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
   * Splits on ` && `, ` || `, `| ` (pipe), `;`, and unquoted newlines while respecting
   * quotes and command substitutions.
   *
   * SECURITY MODEL:
   * - Newlines inside quotes or $(...) are preserved (not split)
   * - Newlines at the top level ARE split (prevents injection attacks)
   * - If any part contains a newline after parsing, it indicates a parser limitation
   *   and that part is defensively re-split on newlines
   * - Parts with newlines won't match allowlist patterns (no normalization in matchesAnyPattern)
   *
   * KNOWN LIMITATION: Top-level heredocs (not inside $() or quotes) are split line-by-line.
   * This is acceptable because:
   * 1. Top-level heredocs are rare in command approval contexts
   * 2. Heredocs inside $() or quotes (the common case) work correctly
   * 3. The security fallback handles edge cases defensively
   */
  splitBashChain(command: string): string[] {
    const parts: string[] = []
    let current = ''
    let inSingleQuote = false
    let inDoubleQuote = false
    let escapeNext = false
    // Stack to track command substitutions: each entry records whether it was opened inside double quotes
    const parenStack: boolean[] = []
    // Counter to track bare subshells: (cmd1 && cmd2)
    // Prevents operators inside subshells from being treated as top-level separators
    let subshellDepth = 0
    // Track if the last processed character was an unescaped $ (for bare subshell detection)
    let lastCharWasUnescapedDollar = false
    let i = 0

    while (i < command.length) {
      const char = command[i]
      const next = command[i + 1]

      // Handle escape sequences (only in double quotes or unquoted context)
      // In single quotes, backslash is literal
      if (escapeNext) {
        current += char
        escapeNext = false
        lastCharWasUnescapedDollar = false
        i++
        continue
      }

      if (char === '\\' && !inSingleQuote) {
        current += char
        escapeNext = true
        lastCharWasUnescapedDollar = false
        i++
        continue
      }

      // Handle quotes
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        current += char
        lastCharWasUnescapedDollar = false
        i++
        continue
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        current += char
        lastCharWasUnescapedDollar = false
        i++
        continue
      }

      // Track command substitutions $(...) - push current quote state onto stack
      // Only when not inside single quotes (single quotes prevent substitution)
      if (char === '$' && next === '(' && !inSingleQuote) {
        parenStack.push(inDoubleQuote)
        current += char + next
        lastCharWasUnescapedDollar = false // Reset because we consumed both $ and (
        i += 2
        continue
      }

      // Track closing ) of command substitution
      // Match ) with the most recent $( by checking if we're in the same quote context
      if (char === ')' && parenStack.length > 0 && !inSingleQuote) {
        const openedInDoubleQuote = parenStack[parenStack.length - 1]
        // Only close if we're in the same quote context as when it opened
        if (inDoubleQuote === openedInDoubleQuote) {
          parenStack.pop()
        }
        current += char
        lastCharWasUnescapedDollar = false
        i++
        continue
      }

      // Track bare subshells: (cmd1 && cmd2) - only when not inside quotes AND not inside command substitution
      // This prevents operators inside subshells from being treated as top-level separators
      // We only track top-level bare subshells (parenStack.length === 0) to avoid cross-contamination
      if (char === '(' && !inSingleQuote && !inDoubleQuote && parenStack.length === 0) {
        // Check if previous token was an unescaped $ (making this a command substitution)
        // We track this with a flag rather than checking raw prevChar to handle escaped \$
        if (!lastCharWasUnescapedDollar) {
          subshellDepth++
        }
        current += char
        lastCharWasUnescapedDollar = false
        i++
        continue
      }

      // Track closing ) of bare subshell - only if not closing a command substitution
      if (char === ')' && subshellDepth > 0 && !inSingleQuote && !inDoubleQuote) {
        // This ) belongs to a bare subshell (parenStack would have matched if it was $())
        subshellDepth--
        current += char
        lastCharWasUnescapedDollar = false
        i++
        continue
      }

      // Only split on operators and newlines when not inside quotes AND not inside command substitution AND not inside subshell
      if (!inSingleQuote && !inDoubleQuote && parenStack.length === 0 && subshellDepth === 0) {
        // Check for newline (command separator) - prevents newline injection attacks
        // Note: Newlines inside quotes or command substitutions ($(...)) are preserved
        // and NOT split because we're tracking those contexts with inSingleQuote/inDoubleQuote/parenStack.
        // Heredocs are NOT tracked as a special context - they're just text. Heredocs inside
        // $() or quotes stay intact, but top-level heredocs WILL be split line-by-line.
        if (char === '\n') {
          if (current.trim()) parts.push(current.trim())
          current = ''
          i++
          continue
        }

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

      // Update flag for next iteration: track if this char is an unescaped $
      // (used to detect bare subshells vs command substitutions)
      lastCharWasUnescapedDollar = (char === '$' && !inSingleQuote)

      current += char
      i++
    }

    // Add the last part
    if (current.trim()) parts.push(current.trim())

    // Security validation: If any part contains a newline after parsing, it means either:
    // 1. A parser limitation with complex nested structures, OR
    // 2. An injection attempt that bypassed quote/substitution tracking
    // Either way, we need to handle it defensively by splitting those parts further.
    const validatedParts = parts.filter((part) => {
      if (/\n/.test(part)) {
        log.warn('CommandFilter: part contains newline after parsing - parser limitation or injection attempt', {
          part: part.substring(0, 100)
        })
        return false
      }
      return true
    })

    // If we found parts with newlines, re-split ONLY those parts (not the entire command)
    // to avoid breaking correctly-parsed parts with quoted arguments
    if (validatedParts.length < parts.length) {
      const result: string[] = []
      for (const part of parts) {
        if (/\n/.test(part)) {
          // This part has a newline - split it for safety
          // Note: This may split legitimate multi-line quoted strings, but that's acceptable
          // because parts shouldn't have newlines unless the parser failed
          result.push(...part.split('\n').map((s) => s.trim()).filter(Boolean))
        } else {
          // This part was parsed correctly - keep it intact
          result.push(part)
        }
      }
      return result
    }

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
   *
   * SECURITY: Does NOT normalize newlines. If a command contains newlines after
   * splitBashChain, it won't match any patterns and will require approval.
   * This is intentional - newlines in parts after splitting indicate parser
   * limitations or injection attempts, and should not be auto-approved.
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

      // Use case-insensitive matching
      // Note: Do NOT use 's' flag - we split on newlines to prevent injection attacks
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
   * For long commands (>=5 words), limits to 4 patterns (exact + 3 wildcard levels)
   * starting from the broadest patterns (fewest words before wildcard).
   * e.g. "gh pr create --title ... --body ..." → ["exact", "gh *", "gh pr *", "gh pr create *"]
   * For shorter commands (<5 words), generates all possible wildcard levels.
   */
  private generateSingleCommandSuggestions(commandStr: string): string[] {
    const prefix = 'bash: '
    if (!commandStr.startsWith(prefix)) return [commandStr]

    const command = commandStr.slice(prefix.length).trim()
    if (!command) return [commandStr]

    const parts = command.split(/\s+/)
    if (parts.length <= 1) return [commandStr]

    const suggestions: string[] = [commandStr]

    // For long commands (>=5 words), limit to 3 wildcard levels starting from the broadest
    // e.g. "gh pr create --title ... --body ..." → ["exact", "gh *", "gh pr *", "gh pr create *"]
    // For shorter commands, generate all possible wildcard levels
    const MAX_WILDCARD_LEVELS = parts.length >= 5 ? 3 : parts.length - 1

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
