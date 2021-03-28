/**
 * xml-sitemap-validator
 *
 * Walk a local sitemap tree, read each file under explicit bounds, apply the
 * sitemap protocol rules, and return one report.
 *
 * Two kinds of limit are deliberately kept apart, because conflating them is
 * how a checker ends up reporting "pass" on evidence it never saw:
 *
 *   - Protocol limits (50,000 entries and 50 MiB per file) are policy. Breaking
 *     one is a finding about the document and the run fails.
 *   - Reader bounds (bytes read, decompressed bytes, elements, depth, files)
 *     are this tool's own safety margin, set above the protocol limits so a
 *     policy violation is still visible. Hitting one means the input could not
 *     be evaluated, so the run is "incomplete" and exits 2, never "pass".
 *
 * Nothing here reaches the network. A sitemap index is followed only into files
 * that already exist inside the declared input root.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { XML_DEFAULT_LIMITS, XmlError, parseXml } from './xml.mjs'
import {
  PROTOCOL_LIMITS,
  SITEMAP_NAMESPACE,
  bounded,
  byCodeUnit,
  parseW3CDateTime,
  validateSitemapDocument,
} from './validate.mjs'

export { XML_DEFAULT_LIMITS, XmlError, parseXml } from './xml.mjs'
export {
  CHANGEFREQ_VALUES,
  EXTENSION_NAMESPACES,
  LEGACY_SITEMAP_NAMESPACE,
  PROTOCOL_LIMITS,
  SITEMAP_NAMESPACE,
  parseW3CDateTime,
  validateSitemapDocument,
} from './validate.mjs'

export const TOOL_ID = 'xml-sitemap-validator'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_LIMITS = Object.freeze({
  /** Largest file this tool will read from disk at all, checked before reading. */
  maxFileBytes: 268435456,
  /** Largest gunzip output accepted, above the 50 MiB protocol limit on purpose. */
  maxDecompressedBytes: 67108864,
  /** Files visited in one tree walk. */
  maxFiles: 512,
  /** Entries recorded across the whole tree, which bounds duplicate tracking. */
  maxTreeEntries: 1000000,
  /** Index nesting levels followed below the entry file. */
  maxIndexDepth: 3,
  /** Uncompressed-to-compressed ratio above which a .gz input is called out. */
  maxCompressionRatio: 1000,
  /** Bounds handed to the XML reader. */
  xml: XML_DEFAULT_LIMITS,
})

/** XML reader errors that mean "bounded out", not "malformed". */
const READER_BOUND_CODES = new Set([
  'element-limit-exceeded',
  'depth-limit-exceeded',
  'attribute-limit-exceeded',
  'name-limit-exceeded',
  'text-limit-exceeded',
])

const GZIP_MAGIC_FIRST = 0x1f
const GZIP_MAGIC_SECOND = 0x8b
const NUL = String.fromCharCode(0)

function toPosix(value) {
  return value.split(sep).join('/')
}

