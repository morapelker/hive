import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  GitPullRequest,
  GitBranch,
  Check,
  Loader2,
  AlertCircle,
  ChevronDown,
  Plus
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { useGitStore, type GitFileStatus } from '@/stores/useGitStore'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ModalPhase = 'commit' | 'form'

interface CreatePRModalProps {
  worktreeId: string
  worktreePath: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreatePRModal({
  worktreeId,
  worktreePath
}: CreatePRModalProps): React.JSX.Element {
  const open = useGitStore((s) => s.createPRModalOpen)
  const setOpen = useGitStore((s) => s.setCreatePRModalOpen)
  const branchInfo = useGitStore((s) =>
    worktreePath ? (s.branchInfoByWorktree.get(worktreePath) ?? null) : null
  )
  const prTargetBranch = useGitStore((s) =>
    worktreeId ? s.prTargetBranch.get(worktreeId) : undefined
  )
  const attachPR = useGitStore((s) => s.attachPR)
  const setCreatingPR = useGitStore((s) => s.setCreatingPR)
  const fileStatusesByWorktree = useGitStore((s) => s.fileStatusesByWorktree)
  const isCommitting = useGitStore((s) => s.isCommitting)
  const loadFileStatuses = useGitStore((s) => s.loadFileStatuses)
  const stageAll = useGitStore((s) => s.stageAll)
  const gitCommit = useGitStore((s) => s.commit)
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk) ?? 'claude-code'

