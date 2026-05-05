import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type DiffViewMode = 'split' | 'inline' | 'hunk'

interface DiffPrefsState {
  viewMode: DiffViewMode
  setViewMode: (viewMode: DiffViewMode) => void
}

export const useDiffPrefsStore = create<DiffPrefsState>()(
  persist(
    (set) => ({
      viewMode: 'split',
      setViewMode: (viewMode) => set({ viewMode })
    }),
    {
      name: 'hive-diff-prefs',
      storage: createJSONStorage(() => localStorage),
      version: 1
    }
  )
)
