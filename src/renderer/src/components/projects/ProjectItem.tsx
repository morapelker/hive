import { memo, useState, useRef, useEffect, useCallback } from 'react'
import { revealLabel } from '@/lib/platform'
import {
  ChevronDown,
  Plus,
  Loader2,
  Link,
  Pencil,
  Trash2,
  Copy,
  ExternalLink,
  RefreshCw,
  Settings,
  GitBranch,
  FolderHeart
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuCheckboxItem
} from '@/components/ui/context-menu'
import {
  useProjectStore,
  useWorktreeStore,
  useSpaceStore,
  useConnectionStore,
  useHintStore,
  useVimModeStore,
  useSettingsStore
} from '@/stores'
import { HintBadge } from '@/components/ui/HintBadge'
import { WorktreeList, BranchPickerDialog } from '@/components/worktrees'
import { ConnectionInstanceList } from './ConnectionInstanceList'
import { getMemberProjects } from '@/lib/connection-project'
import { LanguageIcon } from './LanguageIcon'
import { HighlightedText } from './HighlightedText'
import {
  SECTION_HEADER_ACTIONS,
  SECTION_HEADER_ACTION_BUTTON,
  SECTION_HEADER_CHEVRON,
  SECTION_HEADER_CHEVRON_BOX,
  SECTION_HEADER_CHEVRON_COLLAPSED,
  SECTION_HEADER_ICON_BOX,
  SECTION_HEADER_LABEL,
  SECTION_HEADER_LABEL_ROW,
  SECTION_HEADER_LABEL_WRAP,
  SECTION_HEADER_ROW,
  SECTION_HEADER_ROW_CLICKABLE,
  SECTION_HEADER_TITLE_SURFACE,
  SECTION_HEADER_WRAPPER_STICKY,
  SECTION_HEADER_WRAPPER_STICKY_TOP,
  SECTION_HEADER_WRAPPER_TOP_SPACING,
  SECTION_TONE_NEUTRAL,
  SidebarCountPill,
  getProjectGroupHeaderPaddingLeft
} from '@/components/sidebar'
import { gitToast } from '@/lib/toast'
import { projectApi } from '@/api/project-api'
import { worktreeApi } from '@/api/worktree-api'
import { useSidebarHoverHighlight } from '@/hooks'

interface Project {
  id: string
  name: string
  path: string
  /** 'git' (default) or 'connection' (a saved connection promoted to a project). */
  kind?: 'git' | 'connection'
  /** connection projects only: JSON array of member project ids. */
  member_project_ids?: string | null
  description: string | null
  tags: string | null
  language: string | null
  custom_icon: string | null
  detected_icon: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  auto_assign_port: boolean
  sort_order: number
  created_at: string
  last_accessed_at: string
}

interface ProjectItemProps {
  project: Project
  nameMatchIndices?: number[]
  pathMatchIndices?: number[]
  /** First group in the list gets no top spacer (orca: firstHeaderIndex has no pt-1). */
  isFirst?: boolean
  isDraggable?: boolean
  isDragging?: boolean
  isDragOver?: boolean
  onDragStart?: (e: React.DragEvent, projectId: string) => void
  onDragOver?: (e: React.DragEvent, projectId: string) => void
  onDrop?: (e: React.DragEvent, projectId: string) => void
  onDragEnd?: () => void
}

