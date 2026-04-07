import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import type { UsageProvider } from '@shared/types/usage'

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
  | 'powershell'
  | 'cmd'
  | 'custom'
export type EmbeddedTerminalBackend = 'xterm' | 'ghostty'
export type MergeConflictMode = 'build' | 'plan' | 'always-ask'

export interface SelectedModel {
  providerID: string
  modelID: string
  variant?: string
}

export interface ModeDefaultModels {
  build: SelectedModel | null
  plan: SelectedModel | null
  ask: SelectedModel | null
}

export type QuickActionType = 'cursor' | 'terminal' | 'copy-path' | 'finder'

export interface CommandFilterSettings {
  allowlist: string[]
  blocklist: string[]
  defaultBehavior: 'ask' | 'allow' | 'block'
  enabled: boolean
  enterToApprove: boolean
}

export interface AppSettings {
  // General
  autoStartSession: boolean
  autoPullBeforeWorktree: boolean
  breedType: 'dogs' | 'cats'
  vimModeEnabled: boolean
  mergeConflictMode: MergeConflictMode
  boardMode: 'toggle' | 'sticky-tab'

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
  defaultModels: ModeDefaultModels | null

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
  usageIndicatorMode: 'current-agent' | 'specific-providers'
  usageIndicatorProviders: UsageProvider[]

  // Agent SDK
  defaultAgentSdk: 'opencode' | 'claude-code' | 'codex' | 'terminal'

  // Setup
  initialSetupComplete: boolean

  // Chat
  stripAtMentions: boolean
  codexFastMode: boolean
  codexFastModeAccepted: boolean

  // Updates
  updateChannel: 'stable' | 'canary'
  skippedUpdateVersion: string | null

  // Command Filter
  commandFilter: CommandFilterSettings

  // Privacy
  telemetryEnabled: boolean

  // Tips
  tipsEnabled: boolean

  // Advanced
  environmentVariables: Array<{ key: string; value: string }>
}

const DEFAULT_SETTINGS: AppSettings = {
  autoStartSession: true,
  autoPullBeforeWorktree: true,
  breedType: 'dogs',
  vimModeEnabled: false,
  mergeConflictMode: 'build',
  boardMode: 'toggle',
  defaultEditor: 'vscode',
  customEditorCommand: '',
  defaultTerminal: 'terminal',
  customTerminalCommand: '',
  embeddedTerminalBackend: 'xterm',
  ghosttyFontSize: 14,
  ghosttyPromotionDismissed: false,
  selectedModel: null,
  selectedModelByProvider: {},
  defaultModels: null,
  lastOpenAction: null,
  favoriteModels: [],
  customChromeCommand: '',
  modelVariantDefaults: {},
  showModelIcons: false,
  showModelProvider: false,
  usageIndicatorMode: 'current-agent',
  usageIndicatorProviders: [],
  defaultAgentSdk: 'opencode',
  stripAtMentions: true,
  codexFastMode: false,
  codexFastModeAccepted: false,
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
    enabled: false,
    enterToApprove: false
  },
  telemetryEnabled: true,
  tipsEnabled: true,
  environmentVariables: []
}

interface SettingsState extends AppSettings {
  isOpen: boolean
  activeSection: string
  isLoading: boolean

  // Cached SDK availability (non-persisted, re-detected each launch)
  availableAgentSdks: { opencode: boolean; claude: boolean; codex: boolean } | null

