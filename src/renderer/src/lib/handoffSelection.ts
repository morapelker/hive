import { isAgentSdkAvailable, type AvailableAgentSdks } from './agent-sdk-availability'
import {
  findModelInfo,
  getFirstModelInfo,
  getModelDisplayName,
  getModelVariantKeys,
  parseProviders,
  type ProviderModels
} from './parseProviders'
import { resolveModelForSdk, useSettingsStore, type HandoffAgentSdk, type SelectedModel } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

export interface EffectiveHandoffSelection {
  agentSdk: HandoffAgentSdk
  model: SelectedModel
  display: {
    sdkName: string
    modelName: string
    variant?: string
  }
}

export interface HandoffSelectionOverride {
  agentSdk: HandoffAgentSdk
  model: SelectedModel
}

const SDK_DISPLAY_NAMES: Record<HandoffAgentSdk, string> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex'
}

const FALLBACK_MODELS: Record<HandoffAgentSdk, SelectedModel> = {
  opencode: { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' },
  'claude-code': { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' },
  codex: { providerID: 'codex', modelID: 'gpt-5.4' }
}

const modelCatalogCache = new Map<HandoffAgentSdk, ProviderModels[]>()
const inflightModelCatalogRequests = new Map<HandoffAgentSdk, Promise<ProviderModels[]>>()

function normalizeHandoffSdk(
  sdk: 'opencode' | 'claude-code' | 'codex' | 'terminal' | null | undefined
): HandoffAgentSdk {
  if (sdk === 'claude-code' || sdk === 'codex') return sdk
  return 'opencode'
}

function buildModelSelection(model: SelectedModel | null, agentSdk: HandoffAgentSdk): SelectedModel {
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
  agentSdk?: 'opencode' | 'claude-code' | 'codex' | 'terminal'
  mode?: 'build' | 'plan' | 'super-plan'
}): EffectiveHandoffSelection {
  const settings = useSettingsStore.getState()
  const requestedSdk = normalizeHandoffSdk(opts.agentSdk ?? settings.defaultAgentSdk ?? 'opencode')
  const configuredDefaultSdk = normalizeHandoffSdk(settings.defaultAgentSdk ?? 'opencode')
  let model: SelectedModel | null = null

  if (requestedSdk === configuredDefaultSdk && (opts.mode ?? 'build') === 'build') {
    model = settings.defaultModels?.build ?? null
  }

  if (!model) {
    model = resolveModelForSdk(requestedSdk, settings)
  }

  if (!model && Object.keys(settings.selectedModelByProvider).length === 0) {
    model = getWorktreeFallbackModel(opts.worktreeId)
  }

  const resolvedModel = buildModelSelection(model, requestedSdk)
  const modelInfo = getModelInfoFromCache(requestedSdk, resolvedModel)

  return {
    agentSdk: requestedSdk,
    model: resolvedModel,
    display: {
      sdkName: SDK_DISPLAY_NAMES[requestedSdk],
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

export function getHandoffSdkDisplayName(agentSdk: HandoffAgentSdk): string {
  return SDK_DISPLAY_NAMES[agentSdk]
}

export function getAvailableHandoffAgentSdks(
  availableAgentSdks?: AvailableAgentSdks | null
): HandoffAgentSdk[] {
  const orderedSdks: HandoffAgentSdk[] = ['opencode', 'claude-code', 'codex']
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

export async function loadHandoffModelCatalog(agentSdk: HandoffAgentSdk): Promise<ProviderModels[]> {
  const cached = getCachedModelCatalog(agentSdk)
  if (cached) return cached

  const inflight = inflightModelCatalogRequests.get(agentSdk)
  if (inflight) return inflight
  if (typeof window.opencodeOps?.listModels !== 'function') return []

  const request = window.opencodeOps
    .listModels({ agentSdk })
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
  const configured = resolveModelForSdk(agentSdk)
  return buildModelSelection(configured, agentSdk)
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
  if (!isAgentSdkAvailable(override.agentSdk, settings.availableAgentSdks)) return fallback

  const cachedProviders = getCachedModelCatalog(override.agentSdk)
  if (
    cachedProviders &&
    !findModelInfo(cachedProviders, override.providerID, override.modelID)
  ) {
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
  agentSdkOverride?: 'opencode' | 'claude-code' | 'codex' | 'terminal'
  initialMode?: 'build' | 'plan' | 'super-plan'
  modelOverride?: SelectedModel
}): {
  agentSdk: 'opencode' | 'claude-code' | 'codex' | 'terminal'
  model: SelectedModel | null
} {
  const settings = useSettingsStore.getState()
  const agentSdk = opts.agentSdkOverride ?? settings.defaultAgentSdk ?? 'opencode'

  if (agentSdk === 'terminal') {
    return { agentSdk, model: null }
  }

  if (opts.modelOverride) {
    return { agentSdk, model: opts.modelOverride }
  }

  const resolved = resolveSessionSelection({
    worktreeId: opts.worktreeId,
    agentSdk,
    mode: opts.initialMode
  })
  return { agentSdk, model: resolved.model }
}
