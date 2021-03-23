import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  DEFAULT_LIMITS,
  PROTOCOL_LIMITS,
  SITEMAP_NAMESPACE,
  exitCodeFor,
  parseW3CDateTime,
  validateSitemapTree,
} from '../src/index.mjs'
import { byCodeUnit } from '../src/validate.mjs'

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples')
const OPEN = `<urlset xmlns="${SITEMAP_NAMESPACE}">`
const INDEX_OPEN = `<sitemapindex xmlns="${SITEMAP_NAMESPACE}">`

/** Build a throwaway sitemap tree on disk and hand back its directory. */
async function tree(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'xml-sitemap-validator-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    const target = join(directory, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
  }
  return directory
}

function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

function findingFor(report, ruleId) {
  const match = report.findings.find((finding) => finding.ruleId === ruleId)
  assert.ok(match, `expected a "${ruleId}" finding, saw ${JSON.stringify(ruleIds(report))}`)
  return match
}

test('acceptance: the shipped clean tree passes, with valid namespaces and compressed input', async () => {
  const report = await validateSitemapTree({
    sitemap: join(EXAMPLES, 'clean', 'sitemap-index.xml'),
    baseUrl: 'https://example.com/sitemap-index.xml',
  })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.equal(report.summary.files, 3)
  assert.equal(report.summary.urls, 6)
  assert.equal(report.summary.sitemaps, 2)
  assert.equal(report.summary.checked, 8)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'xml-sitemap-validator')
})

test('acceptance: malformed XML is rejected rather than partly accepted', async (t) => {
  const root = await tree(t, { 'sitemap.xml': `${OPEN}<url><loc>https://example.com/</loc></urlset>` })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root })
  const finding = findingFor(report, 'xml-malformed')
  assert.equal(finding.severity, 'error')
  assert.match(finding.evidence, /^tag-mismatch at line \d+$/)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.equal(report.summary.checked, 0)
})

test('acceptance: a DTD carrying an external entity declaration is rejected, not expanded', async () => {
  const report = await validateSitemapTree({
    sitemap: join(EXAMPLES, 'broken', 'sitemap-entity-expansion.xml'),
  })
  const finding = findingFor(report, 'xml-malformed')
  assert.match(finding.evidence, /^doctype-not-allowed at line \d+$/)
  assert.equal(exitCodeFor(report), 1)
})

test('acceptance: impossible dates are rejected, and the calendar is checked after the pattern', () => {
  for (const value of ['2026-02-30', '2026-02-29', '2025-04-31', '2026-13-01', '2026-00-10', '0000-01-01']) {
    const result = parseW3CDateTime(value)
    assert.equal(result.ok, false, `${value} must not parse`)
    assert.equal(result.code, 'lastmod-impossible', `${value} matches the shape but not the calendar`)
  }
  for (const value of ['2026-02-28T24:00:00Z', '2026-02-28T12:60:00Z', '2026-02-28T12:00:60Z', '2026-02-28T12:00:00+30:00']) {
    assert.equal(parseW3CDateTime(value).code, 'lastmod-impossible', `${value} names a time that does not exist`)
  }
  for (const value of ['28-02-2026', '2026/02/28', '2026-2-8', '2026-02-28T10:00:00', '2026-02-28 10:00:00Z', 'yesterday', '']) {
    assert.equal(parseW3CDateTime(value).code, 'lastmod-malformed', `${value} does not match the W3C shape`)
  }
  assert.equal(parseW3CDateTime('2024-02-29').ok, true, '2024 is a leap year')
  assert.equal(parseW3CDateTime('2000-02-29').ok, true, '2000 is a leap year')
  assert.equal(parseW3CDateTime('1900-02-29').ok, false, '1900 is not a leap year')
})

