import { useState, useEffect, useCallback } from 'react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { Loader2, GitMerge, GitCommit, Archive } from 'lucide-react'

type Step = 'loading' | 'commit_base' | 'commit' | 'merge' | 'archive'

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
  baseWorktreePath: string
  baseBranch: string
  ticketTitle: string
  projectPath: string
  uncommittedStats: { filesChanged: number; insertions: number; deletions: number }
  baseUncommittedStats: { filesChanged: number; insertions: number; deletions: number }
  baseDirty: boolean
  branchStats: BranchStats
}

export function MergeOnDoneDialog() {
  const pendingDoneMove = useKanbanStore((s) => s.pendingDoneMove)
  const completeDoneMove = useKanbanStore((s) => s.completeDoneMove)

  const [step, setStep] = useState<Step>('loading')
  const [resolved, setResolved] = useState<ResolvedState | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [baseCommitMessage, setBaseCommitMessage] = useState('')
  const [committingBase, setCommittingBase] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [archiving, setArchiving] = useState(false)

  // Initialize when pendingDoneMove changes
  useEffect(() => {
    if (!pendingDoneMove) return

    let cancelled = false
    const pending = pendingDoneMove

    const init = async () => {
      setStep('loading')
      setResolved(null)

      try {
        // Look up ticket from store
        const tickets = useKanbanStore.getState().getTicketsForProject(pending.projectId)
        const ticket = tickets.find((t) => t.id === pending.ticketId)

        if (!ticket || !ticket.worktree_id) {
          await completeDoneMove()
          return
        }

        // Fetch feature worktree
        const featureWorktree = await window.db.worktree.get(ticket.worktree_id)
        if (!featureWorktree || featureWorktree.status !== 'active') {
          await completeDoneMove()
          return
        }

        // Resolve base branch
        const activeWorktrees = await window.db.worktree.getActiveByProject(pending.projectId)
        const defaultWt = activeWorktrees.find((w) => w.is_default)
        const resolvedBaseBranch = featureWorktree.base_branch ?? defaultWt?.branch_name

        if (!resolvedBaseBranch) {
          toast.warning('Cannot merge — no base branch resolved')
          await completeDoneMove()
          return
        }

        // Find base worktree
        const baseWorktree = activeWorktrees.find(
          (w) => w.branch_name === resolvedBaseBranch && w.status === 'active'
        )

        if (!baseWorktree) {
          toast.warning(`Cannot merge — no worktree for ${resolvedBaseBranch}`)
          await completeDoneMove()
          return
        }

        // Check both worktrees for dirty state in parallel
        const [baseDirty, hasUncommitted, branchStatResult] = await Promise.all([
          window.gitOps.hasUncommittedChanges(baseWorktree.path),
          window.gitOps.hasUncommittedChanges(featureWorktree.path),
          window.gitOps.branchDiffShortStat(featureWorktree.path, resolvedBaseBranch)
        ])

        if (cancelled) return

        // Get uncommitted diff stats for both worktrees if needed
        const [featureDiffResult, baseDiffResult] = await Promise.all([
          hasUncommitted
            ? window.gitOps.getDiffStat(featureWorktree.path)
            : Promise.resolve(null),
          baseDirty
            ? window.gitOps.getDiffStat(baseWorktree.path)
            : Promise.resolve(null)
        ])

        let uncommittedStats = { filesChanged: 0, insertions: 0, deletions: 0 }
        if (featureDiffResult?.success && featureDiffResult.files) {
          uncommittedStats = {
            filesChanged: featureDiffResult.files.length,
            insertions: featureDiffResult.files.reduce((sum, f) => sum + f.additions, 0),
            deletions: featureDiffResult.files.reduce((sum, f) => sum + f.deletions, 0)
          }
        }

        let baseUncommittedStats = { filesChanged: 0, insertions: 0, deletions: 0 }
        if (baseDiffResult?.success && baseDiffResult.files) {
          baseUncommittedStats = {
            filesChanged: baseDiffResult.files.length,
            insertions: baseDiffResult.files.reduce((sum, f) => sum + f.additions, 0),
            deletions: baseDiffResult.files.reduce((sum, f) => sum + f.deletions, 0)
          }
        }

        if (cancelled) return

        const branchStats: BranchStats = branchStatResult.success
          ? {
              filesChanged: branchStatResult.filesChanged,
              insertions: branchStatResult.insertions,
              deletions: branchStatResult.deletions,
              commitsAhead: branchStatResult.commitsAhead
            }
          : { filesChanged: 0, insertions: 0, deletions: 0, commitsAhead: 0 }

        // If no diffs at all, just move to done
        if (!hasUncommitted && branchStats.commitsAhead === 0) {
          await completeDoneMove()
          return
        }

        // Get project path for archive step
        const project = await window.db.project.get(featureWorktree.project_id)
        if (cancelled) return

        setResolved({
          featureWorktreeId: featureWorktree.id,
          featureWorktreePath: featureWorktree.path,
          featureBranch: featureWorktree.branch_name,
          baseWorktreePath: baseWorktree.path,
          baseBranch: resolvedBaseBranch,
          ticketTitle: ticket.title,
          projectPath: project?.path ?? baseWorktree.path,
          uncommittedStats,
          baseUncommittedStats,
          baseDirty,
          branchStats
        })
        setCommitMessage(ticket.title)
        setBaseCommitMessage('')
        setStep(baseDirty ? 'commit_base' : hasUncommitted ? 'commit' : 'merge')
      } catch (err) {
        if (!cancelled) {
          toast.error(`Failed to check branch: ${err instanceof Error ? err.message : String(err)}`)
          await completeDoneMove()
        }
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [pendingDoneMove, completeDoneMove])

  const handleCommit = useCallback(async () => {
    if (!resolved || !commitMessage.trim()) return
    setCommitting(true)
    try {
      const stageResult = await window.gitOps.stageAll(resolved.featureWorktreePath)
      if (!stageResult.success) {
        toast.error(`Failed to stage: ${stageResult.error}`)
        return
      }

      const commitResult = await window.gitOps.commit(
        resolved.featureWorktreePath,
        commitMessage.trim()
      )
      if (!commitResult.success) {
        toast.error(`Failed to commit: ${commitResult.error}`)
        return
      }

      toast.success('Changes committed')

      // Re-check branch divergence after commit
      const statResult = await window.gitOps.branchDiffShortStat(
        resolved.featureWorktreePath,
        resolved.baseBranch
      )

      if (statResult.success && statResult.commitsAhead > 0) {
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
        await completeDoneMove()
      }
    } catch (err) {
      toast.error(`Commit failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCommitting(false)
    }
  }, [resolved, commitMessage, completeDoneMove])

  const handleCommitBase = useCallback(async () => {
    if (!resolved || !baseCommitMessage.trim()) return
    setCommittingBase(true)
    try {
      const stageResult = await window.gitOps.stageAll(resolved.baseWorktreePath)
      if (!stageResult.success) {
        toast.error(`Failed to stage on ${resolved.baseBranch}: ${stageResult.error}`)
        return
      }

      const commitResult = await window.gitOps.commit(
        resolved.baseWorktreePath,
        baseCommitMessage.trim()
      )
      if (!commitResult.success) {
        toast.error(`Failed to commit on ${resolved.baseBranch}: ${commitResult.error}`)
        return
      }

      toast.success(`Changes committed on ${resolved.baseBranch}`)

      // Check if feature branch still has uncommitted changes
      const featureHasUncommitted = await window.gitOps.hasUncommittedChanges(
        resolved.featureWorktreePath
      )

      if (featureHasUncommitted) {
        setStep('commit')
      } else {
        // Re-check branch divergence
        const statResult = await window.gitOps.branchDiffShortStat(
          resolved.featureWorktreePath,
          resolved.baseBranch
        )
        if (statResult.success && statResult.commitsAhead > 0) {
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
          await completeDoneMove()
        }
      }
    } catch (err) {
      toast.error(`Commit failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCommittingBase(false)
    }
  }, [resolved, baseCommitMessage, completeDoneMove])

  const handleMerge = useCallback(async () => {
    if (!resolved) return
    setMerging(true)
    try {
      // Pull latest on base branch first (only if remote exists)
      const remoteResult = await window.gitOps.getRemoteUrl(resolved.baseWorktreePath)
      if (remoteResult.url) {
        const pullResult = await window.gitOps.pull(resolved.baseWorktreePath)
        if (!pullResult.success) {
          toast.warning(`Pull failed on ${resolved.baseBranch} — continuing with local merge`)
        }
      }

      // Merge feature into base
      const mergeResult = await window.gitOps.merge(
        resolved.baseWorktreePath,
        resolved.featureBranch
      )

      if (!mergeResult.success) {
        // Conflicts or error — abort and let user handle manually
        if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
          await window.gitOps.mergeAbort(resolved.baseWorktreePath)
          toast.error(
            `Merge conflicts in ${mergeResult.conflicts.length} file${mergeResult.conflicts.length !== 1 ? 's' : ''} — merge manually`
          )
        } else {
          toast.error(`Merge failed: ${mergeResult.error}`)
        }
        await completeDoneMove()
        return
      }

      toast.success('Branch merged successfully')
      setStep('archive')
    } catch (err) {
      toast.error(`Merge failed: ${err instanceof Error ? err.message : String(err)}`)
      await completeDoneMove()
    } finally {
      setMerging(false)
    }
  }, [resolved, completeDoneMove])

  const handleArchive = useCallback(async () => {
    if (!resolved) return
    setArchiving(true)
    try {
      const result = await useWorktreeStore.getState().archiveWorktree(
        resolved.featureWorktreeId,
        resolved.featureWorktreePath,
        resolved.featureBranch,
        resolved.projectPath
      )

      if (result.success) {
        toast.success('Worktree archived')
      } else {
        toast.error(`Failed to archive: ${result.error}`)
      }
    } catch (err) {
      toast.error(`Archive failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setArchiving(false)
      await completeDoneMove()
    }
  }, [resolved, completeDoneMove])

  const stepTitle: Record<Step, string> = {
    loading: 'Moving to Done...',
    commit_base: 'Uncommitted changes on base',
    commit: 'Uncommitted changes',
    merge: 'Merge branch',
    archive: 'Archive worktree'
  }

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
        if (!open) completeDoneMove()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            {stepIcon[step]}
            {stepTitle[step]}
          </DialogTitle>
        </DialogHeader>

        {step === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking branch status...
          </div>
        )}

        {step === 'commit_base' && resolved && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-xs text-muted-foreground">
              <code className="bg-muted px-1 rounded">{resolved.baseBranch}</code> has uncommitted
              changes:{' '}
              {resolved.baseUncommittedStats.filesChanged} files changed,{' '}
              <span className="text-green-500">+{resolved.baseUncommittedStats.insertions}</span>{' '}
              <span className="text-red-500">-{resolved.baseUncommittedStats.deletions}</span>
            </p>
            <Input
              value={baseCommitMessage}
              onChange={(e) => setBaseCommitMessage(e.target.value)}
              placeholder="Commit message for base branch"
            />
            <div className="flex items-center justify-between">
              <button
                onClick={() => completeDoneMove()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Skip, just move to Done
              </button>
              <Button
                size="sm"
                onClick={handleCommitBase}
                disabled={!baseCommitMessage.trim() || committingBase}
              >
                {committingBase ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <GitCommit className="h-3 w-3 mr-1" />
                )}
                Commit
              </Button>
            </div>
          </div>
        )}

        {step === 'commit' && resolved && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-xs text-muted-foreground">
              {resolved.uncommittedStats.filesChanged} files changed,{' '}
              <span className="text-green-500">+{resolved.uncommittedStats.insertions}</span>{' '}
              <span className="text-red-500">-{resolved.uncommittedStats.deletions}</span>
            </p>
            <Input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message"
            />
            <div className="flex items-center justify-between">
              <button
                onClick={() => completeDoneMove()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Skip, just move to Done
              </button>
              <Button
                size="sm"
                onClick={handleCommit}
                disabled={!commitMessage.trim() || committing}
              >
                {committing ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <GitCommit className="h-3 w-3 mr-1" />
                )}
                Commit
              </Button>
            </div>
          </div>
        )}

        {step === 'merge' && resolved && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-xs text-muted-foreground">
              Merge <code className="bg-muted px-1 rounded">{resolved.featureBranch}</code> into{' '}
              <code className="bg-muted px-1 rounded">{resolved.baseBranch}</code>
            </p>
            <p className="text-xs text-muted-foreground">
              {resolved.branchStats.filesChanged} files changed,
              <span className="text-green-500"> +{resolved.branchStats.insertions}</span>
              <span className="text-red-500"> -{resolved.branchStats.deletions}</span>,{' '}
              {resolved.branchStats.commitsAhead} commit
              {resolved.branchStats.commitsAhead !== 1 ? 's' : ''} ahead
            </p>
            <div className="flex items-center justify-between">
              <button
                onClick={() => completeDoneMove()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Skip, just move to Done
              </button>
              <Button size="sm" onClick={handleMerge} disabled={merging}>
                {merging ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <GitMerge className="h-3 w-3 mr-1" />
                )}
                Merge
              </Button>
            </div>
          </div>
        )}

        {step === 'archive' && resolved && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-xs text-muted-foreground">
              Merge successful! Archive the{' '}
              <code className="bg-muted px-1 rounded">{resolved.featureBranch}</code> worktree?
            </p>
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={() => completeDoneMove()}>
                Keep
              </Button>
              <Button size="sm" onClick={handleArchive} disabled={archiving}>
                {archiving ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Archive className="h-3 w-3 mr-1" />
                )}
                Archive
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