export const ProjectItem = memo(function ProjectItem({
  project,
  nameMatchIndices,
  pathMatchIndices,
  isFirst,
  isDraggable,
  isDragging,
  isDragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: ProjectItemProps): React.JSX.Element {
  const sidebarHover = useSidebarHoverHighlight('project', project.id)
  // Narrow selectors (primitives/booleans) so this item only re-renders when its
  // own slice of state changes — not on every project/worktree store mutation.
  const selectProject = useProjectStore((s) => s.selectProject)
  const toggleProjectExpanded = useProjectStore((s) => s.toggleProjectExpanded)
  const setEditingProject = useProjectStore((s) => s.setEditingProject)
  const updateProjectName = useProjectStore((s) => s.updateProjectName)
  const removeProject = useProjectStore((s) => s.removeProject)
  const refreshLanguage = useProjectStore((s) => s.refreshLanguage)
  const isSelected = useProjectStore((s) => s.selectedProjectId === project.id)
  const isExpandedInStore = useProjectStore((s) => s.expandedProjectIds.has(project.id))
  const isEditing = useProjectStore((s) => s.editingProjectId === project.id)

  const createWorktree = useWorktreeStore((s) => s.createWorktree)
  const isCreatingWorktree = useWorktreeStore((s) => s.creatingForProjectId === project.id)
  const syncWorktrees = useWorktreeStore((s) => s.syncWorktrees)
  const worktreeCount = useWorktreeStore((s) => s.worktreesByProject.get(project.id)?.length ?? 0)

  const spaces = useSpaceStore((s) => s.spaces)
  const projectSpaceMap = useSpaceStore((s) => s.projectSpaceMap)
  const assignProjectToSpace = useSpaceStore((s) => s.assignProjectToSpace)
  const removeProjectFromSpace = useSpaceStore((s) => s.removeProjectFromSpace)

  const connectionModeActive = useConnectionStore((s) => s.connectionModeActive)

  // ── Connection project (saved connection) ─────────────────────────
  const isConnectionProject = project.kind === 'connection'
  const instanceCount = useConnectionStore((s) =>
    isConnectionProject
      ? s.connections.reduce((n, c) => (c.saved_project_id === project.id ? n + 1 : n), 0)
      : 0
  )
  const quickCreateConnection = useConnectionStore((s) => s.quickCreateConnection)
  const [isCreatingInstance, setIsCreatingInstance] = useState(false)

  const projectSpaceIds = projectSpaceMap[project.id] ?? []

  const plusHint = useHintStore((s) => s.hintMap.get('plus:' + project.id))
  const hintMode = useHintStore((s) => s.mode)
  const hintPendingChar = useHintStore((s) => s.pendingChar)
  const hintActionMode = useHintStore((s) => s.actionMode)
  const isSearchMode = useHintStore((s) => s.filterActive)
  const inputFocused = useHintStore((s) => s.inputFocused)

  const vimMode = useVimModeStore((s) => s.mode)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const autoPullBeforeWorktree = useSettingsStore((s) => s.autoPullBeforeWorktree)
  const projectHint = useHintStore((s) => s.hintMap.get('project:' + project.id))

  const [editName, setEditName] = useState(project.name)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const [noCommitsDialogOpen, setNoCommitsDialogOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const isExpanded = isSearchMode || isExpandedInStore

  // Focus input when editing starts (deferred to run after menu closes)
  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [isEditing])

  const handleClick = (): void => {
    selectProject(project.id)
    toggleProjectExpanded(project.id)
    if (isConnectionProject) {
      // Board-first entity: clear worktree/connection selection so the
      // project's own kanban board becomes the main-pane content.
      useConnectionStore.getState().selectConnection(null)
      useWorktreeStore.getState().selectWorktreeOnly(null)
    }
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
    setRemoveConfirmOpen(false)
    const success = await removeProject(project.id)
    if (success) {
      toast.success('Project removed from Hive')
    } else {
      toast.error('Failed to remove project')
    }
  }

  const handleOpenInFinder = async (): Promise<void> => {
    await projectApi.showInFolder(project.path)
  }

  const handleCopyPath = async (): Promise<void> => {
    await projectApi.copyToClipboard(project.path)
    toast.success('Path copied to clipboard')
  }

  const handleRefreshProject = async (): Promise<void> => {
    await syncWorktrees(project.id, project.path, { force: true })
    toast.success('Project refreshed')
  }

  const doCreateInstance = useCallback(async (): Promise<void> => {
    if (isCreatingInstance) return
    const memberProjects = getMemberProjects(project)
    if (memberProjects.length < 2) {
      toast.error('This connection project needs at least 2 existing member projects')
      return
    }
    setIsCreatingInstance(true)
    const loadingToastId = toast.loading('Creating connection worktrees...')
    try {
      const connectionId = await quickCreateConnection(memberProjects, {
        savedProjectId: project.id
      })
      toast.dismiss(loadingToastId)
      if (connectionId) {
        toast.success('Connection created')
      }
    } catch (error) {
      toast.dismiss(loadingToastId)
      toast.error(error instanceof Error ? error.message : 'Failed to create connection')
    } finally {
      setIsCreatingInstance(false)
    }
  }, [isCreatingInstance, project, quickCreateConnection])

  const doCreateWorktree = useCallback(async (): Promise<void> => {
    if (isConnectionProject) {
      await doCreateInstance()
      return
    }
    if (isCreatingWorktree) return

    // Check if repo has any commits before attempting worktree creation
    const hasCommits = await worktreeApi.hasCommits(project.path)
    if (!hasCommits) {
      setNoCommitsDialogOpen(true)
      return
    }

    // Show loading toast with appropriate progress message based on auto-pull setting
    const loadingToastId = autoPullBeforeWorktree
      ? toast.loading('Pulling latest changes from origin...')
      : toast.loading('Creating worktree...')

    try {
      const result = await createWorktree(project.id, project.path, project.name)

      // Dismiss loading toast
      toast.dismiss(loadingToastId)

      if (result.success) {
        // Show warning if auto-pull was enabled but pull failed
        if (autoPullBeforeWorktree && result.pullInfo?.pulled === false) {
          toast.warning('Failed to pull latest changes - worktree created from local branch')
          // Delay success toast so warning is visible
          setTimeout(() => {
            gitToast.worktreeCreated(project.name)
          }, 1500)
        }
        // Show info toast if commits were pulled
        else if (result.pullInfo?.updated) {
          toast.info('Pulled latest changes from origin')
          gitToast.worktreeCreated(project.name)
        } else {
          // No pull info to show, just success
          gitToast.worktreeCreated(project.name)
        }
      } else {
        gitToast.operationFailed('create worktree', result.error)
      }
    } catch (error) {
      toast.dismiss(loadingToastId)
      gitToast.operationFailed(
        'create worktree',
        error instanceof Error ? error.message : 'Unknown error'
      )
    }
  }, [isConnectionProject, doCreateInstance, isCreatingWorktree, createWorktree, project, autoPullBeforeWorktree])

  const handleCreateWorktree = useCallback(
    async (e: React.MouseEvent): Promise<void> => {
      e.stopPropagation()
      await doCreateWorktree()
    },
    [doCreateWorktree]
  )

  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ projectId: string }>
      if (ce.detail.projectId === project.id) doCreateWorktree()
    }
    window.addEventListener('hive:hint-plus', handler)
    return () => window.removeEventListener('hive:hint-plus', handler)
  }, [project.id, doCreateWorktree])

  const handleBranchSelect = useCallback(
    async (branchName: string, prNumber?: number): Promise<void> => {
      setBranchPickerOpen(false)

      // Show loading toast with appropriate progress message based on auto-pull setting
      const loadingToastId =
        autoPullBeforeWorktree && !prNumber
          ? toast.loading('Pulling latest changes from origin...')
          : toast.loading('Creating worktree...')

      try {
        const result = await worktreeApi.createFromBranch({
          projectId: project.id,
          projectPath: project.path,
          projectName: project.name,
          branchName,
          ...(prNumber === undefined ? {} : { prNumber })
        })

        // Dismiss loading toast
        toast.dismiss(loadingToastId)

        if (result.success && result.worktree) {
          useWorktreeStore.getState().loadWorktrees(project.id, { force: true })
          useWorktreeStore.getState().selectWorktree(result.worktree.id)

          // Show warning if auto-pull was enabled but pull failed (not for PRs)
          if (autoPullBeforeWorktree && !prNumber && result.pullInfo?.pulled === false) {
            toast.warning('Failed to pull latest changes - worktree created from local branch')
            // Delay success toast so warning is visible
            setTimeout(() => {
              gitToast.worktreeCreated(branchName)
            }, 1500)
          }
          // Show info toast if commits were pulled (not applicable for PR checkouts)
          else if (!prNumber && result.pullInfo?.updated) {
            toast.info('Pulled latest changes from origin')
            gitToast.worktreeCreated(branchName)
          } else {
            // No pull info to show, just success
            gitToast.worktreeCreated(branchName)
          }
        } else {
          gitToast.operationFailed('create worktree from branch', result.error)
        }
      } catch (error) {
        toast.dismiss(loadingToastId)
        gitToast.operationFailed(
          'create worktree from branch',
          error instanceof Error ? error.message : 'Unknown error'
        )
      }
    },
    [project, autoPullBeforeWorktree]
  )

  const showProjectHint = !isEditing && !!projectHint && vimModeEnabled && vimMode === 'normal'
  const showPlusHint =
    !isEditing && !!plusHint && (inputFocused || (vimModeEnabled && vimMode === 'normal'))
  // Header actions are hover-revealed (orca ProjectHeaderActions); force them
  // visible while a hint badge targets the plus button or a worktree is being created.
  const forceActionsVisible = showPlusHint || isCreatingWorktree || isCreatingInstance

  return (
    // Orca group section (virtual-rows.ts): every non-first header carries the
    // 4px 'pt-1' top spacer; the header itself pins to the top of the scroll
    // container on the sidebar fill; ROW_GAP (6px) between header and cards.
    <div
      className={cn('flex flex-col gap-1.5', !isFirst && SECTION_HEADER_WRAPPER_TOP_SPACING)}
      data-project-group={project.id}
    >
      <div className={cn(SECTION_HEADER_WRAPPER_STICKY, SECTION_HEADER_WRAPPER_STICKY_TOP)}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className={cn(
                // orca SectionHeader.tsx:227 — h-7 row, gap-1.5, 10px left / 8px right inset
                SECTION_HEADER_ROW,
                SECTION_HEADER_ROW_CLICKABLE,
                isSelected &&
                  'rounded-md bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground',
                isDragging && 'opacity-50',
                isDragOver && 'border-t border-ring'
              )}
              style={{ paddingLeft: getProjectGroupHeaderPaddingLeft(0) }}
              draggable={!!isDraggable && !isEditing && !connectionModeActive}
              onDragStart={
                connectionModeActive || !onDragStart ? undefined : (e) => onDragStart(e, project.id)
              }
              onDragOver={
                connectionModeActive || !onDragOver ? undefined : (e) => onDragOver(e, project.id)
              }
              onDrop={connectionModeActive || !onDrop ? undefined : (e) => onDrop(e, project.id)}
              onDragEnd={connectionModeActive ? undefined : onDragEnd}
              onClick={handleClick}
              onMouseEnter={sidebarHover.onMouseEnter}
              onMouseLeave={sidebarHover.onMouseLeave}
              data-testid={`project-item-${project.id}`}
            >
              {/* Project Hint Badge (visible in vim normal mode, leading the title) */}
              {showProjectHint && projectHint && (
                <HintBadge
                  code={projectHint}
                  mode={hintMode}
                  pendingChar={hintPendingChar}
                  actionMode={hintActionMode}
                />
              )}

              {/* Title surface: 16px icon box + 13px semibold label (+ count pill) */}
              <div className={SECTION_HEADER_TITLE_SURFACE}>
                <div className={cn(SECTION_HEADER_ICON_BOX, SECTION_TONE_NEUTRAL)}>
                  {isConnectionProject ? (
                    <Link className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <LanguageIcon
                      language={project.language}
                      customIcon={project.custom_icon}
                      detectedIcon={project.detected_icon}
                    />
                  )}
                </div>

                {isEditing ? (
                  <Input
                    ref={inputRef}
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={handleSaveEdit}
                    onKeyDown={handleKeyDown}
                    className="h-6 px-1 py-0 text-[13px] font-semibold"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className={SECTION_HEADER_LABEL_WRAP}>
                    <div className={SECTION_HEADER_LABEL_ROW}>
                      {nameMatchIndices ? (
                        <HighlightedText
                          text={project.name}
                          indices={nameMatchIndices}
                          className={SECTION_HEADER_LABEL}
                        />
                      ) : (
                        <span className={SECTION_HEADER_LABEL} title={project.path}>
                          {project.name}
                        </span>
                      )}
                      {(isConnectionProject ? instanceCount : worktreeCount) > 0 && (
                        <SidebarCountPill
                          count={isConnectionProject ? instanceCount : worktreeCount}
                          className="tabular-nums"
                          aria-label={
                            isConnectionProject
                              ? `${instanceCount} ${instanceCount === 1 ? 'connection' : 'connections'}`
                              : `${worktreeCount} ${worktreeCount === 1 ? 'worktree' : 'worktrees'}`
                          }
                          data-testid={`project-worktree-count-${project.id}`}
                        />
                      )}
                    </div>
                    {pathMatchIndices && (
                      <HighlightedText
                        text={project.path}
                        indices={pathMatchIndices}
                        className="mt-1 block truncate text-[10px] leading-none text-muted-foreground"
                      />
                    )}
                  </div>
                )}
              </div>

              {/* Header actions — orca ProjectHeaderActions: hover-revealed overlay on the
                  right edge (chevron + create), painted on the header fill so it can
                  cover a long title without reserving width. */}
              {!isEditing && (
                <div
                  data-project-header-actions=""
                  className={cn(
                    SECTION_HEADER_ACTIONS,
                    isSelected && 'can-hover:bg-worktree-sidebar-accent',
                    forceActionsVisible && 'can-hover:pointer-events-auto can-hover:opacity-100'
                  )}
                >
                  {/* Plus Hint Badge (filter mode with the search field focused, or vim normal) */}
                  {showPlusHint && plusHint && (
                    <HintBadge
                      code={plusHint}
                      mode={hintMode}
                      pendingChar={hintPendingChar}
                      actionMode={hintActionMode}
                    />
                  )}

                  {/* Expand/Collapse affordance (orca SectionHeader.tsx:337) */}
                  <button
                    type="button"
                    className={SECTION_HEADER_CHEVRON_BOX}
                    aria-label={isExpanded ? 'Collapse project' : 'Expand project'}
                    aria-expanded={isExpanded}
                    onClick={handleToggleExpand}
                  >
                    <ChevronDown
                      className={cn(
                        SECTION_HEADER_CHEVRON,
                        !isExpanded && SECTION_HEADER_CHEVRON_COLLAPSED
                      )}
                    />
                  </button>

                  {/* Create Worktree Button (orca RepoHeaderCreateWorkspaceButton) */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      SECTION_HEADER_ACTION_BUTTON,
                      forceActionsVisible && 'ml-0 max-w-5 opacity-100'
                    )}
                    aria-label={
                      isConnectionProject
                        ? `New connection in ${project.name}`
                        : `New worktree in ${project.name}`
                    }
                    onClick={handleCreateWorktree}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (!isConnectionProject) setBranchPickerOpen(true)
                    }}
                    disabled={isCreatingWorktree || isCreatingInstance}
                  >
                    {isCreatingWorktree || isCreatingInstance ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Plus className="size-3" />
                    )}
                  </Button>
                </div>
              )}
            </div>
          </ContextMenuTrigger>

          {!connectionModeActive && (
            <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={handleStartEdit}>
                <Pencil className="h-4 w-4 mr-2" />
                Edit Name
              </ContextMenuItem>
              <ContextMenuItem onClick={handleOpenInFinder}>
                <ExternalLink className="h-4 w-4 mr-2" />
                {revealLabel(true)}
              </ContextMenuItem>
              <ContextMenuItem onClick={handleCopyPath}>
                <Copy className="h-4 w-4 mr-2" />
                Copy Path
              </ContextMenuItem>
              {!isConnectionProject && (
                <>
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
                  <ContextMenuItem
                    onClick={() => useProjectStore.getState().openProjectSettings(project.id)}
                  >
                    <Settings className="h-4 w-4 mr-2" />
                    Project Settings
                  </ContextMenuItem>
                </>
              )}
              {spaces.length > 0 && (
                <>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <FolderHeart className="h-4 w-4 mr-2" />
                      Assign to Space
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-40">
                      {spaces.map((space) => {
                        const isAssigned = projectSpaceIds.includes(space.id)
                        return (
                          <ContextMenuCheckboxItem
                            key={space.id}
                            checked={isAssigned}
                            onSelect={(e) => {
                              e.preventDefault()
                              if (isAssigned) {
                                removeProjectFromSpace(project.id, space.id)
                              } else {
                                assignProjectToSpace(project.id, space.id)
                              }
                            }}
                          >
                            {space.name}
                          </ContextMenuCheckboxItem>
                        )
                      })}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => setRemoveConfirmOpen(true)}
                className="text-destructive focus:text-destructive focus:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Remove from Hive
              </ContextMenuItem>
            </ContextMenuContent>
          )}
        </ContextMenu>
      </div>

      {/* Worktree list — orca surface inset for a depth-0 project group is 0;
          the 6px header→card gap comes from the group's flex gap.
          Connection projects list their live connection instances instead. */}
      {isExpanded &&
        (isConnectionProject ? (
          <ConnectionInstanceList projectId={project.id} />
        ) : (
          <WorktreeList project={project} />
        ))}

      {/* Branch Picker Dialog */}
      <BranchPickerDialog
        open={branchPickerOpen}
        onOpenChange={setBranchPickerOpen}
        projectPath={project.path}
        onSelect={handleBranchSelect}
      />

      {/* Remove Confirmation Dialog */}
      <AlertDialog open={removeConfirmOpen} onOpenChange={setRemoveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove project from Hive?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will remove <span className="font-semibold">{project.name}</span> from Hive.
                </p>
                <p className="font-mono text-xs bg-muted rounded px-2 py-1 break-all">
                  {project.path}
                </p>
                {isConnectionProject ? (
                  <p>
                    Its board, tickets and sessions will be deleted. Member projects, worktrees and
                    files on disk will not be affected; its connections become regular connections.
                  </p>
                ) : (
                  <p>Your files on disk will not be affected.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* No Commits Dialog */}
      <AlertDialog open={noCommitsDialogOpen} onOpenChange={setNoCommitsDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Initial Commit Required</AlertDialogTitle>
            <AlertDialogDescription>
              Creating a first commit with the initial state is required for adding worktrees.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setNoCommitsDialogOpen(false)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
