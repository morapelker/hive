// Row detail side panel (TablePlus' Space): every column of the grid's focused row, top to bottom,
// as name · type · value. Values are shown whole: NULL as a badge distinct from an empty string,
// long text wrapped, JSON pretty-printed, binary as a hex preview (the cell inspector, one click
// away per field, has the full dump). Columns hidden in the grid are listed too (eye-off mark).
//
// Editable grids (the table Data view): each field edits in place and stages through the grid's
// `editing` hooks, exactly like an inline cell edit (same parsing; see row-detail.ts), so the
// pending bar's Preview SQL / Discard / Commit cover it and nothing is written from here. Enter
// or leaving the field stages it (Shift+Enter adds a line break), Esc reverts the draft (a second
// Esc returns to the grid), ⌘S stages the field and lets the view commit, "NULL" sets NULL.
//
// Drafts belong to a row, not to a position: fields are keyed by the row's identity (`rowKey`
// from the caller, else its primary-key values), so when a reload puts another row at the
// focused position the old fields unmount and their drafts are staged for the row they were
// typed into (through that render's editing hooks, which still resolve the old row), and the
// new row starts clean. A reload that changes the value under a draft of the same row keeps
// what was typed and says so (Esc takes the new value).
//
// The panel follows the grid's selection (arrow keys in the grid move the row, as do the panel's
// ↑ / ↓ buttons), clicking a field name selects that cell in the grid, the field filter narrows
// long column lists, and the left edge resizes it (the width is a per-viewer preference). It
// carries `data-db-grid` so the app's vim navigation and shortcuts leave its keys alone.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Copy,
  EyeOff,
  KeyRound,
  Maximize2,
  Search,
  X
} from 'lucide-react'
import type { DataCell, DataColumnMeta } from '@shared/data-projects/types'
import { ResizeHandle } from '@/components/layout/ResizeHandle'
import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { binaryPreview, cellKind, cellToText } from './cell-format'
import { rowToJson } from './export-format'
import type { GridCellState, GridRowState, ResultGridEditing } from './ResultGrid'
import {
  clampRowDetailWidth,
  fieldDraft,
  prettyJsonText,
  readRowDetailPrefs,
  resolveFieldDraft,
  ROW_DETAIL_TEXT_LIMIT,
  rowIdentity,
  writeRowDetailPrefs
} from './row-detail'

export interface RowDetailPanelProps {
  columns: DataColumnMeta[]
  /** The focused row's values; null when nothing is selected. */
  row: DataCell[] | null
  /** That row's index in the grid's rows (what the editing hooks take). */
  rowIndex: number | null
  /**
   * Stable identity of that row (its primary key, a staged insert's id): field drafts belong to
   * it. Without one the panel uses the row's `keyColumns` values (else its position).
   */
  rowKey?: string | null
  /** Its 1-based row number as the grid shows it (pagination offset included). */
  rowNumber: number | null
  /** Rows in the grid's selection (the panel shows the focused one). */
  selectedCount: number
  rowCount: number
  /** The grid's focused column: its field is highlighted and scrolled into view. */
  focusCol: number | null
  /** Columns hidden in the grid (still listed here). */
  hidden: ReadonlySet<number>
  /** Primary-key columns, marked with a key. */
  keyColumns?: readonly string[]
  /** Staged editing (positions in `columns`); read-only without it. */
  editing?: ResultGridEditing
  onClose: () => void
  /** Moves the grid's selection one row up (-1) or down (1). */
  onStep: (delta: -1 | 1) => void
  /** Selects this column's cell of the row in the grid. */
  onSelectField: (col: number) => void
  /** Opens the cell inspector on this column's value. */
  onInspect: (col: number) => void
  /** Esc in an unchanged field: back to the grid. */
  onReturnFocus: () => void
}

const valueClass =
  'max-h-48 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.45]'

