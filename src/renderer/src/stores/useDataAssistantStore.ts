// The database assistant's conversations, one per data project (memory only: they hold schema
// details and are cheap to start over). `ask` snapshots the workspace context (database, schema,
// editor text), resolves the user's model and calls `dataAssistant.start`; the run then reports
// through server events (subscribed once, routed by dataProjectId and filtered by requestId and
// seq) which `reduceAssistantEvent` folds into the conversation: status line, streamed text, the
// tool trace, and finally a proposal, a prose answer, an error or done.
//
// A proposal is inserted into the editor automatically (replacing the active tab when it is
// empty, else in a new tab) through the editor bridge. Nothing here ever runs a query.

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { dataProjectsApi } from '@/api/data-projects-api'
import { readAssistantContext } from '@/components/data-projects/assistant/assistant-context'
import { useDataEditorBridge } from '@/components/data-projects/editor-bridge'
import { resolveDataAssistantGeneration } from '@/lib/data-projects/assistant-generation'
import type { SelectedModel } from '@/stores/useSettingsStore'
import {
  dataEngineFamily,
  type DataAssistantEventPayload,
  type DataAssistantStartRequest,
  type DataEngineFamily,
  type DataProject,
  type DataQueryProposal
} from '@shared/data-projects/types'

/** No event for this long while running: the server (or the connection to it) is gone. */
const WATCHDOG_MS = 200_000
/** A cancel that is not confirmed by the server within this time is finished locally. */
const CANCEL_GRACE_MS = 5_000
const HISTORY_MAX_TURNS = 12
const HISTORY_TEXT_MAX_CHARS = 4_000
const TAB_TITLE_MAX_CHARS = 40

export const ASSISTANT_PANEL_MIN_WIDTH = 300
export const ASSISTANT_PANEL_MAX_WIDTH = 760
const ASSISTANT_PANEL_DEFAULT_WIDTH = 380

export type AssistantRunStatus = 'idle' | 'running' | 'cancelling'

export interface AssistantToolStep {
  callId: string
  name: string
  /** Chip text: `describe_table(orders)`. */
  label: string
  status: 'running' | 'ok' | 'error'
  summary?: string
  ms?: number
}

export interface AssistantProposal extends DataQueryProposal {
  /** Where the proposal went automatically when it arrived (null: not inserted). */
  autoInserted: 'replace' | 'new-tab' | null
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: number
  /** Assistant messages: the tools the run used on the way. */
  tools?: AssistantToolStep[]
  proposal?: AssistantProposal
}

export interface AssistantError {
  message: string
  retryable: boolean
}

export interface AssistantConversation {
  messages: AssistantMessage[]
  status: AssistantRunStatus
  requestId: string | null
  family: DataEngineFamily
  /** Latest status line from the server ("Reading the schema…", a tool label). */
  activity: string | null
  /** Tool trace of the run in flight. */
  tools: AssistantToolStep[]
  /** Text streamed by the run in flight. */
  draft: string
  error: AssistantError | null
  startedAt: number | null
  lastSeq: number
  /** The run in flight already produced its proposal / answer message. */
  runAnswered: boolean
  /** Database the run in flight was asked in (insertion default). */
  runDatabase: string | null
  /** The last question asked (Retry re-sends it). */
  lastQuestion: string | null
  composer: string
  /** Provider/model that answered last (from `done`). */
  answeredBy: { provider: string; model?: string } | null
}

interface DataAssistantState {
  conversations: Record<string, AssistantConversation>
  /** Model picked in the panel (null = the user's default model). Persisted. */
  modelOverride: SelectedModel | null
  /** Panel width in px. Persisted. */
  width: number
  ask: (project: DataProject, question: string) => Promise<void>
  /** Re-sends the last question (after an error). */
  retry: (project: DataProject) => Promise<void>
  cancel: (projectId: string) => Promise<void>
  newConversation: (projectId: string) => void
  setComposer: (projectId: string, text: string) => void
  setModelOverride: (model: SelectedModel | null) => void
  setWidth: (width: number) => void
  /** Puts a proposal into the editor again (Insert / Open in new tab). Never runs it. */
  insertProposal: (projectId: string, messageId: string, mode: 'replace' | 'new-tab') => void
  handleEvent: (payload: DataAssistantEventPayload) => void
  reset: () => void
}

