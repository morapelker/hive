// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { preprocessDocument } from '@shared/document-flow/preprocess'
import {
  DOCUMENT_MAX_BYTES,
  DocumentFileError,
  FIGURE_MAX_BYTES,
  assertDocumentFile,
  documentRunsRoot,
  normalizeDocumentPath,
  readDocumentSource,
  removeRunDir,
  writeRunFiles
} from './document-files'

// A 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'docflow-files-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('normalizeDocumentPath', () => {
  it('keeps an absolute path and resolves its dot segments', () => {
    expect(normalizeDocumentPath('  /tmp/specs/../spec.html  ')).toBe('/tmp/spec.html')
  })

  it('decodes a file:// URL', () => {
    const path = join(dir, 'My spec · round 2.html')
    expect(normalizeDocumentPath(pathToFileURL(path).href)).toBe(path)
    expect(normalizeDocumentPath('file:///tmp/My%20spec.html')).toBe('/tmp/My spec.html')
  })

  it('expands a leading ~ to the home directory', () => {
    expect(normalizeDocumentPath('~/Downloads/spec.md', '/Users/someone')).toBe(
      '/Users/someone/Downloads/spec.md'
    )
  })

  it.each([
    ['', 'Choose a document first.'],
    ['   ', 'Choose a document first.'],
    ['docs/spec.md', 'Give the full path of the document (got "docs/spec.md").'],
    ['file://remote-host/share/spec.md', 'This is not a valid file URL']
  ])('refuses %j', (input, message) => {
    expect(() => normalizeDocumentPath(input)).toThrow(DocumentFileError)
    expect(() => normalizeDocumentPath(input)).toThrow(message)
  })

  it('places run directories next to the attachments directory', () => {
    expect(documentRunsRoot('/Users/someone')).toBe('/Users/someone/.hive/document-runs')
  })
})

describe('assertDocumentFile', () => {
  it('accepts a regular file', async () => {
    const path = join(dir, 'spec.md')
    writeFileSync(path, '# Spec\n')
    await expect(assertDocumentFile(path)).resolves.toBeUndefined()
  })

  it('says when the document is missing', async () => {
    const path = join(dir, 'missing.md')
    await expect(assertDocumentFile(path)).rejects.toThrow(`The document was not found: ${path}`)
    // A path that runs through a file is "not found" too, not an internal error.
    writeFileSync(join(dir, 'file'), 'x')
    await expect(assertDocumentFile(join(dir, 'file', 'spec.md'))).rejects.toThrow(
      'The document was not found'
    )
  })

  it('says when it is a folder', async () => {
    await expect(assertDocumentFile(dir)).rejects.toThrow(
      `This is a folder, not a document: ${dir}`
    )
  })

  it('refuses a document above the size limit, naming both sizes', async () => {
    const path = join(dir, 'huge.html')
    writeFileSync(path, '')
    // Sparse: the size is what is checked, nothing is written.
    truncateSync(path, DOCUMENT_MAX_BYTES + 1024 * 1024)
    await expect(assertDocumentFile(path)).rejects.toThrow(
      'The document is too large: 81.0 MB (the limit is 80.0 MB).'
    )
  })
})

