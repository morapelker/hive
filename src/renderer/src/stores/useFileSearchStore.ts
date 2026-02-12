import { create } from 'zustand'

interface FileSearchState {
  isOpen: boolean
  searchQuery: string
  selectedIndex: number
  open: () => void
  close: () => void
  toggle: () => void
  setSearchQuery: (query: string) => void
  setSelectedIndex: (index: number) => void
  moveSelection: (direction: 'up' | 'down', maxIndex: number) => void
}

export const useFileSearchStore = create<FileSearchState>((set) => ({
  isOpen: false,
  searchQuery: '',
  selectedIndex: 0,
  open: () => set({ isOpen: true, searchQuery: '', selectedIndex: 0 }),
  close: () => set({ isOpen: false, searchQuery: '', selectedIndex: 0 }),
  toggle: () =>
    set((state) =>
      state.isOpen
        ? { isOpen: false, searchQuery: '', selectedIndex: 0 }
        : { isOpen: true, searchQuery: '', selectedIndex: 0 }
    ),
  setSearchQuery: (query) => set({ searchQuery: query, selectedIndex: 0 }),
  setSelectedIndex: (index) => set({ selectedIndex: index }),
  moveSelection: (direction, maxIndex) =>
    set((state) => ({
      selectedIndex:
        direction === 'up'
          ? Math.max(0, state.selectedIndex - 1)
          : Math.min(maxIndex, state.selectedIndex + 1)
    }))
}))
