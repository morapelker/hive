// MongoDB workspace of data projects (mongo-ui). DataProjectWorkspaceHost lazy-loads
// ./MongoWorkspace directly; this barrel is for everything else.
export { MongoWorkspace, type MongoWorkspaceProps } from './MongoWorkspace'
export {
  DocumentResults,
  DocumentViewToggle,
  HighlightedCode,
  type DocumentActions
} from './DocumentResults'
export {
  MongoCodeEditor,
  type MongoCodeEditorHandle,
  type MongoCodeEditorProps
} from './MongoCodeEditor'
export {
  MONGO_TYPE_CLASS,
  MONGO_TYPE_LABEL,
  formatShellDocument,
  formatShellInline,
  formatShellValue,
  mongoTypeLabel,
  mongoValueType,
  toGridCell,
  toRelaxedEjson,
  toRelaxedJsonText,
  type MongoValueType
} from './ejson'
export {
  analyzeMongoCompletion,
  mongoCompletionItems,
  type MongoCompletionData
} from './mongo-completion'
export { createMongoCompletionSource } from './mongo-completion-source'
