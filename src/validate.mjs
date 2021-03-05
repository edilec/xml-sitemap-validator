/**
 * The sitemap rules themselves: namespaces, allowed fields, URL and date
 * syntax, host scope and in-file duplicates.
 *
 * Everything here is a pure function of the parsed document plus explicitly
 * supplied context. No clock, no locale, no filesystem and no network is
 * consulted, which is what makes two runs over the same bytes byte-identical.
 */

export const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9'

/** The pre-2005 Google namespace. Still readable, no longer the one to publish. */
export const LEGACY_SITEMAP_NAMESPACE = 'http://www.google.com/schemas/sitemap/0.84'

/** Namespaces whose elements are recognised as extensions and left unvalidated. */
export const EXTENSION_NAMESPACES = Object.freeze({
  'http://www.google.com/schemas/sitemap-image/1.1': 'image',
  'http://www.google.com/schemas/sitemap-video/1.1': 'video',
  'http://www.google.com/schemas/sitemap-news/0.9': 'news',
  'http://www.google.com/schemas/sitemap-mobile/1.0': 'mobile',
  'http://www.w3.org/1999/xhtml': 'xhtml',
})

/**
 * Limits the sitemap protocol itself imposes. Breaking one is a policy failure
 * reported against the document, not a limit of this reader.
 */
export const PROTOCOL_LIMITS = Object.freeze({
  maxEntriesPerFile: 50000,
  maxUncompressedBytes: 52428800,
  maxLocLength: 2048,
})

export const CHANGEFREQ_VALUES = Object.freeze([
  'always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never',
])

const URL_FIELDS = new Set(['loc', 'lastmod', 'changefreq', 'priority'])
const SITEMAP_FIELDS = new Set(['loc', 'lastmod'])

const W3C_DATETIME = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
const PRIORITY = /^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/

/** Sorting and grouping never use localeCompare: ICU data differs between builds. */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

function epochMilliseconds(year, month, day, hour, minute, second, fraction, offsetMinutes) {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, fraction)
  return date.getTime() - offsetMinutes * 60000
}

/**
 * Parse a W3C datetime the way the sitemap protocol defines it.
 *
 * The shape is checked first and the calendar second, on purpose: a pattern
 * alone happily accepts 2026-02-30, and a tool that reports such a date as
 * valid is worse than no tool, because the mistake then looks reviewed.
 *
 * @returns {{ ok: true, epochMs: number, precision: string }
 *   | { ok: false, code: string, reason: string }}
 */
export function parseW3CDateTime(value) {
  const match = W3C_DATETIME.exec(value)
  if (!match) {
    return {
      ok: false,
      code: 'lastmod-malformed',
      reason: 'is not a W3C datetime (YYYY, YYYY-MM, YYYY-MM-DD, or YYYY-MM-DDThh:mm:ss with a Z or +hh:mm timezone)',
    }
  }

  const year = Number(match[1])
  const month = match[2] === undefined ? null : Number(match[2])
  const day = match[3] === undefined ? null : Number(match[3])
  const hour = match[4] === undefined ? null : Number(match[4])
  const minute = match[5] === undefined ? null : Number(match[5])
  const second = match[6] === undefined ? null : Number(match[6])
  const zone = match[8] ?? null

  if (year === 0) return { ok: false, code: 'lastmod-impossible', reason: 'names year 0000, which does not exist' }
  if (month !== null && (month < 1 || month > 12)) {
    return { ok: false, code: 'lastmod-impossible', reason: `names month ${match[2]}, and months run from 01 to 12` }
  }
  if (day !== null) {
    const available = daysInMonth(year, month)
    if (day < 1 || day > available) {
      return {
        ok: false,
        code: 'lastmod-impossible',
        reason: `names day ${match[3]} of a month that has ${available} days`,
      }
    }
  }
  if (hour !== null && hour > 23) {
    return { ok: false, code: 'lastmod-impossible', reason: `names hour ${match[4]}, and hours run from 00 to 23` }
  }
  if (minute !== null && minute > 59) {
    return { ok: false, code: 'lastmod-impossible', reason: `names minute ${match[5]}, and minutes run from 00 to 59` }
  }
  if (second !== null && second > 59) {
    return { ok: false, code: 'lastmod-impossible', reason: `names second ${match[6]}, and seconds run from 00 to 59` }
  }

  let offsetMinutes = 0
  if (zone !== null && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1
    const offsetHour = Number(zone.slice(1, 3))
    const offsetMinute = Number(zone.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) {
      return {
        ok: false,
        code: 'lastmod-impossible',
        reason: `names the timezone offset ${zone}, which is not a real offset`,
      }
    }
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute)
  }

  const precision = hour === null ? (day === null ? (month === null ? 'year' : 'month') : 'day') : 'second'
  const fraction = match[7] === undefined ? 0 : Math.trunc(Number(`0.${match[7]}`) * 1000)
  const epochMs = epochMilliseconds(year, month ?? 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0, fraction, offsetMinutes)
  return { ok: true, epochMs, precision }
}

