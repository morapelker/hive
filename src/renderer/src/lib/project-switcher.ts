// The rules of the "Go to project" switcher, free of React and stores: which projects it
// lists in which group when nothing is typed, and how a typed query ranks them. In both, the
// more recently opened project comes first: text typed narrows the list to the projects it
// matches, and only sorts them by how it matches in broad kinds (rankSwitcherProjects).

export type SwitcherProjectKind = 'git' | 'connection' | 'data'

/** A project as the switcher sees it: a git project, a connection project or a database. */
export interface SwitcherProject {
  /** Unique across kinds: `switcherKey(kind, id)`. */
  key: string
  kind: SwitcherProjectKind
  id: string
  name: string
  /** What the row shows under "path": the folder (home shortened) or the database target. */
  path: string
  /** When the project was last opened (ms since epoch); 0 when unknown. */
  lastOpenedAt: number
}

/** Git and connection projects share the `projects` table; databases have their own ids. */
export function switcherKey(kind: SwitcherProjectKind, id: string): string {
  return `${kind === 'data' ? 'data' : 'project'}:${id}`
}

/** ISO timestamp → ms, 0 for a missing or unreadable value (sorts as "never opened"). */
export function parseOpenedAt(value: string | null | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

/** `/Users/ana/code/api` → `~/code/api` (macOS, Linux and Windows home folders). */
export function shortenHomePath(path: string): string {
  return path
    .replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~')
}

/** How long ago a project was opened: "now", "5m", "2h", "3d", "4mo", "2yr". */
export function formatOpenedAge(openedAt: number, now: number = Date.now()): string {
  if (!openedAt) return ''
  const minutes = Math.floor(Math.max(0, now - openedAt) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}yr`
}

// ---------------------------------------------------------------------------------------------
// Nothing typed: Pinned, Recent, All projects
// ---------------------------------------------------------------------------------------------

export const SWITCHER_RECENT_LIMIT = 5

export interface SwitcherGroups<P> {
  /** Projects on the Pinned Board, in the Pinned section's order. */
  pinned: P[]
  /** The most recently opened projects that are not pinned (at most SWITCHER_RECENT_LIMIT). */
  recent: P[]
  /** Everything else, most recently opened first. */
  all: P[]
}

/**
 * `projects` come in sidebar order, which settles projects opened at the same moment.
 * `pinnedKeys` are the pinned projects' keys in the Pinned section's order; a key with no
 * project behind it is ignored.
 */
export function groupSwitcherProjects<P extends SwitcherProject>(
  projects: readonly P[],
  pinnedKeys: readonly string[]
): SwitcherGroups<P> {
  const byKey = new Map(projects.map((p) => [p.key, p]))
  const pinnedSet = new Set(pinnedKeys)
  const pinned: P[] = []
  for (const key of pinnedSet) {
    const project = byKey.get(key)
    if (project) pinned.push(project)
  }
  // Array.prototype.sort is stable: equal times keep the sidebar order.
  const rest = projects
    .filter((p) => !pinnedSet.has(p.key))
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  return {
    pinned,
    recent: rest.slice(0, SWITCHER_RECENT_LIMIT),
    all: rest.slice(SWITCHER_RECENT_LIMIT)
  }
}

/**
 * The pinned projects' keys in the order the sidebar's Pinned section lists them: pinned
 * worktrees (their git projects), pinned connections (their connection projects; a connection
 * that was not saved as a project is not a project), then pinned databases. A project with
 * several pinned worktrees is listed once, at its first. `pinnedProjectIds` is the store's own
 * set of pinned projects: one whose pinned worktree is not in `worktreesByProject` (not loaded
 * yet) is still listed, after the ones the section's order is known for.
 */
export function pinnedSwitcherKeys(input: {
  pinnedWorktreeIds: Iterable<string>
  pinnedConnectionIds: Iterable<string>
  worktreesByProject: ReadonlyMap<string, readonly { id: string }[]>
  connections: readonly { id: string; saved_project_id?: string | null }[]
  dataProjects: readonly { id: string; pinned: boolean }[]
  pinnedProjectIds?: Iterable<string>
}): string[] {
  const projectIdByWorktree = new Map<string, string>()
  for (const [projectId, worktrees] of input.worktreesByProject) {
    for (const worktree of worktrees) projectIdByWorktree.set(worktree.id, projectId)
  }
  const keys = new Set<string>()
  for (const worktreeId of input.pinnedWorktreeIds) {
    const projectId = projectIdByWorktree.get(worktreeId)
    if (projectId) keys.add(switcherKey('git', projectId))
  }
  for (const connectionId of input.pinnedConnectionIds) {
    const projectId = input.connections.find((c) => c.id === connectionId)?.saved_project_id
    if (projectId) keys.add(switcherKey('connection', projectId))
  }
  for (const projectId of input.pinnedProjectIds ?? []) keys.add(switcherKey('git', projectId))
  for (const dataProject of input.dataProjects) {
    if (dataProject.pinned) keys.add(switcherKey('data', dataProject.id))
  }
  return [...keys]
}

// ---------------------------------------------------------------------------------------------
// Text typed: one ranked list
// ---------------------------------------------------------------------------------------------

/** How a query matches a text, closest first. Equally close means equal tier and gaps. */
export const MATCH_TIER = {
  exact: 0,
  prefix: 1,
  /** The query starts a word inside the text ("api" in "checkout-api"). */
  word: 2,
  substring: 3,
  /** The query's characters appear in order with other characters between them. */
  scattered: 4
} as const

export interface TextMatch {
  tier: number
  /** Characters skipped between the matched ones (0 unless scattered). */
  gaps: number
  /** Positions of the matched characters in the text. */
  indices: number[]
}

const range = (start: number, length: number): number[] =>
  Array.from({ length }, (_, i) => start + i)

function startsWord(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1]
  if (/[^A-Za-z0-9]/.test(previous)) return true
  // camelCase: "Api" in "checkoutApi"
  return /[a-z0-9]/.test(previous) && /[A-Z]/.test(text[index])
}

/**
 * Case-insensitive match of `query` in `text`: exact, prefix, start of a word, anywhere, or
 * scattered (in order, with the tightest span). Spaces in the query only matter for the
 * contiguous kinds; a scattered match ignores them ("check api" finds "checkout-api").
 */
export function matchText(query: string, text: string): TextMatch | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const lower = text.toLowerCase()
  // Lower-casing can change a string's length for a few characters; positions would be off.
  if (lower.length !== text.length) return null

  if (lower === q) return { tier: MATCH_TIER.exact, gaps: 0, indices: range(0, q.length) }
  if (lower.startsWith(q)) return { tier: MATCH_TIER.prefix, gaps: 0, indices: range(0, q.length) }

  let first = -1
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + 1)) {
    if (first === -1) first = at
    if (startsWord(text, at)) {
      return { tier: MATCH_TIER.word, gaps: 0, indices: range(at, q.length) }
    }
  }
  if (first !== -1) return { tier: MATCH_TIER.substring, gaps: 0, indices: range(first, q.length) }

  const letters = q.replace(/\s+/g, '')
  if (letters.length < 2) return null
  let best: number[] | null = null
  let bestSpan = Infinity
  for (
    let start = lower.indexOf(letters[0]);
    start !== -1;
    start = lower.indexOf(letters[0], start + 1)
  ) {
    // From a fixed first character, taking each next character as early as possible ends
    // earliest, so it is the tightest match that starts here.
    const indices = [start]
    let at = start
    for (let i = 1; i < letters.length; i++) {
      at = lower.indexOf(letters[i], at + 1)
      if (at === -1) break
      indices.push(at)
    }
    // No match from here means none from any later start either.
    if (indices.length < letters.length) break
    const span = at - start + 1
    if (span < bestSpan) {
      best = indices
      bestSpan = span
    }
  }
  if (!best) return null
  return { tier: MATCH_TIER.scattered, gaps: bestSpan - letters.length, indices: best }
}

/**
 * The kinds of match the ranking tells apart, best first. Within a kind the more recently
 * opened project comes first, so the kinds are few and broad: text that starts the name and
 * text that starts a later word of it are the same kind ("pa" finds "studio-pa", opened today,
 * above "paste-typer", opened last month).
 */
export const MATCH_KIND = {
  /** The text is the whole name. */
  exact: 0,
  /** The text starts the name or a word of it. */
  start: 1,
  /** The text is a run of characters inside a word. */
  inside: 2,
  /** The characters appear in order with others between them. */
  scattered: 3
} as const

function kindOf(tier: number): number {
  if (tier === MATCH_TIER.exact) return MATCH_KIND.exact
  if (tier === MATCH_TIER.prefix || tier === MATCH_TIER.word) return MATCH_KIND.start
  return tier === MATCH_TIER.substring ? MATCH_KIND.inside : MATCH_KIND.scattered
}

/** A path match always ranks below every name match. */
const PATH_KIND_OFFSET = 10

export interface SwitcherMatch<P> {
  project: P
  /**
   * The kind of match (MATCH_KIND; a path match is PATH_KIND_OFFSET higher). Lower is better;
   * equal scores are ordered by when the projects were last opened.
   */
  score: number
  /** Matched characters of the name; empty when only the path matched. */
  nameIndices: number[]
  /** Matched characters of the path, set only when the name did not match. */
  pathIndices: number[]
}

/** How exactly the text matched, to order projects of one kind opened at the same time. */
const closenessOf = (match: TextMatch): number => match.tier * 1000 + Math.min(match.gaps, 999)

/**
 * The projects matching `query`, in the order of the recent projects: within a kind of match
 * (MATCH_KIND) the more recently opened project comes first, whatever the finer difference
 * between the matches. An exact name leads, then names the text starts (or a word of them),
 * then a run inside a word, then scattered letters. The name decides; the path only counts
 * when the name does not match, and then only as a run of characters or a tight scattered
 * match (a long path would otherwise match almost any few letters).
 *
 * Projects of one kind opened at the same time (never opened, mostly) are ordered by the
 * closer match: a prefix before a later word, a tighter scattered match before a looser one.
 * The sidebar order settles what is left.
 */
export function rankSwitcherProjects<P extends SwitcherProject>(
  projects: readonly P[],
  query: string
): SwitcherMatch<P>[] {
  const q = query.trim()
  if (!q)
    return projects.map((project) => ({ project, score: 0, nameIndices: [], pathIndices: [] }))

  const letters = q.replace(/\s+/g, '').length
  const found: { match: SwitcherMatch<P>; closeness: number }[] = []
  for (const project of projects) {
    const nameMatch = matchText(q, project.name)
    if (nameMatch) {
      found.push({
        match: {
          project,
          score: kindOf(nameMatch.tier),
          nameIndices: nameMatch.indices,
          pathIndices: []
        },
        closeness: closenessOf(nameMatch)
      })
      continue
    }
    const pathMatch = matchText(q, project.path)
    if (pathMatch && pathMatch.gaps <= letters) {
      found.push({
        match: {
          project,
          score: kindOf(pathMatch.tier) + PATH_KIND_OFFSET,
          nameIndices: [],
          pathIndices: pathMatch.indices
        },
        closeness: closenessOf(pathMatch)
      })
    }
  }
  // Stable sort: the sidebar order settles what kind, recency and closeness leave equal.
  return found
    .sort(
      (a, b) =>
        a.match.score - b.match.score ||
        b.match.project.lastOpenedAt - a.match.project.lastOpenedAt ||
        a.closeness - b.closeness
    )
    .map(({ match }) => match)
}

// ---------------------------------------------------------------------------------------------
// Agent status of a project
// ---------------------------------------------------------------------------------------------

/** 'question': an agent waits on the user. 'working': one is running. */
export type SwitcherAgentState = 'question' | 'working'

/**
 * One indicator for a project from the session statuses of its worktrees (or of a connection
 * project's instances): waiting on the user wins over working; anything else (ready, unread,
 * nothing) shows no indicator. Same reading of the statuses as the sidebar's worktree rows.
 */
export function switcherAgentState(
  statuses: readonly (string | null | undefined)[]
): SwitcherAgentState | null {
  let working = false
  for (const status of statuses) {
    if (
      status === 'answering' ||
      status === 'permission' ||
      status === 'command_approval' ||
      status === 'plan_ready'
    ) {
      return 'question'
    }
    if (status === 'working' || status === 'planning') working = true
  }
  return working ? 'working' : null
}
