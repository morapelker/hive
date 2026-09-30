import { isAgentCli } from '@shared/types/agent-sdk'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { resolveModelForSdk } from '@/stores/useSettingsStore'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import {
  PLAN_MODE_PREFIX,
  getSuperModePrefix,
  isPlanLike,
  isSuperMode,
  baseMode
} from '@/lib/constants'
import { toast } from '@/lib/toast'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { autoPinForBoardPrompt } from '@/lib/auto-pin'
import { startHivePromptTelemetry } from '@/lib/hive-enterprise-telemetry'
import { buildMessageParts } from '@/lib/file-attachment-utils'
import type { Attachment } from '@/components/sessions/AttachmentPreview'
import { dbApi } from '@/api/db-api'
import { opencodeApi } from '@/api/opencode-api'
import { terminalApi } from '@/api/terminal-api'
import type { KanbanTicket, Session, Worktree } from '../../../main/db/types'

export type FollowUpMode = 'build' | 'plan' | 'super-plan' | 'super-build'

/** The bare nudge sent to an errored session by the ticket's Continue button. */
export const CONTINUE_PROMPT = 'continue'

export function completionSendMode(mode: FollowUpMode): 'build' | 'plan' {
  return isPlanLike(mode) ? 'plan' : 'build'
}

function recordSuccessfulFollowupSideEffects(
  session: { project_id: string; worktree_id: string | null; connection_id?: string | null },
  sessionId: string,
  prompt: string,
  followUpMode: FollowUpMode,
  model?: ReturnType<typeof resolveSessionModel>
): void {
  void autoPinForBoardPrompt({
    projectId: session.project_id,
    worktreeId: session.worktree_id,
    connectionId: session.connection_id ?? null
  })
  startHivePromptTelemetry({
    sessionId,
    prompt,
    worktreeId: session.worktree_id,
    modelId: model?.modelID,
    providerId: model?.providerID,
    modelVariant: model?.variant,
    mode: followUpMode
  })
}

/** Find a worktree path by its ID across all projects */
export function findWorktreePathById(worktreeId: string): string | null {
  for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
    const wt = worktrees.find((w) => w.id === worktreeId)
    if (wt) return wt.path
  }
  return null
}

