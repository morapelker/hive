import { buildQuestionModeNotice, isQuestionModeNotice } from '@shared/document-flow/prompts'
import { isAgentCli } from '@shared/types/agent-sdk'
import type { DocumentRunItem, DocumentRunItemStatus } from '@shared/types/document-flow'
import { documentFlowApi } from '@/api/document-flow-api'
import { terminalApi } from '@/api/terminal-api'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { findSessionById } from '@/lib/session-followup'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { getSessionSignal } from './session-signal'

// Flipping "agents may ask me questions" on a run that is already under way. The setting is
// saved first, so every prompt the runner sends from then on follows it; this module then
// tells the sessions that are mid-task, which were briefed under the old setting.
//
// A session is only ever told through its queue, never prompted directly: a prompt sent to a
// busy claude-code session aborts its turn, and codex drops it. A session at rest is left
// alone: the next prompt the runner sends it carries the setting in its footer. A ticket that
// is being launched during the flip has no session yet; the runner tells it once it has.

/** Item statuses in which an agent of the run may be mid-task. */
const TOLD_STATUSES: readonly DocumentRunItemStatus[] = [
  'launching',
  'running',
  'needs_input',
  'checking',
  'resolving_conflicts',
  'fixing'
]

export interface QuestionModeTarget {
  itemId: string
  key: string
  sessionId: string
}

/**
 * How one session was told: `queued` behind its turn, `waiting` in the queue of a session
 * that first needs the user's answer, or `sent` by typing it into its CLI.
 */
export type QuestionModeDelivery = 'queued' | 'waiting' | 'sent' | 'skipped'

export interface QuestionModeResult {
  /** Working sessions that got the message (queued behind the turn, or typed into the CLI). */
  told: number
  /** Sessions blocked on a question or permission: the message is queued behind the answer. */
  waiting: number
  /** Sessions at rest, closed, or a CLI waiting on a dialog: not messaged. */
  skipped: number
  failed: number
}

/** The sessions of a run to tell: the fix session while fixing, else the ticket's own. */
export function questionModeTargets(items: readonly DocumentRunItem[]): QuestionModeTarget[] {
  const seen = new Set<string>()
  const targets: QuestionModeTarget[] = []
  for (const item of items) {
    if (!item.selected || !TOLD_STATUSES.includes(item.status)) continue
    const sessionId = item.status === 'fixing' ? item.fix_session_id : item.session_id
    if (!sessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    targets.push({ itemId: item.id, key: item.key, sessionId })
  }
  return targets
}

/**
 * Tell one session. `justLaunched` is the runner's case of a session whose launch prompt was
 * built before the flip: its first turn is starting, whatever its signal says yet.
 */
export async function tellQuestionMode(
  sessionId: string,
  interactive: boolean,
  options: { justLaunched?: boolean } = {}
): Promise<QuestionModeDelivery> {
  const found = await findSessionById(sessionId)
  if (!found) return 'skipped'
  const sdk = found.session.agent_sdk
  const text = buildQuestionModeNotice({ interactive, sdk })
  // Read after the await, with nothing async before the enqueue: the turn cannot end between.
  const signal = getSessionSignal(sessionId)

  if (isAgentCli(sdk)) {
    // The CLI queues what is typed while it works. Anything else is not safe to type into:
    // an open question or permission dialog would take the text as its answer, and an idle
    // CLI would start a turn the run did not ask for.
    if (signal.kind !== 'working') return 'skipped'
    const { delivered } = unwrapEnvelope(await terminalApi.sendClaudeCliPrompt(sessionId, text))
    return delivered ? 'sent' : 'skipped'
  }

  const sessions = useSessionStore.getState()
  // A notice of an earlier flip that is still queued is out of date, also for a session that
  // gets no new one: it would otherwise be told the old setting at its next turn end.
  const queued = sessions.pendingFollowUpMessages.get(sessionId) ?? []
  if (queued.some(isQuestionModeNotice)) {
    sessions.setPendingFollowUpMessages(
      sessionId,
      queued.filter((message) => !isQuestionModeNotice(message))
    )
  }
  // The queue drains when the turn ends, and waits while the session is blocked on the user.
  const busy = signal.kind === 'working' || signal.kind === 'blocked'
  if (!busy && !options.justLaunched) return 'skipped'
  sessions.enqueueFollowUpMessage(sessionId, text)
  return signal.kind === 'blocked' ? 'waiting' : 'queued'
}

function describeResult(interactive: boolean, result: QuestionModeResult): string {
  const lead = interactive ? 'Agents may ask questions again' : 'Agents told not to ask questions'
  const parts = [`${result.told} running session(s) told`]
  if (result.waiting > 0) parts.push(`${result.waiting} will hear it after your answer`)
  if (result.skipped > 0) parts.push(`${result.skipped} not messaged (at rest or waiting on you)`)
  if (result.failed > 0) parts.push(`${result.failed} failed`)
  return `${lead}: ${parts.join(', ')}`
}

/**
 * Save the setting on the run, then tell every session of it that is mid-task. Rejects only
 * when the save fails, in which case nothing was sent.
 */
export async function applyQuestionMode(
  runId: string,
  interactive: boolean
): Promise<QuestionModeResult> {
  const store = useDocumentFlowStore.getState()
  await store.updateRun(runId, { config: { interactive } })

  const items = useDocumentFlowStore.getState().runsById[runId]?.items ?? []
  const deliveries = await Promise.allSettled(
    questionModeTargets(items).map((target) => tellQuestionMode(target.sessionId, interactive))
  )
  const result: QuestionModeResult = { told: 0, waiting: 0, skipped: 0, failed: 0 }
  for (const delivery of deliveries) {
    if (delivery.status === 'rejected') result.failed += 1
    else if (delivery.value === 'skipped') result.skipped += 1
    else if (delivery.value === 'waiting') result.waiting += 1
    else result.told += 1
  }

  // The activity log is the record of what the user did to the run; a failed write is not
  // worth failing the toggle for.
  void documentFlowApi
    .logEvent({
      runId,
      type: interactive ? 'questions_on' : 'questions_off',
      message: describeResult(interactive, result),
      data: result
    })
    .catch(() => {})
  return result
}
