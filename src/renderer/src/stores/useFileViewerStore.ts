import { create } from 'zustand'
import { isWindows } from '@/lib/platform'

export interface FileViewerTab {
  type: 'file'
  path: string
  name: string
  worktreeId: string
}

export interface DiffTab {
  type: 'diff'
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
  isNewFile?: boolean
  compareBranch?: string
  prReviewWorktreeId?: string
}

export interface ContextTab {
  type: 'context'
  worktreeId: string
}

export type TabEntry = FileViewerTab | DiffTab | ContextTab

export interface ActiveDiff {
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
  isNewFile?: boolean
  compareBranch?: string
  scrollToLine?: number
  scrollTrigger?: number
  prReviewWorktreeId?: string
}

function diffTabKey(diff: { filePath: string; staged: boolean; compareBranch?: string }): string {
  return diff.compareBranch
    ? `diff:${diff.filePath}:branch:${diff.compareBranch}`
    : `diff:${diff.filePath}:${diff.staged ? 'staged' : 'unstaged'}`
}

/**
 * A diff tab keeps its file path split in two, so only the store knows how to join it.
 * Git reports slash separated relative paths, so on Windows they need converting to
 * get a native path, the same shape the file lists and "Copy Absolute Path" expect.
 *
 * Worktree paths are stored canonical, see canonicalProjectPath in project-ops, so
 * joining here gives the same string the backend gets from path.join.
 */
export function diffTabAbsolutePath(diff: { worktreePath: string; filePath: string }): string {
  const separator = isWindows() ? '\\' : '/'
  const filePath = isWindows() ? diff.filePath.replace(/\//g, separator) : diff.filePath
  // A worktree at the filesystem root already ends in a separator, and path.join on
  // the backend side does not double it either.
  const { worktreePath } = diff
  const prefix = worktreePath.endsWith(separator) ? worktreePath : worktreePath + separator
  return `${prefix}${filePath}`
}

/** The file a tab shows, as an absolute path. Null for tabs that show no file. */
export function tabAbsolutePath(tab: TabEntry): string | null {
  if (tab.type === 'file') return tab.path
  if (tab.type === 'diff') return diffTabAbsolutePath(tab)
  return null
}

/**
 * Row paths come from path.join on the backend, which resolves dot segments and
 * repeated separators. Paths joined here keep whatever the worktree path had, and
 * worktrees stored before those paths were canonicalized can still carry a "..".
 *
 * Doing the same lexical work here is the right comparison, because the rows were
 * produced lexically too. This is only for comparing: what a lexically resolved path
 * opens can differ from the original when a ".." crosses a symlink, which is why the
 * path a project is stored under goes through realpath instead. See project-ops.
 *
 * Kept local because the renderer has no path module and also runs in the browser.
 */
function comparableFilePath(path: string, windows: boolean): string {
  // Only Windows can spell a separator two ways: on macOS and Linux a backslash
  // is a normal filename character, so `a\b.ts` and `a/b.ts` differ there.
  const slashed = windows ? path.replace(/\\/g, '/') : path

  // Split off the part ".." must never climb past: the server and share of a UNC
  // path, or a drive letter, which can sit right in front of a relative path as
  // in C:foo. Without this, ".." would eat the root and paths stop matching.
  let root = ''
  let rest = slashed
  if (windows) {
    const unc = slashed.match(/^\/\/[^/]+\/[^/]+/)
    if (unc) {
      root = unc[0]
      rest = slashed.slice(root.length)
    } else if (/^[a-zA-Z]:/.test(slashed)) {
      root = slashed.slice(0, 2)
      rest = slashed.slice(2)
    }
  }

  const absolute = rest.startsWith('/')
  const segments: string[] = []

  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length && segments[segments.length - 1] !== '..') {
        segments.pop()
      } else if (!absolute) {
        // A relative path keeps a leading "..", including a drive relative one like
        // C:..\repo, which path.join keeps too. Only an absolute path drops it,
        // because there is nothing above the root.
        segments.push('..')
      }
      continue
    }
    segments.push(segment)
  }

  const joined = root + (absolute ? '/' : '') + segments.join('/')
  // Windows treats casing as insignificant, including the drive letter. Everywhere
  // else `a.ts` and `A.ts` can be two different files.
  return windows ? joined.toLowerCase() : joined
}

