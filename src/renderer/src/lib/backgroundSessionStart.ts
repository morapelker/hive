import type { SelectedModel } from '@/stores/useSettingsStore'
import { resolveModelForSdk } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { lastSendMode, messageSendTimes, userExplicitSendTimes } from '@/lib/message-send-times'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'
import { dbApi } from '@/api/db-api'

type SessionModelSource = {
  id: string
  agent_sdk: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal'
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
  if (session?.agent_sdk === 'claude-code-cli') {
    useSessionStore.getState().setPendingMessage(opts.sessionId, opts.prompt)
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
}
