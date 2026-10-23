// "Update matching…" / "Delete matching…" from the Documents tab: the filter and collation of
// the query bar, the number of documents they match (counted first — reusing the last Find's
// count when filter and collation are unchanged), and for updates an update-document editor
// ($set…, or a pipeline). The collation goes with the count and the write alike, so what is
// counted (and was shown) is what is written: without it `{ v: { $gt: '10' } }` under
// numericOrdering would compare binary strings and also hit '9'. The write goes through the
// safe-mode gate; an empty filter is flagged red, and the production typed confirmation is the
// gate's job.

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { DataProject } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { HighlightedCode } from './DocumentResults'
import type { MongoCompletionData } from './mongo-completion'
import { MongoCodeEditor, escapeClosesCompletionFirst } from './MongoCodeEditor'
import { formatCount, mongoErrorText, newQueryId, runGated } from './mongo-ui'

export interface BulkState {
  kind: 'update' | 'delete'
  /** Filter text of the query bar ('' = every document). */
  filter: string
  /** Collation text of the query bar ('' = none): string comparisons of the filter use it. */
  collation: string
  /** Count from the last Find with this very filter and collation, when known. */
  knownCount: number | null
}

export const DEFAULT_UPDATE_TEXT = '{\n  $set: {\n    \n  }\n}'

const COUNT_TIMEOUT_MS = 15_000

export function BulkDialog({
  state,
  project,
  database,
  collection,
  completionData,
  onClose,
  onDone
}: {
  state: BulkState | null
  project: DataProject
  database: string
  collection: string
  completionData?: () => MongoCompletionData
  onClose: () => void
  /** After a successful write (refresh the page). */
  onDone: () => void
}): React.JSX.Element {
  const [count, setCount] = useState<number | null>(null)
  const [counting, setCounting] = useState(false)
  const [countError, setCountError] = useState<string | null>(null)
  const [update, setUpdate] = useState(DEFAULT_UPDATE_TEXT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const countId = useRef<string | null>(null)

  useEffect(() => {
    setError(null)
    setBusy(false)
    setCountError(null)
    if (!state) {
      if (countId.current) void dataProjectsApi.cancel(countId.current).catch(() => undefined)
      countId.current = null
      return
    }
    if (state.knownCount !== null) {
      setCount(state.knownCount)
      setCounting(false)
      return
    }
    const queryId = newQueryId()
    countId.current = queryId
    setCount(null)
    setCounting(true)
    dataProjectsApi.mongo
      .find({
        dataProjectId: project.id,
        queryId,
        database,
        collection,
        ...(state.filter.trim() ? { filter: state.filter.trim() } : {}),
        ...(state.collation.trim() ? { collation: state.collation.trim() } : {}),
        limit: 1,
        withCount: true,
        maxTimeMS: COUNT_TIMEOUT_MS
      })
      .then((res) => {
        if (countId.current !== queryId) return
        setCount(res.count)
        if (res.count === null)
          setCountError('Counting took too long; the number of matching documents is unknown')
      })
      .catch((e) => {
        if (countId.current === queryId)
          setCountError(mongoErrorText(project, e, 'Could not count the matching documents'))
      })
      .finally(() => {
        if (countId.current === queryId) setCounting(false)
      })
  }, [state, project, database, collection])

  const isUpdate = state?.kind === 'update'
  const emptyFilter = !!state && (!state.filter.trim() || state.filter.replace(/\s+/g, '') === '{}')
  const n = count === null ? 'the matching' : formatCount(count)

  const run = async (): Promise<void> => {
    if (!state || busy) return
    if (isUpdate && !update.trim()) {
      setError('Enter an update document such as { $set: { status: "done" } }')
      return
    }
    setBusy(true)
    setError(null)
    const filter = state.filter.trim() || '{}'
    const collation = state.collation.trim()
    const outcome = await runGated(
      project,
      (confirmToken) =>
        dataProjectsApi.mongo.write({
          dataProjectId: project.id,
          database,
          collection,
          op: isUpdate ? 'updateMany' : 'deleteMany',
          filter,
          ...(collation ? { collation } : {}),
          ...(isUpdate ? { update: update.trim() } : {}),
          ...(confirmToken ? { confirmToken } : {})
        }),
      isUpdate ? 'The update failed' : 'The delete failed'
    )
    setBusy(false)
    switch (outcome.kind) {
      case 'ok': {
        const r = outcome.response
        toast.success(
          isUpdate
            ? `Matched ${formatCount(r.matchedCount ?? 0)}, modified ${formatCount(r.modifiedCount ?? 0)} documents`
            : `Deleted ${formatCount(r.deletedCount ?? 0)} documents`
        )
        onDone()
        onClose()
        break
      }
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

  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] max-w-2xl flex-col gap-3"
        onEscapeKeyDown={escapeClosesCompletionFirst}
        data-testid="data-project-mongo-bulk"
      >
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {isUpdate ? 'Update matching documents' : 'Delete matching documents'}
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            {database}.{collection} · {isUpdate ? 'updateMany' : 'deleteMany'} with the filter
            {state?.collation.trim() ? ' and collation' : ''} of the query bar
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Filter
          </div>
          <div className="rounded-[6px] border border-border bg-card/40 px-2.5 py-1.5">
            <HighlightedCode text={state?.filter.trim() || '{}'} />
          </div>
        </div>
        {state?.collation.trim() && (
          <div className="space-y-1" data-testid="data-project-mongo-bulk-collation">
            <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              Collation
            </div>
            <div className="rounded-[6px] border border-border bg-card/40 px-2.5 py-1.5">
              <HighlightedCode text={state.collation.trim()} />
            </div>
          </div>
        )}
        <div
          className={cn(
            'flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px]',
            emptyFilter ? 'bg-destructive/10 text-destructive' : 'bg-secondary text-foreground'
          )}
          data-testid="data-project-mongo-bulk-count"
        >
          {counting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Counting matching documents…
            </>
          ) : countError ? (
            <>
              <AlertTriangle className="h-3.5 w-3.5" /> {countError}
            </>
          ) : (
            <>
              {emptyFilter && <AlertTriangle className="h-3.5 w-3.5" />}
              {isUpdate ? 'Will update' : 'Will delete'} {formatCount(count)} document
              {count === 1 ? '' : 's'}
              {emptyFilter && ' — every document in the collection'}
            </>
          )}
        </div>
        {isUpdate && (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              Update
            </div>
            <MongoCodeEditor
              value={update}
              onChange={setUpdate}
              onSubmit={() => void run()}
              minHeight={140}
              maxHeight={320}
              completionPrefix={`db.getCollection(${JSON.stringify(collection)}).updateMany({}, `}
              completionData={completionData}
              aria-label="Update document"
              data-testid="data-project-mongo-bulk-update-editor"
            />
          </div>
        )}
        {error && (
          <p
            className="whitespace-pre-wrap text-[12px] text-destructive"
            data-testid="data-project-mongo-bulk-error"
          >
            {error}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={busy}
            data-testid="data-project-mongo-bulk-cancel"
          >
            Cancel
          </Button>
          <Button
            variant={isUpdate ? 'default' : 'destructive'}
            disabled={busy || counting || count === 0}
            onClick={() => void run()}
            data-testid="data-project-mongo-bulk-submit"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {isUpdate ? `Update ${n} documents` : `Delete ${n} documents`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
