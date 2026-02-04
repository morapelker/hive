import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type Theme = 'dark' | 'light' | 'system'

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
  cycleTheme: () => void
  getEffectiveTheme: () => 'dark' | 'light'
}

const getSystemTheme = (): 'dark' | 'light' => {
  if (typeof window !== 'undefined') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'dark'
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'dark',

      setTheme: (theme: Theme) => {
        set({ theme })
        applyTheme(theme)
      },

      cycleTheme: () => {
        const themes: Theme[] = ['dark', 'light', 'system']
        const currentIndex = themes.indexOf(get().theme)
        const nextTheme = themes[(currentIndex + 1) % themes.length]
        set({ theme: nextTheme })
        applyTheme(nextTheme)
      },

      getEffectiveTheme: () => {
        const { theme } = get()
        if (theme === 'system') {
          return getSystemTheme()
        }
        return theme
      },
    }),
    {
      name: 'hive-theme',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ theme: state.theme }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.theme)
        }
      },
    }
  )
)

function applyTheme(theme: Theme): void {
  const root = window.document.documentElement
  root.classList.remove('light', 'dark')

  if (theme === 'system') {
    const systemTheme = getSystemTheme()
    root.classList.add(systemTheme)
  } else {
    root.classList.add(theme)
  }
}

// Initialize theme and listen for system changes
if (typeof window !== 'undefined') {
  // Apply theme on load
  const storedTheme = localStorage.getItem('hive-theme')
  if (storedTheme) {
    try {
      const parsed = JSON.parse(storedTheme)
      if (parsed.state?.theme) {
        applyTheme(parsed.state.theme)
      }
    } catch {
      applyTheme('dark')
    }
  } else {
    applyTheme('dark')
  }

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const state = useThemeStore.getState()
    if (state.theme === 'system') {
      applyTheme('system')
    }
  })
}
