import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileTree } from './FileTree'
import { ChangesView } from './ChangesView'
import { BranchDiffView } from './BranchDiffView'

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
  const [activeTab, setActiveTab] = useState<'changes' | 'files' | 'diffs'>('changes')

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
          Changes
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
          Files
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
          Diffs
          {activeTab === 'diffs' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
          )}
        </button>
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
