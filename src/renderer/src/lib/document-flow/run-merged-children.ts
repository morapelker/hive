// Right-clicking the ticket of a run (a document run, or an orchestrator) offers "Move merged
// tickets to Done…": the run's tickets that are finished with (merged into the run's
// integration branch, conflicts resolved, the document updated) move to Done and their
// worktrees are archived. It is the tail of the shift-drop batch (run-done-queue.ts) without
// its head: nothing is merged, the run's own ticket stays where it is, and the integration
// branch is neither merged into the base branch nor archived. So it also works in the middle
// of a run, to free the worktrees of what has landed already while the rest goes on.
//
// What is safe to archive is decided against the integration branch, the branch that survives
// here: a ticket branch may go once it holds nothing that branch lacks. Once the integration
// checkout is gone (the run's ticket was merged and archived), the base branch stands in, as
// it does for the batch. Anything that cannot be shown to be safe is kept, and named.
import { dbApi } from '@/api/db-api'
import { documentFlowApi } from '@/api/document-flow-api'
import { pullBaseBranches } from '@/lib/base-branch-pull'
import { closeInstanceSessions, trackConnectionArchives } from '@/lib/connection-archive'
import {
  RunQueueDraft,
  classifyBranch,
  isSessionLive,
  itemLabel,
  selectedItems,
  type BranchVerdict,
  type RunWorktree
} from '@/lib/document-flow/run-done-queue'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { isDocumentUpdatePending } from '@shared/document-flow/planning'
import { isActiveRunStatus } from '@shared/document-flow/run-ticket'
import {
  isConnectionRun,
  type DocumentRun,
  type DocumentRunDetail,
  type DocumentRunItem,
  type DocumentRunMember
} from '@shared/types/document-flow'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'

/** The columns as a sentence names them. */
const KANBAN_COLUMN_LABELS: Record<KanbanTicketColumn, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  merged: 'Merged',
  done: 'Done'
}

/** The run whose merged tickets are moved: the run, and its own ticket on the board. */
export interface MergedChildrenTarget {
  runId: string
  /** The run's own ticket: never moved here. */
  ticketId: string
  projectId: string
}

/** One worktree that can be archived: clean, with nothing `compareBranch` lacks. */
export interface MergedChildWorktree {
  worktreeId: string
  worktreePath: string
  branch: string
  /** Root of the repository the worktree is removed from. */
  projectPath: string
  /** The branch its work was found on: the integration branch, or base once that is gone. */
  compareBranch: string
  /** Connection project: the member repository it belongs to. */
  projectName?: string
}

/** A merged ticket of the run that is finished with. */
export interface MergedChild {
  itemId: string
  /** `A3 · title`. */
  label: string
  /** The tickets to move to Done: the item's own and its fix ticket; none once they are there. */
  ticketIds: string[]
  /**
   * The worktrees to archive: the ticket's one worktree, on a connection project every member
   * worktree of its instance (all or none). Empty when there is none left, or it must stay.
   */
  worktrees: MergedChildWorktree[]
  /** Connection project: the ticket's instance, which goes with its last worktree. */
  connectionId?: string
  /** Why the worktree stays although its ticket moves; null when it goes or none is left. */
  worktreeKept: string | null
}

/** A merged ticket that is not finished with: left as it is, and named. */
export interface MergedChildHeld {
  itemId: string
  label: string
  reason: string
}

export interface MergedChildrenPlan {
  children: MergedChild[]
  held: MergedChildHeld[]
}

/** Whether the run has merged anything: what the menu item is offered for. */
export function hasMergedRunItems(detail: Pick<DocumentRunDetail, 'items'> | undefined): boolean {
  return !!detail?.items.some((item) => item.selected && item.status === 'merged')
}

type WorktreeOutcome =
  /** Clean, and on the branch that survives: these can go. */
  | { kind: 'archive'; worktrees: MergedChildWorktree[] }
  /** No worktree left (archived already), or the item never had one. */
  | { kind: 'none' }
  /** The worktree stays; its ticket moves all the same. */
  | { kind: 'kept'; reason: string }
  /** Something is still to be done on the branch: the ticket stays with it. */
  | { kind: 'hold'; reason: string }

