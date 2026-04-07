import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  THEME_PRESETS,
  THEME_CSS_PROPERTIES,
  DEFAULT_THEME_ID,
  getThemeById
} from '@/lib/themes'
import type { ThemePreset } from '@/lib/themes'

const THEME_SETTING_KEY = 'selected_theme'
const STORAGE_KEY = 'hive-theme'

// ---------------------------------------------------------------------------
// Two-path CSS dispatcher
// ---------------------------------------------------------------------------

function applyThemePreset(preset: ThemePreset): void {
  const root = document.documentElement

  // Always clear previous inline overrides first
  for (const prop of THEME_CSS_PROPERTIES) {
    root.style.removeProperty(`--${prop}`)
  }

  // Toggle dark/light class
  root.classList.remove('light', 'dark')
  root.classList.add(preset.type)

  // For non-native presets, set inline CSS overrides
  if (!preset.cssNative) {
    for (const [key, value] of Object.entries(preset.colors)) {
      root.style.setProperty(`--${key}`, value)
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy helpers
// ---------------------------------------------------------------------------

/** Set of all known preset IDs for quick lookup */
const KNOWN_PRESET_IDS = new Set(THEME_PRESETS.map((p) => p.id))

/**
 * Resolve any legacy or current value to a valid preset ID.
 * - 'dark'  / 'light' (Glass-only era DB values or v1 mode) → glass-dark / glass-light
 * - known preset id → keep as-is
 * - unknown → DEFAULT_THEME_ID
 */
function resolveThemeId(value: string | undefined | null): string {
  if (!value) return DEFAULT_THEME_ID
  if (value === 'dark') return 'glass-dark'
  if (value === 'light') return 'glass-light'
  if (KNOWN_PRESET_IDS.has(value)) return value
  return DEFAULT_THEME_ID
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

async function saveThemeToDatabase(themeId: string): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(THEME_SETTING_KEY, themeId)
    }
  } catch (error) {
    console.error('Failed to save theme to database:', error)
  }
}

async function loadThemeFromDatabase(): Promise<string | null> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      const value = await window.db.setting.get(THEME_SETTING_KEY)
      if (typeof value === 'string' && value.length > 0) {
        return value
      }
    }
  } catch (error) {
    console.error('Failed to load theme from database:', error)
  }
  return null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ThemeState {
  themeId: string
  setTheme: (id: string) => void
  getCurrentTheme: () => ThemePreset | undefined
  loadFromDatabase: () => Promise<void>
  previewTheme: (id: string) => void
  cancelPreview: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themeId: DEFAULT_THEME_ID,

      setTheme: (id: string) => {
        const resolved = resolveThemeId(id)
        const preset = getThemeById(resolved)
        if (preset) {
          set({ themeId: resolved })
          applyThemePreset(preset)
          saveThemeToDatabase(resolved)
        }
      },

      getCurrentTheme: () => {
        return getThemeById(get().themeId)
      },

      loadFromDatabase: async () => {
        const dbValue = await loadThemeFromDatabase()
        const resolved = resolveThemeId(dbValue)
        const preset = getThemeById(resolved)

        if (preset) {
          set({ themeId: resolved })
          applyThemePreset(preset)
        }

        // Write back the (possibly corrected) ID to DB
        await saveThemeToDatabase(resolved)
      },

      previewTheme: (id: string) => {
        const preset = getThemeById(id)
        if (preset) {
          // Apply visually only — do NOT persist via set() or DB
          applyThemePreset(preset)
        }
      },

      cancelPreview: () => {
        // Restore the persisted theme
        const preset = getThemeById(get().themeId)
        if (preset) {
          applyThemePreset(preset)
        }
      }
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 2,
      migrate: (persisted: unknown, version: number) => {
        const old = persisted as Record<string, unknown>

        if (version === 0) {
          // v0 had two shapes:
          // 1. { themeId: 'amethyst' } — preset-based
          // 2. { theme: 'light' | 'dark' } — even older
          if (old?.themeId && typeof old.themeId === 'string') {
            return { themeId: resolveThemeId(old.themeId as string) }
          }
          if (old?.theme && typeof old.theme === 'string') {
            return { themeId: resolveThemeId(old.theme as string) }
          }
          return { themeId: DEFAULT_THEME_ID }
        }

        if (version === 1) {
          // v1 stored { mode: 'dark' | 'light' }
          const mode = old?.mode as string | undefined
          return { themeId: resolveThemeId(mode) }
        }

        return persisted as { themeId: string }
      },
      partialize: (state) => ({ themeId: state.themeId }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          const preset = getThemeById(state.themeId)
          if (preset) {
            applyThemePreset(preset)
          }
        }
      }
    }
  )
)

// ---------------------------------------------------------------------------
// Early init — apply theme before React hydration to prevent flash
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  let themeId = DEFAULT_THEME_ID

  const storedTheme = localStorage.getItem(STORAGE_KEY)
  if (storedTheme) {
    try {
      const parsed = JSON.parse(storedTheme)

      if (parsed.state?.themeId && typeof parsed.state.themeId === 'string') {
        // Current v2 format
        themeId = resolveThemeId(parsed.state.themeId)
      } else if (parsed.state?.mode && typeof parsed.state.mode === 'string') {
        // v1 format: { mode: 'dark' | 'light' }
        themeId = resolveThemeId(parsed.state.mode)
      } else if (parsed.state?.theme && typeof parsed.state.theme === 'string') {
        // v0 format: { theme: 'light' | 'dark' }
        themeId = resolveThemeId(parsed.state.theme)
      }
    } catch {
      // Corrupted JSON — fall through to default
    }
  }

  const preset = getThemeById(themeId)
  if (preset) {
    applyThemePreset(preset)
  } else {
    // Fallback: just set dark class
    document.documentElement.classList.add('dark')
  }

  // Load from database (source of truth) once IPC is ready
  setTimeout(() => {
    useThemeStore.getState().loadFromDatabase()
  }, 100)
}
