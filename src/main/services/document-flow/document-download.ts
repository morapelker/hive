import { readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { DOCUMENT_MAX_BYTES, DocumentFileError, assertDocumentFile } from './document-files'

// A document given as a link. It is downloaded once, into the project directory, before the run
// is created; from there on the run reads the saved file like any picked document.
//
// A document somebody else downloaded (a file that sits in the attachment store under a random
// name) is saved the same way, under the name it has where it came from:
// saveDocumentCopy.

export const DOCUMENT_DOWNLOAD_TIMEOUT_MS = 60_000
/** Extensions the pre-processing tells formats apart by; anything else is saved as `.html`. */
const DOCUMENT_EXTENSIONS = new Set(['.html', '.htm', '.md', '.markdown', '.mdx', '.txt'])
const EXTENSION_BY_CONTENT_TYPE = new Map([
  ['text/html', '.html'],
  ['application/xhtml+xml', '.html'],
  ['text/markdown', '.md'],
  ['text/x-markdown', '.md'],
  ['text/plain', '.txt']
])
const FILE_NAME_MAX_CHARS = 80
const BINARY_SNIFF_BYTES = 8192

export type DocumentFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

/** What the user gave is an http(s) link rather than a path. */
export function isDocumentUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim())
}

const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

const tooLarge = (): DocumentFileError =>
  new DocumentFileError(
    `The document behind the link is too large (the limit is ${megabytes(DOCUMENT_MAX_BYTES)} MB).`
  )

// The name becomes a file in the project: no separators, no hidden files.
const cleanFileName = (value: string): string =>
  value
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, FILE_NAME_MAX_CHARS)

/** `spec.html` for https://host/docs/spec.html; the host name when the path names no file. */
function fileNameFor(url: URL, contentType: string): string {
  let segment = url.pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    segment = decodeURIComponent(segment)
  } catch {
    // Kept as written.
  }
  const name = cleanFileName(segment)
  const extension = extname(name).toLowerCase()
  if (DOCUMENT_EXTENSIONS.has(extension) && name.length > extension.length) return name
  const stem = name || cleanFileName(url.hostname) || 'document'
  return `${stem}${EXTENSION_BY_CONTENT_TYPE.get(contentType) ?? '.html'}`
}

async function readLimited(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > DOCUMENT_MAX_BYTES) throw tooLarge()
  if (!response.body) return Buffer.from(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > DOCUMENT_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Save under `name`, or `name-2`, `name-3`… when a file of that name is already there. */
async function writeNewFile(dir: string, name: string, bytes: Buffer): Promise<string> {
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let attempt = 1; ; attempt++) {
    const target = join(dir, attempt === 1 ? name : `${stem}-${attempt}${extension}`)
    try {
      await writeFile(target, bytes, { flag: 'wx' })
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 1000) throw error
    }
  }
}

/**
 * Download the document behind an http(s) link into `targetDir` and return the path of the
 * saved file. Nothing is written unless the whole document arrived and is text.
 */
export async function downloadDocument(input: {
  url: string
  targetDir: string
  fetch?: DocumentFetch
  timeoutMs?: number
}): Promise<string> {
  let url: URL
  try {
    url = new URL(input.url.trim())
  } catch {
    throw new DocumentFileError(`This is not a valid link: ${input.url.trim()}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DocumentFileError('Only http:// and https:// links can be downloaded.')
  }

  const fetchDocument =
    input.fetch ?? ((href, init) => fetch(href, { ...init, redirect: 'follow' }))
  let response: Response
  let bytes: Buffer
  try {
    response = await fetchDocument(url.href, {
      signal: AbortSignal.timeout(input.timeoutMs ?? DOCUMENT_DOWNLOAD_TIMEOUT_MS)
    })
    if (!response.ok) {
      throw new DocumentFileError(
        `The document could not be downloaded: the server answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`
      )
    }
    bytes = await readLimited(response)
  } catch (error) {
    if (error instanceof DocumentFileError) throw error
    const name = (error as Error | null)?.name
    throw new DocumentFileError(
      name === 'TimeoutError' || name === 'AbortError'
        ? `The document could not be downloaded: ${url.host} did not answer in time.`
        : `The document could not be downloaded from ${url.host}. Check the link and the connection.`
    )
  }

  const contentType = (response.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (bytes.length === 0) throw new DocumentFileError('The link returned an empty document.')
  if (/^(image|audio|video|font)\//.test(contentType) || contentType === 'application/pdf') {
    throw new DocumentFileError(
      `The link does not lead to a document (${contentType}). HTML, Markdown and plain-text documents are supported.`
    )
  }
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new DocumentFileError(
      'The link does not lead to text. HTML, Markdown and plain-text documents are supported.'
    )
  }

  try {
    return await writeNewFile(input.targetDir, fileNameFor(url, contentType), bytes)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new DocumentFileError(
      `The downloaded document could not be saved in ${input.targetDir}${code ? ` (${code})` : ''}.`
    )
  }
}

/**
 * Save a copy of the document at `sourcePath` into `targetDir` under `name` (a file name from
 * somewhere else, cleaned like a link's; `name-2`… when taken) and return the copy's path. The
 * name says what the document is, so it must carry one of the document extensions; the bytes
 * must be text. The file at `sourcePath` is left as it is.
 */
export async function saveDocumentCopy(input: {
  sourcePath: string
  name: string
  targetDir: string
}): Promise<string> {
  // An extension longer than the cap would be cut off with the rest of the name.
  const extension = extname(input.name.trim()).toLowerCase()
  if (!DOCUMENT_EXTENSIONS.has(extension)) {
    throw new DocumentFileError(
      `"${input.name.trim()}" is not a document. HTML, Markdown and plain-text documents are supported.`
    )
  }
  const stem =
    cleanFileName(input.name.trim().slice(0, -extension.length))
      .slice(0, FILE_NAME_MAX_CHARS - extension.length)
      .replace(/[.\s-]+$/, '') || 'document'

  await assertDocumentFile(input.sourcePath)
  let bytes: Buffer
  try {
    bytes = await readFile(input.sourcePath)
  } catch {
    throw new DocumentFileError(`The document cannot be read: ${input.sourcePath}`)
  }
  if (bytes.length === 0) throw new DocumentFileError('The document is empty.')
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new DocumentFileError(
      'This file is not text. HTML, Markdown and plain-text documents are supported.'
    )
  }

  try {
    return await writeNewFile(input.targetDir, `${stem}${extension}`, bytes)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new DocumentFileError(
      `The document could not be saved in ${input.targetDir}${code ? ` (${code})` : ''}.`
    )
  }
}