describe('readDocumentSource', () => {
  it('reads the document as UTF-8', async () => {
    const path = join(dir, 'spec.md')
    writeFileSync(path, '# Spécification · 规格\n')
    await expect(readDocumentSource(path)).resolves.toBe('# Spécification · 规格\n')
  })

  it('refuses a binary file instead of decoding it', async () => {
    const path = join(dir, 'spec.pdf')
    writeFileSync(path, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]))
    await expect(readDocumentSource(path)).rejects.toThrow('This file is not text.')
  })

  it('decodes the charset the document declares', async () => {
    // Word's "Save as Web Page": curly quotes, an en dash and a bullet as cp1252 bytes.
    const cp1252 = Buffer.concat([
      Buffer.from(
        '<html><head><meta http-equiv=Content-Type content="text/html; charset=windows-1252"></head><body><p>don',
        'latin1'
      ),
      Buffer.from([0x92]),
      Buffer.from('t 5', 'latin1'),
      Buffer.from([0x96]),
      Buffer.from('10 items ', 'latin1'),
      Buffer.from([0x95, 0x20, 0x93]),
      Buffer.from('Save', 'latin1'),
      Buffer.from([0x94]),
      Buffer.from('</p></body></html>', 'latin1')
    ])
    writeFileSync(join(dir, 'word.htm'), cp1252)
    await expect(readDocumentSource(join(dir, 'word.htm'))).resolves.toContain(
      'don’t 5–10 items • “Save”'
    )

    // A Hebrew export: every letter is one byte of windows-1255.
    const hebrew = Buffer.concat([
      Buffer.from('<html><head><meta charset=windows-1255></head><body><p>', 'latin1'),
      Buffer.from([0xf9, 0xec, 0xe5, 0xed]),
      Buffer.from('</p></body></html>', 'latin1')
    ])
    writeFileSync(join(dir, 'hebrew.htm'), hebrew)
    await expect(readDocumentSource(join(dir, 'hebrew.htm'))).resolves.toContain('שלום')

    // An XML declaration, and a UTF-8 BOM, which is dropped.
    writeFileSync(
      join(dir, 'xml.xhtml'),
      Buffer.concat([
        Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><p>caf', 'latin1'),
        Buffer.from([0xe9]),
        Buffer.from('</p>', 'latin1')
      ])
    )
    await expect(readDocumentSource(join(dir, 'xml.xhtml'))).resolves.toContain('café')
    writeFileSync(
      join(dir, 'bom.md'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Spec')])
    )
    await expect(readDocumentSource(join(dir, 'bom.md'))).resolves.toBe('# Spec')
  })

  it('reads undeclared text as UTF-8 when it is, else as windows-1252', async () => {
    writeFileSync(join(dir, 'utf8.md'), 'don’t 5–10 • “Save”')
    await expect(readDocumentSource(join(dir, 'utf8.md'))).resolves.toBe('don’t 5–10 • “Save”')

    const cp1252 = Buffer.concat([
      Buffer.from('# Spec\n\ndon', 'latin1'),
      Buffer.from([0x92]),
      Buffer.from('t 5', 'latin1'),
      Buffer.from([0x96]),
      Buffer.from('10\n', 'latin1')
    ])
    writeFileSync(join(dir, 'legacy.md'), cp1252)
    await expect(readDocumentSource(join(dir, 'legacy.md'))).resolves.toBe('# Spec\n\ndon’t 5–10\n')

    // A UTF-8 declaration on a legacy file is a copied template, not a fact.
    writeFileSync(
      join(dir, 'mislabeled.html'),
      Buffer.concat([
        Buffer.from('<meta charset="utf-8"><p>don', 'latin1'),
        Buffer.from([0x92]),
        Buffer.from('t</p>', 'latin1')
      ])
    )
    await expect(readDocumentSource(join(dir, 'mislabeled.html'))).resolves.toContain('don’t')
  })

  it('refuses text whose declared encoding does not fit its bytes', async () => {
    // Declared as UTF-16, but the bytes make no characters: replacement characters.
    const path = join(dir, 'wrong.html')
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from('<meta charset="utf-16le" >', 'latin1'),
        Buffer.from(Array.from({ length: 80 }, () => [0x3d, 0xd8]).flat())
      ])
    )
    await expect(readDocumentSource(path)).rejects.toThrow(
      'The text of this file could not be decoded as utf-16le. Save it as UTF-8 and try again.'
    )
  })

  it('reports a document that disappeared since it was picked', async () => {
    await expect(readDocumentSource(join(dir, 'gone.md'))).rejects.toThrow(DocumentFileError)
  })
})

