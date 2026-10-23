import { subsequenceMatch, type SubsequenceMatch } from './subsequence-match'

export interface FilterableProject {
  id: string
  name: string
  path: string
  language: string | null
}

export interface ProjectFilterCriteria {
  filterQuery: string
  activeLanguages: string[]
  activeSpaceId: string | null
  projectSpaceMap: Record<string, string[]>
}

export interface FilteredProject<P extends FilterableProject> {
  project: P
  nameMatch: SubsequenceMatch | null
  pathMatch: SubsequenceMatch | null
}

/**
 * Applies the sidebar filter (space → language → subsequence query) to a project
 * list. When a query is present the result is sorted by match quality and each
 * entry carries the name/path match details for highlighting.
 */
export function filterProjects<P extends FilterableProject>(
  projects: P[],
  { filterQuery, activeLanguages, activeSpaceId, projectSpaceMap }: ProjectFilterCriteria
): FilteredProject<P>[] {
  let spaceFiltered = projects
  if (activeSpaceId !== null) {
    const allowedIds = new Set(
      Object.entries(projectSpaceMap)
        .filter(([, spaceIds]) => spaceIds.includes(activeSpaceId))
        .map(([projectId]) => projectId)
    )
    spaceFiltered = projects.filter((p) => allowedIds.has(p.id))
  }

  let langFiltered = spaceFiltered
  if (activeLanguages.length > 0) {
    const langSet = new Set(activeLanguages)
    langFiltered = spaceFiltered.filter((p) => p.language && langSet.has(p.language))
  }

  if (!filterQuery.trim())
    return langFiltered.map((p) => ({ project: p, nameMatch: null, pathMatch: null }))

  return langFiltered
    .map((project) => ({
      project,
      nameMatch: subsequenceMatch(filterQuery, project.name),
      pathMatch: subsequenceMatch(filterQuery, project.path)
    }))
    .filter(({ nameMatch, pathMatch }) => nameMatch.matched || pathMatch.matched)
    .sort((a, b) => {
      const aScore = a.nameMatch.matched ? a.nameMatch.score : a.pathMatch.score + 1000
      const bScore = b.nameMatch.matched ? b.nameMatch.score : b.pathMatch.score + 1000
      return aScore - bScore
    })
}

// ---------------------------------------------------------------------------------------------
// One sidebar list of git projects and data projects (database connections)
// ---------------------------------------------------------------------------------------------

export type SidebarEntry<P, D> =
  { kind: 'project'; id: string; item: P } | { kind: 'data'; id: string; item: D }

/**
 * Git projects and data projects share one `sort_order` space. Git projects come in store order
 * (a local drag reorders the array without rewriting `sort_order`), data projects are sorted by
 * `sortOrder`; a stable merge keeps each kind's own order and interleaves them by sort order,
 * a git project first on a tie (a git project added on top shares slot 0 with nothing newer).
 */
export function mergeSidebarEntries<
  P extends { id: string; sort_order: number },
  D extends { id: string; sortOrder: number }
>(projects: readonly P[], dataProjects: readonly D[]): SidebarEntry<P, D>[] {
  const data = [...dataProjects].sort((a, b) => a.sortOrder - b.sortOrder)
  const merged: SidebarEntry<P, D>[] = []
  let i = 0
  let j = 0
  while (i < projects.length || j < data.length) {
    const project = projects[i]
    const dataProject = data[j]
    if (project && (!dataProject || (project.sort_order ?? 0) <= dataProject.sortOrder)) {
      merged.push({ kind: 'project', id: project.id, item: project })
      i++
    } else {
      merged.push({ kind: 'data', id: dataProject.id, item: dataProject })
      j++
    }
  }
  return merged
}

/** A merged sidebar entry as the filter sees it (`entry` is the original entry). */
export interface SidebarFilterRow<E> extends FilterableProject {
  entry: E
}

/**
 * The sidebar filter over the merged list (what ProjectList shows, and what next / previous
 * project walks): a data project matches on its name or `describeData(item)` (host / database),
 * its engine counts as its language and it is listed in every space.
 */
export function filterSidebarEntries<
  P extends FilterableProject,
  D extends { id: string; name: string; engine: string }
>(
  entries: readonly SidebarEntry<P, D>[],
  criteria: ProjectFilterCriteria,
  describeData: (item: D) => string
): FilteredProject<SidebarFilterRow<SidebarEntry<P, D>>>[] {
  const rows = entries.map((entry): SidebarFilterRow<SidebarEntry<P, D>> =>
    entry.kind === 'project'
      ? {
          id: entry.id,
          name: entry.item.name,
          path: entry.item.path,
          language: entry.item.language,
          entry
        }
      : {
          id: entry.id,
          name: entry.item.name,
          path: describeData(entry.item),
          language: entry.item.engine,
          entry
        }
  )
  let { projectSpaceMap } = criteria
  if (criteria.activeSpaceId !== null) {
    const dataIds = entries.filter((e) => e.kind === 'data').map((e) => e.id)
    if (dataIds.length > 0) {
      projectSpaceMap = { ...projectSpaceMap }
      for (const id of dataIds) projectSpaceMap[id] = [criteria.activeSpaceId]
    }
  }
  return filterProjects(rows, { ...criteria, projectSpaceMap })
}

/**
 * A new order for the git projects of a merged sidebar order (e.g. most recent message first)
 * that leaves every data project in its slot: the git slots are refilled in `gitOrder`. Git
 * projects missing from `gitOrder` follow in their current order; unknown ids are ignored.
 */
export function reorderGitEntries<E extends { kind: 'project' | 'data'; id: string }>(
  entries: readonly E[],
  gitOrder: readonly string[]
): E[] {
  const git = entries.filter((e) => e.kind === 'project')
  const byId = new Map(git.map((e) => [e.id, e]))
  const ordered = gitOrder.flatMap((id) => {
    const entry = byId.get(id)
    if (!entry) return []
    byId.delete(id)
    return [entry]
  })
  const queue = [...ordered, ...git.filter((e) => byId.has(e.id))]
  let next = 0
  return entries.map((e) => (e.kind === 'project' ? queue[next++] : e))
}

/**
 * Drag-and-drop over the merged list: `draggedId` lands right before `targetId` (the drop
 * indicator is a top border on the target). Null when either id is unknown or they are equal.
 */
export function moveSidebarEntry<E extends { id: string }>(
  entries: readonly E[],
  draggedId: string,
  targetId: string
): E[] | null {
  if (draggedId === targetId) return null
  const from = entries.findIndex((e) => e.id === draggedId)
  const to = entries.findIndex((e) => e.id === targetId)
  if (from === -1 || to === -1) return null
  const next = [...entries]
  const [moved] = next.splice(from, 1)
  // After removing `from`, everything below it shifted up by one.
  next.splice(from < to ? to - 1 : to, 0, moved)
  return next
}
