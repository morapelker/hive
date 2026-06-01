import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TerminalView, type TerminalViewHandle } from '@/components/terminal/TerminalView'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { useSessionStore, BOARD_TAB_ID } from '@/stores/useSessionStore'
import {
  isProviderSwitchBlockingSessionStatus,
  useWorktreeStatusStore
} from '@/stores/useWorktreeStatusStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useTelegramStore } from '@/stores/useTelegramStore'
import { useClaudeCliSessionPortal } from '@/contexts/ClaudeCliSessionPortalContext'
import { ModeToggle } from './ModeToggle'
import { SuperToggle } from './SuperToggle'
import { SessionProviderSelector } from './SessionProviderSelector'
import { useDurableSessionHistory } from './useDurableSessionHistory'
import { QuestionPrompt } from './QuestionPrompt'
import { ClaudeCliEndedOverlay } from './ClaudeCliEndedOverlay'
import { HandoffSplitButton } from './HandoffSplitButton'
import { buildHandoffPrompt, type HandoffSelectionOverride } from '@/lib/handoffSelection'
import { lastSendMode } from '@/lib/message-send-times'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { startBackgroundSessionPrompt } from '@/lib/backgroundSessionStart'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { extractPlanTitle } from '@shared/types/branch-utils'
import '@xterm/xterm/css/xterm.css'
import '@/styles/xterm.css'
import { toHandoffAgentSdk } from '@shared/types/agent-sdk'

interface ClaudeCliSessionViewProps {
  sessionId: string
  isVisible?: boolean
}

type PlanCardPosition = { left: number; top: number }

const PLAN_CARD_POSITION_KEY = 'hive.claudeCliPlanReadyCard.position'

function loadPlanCardPosition(): PlanCardPosition | null {
  try {
    const raw = localStorage.getItem(PLAN_CARD_POSITION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PlanCardPosition>
    if (typeof parsed.left !== 'number' || typeof parsed.top !== 'number') return null
    return parsed as PlanCardPosition
  } catch {
    return null
  }
}

function savePlanCardPosition(position: PlanCardPosition): void {
  localStorage.setItem(PLAN_CARD_POSITION_KEY, JSON.stringify(position))
}

function findWorktreePathById(worktreeId: string): string | null {
  for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
    const found = worktrees.find((worktree) => worktree.id === worktreeId)
    if (found) return found.path
  }
  return null
}

function findConnectionPathById(connectionId: string): string | null {
  return (
    useConnectionStore.getState().connections.find((connection) => connection.id === connectionId)
      ?.path ?? null
  )
}

async function startTicketModalHandoffSession(opts: {
  sessionId: string
  agentSdk: string
  handoffPrompt: string
  worktreeId?: string | null
  connectionId?: string | null
  worktreePath?: string | null
}): Promise<void> {
  if (opts.agentSdk === 'claude-code-cli') {
    bumpWorktreeLastMessage({
      worktreeId: opts.worktreeId,
      connectionId: opts.connectionId
    })
    const result = unwrapEnvelope(
      await window.terminalOps.createClaudeCli(opts.sessionId, {
        pendingPrompt: opts.handoffPrompt
      })
    )
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to start Claude CLI handoff')
    }
    if (opts.handoffPrompt) {
      useSessionStore.getState().dequeuePendingMessage(opts.sessionId)
    }
    return
  }

  if (!opts.worktreePath) {
    throw new Error('Could not find handoff working path')
  }

  await startBackgroundSessionPrompt({
    worktreePath: opts.worktreePath,
    sessionId: opts.sessionId,
    prompt: opts.handoffPrompt,
    bumpTarget: {
      worktreeId: opts.worktreeId,
      connectionId: opts.connectionId
    }
  })
}

function clampPlanCardPosition(
  position: PlanCardPosition,
  container: DOMRect,
  card: DOMRect
): PlanCardPosition {
  return {
    left: Math.max(8, Math.min(position.left, container.width - card.width - 8)),
    top: Math.max(8, Math.min(position.top, container.height - card.height - 8))
  }
}

