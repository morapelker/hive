import { create } from 'zustand'
import type { HintTarget } from '@/lib/hint-utils'

export type HintMode = 'idle' | 'pending'
export type HintActionMode = 'select' | 'pin' | 'archive'

export type { HintTarget }

interface HintStoreState {
  hintMap: Map<string, string>
  hintTargetMap: Map<string, HintTarget>
  sessionHintMap: Map<string, string>
  sessionHintTargetMap: Map<string, string>
  mode: HintMode
  pendingChar: string | null
  actionMode: HintActionMode
  filterActive: boolean
  inputFocused: boolean

  setHints: (map: Map<string, string>, targetMap: Map<string, HintTarget>) => void
  clearHints: () => void
  setSessionHints: (map: Map<string, string>, targetMap: Map<string, string>) => void
  clearSessionHints: () => void
  enterPending: (char: string) => void
  exitPending: () => void
  setActionMode: (mode: HintActionMode) => void
  setFilterActive: (active: boolean) => void
  setInputFocused: (focused: boolean) => void
}

export const useHintStore = create<HintStoreState>()((set) => ({
  hintMap: new Map(),
  hintTargetMap: new Map(),
  sessionHintMap: new Map(),
  sessionHintTargetMap: new Map(),
  mode: 'idle',
  pendingChar: null,
  actionMode: 'select',
  filterActive: false,
  inputFocused: false,

  setHints: (map, targetMap) => set({ hintMap: map, hintTargetMap: targetMap }),
  clearHints: () =>
    set({
      hintMap: new Map(),
      hintTargetMap: new Map(),
      sessionHintMap: new Map(),
      sessionHintTargetMap: new Map(),
      mode: 'idle',
      pendingChar: null,
      actionMode: 'select'
    }),
  setSessionHints: (map, targetMap) =>
    set({ sessionHintMap: map, sessionHintTargetMap: targetMap }),
  clearSessionHints: () => set({ sessionHintMap: new Map(), sessionHintTargetMap: new Map() }),
  enterPending: (char) => set({ mode: 'pending', pendingChar: char, actionMode: 'select' }),
  exitPending: () => set({ mode: 'idle', pendingChar: null, actionMode: 'select' }),
  setActionMode: (mode) => set({ actionMode: mode }),
  setFilterActive: (active) => set({ filterActive: active }),
  setInputFocused: (focused) => set({ inputFocused: focused })
}))
