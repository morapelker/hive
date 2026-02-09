import { useEffect, useState, useMemo } from 'react'
import { Loader2, FolderPlus } from 'lucide-react'
import { useProjectStore } from '@/stores'
import { ProjectItem } from './ProjectItem'
import { ProjectFilter } from './ProjectFilter'
import { subsequenceMatch } from '@/lib/subsequence-match'

interface ProjectListProps {
  onAddProject: () => void
}

export function ProjectList({ onAddProject }: ProjectListProps): React.JSX.Element {
  const { projects, isLoading, error, loadProjects } = useProjectStore()
  const [filterQuery, setFilterQuery] = useState('')

  // Load projects on mount
  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  const filteredProjects = useMemo(() => {
    if (!filterQuery.trim()) return projects.map(p => ({ project: p, nameMatch: null, pathMatch: null }))

    return projects
      .map(project => ({
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
  }, [projects, filterQuery])

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

  // Project list
  return (
    <div data-testid="project-list">
      {projects.length > 1 && (
        <ProjectFilter value={filterQuery} onChange={setFilterQuery} />
      )}
      <div className="space-y-0.5">
        {filteredProjects.map((item) => (
          <ProjectItem
            key={item.project.id}
            project={item.project}
            nameMatchIndices={item.nameMatch?.matched ? item.nameMatch.indices : undefined}
            pathMatchIndices={item.pathMatch?.matched && !item.nameMatch?.matched ? item.pathMatch.indices : undefined}
          />
        ))}
      </div>
      {filterQuery && filteredProjects.length === 0 && (
        <div className="text-xs text-muted-foreground text-center py-4">
          No matching projects
        </div>
      )}
    </div>
  )
}