test('every W3C datetime precision the protocol allows is accepted', () => {
  for (const value of ['2026', '2026-02', '2026-02-28', '2026-02-28T10:30Z', '2026-02-28T10:30:15Z', '2026-02-28T10:30:15.25+05:30']) {
    assert.equal(parseW3CDateTime(value).ok, true, `${value} is a valid W3C datetime`)
  }
  assert.equal(parseW3CDateTime('2026-02-28T10:30:00Z').epochMs, Date.UTC(2026, 1, 28, 10, 30, 0))
  assert.equal(parseW3CDateTime('2026-02-28T10:30:00+05:30').epochMs, Date.UTC(2026, 1, 28, 5, 0, 0))
})

test('an impossible lastmod in a real document is an error against that entry', async (t) => {
  const root = await tree(t, {
    'sitemap.xml': `${OPEN}<url><loc>https://example.com/</loc><lastmod>2026-02-30</lastmod></url></urlset>`,
  })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root })
  const finding = findingFor(report, 'lastmod-impossible')
  assert.equal(finding.location.pointer, '/urlset/url/0/lastmod')
  assert.equal(finding.evidence, '2026-02-30')
  assert.equal(exitCodeFor(report), 1)
})

test('acceptance: the 50,000 entry protocol limit is enforced against a real document', async (t) => {
  assert.equal(PROTOCOL_LIMITS.maxEntriesPerFile, 50000)
  const entries = []
  for (let index = 0; index <= PROTOCOL_LIMITS.maxEntriesPerFile; index += 1) {
    entries.push(`<url><loc>https://example.com/p/${index}</loc></url>`)
  }
  const root = await tree(t, { 'sitemap.xml': `${OPEN}${entries.join('')}</urlset>` })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root })
  const finding = findingFor(report, 'entry-limit-exceeded')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /50001 "<url>" entries and the sitemap protocol allows 50000/)
  assert.equal(report.summary.checked, 50001)
  assert.equal(exitCodeFor(report), 1)
})

test('acceptance: a document holding no entries is reported, never passed as checked', async (t) => {
  const root = await tree(t, {
    'empty-urlset.xml': `${OPEN}</urlset>`,
    'empty-index.xml': `${INDEX_OPEN}</sitemapindex>`,
    'whitespace-urlset.xml': `${OPEN}\n   \n</urlset>`,
    'populated.xml': `${OPEN}<url><loc>https://example.com/a</loc></url></urlset>`,
  })
  const at = (name) => validateSitemapTree({ sitemap: join(root, name), root, baseUrl: `https://example.com/${name}` })

  const urlset = await at('empty-urlset.xml')
  const finding = findingFor(urlset, 'entry-missing')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.pointer, '/urlset')
  assert.match(finding.message, /holds no "<url>" entries/)
  assert.equal(urlset.summary.checked, 0)
  assert.equal(urlset.status, 'fail', 'a run that checked nothing is never a pass')
  assert.equal(exitCodeFor(urlset), 1)

  const index = await at('empty-index.xml')
  assert.match(findingFor(index, 'entry-missing').message, /holds no "<sitemap>" entries/)
  assert.equal(findingFor(index, 'entry-missing').location.pointer, '/sitemapindex')
  assert.equal(exitCodeFor(index), 1)

  assert.equal(findingFor(await at('whitespace-urlset.xml'), 'entry-missing').severity, 'error')

  const populated = await at('populated.xml')
  assert.equal(ruleIds(populated).includes('entry-missing'), false, 'one entry is enough')
  assert.equal(populated.status, 'pass')
})

