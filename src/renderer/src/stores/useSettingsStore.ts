import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

const APP_SETTINGS_DB_KEY = 'app_settings'

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

export type SandboxAgent = 'claude' | 'codex' | 'copilot' | 'gemini' | 'opencode' | 'shell'

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
  selectedModelByProvider: Record<string, SelectedModel>

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

  // Model provider
  showModelProvider: boolean

  // Usage indicator
  showUsageIndicator: boolean

  // Agent SDK
  defaultAgentSdk: 'opencode' | 'claude-code' | 'terminal'
  preferSandboxSessions: boolean

  // Setup
  initialSetupComplete: boolean

  // Chat
  stripAtMentions: boolean

  // Updates
  updateChannel: 'stable' | 'canary'
  skippedUpdateVersion: string | null

  // Command Filter
  commandFilter: CommandFilterSettings

  // Docker Sandbox
  dockerSandboxAgent: SandboxAgent
  dockerSandboxMountGitReadOnly: boolean

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
  selectedModelByProvider: {},
  lastOpenAction: null,
  favoriteModels: [],
  customChromeCommand: '',
  modelVariantDefaults: {},
  showModelIcons: false,
  showModelProvider: false,
  showUsageIndicator: true,
  defaultAgentSdk: 'opencode',
  preferSandboxSessions: false,
  stripAtMentions: true,
  updateChannel: 'stable',
  skippedUpdateVersion: null,
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
    enabled: false
  },
  dockerSandboxAgent: 'claude',
  dockerSandboxMountGitReadOnly: true,
  telemetryEnabled: true
}

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
  setSelectedModel: (
    model: SelectedModel,
    agentSdk?: AppSettings['defaultAgentSdk']
  ) => Promise<void>
  setSelectedModelForSdk: (
    agentSdk: AppSettings['defaultAgentSdk'],
    model: SelectedModel,
    options?: { skipBackendPush?: boolean }
  ) => Promise<void>
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
      await window.db.setting.set(APP_SETTINGS_DB_KEY, JSON.stringify(settings))
    }
  } catch (error) {
    console.error('Failed to save settings to database:', error)
  }
}

async function loadSettingsFromDatabase(): Promise<AppSettings | null> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      const value = await window.db.setting.get(APP_SETTINGS_DB_KEY)
      if (value) {
        const parsed = JSON.parse(value)
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          // Deep-merge commandFilter so new fields (e.g. `enabled`) always have defaults
          // even for users whose saved settings pre-date those fields being added.
          commandFilter: {
            ...DEFAULT_SETTINGS.commandFilter,
            ...(parsed.commandFilter || {})
          }
        }
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
    selectedModelByProvider: state.selectedModelByProvider,
    lastOpenAction: state.lastOpenAction,
    favoriteModels: state.favoriteModels,
    customChromeCommand: state.customChromeCommand,
    modelVariantDefaults: state.modelVariantDefaults,
    showModelIcons: state.showModelIcons,
    showModelProvider: state.showModelProvider,
    showUsageIndicator: state.showUsageIndicator,
    defaultAgentSdk: state.defaultAgentSdk,
    preferSandboxSessions: state.preferSandboxSessions,
    stripAtMentions: state.stripAtMentions,
    updateChannel: state.updateChannel,
    skippedUpdateVersion: state.skippedUpdateVersion,
    initialSetupComplete: state.initialSetupComplete,
    commandFilter: state.commandFilter,
    dockerSandboxAgent: state.dockerSandboxAgent,
    dockerSandboxMountGitReadOnly: state.dockerSandboxMountGitReadOnly,
    telemetryEnabled: state.telemetryEnabled
  }
}

/**
 * Resolve the default model for a given agent SDK using the per-provider priority chain.
 * Priority: per-provider default → (legacy only) global selectedModel.
 * Returns null when per-provider defaults exist but none matches the requested SDK.
 *
 * Accepts an optional state snapshot so it can be used inside Zustand selectors
 * (where getState() must not be called). Falls back to store.getState() when omitted.
 */
export function resolveModelForSdk(
  agentSdk: string,
  state?: Pick<AppSettings, 'selectedModelByProvider' | 'selectedModel'>
): SelectedModel | null {
  const s = state ?? useSettingsStore.getState()
  const perProvider = s.selectedModelByProvider[agentSdk]
  if (perProvider) return perProvider
  // Legacy fallback only when per-provider feature not yet active (migration)
  if (Object.keys(s.selectedModelByProvider).length > 0) return null
  return s.selectedModel
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

      setSelectedModel: async (model: SelectedModel, agentSdk?: AppSettings['defaultAgentSdk']) => {
        if (agentSdk) {
          return get().setSelectedModelForSdk(agentSdk, model)
        }
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

      setSelectedModelForSdk: async (
        agentSdk: AppSettings['defaultAgentSdk'],
        model: SelectedModel,
        options?: { skipBackendPush?: boolean }
      ) => {
        const updated = { ...get().selectedModelByProvider, [agentSdk]: model }
        set({ selectedModelByProvider: updated })
        // Push to backend (skip for terminal — no backend service, or when caller already pushed)
        if (agentSdk !== 'terminal' && !options?.skipBackendPush) {
          try {
            await window.opencodeOps.setModel({ ...model, agentSdk })
          } catch (error) {
            console.error('Failed to persist model selection for SDK:', error)
          }
        }
        // Persist to app settings DB
        const settings = extractSettings({
          ...get(),
          selectedModelByProvider: updated
        } as SettingsState)
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
        selectedModelByProvider: state.selectedModelByProvider,
        lastOpenAction: state.lastOpenAction,
        favoriteModels: state.favoriteModels,
        customChromeCommand: state.customChromeCommand,
        modelVariantDefaults: state.modelVariantDefaults,
        showModelIcons: state.showModelIcons,
        showModelProvider: state.showModelProvider,
        showUsageIndicator: state.showUsageIndicator,
        defaultAgentSdk: state.defaultAgentSdk,
        preferSandboxSessions: state.preferSandboxSessions,
        activeSection: state.activeSection,
        stripAtMentions: state.stripAtMentions,
        updateChannel: state.updateChannel,
        skippedUpdateVersion: state.skippedUpdateVersion,
        initialSetupComplete: state.initialSetupComplete,
        commandFilter: state.commandFilter,
        dockerSandboxAgent: state.dockerSandboxAgent,
        dockerSandboxMountGitReadOnly: state.dockerSandboxMountGitReadOnly,
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
