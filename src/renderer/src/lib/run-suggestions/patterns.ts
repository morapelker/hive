export type SuggestedAction = { kind: 'killPid'; pid: number }

export interface Suggestion {
  /** Stable signature used for dedup within a run session, e.g. "killPid:31076". */
  signature: string
  /** Label shown on the action button. */
  label: string
  /** Optional human description shown next to the button. */
  description?: string
  action: SuggestedAction
}

interface Pattern {
  regex: RegExp
  build: (match: RegExpExecArray) => Suggestion | null
}

const PATTERNS: Pattern[] = [
  {
    // Matches "Run kill 31076 to stop it" (Next.js dev-server collision).
    regex: /Run kill (\d+) to stop it/,
    build: (m) => {
      const pid = Number(m[1])
      if (!Number.isFinite(pid)) return null
      return {
        signature: `killPid:${pid}`,
        label: `kill ${pid}`,
        description: 'Another dev server is using the expected port.',
        action: { kind: 'killPid', pid }
      }
    }
  }
]

export function detectSuggestion(line: string): Suggestion | null {
  for (const p of PATTERNS) {
    const m = p.regex.exec(line)
    if (m) return p.build(m)
  }
  return null
}
