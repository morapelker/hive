import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorktreeStore } from '@/stores'
import { useSidebarBranchWatcher } from '@/hooks/useSidebarBranchWatcher'
import { WorktreeItem } from './WorktreeItem'

interface Project {
  id: string
  name: string
  path: string
}

interface WorktreeListProps {
  project: Project
}

// Projects whose worktrees have been loaded + git-synced at least once this
// session. The worktree store keeps its data across unmount/remount, so we must
// NOT re-run the expensive git sync every time this list remounts (e.g. each
// time the sidebar filter is cleared). That re-sync flood was the root cause of
// the UI jank: dozens of concurrent git ops + store updates blocking the main
// thread for ~10s.
const initializedProjects = new Set<string>()

export function WorktreeList({ project }: WorktreeListProps): React.JSX.Element {
  // Subscribe only to THIS project's slices so unrelated worktree-store updates
  // (other projects loading, isLoading toggles) don't re-render this list.
  const projectWorktrees = useWorktreeStore((s) => s.worktreesByProject.get(project.id))
  const projectOrder = useWorktreeStore((s) => s.worktreeOrderByProject.get(project.id))
  const getWorktreesForProject = useWorktreeStore((s) => s.getWorktreesForProject)
  const loadWorktrees = useWorktreeStore((s) => s.loadWorktrees)
  const syncWorktrees = useWorktreeStore((s) => s.syncWorktrees)
  const reorderWorktrees = useWorktreeStore((s) => s.reorderWorktrees)

  // Ordered list, recomputed only when this project's data actually changes —
  // keeps `worktrees` (and `worktreePaths` below) referentially stable so
  // unrelated store churn doesn't recreate them or break child memoization.
  const worktrees = useMemo(
    () => getWorktreesForProject(project.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectWorktrees, projectOrder, project.id]
  )

  // Watch all worktree paths for branch changes (lightweight HEAD-only watchers)
  const worktreePaths = useMemo(() => worktrees.map((w) => w.path), [worktrees])
  const watcherProject = useMemo(
    () => ({ projectId: project.id, projectPath: project.path }),
    [project.id, project.path]
  )
  useSidebarBranchWatcher(worktreePaths, watcherProject)

  // Drag state
  const [draggedWorktreeId, setDraggedWorktreeId] = useState<string | null>(null)
  const [dragOverWorktreeId, setDragOverWorktreeId] = useState<string | null>(null)

  // Load + git-sync once per project per session. On later remounts the store
  // already holds the data, so we skip the work entirely. Explicit refresh and
  // worktree create/archive still force-update the store directly.
  useEffect(() => {
    if (initializedProjects.has(project.id)) return
    initializedProjects.add(project.id)
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
          isFirstItem={index === 0}
          isDragging={draggedWorktreeId === worktree.id}
          isDragOver={dragOverWorktreeId === worktree.id}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
        />
      ))}
    </div>
  )
}
