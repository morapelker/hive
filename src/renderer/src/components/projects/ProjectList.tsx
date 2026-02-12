import { useEffect, useState, useMemo, useCallback } from 'react'
import { Loader2, FolderPlus } from 'lucide-react'
import { useProjectStore, useSpaceStore } from '@/stores'
import { ProjectItem } from './ProjectItem'
import { ProjectFilter } from './ProjectFilter'
import { subsequenceMatch } from '@/lib/subsequence-match'

interface ProjectListProps {
  onAddProject: () => void
}

export function ProjectList({ onAddProject }: ProjectListProps): React.JSX.Element {
  const { projects, isLoading, error, loadProjects, reorderProjects } = useProjectStore()
  const [filterQuery, setFilterQuery] = useState('')

  // Drag state for project reordering
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null)
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null)

  const handleDragStart = useCallback((e: React.DragEvent, projectId: string) => {
    setDraggedProjectId(projectId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', projectId)
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent, projectId: string) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (draggedProjectId && draggedProjectId !== projectId) {
        setDragOverProjectId(projectId)
      }
    },
    [draggedProjectId]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent, targetProjectId: string) => {
      e.preventDefault()
      if (!draggedProjectId || draggedProjectId === targetProjectId) return

      const fromIndex = projects.findIndex((p) => p.id === draggedProjectId)
      const toIndex = projects.findIndex((p) => p.id === targetProjectId)

      if (fromIndex !== -1 && toIndex !== -1) {
        // The visual indicator (border-t) shows "insert before target".
        // After splice removes fromIndex, indices above it shift down by 1.
        // When dragging downward (fromIndex < toIndex), we need toIndex - 1
        // so the item lands before the target, not after it.
        const adjustedIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
        reorderProjects(fromIndex, adjustedIndex)
      }

      setDraggedProjectId(null)
      setDragOverProjectId(null)
    },
    [draggedProjectId, projects, reorderProjects]
  )

  const handleDragEnd = useCallback(() => {
    setDraggedProjectId(null)
    setDragOverProjectId(null)
  }, [])

  // Load projects on mount
  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  // Space filtering: restrict to projects in the active space
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId)
  const projectSpaceMap = useSpaceStore((s) => s.projectSpaceMap)

  const filteredProjects = useMemo(() => {
    // First filter by active space
    let spaceFiltered = projects
    if (activeSpaceId !== null) {
      const allowedIds = new Set(
        Object.entries(projectSpaceMap)
          .filter(([, spaceIds]) => spaceIds.includes(activeSpaceId))
          .map(([projectId]) => projectId)
      )
      spaceFiltered = projects.filter((p) => allowedIds.has(p.id))
    }

    if (!filterQuery.trim())
      return spaceFiltered.map((p) => ({ project: p, nameMatch: null, pathMatch: null }))

    return spaceFiltered
      .map((project) => ({
        project,
        nameMatch: subsequenceMatch(filterQuery, project.name),
        pathMatch: subsequenceMatch(filterQuery, project.path)
      }))
      .filter(({ nameMatch, pathMatch }) => nameMatch.matched || pathMatch.matched)
      .sort((a, b) => {
        const aScore = a.nameMatch.matched ? a.nameMatch.score : a.pathMatch.score + 1000
        const bScore = b.nameMatch.matched ? b.nameMatch.score : b.pathMatch.score + 1000
        return aScore - bScore
      })
  }, [projects, filterQuery, activeSpaceId, projectSpaceMap])

  // Loading state
  if (isLoading && projects.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="text-sm text-destructive text-center py-8 px-2">
        <p>Failed to load projects</p>
        <p className="text-xs text-muted-foreground mt-1">{error}</p>
      </div>
    )
  }

  // Empty state
  if (projects.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-8 px-2 text-center cursor-pointer hover:bg-accent/30 rounded-lg transition-colors mx-2"
        onClick={onAddProject}
        data-testid="empty-projects-state"
      >
        <FolderPlus className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">No projects added yet.</p>
        <p className="text-xs text-muted-foreground mt-1">Click + to add a project.</p>
      </div>
    )
  }

  // Space has no assigned projects
  if (activeSpaceId !== null && filteredProjects.length === 0 && !filterQuery.trim()) {
    return (
      <div
        className="flex flex-col items-center justify-center py-8 px-2 text-center"
        data-testid="empty-space-state"
      >
        <p className="text-sm text-muted-foreground">No projects in this space.</p>
        <p className="text-xs text-muted-foreground mt-1">Right-click a project to assign it.</p>
      </div>
    )
  }

  const isDraggable = !filterQuery.trim()

  // Project list
  return (
    <div data-testid="project-list">
      {projects.length > 1 && <ProjectFilter value={filterQuery} onChange={setFilterQuery} />}
      <div className="space-y-0.5">
        {filteredProjects.map((item) => (
          <ProjectItem
            key={item.project.id}
            project={item.project}
            nameMatchIndices={item.nameMatch?.matched ? item.nameMatch.indices : undefined}
            pathMatchIndices={
              item.pathMatch?.matched && !item.nameMatch?.matched
                ? item.pathMatch.indices
                : undefined
            }
            isDragging={isDraggable && draggedProjectId === item.project.id}
            isDragOver={isDraggable && dragOverProjectId === item.project.id}
            onDragStart={isDraggable ? (e) => handleDragStart(e, item.project.id) : undefined}
            onDragOver={isDraggable ? (e) => handleDragOver(e, item.project.id) : undefined}
            onDrop={isDraggable ? (e) => handleDrop(e, item.project.id) : undefined}
            onDragEnd={isDraggable ? handleDragEnd : undefined}
          />
        ))}
      </div>
      {filterQuery && filteredProjects.length === 0 && (
        <div className="text-xs text-muted-foreground text-center py-4">No matching projects</div>
      )}
    </div>
  )
}