test('acceptance: the 50 MiB uncompressed protocol limit is enforced against a real file', async (t) => {
  assert.equal(PROTOCOL_LIMITS.maxUncompressedBytes, 52428800)
  const head = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${OPEN}\n<!-- `, 'utf8')
  const filler = Buffer.alloc(PROTOCOL_LIMITS.maxUncompressedBytes + 1024, 0x78)
  const tail = Buffer.from(' -->\n<url><loc>https://example.com/</loc></url>\n</urlset>\n', 'utf8')
  const root = await tree(t, { 'sitemap.xml': Buffer.concat([head, filler, tail]) })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root })
  const finding = findingFor(report, 'file-size-limit-exceeded')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /the sitemap protocol allows 52428800/)
  assert.equal(report.summary.urls, 1, 'the rest of the document is still validated')
  assert.equal(exitCodeFor(report), 1)
})

test('compressed input is accepted and gzip is detected from the magic bytes, not the extension', async (t) => {
  const body = `${OPEN}<url><loc>https://example.com/a</loc></url></urlset>`
  const root = await tree(t, {
    'sitemap.xml': gzipSync(Buffer.from(body, 'utf8')),
    'other.xml.gz': body,
  })
  const compressed = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root })
  assert.deepEqual(ruleIds(compressed).filter((id) => id !== 'host-scope-not-declared'), [])
  assert.equal(compressed.status, 'pass')
  assert.equal(compressed.summary.urls, 1)

  const mislabelled = await validateSitemapTree({ sitemap: join(root, 'other.xml.gz'), root })
  assert.equal(findingFor(mislabelled, 'gzip-extension-mismatch').severity, 'warning')
  assert.equal(mislabelled.status, 'pass', 'a misleading name is a warning, not a reading failure')
})

