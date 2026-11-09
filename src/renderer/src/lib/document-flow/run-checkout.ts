import {
  isConnectionRun,
  type DocumentRun,
  type DocumentRunLaunchConfig
} from '@shared/types/document-flow'
import { launchTicketWithModel } from '@/lib/ticket-launch'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../../../main/db/types'
import { discardSession } from './migrations'
import { resetTicketToTodo } from './runner-ports'

// Starting a board ticket in a checkout a run already has, from the run's dashboard: an ordinary
// ticket on the board of the run's project (a connection project's when the run is one), whose
// session runs on the run's branch instead of the project's default launch target.

export type RunCheckout =
  | { kind: 'worktree'; worktreeId: string }
  | { kind: 'connection'; connectionId: string }

export interface RunBranchTarget {
  /** The branch the session would run on. */
  branch: string
  /** Null exactly when `refusal` is set. */
  checkout: RunCheckout | null
  /** Why it cannot be run on, in words; null when it can. */
  refusal: string | null
}

export type RunCheckoutRun = Pick<
  DocumentRun,
  | 'project_id'
  | 'base_branch'
  | 'integration_branch'
  | 'integration_worktree_id'
  | 'integration_connection_id'
  | 'members'
>

export type RunCheckoutWorktree = { id: string; is_default: boolean; branch_name: string }
export type RunCheckoutConnection = {
  id: string
  status: string
  saved_project_id?: string | null
  is_base?: number
  members?: ReadonlyArray<{ worktree_branch?: string | null }>
}

/**
 * The run's own branch and the checkout it is in. Lists that have not loaded yet (undefined)
 * refuse nothing: the run carries the checkout's id, and only a list can say it is gone.
 */
export function runBranchTarget(
  run: RunCheckoutRun,
  worktrees: readonly RunCheckoutWorktree[] | undefined,
  connections: readonly RunCheckoutConnection[] | undefined
): RunBranchTarget {
  const branch = run.integration_branch ?? 'the integration branch'
  const refused = (refusal: string): RunBranchTarget => ({ branch, checkout: null, refusal })
  if (isConnectionRun(run)) {
    const connectionId = run.integration_connection_id
    if (!connectionId) return refused('The run has no integration instance to run in.')
    const instance = connections?.find((c) => c.id === connectionId)
    if (connections && instance?.status !== 'active') {
      return refused(`The instance of ${branch} was archived or deleted.`)
    }
    return { branch, checkout: { kind: 'connection', connectionId }, refusal: null }
  }
  const worktreeId = run.integration_worktree_id
  if (!worktreeId) return refused('The run has no integration worktree to run in.')
  if (worktrees && !worktrees.some((worktree) => worktree.id === worktreeId)) {
    return refused(`The worktree of ${branch} was archived.`)
  }
  return { branch, checkout: { kind: 'worktree', worktreeId }, refusal: null }
}

export interface RunCheckoutLaunch {
  prompt: string
  modelConfig: DocumentRunLaunchConfig
}

/**
 * Start `ticket` in `checkout`: it moves In Progress, linked to its session before the agent
 * starts. Resolves with the session's id. A launch that fails leaves no session behind and the
 * ticket back in To Do, and rejects with a message for the user.
 */
export async function launchTicketOnCheckout(
  ticket: Pick<KanbanTicket, 'id' | 'project_id' | 'title'>,
  checkout: RunCheckout,
  { prompt, modelConfig }: RunCheckoutLaunch
): Promise<string> {
  const store = useKanbanStore.getState()
  const result = await launchTicketWithModel({
    ticketId: ticket.id,
    projectId: ticket.project_id,
    ticketTitle: ticket.title,
    worktree:
      checkout.kind === 'connection'
        ? { type: 'existing-connection', connectionId: checkout.connectionId }
        : { type: 'existing', worktreeId: checkout.worktreeId },
    prompt,
    mode: 'build',
    modelConfig,
    goalMode: false,
    goalSuccessCriteria: null,
    keepInstanceName: true,
    ticketUpdateExtras: {
      column: 'in_progress',
      sort_order: store.computeSortOrder(
        store.getTicketsByColumn(ticket.project_id, 'in_progress'),
        0
      ),
      plan_ready: false,
      pending_launch_config: null
    }
  })
  if (result.success && result.sessionId) return result.sessionId
  if (result.sessionId) await discardSession(result.sessionId)
  await resetTicketToTodo(ticket.project_id, ticket.id).catch(() => undefined)
  throw new Error(result.error ?? 'The session could not be started.')
}
