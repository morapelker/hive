import { useKanbanStore } from '@/stores/useKanbanStore'
import { isAgentCli, isCodexCli } from '@shared/types/agent-sdk'
import { useSessionStore, type Session } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { resolveModelForSdk, useSettingsStore } from '@/stores/useSettingsStore'
import {
  CUSTOM_MODEL_PROVIDER_ID,
  findCustomProvider,
  getCustomProviderModelDisplayName,
  matchCustomProviderModel
} from '@shared/types/custom-provider'
import { resolveCustomProviderSelectedModel } from '@/lib/handoffSelection'
import { autoPinForBoardPrompt } from '@/lib/auto-pin'
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
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'
import { isDocumentRunTicket } from '@shared/document-flow/run-ticket'
import { shellCommandIdOfTicket } from '@shared/lib/shell-commands'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'
import { dbApi } from '@/api/db-api'
import { terminalApi } from '@/api/terminal-api'
import { startHivePromptTelemetry } from '@/lib/hive-enterprise-telemetry'
import { createPlanFile, exceedsGoalPromptLimit, planFilePrompt } from '@/lib/goal-plan-file'
import { FALLBACK_MODELS } from '@shared/model-resolution'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import type { KanbanTicketUpdate } from '../../../main/db/types'

type LaunchMode = 'build' | 'plan' | 'super-plan' | 'super-build'

/** Short CLI name for launch errors ('Claude CLI' / 'Codex CLI'). */
function cliDisplayName(sdk: string | null | undefined): string {
  return isCodexCli(sdk) ? 'Codex CLI' : 'Claude CLI'
}

export interface LaunchModelConfig {
  sdk: HandoffAgentSdk
  model: { providerID: string; modelID: string; variant?: string } | null
  codexFastMode: boolean
  /** claude-code-cli only: launch through this custom provider's command. */
  customProviderId?: string | null
}

