import { create } from 'zustand'
import { useProjectStore } from './useProjectStore'
import { useScriptStore } from './useScriptStore'
import { toast } from '@/lib/toast'

// Worktree type matching the database schema
interface Worktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  created_at: string
  last_accessed_at: string
}

interface WorktreeState {
  // Data - keyed by project ID
  worktreesByProject: Map<string, Worktree[]>
  isLoading: boolean
  error: string | null

  // UI State
  selectedWorktreeId: string | null
  creatingForProjectId: string | null

  // Actions
  loadWorktrees: (projectId: string) => Promise<void>
  createWorktree: (
    projectId: string,
    projectPath: string,
    projectName: string
  ) => Promise<{ success: boolean; error?: string }>
  archiveWorktree: (
    worktreeId: string,
    worktreePath: string,
    branchName: string,
    projectPath: string
  ) => Promise<{ success: boolean; error?: string }>
  unbranchWorktree: (
    worktreeId: string,
    worktreePath: string,
    branchName: string,
    projectPath: string
  ) => Promise<{ success: boolean; error?: string }>
  selectWorktree: (id: string | null) => void
  touchWorktree: (id: string) => Promise<void>
  syncWorktrees: (projectId: string, projectPath: string) => Promise<void>
  getWorktreesForProject: (projectId: string) => Worktree[]
  getDefaultWorktree: (projectId: string) => Worktree | null
  setCreatingForProject: (projectId: string | null) => void
  duplicateWorktree: (
    projectId: string,
    projectPath: string,
    projectName: string,
    sourceBranch: string,
    sourceWorktreePath: string
  ) => Promise<{ success: boolean; worktree?: Worktree; error?: string }>
}

