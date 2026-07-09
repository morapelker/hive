/**
 * Pure, fs-free classifier for project setup-script lines used by "launch on
 * cloud". A setup script may contain local-file `cp` lines (e.g. copying an
 * `.env` into the worktree); those can't run as-is on a remote host because
 * the source path only exists locally. This module classifies each line so
 * the caller can turn `cp <local-abs-path> <dest>` lines into real file
 * transfers and run everything else remotely, unmodified.
 *
 * Importable from the renderer (no Node built-ins), so the UI can preview
 * the plan before a remote launch runs.
 */

export type SetupPlanEntry =
  | { kind: 'command'; line: string }
  | { kind: 'transfer-candidate'; sourcePath: string; dest: string; line: string }
  | { kind: 'error'; line: string; reason: string }

/**
 * Minimal quote-aware tokenizer: splits on whitespace, but `"…"` and `'…'`
 * group their content into a single token (quotes stripped from the value).
 * Returns null when a quote is left unterminated.
 */
function tokenizeLine(line: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let hasToken = false
  let quote: '"' | "'" | null = null

  for (const ch of line) {
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }

    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }

    current += ch
    hasToken = true
  }

  if (quote) return null

  if (hasToken) tokens.push(current)
  return tokens
}

function classifyCpLine(line: string, operands: string[]): SetupPlanEntry {
  const flag = operands.find((token) => token.startsWith('-'))
  if (flag) {
    return {
      kind: 'error',
      line,
      reason: `flag "${flag}" is not supported: directories/recursive copies aren't supported for remote launch`
    }
  }

  if (operands.length !== 2) {
    return {
      kind: 'error',
      line,
      reason: `cp with ${operands.length} operands not supported (expected exactly source and destination)`
    }
  }

  const [sourcePath, dest] = operands

  if (sourcePath.startsWith('/')) {
    if (dest.startsWith('/') || dest.startsWith('~')) {
      return { kind: 'error', line, reason: 'destination must be relative to the worktree' }
    }
    return { kind: 'transfer-candidate', sourcePath, dest, line }
  }

  if (sourcePath.startsWith('~')) {
    return {
      kind: 'error',
      line,
      reason: 'tilde expansion is shell-dependent; use an absolute path for the source instead'
    }
  }

  // Both paths live in the worktree; the line runs remotely as-is.
  return { kind: 'command', line }
}

function classifyLine(line: string): SetupPlanEntry {
  const tokens = tokenizeLine(line)
  if (tokens === null) {
    return { kind: 'error', line, reason: 'unterminated quote' }
  }

  if (tokens.length === 0 || tokens[0] !== 'cp') {
    return { kind: 'command', line }
  }

  return classifyCpLine(line, tokens.slice(1))
}

export function parseSetupScriptPlan(script: string | null | undefined): {
  entries: SetupPlanEntry[]
} {
  if (!script) return { entries: [] }

  const lines = script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))

  return { entries: lines.map(classifyLine) }
}
