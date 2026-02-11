import { useCallback, useEffect, useState } from 'react'
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
  const { getWorktreesForProject, loadWorktrees, syncWorktrees, reorderWorktrees } =
    useWorktreeStore()

  const worktrees = getWorktreesForProject(project.id)

  // Drag state
  const [draggedWorktreeId, setDraggedWorktreeId] = useState<string | null>(null)
  const [dragOverWorktreeId, setDragOverWorktreeId] = useState<string | null>(null)

  // Load and sync worktrees on mount
  useEffect(() => {
    loadWorktrees(project.id)
    // Sync with git state
    syncWorktrees(project.id, project.path)
  }, [project.id, project.path, loadWorktrees, syncWorktrees])

  const handleDragStart = useCallback((e: React.DragEvent, worktreeId: string) => {
    setDraggedWorktreeId(worktreeId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', worktreeId)
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent, worktreeId: string) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (draggedWorktreeId && draggedWorktreeId !== worktreeId) {
        setDragOverWorktreeId(worktreeId)
      }
    },
    [draggedWorktreeId]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent, targetWorktreeId: string) => {
      e.preventDefault()
      if (!draggedWorktreeId || draggedWorktreeId === targetWorktreeId) return

      // Compute indices among non-default worktrees only
      const nonDefault = worktrees.filter((w) => !w.is_default)
      const fromIndex = nonDefault.findIndex((w) => w.id === draggedWorktreeId)
      const toIndex = nonDefault.findIndex((w) => w.id === targetWorktreeId)

      if (fromIndex !== -1 && toIndex !== -1) {
        reorderWorktrees(project.id, fromIndex, toIndex)
      }

      setDraggedWorktreeId(null)
      setDragOverWorktreeId(null)
    },
    [draggedWorktreeId, worktrees, project.id, reorderWorktrees]
  )

  const handleDragEnd = useCallback(() => {
    setDraggedWorktreeId(null)
    setDragOverWorktreeId(null)
  }, [])

  return (
    <div className="pl-4" data-testid={`worktree-list-${project.id}`}>
      {worktrees.map((worktree, index) => (
        <WorktreeItem
          key={worktree.id}
          worktree={worktree}
          projectPath={project.path}
          index={index}
          isDragging={draggedWorktreeId === worktree.id}
          isDragOver={dragOverWorktreeId === worktree.id}
          onDragStart={(e) => handleDragStart(e, worktree.id)}
          onDragOver={(e) => handleDragOver(e, worktree.id)}
          onDrop={(e) => handleDrop(e, worktree.id)}
          onDragEnd={handleDragEnd}
        />
      ))}
    </div>
  )
}
