import { useEffect } from 'react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { cn } from '@/lib/utils'
import { TicketEditorPanel } from './TicketEditorPanel'

/**
 * Right-side slide-in drawer hosting the focused ticket editor. Rendered as a
 * fixed overlay so it floats above the board. A full-screen button inside the
 * panel promotes it to a dedicated Hive tab.
 */
export function TicketEditorDrawer(): React.JSX.Element | null {
  const editorTicketId = useKanbanStore((s) => s.editorTicketId)
  const editorDrawerOpen = useKanbanStore((s) => s.editorDrawerOpen)
  const closeEditor = useKanbanStore((s) => s.closeEditor)

  const open = editorDrawerOpen && !!editorTicketId

  // Close on Escape while the drawer is open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeEditor()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeEditor])

  if (!open || !editorTicketId) return null

  return (
    <div className="fixed inset-0 z-50" data-testid="ticket-editor-drawer">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30 animate-in fade-in"
        onClick={closeEditor}
        aria-hidden
      />
      {/* Panel */}
      <div
        className={cn(
          'absolute inset-y-0 right-0 flex w-full max-w-[640px] flex-col border-l border-border bg-background shadow-xl',
          'animate-in slide-in-from-right duration-200'
        )}
        role="dialog"
        aria-label="Ticket editor"
      >
        <TicketEditorPanel ticketId={editorTicketId} variant="drawer" />
      </div>
    </div>
  )
}
