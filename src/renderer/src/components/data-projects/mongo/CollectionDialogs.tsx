// Create collection (standard / capped / time-series / clustered, default collation, or a raw
// options document) and Rename collection, from the explorer's context menus. Both validate the
// name locally first, then go through the safe-mode gate (`dataProjects.mongo.collection`).
// A new database is created by creating its first collection (MongoDB has no empty databases).

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { MongoCodeEditor, escapeClosesCompletionFirst } from './MongoCodeEditor'
import { runGated } from './mongo-ui'
import {
  EMPTY_COLLECTION_FORM,
  buildCollectionOptionsText,
  validateCollectionName,
  validateDatabaseName,
  type CollectionKind,
  type CreateCollectionForm
} from './requests'

const KINDS: Array<{ value: CollectionKind; label: string; hint: string }> = [
  { value: 'standard', label: 'Standard', hint: 'A regular collection' },
  { value: 'capped', label: 'Capped', hint: 'Fixed size, oldest documents roll off' },
  { value: 'timeseries', label: 'Time series', hint: 'Measurements over time (MongoDB 5.0+)' },
  { value: 'clustered', label: 'Clustered', hint: 'Stored in _id order (MongoDB 5.3+)' }
]

const label = 'text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground'

export interface CreateCollectionRequest {
  /** Pre-filled database; editable when `newDatabase`. */
  database: string
  newDatabase?: boolean
}

