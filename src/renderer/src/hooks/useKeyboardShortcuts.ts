import { useEffect, useCallback } from 'react'
import {
  useSessionStore,
  useProjectStore,
  useLayoutStore,
  useSessionHistoryStore,
  useCommandPaletteStore,
  useFileSearchStore,
  useSettingsStore,
  useKanbanStore,
  useVimModeStore,
  useConnectionStore,
  useSpaceStore
} from '@/stores'
import { useGitStore } from '@/stores/useGitStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useWorktreeStore, getOrderedProjectWorktrees } from '@/stores/useWorktreeStore'
import { useScriptStore, fireRunScript, killRunScript } from '@/stores/useScriptStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useTerminalTabStore } from '@/stores/useTerminalTabStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { eventMatchesBinding, type KeyBinding } from '@/lib/keyboard-shortcuts'
import { toast } from '@/lib/toast'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { systemApi } from '@/api/system-api'
import { opencodeApi } from '@/api/opencode-api'
import { worktreeApi } from '@/api/worktree-api'
import type { MenuActionChannel } from '@shared/menu-events'

/**
 * Check if the terminal panel is currently focused.
 * Returns true if the active element is inside a terminal view (.xterm) or
 * the terminal tab sidebar.
 */
function isTerminalFocused(): boolean {
  const active = document.activeElement
  if (!active) return false
  return (
    active.closest?.('.xterm') !== null ||
    active.closest?.('[data-testid="terminal-view"]') !== null
  )
}

/**
 * Runs or stops the project run script for the currently selected worktree.
 * Extracted so it can be shared between the keyboard shortcut and the menu action.
 */
function handleRunProject(): void {
  const worktreeId = useWorktreeStore.getState().selectedWorktreeId
  if (!worktreeId) {
    toast.error('Please select a worktree first')
    return
  }

  const { worktreesByProject } = useWorktreeStore.getState()
  let runScript: string | null = null
  let worktreePath: string | null = null

  for (const [projectId, wts] of worktreesByProject) {
    const wt = wts.find((w) => w.id === worktreeId)
    if (wt) {
      worktreePath = wt.path
      const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)
      runScript = proj?.run_script ?? null
      break
    }
  }

  if (!runScript) {
    toast.info('No run script configured. Add one in Project Settings.')
    return
  }
  if (!worktreePath) return

  const parseCommands = (script: string): string[] =>
    script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))

  // Switch to Run tab
  useLayoutStore.getState().setBottomPanelTab('run')

  const scriptState = useScriptStore.getState().getScriptState(worktreeId)

  if (scriptState.runRunning) {
    // Stop current run (Cmd/Ctrl+R acts as a start/stop toggle)
    killRunScript(worktreeId)
  } else {
    // Start fresh
    const commands = parseCommands(runScript)
    fireRunScript(worktreeId, commands, worktreePath)
  }
}

/**
 * Creates a new session for the currently selected worktree.
 * Shared between the keyboard shortcut handler and the main-process IPC listener.
 */
function createNewSession(): void {
  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore.getState()
  if (!selectedWorktreeId) {
    toast.error('Please select a worktree first')
    return
  }
  let projectId: string | null = null
  for (const [pid, worktrees] of worktreesByProject) {
    if (worktrees.find((w) => w.id === selectedWorktreeId)) {
      projectId = pid
      break
    }
  }
  if (!projectId) {
    toast.error('Please select a worktree first')
    return
  }
  useSessionStore
    .getState()
    .createSession(selectedWorktreeId, projectId)
    .then((result) => {
      if (result.success) {
        toast.success('New session created')
      } else {
        toast.error(result.error || 'Failed to create session')
      }
    })
}

/**
 * Cycles to the next/previous session tab in the current worktree or connection.
 * Wraps around at the ends. Shared between session:next and session:previous shortcuts.
 */
