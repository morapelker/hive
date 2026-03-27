import { create } from 'zustand'

export type VimMode = 'normal' | 'insert'

interface VimModeState {
  mode: VimMode
  helpOverlayOpen: boolean
  enterInsertMode: () => void
  enterNormalMode: () => void
  toggleHelpOverlay: () => void
  setHelpOverlayOpen: (open: boolean) => void
}

export const useVimModeStore = create<VimModeState>()((set) => ({
  mode: 'normal',
  helpOverlayOpen: false,
  enterInsertMode: () => set({ mode: 'insert' }),
  enterNormalMode: () => {
    ;(document.activeElement as HTMLElement)?.blur?.()
    set({ mode: 'normal' })
  },
  toggleHelpOverlay: () => set((s) => ({ helpOverlayOpen: !s.helpOverlayOpen })),
  setHelpOverlayOpen: (open) => set({ helpOverlayOpen: open })
}))
