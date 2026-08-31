import { useCallback, useEffect } from 'react'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useProjectStore, useConnectionStore, useFilterStore, useSpaceStore } from '@/stores'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { formatBinding, getShortcutDefinition } from '@/lib/keyboard-shortcuts'
import { ResizeHandle } from './ResizeHandle'
import { KanbanSquare, Link, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ProjectList,
  AddProjectButton,
  SortProjectsButton,
  RecentToggleButton,
  FilterChips
} from '@/components/projects'
import { ConnectionList, ConnectionsButton } from '@/components/connections'
import { SpacesTabBar } from '@/components/spaces'
import { ProjectFilter } from '@/components/projects/ProjectFilter'
import { UsageIndicator } from './UsageIndicator'
import { UpdatePill } from './UpdatePill'
import { PinnedList } from './PinnedList'
import { RecentList } from './RecentList'
import {
  AgentStateDot,
  LIST_CONTAINER,
  LIST_SCROLL,
  NAV_ICON,
  NAV_ICON_INACTIVE,
  NAV_ICON_STROKE_ACTIVE,
  NAV_ICON_STROKE_INACTIVE,
  NAV_LABEL,
  NAV_LIST,
  NAV_ROW,
  NAV_ROW_ACTIVE_PRIMARY,
  NAV_ROW_INACTIVE,
  SIDEBAR_HEADER,
  SIDEBAR_HEADER_ACTIONS,
  SIDEBAR_HEADER_ACTION_ICON_STROKE,
  SIDEBAR_HEADER_LABEL,
  SIDEBAR_HEADER_LEFT,
  SIDEBAR_SHELL
} from '@/components/sidebar'

/** Orca SidebarNav row (SidebarNav.tsx:104-123): 13px medium row, size-4 icon,
 * heavier stroke + accent fill when active. */
function SidebarNavRow({
  icon: Icon,
  label,
  active,
  onClick,
  testId,
  shortcut
}: {
  icon: typeof KanbanSquare
  label: string
  active: boolean
  onClick: () => void
  testId: string
  shortcut?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(NAV_ROW, active ? NAV_ROW_ACTIVE_PRIMARY : NAV_ROW_INACTIVE)}
      data-testid={testId}
      title={shortcut ? `${label} (${shortcut})` : undefined}
    >
      <Icon
        className={cn(NAV_ICON, !active && NAV_ICON_INACTIVE)}
        strokeWidth={active ? NAV_ICON_STROKE_ACTIVE : NAV_ICON_STROKE_INACTIVE}
      />
      <span className={NAV_LABEL}>{label}</span>
      {shortcut && (
        <kbd
          className={cn(
            'shrink-0 font-sans text-[11px] font-medium tracking-wide',
            active ? 'text-current opacity-55' : 'text-worktree-sidebar-foreground/35'
          )}
        >
          {shortcut}
        </kbd>
      )}
    </button>
  )
}

