// A small, forgiving HTML tokenizer for spec documents. It never backtracks: text and quoted
// attribute values are skipped with indexOf, so a 250k-character base64 `src` costs one scan.
// It does no tree building — html-blocks.ts keeps the element stack.

export type HtmlAttributes = ReadonlyMap<string, string>

export type HtmlToken =
  | { kind: 'text'; text: string }
  | { kind: 'open'; name: string; attrs: HtmlAttributes | null; selfClosing: boolean }
  | { kind: 'close'; name: string }
  /** A raw-text element (script, style, textarea, title) with its content, already closed. */
  | { kind: 'raw'; name: string; attrs: HtmlAttributes | null; text: string }

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])
/** Raw-text elements whose content still has its entities decoded. */
const ESCAPABLE_RAW_TEXT_ELEMENTS = new Set(['textarea', 'title'])

const isSpace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13 || code === 12

const isAsciiLetter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122)

export interface HtmlTagRead {
  name: string
  attrs: HtmlAttributes | null
  selfClosing: boolean
  /** Index just past the tag's `>` (the input length when the tag never closes). */
  end: number
}

/** Read the start tag whose `<` is at `start`. Attribute values are returned undecoded. */
export function readStartTag(html: string, start: number): HtmlTagRead {
  const length = html.length
  let index = start + 1
  while (index < length) {
    const code = html.charCodeAt(index)
    if (isSpace(code) || code === 47 || code === 62) break
    index++
  }
  const name = html.slice(start + 1, index).toLowerCase()
  let attrs: Map<string, string> | null = null
  let selfClosing = false

  while (index < length) {
    const code = html.charCodeAt(index)
    if (isSpace(code)) {
      index++
      continue
    }
    if (code === 62) {
      index++
      break
    }
    if (code === 47) {
      selfClosing = html.charCodeAt(index + 1) === 62
      index++
      continue
    }

    const nameStart = index
    index++
    while (index < length) {
      const next = html.charCodeAt(index)
      if (isSpace(next) || next === 61 || next === 62 || next === 47) break
      index++
    }
    const attrName = html.slice(nameStart, index).toLowerCase()
    while (index < length && isSpace(html.charCodeAt(index))) index++

    let value = ''
    if (html.charCodeAt(index) === 61) {
      index++
      while (index < length && isSpace(html.charCodeAt(index))) index++
      const quote = html.charCodeAt(index)
      if (quote === 34 || quote === 39) {
        const close = html.indexOf(quote === 34 ? '"' : "'", index + 1)
        value = html.slice(index + 1, close === -1 ? length : close)
        index = close === -1 ? length : close + 1
      } else {
        const valueStart = index
        while (index < length) {
          const next = html.charCodeAt(index)
          if (isSpace(next) || next === 62) break
          index++
        }
        value = html.slice(valueStart, index)
      }
    }
    if (!attrs) attrs = new Map()
    if (!attrs.has(attrName)) attrs.set(attrName, value)
  }

  return { name, attrs, selfClosing, end: index }
}

export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = []
  const length = html.length
  const pushText = (text: string): void => {
    if (text) tokens.push({ kind: 'text', text: decodeEntities(text) })
  }
  const skipPast = (terminator: string, from: number): number => {
    const end = html.indexOf(terminator, from)
    return end === -1 ? length : end + terminator.length
  }

  let position = 0
  while (position < length) {
    const lt = html.indexOf('<', position)
    if (lt === -1) {
      pushText(html.slice(position))
      break
    }
    if (lt > position) pushText(html.slice(position, lt))

    const next = html.charCodeAt(lt + 1)
    if (next === 33) {
      // Comments may hold markup; everything up to the terminator is skipped unseen.
      if (html.startsWith('<!--', lt)) {
        position = skipPast('-->', lt + 4)
      } else if (html.startsWith('<![CDATA[', lt)) {
        const end = html.indexOf(']]>', lt + 9)
        pushText(html.slice(lt + 9, end === -1 ? length : end))
        position = end === -1 ? length : end + 3
      } else {
        position = skipPast('>', lt + 2)
      }
    } else if (next === 63) {
      position = skipPast('>', lt + 2)
    } else if (next === 47) {
      if (isAsciiLetter(html.charCodeAt(lt + 2))) {
        let index = lt + 2
        while (index < length) {
          const code = html.charCodeAt(index)
          if (isSpace(code) || code === 62 || code === 47) break
          index++
        }
        tokens.push({ kind: 'close', name: html.slice(lt + 2, index).toLowerCase() })
        position = skipPast('>', index)
      } else {
        position = skipPast('>', lt + 2)
      }
    } else if (isAsciiLetter(next)) {
      const tag = readStartTag(html, lt)
      position = tag.end
      if (RAW_TEXT_ELEMENTS.has(tag.name)) {
        let text = ''
        if (!tag.selfClosing) {
          const close = findRawTextEnd(html, position, tag.name)
          text = html.slice(position, close.contentEnd)
          position = close.next
        }
        tokens.push({
          kind: 'raw',
          name: tag.name,
          attrs: tag.attrs,
          text: ESCAPABLE_RAW_TEXT_ELEMENTS.has(tag.name) ? decodeEntities(text) : text
        })
      } else {
        tokens.push({
          kind: 'open',
          name: tag.name,
          attrs: tag.attrs,
          selfClosing: tag.selfClosing
        })
      }
    } else {
      // A lone "<" ("a < b") is text.
      pushText('<')
      position = lt + 1
    }
  }
  return tokens
}

