import { create } from 'zustand'
import { toast } from '@/lib/toast'
import { TerminalStatus } from './useTerminalStore'

export interface TerminalTab {
  id: string // Format: `${worktreeId}::tab-${counter}`
  worktreeId: string
  name: string // "Terminal 1", "Terminal 2", etc.
  status: TerminalStatus // 'creating' | 'running' | 'exited'
  exitCode?: number
  createdAt: number
}

const TAB_SOFT_LIMIT = 10

interface TerminalTabState {
  tabsByWorktree: Map<string, TerminalTab[]>
  activeTabByWorktree: Map<string, string> // worktreeId -> tabId
  tabCounterByWorktree: Map<string, number>

  // Actions
  createTab(worktreeId: string): string
  closeTab(worktreeId: string, tabId: string): void
  closeOtherTabs(worktreeId: string, keepTabId: string): void
  setActiveTab(worktreeId: string, tabId: string): void
  renameTab(worktreeId: string, tabId: string, name: string): void
  setTabStatus(tabId: string, status: TerminalStatus, exitCode?: number): void
  cycleTab(worktreeId: string, direction: 'next' | 'prev'): void

  // Queries
  getActiveTab(worktreeId: string): TerminalTab | undefined
  getTabs(worktreeId: string): TerminalTab[]
  getTabCount(worktreeId: string): number

  // Cleanup
  removeWorktree(worktreeId: string): void
  removeAllTabs(): void
}

