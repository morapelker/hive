// "Move projects" as this window runs it: ask the server what would move (a plan, read-only),
// show it in one dialog, and on the person's click ask for the projects one at a time. The
// server does the moving; this module asks, records each answer for the dialog and reloads
// what the window holds about a project right after it moved.
//
// The flow lives here, not in a component: the dialog is opened from Settings and has to
// outlive it. Whatever closes Settings while a run is going must not take the dialog along: a
// run that lost its dialog could neither be stopped nor say what it did. Its state for the
// dialog is in lib/dev-folder/store; the dialog is mounted once in AppLayout.
//
// One dialog at a time, one run at a time, one project at a time. An answer that arrives
// after the dialog was closed (or closed and opened again) is dropped.

import { settingsApi } from '@/api/settings-api'
import {
  isDevFolderMovePlan,
  isDevFolderMoveResult,
  type DevFolderMoveCandidate,
  type DevFolderMovePlan,
  type DevFolderMoveResult
} from '@shared/types/dev-folder'
import { refreshAfterDevFolderRun, refreshAfterProjectMove } from './refresh'
import {
  CLOSED_DEV_FOLDER_MOVE,
  isMovableCandidate,
  rowsOfDevFolderPlan,
  selectedDevFolderRows,
  useDevFolderMoveStore,
  type DevFolderMoveRow,
  type DevFolderMoveState
} from './store'

/** Names the dialog that is open: closing it, or opening the next one, moves it on. */
let openDialog = 0

const current = (): DevFolderMoveState => useDevFolderMoveStore.getState()
const patch = (change: Partial<DevFolderMoveState>): void => useDevFolderMoveStore.setState(change)

const patchRow = (projectId: string, change: Partial<DevFolderMoveRow>): void =>
  useDevFolderMoveStore.setState((state) => ({
    rows: state.rows.map((row) =>
      row.candidate.projectId === projectId ? { ...row, ...change } : row
    )
  }))

/** What went wrong, worded to sit inside a sentence: no full stop at the end. */
const reasonOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return text.trim().replace(/[.\s]+$/, '')
}

const nameOf = (candidate: DevFolderMoveCandidate): string =>
  candidate.projectName || candidate.fromPath

const counted = (count: number): string => (count === 1 ? '1 project' : `${count} projects`)

type PlanAnswer = { plan: DevFolderMovePlan } | { error: string }

// Never rejects: a plan that cannot be had is a sentence for the dialog.
const readPlan = async (): Promise<PlanAnswer> => {
  try {
    const answer: unknown = await settingsApi.planDevFolderMove()
    if (isDevFolderMovePlan(answer)) return { plan: answer }
    return { error: 'The projects could not be checked: the answer could not be read.' }
  } catch (error) {
    const reason = reasonOf(error)
    return {
      error: reason
        ? `The projects could not be checked: ${reason}.`
        : 'The projects could not be checked.'
    }
  }
}

// The dialog after a plan was asked for. Without a plan the list on screen stays as it is,
// under the sentence that says why there is no new one; the first plan has no list to keep.
const showPlan = (answer: PlanAnswer, unticked: ReadonlySet<string>): void => {
  if ('plan' in answer) {
    patch({
      phase: 'confirm',
      plan: answer.plan,
      rows: rowsOfDevFolderPlan(answer.plan, unticked),
      rechecking: false,
      cancelRequested: false,
      error: null
    })
    return
  }
  patch({
    ...(current().phase === 'planning' ? { phase: 'confirm' as const } : {}),
    rechecking: false,
    error: answer.error
  })
}

/** Open the dialog and ask for the plan. Does nothing while the dialog is open. */
export const openDevFolderMove = async (): Promise<void> => {
  if (current().phase !== 'closed') return
  const dialog = ++openDialog
  patch({ ...CLOSED_DEV_FOLDER_MOVE, phase: 'planning' })
  const answer = await readPlan()
  if (dialog !== openDialog || current().phase !== 'planning') return
  showPlan(answer, new Set())
}

/**
 * "Check again": a new plan in the dialog that is open, before a run or after one. The list
 * on screen stays until the new one arrives. Before a run, what the person unticked stays
 * unticked; after a run the list starts over with what is still to be moved.
 */
export const recheckDevFolderMove = async (): Promise<void> => {
  const before = current()
  if ((before.phase !== 'confirm' && before.phase !== 'summary') || before.rechecking) return
  const dialog = openDialog
  const unticked = new Set(
    before.phase === 'confirm'
      ? before.rows
          .filter((row) => isMovableCandidate(row.candidate) && !row.selected)
          .map((row) => row.candidate.projectId)
      : []
  )
  patch({ rechecking: true })
  const answer = await readPlan()
  if (dialog !== openDialog || !current().rechecking) return
  // The move that got no answer may have ended since the run stopped. The project is
  // remembered until the dialog closes: the server may still be at it now.
  const stoppedAt = current().stoppedAt
  if (stoppedAt) {
    await refreshUnanswered(stoppedAt)
    if (dialog !== openDialog || !current().rechecking) return
  }
  showPlan(answer, unticked)
}

/** Tick or untick a project in the list. Only before a run, and only one that can move. */
export const toggleDevFolderMoveRow = (projectId: string): void => {
  const state = current()
  if (state.phase !== 'confirm' || state.rechecking) return
  patch({
    rows: state.rows.map((row) =>
      row.candidate.projectId === projectId && isMovableCandidate(row.candidate)
        ? { ...row, selected: !row.selected }
        : row
    )
  })
}

