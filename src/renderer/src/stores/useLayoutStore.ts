import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

interface LayoutState {
  leftSidebarWidth: number
  rightSidebarWidth: number
  rightSidebarCollapsed: boolean
  setLeftSidebarWidth: (width: number) => void
  setRightSidebarWidth: (width: number) => void
  toggleRightSidebar: () => void
  setRightSidebarCollapsed: (collapsed: boolean) => void
}

const LEFT_SIDEBAR_DEFAULT = 240
const LEFT_SIDEBAR_MIN = 200
const LEFT_SIDEBAR_MAX = 400
const RIGHT_SIDEBAR_DEFAULT = 280

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      leftSidebarWidth: LEFT_SIDEBAR_DEFAULT,
      rightSidebarWidth: RIGHT_SIDEBAR_DEFAULT,
      rightSidebarCollapsed: false,

      setLeftSidebarWidth: (width: number) => {
        const clampedWidth = Math.min(Math.max(width, LEFT_SIDEBAR_MIN), LEFT_SIDEBAR_MAX)
        set({ leftSidebarWidth: clampedWidth })
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
    }),
    {
      name: 'hive-layout',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        leftSidebarWidth: state.leftSidebarWidth,
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
