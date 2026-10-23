// Columns of the structure editor: every described column edits in place (name, type, NULL,
// default, comment; PostgreSQL also USING for a type change), new columns are rows of their own
// (green, with their position on MySQL / ClickHouse), dropped ones stay listed struck through
// until applied or undone. Locked cells keep their value and say why in the tooltip; a problem
// found by the plan outlines its cell (red = blocks Apply, amber = warning).

import { useEffect, useRef } from 'react'
import { KeyRound, RotateCcw, Trash2, X } from 'lucide-react'
import { quoteSqlIdentifier } from '@shared/sql'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { CellInput, DefaultInput, TypeInput, type CellTone } from './cells'
import {
  columnChoices,
  editedDraft,
  effectiveChange,
  literalOptions,
  newKey,
  removeNewColumn,
  revertColumn,
  setColumnField,
  setColumnUsing,
  toggleDropColumn,
  updateNewColumn,
  type BaseColumn,
  type ColumnDraft,
  type ColumnKey,
  type ColumnPosition,
  type NewColumn,
  type StagedStructure,
  type StructureIssue,
  type StructureModel
} from './structure-model'
import { isClickhouseNullable, setClickhouseNullable } from './type-catalog'

type Update = (fn: (s: StagedStructure) => StagedStructure) => void

const iconButton =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

const positionValue = (p: ColumnPosition): string =>
  p.kind === 'after' ? `after:${p.column}` : p.kind

const parsePosition = (value: string): ColumnPosition =>
  value.startsWith('after:')
    ? { kind: 'after', column: value.slice('after:'.length) }
    : value === 'first'
      ? { kind: 'first' }
      : { kind: 'end' }

export interface ColumnsTableProps {
  model: StructureModel
  staged: StagedStructure
  onChange: Update
  issues: StructureIssue[]
  /** Why column editing is off (whole structure read-only, or columns only); null = editable. */
  lockReason: string | null
  /** A new column whose name field takes the focus once. */
  focusColumnId: string | null
  onFocused: () => void
}

