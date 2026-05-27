import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { acceptCompletion, autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { linter, type Diagnostic } from '@codemirror/lint'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'

import { lintPromptBraces, PROJECT_PLACEHOLDERS } from '@/lib/custom-commands'

export interface PromptCodeEditorHandle {
  insertToken: (token: string) => void
  focus: () => void
}

interface PromptCodeEditorProps {
  value: string
  onChange: (value: string) => void
  onFocus?: () => void
}

const promptAutocomplete = autocompletion({
  override: [
    (context: CompletionContext) => {
      const match = context.matchBefore(/\{\{[\w.]*$/)
      if (!match || (!context.explicit && match.from === match.to)) {
        return null
      }

      return {
        from: match.from,
        options: PROJECT_PLACEHOLDERS.map((placeholder) => ({
          label: placeholder.token,
          type: 'variable',
          info: placeholder.description,
          apply: placeholder.token
        }))
      }
    }
  ]
})

const promptLint = linter((view) => {
  const text = view.state.doc.toString()
  return lintPromptBraces(text).map(
    (finding): Diagnostic => ({
      from: finding.from,
      to: finding.to,
      severity: 'error',
      message: finding.message
    })
  )
})

const editorTheme = EditorView.theme({
  '&': {
    minHeight: '84px',
    borderRadius: '6px',
    border: '1px solid var(--border)',
    overflow: 'hidden',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px'
  },
  '&.cm-focused': {
    outline: '2px solid color-mix(in srgb, var(--ring) 24%, transparent)',
    outlineOffset: '0'
  },
  '.cm-scroller': {
    minHeight: '84px',
    maxHeight: '180px',
    overflow: 'auto'
  },
  '.cm-content': {
    minHeight: '84px',
    padding: '8px 10px'
  },
  '.cm-line': {
    lineHeight: '1.5'
  },
  '.cm-tooltip': {
    zIndex: '60'
  }
})

export const PromptCodeEditor = forwardRef<PromptCodeEditorHandle, PromptCodeEditorProps>(
  function PromptCodeEditor({ value, onChange, onFocus }, ref): React.JSX.Element {
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const initialValueRef = useRef(value)
    const onChangeRef = useRef(onChange)
    const onFocusRef = useRef(onFocus)
    onChangeRef.current = onChange
    onFocusRef.current = onFocus

    useImperativeHandle(ref, () => ({
      insertToken: (token: string) => {
        const view = viewRef.current
        if (!view) return
        const selection = view.state.selection.main
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert: token },
          selection: { anchor: selection.from + token.length }
        })
        view.focus()
      },
      focus: () => {
        viewRef.current?.focus()
      }
    }))

    useEffect(() => {
      if (!containerRef.current) return

      const state = EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          oneDark,
          editorTheme,
          placeholder('Use {{project.name}}, {{project.path}}, or plain instructions'),
          history(),
          promptAutocomplete,
          promptLint,
          keymap.of([
            { key: 'Tab', run: acceptCompletion },
            { key: 'Enter', run: acceptCompletion },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab
          ]),
          EditorView.domEventHandlers({
            focus: () => {
              onFocusRef.current?.()
              return false
            }
          }),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString())
            }
          })
        ]
      })

      const view = new EditorView({ state, parent: containerRef.current })
      viewRef.current = view

      return () => {
        view.destroy()
        viewRef.current = null
      }
    }, [])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const current = view.state.doc.toString()
      if (current === value) return
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value }
      })
    }, [value])

    return <div ref={containerRef} />
  }
)
