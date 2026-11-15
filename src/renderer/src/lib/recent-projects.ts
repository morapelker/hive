// The rule behind the sidebar's Recent section: the projects opened most recently, newest
// first, leaving out every pinned one. All kinds count (git projects, connection projects,
// databases) and Spaces play no part. "Opened" is what the stores already record when a project
// becomes the selected one: `last_accessed_at` (git and connection projects) and
// `lastAccessedAt` (databases).

import { formatRelativeTime } from '@/lib/format-utils'

export const RECENT_PROJECT_LIMIT = 5

interface RecentGitProjectLike {
  id: string
  last_accessed_at: string
}

interface RecentDataProjectLike {
  id: string
  lastAccessedAt: string
  pinned: boolean
}

export type RecentProjectEntry<P, D> =
  | { kind: 'project'; id: string; item: P; openedAt: number }
  | { kind: 'data'; id: string; item: D; openedAt: number }

function openedAtMs(value: string | null | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * The Recent rows. `pinnedProjectIds` holds the git and connection projects that count as
 * pinned (any worktree or instance pinned); a database carries its own `pinned` flag. Projects
 * opened at the same instant keep the order they were given in.
 */
export function pickRecentProjects<P extends RecentGitProjectLike, D extends RecentDataProjectLike>(
  projects: readonly P[],
  dataProjects: readonly D[],
  pinnedProjectIds: ReadonlySet<string>,
  limit: number = RECENT_PROJECT_LIMIT
): RecentProjectEntry<P, D>[] {
  const entries: RecentProjectEntry<P, D>[] = []
  for (const item of projects) {
    if (pinnedProjectIds.has(item.id)) continue
    entries.push({
      kind: 'project',
      id: item.id,
      item,
      openedAt: openedAtMs(item.last_accessed_at)
    })
  }
  for (const item of dataProjects) {
    if (item.pinned) continue
    entries.push({ kind: 'data', id: item.id, item, openedAt: openedAtMs(item.lastAccessedAt) })
  }
  // Array.prototype.sort is stable: equal times keep the input order.
  entries.sort((a, b) => b.openedAt - a.openedAt)
  return entries.slice(0, Math.max(0, limit))
}

/** How long ago a project was opened: "now", "5m", "2h", "3d". Never negative. */
export function formatOpenedAge(openedAt: number, now: number): string {
  return formatRelativeTime(openedAt, Math.max(now, openedAt))
}

/** What a Recent row's indicator shows: an agent working, one waiting on the user, or nothing. */
export type ProjectAgentState = 'working' | 'question' | null

/**
 * One state for a whole project from the statuses of its worktrees (or connection instances).
 * Waiting on the user wins over working: it is the one that needs the user.
 */
export function summarizeAgentState(statuses: Iterable<string | null>): ProjectAgentState {
  let working = false
  for (const status of statuses) {
    switch (status) {
      case 'answering':
      case 'permission':
      case 'command_approval':
      case 'plan_ready':
        return 'question'
      case 'working':
      case 'planning':
        working = true
        break
      default:
        break
    }
  }
  return working ? 'working' : null
}