export function ColumnsTable({
  model,
  staged,
  onChange,
  issues,
  lockReason,
  focusColumnId,
  onFocused
}: ColumnsTableProps): React.JSX.Element {
  const { dialect, caps } = model
  const quoteOptions = literalOptions(model)
  // SQLite evaluates a new column's default for the existing rows, and only a constant works.
  const noNowReason =
    dialect === 'sqlite' && model.rows !== null && model.rows > 0
      ? 'No CURRENT_TIMESTAMP: SQLite cannot add a column with a non-constant default to a table that has rows.'
      : undefined
  const tableTypes = [...new Set(model.columns.map((c) => c.draft.type).filter(Boolean))]
  const issueOf = (key: ColumnKey, field: string): StructureIssue | undefined =>
    issues.find((i) => i.column === key && i.field === field && i.level === 'error') ??
    issues.find((i) => i.column === key && i.field === field)
  const rowIssue = (key: ColumnKey): StructureIssue | undefined =>
    issues.find((i) => i.column === key && !i.field)
  const toneOf = (key: ColumnKey, field: string): CellTone => issueOf(key, field)?.level ?? null

  const focusRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusColumnId || !focusRef.current) return
    focusRef.current.focus()
    focusRef.current.select()
    focusRef.current.scrollIntoView?.({ block: 'nearest' })
    onFocused()
  }, [focusColumnId, onFocused])

  const headers = [
    '#',
    'Name',
    'Type',
    'Nullable',
    'Default',
    'Extra',
    ...(caps.comments ? ['Comment'] : []),
    ''
  ]

  /** ClickHouse nullability is the type's (Nullable(T)), also while the type is being edited. */
  const nullableOf = (draft: ColumnDraft): boolean =>
    dialect === 'clickhouse' ? isClickhouseNullable(draft.type) : draft.nullable

  /** ClickHouse: why the type cannot become Nullable (arrays, maps, tuples...). */
  const nullableBlocked = (draft: ColumnDraft): string | undefined =>
    dialect === 'clickhouse' &&
    !nullableOf(draft) &&
    setClickhouseNullable(draft.type, true) === null
      ? `ClickHouse cannot make ${draft.type || 'this type'} Nullable.`
      : undefined

  const nullableChange = (draft: ColumnDraft, nullable: boolean): Partial<ColumnDraft> | null => {
    if (dialect !== 'clickhouse') return { nullable }
    const type = setClickhouseNullable(draft.type, nullable)
    if (type === null) {
      toast.error(`ClickHouse cannot make ${draft.type} Nullable.`)
      return null
    }
    return { type }
  }

  const baseRow = (c: BaseColumn): React.JSX.Element => {
    const name = c.info.name
    const draft = editedDraft(c, staged)
    const change = effectiveChange(c, staged.changes[name])
    const dropped = staged.drops.includes(name)
    const modified = !dropped && Object.keys(change).length > 0
    const lock = (field: keyof BaseColumn['locks']): string | undefined =>
      lockReason ?? c.locks[field]
    const off = (field: keyof BaseColumn['locks']): boolean => dropped || !!lock(field)
    const hint = (field: string, lockField: keyof BaseColumn['locks']): string | undefined =>
      issueOf(c.key, field)?.message ?? lock(lockField)
    const set = <F extends keyof ColumnDraft>(field: F, value: ColumnDraft[F]): void =>
      onChange((s) => setColumnField(s, c, field, value))
    const changed = (field: keyof ColumnDraft): string | false =>
      field in change && 'bg-amber-500/15 shadow-[inset_2px_0_0_rgb(245_158_11)]'
    const strike = dropped && 'line-through decoration-red-500/60'
    const problem = rowIssue(c.key)
    // USING runs after a staged rename: it sees the column under its new name.
    const usingPlaceholder = `USING ${quoteSqlIdentifier(draft.name.trim() || name, dialect)}::${draft.type}`
    const extras = [
      c.info.autoIncrement && !/auto_?increment|identity/i.test(c.info.extra ?? '')
        ? 'auto increment'
        : null,
      c.info.extra
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <tr
        key={c.key}
        className={cn(
          'border-b border-border/60 align-middle last:border-0',
          dropped && 'bg-red-500/10 text-muted-foreground',
          problem && 'shadow-[inset_2px_0_0_rgb(239_68_68)]'
        )}
        data-testid={`data-project-structure-column-${name}`}
        data-state={dropped ? 'dropped' : modified ? 'modified' : undefined}
        title={problem?.message}
      >
        <td className="w-8 px-2 py-0.5 text-right tabular-nums text-muted-foreground">
          {c.info.ordinal}
        </td>
        <td className={cn('px-1 py-0.5', changed('name'))}>
          <div className="flex items-center gap-1">
            {c.info.isPrimaryKey && (
              <KeyRound className="h-3 w-3 shrink-0 text-amber-500" aria-label="primary key" />
            )}
            <CellInput
              value={draft.name}
              onValueChange={(v) => set('name', v)}
              disabled={off('rename')}
              tone={toneOf(c.key, 'name')}
              hint={hint('name', 'rename')}
              className={cn('min-w-[110px] font-medium', strike)}
              data-testid="data-project-structure-col-name"
            />
          </div>
        </td>
        <td className={cn('px-1 py-0.5', changed('type'))}>
          <TypeInput
            dialect={dialect}
            value={draft.type}
            onValueChange={(v) => set('type', v)}
            tableTypes={tableTypes}
            disabled={off('type')}
            tone={toneOf(c.key, 'type')}
            hint={hint('type', 'type')}
            testId="data-project-structure-col-type"
          />
        </td>
        <td
          className={cn(
            'px-2 py-0.5 text-center',
            changed('nullable'),
            dialect === 'clickhouse' && 'type' in change && changed('type')
          )}
        >
          <Checkbox
            checked={nullableOf(draft)}
            disabled={off('nullable') || !!nullableBlocked(draft)}
            title={
              hint('nullable', 'nullable') ??
              nullableBlocked(draft) ??
              (nullableOf(draft) ? 'NULL allowed' : 'NOT NULL')
            }
            aria-label="Nullable"
            onCheckedChange={(v) => {
              const patch = nullableChange(draft, v)
              if (!patch) return
              onChange((s) => {
                let next = s
                for (const [field, value] of Object.entries(patch))
                  next = setColumnField(next, c, field as keyof ColumnDraft, value as never)
                return next
              })
            }}
            data-testid="data-project-structure-col-nullable"
          />
        </td>
        <td className={cn('px-1 py-0.5', changed('defaultExpr'))}>
          <DefaultInput
            dialect={dialect}
            value={draft.defaultExpr}
            onValueChange={(v) => set('defaultExpr', v)}
            disabled={off('default')}
            tone={toneOf(c.key, 'defaultExpr')}
            hint={hint('defaultExpr', 'default')}
            testId="data-project-structure-col-default"
            quoteOptions={quoteOptions}
          />
        </td>
        <td className="max-w-[260px] px-2 py-0.5">
          {caps.using && change.type !== undefined && !dropped ? (
            <CellInput
              value={staged.changes[name]?.using ?? ''}
              onValueChange={(v) => onChange((s) => setColumnUsing(s, name, v))}
              placeholder={usingPlaceholder}
              tone={toneOf(c.key, 'using')}
              hint={
                issueOf(c.key, 'using')?.message ??
                'Optional USING expression (without the word USING): how to convert the old values'
              }
              className="min-w-[140px]"
              data-testid="data-project-structure-col-using"
            />
          ) : extras ? (
            <span className="block truncate font-mono text-muted-foreground" title={extras}>
              {extras}
            </span>
          ) : null}
        </td>
        {caps.comments && (
          <td className={cn('px-1 py-0.5', changed('comment'))}>
            <CellInput
              value={draft.comment}
              onValueChange={(v) => set('comment', v)}
              disabled={off('comment')}
              hint={hint('comment', 'comment')}
              placeholder={off('comment') ? '' : '—'}
              className={cn('min-w-[100px] font-sans', strike)}
              data-testid="data-project-structure-col-comment"
            />
          </td>
        )}
        <td className="w-14 px-1 py-0.5">
          {!lockReason && (
            <div className="flex justify-end">
              {(dropped || modified) && (
                <button
                  type="button"
                  className={iconButton}
                  title={dropped ? 'Keep this column' : 'Undo the changes of this column'}
                  onClick={() => onChange((s) => revertColumn(s, name))}
                  data-testid="data-project-structure-col-revert"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              {!dropped && (
                <button
                  type="button"
                  className={cn(iconButton, 'hover:text-red-600')}
                  disabled={!!c.locks.drop}
                  title={c.locks.drop ?? 'Drop this column (staged)'}
                  onClick={() => onChange((s) => toggleDropColumn(s, name))}
                  data-testid="data-project-structure-col-drop"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </td>
      </tr>
    )
  }

  const choices = columnChoices(staged, model)
  const newRow = (a: NewColumn, index: number): React.JSX.Element => {
    const key = newKey(a.id)
    const d = a.draft
    const update = (patch: Partial<ColumnDraft>, position?: ColumnPosition): void =>
      onChange((s) => updateNewColumn(s, a.id, patch, position))
    return (
      <tr
        key={key}
        className="border-b border-border/60 bg-emerald-500/10 align-middle last:border-0"
        data-testid={`data-project-structure-new-column-${index}`}
        data-state="added"
      >
        <td className="w-8 px-2 py-0.5 text-right font-medium text-emerald-600">+</td>
        <td className="px-1 py-0.5">
          <CellInput
            ref={a.id === focusColumnId ? focusRef : undefined}
            value={d.name}
            onValueChange={(name) => update({ name })}
            tone={toneOf(key, 'name')}
            hint={issueOf(key, 'name')?.message}
            className="min-w-[110px] font-medium"
            data-testid="data-project-structure-col-name"
          />
        </td>
        <td className="px-1 py-0.5">
          <TypeInput
            dialect={dialect}
            value={d.type}
            onValueChange={(type) => update({ type })}
            tableTypes={tableTypes}
            tone={toneOf(key, 'type')}
            hint={issueOf(key, 'type')?.message}
            testId="data-project-structure-col-type"
          />
        </td>
        <td className="px-2 py-0.5 text-center">
          <Checkbox
            checked={nullableOf(d)}
            disabled={!!nullableBlocked(d)}
            title={
              issueOf(key, 'nullable')?.message ??
              nullableBlocked(d) ??
              (nullableOf(d) ? 'NULL allowed' : 'NOT NULL')
            }
            aria-label="Nullable"
            className={cn(toneOf(key, 'nullable') === 'warning' && 'border-amber-500')}
            onCheckedChange={(v) => {
              const patch = nullableChange(d, v)
              if (patch) update(patch)
            }}
            data-testid="data-project-structure-col-nullable"
          />
        </td>
        <td className="px-1 py-0.5">
          <DefaultInput
            dialect={dialect}
            value={d.defaultExpr}
            onValueChange={(defaultExpr) => update({ defaultExpr })}
            tone={toneOf(key, 'defaultExpr')}
            hint={issueOf(key, 'defaultExpr')?.message}
            testId="data-project-structure-col-default"
            quoteOptions={quoteOptions}
            noNowReason={noNowReason}
          />
        </td>
        <td className="px-1 py-0.5">
          {caps.positions ? (
            <select
              value={positionValue(a.position)}
              onChange={(e) => update({}, parsePosition(e.target.value))}
              className={cn(
                'h-6 max-w-[180px] rounded-[4px] border border-input bg-background px-1 text-[12px]',
                toneOf(key, 'position') === 'error' && 'border-red-500/70'
              )}
              title={issueOf(key, 'position')?.message ?? 'Where the new column goes'}
              data-testid="data-project-structure-col-position"
            >
              <option value="end">At the end</option>
              <option value="first">First</option>
              {choices
                .filter((c) => c.key !== key && !c.dropped)
                .map((c) => (
                  <option key={c.key} value={`after:${c.key}`}>
                    After {c.name}
                  </option>
                ))}
            </select>
          ) : (
            <span className="text-[11px] text-emerald-700 dark:text-emerald-300">new column</span>
          )}
        </td>
        {caps.comments && (
          <td className="px-1 py-0.5">
            <CellInput
              value={d.comment}
              onValueChange={(comment) => update({ comment })}
              placeholder="—"
              className="min-w-[100px] font-sans"
              data-testid="data-project-structure-col-comment"
            />
          </td>
        )}
        <td className="w-14 px-1 py-0.5">
          <div className="flex justify-end">
            <button
              type="button"
              className={iconButton}
              title="Remove this new column"
              onClick={() => onChange((s) => removeNewColumn(s, a.id))}
              data-testid="data-project-structure-col-remove"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table
        className="w-full border-collapse text-[12px]"
        data-testid="data-project-structure-columns"
      >
        <thead className="bg-card">
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className={cn(
                  'whitespace-nowrap border-b border-border px-2 py-1 text-left font-medium text-muted-foreground',
                  h === '#' && 'text-right',
                  h === 'Nullable' && 'text-center'
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.columns.map(baseRow)}
          {staged.adds.map(newRow)}
        </tbody>
      </table>
    </div>
  )
}