  // Actions
  openSettings: (section?: string) => void
  closeSettings: () => void
  setActiveSection: (section: string) => void
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  setSelectedModel: (
    model: SelectedModel | null,
    agentSdk?: AppSettings['defaultAgentSdk']
  ) => Promise<void>
  setSelectedModelForSdk: (
    agentSdk: AppSettings['defaultAgentSdk'],
    model: SelectedModel | null,
    options?: { skipBackendPush?: boolean }
  ) => Promise<void>
  setModeDefaultModel: (
    mode: 'build' | 'plan' | 'ask',
    model: SelectedModel | null
  ) => Promise<void>
  getModelForMode: (mode: 'build' | 'plan' | 'ask') => SelectedModel | null
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
        const result = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          // Deep-merge commandFilter so new fields (e.g. `enabled`) always have defaults
          // even for users whose saved settings pre-date those fields being added.
          commandFilter: {
            ...DEFAULT_SETTINGS.commandFilter,
            ...(parsed.commandFilter || {})
          }
        }

        // Migrate legacy showUsageIndicator boolean
        if ('showUsageIndicator' in parsed && !('usageIndicatorMode' in parsed)) {
          if (parsed.showUsageIndicator === false) {
            result.usageIndicatorMode = 'specific-providers'
            result.usageIndicatorProviders = []
          } else {
            result.usageIndicatorMode = 'current-agent'
            result.usageIndicatorProviders = []
          }
          delete (result as Record<string, unknown>).showUsageIndicator
        }

        return result
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
    autoPullBeforeWorktree: state.autoPullBeforeWorktree,
    breedType: state.breedType,
    vimModeEnabled: state.vimModeEnabled,
    mergeConflictMode: state.mergeConflictMode,
    boardMode: state.boardMode,
    defaultEditor: state.defaultEditor,
    customEditorCommand: state.customEditorCommand,
    defaultTerminal: state.defaultTerminal,
    customTerminalCommand: state.customTerminalCommand,
    embeddedTerminalBackend: state.embeddedTerminalBackend,
    ghosttyFontSize: state.ghosttyFontSize,
    ghosttyPromotionDismissed: state.ghosttyPromotionDismissed,
    selectedModel: state.selectedModel,
    selectedModelByProvider: state.selectedModelByProvider,
    defaultModels: state.defaultModels,
    lastOpenAction: state.lastOpenAction,
    favoriteModels: state.favoriteModels,
    customChromeCommand: state.customChromeCommand,
    modelVariantDefaults: state.modelVariantDefaults,
    showModelIcons: state.showModelIcons,
    showModelProvider: state.showModelProvider,
    usageIndicatorMode: state.usageIndicatorMode,
    usageIndicatorProviders: state.usageIndicatorProviders,
    defaultAgentSdk: state.defaultAgentSdk,
    stripAtMentions: state.stripAtMentions,
    codexFastMode: state.codexFastMode,
    codexFastModeAccepted: state.codexFastModeAccepted,
    updateChannel: state.updateChannel,
    skippedUpdateVersion: state.skippedUpdateVersion,
    initialSetupComplete: state.initialSetupComplete,
    commandFilter: state.commandFilter,
    telemetryEnabled: state.telemetryEnabled,
    tipsEnabled: state.tipsEnabled,
    environmentVariables: state.environmentVariables
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
        // Handle board mode switching side effects
        if (key === 'boardMode') {
          // setTimeout ensures the state update completes before side effects run.
          // Dynamic import() avoids circular dependency (useSessionStore imports useSettingsStore).
          setTimeout(() => {
            Promise.all([
              import('./useKanbanStore'),
              import('./useSessionStore')
            ]).then(([{ useKanbanStore }, { useSessionStore, BOARD_TAB_ID }]) => {
              if (value === 'sticky-tab') {
                // Toggle → Sticky Tab: deactivate toggle board view, activate board tab
                if (useKanbanStore.getState().isBoardViewActive) {
                  useKanbanStore.getState().toggleBoardView()
                }
                useSessionStore.getState().setActiveSession(BOARD_TAB_ID)
              } else {
                // Sticky Tab → Toggle: if on board tab, fall back to first real session
                const sessionStore = useSessionStore.getState()
                if (sessionStore.activeSessionId === BOARD_TAB_ID) {
                  const worktreeId = sessionStore.activeWorktreeId
                  if (worktreeId) {
                    const tabOrder =
                      sessionStore.tabOrderByWorktree.get(worktreeId) || []
                    const sessions =
                      sessionStore.sessionsByWorktree.get(worktreeId) || []
                    const fallbackId =
                      tabOrder.find((id) => id !== BOARD_TAB_ID) ||
                      (sessions.length > 0 ? sessions[0].id : null)
                    sessionStore.setActiveSession(fallbackId)
                  } else {
                    sessionStore.setActiveSession(null)
                  }
                }
              }
            }).catch(console.error)
          }, 0)
        }
      },

      setSelectedModel: async (
        model: SelectedModel | null,
        agentSdk?: AppSettings['defaultAgentSdk']
      ) => {
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
        // Always save to app settings (including null to clear)
        const settings = extractSettings({ ...get(), selectedModel: model } as SettingsState)
        saveToDatabase(settings)
      },

      setSelectedModelForSdk: async (
        agentSdk: AppSettings['defaultAgentSdk'],
        model: SelectedModel | null,
        options?: { skipBackendPush?: boolean }
      ) => {
        // null clears the per-SDK entry
        const current = { ...get().selectedModelByProvider }
        if (model) {
          current[agentSdk] = model
        } else {
          delete current[agentSdk]
        }
        set({ selectedModelByProvider: current })
        // Push to backend (skip for terminal — no backend service, or when caller already pushed)
        if (agentSdk !== 'terminal' && !options?.skipBackendPush) {
          try {
            await window.opencodeOps.setModel(model ? { ...model, agentSdk } : null)
          } catch (error) {
            console.error('Failed to persist model selection for SDK:', error)
          }
        }
        // Persist to app settings DB
        const settings = extractSettings({
          ...get(),
          selectedModelByProvider: current
        } as SettingsState)
        saveToDatabase(settings)
      },

      setModeDefaultModel: async (mode: 'build' | 'plan' | 'ask', model: SelectedModel | null) => {
        const currentDefaults = get().defaultModels || { build: null, plan: null, ask: null }
        const updated = { ...currentDefaults, [mode]: model }
        set({ defaultModels: updated })

        // Save to database (preference only — don't mutate the live service model)
        const settings = extractSettings({ ...get(), defaultModels: updated } as SettingsState)
        await saveToDatabase(settings)
      },

      getModelForMode: (mode: 'build' | 'plan' | 'ask') => {
        // Return only the mode-specific default (no global fallback).
        // Callers that need a fallback chain should check selectedModel separately.
        return get().defaultModels?.[mode] ?? null
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
        autoPullBeforeWorktree: state.autoPullBeforeWorktree,
        breedType: state.breedType,
        vimModeEnabled: state.vimModeEnabled,
        mergeConflictMode: state.mergeConflictMode,
        boardMode: state.boardMode,
        defaultEditor: state.defaultEditor,
        customEditorCommand: state.customEditorCommand,
        defaultTerminal: state.defaultTerminal,
        customTerminalCommand: state.customTerminalCommand,
        embeddedTerminalBackend: state.embeddedTerminalBackend,
        ghosttyFontSize: state.ghosttyFontSize,
        ghosttyPromotionDismissed: state.ghosttyPromotionDismissed,
        selectedModel: state.selectedModel,
        selectedModelByProvider: state.selectedModelByProvider,
        defaultModels: state.defaultModels,
        lastOpenAction: state.lastOpenAction,
        favoriteModels: state.favoriteModels,
        customChromeCommand: state.customChromeCommand,
        modelVariantDefaults: state.modelVariantDefaults,
        showModelIcons: state.showModelIcons,
        showModelProvider: state.showModelProvider,
        usageIndicatorMode: state.usageIndicatorMode,
        usageIndicatorProviders: state.usageIndicatorProviders,
        defaultAgentSdk: state.defaultAgentSdk,
        activeSection: state.activeSection,
        stripAtMentions: state.stripAtMentions,
        codexFastMode: state.codexFastMode,
        codexFastModeAccepted: state.codexFastModeAccepted,
        updateChannel: state.updateChannel,
        skippedUpdateVersion: state.skippedUpdateVersion,
        initialSetupComplete: state.initialSetupComplete,
        commandFilter: state.commandFilter,
        telemetryEnabled: state.telemetryEnabled,
        tipsEnabled: state.tipsEnabled,
        environmentVariables: state.environmentVariables
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
