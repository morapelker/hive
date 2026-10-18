// Shift-dropping the ticket of a document run (the orchestrator) on Done/Merged finishes the
// whole run in one go: every ticket branch the run opened is checked, the ones with work the
// integration branch lacks are merged into it (the run's own merge path, one dialog step each),
// the integration branch is merged into the base branch like a plain drop of the run's ticket,
// and the archive step then offers to archive all of the run's branches at once and move their
// tickets along. This builds that queue for the merge-on-done dialog.
//
// What is safe to archive is decided against the branch that SURVIVES: a ticket branch may only
// go once its commits are on the integration branch (checked here, against the integration
// branch) AND the integration branch is on base (the integration entry comes before every
// archive entry, and the dialog re-checks each branch against base right before deleting it).
//
// A run on a connection project is the same flow over N member repositories: the integration
// "worktree" is an instance (one integration worktree per member) and every ticket ran in its
// own instance (one worktree per member). A ticket is then one entry standing for its whole
// instance — merged in one all-or-nothing call, archived all or none — and the integration
// instance is one entry per member, each merged into that member's base.
import { dbApi } from '@/api/db-api'
import { documentFlowApi } from '@/api/document-flow-api'
import { gitApi } from '@/api/git-api'
import { assessConnectionMembers } from '@/lib/connection-merge'
import { getSessionSignal } from '@/lib/document-flow/session-signal'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import {
  useKanbanStore,
  type PendingDoneMoveKept,
  type PendingDoneMoveMember,
  type PendingDoneMoveWorktree
} from '@/stores/useKanbanStore'
import { toast } from '@/lib/toast'
import {
  isConnectionRun,
  type DocumentRun,
  type DocumentRunDetail,
  type DocumentRunItem,
  type DocumentRunMember
} from '@shared/types/document-flow'
import type { KanbanTicket, KanbanTicketColumn, Worktree } from '../../../../main/db/types'

export interface RunDoneQueue {
  /** Merge entries (ticket branches with work), the integration entry, then archive entries. */
  entries: PendingDoneMoveWorktree[]
  /** Branches left out, named for the dialog's "Kept" line. */
  kept: PendingDoneMoveKept[]
  /** Children with no worktree of their own (fix tickets, say): moved with the run's ticket. */
  alsoMoveTicketIds: string[]
}

type RunWorktree = Pick<Worktree, 'id' | 'project_id' | 'branch_name' | 'path' | 'status' | 'base_branch'> & {
  is_default: boolean
}

const itemLabel = (key: string, title: string): string => `${key} · ${title}`

/** The run merged this branch itself: its work is on the branch that survives. */
const hasLanded = (item: Pick<DocumentRunItem, 'status' | 'merge_sha'>): boolean =>
  item.status === 'merged' || !!item.merge_sha

type BranchVerdict =
  /** Nothing to commit or merge: the branch can be archived. */
  | { kind: 'clean' }
  /** Commits the compared branch lacks (never landed, or added since): a merge step. */
  | { kind: 'work' }
  /** Landed, with only uncommitted leftovers: nothing to merge, nothing to archive. */
  | { kind: 'leftovers' }
  | { kind: 'markers' }
  /** Landed, and git could not tell: never a reason to refuse the drop. */
  | { kind: 'unverifiable'; error: string }

/**
 * One branch against the branch it should be on. Throws when git fails on a branch whose
 * work never landed: unchecked work must never be treated as clean.
 */
async function classifyBranch(args: {
  path: string
  branch: string
  compareBranch: string
  landed: boolean
  checkMarkers: boolean
}): Promise<BranchVerdict> {
  const [dirty, stat, statuses] = await Promise.all([
    gitApi.hasUncommittedChanges(args.path),
    gitApi.branchDiffShortStat(args.path, args.compareBranch),
    args.checkMarkers ? gitApi.getFileStatuses(args.path) : Promise.resolve(null)
  ])
  if (!stat.success) {
    const error = stat.error ?? 'could not verify merge status'
    if (args.landed) return { kind: 'unverifiable', error }
    throw new Error(`${args.branch}: ${error}`)
  }
  if (statuses?.files?.some((file) => file.status === 'C')) return { kind: 'markers' }
  if (!dirty && stat.commitsAhead === 0) return { kind: 'clean' }
  if (args.landed && stat.commitsAhead === 0) return { kind: 'leftovers' }
  return { kind: 'work' }
}

