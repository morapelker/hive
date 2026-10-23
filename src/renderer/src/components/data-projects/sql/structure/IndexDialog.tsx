// "New index" of the structure editor: name (suggested from the table and columns until edited),
// columns in click order (MySQL / MariaDB: optional prefix length each), UNIQUE, the PostgreSQL
// access method, or for ClickHouse a data-skipping index (expression, type, granularity). The
// statement it will run is previewed live, planned exactly as Apply will plan it. Nothing runs
// here: the index is staged with the other structure changes.

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { SqlText } from '../../shared/SqlText'
import {
  columnChoices,
  indexPreview,
  nextStructureId,
  suggestIndexName,
  type ColumnKey,
  type IndexDraft,
  type StagedStructure,
  type StructureModel
} from './structure-model'

const SKIP_TYPES: readonly string[] = [
  'minmax',
  'set(100)',
  'bloom_filter',
  'bloom_filter(0.01)',
  'tokenbf_v1(32768, 3, 0)',
  'ngrambf_v1(3, 32768, 3, 0)'
]

const fieldClass =
  'h-7 w-full rounded-md border border-input bg-transparent px-2 font-mono text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

export interface IndexDialogProps {
  model: StructureModel
  staged: StagedStructure
  /** The staged index being edited; null for a new one. */
  initial: IndexDraft | null
  onSave: (draft: IndexDraft) => void
  onClose: () => void
}

