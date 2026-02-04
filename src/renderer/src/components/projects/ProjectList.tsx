import { useEffect } from 'react'
import { Loader2, FolderPlus } from 'lucide-react'
import { useProjectStore } from '@/stores'
import { ProjectItem } from './ProjectItem'

interface ProjectListProps {
  onAddProject: () => void
}

export function ProjectList({ onAddProject }: ProjectListProps): React.JSX.Element {
  const { projects, isLoading, error, loadProjects } = useProjectStore()

  // Load projects on mount
  useEffect(() => {
    loadProjects()
  }, [loadProjects])

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
    <div className="space-y-0.5" data-testid="project-list">
      {projects.map((project) => (
        <ProjectItem key={project.id} project={project} />
      ))}
    </div>
  )
}
