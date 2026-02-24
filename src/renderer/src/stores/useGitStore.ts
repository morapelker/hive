import { create } from 'zustand'
import { useWorktreeStore } from './useWorktreeStore'

// Debounce timers for git status refresh per worktree
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Pending promise resolvers — accumulated so ALL callers resolve when debounced work completes
const pendingResolvers = new Map<string, Array<() => void>>()
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

interface RemoteInfo {
  hasRemote: boolean
  isGitHub: boolean
  url: string | null
}

interface PRInfo {
  state: 'none' | 'creating' | 'created' | 'merged'
  prNumber?: number
  prUrl?: string
  targetBranch?: string
  sessionId?: string
}

interface GitStoreState {
  // Data - keyed by worktree path
  fileStatusesByWorktree: Map<string, GitFileStatus[]>
  branchInfoByWorktree: Map<string, GitBranchInfo>
  conflictsByWorktree: Record<string, boolean>
  isLoading: boolean
  error: string | null

  // Operation states
  isCommitting: boolean
  isPushing: boolean
  isPulling: boolean

  // Remote info - keyed by worktree ID
  remoteInfo: Map<string, RemoteInfo>
  prTargetBranch: Map<string, string>
  reviewTargetBranch: Map<string, string>

  // PR lifecycle - keyed by worktree ID
  prInfo: Map<string, PRInfo>

  // Cross-worktree merge default - keyed by project ID
  defaultMergeBranch: Map<string, string>
  // Incremented on every commit so components can reset manual merge selections
  mergeSelectionVersion: number

  // Merge branch selection - keyed by worktree path
  selectedMergeBranch: Map<string, string>

  // Actions
  loadFileStatuses: (worktreePath: string) => Promise<void>
  loadBranchInfo: (worktreePath: string) => Promise<void>
  getFileStatuses: (worktreePath: string) => GitFileStatus[]
  getBranchInfo: (worktreePath: string) => GitBranchInfo | undefined
  getFileStatus: (worktreePath: string, relativePath: string) => GitFileStatus | undefined
  setHasConflicts: (worktreePath: string, hasConflicts: boolean) => void
  stageFile: (worktreePath: string, relativePath: string) => Promise<boolean>
  unstageFile: (worktreePath: string, relativePath: string) => Promise<boolean>
  stageAll: (worktreePath: string) => Promise<boolean>
  unstageAll: (worktreePath: string) => Promise<boolean>
  discardChanges: (worktreePath: string, relativePath: string) => Promise<boolean>
  addToGitignore: (worktreePath: string, pattern: string) => Promise<boolean>
  refreshStatuses: (worktreePath: string) => Promise<void>
  clearStatuses: (worktreePath: string) => void
  loadStatusesForPaths: (paths: string[]) => Promise<void>

  // Remote info actions
  checkRemoteInfo: (worktreeId: string, worktreePath: string) => Promise<void>
  setPrTargetBranch: (worktreeId: string, branch: string) => void
  setReviewTargetBranch: (worktreeId: string, branch: string) => void

  // PR lifecycle actions
  setPrState: (worktreeId: string, info: PRInfo) => void

  // Cross-worktree merge default actions
  setDefaultMergeBranch: (projectId: string, branchName: string) => void

  // Merge branch selection actions
  setSelectedMergeBranch: (worktreePath: string, branch: string) => void

  // Commit, Push, Pull actions
  commit: (
    worktreePath: string,
    message: string
  ) => Promise<{ success: boolean; commitHash?: string; error?: string }>
  push: (
    worktreePath: string,
    remote?: string,
    branch?: string,
    force?: boolean
  ) => Promise<{ success: boolean; error?: string }>
  pull: (
    worktreePath: string,
    remote?: string,
    branch?: string,
    rebase?: boolean
  ) => Promise<{ success: boolean; error?: string }>
}

