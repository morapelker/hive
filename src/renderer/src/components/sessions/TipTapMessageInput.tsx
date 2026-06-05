import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef
} from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { Extension, type Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Placeholder } from '@tiptap/extension-placeholder'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import { cn } from '@/lib/utils'
import type { FlatFile } from '@/lib/file-search-utils'

const lowlight = createLowlight(common)

export interface MentionTriggerState {
  /** Text typed after the '@', up to the cursor (no spaces). */
  query: string
}

export interface TipTapMessageInputHandle {
  focus: () => void
  isEmpty: () => boolean
  getMarkdown: () => string
  /** Plain-text content (used for control-prefix detection like '!' / '/'). */
  getText: () => string
  /** Clear all content. */
  clear: () => void
  /** Replace the '@trigger' span at the cursor with `@relativePath `. */
  insertMention: (file: FlatFile) => void
}

interface TipTapMessageInputProps {
  /** Controlled markdown value — source of truth lives in the parent. */
  value: string
  /** Fired only on user-driven edits, with the serialized markdown. */
  onChange: (markdown: string) => void
  /** Alt+Enter. */
  onSend: () => void
  /** ArrowUp while the editor is empty. Return true if the key was consumed. */
  onHistoryPrev: () => boolean
  /** ArrowDown while the editor is empty. Return true if the key was consumed. */
  onHistoryNext: () => boolean
  /** A pasted image file (non-image paste flows through to the editor). */
  onImagePaste: (file: File) => void
  /**
   * Reports the current '@' mention trigger (or null when none). The parent
   * computes suggestions and renders the popover; selection calls back into
   * `insertMention` on the imperative handle.
   */
  onMentionStateChange: (state: MentionTriggerState | null) => void
  placeholder: string
  disabled: boolean
  /** Classes for the scroll container (height / full-height handling). */
  className?: string
}

/**
 * Detect an active '@' file-mention trigger by scanning backward from the end
 * of the text-before-cursor. Mirrors the rules previously in useFileMentions:
 * '@' must be at a word boundary (start, or preceded by whitespace) and the
 * query (up to the cursor) must not contain a space.
 */
function detectMentionTrigger(textBefore: string): { query: string; triggerIndex: number } | null {
  for (let i = textBefore.length - 1; i >= 0; i--) {
    const ch = textBefore[i]
    if (ch === ' ' || ch === '\n') return null
    if (ch === '@') {
      const prev = textBefore[i - 1]
      if (i === 0 || prev === ' ' || prev === '\n') {
        const query = textBefore.slice(i + 1)
        if (query.includes(' ')) return null
        return { query, triggerIndex: i }
      }
      return null
    }
  }
  return null
}

