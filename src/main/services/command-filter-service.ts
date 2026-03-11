import { createLogger } from './logger'

const log = createLogger({ component: 'CommandFilterService' })

export interface CommandFilterSettings {
  allowlist: string[]
  blocklist: string[]
  defaultBehavior: 'ask' | 'allow' | 'block'
  enabled: boolean
}

export interface SubCommandSuggestions {
  subCommand: string
  patterns: string[]
}

/**
 * Service for evaluating tool uses against allowlist/blocklist patterns
 * with wildcard support (* and **)
 *
 * For bash commands, the service splits on && / || / ; and evaluates
 * each sub-command independently so patterns like "bash: npm *" match
 * any combination of commands including npm.
 */
export class CommandFilterService {
  /**
   * Split a bash command chain into individual sub-commands.
   * Splits on ` && `, ` || `, `| ` (pipe), and `; ` while respecting quotes and heredocs.
   * Note: `||` is matched before `|` so the OR operator is not mis-split as two pipes.
   */
  splitBashChain(command: string): string[] {
    const parts: string[] = []
    let current = ''
    let inSingleQuote = false
    let inDoubleQuote = false
    let escapeNext = false
    let parenDepth = 0 // Track nesting depth of command substitutions $(...)
    let i = 0

    while (i < command.length) {
      const char = command[i]
      const next = command[i + 1]
      const next2 = command[i + 2]

      // Handle escape sequences (only in double quotes or unquoted context)
      // In single quotes, backslash is literal
      if (escapeNext) {
        current += char
        escapeNext = false
        i++
        continue
      }

      if (char === '\\' && !inSingleQuote) {
        current += char
        escapeNext = true
        i++
        continue
      }

      // Handle quotes - track them regardless of nesting level
      // Quotes inside $(...) affect whether ) closes the substitution
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        current += char
        i++
        continue
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        current += char
        i++
        continue
      }

      // Track command substitutions $(...) - increase depth when we see $(
      // Only when not inside single quotes (single quotes prevent substitution)
      if (char === '$' && next === '(' && !inSingleQuote) {
        parenDepth++
        current += char + next
        i += 2
        continue
      }

      // Track closing ) of command substitution
      // Only decrement parenDepth if ) appears OUTSIDE quotes
      // This correctly handles $(echo ")") - the ) inside quotes doesn't close the substitution
      if (char === ')' && parenDepth > 0 && !inSingleQuote && !inDoubleQuote) {
        parenDepth--
        current += char
        i++
        continue
      }

      // Only split on operators when not inside quotes AND not inside command substitution
      if (!inSingleQuote && !inDoubleQuote && parenDepth === 0) {
        // Check for &&
        if (char === '&' && next === '&') {
          if (current.trim()) parts.push(current.trim())
          current = ''
          i += 2
          // Skip whitespace after operator
          while (i < command.length && /\s/.test(command[i])) i++
          continue
        }

        // Check for ||
        if (char === '|' && next === '|') {
          if (current.trim()) parts.push(current.trim())
          current = ''
          i += 2
          // Skip whitespace after operator
          while (i < command.length && /\s/.test(command[i])) i++
          continue
        }

        // Check for single | (pipe)
        if (char === '|' && next !== '|') {
          if (current.trim()) parts.push(current.trim())
          current = ''
          i++
          // Skip whitespace after operator
          while (i < command.length && /\s/.test(command[i])) i++
          continue
        }

        // Check for ;
        if (char === ';') {
          if (current.trim()) parts.push(current.trim())
          current = ''
          i++
          // Skip whitespace after operator
          while (i < command.length && /\s/.test(command[i])) i++
          continue
        }
      }

      current += char
      i++
    }

    // Add the last part
    if (current.trim()) parts.push(current.trim())

