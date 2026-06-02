import { useEffect, useState } from 'react'
import { unwrapEnvelope, unwrapEnvelopeApi } from '@/lib/ipc-envelope'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

const db = unwrapEnvelopeApi(() => window.db)
const DEFAULT_POLL_MS = 1000

function getWorktreePath(worktreeId: string | null): string | null {
  if (!worktreeId) return null
  for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
    const worktree = worktrees.find((candidate) => candidate.id === worktreeId)
    if (worktree) return worktree.path
  }
  return null
}

async function getRuntimePath(session: {
  worktree_id: string | null
  connection_id: string | null
}): Promise<string | null> {
  const worktreePath = getWorktreePath(session.worktree_id)
  if (worktreePath) return worktreePath

  if (!session.connection_id) return null

  const localConnection = useConnectionStore
    .getState()
    .connections.find((connection) => connection.id === session.connection_id)
  if (localConnection?.path) return localConnection.path

  if (!window.connectionOps?.get) return null
  try {
    const result = unwrapEnvelope(await window.connectionOps.get(session.connection_id))
    return result.success && result.connection ? result.connection.path : null
  } catch {
    return null
  }
}

export function useDurableSessionHistory(sessionId: string): boolean {
  const [hasDurableHistory, setHasDurableHistory] = useState(true)
  const session = useSessionStore((state) => state.getSessionById(sessionId))
  const opencodeSessionId = session?.opencode_session_id
  const claudeSessionId = session?.claude_session_id
  const agentSdk = session?.agent_sdk
  const worktreeId = session?.worktree_id
  const connectionId = session?.connection_id

  useEffect(() => {
    let mounted = true

    async function checkDurableHistory(): Promise<void> {
      try {
        if (!db.sessionMessage?.list || !db.sessionActivity?.list) {
          if (mounted) setHasDurableHistory(true)
          return
        }
        const [messageRows, activityRows] = await Promise.all([
          db.sessionMessage.list(sessionId),
          db.sessionActivity.list(sessionId)
        ])
        if (messageRows.length > 0 || activityRows.length > 0) {
          if (mounted) setHasDurableHistory(true)
          return
        }

        if (agentSdk === 'claude-code-cli' && claudeSessionId) {
          if (mounted) setHasDurableHistory(true)
          return
        }

        if (opencodeSessionId) {
          if (!window.opencodeOps?.getMessages) {
            if (mounted) setHasDurableHistory(true)
            return
          }
          const runtimePath = await getRuntimePath({
            worktree_id: worktreeId ?? null,
            connection_id: connectionId ?? null
          })
          if (!runtimePath) {
            if (mounted) setHasDurableHistory(true)
            return
          }
          const result = unwrapEnvelope(
            await window.opencodeOps.getMessages(runtimePath, opencodeSessionId)
          )
          if (!result.success || !Array.isArray(result.messages)) {
            if (mounted) setHasDurableHistory(true)
            return
          }
          if (mounted) setHasDurableHistory(result.messages.length > 0)
          return
        }

        if (mounted) setHasDurableHistory(false)
      } catch {
        if (mounted) setHasDurableHistory(true)
      }
    }

    setHasDurableHistory(true)
    void checkDurableHistory()
    const intervalId = window.setInterval(() => {
      void checkDurableHistory()
    }, DEFAULT_POLL_MS)

    return () => {
      mounted = false
      window.clearInterval(intervalId)
    }
  }, [sessionId, opencodeSessionId, claudeSessionId, agentSdk, worktreeId, connectionId])

  return hasDurableHistory
}
