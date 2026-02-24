import { createLogger } from './logger'

const log = createLogger({ component: 'CommandFilterService' })

export interface CommandFilterSettings {
  allowlist: string[]
  blocklist: string[]
  defaultBehavior: 'ask' | 'allow' | 'block'
  enabled: boolean
}

/**
 * Service for evaluating tool uses against allowlist/blocklist patterns
 * with wildcard support (* and **)
 */
export class CommandFilterService {
  /**
   * Evaluate a tool use and determine if it should be allowed, blocked, or require approval
   */
  evaluateToolUse(
    toolName: string,
    input: Record<string, unknown>,
    settings: CommandFilterSettings
  ): 'allow' | 'block' | 'ask' {
    if (!settings.enabled) {
      return 'allow'
    }

    const commandStr = this.formatCommandString(toolName, input)

    log.info('CommandFilter: evaluating tool use', {
      toolName,
      commandStr,
      allowlist: settings.allowlist,
      blocklist: settings.blocklist,
      defaultBehavior: settings.defaultBehavior,
      enabled: settings.enabled
    })

    // Check blocklist first (highest priority — security rules always win)
    if (this.matchesAnyPattern(commandStr, settings.blocklist)) {
      log.info('CommandFilter: BLOCKED by blocklist', { commandStr })
      return 'block'
    }

    // Check allowlist second
    if (this.matchesAnyPattern(commandStr, settings.allowlist)) {
      log.info('CommandFilter: allowed by allowlist', { commandStr })
      return 'allow'
    }

    // Not on either list - use default behavior
    log.info('CommandFilter: no match, using default behavior', {
      commandStr,
      defaultBehavior: settings.defaultBehavior
    })
    return settings.defaultBehavior
  }

  /**
   * Check if a command matches any pattern in a list
   */
  matchesAnyPattern(command: string, patterns: string[]): boolean {
    return patterns.some((pattern) => this.matchPattern(command, pattern))
  }

  /**
   * Match a single pattern against a command string with wildcard support
   *
   * Wildcards:
   * - * matches any sequence except /
   * - ** matches any sequence including /
   *
   * Examples:
   * - "bash: npm *" matches "bash: npm install", "bash: npm test"
   * - "read: src/**" matches "read: src/main/db/schema.ts"
   * - "edit: *.env" matches "edit: .env", "edit: production.env"
   */
  private matchPattern(command: string, pattern: string): boolean {
    try {
      // Escape special regex characters except our wildcards
      const regexPattern = pattern
        // First, protect ** by replacing with placeholder
        .replace(/\*\*/g, '__DOUBLESTAR__')
        // Escape other special regex chars
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        // Convert * to regex (matches any sequence except /)
        .replace(/\*/g, '[^/]*')
        // Convert ** back to regex (matches any sequence)
        .replace(/__DOUBLESTAR__/g, '.*')

      const regex = new RegExp(`^${regexPattern}$`, 'i')
      const matches = regex.test(command)

      if (matches) {
        log.info('CommandFilter: pattern matched', { command, pattern })
      }

      return matches
    } catch (error) {
      log.error('CommandFilter: invalid pattern', { pattern, error })
      return false
    }
  }

  /**
   * Format a tool use into a searchable command string
   *
   * Format: "{tool}: {primary_identifier}"
   *
   * Examples:
   * - Bash: "bash: npm install"
   * - Edit: "edit: src/main.ts"
   * - Read: "read: /path/to/file"
   */
  formatCommandString(toolName: string, input: Record<string, unknown>): string {
    const tool = toolName.toLowerCase()

    switch (tool) {
      case 'bash':
        return `bash: ${input.command || ''}`

      case 'edit':
        return `edit: ${input.file_path || input.path || ''}`

      case 'write':
        return `write: ${input.file_path || input.path || ''}`

      case 'read':
        return `read: ${input.file_path || input.path || ''}`

      case 'grep':
        return `grep: ${input.pattern || ''} in ${input.path || 'cwd'}`

      case 'glob':
        return `glob: ${input.pattern || ''}`

      case 'webfetch':
        return `webfetch: ${input.url || ''}`

      case 'websearch':
        return `websearch: ${input.query || ''}`

      case 'task':
        return `task: ${input.description || 'subtask'}`

      case 'skill':
        return `skill: ${input.skill || ''}`

      case 'notebookedit':
        return `notebookedit: ${input.notebook_path || ''}`

      default:
        // For unknown tools, use tool name and JSON representation
        return `${tool}: ${JSON.stringify(input)}`
    }
  }

