import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useFileViewerStore } from '@/stores/useFileViewerStore'

const fileApiMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readImageAsBase64: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('@/api/file-api', () => ({ fileApi: fileApiMocks }))
vi.mock('@/api/file-tree-api', () => ({ fileTreeApi: { onChange: () => () => {} } }))

// CodeMirror needs layout jsdom does not have; the editor's contract is all these tests use.
vi.mock('./CodeMirrorEditor', () => ({
  CodeMirrorEditor: ({
    content,
    onContentChange
  }: {
    content: string
    onContentChange?: (content: string) => void
  }) => (
    <textarea
      data-testid="file-viewer-content"
      defaultValue={content}
      onChange={(event) => onContentChange?.(event.target.value)}
    />
  )
}))

import { FileViewer } from './FileViewer'

const PAGE = '/repo/docs/page.html'
const HTML =
  '<!DOCTYPE html><html><head><style>h1 { color: red; }</style></head>' +
  '<body><h1>Report</h1><img src="shots/one.png"><a id="web" href="https://example.com/x">web</a>' +
  '<a id="local" href="other.html#part">other</a><a id="hash" href="#top">top</a></body></html>'

function readOk(content: string): { success: true; value: { success: true; content: string } } {
  return { success: true, value: { success: true, content } }
}

async function previewFrame(): Promise<HTMLIFrameElement> {
  return (await screen.findByTestId('file-viewer-html-preview')) as HTMLIFrameElement
}

beforeEach(() => {
  vi.clearAllMocks()
  useFileViewerStore.setState({
    openFiles: new Map([
      [PAGE, { type: 'file', path: PAGE, name: 'page.html', worktreeId: 'wt1' }]
    ]),
    activeFilePath: PAGE,
    activeDiff: null,
    dirtyFiles: new Set(),
    originalContents: new Map(),
    pendingClose: null,
    externallyChanged: new Set()
  })
  fileApiMocks.readFile.mockImplementation(async (path: string) =>
    path === PAGE ? readOk(HTML) : { success: true, value: { success: false, error: 'missing' } }
  )
  fileApiMocks.readImageAsBase64.mockImplementation(async (path: string) =>
    path === '/repo/docs/shots/one.png'
      ? { success: true, value: { data: 'AAAA', mimeType: 'image/png' } }
      : { success: false, errorCode: 'ENOENT', error: 'missing' }
  )
})

