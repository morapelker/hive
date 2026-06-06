import { Extension, type Editor, type Range } from '@tiptap/core'
import {
  Suggestion,
  type SuggestionProps,
  type SuggestionKeyDownProps
} from '@tiptap/suggestion'
import { ReactRenderer } from '@tiptap/react'
import type { LucideIcon } from 'lucide-react'
import {
  Text,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Code2,
  Quote,
  Table as TableIcon,
  Minus
} from 'lucide-react'
import { SlashCommandMenu, type SlashCommandMenuHandle } from './SlashCommandMenu'

/** A single entry in the Notion-style "/" command menu. */
export interface SlashCommandItem {
  title: string
  description: string
  /** Extra words matched against the typed query (besides the title). */
  searchTerms: string[]
  icon: LucideIcon
  /** Runs the command, having first removed the typed "/query" range. */
  command: (props: { editor: Editor; range: Range }) => void
}

export const SLASH_COMMAND_ITEMS: SlashCommandItem[] = [
  {
    title: 'Text',
    description: 'Plain paragraph',
    searchTerms: ['paragraph', 'body', 'p'],
    icon: Text,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setParagraph().run()
  },
  {
    title: 'Heading 1',
    description: 'Large section heading',
    searchTerms: ['h1', 'title', 'big'],
    icon: Heading1,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run()
  },
  {
    title: 'Heading 2',
    description: 'Medium section heading',
    searchTerms: ['h2', 'subtitle'],
    icon: Heading2,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run()
  },
  {
    title: 'Heading 3',
    description: 'Small section heading',
    searchTerms: ['h3'],
    icon: Heading3,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run()
  },
  {
    title: 'Bullet list',
    description: 'Unordered list',
    searchTerms: ['ul', 'unordered', 'point'],
    icon: List,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run()
  },
  {
    title: 'Numbered list',
    description: 'Ordered list',
    searchTerms: ['ol', 'ordered', 'number'],
    icon: ListOrdered,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run()
  },
  {
    title: 'To-do list',
    description: 'Checklist with checkboxes',
    searchTerms: ['todo', 'task', 'checkbox', 'check'],
    icon: ListChecks,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run()
  },
  {
    title: 'Code block',
    description: 'Fenced code with highlighting',
    searchTerms: ['code', 'snippet', 'pre'],
    icon: Code2,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run()
  },
  {
    title: 'Quote',
    description: 'Block quotation',
    searchTerms: ['blockquote', 'cite'],
    icon: Quote,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run()
  },
  {
    title: 'Table',
    description: '3×3 table with header row',
    searchTerms: ['grid', 'rows', 'columns'],
    icon: TableIcon,
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run()
  },
  {
    title: 'Divider',
    description: 'Horizontal rule',
    searchTerms: ['hr', 'line', 'separator'],
    icon: Minus,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run()
  }
]

function filterItems(query: string): SlashCommandItem[] {
  const q = query.toLowerCase().trim()
  if (!q) return SLASH_COMMAND_ITEMS
  return SLASH_COMMAND_ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.searchTerms.some((term) => term.includes(q))
  )
}

/**
 * Mounts the React menu in a fixed-position wrapper at the caret. We render via
 * ReactRenderer (no tippy dependency) and position the wrapper from the
 * suggestion's clientRect, mirroring the app's existing popover approach.
 */
function makeRenderer() {
  let component: ReactRenderer<SlashCommandMenuHandle> | null = null
  let wrapper: HTMLDivElement | null = null
  // Set when the user dismisses with Escape so a still-active suggestion state
  // doesn't re-open the menu until the trigger token is abandoned (→ onExit).
  let dismissed = false

  const place = (rect: DOMRect | null | undefined): void => {
    if (!wrapper || !rect) return
    const margin = 4
    // Flip above the caret if it would overflow the viewport bottom.
    const below = rect.bottom + margin
    const wouldOverflow = below + wrapper.offsetHeight > window.innerHeight
    wrapper.style.left = `${Math.round(rect.left)}px`
    wrapper.style.top = wouldOverflow
      ? `${Math.round(rect.top - wrapper.offsetHeight - margin)}px`
      : `${Math.round(below)}px`
  }

  const teardown = (): void => {
    wrapper?.remove()
    component?.destroy()
    component = null
    wrapper = null
  }

  return {
    onStart: (props: SuggestionProps<SlashCommandItem>) => {
      dismissed = false
      component = new ReactRenderer(SlashCommandMenu, { props, editor: props.editor })
      wrapper = document.createElement('div')
      wrapper.style.position = 'fixed'
      wrapper.style.zIndex = '60'
      wrapper.appendChild(component.element)
      document.body.appendChild(wrapper)
      place(props.clientRect?.())
    },
    onUpdate: (props: SuggestionProps<SlashCommandItem>) => {
      if (dismissed) return
      component?.updateProps(props)
      place(props.clientRect?.())
    },
    onKeyDown: (props: SuggestionKeyDownProps) => {
      if (props.event.key === 'Escape') {
        dismissed = true
        teardown()
        return true
      }
      if (dismissed) return false
      return component?.ref?.onKeyDown(props.event) ?? false
    },
    onExit: () => {
      teardown()
    }
  }
}

/**
 * Notion-style slash command. Typing "/" opens a filterable block menu built on
 * @tiptap/suggestion. The selected item's `command` removes the "/query" and
 * runs the corresponding editor command.
 */
export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommandItem>({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        items: ({ query }) => filterItems(query),
        command: ({ editor, range, props }) => props.command({ editor, range }),
        render: makeRenderer
      })
    ]
  }
})
