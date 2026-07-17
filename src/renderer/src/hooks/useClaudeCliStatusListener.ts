import { useEffect } from 'react'
import { terminalApi } from '@/api/terminal-api'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUsageStore, resolveUsageProvider } from '@/stores/useUsageStore'
import { lastSendMode } from '@/lib/message-send-times'
import { notifyKanbanSessionSync } from '@/stores/store-coordination'
import { isPlanLike } from '@/lib/constants'
import { isHandoffPickerOpenForSession } from '@/lib/handoff-ui-state'

type ClaudeCliStatusMetadata = {
  reason?: string
  hookEventName?: string
  hookPath?: string
  toolName?: string
  plan?: string
  taskNotification?: boolean
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

// The hook server's armed registry is in-memory (desktop process), while the
// durable auto_approve_plan flag lives on the ticket. Re-asserting on every
// 'planning' publish keeps the two in sync across all spawn paths, --resume,
// and app restarts, and is a no-op for non-armed tickets.
function reassertPlanAutoApprove(sessionId: string): void {
  for (const projectTickets of useKanbanStore.getState().tickets.values()) {
    for (const ticket of projectTickets) {
      if (ticket.current_session_id !== sessionId) continue
      if (ticket.auto_approve_plan && isPlanLike(ticket.mode) && !ticket.goal_mode) {
        void terminalApi.setClaudeCliPlanAutoApprove(sessionId, true).catch(() => undefined)
      }
      return
    }
  }
}

// claude-cli PTY sessions never ride the opencode event stream, so the
// idle-triggered usage refresh in useOpenCodeGlobalListener never fires for
// them. Refresh here when a turn finishes (Stop hook or synthetic completion),
// resolving the provider per session so custom providers attribute to their
// configured usage account ('none' skips). fetchUsageForProvider is
// debounce-safe, matching the other SDKs' idle refresh semantics.
function triggerClaudeCliUsageRefresh(sessionId: string): void {
  const { usageIndicatorMode, usageIndicatorProviders } = useSettingsStore.getState()
  const usageEnabled =
    usageIndicatorMode === 'current-agent' ||
    (usageIndicatorMode === 'specific-providers' && usageIndicatorProviders.length > 0)
  if (!usageEnabled) return
  const session = useSessionStore.getState().getSessionById(sessionId)
  if (!session) return
  const provider = resolveUsageProvider(session)
  if (provider) {
    useUsageStore.getState().fetchUsageForProvider(provider)
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
      // While the user has a handoff picker open for this session, keep the
      // plan card, ticket state, and modal alive — tearing them down strands
      // the picker popover (its anchor collapses). Status still updates; the
      // handoff confirm path unregisters the picker before dispatching, so a
      // real handoff's teardown is unaffected.
      if (!isHandoffPickerOpenForSession(sessionId)) {
        useSessionStore.getState().clearPendingPlan(sessionId)
        notifyKanbanSessionSync(sessionId, { type: 'plan_followup' })
        closeLinkedTicketModal(sessionId)
      }
      lastSendMode.set(sessionId, 'plan')
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'planning', metadata)
    }

    const unsubscribe = terminalApi.onClaudeCliStatus(({ sessionId, status, metadata }) => {
      const worktreeStatus = useWorktreeStatusStore.getState()
      const sessionStore = useSessionStore.getState()
      const currentStatus = worktreeStatus.sessionStatuses[sessionId]?.status
      const currentMode = sessionStore.modeBySession.get(sessionId)

      // Background subagents auto-resume the main agent via a UserPromptSubmit
      // whose prompt is a <task-notification>; the hook server stamps those
      // publishes with taskNotification: true. To the state machine below this
      // looks exactly like a human sending a prompt, but it isn't one — it must
      // not clear a pending plan or flip the send mode away from plan. If the
      // session was sitting at plan_ready, leave it there (the eventual Stop
      // re-derives plan_ready from lastSendMode === 'plan'); otherwise fall
      // through to the default status write below so the UI still reflects the
      // session genuinely working again.
      if (metadata?.taskNotification === true) {
        if (currentStatus === 'plan_ready') return
        worktreeStatus.setSessionStatus(sessionId, status, metadata)
        return
      }

      if (status === 'planning') {
        reassertPlanAutoApprove(sessionId)
      }

      if (metadata?.hookEventName === 'PostToolUse' && metadata.toolName === 'ExitPlanMode') {
        // User approved ExitPlanMode from the terminal, matching the in-app implement action.
        // Any approval consumes the one-shot auto-approve arm (no-op if the hook
        // server already consumed it when auto-approving).
        void terminalApi.setClaudeCliPlanAutoApprove(sessionId, false).catch(() => undefined)
        if (isPlanLike(currentMode)) {
          // Persist the session itself to build mode so a later --resume respawn
          // doesn't pass --permission-mode plan. Claude already left plan mode
          // when the dialog was approved, so skip the Shift+Tab PTY sync.
          void sessionStore.setSessionMode(sessionId, 'build', { syncCliPermissionMode: false })
        }
        // Same handoff-picker guard as handlePlanFollowup: don't rip the plan
        // card / ticket modal out from under an open picker.
        if (!isHandoffPickerOpenForSession(sessionId)) {
          sessionStore.clearPendingPlan(sessionId)
          notifyKanbanSessionSync(sessionId, { type: 'implement' })
          closeLinkedTicketModal(sessionId)
        }
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
        reassertPlanAutoApprove(sessionId)
        lastSendMode.set(sessionId, 'plan')
        worktreeStatus.setSessionStatus(sessionId, 'planning', metadata)
        return
      }

      if (status === 'completed') {
        triggerClaudeCliUsageRefresh(sessionId)
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
