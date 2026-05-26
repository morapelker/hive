import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import type { TelegramConfig } from '@shared/types/telegram'
import type { UsageProvider } from '@shared/types/usage'
import type { PetSettings } from '@shared/types/pet'
import type { ReviewPromptType } from '@/constants/reviewPrompts'
import type { CustomProjectCommand } from '@/lib/custom-commands'
import { validateCustomCommand } from '@/lib/custom-commands'
import { toast } from '@/lib/toast'
import { unwrapEnvelope, unwrapEnvelopeApi } from '@/lib/ipc-envelope'

const db = unwrapEnvelopeApi(() => window.db)

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
export type TerminalPosition = 'sidebar' | 'bottom'
export type MergeConflictMode = 'build' | 'plan' | 'always-ask'
export type FollowUpTriggerColumn = 'review' | 'done'

export type AgentSdk = 'opencode' | 'claude-code' | 'codex' | 'terminal'
export type HandoffAgentSdk = Exclude<AgentSdk, 'terminal'>

export interface SelectedModel {
  agentSdk?: HandoffAgentSdk
  providerID: string
  modelID: string
  variant?: string
}

export interface ModeDefaultModels {
  build: SelectedModel | null
  plan: SelectedModel | null
  ask: SelectedModel | null
  review: SelectedModel | null
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
  warnBeforeQuitting: boolean
  breedType: 'dogs' | 'cats'
  vimModeEnabled: boolean
  keepAwakeEnabled: boolean
  taskListCollapsed: boolean
  goalStatusCollapsed: boolean
  mergeConflictMode: MergeConflictMode
  boardMode: 'toggle' | 'sticky-tab'
  followUpTriggerColumn: FollowUpTriggerColumn

  // Editor
  defaultEditor: EditorOption
  customEditorCommand: string

  // Terminal
  defaultTerminal: TerminalOption
  customTerminalCommand: string
  embeddedTerminalBackend: EmbeddedTerminalBackend
  ghosttyFontSize: number
  ghosttyPromotionDismissed: boolean
  terminalPosition: TerminalPosition

  // Model
  selectedModel: SelectedModel | null
  selectedModelByProvider: Record<string, SelectedModel>
  defaultModels: ModeDefaultModels | null
  lastHandoffOverride: {
    agentSdk: HandoffAgentSdk
    providerID: string
    modelID: string
    variant?: string
  } | null

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
  defaultAgentSdk: AgentSdk

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

  // Telegram
  telegramConfig: TelegramConfig | null

  // Pet
  pet: PetSettings

  // Advanced
  environmentVariables: Array<{ key: string; value: string }>
  customProjectCommands: CustomProjectCommand[]

  // Diagnostics
  perfDiagnosticsEnabled: boolean
  codexJsonlLoggingEnabled: boolean
  codexJsonlResetPerSession: boolean

  // Review
  reviewPromptType: ReviewPromptType

  // Migration flags
  _boardModeMigratedToStickyTab?: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  autoStartSession: true,
  autoPullBeforeWorktree: true,
  warnBeforeQuitting: true,
  breedType: 'dogs',
  vimModeEnabled: false,
  keepAwakeEnabled: false,
  taskListCollapsed: false,
  goalStatusCollapsed: false,
  mergeConflictMode: 'always-ask',
  boardMode: 'sticky-tab',
  followUpTriggerColumn: 'done',
  defaultEditor: 'vscode',
  customEditorCommand: '',
  defaultTerminal: 'terminal',
  customTerminalCommand: '',
  embeddedTerminalBackend: 'xterm',
  ghosttyFontSize: 14,
  ghosttyPromotionDismissed: false,
  terminalPosition: 'sidebar',
  selectedModel: null,
  selectedModelByProvider: {},
  defaultModels: null,
  lastHandoffOverride: null,
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
  telegramConfig: null,
  pet: {
    enabled: false,
    petId: 'bee',
    size: 'M',
    opacity: 1,
    hasHatched: false
  },
  environmentVariables: [],
  customProjectCommands: [],
  perfDiagnosticsEnabled: false,
  codexJsonlLoggingEnabled: false,
  codexJsonlResetPerSession: true,
  reviewPromptType: 'standard',
  _boardModeMigratedToStickyTab: false
}