/** Find a session by ID across worktree and connection session maps, with DB fallback */
export async function findSessionById(sessionId: string): Promise<{
  session: {
    id: string
    project_id: string
    worktree_id: string | null
    connection_id: string | null
    opencode_session_id: string | null
    agent_sdk: string
    mode: FollowUpMode
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
  }
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
        worktreePath = (await dbApi.worktree.get<Worktree>(found.worktree_id))?.path ?? null
      }
      return { session: found, worktreePath, connectionId: null, workingPath: worktreePath }
    }
  }
  for (const [connId, sessions] of sessionStore.sessionsByConnection.entries()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) {
      const connectionPath =
        useConnectionStore.getState().connections.find((c) => c.id === connId)?.path ?? null
      return {
        session: found,
        worktreePath: null,
        connectionId: connId,
        workingPath: connectionPath
      }
    }
  }
  // DB fallback: session not in store (worktree not currently selected)
  const dbSession = await dbApi.session.get<Session>(sessionId)
  if (!dbSession) {
    console.warn(
      `[session-followup] findSessionById: session not found in store or DB — sessionId=${sessionId}`
    )
    return null
  }
  // Hydrate into the in-memory store so getWorktreeStatus() and
  // zustand selectors can find this session going forward.
  useSessionStore.getState().hydrateSession(dbSession)

  const worktreePath = dbSession.worktree_id
    ? ((await dbApi.worktree.get<Worktree>(dbSession.worktree_id))?.path ?? null)
    : null
  return {
    session: {
      id: dbSession.id,
      project_id: dbSession.project_id,
      worktree_id: dbSession.worktree_id,
      connection_id: dbSession.connection_id,
      opencode_session_id: dbSession.opencode_session_id,
      agent_sdk: dbSession.agent_sdk,
      mode: dbSession.mode,
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
export function resolveSessionModel(
  sessionId: string,
  sessionDataFallback?: {
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
    agent_sdk: string
  }
): { providerID: string; modelID: string; variant?: string } | undefined {
  // Primary: scan store (picks up mode-specific defaults applied by setSessionMode)
  const state = useSessionStore.getState()
  let session: {
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
    agent_sdk: string
  } | null = null
  for (const sessions of state.sessionsByWorktree.values()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found) {
      session = found
      break
    }
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

/**
 * Send a followup prompt to an existing session. CLI sessions (claude-code-cli,
 * codex-cli) receive it through their PTY; every other provider goes through
 * the agent SDK prompt API.
 */
export async function sendFollowupToSession(opts: {
  sessionId: string
  prompt: string
  followUpMode: FollowUpMode
  ticketId: string
  attachments?: Attachment[]
  /**
   * Caller already wrote the send stamps + working status for this attempt
   * (and may use its messageSendTimes stamp as a generation token to detect
   * newer sends) — don't overwrite them here.
   */
  skipSendBookkeeping?: boolean
}): Promise<void> {
  const result = await findSessionById(opts.sessionId)
  if (!result) {
    console.error(
      `[session-followup] sendFollowupToSession: session not found — sessionId=${opts.sessionId}`
    )
    throw new Error(`Session not found: ${opts.sessionId}`)
  }

  const { session, workingPath, connectionId } = result

  if (!workingPath) {
    console.error(
      `[session-followup] sendFollowupToSession: workingPath is null — sessionId=${opts.sessionId}, worktree_id=${session.worktree_id}, connection_id=${session.connection_id}`
    )
    throw new Error(`Working path not found for session: ${opts.sessionId}`)
  }

  // Set session mode so the agent SDK knows we're in plan mode (matches Tab toggle in SessionView).
  // This updates modeBySession, persists to DB, and applies mode-specific default model.
  await useSessionStore.getState().setSessionMode(opts.sessionId, opts.followUpMode)

  // Claude Code & Codex handle plan mode via the SDK — don't prepend the text prefix
  const skipPrefix = session.agent_sdk === 'claude-code' || session.agent_sdk === 'codex'
  const modePrefix = isSuperMode(opts.followUpMode)
    ? getSuperModePrefix(opts.followUpMode, session.agent_sdk)
    : opts.followUpMode === 'plan' && !skipPrefix
      ? PLAN_MODE_PREFIX
      : ''
  const fullPrompt = modePrefix + opts.prompt

  // Auto-revert super modes to their base mode immediately (one-shot mode).
  // The prefix is already captured in fullPrompt above.
  if (isSuperMode(opts.followUpMode)) {
    useSessionStore.getState().setSessionMode(opts.sessionId, baseMode(opts.followUpMode))
  }

  if (!opts.skipSendBookkeeping) {
    messageSendTimes.set(opts.sessionId, Date.now())
    userExplicitSendTimes.set(opts.sessionId, Date.now())
    snapshotTokenBaseline(opts.sessionId)
    lastSendMode.set(opts.sessionId, completionSendMode(opts.followUpMode))
    useWorktreeStatusStore
      .getState()
      .setSessionStatus(opts.sessionId, isPlanLike(opts.followUpMode) ? 'planning' : 'working')
  }
  bumpWorktreeLastMessage({
    worktreeId: session.worktree_id,
    connectionId: session.connection_id ?? connectionId
  })

  // Resolve model AFTER setSessionMode (which may have applied a mode-specific default)
  const model = resolveSessionModel(opts.sessionId, result.session)

  if (isAgentCli(session.agent_sdk)) {
    // The follow-up may target a session closed when its ticket entered Done.
    // Reactivate BEFORE delivering: this serializes behind any in-flight
    // close via the lifecycle lock (delivering first could hand the prompt to
    // a PTY the close is about to destroy), flips the row back to active, and
    // restores the tab so the working process has a restore entry and is not
    // culled by the modal-release cleanup.
    await useSessionStore.getState().reactivateSession(opts.sessionId)
    const delivery = unwrapEnvelope(
      await terminalApi.sendClaudeCliPrompt(opts.sessionId, fullPrompt)
    )
    if (!delivery.delivered) {
      const createResult = unwrapEnvelope(
        await terminalApi.createClaudeCli(opts.sessionId, { pendingPrompt: fullPrompt })
      )
      if (!createResult.success) {
        throw new Error(createResult.error ?? 'Failed to start CLI session')
      }
    }
    recordSuccessfulFollowupSideEffects(
      session,
      opts.sessionId,
      fullPrompt,
      opts.followUpMode,
      model
    )
    return
  }

  if (!session.opencode_session_id) {
    console.error(
      `[session-followup] sendFollowupToSession: opencode_session_id is null — sessionId=${opts.sessionId}`
    )
    throw new Error(`No opencode session ID for session: ${opts.sessionId}`)
  }

  // Same as the claude-code-cli branch: reactivate BEFORE reconnecting so the
  // revival serializes behind any in-flight close via the lifecycle lock —
  // otherwise a close could disconnect the implementer state while the
  // reconnect below is in flight and the prompt would fail "session not
  // found" on a session that was just restored as active.
  await useSessionStore.getState().reactivateSession(opts.sessionId)

  // Ensure the session is loaded in the agent SDK implementer's in-memory map.
  // SessionView does this on mount via initializeSession(), but the kanban
  // followup path bypasses SessionView entirely.  Without this, the Claude Code
  // implementer throws "session not found" because its Map was never populated.
  const reconnectResult = unwrapEnvelope(
    await opencodeApi.reconnect(workingPath, session.opencode_session_id, opts.sessionId)
  )
  if (!reconnectResult.success) {
    throw new Error(`Failed to reconnect to session: ${opts.sessionId}`)
  }

  const messageParts = opts.attachments?.length
    ? buildMessageParts(opts.attachments, fullPrompt)
    : [{ type: 'text' as const, text: fullPrompt }]

  const promptResult = unwrapEnvelope(
    await opencodeApi.prompt(workingPath, session.opencode_session_id, messageParts, model)
  )

  if (promptResult && !promptResult.success) {
    console.error(
      `[session-followup] sendFollowupToSession: prompt returned failure — error=${promptResult.error}`
    )
    throw new Error(promptResult.error || 'Failed to send prompt to session')
  }
  recordSuccessfulFollowupSideEffects(session, opts.sessionId, fullPrompt, opts.followUpMode, model)
}

/**
 * Nudge an errored ticket's session with a bare "continue" so it picks up
 * where the failed turn left off. Goes through sendFollowupToSession, so CLI
 * and SDK providers are both covered. Resolves to whether the send went out.
 */
export async function continueTicketSession(
  ticket: Pick<KanbanTicket, 'id' | 'project_id' | 'current_session_id' | 'mode'>
): Promise<boolean> {
  const sessionId = ticket.current_session_id
  if (!sessionId) {
    toast.error('No session linked to this ticket')
    return false
  }
  // Super modes are one-shot — continue in the base mode the ticket last ran in.
  const followUpMode: FollowUpMode = ticket.mode ? baseMode(ticket.mode) : 'build'

  try {
    await sendFollowupToSession({
      sessionId,
      prompt: CONTINUE_PROMPT,
      followUpMode,
      ticketId: ticket.id
    })
    await useKanbanStore
      .getState()
      .updateTicket(ticket.id, ticket.project_id, { mode: followUpMode, plan_ready: false })
    toast.success('Continue sent')
    return true
  } catch (err) {
    console.error('[session-followup] continueTicketSession failed:', err)
    toast.error('Failed to send continue')
    // Reset session status so the kanban card stops showing a progress bar
    useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
    return false
  }
}
