import { useState, useEffect, useRef, useMemo, memo } from 'react'
import { ChevronDown, Search, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { diffTabAbsolutePath } from '@/stores/useFileViewerStore'
import { useFileTabState } from '@/hooks/useFileTabState'
import { FileIcon } from './FileIcon'
import { GitStatusIndicator, type GitStatusCode } from './GitStatusIndicator'
import { OpenTabIndicator } from './OpenTabIndicator'
import { activeTabRowClass } from './open-tab-classes'

/**
 * Pieces shared by the single-worktree Diffs tab (BranchDiffView) and the
 * connection Diffs tab (ConnectionBranchDiffView): the branch picker and the
 * file row. Data loading stays in each view since they differ in shape.
 */

export interface BranchDiffFile {
  relativePath: string
  status: string
}

export interface BranchInfo {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

const KNOWN_STATUS_CODES: GitStatusCode[] = ['M', 'A', 'D', '?', 'C', '']

function toGitStatusCode(raw: string): GitStatusCode {
  return KNOWN_STATUS_CODES.includes(raw as GitStatusCode) ? (raw as GitStatusCode) : 'M'
}

interface BranchSelectDropdownProps {
  branches: BranchInfo[]
  selectedBranch: string | null
  onSelect: (branch: string) => void
  disabled?: boolean
  placeholder?: string
  /** Shown in place of "No branches found" when the list is empty and unfiltered. */
  emptyMessage?: string
  /** Optional content rendered below the branch list (e.g. per-member warnings). */
  footer?: React.ReactNode
}

/** Searchable branch picker with Local / Remote sections and a "current" tag. */
export function BranchSelectDropdown({
  branches,
  selectedBranch,
  onSelect,
  disabled,
  placeholder = 'Select branch to compare...',
  emptyMessage = 'No branches found',
  footer
}: BranchSelectDropdownProps): React.JSX.Element {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [searchFilter, setSearchFilter] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

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

  const handleSelect = (branch: string): void => {
    onSelect(branch)
    setDropdownOpen(false)
    setSearchFilter('')
  }

  // Split branches into local-first, remote-second, filtered by search
  const filteredBranches = useMemo(() => {
    const lower = searchFilter.toLowerCase()
    const filtered = branches.filter((b) => b.name.toLowerCase().includes(lower))
    const local = filtered.filter((b) => !b.isRemote)
    const remote = filtered.filter((b) => b.isRemote)
    return { local, remote }
  }, [branches, searchFilter])

  const isEmpty = filteredBranches.local.length === 0 && filteredBranches.remote.length === 0

  return (
    <div className="px-2 py-1.5 border-b border-border relative" ref={dropdownRef}>
      <button
        type="button"
        className={cn(
          'flex items-center gap-1.5 w-full px-2 py-1 text-xs rounded',
          'border border-border bg-background hover:bg-accent/50 transition-colors'
        )}
        onClick={() => setDropdownOpen((prev) => !prev)}
        disabled={disabled}
        data-testid="branch-select-trigger"
      >
        <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="truncate flex-1 text-left">{selectedBranch || placeholder}</span>
        <ChevronDown
          className={cn(
            'h-3 w-3 text-muted-foreground shrink-0 transition-transform',
            dropdownOpen && 'rotate-180'
          )}
        />
      </button>

      {dropdownOpen && (
        <div
          className="absolute left-0 right-0 mt-1 mx-2 z-50 rounded-[11px] border border-black/14 dark:border-white/14 bg-[rgba(255,255,255,0.82)] dark:bg-[rgba(0,0,0,0.72)] backdrop-blur-2xl shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.04)] max-h-64 flex flex-col overflow-hidden"
          data-testid="branch-select-menu"
        >
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
                      'flex items-center gap-1.5 w-full px-2 py-1 text-xs hover:bg-black/6 dark:hover:bg-white/8',
                      branch.name === selectedBranch && 'bg-accent text-accent-foreground'
                    )}
                    onClick={() => handleSelect(branch.name)}
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
                      'flex items-center gap-1.5 w-full px-2 py-1 text-xs hover:bg-black/6 dark:hover:bg-white/8',
                      branch.name === selectedBranch && 'bg-accent text-accent-foreground'
                    )}
                    onClick={() => handleSelect(branch.name)}
                  >
                    <span className="truncate">{branch.name}</span>
                  </button>
                ))}
              </div>
            )}

            {isEmpty && (
              <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                {searchFilter ? 'No branches found' : emptyMessage}
              </div>
            )}
          </div>

          {footer}
        </div>
      )}
    </div>
  )
}

interface BranchDiffFileRowProps {
  file: BranchDiffFile
  worktreePath: string
  onClick: (file: BranchDiffFile) => void
}

// Memoized because this list is not virtualized: without it every row re-renders
// whenever a tab opens or closes.
export const BranchDiffFileRow = memo(function BranchDiffFileRow({
  file,
  worktreePath,
  onClick
}: BranchDiffFileRowProps): React.JSX.Element {
  const fileName = file.relativePath.split('/').pop() || file.relativePath
  const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : null
  const tabState = useFileTabState(
    diffTabAbsolutePath({ worktreePath, filePath: file.relativePath })
  )

  return (
    <div
      className={cn(
        'relative flex items-center gap-1.5 px-2 py-0.5 hover:bg-accent/30 cursor-pointer',
        activeTabRowClass(tabState)
      )}
      onClick={() => onClick(file)}
      data-testid={`branch-diff-file-${file.relativePath}`}
    >
      <OpenTabIndicator state={tabState} />
      <FileIcon name={fileName} extension={ext} isDirectory={false} className="h-3.5 w-3.5" />
      <span className="text-xs truncate flex-1" title={file.relativePath}>
        {file.relativePath}
      </span>
      <GitStatusIndicator status={toGitStatusCode(file.status)} className="mr-1" />
    </div>
  )
})
