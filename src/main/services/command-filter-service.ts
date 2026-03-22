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
   * Legacy method - kept for comparison/rollback
   * Split a bash command chain into individual sub-commands using simple regex.
   * Splits on ` && `, ` || `, `| ` (pipe), and `; ` (space-delimited to avoid
   * splitting inside quoted strings or URLs).
   * Note: `||` is matched before `|` so the OR operator is not mis-split as two pipes.
   */
  splitBashChainLegacy(command: string): string[] {
    return command
      .split(/\s+&&\s+|\s+\|\|\s+|\s+\|\s+|\s*;\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  /**
   * Split a bash command chain into individual sub-commands.
   * Properly handles quotes, heredocs, command substitutions, and escapes.
   * Only splits on && at the top level (not inside strings or command substitutions).
   *
   * Handles:
   * - Single quotes ('...')
   * - Double quotes ("...")
   * - Command substitutions ($(...) and `...`)
   * - Heredocs (<<EOF...EOF and <<'EOF'...EOF)
   * - Escaped characters (\&&)
   * - Nested command substitutions
   */
  splitBashChain(command: string): string[] {
    const result: string[] = []
    let current = ''
    let i = 0

    // Parse state
    let inSingleQuote = false
    let inDoubleQuote = false
    let inBacktick = false
    let commandSubDepth = 0  // Tracks $(...) nesting depth
    let inHeredoc = false
    let heredocDelimiter = ''
    let heredocIndented = false  // For <<- style heredocs

    // Stack to track quote state at each command substitution level
    // When we enter $(, we push current quote state and start fresh
    // When we exit ), we restore the previous quote state
    const quoteStack: Array<{inSingleQuote: boolean; inDoubleQuote: boolean}> = []

    while (i < command.length) {
      const char = command[i]
      const nextChar = command[i + 1]
      const prevChar = i > 0 ? command[i - 1] : ''

      // Check for heredoc start (only outside quotes, but can be inside command substitutions)
      if (!inSingleQuote && !inDoubleQuote && !inBacktick && !inHeredoc) {
        // Look for << or <<-
        if (char === '<' && nextChar === '<') {
          const isIndented = command[i + 2] === '-'
          const heredocStart = i + (isIndented ? 3 : 2)

          // Extract the delimiter
          let delimEnd = heredocStart
          let quoted = false

          // Skip whitespace
          while (delimEnd < command.length && /\s/.test(command[delimEnd])) {
            delimEnd++
          }

          // Check if delimiter is quoted
          if (command[delimEnd] === "'" || command[delimEnd] === '"') {
            quoted = true
            const quoteChar = command[delimEnd]
            delimEnd++
            const delimStart = delimEnd
            while (delimEnd < command.length && command[delimEnd] !== quoteChar) {
              delimEnd++
            }
            if (delimEnd < command.length) {
              heredocDelimiter = command.slice(delimStart, delimEnd)
              delimEnd++ // Skip closing quote
            }
          } else {
            // Unquoted delimiter - ends at whitespace or special chars
            const delimStart = delimEnd
            while (delimEnd < command.length &&
                   !/[\s<>|;&()]/.test(command[delimEnd])) {
              delimEnd++
            }
            heredocDelimiter = command.slice(delimStart, delimEnd)
          }

          if (heredocDelimiter) {
            inHeredoc = true
            heredocIndented = isIndented
            // Add the heredoc start to current command
            current += command.slice(i, delimEnd)
            i = delimEnd
            continue
          }
        }
      }

      // Handle heredoc content
      if (inHeredoc) {
        // Check if we're at the start of a line (after a newline)
        if (i > 0 && command[i - 1] === '\n') {
          // Check if this line starts with the heredoc delimiter
          let delimiterEnd = i

          // Try to match the delimiter at the start of this line
          let matchesDelimiter = true
          for (let j = 0; j < heredocDelimiter.length; j++) {
            if (i + j >= command.length || command[i + j] !== heredocDelimiter[j]) {
              matchesDelimiter = false
              break
            }
          }
          delimiterEnd = i + heredocDelimiter.length

          // If it matches, check that it's followed by whitespace, newline, or special char (not more text)
          if (matchesDelimiter && delimiterEnd <= command.length) {
            const charAfterDelim = command[delimiterEnd]
            if (!charAfterDelim || charAfterDelim === '\n' || /[\s;&|]/.test(charAfterDelim)) {
              // Found the end delimiter
              inHeredoc = false
              // Add only the delimiter to current (newline was already added in previous iteration)
              current += command.slice(i, delimiterEnd)
              heredocDelimiter = ''
              heredocIndented = false
              i = delimiterEnd
              continue
            }
          }
        }

        // Still in heredoc, just add the character
        current += char
        i++
        continue
      }

      // Handle escape sequences (not in single quotes)
      if (!inSingleQuote && prevChar === '\\') {
        // Previous char was escape, this char is escaped
        current += char
        i++
        continue
      }

      // Skip the backslash itself when it's escaping something
      if (!inSingleQuote && char === '\\' && nextChar) {
        current += char
        i++
        continue
      }

      // Handle single quotes (not escaped, not in double quotes)
      if (char === "'" && prevChar !== '\\' && !inDoubleQuote && !inBacktick) {
        inSingleQuote = !inSingleQuote
        current += char
        i++
        continue
      }

      // Handle double quotes (not escaped, not in single quotes)
      if (char === '"' && prevChar !== '\\' && !inSingleQuote && !inBacktick) {
        inDoubleQuote = !inDoubleQuote
        current += char
        i++
        continue
      }

      // Handle backticks (not escaped, not in quotes)
      if (char === '`' && prevChar !== '\\' && !inSingleQuote) {
        inBacktick = !inBacktick
        current += char
        i++
        continue
      }

      // Handle command substitution start: $(
      if (char === '$' && nextChar === '(' && !inSingleQuote) {
        commandSubDepth++
        // Push current quote state onto stack and reset quotes for the new context
        quoteStack.push({inSingleQuote, inDoubleQuote})
        inSingleQuote = false
        inDoubleQuote = false
        current += char
        i++
        continue
      }

      // Handle command substitution end: )
      if (char === ')' && commandSubDepth > 0 && !inSingleQuote && !inDoubleQuote) {
        commandSubDepth--
        // Restore quote state from before entering this command substitution
        const restored = quoteStack.pop()
        if (restored) {
          inSingleQuote = restored.inSingleQuote
          inDoubleQuote = restored.inDoubleQuote
        }
        current += char
        i++
        continue
      }

      // Check for && operator (only when not in quotes/substitutions/heredocs)
      if (char === '&' && nextChar === '&' &&
          !inSingleQuote && !inDoubleQuote && !inBacktick &&
          commandSubDepth === 0 && !inHeredoc) {
        // Found a top-level &&
        // Add current command if not empty
        const trimmed = current.trim()
        if (trimmed && trimmed !== '&&') { // Don't add standalone && as a command
          result.push(trimmed)
        }
        // Reset for next command
        current = ''
        // Skip the && and any surrounding whitespace
        i += 2
        while (i < command.length && /\s/.test(command[i])) {
          i++
        }
        continue
      }

      // Add character to current command
      current += char
      i++
    }

    // Add the last command if not empty
    const trimmed = current.trim()
    if (trimmed && trimmed !== '&&') { // Don't add standalone && as a command
      result.push(trimmed)
    }

    // Return the result - an empty array is valid if the command only contained operators
    return result
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

      // Use 'is' flags: i=case-insensitive, s=dotall (. matches newlines for heredocs)
      const regex = new RegExp(`^${regexPattern}$`, 'is')
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
   * Returns exactly 4 options (or fewer for short commands):
   * 1. First word + * (most general) - e.g., "bash: git *"
   * 2. First two words + * - e.g., "bash: git commit *"
   * 3. First three words + * - e.g., "bash: git commit -m *"
   * 4. Exact match (most specific)
   *
   * Patterns are ordered from most general to most specific.
   */
  private generateSingleCommandSuggestions(commandStr: string): string[] {
    const prefix = 'bash: '
    if (!commandStr.startsWith(prefix)) return [commandStr]

    const command = commandStr.slice(prefix.length).trim()
    if (!command) return [commandStr]

    const parts = command.split(/\s+/)
    if (parts.length <= 1) return [commandStr]

    const suggestions: string[] = []

    // Generate up to 3 progressive patterns from most general to more specific
    // Start with first word + *, then first 2 words + *, then first 3 words + *
    const maxWildcardPatterns = Math.min(3, parts.length - 1)
    for (let i = 1; i <= maxWildcardPatterns; i++) {
      const pattern = `${prefix}${parts.slice(0, i).join(' ')} *`
      suggestions.push(pattern)
    }

    // Add the exact match as the final (most specific) option
    suggestions.push(commandStr)

    // Return maximum of 4 options
    return suggestions.slice(0, 4)
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
