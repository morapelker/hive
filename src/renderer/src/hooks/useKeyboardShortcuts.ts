import { useEffect, useCallback } from 'react'
import {
  useSessionStore,
  useProjectStore,
  useLayoutStore,
  useSessionHistoryStore,
  useCommandPaletteStore
} from '@/stores'
import { useGitStore } from '@/stores/useGitStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { eventMatchesBinding, type KeyBinding } from '@/lib/keyboard-shortcuts'
import { toast } from 'sonner'

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
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable

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
      allowInInput: false,
      handler: () => {
        const { activeWorktreeId } = useSessionStore.getState()
        const { selectedProjectId } = useProjectStore.getState()
        if (!activeWorktreeId || !selectedProjectId) {
          toast.error('Please select a worktree first')
          return
        }
        useSessionStore.getState().createSession(activeWorktreeId, selectedProjectId).then((result) => {
          if (result.success) {
            toast.success('New session created')
          } else {
            toast.error(result.error || 'Failed to create session')
          }
        })
      }
    },
    {
      id: 'session:close',
      binding: getEffectiveBinding('session:close'),
      allowInInput: false,
      handler: () => {
        const { activeSessionId } = useSessionStore.getState()
        if (!activeSessionId) return // noop if no session
        useSessionStore.getState().closeSession(activeSessionId).then((result) => {
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
      allowInInput: false,
      handler: () => {
        const worktreeId = useWorktreeStore.getState().selectedWorktreeId
        if (!worktreeId) {
          toast.error('Please select a worktree first')
          return
        }

        // Find project for this worktree
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
          script.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

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
    },

    // =====================
    // Navigation shortcuts
    // =====================
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
        useGitStore.getState().push(worktreePath).then((result) => {
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
        useGitStore.getState().pull(worktreePath).then((result) => {
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