  /**
   * Generate pattern suggestions at varying granularity levels for a tool use.
   * Returns patterns from most specific (exact match) to most broad.
   *
   * For bash commands: splits by words and progressively replaces tail with wildcard
   * For file tools: generates filename and extension patterns
   * For other tools: returns the exact command string
   */
  generatePatternSuggestions(toolName: string, input: Record<string, unknown>): string[] {
    const commandStr = this.formatCommandString(toolName, input)
    const tool = toolName.toLowerCase()

    if (tool === 'bash') {
      return this.generateBashSuggestions(commandStr)
    }

    if (tool === 'edit' || tool === 'write' || tool === 'read') {
      return this.generateFileSuggestions(commandStr, tool)
    }

    // For other tools (webfetch, websearch, task, skill, etc.), just the exact command
    return [commandStr]
  }

  /**
   * Generate progressive bash command pattern suggestions
   */
  private generateBashSuggestions(commandStr: string): string[] {
    // commandStr format: "bash: some command args"
    const prefix = 'bash: '
    if (!commandStr.startsWith(prefix)) return [commandStr]

    const command = commandStr.slice(prefix.length).trim()
    if (!command) return [commandStr]

    const parts = command.split(/\s+/)
    if (parts.length <= 1) return [commandStr]

    const suggestions: string[] = [commandStr]

    // Generate progressively broader patterns by trimming from the right
    // e.g. "gcloud compute list --project x" → "gcloud compute list *" → "gcloud compute *" → "gcloud *"
    for (let i = parts.length - 1; i >= 1; i--) {
      const pattern = `${prefix}${parts.slice(0, i).join(' ')} *`
      // Avoid duplicates
      if (!suggestions.includes(pattern)) {
        suggestions.push(pattern)
      }
    }

    return suggestions
  }

  /**
   * Generate file-based pattern suggestions (filename, extension)
   */
  private generateFileSuggestions(commandStr: string, tool: string): string[] {
    // commandStr format: "edit: /some/path/to/file.ts"
    const prefix = `${tool}: `
    if (!commandStr.startsWith(prefix)) return [commandStr]

    const filePath = commandStr.slice(prefix.length).trim()
    if (!filePath) return [commandStr]

    const suggestions: string[] = []

    // Extract filename and extension
    const lastSlash = filePath.lastIndexOf('/')
    const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
    const dotIndex = fileName.lastIndexOf('.')
    const ext = dotIndex >= 0 ? fileName.slice(dotIndex) : null

    // Pattern: match this exact filename anywhere (e.g. "edit: **/db.ts")
    if (fileName) {
      suggestions.push(`${prefix}**/${fileName}`)
    }

    // Pattern: match any file with this extension (e.g. "edit: **/*.ts")
    if (ext) {
      const extPattern = `${prefix}**/*${ext}`
      if (!suggestions.includes(extPattern)) {
        suggestions.push(extPattern)
      }
    }

    return suggestions
  }

  /**
   * Validate a pattern string
   * Returns null if valid, error message if invalid
   */
  validatePattern(pattern: string): string | null {
    if (!pattern || pattern.trim().length === 0) {
      return 'Pattern cannot be empty'
    }

    // Check if pattern would create invalid regex
    try {
      const testCommand = 'test: test'
      this.matchPattern(testCommand, pattern)
      return null
    } catch (error) {
      return `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * Check if a pattern is overly broad (matches everything)
   */
  isOverlyBroadPattern(pattern: string): boolean {
    const broadPatterns = ['*', '**', '*: *', '*: **', '**: *', '**: **']
    return broadPatterns.some((broad) => pattern.trim() === broad)
  }
}

// Singleton instance
export const commandFilterService = new CommandFilterService()