/** What the builders share: the board rows, and the lists they fill. */
class RunQueueDraft {
  readonly byId: Map<string, KanbanTicket>
  readonly mergeEntries: PendingDoneMoveWorktree[] = []
  readonly archiveEntries: PendingDoneMoveWorktree[] = []
  readonly kept: PendingDoneMoveKept[] = []
  readonly alsoMoveTicketIds: string[] = []
  readonly linkedTicketIds = new Set<string>()

  constructor(
    readonly runTicketId: string,
    readonly tickets: readonly KanbanTicket[]
  ) {
    this.byId = new Map(tickets.map((t) => [t.id, t]))
  }

  moveable(ticketId: string | null): ticketId is string {
    const ticket = ticketId ? this.byId.get(ticketId) : undefined
    return !!ticket && !ticket.archived_at && ticket.id !== this.runTicketId
  }

  /**
   * The parts of an item that need no branch: its tickets are noted, a fix ticket rides along
   * (it ran in the integration checkout), and a live session keeps the item. True when the
   * item is settled here.
   */
  settleItemWithoutBranch(item: DocumentRunItem, label: string, hasOwnBranch: boolean): boolean {
    if (item.ticket_id) this.linkedTicketIds.add(item.ticket_id)
    if (item.fix_ticket_id) this.linkedTicketIds.add(item.fix_ticket_id)
    if (this.moveable(item.fix_ticket_id)) this.alsoMoveTicketIds.push(item.fix_ticket_id)

    // An agent may still be writing on the branch (a cancelled run keeps its sessions)
    const live = [item.session_id, item.fix_session_id].some((sessionId) => {
      if (!sessionId) return false
      const kind = getSessionSignal(sessionId).kind
      return kind === 'working' || kind === 'blocked'
    })
    if (live) {
      this.kept.push({ label, reason: 'its session is still working — stop it first' })
      return true
    }
    if (!hasOwnBranch) {
      if (this.moveable(item.ticket_id)) {
        if (this.byId.get(item.ticket_id)?.column === 'todo') {
          this.kept.push({ label, reason: 'never started' })
        } else {
          this.alsoMoveTicketIds.push(item.ticket_id)
        }
      }
      return true
    }
    return false
  }

  /** The branch is gone: its ticket follows the run only if its work landed. */
  settleGoneBranch(item: DocumentRunItem, label: string, where: string): void {
    if (hasLanded(item)) {
      if (this.moveable(item.ticket_id)) this.alsoMoveTicketIds.push(item.ticket_id)
    } else {
      this.kept.push({ label, reason: `its worktree${where} is gone and its work never landed` })
    }
  }

  /** Landed work whose branch is left as it is: named, not archived; its ticket follows. */
  keepLanded(item: DocumentRunItem, label: string, reason: string): void {
    this.kept.push({ label, reason })
    if (this.moveable(item.ticket_id)) this.alsoMoveTicketIds.push(item.ticket_id)
  }

  /** Tickets the run opened that no item names any more (a superseded fix ticket, say). */
  addOrphanTickets(): void {
    for (const ticket of this.tickets) {
      if (
        ticket.parent_ticket_id !== this.runTicketId ||
        ticket.id === this.runTicketId ||
        this.linkedTicketIds.has(ticket.id) ||
        ticket.archived_at
      ) {
        continue
      }
      if (ticket.column === 'todo') {
        this.kept.push({ label: ticket.title, reason: 'never started' })
      } else {
        this.alsoMoveTicketIds.push(ticket.id)
      }
    }
  }

  finish(integrationEntries: PendingDoneMoveWorktree[]): RunDoneQueue {
    this.addOrphanTickets()
    return {
      entries: [...this.mergeEntries, ...integrationEntries, ...this.archiveEntries],
      kept: this.kept,
      alsoMoveTicketIds: [...new Set(this.alsoMoveTicketIds)]
    }
  }
}

