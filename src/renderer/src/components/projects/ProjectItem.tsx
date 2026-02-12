import { useState, useRef, useEffect, useCallback } from 'react'
import {
  ChevronRight,
  Plus,
  Loader2,
  Pencil,
  Trash2,
  Copy,
  ExternalLink,
  RefreshCw,
  Settings,
  GitBranch
} from 'lucide-react'
import { toast } from '@/lib/toast'
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
import { useProjectStore, useWorktreeStore } from '@/stores'
import { WorktreeList, BranchPickerDialog } from '@/components/worktrees'
import { LanguageIcon } from './LanguageIcon'
import { HighlightedText } from './HighlightedText'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { gitToast } from '@/lib/toast'

interface Project {
  id: string
  name: string
  path: string
  description: string | null
  tags: string | null
  language: string | null
  custom_icon: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  sort_order: number
  created_at: string
  last_accessed_at: string
}

interface ProjectItemProps {
  project: Project
  nameMatchIndices?: number[]
  pathMatchIndices?: number[]
  isDragging?: boolean
  isDragOver?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
}

export function ProjectItem({
  project,
  nameMatchIndices,
  pathMatchIndices,
  isDragging,
  isDragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: ProjectItemProps): React.JSX.Element {
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

  const { createWorktree, creatingForProjectId, syncWorktrees } = useWorktreeStore()

  const [editName, setEditName] = useState(project.name)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const isCreatingWorktree = creatingForProjectId === project.id

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

  const handleRefreshProject = async (): Promise<void> => {
    await syncWorktrees(project.id, project.path)
    toast.success('Project refreshed')
  }

  const handleCreateWorktree = useCallback(
    async (e: React.MouseEvent): Promise<void> => {
      e.stopPropagation()
      if (isCreatingWorktree) return

      const result = await createWorktree(project.id, project.path, project.name)
      if (result.success) {
        gitToast.worktreeCreated(project.name)
      } else {
        gitToast.operationFailed('create worktree', result.error)
      }
    },
    [isCreatingWorktree, createWorktree, project]
  )

  const handleBranchSelect = useCallback(
    async (branchName: string): Promise<void> => {
      setBranchPickerOpen(false)
      const result = await window.worktreeOps.createFromBranch(
        project.id,
        project.path,
        project.name,
        branchName
      )
      if (result.success && result.worktree) {
        useWorktreeStore.getState().loadWorktrees(project.id)
        useWorktreeStore.getState().selectWorktree(result.worktree.id)
        gitToast.worktreeCreated(branchName)
      } else {
        gitToast.operationFailed('create worktree from branch', result.error)
      }
    },
    [project]
  )

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'group flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer transition-colors',
              isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              isDragging && 'opacity-50',
              isDragOver && 'border-t-2 border-primary'
            )}
            draggable={!!onDragStart && !isEditing}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
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
            <LanguageIcon language={project.language} customIcon={project.custom_icon} />

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
              <div className="flex-1 min-w-0">
                {nameMatchIndices ? (
                  <HighlightedText
                    text={project.name}
                    indices={nameMatchIndices}
                    className="text-sm truncate block"
                  />
                ) : (
                  <span className="text-sm truncate block" title={project.path}>
                    {project.name}
                  </span>
                )}
                {pathMatchIndices && (
                  <HighlightedText
                    text={project.path}
                    indices={pathMatchIndices}
                    className="text-[10px] text-muted-foreground truncate block"
                  />
                )}
              </div>
            )}

            {/* Create Worktree Button */}
            {!isEditing && (
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-5 w-5 p-0 cursor-pointer', 'hover:bg-accent')}
                onClick={handleCreateWorktree}
                disabled={isCreatingWorktree}
              >
                {isCreatingWorktree ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
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
          <ContextMenuItem onClick={handleRefreshProject}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh Project
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setBranchPickerOpen(true)}>
            <GitBranch className="h-4 w-4 mr-2" />
            New Workspace From...
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setSettingsOpen(true)}>
            <Settings className="h-4 w-4 mr-2" />
            Project Settings
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

      {/* Project Settings Dialog */}
      <ProjectSettingsDialog project={project} open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* Branch Picker Dialog */}
      <BranchPickerDialog
        open={branchPickerOpen}
        onOpenChange={setBranchPickerOpen}
        projectPath={project.path}
        onSelect={handleBranchSelect}
      />
    </div>
  )
}