export function emptyConversation(family: DataEngineFamily = 'sql'): AssistantConversation {
  return {
    messages: [],
    status: 'idle',
    requestId: null,
    family,
    activity: null,
    tools: [],
    draft: '',
    error: null,
    startedAt: null,
    lastSeq: 0,
    runAnswered: false,
    runDatabase: null,
    lastQuestion: null,
    composer: '',
    answeredBy: null
  }
}

/** Stable empty value for selectors (a fresh object per call would re-render forever). */
export const EMPTY_CONVERSATION: AssistantConversation = Object.freeze(
  emptyConversation()
) as AssistantConversation

let idSeq = 0
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++idSeq}`

function newRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // Fall through.
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${++idSeq}`
}

const ARG_LABEL_KEYS = ['table', 'collection', 'pattern', 'database', 'schema'] as const

/** `describe_table(orders)`, `search_columns(*_at)`, `list_databases`. */
export function toolLabel(name: string, args: Record<string, unknown>): string {
  if (name === 'propose_query') return 'propose_query'
  for (const key of ARG_LABEL_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      const shown = value.trim().length > 40 ? `${value.trim().slice(0, 39)}…` : value.trim()
      return `${name}(${shown})`
    }
  }
  return name
}

function proposalAsText(proposal: DataQueryProposal): string {
  const fence = proposal.language === 'mongo' ? 'js' : 'sql'
  return [proposal.explanation, `\`\`\`${fence}\n${proposal.query}\n\`\`\``]
    .filter(Boolean)
    .join('\n\n')
}

/** Earlier turns for the server (oldest first), assistant proposals as fenced queries. */
export function buildAssistantHistory(
  messages: AssistantMessage[]
): DataAssistantStartRequest['history'] {
  const turns: DataAssistantStartRequest['history'] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    const text = message.proposal ? proposalAsText(message.proposal) : message.text
    if (!text.trim()) continue
    turns.push({
      role: message.role,
      text:
        text.length > HISTORY_TEXT_MAX_CHARS ? `${text.slice(0, HISTORY_TEXT_MAX_CHARS)}…` : text
    })
  }
  return turns.slice(-HISTORY_MAX_TURNS)
}

export interface AssistantReduction {
  conversation: AssistantConversation
  /** A proposal message was added: insert it into the editor. */
  insertMessageId?: string
}

/**
 * Folds one server event into a conversation. Events of another request (an older, superseded
 * or cancelled run) and repeated/out-of-order seqs are ignored.
 */
