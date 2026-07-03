import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Loader2, Link, Search, StickyNote, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useConnectionStore } from '@/stores'
import { connectionApi } from '@/api/connection-api'
import { toast } from '@/lib/toast'
import { formatRelativeTime } from '@/lib/format-utils'
import type { RecentConnectionEntry } from '@shared/types/connection'

interface RecentConnectionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RecentConnectionsDialog({
  open,
  onOpenChange
}: RecentConnectionsDialogProps): React.JSX.Element {
  const quickCreateConnection = useConnectionStore((s) => s.quickCreateConnection)

  const [entries, setEntries] = useState<RecentConnectionEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  // Inline note edit state
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [noteInput, setNoteInput] = useState('')
  const noteInputRef = useRef<HTMLInputElement>(null)
  const noteBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noteIntentionalCloseRef = useRef(false)
  const noteEditStartRef = useRef(0)

  useEffect(() => {
    if (!open) return

    setSelectedId(null)
    setIsCreating(false)
    setError(null)
    setEntries([])
    setIsLoading(true)
    setFilter('')
    setEditingNoteId(null)

    connectionApi
      .getRecentConnections()
      .then((result) => {
        if (result.success) {
          setEntries(result.entries ?? [])
        } else {
          setEntries([])
          setError(result.error || 'Failed to load recent connections')
        }
      })
      .catch((err) => {
        setEntries([])
        setError(err instanceof Error ? err.message : 'Failed to load recent connections')
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [open])

  const filteredEntries = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((entry) =>
      `${entry.projects.map((p) => p.name).join(' + ')} ${entry.note ?? ''}`
        .toLowerCase()
        .includes(q)
    )
  }, [entries, filter])

  // The Create handler resolves against `entries`, so a selected row hidden by
  // the filter would still be creatable invisibly -- drop the selection instead.
  useEffect(() => {
    if (selectedId && !filteredEntries.some((entry) => entry.id === selectedId)) {
      setSelectedId(null)
    }
  }, [filteredEntries, selectedId])

  // Focus the note input when it appears (deferred to run after the context menu closes)
  useEffect(() => {
    if (!editingNoteId) return
    requestAnimationFrame(() => {
      if (noteInputRef.current && document.activeElement !== noteInputRef.current) {
        noteInputRef.current.focus()
        noteInputRef.current.select()
      }
    })
  }, [editingNoteId])

  useEffect(() => {
    return () => {
      if (noteBlurTimerRef.current) clearTimeout(noteBlurTimerRef.current)
    }
  }, [])

  const handleCreate = useCallback(async () => {
    const entry = entries.find((e) => e.id === selectedId)
    if (!entry) return

    setIsCreating(true)
    try {
      const id = await quickCreateConnection(entry.projects)
      if (id) {
        onOpenChange(false)
      }
    } finally {
      setIsCreating(false)
    }
  }, [entries, selectedId, quickCreateConnection, onOpenChange])

  const persistNote = useCallback(async (entryId: string, raw: string | null) => {
    const normalized = raw && raw.trim() ? raw.trim() : null
    try {
      const result = await connectionApi.setRecentConnectionNote(entryId, normalized)
      if (result.success) {
        setEntries((prev) =>
          prev.map((entry) => (entry.id === entryId ? { ...entry, note: normalized } : entry))
        )
      } else {
        toast.error(result.error || 'Failed to save note')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save note')
    }
  }, [])

  const handleStartNoteEdit = useCallback((entry: RecentConnectionEntry) => {
    noteIntentionalCloseRef.current = false
    if (noteBlurTimerRef.current) clearTimeout(noteBlurTimerRef.current)
    noteEditStartRef.current = Date.now()
    setNoteInput(entry.note ?? '')
    setEditingNoteId(entry.id)
  }, [])

  const handleSaveNote = useCallback(async () => {
    if (!editingNoteId) return
    noteIntentionalCloseRef.current = true
    if (noteBlurTimerRef.current) clearTimeout(noteBlurTimerRef.current)
    try {
      await persistNote(editingNoteId, noteInput)
    } finally {
      setEditingNoteId(null)
    }
  }, [editingNoteId, noteInput, persistNote])

  const handleNoteKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      // Keep Enter/Escape inside the row edit -- Escape would otherwise close the dialog.
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        handleSaveNote()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        noteIntentionalCloseRef.current = true
        if (noteBlurTimerRef.current) clearTimeout(noteBlurTimerRef.current)
        setEditingNoteId(null)
      }
    },
    [handleSaveNote]
  )

  const handleNoteBlur = useCallback(() => {
    if (noteIntentionalCloseRef.current) {
      noteIntentionalCloseRef.current = false
      return
    }
    // The closing context menu steals focus right after the input mounts --
    // refocus instead of cancelling during that window.
    const timeSinceStart = Date.now() - noteEditStartRef.current
    if (timeSinceStart < 500) {
      setTimeout(() => {
        if (noteInputRef.current && document.activeElement !== noteInputRef.current) {
          noteInputRef.current.focus()
          noteInputRef.current.select()
        }
      }, 0)
      return
    }

    if (noteBlurTimerRef.current) clearTimeout(noteBlurTimerRef.current)
    noteBlurTimerRef.current = setTimeout(() => {
      noteBlurTimerRef.current = null
      if (document.activeElement !== noteInputRef.current) {
        setEditingNoteId(null)
      }
    }, 100)
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="recent-connections-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="h-4 w-4" />
            Recent Connections
          </DialogTitle>
          <DialogDescription>
            Recreate a connection with fresh worktrees in each project.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter by project or note..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9"
            autoFocus
            data-testid="recent-connections-filter"
          />
        </div>

        <div className="max-h-[300px] overflow-y-auto border rounded-md">
          {error ? (
            <div
              className="px-4 py-8 text-center text-sm text-destructive"
              data-testid="recent-connections-error"
            >
              {error}
            </div>
          ) : isLoading ? (
            <div
              className="flex items-center justify-center py-8"
              data-testid="recent-connections-loading"
            >
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <div
              className="px-4 py-8 text-center text-sm text-muted-foreground"
              data-testid="recent-connections-empty"
            >
              No recent connections yet. Create one by right-clicking a worktree and choosing
              Connect to…
            </div>
          ) : filteredEntries.length === 0 ? (
            <div
              className="px-4 py-8 text-center text-sm text-muted-foreground"
              data-testid="recent-connections-no-match"
            >
              No connections match your filter
            </div>
          ) : (
            <div className="py-1">
              {filteredEntries.map((entry) =>
                editingNoteId === entry.id ? (
                  <div key={entry.id} className="flex flex-col w-full px-3 py-2 text-sm text-left">
                    <input
                      ref={noteInputRef}
                      autoFocus
                      value={noteInput}
                      onChange={(e) => setNoteInput(e.target.value)}
                      onKeyDown={handleNoteKeyDown}
                      onBlur={handleNoteBlur}
                      onClick={(e) => e.stopPropagation()}
                      className="bg-background border border-border rounded px-1.5 py-0.5 text-sm w-full focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="Add a note..."
                      data-testid="recent-connection-note-input"
                    />
                    <span className="text-xs text-muted-foreground truncate">
                      {formatRelativeTime(Date.parse(entry.last_used_at))}
                    </span>
                  </div>
                ) : (
                  <ContextMenu key={entry.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        className={cn(
                          'flex flex-col w-full px-3 py-2 text-sm text-left',
                          'hover:bg-accent/50 transition-colors',
                          selectedId === entry.id && 'bg-accent/30'
                        )}
                        onClick={() => setSelectedId(entry.id)}
                        data-testid={`recent-connection-row-${entry.id}`}
                      >
                        <span className="truncate">
                          {entry.note && (
                            <span
                              className="italic text-primary"
                              data-testid={`recent-connection-note-${entry.id}`}
                            >
                              {entry.note}
                              {' — '}
                            </span>
                          )}
                          {entry.projects.map((p) => p.name).join(' + ')}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          {formatRelativeTime(Date.parse(entry.last_used_at))}
                        </span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-52">
                      <ContextMenuItem onClick={() => handleStartNoteEdit(entry)}>
                        <StickyNote className="h-4 w-4 mr-2" />
                        {entry.note ? 'Edit note' : 'Add note'}
                      </ContextMenuItem>
                      {entry.note && (
                        <ContextMenuItem onClick={() => void persistNote(entry.id, null)}>
                          <Trash2 className="h-4 w-4 mr-2" />
                          Remove note
                        </ContextMenuItem>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                )
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            onClick={handleCreate}
            disabled={!selectedId || isCreating}
            data-testid="recent-connections-create-button"
          >
            {isCreating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Link className="h-4 w-4 mr-2" />
                Create
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
