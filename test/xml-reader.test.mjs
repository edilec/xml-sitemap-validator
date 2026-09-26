import assert from 'node:assert/strict'
import test from 'node:test'

import { XML_DEFAULT_LIMITS, XmlError, parseXml } from '../src/index.mjs'

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9'
const IMAGE_NS = 'http://www.google.com/schemas/sitemap-image/1.1'

function readingError(text, options) {
  try {
    parseXml(text, options)
  } catch (error) {
    assert.ok(error instanceof XmlError, `expected an XmlError, got ${error}`)
    return error
  }
  return assert.fail('expected the reader to refuse this document')
}

test('resolves default and prefixed namespaces onto every element', () => {
  const { root, elementCount, maxDepth } = parseXml(
    `<urlset xmlns="${SITEMAP_NS}" xmlns:image="${IMAGE_NS}">`
    + '<url><loc>https://example.com/</loc><image:image><image:loc>https://example.com/a.png</image:loc>'
    + '</image:image></url></urlset>',
  )
  assert.equal(root.ns, SITEMAP_NS)
  assert.equal(root.local, 'urlset')
  assert.equal(root.children[0].ns, SITEMAP_NS)
  assert.equal(root.children[0].children[0].text, 'https://example.com/')
  assert.equal(root.children[0].children[1].ns, IMAGE_NS)
  assert.equal(root.children[0].children[1].local, 'image')
  assert.equal(elementCount, 5)
  assert.equal(maxDepth, 4)
})

test('an unprefixed element outside any default declaration has no namespace', () => {
  const { root } = parseXml('<urlset><url/></urlset>')
  assert.equal(root.ns, null)
  assert.equal(root.children[0].ns, null)
})

test('an unprefixed attribute is never in the default namespace', () => {
  const { root } = parseXml(`<link xmlns="${SITEMAP_NS}" rel="alternate" xml:lang="fr"/>`)
  const [rel, lang] = root.attributes.filter((attribute) => attribute.name !== 'xmlns')
  assert.equal(rel.ns, null)
  assert.equal(rel.value, 'alternate')
  assert.equal(lang.ns, 'http://www.w3.org/XML/1998/namespace')
})

test('refuses a document type declaration, so no DTD is ever processed', () => {
  const error = readingError('<!DOCTYPE urlset><urlset/>')
  assert.equal(error.code, 'doctype-not-allowed')
  assert.equal(error.line, 1)
})

test('refuses an entity declaration pointing at an external resource', () => {
  const error = readingError(
    '<?xml version="1.0"?>\n<!DOCTYPE urlset [\n<!ENTITY x SYSTEM "file:///nonexistent/placeholder.txt">\n]>\n<urlset/>',
  )
  assert.equal(error.code, 'doctype-not-allowed')
  assert.equal(error.line, 2)
})

test('refuses an entity that is not one of the five predefined ones', () => {
  const error = readingError('<loc>https://example.com/&payload;</loc>')
  assert.equal(error.code, 'entity-not-allowed')
  assert.match(error.message, /predefined XML entities/)
})

test('expands only the predefined entities and bounded character references', () => {
  const { root } = parseXml('<loc>a&amp;b&lt;c&gt;d&quot;e&apos;f&#65;&#x42;</loc>')
  assert.equal(root.text, 'a&b<c>d"e\'fAB')
})

test('refuses a character reference that is not a legal XML character', () => {
  assert.equal(readingError('<loc>&#0;</loc>').code, 'character-reference-invalid')
  assert.equal(readingError('<loc>&#xD800;</loc>').code, 'character-reference-invalid')
})

test('refuses a bare ampersand rather than guessing at it', () => {
  const error = readingError('<loc>https://example.com/?a=1&b=2</loc>')
  assert.equal(error.code, 'entity-unterminated')
})

test('reads CDATA literally and does not expand entities inside it', () => {
  const { root } = parseXml('<loc><![CDATA[https://example.com/?a=1&b=2]]></loc>')
  assert.equal(root.text, 'https://example.com/?a=1&b=2')
})

