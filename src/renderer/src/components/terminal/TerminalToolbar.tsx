import { useEffect, useRef } from 'react'
import { Search, X, ChevronUp, ChevronDown, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TerminalBackendType } from './backends/types'

interface TerminalToolbarProps {
  status: 'creating' | 'running' | 'exited'
  exitCode?: number
  searchVisible: boolean
  searchQuery: string
  onToggleSearch: () => void
  onSearchChange: (query: string) => void
  onSearchNext: () => void
  onSearchPrev: () => void
  onSearchClose: () => void
  onRestart: () => void
  onClear: () => void
  backendType?: TerminalBackendType
}

export function TerminalToolbar({
  status,
  exitCode,
  searchVisible,
  searchQuery,
  onToggleSearch,
  onSearchChange,
  onSearchNext,
  onSearchPrev,
  onSearchClose,
  onRestart,
  onClear,
  backendType = 'xterm'
}: TerminalToolbarProps): React.JSX.Element {
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Focus search input when search becomes visible
  useEffect(() => {
    if (searchVisible) {
      // Small delay to ensure the input is rendered
      requestAnimationFrame(() => {
        searchInputRef.current?.focus()
      })
    }
  }, [searchVisible])

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        onSearchPrev()
      } else {
        onSearchNext()
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onSearchClose()
    }
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-background/50 text-xs shrink-0">
      {/* Status indicator */}
      <div className="flex items-center gap-1.5 mr-1">
        <span
          className={cn('h-1.5 w-1.5 rounded-full', {
            'bg-yellow-500 animate-pulse': status === 'creating',
            'bg-green-500': status === 'running',
            'bg-red-500': status === 'exited' && exitCode !== 0,
            'bg-muted-foreground': status === 'exited' && exitCode === 0
          })}
        />
        <span className="text-muted-foreground select-none">
          {status === 'creating' && 'Starting...'}
          {status === 'running' && (backendType === 'ghostty' ? 'Ghostty' : 'Terminal')}
          {status === 'exited' && `Exited (${exitCode ?? '?'})`}
        </span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Search bar (inline, shown when toggled) */}
      {searchVisible && (
        <div className="flex items-center gap-1 mr-1">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search..."
            className="h-5 w-44 px-1.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="terminal-search-input"
          />
          <button
            onClick={onSearchPrev}
            className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onSearchNext}
            className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
            title="Next match (Enter)"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onSearchClose}
            className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
            title="Close search (Escape)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Toolbar actions */}
      {backendType !== 'ghostty' && (
        <button
          onClick={onToggleSearch}
          className={cn(
            'p-1 rounded transition-colors',
            searchVisible
              ? 'text-foreground bg-accent'
              : 'text-muted-foreground hover:text-foreground'
          )}
          title="Search (Cmd+F)"
          data-testid="terminal-search-toggle"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        onClick={onClear}
        className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
        title="Clear terminal (Cmd+K)"
        data-testid="terminal-clear"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {status === 'exited' && (
        <button
          onClick={onRestart}
          className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
          title="Restart terminal"
          data-testid="terminal-restart"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
