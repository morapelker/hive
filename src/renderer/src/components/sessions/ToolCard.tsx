import { useState, useMemo, memo } from 'react'
import {
  FileText,
  Pencil,
  Terminal,
  Search,
  FolderSearch,
  FilePlus,
  Bot,
  MessageCircleQuestion,
  ListTodo,
  ChevronDown,
  Check,
  X,
  Loader2,
  Clock,
  Plus,
  Minus,
  Zap,
  ClipboardCheck,
  Globe,
  Code2
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolViewProps } from './tools/types'
import { ReadToolView } from './tools/ReadToolView'
import { WriteToolView } from './tools/WriteToolView'
import { EditToolView } from './tools/EditToolView'
import { GrepToolView } from './tools/GrepToolView'
import { BashToolView } from './tools/BashToolView'
import { FallbackToolView } from './tools/FallbackToolView'
import { TodoWriteToolView } from './tools/TodoWriteToolView'
import { TaskToolView } from './tools/TaskToolView'
import { QuestionToolView } from './tools/QuestionToolView'
import { SkillToolView } from './tools/SkillToolView'
import { ExitPlanModeToolView } from './tools/ExitPlanModeToolView'
import { WebFetchToolView } from './tools/WebFetchToolView'
import {
  LspToolView,
  getLspOperationLabel,
  getLspOperationColor,
  getLspResultCount
} from './tools/LspToolView'
import { ToolCallContextMenu } from './ToolCallContextMenu'

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

/** Check if a tool name refers to the TodoWrite tool */
function isTodoWriteTool(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('todowrite') || lower.includes('todo_write')
}

/** Check if a tool name refers to the LSP tool */
function isLspTool(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'mcp__hive-lsp__lsp' || lower.includes('hive-lsp')
}

