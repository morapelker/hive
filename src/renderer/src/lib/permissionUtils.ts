/**
 * Utility functions for the Hive-side permission auto-approve system.
 *
 * Used by the OpenCode backend permission prompt (PermissionPrompt.tsx) to:
 *  1. Split bash && chains into individual sub-commands for display
 *  2. Auto-approve permission requests that match patterns in the commandFilter allowlist
 *
 * The commandFilter.allowlist (from useSettingsStore) is shared between the Claude SDK
 * command approval system and the OpenCode permission prompt system.
 * Pattern format: "toolName: command" e.g. "bash: npm *", "edit: src/**"
 */

/**
 * Split a bash command string by && into individual sub-commands.
 * Properly handles quotes, heredocs, command substitutions, and escapes.
 * Only splits on && at the top level (not inside strings or command substitutions).
 *
 * NOTE: This implementation mirrors the logic in CommandFilterService.splitBashChain()
 * to ensure consistent behavior between OpenCode and Claude Code security systems.
 *
 * @example
 * splitBashCommand('git add . && git commit -m "fix"')
 * // → ['git add .', 'git commit -m "fix"']
 *
 * @example
 * splitBashCommand('echo "foo && bar" && echo done')
 * // → ['echo "foo && bar"', 'echo done']
 *
 * @example
 * splitBashCommand('git commit -m "$(cat <<\'EOF\'\nFix && problem\nEOF\n)" && npm install')
 * // → ['git commit -m "$(cat <<\'EOF\'...)"', 'npm install']
 */
export function splitBashCommand(cmd: string): string[] {
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

  // Stack to track quote state at each command substitution level
  // When we enter $(, we push current quote state and start fresh
  // When we exit ), we restore the previous quote state
  const quoteStack: Array<{inSingleQuote: boolean; inDoubleQuote: boolean}> = []

  while (i < cmd.length) {
    const char = cmd[i]
    const nextChar = cmd[i + 1]
    const prevChar = i > 0 ? cmd[i - 1] : ''

    // Check for heredoc start (only outside quotes, but can be inside command substitutions)
    if (!inSingleQuote && !inDoubleQuote && !inBacktick && !inHeredoc) {
      // Look for << or <<-
      if (char === '<' && nextChar === '<') {
        const isIndented = cmd[i + 2] === '-'
        const heredocStart = i + (isIndented ? 3 : 2)

        // Extract the delimiter
        let delimEnd = heredocStart

        // Skip whitespace
        while (delimEnd < cmd.length && /\s/.test(cmd[delimEnd])) {
          delimEnd++
        }

        // Check if delimiter is quoted
        if (cmd[delimEnd] === "'" || cmd[delimEnd] === '"') {
          const quoteChar = cmd[delimEnd]
          delimEnd++
          const delimStart = delimEnd
          while (delimEnd < cmd.length && cmd[delimEnd] !== quoteChar) {
            delimEnd++
          }
          if (delimEnd < cmd.length) {
            heredocDelimiter = cmd.slice(delimStart, delimEnd)
            delimEnd++ // Skip closing quote
          }
        } else {
          // Unquoted delimiter - ends at whitespace or special chars
          const delimStart = delimEnd
          while (delimEnd < cmd.length &&
                 !/[\s<>|;&()]/.test(cmd[delimEnd])) {
            delimEnd++
          }
          heredocDelimiter = cmd.slice(delimStart, delimEnd)
        }

        if (heredocDelimiter) {
          inHeredoc = true
          // Add the heredoc start to current command
          current += cmd.slice(i, delimEnd)
          i = delimEnd
          continue
        }
      }
    }

    // Handle heredoc content
    if (inHeredoc) {
      // Check if we're at the start of a line (after a newline)
      if (i > 0 && cmd[i - 1] === '\n') {
        // Check if this line starts with the heredoc delimiter
        let delimiterEnd = i

        // Try to match the delimiter at the start of this line
        let matchesDelimiter = true
        for (let j = 0; j < heredocDelimiter.length; j++) {
          if (i + j >= cmd.length || cmd[i + j] !== heredocDelimiter[j]) {
            matchesDelimiter = false
            break
          }
        }
        delimiterEnd = i + heredocDelimiter.length

        // If it matches, check that it's followed by whitespace, newline, or special char
        if (matchesDelimiter && delimiterEnd <= cmd.length) {
          const charAfterDelim = cmd[delimiterEnd]
          if (!charAfterDelim || charAfterDelim === '\n' || /[\s;&|]/.test(charAfterDelim)) {
            // Found the end delimiter
            inHeredoc = false
            // Add only the delimiter to current (newline was already added)
            current += cmd.slice(i, delimiterEnd)
            heredocDelimiter = ''
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

    // Handle single quotes
    if (char === "'" && prevChar !== '\\' && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote
      current += char
      i++
      continue
    }

    // Handle double quotes
    if (char === '"' && prevChar !== '\\' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote
      current += char
      i++
      continue
    }

    // Handle backticks
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
      const trimmed = current.trim()
      if (trimmed && trimmed !== '&&') {
        result.push(trimmed)
      }
      current = ''
      // Skip the && and any surrounding whitespace
      i += 2
      while (i < cmd.length && /\s/.test(cmd[i])) {
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
  if (trimmed && trimmed !== '&&') {
    result.push(trimmed)
  }

  return result
}

/**
 * Test whether a prefixed command (e.g. "bash: npm install") matches a stored
 * commandFilter allowlist pattern (e.g. "bash: npm *").
 * Supports exact match and * / ** wildcards.
 *
 * @example
 * patternMatches('bash: ls /tmp/foo', 'bash: ls *')    // true
 * patternMatches('edit: src/foo.ts', 'edit: src/**')   // true
 */
export function patternMatches(cmd: string, pattern: string): boolean {
  if (cmd === pattern) return true
  if (!pattern.includes('*')) return false
  // Escape regex special chars, then replace ** and * with .*
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '.*')
  try {
    // Use 's' flag to make . match newlines (for commands with heredocs)
    return new RegExp(`^${regexStr}$`, 's').test(cmd)
  } catch {
    return false
  }
}

/**
 * Get the set of sub-patterns for a permission request, each prefixed with
 * the permission type to match the commandFilter.allowlist format.
 *
 *  - For 'bash': split each pattern by && to get individual sub-commands,
 *    then prefix as "bash: <sub-command>"
 *  - For all other types: prefix each pattern as "permissionType: <pattern>"
 *
 * Returns a flat, deduplicated list for matching against commandFilter.allowlist.
 */
export function getSubPatterns(request: PermissionRequest): string[] {
  const type = request.permission
  if (type === 'bash') {
    const parts: string[] = []
    for (const p of request.patterns) {
      for (const sub of splitBashCommand(p)) {
        const prefixed = `bash: ${sub}`
        if (!parts.includes(prefixed)) parts.push(prefixed)
      }
    }
    return parts
  }
  // Non-bash permissions: prefix each raw pattern with the type
  return [...new Set(request.patterns.map((p) => `${type}: ${p}`))]
}

/**
 * Return true if ALL sub-patterns of the request are covered by the commandFilter allowlist.
 * An empty sub-pattern list (permission with no patterns) is NOT auto-approved.
 *
 * @param request   The incoming permission request from the OpenCode backend
 * @param allowlist The commandFilter.allowlist string[] from useSettingsStore
 */
export function checkAutoApprove(request: PermissionRequest, allowlist: string[]): boolean {
  const subPatterns = getSubPatterns(request)
  if (subPatterns.length === 0) return false
  return subPatterns.every((sub) => allowlist.some((allowed) => patternMatches(sub, allowed)))
}
