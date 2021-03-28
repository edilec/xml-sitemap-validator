# XML Sitemap Validator

Validate a local XML or gzipped sitemap tree for namespaces, allowed fields, URL
and date syntax, host scope, duplicate entries and bounded index recursion.

- **Repository:** [edilec/xml-sitemap-validator](https://github.com/edilec/xml-sitemap-validator)
- **Area:** SEO & Search
- **License:** MIT

## The problem

A broken sitemap fails quietly. Search engines skip what they cannot parse and
rarely say why, so a tree can rot for months: a `lastmod` of `2026-02-30` that
looks like a date and is not one, a file that crept past 50,000 URLs, an index
that lists itself, half the URLs pointing at a staging host after a migration.

Online validators want the sitemap published first, which is exactly backwards:
the mistakes are cheapest to fix before deployment, in CI, from the build output
still sitting on disk. This tool reads that output, follows the index into the
files beside it, and reports what it found with an exit code CI can act on.

It is deliberately small: Node built-ins only, zero runtime and zero development
dependencies, and its own XML reader that refuses DTDs and expands no entities,
because a sitemap from a CMS export is untrusted input.

## Install

Node.js 22 or newer. No dependencies to install.

```sh
npm install xml-sitemap-validator
# or run it without installing
npx xml-sitemap-validator --help
```

From a checkout:

```sh
npm run check     # lint, tests, the runnable example, and a packaging dry run
```

## Commands

```sh
xml-sitemap-validator --sitemap FILE [--root DIR] [--base-url URL]
                      [--now W3CDATETIME] [--max-index-depth N] [--json]
```

| Option | Meaning |
| --- | --- |
| `--sitemap FILE` | entry sitemap or sitemap index (required) |
| `--root DIR` | directory the tree lives in; defaults to the entry file's directory. Entry and child real paths, including symlink targets, must stay inside its real path; an escape yields incomplete exit 2 without reading the target |
| `--base-url URL` | published location of the entry file. Enables host and path scope checks and maps index references onto files |
| `--now W3CDATETIME` | reference time for the future-`lastmod` warning. Without it no clock is read and the check is simply not made |
| `--max-index-depth N` | index nesting levels followed below the entry file (default 3) |
| `--json` | emit the machine-readable JSON report on stdout |
| `-h`, `--help` | usage |

Package scripts: `lint`, `test`, `test:coverage`, `example`, `pack:check`, and
`check`, which runs all of them.

## Inputs

Local files only. Nothing is fetched, ever.

- `.xml` sitemaps and sitemap indexes in the `0.9` namespace (the retired `0.84`
  namespace is read and reported as legacy).
- Gzipped files, detected from the `1f 8b` magic bytes rather than the file name,
  so a `.gz` that is not gzipped and a gzipped file without the suffix are both
  handled and both called out.
- UTF-8 text. Other encodings are refused rather than mis-decoded.
- The recognised extension namespaces (image, video, news, mobile, XHTML) are
  accepted and left unvalidated.

## Outputs

The report goes to stdout and operational diagnostics go to stderr, so `--json`
output pipes straight into a JSON parser:

```sh
xml-sitemap-validator --sitemap dist/sitemap.xml \
  --base-url https://example.com/sitemap.xml --json | jq '.summary'
```

```json
{
  "schemaVersion": "1",
  "tool": "xml-sitemap-validator",
  "status": "fail",
  "summary": {
    "checked": 8, "errors": 1, "warnings": 0, "info": 0,
    "files": 3, "urls": 6, "sitemaps": 2,
    "indexDepth": 1, "unresolvedChildren": 0, "hostScopeDeclared": true
  },
  "findings": [
    {
      "ruleId": "lastmod-impossible",
      "severity": "error",
      "message": "The \"<lastmod>\" value names day 30 of a month that has 28 days.",
      "location": { "file": "sitemap-pages.xml", "pointer": "/urlset/url/2/lastmod" },
      "evidence": "2026-02-30"
    }
  ]
}
```

Without `--json` the same report is printed as a human-readable summary.

The rule catalog, the field reference and the determinism guarantee are in
[docs/rules.md](./docs/rules.md).

## Examples

```sh
# a clean three-file tree, one member genuinely gzipped: exits 0
npm run example

# every field breaking a different rule, fully readable: exits 1
node bin/xml-sitemap-validator.mjs --sitemap examples/broken/sitemap-bad-fields.xml \
  --base-url https://example.com/sitemap-bad-fields.xml

# an index that lists itself and points at a file that is not there: exits 2
node bin/xml-sitemap-validator.mjs --sitemap examples/broken/sitemap-index.xml \
  --base-url https://example.com/sitemap-index.xml
```

## Programmatic use

```js
import { validateSitemapTree, exitCodeFor } from 'xml-sitemap-validator'

const report = await validateSitemapTree({
  sitemap: 'dist/sitemap.xml',
  baseUrl: 'https://example.com/sitemap.xml',
})

process.exitCode = exitCodeFor(report)
```

`parseW3CDateTime`, `validateSitemapDocument`, `parseXml` and the limit constants
are exported too, if you want one piece rather than the walk.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every declared file was read in full and satisfied the protocol |
| `1` | every declared file was read in full and broke the protocol |
| `2` | invalid usage, or input that could not be read or fully evaluated |

Status `incomplete` always exits 2 and always outranks `fail`. If a file in the
declared tree could not be opened, decoded, decompressed, or read within the
tool's bounds, the run says so rather than passing on evidence it never saw.

## Limits and non-goals

What this tool **cannot** conclude:

- **Whether any URL works.** Nothing is fetched. A `<loc>` that is syntactically
  perfect may still be a 404, a redirect, a `noindex` page or a parked domain,
  and this tool cannot tell you which. It reports URL *syntax* and *scope*, not
  reachability.
- **Whether a sitemap is actually published where it claims.** `--base-url` is
  something you assert; the tool trusts it and checks the tree against it. It
  does not verify that the file is served at that URL, or served at all.
- **Whether robots.txt allows any of it.** Cross-submission rules, `Disallow`
  lines and the `Sitemap:` directive are outside this tool. A
  `loc-path-out-of-scope` warning may be entirely legitimate if robots.txt
  authorises the cross-submission; the tool cannot see that.
- **Whether a search engine accepted the sitemap.** Indexing decisions, crawl
  budget, canonical selection and whether `changefreq` or `priority` influence
  anything at all are not observable from a file on disk.
- **Whether an extension namespace is correct.** Image, video, news, mobile and
  XHTML elements are recognised and then left alone. Their own required fields
  are not checked.
- **Whether the tree is complete.** The tool validates the files an index points
  at. It does not compare the tree against your routes, your CMS or your build
  output, so it cannot tell you a page is missing from the sitemap.
- **Anything about a file it could not read.** A reference it cannot map to a
  local file is reported as unverified and makes the run `incomplete`. That is a
  deliberate refusal to guess, not a gap to be worked around.

Also out of scope by design: no network access, no auto-fix and no writes. The
tool is read-only, reads only inside `--root`, and an index pointing outside that
directory, or back at itself, is reported rather than followed.

Validation is a floor, not a guarantee. A tree this tool passes is well-formed
and internally consistent; whether it is *correct* for your site is a question
about your site, which no file-level checker can answer.

## License

MIT. See [LICENSE](./LICENSE).