describe('FileViewer: an HTML file', () => {
  it('opens rendered, in a frame that runs no script', async () => {
    render(<FileViewer filePath={PAGE} />)
    const frame = await previewFrame()

    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(frame.getAttribute('title')).toBe('page.html')
    const shown = new DOMParser().parseFromString(frame.getAttribute('srcdoc') ?? '', 'text/html')
    expect(shown.querySelector('h1')?.textContent).toBe('Report')
    expect(shown.querySelector('style')?.textContent).toBe('h1 { color: red; }')
    expect(shown.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(screen.queryByTestId('file-viewer-content')).toBeNull()
  })

  it('has the source one click away, and the preview one click back', async () => {
    render(<FileViewer filePath={PAGE} />)
    await previewFrame()

    fireEvent.click(screen.getByTestId('source-toggle'))
    expect((screen.getByTestId('file-viewer-content') as HTMLTextAreaElement).value).toBe(HTML)
    expect(screen.queryByTestId('file-viewer-html-preview')).toBeNull()

    fireEvent.click(screen.getByTestId('preview-toggle'))
    await previewFrame()
    expect(screen.queryByTestId('file-viewer-content')).toBeNull()
  })

  it('previews the unsaved edits, and gives them back to the editor', async () => {
    render(<FileViewer filePath={PAGE} />)
    await previewFrame()

    fireEvent.click(screen.getByTestId('source-toggle'))
    fireEvent.change(screen.getByTestId('file-viewer-content'), {
      target: { value: '<h1>Edited</h1>' }
    })
    fireEvent.click(screen.getByTestId('preview-toggle'))
    const frame = await previewFrame()
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Edited</h1>')

    fireEvent.click(screen.getByTestId('source-toggle'))
    expect((screen.getByTestId('file-viewer-content') as HTMLTextAreaElement).value).toBe(
      '<h1>Edited</h1>'
    )
  })

  it('lets the pointer through the frame while a drag that began in the app lasts', async () => {
    render(<FileViewer filePath={PAGE} />)
    const frame = await previewFrame()
    expect(frame.style.pointerEvents).toBe('')

    fireEvent.mouseDown(screen.getByTestId('source-toggle'))
    expect(frame.style.pointerEvents).toBe('none')
    fireEvent.mouseUp(document.body)
    expect(frame.style.pointerEvents).toBe('')

    fireEvent.mouseDown(document.body)
    expect(frame.style.pointerEvents).toBe('none')
    fireEvent.dragEnd(document.body)
    expect(frame.style.pointerEvents).toBe('')
  })

  it('shows no toggle and no frame for a file without a preview', async () => {
    fileApiMocks.readFile.mockResolvedValue(readOk('const x = 1'))
    render(<FileViewer filePath="/repo/src/a.ts" />)
    await screen.findByTestId('file-viewer-content')
    expect(screen.queryByTestId('preview-toggle')).toBeNull()
    expect(screen.queryByTestId('file-viewer-html-preview')).toBeNull()
  })
})

describe('FileViewer: the links and keys of an HTML preview', () => {
  // jsdom gives a srcdoc frame an empty document and no load event: write the page into it
  // and fire the event the component wires itself on.
  async function loadedFrameDocument(): Promise<Document> {
    render(<FileViewer filePath={PAGE} />)
    const frame = await previewFrame()
    const doc = frame.contentDocument!
    doc.open()
    doc.write(frame.getAttribute('srcdoc') ?? '')
    doc.close()
    fireEvent.load(frame)
    return doc
  }

  function click(doc: Document, id: string): boolean {
    const view = doc.defaultView!
    return doc
      .getElementById(id)!
      .dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  it('opens a web link in the browser', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const doc = await loadedFrameDocument()

    expect(click(doc, 'web')).toBe(false)
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })

  it('opens a link to another file as a tab of the same worktree', async () => {
    const doc = await loadedFrameDocument()

    expect(click(doc, 'local')).toBe(false)
    const state = useFileViewerStore.getState()
    expect(state.activeFilePath).toBe('/repo/docs/other.html')
    expect(state.openFiles.get('/repo/docs/other.html')).toEqual({
      type: 'file',
      path: '/repo/docs/other.html',
      name: 'other.html',
      worktreeId: 'wt1'
    })
  })

  it('leaves a link within the page to the frame', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const doc = await loadedFrameDocument()

    expect(click(doc, 'hash')).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(useFileViewerStore.getState().activeFilePath).toBe(PAGE)
    open.mockRestore()
  })

  it("hands a key pressed in the page to the app's shortcuts", async () => {
    const doc = await loadedFrameDocument()
    const seen: KeyboardEvent[] = []
    const onKey = (event: KeyboardEvent): void => {
      seen.push(event)
      if (event.key === 'w') event.preventDefault()
    }
    document.addEventListener('keydown', onKey, true)
    try {
      const view = doc.defaultView!
      const press = (key: string, metaKey: boolean): boolean =>
        doc.body.dispatchEvent(
          new view.KeyboardEvent('keydown', { key, metaKey, bubbles: true, cancelable: true })
        )

      // The app took Cmd+W: the page must not act on it as well.
      expect(press('w', true)).toBe(false)
      expect(press('j', false)).toBe(true)
      expect(seen.map((event) => [event.key, event.metaKey])).toEqual([
        ['w', true],
        ['j', false]
      ])
      expect((seen[0].target as HTMLElement).tagName).toBe('IFRAME')
    } finally {
      document.removeEventListener('keydown', onKey, true)
    }
  })
})