export function RowDetailPanel({
  columns,
  row,
  rowIndex,
  rowKey,
  rowNumber,
  selectedCount,
  rowCount,
  focusCol,
  hidden,
  keyColumns,
  editing,
  onClose,
  onStep,
  onSelectField,
  onInspect,
  onReturnFocus
}: RowDetailPanelProps): React.JSX.Element {
  const [width, setWidth] = useState(() => readRowDetailPrefs().width)
  const [search, setSearch] = useState('')
  const fieldsRef = useRef<HTMLDivElement>(null)
  const asideRef = useRef<HTMLElement>(null)

  const onResize = useCallback((delta: number) => {
    setWidth((w) => {
      // Never wider than the 75% the layout shows, so dragging back acts at once.
      const room = asideRef.current?.parentElement?.clientWidth
      return clampRowDetailWidth(Math.min(w + delta, room ? room * 0.75 : Infinity))
    })
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => writeRowDetailPrefs({ width }), 250)
    return () => window.clearTimeout(timer)
  }, [width])

  // The grid's focused column moved: bring its field into view (row changes keep the scroll).
  useEffect(() => {
    if (focusCol === null) return
    fieldsRef.current
      ?.querySelector(`[data-field-col="${focusCol}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [focusCol])

  const keys = useMemo(() => new Set(keyColumns ?? []), [keyColumns])
  const fields = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return columns.flatMap((column, col) =>
      !needle || column.name.toLowerCase().includes(needle) ? [{ column, col }] : []
    )
  }, [columns, search])

  const rowState: GridRowState = rowIndex !== null ? (editing?.rowState?.(rowIndex) ?? null) : null
  const identity = rowIdentity(rowKey, row, rowIndex, rowState === 'inserted', columns, keyColumns)
  const fieldEditable = (col: number): boolean =>
    !!editing && rowIndex !== null && rowState !== 'deleted' && editing.isEditable(rowIndex, col)

  const copy = async (text: string, what: string): Promise<void> => {
    if (await copyTextToClipboard(text)) toast.success(`${what} copied`)
    else toast.error('Could not copy to the clipboard')
  }

  const title =
    row === null
      ? 'No row selected'
      : rowState === 'inserted'
        ? 'New row'
        : `Row ${(rowNumber ?? 0).toLocaleString()}`

  return (
    <aside
      ref={asideRef}
      className="relative flex h-full min-h-0 max-w-[75%] shrink-0 border-l border-border bg-card"
      style={{ width }}
      aria-label="Row detail"
      data-db-grid=""
      data-testid="data-project-row-detail"
    >
      <ResizeHandle direction="right" onResize={onResize} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border pl-2 pr-1">
          <span
            className="truncate text-[12px] font-semibold"
            data-testid="data-project-row-detail-title"
          >
            {title}
          </span>
          {rowState === 'deleted' && (
            <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 text-[10px] text-red-600 dark:text-red-400">
              deleted
            </span>
          )}
          {selectedCount > 1 && (
            <span className="shrink-0 truncate text-[11px] text-muted-foreground">
              · {selectedCount.toLocaleString()} selected
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={rowIndex === null || rowIndex <= 0}
              onClick={() => onStep(-1)}
              title="Previous row (↑ in the grid)"
              data-testid="data-project-row-detail-prev"
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={rowIndex === null ? rowCount === 0 : rowIndex >= rowCount - 1}
              onClick={() => onStep(1)}
              title="Next row (↓ in the grid)"
              data-testid="data-project-row-detail-next"
            >
              <ChevronDown />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={row === null}
              onClick={() => row && void copy(rowToJson(columns, row), 'Row')}
              title="Copy the row as JSON"
              data-testid="data-project-row-detail-copy-row"
            >
              <ClipboardCopy />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              title="Close the row detail (Space in the grid)"
              data-testid="data-project-row-detail-close"
            >
              <X />
            </Button>
          </div>
        </div>
        <div className="shrink-0 border-b border-border px-2 py-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && search) {
                  e.stopPropagation()
                  setSearch('')
                }
              }}
              placeholder="Filter fields…"
              spellCheck={false}
              data-testid="data-project-row-detail-search"
              className="h-6 w-full rounded-md border border-input bg-transparent pl-6 pr-1.5 text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
        </div>
        {row === null ? (
          <div
            className="flex flex-1 items-start px-3 py-3 text-[12px] text-muted-foreground"
            data-testid="data-project-row-detail-empty"
          >
            {rowCount === 0
              ? 'No rows'
              : 'Select a row to see its fields (click a cell or use the arrow keys).'}
          </div>
        ) : (
          <div
            ref={fieldsRef}
            className="min-h-0 flex-1 overflow-y-auto"
            data-testid="data-project-row-detail-fields"
          >
            {fields.map(({ column, col }) => {
              const state: GridCellState =
                rowIndex !== null ? (editing?.cellState?.(rowIndex, col) ?? null) : null
              return (
                <RowDetailField
                  // A draft belongs to its row, wherever the row sits: another row at this
                  // position gets fresh fields (the old draft is staged on the way out, for the
                  // row it was typed into).
                  key={`${identity.key}\u0000${col}`}
                  stableRow={identity.stable}
                  column={column}
                  col={col}
                  value={row[col]}
                  state={state}
                  isKey={keys.has(column.name)}
                  hidden={hidden.has(col)}
                  focused={focusCol === col}
                  editable={fieldEditable(col)}
                  onCommit={(value) =>
                    rowIndex !== null && editing?.onCommitEdit(rowIndex, col, value)
                  }
                  onSelect={() => onSelectField(col)}
                  onInspect={() => onInspect(col)}
                  onCopy={() => void copy(cellToText(row[col]), 'Value')}
                  onReturnFocus={onReturnFocus}
                />
              )
            })}
            {fields.length === 0 && (
              <div className="px-3 py-3 text-[12px] text-muted-foreground">
                No column matches “{search.trim()}”
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

interface RowDetailFieldProps {
  column: DataColumnMeta
  col: number
  /** The field's row is known by identity (see rowIdentity). */
  stableRow: boolean
  value: DataCell | undefined
  state: GridCellState
  isKey: boolean
  hidden: boolean
  focused: boolean
  editable: boolean
  onCommit: (value: DataCell) => void
  onSelect: () => void
  onInspect: () => void
  onCopy: () => void
  onReturnFocus: () => void
}

function RowDetailField({
  column,
  col,
  stableRow,
  value,
  state,
  isKey,
  hidden,
  focused,
  editable,
  onCommit,
  onSelect,
  onInspect,
  onCopy,
  onReturnFocus
}: RowDetailFieldProps): React.JSX.Element {
  const long = typeof value === 'string' && value.length > ROW_DETAIL_TEXT_LIMIT
  const inline = editable && !long
  // Tab hops from editor to editor; the per-field buttons stay one click away.
  const buttonTab = inline ? -1 : undefined
  const iconButton =
    'flex h-5 w-5 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-accent hover:text-foreground'
  return (
    <div
      data-field-col={col}
      data-focused={focused || undefined}
      data-cell-state={state ?? undefined}
      data-testid={`data-project-row-detail-field-${col}`}
      className={cn(
        'group/field border-b border-border/60 px-2 pb-1.5 pt-1',
        focused && 'bg-sky-500/[0.07] dark:bg-sky-400/[0.08]',
        state === 'modified' && 'bg-amber-500/10 shadow-[inset_2px_0_0_rgb(245_158_11)]'
      )}
    >
      <div className="flex h-5 min-w-0 items-center gap-1">
        <button
          type="button"
          tabIndex={-1}
          onClick={onSelect}
          title={
            hidden ? `${column.name} (hidden in the grid)` : `Select ${column.name} in the grid`
          }
          className="min-w-0 truncate text-left text-[12px] font-medium text-foreground hover:underline"
          data-testid="data-project-row-detail-name"
        >
          {column.name}
        </button>
        {isKey && (
          <KeyRound className="h-3 w-3 shrink-0 text-amber-500" aria-label="Primary key column" />
        )}
        {hidden && (
          <EyeOff
            className="h-3 w-3 shrink-0 text-muted-foreground/70"
            aria-label="Hidden in the grid"
          />
        )}
        {column.type && (
          <span className="min-w-0 shrink truncate font-mono text-[10px] text-muted-foreground/70">
            {column.type}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/field:opacity-100 group-hover/field:opacity-100">
          {editable && (
            <button
              type="button"
              tabIndex={buttonTab}
              disabled={value === null && state !== 'default'}
              onClick={() => onCommit(null)}
              title="Set NULL (staged until Commit)"
              data-testid="data-project-row-detail-set-null"
              className="h-4 rounded-[4px] border border-border px-1 font-mono text-[9px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              NULL
            </button>
          )}
          <button
            type="button"
            tabIndex={buttonTab}
            onClick={onInspect}
            title={
              editable
                ? 'Open in the cell inspector (edit, JSON, hex)'
                : 'Open in the cell inspector'
            }
            data-testid="data-project-row-detail-inspect"
            className={iconButton}
          >
            <Maximize2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            tabIndex={buttonTab}
            onClick={onCopy}
            title="Copy the value"
            data-testid="data-project-row-detail-copy"
            className={iconButton}
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
      </div>
      {inline ? (
        <FieldEditor
          name={column.name}
          value={value}
          columnType={column.type}
          keepDraftOnChange={stableRow}
          placeholder={
            state === 'default'
              ? 'DEFAULT'
              : value === null || value === undefined
                ? 'NULL'
                : 'empty string'
          }
          onCommit={onCommit}
          onReturnFocus={onReturnFocus}
        />
      ) : (
        <>
          <FieldValue value={value} state={state} />
          {editable && long && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Long value: edit it in the cell inspector.
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Read-only value: NULL / empty string / JSON / binary / long text each look distinct. */
function FieldValue({
  value,
  state
}: {
  value: DataCell | undefined
  state: GridCellState
}): React.JSX.Element {
  const testId = 'data-project-row-detail-value'
  if (state === 'default')
    return (
      <div className="font-mono text-[12px] italic text-muted-foreground/60" data-testid={testId}>
        DEFAULT
      </div>
    )
  if (value === undefined)
    return (
      <div className="text-[12px] text-muted-foreground/60" data-testid={testId}>
        — not present in this document
      </div>
    )
  const kind = cellKind(value)
  if (kind === 'null')
    return (
      <div data-testid={testId}>
        <span className="rounded-[3px] bg-muted px-1 font-mono text-[11px] italic text-muted-foreground">
          NULL
        </span>
      </div>
    )
  if (kind === 'binary')
    return (
      <div
        className={cn(valueClass, 'break-all text-violet-600 dark:text-violet-300/90')}
        data-testid={testId}
      >
        {binaryPreview(value as never, 48)}
      </div>
    )
  if (kind === 'boolean')
    return (
      <div
        className={cn(
          'font-mono text-[12px]',
          value ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
        )}
        data-testid={testId}
      >
        {value ? 'true' : 'false'}
      </div>
    )
  if (kind === 'number')
    return (
      <div className="font-mono text-[12px] tabular-nums" data-testid={testId}>
        {String(value)}
      </div>
    )
  const text = value as string
  if (text === '')
    return (
      <div className="text-[12px] italic text-muted-foreground/60" data-testid={testId}>
        empty string
      </div>
    )
  // Re-spaced, never re-serialised: numbers and escapes show as the database holds them.
  const pretty = kind === 'json' ? prettyJsonText(text) : null
  const shown =
    pretty !== null
      ? pretty
      : text.length > ROW_DETAIL_TEXT_LIMIT
        ? `${text.slice(0, ROW_DETAIL_TEXT_LIMIT)}…`
        : text
  return (
    <pre className={valueClass} data-testid={testId}>
      {shown}
    </pre>
  )
}

/**
 * In-place editor of one field. The draft follows the value until the user types; Enter / blur
 * stage it, Esc reverts; a draft left behind when the field unmounts (another row selected or
 * moved into this position, the panel closed) is staged then, for the row it was typed into.
 * A value that changes under a draft being typed (a reload) keeps the draft when the field's row
 * is known by identity (`keepDraftOnChange`), with a note; otherwise the draft starts over.
 */
function FieldEditor({
  name,
  value,
  columnType,
  keepDraftOnChange,
  placeholder,
  onCommit,
  onReturnFocus
}: {
  name: string
  value: DataCell | undefined
  columnType: string | undefined
  keepDraftOnChange: boolean
  placeholder: string
  onCommit: (value: DataCell) => void
  onReturnFocus: () => void
}): React.JSX.Element {
  const base = useMemo(() => fieldDraft(value), [value])
  const [draft, setDraft] = useState(base.text)
  const [seen, setSeen] = useState(base.text)
  const [invalid, setInvalid] = useState<string | null>(null)
  /** The draft text last staged: not an edit in progress any more. */
  const [staged, setStaged] = useState<string | null>(null)
  /** The value changed underneath the draft being typed (kept; Esc takes the new value). */
  const [stale, setStale] = useState(false)
  if (seen !== base.text) {
    // The value changed underneath (staged from here or the grid, reloaded, committed).
    const typing = draft !== seen && draft !== staged
    setSeen(base.text)
    setStaged(null)
    if (typing && keepDraftOnChange && draft !== base.text) setStale(true)
    else {
      setDraft(base.text)
      setInvalid(null)
      setStale(false)
    }
  }

  const latest = useRef({ draft, base, value, columnType, staged, onCommit })
  latest.current = { draft, base, value, columnType, staged, onCommit }

  const commit = (): boolean => {
    const c = latest.current
    const result = resolveFieldDraft(c.draft, c.base, c.value, c.columnType)
    if (result.kind === 'invalid') {
      setInvalid(result.message)
      return false
    }
    setInvalid(null)
    setStale(false)
    if (result.kind === 'value') {
      // Also on the ref: an unmount right after this (the row's key changed) must not stage it
      // twice.
      c.staged = c.draft
      setStaged(c.draft)
      c.onCommit(result.value)
    } else if (c.draft !== c.base.text) {
      // Only reformatted (JSON whitespace): show the value as it is.
      setDraft(c.base.text)
    }
    return true
  }

  useEffect(
    () => () => {
      const c = latest.current
      if (c.staged !== null && c.draft === c.staged) return // staged already
      const result = resolveFieldDraft(c.draft, c.base, c.value, c.columnType)
      if (result.kind === 'value') c.onCommit(result.value)
      else if (result.kind === 'invalid')
        toast.error(`${name}: the edit was not staged (${result.message})`)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const dirty = draft !== base.text
  return (
    <div>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          if (invalid) setInvalid(null)
        }}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey
          if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !mod) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            if (dirty || invalid || stale) {
              setDraft(base.text)
              setInvalid(null)
              setStale(false)
            } else onReturnFocus()
          } else if (mod && e.key.toLowerCase() === 's' && !commit()) {
            // ⌘S stages the field first and then reaches the view's Commit, unless it is invalid.
            e.preventDefault()
            e.stopPropagation()
          }
        }}
        rows={1}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={`Value of ${name}`}
        title="Enter stages the change · Shift+Enter adds a line break · Esc reverts"
        data-testid="data-project-row-detail-input"
        data-dirty={dirty || undefined}
        className={cn(
          'block max-h-48 min-h-[22px] w-full resize-none rounded-[4px] border border-transparent bg-transparent px-1 py-0.5 font-mono text-[12px] leading-[1.45] outline-none field-sizing-content placeholder:italic placeholder:text-muted-foreground/55 hover:border-input focus:border-ring/60 focus:bg-background',
          dirty && 'border-sky-500/50',
          (invalid || (stale && dirty)) && 'border-amber-500'
        )}
      />
      {invalid ? (
        <div
          className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400"
          data-testid="data-project-row-detail-invalid"
        >
          {invalid}
        </div>
      ) : (
        stale &&
        dirty && (
          <div
            className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400"
            data-testid="data-project-row-detail-stale"
          >
            The value changed since you started typing: Enter keeps your text, Esc takes the new
            value.
          </div>
        )
      )}
    </div>
  )
}
