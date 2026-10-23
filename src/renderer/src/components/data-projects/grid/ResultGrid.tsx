// Virtualized result grid used by query results, table data, processes-like listings and Mongo's
// table view. Rows AND columns are virtualized (@tanstack/react-virtual, one scroll element, two
// virtualizers), so 100k rows × 300 columns render only what is on screen.
//
// Layout: one scroll container holding a sticky header row and an absolutely positioned body.
// The row-number column is `position: sticky; left: 0` inside each row, so it stays put while
// scrolling sideways. Column widths start from a sample of the data and can be dragged (double
// click on a handle auto-fits).
//
// Interaction: click / shift-click / drag select a rectangle, click a row number to select rows,
// Cmd+A all, arrows (+shift) move, Cmd+C copies the selection as TSV, Enter / double-click edits
// (or opens the cell inspector when the cell is not editable), Space opens the inspector, or
// toggles the row detail panel when the caller offers one (Shift+Space is then the inspector),
// Delete/Backspace asks to delete the selected rows (staged by the caller). Right-click opens
// copy-as (TSV/CSV/JSON/SQL INSERT/Markdown), "filter by this value", the inspector and the row
// detail. The container carries `data-db-grid` so the app's vim navigation leaves its keys alone.
//
// Row detail (`rowDetail`, TablePlus' Space): a resizable panel right of the grid listing every
// column of the focused row (RowDetailPanel). The caller owns open / closed (its toolbar toggle);
// the panel follows the selection and edits through the same `editing` hooks as the cells.
//
// Header: click sorts (the caller decides: server-side for table data, client-side for query
// results), the header menu hides a column; hidden columns are listed in the top-left corner
// button (click shows them all). Hiding is a view of the same rows: `ResultGrid` projects the
// visible columns for the grid body and maps column positions back for every callback, so the
// caller always sees positions in its own `columns`.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowUp,
  Braces,
  ClipboardCopy,
  Eye,
  EyeOff,
  Filter,
  PanelRight,
  Pencil,
  Trash2
} from 'lucide-react'
import type { DataCell, DataColumnMeta, DataSort, SqlDialect } from '@shared/data-projects/types'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  binaryPreview,
  cellDisplayText,
  cellKind,
  cellToText,
  estimateColumnWidth,
  MIN_COLUMN_WIDTH,
  resolveCellEdit
} from './cell-format'
import { CellInspector } from './CellInspector'
import { formatRows, type CopyFormat, type SqlInsertOptions } from './export-format'
import { RowDetailPanel } from './RowDetailPanel'

export const GRID_ROW_HEIGHT = 24
export const GRID_HEADER_HEIGHT = 28

export interface GridCellPos {
  row: number
  col: number
}

export type GridRowState = 'inserted' | 'deleted' | null
export type GridCellState = 'modified' | 'default' | null

/** Staged editing hooks (table data). Rows/cols are indexes into the displayed `rows`. */
export interface ResultGridEditing {
  isEditable: (row: number, col: number) => boolean
  onCommitEdit: (row: number, col: number, value: DataCell) => void
  rowState?: (row: number) => GridRowState
  cellState?: (row: number, col: number) => GridCellState
  /** Delete/Backspace and the context menu: stage deletion of these rows. */
  onDeleteRows?: (rows: number[]) => void
}

/** The row detail side panel; the caller owns open / closed (its toolbar toggle, Space). */
export interface ResultGridRowDetail {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Primary-key column names, marked in the panel. */
  keyColumns?: readonly string[]
}

export interface ResultGridProps {
  columns: DataColumnMeta[]
  rows: DataCell[][]
  /** Added to the 1-based row number (pagination). */
  rowNumberOffset?: number
  /** Current sort by column name (header arrows). */
  sort?: DataSort[] | null
  /** Current sort by column position; wins over `sort` (query results may repeat a name). */
  sortedColumns?: ReadonlyArray<{ col: number; direction: 'asc' | 'desc' }> | null
  /**
   * Header click: the caller cycles the direction; `additive` = shift-click (multi-sort). `col` is
   * the column's position in `columns`.
   */
  onSortColumn?: (column: string, additive: boolean, col: number) => void
  onFilterByValue?: (column: string, value: DataCell, col: number) => void
  /** SQL INSERT copies: dialect and target table. */
  dialect?: SqlDialect
  insertTable?: SqlInsertOptions['table']
  editing?: ResultGridEditing
  /** Offers the row detail panel (Space toggles it); omitted, Space opens the cell inspector. */
  rowDetail?: ResultGridRowDetail
  /** Selected row indexes (sorted), whenever the selection changes. */
  onSelectionChange?: (rows: number[]) => void
  emptyMessage?: string
  className?: string
  'data-testid'?: string
}

export interface ResultGridHandle {
  focus: () => void
  scrollToRow: (row: number) => void
  selectRow: (row: number) => void
}

/** The body's handle: the public one plus what the row detail panel drives. */
interface GridBodyHandle extends ResultGridHandle {
  /** Selects one cell (body column position) and scrolls it into view. */
  selectCell: (row: number, col: number) => void
  /** Moves the focused cell `delta` rows (to the first cell when nothing is selected). */
  stepRow: (delta: number) => void
}

/** The grid's focused cell (body column position) and how many rows the selection spans. */
type FocusListener = (focus: GridCellPos | null, selectedRows: number) => void

interface Selection {
  anchor: GridCellPos
  focus: GridCellPos
}

type MenuTarget =
  { kind: 'cell'; row: number; col: number } | { kind: 'header'; col: number } | null

/** What the grid body needs to offer hiding / showing columns (positions are the body's). */
interface ColumnVisibility {
  hidden: Array<{ col: number; name: string }>
  onHide: (viewCol: number) => void
  onShow: (col: number) => void
  onShowAll: () => void
}

const NO_HIDDEN: ReadonlySet<number> = new Set()

