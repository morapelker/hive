// Compact CodeMirror editor for Mongo shell values: the query bar fields (filter, project,
// sort…), stage bodies, and the document / update / index-key editors in dialogs. The Shell tab
// uses the full QueryEditor; this one has no gutter and grows with its content.
//
// Completion runs through the same analyzer as the Shell tab, with a synthetic prefix that puts
// the text inside the right call (`db.getCollection('orders').find(` for a filter), so operators,
// stages and field paths are offered exactly where the shell would offer them.
//
// Keys: Enter submits in `submitOnEnter` mode (Shift+Enter inserts a newline), Mod-Enter always
// submits, Tab accepts an open completion. The root carries `data-db-editor` so the app's global
// shortcut and vim handlers leave Tab/Escape to the editor. Mount-once like QueryEditor: theme,
// read-only and placeholder are compartments; the controlled value syncs by minimal diff.

import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  completionStatus
} from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  insertNewlineAndIndent
} from '@codemirror/commands'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  keymap,
  placeholder as cmPlaceholder,
  tooltips
} from '@codemirror/view'
import { dataEditorTheme } from '@/components/data-projects/editor'
import { useGhosttySuppression } from '@/hooks/useGhosttySuppression'
import { cn } from '@/lib/utils'
import { useThemeStore } from '@/stores/useThemeStore'
import type { MongoCompletionData } from './mongo-completion'
import { createMongoCompletionSource } from './mongo-completion-source'

export interface MongoCodeEditorHandle {
  /** Focuses the editor, optionally placing the cursor at `cursor`. */
  focus: (cursor?: number) => void
  getView: () => EditorView | null
}

export interface MongoCodeEditorProps {
  value: string
  onChange: (value: string) => void
  /** Enter (with submitOnEnter) or Mod-Enter. */
  onSubmit?: () => void
  /** Enter submits, Shift+Enter inserts a newline (query bar fields). */
  submitOnEnter?: boolean
  placeholder?: string
  /** Text the completion analyzer sees before the editor's text. */
  completionPrefix?: string
  /** Latest completion data (collections, fields, server version). */
  completionData?: () => MongoCompletionData
  readOnly?: boolean
  /** Pixel height bounds; the editor grows with its content in between. */
  minHeight?: number
  maxHeight?: number
  autoFocus?: boolean
  invalid?: boolean
  className?: string
  'data-testid'?: string
  'aria-label'?: string
}

const externalSync = Annotation.define<boolean>()

/**
 * Closes an open completion popup, if any. Dialogs call it from Radix's `onEscapeKeyDown`
 * (which runs in the capture phase, before CodeMirror sees the key) so the first Escape closes
 * the popup and only the second one closes the dialog.
 */
export function dismissOpenCompletion(): boolean {
  if (typeof document === 'undefined') return false
  const popup = document.querySelector('.cm-tooltip-autocomplete')
  const editor = popup?.closest('.cm-editor')
  const view = editor instanceof HTMLElement ? EditorView.findFromDOM(editor) : null
  return view ? closeCompletion(view) : false
}

/** Radix `onEscapeKeyDown` handler for dialogs that contain Mongo editors. */
export const escapeClosesCompletionFirst = (event: KeyboardEvent): void => {
  if (dismissOpenCompletion()) event.preventDefault()
}

const EMPTY_DATA: MongoCompletionData = { databases: [], collections: [], fields: () => [] }

function minimalChange(from: string, to: string): { from: number; to: number; insert: string } {
  let start = 0
  const max = Math.min(from.length, to.length)
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++
  let endFrom = from.length
  let endTo = to.length
  while (
    endFrom > start &&
    endTo > start &&
    from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)
  ) {
    endFrom--
    endTo--
  }
  return { from: start, to: endFrom, insert: to.slice(start, endTo) }
}

const sizeTheme = (minHeight: number, maxHeight: number): Extension =>
  EditorView.theme({
    '&': { fontSize: '12px', backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      minHeight: `${minHeight}px`,
      maxHeight: `${maxHeight}px`,
      overflow: 'auto',
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.55'
    },
    '.cm-content': { padding: '4px 0', minHeight: `${minHeight}px` },
    '.cm-line': { padding: '0 8px' },
    '.cm-gutters': { display: 'none' },
    '.cm-tooltip': { zIndex: '60' }
  })

const readOnlyExtension = (readOnly: boolean): Extension => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly)
]

