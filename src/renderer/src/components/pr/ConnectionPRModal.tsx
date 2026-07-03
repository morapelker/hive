import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  GitPullRequest,
  GitBranch,
  Check,
  Loader2,
  AlertCircle,
  ChevronDown,
  Plus,
  Inbox
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
import { resolvePRContentProvider } from '@/lib/pr-content-provider'
import {
  assessConnectionMembers,
  commitConnectionMembers,
  createConnectionPRs,
  emitArchivePrompts,
  isPRWorthy,
  type MemberAssessment
} from '@/lib/connection-pr'
import { useGitStore, type GitFileStatus } from '@/stores/useGitStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { gitApi } from '@/api/git-api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ModalPhase = 'loading' | 'empty' | 'commit' | 'form'

interface ConnectionPRModalProps {
  connectionId: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConnectionPRModal({ connectionId }: ConnectionPRModalProps): React.JSX.Element {
  const open = useGitStore((s) => s.connectionPRModalOpen)
  const setOpen = useGitStore((s) => s.setConnectionPRModalOpen)
  const fileStatusesByWorktree = useGitStore((s) => s.fileStatusesByWorktree)
  const isCommitting = useGitStore((s) => s.isCommitting)
  const loadFileStatuses = useGitStore((s) => s.loadFileStatuses)
  const stageAll = useGitStore((s) => s.stageAll)
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk) ?? 'claude-code'
  const availableAgentSdks = useSettingsStore((s) => s.availableAgentSdks)

  // ── Phase & assessment state ────────────────────────────────────
  const [phase, setPhase] = useState<ModalPhase>('loading')
  const [assessments, setAssessments] = useState<MemberAssessment[]>([])

  // ── Commit phase state ──────────────────────────────────────────
  const [commitSummary, setCommitSummary] = useState('')
  const [commitDescription, setCommitDescription] = useState('')
  const [commitErrors, setCommitErrors] = useState<Map<string, string>>(new Map())
  const [stagingWorktreeId, setStagingWorktreeId] = useState<string | null>(null)

  // ── Form phase state ────────────────────────────────────────────
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [includeByWorktree, setIncludeByWorktree] = useState<Map<string, boolean>>(new Map())
  const [baseBranchByWorktree, setBaseBranchByWorktree] = useState<Map<string, string>>(new Map())
  const [remoteBranchesByWorktree, setRemoteBranchesByWorktree] = useState<Map<string, string[]>>(
    new Map()
  )
  const [openBranchDropdown, setOpenBranchDropdown] = useState<string | null>(null)

  const eligible = useMemo(() => assessments.filter(isPRWorthy), [assessments])
  const ineligible = useMemo(() => assessments.filter((a) => !isPRWorthy(a)), [assessments])

