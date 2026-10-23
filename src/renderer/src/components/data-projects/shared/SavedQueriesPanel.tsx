// Saved queries of a data project: filter, open (into the editor via `onOpen`, never run),
// rename inline, delete (confirmed). Also exports SaveQueryDialog (name prompt used by the query
// tab's Save / ⌘S and by the Mongo shell).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, Loader2, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { DataSavedQuery, SqlDialect } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from './format-utils'
import { SqlText } from './SqlText'

export interface SavedQueriesPanelProps {
  projectId: string
  onOpen: (query: DataSavedQuery) => void
  dialect?: SqlDialect | null
  /** Change it to refetch (after a save elsewhere). */
  refreshKey?: number
  className?: string
}

export function SavedQueriesPanel({
  projectId,
  onOpen,
  dialect = null,
  refreshKey = 0,
  className
}: SavedQueriesPanelProps): React.JSX.Element {
  const [queries, setQueries] = useState<DataSavedQuery[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<DataSavedQuery | null>(null)
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const list = await dataProjectsApi.savedQueries(projectId)
      if (seq !== seqRef.current) return
      setQueries(list)
      setError(null)
    } catch (err) {
      if (seq === seqRef.current) setError(errorMessage(err, 'Could not load saved queries'))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const visible = useMemo(() => {
    const n = filter.trim().toLowerCase()
    const list = [...(queries ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return n
      ? list.filter((q) => q.name.toLowerCase().includes(n) || q.text.toLowerCase().includes(n))
      : list
  }, [queries, filter])

  const rename = async (): Promise<void> => {
    if (!renaming) return
    const query = queries?.find((q) => q.id === renaming.id)
    const name = renaming.name.trim()
    setRenaming(null)
    if (!query || !name || name === query.name) return
    try {
      const saved = await dataProjectsApi.saveQuery(projectId, {
        id: query.id,
        name,
        text: query.text,
        database: query.database
      })
      setQueries((list) => list?.map((q) => (q.id === saved.id ? saved : q)) ?? null)
    } catch (err) {
      toast.error(`Could not rename: ${errorMessage(err)}`)
    }
  }

  const remove = async (): Promise<void> => {
    if (!deleting) return
    const target = deleting
    setDeleting(null)
    try {
      await dataProjectsApi.deleteSavedQuery(projectId, target.id)
      setQueries((list) => list?.filter((q) => q.id !== target.id) ?? null)
      toast.success(`Deleted "${target.name}"`)
    } catch (err) {
      toast.error(`Could not delete: ${errorMessage(err)}`)
    }
  }

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col', className)}
      data-testid="data-project-saved-queries"
    >
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <div className="relative min-w-[120px] max-w-72 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter saved queries…"
            data-testid="data-project-saved-filter"
            className="h-7 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={() => void load()}
          title="Refresh"
          data-testid="data-project-saved-refresh"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {error && (
        <div className="shrink-0 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {queries === null && !error ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : visible.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground"
            data-testid="data-project-saved-empty"
          >
            <Bookmark className="h-8 w-8 opacity-50" />
            {filter
              ? 'No matching saved queries'
              : 'No saved queries yet. Save a query tab with ⌘S.'}
          </div>
        ) : (
          <ul>
            {visible.map((q) => (
              <li
                key={q.id}
                className="group border-b border-border/60 px-3 py-2 hover:bg-accent/40"
                data-testid={`data-project-saved-${q.id}`}
              >
                <div className="flex items-center gap-2">
                  {renaming?.id === q.id ? (
                    <Input
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: q.id, name: e.target.value })}
                      onBlur={() => void rename()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void rename()
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                      className="h-6 text-[12px]"
                      data-testid={`data-project-saved-rename-input-${q.id}`}
                    />
                  ) : (
                    <button
                      type="button"
                      className="truncate text-left text-[13px] font-medium hover:underline"
                      onClick={() => onOpen(q)}
                      data-testid={`data-project-saved-open-${q.id}`}
                    >
                      {q.name}
                    </button>
                  )}
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {q.database ? `${q.database} · ` : ''}
                    {formatRelativeTime(q.updatedAt)}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Rename"
                      onClick={() => setRenaming({ id: q.id, name: q.name })}
                      data-testid={`data-project-saved-rename-${q.id}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Delete"
                      onClick={() => setDeleting(q)}
                      data-testid={`data-project-saved-delete-${q.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <button
                  type="button"
                  className="mt-1 block w-full text-left"
                  onClick={() => onOpen(q)}
                  tabIndex={-1}
                >
                  <SqlText
                    text={q.text.length > 400 ? `${q.text.slice(0, 400)}…` : q.text}
                    dialect={dialect}
                    className="line-clamp-3 text-muted-foreground"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]">
              The saved query is removed. Open tabs keep their text.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault()
                void remove()
              }}
              data-testid="data-project-saved-delete-confirm"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Name prompt for saving a query (new or renamed). */
export function SaveQueryDialog({
  open,
  onOpenChange,
  initialName,
  onSave,
  updating
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialName: string
  onSave: (name: string) => Promise<void> | void
  /** True when the tab is linked to an existing saved query (Save updates it). */
  updating?: boolean
}): React.JSX.Element {
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setName(initialName)
  }, [open, initialName])
  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await onSave(name.trim())
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="data-project-save-query-dialog">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {updating ? 'Update saved query' : 'Save query'}
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            Saved queries are stored with this connection.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          placeholder="Daily revenue"
          data-testid="data-project-save-query-name"
        />
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
            data-testid="data-project-save-query-confirm"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
