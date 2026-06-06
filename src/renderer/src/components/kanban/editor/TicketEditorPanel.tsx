import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore, BOARD_TAB_ID, TICKET_EDITOR_TAB_ID } from '@/stores/useSessionStore'
import { cn } from '@/lib/utils'
import { RichTextEditor } from './RichTextEditor'

const AUTOSAVE_DELAY = 800

interface TicketEditorPanelProps {
  ticketId: string
  /** 'drawer' = right-side overlay, 'tab' = full-screen Hive tab. */
  variant: 'drawer' | 'tab'
  className?: string
}

/**
 * Focused full-height editor for a single ticket's description. Used both inside
 * the right-side drawer and as the full-screen tab. Edits autosave (debounced)
 * to the ticket via the kanban store, so switching between drawer and tab — or
 * to another tab — never loses content.
 */
export function TicketEditorPanel({
  ticketId,
  variant,
  className
}: TicketEditorPanelProps): React.JSX.Element {
  const updateTicket = useKanbanStore((s) => s.updateTicket)
  const promoteEditorToTab = useKanbanStore((s) => s.promoteEditorToTab)
  const collapseEditorToDrawer = useKanbanStore((s) => s.collapseEditorToDrawer)
  const closeEditor = useKanbanStore((s) => s.closeEditor)

  // Reactively track the ticket so the title stays in sync with external edits.
  const ticket = useKanbanStore((s) => {
    for (const tickets of s.tickets.values()) {
      const found = tickets.find((t) => t.id === ticketId)
      if (found) return found
    }
    return null
  })
  const projectId = ticket?.project_id ?? null

  const [description, setDescription] = useState(() => ticket?.description ?? '')
  const savedRef = useRef(description)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [saving, setSaving] = useState(false)

  // Mirror the latest value into a ref so the unmount cleanup can flush it.
  const descriptionRef = useRef(description)
  useEffect(() => {
    descriptionRef.current = description
  }, [description])

  // Reseed when the open ticket changes (a different ticket id).
  useEffect(() => {
    const current = useKanbanStore.getState().getTicketById(ticketId)?.description ?? ''
    setDescription(current)
    savedRef.current = current
  }, [ticketId])

  const persist = useCallback(
    (value: string) => {
      if (!projectId) return
      if (value === savedRef.current) return
      savedRef.current = value
      setSaving(true)
      void updateTicket(ticketId, projectId, { description: value.trim() ? value : null }).finally(
        () => setSaving(false)
      )
    },
    [ticketId, projectId, updateTicket]
  )

  const handleChange = useCallback(
    (md: string) => {
      setDescription(md)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => persist(md), AUTOSAVE_DELAY)
    },
    [persist]
  )

  // Flush pending edits on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      persist(descriptionRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flushAndClose = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    persist(descriptionRef.current)
    closeEditor()
    useSessionStore.getState().setActiveSession(BOARD_TAB_ID)
  }, [persist, closeEditor])

  const toFullscreen = useCallback(() => {
    promoteEditorToTab()
    useSessionStore.getState().setActiveSession(TICKET_EDITOR_TAB_ID)
  }, [promoteEditorToTab])

  const toDrawer = useCallback(() => {
    collapseEditorToDrawer()
    useSessionStore.getState().setActiveSession(BOARD_TAB_ID)
  }, [collapseEditorToDrawer])

  const title = useMemo(() => ticket?.title?.trim() || 'Untitled ticket', [ticket?.title])

  if (!ticket) {
    return (
      <div
        className={cn('flex min-h-0 flex-1 items-center justify-center text-muted-foreground', className)}
      >
        <p className="text-sm">This ticket is no longer available.</p>
      </div>
    )
  }

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}
      data-testid="ticket-editor-panel"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {title}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
          {saving ? 'Saving…' : 'Saved'}
        </span>
        {variant === 'drawer' ? (
          <button
            type="button"
            onClick={toFullscreen}
            title="Open full screen"
            aria-label="Open full screen"
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="ticket-editor-fullscreen"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={toDrawer}
            title="Collapse to side panel"
            aria-label="Collapse to side panel"
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="ticket-editor-collapse"
          >
            <Minimize2 className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={flushAndClose}
          title="Close editor"
          aria-label="Close editor"
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          data-testid="ticket-editor-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <RichTextEditor
        value={description}
        onChange={handleChange}
        autofocus
        placeholder="Describe the ticket… press '/' for commands"
        className="min-h-0 flex-1"
      />
    </div>
  )
}
