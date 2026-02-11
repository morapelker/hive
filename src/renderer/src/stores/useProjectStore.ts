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
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
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

  // Ordering
  projectOrder: string[] // persisted custom order of project IDs

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
      setup_script?: string | null
      run_script?: string | null
      archive_script?: string | null
    }
  ) => Promise<boolean>
  selectProject: (id: string | null) => void
  toggleProjectExpanded: (id: string) => void
  setEditingProject: (id: string | null) => void
  touchProject: (id: string) => Promise<void>
  refreshLanguage: (projectId: string) => Promise<void>
  reorderProjects: (fromIndex: number, toIndex: number) => void
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
      projectOrder: [],

      // Load all projects from database
      loadProjects: async () => {
        set({ isLoading: true, error: null })
        try {
          const projects = await window.db.project.getAll()
          const customOrder = get().projectOrder

          if (customOrder.length > 0) {
            // Apply custom order: ordered projects first, then any new ones at the end
            const ordered: typeof projects = []
            for (const id of customOrder) {
              const p = projects.find((proj) => proj.id === id)
              if (p) ordered.push(p)
            }
            // Append projects not in custom order (newly added)
            for (const p of projects) {
              if (!customOrder.includes(p.id)) ordered.push(p)
            }
            set({ projects: ordered, isLoading: false })
          } else {
            // Default: sort by last_accessed_at descending
            const sortedProjects = projects.sort(
              (a, b) =>
                new Date(b.last_accessed_at).getTime() - new Date(a.last_accessed_at).getTime()
            )
            set({ projects: sortedProjects, isLoading: false })
          }
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
                editingProjectId: state.editingProjectId === id ? null : state.editingProjectId,
                projectOrder: state.projectOrder.filter((pid) => pid !== id)
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
          setup_script?: string | null
          run_script?: string | null
          archive_script?: string | null
        }
      ) => {
        try {
          const updatedProject = await window.db.project.update(id, data)
          if (updatedProject) {
            set((state) => ({
              projects: state.projects.map((p) => (p.id === id ? { ...p, ...data } : p))
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
          const currentProjects = state.projects

          // Build order array from current state or existing custom order
          let order: string[]
          if (state.projectOrder.length > 0) {
            order = [...state.projectOrder]
            // Add any new projects not in order
            for (const p of currentProjects) {
              if (!order.includes(p.id)) order.push(p.id)
            }
            // Remove stale IDs
            order = order.filter((id) => currentProjects.some((p) => p.id === id))
          } else {
            order = currentProjects.map((p) => p.id)
          }

          if (
            fromIndex < 0 ||
            fromIndex >= order.length ||
            toIndex < 0 ||
            toIndex >= order.length
          ) {
            return state
          }

          // Splice move
          const [removed] = order.splice(fromIndex, 1)
          order.splice(toIndex, 0, removed)

          // Reorder the projects array to match
          const reordered: typeof currentProjects = []
          for (const id of order) {
            const p = currentProjects.find((proj) => proj.id === id)
            if (p) reordered.push(p)
          }

          return { projectOrder: order, projects: reordered }
        })
      }
    }),
    {
      name: 'hive-projects',
      storage: createJSONStorage(() => localStorage),
      // Only persist expandedProjectIds and projectOrder
      partialize: (state) => ({
        expandedProjectIds: Array.from(state.expandedProjectIds),
        projectOrder: state.projectOrder
      }),
      // Merge persisted state, converting array back to Set
      merge: (persistedState, currentState) => ({
        ...currentState,
        expandedProjectIds: new Set(
          (persistedState as { expandedProjectIds?: string[] })?.expandedProjectIds ?? []
        ),
        projectOrder: (persistedState as { projectOrder?: string[] })?.projectOrder ?? []
      })
    }
  )
)
