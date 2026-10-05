import {
  DOCUMENT_RUN_ITEM_ACTIVE_STATUSES,
  DOCUMENT_RUN_ITEM_MERGE_STATUSES,
  DOCUMENT_RUN_ITEM_STATUSES,
  DOCUMENT_RUN_ITEM_TERMINAL_STATUSES,
  type DocumentRunItem,
  type DocumentRunItemStatus
} from '../types/document-flow'

// Pure scheduling rules of a document run: which items may launch (dependency waves), which
// item merges next (one at a time), and when the run is over. No I/O — the renderer's
// orchestrator and the server's `start` / `finalize` both read these.

type DependencyNode = Pick<DocumentRunItem, 'key' | 'depends_on' | 'selected' | 'status'>

export function isTerminalItemStatus(status: DocumentRunItemStatus): boolean {
  return DOCUMENT_RUN_ITEM_TERMINAL_STATUSES.includes(status)
}

/**
 * A dependency no longer holds its dependents back once it is merged, or will never be
 * merged by this run (skipped, deselected, or not part of the run at all).
 */
export function isDependencySatisfied(dependency: DependencyNode | undefined): boolean {
  if (!dependency || !dependency.selected) return true
  return dependency.status === 'merged' || dependency.status === 'skipped'
}

/** Keys of the dependencies still holding `item` back. */
export function unmetDependencies(
  item: DependencyNode,
  items: readonly DependencyNode[]
): string[] {
  const byKey = new Map(items.map((candidate) => [candidate.key, candidate]))
  return item.depends_on.filter((key) => !isDependencySatisfied(byKey.get(key)))
}

/**
 * Pending items that may launch now, in document order, limited to the free slots:
 * every dependency satisfied, and fewer than `maxParallel` items with a live agent.
 */
export function launchableItems<T extends DocumentRunItem>(
  items: readonly T[],
  maxParallel: number
): T[] {
  const selected = items.filter((item) => item.selected)
  const active = selected.filter((item) =>
    DOCUMENT_RUN_ITEM_ACTIVE_STATUSES.includes(item.status)
  ).length
  const freeSlots = Math.max(0, Math.max(1, Math.floor(maxParallel)) - active)
  if (freeSlots === 0) return []
  return selected
    .filter((item) => item.status === 'pending' && unmetDependencies(item, items).length === 0)
    .sort((a, b) => a.position - b.position)
    .slice(0, freeSlots)
}

/** True while an item occupies the integration worktree (merging, verifying or being fixed). */
export function isMergeInFlight(items: readonly DocumentRunItem[]): boolean {
  return items.some(
    (item) => item.selected && DOCUMENT_RUN_ITEM_MERGE_STATUSES.includes(item.status)
  )
}

/**
 * The next `ready` item to merge, or null while another merge is in flight. An item that just
 * resolved its conflicts goes first: every merge that lands ahead of it can make it conflict
 * again. Then items that add migrations go after those that do not (their numbering is
 * regenerated against a later tip), otherwise document order.
 */
export function nextMergeCandidate<T extends DocumentRunItem>(items: readonly T[]): T | null {
  if (isMergeInFlight(items)) return null
  const ready = items
    .filter((item) => item.selected && item.status === 'ready')
    .sort(
      (a, b) =>
        Number(b.conflict_attempts > 0) - Number(a.conflict_attempts > 0) ||
        Number(a.has_migration) - Number(b.has_migration) ||
        a.position - b.position
    )
  return ready[0] ?? null
}

/** Every selected item reached a terminal status: the run can be finalized. */
export function isRunSettled(items: readonly DocumentRunItem[]): boolean {
  const selected = items.filter((item) => item.selected)
  return selected.length > 0 && selected.every((item) => isTerminalItemStatus(item.status))
}

/** `status_detail` prefix of an item whose session stopped for the user mid-step. */
export const WAITING_PREFIX = 'Waiting for you: '
/** `status_detail` of an item whose session the user interrupted. */
export const USER_INTERRUPT_DETAIL =
  'You interrupted this session. Send it a message to continue, or use Retry.'

/**
 * The item cannot advance without the user: it is flagged, or its session (also while it
 * resolves conflicts or fixes checks) stopped for a question, a permission or an interruption.
 */
export function isItemWaitingOnUser(
  item: Pick<DocumentRunItem, 'status' | 'status_detail'>
): boolean {
  if (item.status === 'needs_input' || item.status === 'needs_attention') return true
  if (item.status !== 'resolving_conflicts' && item.status !== 'fixing') return false
  const detail = item.status_detail ?? ''
  return detail.startsWith(WAITING_PREFIX) || detail === USER_INTERRUPT_DETAIL
}

/**
 * The run cannot advance without the user: nothing is launching, working or merging, and
 * whatever is left is waiting on them — directly, behind an item that is, or (given the
 * slot count) because every slot is held by an item waiting on them.
 */
