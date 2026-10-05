import type { DocumentBlock, DocumentBlockType, DocumentFigureData } from './preprocess'

// What the HTML and Markdown readers share: the figure registry (embedded images leave the
// text here) and the last pass that turns their raw blocks into numbered document blocks.

export interface RawBlock {
  type: DocumentBlockType
  level?: number
  anchor?: string | null
  text: string
}

// Figure ids are zero-padded to the final figure count, which is only known once the whole
// document is read. Until then a figure is a private-use token inside the block text.
const FIGURE_TOKEN_OPEN = '\uE000'
const FIGURE_TOKEN_CLOSE = '\uE001'
const FIGURE_TOKEN_PATTERN = /\uE000(\d+)\uE001/g
const FIGURE_ONLY_PATTERN = /^(?:\s*\uE000\d+\uE001)+\s*$/
const RESERVED_CHARS_PATTERN = /[\uE000\uE001]/g

/** Remove the two private-use characters the figure tokens are made of from source text. */
export function stripReservedChars(content: string): string {
  return content.indexOf(FIGURE_TOKEN_OPEN) === -1 && content.indexOf(FIGURE_TOKEN_CLOSE) === -1
    ? content
    : content.replace(RESERVED_CHARS_PATTERN, '')
}

type FigureSource = Omit<DocumentFigureData, 'id'>

export interface FigureRegistry {
  /** Register an image; returns the token that stands for it inside block text. */
  add(src: string, alt: string): string
  readonly sources: readonly FigureSource[]
}

export function createFigureRegistry(): FigureRegistry {
  const sources: FigureSource[] = []
  return {
    sources,
    add(src, alt) {
      const cleanAlt = alt.replace(/\s+/g, ' ').trim()
      const embedded = isDataUri(src) ? parseDataUri(src) : undefined
      if (embedded === undefined) {
        sources.push({ alt: cleanAlt, mime: null, base64: null, src })
      } else {
        // An embedded image never keeps its URI: `src` would carry the payload into prompts.
        sources.push({
          alt: cleanAlt,
          mime: embedded?.mime ?? null,
          base64: embedded?.base64 ?? null,
          src: null
        })
      }
      return `${FIGURE_TOKEN_OPEN}${sources.length - 1}${FIGURE_TOKEN_CLOSE}`
    }
  }
}

export function isDataUri(src: string): boolean {
  return src.length >= 5 && src.slice(0, 5).toLowerCase() === 'data:'
}

const MAX_DATA_URI_HEADER = 200

/** null: a data URI too malformed to yield an image. */
function parseDataUri(src: string): { mime: string; base64: string } | null {
  const comma = src.indexOf(',')
  if (comma === -1 || comma > MAX_DATA_URI_HEADER) return null
  const header = src.slice(5, comma).toLowerCase().split(';')
  const mime = header[0].trim() || 'text/plain'
  let payload = src.slice(comma + 1)

  if (header.slice(1).some((part) => part.trim() === 'base64')) {
    if (payload.indexOf('%') !== -1) {
      try {
        payload = decodeURIComponent(payload)
      } catch {
        // Keep the payload as written
      }
    }
    return { mime, base64: /\s/.test(payload) ? payload.replace(/\s+/g, '') : payload }
  }
  return { mime, base64: base64FromBytes(percentDecodedBytes(payload)) }
}

/** The bytes of a percent-encoded (non-base64) data URI payload, e.g. an inline SVG. */
function percentDecodedBytes(payload: string): number[] {
  const bytes: number[] = []
  for (let index = 0; index < payload.length; index++) {
    if (payload.charCodeAt(index) === 37) {
      const byte = parseInt(payload.slice(index + 1, index + 3), 16)
      if (index + 2 < payload.length && !Number.isNaN(byte)) {
        bytes.push(byte)
        index += 2
        continue
      }
    }
    const codePoint = payload.codePointAt(index) ?? 0
    if (codePoint > 0xffff) index++
    if (codePoint < 0x80) {
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      )
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      )
    }
  }
  return bytes
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64FromBytes(bytes: readonly number[]): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    out += BASE64_ALPHABET[first >> 2]
    out += BASE64_ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)]
    out += second === undefined ? '=' : BASE64_ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)]
    out += third === undefined ? '=' : BASE64_ALPHABET[third & 63]
  }
  return out
}