  // ── Shared commit message pre-fill from member session titles ───
  const sessionTitles: string[] = useMemo(() => {
    const memberIds = new Set(
      useConnectionStore
        .getState()
        .connections.find((c) => c.id === connectionId)
        ?.members.map((m) => m.worktree_id) ?? []
    )
    const titles: string[] = []
    for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
      for (const wt of worktrees) {
        if (!memberIds.has(wt.id) || !wt.session_titles) continue
        try {
          for (const t of JSON.parse(wt.session_titles) as string[]) {
            if (!titles.includes(t)) titles.push(t)
          }
        } catch {
          // Ignore malformed session titles
        }
      }
    }
    return titles
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, open])

  // ── Assessment helpers ──────────────────────────────────────────
  const seedSelections = useCallback((results: MemberAssessment[]) => {
    const worthy = results.filter(isPRWorthy)
    setIncludeByWorktree((prev) => {
      const next = new Map(prev)
      for (const a of worthy) {
        if (!next.has(a.worktreeId)) next.set(a.worktreeId, a.isGitHub)
      }
      return next
    })
    setBaseBranchByWorktree((prev) => {
      const next = new Map(prev)
      for (const a of worthy) {
        if (!next.has(a.worktreeId)) next.set(a.worktreeId, a.defaultBase)
      }
      return next
    })
  }, [])

  const refreshAssessments = useCallback(async (): Promise<MemberAssessment[]> => {
    const connection = useConnectionStore.getState().connections.find((c) => c.id === connectionId)
    if (!connection) return []
    const results = await assessConnectionMembers(connection.members)
    setAssessments(results)
    seedSelections(results)
    return results
  }, [connectionId, seedSelections])

  // ── Evaluate on open ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    let cancelled = false

    setPhase('loading')
    setAssessments([])
    setTitle('')
    setBody('')
    setCommitErrors(new Map())
    setIncludeByWorktree(new Map())
    setBaseBranchByWorktree(new Map())
    setRemoteBranchesByWorktree(new Map())

    const connection = useConnectionStore.getState().connections.find((c) => c.id === connectionId)
    if (!connection) {
      setOpen(false)
      return
    }

    // Pre-fill the shared commit message like GitCommitForm does
    setCommitSummary(sessionTitles[0] ?? '')
    setCommitDescription(
      sessionTitles.length > 1 ? sessionTitles.map((t) => `- ${t}`).join('\n') : ''
    )

    assessConnectionMembers(connection.members)
      .then((results) => {
        if (cancelled) return
        setAssessments(results)
        seedSelections(results)
        const worthy = results.filter(isPRWorthy)
        if (worthy.length === 0) {
          // Nothing to PR anywhere — prompt to archive the clean worktrees
          emitArchivePrompts(results)
          setPhase('empty')
        } else if (worthy.some((a) => a.hasUncommitted)) {
          setPhase('commit')
        } else {
          setPhase('form')
        }
      })
      .catch(() => {
        if (!cancelled) setPhase('empty')
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionId])

  // ── Lazily fetch remote branches when the form phase opens ──────
  useEffect(() => {
    if (phase !== 'form') return
    for (const assessment of eligible) {
      if (!assessment.isGitHub) continue
      if (remoteBranchesByWorktree.has(assessment.worktreeId)) continue
      gitApi
        .listBranchesWithStatus(assessment.worktreePath)
        .then((result) => {
          if (!result.success) return
          const seen = new Set<string>()
          const names: string[] = []
          for (const b of result.branches.filter((b) => b.isRemote)) {
            const name = b.name.replace(/^origin\//, '')
            if (!seen.has(name)) {
              seen.add(name)
              names.push(name)
            }
          }
          setRemoteBranchesByWorktree((prev) => new Map(prev).set(assessment.worktreeId, names))
        })
        .catch(() => {
          // Non-critical
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, eligible])

  // ── Commit phase handlers ───────────────────────────────────────
  const handleStageAll = useCallback(
    async (assessment: MemberAssessment) => {
      setStagingWorktreeId(assessment.worktreeId)
      try {
        const success = await stageAll(assessment.worktreePath)
        if (success) {
          await loadFileStatuses(assessment.worktreePath)
        } else {
          toast.error(`Failed to stage files in ${assessment.projectName}`)
        }
      } finally {
        setStagingWorktreeId(null)
      }
    },
    [stageAll, loadFileStatuses]
  )

  const handleToggleFile = useCallback(
    async (worktreePath: string, file: GitFileStatus) => {
      if (file.staged) {
        await useGitStore.getState().unstageFile(worktreePath, file.relativePath)
      } else {
        await useGitStore.getState().stageFile(worktreePath, file.relativePath)
      }
      await loadFileStatuses(worktreePath)
    },
    [loadFileStatuses]
  )

  const membersWithStagedFiles = useMemo(
    () =>
      eligible.filter((a) =>
        (fileStatusesByWorktree.get(a.worktreePath) ?? []).some((f) => f.staged)
      ),
    [eligible, fileStatusesByWorktree]
  )

  const handleCommitAndContinue = useCallback(async () => {
    if (!commitSummary.trim() || membersWithStagedFiles.length === 0) return
    setCommitErrors(new Map())

    const message = commitDescription.trim()
      ? `${commitSummary.trim()}\n\n${commitDescription.trim()}`
      : commitSummary.trim()

    const results = await commitConnectionMembers(membersWithStagedFiles, message)
    const errors = new Map<string, string>()
    for (const [worktreeId, result] of results) {
      if (!result.success) errors.set(worktreeId, result.error ?? 'Commit failed')
    }

    if (errors.size > 0) {
      setCommitErrors(errors)
      await refreshAssessments()
      return
    }

    toast.success(
      `Committed ${results.size} project${results.size !== 1 ? 's' : ''}`
    )
    await refreshAssessments()
    setPhase('form')
  }, [commitSummary, commitDescription, membersWithStagedFiles, refreshAssessments])

  const handleSkipCommit = useCallback(async () => {
    await refreshAssessments()
    setPhase('form')
  }, [refreshAssessments])

  // ── Create PRs (background — closes modal immediately) ──────────
  const includedCount = useMemo(
    () =>
      eligible.filter((a) => a.isGitHub && (includeByWorktree.get(a.worktreeId) ?? a.isGitHub))
        .length,
    [eligible, includeByWorktree]
  )

  const handleCreate = useCallback(() => {
    const provider = resolvePRContentProvider(defaultAgentSdk, availableAgentSdks)
    const gitStore = useGitStore.getState()

    const plans = eligible.map((assessment) => ({
      assessment,
      baseBranch: baseBranchByWorktree.get(assessment.worktreeId) ?? assessment.defaultBase,
      include: includeByWorktree.get(assessment.worktreeId) ?? assessment.isGitHub
    }))

    // Persist the selected target branches like the single-worktree flow
    for (const plan of plans) {
      if (!plan.include || !plan.assessment.isGitHub) continue
      const normalized = plan.baseBranch.startsWith('origin/')
        ? plan.baseBranch
        : `origin/${plan.baseBranch}`
      gitStore.setPrTargetBranch(plan.assessment.worktreeId, normalized)
      if (!gitStore.reviewTargetBranch.get(plan.assessment.worktreeId)) {
        gitStore.setReviewTargetBranch(plan.assessment.worktreeId, normalized)
      }
    }

    setOpen(false)

    void createConnectionPRs({
      plans,
      ineligible,
      title: title.trim(),
      body: body.trim(),
      provider
    })
  }, [
    eligible,
    ineligible,
    baseBranchByWorktree,
    includeByWorktree,
    title,
    body,
    defaultAgentSdk,
    availableAgentSdks,
    setOpen
  ])

  const handleCancel = useCallback(() => {
    setOpen(false)
  }, [setOpen])

  // ── Render: Loading ─────────────────────────────────────────────
  const renderLoading = (): React.JSX.Element => (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Checking connected worktrees...
    </div>
  )

  // ── Render: Empty ───────────────────────────────────────────────
  const renderEmpty = (): React.JSX.Element => (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <Inbox className="h-8 w-8 text-muted-foreground/60" />
      <p className="text-sm font-medium text-foreground">Nothing to PR</p>
      <p className="text-xs text-muted-foreground max-w-[360px]">
        All connected worktrees are clean — no uncommitted changes and no commits ahead of their
        base branches.
      </p>
    </div>
  )

  // ── Render: Commit phase ────────────────────────────────────────
  const renderCommitSection = (assessment: MemberAssessment): React.JSX.Element | null => {
    const files = fileStatusesByWorktree.get(assessment.worktreePath) ?? []
    if (files.length === 0) return null
    const stagedCount = files.filter((f) => f.staged).length
    const commitError = commitErrors.get(assessment.worktreeId)

    return (
      <div
        key={assessment.worktreeId}
        className="border rounded-md overflow-hidden"
        data-testid={`connection-pr-section-${assessment.worktreeId}`}
      >
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b">
          <span className="flex items-center gap-2 min-w-0 text-xs font-medium">
            <span className="truncate">{assessment.projectName}</span>
            <span className="flex items-center gap-1 text-muted-foreground font-normal shrink-0">
              <GitBranch className="h-3 w-3" />
              {assessment.branchName}
            </span>
            <span className="text-muted-foreground font-normal shrink-0">
              {files.length} file{files.length !== 1 ? 's' : ''}
              {stagedCount > 0 && ` · ${stagedCount} staged`}
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => handleStageAll(assessment)}
            disabled={stagingWorktreeId !== null || isCommitting}
          >
            {stagingWorktreeId === assessment.worktreeId ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Plus className="h-3 w-3 mr-1" />
            )}
            Stage All
          </Button>
        </div>
        <div className="max-h-[120px] overflow-y-auto">
          {files.map((file) => (
            <div
              key={file.relativePath}
              className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent/30"
            >
              <Checkbox
                checked={file.staged}
                onCheckedChange={() => handleToggleFile(assessment.worktreePath, file)}
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
        {commitError && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-destructive border-t">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{commitError}</span>
          </div>
        )}
      </div>
    )
  }

  const renderCommit = (): React.JSX.Element => (
    <>
      <p className="text-sm text-muted-foreground">
        You have uncommitted changes in {eligible.filter((a) => a.hasUncommitted).length} connected
        project
        {eligible.filter((a) => a.hasUncommitted).length !== 1 ? 's' : ''}. Commit them with one
        shared message, or skip to continue with what&apos;s already committed.
      </p>

      {/* Per-project file sections */}
      <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
        {eligible.map((assessment) => renderCommitSection(assessment))}
      </div>

      {/* Shared commit message */}
      <div className="space-y-2">
        <div className="relative">
          <Input
            value={commitSummary}
            onChange={(e) => setCommitSummary(e.target.value)}
            placeholder="Commit summary (applied to every project)"
            className={cn(
              'pr-12',
              commitSummary.length > 72 && 'border-red-500 focus-visible:ring-red-500',
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
              commitSummary.length > 50 && commitSummary.length <= 72 && 'text-yellow-500',
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

      {membersWithStagedFiles.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Will commit in {membersWithStagedFiles.map((a) => a.projectName).join(', ')}
        </p>
      )}
    </>
  )

  // ── Render: Form phase ──────────────────────────────────────────
  const renderFormRow = (assessment: MemberAssessment): React.JSX.Element => {
    const included = includeByWorktree.get(assessment.worktreeId) ?? assessment.isGitHub
    const baseBranch = baseBranchByWorktree.get(assessment.worktreeId) ?? assessment.defaultBase
    const rawOptions = remoteBranchesByWorktree.get(assessment.worktreeId) ?? []
    const options = rawOptions.includes(baseBranch) ? rawOptions : [baseBranch, ...rawOptions]
    const sortedOptions = [...options].sort((a, b) => {
      if (a === assessment.defaultBase) return -1
      if (b === assessment.defaultBase) return 1
      return a.localeCompare(b)
    })

    return (
      <div
        key={assessment.worktreeId}
        className="border rounded-md px-3 py-2 space-y-1.5"
        data-testid={`connection-pr-row-${assessment.worktreeId}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Checkbox
            checked={included}
            disabled={!assessment.isGitHub}
            onCheckedChange={(checked) =>
              setIncludeByWorktree((prev) =>
                new Map(prev).set(assessment.worktreeId, checked === true)
              )
            }
            className="h-3.5 w-3.5"
          />
          <span className="text-sm font-medium truncate">{assessment.projectName}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
            <GitBranch className="h-3 w-3 shrink-0" />
            <span className="truncate">{assessment.branchName}</span>
          </span>
          <span className="ml-auto text-xs text-muted-foreground shrink-0">
            {assessment.commitsAhead} commit{assessment.commitsAhead !== 1 ? 's' : ''} ahead
          </span>
        </div>

        {!assessment.isGitHub ? (
          <p className="text-xs text-amber-500">No GitHub remote — PR will be skipped</p>
        ) : assessment.attachedPR ? (
          <p className="text-xs text-blue-400">
            PR #{assessment.attachedPR.number} attached — will push updates
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0">Base</span>
            <Popover
              open={openBranchDropdown === assessment.worktreeId}
              onOpenChange={(isOpen) =>
                setOpenBranchDropdown(isOpen ? assessment.worktreeId : null)
              }
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex items-center justify-between flex-1 min-w-0 px-2 py-1 text-xs border rounded-md',
                    'bg-background hover:bg-accent/50 transition-colors text-left'
                  )}
                  disabled={!included}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="truncate">{baseBranch}</span>
                  </span>
                  <ChevronDown
                    className={cn(
                      'h-3 w-3 text-muted-foreground transition-transform',
                      openBranchDropdown === assessment.worktreeId && 'rotate-180'
                    )}
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <div className="max-h-[180px] overflow-y-auto">
                  {sortedOptions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={cn(
                        'flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left',
                        'hover:bg-accent transition-colors',
                        name === baseBranch && 'bg-accent'
                      )}
                      onClick={() => {
                        setBaseBranchByWorktree((prev) =>
                          new Map(prev).set(assessment.worktreeId, name)
                        )
                        setOpenBranchDropdown(null)
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
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>
    )
  }

  const renderForm = (): React.JSX.Element => (
    <>
      {/* Per-project rows */}
      <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
        {eligible.map((assessment) => renderFormRow(assessment))}
      </div>

      {/* Shared title */}
      <div className="space-y-1.5">
        <label htmlFor="connection-pr-title" className="text-sm font-medium text-foreground">
          Title
        </label>
        <Input
          id="connection-pr-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Leave empty to auto-generate per repository"
        />
      </div>

      {/* Shared description */}
      <div className="space-y-1.5">
        <label htmlFor="connection-pr-description" className="text-sm font-medium text-foreground">
          Description
        </label>
        <Textarea
          id="connection-pr-description"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Leave empty to auto-generate per repository"
          rows={3}
        />
      </div>
    </>
  )

  // ── Render: Footer ──────────────────────────────────────────────
  const renderFooter = (): React.JSX.Element => {
    switch (phase) {
      case 'loading':
        return <></>
      case 'empty':
        return (
          <DialogFooter>
            <Button variant="ghost" onClick={handleCancel}>
              Close
            </Button>
          </DialogFooter>
        )
      case 'commit':
        return (
          <DialogFooter>
            <Button variant="ghost" onClick={handleSkipCommit} disabled={isCommitting}>
              Skip
            </Button>
            <Button
              onClick={handleCommitAndContinue}
              disabled={
                !commitSummary.trim() || membersWithStagedFiles.length === 0 || isCommitting
              }
              data-testid="connection-pr-commit-button"
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
            <Button
              onClick={handleCreate}
              disabled={includedCount === 0}
              data-testid="connection-pr-create-button"
            >
              <GitPullRequest className="h-4 w-4 mr-1.5" />
              Create {includedCount} Pull Request{includedCount !== 1 ? 's' : ''}
            </Button>
          </DialogFooter>
        )
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => setOpen(isOpen, isOpen ? connectionId : undefined)}>
      <DialogContent className="sm:max-w-xl" data-testid="connection-pr-modal">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <GitPullRequest className="h-5 w-5" />
              Create Pull Requests
            </span>
          </DialogTitle>
          {phase === 'commit' && (
            <DialogDescription>
              Commit your changes across the connected projects before creating pull requests.
            </DialogDescription>
          )}
          {phase === 'form' && (
            <DialogDescription>
              One pull request will be created per connected project with changes.
            </DialogDescription>
          )}
          {(phase === 'loading' || phase === 'empty') && (
            <DialogDescription>
              Create pull requests for the projects in this connection.
            </DialogDescription>
          )}
        </DialogHeader>

        {phase === 'loading' && renderLoading()}
        {phase === 'empty' && renderEmpty()}
        {phase === 'commit' && renderCommit()}
        {phase === 'form' && renderForm()}

        {renderFooter()}
      </DialogContent>
    </Dialog>
  )
}
