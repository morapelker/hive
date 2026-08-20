/**
 * Helpers for "connection projects" — saved connections promoted to standalone
 * sidebar projects (projects.kind === 'connection'). A connection project owns
 * its own kanban board; each launch materializes a live `connections` row (an
 * "instance") linked back via connections.saved_project_id.
 */
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

export interface MemberProject {
  id: string
  path: string
  name: string
}

interface ProjectLike {
  id: string
  kind?: 'git' | 'connection'
  member_project_ids?: string | null
}

export function isConnectionProject(project: ProjectLike | null | undefined): boolean {
  return project?.kind === 'connection'
}

// ── Base instance ──────────────────────────────────────────────────
// A connection project's BASE instance (connections.is_base = 1) is the twin
// of a git project's default worktree: each member project's default worktree
// connected together. Always present, never archivable/deletable, fixed members.

interface ConnectionInstanceLike {
  id: string
  saved_project_id?: string | null
  is_base?: number
}

/**
 * Base only while its connection project still exists — an is_base row whose
 * saved_project_id was nulled is an orphan the backend heals on the next
 * listing; until then it must behave like an ordinary (deletable) connection.
 */
export function isBaseInstance(connection: ConnectionInstanceLike | null | undefined): boolean {
  return !!connection?.is_base && !!connection?.saved_project_id
}

type ConnectionRecord = ReturnType<typeof useConnectionStore.getState>['connections'][number]

/** The base instance of a connection project from the connection store (null when not loaded/missing). */
export function findBaseInstanceConnection(projectId: string): ConnectionRecord | null {
  return (
    useConnectionStore
      .getState()
      .connections.find((c) => c.saved_project_id === projectId && isBaseInstance(c)) ?? null
  )
}

/**
 * Sidebar/picker label for a base instance: the distinct member default branch
 * names ("main", or "main + master"), mirroring how a default worktree shows its
 * branch name rather than a connection-style "proj-a + proj-b".
 */
export function baseInstanceLabel(
  members: ReadonlyArray<{ worktree_branch?: string | null }> | null | undefined
): string {
  const branches = [
    ...new Set((members ?? []).map((m) => m.worktree_branch?.trim()).filter(Boolean))
  ]
  return branches.join(' + ') || 'main'
}

/** Order instances like worktrees: user instances first (input order), the base instance last. */
export function sortInstancesBaseLast<T extends ConnectionInstanceLike>(instances: T[]): T[] {
  return [...instances.filter((c) => !isBaseInstance(c)), ...instances.filter((c) => isBaseInstance(c))]
}

/** Parse the JSON member id list stored on a connection project row. */
export function parseMemberProjectIds(memberProjectIdsJson: string | null | undefined): string[] {
  if (!memberProjectIdsJson) return []
  try {
    const parsed = JSON.parse(memberProjectIdsJson)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

/**
 * Resolve a connection project's member projects against the project store,
 * silently dropping members that have since been removed from Hive.
 */
export function getMemberProjects(project: ProjectLike): MemberProject[] {
  const ids = parseMemberProjectIds(project.member_project_ids)
  const projects = useProjectStore.getState().projects
  const byId = new Map(projects.map((p) => [p.id, p]))
  const members: MemberProject[] = []
  for (const id of ids) {
    const member = byId.get(id)
    if (member) members.push({ id: member.id, path: member.path, name: member.name })
  }
  return members
}

export interface WorktreeNameSet {
  name: string
  /** One entry per member project, in member order. */
  worktrees: { projectId: string; worktreeId: string; worktreePath: string }[]
}

/**
 * Worktree names that exist (active, non-default) in EVERY member project —
 * the "same name worktrees" the existing-worktree picker offers. Requires the
 * member projects' worktrees to already be loaded into the worktree store.
 */
export function computeWorktreeNameSets(memberProjects: MemberProject[]): WorktreeNameSet[] {
  if (memberProjects.length === 0) return []
  const worktreesByProject = useWorktreeStore.getState().worktreesByProject

  const nameMaps = memberProjects.map((member) => {
    const map = new Map<string, { worktreeId: string; worktreePath: string }>()
    for (const wt of worktreesByProject.get(member.id) ?? []) {
      if (wt.is_default || wt.status !== 'active') continue
      // First worktree wins on (unlikely) duplicate names within one project
      if (!map.has(wt.name)) map.set(wt.name, { worktreeId: wt.id, worktreePath: wt.path })
    }
    return map
  })

  const sets: WorktreeNameSet[] = []
  const [first, ...rest] = nameMaps
  for (const [name, firstEntry] of first) {
    const entries = [
      { projectId: memberProjects[0].id, worktreeId: firstEntry.worktreeId, worktreePath: firstEntry.worktreePath }
    ]
    let inAll = true
    for (let i = 0; i < rest.length; i++) {
      const entry = rest[i].get(name)
      if (!entry) {
        inAll = false
        break
      }
      entries.push({
        projectId: memberProjects[i + 1].id,
        worktreeId: entry.worktreeId,
        worktreePath: entry.worktreePath
      })
    }
    if (inAll) sets.push({ name, worktrees: entries })
  }
  sets.sort((a, b) => a.name.localeCompare(b.name))
  return sets
}