const columnsKeyOf = (columns: DataColumnMeta[]): string =>
  columns.map((c) => `${c.name}:${c.type ?? ''}`).join('\u0001')

interface EditingCell {
  row: number
  col: number
  draft: string
}

const NUMERIC_TYPE = /int|dec|numeric|float|double|real|number|money|serial|uint/i

const rect = (s: Selection): { r0: number; r1: number; c0: number; c1: number } => ({
  r0: Math.min(s.anchor.row, s.focus.row),
  r1: Math.max(s.anchor.row, s.focus.row),
  c0: Math.min(s.anchor.col, s.focus.col),
  c1: Math.max(s.anchor.col, s.focus.col)
})

const clampIndex = (value: number, count: number): number => Math.max(0, Math.min(count - 1, value))

export const ResultGrid = forwardRef<ResultGridHandle, ResultGridProps>(
  function ResultGrid(props, ref): React.JSX.Element {
    const { columns, rows, sortedColumns, onSortColumn, onFilterByValue, editing, rowDetail } =
      props
    const bodyRef = useRef<GridBodyHandle>(null)
    useImperativeHandle(
      ref,
      () => ({
        focus: () => bodyRef.current?.focus(),
        scrollToRow: (row) => bodyRef.current?.scrollToRow(row),
        selectRow: (row) => bodyRef.current?.selectRow(row)
      }),
      []
    )
    const columnsKey = useMemo(() => columnsKeyOf(columns), [columns])
    // Hidden column positions, forgotten when another column set arrives (a new result).
    const [hiddenState, setHiddenState] = useState<{ key: string; cols: ReadonlySet<number> }>(
      () => ({ key: columnsKey, cols: NO_HIDDEN })
    )
    const hidden = hiddenState.key === columnsKey ? hiddenState.cols : NO_HIDDEN
    const visible = useMemo(
      () => columns.flatMap((_, i) => (hidden.has(i) ? [] : [i])),
      [columns, hidden]
    )
    const projecting = hidden.size > 0
    const viewColumns = useMemo(
      () => (projecting ? visible.map((i) => columns[i]) : columns),
      [projecting, visible, columns]
    )
    const viewRows = useMemo(
      () => (projecting ? rows.map((r) => visible.map((i) => r[i])) : rows),
      [projecting, visible, rows]
    )
    const toOriginal = useCallback((viewCol: number) => visible[viewCol] ?? viewCol, [visible])

    const viewEditing = useMemo<ResultGridEditing | undefined>(() => {
      if (!editing || !projecting) return editing
      return {
        isEditable: (row, col) => editing.isEditable(row, toOriginal(col)),
        onCommitEdit: (row, col, value) => editing.onCommitEdit(row, toOriginal(col), value),
        rowState: editing.rowState,
        cellState: editing.cellState
          ? (row, col) => editing.cellState?.(row, toOriginal(col)) ?? null
          : undefined,
        onDeleteRows: editing.onDeleteRows
      }
    }, [editing, projecting, toOriginal])

    const viewSortedColumns = useMemo(
      () =>
        sortedColumns && projecting
          ? sortedColumns.flatMap((s) => {
              const at = visible.indexOf(s.col)
              return at >= 0 ? [{ col: at, direction: s.direction }] : []
            })
          : sortedColumns,
      [sortedColumns, projecting, visible]
    )

    const setHidden = (update: (cols: ReadonlySet<number>) => ReadonlySet<number>): void =>
      setHiddenState((s) => ({
        key: columnsKey,
        cols: update(s.key === columnsKey ? s.cols : NO_HIDDEN)
      }))

    const visibility: ColumnVisibility = {
      hidden: [...hidden]
        .sort((a, b) => a - b)
        .map((col) => ({ col, name: columns[col]?.name ?? '' })),
      onHide: (viewCol) => {
        const col = toOriginal(viewCol)
        setHidden((cols) =>
          // Keep at least one column on screen.
          cols.size + 1 >= columns.length ? cols : new Set([...cols, col])
        )
      },
      onShow: (col) =>
        setHidden((cols) => {
          const next = new Set(cols)
          next.delete(col)
          return next
        }),
      onShowAll: () => setHidden(() => NO_HIDDEN)
    }

    // ---- row detail: the focused cell in the caller's column positions ----------------------------
    const [focus, setFocus] = useState<{ row: number; col: number; selected: number } | null>(null)
    const [panelInspector, setPanelInspector] = useState<GridCellPos | null>(null)
    const onFocusChange: FocusListener = (pos, selected) =>
      setFocus(pos ? { row: pos.row, col: toOriginal(pos.col), selected } : null)
    const focusRow = focus && focus.row < rows.length ? focus.row : null
    const canEditCell = (row: number, col: number): boolean =>
      !!editing && editing.rowState?.(row) !== 'deleted' && editing.isEditable(row, col)

    const body = (
      <GridBody
        {...props}
        ref={bodyRef}
        columns={viewColumns}
        rows={viewRows}
        sortedColumns={viewSortedColumns}
        onSortColumn={
          onSortColumn
            ? (name, additive, col) => onSortColumn(name, additive, toOriginal(col))
            : undefined
        }
        onFilterByValue={
          onFilterByValue
            ? (name, value, col) => onFilterByValue(name, value, toOriginal(col))
            : undefined
        }
        editing={viewEditing}
        visibility={visibility}
        onFocusChange={rowDetail ? onFocusChange : undefined}
      />
    )
    if (!rowDetail) return body
    // The wrapper exists whenever a panel is offered, so toggling it never remounts the grid
    // (which would drop the selection the panel shows).
    return (
      <div className="flex min-h-0 min-w-0 flex-1" data-testid="data-project-grid-with-detail">
        {body}
        {rowDetail.open && (
          <RowDetailPanel
            columns={columns}
            row={focusRow !== null ? (rows[focusRow] ?? null) : null}
            rowIndex={focusRow}
            rowNumber={focusRow !== null ? (props.rowNumberOffset ?? 0) + focusRow + 1 : null}
            selectedCount={focus?.selected ?? 0}
            rowCount={rows.length}
            focusCol={focusRow !== null && focus ? focus.col : null}
            hidden={hidden}
            keyColumns={rowDetail.keyColumns}
            editing={editing}
            onClose={() => {
              rowDetail.onOpenChange(false)
              bodyRef.current?.focus()
            }}
            onStep={(delta) => bodyRef.current?.stepRow(delta)}
            onSelectField={(col) => {
              const viewCol = visible.indexOf(col)
              if (focusRow !== null && viewCol >= 0) bodyRef.current?.selectCell(focusRow, viewCol)
            }}
            onInspect={(col) => focusRow !== null && setPanelInspector({ row: focusRow, col })}
            onReturnFocus={() => bodyRef.current?.focus()}
          />
        )}
        <CellInspector
          open={panelInspector !== null}
          onOpenChange={(open) => !open && setPanelInspector(null)}
          column={panelInspector ? (columns[panelInspector.col] ?? null) : null}
          value={panelInspector ? rows[panelInspector.row]?.[panelInspector.col] : undefined}
          onApply={
            panelInspector && editing && canEditCell(panelInspector.row, panelInspector.col)
              ? (value) => editing.onCommitEdit(panelInspector.row, panelInspector.col, value)
              : undefined
          }
        />
      </div>
    )
  }
)

