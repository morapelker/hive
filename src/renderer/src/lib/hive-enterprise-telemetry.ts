import { gitApi } from '@/api/git-api'
import {
  isHiveTelemetryEnabled,
  recordHivePromptIdle,
  recordHivePromptStart,
  recordHiveQuestionsAnswered
} from '@/api/hive-enterprise/client'
import { currentPromptIdBySession } from '@/lib/message-send-times'
import { computeTokenFieldDelta } from '@/lib/token-baselines'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useContextStore } from '@/stores/useContextStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { type SessionMode, useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

interface StartHivePromptTelemetryInput {
  sessionId: string
  prompt: string
  worktreeId: string | null | undefined
  modelId?: string | null
  providerId?: string | null
  modelVariant?: string | null
  mode?: SessionMode | null
}

interface HivePromptMetadataSession {
  agent_sdk?: string | null
  mode?: SessionMode | string | null
  model_provider_id?: string | null
  model_id?: string | null
  model_variant?: string | null
}

interface HivePromptMetadataModel {
  providerID?: string | null
  modelID?: string | null
  variant?: string | null
}

export interface HiveTelemetryConnectionProject {
  name: string
  path: string
}

export interface HivePromptMetadata {
  providerId: string | null
  modelProviderId: string | null
  modelId: string | null
  modelVariant: string | null
  mode: string | null
  isGoalPrompt: boolean
  handoffSessionId: string | null
  loggedAt: string
  connectionProjects: string | null
}

const handoffSessionIdByChildSession = new Map<string, string>()

export function registerHivePromptHandoff(parentSessionId: string, childSessionId: string): void {
  handoffSessionIdByChildSession.set(childSessionId, parentSessionId)
}

export function buildHivePromptMetadata(input: {
  prompt: string
  session?: HivePromptMetadataSession | null
  requestModel?: HivePromptMetadataModel | null
  mode?: SessionMode | string | null
  handoffSessionId?: string | null
  connectionProjects?: HiveTelemetryConnectionProject[] | null
  now?: Date
}): HivePromptMetadata {
  return {
    providerId: input.session?.agent_sdk ?? null,
    modelProviderId: input.requestModel?.providerID ?? input.session?.model_provider_id ?? null,
    modelId: input.requestModel?.modelID ?? input.session?.model_id ?? null,
    modelVariant: input.requestModel?.variant ?? input.session?.model_variant ?? null,
    mode: input.mode ?? input.session?.mode ?? null,
    isGoalPrompt: input.prompt.trimStart().startsWith('/goal'),
    handoffSessionId: input.handoffSessionId ?? null,
    loggedAt: (input.now ?? new Date()).toISOString(),
    connectionProjects:
      input.connectionProjects && input.connectionProjects.length > 0
        ? JSON.stringify(input.connectionProjects)
        : null
  }
}

function getWorktree(worktreeId: string | null | undefined) {
  if (!worktreeId) return undefined
  for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
    const worktree = worktrees.find((candidate) => candidate.id === worktreeId)
    if (worktree) return worktree
  }
  return undefined
}

export function resolveHiveTelemetryWorktreeId(
  sessionId: string,
  worktreeId: string | null | undefined
): string | null {
  if (worktreeId) return worktreeId
  return useSessionStore.getState().getSessionById(sessionId)?.worktree_id ?? null
}

function getConnectionProjects(connectionId: string | null | undefined): HiveTelemetryConnectionProject[] {
  if (!connectionId) return []
  const connection = useConnectionStore
    .getState()
    .connections.find((candidate) => candidate.id === connectionId)
  if (!connection) return []

  const projectsById = new Map(useProjectStore.getState().projects.map((project) => [project.id, project]))
  const projectsByKey = new Map<string, HiveTelemetryConnectionProject>()
  for (const member of connection.members ?? []) {
    const project = projectsById.get(member.project_id)
    const name = project?.name ?? member.project_name
    const path = project?.path ?? member.worktree_path
    projectsByKey.set(member.project_id, { name, path })
  }
  return Array.from(projectsByKey.values())
}

