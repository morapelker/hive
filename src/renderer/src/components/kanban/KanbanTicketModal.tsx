import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  Eye,
  EyeOff,
  X,
  Trash2,
  ExternalLink,
  Hammer,
  Send,
  Zap,
  ArrowRight,
  AlertCircle,
  Bolt,
  Play,
  Square,
  FileSearch,
  GitPullRequest,
  GitMerge,
  Archive,
  Loader2,
  Github,
  FileUp,
  File as FileIcon,
  Upload
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownRenderer } from '../sessions/MarkdownRenderer'
import { cn } from '@/lib/utils'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useCommandApprovalStore } from '@/stores/useCommandApprovalStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { useGitStore } from '@/stores/useGitStore'
import { notifyKanbanSessionSync } from '@/stores/store-coordination'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { PLAN_MODE_PREFIX, SUPER_PLAN_MODE_PREFIX, isPlanLike } from '@/lib/constants'
import { buildSdkPlanImplementationPrompt } from '@/lib/proposedPlan'
import { toast } from '@/lib/toast'
import { useScriptStore, fireRunScript, killRunScript } from '@/stores/useScriptStore'
import { useQuestionStore, type QuestionRequest } from '@/stores/useQuestionStore'
import { QuestionPrompt } from '@/components/sessions/QuestionPrompt'
import { FollowupInput } from './FollowupInput'
import type { Attachment } from '@/components/sessions/AttachmentPreview'
import { buildMessageParts, isImageMime, MAX_ATTACHMENTS } from '@/lib/file-attachment-utils'
import { useDropZone } from '@/hooks/useDropZone'
import { SessionStreamPanel } from './SessionStreamPanel'
import {
  ReviewTicketDiffSummary,
  type ReviewTicketDiffFile
} from './ReviewTicketDiffSummary'
import { ProviderIcon, getProviderLabel } from '@/components/ui/provider-icon'
import { useLifecycleActions } from '@/hooks/useLifecycleActions'
import { usePinAndActivateSession } from '@/hooks/usePinAndActivateSession'
import { TicketAttachmentEditor, MAX_ATTACHMENTS } from './TicketAttachmentEditor'
import { useImagePaste } from '@/hooks/useImagePaste'
import type { KanbanTicket, KanbanTicketUpdate, Worktree } from '../../../../main/db/types'

// ── Types ───────────────────────────────────────────────────────────
type ModalMode = 'edit' | 'plan_review' | 'review' | 'error' | 'question'
type FollowUpMode = 'build' | 'plan' | 'super-plan'

/** Standard (non-dual-pane) DialogContent className per modal mode */
const MODE_DIALOG_CLASS: Record<ModalMode, string> = {
  edit: 'sm:max-w-lg',
  plan_review: 'sm:max-w-2xl max-h-[80vh] flex flex-col overflow-hidden',
  review: 'sm:max-w-2xl max-h-[80vh] flex flex-col overflow-hidden',
  error: 'sm:max-w-lg',
  question: 'sm:max-w-lg'
}

// TicketAttachment is now imported from TicketAttachmentEditor
type TicketAttachment = import('./TicketAttachmentEditor').TicketAttachment

// ── Helpers ─────────────────────────────────────────────────────────

/** Find a worktree by its ID across all projects */
function findWorktreeById(
  worktreeId: string
): { id: string; path: string; branch_name: string; project_id: string } | null {
  for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
    const wt = worktrees.find((w) => w.id === worktreeId)
    if (wt) return wt
  }
  return null
}

/** Find a worktree path by its ID across all projects */
function findWorktreePathById(worktreeId: string): string | null {
  return findWorktreeById(worktreeId)?.path ?? null
}

/** Find a session by ID across worktree and connection session maps, with DB fallback */
async function findSessionById(sessionId: string): Promise<{
  session: { id: string; worktree_id: string | null; connection_id: string | null; opencode_session_id: string | null; agent_sdk: string; model_provider_id: string | null; model_id: string | null; model_variant: string | null }
  worktreePath: string | null
  connectionId: string | null
  /** Working directory for opencode ops — worktree path or connection path */
  workingPath: string | null
} | null> {
  // Fast path: check in-memory store
  const sessionStore = useSessionStore.getState()
  for (const sessions of sessionStore.sessionsByWorktree.values()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) {
      let worktreePath = found.worktree_id ? findWorktreePathById(found.worktree_id) : null
      // Worktree not in the in-memory store (project not loaded in sidebar) — try DB
      if (!worktreePath && found.worktree_id) {
        worktreePath = (await window.db.worktree.get(found.worktree_id))?.path ?? null
      }
      return { session: found, worktreePath, connectionId: null, workingPath: worktreePath }
    }
  }
  for (const [connId, sessions] of sessionStore.sessionsByConnection.entries()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) {
      const connectionPath = useConnectionStore.getState().connections.find(c => c.id === connId)?.path ?? null
      return { session: found, worktreePath: null, connectionId: connId, workingPath: connectionPath }
    }
  }
  // DB fallback: session not in store (worktree not currently selected)
  const dbSession = await window.db.session.get(sessionId)
  if (!dbSession) {
    console.warn(`[KanbanTicketModal] findSessionById: session not found in store or DB — sessionId=${sessionId}`)
    return null
  }
  // Hydrate into the in-memory store so getWorktreeStatus() and
  // zustand selectors can find this session going forward.
  useSessionStore.getState().hydrateSession(dbSession)

  const worktreePath = dbSession.worktree_id
    ? (await window.db.worktree.get(dbSession.worktree_id))?.path ?? null
    : null
  return {
    session: {
      id: dbSession.id,
      worktree_id: dbSession.worktree_id,
      connection_id: dbSession.connection_id,
      opencode_session_id: dbSession.opencode_session_id,
      agent_sdk: dbSession.agent_sdk,
      model_provider_id: dbSession.model_provider_id,
      model_id: dbSession.model_id,
      model_variant: dbSession.model_variant
    },
    worktreePath,
    connectionId: dbSession.connection_id,
    workingPath: worktreePath
  }
}

/** Resolve the model to use for a session's next prompt (mirrors SessionView.getModelForRequests) */
function resolveSessionModel(
  sessionId: string,
  sessionDataFallback?: { model_provider_id: string | null; model_id: string | null; model_variant: string | null; agent_sdk: string }
): { providerID: string; modelID: string; variant?: string } | undefined {
  // Primary: scan store (picks up mode-specific defaults applied by setSessionMode)
  const state = useSessionStore.getState()
  let session: { model_provider_id: string | null; model_id: string | null; model_variant: string | null; agent_sdk: string } | null = null
  for (const sessions of state.sessionsByWorktree.values()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) { session = found; break }
  }
  // Fallback: use provided session data when session not in store (DB fallback path)
  if (!session && sessionDataFallback) {
    session = sessionDataFallback
  }
  // Session has an explicit model — use it
  if (session?.model_provider_id && session.model_id) {
    return {
      providerID: session.model_provider_id,
      modelID: session.model_id,
      variant: session.model_variant ?? undefined
    }
  }
  // Fall back to per-provider default for this session's SDK
  const agentSdk = session?.agent_sdk ?? 'opencode'
  return resolveModelForSdk(agentSdk) ?? undefined
}

/** Send a followup prompt to an existing session */
async function sendFollowupToSession(opts: {
  sessionId: string
  prompt: string
  followUpMode: FollowUpMode
  ticketId: string
  attachments?: Attachment[]
}): Promise<void> {
  const result = await findSessionById(opts.sessionId)
  if (!result) {
    console.error(`[KanbanTicketModal] sendFollowupToSession: session not found — sessionId=${opts.sessionId}`)
    throw new Error(`Session not found: ${opts.sessionId}`)
  }

  const { session, workingPath } = result

  if (!workingPath) {
    console.error(`[KanbanTicketModal] sendFollowupToSession: workingPath is null — sessionId=${opts.sessionId}, worktree_id=${session.worktree_id}, connection_id=${session.connection_id}`)
    throw new Error(`Working path not found for session: ${opts.sessionId}`)
  }

  if (!session.opencode_session_id) {
    console.error(`[KanbanTicketModal] sendFollowupToSession: opencode_session_id is null — sessionId=${opts.sessionId}`)
    throw new Error(`No opencode session ID for session: ${opts.sessionId}`)
  }

  // Set session mode so the agent SDK knows we're in plan mode (matches Tab toggle in SessionView).
  // This updates modeBySession, persists to DB, and applies mode-specific default model.
  await useSessionStore.getState().setSessionMode(opts.sessionId, opts.followUpMode)

  // Claude Code & Codex handle plan mode via the SDK — don't prepend the text prefix
  const skipPrefix = session.agent_sdk === 'claude-code' || session.agent_sdk === 'codex'
  const modePrefix =
    opts.followUpMode === 'super-plan' ? SUPER_PLAN_MODE_PREFIX
    : opts.followUpMode === 'plan' && !skipPrefix ? PLAN_MODE_PREFIX
    : ''
  const fullPrompt = modePrefix + opts.prompt

  // Auto-revert super-plan → plan immediately (one-shot mode).
  // The prefix is already captured in fullPrompt above.
  if (opts.followUpMode === 'super-plan') {
    useSessionStore.getState().setSessionMode(opts.sessionId, 'plan')
  }

  messageSendTimes.set(opts.sessionId, Date.now())
  userExplicitSendTimes.set(opts.sessionId, Date.now())
  snapshotTokenBaseline(opts.sessionId)
  lastSendMode.set(opts.sessionId, opts.followUpMode)
  useWorktreeStatusStore
    .getState()
    .setSessionStatus(opts.sessionId, isPlanLike(opts.followUpMode) ? 'planning' : 'working')

  // Resolve model AFTER setSessionMode (which may have applied a mode-specific default)
  const model = resolveSessionModel(opts.sessionId, result.session)

  // Ensure the session is loaded in the agent SDK implementer's in-memory map.
  // SessionView does this on mount via initializeSession(), but the kanban
  // followup path bypasses SessionView entirely.  Without this, the Claude Code
  // implementer throws "session not found" because its Map was never populated.
  const reconnectResult = await window.opencodeOps.reconnect(workingPath, session.opencode_session_id, opts.sessionId)
  if (!reconnectResult.success) {
    throw new Error(`Failed to reconnect to session: ${opts.sessionId}`)
  }

  const messageParts = opts.attachments?.length
    ? buildMessageParts(opts.attachments, fullPrompt)
    : [{ type: 'text' as const, text: fullPrompt }]

  const promptResult = await window.opencodeOps.prompt(workingPath, session.opencode_session_id,
    messageParts, model)

  if (promptResult && !promptResult.success) {
    console.error(`[KanbanTicketModal] sendFollowupToSession: prompt returned failure — error=${promptResult.error}`)
    throw new Error(promptResult.error || 'Failed to send prompt to session')
  }
}

