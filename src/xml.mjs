/**
 * A deliberately small, non-evaluating XML reader.
 *
 * Sitemaps arrive from crawlers, CMS exports and third-party generators, so the
 * reader is a trust boundary rather than a convenience. It therefore refuses the
 * XML features that turn a parser into a fetcher or an amplifier:
 *
 *   - no DOCTYPE, so no internal or external DTD subset;
 *   - no entity declarations and no entity expansion beyond the five predefined
 *     entities and bounded numeric character references, so no billion laughs;
 *   - no external references of any kind, so no network and no file reads;
 *   - explicit element, depth, attribute, name and text bounds, each of which
 *     raises a named error instead of silently truncating the document.
 *
 * It is not a general XML processor. It understands exactly the subset the
 * sitemap protocol uses, and says so loudly when it meets anything else.
 */

export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'

export const XML_DEFAULT_LIMITS = Object.freeze({
  /** Elements in one document. A 50,000-URL sitemap uses roughly 150,000. */
  maxElements: 400000,
  /** Open-element nesting depth. The sitemap protocol never needs more than 5. */
  maxDepth: 32,
  /** Attributes on a single element. */
  maxAttributes: 64,
  /** Characters in one element or attribute name. */
  maxNameLength: 256,
  /** Characters of character data accumulated into a single element. */
  maxTextLength: 4194304,
})

const PREDEFINED_ENTITIES = Object.assign(Object.create(null), {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
})

const QNAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/
const EMPTY_NAMESPACES = Object.freeze(Object.create(null))

/** A reading failure that names which rule of this subset was broken. */
export class XmlError extends Error {
  constructor(code, message, line) {
    super(message)
    this.name = 'XmlError'
    this.code = code
    this.line = line
  }
}

function isSpace(code) {
  return code === 32 || code === 9 || code === 10 || code === 13
}

function isNameEnd(code) {
  return isSpace(code) || code === 47 || code === 62
}

/**
 * A character reference may only produce a character XML actually allows.
 * Surrogates, NUL and the C0 controls are rejected rather than smuggled into a
 * URL or a date where a later consumer would have to deal with them.
 */
function characterFromCodePoint(value, fail, offset, literal) {
  const allowed = value === 0x9
    || value === 0xa
    || value === 0xd
    || (value >= 0x20 && value <= 0xd7ff)
    || (value >= 0xe000 && value <= 0xfffd)
    || (value >= 0x10000 && value <= 0x10ffff)
  if (!allowed) {
    fail('character-reference-invalid', `The character reference "${literal}" is not a character XML permits.`, offset)
  }
  return String.fromCodePoint(value)
}

function decodeEntities(raw, fail, offset) {
  if (!raw.includes('&')) return raw
  let out = ''
  let index = 0
  while (index < raw.length) {
    const amp = raw.indexOf('&', index)
    if (amp === -1) {
      out += raw.slice(index)
      break
    }
    out += raw.slice(index, amp)
    const semicolon = raw.indexOf(';', amp + 1)
    if (semicolon === -1 || semicolon - amp > 12) {
      fail('entity-unterminated', 'A raw "&" was found. XML requires it to be written as "&amp;".', offset)
    }
    const body = raw.slice(amp + 1, semicolon)
    const literal = `&${body};`
    if (PREDEFINED_ENTITIES[body] !== undefined) {
      out += PREDEFINED_ENTITIES[body]
    } else if (/^#[0-9]{1,7}$/.test(body)) {
      out += characterFromCodePoint(Number(body.slice(1)), fail, offset, literal)
    } else if (/^#x[0-9A-Fa-f]{1,6}$/.test(body)) {
      out += characterFromCodePoint(Number.parseInt(body.slice(2), 16), fail, offset, literal)
    } else {
      fail(
        'entity-not-allowed',
        `The entity "${literal}" is not one of the five predefined XML entities. This reader declares no entities and expands none.`,
        offset,
      )
    }
    index = semicolon + 1
  }
  return out
}

/**
 * Read an XML document into a plain element tree.
 *
 * @param {string} text decoded document text
 * @param {{ limits?: object }} [options]
 * @returns {{ root: object, elementCount: number, maxDepth: number, declaredEncoding: string|null }}
 */
