import { useEffect, useState, useMemo, useCallback } from 'react'
import { Loader2, FolderPlus } from 'lucide-react'
import {
  useProjectStore,
  useSpaceStore,
  useWorktreeStore,
  useHintStore,
  useVimModeStore,
  useSettingsStore,
  usePinnedStore,
  useConnectionStore
} from '@/stores'
import { ProjectItem } from './ProjectItem'
import { filterProjects } from '@/lib/project-filter'
import { sidebarPerfFlags } from '@/lib/sidebar-perf-flags'
import { pickSearchAutoExpandIds } from '@/lib/search-auto-expand'
import {
  assignHints,
  buildNormalModeTargets,
  buildPinnedAndConnectionTargets,
  type HintTarget
} from '@/lib/hint-utils'

interface ProjectListProps {
  onAddProject: () => void
  filterQuery: string
  activeLanguages?: string[]
}

export function ProjectList({
  onAddProject,
  filterQuery,
  activeLanguages = []
}: ProjectListProps): React.JSX.Element {
  // Narrow selectors: a whole-store subscription re-rendered the list (and
  // re-mapped every row) on any project/hint store change, e.g. selecting a
  // project or the pending-hint keypress.
  const projects = useProjectStore((s) => s.projects)
  const isLoading = useProjectStore((s) => s.isLoading)
  const error = useProjectStore((s) => s.error)
  const loadProjects = useProjectStore((s) => s.loadProjects)
  const reorderProjects = useProjectStore((s) => s.reorderProjects)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const loadedProjectIds = useWorktreeStore((s) => s.loadedProjectIds)
  const expandedProjectIds = useProjectStore((s) => s.expandedProjectIds)
  const setHints = useHintStore((s) => s.setHints)
  const clearHints = useHintStore((s) => s.clearHints)
  const setFilterActive = useHintStore((s) => s.setFilterActive)
  const vimMode = useVimModeStore((s) => s.mode)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const pinnedWorktreeIds = usePinnedStore((s) => s.pinnedWorktreeIds)
  const pinnedConnectionIds = usePinnedStore((s) => s.pinnedConnectionIds)
  const connections = useConnectionStore((s) => s.connections)

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

  // Load projects and spaces on mount
  const loadSpaces = useSpaceStore((s) => s.loadSpaces)
  const hydrateAllWorktrees = useWorktreeStore((s) => s.hydrateAllWorktrees)
  useEffect(() => {
    loadProjects()
    loadSpaces()
    // One DB query for every project's worktrees, so filtering shows complete,
    // uniformly expanded results instead of whatever happened to be loaded.
    hydrateAllWorktrees()
  }, [loadProjects, loadSpaces, hydrateAllWorktrees])

  // Space filtering: restrict to projects in the active space
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId)
  const projectSpaceMap = useSpaceStore((s) => s.projectSpaceMap)

  const filteredProjects = useMemo(
    () =>
      filterProjects(projects, { filterQuery, activeLanguages, activeSpaceId, projectSpaceMap }),
    [projects, filterQuery, activeSpaceId, projectSpaceMap, activeLanguages]
  )

  // A filter expands only its best-ranked matches (see SEARCH_AUTO_EXPAND_LIMIT).
  const filterActive = !!filterQuery.trim() || activeLanguages.length > 0
  const searchAutoExpandIds = useMemo(() => {
    if (!filterActive) return new Set<string>()
    return pickSearchAutoExpandIds(
      filteredProjects.map(({ project }) => project.id),
      (id) => loadedProjectIds.has(id) && (worktreesByProject.get(id)?.length ?? 0) > 0
    )
  }, [filterActive, filteredProjects, loadedProjectIds, worktreesByProject])

  // Build hint assignments when filter is active
  const { hintMap: computedHintMap, hintTargetMap: computedHintTargetMap } = useMemo(() => {
    if (filterQuery.trim()) {
      // Filter mode: existing behavior (plus + worktree targets)
      const targets: HintTarget[] = []
      for (const { project } of filteredProjects) {
        const wts = loadedProjectIds.has(project.id)
          ? (worktreesByProject.get(project.id) ?? [])
          : []
        // Hints go to the projects the search expanded (or that were already open).
        // Hint codes change with every keystroke, so badging every collapsed match
        // too would re-render the whole result list per keystroke.
        if (!searchAutoExpandIds.has(project.id) && !expandedProjectIds.has(project.id)) continue
        if (wts.length > 0) {
          targets.push({ kind: 'plus', projectId: project.id })
          for (const wt of wts) {
            targets.push({ kind: 'worktree', worktreeId: wt.id, projectId: project.id })
          }
        }
      }
      const lastChar = filterQuery.trim().slice(-1).toUpperCase()
      return assignHints(targets, sidebarPerfFlags.stableHintPrefix ? undefined : lastChar)
    }

    if (vimModeEnabled && vimMode === 'normal') {
      // Normal mode (no filter): pinned/connection targets + project/worktree targets
      const worktreeProjectMap = new Map<string, string>()
      for (const [projectId, wts] of worktreesByProject) {
        for (const wt of wts) {
          worktreeProjectMap.set(wt.id, projectId)
        }
      }
      const pinnedAndConnectionTargets = buildPinnedAndConnectionTargets(
        pinnedWorktreeIds,
        pinnedConnectionIds,
        connections.map((c) => c.id),
        worktreeProjectMap
      )
      const projectTargets = buildNormalModeTargets(
        filteredProjects.map((fp) => fp.project),
        worktreesByProject
      )
      const allTargets = [...pinnedAndConnectionTargets, ...projectTargets]
      return assignHints(allTargets, undefined, 'S')
    }

    return { hintMap: new Map<string, string>(), hintTargetMap: new Map<string, HintTarget>() }
  }, [
    filteredProjects,
    worktreesByProject,
    loadedProjectIds,
    searchAutoExpandIds,
    expandedProjectIds,
    filterQuery,
    vimModeEnabled,
    vimMode,
    pinnedWorktreeIds,
    pinnedConnectionIds,
    connections
  ])

  // Immediately set filterActive when filter text or language filters change — this drives
  // project expansion independently of worktree loading (breaking the circular dependency)
  useEffect(() => {
    setFilterActive(!!filterQuery.trim() || activeLanguages.length > 0)
    return () => {
      setFilterActive(false)
    }
  }, [filterQuery, activeLanguages, setFilterActive])

  useEffect(() => {
    if (filterQuery.trim() || (vimModeEnabled && vimMode === 'normal')) {
      setHints(computedHintMap, computedHintTargetMap)
    } else {
      clearHints()
    }
    // No cleanup here: when computedHintMap changes (worktrees loading), setHints
    // immediately overwrites — running clearHints() in cleanup would reset mode:'idle'
    // mid-navigation and break the two-char hint flow.
  }, [
    computedHintMap,
    computedHintTargetMap,
    filterQuery,
    vimModeEnabled,
    vimMode,
    setHints,
    clearHints
  ])

  // Clear all hint state on unmount only
  useEffect(() => {
    return () => {
      useHintStore.getState().clearHints()
    }
  }, [])

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
        className="mx-1 mt-1 flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-worktree-sidebar-border px-2 py-8 text-center transition-colors hover:bg-worktree-sidebar-accent/40"
        onClick={onAddProject}
        data-testid="empty-projects-state"
      >
        <FolderPlus className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-[13px] text-muted-foreground">No projects added yet.</p>
        <p className="text-[11px] text-muted-foreground mt-1">Click + to add a project.</p>
      </div>
    )
  }

  // Space has no assigned projects
  if (
    activeSpaceId !== null &&
    filteredProjects.length === 0 &&
    !filterQuery.trim() &&
    activeLanguages.length === 0
  ) {
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

  const isDraggable = !filterQuery.trim() && activeLanguages.length === 0

  // Project list
  return (
    // Orca virtual-row rhythm: ROW_GAP (6px) between group rows; the first
    // header in the whole sidebar has no top spacer, so the list only adds the
    // 4px header spacer when another section (Pinned/Recent/Connections)
    // renders above it. Non-first groups add their own pt-1 (ProjectItem).
    <div data-testid="project-list" className="flex flex-col gap-1.5 [&:not(:first-child)]:pt-1">
      {filteredProjects.map((item, index) => (
        <ProjectItem
          key={item.project.id}
          project={item.project}
          isFirst={index === 0}
          searchAutoExpand={searchAutoExpandIds.has(item.project.id)}
          nameMatchIndices={item.nameMatch?.matched ? item.nameMatch.indices : undefined}
          pathMatchIndices={
            item.pathMatch?.matched && !item.nameMatch?.matched ? item.pathMatch.indices : undefined
          }
          isDraggable={isDraggable}
          isDragging={isDraggable && draggedProjectId === item.project.id}
          isDragOver={isDraggable && dragOverProjectId === item.project.id}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
        />
      ))}
      {(filterQuery || activeLanguages.length > 0) && filteredProjects.length === 0 && (
        <div className="text-[11px] text-muted-foreground text-center py-4">
          No matching projects
        </div>
      )}
    </div>
  )
}
