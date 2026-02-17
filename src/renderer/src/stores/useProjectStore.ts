import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// Project type matching the database schema
interface Project {
  id: string
  name: string
  path: string
  description: string | null
  tags: string | null
  language: string | null
  custom_icon: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  auto_assign_port: boolean
  sort_order: number
  created_at: string
  last_accessed_at: string
}

interface ProjectState {
  // Data
  projects: Project[]
  isLoading: boolean
  error: string | null

  // UI State
  selectedProjectId: string | null
  expandedProjectIds: Set<string>
  editingProjectId: string | null
  settingsProjectId: string | null

  // Actions
  loadProjects: () => Promise<void>
  addProject: (path: string) => Promise<{ success: boolean; error?: string }>
  removeProject: (id: string) => Promise<boolean>
  updateProjectName: (id: string, name: string) => Promise<boolean>
  updateProject: (
    id: string,
    data: {
      name?: string
      description?: string | null
      tags?: string[] | null
      language?: string | null
      custom_icon?: string | null
      setup_script?: string | null
      run_script?: string | null
      archive_script?: string | null
      auto_assign_port?: boolean
    }
  ) => Promise<boolean>
  selectProject: (id: string | null) => void
  toggleProjectExpanded: (id: string) => void
  expandAllProjects: () => void
  setEditingProject: (id: string | null) => void
  touchProject: (id: string) => Promise<void>
  refreshLanguage: (projectId: string) => Promise<void>
  reorderProjects: (fromIndex: number, toIndex: number) => void
  sortProjectsByLastMessage: () => Promise<void>
  openProjectSettings: (projectId: string) => void
  closeProjectSettings: () => void
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      // Initial state
      projects: [],
      isLoading: false,
      error: null,
      selectedProjectId: null,
      expandedProjectIds: new Set(),
      editingProjectId: null,
      settingsProjectId: null,

