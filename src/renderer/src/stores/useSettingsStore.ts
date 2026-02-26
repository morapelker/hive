import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// ==========================================
// Types
// ==========================================

export type EditorOption = 'vscode' | 'cursor' | 'sublime' | 'webstorm' | 'zed' | 'custom'
export type TerminalOption =
  | 'terminal'
  | 'iterm'
  | 'warp'
  | 'alacritty'
  | 'kitty'
  | 'ghostty'
  | 'custom'
export type EmbeddedTerminalBackend = 'xterm' | 'ghostty'

export interface SelectedModel {
  providerID: string
  modelID: string
  variant?: string
}

export type QuickActionType = 'cursor' | 'terminal' | 'copy-path' | 'finder'

export interface CommandFilterSettings {
  allowlist: string[]
  blocklist: string[]
  defaultBehavior: 'ask' | 'allow' | 'block'
  enabled: boolean
}

export interface AppSettings {
  // General
  autoStartSession: boolean
  breedType: 'dogs' | 'cats'

  // Editor
  defaultEditor: EditorOption
  customEditorCommand: string

  // Terminal
  defaultTerminal: TerminalOption
  customTerminalCommand: string
  embeddedTerminalBackend: EmbeddedTerminalBackend
  ghosttyFontSize: number
  ghosttyPromotionDismissed: boolean

  // Model
  selectedModel: SelectedModel | null

  // Quick Actions
  lastOpenAction: QuickActionType | null

  // Favorites
  favoriteModels: string[] // Array of "providerID::modelID" keys

  // Chrome
  customChromeCommand: string // Custom chrome launch command, e.g. "open -a Chrome {url}"

  // Variant defaults per model
  modelVariantDefaults: Record<string, string> // "providerID::modelID" → variant

  // Model icons
  showModelIcons: boolean

  // Agent SDK
  defaultAgentSdk: 'opencode' | 'claude-code' | 'terminal'

  // Setup
  initialSetupComplete: boolean

  // Chat
  stripAtMentions: boolean

  // Updates
  updateChannel: 'stable' | 'canary'

  // Command Filter
  commandFilter: CommandFilterSettings

  // Privacy
  telemetryEnabled: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  autoStartSession: true,
  breedType: 'dogs',
  defaultEditor: 'vscode',
  customEditorCommand: '',
  defaultTerminal: 'terminal',
  customTerminalCommand: '',
  embeddedTerminalBackend: 'xterm',
  ghosttyFontSize: 14,
  ghosttyPromotionDismissed: false,
  selectedModel: null,
  lastOpenAction: null,
  favoriteModels: [],
  customChromeCommand: '',
  modelVariantDefaults: {},
  showModelIcons: false,
  defaultAgentSdk: 'opencode',
  stripAtMentions: true,
  updateChannel: 'stable',
  initialSetupComplete: false,
  commandFilter: {
    allowlist: ['edit: **', 'write: **'],
    blocklist: [
      'bash: rm -rf *',
      'bash: sudo rm *',
      'bash: sudo *',
      'edit: **/.env',
      'edit: **/*.key',
      'edit: **/credentials*',
      'write: **/.env',
      'write: **/*.key',
      'write: **/credentials*'
    ],
    defaultBehavior: 'ask',
    enabled: true
  },
  telemetryEnabled: true
}

const SETTINGS_DB_KEY = 'app_settings'

interface SettingsState extends AppSettings {
  isOpen: boolean
  activeSection: string
  isLoading: boolean

  // Cached SDK availability (non-persisted, re-detected each launch)
  availableAgentSdks: { opencode: boolean; claude: boolean } | null

