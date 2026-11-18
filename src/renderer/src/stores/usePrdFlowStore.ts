import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import { registerPrdFlowHold } from './store-coordination'

// The flows of "New PRD → orchestrator ticket…": one per board ticket, from the moment the form
// is sent until the orchestrator ticket exists (the flow is forgotten then) or the person
// cancels it. A flow is this app's own errand on this Mac: it is kept in localStorage, not in
// the database, so it is back the moment the window is, before any session reports a status,
// and no other window, instance or Mac drives it. lib/prd-flow/driver moves it along;
// lib/prd-flow/start creates it; the card (KanbanTicketCard) shows it.

/**
 * Where a flow stands:
 *   - `launching`: the ticket exists and its session is being started with the PRD prompt;
 *   - `prd`: the session was asked for <PREFIX>_PRD.html;
 *   - `tasks`: the PRD exists and the same session was asked for <PREFIX>_TASKS.html;
 *   - `creating_run`: the tasks document exists and the orchestrator ticket is being made of it.
 */
export type PrdFlowStage = 'launching' | 'prd' | 'tasks' | 'creating_run'

/** `needs_attention`: the flow stopped and prompts nothing until the person retries (or it resumes). */
export type PrdFlowStatus = 'running' | 'needs_attention'

/** Why a flow needs attention. */
export type PrdFlowAttention =
  /** The session could not be started. */
  | 'launch_failed'
  /** The session came to rest without the document, also after it was asked again. */
  | 'missing_file'
  /** The turn kept ending on an API error. */
  | 'api_error'
  /** The session kept going away mid-turn. */
  | 'interrupted'
  /** The person stopped the turn. */
  | 'user_stopped'
  /** The person closed the session. */
  | 'session_closed'
  /** A prompt could not be delivered. */
  | 'send_failed'
  /** The orchestrator ticket could not be created from the tasks document. */
  | 'run_failed'

/** Where the flow's session runs: the project's main checkout, or a connection project's base instance. */
export type PrdFlowCheckout =
  { kind: 'worktree'; worktreeId: string } | { kind: 'connection'; connectionId: string }

export interface PrdFlow {
  /** The board ticket the flow belongs to: the key of the flow. */
  ticketId: string
  projectId: string
  /** The ticket's name as the person typed it. */
  name: string
  /** Its file-name prefix (`prdFlowPrefix(name)`), fixed when the flow starts. */
  prefix: string
  /** What the person wants, as they typed it. */
  prompt: string
  /** The form's checkmarks. */
  research: boolean
  clarify: boolean
  /** The agent and model the session runs with. */
  launch: DocumentRunLaunchConfig
  checkout: PrdFlowCheckout
  /** The directory the session runs in, where the documents are expected. Pinned at the start. */
  cwd: string
  /**
   * Directories inside `cwd` an agent may write a document into instead (the member
   * repositories of a connection directory); empty for a git project.
   */
  memberDirs: string[]
  sessionId: string | null
  stage: PrdFlowStage
  status: PrdFlowStatus
  attention: PrdFlowAttention | null
  /** What the card says: what the flow waits for, or what went wrong. */
  detail: string | null
  /** When the stage's last prompt was stamped (epoch ms), always before it is sent. */
  promptedAt: number | null
  /** Times the stage's document was asked for again after a turn that ended without it. */
  reprompts: number
  /** Times the stage was resumed after an API error, an interruption or an undelivered prompt. */
  resumes: number
  /** Since when the stage waits for work the session left running (epoch ms). */
  waitingSince: number | null
  /** Not before this (epoch ms) is the session prompted again after an API error. */
  retryAt: number | null
  /** The person pressed Retry: the session is prompted again whatever state it is found in. */
  forcePrompt: boolean
  /** Absolute paths of the documents, once found. */
  prdPath: string | null
  tasksPath: string | null
  /** The orchestrator run made from the tasks document. */
  runId: string | null
  createdAt: number
}

export type PrdFlowPatch = Partial<Omit<PrdFlow, 'ticketId' | 'projectId' | 'createdAt'>>

export interface PrdFlowDialogState {
  open: boolean
  /** The project the form is for; kept while it closes. */
  projectId: string | null
}

interface PrdFlowState {
  /** Every flow that is not over, by its ticket's id. */
  flows: Record<string, PrdFlow>
  dialog: PrdFlowDialogState
  /** The agent and model last chosen in the form; null = the app's default launch. */
  launchPref: DocumentRunLaunchConfig | null

  openDialog: (projectId: string) => void
  closeDialog: () => void
  putFlow: (flow: PrdFlow) => void
  /** Present keys only. Resolves to the flow as it is now, or null when it is gone. */
  patchFlow: (ticketId: string, patch: PrdFlowPatch) => PrdFlow | null
  removeFlow: (ticketId: string) => void
  setLaunchPref: (launch: DocumentRunLaunchConfig | null) => void
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b))

