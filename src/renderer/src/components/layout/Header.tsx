import { useCallback, useEffect, useState } from 'react'
import {
  PanelRightClose,
  PanelRightOpen,
  History,
  Settings,
  AlertTriangle,
  GitPullRequest,
  GitMerge,
  Archive,
  ChevronDown,
  Loader2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { toast } from '@/lib/toast'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useSessionHistoryStore } from '@/stores/useSessionHistoryStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useGitStore } from '@/stores/useGitStore'
import { QuickActions } from './QuickActions'
import { usePRDetection } from '@/hooks/usePRDetection'
import hiveLogo from '@/assets/icon.png'

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
  const branchInfoByWorktree = useGitStore((state) => state.branchInfoByWorktree)
  const branchInfo = selectedWorktree?.path
    ? branchInfoByWorktree.get(selectedWorktree.path)
    : undefined
  const isOperating = useGitStore((state) => state.isPushing || state.isPulling)

  // PR lifecycle state
  const prInfo = useGitStore((s) =>
    selectedWorktreeId ? s.prInfo.get(selectedWorktreeId) : undefined
  )
  const prState = prInfo?.state ?? 'none'

  // Clean tree detection for merge button visibility
  const fileStatuses = useGitStore((s) =>
    selectedWorktree?.path ? s.fileStatusesByWorktree.get(selectedWorktree.path) : undefined
  )
  const isCleanTree = !fileStatuses || fileStatuses.length === 0

  // Load remote branches for the PR target dropdown
  const [remoteBranches, setRemoteBranches] = useState<{ name: string }[]>([])
  useEffect(() => {
    if (!isGitHub || !selectedWorktree?.path) {
      setRemoteBranches([])
      return
    }
    window.gitOps.listBranchesWithStatus(selectedWorktree.path).then((result) => {
      if (result.success) {
        setRemoteBranches(result.branches.filter((b: { isRemote: boolean }) => b.isRemote))
      }
    })
  }, [isGitHub, selectedWorktree?.path])

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
    useGitStore.getState().setPrState(wtId, {
      state: 'creating',
      sessionId: result.session.id,
      targetBranch
    })
  }, [selectedWorktree?.path, selectedWorktreeId, prTargetBranch, branchInfo])

  const handleMergePR = useCallback(async () => {
    if (!selectedWorktree?.path || !selectedWorktreeId) return
    const pr = useGitStore.getState().prInfo.get(selectedWorktreeId)
    if (!pr?.prNumber) return

    try {
      const result = await window.gitOps.prMerge(selectedWorktree.path, pr.prNumber)
      if (result.success) {
        toast.success('PR merged successfully')
        useGitStore.getState().setPrState(selectedWorktreeId, { ...pr, state: 'merged' })
      } else {
        toast.error(`Merge failed: ${result.error}`)
      }
    } catch {
      toast.error('Failed to merge PR')
    }
  }, [selectedWorktree?.path, selectedWorktreeId])

  const handleArchiveWorktree = useCallback(async () => {
    if (!selectedWorktreeId || !selectedWorktree || !selectedProject) return
    await useWorktreeStore
      .getState()
      .archiveWorktree(
        selectedWorktreeId,
        selectedWorktree.path,
        selectedWorktree.branch_name,
        selectedProject.path
      )
  }, [selectedWorktreeId, selectedWorktree, selectedProject])

  const handleFixConflicts = async () => {
    if (!selectedWorktreeId || !selectedProjectId) return
    const { success, session } = await createSession(selectedWorktreeId, selectedProjectId)
    if (!success || !session) return

    const branchName = selectedWorktree?.branch_name || 'unknown'
    await updateSessionName(session.id, `Merge Conflicts -- ${branchName}`)
    setPendingMessage(session.id, 'Fix merge conflicts')
    setActiveSession(session.id)
  }

  return (
    <header
      className="h-12 border-b bg-background flex items-center justify-between px-4 flex-shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      data-testid="header"
    >
      {/* Spacer for macOS traffic lights */}
      <div className="w-16 flex-shrink-0" />
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <img src={hiveLogo} alt="Hive" className="h-5 w-5 shrink-0 rounded" draggable={false} />
        {selectedProject ? (
          <span className="text-sm font-medium truncate" data-testid="header-project-info">
            {selectedProject.name}
            {selectedWorktree?.branch_name && selectedWorktree.name !== '(no-worktree)' && (
              <span className="text-primary font-normal"> ({selectedWorktree.branch_name})</span>
            )}
          </span>
        ) : (
          <span className="text-sm font-medium">Hive</span>
        )}
      </div>
      {/* Center: Quick Actions */}
      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <QuickActions />
      </div>
      {hasConflicts && (
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-xs font-semibold"
            onClick={handleFixConflicts}
            data-testid="fix-conflicts-button"
          >
            <AlertTriangle className="h-3.5 w-3.5 mr-1" />
            Fix conflicts
          </Button>
        </div>
      )}
      <div className="flex-1" />
      <div
        className="flex items-center gap-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {isGitHub && prState === 'merged' && (
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-xs"
            onClick={handleArchiveWorktree}
            title="Archive worktree"
            data-testid="pr-archive-button"
          >
            <Archive className="h-3.5 w-3.5 mr-1" />
            Archive
          </Button>
        )}
        {isGitHub && prState === 'created' && isCleanTree && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs bg-emerald-600/10 border-emerald-600/30 text-emerald-500 hover:bg-emerald-600/20"
            onClick={handleMergePR}
            title="Merge Pull Request"
            data-testid="pr-merge-button"
          >
            <GitMerge className="h-3.5 w-3.5 mr-1" />
            Merge PR
          </Button>
        )}
        {isGitHub &&
          (prState === 'none' ||
            prState === 'creating' ||
            (prState === 'created' && !isCleanTree)) && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={handleCreatePR}
                disabled={isOperating || prState === 'creating'}
                title="Create Pull Request"
                data-testid="pr-button"
              >
                {prState === 'creating' ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <GitPullRequest className="h-3.5 w-3.5 mr-1" />
                )}
                PR
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