function cycleSession(direction: 1 | -1): void {
  const state = useSessionStore.getState()
  const { activeSessionId, activeWorktreeId, activeConnectionId } = state

  // Determine scope: connection mode when a connection is active and no worktree is
  const isConnectionMode = !!activeConnectionId && !activeWorktreeId
  const scopeId = isConnectionMode ? activeConnectionId : activeWorktreeId
  if (!scopeId) return

  const tabOrder = isConnectionMode
    ? state.tabOrderByConnection.get(scopeId) || []
    : state.tabOrderByWorktree.get(scopeId) || []

  // Always leave any file/diff view so the session becomes visible,
  // even when there is only one session tab to "cycle" to.
  useFileViewerStore.getState().setActiveFile(null)
  state.clearInlineConnectionSession()

  if (tabOrder.length === 0) return

  const currentIndex = activeSessionId ? tabOrder.indexOf(activeSessionId) : -1
  // With a single tab, still select it when it isn't the active session
  // (e.g. cycling away from the Board tab); otherwise nothing to cycle to.
  if (tabOrder.length === 1 && currentIndex === 0) return

  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : tabOrder.length - 1
      : (currentIndex + direction + tabOrder.length) % tabOrder.length
  const nextSessionId = tabOrder[nextIndex]
  if (!nextSessionId) return

  if (isConnectionMode) {
    state.setActiveConnectionSession(nextSessionId)
  } else {
    state.setActiveSession(nextSessionId)
  }
  // Match tab-click behavior: viewing the session clears its unread badge
  useWorktreeStatusStore.getState().clearSessionStatus(nextSessionId)
}

/**
 * Cycles to the next/previous worktree within the currently selected project.
 * Uses the sidebar display order (custom order, default worktree last) and
 * wraps around at the ends.
 */
function cycleWorktree(direction: 1 | -1): void {
  const wtState = useWorktreeStore.getState()
  const { selectedWorktreeId, worktreesByProject, worktreeOrderByProject } = wtState

  // Resolve project: from the selected worktree, or fall back to selected project
  let projectId: string | null = null
  if (selectedWorktreeId) {
    for (const [pid, worktrees] of worktreesByProject) {
      if (worktrees.some((w) => w.id === selectedWorktreeId)) {
        projectId = pid
        break
      }
    }
  }
  if (!projectId) projectId = useProjectStore.getState().selectedProjectId
  if (!projectId) return

  const ordered = getOrderedProjectWorktrees(worktreesByProject, worktreeOrderByProject, projectId)
  if (ordered.length === 0) return

  const currentIndex = selectedWorktreeId
    ? ordered.findIndex((w) => w.id === selectedWorktreeId)
    : -1
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : ordered.length - 1
      : (currentIndex + direction + ordered.length) % ordered.length
  const next = ordered[nextIndex]
  if (!next || next.id === selectedWorktreeId) return

  useProjectStore.getState().selectProject(projectId)
  wtState.selectWorktree(next.id)
  // Match mouse navigation: viewing the worktree clears its unread badge
  useWorktreeStatusStore.getState().clearWorktreeUnread(next.id)
}

/**
 * Cycles to the next/previous item in the sidebar — connections first (as
 * displayed above projects), then projects — as one unified list, wrapping
 * around at the ends. Landing on a connection selects it; landing on a
 * project selects it and its top worktree so the jump lands somewhere useful.
 */
function cycleProject(direction: 1 | -1): void {
  const projectState = useProjectStore.getState()
  const connectionState = useConnectionStore.getState()
  const { projects, selectedProjectId } = projectState
  const { connections, selectedConnectionId } = connectionState

  // Respect the active Space filter so cycling stays within the visible
  // sidebar list (mirrors ProjectList's space filtering)
  const { activeSpaceId, projectSpaceMap } = useSpaceStore.getState()
  const visibleProjects =
    activeSpaceId === null
      ? projects
      : projects.filter((p) => projectSpaceMap[p.id]?.includes(activeSpaceId))

  // Unified sidebar order: connections section first, then projects
  type SidebarItem = { kind: 'connection' | 'project'; id: string }
  const items: SidebarItem[] = [
    ...connections.map((c): SidebarItem => ({ kind: 'connection', id: c.id })),
    ...visibleProjects.map((p): SidebarItem => ({ kind: 'project', id: p.id }))
  ]
  if (items.length === 0) return

  // Current position: an explicitly selected connection wins (it clears
  // worktree/project selection); otherwise the selected project.
  const currentIndex = selectedConnectionId
    ? items.findIndex((i) => i.kind === 'connection' && i.id === selectedConnectionId)
    : selectedProjectId
      ? items.findIndex((i) => i.kind === 'project' && i.id === selectedProjectId)
      : -1
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : items.length - 1
      : (currentIndex + direction + items.length) % items.length
  const next = items[nextIndex]
  if (!next || nextIndex === currentIndex) return

  if (next.kind === 'connection') {
    connectionState.selectConnection(next.id)
    return
  }

  // Landing on a project: clear any connection selection and select the project
  if (selectedConnectionId) connectionState.selectConnection(null)
  projectState.selectProject(next.id)

  // Select the project's top worktree (sidebar order) so the jump is useful
  const wtState = useWorktreeStore.getState()
  const load =
    wtState.worktreesByProject.has(next.id)
      ? Promise.resolve()
      : wtState.loadWorktrees(next.id) ?? Promise.resolve()
  void Promise.resolve(load).then(() => {
    const state = useWorktreeStore.getState()
    // Bail if the user has moved on to another project meanwhile
    if (useProjectStore.getState().selectedProjectId !== next.id) return
    if (useConnectionStore.getState().selectedConnectionId) return
    const ordered = getOrderedProjectWorktrees(
      state.worktreesByProject,
      state.worktreeOrderByProject,
      next.id
    )
    if (ordered[0]) {
      state.selectWorktree(ordered[0].id)
      useWorktreeStatusStore.getState().clearWorktreeUnread(ordered[0].id)
    }
  })
}

