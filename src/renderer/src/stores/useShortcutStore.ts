import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  type KeyBinding,
  DEFAULT_SHORTCUTS,
  detectConflicts,
  formatBinding,
  resolveEffectiveBinding,
  withoutRemovedShortcuts
} from '@/lib/keyboard-shortcuts'
import { dbApi } from '@/api/db-api'

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
  /** `null` when the action has no key: the user gave its default key to another action. */
  getEffectiveBinding: (shortcutId: string) => KeyBinding | null
  /** Every action that has a key. Actions without one are left out. */
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

      getEffectiveBinding: (shortcutId: string) =>
        resolveEffectiveBinding(shortcutId, get().customBindings),

      getAllEffectiveBindings: () => {
        const bindings = new Map<string, KeyBinding>()
        const custom = get().customBindings

        for (const shortcut of DEFAULT_SHORTCUTS) {
          const binding = resolveEffectiveBinding(shortcut.id, custom)
          if (binding) bindings.set(shortcut.id, binding)
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
          if (typeof window !== 'undefined') {
            const value = await dbApi.setting.get(SHORTCUTS_SETTING_KEY)
            if (value) {
              const parsed = JSON.parse(value) as Record<string, KeyBinding>
              // A key saved for an action that is no longer a shortcut is dropped, here and
              // in the database.
              const bindings = withoutRemovedShortcuts(parsed)
              set({ customBindings: bindings })
              if (bindings !== parsed) saveToDatabase(bindings)
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
      // Version 1: "Filter Projects" (nav:filter-projects) is no longer a shortcut. A key
      // saved for it is dropped from the stored copy too.
      version: 1,
      migrate: (persisted) => {
        const stored = (persisted as { customBindings?: Record<string, KeyBinding> } | null)
          ?.customBindings
        return { customBindings: withoutRemovedShortcuts(stored ?? {}) }
      },
      partialize: (state) => ({
        customBindings: state.customBindings
      })
    }
  )
)

// Save to SQLite database (async, non-blocking)
async function saveToDatabase(bindings: Record<string, KeyBinding>): Promise<void> {
  try {
    if (typeof window !== 'undefined') {
      await dbApi.setting.set(SHORTCUTS_SETTING_KEY, JSON.stringify(bindings))
    }
  } catch (error) {
    console.error('Failed to save shortcuts to database:', error)
  }
}

// Load from database on startup
if (typeof window !== 'undefined') {
  setTimeout(() => {
    if (typeof window === 'undefined') return
    useShortcutStore.getState().loadFromDatabase()
  }, 150)
}
