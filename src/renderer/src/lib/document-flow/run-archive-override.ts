// ⌘⇧-dragging the ticket of a document run (the orchestrator) to Done/Merged is the override
// of its shift-drop (run-done-queue.ts): the run's ticket and its children move, and every
// branch the run opened is offered to the archive step as it is. No pull, no branch is checked
// for uncommitted changes or unmerged commits, nothing is committed or merged — the
// merge-on-done dialog opens straight on archive/keep with "Archive all" for the whole run.
//
// What is skipped is git, not ownership: a ticket whose session is still working, one another
// run holds by now, and one that never started stay where they are and are named, exactly as
// the shift-drop leaves them (moving a ticket to Done closes its session).
import { documentFlowApi } from '@/api/document-flow-api'
import { documentRunTicketDropRefusal } from '@/components/document-flow/document-flow-ui'
import { archivableWorktree, connectionArchiveTargets } from '@/lib/archive-override'
import {
  itemLabel,
  moveTicketsAlong,
  RunQueueDraft,
  selectedItems,
  type RunDoneQueue,
  type RunDoneQueueOutcome
} from '@/lib/document-flow/run-done-queue'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import {
  useKanbanStore,
  type PendingDoneMoveMember,
  type PendingDoneMoveWorktree
} from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { documentRunIdOf } from '@shared/document-flow/run-ticket'
import {
  isConnectionRun,
  type DocumentRun,
  type DocumentRunDetail,
  type DocumentRunMember
} from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'

/** The columns the override drops on: where the shift-drop of a run's ticket goes too. */
export const RUN_ARCHIVE_OVERRIDE_COLUMNS = ['done', 'merged'] as const

export type RunArchiveOverrideColumn = (typeof RUN_ARCHIVE_OVERRIDE_COLUMNS)[number]

export const isRunArchiveOverrideColumn = (column: string | null): column is RunArchiveOverrideColumn =>
  column === 'done' || column === 'merged'

/**
 * The columns the override would act on for a ticket sitting in `from`: not its own, and not
 * the Done list for a Merged card folded into it (the same no-op a plain drag gets there).
 */
export function runArchiveOverrideTargets(from: string): RunArchiveOverrideColumn[] {
  const folded = !useSettingsStore.getState().showMergedColumn
  return RUN_ARCHIVE_OVERRIDE_COLUMNS.filter(
    (column) => column !== from && !(column === 'done' && from === 'merged' && folded)
  )
}

/**
 * Every branch of `detail` as an archive entry, unchecked: the integration checkout first (the
 * run's own ticket was dragged), then one entry per ticket branch. Only the database is read —
 * a worktree that is gone, on its way out, or a project's default one is left out, and the
 * ticket it belonged to moves along. `tickets` are the board's rows of the run's project.
 */
export async function buildRunArchiveOverrideQueue(
  detail: DocumentRunDetail,
  runTicketId: string,
  tickets: readonly KanbanTicket[]
): Promise<RunDoneQueue> {
  const { run } = detail
  const draft = new RunQueueDraft(run, runTicketId, tickets)
  if (isConnectionRun(run)) return buildConnectionRunArchiveOverrideQueue(detail, run, draft)

  const integrationId = run.integration_worktree_id
  const seenWorktrees = new Set<string>(integrationId ? [integrationId] : [])

  for (const item of selectedItems(detail)) {
    const label = itemLabel(item.key, item.title)
    const worktreeId =
      item.worktree_id && item.worktree_id !== integrationId ? item.worktree_id : null
    if (draft.settleItemWithoutBranch(item, label, !!worktreeId)) continue
    if (!worktreeId) continue

    const ticketId = draft.moveable(item.ticket_id) ? item.ticket_id : undefined
    const worktree = seenWorktrees.has(worktreeId) ? null : await archivableWorktree(worktreeId)
    seenWorktrees.add(worktreeId)
    if (!worktree) {
      // Nothing of its own left to archive: the ticket just follows the run
      if (ticketId) draft.alsoMoveTicketIds.push(ticketId)
      continue
    }
    draft.archiveEntries.push({
      worktreeId: worktree.id,
      projectId: worktree.project_id,
      kind: 'run-child-archive',
      label,
      ...(ticketId ? { ticketId } : {})
    })
  }

  let integrationEntries: PendingDoneMoveWorktree[] = []
  if (integrationId) {
    const integration = await archivableWorktree(integrationId)
    if (integration) {
      integrationEntries = [
        {
          worktreeId: integration.id,
          projectId: integration.project_id,
          kind: 'run-integration',
          label: run.title
        }
      ]
    }
  } else if (run.integration_connection_id) {
    // A connection run whose members were never recorded: its tickets' instances are unknown,
    // but the integration instance itself can still be listed from the connection
    integrationEntries = (await connectionArchiveTargets(run.integration_connection_id)).map(
      (target) => ({
        ...target,
        kind: 'run-integration' as const,
        label: run.title,
        connectionId: run.integration_connection_id as string
      })
    )
  }
  return draft.finish(integrationEntries)
}

/**
 * The same over a connection project: a ticket is one entry standing for its whole instance
 * (every member worktree still there), the integration instance one entry per member.
 */
