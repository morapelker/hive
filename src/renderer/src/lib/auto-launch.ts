import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { PLAN_MODE_PREFIX, getSuperPlanModePrefix, isPlanLike } from '@/lib/constants'
import { toast } from '@/lib/toast'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'
import { dbApi } from '@/api/db-api'
import { terminalApi } from '@/api/terminal-api'

type AutoLaunchMode = 'build' | 'plan' | 'super-plan'

interface AutoLaunchTicket {
  id: string
  project_id: string
  title: string
  pending_launch_config: string | null
}

interface PendingLaunchConfig {
  worktree: { type: 'new'; sourceBranch: string } | { type: 'existing'; worktreeId: string }
  prompt: string
  mode: AutoLaunchMode
  model: { providerID: string; modelID: string; variant?: string } | null
  sdk: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex'
  codexFastMode: boolean
  goalMode: boolean
  goalSuccessCriteria: string | null
}

function wrapGoalPrompt(prompt: string, criteria: string): string {
  const stripped = prompt.replace(/^\/goal\s+/, '')
  return `/goal ${stripped}. Goal success criteria: ${criteria}`
}

function composeAutoLaunchPrompt(
  config: PendingLaunchConfig,
  sessionAgentSdk: string | null | undefined,
  configGoalMode: boolean,
  configGoalSuccessCriteria: string | null,
  options: { claudeCli: boolean }
): string | null {
  const trimmedPrompt = config.prompt.trim()
  if (!trimmedPrompt) return null

  const skipPrefix =
    options.claudeCli ||
    sessionAgentSdk === 'claude-code' ||
    sessionAgentSdk === 'codex' ||
    sessionAgentSdk === 'claude-code-cli'
  const modePrefix =
    config.mode === 'super-plan'
      ? getSuperPlanModePrefix(sessionAgentSdk)
      : config.mode === 'plan' && !skipPrefix
        ? PLAN_MODE_PREFIX
        : ''
  const fullPrompt = modePrefix + trimmedPrompt

  return configGoalMode && configGoalSuccessCriteria
    ? wrapGoalPrompt(fullPrompt, configGoalSuccessCriteria)
    : fullPrompt
}

