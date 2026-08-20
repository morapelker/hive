import { useSettingsStore } from '@/stores/useSettingsStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { isForceBoardMode } from '@/api/hive-enterprise/client'
import { findBaseInstanceConnection } from '@/lib/connection-project'

/**
 * When the "auto-pin project on board prompts" setting is enabled, pin the
 * project's base (is_default) worktree so the project's tickets appear on the
 * pinned board. Connection projects (projects.kind === 'connection') have no
 * worktrees — their base INSTANCE (the connection over every member's default
 * worktree) is pinned instead, which scopes the project onto the pinned board
 * the same way. Never throws — call fire-and-forget via `void`.
 */
export async function autoPinBaseWorktree(projectId: string | null | undefined): Promise<void> {
  try {
    if (!projectId) return
    // Org "Force board mode" policy pins unconditionally — the local setting
    // is forced on and cannot be disabled.
    const settings = useSettingsStore.getState()
    if (!settings.autoPinBaseWorktreeOnBoardPrompt && !isForceBoardMode(settings)) return

    const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
    if (project?.kind === 'connection') {
      await pinConnectionProjectBase(projectId)
      return
    }

    let base = useWorktreeStore.getState().getDefaultWorktree(projectId)
    if (!base) {
      // The project's worktrees may not be loaded yet (e.g. auto-launch firing
      // from a store subscription shortly after startup)
      await useWorktreeStore.getState().loadWorktrees(projectId)
      base = useWorktreeStore.getState().getDefaultWorktree(projectId)
    }
    if (!base) return

    const pinned = usePinnedStore.getState()
    if (pinned.isWorktreePinned(base.id)) return
    await pinned.pinWorktree(base.id)
  } catch (err) {
    console.error('[auto-pin] failed to auto-pin base worktree:', err)
  }
}

async function pinConnectionProjectBase(projectId: string): Promise<void> {
  let base = findBaseInstanceConnection(projectId)
  if (!base) {
    // Connections may not be loaded yet, or the base was only just healed
    // server-side (connectionOps.getAll creates a missing base on listing).
    await useConnectionStore.getState().loadConnections()
    base = findBaseInstanceConnection(projectId)
  }
  if (!base) return

  const pinned = usePinnedStore.getState()
  if (pinned.isConnectionPinned(base.id)) return
  await pinned.pinConnection(base.id)
}
