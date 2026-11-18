import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { getImageMimeType } from '@shared/types/file-utils'
import { fileApi } from '@/api/file-api'
import {
  buildHtmlPreviewDocument,
  resolveLocalAssetPath,
  type HtmlPreviewAssetReaders
} from '@/lib/html-preview'
import { useFileViewerStore } from '@/stores/useFileViewerStore'

interface HtmlPreviewProps {
  html: string
  filePath: string
  fileName: string
}

const assetReaders: HtmlPreviewAssetReaders = {
  readText: async (path) => {
    const envelope = await fileApi.readFile(path)
    if (!envelope.success) return null
    const result = envelope.value
    return result.success && result.content !== undefined ? result.content : null
  },
  readImageDataUri: async (path) => {
    const envelope = await fileApi.readImageAsBase64(path)
    if (!envelope.success) return null
    const mimeType = envelope.value.mimeType ?? getImageMimeType(path)
    return mimeType ? `data:${mimeType};base64,${envelope.value.data}` : null
  }
}

const EXTERNAL_LINK = /^(https?:|mailto:)/i

// The frame's nodes belong to another window, so `instanceof` of this window's classes is
// false for all of them: read what is needed off the node instead.
interface FrameNode {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => Element | null
}

function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as FrameNode | null
  const tag = node?.tagName?.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!node?.isContentEditable
}

/**
 * An HTML file rendered as a page, styles and images included, in a frame that runs no script.
 *
 * The frame is sandboxed without `allow-scripts`: a file of a repository is not trusted to run
 * code inside the app, and the app's own content policy would refuse its scripts anyway.
 * `allow-same-origin` is what lets this component reach the frame's document, to follow its
 * links and to hand its key presses to the app.
 */
export function HtmlPreview({ html, filePath, fileName }: HtmlPreviewProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const wiredDocumentRef = useRef<Document | null>(null)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    buildHtmlPreviewDocument(html, filePath, assetReaders)
      // The file as it is, without what it takes from disk, rather than no preview at all.
      .catch(() => html)
      .then((built) => {
        if (!cancelled) setSrcDoc(built)
      })
    return () => {
      cancelled = true
    }
  }, [html, filePath])

  // A drag that starts in the app (a panel's resize handle, a tab being moved) loses its mouse
  // events as soon as the pointer is over a frame: they go to the frame's document instead.
  // While a button pressed in the app is held, the frame lets the pointer through.
  useEffect(() => {
    const setPassThrough = (passThrough: boolean): void => {
      if (iframeRef.current) iframeRef.current.style.pointerEvents = passThrough ? 'none' : ''
    }
    const begin = (): void => setPassThrough(true)
    const end = (): void => setPassThrough(false)
    document.addEventListener('mousedown', begin, true)
    window.addEventListener('mouseup', end, true)
    window.addEventListener('dragend', end, true)
    window.addEventListener('blur', end)
    return () => {
      document.removeEventListener('mousedown', begin, true)
      window.removeEventListener('mouseup', end, true)
      window.removeEventListener('dragend', end, true)
      window.removeEventListener('blur', end)
    }
  }, [])

  const handleLoad = useCallback(() => {
    const iframe = iframeRef.current
    const doc = iframe?.contentDocument
    // Once per document: a second load event for the same one must not double its listeners.
    if (!iframe || !doc || wiredDocumentRef.current === doc) return
    wiredDocumentRef.current = doc

    // Links. A `#section` link is left to the frame (it moves within the document). Anything
    // else must not navigate the frame itself: a web address opens in the browser, as every
    // link in the app does, and a link to another file opens that file here.
    doc.addEventListener('click', (event) => {
      const anchor = (event.target as FrameNode | null)?.closest?.('a[href], area[href]')
      const href = anchor?.getAttribute('href')?.trim()
      if (!href || href.startsWith('#')) return
      event.preventDefault()
      if (EXTERNAL_LINK.test(href)) {
        window.open(href, '_blank', 'noopener,noreferrer')
        return
      }
      const linkedPath = resolveLocalAssetPath(filePath, href)
      const tab = useFileViewerStore.getState().openFiles.get(filePath)
      if (linkedPath && tab?.type === 'file') {
        const linkedName = linkedPath.substring(linkedPath.lastIndexOf('/') + 1)
        useFileViewerStore.getState().openFile(linkedPath, linkedName, tab.worktreeId)
      }
    })

    // Keys. With the focus inside the frame a key press never reaches the app's document, so
    // its shortcuts (close the tab, switch tabs, the command palette…) would stop working
    // after a click in the page. Hand each one over, as if pressed on the frame.
    const forwardKey = (event: KeyboardEvent): void => {
      // Typing in a field of the page is not a shortcut, unless a command key is held.
      if (isTypingTarget(event.target) && !event.metaKey && !event.ctrlKey) return
      const forwarded = new KeyboardEvent(event.type, {
        key: event.key,
        code: event.code,
        location: event.location,
        repeat: event.repeat,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        bubbles: true,
        cancelable: true
      })
      if (!iframe.dispatchEvent(forwarded)) event.preventDefault()
    }
    doc.addEventListener('keydown', forwardKey)
    doc.addEventListener('keyup', forwardKey)
  }, [filePath])

  if (srcDoc === null) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        data-testid="file-viewer-html-loading"
      >
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      title={fileName}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      // `Canvas` is the page background of a browser in the app's colour scheme: white in a
      // light theme, near-black in a dark one. A page without a background of its own shows it.
      className="flex-1 min-h-0 w-full border-0 bg-[Canvas]"
      onLoad={handleLoad}
      data-testid="file-viewer-html-preview"
    />
  )
}
