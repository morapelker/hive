import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  ticketKey,
  useKanbanStore,
  type PendingDoneMoveIdentity,
  type PendingDoneMoveMember,
  type PendingDoneMoveWorktree
} from '@/stores/useKanbanStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { documentFlowApi } from '@/api/document-flow-api'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { Loader2, GitMerge, GitCommit, Archive, AlertTriangle } from 'lucide-react'
import { dbApi } from '@/api/db-api'
import { gitApi } from '@/api/git-api'
import { cn } from '@/lib/utils'
import { findCarriedRunTickets } from '@/lib/document-flow/carried-tickets'
import { runItemOfTicket } from '@/lib/document-flow/ticket-run-membership'
import { runKindNoun } from '@/components/document-flow/document-flow-ui'
import { ChangedFilesPanel, type ChangedFilesPanelHandle } from './merge-dialog/ChangedFilesPanel'
import { ChangedFilesSummary, SummaryChip } from './merge-dialog/ChangedFilesSummary'
import { useChangedFiles } from './merge-dialog/useChangedFiles'
import type { ChangedFilesSource, ChangedFilesTotals } from './merge-dialog/changed-files'

type Step = 'loading' | 'commit_base' | 'commit' | 'merge' | 'archive'

type MergeWorktree = {
  id: string
  project_id: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  base_branch: string | null
}

type MergeProject = {
  path: string
  name?: string
}

interface BranchStats {
  filesChanged: number
  insertions: number
  deletions: number
  commitsAhead: number
}

/**
 * Document-run batch on a connection project: one member worktree of the instance the entry
 * stands for, checked against the branch it should be on (the member's integration branch
 * for a merge entry, the member's base for an archive entry).
 */
interface ResolvedMember extends PendingDoneMoveMember {
  /** Root of the member repository, where its worktree is removed from. */
  projectPath: string
  baseBranch: string
  baseWorktreeId: string
  baseWorktreePath: string
  baseDirty: boolean
  dirty: boolean
  branchStats: BranchStats
}

interface ResolvedState {
  featureWorktreeId: string
  featureWorktreePath: string
  featureBranch: string
  baseWorktreeId: string
  baseWorktreePath: string
  baseBranch: string
  ticketTitle: string
  projectPath: string
  projectName: string | null
  baseDirty: boolean
  branchStats: BranchStats
  alreadyMerged: boolean
  /**
   * Document-run tickets merged before this one whose work is on its branch (it was cut from
   * the run's integration branch) but not on the base branch yet: merging brings them along.
   */
  carriedRunTickets: string[]
  /**
   * Connection project: every member worktree of the instance; the `feature*` / `base*`
   * fields above describe the member in focus. Merged in one call, archived all or none.
   */
  members?: ResolvedMember[]
}

const toBranchStats = (stat: {
  filesChanged: number
  insertions: number
  deletions: number
  commitsAhead: number
}): BranchStats => ({
  filesChanged: stat.filesChanged,
  insertions: stat.insertions,
  deletions: stat.deletions,
  commitsAhead: stat.commitsAhead
})

/** The worktrees an entry stands for: its instance's members, or the one worktree. */
const entryWorktreeCount = (entry: Pick<PendingDoneMoveWorktree, 'members'>): number =>
  entry.members?.length ?? 1

/**
 * Archiving every worktree of an instance deletes the instance; its sessions (an agent's
 * terminal, say) must be released first — they are listed per connection, not per worktree.
 */
async function closeInstanceSessions(connectionId: string | undefined): Promise<void> {
  if (!connectionId) return
  const sessionStore = useSessionStore.getState()
  for (const session of sessionStore.sessionsByConnection.get(connectionId) ?? []) {
    try {
      await sessionStore.closeSession(session.id)
    } catch {
      // Non-critical — the session may be gone already
    }
  }
}