export function reduceAssistantEvent(
  conversation: AssistantConversation,
  payload: DataAssistantEventPayload
): AssistantReduction {
  if (conversation.requestId !== payload.requestId || payload.seq <= conversation.lastSeq) {
    return { conversation }
  }
  const next: AssistantConversation = { ...conversation, lastSeq: payload.seq }
  const event = payload.event
  const now = Date.now()
  switch (event.type) {
    case 'status':
      next.activity = event.text
      return { conversation: next }
    case 'text_delta':
      next.draft = conversation.draft + event.text
      return { conversation: next }
    case 'tool_start': {
      const label = toolLabel(event.name, event.args ?? {})
      next.tools = [
        ...conversation.tools,
        { callId: event.callId, name: event.name, label, status: 'running' }
      ]
      next.activity = label
      // Text streamed before a tool call is the model thinking aloud, not the answer.
      next.draft = ''
      return { conversation: next }
    }
    case 'tool_end':
      next.tools = conversation.tools.map((step) =>
        step.callId === event.callId
          ? { ...step, status: event.ok ? 'ok' : 'error', summary: event.summary, ms: event.ms }
          : step
      )
      return { conversation: next }
    case 'proposal': {
      const id = nextId('assistant')
      next.messages = [
        ...conversation.messages,
        {
          id,
          role: 'assistant',
          text: event.proposal.explanation,
          createdAt: now,
          tools: conversation.tools,
          proposal: { ...event.proposal, autoInserted: null }
        }
      ]
      next.draft = ''
      next.runAnswered = true
      next.activity = 'Query ready'
      return { conversation: next, insertMessageId: id }
    }
    case 'answer':
      next.messages = [
        ...conversation.messages,
        {
          id: nextId('assistant'),
          role: 'assistant',
          text: event.text,
          createdAt: now,
          tools: conversation.tools
        }
      ]
      next.draft = ''
      next.runAnswered = true
      return { conversation: next }
    case 'error':
      return {
        conversation: {
          ...next,
          status: 'idle',
          requestId: null,
          activity: null,
          tools: [],
          draft: '',
          startedAt: null,
          error: { message: event.message, retryable: event.retryable }
        }
      }
    case 'done': {
      const messages = [...conversation.messages]
      if (
        !conversation.runAnswered &&
        conversation.draft.trim() &&
        conversation.status !== 'cancelling'
      ) {
        messages.push({
          id: nextId('assistant'),
          role: 'assistant',
          text: conversation.draft.trim(),
          createdAt: now,
          tools: conversation.tools
        })
      }
      if (conversation.status === 'cancelling') {
        messages.push({ id: nextId('system'), role: 'system', text: 'Stopped.', createdAt: now })
      }
      return {
        conversation: {
          ...next,
          messages,
          status: 'idle',
          requestId: null,
          activity: null,
          tools: [],
          draft: '',
          startedAt: null,
          answeredBy: { provider: event.provider, ...(event.model ? { model: event.model } : {}) }
        }
      }
    }
    default:
      return { conversation }
  }
}

// ---------------------------------------------------------------------------------------------
// Module-level runtime (subscription, timers): not state, never persisted
// ---------------------------------------------------------------------------------------------

let unsubscribe: (() => void) | null = null
const watchdogs = new Map<string, ReturnType<typeof setTimeout>>()
const cancelTimers = new Map<string, ReturnType<typeof setTimeout>>()

function ensureSubscribed(): void {
  if (unsubscribe) return
  unsubscribe = dataProjectsApi.assistant.onEvent((payload) =>
    useDataAssistantStore.getState().handleEvent(payload)
  )
}

function clearTimer(map: Map<string, ReturnType<typeof setTimeout>>, projectId: string): void {
  const timer = map.get(projectId)
  if (timer) clearTimeout(timer)
  map.delete(projectId)
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || 'The assistant could not start.'
}

const shortTitle = (question: string | null): string => {
  const flat = (question ?? '').replace(/\s+/g, ' ').trim()
  const cut =
    flat.length > TAB_TITLE_MAX_CHARS ? `${flat.slice(0, TAB_TITLE_MAX_CHARS - 1)}…` : flat
  return cut ? `AI: ${cut}` : 'AI query'
}

const clampWidth = (width: number): number =>
  Math.min(ASSISTANT_PANEL_MAX_WIDTH, Math.max(ASSISTANT_PANEL_MIN_WIDTH, Math.round(width)))

