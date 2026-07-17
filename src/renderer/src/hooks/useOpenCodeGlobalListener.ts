import { useEffect } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import type { CodexThreadGoal } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { usePermissionStore } from '@/stores/usePermissionStore'
import { useCommandApprovalStore } from '@/stores/useCommandApprovalStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useContextStore, type TokenInfo, type SessionModelRef } from '@/stores/useContextStore'
import { useRecentStore } from '@/stores/useRecentStore'
import { useUsageStore, resolveUsageProvider } from '@/stores'
import { extractTokens, extractCost, extractModelRef, extractModelUsage } from '@/lib/token-utils'
import { COMPLETION_WORDS } from '@/lib/format-utils'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { computeTokenDelta, snapshotTokenBaseline } from '@/lib/token-baselines'
import { lastSendMode, messageSendTimes } from '@/lib/message-send-times'
import {
  recordHivePromptIdleForSession,
  startHivePromptTelemetry
} from '@/lib/hive-enterprise-telemetry'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { checkAutoApprove } from '@/lib/permissionUtils'
import { isPlanLike } from '@/lib/constants'
import { shouldPreserveBlockingSessionStatus } from '@/lib/session-status-guards'
import { handleSessionIdleFollowUp } from '@/lib/session-follow-up-dispatch'
import { useKanbanStore } from '@/stores/useKanbanStore'
import {
  notifyKanbanSessionSync,
  notifyKanbanAutoCreateTicket
} from '@/stores/store-coordination'
import { dbApi } from '@/api/db-api'
import { opencodeApi } from '@/api/opencode-api'
import { connectionApi } from '@/api/connection-api'
import { worktreeApi } from '@/api/worktree-api'
import { maybeExtractJsonTitle } from '@shared/title-utils'
import type { AnthropicRateLimitInfo } from '@shared/types/usage'

interface PromptDispatchContext {
  worktreePath: string
  opencodeSessionId: string
}

interface BackgroundTelemetrySession {
  id: string
  worktree_id?: string | null
  connection_id?: string | null
  model_provider_id?: string | null
  model_id?: string | null
  model_variant?: string | null
}

type PromptDispatchDbSession = {
  worktree_id?: string | null
  connection_id?: string | null
  opencode_session_id?: string | null
}

function resolvePromptDispatchContextFromStores(sessionId: string): PromptDispatchContext | null {
  const sessionState = useSessionStore.getState()

  for (const [worktreeId, sessions] of sessionState.sessionsByWorktree) {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session?.opencode_session_id) continue

    const worktreesByProject = useWorktreeStore.getState().worktreesByProject
    for (const worktrees of worktreesByProject.values()) {
      const worktree = worktrees.find((w) => w.id === worktreeId)
      if (worktree?.path) {
        return {
          worktreePath: worktree.path,
          opencodeSessionId: session.opencode_session_id
        }
      }
    }
  }

  for (const [connectionId, sessions] of sessionState.sessionsByConnection) {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session?.opencode_session_id) continue

    const connection = useConnectionStore
      .getState()
      .connections.find((item) => item.id === connectionId)
    if (connection?.path) {
      return {
        worktreePath: connection.path,
        opencodeSessionId: session.opencode_session_id
      }
    }
  }

  return null
}

function findBackgroundTelemetrySession(sessionId: string): BackgroundTelemetrySession | null {
  const sessionState = useSessionStore.getState()

  for (const [worktreeId, sessions] of sessionState.sessionsByWorktree) {
    const found = sessions.find((session) => session.id === sessionId) as
      | BackgroundTelemetrySession
      | undefined
    if (found) {
      return {
        ...found,
        worktree_id: found.worktree_id ?? worktreeId
      }
    }
  }

  for (const [connectionId, sessions] of sessionState.sessionsByConnection) {
    const found = sessions.find((session) => session.id === sessionId) as
      | BackgroundTelemetrySession
      | undefined
    if (found) {
      return {
        ...found,
        connection_id: found.connection_id ?? connectionId
      }
    }
  }

  return null
}

