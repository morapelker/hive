import { create } from 'zustand'
import type { OpenCodeMessage } from '@/components/sessions/SessionView'
import { parseBoardAssistantDraftSet } from '@/lib/board-assistant-drafts'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { SelectedModel } from '@/stores/useSettingsStore'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { BOARD_ASSISTANT_SESSION_NAME_PREFIX } from '@/stores/useSessionStore'

export type BoardChatStatus =
  | 'idle'
  | 'starting'
  | 'thinking'
  | 'awaiting_confirmation'
  | 'error'

export type BoardChatScope =
  | {
      kind: 'project'
      projectId: string
      projectName: string
      projectPath: string
    }
  | {
      kind: 'connection'
      connectionId: string
      connectionName: string
      connectionPath: string
      availableProjects: Array<{ id: string; name: string }>
    }
  | {
      kind: 'pinned'
    }

export interface BoardChatMessage extends OpenCodeMessage {
  kind: 'transcript' | 'local'
}

export interface TicketDraft {
  id: string
  draftKey: string
  title: string
  description: string | null
  dependsOn: string[]
  resolvedDependsOnTitles: string[]
  warnings: string[]
  validationIssues: string[]
  projectId: string
  projectName: string
  selected: boolean
  createdAt: string | null
}

interface ResetBoardChatOptions {
  preserveOpen?: boolean
  scope?: BoardChatScope | null
  selectedTargetProjectId?: string | null
  selectedAgentSdkOverride?: 'opencode' | 'claude-code' | 'codex' | null
  selectedModelOverride?: SelectedModel | null
}

export interface BoardChatSnapshot {
  scope: BoardChatScope | null
  messages: BoardChatMessage[]
  drafts: TicketDraft[]
  createdDraftIds: string[]
  draftSourceMessageId: string | null
  status: BoardChatStatus
  selectedTargetProjectId: string | null
  error: string | null
  sessionId: string | null
  opencodeSessionId: string | null
  runtimePath: string | null
  selectedAgentSdkOverride: 'opencode' | 'claude-code' | 'codex' | null
  selectedModelOverride: SelectedModel | null
  composerValue: string
}

interface BoardChatState extends BoardChatSnapshot {
  isOpen: boolean
  isMinimized: boolean
  activeScopeKey: string
  snapshots: Record<string, BoardChatSnapshot>
  open: () => void
  minimize: () => void
  restore: () => void
  close: () => Promise<void>
  clear: () => Promise<void>
  activateScope: (scope: BoardChatScope | null, options?: ResetBoardChatOptions) => void
  getProjectSnapshot: (projectId: string) => BoardChatSnapshot | null
  getSessionSnapshot: (sessionId: string) => { key: string; snapshot: BoardChatSnapshot } | null
  clearProjectSnapshot: (projectId: string) => void
  syncScope: (scope: BoardChatScope | null) => Promise<void>
  resetForBoardExit: () => Promise<void>
  syncTranscript: (messages: OpenCodeMessage[], isStreaming: boolean) => void
  sendMessage: (message: string) => Promise<void>
  createSelected: () => Promise<void>
  toggleDraftSelected: (draftId: string) => void
  markDraftsCreated: (draftIds: string[]) => void
  setSelectedTargetProjectId: (projectId: string | null) => Promise<void>
  setSelectedAgentSdkOverride: (sdk: 'opencode' | 'claude-code' | 'codex' | null) => void
  setSelectedModelOverride: (model: SelectedModel | null) => void

  openDrawer: () => void
  minimizeDrawer: () => void
  restoreDrawer: () => void
  setTranscriptMessages: (messages: OpenCodeMessage[]) => void
  addLocalUserMessage: (content: string) => void
  addLocalSystemMessage: (content: string) => void
  setDrafts: (drafts: TicketDraft[], sourceMessageId: string) => void
  clearDrafts: () => void
  setAllDraftsSelected: (selected: boolean) => void
  setStatus: (status: BoardChatStatus) => void
  setError: (error: string | null) => void
  setRuntimeSession: (runtime: {
    sessionId: string
    opencodeSessionId: string
    runtimePath: string
  }) => void
  updateOpencodeSessionId: (opencodeSessionId: string) => void
  clearRuntimeSession: () => void
  setComposerValue: (value: string) => void
  resetState: (options?: ResetBoardChatOptions) => void
}