  // ── Session titles for commit message pre-fill ──────────────────
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const sessionTitles: string[] = useMemo(() => {
    if (!worktreePath) return []
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.path === worktreePath)
      if (wt?.session_titles) {
        try {
          return JSON.parse(wt.session_titles)
        } catch {
          return []
        }
      }
    }
    return []
  }, [worktreePath, worktreesByProject])

  // ── Form state ──────────────────────────────────────────────────
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false)
  const [remoteBranches, setRemoteBranches] = useState<
    { name: string; isRemote: boolean }[]
  >([])
  const [commitCount, setCommitCount] = useState<number | null>(null)
  const [loadingBranches, setLoadingBranches] = useState(false)

  // ── Phase state ─────────────────────────────────────────────────
  const [phase, setPhase] = useState<ModalPhase>('form')

  // ── Commit phase state ───────────────────────────────────────
  const [commitSummary, setCommitSummary] = useState('')
  const [commitDescription, setCommitDescription] = useState('')
  const [commitError, setCommitError] = useState('')
  const [isStaging, setIsStaging] = useState(false)

  // ── Derived: file status for commit phase ───────────────────
  const { uncommittedFiles, stagedCount } = useMemo(() => {
    const files = worktreePath ? fileStatusesByWorktree.get(worktreePath) || [] : []
    return {
      uncommittedFiles: files,
      stagedCount: files.filter((f) => f.staged).length
    }
  }, [worktreePath, fileStatusesByWorktree])

  // ── Reset on open ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return

    // Reset all state
    setTitle('')
    setBody('')
    setPhase('form')
    setCommitCount(null)
    // Pre-fill commit message from session titles (same as GitCommitForm)
    setCommitSummary(sessionTitles[0] ?? '')
    setCommitDescription(
      sessionTitles.length > 1
        ? sessionTitles.map((t) => `- ${t}`).join('\n')
        : ''
    )
    setCommitError('')
    setIsStaging(false)

    // Pre-fill base branch from store
    setBaseBranch(prTargetBranch ?? 'main')

    // Fetch remote branches
    setLoadingBranches(true)
    window.gitOps
      .listBranchesWithStatus(worktreePath)
      .then((result) => {
        if (result.success) {
          setRemoteBranches(result.branches.filter((b) => b.isRemote))
        }
      })
      .catch(() => {
        // Non-critical
      })
      .finally(() => setLoadingBranches(false))

    // Check for uncommitted changes — show commit phase if any
    Promise.all([
      window.gitOps.hasUncommittedChanges(worktreePath),
      loadFileStatuses(worktreePath)
    ])
      .then(([hasUncommitted]) => {
        if (hasUncommitted) setPhase('commit')
      })
      .catch(() => {
        // Non-critical — fall through to form phase
      })
  }, [open, worktreePath, prTargetBranch, loadFileStatuses, sessionTitles])

  // ── Refresh commit count when base branch changes ───────────────
  useEffect(() => {
    if (!open || !baseBranch) return
    setCommitCount(null)
    window.gitOps
      .getRangeDiff(worktreePath, baseBranch)
      .then((rd) => setCommitCount(rd.commitCount))
      .catch(() => {
        // Non-critical
      })
  }, [open, worktreePath, baseBranch])

  // ── Derived: clean branch names for dropdown ────────────────────
  const branchOptions = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const b of remoteBranches) {
      // Strip origin/ prefix for display
      const name = b.name.replace(/^origin\//, '')
      if (!seen.has(name)) {
        seen.add(name)
        result.push(name)
      }
    }
    // Ensure current baseBranch is in the list
    if (baseBranch && !result.includes(baseBranch)) {
      result.unshift(baseBranch)
    }
    return result.sort()
  }, [remoteBranches, baseBranch])

  // ── Commit phase handlers ────────────────────────────────────
  const handleStageAll = useCallback(async () => {
    setIsStaging(true)
    try {
      const success = await stageAll(worktreePath)
      if (success) {
        await loadFileStatuses(worktreePath)
      } else {
        toast.error('Failed to stage files')
      }
    } finally {
      setIsStaging(false)
    }
  }, [worktreePath, stageAll, loadFileStatuses])

  const handleToggleFile = useCallback(
    async (file: GitFileStatus) => {
      if (file.staged) {
        await useGitStore.getState().unstageFile(worktreePath, file.relativePath)
      } else {
        await useGitStore.getState().stageFile(worktreePath, file.relativePath)
      }
      await loadFileStatuses(worktreePath)
    },
    [worktreePath, loadFileStatuses]
  )

  const handleCommitAndContinue = useCallback(async () => {
    if (!commitSummary.trim()) return
    setCommitError('')

    const message = commitDescription.trim()
      ? `${commitSummary.trim()}\n\n${commitDescription.trim()}`
      : commitSummary.trim()

    const result = await gitCommit(worktreePath, message)

    if (result.success) {
      toast.success('Changes committed', {
        description: result.commitHash
          ? `Commit: ${result.commitHash.slice(0, 7)}`
          : undefined
      })
      // Refresh commit count and branch info after committing
      if (baseBranch) {
        window.gitOps
          .getRangeDiff(worktreePath, baseBranch)
          .then((rd) => setCommitCount(rd.commitCount))
          .catch(() => {})
      }
      useGitStore.getState().loadBranchInfo(worktreePath)
      setPhase('form')
    } else {
      setCommitError(result.error ?? 'Commit failed')
    }
  }, [worktreePath, commitSummary, commitDescription, gitCommit, baseBranch])

  const handleSkipCommit = useCallback(() => {
    setPhase('form')
  }, [])

  // ── Create PR flow (background — closes modal immediately) ─────
  const handleCreate = useCallback(async () => {
    if (!baseBranch) return

    // Capture form values before closing
    const targetBase = baseBranch
    const prTitle = title.trim()
    const prBody = body.trim()
    const branchName = branchInfo?.name ?? 'Pull Request'
    const provider = defaultAgentSdk

    // Close modal — PR creation continues in background via notification
    setOpen(false)
    setCreatingPR(worktreeId, true)

    const { show, update } = usePRNotificationStore.getState()
    const notifId = show({
      status: 'loading',
      message: 'Creating pull request...'
    })

    let finalTitle = prTitle
    let finalBody = prBody

    try {
      // Step 1: Push if needed
      let willPush = false
      try {
        willPush = await window.gitOps.needsPush(worktreePath)
      } catch {
        // Assume no push needed
      }

      if (willPush) {
        update(notifId, { message: 'Pushing branch...' })
        const pushResult = await window.gitOps.push(worktreePath)
        if (!pushResult.success) {
          throw new Error(pushResult.error ?? 'Push failed')
        }
      }

      // Step 2: Generate content if needed (best-effort — failure should not block PR creation)
      const needsGenerate = !finalTitle || !finalBody
      let usedFallbackContent = false
      if (needsGenerate) {
        update(notifId, { message: 'Generating PR content...' })
        try {
          const genResult = await window.gitOps.generatePRContent(
            worktreePath,
            targetBase,
            provider
          )
          if (genResult.success) {
            if (!finalTitle && genResult.title) finalTitle = genResult.title
            if (!finalBody && genResult.body) finalBody = genResult.body
          } else {
            console.warn('PR content generation failed, using fallback:', genResult.error)
            usedFallbackContent = true
          }
        } catch (err) {
          console.warn('PR content generation threw, using fallback:', err)
          usedFallbackContent = true
        }
        // Fallback if generation failed or returned empty
        if (!finalTitle) finalTitle = branchName
        if (!finalBody) finalBody = ''
      }

      // Step 3: Create PR
      update(notifId, { message: 'Creating pull request...' })
      const createResult = await window.gitOps.createPR(
        worktreePath,
        targetBase,
        finalTitle,
        finalBody
      )

      if (!createResult.success) {
        // Check for "already exists" pattern
        const errMsg = createResult.error ?? 'PR creation failed'
        const alreadyExistsMatch = errMsg.match(
          /already exists.*?(\d+)|pull request.*?#(\d+).*?already/i
        )
        if (alreadyExistsMatch) {
          const existingNumber = parseInt(alreadyExistsMatch[1] || alreadyExistsMatch[2], 10)
          if (existingNumber) {
            const urlMatch = errMsg.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)
            const existingUrl =
              urlMatch?.[0] ?? `https://github.com/unknown/pull/${existingNumber}`

            // Auto-attach the existing PR
            await attachPR(worktreeId, existingNumber, existingUrl)

            update(notifId, {
              status: 'info',
              message: `PR #${existingNumber} already exists`,
              description: 'Attached to workspace',
              prUrl: existingUrl,
              prNumber: existingNumber
            })
            return
          }
        }

        throw new Error(errMsg)
      }

      // Attach the new PR
      const prUrl = createResult.url ?? ''
      const prNumber = createResult.number ?? 0
      await attachPR(worktreeId, prNumber, prUrl)

      update(notifId, {
        status: usedFallbackContent ? 'warning' : 'success',
        message: usedFallbackContent
          ? `PR #${prNumber} created with default content`
          : `Pull request #${prNumber} created`,
        description: usedFallbackContent
          ? 'AI content generation failed — you may want to edit the title and description'
          : undefined,
        prUrl,
        prNumber
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      update(notifId, {
        status: 'error',
        message: 'Failed to create pull request',
        description: msg
      })
    } finally {
      setCreatingPR(worktreeId, false)
    }
  }, [
    worktreePath,
    worktreeId,
    baseBranch,
    title,
    body,
    defaultAgentSdk,
    branchInfo,
    attachPR,
    setOpen,
    setCreatingPR
  ])

  // ── Cancel handler ──────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    setOpen(false)
  }, [setOpen])

  // ── Render: Commit ──────────────────────────────────────────────
  const renderCommit = (): React.JSX.Element => (
    <>
      {/* Info text */}
      <p className="text-sm text-muted-foreground">
        You have uncommitted changes. Commit them before creating a pull request,
        or skip to create a PR with what&apos;s already committed.
      </p>

      {/* File list */}
      <div className="border rounded-md overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b">
          <span className="text-xs font-medium text-muted-foreground">
            Changed files ({uncommittedFiles.length})
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={handleStageAll}
            disabled={isStaging || isCommitting}
          >
            {isStaging ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Plus className="h-3 w-3 mr-1" />
            )}
            Stage All
          </Button>
        </div>
        <div className="max-h-[160px] overflow-y-auto">
          {uncommittedFiles.map((file) => (
            <div
              key={file.relativePath}
              className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent/30"
            >
              <Checkbox
                checked={file.staged}
                onCheckedChange={() => handleToggleFile(file)}
                className="h-3.5 w-3.5"
              />
              <span
                className={cn(
                  'font-mono w-3 text-center shrink-0',
                  file.status === 'M' && 'text-yellow-500',
                  file.status === 'A' && 'text-green-500',
                  file.status === 'D' && 'text-red-500',
                  file.status === '?' && 'text-muted-foreground'
                )}
              >
                {file.status}
              </span>
              <span className="truncate">{file.relativePath}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Commit message */}
      <div className="space-y-2">
        <div className="relative">
          <Input
            value={commitSummary}
            onChange={(e) => setCommitSummary(e.target.value)}
            placeholder="Commit summary"
            className={cn(
              'pr-12',
              commitSummary.length > 72 &&
                'border-red-500 focus-visible:ring-red-500',
              commitSummary.length > 50 &&
                commitSummary.length <= 72 &&
                'border-yellow-500 focus-visible:ring-yellow-500'
            )}
            disabled={isCommitting}
          />
          <span
            className={cn(
              'absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono',
              commitSummary.length > 72 && 'text-red-500',
              commitSummary.length > 50 &&
                commitSummary.length <= 72 &&
                'text-yellow-500',
              commitSummary.length <= 50 && 'text-muted-foreground'
            )}
          >
            {commitSummary.length}/72
          </span>
        </div>
        <Textarea
          value={commitDescription}
          onChange={(e) => setCommitDescription(e.target.value)}
          placeholder="Extended description (optional)"
          rows={2}
          disabled={isCommitting}
        />
      </div>

      {/* Error */}
      {commitError && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{commitError}</span>
        </div>
      )}

      {/* Staged count */}
      {stagedCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {stagedCount} file{stagedCount !== 1 ? 's' : ''} staged for commit
        </p>
      )}
    </>
  )

  // ── Render: Form ────────────────────────────────────────────────
  const renderForm = (): React.JSX.Element => (
    <>
      {/* Source branch (read-only) */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-foreground">Source branch</label>
        <div className="flex items-center gap-2 px-3 py-2 text-sm border rounded-md bg-muted/50 min-w-0">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{branchInfo?.name ?? 'Unknown'}</span>
          {commitCount !== null && (
            <span className="ml-auto text-xs text-muted-foreground shrink-0">
              {commitCount} commit{commitCount !== 1 ? 's' : ''} ahead
            </span>
          )}
        </div>
      </div>

      {/* Base branch dropdown */}
      <div className="space-y-1.5">
        <label htmlFor="pr-base-branch" className="text-sm font-medium text-foreground">Base branch</label>
        <Popover open={branchDropdownOpen} onOpenChange={setBranchDropdownOpen}>
          <PopoverTrigger asChild>
            <button
              id="pr-base-branch"
              type="button"
              className={cn(
                'flex items-center justify-between w-full px-3 py-2 text-sm border rounded-md',
                'bg-background hover:bg-accent/50 transition-colors text-left'
              )}
            >
              <span className="flex items-center gap-2 min-w-0">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{baseBranch || 'Select base branch...'}</span>
              </span>
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 text-muted-foreground transition-transform',
                  branchDropdownOpen && 'rotate-180'
                )}
              />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            {loadingBranches ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : branchOptions.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                No branches found
              </div>
            ) : (
              <div className="max-h-[200px] overflow-y-auto">
                {branchOptions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-2 text-sm text-left',
                      'hover:bg-accent transition-colors',
                      name === baseBranch && 'bg-accent'
                    )}
                    onClick={() => {
                      setBaseBranch(name)
                      setBranchDropdownOpen(false)
                    }}
                  >
                    <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="truncate">{name}</span>
                    {name === baseBranch && (
                      <Check className="h-3 w-3 ml-auto text-primary shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* Title */}
      <div className="space-y-1.5">
        <label htmlFor="pr-title" className="text-sm font-medium text-foreground">Title</label>
        <Input
          id="pr-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Leave empty to auto-generate"
        />
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <label htmlFor="pr-description" className="text-sm font-medium text-foreground">Description</label>
        <Textarea
          id="pr-description"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Leave empty to auto-generate"
          rows={4}
        />
      </div>
    </>
  )

  // ── Render: Footer ──────────────────────────────────────────────
  const renderFooter = (): React.JSX.Element => {
    switch (phase) {
      case 'commit':
        return (
          <DialogFooter>
            <Button variant="ghost" onClick={handleSkipCommit}>
              Skip
            </Button>
            <Button
              onClick={handleCommitAndContinue}
              disabled={!commitSummary.trim() || stagedCount === 0 || isCommitting}
            >
              {isCommitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Committing...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-1.5" />
                  Commit & Continue
                </>
              )}
            </Button>
          </DialogFooter>
        )
      case 'form':
        return (
          <DialogFooter>
            <Button variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!baseBranch}>
              <GitPullRequest className="h-4 w-4 mr-1.5" />
              Create Pull Request
            </Button>
          </DialogFooter>
        )
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <GitPullRequest className="h-5 w-5" />
              Create Pull Request
            </span>
          </DialogTitle>
          {phase === 'commit' && (
            <DialogDescription>
              Commit your changes before creating a pull request.
            </DialogDescription>
          )}
          {phase === 'form' && (
            <DialogDescription>
              Create a new pull request for this workspace.
            </DialogDescription>
          )}
        </DialogHeader>

        {phase === 'commit' && renderCommit()}
        {phase === 'form' && renderForm()}

        {renderFooter()}
      </DialogContent>
    </Dialog>
  )
}
