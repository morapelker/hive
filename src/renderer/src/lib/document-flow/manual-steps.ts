import {
  isConnectionRun,
  type DocumentRun,
  type DocumentRunLaunchConfig
} from '@shared/types/document-flow'
import { baseInstanceLabel, isBaseInstance } from '@/lib/connection-project'
import { launchSessionOnConnection, launchSessionWithModel } from '@/lib/ticket-launch'
import { useSessionStore } from '@/stores/useSessionStore'
import { discardSession } from './migrations'

// Executing the manual steps of a finished run: one agent session, started from the report in
// the run dashboard with a prompt the user may edit. Unlike the migrations the run does not
// track it: it is an ordinary session in the checkout the user picked, and only its launch
// lives here.

/** The run's own branch, or the project's checkout without a worktree (main, most of the time). */
export type ManualStepsTargetKind = 'integration' | 'no-worktree'

export type ManualStepsCheckout =
  | { kind: 'worktree'; worktreeId: string }
  | { kind: 'connection'; connectionId: string; path: string | null }

export interface ManualStepsTarget {
  kind: ManualStepsTargetKind
  /** The branch the session would run on. */
  branch: string
  /** Null exactly when `refusal` is set. */
  checkout: ManualStepsCheckout | null
  /** Why this target cannot be picked, in words; null when it can. */
  refusal: string | null
}

type TargetRun = Pick<
  DocumentRun,
  | 'project_id'
  | 'base_branch'
  | 'integration_branch'
  | 'integration_worktree_id'
  | 'integration_connection_id'
  | 'integration_connection_path'
  | 'members'
>

type TargetWorktree = { id: string; is_default: boolean; branch_name: string }
type TargetConnection = {
  id: string
  status: string
  path: string
  saved_project_id?: string | null
  is_base?: number
  members?: ReadonlyArray<{ worktree_branch?: string | null }>
}

function integrationTarget(
  run: TargetRun,
  worktrees: readonly TargetWorktree[] | undefined,
  connections: readonly TargetConnection[] | undefined
): ManualStepsTarget {
  const branch = run.integration_branch ?? 'the integration branch'
  const refused = (refusal: string): ManualStepsTarget => ({
    kind: 'integration',
    branch,
    checkout: null,
    refusal
  })
  if (isConnectionRun(run)) {
    const connectionId = run.integration_connection_id
    if (!connectionId) return refused('The run has no integration instance to run in.')
    const instance = connections?.find((c) => c.id === connectionId)
    if (connections && instance?.status !== 'active') {
      return refused(`The instance of ${branch} was archived or deleted.`)
    }
    return {
      kind: 'integration',
      branch,
      checkout: {
        kind: 'connection',
        connectionId,
        path: run.integration_connection_path ?? instance?.path ?? null
      },
      refusal: null
    }
  }
  const worktreeId = run.integration_worktree_id
  if (!worktreeId) return refused('The run has no integration worktree to run in.')
  if (worktrees && !worktrees.some((worktree) => worktree.id === worktreeId)) {
    return refused(`The worktree of ${branch} was archived.`)
  }
  return { kind: 'integration', branch, checkout: { kind: 'worktree', worktreeId }, refusal: null }
}

function noWorktreeTarget(
  run: TargetRun,
  worktrees: readonly TargetWorktree[] | undefined,
  connections: readonly TargetConnection[] | undefined
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
      checkout: { kind: 'connection', connectionId: base.id, path: base.path },
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
  run: TargetRun,
  worktrees: readonly TargetWorktree[] | undefined,
  connections: readonly TargetConnection[] | undefined
): ManualStepsTarget[] {
  return [
    integrationTarget(run, worktrees, connections),
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

/** Sessions this page started for manual steps; forgotten when the page reloads. */
const launched = new Set<string>()

/**
 * Whether `sessionId` was started by this page to execute manual steps. Marked as the session
 * is created: the agent's first prompt is only reported back once it is already running.
 */
export function isManualStepsSession(sessionId: string): boolean {
  return launched.has(sessionId)
}

/**
 * Start the session. Resolves with its id, and rejects with a message for the user when it could
 * not be started, leaving nothing behind: the user is still in the dialog and may launch again.
 */
export async function launchManualStepsSession(
  target: ManualStepsTarget & { checkout: ManualStepsCheckout },
  projectId: string,
  prompt: string,
  modelConfig: DocumentRunLaunchConfig
): Promise<string> {
  const onSessionCreated = async ({ session }: { session: { id: string } }): Promise<void> => {
    launched.add(session.id)
    await useSessionStore
      .getState()
      .updateSessionName(session.id, `Manual steps — ${target.branch}`)
  }
  const base = {
    prompt,
    mode: 'build' as const,
    modelConfig,
    goalMode: false,
    goalSuccessCriteria: null,
    onSessionCreated
  }
  const { checkout } = target
  const result =
    checkout.kind === 'connection'
      ? await launchSessionOnConnection({
          ...base,
          connectionId: checkout.connectionId,
          connectionPath: checkout.path
        })
      : await launchSessionWithModel({
          ...base,
          projectId,
          worktreeId: checkout.worktreeId,
          // A ticket that merely waits on this worktree must not be handed the session.
          skipKanbanAttach: true
        })
  if (result.success && result.sessionId) return result.sessionId
  if (result.sessionId) {
    launched.delete(result.sessionId)
    await discardSession(result.sessionId)
  }
  throw new Error(result.error ?? 'The session could not be started.')
}

/** A session the dialog started, and the checkout it runs in. */
export interface LaunchedManualSteps {
  sessionId: string
  checkout: ManualStepsCheckout
}

export function resetManualStepsStateForTests(): void {
  launched.clear()
}
