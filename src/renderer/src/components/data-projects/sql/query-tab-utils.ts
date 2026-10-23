// Pure helpers of the query tab (kept out of the component file for fast refresh).

import type { DataStatementResult } from '@shared/data-projects/types'
import type { DataTabOrigin } from '@/stores/useDataWorkspaceStore'
import type { EditorErrorRange } from '../editor/decorations'

export const LIMIT_OPTIONS: readonly number[] = [100, 500, 1000, 5000, 10000, 0]

export const ORIGIN_LABEL: Readonly<Record<DataTabOrigin, string>> = {
  assistant: 'AI assistant',
  history: 'History',
  saved: 'Saved query',
  schema: 'Schema'
}

const TOKEN_AT = /^(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|'(?:[^']|'')*'|[\w$]+)/

/** Editor range for a statement's error: the token at its position, else its first line. */
export function errorRangeFor(
  statement: DataStatementResult,
  runFrom: number,
  doc: string
): EditorErrorRange | null {
  if (!statement.error) return null
  const base = runFrom + statement.start
  const detail = [statement.error.message, statement.error.hint && `Hint: ${statement.error.hint}`]
    .filter(Boolean)
    .join('\n')
  if (statement.error.position !== undefined) {
    const from = Math.max(0, base + statement.error.position)
    const token = TOKEN_AT.exec(doc.slice(from, from + 200))?.[0]
    return { from, to: from + Math.max(1, token?.length ?? 1), message: detail }
  }
  const firstLine = statement.text.split('\n')[0] ?? ''
  return { from: base, to: base + Math.max(1, firstLine.length), message: detail }
}