/**
 * Checks whether any modal/dialog is currently open and closes it.
 * Returns `true` if a modal was closed, `false` otherwise.
 *
 * Used as the highest-priority handler for Cmd+W / Ctrl+W so that
 * pressing the shortcut dismisses the topmost overlay instead of
 * closing a session or file tab.
 */
function tryCloseOpenModal(): boolean {
  // Command palette (highest z-layer, often overlays other modals)
  if (useCommandPaletteStore.getState().isOpen) {
    useCommandPaletteStore.getState().close()
    return true
  }

  // File search dialog
  if (useFileSearchStore.getState().isOpen) {
    useFileSearchStore.getState().close()
    return true
  }

  // Settings modal
  if (useSettingsStore.getState().isOpen) {
    useSettingsStore.getState().closeSettings()
    return true
  }

  // Session history panel
  if (useSessionHistoryStore.getState().isOpen) {
    useSessionHistoryStore.getState().closePanel()
    return true
  }

  // Kanban ticket detail modal
  if (useKanbanStore.getState().selectedTicketId !== null) {
    useKanbanStore.getState().setSelectedTicketId(null)
    return true
  }

  // Project settings dialog
  if (useProjectStore.getState().settingsProjectId !== null) {
    useProjectStore.getState().closeProjectSettings()
    return true
  }

  // Vim mode help overlay
  if (useVimModeStore.getState().helpOverlayOpen) {
    useVimModeStore.getState().setHelpOverlayOpen(false)
    return true
  }

  return false
}

/**
 * Centralized keyboard shortcuts hook.
 * Registers a single global keydown listener that dispatches to the
 * correct action based on the shortcut registry and user overrides.
 *
 * Must be called once at the top-level (AppLayout).
 */