/** Same file? Forgives every spelling difference that means the same path. */
export function isSameFilePath(a: string, b: string): boolean {
  if (a === b) return true
  const windows = isWindows()
  return comparableFilePath(a, windows) === comparableFilePath(b, windows)
}

interface FileViewerState {
  openFiles: Map<string, TabEntry>
  activeFilePath: string | null
  activeDiff: ActiveDiff | null

  dirtyFiles: Set<string>
  originalContents: Map<string, string>
  pendingClose: string | null
  externallyChanged: Set<string>

  contextEditorWorktreeId: string | null
  openContextEditor: (worktreeId: string) => void
  closeContextEditor: () => void
  activateContextEditor: (worktreeId: string) => void

  hasActiveOverlay: () => boolean
  clearActiveViews: () => void

  openFile: (path: string, name: string, worktreeId: string) => void
  closeFile: (path: string) => void
  setActiveFile: (path: string | null) => void
  closeAllFiles: () => void
  setActiveDiff: (diff: ActiveDiff | null) => void
  clearActiveDiff: () => void
  closeDiffTab: (tabKey: string) => void
  activateDiffTab: (tabKey: string) => void
  closeOtherFiles: (keepKey: string) => void
  closeFilesToRight: (fromKey: string) => void

  markDirty: (path: string) => void
  markClean: (path: string) => void
  isDirty: (path: string) => boolean
  setOriginalContent: (path: string, content: string) => void
  getOriginalContent: (path: string) => string | undefined
  requestCloseFile: (path: string) => void
  confirmCloseFile: (path: string) => void
  cancelCloseFile: () => void
  markExternallyChanged: (path: string) => void
  clearExternallyChanged: (path: string) => void
}

