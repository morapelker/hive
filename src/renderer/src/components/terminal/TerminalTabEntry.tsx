import { useState, useRef, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TerminalTab } from '@/stores/useTerminalTabStore'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'

interface TerminalTabEntryProps {
  tab: TerminalTab
  isActive: boolean
  onSelect: () => void
  onClose: () => void
  onRename: (name: string) => void
  onCloseOthers: () => void
}

export function TerminalTabEntry({
  tab,
  isActive,
  onSelect,
  onClose,
  onRename,
  onCloseOthers
}: TerminalTabEntryProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(tab.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [isEditing])

  const startRename = useCallback(() => {
    setEditValue(tab.name)
    setIsEditing(true)
  }, [tab.name])

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== tab.name) {
      onRename(trimmed)
    }
    setIsEditing(false)
  }, [editValue, tab.name, onRename])

  const cancelRename = useCallback(() => {
    setEditValue(tab.name)
    setIsEditing(false)
  }, [tab.name])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelRename()
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group flex items-center gap-1.5 px-2 py-1 mx-0.5 rounded-sm cursor-pointer text-xs select-none',
            isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
          )}
          onClick={onSelect}
        >
          {/* Status dot */}
          <span
            className={cn('h-1.5 w-1.5 rounded-full shrink-0', {
              'bg-yellow-500 animate-pulse': tab.status === 'creating',
              'bg-green-500': tab.status === 'running',
              'bg-red-500': tab.status === 'exited' && tab.exitCode !== 0,
              'bg-muted-foreground': tab.status === 'exited' && tab.exitCode === 0
            })}
          />

          {/* Name or inline edit */}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={commitRename}
              className="flex-1 min-w-0 h-4 px-0.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <span
              className="flex-1 min-w-0 truncate"
              onDoubleClick={(e) => {
                e.stopPropagation()
                startRename()
              }}
            >
              {tab.name}
            </span>
          )}

          {/* Hover-reveal close button */}
          {!isEditing && (
            <button
              className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-foreground rounded transition-opacity"
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              title="Close"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={startRename}>Rename</ContextMenuItem>
        <ContextMenuItem onSelect={onClose}>Close</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCloseOthers}>Close Others</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
