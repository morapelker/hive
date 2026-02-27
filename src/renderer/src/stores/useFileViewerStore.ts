import { create } from 'zustand'

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
}

export interface ContextTab {
  type: 'context'
  worktreeId: string
  worktreeName: string
}

export type TabEntry = FileViewerTab | DiffTab | ContextTab

export interface ActiveDiff {
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
  isNewFile?: boolean
}

interface FileViewerState {
  openFiles: Map<string, TabEntry>
  activeFilePath: string | null
  activeDiff: ActiveDiff | null

  contextEditorWorktreeId: string | null
  openContextEditor: (worktreeId: string) => void
  closeContextEditor: () => void
  activateContextEditor: (worktreeId: string) => void

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
}

export const useFileViewerStore = create<FileViewerState>((set) => ({
  openFiles: new Map(),
  activeFilePath: null,
  activeDiff: null,
  contextEditorWorktreeId: null,

  openContextEditor: (worktreeId: string) => {
    set((state) => {
      const tabKey = `context:${worktreeId}`
      const openFiles = new Map(state.openFiles)
      openFiles.set(tabKey, {
        type: 'context',
        worktreeId,
        worktreeName: '' // Will be resolved by the tab component
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
    set({ openFiles: new Map(), activeFilePath: null, activeDiff: null })
  },

  setActiveDiff: (diff: ActiveDiff | null) => {
    if (!diff) {
      set({ activeDiff: null })
      return
    }
    const tabKey = `diff:${diff.filePath}:${diff.staged ? 'staged' : 'unstaged'}`
    set((state) => {
      const openFiles = new Map(state.openFiles)
      openFiles.set(tabKey, {
        type: 'diff',
        worktreePath: diff.worktreePath,
        filePath: diff.filePath,
        fileName: diff.fileName,
        staged: diff.staged,
        isUntracked: diff.isUntracked,
        isNewFile: diff.isNewFile
      })
      return { activeDiff: diff, activeFilePath: tabKey, openFiles }
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
          isNewFile: tab.isNewFile
        }
      }
    })
  },

  closeOtherFiles: (keepKey: string) => {
    set((state) => {
      const newMap = new Map<string, TabEntry>()
      const kept = state.openFiles.get(keepKey)
      if (kept) newMap.set(keepKey, kept)
      return {
        openFiles: newMap,
        activeFilePath: kept ? keepKey : null,
        activeDiff: kept?.type === 'diff' ? state.activeDiff : null
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
      // If active file was to the right and got closed, activate the fromKey
      const activeStillOpen = newMap.has(state.activeFilePath || '')
      return {
        openFiles: newMap,
        activeFilePath: activeStillOpen ? state.activeFilePath : fromKey
      }
    })
  }
}))