/** Determine what mode the modal should operate in */
function resolveModalMode(ticket: KanbanTicket, sessionStatus: string | null): ModalMode {
  // Error mode: linked session has error (can appear in any column)
  if (sessionStatus === 'error') {
    return 'error'
  }
  // Plan review mode: plan_ready flag set (ticket is now in review column)
  if (ticket.plan_ready) {
    return 'plan_review'
  }
  // Review mode: review column
  if (ticket.column === 'review') {
    return 'review'
  }
  // Default: edit mode (todo, done, or simple in_progress tickets)
  return 'edit'
}

// ── Component ───────────────────────────────────────────────────────
export function KanbanTicketModal() {
  const selectedTicketId = useKanbanStore((s) => s.selectedTicketId)
  const setSelectedTicketId = useKanbanStore((s) => s.setSelectedTicketId)
  const tickets = useKanbanStore((s) => s.tickets)

  // Find the ticket across all projects
  const ticket = useMemo<KanbanTicket | null>(() => {
    if (!selectedTicketId) return null
    for (const projectTickets of tickets.values()) {
      const found = projectTickets.find((t) => t.id === selectedTicketId)
      if (found) return found
    }
    return null
  }, [selectedTicketId, tickets])

  const open = ticket !== null
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) setSelectedTicketId(null)
    },
    [setSelectedTicketId]
  )

  if (!ticket) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <KanbanTicketModalContent ticket={ticket} onClose={() => setSelectedTicketId(null)} />
    </Dialog>
  )
}

