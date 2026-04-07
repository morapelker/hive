import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

const THEME_SETTING_KEY = 'selected_theme'

const DARK_PRESET_IDS = new Set([
  'amethyst',
  'obsidian',
  'midnight-blue',
  'emerald-night',
  'crimson',
  'sunset'
])
const LIGHT_PRESET_IDS = new Set(['daylight', 'cloud', 'mint', 'rose'])

export type Mode = 'dark' | 'light'

interface ThemeState {
  mode: Mode
  setMode: (mode: Mode) => void
  toggleMode: () => void
  loadFromDatabase: () => Promise<void>
}

function mapLegacyIdToMode(id: string): Mode {
  if (LIGHT_PRESET_IDS.has(id)) return 'light'
  return 'dark'
}

function applyMode(mode: Mode): void {
  const root = window.document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(mode)
}

async function saveModeToDatabase(mode: Mode): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(THEME_SETTING_KEY, mode)
    }
  } catch (error) {
    console.error('Failed to save theme mode to database:', error)
  }
}

async function loadModeFromDatabase(): Promise<Mode | null> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      const value = await window.db.setting.get(THEME_SETTING_KEY)
      if (value === 'dark' || value === 'light') {
        return value
      }
      // Migrate old preset ID to mode
      if (value && (DARK_PRESET_IDS.has(value) || LIGHT_PRESET_IDS.has(value))) {
        return mapLegacyIdToMode(value)
      }
    }
  } catch (error) {
    console.error('Failed to load theme mode from database:', error)
  }
  return null
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'dark' as Mode,

      setMode: (mode: Mode) => {
        set({ mode })
        applyMode(mode)
        saveModeToDatabase(mode)
      },

      toggleMode: () => {
        const next = get().mode === 'dark' ? 'light' : 'dark'
        get().setMode(next)
      },

      loadFromDatabase: async () => {
        const dbMode = await loadModeFromDatabase()
        if (dbMode) {
          set({ mode: dbMode })
          applyMode(dbMode)
          await saveModeToDatabase(dbMode)
        } else {
          const currentMode = get().mode
          applyMode(currentMode)
          await saveModeToDatabase(currentMode)
        }
      }
    }),
    {
      name: 'hive-theme',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      migrate: (persisted: unknown, version: number) => {
        if (version === 0) {
          const old = persisted as { themeId?: string }
          return { mode: old?.themeId ? mapLegacyIdToMode(old.themeId) : 'dark' }
        }
        return persisted as { mode: Mode }
      },
      partialize: (state) => ({ mode: state.mode }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyMode(state.mode)
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
      if (parsed.state?.mode === 'dark' || parsed.state?.mode === 'light') {
        // New format — apply directly
        applyMode(parsed.state.mode)
      } else if (parsed.state?.themeId) {
        // Migrate from old preset-based format
        applyMode(mapLegacyIdToMode(parsed.state.themeId))
      } else if (parsed.state?.theme) {
        // Migrate from even older dark/light/system format
        applyMode(parsed.state.theme === 'light' ? 'light' : 'dark')
      } else {
        applyMode('dark')
      }
    } catch {
      applyMode('dark')
    }
  } else {
    applyMode('dark')
  }

  // Load from database (source of truth) once IPC is ready
  setTimeout(() => {
    useThemeStore.getState().loadFromDatabase()
  }, 100)
}
