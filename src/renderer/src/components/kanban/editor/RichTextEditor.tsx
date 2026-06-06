import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Placeholder } from '@tiptap/extension-placeholder'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { TableKit } from '@tiptap/extension-table'
import { createLowlight, common } from 'lowlight'
import { cn } from '@/lib/utils'
import { SlashCommand } from './slash-command'
import { EditorToolbar } from './EditorToolbar'

const lowlight = createLowlight(common)

export interface RichTextEditorHandle {
  focus: () => void
  getMarkdown: () => string
  isEmpty: () => boolean
}

interface RichTextEditorProps {
  /** Controlled markdown value — source of truth lives in the parent. */
  value: string
  /** Fired on user-driven edits with the serialized markdown. */
  onChange: (markdown: string) => void
  placeholder?: string
  editable?: boolean
  autofocus?: boolean
  showToolbar?: boolean
  /** Classes for the editor scroll area (height handling). */
  className?: string
}

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  function RichTextEditor(
    {
      value,
      onChange,
      placeholder = "Write something, or press '/' for commands…",
      editable = true,
      autofocus = false,
      showToolbar = true,
      className
    },
    ref
  ): React.JSX.Element {
    const onChangeRef = useRef(onChange)
    const placeholderRef = useRef(placeholder)
    useEffect(() => {
      onChangeRef.current = onChange
      placeholderRef.current = placeholder
    })

    // Markdown last emitted by the editor — lets the value-sync effect ignore the
    // echo of our own edits so the cursor is never disturbed.
    const lastEmittedRef = useRef('')

    // Tab/Shift+Tab indent lists & checklists (but defer to tables, which use Tab
    // for cell navigation).
    const indentKeymap = useMemo(
      () =>
        Extension.create({
          name: 'richEditorIndent',
          addKeyboardShortcuts() {
            const sink = (): boolean => {
              if (this.editor.can().sinkListItem('listItem')) {
                return this.editor.commands.sinkListItem('listItem')
              }
              if (this.editor.can().sinkListItem('taskItem')) {
                return this.editor.commands.sinkListItem('taskItem')
              }
              return false
            }
            const lift = (): boolean => {
              if (this.editor.can().liftListItem('listItem')) {
                return this.editor.commands.liftListItem('listItem')
              }
              if (this.editor.can().liftListItem('taskItem')) {
                return this.editor.commands.liftListItem('taskItem')
              }
              return false
            }
            return {
              Tab: () => {
                if (this.editor.isActive('table')) return false
                if (sink()) return true
                this.editor.commands.insertContent('\t')
                return true
              },
              'Shift-Tab': () => {
                if (this.editor.isActive('table')) return false
                return lift()
              }
            }
          }
        }),
      []
    )

    const editor = useEditor({
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        CodeBlockLowlight.configure({ lowlight }),
        TaskList,
        TaskItem.configure({ nested: true }),
        TableKit.configure({ table: { resizable: true } }),
        Markdown,
        Placeholder.configure({ placeholder: () => placeholderRef.current }),
        SlashCommand,
        indentKeymap
      ],
      editable,
      autofocus,
      editorProps: {
        attributes: {
          class: 'tiptap-rich-editor focus:outline-none',
          'aria-label': 'Rich text editor',
          'data-testid': 'rich-text-editor'
        },
        // Keep keys the editor handles (Tab/Shift+Tab indentation) from bubbling
        // to app-wide shortcut handlers. ProseMirror's keymap still runs.
        handleKeyDown: (_view, event) => {
          if (event.key === 'Tab') event.stopPropagation()
          return false
        }
      },
      onUpdate: ({ editor }) => {
        const md = editor.getMarkdown()
        lastEmittedRef.current = md
        onChangeRef.current(md)
      }
    })

    // Push external value changes into the editor, skipping the echo of our own
    // edits and no-ops so the cursor stays put.
    useEffect(() => {
      if (!editor) return
      if (value === lastEmittedRef.current) return
      if (value === editor.getMarkdown()) return
      editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
      lastEmittedRef.current = value
    }, [editor, value])

    // Reactive placeholder.
    useEffect(() => {
      if (editor) editor.view.dispatch(editor.state.tr)
    }, [editor, placeholder])

    // Editable state.
    useEffect(() => {
      if (editor) editor.setEditable(editable)
    }, [editor, editable])

    useImperativeHandle(
      ref,
      () => ({
        focus: () => editor?.commands.focus(),
        getMarkdown: () => editor?.getMarkdown() ?? '',
        isEmpty: () => editor?.isEmpty ?? true
      }),
      [editor]
    )

    return (
      <div className={cn('flex min-h-0 flex-col', className)}>
        {showToolbar && editor && <EditorToolbar editor={editor} />}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EditorContent editor={editor} />
        </div>
      </div>
    )
  }
)
