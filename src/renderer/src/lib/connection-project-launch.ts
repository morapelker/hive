/**
 * Ticket launch pipeline for "connection projects" (projects.kind === 'connection').
 *
 * A ticket on a connection-project board launches into a live connection
 * INSTANCE: either a brand-new one (a fresh worktree named after the ticket in
 * every member project, connected together) or an existing one (a same-name
 * worktree set across all member projects, or an already-materialized instance
 * connection of this project). The session is a regular connection session
 * (sessions.connection_id set, worktree_id null) whose project_id is the saved
 * project — so tickets/history attribute to the saved board.
 */
import { useConnectionStore } from '@/stores/useConnectionStore'
import { isAgentCli } from '@shared/types/agent-sdk'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { shellCommandIdOfTicket } from '@shared/lib/shell-commands'
import { useSessionStore, type Session as StoreSession } from '@/stores/useSessionStore'
import {
  useSettingsStore,
  resolveModelForSdk,
  resolvePreferredAgentSdk
} from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useUsageStore, resolveDefaultUsageProvider } from '@/stores/useUsageStore'
import { connectionApi } from '@/api/connection-api'
import { worktreeApi } from '@/api/worktree-api'
import { opencodeApi } from '@/api/opencode-api'
import { terminalApi } from '@/api/terminal-api'
import { dbApi } from '@/api/db-api'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { toast } from '@/lib/toast'
import { messageSendTimes, lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { startHivePromptTelemetry } from '@/lib/hive-enterprise-telemetry'
import { createPlanFile, exceedsGoalPromptLimit, planFilePrompt } from '@/lib/goal-plan-file'
import { resolveBadgeModel, resolveCustomProviderBadge } from '@/lib/ticket-launch'
import { insertConnectionLocally } from '@/lib/connection-create'
import { autoPinForBoardPrompt } from '@/lib/auto-pin'
import {
  PLAN_MODE_PREFIX,
  getSuperModePrefix,
  isPlanLike,
  isSuperMode,
  baseMode
} from '@/lib/constants'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'
import { FALLBACK_MODELS } from '@shared/model-resolution'
import {
  getMemberProjects,
  isBaseInstance,
  type MemberProject,
  type WorktreeNameSet
} from '@/lib/connection-project'
import type { KanbanTicket, KanbanTicketUpdate, Session } from '../../../main/db/types'

/** Minimal ticket shape the connection-project pipeline needs. */
export type ConnectionProjectTicket = Pick<KanbanTicket, 'id' | 'project_id' | 'title'> & {
  description?: string | null
  attachments?: KanbanTicket['attachments']
}

type LaunchMode = 'build' | 'plan' | 'super-plan' | 'super-build'
type LaunchSdk = 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'codex-cli'

export type ConnectionProjectLaunchTarget =
  | { type: 'new' }
  | { type: 'existing-connection'; connectionId: string }
  | { type: 'name-set'; nameSet: WorktreeNameSet }
  /** A specific worktree set (serialized name-set from a queued launch config). */
  | { type: 'worktree-set'; worktreeIds: string[] }

export interface ConnectionProjectLaunchOptions {
  mode: LaunchMode
  sdk: LaunchSdk
  model: { providerID: string; modelID: string; variant?: string } | null
  codexFastMode: boolean
  /** claude-code-cli only: launch through this custom provider's command. */
  customProviderId?: string | null
  /** RAW prompt (ticket prompt or user-edited text) — composed per SDK here. */
  promptText: string
  goalMode: boolean
  goalSuccessCriteria: string | null
  /**
   * A launch nobody is watching (the document-run orchestrator): the board tab is not brought
   * to the front in sticky-tab mode, as the git-project headless launch never does.
   */
  headless?: boolean
}

export interface ConnectionProjectLaunchResult {
  success: boolean
  sessionId?: string
  connectionId?: string
  error?: string
}

/**
 * How one member's worktree of a new instance is cut. Without `sourceBranch` the member's
 * default branch; without `baseRef` the tip of that branch (the document flow cuts every
 * member from its integration branch's verified commit instead).
 */
export interface InstanceMemberSpec {
  projectId: string
  sourceBranch?: string
  /** Cut the branch from this ref even when `sourceBranch` is checked out in a worktree. */
  baseRef?: string
  /** Overrides the "auto-pull before worktree" setting for this member's worktree. */
  autoPull?: boolean
}

/** A member worktree of a freshly created instance, as the worktree row records it. */
export interface InstanceWorktree {
  projectId: string
  worktreeId: string
  branchName: string
  path: string
}

export interface ResolvedConnectionInstance {
  connectionId?: string
  connectionPath?: string
  /** Only for an instance created here: the worktrees it was connected over, in member order. */
  worktrees?: InstanceWorktree[]
  error?: string
}

// ── Prompt composition (mirrors WorktreePickerModal/ticket-launch) ──
export function buildTicketPrompt(mode: LaunchMode, ticket: ConnectionProjectTicket): string {
  const prefix =
    baseMode(mode) === 'build'
      ? 'Please implement the following ticket.'
      : 'Please review the following ticket and create a detailed implementation plan.'
  const description = ticket.description ?? ''
  const attachments = (ticket.attachments ?? []) as Array<{
    type: string
    url: string
    label: string
  }>

  let attachmentsXml = ''
  if (attachments.length > 0) {
    const items: string[] = []
    for (const a of attachments) {
      if (a.type === 'image' || a.type === 'file') {
        items.push(`<file path="${a.url}">${a.label}</file>`)
      } else {
        items.push(`<link type="${a.type}" url="${a.url}">${a.label}</link>`)
      }
    }
    attachmentsXml = `\n<attachments>\n${items.join('\n')}\n</attachments>`
  }

  return `${prefix}\n\n<ticket title="${ticket.title}">${description}${attachmentsXml}</ticket>`
}

function wrapGoalPrompt(prompt: string, criteria: string): string {
  const stripped = prompt.replace(/^\/goal\s+/, '')
  return `/goal ${stripped}. Goal success criteria: ${criteria}`
}

function composePromptForSdk(
  mode: LaunchMode,
  sessionAgentSdk: string | null | undefined,
  prompt: string,
  goalMode: boolean,
  goalCriteria: string | null,
  options: { claudeCli: boolean }
): string | null {
  const trimmedPrompt = prompt.trim()
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

  return goalMode && goalCriteria?.trim()
    ? wrapGoalPrompt(fullPrompt, goalCriteria.trim())
    : fullPrompt
}

/** Default SDK + build-mode model, mirroring the picker's quick-launch resolution. */
function resolveQuickModel(): {
  sdk: LaunchSdk
  model: { providerID: string; modelID: string; variant?: string }
} {
  const settings = useSettingsStore.getState()
  const sdk: LaunchSdk = resolvePreferredAgentSdk(settings)
  const modeModel = settings.getModelForMode('build')
  if (modeModel && modeModel.agentSdk === sdk) {
    return {
      sdk,
      model: {
        providerID: modeModel.providerID,
        modelID: modeModel.modelID,
        variant: modeModel.variant
      }
    }
  }
  const resolved = resolveModelForSdk(sdk) ?? FALLBACK_MODELS[sdk]
  return {
    sdk,
    model: { providerID: resolved.providerID, modelID: resolved.modelID, variant: resolved.variant }
  }
}

/**
 * Create one new worktree per member project (nameHint = ticket slug, base =
 * each project's default branch unless `members` says otherwise) and connect
 * them, linked to the saved project. Best-effort rollback of created worktrees
 * on failure — mirrors useConnectionStore.quickCreateConnection but never
 * changes selection. `members`, when given, also fixes the member order; a
 * member it names that is not one of `memberProjects` fails the launch.
 */
export async function createInstanceWithNewWorktrees(args: {
  savedProjectId: string
  memberProjects: MemberProject[]
  nameHint: string | undefined
  members?: readonly InstanceMemberSpec[]
}): Promise<ResolvedConnectionInstance> {
  const { savedProjectId, memberProjects, nameHint } = args
  const { useWorktreeStore, fireSetupScript } = await import('@/stores/useWorktreeStore')
  const worktreeStore = useWorktreeStore.getState()

  const byId = new Map(memberProjects.map((project) => [project.id, project]))
  const plan: { project: MemberProject; spec: InstanceMemberSpec }[] = []
  for (const spec of args.members ?? memberProjects.map((project) => ({ projectId: project.id }))) {
    const project = byId.get(spec.projectId)
    if (!project) return { error: `Member project ${spec.projectId} is no longer in the app` }
    plan.push({ project, spec })
  }

  // Ensure member worktrees are loaded so default branches resolve
  await Promise.all(plan.map(({ project }) => worktreeStore.loadWorktrees(project.id)))

  const created: {
    project: MemberProject
    worktree: { id: string; path: string; branch_name: string }
  }[] = []

  const rollback = async (): Promise<void> => {
    for (const { project, worktree } of created) {
      try {
        const deleteResult = await worktreeApi.delete({
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          branchName: worktree.branch_name,
          projectPath: project.path,
          archive: false
        })
        if (deleteResult.success) {
          useWorktreeStore.getState().removeWorktreeFromProject(project.id, worktree.id)
        }
      } catch {
        // Best-effort cleanup only
      }
    }
  }

  for (const { project, spec } of plan) {
    const branchName =
      spec.sourceBranch ||
      useWorktreeStore.getState().getDefaultWorktree(project.id)?.branch_name ||
      'main'
    // Keys are added only when set, so plain launches make the exact call they always did.
    const result = await worktreeApi.createFromBranch({
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      branchName,
      ...(nameHint ? { nameHint } : {}),
      ...(spec.autoPull === undefined ? {} : { autoPull: spec.autoPull }),
      ...(spec.baseRef === undefined ? {} : { baseRef: spec.baseRef })
    })
    if (!result.success || !result.worktree) {
      await rollback()
      return {
        error: `Failed to create worktree in "${project.name}": ${result.error ?? 'Unknown error'}`
      }
    }
    // Insert WITHOUT selecting (the store's createWorktreeFromBranch action selects)
    useWorktreeStore.getState().addWorktreeToProject(project.id, result.worktree)
    created.push({ project, worktree: result.worktree })
  }

  // Fire setup scripts only after every worktree succeeded (rollback can delete dirs)
  for (const { project, worktree } of created) {
    fireSetupScript(project.id, worktree.id, worktree.path)
  }

  const createResult = await connectionApi.create(
    created.map((c) => c.worktree.id),
    { savedProjectId }
  )
  if (!createResult.success || !createResult.connection) {
    await rollback()
    return { error: createResult.error || 'Failed to create connection' }
  }
  insertConnectionLocally(createResult.connection)
  return {
    connectionId: createResult.connection.id,
    connectionPath: createResult.connection.path,
    worktrees: created.map(({ project, worktree }) => ({
      projectId: project.id,
      worktreeId: worktree.id,
      branchName: worktree.branch_name,
      path: worktree.path
    }))
  }
}

/**
 * Resolve a launch target to a live connection instance. Name sets reuse an
 * existing instance of this project when the worktree set matches exactly;
 * otherwise a new connection is created over the picked worktrees.
 */
export async function resolveConnectionForLaunch(args: {
  savedProjectId: string
  memberProjects: MemberProject[]
  target: ConnectionProjectLaunchTarget
  nameHint?: string
  /** A `new` target only: how each member's worktree is cut (default: the member's default branch tip). */
  members?: readonly InstanceMemberSpec[]
}): Promise<ResolvedConnectionInstance> {
  const { savedProjectId, memberProjects, target } = args

  if (target.type === 'existing-connection') {
    const known = useConnectionStore
      .getState()
      .connections.find((c) => c.id === target.connectionId)
    if (known) return { connectionId: known.id, connectionPath: known.path }
    // Not in this window's store yet (an instance the server created, such as a document run's
    // integration instance): ask the server before calling it gone.
    const fetched = await connectionApi.get(target.connectionId)
    const connection = fetched.success ? fetched.connection : undefined
    if (!connection || connection.status !== 'active')
      return { error: 'Connection no longer exists' }
    insertConnectionLocally(connection)
    return { connectionId: connection.id, connectionPath: connection.path }
  }

  if (target.type === 'name-set' || target.type === 'worktree-set') {
    const worktreeIds =
      target.type === 'name-set'
        ? target.nameSet.worktrees.map((w) => w.worktreeId)
        : target.worktreeIds
    const wanted = new Set(worktreeIds)
    // Reuse an existing instance whose member worktree set matches exactly
    const existing = useConnectionStore.getState().connections.find((c) => {
      if (c.saved_project_id !== savedProjectId) return false
      const memberIds = c.members.map((m) => m.worktree_id)
      return memberIds.length === wanted.size && memberIds.every((id) => wanted.has(id))
    })
    if (existing) return { connectionId: existing.id, connectionPath: existing.path }

    const createResult = await connectionApi.create(worktreeIds, { savedProjectId })
    if (!createResult.success || !createResult.connection) {
      return { error: createResult.error || 'Failed to create connection' }
    }
    insertConnectionLocally(createResult.connection)
    return {
      connectionId: createResult.connection.id,
      connectionPath: createResult.connection.path
    }
  }

  if (memberProjects.length < 2) {
    return { error: 'Connection project needs at least 2 existing member projects' }
  }
  return createInstanceWithNewWorktrees({
    savedProjectId,
    memberProjects,
    nameHint: args.nameHint,
    ...(args.members ? { members: args.members } : {})
  })
}

export interface ConnectionSessionLaunchArgs {
  connectionId: string
  connectionPath: string | undefined
  sdk: LaunchSdk
  model: { providerID: string; modelID: string; variant?: string } | null
  codexFastMode: boolean
  /** claude-code-cli only: launch through this custom provider's command (already resolved). */
  customProviderId?: string | null
  mode: LaunchMode
  /** RAW prompt — composed per SDK here. */
  promptText: string
  goalMode: boolean
  goalSuccessCriteria: string | null
  /** Renames the session once it exists; the default is the store's "Session n". */
  sessionName?: string
  /**
   * Runs once the session row exists and is stamped as working, before the agent is started
   * with the prompt: where the caller links the session to whatever launched it. A throw
   * fails the launch (reported with the session id, like every later failure).
   */
  onSessionCreated?: (session: StoreSession) => void | Promise<void>
}

export interface ConnectionSessionLaunchResult {
  success: boolean
  sessionId?: string
  error?: string
}

/**
 * Create a session on a connection instance and deliver the prompt — the ticketless half of
 * a connection launch, the twin of ticket-launch's `launchSessionWithModel`: the session is
 * created with the launch's model, stamped as working, handed to the caller, then started
 * per SDK (a CLI gets the prompt as its pending message, an SDK session is connected and
 * prompted). Never throws: every failure is returned as { success: false, error }.
 */
export async function startSessionOnConnection(
  args: ConnectionSessionLaunchArgs
): Promise<ConnectionSessionLaunchResult> {
  const { connectionId, connectionPath, mode, sdk, model, codexFastMode, goalMode } = args
  const customProviderId = args.customProviderId ?? null
  const goalCriteria = args.goalSuccessCriteria?.trim() || null
  let promptText = args.promptText
  // Snapshot of the session id as soon as it is created, hoisted above the try so the catch
  // fallback can still report it.
  let createdSessionId: string | undefined

  try {
    // Oversized goal prompts become a PLAN_{uuid}.md in the connection dir
    if (goalMode && goalCriteria && connectionPath) {
      const composed = composePromptForSdk(mode, sdk, promptText, goalMode, goalCriteria, {
        claudeCli: isAgentCli(sdk)
      })
      if (exceedsGoalPromptLimit(composed)) {
        const fileName = await createPlanFile(connectionPath, promptText.trim())
        promptText = planFilePrompt(fileName)
      }
    }

    const cliPendingPrompt = isAgentCli(sdk)
      ? composePromptForSdk(mode, sdk, promptText, goalMode, goalCriteria, { claudeCli: true })
      : null
    const sessionResult = await useSessionStore
      .getState()
      .createConnectionSession(connectionId, sdk, mode, {
        autoFocus: false,
        ...(model ? { modelOverride: { ...model, agentSdk: sdk } } : {}),
        ...(cliPendingPrompt ? { pendingMessage: cliPendingPrompt } : {}),
        ...(customProviderId ? { customProviderId } : {})
      })
    if (!sessionResult.success || !sessionResult.session) {
      return { success: false, error: sessionResult.error || 'Failed to create session' }
    }

    const session = sessionResult.session
    const sessionId = session.id
    const sessionAgentSdk = session.agent_sdk
    createdSessionId = sessionId

    // Status tracking BEFORE any async connect so loadSessions can't race it
    messageSendTimes.set(sessionId, Date.now())
    userExplicitSendTimes.set(sessionId, Date.now())
    snapshotTokenBaseline(sessionId)
    lastSendMode.set(sessionId, isPlanLike(mode) ? 'plan' : 'build')
    useWorktreeStatusStore
      .getState()
      .setSessionStatus(sessionId, isPlanLike(mode) ? 'planning' : 'working')

    if (model) {
      await useSessionStore.getState().setSessionModel(sessionId, model)
    }
    if (args.sessionName) {
      await useSessionStore.getState().updateSessionName(sessionId, args.sessionName)
    }

    await args.onSessionCreated?.(session)

    const usageProvider = resolveDefaultUsageProvider(sdk, customProviderId)
    if (usageProvider) {
      useUsageStore.getState().fetchUsageForProvider(usageProvider)
    }

    if (isAgentCli(sessionAgentSdk)) {
      const outboundPrompt =
        cliPendingPrompt ??
        composePromptForSdk(mode, sessionAgentSdk, promptText, goalMode, goalCriteria, {
          claudeCli: true
        })

      if (isSuperMode(mode)) {
        // Await so the persisted mode is committed before the main process
        // reads it in buildClaudeCliPtySpawn (createClaudeCli).
        await useSessionStore.getState().setSessionMode(sessionId, baseMode(mode))
      }

      bumpWorktreeLastMessage({ connectionId })
      const result = unwrapEnvelope(
        await terminalApi.createClaudeCli(sessionId, { pendingPrompt: outboundPrompt })
      )
      if (!result.success) {
        return { success: false, error: result.error ?? 'Failed to start Claude CLI', sessionId }
      }
      if (outboundPrompt) {
        useSessionStore.getState().dequeuePendingMessage(sessionId)
      }
      return { success: true, sessionId }
    }

    if (!connectionPath) return { success: true, sessionId }

    const connectResult = unwrapEnvelope(await opencodeApi.connect(connectionPath, sessionId))
    if (!connectResult.success || !connectResult.sessionId) {
      return { success: false, error: connectResult.error || 'Failed to start session', sessionId }
    }
    useSessionStore.getState().setOpenCodeSessionId(sessionId, connectResult.sessionId)
    await dbApi.session.update<Session>(sessionId, {
      opencode_session_id: connectResult.sessionId
    })

    const outboundPrompt = composePromptForSdk(
      mode,
      sessionAgentSdk,
      promptText,
      goalMode,
      goalCriteria,
      {
        claudeCli: false
      }
    )
    if (!outboundPrompt) return { success: true, sessionId }

    if (isSuperMode(mode)) {
      useSessionStore.getState().setSessionMode(sessionId, baseMode(mode))
    }

    const promptOptions = sessionAgentSdk === 'codex' ? { codexFastMode } : undefined
    bumpWorktreeLastMessage({ connectionId })
    startHivePromptTelemetry({
      sessionId,
      prompt: outboundPrompt,
      worktreeId: null,
      modelId: model?.modelID,
      providerId: model?.providerID,
      modelVariant: model?.variant,
      mode
    })
    const promptResult = unwrapEnvelope(
      await opencodeApi.prompt(
        connectionPath,
        connectResult.sessionId,
        [{ type: 'text', text: outboundPrompt }],
        model
          ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
          : undefined,
        promptOptions
      )
    )
    if (!promptResult.success) {
      return { success: false, error: promptResult.error || 'Could not send prompt', sessionId }
    }

    return { success: true, sessionId }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start session',
      ...(createdSessionId ? { sessionId: createdSessionId } : {})
    }
  }
}