const EMBEDDED_DATA_MARKER = ';base64,'
const EMBEDDED_DATA_NOTE = '[embedded data removed]'
const MIN_EMBEDDED_DATA_CHARS = 64
/** Hard-wrapped base64 continues on the next line in chunks at least this long. */
const MIN_WRAPPED_CHUNK_CHARS = 60

const isBase64Char = (code: number): boolean =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 43 ||
  code === 47 ||
  code === 61 ||
  code === 45 ||
  code === 95

const isWhitespace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13

function base64RunEnd(text: string, from: number): number {
  let end = from
  while (end < text.length && isBase64Char(text.charCodeAt(end))) end++
  return end
}

/**
 * Last line of defence for the "no base64 in the text" rule: a data URI that reached block
 * text some other way (plain text, a code sample, a link target) loses its payload.
 */
function scrubEmbeddedData(text: string): string {
  let marker = text.indexOf(EMBEDDED_DATA_MARKER)
  if (marker === -1) return text
  let out = ''
  let copied = 0
  while (marker !== -1) {
    const payloadStart = marker + EMBEDDED_DATA_MARKER.length
    let end = base64RunEnd(text, payloadStart)
    while (end < text.length && isWhitespace(text.charCodeAt(end))) {
      let chunkStart = end
      while (chunkStart < text.length && isWhitespace(text.charCodeAt(chunkStart))) chunkStart++
      const chunkEnd = base64RunEnd(text, chunkStart)
      if (chunkEnd - chunkStart < MIN_WRAPPED_CHUNK_CHARS) break
      end = chunkEnd
    }
    if (end - payloadStart >= MIN_EMBEDDED_DATA_CHARS) {
      out += text.slice(copied, payloadStart) + EMBEDDED_DATA_NOTE
      copied = end
    }
    marker = text.indexOf(EMBEDDED_DATA_MARKER, end)
  }
  return out + text.slice(copied)
}

const MAX_ALT_IN_TEXT = 160

function figureLabel(id: string, alt: string): string {
  const shown = alt.length > MAX_ALT_IN_TEXT ? `${alt.slice(0, MAX_ALT_IN_TEXT - 1)}…` : alt
  return `[${id} "${shown.replace(/"/g, "'")}"]`
}

export function finalizeBlocks(
  rawBlocks: readonly RawBlock[],
  registry: FigureRegistry
): { blocks: DocumentBlock[]; figures: DocumentFigureData[] } {
  const width = registry.sources.length >= 100 ? 3 : 2
  const figures = registry.sources.map((source, index) => ({
    id: `fig-${String(index + 1).padStart(width, '0')}`,
    ...source
  }))
  const resolveFigures = (text: string): string =>
    text.replace(FIGURE_TOKEN_PATTERN, (match, index: string) => {
      const figure = figures[Number(index)]
      return figure ? figureLabel(figure.id, figure.alt) : match
    })

  // An image that stands alone becomes a figure block; one inside running text, a heading, a
  // list item or a table cell stays in place as an inline reference.
  const split: RawBlock[] = []
  for (const block of rawBlocks) {
    if (block.type === 'paragraph' && FIGURE_ONLY_PATTERN.test(block.text)) {
      for (const token of block.text.match(FIGURE_TOKEN_PATTERN) ?? []) {
        split.push({ type: 'figure', text: token })
      }
    } else {
      split.push(block)
    }
  }

  // Every block is kept, repeated ones included: the same label paragraph under each task
  // ("Acceptance criteria:") or disclaimer under each mock-up is part of the spec as written.
  const blocks: DocumentBlock[] = []
  for (const block of split) {
    const text = resolveFigures(scrubEmbeddedData(block.text))
    if (!text.trim()) continue
    const numbered: DocumentBlock = { id: blocks.length + 1, type: block.type, text }
    if (block.type === 'heading') {
      numbered.level = block.level ?? 1
      numbered.anchor = block.anchor ?? null
    }
    blocks.push(numbered)
  }
  return { blocks, figures }
}
