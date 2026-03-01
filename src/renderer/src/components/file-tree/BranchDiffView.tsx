import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { RefreshCw, ChevronDown, Search, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGitStore } from '@/stores/useGitStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { FileIcon } from './FileIcon'
import { GitStatusIndicator, type GitStatusCode } from './GitStatusIndicator'

interface BranchDiffViewProps {
  worktreePath: string | null
}

interface BranchDiffFile {
  relativePath: string
  status: string
}

interface BranchInfo {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

export function BranchDiffView({ worktreePath }: BranchDiffViewProps): React.JSX.Element {
  const selectedDiffBranch = useGitStore((state) => state.selectedDiffBranch)
  const setSelectedDiffBranch = useGitStore((state) => state.setSelectedDiffBranch)

  const selectedBranch = worktreePath ? selectedDiffBranch.get(worktreePath) ?? null : null

  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [files, setFiles] = useState<BranchDiffFile[]>([])
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)
  const [isLoadingBranches, setIsLoadingBranches] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [searchFilter, setSearchFilter] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Load branches
  const loadBranches = useCallback(async () => {
    if (!worktreePath) return
    setIsLoadingBranches(true)
    try {
      const result = await window.gitOps.listBranchesWithStatus(worktreePath)
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
      const result = await window.gitOps.getBranchDiffFiles(worktreePath, selectedBranch)
      if (result.success && result.files) {
        setFiles(result.files)
      } else {
        setFiles([])
      }
    } catch (error) {
      console.error('Failed to load branch diff files:', error)
      setFiles([])
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
    const cleanup = window.gitOps.onStatusChanged((event) => {
      if (event.worktreePath === worktreePath) {
        loadDiffFiles()
      }
    })
    return cleanup
  }, [worktreePath, selectedBranch, loadDiffFiles])

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    function handleClickOutside(e: MouseEvent): void {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
        setSearchFilter('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dropdownOpen])

  // Focus search when dropdown opens
  useEffect(() => {
    if (dropdownOpen && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [dropdownOpen])

  const handleSelectBranch = useCallback(
    (branch: string) => {
      if (!worktreePath) return
      setSelectedDiffBranch(worktreePath, branch)
      setDropdownOpen(false)
      setSearchFilter('')
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

  // Split branches into local-first, remote-second, filtered by search
  const filteredBranches = useMemo(() => {
    const lower = searchFilter.toLowerCase()
    const filtered = branches.filter((b) => b.name.toLowerCase().includes(lower))
    const local = filtered.filter((b) => !b.isRemote)
    const remote = filtered.filter((b) => b.isRemote)
    return { local, remote }
  }, [branches, searchFilter])

  if (!worktreePath) {
    return (
      <div className="p-4 text-sm text-muted-foreground text-center">No worktree selected</div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="branch-diff-view">
      {/* Branch selector */}
      <div className="px-2 py-1.5 border-b border-border" ref={dropdownRef}>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1.5 w-full px-2 py-1 text-xs rounded',
            'border border-border bg-background hover:bg-accent/50 transition-colors'
          )}
          onClick={() => setDropdownOpen((prev) => !prev)}
          disabled={isLoadingBranches}
        >
          <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="truncate flex-1 text-left">
            {selectedBranch || 'Select branch to compare...'}
          </span>
          <ChevronDown
            className={cn(
              'h-3 w-3 text-muted-foreground shrink-0 transition-transform',
              dropdownOpen && 'rotate-180'
            )}
          />
        </button>

        {dropdownOpen && (
          <div className="absolute left-0 right-0 mt-1 mx-2 z-50 bg-popover border border-border rounded-md shadow-md max-h-64 flex flex-col">
            {/* Search input */}
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
              <Search className="h-3 w-3 text-muted-foreground shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                placeholder="Filter branches..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
              />
            </div>

            {/* Branch list */}
            <div className="overflow-y-auto flex-1">
              {filteredBranches.local.length > 0 && (
                <div>
                  <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Local
                  </div>
                  {filteredBranches.local.map((branch) => (
                    <button
                      key={branch.name}
                      type="button"
                      className={cn(
                        'flex items-center gap-1.5 w-full px-2 py-1 text-xs hover:bg-accent/50',
                        branch.name === selectedBranch && 'bg-accent text-accent-foreground'
                      )}
                      onClick={() => handleSelectBranch(branch.name)}
                    >
                      <span className="truncate">{branch.name}</span>
                      {branch.isCheckedOut && (
                        <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                          current
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {filteredBranches.remote.length > 0 && (
                <div>
                  <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Remote
                  </div>
                  {filteredBranches.remote.map((branch) => (
                    <button
                      key={branch.name}
                      type="button"
                      className={cn(
                        'flex items-center gap-1.5 w-full px-2 py-1 text-xs hover:bg-accent/50',
                        branch.name === selectedBranch && 'bg-accent text-accent-foreground'
                      )}
                      onClick={() => handleSelectBranch(branch.name)}
                    >
                      <span className="truncate">{branch.name}</span>
                    </button>
                  ))}
                </div>
              )}

              {filteredBranches.local.length === 0 && filteredBranches.remote.length === 0 && (
                <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                  No branches found
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* File list */}
      {!selectedBranch ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Select a branch to see differences
        </div>
      ) : isLoadingFiles ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Loading...
        </div>
      ) : files.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          No differences
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {files.map((file) => {
            const fileName = file.relativePath.split('/').pop() || file.relativePath
            const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : null

            return (
              <div
                key={file.relativePath}
                className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-accent/30 cursor-pointer"
                onClick={() => handleFileClick(file)}
                data-testid={`branch-diff-file-${file.relativePath}`}
              >
                <FileIcon
                  name={fileName}
                  extension={ext}
                  isDirectory={false}
                  className="h-3.5 w-3.5"
                />
                <span className="text-xs truncate flex-1" title={file.relativePath}>
                  {file.relativePath}
                </span>
                <GitStatusIndicator
                  status={file.status as GitStatusCode}
                  className="mr-1"
                />
              </div>
            )
          })}
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