export function MergeOnDoneDialog() {
  const pendingDoneMove = useKanbanStore((s) => s.pendingDoneMove)
  const completeDoneMove = useKanbanStore((s) => s.completeDoneMove)
  const continueDoneMoveAfterConflict = useKanbanStore((s) => s.continueDoneMoveAfterConflict)
  const skipDoneMoveEntry = useKanbanStore((s) => s.skipDoneMoveEntry)
  const clearPendingDoneMove = useKanbanStore((s) => s.clearPendingDoneMove)

  // Identity passed to completeDoneMove so a stale async completion (e.g. a
  // merge resolving after dismissal) can't act on a replacement pending move
  const pendingIdentity = useMemo<PendingDoneMoveIdentity | undefined>(
    () =>
      pendingDoneMove
        ? {
            ticketId: pendingDoneMove.ticketId,
            projectId: pendingDoneMove.projectId,
            worktreeId: pendingDoneMove.worktreeId,
            kind: pendingDoneMove.entry?.kind
          }
        : undefined,
    [pendingDoneMove]
  )

  // Document-run batch (shift-drop of the run's ticket): the entry being handled
  const runEntry = pendingDoneMove?.run ? pendingDoneMove.entry : undefined
  const isRunChild = runEntry?.kind === 'run-child'
  const isRunIntegration = runEntry?.kind === 'run-integration'

  const [step, setStep] = useState<Step>('loading')
  const [resolved, setResolved] = useState<ResolvedState | null>(null)
  // Connection project: which member of the instance the file list and header show
  const [memberIndex, setMemberIndex] = useState(0)
  const focusedMember = resolved?.members?.[memberIndex] ?? resolved?.members?.[0]
  // What the inspect steps describe: the member in focus, else the entry's one worktree
  const view = resolved
    ? {
        featureWorktreePath: focusedMember?.worktreePath ?? resolved.featureWorktreePath,
        featureBranch: focusedMember?.branchName ?? resolved.featureBranch,
        baseBranch: focusedMember?.baseBranch ?? resolved.baseBranch,
        baseWorktreePath: focusedMember?.baseWorktreePath ?? resolved.baseWorktreePath,
        branchStats: focusedMember?.branchStats ?? resolved.branchStats,
        projectName: focusedMember?.projectName ?? resolved.projectName
      }
    : null
  const [commitMessage, setCommitMessage] = useState('')
  const [baseCommitMessage, setBaseCommitMessage] = useState('')
  const [committingBase, setCommittingBase] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [archivingAll, setArchivingAll] = useState(false)

  // The file list / diff drill-down owns its navigation state; the dialog
  // only needs to ask it whether Escape was consumed (back / clear filter)
  const panelRef = useRef<ChangedFilesPanelHandle>(null)

  const inspecting = step === 'commit_base' || step === 'commit' || step === 'merge'

  // Which change set the file list shows: the branch against its base in the
  // merge step, the uncommitted changes of the relevant worktree otherwise
  const changedSource = useMemo<ChangedFilesSource | null>(() => {
    // `resolved`/`step` linger after the dialog closes; stop watching then
    if (!resolved || !pendingDoneMove) return null
    const shown = focusedMember ?? resolved
    switch (step) {
      case 'merge':
        return {
          kind: 'branch',
          worktreePath: focusedMember?.worktreePath ?? resolved.featureWorktreePath,
          baseBranch: shown.baseBranch
        }
      case 'commit':
        return {
          kind: 'worktree',
          worktreePath: focusedMember?.worktreePath ?? resolved.featureWorktreePath
        }
      case 'commit_base':
        return { kind: 'worktree', worktreePath: shown.baseWorktreePath }
      default:
        return null
    }
  }, [resolved, focusedMember, step, pendingDoneMove])
  const changed = useChangedFiles(changedSource)

  // The merge step assumes a clean feature tree, but an agent may still be
  // writing. Merge lands commits only, so new edits go through the commit
  // step first — the same routing init applies when the dialog opens.
  useEffect(() => {
    if (step !== 'merge' || !resolved || !pendingDoneMove) return
    const path = resolved.featureWorktreePath
    let cancelled = false
    const unsubscribe = gitApi.onStatusChanged((event) => {
      if (event.worktreePath !== path) return
      void gitApi.hasUncommittedChanges(path).then((dirty) => {
        if (!cancelled && dirty) setStep('commit')
      })
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [step, resolved, pendingDoneMove])

  // Initialize when pendingDoneMove changes
  useEffect(() => {
    if (!pendingDoneMove) return

    let cancelled = false
    const pending = pendingDoneMove

    const init = async () => {
      setStep('loading')
      setResolved(null)
      setMemberIndex(0)
      setCommittingBase(false)
      setCommitting(false)
      setMerging(false)
      setArchiving(false)
      setArchivingAll(false)

      try {
        // Look up ticket from store
        const tickets = useKanbanStore.getState().getTicketsForProject(pending.projectId)
        const ticket = tickets.find((t) => t.id === pending.ticketId)
        const identity: PendingDoneMoveIdentity = {
          ticketId: pending.ticketId,
          projectId: pending.projectId,
          worktreeId: pending.worktreeId,
          kind: pending.entry?.kind
        }
        // Document-run batch: the entry's own ticket names the step, not the run's
        const entry = pending.run ? pending.entry : undefined
        const entryTicket = entry?.ticketId
          ? tickets.find((t) => t.id === entry.ticketId)
          : undefined
        const entryTitle = entryTicket?.title ?? entry?.label ?? ticket?.title ?? ''
        const runChild = entry?.kind === 'run-child'

        // Connection tickets carry no worktree_id — the drop handler queues
        // each member worktree explicitly via pending.worktreeId
        const mergeWorktreeId = pending.worktreeId ?? ticket?.worktree_id
        if (!ticket || !mergeWorktreeId) {
          clearPendingDoneMove()
          return
        }

        // Document-run batch on a connection project: the entry is a ticket's whole instance.
        // Every member worktree is checked; one that cannot go holds the whole instance.
        const instanceMembers = pending.run && entry?.members?.length ? entry.members : null
        if (instanceMembers) {
          const members: ResolvedMember[] = []
          for (const member of instanceMembers) {
            const worktree = await dbApi.worktree.get<MergeWorktree>(member.worktreeId)
            if (cancelled) return
            if (!worktree || worktree.status !== 'active') {
              await skipDoneMoveEntry(identity, `its worktree in ${member.projectName} is gone`)
              return
            }
            let baseBranch: string | undefined
            let baseWorktree: MergeWorktree | undefined
            if (runChild) {
              // A ticket branch merges into its member's integration branch
              const integrationWorktree = member.integrationWorktreeId
                ? await dbApi.worktree.get<MergeWorktree>(member.integrationWorktreeId)
                : null
              if (cancelled) return
              if (
                !integrationWorktree ||
                integrationWorktree.status !== 'active' ||
                !member.integrationBranch
              ) {
                await skipDoneMoveEntry(
                  identity,
                  `the integration worktree of ${member.projectName} is gone`
                )
                return
              }
              baseBranch = member.integrationBranch
              baseWorktree = integrationWorktree
            } else {
              // An archive entry may only go once the member's base has its work
              const activeWorktrees = await dbApi.worktree.getActiveByProject<MergeWorktree>(
                member.projectId
              )
              if (cancelled) return
              baseBranch =
                worktree.base_branch ?? activeWorktrees.find((w) => w.is_default)?.branch_name
              baseWorktree = activeWorktrees.find((w) => w.branch_name === baseBranch)
            }
            if (!baseBranch) {
              await skipDoneMoveEntry(identity, `no base branch resolved for ${member.projectName}`)
              return
            }
            const [baseDirty, dirty, stat] = await Promise.all([
              baseWorktree ? gitApi.hasUncommittedChanges(baseWorktree.path) : Promise.resolve(false),
              gitApi.hasUncommittedChanges(worktree.path),
              gitApi.branchDiffShortStat(worktree.path, baseBranch)
            ])
            if (cancelled) return
            if (!stat.success) {
              toast.warning(
                `Cannot verify merge status in ${member.projectName}: ${stat.error ?? 'unknown error'}`
              )
              clearPendingDoneMove()
              return
            }
            const memberProject = await dbApi.project.get<MergeProject>(member.projectId)
            if (cancelled) return
            members.push({
              ...member,
              worktreePath: worktree.path,
              branchName: worktree.branch_name,
              projectPath: memberProject?.path ?? worktree.path,
              baseBranch,
              baseWorktreeId: baseWorktree?.id ?? '',
              baseWorktreePath: baseWorktree?.path ?? worktree.path,
              baseDirty,
              dirty,
              branchStats: toBranchStats(stat)
            })
          }
          const hasWork = (m: ResolvedMember): boolean => m.dirty || m.branchStats.commitsAhead > 0
          const alreadyMerged = !members.some(hasWork)
          if (runChild && alreadyMerged) {
            await completeDoneMove(identity)
            return
          }
          if (!runChild && !alreadyMerged) {
            const where = members.filter(hasWork).map((m) => m.projectName).join(', ')
            await skipDoneMoveEntry(identity, `has new changes in ${where} since the run`)
            return
          }
          const focus = Math.max(0, members.findIndex(hasWork))
          const anchor = members[focus]
          setResolved({
            featureWorktreeId: anchor.worktreeId,
            featureWorktreePath: anchor.worktreePath,
            featureBranch: anchor.branchName,
            baseWorktreeId: anchor.baseWorktreeId,
            baseWorktreePath: anchor.baseWorktreePath,
            baseBranch: anchor.baseBranch,
            ticketTitle: entryTitle,
            projectPath: anchor.projectPath,
            projectName: anchor.projectName,
            baseDirty: members.some((m) => m.baseDirty),
            branchStats: anchor.branchStats,
            alreadyMerged,
            carriedRunTickets: [],
            members
          })
          setMemberIndex(focus)
          setCommitMessage(entryTitle)
          setBaseCommitMessage('')
          setStep(
            alreadyMerged
              ? 'archive'
              : members.some((m) => m.baseDirty)
                ? 'commit_base'
                : members.some((m) => m.dirty)
                  ? 'commit'
                  : 'merge'
          )
          return
        }

        // Fetch feature worktree
        const featureWorktree = await dbApi.worktree.get<MergeWorktree>(mergeWorktreeId)
        if (!featureWorktree || featureWorktree.status !== 'active') {
          // Worktree archived/deleted since the drop — nothing to merge, so
          // complete the move instead of failing the transition
          await completeDoneMove(identity)
          return
        }

        // Resolve base branch (connection members may live in another project)
        const activeWorktrees = await dbApi.worktree.getActiveByProject<MergeWorktree>(
          pending.worktreeProjectId ?? pending.projectId
        )
        const defaultWt = activeWorktrees.find((w) => w.is_default)
        let resolvedBaseBranch = featureWorktree.base_branch ?? defaultWt?.branch_name
        // Document-run batch: a ticket branch merges into the run's integration branch (the
        // branch it was cut from), never straight into base — that is the integration
        // entry's step, after every ticket branch landed
        let integrationWorktree: MergeWorktree | null = null
        if (runChild && entry?.integrationBranch && entry.integrationWorktreeId) {
          integrationWorktree = await dbApi.worktree.get<MergeWorktree>(
            entry.integrationWorktreeId
          )
          if (cancelled) return
          if (!integrationWorktree || integrationWorktree.status !== 'active') {
            await skipDoneMoveEntry(identity, 'the integration worktree is gone')
            return
          }
          resolvedBaseBranch = entry.integrationBranch
        }

        if (!resolvedBaseBranch) {
          toast.warning('Skipping merge — no base branch resolved')
          await completeDoneMove(identity)
          return
        }

        // Find base worktree
        const baseWorktree =
          integrationWorktree ??
          activeWorktrees.find(
            (w) => w.branch_name === resolvedBaseBranch && w.status === 'active'
          )

        if (!baseWorktree) {
          // Base worktree archived/deleted — merge impossible, but the move
          // should still land in the target column
          toast.warning(`Skipping merge — no worktree for ${resolvedBaseBranch}`)
          await completeDoneMove(identity)
          return
        }

        // Check both worktrees for dirty state in parallel
        const [baseDirty, hasUncommitted, branchStatResult] = await Promise.all([
          gitApi.hasUncommittedChanges(baseWorktree.path),
          gitApi.hasUncommittedChanges(featureWorktree.path),
          gitApi.branchDiffShortStat(featureWorktree.path, resolvedBaseBranch)
        ])

        if (cancelled) return

        if (!branchStatResult.success) {
          toast.warning(`Cannot verify merge status: ${branchStatResult.error ?? 'unknown error'}`)
          clearPendingDoneMove()
          return
        }

        const branchStats: BranchStats = {
          filesChanged: branchStatResult.filesChanged,
          insertions: branchStatResult.insertions,
          deletions: branchStatResult.deletions,
          commitsAhead: branchStatResult.commitsAhead
        }

        // No diffs at all means the branch already landed on base — skip the
        // commit/merge steps but still offer the archive/keep choice
        const alreadyMerged = !hasUncommitted && branchStats.commitsAhead === 0

        // Document-run batch: a ticket branch with nothing left for the integration branch
        // needs no merge step (its archive entry at the tail takes the archive/keep step);
        // an archive entry that picked up work since the queue was built is left alone —
        // the branch must not be deleted, and a merge into base is not this batch's to do
        if (runChild && alreadyMerged) {
          await completeDoneMove(identity)
          return
        }
        if (entry?.kind === 'run-child-archive' && !alreadyMerged) {
          await skipDoneMoveEntry(identity, 'has new changes since the run')
          return
        }

        // A merge-only connection queue (no offerArchive) advances past a
        // clean member without asking. Every connection flow sets offerArchive
        // today, so members fall through to the archive/keep step and can be
        // archived like any feature worktree.
        if (pending.worktreeId && alreadyMerged && !pending.offerArchive) {
          await completeDoneMove(identity)
          return
        }

        // Get project path for archive step
        const project = await dbApi.project.get<MergeProject>(featureWorktree.project_id)
        // (A run batch merges ticket branches into the integration branch, where the
        // sibling merges already are: nothing is carried.)
        const carriedRunTickets = alreadyMerged || runChild
          ? []
          : await findCarriedRunTickets({
              ticketId: ticket.id,
              worktreeId: featureWorktree.id,
              featureWorktreePath: featureWorktree.path,
              baseWorktreePath: baseWorktree.path
            }).catch(() => [])
        if (cancelled) return

        setResolved({
          featureWorktreeId: featureWorktree.id,
          featureWorktreePath: featureWorktree.path,
          featureBranch: featureWorktree.branch_name,
          baseWorktreeId: baseWorktree.id,
          baseWorktreePath: baseWorktree.path,
          baseBranch: resolvedBaseBranch,
          ticketTitle: entryTitle,
          projectPath: project?.path ?? baseWorktree.path,
          projectName: project?.name ?? null,
          baseDirty,
          branchStats,
          alreadyMerged,
          carriedRunTickets
        })
        setCommitMessage(entryTitle)
        setBaseCommitMessage('')
        setStep(
          alreadyMerged
            ? 'archive'
            : baseDirty
              ? 'commit_base'
              : hasUncommitted
                ? 'commit'
                : 'merge'
        )
      } catch (err) {
        if (!cancelled) {
          toast.error(`Failed to check branch: ${err instanceof Error ? err.message : String(err)}`)
          clearPendingDoneMove()
        }
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [pendingDoneMove, completeDoneMove, clearPendingDoneMove, skipDoneMoveEntry])

  /**
   * Connection project: the members' branches after a commit or a base commit. Any member
   * with commits its branch to merge into lacks → the merge step; none → the entry is done.
   */
  const continueInstanceAfterCommit = useCallback(
    async (members: ResolvedMember[]): Promise<void> => {
      const updated: ResolvedMember[] = []
      for (const member of members) {
        const [dirty, stat] = await Promise.all([
          gitApi.hasUncommittedChanges(member.worktreePath),
          gitApi.branchDiffShortStat(member.worktreePath, member.baseBranch)
        ])
        if (!stat.success) {
          toast.warning(
            `Cannot verify merge status in ${member.projectName}: ${stat.error ?? 'unknown error'}`
          )
          clearPendingDoneMove()
          return
        }
        updated.push({ ...member, dirty, branchStats: toBranchStats(stat) })
      }
      const focusDirty = updated.findIndex((m) => m.dirty)
      const focusWork = updated.findIndex((m) => m.branchStats.commitsAhead > 0)
      const focus = focusDirty >= 0 ? focusDirty : Math.max(0, focusWork)
      setResolved((prev) =>
        prev ? { ...prev, members: updated, branchStats: updated[focus].branchStats } : prev
      )
      setMemberIndex(focus)
      if (focusDirty >= 0) setStep('commit')
      else if (focusWork >= 0) setStep('merge')
      else await completeDoneMove(pendingIdentity)
    },
    [pendingIdentity, completeDoneMove, clearPendingDoneMove]
  )

  const handleCommit = useCallback(async () => {
    if (!resolved || !commitMessage.trim()) return
    setCommitting(true)
    try {
      // Connection project: every member worktree with uncommitted changes, one message
      if (resolved.members) {
        const dirty = resolved.members.filter((m) => m.dirty)
        for (const member of dirty) {
          const statuses = await gitApi.getFileStatuses(member.worktreePath)
          if (statuses.files?.some((file) => file.status === 'C')) {
            toast.error(
              `${member.branchName} in ${member.projectName} has unresolved conflict markers — resolve them first`
            )
            return
          }
        }
        for (const member of dirty) {
          // A retry after a failure further down the list: this member is committed already
          if (!(await gitApi.hasUncommittedChanges(member.worktreePath))) continue
          const stageResult = await gitApi.stageAll(member.worktreePath)
          if (!stageResult.success) {
            toast.error(`Failed to stage in ${member.projectName}: ${stageResult.error}`)
            return
          }
          const commitResult = await gitApi.commit(member.worktreePath, commitMessage.trim())
          if (!commitResult.success) {
            toast.error(`Failed to commit in ${member.projectName}: ${commitResult.error}`)
            return
          }
        }
        toast.success(
          dirty.length === 1
            ? 'Changes committed'
            : `Changes committed in ${dirty.map((m) => m.projectName).join(', ')}`
        )
        await continueInstanceAfterCommit(resolved.members)
        return
      }
      // A run's ticket branch may hold a half-resolved merge of the integration branch:
      // committing would land the conflict markers as the resolution
      if (isRunChild) {
        const statuses = await gitApi.getFileStatuses(resolved.featureWorktreePath)
        if (statuses.files?.some((file) => file.status === 'C')) {
          toast.error(
            `${resolved.featureBranch} has unresolved conflict markers — resolve them first`
          )
          return
        }
      }
      const stageResult = await gitApi.stageAll(resolved.featureWorktreePath)
      if (!stageResult.success) {
        toast.error(`Failed to stage: ${stageResult.error}`)
        return
      }

      const commitResult = await gitApi.commit(resolved.featureWorktreePath, commitMessage.trim())
      if (!commitResult.success) {
        toast.error(`Failed to commit: ${commitResult.error}`)
        return
      }

      toast.success('Changes committed')

      // Re-check branch divergence after commit
      const statResult = await gitApi.branchDiffShortStat(
        resolved.featureWorktreePath,
        resolved.baseBranch
      )

      if (!statResult.success) {
        toast.warning(`Cannot verify merge status: ${statResult.error ?? 'unknown error'}`)
        clearPendingDoneMove()
        return
      }

      if (statResult.commitsAhead > 0) {
        setResolved((prev) =>
          prev
            ? {
                ...prev,
                branchStats: {
                  filesChanged: statResult.filesChanged,
                  insertions: statResult.insertions,
                  deletions: statResult.deletions,
                  commitsAhead: statResult.commitsAhead
                }
              }
            : prev
        )
        setStep('merge')
      } else {
        // No divergence after commit — base already has everything
        await completeDoneMove(pendingIdentity)
      }
    } catch (err) {
      toast.error(`Commit failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCommitting(false)
    }
  }, [
    resolved,
    commitMessage,
    pendingIdentity,
    isRunChild,
    completeDoneMove,
    clearPendingDoneMove,
    continueInstanceAfterCommit
  ])

  const handleCommitBase = useCallback(async () => {
    if (!resolved || !baseCommitMessage.trim()) return
    setCommittingBase(true)
    try {
      // Connection project: every member integration worktree with uncommitted changes
      if (resolved.members) {
        for (const member of resolved.members.filter((m) => m.baseDirty)) {
          if (!(await gitApi.hasUncommittedChanges(member.baseWorktreePath))) continue
          const stageResult = await gitApi.stageAll(member.baseWorktreePath)
          if (!stageResult.success) {
            toast.error(`Failed to stage on ${member.baseBranch} in ${member.projectName}: ${stageResult.error}`)
            return
          }
          const commitResult = await gitApi.commit(member.baseWorktreePath, baseCommitMessage.trim())
          if (!commitResult.success) {
            toast.error(`Failed to commit on ${member.baseBranch} in ${member.projectName}: ${commitResult.error}`)
            return
          }
        }
        toast.success('Changes committed on the integration branches')
        await continueInstanceAfterCommit(
          resolved.members.map((m) => ({ ...m, baseDirty: false }))
        )
        return
      }
      const stageResult = await gitApi.stageAll(resolved.baseWorktreePath)
      if (!stageResult.success) {
        toast.error(`Failed to stage on ${resolved.baseBranch}: ${stageResult.error}`)
        return
      }

      const commitResult = await gitApi.commit(resolved.baseWorktreePath, baseCommitMessage.trim())
      if (!commitResult.success) {
        toast.error(`Failed to commit on ${resolved.baseBranch}: ${commitResult.error}`)
        return
      }

      toast.success(`Changes committed on ${resolved.baseBranch}`)

      // Check if feature branch still has uncommitted changes
      const featureHasUncommitted = await gitApi.hasUncommittedChanges(resolved.featureWorktreePath)

      if (featureHasUncommitted) {
        setStep('commit')
      } else {
        // Re-check branch divergence
        const statResult = await gitApi.branchDiffShortStat(
          resolved.featureWorktreePath,
          resolved.baseBranch
        )
        if (!statResult.success) {
          toast.warning(`Cannot verify merge status: ${statResult.error ?? 'unknown error'}`)
          clearPendingDoneMove()
          return
        }

        if (statResult.commitsAhead > 0) {
          setResolved((prev) =>
            prev
              ? {
                  ...prev,
                  branchStats: {
                    filesChanged: statResult.filesChanged,
                    insertions: statResult.insertions,
                    deletions: statResult.deletions,
                    commitsAhead: statResult.commitsAhead
                  }
                }
              : prev
          )
          setStep('merge')
        } else {
          await completeDoneMove(pendingIdentity)
        }
      }
    } catch (err) {
      toast.error(`Commit failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCommittingBase(false)
    }
  }, [
    resolved,
    baseCommitMessage,
    pendingIdentity,
    completeDoneMove,
    clearPendingDoneMove,
    continueInstanceAfterCommit
  ])

  const handleMerge = useCallback(async () => {
    if (!resolved || !pendingDoneMove) return
    setMerging(true)
    try {
      // Last look before landing commits only: anything written since the
      // step opened must be committed first (see the status watcher above).
      // An instance is looked at member by member — the run commits nothing on its own.
      const branchPaths = resolved.members
        ? resolved.members.map((m) => m.worktreePath)
        : [resolved.featureWorktreePath]
      const dirtyNow = await Promise.all(branchPaths.map((p) => gitApi.hasUncommittedChanges(p)))
      if (dirtyNow.some(Boolean)) {
        toast.warning('New uncommitted changes on the branch — commit them before merging')
        if (resolved.members) {
          const members = resolved.members.map((m, i) => ({ ...m, dirty: dirtyNow[i] }))
          setResolved((prev) => (prev ? { ...prev, members } : prev))
          setMemberIndex(Math.max(0, dirtyNow.findIndex(Boolean)))
        }
        setStep('commit')
        return
      }

      // Document-run batch: a ticket branch lands on the integration branch through the
      // run's own merge path — a dry run first, and a conflicting merge is aborted on the
      // server, so the integration worktree is never left mid-merge and the queue goes on
      // with the next branch. The run's item and ticket read as merged afterwards, as
      // they would had the run merged it.
      if (isRunChild && runEntry?.runId && runEntry.itemId && pendingDoneMove.run) {
        const label = runEntry.label ?? resolved.featureBranch
        const check = await documentFlowApi.prepareMerge(runEntry.runId, runEntry.itemId)
        if (check.state === 'conflict' || check.state === 'error') {
          // Connection project: name the members that conflicted
          const conflicted = (check.members ?? []).filter((m) => m.state === 'conflict')
          const where =
            conflicted.length > 0
              ? conflicted
                  .map(
                    (m) =>
                      `${m.project_name} (${m.conflictedFiles.length} file${m.conflictedFiles.length !== 1 ? 's' : ''})`
                  )
                  .join(', ')
              : `${check.conflictedFiles.length} file${check.conflictedFiles.length !== 1 ? 's' : ''}`
          toast.error(
            check.state === 'conflict'
              ? `Merge conflicts in ${where} on ${label} — kept, continuing with the next branch`
              : `Could not check ${label}: ${check.error ?? 'unknown error'} — kept`
          )
          continueDoneMoveAfterConflict(pendingIdentity)
          return
        }
        if (check.state === 'no_changes' || check.alreadyMerged) {
          await completeDoneMove(pendingIdentity)
          return
        }
        const result = await documentFlowApi.merge(runEntry.runId, runEntry.itemId)
        if (!result.success) {
          toast.error(`Could not merge ${label}: ${result.error ?? 'merge conflicts'} — kept`)
          continueDoneMoveAfterConflict(pendingIdentity)
          return
        }
        toast.success(
          resolved.members
            ? `${label} merged into ${resolved.members.map((m) => `${m.baseBranch} of ${m.projectName}`).join(', ')}`
            : `${label} merged into ${resolved.baseBranch}`
        )
        const { runId, itemId, ticketId } = runEntry
        const projectId = pendingDoneMove.projectId
        void useDocumentFlowStore
          .getState()
          .updateItem(runId, itemId, {
            status: 'merged',
            status_detail: 'Merged from the board after the run ended.',
            finished_at: new Date().toISOString()
          })
          .catch(() => {
            // The dashboard may lag behind the branch; the merge itself landed
          })
        if (ticketId) {
          const kanban = useKanbanStore.getState()
          const ticket = kanban.tickets.get(projectId)?.find((t) => t.id === ticketId)
          if (ticket && ticket.column !== 'merged' && ticket.column !== 'done') {
            await kanban
              .moveTicket(
                ticketId,
                projectId,
                'merged',
                kanban.computeSortOrder(kanban.getTicketsByColumn(projectId, 'merged'), 0),
                { skipCompletionEffects: true }
              )
              .catch(() => {
                // Its archive entry moves it again at the end of the batch
              })
          }
        }
        await completeDoneMove(pendingIdentity)
        return
      }

      // Pull latest on base branch first (only if remote exists)
      const remoteResult = await gitApi.getRemoteUrl(resolved.baseWorktreePath)
      if (remoteResult.url) {
        const pullResult = await gitApi.pull(resolved.baseWorktreePath)
        if (!pullResult.success) {
          toast.warning(`Pull failed on ${resolved.baseBranch} — continuing with local merge`)
        }
      }

      // Merge feature into base
      const mergeResult = await gitApi.merge(resolved.baseWorktreePath, resolved.featureBranch)

      if (!mergeResult.success) {
        // Conflicts or error — keep conflicts on disk so the ticket-level fix flow can act on them.
        if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
          useGitStore.getState().setHasConflicts(resolved.baseWorktreePath, true)
          // The ticket surfaces one conflict target — keep the first member
          // that conflicted in this queue so later members don't hide it
          if (!pendingDoneMove.conflictedWorktrees?.length) {
            useWorktreeStatusStore
              .getState()
              .setMergeConflictWorktreeForTicket(
                ticketKey(pendingDoneMove.projectId, pendingDoneMove.ticketId),
                resolved.baseWorktreeId
              )
          }
          // Hydrate the owning project's worktrees so the conflict banner can
          // resolve the worktree path when the member project isn't loaded yet
          void useWorktreeStore
            .getState()
            .loadWorktrees(pendingDoneMove.worktreeProjectId ?? pendingDoneMove.projectId)
          void useGitStore.getState().refreshStatuses(resolved.baseWorktreePath)
          const conflictSummary = `Merge conflicts in ${mergeResult.conflicts.length} file${mergeResult.conflicts.length !== 1 ? 's' : ''}`
          // Connection flow: a conflicted member must not abort the queue —
          // keep checking the remaining members so every branch gets merged
          // (or flagged) in one pass. The ticket stays put at the end.
          // (A run batch's integration entry is the exception: the ticket
          // branches behind it may only be archived once the integration branch
          // is on base, and base is now mid-merge — the batch stops here.)
          if (pendingDoneMove.worktreeId && !isRunIntegration) {
            const where = resolved.projectName ?? resolved.baseBranch
            const hasMore = (pendingDoneMove.remainingWorktrees?.length ?? 0) > 0
            toast.error(
              `${conflictSummary} on ${where}${hasMore ? ' — continuing with the next project' : ''}`
            )
            continueDoneMoveAfterConflict(pendingIdentity)
            return
          }
          toast.error(
            isRunIntegration
              ? `${conflictSummary} on ${resolved.baseBranch} — nothing archived. Fix them, then shift-drag the run's ticket again`
              : `${conflictSummary} — merge manually`
          )
        } else {
          toast.error(`Merge failed: ${mergeResult.error}`)
        }
        clearPendingDoneMove()
        return
      }

      toast.success('Branch merged successfully')
      // Dismissed during the merge, and another move opened since: its branch was not merged
      // and must not get the archive step, which deletes the branch
      if (useKanbanStore.getState().pendingDoneMove !== pendingDoneMove) return
      // A merge-only connection queue advances instead of offering the
      // destructive archive step; connection members with offerArchive get it (see init)
      if (pendingDoneMove.worktreeId && !pendingDoneMove.offerArchive) {
        await completeDoneMove(pendingIdentity)
        return
      }
      setStep('archive')
    } catch (err) {
      toast.error(`Merge failed: ${err instanceof Error ? err.message : String(err)}`)
      clearPendingDoneMove()
    } finally {
      setMerging(false)
    }
  }, [
    resolved,
    pendingDoneMove,
    pendingIdentity,
    runEntry,
    isRunChild,
    isRunIntegration,
    completeDoneMove,
    continueDoneMoveAfterConflict,
    clearPendingDoneMove
  ])

  const handleArchive = useCallback(async () => {
    if (!resolved) return

    // Connection project: every worktree of the instance; the last one removed deletes
    // the instance itself, so they go one after the other
    const archiveTargets = resolved.members
      ? resolved.members.map((m) => ({
          worktreeId: m.worktreeId,
          worktreePath: m.worktreePath,
          branch: m.branchName,
          projectPath: m.projectPath
        }))
      : [
          {
            worktreeId: resolved.featureWorktreeId,
            worktreePath: resolved.featureWorktreePath,
            branch: resolved.featureBranch,
            projectPath: resolved.projectPath
          }
        ]
    // A ticket's instance goes whole, so its sessions go first; the integration instance
    // loses one member here and keeps its sessions
    const connectionId = resolved.members ? runEntry?.connectionId : undefined

    try {
      setArchiving(true)
      await completeDoneMove(pendingIdentity)
    } catch (err) {
      setArchiving(false)
      toast.error(`Failed to move ticket: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    void (async () => {
      await closeInstanceSessions(connectionId)
      const store = useWorktreeStore.getState()
      let archived = 0
      for (const target of archiveTargets) {
        try {
          const result = await store.archiveWorktree(
            target.worktreeId,
            target.worktreePath,
            target.branch,
            target.projectPath
          )
          if (result.success) archived += 1
          else toast.error(`Failed to archive ${target.branch}: ${result.error}`)
        } catch (err) {
          toast.error(`Archive failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (archived === 1 && archiveTargets.length === 1) toast.success('Worktree archived')
      else if (archived > 0) toast.success(`${archived} worktree${archived !== 1 ? 's' : ''} archived`)
    })()
  }, [resolved, runEntry, pendingIdentity, completeDoneMove])

  // Connection flow: once the members with work to merge are done, the rest
  // of the queue is archive/keep prompts only (the queue builder puts
  // already-merged members last). Offer to archive them all at once instead
  // of one Archive click per project.
  const archiveAllCandidates = useMemo(() => {
    const remaining = pendingDoneMove?.remainingWorktrees ?? []
    if (!pendingDoneMove?.offerArchive || remaining.length === 0) return []
    return remaining.every((w) => w.alreadyMerged) ? remaining : []
  }, [pendingDoneMove])

  // What the run is called in a sentence. Its kind never changes, so no subscription to the run.
  const runNoun = runKindNoun(
    pendingDoneMove?.run
      ? useDocumentFlowStore.getState().runsById[pendingDoneMove.run.runId]?.run
      : runItemOfTicket(pendingDoneMove?.ticketId ?? '', undefined, { anyStatus: true })?.run
  )

  // Document-run batch: the branches left out, for the archive step's "Kept" line
  const keptEntries = useMemo(
    () => [...(pendingDoneMove?.run?.kept ?? []), ...(pendingDoneMove?.keptWorktrees ?? [])],
    [pendingDoneMove]
  )

  // Document-run batch: what "Archive all" stands for. On a connection project an entry is an
  // instance (several worktrees) and the integration instance is one entry per member, so
  // the count is of instances, the hint says how many worktrees that is
  const archiveAllScope = useMemo(() => {
    const entries: Pick<PendingDoneMoveWorktree, 'worktreeId' | 'connectionId' | 'members' | 'projectId'>[] =
      [...(runEntry ? [runEntry] : []), ...archiveAllCandidates]
    const instances = new Set(entries.map((e) => e.connectionId ?? e.worktreeId)).size
    const worktrees = entries.reduce((n, e) => n + entryWorktreeCount(e), 0)
    const repositories = new Set(
      entries.flatMap((e) => e.members?.map((m) => m.projectId) ?? [e.projectId])
    ).size
    const isConnectionRun = entries.some((e) => !!e.connectionId)
    return { instances, worktrees, repositories, isConnectionRun }
  }, [runEntry, archiveAllCandidates])

  const handleArchiveAll = useCallback(async () => {
    if (!resolved || archiveAllCandidates.length === 0) return
    setArchivingAll(true)

    type ArchiveTarget = {
      worktreeId: string
      worktreePath: string
      branch: string
      baseBranch: string
      projectPath: string
    }
    // One group per entry: a connection instance's worktrees are archived one after the
    // other (the last removal deletes the instance), groups in parallel
    const groups: ArchiveTarget[][] = [
      resolved.members
        ? resolved.members.map((m) => ({
            worktreeId: m.worktreeId,
            worktreePath: m.worktreePath,
            branch: m.branchName,
            baseBranch: m.baseBranch,
            projectPath: m.projectPath
          }))
        : [
            {
              worktreeId: resolved.featureWorktreeId,
              worktreePath: resolved.featureWorktreePath,
              branch: resolved.featureBranch,
              baseBranch: resolved.baseBranch,
              projectPath: resolved.projectPath
            }
          ]
    ]
    // Sessions of a ticket's instance are released before its worktrees go (the last one
    // removed deletes the instance); the integration instance keeps its sessions
    const connectionIds = new Set<string>(
      resolved.members && runEntry?.connectionId ? [runEntry.connectionId] : []
    )
    // Archive removes the worktree and deletes the branch, so a target is only
    // archived while it has nothing to commit or merge
    const isClean = async (worktreePath: string, baseBranch: string): Promise<boolean> => {
      const [dirty, stat] = await Promise.all([
        gitApi.hasUncommittedChanges(worktreePath),
        gitApi.branchDiffShortStat(worktreePath, baseBranch)
      ])
      return !dirty && stat.success && stat.commitsAhead === 0
    }
    // Members that were skipped: gone already, or they picked up work since
    // the queue was built — those keep their own turn in the dialog instead
    // of being archived (archive deletes the branch)
    const handled = new Set<string>()
    const keptForMerge: string[] = []

    // One worktree of a candidate: its archive target when it is clean against its base
    const assess = async (
      worktreeId: string,
      projectId: string
    ): Promise<ArchiveTarget | 'gone' | 'kept' | 'unknown-base'> => {
      const worktree = await dbApi.worktree.get<MergeWorktree>(worktreeId)
      if (!worktree || worktree.status !== 'active') return 'gone'
      const activeWorktrees = await dbApi.worktree.getActiveByProject<MergeWorktree>(projectId)
      const baseBranch =
        worktree.base_branch ?? activeWorktrees.find((w) => w.is_default)?.branch_name
      if (!baseBranch) return 'unknown-base'
      if (!(await isClean(worktree.path, baseBranch))) return 'kept'
      const project = await dbApi.project.get<MergeProject>(worktree.project_id)
      return {
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        branch: worktree.branch_name,
        baseBranch,
        projectPath: project?.path ?? worktree.path
      }
    }

    try {
      await Promise.all(
        archiveAllCandidates.map(async (candidate) => {
          if (candidate.members?.length) {
            // A connection instance goes all or none
            const results = await Promise.all(
              candidate.members.map((m) => assess(m.worktreeId, m.projectId))
            )
            if (results.every((r) => r === 'gone')) {
              handled.add(candidate.worktreeId)
              return
            }
            if (results.some((r) => typeof r === 'string')) {
              keptForMerge.push(candidate.label ?? candidate.members[0].branchName)
              return
            }
            handled.add(candidate.worktreeId)
            if (candidate.connectionId) connectionIds.add(candidate.connectionId)
            groups.push(results as ArchiveTarget[])
            return
          }
          const result = await assess(candidate.worktreeId, candidate.projectId)
          if (result === 'gone') {
            handled.add(candidate.worktreeId)
            return
          }
          if (result === 'unknown-base') return
          if (result === 'kept') {
            const worktree = await dbApi.worktree.get<MergeWorktree>(candidate.worktreeId)
            keptForMerge.push(worktree?.branch_name ?? candidate.label ?? candidate.worktreeId)
            return
          }
          handled.add(candidate.worktreeId)
          groups.push([result])
        })
      )
    } catch (err) {
      setArchivingAll(false)
      toast.error(`Failed to check branches: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // The checks above took a while: the dialog may have been dismissed (Keep
    // in Review) or replaced meanwhile. Then the move is refused and nothing
    // may be archived — closing must never delete branches.
    let accepted: boolean
    try {
      accepted = await completeDoneMove(pendingIdentity, { handledWorktreeIds: handled })
    } catch (err) {
      setArchivingAll(false)
      toast.error(`Failed to move ticket: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!accepted) {
      setArchivingAll(false)
      return
    }

    const store = useWorktreeStore.getState()
    const archiveGroup = async (
      group: ArchiveTarget[]
    ): Promise<({ branch: string; error: string | null | undefined } | null)[]> => {
      // Last look right before the destructive step: work that landed in a worktree since
      // its check above (an agent still writing) keeps it — and, for an instance, every
      // worktree of it
      const dirtyNow = await Promise.all(
        group.map(async (t) => !(await isClean(t.worktreePath, t.baseBranch)))
      )
      if (dirtyNow.some(Boolean)) {
        keptForMerge.push(...group.filter((_, i) => dirtyNow[i]).map((t) => t.branch))
        return group.map(() => null)
      }
      const results: ({ branch: string; error: string | null | undefined } | null)[] = []
      for (const t of group) {
        try {
          const result = await store.archiveWorktree(
            t.worktreeId,
            t.worktreePath,
            t.branch,
            t.projectPath
          )
          results.push({ branch: t.branch, error: result.success ? null : result.error })
        } catch (err) {
          results.push({ branch: t.branch, error: err instanceof Error ? err.message : String(err) })
        }
      }
      return results
    }
    void (async () => {
      for (const connectionId of connectionIds) await closeInstanceSessions(connectionId)
      return (await Promise.all(groups.map(archiveGroup))).flat()
    })().then((results) => {
      if (keptForMerge.length > 0) {
        toast.warning(
          `${keptForMerge.join(', ')} ${keptForMerge.length === 1 ? 'has' : 'have'} new changes — not archived`
        )
      }
      const outcomes = results.filter((r) => r !== null)
      const failed = outcomes.filter((r) => r.error)
      const archived = outcomes.length - failed.length
      if (archived > 0) {
        toast.success(`${archived} worktree${archived !== 1 ? 's' : ''} archived`)
      }
      for (const f of failed) toast.error(`Failed to archive ${f.branch}: ${f.error}`)
    })
  }, [resolved, runEntry, archiveAllCandidates, pendingIdentity, completeDoneMove])

  // The dialog serves both the Done and the optional Merged column
  const targetLabel = pendingDoneMove?.targetColumn === 'merged' ? 'Merged' : 'Done'

  // Connection tickets run this dialog once per member worktree with changes
  const isConnectionFlow = !!pendingDoneMove?.worktreeId
  const remainingCount = pendingDoneMove?.remainingWorktrees?.length ?? 0

  const stepTitle: Record<Step, string> = {
    loading: `Moving to ${targetLabel}...`,
    commit_base: 'Uncommitted changes on base',
    commit: 'Uncommitted changes',
    merge: 'Merge branch',
    archive: 'Archive worktree'
  }

  // The three inspect steps share one footer; only the primary action differs
  const primaryAction =
    step === 'merge'
      ? { label: 'Merge', Icon: GitMerge, onClick: handleMerge, busy: merging, disabled: merging }
      : step === 'commit'
        ? {
            label: 'Commit',
            Icon: GitCommit,
            onClick: handleCommit,
            busy: committing,
            disabled: !commitMessage.trim() || committing
          }
        : {
            label: 'Commit',
            Icon: GitCommit,
            onClick: handleCommitBase,
            busy: committingBase,
            disabled: !baseCommitMessage.trim() || committingBase
          }

  // Header totals until the file list has loaded (renames make the shortstat
  // and the list disagree, so the list wins once it is there)
  const branchTotals: ChangedFilesTotals | null =
    step === 'merge' && view
      ? {
          files: view.branchStats.filesChanged,
          additions: view.branchStats.insertions,
          deletions: view.branchStats.deletions
        }
      : null

  const emptyState = view ? (
    step === 'merge' ? (
      <>
        <p>
          No file differences against{' '}
          <code className="bg-muted px-1 rounded">{view.baseBranch}</code>.
        </p>
        {view.branchStats.commitsAhead > 0 && (
          <p className="text-[11px]">
            The branch is {view.branchStats.commitsAhead} commit
            {view.branchStats.commitsAhead !== 1 ? 's' : ''} ahead, but its content already
            matches <code className="bg-muted px-1 rounded">{view.baseBranch}</code>.
          </p>
        )}
      </>
    ) : (
      <p>
        No uncommitted changes found in{' '}
        <code className="bg-muted px-1 rounded">
          {step === 'commit_base' ? view.baseBranch : view.featureBranch}
        </code>
        .
      </p>
    )
  ) : null

  const stepIcon: Record<Step, React.ReactNode> = {
    loading: <Loader2 className="h-4 w-4 animate-spin" />,
    commit_base: <GitCommit className="h-4 w-4" />,
    commit: <GitCommit className="h-4 w-4" />,
    merge: <GitMerge className="h-4 w-4" />,
    archive: <Archive className="h-4 w-4" />
  }

  return (
    <Dialog
      open={!!pendingDoneMove}
      onOpenChange={(open) => {
        if (!open) clearPendingDoneMove()
      }}
    >
      <DialogContent
        className={cn(
          inspecting
            ? 'max-w-[720px] w-[calc(100vw-2rem)] h-[min(600px,85vh)] flex flex-col gap-3'
            : 'max-w-md'
        )}
        onEscapeKeyDown={(event) => {
          // Escape peels the innermost layer first: an open diff goes back to
          // the list, a filter clears; only then does it close (Keep in Review)
          if (panelRef.current?.handleEscape()) event.preventDefault()
        }}
        data-testid="merge-on-done-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            {stepIcon[step]}
            {stepTitle[step]}
            {runEntry ? (
              <span className="font-normal text-muted-foreground" data-testid="run-entry-label">
                — {runEntry.label ?? resolved?.featureBranch}
              </span>
            ) : (
              isConnectionFlow &&
              resolved?.projectName && (
                <span className="font-normal text-muted-foreground">— {resolved.projectName}</span>
              )
            )}
            {isConnectionFlow && remainingCount > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                ({remainingCount} more {runEntry ? 'branch' : 'project'}
                {remainingCount !== 1 ? (runEntry ? 'es' : 's') : ''})
              </span>
            )}
          </DialogTitle>
          {inspecting && view && (
            <DialogDescription className="text-xs">
              {step === 'merge' && (
                <>
                  Merge <code className="bg-muted px-1 rounded">{view.featureBranch}</code> into{' '}
                  <code className="bg-muted px-1 rounded">{view.baseBranch}</code>
                </>
              )}
              {step === 'commit' && (
                <>
                  Commit the changes on{' '}
                  <code className="bg-muted px-1 rounded">{view.featureBranch}</code> before
                  merging into <code className="bg-muted px-1 rounded">{view.baseBranch}</code>
                </>
              )}
              {step === 'commit_base' && (
                <>
                  <code className="bg-muted px-1 rounded">{view.baseBranch}</code> has
                  uncommitted changes. Commit them before merging{' '}
                  <code className="bg-muted px-1 rounded">{view.featureBranch}</code>
                </>
              )}
              {resolved?.members && resolved.members.length > 1 && (
                <>
                  {' '}
                  in {view.projectName} — one merge lands every member of the instance (
                  {resolved.members.map((m) => m.projectName).join(', ')})
                </>
              )}
            </DialogDescription>
          )}
        </DialogHeader>

        {/* Connection project: the instance's members; a chip switches the file list to it */}
        {inspecting && resolved?.members && resolved.members.length > 1 && (
          <div className="flex shrink-0 flex-wrap gap-1" data-testid="run-child-members">
            {resolved.members.map((member, index) => (
              <button
                key={member.worktreeId}
                type="button"
                onClick={() => setMemberIndex(index)}
                data-testid={`run-child-member-${member.projectId}`}
                aria-pressed={index === memberIndex}
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                  index === memberIndex
                    ? 'border-foreground/40 bg-muted text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {member.projectName} · {member.branchStats.commitsAhead} commit
                {member.branchStats.commitsAhead !== 1 ? 's' : ''}
                {member.dirty ? ' · uncommitted' : ''}
              </button>
            ))}
          </div>
        )}

        {step === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking branch status...
          </div>
        )}

        {inspecting && resolved && (
          <>
            {step === 'merge' ? (
              <ChangedFilesSummary
                files={changed.files}
                fallback={branchTotals}
                fileLabel={(n) => `${n} file${n === 1 ? '' : 's'} changed`}
              >
                <SummaryChip testId="merge-summary-commits">
                  <GitCommit className="h-3 w-3" />
                  {(view ?? resolved).branchStats.commitsAhead} commit
                  {(view ?? resolved).branchStats.commitsAhead !== 1 ? 's' : ''} ahead
                </SummaryChip>
              </ChangedFilesSummary>
            ) : (
              <ChangedFilesSummary
                files={changed.files}
                fileLabel={(n) => `${n} uncommitted file${n === 1 ? '' : 's'}`}
              />
            )}

            {step !== 'commit_base' && resolved.carriedRunTickets.length > 0 && (
              <p
                className="flex shrink-0 items-start gap-1.5 text-xs text-amber-500"
                data-testid="merge-carried-run-tickets"
              >
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>
                  This branch was cut from its {runNoun}, so the merge also brings{' '}
                  {resolved.carriedRunTickets.join(', ')} into {resolved.baseBranch}, ahead of
                  the run&rsquo;s own ticket.
                </span>
              </p>
            )}

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60 bg-muted/10">
              <ChangedFilesPanel
                // Remount per step, queue member and instance member so navigation starts fresh
                key={`${step}:${pendingDoneMove?.ticketId ?? ''}:${pendingDoneMove?.worktreeId ?? ''}:${focusedMember?.worktreeId ?? ''}`}
                ref={panelRef}
                source={changedSource}
                files={changed.files}
                loading={changed.loading}
                error={changed.error}
                emptyState={emptyState}
                onRetry={changed.reload}
              />
            </div>

            {step === 'commit_base' && (
              <Input
                value={baseCommitMessage}
                onChange={(e) => setBaseCommitMessage(e.target.value)}
                placeholder="Commit message for base branch"
                className="shrink-0"
              />
            )}
            {step === 'commit' && (
              <Input
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Commit message"
                className="shrink-0"
              />
            )}

            <div className="flex shrink-0 items-center justify-between">
              <button
                onClick={() => clearPendingDoneMove()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Keep in Review
              </button>
              <div className="flex items-center gap-2">
                {/* A run batch has no "anyway": a ticket branch can be skipped (kept as it
                    is, its ticket stays with it), the integration branch only merged */}
                {runEntry ? (
                  isRunChild && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void skipDoneMoveEntry(pendingIdentity, 'skipped')}
                      disabled={primaryAction.busy}
                      data-testid="skip-run-branch"
                    >
                      Skip this branch
                    </Button>
                  )
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => completeDoneMove(pendingIdentity)}
                    disabled={primaryAction.busy}
                  >
                    Move to {targetLabel} anyway
                  </Button>
                )}
                <Button size="sm" onClick={primaryAction.onClick} disabled={primaryAction.disabled}>
                  {primaryAction.busy ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <primaryAction.Icon className="h-3 w-3 mr-1" />
                  )}
                  {primaryAction.label}
                </Button>
              </div>
            </div>
          </>
        )}

        {step === 'archive' && resolved && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-xs text-muted-foreground">
              {resolved.alreadyMerged ? 'Branch already merged.' : 'Merge successful!'}{' '}
              {resolved.members ? (
                <>
                  Archive the {resolved.members.length} worktree
                  {resolved.members.length !== 1 ? 's' : ''} of{' '}
                  <code className="bg-muted px-1 rounded">{runEntry?.label ?? resolved.featureBranch}</code>{' '}
                  ({resolved.members.map((m) => m.projectName).join(', ')})?
                </>
              ) : (
                <>
                  Archive the <code className="bg-muted px-1 rounded">{resolved.featureBranch}</code>{' '}
                  worktree?
                </>
              )}
            </p>
            {archiveAllCandidates.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="archive-all-hint">
                {pendingDoneMove?.run && archiveAllScope.isConnectionRun ? (
                  archiveAllScope.instances > 1 ? (
                    <>
                      The{' '}
                      {archiveAllScope.instances - 1 === 1
                        ? 'other instance'
                        : `other ${archiveAllScope.instances - 1} instances`}{' '}
                      of this {runNoun} {archiveAllScope.instances - 1 === 1 ? 'is' : 'are'}{' '}
                      merged too ({archiveAllScope.worktrees} worktree
                      {archiveAllScope.worktrees !== 1 ? 's' : ''} across{' '}
                      {archiveAllScope.repositories} repositor
                      {archiveAllScope.repositories !== 1 ? 'ies' : 'y'} in all). Archive all
                      archives all of them and moves their tickets to {targetLabel}.
                    </>
                  ) : (
                    <>
                      The other {archiveAllCandidates.length === 1 ? 'worktree' : `${archiveAllCandidates.length} worktrees`}{' '}
                      of this instance {archiveAllCandidates.length === 1 ? 'is' : 'are'} merged too.
                      Archive all archives {archiveAllCandidates.length === 1 ? 'both' : 'all of them'}.
                    </>
                  )
                ) : pendingDoneMove?.run ? (
                  <>
                    The{' '}
                    {archiveAllCandidates.length === 1
                      ? 'other'
                      : `other ${archiveAllCandidates.length}`}{' '}
                    branch{archiveAllCandidates.length !== 1 ? 'es' : ''} of this {runNoun}{' '}
                    {archiveAllCandidates.length === 1 ? 'is' : 'are'} merged too. Archive all
                    archives {archiveAllCandidates.length === 1 ? 'both' : 'all of them'} and
                    moves their tickets to {targetLabel}.
                  </>
                ) : (
                  <>
                    The{' '}
                    {archiveAllCandidates.length === 1
                      ? 'other'
                      : `other ${archiveAllCandidates.length}`}{' '}
                    project{archiveAllCandidates.length !== 1 ? 's' : ''} in this connection{' '}
                    {archiveAllCandidates.length === 1 ? 'is' : 'are'} already merged too. Archive
                    all archives {archiveAllCandidates.length === 1 ? 'both' : 'all of them'} at
                    once.
                  </>
                )}
              </p>
            )}
            {keptEntries.length > 0 && (
              <p
                className="flex items-start gap-1.5 text-xs text-amber-500"
                data-testid="archive-kept-branches"
              >
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>
                  Kept as {keptEntries.length === 1 ? 'it is' : 'they are'}:{' '}
                  {keptEntries.map((k) => `${k.label} (${k.reason})`).join(', ')}.
                </span>
              </p>
            )}
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() => completeDoneMove(pendingIdentity)}
                disabled={archiving || archivingAll}
              >
                Keep
              </Button>
              <div className="flex items-center gap-2">
                {archiveAllCandidates.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleArchiveAll}
                    disabled={archiving || archivingAll}
                  >
                    {archivingAll ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <Archive className="h-3 w-3 mr-1" />
                    )}
                    Archive all
                    {pendingDoneMove?.run ? ` (${archiveAllScope.instances})` : ''}
                  </Button>
                )}
                <Button size="sm" onClick={handleArchive} disabled={archiving || archivingAll}>
                  {archiving ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <Archive className="h-3 w-3 mr-1" />
                  )}
                  Archive
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
