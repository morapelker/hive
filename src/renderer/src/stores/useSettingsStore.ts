import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// ==========================================
// Types
// ==========================================

export type EditorOption = 'vscode' | 'cursor' | 'sublime' | 'webstorm' | 'zed' | 'custom'
export type TerminalOption = 'terminal' | 'iterm' | 'warp' | 'alacritty' | 'kitty' | 'custom'

export interface SelectedModel {
  providerID: string
  modelID: string
  variant?: string
}

export type QuickActionType = 'cursor' | 'ghostty' | 'copy-path' | 'finder'

export interface AppSettings {
  // General
  autoStartSession: boolean

  // Editor
  defaultEditor: EditorOption
  customEditorCommand: string

  // Terminal
  defaultTerminal: TerminalOption
  customTerminalCommand: string

  // Git
  commitTemplate: string
  autoFetchInterval: number // 0 = disabled, otherwise minutes

  // Model
  selectedModel: SelectedModel | null

  // Quick Actions
  lastOpenAction: QuickActionType | null

  // Chrome
  customChromeCommand: string // Custom chrome launch command, e.g. "open -a Chrome {url}"
}

const DEFAULT_SETTINGS: AppSettings = {
  autoStartSession: true,
  defaultEditor: 'vscode',
  customEditorCommand: '',
  defaultTerminal: 'terminal',
  customTerminalCommand: '',
  commitTemplate: '',
  autoFetchInterval: 0,
  selectedModel: null,
  lastOpenAction: null,
  customChromeCommand: ''
}

const SETTINGS_DB_KEY = 'app_settings'

interface SettingsState extends AppSettings {
  isOpen: boolean
  activeSection: string
  isLoading: boolean

  // Actions
  openSettings: (section?: string) => void
  closeSettings: () => void
  setActiveSection: (section: string) => void
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  setSelectedModel: (model: SelectedModel) => Promise<void>
  resetToDefaults: () => void
  loadFromDatabase: () => Promise<void>
}

async function saveToDatabase(settings: AppSettings): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(SETTINGS_DB_KEY, JSON.stringify(settings))
    }
  } catch (error) {
    console.error('Failed to save settings to database:', error)
  }
}

async function loadSettingsFromDatabase(): Promise<AppSettings | null> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      const value = await window.db.setting.get(SETTINGS_DB_KEY)
      if (value) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(value) }
      }
    }
  } catch (error) {
    console.error('Failed to load settings from database:', error)
  }
  return null
}

function extractSettings(state: SettingsState): AppSettings {
  return {
    autoStartSession: state.autoStartSession,
    defaultEditor: state.defaultEditor,
    customEditorCommand: state.customEditorCommand,
    defaultTerminal: state.defaultTerminal,
    customTerminalCommand: state.customTerminalCommand,
    commitTemplate: state.commitTemplate,
    autoFetchInterval: state.autoFetchInterval,
    selectedModel: state.selectedModel,
    lastOpenAction: state.lastOpenAction,
    customChromeCommand: state.customChromeCommand
  }
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Default values
      ...DEFAULT_SETTINGS,
      isOpen: false,
      activeSection: 'appearance',
      isLoading: true,

      openSettings: (section?: string) => {
        set({ isOpen: true, activeSection: section || get().activeSection })
      },

      closeSettings: () => {
        set({ isOpen: false })
      },

      setActiveSection: (section: string) => {
        set({ activeSection: section })
      },

      updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
        set({ [key]: value } as Partial<SettingsState>)
        // Persist to database
        const settings = extractSettings({ ...get(), [key]: value } as SettingsState)
        saveToDatabase(settings)
      },

      setSelectedModel: async (model: SelectedModel) => {
        set({ selectedModel: model })
        // Persist to backend (settings DB + opencode service)
        try {
          await window.opencodeOps.setModel(model)
        } catch (error) {
          console.error('Failed to persist model selection:', error)
        }
        // Also save in app settings
        const settings = extractSettings({ ...get(), selectedModel: model } as SettingsState)
        saveToDatabase(settings)
      },

      resetToDefaults: () => {
        set({ ...DEFAULT_SETTINGS })
        saveToDatabase(DEFAULT_SETTINGS)
      },

      loadFromDatabase: async () => {
        const dbSettings = await loadSettingsFromDatabase()
        if (dbSettings) {
          set({ ...dbSettings, isLoading: false })
        } else {
          set({ isLoading: false })
          await saveToDatabase(extractSettings(get()))
        }
      }
    }),
    {
      name: 'hive-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        autoStartSession: state.autoStartSession,
        defaultEditor: state.defaultEditor,
        customEditorCommand: state.customEditorCommand,
        defaultTerminal: state.defaultTerminal,
        customTerminalCommand: state.customTerminalCommand,
        commitTemplate: state.commitTemplate,
        autoFetchInterval: state.autoFetchInterval,
        selectedModel: state.selectedModel,
        lastOpenAction: state.lastOpenAction,
        customChromeCommand: state.customChromeCommand,
        activeSection: state.activeSection
      })
    }
  )
)

// Load from database on startup
if (typeof window !== 'undefined') {
  setTimeout(() => {
    useSettingsStore.getState().loadFromDatabase()
  }, 200)
}
