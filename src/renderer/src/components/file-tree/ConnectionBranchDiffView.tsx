import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { RefreshCw, ChevronDown, ChevronRight, GitBranch, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGitStore } from '@/stores/useGitStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { gitApi } from '@/api/git-api'
import {
  connectionDiffBranchKey,
  describeMemberGitError,
  intersectMemberBranches,
  type MemberBranchListing
} from '@/lib/connection-branch-diff'
import { BranchDiffFileRow, BranchSelectDropdown, type BranchDiffFile } from './branch-diff-shared'

interface ConnectionMemberInfo {
  worktree_path: string
  project_name: string
  worktree_branch: string
}

interface ConnectionBranchDiffViewProps {
  members: ConnectionMemberInfo[]
}

interface MemberDiffState {
  files: BranchDiffFile[]
  isLoading: boolean
  error: string | null
}

const EMPTY_DIFF: MemberDiffState = { files: [], isLoading: false, error: null }
// Same cap as the Changes tab's member sections, so one big repo cannot push
// the others off-screen.
const MEMBER_MAX_HEIGHT = 300
const LOADING_DIFF: MemberDiffState = { files: [], isLoading: true, error: null }
// Status events fire per saved file; coalesce them before re-listing branches.
const BRANCH_RELOAD_DEBOUNCE_MS = 750

async function loadMemberBranches(worktreePath: string): Promise<MemberBranchListing> {
  try {
    const result = await gitApi.listBranchesWithStatus(worktreePath)
    if (result.success && result.branches) {
      return { worktreePath, branches: result.branches }
    }
    return {
      worktreePath,
      error: describeMemberGitError(result.error || 'Failed to load branches')
    }
  } catch (error) {
    return {
      worktreePath,
      error: describeMemberGitError(
        error instanceof Error ? error.message : 'Failed to load branches'
      )
    }
  }
}

async function loadMemberDiffFiles(
  worktreePath: string,
  branch: string
): Promise<Pick<MemberDiffState, 'files' | 'error'>> {
  try {
    const result = await gitApi.getBranchDiffFiles(worktreePath, branch)
    if (result.success && result.files) {
      return { files: result.files, error: null }
    }
    return { files: [], error: describeMemberGitError(result.error || 'Failed to load diff files') }
  } catch (error) {
    return {
      files: [],
      error: describeMemberGitError(
        error instanceof Error ? error.message : 'Failed to load diff files'
      )
    }
  }
}

/**
 * Diffs tab for a connection: one compare branch (offered only when every
 * member repo has a branch of that name), then a collapsible section per
 * member listing the files that differ in that member's worktree, the same
 * way the Changes tab shows per-member working-tree changes.
 */