export function useKeyboardShortcuts(): void {
  const getEffectiveBinding = useShortcutStore((s) => s.getEffectiveBinding)

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Skip if the user is typing in an input/textarea (except for specific shortcuts)
      const target = event.target as HTMLElement
      const isInputFocused =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      // Build a list of shortcut handlers
      // Each entry: [shortcutId, binding, handler, allowInInput]
      const shortcuts = getShortcutHandlers(getEffectiveBinding, isInputFocused)

      // Don't intercept bare-key shortcuts (no modifiers) when the xterm terminal
      // is focused — the terminal needs unmodified keystrokes for shell features
      // like Tab completion. Modified shortcuts (Cmd+T, Cmd+W, etc.) still work.
      // Also skip bare Tab (no ctrl) since the terminal uses it for completion,
      // but allow Ctrl+Tab through for terminal tab cycling.
      const isXtermFocused = target.closest?.('.xterm') !== null

      // Ctrl+[ is the Escape equivalent in terminals (and Vim), and Ctrl+] is
      // Vim's "jump to tag/definition". Never intercept them while the
      // terminal is focused, even though meta-modifier bindings also match
      // Ctrl on Windows/Linux.
      if (
        isXtermFocused &&
        event.ctrlKey &&
        !event.metaKey &&
        (event.key === '[' || event.key === ']')
      ) {
        return
      }

      for (const { binding, handler, allowInInput } of shortcuts) {
        if (!binding) continue
        if (isInputFocused && !allowInInput) continue
        if (isXtermFocused && binding.modifiers.length === 0) continue
        if (
          isXtermFocused &&
          binding.key?.toLowerCase() === 'tab' &&
          !binding.modifiers.includes('ctrl')
        )
          continue

        if (eventMatchesBinding(event, binding)) {
          event.preventDefault()
          event.stopPropagation()
          handler()
          return
        }
      }
    },
    [getEffectiveBinding]
  )

  useEffect(() => {
    // Use capture phase to intercept Tab key before browser handles focus/tab insertion
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])

  // Listen for Cmd+T / Ctrl+T forwarded from the main process via WebSocket
  useEffect(() => {
    const cleanup = systemApi.onNewSessionShortcut(() => {
      if (isTerminalFocused()) {
        const worktreeId = useWorktreeStore.getState().selectedWorktreeId
        if (worktreeId) {
          useTerminalTabStore.getState().createTab(worktreeId)
        }
        return
      }
      createNewSession()
    })

    return cleanup
  }, [])

  // Listen for Cmd+D / Ctrl+D forwarded from the main process via WebSocket
  useEffect(() => {
    const cleanup = systemApi.onFileSearchShortcut(() => {
      useFileSearchStore.getState().toggle()
    })

    return cleanup
  }, [])

  // Listen for application menu actions forwarded from the main process via IPC
  useMenuActionListeners()

  // Reactively update menu enabled/disabled state based on active session/worktree
  useMenuStateUpdater()

  // Listen for Cmd+W / Ctrl+W forwarded from the main process via WebSocket
  useEffect(() => {
    const cleanup = systemApi.onCloseSessionShortcut(() => {
      // Priority 0: Close any open modal/dialog
      if (tryCloseOpenModal()) return

      // Priority 0.5: Close active terminal tab when terminal is focused
      if (isTerminalFocused()) {
        const worktreeId = useWorktreeStore.getState().selectedWorktreeId
        if (worktreeId) {
          const activeTab = useTerminalTabStore.getState().getActiveTab(worktreeId)
          if (activeTab) {
            if (activeTab.status === 'running') {
              window.dispatchEvent(
                new CustomEvent('hive:close-terminal-tab', {
                  detail: { worktreeId, tabId: activeTab.id, tabName: activeTab.name }
                })
              )
            } else {
              useTerminalTabStore.getState().closeTab(worktreeId, activeTab.id)
              useTerminalStore.getState().destroyTerminal(activeTab.id)
            }
          }
        }
        return
      }

      const { activeFilePath, activeDiff } = useFileViewerStore.getState()

      // Priority 1: Close active diff tab
      if (activeFilePath?.startsWith('diff:')) {
        useFileViewerStore.getState().closeDiffTab(activeFilePath)
        return
      }

      // Priority 2: Close active file tab
      if (activeFilePath) {
        useFileViewerStore.getState().requestCloseFile(activeFilePath)
        return
      }

      // Priority 3: Clear active diff view (legacy — diff without tab)
      if (activeDiff) {
        useFileViewerStore.getState().clearActiveDiff()
        return
      }

      // Priority 4: Close active session tab
      const { activeSessionId } = useSessionStore.getState()
      if (!activeSessionId) return
      useSessionStore
        .getState()
        .closeSession(activeSessionId)
        .then((result) => {
          if (result.success) {
            toast.success('Session closed')
          } else {
            toast.error(result.error || 'Failed to close session')
          }
        })
    })

    return cleanup
  }, [])
}

interface ShortcutHandler {
  id: string
  binding: KeyBinding | null
  handler: () => void
  allowInInput: boolean
}

/**
 * Builds the list of active shortcuts and their handlers.
 * Reads directly from stores (outside React) for fresh state on each keypress.
 */
