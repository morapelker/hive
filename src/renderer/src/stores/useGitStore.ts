import { create } from 'zustand'

// Git status types matching main process
type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'C' | ''

interface GitFileStatus {
  path: string
  relativePath: string
  status: GitStatusCode
  staged: boolean
}

interface GitStoreState {
  // Data - keyed by worktree path
  fileStatusesByWorktree: Map<string, GitFileStatus[]>
  isLoading: boolean
  error: string | null

  // Actions
  loadFileStatuses: (worktreePath: string) => Promise<void>
  getFileStatuses: (worktreePath: string) => GitFileStatus[]
  getFileStatus: (worktreePath: string, relativePath: string) => GitFileStatus | undefined
  stageFile: (worktreePath: string, relativePath: string) => Promise<boolean>
  unstageFile: (worktreePath: string, relativePath: string) => Promise<boolean>
  discardChanges: (worktreePath: string, relativePath: string) => Promise<boolean>
  addToGitignore: (worktreePath: string, pattern: string) => Promise<boolean>
  refreshStatuses: (worktreePath: string) => Promise<void>
  clearStatuses: (worktreePath: string) => void
}

export const useGitStore = create<GitStoreState>()((set, get) => ({
  // Initial state
  fileStatusesByWorktree: new Map(),
  isLoading: false,
  error: null,

  // Load file statuses for a worktree
  loadFileStatuses: async (worktreePath: string) => {
    set({ isLoading: true, error: null })
    try {
      const result = await window.gitOps.getFileStatuses(worktreePath)
      if (!result.success || !result.files) {
        set({
          error: result.error || 'Failed to load file statuses',
          isLoading: false
        })
        return
      }

      set((state) => {
        const newMap = new Map(state.fileStatusesByWorktree)
        newMap.set(worktreePath, result.files!)
        return { fileStatusesByWorktree: newMap, isLoading: false }
      })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load file statuses',
        isLoading: false
      })
    }
  },

  // Get file statuses for a worktree
  getFileStatuses: (worktreePath: string) => {
    return get().fileStatusesByWorktree.get(worktreePath) || []
  },

  // Get status for a specific file
  getFileStatus: (worktreePath: string, relativePath: string) => {
    const statuses = get().fileStatusesByWorktree.get(worktreePath) || []
    return statuses.find((s) => s.relativePath === relativePath)
  },

  // Stage a file
  stageFile: async (worktreePath: string, relativePath: string) => {
    try {
      const result = await window.gitOps.stageFile(worktreePath, relativePath)
      if (result.success) {
        // Refresh statuses after staging
        await get().loadFileStatuses(worktreePath)
      }
      return result.success
    } catch (error) {
      console.error('Failed to stage file:', error)
      return false
    }
  },

  // Unstage a file
  unstageFile: async (worktreePath: string, relativePath: string) => {
    try {
      const result = await window.gitOps.unstageFile(worktreePath, relativePath)
      if (result.success) {
        // Refresh statuses after unstaging
        await get().loadFileStatuses(worktreePath)
      }
      return result.success
    } catch (error) {
      console.error('Failed to unstage file:', error)
      return false
    }
  },

  // Discard changes in a file
  discardChanges: async (worktreePath: string, relativePath: string) => {
    try {
      const result = await window.gitOps.discardChanges(worktreePath, relativePath)
      if (result.success) {
        // Refresh statuses after discarding
        await get().loadFileStatuses(worktreePath)
      }
      return result.success
    } catch (error) {
      console.error('Failed to discard changes:', error)
      return false
    }
  },

  // Add to .gitignore
  addToGitignore: async (worktreePath: string, pattern: string) => {
    try {
      const result = await window.gitOps.addToGitignore(worktreePath, pattern)
      if (result.success) {
        // Refresh statuses after adding to gitignore
        await get().loadFileStatuses(worktreePath)
      }
      return result.success
    } catch (error) {
      console.error('Failed to add to .gitignore:', error)
      return false
    }
  },

  // Refresh statuses (alias for loadFileStatuses)
  refreshStatuses: async (worktreePath: string) => {
    await get().loadFileStatuses(worktreePath)
  },

  // Clear statuses for a worktree
  clearStatuses: (worktreePath: string) => {
    set((state) => {
      const newMap = new Map(state.fileStatusesByWorktree)
      newMap.delete(worktreePath)
      return { fileStatusesByWorktree: newMap }
    })
  }
}))

// Export types
export type { GitStatusCode, GitFileStatus }
