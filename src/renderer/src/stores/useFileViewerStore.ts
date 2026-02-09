import { create } from 'zustand'

export interface FileViewerTab {
  path: string
  name: string
  worktreeId: string
}

export interface ActiveDiff {
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
}

interface FileViewerState {
  openFiles: Map<string, FileViewerTab>
  activeFilePath: string | null
  activeDiff: ActiveDiff | null

  openFile: (path: string, name: string, worktreeId: string) => void
  closeFile: (path: string) => void
  setActiveFile: (path: string | null) => void
  closeAllFiles: () => void
  setActiveDiff: (diff: ActiveDiff | null) => void
  clearActiveDiff: () => void
}

export const useFileViewerStore = create<FileViewerState>((set) => ({
  openFiles: new Map(),
  activeFilePath: null,
  activeDiff: null,

  openFile: (path: string, name: string, worktreeId: string) => {
    set((state) => {
      const newFiles = new Map(state.openFiles)
      newFiles.set(path, { path, name, worktreeId })
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
    set({ activeDiff: diff, activeFilePath: null })
  },

  clearActiveDiff: () => {
    set({ activeDiff: null })
  }
}))
