# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a bounded, non-evaluating XML reader that refuses `<!DOCTYPE` and every entity
  declaration, expands nothing beyond the five predefined entities and legal
  numeric character references, resolves no external reference, and raises a
  named error for each of its element, depth, attribute, name and text bounds;
- `validateSitemapTree`, walking a local sitemap tree and reporting namespaces,
  root and entry elements, allowed fields, field cardinality, `<loc>` syntax and
  length, `<changefreq>`, `<priority>`, W3C `<lastmod>` syntax and calendar,
  host and path scope, in-file and cross-file duplicates, and index recursion;
- calendar validation that runs after the pattern, so `2026-02-30`,
  `1900-02-29`, `2026-13-01` and `...T24:00:00Z` are rejected as impossible
  rather than accepted as well-shaped;
- gzip support with compression detected from the magic bytes rather than the
  file name, a decompression output cap, and a compression-ratio warning;
- enforcement of the sitemap protocol limits of 50,000 entries and 50 MiB
  uncompressed per file, kept separate from the tool's own reader bounds so a
  policy violation fails the run while an unreadable input reports `incomplete`;
- bounded index recursion that terminates on a self reference or an ancestor
  cycle, reads a repeated child once, and refuses a reference resolving outside
  the declared input root, including one hidden behind percent-encoding;
- `parseW3CDateTime`, `validateSitemapDocument`, `parseXml`, `formatReport`,
  `exitCodeFor` and the limit constants as part of the public API;
- a CLI with `--sitemap`, `--root`, `--base-url`, `--now`, `--max-index-depth`,
  `--json` and `--help`, reporting on stdout, diagnostics on stderr, and exit
  codes 0 / 1 / 2;
- a clean three-file example tree with one genuinely gzipped member, and broken
  examples covering a self-referencing index, per-field rule violations and an
  external entity declaration;
- the rule catalog, limit reference and determinism guarantee in
  `docs/rules.md`.

No release has been published.