export const useFileViewerStore = create<FileViewerState>((set, get) => ({
  openFiles: new Map(),
  activeFilePath: null,
  activeDiff: null,
  dirtyFiles: new Set(),
  originalContents: new Map(),
  pendingClose: null,
  externallyChanged: new Set(),
  contextEditorWorktreeId: null,

  openContextEditor: (worktreeId: string) => {
    set((state) => {
      const tabKey = `context:${worktreeId}`
      const openFiles = new Map(state.openFiles)
      openFiles.set(tabKey, {
        type: 'context',
        worktreeId
      })
      return {
        openFiles,
        activeFilePath: tabKey,
        activeDiff: null,
        contextEditorWorktreeId: worktreeId
      }
    })
  },

  closeContextEditor: () => {
    set((state) => {
      const tabKey = state.contextEditorWorktreeId
        ? `context:${state.contextEditorWorktreeId}`
        : null
      const openFiles = new Map(state.openFiles)
      if (tabKey) openFiles.delete(tabKey)

      let newActivePath = state.activeFilePath
      if (state.activeFilePath === tabKey) {
        const paths = Array.from(openFiles.keys())
        newActivePath = paths.length > 0 ? paths[paths.length - 1] : null
      }

      return {
        openFiles,
        activeFilePath: newActivePath,
        activeDiff: null,
        contextEditorWorktreeId: null
      }
    })
  },

  activateContextEditor: (worktreeId: string) => {
    const tabKey = `context:${worktreeId}`
    set({
      activeFilePath: tabKey,
      activeDiff: null,
      contextEditorWorktreeId: worktreeId
    })
  },

  hasActiveOverlay: () => {
    const s = get()
    return s.activeFilePath !== null || s.activeDiff !== null || s.contextEditorWorktreeId !== null
  },

  clearActiveViews: () => {
    set((state) => {
      // Remove context tab from openFiles if present
      const tabKey = state.contextEditorWorktreeId
        ? `context:${state.contextEditorWorktreeId}`
        : null
      const openFiles = tabKey
        ? (() => { const m = new Map(state.openFiles); m.delete(tabKey); return m })()
        : state.openFiles

      return {
        openFiles,
        activeFilePath: null,
        activeDiff: null,
        contextEditorWorktreeId: null
      }
    })
  },

  openFile: (path: string, name: string, worktreeId: string) => {
    set((state) => {
      const newFiles = new Map(state.openFiles)
      newFiles.set(path, { type: 'file', path, name, worktreeId })
      return { openFiles: newFiles, activeFilePath: path, activeDiff: null }
    })
  },

  closeFile: (path: string) => {
    set((state) => {
      const newFiles = new Map(state.openFiles)
      newFiles.delete(path)

      let newActivePath = state.activeFilePath
      if (state.activeFilePath === path) {
        // Select another file tab or null
        const paths = Array.from(newFiles.keys())
        newActivePath = paths.length > 0 ? paths[paths.length - 1] : null
      }

      return { openFiles: newFiles, activeFilePath: newActivePath }
    })
  },

  setActiveFile: (path: string | null) => {
    set({ activeFilePath: path, activeDiff: null })
  },

  closeAllFiles: () => {
    set({
      openFiles: new Map(),
      activeFilePath: null,
      activeDiff: null,
      contextEditorWorktreeId: null,
      dirtyFiles: new Set(),
      originalContents: new Map(),
      pendingClose: null,
      externallyChanged: new Set()
    })
  },

  setActiveDiff: (diff: ActiveDiff | null) => {
    if (!diff) {
      set({ activeDiff: null })
      return
    }
    const tabKey = diffTabKey(diff)
    set((state) => {
      const openFiles = new Map(state.openFiles)
      openFiles.set(tabKey, {
        type: 'diff',
        worktreePath: diff.worktreePath,
        filePath: diff.filePath,
        fileName: diff.fileName,
        staged: diff.staged,
        isUntracked: diff.isUntracked,
        isNewFile: diff.isNewFile,
        compareBranch: diff.compareBranch,
        prReviewWorktreeId: diff.prReviewWorktreeId
      })
      // Increment scrollTrigger so the scroll effect re-fires even when
      // scrollToLine hasn't changed (e.g. same comment clicked twice)
      const scrollTrigger = diff.scrollToLine != null
        ? (state.activeDiff?.scrollTrigger ?? 0) + 1
        : undefined
      return {
        activeDiff: { ...diff, scrollTrigger },
        activeFilePath: tabKey,
        openFiles
      }
    })
  },

  clearActiveDiff: () => {
    set({ activeDiff: null })
  },

  closeDiffTab: (tabKey: string) => {
    set((state) => {
      const openFiles = new Map(state.openFiles)
      openFiles.delete(tabKey)
      const isActive = state.activeFilePath === tabKey
      return {
        openFiles,
        activeFilePath: isActive ? null : state.activeFilePath,
        activeDiff: isActive ? null : state.activeDiff
      }
    })
  },

  activateDiffTab: (tabKey: string) => {
    set((state) => {
      const tab = state.openFiles.get(tabKey)
      if (!tab || tab.type !== 'diff') return state
      return {
        activeFilePath: tabKey,
        activeDiff: {
          worktreePath: tab.worktreePath,
          filePath: tab.filePath,
          fileName: tab.fileName,
          staged: tab.staged,
          isUntracked: tab.isUntracked,
          isNewFile: tab.isNewFile,
          compareBranch: tab.compareBranch,
          prReviewWorktreeId: tab.prReviewWorktreeId
        }
      }
    })
  },

  closeOtherFiles: (keepKey: string) => {
    set((state) => {
      const newMap = new Map<string, TabEntry>()
      const kept = state.openFiles.get(keepKey)
      if (kept) newMap.set(keepKey, kept)
      // Clean up dirty, original, and externallyChanged for closed files
      const newDirty = new Set(state.dirtyFiles)
      const newOriginal = new Map(state.originalContents)
      const newExtChanged = new Set(state.externallyChanged)
      for (const key of state.openFiles.keys()) {
        if (!newMap.has(key)) {
          newDirty.delete(key)
          newOriginal.delete(key)
          newExtChanged.delete(key)
        }
      }
      // Clear contextEditorWorktreeId if the context tab was closed
      const contextTabKey = state.contextEditorWorktreeId
        ? `context:${state.contextEditorWorktreeId}`
        : null
      const contextStillOpen = contextTabKey ? newMap.has(contextTabKey) : false
      return {
        openFiles: newMap,
        activeFilePath: kept ? keepKey : null,
        activeDiff: kept?.type === 'diff' ? state.activeDiff : null,
        contextEditorWorktreeId: contextStillOpen ? state.contextEditorWorktreeId : null,
        dirtyFiles: newDirty,
        originalContents: newOriginal,
        externallyChanged: newExtChanged
      }
    })
  },

  closeFilesToRight: (fromKey: string) => {
    set((state) => {
      const keys = [...state.openFiles.keys()]
      const index = keys.indexOf(fromKey)
      if (index === -1) return state
      const newMap = new Map<string, TabEntry>()
      for (let i = 0; i <= index; i++) {
        const entry = state.openFiles.get(keys[i])
        if (entry) newMap.set(keys[i], entry)
      }
      // Clean up dirty, original, and externallyChanged for closed files
      const newDirty = new Set(state.dirtyFiles)
      const newOriginal = new Map(state.originalContents)
      const newExtChanged = new Set(state.externallyChanged)
      for (const key of keys.slice(index + 1)) {
        newDirty.delete(key)
        newOriginal.delete(key)
        newExtChanged.delete(key)
      }
      // If active file was to the right and got closed, activate the fromKey
      const activeStillOpen = newMap.has(state.activeFilePath || '')
      // Clear contextEditorWorktreeId if the context tab was closed
      const contextTabKey = state.contextEditorWorktreeId
        ? `context:${state.contextEditorWorktreeId}`
        : null
      const contextStillOpen = contextTabKey ? newMap.has(contextTabKey) : false
      return {
        openFiles: newMap,
        activeFilePath: activeStillOpen ? state.activeFilePath : fromKey,
        contextEditorWorktreeId: contextStillOpen ? state.contextEditorWorktreeId : null,
        dirtyFiles: newDirty,
        originalContents: newOriginal,
        externallyChanged: newExtChanged
      }
    })
  },

  markDirty: (path: string) => {
    set((state) => {
      if (state.dirtyFiles.has(path)) return state
      const newDirty = new Set(state.dirtyFiles)
      newDirty.add(path)
      return { dirtyFiles: newDirty }
    })
  },

  markClean: (path: string) => {
    set((state) => {
      if (!state.dirtyFiles.has(path)) return state
      const newDirty = new Set(state.dirtyFiles)
      newDirty.delete(path)
      return { dirtyFiles: newDirty }
    })
  },

  isDirty: (path: string) => {
    return get().dirtyFiles.has(path)
  },

  setOriginalContent: (path: string, content: string) => {
    set((state) => {
      const newOriginal = new Map(state.originalContents)
      newOriginal.set(path, content)
      return { originalContents: newOriginal }
    })
  },

  getOriginalContent: (path: string) => {
    return get().originalContents.get(path)
  },

  requestCloseFile: (path: string) => {
    const state = get()
    if (state.dirtyFiles.has(path)) {
      // Switch to the dirty tab so the correct FileViewer renders the dialog
      set({ pendingClose: path, activeFilePath: path, activeDiff: null })
    } else {
      get().closeFile(path)
      // Clean up original content and externallyChanged for non-dirty files
      set((s) => {
        const newOriginal = new Map(s.originalContents)
        newOriginal.delete(path)
        const newExtChanged = new Set(s.externallyChanged)
        newExtChanged.delete(path)
        return { originalContents: newOriginal, externallyChanged: newExtChanged }
      })
    }
  },

  confirmCloseFile: (path: string) => {
    set((state) => {
      const newDirty = new Set(state.dirtyFiles)
      newDirty.delete(path)
      const newOriginal = new Map(state.originalContents)
      newOriginal.delete(path)
      const newExtChanged = new Set(state.externallyChanged)
      newExtChanged.delete(path)
      return {
        dirtyFiles: newDirty,
        originalContents: newOriginal,
        pendingClose: null,
        externallyChanged: newExtChanged
      }
    })
    get().closeFile(path)
  },

  cancelCloseFile: () => {
    set({ pendingClose: null })
  },

  markExternallyChanged: (path: string) => {
    set((state) => {
      if (state.externallyChanged.has(path)) return state
      const newSet = new Set(state.externallyChanged)
      newSet.add(path)
      return { externallyChanged: newSet }
    })
  },

  clearExternallyChanged: (path: string) => {
    set((state) => {
      if (!state.externallyChanged.has(path)) return state
      const newSet = new Set(state.externallyChanged)
      newSet.delete(path)
      return { externallyChanged: newSet }
    })
  }
}))