const STAGES: readonly PrdFlowStage[] = ['launching', 'prd', 'tasks', 'creating_run']
const STATUSES: readonly PrdFlowStatus[] = ['running', 'needs_attention']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isLaunchConfig = (value: unknown): value is DocumentRunLaunchConfig =>
  isRecord(value) && typeof value.sdk === 'string'

function isCheckout(value: unknown): value is PrdFlowCheckout {
  if (!isRecord(value)) return false
  if (value.kind === 'worktree') return typeof value.worktreeId === 'string'
  return value.kind === 'connection' && typeof value.connectionId === 'string'
}

/**
 * What localStorage holds under a ticket's id is a flow the driver and the card can read: it
 * is the flow of that ticket, and everything they read without asking first (where it runs,
 * with what, how far it is) is there in its own shape.
 */
function isStoredFlow(ticketId: string, value: unknown): value is PrdFlow {
  return (
    isRecord(value) &&
    value.ticketId === ticketId &&
    (['projectId', 'name', 'prefix', 'prompt', 'cwd'] as const).every(
      (key) => typeof value[key] === 'string'
    ) &&
    STAGES.includes(value.stage as PrdFlowStage) &&
    STATUSES.includes(value.status as PrdFlowStatus) &&
    isLaunchConfig(value.launch) &&
    isCheckout(value.checkout) &&
    Array.isArray(value.memberDirs) &&
    value.memberDirs.every((dir) => typeof dir === 'string')
  )
}

/**
 * The flows read back from localStorage, without the entries that are not flows. The stored
 * text is not this build's to trust (an older build, a hand edit, a write cut short), and one
 * entry the driver cannot read must not stop it, or the form, for every other flow.
 */
function readStoredFlows(stored: unknown): Record<string, PrdFlow> {
  if (!isRecord(stored)) return {}
  const flows: Record<string, PrdFlow> = {}
  let dropped = 0
  for (const [ticketId, value] of Object.entries(stored)) {
    if (isStoredFlow(ticketId, value)) flows[ticketId] = value
    else dropped += 1
  }
  if (dropped > 0) {
    console.warn(`[prdFlow] dropped ${dropped} stored flow(s) that could not be read`)
  }
  return flows
}

export const usePrdFlowStore = create<PrdFlowState>()(
  persist(
    (set, get) => ({
      flows: {},
      dialog: { open: false, projectId: null },
      launchPref: null,

      openDialog: (projectId) => set({ dialog: { open: true, projectId } }),
      closeDialog: () => set((state) => ({ dialog: { ...state.dialog, open: false } })),

      putFlow: (flow) => set((state) => ({ flows: { ...state.flows, [flow.ticketId]: flow } })),

      patchFlow: (ticketId, patch) => {
        const current = get().flows[ticketId]
        if (!current) return null
        // A write that changes nothing keeps the object: every card reads its flow from here.
        const changed = (Object.keys(patch) as (keyof PrdFlowPatch)[]).some(
          (key) => !sameValue(current[key], patch[key])
        )
        if (!changed) return current
        const next: PrdFlow = { ...current, ...patch }
        set((state) => ({ flows: { ...state.flows, [ticketId]: next } }))
        return next
      },

      removeFlow: (ticketId) =>
        set((state) => {
          if (!state.flows[ticketId]) return state
          const flows = { ...state.flows }
          delete flows[ticketId]
          return { flows }
        }),

      setLaunchPref: (launchPref) => set({ launchPref })
    }),
    {
      name: 'hive-prd-flows',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // The flows and the remembered model persist; the form is closed in a new window.
      partialize: (state) => ({ flows: state.flows, launchPref: state.launchPref }),
      merge: (persisted, current) => {
        const saved = isRecord(persisted) ? persisted : {}
        return {
          ...current,
          flows: readStoredFlows(saved.flows),
          launchPref: isLaunchConfig(saved.launchPref) ? saved.launchPref : null
        }
      }
    }
  )
)

/**
 * The flow keeps its ticket In Progress: it is on, and its session is (or is about to be) at
 * one of its prompts. A flow that needs attention holds nothing: its ticket moves as any other.
 */
export function isPrdFlowHolding(flow: PrdFlow | null | undefined): boolean {
  return !!flow && flow.status === 'running'
}

/** The flow of a ticket, or null. Not a hook. */
export function prdFlowOfTicket(ticketId: string): PrdFlow | null {
  return usePrdFlowStore.getState().flows[ticketId] ?? null
}

/** The flow of a ticket as the store holds it (the same object until the flow changes), or null. */
export function useTicketPrdFlow(ticketId: string): PrdFlow | null {
  return usePrdFlowStore((state) => state.flows[ticketId] ?? null)
}

// The kanban store keeps a ticket In Progress while its flow is on.
registerPrdFlowHold((ticketId) => isPrdFlowHolding(usePrdFlowStore.getState().flows[ticketId]))
