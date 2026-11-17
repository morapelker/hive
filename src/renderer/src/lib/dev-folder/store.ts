// What the "Move projects" dialog shows (components/settings/dev-folder/DevFolderMoveDialog,
// mounted once in AppLayout). This store only holds the state of the one dialog that can be
// open; lib/dev-folder/move-projects drives it. It is kept outside Settings on purpose: a run
// goes on when the Settings modal is closed, and the dialog has to outlive it to say what
// moved and what did not.

import { create } from 'zustand'
import type {
  DevFolderMoveCandidate,
  DevFolderMovePlan,
  DevFolderMoveResult
} from '@shared/types/dev-folder'

/**
 * `closed`: no dialog. `planning`: asking the server what "Move projects" would do. `confirm`:
 * the list is on screen and nothing has been moved. `running`: projects are being moved, one
 * at a time. `summary`: the run is over and the list says how each project ended.
 */
export type DevFolderMovePhase = 'closed' | 'planning' | 'confirm' | 'running' | 'summary'

/**
 * How a project stands in the dialog. `pending`: not moved (yet): waiting for its turn, left
 * out by the person, or never reached by a run that stopped. `running`: its move was asked
 * for and has not answered. `moved`, `skipped`, `failed`: how its move ended. A project the
 * plan already said cannot be moved is `skipped` from the start, with no `result`.
 */
export type DevFolderMoveRowStatus = 'pending' | 'running' | 'moved' | 'skipped' | 'failed'

export interface DevFolderMoveRow {
  candidate: DevFolderMoveCandidate
  /** Ticked: the next run moves it. Always false for a project the plan says cannot be moved. */
  selected: boolean
  status: DevFolderMoveRowStatus
  /** What its move answered; null while it has not been asked for or has not answered. */
  result: DevFolderMoveResult | null
}

export interface DevFolderMoveState {
  phase: DevFolderMovePhase
  /**
   * The newest plan; null until the first one arrived. The rows are made from it, except
   * after a run that stopped at a move without an answer: the rows then still tell that run,
   * and the plan is the one made right after it.
   */
  plan: DevFolderMovePlan | null
  /** One row per project of the plan, in the plan's order. */
  rows: DevFolderMoveRow[]
  /** "Check again" is waiting for a new plan; the list on screen stays until it arrives. */
  rechecking: boolean
  /** "Cancel remaining" was pressed: the project being moved finishes, no other one starts. */
  cancelRequested: boolean
  /** Why there is no list, or why the run stopped early; null otherwise. */
  error: string | null
  /**
   * The project whose move got no answer, where a run of this dialog stopped; null otherwise.
   * The server may have moved it after the window stopped waiting, so what the window holds
   * about it is read again on every "Check again" and when the dialog closes.
   */
  stoppedAt: DevFolderMoveCandidate | null
}

export const CLOSED_DEV_FOLDER_MOVE: DevFolderMoveState = {
  phase: 'closed',
  plan: null,
  rows: [],
  rechecking: false,
  cancelRequested: false,
  error: null,
  stoppedAt: null
}

/** A project the plan lets through, as opposed to one it lists only to say why it stays. */
export const isMovableCandidate = (candidate: DevFolderMoveCandidate): boolean =>
  candidate.skipReason === null || candidate.skipReason === undefined

/**
 * The rows of a plan. Every project that can be moved starts ticked, except those the person
 * unticked in the list this plan replaces (`unticked`: their project ids).
 */
export const rowsOfDevFolderPlan = (
  plan: DevFolderMovePlan,
  unticked: ReadonlySet<string> = new Set()
): DevFolderMoveRow[] =>
  plan.candidates.map((candidate) => {
    const movable = isMovableCandidate(candidate)
    return {
      candidate,
      selected: movable && !unticked.has(candidate.projectId),
      status: movable ? 'pending' : 'skipped',
      result: null
    }
  })

/** The rows a run moves: ticked, and not ruled out by the plan. */
export const selectedDevFolderRows = (rows: readonly DevFolderMoveRow[]): DevFolderMoveRow[] =>
  rows.filter((row) => row.selected && isMovableCandidate(row.candidate))

export const useDevFolderMoveStore = create<DevFolderMoveState>()(() => ({
  ...CLOSED_DEV_FOLDER_MOVE
}))