interface ClaudeCliPlanReadyCardProps {
  planContent: string
  worktreeId?: string
  onHandoff: (override: HandoffSelectionOverride) => void
  onSaveAsTicket: () => void
  savedAsTicket: boolean
}

function ClaudeCliPlanReadyCard({
  planContent,
  worktreeId,
  onHandoff,
  onSaveAsTicket,
  savedAsTicket
}: ClaudeCliPlanReadyCardProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    pointerId: number
    offsetX: number
    offsetY: number
  } | null>(null)
  const [position, setPosition] = useState<PlanCardPosition | null>(() => loadPlanCardPosition())

  const preview = planContent.trim().split('\n').find(Boolean) ?? 'Plan ready'

  // Clamp a persisted position against the current container on mount. A
  // position saved while the window was larger could otherwise place the card
  // (and its Handoff / Save-as-ticket buttons) off-screen until the user
  // happens to drag it back. Runs once on mount (before paint to avoid a flash);
  // re-clamping on every position change would fight an in-progress drag.
  useLayoutEffect(() => {
    if (!position) return
    const container = containerRef.current?.getBoundingClientRect()
    const card = cardRef.current?.getBoundingClientRect()
    if (!container || !card) return
    const clamped = clampPlanCardPosition(position, container, card)
    if (clamped.left !== position.left || clamped.top !== position.top) {
      setPosition(clamped)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const moveToPointer = useCallback((clientX: number, clientY: number): void => {
    const container = containerRef.current?.getBoundingClientRect()
    const card = cardRef.current?.getBoundingClientRect()
    const drag = dragRef.current
    if (!container || !card || !drag) return

    setPosition(
      clampPlanCardPosition(
        {
          left: clientX - container.left - drag.offsetX,
          top: clientY - container.top - drag.offsetY
        },
        container,
        card
      )
    )
  }, [])

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-20">
      <div
        ref={cardRef}
        data-testid="claude-cli-plan-ready-card"
        className={cn(
          'pointer-events-auto absolute w-[min(520px,calc(100%-32px))]',
          'rounded-lg border border-border bg-background/95 p-3 shadow-xl backdrop-blur',
          position ? '' : 'bottom-4 right-4'
        )}
        style={position ? { left: position.left, top: position.top } : undefined}
      >
        <div
          className="mb-3 cursor-grab select-none active:cursor-grabbing"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            const container = containerRef.current?.getBoundingClientRect()
            const card = cardRef.current?.getBoundingClientRect()
            if (!container || !card) return

            const current = clampPlanCardPosition(
              {
                left: card.left - container.left,
                top: card.top - container.top
              },
              container,
              card
            )
            setPosition(current)
            dragRef.current = {
              pointerId: event.pointerId,
              offsetX: event.clientX - card.left,
              offsetY: event.clientY - card.top
            }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return
            moveToPointer(event.clientX, event.clientY)
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return
            dragRef.current = null
            const card = cardRef.current?.getBoundingClientRect()
            const container = containerRef.current?.getBoundingClientRect()
            if (card && container) {
              savePlanCardPosition(
                clampPlanCardPosition(
                  {
                    left: card.left - container.left,
                    top: card.top - container.top
                  },
                  container,
                  card
                )
              )
            }
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return
            dragRef.current = null
          }}
        >
          <div className="text-sm font-semibold text-foreground">Plan ready</div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{preview}</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <HandoffSplitButton
            worktreeId={worktreeId}
            onHandoff={onHandoff}
            testIdPrefix="claude-cli-plan-ready"
          />
          <button
            type="button"
            onClick={onSaveAsTicket}
            disabled={savedAsTicket}
            className={cn(
              'h-8 rounded-full border border-border bg-muted/80 px-3 text-xs font-medium',
              'text-foreground shadow-md transition-colors hover:bg-muted',
              'disabled:pointer-events-none disabled:opacity-60'
            )}
            data-testid="claude-cli-plan-ready-save-ticket"
          >
            {savedAsTicket ? 'Saved as ticket' : 'Save as ticket'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ClaudeCliSessionView({
  sessionId,
  isVisible = true
}: ClaudeCliSessionViewProps): React.JSX.Element {
  const terminalRef = useRef<TerminalViewHandle>(null)
  const [terminalKey, setTerminalKey] = useState(0)
  const [ended, setEnded] = useState(false)
  const [planSavedAsTicket, setPlanSavedAsTicket] = useState(false)
  const pendingMessage = useSessionStore((state) => state.pendingMessages.get(sessionId) ?? null)
  const pendingPlan = useSessionStore((state) => state.pendingPlans.get(sessionId) ?? null)
  const mode = useSessionStore((state) => state.modeBySession.get(sessionId) ?? 'build')
  const pendingFollowUpMessages =
    useSessionStore((state) => state.pendingFollowUpMessages.get(sessionId)) ?? []
  const sessionStatus = useWorktreeStatusStore((state) => state.sessionStatuses[sessionId] ?? null)
  const { getTarget, revision: portalRevision } = useClaudeCliSessionPortal()
  void portalRevision
  const isMountedInTicketModal = !!getTarget(sessionId)
  const sessionRecord = useSessionStore((state) => state.getSessionById(sessionId))
  const selectableAgentSdk = toHandoffAgentSdk(sessionRecord?.agent_sdk)
  const hasDurableHistory = useDurableSessionHistory(sessionId)

  // While Telegram forwarding is active, AskUserQuestion is intercepted by the
  // hook bridge (so it never renders in the terminal) and surfaced through the
  // shared question store. Render the same in-app QuestionPrompt the SDK
  // providers use; when forwarding is off the question shows natively in the CLI.
  const activeQuestion = useQuestionStore((state) => state.getActiveQuestion(sessionId))
  const isForwarding = useTelegramStore((state) => state.activeForwardingSessionId === sessionId)

  const canChangeBlankSessionProvider =
    !!selectableAgentSdk &&
    sessionRecord?.session_type === 'default' &&
    !hasDurableHistory &&
    !pendingMessage &&
    pendingFollowUpMessages.length === 0 &&
    !pendingPlan &&
    !isProviderSwitchBlockingSessionStatus(sessionStatus)

  useEffect(() => {
    setPlanSavedAsTicket(false)
  }, [pendingPlan?.planContent])

  useEffect(() => {
    if (!isVisible) return
    const timer = window.setTimeout(() => {
      terminalRef.current?.focus()
    }, 75)
    return () => window.clearTimeout(timer)
  }, [isVisible, sessionId, terminalKey])

  const createClaudeTerminal = useCallback(async () => {
    const pendingPrompt = useSessionStore.getState().dequeuePendingMessage(sessionId)
    try {
      const envelope = await window.terminalOps.createClaudeCli(sessionId, {
        pendingPrompt
      })
      const result = unwrapEnvelope(envelope)
      if (!result.success && pendingPrompt) {
        useSessionStore.getState().requeuePendingMessage(sessionId, pendingPrompt)
      }
      return envelope
    } catch (error) {
      if (pendingPrompt) {
        useSessionStore.getState().requeuePendingMessage(sessionId, pendingPrompt)
      }
      throw error
    }
  }, [sessionId])

  useEffect(() => {
    return window.terminalOps.onClaudeSessionId(sessionId, (claudeSessionId) => {
      useSessionStore.getState().setClaudeSessionId(sessionId, claudeSessionId)
    })
  }, [sessionId])

  const handleStatusChange = useCallback((status: 'creating' | 'running' | 'exited') => {
    if (status === 'running') {
      setEnded(false)
    } else if (status === 'exited') {
      setEnded(true)
    }
  }, [])

  const handleRestart = useCallback(() => {
    setEnded(false)
    setTerminalKey((current) => current + 1)
  }, [])

  const terminalId = useMemo(() => `${sessionId}:${terminalKey}`, [sessionId, terminalKey])

  const handlePlanReadyHandoff = useCallback(
    async (override: HandoffSelectionOverride) => {
      const planContent = pendingPlan?.planContent
      if (!planContent) {
        toast.error('No plan content found to hand off')
        return
      }

      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      lastSendMode.delete(sessionId)
      const handoffGoalMode = override.goalMode === true && override.agentSdk === 'codex'

      const handoffPrompt = buildHandoffPrompt(planContent, {
        ...override,
        superPlan: mode === 'super-plan'
      })
      const sessionStore = useSessionStore.getState()

      if (sessionRecord?.connection_id) {
        const result = await sessionStore.createConnectionSession(
          sessionRecord.connection_id,
          override.agentSdk,
          override.agentSdk === 'claude-code-cli' && mode === 'super-plan'
            ? 'super-plan'
            : undefined,
          { autoFocus: !isMountedInTicketModal, modelOverride: override.model }
        )
        if (!result.success || !result.session) {
          toast.error(result.error ?? 'Failed to create handoff session')
          return
        }

        const setModePromise =
          result.session.agent_sdk === 'claude-code-cli' && mode === 'super-plan'
            ? Promise.resolve()
            : sessionStore.setSessionMode(result.session.id, 'build')
        sessionStore.setPendingMessage(result.session.id, handoffPrompt)
        await useKanbanStore
          .getState()
          .relinkTicketsForHandoff(sessionId, result.session.id, handoffGoalMode)
        if (isMountedInTicketModal) {
          if (useSettingsStore.getState().boardMode === 'sticky-tab') {
            sessionStore.setActiveSession(BOARD_TAB_ID)
          }
          useKanbanStore.getState().setSelectedTicketId(null)
          const connectionPath = findConnectionPathById(sessionRecord.connection_id)
          await setModePromise
          await startTicketModalHandoffSession({
            sessionId: result.session.id,
            agentSdk: result.session.agent_sdk,
            handoffPrompt,
            connectionId: sessionRecord.connection_id,
            worktreePath: connectionPath
          })
          toast.success('Handoff session started')
          return
        }
        sessionStore.setActiveConnectionSession(result.session.id)
        await setModePromise
        return
      }

      if (!sessionRecord?.worktree_id || !sessionRecord.project_id) {
        toast.error('Could not start handoff session')
        return
      }

      const result = await sessionStore.createSession(
        sessionRecord.worktree_id,
        sessionRecord.project_id,
        override.agentSdk,
        override.agentSdk === 'claude-code-cli' && mode === 'super-plan' ? 'super-plan' : undefined,
        { autoFocus: !isMountedInTicketModal, modelOverride: override.model }
      )
      if (!result.success || !result.session) {
        toast.error(result.error ?? 'Failed to create handoff session')
        return
      }

      const setModePromise =
        result.session.agent_sdk === 'claude-code-cli' && mode === 'super-plan'
          ? Promise.resolve()
          : sessionStore.setSessionMode(result.session.id, 'build')
      sessionStore.setPendingMessage(result.session.id, handoffPrompt)
      await useKanbanStore
        .getState()
        .relinkTicketsForHandoff(sessionId, result.session.id, handoffGoalMode)
      if (isMountedInTicketModal) {
        if (useSettingsStore.getState().boardMode === 'sticky-tab') {
          sessionStore.setActiveSession(BOARD_TAB_ID)
        }
        useKanbanStore.getState().setSelectedTicketId(null)
        const worktreePath = findWorktreePathById(sessionRecord.worktree_id)
        await setModePromise
        await startTicketModalHandoffSession({
          sessionId: result.session.id,
          agentSdk: result.session.agent_sdk,
          handoffPrompt,
          worktreeId: sessionRecord.worktree_id,
          worktreePath
        })
        toast.success('Handoff session started')
        return
      }
      sessionStore.setActiveSession(result.session.id)
      await setModePromise
    },
    [isMountedInTicketModal, mode, pendingPlan?.planContent, sessionId, sessionRecord]
  )

  const handlePlanReadySaveAsTicket = useCallback(async () => {
    const projectId = sessionRecord?.project_id
    const planContent = pendingPlan?.planContent
    if (!projectId) {
      toast.error('No project associated with this session')
      return
    }
    if (!planContent) {
      toast.error('No plan content found')
      return
    }

    const extracted = extractPlanTitle(planContent)
    const title = extracted ? extracted.slice(0, 100) : 'Plan ticket'

    try {
      await useKanbanStore.getState().createTicket(projectId, {
        project_id: projectId,
        title,
        description: planContent,
        column: 'todo'
      })
      setPlanSavedAsTicket(true)
      toast.success('Saved as ticket')
    } catch {
      toast.error('Failed to save as ticket')
    }
  }, [pendingPlan?.planContent, sessionRecord?.project_id])

  const resolveQuestionPath = useCallback((): string | undefined => {
    if (sessionRecord?.worktree_id) {
      return findWorktreePathById(sessionRecord.worktree_id) ?? undefined
    }
    if (sessionRecord?.connection_id) {
      return findConnectionPathById(sessionRecord.connection_id) ?? undefined
    }
    return undefined
  }, [sessionRecord?.worktree_id, sessionRecord?.connection_id])

  const handleQuestionReply = useCallback(
    async (requestId: string, answers: string[][]) => {
      try {
        unwrapEnvelope(
          await window.opencodeOps.questionReply(requestId, answers, resolveQuestionPath())
        )
      } catch (err) {
        console.error('Failed to reply to question:', err)
        toast.error('Failed to send answer')
      }
    },
    [resolveQuestionPath]
  )

  const handleQuestionReject = useCallback(
    async (requestId: string) => {
      try {
        unwrapEnvelope(await window.opencodeOps.questionReject(requestId, resolveQuestionPath()))
      } catch (err) {
        console.error('Failed to dismiss question:', err)
        toast.error('Failed to dismiss question')
      }
    },
    [resolveQuestionPath]
  )

  return (
    <div
      className="flex-1 flex flex-col min-h-0 bg-background"
      data-testid="claude-cli-session-view"
      data-session-id={sessionId}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ModeToggle sessionId={sessionId} />
          <SuperToggle sessionId={sessionId} />
          {pendingMessage && (
            <span className="truncate text-xs text-muted-foreground">handoff prompt pending</span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {selectableAgentSdk && (
            <SessionProviderSelector
              sessionId={sessionId}
              agentSdk={selectableAgentSdk}
              canChange={canChangeBlankSessionProvider}
            />
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <TerminalView
          ref={terminalRef}
          key={terminalId}
          terminalId={sessionId}
          cwd="/"
          isVisible={isVisible}
          showToolbar={false}
          backendTypeOverride="xterm"
          shiftEnterAsNewline
          createTerminal={createClaudeTerminal}
          onStatusChange={handleStatusChange}
        />
        {pendingPlan?.planContent && (
          <ClaudeCliPlanReadyCard
            planContent={pendingPlan.planContent}
            worktreeId={sessionRecord?.worktree_id ?? undefined}
            onHandoff={handlePlanReadyHandoff}
            onSaveAsTicket={handlePlanReadySaveAsTicket}
            savedAsTicket={planSavedAsTicket}
          />
        )}
        {/* In the ticket modal the modal renders its own question sidebar, so only
            show the session-embedded prompt for the standalone session view. */}
        {activeQuestion && isForwarding && !isMountedInTicketModal && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 p-4">
            <div className="pointer-events-auto mx-auto max-w-2xl">
              <QuestionPrompt
                key={activeQuestion.id}
                request={activeQuestion}
                onReply={handleQuestionReply}
                onReject={handleQuestionReject}
              />
            </div>
          </div>
        )}
        {ended && <ClaudeCliEndedOverlay onRestart={handleRestart} />}
      </div>
    </div>
  )
}
