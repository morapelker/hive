import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

interface SpaceState {
  spaces: Space[]
  activeSpaceId: string | null // null = "All"
  projectSpaceMap: Record<string, string[]> // projectId -> spaceId[]

  // Actions
  loadSpaces: () => Promise<void>
  createSpace: (name: string, iconType: string, iconValue: string) => Promise<Space | null>
  updateSpace: (
    id: string,
    data: { name?: string; icon_type?: string; icon_value?: string }
  ) => Promise<void>
  deleteSpace: (id: string) => Promise<void>
  setActiveSpace: (id: string | null) => void
  assignProjectToSpace: (projectId: string, spaceId: string) => Promise<void>
  removeProjectFromSpace: (projectId: string, spaceId: string) => Promise<void>
  getProjectIdsForActiveSpace: () => string[] | null // null = show all
  reorderSpaces: (fromIndex: number, toIndex: number) => void
}

export const useSpaceStore = create<SpaceState>()(
  persist(
    (set, get) => ({
      spaces: [],
      activeSpaceId: null,
      projectSpaceMap: {},

      loadSpaces: async () => {
        try {
          const [spaces, assignments] = await Promise.all([
            window.db.space.list(),
            window.db.space.getAllAssignments()
          ])

          // Build projectSpaceMap from assignments
          const projectSpaceMap: Record<string, string[]> = {}
          for (const a of assignments) {
            if (!projectSpaceMap[a.project_id]) {
              projectSpaceMap[a.project_id] = []
            }
            projectSpaceMap[a.project_id].push(a.space_id)
          }

          set({ spaces, projectSpaceMap })
        } catch {
          // Silently fail — spaces are non-critical
        }
      },

      createSpace: async (name: string, iconType: string, iconValue: string) => {
        try {
          const space = await window.db.space.create({
            name,
            icon_type: iconType,
            icon_value: iconValue
          })
          set((state) => ({ spaces: [...state.spaces, space] }))
          return space
        } catch {
          return null
        }
      },

      updateSpace: async (id: string, data) => {
        try {
          const updated = await window.db.space.update(id, data)
          if (updated) {
            set((state) => ({
              spaces: state.spaces.map((s) => (s.id === id ? updated : s))
            }))
          }
        } catch {
          // Silently fail
        }
      },

      deleteSpace: async (id: string) => {
        try {
          await window.db.space.delete(id)
          set((state) => {
            // Remove space from list
            const spaces = state.spaces.filter((s) => s.id !== id)

            // Clean up projectSpaceMap entries
            const projectSpaceMap: Record<string, string[]> = {}
            for (const [projectId, spaceIds] of Object.entries(state.projectSpaceMap)) {
              const filtered = spaceIds.filter((sid) => sid !== id)
              if (filtered.length > 0) {
                projectSpaceMap[projectId] = filtered
              }
            }

            // Reset activeSpaceId if the deleted space was active
            const activeSpaceId = state.activeSpaceId === id ? null : state.activeSpaceId

            return { spaces, projectSpaceMap, activeSpaceId }
          })
        } catch {
          // Silently fail
        }
      },

      setActiveSpace: (id: string | null) => {
        set({ activeSpaceId: id })
      },

      assignProjectToSpace: async (projectId: string, spaceId: string) => {
        try {
          await window.db.space.assignProject(projectId, spaceId)
          set((state) => {
            const existing = state.projectSpaceMap[projectId] ?? []
            if (existing.includes(spaceId)) return state
            return {
              projectSpaceMap: {
                ...state.projectSpaceMap,
                [projectId]: [...existing, spaceId]
              }
            }
          })
        } catch {
          // Silently fail
        }
      },

      removeProjectFromSpace: async (projectId: string, spaceId: string) => {
        try {
          await window.db.space.removeProject(projectId, spaceId)
          set((state) => {
            const existing = state.projectSpaceMap[projectId] ?? []
            const filtered = existing.filter((sid) => sid !== spaceId)
            const projectSpaceMap = { ...state.projectSpaceMap }
            if (filtered.length > 0) {
              projectSpaceMap[projectId] = filtered
            } else {
              delete projectSpaceMap[projectId]
            }
            return { projectSpaceMap }
          })
        } catch {
          // Silently fail
        }
      },

      getProjectIdsForActiveSpace: () => {
        const { activeSpaceId, projectSpaceMap } = get()
        if (activeSpaceId === null) return null // Show all

        const projectIds: string[] = []
        for (const [projectId, spaceIds] of Object.entries(projectSpaceMap)) {
          if (spaceIds.includes(activeSpaceId)) {
            projectIds.push(projectId)
          }
        }
        return projectIds
      },

      reorderSpaces: (fromIndex: number, toIndex: number) => {
        const { spaces } = get()
        const reordered = [...spaces]
        const [moved] = reordered.splice(fromIndex, 1)
        reordered.splice(toIndex, 0, moved)

        // Update sort_order locally
        const updated = reordered.map((s, i) => ({ ...s, sort_order: i }))
        set({ spaces: updated })

        // Persist to database
        const orderedIds = updated.map((s) => s.id)
        window.db.space.reorder(orderedIds).catch(() => {
          // Silently fail — revert on next load
        })
      }
    }),
    {
      name: 'hive-spaces',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        activeSpaceId: state.activeSpaceId
      })
    }
  )
)
