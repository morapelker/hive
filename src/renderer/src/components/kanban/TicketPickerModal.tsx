import { useState, useMemo, useCallback, useEffect } from 'react'
import { Search, KanbanSquare, Paperclip, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'

// ── Stable empty array to avoid infinite re-renders with Zustand ────
const EMPTY_TICKETS: KanbanTicket[] = []

// ── Types ───────────────────────────────────────────────────────────
export interface TicketAttachmentData {
  ticketId: string
  title: string
  description: string
  attachments: string
}

interface TicketPickerModalProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectTickets: (tickets: TicketAttachmentData[]) => void
}

// ── Column metadata for filter chips ────────────────────────────────
const COLUMNS: { key: KanbanTicketColumn; label: string; color: string; activeColor: string }[] = [
  { key: 'todo', label: 'To Do', color: 'border-zinc-600 text-zinc-400', activeColor: 'border-zinc-400 bg-zinc-400/15 text-zinc-200' },
  { key: 'in_progress', label: 'In Progress', color: 'border-blue-600/50 text-blue-400/70', activeColor: 'border-blue-500 bg-blue-500/15 text-blue-300' },
  { key: 'review', label: 'Review', color: 'border-amber-600/50 text-amber-400/70', activeColor: 'border-amber-500 bg-amber-500/15 text-amber-300' },
  { key: 'done', label: 'Done', color: 'border-emerald-600/50 text-emerald-400/70', activeColor: 'border-emerald-500 bg-emerald-500/15 text-emerald-300' }
]

// ── Column badge for ticket rows ────────────────────────────────────
function ColumnBadge({ column }: { column: KanbanTicketColumn }) {
  const meta = COLUMNS.find((c) => c.key === column)
  if (!meta) return null
  return (
    <span
      className={cn(
        'text-[10px] px-1.5 py-0.5 rounded border font-medium',
        meta.activeColor
      )}
    >
      {meta.label}
    </span>
  )
}

// ── Component ───────────────────────────────────────────────────────
export function TicketPickerModal({
  projectId,
  open,
  onOpenChange,
  onSelectTickets
}: TicketPickerModalProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [activeFilters, setActiveFilters] = useState<Set<KanbanTicketColumn>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // ── Store access ────────────────────────────────────────────────
  const tickets = useKanbanStore(
    useCallback(
      (state) => state.tickets.get(projectId) ?? EMPTY_TICKETS,
      [projectId]
    )
  )

  // Ensure tickets are loaded when the modal opens
  useEffect(() => {
    if (open) {
      useKanbanStore.getState().loadTickets(projectId)
    }
  }, [open, projectId])

  // ── Filtering ───────────────────────────────────────────────────
  const filteredTickets = useMemo(() => {
    let result = tickets

    // Column filter (multi-select — show all if none selected)
    if (activeFilters.size > 0) {
      result = result.filter((t) => activeFilters.has(t.column))
    }

    // Search filter (case-insensitive by title)
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      result = result.filter((t) => t.title.toLowerCase().includes(q))
    }

    return result
  }, [tickets, activeFilters, searchQuery])

  // ── Handlers ────────────────────────────────────────────────────
  const toggleFilter = (column: KanbanTicketColumn) => {
    setActiveFilters((prev) => {
      const next = new Set(prev)
      if (next.has(column)) {
        next.delete(column)
      } else {
        next.add(column)
      }
      return next
    })
  }

  const toggleTicketSelection = (ticketId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(ticketId)) {
        next.delete(ticketId)
      } else {
        next.add(ticketId)
      }
      return next
    })
  }

  const handleDone = () => {
    const selectedTickets = tickets.filter((t) => selectedIds.has(t.id))
    const result: TicketAttachmentData[] = selectedTickets.map((t) => ({
      ticketId: t.id,
      title: t.title,
      description: t.description ?? '',
      attachments: JSON.stringify(t.attachments ?? [])
    }))
    onSelectTickets(result)
    // Reset state
    setSearchQuery('')
    setActiveFilters(new Set())
    setSelectedIds(new Set())
    onOpenChange(false)
  }

  const handleCancel = () => {
    setSearchQuery('')
    setActiveFilters(new Set())
    setSelectedIds(new Set())
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <KanbanSquare className="h-4 w-4 text-blue-400" />
            Attach board tickets
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Select tickets to attach as context for this message.
          </DialogDescription>
        </DialogHeader>

        {/* Search input */}
        <div className="px-5 pb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search tickets by title..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-muted/50 border border-border rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="ticket-search-input"
              autoFocus
            />
          </div>
        </div>

        {/* Column filter chips */}
        <div className="flex gap-1.5 px-5 pb-3">
          {COLUMNS.map((col) => (
            <button
              key={col.key}
              onClick={() => toggleFilter(col.key)}
              className={cn(
                'text-[11px] px-2 py-0.5 rounded-full border transition-colors cursor-pointer',
                activeFilters.has(col.key) ? col.activeColor : col.color,
                'hover:opacity-80'
              )}
              data-testid={`column-filter-${col.key}`}
            >
              {col.label}
            </button>
          ))}
        </div>

        {/* Ticket list */}
        <div className="flex-1 overflow-y-auto min-h-0 border-t border-border">
          {filteredTickets.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              {tickets.length === 0 ? 'No tickets in this project' : 'No tickets match your filters'}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filteredTickets.map((ticket) => {
                const isSelected = selectedIds.has(ticket.id)
                const attachmentCount = Array.isArray(ticket.attachments)
                  ? ticket.attachments.length
                  : 0
                return (
                  <button
                    key={ticket.id}
                    onClick={() => toggleTicketSelection(ticket.id)}
                    className={cn(
                      'w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors cursor-pointer',
                      isSelected
                        ? 'bg-blue-500/10'
                        : 'hover:bg-muted/50'
                    )}
                    data-testid={`ticket-row-${ticket.id}`}
                  >
                    {/* Selection indicator */}
                    <div
                      className={cn(
                        'flex-shrink-0 h-4 w-4 rounded border flex items-center justify-center transition-colors',
                        isSelected
                          ? 'bg-blue-500 border-blue-500'
                          : 'border-muted-foreground/30'
                      )}
                    >
                      {isSelected && <Check className="h-3 w-3 text-white" />}
                    </div>

                    {/* Ticket info */}
                    <div className="flex-1 min-w-0">
                      <span className="text-sm truncate block">{ticket.title}</span>
                    </div>

                    {/* Column badge */}
                    <ColumnBadge column={ticket.column} />

                    {/* Attachment count */}
                    {attachmentCount > 0 && (
                      <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground flex-shrink-0">
                        <Paperclip className="h-3 w-3" />
                        {attachmentCount}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="px-5 py-3 border-t border-border">
          <div className="flex items-center justify-between w-full">
            <span className="text-xs text-muted-foreground">
              {selectedIds.size > 0
                ? `${selectedIds.size} ticket${selectedIds.size > 1 ? 's' : ''} selected`
                : 'No tickets selected'}
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                data-testid="ticket-picker-cancel"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleDone}
                disabled={selectedIds.size === 0}
                data-testid="ticket-picker-done"
              >
                Attach {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