const selectedItems = (detail: DocumentRunDetail): DocumentRunItem[] =>
  [...detail.items].filter((item) => item.selected).sort((a, b) => a.position - b.position)

/**
 * Classify every ticket branch of `detail` for the batch. Rejects when a branch cannot be
 * verified (git failure): unchecked work must never be treated as clean. `tickets` are the
 * board's rows of the run's project (archived rows, when loaded, are never moved).
 */
export async function buildRunDoneQueue(
  detail: DocumentRunDetail,
  runTicketId: string,
  tickets: readonly KanbanTicket[]
): Promise<RunDoneQueue> {
  const { run } = detail
  if (isConnectionRun(run)) return buildConnectionRunDoneQueue(detail, run, runTicketId, tickets)

  const projectId = run.project_id
  const integrationId = run.integration_worktree_id
  const integration = integrationId
    ? await dbApi.worktree.get<RunWorktree>(integrationId)
    : null
  const integrationBranch = run.integration_branch
  const integrationActive =
    !!integration && integration.status === 'active' && !!integrationBranch

  const draft = new RunQueueDraft(runTicketId, tickets)
  const seenWorktrees = new Set<string>(integrationId ? [integrationId] : [])
  let defaultBranch: string | null | undefined

  const projectDefaultBranch = async (): Promise<string | null> => {
    if (defaultBranch === undefined) {
      const active = await dbApi.worktree.getActiveByProject<RunWorktree>(projectId)
      defaultBranch = active.find((w) => w.is_default)?.branch_name ?? null
    }
    return defaultBranch
  }

  for (const item of selectedItems(detail)) {
    const label = itemLabel(item.key, item.title)
    const worktreeId = item.worktree_id && item.worktree_id !== integrationId ? item.worktree_id : null
    if (draft.settleItemWithoutBranch(item, label, !!worktreeId)) continue
    if (!worktreeId || seenWorktrees.has(worktreeId)) continue
    seenWorktrees.add(worktreeId)

    // The run merged this branch into the integration branch itself: its work is on the
    // branch that survives, so what is left in the worktree (an agent's stray files, a
    // fixup commit) is never force-committed and merged again by the batch
    const landed = hasLanded(item)
    const worktree = await dbApi.worktree.get<RunWorktree>(worktreeId)
    if (!worktree || worktree.status !== 'active') {
      draft.settleGoneBranch(item, label, '')
      continue
    }

    const ticketId = draft.moveable(item.ticket_id) ? item.ticket_id : undefined
    const archiveEntry: PendingDoneMoveWorktree = {
      worktreeId: worktree.id,
      projectId: worktree.project_id,
      alreadyMerged: true,
      kind: 'run-child-archive',
      label,
      ...(ticketId ? { ticketId } : {})
    }

    if (!integrationActive) {
      // Nothing to merge into any more: the branch can only go once it is on base
      const baseBranch = worktree.base_branch ?? (await projectDefaultBranch())
      if (!baseBranch) {
        draft.kept.push({ label, reason: 'no base branch to check it against' })
        continue
      }
      const verdict = await classifyBranch({
        path: worktree.path,
        branch: worktree.branch_name,
        compareBranch: baseBranch,
        landed,
        checkMarkers: false
      })
      if (verdict.kind === 'unverifiable') {
        draft.keepLanded(item, label, `could not be verified: ${verdict.error} — not archived`)
      } else if (verdict.kind === 'clean') {
        draft.archiveEntries.push(archiveEntry)
      } else if (verdict.kind === 'leftovers') {
        draft.keepLanded(item, label, 'has uncommitted changes since the run merged it — not archived')
      } else {
        draft.kept.push({ label, reason: 'the integration worktree is gone — merge it by hand' })
      }
      continue
    }

    const verdict = await classifyBranch({
      path: worktree.path,
      branch: worktree.branch_name,
      compareBranch: integrationBranch as string,
      landed,
      checkMarkers: true
    })
    if (verdict.kind === 'unverifiable') {
      draft.keepLanded(item, label, `could not be verified: ${verdict.error} — not archived`)
      continue
    }
    if (verdict.kind === 'markers') {
      if (landed) draft.keepLanded(item, label, 'has unresolved conflict markers — not archived')
      else draft.kept.push({ label, reason: 'has unresolved conflict markers' })
      continue
    }
    if (verdict.kind === 'clean') {
      draft.archiveEntries.push(archiveEntry)
      continue
    }
    if (verdict.kind === 'leftovers') {
      // Only uncommitted leftovers on a branch the run already merged: nothing to merge
      draft.keepLanded(item, label, 'has uncommitted changes since the run merged it — not archived')
      continue
    }
    // Commits the integration branch lacks (never landed, or added since): a merge step
    draft.mergeEntries.push({
      worktreeId: worktree.id,
      projectId: worktree.project_id,
      kind: 'run-child',
      label,
      runId: run.id,
      itemId: item.id,
      integrationBranch: integrationBranch as string,
      integrationWorktreeId: integrationId as string,
      ...(ticketId ? { ticketId } : {})
    })
    draft.archiveEntries.push(archiveEntry)
  }

  return draft.finish(
    integrationActive
      ? [
          {
            worktreeId: integration.id,
            projectId: integration.project_id,
            kind: 'run-integration' as const,
            label: run.title
          }
        ]
      : []
  )
}

