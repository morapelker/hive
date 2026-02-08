import { create } from 'zustand'

export interface FileViewerTab {
  path: string
  name: string
  worktreeId: string
}

interface FileViewerState {
  openFiles: Map<string, FileViewerTab>
  activeFilePath: string | null

  openFile: (path: string, name: string, worktreeId: string) => void
  closeFile: (path: string) => void
  setActiveFile: (path: string | null) => void
  closeAllFiles: () => void
}

export const useFileViewerStore = create<FileViewerState>((set) => ({
  openFiles: new Map(),
  activeFilePath: null,

  openFile: (path: string, name: string, worktreeId: string) => {
    set((state) => {
      const newFiles = new Map(state.openFiles)
      newFiles.set(path, { path, name, worktreeId })
      return { openFiles: newFiles, activeFilePath: path }
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
    set({ activeFilePath: path })
  },

  closeAllFiles: () => {
    set({ openFiles: new Map(), activeFilePath: null })
  }
}))