export function ConnectionBranchDiffView({
  members
}: ConnectionBranchDiffViewProps): React.JSX.Element {
  const connectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectionKey = connectionId ? connectionDiffBranchKey(connectionId) : null
  const rememberedBranch = useGitStore((s) =>
    selectionKey ? (s.selectedDiffBranch.get(selectionKey) ?? null) : null
  )
  const setSelectedDiffBranch = useGitStore((s) => s.setSelectedDiffBranch)
  const branchInfoByWorktree = useGitStore((s) => s.branchInfoByWorktree)

  const [listings, setListings] = useState<MemberBranchListing[]>([])
  const [isLoadingBranches, setIsLoadingBranches] = useState(false)
  const [diffByMember, setDiffByMember] = useState<Map<string, MemberDiffState>>(new Map())
  const [collapsedMembers, setCollapsedMembers] = useState<Set<string>>(new Set())

  // Member paths keyed by content so effects only re-run when the set changes,
  // not when the store hands out a fresh members array with the same entries.
  const memberPathsKey = members.map((m) => m.worktree_path).join('\n')
  const memberPaths = useMemo(
    () => (memberPathsKey ? memberPathsKey.split('\n') : []),
    [memberPathsKey]
  )

  // Guards against stale async results landing after members/branch changed.
  const branchesRequestRef = useRef(0)
  const diffRequestRef = useRef(new Map<string, number>())

  // Load every member's branch list; the picker shows the intersection.
  const loadBranches = useCallback(async () => {
    const requestId = ++branchesRequestRef.current
    if (memberPaths.length === 0) {
      setListings([])
      return
    }
    setIsLoadingBranches(true)
    try {
      const results = await Promise.all(memberPaths.map(loadMemberBranches))
      if (requestId !== branchesRequestRef.current) return
      setListings(results)
    } finally {
      if (requestId === branchesRequestRef.current) setIsLoadingBranches(false)
    }
  }, [memberPaths])

  // Load (or reload) the branch diff for one member. A refresh keeps the
  // previous rows visible while loading so the list does not flicker.
  const loadMemberDiff = useCallback(
    async (worktreePath: string, branch: string) => {
      const requestId = (diffRequestRef.current.get(worktreePath) ?? 0) + 1
      diffRequestRef.current.set(worktreePath, requestId)
      setDiffByMember((prev) => {
        const next = new Map(prev)
        next.set(worktreePath, { ...(prev.get(worktreePath) ?? EMPTY_DIFF), isLoading: true })
        return next
      })
      const result = await loadMemberDiffFiles(worktreePath, branch)
      if (diffRequestRef.current.get(worktreePath) !== requestId) return
      setDiffByMember((prev) => {
        const next = new Map(prev)
        next.set(worktreePath, { ...result, isLoading: false })
        return next
      })
    },
    []
  )

  const commonBranches = useMemo(() => intersectMemberBranches(listings), [listings])

  // The remembered branch only stays selected while every member still has it
  // (a member may have been added, or a branch deleted, since it was picked).
  const selectedBranch = useMemo(
    () =>
      rememberedBranch && commonBranches.some((b) => b.name === rememberedBranch)
        ? rememberedBranch
        : null,
    [rememberedBranch, commonBranches]
  )

  const loadAllDiffs = useCallback(async () => {
    if (!selectedBranch) {
      setDiffByMember(new Map())
      return
    }
    setDiffByMember(new Map(memberPaths.map((p) => [p, LOADING_DIFF])))
    await Promise.all(memberPaths.map((p) => loadMemberDiff(p, selectedBranch)))
  }, [selectedBranch, memberPaths, loadMemberDiff])

  useEffect(() => {
    loadBranches()
  }, [loadBranches])

  useEffect(() => {
    loadAllDiffs()
  }, [loadAllDiffs])

  // A git status change in any member refreshes just that member's diff. The
  // worktree watcher also raises this for HEAD/refs changes (checkout, fetch,
  // branch create/delete), so the common-branch list is re-derived too, but
  // debounced since a burst of saves raises one event per file.
  useEffect(() => {
    if (memberPaths.length === 0) return
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = gitApi.onStatusChanged((event) => {
      if (!memberPaths.includes(event.worktreePath)) return
      if (selectedBranch) loadMemberDiff(event.worktreePath, selectedBranch)
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        loadBranches()
      }, BRANCH_RELOAD_DEBOUNCE_MS)
    })
    return () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      cleanup()
    }
  }, [selectedBranch, memberPaths, loadMemberDiff, loadBranches])

  // A member switching branch changes what is common (and what is "current").
  // Only fires for worktrees with a branch watcher (expanded sidebar projects);
  // the status listener above covers the rest.
  useEffect(() => {
    if (memberPaths.length === 0) return
    const cleanup = gitApi.onBranchChanged((event) => {
      if (memberPaths.includes(event.worktreePath)) {
        loadBranches()
      }
    })
    return cleanup
  }, [memberPaths, loadBranches])

  const failedListings = useMemo(
    () =>
      listings
        .filter((l) => l.error)
        .map((l) => ({
          worktreePath: l.worktreePath,
          projectName:
            members.find((m) => m.worktree_path === l.worktreePath)?.project_name ??
            l.worktreePath,
          error: l.error as string
        })),
    [listings, members]
  )
  const allListingsFailed = listings.length > 0 && failedListings.length === listings.length
  // Background re-lists (after status events) keep the picker usable; only the
  // first load, when nothing is known yet, locks it.
  const isInitialBranchLoad = isLoadingBranches && listings.length === 0

  const handleSelectBranch = useCallback(
    (branch: string) => {
      if (!selectionKey) return
      setSelectedDiffBranch(selectionKey, branch)
    },
    [selectionKey, setSelectedDiffBranch]
  )

  const handleFileClick = useCallback(
    (worktreePath: string, file: BranchDiffFile) => {
      if (!selectedBranch) return
      const fileName = file.relativePath.split('/').pop() || file.relativePath
      useFileViewerStore.getState().setActiveDiff({
        worktreePath,
        filePath: file.relativePath,
        fileName,
        staged: false,
        isUntracked: false,
        compareBranch: selectedBranch
      })
    },
    [selectedBranch]
  )

  const toggleMember = useCallback((path: string) => {
    setCollapsedMembers((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const isLoadingAnyDiff = useMemo(
    () => Array.from(diffByMember.values()).some((d) => d.isLoading),
    [diffByMember]
  )

  const handleRefresh = useCallback(async () => {
    await Promise.all([loadBranches(), loadAllDiffs()])
  }, [loadBranches, loadAllDiffs])

  const summary = useMemo(() => {
    let totalFiles = 0
    let reposWithChanges = 0
    for (const path of memberPaths) {
      const count = diffByMember.get(path)?.files.length ?? 0
      totalFiles += count
      if (count > 0) reposWithChanges += 1
    }
    return { totalFiles, reposWithChanges }
  }, [memberPaths, diffByMember])

  if (members.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground text-center">No connection members</div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="connection-branch-diff-view">
      {/* Branch selector: only branches every member has */}
      <BranchSelectDropdown
        branches={commonBranches}
        selectedBranch={selectedBranch}
        onSelect={handleSelectBranch}
        disabled={isInitialBranchLoad}
        placeholder={
          isInitialBranchLoad ? 'Loading branches...' : 'Select a branch common to all repos...'
        }
        emptyMessage={
          allListingsFailed ? 'Could not load branches' : 'No branches shared by all repos'
        }
        footer={
          failedListings.length > 0 ? (
            <div
              className="px-2 py-1.5 border-t border-border text-[10px] text-destructive space-y-0.5"
              data-testid="branch-listing-errors"
            >
              {failedListings.map((f) => (
                <div key={f.worktreePath} className="flex items-start gap-1">
                  <AlertTriangle className="h-3 w-3 shrink-0 mt-px" />
                  <span className="truncate">
                    {f.projectName}: {f.error}
                  </span>
                </div>
              ))}
            </div>
          ) : null
        }
      />

      {/* Per-member sections */}
      {!selectedBranch ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground px-4 text-center">
          {isInitialBranchLoad
            ? 'Loading branches...'
            : rememberedBranch && listings.length > 0
              ? `"${rememberedBranch}" is no longer shared by all repos. Select another branch.`
              : `Select a branch to see differences across ${members.length} repo${members.length === 1 ? '' : 's'}`}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {members.map((member) => {
            const diff = diffByMember.get(member.worktree_path) ?? EMPTY_DIFF
            const isCollapsed = collapsedMembers.has(member.worktree_path)
            const hasNoChanges = !diff.isLoading && !diff.error && diff.files.length === 0
            const currentBranch =
              branchInfoByWorktree.get(member.worktree_path)?.name || member.worktree_branch

            return (
              <div
                key={member.worktree_path}
                className="border-b border-border last:border-b-0"
                data-testid={`branch-diff-member-${member.worktree_path}`}
              >
                {/* Member header */}
                <button
                  type="button"
                  className="flex items-center justify-between w-full px-2 py-1.5 text-xs hover:bg-accent/50"
                  onClick={() => toggleMember(member.worktree_path)}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    {isCollapsed || hasNoChanges ? (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="font-medium truncate">{member.project_name}</span>
                    <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground truncate">{currentBranch || '...'}</span>
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    {diff.isLoading ? (
                      <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
                    ) : diff.error ? (
                      <AlertTriangle className="h-3 w-3 text-destructive" />
                    ) : hasNoChanges ? (
                      <span className="text-muted-foreground text-[10px]">no diff</span>
                    ) : (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-muted">
                        {diff.files.length}
                      </span>
                    )}
                  </span>
                </button>

                {/* Member content */}
                {!isCollapsed && diff.error && (
                  <div className="px-4 pb-2 text-xs text-destructive">{diff.error}</div>
                )}
                {!isCollapsed && !diff.error && diff.files.length > 0 && (
                  <div
                    className="pl-3 pb-1 overflow-y-auto"
                    style={{ maxHeight: `${MEMBER_MAX_HEIGHT}px` }}
                  >
                    {diff.files.map((file) => (
                      <BranchDiffFileRow
                        key={file.relativePath}
                        file={file}
                        worktreePath={member.worktree_path}
                        onClick={(f) => handleFileClick(member.worktree_path, f)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center justify-between px-2 py-1 border-t border-border bg-muted/30">
        <span className="text-[10px] text-muted-foreground">
          {!selectedBranch
            ? isInitialBranchLoad
              ? 'Loading...'
              : 'No branch selected'
            : summary.totalFiles === 0
              ? 'No differences'
              : `${summary.totalFiles} file${summary.totalFiles === 1 ? '' : 's'} changed across ${summary.reposWithChanges} repo${summary.reposWithChanges === 1 ? '' : 's'}`}
        </span>
        <button
          className={cn(
            'p-0.5 text-muted-foreground hover:text-foreground rounded',
            (isLoadingAnyDiff || isLoadingBranches) && 'animate-spin'
          )}
          onClick={handleRefresh}
          disabled={isLoadingAnyDiff || isLoadingBranches}
          title="Refresh all"
          data-testid="connection-branch-diff-refresh"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}
