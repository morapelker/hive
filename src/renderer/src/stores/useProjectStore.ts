import { create } from 'zustand'

// Project type matching the database schema
interface Project {
  id: string
  name: string
  path: string
  description: string | null
  tags: string | null
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

  // Actions
  loadProjects: () => Promise<void>
  addProject: (path: string) => Promise<{ success: boolean; error?: string }>
  removeProject: (id: string) => Promise<boolean>
  updateProjectName: (id: string, name: string) => Promise<boolean>
  selectProject: (id: string | null) => void
  toggleProjectExpanded: (id: string) => void
  setEditingProject: (id: string | null) => void
  touchProject: (id: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  // Initial state
  projects: [],
  isLoading: false,
  error: null,
  selectedProjectId: null,
  expandedProjectIds: new Set(),
  editingProjectId: null,

  // Load all projects from database
  loadProjects: async () => {
    set({ isLoading: true, error: null })
    try {
      const projects = await window.db.project.getAll()
      // Sort by last_accessed_at descending (most recent first)
      const sortedProjects = projects.sort(
        (a, b) => new Date(b.last_accessed_at).getTime() - new Date(a.last_accessed_at).getTime()
      )
      set({ projects: sortedProjects, isLoading: false })
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
  }
}))
