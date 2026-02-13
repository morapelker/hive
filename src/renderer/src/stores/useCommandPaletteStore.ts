import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// Command categories for organization
export type CommandCategory = 'navigation' | 'action' | 'git' | 'settings' | 'file' | 'recent'

// Individual command definition
export interface Command {
  id: string
  label: string
  description?: string
  category: CommandCategory
  icon?: string // Lucide icon name
  shortcut?: string // Display shortcut like "⌘N"
  action: () => void | Promise<void>
  keywords?: string[] // Additional search keywords
  // For nested commands (e.g., "Switch to worktree" → list of worktrees)
  hasChildren?: boolean
  getChildren?: () => Command[]
  // Callback when this command is highlighted (hovered/arrowed to)
  onHighlight?: () => void
  // Visibility conditions
  isEnabled?: () => boolean
  isVisible?: () => boolean
}

// Command palette state
interface CommandPaletteState {
  // UI State
  isOpen: boolean
  searchQuery: string
  selectedIndex: number

  // Navigation stack for nested commands
  commandStack: Command[][]
  currentParent: Command | null

  // Dismiss callback for nested command levels
  onDismissLevel: (() => void) | null

  // Recent commands (persisted)
  recentCommandIds: string[]
  maxRecentCommands: number

  // Actions
  open: () => void
  close: () => void
  toggle: () => void
  setSearchQuery: (query: string) => void
  setSelectedIndex: (index: number) => void
  moveSelection: (delta: number, maxItems: number) => void
  addRecentCommand: (commandId: string) => void
  clearRecentCommands: () => void

  // Nested command navigation
  pushCommandLevel: (commands: Command[], parent: Command, onDismiss?: () => void) => void
  popCommandLevel: () => void
  resetCommandStack: () => void
}

export const useCommandPaletteStore = create<CommandPaletteState>()(
  persist(
    (set, get) => ({
      // Initial state
      isOpen: false,
      searchQuery: '',
      selectedIndex: 0,
      commandStack: [],
      currentParent: null,
      onDismissLevel: null,
      recentCommandIds: [],
      maxRecentCommands: 5,

      // Open the command palette
      open: () => {
        set({
          isOpen: true,
          searchQuery: '',
          selectedIndex: 0,
          commandStack: [],
          currentParent: null
        })
      },

      // Close the command palette
      close: () => {
        get().onDismissLevel?.()
        set({
          isOpen: false,
          searchQuery: '',
          selectedIndex: 0,
          commandStack: [],
          currentParent: null,
          onDismissLevel: null
        })
      },

      // Toggle the command palette
      toggle: () => {
        const { isOpen } = get()
        if (isOpen) {
          get().close()
        } else {
          get().open()
        }
      },

      // Set search query and reset selection
      setSearchQuery: (query: string) => {
        set({ searchQuery: query, selectedIndex: 0 })
      },

      // Set selected index
      setSelectedIndex: (index: number) => {
        set({ selectedIndex: index })
      },

      // Move selection up or down
      moveSelection: (delta: number, maxItems: number) => {
        set((state) => {
          if (maxItems === 0) return state
          let newIndex = state.selectedIndex + delta
          // Wrap around
          if (newIndex < 0) newIndex = maxItems - 1
          if (newIndex >= maxItems) newIndex = 0
          return { selectedIndex: newIndex }
        })
      },

      // Add command to recent list
      addRecentCommand: (commandId: string) => {
        set((state) => {
          // Remove if already exists
          const filtered = state.recentCommandIds.filter((id) => id !== commandId)
          // Add to front
          const updated = [commandId, ...filtered].slice(0, state.maxRecentCommands)
          return { recentCommandIds: updated }
        })
      },

      // Clear recent commands
      clearRecentCommands: () => {
        set({ recentCommandIds: [] })
      },

      // Push a new level of commands (for nested navigation)
      pushCommandLevel: (commands: Command[], parent: Command, onDismiss?: () => void) => {
        set((state) => ({
          commandStack: [...state.commandStack, commands],
          currentParent: parent,
          searchQuery: '',
          selectedIndex: 0,
          onDismissLevel: onDismiss ?? state.onDismissLevel
        }))
      },

      // Pop back to previous level
      popCommandLevel: () => {
        get().onDismissLevel?.()
        set((state) => {
          if (state.commandStack.length === 0) return state
          const newStack = state.commandStack.slice(0, -1)
          return {
            commandStack: newStack,
            currentParent: null,
            searchQuery: '',
            selectedIndex: 0,
            onDismissLevel: null
          }
        })
      },

      // Reset command stack to root level
      resetCommandStack: () => {
        get().onDismissLevel?.()
        set({
          commandStack: [],
          currentParent: null,
          searchQuery: '',
          selectedIndex: 0,
          onDismissLevel: null
        })
      }
    }),
    {
      name: 'hive-command-palette',
      storage: createJSONStorage(() => localStorage),
      // Only persist recent commands
      partialize: (state) => ({
        recentCommandIds: state.recentCommandIds
      })
    }
  )
)

// Export types
export type { CommandPaletteState }
