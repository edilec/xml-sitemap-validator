# Rule catalog, limits and determinism

This is the reference for `xml-sitemap-validator`. Rule identifiers are stable
across releases; renaming one is a breaking change and is recorded in
[CHANGELOG.md](../CHANGELOG.md).

## Report shape

```json
{
  "schemaVersion": "1",
  "tool": "xml-sitemap-validator",
  "status": "pass",
  "summary": {
    "checked": 8, "errors": 0, "warnings": 0, "info": 0,
    "files": 3, "urls": 6, "sitemaps": 2,
    "indexDepth": 1, "unresolvedChildren": 0, "hostScopeDeclared": true
  },
  "findings": []
}
```

| Field | Meaning |
| --- | --- |
| `summary.checked` | `<url>` plus `<sitemap>` entries validated across the tree |
| `summary.files` | files actually read |
| `summary.indexDepth` | deepest index nesting reached below the entry file |
| `summary.unresolvedChildren` | references that could not be mapped to a local file |
| `summary.hostScopeDeclared` | whether `--base-url` was supplied, so scope was checked rather than skipped |

A finding is `{ ruleId, severity, message, location: { file, pointer? }, evidence?, suggestion? }`.
`location.file` is relative to the input root, never an absolute host path.
`location.pointer` is a document field path such as `/urlset/url/3/lastmod`,
where the number is the zero-based position of the entry inside its root element.

## Status and exit codes

| Status | Exit | When |
| --- | ---: | --- |
| `pass` | 0 | every declared file was read in full and no error-severity rule fired |
| `fail` | 1 | every declared file was read in full and at least one error fired |
| `incomplete` | 2 | some input could not be read or evaluated, whatever else was found |

`incomplete` outranks `fail`. Unknown evidence is never reported as a pass: if a
file in the declared tree could not be opened, decoded, decompressed or read
within the bounds below, the run says so and exits 2.

Invalid configuration (a missing `--sitemap`, an unparseable `--base-url`, an
impossible `--now`) also exits 2, writes the reason to stderr and writes nothing
to stdout.

## Two kinds of limit

**Protocol limits** come from the sitemap protocol. Breaking one is a finding
about the document and fails the run.

| Limit | Value | Rule |
| --- | ---: | --- |
| Entries per file | 50,000 | `entry-limit-exceeded` |
| Uncompressed bytes per file | 52,428,800 (50 MiB) | `file-size-limit-exceeded` |
| Characters per `<loc>` | 2,048 | `loc-too-long` |

**Reader bounds** are this tool's own safety margin, set deliberately above the
protocol limits so a policy violation stays visible instead of turning into a
read failure. Hitting one means the input was not evaluated, so the run is
`incomplete` and exits 2. Every bound is overridable through `limits`.

| Bound | Default | Rule |
| --- | ---: | --- |
| `maxFileBytes` — bytes read from disk, checked before reading | 268,435,456 | `input-limit-exceeded` |
| `maxDecompressedBytes` — gunzip output cap | 67,108,864 | `decompressed-limit-exceeded` |
| `maxFiles` — files visited in one walk | 512 | `file-limit-exceeded` |
| `maxTreeEntries` — URLs tracked for duplicates | 1,000,000 | `tree-entry-limit-exceeded` |
| `maxIndexDepth` — index nesting below the entry file | 3 | `index-depth-exceeded` |
| `maxCompressionRatio` — expansion factor called out | 1,000 | `compression-ratio-suspicious` |
| `limits.xml.maxElements` | 400,000 | `input-limit-exceeded` |
| `limits.xml.maxDepth` | 32 | `input-limit-exceeded` |
| `limits.xml.maxAttributes` | 64 | `input-limit-exceeded` |
| `limits.xml.maxNameLength` | 256 | `input-limit-exceeded` |
| `limits.xml.maxTextLength` | 4,194,304 | `input-limit-exceeded` |

No bound is ever a silent truncation. Each one raises a named finding.

## The XML subset that is read

The reader is a trust boundary, not a convenience, so it refuses the XML
features that turn a parser into a fetcher or an amplifier:

- no `<!DOCTYPE`, and therefore no internal or external DTD subset;
- no entity declarations, and expansion of nothing beyond `&lt; &gt; &amp;
  &quot; &apos;` and numeric character references that name a legal XML
  character;