async function buildConnectionRunArchiveOverrideQueue(
  detail: DocumentRunDetail,
  run: DocumentRun & { members: DocumentRunMember[] },
  draft: RunQueueDraft
): Promise<RunDoneQueue> {
  const memberByProject = new Map(run.members.map((m) => [m.project_id, m]))
  const seenWorktrees = new Set<string>(run.members.map((m) => m.integration_worktree_id))

  for (const item of selectedItems(detail)) {
    const label = itemLabel(item.key, item.title)
    const owns = (item.members ?? []).filter(
      (own) => memberByProject.has(own.project_id) && !seenWorktrees.has(own.worktree_id)
    )
    if (draft.settleItemWithoutBranch(item, label, owns.length > 0)) continue
    for (const own of owns) seenWorktrees.add(own.worktree_id)

    const ticketId = draft.moveable(item.ticket_id) ? item.ticket_id : undefined
    const members: PendingDoneMoveMember[] = []
    for (const own of owns) {
      const member = memberByProject.get(own.project_id) as DocumentRunMember
      const worktree = await archivableWorktree(own.worktree_id)
      if (!worktree) continue
      members.push({
        worktreeId: worktree.id,
        projectId: worktree.project_id,
        projectName: member.project_name,
        branchName: worktree.branch_name,
        worktreePath: worktree.path
      })
    }
    if (members.length === 0) {
      if (ticketId) draft.alsoMoveTicketIds.push(ticketId)
      continue
    }
    draft.archiveEntries.push({
      worktreeId: members[0].worktreeId,
      projectId: members[0].projectId,
      kind: 'run-child-archive',
      label,
      itemId: item.id,
      members,
      ...(item.connection_id ? { connectionId: item.connection_id } : {}),
      ...(ticketId ? { ticketId } : {})
    })
  }

  const integrationEntries: PendingDoneMoveWorktree[] = []
  for (const member of run.members) {
    const worktree = await archivableWorktree(member.integration_worktree_id)
    if (!worktree) continue
    integrationEntries.push({
      worktreeId: worktree.id,
      projectId: worktree.project_id,
      kind: 'run-integration',
      label: `${run.title} · ${member.project_name}`,
      ...(run.integration_connection_id ? { connectionId: run.integration_connection_id } : {})
    })
  }
  return draft.finish(integrationEntries)
}

/**
 * Done/Merged for the whole run, unchecked. `queued`: the dialog has the move, open on the
 * archive step. `nothing`: no worktree is left to archive — the run's worktree-less children
 * were moved along and the caller moves the run's ticket. Rejects when the run or a worktree
 * cannot be looked up.
 */
export async function queueRunArchiveOverride(args: {
  runId: string
  ticketId: string
  projectId: string
  targetColumn: RunArchiveOverrideColumn
  sortOrder: number
}): Promise<RunDoneQueueOutcome> {
  const detail = await documentFlowApi.get(args.runId)
  if (!detail) return 'nothing'
  useDocumentFlowStore.getState().applyDetail(detail)

  const store = useKanbanStore.getState()
  const queue = await buildRunArchiveOverrideQueue(
    detail,
    args.ticketId,
    store.tickets.get(args.projectId) ?? []
  )

  if (queue.entries.length === 0) {
    if (queue.kept.length > 0) {
      toast.warning(`Kept: ${queue.kept.map((k) => `${k.label} (${k.reason})`).join(', ')}`)
    }
    await moveTicketsAlong(args.projectId, args.targetColumn, queue.alsoMoveTicketIds)
    return 'nothing'
  }

  const [first, ...rest] = queue.entries
  store.setPendingDoneMove({
    ticketId: args.ticketId,
    projectId: args.projectId,
    sortOrder: args.sortOrder,
    targetColumn: args.targetColumn,
    worktreeId: first.worktreeId,
    worktreeProjectId: first.projectId,
    remainingWorktrees: rest,
    offerArchive: true,
    skipMergeChecks: true,
    entry: first,
    run: {
      runId: detail.run.id,
      title: detail.run.title,
      kept: queue.kept,
      alsoMoveTicketIds: queue.alsoMoveTicketIds
    }
  })
  return 'queued'
}

/**
 * The drop of the override gesture: `ticket` is a run's, released on `column`. Refused with the
 * sentence a plain drop gets while the run is not over; otherwise the archive step opens for
 * the whole run, or — with no worktree left — the ticket simply moves.
 */
export async function dropRunTicketArchiveOverride(
  ticket: KanbanTicket,
  column: RunArchiveOverrideColumn
): Promise<void> {
  const runId = documentRunIdOf(ticket)
  if (!runId || !runArchiveOverrideTargets(ticket.column).includes(column)) return

  try {
    // No run when its record is gone; then only its ticket is left to move
    const run =
      useDocumentFlowStore.getState().runsById[runId]?.run ??
      (await documentFlowApi.get(runId))?.run
    const refusal = documentRunTicketDropRefusal(
      run?.status ?? null,
      column,
      Boolean(run?.migration_session_id),
      run
    )
    if (refusal) {
      toast.warning(refusal)
      return
    }

    const store = useKanbanStore.getState()
    // Done and Merged are sorted by when a ticket got there: the top is where it lands
    const sortOrder = store.computeSortOrder(
      store.getTicketsByColumn(ticket.project_id, column),
      0
    )
    const outcome = await queueRunArchiveOverride({
      runId,
      ticketId: ticket.id,
      projectId: ticket.project_id,
      targetColumn: column,
      sortOrder
    })
    if (outcome === 'queued') return
    await store.moveTicket(ticket.id, ticket.project_id, column, sortOrder, { interactive: true })
  } catch (err) {
    toast.warning(
      `Could not look up the branches of the run: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
