// Hands text to a data project's workspace from outside it: the AI assistant's proposals, the
// schema tree's "Generate SELECT", history and saved queries. The workspace (SQL or Mongo)
// subscribes for its project and places the text in the active query/shell tab, or opens a new
// one. Nothing here ever runs a query.
//
// Insertions queue per project: one made for a project that is not on screen (the assistant
// answering after the user switched to another project) waits until that project's workspace
// mounts and takes it, and an insertion for another project never replaces it. A workspace reads
// its next insertion with `selectPendingFor(projectId)` and removes it with `consume(seq)`.

import { create } from 'zustand'

export interface DataEditorInsertion {
  /** Monotonic id so the same text can be inserted twice. */
  seq: number
  dataProjectId: string
  text: string
  /** 'replace' the active tab's text, or 'new-tab' to open a fresh query/shell tab. */
  mode: 'replace' | 'new-tab'
  /** Database the text was written for (switches the tab's database when given). */
  database?: string
  /** Tab title hint for 'new-tab' ("AI: orders since yesterday", "Saved: daily revenue"). */
  title?: string
  /** Shown as a badge on the tab until the text is edited or run. */
  origin?: 'assistant' | 'history' | 'saved' | 'schema'
}

/** Waiting insertions kept per project; beyond it the oldest go (a project never reopened). */
export const MAX_PENDING_INSERTIONS_PER_PROJECT = 20

export interface DataEditorBridgeState {
  /** Waiting insertions of every project, oldest first. */
  queue: DataEditorInsertion[]
  /**
   * The most recent waiting insertion of any project: what the single slot used to hold, kept for
   * readers that predate the per-project queue (workspaces use `selectPendingFor`). Null means
   * nothing waits: setting it to null (older tests and callers) clears the whole queue.
   */
  pending: DataEditorInsertion | null
  insert: (insertion: Omit<DataEditorInsertion, 'seq'>) => void
  /** Removes the insertion `seq` once a workspace applied it (no-op when it is already gone). */
  consume: (seq: number) => void
  /** Drops the waiting insertions of one project (removed, forgotten) or of every project. */
  clear: (projectId?: string) => void
}

/** The queue as it stands: `pending: null` written from outside means it was cleared. */
const liveQueue = (
  state: Pick<DataEditorBridgeState, 'queue' | 'pending'>
): DataEditorInsertion[] => (state.pending === null ? [] : state.queue)

const withQueue = (
  queue: DataEditorInsertion[]
): Pick<DataEditorBridgeState, 'queue' | 'pending'> => ({
  queue,
  pending: queue[queue.length - 1] ?? null
})

let nextSeq = 1

export const useDataEditorBridge = create<DataEditorBridgeState>()((set) => ({
  queue: [],
  pending: null,

  insert: (insertion) =>
    set((state) => {
      const item: DataEditorInsertion = { ...insertion, seq: nextSeq++ }
      let queue = [...liveQueue(state), item]
      const mine = queue.filter((i) => i.dataProjectId === item.dataProjectId)
      if (mine.length > MAX_PENDING_INSERTIONS_PER_PROJECT) {
        const drop = new Set(
          mine.slice(0, mine.length - MAX_PENDING_INSERTIONS_PER_PROJECT).map((i) => i.seq)
        )
        queue = queue.filter((i) => !drop.has(i.seq))
      }
      return withQueue(queue)
    }),

  consume: (seq) =>
    set((state) => {
      const queue = liveQueue(state)
      return queue.some((i) => i.seq === seq)
        ? withQueue(queue.filter((i) => i.seq !== seq))
        : state
    }),

  clear: (projectId) =>
    set((state) =>
      withQueue(
        projectId === undefined ? [] : liveQueue(state).filter((i) => i.dataProjectId !== projectId)
      )
    )
}))

/**
 * Selector of the next insertion waiting for `projectId` (the same object until it is consumed),
 * or null: `useDataEditorBridge(selectPendingFor(project.id))`.
 */
export const selectPendingFor =
  (projectId: string) =>
  (state: Pick<DataEditorBridgeState, 'queue' | 'pending'>): DataEditorInsertion | null =>
    liveQueue(state).find((i) => i.dataProjectId === projectId) ?? null
