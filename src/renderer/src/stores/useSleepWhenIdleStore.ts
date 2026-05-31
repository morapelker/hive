import { create } from 'zustand'

interface SleepWhenIdleState {
  armed: boolean
  arm: () => void
  disarm: () => void
  toggle: () => void
}

export const useSleepWhenIdleStore = create<SleepWhenIdleState>((set) => ({
  armed: false,
  arm: () => set({ armed: true }),
  disarm: () => set({ armed: false }),
  toggle: () => set((state) => ({ armed: !state.armed }))
}))