export const useWorktreeStore = create<WorktreeState>((set, get) => ({
  // Initial state
  worktreesByProject: new Map(),
  isLoading: false,
  error: null,
  selectedWorktreeId: null,
  creatingForProjectId: null,

  // Load worktrees for a project from database
  loadWorktrees: async (projectId: string) => {
    set({ isLoading: true, error: null })
    try {
      const worktrees = await window.db.worktree.getActiveByProject(projectId)
      // Sort: default worktrees first, then by last_accessed_at descending
      const sortedWorktrees = worktrees.sort((a, b) => {
        if (a.is_default && !b.is_default) return -1
        if (!a.is_default && b.is_default) return 1
        return new Date(b.last_accessed_at).getTime() - new Date(a.last_accessed_at).getTime()
      })
      set((state) => {
        const newMap = new Map(state.worktreesByProject)
        newMap.set(projectId, sortedWorktrees)
        return { worktreesByProject: newMap, isLoading: false }
      })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load worktrees',
        isLoading: false
      })
    }
  },

  // Create a new worktree
  createWorktree: async (projectId: string, projectPath: string, projectName: string) => {
    set({ creatingForProjectId: projectId })
    try {
      const result = await window.worktreeOps.create({
        projectId,
        projectPath,
        projectName
      })

      if (!result.success || !result.worktree) {
        set({ creatingForProjectId: null })
        return { success: false, error: result.error || 'Failed to create worktree' }
      }

      // Add to state
      set((state) => {
        const newMap = new Map(state.worktreesByProject)
        const existingWorktrees = newMap.get(projectId) || []
        newMap.set(projectId, [result.worktree!, ...existingWorktrees])
        return {
          worktreesByProject: newMap,
          selectedWorktreeId: result.worktree!.id,
          creatingForProjectId: null
        }
      })

      // Fire-and-forget: run setup script if configured
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
      if (project?.setup_script) {
        const commands = project.setup_script
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))

        if (commands.length > 0) {
          const worktreeId = result.worktree!.id
          const cwd = result.worktree!.path
          useScriptStore.getState().setSetupRunning(worktreeId, true)
          window.scriptOps.runSetup(commands, cwd, worktreeId).catch(() => {
            useScriptStore.getState().setSetupRunning(worktreeId, false)
          })
        }
      }

      return { success: true }
    } catch (error) {
      set({ creatingForProjectId: null })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create worktree'
      }
    }
  },

  // Archive a worktree (remove worktree AND delete branch)
  archiveWorktree: async (
    worktreeId: string,
    worktreePath: string,
    branchName: string,
    projectPath: string
  ) => {
    // Guard: block archive of default worktrees
    const worktrees = Array.from(get().worktreesByProject.values()).flat()
    const worktree = worktrees.find((w) => w.id === worktreeId)
    if (worktree?.is_default) {
      toast.error('Cannot archive the default worktree')
      return { success: false, error: 'Cannot archive the default worktree' }
    }

    try {
      const result = await window.worktreeOps.delete({
        worktreeId,
        worktreePath,
        branchName,
        projectPath,
        archive: true
      })

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to archive worktree' }
      }

      // Remove from state
      set((state) => {
        const newMap = new Map(state.worktreesByProject)
        for (const [projectId, worktrees] of newMap.entries()) {
          const filtered = worktrees.filter((w) => w.id !== worktreeId)
          if (filtered.length !== worktrees.length) {
            newMap.set(projectId, filtered)
          }
        }
        return {
          worktreesByProject: newMap,
          selectedWorktreeId:
            state.selectedWorktreeId === worktreeId ? null : state.selectedWorktreeId
        }
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to archive worktree'
      }
    }
  },

  // Unbranch a worktree (remove worktree but keep branch)
  unbranchWorktree: async (
    worktreeId: string,
    worktreePath: string,
    branchName: string,
    projectPath: string
  ) => {
    // Guard: block unbranch of default worktrees
    const worktrees = Array.from(get().worktreesByProject.values()).flat()
    const worktree = worktrees.find((w) => w.id === worktreeId)
    if (worktree?.is_default) {
      toast.error('Cannot unbranch the default worktree')
      return { success: false, error: 'Cannot unbranch the default worktree' }
    }

    try {
      const result = await window.worktreeOps.delete({
        worktreeId,
        worktreePath,
        branchName,
        projectPath,
        archive: false
      })

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to unbranch worktree' }
      }

      // Remove from state
      set((state) => {
        const newMap = new Map(state.worktreesByProject)
        for (const [projectId, worktrees] of newMap.entries()) {
          const filtered = worktrees.filter((w) => w.id !== worktreeId)
          if (filtered.length !== worktrees.length) {
            newMap.set(projectId, filtered)
          }
        }
        return {
          worktreesByProject: newMap,
          selectedWorktreeId:
            state.selectedWorktreeId === worktreeId ? null : state.selectedWorktreeId
        }
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to unbranch worktree'
      }
    }
  },

  // Select a worktree
  selectWorktree: (id: string | null) => {
    set({ selectedWorktreeId: id })
    if (id) {
      // Touch worktree to update last_accessed_at
      get().touchWorktree(id)
    }
  },

  // Touch worktree (update last_accessed_at)
  touchWorktree: async (id: string) => {
    try {
      await window.db.worktree.touch(id)
      // Update local state
      set((state) => {
        const newMap = new Map(state.worktreesByProject)
        for (const [projectId, worktrees] of newMap.entries()) {
          const updated = worktrees.map((w) =>
            w.id === id ? { ...w, last_accessed_at: new Date().toISOString() } : w
          )
          if (updated.some((w, i) => w !== worktrees[i])) {
            newMap.set(projectId, updated)
          }
        }
        return { worktreesByProject: newMap }
      })
    } catch {
      // Ignore touch errors
    }
  },

  // Sync worktrees with actual git state
  syncWorktrees: async (projectId: string, projectPath: string) => {
    try {
      await window.worktreeOps.sync({ projectId, projectPath })
      // Reload worktrees after sync
      await get().loadWorktrees(projectId)
    } catch {
      // Ignore sync errors
    }
  },

  // Get worktrees for a specific project
  getWorktreesForProject: (projectId: string) => {
    return get().worktreesByProject.get(projectId) || []
  },

  // Get the default worktree for a project
  getDefaultWorktree: (projectId: string) => {
    const worktrees = get().worktreesByProject.get(projectId) || []
    return worktrees.find((w) => w.is_default) ?? null
  },

  // Set the project ID that is currently creating a worktree
  setCreatingForProject: (projectId: string | null) => {
    set({ creatingForProjectId: projectId })
  },

  // Duplicate a worktree (clone branch with uncommitted state)
  duplicateWorktree: async (
    projectId: string,
    projectPath: string,
    projectName: string,
    sourceBranch: string,
    sourceWorktreePath: string
  ) => {
    try {
      const result = await window.worktreeOps.duplicate({
        projectId,
        projectPath,
        projectName,
        sourceBranch,
        sourceWorktreePath
      })
      if (result.success && result.worktree) {
        // Reload worktrees for the project
        get().loadWorktrees(projectId)
      }
      return result
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to duplicate worktree'
      }
    }
  }
}))