function getShortcutHandlers(
  getEffectiveBinding: (id: string) => KeyBinding | null,
  _isInputFocused: boolean
): ShortcutHandler[] {
  return [
    // =====================
    // Session shortcuts
    // =====================
    {
      id: 'session:new',
      binding: getEffectiveBinding('session:new'),
      allowInInput: true,
      handler: () => {
        if (isTerminalFocused()) {
          const worktreeId = useWorktreeStore.getState().selectedWorktreeId
          if (worktreeId) {
            useTerminalTabStore.getState().createTab(worktreeId)
          }
          return
        }
        createNewSession()
      }
    },
    {
      id: 'session:close',
      binding: getEffectiveBinding('session:close'),
      allowInInput: true,
      handler: () => {
        // Priority 0: Close any open modal/dialog
        if (tryCloseOpenModal()) return

        // Priority 0.5: Close active terminal tab when terminal is focused
        if (isTerminalFocused()) {
          const worktreeId = useWorktreeStore.getState().selectedWorktreeId
          if (worktreeId) {
            const activeTab = useTerminalTabStore.getState().getActiveTab(worktreeId)
            if (activeTab) {
              if (activeTab.status === 'running') {
                // Dispatch a custom event that TerminalTabSidebar can listen for
                // to show the close confirmation dialog
                window.dispatchEvent(
                  new CustomEvent('hive:close-terminal-tab', {
                    detail: { worktreeId, tabId: activeTab.id, tabName: activeTab.name }
                  })
                )
              } else {
                // Non-running tab: close directly
                useTerminalTabStore.getState().closeTab(worktreeId, activeTab.id)
                // Destroy the PTY
                useTerminalStore.getState().destroyTerminal(activeTab.id)
              }
            }
          }
          return
        }

        const { activeFilePath, activeDiff } = useFileViewerStore.getState()

        // Priority 1: Close active diff tab
        if (activeFilePath?.startsWith('diff:')) {
          useFileViewerStore.getState().closeDiffTab(activeFilePath)
          return
        }

        // Priority 2: Close active file tab
        if (activeFilePath) {
          useFileViewerStore.getState().requestCloseFile(activeFilePath)
          return
        }

        // Priority 3: Clear active diff view (legacy — diff without tab)
        if (activeDiff) {
          useFileViewerStore.getState().clearActiveDiff()
          return
        }

        // Priority 4: Close active session tab
        const { activeSessionId } = useSessionStore.getState()
        if (!activeSessionId) return
        useSessionStore
          .getState()
          .closeSession(activeSessionId)
          .then((result) => {
            if (result.success) {
              toast.success('Session closed')
            } else {
              toast.error(result.error || 'Failed to close session')
            }
          })
      }
    },
    {
      id: 'session:next',
      binding: getEffectiveBinding('session:next'),
      allowInInput: true,
      handler: () => {
        cycleSession(1)
      }
    },
    {
      id: 'session:previous',
      binding: getEffectiveBinding('session:previous'),
      allowInInput: true,
      handler: () => {
        cycleSession(-1)
      }
    },
    {
      id: 'session:mode-toggle',
      binding: getEffectiveBinding('session:mode-toggle'),
      allowInInput: true, // Tab should work even in inputs
      handler: () => {
        const { activeSessionId } = useSessionStore.getState()
        if (!activeSessionId) return
        useSessionStore.getState().toggleSessionMode(activeSessionId)
      }
    },
    {
      id: 'session:super-plan-toggle',
      binding: getEffectiveBinding('session:super-plan-toggle'),
      allowInInput: true,
      handler: () => {
        const { activeSessionId } = useSessionStore.getState()
        if (!activeSessionId) return
        useSessionStore.getState().toggleSuperPlanShortcut(activeSessionId)
      }
    },
    {
      id: 'project:run',
      binding: getEffectiveBinding('project:run'),
      allowInInput: true,
      handler: handleRunProject
    },

    {
      id: 'model:cycle-variant',
      binding: getEffectiveBinding('model:cycle-variant'),
      allowInInput: true,
      handler: () => {
        window.dispatchEvent(new CustomEvent('hive:cycle-variant'))
      }
    },

    // =====================
    // Navigation shortcuts
    // =====================
    {
      id: 'nav:file-search',
      binding: getEffectiveBinding('nav:file-search'),
      allowInInput: true,
      handler: () => {
        useFileSearchStore.getState().toggle()
      }
    },
    {
      id: 'nav:command-palette',
      binding: getEffectiveBinding('nav:command-palette'),
      allowInInput: true,
      handler: () => {
        useCommandPaletteStore.getState().toggle()
      }
    },
    {
      id: 'nav:session-history',
      binding: getEffectiveBinding('nav:session-history'),
      allowInInput: false,
      handler: () => {
        useSessionHistoryStore.getState().togglePanel()
      }
    },
    {
      id: 'nav:new-worktree',
      binding: getEffectiveBinding('nav:new-worktree'),
      allowInInput: false,
      handler: () => {
        toast.info('Use the + button in the sidebar to create a new worktree')
      }
    },
    {
      id: 'nav:filter-projects',
      binding: getEffectiveBinding('nav:filter-projects'),
      allowInInput: true,
      handler: () => {
        // Open left sidebar if collapsed
        const { leftSidebarCollapsed, setLeftSidebarCollapsed } = useLayoutStore.getState()
        if (leftSidebarCollapsed) {
          setLeftSidebarCollapsed(false)
        }
        // Dispatch focus event (allow a tick for sidebar to render)
        setTimeout(
          () => {
            window.dispatchEvent(new CustomEvent('hive:focus-project-filter'))
          },
          leftSidebarCollapsed ? 100 : 0
        )
      }
    },

    {
      id: 'nav:toggle-project-expand',
      binding: getEffectiveBinding('nav:toggle-project-expand'),
      allowInInput: true,
      handler: () => {
        const { selectedProjectId, toggleProjectExpanded } = useProjectStore.getState()
        if (!selectedProjectId) return
        // Ensure the sidebar is visible so the toggle has a visible effect
        const { leftSidebarCollapsed, setLeftSidebarCollapsed } = useLayoutStore.getState()
        if (leftSidebarCollapsed) setLeftSidebarCollapsed(false)
        toggleProjectExpanded(selectedProjectId)
      }
    },
    {
      id: 'nav:next-worktree',
      binding: getEffectiveBinding('nav:next-worktree'),
      allowInInput: true,
      handler: () => {
        cycleWorktree(1)
      }
    },
    {
      id: 'nav:previous-worktree',
      binding: getEffectiveBinding('nav:previous-worktree'),
      allowInInput: true,
      handler: () => {
        cycleWorktree(-1)
      }
    },
    {
      id: 'nav:next-project',
      binding: getEffectiveBinding('nav:next-project'),
      allowInInput: true,
      handler: () => {
        cycleProject(1)
      }
    },
    {
      id: 'nav:previous-project',
      binding: getEffectiveBinding('nav:previous-project'),
      allowInInput: true,
      handler: () => {
        cycleProject(-1)
      }
    },

    // =====================
    // Git shortcuts
    // =====================
    {
      id: 'git:commit',
      binding: getEffectiveBinding('git:commit'),
      allowInInput: false,
      handler: () => {
        // Focus the commit form by dispatching a custom event
        window.dispatchEvent(new CustomEvent('hive:focus-commit'))
        // Also ensure right sidebar is open
        const { rightSidebarCollapsed, setRightSidebarCollapsed } = useLayoutStore.getState()
        if (rightSidebarCollapsed) {
          setRightSidebarCollapsed(false)
        }
      }
    },
    {
      id: 'git:push',
      binding: getEffectiveBinding('git:push'),
      allowInInput: false,
      handler: () => {
        const worktreePath = getActiveWorktreePath()
        if (!worktreePath) {
          toast.error('Please select a worktree first')
          return
        }
        const { isPushing } = useGitStore.getState()
        if (isPushing) return
        useGitStore
          .getState()
          .push(worktreePath)
          .then((result) => {
            if (result.success) {
              toast.success('Pushed successfully')
            } else {
              toast.error(result.error || 'Failed to push')
            }
          })
      }
    },
    {
      id: 'git:pull',
      binding: getEffectiveBinding('git:pull'),
      allowInInput: false,
      handler: () => {
        const worktreePath = getActiveWorktreePath()
        if (!worktreePath) {
          toast.error('Please select a worktree first')
          return
        }
        const { isPulling } = useGitStore.getState()
        if (isPulling) return
        useGitStore
          .getState()
          .pull(worktreePath)
          .then((result) => {
            if (result.success) {
              toast.success('Pulled successfully')
            } else {
              toast.error(result.error || 'Failed to pull')
            }
          })
      }
    },

    // =====================
    // Sidebar shortcuts
    // =====================
    {
      id: 'sidebar:toggle-left',
      binding: getEffectiveBinding('sidebar:toggle-left'),
      allowInInput: false,
      handler: () => {
        useLayoutStore.getState().toggleLeftSidebar()
      }
    },
    {
      id: 'sidebar:toggle-right',
      binding: getEffectiveBinding('sidebar:toggle-right'),
      allowInInput: false,
      handler: () => {
        useLayoutStore.getState().toggleRightSidebar()
      }
    },
    {
      id: 'sidebar:toggle-bottom-terminal',
      binding: getEffectiveBinding('sidebar:toggle-bottom-terminal'),
      allowInInput: true,
      handler: () => {
        const terminalPosition = useSettingsStore.getState().terminalPosition
        if (terminalPosition === 'bottom') {
          useLayoutStore.getState().toggleBottomTerminal()
        } else {
          // In sidebar mode: open right sidebar + switch to terminal tab
          const layout = useLayoutStore.getState()
          if (layout.rightSidebarCollapsed) layout.setRightSidebarCollapsed(false)
          layout.setBottomPanelTab('terminal')
          if (layout.collapsedPanel === 'bottom') layout.toggleBottomPanel()
        }
      }
    },

    // =====================
    // Focus shortcuts
    // =====================
    {
      id: 'focus:left-sidebar',
      binding: getEffectiveBinding('focus:left-sidebar'),
      allowInInput: true,
      handler: () => {
        const sidebar = document.querySelector('[data-testid="left-sidebar"]') as HTMLElement
        if (sidebar) {
          // Focus the first focusable element within the sidebar
          const focusable = sidebar.querySelector<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
          if (focusable) {
            focusable.focus()
          } else {
            sidebar.focus()
          }
        }
      }
    },
    {
      id: 'focus:main-pane',
      binding: getEffectiveBinding('focus:main-pane'),
      allowInInput: true,
      handler: () => {
        const mainPane = document.querySelector('[data-testid="main-pane"]') as HTMLElement
        if (mainPane) {
          const focusable = mainPane.querySelector<HTMLElement>(
            'textarea, input, button, [href], select, [tabindex]:not([tabindex="-1"])'
          )
          if (focusable) {
            focusable.focus()
          } else {
            mainPane.focus()
          }
        }
      }
    },

    // =====================
    // Terminal tab cycling
    // =====================
    {
      id: 'terminal:next-tab',
      binding: { key: 'Tab', modifiers: ['ctrl'] },
      allowInInput: true,
      handler: () => {
        const worktreeId = useWorktreeStore.getState().selectedWorktreeId
        if (worktreeId) {
          useTerminalTabStore.getState().cycleTab(worktreeId, 'next')
        }
      }
    },
    {
      id: 'terminal:prev-tab',
      binding: { key: 'Tab', modifiers: ['ctrl', 'shift'] },
      allowInInput: true,
      handler: () => {
        const worktreeId = useWorktreeStore.getState().selectedWorktreeId
        if (worktreeId) {
          useTerminalTabStore.getState().cycleTab(worktreeId, 'prev')
        }
      }
    },

    // =====================
    // Settings shortcuts
    // =====================
    {
      id: 'settings:open',
      binding: getEffectiveBinding('settings:open'),
      allowInInput: false,
      handler: () => {
        window.dispatchEvent(new CustomEvent('hive:open-settings'))
      }
    }
  ]
}

