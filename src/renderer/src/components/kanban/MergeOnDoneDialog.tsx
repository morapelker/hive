import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
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
}

export function MergeOnDoneDialog() {
  const pendingDoneMove = useKanbanStore((s) => s.pendingDoneMove)
  const completeDoneMove = useKanbanStore((s) => s.completeDoneMove)
  const continueDoneMoveAfterConflict = useKanbanStore((s) => s.continueDoneMoveAfterConflict)
  const clearPendingDoneMove = useKanbanStore((s) => s.clearPendingDoneMove)

  // Identity passed to completeDoneMove so a stale async completion (e.g. a
  // merge resolving after dismissal) can't act on a replacement pending move
  const pendingIdentity = useMemo(
    () =>
      pendingDoneMove
        ? {
            ticketId: pendingDoneMove.ticketId,
            projectId: pendingDoneMove.projectId,
            worktreeId: pendingDoneMove.worktreeId
          }
        : undefined,
    [pendingDoneMove]
  )

  const [step, setStep] = useState<Step>('loading')
  const [resolved, setResolved] = useState<ResolvedState | null>(null)
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
    switch (step) {
      case 'merge':
        return {
          kind: 'branch',
          worktreePath: resolved.featureWorktreePath,
          baseBranch: resolved.baseBranch
        }
      case 'commit':
        return { kind: 'worktree', worktreePath: resolved.featureWorktreePath }
      case 'commit_base':
        return { kind: 'worktree', worktreePath: resolved.baseWorktreePath }
      default:
        return null
    }
  }, [resolved, step, pendingDoneMove])
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
      setCommittingBase(false)
      setCommitting(false)
      setMerging(false)
      setArchiving(false)
      setArchivingAll(false)

      try {
        // Look up ticket from store
        const tickets = useKanbanStore.getState().getTicketsForProject(pending.projectId)
        const ticket = tickets.find((t) => t.id === pending.ticketId)

        // Connection tickets carry no worktree_id — the drop handler queues
        // each member worktree explicitly via pending.worktreeId
        const mergeWorktreeId = pending.worktreeId ?? ticket?.worktree_id
        if (!ticket || !mergeWorktreeId) {
          clearPendingDoneMove()
          return
        }

        // Fetch feature worktree
        const featureWorktree = await dbApi.worktree.get<MergeWorktree>(mergeWorktreeId)
        if (!featureWorktree || featureWorktree.status !== 'active') {
          // Worktree archived/deleted since the drop — nothing to merge, so
          // complete the move instead of failing the transition
          await completeDoneMove({
            ticketId: pending.ticketId,
            projectId: pending.projectId,
            worktreeId: pending.worktreeId
          })
          return
        }

        // Resolve base branch (connection members may live in another project)
        const activeWorktrees = await dbApi.worktree.getActiveByProject<MergeWorktree>(
          pending.worktreeProjectId ?? pending.projectId
        )
        const defaultWt = activeWorktrees.find((w) => w.is_default)
        const resolvedBaseBranch = featureWorktree.base_branch ?? defaultWt?.branch_name

        if (!resolvedBaseBranch) {
          toast.warning('Skipping merge — no base branch resolved')
          await completeDoneMove({
            ticketId: pending.ticketId,
            projectId: pending.projectId,
            worktreeId: pending.worktreeId
          })
          return
        }

        // Find base worktree
        const baseWorktree = activeWorktrees.find(
          (w) => w.branch_name === resolvedBaseBranch && w.status === 'active'
        )

        if (!baseWorktree) {
          // Base worktree archived/deleted — merge impossible, but the move
          // should still land in the target column
          toast.warning(`Skipping merge — no worktree for ${resolvedBaseBranch}`)
          await completeDoneMove({
            ticketId: pending.ticketId,
            projectId: pending.projectId,
            worktreeId: pending.worktreeId
          })
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

        // Plain-connection members never get the archive prompt — archiving
        // would tear the worktree out of a connection the user still needs.
        // Connection-PROJECT members (offerArchive) fall through to it so the
        // instance's worktrees can be archived like any feature worktree.
        if (pending.worktreeId && alreadyMerged && !pending.offerArchive) {
          await completeDoneMove({
            ticketId: pending.ticketId,
            projectId: pending.projectId,
            worktreeId: pending.worktreeId
          })
          return
        }

        // Get project path for archive step
        const project = await dbApi.project.get<MergeProject>(featureWorktree.project_id)
        const carriedRunTickets = alreadyMerged
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
          ticketTitle: ticket.title,
          projectPath: project?.path ?? baseWorktree.path,
          projectName: project?.name ?? null,
          baseDirty,
          branchStats,
          alreadyMerged,
          carriedRunTickets
        })
        setCommitMessage(ticket.title)
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
  }, [pendingDoneMove, completeDoneMove, clearPendingDoneMove])

  const handleCommit = useCallback(async () => {
    if (!resolved || !commitMessage.trim()) return
    setCommitting(true)
    try {
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
  }, [resolved, commitMessage, pendingIdentity, completeDoneMove, clearPendingDoneMove])

  const handleCommitBase = useCallback(async () => {
    if (!resolved || !baseCommitMessage.trim()) return
    setCommittingBase(true)
    try {
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
  }, [resolved, baseCommitMessage, pendingIdentity, completeDoneMove, clearPendingDoneMove])

  const handleMerge = useCallback(async () => {
    if (!resolved || !pendingDoneMove) return
    setMerging(true)
    try {
      // Last look before landing commits only: anything written since the
      // step opened must be committed first (see the status watcher above)
      if (await gitApi.hasUncommittedChanges(resolved.featureWorktreePath)) {
        toast.warning('New uncommitted changes on the branch — commit them before merging')
        setStep('commit')
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
          if (pendingDoneMove.worktreeId) {
            const where = resolved.projectName ?? resolved.baseBranch
            const hasMore = (pendingDoneMove.remainingWorktrees?.length ?? 0) > 0
            toast.error(
              `${conflictSummary} on ${where}${hasMore ? ' — continuing with the next project' : ''}`
            )
            continueDoneMoveAfterConflict(pendingIdentity)
            return
          }
          toast.error(`${conflictSummary} — merge manually`)
        } else {
          toast.error(`Merge failed: ${mergeResult.error}`)
        }
        clearPendingDoneMove()
        return
      }

      toast.success('Branch merged successfully')
      // Plain-connection members advance the queue instead of offering the
      // destructive archive step; connection-project members get it (see init)
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
    completeDoneMove,
    continueDoneMoveAfterConflict,
    clearPendingDoneMove
  ])

  const handleArchive = useCallback(async () => {
    if (!resolved) return

    const archiveTarget = {
      featureWorktreeId: resolved.featureWorktreeId,
      featureWorktreePath: resolved.featureWorktreePath,
      featureBranch: resolved.featureBranch,
      projectPath: resolved.projectPath
    }

    try {
      setArchiving(true)
      await completeDoneMove(pendingIdentity)
    } catch (err) {
      setArchiving(false)
      toast.error(`Failed to move ticket: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    useWorktreeStore
      .getState()
      .archiveWorktree(
        archiveTarget.featureWorktreeId,
        archiveTarget.featureWorktreePath,
        archiveTarget.featureBranch,
        archiveTarget.projectPath
      )
      .then((result) => {
        if (result.success) {
          toast.success('Worktree archived')
        } else {
          toast.error(`Failed to archive: ${result.error}`)
        }
      })
      .catch((err) => {
        toast.error(`Archive failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }, [resolved, pendingIdentity, completeDoneMove])

  // Connection-project flow: once the members with work to merge are done,
  // the rest of the queue is archive/keep prompts only (the queue builder
  // puts already-merged members last). Offer to archive them all at once
  // instead of one Archive click per project.
  const archiveAllCandidates = useMemo(() => {
    const remaining = pendingDoneMove?.remainingWorktrees ?? []
    if (!pendingDoneMove?.offerArchive || remaining.length === 0) return []
    return remaining.every((w) => w.alreadyMerged) ? remaining : []
  }, [pendingDoneMove])

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
    const targets: ArchiveTarget[] = [
      {
        worktreeId: resolved.featureWorktreeId,
        worktreePath: resolved.featureWorktreePath,
        branch: resolved.featureBranch,
        baseBranch: resolved.baseBranch,
        projectPath: resolved.projectPath
      }
    ]
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

    try {
      await Promise.all(
        archiveAllCandidates.map(async (member) => {
          const worktree = await dbApi.worktree.get<MergeWorktree>(member.worktreeId)
          if (!worktree || worktree.status !== 'active') {
            handled.add(member.worktreeId)
            return
          }
          const activeWorktrees = await dbApi.worktree.getActiveByProject<MergeWorktree>(
            member.projectId
          )
          const baseBranch =
            worktree.base_branch ?? activeWorktrees.find((w) => w.is_default)?.branch_name
          if (!baseBranch) return
          if (!(await isClean(worktree.path, baseBranch))) {
            keptForMerge.push(worktree.branch_name)
            return
          }
          const project = await dbApi.project.get<MergeProject>(worktree.project_id)
          handled.add(member.worktreeId)
          targets.push({
            worktreeId: worktree.id,
            worktreePath: worktree.path,
            branch: worktree.branch_name,
            baseBranch,
            projectPath: project?.path ?? worktree.path
          })
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
    void Promise.all(
      targets.map(async (t) => {
        // Last look right before the destructive step: work that landed in
        // the worktree since its check above (an agent still writing) is kept
        try {
          if (!(await isClean(t.worktreePath, t.baseBranch))) {
            keptForMerge.push(t.branch)
            return null
          }
          const result = await store.archiveWorktree(
            t.worktreeId,
            t.worktreePath,
            t.branch,
            t.projectPath
          )
          return { branch: t.branch, error: result.success ? null : result.error }
        } catch (err) {
          return { branch: t.branch, error: err instanceof Error ? err.message : String(err) }
        }
      })
    ).then((results) => {
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
  }, [resolved, archiveAllCandidates, pendingIdentity, completeDoneMove])

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
    step === 'merge' && resolved
      ? {
          files: resolved.branchStats.filesChanged,
          additions: resolved.branchStats.insertions,
          deletions: resolved.branchStats.deletions
        }
      : null

  const emptyState = resolved ? (
    step === 'merge' ? (
      <>
        <p>
          No file differences against{' '}
          <code className="bg-muted px-1 rounded">{resolved.baseBranch}</code>.
        </p>
        {resolved.branchStats.commitsAhead > 0 && (
          <p className="text-[11px]">
            The branch is {resolved.branchStats.commitsAhead} commit
            {resolved.branchStats.commitsAhead !== 1 ? 's' : ''} ahead, but its content already
            matches <code className="bg-muted px-1 rounded">{resolved.baseBranch}</code>.
          </p>
        )}
      </>
    ) : (
      <p>
        No uncommitted changes found in{' '}
        <code className="bg-muted px-1 rounded">
          {step === 'commit_base' ? resolved.baseBranch : resolved.featureBranch}
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
            {isConnectionFlow && resolved?.projectName && (
              <span className="font-normal text-muted-foreground">— {resolved.projectName}</span>
            )}
            {isConnectionFlow && remainingCount > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                ({remainingCount} more project{remainingCount !== 1 ? 's' : ''})
              </span>
            )}
          </DialogTitle>
          {inspecting && resolved && (
            <DialogDescription className="text-xs">
              {step === 'merge' && (
                <>
                  Merge <code className="bg-muted px-1 rounded">{resolved.featureBranch}</code> into{' '}
                  <code className="bg-muted px-1 rounded">{resolved.baseBranch}</code>
                </>
              )}
              {step === 'commit' && (
                <>
                  Commit the changes on{' '}
                  <code className="bg-muted px-1 rounded">{resolved.featureBranch}</code> before
                  merging into <code className="bg-muted px-1 rounded">{resolved.baseBranch}</code>
                </>
              )}
              {step === 'commit_base' && (
                <>
                  <code className="bg-muted px-1 rounded">{resolved.baseBranch}</code> has
                  uncommitted changes. Commit them before merging{' '}
                  <code className="bg-muted px-1 rounded">{resolved.featureBranch}</code>
                </>
              )}
            </DialogDescription>
          )}
        </DialogHeader>

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
                  {resolved.branchStats.commitsAhead} commit
                  {resolved.branchStats.commitsAhead !== 1 ? 's' : ''} ahead
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
                  This branch was cut from its document run, so the merge also brings{' '}
                  {resolved.carriedRunTickets.join(', ')} into {resolved.baseBranch}, ahead of
                  the run&rsquo;s own ticket.
                </span>
              </p>
            )}

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60 bg-muted/10">
              <ChangedFilesPanel
                // Remount per step and queue member so navigation starts fresh
                key={`${step}:${pendingDoneMove?.ticketId ?? ''}:${pendingDoneMove?.worktreeId ?? ''}`}
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => completeDoneMove(pendingIdentity)}
                  disabled={primaryAction.busy}
                >
                  Move to {targetLabel} anyway
                </Button>
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
              {resolved.alreadyMerged ? 'Branch already merged.' : 'Merge successful!'} Archive the{' '}
              <code className="bg-muted px-1 rounded">{resolved.featureBranch}</code> worktree?
            </p>
            {archiveAllCandidates.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="archive-all-hint">
                The{' '}
                {archiveAllCandidates.length === 1
                  ? 'other'
                  : `other ${archiveAllCandidates.length}`}{' '}
                project{archiveAllCandidates.length !== 1 ? 's' : ''} in this connection{' '}
                {archiveAllCandidates.length === 1 ? 'is' : 'are'} already merged too. Archive all
                archives {archiveAllCandidates.length === 1 ? 'both' : 'all of them'} at once.
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
