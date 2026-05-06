import { useEffect, useRef } from 'react'
import type { PetStatusPayload } from '@shared/types/pet'
import { aggregatePetStatus } from '@/lib/pet-status-aggregator'
import {
  useConnectionStore,
  useProjectStore,
  useSettingsStore,
  useSessionStore,
  useWorktreeStatusStore,
  useWorktreeStore
} from '@/stores'

function sameStatus(a: PetStatusPayload | null, b: PetStatusPayload): boolean {
  return a?.state === b.state && a.sourceWorktreeId === b.sourceWorktreeId
}

function computeStatus(): PetStatusPayload {
  const statusState = useWorktreeStatusStore.getState()
  const sessionState = useSessionStore.getState()
  const connectionState = useConnectionStore.getState()

  return aggregatePetStatus({
    sessionStatuses: statusState.sessionStatuses,
    worktreeSessions: sessionState.sessionsByWorktree,
    connectionSessions: sessionState.sessionsByConnection,
    connections: connectionState.connections
  })
}

function jumpToWorktree(worktreeId: string): void {
  const worktreeState = useWorktreeStore.getState()
  const projectEntry = Array.from(worktreeState.worktreesByProject.entries()).find(([, worktrees]) =>
    worktrees.some((worktree) => worktree.id === worktreeId)
  )
  const projectId = projectEntry?.[0]

  if (projectId) {
    useProjectStore.getState().selectProject(projectId)
  }
  worktreeState.selectWorktree(worktreeId)
  useSessionStore.getState().setActiveWorktree(worktreeId)
}

export function PetStatusBridge(): null {
  const lastPublishedRef = useRef<PetStatusPayload | null>(null)

  useEffect(() => {
    const publishIfChanged = (): void => {
      const next = computeStatus()
      if (sameStatus(lastPublishedRef.current, next)) return
      lastPublishedRef.current = next
      window.petOps.publishStatus(next)
    }

    publishIfChanged()

    const cleanupStatus = useWorktreeStatusStore.subscribe(publishIfChanged)
    const cleanupSessions = useSessionStore.subscribe(publishIfChanged)
    const cleanupConnections = useConnectionStore.subscribe(publishIfChanged)
    const cleanupJump = window.petOps.onJumpToWorktree(({ worktreeId }) => {
      if (worktreeId) jumpToWorktree(worktreeId)
    })
    const cleanupSettings = window.petOps.onSettingsUpdated((settings) => {
      const current = useSettingsStore.getState().pet
      if (current.hasHatched !== settings.hasHatched) {
        useSettingsStore.setState({ pet: { ...current, hasHatched: settings.hasHatched } })
      }
    })

    return () => {
      cleanupStatus()
      cleanupSessions()
      cleanupConnections()
      cleanupJump()
      cleanupSettings()
    }
  }, [])

  return null
}
