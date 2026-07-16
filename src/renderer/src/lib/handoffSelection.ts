import { isAgentSdkAvailable, type AvailableAgentSdks } from './agent-sdk-availability'
import { type AgentSdk, supportsGoalMode, toModelCatalogSdk } from '@shared/types/agent-sdk'
import { findCustomProvider } from '@shared/types/custom-provider'
import { HANDOFF_PLAN_PROMPT_HEADER } from '@shared/agent-mode-prefixes'
import {
  findModelInfo,
  getFirstModelInfo,
  getModelDisplayName,
  getModelVariantKeys,
  parseProviders,
  type ProviderModels
} from './parseProviders'
import {
  resolveModelForSdk,
  useSettingsStore,
  type HandoffAgentSdk,
  type SelectedModel
} from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'

export interface EffectiveHandoffSelection {
  agentSdk: HandoffAgentSdk
  /** claude-code-cli only: hand off to this custom provider's command. */
  customProviderId?: string | null
  model: SelectedModel
  display: {
    sdkName: string
    modelName: string
    variant?: string
  }
}

export interface HandoffSelectionOverride {
  agentSdk: HandoffAgentSdk
  /** claude-code-cli only: hand off to this custom provider's command. */
  customProviderId?: string | null
  model: SelectedModel
  goalMode?: boolean
}

export function buildHandoffPrompt(
  planContent: string,
  override?: HandoffSelectionOverride
): string {
  // A handoff always means "implement this plan", so the prompt is sent as-is.
  // Goal mode is the only decoration; the source session's planning mode (plan /
  // super-plan) must never leak into the implementor's prompt.
  const goalPrefix = override?.goalMode && supportsGoalMode(override.agentSdk) ? '/goal ' : ''
  return `${goalPrefix}${HANDOFF_PLAN_PROMPT_HEADER}${planContent}`
}

const SDK_DISPLAY_NAMES: Record<HandoffAgentSdk, string> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  'claude-code-cli': 'Claude Code (CLI)',
  codex: 'Codex',
  'grok-cli': 'Grok Build'
}