describe('writeRunFiles', () => {
  it('writes the numbered text, the blocks without image payloads, and the figures', async () => {
    const sourceDir = join(dir, 'source')
    mkdirSync(join(sourceDir, 'img'), { recursive: true })
    writeFileSync(join(sourceDir, 'img', 'local shot.png'), Buffer.from(PNG_BASE64, 'base64'))
    const sourcePath = join(sourceDir, 'spec.html')
    const html = [
      '<html><head><title>Spec</title></head><body>',
      '<h1>Spec</h1>',
      '<h2>A1 · First task</h2>',
      '<p>Do the first thing.</p>',
      `<img alt="Embedded mock-up" src="data:image/png;base64,${PNG_BASE64}">`,
      '<img alt="Local mock-up" src="img/local%20shot.png?v=3">',
      '<img alt="Remote mock-up" src="https://example.test/remote.png">',
      '<img alt="Missing mock-up" src="img/missing.png">',
      '<img alt="Not an image" src="spec.html">',
      '</body></html>'
    ].join('\n')
    writeFileSync(sourcePath, html)
    const doc = preprocessDocument({ fileName: 'spec.html', content: html })
    expect(doc.figures.map((figure) => figure.id)).toEqual([
      'fig-01',
      'fig-02',
      'fig-03',
      'fig-04',
      'fig-05'
    ])

    const runDir = join(dir, 'runs', 'run-1')
    const files = await writeRunFiles({ runDir, sourcePath, doc })

    expect(files.documentPath).toBe(join(runDir, 'document.md'))
    const text = readFileSync(files.documentPath, 'utf8')
    expect(text).toBe(`${doc.text}\n`)
    expect(text).toMatch(/^\[b1\] # Spec$/m)
    expect(text).not.toContain('base64')

    const stored = JSON.parse(readFileSync(join(runDir, 'blocks.json'), 'utf8'))
    expect(stored.title).toBe('Spec')
    expect(stored.blocks).toEqual(doc.blocks)
    expect(stored.figures).toHaveLength(5)
    expect(stored.figures.every((figure: { base64: unknown }) => figure.base64 === null)).toBe(true)
    expect(readFileSync(join(runDir, 'blocks.json'), 'utf8')).not.toContain(PNG_BASE64)

    // The embedded image is decoded; the local one is found despite its encoding and query.
    // The remote URL, the missing file and the non-image are skipped.
    expect(files.figurePaths).toEqual({
      'fig-01': join(runDir, 'figures', 'fig-01.png'),
      'fig-02': join(runDir, 'figures', 'fig-02.png')
    })
    expect(readdirSync(join(runDir, 'figures')).sort()).toEqual(['fig-01.png', 'fig-02.png'])
    expect(readFileSync(files.figurePaths['fig-01']).toString('base64')).toBe(PNG_BASE64)
    expect(readFileSync(files.figurePaths['fig-02']).toString('base64')).toBe(PNG_BASE64)
  })

  it('only brings along images from the document’s own directory tree', async () => {
    const sourceDir = join(dir, 'specs', 'round-2')
    mkdirSync(join(sourceDir, 'img'), { recursive: true })
    mkdirSync(join(dir, 'private'))
    const png = Buffer.from(PNG_BASE64, 'base64')
    writeFileSync(join(sourceDir, 'img', 'inside.png'), png)
    writeFileSync(join(dir, 'private', 'passport.png'), png)
    // A link inside the tree that leads out of it.
    symlinkSync(join(dir, 'private'), join(sourceDir, 'img', 'linked'))
    const sourcePath = join(sourceDir, 'spec.html')
    const html = [
      '<p>Spec</p>',
      '<img alt="Inside" src="img/inside.png">',
      '<img alt="Nested inside" src="./img/../img/inside.png">',
      `<img alt="Absolute" src="${join(dir, 'private', 'passport.png')}">`,
      `<img alt="File URL" src="${pathToFileURL(join(dir, 'private', 'passport.png')).href}">`,
      '<img alt="Traversal" src="../../private/passport.png">',
      '<img alt="Through a link" src="img/linked/passport.png">'
    ].join('\n')
    writeFileSync(sourcePath, html)
    const doc = preprocessDocument({ fileName: 'spec.html', content: html })
    expect(doc.figures).toHaveLength(6)

    const runDir = join(dir, 'runs', 'run-contained')
    const files = await writeRunFiles({ runDir, sourcePath, doc })

    expect(Object.keys(files.figurePaths)).toEqual(['fig-01', 'fig-02'])
    expect(readdirSync(join(runDir, 'figures')).sort()).toEqual(['fig-01.png', 'fig-02.png'])
  })

  it('names figures after their MIME type and skips what it cannot save', async () => {
    const runDir = join(dir, 'run-2')
    const doc = preprocessDocument({ fileName: 'spec.md', content: '# Spec\n\nText.\n' })
    doc.figures = [
      { id: 'fig-01', alt: 'jpeg', mime: 'image/jpeg', base64: PNG_BASE64, src: null },
      { id: 'fig-02', alt: 'svg', mime: 'IMAGE/SVG+XML', base64: PNG_BASE64, src: null },
      { id: 'fig-03', alt: 'not an image', mime: 'text/html', base64: PNG_BASE64, src: null },
      { id: 'fig-04', alt: 'malformed', mime: null, base64: null, src: null },
      { id: 'fig-05', alt: 'empty', mime: 'image/png', base64: '', src: null },
      {
        id: 'fig-06',
        alt: 'oversized',
        mime: 'image/png',
        base64: 'A'.repeat(Math.ceil((FIGURE_MAX_BYTES * 4) / 3) + 8),
        src: null
      },
      { id: '../escape', alt: 'bad id', mime: 'image/png', base64: PNG_BASE64, src: null }
    ]

    const files = await writeRunFiles({ runDir, sourcePath: join(dir, 'spec.md'), doc })

    expect(Object.keys(files.figurePaths)).toEqual(['fig-01', 'fig-02'])
    expect(readdirSync(join(runDir, 'figures')).sort()).toEqual(['fig-01.jpg', 'fig-02.svg'])
    expect(readdirSync(dir)).not.toContain('escape.png')
  })

  it('replaces the figures of a previous extraction', async () => {
    const runDir = join(dir, 'run-3')
    mkdirSync(join(runDir, 'figures'), { recursive: true })
    writeFileSync(join(runDir, 'figures', 'fig-09.png'), 'stale')
    const doc = preprocessDocument({ fileName: 'spec.md', content: '# Spec\n\nText.\n' })

    await writeRunFiles({ runDir, sourcePath: join(dir, 'spec.md'), doc })

    expect(readdirSync(join(runDir, 'figures'))).toEqual([])
  })
})

describe('removeRunDir', () => {
  it('deletes a run directory inside the root', async () => {
    const root = join(dir, 'document-runs')
    const runDir = join(root, 'run-1')
    mkdirSync(join(runDir, 'figures'), { recursive: true })
    writeFileSync(join(runDir, 'document.md'), 'text')

    await removeRunDir(runDir, root)

    expect(existsSync(runDir)).toBe(false)
    expect(existsSync(root)).toBe(true)
    // Already gone is fine.
    await expect(removeRunDir(runDir, root)).resolves.toBeUndefined()
  })

  it('refuses anything that is not a direct child of the root', async () => {
    const root = join(dir, 'document-runs')
    const outside = join(dir, 'precious')
    mkdirSync(root)
    mkdirSync(join(outside, 'nested'), { recursive: true })
    mkdirSync(join(root, 'run-1', 'figures'), { recursive: true })

    for (const target of [
      root,
      outside,
      join(root, '..', 'precious'),
      join(root, 'run-1', 'figures'),
      dir
    ]) {
      await expect(removeRunDir(target, root)).rejects.toThrow('Refusing to delete')
    }
    expect(existsSync(join(outside, 'nested'))).toBe(true)
    expect(existsSync(join(root, 'run-1', 'figures'))).toBe(true)
  })
})
