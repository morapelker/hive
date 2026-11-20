import { create } from 'zustand'
import type { MergedChildrenTarget } from '@/lib/document-flow/run-merged-children'

interface RunMergedChildrenState {
  /** The run whose "Move merged tickets to Done" dialog is open; null when none is. */
  target: MergedChildrenTarget | null
  open: (target: MergedChildrenTarget) => void
  close: () => void
}

/**
 * The board-level dialog a run ticket's context menu opens (RunMergedChildrenDialog). The menu
 * is gone by the time the dialog shows, so the dialog is the board's and this is what opens it.
 */
export const useRunMergedChildrenStore = create<RunMergedChildrenState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set((state) => (state.target === null ? state : { target: null }))
}))