export function isRunWaitingOnUser(
  items: readonly DocumentRunItem[],
  maxParallel?: number
): boolean {
  const open = items.filter((item) => item.selected && !isTerminalItemStatus(item.status))
  if (open.length === 0) return false
  const slotsBlocked =
    maxParallel !== undefined &&
    launchableItems(items, maxParallel).length === 0 &&
    open
      .filter((item) => DOCUMENT_RUN_ITEM_ACTIVE_STATUSES.includes(item.status))
      .every(isItemWaitingOnUser)
  return open.every((item) => {
    if (isItemWaitingOnUser(item)) return true
    if (item.status !== 'pending') return false
    return slotsBlocked || unmetDependencies(item, items).length > 0
  })
}

export interface DependencySanitization {
  /** Cleaned dependency list per key. */
  dependsOn: Record<string, string[]>
  warnings: string[]
}

/**
 * Make the dependency graph safe to schedule: drop self-references, unknown keys and
 * duplicates, then break every cycle. A cycle always holds an edge where a task depends on one
 * that comes later in the document; that edge is the one dropped, so tasks keep document order.
 */
export function sanitizeDependencies(
  items: readonly { key: string; depends_on: readonly string[] }[]
): DependencySanitization {
  const warnings: string[] = []
  const position = new Map(items.map((item, index) => [item.key, index]))
  const dependsOn: Record<string, string[]> = {}

  for (const item of items) {
    const cleaned: string[] = []
    for (const dependency of item.depends_on) {
      if (dependency === item.key) {
        warnings.push(`${item.key} listed itself as a dependency; ignored.`)
      } else if (!position.has(dependency)) {
        warnings.push(`${item.key} depends on unknown task "${dependency}"; ignored.`)
      } else if (!cleaned.includes(dependency)) {
        cleaned.push(dependency)
      }
    }
    dependsOn[item.key] = cleaned
  }

  // Each pass removes one edge of one cycle, so this ends after at most one pass per edge.
  for (let cycle = findCycle(items, dependsOn); cycle; cycle = findCycle(items, dependsOn)) {
    const edges = cycle.map((key, index) => [key, cycle[(index + 1) % cycle.length]] as const)
    const [dependent, dependency] =
      edges.find(([from, to]) => (position.get(from) ?? 0) < (position.get(to) ?? 0)) ?? edges[0]
    dependsOn[dependent] = dependsOn[dependent].filter((candidate) => candidate !== dependency)
    warnings.push(
      `Circular dependency ${[...cycle, cycle[0]].join(' → ')}; dropped "${dependent} depends on ${dependency}".`
    )
  }

  return { dependsOn, warnings }
}

/** The keys of one dependency cycle (each depends on the next, the last on the first), or null. */
function findCycle(
  items: readonly { key: string }[],
  dependsOn: Readonly<Record<string, readonly string[]>>
): string[] | null {
  const done = new Set<string>()
  const path: string[] = []
  const visit = (key: string): string[] | null => {
    const seenAt = path.indexOf(key)
    if (seenAt !== -1) return path.slice(seenAt)
    if (done.has(key)) return null
    path.push(key)
    for (const dependency of dependsOn[key] ?? []) {
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    path.pop()
    done.add(key)
    return null
  }
  for (const item of items) {
    const cycle = visit(item.key)
    if (cycle) return cycle
  }
  return null
}

export interface DocumentRunItemSummary {
  /** Selected items. */
  total: number
  merged: number
  /** Launching, working, being checked, merged or verified — the orchestrator is on it. */
  inProgress: number
  /** `needs_input` + `needs_attention`. */
  attention: number
  pending: number
  skipped: number
  byStatus: Record<DocumentRunItemStatus, number>
}

export function summarizeItems(items: readonly DocumentRunItem[]): DocumentRunItemSummary {
  const byStatus = Object.fromEntries(
    DOCUMENT_RUN_ITEM_STATUSES.map((status) => [status, 0])
  ) as Record<DocumentRunItemStatus, number>
  const selected = items.filter((item) => item.selected)
  for (const item of selected) byStatus[item.status] += 1
  const attention = byStatus.needs_input + byStatus.needs_attention
  const closed = byStatus.merged + byStatus.skipped + byStatus.cancelled
  return {
    total: selected.length,
    merged: byStatus.merged,
    inProgress: selected.length - closed - attention - byStatus.pending,
    attention,
    pending: byStatus.pending,
    skipped: byStatus.skipped + byStatus.cancelled,
    byStatus
  }
}

const slugify = (value: string, maxLength: number): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')

/** Worktree / branch name hint for a ticket: the task key first, so branches sort by task. */
export function ticketBranchHint(key: string, title: string): string {
  return slugify(`${key} ${title}`, 32) || 'task'
}

/** Worktree / branch name hint for a run's integration branch. */
export function integrationBranchHint(documentTitle: string): string {
  const slug = slugify(documentTitle, 36)
  return slug ? `doc-${slug}` : 'doc-run'
}
