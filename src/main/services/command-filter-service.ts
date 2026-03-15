import { createLogger } from './logger'

const log = createLogger({ component: 'CommandFilterService' })

/**
 * Check if a string contains an unescaped command substitution $(...)
 * Must properly handle escape sequences: \$( is NOT a substitution, \\$( IS a substitution
 */
function hasUnescapedCommandSubstitution(str: string): boolean {
  let i = 0
  while (i < str.length - 1) {
    if (str[i] === '\\') {
      // Skip the next character (it's escaped)
      i += 2
      continue
    }
    if (str[i] === '$' && str[i + 1] === '(') {
      return true
    }
    i++
  }
  return false
}

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
   * ⚠️ IMPORTANT: This logic is duplicated in the frontend for display purposes:
   * src/renderer/src/components/sessions/CommandApprovalPrompt.tsx → splitBashForDisplay()
   * Any changes to parsing rules MUST be synchronized between both implementations.
   *
   * SECURITY MODEL (Defense in Depth):
   * - Newlines at the top level are split during parsing (prevents injection attacks)
   * - After parsing, parts with newlines are evaluated:
   *   • If part contains $(...) or heredoc markers (<<): kept intact (legitimate multi-line)
   *   • If part is a simple string with newlines: split for security (suspicious)
   * - This balanced approach allows legitimate heredocs while preventing injection
   * - Parts with newlines won't match allowlist patterns (no normalization in matchesAnyPattern)
   * - Result: Heredocs in command substitutions work; simple multi-line strings are split
   *
   * SUPPORTED FEATURES:
   * ✅ Operators: && || | ; (splits on these at top level)
   * ✅ Newlines: splits on unquoted newlines (security)
   * ✅ Single quotes: preserves everything inside (no substitution)
   * ✅ Double quotes: preserves operators and newlines, allows substitutions
   * ✅ Escape sequences: \$ \" \n etc. (in double quotes and unquoted)
   * ✅ Command substitutions: $(cmd) including nested $(outer $(inner))
   * ✅ Bare subshells: (cmd1 && cmd2) - preserves operators inside
   * ✅ Mixed contexts: "text $(cmd | cmd) text" && other
   *
   * KNOWN LIMITATIONS:
   * ⚠️ Simple multi-line strings without command substitutions are split line-by-line
   *    Example: echo "line1\nline2" → splits into 2 parts (security feature)
   *    Workaround: Use command substitution for legitimate multi-line content
   *
   * ⚠️ SECURITY LIMITATION: Quote tracking is global, not per-nesting-level
   *    Example: "$(echo ')' && cmd)" may parse incorrectly
   *    Issue: Single quotes inside double-quoted command substitutions don't toggle quote mode
   *    Impact: Parser may incorrectly identify ) as closing $( when it's actually inside single quotes
   *    Workaround: Avoid single quotes inside double-quoted command substitutions
   *    Status: Requires per-level quote tracking (complex architectural change)
   *
   * ⚠️ SECURITY LIMITATION: Complex nested quote contexts not fully supported
   *    Example: echo "$(cat <<EOF | grep "pattern"\nEOF)" may parse incorrectly
   *    Issue: Parser tracks one global quote state, not per-substitution-level
   *    Impact: Deeply nested quote contexts may confuse the parser
   *    Workaround: Keep command substitutions simple; avoid nesting quotes inside substitutions
   *    Status: Requires architectural redesign to track quote state per nesting level
   *
   * ⚠️ Backtick command substitutions `cmd` are NOT supported (use $() instead)
   * ⚠️ Process substitutions <(cmd) and >(cmd) are NOT supported
   * ⚠️ Brace expansion {a,b,c} is treated as literal text
   *
   * ✅ Heredocs inside command substitutions ARE supported (e.g., git commit -m "$(cat <<EOF...)")
   *
   * SECURITY IMPACT OF LIMITATIONS:
   * The quote-tracking limitations could potentially allow crafted commands to bypass
   * splitting in unintended ways. However, the defense-in-depth model provides multiple
   * layers of protection:
   * 1. Allowlist patterns must still match for auto-approval
   * 2. User can manually review and approve/deny each command
   * 3. Most real-world commands don't use complex nested quote contexts
   * 4. Simple injection attempts (echo "safe\nmalicious") are still caught
   *
   * RECOMMENDATION: For high-security environments, consider:
   * - Using more specific allowlist patterns (avoid broad wildcards)
   * - Manually reviewing commands with complex nesting
   * - Avoiding single quotes inside double-quoted command substitutions in trusted commands
   */
  splitBashChain(command: string): string[] {
    const parts: string[] = []
    let current = ''
    let inSingleQuote = false
    let inDoubleQuote = false
    let escapeNext = false
    // Stack to track command substitutions: [wasInDoubleQuote, parenBalanceInside]
    // parenBalanceInside tracks bare ( ) pairs inside the $(...) to avoid premature popping
    const parenStack: Array<{ wasInDoubleQuote: boolean; parenBalance: number }> = []
    // Counter to track bare subshells: (cmd1 && cmd2) at TOP level only
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
        parenStack.push({ wasInDoubleQuote: inDoubleQuote, parenBalance: 0 })
        current += char + next
        lastCharWasUnescapedDollar = false // Reset because we consumed both $ and (
        i += 2
        continue
      }

      // Track closing ) of command substitution
      // IMPORTANT: Must handle bare parens inside $(...) correctly to avoid premature pop
      // Example: $(cmd (inner)) - the first ) closes (inner), not $(
      if (char === ')' && parenStack.length > 0 && !inSingleQuote) {
        const topEntry = parenStack[parenStack.length - 1]
        // Only close command substitution if we're in the same quote context AND
        // all nested bare parens inside it have been closed (parenBalance === 0)
        if (inDoubleQuote === topEntry.wasInDoubleQuote) {
          if (topEntry.parenBalance > 0) {
            // This ) closes a bare subshell inside the command substitution
            topEntry.parenBalance--
          } else {
            // This ) closes the command substitution itself
            parenStack.pop()
          }
        }
        current += char
        lastCharWasUnescapedDollar = false
        i++
        continue
      }

      // Track bare subshells: (cmd1 && cmd2)
      // CRITICAL: Must track ( inside command substitutions even when inside double quotes
      // Example: "$(cmd (sub))" - the (sub) parens MUST be tracked even though inDoubleQuote=true
      //
      // If we're at top level (not in command substitution), track with subshellDepth
      // If we're inside command substitution, track with parenBalance in the stack entry
      if (char === '(' && !inSingleQuote) {
        // Check if previous token was an unescaped $ (making this a command substitution)
        // We track this with a flag rather than checking raw prevChar to handle escaped \$
        if (!lastCharWasUnescapedDollar) {
          if (parenStack.length > 0) {
            // Inside command substitution: increment paren balance
            // This handles "$(cmd (sub))" where the (sub) parens are inside double quotes
            parenStack[parenStack.length - 1].parenBalance++
          } else if (!inDoubleQuote) {
            // Top level AND not in double quotes: increment subshell depth
            // We check !inDoubleQuote here because top-level bare subshells like (cmd1 && cmd2)
            // should not be tracked if they're inside double quotes (which would be syntax error in bash)
            subshellDepth++
          }
        }
        current += char
        lastCharWasUnescapedDollar = false
        i++
        continue
      }

      // Track closing ) of bare subshell at TOP level only
      // (Inside command substitutions, closing ) is handled by the earlier parenStack logic)
      if (char === ')' && subshellDepth > 0 && !inSingleQuote && !inDoubleQuote && parenStack.length === 0) {
        // This ) belongs to a top-level bare subshell
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
          lastCharWasUnescapedDollar = false
          i++
          continue
        }

        // Check for &&
        if (char === '&' && next === '&') {
          if (current.trim()) parts.push(current.trim())
          current = ''
          lastCharWasUnescapedDollar = false
          i += 2
          // Skip whitespace after operator
          while (i < command.length && /\s/.test(command[i])) i++
          continue
        }

        // Check for ||
        if (char === '|' && next === '|') {
          if (current.trim()) parts.push(current.trim())
          current = ''
          lastCharWasUnescapedDollar = false
          i += 2
          // Skip whitespace after operator
          while (i < command.length && /\s/.test(command[i])) i++
          continue
        }

        // Check for single | (pipe)
        if (char === '|' && next !== '|') {
          if (current.trim()) parts.push(current.trim())
          current = ''
          lastCharWasUnescapedDollar = false
          i++
          // Skip whitespace after operator
          while (i < command.length && /\s/.test(command[i])) i++
          continue
        }

        // Check for ;
        if (char === ';') {
          if (current.trim()) parts.push(current.trim())
          current = ''
          lastCharWasUnescapedDollar = false
          i++
          // Skip whitespace after operator
          while (i < command.length && /\s/.test(command[i])) i++
          continue
        }
      }

      // Update flag for next iteration: track if this char is an unescaped $
      // (used to detect bare subshells vs command substitutions)
      // Must be outside both single AND double quotes - a $ inside "..." followed by ( outside is not $(...)
      lastCharWasUnescapedDollar = (char === '$' && !inSingleQuote && !inDoubleQuote)

      current += char
      i++
    }

    // Add the last part
    if (current.trim()) parts.push(current.trim())

    // Security validation: If any part contains a newline after parsing, determine if it's:
    // 1. Legitimate: heredoc inside command substitution (e.g., git commit -m "$(cat <<'EOF'\n...\nEOF\n)")
    // 2. Suspicious: simple string with newlines (possible injection attempt) OR top-level heredoc
    //
    // Strategy: ONLY trust newlines inside command substitutions $()
    // - Check for UNESCAPED $( to indicate legitimate multi-line context
    // - Everything else (including top-level heredocs) is split for security
    //
    // CRITICAL: Must properly handle escape sequences to avoid false positives
    // - \$( is escaped, NOT a command substitution → SPLIT
    // - \\$( has escaped backslash, so $( is NOT escaped → KEEP INTACT
    //
    // SECURITY: We do NOT check for heredoc markers (<<) separately because:
    // 1. Top-level heredocs are not supported in the security model (see KNOWN LIMITATIONS)
    // 2. Checking for << creates false positives: echo "text <<MARKER\nmalicious\nMARKER"
    //    would match the pattern even though << is inside quotes and not a real heredoc
    // 3. Legitimate heredocs should be inside command substitutions: $(cat <<EOF...)
    const result: string[] = []
    for (const part of parts) {
      if (/\n/.test(part)) {
        // Part contains newline(s) - check if it's inside a command substitution
        const hasCommandSub = hasUnescapedCommandSubstitution(part)

        if (hasCommandSub) {
          // Legitimate: multi-line command inside $() - keep intact
          // This covers heredocs in command substitutions: git commit -m "$(cat <<EOF\n...\nEOF)"
          log.debug('CommandFilter: part contains newline but has command substitution - keeping intact', {
            part: part.substring(0, 100)
          })
          result.push(part)
        } else {
          // Suspicious: newline without command substitution context - split for safety
          // This includes:
          // - Injection attempts: echo "safe\nmalicious"
          // - Top-level heredocs: cat <<EOF\n...\nEOF (not supported, see docs)
          // - Quoted strings with << markers: echo "<<MARKER\nmalicious" (false heredocs)
          //
          // Note: This will split even if newline is inside quotes, creating fragments with
          // dangling quotes like ['echo "line1', 'line2"']. This is acceptable because:
          // 1. Such fragments won't match allowlist patterns (security goal achieved)
          // 2. User will see the fragments and can approve individually or fix the command
          // 3. Legitimate multi-line quoted strings should use command substitution + heredoc
          log.warn('CommandFilter: part contains newline without command substitution - splitting for security', {
            part: part.substring(0, 100)
          })
          result.push(...part.split('\n').map((s) => s.trim()).filter(Boolean))
        }
      } else {
        // No newlines - keep as-is
        result.push(part)
      }
    }

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
   *
   * SECURITY: Normalizes legitimate heredocs (inside command substitutions) before matching
   * so they can match wildcard patterns. Suspicious newlines (outside command substitutions)
   * remain as-is and won't match patterns.
   */
  matchesAnyPattern(command: string, patterns: string[]): boolean {
    // Normalize heredocs for pattern matching: collapse newlines inside command substitutions
    // This allows "git commit -m "$(cat <<EOF...)" to match "bash: git commit *"
    const normalized = this.normalizeCommandForMatching(command)
    return patterns.some((pattern) => this.matchPattern(normalized, pattern))
  }

  /**
   * Normalize a command for pattern matching by collapsing newlines in legitimate contexts.
   * This allows heredocs and multi-line commands inside $() to match wildcard patterns.
   *
   * Strategy:
   * - If command contains UNESCAPED $(...): collapse ALL newlines to spaces
   * - Otherwise: leave as-is (suspicious newlines won't match patterns)
   *
   * IMPORTANT: This is an intentional over-normalization for simplicity and security.
   * If a command contains unescaped $() ANYWHERE, all newlines in the ENTIRE command are collapsed,
   * even those outside the command substitution. This is acceptable because:
   * 1. Commands reaching this point already passed splitBashChain's newline security checks
   * 2. The goal is pattern matching, not execution - we're checking intent, not structure
   * 3. Edge cases like: echo "text\ninjection" && $(safe) will match patterns but that's OK
   *    because splitBashChain already split it into parts, each evaluated separately
   *
   * Alternative would be complex parsing to normalize only inside $(), but the security
   * benefit is minimal since splitBashChain already provides the primary defense.
   *
   * SECURITY: We do NOT check for heredoc markers (<<) separately to avoid false positives
   * on quoted strings containing << (e.g., echo "text <<MARKER\nmalicious"). Only command
   * substitutions $() indicate legitimate multi-line content.
   */
  private normalizeCommandForMatching(command: string): string {
    const hasCommandSub = hasUnescapedCommandSubstitution(command)

    if (hasCommandSub) {
      // Legitimate multi-line command - collapse newlines for pattern matching
      return command.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
    }

    // Simple command - leave as-is
    return command
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