- no external references of any kind, so no network access and no extra file
  reads;
- a raw `&` is an error rather than a guess, and a raw `<` inside an attribute
  value is an error;
- CDATA is read literally and entities inside it are not expanded;
- input must be UTF-8; an XML declaration naming another encoding is reported
  and the bytes are still decoded as UTF-8 or refused.

Anything the reader refuses surfaces as `xml-malformed`, with the reader's own
code and line number in `evidence` (for example `doctype-not-allowed at line 2`).

## Compression

Gzip is detected from the `1f 8b` magic bytes, never from the file name, because
mirrored exports are routinely gzipped without a `.gz` suffix and named `.gz`
without being gzipped. The protocol size limit is measured against the
*uncompressed* bytes.

## Index recursion

A sitemap index is followed only into files that already exist inside the
declared input root. The walk:

- stops on a reference back to the current file or any of its ancestors
  (`index-cycle`);
- reads a file listed twice only once (`index-repeated-child`);
- stops at `maxIndexDepth` (`index-depth-exceeded`);
- refuses a reference that resolves outside the input root, including one hidden
  behind percent-encoding (`child-outside-root`);
- reports a reference it cannot map to a local file rather than assuming the
  file is fine (`child-sitemap-unresolved`).

With `--base-url` the mapping is exact: the path below the sitemap's own
directory, and nothing else. Without it the last path segment is looked up
directly in the input root, which is how mirrored exports are usually laid out.

## Rule catalog

### Reading a file

| ruleId | Severity | Incomplete | Meaning |
| --- | --- | :---: | --- |
| `file-unreadable` | error | yes | the file could not be opened, or is not a regular file |
| `input-limit-exceeded` | error | yes | a reader bound was reached, so the file was not evaluated |
| `decompression-failed` | error | yes | the gzip stream is corrupt or truncated |
| `decompressed-limit-exceeded` | error | yes | the gzip stream expands past `maxDecompressedBytes` |
| `compression-ratio-suspicious` | warning | no | the file expands beyond `maxCompressionRatio` times |
| `gzip-extension-mismatch` | warning | no | named `.gz` but not gzipped; read as plain XML |
| `encoding-invalid` | error | yes | the bytes are not valid UTF-8 |
| `encoding-declared-unsupported` | warning | no | the XML declaration names an encoding other than UTF-8 |
| `xml-malformed` | error | no | the file is not well-formed XML in the subset above |
| `file-size-limit-exceeded` | error | no | uncompressed bytes exceed the 50 MiB protocol limit |
| `file-limit-exceeded` | error | yes | the tree holds more files than `maxFiles` |

### The document as a whole

| ruleId | Severity | Meaning |
| --- | --- | --- |
| `namespace-missing` | error | the root element declares no namespace |
| `namespace-unexpected` | error | the root element is not in the sitemap namespace |
| `namespace-legacy` | warning | the retired `.../sitemap/0.84` namespace is in use |
| `root-element-unexpected` | error | the root is neither `urlset` nor `sitemapindex` |
| `entry-element-unexpected` | error | a root child is not the expected `url` or `sitemap` |
| `element-unqualified` | error | an element carries no namespace at all |
| `unknown-namespace` | warning | elements from an unrecognised namespace, reported once per namespace per file |
| `entry-missing` | error | the document holds no `url` or `sitemap` entries at all |
| `entry-limit-exceeded` | error | more than 50,000 entries in one file |
| `mixed-hosts` | warning | one file lists URLs on several hosts and no scope was declared |
| `host-scope-not-declared` | info | no `--base-url`, so host and path scope were not verified |
| `nested-index` | warning | an index is listed by another index; search engines generally do not follow this |

`entry-missing` is an error and not a warning on purpose. The sitemaps.org 0.9
schema gives `<url>` inside `<urlset>`, and `<sitemap>` inside `<sitemapindex>`,
the default `minOccurs` of 1, so a document with no entries is not a valid
sitemap. Reporting it any lower would leave the one outcome a validator must
never produce standing: `pass` and exit 0 over a file that held nothing to
check. An empty sitemap is usually a build that produced no routes, which is
exactly the failure worth catching before it is published.