export interface TicketLaunchSpec {
  ticketId: string
  projectId: string
  ticketTitle: string
  worktree:
    | {
        type: 'new'
        sourceBranch: string
        nameHint?: string
        /** Cut the branch from this ref even when `sourceBranch` is checked out in a worktree. */
        baseRef?: string
        /** Overrides the "auto-pull before worktree" setting for this launch. */
        autoPull?: boolean
        /** false: keep the user's selected worktree and open file tabs (background launch). */
        select?: boolean
      }
    | { type: 'existing'; worktreeId: string }
    /**
     * A connection project: a NEW instance with one worktree per member project, each cut
     * from `baseRef` and recorded against `sourceBranch` (never auto-pulled), all named after
     * `nameHint`. The session runs on the instance (lib/connection-project-launch).
     */
    | {
        type: 'connection-new'
        savedProjectId: string
        members: { projectId: string; sourceBranch: string; baseRef: string }[]
        nameHint: string
      }
    /** A connection project: a session on an instance that already exists. */
    | { type: 'existing-connection'; connectionId: string }
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
  /** A connection launch: the instance the session runs on. */
  connectionId?: string
  /** A `connection-new` launch: the member worktrees the instance was created over, in member order. */
  worktrees?: { projectId: string; worktreeId: string; branchName: string }[]
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
    sessionAgentSdk === 'claude-code-cli' ||
    sessionAgentSdk === 'codex-cli'
  const modePrefix = isSuperMode(mode)
    ? getSuperModePrefix(mode, sessionAgentSdk)
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
 * launch. Exported: WorktreePickerModal's interactive launch paths stamp with
 * the same priority — the session row records what ACTUALLY runs (session
 * creation resolves through its own chain and can differ from the picker's).
 */
export function resolveBadgeModel(
  modelConfig: LaunchModelConfig,
  session: {
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
  }
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
 * Badge for a custom-provider launch. With a chosen declared model, stamp its
 * display name (+ effort) — that is what actually runs. Otherwise the
 * provider's command decides the real model (often via alias flags), so the
 * session row's resolved claude model would mislead — stamp the provider's
 * display name instead. Returns null when the id doesn't reference a known
 * provider.
 */
export function resolveCustomProviderBadge(
  customProviderId: string | null | undefined,
  model?: { providerID: string; modelID: string; variant?: string | null } | null
): { providerID: string; modelID: string; variant: string | null } | null {
  if (!customProviderId) return null
  const provider = findCustomProvider(useSettingsStore.getState().customProviders, customProviderId)
  if (!provider) return null
  const declaredModel =
    model?.providerID === CUSTOM_MODEL_PROVIDER_ID
      ? matchCustomProviderModel(provider.models, model.modelID)
      : null
  if (declaredModel) {
    return {
      providerID: CUSTOM_MODEL_PROVIDER_ID,
      modelID: getCustomProviderModelDisplayName(declaredModel),
      variant: model?.variant ?? null
    }
  }
  return { providerID: 'custom', modelID: provider.name || 'Custom Provider', variant: null }
}

/**
 * A launch config can outlive its provider (queued tickets, saved handoff
 * overrides). Resolve the id against current settings — a deleted provider
 * degrades to a plain claude-code-cli launch instead of failing at spawn.
 */
function resolveLaunchCustomProviderId(
  sdk: HandoffAgentSdk,
  customProviderId: string | null | undefined
): string | null {
  if (sdk !== 'claude-code-cli' || !customProviderId) return null
  const provider = findCustomProvider(useSettingsStore.getState().customProviders, customProviderId)
  if (!provider || !provider.command.trim()) {
    console.warn('Custom provider no longer exists; launching plain Claude CLI:', customProviderId)
    return null
  }
  return provider.id
}

/**
 * Headless ticket-launch pipeline shared by auto-launch (single model) and the
 * multi-model orchestrator. Resolves/creates the worktree, creates the session,
 * stamps status + ticket badge fields, and delivers the prompt per SDK. Every
 * failure — worktree/session/connect or a thrown error — is returned as
 * { success: false, error }; callers own all user-visible messaging.
 */
export async function launchTicketWithModel(spec: TicketLaunchSpec): Promise<TicketLaunchResult> {
  const goalMode = spec.goalMode === true
  const goalSuccessCriteria = spec.goalSuccessCriteria?.trim() || null
  // Snapshot of the worktree id as soon as it is resolved, hoisted above the
  // try so the catch fallback can still report it.
  let createdWorktreeId: string | undefined

  // A document run's ticket has no session of its own, whoever asks for one
  const launchedTicket = useKanbanStore
    .getState()
    .tickets.get(spec.projectId)
    ?.find((t) => t.id === spec.ticketId)
  if (isDocumentRunTicket(launchedTicket)) {
    return { success: false, error: 'The ticket of a document run cannot be launched.' }
  }
  // A shell command's ticket runs its command (lib/shell-command-ticket): its text is
  // never an agent prompt, whoever asks for the launch. Tickets from before the marker
  // are known through their session's run.
  if (
    shellCommandIdOfTicket(launchedTicket) ||
    (launchedTicket?.current_session_id &&
      launchedTicket.current_session_id in useShellCommandRunStore.getState().runsBySession)
  ) {
    return {
      success: false,
      error: 'A shell command ticket runs its command: drag it to In Progress on the board.'
    }
  }

  // A connection project's ticket runs on an instance, not in a worktree: the connection
  // pipeline owns the instance and the session, and reports its failures the same way.
  if (spec.worktree.type === 'connection-new' || spec.worktree.type === 'existing-connection') {
    return launchTicketOnConnection(spec, spec.worktree)
  }

  try {
    // 1. Resolve worktree
    let worktreeId: string
    if (spec.worktree.type === 'new') {
      const project = useProjectStore.getState().projects.find((p) => p.id === spec.projectId)
      if (!project) {
        return { success: false, error: 'Project not found' }
      }
      const nameHint = spec.worktree.nameHint ?? canonicalizeTicketTitle(spec.ticketTitle)
      const { baseRef, autoPull, select } = spec.worktree
      const worktreeOptions = {
        ...(baseRef === undefined ? {} : { baseRef }),
        ...(autoPull === undefined ? {} : { autoPull }),
        ...(select === undefined ? {} : { select })
      }
      const createWorktreeFromBranch = useWorktreeStore.getState().createWorktreeFromBranch
      // The options argument is passed only when one is set, so plain launches make the
      // exact five-argument call they always did.
      const result =
        Object.keys(worktreeOptions).length > 0
          ? await createWorktreeFromBranch(
              spec.projectId,
              project.path,
              project.name,
              spec.worktree.sourceBranch,
              nameHint || undefined,
              worktreeOptions
            )
          : await createWorktreeFromBranch(
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
    createdWorktreeId = worktreeId

    // Setting-gated auto-pin so the ticket shows on the pinned board. Fired
    // here (not by callers) because 'current-branch' mode needs the worktree
    // the session is sent on, which only exists from this point. Idempotent,
    // so a multi-model batch re-running this per model is a no-op in
    // 'root-branch' mode and pins each model's worktree in 'current-branch'.
    void autoPinForBoardPrompt({ projectId: spec.projectId, worktreeId })

    // The session itself: created, stamped on the ticket, then started with the prompt.
    const result = await launchSessionWithModel({
      projectId: spec.projectId,
      worktreeId,
      prompt: spec.prompt,
      mode: spec.mode,
      modelConfig: spec.modelConfig,
      goalMode,
      goalSuccessCriteria,
      // Update ticket: clear pending config (via extras), set session + worktree,
      // and stamp the model badge fields. variant_group_id defaults to null
      // here (a single-model (re)launch shouldn't keep claiming membership in
      // a stale multi-launch group) — the multi-model orchestrator overrides
      // it back via ticketUpdateExtras, which must win, hence the field
      // ordering below.
      onSessionCreated: async ({ session, customProviderId, model }) => {
        const badge =
          resolveCustomProviderBadge(customProviderId, model) ??
          resolveBadgeModel(spec.modelConfig, session)
        await useKanbanStore.getState().updateTicket(spec.ticketId, spec.projectId, {
          current_session_id: session.id,
          worktree_id: worktreeId,
          mode: spec.mode,
          goal_mode: goalMode,
          goal_success_criteria: goalMode ? goalSuccessCriteria : null,
          model_provider_id: badge.providerID,
          model_id: badge.modelID,
          model_variant: badge.variant,
          variant_group_id: null,
          ...spec.ticketUpdateExtras
        })
      }
    })
    // worktreeId is included on every outcome so a just-created worktree stays
    // visible to the caller — nothing else records it when the session could
    // not be created (the ticket link is only stamped after session creation).
    return { ...result, worktreeId }
  } catch (err) {
    const detail = err instanceof Error ? err.message : null
    return {
      success: false,
      error: detail || 'Could not launch session',
      ...(createdWorktreeId ? { worktreeId: createdWorktreeId } : {})
    }
  }
}

type ConnectionWorktreeSpec = Extract<
  TicketLaunchSpec['worktree'],
  { type: 'connection-new' | 'existing-connection' }
>

/**
 * The connection half of `launchTicketWithModel`: resolve or create the instance, then start
 * the ticket's session on it through lib/connection-project-launch (which also stamps the
 * ticket, names and pins the instance). Imported lazily: that module builds on this one.
 */
async function launchTicketOnConnection(
  spec: TicketLaunchSpec,
  target: ConnectionWorktreeSpec
): Promise<TicketLaunchResult> {
  const goalMode = spec.goalMode === true
  const goalSuccessCriteria = spec.goalSuccessCriteria?.trim() || null
  try {
    const launch = await import('@/lib/connection-project-launch')
    const { getMemberProjects } = await import('@/lib/connection-project')
    const savedProjectId = target.type === 'connection-new' ? target.savedProjectId : spec.projectId
    const project = useProjectStore.getState().projects.find((p) => p.id === savedProjectId)
    if (!project) return { success: false, error: 'Project not found' }

    let resolved: Awaited<ReturnType<typeof launch.resolveConnectionForLaunch>>
    if (target.type === 'connection-new') {
      resolved = await launch.createInstanceWithNewWorktrees({
        savedProjectId,
        memberProjects: getMemberProjects(project),
        nameHint: target.nameHint || canonicalizeTicketTitle(spec.ticketTitle) || undefined,
        // `baseRef` cuts each member's branch from the commit the caller verified, without
        // auto-pull, which could move the user's checkout of the source branch.
        members: target.members.map((member) => ({
          projectId: member.projectId,
          sourceBranch: member.sourceBranch,
          baseRef: member.baseRef,
          autoPull: false
        }))
      })
    } else {
      resolved = await launch.resolveConnectionForLaunch({
        savedProjectId,
        memberProjects: getMemberProjects(project),
        target: { type: 'existing-connection', connectionId: target.connectionId }
      })
    }
    if (!resolved.connectionId) {
      return { success: false, error: resolved.error || 'Failed to resolve connection' }
    }
    const { connectionId, connectionPath } = resolved
    const worktrees = resolved.worktrees?.map(({ projectId, worktreeId, branchName }) => ({
      projectId,
      worktreeId,
      branchName
    }))
    const created = {
      connectionId,
      ...(worktrees ? { worktrees } : {})
    }

    const { sdk, model, codexFastMode } = spec.modelConfig
    const customProviderId = resolveLaunchCustomProviderId(sdk, spec.modelConfig.customProviderId)
    const result = await launch.startTicketSessionOnConnectionInstance({
      ticket: { id: spec.ticketId, project_id: spec.projectId, title: spec.ticketTitle },
      savedProjectId,
      connectionId,
      connectionPath,
      options: {
        mode: spec.mode,
        sdk,
        model: resolveLaunchModel(sdk, model, customProviderId),
        codexFastMode,
        customProviderId,
        promptText: spec.prompt,
        goalMode,
        goalSuccessCriteria,
        headless: true
      },
      ...(spec.ticketUpdateExtras ? { ticketUpdateExtras: spec.ticketUpdateExtras } : {})
    })
    // The instance is included on every outcome so a just-created one stays visible to the
    // caller, as `worktreeId` does for a worktree launch.
    return {
      success: result.success,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...created
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : null
    return { success: false, error: detail || 'Could not launch session' }
  }
}

/**
 * The model a claude-code-cli launch really runs with. Custom-provider models can go stale
 * between queueing and launch: a deleted provider degrades to plain claude and must drop the
 * model too (a proxy slug could fuzzy-match a wrong --model on stock claude), and a renamed
 * slug re-resolves to the provider's current default. Scoped to claude-code-cli — 'custom'
 * is also a legal opencode catalog provider id.
 */
function resolveLaunchModel(
  sdk: HandoffAgentSdk,
  model: LaunchModelConfig['model'],
  customProviderId: string | null
): LaunchModelConfig['model'] {
  if (sdk !== 'claude-code-cli' || model?.providerID !== CUSTOM_MODEL_PROVIDER_ID) return model
  const provider = findCustomProvider(useSettingsStore.getState().customProviders, customProviderId)
  return provider ? resolveCustomProviderSelectedModel(provider, model) : null
}

/** A session to launch on a connection instance that already exists; `launchSessionOnConnection`'s input. */
export interface ConnectionSessionLaunchSpec {
  connectionId: string
  /** The instance directory; without it an SDK session is created but not started. */
  connectionPath: string | null
  prompt: string
  mode: LaunchMode
  modelConfig: LaunchModelConfig
  goalMode: boolean
  goalSuccessCriteria: string | null
  /** Renames the session once it exists. */
  sessionName?: string
  /** As in `SessionLaunchSpec`: runs once the session exists, before the agent is started. */
  onSessionCreated?: (created: SessionLaunchCreated) => void | Promise<void>
}

/**
 * Headless session launch on a connection instance, with no ticket in sight: the twin of
 * `launchSessionWithModel` for a connection project (a document run's migration session on
 * its integration instance). Never throws: every failure is returned as { success: false }.
 */
export async function launchSessionOnConnection(
  spec: ConnectionSessionLaunchSpec
): Promise<SessionLaunchResult> {
  const { sdk, model, codexFastMode } = spec.modelConfig
  try {
    const { startSessionOnConnection } = await import('@/lib/connection-project-launch')
    const customProviderId = resolveLaunchCustomProviderId(sdk, spec.modelConfig.customProviderId)
    const effectiveModel = resolveLaunchModel(sdk, model, customProviderId)
    return await startSessionOnConnection({
      connectionId: spec.connectionId,
      connectionPath: spec.connectionPath ?? undefined,
      sdk,
      model: effectiveModel,
      codexFastMode,
      customProviderId,
      mode: spec.mode,
      promptText: spec.prompt,
      goalMode: spec.goalMode === true,
      goalSuccessCriteria: spec.goalSuccessCriteria?.trim() || null,
      ...(spec.sessionName ? { sessionName: spec.sessionName } : {}),
      ...(spec.onSessionCreated
        ? {
            onSessionCreated: (session: Session) =>
              spec.onSessionCreated?.({ session, customProviderId, model: effectiveModel })
          }
        : {})
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : null
    return { success: false, error: detail || 'Could not launch session' }
  }
}

/** A session to launch in a worktree that already exists; `launchSessionWithModel`'s input. */
export interface SessionLaunchSpec {
  projectId: string
  worktreeId: string
  prompt: string
  mode: LaunchMode
  modelConfig: LaunchModelConfig
  goalMode: boolean
  goalSuccessCriteria: string | null
  /** The session belongs to no ticket: the board must not attach it to one pre-assigned to the worktree. */
  skipKanbanAttach?: boolean
  /**
   * Runs once the session row exists and is stamped as working, before the agent is
   * started with the prompt: where the caller links the session to whatever launched it.
   * A throw fails the launch (reported with the session id, like every later failure).
   */
  onSessionCreated?: (created: SessionLaunchCreated) => void | Promise<void>
}

export interface SessionLaunchCreated {
  session: Session
  /** The custom provider the session really launches through (a deleted one is dropped). */
  customProviderId: string | null
  /** The launch config's model as it stands now; null leaves the choice to session creation. */
  model: { providerID: string; modelID: string; variant?: string } | null
}

export interface SessionLaunchResult {
  success: boolean
  sessionId?: string
  error?: string
}

/**
 * Headless session launch in an existing worktree, with no ticket in sight: creates the
 * session with the launch config's model, stamps its status, and delivers the prompt per
 * SDK without waiting for a session view to mount. `launchTicketWithModel` runs on it; a
 * caller without a ticket (a document run's migration session) uses it directly. Never
 * throws: every failure is returned as { success: false, error }.
 */
export async function launchSessionWithModel(
  spec: SessionLaunchSpec
): Promise<SessionLaunchResult> {
  const { sdk, model, codexFastMode } = spec.modelConfig
  const { worktreeId } = spec
  const goalMode = spec.goalMode === true
  const goalSuccessCriteria = spec.goalSuccessCriteria?.trim() || null
  // Working copy of the prompt — the goal-mode overflow branch may replace it
  // with a short "Implement PLAN_{uuid}.md" pointer.
  let prompt = spec.prompt
  // Snapshot of the session id as soon as it is created, hoisted above the try
  // so the catch fallback can still report it (Fix 5: avoids leaving a phantom
  // "working" session the caller can't see/clean up).
  let createdSessionId: string | undefined

  try {
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
        claudeCli: isAgentCli(sdk)
      })
      if (exceedsGoalPromptLimit(composed)) {
        const fileName = await createPlanFile(worktree.path, prompt.trim())
        prompt = planFilePrompt(fileName)
      }
    }

    // 2. Create session
    const customProviderId = resolveLaunchCustomProviderId(sdk, spec.modelConfig.customProviderId)
    const effectiveConfigModel = resolveLaunchModel(sdk, model, customProviderId)
    const modelOverride = effectiveConfigModel
      ? { ...effectiveConfigModel, agentSdk: sdk }
      : undefined
    const cliPendingPrompt = isAgentCli(sdk)
      ? composeLaunchPrompt(prompt, spec.mode, sdk, goalMode, goalSuccessCriteria, {
          claudeCli: true
        })
      : null
    const createOptions = {
      autoFocus: false,
      ...(modelOverride ? { modelOverride } : {}),
      ...(cliPendingPrompt ? { pendingMessage: cliPendingPrompt } : {}),
      ...(customProviderId ? { customProviderId } : {}),
      ...(spec.skipKanbanAttach ? { skipKanbanAttach: true } : {})
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
    createdSessionId = sessionId

    // 3. Set status tracking
    messageSendTimes.set(sessionId, Date.now())
    userExplicitSendTimes.set(sessionId, Date.now())
    snapshotTokenBaseline(sessionId)
    lastSendMode.set(sessionId, isPlanLike(spec.mode) ? 'plan' : 'build')
    useWorktreeStatusStore
      .getState()
      .setSessionStatus(sessionId, isPlanLike(spec.mode) ? 'planning' : 'working')

    // 4. Apply model override
    const effectiveModel = effectiveConfigModel ?? undefined
    if (effectiveConfigModel) {
      await useSessionStore.getState().setSessionModel(sessionId, effectiveConfigModel)
    }

    // 5. Let the caller link the session to whatever launched it (a ticket's
    //    session + badge fields) before the agent is started with the prompt.
    await spec.onSessionCreated?.({ session, customProviderId, model: effectiveConfigModel })

    // 6. Trigger usage refresh
    const usageProvider = resolveDefaultUsageProvider(sdk, customProviderId)
    if (usageProvider) {
      useUsageStore.getState().fetchUsageForProvider(usageProvider)
    }

    if (isAgentCli(sessionAgentSdk)) {
      const outboundPrompt =
        cliPendingPrompt ??
        composeLaunchPrompt(prompt, spec.mode, sessionAgentSdk, goalMode, goalSuccessCriteria, {
          claudeCli: true
        })

      if (isSuperMode(spec.mode)) {
        // Await so the persisted mode is committed before the main process
        // reads it in buildClaudeCliPtySpawn (createClaudeCli).
        await useSessionStore.getState().setSessionMode(sessionId, baseMode(spec.mode))
      }

      bumpWorktreeLastMessage({ worktreeId })
      const result = unwrapEnvelope(
        await terminalApi.createClaudeCli(sessionId, {
          pendingPrompt: outboundPrompt
        })
      )
      if (!result.success) {
        return {
          success: false,
          error: result.error ?? `Failed to start ${cliDisplayName(sessionAgentSdk)}`,
          sessionId
        }
      }
      if (outboundPrompt) {
        useSessionStore.getState().dequeuePendingMessage(sessionId)
      }
      return { success: true, sessionId }
    }

    // 7. Connect to OpenCode and send prompt
    if (!worktree?.path) {
      return { success: false, error: 'Worktree path not found', sessionId }
    }

    const connectResult = unwrapEnvelope(await opencodeApi.connect(worktree.path, sessionId))
    if (!connectResult.success || !connectResult.sessionId) {
      return {
        success: false,
        error: connectResult.error || 'Could not start session',
        sessionId
      }
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
      if (!outboundPrompt) return { success: true, sessionId }

      const promptOptions = sessionAgentSdk === 'codex' ? { codexFastMode } : undefined

      if (isSuperMode(spec.mode)) {
        useSessionStore.getState().setSessionMode(sessionId, baseMode(spec.mode))
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
      const promptResult = unwrapEnvelope(
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
      if (!promptResult.success) {
        // A rejected prompt (e.g. command bridge unavailable) means no agent
        // is actually running — surface it so the caller's failure recovery
        // runs instead of leaving the ticket linked to an idle session.
        return {
          success: false,
          error: promptResult.error || 'Could not send prompt',
          sessionId
        }
      }
    }

    return { success: true, sessionId }
  } catch (err) {
    const detail = err instanceof Error ? err.message : null
    return {
      success: false,
      error: detail || 'Could not launch session',
      ...(createdSessionId ? { sessionId: createdSessionId } : {})
    }
  }
}
