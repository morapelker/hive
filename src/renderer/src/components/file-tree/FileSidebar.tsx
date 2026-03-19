import { useState, useEffect, useMemo } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { FileTree } from './FileTree'
import { ChangesView } from './ChangesView'
import { BranchDiffView } from './BranchDiffView'
import { PRCommentsView } from '@/components/pr-comments'

interface ConnectionMemberInfo {
  worktree_path: string
  project_name: string
  worktree_branch: string
}

interface FileSidebarProps {
  worktreePath: string | null
  isConnectionMode?: boolean
  connectionMembers?: ConnectionMemberInfo[]
  onClose: () => void
  onFileClick: (node: { path: string; name: string; isDirectory: boolean }) => void
  className?: string
}

export function FileSidebar({
  worktreePath,
  isConnectionMode,
  connectionMembers,
  onClose,
  onFileClick,
  className
}: FileSidebarProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'changes' | 'files' | 'diffs' | 'comments'>('changes')
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)

  // Get worktree data to check for attached PR
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const worktree = useMemo(() => {
    if (!selectedWorktreeId) return null
    for (const wts of worktreesByProject.values()) {
      const found = wts.find((w) => w.id === selectedWorktreeId)
      if (found) return found
    }
    return null
  }, [selectedWorktreeId, worktreesByProject])
  const hasPR = worktree?.github_pr_number != null

  // Auto-switch away from Comments tab if PR is detached
  useEffect(() => {
    if (activeTab === 'comments' && !hasPR) {
      setActiveTab('changes')
    }
  }, [activeTab, hasPR])

  useEffect(() => {
    const handler = (e: Event): void => {
      if (!vimModeEnabled) return
      const tab = (e as CustomEvent).detail?.tab
      if (tab === 'changes' || tab === 'files' || tab === 'diffs' || tab === 'comments') {
        setActiveTab(tab)
      }
    }
    window.addEventListener('hive:right-sidebar-tab', handler)
    return () => window.removeEventListener('hive:right-sidebar-tab', handler)
  }, [vimModeEnabled])

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="flex items-center border-b border-border px-2 pt-1.5 pb-0">
        <button
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors relative',
            activeTab === 'changes'
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={() => setActiveTab('changes')}
        >
          {vimModeEnabled ? (
            <>
              <span className="text-primary">C</span>hanges
            </>
          ) : (
            'Changes'
          )}
          {activeTab === 'changes' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
          )}
        </button>
        <button
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors relative',
            activeTab === 'files'
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={() => setActiveTab('files')}
        >
          {vimModeEnabled ? (
            <>
              <span className="text-primary">F</span>iles
            </>
          ) : (
            'Files'
          )}
          {activeTab === 'files' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
          )}
        </button>
        <button
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors relative',
            activeTab === 'diffs'
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={() => setActiveTab('diffs')}
        >
          {vimModeEnabled ? (
            <>
              <span className="text-primary">D</span>iffs
            </>
          ) : (
            'Diffs'
          )}
          {activeTab === 'diffs' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
          )}
        </button>
        {hasPR && (
          <button
            className={cn(
              'px-3 py-1.5 text-xs font-medium transition-colors relative',
              activeTab === 'comments'
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setActiveTab('comments')}
          >
            {vimModeEnabled ? (
              <>
                Co<span className="text-primary">m</span>ments
              </>
            ) : (
              'Comments'
            )}
            {activeTab === 'comments' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="p-1 text-muted-foreground hover:text-foreground rounded"
          aria-label="Close sidebar"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === 'changes' ? (
          <ChangesView
            worktreePath={worktreePath}
            isConnectionMode={isConnectionMode}
            connectionMembers={connectionMembers}
          />
        ) : activeTab === 'diffs' ? (
          <BranchDiffView worktreePath={worktreePath} />
        ) : activeTab === 'comments' && selectedWorktreeId ? (
          <PRCommentsView worktreeId={selectedWorktreeId} />
        ) : (
          <FileTree
            worktreePath={worktreePath}
            isConnectionMode={isConnectionMode}
            onClose={onClose}
            onFileClick={onFileClick}
            hideHeader
            hideGitIndicators
            hideGitContextActions
          />
        )}
      </div>
    </div>
  )
}
