import { useCallback, useEffect, useMemo } from 'react'
import { useGitStore } from '@/stores/useGitStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore, type MergeConflictFlow } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

type ConflictFixMode = 'build' | 'plan'

function isConflictFixActiveStatus(status: string | null): boolean {
  return (
    status === 'working' ||
    status === 'planning' ||
    status === 'answering' ||
    status === 'permission'
  )
}

function resolveWorktree(worktreeId: string | null): {
  worktreePath: string | null
  projectId: string | null
  branchName: string
} {
  if (!worktreeId) {
    return { worktreePath: null, projectId: null, branchName: 'unknown' }
  }

  for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
    const worktree = worktrees.find((wt) => wt.id === worktreeId)
    if (worktree) {
      return {
        worktreePath: worktree.path,
        projectId: worktree.project_id,
        branchName: worktree.branch_name || 'unknown'
      }
    }
  }

  return { worktreePath: null, projectId: null, branchName: 'unknown' }
}

export function useConflictFixFlow(worktreeId: string | null): {
  phase: MergeConflictFlow['phase'] | null
  isRunning: boolean
  isFinalizing: boolean
  attachedSessionId: string | null
  startFixFlow: (modeOverride?: ConflictFixMode) => Promise<void>
  openAttachedSession: () => void
} {
  const worktreesByProject = useWorktreeStore((state) => state.worktreesByProject)
  const worktreeInfo = useMemo(() => {
    if (!worktreeId) {
      return { worktreePath: null, projectId: null, branchName: 'unknown' }
    }
    for (const worktrees of worktreesByProject.values()) {
      const worktree = worktrees.find((wt) => wt.id === worktreeId)
      if (worktree) {
        return {
          worktreePath: worktree.path,
          projectId: worktree.project_id,
          branchName: worktree.branch_name || 'unknown'
        }
      }
    }
    return { worktreePath: null, projectId: null, branchName: 'unknown' }
  }, [worktreeId, worktreesByProject])

  const mergeConflictMode = useSettingsStore((state) => state.mergeConflictMode)
  const createSession = useSessionStore((state) => state.createSession)
  const updateSessionName = useSessionStore((state) => state.updateSessionName)
  const setActiveSession = useSessionStore((state) => state.setActiveSession)
  const flow = useWorktreeStatusStore((state) =>
    worktreeId ? state.mergeConflictFlowByWorktree[worktreeId] : undefined
  )
  const attachedSessionId = useWorktreeStatusStore((state) =>
    worktreeId ? (state.mergeConflictSessionByWorktree[worktreeId] ?? null) : null
  )
  const conflictFixSessionStatus = useWorktreeStatusStore((state) =>
    flow?.phase === 'running' ? (state.sessionStatuses[flow.sessionId]?.status ?? null) : null
  )
  const hasConflicts = useGitStore((state) =>
    worktreeInfo.worktreePath
      ? (state.conflictsByWorktree[worktreeInfo.worktreePath] ?? false)
      : false
  )

  const clearFlowAndSession = useCallback(() => {
    if (!worktreeId) return
    const statusStore = useWorktreeStatusStore.getState()
    statusStore.setMergeConflictFlow(worktreeId, null)
    statusStore.clearMergeConflictSession(worktreeId)
  }, [worktreeId])

  const startFixFlow = useCallback(
    async (modeOverride?: ConflictFixMode) => {
      if (!worktreeId) return

      const currentFlow = useWorktreeStatusStore.getState().mergeConflictFlowByWorktree[worktreeId]
      if (currentFlow?.phase === 'starting' || currentFlow?.phase === 'running') return

      const currentWorktree = resolveWorktree(worktreeId)
      if (!currentWorktree.worktreePath || !currentWorktree.projectId) return

      const resolvedMode =
        modeOverride ?? (mergeConflictMode === 'always-ask' ? 'build' : mergeConflictMode)
      const statusStore = useWorktreeStatusStore.getState()
      statusStore.setMergeConflictFlow(worktreeId, { phase: 'starting' })

      // Queue the prompt atomically with session creation: queuing it after
      // the updateSessionName roundtrip loses the race against
      // ClaudeCliSessionView mounting and spawning a promptless PTY.
      const { success, session } = await createSession(
        worktreeId,
        currentWorktree.projectId,
        undefined,
        resolvedMode,
        { pendingMessage: 'Fix merge conflicts' }
      )
      if (!success || !session) {
        statusStore.setMergeConflictFlow(worktreeId, null)
        return
      }

      useProjectStore.getState().selectProject(currentWorktree.projectId)
      useWorktreeStore.getState().selectWorktree(worktreeId)
      useSessionStore.getState().setActiveWorktree(worktreeId)
      await updateSessionName(session.id, `Merge Conflicts — ${currentWorktree.branchName}`)
      setActiveSession(session.id)
      statusStore.setMergeConflictSession(worktreeId, session.id)
      statusStore.setMergeConflictFlow(worktreeId, {
        phase: 'running',
        sessionId: session.id,
        seenBusy: false
      })
    },
    [createSession, mergeConflictMode, setActiveSession, updateSessionName, worktreeId]
  )

  useEffect(() => {
    if (!worktreeId || !worktreeInfo.worktreePath || !flow || flow.phase !== 'running') return

    const isBusy = isConflictFixActiveStatus(conflictFixSessionStatus)

    if (isBusy && !flow.seenBusy) {
      useWorktreeStatusStore
        .getState()
        .setMergeConflictFlow(worktreeId, { ...flow, seenBusy: true })
      return
    }

    const shouldFinalize =
      (flow.seenBusy && !isBusy) || (!flow.seenBusy && conflictFixSessionStatus === 'completed')

    if (!shouldFinalize) return

    let cancelled = false
    const finishConflictRun = async (): Promise<void> => {
      useWorktreeStatusStore.getState().setMergeConflictFlow(worktreeId, { phase: 'refreshing' })

      try {
        await useGitStore.getState().refreshStatuses(worktreeInfo.worktreePath!)
      } finally {
        if (!cancelled) {
          clearFlowAndSession()
        }
      }
    }

    void finishConflictRun()

    return () => {
      cancelled = true
    }
  }, [clearFlowAndSession, conflictFixSessionStatus, flow, worktreeId, worktreeInfo.worktreePath])

  useEffect(() => {
    if (!worktreeId || (!flow && !attachedSessionId)) return
    if (!hasConflicts) {
      clearFlowAndSession()
    }
  }, [attachedSessionId, clearFlowAndSession, flow, hasConflicts, worktreeId])

  const openAttachedSession = useCallback(() => {
    if (!worktreeId || !attachedSessionId) return
    const currentWorktree = resolveWorktree(worktreeId)
    const kanbanStore = useKanbanStore.getState()
    if (kanbanStore.isBoardViewActive) kanbanStore.toggleBoardView()
    if (kanbanStore.isPinnedBoardActive) kanbanStore.togglePinnedBoard()
    if (currentWorktree.projectId) {
      useProjectStore.getState().selectProject(currentWorktree.projectId)
    }
    useWorktreeStore.getState().selectWorktree(worktreeId)
    useSessionStore.getState().setActiveWorktree(worktreeId)
    useSessionStore.getState().setActiveSession(attachedSessionId)
  }, [attachedSessionId, worktreeId])

  return {
    phase: flow?.phase ?? null,
    isRunning: flow?.phase === 'starting' || flow?.phase === 'running',
    isFinalizing: flow?.phase === 'refreshing',
    attachedSessionId,
    startFixFlow,
    openAttachedSession
  }
}
