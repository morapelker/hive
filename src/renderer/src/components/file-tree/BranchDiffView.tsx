import { useState, useEffect, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGitStore } from '@/stores/useGitStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { gitApi } from '@/api/git-api'
import {
  BranchDiffFileRow,
  BranchSelectDropdown,
  type BranchDiffFile,
  type BranchInfo
} from './branch-diff-shared'

interface BranchDiffViewProps {
  worktreePath: string | null
}

export function BranchDiffView({ worktreePath }: BranchDiffViewProps): React.JSX.Element {
  const selectedDiffBranch = useGitStore((state) => state.selectedDiffBranch)
  const setSelectedDiffBranch = useGitStore((state) => state.setSelectedDiffBranch)

  const selectedBranch = worktreePath ? (selectedDiffBranch.get(worktreePath) ?? null) : null

  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [files, setFiles] = useState<BranchDiffFile[]>([])
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [isLoadingBranches, setIsLoadingBranches] = useState(false)

  // Load branches
  const loadBranches = useCallback(async () => {
    if (!worktreePath) return
    setIsLoadingBranches(true)
    try {
      const result = await gitApi.listBranchesWithStatus(worktreePath)
      if (result.success && result.branches) {
        setBranches(result.branches)
      }
    } catch (error) {
      console.error('Failed to load branches:', error)
    } finally {
      setIsLoadingBranches(false)
    }
  }, [worktreePath])

  // Load diff files for selected branch
  const loadDiffFiles = useCallback(async () => {
    if (!worktreePath || !selectedBranch) {
      setFiles([])
      return
    }
    setIsLoadingFiles(true)
    try {
      const result = await gitApi.getBranchDiffFiles(worktreePath, selectedBranch)
      if (result.success && result.files) {
        setFiles(result.files)
        setDiffError(null)
      } else {
        setFiles([])
        setDiffError(result.error || 'Failed to load diff files')
      }
    } catch (error) {
      console.error('Failed to load branch diff files:', error)
      setFiles([])
      setDiffError(error instanceof Error ? error.message : 'Failed to load diff files')
    } finally {
      setIsLoadingFiles(false)
    }
  }, [worktreePath, selectedBranch])

  // Initial load of branches
  useEffect(() => {
    loadBranches()
  }, [loadBranches])

  // Load files when selected branch changes
  useEffect(() => {
    loadDiffFiles()
  }, [loadDiffFiles])

  // Listen for git status changes to auto-refresh file list
  useEffect(() => {
    if (!worktreePath || !selectedBranch) return
    const cleanup = gitApi.onStatusChanged((event) => {
      if (event.worktreePath === worktreePath) {
        loadDiffFiles()
      }
    })
    return cleanup
  }, [worktreePath, selectedBranch, loadDiffFiles])

  const handleSelectBranch = useCallback(
    (branch: string) => {
      if (!worktreePath) return
      setSelectedDiffBranch(worktreePath, branch)
    },
    [worktreePath, setSelectedDiffBranch]
  )

  const handleFileClick = useCallback(
    (file: BranchDiffFile) => {
      if (!worktreePath || !selectedBranch) return
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
    [worktreePath, selectedBranch]
  )

  const handleRefresh = useCallback(async () => {
    await Promise.all([loadBranches(), loadDiffFiles()])
  }, [loadBranches, loadDiffFiles])

  if (!worktreePath) {
    return <div className="p-4 text-sm text-muted-foreground text-center">No worktree selected</div>
  }

  return (
    <div className="flex flex-col h-full" data-testid="branch-diff-view">
      {/* Branch selector */}
      <BranchSelectDropdown
        branches={branches}
        selectedBranch={selectedBranch}
        onSelect={handleSelectBranch}
        disabled={isLoadingBranches}
      />

      {/* File list */}
      {!selectedBranch ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Select a branch to see differences
        </div>
      ) : isLoadingFiles ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Loading...
        </div>
      ) : diffError ? (
        <div className="flex-1 flex items-center justify-center text-xs text-destructive px-4 text-center">
          {diffError}
        </div>
      ) : files.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          No differences
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {files.map((file) => (
            <BranchDiffFileRow
              key={file.relativePath}
              file={file}
              worktreePath={worktreePath}
              onClick={handleFileClick}
            />
          ))}
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center justify-between px-2 py-1 border-t border-border bg-muted/30">
        <span className="text-[10px] text-muted-foreground">
          {selectedBranch
            ? `${files.length} file${files.length === 1 ? '' : 's'} changed`
            : 'No branch selected'}
        </span>
        <button
          className={cn(
            'p-0.5 text-muted-foreground hover:text-foreground rounded',
            isLoadingFiles && 'animate-spin'
          )}
          onClick={handleRefresh}
          disabled={isLoadingFiles}
          title="Refresh"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}