/**
 * Why a branch cannot go, or null when it can. Work the surviving branch lacks and unresolved
 * conflicts mean the ticket is not finished with (`holds`); stray uncommitted files and a
 * branch git could not read only keep the worktree.
 */
function refusalOf(
  verdict: BranchVerdict,
  compareBranch: string,
  where = ''
): { holds: boolean; reason: string } | null {
  switch (verdict.kind) {
    case 'clean':
      return null
    case 'work':
      return { holds: true, reason: `it has commits${where} that are not on ${compareBranch}` }
    case 'markers':
      return { holds: true, reason: `it has unresolved conflict markers${where}` }
    case 'leftovers':
      return { holds: false, reason: `it has uncommitted changes${where}` }
    case 'unverifiable':
      return { holds: false, reason: `it could not be checked${where}: ${verdict.error}` }
  }
}

type Assess = (item: DocumentRunItem, claimed: ReadonlySet<string>) => Promise<WorktreeOutcome>

/** The worktree of each ticket of a run on a git project, against the integration branch. */
async function worktreeAssessor(run: DocumentRun): Promise<Assess> {
  const [integration, project] = await Promise.all([
    run.integration_worktree_id
      ? dbApi.worktree.get<RunWorktree>(run.integration_worktree_id)
      : Promise.resolve(null),
    dbApi.project.get<{ path: string }>(run.project_id)
  ])
  const integrationBranch =
    integration?.status === 'active' && run.integration_branch ? run.integration_branch : null
  let defaultBranch: Promise<string | null> | undefined
  const projectDefaultBranch = (): Promise<string | null> => {
    defaultBranch ??= dbApi.worktree
      .getActiveByProject<RunWorktree>(run.project_id)
      .then((active) => active.find((w) => w.is_default)?.branch_name ?? null)
    return defaultBranch
  }

  return async (item, claimed) => {
    if (!item.worktree_id || !claimed.has(item.worktree_id)) return { kind: 'none' }
    const worktree = await dbApi.worktree.get<RunWorktree>(item.worktree_id)
    if (!worktree || worktree.status !== 'active') return { kind: 'none' }

    let compareBranch = integrationBranch
    if (!compareBranch) {
      // Nothing to have merged into any more: the branch can only go once it is on base
      compareBranch = worktree.base_branch ?? (await projectDefaultBranch())
      if (!compareBranch) return { kind: 'kept', reason: 'there is no branch to check it against' }
      await pullBaseBranches([
        { projectId: worktree.project_id, worktreePath: worktree.path, branch: compareBranch }
      ])
    }
    const verdict = await classifyBranch({
      path: worktree.path,
      branch: worktree.branch_name,
      compareBranch,
      landed: true,
      checkMarkers: true
    })
    const refusal = refusalOf(verdict, compareBranch)
    if (refusal) return { kind: refusal.holds ? 'hold' : 'kept', reason: refusal.reason }
    return {
      kind: 'archive',
      worktrees: [
        {
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          branch: worktree.branch_name,
          projectPath: project?.path ?? worktree.path,
          compareBranch
        }
      ]
    }
  }
}

/**
 * The connection-project shape: a ticket's instance is checked member by member against that
 * member's integration branch, and goes whole or not at all.
 */
