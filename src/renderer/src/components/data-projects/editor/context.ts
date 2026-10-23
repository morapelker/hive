// Per-editor configuration that completion sources and the statement highlighter read from the
// editor state. It lives in a Compartment of QueryEditor, so a schema refresh or a dialect switch
// is one `reconfigure` and the (configure-once) autocompletion extension never changes.

import type { CompletionSource } from '@codemirror/autocomplete'
import { Facet } from '@codemirror/state'
import type { SqlDialect } from '@shared/data-projects/types'
import type { SqlCompletionIndex } from './sql-completion'

export type QueryEditorLanguage = 'sql' | 'mongo'
export type KeywordCase = 'upper' | 'lower'

export interface StatementRange {
  from: number
  to: number
}

export interface DataEditorConfig {
  language: QueryEditorLanguage
  dialect: SqlDialect | null
  completionIndex: SqlCompletionIndex | null
  keywordCase: KeywordCase
  /** Extra completion sources (mongo-ui supplies its own for the shell language). */
  extraSources: readonly CompletionSource[]
  /** Statement under the cursor (Cmd+Enter target and the highlighted band). */
  statementRange: ((doc: string, offset: number) => StatementRange | null) | null
}

const DEFAULT_CONFIG: DataEditorConfig = {
  language: 'sql',
  dialect: null,
  completionIndex: null,
  keywordCase: 'upper',
  extraSources: [],
  statementRange: null
}

export const dataEditorConfig = Facet.define<DataEditorConfig, DataEditorConfig>({
  combine: (values) => (values.length ? values[values.length - 1] : DEFAULT_CONFIG)
})
