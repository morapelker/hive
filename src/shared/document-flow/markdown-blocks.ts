import { isDataUri, type FigureRegistry, type RawBlock } from './block-assembly'
import { decodeEntities, readStartTag } from './html-tokenizer'

// Line-based readers for Markdown and plain text. Not a Markdown renderer: inline syntax
// (emphasis, links, inline HTML) stays as written — it is already text a model can read. Only
// what shapes the blocks is interpreted, and images, which must leave the text. Lines are
// classified from their first characters, so a 250k-character data URI line costs one scan.

const isDigit = (code: number): boolean => code >= 48 && code <= 57

function indentOf(line: string): { width: number; start: number } {
  let width = 0
  let start = 0
  for (; start < line.length; start++) {
    const code = line.charCodeAt(start)
    if (code === 32) width++
    else if (code === 9) width += 4 - (width % 4)
    else break
  }
  return { width, start }
}

const BULLETS = '-*+•◦▪‣'

/** "- ", "* ", "+ ", "1. ", "2) " at `start`; ordered markers are kept as part of the text. */
function readListMarker(
  line: string,
  start: number
): { marker: string; contentStart: number } | null {
  let end = start
  let marker = ''
  if (BULLETS.includes(line.charAt(start)) && start < line.length) {
    end = start + 1
  } else {
    while (end < line.length && end - start < 9 && isDigit(line.charCodeAt(end))) end++
    const punctuation = line.charCodeAt(end)
    if (end === start || (punctuation !== 46 && punctuation !== 41)) return null
    end++
    marker = `${line.slice(start, end)} `
  }
  const after = line.charCodeAt(end)
  if (after !== 32 && after !== 9) return null
  return { marker, contentStart: end + 1 }
}

/** A line made only of rule characters ("---", "* * *", "=====") separates, and says nothing. */
function isRule(trimmed: string, chars: string): boolean {
  if (trimmed.length < 3 || trimmed.length > 400 || !chars.includes(trimmed.charAt(0))) return false
  const first = trimmed.charAt(0)
  let count = 0
  for (const char of trimmed) {
    if (char === first) count++
    else if (char !== ' ' && char !== '\t') return false
  }
  return count >= 3
}

function isRunOf(trimmed: string, char: string, minimum: number): boolean {
  if (trimmed.length < minimum || trimmed.length > 400) return false
  for (const candidate of trimmed) if (candidate !== char) return false
  return true
}

function readAtxHeading(line: string, start: number): RawBlock | null {
  let end = start
  while (end < line.length && line.charCodeAt(end) === 35) end++
  const level = end - start
  const after = line.charCodeAt(end)
  if (level > 6 || (end < line.length && after !== 32 && after !== 9)) return null

  let text = line.slice(end).trim()
  let close = text.length
  while (close > 0 && text.charCodeAt(close - 1) === 35) close--
  if (close < text.length && (close === 0 || text.charCodeAt(close - 1) === 32)) {
    text = text.slice(0, close).trimEnd()
  }

  // "## Title {#anchor}"
  let anchor: string | null = null
  const open = text.endsWith('}') ? text.lastIndexOf('{#') : -1
  if (open !== -1) {
    const id = text.slice(open + 2, -1).trim()
    if (id && !/\s/.test(id)) {
      anchor = id
      text = text.slice(0, open).trimEnd()
    }
  }
  return { type: 'heading', level, anchor, text }
}

interface Fence {
  char: number
  length: number
}

function readFence(line: string, start: number): Fence | null {
  const char = line.charCodeAt(start)
  if (char !== 96 && char !== 126) return null
  let end = start
  while (end < line.length && line.charCodeAt(end) === char) end++
  if (end - start < 3) return null
  // ```code``` on one line is an inline span, not a fence.
  if (char === 96 && line.indexOf('`', end) !== -1) return null
  return { char, length: end - start }
}

