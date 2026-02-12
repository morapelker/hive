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
}

export type TabEntry = FileViewerTab | DiffTab

export interface ActiveDiff {
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
}

interface FileViewerState {
  openFiles: Map<string, TabEntry>
  activeFilePath: string | null
  activeDiff: ActiveDiff | null

  openFile: (path: string, name: string, worktreeId: string) => void
  closeFile: (path: string) => void
  setActiveFile: (path: string | null) => void
  closeAllFiles: () => void
  setActiveDiff: (diff: ActiveDiff | null) => void
  clearActiveDiff: () => void
  closeDiffTab: (tabKey: string) => void
  activateDiffTab: (tabKey: string) => void
}

export const useFileViewerStore = create<FileViewerState>((set) => ({
  openFiles: new Map(),
  activeFilePath: null,
  activeDiff: null,

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
        isUntracked: diff.isUntracked
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
          isUntracked: tab.isUntracked
        }
      }
    })
  }
}))
