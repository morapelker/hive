import { stripShellPrefix } from './codex-tool-normalizer'

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value)
  if (direct) return direct

  if (!Array.isArray(value)) return null

  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null)

  return parts.length > 0 ? parts.join(' ') : null
}

export function extractCommandText(input: unknown): string {
  const direct = normalizeCommandValue(input)
  if (direct) return stripShellPrefix(direct)

  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''

  const record = input as Record<string, unknown>
  const result =
    normalizeCommandValue(record.command) ??
    normalizeCommandValue(record.cmd) ??
    normalizeCommandValue(record.argv) ??
    ''

  return result ? stripShellPrefix(result) : result
}

export function isTodoWriteTool(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('todowrite') || lower.includes('todo_write') || lower === 'update_plan'
}

export function isFigmaTool(name: string): boolean {
  return name.toLowerCase().startsWith('mcp__figma__')
}

export function isFileChangeTool(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'filechange' || lower === 'file_change' || lower === 'apply_patch'
}

export function getFigmaOperation(name: string): string {
  return name.toLowerCase().replace('mcp__figma__', '')
}

export const FIGMA_OPERATION_LABELS: Record<string, string> = {
  get_screenshot: 'Screenshot',
  create_design_system_rules: 'Design system rules',
  get_design_context: 'Design context',
  get_metadata: 'Metadata',
  get_variable_defs: 'Variables',
  get_figjam: 'FigJam',
  generate_figma_design: 'Generate design',
  generate_diagram: 'Generate diagram',
  get_code_connect_map: 'Code connect map',
  whoami: 'Who am I',
  add_code_connect_map: 'Add code connect',
  get_code_connect_suggestions: 'Code connect suggestions',
  send_code_connect_mappings: 'Send mappings'
}

export const FIGMA_OPERATION_COLORS: Record<string, string> = {
  get_screenshot: 'bg-blue-500/15 text-blue-500 dark:text-blue-400',
  get_design_context: 'bg-blue-500/15 text-blue-500 dark:text-blue-400',
  get_metadata: 'bg-blue-500/15 text-blue-500 dark:text-blue-400',
  get_variable_defs: 'bg-blue-500/15 text-blue-500 dark:text-blue-400',
  get_figjam: 'bg-blue-500/15 text-blue-500 dark:text-blue-400',
  generate_figma_design: 'bg-purple-500/15 text-purple-500 dark:text-purple-400',
  generate_diagram: 'bg-purple-500/15 text-purple-500 dark:text-purple-400',
  create_design_system_rules: 'bg-purple-500/15 text-purple-500 dark:text-purple-400',
  get_code_connect_map: 'bg-teal-500/15 text-teal-500 dark:text-teal-400',
  add_code_connect_map: 'bg-teal-500/15 text-teal-500 dark:text-teal-400',
  get_code_connect_suggestions: 'bg-teal-500/15 text-teal-500 dark:text-teal-400',
  send_code_connect_mappings: 'bg-teal-500/15 text-teal-500 dark:text-teal-400',
  whoami: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400'
}

export function getFigmaOperationLabel(operation: string): string {
  return FIGMA_OPERATION_LABELS[operation] || operation.replace(/_/g, ' ')
}

export function getFigmaOperationColor(operation: string): string {
  return FIGMA_OPERATION_COLORS[operation] || 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400'
}

export function shortenPath(filePath: string, cwd?: string | null): string {
  if (cwd && filePath.startsWith(cwd)) {
    const relative = filePath.slice(cwd.length).replace(/^\//, '')
    if (relative) return relative
  }
  const parts = filePath.split('/')
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : filePath
}

export function getToolLabel(
  name: string,
  input: Record<string, unknown>,
  cwd?: string | null
): string {
  const lowerName = name.toLowerCase()

  if (isTodoWriteTool(lowerName)) {
    const todos = Array.isArray(input.todos) ? (input.todos as Array<{ status: string }>) : []
    const completed = todos.filter((todo) => todo.status === 'completed').length
    return `${completed}/${todos.length} completed`
  }

  if (isFileChangeTool(lowerName)) {
    const changes = Array.isArray(input.changes) ? (input.changes as Array<{ path: string }>) : []
    if (changes.length > 0) {
      const firstPath = changes[0]?.path || ''
      const label = shortenPath(firstPath, cwd)
      return changes.length > 1 ? `${label} +${changes.length - 1} more` : label
    }
  }

  if (lowerName.includes('read') || lowerName.includes('write') || lowerName.includes('edit')) {
    const filePath = (input.filePath || input.file_path || input.path || '') as string
    if (filePath) return shortenPath(filePath, cwd)
  }

  if (lowerName.includes('bash') || lowerName.includes('shell') || lowerName.includes('exec')) {
    const command = extractCommandText(input)
    if (command) return command.length > 60 ? `${command.slice(0, 60)}...` : command
  }

  if (lowerName.includes('grep') || lowerName.includes('search')) {
    const pattern = (input.pattern || input.query || input.regex || '') as string
    if (pattern) return pattern.length > 40 ? `${pattern.slice(0, 40)}...` : pattern
  }

  if (lowerName.includes('glob') || lowerName.includes('find')) {
    const pattern = (input.pattern || input.glob || '') as string
    if (pattern) return pattern
  }

  if (lowerName === 'task') {
    const description = ((input.description || input.prompt || '') as string).trim()
    if (description) return description
  }

  if (lowerName.includes('skill')) {
    const skillName = (input.skill || input.name || '') as string
    return skillName || 'unknown'
  }

  if (lowerName === 'webfetch' || lowerName === 'web_fetch') {
    const url = (input.url || '') as string
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  }

  if (isFigmaTool(name)) {
    return getFigmaOperationLabel(getFigmaOperation(name))
  }

  return ''
}

export function getDiscordToolEmoji(name: string): string {
  const lowerName = name.toLowerCase()
  if (isFileChangeTool(lowerName) || lowerName.includes('edit') || lowerName.includes('write')) {
    return '📝'
  }
  if (lowerName.includes('read') || lowerName === 'cat' || lowerName === 'view') return '📖'
  if (lowerName.includes('bash') || lowerName.includes('shell') || lowerName.includes('exec')) {
    return '💻'
  }
  if (lowerName.includes('grep') || lowerName.includes('search') || lowerName.includes('rg')) {
    return '🔎'
  }
  if (lowerName.includes('glob') || lowerName.includes('find') || lowerName.includes('list')) {
    return '📁'
  }
  if (lowerName === 'task') return '🤖'
  if (isTodoWriteTool(lowerName)) return '☑️'
  if (isFigmaTool(name)) return '🎨'
  return '🔧'
}