/**
 * Create the connection session, link the ticket, and deliver the prompt —
 * the connection-project twin of the picker's connection-mode send path.
 * Sort order comes from the SAVED project's own board column.
 * `ticketUpdateExtras` are merged last into the ticket update (a caller that
 * places the ticket itself overrides the column and sort order).
 */
export async function startTicketSessionOnConnectionInstance(args: {
  ticket: ConnectionProjectTicket
  savedProjectId: string
  connectionId: string
  connectionPath: string | undefined
  options: ConnectionProjectLaunchOptions
  ticketUpdateExtras?: Partial<KanbanTicketUpdate>
}): Promise<ConnectionProjectLaunchResult> {
  const { ticket, savedProjectId, connectionId, connectionPath, options } = args
  const { mode, sdk, model, codexFastMode, goalMode } = options
  const customProviderId = options.customProviderId ?? null
  const goalCriteria = options.goalSuccessCriteria?.trim() || null

  // A shell command's ticket is never an agent prompt (same refusal as ticket-launch)
  const boardTicket = useKanbanStore
    .getState()
    .tickets.get(ticket.project_id)
    ?.find((t) => t.id === ticket.id)
  if (shellCommandIdOfTicket(boardTicket)) {
    return { success: false, error: 'A shell command ticket cannot be launched with an agent.' }
  }

  const result = await startSessionOnConnection({
    connectionId,
    connectionPath,
    sdk,
    model,
    codexFastMode,
    customProviderId,
    mode,
    promptText: options.promptText,
    goalMode,
    goalSuccessCriteria: goalCriteria,
    onSessionCreated: async (session) => {
      const kanban = useKanbanStore.getState()
      const sortOrder = kanban.computeSortOrder(
        kanban.getTicketsByColumn(savedProjectId, 'in_progress'),
        0
      )
      const badgeModel =
        resolveCustomProviderBadge(customProviderId, model) ??
        resolveBadgeModel({ sdk, model, codexFastMode, customProviderId }, session)
      await kanban.updateTicket(ticket.id, ticket.project_id, {
        current_session_id: session.id,
        worktree_id: null,
        mode,
        column: 'in_progress',
        sort_order: sortOrder,
        plan_ready: false,
        goal_mode: goalMode,
        goal_success_criteria: goalMode ? goalCriteria : null,
        model_provider_id: badgeModel.providerID,
        model_id: badgeModel.modelID,
        model_variant: badgeModel.variant,
        variant_group_id: null,
        pending_launch_config: null,
        ...args.ticketUpdateExtras
      })

      // Name the instance after the ticket unless the user already renamed it —
      // never the base instance (it is the project's "main", like a default worktree).
      const connection = useConnectionStore
        .getState()
        .connections.find((c) => c.id === connectionId)
      const ticketTitle = ticket.title.trim()
      if (connection && !isBaseInstance(connection) && !connection.custom_name && ticketTitle) {
        void useConnectionStore.getState().renameConnection(connectionId, ticketTitle)
      }

      // Setting-gated auto-pin so this board shows on the pinned board: the
      // project's base instance, or in 'current-branch' mode the instance the
      // session was sent on (the git-project paths pin worktrees the same way).
      void autoPinForBoardPrompt({ projectId: savedProjectId, connectionId })

      if (!options.headless && useSettingsStore.getState().boardMode === 'sticky-tab') {
        const { BOARD_TAB_ID } = await import('@/stores/useSessionStore')
        useSessionStore.getState().setActiveSession(BOARD_TAB_ID)
      }
    }
  })
  return { ...result, connectionId }
}

