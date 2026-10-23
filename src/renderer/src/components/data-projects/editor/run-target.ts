// What Run (Mod-Enter) and Run all (Shift-Mod-Enter) execute for an editor state: the selection
// when there is one, else the statement under the cursor (the config's `statementRange`, the shared
// SQL splitter by default), or the whole document.

import type { EditorState } from '@codemirror/state'
import { dataEditorConfig } from './context'

export type QueryRunMode = 'current' | 'selection' | 'all'

export interface QueryEditorRunTarget {
  text: string
  /** Offsets of `text` in the document (error positions are mapped back through them). */
  from: number
  to: number
  mode: QueryRunMode
}

/** The run target for `mode` in `state`; null when there is nothing to run. */
export function runTargetFor(
  state: EditorState,
  mode: 'current' | 'all'
): QueryEditorRunTarget | null {
  const doc = state.doc.toString()
  if (mode === 'all') {
    return doc.trim() ? { text: doc, from: 0, to: doc.length, mode: 'all' } : null
  }
  const sel = state.selection.main
  if (!sel.empty) {
    const text = state.sliceDoc(sel.from, sel.to)
    return text.trim() ? { text, from: sel.from, to: sel.to, mode: 'selection' } : null
  }
  const fn = state.facet(dataEditorConfig).statementRange
  const range = fn ? fn(doc, sel.head) : doc.trim() ? { from: 0, to: doc.length } : null
  if (!range || range.to <= range.from) return null
  const text = doc.slice(range.from, range.to)
  return text.trim() ? { text, from: range.from, to: range.to, mode: 'current' } : null
}