/**
 * The connection-project shape of `buildRunDoneQueue`. A ticket's instance is checked member
 * by member against that member's integration branch (its base once the member integration
 * worktree is gone) and becomes ONE entry: clean everywhere → archive it all; commits some
 * member's integration branch lacks → merge it all through the run (one dialog step, every
 * member at once); anything in between keeps the whole instance. The integration instance
 * is one entry per member with its integration worktree, merged into that member's base.
 */
async function buildConnectionRunDoneQueue(
  detail: DocumentRunDetail,
  run: DocumentRun & { members: DocumentRunMember[] },
  runTicketId: string,
  tickets: readonly KanbanTicket[]
): Promise<RunDoneQueue> {
  const draft = new RunQueueDraft(runTicketId, tickets)
  const memberByProject = new Map(run.members.map((m) => [m.project_id, m]))

  // The integration instance: which member integration worktrees still exist, and which
  // members can be merged into their base here
  const assessment = run.integration_connection_id
    ? await assessConnectionMembers(run.integration_connection_id, { includeAlreadyMerged: true })
    : { targets: [], skipped: [], found: false }
  const integrationActive = new Map<string, boolean>()
  const skippedInactive = new Set(
    assessment.skipped.filter((s) => s.reason === 'inactive').map((s) => s.worktreeId)
  )
  for (const member of run.members) {
    // A worktree mid-archive still reads active in the DB; the assessment knows better
    const worktree =
      assessment.found && !skippedInactive.has(member.integration_worktree_id)
        ? await dbApi.worktree.get<RunWorktree>(member.integration_worktree_id)
        : null
    integrationActive.set(member.project_id, !!worktree && worktree.status === 'active')
  }
  // A member whose base branch has no worktree: its integration branch cannot reach base in
  // this batch, so nothing cut from it may be archived either
  const blockedMembers = new Map<string, string>()
  for (const skipped of assessment.skipped) {
    if (skipped.reason !== 'no-base-worktree') continue
    const member = memberByProject.get(skipped.projectId)
    if (!member) continue
    const reason = `no worktree on ${member.base_branch} to merge into`
    blockedMembers.set(member.project_id, reason)
    draft.kept.push({ label: `${run.title} · ${member.project_name}`, reason })
  }
  const seenWorktrees = new Set<string>(run.members.map((m) => m.integration_worktree_id))
  // Members some ticket merge will put commits on: their integration branch is not "already
  // merged" any more, whatever the assessment found at build time
  const landingOn = new Set<string>()

  for (const item of selectedItems(detail)) {
    const label = itemLabel(item.key, item.title)
    const owns = (item.members ?? []).filter(
      (own) => memberByProject.has(own.project_id) && !seenWorktrees.has(own.worktree_id)
    )
    if (draft.settleItemWithoutBranch(item, label, owns.length > 0)) continue
    for (const own of owns) seenWorktrees.add(own.worktree_id)

    const landed = hasLanded(item)
    const ticketId = draft.moveable(item.ticket_id) ? item.ticket_id : undefined

    // The instance is a unit: one member worktree gone settles the whole ticket
    const rows: { member: DocumentRunMember; worktree: RunWorktree }[] = []
    let gone: DocumentRunMember | null = null
    for (const own of owns) {
      const member = memberByProject.get(own.project_id) as DocumentRunMember
      const worktree = await dbApi.worktree.get<RunWorktree>(own.worktree_id)
      if (!worktree || worktree.status !== 'active') {
        gone = member
        break
      }
      rows.push({ member, worktree })
    }
    if (gone) {
      const goneId = gone.project_id
      const survivors = owns
        .map((own) => memberByProject.get(own.project_id) as DocumentRunMember)
        .filter((member) => member.project_id !== goneId)
        .map((member) => member.project_name)
      if (survivors.length === 0 || !hasLanded(item)) {
        draft.settleGoneBranch(item, label, ` in ${gone.project_name}`)
      } else {
        // Landed, with worktrees left in other members: nothing of it is archived here
        draft.keepLanded(
          item,
          label,
          `its worktree in ${gone.project_name} is gone — ${survivors.join(', ')} left as ${survivors.length === 1 ? 'it is' : 'they are'}`
        )
      }
      continue
    }

    const verdicts: { member: DocumentRunMember; verdict: BranchVerdict; active: boolean }[] = []
    for (const { member, worktree } of rows) {
      const active = integrationActive.get(member.project_id) === true
      verdicts.push({
        member,
        active,
        verdict: await classifyBranch({
          path: worktree.path,
          branch: worktree.branch_name,
          compareBranch: active
            ? member.integration_branch
            : (worktree.base_branch ?? member.base_branch),
          landed,
          checkMarkers: true
        })
      })
    }
    const names = (filter: (v: (typeof verdicts)[number]) => boolean): string =>
      verdicts.filter(filter).map((v) => v.member.project_name).join(', ')

    const unverifiable = verdicts.find((v) => v.verdict.kind === 'unverifiable')
    if (unverifiable) {
      const error = (unverifiable.verdict as { error: string }).error
      draft.keepLanded(
        item,
        label,
        `could not be verified in ${unverifiable.member.project_name}: ${error} — not archived`
      )
      continue
    }
    if (verdicts.some((v) => v.verdict.kind === 'markers')) {
      const where = names((v) => v.verdict.kind === 'markers')
      if (landed) draft.keepLanded(item, label, `has unresolved conflict markers in ${where} — not archived`)
      else draft.kept.push({ label, reason: `has unresolved conflict markers in ${where}` })
      continue
    }
    // A member whose integration branch cannot reach its base here: what was cut from it
    // (its commits are on that integration branch) is neither archived nor merged further
    const blocked = verdicts.find((v) => blockedMembers.has(v.member.project_id))
    if (blocked) {
      draft.kept.push({
        label,
        reason: `${blocked.member.project_name}: ${blockedMembers.get(blocked.member.project_id)}`
      })
      continue
    }
    const anyWork = verdicts.some((v) => v.verdict.kind === 'work')
    if (anyWork) {
      // The run's merge needs every member integration worktree
      const inactive = names((v) => !v.active)
      if (inactive) {
        draft.kept.push({ label, reason: `${inactive}: the integration worktree is gone — merge it by hand` })
        continue
      }
    }
    if (verdicts.some((v) => v.verdict.kind === 'leftovers')) {
      const where = names((v) => v.verdict.kind === 'leftovers')
      draft.keepLanded(
        item,
        label,
        `has uncommitted changes in ${where} since the run merged it — not archived`
      )
      continue
    }

    const anchor = rows[0]
    const members: PendingDoneMoveMember[] = rows.map(({ member, worktree }) => ({
      worktreeId: worktree.id,
      projectId: worktree.project_id,
      projectName: member.project_name,
      branchName: worktree.branch_name,
      worktreePath: worktree.path,
      integrationBranch: member.integration_branch,
      integrationWorktreeId: member.integration_worktree_id
    }))
    const instance = {
      worktreeId: anchor.worktree.id,
      projectId: anchor.worktree.project_id,
      label,
      itemId: item.id,
      members,
      ...(item.connection_id ? { connectionId: item.connection_id } : {}),
      ...(ticketId ? { ticketId } : {})
    }
    if (anyWork) {
      for (const v of verdicts) if (v.verdict.kind === 'work') landingOn.add(v.member.project_id)
      draft.mergeEntries.push({
        ...instance,
        kind: 'run-child',
        runId: run.id,
        integrationBranch: anchor.member.integration_branch,
        integrationWorktreeId: anchor.member.integration_worktree_id
      })
    }
    draft.archiveEntries.push({ ...instance, alreadyMerged: true, kind: 'run-child-archive' })
  }

  // The integration instance, one member at a time — members with work first, so the last
  // merge lands on an archive step where everything left is already merged
  const withWorkFirst = [...assessment.targets].sort(
    (a, b) => Number(!!a.alreadyMerged && !landingOn.has(a.projectId)) - Number(!!b.alreadyMerged && !landingOn.has(b.projectId))
  )
  const integrationEntries: PendingDoneMoveWorktree[] = withWorkFirst.map((target) => ({
    worktreeId: target.worktreeId,
    projectId: target.projectId,
    kind: 'run-integration' as const,
    label: `${run.title} · ${memberByProject.get(target.projectId)?.project_name ?? target.projectId}`,
    ...(run.integration_connection_id ? { connectionId: run.integration_connection_id } : {}),
    ...(target.alreadyMerged && !landingOn.has(target.projectId) ? { alreadyMerged: true } : {})
  }))
  return draft.finish(integrationEntries)
}

