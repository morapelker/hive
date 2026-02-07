import { useState, useMemo, memo } from 'react'
import {
  FileText,
  Pencil,
  Terminal,
  Search,
  FolderSearch,
  FilePlus,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Loader2,
  Clock
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type ToolStatus = 'pending' | 'running' | 'success' | 'error'

export interface ToolUseInfo {
  id: string
  name: string
  input: Record<string, unknown>
  status: ToolStatus
  output?: string
  error?: string
  startTime: number
  endTime?: number
}

// Map tool names to icons
function getToolIcon(name: string): React.JSX.Element {
  const iconClass = 'h-3.5 w-3.5'
  const lowerName = name.toLowerCase()

  if (lowerName.includes('read') || lowerName === 'cat' || lowerName === 'view') {
    return <FileText className={iconClass} />
  }
  if (lowerName.includes('write') || lowerName === 'create') {
    return <FilePlus className={iconClass} />
  }
  if (lowerName.includes('edit') || lowerName.includes('replace') || lowerName.includes('patch')) {
    return <Pencil className={iconClass} />
  }
  if (lowerName.includes('bash') || lowerName.includes('shell') || lowerName.includes('exec') || lowerName.includes('command')) {
    return <Terminal className={iconClass} />
  }
  if (lowerName.includes('glob') || lowerName.includes('find') || lowerName.includes('list')) {
    return <FolderSearch className={iconClass} />
  }
  if (lowerName.includes('grep') || lowerName.includes('search') || lowerName.includes('rg')) {
    return <Search className={iconClass} />
  }
  // Default
  return <Terminal className={iconClass} />
}

// Get a display label for the tool
function getToolLabel(name: string, input: Record<string, unknown>): string {
  const lowerName = name.toLowerCase()

  // Show file path for file operations
  if (lowerName.includes('read') || lowerName.includes('write') || lowerName.includes('edit')) {
    const filePath = (input.file_path || input.path || input.file || '') as string
    if (filePath) {
      // Show just the filename or last 2 path segments
      const parts = filePath.split('/')
      return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : filePath
    }
  }

  // Show command for bash
  if (lowerName.includes('bash') || lowerName.includes('shell') || lowerName.includes('exec')) {
    const command = (input.command || input.cmd || '') as string
    if (command) {
      // Truncate long commands
      return command.length > 60 ? command.slice(0, 60) + '...' : command
    }
  }

  // Show pattern for search
  if (lowerName.includes('grep') || lowerName.includes('search')) {
    const pattern = (input.pattern || input.query || input.regex || '') as string
    if (pattern) {
      return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern
    }
  }

  // Show pattern for glob
  if (lowerName.includes('glob') || lowerName.includes('find')) {
    const pattern = (input.pattern || input.glob || '') as string
    if (pattern) {
      return pattern
    }
  }

  return ''
}

function StatusIndicator({ status }: { status: ToolStatus }): React.JSX.Element {
  switch (status) {
    case 'pending':
    case 'running':
      return (
        <Loader2
          className="h-3.5 w-3.5 animate-spin text-blue-500"
          data-testid="tool-spinner"
        />
      )
    case 'success':
      return (
        <Check
          className="h-3.5 w-3.5 text-green-500"
          data-testid="tool-success"
        />
      )
    case 'error':
      return (
        <X
          className="h-3.5 w-3.5 text-red-500"
          data-testid="tool-error"
        />
      )
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

interface ToolCardProps {
  toolUse: ToolUseInfo
}

export const ToolCard = memo(function ToolCard({ toolUse }: ToolCardProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)

  const label = useMemo(
    () => getToolLabel(toolUse.name, toolUse.input),
    [toolUse.name, toolUse.input]
  )

  const duration = useMemo(() => {
    if (toolUse.endTime && toolUse.startTime) {
      return formatDuration(toolUse.endTime - toolUse.startTime)
    }
    return null
  }, [toolUse.startTime, toolUse.endTime])

  const hasOutput = !!(toolUse.output || toolUse.error)

  return (
    <div
      className={cn(
        'my-2 rounded-lg border text-xs',
        toolUse.status === 'error'
          ? 'border-red-500/30 bg-red-500/5'
          : 'border-border bg-muted/30'
      )}
      data-testid="tool-card"
      data-tool-name={toolUse.name}
      data-tool-status={toolUse.status}
    >
      {/* Header - always visible */}
      <button
        onClick={() => hasOutput && setIsExpanded(!isExpanded)}
        className={cn(
          'flex items-center gap-2 w-full px-3 py-2 text-left',
          hasOutput && 'cursor-pointer hover:bg-muted/50 transition-colors'
        )}
        disabled={!hasOutput}
        data-testid="tool-card-header"
      >
        {/* Expand/Collapse chevron */}
        {hasOutput ? (
          isExpanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {/* Tool icon */}
        <span className="text-muted-foreground shrink-0">
          {getToolIcon(toolUse.name)}
        </span>

        {/* Tool name */}
        <span className="font-medium text-foreground shrink-0">
          {toolUse.name}
        </span>

        {/* Tool label (file path, command, etc.) */}
        {label && (
          <span className="text-muted-foreground truncate font-mono">
            {label}
          </span>
        )}

        {/* Spacer */}
        <span className="flex-1" />

        {/* Duration */}
        {duration && (
          <span className="text-muted-foreground shrink-0 flex items-center gap-1" data-testid="tool-duration">
            <Clock className="h-3 w-3" />
            {duration}
          </span>
        )}

        {/* Status indicator */}
        <StatusIndicator status={toolUse.status} />
      </button>

      {/* Expandable output */}
      {isExpanded && hasOutput && (
        <div
          className="border-t border-border px-3 py-2"
          data-testid="tool-output"
        >
          {toolUse.error && (
            <div className="text-red-400 font-mono whitespace-pre-wrap break-all">
              {toolUse.error}
            </div>
          )}
          {toolUse.output && (
            <pre className="text-muted-foreground font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
              {toolUse.output.length > 2000
                ? toolUse.output.slice(0, 2000) + '\n... (truncated)'
                : toolUse.output}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})
