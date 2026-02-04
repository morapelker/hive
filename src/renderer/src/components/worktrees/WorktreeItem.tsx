import {
  GitBranch,
  MoreHorizontal,
  Terminal,
  Code,
  Archive,
  GitBranchPlus,
  Copy,
  ExternalLink
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useWorktreeStore } from '@/stores'

interface Worktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  created_at: string
  last_accessed_at: string
}

interface WorktreeItemProps {
  worktree: Worktree
  projectPath: string
}

export function WorktreeItem({ worktree, projectPath }: WorktreeItemProps): React.JSX.Element {
  const { selectedWorktreeId, selectWorktree, archiveWorktree, unbranchWorktree } =
    useWorktreeStore()

  const isSelected = selectedWorktreeId === worktree.id

  const handleClick = (): void => {
    selectWorktree(worktree.id)
  }

  const handleOpenInTerminal = async (): Promise<void> => {
    const result = await window.worktreeOps.openInTerminal(worktree.path)
    if (result.success) {
      toast.success('Opened in Terminal')
    } else {
      toast.error(result.error || 'Failed to open in terminal')
    }
  }

  const handleOpenInEditor = async (): Promise<void> => {
    const result = await window.worktreeOps.openInEditor(worktree.path)
    if (result.success) {
      toast.success('Opened in Editor')
    } else {
      toast.error(result.error || 'Failed to open in editor')
    }
  }

  const handleOpenInFinder = async (): Promise<void> => {
    await window.projectOps.showInFolder(worktree.path)
  }

  const handleCopyPath = async (): Promise<void> => {
    await window.projectOps.copyToClipboard(worktree.path)
    toast.success('Path copied to clipboard')
  }

  const handleArchive = async (): Promise<void> => {
    const result = await archiveWorktree(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      projectPath
    )
    if (result.success) {
      toast.success('Worktree archived and branch deleted')
    } else {
      toast.error(result.error || 'Failed to archive worktree')
    }
  }

  const handleUnbranch = async (): Promise<void> => {
    const result = await unbranchWorktree(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      projectPath
    )
    if (result.success) {
      toast.success('Worktree removed (branch preserved)')
    } else {
      toast.error(result.error || 'Failed to unbranch worktree')
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group flex items-center gap-1.5 pl-8 pr-2 py-1 rounded-md cursor-pointer transition-colors',
            isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
          )}
          onClick={handleClick}
          data-testid={`worktree-item-${worktree.id}`}
        >
          {/* Branch Icon */}
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

          {/* Worktree Name */}
          <span className="flex-1 text-sm truncate" title={worktree.path}>
            {worktree.name}
          </span>

          {/* More Options Dropdown (visible on hover) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity',
                  'hover:bg-accent'
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52" align="end">
              <DropdownMenuItem onClick={handleOpenInTerminal}>
                <Terminal className="h-4 w-4 mr-2" />
                Open in Terminal
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleOpenInEditor}>
                <Code className="h-4 w-4 mr-2" />
                Open in Editor
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleOpenInFinder}>
                <ExternalLink className="h-4 w-4 mr-2" />
                Open in Finder
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyPath}>
                <Copy className="h-4 w-4 mr-2" />
                Copy Path
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleUnbranch}>
                <GitBranchPlus className="h-4 w-4 mr-2" />
                Unbranch
                <span className="ml-auto text-xs text-muted-foreground">Keep branch</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleArchive}
                className="text-destructive focus:text-destructive focus:bg-destructive/10"
              >
                <Archive className="h-4 w-4 mr-2" />
                Archive
                <span className="ml-auto text-xs text-muted-foreground">Delete branch</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>

      {/* Context Menu (right-click) */}
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={handleOpenInTerminal}>
          <Terminal className="h-4 w-4 mr-2" />
          Open in Terminal
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInEditor}>
          <Code className="h-4 w-4 mr-2" />
          Open in Editor
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInFinder}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Open in Finder
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyPath}>
          <Copy className="h-4 w-4 mr-2" />
          Copy Path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleUnbranch}>
          <GitBranchPlus className="h-4 w-4 mr-2" />
          Unbranch
          <span className="ml-auto text-xs text-muted-foreground">Keep branch</span>
        </ContextMenuItem>
        <ContextMenuItem
          onClick={handleArchive}
          className="text-destructive focus:text-destructive focus:bg-destructive/10"
        >
          <Archive className="h-4 w-4 mr-2" />
          Archive
          <span className="ml-auto text-xs text-muted-foreground">Delete branch</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