export function parseXml(text, options = {}) {
  const limits = { ...XML_DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  // Line numbers are read from the document, never from the clock or the host,
  // and the scan only ever moves forward so a large file stays linear.
  let scannedTo = 0
  let scannedLine = 1
  const lineAt = (offset) => {
    const target = Math.min(Math.max(offset, 0), source.length)
    if (target < scannedTo) {
      scannedTo = 0
      scannedLine = 1
    }
    while (scannedTo < target) {
      if (source.charCodeAt(scannedTo) === 10) scannedLine += 1
      scannedTo += 1
    }
    return scannedLine
  }
  const fail = (code, message, offset) => {
    throw new XmlError(code, message, lineAt(offset))
  }

  const stack = []
  let root = null
  let elementCount = 0
  let maxDepth = 0
  let declaredEncoding = null
  let index = 0

  const appendText = (value, offset) => {
    const open = stack[stack.length - 1]
    if (!open) {
      if (value.trim() !== '') fail('text-outside-root', 'Character data was found outside the root element.', offset)
      return
    }
    if (open.text.length + value.length > limits.maxTextLength) {
      fail('text-limit-exceeded', `A single element carries more than ${limits.maxTextLength} characters of text.`, offset)
    }
    open.text += value
  }

  while (index < source.length) {
    const lt = source.indexOf('<', index)
    if (lt === -1) {
      appendText(decodeEntities(source.slice(index), fail, index), index)
      break
    }
    if (lt > index) appendText(decodeEntities(source.slice(index, lt), fail, index), index)

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      if (end === -1) fail('comment-unterminated', 'A comment is opened with "<!--" and never closed with "-->".', lt)
      index = end + 3
      continue
    }

    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      if (end === -1) fail('cdata-unterminated', 'A CDATA section is opened and never closed with "]]>".', lt)
      appendText(source.slice(lt + 9, end), lt)
      index = end + 3
      continue
    }

    if (source.startsWith('<!', lt)) {
      fail(
        'doctype-not-allowed',
        'A "<!...>" declaration was found. This reader processes no document type declaration, no entity declaration and no external reference.',
        lt,
      )
    }

    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2)
      if (end === -1) fail('processing-instruction-unterminated', 'A processing instruction is never closed with "?>".', lt)
      const body = source.slice(lt + 2, end)
      if (/^xml(\s|$)/i.test(body)) {
        const declared = /encoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(body)
        if (declared) declaredEncoding = declared[1] ?? declared[2]
      }
      index = end + 2
      continue
    }

    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt + 2)
      if (end === -1) fail('tag-unterminated', 'A closing tag is never finished with ">".', lt)
      const closing = source.slice(lt + 2, end).trim()
      const open = stack.pop()
      if (!open) fail('close-tag-unmatched', `The closing tag "</${closing}>" has no matching open element.`, lt)
      if (open.name !== closing) {
        fail('tag-mismatch', `The closing tag "</${closing}>" does not match the open element "<${open.name}>".`, lt)
      }
      index = end + 1
      continue
    }

    let cursor = lt + 1
    let nameEnd = cursor
    while (nameEnd < source.length && !isNameEnd(source.charCodeAt(nameEnd))) nameEnd += 1
    const rawName = source.slice(cursor, nameEnd)
    if (rawName.length === 0) fail('tag-malformed', 'A "<" is not followed by an element name.', lt)
    if (rawName.length > limits.maxNameLength) {
      fail('name-limit-exceeded', `An element name is longer than ${limits.maxNameLength} characters.`, lt)
    }
    if (!QNAME.test(rawName)) fail('name-invalid', `"${rawName}" is not a valid XML element name.`, lt)

    const rawAttributes = []
    cursor = nameEnd
    let selfClosing = false
    for (;;) {
      while (cursor < source.length && isSpace(source.charCodeAt(cursor))) cursor += 1
      if (cursor >= source.length) fail('tag-unterminated', `The element "<${rawName}>" is never finished with ">".`, lt)
      const code = source.charCodeAt(cursor)
      if (code === 62) {
        cursor += 1
        break
      }
      if (code === 47) {
        if (source.charCodeAt(cursor + 1) !== 62) fail('tag-malformed', `The element "<${rawName}>" has a stray "/".`, lt)
        selfClosing = true
        cursor += 2
        break
      }
      let attributeEnd = cursor
      while (
        attributeEnd < source.length
        && !isSpace(source.charCodeAt(attributeEnd))
        && source.charCodeAt(attributeEnd) !== 61
        && source.charCodeAt(attributeEnd) !== 62
        && source.charCodeAt(attributeEnd) !== 47
      ) attributeEnd += 1
      const attributeName = source.slice(cursor, attributeEnd)
      if (attributeName.length === 0) fail('attribute-malformed', `The element "<${rawName}>" has malformed attribute markup.`, lt)
      if (attributeName.length > limits.maxNameLength) {
        fail('name-limit-exceeded', `An attribute name is longer than ${limits.maxNameLength} characters.`, lt)
      }
      if (!QNAME.test(attributeName)) fail('attribute-name-invalid', `"${attributeName}" is not a valid XML attribute name.`, lt)
      let valueCursor = attributeEnd
      while (valueCursor < source.length && isSpace(source.charCodeAt(valueCursor))) valueCursor += 1
      if (source.charCodeAt(valueCursor) !== 61) {
        fail('attribute-malformed', `The attribute "${attributeName}" on "<${rawName}>" has no value. XML requires name="value".`, lt)
      }
      valueCursor += 1
      while (valueCursor < source.length && isSpace(source.charCodeAt(valueCursor))) valueCursor += 1
      const quote = source.charCodeAt(valueCursor)
      if (quote !== 34 && quote !== 39) {
        fail('attribute-unquoted', `The attribute "${attributeName}" on "<${rawName}>" must have a quoted value.`, lt)
      }
      const quoteChar = quote === 34 ? '"' : "'"
      const closingQuote = source.indexOf(quoteChar, valueCursor + 1)
      if (closingQuote === -1) {
        fail('attribute-unterminated', `The attribute "${attributeName}" on "<${rawName}>" has an unterminated value.`, lt)
      }
      const rawValue = source.slice(valueCursor + 1, closingQuote)
      if (rawValue.includes('<')) {
        fail('attribute-value-invalid', `The attribute "${attributeName}" on "<${rawName}>" contains a raw "<".`, lt)
      }
      rawAttributes.push({ name: attributeName, value: decodeEntities(rawValue, fail, lt) })
      if (rawAttributes.length > limits.maxAttributes) {
        fail('attribute-limit-exceeded', `The element "<${rawName}>" has more than ${limits.maxAttributes} attributes.`, lt)
      }
      cursor = closingQuote + 1
    }

    const parent = stack[stack.length - 1] ?? null
    const inherited = parent ? parent.namespaces : EMPTY_NAMESPACES
    let namespaces = inherited
    for (const attribute of rawAttributes) {
      if (attribute.name !== 'xmlns' && !attribute.name.startsWith('xmlns:')) continue
      if (namespaces === inherited) namespaces = Object.assign(Object.create(null), inherited)
      const prefix = attribute.name === 'xmlns' ? '' : attribute.name.slice(6)
      namespaces[prefix] = attribute.value === '' ? null : attribute.value
    }

    const resolve = (qname, isAttribute) => {
      const colon = qname.indexOf(':')
      if (colon === -1) {
        return { local: qname, ns: isAttribute ? null : (namespaces[''] ?? null) }
      }
      const prefix = qname.slice(0, colon)
      const local = qname.slice(colon + 1)
      if (prefix === 'xmlns') return { local, ns: XMLNS_NAMESPACE }
      if (prefix === 'xml') return { local, ns: XML_NAMESPACE }
      const bound = namespaces[prefix]
      if (bound === undefined || bound === null) {
        fail('namespace-prefix-unbound', `The namespace prefix "${prefix}:" is used but never declared.`, lt)
      }
      return { local, ns: bound }
    }

    const resolved = resolve(rawName, false)
    const element = {
      name: rawName,
      local: resolved.local,
      ns: resolved.ns,
      attributes: rawAttributes.map((attribute) => {
        const attributeNames = resolve(attribute.name, true)
        return { name: attribute.name, local: attributeNames.local, ns: attributeNames.ns, value: attribute.value }
      }),
      children: [],
      text: '',
      line: lineAt(lt),
      namespaces,
    }

    elementCount += 1
    if (elementCount > limits.maxElements) {
      fail('element-limit-exceeded', `The document has more than ${limits.maxElements} elements.`, lt)
    }

    if (root === null) {
      root = element
    } else if (stack.length === 0) {
      fail('multiple-roots', 'The document has more than one root element.', lt)
    } else {
      parent.children.push(element)
    }

    const depth = stack.length + 1
    if (depth > maxDepth) maxDepth = depth
    if (!selfClosing) {
      if (depth > limits.maxDepth) {
        fail('depth-limit-exceeded', `Elements are nested deeper than ${limits.maxDepth} levels.`, lt)
      }
      stack.push(element)
    }
    index = cursor
  }

  if (root === null) fail('no-root-element', 'The document has no root element.', source.length)
  if (stack.length > 0) {
    fail('tag-unclosed', `The element "<${stack[stack.length - 1].name}>" is never closed.`, source.length)
  }

  return { root, elementCount, maxDepth, declaredEncoding }
}