Recognised extension namespaces are accepted and left unvalidated:
`sitemap-image/1.1`, `sitemap-video/1.1`, `sitemap-news/0.9`,
`sitemap-mobile/1.0` and XHTML (for `alternate` links).

### An entry

| ruleId | Severity | Meaning |
| --- | --- | --- |
| `loc-missing` | error | the entry has no `<loc>` |
| `loc-empty` | error | `<loc>` is empty |
| `loc-whitespace` | error | `<loc>` contains whitespace |
| `loc-control-character` | error | `<loc>` contains a control character |
| `loc-not-absolute` | error | `<loc>` is not an absolute URL |
| `loc-scheme-unsupported` | error | `<loc>` uses a scheme other than http or https |
| `loc-too-long` | error | `<loc>` is longer than 2,048 characters |
| `loc-host-out-of-scope` | error | `<loc>` is on a different origin from the declared location |
| `loc-path-out-of-scope` | warning | `<loc>` is not below the directory this sitemap is published in |
| `duplicate-loc` | error | the same normalised URL appears twice in one file |
| `duplicate-loc-in-tree` | warning | the same normalised URL appears in two files of the tree |
| `unknown-field` | error | a sitemap-namespace child the protocol does not define |
| `field-repeated` | error | a defined field appears more than once in one entry |
| `lastmod-malformed` | error | `<lastmod>` does not match the W3C datetime shape |
| `lastmod-impossible` | error | the shape matches but the calendar does not, such as `2026-02-30` |
| `lastmod-in-future` | warning | `<lastmod>` is later than the injected `--now`; not checked without one |
| `changefreq-invalid` | error | not one of `always hourly daily weekly monthly yearly never` |
| `priority-invalid` | error | not a decimal from `0.0` to `1.0` |
| `tree-entry-limit-exceeded` | error | duplicate tracking stopped at `maxTreeEntries` |
| `index-cycle` | error | the index references itself or one of its ancestors |
| `index-repeated-child` | warning | the same file is listed more than once in the tree |
| `index-depth-exceeded` | error | following the reference would pass `maxIndexDepth` |
| `child-outside-root` | error | the reference resolves outside the declared input root |
| `child-sitemap-unresolved` | warning | the reference could not be mapped to a local file |

### Dates

`<lastmod>` is a W3C datetime. The accepted shapes are `YYYY`, `YYYY-MM`,
`YYYY-MM-DD`, `YYYY-MM-DDThh:mmTZD`, `YYYY-MM-DDThh:mm:ssTZD` and
`YYYY-MM-DDThh:mm:ss.sTZD`, where `TZD` is `Z` or `+hh:mm` / `-hh:mm`. The `T`
and `Z` are uppercase, and a time without a timezone is malformed.

The shape is checked first and the calendar second. `2026-02-30`,
`2026-02-29`, `2025-04-31`, `1900-02-29`, `2026-13-01`, `0000-01-01`,
`...T24:00:00Z` and `...+30:00` all match a plausible pattern and are all
rejected as `lastmod-impossible`, with leap years handled by the full
Gregorian rule.

## Determinism guarantee

Running this tool twice over identical bytes produces byte-identical stdout.

- Findings sort by `location.file`, then the entry ordinal (a number, so entry 2
  precedes entry 10), then `location.pointer`, then `ruleId`, then `message`.
- All string comparison uses a plain UTF-16 code unit comparator. `localeCompare`
  is never used anywhere in this package, because ICU data differs between Node
  builds and would make output machine-dependent.
- No wall clock is read. `Date.now()` and `new Date()` with no argument do not
  appear in the source. The only time comparison, `lastmod-in-future`, runs
  against the reference time passed in through `--now`, and is simply not made
  when none is given.
- No randomness, no locale, no environment variable and no filesystem
  enumeration order affects the output. Files are visited in the order their
  index lists them.
- Object keys are emitted in a fixed order, so `JSON.stringify` output is stable.
- Evidence excerpts are whitespace-collapsed and capped at 120 characters, so a
  long or oddly wrapped input cannot change the shape of the report.

## What this tool cannot conclude

See the "Limits and non-goals" section of [README.md](../README.md). In short:
it reads local files only, never fetches anything, and therefore cannot tell you
whether a URL resolves, whether a sitemap is reachable at the location it claims,
whether robots.txt permits it, or whether a search engine has accepted it.