      // Load all projects from database (already ordered by sort_order ASC)
      loadProjects: async () => {
        set({ isLoading: true, error: null })
        try {
          const projects = await window.db.project.getAll()
          set({ projects, isLoading: false })
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to load projects',
            isLoading: false
          })
        }
      },

      // Add a new project
      addProject: async (path: string) => {
        try {
          // Validate the project path
          const validation = await window.projectOps.validateProject(path)
          if (!validation.success) {
            return { success: false, error: validation.error }
          }

          // Check if project already exists
          const existingProject = await window.db.project.getByPath(path)
          if (existingProject) {
            return { success: false, error: 'This project has already been added to Hive.' }
          }

          // Create the project
          const project = await window.db.project.create({
            name: validation.name!,
            path: validation.path!
          })

          // Auto-detect language (fire and forget for speed)
          window.projectOps
            .detectLanguage(validation.path!)
            .then(async (language) => {
              if (language) {
                await window.db.project.update(project.id, { language })
                set((state) => ({
                  projects: state.projects.map((p) =>
                    p.id === project.id ? { ...p, language } : p
                  )
                }))
              }
            })
            .catch(() => {
              // Ignore detection errors
            })

          // Add to state
          set((state) => ({
            projects: [project, ...state.projects],
            selectedProjectId: project.id,
            expandedProjectIds: new Set([...state.expandedProjectIds, project.id])
          }))

          return { success: true }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to add project'
          }
        }
      },

      // Remove a project
      removeProject: async (id: string) => {
        try {
          const success = await window.db.project.delete(id)
          if (success) {
            set((state) => {
              const newExpandedIds = new Set(state.expandedProjectIds)
              newExpandedIds.delete(id)
              return {
                projects: state.projects.filter((p) => p.id !== id),
                selectedProjectId: state.selectedProjectId === id ? null : state.selectedProjectId,
                expandedProjectIds: newExpandedIds,
                editingProjectId: state.editingProjectId === id ? null : state.editingProjectId
              }
            })
          }
          return success
        } catch {
          return false
        }
      },

      // Update project name
      updateProjectName: async (id: string, name: string) => {
        try {
          const updatedProject = await window.db.project.update(id, { name })
          if (updatedProject) {
            set((state) => ({
              projects: state.projects.map((p) => (p.id === id ? { ...p, name } : p)),
              editingProjectId: null
            }))
            return true
          }
          return false
        } catch {
          return false
        }
      },

      // Update project fields (generic)
      updateProject: async (
        id: string,
        data: {
          name?: string
          description?: string | null
          tags?: string[] | null
          language?: string | null
          custom_icon?: string | null
          setup_script?: string | null
          run_script?: string | null
          archive_script?: string | null
          auto_assign_port?: boolean
        }
      ) => {
        try {
          const updatedProject = await window.db.project.update(id, data)
          if (updatedProject) {
            // Convert tags from string[] to JSON string for local state
            const { tags, ...rest } = data
            const localUpdate: Partial<Project> = { ...rest }
            if (tags !== undefined) {
              localUpdate.tags = tags ? JSON.stringify(tags) : null
            }
            set((state) => ({
              projects: state.projects.map((p) => (p.id === id ? { ...p, ...localUpdate } : p))
            }))
            return true
          }
          return false
        } catch {
          return false
        }
      },

      // Select a project
      selectProject: (id: string | null) => {
        set({ selectedProjectId: id })
        if (id) {
          // Touch project to update last_accessed_at
          get().touchProject(id)
        }
      },

      // Toggle project expand/collapse
      toggleProjectExpanded: (id: string) => {
        set((state) => {
          const newExpandedIds = new Set(state.expandedProjectIds)
          if (newExpandedIds.has(id)) {
            newExpandedIds.delete(id)
          } else {
            newExpandedIds.add(id)
          }
          return { expandedProjectIds: newExpandedIds }
        })
      },

      // Expand all projects (used by connection mode)
      expandAllProjects: () => {
        set({ expandedProjectIds: new Set(get().projects.map((p) => p.id)) })
      },

      // Set project being edited
      setEditingProject: (id: string | null) => {
        set({ editingProjectId: id })
      },

      // Touch project (update last_accessed_at)
      touchProject: async (id: string) => {
        try {
          await window.db.project.touch(id)
          // Update local state
          set((state) => ({
            projects: state.projects.map((p) =>
              p.id === id ? { ...p, last_accessed_at: new Date().toISOString() } : p
            )
          }))
        } catch {
          // Ignore touch errors
        }
      },

      // Re-detect and update project language
      refreshLanguage: async (projectId: string) => {
        const project = get().projects.find((p) => p.id === projectId)
        if (!project) return
        try {
          const language = await window.projectOps.detectLanguage(project.path)
          await window.db.project.update(projectId, { language })
          set((state) => ({
            projects: state.projects.map((p) => (p.id === projectId ? { ...p, language } : p))
          }))
        } catch {
          // Ignore refresh errors
        }
      },

      // Reorder projects via drag-and-drop
      reorderProjects: (fromIndex: number, toIndex: number) => {
        set((state) => {
          const projects = [...state.projects]

          if (
            fromIndex < 0 ||
            fromIndex >= projects.length ||
            toIndex < 0 ||
            toIndex >= projects.length
          ) {
            return state
          }

          // Splice move
          const [removed] = projects.splice(fromIndex, 1)
          projects.splice(toIndex, 0, removed)

          // Persist new order to database (fire and forget)
          const orderedIds = projects.map((p) => p.id)
          window.db.project.reorder(orderedIds).catch(() => {
            // Ignore reorder persistence errors
          })

          return { projects }
        })
      },

      // Sort projects by last AI message activity (newest first, NULLs last)
      sortProjectsByLastMessage: async () => {
        try {
          const orderedIds = await window.db.project.sortByLastMessage()
          await window.db.project.reorder(orderedIds)

          set((state) => {
            const projectMap = new Map(state.projects.map((p) => [p.id, p]))
            const reordered = orderedIds
              .map((id) => projectMap.get(id))
              .filter((p): p is Project => p !== undefined)

            // Include any projects not in orderedIds (defensive)
            const reorderedIds = new Set(orderedIds)
            const missing = state.projects.filter((p) => !reorderedIds.has(p.id))

            return { projects: [...reordered, ...missing] }
          })
        } catch {
          // Ignore sort errors
        }
      },

      // Open project settings dialog globally
      openProjectSettings: (projectId: string) => {
        set({ settingsProjectId: projectId })
      },

      // Close project settings dialog
      closeProjectSettings: () => {
        set({ settingsProjectId: null })
      }
    }),
    {
      name: 'hive-projects',
      storage: createJSONStorage(() => localStorage),
      // Only persist expandedProjectIds
      partialize: (state) => ({
        expandedProjectIds: Array.from(state.expandedProjectIds)
      }),
      // Merge persisted state, converting array back to Set
      merge: (persistedState, currentState) => ({
        ...currentState,
        expandedProjectIds: new Set(
          (persistedState as { expandedProjectIds?: string[] })?.expandedProjectIds ?? []
        )
      })
    }
  )
)