export const MongoCodeEditor = forwardRef<MongoCodeEditorHandle, MongoCodeEditorProps>(
  function MongoCodeEditor(props, ref): React.JSX.Element {
    const {
      value,
      placeholder,
      readOnly = false,
      minHeight = 26,
      maxHeight = 240,
      invalid,
      className
    } = props
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const propsRef = useRef(props)
    propsRef.current = props
    const id = useId()
    const [completionOpen, setCompletionOpen] = useState(false)
    useGhosttySuppression(`mongo-code-editor:${id}`, completionOpen)
    const dark = useThemeStore((s) => (s.getCurrentTheme()?.type ?? 'dark') === 'dark')

    const compartments = useMemo(
      () => ({
        theme: new Compartment(),
        readOnly: new Compartment(),
        placeholder: new Compartment(),
        size: new Compartment()
      }),
      []
    )
    const initialRef = useRef({ value, dark, readOnly, placeholder, minHeight, maxHeight })

    useEffect(() => {
      const parent = containerRef.current
      if (!parent) return
      const initial = initialRef.current
      const submit = (): boolean => {
        const onSubmit = propsRef.current.onSubmit
        if (!onSubmit) return false
        onSubmit()
        return true
      }
      const source = createMongoCompletionSource(
        () => propsRef.current.completionData?.() ?? EMPTY_DATA,
        () => propsRef.current.completionPrefix ?? ''
      )
      const state = EditorState.create({
        doc: initial.value,
        extensions: [
          history(),
          drawSelection(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          javascriptLanguage,
          tooltips({ position: 'fixed' }),
          autocompletion({
            override: [source],
            activateOnTypingDelay: 60,
            maxRenderedOptions: 150
          }),
          compartments.theme.of(dataEditorTheme(initial.dark)),
          compartments.size.of(sizeTheme(initial.minHeight, initial.maxHeight)),
          compartments.readOnly.of(readOnlyExtension(initial.readOnly)),
          compartments.placeholder.of(
            initial.placeholder ? cmPlaceholder(initial.placeholder) : []
          ),
          Prec.highest(
            keymap.of([
              { key: 'Mod-Enter', run: submit },
              {
                key: 'Enter',
                run: (view) => {
                  if (completionStatus(view.state) === 'active') return acceptCompletion(view)
                  return propsRef.current.submitOnEnter ? submit() : false
                }
              },
              { key: 'Shift-Enter', run: insertNewlineAndIndent }
            ])
          ),
          keymap.of([
            { key: 'Tab', run: acceptCompletion },
            ...closeBracketsKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab
          ]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            spellcheck: 'false',
            autocorrect: 'off',
            autocapitalize: 'off',
            ...(propsRef.current['aria-label']
              ? { 'aria-label': propsRef.current['aria-label'] }
              : {})
          }),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(externalSync))
            ) {
              propsRef.current.onChange(update.state.doc.toString())
            }
            const open = completionStatus(update.state) !== null
            if (open !== (completionStatus(update.startState) !== null)) setCompletionOpen(open)
          })
        ]
      })
      const view = new EditorView({ state, parent })
      viewRef.current = view
      if (propsRef.current.autoFocus) {
        view.focus()
        view.dispatch({ selection: { anchor: view.state.doc.length } })
      }
      return () => {
        view.destroy()
        viewRef.current = null
      }
    }, [compartments])

    useEffect(() => {
      viewRef.current?.dispatch({ effects: compartments.theme.reconfigure(dataEditorTheme(dark)) })
    }, [compartments, dark])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartments.size.reconfigure(sizeTheme(minHeight, maxHeight))
      })
    }, [compartments, minHeight, maxHeight])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartments.readOnly.reconfigure(readOnlyExtension(readOnly))
      })
    }, [compartments, readOnly])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartments.placeholder.reconfigure(placeholder ? cmPlaceholder(placeholder) : [])
      })
    }, [compartments, placeholder])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const current = view.state.doc.toString()
      if (current === value) return
      view.dispatch({ changes: minimalChange(current, value), annotations: externalSync.of(true) })
    }, [value])

    useImperativeHandle(
      ref,
      (): MongoCodeEditorHandle => ({
        focus: (cursor) => {
          const view = viewRef.current
          if (!view) return
          view.focus()
          if (cursor !== undefined) {
            const anchor = Math.max(0, Math.min(cursor, view.state.doc.length))
            view.dispatch({ selection: { anchor }, scrollIntoView: true })
          }
        },
        getView: () => viewRef.current
      }),
      []
    )

    return (
      <div
        ref={containerRef}
        data-db-editor=""
        data-testid={props['data-testid']}
        aria-invalid={invalid || undefined}
        className={cn(
          'min-w-0 rounded-[6px] border border-input bg-background dark:bg-input/30 transition-colors',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30',
          invalid &&
            'border-destructive/60 focus-within:border-destructive focus-within:ring-destructive/20',
          readOnly && 'opacity-80',
          className
        )}
      />
    )
  }
)
