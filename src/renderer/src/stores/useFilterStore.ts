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
  addLanguage: (lang: string) => void
  removeLanguage: (lang: string) => void
  clearAll: () => void
}

export const useFilterStore = create<FilterState>()((set) => ({
  activeLanguages: [],
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
  clearAll: () => set({ activeLanguages: [] })
}))
