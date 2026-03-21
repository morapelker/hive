import { useCallback, useEffect, useState } from 'react'
import { isMac } from '@/lib/platform'
import {
  PanelRightClose,
  PanelRightOpen,
  History,
  Settings,
  AlertTriangle,
  Loader2,
  GitPullRequest,
  GitMerge,
  Archive,
  ChevronDown,
  FileSearch,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useSessionHistoryStore } from '@/stores/useSessionHistoryStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useVimModeStore } from '@/stores/useVimModeStore'
import { QuickActions } from './QuickActions'
import { usePRDetection } from '@/hooks/usePRDetection'
import hiveLogo from '@/assets/icon.png'

type ConflictFixFlow =
  | {
      phase: 'starting'
      worktreePath: string
    }
  | {
      phase: 'running'
      worktreePath: string
      sessionId: string
      seenBusy: boolean
    }
  | {
      phase: 'refreshing'
      worktreePath: string
    }

function isConflictFixActiveStatus(status: string | null): boolean {
  return (
    status === 'working' ||
    status === 'planning' ||
    status === 'answering' ||
    status === 'permission'
  )
}

export function Header(): React.JSX.Element {
  const { rightSidebarCollapsed, toggleRightSidebar } = useLayoutStore()
  const { openPanel: openSessionHistory } = useSessionHistoryStore()
  const openSettings = useSettingsStore((s) => s.openSettings)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const projects = useProjectStore((s) => s.projects)
  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()
  const createSession = useSessionStore((s) => s.createSession)
  const updateSessionName = useSessionStore((s) => s.updateSessionName)
  const setPendingMessage = useSessionStore((s) => s.setPendingMessage)
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  const vimMode = useVimModeStore((s) => s.mode)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const showVimHints = vimModeEnabled && vimMode === 'normal'
  const [conflictFixFlow, setConflictFixFlow] = useState<ConflictFixFlow | null>(null)

  // Monitor PR session stream events for PR URL detection
  usePRDetection(selectedWorktreeId)

  const selectedProject = projects.find((p) => p.id === selectedProjectId)
  const selectedWorktree = (() => {
    if (!selectedWorktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === selectedWorktreeId)
      if (wt) return wt
    }
    return null
  })()

  // Connection mode detection
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectedConnection = useConnectionStore((s) =>
    s.selectedConnectionId ? s.connections.find((c) => c.id === s.selectedConnectionId) : null
  )
  const isConnectionMode = !!selectedConnectionId && !selectedWorktreeId

  const hasConflicts = useGitStore(
    (state) =>
      (selectedWorktree?.path ? state.conflictsByWorktree[selectedWorktree.path] : false) ?? false
  )

  // PR / remote info
  const remoteInfo = useGitStore((state) =>
    selectedWorktreeId ? state.remoteInfo.get(selectedWorktreeId) : undefined
  )
  const isGitHub = remoteInfo?.isGitHub ?? false
  const prTargetBranch = useGitStore((state) =>
    selectedWorktreeId ? state.prTargetBranch.get(selectedWorktreeId) : undefined
  )
  const setPrTargetBranch = useGitStore((state) => state.setPrTargetBranch)
  const reviewTargetBranch = useGitStore((state) =>
    selectedWorktreeId ? state.reviewTargetBranch.get(selectedWorktreeId) : undefined
  )
  const setReviewTargetBranch = useGitStore((state) => state.setReviewTargetBranch)
  const branchInfoByWorktree = useGitStore((state) => state.branchInfoByWorktree)
  const branchInfo = selectedWorktree?.path
    ? branchInfoByWorktree.get(selectedWorktree.path)
    : undefined
  const isOperating = useGitStore((state) => state.isPushing || state.isPulling)

  // PR lifecycle state (new persistent model)
  const prCreation = useGitStore((s) =>
    selectedWorktreeId ? s.prCreation.get(selectedWorktreeId) : undefined
  )
  const attachedPR = useGitStore((s) =>
    selectedWorktreeId ? s.attachedPR.get(selectedWorktreeId) : undefined
  )
  const isCreatingPR = prCreation?.creating ?? false
  const hasAttachedPR = !!attachedPR

  // Clean tree detection for merge button visibility
  const fileStatuses = useGitStore((s) =>
    selectedWorktree?.path ? s.fileStatusesByWorktree.get(selectedWorktree.path) : undefined
  )
  const isCleanTree = !fileStatuses || fileStatuses.length === 0

  const conflictFixSessionStatus = useWorktreeStatusStore((state) =>
    conflictFixFlow?.phase === 'running'
      ? (state.sessionStatuses[conflictFixFlow.sessionId]?.status ?? null)
      : null
  )

  // Clear conflict fix flow as soon as conflicts are resolved
  useEffect(() => {
    if (!hasConflicts && conflictFixFlow) {
      setConflictFixFlow(null)
    }
  }, [hasConflicts, conflictFixFlow])

  useEffect(() => {
    if (!conflictFixFlow || conflictFixFlow.phase !== 'running') return

    const isBusy = isConflictFixActiveStatus(conflictFixSessionStatus)

    if (isBusy && !conflictFixFlow.seenBusy) {
      setConflictFixFlow((prev) =>
        prev && prev.phase === 'running' ? { ...prev, seenBusy: true } : prev
      )
      return
    }

    const shouldFinalize =
      (conflictFixFlow.seenBusy && !isBusy) ||
      (!conflictFixFlow.seenBusy && conflictFixSessionStatus === 'completed')

    if (!shouldFinalize) return

    let cancelled = false
    const finishConflictRun = async (): Promise<void> => {
      setConflictFixFlow((prev) =>
        prev && prev.phase === 'running'
          ? { phase: 'refreshing', worktreePath: prev.worktreePath }
          : prev
      )

      try {
        await useGitStore.getState().refreshStatuses(conflictFixFlow.worktreePath)
      } finally {
        if (!cancelled) {
          setConflictFixFlow((prev) =>
            prev?.worktreePath === conflictFixFlow.worktreePath ? null : prev
          )
        }
      }
    }

    void finishConflictRun()

    return () => {
      cancelled = true
    }
  }, [conflictFixFlow, conflictFixSessionStatus])

  // Load remote branches for the PR target and review target dropdowns
  const [remoteBranches, setRemoteBranches] = useState<{ name: string }[]>([])
  const [isMergingPR, setIsMergingPR] = useState(false)
  const [isArchivingWorktree, setIsArchivingWorktree] = useState(false)

  // PR picker popover state
  const [prPickerOpen, setPrPickerOpen] = useState(false)
  const [prList, setPrList] = useState<
    Array<{ number: number; title: string; author: string; headRefName: string }>
  >([])
  const [prListLoading, setPrListLoading] = useState(false)
  const [prLiveState, setPrLiveState] = useState<
    { state?: string; title?: string } | null
  >(null)

  useEffect(() => {
    if (!selectedWorktree?.path) {
      setRemoteBranches([])
      return
    }
    window.gitOps.listBranchesWithStatus(selectedWorktree.path).then((result) => {
      if (result.success) {
        setRemoteBranches(result.branches.filter((b: { isRemote: boolean }) => b.isRemote))
      }
    })
  }, [selectedWorktree?.path])

  // Fetch PR list + live state when picker opens
  useEffect(() => {
    if (!prPickerOpen || !selectedProject?.path) return
    setPrListLoading(true)

    const fetchPRs = window.gitOps.listPRs(selectedProject.path).then((res) => {
      if (res.success) {
        // Sort: branch-matching PR first, then by number descending
        const currentBranch = branchInfo?.name ?? ''
        const sorted = [...res.prs].sort((a, b) => {
          const aMatch = a.headRefName === currentBranch ? 1 : 0
          const bMatch = b.headRefName === currentBranch ? 1 : 0
          if (aMatch !== bMatch) return bMatch - aMatch
          return b.number - a.number
        })
        setPrList(sorted)
      } else {
        toast.error(res.error || 'Failed to load PRs')
        setPrPickerOpen(false)
      }
    }).catch(() => {
      toast.error('Failed to load PRs')
      setPrPickerOpen(false)
    })

    const fetchState = attachedPR && selectedProject?.path
      ? window.gitOps.getPRState(selectedProject.path, attachedPR.number).then((res) => {
          if (res.success) {
            setPrLiveState({ state: res.state, title: res.title })
          }
        }).catch(() => { /* non-critical */ })
      : Promise.resolve()

    Promise.all([fetchPRs, fetchState]).finally(() => setPrListLoading(false))
  }, [prPickerOpen, selectedProject?.path, attachedPR, branchInfo?.name])

  // Clear live state when attached PR changes
  useEffect(() => {
    setPrLiveState(null)
  }, [attachedPR?.number])

  const handleCreatePR = useCallback(async () => {
    if (!selectedWorktree?.path) return

    const wtId = selectedWorktreeId
    if (!wtId) {
      toast.error('No worktree selected')
      return
    }

    let projectId = ''
    const worktreeStore = useWorktreeStore.getState()
    for (const [projId, wts] of worktreeStore.worktreesByProject) {
      if (wts.some((w) => w.id === wtId)) {
        projectId = projId
        break
      }
    }
    if (!projectId) {
      toast.error('Could not find project for worktree')
      return
    }

    const targetBranch = prTargetBranch || branchInfo?.tracking || 'origin/main'

    const sessionStore = useSessionStore.getState()
    const result = await sessionStore.createSession(wtId, projectId)
    if (!result.success || !result.session) {
      toast.error('Failed to create PR session')
      return
    }

    await sessionStore.updateSessionName(result.session.id, `PR → ${targetBranch}`)
    sessionStore.setPendingMessage(
      result.session.id,
      [
        `Create a pull request targeting ${targetBranch}.`,
        `Use \`gh pr create\` to create the PR.`,
        `Base the PR title and description on the git diff between HEAD and ${targetBranch}.`,
        `Make the description comprehensive, summarizing all changes.`
      ].join(' ')
    )

    // Tag this session as a PR session for detection
    useGitStore.getState().setPrCreation(wtId, {
      creating: true,
      sessionId: result.session.id
    })
  }, [selectedWorktree?.path, selectedWorktreeId, prTargetBranch, branchInfo])

  const handleReview = useCallback(async () => {
    if (!selectedWorktree?.path) return

    const wtId = selectedWorktreeId
    if (!wtId) {
      toast.error('No worktree selected')
      return
    }

    let projectId = ''
    const worktreeStore = useWorktreeStore.getState()
    for (const [projId, wts] of worktreeStore.worktreesByProject) {
      if (wts.some((w) => w.id === wtId)) {
        projectId = projId
        break
      }
    }
    if (!projectId) {
      toast.error('Could not find project for worktree')
      return
    }

    const targetBranch = reviewTargetBranch || branchInfo?.tracking || 'origin/main'
    const branchName = branchInfo?.name || 'unknown'

    let reviewTemplate = ''
    try {
      const tmpl = await window.fileOps.readPrompt('review.md')
      if (tmpl.success && tmpl.content) {
        reviewTemplate = tmpl.content
      }
    } catch {
      // readPrompt failed, use fallback
    }

    const prompt = reviewTemplate
      ? [
          reviewTemplate,
          '',
          '---',
          '',
          `Compare the current branch (${branchName}) against ${targetBranch}.`,
          `Use \`git diff ${targetBranch}...HEAD\` to see all changes.`
        ].join('\n')
      : [
          `Please review the changes on branch "${branchName}" compared to ${targetBranch}.`,
          `Use \`git diff ${targetBranch}...HEAD\` to get the full diff.`,
          'Focus on: bugs, logic errors, and code quality.'
        ].join('\n')

    const sessionStore = useSessionStore.getState()
    const result = await sessionStore.createSession(wtId, projectId)
    if (!result.success || !result.session) {
      toast.error('Failed to create review session')
      return
    }

    await sessionStore.updateSessionName(
      result.session.id,
      `Code Review — ${branchName} vs ${targetBranch}`
    )
    sessionStore.setPendingMessage(result.session.id, prompt)
  }, [selectedWorktree?.path, selectedWorktreeId, reviewTargetBranch, branchInfo])

  const handleMergePR = useCallback(async () => {
    if (!selectedWorktree?.path || !selectedWorktreeId) return
    const pr = useGitStore.getState().attachedPR.get(selectedWorktreeId)
    if (!pr?.number) return

    setIsMergingPR(true)
    try {
      const result = await window.gitOps.prMerge(selectedWorktree.path, pr.number)
      if (result.success) {
        toast.success('PR merged successfully')
        setPrLiveState({ state: 'MERGED', title: prLiveState?.title })
      } else {
        toast.error(`Merge failed: ${result.error}`)
      }
    } catch {
      toast.error('Failed to merge PR')
    } finally {
      setIsMergingPR(false)
    }
  }, [selectedWorktree?.path, selectedWorktreeId, prLiveState?.title])

  const handleArchiveWorktree = useCallback(async () => {
    if (!selectedWorktreeId || !selectedWorktree || !selectedProject) return
    setIsArchivingWorktree(true)
    try {
      const result = await useWorktreeStore
        .getState()
        .archiveWorktree(
          selectedWorktreeId,
          selectedWorktree.path,
          selectedWorktree.branch_name,
          selectedProject.path
        )

      if (!result.success && result.error) {
        toast.error(result.error)
      }
    } finally {
      setIsArchivingWorktree(false)
    }
  }, [selectedWorktreeId, selectedWorktree, selectedProject])

  const handleSelectPR = useCallback(
    (pr: { number: number; headRefName: string }) => {
      if (!selectedWorktreeId || !remoteInfo?.url) return
      // Construct PR URL from remote URL + number
      const cleanUrl = remoteInfo.url.replace(/\.git$/, '')
      const prUrl = `${cleanUrl}/pull/${pr.number}`
      useGitStore.getState().attachPR(selectedWorktreeId, pr.number, prUrl)
      setPrPickerOpen(false)
    },
    [selectedWorktreeId, remoteInfo?.url]
  )

  const handleDetachPR = useCallback(() => {
    if (!selectedWorktreeId) return
    useGitStore.getState().detachPR(selectedWorktreeId)
    setPrPickerOpen(false)
    setPrLiveState(null)
  }, [selectedWorktreeId])

  const handleFixConflicts = async () => {
    if (!selectedWorktreeId || !selectedProjectId || !selectedWorktree?.path) return

    setConflictFixFlow({
      phase: 'starting',
      worktreePath: selectedWorktree.path
    })

    const { success, session } = await createSession(selectedWorktreeId, selectedProjectId)
    if (!success || !session) {
      setConflictFixFlow(null)
      return
    }

    const branchName = selectedWorktree?.branch_name || 'unknown'
    await updateSessionName(session.id, `Merge Conflicts -- ${branchName}`)
    setPendingMessage(session.id, 'Fix merge conflicts')
    setActiveSession(session.id)

    setConflictFixFlow({
      phase: 'running',
      worktreePath: selectedWorktree.path,
      sessionId: session.id,
      seenBusy: false
    })
  }

  const isFixConflictsLoading =
    !!selectedWorktree?.path &&
    !!conflictFixFlow &&
    conflictFixFlow.worktreePath === selectedWorktree.path

  const showFixConflictsButton = hasConflicts || isFixConflictsLoading

  return (
    <header
      className="h-12 border-b bg-background flex items-center justify-between px-4 flex-shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      data-testid="header"
    >
      {/* Spacer for macOS traffic lights */}
      {isMac() && <div className="w-16 flex-shrink-0" />}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <img src={hiveLogo} alt="Hive" className="h-5 w-5 shrink-0 rounded" draggable={false} />
        {isConnectionMode && selectedConnection ? (
          <span className="text-sm font-medium truncate" data-testid="header-connection-info">
            {selectedConnection.name}
            <span className="text-primary font-normal">
              {' '}
              ({selectedConnection.members.map((m) => m.project_name).join(' + ')})
            </span>
          </span>
        ) : selectedProject ? (
          <span className="text-sm font-medium truncate" data-testid="header-project-info">
            {selectedProject.name}
            {selectedWorktree?.branch_name && selectedWorktree.name !== '(no-worktree)' && (
              <span className="text-primary font-normal"> ({selectedWorktree.branch_name})</span>
            )}
          </span>
        ) : (
          <span className="text-sm font-medium">Hive</span>
        )}
        {vimModeEnabled && (
          <span
            className={cn(
              'text-[10px] font-mono px-1.5 py-0.5 rounded border select-none',
              vimMode === 'normal'
                ? 'text-muted-foreground bg-muted/50 border-border/50'
                : 'text-primary bg-primary/10 border-primary/30'
            )}
            data-testid="vim-mode-pill"
          >
            {vimMode === 'normal' ? 'NORMAL' : 'INSERT'}
          </span>
        )}
      </div>
      {/* Center: Quick Actions */}
      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <QuickActions />
      </div>
      {!isConnectionMode && showFixConflictsButton && (
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-xs font-semibold"
            onClick={handleFixConflicts}
            disabled={isFixConflictsLoading}
            data-testid="fix-conflicts-button"
          >
            {isFixConflictsLoading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 mr-1" />
            )}
            {isFixConflictsLoading ? 'Fixing conflicts...' : 'Fix conflicts'}
          </Button>
        </div>
      )}
      <div className="flex-1" />
      <div
        className="flex items-center gap-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {!isConnectionMode &&
          isGitHub &&
          hasAttachedPR &&
          prLiveState?.state === 'MERGED' &&
          !selectedWorktree?.is_default && (
            <Button
              size="sm"
              variant="destructive"
              className="h-7 text-xs"
              onClick={handleArchiveWorktree}
              disabled={isArchivingWorktree}
              title="Archive worktree"
              data-testid="pr-archive-button"
            >
              {isArchivingWorktree ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Archive className="h-3.5 w-3.5 mr-1" />
              )}
              {isArchivingWorktree ? (
                'Archiving...'
              ) : showVimHints ? (
                <span>
                  <span className="text-primary font-bold">A</span>rchive
                </span>
              ) : (
                'Archive'
              )}
            </Button>
          )}
        {!isConnectionMode &&
          isGitHub &&
          hasAttachedPR &&
          prLiveState?.state !== 'MERGED' &&
          prLiveState?.state !== 'CLOSED' &&
          isCleanTree && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs bg-emerald-600/10 border-emerald-600/30 text-emerald-500 hover:bg-emerald-600/20"
              onClick={handleMergePR}
              disabled={isMergingPR}
              title="Merge Pull Request"
              data-testid="pr-merge-button"
            >
              {isMergingPR ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <GitMerge className="h-3.5 w-3.5 mr-1" />
              )}
              {isMergingPR ? (
                'Merging...'
              ) : showVimHints ? (
                <span>
                  <span className="text-primary font-bold">M</span>erge PR
                </span>
              ) : (
                'Merge PR'
              )}
            </Button>
          )}
        {!isConnectionMode && selectedWorktree && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={handleReview}
              disabled={isOperating}
              title="Review branch changes with AI"
              data-testid="review-button"
            >
              <FileSearch className="h-3.5 w-3.5 mr-1" />
              {showVimHints ? (
                <span>
                  <span className="text-primary font-bold">R</span>eview
                </span>
              ) : (
                'Review'
              )}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs text-muted-foreground px-2 h-7"
                  data-testid="review-target-branch-trigger"
                >
                  vs {reviewTargetBranch || branchInfo?.tracking || 'origin/main'}
                  <ChevronDown className="h-3 w-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-60 overflow-y-auto">
                {remoteBranches.length === 0 ? (
                  <DropdownMenuItem disabled>No remote branches</DropdownMenuItem>
                ) : (
                  remoteBranches.map((branch) => (
                    <DropdownMenuItem
                      key={branch.name}
                      onClick={() =>
                        selectedWorktreeId && setReviewTargetBranch(selectedWorktreeId, branch.name)
                      }
                      data-testid={`review-target-branch-${branch.name}`}
                    >
                      {branch.name}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        {/* PR Badge with Popover Picker — shown when a PR is attached and not creating */}
        {!isConnectionMode && isGitHub && hasAttachedPR && !isCreatingPR && (
          <Popover open={prPickerOpen} onOpenChange={setPrPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                title={`PR #${attachedPR!.number}`}
                data-testid="pr-badge"
              >
                <GitPullRequest className="h-3.5 w-3.5 mr-1" />
                PR #{attachedPR!.number}
                {prLiveState?.state === 'MERGED' && (
                  <span className="text-muted-foreground ml-1">· merged</span>
                )}
                {prLiveState?.state === 'CLOSED' && (
                  <span className="text-muted-foreground ml-1">· closed</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-0">
              {/* Attached PR header */}
              <div className="px-3 py-2 border-b">
                <div className="text-xs font-medium text-muted-foreground">
                  Attached: #{attachedPR!.number}
                </div>
                {prLiveState?.title && (
                  <div className="text-sm truncate">
                    {prLiveState.title}
                    {prLiveState.state && (
                      <span className="text-muted-foreground ml-1 text-xs">
                        ({prLiveState.state.toLowerCase()})
                      </span>
                    )}
                  </div>
                )}
              </div>
              {/* PR list */}
              <div className="max-h-48 overflow-y-auto">
                {prListLoading ? (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" />
                    Loading PRs...
                  </div>
                ) : prList.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No open PRs found
                  </div>
                ) : (
                  prList.map((pr) => (
                    <button
                      key={pr.number}
                      className={cn(
                        'w-full text-left px-3 py-2 text-sm hover:bg-accent cursor-pointer',
                        'flex items-center gap-2',
                        pr.number === attachedPR!.number && 'bg-accent/50'
                      )}
                      onClick={() => handleSelectPR(pr)}
                      data-testid={`pr-picker-item-${pr.number}`}
                    >
                      <span className={cn(
                        'text-xs font-mono shrink-0',
                        pr.number === attachedPR!.number && 'text-primary font-bold'
                      )}>
                        {pr.number === attachedPR!.number ? '●' : ' '} #{pr.number}
                      </span>
                      <span className="truncate">{pr.title}</span>
                    </button>
                  ))
                )}
              </div>
              {/* Detach action */}
              <div className="border-t">
                <button
                  className="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10 cursor-pointer flex items-center gap-1"
                  onClick={handleDetachPR}
                  data-testid="pr-detach-button"
                >
                  <X className="h-3.5 w-3.5" />
                  Detach PR
                </button>
              </div>
            </PopoverContent>
          </Popover>
        )}
        {/* Creating PR spinner */}
        {!isConnectionMode && isGitHub && isCreatingPR && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled
            data-testid="pr-creating-button"
          >
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            PR
          </Button>
        )}
        {/* Create PR button — shown when no PR attached and not creating */}
        {!isConnectionMode && isGitHub && !hasAttachedPR && !isCreatingPR && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={handleCreatePR}
              disabled={isOperating}
              title="Create Pull Request"
              data-testid="pr-button"
            >
              <GitPullRequest className="h-3.5 w-3.5 mr-1" />
              {showVimHints ? (
                <span>
                  <span className="text-primary font-bold">P</span>R
                </span>
              ) : (
                'PR'
              )}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs text-muted-foreground px-2 h-7"
                  data-testid="pr-target-branch-trigger"
                >
                  → {prTargetBranch || branchInfo?.tracking || 'origin/main'}
                  <ChevronDown className="h-3 w-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-60 overflow-y-auto">
                {remoteBranches.length === 0 ? (
                  <DropdownMenuItem disabled>No remote branches</DropdownMenuItem>
                ) : (
                  remoteBranches.map((branch) => (
                    <DropdownMenuItem
                      key={branch.name}
                      onClick={() =>
                        selectedWorktreeId && setPrTargetBranch(selectedWorktreeId, branch.name)
                      }
                      data-testid={`pr-target-branch-${branch.name}`}
                    >
                      {branch.name}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={openSessionHistory}
          title="Session History (⌘K)"
          data-testid="session-history-toggle"
        >
          <History className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openSettings()}
          title="Settings (⌘,)"
          data-testid="settings-toggle"
        >
          <Settings className="h-4 w-4" />
        </Button>
        <Button
          onClick={toggleRightSidebar}
          variant="ghost"
          size="icon"
          title={rightSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          data-testid="right-sidebar-toggle"
        >
          {rightSidebarCollapsed ? (
            <PanelRightOpen className="h-4 w-4" />
          ) : (
            <PanelRightClose className="h-4 w-4" />
          )}
        </Button>
      </div>
    </header>
  )
}
