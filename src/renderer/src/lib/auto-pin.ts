import { useSettingsStore, type AppSettings, type AutoPinMode } from '@/stores/useSettingsStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { isForceBoardMode } from '@/api/hive-enterprise/client'
import { findBaseInstanceConnection } from '@/lib/connection-project'

type AutoPinSettings = Pick<
  AppSettings,
  'autoPinOnBoardPrompt' | 'hiveAuthToken' | 'hiveOrganizationId' | 'hiveOrganizationForceBoardMode'
>

/**
 * The auto-pin mode actually in effect. The org "Force board mode" policy
 * forces 'root-branch' (the pre-3-way "on" behavior) and cannot be changed
 * locally; otherwise it is the user's own setting.
 */
export function resolveAutoPinMode(settings: AutoPinSettings): AutoPinMode {
  return isForceBoardMode(settings) ? 'root-branch' : settings.autoPinOnBoardPrompt
}

export interface AutoPinTarget {
  projectId: string | null | undefined
  /**
   * The worktree the session was sent on (git projects). In 'current-branch'
   * mode this is pinned instead of the project's base worktree.
   */
  worktreeId?: string | null
  /**
   * The connection instance the session was sent on (connection projects). In
   * 'current-branch' mode this is pinned instead of the project's base instance.
   */
  connectionId?: string | null
}

/**
 * Setting-gated auto-pin for board prompts: pins something in the project so
 * its tickets appear on the pinned board (pinning ANY worktree / instance of a
 * project scopes the whole project onto the pinned board).
 *
 * - 'off': no-op.
 * - 'root-branch': the project's base (is_default) worktree. Connection
 *   projects (projects.kind === 'connection') have no worktrees — their base
 *   INSTANCE (the connection over every member's default worktree) is pinned.
 * - 'current-branch': the worktree / connection instance the session was sent
 *   on, when the caller knows it and it belongs to the project; otherwise the
 *   same fallback as 'root-branch'.
 *
 * Never throws — call fire-and-forget via `void`.
 */
export async function autoPinForBoardPrompt(target: AutoPinTarget): Promise<void> {
  try {
    const { projectId } = target
    if (!projectId) return
    const mode = resolveAutoPinMode(useSettingsStore.getState())
    if (mode === 'off') return
    const currentBranch = mode === 'current-branch'

    const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
    if (project?.kind === 'connection') {
      await pinConnectionProjectInstance(projectId, currentBranch ? target.connectionId : null)
      return
    }
    await pinGitProjectWorktree(projectId, currentBranch ? target.worktreeId : null)
  } catch (err) {
    console.error('[auto-pin] failed to auto-pin for board prompt:', err)
  }
}

/**
 * The project's worktree matching `worktreeId` (must belong to `projectId` so
 * pinning it scopes this project's board), else the project's base worktree.
 */
function resolveWorktreeTarget(
  projectId: string,
  worktreeId: string | null | undefined
): { id: string } | null {
  const state = useWorktreeStore.getState()
  if (worktreeId) {
    const current = state.worktreesByProject.get(projectId)?.find((w) => w.id === worktreeId)
    if (current) return current
  }
  return state.getDefaultWorktree(projectId)
}

async function pinGitProjectWorktree(
  projectId: string,
  worktreeId: string | null | undefined
): Promise<void> {
  let target = resolveWorktreeTarget(projectId, worktreeId)
  if (!target || (worktreeId && target.id !== worktreeId)) {
    // The project's worktrees may not be loaded yet (e.g. auto-launch firing
    // from a store subscription shortly after startup), or the requested
    // worktree was only just created.
    await useWorktreeStore.getState().loadWorktrees(projectId)
    target = resolveWorktreeTarget(projectId, worktreeId)
  }
  if (!target) return

  const pinned = usePinnedStore.getState()
  if (pinned.isWorktreePinned(target.id)) return
  await pinned.pinWorktree(target.id)
}

/**
 * The project's instance matching `connectionId` (must be an instance of
 * `projectId` — an ad-hoc connection would not scope the project's board),
 * else the project's base instance.
 */
function resolveConnectionTarget(
  projectId: string,
  connectionId: string | null | undefined
): { id: string } | null {
  if (connectionId) {
    const current = useConnectionStore
      .getState()
      .connections.find((c) => c.id === connectionId && c.saved_project_id === projectId)
    if (current) return current
  }
  return findBaseInstanceConnection(projectId)
}

async function pinConnectionProjectInstance(
  projectId: string,
  connectionId: string | null | undefined
): Promise<void> {
  let target = resolveConnectionTarget(projectId, connectionId)
  if (!target || (connectionId && target.id !== connectionId)) {
    // Connections may not be loaded yet, or the base was only just healed
    // server-side (connectionOps.getAll creates a missing base on listing).
    await useConnectionStore.getState().loadConnections()
    target = resolveConnectionTarget(projectId, connectionId)
  }
  if (!target) return

  const pinned = usePinnedStore.getState()
  if (pinned.isConnectionPinned(target.id)) return
  await pinned.pinConnection(target.id)
}
