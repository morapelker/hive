import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileTree } from './FileTree'
import { GitStatusPanel } from '@/components/git'

interface FileSidebarProps {
  worktreePath: string | null
  onClose: () => void
  onFileClick: (node: { path: string; name: string; isDirectory: boolean }) => void
  className?: string
}

export function FileSidebar({
  worktreePath,
  onClose,
  onFileClick,
  className
}: FileSidebarProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'changes' | 'files'>('changes')

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
          <div className="flex flex-col h-full overflow-y-auto">
            <GitStatusPanel worktreePath={worktreePath} />
          </div>
        ) : (
          <FileTree
            worktreePath={worktreePath}
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