function isFenceClose(line: string, fence: Fence): boolean {
  const { start } = indentOf(line)
  let end = start
  while (end < line.length && line.charCodeAt(end) === fence.char) end++
  return end - start >= fence.length && line.slice(end).trim() === ''
}

function stripIndent(line: string, width: number): string {
  let index = 0
  while (index < width && index < line.length && line.charCodeAt(index) === 32) index++
  return line.slice(index)
}

function splitTableRow(row: string): string[] {
  const cells: string[] = []
  let from = 0
  for (let at = row.indexOf('|'); at !== -1; at = row.indexOf('|', at + 1)) {
    if (at > 0 && row.charCodeAt(at - 1) === 92) continue
    cells.push(row.slice(from, at))
    from = at + 1
  }
  cells.push(row.slice(from))
  // The outer pipes of "| a | b |" are not cells.
  if (cells.length > 1 && cells[0].trim() === '') cells.shift()
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

const isSeparatorRow = (cells: readonly string[]): boolean =>
  cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))

function isSeparatorLine(line: string | undefined): boolean {
  if (line === undefined || line.length > 1000 || !line.includes('|')) return false
  return isSeparatorRow(splitTableRow(line.trim()))
}

const normalizeLabel = (label: string): string => label.replace(/\s+/g, ' ').trim().toLowerCase()

const MAX_LABEL_CHARS = 200

/** A link reference definition: `[label]: destination "title"`. */
function readDefinition(line: string): { label: string; destination: string } | null {
  const { width, start } = indentOf(line)
  if (width > 3 || line.charCodeAt(start) !== 91) return null
  const close = line.indexOf(']:', start + 1)
  if (close === -1 || close - start > MAX_LABEL_CHARS) return null
  const label = normalizeLabel(line.slice(start + 1, close))
  // "[^1]: …" is a footnote, which is text.
  if (!label || label.startsWith('^')) return null
  const rest = line.slice(close + 2).trim()
  if (rest.startsWith('<')) {
    const end = rest.indexOf('>')
    return end === -1 ? null : { label, destination: rest.slice(1, end).trim() }
  }
  const space = rest.search(/\s/)
  const destination = space === -1 ? rest : rest.slice(0, space)
  return destination ? { label, destination } : null
}

