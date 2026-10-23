// CodeMirror base of the data-project editors (SQL query tabs, DDL viewer, Mongo shell).
export { QueryEditor, type QueryEditorHandle, type QueryEditorProps } from './QueryEditor'
export { runTargetFor, type QueryEditorRunTarget, type QueryRunMode } from './run-target'
export {
  dataEditorConfig,
  type KeywordCase,
  type QueryEditorLanguage,
  type StatementRange
} from './context'
export { setEditorError, type EditorErrorRange } from './decorations'
export {
  ClickHouseDialect,
  CM_SQL_DIALECTS,
  cmSqlDialect,
  explainPrefix,
  isExplainStatement,
  SQL_FUNCTIONS
} from './dialects'
export { formatEditorSql, formatSql, formatSqlChanges, type FormatKeywordCase } from './format'
export {
  analyzeSqlCompletion,
  buildSqlCompletionIndex,
  completionStatement,
  identifierText,
  resolveTable,
  sqlKeywordCompletionSource,
  sqlSchemaCompletions,
  sqlSchemaCompletionSource,
  type CompletionWant,
  type ScopeRef,
  type SqlCompletionAnalysis,
  type SqlCompletionIndex
} from './sql-completion'
export { dataEditorHighlighter, dataEditorTheme } from './theme'
