import { useEffect } from 'react'
import { terminalApi } from '@/api/terminal-api'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { lastSendMode } from '@/lib/message-send-times'
import { notifyKanbanSessionSync } from '@/stores/store-coordination'
import { isPlanLike } from '@/lib/constants'

type ClaudeCliStatusMetadata = {
  reason?: string
  hookEventName?: string
  hookPath?: string
  toolName?: string
  plan?: string
}

function closeLinkedTicketModal(sessionId: string): void {
  const kanbanState = useKanbanStore.getState()
  const selectedTicketId = kanbanState.selectedTicketId
  if (!selectedTicketId) return

  for (const projectTickets of kanbanState.tickets.values()) {
    const selectedTicket = projectTickets.find((ticket) => ticket.id === selectedTicketId)
    if (!selectedTicket) continue
    if (selectedTicket.current_session_id === sessionId) {
      kanbanState.setSelectedTicketId(null)
    }
    return
  }
}

export function useClaudeCliStatusListener(): void {
  useEffect(() => {
    const handlePlanFollowup = (
      sessionId: string,
      metadata: ClaudeCliStatusMetadata = {
        reason: 'claude_cli_plan_followup'
      }
    ): void => {
      useSessionStore.getState().clearPendingPlan(sessionId)
      notifyKanbanSessionSync(sessionId, { type: 'plan_followup' })
      closeLinkedTicketModal(sessionId)
      lastSendMode.set(sessionId, 'plan')
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'planning', metadata)
    }

    const unsubscribe = terminalApi.onClaudeCliStatus(({ sessionId, status, metadata }) => {
      const worktreeStatus = useWorktreeStatusStore.getState()
      const sessionStore = useSessionStore.getState()
      const currentStatus = worktreeStatus.sessionStatuses[sessionId]?.status
      const currentMode = sessionStore.modeBySession.get(sessionId)

      if (metadata?.hookEventName === 'PostToolUse' && metadata.toolName === 'ExitPlanMode') {
        // User approved ExitPlanMode from the terminal, matching the in-app implement action.
        sessionStore.clearPendingPlan(sessionId)
        notifyKanbanSessionSync(sessionId, { type: 'implement' })
        lastSendMode.set(sessionId, 'build')
        worktreeStatus.setSessionStatus(sessionId, 'working', metadata)
        return
      }

      if (
        status === 'plan_ready' &&
        metadata?.toolName === 'ExitPlanMode' &&
        typeof metadata.plan === 'string'
      ) {
        const syntheticId = `claude-cli:${sessionId}`
        sessionStore.setPendingPlan(sessionId, {
          requestId: syntheticId,
          planContent: metadata.plan,
          toolUseID: syntheticId
        })
      }

      if (
        status === 'planning' &&
        ((metadata?.hookEventName === 'UserPromptSubmit' && currentStatus === 'plan_ready') ||
          (metadata?.hookEventName === 'PostToolUseFailure' &&
            metadata.toolName === 'ExitPlanMode') ||
          metadata?.reason === 'claude_cli_plan_followup')
      ) {
        handlePlanFollowup(sessionId, metadata)
        return
      }

      if (
        status === 'working' &&
        metadata?.hookEventName === 'UserPromptSubmit' &&
        currentStatus === 'plan_ready'
      ) {
        lastSendMode.set(sessionId, 'build')
        worktreeStatus.setSessionStatus(sessionId, 'working', metadata)
        return
      }

      if (
        status === 'working' &&
        metadata?.hookEventName === 'UserPromptSubmit' &&
        isPlanLike(currentMode)
      ) {
        lastSendMode.set(sessionId, 'plan')
        worktreeStatus.setSessionStatus(sessionId, 'planning', metadata)
        return
      }

      if (
        status === 'completed' &&
        metadata?.hookEventName === 'Stop' &&
        lastSendMode.get(sessionId) === 'plan'
      ) {
        worktreeStatus.setSessionStatus(sessionId, 'plan_ready', metadata)
        return
      }

      worktreeStatus.setSessionStatus(sessionId, status, metadata)
    })

    return unsubscribe
  }, [])
}