export function resolveBoardChatAgentSdk(
  defaultAgentSdk: ReturnType<typeof useSettingsStore.getState>['defaultAgentSdk'] | null | undefined
): 'opencode' | 'claude-code' | 'codex' {
  const sdk = defaultAgentSdk ?? 'opencode'
  return sdk === 'terminal' ? 'opencode' : sdk
}

export function resolveBoardChatDefaultModel(
  settings: Pick<
    ReturnType<typeof useSettingsStore.getState>,
    'defaultAgentSdk' | 'selectedModel' | 'selectedModelByProvider' | 'getModelForMode'
  >,
  agentSdkOverride?: 'opencode' | 'claude-code' | 'codex' | null
): SelectedModel | null {
  const agentSdk = agentSdkOverride ?? resolveBoardChatAgentSdk(settings.defaultAgentSdk)
  return settings.getModelForMode('ask') ?? resolveModelForSdk(agentSdk, settings) ?? settings.selectedModel
}

const BOARD_RULES_TAG_RE = /<board-assistant-rules>[\s\S]*?<\/board-assistant-rules>/gi
const BOARD_CONTEXT_TAG_RE = /<board-assistant-context>[\s\S]*?<\/board-assistant-context>/gi
const BOARD_DRAFT_BLOCK_RE = /```board-ticket-drafts[\s\S]*?```/gi
const BOARD_DRAFT_BLOCK_CAPTURE_RE = /```board-ticket-drafts\s*([\s\S]*?)```/i

export function stripBoardAssistantScaffolding(content: string): string {
  const withoutTags = content
    .replace(BOARD_RULES_TAG_RE, '')
    .replace(BOARD_CONTEXT_TAG_RE, '')

  const marker = 'User request:'
  const markerIndex = withoutTags.lastIndexOf(marker)
  if (markerIndex >= 0) {
    return withoutTags.slice(markerIndex + marker.length).trim()
  }

  return withoutTags.trim()
}

export function stripBoardDraftBlocks(content: string): string {
  return content.replace(BOARD_DRAFT_BLOCK_RE, '').trim()
}

function normalizeVisibleContent(content: string, role: OpenCodeMessage['role']): string {
  const visible =
    role === 'user'
      ? stripBoardAssistantScaffolding(content)
      : stripBoardDraftBlocks(stripBoardAssistantScaffolding(content))

  return visible.replace(/\s+/g, ' ').trim().toLowerCase()
}

