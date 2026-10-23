// What the assistant knows about the user's workspace: the active database/schema and the text
// of the active editor tab, read from the SQL workspace store (sql-ui) or the Mongo workspace
// store (mongo-ui). Both stores export `getActiveContext(projectId)`; this module is the only
// place the assistant touches them, so the store and the panel stay testable with one mock.
//
// The lookup is tolerant on purpose (a module-level export or a store method of that name both
// work, and a throwing/missing reader means "no context") because a broken context must never
// stop the user from asking a question.

import { useDataWorkspaceStore } from '@/stores/useDataWorkspaceStore'
import * as sqlWorkspaceModule from '@/stores/useDataWorkspaceStore'
import { useMongoWorkspaceStore } from '@/stores/useMongoWorkspaceStore'
import * as mongoWorkspaceModule from '@/stores/useMongoWorkspaceStore'
import type { DataEngineFamily } from '@shared/data-projects/types'

export interface AssistantActiveContext {
  database?: string
  schema?: string
  /** Text of the active query / shell tab ('' when it is empty). */
  editorText?: string
}

type ContextReader = (projectId: string) => AssistantActiveContext | null | undefined

function readerOf(module: unknown, store: unknown): ContextReader | null {
  const exported = (module as { getActiveContext?: unknown }).getActiveContext
  if (typeof exported === 'function') return exported as ContextReader
  const state = (
    store as { getState?: () => { getActiveContext?: unknown } } | undefined
  )?.getState?.()
  return typeof state?.getActiveContext === 'function'
    ? (state.getActiveContext as ContextReader)
    : null
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** The active database, schema and editor text of a data project's workspace. */
export function readAssistantContext(
  projectId: string,
  family: DataEngineFamily
): AssistantActiveContext {
  try {
    const reader =
      family === 'document'
        ? readerOf(mongoWorkspaceModule, useMongoWorkspaceStore)
        : readerOf(sqlWorkspaceModule, useDataWorkspaceStore)
    const context = reader?.(projectId)
    if (!context) return {}
    const database = text(context.database)
    const schema = text(context.schema)
    return {
      ...(database ? { database } : {}),
      ...(schema ? { schema } : {}),
      editorText: typeof context.editorText === 'string' ? context.editorText : ''
    }
  } catch {
    return {}
  }
}

/** Re-renders when the active database of the project's workspace changes. */
export function useAssistantActiveDatabase(
  projectId: string,
  family: DataEngineFamily
): string | undefined {
  // Both hooks always run (rules of hooks); only the family's store feeds the value.
  const sqlDatabase = useDataWorkspaceStore(() =>
    family === 'sql' ? readAssistantContext(projectId, 'sql').database : undefined
  )
  const mongoDatabase = useMongoWorkspaceStore(() =>
    family === 'document' ? readAssistantContext(projectId, 'document').database : undefined
  )
  return family === 'document' ? mongoDatabase : sqlDatabase
}
