import { useState, useMemo, memo } from 'react'
import {
  FileText,
  Pencil,
  Terminal,
  Search,
  FolderSearch,
  FilePlus,
  Bot,
  ChevronDown,
  Check,
  X,
  Loader2,
  Clock
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolViewProps } from './tools/types'
import { ReadToolView } from './tools/ReadToolView'
import { EditToolView } from './tools/EditToolView'
import { GrepToolView } from './tools/GrepToolView'
import { BashToolView } from './tools/BashToolView'
import { TodoToolView } from './tools/TodoToolView'
import { TaskToolView } from './tools/TaskToolView'

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
  if (lowerName === 'task') {
    return <Bot className={iconClass} />
  }
  // Default
  return <Terminal className={iconClass} />
}

// Get a display label for the tool
function getToolLabel(name: string, input: Record<string, unknown>, cwd?: string | null): string {
  const lowerName = name.toLowerCase()

  // Show file path for file operations
  if (lowerName.includes('read') || lowerName.includes('write') || lowerName.includes('edit')) {
    const filePath = (input.filePath || input.file_path || input.path || '') as string
    if (filePath) {
      return shortenPath(filePath, cwd)
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

  // Show description for task
  if (lowerName === 'task') {
    const description = (input.description || '') as string
    if (description) {
      return description
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

function getLeftBorderColor(status: ToolStatus): string {
  switch (status) {
    case 'pending':
      return 'hsl(var(--muted-foreground))'
    case 'running':
      return '#3b82f6' // blue-500
    case 'success':
      return '#22c55e' // green-500
    case 'error':
      return '#ef4444' // red-500
  }
}

// Map tool names to rich renderers
const TOOL_RENDERERS: Record<string, React.FC<ToolViewProps>> = {
  Read: ReadToolView,
  read_file: ReadToolView,
  Write: ReadToolView, // Similar rendering to Read
  write_file: ReadToolView,
  Edit: EditToolView,
  edit_file: EditToolView,
  Grep: GrepToolView,
  grep: GrepToolView,
  Glob: GrepToolView, // Similar rendering to Grep
  glob: GrepToolView,
  Bash: BashToolView,
  bash: BashToolView,
  Task: TaskToolView,
  task: TaskToolView,
}

/** Resolve a tool name to its rich renderer, falling back to TodoToolView */
function getToolRenderer(name: string): React.FC<ToolViewProps> {
  // Try exact match first
  if (TOOL_RENDERERS[name]) return TOOL_RENDERERS[name]
  // Try case-insensitive match via known patterns
  const lower = name.toLowerCase()
  if (lower.includes('read') || lower === 'cat' || lower === 'view') return ReadToolView
  if (lower.includes('write') || lower === 'create') return ReadToolView
  if (lower.includes('edit') || lower.includes('replace') || lower.includes('patch')) return EditToolView
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec') || lower.includes('command')) return BashToolView
  if (lower.includes('grep') || lower.includes('search') || lower.includes('rg')) return GrepToolView
  if (lower.includes('glob') || lower.includes('find') || lower.includes('list')) return GrepToolView
  if (lower === 'task') return TaskToolView
  // Fallback
  return TodoToolView
}

function shortenPath(filePath: string, cwd?: string | null): string {
  if (cwd && filePath.startsWith(cwd)) {
    const relative = filePath.slice(cwd.length).replace(/^\//, '')
    if (relative) return relative
  }
  const parts = filePath.split('/')
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : filePath
}

/** Renders tool-specific collapsed header content (icon + name + contextual info) */
function CollapsedContent({ toolUse, cwd }: { toolUse: ToolUseInfo; cwd?: string | null }): React.JSX.Element {
  const { name, input, output } = toolUse
  const lowerName = name.toLowerCase()

  // Bash / Shell / Exec
  if (lowerName.includes('bash') || lowerName.includes('shell') || lowerName.includes('exec') || lowerName.includes('command')) {
    const command = (input.command || input.cmd || '') as string
    const truncCmd = command.length > 60 ? command.slice(0, 60) + '...' : command
    return (
      <>
        <span className="text-muted-foreground shrink-0"><Terminal className="h-3.5 w-3.5" /></span>
        <span className="font-medium text-foreground shrink-0">Bash</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">
          <span className="text-green-500">$</span> {truncCmd}
        </span>
      </>
    )
  }

  // Read / Cat / View
  if (lowerName.includes('read') || lowerName === 'cat' || lowerName === 'view') {
    const filePath = (input.filePath || input.file_path || input.path || '') as string
    const lineCount = output ? output.trimEnd().split('\n').length : null
    return (
      <>
        <span className="text-muted-foreground shrink-0"><FileText className="h-3.5 w-3.5" /></span>
        <span className="font-medium text-foreground shrink-0">Read</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">{shortenPath(filePath, cwd)}</span>
        {lineCount !== null && (
          <span className="text-muted-foreground/60 shrink-0 text-[10px]">{lineCount} lines</span>
        )}
      </>
    )
  }

  // Write / Create
  if (lowerName.includes('write') || lowerName === 'create') {
    const filePath = (input.filePath || input.file_path || input.path || '') as string
    const content = (input.content || '') as string
    const lineCount = content ? content.trimEnd().split('\n').length : null
    return (
      <>
        <span className="text-muted-foreground shrink-0"><FilePlus className="h-3.5 w-3.5" /></span>
        <span className="font-medium text-foreground shrink-0">Write</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">{shortenPath(filePath, cwd)}</span>
        {lineCount !== null && (
          <span className="text-muted-foreground/60 shrink-0 text-[10px]">{lineCount} lines</span>
        )}
      </>
    )
  }

  // Edit / Replace / Patch
  if (lowerName.includes('edit') || lowerName.includes('replace') || lowerName.includes('patch')) {
    const filePath = (input.filePath || input.file_path || input.path || '') as string
    const oldString = (input.oldString || input.old_string || '') as string
    const newString = (input.newString || input.new_string || '') as string
    const removedLines = oldString ? oldString.split('\n').length : 0
    const addedLines = newString ? newString.split('\n').length : 0
    return (
      <>
        <span className="text-muted-foreground shrink-0"><Pencil className="h-3.5 w-3.5" /></span>
        <span className="font-medium text-foreground shrink-0">Edit</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">{shortenPath(filePath, cwd)}</span>
        {(removedLines > 0 || addedLines > 0) && (
          <span className="shrink-0 text-[10px] flex items-center gap-1">
            {removedLines > 0 && <span className="text-red-400">-{removedLines}</span>}
            {addedLines > 0 && <span className="text-green-400">+{addedLines}</span>}
          </span>
        )}
      </>
    )
  }

  // Grep / Search / Rg
  if (lowerName.includes('grep') || lowerName.includes('search') || lowerName.includes('rg')) {
    const pattern = (input.pattern || input.query || input.regex || '') as string
    const matchCount = output ? output.split('\n').filter(l => l.trim()).length : null
    return (
      <>
        <span className="text-muted-foreground shrink-0"><Search className="h-3.5 w-3.5" /></span>
        <span className="font-medium text-foreground shrink-0">Grep</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">&quot;{pattern}&quot;</span>
        {matchCount !== null && matchCount > 0 && (
          <span className="text-muted-foreground/60 shrink-0 text-[10px]">
            {matchCount} {matchCount === 1 ? 'match' : 'matches'}
          </span>
        )}
      </>
    )
  }

  // Glob / Find / List
  if (lowerName.includes('glob') || lowerName.includes('find') || lowerName.includes('list')) {
    const pattern = (input.pattern || input.glob || '') as string
    const fileCount = output ? output.split('\n').filter(l => l.trim()).length : null
    return (
      <>
        <span className="text-muted-foreground shrink-0"><FolderSearch className="h-3.5 w-3.5" /></span>
        <span className="font-medium text-foreground shrink-0">Glob</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">{pattern}</span>
        {fileCount !== null && fileCount > 0 && (
          <span className="text-muted-foreground/60 shrink-0 text-[10px]">
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
          </span>
        )}
      </>
    )
  }

  // Task
  if (lowerName === 'task') {
    const description = (input.description || '') as string
    const subagentType = (input.subagent_type || input.subagentType || '') as string
    return (
      <>
        <span className="text-muted-foreground shrink-0"><Bot className="h-3.5 w-3.5" /></span>
        <span className="font-medium text-foreground shrink-0">Task</span>
        {subagentType && (
          <span className="text-[10px] bg-blue-500/15 text-blue-500 dark:text-blue-400 rounded px-1 py-0.5 font-medium shrink-0">
            {subagentType}
          </span>
        )}
        <span className="text-muted-foreground truncate min-w-0">{description}</span>
      </>
    )
  }

  // Default fallback
  const label = getToolLabel(name, input, cwd)
  return (
    <>
      <span className="text-muted-foreground shrink-0">{getToolIcon(name)}</span>
      <span className="font-medium text-foreground shrink-0">{name}</span>
      {label && <span className="text-muted-foreground truncate font-mono min-w-0">{label}</span>}
    </>
  )
}

interface ToolCardProps {
  toolUse: ToolUseInfo
  cwd?: string | null
  compact?: boolean
}

export const ToolCard = memo(function ToolCard({ toolUse, cwd, compact = false }: ToolCardProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)

  const duration = useMemo(() => {
    if (toolUse.endTime && toolUse.startTime) {
      return formatDuration(toolUse.endTime - toolUse.startTime)
    }
    return null
  }, [toolUse.startTime, toolUse.endTime])

  const hasOutput = !!(toolUse.output || toolUse.error)

  const Renderer = useMemo(() => getToolRenderer(toolUse.name), [toolUse.name])

  return (
    <div
      className={cn(
        compact ? 'my-0 rounded-md border border-l-2 text-xs' : 'my-1 rounded-md border border-l-2 text-xs',
        toolUse.status === 'running' && 'animate-pulse',
        toolUse.status === 'error'
          ? 'border-red-500/30 bg-red-500/5'
          : 'border-border bg-muted/30'
      )}
      style={{ borderLeftColor: getLeftBorderColor(toolUse.status) }}
      data-testid="tool-card"
      data-tool-name={toolUse.name}
      data-tool-status={toolUse.status}
    >
      {/* Header - always visible */}
      <button
        onClick={() => hasOutput && setIsExpanded(!isExpanded)}
        className={cn(
          compact ? 'flex items-center gap-1.5 w-full px-2 py-1.5 text-left' : 'flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left',
          hasOutput && 'cursor-pointer hover:bg-muted/50 transition-colors'
        )}
        disabled={!hasOutput}
        aria-expanded={hasOutput ? isExpanded : undefined}
        data-testid="tool-card-header"
      >
        {/* Tool-specific collapsed content */}
        <CollapsedContent toolUse={toolUse} cwd={cwd} />

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

        {/* Expand/Collapse affordance */}
        {hasOutput && (
          <span className="ml-1 inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {isExpanded ? 'Hide' : 'View'}
            <ChevronDown
              className={cn(
                'h-2.5 w-2.5 shrink-0 transition-transform duration-150',
                !isExpanded && '-rotate-90'
              )}
            />
          </span>
        )}
      </button>

      {/* Expandable detail view with rich renderer */}
      <div
        className={cn(
          'transition-all duration-150 overflow-hidden',
          isExpanded && hasOutput ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'
        )}
        data-testid="tool-output"
      >
        <div className={cn('border-t border-border', compact ? 'px-2 py-1.5' : 'px-2.5 py-2')}>
          <Renderer
            name={toolUse.name}
            input={toolUse.input}
            output={toolUse.output}
            error={toolUse.error}
            status={toolUse.status}
          />
        </div>
      </div>
    </div>
  )
})
