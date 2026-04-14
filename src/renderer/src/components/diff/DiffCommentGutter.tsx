import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Plus, MessageSquare, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { reanchorComments } from '@/lib/diff-comment-anchor'
import { formatRelativeTime } from '@/lib/format-utils'
import { toast } from '@/lib/toast'
import { useDiffCommentStore, onJump } from '@/stores/useDiffCommentStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { editor } from 'monaco-editor'

const EMPTY_COMMENTS: DiffComment[] = []

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiffCommentGutterProps {
  modifiedEditor: editor.IStandaloneCodeEditor | null
  filePath: string
}

type EditorState = 'idle' | 'dragging' | 'editor-open'

interface EditorZonePortal {
  domNode: HTMLDivElement
  lineStart: number
  lineEnd: number
}

interface SavedZonePortal {
  domNode: HTMLDivElement
  comment: DiffComment
}

// ---------------------------------------------------------------------------
// DiffCommentGutter
// ---------------------------------------------------------------------------

export function DiffCommentGutter({
  modifiedEditor,
  filePath
}: DiffCommentGutterProps): React.JSX.Element | null {
  const worktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  // Subscribe to the raw Map entry (stable reference) — NOT getCommentsForFile()
  // which calls .filter() and returns a new array every evaluation, causing
  // Zustand's Object.is check to always see "changed" → infinite re-render loop.
  const allComments = useDiffCommentStore((s) =>
    worktreeId ? s.comments.get(worktreeId) : undefined
  ) ?? EMPTY_COMMENTS
  const fileComments = useMemo(
    () => worktreeId
      ? allComments.filter((c) => c.file_path === filePath)
      : EMPTY_COMMENTS,
    [allComments, filePath, worktreeId]
  )
  const { create, update, remove, fetch, updateLocalLines } = useDiffCommentStore()

  // Fetch comments on mount and when worktreeId changes
  const fetchedWorktreeRef = useRef<string | null>(null)
  useEffect(() => {
    if (worktreeId && fetchedWorktreeRef.current !== worktreeId) {
      fetchedWorktreeRef.current = worktreeId
      fetch(worktreeId)
    }
  }, [worktreeId, fetch])

  // ---------------------------------------------------------------------------
  // Hover state for + button
  // ---------------------------------------------------------------------------

  const [hoveredLine, setHoveredLine] = useState<number | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  // Pixel offset of the modified editor's left edge relative to the
  // positioned container (the `flex-1 relative` wrapper in MonacoDiffView).
  // In side-by-side mode this is roughly half the container width;
  // in inline mode it is 0.
  const [editorLeftOffset, setEditorLeftOffset] = useState(0)
  // Debounced hide: prevents the + button from vanishing when the mouse
  // moves from the editor DOM to the button (which is a sibling element).
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ref to the + button element — used in mouseleave relatedTarget checks
  // to detect when the mouse moves between the editor and the button.
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Editor interaction state machine
  const [editorState, setEditorState] = useState<EditorState>('idle')
  const [dragStartLine, setDragStartLine] = useState(1)
  const [dragEndLine, setDragEndLine] = useState(1)
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)

  // Editor view zone portal
  const [editorZone, setEditorZone] = useState<EditorZonePortal | null>(null)
  const editorZoneIdRef = useRef<string | null>(null)

  // Anchor ref — a direct child of the flex-1 relative container.
  // Used to reliably compute the container's bounding rect for positioning.
  // (We can't use modifiedEditor.getDomNode().offsetParent because Monaco
  // has internal positioned elements that intercept offsetParent.)
  const anchorRef = useRef<HTMLDivElement>(null)

  // Saved comment view zone portals
  const [savedPortals, setSavedPortals] = useState<SavedZonePortal[]>([])
  const savedZonesRef = useRef<Array<{ zoneId: string; domNode: HTMLDivElement }>>([])
  const savedDecosRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const disposedRef = useRef(false)

  // ---------------------------------------------------------------------------
  // Hover + button tracking via native mousemove
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!modifiedEditor) return

    const editorDom = modifiedEditor.getDomNode()
    if (!editorDom) return

    // Compute modified editor's left offset relative to the container
    // (the MonacoDiffView `flex-1 relative` div). We compare the
    // modified editor's screen rect against anchorRef's screen rect —
    // anchorRef is a direct child of the container with `absolute inset-0`,
    // so its rect matches the container exactly. This avoids offsetParent
    // which resolves to internal Monaco positioned elements.
    const computeEditorOffset = (): void => {
      const anchor = anchorRef.current
      if (!anchor) return
      const editorRect = editorDom.getBoundingClientRect()
      const containerRect = anchor.getBoundingClientRect()
      setEditorLeftOffset(editorRect.left - containerRect.left)
    }

    const handleMouseMove = (e: MouseEvent): void => {
      // Mouse is back in the editor — cancel any pending hide
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }

      const rect = editorDom.getBoundingClientRect()
      const currentScrollTop = modifiedEditor.getScrollTop()
      const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 1

      const line = Math.min(
        Math.max(1, Math.floor((e.clientY - rect.top + currentScrollTop) / 20) + 1),
        lineCount
      )

      setHoveredLine(line)
    }

    // When the mouse leaves the editor, check if it went to the + button.
    // If so, don't hide — the button rendered on top of the editor and the
    // browser fires mouseleave even though the user hasn't moved away.
    // For any other target, debounce the hide to handle edge transitions.
    const handleMouseLeave = (e: MouseEvent): void => {
      // Mouse went to the + button → don't hide
      if (buttonRef.current?.contains(e.relatedTarget as Node)) return

      hideTimerRef.current = setTimeout(() => {
        setHoveredLine(null)
        hideTimerRef.current = null
      }, 150)
    }

    editorDom.addEventListener('mousemove', handleMouseMove)
    editorDom.addEventListener('mouseleave', handleMouseLeave as EventListener)

    const scrollDisposable = modifiedEditor.onDidScrollChange((e) => {
      setScrollTop(e.scrollTop)
    })

    // Recompute offset when layout changes (e.g. side-by-side toggle,
    // split resizing, window resize).
    const layoutDisposable = modifiedEditor.onDidLayoutChange(() => {
      computeEditorOffset()
    })

    // Initialize
    setScrollTop(modifiedEditor.getScrollTop())
    computeEditorOffset()

    return () => {
      editorDom.removeEventListener('mousemove', handleMouseMove)
      editorDom.removeEventListener('mouseleave', handleMouseLeave as EventListener)
      scrollDisposable.dispose()
      layoutDisposable.dispose()
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [modifiedEditor])

  // ---------------------------------------------------------------------------
  // Drag-to-range interaction
  // ---------------------------------------------------------------------------

  const handleGutterMouseDown = useCallback(
    (startLine: number) => {
      if (!modifiedEditor) return

      setDragStartLine(startLine)
      setDragEndLine(startLine)
      setEditorState('dragging')

      // Initial decoration
      const deco = modifiedEditor.createDecorationsCollection([
        {
          range: {
            startLineNumber: startLine,
            startColumn: 1,
            endLineNumber: startLine,
            endColumn: 1
          },
          options: { isWholeLine: true, className: 'diff-comment-range-highlight' }
        }
      ])
      decorationsRef.current = deco

      const editorDom = modifiedEditor.getDomNode()
      if (!editorDom) return

      const handleDocMouseMove = (e: MouseEvent): void => {
        const rect = editorDom.getBoundingClientRect()
        const currentScrollTop = modifiedEditor.getScrollTop()
        const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 1

        const currentLine = Math.min(
          Math.max(1, Math.floor((e.clientY - rect.top + currentScrollTop) / 20) + 1),
          lineCount
        )

        setDragEndLine(currentLine)

        const rangeStart = Math.min(startLine, currentLine)
        const rangeEnd = Math.max(startLine, currentLine)

        deco.set([
          {
            range: {
              startLineNumber: rangeStart,
              startColumn: 1,
              endLineNumber: rangeEnd,
              endColumn: 1
            },
            options: { isWholeLine: true, className: 'diff-comment-range-highlight' }
          }
        ])
      }

      const handleDocMouseUp = (): void => {
        document.removeEventListener('mousemove', handleDocMouseMove)
        document.removeEventListener('mouseup', handleDocMouseUp)
        setEditorState('editor-open')
      }

      document.addEventListener('mousemove', handleDocMouseMove)
      document.addEventListener('mouseup', handleDocMouseUp)
    },
    [modifiedEditor]
  )

  // ---------------------------------------------------------------------------
  // Open inline editor view zone when entering 'editor-open' state
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (editorState !== 'editor-open' || !modifiedEditor) return

    const lineStart = Math.min(dragStartLine, dragEndLine)
    const lineEnd = Math.max(dragStartLine, dragEndLine)
    const afterLine = lineEnd

    const domNode = document.createElement('div')
    domNode.style.pointerEvents = 'auto'
    domNode.style.position = 'relative'
    domNode.style.zIndex = '1'

    // Keep a mutable reference to the zone so measureAndAdjust can update heightInPx
    // before calling layoutZone (same pattern as PrCommentGutter).
    const zone = {
      afterLineNumber: afterLine,
      heightInPx: 120,
      domNode,
      suppressMouseDown: true
    }

    const scrollBefore = modifiedEditor.getScrollTop()
    modifiedEditor.changeViewZones((acc) => {
      editorZoneIdRef.current = acc.addZone(zone)
    })
    modifiedEditor.setScrollTop(scrollBefore)

    setEditorZone({ domNode, lineStart, lineEnd })

    // Auto-size observer — measures the React content's natural height and
    // updates the zone's heightInPx before calling layoutZone.
    const measureAndAdjust = (): void => {
      const child = domNode.firstElementChild as HTMLElement | null
      if (!child || !modifiedEditor) return
      const actualHeight = child.offsetHeight
      if (actualHeight > 0 && Math.abs(actualHeight - zone.heightInPx) > 2) {
        zone.heightInPx = actualHeight + 4
        const st = modifiedEditor.getScrollTop()
        modifiedEditor.changeViewZones((acc) => {
          if (editorZoneIdRef.current) {
            acc.layoutZone(editorZoneIdRef.current)
          }
        })
        modifiedEditor.setScrollTop(st)
      }
    }

    const mutation = new MutationObserver(measureAndAdjust)
    mutation.observe(domNode, { childList: true, subtree: true, attributes: true })
    const resize = new ResizeObserver(measureAndAdjust)
    resize.observe(domNode)

    return () => {
      mutation.disconnect()
      resize.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorState, modifiedEditor])

  // ---------------------------------------------------------------------------
  // Cancel editor
  // ---------------------------------------------------------------------------

  const cancelEditor = useCallback(() => {
    if (modifiedEditor && editorZoneIdRef.current) {
      const st = modifiedEditor.getScrollTop()
      modifiedEditor.changeViewZones((acc) => {
        if (editorZoneIdRef.current) acc.removeZone(editorZoneIdRef.current)
      })
      modifiedEditor.setScrollTop(st)
      editorZoneIdRef.current = null
    }
    decorationsRef.current?.clear()
    decorationsRef.current = null
    setEditorZone(null)
    setEditorState('idle')
  }, [modifiedEditor])

  // ---------------------------------------------------------------------------
  // Save new comment
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(
    async (body: string) => {
      if (!worktreeId || !modifiedEditor) return

      const model = modifiedEditor.getModel()
      if (!model) return

      const lineStart = Math.min(dragStartLine, dragEndLine)
      const lineEnd = Math.max(dragStartLine, dragEndLine)
      const isSingleLine = lineStart === lineEnd

      // Capture anchor text
      let anchorText: string
      if (isSingleLine) {
        anchorText = model.getLineContent(lineStart)
      } else {
        const lines: string[] = []
        for (let i = lineStart; i <= lineEnd; i++) {
          lines.push(model.getLineContent(i))
        }
        anchorText = lines.join('\n')
      }

      // Context before
      let anchorContextBefore: string | null = null
      if (lineStart > 1) {
        const contextStart = Math.max(1, lineStart - 3)
        const contextLines: string[] = []
        for (let i = contextStart; i < lineStart; i++) {
          contextLines.push(model.getLineContent(i))
        }
        anchorContextBefore = contextLines.join('\n')
      }

      // Context after
      const lineCount = model.getLineCount()
      let anchorContextAfter: string | null = null
      if (lineEnd < lineCount) {
        const contextEnd = Math.min(lineCount, lineEnd + 3)
        const contextLines: string[] = []
        for (let i = lineEnd + 1; i <= contextEnd; i++) {
          contextLines.push(model.getLineContent(i))
        }
        anchorContextAfter = contextLines.join('\n')
      }

      const result = await create({
        worktree_id: worktreeId,
        file_path: filePath,
        line_start: lineStart,
        line_end: isSingleLine ? null : lineEnd,
        anchor_text: anchorText,
        anchor_context_before: anchorContextBefore,
        anchor_context_after: anchorContextAfter,
        body
      })

      if (result) {
        cancelEditor()
      } else {
        toast.error('Failed to save comment')
      }
    },
    [worktreeId, modifiedEditor, dragStartLine, dragEndLine, filePath, create, cancelEditor]
  )

  // ---------------------------------------------------------------------------
  // Model version tracking — detect when file content changes
  // ---------------------------------------------------------------------------

  const [modelVersion, setModelVersion] = useState(0)

  useEffect(() => {
    if (!modifiedEditor) return
    const disposable = modifiedEditor.onDidChangeModelContent(() => {
      setModelVersion((v) => v + 1)
    })
    setModelVersion((v) => v + 1) // capture initial state
    return () => disposable.dispose()
  }, [modifiedEditor])

  // ---------------------------------------------------------------------------
  // Re-anchoring effect — update comment positions when content changes
  // ---------------------------------------------------------------------------

  const lastAnchorKeyRef = useRef('')

  useEffect(() => {
    if (!modifiedEditor || !worktreeId || fileComments.length === 0) return

    const model = modifiedEditor.getModel()
    if (!model) return

    const lineCount = model.getLineCount()
    const commentIds = fileComments.map((c) => c.id).sort().join(',')
    const anchorKey = `${modelVersion}:${commentIds}`

    if (anchorKey === lastAnchorKeyRef.current) return
    lastAnchorKeyRef.current = anchorKey

    const getLineContent = (n: number): string => model.getLineContent(n)
    const results = reanchorComments(fileComments, getLineContent, lineCount)
    updateLocalLines(worktreeId, results)
  }, [modifiedEditor, fileComments, worktreeId, modelVersion, updateLocalLines])

  // ---------------------------------------------------------------------------
  // Saved comment view zones
  // ---------------------------------------------------------------------------

  useEffect(() => {
    disposedRef.current = false

    if (!modifiedEditor) return

    // Remove previous saved zones
    if (savedZonesRef.current.length > 0) {
      modifiedEditor.changeViewZones((acc) => {
        for (const z of savedZonesRef.current) acc.removeZone(z.zoneId)
      })
      savedZonesRef.current = []
    }
    savedDecosRef.current?.clear()
    savedDecosRef.current = null

    if (fileComments.length === 0) {
      setSavedPortals([])
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newZones: Array<{ zoneId: string; zone: any; domNode: HTMLDivElement; comment: DiffComment }> = []

    const scrollBefore = modifiedEditor.getScrollTop()
    modifiedEditor.changeViewZones((acc) => {
      for (const comment of fileComments) {
        const domNode = document.createElement('div')
        domNode.style.pointerEvents = 'auto'
        domNode.style.position = 'relative'
        domNode.style.zIndex = '1'

        const afterLine = comment.line_end ?? comment.line_start
        const zone = {
          afterLineNumber: afterLine,
          heightInPx: 60,
          domNode,
          suppressMouseDown: true
        }

        const zoneId = acc.addZone(zone)
        newZones.push({ zoneId, zone, domNode, comment })
      }
    })
    modifiedEditor.setScrollTop(scrollBefore)

    savedZonesRef.current = newZones.map((z) => ({ zoneId: z.zoneId, domNode: z.domNode }))
    setSavedPortals(newZones.map((z) => ({ domNode: z.domNode, comment: z.comment })))

    // Apply range decorations for saved comments
    const decoEntries = fileComments.map((c) => ({
      range: {
        startLineNumber: c.line_start,
        startColumn: 1,
        endLineNumber: c.line_end ?? c.line_start,
        endColumn: 1
      },
      options: {
        isWholeLine: true,
        className: c.is_outdated
          ? 'diff-comment-range-highlight-outdated'
          : 'diff-comment-range-highlight'
      }
    }))
    savedDecosRef.current = modifiedEditor.createDecorationsCollection(decoEntries)

    // Auto-size observers — measure the React content's natural height
    // and update zone.heightInPx before layoutZone (PrCommentGutter pattern).
    const observers = newZones.map((z) => {
      const measureAndAdjust = (): void => {
        if (disposedRef.current || !modifiedEditor) return
        const child = z.domNode.firstElementChild as HTMLElement | null
        if (!child) return
        const actualHeight = child.offsetHeight
        if (actualHeight > 0 && Math.abs(actualHeight - z.zone.heightInPx) > 2) {
          z.zone.heightInPx = actualHeight + 4
          const st = modifiedEditor.getScrollTop()
          modifiedEditor.changeViewZones((acc) => acc.layoutZone(z.zoneId))
          modifiedEditor.setScrollTop(st)
        }
      }

      const mutation = new MutationObserver(measureAndAdjust)
      mutation.observe(z.domNode, { childList: true, subtree: true, attributes: true })
      const resizeOb = new ResizeObserver(measureAndAdjust)
      resizeOb.observe(z.domNode)

      return { mutation, resize: resizeOb }
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
      savedDecosRef.current?.clear()
    }
  }, [modifiedEditor, fileComments])

  // ---------------------------------------------------------------------------
  // Jump-to-comment subscription
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let flashTimer: ReturnType<typeof setTimeout> | null = null

    const unsub = onJump((commentId) => {
      const comment = fileComments.find((c) => c.id === commentId)
      if (!comment || !modifiedEditor) return

      const targetLine = comment.line_end ?? comment.line_start
      modifiedEditor.revealLineInCenter(targetLine)

      // Flash decoration for 1.5s
      const flashDeco = modifiedEditor.createDecorationsCollection([
        {
          range: {
            startLineNumber: comment.line_start,
            startColumn: 1,
            endLineNumber: targetLine,
            endColumn: 1
          },
          options: { isWholeLine: true, className: 'diff-comment-jump-flash' }
        }
      ])
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => flashDeco.clear(), 1500)
    })

    return () => {
      unsub()
      if (flashTimer) clearTimeout(flashTimer)
    }
  }, [fileComments, modifiedEditor])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!modifiedEditor) return null

  // Show the + button whenever the mouse is over any line in the modified
  // editor (not just the narrow gutter strip). The button is positioned in
  // the gutter but must remain visible across the full line hover so users
  // can actually reach and click it. This matches GitHub/GitLab UX.
  const showPlusButton =
    hoveredLine !== null && editorState === 'idle'
  const buttonTop = showPlusButton
    ? modifiedEditor.getTopForLineNumber(hoveredLine) - scrollTop
    : 0
  // Position in the modified editor's gutter: editor offset + small inset
  const gutterLeft = editorLeftOffset + 4

  return (
    <>
      {/* Invisible anchor for measuring the container's bounding rect */}
      <div ref={anchorRef} className="absolute inset-0 pointer-events-none" />

      {/* Hover + button */}
      {showPlusButton && (
        <button
          ref={buttonRef}
          className="absolute z-20 flex items-center justify-center w-5 h-5 rounded-sm bg-violet-600 hover:bg-violet-500 text-white cursor-pointer transition-colors"
          style={{
            top: buttonTop,
            left: gutterLeft,
            pointerEvents: 'auto'
          }}
          onMouseEnter={() => {
            // Mouse reached the button — cancel the pending hide
            if (hideTimerRef.current) {
              clearTimeout(hideTimerRef.current)
              hideTimerRef.current = null
            }
          }}
          onMouseMove={(e) => {
            // Track line changes while hovering the button so it follows
            // the mouse vertically (the editor's mousemove doesn't fire
            // while the mouse is over this sibling element).
            const editorDom = modifiedEditor?.getDomNode()
            if (!editorDom || !modifiedEditor) return
            const rect = editorDom.getBoundingClientRect()
            const currentScrollTop = modifiedEditor.getScrollTop()
            const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 1
            const line = Math.min(
              Math.max(1, Math.floor((e.clientY - rect.top + currentScrollTop) / 20) + 1),
              lineCount
            )
            setHoveredLine(line)
          }}
          onMouseLeave={(e) => {
            // If going back to the editor, let editor's mousemove take over
            const editorDom = modifiedEditor?.getDomNode()
            if (editorDom?.contains(e.relatedTarget as Node)) return
            // Otherwise hide
            setHoveredLine(null)
          }}
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            e.nativeEvent.stopImmediatePropagation()
            handleGutterMouseDown(hoveredLine)
          }}
          title="Add comment"
        >
          <Plus className="h-3 w-3" />
        </button>
      )}

      {/* Editor view zone portal */}
      {editorZone &&
        createPortal(
          <CommentEditorZone
            lineStart={editorZone.lineStart}
            lineEnd={editorZone.lineEnd}
            onSave={handleSave}
            onCancel={cancelEditor}
          />,
          editorZone.domNode
        )}

      {/* Saved comment view zone portals */}
      {savedPortals.map(({ domNode, comment }) =>
        createPortal(
          <SavedCommentCard
            key={comment.id}
            comment={comment}
            onUpdate={update}
            onDelete={remove}
          />,
          domNode
        )
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// CommentEditorZone — inline editor for creating new comments
// ---------------------------------------------------------------------------

function CommentEditorZone({
  lineStart,
  lineEnd,
  onSave,
  onCancel
}: {
  lineStart: number
  lineEnd: number
  onSave: (body: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const isSingleLine = lineStart === lineEnd

  return (
    <div
      className="mx-1 my-0.5 rounded-md border border-violet-500/30 bg-violet-950/30 text-xs"
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.nativeEvent.stopImmediatePropagation()
      }}
    >
      <div className="px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
          <MessageSquare className="h-3 w-3 text-violet-400 shrink-0" />
          <span>{isSingleLine ? `Line ${lineStart}` : `Lines ${lineStart}-${lineEnd}`}</span>
        </div>
        <textarea
          className="w-full bg-transparent border border-border/50 rounded px-2 py-1 text-xs text-foreground resize-none font-mono focus:outline-none focus:border-violet-500/50"
          rows={3}
          autoFocus
          placeholder="Write a comment..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              if (body.trim()) onSave(body.trim())
            }
          }}
          onMouseDown={(e) => {
            // Allow text selection inside textarea but stop Monaco
            e.stopPropagation()
            e.nativeEvent.stopImmediatePropagation()
          }}
        />
        <div className="flex items-center justify-end gap-1.5 mt-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={onCancel}
          >
            <X className="h-3 w-3 mr-1" />
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-6 px-2 text-[11px] bg-violet-600 hover:bg-violet-500"
            disabled={!body.trim()}
            onClick={() => onSave(body.trim())}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SavedCommentCard — read / edit / delete for persisted comments
// ---------------------------------------------------------------------------

function SavedCommentCard({
  comment,
  onUpdate,
  onDelete
}: {
  comment: DiffComment
  onUpdate: (id: string, data: { body: string }) => Promise<DiffComment | null>
  onDelete: (id: string) => Promise<boolean>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(comment.body)
  const isSingleLine = comment.line_end === null

  const handleSaveEdit = async (): Promise<void> => {
    const trimmed = editBody.trim()
    if (!trimmed) return
    const result = await onUpdate(comment.id, { body: trimmed })
    if (result) {
      setEditing(false)
    } else {
      toast.error('Failed to update comment')
    }
  }

  const handleDelete = async (): Promise<void> => {
    const success = await onDelete(comment.id)
    if (!success) {
      toast.error('Failed to delete comment')
    }
  }

  return (
    <div
      className={cn(
        "mx-1 my-0.5 rounded-md text-xs",
        comment.is_outdated
          ? "border border-yellow-500/40 bg-yellow-950/20"
          : "border border-violet-500/30 bg-violet-950/30"
      )}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.nativeEvent.stopImmediatePropagation()
      }}
    >
      <div className="px-3 py-1.5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px]">
            <MessageSquare className="h-3 w-3 text-violet-400 shrink-0" />
            <span className="text-muted-foreground">
              {isSingleLine
                ? `Line ${comment.line_start}`
                : `Lines ${comment.line_start}-${comment.line_end}`}
            </span>
            <span className="text-muted-foreground">&bull;</span>
            <span className="text-muted-foreground">
              {formatRelativeTime(new Date(comment.created_at).getTime())}
            </span>
          </div>
          {comment.is_outdated && (
            <span className="px-1 py-px rounded text-[9px] font-medium bg-yellow-500/10 text-yellow-500 shrink-0">
              outdated
            </span>
          )}
          {!editing && (
            <div className="flex items-center gap-0.5">
              <button
                className="p-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => {
                  setEditBody(comment.body)
                  setEditing(true)
                }}
                title="Edit comment"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                className="p-0.5 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors"
                onClick={handleDelete}
                title="Delete comment"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>

        {comment.is_outdated && comment.anchor_text && (
          <div className="mt-1 px-2 py-1 rounded bg-yellow-500/5 border border-yellow-500/10 font-mono text-[10px] text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-16 overflow-hidden">
            {comment.anchor_text}
          </div>
        )}

        {/* Body — read vs edit mode */}
        {editing ? (
          <div className="mt-1">
            <textarea
              className="w-full bg-transparent border border-border/50 rounded px-2 py-1 text-xs text-foreground resize-none font-mono focus:outline-none focus:border-violet-500/50"
              rows={3}
              autoFocus
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditing(false)
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSaveEdit()
                }
              }}
              onMouseDown={(e) => {
                e.stopPropagation()
                e.nativeEvent.stopImmediatePropagation()
              }}
            />
            <div className="flex items-center justify-end gap-1.5 mt-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                className="h-6 px-2 text-[11px] bg-violet-600 hover:bg-violet-500"
                disabled={!editBody.trim()}
                onClick={handleSaveEdit}
              >
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-0.5 text-foreground break-words leading-relaxed whitespace-pre-wrap">
            {comment.body}
          </p>
        )}
      </div>
    </div>
  )
}