interface SettingsState extends AppSettings {
  isOpen: boolean
  activeSection: string
  isLoading: boolean
  customCommandsFileMtime: number | null

  // Cached SDK availability (non-persisted, re-detected each launch)
  availableAgentSdks: { opencode: boolean; claude: boolean; codex: boolean } | null

  // Actions
  openSettings: (section?: string) => void
  closeSettings: () => void
  setActiveSection: (section: string) => void
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  setTelegramConfig: (config: TelegramConfig | null) => void
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
    mode: 'build' | 'plan' | 'ask' | 'review',
    model: SelectedModel | null
  ) => Promise<void>
  getModelForMode: (
    mode: 'build' | 'plan' | 'super-plan' | 'ask' | 'review'
  ) => SelectedModel | null
  setLastHandoffOverride: (value: AppSettings['lastHandoffOverride']) => void
  toggleFavoriteModel: (providerID: string, modelID: string) => void
  setModelVariantDefault: (providerID: string, modelID: string, variant: string) => void
  getModelVariantDefault: (providerID: string, modelID: string) => string | undefined
  resetToDefaults: () => void
  loadFromDatabase: () => Promise<void>
  detectAvailableAgentSdks: () => Promise<void>
  reloadCustomCommands: () => Promise<void>
}

async function saveToDatabase(settings: AppSettings): Promise<void> {
  try {
    if (typeof window !== 'undefined' && db?.setting) {
      await db.setting.set(APP_SETTINGS_DB_KEY, JSON.stringify(settings))
    }
  } catch (error) {
    console.error('Failed to save settings to database:', error)
  }
}

