import { type ReactNode } from 'react'
import { type Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Code2,
  Table as TableIcon,
  Minus,
  Link as LinkIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface EditorToolbarProps {
  editor: Editor
  className?: string
}

interface ToolbarButtonProps {
  onClick: () => void
  active?: boolean
  disabled?: boolean
  title: string
  children: ReactNode
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children
}: ToolbarButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      // Use mousedown + preventDefault so the editor selection isn't lost.
      onMouseDown={(e) => {
        e.preventDefault()
        if (!disabled) onClick()
      }}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded transition-colors',
        'text-muted-foreground hover:bg-accent hover:text-foreground',
        'disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-accent text-accent-foreground'
      )}
    >
      {children}
    </button>
  )
}

function Divider(): React.JSX.Element {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden />
}

/** Formatting toolbar bound to a TipTap editor instance. */
export function EditorToolbar({ editor, className }: EditorToolbarProps): React.JSX.Element {
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      h1: editor.isActive('heading', { level: 1 }),
      h2: editor.isActive('heading', { level: 2 }),
      h3: editor.isActive('heading', { level: 3 }),
      bullet: editor.isActive('bulletList'),
      ordered: editor.isActive('orderedList'),
      task: editor.isActive('taskList'),
      quote: editor.isActive('blockquote'),
      codeBlock: editor.isActive('codeBlock'),
      link: editor.isActive('link')
    })
  })

  const setLink = (): void => {
    const previous = (editor.getAttributes('link').href as string | undefined) ?? ''
    const url = window.prompt('Link URL', previous)
    if (url === null) return
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-0.5 border-b border-border bg-background/60 px-2 py-1',
        className
      )}
      data-testid="editor-toolbar"
    >
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={state.bold}
        title="Bold (Ctrl+B)"
      >
        <Bold className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={state.italic}
        title="Italic (Ctrl+I)"
      >
        <Italic className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={state.strike}
        title="Strikethrough"
      >
        <Strikethrough className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={state.code}
        title="Inline code"
      >
        <Code className="h-4 w-4" />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={state.h1}
        title="Heading 1"
      >
        <Heading1 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={state.h2}
        title="Heading 2"
      >
        <Heading2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={state.h3}
        title="Heading 3"
      >
        <Heading3 className="h-4 w-4" />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={state.bullet}
        title="Bullet list"
      >
        <List className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={state.ordered}
        title="Numbered list"
      >
        <ListOrdered className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        active={state.task}
        title="To-do list"
      >
        <ListChecks className="h-4 w-4" />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={state.quote}
        title="Quote"
      >
        <Quote className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={state.codeBlock}
        title="Code block"
      >
        <Code2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton onClick={setLink} active={state.link} title="Link">
        <LinkIcon className="h-4 w-4" />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
        title="Insert table"
      >
        <TableIcon className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="Divider"
      >
        <Minus className="h-4 w-4" />
      </ToolbarButton>
    </div>
  )
}