export async function autoLaunchTicket(ticket: AutoLaunchTicket): Promise<void> {
  if (!ticket.pending_launch_config) return

  let config: PendingLaunchConfig
  try {
    config = JSON.parse(ticket.pending_launch_config) as PendingLaunchConfig
  } catch {
    console.error('Failed to parse pending_launch_config for ticket:', ticket.id)
    return
  }
  const configGoalMode = config.goalMode === true
  const configGoalSuccessCriteria = config.goalSuccessCriteria?.trim() || null

  const project = useProjectStore.getState().projects.find((p) => p.id === ticket.project_id)
  if (!project) {
    console.error('Project not found for auto-launch:', ticket.project_id)
    return
  }

  try {
    // 1. Resolve worktree
    let worktreeId: string
    if (config.worktree.type === 'new') {
      const nameHint = canonicalizeTicketTitle(ticket.title)
      const result = await useWorktreeStore
        .getState()
        .createWorktreeFromBranch(
          ticket.project_id,
          project.path,
          project.name,
          config.worktree.sourceBranch,
          nameHint || undefined
        )
      if (!result.success || !result.worktree?.id) {
        toast.error(`Auto-launch failed: ${result.error || 'Could not create worktree'}`)
        return
      }
      worktreeId = result.worktree.id
    } else {
      worktreeId = config.worktree.worktreeId
    }

    // 2. Create session
    const modelOverride = config.model ? { ...config.model, agentSdk: config.sdk } : undefined
    const cliPendingPrompt =
      config.sdk === 'claude-code-cli'
        ? composeAutoLaunchPrompt(config, config.sdk, configGoalMode, configGoalSuccessCriteria, {
            claudeCli: true
          })
        : null
    const createOptions = {
      autoFocus: false,
      ...(modelOverride ? { modelOverride } : {}),
      ...(cliPendingPrompt ? { pendingMessage: cliPendingPrompt } : {})
    }
    const sessionResult = await useSessionStore
      .getState()
      .createSession(worktreeId, ticket.project_id, config.sdk, config.mode, createOptions)
    if (!sessionResult.success || !sessionResult.session) {
      toast.error(`Auto-launch failed: ${sessionResult.error || 'Could not create session'}`)
      return
    }

    const sessionId = sessionResult.session.id
    const sessionAgentSdk = sessionResult.session.agent_sdk

    // 3. Set status tracking
    messageSendTimes.set(sessionId, Date.now())
    userExplicitSendTimes.set(sessionId, Date.now())
    snapshotTokenBaseline(sessionId)
    lastSendMode.set(sessionId, isPlanLike(config.mode) ? 'plan' : 'build')
    useWorktreeStatusStore
      .getState()
      .setSessionStatus(sessionId, isPlanLike(config.mode) ? 'planning' : 'working')

    // 4. Apply model override
    const effectiveModel = config.model ?? undefined
    if (config.model) {
      await useSessionStore.getState().setSessionModel(sessionId, config.model)
    }

    // 5. Update ticket: clear pending config, set session + worktree
    await useKanbanStore.getState().updateTicket(ticket.id, ticket.project_id, {
      pending_launch_config: null,
      current_session_id: sessionId,
      worktree_id: worktreeId,
      mode: config.mode,
      goal_mode: configGoalMode,
      goal_success_criteria: configGoalMode ? configGoalSuccessCriteria : null
    })

    // 6. Trigger usage refresh
    useUsageStore.getState().fetchUsageForProvider(resolveDefaultUsageProvider(config.sdk))

    // 7. Toast notification
    toast.success(`Auto-launched: ${ticket.title}`)

    if (sessionAgentSdk === 'claude-code-cli') {
      const outboundPrompt =
        cliPendingPrompt ??
        composeAutoLaunchPrompt(
          config,
          sessionAgentSdk,
          configGoalMode,
          configGoalSuccessCriteria,
          {
            claudeCli: true
          }
        )

      if (config.mode === 'super-plan') {
        // Await so the persisted mode is committed before the main process
        // reads it in buildClaudeCliPtySpawn (createClaudeCli).
        await useSessionStore.getState().setSessionMode(sessionId, 'plan')
      }

      bumpWorktreeLastMessage({ worktreeId })
      const result = unwrapEnvelope(
        await terminalApi.createClaudeCli(sessionId, {
          pendingPrompt: outboundPrompt
        })
      )
      if (result.success && outboundPrompt) {
        useSessionStore.getState().dequeuePendingMessage(sessionId)
      }
      return
    }

    // 8. Connect to OpenCode and send prompt
    const allWorktrees = Array.from(useWorktreeStore.getState().worktreesByProject.values()).flat()
    const worktree = allWorktrees.find((w) => w.id === worktreeId)
    if (!worktree?.path) return

    const connectResult = unwrapEnvelope(await opencodeApi.connect(worktree.path, sessionId))
    if (!connectResult.success || !connectResult.sessionId) return

    useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
    await dbApi.session.update(sessionId, { opencode_session_id: connectResult.sessionId })

    // 9. Send prompt
    if (config.prompt.trim()) {
      const outboundPrompt = composeAutoLaunchPrompt(
        config,
        sessionAgentSdk,
        configGoalMode,
        configGoalSuccessCriteria,
        { claudeCli: false }
      )
      if (!outboundPrompt) return

      const promptOptions =
        sessionAgentSdk === 'codex' ? { codexFastMode: config.codexFastMode } : undefined

      if (config.mode === 'super-plan') {
        useSessionStore.getState().setSessionMode(sessionId, 'plan')
      }

      bumpWorktreeLastMessage({ worktreeId })
      unwrapEnvelope(
        await opencodeApi.prompt(
          worktree.path,
          connectResult.sessionId,
          [{ type: 'text', text: outboundPrompt }],
          effectiveModel,
          promptOptions
        )
      )
    }
  } catch (err) {
    console.error('Auto-launch failed for ticket:', ticket.id, err)
    toast.error(`Auto-launch failed for: ${ticket.title}`)
  }
}