export const useGitStore = create<GitStoreState>()((set, get) => ({
  // Initial state
  fileStatusesByWorktree: new Map(),
  branchInfoByWorktree: new Map(),
  conflictsByWorktree: {},
  isLoading: false,
  error: null,

  // Operation states
  isCommitting: false,
  isPushing: false,
  isPulling: false,

  // Remote info
  remoteInfo: new Map(),
  prTargetBranch: new Map(),
  reviewTargetBranch: new Map(),

  // PR lifecycle
  prInfo: new Map(),

  // Cross-worktree merge default
  defaultMergeBranch: new Map(),
  mergeSelectionVersion: 0,

  // Merge branch selection
  selectedMergeBranch: new Map(),

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

      const files = result.files!
      const hasConflicts = files.some((f) => f.status === 'C')

      set((state) => {
        const newMap = new Map(state.fileStatusesByWorktree)
        newMap.set(worktreePath, files)
        return {
          fileStatusesByWorktree: newMap,
          isLoading: false,
          conflictsByWorktree: {
            ...state.conflictsByWorktree,
            [worktreePath]: hasConflicts
          }
        }
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

  // Set whether a worktree has merge conflicts
  setHasConflicts: (worktreePath: string, hasConflicts: boolean) => {
    set((state) => ({
      conflictsByWorktree: {
        ...state.conflictsByWorktree,
        [worktreePath]: hasConflicts
      }
    }))
  },

  // Stage a file
  stageFile: async (worktreePath: string, relativePath: string) => {
    try {
      const result = await window.gitOps.stageFile(worktreePath, relativePath)
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

    // Set debounced refresh — accumulate resolvers so all callers get notified
    return new Promise<void>((resolve) => {
      const resolvers = pendingResolvers.get(worktreePath) || []
      resolvers.push(resolve)
      pendingResolvers.set(worktreePath, resolvers)

      refreshTimers.set(
        worktreePath,
        setTimeout(async () => {
          refreshTimers.delete(worktreePath)
          try {
            await Promise.all([
              get().loadFileStatuses(worktreePath),
              get().loadBranchInfo(worktreePath)
            ])
          } finally {
            // Resolve ALL pending promises for this worktree
            const toResolve = pendingResolvers.get(worktreePath) || []
            pendingResolvers.delete(worktreePath)
            toResolve.forEach((r) => r())
          }
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

  // Load statuses and branch info for multiple worktree paths simultaneously
  loadStatusesForPaths: async (paths: string[]) => {
    await Promise.all(
      paths.map((path) => Promise.all([get().loadFileStatuses(path), get().loadBranchInfo(path)]))
    )
  },

  // Check remote info for a worktree
  checkRemoteInfo: async (worktreeId: string, worktreePath: string) => {
    try {
      const result = await window.gitOps.getRemoteUrl(worktreePath)
      const info: RemoteInfo = {
        hasRemote: !!result.url,
        isGitHub: result.url?.includes('github.com') ?? false,
        url: result.url ?? null
      }
      set((state) => {
        const newRemoteInfo = new Map(state.remoteInfo)
        newRemoteInfo.set(worktreeId, info)
        return { remoteInfo: newRemoteInfo }
      })
    } catch {
      // Non-critical — default to no remote
      set((state) => {
        const newRemoteInfo = new Map(state.remoteInfo)
        newRemoteInfo.set(worktreeId, { hasRemote: false, isGitHub: false, url: null })
        return { remoteInfo: newRemoteInfo }
      })
    }
  },

  // Set PR lifecycle state for a worktree
  setPrState: (worktreeId: string, info: PRInfo) => {
    set((state) => {
      const newMap = new Map(state.prInfo)
      newMap.set(worktreeId, info)
      return { prInfo: newMap }
    })
  },

  // Set PR target branch for a worktree
  setPrTargetBranch: (worktreeId: string, branch: string) => {
    set((state) => {
      const newPrTargetBranch = new Map(state.prTargetBranch)
      newPrTargetBranch.set(worktreeId, branch)
      return { prTargetBranch: newPrTargetBranch }
    })
  },

  // Set review target branch for a worktree
  setReviewTargetBranch: (worktreeId: string, branch: string) => {
    set((state) => {
      const newMap = new Map(state.reviewTargetBranch)
      newMap.set(worktreeId, branch)
      return { reviewTargetBranch: newMap }
    })
  },

  // Set default merge branch for sibling worktrees after a commit
  setDefaultMergeBranch: (projectId: string, branchName: string) => {
    set((state) => {
      const newMap = new Map(state.defaultMergeBranch)
      newMap.set(projectId, branchName)
      return { defaultMergeBranch: newMap }
    })
  },

  // Set the selected merge branch for a worktree
  setSelectedMergeBranch: (worktreePath: string, branch: string) => {
    set((state) => {
      const newMap = new Map(state.selectedMergeBranch)
      newMap.set(worktreePath, branch)
      return { selectedMergeBranch: newMap }
    })
  },

  // Commit staged changes
  commit: async (worktreePath: string, message: string) => {
    set({ isCommitting: true, error: null })
    try {
      const result = await window.gitOps.commit(worktreePath, message)
      if (result.success) {
        // Refresh statuses after commit (wrapped so failure doesn't block commit success)
        try {
          await get().refreshStatuses(worktreePath)
        } catch {
          // Non-critical — commit already succeeded
        }

        // Set the committed branch as the default merge target for sibling worktrees
        const branchInfo = get().branchInfoByWorktree.get(worktreePath)
        if (branchInfo?.name) {
          const allWorktrees = Array.from(
            useWorktreeStore.getState().worktreesByProject.values()
          ).flat()
          const worktree = allWorktrees.find((w) => w.path === worktreePath)
          if (worktree?.project_id) {
            get().setDefaultMergeBranch(worktree.project_id, branchInfo.name)
          }
        }
        // Bump version so components reset any manual merge-from selection
        set((state) => ({ mergeSelectionVersion: state.mergeSelectionVersion + 1 }))
      }
      return result
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Failed to commit'
      set({ error: errMessage })
      return { success: false, error: errMessage }
    } finally {
      set({ isCommitting: false })
    }
  },

  // Push to remote
  push: async (worktreePath: string, remote?: string, branch?: string, force?: boolean) => {
    set({ isPushing: true, error: null })
    try {
      const result = await window.gitOps.push(worktreePath, remote, branch, force)
      if (result.success) {
        // Refresh branch info to update ahead/behind counts
        try {
          await get().loadBranchInfo(worktreePath)
        } catch {
          // Non-critical — push already succeeded
        }
      }
      return result
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Failed to push'
      set({ error: errMessage })
      return { success: false, error: errMessage }
    } finally {
      set({ isPushing: false })
    }
  },

  // Pull from remote
  pull: async (worktreePath: string, remote?: string, branch?: string, rebase?: boolean) => {
    set({ isPulling: true, error: null })
    try {
      const result = await window.gitOps.pull(worktreePath, remote, branch, rebase)
      if (result.success) {
        // Refresh statuses after pull (wrapped so failure doesn't block pull success)
        try {
          await get().refreshStatuses(worktreePath)
        } catch {
          // Non-critical — pull already succeeded
        }
      }
      return result
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Failed to pull'
      set({ error: errMessage })
      return { success: false, error: errMessage }
    } finally {
      set({ isPulling: false })
    }
  }
}))

// Export types
export type { GitStatusCode, GitFileStatus, GitBranchInfo, RemoteInfo, PRInfo }
