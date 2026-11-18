import { describe, expect, it, vi } from 'vitest'
import {
  buildHtmlPreviewDocument,
  resolveLocalAssetPath,
  type HtmlPreviewAssetReaders
} from './html-preview'

const PNG = 'data:image/png;base64,AAAA'

function readersOf(
  texts: Record<string, string> = {},
  images: Record<string, string> = {}
): HtmlPreviewAssetReaders & {
  readText: ReturnType<typeof vi.fn>
  readImageDataUri: ReturnType<typeof vi.fn>
} {
  return {
    readText: vi.fn(async (path: string) => texts[path] ?? null),
    readImageDataUri: vi.fn(async (path: string) => images[path] ?? null)
  }
}

async function build(
  html: string,
  readers: HtmlPreviewAssetReaders = readersOf(),
  filePath = '/repo/docs/page.html'
): Promise<Document> {
  const built = await buildHtmlPreviewDocument(html, filePath, readers)
  return new DOMParser().parseFromString(built, 'text/html')
}

describe('resolveLocalAssetPath', () => {
  it('resolves a reference against the folder of the file', () => {
    expect(resolveLocalAssetPath('/repo/docs/page.html', 'style.css')).toBe('/repo/docs/style.css')
    expect(resolveLocalAssetPath('/repo/docs/page.html', './a/b.png')).toBe('/repo/docs/a/b.png')
    expect(resolveLocalAssetPath('/repo/docs/page.html', '../shared/x.css')).toBe(
      '/repo/shared/x.css'
    )
  })

  it('drops the query and the fragment, and decodes the path', () => {
    expect(resolveLocalAssetPath('/repo/page.html', 'a.css?v=3#top')).toBe('/repo/a.css')
    expect(resolveLocalAssetPath('/repo/page.html', 'my%20shots/one.png')).toBe(
      '/repo/my shots/one.png'
    )
    expect(resolveLocalAssetPath('/repo/page.html', '100%.png')).toBe('/repo/100%.png')
  })

  it('never climbs above the root', () => {
    expect(resolveLocalAssetPath('/a/page.html', '../../../x.png')).toBe('/x.png')
  })

  it('keeps the separator of a Windows path', () => {
    expect(resolveLocalAssetPath('C:\\repo\\docs\\page.html', '../img/a.png')).toBe(
      'C:\\repo\\img\\a.png'
    )
  })

  it('answers null for what is not a relative file reference', () => {
    for (const reference of [
      '',
      '#section',
      'https://example.com/a.css',
      '//cdn.example.com/a.css',
      '/assets/a.css',
      'data:image/png;base64,AAAA',
      'mailto:someone@example.com',
      'javascript:void(0)'
    ]) {
      expect(resolveLocalAssetPath('/repo/page.html', reference)).toBeNull()
    }
  })
})