test('a gzip stream that expands past the decompression bound is incomplete, never a pass', async (t) => {
  assert.equal(DEFAULT_LIMITS.maxDecompressedBytes, 67108864)
  const root = await tree(t, { 'sitemap.xml.gz': gzipSync(Buffer.alloc(65536, 0x78)) })
  const report = await validateSitemapTree({
    sitemap: join(root, 'sitemap.xml.gz'),
    root,
    limits: { maxDecompressedBytes: 1024 },
  })
  const finding = findingFor(report, 'decompressed-limit-exceeded')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /1024 byte decompression bound/)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('a truncated gzip stream is incomplete, never a pass', async (t) => {
  const complete = gzipSync(Buffer.from(`${OPEN}</urlset>`, 'utf8'))
  const root = await tree(t, { 'sitemap.xml.gz': complete.subarray(0, complete.length - 6) })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml.gz'), root })
  assert.equal(findingFor(report, 'decompression-failed').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('input that is not valid UTF-8 is incomplete, never a pass', async (t) => {
  const root = await tree(t, { 'sitemap.xml': Buffer.from([0x3c, 0x6c, 0x6f, 0x63, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x6c, 0x6f, 0x63, 0x3e]) })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root })
  assert.equal(findingFor(report, 'encoding-invalid').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('an input file that is not there at all is incomplete, never a pass', async (t) => {
  const root = await tree(t, { 'placeholder.txt': 'x' })
  const report = await validateSitemapTree({ sitemap: join(root, 'absent.xml'), root })
  assert.equal(findingFor(report, 'file-unreadable').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('a file larger than the read bound is refused before it is read', async (t) => {
  const root = await tree(t, { 'sitemap.xml': `${OPEN}</urlset>` })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root, limits: { maxFileBytes: 4 } })
  assert.match(findingFor(report, 'input-limit-exceeded').message, /reads at most 4 bytes from disk/)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('an XML reader bound is incomplete, and is reported apart from malformed XML', async (t) => {
  const root = await tree(t, { 'sitemap.xml': `${OPEN}${'<url/>'.repeat(20)}</urlset>` })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root, limits: { xml: { maxElements: 5 } } })
  const finding = findingFor(report, 'input-limit-exceeded')
  assert.match(finding.evidence, /^element-limit-exceeded at line \d+$/)
  assert.equal(ruleIds(report).includes('xml-malformed'), false)
  assert.equal(report.status, 'incomplete')
})

test('a sitemap index that references itself terminates and is reported as a cycle', async (t) => {
  const root = await tree(t, {
    'sitemap.xml': `${INDEX_OPEN}<sitemap><loc>https://example.com/sitemap.xml</loc></sitemap></sitemapindex>`,
  })
  const report = await validateSitemapTree({
    sitemap: join(root, 'sitemap.xml'),
    root,
    baseUrl: 'https://example.com/sitemap.xml',
  })
  const finding = findingFor(report, 'index-cycle')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /references itself/)
  assert.equal(report.summary.files, 1, 'the self reference was never followed')
  assert.equal(exitCodeFor(report), 1)
})

test('a cycle running through two index files terminates as well', async (t) => {
  const root = await tree(t, {
    'a.xml': `${INDEX_OPEN}<sitemap><loc>https://example.com/b.xml</loc></sitemap></sitemapindex>`,
    'b.xml': `${INDEX_OPEN}<sitemap><loc>https://example.com/a.xml</loc></sitemap></sitemapindex>`,
  })
  const report = await validateSitemapTree({ sitemap: join(root, 'a.xml'), root, baseUrl: 'https://example.com/a.xml' })
  assert.match(findingFor(report, 'index-cycle').message, /already contains it/)
  assert.equal(ruleIds(report).includes('nested-index'), true)
  assert.equal(report.summary.files, 2)
})

test('index nesting is bounded and exceeding the bound is incomplete', async (t) => {
  const root = await tree(t, {
    'a.xml': `${INDEX_OPEN}<sitemap><loc>https://example.com/b.xml</loc></sitemap></sitemapindex>`,
    'b.xml': `${INDEX_OPEN}<sitemap><loc>https://example.com/c.xml</loc></sitemap></sitemapindex>`,
    'c.xml': `${OPEN}<url><loc>https://example.com/</loc></url></urlset>`,
  })
  const bounded = await validateSitemapTree({
    sitemap: join(root, 'a.xml'),
    root,
    baseUrl: 'https://example.com/a.xml',
    limits: { maxIndexDepth: 1 },
  })
  assert.match(findingFor(bounded, 'index-depth-exceeded').message, /more than 1 levels deep/)
  assert.equal(bounded.status, 'incomplete')
  assert.equal(bounded.summary.files, 2)

  const full = await validateSitemapTree({ sitemap: join(root, 'a.xml'), root, baseUrl: 'https://example.com/a.xml' })
  assert.equal(full.summary.files, 3)
  assert.equal(full.summary.indexDepth, 2)
  assert.equal(ruleIds(full).filter((id) => id === 'nested-index').length, 1)
})

test('a child that would resolve outside the input root is refused, not read', async (t) => {
  const root = await tree(t, {
    'inside/sitemap.xml': `${INDEX_OPEN}<sitemap>`
      + '<loc>https://example.com/inside/%2e%2e%2foutside.xml</loc></sitemap></sitemapindex>',
    'outside.xml': `${OPEN}<url><loc>https://example.com/leaked</loc></url></urlset>`,
  })
  const report = await validateSitemapTree({
    sitemap: join(root, 'inside', 'sitemap.xml'),
    root: join(root, 'inside'),
    baseUrl: 'https://example.com/inside/sitemap.xml',
  })
  assert.equal(findingFor(report, 'child-outside-root').severity, 'error')
  assert.equal(report.summary.files, 1)
  assert.equal(report.summary.urls, 0, 'the file outside the root was never read')
})

test('a referenced sitemap that is not present is incomplete, never a pass', async (t) => {
  const root = await tree(t, {
    'sitemap.xml': `${INDEX_OPEN}<sitemap><loc>https://example.com/absent.xml</loc></sitemap></sitemapindex>`,
  })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root, baseUrl: 'https://example.com/sitemap.xml' })
  const finding = findingFor(report, 'child-sitemap-unresolved')
  assert.equal(finding.severity, 'warning')
  assert.equal(report.summary.unresolvedChildren, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('host and path scope are checked when the published location is declared', async (t) => {
  const root = await tree(t, {
    'a/sitemap.xml': `${OPEN}`
      + '<url><loc>https://example.com/a/one</loc></url>'
      + '<url><loc>https://other.example.net/two</loc></url>'
      + '<url><loc>https://example.com/elsewhere/three</loc></url>'
      + '</urlset>',
  })
  const report = await validateSitemapTree({
    sitemap: join(root, 'a', 'sitemap.xml'),
    root,
    baseUrl: 'https://example.com/a/sitemap.xml',
  })
  const host = findingFor(report, 'loc-host-out-of-scope')
  assert.equal(host.severity, 'error')
  assert.equal(host.location.pointer, '/urlset/url/1/loc')
  const path = findingFor(report, 'loc-path-out-of-scope')
  assert.equal(path.severity, 'warning')
  assert.equal(path.location.pointer, '/urlset/url/2/loc')
  assert.equal(report.summary.hostScopeDeclared, true)
  assert.equal(exitCodeFor(report), 1)
})

test('without a declared location, host scope is reported as unverified rather than assumed', async (t) => {
  const root = await tree(t, {
    'sitemap.xml': `${OPEN}`
      + '<url><loc>https://example.com/one</loc></url>'
      + '<url><loc>https://other.example.net/two</loc></url>'
      + '</urlset>',
  })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root })
  const notice = findingFor(report, 'host-scope-not-declared')
  assert.equal(notice.severity, 'info')
  assert.equal(findingFor(report, 'mixed-hosts').severity, 'warning')
  assert.equal(report.summary.hostScopeDeclared, false)
  assert.equal(report.status, 'pass', 'an unverified scope is an info, not a silent claim of correctness')
})

test('duplicates are reported inside a file and across the tree', async (t) => {
  const root = await tree(t, {
    'index.xml': `${INDEX_OPEN}`
      + '<sitemap><loc>https://example.com/a.xml</loc></sitemap>'
      + '<sitemap><loc>https://example.com/b.xml</loc></sitemap>'
      + '</sitemapindex>',
    'a.xml': `${OPEN}`
      + '<url><loc>https://example.com/one</loc></url>'
      + '<url><loc>https://EXAMPLE.com/one</loc></url>'
      + '</urlset>',
    'b.xml': `${OPEN}<url><loc>https://example.com/one</loc></url></urlset>`,
  })
  const report = await validateSitemapTree({ sitemap: join(root, 'index.xml'), root, baseUrl: 'https://example.com/index.xml' })
  const inFile = findingFor(report, 'duplicate-loc')
  assert.equal(inFile.severity, 'error')
  assert.equal(inFile.location.file, 'a.xml')
  const acrossTree = findingFor(report, 'duplicate-loc-in-tree')
  assert.equal(acrossTree.severity, 'warning')
  assert.equal(acrossTree.location.file, 'b.xml')
  assert.match(acrossTree.message, /already appears in "a\.xml"/)
})

test('namespaces, fields and field values are checked against the protocol', async (t) => {
  const root = await tree(t, {
    'wrong-namespace.xml': '<urlset xmlns="https://example.com/made-up"><url><loc>https://example.com/</loc></url></urlset>',
    'no-namespace.xml': '<urlset><url><loc>https://example.com/</loc></url></urlset>',
    'legacy.xml': '<urlset xmlns="http://www.google.com/schemas/sitemap/0.84">'
      + '<url><loc>https://example.com/</loc></url></urlset>',
    'wrong-root.xml': `<feed xmlns="${SITEMAP_NAMESPACE}"><entry/></feed>`,
    'fields.xml': `${OPEN}`
      + '<url><loc>https://example.com/a</loc><loc>https://example.com/b</loc>'
      + '<changefreq>fortnightly</changefreq><priority>3</priority><updated>now</updated></url>'
      + '<url><loc>ftp://example.com/c</loc></url>'
      + '<url><loc>not a url</loc></url>'
      + '<url><lastmod>2026-02-28</lastmod></url>'
      + '<page><loc>https://example.com/d</loc></page>'
      + '</urlset>',
  })
  const run = (name) => validateSitemapTree({ sitemap: join(root, name), root })

  assert.equal(findingFor(await run('wrong-namespace.xml'), 'namespace-unexpected').severity, 'error')
  assert.equal(findingFor(await run('no-namespace.xml'), 'namespace-missing').severity, 'error')
  assert.equal(findingFor(await run('legacy.xml'), 'namespace-legacy').severity, 'warning')
  assert.equal(findingFor(await run('wrong-root.xml'), 'root-element-unexpected').severity, 'error')

  const fields = await run('fields.xml')
  for (const ruleId of [
    'field-repeated', 'changefreq-invalid', 'priority-invalid', 'unknown-field',
    'loc-scheme-unsupported', 'loc-whitespace', 'loc-missing', 'entry-element-unexpected',
  ]) {
    assert.equal(findingFor(fields, ruleId).severity, 'error', ruleId)
  }
  assert.equal(exitCodeFor(fields), 1)
})

test('recognised extension namespaces are accepted, unrecognised ones are flagged once', async (t) => {
  const root = await tree(t, {
    'sitemap.xml': `<urlset xmlns="${SITEMAP_NAMESPACE}"`
      + ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'
      + ' xmlns:made="https://example.com/made-up">'
      + '<url><loc>https://example.com/a</loc><image:image><image:loc>https://example.com/a.png</image:loc>'
      + '</image:image><made:thing>x</made:thing></url>'
      + '<url><loc>https://example.com/b</loc><made:thing>y</made:thing></url>'
      + '</urlset>',
  })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root })
  assert.equal(ruleIds(report).filter((id) => id === 'unknown-namespace').length, 1, 'one namespace, one finding')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.urls, 2)
})

test('a loc longer than the protocol allows is rejected', async (t) => {
  const long = `https://example.com/${'a'.repeat(PROTOCOL_LIMITS.maxLocLength)}`
  const root = await tree(t, { 'sitemap.xml': `${OPEN}<url><loc>${long}</loc></url></urlset>` })
  const report = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root })
  assert.match(findingFor(report, 'loc-too-long').message, /the sitemap protocol allows 2048/)
})

