// CodeMirror extensions of the Mongo Shell tab, on top of the shared QueryEditor:
// - mongoShellLinter: underlines what the shell cannot run (the shared structural parser's
//   error per statement: unsupported method, JS that is not a literal, syntax errors), before
//   anything is sent.
// - mongoCursorStatement: reports the statement under the cursor (debounced) so the toolbar can
//   show its READ / WRITE / DDL badge from the shared classifier.
// - mongoStatementRange: what ⌘↵ runs (the shared splitter's statement at the cursor).

import { linter, type Diagnostic } from '@codemirror/lint'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  isMongoShellParseError,
  mongoStatementAtOffset,
  parseMongoShellStructure,
  splitMongoShell,
  type MongoShellSpan
} from '@shared/data-projects/mongo-shell'

/** End of the token starting at `offset` (for a readable underline). */
function tokenEnd(text: string, offset: number): number {
  let end = offset
  while (end < text.length && /[\w$.]/.test(text[end])) end++
  return Math.max(end, Math.min(text.length, offset + 1))
}

/** Parse errors of every statement, as diagnostics (pure; exported for tests). */
export function mongoShellDiagnostics(doc: string): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const span of splitMongoShell(doc)) {
    const result = parseMongoShellStructure(span.text)
    if (!isMongoShellParseError(result)) continue
    const at = Math.max(0, Math.min(result.error.offset, span.text.length))
    const from = span.start + Math.min(at, Math.max(0, span.text.length - 1))
    const to = Math.min(span.end, span.start + tokenEnd(span.text, at))
    out.push({
      from,
      to: Math.max(to, from + 1),
      severity: 'error',
      source: 'mongo shell',
      message: result.error.message
    })
  }
  return out
}

export const mongoShellLinter = (): Extension =>
  linter((view) => mongoShellDiagnostics(view.state.doc.toString()), { delay: 350 })

/** Calls `onStatement` with the statement under the cursor whenever it may have changed. */
export function mongoCursorStatement(
  onStatement: (span: MongoShellSpan | null) => void
): Extension {
  let timer: ReturnType<typeof setTimeout> | null = null
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet && !update.focusChanged) return
    if (timer) clearTimeout(timer)
    const state = update.state
    timer = setTimeout(() => {
      timer = null
      const sel = state.selection.main
      if (!sel.empty) {
        const text = state.sliceDoc(sel.from, sel.to).trim()
        onStatement(text ? { text, start: sel.from, end: sel.to } : null)
        return
      }
      onStatement(mongoStatementAtOffset(state.doc.toString(), sel.head))
    }, 120)
  })
}

export function mongoStatementRange(
  doc: string,
  offset: number
): { from: number; to: number } | null {
  const span = mongoStatementAtOffset(doc, offset)
  return span ? { from: span.start, to: span.end } : null
}
