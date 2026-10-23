// A forgiving tokenizer for mongosh-style text (filters, pipelines, shell statements), shared by
// the renderer (completion context, the pipeline text ⇄ stage cards conversion, read-only
// highlighting) and the secret masker (history, the assistant, persisted drafts). The text is
// usually half typed, so this never throws: an unterminated string, comment or regex becomes one
// token flagged `unterminated` that runs to the end of the input (a plain string ends at the end
// of its line). It knows JS strings (with escapes), template literals, line/block comments and
// regex literals (a `/` where a value may start). Nothing is evaluated; the server parses for
// real. Linear in the input.

export type ShellTokenType =
  'ident' | 'string' | 'template' | 'number' | 'regex' | 'comment' | 'punct' | 'other'

export interface ShellToken {
  type: ShellTokenType
  text: string
  start: number
  end: number
  /** String / template / comment / regex that reaches the end of the input without closing. */
  unterminated?: boolean
}

const PUNCT = new Set([
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ',',
  ':',
  ';',
  '.',
  '?',
  '!',
  '=',
  '+',
  '-',
  '*',
  '%',
  '&',
  '|',
  '<',
  '>',
  '^',
  '~'
])
/** After these tokens a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_PUNCT = new Set([
  '(',
  ',',
  ':',
  '[',
  '{',
  '!',
  '&',
  '|',
  '?',
  ';',
  '=',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^'
])
/**
 * After these keywords a `/` also starts a regex literal (`return /O'Brien/.test(this.name)` in
 * a $where function), except after a `.`, where the word is a property name (`x.in / 2`).
 */
const REGEX_AFTER_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'case',
  'in',
  'of',
  'void',
  'delete',
  'throw',
  'new',
  'yield',
  'await',
  'do',
  'else'
])

const NON_ASCII_SPACE = /\s/
const NON_ASCII_IDENT = /[\u00a0-\uffff]/

const isSpace = (c: number, ch: string): boolean =>
  c === 32 || (c >= 9 && c <= 13) || (c >= 128 && NON_ASCII_SPACE.test(ch))
const isDigit = (c: number): boolean => c >= 48 && c <= 57
const isAsciiLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
const isIdentStart = (c: number, ch: string): boolean =>
  isAsciiLetter(c) || c === 95 || c === 36 || (c >= 128 && NON_ASCII_IDENT.test(ch))
const isIdentPart = (c: number, ch: string): boolean => isIdentStart(c, ch) || isDigit(c)
/** Characters of a number token: digits, letters (hex, suffixes, exponent), `_` and `.`. */
const isNumberPart = (c: number): boolean => isDigit(c) || isAsciiLetter(c) || c === 95 || c === 46

function regexAllowedAfter(prev: ShellToken | null, beforePrev: ShellToken | null): boolean {
  if (!prev) return true
  if (prev.type === 'punct') return REGEX_AFTER_PUNCT.has(prev.text)
  return (
    prev.type === 'ident' &&
    REGEX_AFTER_WORDS.has(prev.text) &&
    !(beforePrev?.type === 'punct' && beforePrev.text === '.')
  )
}

function skipQuoted(text: string, from: number, quote: string): { end: number; closed: boolean } {
  let i = from + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return { end: i + 1, closed: true }
    // A plain string cannot span lines; treat the newline as the end (unterminated).
    if (quote !== '`' && (ch === '\n' || ch === '\r')) return { end: i, closed: false }
    i++
  }
  return { end: text.length, closed: false }
}

function skipRegex(text: string, from: number): { end: number; closed: boolean } {
  let i = from + 1
  let inClass = false
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '\n' || ch === '\r') return { end: i, closed: false }
    if (inClass) {
      if (ch === ']') inClass = false
    } else if (ch === '[') inClass = true
    else if (ch === '/') {
      i++
      while (i < text.length && isAsciiLetter(text.charCodeAt(i))) i++
      return { end: i, closed: true }
    }
    i++
  }
  return { end: text.length, closed: false }
}

/** Tokenizes `text`; whitespace is dropped, comments are kept as tokens. */
export function lexShell(text: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let prev: ShellToken | null = null
  let beforePrev: ShellToken | null = null
  let i = 0
  const n = text.length
  const push = (token: ShellToken): void => {
    tokens.push(token)
    if (token.type !== 'comment') {
      beforePrev = prev
      prev = token
    }
  }
  while (i < n) {
    const ch = text[i]
    const c = text.charCodeAt(i)
    if (isSpace(c, ch)) {
      i++
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      let end = text.indexOf('\n', i)
      if (end < 0) end = n
      push({ type: 'comment', text: text.slice(i, end), start: i, end })
      i = end
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      push({
        type: 'comment',
        text: text.slice(i, end),
        start: i,
        end,
        ...(close < 0 ? { unterminated: true } : {})
      })
      i = end
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const { end, closed } = skipQuoted(text, i, ch)
      push({
        type: ch === '`' ? 'template' : 'string',
        text: text.slice(i, end),
        start: i,
        end,
        ...(closed ? {} : { unterminated: true })
      })
      i = end
      continue
    }
    if (ch === '/' && regexAllowedAfter(prev, beforePrev)) {
      const { end, closed } = skipRegex(text, i)
      push({
        type: 'regex',
        text: text.slice(i, end),
        start: i,
        end,
        ...(closed ? {} : { unterminated: true })
      })
      i = end
      continue
    }
    if (isDigit(c) || (ch === '.' && isDigit(text.charCodeAt(i + 1)))) {
      const hex = c === 48 && (text[i + 1] === 'x' || text[i + 1] === 'X')
      let end = i + 1
      while (end < n && isNumberPart(text.charCodeAt(end))) {
        // 1e-5 / 1E+5: the sign belongs to the exponent.
        const e = text[end]
        const sign = text[end + 1]
        if ((e === 'e' || e === 'E') && (sign === '+' || sign === '-') && !hex) {
          end += 2
          continue
        }
        end++
      }
      push({ type: 'number', text: text.slice(i, end), start: i, end })
      i = end
      continue
    }
    if (isIdentStart(c, ch)) {
      let end = i + 1
      while (end < n && isIdentPart(text.charCodeAt(end), text[end])) end++
      push({ type: 'ident', text: text.slice(i, end), start: i, end })
      i = end
      continue
    }
    if (PUNCT.has(ch)) {
      push({ type: 'punct', text: ch, start: i, end: i + 1 })
      i++
      continue
    }
    push({ type: 'other', text: ch, start: i, end: i + 1 })
    i++
  }
  return tokens
}

/** The JS string value of a closed string token ('it\'s' → it's); null for anything else. */
export function stringTokenValue(token: ShellToken | undefined): string | null {
  if (!token || token.type !== 'string' || token.unterminated) return null
  const body = token.text.slice(1, -1)
  return body.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_m, esc) => {
      const c = esc as string
      if (c[0] === 'u' && c[1] === '{') return String.fromCodePoint(parseInt(c.slice(2, -1), 16))
      if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16))
      if (c[0] === 'x' && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16))
      switch (c) {
        case 'n':
          return '\n'
        case 'r':
          return '\r'
        case 't':
          return '\t'
        case 'b':
          return '\b'
        case 'f':
          return '\f'
        case 'v':
          return '\v'
        case '0':
          return '\0'
        case '\n':
          return ''
        default:
          return c
      }
    }
  )
}
