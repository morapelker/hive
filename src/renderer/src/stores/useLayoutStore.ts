import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type BottomPanelTab = 'setup' | 'run' | 'terminal'

interface LayoutState {
  leftSidebarWidth: number
  leftSidebarCollapsed: boolean
  rightSidebarWidth: number
  rightSidebarCollapsed: boolean
  bottomPanelTab: BottomPanelTab
  setLeftSidebarWidth: (width: number) => void
  toggleLeftSidebar: () => void
  setLeftSidebarCollapsed: (collapsed: boolean) => void
  setRightSidebarWidth: (width: number) => void
  toggleRightSidebar: () => void
  setRightSidebarCollapsed: (collapsed: boolean) => void
  setBottomPanelTab: (tab: BottomPanelTab) => void
}

const LEFT_SIDEBAR_DEFAULT = 240
const LEFT_SIDEBAR_MIN = 200
const LEFT_SIDEBAR_MAX = 400
const RIGHT_SIDEBAR_DEFAULT = 280

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      leftSidebarWidth: LEFT_SIDEBAR_DEFAULT,
      leftSidebarCollapsed: false,
      rightSidebarWidth: RIGHT_SIDEBAR_DEFAULT,
      rightSidebarCollapsed: false,
      bottomPanelTab: 'setup' as BottomPanelTab,

      setLeftSidebarWidth: (width: number) => {
        const clampedWidth = Math.min(Math.max(width, LEFT_SIDEBAR_MIN), LEFT_SIDEBAR_MAX)
        set({ leftSidebarWidth: clampedWidth })
      },

      toggleLeftSidebar: () => {
        set((state) => ({ leftSidebarCollapsed: !state.leftSidebarCollapsed }))
      },

      setLeftSidebarCollapsed: (collapsed: boolean) => {
        set({ leftSidebarCollapsed: collapsed })
      },

      setRightSidebarWidth: (width: number) => {
        set({ rightSidebarWidth: Math.max(width, 200) })
      },

      toggleRightSidebar: () => {
        set((state) => ({ rightSidebarCollapsed: !state.rightSidebarCollapsed }))
      },

      setRightSidebarCollapsed: (collapsed: boolean) => {
        set({ rightSidebarCollapsed: collapsed })
      },

      setBottomPanelTab: (tab: BottomPanelTab) => {
        set({ bottomPanelTab: tab })
      },
    }),
    {
      name: 'hive-layout',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        leftSidebarWidth: state.leftSidebarWidth,
        leftSidebarCollapsed: state.leftSidebarCollapsed,
        rightSidebarWidth: state.rightSidebarWidth,
        rightSidebarCollapsed: state.rightSidebarCollapsed,
      }),
    }
  )
)

export const LAYOUT_CONSTRAINTS = {
  leftSidebar: {
    default: LEFT_SIDEBAR_DEFAULT,
    min: LEFT_SIDEBAR_MIN,
    max: LEFT_SIDEBAR_MAX,
  },
  rightSidebar: {
    default: RIGHT_SIDEBAR_DEFAULT,
    min: 200,
  },
}
