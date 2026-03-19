import { useRef, useEffect } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers, highlightActiveLine, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import { getLanguageExtension } from './cm-languages'

interface CodeMirrorEditorProps {
  content: string
  filePath: string
  onContentChange?: (content: string) => void
}

const editorTheme = EditorView.theme({
  '&': {
    flex: '1',
    minHeight: '0',
    overflow: 'hidden',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '13px'
  },
  '.cm-scroller': {
    overflow: 'auto',
    height: '100%'
  },
  '.cm-content': {
    minHeight: '100%'
  }
})

export function CodeMirrorEditor({
  content,
  filePath,
  onContentChange
}: CodeMirrorEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange

  // Initializes the EditorView once on mount and cleans it up on unmount.
  // The parent component keys this component by filePath, so a new file
  // causes a full remount. content, filePath, and onContentChange are
  // intentionally excluded — they are only needed at initialization time
  // (content/filePath captured in the closure, onContentChange accessed
  // via onContentChangeRef to always use the latest callback).
  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      doc: content,
      extensions: [
        oneDark,
        editorTheme,
        lineNumbers(),
        highlightActiveLine(),
        bracketMatching(),
        history(),
        indentOnInput(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        getLanguageExtension(filePath),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onContentChangeRef.current) {
            onContentChangeRef.current(update.state.doc.toString())
          }
        })
      ]
    })

    const view = new EditorView({
      state,
      parent: containerRef.current
    })

    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-hidden flex flex-col"
      data-testid="file-viewer-content"
    />
  )
}
