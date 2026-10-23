// The CodeMirror 6 query editor shared by the SQL workspace (query tabs, DDL view) and the Mongo
// workspace (shell tab, via `language: 'mongo'`).
//
// Mount-once: the EditorView is created a single time and everything that can change while it
// lives (language/dialect, completion schema, theme, read-only, placeholder, the caller's extra
// extensions) sits in its own Compartment and is reconfigured in place, so a schema refresh or a
// theme switch never loses the cursor, the undo history or the scroll position.
//
// Keyboard contract (Prec.highest so it beats CodeMirror's own Mod-Enter = insertBlankLine):
//   Mod-Enter        run the selection, else the statement under the cursor (`statementRange`)
//   Shift-Mod-Enter  run the whole document
//   Mod-.            cancel the running query
//   Mod-/            toggle line comment (defaultKeymap; `--` for SQL, `//` for the shell)
//   Shift-Alt-f      format (SQL)
//   Alt-Mod-e        explain the current statement (when `onExplain` is given)
//   Mod-s            `onSave` (when given)
//   Tab              accept the open completion, else indent
//   Escape           close the completion popup (completionKeymap)
// Tab/Escape only reach CodeMirror because the app's global shortcut and vim-navigation handlers
// skip targets inside `[data-db-editor]`, which the root carries.

import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionStatus,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory
} from '@codemirror/commands'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  rectangularSelection,
  tooltips
} from '@codemirror/view'
import type { DataCompletionSchema, SqlDialect } from '@shared/data-projects/types'
import { statementAtOffset } from '@shared/sql'
import { useGhosttySuppression } from '@/hooks/useGhosttySuppression'
import { cn } from '@/lib/utils'
import { useThemeStore } from '@/stores/useThemeStore'
import {
  dataEditorConfig,
  type DataEditorConfig,
  type KeywordCase,
  type QueryEditorLanguage,
  type StatementRange
} from './context'
import {
  currentStatementHighlight,
  editorErrorField,
  editorErrorTooltip,
  setEditorError,
  type EditorErrorRange
} from './decorations'
import { cmSqlDialect } from './dialects'
import { formatEditorSql } from './format'
import {
  buildSqlCompletionIndex,
  sqlKeywordCompletionSource,
  sqlSchemaCompletionSource
} from './sql-completion'
import { runTargetFor, type QueryEditorRunTarget } from './run-target'
import { dataEditorTheme } from './theme'

export type { QueryEditorRunTarget, QueryRunMode } from './run-target'

export interface QueryEditorProps {
  value: string
  onChange: (value: string) => void
  language: QueryEditorLanguage
  dialect?: SqlDialect
  completionSchema?: DataCompletionSchema | null
  /** Completion sources for the 'mongo' language (SQL uses the built-in schema source). */
  completionSources?: CompletionSource[]
  extraExtensions?: Extension[]
  onRun?: (target: QueryEditorRunTarget) => void
  onCancel?: () => void
  onExplain?: (target: QueryEditorRunTarget) => void
  onSave?: () => void
  /** Statement under the cursor; defaults to the shared SQL splitter for 'sql'. */
  statementRange?: (doc: string, offset: number) => StatementRange | null
  errorRange?: EditorErrorRange | null
  readOnly?: boolean
  placeholder?: string
  keywordCase?: KeywordCase
  className?: string
  autoFocus?: boolean
  'data-testid'?: string
}

export interface QueryEditorHandle {
  focus: () => void
  /** Replaces the whole document as ONE undo step (AI proposals, history, saved queries). */
  setText: (text: string) => void
  /** Inserts at the cursor (replacing the selection). */
  insertText: (text: string) => void
  getView: () => EditorView | null
  /** Formats the selection or the whole document (SQL only); null when not applicable. */
  format: () => { changed: boolean; failed: number } | null
  /** What Run / Run all would execute now (same rules as Mod-Enter / Shift-Mod-Enter). */
  getRunTarget: (mode: 'current' | 'all') => QueryEditorRunTarget | null
}

/** Marks transactions that sync the controlled `value` into the view (not user edits). */
const externalSync = Annotation.define<boolean>()

// Autocompletion is configured exactly once (two `override` configs with different values throw
// on merge). Mongo sources come through the config facet into fixed slots.
const EXTRA_SOURCE_SLOTS = 6
const extraSlot =
  (slot: number): CompletionSource =>
  (context: CompletionContext): CompletionResult | null | Promise<CompletionResult | null> => {
    const source = context.state.facet(dataEditorConfig).extraSources[slot]
    return source ? source(context) : null
  }
