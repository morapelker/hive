import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// File tree node structure matching main process
interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  extension: string | null
  children?: FileTreeNode[]
}

interface FileTreeState {
  // Data - keyed by worktree path
  fileTreeByWorktree: Map<string, FileTreeNode[]>
  isLoading: boolean
  error: string | null

  // UI State - keyed by worktree path
  expandedPathsByWorktree: Map<string, Set<string>>
  filterByWorktree: Map<string, string>

  // Actions
  loadFileTree: (worktreePath: string) => Promise<void>
  loadChildren: (worktreePath: string, dirPath: string) => Promise<void>
  setExpanded: (worktreePath: string, paths: Set<string>) => void
  toggleExpanded: (worktreePath: string, path: string) => void
  collapseAll: (worktreePath: string) => void
  setFilter: (worktreePath: string, filter: string) => void
  getFileTree: (worktreePath: string) => FileTreeNode[]
  getExpandedPaths: (worktreePath: string) => Set<string>
  getFilter: (worktreePath: string) => string
  isExpanded: (worktreePath: string, path: string) => boolean
  refreshFileTree: (worktreePath: string) => Promise<void>
  startWatching: (worktreePath: string) => Promise<void>
  stopWatching: (worktreePath: string) => Promise<void>
  handleFileChange: (
    worktreePath: string,
    eventType: string,
    changedPath: string,
    relativePath: string
  ) => Promise<void>
}

// Helper to convert Set to Array for persistence
const serializeExpandedPaths = (map: Map<string, Set<string>>): [string, string[]][] => {
  const result: [string, string[]][] = []
  for (const [key, value] of map.entries()) {
    result.push([key, Array.from(value)])
  }
  return result
}

// Helper to convert Array back to Set from persistence
const deserializeExpandedPaths = (data: [string, string[]][]): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>()
  for (const [key, value] of data) {
    map.set(key, new Set(value))
  }
  return map
}