/**
 * Get the file path of the currently active worktree.
 */
function getActiveWorktreePath(): string | null {
  const { activeWorktreeId } = useSessionStore.getState()
  if (!activeWorktreeId) return null

  const { worktreesByProject } = useWorktreeStore.getState()
  for (const worktrees of worktreesByProject.values()) {
    const worktree = worktrees.find((w) => w.id === activeWorktreeId)
    if (worktree) return worktree.path
  }
  return null
}

/**
 * Listens for menu:* IPC channels sent from the application menu and
 * dispatches them to the appropriate store actions / custom events.
 */
function useMenuActionListeners(): void {
  useEffect(() => {
    const cleanups: (() => void)[] = []

    const on = (channel: MenuActionChannel, handler: () => void): void => {
      cleanups.push(systemApi.onMenuAction(channel, handler))
    }

    on('menu:new-worktree', () => {
      const { selectedProjectId } = useProjectStore.getState()
      if (!selectedProjectId) {
        toast.info('Please select a project first')
        return
      }
      useWorktreeStore.getState().setCreatingForProject(selectedProjectId)
    })

    on('menu:add-project', () => {
      window.dispatchEvent(new CustomEvent('hive:add-project'))
    })

    on('menu:toggle-mode', () => {
      const { activeSessionId } = useSessionStore.getState()
      if (!activeSessionId) return
      useSessionStore.getState().toggleSessionMode(activeSessionId)
    })

    on('menu:cycle-model', () => {
      window.dispatchEvent(new CustomEvent('hive:cycle-variant'))
    })

    on('menu:run-project', () => {
      handleRunProject()
    })

    on('menu:undo-turn', () => {
      window.dispatchEvent(new CustomEvent('hive:undo-turn'))
    })

    on('menu:redo-turn', () => {
      window.dispatchEvent(new CustomEvent('hive:redo-turn'))
    })

    on('menu:commit', () => {
      window.dispatchEvent(new CustomEvent('hive:focus-commit'))
      const { rightSidebarCollapsed, setRightSidebarCollapsed } = useLayoutStore.getState()
      if (rightSidebarCollapsed) {
        setRightSidebarCollapsed(false)
      }
    })

    on('menu:push', () => {
      const worktreePath = getActiveWorktreePath()
      if (!worktreePath) {
        toast.error('Please select a worktree first')
        return
      }
      useGitStore
        .getState()
        .push(worktreePath)
        .then((result) => {
          if (result.success) {
            toast.success('Pushed successfully')
          } else {
            toast.error(result.error || 'Failed to push')
          }
        })
    })

    on('menu:pull', () => {
      const worktreePath = getActiveWorktreePath()
      if (!worktreePath) {
        toast.error('Please select a worktree first')
        return
      }
      useGitStore
        .getState()
        .pull(worktreePath)
        .then((result) => {
          if (result.success) {
            toast.success('Pulled successfully')
          } else {
            toast.error(result.error || 'Failed to pull')
          }
        })
    })

    on('menu:stage-all', () => {
      const worktreePath = getActiveWorktreePath()
      if (!worktreePath) return
      useGitStore.getState().stageAll(worktreePath)
    })

    on('menu:unstage-all', () => {
      const worktreePath = getActiveWorktreePath()
      if (!worktreePath) return
      useGitStore.getState().unstageAll(worktreePath)
    })

    on('menu:open-in-editor', () => {
      const worktreePath = getActiveWorktreePath()
      if (!worktreePath) return
      worktreeApi.openInEditor(worktreePath).catch(console.error)
    })

    on('menu:open-in-terminal', () => {
      const worktreePath = getActiveWorktreePath()
      if (!worktreePath) return
      worktreeApi.openInTerminal(worktreePath).catch(console.error)
    })

    on('menu:command-palette', () => {
      useCommandPaletteStore.getState().toggle()
    })

    on('menu:session-history', () => {
      useSessionHistoryStore.getState().togglePanel()
    })

    on('menu:toggle-left-sidebar', () => {
      useLayoutStore.getState().toggleLeftSidebar()
    })

    on('menu:toggle-right-sidebar', () => {
      useLayoutStore.getState().toggleRightSidebar()
    })

    on('menu:focus-left-sidebar', () => {
      const sidebar = document.querySelector('[data-testid="left-sidebar"]') as HTMLElement
      if (sidebar) {
        const focusable = sidebar.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (focusable) focusable.focus()
        else sidebar.focus()
      }
    })

    on('menu:focus-main-pane', () => {
      const mainPane = document.querySelector('[data-testid="main-pane"]') as HTMLElement
      if (mainPane) {
        const focusable = mainPane.querySelector<HTMLElement>(
          'textarea, input, button, [href], select, [tabindex]:not([tabindex="-1"])'
        )
        if (focusable) focusable.focus()
        else mainPane.focus()
      }
    })

    return () => {
      for (const cleanup of cleanups) {
        cleanup()
      }
    }
  }, [])
}

