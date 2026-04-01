import { useState, useMemo } from 'react'
import { Download, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { toast } from 'sonner'

interface ExportedTicket {
  id: string
  title: string
  description?: string | null
  attachments?: unknown[]
  column?: string
}

interface HiveImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  tickets: ExportedTicket[]
}

export function HiveImportModal({
  open,
  onOpenChange,
  projectId,
  tickets
}: HiveImportModalProps) {
  const loadTickets = useKanbanStore((s) => s.loadTickets)
  const existingTickets = useKanbanStore((s) => s.tickets)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(tickets.map((t) => t.id))
  )
  const [importing, setImporting] = useState(false)

  // Determine which tickets are new vs updates by checking existing tickets in the store
  const ticketStatuses = useMemo(() => {
    const projectTickets = existingTickets.get(projectId) ?? []
    const existingIdSet = new Set(projectTickets.map((t) => t.id))
    return tickets.map((t) => ({
      ...t,
      isUpdate: existingIdSet.has(t.id)
    }))
  }, [tickets, existingTickets, projectId])

  const newCount = ticketStatuses.filter((t) => !t.isUpdate && selectedIds.has(t.id)).length
  const updateCount = ticketStatuses.filter((t) => t.isUpdate && selectedIds.has(t.id)).length

  const toggleTicket = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleAll = () => {
    if (selectedIds.size === tickets.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(tickets.map((t) => t.id)))
    }
  }

  const handleImport = async () => {
    const selected = tickets.filter((t) => selectedIds.has(t.id))
    if (selected.length === 0) return

    setImporting(true)
    try {
      const result = await window.kanban.board.importTickets(projectId, selected)
      await loadTickets(projectId)

      const parts: string[] = []
      if (result.created > 0) parts.push(`${result.created} created`)
      if (result.updated > 0) parts.push(`${result.updated} updated`)
      toast.success(`Import complete: ${parts.join(', ')}`)

      onOpenChange(false)
    } catch {
      toast.error('Failed to import tickets')
    } finally {
      setImporting(false)
    }
  }

  const columnLabel = (col?: string) => {
    switch (col) {
      case 'todo':
        return 'To Do'
      case 'in_progress':
        return 'In Progress'
      case 'review':
        return 'Review'
      case 'done':
        return 'Done'
      default:
        return 'To Do'
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Import from Hive JSON
          </DialogTitle>
        </DialogHeader>

        {/* Summary */}
        <div className="text-sm text-muted-foreground px-1">
          {selectedIds.size} of {tickets.length} tickets selected
          {(newCount > 0 || updateCount > 0) && (
            <span className="ml-1">
              ({newCount > 0 && <span className="text-green-500">{newCount} new</span>}
              {newCount > 0 && updateCount > 0 && ', '}
              {updateCount > 0 && (
                <span className="text-yellow-500">{updateCount} update{updateCount !== 1 ? 's' : ''}</span>
              )})
            </span>
          )}
        </div>

        {/* Select all */}
        <div className="flex items-center gap-2 px-1 py-1 border-b">
          <Checkbox
            checked={selectedIds.size === tickets.length}
            onCheckedChange={toggleAll}
          />
          <span className="text-xs text-muted-foreground font-medium">Select all</span>
        </div>

        {/* Ticket list */}
        <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
          {ticketStatuses.map((ticket) => (
            <label
              key={ticket.id}
              className="flex items-start gap-2 p-2 rounded hover:bg-muted cursor-pointer"
            >
              <Checkbox
                checked={selectedIds.has(ticket.id)}
                onCheckedChange={() => toggleTicket(ticket.id)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{ticket.title}</span>
                  {ticket.isUpdate ? (
                    <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500">
                      Update
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-500/15 text-green-500">
                      New
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-muted-foreground">
                    {columnLabel(ticket.column)}
                  </span>
                  {ticket.description && (
                    <span className="text-xs text-muted-foreground truncate">
                      — {ticket.description.slice(0, 80)}
                      {ticket.description.length > 80 ? '…' : ''}
                    </span>
                  )}
                </div>
              </div>
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={importing || selectedIds.size === 0}>
            {importing ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Importing…
              </>
            ) : (
              `Import ${selectedIds.size} ticket${selectedIds.size !== 1 ? 's' : ''}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
