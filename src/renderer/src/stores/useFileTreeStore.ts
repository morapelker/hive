import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { FlatFile } from '@/lib/file-search-utils'
import { isSameOrInsidePath, movedPathFor, type MovedPath } from '@/lib/dev-folder/moved-paths'
import type { FileTreeChangeEventItem } from '@shared/types/file-tree'
import { fileTreeApi } from '@/api/file-tree-api'

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

  // Flat file index for search (@ mentions, Cmd+D) - keyed by worktree path
  fileIndexByWorktree: Map<string, FlatFile[]>
  fileIndexLoadingByWorktree: Map<string, boolean>

  // UI State - keyed by worktree path
  expandedPathsByWorktree: Map<string, Set<string>>
  filterByWorktree: Map<string, string>

  // Actions
  loadFileTree: (worktreePath: string) => Promise<void>
  loadFileIndex: (worktreePath: string) => Promise<void>
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
  handleFileChange: (worktreePath: string, events: FileTreeChangeEventItem[]) => Promise<void>
  /**
   * Follow worktrees whose folder moved (a project brought over to the dev folder): what the
   * person left expanded and the filter they typed go to the new path, and what was scanned
   * under the old path is dropped so the tree is read again where it is now.
   */
  rekeyWorktreePaths: (moves: readonly MovedPath[]) => void
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

// The expanded folders after `moves`: a worktree that moved is filed under its new path, and
// so is every folder in its set (each entry is an absolute path inside the worktree). When
// the new path already has a set, the two are merged, so nothing the person expanded is lost.
// Returns the map it was given when no path in it moved; a set no move touched is kept as the
// same object.
const rekeyExpandedPaths = (
  map: Map<string, Set<string>>,
  moves: readonly MovedPath[]
): Map<string, Set<string>> => {
  let changed = false
  const next = new Map<string, Set<string>>()
  for (const [key, paths] of map) {
    const nextKey = movedPathFor(key, moves) ?? key

    let nextPaths = paths
    for (const path of paths) {
      if ((movedPathFor(path, moves) ?? path) === path) continue
      nextPaths = new Set(Array.from(paths, (entry) => movedPathFor(entry, moves) ?? entry))
      break
    }
    if (nextKey !== key || nextPaths !== paths) changed = true

    const existing = next.get(nextKey)
    if (existing) {
      changed = true
      next.set(nextKey, new Set([...existing, ...nextPaths]))
    } else {
      next.set(nextKey, nextPaths)
    }
  }
  return changed ? next : map
}

// The filters after `moves`. The filter of a worktree that moved replaces whatever its new
// path held: that one is what the person sees in the tree right now.
const rekeyFilters = (
  map: Map<string, string>,
  moves: readonly MovedPath[]
): Map<string, string> => {
  let changed = false
  const next = new Map<string, string>()
  const moved: [string, string][] = []
  for (const [key, filter] of map) {
    const nextKey = movedPathFor(key, moves) ?? key
    if (nextKey === key) {
      next.set(key, filter)
    } else {
      changed = true
      moved.push([nextKey, filter])
    }
  }
  for (const [key, filter] of moved) next.set(key, filter)
  return changed ? next : map
}

// A map without the entries of the worktrees that moved. Trees and file indexes hold the old
// absolute path in every node, so they are not carried over: the views load them again under
// the new path. Returns the map it was given when it holds none.
const withoutMovedWorktrees = <T>(
  map: Map<string, T>,
  moves: readonly MovedPath[]
): Map<string, T> => {
  let next: Map<string, T> | null = null
  for (const key of map.keys()) {
    if (!moves.some((move) => isSameOrInsidePath(key, move.from))) continue
    next ??= new Map(map)
    next.delete(key)
  }
  return next ?? map
}

// Module-level map for onChange subscriptions with refcounting.
// Multiple components (FileTree, SessionView) can startWatching the same path;
// refCount ensures the watcher is only torn down when all consumers have stopped.
const watchSubscriptions = new Map<string, { unsubscribe: () => void; refCount: number }>()

// When a batch of file-change events exceeds this threshold (e.g. branch switch,
// npm install), skip incremental index updates and do a full re-scan instead.
const FULL_RESCAN_THRESHOLD = 20

// Folders that moved away (a project brought over to the dev folder), newest last. The watcher
// of a folder reports the folder's own disappearance, and that report can arrive after the
// tree was already read at the new path: a scan of the old path then fails with "Directory
// does not exist" and, `error` being one field for the whole store, the Files panel showed
// that error over the folder that is there. Nothing is loaded or reported for these paths.
//
// Only for a minute: the late report arrives within seconds of the move, and a path that
// stayed marked for good could never be read again in this window, also not when another
// project is later put at the same place.
const MOVED_AWAY_LIMIT = 2000
const MOVED_AWAY_MS = 60_000
let movedAwayPaths: { from: string; at: number }[] = []
const isMovedAway = (path: string): boolean => {
  const now = Date.now()
  return movedAwayPaths.some(
    (entry) => now - entry.at < MOVED_AWAY_MS && isSameOrInsidePath(path, entry.from)
  )
}

