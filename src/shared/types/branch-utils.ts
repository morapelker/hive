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

const MODEL_SLUG_CAP = 16

/**
 * Convert a model ID into a short, filesystem-safe slug for the multi-model
 * worktree nameHint (`<ticket-slug>-<model-slug>`). Reuses
 * canonicalizeTicketTitle's sanitation mechanics (lowercase, non-alphanumeric
 * runs -> single dash, trim leading/trailing dashes) but caps at ~16 chars
 * without cutting a dash-separated segment in half: a trailing segment that
 * would push past the cap is dropped instead of truncated, e.g.
 * `claude-opus-4-5-20251101` -> `claude-opus-4-5`. Never returns an empty
 * string for non-empty input — if even the first segment overflows the cap,
 * falls back to a raw prefix of the sanitized string; if sanitation strips
 * the input down to nothing (symbol-only or non-ASCII modelIDs like `你好`),
 * falls back to the literal `model`.
 */
export function canonicalizeModelSlug(modelID: string): string {
  const sanitized = modelID
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumeric chars → single dash
    .replace(/^-+|-+$/g, '') // strip leading/trailing dashes

  if (sanitized.length === 0) return modelID.length > 0 ? 'model' : ''

  if (sanitized.length <= MODEL_SLUG_CAP) return sanitized

  let capped = ''
  for (const segment of sanitized.split('-')) {
    const candidate = capped ? `${capped}-${segment}` : segment
    if (candidate.length > MODEL_SLUG_CAP) break
    capped = candidate
  }

  return capped || sanitized.slice(0, MODEL_SLUG_CAP).replace(/-+$/, '')
}

/**
 * Convert a plan title into a filesystem-safe filename fragment.
 * Unlike canonicalizeTicketTitle (lowercase, 32-char cap for Windows
 * worktree paths), this preserves case and keeps more of the title since
 * the result is a user-visible, user-editable filename.
 */
export function normalizeFilename(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, '_') // underscore style matches the PLAN_ prefix
    .replace(/[^A-Za-z0-9._-]/g, '') // strip filesystem-unsafe chars
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64)
    .replace(/[._-]+$/, '')
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
