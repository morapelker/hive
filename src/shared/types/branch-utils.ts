/**
 * Convert a ticket title into a safe git branch name.
 * Unlike canonicalizeBranchName (which takes 3 words for verbose session titles),
 * this uses more of the ticket title to stay recognizable.
 *
 * Important: this slug is also used as part of the worktree folder name.
 * Keep it filesystem-safe and short enough for downstream Windows paths
 * inside the worktree (for example repos with long backlog filenames).
 *
 * Lives in shared/ so both main and renderer processes can import it
 * (git-service.ts has Node.js deps that crash the renderer).
 */
export function canonicalizeTicketTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces and underscores → dashes
    .replace(/[^a-z0-9\-.]/g, '') // remove chars unsafe for worktree folder names
    .replace(/-{2,}/g, '-') // collapse consecutive dashes
    .replace(/^-+|-+$/g, '') // strip leading/trailing dashes
    .slice(0, 32) // keep ticket-named worktrees under Windows path limits
    .replace(/-+$/, '') // strip trailing dashes after truncation
}

function normalizePlanTitle(title: string): string {
  const trimmed = title.trim()
  const withoutPrefix = trimmed.replace(/^plan\s*[:\-–—]\s*/i, '').trim()
  return withoutPrefix.length > 0 ? withoutPrefix : trimmed
}

/**
 * Extract a human-readable title from markdown plan content.
 * Looks for the first markdown heading (any level), then falls back to
 * the first non-empty line. Returns null if neither yields text.
 *
 * Used for both deriving a branch name (Supercharge) and deriving a
 * ticket title (Save as Ticket). Lives in shared/ so both main and
 * renderer can import it.
 */
export function extractPlanTitle(content: string): string | null {
  if (!content) return null

  const headingMatch = content.match(/^#+\s+(.+)$/m)
  if (headingMatch) {
    const stripped = normalizePlanTitle(headingMatch[1])
    if (stripped.length > 0) return stripped
  }

  const firstLine = content
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim()

  if (!firstLine || firstLine.length === 0) return null

  const normalizedFirstLine = normalizePlanTitle(firstLine)
  return normalizedFirstLine.length > 0 ? normalizedFirstLine : null
}
