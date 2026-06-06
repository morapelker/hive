import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { cn } from '@/lib/utils'
import type { SlashCommandItem } from './slash-command'

export interface SlashCommandMenuHandle {
  /** Returns true if the key was consumed by the menu. */
  onKeyDown: (event: KeyboardEvent) => boolean
}

interface SlashCommandMenuProps {
  items: SlashCommandItem[]
  /** Provided by @tiptap/suggestion — selects an item (runs its command). */
  command: (item: SlashCommandItem) => void
}

/**
 * Presentational "/" command list. Keyboard navigation (Up/Down/Enter) is
 * driven through the imperative handle by the suggestion plugin's onKeyDown;
 * mouse selection runs the command directly.
 */
export const SlashCommandMenu = forwardRef<SlashCommandMenuHandle, SlashCommandMenuProps>(
  function SlashCommandMenu({ items, command }, ref) {
    const [selected, setSelected] = useState(0)

    // Reset highlight whenever the filtered list changes.
    useEffect(() => {
      setSelected(0)
    }, [items])

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event) => {
          if (items.length === 0) return false
          if (event.key === 'ArrowUp') {
            setSelected((s) => (s + items.length - 1) % items.length)
            return true
          }
          if (event.key === 'ArrowDown') {
            setSelected((s) => (s + 1) % items.length)
            return true
          }
          if (event.key === 'Enter') {
            const item = items[selected]
            if (item) command(item)
            return true
          }
          return false
        }
      }),
      [items, selected, command]
    )

    if (items.length === 0) {
      return (
        <div className="w-64 rounded-md border border-border bg-popover p-2 text-sm text-muted-foreground shadow-md">
          No matching blocks
        </div>
      )
    }

    return (
      <div
        className="w-64 max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
        data-testid="slash-command-menu"
        role="listbox"
      >
        {items.map((item, i) => {
          const Icon = item.icon
          return (
            <button
              key={item.title}
              type="button"
              role="option"
              aria-selected={i === selected}
              onMouseDown={(e) => {
                // Keep editor focus / selection intact for the command.
                e.preventDefault()
                command(item)
              }}
              onMouseEnter={() => setSelected(i)}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left',
                i === selected
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground hover:bg-accent/50'
              )}
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-tight">{item.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {item.description}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    )
  }
)
