// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { downloadDocument, isDocumentUrl, saveDocumentCopy } from './document-download'
import { DOCUMENT_MAX_BYTES, DocumentFileError } from './document-files'

const HTML = '<html><body><h1>Factory spec</h1><p>Translate the screen.</p></body></html>'

let server: Server
let origin: string
let respond: (path: string, response: ServerResponse) => void
let dir: string

beforeAll(async () => {
  server = createServer((request, response) => respond(request.url ?? '/', response))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'docflow-download-'))
  respond = (_path, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(HTML)
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const download = (path: string): Promise<string> =>
  downloadDocument({ url: `${origin}${path}`, targetDir: dir })

describe('isDocumentUrl', () => {
  it('tells http(s) links from paths and file:// URLs', () => {
    expect(isDocumentUrl(' https://specs.example.com/a ')).toBe(true)
    expect(isDocumentUrl('HTTP://localhost:3000/spec.html')).toBe(true)
    expect(isDocumentUrl('file:///docs/spec.html')).toBe(false)
    expect(isDocumentUrl('/docs/https://spec.html')).toBe(false)
    expect(isDocumentUrl('~/spec.md')).toBe(false)
  })
})

describe('downloadDocument', () => {
  it('saves the document under the name the link gives it', async () => {
    const saved = await download('/docs/Factory%20spec.html?version=2#tasks')

    expect(saved).toBe(join(dir, 'Factory spec.html'))
    expect(readFileSync(saved, 'utf8')).toBe(HTML)
  })

  it('names a link without a file name after the path or the host, by content type', async () => {
    expect(await download('/specs/round-2')).toBe(join(dir, 'round-2.html'))
    expect(await download('/')).toBe(join(dir, '127.0.0.1.html'))

    respond = (_path, response) => {
      response.writeHead(200, { 'content-type': 'text/markdown' })
      response.end('# Spec')
    }
    expect(await download('/raw/spec')).toBe(join(dir, 'spec.md'))
    // The extension in the link wins over the content type.
    expect(await download('/raw/notes.txt')).toBe(join(dir, 'notes.txt'))
  })

  it('never overwrites a file of the project and never leaves the directory', async () => {
    writeFileSync(join(dir, 'spec.html'), 'mine')

    expect(await download('/spec.html')).toBe(join(dir, 'spec-2.html'))
    expect(await download('/spec.html')).toBe(join(dir, 'spec-3.html'))
    expect(readFileSync(join(dir, 'spec.html'), 'utf8')).toBe('mine')

    expect(await download('/a/..%2F..%2F.env.html')).toBe(join(dir, 'env.html'))
  })

  it('follows redirects', async () => {
    respond = (path, response) => {
      if (path === '/short') {
        response.writeHead(302, { location: '/docs/spec.html' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(HTML)
    }

    const saved = await download('/short')

    expect(saved).toBe(join(dir, 'short.html'))
    expect(readFileSync(saved, 'utf8')).toBe(HTML)
  })

  it.each([
    [
      'a failed request',
      (response: ServerResponse) => response.writeHead(404).end('nope'),
      'the server answered 404'
    ],
    [
      'an empty answer',
      (response: ServerResponse) => response.writeHead(200).end(),
      'empty document'
    ],
    [
      'a PDF',
      (response: ServerResponse) =>
        response.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.7'),
      'does not lead to a document (application/pdf)'
    ],
    [
      'binary content',
      (response: ServerResponse) =>
        response
          .writeHead(200, { 'content-type': 'application/octet-stream' })
          .end(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])),
      'does not lead to text'
    ],
    [
      'an oversized document',
      (response: ServerResponse) =>
        response
          .writeHead(200, {
            'content-type': 'text/html',
            'content-length': String(DOCUMENT_MAX_BYTES + 1)
          })
          .end(),
      'too large'
    ]
  ])('refuses %s and writes nothing', async (_name, answer, message) => {
    respond = (_path, response) => answer(response)

    const failure = await download('/spec.html').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DocumentFileError)
    expect((failure as Error).message).toContain(message)
    expect(readdirSync(dir)).toEqual([])
  })

  it('reports an unreachable host, a slow one and a link that is not http(s)', async () => {
    const unreachable = downloadDocument({
      url: 'https://specs.example.com/spec.html',
      targetDir: dir,
      fetch: async () => {
        throw new TypeError('fetch failed')
      }
    })
    await expect(unreachable).rejects.toThrow('could not be downloaded from specs.example.com')

    respond = () => undefined // Never answers.
    await expect(
      downloadDocument({ url: `${origin}/spec.html`, targetDir: dir, timeoutMs: 50 })
    ).rejects.toThrow('did not answer in time')

    await expect(downloadDocument({ url: 'ftp://host/spec.html', targetDir: dir })).rejects.toThrow(
      'Only http:// and https:// links'
    )
    await expect(downloadDocument({ url: 'https://', targetDir: dir })).rejects.toThrow(
      'not a valid link'
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it('says so when the project directory cannot be written to', async () => {
    await expect(
      downloadDocument({ url: `${origin}/spec.html`, targetDir: join(dir, 'missing') })
    ).rejects.toThrow(/could not be saved in .*missing \(ENOENT\)/)
  })
})

describe('saveDocumentCopy', () => {
  let downloads: string

  beforeEach(() => {
    downloads = mkdtempSync(join(tmpdir(), 'docflow-copy-'))
  })

  afterEach(() => {
    rmSync(downloads, { recursive: true, force: true })
  })

  const downloadedAs = (name: string, content: string | Buffer = HTML): string => {
    const path = join(downloads, name)
    writeFileSync(path, content)
    return path
  }

  it('copies the document into the directory under its own name and leaves the source', async () => {
    const sourcePath = downloadedAs('0b8a-4f1e.html')

    const saved = await saveDocumentCopy({ sourcePath, name: 'Factory spec.html', targetDir: dir })

    expect(saved).toBe(join(dir, 'Factory spec.html'))
    expect(readFileSync(saved, 'utf8')).toBe(HTML)
    expect(readFileSync(sourcePath, 'utf8')).toBe(HTML)
  })

  it('numbers the copy when the name is taken, and never leaves the directory', async () => {
    const sourcePath = downloadedAs('0b8a-4f1e.md', '# Spec')
    writeFileSync(join(dir, 'spec.md'), 'mine')

    expect(await saveDocumentCopy({ sourcePath, name: 'spec.md', targetDir: dir })).toBe(
      join(dir, 'spec-2.md')
    )
    expect(readFileSync(join(dir, 'spec.md'), 'utf8')).toBe('mine')
    expect(
      await saveDocumentCopy({ sourcePath, name: '../../etc/.hidden/Plan.MD', targetDir: dir })
    ).toBe(join(dir, 'etc-.hidden-Plan.md'))
    expect(await saveDocumentCopy({ sourcePath, name: '..md', targetDir: dir })).toBe(
      join(dir, 'document.md')
    )
  })

  it('refuses a name that is not a document, bytes that are not text, and a missing file', async () => {
    const pdf = downloadedAs('0b8a-4f1e.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]))

    await expect(
      saveDocumentCopy({ sourcePath: pdf, name: 'spec.pdf', targetDir: dir })
    ).rejects.toThrow('"spec.pdf" is not a document')
    await expect(
      saveDocumentCopy({ sourcePath: pdf, name: 'spec.html', targetDir: dir })
    ).rejects.toThrow('This file is not text')
    await expect(
      saveDocumentCopy({
        sourcePath: downloadedAs('empty.md', ''),
        name: 'spec.md',
        targetDir: dir
      })
    ).rejects.toThrow('The document is empty')
    await expect(
      saveDocumentCopy({ sourcePath: join(downloads, 'gone.md'), name: 'spec.md', targetDir: dir })
    ).rejects.toBeInstanceOf(DocumentFileError)
    expect(readdirSync(dir)).toEqual([])
  })
})