// A call that was refused by the transport, or answered something that is not a result, says
// nothing about the project: the server may have moved it, or may still be moving it. The
// row gets a result of its own so the dialog has a sentence to show, and so the window can
// reload the project's rows (nothing in `movedPaths`: where it is now is not known).
const unansweredMove = (
  candidate: DevFolderMoveCandidate,
  reason: string
): DevFolderMoveResult => ({
  projectId: candidate.projectId,
  projectName: candidate.projectName,
  action: 'failed',
  fromPath: candidate.fromPath,
  toPath: candidate.toPath,
  skipReason: null,
  detail: `Hive did not get an answer for this move${reason ? ` (${reason})` : ''}. The project may have been moved anyway: check again before moving it.`,
  warnings: [],
  movedPaths: []
})

// The run stopped at this project without knowing what became of it, and the server tells
// this window nothing more: it leaves out the window that asked. The rows of the project are
// read again; when they show it in another folder, the window follows it there. Never rejects.
const refreshUnanswered = async (candidate: DevFolderMoveCandidate): Promise<void> => {
  try {
    await refreshAfterProjectMove(unansweredMove(candidate, ''))
  } catch {
    // It never rejects; if it did, there is nothing more to do about it here.
  }
}

/**
 * Moves the projects in turn. Answers the project whose move got no answer, where the run
 * stops (the ones after it are not started), or null when every move answered or the person
 * cancelled the rest.
 */
const moveInTurn = async (
  queue: readonly DevFolderMoveCandidate[]
): Promise<DevFolderMoveCandidate | null> => {
  for (const candidate of queue) {
    // "Cancel remaining" is read here only: the project being moved always finishes.
    if (current().cancelRequested) return null
    patchRow(candidate.projectId, { status: 'running', result: null })

    let answer: unknown = null
    let unanswered: string | null = null
    try {
      answer = await settingsApi.moveProjectToDevFolder({
        projectId: candidate.projectId,
        expectedToPath: candidate.toPath
      })
      // An answer about another project is no answer about this one.
      if (!isDevFolderMoveResult(answer) || answer.projectId !== candidate.projectId) {
        unanswered = 'the answer could not be read'
      }
    } catch (error) {
      unanswered = reasonOf(error)
    }

    if (unanswered !== null) {
      const result = unansweredMove(candidate, unanswered)
      patchRow(candidate.projectId, { status: 'failed', result })
      await refreshAfterProjectMove(result)
      return candidate
    }

    const result = answer as DevFolderMoveResult
    patchRow(candidate.projectId, { status: result.action, result })
    // Before the next project starts: a move can take minutes, and until this ran the window
    // still watches and prompts in the folder the project left.
    if (result.action === 'moved') await refreshAfterProjectMove(result, { inRun: true })
  }
  return null
}

// What the dialog says above the list when a move got no answer. The plan made right after
// it says how much is left; without one the sentence sends the person to "Check again".
const stoppedSentence = (stoppedAt: DevFolderMoveCandidate, fresh: PlanAnswer): string => {
  const stopped = `The run stopped at "${nameOf(stoppedAt)}": Hive did not get an answer for its move, and the projects after it were not started.`
  if (!('plan' in fresh)) return `${stopped} Check again to see what is left.`
  const left = fresh.plan.candidates.filter(isMovableCandidate).length
  return left === 0
    ? `${stopped} Nothing is left that can be moved.`
    : `${stopped} ${counted(left)} can still be moved: check again to see ${left === 1 ? 'it' : 'them'}.`
}

/**
 * Move the ticked projects, one at a time. Returns at once when a run is going, when a new
 * plan is on its way, and when nothing is ticked. Never rejects, and always leaves the
 * running phase: the dialog cannot be closed while it is in it.
 */
export const startDevFolderMove = async (): Promise<void> => {
  const state = current()
  if (state.phase !== 'confirm' || state.rechecking) return
  const queue = selectedDevFolderRows(state.rows).map((row) => row.candidate)
  if (queue.length === 0) return
  patch({ phase: 'running', cancelRequested: false, error: null })

  let stoppedAt: DevFolderMoveCandidate | null = null
  let broke: string | null = null
  try {
    stoppedAt = await moveInTurn(queue)
  } catch (error) {
    // Every call above is guarded; this is for a fault in this module, which must not leave
    // the dialog locked in its running phase.
    broke = `The run stopped: ${reasonOf(error) || 'something went wrong in this window'}. Check again to see what is left.`
  } finally {
    try {
      await refreshAfterDevFolderRun()
    } catch {
      // It never rejects; if it did, the run is over all the same.
    }
  }

  if (stoppedAt === null) {
    patch({ phase: 'summary', cancelRequested: false, error: broke })
    return
  }
  // The list on screen no longer says where that project is. The run's own account stays in
  // the dialog (what moved, with its warnings, and what did not); the new plan says what is
  // left, and "Check again" shows it.
  const fresh = await readPlan()
  patch({
    phase: 'summary',
    cancelRequested: false,
    error: stoppedSentence(stoppedAt, fresh),
    stoppedAt,
    ...('plan' in fresh ? { plan: fresh.plan } : {})
  })
}

/** "Cancel remaining": no other project is started. The one being moved is not interrupted. */
export const cancelRemainingDevFolderMove = (): void => {
  if (current().phase === 'running') patch({ cancelRequested: true })
}

/**
 * Close the dialog. Does nothing while projects are being moved. After a run that stopped at
 * a move without an answer, what the window holds about that project is read once more.
 */
export const closeDevFolderMove = (): void => {
  const { phase, stoppedAt } = current()
  if (phase === 'running' || phase === 'closed') return
  openDialog++
  patch({ ...CLOSED_DEV_FOLDER_MOVE })
  if (stoppedAt) void refreshUnanswered(stoppedAt)
}
