// Splits Shell-tab text into top-level statements without parsing it: a small lexer that knows
// JS strings, template literals, comments, regex literals and bracket depth. It must work on
// half-typed text (the editor asks for "the statement at the cursor" on every keystroke), so
// it never fails; the parser reports errors per statement afterwards.
//
// Boundaries, as in mongosh scripts:
// - `;` at depth 0;
// - a newline at depth 0 when the statement looks complete: the previous token does not
//   expect more (`.`, `,`, `(`, operators...) and the next line does not continue the chain
//   (`.sort(...)`, `)`, operators). So a find() broken over several lines stays one statement;
// - `use x` / `show y` always end at the end of their line.
// Statement spans are trimmed of whitespace and leading/trailing comments.

export interface MongoShellSpan {
  /** source.slice(start, end): no trailing ';', no surrounding whitespace or comments. */
  text: string
  start: number
  end: number
}

const CONTINUES_BEFORE_NEWLINE = new Set([
  '.',
  ',',
  '(',
  '[',
  '{',
  ':',
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '?',
  '!',
  '<',
  '>',
  '^',
  '~'
])
const CONTINUES_AFTER_NEWLINE = new Set([
  '.',
  ')',
  ']',
  '}',
  ',',
  '?',
  ':',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '<',
  '>',
  '='
])
/** After these characters a `/` starts a regex literal rather than a division. */
const REGEX_AFTER = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>'
])
/**
 * After these keywords a `/` also starts a regex literal (`return /O'Brien/.test(this.name)` in
 * a $where function). Not after a `.`, where the word is a property name (`x.in / 2`).
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
const NON_ASCII_WORD_CHAR = /[\p{ID_Continue}\u200c\u200d]/u
/** An identifier / keyword / number character (`$` included, as in JS). */
function isWordChar(ch: string): boolean {
  const c = ch.charCodeAt(0)
  if (c >= 128) return NON_ASCII_WORD_CHAR.test(ch)
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36
  )
}

const isNewline = (ch: string): boolean => ch === '\n' || ch === '\r' || ch === ' ' || ch === ' '
const isSpace = (ch: string): boolean =>
  ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f' || ch === ' ' || ch === '﻿'

/** Index after the comment starting at `i` (which must be `//` or `/*`). */
function skipComment(source: string, i: number): number {
  if (source[i + 1] === '/') {
    let j = i + 2
    while (j < source.length && !isNewline(source[j])) j++
    return j
  }
  const end = source.indexOf('*/', i + 2)
  return end < 0 ? source.length : end + 2
}

/** Next significant character at or after `i` (skipping whitespace, newlines and comments). */
function nextSignificant(source: string, i: number): string {
  let j = i
  while (j < source.length) {
    const ch = source[j]
    if (isSpace(ch) || isNewline(ch)) j++
    else if (ch === '/' && (source[j + 1] === '/' || source[j + 1] === '*'))
      j = skipComment(source, j)
    else return ch
  }
  return ''
}

/** Index after a quoted string starting at `i`; unterminated '/" strings stop at the newline. */
function skipString(source: string, i: number): number {
  const quote = source[i]
  let j = i + 1
  while (j < source.length) {
    const ch = source[j]
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === quote) return j + 1
    if (quote !== '`' && isNewline(ch)) return j
    j++
  }
  return source.length
}

/** Index after a regex literal starting at `i` (including flags). */
function skipRegex(source: string, i: number): number {
  let j = i + 1
  let inClass = false
  while (j < source.length) {
    const ch = source[j]
    if (isNewline(ch)) return j
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      j++
      while (j < source.length && /[a-z]/i.test(source[j])) j++
      return j
    }
    j++
  }
  return source.length
}

const LINE_COMMAND = /^(use|show)[ \t]+[^\s(.=]/

export function splitMongoShell(source: string): MongoShellSpan[] {
  const spans: MongoShellSpan[] = []
  const n = source.length
  let depth = 0
  let start = -1
  let lastEnd = -1
  let lastChar = ''
  // The word that ended at lastEnd ('' after any other token, or after a `.`).
  let lastWord = ''
  let lineCommand = false

  const flush = (): void => {
    if (start >= 0 && lastEnd > start) {
      spans.push({ text: source.slice(start, lastEnd), start, end: lastEnd })
    }
    start = -1
    lastEnd = -1
    lastChar = ''
    lastWord = ''
    depth = 0
    lineCommand = false
  }
  const mark = (from: number, to: number, word = ''): void => {
    if (start < 0) {
      start = from
      lineCommand = LINE_COMMAND.test(source.slice(from, Math.min(n, from + 80)))
    }
    lastEnd = to
    lastChar = source[to - 1]
    lastWord = word
  }

  let i = 0
  while (i < n) {
    const ch = source[i]
    if (isNewline(ch)) {
      if (start >= 0 && depth === 0) {
        const complete =
          lineCommand ||
          (!CONTINUES_BEFORE_NEWLINE.has(lastChar) &&
            !CONTINUES_AFTER_NEWLINE.has(nextSignificant(source, i + 1)))
        if (complete) flush()
      }
      i++
      continue
    }
    if (isSpace(ch)) {
      i++
      continue
    }
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      i = skipComment(source, i)
      continue
    }
    if (ch === ';' && depth === 0) {
      flush()
      i++
      continue
    }
    if (lineCommand) {
      // `use x` / `show y`: plain words until the end of the line.
      mark(i, i + 1)
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(source, i)
      mark(i, end)
      i = end
      continue
    }
    if (ch === '/' && (REGEX_AFTER.has(lastChar) || REGEX_AFTER_WORDS.has(lastWord))) {
      const end = skipRegex(source, i)
      mark(i, end)
      i = end
      continue
    }
    if (isWordChar(ch)) {
      let end = i + 1
      while (end < n && isWordChar(source[end])) end++
      mark(i, end, lastChar === '.' ? '' : source.slice(i, end))
      i = end
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    mark(i, i + 1)
    i++
  }
  flush()
  return spans
}

/**
 * The statement under the cursor: the one containing `offset`; else the previous one when the
 * cursor is after it on the same line (after its `;` or in trailing whitespace); else the next
 * one when only whitespace on the same line separates them; null on blank lines.
 */
export function mongoStatementAtOffset(source: string, offset: number): MongoShellSpan | null {
  const spans = splitMongoShell(source)
  let previous: MongoShellSpan | null = null
  for (const span of spans) {
    if (offset >= span.start && offset <= span.end) return span
    if (span.end < offset) {
      previous = span
      continue
    }
    // span.start > offset
    if (previous && !/[\n\r]/.test(source.slice(previous.end, offset))) return previous
    if (!/[\n\r]/.test(source.slice(offset, span.start))) return span
    return null
  }
  if (previous && !/[\n\r]/.test(source.slice(previous.end, offset))) return previous
  return null
}