const COMPLETION_SOURCES: CompletionSource[] = [
  sqlSchemaCompletionSource,
  sqlKeywordCompletionSource,
  ...Array.from({ length: EXTRA_SOURCE_SLOTS }, (_, i) => extraSlot(i))
]

const languageExtension = (
  language: QueryEditorLanguage,
  dialect: SqlDialect | undefined
): Extension =>
  language === 'mongo' ? javascriptLanguage : cmSqlDialect(dialect ?? 'postgres').language

const readOnlyExtension = (readOnly: boolean): Extension => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly)
]

/** Smallest single replacement turning `from` into `to` (keeps the cursor where text is equal). */
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

export const QueryEditor = forwardRef<QueryEditorHandle, QueryEditorProps>(
  function QueryEditor(props, ref): React.JSX.Element {
    const {
      value,
      language,
      dialect,
      completionSchema,
      completionSources,
      extraExtensions,
      errorRange,
      readOnly = false,
      placeholder,
      keywordCase = 'upper',
      className,
      autoFocus
    } = props
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const propsRef = useRef(props)
    propsRef.current = props
    const id = useId()
    const [completionOpen, setCompletionOpen] = useState(false)
    // The completion popup is a floating surface: keep native terminal views from painting over it.
    useGhosttySuppression(`data-query-editor:${id}`, completionOpen)

    const compartments = useMemo(
      () => ({
        language: new Compartment(),
        config: new Compartment(),
        theme: new Compartment(),
        readOnly: new Compartment(),
        placeholder: new Compartment(),
        extra: new Compartment()
      }),
      []
    )

    const dark = useThemeStore((s) => (s.getCurrentTheme()?.type ?? 'dark') === 'dark')

    const completionIndex = useMemo(
      () =>
        language === 'sql' && dialect && completionSchema
          ? buildSqlCompletionIndex(completionSchema, dialect)
          : null,
      [language, dialect, completionSchema]
    )

    // Stable function per (language, dialect, custom?) so the highlighter does not recompute on
    // every parent render while a custom `statementRange` still always sees the latest prop.
    const hasCustomRange = !!props.statementRange
    const statementRange = useMemo<DataEditorConfig['statementRange']>(() => {
      if (hasCustomRange) {
        return (doc, offset) => propsRef.current.statementRange?.(doc, offset) ?? null
      }
      if (language !== 'sql' || !dialect) return null
      return (doc, offset) => {
        const span = statementAtOffset(doc, offset, dialect)
        return span ? { from: span.start, to: span.end } : null
      }
    }, [hasCustomRange, language, dialect])

    const config = useMemo<DataEditorConfig>(
      () => ({
        language,
        dialect: language === 'sql' ? (dialect ?? null) : null,
        completionIndex,
        keywordCase,
        extraSources: completionSources ?? [],
        statementRange
      }),
      [language, dialect, completionIndex, keywordCase, completionSources, statementRange]
    )

    // Initial values for the mount-once effect (later changes go through the compartments).
    const initialRef = useRef({ config, dark, readOnly, placeholder, extraExtensions, value })

    useEffect(() => {
      const parent = containerRef.current
      if (!parent) return
      const initial = initialRef.current
      const run = (mode: 'current' | 'all') => (view: EditorView) => {
        const onRun = propsRef.current.onRun
        if (!onRun) return false
        const target = runTargetFor(view.state, mode)
        if (target) onRun(target)
        return true
      }
      const runKeymap = keymap.of([
        { key: 'Mod-Enter', run: run('current') },
        { key: 'Shift-Mod-Enter', run: run('all') },
        {
          key: 'Mod-.',
          run: () => {
            const onCancel = propsRef.current.onCancel
            if (!onCancel) return false
            onCancel()
            return true
          }
        },
        {
          key: 'Shift-Alt-f',
          run: (view) => {
            const d = view.state.facet(dataEditorConfig).dialect
            if (!d || view.state.readOnly) return false
            formatEditorSql(view, d, view.state.facet(dataEditorConfig).keywordCase)
            return true
          }
        },
        {
          key: 'Alt-Mod-e',
          run: (view) => {
            const onExplain = propsRef.current.onExplain
            if (!onExplain) return false
            const target = runTargetFor(view.state, 'current')
            if (target) onExplain(target)
            return true
          }
        },
        {
          key: 'Mod-s',
          run: () => {
            const onSave = propsRef.current.onSave
            if (!onSave) return false
            onSave()
            return true
          }
        }
      ])
      const state = EditorState.create({
        doc: initial.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          EditorState.allowMultipleSelections.of(true),
          history(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          highlightSelectionMatches(),
          tooltips({ position: 'fixed' }),
          compartments.language.of(
            languageExtension(initial.config.language, initial.config.dialect ?? undefined)
          ),
          compartments.config.of(dataEditorConfig.of(initial.config)),
          compartments.theme.of(dataEditorTheme(initial.dark)),
          compartments.readOnly.of(readOnlyExtension(initial.readOnly)),
          compartments.placeholder.of(
            initial.placeholder ? cmPlaceholder(initial.placeholder) : []
          ),
          compartments.extra.of(initial.extraExtensions ?? []),
          autocompletion({
            override: COMPLETION_SOURCES,
            activateOnTypingDelay: 60,
            maxRenderedOptions: 200,
            closeOnBlur: true
          }),
          currentStatementHighlight,
          editorErrorField,
          editorErrorTooltip,
          Prec.highest(runKeymap),
          keymap.of([
            { key: 'Tab', run: acceptCompletion },
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab
          ]),
          EditorView.contentAttributes.of({
            'aria-label': 'Query editor',
            spellcheck: 'false',
            autocorrect: 'off',
            autocapitalize: 'off'
          }),
          EditorView.editorAttributes.of({ 'data-db-editor': '' }),
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
      if (propsRef.current.autoFocus) view.focus()
      return () => {
        view.destroy()
        viewRef.current = null
      }
    }, [compartments])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartments.language.reconfigure(languageExtension(language, dialect))
      })
    }, [compartments, language, dialect])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartments.config.reconfigure(dataEditorConfig.of(config))
      })
    }, [compartments, config])

    useEffect(() => {
      viewRef.current?.dispatch({ effects: compartments.theme.reconfigure(dataEditorTheme(dark)) })
    }, [compartments, dark])

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
      viewRef.current?.dispatch({ effects: compartments.extra.reconfigure(extraExtensions ?? []) })
    }, [compartments, extraExtensions])

    // Controlled value: only external changes (bridge insertions, store resets) reach this; user
    // typing already updated the doc, so the comparison short-circuits.
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const current = view.state.doc.toString()
      if (current === value) return
      // One undoable step; the selection is mapped through the change by CodeMirror.
      view.dispatch({
        changes: minimalChange(current, value),
        annotations: [externalSync.of(true), isolateHistory.of('full')]
      })
    }, [value])

    useEffect(() => {
      viewRef.current?.dispatch({ effects: setEditorError.of(errorRange ?? null) })
    }, [errorRange?.from, errorRange?.to, errorRange?.message]) // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
      if (autoFocus) viewRef.current?.focus()
    }, [autoFocus])

    useImperativeHandle(
      ref,
      (): QueryEditorHandle => ({
        focus: () => viewRef.current?.focus(),
        setText: (text) => {
          const view = viewRef.current
          if (!view) return
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection: { anchor: text.length },
            userEvent: 'input.replace',
            annotations: isolateHistory.of('full'),
            scrollIntoView: true
          })
          view.focus()
        },
        insertText: (text) => {
          const view = viewRef.current
          if (!view) return
          const sel = view.state.selection.main
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: text },
            selection: { anchor: sel.from + text.length },
            userEvent: 'input.paste',
            annotations: isolateHistory.of('full'),
            scrollIntoView: true
          })
          view.focus()
        },
        getView: () => viewRef.current,
        format: () => {
          const view = viewRef.current
          const d = view?.state.facet(dataEditorConfig).dialect
          if (!view || !d || view.state.readOnly) return null
          return formatEditorSql(view, d, view.state.facet(dataEditorConfig).keywordCase)
        },
        getRunTarget: (mode) => {
          const view = viewRef.current
          return view ? runTargetFor(view.state, mode) : null
        }
      }),
      []
    )

    return (
      <div
        ref={containerRef}
        data-db-editor=""
        data-testid={props['data-testid'] ?? 'data-project-query-editor'}
        className={cn('relative h-full min-h-0 w-full overflow-hidden', className)}
      />
    )
  }
)
