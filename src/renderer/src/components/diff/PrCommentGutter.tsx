import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/format-utils'
import type { PRReviewComment } from '@shared/types/git'
import type { editor } from 'monaco-editor'

interface CommentThread {
  rootComment: PRReviewComment
  replies: PRReviewComment[]
  line: number
}

interface ZoneEntry {
  zoneId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zone: any // IViewZone — mutable reference Monaco stores internally
  domNode: HTMLDivElement
  thread: CommentThread
}

interface PrCommentGutterProps {
  comments: PRReviewComment[]
  modifiedEditor: editor.IStandaloneCodeEditor | null
  highlightLine?: number
  onZonesReady?: () => void
}

/**
 * Renders PR review comment threads inline between diff lines using
 * Monaco view zones. Each zone pushes subsequent code lines down,
 * producing a layout identical to GitHub's "Files changed" tab.
 *
 * React content is rendered into each zone's DOM node via createPortal,
 * keeping everything inside the React tree (stores, context, etc.).
 */
export function PrCommentGutter({
  comments,
  modifiedEditor,
  highlightLine,
  onZonesReady
}: PrCommentGutterProps): React.JSX.Element | null {
  const threads = useGroupedThreads(comments)
  const [portalTargets, setPortalTargets] = useState<
    Array<{ domNode: HTMLDivElement; thread: CommentThread }>
  >([])
  const zonesRef = useRef<ZoneEntry[]>([])
  const disposedRef = useRef(false)
  const onZonesReadyRef = useRef(onZonesReady)
  onZonesReadyRef.current = onZonesReady

  // Create / recreate view zones when threads or editor change
  useEffect(() => {
    disposedRef.current = false

    if (!modifiedEditor) return

    // Remove previous zones
    if (zonesRef.current.length > 0) {
      modifiedEditor.changeViewZones((acc) => {
        for (const z of zonesRef.current) acc.removeZone(z.zoneId)
      })
      zonesRef.current = []
    }

    if (threads.length === 0) {
      setPortalTargets([])
      onZonesReadyRef.current?.()
      return
    }

    const newZones: ZoneEntry[] = []

    modifiedEditor.changeViewZones((acc) => {
      for (const thread of threads) {
        const domNode = document.createElement('div')
        // Monaco view-zone DOM nodes sit behind overlay layers by default.
        // Force pointer-events so interactive HTML elements (<details>,
        // <a>, etc.) inside the rendered bodyHTML are clickable.
        domNode.style.pointerEvents = 'auto'
        domNode.style.position = 'relative'
        domNode.style.zIndex = '1'

        // Estimate height from content length so the zone starts close to right
        const bodyLines = Math.max(1, Math.ceil(thread.rootComment.body.length / 70))
        let totalLines = 1.5 + bodyLines // header + body + padding
        for (const reply of thread.replies) {
          totalLines += 1 + Math.max(1, Math.ceil(reply.body.length / 70))
        }
        if (thread.replies.length > 0) totalLines += 0.5
        const estimatedHeight = Math.max(totalLines * 18 + 16, 48)

        const zone = {
          afterLineNumber: thread.line,
          heightInPx: estimatedHeight,
          domNode,
          suppressMouseDown: true
        }

        const zoneId = acc.addZone(zone)
        newZones.push({ zoneId, zone, domNode, thread })
      }
    })

    zonesRef.current = newZones
    setPortalTargets(newZones.map((z) => ({ domNode: z.domNode, thread: z.thread })))

    // Correct zone heights after React renders portal content.
    // We measure firstElementChild.offsetHeight (the React content's natural
    // height) instead of the domNode's contentRect because Monaco sizes the
    // domNode to match the zone — creating a circular reference that prevents
    // the ResizeObserver alone from ever detecting overestimates.
    let readyFired = false
    const observers = newZones.map((z) => {
      const measureAndAdjust = (): void => {
        if (disposedRef.current) return
        const child = z.domNode.firstElementChild as HTMLElement | null
        if (!child) return
        const actualHeight = child.offsetHeight
        if (actualHeight > 0 && Math.abs(actualHeight - z.zone.heightInPx) > 2) {
          z.zone.heightInPx = actualHeight + 4
          // Preserve scroll position so zone resizes (e.g. <details> toggle)
          // don't cause the editor to jump.
          const scrollTop = modifiedEditor.getScrollTop()
          modifiedEditor.changeViewZones((acc) => acc.layoutZone(z.zoneId))
          modifiedEditor.setScrollTop(scrollTop)
        }
        if (!readyFired) {
          readyFired = true
          onZonesReadyRef.current?.()
        }
      }

      // MutationObserver detects portal render and <details> toggles
      const mutation = new MutationObserver(measureAndAdjust)
      mutation.observe(z.domNode, { childList: true, subtree: true, attributes: true })

      // ResizeObserver detects content reflows (images loading, fonts, etc.)
      const resize = new ResizeObserver(measureAndAdjust)
      resize.observe(z.domNode)

      return { mutation, resize }
    })

    return () => {
      disposedRef.current = true
      observers.forEach((o) => {
        o.mutation.disconnect()
        o.resize.disconnect()
      })
      modifiedEditor.changeViewZones((acc) => {
        for (const z of newZones) acc.removeZone(z.zoneId)
      })
    }
  }, [modifiedEditor, threads])

  if (!modifiedEditor || threads.length === 0) return null

  // Render React content into each zone's DOM node via portals
  return (
    <>
      {portalTargets.map(({ domNode, thread }) =>
        createPortal(
          <CommentZoneContent
            key={thread.rootComment.id}
            thread={thread}
            isHighlighted={highlightLine !== undefined && thread.line === highlightLine}
          />,
          domNode
        )
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Inline comment card rendered inside a Monaco view zone
// ---------------------------------------------------------------------------

function CommentZoneContent({
  thread,
  isHighlighted
}: {
  thread: CommentThread
  isHighlighted: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'mx-1 my-0.5 rounded-md border text-xs',
        isHighlighted
          ? 'border-violet-500/50 bg-violet-950/40'
          : 'border-blue-500/30 bg-blue-950/30'
      )}
      onMouseDown={(e) => {
        // preventDefault stops the browser from changing focus/selection,
        // which is what causes Monaco to scroll. stopImmediatePropagation
        // on the native event prevents Monaco from seeing it at the DOM level
        // (React synthetic stopPropagation only stops within React's tree).
        e.preventDefault()
        e.stopPropagation()
        e.nativeEvent.stopImmediatePropagation()
      }}
      onClick={(e) => {
        e.stopPropagation()
        // Open links in external browser instead of navigating the Electron window
        const anchor = (e.target as HTMLElement).closest('a')
        if (anchor?.href) {
          e.preventDefault()
          window.open(anchor.href, '_blank')
        }
      }}
    >
      {/* Root comment */}
      <div className="px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-[11px]">
          <MessageSquare className="h-3 w-3 text-blue-400 shrink-0" />
          <span className="font-medium text-foreground">
            @{thread.rootComment.user?.login ?? 'ghost'}
          </span>
          <span className="text-muted-foreground">&bull;</span>
          <span className="text-muted-foreground">
            {thread.rootComment.createdAt
              ? formatRelativeTime(new Date(thread.rootComment.createdAt).getTime())
              : ''}
          </span>
        </div>
        <div
          className="mt-0.5 text-foreground break-words leading-relaxed pr-comment-html"
          dangerouslySetInnerHTML={{ __html: thread.rootComment.bodyHTML || thread.rootComment.body }}
        />
      </div>

      {/* Replies */}
      {thread.replies.map((reply) => (
        <div
          key={reply.id}
          className="px-3 py-1.5 border-t border-border/40 ml-4"
        >
          <div className="flex items-center gap-1.5 text-[11px]">
            <MessageSquare className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
            <span className="font-medium text-foreground">
              @{reply.user?.login ?? 'ghost'}
            </span>
            <span className="text-muted-foreground">&bull;</span>
            <span className="text-muted-foreground">
              {reply.createdAt
                ? formatRelativeTime(new Date(reply.createdAt).getTime())
                : ''}
            </span>
          </div>
          <div
            className="mt-0.5 text-foreground break-words leading-relaxed pr-comment-html"
            dangerouslySetInnerHTML={{ __html: reply.bodyHTML || reply.body }}
          />
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hook: group flat comments into threads by line
// ---------------------------------------------------------------------------

function useGroupedThreads(comments: PRReviewComment[]): CommentThread[] {
  return useMemo(() => {
    const roots: PRReviewComment[] = []
    const replyMap = new Map<number, PRReviewComment[]>()

    for (const c of comments) {
      if (c.inReplyToId === null) {
        roots.push(c)
      } else {
        const existing = replyMap.get(c.inReplyToId) ?? []
        existing.push(c)
        replyMap.set(c.inReplyToId, existing)
      }
    }

    return roots
      .filter((r) => r.line !== null || r.originalLine !== null)
      .map((root) => ({
        rootComment: root,
        replies: (replyMap.get(root.id) ?? []).sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        ),
        line: root.line ?? root.originalLine ?? 1
      }))
      .sort((a, b) => a.line - b.line)
  }, [comments])
}
