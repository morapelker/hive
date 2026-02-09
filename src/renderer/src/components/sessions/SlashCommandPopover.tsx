import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface SlashCommand {
  name: string
  description?: string
  template: string
}

interface SlashCommandPopoverProps {
  commands: SlashCommand[]
  filter: string
  onSelect: (command: { name: string; template: string }) => void
  onClose: () => void
  visible: boolean
}

const MAX_VISIBLE_ITEMS = 8

export function SlashCommandPopover({
  commands,
  filter,
  onSelect,
  onClose,
  visible
}: SlashCommandPopoverProps): React.JSX.Element | null {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter commands by substring match
  const filterText = filter.startsWith('/') ? filter.slice(1) : filter
  const filtered = commands.filter((c) =>
    c.name.toLowerCase().includes(filterText.toLowerCase())
  ).slice(0, MAX_VISIBLE_ITEMS)

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('[data-slash-item]')
    const item = items[selectedIndex]
    if (item && typeof item.scrollIntoView === 'function') {
      item.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // Keyboard navigation
  useEffect(() => {
    if (!visible) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && filtered.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        const cmd = filtered[selectedIndex]
        if (cmd) {
          onSelect({ name: cmd.name, template: cmd.template })
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [visible, filtered, selectedIndex, onSelect, onClose])

  if (!visible) return null

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 z-50"
      data-testid="slash-command-popover"
    >
      <div
        ref={listRef}
        className="mx-3 rounded-lg border bg-popover text-popover-foreground shadow-md max-h-64 overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {commands.length === 0 ? 'Loading commands...' : 'No matching commands'}
          </div>
        ) : (
          filtered.map((cmd, index) => (
            <div
              key={cmd.name}
              data-slash-item
              data-testid={`slash-item-${cmd.name}`}
              className={cn(
                'flex items-center gap-2 px-3 py-2 cursor-pointer text-sm',
                index === selectedIndex && 'bg-accent text-accent-foreground'
              )}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => onSelect({ name: cmd.name, template: cmd.template })}
            >
              <span className="font-mono text-xs text-muted-foreground">/{cmd.name}</span>
              {cmd.description && (
                <span className="text-xs text-muted-foreground truncate">
                  {cmd.description}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
