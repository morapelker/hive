// Indexes sub-tab: every index of the collection with its key spec, properties (unique, sparse,
// TTL, partial, hidden), size and usage since the server started ($indexStats); Create index
// (keys editor + name / unique / sparse / hidden / TTL / partial filter) and Drop. Both changes
// go through the safe-mode gate; Drop asks first here as well (it can make queries slow).

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { DataProject, MongoIndexInfo } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
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
import { Checkbox } from '@/components/ui/checkbox'
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
import type { MongoCollectionTab } from '@/stores/useMongoWorkspaceStore'
import { invalidateCompletionSchema, useMongoCompletionData } from './completion-data'
import { formatShellInline } from './ejson'
import { MongoCodeEditor, escapeClosesCompletionFirst } from './MongoCodeEditor'
import { formatBytes, formatCount, mongoErrorText, runGated } from './mongo-ui'
import { EMPTY_INDEX_FORM, buildCreateIndexRequest, type MongoIndexForm } from './requests'

function Badge({
  children,
  tone = 'neutral',
  title
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'warn' | 'info'
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={
        tone === 'warn'
          ? 'rounded-[4px] bg-amber-500/15 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-[0.04em] text-amber-700 dark:text-amber-300'
          : tone === 'info'
            ? 'rounded-[4px] bg-sky-500/15 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-[0.04em] text-sky-700 dark:text-sky-300'
            : 'rounded-[4px] bg-secondary px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground'
      }
    >
      {children}
    </span>
  )
}

/** Regular / compound / text / 2dsphere / hashed / wildcard from the key spec. */
function indexKind(keys: Record<string, unknown>): string | null {
  const values = Object.values(keys).map((v) => (typeof v === 'string' ? v : null))
  if (values.includes('text')) return 'text'
  if (values.includes('2dsphere')) return '2dsphere'
  if (values.includes('2d')) return '2d'
  if (values.includes('hashed')) return 'hashed'
  if (Object.keys(keys).some((k) => k.includes('$**'))) return 'wildcard'
  return Object.keys(keys).length > 1 ? 'compound' : null
}

