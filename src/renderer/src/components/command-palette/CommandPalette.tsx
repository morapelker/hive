import { useEffect, useCallback, useMemo } from 'react'
import { Command } from 'cmdk'
import { useCommandPaletteStore, type Command as CommandType } from '@/stores/useCommandPaletteStore'
import { useCommands } from '@/hooks'
import { categoryLabels } from '@/lib/command-registry'
import { CommandItem } from './CommandItem'
import {
  ArrowLeft,
  Search
} from 'lucide-react'

export function CommandPalette() {
  const {
    isOpen,
    searchQuery,
    selectedIndex,
    commandStack,
    currentParent,
    close,
    setSearchQuery,
    setSelectedIndex,
    moveSelection,
    popCommandLevel
  } = useCommandPaletteStore()

  const { filteredCommands, recentCommands, executeCommand } = useCommands()

  // Cmd/Ctrl+P is handled centrally by useKeyboardShortcuts

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return

      if (e.key === 'Escape') {
        e.preventDefault()
        if (commandStack.length > 0) {
          popCommandLevel()
        } else {
          close()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, commandStack.length, popCommandLevel, close])

  // Get commands to display based on current level
  const displayCommands = useMemo(() => {
    if (commandStack.length > 0) {
      // Show commands from nested level
      return commandStack[commandStack.length - 1]
    }
    return filteredCommands
  }, [commandStack, filteredCommands])

  // Group commands by category for display
  const groupedCommands = useMemo(() => {
    // If we have a search query or in nested mode, don't group
    if (searchQuery.trim() || commandStack.length > 0) {
      return new Map([['results', displayCommands]])
    }

    // Group by category
    const groups = new Map<string, CommandType[]>()

    // Add recent commands first if available
    if (recentCommands.length > 0) {
      groups.set('recent', recentCommands)
    }

    // Group the rest by category
    for (const cmd of displayCommands) {
      // Skip commands that are in recent (to avoid duplicates in Recent section)
      if (recentCommands.some((r) => r.id === cmd.id)) continue

      const category = cmd.category
      const existing = groups.get(category) || []
      groups.set(category, [...existing, cmd])
    }

    return groups
  }, [displayCommands, recentCommands, searchQuery, commandStack.length])

  // Total command count for navigation
  const totalCommands = useMemo(() => {
    let count = 0
    for (const commands of groupedCommands.values()) {
      count += commands.length
    }
    return count
  }, [groupedCommands])

  // Handle command selection
  const handleSelect = useCallback(
    async (command: CommandType) => {
      if (command.hasChildren && command.getChildren) {
        // Don't execute, just show children
        return
      }

      // Check if enabled
      if (command.isEnabled && !command.isEnabled()) {
        return
      }

      await executeCommand(command)
    },
    [executeCommand]
  )

  // Handle arrow key navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveSelection(1, totalCommands)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveSelection(-1, totalCommands)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, totalCommands, moveSelection])

  // Close on click outside
  const handleOverlayClick = useCallback(() => {
    close()
  }, [close])

  if (!isOpen) return null

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/50 z-50"
        onClick={handleOverlayClick}
        data-testid="command-palette-overlay"
      />

      {/* Command palette dialog */}
      <div
        className="fixed left-1/2 top-[20%] -translate-x-1/2 w-full max-w-xl z-50"
        data-testid="command-palette"
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
      >
        <Command
          className="rounded-lg border border-border bg-popover shadow-xl overflow-hidden"
          shouldFilter={false}
          label="Command palette"
        >
          {/* Search input */}
          <div className="flex items-center border-b border-border px-3">
            {commandStack.length > 0 ? (
              <button
                onClick={popCommandLevel}
                className="mr-2 p-1 rounded hover:bg-muted"
                aria-label="Go back"
              >
                <ArrowLeft className="w-4 h-4 text-muted-foreground" />
              </button>
            ) : (
              <Search className="w-4 h-4 text-muted-foreground mr-2" />
            )}
            <Command.Input
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder={
                currentParent
                  ? `Search in ${currentParent.label}...`
                  : 'Type a command or search...'
              }
              className="flex-1 h-12 bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground"
              autoFocus
              data-testid="command-palette-input"
            />
          </div>

          {/* Command list */}
          <Command.List className="max-h-[300px] overflow-y-auto p-2">
            {totalCommands === 0 && (
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                No commands found.
              </Command.Empty>
            )}

            {Array.from(groupedCommands.entries()).map(([category, commands]) => {
              // Get display label for category
              const label =
                category === 'results'
                  ? commandStack.length > 0
                    ? currentParent?.label || 'Results'
                    : 'Results'
                  : categoryLabels[category as keyof typeof categoryLabels] || category

              return (
                <Command.Group key={category} heading={label} className="mb-2">
                  {commands.map((command, idx) => {
                    // Calculate global index for this command
                    let globalIndex = 0
                    let found = false
                    for (const [cat, cmds] of groupedCommands.entries()) {
                      if (cat === category) {
                        globalIndex += idx
                        found = true
                        break
                      }
                      globalIndex += cmds.length
                    }

                    const isSelected = found && globalIndex === selectedIndex

                    return (
                      <CommandItem
                        key={command.id}
                        command={command}
                        isSelected={isSelected}
                        onSelect={() => handleSelect(command)}
                        onMouseEnter={() => {
                          if (found) setSelectedIndex(globalIndex)
                        }}
                      />
                    )
                  })}
                </Command.Group>
              )
            })}
          </Command.List>

          {/* Footer with keyboard hints */}
          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-4">
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">↑↓</kbd>
                {' '}navigate
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">↵</kbd>
                {' '}select
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">esc</kbd>
                {' '}close
              </span>
            </div>
            {commandStack.length > 0 && (
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">esc</kbd>
                {' '}or{' '}
                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">←</kbd>
                {' '}go back
              </span>
            )}
          </div>
        </Command>
      </div>
    </>
  )
}