async function instanceAssessor(
  run: DocumentRun & { members: DocumentRunMember[] }
): Promise<Assess> {
  const memberByProject = new Map(run.members.map((m) => [m.project_id, m]))
  const integrationActive = new Map<string, boolean>()
  await Promise.all(
    run.members.map(async (member) => {
      const worktree = await dbApi.worktree.get<RunWorktree>(member.integration_worktree_id)
      integrationActive.set(member.project_id, worktree?.status === 'active')
    })
  )

  return async (item, claimed) => {
    const owns = (item.members ?? []).filter(
      (own) => memberByProject.has(own.project_id) && claimed.has(own.worktree_id)
    )
    if (owns.length === 0) return { kind: 'none' }
    const rows = await Promise.all(
      owns.map(async (own) => ({
        member: memberByProject.get(own.project_id) as DocumentRunMember,
        worktree: await dbApi.worktree.get<RunWorktree>(own.worktree_id)
      }))
    )
    const isGone = (row: (typeof rows)[number]): boolean =>
      !row.worktree || row.worktree.status !== 'active'
    const gone = rows.filter(isGone)
    if (gone.length === rows.length) return { kind: 'none' }
    if (gone.length > 0) {
      const where = gone.map((row) => row.member.project_name).join(', ')
      return { kind: 'kept', reason: `its worktree in ${where} is gone, so the rest is left as it is` }
    }

    const checked = await Promise.all(
      rows.map(async ({ member, worktree }) => {
        const present = worktree as RunWorktree
        const active = integrationActive.get(member.project_id) === true
        const compareBranch = active
          ? member.integration_branch
          : (present.base_branch ?? member.base_branch)
        if (!active) {
          await pullBaseBranches([
            {
              projectId: member.project_id,
              projectName: member.project_name,
              worktreePath: present.path,
              branch: compareBranch
            }
          ])
        }
        const verdict = await classifyBranch({
          path: present.path,
          branch: present.branch_name,
          compareBranch,
          landed: true,
          checkMarkers: true
        })
        return { member, worktree: present, compareBranch, verdict }
      })
    )
    // The instance is a unit: one member that cannot go keeps them all
    const refusals = checked.flatMap((c) => {
      const refusal = refusalOf(c.verdict, c.compareBranch, ` in ${c.member.project_name}`)
      return refusal ? [refusal] : []
    })
    const refusal = refusals.find((r) => r.holds) ?? refusals[0]
    if (refusal) return { kind: refusal.holds ? 'hold' : 'kept', reason: refusal.reason }
    return {
      kind: 'archive',
      worktrees: checked.map(({ member, worktree, compareBranch }) => ({
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        branch: worktree.branch_name,
        projectPath: member.project_path,
        compareBranch,
        projectName: member.project_name
      }))
    }
  }
}

/**
 * The tickets a merged item moves to Done, or why the item is not finished with: its session
 * still has the document to update, an agent is at work on it, the ticket is someone else's
 * by now, or it was taken out of Merged by hand.
 */
function settleTickets(
  draft: RunQueueDraft,
  run: Pick<DocumentRun, 'status'>,
  item: DocumentRunItem
): { held: string } | { ticketIds: string[] } {
  // The run has one more prompt for the ticket's session, which lives in its worktree
  if (isActiveRunStatus(run.status) && isDocumentUpdatePending(item)) {
    return {
      held:
        item.document_update_status === 'updating'
          ? 'its session is updating the document'
          : 'its session is still to update the document'
    }
  }
  if ([item.session_id, item.fix_session_id].some(isSessionLive)) {
    return { held: 'its session is still working' }
  }
  const takenElsewhere = draft.ticketTakenElsewhere(item)
  if (takenElsewhere) return { held: takenElsewhere }

  const ticketIds: string[] = []
  const ticket = draft.moveable(item.ticket_id) ? draft.byId.get(item.ticket_id) : undefined
  if (ticket?.column === 'merged') {
    ticketIds.push(ticket.id)
  } else if (ticket && ticket.column !== 'done') {
    return { held: `its ticket is back in ${KANBAN_COLUMN_LABELS[ticket.column]}` }
  }
  // A fix ticket ran in the integration checkout, and is over once its item is merged
  const fix = draft.moveable(item.fix_ticket_id) ? draft.byId.get(item.fix_ticket_id) : undefined
  if (fix && fix.column !== 'done' && fix.column !== 'todo') ticketIds.push(fix.id)
  return { ticketIds }
}

/**
 * Which merged tickets of `detail` are finished with, what moving them to Done takes along,
 * and which are held back. `tickets` are the board's rows of the run's project. Never rejects
 * for a branch git cannot read: that branch is kept, and said so.
 */