// Map tool names to icons
function getToolIcon(name: string): React.JSX.Element {
  const iconClass = 'h-3.5 w-3.5'
  const lowerName = name.toLowerCase()

  if (isTodoWriteTool(lowerName)) {
    return <ListTodo className={iconClass} />
  }
  if (lowerName.includes('read') || lowerName === 'cat' || lowerName === 'view') {
    return <FileText className={iconClass} />
  }
  if (lowerName.includes('write') || lowerName === 'create') {
    return <FilePlus className={iconClass} />
  }
  if (lowerName.includes('edit') || lowerName.includes('replace') || lowerName.includes('patch')) {
    return <Pencil className={iconClass} />
  }
  if (
    lowerName.includes('bash') ||
    lowerName.includes('shell') ||
    lowerName.includes('exec') ||
    lowerName.includes('command')
  ) {
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
  if (lowerName.includes('question')) {
    return <MessageCircleQuestion className={iconClass} />
  }
  if (lowerName.includes('skill')) {
    return <Zap className={iconClass} />
  }
  if (lowerName === 'exitplanmode') {
    return <ClipboardCheck className={iconClass} />
  }
  if (lowerName === 'webfetch' || lowerName === 'web_fetch') {
    return <Globe className={iconClass} />
  }
  if (isLspTool(name)) {
    return <Code2 className={cn(iconClass, 'text-purple-400')} />
  }
  // Default
  return <Terminal className={iconClass} />
}

// Get a display label for the tool
function getToolLabel(name: string, input: Record<string, unknown>, cwd?: string | null): string {
  const lowerName = name.toLowerCase()

  // Show summary for todowrite (must be before 'write' check)
  if (isTodoWriteTool(lowerName)) {
    const todos = (input.todos || []) as Array<{ status: string }>
    const completed = todos.filter((t) => t.status === 'completed').length
    return `${completed}/${todos.length} completed`
  }

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

  // Show skill name — Skill tool uses `skill` param, not `name`
  if (lowerName.includes('skill')) {
    const skillName = (input.skill || input.name || '') as string
    return skillName || 'unknown'
  }

  // Show URL for webfetch
  if (lowerName === 'webfetch' || lowerName === 'web_fetch') {
    const url = (input.url || '') as string
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  }

  // Show operation for LSP tool
  if (isLspTool(name)) {
    const operation = (input.operation || '') as string
    return getLspOperationLabel(operation)
  }

  return ''
}

function StatusIndicator({ status }: { status: ToolStatus }): React.JSX.Element {
  switch (status) {
    case 'pending':
    case 'running':
      return (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" data-testid="tool-spinner" />
      )
    case 'success':
      return <Check className="h-3.5 w-3.5 text-green-500" data-testid="tool-success" />
    case 'error':
      return <X className="h-3.5 w-3.5 text-red-500" data-testid="tool-error" />
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
  Write: WriteToolView,
  write_file: WriteToolView,
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
  mcp_question: QuestionToolView,
  question: QuestionToolView,
  mcp_todowrite: TodoWriteToolView,
  TodoWrite: TodoWriteToolView,
  todowrite: TodoWriteToolView,
  Skill: SkillToolView,
  mcp_skill: SkillToolView,
  ExitPlanMode: ExitPlanModeToolView,
  exitplanmode: ExitPlanModeToolView,
  WebFetch: WebFetchToolView,
  webfetch: WebFetchToolView,
  web_fetch: WebFetchToolView,
  'mcp__hive-lsp__lsp': LspToolView
}

/** Resolve a tool name to its rich renderer, falling back to FallbackToolView */
function getToolRenderer(name: string): React.FC<ToolViewProps> {
  // Try exact match first
  if (TOOL_RENDERERS[name]) return TOOL_RENDERERS[name]
  // Try case-insensitive match via known patterns
  const lower = name.toLowerCase()
  if (lower.includes('todowrite') || lower.includes('todo_write')) return TodoWriteToolView
  if (lower.includes('read') || lower === 'cat' || lower === 'view') return ReadToolView
  if (lower.includes('write') || lower === 'create') return WriteToolView
  if (lower.includes('edit') || lower.includes('replace') || lower.includes('patch'))
    return EditToolView
  if (
    lower.includes('bash') ||
    lower.includes('shell') ||
    lower.includes('exec') ||
    lower.includes('command')
  )
    return BashToolView
  if (lower.includes('grep') || lower.includes('search') || lower.includes('rg'))
    return GrepToolView
  if (lower.includes('glob') || lower.includes('find') || lower.includes('list'))
    return GrepToolView
  if (lower === 'task') return TaskToolView
  if (lower.includes('question')) return QuestionToolView
  if (lower.includes('skill')) return SkillToolView
  if (lower === 'exitplanmode') return ExitPlanModeToolView
  if (lower === 'webfetch' || lower === 'web_fetch') return WebFetchToolView
  if (isLspTool(name)) return LspToolView
  // Fallback
  return FallbackToolView
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
function CollapsedContent({
  toolUse,
  cwd
}: {
  toolUse: ToolUseInfo
  cwd?: string | null
}): React.JSX.Element {
  const { name, input, output } = toolUse
  const lowerName = name.toLowerCase()

  // Bash / Shell / Exec
  if (
    lowerName.includes('bash') ||
    lowerName.includes('shell') ||
    lowerName.includes('exec') ||
    lowerName.includes('command')
  ) {
    const command = (input.command || input.cmd || '') as string
    const truncCmd = command.length > 60 ? command.slice(0, 60) + '...' : command
    return (
      <>
        <span className="text-muted-foreground shrink-0">
          <Terminal className="h-3.5 w-3.5" />
        </span>
        <span className="font-medium text-foreground shrink-0">Bash</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">
          <span className="text-green-500">$</span> {truncCmd}
        </span>
      </>
    )
  }

  // TodoWrite (must be before 'write' check since name contains 'write')
  if (isTodoWriteTool(lowerName)) {
    const todos = (input.todos || []) as Array<{ status: string }>
    const completed = todos.filter((t) => t.status === 'completed').length
    const inProgress = todos.filter((t) => t.status === 'in_progress').length
    return (
      <>
        <span className="text-muted-foreground shrink-0">
          <ListTodo className="h-3.5 w-3.5" />
        </span>
        <span className="font-medium text-foreground shrink-0">Tasks</span>
        <span className="text-muted-foreground truncate min-w-0">
          {completed}/{todos.length} completed
        </span>
        {inProgress > 0 && (
          <span className="text-[10px] bg-blue-500/15 text-blue-500 dark:text-blue-400 rounded px-1 py-0.5 font-medium shrink-0">
            {inProgress} active
          </span>
        )}
      </>
    )
  }

  // Read / Cat / View
  if (lowerName.includes('read') || lowerName === 'cat' || lowerName === 'view') {
    const filePath = (input.filePath || input.file_path || input.path || '') as string
    const lineCount = output ? output.trimEnd().split('\n').length : null
    return (
      <>
        <span className="text-muted-foreground shrink-0">
          <FileText className="h-3.5 w-3.5" />
        </span>
        <span className="font-medium text-foreground shrink-0">Read</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">
          {shortenPath(filePath, cwd)}
        </span>
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
        <span className="text-muted-foreground shrink-0">
          <FilePlus className="h-3.5 w-3.5" />
        </span>
        <span className="font-medium text-foreground shrink-0">Write</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">
          {shortenPath(filePath, cwd)}
        </span>
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
        <span className="text-muted-foreground shrink-0">
          <Pencil className="h-3.5 w-3.5" />
        </span>
        <span className="font-medium text-foreground shrink-0">Edit</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">
          {shortenPath(filePath, cwd)}
        </span>
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
    const searchPath = (input.path || '') as string
    const matchCount = output ? output.split('\n').filter((l) => l.trim()).length : null
    return (
      <>
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground">Search</span>
        <span className="truncate">&quot;{pattern}&quot;</span>
        {searchPath && <span className="text-muted-foreground truncate">in {searchPath}</span>}
        {matchCount !== null && matchCount > 0 && (
          <span className="text-muted-foreground">({matchCount})</span>
        )}
      </>
    )
  }

  // Glob / Find / List
  if (lowerName.includes('glob') || lowerName.includes('find') || lowerName.includes('list')) {
    const pattern = (input.pattern || input.glob || '') as string
    const fileCount = output ? output.split('\n').filter((l) => l.trim()).length : null
    return (
      <>
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground">Find files</span>
        <span className="truncate">{pattern}</span>
        {fileCount !== null && fileCount > 0 && (
          <span className="text-muted-foreground">({fileCount})</span>
        )}
      </>
    )
  }

  // Skill — Skill tool uses `skill` param, not `name`
  if (lowerName === 'skill' || lowerName === 'mcp_skill' || lowerName.includes('skill')) {
    const skillName = (input.skill as string) || (input.name as string) || 'unknown'
    return (
      <>
        <Zap className="h-3.5 w-3.5 text-amber-400 shrink-0" />
        <span className="font-medium text-foreground shrink-0">Skill</span>
        <span className="text-muted-foreground truncate min-w-0">{skillName}</span>
      </>
    )
  }

  // Question
  if (lowerName.includes('question')) {
    const questions = (input.questions || []) as Array<{ header: string; question: string }>
    const questionCount = questions.length
    const firstHeader = questions[0]?.header || 'Question'
    return (
      <>
        <span className="text-muted-foreground shrink-0">
          <MessageCircleQuestion className="h-3.5 w-3.5" />
        </span>
        <span className="font-medium text-foreground shrink-0">Question</span>
        <span className="text-muted-foreground truncate min-w-0">
          {questionCount > 1 ? `${questionCount} questions` : firstHeader}
        </span>
      </>
    )
  }

  // Task
  if (lowerName === 'task') {
    const description = (input.description || '') as string
    const subagentType = (input.subagent_type || input.subagentType || '') as string
    return (
      <>
        <span className="text-muted-foreground shrink-0">
          <Bot className="h-3.5 w-3.5" />
        </span>
        <span className="font-medium text-foreground shrink-0">Agent</span>
        {subagentType && (
          <span className="text-[10px] bg-blue-500/15 text-blue-500 dark:text-blue-400 rounded px-1 py-0.5 font-medium shrink-0">
            {subagentType}
          </span>
        )}
        <span className="text-muted-foreground truncate min-w-0">{description}</span>
      </>
    )
  }

  // ExitPlanMode — plan review tool
  if (lowerName === 'exitplanmode') {
    const isAccepted = toolUse.status === 'success'
    const isRejected = toolUse.status === 'error'
    const badgeText = isAccepted ? 'accepted' : isRejected ? 'rejected' : 'review'
    return (
      <>
        <span className={cn(isRejected ? 'text-red-500' : 'text-emerald-500', 'shrink-0')}>
          <ClipboardCheck className="h-3.5 w-3.5" />
        </span>
        <span className="font-medium text-foreground shrink-0">Plan</span>
        <span className={cn(
          'text-[10px] rounded px-1 py-0.5 font-medium shrink-0',
          isRejected
            ? 'bg-red-500/15 text-red-600 dark:text-red-400'
            : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
        )}>
          {badgeText}
        </span>
      </>
    )
  }

  // WebFetch
  if (lowerName === 'webfetch' || lowerName === 'web_fetch') {
    const url = (input.url || '') as string
    let hostname = url
    try {
      hostname = new URL(url).hostname
    } catch {
      // keep full url
    }
    return (
      <>
        <Globe className="h-3.5 w-3.5 text-blue-400 shrink-0" />
        <span className="font-medium text-foreground shrink-0">Fetch</span>
        <span className="font-mono text-muted-foreground truncate min-w-0">{hostname}</span>
      </>
    )
  }

  // LSP tool
  if (isLspTool(name)) {
    const operation = (input.operation || '') as string
    const filePath = (input.filePath || '') as string
    const line = input.line as number | undefined
    const character = input.character as number | undefined
    const resultCount = getLspResultCount(output)
    return (
      <>
        <Code2 className="h-3.5 w-3.5 text-purple-400 shrink-0" />
        <span className="font-medium text-foreground shrink-0">LSP</span>
        <span
          className={cn(
            'text-[10px] rounded px-1 py-0.5 font-medium shrink-0',
            getLspOperationColor(operation)
          )}
        >
          {getLspOperationLabel(operation)}
        </span>
        {filePath && (
          <span className="font-mono text-muted-foreground truncate min-w-0">
            {shortenPath(filePath, cwd)}
          </span>
        )}
        {line !== undefined && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            L:{line}
            {character !== undefined && ` C:${character}`}
          </span>
        )}
        {resultCount !== null && resultCount > 0 && (
          <span className="text-muted-foreground shrink-0">({resultCount})</span>
        )}
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

/** Check if a tool name refers to a Skill tool */
function isSkillTool(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'skill' || lower === 'mcp_skill' || lower.includes('skill')
}

/** Detect file operation tools that should use the compact inline layout */
export function isFileOperation(name: string): boolean {
  if (isTodoWriteTool(name)) return false
  const lower = name.toLowerCase()
  return (
    lower.includes('read') ||
    lower === 'cat' ||
    lower === 'view' ||
    lower.includes('write') ||
    lower === 'create' ||
    lower.includes('edit') ||
    lower.includes('replace') ||
    lower.includes('patch')
  )
}

/** Detect search/find tools that should use the compact inline layout */
export function isSearchOperation(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === 'grep' ||
    lower === 'mcp_grep' ||
    lower === 'glob' ||
    lower === 'mcp_glob' ||
    lower.includes('grep') ||
    lower.includes('glob')
  )
}

/** Resolve a short display label for a file operation tool */
function getFileToolLabel(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('read') || lower === 'cat' || lower === 'view') return 'Read'
  if (lower.includes('write') || lower === 'create') return 'Write'
  if (lower.includes('edit') || lower.includes('replace') || lower.includes('patch')) return 'Edit'
  return name
}

/** Compact single-line renderer for Read/Write/Edit file operations, Search/Find tools, Skill tools, and LSP tools */
const CompactFileToolCard = memo(function CompactFileToolCard({
  toolUse,
  cwd
}: {
  toolUse: ToolUseInfo
  cwd?: string | null
}): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)

  const isSearch = isSearchOperation(toolUse.name)
  const isSkill = isSkillTool(toolUse.name)
  const isLsp = isLspTool(toolUse.name)
  const filePath = (toolUse.input.filePath ||
    toolUse.input.file_path ||
    toolUse.input.path ||
    '') as string
  const shortPath = shortenPath(filePath, cwd)
  const label = isSkill ? 'Skill' : getFileToolLabel(toolUse.name)
  const detail = isSkill
    ? (toolUse.input.skill as string) || (toolUse.input.name as string) || 'unknown'
    : shortPath
  const isRunning = toolUse.status === 'pending' || toolUse.status === 'running'
  const isError = toolUse.status === 'error'
  const hasOutput = !!(toolUse.output || toolUse.error)

  const Renderer = useMemo(() => getToolRenderer(toolUse.name), [toolUse.name])

  // Use CollapsedContent for search and LSP tools (they have rich collapsed headers)
  const useCollapsedContent = isSearch || isLsp

  const icon = useMemo(() => {
    if (isExpanded) {
      return <Minus className="h-3.5 w-3.5 text-muted-foreground" />
    }
    if (isRunning) {
      return (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" data-testid="tool-spinner" />
      )
    }
    if (isError) {
      return <X className="h-3.5 w-3.5 text-red-500" data-testid="tool-error" />
    }
    if (isSkill) {
      return <Zap className="h-3.5 w-3.5 text-amber-400" data-testid="tool-success" />
    }
    if (isLsp) {
      return <Code2 className="h-3.5 w-3.5 text-purple-400" data-testid="tool-success" />
    }
    return <Plus className="h-3.5 w-3.5 text-muted-foreground" data-testid="tool-success" />
  }, [isExpanded, isRunning, isError, isSkill, isLsp])

  return (
    <div
      data-testid="compact-file-tool"
      data-tool-name={toolUse.name}
      data-tool-status={toolUse.status}
    >
      {/* Compact single-line header */}
      <button
        onClick={() => hasOutput && setIsExpanded(!isExpanded)}
        className={cn(
          'flex items-center gap-1.5 w-full py-0.5 text-left text-xs',
          hasOutput && 'cursor-pointer hover:bg-accent/50 transition-colors rounded-sm',
          !hasOutput && !isRunning && 'cursor-default'
        )}
        disabled={!hasOutput && !isRunning}
      >
        {icon}
        {useCollapsedContent ? (
          <CollapsedContent toolUse={toolUse} cwd={cwd} />
        ) : (
          <>
            <span className="font-medium text-foreground shrink-0">{label}</span>
            <span
              className={cn(
                'truncate min-w-0',
                isSkill ? 'text-muted-foreground' : 'font-mono',
                isError ? 'text-red-400' : 'text-muted-foreground'
              )}
            >
              {detail}
            </span>
          </>
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && hasOutput && (
        <div className="ml-5 mt-0.5 mb-1" data-testid="tool-output">
          <Renderer
            name={toolUse.name}
            input={toolUse.input}
            output={toolUse.output}
            error={toolUse.error}
            status={toolUse.status}
          />
        </div>
      )}
    </div>
  )
})

interface ToolCardProps {
  toolUse: ToolUseInfo
  cwd?: string | null
  compact?: boolean
}

export const ToolCard = memo(function ToolCard({
  toolUse,
  cwd,
  compact = false
}: ToolCardProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)

  const duration = useMemo(() => {
    if (toolUse.endTime && toolUse.startTime) {
      return formatDuration(toolUse.endTime - toolUse.startTime)
    }
    return null
  }, [toolUse.startTime, toolUse.endTime])

  const hasOutput = !!(toolUse.output || toolUse.error)
  const isExitPlanMode = toolUse.name.toLowerCase() === 'exitplanmode'
  const hasPlanInput =
    isExitPlanMode && typeof toolUse.input?.plan === 'string' && toolUse.input.plan.length > 0
  const hasDetail = hasOutput || hasPlanInput

  const Renderer = useMemo(() => getToolRenderer(toolUse.name), [toolUse.name])

  // Route file operations, search tools, skill tools, and LSP tools to compact layout
  if (
    isFileOperation(toolUse.name) ||
    isSearchOperation(toolUse.name) ||
    isSkillTool(toolUse.name) ||
    isLspTool(toolUse.name)
  ) {
    return (
      <ToolCallContextMenu toolUse={toolUse}>
        <div>
          <CompactFileToolCard toolUse={toolUse} cwd={cwd} />
        </div>
      </ToolCallContextMenu>
    )
  }

  // TodoWrite: always-visible, no expand/collapse
  if (isTodoWriteTool(toolUse.name)) {
    return (
      <ToolCallContextMenu toolUse={toolUse}>
        <div
          className={cn(
            compact
              ? 'my-0 rounded-md border border-l-2 text-xs'
              : 'my-1 rounded-md border border-l-2 text-xs',
            toolUse.status === 'running' && 'animate-pulse',
            'border-border bg-muted/30'
          )}
          style={{ borderLeftColor: getLeftBorderColor(toolUse.status) }}
          data-testid="tool-card"
          data-tool-name={toolUse.name}
          data-tool-status={toolUse.status}
        >
          {/* Header */}
          <div
            className={cn(
              'flex items-center gap-1.5 w-full text-left',
              compact ? 'px-2 py-1.5' : 'px-2.5 py-1.5'
            )}
            data-testid="tool-card-header"
          >
            <CollapsedContent toolUse={toolUse} cwd={cwd} />
            <span className="flex-1" />
            {duration && (
              <span
                className="text-muted-foreground shrink-0 flex items-center gap-1"
                data-testid="tool-duration"
              >
                <Clock className="h-3 w-3" />
                {duration}
              </span>
            )}
            <StatusIndicator status={toolUse.status} />
          </div>
          {/* Always-visible content */}
          <div
            className={cn('border-t border-border', compact ? 'px-2 py-1.5' : 'px-2.5 py-2')}
            data-testid="tool-output"
          >
            <Renderer
              name={toolUse.name}
              input={toolUse.input}
              output={toolUse.output}
              error={toolUse.error}
              status={toolUse.status}
            />
          </div>
        </div>
      </ToolCallContextMenu>
    )
  }

  // ExitPlanMode: always-expanded plan card with fake user message on acceptance/rejection
  if (isExitPlanMode) {
    const planAccepted = toolUse.status === 'success'
    const planRejected = toolUse.status === 'error'
    return (
      <ToolCallContextMenu toolUse={toolUse}>
        <div>
          <div
            className={cn(
              compact
                ? 'my-0 rounded-md border border-l-2 text-xs'
                : 'my-1 rounded-md border border-l-2 text-xs',
              planRejected
                ? 'border-red-500/30 bg-red-500/5'
                : 'border-border bg-primary/[0.04]'
            )}
            style={{ borderLeftColor: getLeftBorderColor(toolUse.status) }}
            data-testid="tool-card"
            data-tool-name={toolUse.name}
            data-tool-status={toolUse.status}
          >
            {/* Header */}
            <div
              className={cn(
                'flex items-center gap-1.5 w-full text-left',
                compact ? 'px-2 py-1.5' : 'px-2.5 py-1.5'
              )}
              data-testid="tool-card-header"
            >
              <CollapsedContent toolUse={toolUse} cwd={cwd} />
              <span className="flex-1" />
              {duration && (
                <span
                  className="text-muted-foreground shrink-0 flex items-center gap-1"
                  data-testid="tool-duration"
                >
                  <Clock className="h-3 w-3" />
                  {duration}
                </span>
              )}
              <StatusIndicator status={toolUse.status} />
            </div>
            {/* Always-visible plan content */}
            {hasPlanInput && (
              <div
                className={cn('border-t border-border', compact ? 'px-3 py-2.5' : 'px-4 py-3')}
                data-testid="tool-output"
              >
                <Renderer
                  name={toolUse.name}
                  input={toolUse.input}
                  output={toolUse.output}
                  error={toolUse.error}
                  status={toolUse.status}
                />
              </div>
            )}
          </div>
          {/* Fake user message after plan acceptance */}
          {planAccepted && (
            <div className="flex justify-end px-6 py-4" data-testid="plan-accepted-message">
              <div className="max-w-[80%] rounded-2xl px-4 py-3 bg-primary/10 text-foreground">
                <p className="text-sm whitespace-pre-wrap leading-relaxed">Implement the plan</p>
              </div>
            </div>
          )}
          {/* Fake user message after plan rejection with feedback */}
          {planRejected && toolUse.error && (
            <div className="flex justify-end px-6 py-4" data-testid="plan-rejected-message">
              <div className="max-w-[80%] rounded-2xl px-4 py-3 bg-primary/10 text-foreground">
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{toolUse.error}</p>
              </div>
            </div>
          )}
        </div>
      </ToolCallContextMenu>
    )
  }

  return (
    <ToolCallContextMenu toolUse={toolUse}>
      <div
        className={cn(
          compact
            ? 'my-0 rounded-md border border-l-2 text-xs'
            : 'my-1 rounded-md border border-l-2 text-xs',
          toolUse.status === 'running' && 'animate-pulse',
          toolUse.status === 'error'
            ? 'border-red-500/30 bg-red-500/5'
            : 'border-border bg-muted/30'
        )}
        style={{
          borderLeftColor: getLeftBorderColor(toolUse.status)
        }}
        data-testid="tool-card"
        data-tool-name={toolUse.name}
        data-tool-status={toolUse.status}
      >
        {/* Header - always visible */}
        <button
          onClick={() => hasDetail && setIsExpanded(!isExpanded)}
          className={cn(
            compact
              ? 'flex items-center gap-1.5 w-full px-2 py-1.5 text-left'
              : 'flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left',
            hasDetail && 'cursor-pointer hover:bg-muted/50 transition-colors'
          )}
          disabled={!hasDetail}
          aria-expanded={hasDetail ? isExpanded : undefined}
          data-testid="tool-card-header"
        >
          {/* Tool-specific collapsed content */}
          <CollapsedContent toolUse={toolUse} cwd={cwd} />

          {/* Spacer */}
          <span className="flex-1" />

          {/* Duration */}
          {duration && (
            <span
              className="text-muted-foreground shrink-0 flex items-center gap-1"
              data-testid="tool-duration"
            >
              <Clock className="h-3 w-3" />
              {duration}
            </span>
          )}

          {/* Status indicator */}
          <StatusIndicator status={toolUse.status} />

          {/* Expand/Collapse affordance */}
          {hasDetail && (
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
            isExpanded && hasDetail ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'
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
    </ToolCallContextMenu>
  )
})