/** The target inside `![alt](…)`, without its optional title. */
function imageDestination(target: string): string {
  const value = target.trim()
  if (value.startsWith('<')) {
    const end = value.indexOf('>')
    return end === -1 ? '' : value.slice(1, end).trim()
  }
  // A data URI may be hard-wrapped, so whitespace alone does not end it; a title does.
  const end = value.search(isDataUri(value) ? /\s["'(]/ : /\s/)
  return end === -1 ? value : value.slice(0, end)
}

interface ImageContext {
  figures: FigureRegistry
  definitions: ReadonlyMap<string, string>
}

function readImage(
  text: string,
  at: number,
  context: ImageContext
): { token: string; end: number } | null {
  const altEnd = text.indexOf(']', at + 2)
  if (altEnd === -1 || altEnd - at > 1000) return null
  const alt = text.slice(at + 2, altEnd)
  const next = text.charCodeAt(altEnd + 1)

  if (next === 40) {
    const close = text.indexOf(')', altEnd + 2)
    if (close === -1) return null
    const src = imageDestination(text.slice(altEnd + 2, close))
    return src ? { token: context.figures.add(src, alt), end: close + 1 } : null
  }

  // Reference style: ![alt][label], ![label][] and ![label].
  let label = alt
  let end = altEnd + 1
  if (next === 91) {
    const labelEnd = text.indexOf(']', altEnd + 2)
    if (labelEnd === -1 || labelEnd - altEnd > MAX_LABEL_CHARS) return null
    label = text.slice(altEnd + 2, labelEnd) || alt
    end = labelEnd + 1
  }
  const destination = context.definitions.get(normalizeLabel(label))
  return destination ? { token: context.figures.add(destination, alt), end } : null
}

const HTML_IMAGE_PATTERN = /<img[\s/>]/gi

/** Images leave the text: `![alt](src)`, reference-style images and inline `<img>` tags. */
function replaceImages(text: string, context: ImageContext): string {
  let result = text
  if (text.indexOf('![') !== -1) {
    let out = ''
    let copied = 0
    let at = text.indexOf('![')
    while (at !== -1) {
      const image = readImage(text, at, context)
      if (image) {
        out += `${text.slice(copied, at)} ${image.token} `
        copied = image.end
      }
      at = text.indexOf('![', image ? image.end : at + 2)
    }
    result = out + text.slice(copied)
  }

  if (result.indexOf('<') === -1) return result
  HTML_IMAGE_PATTERN.lastIndex = 0
  let out = ''
  let copied = 0
  for (
    let match = HTML_IMAGE_PATTERN.exec(result);
    match !== null;
    match = HTML_IMAGE_PATTERN.exec(result)
  ) {
    const tag = readStartTag(result, match.index)
    const src = (tag.attrs?.get('src') ?? '').trim()
    if (src) {
      const alt = decodeEntities(tag.attrs?.get('alt') ?? '')
      const token = context.figures.add(isDataUri(src) ? src : decodeEntities(src), alt)
      out += `${result.slice(copied, match.index)} ${token} `
      copied = tag.end
    }
    HTML_IMAGE_PATTERN.lastIndex = Math.max(tag.end, match.index + 1)
  }
  return copied === 0 ? result : out + result.slice(copied)
}

/** Definitions outside code fences, by normalised label. */
function collectDefinitions(lines: readonly string[]): Map<string, string> {
  const definitions = new Map<string, string>()
  let fence: Fence | null = null
  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null
      continue
    }
    fence = readFence(line, indentOf(line).start)
    if (fence) continue
    const definition = readDefinition(line)
    if (definition && !definitions.has(definition.label)) {
      definitions.set(definition.label, definition.destination)
    }
  }
  return definitions
}

const FRONT_MATTER_MAX_LINES = 200

/** YAML front matter is kept, as one code block: read as Markdown it becomes a bogus heading. */
function readFrontMatter(lines: readonly string[], blocks: RawBlock[]): number {
  if (lines[0]?.trimEnd() !== '---') return 0
  const limit = Math.min(lines.length, FRONT_MATTER_MAX_LINES)
  for (let index = 1; index < limit; index++) {
    const line = lines[index].trimEnd()
    if (line !== '---' && line !== '...') continue
    const body = lines.slice(1, index).join('\n').trim()
    if (body) blocks.push({ type: 'code', text: body })
    return index + 1
  }
  return 0
}

function stripQuoteMarkers(line: string): string {
  let rest = line
  for (;;) {
    const { width, start } = indentOf(rest)
    if (width > 3 || rest.charCodeAt(start) !== 62) return rest
    rest = rest.slice(rest.charCodeAt(start + 1) === 32 ? start + 2 : start + 1)
  }
}

interface PendingBlock {
  type: 'paragraph' | 'list-item'
  prefix: string
  lines: string[]
}

/**
 * `figures` is null for plain text, where only blank lines and list markers are interpreted:
 * a "#" or a "|" at the start of a line of prose means nothing there.
 */