export async function buildMergedChildrenPlan(
  detail: DocumentRunDetail,
  runTicketId: string,
  tickets: readonly KanbanTicket[]
): Promise<MergedChildrenPlan> {
  const { run } = detail
  const draft = new RunQueueDraft(run, runTicketId, tickets)
  const assess = isConnectionRun(run) ? await instanceAssessor(run) : await worktreeAssessor(run)

  // A worktree is one item's to archive: the first that names it, never the integration one
  const taken = new Set<string>(
    isConnectionRun(run)
      ? run.members.map((m) => m.integration_worktree_id)
      : run.integration_worktree_id
        ? [run.integration_worktree_id]
        : []
  )
  const merged = selectedItems(detail)
    .filter((item) => item.status === 'merged')
    .map((item) => {
      const named = item.members?.length
        ? item.members.map((m) => m.worktree_id)
        : item.worktree_id
          ? [item.worktree_id]
          : []
      const claimed = new Set(named.filter((id) => !taken.has(id)))
      for (const id of claimed) taken.add(id)
      return { item, claimed, label: itemLabel(item.key, item.title) }
    })

  const settled = await Promise.all(
    merged.map(async ({ item, claimed, label }) => {
      const moves = settleTickets(draft, run, item)
      if ('held' in moves) return { item, label, held: moves.held }
      return { item, label, ticketIds: moves.ticketIds, outcome: await assess(item, claimed) }
    })
  )

  const plan: MergedChildrenPlan = { children: [], held: [] }
  for (const entry of settled) {
    const { item, label } = entry
    if (entry.held !== undefined) {
      plan.held.push({ itemId: item.id, label, reason: entry.held })
      continue
    }
    const { ticketIds, outcome } = entry
    if (outcome.kind === 'hold') {
      plan.held.push({ itemId: item.id, label, reason: outcome.reason })
      continue
    }
    const worktrees = outcome.kind === 'archive' ? outcome.worktrees : []
    const worktreeKept = outcome.kind === 'kept' ? outcome.reason : null
    if (ticketIds.length === 0 && worktrees.length === 0) {
      // In Done already with nothing left to archive: only a worktree that stays is worth a word
      if (worktreeKept) {
        plan.held.push({ itemId: item.id, label, reason: `its worktree stays: ${worktreeKept}` })
      }
      continue
    }
    plan.children.push({
      itemId: item.id,
      label,
      ticketIds,
      worktrees,
      worktreeKept,
      ...(item.connection_id && worktrees.length > 0 ? { connectionId: item.connection_id } : {})
    })
  }
  return plan
}