/**
 * Reactively updates the application menu enabled/disabled state based on
 * whether a session and worktree are currently active.
 */
function useMenuStateUpdater(): void {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)

  const opencodeSessionId = useSessionStore((state) => {
    if (!activeSessionId) return null
    for (const sessions of state.sessionsByWorktree.values()) {
      const found = sessions.find((s) => s.id === activeSessionId)
      if (found) return found.opencode_session_id
    }
    return null
  })

  useEffect(() => {
    const baseState = {
      hasActiveSession: !!activeSessionId,
      hasActiveWorktree: !!selectedWorktreeId
    }

    if (!activeSessionId || !opencodeSessionId) {
      void systemApi.updateMenuState(baseState).catch(() => {})
      return
    }

    opencodeApi
      .capabilities(opencodeSessionId)
      .then(unwrapEnvelope)
      .then((result) => {
        void systemApi
          .updateMenuState({
            ...baseState,
            canUndo: result.success ? result.capabilities?.supportsUndo : true,
            canRedo: result.success ? result.capabilities?.supportsRedo : true
          })
          .catch(() => {})
      })
      .catch(() => {
        void systemApi.updateMenuState(baseState).catch(() => {})
      })
  }, [activeSessionId, selectedWorktreeId, opencodeSessionId])
}