export const useTerminalTabStore = create<TerminalTabState>((set, get) => ({
  tabsByWorktree: new Map(),
  activeTabByWorktree: new Map(),
  tabCounterByWorktree: new Map(),

  createTab: (worktreeId: string): string => {
    const state = get()
    const currentCount = state.tabCounterByWorktree.get(worktreeId) ?? 0
    const counter = currentCount + 1
    const tabId = `${worktreeId}::tab-${counter}`

    const existingTabs = state.tabsByWorktree.get(worktreeId) ?? []
    if (existingTabs.length >= TAB_SOFT_LIMIT) {
      toast.warning(
        'You have many terminal tabs open. Consider closing unused ones.'
      )
    }

    const newTab: TerminalTab = {
      id: tabId,
      worktreeId,
      name: `Terminal ${counter}`,
      status: 'creating',
      createdAt: Date.now()
    }

    set((state) => {
      const tabsByWorktree = new Map(state.tabsByWorktree)
      const activeTabByWorktree = new Map(state.activeTabByWorktree)
      const tabCounterByWorktree = new Map(state.tabCounterByWorktree)

      const tabs = [...(tabsByWorktree.get(worktreeId) ?? []), newTab]
      tabsByWorktree.set(worktreeId, tabs)
      activeTabByWorktree.set(worktreeId, tabId)
      tabCounterByWorktree.set(worktreeId, counter)

      return { tabsByWorktree, activeTabByWorktree, tabCounterByWorktree }
    })

    return tabId
  },

  closeTab: (worktreeId: string, tabId: string): void => {
    const state = get()
    const tabs = state.tabsByWorktree.get(worktreeId) ?? []
    const tabIndex = tabs.findIndex((t) => t.id === tabId)
    if (tabIndex === -1) return

    const remaining = tabs.filter((t) => t.id !== tabId)

    if (remaining.length === 0) {
      // Last tab closed: auto-create a fresh tab named "Terminal 1"
      // Use next counter value for ID to avoid collision with in-flight PTY destroy
      const currentCounter = state.tabCounterByWorktree.get(worktreeId) ?? 0
      const nextCounter = currentCounter + 1
      const freshTabId = `${worktreeId}::tab-${nextCounter}`
      const freshTab: TerminalTab = {
        id: freshTabId,
        worktreeId,
        name: 'Terminal 1',
        status: 'creating',
        createdAt: Date.now()
      }

      set((state) => {
        const tabsByWorktree = new Map(state.tabsByWorktree)
        const activeTabByWorktree = new Map(state.activeTabByWorktree)
        const tabCounterByWorktree = new Map(state.tabCounterByWorktree)

        tabsByWorktree.set(worktreeId, [freshTab])
        activeTabByWorktree.set(worktreeId, freshTabId)
        tabCounterByWorktree.set(worktreeId, nextCounter)

        return { tabsByWorktree, activeTabByWorktree, tabCounterByWorktree }
      })
      return
    }

    // Determine new active tab if the closed one was active
    const wasActive = state.activeTabByWorktree.get(worktreeId) === tabId

    set((state) => {
      const tabsByWorktree = new Map(state.tabsByWorktree)
      const activeTabByWorktree = new Map(state.activeTabByWorktree)

      tabsByWorktree.set(worktreeId, remaining)

      if (wasActive) {
        // Activate next tab in list, or previous if closed tab was last
        const newIndex = tabIndex < remaining.length ? tabIndex : remaining.length - 1
        activeTabByWorktree.set(worktreeId, remaining[newIndex].id)
      }

      return { tabsByWorktree, activeTabByWorktree }
    })
  },

  closeOtherTabs: (worktreeId: string, keepTabId: string): void => {
    const state = get()
    const tabs = state.tabsByWorktree.get(worktreeId) ?? []
    const keepTab = tabs.find((t) => t.id === keepTabId)
    if (!keepTab) return

    set((state) => {
      const tabsByWorktree = new Map(state.tabsByWorktree)
      const activeTabByWorktree = new Map(state.activeTabByWorktree)

      tabsByWorktree.set(worktreeId, [keepTab])
      activeTabByWorktree.set(worktreeId, keepTabId)

      return { tabsByWorktree, activeTabByWorktree }
    })
  },

  setActiveTab: (worktreeId: string, tabId: string): void => {
    set((state) => {
      const activeTabByWorktree = new Map(state.activeTabByWorktree)
      activeTabByWorktree.set(worktreeId, tabId)
      return { activeTabByWorktree }
    })
  },

  renameTab: (worktreeId: string, tabId: string, name: string): void => {
    set((state) => {
      const tabsByWorktree = new Map(state.tabsByWorktree)
      const tabs = tabsByWorktree.get(worktreeId)
      if (!tabs) return state

      const updatedTabs = tabs.map((t) =>
        t.id === tabId ? { ...t, name } : t
      )
      tabsByWorktree.set(worktreeId, updatedTabs)

      return { tabsByWorktree }
    })
  },

  setTabStatus: (tabId: string, status: TerminalStatus, exitCode?: number): void => {
    set((state) => {
      const tabsByWorktree = new Map(state.tabsByWorktree)

      for (const [worktreeId, tabs] of tabsByWorktree) {
        const tabIndex = tabs.findIndex((t) => t.id === tabId)
        if (tabIndex !== -1) {
          const updatedTabs = tabs.map((t) =>
            t.id === tabId ? { ...t, status, exitCode } : t
          )
          tabsByWorktree.set(worktreeId, updatedTabs)
          return { tabsByWorktree }
        }
      }

      return state
    })
  },

  cycleTab: (worktreeId: string, direction: 'next' | 'prev'): void => {
    const state = get()
    const tabs = state.tabsByWorktree.get(worktreeId) ?? []
    if (tabs.length <= 1) return

    const activeTabId = state.activeTabByWorktree.get(worktreeId)
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId)
    if (currentIndex === -1) return

    const offset = direction === 'next' ? 1 : -1
    const newIndex = (currentIndex + offset + tabs.length) % tabs.length

    set((state) => {
      const activeTabByWorktree = new Map(state.activeTabByWorktree)
      activeTabByWorktree.set(worktreeId, tabs[newIndex].id)
      return { activeTabByWorktree }
    })
  },

  getActiveTab: (worktreeId: string): TerminalTab | undefined => {
    const state = get()
    const activeTabId = state.activeTabByWorktree.get(worktreeId)
    if (!activeTabId) return undefined

    const tabs = state.tabsByWorktree.get(worktreeId) ?? []
    return tabs.find((t) => t.id === activeTabId)
  },

  getTabs: (worktreeId: string): TerminalTab[] => {
    return get().tabsByWorktree.get(worktreeId) ?? []
  },

  getTabCount: (worktreeId: string): number => {
    return (get().tabsByWorktree.get(worktreeId) ?? []).length
  },

  removeWorktree: (worktreeId: string): void => {
    set((state) => {
      const tabsByWorktree = new Map(state.tabsByWorktree)
      const activeTabByWorktree = new Map(state.activeTabByWorktree)
      const tabCounterByWorktree = new Map(state.tabCounterByWorktree)

      tabsByWorktree.delete(worktreeId)
      activeTabByWorktree.delete(worktreeId)
      tabCounterByWorktree.delete(worktreeId)

      return { tabsByWorktree, activeTabByWorktree, tabCounterByWorktree }
    })
  },

  removeAllTabs: (): void => {
    set({
      tabsByWorktree: new Map(),
      activeTabByWorktree: new Map(),
      tabCounterByWorktree: new Map()
    })
  }
}))