/** Evidence is an excerpt, never a payload: collapsed, trimmed and length capped. */
export function bounded(value, length = 120) {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length)}...` : flat
}

function textOf(element) {
  return element.text.trim()
}

/**
 * Validate one parsed sitemap or sitemap index document.
 *
 * @param {object} input
 * @param {object} input.root parsed root element
 * @param {string} input.file path relative to the declared input root
 * @param {URL|null} [input.baseUrl] published location of this document, when declared
 * @param {number|null} [input.nowMs] injected clock, only used for the future-lastmod warning
 * @returns {{ kind: string, entries: object[], findings: object[] }}
 */
export function validateSitemapDocument({ root, file, baseUrl = null, nowMs = null }) {
  const findings = []
  const add = (ruleId, severity, message, ordinal, pointer, extra = {}) => {
    const location = pointer === null ? { file } : { file, pointer }
    findings.push({ ruleId, severity, message, location, ordinal, ...extra })
  }

  const documentNamespace = root.ns
  if (documentNamespace === null) {
    add('namespace-missing', 'error', `The root element "<${root.name}>" declares no namespace.`, -1, `/${root.local}`, {
      suggestion: `Declare xmlns="${SITEMAP_NAMESPACE}" on the root element.`,
    })
  } else if (documentNamespace === LEGACY_SITEMAP_NAMESPACE) {
    add('namespace-legacy', 'warning', 'The document uses the retired 0.84 sitemap namespace.', -1, `/${root.local}`, {
      evidence: documentNamespace,
      suggestion: `Publish with xmlns="${SITEMAP_NAMESPACE}".`,
    })
  } else if (documentNamespace !== SITEMAP_NAMESPACE) {
    add('namespace-unexpected', 'error', 'The root element is not in the sitemap namespace.', -1, `/${root.local}`, {
      evidence: bounded(documentNamespace),
      suggestion: `Declare xmlns="${SITEMAP_NAMESPACE}" on the root element.`,
    })
  }

  const kind = root.local === 'urlset' ? 'urlset' : root.local === 'sitemapindex' ? 'sitemapindex' : 'unknown'
  if (kind === 'unknown') {
    add(
      'root-element-unexpected',
      'error',
      `The root element "<${root.name}>" is neither "urlset" nor "sitemapindex".`,
      -1,
      `/${root.local}`,
    )
    return { kind, entries: [], findings }
  }

  const entryName = kind === 'urlset' ? 'url' : 'sitemap'
  const allowedFields = kind === 'urlset' ? URL_FIELDS : SITEMAP_FIELDS
  const reportedNamespaces = new Set()

  const noteForeignNamespace = (child, ordinal, pointer) => {
    if (child.ns === null) {
      add('element-unqualified', 'error', `The element "<${child.name}>" carries no namespace.`, ordinal, pointer, {
        suggestion: 'Every sitemap element must be namespace qualified.',
      })
      return
    }
    if (EXTENSION_NAMESPACES[child.ns] !== undefined) return
    if (reportedNamespaces.has(child.ns)) return
    reportedNamespaces.add(child.ns)
    add(
      'unknown-namespace',
      'warning',
      'Elements from an unrecognised namespace are present and were not validated.',
      ordinal,
      pointer,
      { evidence: bounded(child.ns) },
    )
  }

  const entryElements = []
  for (const child of root.children) {
    if (child.ns === documentNamespace) {
      if (child.local === entryName) {
        entryElements.push(child)
      } else {
        add(
          'entry-element-unexpected',
          'error',
          `A "<${entryName}>" element was expected but "<${child.name}>" was found.`,
          -1,
          `/${root.local}`,
        )
      }
      continue
    }
    noteForeignNamespace(child, -1, `/${root.local}`)
  }

  if (entryElements.length > PROTOCOL_LIMITS.maxEntriesPerFile) {
    add(
      'entry-limit-exceeded',
      'error',
      `The document holds ${entryElements.length} "<${entryName}>" entries and the sitemap protocol allows `
      + `${PROTOCOL_LIMITS.maxEntriesPerFile} per file.`,
      -1,
      `/${root.local}`,
      { suggestion: 'Split the file and list the parts from a sitemap index.' },
    )
  }

  const entries = []
  const seenLocations = new Map()
  const hosts = new Set()
  const basePathPrefix = baseUrl === null ? null : baseUrl.pathname.replace(/[^/]*$/, '')

  for (let ordinal = 0; ordinal < entryElements.length; ordinal += 1) {
    const element = entryElements[ordinal]
    const pointerBase = `/${root.local}/${entryName}/${ordinal}`
    const fields = new Map()

    for (const child of element.children) {
      if (child.ns !== documentNamespace) {
        noteForeignNamespace(child, ordinal, pointerBase)
        continue
      }
      if (!allowedFields.has(child.local)) {
        add(
          'unknown-field',
          'error',
          `"<${child.name}>" is not a field the sitemap protocol defines for "<${entryName}>".`,
          ordinal,
          `${pointerBase}/${child.local}`,
          { suggestion: `Allowed fields are: ${[...allowedFields].join(', ')}.` },
        )
        continue
      }
      if (fields.has(child.local)) {
        add(
          'field-repeated',
          'error',
          `"<${child.name}>" appears more than once in one "<${entryName}>".`,
          ordinal,
          `${pointerBase}/${child.local}`,
        )
      } else {
        fields.set(child.local, child)
      }
    }

    const locElement = fields.get('loc')
    let url = null
    let loc = null

    if (locElement === undefined) {
      add('loc-missing', 'error', `This "<${entryName}>" has no "<loc>" element.`, ordinal, `${pointerBase}/loc`)
    } else {
      loc = textOf(locElement)
      if (loc === '') {
        add('loc-empty', 'error', 'The "<loc>" element is empty.', ordinal, `${pointerBase}/loc`)
      } else if (CONTROL_CHARACTER.test(loc)) {
        add('loc-control-character', 'error', 'The "<loc>" value contains a control character.', ordinal, `${pointerBase}/loc`)
      } else if (/\s/.test(loc)) {
        add('loc-whitespace', 'error', 'The "<loc>" value contains whitespace.', ordinal, `${pointerBase}/loc`, {
          evidence: bounded(loc),
          suggestion: 'Percent-encode the whitespace, or remove it.',
        })
      } else if (loc.length > PROTOCOL_LIMITS.maxLocLength) {
        add(
          'loc-too-long',
          'error',
          `The "<loc>" value is ${loc.length} characters and the sitemap protocol allows ${PROTOCOL_LIMITS.maxLocLength}.`,
          ordinal,
          `${pointerBase}/loc`,
        )
      } else {
        let parsed = null
        try {
          parsed = new URL(loc)
        } catch {
          parsed = null
        }
        if (parsed === null) {
          add('loc-not-absolute', 'error', 'The "<loc>" value is not an absolute URL.', ordinal, `${pointerBase}/loc`, {
            evidence: bounded(loc),
          })
        } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          add(
            'loc-scheme-unsupported',
            'error',
            `The "<loc>" value uses the "${parsed.protocol.slice(0, -1)}" scheme; sitemaps carry http and https URLs.`,
            ordinal,
            `${pointerBase}/loc`,
          )
        } else {
          url = parsed
        }
      }
    }

    if (url !== null) {
      hosts.add(url.host)
      if (baseUrl !== null) {
        if (url.origin !== baseUrl.origin) {
          add(
            'loc-host-out-of-scope',
            'error',
            `The "<loc>" host "${url.host}" is outside the declared scope "${baseUrl.host}".`,
            ordinal,
            `${pointerBase}/loc`,
            { suggestion: 'Move the URL into a sitemap published on its own host.' },
          )
        } else if (!url.pathname.startsWith(basePathPrefix)) {
          add(
            'loc-path-out-of-scope',
            'warning',
            `The "<loc>" path is not below "${basePathPrefix}", the directory this sitemap is published in.`,
            ordinal,
            `${pointerBase}/loc`,
            {
              evidence: bounded(url.pathname),
              suggestion: 'Publish the sitemap higher up, or declare cross-submission in robots.txt.',
            },
          )
        }
      }
      const key = url.href
      const first = seenLocations.get(key)
      if (first === undefined) {
        seenLocations.set(key, ordinal)
      } else {
        add('duplicate-loc', 'error', `This URL already appears as entry ${first} of the same file.`, ordinal, `${pointerBase}/loc`, {
          evidence: bounded(key),
        })
      }
    }

    const lastmodElement = fields.get('lastmod')
    let lastmod = null
    if (lastmodElement !== undefined) {
      const raw = textOf(lastmodElement)
      const result = parseW3CDateTime(raw)
      if (!result.ok) {
        add(result.code, 'error', `The "<lastmod>" value ${result.reason}.`, ordinal, `${pointerBase}/lastmod`, {
          evidence: bounded(raw),
        })
      } else {
        lastmod = { raw, epochMs: result.epochMs, precision: result.precision }
        if (nowMs !== null && result.epochMs > nowMs) {
          add(
            'lastmod-in-future',
            'warning',
            'The "<lastmod>" value is later than the reference time supplied to this run.',
            ordinal,
            `${pointerBase}/lastmod`,
            { evidence: bounded(raw) },
          )
        }
      }
    }

    if (kind === 'urlset') {
      const changefreqElement = fields.get('changefreq')
      if (changefreqElement !== undefined) {
        const raw = textOf(changefreqElement)
        if (!CHANGEFREQ_VALUES.includes(raw)) {
          add(
            'changefreq-invalid',
            'error',
            `"<changefreq>" must be one of ${CHANGEFREQ_VALUES.join(', ')}.`,
            ordinal,
            `${pointerBase}/changefreq`,
            { evidence: bounded(raw) },
          )
        }
      }
      const priorityElement = fields.get('priority')
      if (priorityElement !== undefined) {
        const raw = textOf(priorityElement)
        if (!PRIORITY.test(raw)) {
          add('priority-invalid', 'error', '"<priority>" must be a decimal from 0.0 to 1.0.', ordinal, `${pointerBase}/priority`, {
            evidence: bounded(raw),
          })
        }
      }
    }

    entries.push({ ordinal, loc, url, lastmod, pointerBase })
  }

  if (baseUrl === null && hosts.size > 1) {
    const sample = [...hosts].sort(byCodeUnit).slice(0, 3).join(', ')
    add('mixed-hosts', 'warning', `The document lists URLs on ${hosts.size} different hosts.`, -1, `/${root.local}`, {
      evidence: bounded(sample),
      suggestion: 'Pass the published sitemap location so host scope can be checked rather than guessed.',
    })
  }

  return { kind, entries, findings }
}
