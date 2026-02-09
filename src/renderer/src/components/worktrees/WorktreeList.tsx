import { useEffect } from 'react'
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
    syncWorktrees
  } = useWorktreeStore()

  const worktrees = getWorktreesForProject(project.id)

  // Load and sync worktrees on mount
  useEffect(() => {
    loadWorktrees(project.id)
    // Sync with git state
    syncWorktrees(project.id, project.path)
  }, [project.id, project.path, loadWorktrees, syncWorktrees])

  return (
    <div className="pl-4" data-testid={`worktree-list-${project.id}`}>
      {worktrees.map((worktree) => (
        <WorktreeItem key={worktree.id} worktree={worktree} projectPath={project.path} />
      ))}
    </div>
  )
}
