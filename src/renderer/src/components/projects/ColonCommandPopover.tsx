import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ColonCommandItem {
  key: string
  label: string
  icon?: ReactNode
}

interface ColonCommandPopoverProps {
  visible: boolean
  items: ColonCommandItem[]
  selectedIndex: number
  onSelectedIndexChange: (index: number) => void
  onSelect: (key: string) => void
  onClose: () => void
  emptyMessage?: string
}

const MAX_VISIBLE_ITEMS = 8

export function ColonCommandPopover({
  visible,
  items,
  selectedIndex,
  onSelectedIndexChange,
  onSelect,
  onClose,
  emptyMessage = 'No matches'
}: ColonCommandPopoverProps): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)

  const displayed = items.slice(0, MAX_VISIBLE_ITEMS)

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const els = listRef.current.querySelectorAll('[data-colon-item]')
    const el = els[selectedIndex]
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // Capture-phase keyboard navigation
  useEffect(() => {
    if (!visible) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        onSelectedIndexChange(Math.min(selectedIndex + 1, displayed.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        onSelectedIndexChange(Math.max(selectedIndex - 1, 0))
      } else if ((e.key === 'Enter' || e.key === 'Tab') && displayed.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        const item = displayed[selectedIndex]
        if (item) onSelect(item.key)
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
  }, [visible, displayed, selectedIndex, onSelect, onClose, onSelectedIndexChange])

  if (!visible) return null

  return (
    <div
      className="absolute top-full left-0 right-0 mt-1 z-50"
      data-testid="colon-command-popover"
    >
      <div
        ref={listRef}
        className="rounded-lg border bg-popover text-popover-foreground shadow-md max-h-64 overflow-y-auto"
      >
        {displayed.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">{emptyMessage}</div>
        ) : (
          displayed.map((item, index) => (
            <div
              key={item.key}
              data-colon-item
              data-testid={`colon-item-${item.key}`}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm',
                index === selectedIndex && 'bg-accent text-accent-foreground'
              )}
              onMouseEnter={() => onSelectedIndexChange(index)}
              onClick={() => onSelect(item.key)}
            >
              {item.icon}
              <span>{item.label}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