export function IndexDialog({
  model,
  staged,
  initial,
  onSave,
  onClose
}: IndexDialogProps): React.JSX.Element {
  const { caps, dialect } = model
  const [draft, setDraft] = useState<IndexDraft>(
    () =>
      initial ?? {
        id: nextStructureId('i'),
        name: '',
        columns: [],
        unique: false,
        ...(caps.indexMethods ? { method: 'btree' } : {}),
        ...(caps.skippingIndexes ? { skipType: 'minmax', granularity: 1 } : {})
      }
  )
  const [nameTouched, setNameTouched] = useState(!!initial)
  const choices = useMemo(
    () => columnChoices(staged, model).filter((c) => !c.dropped),
    [staged, model]
  )
  const nameOf = (key: ColumnKey): string => choices.find((c) => c.key === key)?.name ?? '?'

  // The suggested name follows the columns until the user types one.
  useEffect(() => {
    if (nameTouched) return
    const names = draft.columns.map((c) => choices.find((x) => x.key === c.key)?.name ?? '')
    setDraft((d) => ({ ...d, name: names.length ? suggestIndexName(model, names, d.unique) : '' }))
  }, [draft.columns, draft.unique, nameTouched, choices, model])

  const toggleColumn = (key: ColumnKey): void =>
    setDraft((d) => ({
      ...d,
      columns: d.columns.some((c) => c.key === key)
        ? d.columns.filter((c) => c.key !== key)
        : [...d.columns, { key }]
    }))
  const setLength = (key: ColumnKey, text: string): void => {
    const n = Number.parseInt(text, 10)
    setDraft((d) => ({
      ...d,
      columns: d.columns.map((c) =>
        c.key === key ? { key, ...(Number.isFinite(n) && n > 0 ? { length: n } : {}) } : c
      )
    }))
  }

  const preview = useMemo(() => indexPreview(model, staged, draft), [model, staged, draft])
  const errors = preview.issues.filter((i) => i.level === 'error')
  const save = (): void => {
    if (errors.length) return
    onSave({ ...draft, name: draft.name.trim() })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] max-w-lg flex-col gap-3"
        data-testid="data-project-structure-index-dialog"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            save()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {initial ? 'Edit new index' : 'New index'}
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            {caps.skippingIndexes
              ? 'A data-skipping index. It covers parts written from now on; MATERIALIZE INDEX in a query tab builds it for existing parts.'
              : 'Staged with the other structure changes: nothing runs until you apply them.'}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto text-[12px]">
          <label className="block space-y-1">
            <span className="text-muted-foreground">Name</span>
            <input
              value={draft.name}
              onChange={(e) => {
                setNameTouched(true)
                setDraft((d) => ({ ...d, name: e.target.value }))
              }}
              autoFocus
              spellCheck={false}
              className={fieldClass}
              data-testid="data-project-structure-index-name"
            />
          </label>
          <div className="space-y-1">
            <span className="text-muted-foreground">
              Columns{caps.skippingIndexes ? ' (or an expression below)' : ''}
            </span>
            <div
              className="flex flex-wrap gap-1"
              data-testid="data-project-structure-index-columns"
            >
              {choices.map((c) => {
                const at = draft.columns.findIndex((x) => x.key === c.key)
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => toggleColumn(c.key)}
                    className={cn(
                      'flex h-6 items-center gap-1 rounded-md border px-2 font-mono text-[12px] transition-colors',
                      at >= 0
                        ? 'border-primary/60 bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                    aria-pressed={at >= 0}
                    data-testid={`data-project-structure-index-column-${c.name}`}
                  >
                    {at >= 0 && (
                      <span className="rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
                        {at + 1}
                      </span>
                    )}
                    {c.name}
                    {c.isNew && <span className="text-[10px] text-emerald-600">new</span>}
                  </button>
                )
              })}
            </div>
            {caps.prefixLengths && draft.columns.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-muted-foreground">Prefix length</span>
                {draft.columns.map((c) => (
                  <label key={c.key} className="flex items-center gap-1 font-mono">
                    {nameOf(c.key)}
                    <input
                      value={c.length ? String(c.length) : ''}
                      onChange={(e) => setLength(c.key, e.target.value.replace(/[^\d]/g, ''))}
                      placeholder="all"
                      inputMode="numeric"
                      className={cn(fieldClass, 'h-6 w-14')}
                      title="Index only the first N characters (needed for TEXT / BLOB columns)"
                      data-testid={`data-project-structure-index-length-${nameOf(c.key)}`}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
          {caps.skippingIndexes ? (
            <>
              <label className="block space-y-1">
                <span className="text-muted-foreground">Expression</span>
                <input
                  value={draft.expression ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, expression: e.target.value }))}
                  placeholder={
                    draft.columns.length > 1
                      ? `(${draft.columns.map((c) => nameOf(c.key)).join(', ')})`
                      : draft.columns.length
                        ? nameOf(draft.columns[0].key)
                        : 'lower(name)'
                  }
                  spellCheck={false}
                  className={fieldClass}
                  data-testid="data-project-structure-index-expression"
                />
              </label>
              <div className="flex gap-2">
                <label className="block flex-1 space-y-1">
                  <span className="text-muted-foreground">Type</span>
                  <div className="relative">
                    <input
                      value={draft.skipType ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, skipType: e.target.value }))}
                      spellCheck={false}
                      className={cn(fieldClass, 'pr-7')}
                      data-testid="data-project-structure-index-skip-type"
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label="Index types"
                          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {SKIP_TYPES.map((t) => (
                          <DropdownMenuItem
                            key={t}
                            className="font-mono text-[12px]"
                            onSelect={() => setDraft((d) => ({ ...d, skipType: t }))}
                          >
                            {t}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </label>
                <label className="block w-28 space-y-1">
                  <span className="text-muted-foreground">Granularity</span>
                  <input
                    value={String(draft.granularity ?? '')}
                    onChange={(e) => {
                      const n = Number.parseInt(e.target.value.replace(/[^\d]/g, ''), 10)
                      setDraft((d) => ({ ...d, granularity: Number.isFinite(n) ? n : 0 }))
                    }}
                    inputMode="numeric"
                    className={fieldClass}
                    data-testid="data-project-structure-index-granularity"
                  />
                </label>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={draft.unique}
                  onCheckedChange={(unique) => setDraft((d) => ({ ...d, unique }))}
                  data-testid="data-project-structure-index-unique"
                />
                Unique
              </label>
              {caps.indexMethods && (
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">Method</span>
                  <select
                    value={draft.method ?? 'btree'}
                    onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value }))}
                    className="h-7 rounded-md border border-input bg-background px-1.5 text-[12px]"
                    data-testid="data-project-structure-index-method"
                  >
                    {caps.indexMethods.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <div className="rounded-md border border-border bg-muted/40 p-2">
            {preview.sql ? (
              <SqlText
                text={`${preview.sql};`}
                dialect={dialect}
                data-testid="data-project-structure-index-preview"
              />
            ) : (
              <span className="text-muted-foreground">Pick the columns to index.</span>
            )}
          </div>
          {preview.issues.length > 0 && (nameTouched || draft.columns.length > 0) && (
            <ul className="space-y-0.5" data-testid="data-project-structure-index-issues">
              {preview.issues.map((issue, i) => (
                <li
                  key={i}
                  className={cn(
                    'flex items-start gap-1',
                    issue.level === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-amber-700 dark:text-amber-300'
                  )}
                >
                  <X className="mt-0.5 h-3 w-3 shrink-0" />
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={errors.length > 0}
            onClick={save}
            data-testid="data-project-structure-index-save"
          >
            {initial ? 'Update index' : 'Add index'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
