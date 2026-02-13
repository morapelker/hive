import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  ArrowUpCircle,
  ArrowDownCircle,
  Loader2,
  ChevronDown,
  GitBranch,
  Globe,
  Search,
  Archive,
  Trash2
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { cn } from '@/lib/utils'

interface BranchInfo {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

interface GitPushPullProps {
  worktreePath: string | null
  className?: string
}

export function GitPushPull({
  worktreePath,
  className
}: GitPushPullProps): React.JSX.Element | null {
  const [mergeBranch, setMergeBranch] = useState('')
  const [isMerging, setIsMerging] = useState(false)
  const [isBranchMerged, setIsBranchMerged] = useState(false)
  const [mergedCheckVersion, setMergedCheckVersion] = useState(0)

  // Branch picker dropdown state
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [branchFilter, setBranchFilter] = useState('')
  const [branchesLoading, setBranchesLoading] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const filterInputRef = useRef<HTMLInputElement>(null)

  const { push, pull, isPushing, isPulling, refreshStatuses } = useGitStore()

  // Subscribe to branch info for ahead/behind counts
  const branchInfoByWorktree = useGitStore((state) => state.branchInfoByWorktree)
  const branchInfo = worktreePath ? branchInfoByWorktree.get(worktreePath) : undefined

  // Cross-worktree merge default: look up the project for this worktree
  const selectedWorktreeId = useWorktreeStore((state) => state.selectedWorktreeId)
  const worktreeProjectId = useWorktreeStore((state) => {
    if (!selectedWorktreeId) return undefined
    for (const [projectId, worktrees] of state.worktreesByProject) {
      if (worktrees.some((w) => w.id === selectedWorktreeId)) return projectId
    }
    return undefined
  })
  const defaultMerge = useGitStore((s) =>
    worktreeProjectId ? s.defaultMergeBranch.get(worktreeProjectId) : undefined
  )
  const mergeSelectionVersion = useGitStore((s) => s.mergeSelectionVersion)
  const currentBranch = branchInfo?.name

  // Reset manual merge selection when a commit happens anywhere
  const prevVersionRef = useRef(mergeSelectionVersion)
  useEffect(() => {
    if (mergeSelectionVersion !== prevVersionRef.current) {
      prevVersionRef.current = mergeSelectionVersion
      setMergeBranch('')
    }
  }, [mergeSelectionVersion])

  // Pre-populate merge branch from cross-worktree default
  useEffect(() => {
    if (defaultMerge && defaultMerge !== currentBranch && !mergeBranch) {
      setMergeBranch(defaultMerge)
    }
  }, [defaultMerge, currentBranch, mergeBranch])

  const hasTracking = !!branchInfo?.tracking
  const ahead = branchInfo?.ahead || 0
  const behind = branchInfo?.behind || 0

  const handlePush = useCallback(async () => {
    if (!worktreePath) return

    const result = await push(worktreePath)

    if (result.success) {
      toast.success('Pushed successfully')
    } else {
      toast.error('Push failed', {
        description: result.error
      })
    }
  }, [worktreePath, push])

  const handlePull = useCallback(async () => {
    if (!worktreePath) return

    const result = await pull(worktreePath)

    if (result.success) {
      toast.success('Pulled successfully')
    } else {
      toast.error('Pull failed', {
        description: result.error
      })
    }
  }, [worktreePath, pull])

  // Load branches when dropdown opens
  useEffect(() => {
    if (!branchDropdownOpen || !worktreePath) return

    setBranchesLoading(true)
    window.gitOps
      .listBranchesWithStatus(worktreePath)
      .then((result) => {
        if (result.success) {
          setBranches(result.branches)
        }
      })
      .finally(() => {
        setBranchesLoading(false)
      })
  }, [branchDropdownOpen, worktreePath])

  // Focus the filter input when dropdown opens
  useEffect(() => {
    if (branchDropdownOpen) {
      requestAnimationFrame(() => {
        filterInputRef.current?.focus()
      })
    } else {
      setBranchFilter('')
    }
  }, [branchDropdownOpen])

  // Close dropdown on outside click
  useEffect(() => {
    if (!branchDropdownOpen) return

    const handleClickOutside = (e: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setBranchDropdownOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [branchDropdownOpen])

  // Filter and sort branches — local first, then remote; exclude current branch
  const filteredBranches = useMemo(() => {
    const currentBranch = branchInfo?.name
    const lowerFilter = branchFilter.toLowerCase()
    const filtered = branches.filter(
      (b) => b.name.toLowerCase().includes(lowerFilter) && b.name !== currentBranch
    )

    return filtered.sort((a, b) => {
      if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1
      return a.name.localeCompare(b.name)
    })
  }, [branches, branchFilter, branchInfo?.name])

  const handleBranchSelect = useCallback((branchName: string) => {
    setMergeBranch(branchName)
    setBranchDropdownOpen(false)
  }, [])

  // Check if the selected merge branch is already merged into HEAD
  // Re-runs when mergedCheckVersion increments (e.g. after a successful merge)
  useEffect(() => {
    if (!worktreePath || !mergeBranch) {
      setIsBranchMerged(false)
      return
    }
    window.gitOps.isBranchMerged(worktreePath, mergeBranch).then((result) => {
      if (result.success) {
        setIsBranchMerged(result.isMerged)
      }
    })
  }, [worktreePath, mergeBranch, mergedCheckVersion])

  // Look up whether the selected merge branch is checked out in a worktree
  const selectedBranchInfo = useMemo(() => {
    if (!mergeBranch) return undefined
    return branches.find((b) => b.name === mergeBranch)
  }, [branches, mergeBranch])

  const handleArchiveWorktree = useCallback(async () => {
    // Archive the worktree that has the SELECTED BRANCH checked out (not our worktree)
    if (!selectedBranchInfo?.worktreePath) return

    const worktreeStore = useWorktreeStore.getState()

    // Find the worktree by its path across all projects
    let worktree: { id: string; path: string; branch_name: string; project_id: string } | undefined
    for (const [_projectId, worktrees] of worktreeStore.worktreesByProject) {
      const found = worktrees.find((w) => w.path === selectedBranchInfo.worktreePath)
      if (found) {
        worktree = found
        break
      }
    }
    if (!worktree) return

    // Get the project path from the project store
    const project = useProjectStore.getState().projects.find((p) => p.id === worktree!.project_id)
    if (!project) return

    const result = await worktreeStore.archiveWorktree(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      project.path
    )
    if (result.success) {
      setMergeBranch('')
    }
  }, [selectedBranchInfo?.worktreePath])

  const handleDeleteBranch = useCallback(async () => {
    if (!worktreePath || !mergeBranch) return
    try {
      const result = await window.gitOps.deleteBranch(worktreePath, mergeBranch)
      if (result.success) {
        toast.success(`Deleted branch ${mergeBranch}`)
        setMergeBranch('')
      } else {
        toast.error('Failed to delete branch', { description: result.error })
      }
    } catch {
      toast.error('Failed to delete branch')
    }
  }, [worktreePath, mergeBranch])

  const handleMerge = useCallback(async () => {
    if (!worktreePath || !mergeBranch.trim()) return
    setIsMerging(true)
    try {
      const result = await window.gitOps.merge(worktreePath, mergeBranch.trim())
      if (result.success) {
        toast.success(`Merged ${mergeBranch} successfully`)
        // Refresh file statuses and branch info after merge
        await refreshStatuses(worktreePath)
        // Re-check if the merged branch is now up-to-date
        setMergedCheckVersion((v) => v + 1)
      } else {
        toast.error('Merge failed', { description: result.error })
      }
    } finally {
      setIsMerging(false)
    }
  }, [worktreePath, mergeBranch, refreshStatuses])

  if (!worktreePath) {
    return null
  }

  const isOperating = isPushing || isPulling || isMerging

  return (
    <div
      className={cn('flex flex-col gap-2 px-2 py-2 border-t', className)}
      data-testid="git-push-pull"
    >
      {/* Push/Pull buttons */}
      <div className="flex gap-2">
        {/* Push button */}
        <Button
          variant="outline"
          size="sm"
          className="flex-1 h-7 text-xs"
          onClick={handlePush}
          disabled={isOperating}
          data-testid="push-button"
        >
          {isPushing ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <ArrowUpCircle className="h-3 w-3 mr-1" />
          )}
          Push
          {ahead > 0 && <span className="ml-1 text-[10px] opacity-75">({ahead})</span>}
        </Button>

        {/* Pull button */}
        <Button
          variant="outline"
          size="sm"
          className="flex-1 h-7 text-xs"
          onClick={handlePull}
          disabled={isOperating || !hasTracking}
          data-testid="pull-button"
        >
          {isPulling ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <ArrowDownCircle className="h-3 w-3 mr-1" />
          )}
          Pull
          {behind > 0 && <span className="ml-1 text-[10px] opacity-75">({behind})</span>}
        </Button>
      </div>

      {/* Merge section */}
      <div className="flex gap-2 items-center border-t pt-2" data-testid="merge-section">
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">Merge from</span>
        <div className="relative flex-1 min-w-0" ref={dropdownRef}>
          <button
            type="button"
            className={cn(
              'flex items-center justify-between w-full bg-background border border-border',
              'rounded px-1.5 py-0.5 text-xs min-w-0',
              'hover:bg-accent/50 transition-colors',
              'focus:outline-none focus:ring-1 focus:ring-ring',
              (isMerging || isOperating) && 'opacity-50 pointer-events-none'
            )}
            onClick={() => setBranchDropdownOpen((v) => !v)}
            disabled={isMerging || isOperating}
            data-testid="merge-branch-trigger"
          >
            <span className="truncate">
              {mergeBranch || <span className="text-muted-foreground">Select branch</span>}
            </span>
            <ChevronDown
              className={cn(
                'h-3 w-3 ml-1 shrink-0 text-muted-foreground transition-transform',
                branchDropdownOpen && 'rotate-180'
              )}
            />
          </button>

          {/* Branch dropdown */}
          {branchDropdownOpen && (
            <div
              className="absolute z-50 bottom-full mb-1 left-0 right-0 bg-popover border border-border
                         rounded-md shadow-md overflow-hidden"
              data-testid="merge-branch-dropdown"
            >
              {/* Filter input */}
              <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
                <Search className="h-3 w-3 text-muted-foreground shrink-0" />
                <input
                  ref={filterInputRef}
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  className="flex-1 bg-transparent text-xs focus:outline-none min-w-0
                             placeholder:text-muted-foreground"
                  placeholder="Filter branches..."
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setBranchDropdownOpen(false)
                    } else if (e.key === 'Enter' && filteredBranches.length === 1) {
                      handleBranchSelect(filteredBranches[0].name)
                    }
                  }}
                />
              </div>

              {/* Branch list */}
              <div className="max-h-[200px] overflow-y-auto">
                {branchesLoading ? (
                  <div className="flex items-center justify-center py-3">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    <span className="ml-1.5 text-xs text-muted-foreground">Loading...</span>
                  </div>
                ) : filteredBranches.length === 0 ? (
                  <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                    {branchFilter ? 'No matching branches' : 'No branches found'}
                  </div>
                ) : (
                  filteredBranches.map((branch) => (
                    <button
                      key={`${branch.name}-${branch.isRemote}`}
                      type="button"
                      className={cn(
                        'flex items-center gap-1.5 w-full px-2 py-1.5 text-xs text-left',
                        'hover:bg-accent hover:text-accent-foreground transition-colors',
                        branch.name === mergeBranch && 'bg-accent/50'
                      )}
                      onClick={() => handleBranchSelect(branch.name)}
                    >
                      <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{branch.name}</span>
                      {branch.isRemote && (
                        <Globe className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        {isBranchMerged && selectedBranchInfo?.isCheckedOut ? (
          <Button
            variant="destructive"
            size="sm"
            className="h-6 text-xs whitespace-nowrap"
            onClick={handleArchiveWorktree}
            data-testid="archive-merged-button"
          >
            <Archive className="h-3 w-3 mr-1" />
            Archive
          </Button>
        ) : isBranchMerged && !selectedBranchInfo?.isRemote ? (
          <Button
            variant="destructive"
            size="sm"
            className="h-6 text-xs whitespace-nowrap"
            onClick={handleDeleteBranch}
            data-testid="delete-branch-button"
          >
            <Trash2 className="h-3 w-3 mr-1" />
            Delete
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs whitespace-nowrap"
            onClick={handleMerge}
            disabled={isMerging || isOperating || !mergeBranch.trim()}
            data-testid="merge-button"
          >
            {isMerging ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Merge'}
          </Button>
        )}
      </div>
    </div>
  )
}
