import { useState, useRef, useEffect } from 'react'
import { ChevronRight, MoreHorizontal, Pencil, Trash2, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useProjectStore } from '@/stores'
import { WorktreeList } from '@/components/worktrees'
import { LanguageIcon } from './LanguageIcon'

interface Project {
  id: string
  name: string
  path: string
  description: string | null
  tags: string | null
  language: string | null
  created_at: string
  last_accessed_at: string
}

interface ProjectItemProps {
  project: Project
}

export function ProjectItem({ project }: ProjectItemProps): React.JSX.Element {
  const {
    selectedProjectId,
    expandedProjectIds,
    editingProjectId,
    selectProject,
    toggleProjectExpanded,
    setEditingProject,
    updateProjectName,
    removeProject,
    refreshLanguage
  } = useProjectStore()

  const [editName, setEditName] = useState(project.name)
  const inputRef = useRef<HTMLInputElement>(null)

  const isSelected = selectedProjectId === project.id
  const isExpanded = expandedProjectIds.has(project.id)
  const isEditing = editingProjectId === project.id

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleClick = (): void => {
    selectProject(project.id)
    toggleProjectExpanded(project.id)
  }

  const handleToggleExpand = (e: React.MouseEvent): void => {
    e.stopPropagation()
    toggleProjectExpanded(project.id)
  }

  const handleStartEdit = (): void => {
    setEditName(project.name)
    setEditingProject(project.id)
  }

  const handleSaveEdit = async (): Promise<void> => {
    const trimmedName = editName.trim()
    if (trimmedName && trimmedName !== project.name) {
      const success = await updateProjectName(project.id, trimmedName)
      if (success) {
        toast.success('Project renamed successfully')
      } else {
        toast.error('Failed to rename project')
      }
    }
    setEditingProject(null)
  }

  const handleCancelEdit = (): void => {
    setEditName(project.name)
    setEditingProject(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  const handleRemove = async (): Promise<void> => {
    const success = await removeProject(project.id)
    if (success) {
      toast.success('Project removed from Hive')
    } else {
      toast.error('Failed to remove project')
    }
  }

  const handleOpenInFinder = async (): Promise<void> => {
    await window.projectOps.showInFolder(project.path)
  }

  const handleCopyPath = async (): Promise<void> => {
    await window.projectOps.copyToClipboard(project.path)
    toast.success('Path copied to clipboard')
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'group flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer transition-colors',
              isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
            )}
            onClick={handleClick}
            data-testid={`project-item-${project.id}`}
          >
            {/* Expand/Collapse Chevron */}
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 p-0 hover:bg-transparent"
              onClick={handleToggleExpand}
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 text-muted-foreground transition-transform',
                  isExpanded && 'rotate-90'
                )}
              />
            </Button>

            {/* Language Icon */}
            <LanguageIcon language={project.language} />

            {/* Project Name */}
            {isEditing ? (
              <Input
                ref={inputRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleSaveEdit}
                onKeyDown={handleKeyDown}
                className="h-6 py-0 px-1 text-sm"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="flex-1 text-sm truncate" title={project.path}>
                {project.name}
              </span>
            )}

            {/* More Options Button (visible on hover) */}
            {!isEditing && (
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity',
                  'hover:bg-accent'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  // Context menu will handle this
                }}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={handleStartEdit}>
            <Pencil className="h-4 w-4 mr-2" />
            Edit Name
          </ContextMenuItem>
          <ContextMenuItem onClick={handleOpenInFinder}>
            <ExternalLink className="h-4 w-4 mr-2" />
            Open in Finder
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyPath}>
            <Copy className="h-4 w-4 mr-2" />
            Copy Path
          </ContextMenuItem>
          <ContextMenuItem onClick={() => refreshLanguage(project.id)}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh Language
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={handleRemove}
            className="text-destructive focus:text-destructive focus:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Remove from Hive
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Worktree List - shown when project is expanded */}
      {isExpanded && <WorktreeList project={project} />}
    </div>
  )
}