    return parts
  }

  /**
   * Evaluate a tool use and determine if it should be allowed, blocked, or require approval.
   *
   * For bash: splits by && and evaluates each sub-command independently.
   *   - Block wins: if ANY sub-command matches the blocklist → block
   *   - Allow: ALL sub-commands must match the allowlist
   *   - Otherwise: default behavior
   */
  evaluateToolUse(
    toolName: string,
    input: Record<string, unknown>,
    settings: CommandFilterSettings
  ): 'allow' | 'block' | 'ask' {
    if (!settings.enabled) {
      return 'allow'
    }

    const tool = toolName.toLowerCase()

    if (tool === 'bash') {
      const command = String(input.command || '').trim()
      const subCommands = this.splitBashChain(command)

      log.info('CommandFilter: evaluating bash chain', {
        subCommands,
        allowlistCount: settings.allowlist.length,
        blocklistCount: settings.blocklist.length
      })

      // Blocklist wins: if ANY sub-command is blocked, block the entire chain
      for (const sub of subCommands) {
        const subStr = `bash: ${sub}`
        if (this.matchesAnyPattern(subStr, settings.blocklist)) {
          log.info('CommandFilter: BLOCKED by blocklist', { subStr })
          return 'block'
        }
      }

      // Allowlist: ALL sub-commands must be covered
      if (subCommands.length > 0) {
        const allMatch = subCommands.every((sub) => {
          const formatted = `bash: ${sub}`
          const matches = this.matchesAnyPattern(formatted, settings.allowlist)
          log.info('CommandFilter: checking sub-command against allowlist', {
            subCommand: sub,
            formatted,
            matches
          })
          return matches
        })
        if (allMatch) {
          log.info('CommandFilter: all sub-commands allowed by allowlist', { subCommands })
          return 'allow'
        }
      }

      log.info('CommandFilter: bash chain not fully covered, using default', {
        defaultBehavior: settings.defaultBehavior
      })
      return settings.defaultBehavior
    }

    // Non-bash tools: check the full command string
    const commandStr = this.formatCommandString(toolName, input)

    log.info('CommandFilter: evaluating tool use', {
      toolName,
      commandStr,
      allowlistCount: settings.allowlist.length,
      blocklistCount: settings.blocklist.length,
      defaultBehavior: settings.defaultBehavior,
      enabled: settings.enabled
    })

    if (this.matchesAnyPattern(commandStr, settings.blocklist)) {
      log.info('CommandFilter: BLOCKED by blocklist', { commandStr })
      return 'block'
    }

    if (this.matchesAnyPattern(commandStr, settings.allowlist)) {
      log.info('CommandFilter: allowed by allowlist', { commandStr })
      return 'allow'
    }

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
   * - * matches any sequence except / (for file-path patterns: edit, read, write)
   * - * matches any sequence INCLUDING / (for bash patterns — args often contain paths)
   * - ** matches any sequence including / (all pattern types)
   *
   * Examples:
   * - "bash: npm *" matches "bash: npm install", "bash: npm test"
   * - "bash: cd *" matches "bash: cd /Users/foo/bar" (slash-aware for bash)
   * - "read: src/**" matches "read: src/main/db/schema.ts"
   * - "edit: *.env" matches "edit: .env", "edit: production.env"
   */
  private matchPattern(command: string, pattern: string): boolean {
    try {
      // For bash commands, * should match any character including /
      // because command arguments regularly contain paths with slashes.
      // The [^/]* behaviour is only useful for file-path patterns (edit:, read:, write:).
      const isBashPattern = pattern.toLowerCase().startsWith('bash:')

      // Escape special regex characters except our wildcards
      const regexPattern = pattern
        // First, protect ** by replacing with placeholder
        .replace(/\*\*/g, '__DOUBLESTAR__')
        // Escape other special regex chars
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        // Convert * to regex — for bash patterns match everything, for file patterns exclude /
        .replace(/\*/g, isBashPattern ? '.*' : '[^/]*')
        // Convert ** back to regex (matches any sequence)
        .replace(/__DOUBLESTAR__/g, '.*')

      const regex = new RegExp(`^${regexPattern}$`, 'i')
      const matches = regex.test(command)

      // Only log successful matches to reduce noise
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
   * For bash commands with &&: returns a flat list of per-sub-command patterns (no && in patterns).
   * For bash single command: splits by words and progressively replaces tail with wildcard.
   * For file tools: generates filename and extension patterns.
   * For other tools: returns the exact command string.
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
   * Generate structured per-sub-command pattern suggestions for bash && chains.
   * Returns null for non-bash tools or single commands (use generatePatternSuggestions instead).
   *
   * Each entry has the original sub-command text and a list of patterns at varying granularity.
   */
  generateSubCommandSuggestions(
    toolName: string,
    input: Record<string, unknown>
  ): SubCommandSuggestions[] | null {
    if (toolName.toLowerCase() !== 'bash') return null

    const command = String(input.command || '').trim()
    if (!command) return null

    const subCommands = this.splitBashChain(command)
    if (subCommands.length <= 1) return null

    return subCommands.map((sub) => ({
      subCommand: sub,
      patterns: this.generateSingleCommandSuggestions(`bash: ${sub}`)
    }))
  }

  /**
   * Generate progressive bash command pattern suggestions for a SINGLE command (no &&).
   * Used internally by both generateBashSuggestions and generateSubCommandSuggestions.
   *
   * For long commands (>5 words), limits to first 4 patterns (exact + 3 wildcard levels)
   * starting from the broadest patterns (fewest words before wildcard).
   * e.g. "gh pr create --title ... --body ..." → ["exact", "gh *", "gh pr *", "gh pr create *"]
   */
  private generateSingleCommandSuggestions(commandStr: string): string[] {
    const prefix = 'bash: '
    if (!commandStr.startsWith(prefix)) return [commandStr]

    const command = commandStr.slice(prefix.length).trim()
    if (!command) return [commandStr]

    const parts = command.split(/\s+/)
    if (parts.length <= 1) return [commandStr]

    const suggestions: string[] = [commandStr]

    // For long commands, limit to 3 wildcard levels starting from the broadest
    // e.g. "gh pr create --title ... --body ..." → ["exact", "gh *", "gh pr *", "gh pr create *"]
    const MAX_WILDCARD_LEVELS = parts.length > 5 ? 3 : parts.length - 1

    // Generate progressively more specific patterns starting from the broadest
    // For long commands, we want the FIRST few patterns: "gh *", "gh pr *", "gh pr create *"
    // NOT the last few patterns near the end of the command
    let levelsAdded = 0
    for (let i = 1; i <= parts.length - 1 && levelsAdded < MAX_WILDCARD_LEVELS; i++) {
      const pattern = `${prefix}${parts.slice(0, i).join(' ')} *`
      if (!suggestions.includes(pattern)) {
        suggestions.push(pattern)
        levelsAdded++
      }
    }

    return suggestions
  }

  /**
   * Generate progressive bash command pattern suggestions.
   * For && chains: returns flat list of per-sub-command suggestions (no && in patterns).
   * For single commands: same word-trimming approach as before.
   */
  private generateBashSuggestions(commandStr: string): string[] {
    const prefix = 'bash: '
    if (!commandStr.startsWith(prefix)) return [commandStr]

    const fullCommand = commandStr.slice(prefix.length).trim()
    const subCommands = this.splitBashChain(fullCommand)

    if (subCommands.length <= 1) {
      // Single command: existing word-trimming approach
      return this.generateSingleCommandSuggestions(commandStr)
    }

    // Multiple sub-commands: generate suggestions for each sub-command independently
    // (no && in any pattern — each sub-command is matched individually in evaluateToolUse)
    const suggestions: string[] = []
    for (const sub of subCommands) {
      const subSuggestions = this.generateSingleCommandSuggestions(`${prefix}${sub}`)
      for (const pattern of subSuggestions) {
        if (!suggestions.includes(pattern)) {
          suggestions.push(pattern)
        }
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
