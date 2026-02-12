import { useEffect, useCallback } from 'react'
import {
  useSessionStore,
  useProjectStore,
  useLayoutStore,
  useSessionHistoryStore,
  useCommandPaletteStore,
  useFileSearchStore
} from '@/stores'
import { useGitStore } from '@/stores/useGitStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { eventMatchesBinding, type KeyBinding } from '@/lib/keyboard-shortcuts'
import { toast } from '@/lib/toast'

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
    window.scriptOps.kill(worktreeId).then(() => {
      useScriptStore.getState().setRunRunning(worktreeId, false)
      useScriptStore.getState().setRunPid(worktreeId, null)
    })
  } else {
    // Start fresh
    useScriptStore.getState().clearRunOutput(worktreeId)
    useScriptStore.getState().setRunRunning(worktreeId, true)

    const commands = parseCommands(runScript)

    window.scriptOps.runProject(commands, worktreePath, worktreeId).then((result) => {
      if (result.success && result.pid) {
        useScriptStore.getState().setRunPid(worktreeId, result.pid)
      } else {
        useScriptStore.getState().setRunRunning(worktreeId, false)
      }
    })
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

      for (const { binding, handler, allowInInput } of shortcuts) {
        if (!binding) continue
        if (isInputFocused && !allowInInput) continue

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

  // Listen for Cmd+T / Ctrl+T forwarded from the main process via IPC
  useEffect(() => {
    if (!window.systemOps?.onNewSessionShortcut) return

    const cleanup = window.systemOps.onNewSessionShortcut(() => {
      createNewSession()
    })

    return cleanup
  }, [])

  // Listen for Cmd+D / Ctrl+D forwarded from the main process via IPC
  useEffect(() => {
    if (!window.systemOps?.onFileSearchShortcut) return

    const cleanup = window.systemOps.onFileSearchShortcut(() => {
      useFileSearchStore.getState().toggle()
    })

    return cleanup
  }, [])

  // Listen for application menu actions forwarded from the main process via IPC
  useMenuActionListeners()

  // Reactively update menu enabled/disabled state based on active session/worktree
  useMenuStateUpdater()

  // Listen for Cmd+W / Ctrl+W forwarded from the main process via IPC
  useEffect(() => {
    if (!window.systemOps?.onCloseSessionShortcut) return

    const cleanup = window.systemOps.onCloseSessionShortcut(() => {
      const { activeFilePath, activeDiff } = useFileViewerStore.getState()

      // Priority 1: Close active diff tab
      if (activeFilePath?.startsWith('diff:')) {
        useFileViewerStore.getState().closeDiffTab(activeFilePath)
        return
      }

      // Priority 2: Close active file tab
      if (activeFilePath) {
        useFileViewerStore.getState().closeFile(activeFilePath)
        return
      }

      // Priority 3: Clear active diff view (legacy — diff without tab)
      if (activeDiff) {
        useFileViewerStore.getState().clearActiveDiff()
        return
      }

      // Priority 3: Close active session tab
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
        createNewSession()
      }
    },
    {
      id: 'session:close',
      binding: getEffectiveBinding('session:close'),
      allowInInput: true,
      handler: () => {
        const { activeFilePath, activeDiff } = useFileViewerStore.getState()

        // Priority 1: Close active diff tab
        if (activeFilePath?.startsWith('diff:')) {
          useFileViewerStore.getState().closeDiffTab(activeFilePath)
          return
        }

        // Priority 2: Close active file tab
        if (activeFilePath) {
          useFileViewerStore.getState().closeFile(activeFilePath)
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
    if (!window.systemOps?.onMenuAction) return

    const cleanups: (() => void)[] = []

    const on = (channel: string, handler: () => void): void => {
      cleanups.push(window.systemOps.onMenuAction(channel, handler))
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
      window.worktreeOps.openInEditor(worktreePath)
    })

    on('menu:open-in-terminal', () => {
      const worktreePath = getActiveWorktreePath()
      if (!worktreePath) return
      window.worktreeOps.openInTerminal(worktreePath)
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

  useEffect(() => {
    if (!window.systemOps?.updateMenuState) return
    window.systemOps.updateMenuState({
      hasActiveSession: !!activeSessionId,
      hasActiveWorktree: !!selectedWorktreeId
    })
  }, [activeSessionId, selectedWorktreeId])
}