export function CreateCollectionDialog({
  request,
  project,
  onClose,
  onCreated
}: {
  request: CreateCollectionRequest | null
  project: DataProject
  onClose: () => void
  onCreated: (database: string, collection: string) => void
}): React.JSX.Element {
  const [form, setForm] = useState<CreateCollectionForm>({ ...EMPTY_COLLECTION_FORM })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (request) {
      setForm({ ...EMPTY_COLLECTION_FORM, database: request.database })
      setShowAdvanced(false)
      setError(null)
      setBusy(false)
    }
  }, [request])
  const set = (patch: Partial<CreateCollectionForm>): void => {
    setForm((f) => ({ ...f, ...patch }))
    if (error) setError(null)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    const database = form.database.trim()
    const name = form.name.trim()
    const problem = validateDatabaseName(database) ?? validateCollectionName(name)
    if (problem) {
      setError(problem)
      return
    }
    const options = buildCollectionOptionsText(form)
    if (!options.ok) {
      setError(options.error)
      return
    }
    setBusy(true)
    const outcome = await runGated(
      project,
      (confirmToken) =>
        dataProjectsApi.mongo.collection({
          dataProjectId: project.id,
          database,
          action: {
            kind: 'create',
            collection: name,
            ...(options.text ? { options: options.text } : {})
          },
          ...(confirmToken ? { confirmToken } : {})
        }),
      'Could not create the collection'
    )
    setBusy(false)
    switch (outcome.kind) {
      case 'ok':
        toast.success(`Created ${database}.${name}`)
        onCreated(database, name)
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

  const field = (
    key: keyof CreateCollectionForm,
    text: string,
    placeholder: string,
    mono = true
  ): React.JSX.Element => (
    <label className="space-y-1">
      <span className={label}>{text}</span>
      <Input
        value={form[key] as string}
        onChange={(e) => set({ [key]: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
        placeholder={placeholder}
        className={cn('h-8 text-[12px]', mono && 'font-mono')}
        data-testid={`data-project-mongo-create-collection-${key}`}
      />
    </label>
  )

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] max-w-lg flex-col gap-3 overflow-y-auto"
        onEscapeKeyDown={escapeClosesCompletionFirst}
        data-testid="data-project-mongo-create-collection"
      >
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {request?.newDatabase ? 'Create database' : 'Create collection'}
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            {request?.newDatabase
              ? 'A database exists once it has a collection: name both.'
              : `In database ${request?.database ?? ''}`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {request?.newDatabase ? field('database', 'Database', 'analytics') : null}
          <div className={request?.newDatabase ? '' : 'col-span-2'}>
            {field('name', 'Collection', 'events')}
          </div>
        </div>
        {!showAdvanced && (
          <>
            <div className="space-y-1">
              <span className={label}>Type</span>
              <div className="grid grid-cols-2 gap-1.5">
                {KINDS.map((k) => (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => set({ kind: k.value })}
                    className={cn(
                      'rounded-[6px] border px-2.5 py-1.5 text-left text-[12px] transition-colors',
                      form.kind === k.value
                        ? 'border-ring bg-accent/60'
                        : 'border-border hover:bg-accent/30'
                    )}
                    data-testid={`data-project-mongo-create-collection-kind-${k.value}`}
                  >
                    <div className="font-medium">{k.label}</div>
                    <div className="text-muted-foreground">{k.hint}</div>
                  </button>
                ))}
              </div>
            </div>
            {form.kind === 'capped' && (
              <div className="grid grid-cols-2 gap-2">
                {field('cappedSize', 'Size (bytes)', '1048576')}
                {field('cappedMax', 'Max documents', 'optional')}
              </div>
            )}
            {form.kind === 'timeseries' && (
              <div className="grid grid-cols-2 gap-2">
                {field('timeField', 'Time field', 'timestamp')}
                {field('metaField', 'Meta field', 'optional')}
                <label className="space-y-1">
                  <span className={label}>Granularity</span>
                  <select
                    value={form.granularity}
                    onChange={(e) =>
                      set({ granularity: e.target.value as CreateCollectionForm['granularity'] })
                    }
                    className="h-8 w-full rounded-[6px] border border-input bg-background px-2 text-[12px] dark:bg-input/30"
                    data-testid="data-project-mongo-create-collection-granularity"
                  >
                    <option value="">Default (seconds)</option>
                    <option value="seconds">seconds</option>
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                  </select>
                </label>
                {field('expireAfterSeconds', 'Expire after (s)', 'optional')}
              </div>
            )}
            {form.kind === 'clustered' &&
              field('expireAfterSeconds', 'Expire after (s)', 'optional')}
            {field('collationLocale', 'Default collation locale', "optional, e.g. 'en'")}
          </>
        )}
        {showAdvanced && (
          <div className="space-y-1">
            <span className={label}>Options document</span>
            <MongoCodeEditor
              value={form.advanced}
              onChange={(advanced) => set({ advanced })}
              onSubmit={() => void submit()}
              placeholder="{ validator: { $jsonSchema: { … } }, validationLevel: 'moderate' }"
              minHeight={120}
              maxHeight={320}
              completionPrefix="db.createCollection('x', "
              aria-label="Collection options"
              data-testid="data-project-mongo-create-collection-advanced"
            />
          </div>
        )}
        <button
          type="button"
          className="self-start text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => {
            setShowAdvanced((v) => !v)
            set({ advanced: '' })
          }}
          data-testid="data-project-mongo-create-collection-advanced-toggle"
        >
          {showAdvanced
            ? 'Use the form instead'
            : 'Write the options document (validator, clusteredIndex…)'}
        </button>
        {error && (
          <p
            className="whitespace-pre-wrap text-[12px] text-destructive"
            data-testid="data-project-mongo-create-collection-error"
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
            data-testid="data-project-mongo-create-collection-submit"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface RenameCollectionRequest {
  database: string
  collection: string
}

export function RenameCollectionDialog({
  request,
  project,
  onClose,
  onRenamed
}: {
  request: RenameCollectionRequest | null
  project: DataProject
  onClose: () => void
  onRenamed: (database: string, from: string, to: string) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (request) {
      setName(request.collection)
      setError(null)
      setBusy(false)
    }
  }, [request])

  const submit = async (): Promise<void> => {
    if (!request || busy) return
    const to = name.trim()
    const problem = validateCollectionName(to)
    if (problem) {
      setError(problem)
      return
    }
    if (to === request.collection) {
      onClose()
      return
    }
    setBusy(true)
    const outcome = await runGated(
      project,
      (confirmToken) =>
        dataProjectsApi.mongo.collection({
          dataProjectId: project.id,
          database: request.database,
          action: { kind: 'rename', collection: request.collection, to },
          ...(confirmToken ? { confirmToken } : {})
        }),
      'Could not rename the collection'
    )
    setBusy(false)
    switch (outcome.kind) {
      case 'ok':
        toast.success(`Renamed to ${to}`)
        onRenamed(request.database, request.collection, to)
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

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-md" data-testid="data-project-mongo-rename-collection">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Rename collection</DialogTitle>
          <DialogDescription className="text-[12px]">
            {request?.database}.{request?.collection} — fails if a collection with the new name
            exists.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          className="font-mono text-[12px]"
          spellCheck={false}
          data-testid="data-project-mongo-rename-collection-input"
        />
        {error && <p className="whitespace-pre-wrap text-[12px] text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy}
            data-testid="data-project-mongo-rename-collection-submit"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