test('the future-lastmod check runs only against an injected reference time', async (t) => {
  const root = await tree(t, {
    'sitemap.xml': `${OPEN}<url><loc>https://example.com/</loc><lastmod>2030-01-01</lastmod></url></urlset>`,
  })
  const withoutClock = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root })
  assert.equal(ruleIds(withoutClock).includes('lastmod-in-future'), false)

  const withClock = await validateSitemapTree({ sitemap: join(root, 'sitemap.xml'), root, now: '2026-09-13T00:00:00Z' })
  assert.equal(findingFor(withClock, 'lastmod-in-future').severity, 'warning')
  assert.equal(withClock.status, 'pass')
})

test('invalid configuration is refused before anything is read', async () => {
  await assert.rejects(() => validateSitemapTree({}), /options.sitemap must be a path/)
  await assert.rejects(() => validateSitemapTree(null), /options must be an object/)
  await assert.rejects(
    () => validateSitemapTree({ sitemap: 'x.xml', baseUrl: 'not-a-url' }),
    /baseUrl "not-a-url" is not an absolute URL/,
  )
  await assert.rejects(
    () => validateSitemapTree({ sitemap: 'x.xml', baseUrl: 'ftp://example.com/s.xml' }),
    /baseUrl must use http or https/,
  )
  await assert.rejects(() => validateSitemapTree({ sitemap: 'x.xml', now: '2026-02-30' }), /names day 30/)
  await assert.rejects(
    () => validateSitemapTree({ sitemap: 'x.xml', limits: { maxIndexDepth: -1 } }),
    /maxIndexDepth must be a non-negative integer/,
  )
  await assert.rejects(
    () => validateSitemapTree({ sitemap: '/tmp/a/sitemap.xml', root: '/tmp/b' }),
    /options.sitemap must be inside options.root/,
  )
})

