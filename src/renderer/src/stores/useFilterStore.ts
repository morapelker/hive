import { create } from 'zustand'

// --- Colon-command registry ---

export interface ColonCommand {
  name: string
  displayName: string
  getOptions: (projects: { language: string | null }[]) => string[]
}

export const COLON_COMMANDS: ColonCommand[] = [
  {
    name: 'lang',
    displayName: ':lang',
    getOptions: (projects) => {
      const langs = new Set<string>()
      for (const p of projects) if (p.language) langs.add(p.language)
      return [...langs]
    }
  }
]

// --- Filter store ---

interface FilterState {
  activeLanguages: string[]
  /** Live input value — updates on every keystroke, drives the search field. */
  filterQuery: string
  /** Trailing-debounced copy of filterQuery — drives project filtering so
      typing doesn't re-filter the whole sidebar on every letter. */
  debouncedFilterQuery: string
  addLanguage: (lang: string) => void
  removeLanguage: (lang: string) => void
  setFilterQuery: (query: string) => void
  clearAll: () => void
}

export const FILTER_DEBOUNCE_MS = 150

let filterDebounceTimer: ReturnType<typeof setTimeout> | null = null

export const useFilterStore = create<FilterState>()((set) => ({
  activeLanguages: [],
  filterQuery: '',
  debouncedFilterQuery: '',
  addLanguage: (lang) =>
    set((state) => ({
      activeLanguages: state.activeLanguages.includes(lang)
        ? state.activeLanguages
        : [...state.activeLanguages, lang]
    })),
  removeLanguage: (lang) =>
    set((state) => ({
      activeLanguages: state.activeLanguages.filter((l) => l !== lang)
    })),
  setFilterQuery: (query) => {
    if (filterDebounceTimer !== null) clearTimeout(filterDebounceTimer)
    // Clearing must feel instant (Escape / clear button restores the full list).
    if (!query) {
      filterDebounceTimer = null
      set({ filterQuery: '', debouncedFilterQuery: '' })
      return
    }
    set({ filterQuery: query })
    filterDebounceTimer = setTimeout(() => {
      filterDebounceTimer = null
      set({ debouncedFilterQuery: query })
    }, FILTER_DEBOUNCE_MS)
  },
  clearAll: () => {
    if (filterDebounceTimer !== null) {
      clearTimeout(filterDebounceTimer)
      filterDebounceTimer = null
    }
    set({ activeLanguages: [], filterQuery: '', debouncedFilterQuery: '' })
  }
}))