// ── Inner content (only rendered when ticket is non-null) ───────────
function KanbanTicketModalContent({
  ticket,
  onClose
}: {
  ticket: KanbanTicket
  onClose: () => void
}) {
  const updateTicket = useKanbanStore((s) => s.updateTicket)
  const deleteTicket = useKanbanStore((s) => s.deleteTicket)
  const moveTicket = useKanbanStore((s) => s.moveTicket)

  // ── Session lookup ────────────────────────────────────────────────
  const sessionStatus = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.status
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found.status
        }
        return null
      },
      [ticket.current_session_id]
    )
  )

  const sessionRecord = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === ticket.current_session_id)
          if (found) return found
        }
        return null
      },
      [ticket.current_session_id]
    )
  )

  // ── DB session fallback ──────────────────────────────────────────
  // When zustand selectors return null (session not in sessionsByWorktree
  // or sessionsByConnection), fall back to the DB via findSessionById —
  // the same 3-tier lookup that sendFollowupToSession already uses.
  const [dbSessionInfo, setDbSessionInfo] = useState<{
    session: {
      id: string; worktree_id: string | null; connection_id: string | null;
      opencode_session_id: string | null; agent_sdk: string;
      model_provider_id: string | null; model_id: string | null; model_variant: string | null;
    }
    worktreePath: string | null
  } | null>(null)

  // Tracks when findSessionById definitively returns null (session not
  // in store or DB).  Used to fall back to the standard (no-session)
  // layout instead of showing a perpetual spinner.
  const [sessionLoadFailed, setSessionLoadFailed] = useState(false)

  // Guards against a race where loadSessions (which replaces
  // sessionsByWorktree entirely with active-only sessions) would wipe
  // out a session that hydrateSession just added from the DB fallback.
  const isLoadingDbSession = useRef(false)

  useEffect(() => {
    if (!ticket.current_session_id) {
      setDbSessionInfo(null)
      setSessionLoadFailed(false)
      isLoadingDbSession.current = false
      return
    }
    if (sessionRecord) {
      // Session found in zustand — don't clear dbSessionInfo because its
      // worktreePath is still needed as a fallback until dbWorktreePath
      // loads from its own async effect.
      // Only clear if it belongs to a different session (ticket switched).
      if (dbSessionInfo && dbSessionInfo.session.id !== ticket.current_session_id) {
        setDbSessionInfo(null)
      }
      setSessionLoadFailed(false)
      isLoadingDbSession.current = false
      return
    }
    let cancelled = false
    // Set synchronously so the hasAttemptedSessionLoad effect (which
    // fires in the same micro-task batch) sees it before calling loadSessions.
    isLoadingDbSession.current = true
    setSessionLoadFailed(false)
    findSessionById(ticket.current_session_id).then((result) => {
      if (cancelled) return
      if (!result) {
        setSessionLoadFailed(true)
        return
      }
      setDbSessionInfo({ session: result.session, worktreePath: result.workingPath })
    }).finally(() => {
      if (!cancelled) isLoadingDbSession.current = false
    })
    return () => { cancelled = true; isLoadingDbSession.current = false }
  }, [ticket.current_session_id, sessionRecord])

  // Eagerly load sessions when a ticket has a session but it's not in the
  // in-memory store (e.g. the worktree isn't currently selected).  Guard
  // with a ref so we only attempt once per ticket to avoid infinite loops
  // when the session genuinely doesn't exist in the loaded worktree.
  const hasAttemptedSessionLoad = useRef(false)
  useEffect(() => {
    if (!ticket.current_session_id || sessionRecord || dbSessionInfo) {
      hasAttemptedSessionLoad.current = false
      return
    }
    if (!ticket.worktree_id || !ticket.project_id) return
    if (hasAttemptedSessionLoad.current) return
    // Don't call loadSessions while the DB fallback lookup is in-flight —
    // loadSessions replaces sessionsByWorktree entirely with active-only
    // sessions, which would wipe out the session hydrateSession adds.
    if (isLoadingDbSession.current) return
    hasAttemptedSessionLoad.current = true
    useSessionStore.getState().loadSessions(ticket.worktree_id, ticket.project_id)
  }, [ticket.current_session_id, ticket.worktree_id, ticket.project_id, sessionRecord, dbSessionInfo])

  const pendingPlan = useSessionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        return state.pendingPlans.get(ticket.current_session_id) ?? null
      },
      [ticket.current_session_id]
    )
  )

  const activeQuestion = useQuestionStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        const questions = state.pendingBySession.get(ticket.current_session_id)
        return questions?.[0] ?? null
      },
      [ticket.current_session_id]
    )
  )

  const [dbWorktreePath, setDbWorktreePath] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionRecord?.worktree_id) { setDbWorktreePath(null); return }

    const inMemory = findWorktreePathById(sessionRecord.worktree_id)
    if (inMemory) { setDbWorktreePath(null); return }

    // Worktree not in store — load from DB
    window.db.worktree.get(sessionRecord.worktree_id).then((wt) => {
      setDbWorktreePath(wt?.path ?? null)
    })
  }, [sessionRecord?.worktree_id])

  const effectiveSession = sessionRecord ?? dbSessionInfo?.session ?? null

  const baseModalMode = resolveModalMode(ticket, sessionStatus)
  // Question mode takes highest priority — an unanswered question blocks
  // the agent regardless of other ticket state (error, plan_ready, etc.)
  const modalMode = activeQuestion ? 'question' : baseModalMode

  // ── Session stream resolution ────────────────────────────────────
  let worktreePath: string | null = null
  if (effectiveSession?.worktree_id) {
    worktreePath = findWorktreePathById(effectiveSession.worktree_id) ?? dbWorktreePath ?? dbSessionInfo?.worktreePath ?? null
  } else if (effectiveSession?.connection_id) {
    worktreePath = useConnectionStore.getState().connections.find(
      c => c.id === effectiveSession.connection_id
    )?.path ?? dbSessionInfo?.worktreePath ?? null
  } else if (dbSessionInfo?.worktreePath) {
    worktreePath = dbSessionInfo.worktreePath
  }
  const storeOpcSessionId: string | null = effectiveSession?.opencode_session_id ?? null

  // If the Zustand store still has a placeholder `pending::` ID, the real
  // materialized ID may already be in the DB (the backend updates it during
  // the first prompt).  Re-read from the DB to resolve it.
  const [resolvedOpcSessionId, setResolvedOpcSessionId] = useState<string | null>(null)
  useEffect(() => {
    if (!storeOpcSessionId || !storeOpcSessionId.startsWith('pending::') || !ticket.current_session_id) {
      setResolvedOpcSessionId(null)
      return
    }
    let cancelled = false
    window.db.session.get(ticket.current_session_id).then((dbSess: { opencode_session_id?: string | null } | null) => {
      if (cancelled) return
      const dbId = dbSess?.opencode_session_id ?? null
      if (dbId && !dbId.startsWith('pending::')) {
        console.info('[KanbanModal] resolved pending:: ID from DB — store=%s, db=%s', storeOpcSessionId, dbId)
        // Also update the Zustand store so other components pick it up
        useSessionStore.getState().setOpenCodeSessionId(ticket.current_session_id!, dbId)
        setResolvedOpcSessionId(dbId)
      }
    })
    return () => { cancelled = true }
  }, [storeOpcSessionId, ticket.current_session_id])

  const opcSessionId = resolvedOpcSessionId ?? storeOpcSessionId
  const hasSession = !!(ticket.current_session_id && worktreePath && opcSessionId && !opcSessionId.startsWith('pending::'))

  // Commit to dual-pane layout as soon as we know the ticket has a session,
  // even before the async DB lookups resolve.  This prevents the user from
  // seeing a narrow "empty" modal while session data loads.
  // Falls back to standard layout only when the DB lookup definitively fails.
  const wantsDualPane = !!ticket.current_session_id && !sessionLoadFailed

  const [sessionReady, setSessionReady] = useState(false)

  console.info('[KanbanModal] session resolution — ticket.current_session_id=%s, worktreePath=%s, opcSessionId=%s (store=%s), hasSession=%s, sessionReady=%s, agent_sdk=%s, sessionLoadFailed=%s', ticket.current_session_id, worktreePath, opcSessionId, storeOpcSessionId, hasSession, sessionReady, effectiveSession?.agent_sdk, sessionLoadFailed)

  useEffect(() => {
    if (!worktreePath || !opcSessionId || !ticket.current_session_id) {
      setSessionReady(false)
      return
    }

    let cancelled = false
    setSessionReady(false)

    // Mirror SessionView's init flow: reconnect → getMessages in one async
    // sequence.  The getMessages() call pre-warms the backend's in-memory
    // message cache (for Claude Code sessions this triggers readClaudeTranscript
    // from disk; for OpenCode sessions it pokes the server).  Without this,
    // SessionStreamPanel's useSessionStream hook may call getMessages() before
    // the cache is warm and receive an empty result.
    console.info('[KanbanModal:sessionReady] starting — worktreePath=%s, opcSessionId=%s, hiveSessionId=%s', worktreePath, opcSessionId, ticket.current_session_id)
    ;(async () => {
      try {
        const reconnResult = await window.opencodeOps.reconnect(worktreePath, opcSessionId, ticket.current_session_id)
        console.info('[KanbanModal:sessionReady] reconnect result:', reconnResult)
      } catch (err) {
        console.warn('[KanbanModal:sessionReady] reconnect failed:', err)
        // reconnect failure is non-fatal — still try to show messages
      }

      // Pre-warm: load messages into the backend cache so the next
      // getMessages() call from useSessionStream finds them immediately.
      try {
        const warmResult = await window.opencodeOps.getMessages(worktreePath, opcSessionId)
        console.info('[KanbanModal:sessionReady] pre-warm getMessages — success=%s, messageCount=%d', warmResult.success, Array.isArray(warmResult.messages) ? warmResult.messages.length : 0)
      } catch (err) {
        console.warn('[KanbanModal:sessionReady] pre-warm getMessages failed:', err)
        // Pre-warm failure is non-fatal
      }

      if (!cancelled) {
        console.info('[KanbanModal:sessionReady] setting sessionReady=true')
        setSessionReady(true)
      } else {
        console.info('[KanbanModal:sessionReady] cancelled, not setting sessionReady')
      }
    })()

    return () => { cancelled = true }
  }, [worktreePath, opcSessionId, ticket.current_session_id])

  // Render the mode-specific inner content (without DialogContent wrapper)
  let modeContent: React.ReactNode
  switch (modalMode) {
    case 'edit':
      modeContent = (
        <EditModeContent
          ticket={ticket}
          onClose={onClose}
          updateTicket={updateTicket}
          deleteTicket={deleteTicket}
        />
      )
      break
    case 'plan_review':
      modeContent = (
        <PlanReviewModeContent
          ticket={ticket}
          onClose={onClose}
          pendingPlan={pendingPlan}
          sessionRecord={effectiveSession}
          updateTicket={updateTicket}
          dualPane={wantsDualPane}
          worktreePath={worktreePath}
          opcSessionId={opcSessionId}
        />
      )
      break
    case 'review':
      modeContent = (
        <ReviewModeContent
          ticket={ticket}
          onClose={onClose}
          moveTicket={moveTicket}
          updateTicket={updateTicket}
          dualPane={wantsDualPane}
        />
      )
      break
    case 'error':
      modeContent = <ErrorModeContent ticket={ticket} onClose={onClose} dualPane={wantsDualPane} />
      break
    case 'question':
      modeContent = (
        <QuestionModeContent
          ticket={ticket}
          onClose={onClose}
          activeQuestion={activeQuestion!}
          dualPane={wantsDualPane}
        />
      )
      break
  }

  // ── Full-width session layout (only in-progress edit mode — left pane has no actionable content) ──
  if (wantsDualPane && modalMode === 'edit' && ticket.column === 'in_progress') {
    return (
      <DialogContent
        data-testid="kanban-ticket-modal"
        className="w-[96vw] max-w-[1920px] h-[90vh] p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{ticket.title}</DialogTitle>
        </DialogHeader>
        <div className="flex h-full overflow-hidden">
          {hasSession && sessionReady ? (
            <SessionStreamPanel
              sessionId={ticket.current_session_id!}
              worktreePath={worktreePath!}
              opencodeSessionId={opcSessionId!}
              title={ticket.title}
              headerAction={(
                <JumpToSessionButton
                  ticket={ticket}
                  onClose={onClose}
                  label="Go to session"
                  testId="go-to-session-btn"
                />
              )}
              fullWidth
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent" />
            </div>
          )}
        </div>
      </DialogContent>
    )
  }

  // ── Dual-pane layout (ticket + session stream) ──────────────────
  if (wantsDualPane) {
    return (
      <DialogContent
        data-testid="kanban-ticket-modal"
        className="w-[96vw] max-w-[1920px] h-[90vh] p-0 gap-0 overflow-hidden"
      >
        <div className="flex h-full overflow-hidden">
          {/* Left: ticket content */}
          <div className="w-[480px] shrink-0 h-full flex flex-col overflow-y-auto p-6 gap-4">
            {/* Shared ticket context header for non-edit modes */}
            {modalMode !== 'edit' && (
              <div className="space-y-2 pb-3 border-b border-border/40">
                <h2 className="text-base font-semibold text-foreground leading-tight">
                  {ticket.title}
                </h2>
                {ticket.description && (
                  <div className="prose prose-sm dark:prose-invert max-w-none text-sm text-muted-foreground max-h-[120px] overflow-y-auto">
                    <MarkdownRenderer content={ticket.description} />
                  </div>
                )}
              </div>
            )}
            {modeContent}
          </div>
          {/* Right: session stream (or loading spinner while DB lookup resolves) */}
          {hasSession && sessionReady ? (
            <SessionStreamPanel
              sessionId={ticket.current_session_id!}
              worktreePath={worktreePath!}
              opencodeSessionId={opcSessionId!}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent" />
            </div>
          )}
        </div>
      </DialogContent>
    )
  }

  // ── Standard layout (no session) ────────────────────────────────
  return (
    <DialogContent
      data-testid="kanban-ticket-modal"
      className={MODE_DIALOG_CLASS[modalMode]}
    >
      {modeContent}
    </DialogContent>
  )
}

// ════════════════════════════════════════════════════════════════════
// EDIT MODE
// ════════════════════════════════════════════════════════════════════