function normaliseBaseUrl(value) {
  if (value === null || value === undefined || value === '') return null
  let parsed
  try {
    parsed = value instanceof URL ? value : new URL(String(value))
  } catch {
    throw new TypeError(`baseUrl "${String(value)}" is not an absolute URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`baseUrl must use http or https, not "${parsed.protocol.slice(0, -1)}"`)
  }
  return parsed
}

/**
 * The reference time is always injected. The tool never reads the wall clock,
 * so a run without one simply does not check whether a date is in the future.
 */
function normaliseNow(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = parseW3CDateTime(String(value))
  if (!parsed.ok) throw new TypeError(`now "${String(value)}" ${parsed.reason}`)
  return parsed.epochMs
}

/**
 * Map a sitemap URL onto a file inside the declared input root.
 *
 * With a declared base URL the mapping is exact: the path below the sitemap's
 * own directory, and nothing else. A reference to another origin, or above that
 * directory, is out of scope and stays unresolved rather than being guessed at.
 * Without a declared base URL the last path segment is looked up directly in the
 * root, which is how mirrored exports are usually laid out.
 *
 * Either way the result is resolved and then checked to be inside the root, so a
 * percent-encoded "../" in a hostile sitemap cannot walk the validator out of
 * the directory it was given.
 */
function resolveChildPath(url, rootDirectory, parentBaseUrl) {
  let relativePath = null
  if (parentBaseUrl !== null) {
    if (url.origin !== parentBaseUrl.origin) return null
    const prefix = parentBaseUrl.pathname.replace(/[^/]*$/, '')
    if (!url.pathname.startsWith(prefix)) return null
    relativePath = url.pathname.slice(prefix.length)
  } else {
    const segments = url.pathname.split('/')
    relativePath = segments[segments.length - 1]
  }
  let decoded
  try {
    decoded = decodeURIComponent(relativePath)
  } catch {
    return null
  }
  if (decoded === '' || decoded.includes(NUL)) return null
  const absolute = resolve(rootDirectory, decoded)
  const inside = absolute === rootDirectory || absolute.startsWith(rootDirectory + sep)
  return { absolute, inside }
}

async function isReadableFile(absolute) {
  try {
    const stats = await stat(absolute)
    return stats.isFile()
  } catch {
    return false
  }
}

/**
 * Validate a local sitemap tree.
 *
 * @param {object} options
 * @param {string} options.sitemap path to the entry sitemap or sitemap index
 * @param {string} [options.root] directory the tree lives in; defaults to the entry file's directory
 * @param {string|URL|null} [options.baseUrl] published location of the entry file
 * @param {string|null} [options.now] injected reference time as a W3C datetime
 * @param {object} [options.limits] reader bound overrides
 * @param {(message: string) => void} [options.onDiagnostic] operational log sink, never the report
 * @returns {Promise<object>} the report described in docs/rules.md
 */
export async function validateSitemapTree(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options must be an object')
  if (typeof options.sitemap !== 'string' || options.sitemap.trim() === '') {
    throw new TypeError('options.sitemap must be a path to a sitemap file')
  }

  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  limits.xml = { ...XML_DEFAULT_LIMITS, ...(options.limits?.xml ?? {}) }
  if (!Number.isInteger(limits.maxIndexDepth) || limits.maxIndexDepth < 0) {
    throw new TypeError('limits.maxIndexDepth must be a non-negative integer')
  }

  const entryAbsolute = resolve(options.sitemap)
  const rootDirectory = resolve(options.root ?? dirname(entryAbsolute))
  if (entryAbsolute !== rootDirectory && !entryAbsolute.startsWith(rootDirectory + sep)) {
    throw new TypeError('options.sitemap must be inside options.root')
  }
  const realRoot = await realpath(rootDirectory)
  const insideRealRoot = (path) => path === realRoot || path.startsWith(realRoot + sep)

  const entryBaseUrl = normaliseBaseUrl(options.baseUrl ?? null)
  const nowMs = normaliseNow(options.now ?? null)
  const diagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : () => {}

  const findings = []
  const visited = new Set()
  const treeLocations = new Map()
  let incomplete = false
  let filesRead = 0
  let urls = 0
  let sitemaps = 0
  let checked = 0
  let deepestIndexDepth = 0
  let unresolvedChildren = 0
  let treeLimitReported = false
  let fileLimitReported = false

  const relativeFor = (absolute) => toPosix(relative(rootDirectory, absolute))
  const record = (ruleId, severity, message, file, ordinal, pointer, extra = {}) => {
    const location = pointer === null ? { file } : { file, pointer }
    findings.push({ ruleId, severity, message, location, ordinal, ...extra })
  }

  /** Read one file under bounds. Returns null when the input could not be evaluated. */
  const readSitemapFile = async (absolute, file) => {
    let realFile
    try {
      realFile = await realpath(absolute)
    } catch (error) {
      incomplete = true
      record('file-unreadable', 'error', `The file could not be read: ${error.code ?? 'unknown error'}.`, file, -1, null)
      return null
    }
    if (!insideRealRoot(realFile)) {
      incomplete = true
      record('file-outside-root', 'error', 'The file resolves outside the declared input root and was not read.', file, -1, null)
      return null
    }
    let stats
    try {
      stats = await stat(realFile)
    } catch (error) {
      incomplete = true
      record('file-unreadable', 'error', `The file could not be read: ${error.code ?? 'unknown error'}.`, file, -1, null)
      return null
    }
    if (!stats.isFile()) {
      incomplete = true
      record('file-unreadable', 'error', 'The path is not a regular file.', file, -1, null)
      return null
    }
    if (stats.size > limits.maxFileBytes) {
      incomplete = true
      record(
        'input-limit-exceeded',
        'error',
        `The file is ${stats.size} bytes and this tool reads at most ${limits.maxFileBytes} bytes from disk.`,
        file,
        -1,
        null,
        { suggestion: 'Raise limits.maxFileBytes only if you have reason to trust the input.' },
      )
      return null
    }

    let raw
    try {
      raw = await readFile(realFile)
    } catch (error) {
      incomplete = true
      record('file-unreadable', 'error', `The file could not be read: ${error.code ?? 'unknown error'}.`, file, -1, null)
      return null
    }

    // Compression is detected from the gzip magic bytes, not the file name: a
    // mirrored export is routinely gzipped without the extension, or named .gz
    // without being gzipped.
    const isGzip = raw.length >= 2 && raw[0] === GZIP_MAGIC_FIRST && raw[1] === GZIP_MAGIC_SECOND
    let bytes = raw
    if (isGzip) {
      try {
        bytes = gunzipSync(raw, { maxOutputLength: limits.maxDecompressedBytes })
      } catch (error) {
        incomplete = true
        if (error.code === 'ERR_BUFFER_TOO_LARGE') {
          record(
            'decompressed-limit-exceeded',
            'error',
            `The file expands beyond the ${limits.maxDecompressedBytes} byte decompression bound, so it was not read.`,
            file,
            -1,
            null,
            { suggestion: 'A sitemap this large already breaks the protocol; split it at the source.' },
          )
        } else {
          record('decompression-failed', 'error', `The gzip stream could not be decompressed: ${bounded(error.message, 80)}.`, file, -1, null)
        }
        return null
      }
      const ratio = raw.length === 0 ? 0 : bytes.length / raw.length
      if (ratio > limits.maxCompressionRatio) {
        record(
          'compression-ratio-suspicious',
          'warning',
          `The file expands ${Math.round(ratio)} times, above the ${limits.maxCompressionRatio} times bound for ordinary sitemap text.`,
          file,
          -1,
          null,
        )
      }
    } else if (file.endsWith('.gz')) {
      record(
        'gzip-extension-mismatch',
        'warning',
        'The file is named ".gz" but does not begin with the gzip magic bytes, so it was read as plain XML.',
        file,
        -1,
        null,
        { suggestion: 'Serve the file uncompressed, or compress it for real.' },
      )
    }

    if (bytes.length > PROTOCOL_LIMITS.maxUncompressedBytes) {
      record(
        'file-size-limit-exceeded',
        'error',
        `The uncompressed file is ${bytes.length} bytes and the sitemap protocol allows ${PROTOCOL_LIMITS.maxUncompressedBytes}.`,
        file,
        -1,
        null,
        { suggestion: 'Split the file and list the parts from a sitemap index.' },
      )
    }

    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      incomplete = true
      record('encoding-invalid', 'error', 'The file is not valid UTF-8, so it was not read.', file, -1, null)
      return null
    }

    diagnostic(`read ${file} (${raw.length} bytes on disk, ${bytes.length} bytes of XML, gzip ${isGzip ? 'yes' : 'no'})`)
    return { text, bytes: bytes.length }
  }

  const visit = async (absolute, depth, ownBaseUrl, chain) => {
    if (filesRead >= limits.maxFiles) {
      if (!fileLimitReported) {
        fileLimitReported = true
        incomplete = true
        record(
          'file-limit-exceeded',
          'error',
          `The tree holds more than ${limits.maxFiles} files, so the rest of it was not read.`,
          relativeFor(absolute),
          -1,
          null,
        )
      }
      return
    }

    visited.add(absolute)
    filesRead += 1
    const file = relativeFor(absolute)
    if (depth > deepestIndexDepth) deepestIndexDepth = depth

    const loaded = await readSitemapFile(absolute, file)
    if (loaded === null) return

    let parsed
    try {
      parsed = parseXml(loaded.text, { limits: limits.xml })
    } catch (error) {
      if (!(error instanceof XmlError)) throw error
      const boundedOut = READER_BOUND_CODES.has(error.code)
      if (boundedOut) incomplete = true
      record(
        boundedOut ? 'input-limit-exceeded' : 'xml-malformed',
        'error',
        boundedOut ? error.message : `The file is not well-formed XML: ${error.message}`,
        file,
        -1,
        null,
        { evidence: `${error.code} at line ${error.line}` },
      )
      return
    }

    if (parsed.declaredEncoding !== null && !/^utf-?8$/i.test(parsed.declaredEncoding)) {
      record(
        'encoding-declared-unsupported',
        'warning',
        `The XML declaration names the "${bounded(parsed.declaredEncoding, 40)}" encoding; this tool decodes UTF-8 only.`,
        file,
        -1,
        null,
        { suggestion: 'Publish sitemaps as UTF-8, which the sitemap protocol requires.' },
      )
    }

    const result = validateSitemapDocument({ root: parsed.root, file, baseUrl: ownBaseUrl, nowMs })
    for (const finding of result.findings) findings.push(finding)

    checked += result.entries.length
    if (result.kind === 'urlset') urls += result.entries.length
    if (result.kind === 'sitemapindex') sitemaps += result.entries.length

    if (depth > 0 && result.kind === 'sitemapindex') {
      record(
        'nested-index',
        'warning',
        'This file is a sitemap index that is itself listed by a sitemap index. Search engines generally do not follow nested indexes.',
        file,
        -1,
        `/${parsed.root.local}`,
      )
    }

    for (const entry of result.entries) {
      if (entry.url === null) continue
      if (treeLocations.size >= limits.maxTreeEntries) {
        if (!treeLimitReported) {
          treeLimitReported = true
          incomplete = true
          record(
            'tree-entry-limit-exceeded',
            'error',
            `The tree holds more than ${limits.maxTreeEntries} URLs, so duplicate detection stopped here.`,
            file,
            entry.ordinal,
            `${entry.pointerBase}/loc`,
          )
        }
        break
      }
      const first = treeLocations.get(entry.url.href)
      if (first === undefined) {
        treeLocations.set(entry.url.href, file)
      } else if (first !== file) {
        record(
          'duplicate-loc-in-tree',
          'warning',
          `This URL already appears in "${first}".`,
          file,
          entry.ordinal,
          `${entry.pointerBase}/loc`,
          { evidence: bounded(entry.url.href) },
        )
      }
    }

    if (result.kind !== 'sitemapindex') return

    for (const entry of result.entries) {
      if (entry.url === null) continue
      const pointer = `${entry.pointerBase}/loc`
      const resolved = resolveChildPath(entry.url, rootDirectory, ownBaseUrl)
      if (resolved === null || !resolved.inside) {
        if (resolved !== null && !resolved.inside) {
          incomplete = true
          record(
            'child-outside-root',
            'error',
            'The referenced sitemap resolves to a path outside the declared input root and was not read.',
            file,
            entry.ordinal,
            pointer,
            { evidence: bounded(entry.url.href) },
          )
          continue
        }
        incomplete = true
        unresolvedChildren += 1
        record(
          'child-sitemap-unresolved',
          'warning',
          'The referenced sitemap could not be mapped to a local file, so its contents were not validated.',
          file,
          entry.ordinal,
          pointer,
          { evidence: bounded(entry.url.href), suggestion: 'Pass --base-url so URLs can be mapped onto the mirrored directory.' },
        )
        continue
      }

      const childAbsolute = resolved.absolute
      let realChild
      try { realChild = await realpath(childAbsolute) } catch { /* unresolved below */ }
      if (realChild !== undefined && !insideRealRoot(realChild)) {
        incomplete = true
        record('child-outside-root', 'error', 'The referenced sitemap resolves outside the declared input root and was not read.', file, entry.ordinal, pointer)
        continue
      }
      if (chain.includes(childAbsolute)) {
        record(
          'index-cycle',
          'error',
          childAbsolute === absolute
            ? 'The sitemap index references itself. The walk stopped here.'
            : `The sitemap index references "${relativeFor(childAbsolute)}", which already contains it. The walk stopped here.`,
          file,
          entry.ordinal,
          pointer,
          { evidence: bounded(entry.url.href) },
        )
        continue
      }
      if (visited.has(childAbsolute)) {
        record(
          'index-repeated-child',
          'warning',
          `"${relativeFor(childAbsolute)}" is listed more than once in this tree and was read only once.`,
          file,
          entry.ordinal,
          pointer,
        )
        continue
      }
      if (depth + 1 > limits.maxIndexDepth) {
        incomplete = true
        record(
          'index-depth-exceeded',
          'error',
          `Following this reference would nest sitemap indexes more than ${limits.maxIndexDepth} levels deep, so it was not read.`,
          file,
          entry.ordinal,
          pointer,
        )
        continue
      }
      if (!(await isReadableFile(childAbsolute))) {
        incomplete = true
        unresolvedChildren += 1
        record(
          'child-sitemap-unresolved',
          'warning',
          `The referenced sitemap maps to "${relativeFor(childAbsolute)}", which is not present, so its contents were not validated.`,
          file,
          entry.ordinal,
          pointer,
          { evidence: bounded(entry.url.href) },
        )
        continue
      }

      await visit(childAbsolute, depth + 1, entry.url, [...chain, childAbsolute])
    }
  }

  if (entryBaseUrl === null) {
    record(
      'host-scope-not-declared',
      'info',
      'No published sitemap location was declared, so host and path scope were not verified.',
      relativeFor(entryAbsolute),
      -1,
      null,
      { suggestion: 'Pass --base-url https://example.com/sitemap.xml to check that every URL is in scope.' },
    )
  }

  await visit(entryAbsolute, 0, entryBaseUrl, [entryAbsolute])

  findings.sort((left, right) => (
    byCodeUnit(left.location.file, right.location.file)
    || (left.ordinal - right.ordinal)
    || byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '')
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.message, right.message)
  ))

  const ordered = findings.map((finding) => {
    const output = {
      ruleId: finding.ruleId,
      severity: finding.severity,
      message: finding.message,
      location: finding.location,
    }
    if (finding.evidence !== undefined) output.evidence = finding.evidence
    if (finding.suggestion !== undefined) output.suggestion = finding.suggestion
    return output
  })

  const errors = ordered.filter((finding) => finding.severity === 'error').length
  const warnings = ordered.filter((finding) => finding.severity === 'warning').length
  const info = ordered.length - errors - warnings
  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked,
      errors,
      warnings,
      info,
      files: filesRead,
      urls,
      sitemaps,
      indexDepth: deepestIndexDepth,
      unresolvedChildren,
      hostScopeDeclared: entryBaseUrl !== null,
    },
    findings: ordered,
  }
}

/** 0 passed, 1 completed and failed policy, 2 could not be evaluated. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

export function formatReport(report) {
  const lines = report.findings.map((finding) => {
    const where = finding.location.pointer === undefined
      ? finding.location.file
      : `${finding.location.file}${finding.location.pointer}`
    return `${finding.severity.toUpperCase().padEnd(7)} ${finding.ruleId.padEnd(28)} ${where}\n        ${finding.message}`
  })
  lines.push('')
  lines.push(
    `${report.summary.files} file(s), ${report.summary.checked} entr(ies) checked `
    + `(${report.summary.urls} URL, ${report.summary.sitemaps} sitemap reference).`,
  )
  lines.push(
    `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info; status ${report.status}.`,
  )
  if (!report.summary.hostScopeDeclared) {
    lines.push('Host scope was not declared, so it was reported as unverified rather than assumed correct.')
  }
  if (report.summary.unresolvedChildren > 0) {
    lines.push(`${report.summary.unresolvedChildren} referenced sitemap(s) could not be read, so the tree was not fully evaluated.`)
  }
  lines.push(`The sitemap namespace checked against is ${SITEMAP_NAMESPACE}.`)
  return `${lines.join('\n')}\n`
}
