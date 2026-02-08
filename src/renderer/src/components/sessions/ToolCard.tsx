import { useState, useMemo, memo } from 'react'
import {
  FileText,
  Pencil,
  Terminal,
  Search,
  FolderSearch,
  FilePlus,
  ChevronDown,
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

const MAX_LINES = 10

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

function getLeftBorderClass(status: ToolStatus): string {
  switch (status) {
    case 'pending':
      return 'border-l-2 border-l-muted-foreground'
    case 'running':
      return 'border-l-2 border-l-blue-500 animate-pulse'
    case 'success':
      return 'border-l-2 border-l-green-500'
    case 'error':
      return 'border-l-2 border-l-red-500'
  }
}

interface ToolCardProps {
  toolUse: ToolUseInfo
}

export const ToolCard = memo(function ToolCard({ toolUse }: ToolCardProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const [showFullOutput, setShowFullOutput] = useState(false)

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

  const outputLines = useMemo(() => {
    if (!toolUse.output) return { lines: [], totalCount: 0, needsTruncation: false }
    const lines = toolUse.output.split('\n')
    return {
      lines,
      totalCount: lines.length,
      needsTruncation: lines.length > MAX_LINES
    }
  }, [toolUse.output])

  const displayedOutput = useMemo(() => {
    if (!toolUse.output) return ''
    if (!outputLines.needsTruncation || showFullOutput) return toolUse.output
    return outputLines.lines.slice(0, MAX_LINES).join('\n')
  }, [toolUse.output, outputLines, showFullOutput])

  return (
    <div
      className={cn(
        'my-3 rounded-lg border text-xs',
        getLeftBorderClass(toolUse.status),
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
          'flex items-center gap-2 w-full px-3.5 py-2.5 text-left',
          hasOutput && 'cursor-pointer hover:bg-muted/50 transition-colors'
        )}
        disabled={!hasOutput}
        data-testid="tool-card-header"
      >
        {/* Expand/Collapse chevron with smooth rotation */}
        {hasOutput ? (
          <ChevronDown
            className={cn(
              'h-3 w-3 text-muted-foreground shrink-0 transition-transform duration-150',
              !isExpanded && '-rotate-90'
            )}
          />
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

      {/* Expandable output with smooth transition */}
      <div
        className={cn(
          'transition-all duration-150 overflow-hidden',
          isExpanded && hasOutput ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'
        )}
        data-testid="tool-output"
      >
        <div className="border-t border-border px-3.5 py-2.5">
          {toolUse.error && (
            <div className="text-red-400 font-mono whitespace-pre-wrap break-all">
              {toolUse.error}
            </div>
          )}
          {toolUse.output && (
            <div>
              <pre className="text-muted-foreground font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                {displayedOutput}
              </pre>
              {outputLines.needsTruncation && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowFullOutput(!showFullOutput)
                  }}
                  className="mt-1.5 text-blue-500 hover:text-blue-400 text-xs font-medium transition-colors"
                  data-testid="show-more-button"
                >
                  {showFullOutput
                    ? 'Show less'
                    : `Show more (${outputLines.totalCount - MAX_LINES} more lines)`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
