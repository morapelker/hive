import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { THEME_PRESETS, DEFAULT_THEME_ID, getThemeById, type ThemePreset } from '@/lib/themes'

const THEME_SETTING_KEY = 'selected_theme'

interface ThemeState {
  themeId: string
  isLoading: boolean
  setTheme: (id: string) => void
  getCurrentTheme: () => ThemePreset
  loadFromDatabase: () => Promise<void>
  previewTheme: (id: string) => void
  cancelPreview: () => void
}

// Save theme ID to SQLite database
async function saveThemeToDatabase(themeId: string): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(THEME_SETTING_KEY, themeId)
    }
  } catch (error) {
    console.error('Failed to save theme to database:', error)
  }
}

// Load theme ID from SQLite database
async function loadThemeFromDatabase(): Promise<string | null> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      const value = await window.db.setting.get(THEME_SETTING_KEY)
      if (value && getThemeById(value)) {
        return value
      }
    }
  } catch (error) {
    console.error('Failed to load theme from database:', error)
  }
  return null
}

function applyThemePreset(preset: ThemePreset): void {
  const root = window.document.documentElement

  // Set dark/light class
  root.classList.remove('light', 'dark')
  root.classList.add(preset.type)

  // Apply all CSS custom properties
  for (const [key, value] of Object.entries(preset.colors)) {
    root.style.setProperty(`--${key}`, value)
  }
}

function applyThemeById(themeId: string): void {
  const preset = getThemeById(themeId)
  if (preset) {
    applyThemePreset(preset)
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themeId: DEFAULT_THEME_ID,
      isLoading: true,

      setTheme: (id: string) => {
        const preset = getThemeById(id)
        if (!preset) return
        set({ themeId: id })
        applyThemePreset(preset)
        saveThemeToDatabase(id)
      },

      getCurrentTheme: () => {
        const preset = getThemeById(get().themeId)
        return preset || THEME_PRESETS[0]
      },

      previewTheme: (id: string) => {
        const preset = getThemeById(id)
        if (preset) {
          applyThemePreset(preset)
        }
      },

      cancelPreview: () => {
        applyThemeById(get().themeId)
      },

      loadFromDatabase: async () => {
        const dbThemeId = await loadThemeFromDatabase()
        if (dbThemeId) {
          set({ themeId: dbThemeId, isLoading: false })
          applyThemeById(dbThemeId)
        } else {
          const currentId = get().themeId
          set({ isLoading: false })
          applyThemeById(currentId)
          await saveThemeToDatabase(currentId)
        }
      }
    }),
    {
      name: 'hive-theme',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ themeId: state.themeId }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyThemeById(state.themeId)
        }
      }
    }
  )
)

// Initialize theme immediately to prevent flicker
if (typeof window !== 'undefined') {
  const storedTheme = localStorage.getItem('hive-theme')
  if (storedTheme) {
    try {
      const parsed = JSON.parse(storedTheme)
      if (parsed.state?.themeId) {
        applyThemeById(parsed.state.themeId)
      } else if (parsed.state?.theme) {
        // Migration from old format: map dark/light/system to preset IDs
        const oldTheme = parsed.state.theme
        const newId = oldTheme === 'light' ? 'daylight' : DEFAULT_THEME_ID
        applyThemeById(newId)
      } else {
        applyThemeById(DEFAULT_THEME_ID)
      }
    } catch {
      applyThemeById(DEFAULT_THEME_ID)
    }
  } else {
    applyThemeById(DEFAULT_THEME_ID)
  }

  // Load from database (source of truth) once IPC is ready
  setTimeout(() => {
    useThemeStore.getState().loadFromDatabase()
  }, 100)
}