export const useFileTreeStore = create<FileTreeState>()(
  persist(
    (set, get) => ({
      // Initial state
      fileTreeByWorktree: new Map(),
      isLoading: false,
      error: null,
      expandedPathsByWorktree: new Map(),
      filterByWorktree: new Map(),

      // Load file tree for a worktree
      loadFileTree: async (worktreePath: string) => {
        set({ isLoading: true, error: null })
        try {
          const result = await window.fileTreeOps.scan(worktreePath)
          if (!result.success || !result.tree) {
            set({
              error: result.error || 'Failed to load file tree',
              isLoading: false
            })
            return
          }

          set((state) => {
            const newMap = new Map(state.fileTreeByWorktree)
            newMap.set(worktreePath, result.tree!)
            return { fileTreeByWorktree: newMap, isLoading: false }
          })
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to load file tree',
            isLoading: false
          })
        }
      },

      // Lazy load children for a directory
      loadChildren: async (worktreePath: string, dirPath: string) => {
        try {
          const result = await window.fileTreeOps.loadChildren(dirPath, worktreePath)
          if (!result.success || !result.children) {
            return
          }

          set((state) => {
            const newMap = new Map(state.fileTreeByWorktree)
            const tree = newMap.get(worktreePath)
            if (!tree) return state

            // Helper to update children in the tree
            const updateChildren = (nodes: FileTreeNode[]): FileTreeNode[] => {
              return nodes.map((node) => {
                if (node.path === dirPath) {
                  return { ...node, children: result.children }
                }
                if (node.children) {
                  return { ...node, children: updateChildren(node.children) }
                }
                return node
              })
            }

            newMap.set(worktreePath, updateChildren(tree))
            return { fileTreeByWorktree: newMap }
          })
        } catch (error) {
          console.error('Failed to load children:', error)
        }
      },

      // Set expanded paths
      setExpanded: (worktreePath: string, paths: Set<string>) => {
        set((state) => {
          const newMap = new Map(state.expandedPathsByWorktree)
          newMap.set(worktreePath, paths)
          return { expandedPathsByWorktree: newMap }
        })
      },

      // Toggle expanded state for a path
      toggleExpanded: (worktreePath: string, path: string) => {
        const state = get()
        const expanded = new Set(state.expandedPathsByWorktree.get(worktreePath) || [])

        if (expanded.has(path)) {
          expanded.delete(path)
        } else {
          expanded.add(path)
          // Trigger lazy loading if needed
          const tree = state.fileTreeByWorktree.get(worktreePath)
          if (tree) {
            const findNode = (nodes: FileTreeNode[]): FileTreeNode | null => {
              for (const node of nodes) {
                if (node.path === path) return node
                if (node.children) {
                  const found = findNode(node.children)
                  if (found) return found
                }
              }
              return null
            }
            const node = findNode(tree)
            if (node && node.isDirectory && node.children === undefined) {
              // Lazy load children
              get().loadChildren(worktreePath, path)
            }
          }
        }

        set((state) => {
          const newMap = new Map(state.expandedPathsByWorktree)
          newMap.set(worktreePath, expanded)
          return { expandedPathsByWorktree: newMap }
        })
      },

      // Collapse all folders
      collapseAll: (worktreePath: string) => {
        set((state) => {
          const newMap = new Map(state.expandedPathsByWorktree)
          newMap.set(worktreePath, new Set())
          return { expandedPathsByWorktree: newMap }
        })
      },

      // Set filter for a worktree
      setFilter: (worktreePath: string, filter: string) => {
        set((state) => {
          const newMap = new Map(state.filterByWorktree)
          newMap.set(worktreePath, filter)
          return { filterByWorktree: newMap }
        })
      },

      // Get file tree for a worktree
      getFileTree: (worktreePath: string) => {
        return get().fileTreeByWorktree.get(worktreePath) || []
      },

      // Get expanded paths for a worktree
      getExpandedPaths: (worktreePath: string) => {
        return get().expandedPathsByWorktree.get(worktreePath) || new Set()
      },

      // Get filter for a worktree
      getFilter: (worktreePath: string) => {
        return get().filterByWorktree.get(worktreePath) || ''
      },

      // Check if a path is expanded
      isExpanded: (worktreePath: string, path: string) => {
        const expanded = get().expandedPathsByWorktree.get(worktreePath)
        return expanded ? expanded.has(path) : false
      },

      // Refresh file tree (rescan)
      refreshFileTree: async (worktreePath: string) => {
        await get().loadFileTree(worktreePath)
      },

      // Start watching for file changes
      startWatching: async (worktreePath: string) => {
        try {
          await window.fileTreeOps.watch(worktreePath)
        } catch (error) {
          console.error('Failed to start file watching:', error)
        }
      },

      // Stop watching for file changes
      stopWatching: async (worktreePath: string) => {
        try {
          await window.fileTreeOps.unwatch(worktreePath)
        } catch (error) {
          console.error('Failed to stop file watching:', error)
        }
      },

      // Handle file change event from watcher
      handleFileChange: async (
        worktreePath: string,
        _eventType: string,
        _changedPath: string,
        _relativePath: string
      ) => {
        // For now, just refresh the entire tree
        // In the future, we could be smarter about updating just the changed part
        await get().refreshFileTree(worktreePath)
      }
    }),
    {
      name: 'hive-file-tree',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        // Only persist expanded paths
        expandedPathsByWorktree: serializeExpandedPaths(state.expandedPathsByWorktree)
      }),
      // Handle deserialization
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Convert serialized data back to Map<string, Set<string>>
          const serialized = state.expandedPathsByWorktree as unknown as [string, string[]][]
          if (Array.isArray(serialized)) {
            state.expandedPathsByWorktree = deserializeExpandedPaths(serialized)
          }
        }
      }
    }
  )
)