export function LeftSidebar(): React.JSX.Element {
  const { leftSidebarWidth, leftSidebarCollapsed, setLeftSidebarWidth } = useLayoutStore()
  const projectCount = useProjectStore((s) => s.projects.length)
  const usageIndicatorMode = useSettingsStore((s) => s.usageIndicatorMode)
  const usageIndicatorProviders = useSettingsStore((s) => s.usageIndicatorProviders)
  const shouldShowUsageIndicator =
    usageIndicatorMode === 'current-agent' ||
    (usageIndicatorMode === 'specific-providers' && usageIndicatorProviders.length > 0)
  // Filter store for language filters and the text filter query
  // (in the store so keyboard navigation can respect the visible list)
  const filterQuery = useFilterStore((s) => s.filterQuery)
  const debouncedFilterQuery = useFilterStore((s) => s.debouncedFilterQuery)
  const setFilterQuery = useFilterStore((s) => s.setFilterQuery)
  const activeLanguages = useFilterStore((s) => s.activeLanguages)
  const removeLanguage = useFilterStore((s) => s.removeLanguage)
  const clearAllFilters = useFilterStore((s) => s.clearAll)

  // Space switching
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId)

  // Connection mode state
  const connectionModeActive = useConnectionStore((s) => s.connectionModeActive)
  // Number of sessions currently streaming ('working'/'planning'), same
  // definition useKeepAwake uses. Drives the yellow spinner + counter next to
  // the "Projects" title.
  const workingSessionCount = useWorktreeStatusStore((state) => {
    let count = 0
    for (const entry of Object.values(state.sessionStatuses)) {
      if (entry && (entry.status === 'working' || entry.status === 'planning')) count++
    }
    return count
  })
  const connectionModeSelectedIds = useConnectionStore((s) => s.connectionModeSelectedIds)
  const connectionModeSubmitting = useConnectionStore((s) => s.connectionModeSubmitting)
  const exitConnectionMode = useConnectionStore((s) => s.exitConnectionMode)
  const finalizeConnection = useConnectionStore((s) => s.finalizeConnection)

  // Nav row — Pinned Board toggle (clear file/diff overlays before showing
  // the board, then toggle).
  const isPinnedBoardActive = useKanbanStore((s) => s.isPinnedBoardActive)
  const togglePinnedBoard = useKanbanStore((s) => s.togglePinnedBoard)

  // Effective Cmd+P binding (respects user overrides), shown on the nav row
  const pinnedBoardBinding =
    useShortcutStore((s) => s.customBindings['nav:toggle-pinned-board']) ??
    getShortcutDefinition('nav:toggle-pinned-board')?.defaultBinding
  const pinnedBoardShortcut = pinnedBoardBinding ? formatBinding(pinnedBoardBinding) : undefined

  const handlePinnedBoardClick = useCallback((): void => {
    if (!isPinnedBoardActive) {
      const fileStore = useFileViewerStore.getState()
      fileStore.setActiveFile(null)
      fileStore.clearActiveDiff()
      fileStore.closeContextEditor()
    }
    togglePinnedBoard()
  }, [isPinnedBoardActive, togglePinnedBoard])

  const canFinalize = connectionModeSelectedIds.size >= 2

  // Clear language filters and the text filter on space switch
  useEffect(() => {
    clearAllFilters()
  }, [activeSpaceId, clearAllFilters])

  // Escape key exits connection mode
  useEffect(() => {
    if (!connectionModeActive) return

    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // If the project filter input is focused, let it handle Escape first
        // (clear the query / close the colon-command popover).
        // The user can press Escape again to exit connection mode.
        const filterInput = document.querySelector(
          '[data-testid="project-filter-input"]'
        ) as HTMLInputElement | null
        if (filterInput && document.activeElement === filterInput) {
          return
        }

        e.preventDefault()
        exitConnectionMode()
      }
    }

    document.addEventListener('keydown', handleEscape, true)
    return () => document.removeEventListener('keydown', handleEscape, true)
  }, [connectionModeActive, exitConnectionMode])

  // Exit connection mode if sidebar collapses
  useEffect(() => {
    if (leftSidebarCollapsed && connectionModeActive) {
      exitConnectionMode()
    }
  }, [leftSidebarCollapsed, connectionModeActive, exitConnectionMode])

  const handleResize = (delta: number): void => {
    setLeftSidebarWidth(leftSidebarWidth + delta)
  }

  const handleAddProject = async (): Promise<void> => {
    // Trigger the add project flow
    const addButton = document.querySelector(
      '[data-testid="add-project-button"]'
    ) as HTMLButtonElement
    if (addButton) {
      addButton.click()
    }
  }

  if (leftSidebarCollapsed) {
    return <div data-testid="left-sidebar-collapsed" />
  }

  return (
    <div className="flex flex-shrink-0" data-testid="left-sidebar-container">
      {/* Orca sidebar/index.tsx:110 shell — nav, header, list viewport, footer */}
      <aside
        className={cn(
          SIDEBAR_SHELL,
          'text-worktree-sidebar-foreground border-r border-worktree-sidebar-border'
        )}
        style={{ width: leftSidebarWidth }}
        data-testid="left-sidebar"
        data-width={leftSidebarWidth}
        role="navigation"
        aria-label="Projects and worktrees"
      >
        {/* Orca SidebarNav: nav rows + search field */}
        <div className={NAV_LIST}>
          <SidebarNavRow
            icon={KanbanSquare}
            label="Pinned Board"
            active={isPinnedBoardActive}
            onClick={handlePinnedBoardClick}
            testId="sidebar-nav-pinned-board"
            shortcut={pinnedBoardShortcut}
          />
          {projectCount > 1 && <ProjectFilter value={filterQuery} onChange={setFilterQuery} />}
          {activeLanguages.length > 0 && (
            <div className="px-0.5 pt-1">
              <FilterChips languages={activeLanguages} onRemove={removeLanguage} />
            </div>
          )}
        </div>

        {/* Orca SidebarHeader ("Workspaces" → "Projects") */}
        {connectionModeActive ? (
          <div className={SIDEBAR_HEADER}>
            <div className={cn(SIDEBAR_HEADER_LEFT, SIDEBAR_HEADER_LABEL, 'gap-1.5')}>
              <Link className="size-3.5 shrink-0" strokeWidth={SIDEBAR_HEADER_ACTION_ICON_STROKE} />
              <span className="truncate">Select worktrees</span>
              <span className="shrink-0 tabular-nums">({connectionModeSelectedIds.size})</span>
            </div>
            <div className={cn(SIDEBAR_HEADER_ACTIONS, 'gap-1')}>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[12px] text-muted-foreground"
                onClick={exitConnectionMode}
                disabled={connectionModeSubmitting}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-6 px-2 text-[12px]"
                onClick={finalizeConnection}
                disabled={!canFinalize || connectionModeSubmitting}
              >
                {connectionModeSubmitting ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  'Connect'
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className={SIDEBAR_HEADER}>
            <div className={SIDEBAR_HEADER_LEFT}>
              <span className={SIDEBAR_HEADER_LABEL}>Projects</span>
              {workingSessionCount > 0 && (
                <span
                  className="flex shrink-0 items-center gap-1 text-xs font-semibold tabular-nums text-yellow-500"
                  data-testid="working-session-indicator"
                  title={`${workingSessionCount} active ${workingSessionCount === 1 ? 'session' : 'sessions'}`}
                >
                  <AgentStateDot state="working" size="md" />
                  <span data-testid="working-session-count">{workingSessionCount}</span>
                </span>
              )}
            </div>
            <div className={SIDEBAR_HEADER_ACTIONS}>
              <ConnectionsButton />
              <RecentToggleButton />
              <SortProjectsButton />
              <AddProjectButton />
            </div>
          </div>
        )}

        {/* Orca list viewport (VirtualizedWorktreeViewport): pl-1 pt-px scroll root
            with the hover-reveal sidebar scrollbar; the flex gap stands in for the
            virtualizer's 6px row gap between the section lists. */}
        <div className={LIST_CONTAINER} data-worktree-sidebar-container="">
          <div
            className={cn(LIST_SCROLL, 'flex flex-col gap-1.5')}
            style={{ overflowAnchor: 'none' }}
            data-testid="sidebar-scroll-container"
          >
            <PinnedList />
            <RecentList />
            <ConnectionList />
            <ProjectList
              onAddProject={handleAddProject}
              filterQuery={debouncedFilterQuery}
              activeLanguages={activeLanguages}
            />
          </div>
        </div>

        {/* Orca footer slot: notice card(s) above the fixed bottom toolbar */}
        {!connectionModeActive && <UpdatePill />}
        {!connectionModeActive &&
          (shouldShowUsageIndicator ? <UsageIndicator /> : <SpacesTabBar />)}
      </aside>
      <ResizeHandle onResize={handleResize} direction="left" />
    </div>
  )
}
