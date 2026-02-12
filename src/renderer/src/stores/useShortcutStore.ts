import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  type KeyBinding,
  DEFAULT_SHORTCUTS,
  detectConflicts,
  formatBinding
} from '@/lib/keyboard-shortcuts'

const SHORTCUTS_SETTING_KEY = 'keyboard_shortcuts'

interface ShortcutState {
  // Custom bindings - keyed by shortcut ID
  customBindings: Record<string, KeyBinding>

  // Actions
  setCustomBinding: (
    shortcutId: string,
    binding: KeyBinding
  ) => { success: boolean; conflicts?: string[] }
  removeCustomBinding: (shortcutId: string) => void
  resetToDefaults: () => void
  getEffectiveBinding: (shortcutId: string) => KeyBinding | null
  getAllEffectiveBindings: () => Map<string, KeyBinding>
  getConflicts: (shortcutId: string, binding: KeyBinding) => string[]
  getDisplayString: (shortcutId: string) => string
  loadFromDatabase: () => Promise<void>
}

export const useShortcutStore = create<ShortcutState>()(
  persist(
    (set, get) => ({
      customBindings: {},

      setCustomBinding: (shortcutId: string, binding: KeyBinding) => {
        const allBindings = get().getAllEffectiveBindings()
        const conflicts = detectConflicts(binding, allBindings, shortcutId)

        if (conflicts.length > 0) {
          return { success: false, conflicts }
        }

        set((state) => {
          const newBindings = { ...state.customBindings, [shortcutId]: binding }
          // Persist to database async
          saveToDatabase(newBindings)
          return { customBindings: newBindings }
        })

        return { success: true }
      },

      removeCustomBinding: (shortcutId: string) => {
        set((state) => {
          const newBindings = { ...state.customBindings }
          delete newBindings[shortcutId]
          saveToDatabase(newBindings)
          return { customBindings: newBindings }
        })
      },

      resetToDefaults: () => {
        set({ customBindings: {} })
        saveToDatabase({})
      },

      getEffectiveBinding: (shortcutId: string) => {
        const custom = get().customBindings[shortcutId]
        if (custom) return custom

        const defaultShortcut = DEFAULT_SHORTCUTS.find((s) => s.id === shortcutId)
        return defaultShortcut?.defaultBinding ?? null
      },

      getAllEffectiveBindings: () => {
        const bindings = new Map<string, KeyBinding>()
        const custom = get().customBindings

        for (const shortcut of DEFAULT_SHORTCUTS) {
          bindings.set(shortcut.id, custom[shortcut.id] ?? shortcut.defaultBinding)
        }

        return bindings
      },

      getConflicts: (shortcutId: string, binding: KeyBinding) => {
        const allBindings = get().getAllEffectiveBindings()
        return detectConflicts(binding, allBindings, shortcutId)
      },

      getDisplayString: (shortcutId: string) => {
        const binding = get().getEffectiveBinding(shortcutId)
        if (!binding) return ''
        return formatBinding(binding)
      },

      loadFromDatabase: async () => {
        try {
          if (typeof window !== 'undefined' && window.db?.setting) {
            const value = await window.db.setting.get(SHORTCUTS_SETTING_KEY)
            if (value) {
              const parsed = JSON.parse(value) as Record<string, KeyBinding>
              set({ customBindings: parsed })
            }
          }
        } catch (error) {
          console.error('Failed to load shortcuts from database:', error)
        }
      }
    }),
    {
      name: 'hive-shortcuts',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        customBindings: state.customBindings
      })
    }
  )
)

// Save to SQLite database (async, non-blocking)
async function saveToDatabase(bindings: Record<string, KeyBinding>): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(SHORTCUTS_SETTING_KEY, JSON.stringify(bindings))
    }
  } catch (error) {
    console.error('Failed to save shortcuts to database:', error)
  }
}

// Load from database on startup
if (typeof window !== 'undefined') {
  setTimeout(() => {
    useShortcutStore.getState().loadFromDatabase()
  }, 150)
}
