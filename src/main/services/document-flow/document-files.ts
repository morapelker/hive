import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  renderBlocks,
  type DocumentFigureData,
  type PreprocessedDocument
} from '@shared/document-flow/preprocess'

// Files of a document run. The picked document is only ever read; everything the run derives
// from it (the block-numbered text agents are pointed to, the extracted images) lives in an
// app-owned directory per run, next to the attachments directory.

export const DOCUMENT_MAX_BYTES = 80 * 1024 * 1024
export const FIGURE_MAX_BYTES = 15 * 1024 * 1024
/** How much of the file is checked for NUL bytes before it is read as text. */
const BINARY_SNIFF_BYTES = 8192

/** A problem with the picked document, worded for the person who picked it. */
export class DocumentFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentFileError'
  }
}

export function documentRunsRoot(home: string = homedir()): string {
  return join(home, '.hive', 'document-runs')
}

const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

/**
 * The absolute path behind what the user gave: a plain path, a `file://` URL (a dragged file)
 * or a path starting with `~`.
 */
export function normalizeDocumentPath(input: string, home: string = homedir()): string {
  let value = input.trim()
  if (!value) throw new DocumentFileError('Choose a document first.')

  if (/^file:/i.test(value)) {
    try {
      value = fileURLToPath(value)
    } catch {
      throw new DocumentFileError(`This is not a valid file URL: ${input}`)
    }
  } else if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = join(home, value.slice(1))
  }

  if (!isAbsolute(value)) {
    throw new DocumentFileError(`Give the full path of the document (got "${input.trim()}").`)
  }
  return resolve(value)
}

/** The document exists, is a regular file and is small enough to read. */
export async function assertDocumentFile(path: string): Promise<void> {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new DocumentFileError(`The document was not found: ${path}`)
    }
    throw new DocumentFileError(
      code === 'EACCES' || code === 'EPERM'
        ? `The document cannot be read (permission denied): ${path}`
        : `The document cannot be read: ${path}`
    )
  }
  if (info.isDirectory()) {
    throw new DocumentFileError(`This is a folder, not a document: ${path}`)
  }
  if (!info.isFile()) {
    throw new DocumentFileError(`This is not a regular file: ${path}`)
  }
  if (info.size > DOCUMENT_MAX_BYTES) {
    throw new DocumentFileError(
      `The document is too large: ${megabytes(info.size)} MB (the limit is ${megabytes(DOCUMENT_MAX_BYTES)} MB).`
    )
  }
}

/**
 * The document as text. Binary formats (PDF, Word) are refused rather than decoded. The
 * encoding is what the file declares (a BOM, `<meta charset>`, `<?xml encoding>`), else UTF-8
 * when the bytes are valid UTF-8, else windows-1252: what Word's "Save as Web Page" writes.
 */
export async function readDocumentSource(path: string): Promise<string> {
  await assertDocumentFile(path)
  const buffer = await readFile(path)
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new DocumentFileError(
      'This file is not text. HTML, Markdown and plain-text documents are supported.'
    )
  }
  const { text, encoding } = decodeDocument(buffer)
  // Text read with the wrong table is replacement characters: refused, not turned into tickets.
  const sample = text.slice(0, DECODE_SAMPLE_CHARS)
  const replaced = (sample.match(/�/g) ?? []).length
  if (replaced > 0 && replaced >= sample.replace(/\s/g, '').length * UNDECODABLE_SHARE) {
    throw new DocumentFileError(
      `The text of this file could not be decoded as ${encoding}. Save it as UTF-8 and try again.`
    )
  }
  return text
}

/** Bytes checked for an encoding declaration (`<head>` comes first in an HTML file). */
const CHARSET_SNIFF_BYTES = 8192
const DECODE_SAMPLE_CHARS = 20_000
/** Share of the sampled non-blank characters that are U+FFFD before the file is refused. */
const UNDECODABLE_SHARE = 0.2
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** The encoding label the document declares, if any. */
function declaredCharset(buffer: Buffer): string | null {
  const head = buffer.subarray(0, CHARSET_SNIFF_BYTES).toString('latin1')
  const patterns = [
    /<meta[^>]*charset\s*=\s*["']?\s*([\w.:-]+)/i,
    /<\?xml[^>]*encoding\s*=\s*["']\s*([\w.:-]+)/i
  ]
  for (const pattern of patterns) {
    const label = pattern.exec(head)?.[1]
    if (label) return label
  }
  return null
}

function decodeDocument(buffer: Buffer): { text: string; encoding: string } {
  if (buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    return { text: buffer.subarray(UTF8_BOM.length).toString('utf8'), encoding: 'UTF-8' }
  }
  const label = declaredCharset(buffer)
  // A UTF-8 declaration is checked against the bytes like no declaration at all: a legacy
  // file saved under a copied template is the usual case.
  if (label && !/^utf-?8$/i.test(label)) {
    try {
      return { text: new TextDecoder(label).decode(buffer), encoding: label }
    } catch {
      // A label this runtime does not know: decided by the bytes below.
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buffer), encoding: 'windows-1252' }
  }
}

const IMAGE_EXTENSION_BY_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['image/bmp', 'bmp'],
  ['image/avif', 'avif']
])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])