describe('buildHtmlPreviewDocument', () => {
  it('keeps the markup and the inline styles of the file', async () => {
    const built = await buildHtmlPreviewDocument(
      '<!DOCTYPE html><html lang="en"><head><title>T</title><style>h1 { color: red; }</style></head>' +
        '<body><h1 id="top" style="margin: 0">Hello</h1></body></html>',
      '/repo/page.html',
      readersOf()
    )
    expect(built.startsWith('<!DOCTYPE html>')).toBe(true)
    const doc = new DOMParser().parseFromString(built, 'text/html')
    expect(doc.documentElement.getAttribute('lang')).toBe('en')
    expect(doc.querySelector('style')?.textContent).toBe('h1 { color: red; }')
    expect(doc.querySelector('h1')?.getAttribute('style')).toBe('margin: 0')
    expect(doc.querySelector('h1')?.textContent).toBe('Hello')
  })

  it('writes no doctype for a file that has none', async () => {
    const built = await buildHtmlPreviewDocument('<p>bare</p>', '/repo/page.html', readersOf())
    expect(built.startsWith('<html>')).toBe(true)
  })

  it('points the base at the frame itself, in place of any base of the file', async () => {
    const doc = await build('<head><base href="https://example.com/"><title>T</title></head>')
    const bases = doc.querySelectorAll('base')
    expect(bases).toHaveLength(1)
    expect(bases[0].getAttribute('href')).toBe('about:srcdoc')
    expect(doc.head.firstElementChild).toBe(bases[0])
  })

  it('removes a refresh and a content policy, and keeps the other meta tags', async () => {
    const doc = await build(
      '<head><meta charset="utf-8"><meta http-equiv="Refresh" content="0; url=https://example.com">' +
        '<meta http-equiv="Content-Security-Policy" content="img-src \'self\'">' +
        '<meta name="viewport" content="width=device-width"></head>'
    )
    expect(doc.querySelectorAll('meta[http-equiv]')).toHaveLength(0)
    expect(doc.querySelector('meta[charset]')).not.toBeNull()
    expect(doc.querySelector('meta[name=viewport]')).not.toBeNull()
  })

  it('inlines a local stylesheet, with its media', async () => {
    const readers = readersOf({ '/repo/docs/css/site.css': 'body { color: blue; }' })
    const doc = await build(
      '<head><link rel="stylesheet" media="print" href="css/site.css?v=2"></head>',
      readers
    )
    expect(doc.querySelector('link')).toBeNull()
    const style = doc.querySelector('style')
    expect(style?.textContent).toBe('body { color: blue; }')
    expect(style?.getAttribute('media')).toBe('print')
  })

  it('leaves a stylesheet it cannot inline where it is', async () => {
    const readers = readersOf()
    const doc = await build(
      '<head><link rel="stylesheet" href="https://cdn.example.com/a.css">' +
        '<link rel="stylesheet" href="missing.css"><link rel="stylesheet" href="../../.ssh/id_rsa">' +
        '<link rel="icon" href="favicon.png"></head>',
      readers
    )
    expect(doc.querySelectorAll('link')).toHaveLength(4)
    expect(doc.querySelector('style')).toBeNull()
    // Only a .css file is ever read as a stylesheet.
    expect(readers.readText.mock.calls.map(([path]) => path)).toEqual(['/repo/docs/missing.css'])
  })

  it('resolves the images of a stylesheet against the stylesheet, and follows its imports', async () => {
    const readers = readersOf(
      {
        '/repo/docs/css/site.css':
          '@import "base/reset.css";\n@import url(print.css) print;\n.logo { background: url(../img/logo.png) no-repeat; }',
        '/repo/docs/css/base/reset.css':
          '@import "../site.css";\n* { margin: 0; } .dot { background: url("dot.png"); }'
      },
      {
        '/repo/docs/img/logo.png': PNG,
        '/repo/docs/css/base/dot.png': 'data:image/png;base64,DOT0'
      }
    )
    const doc = await build('<head><link rel="stylesheet" href="css/site.css"></head>', readers)
    const css = doc.querySelector('style')?.textContent ?? ''
    expect(css).toContain(`.logo { background: url("${PNG}") no-repeat; }`)
    expect(css).toContain('.dot { background: url("data:image/png;base64,DOT0"); }')
    expect(css).toContain('* { margin: 0; }')
    // The cycle back to site.css ends there, and a conditional import is not replaced.
    expect(css).toContain('@import "../site.css";')
    expect(css).toContain('@import url(print.css) print;')
    expect(readers.readText).toHaveBeenCalledTimes(2)
  })

  it('inlines the local images of img, style elements and style attributes', async () => {
    const readers = readersOf(
      {},
      {
        '/repo/docs/shots/one.png': PNG,
        '/repo/docs/bg.jpg': 'data:image/jpeg;base64,BBBB'
      }
    )
    const doc = await build(
      "<head><style>body { background: url('bg.jpg'); }</style></head><body>" +
        '<img id="a" src="shots/one.png" alt="one"><img id="b" src="shots/one.png">' +
        '<div id="c" style="background-image: url(&quot;bg.jpg&quot;)"></div></body>',
      readers
    )
    expect(doc.getElementById('a')?.getAttribute('src')).toBe(PNG)
    expect(doc.getElementById('a')?.getAttribute('alt')).toBe('one')
    expect(doc.getElementById('b')?.getAttribute('src')).toBe(PNG)
    expect(doc.querySelector('style')?.textContent).toBe(
      'body { background: url("data:image/jpeg;base64,BBBB"); }'
    )
    expect(doc.getElementById('c')?.getAttribute('style')).toBe(
      "background-image: url('data:image/jpeg;base64,BBBB')"
    )
    // One read per file, however often it is used.
    expect(readers.readImageDataUri).toHaveBeenCalledTimes(2)
  })

  it('leaves remote and unreadable images alone, and gives a protocol-relative one a protocol', async () => {
    const readers = readersOf()
    const doc = await build(
      '<img id="a" src="https://example.com/a.png"><img id="b" src="gone.png">' +
        '<img id="c" src="//cdn.example.com/c.png"><img id="d" src="notes.txt"><img id="e" src="data:image/gif;base64,R0lG">',
      readers
    )
    expect(doc.getElementById('a')?.getAttribute('src')).toBe('https://example.com/a.png')
    expect(doc.getElementById('b')?.getAttribute('src')).toBe('gone.png')
    expect(doc.getElementById('c')?.getAttribute('src')).toBe('https://cdn.example.com/c.png')
    expect(doc.getElementById('d')?.getAttribute('src')).toBe('notes.txt')
    expect(doc.getElementById('e')?.getAttribute('src')).toBe('data:image/gif;base64,R0lG')
    // Only an image file is ever read as an image.
    expect(readers.readImageDataUri.mock.calls.map(([path]) => path)).toEqual([
      '/repo/docs/gone.png'
    ])
  })

  it('reduces a responsive image to one source', async () => {
    const readers = readersOf({}, { '/repo/docs/small.png': PNG })
    const doc = await build(
      '<picture><source srcset="big.webp" type="image/webp"><img id="a" src="small.png" srcset="big.png 2x" sizes="100vw"></picture>' +
        '<img id="b" srcset="small.png 1x, big.png 2x">',
      readers
    )
    expect(doc.querySelector('source')).toBeNull()
    for (const id of ['a', 'b']) {
      const img = doc.getElementById(id)
      expect(img?.getAttribute('src')).toBe(PNG)
      expect(img?.hasAttribute('srcset')).toBe(false)
      expect(img?.hasAttribute('sizes')).toBe(false)
    }
  })

  it('keeps an inlined stylesheet inside its style element', async () => {
    const readers = readersOf({
      '/repo/docs/a.css': 'a::after { content: "</style><p id=escaped>"; }'
    })
    const doc = await build(
      '<head><link rel="stylesheet" href="a.css"></head><body></body>',
      readers
    )
    expect(doc.getElementById('escaped')).toBeNull()
    expect(doc.querySelectorAll('style')).toHaveLength(1)
  })

  it('builds the document when a reader fails', async () => {
    const readers: HtmlPreviewAssetReaders = {
      readText: async () => {
        throw new Error('offline')
      },
      readImageDataUri: async () => {
        throw new Error('offline')
      }
    }
    const doc = await build(
      '<head><link rel="stylesheet" href="a.css"></head><body><img src="a.png"><p>text</p></body>',
      readers
    )
    expect(doc.querySelector('p')?.textContent).toBe('text')
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('a.png')
  })
})
