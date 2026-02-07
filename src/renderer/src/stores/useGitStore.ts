import { create } from 'zustand'

// Debounce timers for git status refresh per worktree
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const REFRESH_DEBOUNCE_MS = 150

// Git status types matching main process
type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'C' | ''

interface GitFileStatus {
  path: string
  relativePath: string
  status: GitStatusCode
  staged: boolean
}

interface GitBranchInfo {
  name: string
  tracking: string | null
  ahead: number
  behind: number
}

interface GitStoreState {
  // Data - keyed by worktree path
  fileStatusesByWorktree: Map<string, GitFileStatus[]>
  branchInfoByWorktree: Map<string, GitBranchInfo>
  isLoading: boolean
  error: string | null

  // Operation states
  isCommitting: boolean
  isPushing: boolean
  isPulling: boolean

  // Actions
  loadFileStatuses: (worktreePath: string) => Promise<void>
  loadBranchInfo: (worktreePath: string) => Promise<void>
  getFileStatuses: (worktreePath: string) => GitFileStatus[]
  getBranchInfo: (worktreePath: string) => GitBranchInfo | undefined
  getFileStatus: (worktreePath: string, relativePath: string) => GitFileStatus | undefined
  stageFile: (worktreePath: string, relativePath: string) => Promise<boolean>
  unstageFile: (worktreePath: string, relativePath: string) => Promise<boolean>
  stageAll: (worktreePath: string) => Promise<boolean>
  unstageAll: (worktreePath: string) => Promise<boolean>
  discardChanges: (worktreePath: string, relativePath: string) => Promise<boolean>
  addToGitignore: (worktreePath: string, pattern: string) => Promise<boolean>
  refreshStatuses: (worktreePath: string) => Promise<void>
  clearStatuses: (worktreePath: string) => void

  // Commit, Push, Pull actions
  commit: (worktreePath: string, message: string) => Promise<{ success: boolean; commitHash?: string; error?: string }>
  push: (worktreePath: string, remote?: string, branch?: string, force?: boolean) => Promise<{ success: boolean; error?: string }>
  pull: (worktreePath: string, remote?: string, branch?: string, rebase?: boolean) => Promise<{ success: boolean; error?: string }>
}

export const useGitStore = create<GitStoreState>()((set, get) => ({
  // Initial state
  fileStatusesByWorktree: new Map(),
  branchInfoByWorktree: new Map(),
  isLoading: false,
  error: null,

  // Operation states
  isCommitting: false,
  isPushing: false,
  isPulling: false,

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

  // Load branch info for a worktree
  loadBranchInfo: async (worktreePath: string) => {
    try {
      const result = await window.gitOps.getBranchInfo(worktreePath)
      if (!result.success || !result.branch) {
        return
      }

      set((state) => {
        const newMap = new Map(state.branchInfoByWorktree)
        newMap.set(worktreePath, result.branch!)
        return { branchInfoByWorktree: newMap }
      })
    } catch (error) {
      console.error('Failed to load branch info:', error)
    }
  },

  // Get file statuses for a worktree
  getFileStatuses: (worktreePath: string) => {
    return get().fileStatusesByWorktree.get(worktreePath) || []
  },

  // Get branch info for a worktree
  getBranchInfo: (worktreePath: string) => {
    return get().branchInfoByWorktree.get(worktreePath)
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

  // Stage all modified and untracked files
  stageAll: async (worktreePath: string) => {
    try {
      const result = await window.gitOps.stageAll(worktreePath)
      if (result.success) {
        // Refresh statuses after staging all
        await get().loadFileStatuses(worktreePath)
      }
      return result.success
    } catch (error) {
      console.error('Failed to stage all files:', error)
      return false
    }
  },

  // Unstage all staged files
  unstageAll: async (worktreePath: string) => {
    try {
      const result = await window.gitOps.unstageAll(worktreePath)
      if (result.success) {
        // Refresh statuses after unstaging all
        await get().loadFileStatuses(worktreePath)
      }
      return result.success
    } catch (error) {
      console.error('Failed to unstage all files:', error)
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

  // Refresh statuses and branch info (debounced to batch rapid file changes)
  refreshStatuses: async (worktreePath: string) => {
    // Clear existing timer for this worktree
    const existing = refreshTimers.get(worktreePath)
    if (existing) {
      clearTimeout(existing)
    }

    // Set debounced refresh
    return new Promise<void>((resolve) => {
      refreshTimers.set(
        worktreePath,
        setTimeout(async () => {
          refreshTimers.delete(worktreePath)
          await Promise.all([
            get().loadFileStatuses(worktreePath),
            get().loadBranchInfo(worktreePath)
          ])
          resolve()
        }, REFRESH_DEBOUNCE_MS)
      )
    })
  },

  // Clear statuses for a worktree
  clearStatuses: (worktreePath: string) => {
    set((state) => {
      const newFileMap = new Map(state.fileStatusesByWorktree)
      newFileMap.delete(worktreePath)
      const newBranchMap = new Map(state.branchInfoByWorktree)
      newBranchMap.delete(worktreePath)
      return { fileStatusesByWorktree: newFileMap, branchInfoByWorktree: newBranchMap }
    })
  },

  // Commit staged changes
  commit: async (worktreePath: string, message: string) => {
    set({ isCommitting: true, error: null })
    try {
      const result = await window.gitOps.commit(worktreePath, message)
      if (result.success) {
        // Refresh statuses after commit
        await get().refreshStatuses(worktreePath)
      }
      set({ isCommitting: false })
      return result
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Failed to commit'
      set({ isCommitting: false, error: errMessage })
      return { success: false, error: errMessage }
    }
  },

  // Push to remote
  push: async (worktreePath: string, remote?: string, branch?: string, force?: boolean) => {
    set({ isPushing: true, error: null })
    try {
      const result = await window.gitOps.push(worktreePath, remote, branch, force)
      if (result.success) {
        // Refresh branch info to update ahead/behind counts
        await get().loadBranchInfo(worktreePath)
      }
      set({ isPushing: false })
      return result
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Failed to push'
      set({ isPushing: false, error: errMessage })
      return { success: false, error: errMessage }
    }
  },

  // Pull from remote
  pull: async (worktreePath: string, remote?: string, branch?: string, rebase?: boolean) => {
    set({ isPulling: true, error: null })
    try {
      const result = await window.gitOps.pull(worktreePath, remote, branch, rebase)
      if (result.success) {
        // Refresh statuses after pull
        await get().refreshStatuses(worktreePath)
      }
      set({ isPulling: false })
      return result
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Failed to pull'
      set({ isPulling: false, error: errMessage })
      return { success: false, error: errMessage }
    }
  }
}))

// Export types
export type { GitStatusCode, GitFileStatus, GitBranchInfo }
