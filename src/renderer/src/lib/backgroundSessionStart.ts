import type { SelectedModel } from '@/stores/useSettingsStore'
import { type AgentSdk, isCliAgentSdk } from '@shared/types/agent-sdk'
import { resolveModelForSdk } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { lastSendMode, messageSendTimes, userExplicitSendTimes } from '@/lib/message-send-times'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { markClaudeCliPromptStarted } from '@/lib/claude-cli-send-tracking'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'
import { dbApi } from '@/api/db-api'
import { terminalApi } from '@/api/terminal-api'
import { startHivePromptTelemetry } from '@/lib/hive-enterprise-telemetry'

type SessionModelSource = {
  id: string
  agent_sdk: AgentSdk
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
}

function findSessionModelSource(sessionId: string): SessionModelSource | null {
  const state = useSessionStore.getState()

  for (const sessions of state.sessionsByWorktree.values()) {
    const found = sessions.find((session) => session.id === sessionId)
    if (found) return found
  }

  for (const sessions of state.sessionsByConnection.values()) {
    const found = sessions.find((session) => session.id === sessionId)
    if (found) return found
  }

  return null
}

export function resolveBackgroundSessionModel(sessionId: string): SelectedModel | undefined {
  const session = findSessionModelSource(sessionId)
  if (session?.model_provider_id && session.model_id) {
    return {
      providerID: session.model_provider_id,
      modelID: session.model_id,
      variant: session.model_variant ?? undefined
    }
  }

  const agentSdk = session?.agent_sdk ?? 'opencode'
  return resolveModelForSdk(agentSdk) ?? undefined
}

export async function startBackgroundSessionPrompt(opts: {
  worktreePath: string
  sessionId: string
  prompt: string
  bumpTarget: { worktreeId?: string | null; connectionId?: string | null }
}): Promise<void> {
  const session = findSessionModelSource(opts.sessionId)
  if (isCliAgentSdk(session?.agent_sdk)) {
    // If the session already has a live PTY, deliver straight into it (a
    // follow-up to a running CLI session).
    const { delivered } = unwrapEnvelope(
      await terminalApi.sendClaudeCliPrompt(opts.sessionId, opts.prompt)
    )
    if (delivered) {
      markClaudeCliPromptStarted(opts.sessionId)
      bumpWorktreeLastMessage(opts.bumpTarget)
      return
    }
    // No live PTY yet. This helper *starts* background-created sessions (e.g. a
    // Telegram plan handoff, created with autoFocus:false) — and unlike a
    // foreground launch there is no terminal view that will mount and spawn the
    // CLI. So start the PTY ourselves with the prompt as its initial argument,
    // mirroring the ticket-modal CLI handoff (ClaudeCliSessionView). Merely
    // queuing would leave the handoff idle until the user manually opened its
    // tab, even though a "handoff started" toast was already shown.
    const result = unwrapEnvelope(
      await terminalApi.createClaudeCli(opts.sessionId, { pendingPrompt: opts.prompt })
    )
    if (!result.success) {
      // Spawn failed — fall back to queuing so a later manual open still delivers it.
      useSessionStore.getState().setPendingMessage(opts.sessionId, opts.prompt)
      return
    }
    useSessionStore.getState().dequeuePendingMessage(opts.sessionId)
    markClaudeCliPromptStarted(opts.sessionId)
    bumpWorktreeLastMessage(opts.bumpTarget)
    return
  }

  const connectResult = unwrapEnvelope(await opencodeApi.connect(opts.worktreePath, opts.sessionId))
  if (!connectResult.success || !connectResult.sessionId) {
    throw new Error(connectResult.error ?? 'Failed to connect to handoff session')
  }

  useSessionStore.getState().setOpenCodeSessionId(opts.sessionId, connectResult.sessionId)
  await dbApi.session.update(opts.sessionId, {
    opencode_session_id: connectResult.sessionId
  })

  messageSendTimes.set(opts.sessionId, Date.now())
  userExplicitSendTimes.set(opts.sessionId, Date.now())
  snapshotTokenBaseline(opts.sessionId)
  lastSendMode.set(opts.sessionId, 'build')
  useWorktreeStatusStore.getState().setSessionStatus(opts.sessionId, 'working')
  bumpWorktreeLastMessage(opts.bumpTarget)

  const model = resolveBackgroundSessionModel(opts.sessionId)
  startHivePromptTelemetry({
    sessionId: opts.sessionId,
    prompt: opts.prompt,
    worktreeId: opts.bumpTarget.worktreeId,
    modelId: model?.modelID,
    providerId: model?.providerID,
    modelVariant: model?.variant,
    mode: 'build',
    // Background/remote (e.g. Telegram) start — not an interactive tab send.
    source: 'other'
  })
  const result = unwrapEnvelope(
    await opencodeApi.prompt(
      opts.worktreePath,
      connectResult.sessionId,
      [{ type: 'text', text: opts.prompt }],
      model
    )
  )
  if (!result.success) {
    throw new Error(result.error ?? 'Failed to start background session prompt')
  }

  useSessionStore.getState().dequeuePendingMessage(opts.sessionId)
}