  // Actions
  openSettings: (section?: string) => void
  closeSettings: () => void
  setActiveSection: (section: string) => void
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  setSelectedModel: (model: SelectedModel) => Promise<void>
  toggleFavoriteModel: (providerID: string, modelID: string) => void
  setModelVariantDefault: (providerID: string, modelID: string, variant: string) => void
  getModelVariantDefault: (providerID: string, modelID: string) => string | undefined
  resetToDefaults: () => void
  loadFromDatabase: () => Promise<void>
  detectAvailableAgentSdks: () => Promise<void>
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
    breedType: state.breedType,
    defaultEditor: state.defaultEditor,
    customEditorCommand: state.customEditorCommand,
    defaultTerminal: state.defaultTerminal,
    customTerminalCommand: state.customTerminalCommand,
    embeddedTerminalBackend: state.embeddedTerminalBackend,
    ghosttyFontSize: state.ghosttyFontSize,
    ghosttyPromotionDismissed: state.ghosttyPromotionDismissed,
    selectedModel: state.selectedModel,
    lastOpenAction: state.lastOpenAction,
    favoriteModels: state.favoriteModels,
    customChromeCommand: state.customChromeCommand,
    modelVariantDefaults: state.modelVariantDefaults,
    showModelIcons: state.showModelIcons,
    defaultAgentSdk: state.defaultAgentSdk,
    stripAtMentions: state.stripAtMentions,
    updateChannel: state.updateChannel,
    initialSetupComplete: state.initialSetupComplete,
    commandFilter: state.commandFilter,
    telemetryEnabled: state.telemetryEnabled
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
      availableAgentSdks: null,

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
        // Notify main process of channel change
        if (key === 'updateChannel' && window.updaterOps?.setChannel) {
          window.updaterOps.setChannel(value as string)
        }
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

      setModelVariantDefault: (providerID: string, modelID: string, variant: string) => {
        const key = `${providerID}::${modelID}`
        const updated = { ...get().modelVariantDefaults, [key]: variant }
        set({ modelVariantDefaults: updated })
        const settings = extractSettings({
          ...get(),
          modelVariantDefaults: updated
        } as SettingsState)
        saveToDatabase(settings)
      },

      getModelVariantDefault: (providerID: string, modelID: string) => {
        const key = `${providerID}::${modelID}`
        return get().modelVariantDefaults[key]
      },

      toggleFavoriteModel: (providerID: string, modelID: string) => {
        const key = `${providerID}::${modelID}`
        const current = get().favoriteModels
        const updated = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
        set({ favoriteModels: updated })
        const settings = extractSettings({ ...get(), favoriteModels: updated } as SettingsState)
        saveToDatabase(settings)
      },

      resetToDefaults: () => {
        set({ ...DEFAULT_SETTINGS })
        saveToDatabase(DEFAULT_SETTINGS)
      },

      loadFromDatabase: async () => {
        const dbSettings = await loadSettingsFromDatabase()
        if (dbSettings) {
          set({
            ...dbSettings,
            // Existing users upgrading: if field missing, they've already set up
            initialSetupComplete: dbSettings.initialSetupComplete ?? true,
            isLoading: false
          })
        } else {
          set({ isLoading: false })
          await saveToDatabase(extractSettings(get()))
        }
      },

      detectAvailableAgentSdks: async () => {
        try {
          const result = await window.systemOps.detectAgentSdks()
          set({ availableAgentSdks: result })
        } catch {
          // Fail gracefully — context menu just won't show
          set({ availableAgentSdks: null })
        }
      }
    }),
    {
      name: 'hive-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        autoStartSession: state.autoStartSession,
        breedType: state.breedType,
        defaultEditor: state.defaultEditor,
        customEditorCommand: state.customEditorCommand,
        defaultTerminal: state.defaultTerminal,
        customTerminalCommand: state.customTerminalCommand,
        embeddedTerminalBackend: state.embeddedTerminalBackend,
        ghosttyFontSize: state.ghosttyFontSize,
        ghosttyPromotionDismissed: state.ghosttyPromotionDismissed,
        selectedModel: state.selectedModel,
        lastOpenAction: state.lastOpenAction,
        favoriteModels: state.favoriteModels,
        customChromeCommand: state.customChromeCommand,
        modelVariantDefaults: state.modelVariantDefaults,
        showModelIcons: state.showModelIcons,
        defaultAgentSdk: state.defaultAgentSdk,
        activeSection: state.activeSection,
        stripAtMentions: state.stripAtMentions,
        updateChannel: state.updateChannel,
        initialSetupComplete: state.initialSetupComplete,
        commandFilter: state.commandFilter,
        telemetryEnabled: state.telemetryEnabled
      })
    }
  )
)

// Load from database on startup, then detect available agent SDKs
if (typeof window !== 'undefined') {
  setTimeout(() => {
    useSettingsStore
      .getState()
      .loadFromDatabase()
      .then(() => {
        useSettingsStore.getState().detectAvailableAgentSdks()
      })
  }, 200)

  // Listen for settings updates from main process (e.g., when "Allow always" adds to allowlist)
  window.settingsOps?.onSettingsUpdated((data) => {
    const typedData = data as { commandFilter?: CommandFilterSettings }
    if (typedData.commandFilter) {
      useSettingsStore.setState({ commandFilter: typedData.commandFilter })
    }
  })
}
