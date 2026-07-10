import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { resolveModelForSdk } from '@/stores/useSettingsStore'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { PLAN_MODE_PREFIX, getSuperPlanModePrefix, isPlanLike } from '@/lib/constants'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'
import { dbApi } from '@/api/db-api'
import { terminalApi } from '@/api/terminal-api'
import { startHivePromptTelemetry } from '@/lib/hive-enterprise-telemetry'
import { createPlanFile, exceedsGoalPromptLimit, planFilePrompt } from '@/lib/goal-plan-file'
import { FALLBACK_MODELS } from '@shared/model-resolution'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import type { KanbanTicketUpdate } from '../../../main/db/types'

type LaunchMode = 'build' | 'plan' | 'super-plan'

export interface LaunchModelConfig {
  sdk: HandoffAgentSdk
  model: { providerID: string; modelID: string; variant?: string } | null
  codexFastMode: boolean
}

export interface TicketLaunchSpec {
  ticketId: string
  projectId: string
  ticketTitle: string
  worktree:
    | { type: 'new'; sourceBranch: string; nameHint?: string }
    | { type: 'existing'; worktreeId: string }
  prompt: string
  mode: LaunchMode
  modelConfig: LaunchModelConfig
  goalMode: boolean
  goalSuccessCriteria: string | null
  /** Extra fields merged into the success updateTicket call (e.g. { pending_launch_config: null }). */
  ticketUpdateExtras?: Partial<KanbanTicketUpdate>
}

export interface TicketLaunchResult {
  success: boolean
  sessionId?: string
  worktreeId?: string
  error?: string
}

function wrapGoalPrompt(prompt: string, criteria: string): string {
  const stripped = prompt.replace(/^\/goal\s+/, '')
  return `/goal ${stripped}. Goal success criteria: ${criteria}`
}

function composeLaunchPrompt(
  rawPrompt: string,
  mode: LaunchMode,
  sessionAgentSdk: string | null | undefined,
  goalMode: boolean,
  goalSuccessCriteria: string | null,
  options: { claudeCli: boolean }
): string | null {
  const trimmedPrompt = rawPrompt.trim()
  if (!trimmedPrompt) return null

  const skipPrefix =
    options.claudeCli ||
    sessionAgentSdk === 'claude-code' ||
    sessionAgentSdk === 'codex' ||
    sessionAgentSdk === 'claude-code-cli'
  const modePrefix =
    mode === 'super-plan'
      ? getSuperPlanModePrefix(sessionAgentSdk)
      : mode === 'plan' && !skipPrefix
        ? PLAN_MODE_PREFIX
        : ''
  const fullPrompt = modePrefix + trimmedPrompt

  return goalMode && goalSuccessCriteria
    ? wrapGoalPrompt(fullPrompt, goalSuccessCriteria)
    : fullPrompt
}

/**
 * Resolve the provider/model/variant to stamp on the ticket badge. Priority:
 * (a) the resolved model persisted on the created session row, (b) the launch
 * config's explicit model, (c) the renderer's per-SDK resolution then the hard
 * SDK fallback. The last step guarantees non-null provider/model ids on every
 * launch.
 */
function resolveBadgeModel(
  modelConfig: LaunchModelConfig,
  session: { model_provider_id: string | null; model_id: string | null; model_variant: string | null }
): { providerID: string; modelID: string; variant: string | null } {
  if (session.model_provider_id && session.model_id) {
    return {
      providerID: session.model_provider_id,
      modelID: session.model_id,
      variant: session.model_variant ?? null
    }
  }
  if (modelConfig.model) {
    return {
      providerID: modelConfig.model.providerID,
      modelID: modelConfig.model.modelID,
      variant: modelConfig.model.variant ?? null
    }
  }
  const resolved = resolveModelForSdk(modelConfig.sdk) ?? FALLBACK_MODELS[modelConfig.sdk]
  return {
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    variant: resolved.variant ?? null
  }
}

/**
 * Headless ticket-launch pipeline shared by auto-launch (single model) and the
 * multi-model orchestrator. Resolves/creates the worktree, creates the session,
 * stamps status + ticket badge fields, and delivers the prompt per SDK. Every
 * failure — worktree/session/connect or a thrown error — is returned as
 * { success: false, error }; callers own all user-visible messaging.
 */
