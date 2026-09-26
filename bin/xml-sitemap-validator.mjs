#!/usr/bin/env node

import { exitCodeFor, formatReport, validateSitemapTree } from '../src/index.mjs'

const HELP = `xml-sitemap-validator

Validate a local XML or gzipped sitemap tree: namespaces, allowed fields, URL
and date syntax, host scope, duplicate entries and bounded index recursion.

Usage:
  xml-sitemap-validator --sitemap FILE [--root DIR] [--base-url URL]
                        [--now W3CDATETIME] [--max-index-depth N] [--json]

Options:
  --sitemap FILE       Entry sitemap or sitemap index to validate
  --root DIR           Directory the tree lives in (default: the entry file's directory)
  --base-url URL       Published location of the entry file, used to check host
                       and path scope and to map index references onto files
  --now W3CDATETIME    Reference time for the future-lastmod warning. Without it
                       no clock is read and the check is simply not made
  --max-index-depth N  Index nesting levels followed below the entry file (default 3)
  --json               Emit the machine-readable JSON report on stdout
  -h, --help           Show this help

The report goes to stdout and operational diagnostics go to stderr, so
"--json" output can be piped straight into a JSON parser.

Nothing is fetched. Only files inside --root are read, and a sitemap index that
points outside it, or back at itself, is reported rather than followed.

Exit codes:
  0  the tree was read in full and satisfied the protocol
  1  the tree was read in full and broke the protocol
  2  invalid usage, or input that could not be read or fully evaluated
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { sitemap: null, root: null, baseUrl: null, now: null, maxIndexDepth: null, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--sitemap') options.sitemap = takeValue('--sitemap')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--base-url') options.baseUrl = takeValue('--base-url')
    else if (argument === '--now') options.now = takeValue('--now')
    else if (argument === '--max-index-depth') options.maxIndexDepth = takeValue('--max-index-depth')
    else throw new Error(`Unknown option "${argument}"`)
  }

  if (!options.sitemap) throw new Error('--sitemap is required')
  if (options.maxIndexDepth !== null) {
    if (!/^\d+$/.test(options.maxIndexDepth)) throw new Error('--max-index-depth must be a non-negative integer')
    options.maxIndexDepth = Number(options.maxIndexDepth)
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  try {
    const report = await validateSitemapTree({
      sitemap: options.sitemap,
      root: options.root ?? undefined,
      baseUrl: options.baseUrl,
      now: options.now,
      limits: options.maxIndexDepth === null ? undefined : { maxIndexDepth: options.maxIndexDepth },
      onDiagnostic: (message) => process.stderr.write(`xml-sitemap-validator: ${message}\n`),
    })
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
    return exitCodeFor(report)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }
}

process.exitCode = await main(process.argv.slice(2))