async function loadSettingsFromDatabase(): Promise<AppSettings | null> {
  try {
    if (typeof window !== 'undefined' && db?.setting && window.settingsOps) {
      // Step 1: Load from file if it exists
      const fileResultEnvelope = await window.settingsOps.loadCustomCommandsFile()
      const fileResult = unwrapEnvelope(fileResultEnvelope)

      // Always sync to database when file load succeeded, even if empty (file is source of truth)
      if (fileResult.success && fileResult.commands !== undefined) {
        const dbValue = await db.setting.get(APP_SETTINGS_DB_KEY)
        const settings = dbValue ? JSON.parse(dbValue) : {}
        settings.customProjectCommands = fileResult.commands

        await db.setting.set(APP_SETTINGS_DB_KEY, JSON.stringify(settings))
      }

      // Step 2: Load all settings from database (now has latest file data)
      const value = await db.setting.get(APP_SETTINGS_DB_KEY)
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
          },
          pet: {
            ...DEFAULT_SETTINGS.pet,
            ...(parsed.pet || {})
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

        // Migrate boardMode default from 'toggle' to 'sticky-tab' (one-time)
        if (!parsed._boardModeMigratedToStickyTab) {
          if (result.boardMode === 'toggle') {
            result.boardMode = 'sticky-tab'
          }
          result._boardModeMigratedToStickyTab = true
        }

        // Validate and filter custom project commands
        if (Array.isArray(result.customProjectCommands)) {
          const validCommands: CustomProjectCommand[] = []
          result.customProjectCommands.forEach((cmd: unknown) => {
            const validation = validateCustomCommand(cmd)
            if (validation.valid) {
              validCommands.push(cmd as CustomProjectCommand)
            } else {
              console.warn('Invalid custom command filtered during settings load:', validation.errors)
            }
          })
          result.customProjectCommands = validCommands
        } else {
          console.warn('customProjectCommands is not an array, setting to empty array')
          result.customProjectCommands = []
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
    warnBeforeQuitting: state.warnBeforeQuitting,
    breedType: state.breedType,
    vimModeEnabled: state.vimModeEnabled,
    keepAwakeEnabled: state.keepAwakeEnabled,
    taskListCollapsed: state.taskListCollapsed,
    goalStatusCollapsed: state.goalStatusCollapsed,
    mergeConflictMode: state.mergeConflictMode,
    boardMode: state.boardMode,
    followUpTriggerColumn: state.followUpTriggerColumn,
    defaultEditor: state.defaultEditor,
    customEditorCommand: state.customEditorCommand,
    defaultTerminal: state.defaultTerminal,
    customTerminalCommand: state.customTerminalCommand,
    embeddedTerminalBackend: state.embeddedTerminalBackend,
    ghosttyFontSize: state.ghosttyFontSize,
    ghosttyPromotionDismissed: state.ghosttyPromotionDismissed,
    terminalPosition: state.terminalPosition,
    selectedModel: state.selectedModel,
    selectedModelByProvider: state.selectedModelByProvider,
    defaultModels: state.defaultModels,
    lastHandoffOverride: state.lastHandoffOverride,
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
    telegramConfig: null,
    pet: state.pet,
    environmentVariables: state.environmentVariables,
    customProjectCommands: state.customProjectCommands,
    perfDiagnosticsEnabled: state.perfDiagnosticsEnabled,
    codexJsonlLoggingEnabled: state.codexJsonlLoggingEnabled,
    codexJsonlResetPerSession: state.codexJsonlResetPerSession,
    reviewPromptType: state.reviewPromptType,
    _boardModeMigratedToStickyTab: state._boardModeMigratedToStickyTab
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
      customCommandsFileMtime: null,

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
          window.updaterOps
            .setChannel(value as string)
            .then(unwrapEnvelope)
            .catch(() => {})
        }
        if (key === 'pet' && window.petOps) {
          const pet = value as PetSettings
          window.petOps.updateSettings(pet)
          if (pet.enabled) {
            window.petOps
              .show()
              .then(unwrapEnvelope)
              .catch(() => {})
          } else {
            window.petOps
              .hide()
              .then(unwrapEnvelope)
              .catch(() => {})
          }
        }
        // Handle board mode switching side effects
        if (key === 'boardMode') {
          // setTimeout ensures the state update completes before side effects run.
          // Dynamic import() avoids circular dependency (useSessionStore imports useSettingsStore).
          setTimeout(() => {
            Promise.all([import('./useKanbanStore'), import('./useSessionStore')])
              .then(([{ useKanbanStore }, { useSessionStore, BOARD_TAB_ID }]) => {
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
                      const tabOrder = sessionStore.tabOrderByWorktree.get(worktreeId) || []
                      const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []
                      const fallbackId =
                        tabOrder.find((id) => id !== BOARD_TAB_ID) ||
                        (sessions.length > 0 ? sessions[0].id : null)
                      sessionStore.setActiveSession(fallbackId)
                    } else {
                      sessionStore.setActiveSession(null)
                    }
                  }
                }
              })
              .catch(console.error)
          }, 0)
        }
      },

      setTelegramConfig: (config) => {
        set({ telegramConfig: config })
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
          unwrapEnvelope(await window.opencodeOps.setModel(model))
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
            unwrapEnvelope(await window.opencodeOps.setModel(model ? { ...model, agentSdk } : null))
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

      setModeDefaultModel: async (
        mode: 'build' | 'plan' | 'ask' | 'review',
        model: SelectedModel | null
      ) => {
        const currentDefaults = get().defaultModels || {
          build: null,
          plan: null,
          ask: null,
          review: null
        }
        const updated = { ...currentDefaults, [mode]: model }
        set({ defaultModels: updated })

        // Save to database (preference only — don't mutate the live service model)
        const settings = extractSettings({ ...get(), defaultModels: updated } as SettingsState)
        await saveToDatabase(settings)
      },

      getModelForMode: (mode: 'build' | 'plan' | 'super-plan' | 'ask' | 'review') => {
        // Return only the mode-specific default (no global fallback).
        // Callers that need a fallback chain should check selectedModel separately.
        const key = mode === 'super-plan' ? 'plan' : mode
        return get().defaultModels?.[key] ?? null
      },

      setLastHandoffOverride: (value) => {
        set({ lastHandoffOverride: value })
        const settings = extractSettings({ ...get(), lastHandoffOverride: value } as SettingsState)
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
        window.petOps?.updateSettings(DEFAULT_SETTINGS.pet)
        window.petOps
          ?.hide()
          .then(unwrapEnvelope)
          .catch(() => {})
      },

      loadFromDatabase: async () => {
        const dbSettings = await loadSettingsFromDatabase()
        const telegramConfig = await window.telegramOps
          ?.getConfig?.()
          .then(unwrapEnvelope)
          .catch(() => null)
        if (dbSettings) {
          set({
            ...dbSettings,
            telegramConfig: telegramConfig ?? null,
            // Existing users upgrading: if field missing, they've already set up
            initialSetupComplete: dbSettings.initialSetupComplete ?? true,
            isLoading: false
          })
          window.petOps?.updateSettings(dbSettings.pet)
          if (dbSettings.pet.enabled) {
            window.petOps
              ?.show()
              .then(unwrapEnvelope)
              .catch(() => {})
          }
        } else {
          set({ isLoading: false, telegramConfig: telegramConfig ?? null })
          await saveToDatabase(extractSettings(get()))
          window.petOps?.updateSettings(get().pet)
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
      },

      reloadCustomCommands: async () => {
        try {
          if (!window.settingsOps?.reloadCustomCommands) {
            toast.error('Settings operations not available')
            return
          }

          const resultEnvelope = await window.settingsOps.reloadCustomCommands()
          const result = unwrapEnvelope(resultEnvelope)

          if (result.success) {
            // Reload all settings from database
            await get().loadFromDatabase()

            // Update mtime
            set({ customCommandsFileMtime: result.mtime ?? null })

            toast.success(`Loaded ${result.count ?? 0} custom commands`)
          } else {
            toast.error(`Failed to reload: ${result.error || 'Unknown error'}`)
          }
        } catch (error) {
          console.error('Failed to reload custom commands:', error)
          toast.error('Failed to reload custom commands')
        }
      }
    }),
    {
      name: 'hive-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        autoStartSession: state.autoStartSession,
        autoPullBeforeWorktree: state.autoPullBeforeWorktree,
        warnBeforeQuitting: state.warnBeforeQuitting,
        breedType: state.breedType,
        vimModeEnabled: state.vimModeEnabled,
        keepAwakeEnabled: state.keepAwakeEnabled,
        taskListCollapsed: state.taskListCollapsed,
        goalStatusCollapsed: state.goalStatusCollapsed,
        mergeConflictMode: state.mergeConflictMode,
        boardMode: state.boardMode,
        followUpTriggerColumn: state.followUpTriggerColumn,
        defaultEditor: state.defaultEditor,
        customEditorCommand: state.customEditorCommand,
        defaultTerminal: state.defaultTerminal,
        customTerminalCommand: state.customTerminalCommand,
        embeddedTerminalBackend: state.embeddedTerminalBackend,
        ghosttyFontSize: state.ghosttyFontSize,
        ghosttyPromotionDismissed: state.ghosttyPromotionDismissed,
        terminalPosition: state.terminalPosition,
        selectedModel: state.selectedModel,
        selectedModelByProvider: state.selectedModelByProvider,
        defaultModels: state.defaultModels,
        lastHandoffOverride: state.lastHandoffOverride,
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
        pet: state.pet,
        environmentVariables: state.environmentVariables,
        customProjectCommands: state.customProjectCommands,
        perfDiagnosticsEnabled: state.perfDiagnosticsEnabled,
        codexJsonlLoggingEnabled: state.codexJsonlLoggingEnabled,
        codexJsonlResetPerSession: state.codexJsonlResetPerSession,
        reviewPromptType: state.reviewPromptType,
        _boardModeMigratedToStickyTab: state._boardModeMigratedToStickyTab
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
