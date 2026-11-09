import {
  isConnectionRun,
  type DocumentRun,
  type DocumentRunLaunchConfig
} from '@shared/types/document-flow'
import { baseInstanceLabel, isBaseInstance } from '@/lib/connection-project'
import { useKanbanStore } from '@/stores/useKanbanStore'
import {
  launchTicketOnCheckout,
  runBranchTarget,
  type RunBranchTarget,
  type RunCheckout,
  type RunCheckoutConnection,
  type RunCheckoutRun,
  type RunCheckoutWorktree
} from './run-checkout'
import { runTitle } from './ticket-run-membership'

// Executing the manual steps of a finished run: one agent session, started from the report in
// the run dashboard with a prompt the user may edit. It is an ordinary ticket of the run's
// project, on the board like any other so its session can be followed there, in the checkout
// the user picked; only its launch lives here.

/** The run's own branch, or the project's checkout without a worktree (main, most of the time). */
export type ManualStepsTargetKind = 'integration' | 'no-worktree'

export interface ManualStepsTarget extends RunBranchTarget {
  kind: ManualStepsTargetKind
}

function noWorktreeTarget(
  run: RunCheckoutRun,
  worktrees: readonly RunCheckoutWorktree[] | undefined,
  connections: readonly RunCheckoutConnection[] | undefined
): ManualStepsTarget {
  const refused = (refusal: string): ManualStepsTarget => ({
    kind: 'no-worktree',
    branch: run.base_branch ?? 'main',
    checkout: null,
    refusal
  })
  if (isConnectionRun(run)) {
    if (!connections) return refused('Loading the project’s instances…')
    // A connection project's twin of a default worktree: its members' default worktrees.
    const base = connections.find(
      (c) => c.saved_project_id === run.project_id && isBaseInstance(c) && c.status === 'active'
    )
    if (!base) return refused('This project has no base instance to run in.')
    return {
      kind: 'no-worktree',
      branch: baseInstanceLabel(base.members),
      checkout: { kind: 'connection', connectionId: base.id },
      refusal: null
    }
  }
  if (!worktrees) return refused('Loading the project’s worktrees…')
  const root = worktrees.find((worktree) => worktree.is_default)
  if (!root) return refused('This project has no checkout outside a worktree.')
  return {
    kind: 'no-worktree',
    branch: root.branch_name,
    checkout: { kind: 'worktree', worktreeId: root.id },
    refusal: null
  }
}

/**
 * Where the manual steps of `run` can be executed, the run's own branch first. Lists that have
 * not loaded yet (undefined) refuse nothing about the integration checkout, whose id the run
 * carries; the no-worktree target has to be looked up in them, so it waits.
 */
export function manualStepsTargets(
  run: RunCheckoutRun,
  worktrees: readonly RunCheckoutWorktree[] | undefined,
  connections: readonly RunCheckoutConnection[] | undefined
): ManualStepsTarget[] {
  return [
    { kind: 'integration', ...runBranchTarget(run, worktrees, connections) },
    noWorktreeTarget(run, worktrees, connections)
  ]
}

/** The run's branch when it can still be run on, else the no-worktree path, as a merged run has. */
export function defaultManualStepsTarget(
  targets: readonly ManualStepsTarget[]
): ManualStepsTargetKind {
  return targets.find((target) => target.kind === 'integration')?.refusal === null
    ? 'integration'
    : 'no-worktree'
}

/**
 * Open the session's ticket on the board of the run's project and start it. Resolves with the
 * session's id, and rejects with a message for the user when it could not be started, leaving
 * nothing behind: the user is still in the dialog and may launch again.
 */
export async function launchManualStepsSession(
  target: ManualStepsTarget & { checkout: RunCheckout },
  run: Pick<DocumentRun, 'project_id' | 'title' | 'source_kind'>,
  prompt: string,
  modelConfig: DocumentRunLaunchConfig
): Promise<string> {
  const store = useKanbanStore.getState()
  const ticket = await store.createTicket(run.project_id, {
    project_id: run.project_id,
    title: `Manual steps — ${runTitle(run)}`,
    description: prompt,
    column: 'todo'
  })
  try {
    return await launchTicketOnCheckout(ticket, target.checkout, { prompt, modelConfig })
  } catch (cause) {
    await store.deleteTicket(ticket.id, run.project_id).catch(() => undefined)
    throw cause
  }
}

/** A session the dialog started, and the checkout it runs in. */
export interface LaunchedManualSteps {
  sessionId: string
  checkout: RunCheckout
}