export type RunDoneQueueOutcome =
  /** The dialog owns the move now. */
  | 'queued'
  /** Nothing to merge or archive; the caller moves the run's ticket as a plain drop would. */
  | 'nothing'

/**
 * Done/Merged for the whole run. Rejects when a branch cannot be assessed (the drop must then
 * be refused: Done means merged). Returns `nothing` when no branch is left to merge or
 * archive, after moving the run's worktree-less children along.
 */
export async function queueDocumentRunDone(args: {
  runId: string
  ticketId: string
  projectId: string
  targetColumn: 'done' | 'merged'
  sortOrder: number
}): Promise<RunDoneQueueOutcome> {
  const detail = await documentFlowApi.get(args.runId)
  if (!detail) return 'nothing'
  useDocumentFlowStore.getState().applyDetail(detail)
  // A connection run whose members were never recorded: nothing to walk — the plain path
  // (the integration instance alone) is all that can be done for it
  if (detail.run.integration_connection_id && !isConnectionRun(detail.run)) return 'nothing'

  const store = useKanbanStore.getState()
  const tickets = store.tickets.get(args.projectId) ?? []
  // Every branch is checked with git before anything shows: say so meanwhile, so a drop
  // never looks like it did nothing
  const branchCount = selectedItems(detail).reduce(
    (count, item) => count + Math.max(1, item.members?.length ?? 0),
    0
  )
  const checking = toast.loading(
    `Checking ${branchCount} branch${branchCount === 1 ? '' : 'es'} of ${detail.run.title}…`
  )
  let queue: RunDoneQueue
  try {
    queue = await buildRunDoneQueue(detail, args.ticketId, tickets)
  } finally {
    toast.dismiss(checking)
  }

  if (queue.entries.length === 0) {
    if (queue.kept.length > 0) {
      toast.warning(
        `Kept: ${queue.kept.map((k) => `${k.label} (${k.reason})`).join(', ')}`
      )
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

async function moveTicketsAlong(
  projectId: string,
  column: KanbanTicketColumn,
  ticketIds: readonly string[]
): Promise<void> {
  const state = useKanbanStore.getState()
  for (const ticketId of ticketIds) {
    const ticket = state.tickets.get(projectId)?.find((t) => t.id === ticketId)
    if (!ticket || ticket.archived_at || ticket.column === column) continue
    const sortOrder = state.computeSortOrder(state.getTicketsByColumn(projectId, column), 0)
    await state.moveTicket(ticketId, projectId, column, sortOrder, { skipCompletionEffects: true })
  }
}
