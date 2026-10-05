import {
  createFigureRegistry,
  finalizeBlocks,
  stripReservedChars,
  type RawBlock
} from './block-assembly'
import { htmlToBlocks } from './html-blocks'
import { markdownToBlocks, plainTextToBlocks } from './markdown-blocks'

/**
 * Turns a spec document (HTML, Markdown or plain text) into numbered text blocks a model can
 * reference by id, and pulls embedded images out so they never reach a prompt. Pure: no
 * filesystem, no DOM — it runs in the server child (plain Node) and in tests.
 */

export type DocumentFormat = 'html' | 'markdown' | 'text'

export type DocumentBlockType =
  'heading' | 'paragraph' | 'list-item' | 'table-row' | 'figure' | 'code'

export interface DocumentBlock {
  /** 1-based; rendered as `[bN]`. */
  id: number
  type: DocumentBlockType
  /** Heading level 1-6 (headings only). */
  level?: number
  /** The element's `id` attribute, when it has one (headings and their containers). */
  anchor?: string | null
  /** Plain text. Figures read `[fig-01 "alt text"]`; inline badges keep their text. */
  text: string
}

export interface DocumentFigureData {
  /** `fig-01`, `fig-02`, … in document order. */
  id: string
  alt: string
  /** MIME type of an embedded (`data:`) image, e.g. `image/jpeg`; null otherwise. */
  mime: string | null
  /** Base64 payload of an embedded image; null when the image is referenced by `src`. */
  base64: string | null
  /** The original `src` when it is not a data URI (relative path, absolute path or URL). */
  src: string | null
}

export interface PreprocessedDocument {
  title: string
  format: DocumentFormat
  blocks: DocumentBlock[]
  figures: DocumentFigureData[]
  /** `renderBlocks(blocks, { withIds: true })`. */
  text: string
}

/** Pre-processed text above this many characters is refused (v1 has no chunked extraction). */
export const DOCUMENT_TEXT_LIMIT = 400_000

const EXTENSION_FORMATS = new Map<string, DocumentFormat>([
  ['html', 'html'],
  ['htm', 'html'],
  ['xhtml', 'html'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'markdown'],
  ['txt', 'text'],
  ['text', 'text']
])

const baseName = (fileName: string): string =>
  fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1)

function extensionOf(fileName: string): string {
  const name = baseName(fileName)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function titleFromFileName(fileName: string): string {
  const name = baseName(fileName)
  const dot = name.lastIndexOf('.')
  return (dot <= 0 ? name : name.slice(0, dot)).trim() || 'Document'
}

/** How much of an extension-less file is read to tell its format. */
const SNIFF_CHARS = 8192

const HTML_TAG_PATTERN = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi
const MARKDOWN_MARKERS: readonly RegExp[] = [
  /^ {0,3}#{1,6} \S/m,
  /^\s*[-*+] \S/m,
  /^\s*\d+[.)] \S/m,
  /^ {0,3}(?:```|~~~)/m,
  /^ {0,3}\|?[ :]*-{3,}[ :]*\|/m,
  /\[[^\]\n]+\]\([^)\s]+\)/,
  /\*\*[^*\n]+\*\*/,
  /^ {0,3}> \S/m
]

export function detectDocumentFormat(fileName: string, content: string): DocumentFormat {
  const byExtension = EXTENSION_FORMATS.get(extensionOf(fileName))
  if (byExtension) return byExtension

  const head = content.slice(0, SNIFF_CHARS)
  if (/<!doctype html|<html[\s>]|<body[\s>]|<head[\s>]/i.test(head)) return 'html'
  const tags = head.match(HTML_TAG_PATTERN)?.length ?? 0
  const markers = MARKDOWN_MARKERS.filter((marker) => marker.test(head)).length
  // Markdown may hold a few inline tags; an HTML fragment is mostly tags.
  if (tags >= 5 && tags > markers * 3) return 'html'
  return markers >= 2 ? 'markdown' : 'text'
}

export function preprocessDocument(input: {
  fileName: string
  content: string
}): PreprocessedDocument {
  const content = stripReservedChars(input.content.replace(/^\uFEFF/, ''))
  const format = detectDocumentFormat(input.fileName, content)
  const registry = createFigureRegistry()

  let declaredTitle: string | null = null
  let rawBlocks: RawBlock[]
  if (format === 'html') {
    const html = htmlToBlocks(content, registry)
    declaredTitle = html.title
    rawBlocks = html.blocks
  } else if (format === 'markdown') {
    rawBlocks = markdownToBlocks(content, registry)
  } else {
    rawBlocks = plainTextToBlocks(content)
  }

  const { blocks, figures } = finalizeBlocks(rawBlocks, registry)
  const firstHeading =
    format === 'text'
      ? undefined
      : blocks.find((block) => block.type === 'heading' && block.level === 1)
  return {
    title: declaredTitle ?? firstHeading?.text ?? titleFromFileName(input.fileName),
    format,
    blocks,
    figures,
    text: renderBlocks(blocks, { withIds: true })
  }
}

const TIGHT_BLOCK_TYPES: ReadonlySet<DocumentBlockType> = new Set(['list-item', 'table-row'])

function renderBlock(block: DocumentBlock): string {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level ?? 1))
      return `${'#'.repeat(level)} ${block.text}${block.anchor ? ` {#${block.anchor}}` : ''}`
    }
    case 'list-item': {
      const text = block.text.trimStart()
      const indent = block.text.slice(0, block.text.length - text.length)
      // Ordered items carry their own number ("3. …"), which is how the document refers to them.
      return /^\d{1,9}[.)] /.test(text) ? `${indent}${text}` : `${indent}- ${text}`
    }
    case 'table-row':
      return `| ${block.text} |`
    case 'code': {
      const fence = block.text.includes('```') ? '````' : '```'
      return `${fence}\n${block.text}\n${fence}`
    }
    default:
      return block.text
  }
}

/**
 * Render blocks as readable text: headings as `#`-prefixed lines (with `{#anchor}` when
 * present), list items as `- `, table rows as `| a | b |`, one blank line between blocks of
 * different kinds. With `withIds`, every block starts with `[bN] `.
 */
export function renderBlocks(
  blocks: readonly DocumentBlock[],
  options?: { withIds?: boolean }
): string {
  const withIds = options?.withIds === true
  const parts: string[] = []
  let previous: DocumentBlock | undefined
  for (const block of blocks) {
    if (previous) {
      // Items of one list and rows of one table stay together; everything else is spaced.
      parts.push(previous.type === block.type && TIGHT_BLOCK_TYPES.has(block.type) ? '\n' : '\n\n')
    }
    if (withIds) parts.push(`[b${block.id}] `)
    parts.push(renderBlock(block))
    previous = block
  }
  return parts.join('')
}