// Names the newest `loadFileTree` call: only that one may write `error` and `isLoading`, so a
// slower answer about another folder never replaces what the newest load said.
let treeLoadTurn = 0

export const useFileTreeStore = create<FileTreeState>()(
  persist(
    (set, get) => ({
      // Initial state
      fileTreeByWorktree: new Map(),
      isLoading: false,
      error: null,
      fileIndexByWorktree: new Map(),
      fileIndexLoadingByWorktree: new Map(),
      expandedPathsByWorktree: new Map(),
      filterByWorktree: new Map(),

      // Load file tree for a worktree
      loadFileTree: async (worktreePath: string) => {
        if (isMovedAway(worktreePath)) return
        const turn = ++treeLoadTurn
        set({ isLoading: true, error: null })
        try {
          const result = await fileTreeApi.scan(worktreePath)
          // The folder moved while it was being read: what came back is about a path that is
          // gone, whether it is a tree or an error.
          if (isMovedAway(worktreePath)) {
            if (turn === treeLoadTurn) set({ isLoading: false })
            return
          }
          if (!result.success || !result.tree) {
            if (turn !== treeLoadTurn) return
            set({
              error: result.error || 'Failed to load file tree',
              isLoading: false
            })
            return
          }

          set((state) => {
            const newMap = new Map(state.fileTreeByWorktree)
            newMap.set(worktreePath, result.tree!)
            return turn === treeLoadTurn
              ? { fileTreeByWorktree: newMap, isLoading: false }
              : { fileTreeByWorktree: newMap }
          })
        } catch (error) {
          if (turn !== treeLoadTurn) return
          if (isMovedAway(worktreePath)) {
            set({ isLoading: false })
            return
          }
          set({
            error: error instanceof Error ? error.message : 'Failed to load file tree',
            isLoading: false
          })
        }
      },

      // Load full flat file index for a worktree (for search / @ mentions)
      loadFileIndex: async (worktreePath: string) => {
        // Prevent duplicate concurrent loads
        if (get().fileIndexLoadingByWorktree.get(worktreePath)) return

        set((state) => {
          const newMap = new Map(state.fileIndexLoadingByWorktree)
          newMap.set(worktreePath, true)
          return { fileIndexLoadingByWorktree: newMap }
        })

        try {
          const result = await fileTreeApi.scanFlat(worktreePath)
          set((state) => {
            const indexMap = new Map(state.fileIndexByWorktree)
            const loadingMap = new Map(state.fileIndexLoadingByWorktree)
            if (result.success && result.files) {
              indexMap.set(worktreePath, result.files)
            }
            loadingMap.set(worktreePath, false)
            return { fileIndexByWorktree: indexMap, fileIndexLoadingByWorktree: loadingMap }
          })

          // Ensure the file watcher subscription is active so incremental
          // updates flow even when the Files sidebar tab is hidden.
          // startWatching guards against duplicate subscriptions internally.
          get().startWatching(worktreePath)
        } catch {
          set((state) => {
            const loadingMap = new Map(state.fileIndexLoadingByWorktree)
            loadingMap.set(worktreePath, false)
            return { fileIndexLoadingByWorktree: loadingMap }
          })
        }
      },

      // Lazy load children for a directory
      loadChildren: async (worktreePath: string, dirPath: string) => {
        try {
          const result = await fileTreeApi.loadChildren(dirPath, worktreePath)
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

      // Start watching for file changes + subscribe to onChange events.
      // Uses refcounting so multiple consumers (FileTree, SessionView) can
      // watch the same path without creating duplicate chokidar instances.
      startWatching: async (worktreePath: string) => {
        if (isMovedAway(worktreePath)) return
        try {
          const existing = watchSubscriptions.get(worktreePath)
          if (existing) {
            existing.refCount++
            return
          }

          await fileTreeApi.watch(worktreePath)

          // Subscribe to change events and route to handleFileChange
          const unsubscribe = fileTreeApi.onChange((event) => {
            if (event.worktreePath === worktreePath) {
              get().handleFileChange(worktreePath, event.events)
            }
          })
          watchSubscriptions.set(worktreePath, { unsubscribe, refCount: 1 })
        } catch (error) {
          console.error('Failed to start file watching:', error)
        }
      },

      // Stop watching for file changes + unsubscribe onChange events.
      // Only tears down the watcher when refCount reaches 0.
      stopWatching: async (worktreePath: string) => {
        try {
          const entry = watchSubscriptions.get(worktreePath)
          if (!entry) return

          if (entry.refCount <= 0) {
            console.warn(
              `[FileTreeStore] stopWatching called at refCount ${entry.refCount}`,
              worktreePath
            )
            return
          }

          entry.refCount = Math.max(0, entry.refCount - 1)
          if (entry.refCount > 0) return

          entry.unsubscribe()
          watchSubscriptions.delete(worktreePath)

          await fileTreeApi.unwatch(worktreePath)
        } catch (error) {
          console.error('Failed to stop file watching:', error)
        }
      },

      // Handle batched file change events from watcher
      handleFileChange: async (worktreePath: string, events: FileTreeChangeEventItem[]) => {
        // The last thing the watcher of a folder that moved reports is the folder going away.
        if (isMovedAway(worktreePath)) return

        // Refresh the tree display once (not per-event)
        await get().refreshFileTree(worktreePath)

        // For large batches (branch switch, npm install, etc.), skip incremental
        // updates and do a full re-scan — safer than processing hundreds of events.
        if (events.length > FULL_RESCAN_THRESHOLD) {
          await get().loadFileIndex(worktreePath)
          return
        }

        // Incrementally update the flat file index by processing all events in sequence
        set((state) => {
          const currentIndex = state.fileIndexByWorktree.get(worktreePath)
          if (!currentIndex) return state // No index loaded yet

          let updatedIndex = [...currentIndex]
          const knownPaths = new Set(currentIndex.map((f) => f.path))
          let mutated = false

          for (const { eventType, changedPath, relativePath } of events) {
            if (eventType === 'add' || eventType === 'change') {
              // For 'add': ensure file is in the index (avoid duplicates)
              // For 'change': if path is NOT in the index, treat as implicit 'add'
              //   — recovers from lost add events (debounce race, missed watcher event)
              if (!knownPaths.has(changedPath)) {
                const name = relativePath.split('/').pop() || relativePath
                const dotIdx = name.lastIndexOf('.')
                const extension = dotIdx > 0 ? name.substring(dotIdx).toLowerCase() : null
                updatedIndex.push({ name, path: changedPath, relativePath, extension })
                knownPaths.add(changedPath)
                mutated = true
              }
            } else if (eventType === 'unlink') {
              updatedIndex = updatedIndex.filter((f) => f.path !== changedPath)
              knownPaths.delete(changedPath)
              mutated = true
            } else if (eventType === 'unlinkDir') {
              const prefix = changedPath + '/'
              updatedIndex = updatedIndex.filter((f) => {
                if (f.path.startsWith(prefix)) {
                  knownPaths.delete(f.path)
                  return false
                }
                return true
              })
              mutated = true
            }
            // 'addDir' events do not affect the flat file index
          }

          if (!mutated) return state

          const newMap = new Map(state.fileIndexByWorktree)
          newMap.set(worktreePath, updatedIndex)
          return { fileIndexByWorktree: newMap }
        })
      },

      // The watch subscriptions are left alone on purpose: the views that started a watch on
      // the old path stop it and start one on the new path when their path changes, and the
      // counts only stay balanced when the same code does both.
      rekeyWorktreePaths: (moves: readonly MovedPath[]) => {
        const moved = moves.filter((move) => move.from.length > 0 && move.from !== move.to)
        if (moved.length === 0) return

        // From here on the old paths are gone: nothing is loaded for them, and what is still
        // on its way about them is dropped. A folder that moved back is no longer "away", and
        // neither is one that moved more than a minute ago.
        const now = Date.now()
        movedAwayPaths = [
          ...movedAwayPaths.filter(
            (entry) =>
              now - entry.at < MOVED_AWAY_MS &&
              !moved.some((move) => isSameOrInsidePath(move.to, entry.from))
          ),
          ...moved.map((move) => ({ from: move.from, at: now }))
        ].slice(-MOVED_AWAY_LIMIT)

        // Their watchers have nothing left to watch. Whoever started one stops it later by
        // its old path and finds it gone, which `stopWatching` takes as done.
        for (const [watched, entry] of Array.from(watchSubscriptions)) {
          if (!isMovedAway(watched)) continue
          watchSubscriptions.delete(watched)
          try {
            entry.unsubscribe()
          } catch {
            // The subscription is dropped either way.
          }
          void Promise.resolve()
            .then(() => fileTreeApi.unwatch(watched))
            .catch(() => undefined)
        }

        const state = get()
        const expandedPathsByWorktree = rekeyExpandedPaths(state.expandedPathsByWorktree, moved)
        const filterByWorktree = rekeyFilters(state.filterByWorktree, moved)
        const fileTreeByWorktree = withoutMovedWorktrees(state.fileTreeByWorktree, moved)
        const fileIndexByWorktree = withoutMovedWorktrees(state.fileIndexByWorktree, moved)
        const fileIndexLoadingByWorktree = withoutMovedWorktrees(
          state.fileIndexLoadingByWorktree,
          moved
        )

        // Every set is written to localStorage, so a move that touched nothing held here
        // writes nothing.
        if (
          expandedPathsByWorktree === state.expandedPathsByWorktree &&
          filterByWorktree === state.filterByWorktree &&
          fileTreeByWorktree === state.fileTreeByWorktree &&
          fileIndexByWorktree === state.fileIndexByWorktree &&
          fileIndexLoadingByWorktree === state.fileIndexLoadingByWorktree
        ) {
          return
        }

        set({
          expandedPathsByWorktree,
          filterByWorktree,
          fileTreeByWorktree,
          fileIndexByWorktree,
          fileIndexLoadingByWorktree
        })
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