const GridBody = forwardRef<
  GridBodyHandle,
  ResultGridProps & { visibility: ColumnVisibility; onFocusChange?: FocusListener }
>(function GridBody(
  {
    columns,
    rows,
    rowNumberOffset = 0,
    sort,
    sortedColumns,
    onSortColumn,
    onFilterByValue,
    dialect,
    insertTable,
    editing,
    rowDetail,
    onSelectionChange,
    emptyMessage = 'No rows',
    className,
    visibility,
    onFocusChange,
    'data-testid': testId = 'data-project-result-grid'
  },
  ref
): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // ---- column widths (estimated per column set, then user-resizable) -------------------------
  const columnsKey = useMemo(() => columnsKeyOf(columns), [columns])
  const estimate = useCallback(
    (sample: number) =>
      columns.map((c, i) =>
        estimateColumnWidth(
          c.name,
          c.type,
          (function* () {
            for (let r = 0; r < Math.min(rows.length, sample); r++) yield rows[r][i]
          })(),
          sample
        )
      ),
    [columns, rows]
  )
  const [widthState, setWidthState] = useState(() => ({
    key: columnsKey,
    columns,
    widths: estimate(60)
  }))
  let widths = widthState.widths
  if (widthState.key !== columnsKey) {
    // Columns that stay (hiding / showing one) keep their width, dragged or not.
    const kept = new Map<string, number[]>()
    widthState.columns.forEach((c, i) => {
      const key = columnsKeyOf([c])
      kept.set(key, [...(kept.get(key) ?? []), widthState.widths[i]])
    })
    const estimated = estimate(60)
    widths = columns.map((c, i) => kept.get(columnsKeyOf([c]))?.shift() ?? estimated[i])
    setWidthState({ key: columnsKey, columns, widths })
  }

  const lastRowNumber = rowNumberOffset + rows.length
  const rowNumberWidth = Math.max(40, String(lastRowNumber).length * 7.2 + 20)

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: 12
  })
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i] ?? 120,
    overscan: 3
  })
  useEffect(() => {
    colVirtualizer.measure()
  }, [widths, colVirtualizer])

  // ---- selection -------------------------------------------------------------------------------
  const [selection, setSelection] = useState<Selection | null>(null)
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null)
  const [inspector, setInspector] = useState<GridCellPos | null>(null)
  const [menuTarget, setMenuTarget] = useState<MenuTarget>(null)
  const draggingRef = useRef<'cells' | 'rows' | null>(null)

  useEffect(() => {
    setSelection(null)
    setEditingCell(null)
  }, [columnsKey])

  useEffect(() => {
    // Rows shrank (page change, refresh): keep the selection inside the data.
    setSelection((s) => {
      if (!s) return s
      if (rows.length === 0) return null
      const fix = (p: GridCellPos): GridCellPos => ({
        row: clampIndex(p.row, rows.length),
        col: p.col
      })
      return { anchor: fix(s.anchor), focus: fix(s.focus) }
    })
  }, [rows.length])

  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  useEffect(() => {
    const cb = onSelectionChangeRef.current
    if (!cb) return
    if (!selection) cb([])
    else {
      const { r0, r1 } = rect(selection)
      cb(Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i))
    }
  }, [selection])

  // The row detail panel follows the focused cell (the moving end of the selection).
  const onFocusChangeRef = useRef(onFocusChange)
  onFocusChangeRef.current = onFocusChange
  const focusRow = selection ? selection.focus.row : -1
  const focusCol = selection ? selection.focus.col : -1
  const selectedRowCount = selection ? Math.abs(selection.focus.row - selection.anchor.row) + 1 : 0
  useEffect(() => {
    onFocusChangeRef.current?.(
      focusRow < 0 ? null : { row: focusRow, col: focusCol },
      selectedRowCount
    )
  }, [focusRow, focusCol, selectedRowCount])

  useImperativeHandle(ref, () => ({
    focus: () => scrollRef.current?.focus(),
    scrollToRow: (row) => rowVirtualizer.scrollToIndex(row, { align: 'auto' }),
    selectRow: (row) => {
      if (row < 0 || row >= rows.length || columns.length === 0) return
      setSelection({ anchor: { row, col: 0 }, focus: { row, col: columns.length - 1 } })
      rowVirtualizer.scrollToIndex(row, { align: 'auto' })
    },
    selectCell: (row, col) => moveTo({ row, col }, false),
    stepRow: (delta) =>
      selection
        ? moveTo({ row: selection.focus.row + delta, col: selection.focus.col }, false)
        : moveTo({ row: 0, col: 0 }, false)
  }))

  const isSelected = (row: number, col: number): boolean => {
    if (!selection) return false
    const { r0, r1, c0, c1 } = rect(selection)
    return row >= r0 && row <= r1 && col >= c0 && col <= c1
  }

  const moveTo = (pos: GridCellPos, extend: boolean): void => {
    if (!rows.length || !columns.length) return
    const p = { row: clampIndex(pos.row, rows.length), col: clampIndex(pos.col, columns.length) }
    setSelection((s) => (extend && s ? { anchor: s.anchor, focus: p } : { anchor: p, focus: p }))
    rowVirtualizer.scrollToIndex(p.row, { align: 'auto' })
    colVirtualizer.scrollToIndex(p.col, { align: 'auto' })
  }

  // ---- copy ------------------------------------------------------------------------------------
  const copyText = async (text: string, what: string | null): Promise<void> => {
    const ok = await copyTextToClipboard(text)
    if (!ok) toast.error('Could not copy to the clipboard')
    else if (what) toast.success(`${what} copied`)
  }

  const block = (s: Selection): { cols: DataColumnMeta[]; data: DataCell[][] } => {
    const { r0, r1, c0, c1 } = rect(s)
    return {
      cols: columns.slice(c0, c1 + 1),
      data: rows.slice(r0, r1 + 1).map((r) => r.slice(c0, c1 + 1))
    }
  }

  /** Copy-as uses the selected block, or whole rows when a single cell is selected. */
  const copyAs = (format: CopyFormat): void => {
    if (!selection) return
    const { r0, r1, c0, c1 } = rect(selection)
    const single = r0 === r1 && c0 === c1
    const cols = single ? columns : columns.slice(c0, c1 + 1)
    const data = rows.slice(r0, r1 + 1).map((r) => (single ? r : r.slice(c0, c1 + 1)))
    const text = formatRows(format, cols, data, {
      dialect,
      table: insertTable,
      header: format !== 'tsv'
    })
    const n = r1 - r0 + 1
    void copyText(text, `${n.toLocaleString()} ${n === 1 ? 'row' : 'rows'}`)
  }

  const copySelectionTsv = (withToast: boolean): void => {
    if (!selection) return
    const { cols, data } = block(selection)
    void copyText(formatRows('tsv', cols, data), withToast ? 'Selection' : null)
  }

  // ---- editing ---------------------------------------------------------------------------------
  const canEdit = (row: number, col: number): boolean =>
    !!editing && editing.rowState?.(row) !== 'deleted' && editing.isEditable(row, col)

  const startEdit = (row: number, col: number): void => {
    if (!canEdit(row, col)) return
    const value = rows[row]?.[col]
    setEditingCell({
      row,
      col,
      draft: value === null || value === undefined ? '' : cellToText(value)
    })
  }

  const commitEdit = (setNull = false, move?: GridCellPos): void => {
    if (!editingCell || !editing) return
    const original = rows[editingCell.row]?.[editingCell.col]
    const { changed, value } = resolveCellEdit(editingCell.draft, setNull, original)
    if (changed) editing.onCommitEdit(editingCell.row, editingCell.col, value)
    setEditingCell(null)
    if (move) moveTo(move, false)
    scrollRef.current?.focus()
  }

  const selectedRows = (): number[] => {
    if (!selection) return []
    const { r0, r1 } = rect(selection)
    return Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i)
  }

  // ---- keyboard --------------------------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (editingCell) return
    if (e.target !== e.currentTarget) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key
    if (mod && key.toLowerCase() === 'a') {
      e.preventDefault()
      if (rows.length && columns.length) {
        setSelection({
          anchor: { row: 0, col: 0 },
          focus: { row: rows.length - 1, col: columns.length - 1 }
        })
      }
      return
    }
    if (mod && key.toLowerCase() === 'c') {
      e.preventDefault()
      copySelectionTsv(false)
      return
    }
    if (key === ' ' && rowDetail && !e.shiftKey && !mod) {
      e.preventDefault()
      const opening = !rowDetail.open
      rowDetail.onOpenChange(opening)
      if (opening && !selection) moveTo({ row: 0, col: 0 }, false)
      return
    }
    if (!selection) {
      if (/^Arrow/.test(key) && rows.length && columns.length) {
        e.preventDefault()
        moveTo({ row: 0, col: 0 }, false)
      }
      return
    }
    const f = selection.focus
    const page = Math.max(
      1,
      Math.floor((scrollRef.current?.clientHeight ?? 240) / GRID_ROW_HEIGHT) - 1
    )
    const moves: Record<string, GridCellPos> = {
      ArrowUp: { row: mod ? 0 : f.row - 1, col: f.col },
      ArrowDown: { row: mod ? rows.length - 1 : f.row + 1, col: f.col },
      ArrowLeft: { row: f.row, col: mod ? 0 : f.col - 1 },
      ArrowRight: { row: f.row, col: mod ? columns.length - 1 : f.col + 1 },
      PageUp: { row: f.row - page, col: f.col },
      PageDown: { row: f.row + page, col: f.col },
      Home: { row: mod ? 0 : f.row, col: 0 },
      End: { row: mod ? rows.length - 1 : f.row, col: columns.length - 1 }
    }
    if (moves[key]) {
      e.preventDefault()
      moveTo(moves[key], e.shiftKey)
      return
    }
    if (key === 'Enter' || key === 'F2') {
      e.preventDefault()
      if (canEdit(f.row, f.col)) startEdit(f.row, f.col)
      else setInspector(f)
      return
    }
    if (key === ' ') {
      e.preventDefault()
      setInspector(f)
      return
    }
    if ((key === 'Delete' || key === 'Backspace') && editing?.onDeleteRows) {
      e.preventDefault()
      editing.onDeleteRows(selectedRows())
      return
    }
    if (key === 'Escape' && selection) {
      setSelection(null)
    }
  }

  // ---- mouse (delegated) -----------------------------------------------------------------------
  const cellFromEvent = (target: EventTarget | null): GridCellPos | null => {
    const el = (target as HTMLElement | null)?.closest?.('[data-cell]') as HTMLElement | null
    if (!el) return null
    const row = Number(el.dataset.row)
    const col = Number(el.dataset.col)
    return Number.isInteger(row) && Number.isInteger(col) ? { row, col } : null
  }
  const rowNumberFromEvent = (target: EventTarget | null): number | null => {
    const el = (target as HTMLElement | null)?.closest?.('[data-row-number]') as HTMLElement | null
    return el ? Number(el.dataset.rowNumber) : null
  }

  const onBodyMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-cell-editor]')) return
    const rowNumber = rowNumberFromEvent(e.target)
    if (rowNumber !== null && columns.length) {
      const last = columns.length - 1
      setSelection((s) =>
        e.shiftKey && s
          ? { anchor: { row: s.anchor.row, col: 0 }, focus: { row: rowNumber, col: last } }
          : { anchor: { row: rowNumber, col: 0 }, focus: { row: rowNumber, col: last } }
      )
      draggingRef.current = 'rows'
      return
    }
    const cell = cellFromEvent(e.target)
    if (!cell) return
    // An open inline editor commits on its own blur, which follows this mousedown.
    setSelection((s) =>
      e.shiftKey && s ? { anchor: s.anchor, focus: cell } : { anchor: cell, focus: cell }
    )
    draggingRef.current = 'cells'
  }

  const onBodyMouseOver = (e: React.MouseEvent): void => {
    if (!draggingRef.current || e.buttons !== 1) return
    if (draggingRef.current === 'rows') {
      const rowNumber = rowNumberFromEvent(e.target) ?? cellFromEvent(e.target)?.row ?? null
      if (rowNumber === null) return
      setSelection((s) =>
        s ? { anchor: s.anchor, focus: { row: rowNumber, col: columns.length - 1 } } : s
      )
      return
    }
    const cell = cellFromEvent(e.target)
    if (cell)
      setSelection((s) =>
        s && (s.focus.row !== cell.row || s.focus.col !== cell.col)
          ? { anchor: s.anchor, focus: cell }
          : s
      )
  }

  useEffect(() => {
    const up = (): void => {
      draggingRef.current = null
    }
    document.addEventListener('mouseup', up)
    return () => document.removeEventListener('mouseup', up)
  }, [])

  const onBodyDoubleClick = (e: React.MouseEvent): void => {
    const cell = cellFromEvent(e.target)
    if (!cell) return
    if (canEdit(cell.row, cell.col)) startEdit(cell.row, cell.col)
    else setInspector(cell)
  }

  const onContextMenuCapture = (e: React.MouseEvent): void => {
    const headerEl = (e.target as HTMLElement).closest?.('[data-header-col]') as HTMLElement | null
    if (headerEl) {
      setMenuTarget({ kind: 'header', col: Number(headerEl.dataset.headerCol) })
      return
    }
    const rowNumber = rowNumberFromEvent(e.target)
    const cell = cellFromEvent(e.target) ?? (rowNumber !== null ? { row: rowNumber, col: 0 } : null)
    if (!cell) {
      setMenuTarget(null)
      return
    }
    if (!isSelected(cell.row, cell.col)) {
      setSelection(
        rowNumber !== null
          ? {
              anchor: { row: rowNumber, col: 0 },
              focus: { row: rowNumber, col: columns.length - 1 }
            }
          : { anchor: cell, focus: cell }
      )
    }
    setMenuTarget({ kind: 'cell', row: cell.row, col: cell.col })
  }

  // ---- column resize ---------------------------------------------------------------------------
  const startResize = (e: React.MouseEvent, col: number): void => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = widths[col] ?? 120
    const move = (ev: MouseEvent): void => {
      const next = Math.max(MIN_COLUMN_WIDTH, Math.min(2000, startWidth + ev.clientX - startX))
      setWidthState((s) => ({ ...s, widths: s.widths.map((w, i) => (i === col ? next : w)) }))
    }
    const up = (): void => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.classList.remove('resize-active')
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    document.body.classList.add('resize-active')
  }

  const autoFit = (col: number): void => {
    const c = columns[col]
    if (!c) return
    const width = estimateColumnWidth(
      c.name,
      c.type,
      (function* () {
        for (let r = 0; r < Math.min(rows.length, 1000); r++) yield rows[r][col]
      })(),
      1000
    )
    setWidthState((s) => ({ ...s, widths: s.widths.map((w, i) => (i === col ? width : w)) }))
  }

  // ---- render ----------------------------------------------------------------------------------
  const totalWidth = colVirtualizer.getTotalSize() + rowNumberWidth
  const virtualCols = colVirtualizer.getVirtualItems()
  const virtualRows = rowVirtualizer.getVirtualItems()
  const sortCount = sortedColumns ? sortedColumns.length : (sort?.length ?? 0)
  const sortIndex = (name: string, col: number): { dir: 'asc' | 'desc'; n: number } | null => {
    if (sortedColumns) {
      const i = sortedColumns.findIndex((s) => s.col === col)
      return i >= 0 ? { dir: sortedColumns[i].direction, n: i + 1 } : null
    }
    const i = sort?.findIndex((s) => s.column === name) ?? -1
    return i >= 0 && sort ? { dir: sort[i].direction, n: i + 1 } : null
  }
  const numericCols = useMemo(
    () =>
      columns.map((c, i) => NUMERIC_TYPE.test(c.type ?? '') || typeof rows[0]?.[i] === 'number'),
    [columns, rows]
  )

  const renderValue = (value: DataCell | undefined, row: number, col: number): React.ReactNode => {
    const state = editing?.cellState?.(row, col)
    if (state === 'default') return <span className="italic text-muted-foreground/60">DEFAULT</span>
    // A field the document does not have (Mongo table view), unlike a stored null.
    if (value === undefined)
      return (
        <span className="text-muted-foreground/40" title="Field not present in this document">
          —
        </span>
      )
    const kind = cellKind(value)
    if (kind === 'null') return <span className="italic text-muted-foreground/55">NULL</span>
    if (kind === 'binary') {
      return (
        <span className="text-violet-600 dark:text-violet-300/90">
          {binaryPreview(value as never)}
        </span>
      )
    }
    if (kind === 'boolean') {
      return (
        <span
          className={
            value ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
          }
        >
          {value ? 'true' : 'false'}
        </span>
      )
    }
    return cellDisplayText(value)
  }

  const menuCell =
    menuTarget?.kind === 'cell'
      ? { value: rows[menuTarget.row]?.[menuTarget.col], column: columns[menuTarget.col] }
      : null
  const menuCol = menuTarget?.kind === 'cell' ? menuTarget.col : 0
  const inspectorValue = inspector ? rows[inspector.row]?.[inspector.col] : undefined
  const inspectorEditable = inspector ? canEdit(inspector.row, inspector.col) : false

  return (
    <div className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      <ContextMenu onOpenChange={(open) => !open && scrollRef.current?.focus()}>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            tabIndex={0}
            role="grid"
            aria-rowcount={rows.length}
            aria-colcount={columns.length}
            data-db-grid=""
            data-testid={testId}
            onKeyDown={onKeyDown}
            onContextMenuCapture={onContextMenuCapture}
            className="relative min-h-0 flex-1 overflow-auto font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/40"
          >
            <div style={{ width: totalWidth, minWidth: '100%' }}>
              {/* Header */}
              <div
                className="sticky top-0 z-20 flex border-b border-border bg-card"
                style={{ height: GRID_HEADER_HEIGHT, width: totalWidth, minWidth: '100%' }}
                role="row"
              >
                <div
                  className="sticky left-0 z-30 flex shrink-0 items-center justify-center border-r border-border bg-card"
                  style={{ width: rowNumberWidth, height: GRID_HEADER_HEIGHT }}
                >
                  {visibility.hidden.length > 0 && (
                    <button
                      type="button"
                      onClick={visibility.onShowAll}
                      title={`Hidden: ${visibility.hidden.map((h) => h.name).join(', ')} · click to show all`}
                      data-testid="data-project-grid-show-hidden"
                      className="flex items-center gap-0.5 rounded px-1 font-sans text-[10px] text-amber-600 hover:bg-accent dark:text-amber-400"
                    >
                      <EyeOff className="h-3 w-3" />
                      {visibility.hidden.length}
                    </button>
                  )}
                </div>
                <div
                  className="relative"
                  style={{ width: colVirtualizer.getTotalSize(), height: GRID_HEADER_HEIGHT }}
                >
                  {virtualCols.map((vc) => {
                    const column = columns[vc.index]
                    const sorted = sortIndex(column.name, vc.index)
                    return (
                      <div
                        key={vc.key}
                        role="columnheader"
                        data-header-col={vc.index}
                        data-testid={`data-project-grid-header-${vc.index}`}
                        title={column.type ? `${column.name} · ${column.type}` : column.name}
                        onClick={(e) =>
                          onSortColumn?.(column.name, e.shiftKey || e.metaKey, vc.index)
                        }
                        className={cn(
                          'group absolute top-0 flex h-full select-none items-center gap-1 border-r border-border px-2 font-sans text-[12px] font-semibold text-foreground',
                          onSortColumn && 'cursor-pointer hover:bg-accent/40'
                        )}
                        style={{ left: vc.start, width: vc.size }}
                      >
                        <span className="truncate">{column.name}</span>
                        {column.type && (
                          <span className="hidden truncate font-mono text-[10px] font-normal text-muted-foreground/70 group-hover:inline">
                            {column.type}
                          </span>
                        )}
                        {sorted && (
                          <span className="ml-auto flex shrink-0 items-center text-muted-foreground">
                            {sorted.dir === 'asc' ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : (
                              <ArrowDown className="h-3 w-3" />
                            )}
                            {sortCount > 1 && <span className="text-[9px]">{sorted.n}</span>}
                          </span>
                        )}
                        <div
                          role="separator"
                          aria-orientation="vertical"
                          data-testid={`data-project-grid-resize-${vc.index}`}
                          onMouseDown={(e) => startResize(e, vc.index)}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            autoFit(vc.index)
                          }}
                          className="absolute right-[-3px] top-0 z-10 h-full w-[6px] cursor-col-resize hover:bg-ring/40"
                        />
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Body */}
              {rows.length === 0 ? (
                <div
                  className="sticky left-0 flex h-16 items-center px-3 font-sans text-[12px] text-muted-foreground"
                  style={{ width: scrollRef.current?.clientWidth ?? '100%' }}
                  data-testid="data-project-result-grid-empty"
                >
                  {columns.length === 0 ? 'No columns' : emptyMessage}
                </div>
              ) : (
                <div
                  className="relative"
                  style={{ height: rowVirtualizer.getTotalSize(), width: totalWidth }}
                  onMouseDown={onBodyMouseDown}
                  onMouseOver={onBodyMouseOver}
                  onDoubleClick={onBodyDoubleClick}
                >
                  {virtualRows.map((vr) => {
                    const row = rows[vr.index]
                    const rowState = editing?.rowState?.(vr.index) ?? null
                    const rowSelected = selection
                      ? vr.index >= rect(selection).r0 && vr.index <= rect(selection).r1
                      : false
                    return (
                      <div
                        key={vr.key}
                        role="row"
                        data-testid={`data-project-grid-row-${vr.index}`}
                        data-row-state={rowState ?? undefined}
                        className={cn(
                          'absolute left-0 flex',
                          rowState === 'deleted' &&
                            'bg-red-500/10 text-muted-foreground line-through decoration-red-500/60',
                          rowState === 'inserted' && 'bg-emerald-500/10',
                          !rowState && vr.index % 2 === 1 && 'bg-foreground/[0.018]'
                        )}
                        style={{ top: vr.start, height: GRID_ROW_HEIGHT, width: totalWidth }}
                      >
                        <div
                          data-row-number={vr.index}
                          className={cn(
                            'sticky left-0 z-10 flex shrink-0 cursor-default select-none items-center justify-end border-r border-border bg-card pr-2 text-[11px] tabular-nums text-muted-foreground/70',
                            rowSelected &&
                              'bg-[color-mix(in_srgb,var(--foreground)_8%,var(--card))] text-foreground'
                          )}
                          style={{ width: rowNumberWidth, height: GRID_ROW_HEIGHT }}
                        >
                          {rowState === 'inserted' ? '+' : rowNumberOffset + vr.index + 1}
                        </div>
                        <div
                          className="relative"
                          style={{
                            width: colVirtualizer.getTotalSize(),
                            height: GRID_ROW_HEIGHT
                          }}
                        >
                          {virtualCols.map((vc) => {
                            const value = row?.[vc.index]
                            const selected = isSelected(vr.index, vc.index)
                            const isFocus =
                              selection?.focus.row === vr.index && selection.focus.col === vc.index
                            const cellState = editing?.cellState?.(vr.index, vc.index) ?? null
                            const isEditing =
                              editingCell?.row === vr.index && editingCell.col === vc.index
                            return (
                              <div
                                key={vc.key}
                                role="gridcell"
                                data-cell=""
                                data-row={vr.index}
                                data-col={vc.index}
                                data-cell-state={cellState ?? undefined}
                                className={cn(
                                  'absolute top-0 flex h-full items-center overflow-hidden whitespace-nowrap border-b border-r border-border/60 px-2',
                                  numericCols[vc.index] && 'justify-end tabular-nums',
                                  cellState === 'modified' &&
                                    'bg-amber-500/20 shadow-[inset_2px_0_0_rgb(245_158_11)]',
                                  selected && 'bg-sky-500/15 dark:bg-sky-400/20',
                                  isFocus &&
                                    'outline outline-1 -outline-offset-1 outline-sky-500/80'
                                )}
                                style={{ left: vc.start, width: vc.size }}
                              >
                                {isEditing && editingCell ? (
                                  <CellEditor
                                    draft={editingCell.draft}
                                    onDraft={(draft) => setEditingCell({ ...editingCell, draft })}
                                    onCommit={(move) =>
                                      commitEdit(
                                        false,
                                        move === 'right'
                                          ? {
                                              row: vr.index,
                                              col: Math.min(columns.length - 1, vc.index + 1)
                                            }
                                          : move === 'down'
                                            ? {
                                                row: Math.min(rows.length - 1, vr.index + 1),
                                                col: vc.index
                                              }
                                            : undefined
                                      )
                                    }
                                    onSetNull={() => commitEdit(true)}
                                    onCancel={() => {
                                      setEditingCell(null)
                                      scrollRef.current?.focus()
                                    }}
                                  />
                                ) : (
                                  <span className="truncate">
                                    {renderValue(value, vr.index, vc.index)}
                                  </span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[220px]" data-testid="data-project-grid-menu">
          {menuTarget?.kind === 'header' ? (
            <>
              <ContextMenuItem
                onSelect={() => void copyText(columns[menuTarget.col]?.name ?? '', 'Column name')}
                data-testid="data-project-grid-menu-copy-column-name"
              >
                <ClipboardCopy className="mr-2 h-4 w-4" />
                Copy column name
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  void copyText(rows.map((r) => cellToText(r[menuTarget.col])).join('\n'), 'Column')
                }
                data-testid="data-project-grid-menu-copy-column-values"
              >
                Copy column values
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  rows.length &&
                  setSelection({
                    anchor: { row: 0, col: menuTarget.col },
                    focus: { row: rows.length - 1, col: menuTarget.col }
                  })
                }
              >
                Select column
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => autoFit(menuTarget.col)}>
                Auto-fit width
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={columns.length < 2}
                onSelect={() => visibility.onHide(menuTarget.col)}
                data-testid="data-project-grid-menu-hide-column"
              >
                <EyeOff className="mr-2 h-4 w-4" />
                Hide column
              </ContextMenuItem>
              {visibility.hidden.length > 0 && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger data-testid="data-project-grid-menu-show-columns">
                    <Eye className="mr-2 h-4 w-4" />
                    Show hidden ({visibility.hidden.length})
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="max-h-80 overflow-y-auto">
                    <ContextMenuItem
                      onSelect={visibility.onShowAll}
                      data-testid="data-project-grid-menu-show-all"
                    >
                      Show all
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {visibility.hidden.map((h) => (
                      <ContextMenuItem key={h.col} onSelect={() => visibility.onShow(h.col)}>
                        {h.name}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
            </>
          ) : menuCell ? (
            <>
              <ContextMenuItem
                onSelect={() => void copyText(cellToText(menuCell.value), 'Value')}
                data-testid="data-project-grid-menu-copy-cell"
              >
                <ClipboardCopy className="mr-2 h-4 w-4" />
                Copy cell
                <ContextMenuShortcut>⌘C</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  const sel = selectedRows()
                  void copyText(
                    formatRows(
                      'tsv',
                      columns,
                      sel.map((r) => rows[r])
                    ),
                    `${sel.length} ${sel.length === 1 ? 'row' : 'rows'}`
                  )
                }}
                data-testid="data-project-grid-menu-copy-row"
              >
                Copy {selectedRows().length > 1 ? 'rows' : 'row'}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  void copyText(rows.map((r) => cellToText(r[menuCol])).join('\n'), 'Column')
                }
                data-testid="data-project-grid-menu-copy-column"
              >
                Copy column
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger data-testid="data-project-grid-menu-copy-as">
                  Copy as
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem
                    onSelect={() => copyAs('tsv')}
                    data-testid="data-project-grid-menu-copy-tsv"
                  >
                    TSV (with header)
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => copyAs('csv')}
                    data-testid="data-project-grid-menu-copy-csv"
                  >
                    CSV
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => copyAs('json')}
                    data-testid="data-project-grid-menu-copy-json"
                  >
                    JSON
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => copyAs('sql')}
                    data-testid="data-project-grid-menu-copy-sql"
                  >
                    SQL INSERT
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => copyAs('markdown')}
                    data-testid="data-project-grid-menu-copy-markdown"
                  >
                    Markdown
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSeparator />
              {onFilterByValue && menuCell.column && (
                <ContextMenuItem
                  onSelect={() =>
                    onFilterByValue(menuCell.column.name, menuCell.value ?? null, menuCol)
                  }
                  data-testid="data-project-grid-menu-filter"
                >
                  <Filter className="mr-2 h-4 w-4" />
                  Filter by this value
                </ContextMenuItem>
              )}
              <ContextMenuItem
                onSelect={() =>
                  menuTarget?.kind === 'cell' &&
                  setInspector({ row: menuTarget.row, col: menuTarget.col })
                }
                data-testid="data-project-grid-menu-inspect"
              >
                <Braces className="mr-2 h-4 w-4" />
                Open cell inspector
                <ContextMenuShortcut>{rowDetail ? '⇧Space' : 'Space'}</ContextMenuShortcut>
              </ContextMenuItem>
              {rowDetail && (
                <ContextMenuItem
                  onSelect={() => rowDetail.onOpenChange(!rowDetail.open)}
                  data-testid="data-project-grid-menu-row-detail"
                >
                  <PanelRight className="mr-2 h-4 w-4" />
                  {rowDetail.open ? 'Hide row detail' : 'Show row detail'}
                  <ContextMenuShortcut>Space</ContextMenuShortcut>
                </ContextMenuItem>
              )}
              {editing &&
                menuTarget?.kind === 'cell' &&
                canEdit(menuTarget.row, menuTarget.col) && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onSelect={() => startEdit(menuTarget.row, menuTarget.col)}
                      data-testid="data-project-grid-menu-edit"
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit cell
                      <ContextMenuShortcut>↵</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => editing.onCommitEdit(menuTarget.row, menuTarget.col, null)}
                      data-testid="data-project-grid-menu-set-null"
                    >
                      Set NULL
                    </ContextMenuItem>
                  </>
                )}
              {editing?.onDeleteRows && (
                <ContextMenuItem
                  onSelect={() => editing.onDeleteRows?.(selectedRows())}
                  className="text-red-500 focus:text-red-500"
                  data-testid="data-project-grid-menu-delete-rows"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {editing.rowState?.(menuTarget?.kind === 'cell' ? menuTarget.row : -1) ===
                  'deleted'
                    ? 'Restore row'
                    : selectedRows().length > 1
                      ? `Delete ${selectedRows().length} rows`
                      : 'Delete row'}
                  <ContextMenuShortcut>⌫</ContextMenuShortcut>
                </ContextMenuItem>
              )}
            </>
          ) : (
            <ContextMenuItem disabled>No cell</ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <CellInspector
        open={inspector !== null}
        onOpenChange={(open) => {
          if (!open) {
            setInspector(null)
            scrollRef.current?.focus()
          }
        }}
        column={inspector ? (columns[inspector.col] ?? null) : null}
        value={inspectorValue}
        onApply={
          inspector && inspectorEditable && editing
            ? (value) => editing.onCommitEdit(inspector.row, inspector.col, value)
            : undefined
        }
      />
    </div>
  )
})

/** Inline single-line cell editor (Enter commits, Tab commits and moves right, Esc cancels). */
function CellEditor({
  draft,
  onDraft,
  onCommit,
  onSetNull,
  onCancel
}: {
  draft: string
  onDraft: (draft: string) => void
  onCommit: (move?: 'right' | 'down') => void
  onSetNull: () => void
  onCancel: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const doneRef = useRef(false)
  // An <input> silently drops line breaks, so a multi-line value is edited in a textarea that
  // grows over the rows below (Enter commits, Shift/Option+Enter inserts a line break).
  const [multiline] = useState(() => /[\r\n]/.test(draft))
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const finish = (fn: () => void): void => {
    if (doneRef.current) return
    doneRef.current = true
    fn()
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      if (multiline && (e.shiftKey || e.altKey)) return
      e.preventDefault()
      finish(() => onCommit('down'))
    } else if (e.key === 'Tab') {
      e.preventDefault()
      finish(() => onCommit('right'))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(onCancel)
    }
  }
  const editorClass =
    'min-w-0 flex-1 bg-transparent px-2 font-mono text-[12px] outline outline-2 -outline-offset-2 outline-sky-500'
  return (
    <div
      data-cell-editor=""
      className={cn(
        'absolute inset-x-0 top-0 z-10 flex bg-background',
        multiline ? 'items-start shadow-lg' : 'bottom-0 items-center'
      )}
    >
      {multiline ? (
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          spellCheck={false}
          rows={Math.min(8, Math.max(3, draft.split('\n').length))}
          title="Enter saves · Shift+Enter adds a line break"
          data-testid="data-project-grid-cell-input"
          className={cn(editorClass, 'resize-y py-1 leading-snug')}
          onKeyDown={onKeyDown}
          onBlur={() => finish(() => onCommit())}
        />
      ) : (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          spellCheck={false}
          data-testid="data-project-grid-cell-input"
          className={cn(editorClass, 'h-full')}
          onKeyDown={onKeyDown}
          onBlur={() => finish(() => onCommit())}
        />
      )}
      <button
        type="button"
        title="Set NULL"
        onMouseDown={(e) => {
          e.preventDefault()
          finish(onSetNull)
        }}
        data-testid="data-project-grid-cell-set-null"
        className="mr-0.5 h-5 shrink-0 rounded-[4px] border border-border px-1 font-sans text-[10px] text-muted-foreground hover:text-foreground"
      >
        NULL
      </button>
    </div>
  )
}