export function startHivePromptTelemetry(input: StartHivePromptTelemetryInput): void {
  const settings = useSettingsStore.getState()
  if (!isHiveTelemetryEnabled(settings)) return

  const sessionStore = useSessionStore.getState()
  const session = sessionStore.getSessionById(input.sessionId)
  const effectiveWorktreeId = resolveHiveTelemetryWorktreeId(input.sessionId, input.worktreeId)
  const worktree = getWorktree(effectiveWorktreeId)
  const project = worktree
    ? useProjectStore.getState().projects.find((candidate) => candidate.id === worktree.project_id)
    : undefined
  const contextLength = useContextStore
    .getState()
    .getContextUsage(input.sessionId, input.modelId ?? '', input.providerId ?? undefined).used
  const handoffSessionId = handoffSessionIdByChildSession.get(input.sessionId) ?? null
  if (handoffSessionId) handoffSessionIdByChildSession.delete(input.sessionId)
  const metadata = buildHivePromptMetadata({
    prompt: input.prompt,
    session,
    requestModel: {
      providerID: input.providerId ?? null,
      modelID: input.modelId ?? null,
      variant: input.modelVariant ?? null
    },
    mode: input.mode ?? sessionStore.getSessionMode(input.sessionId),
    handoffSessionId,
    connectionProjects: getConnectionProjects(session?.connection_id)
  })

  void (async () => {
    const remote = worktree?.path
      ? await gitApi.getRemoteUrl(worktree.path, 'origin').catch(() => null)
      : null

    // The server generates the prompt id and returns it; store it so the
    // matching idle event can correlate. A null id means nothing was recorded.
    const promptId = await recordHivePromptStart({
      prompt: input.prompt,
      sessionId: input.sessionId,
      worktreeId: worktree?.id ?? null,
      worktreeBranch: worktree?.branch_name ?? null,
      worktreePath: worktree?.path ?? null,
      projectName: project?.name ?? null,
      projectPath: project?.path ?? null,
      gitRemoteUrl: remote?.success ? (remote.url ?? null) : null,
      contextLength,
      ...metadata
    })
    if (promptId) currentPromptIdBySession.set(input.sessionId, promptId)
  })()
}

/**
 * Resolve how many questions were bundled in an answered AskUserQuestion
 * request. Falls back to the submitted answer count when the request has
 * already been removed from the store.
 */
export function resolveQuestionCount(
  requests: Array<{ id: string; questions: ReadonlyArray<unknown> }>,
  requestId: string,
  answers: ReadonlyArray<unknown>
): number {
  return requests.find((request) => request.id === requestId)?.questions.length ?? answers.length
}

export function recordHiveQuestionAnswerTelemetry(input: {
  sessionId: string
  questionCount: number
}): void {
  const settings = useSettingsStore.getState()
  if (!isHiveTelemetryEnabled(settings)) return

  const worktreeId = resolveHiveTelemetryWorktreeId(input.sessionId, null)
  const worktree = getWorktree(worktreeId)
  const project = worktree
    ? useProjectStore.getState().projects.find((candidate) => candidate.id === worktree.project_id)
    : undefined

  void recordHiveQuestionsAnswered({
    sessionId: input.sessionId,
    projectName: project?.name ?? null,
    questionCount: input.questionCount,
    loggedAt: new Date().toISOString()
  })
}

export function recordHivePromptIdleForSession(sessionId: string): void {
  const settings = useSettingsStore.getState()
  if (!isHiveTelemetryEnabled(settings)) return

  const promptId = currentPromptIdBySession.get(sessionId)
  if (!promptId) return
  const delta = computeTokenFieldDelta(sessionId)
  currentPromptIdBySession.delete(sessionId)

  void recordHivePromptIdle({
    promptId,
    inputTokens: delta.input,
    outputTokens: delta.output + delta.reasoning,
    cacheReadTokens: delta.cacheRead,
    cacheWriteTokens: delta.cacheWrite
  })
}