function mergeTranscriptMessages(
  currentMessages: BoardChatMessage[],
  transcriptMessages: OpenCodeMessage[]
): BoardChatMessage[] {
  const normalizedTranscriptKeys = new Set(
    transcriptMessages.map(
      (message) => `${message.role}:${normalizeVisibleContent(message.content, message.role)}`
    )
  )

  const localMessages = currentMessages.filter((message) => {
    if (message.kind !== 'local') return false
    if (message.role !== 'user') return true

    const key = `${message.role}:${normalizeVisibleContent(message.content, message.role)}`
    return !normalizedTranscriptKeys.has(key)
  })

  return [
    ...localMessages,
    ...transcriptMessages.map((message) => ({
      ...message,
      kind: 'transcript' as const
    }))
  ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

function makeLocalMessage(role: OpenCodeMessage['role'], content: string): BoardChatMessage {
  return {
    id: `board-chat-${role}-${crypto.randomUUID()}`,
    role,
    content,
    timestamp: new Date().toISOString(),
    kind: 'local'
  }
}

function buildDefaultTargetProjectId(scope: BoardChatScope | null): string | null {
  if (!scope) return null
  if (scope.kind === 'project') return scope.projectId
  if (scope.kind === 'connection') return scope.availableProjects[0]?.id ?? null
  return null
}

function createInitialSnapshot(options?: ResetBoardChatOptions): BoardChatSnapshot {
  const scope = options?.scope ?? null
  return {
    scope,
    messages: [],
    drafts: [],
    createdDraftIds: [],
    draftSourceMessageId: null,
    status: 'idle',
    selectedTargetProjectId:
      options?.selectedTargetProjectId ?? buildDefaultTargetProjectId(scope),
    error: null,
    sessionId: null,
    opencodeSessionId: null,
    runtimePath: null,
    selectedAgentSdkOverride: options?.selectedAgentSdkOverride ?? null,
    selectedModelOverride: options?.selectedModelOverride ?? null,
    composerValue: ''
  }
}

function getScopeKey(scope: BoardChatScope | null): string {
  if (!scope) return 'none'
  if (scope.kind === 'project') return `project:${scope.projectId}`
  if (scope.kind === 'connection') return `connection:${scope.connectionId}`
  return 'pinned'
}

function getSnapshotFromState(state: BoardChatState): BoardChatSnapshot {
  return {
    scope: state.scope,
    messages: state.messages,
    drafts: state.drafts,
    createdDraftIds: state.createdDraftIds,
    draftSourceMessageId: state.draftSourceMessageId,
    status: state.status,
    selectedTargetProjectId: state.selectedTargetProjectId,
    error: state.error,
    sessionId: state.sessionId,
    opencodeSessionId: state.opencodeSessionId,
    runtimePath: state.runtimePath,
    selectedAgentSdkOverride: state.selectedAgentSdkOverride,
    selectedModelOverride: state.selectedModelOverride,
    composerValue: state.composerValue
  }
}

function replaceActiveSnapshot(
  state: BoardChatState,
  snapshot: BoardChatSnapshot,
  activeScopeKey = getScopeKey(snapshot.scope),
  options?: { dropExistingSnapshot?: boolean }
): Partial<BoardChatState> {
  const nextSnapshots = { ...state.snapshots }
  if (activeScopeKey !== 'none') {
    if (options?.dropExistingSnapshot) {
      delete nextSnapshots[activeScopeKey]
    } else {
      nextSnapshots[activeScopeKey] = snapshot
    }
  }

  return {
    ...snapshot,
    activeScopeKey,
    snapshots: nextSnapshots
  }
}

function patchActiveSnapshot(
  state: BoardChatState,
  patch: Partial<BoardChatSnapshot>
): Partial<BoardChatState> {
  const activeScopeKey = state.activeScopeKey || getScopeKey(state.scope)
  const nextSnapshot = {
    ...getSnapshotFromState(state),
    ...patch
  }

  const nextSnapshots = { ...state.snapshots }
  if (activeScopeKey !== 'none') {
    nextSnapshots[activeScopeKey] = nextSnapshot
  }

  return {
    ...patch,
    activeScopeKey,
    snapshots: nextSnapshots
  }
}

function createBaseState(): Omit<
  BoardChatState,
  | 'open'
  | 'minimize'
  | 'restore'
  | 'close'
  | 'clear'
  | 'activateScope'
  | 'getProjectSnapshot'
  | 'getSessionSnapshot'
  | 'clearProjectSnapshot'
  | 'syncScope'
  | 'resetForBoardExit'
  | 'syncTranscript'
  | 'sendMessage'
  | 'createSelected'
  | 'toggleDraftSelected'
  | 'setSelectedTargetProjectId'
  | 'openDrawer'
  | 'minimizeDrawer'
  | 'restoreDrawer'
  | 'setTranscriptMessages'
  | 'addLocalUserMessage'
  | 'addLocalSystemMessage'
  | 'setDrafts'
  | 'clearDrafts'
  | 'setAllDraftsSelected'
  | 'setStatus'
  | 'setError'
  | 'setRuntimeSession'
  | 'updateOpencodeSessionId'
  | 'clearRuntimeSession'
  | 'setComposerValue'
  | 'resetState'
> {
  return {
    isOpen: false,
    isMinimized: false,
    activeScopeKey: 'none',
    snapshots: {},
    ...createInitialSnapshot()
  }
}

function applyCreatedDraftState(drafts: TicketDraft[], createdDraftIds: string[]): TicketDraft[] {
  const createdDraftIdSet = new Set(createdDraftIds)
  return drafts.map((draft) =>
    createdDraftIdSet.has(draft.id)
      ? {
          ...draft,
          createdAt: draft.createdAt ?? new Date().toISOString()
        }
      : draft
  )
}

function getProjectName(scope: BoardChatScope | null, projectId: string): string {
  if (!scope) return 'Unknown project'
  if (scope.kind === 'project') return scope.projectName
  if (scope.kind === 'connection') {
    return scope.availableProjects.find((project) => project.id === projectId)?.name ?? 'Unknown project'
  }
  return 'Pinned projects'
}

function parseDraftsFromMessage(
  message: OpenCodeMessage,
  scope: BoardChatScope | null,
  selectedTargetProjectId: string | null
): TicketDraft[] | null {
  const strictProjectId = scope?.kind === 'project' ? scope.projectId : null
  const fallbackProjectId = strictProjectId ?? selectedTargetProjectId
  const parsed = parseBoardAssistantDraftSet(message.content, {
    fallbackProjectId,
    strictProjectId,
    requireExplicitDraftKeys: scope?.kind === 'project'
  })
  if (!parsed) return null

  const drafts = parsed.drafts.map((draft) => ({
    id: `${message.id}:${draft.draftKey}:${strictProjectId ?? draft.projectId}`,
    draftKey: draft.draftKey,
    title: draft.title,
    description: draft.description,
    dependsOn: draft.dependsOn,
    resolvedDependsOnTitles: [] as string[],
    warnings: draft.warnings,
    validationIssues: [...draft.validationIssues],
    projectId: strictProjectId ?? draft.projectId,
    projectName: getProjectName(scope, strictProjectId ?? draft.projectId),
    selected: true,
    createdAt: null
  }))

  const titleByDraftKey = new Map(drafts.map((draft) => [draft.draftKey, draft.title]))
  for (const draft of drafts) {
    draft.resolvedDependsOnTitles = draft.dependsOn.map(
      (dependency) => titleByDraftKey.get(dependency) ?? dependency
    )
  }

  return drafts.filter((draft) => draft.projectId.length > 0)
}

async function cleanupRuntime(sessionId: string | null, opencodeSessionId: string | null, runtimePath: string | null): Promise<void> {
  try {
    if (opencodeSessionId && runtimePath) {
      await window.opencodeOps.disconnect(runtimePath, opencodeSessionId)
    }
  } catch {
    // Best effort only.
  }

  try {
    if (sessionId) {
      await window.db.session.delete(sessionId)
    }
  } catch {
    // Best effort only.
  }
}

async function buildBoardContext(scope: BoardChatScope, selectedTargetProjectId: string | null): Promise<string> {
  if (scope.kind === 'project') {
    const tickets = await window.kanban.ticket.getByProject(scope.projectId, false)
    return [
      `Single-project board: ${scope.projectName}`,
      `Target project ID: ${scope.projectId}`,
      'Current tickets:',
      ...tickets.slice(0, 50).map((ticket: KanbanTicket) => `- [${ticket.column}] ${ticket.title}`)
    ].join('\n')
  }

  if (scope.kind === 'connection') {
    const ticketGroups = await Promise.all(
      scope.availableProjects.map(async (project) => ({
        project,
        tickets: await window.kanban.ticket.getByProject(project.id, false)
      }))
    )

    return [
      `Connection board: ${scope.connectionName}`,
      `Target project ID for new tickets: ${selectedTargetProjectId || 'none selected'}`,
      `Projects in scope: ${scope.availableProjects.map((project) => project.name).join(', ')}`,
      ...ticketGroups.flatMap(({ project, tickets }) => [
        `${project.name}:`,
        ...tickets.slice(0, 20).map((ticket: KanbanTicket) => `- [${ticket.column}] ${ticket.title}`)
      ])
    ].join('\n')
  }

  return 'Pinned multi-project boards are not supported.'
}

function buildAssistantPrompt(
  scope: BoardChatScope,
  selectedTargetProjectId: string | null,
  boardContext: string,
  userMessage: string
): string {
  const targetProjectId =
    scope.kind === 'project'
      ? scope.projectId
      : selectedTargetProjectId

  return [
    '<board-assistant-rules>',
    'You are Hive Board Assistant.',
    'Purpose: converse in order to create local kanban tickets for the current board.',
    'If you need clarification, ask one concise question and do not include draft tickets yet.',
    'When you are ready to propose tickets, include exactly one fenced code block labeled board-ticket-drafts.',
    'The block must contain strict JSON shaped like:',
    '```board-ticket-drafts',
    scope.kind === 'project'
      ? '{"drafts":[{"draftKey":"string","title":"string","description":"string|null","projectId":"string","dependsOn":["draftKey"],"warnings":["string"]}]}'
      : '{"drafts":[{"title":"string","description":"string","projectId":"string","warnings":["string"]}]}',
    '```',
    `Every proposed draft must use projectId=${targetProjectId || 'MISSING_TARGET_PROJECT'}.`,
    ...(scope.kind === 'project'
      ? [
          'For project boards, every draft must include a unique draftKey.',
          'Use dependsOn to reference other drafts by draftKey when there is a dependency.'
        ]
      : []),
    'Keep draft tickets concrete and local-only.',
    '</board-assistant-rules>',
    '<board-assistant-context>',
    boardContext,
    '</board-assistant-context>',
    `User request: ${userMessage}`
  ].join('\n')
}

async function ensureRuntime(): Promise<{
  sessionId: string
  opencodeSessionId: string
  runtimePath: string
}> {
  const state = useBoardChatStore.getState()
  const scope = state.scope

  if (!scope || scope.kind === 'pinned') {
    throw new Error('Board Assistant is unavailable for this board.')
  }

  const runtimePath = scope.kind === 'project' ? scope.projectPath : scope.connectionPath
  if (!runtimePath) {
    throw new Error('Board path is unavailable for this board.')
  }

  if (state.sessionId && state.opencodeSessionId) {
    await window.opencodeOps.reconnect(runtimePath, state.opencodeSessionId, state.sessionId)
    return {
      sessionId: state.sessionId,
      opencodeSessionId: state.opencodeSessionId,
      runtimePath
    }
  }

  const settings = useSettingsStore.getState()
  const agentSdk = state.selectedAgentSdkOverride ?? resolveBoardChatAgentSdk(settings.defaultAgentSdk)
  const model = state.selectedModelOverride ?? resolveBoardChatDefaultModel(settings, agentSdk)

  const projectId =
    scope.kind === 'project'
      ? scope.projectId
      : state.selectedTargetProjectId

  if (!projectId) {
    throw new Error('Select a target project before starting the board assistant.')
  }

  const session = await window.db.session.create({
    worktree_id: null,
    connection_id: null,
    project_id: projectId,
    name: `${BOARD_ASSISTANT_SESSION_NAME_PREFIX} ${scope.kind === 'project' ? scope.projectName : scope.connectionName}`,
    agent_sdk: agentSdk,
    ...(model
      ? {
          model_provider_id: model.providerID,
          model_id: model.modelID,
          model_variant: model.variant ?? null
        }
      : {})
  })

  const connectResult = await window.opencodeOps.connect(runtimePath, session.id)
  if (!connectResult.success || !connectResult.sessionId) {
    await window.db.session.delete(session.id).catch(() => {})
    throw new Error(connectResult.error || 'Failed to start board assistant session.')
  }

  await window.db.session.update(session.id, { opencode_session_id: connectResult.sessionId })

  useBoardChatStore.setState((state) =>
    patchActiveSnapshot(state, {
      sessionId: session.id,
      opencodeSessionId: connectResult.sessionId,
      runtimePath
    })
  )

  return {
    sessionId: session.id,
    opencodeSessionId: connectResult.sessionId,
    runtimePath
  }
}

async function resetAndCleanup(state: Pick<BoardChatState, 'sessionId' | 'opencodeSessionId' | 'runtimePath'>): Promise<void> {
  await cleanupRuntime(state.sessionId, state.opencodeSessionId, state.runtimePath)
}

export const useBoardChatStore = create<BoardChatState>((set, get) => ({
  ...createBaseState(),

  open: () => set({ isOpen: true, isMinimized: false }),
  minimize: () => set({ isOpen: true, isMinimized: true }),
  restore: () => set({ isOpen: true, isMinimized: false }),

  close: async () => {
    const state = get()
    const resetSnapshot = createInitialSnapshot({
      scope: state.scope,
      selectedTargetProjectId:
        state.scope?.kind === 'project' ? state.scope.projectId : state.selectedTargetProjectId,
      selectedAgentSdkOverride: state.selectedAgentSdkOverride,
      selectedModelOverride: state.selectedModelOverride
    })
    set((current) => ({
      isOpen: false,
      ...replaceActiveSnapshot(current, resetSnapshot, current.activeScopeKey, {
        dropExistingSnapshot: true
      })
    }))
    await resetAndCleanup(state)
  },

  clear: async () => {
    const state = get()
    set((current) =>
      replaceActiveSnapshot(
        current,
        createInitialSnapshot({
          scope: state.scope,
          selectedTargetProjectId:
            state.scope?.kind === 'project' ? state.scope.projectId : state.selectedTargetProjectId,
          selectedAgentSdkOverride: state.selectedAgentSdkOverride,
          selectedModelOverride: state.selectedModelOverride
        }),
        current.activeScopeKey
      )
    )
    await resetAndCleanup(state)
  },

  activateScope: (scope, options) => {
    set((state) => {
      const scopeKey = getScopeKey(scope)
      const existing = scopeKey !== 'none' ? state.snapshots[scopeKey] : null

      if (existing) {
        const hydrated = {
          ...existing,
          scope,
          selectedTargetProjectId:
            scope?.kind === 'project'
              ? scope.projectId
              : existing.selectedTargetProjectId ?? buildDefaultTargetProjectId(scope)
        }
        return replaceActiveSnapshot(state, hydrated, scopeKey)
      }

      return replaceActiveSnapshot(
        state,
        createInitialSnapshot({
          ...options,
          scope,
          selectedTargetProjectId:
            options?.selectedTargetProjectId ?? buildDefaultTargetProjectId(scope)
        }),
        scopeKey
      )
    })
  },

  getProjectSnapshot: (projectId) => {
    const key = `project:${projectId}`
    const state = get()
    if (state.activeScopeKey === key) {
      return getSnapshotFromState(state)
    }
    return state.snapshots[key] ?? null
  },

  getSessionSnapshot: (sessionId) => {
    const state = get()
    if (!sessionId) return null

    if (state.sessionId === sessionId) {
      return {
        key: state.activeScopeKey,
        snapshot: getSnapshotFromState(state)
      }
    }

    for (const [key, snapshot] of Object.entries(state.snapshots)) {
      if (snapshot.sessionId === sessionId) {
        return { key, snapshot }
      }
    }

    return null
  },

  clearProjectSnapshot: (projectId) => {
    set((state) => {
      const key = `project:${projectId}`
      const nextSnapshots = { ...state.snapshots }
      delete nextSnapshots[key]

      if (state.activeScopeKey === key) {
        return {
          ...createBaseState(),
          isOpen: state.isOpen,
          isMinimized: state.isMinimized,
          snapshots: nextSnapshots
        }
      }

      return { snapshots: nextSnapshots }
    })
  },

  syncScope: async (scope) => {
    const current = get()
    if (getScopeKey(current.scope) === getScopeKey(scope)) {
      set((state) =>
        patchActiveSnapshot(state, {
          scope,
          selectedTargetProjectId:
            scope?.kind === 'project'
              ? scope.projectId
              : current.selectedTargetProjectId ?? buildDefaultTargetProjectId(scope)
        })
      )
      return
    }

    get().activateScope(scope, {
      scope,
      selectedTargetProjectId: buildDefaultTargetProjectId(scope)
    })
  },

  resetForBoardExit: async () => {
    const state = get()
    set({ ...createBaseState() })
    await resetAndCleanup(state)
  },

  syncTranscript: (messages, isStreaming) => {
    const mergedMessages = mergeTranscriptMessages(get().messages, messages)
    const latestDraftMessage = [...messages].reverse().find((message) => {
      return message.role === 'assistant' && BOARD_DRAFT_BLOCK_CAPTURE_RE.test(message.content)
    })
    const parsedDrafts = latestDraftMessage
      ? parseDraftsFromMessage(latestDraftMessage, get().scope, get().selectedTargetProjectId)
      : null

    set((state) =>
      patchActiveSnapshot(state, {
        messages: mergedMessages,
        drafts:
          parsedDrafts && latestDraftMessage
            ? applyCreatedDraftState(parsedDrafts, state.createdDraftIds)
            : latestDraftMessage
              ? []
              : state.drafts,
        draftSourceMessageId: latestDraftMessage?.id ?? state.draftSourceMessageId,
        status: isStreaming
          ? 'thinking'
          : parsedDrafts && parsedDrafts.length > 0
            ? 'awaiting_confirmation'
            : state.status === 'error'
              ? 'error'
              : 'idle'
      })
    )
  },

  sendMessage: async (message) => {
    const trimmed = message.trim()
    if (!trimmed) return

    const scope = get().scope
    if (!scope || scope.kind === 'pinned') {
      set((state) =>
        patchActiveSnapshot(state, {
          status: 'error',
          error: 'Board Assistant is unavailable for this board.'
        })
      )
      return
    }

    set((state) => ({
      isOpen: true,
      isMinimized: false,
      ...patchActiveSnapshot(state, {
        status: 'starting',
        error: null,
        composerValue: ''
      })
    }))
    get().addLocalUserMessage(trimmed)

    try {
      const runtime = await ensureRuntime()
      const boardContext = await buildBoardContext(scope, get().selectedTargetProjectId)
      const prompt = buildAssistantPrompt(scope, get().selectedTargetProjectId, boardContext, trimmed)
      set((state) => patchActiveSnapshot(state, { status: 'thinking' }))

      const result = await window.opencodeOps.prompt(
        runtime.runtimePath,
        runtime.opencodeSessionId,
        prompt,
        undefined,
        { codexFastMode: useSettingsStore.getState().codexFastMode }
      )

      if (!result.success) {
        throw new Error(result.error || 'Failed to send board assistant prompt.')
      }
    } catch (error) {
      set((state) =>
        patchActiveSnapshot(state, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to send board assistant prompt.'
        })
      )
      get().addLocalSystemMessage('Board Assistant failed to send that message.')
    }
  },

  createSelected: async () => {
    const selectedDrafts = get().drafts.filter((draft) => draft.selected && !draft.createdAt)
    if (selectedDrafts.length === 0) {
      get().addLocalSystemMessage('All selected drafts have already been created.')
      return
    }

    set((state) => patchActiveSnapshot(state, { status: 'starting', error: null }))

    try {
      const invalidDrafts = selectedDrafts.filter((draft) => draft.validationIssues.length > 0)
      if (invalidDrafts.length > 0) {
        throw new Error('Fix draft validation issues before creating tickets.')
      }

      const draftKeysInBatch = new Set(selectedDrafts.map((draft) => draft.draftKey))
      const result = await window.kanban.ticket.createBatch({
        drafts: selectedDrafts.map((draft) => ({
          draft_key: draft.draftKey,
          project_id: draft.projectId,
          title: draft.title,
          description: draft.description ?? null,
          column: 'todo',
          depends_on: draft.dependsOn.filter((key) => draftKeysInBatch.has(key))
        }))
      })

      for (const projectId of new Set(selectedDrafts.map((draft) => draft.projectId))) {
        await useKanbanStore.getState().loadTickets(projectId)
        await useKanbanStore.getState().loadDependencies(projectId)
      }

      get().markDraftsCreated(selectedDrafts.map((draft) => draft.id))
      get().addLocalSystemMessage(
        `Created ${result.tickets.length} ticket${result.tickets.length === 1 ? '' : 's'} with ${result.dependencies.length} dependenc${result.dependencies.length === 1 ? 'y' : 'ies'}.`
      )
      set((state) => patchActiveSnapshot(state, { status: 'idle' }))
    } catch (error) {
      set((state) =>
        patchActiveSnapshot(state, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to create selected tickets.'
        })
      )
    }
  },

  toggleDraftSelected: (draftId) =>
    set((state) =>
      patchActiveSnapshot(state, {
        drafts: state.drafts.map((draft) =>
          draft.id === draftId ? { ...draft, selected: !draft.selected } : draft
        )
      })
    ),

  markDraftsCreated: (draftIds) =>
    set((state) =>
      patchActiveSnapshot(state, {
        createdDraftIds: [...new Set([...state.createdDraftIds, ...draftIds])],
        drafts: state.drafts.map((draft) =>
          draftIds.includes(draft.id)
            ? { ...draft, createdAt: draft.createdAt ?? new Date().toISOString() }
            : draft
        )
      })
    ),

  setSelectedTargetProjectId: async (projectId) => {
    const state = get()
    if (state.selectedTargetProjectId === projectId) return

    set((current) =>
      replaceActiveSnapshot(
        current,
        createInitialSnapshot({
          scope: state.scope,
          selectedTargetProjectId: projectId,
          selectedAgentSdkOverride: state.selectedAgentSdkOverride,
          selectedModelOverride: state.selectedModelOverride
        }),
        current.activeScopeKey
      )
    )
    await resetAndCleanup(state)
  },

  setSelectedAgentSdkOverride: (selectedAgentSdkOverride) =>
    set((state) => patchActiveSnapshot(state, { selectedAgentSdkOverride })),

  setSelectedModelOverride: (selectedModelOverride) =>
    set((state) => patchActiveSnapshot(state, { selectedModelOverride })),

  openDrawer: () => get().open(),
  minimizeDrawer: () => get().minimize(),
  restoreDrawer: () => get().restore(),

  setTranscriptMessages: (messages) => get().syncTranscript(messages, false),

  addLocalUserMessage: (content) =>
    set((state) =>
      patchActiveSnapshot(state, {
        messages: [...state.messages, makeLocalMessage('user', content)]
      })
    ),

  addLocalSystemMessage: (content) =>
    set((state) =>
      patchActiveSnapshot(state, {
        messages: [...state.messages, makeLocalMessage('system', content)]
      })
    ),

  setDrafts: (drafts, sourceMessageId) =>
    set((state) =>
      patchActiveSnapshot(state, {
        drafts: applyCreatedDraftState(drafts, state.createdDraftIds),
        draftSourceMessageId: sourceMessageId,
        status: drafts.length > 0 ? 'awaiting_confirmation' : 'idle'
      })
    ),

  clearDrafts: () =>
    set((state) =>
      patchActiveSnapshot(state, {
        drafts: [],
        draftSourceMessageId: null,
        status: state.status === 'awaiting_confirmation' ? 'idle' : state.status
      })
    ),

  setAllDraftsSelected: (selected) =>
    set((state) =>
      patchActiveSnapshot(state, {
        drafts: state.drafts.map((draft) => (draft.createdAt ? draft : { ...draft, selected }))
      })
    ),

  setStatus: (status) => set((state) => patchActiveSnapshot(state, { status })),
  setError: (error) => set((state) => patchActiveSnapshot(state, { error })),
  setRuntimeSession: ({ sessionId, opencodeSessionId, runtimePath }) =>
    set((state) => patchActiveSnapshot(state, { sessionId, opencodeSessionId, runtimePath })),
  updateOpencodeSessionId: (opencodeSessionId) =>
    set((state) => patchActiveSnapshot(state, { opencodeSessionId })),
  clearRuntimeSession: () =>
    set((state) => patchActiveSnapshot(state, { sessionId: null, opencodeSessionId: null, runtimePath: null })),
  setComposerValue: (composerValue) =>
    set((state) => patchActiveSnapshot(state, { composerValue })),
  resetState: (options) =>
    set((state) =>
      replaceActiveSnapshot(
        state,
        createInitialSnapshot(options ? { ...options, scope: options.scope ?? state.scope } : { scope: state.scope }),
        state.activeScopeKey
      )
    )
}))
