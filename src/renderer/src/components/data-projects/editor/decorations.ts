// Editor decorations of the query editor:
// - the current-statement band (the text Cmd+Enter would run), drawn only when the document holds
//   more than one statement, so a single query is not permanently tinted;
// - the server error underline (`errorRange`), with its message on hover. It is dropped as soon as
//   an edit touches it, because the server's offset no longer describes the text.

import { StateEffect, StateField, type EditorState, type Range, type Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { dataEditorConfig, type StatementRange } from './context'

// ---------------------------------------------------------------------------------------------
// Current statement
// ---------------------------------------------------------------------------------------------

const statementLine = Decoration.line({ class: 'cm-dp-current-statement' })
const MAX_HIGHLIGHT_DOC = 300_000

/** The statement Cmd+Enter would run for the main cursor, or null (selection / no statement). */
export function currentStatementRange(state: EditorState): StatementRange | null {
  const fn = state.facet(dataEditorConfig).statementRange
  if (!fn) return null
  const sel = state.selection.main
  return fn(state.doc.toString(), sel.head)
}

class StatementHighlighter {
  decorations: DecorationSet = Decoration.none
  private lastDoc: Text | null = null
  private lastPos = -1
  private lastFn: unknown = null

  constructor(view: EditorView) {
    this.decorations = this.build(view.state)
  }

  update(update: ViewUpdate): void {
    const fn = update.state.facet(dataEditorConfig).statementRange
    if (update.docChanged || update.selectionSet || fn !== this.lastFn) {
      this.decorations = this.build(update.state)
    }
  }

  private build(state: EditorState): DecorationSet {
    const fn = state.facet(dataEditorConfig).statementRange
    const sel = state.selection.main
    if (
      fn === this.lastFn &&
      state.doc === this.lastDoc &&
      sel.head === this.lastPos &&
      sel.empty
    ) {
      return this.decorations
    }
    this.lastFn = fn
    this.lastDoc = state.doc
    this.lastPos = sel.empty ? sel.head : -1
    if (!fn || !sel.empty || state.doc.length === 0 || state.doc.length > MAX_HIGHLIGHT_DOC) {
      return Decoration.none
    }
    const text = state.doc.toString()
    const range = fn(text, sel.head)
    if (!range || range.to <= range.from) return Decoration.none
    // Only worth drawing when something else (other than `;` and blanks) is in the document.
    if (!/[^\s;]/.test(text.slice(0, range.from)) && !/[^\s;]/.test(text.slice(range.to))) {
      return Decoration.none
    }
    const first = state.doc.lineAt(Math.min(range.from, state.doc.length)).number
    const last = state.doc.lineAt(Math.min(range.to, state.doc.length)).number
    const marks: Range<Decoration>[] = []
    for (let n = first; n <= last; n++) marks.push(statementLine.range(state.doc.line(n).from))
    return Decoration.set(marks)
  }
}

export const currentStatementHighlight = ViewPlugin.fromClass(StatementHighlighter, {
  decorations: (plugin) => plugin.decorations
})

// ---------------------------------------------------------------------------------------------
// Error underline
// ---------------------------------------------------------------------------------------------

export interface EditorErrorRange {
  from: number
  to: number
  message: string
}

export const setEditorError = StateEffect.define<EditorErrorRange | null>()

const errorMark = Decoration.mark({ class: 'cm-dp-error' })

interface ErrorState {
  range: EditorErrorRange | null
  decorations: DecorationSet
}

const clampRange = (state: EditorState, range: EditorErrorRange): EditorErrorRange | null => {
  const len = state.doc.length
  if (len === 0) return null
  let from = Math.max(0, Math.min(range.from, len))
  let to = Math.max(from, Math.min(range.to, len))
  if (to === from) {
    // Zero-width (end of input): underline the last character instead.
    if (from >= len) from = len - 1
    to = from + 1
  }
  return { ...range, from, to }
}

export const editorErrorField = StateField.define<ErrorState>({
  create: () => ({ range: null, decorations: Decoration.none }),
  update(value, tr) {
    let next = value
    if (tr.docChanged && value.range) {
      next = tr.changes.touchesRange(value.range.from, value.range.to)
        ? { range: null, decorations: Decoration.none }
        : {
            range: {
              ...value.range,
              from: tr.changes.mapPos(value.range.from),
              to: tr.changes.mapPos(value.range.to)
            },
            decorations: value.decorations.map(tr.changes)
          }
    }
    for (const effect of tr.effects) {
      if (!effect.is(setEditorError)) continue
      const range = effect.value ? clampRange(tr.state, effect.value) : null
      next = range
        ? { range, decorations: Decoration.set([errorMark.range(range.from, range.to)]) }
        : { range: null, decorations: Decoration.none }
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

export const editorErrorTooltip = hoverTooltip((view, pos) => {
  const range = view.state.field(editorErrorField, false)?.range
  if (!range || pos < range.from || pos > range.to) return null
  return {
    pos: range.from,
    end: range.to,
    above: true,
    create: () => {
      const dom = document.createElement('div')
      dom.className = 'cm-dp-error-tooltip'
      dom.textContent = range.message
      return { dom }
    }
  }
})