/** The plan for the run as it is now (its record is re-read first); null when the run is gone. */
export async function loadMergedChildrenPlan(
  target: MergedChildrenTarget
): Promise<MergedChildrenPlan | null> {
  const detail = await documentFlowApi.get(target.runId)
  if (!detail) return null
  useDocumentFlowStore.getState().applyDetail(detail)
  const tickets = useKanbanStore.getState().tickets.get(target.projectId) ?? []
  return buildMergedChildrenPlan(detail, target.ticketId, tickets)
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Move a merged item's tickets to Done, each to the top of the column with the completion
 * effects off, like every ticket a run moves: the work is on the integration branch, not on
 * base, so nothing that waits on it outside the run may start yet. True when all of them moved.
 */
async function moveTicketsToDone(
  projectId: string,
  ticketIds: readonly string[],
  onMoved: () => void
): Promise<boolean> {
  let allMoved = true
  for (const ticketId of ticketIds) {
    const state = useKanbanStore.getState()
    const ticket = state.tickets.get(projectId)?.find((t) => t.id === ticketId)
    if (!ticket || ticket.archived_at || ticket.column === 'done') continue
    const sortOrder = state.computeSortOrder(state.getTicketsByColumn(projectId, 'done'), 0)
    try {
      await state.moveTicket(ticketId, projectId, 'done', sortOrder, { skipCompletionEffects: true })
      onMoved()
    } catch (err) {
      allMoved = false
      toast.error(`Could not move ${ticket.title}: ${errorText(err)}`)
    }
  }
  return allMoved
}

/** Nothing was written to the worktree, or committed past the surviving branch, since the check. */
async function isStillClean(worktree: MergedChildWorktree): Promise<boolean> {
  try {
    const verdict = await classifyBranch({
      path: worktree.worktreePath,
      branch: worktree.branch,
      compareBranch: worktree.compareBranch,
      landed: true,
      checkMarkers: false
    })
    return verdict.kind === 'clean'
  } catch {
    return false
  }
}

/**
 * Archive the worktrees of `children` (the worktree is removed and its branch deleted), one
 * ticket beside the other; the worktrees of a connection instance go one after the other, as
 * the last one removed deletes the instance. Says what came of it.
 */
async function archiveChildWorktrees(children: readonly MergedChild[]): Promise<void> {
  const store = useWorktreeStore.getState()
  // A connection that goes away with these worktrees reads "Archiving x/y" in the sidebar
  const progress = trackConnectionArchives(
    children.flatMap((child) => child.worktrees.map((w) => w.worktreeId))
  )
  const kept: string[] = []
  const failed: string[] = []
  let archived = 0
  try {
    await Promise.all(
      children.map(async (child) => {
        // Last look right before the destructive step: an agent may have written since
        const clean = await Promise.all(child.worktrees.map(isStillClean))
        if (clean.includes(false)) {
          kept.push(child.label)
          progress.release(child.worktrees.map((w) => w.worktreeId))
          return
        }
        await closeInstanceSessions(child.connectionId)
        for (const worktree of child.worktrees) {
          try {
            const result = await store.archiveWorktree(
              worktree.worktreeId,
              worktree.worktreePath,
              worktree.branch,
              worktree.projectPath
            )
            if (result.success) archived += 1
            else failed.push(`${worktree.branch}: ${result.error ?? 'unknown error'}`)
          } catch (err) {
            failed.push(`${worktree.branch}: ${errorText(err)}`)
          }
          progress.settled(worktree.worktreeId)
        }
      })
    )
  } finally {
    progress.end()
  }
  if (kept.length > 0) {
    toast.warning(
      `${kept.join(', ')} ${kept.length === 1 ? 'has' : 'have'} new changes — not archived`
    )
  }
  if (archived > 0) toast.success(`${plural(archived, 'worktree')} archived`)
  for (const failure of failed) toast.error(`Failed to archive ${failure}`)
}

export interface MergedChildrenMoveResult {
  /** Tickets that went to Done. */
  moved: number
  /** Chosen tickets that were not finished with any more when it came to it. */
  skipped: MergedChildHeld[]
  /** Worktrees handed to the archive. */
  archiving: number
  /** Settles once the archive is over; it runs on after this resolves. */
  archive: Promise<void>
}

/**
 * Move the chosen merged tickets of the run to Done and, with `archiveWorktrees`, archive
 * their worktrees. `chosen` is what the dialog showed, which may be minutes old: the run is
 * assessed again here, and only what is still finished with goes. The run's own ticket and
 * its integration branch are never touched. Resolves once the tickets moved; the archive goes
 * on in the background.
 */
export async function moveMergedChildrenToDone(
  target: MergedChildrenTarget,
  chosen: readonly Pick<MergedChild, 'itemId' | 'label'>[],
  options: { archiveWorktrees: boolean }
): Promise<MergedChildrenMoveResult> {
  const plan = await loadMergedChildrenPlan(target)
  if (!plan) throw new Error('The run no longer exists.')
  const ready = new Map(plan.children.map((child) => [child.itemId, child]))
  const held = new Map(plan.held.map((entry) => [entry.itemId, entry]))

  const skipped: MergedChildHeld[] = []
  const toArchive: MergedChild[] = []
  let moved = 0
  for (const { itemId, label } of chosen) {
    const child = ready.get(itemId)
    if (!child) {
      // Held by now, or settled meanwhile (moved by hand, archived): only the first is news
      const entry = held.get(itemId)
      if (entry) skipped.push({ itemId, label, reason: entry.reason })
      continue
    }
    const allMoved = await moveTicketsToDone(target.projectId, child.ticketIds, () => {
      moved += 1
    })
    // A ticket that would not move keeps its worktree: the two go together
    if (allMoved && options.archiveWorktrees && child.worktrees.length > 0) toArchive.push(child)
  }

  if (skipped.length > 0) {
    toast.warning(
      `Left as ${skipped.length === 1 ? 'it is' : 'they are'}: ${skipped.map((s) => `${s.label} (${s.reason})`).join(', ')}`
    )
  }
  if (moved > 0) toast.success(`${plural(moved, 'ticket')} moved to Done`)

  const archiving = toArchive.reduce((count, child) => count + child.worktrees.length, 0)
  const archive =
    toArchive.length > 0
      ? archiveChildWorktrees(toArchive).catch((err) => {
          toast.error(`Archive failed: ${errorText(err)}`)
        })
      : Promise.resolve()
  return { moved, skipped, archiving, archive }
}