const FALLBACK_MODELS: Record<HandoffAgentSdk, SelectedModel> = {
  opencode: { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' },
  'claude-code': { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' },
  'claude-code-cli': { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' },
  codex: { providerID: 'codex', modelID: 'gpt-5.5' },
  'grok-cli': { providerID: 'xai', modelID: 'grok-4.5', variant: 'high' }
}

const modelCatalogCache = new Map<HandoffAgentSdk, ProviderModels[]>()
const inflightModelCatalogRequests = new Map<HandoffAgentSdk, Promise<ProviderModels[]>>()

function normalizeHandoffSdk(
  sdk:
    | 'opencode'
    | 'claude-code'
    | 'claude-code-cli'
    | 'codex'
    | 'grok-cli'
    | 'terminal'
    | null
    | undefined
): HandoffAgentSdk {
  if (sdk === 'claude-code' || sdk === 'claude-code-cli' || sdk === 'codex' || sdk === 'grok-cli') {
    return sdk
  }
  return 'opencode'
}

function getModeDefaultKey(mode: 'build' | 'plan' | 'super-plan' | undefined): 'build' | 'plan' {
  return mode === 'plan' || mode === 'super-plan' ? 'plan' : 'build'
}

/**
 * Grok runs only grok-family models: a foreign default leaking in from the
 * legacy global selectedModel or a worktree's last-used model would be
 * stamped on the session/badge while buildGrokCliPtySpawn drops it and the
 * CLI runs its own default — discard it so the grok catalog/fallback wins.
 */
function dropForeignModelForSdk(
  model: SelectedModel | null,
  agentSdk: HandoffAgentSdk
): SelectedModel | null {
  if (agentSdk === 'grok-cli' && model && !model.modelID.toLowerCase().startsWith('grok')) {
    return null
  }
  return model
}

function buildModelSelection(
  model: SelectedModel | null,
  agentSdk: HandoffAgentSdk
): SelectedModel {
  if (model) return model

  const cachedProviders = getCachedModelCatalog(agentSdk)
  const firstModel = cachedProviders ? getFirstModelInfo(cachedProviders) : null
  if (firstModel) {
    const variants = getModelVariantKeys(firstModel)
    return {
      providerID: firstModel.providerID,
      modelID: firstModel.id,
      variant: variants[0]
    }
  }

  return FALLBACK_MODELS[agentSdk]
}

function getWorktreeFallbackModel(worktreeId?: string): SelectedModel | null {
  if (!worktreeId) return null

  for (const worktrees of useWorktreeStore.getState().worktreesByProject.values()) {
    const worktree = worktrees.find((candidate) => candidate.id === worktreeId)
    if (!worktree?.last_model_id || !worktree.last_model_provider_id) continue

    return {
      providerID: worktree.last_model_provider_id,
      modelID: worktree.last_model_id,
      variant: worktree.last_model_variant ?? undefined
    }
  }

  return null
}

function resolveSessionSelection(opts: {
  worktreeId?: string
  agentSdk?: AgentSdk
  mode?: 'build' | 'plan' | 'super-plan'
  explicitSdk?: boolean
}): EffectiveHandoffSelection {
  // Discord mirrors the data-driven subset of this chain in src/shared/model-resolution.ts.
  const settings = useSettingsStore.getState()
  const requestedSdk = normalizeHandoffSdk(opts.agentSdk ?? settings.defaultAgentSdk ?? 'opencode')
  const configuredDefaultSdk = normalizeHandoffSdk(settings.defaultAgentSdk ?? 'opencode')
  let model: SelectedModel | null = null
  let resolvedSdk = requestedSdk

  const modeDefault = settings.getModelForMode(getModeDefaultKey(opts.mode))
  // Session creation can pass an explicit SDK; in that case the mode default may only
  // supply a model that already belongs to the requested SDK.
  if (modeDefault && (modeDefault.agentSdk || requestedSdk === configuredDefaultSdk)) {
    const modeDefaultSdk = modeDefault.agentSdk ? normalizeHandoffSdk(modeDefault.agentSdk) : null
    if (opts.explicitSdk) {
      if (modeDefaultSdk === requestedSdk) {
        model = modeDefault
      }
    } else {
      model = modeDefault
      resolvedSdk = modeDefaultSdk ?? requestedSdk
    }
  }

  if (!model) {
    model = resolveModelForSdk(resolvedSdk, settings)
  }

  if (!model && Object.keys(settings.selectedModelByProvider).length === 0) {
    model = getWorktreeFallbackModel(opts.worktreeId)
  }

  model = dropForeignModelForSdk(model, resolvedSdk)

  const resolvedModel = buildModelSelection(model, resolvedSdk)
  const modelInfo = getModelInfoFromCache(resolvedSdk, resolvedModel)

  return {
    agentSdk: resolvedSdk,
    model: resolvedModel,
    display: {
      sdkName: SDK_DISPLAY_NAMES[resolvedSdk],
      modelName: modelInfo ? getModelDisplayName(modelInfo) : resolvedModel.modelID,
      variant: resolvedModel.variant
    }
  }
}

function getModelInfoFromCache(
  agentSdk: HandoffAgentSdk,
  model: SelectedModel
): ReturnType<typeof findModelInfo> {
  const providers = getCachedModelCatalog(agentSdk)
  if (!providers) return null
  return findModelInfo(providers, model.providerID, model.modelID)
}

export function getHandoffSdkDisplayName(
  agentSdk: HandoffAgentSdk,
  customProviderId?: string | null
): string {
  if (customProviderId) {
    const provider = findCustomProvider(
      useSettingsStore.getState().customProviders,
      customProviderId
    )
    if (provider) return provider.name || 'Custom Provider'
  }
  return SDK_DISPLAY_NAMES[agentSdk]
}

export function getAvailableHandoffAgentSdks(
  availableAgentSdks?: AvailableAgentSdks | null
): HandoffAgentSdk[] {
  const orderedSdks: HandoffAgentSdk[] = [
    'opencode',
    'claude-code',
    'codex',
    'claude-code-cli',
    'grok-cli'
  ]
  return orderedSdks.filter((sdk) => isAgentSdkAvailable(sdk, availableAgentSdks))
}

export function cacheHandoffModelCatalog(
  agentSdk: HandoffAgentSdk,
  providerData: unknown
): ProviderModels[] {
  const parsed = parseProviders(providerData)
  modelCatalogCache.set(agentSdk, parsed)
  return parsed
}

export function getCachedModelCatalog(agentSdk: HandoffAgentSdk): ProviderModels[] | null {
  return modelCatalogCache.get(agentSdk) ?? null
}

export function clearHandoffModelCatalogCache(): void {
  modelCatalogCache.clear()
  inflightModelCatalogRequests.clear()
}

export async function loadHandoffModelCatalog(
  agentSdk: HandoffAgentSdk
): Promise<ProviderModels[]> {
  const cached = getCachedModelCatalog(agentSdk)
  if (cached) return cached

  const inflight = inflightModelCatalogRequests.get(agentSdk)
  if (inflight) return inflight

  const listModelsSdk = toModelCatalogSdk(agentSdk)
  const request = opencodeApi
    .listModels({ agentSdk: listModelsSdk })
    .then(unwrapEnvelope)
    .then((result) => {
      const parsed = result.success ? cacheHandoffModelCatalog(agentSdk, result.providers) : []
      inflightModelCatalogRequests.delete(agentSdk)
      return parsed
    })
    .catch((error) => {
      inflightModelCatalogRequests.delete(agentSdk)
      console.error('Failed to load handoff model catalog:', error)
      return []
    })

  inflightModelCatalogRequests.set(agentSdk, request)
  return request
}

export function resolveModelForSdkDefault(agentSdk: HandoffAgentSdk): SelectedModel {
  let configured = resolveModelForSdk(agentSdk)
  // resolveModelForSdk falls back to the legacy global selectedModel, which
  // can hold a grok model (unstamped or grok-cli-stamped) that only the
  // grok-cli catalog serves — never hand that to a non-grok SDK. A per-SDK
  // map hit or an explicit non-grok stamp is trusted provenance (an xAI
  // model the user selected FOR this SDK).
  if (agentSdk !== 'grok-cli' && configured) {
    const grokFamily =
      configured.providerID === 'xai' || configured.modelID.toLowerCase().startsWith('grok')
    const trusted =
      !!useSettingsStore.getState().selectedModelByProvider?.[agentSdk] ||
      (configured.agentSdk != null && configured.agentSdk !== 'grok-cli')
    if (configured.agentSdk === 'grok-cli' || (grokFamily && !trusted)) {
      configured = null
    }
  }
  return buildModelSelection(dropForeignModelForSdk(configured, agentSdk), agentSdk)
}

export function resolveHandoffDefault(opts: { worktreeId?: string }): EffectiveHandoffSelection {
  return resolveSessionSelection({ worktreeId: opts.worktreeId, mode: 'build' })
}

export function getEffectiveHandoffSelection(opts: {
  worktreeId?: string
}): EffectiveHandoffSelection {
  const settings = useSettingsStore.getState()
  const fallback = resolveHandoffDefault(opts)
  const override = settings.lastHandoffOverride

  if (!override) return fallback

  // A custom-provider override outlives its provider (they live in settings) —
  // a deleted provider must fall back rather than silently handing off to
  // plain claude-cli under the stale display name. Checked before the SDK
  // availability guard: custom providers run their own command and don't
  // depend on stock-claude detection.
  if (override.customProviderId) {
    const provider = findCustomProvider(settings.customProviders, override.customProviderId)
    if (!provider || !provider.command.trim()) return fallback
    const model: SelectedModel = {
      providerID: override.providerID,
      modelID: override.modelID,
      variant: override.variant
    }
    return {
      agentSdk: override.agentSdk,
      customProviderId: provider.id,
      model,
      display: {
        // The provider's command decides the real model — show only the name.
        sdkName: provider.name || 'Custom Provider',
        modelName: provider.name || 'Custom Provider',
        variant: undefined
      }
    }
  }

  if (!isAgentSdkAvailable(override.agentSdk, settings.availableAgentSdks)) return fallback

  const cachedProviders = getCachedModelCatalog(override.agentSdk)
  if (cachedProviders && !findModelInfo(cachedProviders, override.providerID, override.modelID)) {
    return fallback
  }

  const model: SelectedModel = {
    providerID: override.providerID,
    modelID: override.modelID,
    variant: override.variant
  }
  const modelInfo = getModelInfoFromCache(override.agentSdk, model)

  return {
    agentSdk: override.agentSdk,
    model,
    display: {
      sdkName: SDK_DISPLAY_NAMES[override.agentSdk],
      modelName: modelInfo ? getModelDisplayName(modelInfo) : override.modelID,
      variant: override.variant
    }
  }
}

export function resolveSessionCreationSelection(opts: {
  worktreeId?: string
  agentSdkOverride?: AgentSdk
  initialMode?: 'build' | 'plan' | 'super-plan'
  modelOverride?: SelectedModel
}): {
  agentSdk: AgentSdk
  model: SelectedModel | null
} {
  const settings = useSettingsStore.getState()
  const agentSdk =
    opts.modelOverride?.agentSdk ?? opts.agentSdkOverride ?? settings.defaultAgentSdk ?? 'opencode'

  if (agentSdk === 'terminal') {
    return { agentSdk, model: null }
  }

  if (opts.modelOverride) {
    return { agentSdk, model: opts.modelOverride }
  }

  if (opts.agentSdkOverride) {
    const resolvedAgentSdk = normalizeHandoffSdk(opts.agentSdkOverride)
    const model = dropForeignModelForSdk(
      resolveModelForSdk(resolvedAgentSdk, settings),
      resolvedAgentSdk
    )
    return {
      agentSdk: resolvedAgentSdk,
      model: buildModelSelection(model, resolvedAgentSdk)
    }
  }

  const resolved = resolveSessionSelection({
    worktreeId: opts.worktreeId,
    agentSdk,
    mode: opts.initialMode,
    explicitSdk: opts.agentSdkOverride != null
  })
  return { agentSdk: resolved.agentSdk, model: resolved.model }
}
