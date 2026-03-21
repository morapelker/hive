import { useEffect, useRef } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { usePermissionStore } from '@/stores/usePermissionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useContextStore, type TokenInfo, type SessionModelRef } from '@/stores/useContextStore'
import { useRecentStore } from '@/stores/useRecentStore'
import { useUsageStore, resolveUsageProvider } from '@/stores'
import { extractTokens, extractCost, extractModelRef, extractModelUsage } from '@/lib/token-utils'
import { COMPLETION_WORDS } from '@/lib/format-utils'
import { messageSendTimes } from '@/lib/message-send-times'
import { checkAutoApprove } from '@/lib/permissionUtils'

interface PromptDispatchContext {
  worktreePath: string
  opencodeSessionId: string
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

async function resolvePromptDispatchContext(
  sessionId: string
): Promise<PromptDispatchContext | null> {
  const storeContext = resolvePromptDispatchContextFromStores(sessionId)

  if (!window.db?.session?.get) {
    return storeContext
  }

  try {
    const dbSession = (await window.db.session.get(sessionId)) as {
      worktree_id?: string | null
      connection_id?: string | null
      opencode_session_id?: string | null
    } | null

    const dbOpcSessionId = dbSession?.opencode_session_id ?? null
    if (!dbOpcSessionId) {
      return storeContext
    }

    if (dbSession?.worktree_id && window.db?.worktree?.get) {
      const dbWorktree = (await window.db.worktree.get(dbSession.worktree_id)) as {
        path?: string | null
      } | null
      if (dbWorktree?.path) {
        return {
          worktreePath: dbWorktree.path,
          opencodeSessionId: dbOpcSessionId
        }
      }
    }

    if (dbSession?.connection_id && window.connectionOps?.get) {
      const connectionResult = await window.connectionOps.get(dbSession.connection_id)
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
  useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'completed', { word, durationMs })

  const now = Date.now()
  const sessions = useSessionStore.getState().sessionsByWorktree
  let found = false
  for (const [worktreeId, wSessions] of sessions) {
    if (wSessions.some((s) => s.id === sessionId)) {
      useWorktreeStatusStore.getState().setLastMessageTime(worktreeId, now)
      useRecentStore.getState().addWorktreeToRecent(worktreeId)
      found = true
      break
    }
  }

  const connectionSessions = useSessionStore.getState().sessionsByConnection
  for (const [connectionId, cSessions] of connectionSessions) {
    if (cSessions.some((s) => s.id === sessionId)) {
      useRecentStore.getState().addConnectionToRecent(connectionId)
      break
    }
  }

  if (!found) {
    const connSessions = useSessionStore.getState().sessionsByConnection
    for (const [connectionId, cSessions] of connSessions) {
      if (cSessions.some((s) => s.id === sessionId)) {
        const connection = useConnectionStore
          .getState()
          .connections.find((c) => c.id === connectionId)
        if (connection) {
          for (const member of connection.members) {
            useWorktreeStatusStore.getState().setLastMessageTime(member.worktree_id, now)
          }
        }
        break
      }
    }
  }
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
  const backgroundFollowUpDispatchingRef = useRef<Set<string>>(new Set())
  const deferredIdleWhileDispatchingRef = useRef<Set<string>>(new Set())

  // Listen for branch auto-rename events from the main process
  useEffect(() => {
    const unsubscribe = window.worktreeOps?.onBranchRenamed
      ? window.worktreeOps.onBranchRenamed((data) => {
          const { worktreeId, newBranch } = data
          useWorktreeStore.getState().updateWorktreeBranch(worktreeId, newBranch)
        })
      : () => {}

    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.opencodeOps?.onStream
      ? window.opencodeOps.onStream((event) => {
          const sessionId = event.sessionId
          const activeId = useSessionStore.getState().activeSessionId

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
              useContextStore
                .getState()
                .setModelLimit(model.modelID, contextWindow, model.providerID)
              useContextStore.getState().setModelLimit(model.modelID, contextWindow)
            }
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
            const isOpenCodeDefault = /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(
              sessionTitle || ''
            )
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

          // Keep session.updated for background title sync (some events use this type)
          if (event.type === 'session.updated' && sessionId !== activeId) {
            const sessionTitle = event.data?.info?.title || event.data?.title
            // Skip OpenCode default placeholder titles like "New session - 2026-02-12T21:33:03.013Z"
            const isOpenCodeDefault = /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(
              sessionTitle || ''
            )
            if (sessionTitle && !isOpenCodeDefault) {
              useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
            }
            return
          }

          // Handle question events for background sessions
          if (event.type === 'question.asked' && sessionId !== activeId) {
            const request = event.data
            if (request?.id && request?.questions) {
              useQuestionStore.getState().addQuestion(sessionId, request)
              useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'answering')
            }
            return
          }

          if (
            (event.type === 'question.replied' || event.type === 'question.rejected') &&
            sessionId !== activeId
          ) {
            const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
            if (requestId) {
              useQuestionStore.getState().removeQuestion(sessionId, requestId)
            }
            return
          }

          // Handle permission events for background sessions
          if (event.type === 'permission.asked' && sessionId !== activeId) {
            const request = event.data
            if (request?.id && request?.permission) {
              const { commandFilter } = useSettingsStore.getState()
              // Security globally off OR all sub-patterns in commandFilter allowlist → auto-approve
              if (
                !commandFilter.enabled ||
                checkAutoApprove(request as PermissionRequest, commandFilter.allowlist)
              ) {
                window.opencodeOps
                  .permissionReply(request.id, 'once', undefined)
                  .catch((err: unknown) => {
                    console.warn('Auto-approve permissionReply (background) failed:', err)
                  })
                return
              }
              usePermissionStore.getState().addPermission(sessionId, request)
              useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'permission')
            }
            return
          }

          if (event.type === 'permission.replied' && sessionId !== activeId) {
            const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
            if (requestId) {
              usePermissionStore.getState().removePermission(sessionId, requestId)
              // Revert to working/planning if no more pending permissions
              const remaining = usePermissionStore.getState().pendingBySession.get(sessionId)
              if (!remaining || remaining.length === 0) {
                const mode = useSessionStore.getState().getSessionMode(sessionId)
                useWorktreeStatusStore
                  .getState()
                  .setSessionStatus(sessionId, mode === 'plan' ? 'planning' : 'working')
              }
            }
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
            useSessionStore.getState().clearPendingPlan(sessionId)
            // If session is no longer busy/planning, clear stale plan_ready badge.
            const current = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
            if (current?.status === 'plan_ready') {
              useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
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

            if (sessionId !== activeId) {
              const currentMode = useSessionStore.getState().getSessionMode(sessionId)
              useWorktreeStatusStore
                .getState()
                .setSessionStatus(sessionId, currentMode === 'plan' ? 'planning' : 'working')
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

          if (useSettingsStore.getState().showUsageIndicator) {
            const sessionState = useSessionStore.getState()
            let idleSession: {
              agent_sdk?: string | null
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
            if (idleSession) {
              const provider = resolveUsageProvider(idleSession)
              useUsageStore.getState().fetchUsageForProvider(provider)
            } else {
              useUsageStore.getState().fetchUsage()
            }
          }

          // Don't overwrite plan_ready — session is blocked waiting for plan approval
          if (useSessionStore.getState().getPendingPlan(sessionId)) return

          // Active session is handled by SessionView.
          if (sessionId === activeId) return

          const dispatchBackgroundFollowUp = (message: string): void => {
            backgroundFollowUpDispatchingRef.current.add(sessionId)

            void (async () => {
              let dispatchSucceeded = false
              try {
                const context = await resolvePromptDispatchContext(sessionId)
                if (!context || !window.opencodeOps?.prompt) {
                  useSessionStore.getState().requeueFollowUpMessageFront(sessionId, message)
                  markBackgroundSessionCompleted(sessionId)
                  return
                }

                if (context.opencodeSessionId.startsWith('pending::')) {
                  useSessionStore.getState().requeueFollowUpMessageFront(sessionId, message)
                  markBackgroundSessionCompleted(sessionId)
                  return
                }

                const mode = useSessionStore.getState().getSessionMode(sessionId)
                useWorktreeStatusStore
                  .getState()
                  .setSessionStatus(sessionId, mode === 'plan' ? 'planning' : 'working')

                const result = await window.opencodeOps.prompt(
                  context.worktreePath,
                  context.opencodeSessionId,
                  [{ type: 'text', text: message }]
                )

                if (!result.success) {
                  useSessionStore.getState().requeueFollowUpMessageFront(sessionId, message)
                  markBackgroundSessionCompleted(sessionId)
                  return
                }

                dispatchSucceeded = true
              } catch {
                useSessionStore.getState().requeueFollowUpMessageFront(sessionId, message)
                markBackgroundSessionCompleted(sessionId)
              } finally {
                backgroundFollowUpDispatchingRef.current.delete(sessionId)

                if (!deferredIdleWhileDispatchingRef.current.has(sessionId)) {
                  return
                }

                deferredIdleWhileDispatchingRef.current.delete(sessionId)

                // If dispatch failed, we've already requeued + set completed above.
                if (!dispatchSucceeded) return

                // Don't overwrite plan_ready — session is blocked waiting for plan approval
                if (useSessionStore.getState().getPendingPlan(sessionId)) return

                const nextFollowUp = useSessionStore.getState().dequeueFollowUpMessage(sessionId)
                if (nextFollowUp) {
                  dispatchBackgroundFollowUp(nextFollowUp)
                  return
                }

                markBackgroundSessionCompleted(sessionId)
              }
            })()
          }

          // Background queued follow-ups should be dispatched here so they survive tab switches.
          if (backgroundFollowUpDispatchingRef.current.has(sessionId)) {
            deferredIdleWhileDispatchingRef.current.add(sessionId)
            return
          }

          const followUp = useSessionStore.getState().dequeueFollowUpMessage(sessionId)
          if (followUp) {
            dispatchBackgroundFollowUp(followUp)

            return
          }

          markBackgroundSessionCompleted(sessionId)
        })
      : () => {}

    return unsubscribe
  }, [])
}
