/**
 * How many matching projects a sidebar search expands on its own. Every project's
 * worktrees are in the store, so expanding is free of I/O, but each expanded
 * project still costs render time (~1.5 ms in Chrome): expanding all 200 matches
 * of a broad query made a keystroke 3-4x slower. Results are ranked best-first,
 * so the top matches expand and the rest stay collapsed (with their worktree
 * count) until the query narrows or the project is opened by hand.
 */
export const SEARCH_AUTO_EXPAND_LIMIT = 20

/**
 * Picks the projects a search expands: the first `limit` of `rankedProjectIds`
 * that have something to show.
 */
export function pickSearchAutoExpandIds(
  rankedProjectIds: readonly string[],
  hasContent: (projectId: string) => boolean,
  limit: number = SEARCH_AUTO_EXPAND_LIMIT
): Set<string> {
  const ids = new Set<string>()
  for (const id of rankedProjectIds) {
    if (ids.size >= limit) break
    if (hasContent(id)) ids.add(id)
  }
  return ids
}