function EditModeContent({
  ticket,
  onClose,
  updateTicket,
  deleteTicket
}: {
  ticket: KanbanTicket
  onClose: () => void
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
  deleteTicket: (ticketId: string, projectId: string) => Promise<void>
}) {
  const [title, setTitle] = useState(ticket.title)
  const [description, setDescription] = useState(ticket.description ?? '')
  const [showPreview, setShowPreview] = useState(false)
  const [attachments, setAttachments] = useState<TicketAttachment[]>(
    () =>
      (ticket.attachments as Array<{ type: string; url: string; label: string }>).map((a) => ({
        type: a.type as 'jira' | 'figma' | 'file' | 'image',
        url: a.url,
        label: a.label
      })) ?? []
  )
  const [isSaving, setIsSaving] = useState(false)
  const lifecycle = useLifecycleActions(ticket.worktree_id)
  const { pinAndActivate: pinAndActivateSession, lifecycleLoading } = usePinAndActivateSession(onClose)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Load live PR state so merge-button guard works (hide if already merged/closed)
  useEffect(() => {
    if (lifecycle.hasAttachedPR) lifecycle.loadPRState()
  }, [lifecycle.hasAttachedPR])

  // ── Image paste/drop ───────────────────────────────────────────────
  const { isDragOver, handlePaste, handleDragOver, handleDragEnter, handleDragLeave, handleDrop } = useImagePaste({
    maxAttachments: MAX_ATTACHMENTS,
    currentCount: attachments.length,
    onAttach: (attachment) => setAttachments((prev) => [...prev, attachment])
  })

  const handleSave = useCallback(async () => {
    if (!title.trim() || isSaving) return
    setIsSaving(true)
    try {
      await updateTicket(ticket.id, ticket.project_id, {
        title: title.trim(),
        description: description.trim() || null,
        attachments: attachments.map((a) => ({ type: a.type, url: a.url, label: a.label }))
      })
      toast.success('Ticket updated')
      onClose()
    } catch {
      toast.error('Failed to update ticket')
    } finally {
      setIsSaving(false)
    }
  }, [title, description, attachments, isSaving, updateTicket, ticket.id, ticket.project_id, onClose])

  const handleDelete = useCallback(async () => {
    try {
      await deleteTicket(ticket.id, ticket.project_id)
      toast.success('Ticket deleted')
      onClose()
    } catch {
      toast.error('Failed to delete ticket')
    }
  }, [deleteTicket, ticket.id, ticket.project_id, onClose])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && title.trim()) {
        e.preventDefault()
        handleSave()
      }
    },
    [handleSave, title]
  )

  return (
    <div
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(isDragOver && "ring-2 ring-primary ring-offset-2 rounded-lg")}
    >
      <DialogHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DialogTitle>Edit Ticket</DialogTitle>
            {ticket.external_provider && ticket.external_url && (
              <button
                onClick={() => window.systemOps.openInChrome(ticket.external_url!)}
                className="transition-opacity hover:opacity-80"
                title={`Open ${getProviderLabel(ticket.external_provider)} #${ticket.external_id}`}
              >
                <ProviderIcon provider={ticket.external_provider} />
              </button>
            )}
          </div>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>Update ticket details.</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* Title */}
        <div className="space-y-1.5">
          <label htmlFor="ticket-edit-title" className="text-sm font-medium text-foreground">
            Title <span className="text-destructive">*</span>
          </label>
          <Input
            id="ticket-edit-title"
            data-testid="ticket-edit-title-input"
            placeholder="What needs to be done?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="ticket-edit-description"
              className="text-sm font-medium text-foreground"
            >
              Description
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="ticket-edit-preview-toggle"
              className="h-7 gap-1 text-xs text-muted-foreground"
              onClick={() => setShowPreview((prev) => !prev)}
            >
              {showPreview ? (
                <>
                  <EyeOff className="h-3.5 w-3.5" /> Edit
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5" /> Preview
                </>
              )}
            </Button>
          </div>

          {showPreview ? (
            <div
              data-testid="ticket-edit-description-preview"
              className="min-h-[120px] rounded-md border border-input bg-muted/30 px-3 py-2 text-sm prose prose-sm dark:prose-invert max-w-none"
            >
              {description.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{description}</ReactMarkdown>
              ) : (
                <p className="text-muted-foreground/60 italic">No description</p>
              )}
            </div>
          ) : (
            <Textarea
              id="ticket-edit-description"
              data-testid="ticket-edit-description-input"
              placeholder="Describe the ticket (supports markdown)..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              className="resize-y"
            />
          )}
        </div>

        {/* Attachments */}
        <TicketAttachmentEditor
          attachments={attachments}
          onChange={setAttachments}
          testIdPrefix="ticket-edit"
        />
      </div>

      <DialogFooter className="flex items-center justify-between sm:justify-between flex-wrap gap-y-2">
        <div>
          {showDeleteConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-destructive">Delete this ticket?</span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid="ticket-edit-delete-confirm-btn"
                onClick={handleDelete}
              >
                Yes, delete
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="ticket-edit-delete-btn"
              className="text-destructive hover:text-destructive"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {ticket.column === 'done' && ticket.worktree_id && (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5"
              disabled={lifecycleLoading}
              onClick={() => pinAndActivateSession(() => lifecycle.createCodeReview())}
            >
              <FileSearch className="h-3.5 w-3.5" />
              Review
            </Button>
          )}
          {ticket.column === 'done' && ticket.worktree_id && lifecycle.isGitHub &&
            lifecycle.hasAttachedPR && lifecycle.prLiveState?.state !== 'MERGED' &&
            lifecycle.prLiveState?.state !== 'CLOSED' && (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5 bg-emerald-600/10 border-emerald-500/30 text-emerald-500 hover:bg-emerald-600/20"
              onClick={() => lifecycle.mergePR()}
              disabled={lifecycle.isMergingPR}
            >
              {lifecycle.isMergingPR ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitMerge className="h-3.5 w-3.5" />
              )}
              {lifecycle.isMergingPR ? 'Merging...' : 'Merge PR'}
            </Button>
          )}
          {ticket.column === 'done' && ticket.worktree_id && (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5 border-red-500/30 text-red-500 hover:bg-red-500/10"
              onClick={() => {
                onClose()
                lifecycle.archiveWorktree()
              }}
            >
              <Archive className="h-3.5 w-3.5" />
              Archive
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            data-testid="ticket-edit-cancel-btn"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="ticket-edit-save-btn"
            disabled={!title.trim() || isSaving}
            onClick={handleSave}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </DialogFooter>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// PLAN REVIEW MODE
// ════════════════════════════════════════════════════════════════════

function PlanReviewModeContent({
  ticket,
  onClose,
  pendingPlan,
  sessionRecord,
  updateTicket,
  dualPane = false,
  worktreePath,
  opcSessionId
}: {
  ticket: KanbanTicket
  onClose: () => void
  pendingPlan: { requestId: string; planContent: string; toolUseID: string } | null
  sessionRecord: {
    worktree_id: string | null
    connection_id: string | null
    agent_sdk: string
  } | null
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
  dualPane?: boolean
  worktreePath: string | null
  opcSessionId: string | null
}) {
  const [isActioning, setIsActioning] = useState(false)
  const [followUpText, setFollowUpText] = useState('')
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>('plan')
  const [isSending, setIsSending] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)

  const planContent = pendingPlan?.planContent ?? ticket.description ?? ''

  const handleAttach = useCallback((file: Omit<Attachment, 'id'>) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        return prev
      }
      return [...prev, { id: crypto.randomUUID(), ...file }]
    })
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleDropFiles = useCallback((files: FileList) => {
    for (const file of Array.from(files)) {
      if (attachments.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        break
      }
      if (isImageMime(file.type)) {
        const reader = new FileReader()
        reader.onload = () => {
          handleAttach({
            kind: 'data',
            name: file.name,
            mime: file.type,
            dataUrl: reader.result as string
          })
        }
        reader.readAsDataURL(file)
      } else {
        handleAttach({
          kind: 'path',
          name: file.name,
          mime: file.type || 'application/octet-stream',
          filePath: window.fileOps.getPathForFile(file)
        })
      }
    }
  }, [handleAttach, attachments.length])

  const { isDragging } = useDropZone({ onDrop: handleDropFiles, containerRef: dropZoneRef })

  const toggleMode = useCallback(() => {
    setFollowUpMode((prev) => prev === 'build' ? 'plan' : 'build')
  }, [])

  // Tab key toggles mode
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const modal = document.querySelector('[data-testid="kanban-ticket-modal"]')
        if (modal?.contains(document.activeElement)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          toggleMode()
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [toggleMode])

  // ── Send followup (reject pending plan + iterate) ────────────────
  const handleSendFollowup = useCallback(async () => {
    if ((!followUpText.trim() && attachments.length === 0) || !ticket.current_session_id || isSending) return
    setIsSending(true)

    try {
      const sessionId = ticket.current_session_id
      const feedback = followUpText.trim()
      const isClaudeCode = sessionRecord?.agent_sdk === 'claude-code'

      // Reject the pending plan before sending the followup (mirrors SessionView)
      if (pendingPlan) {
        useSessionStore.getState().clearPendingPlan(sessionId)
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

        if (isClaudeCode && (sessionRecord?.worktree_id || sessionRecord?.connection_id)) {
          let rejectPath: string | null = null
          if (sessionRecord.worktree_id) {
            rejectPath = findWorktreePathById(sessionRecord.worktree_id)
          } else if (sessionRecord.connection_id) {
            rejectPath = useConnectionStore.getState().connections.find(c => c.id === sessionRecord.connection_id)?.path ?? null
          }
          if (!rejectPath) {
            console.error(`[KanbanTicketModal] planReject: working path not found — worktree_id=${sessionRecord.worktree_id}, connection_id=${sessionRecord.connection_id}`)
            toast.error('Failed to reject plan: working path not found')
            return
          }
          await updateTicket(ticket.id, ticket.project_id, { plan_ready: false, mode: 'plan' })
          // The clearSessionStatus above wiped the busy state. Set it back to
          // 'planning' so the kanban card shows the progress bar while the
          // agent processes the rejection feedback.
          messageSendTimes.set(sessionId, Date.now())
          userExplicitSendTimes.set(sessionId, Date.now())
          snapshotTokenBaseline(sessionId)
          lastSendMode.set(sessionId, 'plan')
          useWorktreeStatusStore
            .getState()
            .setSessionStatus(sessionId, 'planning')
          toast.success('Plan rejected with feedback')
          onClose()

          // Send the rejection feedback to the session in background.
          // UI is already updated (plan cleared, status set, modal closed).
          sendFollowupToSession({
            sessionId,
            prompt: feedback,
            followUpMode,
            ticketId: ticket.id,
            attachments,
          }).catch((err) => {
            console.error('[KanbanTicketModal] sendFollowupToSession failed:', err)
            const reason = err instanceof Error ? err.message : String(err)
            toast.error(`Failed to send followup: ${reason}`)
            useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
          })
          return
        }
      }

      // For non-Claude Code (or no pending plan): send as a regular followup.
      // Close modal immediately for instant UI feedback; run session in background.
      // Mark the session as busy NOW so the kanban card shows the progress bar
      // the moment the modal closes (sendFollowupToSession would set this too,
      // but only after async DB calls — the card would look idle in between).
      messageSendTimes.set(sessionId, Date.now())
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)
      lastSendMode.set(sessionId, followUpMode)
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, isPlanLike(followUpMode) ? 'planning' : 'working')

      await updateTicket(ticket.id, ticket.project_id, { mode: followUpMode, plan_ready: false })
      toast.success('Followup sent')
      onClose()

      sendFollowupToSession({
        sessionId,
        prompt: feedback,
        followUpMode,
        ticketId: ticket.id,
        attachments,
      }).catch((err) => {
        console.error('[KanbanTicketModal] sendFollowupToSession failed:', err)
        const reason = err instanceof Error ? err.message : String(err)
        toast.error(`Failed to send followup: ${reason}`)
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      })
    } catch (err) {
      console.error('[KanbanTicketModal] handleSendFollowup failed:', err)
      const reason = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to send followup: ${reason}`)
    } finally {
      setIsSending(false)
      setAttachments([])
    }
  }, [followUpText, followUpMode, ticket, isSending, pendingPlan, sessionRecord, updateTicket, onClose, attachments])

  // ── Implement handler ─────────────────────────────────────────────
  const handleImplement = useCallback(async () => {
    if (!ticket.current_session_id || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      const pendingBeforeAction = pendingPlan
      const isClaudeCode = sessionRecord?.agent_sdk === 'claude-code'
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      await useSessionStore.getState().setSessionMode(sessionId, 'build')
      lastSendMode.set(sessionId, 'build')
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
      messageSendTimes.set(sessionId, Date.now())
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)

      // Clear plan_ready badge — ticket is back to working
      await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, { plan_ready: false, mode: 'build' })
      notifyKanbanSessionSync(sessionId, { type: 'implement' })

      if (!isClaudeCode && pendingBeforeAction) {
        toast.success('Implementation started')
        onClose()

        sendFollowupToSession({
          sessionId,
          prompt: buildSdkPlanImplementationPrompt(
            sessionRecord?.agent_sdk,
            pendingBeforeAction.planContent
          ),
          followUpMode: 'build',
          ticketId: ticket.id
        }).catch((err) => {
          const reason = err instanceof Error ? err.message : String(err)
          console.error('[KanbanTicketModal] background implement send failed:', err)
          toast.error(`Failed to start implementation: ${reason}`)
          useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
        })
        return
      }

      // Claude Code sessions approve the real pending plan request.
      if (pendingBeforeAction && (sessionRecord?.worktree_id || sessionRecord?.connection_id)) {
        let approvePath: string | null = null
        if (sessionRecord.worktree_id) {
          approvePath = findWorktreePathById(sessionRecord.worktree_id)
        } else if (sessionRecord.connection_id) {
          approvePath = useConnectionStore.getState().connections.find(c => c.id === sessionRecord.connection_id)?.path ?? null
        }
        if (!approvePath) {
          console.error(`[KanbanTicketModal] handleImplement: working path not found — worktree_id=${sessionRecord.worktree_id}, connection_id=${sessionRecord.connection_id}`)
          toast.error('Failed to approve plan: working path not found')
          return
        }
        await window.opencodeOps.planApprove(approvePath, sessionId, pendingBeforeAction.requestId)
      }

      toast.success('Implementation started')
      onClose()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error('[KanbanTicketModal] handleImplement failed:', err)
      toast.error(`Failed to start implementation: ${reason}`)
      useWorktreeStatusStore.getState().clearSessionStatus(ticket.current_session_id)
    } finally {
      setIsActioning(false)
    }
  }, [ticket.current_session_id, ticket.id, ticket.project_id, isActioning, pendingPlan, sessionRecord, onClose])

  // ── Handoff handler ───────────────────────────────────────────────
  const handleHandoff = useCallback(async () => {
    if (!ticket.current_session_id || !ticket.worktree_id || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      lastSendMode.delete(sessionId)

      const sessionStore = useSessionStore.getState()
      const result = await sessionStore.createSession(ticket.worktree_id, ticket.project_id)
      if (!result.success || !result.session) {
        toast.error(result.error ?? 'Failed to create handoff session')
        return
      }

      const handoffPrompt = `Implement the following plan\n${planContent}`
      await sessionStore.setSessionMode(result.session.id, 'build')
      sessionStore.setPendingMessage(result.session.id, handoffPrompt)

      // In sticky-tab mode, stay on the board; otherwise navigate to the new session
      const { BOARD_TAB_ID } = await import('@/stores/useSessionStore')
      if (useSettingsStore.getState().boardMode === 'sticky-tab') {
        sessionStore.setActiveSession(BOARD_TAB_ID)
      } else {
        sessionStore.setActiveSession(result.session.id)
      }

      // Clear plan_ready badge and link to new session
      await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, {
        current_session_id: result.session.id,
        plan_ready: false,
        mode: 'build'
      })

      toast.success('Handoff session created')
      onClose()
    } catch {
      toast.error('Failed to create handoff session')
    } finally {
      setIsActioning(false)
    }
  }, [ticket, isActioning, planContent, onClose])

  // ── Shared: eagerly connect, send /using-superpowers, queue follow-up for global listener ──
  const eagerSuperchargeStart = useCallback(async (
    worktreePath: string,
    newSessionId: string
  ) => {
    // Connect to OpenCode
    const connectResult = await window.opencodeOps.connect(worktreePath, newSessionId)
    if (!connectResult.success || !connectResult.sessionId) return

    // Persist the opencode session ID to Zustand + DB
    useSessionStore.getState().setOpenCodeSessionId(newSessionId, connectResult.sessionId)
    await window.db.session.update(newSessionId, {
      opencode_session_id: connectResult.sessionId
    })

    // Queue the follow-up for the global idle listener to dispatch after /using-superpowers completes
    useSessionStore.getState().setPendingFollowUpMessages(newSessionId, [
      'use the subagent development skill to implement the following plan:\n' + planContent
    ])

    // Set status tracking
    messageSendTimes.set(newSessionId, Date.now())
    userExplicitSendTimes.set(newSessionId, Date.now())
    snapshotTokenBaseline(newSessionId)
    lastSendMode.set(newSessionId, 'build')
    useWorktreeStatusStore.getState().setSessionStatus(newSessionId, 'working')

    // Send /using-superpowers — global listener handles follow-up on idle
    const model = resolveSessionModel(newSessionId)
    await window.opencodeOps.prompt(worktreePath, connectResult.sessionId, [
      { type: 'text', text: '/using-superpowers' }
    ], model)
  }, [planContent])

  // ── Supercharge handler (new branch) ────────────────────────────
  const handleSupercharge = useCallback(async () => {
    if (!ticket.current_session_id || !ticket.worktree_id || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      lastSendMode.delete(sessionId)

      // Abort the original backend session so it stops spinning
      if (worktreePath && opcSessionId) {
        useCommandApprovalStore.getState().clearSession(sessionId)
        await window.opencodeOps.abort(worktreePath, opcSessionId)
      }

      // Look up worktree and project for duplication
      const worktree = findWorktreeById(ticket.worktree_id!)
      if (!worktree) {
        toast.error('Could not find worktree')
        return
      }

      const project = useProjectStore.getState().projects.find((p) => p.id === worktree.project_id)
      if (!project) {
        toast.error('Could not find project')
        return
      }

      // Duplicate worktree
      const dupResult = await useWorktreeStore.getState().duplicateWorktree(
        project.id,
        project.path,
        project.name,
        worktree.branch_name,
        worktree.path
      )
      if (!dupResult.success || !dupResult.worktree) {
        toast.error(dupResult.error ?? 'Failed to duplicate worktree')
        return
      }

      // Create session in the new worktree
      const sessionStore = useSessionStore.getState()
      const sessionResult = await sessionStore.createSession(dupResult.worktree.id, project.id, undefined, undefined, { autoFocus: false })
      if (!sessionResult.success || !sessionResult.session) {
        toast.error(sessionResult.error ?? 'Failed to create supercharge session')
        return
      }

      const newSessionId = sessionResult.session.id
      await sessionStore.setSessionMode(newSessionId, 'build')

      // Notify kanban store: supercharge re-attaches ticket to new session
      notifyKanbanSessionSync(sessionId, {
        type: 'supercharge',
        newSessionId
      })

      toast.success('Supercharge session started')
      onClose()

      // Eagerly connect + send /using-superpowers in background; follow-up dispatched by global listener
      await eagerSuperchargeStart(dupResult.worktree.path, newSessionId)
    } catch {
      toast.error('Failed to supercharge')
    } finally {
      setIsActioning(false)
    }
  }, [ticket, isActioning, planContent, onClose, eagerSuperchargeStart, worktreePath, opcSessionId])

  // ── Supercharge Local handler (same worktree, no duplication) ───
  const handleSuperchargeLocal = useCallback(async () => {
    if (!ticket.current_session_id || !ticket.worktree_id || isActioning) return
    setIsActioning(true)

    try {
      const sessionId = ticket.current_session_id
      useSessionStore.getState().clearPendingPlan(sessionId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      lastSendMode.delete(sessionId)

      // Abort the original backend session so it stops spinning
      if (worktreePath && opcSessionId) {
        useCommandApprovalStore.getState().clearSession(sessionId)
        await window.opencodeOps.abort(worktreePath, opcSessionId)
      }

      const localWorktreePath = findWorktreePathById(ticket.worktree_id)
      if (!localWorktreePath) {
        toast.error('Could not find worktree path')
        return
      }

      // Create a new session in the SAME worktree
      const sessionStore = useSessionStore.getState()
      const sessionResult = await sessionStore.createSession(ticket.worktree_id, ticket.project_id, undefined, undefined, { autoFocus: false })
      if (!sessionResult.success || !sessionResult.session) {
        toast.error(sessionResult.error ?? 'Failed to create local supercharge session')
        return
      }

      const newSessionId = sessionResult.session.id
      await sessionStore.setSessionMode(newSessionId, 'build')

      // Re-attach ticket to the new session, clear plan_ready
      notifyKanbanSessionSync(sessionId, {
        type: 'supercharge',
        newSessionId
      })

      toast.success('Local supercharge session started')
      onClose()

      // Eagerly connect + send /using-superpowers in background; follow-up dispatched by global listener
      await eagerSuperchargeStart(localWorktreePath, newSessionId)
    } catch {
      toast.error('Failed to supercharge locally')
    } finally {
      setIsActioning(false)
    }
  }, [ticket, isActioning, planContent, onClose, eagerSuperchargeStart, worktreePath, opcSessionId])

  return (
    <div ref={dropZoneRef} className="relative contents">
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle className="flex items-center gap-2">
            {!dualPane && ticket.title}
            <span className="inline-flex items-center rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-[11px] font-medium text-violet-500">
              Plan ready
            </span>
          </DialogTitle>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>Review the plan and choose an action.</DialogDescription>
      </DialogHeader>

      <div
        data-testid="plan-review-content"
        className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-4 prose prose-sm dark:prose-invert max-w-none"
      >
        <MarkdownRenderer content={planContent} />
      </div>

      {/* Followup input — iterate on the plan */}
      <FollowupInput
        text={followUpText}
        onTextChange={setFollowUpText}
        attachments={attachments}
        onAttach={handleAttach}
        onRemoveAttachment={handleRemoveAttachment}
        followUpMode={followUpMode}
        onToggleMode={toggleMode}
        onSend={handleSendFollowup}
        isSending={isSending}
        placeholder="Iterate on the plan... (Enter to send)"
        testIdPrefix="plan-review"
        showInlineSendButton
        textareaRef={textareaRef}
      />

      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg border-2 border-dashed border-primary/50">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>
      )}

      {/* Action buttons only visible when ExitPlanMode is awaiting approval
          (matches SessionView's showPlanReadyImplementFab gating on !!pendingPlan) */}
      {!!pendingPlan && (
        <DialogFooter className="flex-shrink-0 gap-1.5 flex-wrap">
          <Button
            type="button"
            data-testid="plan-review-handoff-btn"
            disabled={isActioning || !ticket.worktree_id}
            onClick={handleHandoff}
            className="gap-1.5"
            variant="outline"
          >
            <ArrowRight className="h-3.5 w-3.5" />
            Handoff
          </Button>
          <Button
            type="button"
            data-testid="plan-review-supercharge-local-btn"
            disabled={isActioning || !ticket.worktree_id}
            onClick={handleSuperchargeLocal}
            className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
          >
            <Bolt className="h-3.5 w-3.5" />
            Supercharge
          </Button>
          <Button
            type="button"
            data-testid="plan-review-supercharge-btn"
            disabled={isActioning || !ticket.worktree_id}
            onClick={handleSupercharge}
            className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
            variant="outline"
          >
            <Zap className="h-3.5 w-3.5" />
            Supercharge (new branch)
          </Button>
          <Button
            type="button"
            data-testid="plan-review-implement-btn"
            disabled={isActioning}
            onClick={handleImplement}
            className="gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Hammer className="h-3.5 w-3.5" />
            Implement
          </Button>
        </DialogFooter>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// REVIEW MODE
// ════════════════════════════════════════════════════════════════════

function ReviewModeContent({
  ticket,
  onClose,
  moveTicket,
  updateTicket,
  dualPane = false
}: {
  ticket: KanbanTicket
  onClose: () => void
  moveTicket: (ticketId: string, projectId: string, column: 'todo' | 'in_progress' | 'review' | 'done', sortOrder: number) => Promise<void>
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
  dualPane?: boolean
}) {
  const worktree = useMemo(
    () => (ticket.worktree_id ? findWorktreeById(ticket.worktree_id) : null),
    [ticket.worktree_id]
  )
  const [followUpText, setFollowUpText] = useState('')
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>('build')
  const [isSending, setIsSending] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [resolvedWorktree, setResolvedWorktree] = useState<Worktree | null>(worktree)
  const [resolvedBaseBranch, setResolvedBaseBranch] = useState<string | null>(null)
  const [diffSummary, setDiffSummary] = useState<ReviewTicketDiffFile[]>([])
  const [diffSummaryLoading, setDiffSummaryLoading] = useState(false)
  const [diffSummaryError, setDiffSummaryError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)

  const handleAttach = useCallback((file: Omit<Attachment, 'id'>) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        return prev
      }
      return [...prev, { id: crypto.randomUUID(), ...file }]
    })
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleDropFiles = useCallback((files: FileList) => {
    for (const file of Array.from(files)) {
      if (attachments.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        break
      }
      if (isImageMime(file.type)) {
        const reader = new FileReader()
        reader.onload = () => {
          handleAttach({
            kind: 'data',
            name: file.name,
            mime: file.type,
            dataUrl: reader.result as string
          })
        }
        reader.readAsDataURL(file)
      } else {
        handleAttach({
          kind: 'path',
          name: file.name,
          mime: file.type || 'application/octet-stream',
          filePath: window.fileOps.getPathForFile(file)
        })
      }
    }
  }, [handleAttach, attachments.length])

  const { isDragging } = useDropZone({ onDrop: handleDropFiles, containerRef: dropZoneRef })
  const lifecycle = useLifecycleActions(ticket.worktree_id)
  const isCreatingPR = useGitStore((s) =>
    ticket.worktree_id ? s.creatingPRByWorktreeId.get(ticket.worktree_id) === true : false
  )
  const { pinAndActivate: pinAndActivateSession, lifecycleLoading } = usePinAndActivateSession(onClose)

  // Load live PR state so merge-button guard works (hide if already merged/closed)
  useEffect(() => {
    if (lifecycle.hasAttachedPR) lifecycle.loadPRState()
  }, [lifecycle.hasAttachedPR])

  // Display ticket description as context, with notice to view session for full conversation
  const reviewDescription = ticket.description ?? null

  // ── Run-script state ───────────────────────────────────────────────
  const project = useMemo(
    () => useProjectStore.getState().projects.find((p) => p.id === ticket.project_id) ?? null,
    [ticket.project_id]
  )

  useEffect(() => {
    let cancelled = false

    if (!ticket.worktree_id) {
      setResolvedWorktree(null)
      return
    }

    if (worktree) {
      setResolvedWorktree(worktree)
      return
    }

    window.db.worktree.get(ticket.worktree_id).then((dbWorktree) => {
      if (!cancelled) {
        setResolvedWorktree(dbWorktree ?? null)
      }
    }).catch(() => {
      if (!cancelled) {
        setResolvedWorktree(null)
      }
    })

    return () => {
      cancelled = true
    }
  }, [ticket.worktree_id, worktree])

  useEffect(() => {
    let cancelled = false

    if (!ticket.worktree_id || !resolvedWorktree) {
      setResolvedBaseBranch(null)
      return
    }

    ;(async () => {
      try {
        const defaultWorktrees = await window.db.worktree.getActiveByProject(ticket.project_id)
        const defaultWt = defaultWorktrees.find((w) => w.is_default)
        if (!cancelled) {
          setResolvedBaseBranch(resolvedWorktree.base_branch ?? defaultWt?.branch_name ?? null)
        }
      } catch {
        if (!cancelled) {
          setResolvedBaseBranch(resolvedWorktree.base_branch ?? null)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [ticket.project_id, ticket.worktree_id, resolvedWorktree])

  const hasRunScript = !!project?.run_script && !!resolvedWorktree

  useEffect(() => {
    let cancelled = false

    if (!dualPane || !resolvedWorktree?.path || !resolvedBaseBranch) {
      setDiffSummary([])
      setDiffSummaryError(null)
      setDiffSummaryLoading(false)
      return
    }

    const loadDiffSummary = async (): Promise<void> => {
      setDiffSummaryLoading(true)
      try {
        const result = await window.gitOps.getBranchDiffFiles(resolvedWorktree.path, resolvedBaseBranch)
        if (cancelled) return

        if (result.success) {
          setDiffSummary(result.files ?? [])
          setDiffSummaryError(null)
        } else {
          setDiffSummary([])
          setDiffSummaryError(result.error ?? 'Failed to load changed files')
        }
      } catch (error) {
        if (!cancelled) {
          setDiffSummary([])
          setDiffSummaryError(error instanceof Error ? error.message : 'Failed to load changed files')
        }
      } finally {
        if (!cancelled) {
          setDiffSummaryLoading(false)
        }
      }
    }

    loadDiffSummary()

    const cleanup = window.gitOps.onStatusChanged((event) => {
      if (event.worktreePath === resolvedWorktree.path) {
        void loadDiffSummary()
      }
    })

    return () => {
      cancelled = true
      cleanup()
    }
  }, [dualPane, resolvedWorktree?.path, resolvedBaseBranch])

  const runRunning = useScriptStore((s) =>
    ticket.worktree_id ? (s.scriptStates[ticket.worktree_id]?.runRunning ?? false) : false
  )

  const toggleMode = useCallback(() => {
    setFollowUpMode((prev) => prev === 'build' ? 'plan' : 'build')
  }, [])

  // Tab key toggles mode
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Only intercept when the modal is focused
        const modal = document.querySelector('[data-testid="kanban-ticket-modal"]')
        if (modal?.contains(document.activeElement)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          toggleMode()
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [toggleMode])

  // ── Send followup ─────────────────────────────────────────────────
  const handleSendFollowup = useCallback(async () => {
    if ((!followUpText.trim() && attachments.length === 0) || !ticket.current_session_id || isSending) return
    setIsSending(true)

    try {
      // Move ticket back to in_progress FIRST for immediate UI feedback.
      const kanbanStore = useKanbanStore.getState()
      const inProgressTickets = kanbanStore.getTicketsByColumn(ticket.project_id, 'in_progress')
      const sortOrder = kanbanStore.computeSortOrder(inProgressTickets, 0)
      await moveTicket(ticket.id, ticket.project_id, 'in_progress', sortOrder)

      // Capture values before closing modal
      const sessionId = ticket.current_session_id
      const prompt = followUpText.trim()
      const mode = followUpMode
      const ticketId = ticket.id
      const projectId = ticket.project_id
      const currentAttachments = [...attachments]

      // Mark the session as busy NOW so the kanban card shows the progress bar
      // the moment the modal closes (sendFollowupToSession would set this too,
      // but only after async DB calls — the card would look idle in between).
      messageSendTimes.set(sessionId, Date.now())
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)
      lastSendMode.set(sessionId, mode)
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')

      await updateTicket(ticketId, projectId, { mode, plan_ready: false })
      toast.success('Followup sent')
      onClose()

      // Send followup in background. sendFollowupToSession awaits the full
      // Claude session, but the UI is already updated (ticket moved, modal
      // closed). Errors surface via the session error pipeline.
      sendFollowupToSession({
        sessionId,
        prompt,
        followUpMode: mode,
        ticketId,
        attachments: currentAttachments,
      }).catch((err) => {
        console.error('[KanbanTicketModal] sendFollowupToSession failed:', err)
        const reason = err instanceof Error ? err.message : String(err)
        toast.error(`Failed to send followup: ${reason}`)
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
      })
    } catch (err) {
      console.error('[KanbanTicketModal] handleSendFollowup failed:', err)
      const reason = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to move ticket: ${reason}`)
    } finally {
      setIsSending(false)
      setAttachments([])
    }
  }, [followUpText, followUpMode, ticket, isSending, moveTicket, updateTicket, onClose, attachments])

  // ── Move to Done ──────────────────────────────────────────────────
  const handleMoveToDone = useCallback(async () => {
    // Merge-on-done: intercept for feature-branch worktrees
    if (ticket.worktree_id) {
      try {
        const worktree = await window.db.worktree.get(ticket.worktree_id)
        if (worktree) {
          const defaultWorktrees = await window.db.worktree.getActiveByProject(ticket.project_id)
          const defaultWt = defaultWorktrees.find((w) => w.is_default)
          const resolvedBaseBranch = worktree.base_branch ?? defaultWt?.branch_name

          if (resolvedBaseBranch && worktree.branch_name !== resolvedBaseBranch) {
            const kanbanStore = useKanbanStore.getState()
            const doneTickets = kanbanStore.getTicketsByColumn(ticket.project_id, 'done')
            const sortOrder = kanbanStore.computeSortOrder(doneTickets, doneTickets.length)
            kanbanStore.setPendingDoneMove({ ticketId: ticket.id, projectId: ticket.project_id, sortOrder })
            return
          }
        }
      } catch {
        // Fall through to normal move on error
      }
    }

    // Original logic
    try {
      const kanbanStore = useKanbanStore.getState()
      const doneTickets = kanbanStore.getTicketsByColumn(ticket.project_id, 'done')
      const sortOrder = kanbanStore.computeSortOrder(doneTickets, doneTickets.length)
      await moveTicket(ticket.id, ticket.project_id, 'done', sortOrder)
      toast.success('Ticket moved to Done')
    } catch {
      toast.error('Failed to move ticket')
    }
  }, [ticket, moveTicket])

  // ── Run / Stop handlers ────────────────────────────────────────────
  const handleRunScript = useCallback(() => {
    if (!ticket.worktree_id || !resolvedWorktree || !project?.run_script || runRunning) return
    const commands = project.run_script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
    fireRunScript(ticket.worktree_id, commands, resolvedWorktree.path)
    toast.success('Run script started')
  }, [ticket.worktree_id, resolvedWorktree, project, runRunning])

  const handleStopScript = useCallback(async () => {
    if (!ticket.worktree_id) return
    await killRunScript(ticket.worktree_id)
    toast.success('Run script stopped')
  }, [ticket.worktree_id])

  // Cmd+R / Ctrl+R toggles run/stop while the review modal is open
  useEffect(() => {
    if (!hasRunScript) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'r' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const modal = document.querySelector('[data-testid="kanban-ticket-modal"]')
        if (modal?.contains(document.activeElement)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          if (runRunning) {
            handleStopScript()
          } else {
            handleRunScript()
          }
        }
      }
    }
    window.addEventListener('keydown', handler, true) // capture phase
    return () => window.removeEventListener('keydown', handler, true)
  }, [hasRunScript, runRunning, handleRunScript, handleStopScript])

  return (
    <div ref={dropZoneRef} className="relative contents">
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle>{dualPane ? 'Review' : ticket.title}</DialogTitle>
          <div className="flex items-center gap-2">
            {lifecycle.hasAttachedPR && lifecycle.attachedPR && (
              <button
                onClick={() => lifecycle.openPRInBrowser()}
                className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/60 transition-colors"
              >
                <Github className="h-3 w-3" />
                #{lifecycle.attachedPR.number}
              </button>
            )}
            <JumpToSessionButton ticket={ticket} onClose={onClose} />
          </div>
        </div>
        <DialogDescription>Review the session output and provide followup.</DialogDescription>
      </DialogHeader>

      {!dualPane && (
        <div
          data-testid="review-content"
          className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-4 space-y-3"
        >
          {reviewDescription ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownRenderer content={reviewDescription} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Session completed.</p>
          )}
          <p data-testid="review-session-notice" className="text-xs text-muted-foreground/80">
            View the full session conversation by clicking &quot;Jump to session&quot; above.
          </p>
        </div>
      )}

      {dualPane && (
        <ReviewTicketDiffSummary
          baseBranch={resolvedBaseBranch}
          files={diffSummary}
          loading={diffSummaryLoading}
          error={diffSummaryError}
        />
      )}

      {/* Followup input area */}
      <FollowupInput
        text={followUpText}
        onTextChange={setFollowUpText}
        attachments={attachments}
        onAttach={handleAttach}
        onRemoveAttachment={handleRemoveAttachment}
        followUpMode={followUpMode}
        onToggleMode={toggleMode}
        onSend={handleSendFollowup}
        isSending={isSending}
        placeholder="Provide followup instructions... (Enter to send)"
        testIdPrefix="review"
        textareaRef={textareaRef}
      />

      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg border-2 border-dashed border-primary/50">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>
      )}

      <DialogFooter className="flex-shrink-0 flex-wrap gap-y-2">
        <Button
          type="button"
          variant="outline"
          data-testid="review-cancel-btn"
          onClick={onClose}
        >
          Cancel
        </Button>
        {hasRunScript && (
          <Button
            type="button"
            variant="outline"
            data-testid="review-run-btn"
            onClick={runRunning ? handleStopScript : handleRunScript}
            className={cn(
              'gap-1.5',
              runRunning
                ? 'border-red-500/30 text-red-500 hover:bg-red-500/10'
                : 'border-green-500/30 text-green-500 hover:bg-green-500/10'
            )}
          >
            {runRunning ? <><Square className="h-3.5 w-3.5" /> Stop</> : <><Play className="h-3.5 w-3.5" /> Run</>}
              <kbd className="ml-1 text-[10px] opacity-60 font-sans">⌘R</kbd>
          </Button>
        )}
        {ticket.worktree_id && (
          <Button
            type="button"
            variant="outline"
            className="gap-1.5"
            disabled={lifecycleLoading}
            onClick={() => pinAndActivateSession(() => lifecycle.createCodeReview())}
          >
            <FileSearch className="h-3.5 w-3.5" />
            Review
          </Button>
        )}
        {ticket.worktree_id && lifecycle.isGitHub && !lifecycle.hasAttachedPR && (
          isCreatingPR ? (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5"
              disabled
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Creating PR...
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="gap-1.5"
              disabled={lifecycleLoading}
              onClick={() => {
                const worktreePath = findWorktreePathById(ticket.worktree_id!)
                if (worktreePath) {
                  useGitStore.getState().setCreatePRModalOpen(true, {
                    worktreeId: ticket.worktree_id!,
                    worktreePath,
                  })
                } else {
                  toast.error('Could not find worktree path')
                }
              }}
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              Create PR
            </Button>
          )
        )}
        {ticket.worktree_id && lifecycle.isGitHub && lifecycle.hasAttachedPR &&
          lifecycle.prLiveState?.state !== 'MERGED' && lifecycle.prLiveState?.state !== 'CLOSED' && (
          <Button
            type="button"
            variant="outline"
            className="gap-1.5 bg-emerald-600/10 border-emerald-500/30 text-emerald-500 hover:bg-emerald-600/20"
            onClick={() => lifecycle.mergePR()}
            disabled={lifecycle.isMergingPR}
          >
            {lifecycle.isMergingPR ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitMerge className="h-3.5 w-3.5" />
            )}
            {lifecycle.isMergingPR ? 'Merging...' : 'Merge PR'}
          </Button>
        )}
        <Button
          type="button"
          data-testid="review-move-done-btn"
          variant="outline"
          onClick={handleMoveToDone}
        >
          Move to Done
        </Button>
        <Button
          type="button"
          data-testid="review-send-followup-btn"
          disabled={(!followUpText.trim() && attachments.length === 0) || isSending}
          onClick={handleSendFollowup}
          className={cn(
            'gap-1.5',
            followUpMode === 'build'
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-violet-600 hover:bg-violet-700 text-white'
          )}
        >
          <Send className="h-3.5 w-3.5" />
          {isSending ? 'Sending...' : 'Send'}
        </Button>
      </DialogFooter>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// ERROR MODE
