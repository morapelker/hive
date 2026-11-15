/**
 * Pin a whole project to the Pinned Board, or take it off: the one action behind every
 * "Pin to board" / "Unpin from board" control (the project's right-click menu, and the other
 * places that offer it). Call it from all of them so they behave the same.
 *
 * No data of its own. A project is on the Pinned Board while at least one of its worktrees
 * (git project) or instances (connection project) is pinned, so:
 * - pinning pins the project's default worktree, or the base instance of a connection project;
 * - unpinning removes the pin from every worktree / instance of the project.
 * Per-worktree Pin and Unpin read and write the same pins, so the two always agree.
 *
 * Databases have their own Pin (useDataProjectStore.setPinned) and are not handled here.
 */
import { toast } from '@/lib/toast'
import { dbApi } from '@/api/db-api'
import { connectionApi } from '@/api/connection-api'
import { usePinnedStore, type ProjectPinResult } from '@/stores/usePinnedStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { findBaseInstanceConnection } from '@/lib/connection-project'

export interface PinnableProject {
  id: string
  name: string
  /** 'git' when absent. */
  kind?: 'git' | 'connection'
}

/** Whether the project is on the Pinned Board (any of its worktrees / instances is pinned). */
export function isProjectPinned(projectId: string): boolean {
  return usePinnedStore.getState().pinnedProjectIds.has(projectId)
}

/** `isProjectPinned` as a hook: follows pins made anywhere, per worktree or per project. */
export function useIsProjectPinned(projectId: string): boolean {
  return usePinnedStore((s) => s.pinnedProjectIds.has(projectId))
}

const inFlight = new Map<string, Promise<boolean>>()

/**
 * Pin or unpin the project and confirm with a toast ("Pinned <name>" / "Unpinned <name>").
 * Works for a project whose worktrees were never loaded. Never selects or navigates.
 * On failure an error toast shows, nothing is changed, and it resolves to false.
 */
export function setProjectPinned(project: PinnableProject, pinned: boolean): Promise<boolean> {
  // A second request for a project that is still being changed joins the first one.
  const running = inFlight.get(project.id)
  if (running) return running

  const run = (async () => {
    let result: ProjectPinResult
    try {
      result = await applyProjectPin(project, pinned)
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (result.success) {
      toast.success(`${pinned ? 'Pinned' : 'Unpinned'} ${project.name}`)
    } else {
      toast.error(
        `Failed to ${pinned ? 'pin' : 'unpin'} ${project.name}`,
        result.error ? { description: result.error } : undefined
      )
    }
    return result.success
  })().finally(() => inFlight.delete(project.id))

  inFlight.set(project.id, run)
  return run
}

async function ensurePinsLoaded(): Promise<void> {
  if (!usePinnedStore.getState().loaded) await usePinnedStore.getState().loadPinned()
}

async function applyProjectPin(
  project: PinnableProject,
  pinned: boolean
): Promise<ProjectPinResult> {
  await ensurePinsLoaded()
  const kind = project.kind === 'connection' ? 'connection' : 'worktree'

  if (pinned) {
    // Already on the board through one of its worktrees / instances: nothing to add.
    if (isProjectPinned(project.id)) return { success: true }
    const target =
      kind === 'connection'
        ? await resolveBaseInstance(project.id)
        : await resolveDefaultWorktree(project.id)
    if (!target) {
      return {
        success: false,
        error:
          kind === 'connection'
            ? 'This connection project has no base connection.'
            : 'This project has no default worktree.'
      }
    }
    return usePinnedStore
      .getState()
      .setProjectPins({ projectId: project.id, kind, ids: [target.id], pinned: true })
  }

  const ids =
    kind === 'connection'
      ? await pinnedInstanceIds(project.id)
      : await pinnedWorktreeIds(project.id)
  return usePinnedStore
    .getState()
    .setProjectPins({ projectId: project.id, kind, ids, pinned: false })
}

/**
 * The project's default worktree. A project that was never expanded may not have its
 * worktrees in the store yet: they are read from the database, which also gives the Pinned
 * section the row it needs to draw the card. Nothing is expanded, synced or selected.
 */
async function resolveDefaultWorktree(projectId: string): Promise<{ id: string } | null> {
  const store = useWorktreeStore.getState()
  const known = store.getDefaultWorktree(projectId)
  if (known) return known
  await store.loadWorktrees(projectId, { force: true })
  return useWorktreeStore.getState().getDefaultWorktree(projectId)
}

/** The connection project's base instance, reloading the connections when it is not there. */
async function resolveBaseInstance(projectId: string): Promise<{ id: string } | null> {
  const known = findBaseInstanceConnection(projectId)
  if (known) return known
  // Not loaded yet, or only just created by the backend (listing heals a missing base).
  await useConnectionStore.getState().loadConnections()
  return findBaseInstanceConnection(projectId)
}

/**
 * Every pinned worktree of the project: the ones the database has (the project's worktrees
 * need not be loaded) plus the ones the store shows as pinned.
 */
async function pinnedWorktreeIds(projectId: string): Promise<string[]> {
  const stored = await dbApi.worktree.getPinned<{ id: string; project_id: string }>()
  const ids = new Set(stored.filter((wt) => wt.project_id === projectId).map((wt) => wt.id))

  const shown = usePinnedStore.getState().pinnedWorktreeIds
  for (const wt of useWorktreeStore.getState().worktreesByProject.get(projectId) ?? []) {
    if (shown.has(wt.id)) ids.add(wt.id)
  }
  return [...ids]
}

/** Every pinned instance of the connection project, from the database plus the store. */
async function pinnedInstanceIds(projectId: string): Promise<string[]> {
  const stored = await connectionApi.getPinned()
  const ids = new Set(stored.filter((c) => c.saved_project_id === projectId).map((c) => c.id))

  const shown = usePinnedStore.getState().pinnedConnectionIds
  for (const connection of useConnectionStore.getState().connections) {
    if (connection.saved_project_id === projectId && shown.has(connection.id)) {
      ids.add(connection.id)
    }
  }
  return [...ids]
}