async function saveEmbeddedFigure(
  figure: DocumentFigureData,
  figuresDir: string
): Promise<string | null> {
  const extension = IMAGE_EXTENSION_BY_MIME.get((figure.mime ?? '').toLowerCase())
  if (!extension || !figure.base64) return null
  // Four base64 characters hold three bytes: skip oversized payloads before decoding them.
  if (figure.base64.length * 0.75 > FIGURE_MAX_BYTES) return null
  const bytes = Buffer.from(figure.base64, 'base64')
  if (bytes.length === 0 || bytes.length > FIGURE_MAX_BYTES) return null
  const target = join(figuresDir, `${figure.id}.${extension}`)
  await writeFile(target, bytes)
  return target
}

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Local paths a relative `src` may mean: as written, without its query or fragment, and
 * URL-decoded. A document only brings along images that live next to it: an absolute path or
 * a `file:` URL in a document received from elsewhere would read any image on this machine.
 */
function localCandidates(src: string, sourceDir: string): string[] {
  const value = src.trim()
  // http(s), data, blob, cid, file…: not a path next to the document. (One letter is a
  // Windows drive: an absolute path, dropped below.)
  if (/^[a-z][a-z0-9+.-]+:/i.test(value) || value.startsWith('//')) return []
  const bare = value.replace(/[?#].*$/, '')
  const candidates = [value, bare, safeDecode(bare)].filter(
    (candidate) => candidate !== '' && !isAbsolute(candidate)
  )
  return [...new Set(candidates)].map((candidate) => resolve(sourceDir, candidate))
}

/** `path` is `root` or below it, symbolic links followed. */
async function isInside(path: string, root: string): Promise<boolean> {
  const inside = relative(await realpath(root), await realpath(path))
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
}

async function copyReferencedFigure(
  figure: DocumentFigureData,
  figuresDir: string,
  sourceDir: string
): Promise<string | null> {
  for (const candidate of localCandidates(figure.src ?? '', sourceDir)) {
    const extension = extname(candidate).slice(1).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(extension)) continue
    try {
      const info = await stat(candidate)
      if (!info.isFile() || info.size === 0 || info.size > FIGURE_MAX_BYTES) continue
      // `..` segments (and links) may lead out of the document's directory.
      if (!(await isInside(candidate, sourceDir))) continue
      const target = join(figuresDir, `${figure.id}.${extension}`)
      await copyFile(candidate, target)
      return target
    } catch {
      // Not there (or unreadable): the next spelling may be.
    }
  }
  return null
}

export interface RunFiles {
  /** `<runDir>/document.md`: the block-numbered text. */
  documentPath: string
  /** figure id → absolute path of the saved image; figures that could not be saved are absent. */
  figurePaths: Record<string, string>
}

/**
 * Write the run directory: `document.md`, `blocks.json` (the pre-processed document without
 * image payloads) and `figures/fig-NN.<ext>`.
 */
export async function writeRunFiles(input: {
  runDir: string
  sourcePath: string
  doc: PreprocessedDocument
}): Promise<RunFiles> {
  const { runDir, doc } = input
  const figuresDir = join(runDir, 'figures')
  // A retried extraction must not leave figures of the previous attempt behind.
  await rm(figuresDir, { recursive: true, force: true })
  await mkdir(figuresDir, { recursive: true })

  const documentPath = join(runDir, 'document.md')
  await writeFile(documentPath, `${renderBlocks(doc.blocks, { withIds: true })}\n`, 'utf8')
  await writeFile(
    join(runDir, 'blocks.json'),
    JSON.stringify({
      ...doc,
      figures: doc.figures.map((figure) => ({ ...figure, base64: null }))
    }),
    'utf8'
  )

  const figurePaths: Record<string, string> = {}
  const sourceDir = dirname(input.sourcePath)
  for (const figure of doc.figures) {
    // The id becomes a file name.
    if (!/^fig-\d+$/.test(figure.id)) continue
    const saved = figure.base64
      ? await saveEmbeddedFigure(figure, figuresDir)
      : await copyReferencedFigure(figure, figuresDir, sourceDir)
    if (saved) figurePaths[figure.id] = saved
  }
  return { documentPath, figurePaths }
}

/** Delete a run directory. Refuses anything that is not a direct child of `root`. */
export async function removeRunDir(runDir: string, root: string): Promise<void> {
  const inside = relative(resolve(root), resolve(runDir))
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside.includes(sep)) {
    throw new Error(`Refusing to delete ${runDir}: it is not a run directory inside ${root}`)
  }
  await rm(resolve(runDir), { recursive: true, force: true })
}