async function resolvePromptDispatchContext(
  sessionId: string
): Promise<PromptDispatchContext | null> {
  const storeContext = resolvePromptDispatchContextFromStores(sessionId)

  try {
    const dbSession = await dbApi.session.get<PromptDispatchDbSession>(sessionId)

    const dbOpcSessionId = dbSession?.opencode_session_id ?? null
    if (!dbOpcSessionId) {
      return storeContext
    }

    if (dbSession?.worktree_id) {
      const dbWorktree = await dbApi.worktree.get(dbSession.worktree_id)
      if (dbWorktree?.path) {
        return {
          worktreePath: dbWorktree.path,
          opencodeSessionId: dbOpcSessionId
        }
      }
    }

    if (dbSession?.connection_id) {
      const connectionResult = await connectionApi.get(dbSession.connection_id)
      if (connectionResult.success && connectionResult.connection?.path) {
        return {
          worktreePath: connectionResult.connection.path,
          opencodeSessionId: dbOpcSessionId
        }
      }
    }

    if (storeContext) {
      return { ...storeContext, opencodeSessionId: dbOpcSessionId }
    }
  } catch {
    // DB lookup failed — fall through to store context
  }

  return storeContext
}

function markBackgroundSessionCompleted(sessionId: string): void {
  const sendTime = messageSendTimes.get(sessionId)
  const durationMs = sendTime ? Date.now() - sendTime : 0
  const word = COMPLETION_WORDS[Math.floor(Math.random() * COMPLETION_WORDS.length)]
  const tokenDelta = computeTokenDelta(sessionId)
  recordHivePromptIdleForSession(sessionId)
  useWorktreeStatusStore
    .getState()
    .setSessionStatus(sessionId, 'completed', { word, durationMs, tokenDelta })

  const now = Date.now()
  const sessions = useSessionStore.getState().sessionsByWorktree
  let found = false
  for (const [worktreeId, wSessions] of sessions) {
    if (wSessions.some((s) => s.id === sessionId)) {
      bumpWorktreeLastMessage({ worktreeId, timestamp: now })
      useRecentStore.getState().addWorktreeToRecent(worktreeId)
      found = true
      break
    }
  }

  const connectionSessions = useSessionStore.getState().sessionsByConnection
  let completedConnectionId: string | null = null
  for (const [connectionId, cSessions] of connectionSessions) {
    if (cSessions.some((s) => s.id === sessionId)) {
      useRecentStore.getState().addConnectionToRecent(connectionId)
      completedConnectionId = connectionId
      break
    }
  }

  if (!found && completedConnectionId) {
    bumpWorktreeLastMessage({ connectionId: completedConnectionId, timestamp: now })
  }
}

function hasOutstandingBlockingInteraction(sessionId: string): boolean {
  if (useSessionStore.getState().getPendingPlan(sessionId)) return true
  if (useQuestionStore.getState().getQuestions(sessionId).length > 0) return true
  if (usePermissionStore.getState().getPermissions(sessionId).length > 0) return true
  if (useCommandApprovalStore.getState().getApprovals(sessionId).length > 0) return true
  return false
}

function restoreSessionRunningStatus(sessionId: string, modeOverride?: 'build' | 'plan'): void {
  if (hasOutstandingBlockingInteraction(sessionId)) return
  const mode = modeOverride ?? useSessionStore.getState().getSessionMode(sessionId)
  useWorktreeStatusStore
    .getState()
    .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')
}

/**
 * Persistent global listener for OpenCode stream events.
 *
 * The main process now owns stream persistence into SQLite.
 * This listener handles:
 * - Unread status for sessions that finish in background
 * - Title updates for background sessions (active session handled by SessionView)
 * - Branch auto-rename notifications from the main process
 */
