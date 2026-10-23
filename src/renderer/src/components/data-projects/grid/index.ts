// Result grid (virtualized rows + columns), cell inspector, row detail panel, the copy/export text
// formats and the client-side sort / quick filter of loaded rows.
export {
  GRID_HEADER_HEIGHT,
  GRID_ROW_HEIGHT,
  ResultGrid,
  type GridCellPos,
  type GridCellState,
  type GridRowState,
  type ResultGridEditing,
  type ResultGridHandle,
  type ResultGridProps,
  type ResultGridRowDetail
} from './ResultGrid'
export { CellInspector, type CellInspectorProps } from './CellInspector'
export { RowDetailPanel, type RowDetailPanelProps } from './RowDetailPanel'
export {
  fieldDraft,
  resolveFieldDraft,
  useRowDetailOpen,
  type FieldCommit,
  type FieldDraft
} from './row-detail'
export {
  formatRows,
  rowToJson,
  toCsv,
  toJson,
  toMarkdown,
  toSqlInserts,
  toTsv,
  uniqueColumnKeys,
  type CopyFormat,
  type CsvOptions,
  type SqlInsertOptions
} from './export-format'
export {
  binaryPreview,
  cellDisplayText,
  cellKind,
  cellToText,
  estimateColumnWidth,
  hexDump,
  parseEditedValue,
  resolveCellEdit,
  tryParseJson,
  type CellKind
} from './cell-format'
export {
  applyClientView,
  compareDecimalStrings,
  EMPTY_CLIENT_VIEW,
  filterRowIndexes,
  isClientFilterActive,
  isClientViewActive,
  nextClientSort,
  sortRowIndexes,
  withValueFilter,
  type ClientSort,
  type ClientValueFilter,
  type ClientView
} from './client-view'