test('reports the declared encoding without acting on it', () => {
  const { declaredEncoding } = parseXml('<?xml version="1.0" encoding="ISO-8859-1"?><urlset/>')
  assert.equal(declaredEncoding, 'ISO-8859-1')
})

test('refuses mismatched, unclosed and unmatched tags', () => {
  assert.equal(readingError('<urlset><url></loc></urlset>').code, 'tag-mismatch')
  assert.equal(readingError('<urlset><url></urlset>').code, 'tag-mismatch')
  assert.equal(readingError('<urlset><url>').code, 'tag-unclosed')
  assert.equal(readingError('</urlset>').code, 'close-tag-unmatched')
  assert.equal(readingError('<urlset/><urlset/>').code, 'multiple-roots')
  assert.equal(readingError('   ').code, 'no-root-element')
})

test('refuses an unbound namespace prefix', () => {
  const error = readingError('<urlset><image:image/></urlset>')
  assert.equal(error.code, 'namespace-prefix-unbound')
})

test('refuses malformed attribute markup', () => {
  assert.equal(readingError('<urlset xmlns=foo/>').code, 'attribute-unquoted')
  assert.equal(readingError('<urlset xmlns/>').code, 'attribute-malformed')
  assert.equal(readingError('<urlset xmlns="unterminated/>').code, 'attribute-unterminated')
  assert.equal(readingError('<link href="a<b"/>').code, 'attribute-value-invalid')
  assert.equal(readingError('<3bad/>').code, 'name-invalid')
})

test('refuses character data outside the root element', () => {
  assert.equal(readingError('<urlset/>trailing text').code, 'text-outside-root')
})

test('enforces the element, depth, attribute and name bounds by name', () => {
  const deep = `${'<a>'.repeat(6)}${'</a>'.repeat(6)}`
  assert.equal(readingError(deep, { limits: { maxDepth: 4 } }).code, 'depth-limit-exceeded')

  const wide = `<urlset>${'<url/>'.repeat(10)}</urlset>`
  assert.equal(readingError(wide, { limits: { maxElements: 5 } }).code, 'element-limit-exceeded')

  const attributes = `<url ${['a', 'b', 'c'].map((name) => `${name}="1"`).join(' ')}/>`
  assert.equal(readingError(attributes, { limits: { maxAttributes: 2 } }).code, 'attribute-limit-exceeded')

  assert.equal(readingError('<averylongname/>', { limits: { maxNameLength: 4 } }).code, 'name-limit-exceeded')
  assert.equal(readingError('<loc>abcdefghij</loc>', { limits: { maxTextLength: 4 } }).code, 'text-limit-exceeded')
})

test('the published reader bounds are the documented ones', () => {
  assert.deepEqual({ ...XML_DEFAULT_LIMITS }, {
    maxElements: 400000,
    maxDepth: 32,
    maxAttributes: 64,
    maxNameLength: 256,
    maxTextLength: 4194304,
  })
})

test('skips comments, processing instructions and a byte order mark', () => {
  const { root } = parseXml('﻿<?xml version="1.0"?><!-- note --><urlset><?target data?><url/></urlset>')
  assert.equal(root.local, 'urlset')
  assert.equal(root.children.length, 1)
})

test('refuses unterminated comments and CDATA sections', () => {
  assert.equal(readingError('<urlset><!-- open </urlset>').code, 'comment-unterminated')
  assert.equal(readingError('<urlset><![CDATA[ open </urlset>').code, 'cdata-unterminated')
  assert.equal(readingError('<urlset><?pi open </urlset>').code, 'processing-instruction-unterminated')
})

test('reading the same document twice produces the same tree', () => {
  const document = `<urlset xmlns="${SITEMAP_NS}"><url><loc>https://example.com/</loc></url></urlset>`
  const strip = (node) => ({
    local: node.local,
    ns: node.ns,
    text: node.text,
    children: node.children.map(strip),
  })
  assert.deepEqual(strip(parseXml(document).root), strip(parseXml(document).root))
})