export const TipTapMessageInput = forwardRef<TipTapMessageInputHandle, TipTapMessageInputProps>(
  function TipTapMessageInput(
    {
      value,
      onChange,
      onSend,
      onHistoryPrev,
      onHistoryNext,
      onImagePaste,
      onMentionStateChange,
      placeholder,
      disabled,
      className
    },
    ref
  ): React.JSX.Element {
    // Stable refs so the (create-once) editor/extensions always call the latest callbacks.
    const onChangeRef = useRef(onChange)
    const onSendRef = useRef(onSend)
    const onHistoryPrevRef = useRef(onHistoryPrev)
    const onHistoryNextRef = useRef(onHistoryNext)
    const onImagePasteRef = useRef(onImagePaste)
    const onMentionStateChangeRef = useRef(onMentionStateChange)
    const placeholderRef = useRef(placeholder)
    useEffect(() => {
      onChangeRef.current = onChange
      onSendRef.current = onSend
      onHistoryPrevRef.current = onHistoryPrev
      onHistoryNextRef.current = onHistoryNext
      onImagePasteRef.current = onImagePaste
      onMentionStateChangeRef.current = onMentionStateChange
    })

    // Markdown last emitted by the editor itself — lets the value-sync effect
    // distinguish an echo of our own edit from a genuine external change.
    const lastEmittedRef = useRef('')
    // Document position of the active '@' so insertMention can replace the span.
    const mentionAnchorRef = useRef<number | null>(null)

    const computeMentionState = useCallback((editor: Editor) => {
      // Don't surface the popover unless the user is actively editing.
      if (!editor.view.hasFocus()) {
        mentionAnchorRef.current = null
        onMentionStateChangeRef.current(null)
        return
      }
      const { selection } = editor.state
      if (!selection.empty) {
        mentionAnchorRef.current = null
        onMentionStateChangeRef.current(null)
        return
      }
      const $from = selection.$from
      const from = selection.from
      const blockStart = $from.start()
      const textBefore = editor.state.doc.textBetween(blockStart, from, '\n', '\n')
      const trigger = detectMentionTrigger(textBefore)
      if (!trigger) {
        mentionAnchorRef.current = null
        onMentionStateChangeRef.current(null)
        return
      }
      // '@' doc position maps 1:1 with the text offset within the block.
      mentionAnchorRef.current = blockStart + trigger.triggerIndex
      onMentionStateChangeRef.current({ query: trigger.query })
    }, [])

    const keymapExtension = useMemo(
      () =>
        Extension.create({
          name: 'composerKeymap',
          addKeyboardShortcuts() {
            // Remove a single leading tab immediately before the cursor.
            const outdentTab = (): boolean => {
              const { state } = this.editor
              const { from, empty } = state.selection
              if (!empty || from === 0) return false
              const before = state.doc.textBetween(from - 1, from)
              if (before === '\t') {
                return this.editor.commands.deleteRange({ from: from - 1, to: from })
              }
              return false
            }
            return {
              'Alt-Enter': () => {
                if (this.editor.view.composing) return false
                onSendRef.current()
                return true
              },
              ArrowUp: () => {
                if (!this.editor.isEmpty) return false
                return onHistoryPrevRef.current()
              },
              ArrowDown: () => {
                if (!this.editor.isEmpty) return false
                return onHistoryNextRef.current()
              },
              // Tab indents (nest lists; insert a tab elsewhere). Always consume
              // so focus never leaves the editor.
              Tab: () => {
                if (!this.editor.isActive('codeBlock') && this.editor.can().sinkListItem('listItem')) {
                  return this.editor.commands.sinkListItem('listItem')
                }
                this.editor.commands.insertContent('\t')
                return true
              },
              // Shift+Tab un-indents (lift lists; remove a leading tab elsewhere).
              'Shift-Tab': () => {
                if (!this.editor.isActive('codeBlock') && this.editor.can().liftListItem('listItem')) {
                  return this.editor.commands.liftListItem('listItem')
                }
                outdentTab()
                return true
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
        Markdown,
        Placeholder.configure({ placeholder: () => placeholderRef.current }),
        keymapExtension
      ],
      editable: !disabled,
      editorProps: {
        attributes: {
          class: 'tiptap-message-input focus:outline-none',
          'aria-label': 'Message input',
          'data-testid': 'message-input'
        },
        handlePaste: (_view, event) => {
          const items = event.clipboardData?.items
          if (!items) return false
          for (const item of Array.from(items)) {
            if (item.type.startsWith('image/')) {
              const file = item.getAsFile()
              if (file) {
                event.preventDefault()
                onImagePasteRef.current(file)
                return true
              }
            }
          }
          return false
        }
      },
      onUpdate: ({ editor }) => {
        const md = editor.getMarkdown()
        lastEmittedRef.current = md
        onChangeRef.current(md)
        computeMentionState(editor)
      },
      onSelectionUpdate: ({ editor }) => {
        computeMentionState(editor)
      }
    })

    // Push programmatic (external) value changes into the editor. Skip the echo
    // of our own edits and any no-op so the cursor is never disturbed.
    useEffect(() => {
      if (!editor) return
      if (value === lastEmittedRef.current) return
      if (value === editor.getMarkdown()) return
      editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
      lastEmittedRef.current = value
    }, [editor, value])

    // Reactive placeholder.
    useEffect(() => {
      placeholderRef.current = placeholder
      if (editor) editor.view.dispatch(editor.state.tr)
    }, [editor, placeholder])

    // Editable state.
    useEffect(() => {
      if (editor) editor.setEditable(!disabled)
    }, [editor, disabled])

    useImperativeHandle(
      ref,
      () => ({
        focus: () => editor?.commands.focus(),
        isEmpty: () => editor?.isEmpty ?? true,
        getMarkdown: () => editor?.getMarkdown() ?? '',
        getText: () => editor?.getText() ?? '',
        clear: () => {
          editor?.commands.clearContent()
        },
        insertMention: (file: FlatFile) => {
          if (!editor) return
          const anchor = mentionAnchorRef.current
          const to = editor.state.selection.from
          const from = anchor ?? to
          editor
            .chain()
            .focus()
            .insertContentAt({ from, to }, `@${file.relativePath} `)
            .run()
          mentionAnchorRef.current = null
        }
      }),
      [editor]
    )

    return (
      <div
        className={cn(
          'overflow-y-auto',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
      >
        <EditorContent editor={editor} />
      </div>
    )
  }
)