export function IndexesView({
  project,
  tab
}: {
  project: DataProject
  tab: MongoCollectionTab
}): React.JSX.Element {
  const { database, collection } = tab
  const projectId = project.id
  const [indexes, setIndexes] = useState<MongoIndexInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [dropping, setDropping] = useState<MongoIndexInfo | null>(null)
  const [dropBusy, setDropBusy] = useState(false)
  const seq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const list = await dataProjectsApi.mongo.indexes(projectId, database, collection)
      if (mine === seq.current) setIndexes(list)
    } catch (e) {
      if (mine === seq.current)
        setError(mongoErrorText({ id: projectId }, e, 'Could not list the indexes'))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
    // The project id, not the object: a pin or safe-mode change must not re-list the indexes.
  }, [projectId, database, collection])

  useEffect(() => {
    void load()
    return () => {
      seq.current++
    }
  }, [load])

  const drop = async (): Promise<void> => {
    if (!dropping) return
    setDropBusy(true)
    const outcome = await runGated(
      project,
      (confirmToken) =>
        dataProjectsApi.mongo.dropIndex({
          dataProjectId: project.id,
          database,
          collection,
          name: dropping.name,
          ...(confirmToken ? { confirmToken } : {})
        }),
      'Could not drop the index'
    )
    setDropBusy(false)
    switch (outcome.kind) {
      case 'ok':
        toast.success(`Dropped index ${dropping.name}`)
        setDropping(null)
        invalidateCompletionSchema(project.id, database)
        void load()
        break
      case 'blocked':
        toast.error(`Blocked by the safe mode: ${outcome.reason}`)
        setDropping(null)
        break
      case 'error':
        toast.error(outcome.message)
        break
      default:
        setDropping(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-project-mongo-indexes">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          data-testid="data-project-mongo-index-create"
        >
          <Plus className="h-3.5 w-3.5" />
          Create index
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void load()}
          disabled={loading}
          title="Refresh"
          data-testid="data-project-mongo-index-refresh"
        >
          <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
        </Button>
        {indexes && (
          <span className="ml-1 text-[12px] text-muted-foreground">
            {indexes.length} index{indexes.length === 1 ? '' : 'es'}
          </span>
        )}
      </div>
      {error && (
        <div
          className="whitespace-pre-wrap border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 font-mono text-[12px] text-destructive"
          data-testid="data-project-mongo-index-error"
        >
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-3">
        {!indexes && loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading indexes…
          </div>
        )}
        {indexes && indexes.length === 0 && (
          <div className="py-12 text-center text-[13px] text-muted-foreground">No indexes.</div>
        )}
        {indexes && indexes.length > 0 && (
          <table className="w-full border-collapse text-left text-[12px]">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="border-b border-border text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">Name</th>
                <th className="py-2 pr-3 font-semibold">Keys</th>
                <th className="py-2 pr-3 font-semibold">Properties</th>
                <th className="py-2 pr-3 text-right font-semibold">Size</th>
                <th className="py-2 pr-3 text-right font-semibold">Usage</th>
                <th className="w-10 py-2" />
              </tr>
            </thead>
            <tbody>
              {indexes.map((index) => {
                const kind = indexKind(index.keys)
                return (
                  <tr
                    key={index.name}
                    className="group border-b border-border/60 hover:bg-accent/30"
                    data-testid={`data-project-mongo-index-${index.name}`}
                  >
                    <td className="py-1.5 pr-3 font-mono">{index.name}</td>
                    <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                      {formatShellInline(index.keys, 200)}
                    </td>
                    <td className="py-1.5 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {kind && <Badge>{kind}</Badge>}
                        {index.unique && <Badge tone="info">unique</Badge>}
                        {index.sparse && <Badge>sparse</Badge>}
                        {index.ttlSeconds !== null && index.ttlSeconds !== undefined && (
                          <Badge tone="info">TTL {formatCount(index.ttlSeconds)} s</Badge>
                        )}
                        {index.partialFilterExpression && (
                          <Badge title={formatShellInline(index.partialFilterExpression, 400)}>
                            partial
                          </Badge>
                        )}
                        {index.hidden && <Badge tone="warn">hidden</Badge>}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {formatBytes(index.sizeBytes)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {index.accesses === null || index.accesses === undefined
                        ? '—'
                        : formatCount(index.accesses)}
                    </td>
                    <td className="py-1.5 text-right">
                      {index.name !== '_id_' && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="opacity-0 hover:text-destructive group-hover:opacity-100"
                          onClick={() => setDropping(index)}
                          title={`Drop ${index.name}`}
                          data-testid={`data-project-mongo-index-drop-${index.name}`}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <CreateIndexDialog
        open={creating}
        project={project}
        tab={tab}
        onClose={() => setCreating(false)}
        onCreated={() => {
          invalidateCompletionSchema(project.id, database)
          void load()
        }}
      />
      <AlertDialog
        open={!!dropping}
        onOpenChange={(open) => !open && !dropBusy && setDropping(null)}
      >
        <AlertDialogContent data-testid="data-project-mongo-index-drop-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Drop index {dropping?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Queries that use it will fall back to other indexes or a collection scan
              {dropping?.unique ? ', and the uniqueness it enforces goes away' : ''}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dropBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={dropBusy}
              onClick={(e) => {
                e.preventDefault()
                void drop()
              }}
              data-testid="data-project-mongo-index-drop-confirm"
            >
              {dropBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              Drop index
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function CreateIndexDialog({
  open,
  project,
  tab,
  onClose,
  onCreated
}: {
  open: boolean
  project: DataProject
  tab: Pick<MongoCollectionTab, 'database' | 'collection'>
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<MongoIndexForm>({ ...EMPTY_INDEX_FORM })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const completionData = useMongoCompletionData(project, tab.database, tab.collection)
  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_INDEX_FORM })
      setError(null)
      setBusy(false)
    }
  }, [open])
  const set = (patch: Partial<MongoIndexForm>): void => {
    setForm((f) => ({ ...f, ...patch }))
    if (error) setError(null)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    const built = buildCreateIndexRequest(
      { dataProjectId: project.id, database: tab.database, collection: tab.collection },
      form
    )
    if (!built.ok) {
      setError(built.error)
      return
    }
    setBusy(true)
    const outcome = await runGated(
      project,
      (confirmToken) =>
        dataProjectsApi.mongo.createIndex({
          ...built.request,
          ...(confirmToken ? { confirmToken } : {})
        }),
      'Could not create the index'
    )
    setBusy(false)
    switch (outcome.kind) {
      case 'ok':
        toast.success(`Created index ${outcome.response.name ?? ''}`.trim())
        onCreated()
        onClose()
        break
      case 'blocked':
        setError(`Blocked by the safe mode: ${outcome.reason}`)
        break
      case 'error':
        setError(outcome.message)
        break
      default:
        break
    }
  }

  const check = (
    key: 'unique' | 'sparse' | 'hidden',
    label: string,
    hint: string
  ): React.JSX.Element => (
    <label className="flex items-start gap-2 text-[12px]">
      <Checkbox
        checked={form[key]}
        onCheckedChange={(checked) => set({ [key]: checked })}
        className="mt-0.5"
        data-testid={`data-project-mongo-index-form-${key}`}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-muted-foreground">{hint}</span>
      </span>
    </label>
  )

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] max-w-xl flex-col gap-3 overflow-y-auto"
        onEscapeKeyDown={escapeClosesCompletionFirst}
        data-testid="data-project-mongo-index-dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-[15px]">Create index</DialogTitle>
          <DialogDescription className="text-[12px]">
            {tab.database}.{tab.collection} · 1 / -1 for ascending / descending, or 'text',
            '2dsphere', 'hashed'.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Keys
          </div>
          <MongoCodeEditor
            value={form.keys}
            onChange={(keys) => set({ keys })}
            onSubmit={() => void submit()}
            minHeight={80}
            maxHeight={200}
            completionPrefix={`db.getCollection(${JSON.stringify(tab.collection)}).createIndex(`}
            completionData={completionData}
            aria-label="Index keys"
            data-testid="data-project-mongo-index-form-keys"
          />
        </div>
        <label className="space-y-1 text-[12px]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Name
          </span>
          <Input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Generated from the keys"
            className="h-8 font-mono text-[12px]"
            data-testid="data-project-mongo-index-form-name"
          />
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {check('unique', 'Unique', 'Reject duplicate keys')}
          {check('sparse', 'Sparse', 'Skip documents without the field')}
          {check('hidden', 'Hidden', 'Kept up to date, not used by queries')}
        </div>
        <label className="space-y-1 text-[12px]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            TTL (seconds)
          </span>
          <Input
            value={form.ttlSeconds}
            onChange={(e) => set({ ttlSeconds: e.target.value })}
            inputMode="numeric"
            placeholder="No expiry (date fields only)"
            className="h-8 w-56 font-mono text-[12px]"
            data-testid="data-project-mongo-index-form-ttl"
          />
        </label>
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Partial filter expression
          </div>
          <MongoCodeEditor
            value={form.partialFilter}
            onChange={(partialFilter) => set({ partialFilter })}
            onSubmit={() => void submit()}
            placeholder="{ status: 'active' }  (optional)"
            minHeight={40}
            maxHeight={160}
            completionPrefix={`db.getCollection(${JSON.stringify(tab.collection)}).find(`}
            completionData={completionData}
            aria-label="Partial filter expression"
            data-testid="data-project-mongo-index-form-partial"
          />
        </div>
        {form.unique && (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" />
            Building a unique index fails if existing documents already have duplicate keys.
          </div>
        )}
        {error && (
          <p
            className="whitespace-pre-wrap text-[12px] text-destructive"
            data-testid="data-project-mongo-index-form-error"
          >
            {error}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy}
            data-testid="data-project-mongo-index-form-submit"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Create index
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
