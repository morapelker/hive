import { useEffect } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useWorktreeStore } from '@/stores'
import { WorktreeItem } from './WorktreeItem'

interface Project {
  id: string
  name: string
  path: string
}

interface WorktreeListProps {
  project: Project
}

export function WorktreeList({ project }: WorktreeListProps): React.JSX.Element {
  const {
    getWorktreesForProject,
    loadWorktrees,
    createWorktree,
    syncWorktrees,
    creatingForProjectId
  } = useWorktreeStore()

  const worktrees = getWorktreesForProject(project.id)
  const isCreating = creatingForProjectId === project.id

  // Load and sync worktrees on mount
  useEffect(() => {
    loadWorktrees(project.id)
    // Sync with git state
    syncWorktrees(project.id, project.path)
  }, [project.id, project.path, loadWorktrees, syncWorktrees])

  const handleCreateWorktree = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()

    if (isCreating) return

    const result = await createWorktree(project.id, project.path, project.name)

    if (result.success) {
      toast.success('Worktree created successfully')
    } else {
      toast.error(result.error || 'Failed to create worktree')
    }
  }

  return (
    <div className="pl-4" data-testid={`worktree-list-${project.id}`}>
      {/* Worktree items */}
      {worktrees.map((worktree) => (
        <WorktreeItem key={worktree.id} worktree={worktree} projectPath={project.path} />
      ))}

      {/* Add Worktree Button */}
      <div className="pl-4 py-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
          onClick={handleCreateWorktree}
          disabled={isCreating}
          data-testid={`add-worktree-${project.id}`}
        >
          {isCreating ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Plus className="h-3 w-3" />
              New Worktree
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