/**
 * Full launch: resolve/create the connection instance for the target, then
 * start the ticket session on it.
 */
export async function launchTicketOnConnectionProject(args: {
  ticket: ConnectionProjectTicket
  savedProject: { id: string; kind?: 'git' | 'connection'; member_project_ids?: string | null }
  target: ConnectionProjectLaunchTarget
  options: ConnectionProjectLaunchOptions
}): Promise<ConnectionProjectLaunchResult> {
  const memberProjects = getMemberProjects(args.savedProject)
  const nameHint = canonicalizeTicketTitle(args.ticket.title) || undefined
  const resolved = await resolveConnectionForLaunch({
    savedProjectId: args.savedProject.id,
    memberProjects,
    target: args.target,
    nameHint
  })
  if (!resolved.connectionId) {
    return { success: false, error: resolved.error || 'Failed to resolve connection' }
  }
  return startTicketSessionOnConnectionInstance({
    ticket: args.ticket,
    savedProjectId: args.savedProject.id,
    connectionId: resolved.connectionId,
    connectionPath: resolved.connectionPath,
    options: args.options
  })
}

/**
 * Quick launch (right-drag / Save & Send / Create & Send / auto-launch defaults):
 * build mode, a NEW worktree per member project named after the ticket, default
 * SDK + model, the plain ticket prompt. Reports its own toasts.
 */
export async function quickLaunchTicketOnConnectionProject(
  ticket: ConnectionProjectTicket,
  overrides?: Partial<ConnectionProjectLaunchOptions>,
  target: ConnectionProjectLaunchTarget = { type: 'new' }
): Promise<boolean> {
  const savedProject = useProjectStore.getState().projects.find((p) => p.id === ticket.project_id)
  if (!savedProject || savedProject.kind !== 'connection') {
    toast.error('Connection project not found')
    return false
  }
  const { sdk, model } = resolveQuickModel()
  const options: ConnectionProjectLaunchOptions = {
    mode: 'build',
    sdk,
    model,
    codexFastMode: useSettingsStore.getState().codexFastMode,
    promptText: buildTicketPrompt('build', ticket),
    goalMode: false,
    goalSuccessCriteria: null,
    ...overrides
  }
  const result = await launchTicketOnConnectionProject({
    ticket,
    savedProject,
    target,
    options
  })
  if (!result.success) {
    toast.error(result.error || 'Failed to start session')
    return false
  }
  toast.success('Session started')
  return true
}
