import { useEffect, useMemo, useCallback, useState } from 'react'
import {
  useProjectStore,
  useWorktreeStore,
  useSessionStore,
  useThemeStore,
  useSessionHistoryStore,
  useLayoutStore,
  useSettingsStore
} from '@/stores'
import { THEME_PRESETS } from '@/lib/themes'
import { useGitStore } from '@/stores/useGitStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useCommandPaletteStore, type Command } from '@/stores/useCommandPaletteStore'
import { commandRegistry, fuzzySearch } from '@/lib/command-registry'
import { toast } from '@/lib/toast'

/**
 * Hook that registers all available commands and returns filtered commands
 * based on the current search query and context.
 */
export function useCommands() {
  // Get store state and actions
  const { projects, selectedProjectId, selectProject, toggleProjectExpanded } = useProjectStore()
  const { worktreesByProject, selectWorktree, getWorktreesForProject } = useWorktreeStore()
  const {
    activeWorktreeId,
    activeSessionId,
    createSession,
    closeSession,
    setActiveSession,
    getSessionsForWorktree
  } = useSessionStore()
  const { themeId, setTheme, previewTheme, cancelPreview } = useThemeStore()
  const { togglePanel: toggleSessionHistory } = useSessionHistoryStore()
  const { stageAll, unstageAll, refreshStatuses, push, pull, isPushing, isPulling } = useGitStore()
  const { toggleLeftSidebar, toggleRightSidebar } = useLayoutStore()
  const { getDisplayString } = useShortcutStore()
  const {
    searchQuery,
    recentCommandIds,
    close: closeCommandPalette,
    addRecentCommand,
    pushCommandLevel
  } = useCommandPaletteStore()

  // Track whether the app is running in packaged mode (not dev)
  const [isPackaged, setIsPackaged] = useState(false)
  useEffect(() => {
    window.systemOps.isPackaged().then(setIsPackaged)
  }, [])

  // Get the currently selected worktree path
  const getActiveWorktreePath = useCallback(() => {
    if (!activeWorktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const worktree = worktrees.find((w) => w.id === activeWorktreeId)
      if (worktree) return worktree.path
    }
    return null
  }, [activeWorktreeId, worktreesByProject])

  // Register all commands on mount
  useEffect(() => {
    const commands: Command[] = [
      // =====================
      // NAVIGATION COMMANDS
      // =====================
      {
        id: 'nav:session-history',
        label: 'Open Session History',
        description: 'Search and browse past sessions',
        category: 'navigation',
        icon: 'History',
        shortcut: getDisplayString('nav:session-history'),
        keywords: ['history', 'search', 'past', 'sessions'],
        action: () => {
          closeCommandPalette()
          toggleSessionHistory()
        }
      },
      {
        id: 'nav:switch-project',
        label: 'Switch to Project',
        description: 'Navigate to a different project',
        category: 'navigation',
        icon: 'Folder',
        keywords: ['project', 'switch', 'change'],
        hasChildren: true,
        getChildren: () =>
          projects.map((project) => ({
            id: `nav:project:${project.id}`,
            label: project.name,
            description: project.path,
            category: 'navigation' as const,
            icon: 'Folder',
            action: () => {
              selectProject(project.id)
              toggleProjectExpanded(project.id)
              closeCommandPalette()
              toast.success(`Switched to ${project.name}`)
            }
          })),
        action: () => {
          const children =
            projects.map((project) => ({
              id: `nav:project:${project.id}`,
              label: project.name,
              description: project.path,
              category: 'navigation' as const,
              icon: 'Folder',
              action: () => {
                selectProject(project.id)
                toggleProjectExpanded(project.id)
                closeCommandPalette()
                toast.success(`Switched to ${project.name}`)
              }
            })) || []
          pushCommandLevel(children, {
            id: 'nav:switch-project',
            label: 'Switch to Project',
            category: 'navigation',
            action: () => {}
          })
        },
        isVisible: () => projects.length > 0
      },
      {
        id: 'nav:switch-worktree',
        label: 'Switch to Worktree',
        description: 'Navigate to a different worktree',
        category: 'navigation',
        icon: 'GitBranch',
        keywords: ['worktree', 'branch', 'switch'],
        hasChildren: true,
        action: () => {
          if (!selectedProjectId) {
            toast.error('Please select a project first')
            return
          }
          const worktrees = getWorktreesForProject(selectedProjectId)
          const children = worktrees.map((worktree) => ({
            id: `nav:worktree:${worktree.id}`,
            label: worktree.name,
            description: worktree.branch_name,
            category: 'navigation' as const,
            icon: 'GitBranch',
            action: () => {
              selectWorktree(worktree.id)
              closeCommandPalette()
              toast.success(`Switched to ${worktree.name}`)
            }
          }))
          pushCommandLevel(children, {
            id: 'nav:switch-worktree',
            label: 'Switch to Worktree',
            category: 'navigation',
            action: () => {}
          })
        },
        isVisible: () => selectedProjectId !== null
      },
      {
        id: 'nav:switch-session',
        label: 'Switch to Session',
        description: 'Navigate to a different session tab',
        category: 'navigation',
        icon: 'MessageSquare',
        keywords: ['session', 'tab', 'switch'],
        hasChildren: true,
        action: () => {
          if (!activeWorktreeId) {
            toast.error('Please select a worktree first')
            return
          }
          const sessions = getSessionsForWorktree(activeWorktreeId)
          const children = sessions.map((session) => ({
            id: `nav:session:${session.id}`,
            label: session.name || 'Untitled Session',
            description: `Created ${new Date(session.created_at).toLocaleString()}`,
            category: 'navigation' as const,
            icon: 'MessageSquare',
            action: () => {
              setActiveSession(session.id)
              closeCommandPalette()
            }
          }))
          pushCommandLevel(children, {
            id: 'nav:switch-session',
            label: 'Switch to Session',
            category: 'navigation',
            action: () => {}
          })
        },
        isVisible: () => activeWorktreeId !== null
      },

      // =====================
      // ACTION COMMANDS
      // =====================
      {
        id: 'action:new-session',
        label: 'New Session',
        description: 'Create a new chat session',
        category: 'action',
        icon: 'Plus',
        shortcut: getDisplayString('session:new'),
        keywords: ['new', 'create', 'session', 'chat'],
        action: async () => {
          if (!activeWorktreeId || !selectedProjectId) {
            toast.error('Please select a worktree first')
            return
          }
          const result = await createSession(activeWorktreeId, selectedProjectId)
          if (result.success) {
            toast.success('New session created')
          } else {
            toast.error(result.error || 'Failed to create session')
          }
          closeCommandPalette()
        },
        isEnabled: () => activeWorktreeId !== null && selectedProjectId !== null
      },
      {
        id: 'action:close-session',
        label: 'Close Session',
        description: 'Close the current session tab',
        category: 'action',
        icon: 'X',
        shortcut: getDisplayString('session:close'),
        keywords: ['close', 'session', 'tab'],
        action: async () => {
          if (!activeSessionId) return
          const result = await closeSession(activeSessionId)
          if (result.success) {
            toast.success('Session closed')
          } else {
            toast.error(result.error || 'Failed to close session')
          }
          closeCommandPalette()
        },
        isEnabled: () => activeSessionId !== null
      },
      {
        id: 'action:new-worktree',
        label: 'New Worktree',
        description: 'Create a new worktree for the current project',
        category: 'action',
        icon: 'GitBranch',
        shortcut: getDisplayString('nav:new-worktree'),
        keywords: ['new', 'create', 'worktree', 'branch'],
        action: () => {
          // This will trigger the worktree creation dialog
          // For now, we just show a message
          toast.info('Use the + button in the sidebar to create a new worktree')
          closeCommandPalette()
        },
        isEnabled: () => selectedProjectId !== null
      },
      {
        id: 'action:add-project',
        label: 'Add Project',
        description: 'Add a new project to Hive',
        category: 'action',
        icon: 'FolderPlus',
        keywords: ['add', 'new', 'project', 'import'],
        action: async () => {
          closeCommandPalette()
          // Trigger the add project dialog
          const result = await window.projectOps.openDialog()
          if (result.success && result.path) {
            const addResult = await useProjectStore.getState().addProject(result.path)
            if (addResult.success) {
              toast.success('Project added successfully')
            } else {
              toast.error(addResult.error || 'Failed to add project')
            }
          }
        }
      },
      {
        id: 'action:open-in-editor',
        label: 'Open in Editor',
        description: 'Open the current worktree in your code editor',
        category: 'action',
        icon: 'Code',
        keywords: ['editor', 'vscode', 'cursor', 'code'],
        action: async () => {
          const worktreePath = getActiveWorktreePath()
          if (!worktreePath) {
            toast.error('Please select a worktree first')
            return
          }
          try {
            await window.worktreeOps.openInEditor(worktreePath)
            toast.success('Opened in editor')
          } catch {
            toast.error('Failed to open in editor')
          }
          closeCommandPalette()
        },
        isEnabled: () => activeWorktreeId !== null
      },
      {
        id: 'action:open-in-terminal',
        label: 'Open in Terminal',
        description: 'Open the current worktree in terminal',
        category: 'action',
        icon: 'Terminal',
        keywords: ['terminal', 'shell', 'console', 'cmd'],
        action: async () => {
          const worktreePath = getActiveWorktreePath()
          if (!worktreePath) {
            toast.error('Please select a worktree first')
            return
          }
          try {
            const { defaultTerminal, customTerminalCommand } = useSettingsStore.getState()
            await window.settingsOps.openWithTerminal(
              worktreePath,
              defaultTerminal,
              defaultTerminal === 'custom' ? customTerminalCommand : undefined
            )
            toast.success('Opened in terminal')
          } catch {
            toast.error('Failed to open in terminal')
          }
          closeCommandPalette()
        },
        isEnabled: () => activeWorktreeId !== null
      },
      {
        id: 'action:reveal-in-finder',
        label: 'Reveal in Finder',
        description: 'Show the current worktree in Finder/Explorer',
        category: 'action',
        icon: 'FolderOpen',
        keywords: ['finder', 'explorer', 'reveal', 'show'],
        action: async () => {
          const worktreePath = getActiveWorktreePath()
          if (!worktreePath) {
            toast.error('Please select a worktree first')
            return
          }
          try {
            await window.projectOps.showInFolder(worktreePath)
          } catch {
            toast.error('Failed to reveal in Finder')
          }
          closeCommandPalette()
        },
        isEnabled: () => activeWorktreeId !== null
      },

      // =====================
      // GIT COMMANDS
      // =====================
      {
        id: 'git:stage-all',
        label: 'Stage All Changes',
        description: 'Stage all modified and untracked files',
        category: 'git',
        icon: 'Plus',
        keywords: ['stage', 'add', 'all', 'git'],
        action: async () => {
          const worktreePath = getActiveWorktreePath()
          if (!worktreePath) {
            toast.error('Please select a worktree first')
            return
          }
          const success = await stageAll(worktreePath)
          if (success) {
            toast.success('All changes staged')
          } else {
            toast.error('Failed to stage changes')
          }
          closeCommandPalette()
        },
        isEnabled: () => activeWorktreeId !== null
      },
      {
        id: 'git:unstage-all',
        label: 'Unstage All Changes',
        description: 'Unstage all staged files',
        category: 'git',
        icon: 'Minus',
        keywords: ['unstage', 'reset', 'all', 'git'],
        action: async () => {
          const worktreePath = getActiveWorktreePath()
          if (!worktreePath) {
            toast.error('Please select a worktree first')
            return
          }
          const success = await unstageAll(worktreePath)
          if (success) {
            toast.success('All changes unstaged')
          } else {
            toast.error('Failed to unstage changes')
          }
          closeCommandPalette()
        },
        isEnabled: () => activeWorktreeId !== null
      },
      {
        id: 'git:commit',
        label: 'Commit Changes',
        description: 'Focus the commit form',
        category: 'git',
        icon: 'Check',
        shortcut: getDisplayString('git:commit'),
        keywords: ['commit', 'save', 'git'],
        action: () => {
          // Focus commit form - emit event or trigger UI state
          toast.info('Use the commit form in the git panel')
          closeCommandPalette()
        },
        isEnabled: () => activeWorktreeId !== null
      },
      {
        id: 'git:push',
        label: 'Push to Remote',
        description: 'Push commits to the remote repository',
        category: 'git',
        icon: 'Upload',
        shortcut: getDisplayString('git:push'),
        keywords: ['push', 'upload', 'remote', 'git'],
        action: async () => {
          const worktreePath = getActiveWorktreePath()
          if (!worktreePath) {
            toast.error('Please select a worktree first')
            return
          }
          const result = await push(worktreePath)
          if (result.success) {
            toast.success('Pushed successfully')
          } else {
            toast.error(result.error || 'Failed to push')
          }
          closeCommandPalette()
        },
        isEnabled: () => activeWorktreeId !== null && !isPushing
      },
      {
        id: 'git:pull',
        label: 'Pull from Remote',
        description: 'Pull commits from the remote repository',
        category: 'git',
        icon: 'Download',
        shortcut: getDisplayString('git:pull'),
        keywords: ['pull', 'download', 'fetch', 'remote', 'git'],
        action: async () => {
          const worktreePath = getActiveWorktreePath()
          if (!worktreePath) {
            toast.error('Please select a worktree first')
            return
          }
          const result = await pull(worktreePath)
          if (result.success) {
            toast.success('Pulled successfully')
          } else {
            toast.error(result.error || 'Failed to pull')
          }
          closeCommandPalette()
        },
        isEnabled: () => activeWorktreeId !== null && !isPulling
      },
      {
        id: 'git:refresh',
        label: 'Refresh Git Status',
        description: 'Refresh the git status for the current worktree',
        category: 'git',
        icon: 'RefreshCw',
        keywords: ['refresh', 'reload', 'status', 'git'],
        action: async () => {
          const worktreePath = getActiveWorktreePath()
          if (!worktreePath) {
            toast.error('Please select a worktree first')
            return
          }
          await refreshStatuses(worktreePath)
          toast.success('Git status refreshed')
          closeCommandPalette()
        },
        isEnabled: () => activeWorktreeId !== null
      },

      // =====================
      // SIDEBAR COMMANDS
      // =====================
      {
        id: 'sidebar:toggle-left',
        label: 'Toggle Left Sidebar',
        description: 'Show or hide the left sidebar',
        category: 'action',
        icon: 'PanelLeft',
        shortcut: getDisplayString('sidebar:toggle-left'),
        keywords: ['sidebar', 'left', 'toggle', 'hide', 'show'],
        action: () => {
          toggleLeftSidebar()
          closeCommandPalette()
        }
      },
      {
        id: 'sidebar:toggle-right',
        label: 'Toggle Right Sidebar',
        description: 'Show or hide the right sidebar',
        category: 'action',
        icon: 'PanelRight',
        shortcut: getDisplayString('sidebar:toggle-right'),
        keywords: ['sidebar', 'right', 'toggle', 'hide', 'show', 'git', 'files'],
        action: () => {
          toggleRightSidebar()
          closeCommandPalette()
        }
      },

      // =====================
      // SETTINGS COMMANDS
      // =====================
      {
        id: 'settings:open',
        label: 'Open Settings',
        description: 'Open the settings panel',
        category: 'settings',
        icon: 'Settings',
        shortcut: getDisplayString('settings:open'),
        keywords: ['settings', 'preferences', 'config'],
        action: () => {
          closeCommandPalette()
          window.dispatchEvent(new CustomEvent('hive:open-settings'))
        }
      },
      {
        id: 'settings:theme',
        label: 'Switch Theme',
        description: `Current: ${themeId}. Choose a theme preset`,
        category: 'settings',
        icon: 'Palette',
        keywords: ['theme', 'dark', 'light', 'mode', 'appearance', 'color'],
        hasChildren: true,
        action: () => {
          const children = THEME_PRESETS.map((preset) => ({
            id: `settings:theme:${preset.id}`,
            label: preset.name,
            description: `${preset.type} theme`,
            category: 'settings' as const,
            icon: preset.type === 'dark' ? 'Moon' : 'Sun',
            onHighlight: () => previewTheme(preset.id),
            action: () => {
              setTheme(preset.id)
              toast.success(`Theme set to ${preset.name}`)
              closeCommandPalette()
            }
          }))
          pushCommandLevel(
            children,
            {
              id: 'settings:theme',
              label: 'Switch Theme',
              category: 'settings',
              action: () => {}
            },
            () => cancelPreview()
          )
        }
      },

      // =====================
      // SERVER COMMANDS
      // =====================
      {
        id: 'action:install-server',
        label: "Install 'hive-server' Command in PATH",
        description: 'Install the hive-server CLI to /usr/local/bin',
        category: 'action',
        icon: 'Terminal',
        keywords: ['install', 'server', 'path', 'headless', 'cli', 'terminal'],
        isVisible: () => isPackaged,
        action: async () => {
          try {
            const result = await window.systemOps.installServerToPath()
            if (result.success) {
              toast.success(`Installed hive-server to ${result.path}`)
            } else {
              toast.error(result.error || 'Failed to install')
            }
          } catch {
            toast.error('Installation cancelled or failed')
          }
          closeCommandPalette()
        }
      },
      {
        id: 'action:uninstall-server',
        label: "Uninstall 'hive-server' Command from PATH",
        description: 'Remove the hive-server CLI from /usr/local/bin',
        category: 'action',
        icon: 'Trash2',
        keywords: ['uninstall', 'remove', 'server', 'path', 'cli'],
        isVisible: () => isPackaged,
        action: async () => {
          try {
            const result = await window.systemOps.uninstallServerFromPath()
            if (result.success) {
              toast.success('Removed hive-server from PATH')
            } else {
              toast.error(result.error || 'Failed to uninstall')
            }
          } catch {
            toast.error('Uninstall cancelled or failed')
          }
          closeCommandPalette()
        }
      }
    ]

    // Register all commands
    commandRegistry.registerMany(commands)

    return () => {
      // Unregister all commands on unmount
      commands.forEach((cmd) => commandRegistry.unregister(cmd.id))
    }
  }, [
    projects,
    selectedProjectId,
    selectProject,
    toggleProjectExpanded,
    selectWorktree,
    getWorktreesForProject,
    activeWorktreeId,
    activeSessionId,
    createSession,
    closeSession,
    setActiveSession,
    getSessionsForWorktree,
    themeId,
    setTheme,
    previewTheme,
    cancelPreview,
    toggleSessionHistory,
    stageAll,
    unstageAll,
    refreshStatuses,
    push,
    pull,
    isPushing,
    isPulling,
    toggleLeftSidebar,
    toggleRightSidebar,
    getDisplayString,
    getActiveWorktreePath,
    closeCommandPalette,
    pushCommandLevel,
    isPackaged
  ])

  // Get filtered commands based on search query
  const filteredCommands = useMemo(() => {
    const allCommands = commandRegistry.getVisible()
    if (!searchQuery.trim()) return allCommands
    return fuzzySearch(searchQuery, allCommands)
  }, [searchQuery])

  // Get recent commands
  const recentCommands = useMemo(() => {
    return recentCommandIds
      .map((id) => commandRegistry.get(id))
      .filter((cmd): cmd is Command => cmd !== undefined && (!cmd.isVisible || cmd.isVisible()))
  }, [recentCommandIds])

  // Execute a command and track it
  const executeCommand = useCallback(
    async (command: Command) => {
      addRecentCommand(command.id)
      await command.action()
    },
    [addRecentCommand]
  )

  return {
    filteredCommands,
    recentCommands,
    executeCommand,
    searchQuery
  }
}