export function useOpenCodeGlobalListener(): void {
  // Listen for branch auto-rename events from the main process
  useEffect(() => {
    const unsubscribe = worktreeApi.onBranchRenamed((data) => {
      const { worktreeId, newBranch, worktreePath } = data
      useWorktreeStore.getState().updateWorktreeBranch(worktreeId, newBranch)
      // The displayed name prefers the live branch info from the git store —
      // refresh it so the rename shows without waiting for a watcher event.
      if (worktreePath) {
        void useGitStore.getState().loadBranchInfo(worktreePath, { force: true })
      }
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = worktreeApi.onWorktreeCreated((data) => {
      const { projectId, worktree } = data
      useWorktreeStore.getState().addWorktreeToProject(projectId, worktree)
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = opencodeApi.onStream((event) => {
      const sessionId = event.sessionId
      // When the kanban board is showing, SessionView isn't mounted —
      // treat the "active" session as a background session so the global
      // listener handles its status badges, completion, permissions, etc.
      const rawActiveId = useSessionStore.getState().activeSessionId
      const activeId = useKanbanStore.getState().isBoardViewActive ? null : rawActiveId

      // Handle session materialization globally so the Zustand store
      // is always up-to-date with the real SDK session ID.  Without this,
      // sessions created via the kanban board (where SessionView / useSessionStream
      // are never mounted) keep their placeholder `pending::UUID` ID forever,
      // and reconnect / getMessages fail because the backend uses the real ID.
      if (event.type === 'session.materialized') {
        const newId = (event.data as Record<string, unknown> | undefined)?.newSessionId as
          | string
          | undefined
        if (newId) {
          useSessionStore.getState().setOpenCodeSessionId(sessionId, newId)
        }
        return
      }

      // First user prompt in a terminal-backed Claude CLI session — captured in
      // the main process by the UserPromptSubmit hook (covers prompts typed
      // straight into the terminal as well as composer/handoff prompts). The
      // renderer creation helper applies the setting gate, exclusions and the
      // idempotency check (so a ticket-originated CLI session is skipped).
      if (event.type === 'claude-cli.first-prompt-detected') {
        const promptText = (event.data as { promptText?: unknown } | undefined)?.promptText
        if (typeof promptText === 'string') {
          notifyKanbanAutoCreateTicket({ sessionId, rawPrompt: promptText })
        }
        return
      }

      // Handle model limits from Claude Code session init
      if (event.type === 'session.model_limits') {
        const models = event.data?.models as
          | Array<{ modelID: string; providerID: string; contextLimit: number }>
          | undefined
        if (models) {
          for (const m of models) {
            if (m.contextLimit > 0) {
              useContextStore.getState().setModelLimit(m.modelID, m.contextLimit, m.providerID)
              // Also store as wildcard so the limit is found regardless
              // of the session's providerID (e.g. "claude-code" vs "anthropic")
              useContextStore.getState().setModelLimit(m.modelID, m.contextLimit)
            }
          }
        }
        return
      }

      // Handle context usage from Codex sessions
      if (event.type === 'session.context_usage') {
        const { tokens, model, contextWindow } = event.data as {
          tokens: TokenInfo
          model: SessionModelRef
          contextWindow: number
        }
        useContextStore.getState().setSessionTokens(sessionId, tokens, model)
        if (contextWindow > 0 && model) {
          useContextStore.getState().setModelLimit(model.modelID, contextWindow, model.providerID)
          useContextStore.getState().setModelLimit(model.modelID, contextWindow)
        }
        return
      }

      if (event.type === 'session.rate_limit') {
        useUsageStore.getState().setAnthropicRateLimit(event.data as AnthropicRateLimitInfo)
        return
      }

      // Handle context compaction from Codex sessions
      if (event.type === 'session.context_compacted') {
        useContextStore.getState().clearSessionTokenSnapshot(sessionId)
        return
      }

      // Handle message.updated for background sessions — extract title + tokens
      if (event.type === 'message.updated' && sessionId !== activeId) {
        // Child/subagent message.updated events are metadata for nested work;
        // do not use them for parent context/cost snapshots.
        if (event.childSessionId) {
          return
        }

        const sessionTitle = event.data?.info?.title || event.data?.title
        // Skip OpenCode default placeholder titles like "New session - 2026-02-12T21:33:03.013Z"
        const isOpenCodeDefault = /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(sessionTitle || '')
        if (sessionTitle && !isOpenCodeDefault) {
          useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
        }

        // Extract tokens for background sessions
        const info = event.data?.info
        if (info?.time?.completed) {
          const data = event.data as Record<string, unknown> | undefined
          if (data) {
            const tokens = extractTokens(data)
            if (tokens) {
              const modelRef = extractModelRef(data) ?? undefined
              useContextStore.getState().setSessionTokens(sessionId, tokens, modelRef)
            }
            const cost = extractCost(data)
            if (cost > 0) {
              useContextStore.getState().addSessionCost(sessionId, cost)
            }
            // Extract per-model usage (from SDK result messages) to update context limits
            const modelUsageEntries = extractModelUsage(data)
            if (modelUsageEntries) {
              for (const entry of modelUsageEntries) {
                if (entry.contextWindow > 0) {
                  useContextStore.getState().setModelLimit(entry.modelName, entry.contextWindow)
                }
              }
            }
          }
        }
        return
      }

      // session.updated — sync title for both background and active sessions.
      // ClaudeCliSessionView has no stream listener of its own, so active
      // claude-cli renames need to flow through the global listener.
      if (event.type === 'session.updated') {
        const rawTitle = event.data?.info?.title || event.data?.title
        const sessionTitle = rawTitle ? maybeExtractJsonTitle(rawTitle) : rawTitle
        const isOpenCodeDefault = /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(sessionTitle || '')
        if (sessionTitle && !isOpenCodeDefault) {
          useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
        }
        return
      }

      // Handle question events for all sessions (catch-all; SessionView also handles active session)
      if (event.type === 'question.asked') {
        const request = event.data
        if (request?.id && request?.questions) {
          useQuestionStore.getState().addQuestion(sessionId, request)
          // Only set status badge for background sessions; active session manages its own
          if (sessionId !== activeId) {
            useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'answering')
          }
        }
        return
      }

      if (event.type === 'question.replied' || event.type === 'question.rejected') {
        const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
        if (requestId) {
          useQuestionStore.getState().removeQuestion(sessionId, requestId)
          restoreSessionRunningStatus(sessionId)
        }
        return
      }

      // Handle permission events for all sessions (catch-all; SessionView also handles active session)
      if (event.type === 'permission.asked') {
        const request = event.data
        if (request?.id && request?.permission) {
          const { commandFilter } = useSettingsStore.getState()
          const isAutoApprovable =
            !commandFilter.enabled ||
            checkAutoApprove(request as PermissionRequest, commandFilter.allowlist)

          if (isAutoApprovable) {
            // Background: auto-approve directly
            if (sessionId !== activeId) {
              opencodeApi.permissionReply(request.id, 'once', undefined).catch((err: unknown) => {
                console.warn('Auto-approve permissionReply (background) failed:', err)
              })
            }
            // Active: SessionView handles auto-approve with worktreePath; skip store
            return
          }
          // Not auto-approvable: add to store so modal appears (dedup-safe)
          usePermissionStore.getState().addPermission(sessionId, request)
          if (sessionId !== activeId) {
            useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'permission')
          }
        }
        return
      }

      if (event.type === 'permission.replied') {
        const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
        if (requestId) {
          usePermissionStore.getState().removePermission(sessionId, requestId)
          restoreSessionRunningStatus(sessionId)
        }
        return
      }

      // Handle command approval events for all sessions (catch-all; SessionView also handles active session)
      if (event.type === 'command.approval_needed') {
        const request = event.data
        if (request?.id && request?.toolName) {
          const { commandFilter } = useSettingsStore.getState()

          if (!commandFilter.enabled) {
            // Background: auto-approve directly when security is disabled
            if (sessionId !== activeId) {
              opencodeApi.commandApprovalReply(request.id, true).catch((err: unknown) => {
                console.warn('Auto-approve commandApprovalReply (background) failed:', err)
              })
            }
            // Active: SessionView handles auto-approve; skip store
            return
          }
          // Security enabled: add to store so dialog appears (dedup-safe)
          useCommandApprovalStore.getState().addApproval(sessionId, request)
          if (sessionId !== activeId) {
            useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'command_approval')
          }
        }
        return
      }

      // Handle command approval replies for all sessions
      if (event.type === 'command.approval_replied') {
        const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
        if (requestId) {
          useCommandApprovalStore.getState().removeApproval(sessionId, requestId)
          restoreSessionRunningStatus(sessionId)
        }
        return
      }

      if (event.type === 'codex.goal.updated') {
        const data = event.data as Record<string, unknown> | undefined
        const goal = (data?.goal ?? null) as CodexThreadGoal | null
        if (goal && typeof goal === 'object') {
          useSessionStore.getState().setCodexGoal(sessionId, goal)
        }
        return
      }

      if (event.type === 'codex.goal.cleared') {
        useSessionStore.getState().clearCodexGoal(sessionId)
        return
      }

      // Handle plan approval events globally so pending state survives tab switches.
      if (event.type === 'plan.ready') {
        const data = event.data as
          | { id?: string; requestId?: string; plan?: string; toolUseID?: string }
          | undefined
        const requestId = data?.id || data?.requestId
        if (requestId) {
          useSessionStore.getState().setPendingPlan(sessionId, {
            requestId,
            planContent: data?.plan ?? '',
            toolUseID: data?.toolUseID ?? ''
          })
          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
        }
        return
      }

      if (event.type === 'plan.resolved') {
        const data = event.data as
          | {
              approved?: boolean
              resolution?: 'implement' | 'handoff' | 'feedback'
            }
          | undefined
        useSessionStore.getState().clearPendingPlan(sessionId)

        if (data?.resolution === 'handoff') {
          useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
          return
        }

        if (data?.approved === true) {
          lastSendMode.set(sessionId, 'build')
          void useSessionStore.getState().setSessionMode(sessionId, 'build')
          notifyKanbanSessionSync(sessionId, { type: 'implement' })
          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
          return
        }

        if (data?.approved === false) {
          lastSendMode.set(sessionId, 'plan')
          restoreSessionRunningStatus(sessionId, 'plan')
          return
        }

        const current = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
        if (current?.status === 'plan_ready') {
          restoreSessionRunningStatus(sessionId)
        }
        return
      }

      // Use session.status (not deprecated session.idle) as the authoritative signal
      if (event.type !== 'session.status') return

      const status = event.statusPayload || event.data?.status

      // Background session became busy again — restore working/planning status
      if (status?.type === 'busy') {
        // Don't overwrite plan_ready — session is blocked waiting for plan approval
        if (useSessionStore.getState().getPendingPlan(sessionId)) return

        // Don't overwrite blocking statuses (command approval, permission, or a
        // still-pending question) — the session is waiting on the user.
        const currentStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
        if (
          shouldPreserveBlockingSessionStatus(
            currentStatus?.status,
            useQuestionStore.getState().getQuestions(sessionId).length > 0
          )
        )
          return

        if (sessionId !== activeId) {
          const currentMode = useSessionStore.getState().getSessionMode(sessionId)
          useWorktreeStatusStore
            .getState()
            .setSessionStatus(sessionId, isPlanLike(currentMode) ? 'planning' : 'working')
        }

        // Always track recent activity so data is fresh when toggled on (Fix #6)
        const wSessions = useSessionStore.getState().sessionsByWorktree
        for (const [worktreeId, sessions] of wSessions) {
          if (sessions.some((s) => s.id === sessionId)) {
            useRecentStore.getState().addWorktreeToRecent(worktreeId)
            break
          }
        }
        const cSessions = useSessionStore.getState().sessionsByConnection
        for (const [connectionId, sessions] of cSessions) {
          if (sessions.some((s) => s.id === sessionId)) {
            useRecentStore.getState().addConnectionToRecent(connectionId)
            break
          }
        }

        return
      }

      if (status?.type !== 'idle') return

      const { usageIndicatorMode, usageIndicatorProviders } = useSettingsStore.getState()
      const usageEnabled =
        usageIndicatorMode === 'current-agent' ||
        (usageIndicatorMode === 'specific-providers' && usageIndicatorProviders.length > 0)
      if (usageEnabled) {
        const sessionState = useSessionStore.getState()
        let idleSession: {
          agent_sdk?: string | null
          custom_provider_id?: string | null
          model_provider_id?: string | null
          model_id?: string | null
        } | null = null
        for (const sessions of sessionState.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === sessionId)
          if (found) {
            idleSession = found
            break
          }
        }
        if (!idleSession) {
          for (const sessions of sessionState.sessionsByConnection.values()) {
            const found = sessions.find((s) => s.id === sessionId)
            if (found) {
              idleSession = found
              break
            }
          }
        }
        if (!idleSession) {
          for (const session of sessionState.boardAssistantByProject.values()) {
            if (session.id === sessionId) {
              idleSession = session
              break
            }
          }
        }
        if (idleSession) {
          const provider = resolveUsageProvider(idleSession)
          if (provider) {
            useUsageStore.getState().fetchUsageForProvider(provider)
          }
        } else {
          useUsageStore.getState().fetchUsage()
        }
      }

      // Don't overwrite plan_ready — session is blocked waiting for plan approval
      if (useSessionStore.getState().getPendingPlan(sessionId)) return

      // Don't overwrite blocking statuses (command approval, permission, or a
      // still-pending question) — the session is waiting on the user.
      const statusForIdle = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
      if (
        shouldPreserveBlockingSessionStatus(
          statusForIdle?.status,
          useQuestionStore.getState().getQuestions(sessionId).length > 0
        )
      )
        return

      // Active session is handled by SessionView.
      if (sessionId === activeId) return

      void handleSessionIdleFollowUp({
        sessionId,
        isBlocked: () => {
          if (useSessionStore.getState().getPendingPlan(sessionId)) return true
          const current = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
          return shouldPreserveBlockingSessionStatus(
            current?.status,
            useQuestionStore.getState().getQuestions(sessionId).length > 0
          )
        },
        dequeueFollowUp: () => useSessionStore.getState().dequeueFollowUpMessage(sessionId),
        requeueFollowUp: (message) =>
          useSessionStore.getState().requeueFollowUpMessageFront(sessionId, message),
        onBeforeDispatch: (message) => {
          recordHivePromptIdleForSession(sessionId)
          messageSendTimes.set(sessionId, Date.now())
          snapshotTokenBaseline(sessionId)
          const mode = useSessionStore.getState().getSessionMode(sessionId)
          const session = findBackgroundTelemetrySession(sessionId)
          startHivePromptTelemetry({
            sessionId,
            prompt: message,
            worktreeId: session?.worktree_id,
            modelId: session?.model_id,
            providerId: session?.model_provider_id,
            modelVariant: session?.model_variant,
            mode,
            // Background follow-up-queue drain for a non-active session.
            source: 'other'
          })
          lastSendMode.set(sessionId, isPlanLike(mode) ? 'plan' : 'build')
          useWorktreeStatusStore
            .getState()
            .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')
        },
        dispatchFollowUp: async (message) => {
          const context = await resolvePromptDispatchContext(sessionId)
          if (!context) return false
          if (context.opencodeSessionId.startsWith('pending::')) return false

          const result = unwrapEnvelope(
            await opencodeApi.prompt(context.worktreePath, context.opencodeSessionId, [
              { type: 'text', text: message }
            ])
          )

          return result.success
        },
        onDispatchFailure: () => {
          markBackgroundSessionCompleted(sessionId)
        },
        onComplete: () => {
          markBackgroundSessionCompleted(sessionId)
        }
      })
    })

    return unsubscribe
  }, [])
}