export async function launchTicketWithModel(spec: TicketLaunchSpec): Promise<TicketLaunchResult> {
  const { sdk, model, codexFastMode } = spec.modelConfig
  const goalMode = spec.goalMode === true
  const goalSuccessCriteria = spec.goalSuccessCriteria?.trim() || null
  // Working copy of the prompt — the goal-mode overflow branch may replace it
  // with a short "Implement PLAN_{uuid}.md" pointer.
  let prompt = spec.prompt

  try {
    // 1. Resolve worktree
    let worktreeId: string
    if (spec.worktree.type === 'new') {
      const project = useProjectStore.getState().projects.find((p) => p.id === spec.projectId)
      if (!project) {
        return { success: false, error: 'Project not found' }
      }
      const nameHint = spec.worktree.nameHint ?? canonicalizeTicketTitle(spec.ticketTitle)
      const result = await useWorktreeStore
        .getState()
        .createWorktreeFromBranch(
          spec.projectId,
          project.path,
          project.name,
          spec.worktree.sourceBranch,
          nameHint || undefined
        )
      if (!result.success || !result.worktree?.id) {
        return { success: false, error: result.error || 'Could not create worktree' }
      }
      worktreeId = result.worktree.id
    } else {
      worktreeId = spec.worktree.worktreeId
    }

    // Resolve the worktree record once — needed for plan-file creation and the
    // OpenCode connect below. Newly created worktrees are already in the store.
    const findWorktree = (): { path: string } | undefined =>
      Array.from(useWorktreeStore.getState().worktreesByProject.values())
        .flat()
        .find((w) => w.id === worktreeId)
    let worktree = findWorktree()
    if (!worktree) {
      // The project's worktrees may not be loaded yet (e.g. auto-launch firing
      // from a store subscription shortly after startup)
      await useWorktreeStore.getState().loadWorktrees(spec.projectId)
      worktree = findWorktree()
    }

    // Oversized goal prompts get rejected by the CLI — persist the full ticket
    // prompt as PLAN_{uuid}.md in the worktree root and send a short
    // "Implement PLAN_{uuid}.md" goal prompt instead (the /goal wrapper stays).
    if (goalMode && goalSuccessCriteria && worktree?.path) {
      const composed = composeLaunchPrompt(prompt, spec.mode, sdk, goalMode, goalSuccessCriteria, {
        claudeCli: sdk === 'claude-code-cli'
      })
      if (exceedsGoalPromptLimit(composed)) {
        const fileName = await createPlanFile(worktree.path, prompt.trim())
        prompt = planFilePrompt(fileName)
      }
    }

    // 2. Create session
    const modelOverride = model ? { ...model, agentSdk: sdk } : undefined
    const cliPendingPrompt =
      sdk === 'claude-code-cli'
        ? composeLaunchPrompt(prompt, spec.mode, sdk, goalMode, goalSuccessCriteria, {
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
      .createSession(worktreeId, spec.projectId, sdk, spec.mode, createOptions)
    if (!sessionResult.success || !sessionResult.session) {
      return { success: false, error: sessionResult.error || 'Could not create session' }
    }

    const session = sessionResult.session
    const sessionId = session.id
    const sessionAgentSdk = session.agent_sdk

    // 3. Set status tracking
    messageSendTimes.set(sessionId, Date.now())
    userExplicitSendTimes.set(sessionId, Date.now())
    snapshotTokenBaseline(sessionId)
    lastSendMode.set(sessionId, isPlanLike(spec.mode) ? 'plan' : 'build')
    useWorktreeStatusStore
      .getState()
      .setSessionStatus(sessionId, isPlanLike(spec.mode) ? 'planning' : 'working')

    // 4. Apply model override
    const effectiveModel = model ?? undefined
    if (model) {
      await useSessionStore.getState().setSessionModel(sessionId, model)
    }

    // 5. Update ticket: clear pending config (via extras), set session + worktree,
    //    and stamp the model badge fields.
    const badge = resolveBadgeModel(spec.modelConfig, session)
    await useKanbanStore.getState().updateTicket(spec.ticketId, spec.projectId, {
      current_session_id: sessionId,
      worktree_id: worktreeId,
      mode: spec.mode,
      goal_mode: goalMode,
      goal_success_criteria: goalMode ? goalSuccessCriteria : null,
      model_provider_id: badge.providerID,
      model_id: badge.modelID,
      model_variant: badge.variant,
      ...spec.ticketUpdateExtras
    })

    // 6. Trigger usage refresh
    useUsageStore.getState().fetchUsageForProvider(resolveDefaultUsageProvider(sdk))

    if (sessionAgentSdk === 'claude-code-cli') {
      const outboundPrompt =
        cliPendingPrompt ??
        composeLaunchPrompt(prompt, spec.mode, sessionAgentSdk, goalMode, goalSuccessCriteria, {
          claudeCli: true
        })

      if (spec.mode === 'super-plan') {
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
      return { success: true, sessionId, worktreeId }
    }

    // 7. Connect to OpenCode and send prompt
    if (!worktree?.path) return { success: true, sessionId, worktreeId }

    const connectResult = unwrapEnvelope(await opencodeApi.connect(worktree.path, sessionId))
    if (!connectResult.success || !connectResult.sessionId) {
      return { success: false, error: connectResult.error || 'Could not start session' }
    }

    useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
    await dbApi.session.update(sessionId, { opencode_session_id: connectResult.sessionId })

    // 8. Send prompt
    if (prompt.trim()) {
      const outboundPrompt = composeLaunchPrompt(
        prompt,
        spec.mode,
        sessionAgentSdk,
        goalMode,
        goalSuccessCriteria,
        { claudeCli: false }
      )
      if (!outboundPrompt) return { success: true, sessionId, worktreeId }

      const promptOptions = sessionAgentSdk === 'codex' ? { codexFastMode } : undefined

      if (spec.mode === 'super-plan') {
        useSessionStore.getState().setSessionMode(sessionId, 'plan')
      }

      bumpWorktreeLastMessage({ worktreeId })
      startHivePromptTelemetry({
        sessionId,
        prompt: outboundPrompt,
        worktreeId,
        modelId: effectiveModel?.modelID,
        providerId: effectiveModel?.providerID,
        modelVariant: effectiveModel?.variant,
        mode: spec.mode,
        // Auto-launch is not an interactive send from a tab.
        source: 'other'
      })
      unwrapEnvelope(
        await opencodeApi.prompt(
          worktree.path,
          connectResult.sessionId,
          [{ type: 'text', text: outboundPrompt }],
          // Strip `agentSdk` — the prompt RPC model schema is .strict() and
          // rejects it ("RPC parameters failed validation").
          effectiveModel
            ? {
                providerID: effectiveModel.providerID,
                modelID: effectiveModel.modelID,
                variant: effectiveModel.variant
              }
            : undefined,
          promptOptions
        )
      )
    }

    return { success: true, sessionId, worktreeId }
  } catch (err) {
    const detail = err instanceof Error ? err.message : null
    return { success: false, error: detail || 'Could not launch session' }
  }
}