function readLines(content: string, figures: FigureRegistry | null): RawBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const blocks: RawBlock[] = []
  const context: ImageContext | null = figures
    ? { figures, definitions: collectDefinitions(lines) }
    : null
  /** Indentation of the open list levels, outermost first. */
  const listIndents: number[] = []
  let pending: PendingBlock | null = null
  let inTable = false

  const inline = (text: string): string =>
    (context ? replaceImages(text, context) : text).replace(/\s+/g, ' ').trim()

  const flush = (): void => {
    if (!pending) return
    const text = inline(pending.lines.join('\n'))
    if (text) blocks.push({ type: pending.type, text: pending.prefix + text })
    pending = null
  }

  const listLevel = (indent: number): number => {
    while (listIndents.length > 0 && listIndents[listIndents.length - 1] > indent) listIndents.pop()
    if (listIndents.length === 0 || indent >= listIndents[listIndents.length - 1] + 2) {
      listIndents.push(indent)
    }
    return listIndents.length - 1
  }

  for (let index = context ? readFrontMatter(lines, blocks) : 0; index < lines.length; index++) {
    let line = lines[index]
    if (context) {
      // The definition of an embedded image is its payload; the image itself is a figure.
      const definition = readDefinition(line)
      if (definition && isDataUri(definition.destination)) continue
      line = stripQuoteMarkers(line)
    }
    const { width, start } = indentOf(line)
    if (start >= line.length) {
      flush()
      inTable = false
      continue
    }
    const trimmed = line.slice(start).trimEnd()
    const wasInTable = inTable
    inTable = false

    if (context) {
      const fence = readFence(line, start)
      if (fence) {
        flush()
        // A fence opened inside a block quote closes on a quoted fence line, and ends with the
        // quote: the first unquoted line is read again as ordinary text.
        const quoted = line !== lines[index]
        const code: string[] = []
        for (index++; index < lines.length; index++) {
          const raw = lines[index]
          const body = quoted ? stripQuoteMarkers(raw) : raw
          if (isFenceClose(body, fence)) break
          if (quoted && body === raw) {
            index--
            break
          }
          code.push(stripIndent(body, width))
        }
        const text = code.join('\n').trimEnd()
        if (text.trim()) blocks.push({ type: 'code', text })
        continue
      }

      if (width <= 3 && line.charCodeAt(start) === 35) {
        const heading = readAtxHeading(line, start)
        if (heading) {
          flush()
          listIndents.length = 0
          blocks.push({ ...heading, text: inline(heading.text) })
          continue
        }
      }

      if (pending?.type === 'paragraph') {
        const level = isRunOf(trimmed, '=', 2) ? 1 : isRunOf(trimmed, '-', 3) ? 2 : 0
        if (level > 0) {
          const text = inline(pending.lines.join('\n'))
          pending = null
          if (text) blocks.push({ type: 'heading', level, anchor: null, text })
          continue
        }
      }

      const startsRow = trimmed.charCodeAt(0) === 124
      if (
        startsRow ||
        (trimmed.includes('|') && (wasInTable || isSeparatorLine(lines[index + 1])))
      ) {
        flush()
        inTable = true
        const cells = splitTableRow(trimmed)
        if (!isSeparatorRow(cells)) {
          const row = cells.map(inline)
          if (row.some((cell) => cell !== '')) {
            blocks.push({ type: 'table-row', text: row.join(' | ') })
          }
        }
        continue
      }
    }

    if (isRule(trimmed, context ? '-*_' : '-*_=~#')) {
      flush()
      continue
    }

    const item = readListMarker(line, start)
    if (item) {
      flush()
      pending = {
        type: 'list-item',
        prefix: '  '.repeat(listLevel(width)) + item.marker,
        lines: [line.slice(item.contentStart)]
      }
      continue
    }

    if (pending) {
      pending.lines.push(trimmed)
      continue
    }
    // An unindented paragraph ends the list; an indented one continues its last item.
    if (width < 2) listIndents.length = 0
    pending = { type: 'paragraph', prefix: '', lines: [trimmed] }
  }
  flush()
  return blocks
}

export function markdownToBlocks(content: string, figures: FigureRegistry): RawBlock[] {
  return readLines(content, figures)
}

/**
 * Plain text: paragraphs split on blank lines. Bulleted and numbered lines still become list
 * items, so a text file of numbered tasks keeps one addressable block per task.
 */
export function plainTextToBlocks(content: string): RawBlock[] {
  return readLines(content, null)
}