export const useDataAssistantStore = create<DataAssistantState>()(
  persist(
    (set, get) => {
      const conversationOf = (projectId: string): AssistantConversation | undefined =>
        get().conversations[projectId]

      const update = (
        projectId: string,
        change: (conversation: AssistantConversation) => AssistantConversation
      ): void => {
        set((state) => {
          const current = state.conversations[projectId] ?? emptyConversation()
          return { conversations: { ...state.conversations, [projectId]: change(current) } }
        })
      }

      /** No event for WATCHDOG_MS: give up on the run locally. */
      const armWatchdog = (projectId: string, requestId: string): void => {
        clearTimer(watchdogs, projectId)
        watchdogs.set(
          projectId,
          setTimeout(() => {
            watchdogs.delete(projectId)
            const conversation = conversationOf(projectId)
            if (!conversation || conversation.requestId !== requestId) return
            update(projectId, (c) => ({
              ...c,
              status: 'idle',
              requestId: null,
              activity: null,
              tools: [],
              draft: '',
              startedAt: null,
              error: { message: 'The assistant stopped responding.', retryable: true }
            }))
          }, WATCHDOG_MS)
        )
      }

      const finishLocally = (projectId: string, requestId: string): void => {
        clearTimer(watchdogs, projectId)
        clearTimer(cancelTimers, projectId)
        const conversation = conversationOf(projectId)
        if (!conversation || conversation.requestId !== requestId) return
        update(projectId, (c) => ({
          ...c,
          status: 'idle',
          requestId: null,
          activity: null,
          tools: [],
          draft: '',
          startedAt: null,
          messages: [
            ...c.messages,
            { id: nextId('system'), role: 'system', text: 'Stopped.', createdAt: Date.now() }
          ]
        }))
      }

      const insert = (
        projectId: string,
        messageId: string,
        mode: 'replace' | 'new-tab',
        automatic: boolean
      ): void => {
        const conversation = conversationOf(projectId)
        const message = conversation?.messages.find((m) => m.id === messageId)
        const proposal = message?.proposal
        if (!conversation || !proposal) return
        const database = proposal.database ?? conversation.runDatabase ?? undefined
        useDataEditorBridge.getState().insert({
          dataProjectId: projectId,
          text: proposal.query,
          mode,
          ...(database ? { database } : {}),
          title: shortTitle(conversation.lastQuestion),
          origin: 'assistant'
        })
        if (automatic) {
          update(projectId, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId && m.proposal
                ? { ...m, proposal: { ...m.proposal, autoInserted: mode } }
                : m
            )
          }))
        }
      }

      const start = async (
        project: DataProject,
        question: string,
        isRetry: boolean
      ): Promise<void> => {
        const text = question.trim()
        const projectId = project.id
        const family = dataEngineFamily(project.engine)
        const before = conversationOf(projectId) ?? emptyConversation(family)
        if (!text || before.status !== 'idle') return
        ensureSubscribed()

        const context = readAssistantContext(projectId, family)
        // Retry re-sends the question already shown as the last user bubble.
        const priorMessages =
          isRetry && before.messages.at(-1)?.role === 'user'
            ? before.messages.slice(0, -1)
            : before.messages
        const history = buildAssistantHistory(priorMessages)
        const userMessages: AssistantMessage[] = isRetry
          ? before.messages
          : [...before.messages, { id: nextId('user'), role: 'user', text, createdAt: Date.now() }]
        const generation = resolveDataAssistantGeneration(get().modelOverride)

        if (!generation) {
          update(projectId, (c) => ({
            ...c,
            family,
            messages: userMessages,
            composer: isRetry ? c.composer : '',
            lastQuestion: text,
            error: {
              message:
                'No AI provider is installed. Install Claude Code, Codex or OpenCode, or pick a model in Settings › Models.',
              retryable: true
            }
          }))
          return
        }

        const requestId = newRequestId()
        update(projectId, (c) => ({
          ...c,
          family,
          messages: userMessages,
          status: 'running',
          requestId,
          activity: 'Starting…',
          tools: [],
          draft: '',
          error: null,
          startedAt: Date.now(),
          lastSeq: 0,
          runAnswered: false,
          runDatabase: context.database ?? null,
          lastQuestion: text,
          composer: isRetry ? c.composer : ''
        }))
        armWatchdog(projectId, requestId)

        try {
          await dataProjectsApi.assistant.start({
            requestId,
            dataProjectId: projectId,
            question: text,
            ...(context.database ? { database: context.database } : {}),
            ...(context.schema ? { schema: context.schema } : {}),
            ...(context.editorText?.trim() ? { editorText: context.editorText } : {}),
            history,
            generation
          })
        } catch (error) {
          clearTimer(watchdogs, projectId)
          if (conversationOf(projectId)?.requestId !== requestId) return
          update(projectId, (c) => ({
            ...c,
            status: 'idle',
            requestId: null,
            activity: null,
            startedAt: null,
            error: { message: errorMessage(error), retryable: true }
          }))
        }
      }

      return {
        conversations: {},
        modelOverride: null,
        width: ASSISTANT_PANEL_DEFAULT_WIDTH,

        ask: (project, question) => start(project, question, false),

        retry: async (project) => {
          const question = conversationOf(project.id)?.lastQuestion
          if (question) await start(project, question, true)
        },

        cancel: async (projectId) => {
          const conversation = conversationOf(projectId)
          const requestId = conversation?.requestId
          if (!conversation || !requestId || conversation.status !== 'running') return
          update(projectId, (c) => ({ ...c, status: 'cancelling', activity: 'Stopping…' }))
          clearTimer(cancelTimers, projectId)
          cancelTimers.set(
            projectId,
            setTimeout(() => finishLocally(projectId, requestId), CANCEL_GRACE_MS)
          )
          try {
            const { cancelled } = await dataProjectsApi.assistant.cancel(requestId)
            // The run had already ended on the server: its terminal event may never come.
            if (!cancelled) finishLocally(projectId, requestId)
          } catch {
            finishLocally(projectId, requestId)
          }
        },

        newConversation: (projectId) => {
          const conversation = conversationOf(projectId)
          if (conversation?.requestId) void get().cancel(projectId)
          clearTimer(watchdogs, projectId)
          clearTimer(cancelTimers, projectId)
          set((state) => ({
            conversations: {
              ...state.conversations,
              [projectId]: emptyConversation(conversation?.family ?? 'sql')
            }
          }))
        },

        setComposer: (projectId, text) => update(projectId, (c) => ({ ...c, composer: text })),

        setModelOverride: (model) => set({ modelOverride: model }),

        setWidth: (width) => set({ width: clampWidth(width) }),

        insertProposal: (projectId, messageId, mode) => insert(projectId, messageId, mode, false),

        handleEvent: (payload) => {
          const conversation = conversationOf(payload.dataProjectId)
          if (!conversation) return
          const { conversation: next, insertMessageId } = reduceAssistantEvent(
            conversation,
            payload
          )
          if (next === conversation) return
          set((state) => ({
            conversations: { ...state.conversations, [payload.dataProjectId]: next }
          }))
          if (next.requestId) armWatchdog(payload.dataProjectId, next.requestId)
          else {
            clearTimer(watchdogs, payload.dataProjectId)
            clearTimer(cancelTimers, payload.dataProjectId)
          }
          if (insertMessageId) {
            // Auto-insert: an empty active tab takes it; otherwise a new tab, so the user's
            // own query is never overwritten.
            const context = readAssistantContext(payload.dataProjectId, next.family)
            const mode = context.editorText?.trim() ? 'new-tab' : 'replace'
            insert(payload.dataProjectId, insertMessageId, mode, true)
          }
        },

        reset: () => {
          unsubscribe?.()
          unsubscribe = null
          for (const timer of [...watchdogs.values(), ...cancelTimers.values()]) clearTimeout(timer)
          watchdogs.clear()
          cancelTimers.clear()
          set({ conversations: {}, modelOverride: null, width: ASSISTANT_PANEL_DEFAULT_WIDTH })
        }
      }
    },
    {
      name: 'hive-data-assistant',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({ modelOverride: state.modelOverride, width: state.width })
    }
  )
)

/** The conversation of a project for selectors (a stable empty one when there is none yet). */
export const selectAssistantConversation =
  (projectId: string) =>
  (state: DataAssistantState): AssistantConversation =>
    state.conversations[projectId] ?? EMPTY_CONVERSATION