function findRawTextEnd(
  html: string,
  from: number,
  name: string
): { contentEnd: number; next: number } {
  const length = html.length
  for (let at = html.indexOf('</', from); at !== -1; at = html.indexOf('</', at + 2)) {
    const nameEnd = at + 2 + name.length
    if (html.slice(at + 2, nameEnd).toLowerCase() !== name) continue
    const after = html.charCodeAt(nameEnd)
    if (nameEnd >= length || isSpace(after) || after === 62 || after === 47) {
      const gt = html.indexOf('>', nameEnd)
      return { contentEnd: at, next: gt === -1 ? length : gt + 1 }
    }
  }
  return { contentEnd: length, next: length }
}

const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
  ['ensp', ' '],
  ['emsp', ' '],
  ['thinsp', ' '],
  ['shy', ''],
  ['zwnj', ''],
  ['zwj', ''],
  ['lrm', ''],
  ['rlm', ''],
  ['copy', '©'],
  ['reg', '®'],
  ['trade', '™'],
  ['hellip', '…'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['minus', '−'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['sbquo', '‚'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['bdquo', '„'],
  ['laquo', '«'],
  ['raquo', '»'],
  ['lsaquo', '‹'],
  ['rsaquo', '›'],
  ['bull', '•'],
  ['middot', '·'],
  ['sdot', '⋅'],
  ['times', '×'],
  ['divide', '÷'],
  ['plusmn', '±'],
  ['deg', '°'],
  ['micro', 'µ'],
  ['para', '¶'],
  ['sect', '§'],
  ['dagger', '†'],
  ['prime', '′'],
  ['frac12', '½'],
  ['frac14', '¼'],
  ['frac34', '¾'],
  ['sup2', '²'],
  ['sup3', '³'],
  ['larr', '←'],
  ['rarr', '→'],
  ['uarr', '↑'],
  ['darr', '↓'],
  ['harr', '↔'],
  ['lArr', '⇐'],
  ['rArr', '⇒'],
  ['hArr', '⇔'],
  ['le', '≤'],
  ['ge', '≥'],
  ['ne', '≠'],
  ['asymp', '≈'],
  ['equiv', '≡'],
  ['infin', '∞'],
  ['check', '✓'],
  ['cross', '✗'],
  ['euro', '€'],
  ['pound', '£'],
  ['yen', '¥'],
  ['cent', '¢'],
  ['iexcl', '¡'],
  ['iquest', '¿']
])

// The Latin-1 letters, as Word and older editors write them (`&eacute;`).
const LATIN1_LETTERS =
  '\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d0\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d7\u00d8\u00d9\u00da\u00db\u00dc\u00dd\u00de\u00df\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e6\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f0\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f7\u00f8\u00f9\u00fa\u00fb\u00fc\u00fd\u00fe\u00ff'
const LATIN1_NAMES = [
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute',
  'Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml',
  'Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc',
  'euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave',
  'uacute ucirc uuml yacute thorn yuml'
]
  .join(' ')
  .split(' ')
LATIN1_NAMES.forEach((name, index) => {
  if (!NAMED_ENTITIES.has(name)) NAMED_ENTITIES.set(name, [...LATIN1_LETTERS][index])
})

/**
 * What browsers show for a numeric reference in the C1 range (`&#146;` is a curly apostrophe,
 * not a control character): the windows-1252 characters, per the HTML standard.
 */
const C1_REPLACEMENTS = new Map<number, string>([
  [0x80, '\u20ac'],
  [0x82, '\u201a'],
  [0x83, '\u0192'],
  [0x84, '\u201e'],
  [0x85, '\u2026'],
  [0x86, '\u2020'],
  [0x87, '\u2021'],
  [0x88, '\u02c6'],
  [0x89, '\u2030'],
  [0x8a, '\u0160'],
  [0x8b, '\u2039'],
  [0x8c, '\u0152'],
  [0x8e, '\u017d'],
  [0x91, '\u2018'],
  [0x92, '\u2019'],
  [0x93, '\u201c'],
  [0x94, '\u201d'],
  [0x95, '\u2022'],
  [0x96, '\u2013'],
  [0x97, '\u2014'],
  [0x98, '\u02dc'],
  [0x99, '\u2122'],
  [0x9a, '\u0161'],
  [0x9b, '\u203a'],
  [0x9c, '\u0153'],
  [0x9e, '\u017e'],
  [0x9f, '\u0178']
])

const ENTITY_PATTERN =
  /&(?:#[xX]([0-9a-fA-F]{1,6});?|#([0-9]{1,7});?|([a-zA-Z][a-zA-Z0-9]{1,31});)/g

function fromCodePoint(codePoint: number): string {
  const replacement = C1_REPLACEMENTS.get(codePoint)
  if (replacement) return replacement
  const valid =
    codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
  return valid ? String.fromCodePoint(codePoint) : '\ufffd'
}

/** Decode numeric character references and the common named ones; unknown names stay as written. */
export function decodeEntities(text: string): string {
  if (text.indexOf('&') === -1) return text
  return text.replace(ENTITY_PATTERN, (match, hex?: string, decimal?: string, name?: string) => {
    if (hex) return fromCodePoint(parseInt(hex, 16))
    if (decimal) return fromCodePoint(parseInt(decimal, 10))
    return (name && NAMED_ENTITIES.get(name)) ?? match
  })
}