test('determinism: the same tree twice produces byte-identical JSON', async () => {
  const options = {
    sitemap: join(EXAMPLES, 'broken', 'sitemap-index.xml'),
    baseUrl: 'https://example.com/sitemap-index.xml',
    now: '2026-09-13T00:00:00Z',
  }
  const first = JSON.stringify(await validateSitemapTree(options), null, 2)
  const second = JSON.stringify(await validateSitemapTree(options), null, 2)
  assert.equal(first, second)
  assert.equal(JSON.parse(first).status, 'incomplete')
})

test('determinism: findings are ordered by file, entry, pointer and rule', async (t) => {
  const root = await tree(t, {
    'b.xml': `${OPEN}<url><loc>https://example.com/b</loc><lastmod>2026-02-30</lastmod></url></urlset>`,
    'a.xml': `${OPEN}`
      + '<url><loc>https://example.com/a</loc><priority>9</priority><changefreq>often</changefreq></url>'
      + '<url><loc>ftp://example.com/a</loc></url>'
      + '</urlset>',
  })
  const first = await validateSitemapTree({ sitemap: join(root, 'a.xml'), root })
  assert.deepEqual(
    first.findings.map((finding) => `${finding.location.file}${finding.location.pointer ?? ''}:${finding.ruleId}`),
    [
      'a.xml:host-scope-not-declared',
      'a.xml/urlset/url/0/changefreq:changefreq-invalid',
      'a.xml/urlset/url/0/priority:priority-invalid',
      'a.xml/urlset/url/1/loc:loc-scheme-unsupported',
    ],
  )
  const second = await validateSitemapTree({ sitemap: join(root, 'a.xml'), root })
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test('determinism: the shared comparator orders by UTF-16 code unit, not by locale', () => {
  // Every pair here is one an ICU collator orders the other way round, which is
  // the whole point: ICU data differs between Node builds, so a locale-aware
  // comparator would make the report depend on the machine that produced it.
  assert.equal(byCodeUnit('Sitemap-B.xml', 'sitemap-a.xml'), -1)
  assert.equal(byCodeUnit('sitemap-a.xml', 'Sitemap-B.xml'), 1)
  assert.equal(byCodeUnit('zebra.xml', 'über.xml'), -1)
  assert.equal(byCodeUnit('tango.xml', 'ßeta.xml'), -1)
  assert.equal(byCodeUnit('/urlset/url/0/Priority', '/urlset/url/0/extra'), -1)
  assert.equal(byCodeUnit('same', 'same'), 0)
  assert.deepEqual(
    ['sitemap-a.xml', 'ßeta.xml', 'Sitemap-B.xml', 'über.xml', 'tango.xml', 'zebra.xml'].sort(byCodeUnit),
    ['Sitemap-B.xml', 'sitemap-a.xml', 'tango.xml', 'zebra.xml', 'ßeta.xml', 'über.xml'],
  )
})

test('determinism: report order follows code units through mixed-case and non-ASCII names', async (t) => {
  // "Sitemap-B.xml" precedes "sitemap-a.xml" and "tango.xml" precedes
  // "ßeta.xml" only under a code unit comparator; a locale-aware one reverses
  // both, and reverses "Priority" against "extra" inside each file as well.
  const entry = (path) => `<url><loc>https://example.com/${path}</loc><Priority>1.0</Priority><extra>x</extra></url>`
  const root = await tree(t, {
    'index.xml': `${INDEX_OPEN}`
      + '<sitemap><loc>https://example.com/sitemap-a.xml</loc></sitemap>'
      + '<sitemap><loc>https://example.com/Sitemap-B.xml</loc></sitemap>'
      + '<sitemap><loc>https://example.com/tango.xml</loc></sitemap>'
      + '<sitemap><loc>https://example.com/%C3%9Feta.xml</loc></sitemap>'
      + '</sitemapindex>',
    'sitemap-a.xml': `${OPEN}${entry('a')}</urlset>`,
    'Sitemap-B.xml': `${OPEN}${entry('b')}</urlset>`,
    'tango.xml': `${OPEN}${entry('t')}</urlset>`,
    'ßeta.xml': `${OPEN}${entry('s')}</urlset>`,
  })
  const report = await validateSitemapTree({
    sitemap: join(root, 'index.xml'),
    root,
    baseUrl: 'https://example.com/index.xml',
  })
  assert.equal(report.summary.files, 5, 'every listed member was read')
  assert.deepEqual(
    report.findings.map((finding) => `${finding.location.file}${finding.location.pointer ?? ''}`),
    [
      'Sitemap-B.xml/urlset/url/0/Priority',
      'Sitemap-B.xml/urlset/url/0/extra',
      'sitemap-a.xml/urlset/url/0/Priority',
      'sitemap-a.xml/urlset/url/0/extra',
      'tango.xml/urlset/url/0/Priority',
      'tango.xml/urlset/url/0/extra',
      'ßeta.xml/urlset/url/0/Priority',
      'ßeta.xml/urlset/url/0/extra',
    ],
  )
  const again = await validateSitemapTree({
    sitemap: join(root, 'index.xml'),
    root,
    baseUrl: 'https://example.com/index.xml',
  })
  assert.equal(JSON.stringify(report), JSON.stringify(again))
})

test('the remaining catalog rules fire against real inputs, not just documentation', async (t) => {
  const control = `https://example.com/${String.fromCharCode(1)}path`
  const root = await tree(t, {
    'repeated.xml': `${INDEX_OPEN}`
      + '<sitemap><loc>https://example.com/child.xml</loc></sitemap>'
      + '<sitemap><loc>https://example.com/child.xml</loc></sitemap>'
      + '</sitemapindex>',
    'child.xml': `${OPEN}<url><loc>https://example.com/a</loc></url></urlset>`,
    'compressible.xml.gz': gzipSync(Buffer.from(`${OPEN}${'<url><loc>https://example.com/a</loc></url>'.repeat(200)}</urlset>`, 'utf8')),
    'latin.xml': `<?xml version="1.0" encoding="ISO-8859-1"?>${OPEN}<url><loc>https://example.com/a</loc></url></urlset>`,
    'values.xml': `${OPEN}`
      + '<url><loc>   </loc></url>'
      + `<url><loc>${control}</loc></url>`
      + '<url><loc>https://example.com/c</loc><extra xmlns=""/></url>'
      + '</urlset>',
    'pair.xml': `${OPEN}<url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>`,
  })
  const at = (name, options = {}) => validateSitemapTree({ sitemap: join(root, name), root, ...options })

  const repeated = await at('repeated.xml', { baseUrl: 'https://example.com/repeated.xml' })
  assert.equal(findingFor(repeated, 'index-repeated-child').severity, 'warning')
  assert.equal(repeated.summary.files, 2, 'a file listed twice is read once')

  const ratio = await at('compressible.xml.gz', { limits: { maxCompressionRatio: 5 } })
  assert.equal(findingFor(ratio, 'compression-ratio-suspicious').severity, 'warning')

  assert.equal(findingFor(await at('latin.xml'), 'encoding-declared-unsupported').severity, 'warning')

  const values = await at('values.xml')
  assert.equal(findingFor(values, 'loc-empty').severity, 'error')
  assert.equal(findingFor(values, 'loc-control-character').severity, 'error')
  assert.equal(findingFor(values, 'element-unqualified').severity, 'error')

  const files = await at('repeated.xml', { baseUrl: 'https://example.com/repeated.xml', limits: { maxFiles: 1 } })
  assert.match(findingFor(files, 'file-limit-exceeded').message, /more than 1 files/)
  assert.equal(files.status, 'incomplete')

  const entries = await at('pair.xml', { limits: { maxTreeEntries: 1 } })
  assert.match(findingFor(entries, 'tree-entry-limit-exceeded').message, /more than 1 URLs/)
  assert.equal(entries.status, 'incomplete')
})
