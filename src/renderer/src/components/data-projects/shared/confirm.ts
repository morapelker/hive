// The safety confirmation flow of every call that can run user SQL / Mongo writes:
// `dataProjects.query.execute`, `table.applyEdits`, `export.start`, the Mongo writes.
//
// The server decides (safe mode × statement class × environment) and answers
// `confirmation_required` with the plan and a single-use token instead of running anything.
// `runWithConfirmation(call)` shows that plan in the confirm dialog (DataConfirmHost, mounted
// once in DataProjectView) and re-sends the SAME request with the token when the user confirms.
// `blocked` answers show the blocked dialog and are returned as they are.
//
// Requests queue: two tabs asking at once get two dialogs, one after the other. A token that
// expired while the dialog was open (5 min TTL → DATA_CONFIRMATION_INVALID) re-asks once more
// with a fresh plan instead of failing.

import { create } from 'zustand'
import {
  DATA_ERROR_CODES,
  type DataExecutionPlan,
  type DataPlannedStatement
} from '@shared/data-projects/types'
import { dataErrorCode } from '@/components/data-projects/data-project-ui'
import { toast } from '@/lib/toast'

export type DataConfirmKind = 'confirm' | 'blocked'

export interface DataConfirmRequest {
  id: number
  kind: DataConfirmKind
  plan: DataExecutionPlan
  /** Blocked: why nothing ran. */
  reason?: string
  resolve: (confirmed: boolean) => void
}

interface DataConfirmState {
  queue: DataConfirmRequest[]
  /** Mounted DataConfirmHost instances (no host = nobody could answer: decline at once). */
  hosts: number
  request: (input: {
    kind: DataConfirmKind
    plan: DataExecutionPlan
    reason?: string
  }) => Promise<boolean>
  /** Answers the request `id` (the dialog's Run / Cancel / Close). */
  resolve: (id: number, confirmed: boolean) => void
  /** Declines everything pending (host unmounted, project closed). */
  cancelAll: () => void
  registerHost: () => () => void
}

let nextRequestId = 1

export const useDataConfirmStore = create<DataConfirmState>()((set, get) => ({
  queue: [],
  hosts: 0,

  request: ({ kind, plan, reason }) => {
    if (get().hosts === 0) {
      // Never hang a run on a dialog nobody renders.
      console.warn('[data-projects] confirmation requested without a DataConfirmHost; declining')
      return Promise.resolve(false)
    }
    // The dialog unmounts on resolve; put focus back where the run started (the editor or grid)
    // so ⌘. / ⌘↵ keep working without a click.
    const previous = typeof document !== 'undefined' ? document.activeElement : null
    return new Promise<boolean>((resolve) => {
      const id = nextRequestId++
      const done = (confirmed: boolean): void => {
        resolve(confirmed)
        restoreFocus(previous)
      }
      set((state) => ({ queue: [...state.queue, { id, kind, plan, reason, resolve: done }] }))
    })
  },

  resolve: (id, confirmed) => {
    const request = get().queue.find((r) => r.id === id)
    if (!request) return
    set((state) => ({ queue: state.queue.filter((r) => r.id !== id) }))
    request.resolve(confirmed)
  },

  cancelAll: () => {
    const pending = get().queue
    set({ queue: [] })
    for (const r of pending) r.resolve(false)
  },

  registerHost: () => {
    set((state) => ({ hosts: state.hosts + 1 }))
    return () => {
      const hosts = Math.max(0, get().hosts - 1)
      set({ hosts })
      if (hosts === 0) get().cancelAll()
    }
  }
}))

function restoreFocus(previous: Element | null): void {
  if (!(previous instanceof HTMLElement) || previous === document.body) return
  // The dialog unmounts after this resolve; wait until focus has left it (a few frames at most),
  // and never steal focus the user already moved elsewhere.
  const attempt = (tries: number): void => {
    if (!previous.isConnected) return
    const active = document.activeElement
    if (!active || active === document.body) previous.focus()
    else if (tries > 0 && active.closest('[role="alertdialog"]'))
      setTimeout(() => attempt(tries - 1), 16)
  }
  setTimeout(() => attempt(20), 0)
}

type ConfirmationRequired = {
  status: 'confirmation_required'
  plan: DataExecutionPlan
  confirmToken: string
}
type Blocked = { status: 'blocked'; plan: DataExecutionPlan; reason: string }

const isConfirmationRequired = (r: { status: string }): r is ConfirmationRequired =>
  r.status === 'confirmation_required'
const isBlocked = (r: { status: string }): r is Blocked => r.status === 'blocked'

/** The user declined the confirmation: nothing ran. */
export interface DeclinedResponse {
  status: 'declined'
}

const MAX_ROUNDS = 3

/**
 * Runs `call()`; when the server asks for confirmation, shows the plan and re-calls with the
 * token. Returns the final response, `{ status: 'declined' }` when the user cancelled, or the
 * `blocked` response after showing why.
 */
export async function runWithConfirmation<R extends { status: string }>(
  call: (confirmToken?: string) => Promise<R>
): Promise<R | DeclinedResponse> {
  let response = await call()
  for (let round = 0; round < MAX_ROUNDS && isConfirmationRequired(response); round++) {
    const required: ConfirmationRequired = response
    const confirmed = await useDataConfirmStore
      .getState()
      .request({ kind: 'confirm', plan: required.plan })
    if (!confirmed) return { status: 'declined' }
    try {
      response = await call(required.confirmToken)
    } catch (error) {
      if (
        dataErrorCode(error) !== DATA_ERROR_CODES.confirmationInvalid ||
        round === MAX_ROUNDS - 1
      ) {
        throw error
      }
      toast.warning('The confirmation expired. Please review and confirm again.')
      response = await call()
    }
  }
  if (isBlocked(response)) {
    await useDataConfirmStore
      .getState()
      .request({ kind: 'blocked', plan: response.plan, reason: response.reason })
  }
  return response
}

/** Statements in display order: dangerous first, then those needing confirmation, then by index. */
export function orderPlanStatements(statements: DataPlannedStatement[]): DataPlannedStatement[] {
  return [...statements].sort((a, b) => {
    const da = a.dangerous.length > 0 ? 0 : 1
    const db = b.dangerous.length > 0 ? 0 : 1
    if (da !== db) return da - db
    const ca = a.needsConfirmation ? 0 : 1
    const cb = b.needsConfirmation ? 0 : 1
    if (ca !== cb) return ca - cb
    return a.index - b.index
  })
}
