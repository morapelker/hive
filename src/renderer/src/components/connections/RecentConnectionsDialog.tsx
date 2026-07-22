import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Loader2, Link, Search, StickyNote, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { subsequenceMatch } from '@/lib/subsequence-match'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useConnectionStore, useProjectStore } from '@/stores'
import { connectionApi } from '@/api/connection-api'
import { toast } from '@/lib/toast'
import { formatRelativeTime } from '@/lib/format-utils'
import type { RecentConnectionEntry, RecentConnectionProject } from '@shared/types/connection'

interface RecentConnectionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Row id for the pinned "create from selected projects" row, which has no
// backing recent-connection entry.
const SELECTED_COMBO_ID = '__selected-projects__'

export function RecentConnectionsDialog({
  open,
  onOpenChange
}: RecentConnectionsDialogProps): React.JSX.Element {
  const quickCreateConnection = useConnectionStore((s) => s.quickCreateConnection)
  const storeProjects = useProjectStore((s) => s.projects)

  const [entries, setEntries] = useState<RecentConnectionEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set())

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
    setProjectFilter('')
    setSelectedProjectIds(new Set())
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

  // Every project in the app (current name/path wins), plus any project that only
  // survives inside a recent connection entry (e.g. since removed from the app) --
  // so brand-new combinations are creatable, not just previously-used ones.
  const allProjects = useMemo(() => {
    const byId = new Map<string, RecentConnectionProject>()
    for (const project of storeProjects) {
      byId.set(project.id, { id: project.id, name: project.name, path: project.path })
    }
    for (const entry of entries) {
      for (const project of entry.projects) {
        if (!byId.has(project.id)) byId.set(project.id, project)
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [storeProjects, entries])

  // Same fuzzy matching + ranking as the sidebar project filter
  const filteredProjects = useMemo(() => {
    const q = projectFilter.trim()
    if (!q) return allProjects
    return allProjects
      .map((project) => ({
        project,
        nameMatch: subsequenceMatch(q, project.name),
        pathMatch: subsequenceMatch(q, project.path)
      }))
      .filter(({ nameMatch, pathMatch }) => nameMatch.matched || pathMatch.matched)
      .sort((a, b) => {
        const aScore = a.nameMatch.matched ? a.nameMatch.score : a.pathMatch.score + 1000
        const bScore = b.nameMatch.matched ? b.nameMatch.score : b.pathMatch.score + 1000
        return aScore - bScore
      })
      .map(({ project }) => project)
  }, [allProjects, projectFilter])

  const selectedProjects = useMemo(
    () => allProjects.filter((p) => selectedProjectIds.has(p.id)),
    [allProjects, selectedProjectIds]
  )

  const toggleProject = useCallback((projectId: string) => {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  const filteredEntries = useMemo(() => {
    let result = entries
    if (selectedProjectIds.size > 0) {
      result = result.filter((entry) => {
        const memberIds = new Set(entry.projects.map((p) => p.id))
        return Array.from(selectedProjectIds).every((id) => memberIds.has(id))
      })
    }
    const q = filter.trim().toLowerCase()
    if (!q) return result
    return result.filter((entry) =>
      `${entry.projects.map((p) => p.name).join(' + ')} ${entry.note ?? ''}`
        .toLowerCase()
        .includes(q)
    )
  }, [entries, filter, selectedProjectIds])

  // The recent connection whose project set is exactly the selection, if any
  const exactSelectionEntry = useMemo(() => {
    if (selectedProjects.length < 2) return null
    return (
      entries.find(
        (entry) =>
          entry.projects.length === selectedProjects.length &&
          entry.projects.every((p) => selectedProjectIds.has(p.id))
      ) ?? null
    )
  }, [entries, selectedProjects, selectedProjectIds])

  // With 2+ projects selected, the first row is always exactly that combination:
  // the matching recent entry pinned to the top (exempt from the text filter),
  // or a synthetic row that creates a brand-new connection from the selection.
  const showSelectionRow = selectedProjects.length >= 2 && !exactSelectionEntry

  const displayEntries = useMemo(() => {
    if (!exactSelectionEntry) return filteredEntries
    return [
      exactSelectionEntry,
      ...filteredEntries.filter((entry) => entry.id !== exactSelectionEntry.id)
    ]
  }, [filteredEntries, exactSelectionEntry])

  // The Create handler resolves against `entries`, so a selected row hidden by
  // the filter would still be creatable invisibly -- drop the selection instead.
  useEffect(() => {
    if (!selectedId) return
    if (selectedId === SELECTED_COMBO_ID) {
      if (!showSelectionRow) setSelectedId(null)
      return
    }
    if (!displayEntries.some((entry) => entry.id === selectedId)) {
      setSelectedId(null)
    }
  }, [displayEntries, selectedId, showSelectionRow])

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
    const projects =
      selectedId === SELECTED_COMBO_ID
        ? selectedProjects
        : entries.find((e) => e.id === selectedId)?.projects
    if (!projects || projects.length === 0) return

    setIsCreating(true)
    try {
      const id = await quickCreateConnection(projects)
      if (id) {
        onOpenChange(false)
      }
    } finally {
      setIsCreating(false)
    }
  }, [entries, selectedId, selectedProjects, quickCreateConnection, onOpenChange])

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

  // With projects selected, the selection chips already say what's common to
  // every row -- only the remaining (unselected) projects are worth showing.
  const renderProjectsLabel = (entry: RecentConnectionEntry): React.ReactNode => {
    if (selectedProjectIds.size === 0) {
      return entry.projects.map((p) => p.name).join(' + ')
    }
    const remaining = entry.projects.filter((p) => !selectedProjectIds.has(p.id))
    if (remaining.length === 0) {
      return <span className="italic text-muted-foreground">selected projects only</span>
    }
    return `+ ${remaining.map((p) => p.name).join(' + ')}`
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="recent-connections-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="h-4 w-4" />
            Recent Connections
          </DialogTitle>
          <DialogDescription>
            Recreate a connection with fresh worktrees in each project.
          </DialogDescription>
        </DialogHeader>

        {selectedProjects.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5"
            data-testid="recent-connections-selected-projects"
          >
            {selectedProjects.map((project) => (
              <button
                key={project.id}
                onClick={() => toggleProject(project.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border border-border',
                  'bg-accent/40 px-2 py-0.5 text-xs hover:bg-accent transition-colors'
                )}
                title="Remove from filter"
                data-testid={`recent-connections-selected-chip-${project.id}`}
              >
                {project.name}
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            ))}
            <button
              onClick={() => setSelectedProjectIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
              data-testid="recent-connections-clear-selection"
            >
              Clear
            </button>
          </div>
        )}

        {/* min-w-0: as a grid item of DialogContent this row would otherwise
            size to its content's min-width and overflow the dialog */}
        <div className="flex min-w-0 gap-3">
          {/* Project filter panel */}
          <div className="flex w-56 shrink-0 flex-col gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter projects..."
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="pl-9"
                data-testid="recent-connections-project-filter"
              />
            </div>
            <div
              className="h-[340px] overflow-y-auto border rounded-md"
              data-testid="recent-connections-project-list"
            >
              {allProjects.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No projects yet
                </div>
              ) : filteredProjects.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No projects match your filter
                </div>
              ) : (
                <div className="py-1">
                  {filteredProjects.map((project) => (
                    <label
                      key={project.id}
                      className={cn(
                        'flex items-center gap-2.5 w-full px-3 py-1.5 text-sm cursor-pointer',
                        'hover:bg-accent/50 transition-colors',
                        selectedProjectIds.has(project.id) && 'bg-accent/30'
                      )}
                      data-testid={`recent-connections-project-option-${project.id}`}
                    >
                      <Checkbox
                        checked={selectedProjectIds.has(project.id)}
                        onCheckedChange={() => toggleProject(project.id)}
                        data-testid={`recent-connections-project-checkbox-${project.id}`}
                      />
                      <span className="truncate">{project.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Connection list */}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
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

            <div className="h-[340px] overflow-y-auto border rounded-md">
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
              ) : entries.length === 0 && !showSelectionRow ? (
                <div
                  className="px-4 py-8 text-center text-sm text-muted-foreground"
                  data-testid="recent-connections-empty"
                >
                  No recent connections yet. Select two or more projects on the left to create one.
                </div>
              ) : displayEntries.length === 0 && !showSelectionRow ? (
                <div
                  className="px-4 py-8 text-center text-sm text-muted-foreground"
                  data-testid="recent-connections-no-match"
                >
                  No connections match your filter
                </div>
              ) : (
                <div className="py-1">
                  {showSelectionRow && (
                    <button
                      className={cn(
                        'flex flex-col w-full px-3 py-2 text-sm text-left',
                        'bg-primary/10 hover:bg-primary/15 transition-colors',
                        selectedId === SELECTED_COMBO_ID && 'bg-primary/20'
                      )}
                      onClick={() => setSelectedId(SELECTED_COMBO_ID)}
                      data-testid="recent-connection-row-selected-combo"
                    >
                      <span className="truncate">
                        {selectedProjects.map((p) => p.name).join(' + ')}
                      </span>
                      <span className="text-xs text-muted-foreground truncate">
                        New connection from selected projects
                      </span>
                    </button>
                  )}
                  {displayEntries.map((entry) =>
                    editingNoteId === entry.id ? (
                      <div
                        key={entry.id}
                        className="flex flex-col w-full px-3 py-2 text-sm text-left"
                      >
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
                              selectedId === entry.id && 'bg-accent/30',
                              // The pinned exact-selection entry is special in the
                              // same way as the synthetic row -- tint it to match
                              entry.id === exactSelectionEntry?.id &&
                                (selectedId === entry.id
                                  ? 'bg-primary/20 hover:bg-primary/20'
                                  : 'bg-primary/10 hover:bg-primary/15')
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
                              {renderProjectsLabel(entry)}
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
          </div>
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