// ════════════════════════════════════════════════════════════════════

function ErrorModeContent({
  ticket,
  onClose,
  dualPane = false
}: {
  ticket: KanbanTicket
  onClose: () => void
  dualPane?: boolean
}) {
  const [followUpText, setFollowUpText] = useState('')
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>('build')
  const [isSending, setIsSending] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const updateTicket = useKanbanStore((s) => s.updateTicket)
  const dropZoneRef = useRef<HTMLDivElement>(null)

  // Look up session status entry for error details
  const sessionStatusEntry = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (!ticket.current_session_id) return null
        return state.sessionStatuses[ticket.current_session_id] ?? null
      },
      [ticket.current_session_id]
    )
  )

  const handleAttach = useCallback((file: Omit<Attachment, 'id'>) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        return prev
      }
      return [...prev, { id: crypto.randomUUID(), ...file }]
    })
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleDropFiles = useCallback((files: FileList) => {
    for (const file of Array.from(files)) {
      if (attachments.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        break
      }
      if (isImageMime(file.type)) {
        const reader = new FileReader()
        reader.onload = () => {
          handleAttach({
            kind: 'data',
            name: file.name,
            mime: file.type,
            dataUrl: reader.result as string
          })
        }
        reader.readAsDataURL(file)
      } else {
        handleAttach({
          kind: 'path',
          name: file.name,
          mime: file.type || 'application/octet-stream',
          filePath: window.fileOps.getPathForFile(file)
        })
      }
    }
  }, [handleAttach, attachments.length])

  const { isDragging } = useDropZone({ onDrop: handleDropFiles, containerRef: dropZoneRef })

  const toggleMode = useCallback(() => {
    setFollowUpMode((prev) => prev === 'build' ? 'plan' : 'build')
  }, [])

  // ── Send followup for error retry ─────────────────────────────────
  const handleSendFollowup = useCallback(async () => {
    if ((!followUpText.trim() && attachments.length === 0) || !ticket.current_session_id || isSending) return
    setIsSending(true)

    try {
      await sendFollowupToSession({
        sessionId: ticket.current_session_id,
        prompt: followUpText.trim(),
        followUpMode,
        ticketId: ticket.id,
        attachments,
      })

      await updateTicket(ticket.id, ticket.project_id, { mode: followUpMode, plan_ready: false })
      toast.success('Retry sent')
      onClose()
    } catch {
      toast.error('Failed to send retry')
      // Reset session status so the kanban card stops showing a progress bar
      if (ticket.current_session_id) {
        useWorktreeStatusStore.getState().clearSessionStatus(ticket.current_session_id)
      }
    } finally {
      setIsSending(false)
      setAttachments([])
    }
  }, [followUpText, followUpMode, ticket, isSending, updateTicket, onClose, attachments])

  return (
    <div ref={dropZoneRef} className="relative contents">
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle className="flex items-center gap-2">
            {!dualPane && ticket.title}
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-[11px] font-medium text-red-500">
              <AlertCircle className="h-3 w-3" />
              Error
            </span>
          </DialogTitle>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>The session encountered an error. Send a followup to retry or correct.</DialogDescription>
      </DialogHeader>

      <div
        data-testid="error-info"
        className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400 space-y-1"
      >
        <p>The linked session reported an error. You can send a followup message to retry or provide corrections.</p>
        {sessionStatusEntry && (
          <p className="text-xs text-red-400/70" data-testid="error-status-detail">
            Status: {sessionStatusEntry.status}
            {sessionStatusEntry.word ? ` - ${sessionStatusEntry.word}` : ''}
            {sessionStatusEntry.durationMs ? ` (${Math.round(sessionStatusEntry.durationMs / 1000)}s ago)` : ''}
          </p>
        )}
        <p className="text-xs text-red-400/70">
          Session: {ticket.current_session_id}
          {' \u2014 use "Jump to session" for full details.'}
        </p>
      </div>

      {/* Followup input */}
      <FollowupInput
        text={followUpText}
        onTextChange={setFollowUpText}
        attachments={attachments}
        onAttach={handleAttach}
        onRemoveAttachment={handleRemoveAttachment}
        followUpMode={followUpMode}
        onToggleMode={toggleMode}
        onSend={handleSendFollowup}
        isSending={isSending}
        placeholder="Describe the fix or retry instructions... (Enter to send)"
        testIdPrefix="error"
      />

      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg border-2 border-dashed border-primary/50">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          data-testid="error-cancel-btn"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="error-send-followup-btn"
          disabled={(!followUpText.trim() && attachments.length === 0) || isSending}
          onClick={handleSendFollowup}
          className={cn(
            'gap-1.5',
            followUpMode === 'build'
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-violet-600 hover:bg-violet-700 text-white'
          )}
        >
          <Send className="h-3.5 w-3.5" />
          {isSending ? 'Sending...' : 'Send'}
        </Button>
      </DialogFooter>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// QUESTION MODE
// ════════════════════════════════════════════════════════════════════

function QuestionModeContent({
  ticket,
  onClose,
  activeQuestion,
  dualPane = false
}: {
  ticket: KanbanTicket
  onClose: () => void
  activeQuestion: QuestionRequest
  dualPane?: boolean
}) {
  const handleReply = useCallback(async (requestId: string, answers: string[][]) => {
    try {
      let questionPath: string | null = null
      if (ticket.worktree_id) {
        questionPath = findWorktreePathById(ticket.worktree_id)
      } else if (ticket.current_session_id) {
        questionPath = (await findSessionById(ticket.current_session_id))?.workingPath ?? null
      }
      await window.opencodeOps.questionReply(requestId, answers, questionPath || undefined)
      // Optimistically set session back to working so the progress bar resumes immediately
      if (ticket.current_session_id) {
        useWorktreeStatusStore.getState().setSessionStatus(
          ticket.current_session_id,
          isPlanLike(ticket.mode) ? 'planning' : 'working'
        )
      }
      onClose()
    } catch (err) {
      console.error('Failed to send answer:', err)
      toast.error('Failed to send answer')
    }
  }, [ticket.worktree_id, ticket.current_session_id, ticket.mode, onClose])

  const handleReject = useCallback(async (requestId: string) => {
    try {
      let questionPath: string | null = null
      if (ticket.worktree_id) {
        questionPath = findWorktreePathById(ticket.worktree_id)
      } else if (ticket.current_session_id) {
        questionPath = (await findSessionById(ticket.current_session_id))?.workingPath ?? null
      }
      await window.opencodeOps.questionReject(requestId, questionPath || undefined)
      // Optimistically set session back to working so the progress bar resumes immediately
      if (ticket.current_session_id) {
        useWorktreeStatusStore.getState().setSessionStatus(
          ticket.current_session_id,
          isPlanLike(ticket.mode) ? 'planning' : 'working'
        )
      }
      onClose()
    } catch (err) {
      console.error('Failed to dismiss question:', err)
      toast.error('Failed to dismiss question')
    }
  }, [ticket.worktree_id, ticket.current_session_id, ticket.mode, onClose])

  return (
    <>
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle className="flex items-center gap-2">
            Question from Agent
          </DialogTitle>
          <JumpToSessionButton ticket={ticket} onClose={onClose} />
        </div>
        <DialogDescription>{dualPane ? 'An agent question needs your attention.' : ticket.title}</DialogDescription>
      </DialogHeader>
      <QuestionPrompt
        key={activeQuestion.id}
        request={activeQuestion}
        onReply={handleReply}
        onReject={handleReject}
      />
    </>
  )
}

// ════════════════════════════════════════════════════════════════════
// JUMP TO SESSION BUTTON
// ════════════════════════════════════════════════════════════════════

function JumpToSessionButton({
  ticket,
  onClose,
  label = 'Jump to session',
  testId = 'jump-to-session-btn'
}: {
  ticket: KanbanTicket
  onClose: () => void
  label?: string
  testId?: string
}) {
  const handleJump = useCallback(() => {
    if (!ticket.current_session_id) return

    // Switch off board view
    const kanbanStore = useKanbanStore.getState()
    if (kanbanStore.isBoardViewActive) {
      kanbanStore.toggleBoardView()
    }

    // Select the ticket's worktree and sync session store
    if (ticket.worktree_id) {
      useWorktreeStore.getState().selectWorktree(ticket.worktree_id)
      useSessionStore.getState().setActiveWorktree(ticket.worktree_id)
    }

    // Focus the session tab
    useSessionStore.getState().setActiveSession(ticket.current_session_id)

    onClose()
  }, [ticket.current_session_id, ticket.worktree_id, onClose])

  if (!ticket.current_session_id) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testId}
      className="gap-1 text-xs text-muted-foreground hover:text-foreground"
      onClick={handleJump}
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {label}
    </Button>
  )
}
