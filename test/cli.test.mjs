import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(PROJECT, 'bin', 'xml-sitemap-validator.mjs')
const CLEAN = 'examples/clean/sitemap-index.xml'
const BROKEN_INDEX = 'examples/broken/sitemap-index.xml'
const BROKEN_FIELDS = 'examples/broken/sitemap-bad-fields.xml'

/** Run the real entry point as a separate process, exactly as a user would. */
function run(args, command = process.execPath) {
  const argv = command === process.execPath ? [CLI, ...args] : args
  return new Promise((resolveRun) => {
    execFile(command, argv, { cwd: PROJECT, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolveRun({ code: error === null ? 0 : error.code, stdout, stderr })
    })
  })
}

test('--help prints usage on stdout and exits 0', async () => {
  const { code, stdout, stderr } = await run(['--help'])
  assert.equal(code, 0)
  assert.match(stdout, /^xml-sitemap-validator/)
  assert.match(stdout, /--sitemap FILE/)
  assert.match(stdout, /Exit codes:/)
  assert.equal(stderr, '')
})

test('the clean example exits 0 and puts only JSON on stdout', async () => {
  const { code, stdout, stderr } = await run([
    '--sitemap', CLEAN, '--base-url', 'https://example.com/sitemap-index.xml', '--json',
  ])
  assert.equal(code, 0)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.tool, 'xml-sitemap-validator')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.files, 3)
  assert.match(stderr, /read sitemap-posts\.xml\.gz .* gzip yes/)
  assert.equal(stdout.includes('xml-sitemap-validator: read'), false, 'diagnostics never reach stdout')
})

test('the human-readable run of the clean example also exits 0', async () => {
  const { code, stdout } = await run(['--sitemap', CLEAN, '--base-url', 'https://example.com/sitemap-index.xml'])
  assert.equal(code, 0)
  assert.match(stdout, /status pass/)
  assert.match(stdout, /3 file\(s\), 8 entr\(ies\) checked/)
})

test('the executable bit and shebang let the CLI run directly', async () => {
  const { code, stdout } = await run(
    ['--sitemap', CLEAN, '--base-url', 'https://example.com/sitemap-index.xml', '--json'],
    CLI,
  )
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout).status, 'pass')
})

test('a fully readable tree that breaks policy exits 1', async () => {
  const { code, stdout } = await run([
    '--sitemap', BROKEN_FIELDS, '--base-url', 'https://example.com/sitemap-bad-fields.xml', '--json',
  ])
  assert.equal(code, 1)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'fail')
  assert.ok(report.summary.errors >= 6)
  const rules = new Set(report.findings.map((finding) => finding.ruleId))
  for (const ruleId of ['lastmod-impossible', 'lastmod-malformed', 'duplicate-loc', 'changefreq-invalid', 'priority-invalid', 'unknown-field', 'loc-missing', 'loc-not-absolute']) {
    assert.ok(rules.has(ruleId), `expected ${ruleId}`)
  }
})

test('a tree that could not be read in full exits 2 and reports incomplete', async () => {
  const { code, stdout } = await run([
    '--sitemap', BROKEN_INDEX, '--base-url', 'https://example.com/sitemap-index.xml', '--json',
  ])
  assert.equal(code, 2)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'incomplete')
  const rules = new Set(report.findings.map((finding) => finding.ruleId))
  assert.ok(rules.has('index-cycle'))
  assert.ok(rules.has('child-sitemap-unresolved'))
  assert.ok(rules.has('loc-host-out-of-scope'))
})

test('malformed XML from the real CLI exits 1 and names the reader rule', async () => {
  const { code, stdout } = await run(['--sitemap', 'examples/broken/sitemap-entity-expansion.xml', '--json'])
  assert.equal(code, 1)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'fail')
  const finding = report.findings.find((item) => item.ruleId === 'xml-malformed')
  assert.match(finding.evidence, /doctype-not-allowed/)
})

test('an input file that does not exist exits 2 with a report, not a crash', async () => {
  const { code, stdout } = await run(['--sitemap', 'examples/clean/absent.xml', '--json'])
  assert.equal(code, 2)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'file-unreadable'), true)
})

test('invalid usage exits 2, writes nothing to stdout and explains itself on stderr', async () => {
  for (const argv of [[], ['--sitemap'], ['--nope'], ['--sitemap', CLEAN, '--max-index-depth', 'deep']]) {
    const { code, stdout, stderr } = await run(argv)
    assert.equal(code, 2, `argv ${JSON.stringify(argv)}`)
    assert.equal(stdout, '', 'stdout stays parseable or empty, never half a message')
    assert.match(stderr, /xml-sitemap-validator/)
  }
})

test('an invalid reference time or base URL exits 2 before anything is validated', async () => {
  const badNow = await run(['--sitemap', CLEAN, '--now', '2026-02-30'])
  assert.equal(badNow.code, 2)
  assert.equal(badNow.stdout, '')
  assert.match(badNow.stderr, /names day 30/)

  const badBase = await run(['--sitemap', CLEAN, '--base-url', 'nonsense'])
  assert.equal(badBase.code, 2)
  assert.equal(badBase.stdout, '')
  assert.match(badBase.stderr, /is not an absolute URL/)
})

test('determinism: two CLI runs over the same tree write byte-identical stdout', async () => {
  const argv = ['--sitemap', BROKEN_INDEX, '--base-url', 'https://example.com/sitemap-index.xml', '--now', '2026-09-13T00:00:00Z', '--json']
  const first = await run(argv)
  const second = await run(argv)
  assert.equal(first.code, second.code)
  assert.equal(first.stdout, second.stdout)
  assert.ok(first.stdout.length > 0)
})

test('--max-index-depth 0 stops at the entry file and reports the bound', async () => {
  const { code, stdout } = await run([
    '--sitemap', CLEAN, '--base-url', 'https://example.com/sitemap-index.xml', '--max-index-depth', '0', '--json',
  ])
  assert.equal(code, 2)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.files, 1)
  assert.equal(report.findings.filter((finding) => finding.ruleId === 'index-depth-exceeded').length, 2)
})
