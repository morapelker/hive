import { isAgentSdkAvailable, type AvailableAgentSdks } from './agent-sdk-availability'
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
import { SUPER_PLAN_MODE_PREFIX } from '@/lib/constants'

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
  goalMode?: boolean
  superPlan?: boolean
}

export function buildHandoffPrompt(
  planContent: string,
  override?: HandoffSelectionOverride
): string {
  const goalPrefix = override?.goalMode && override.agentSdk === 'codex' ? '/goal ' : ''
  const superPrefix =
    override?.superPlan && override.agentSdk === 'claude-code-cli' ? SUPER_PLAN_MODE_PREFIX : ''
  return `${superPrefix}${goalPrefix}Implement the following plan\n${planContent}`
}

const SDK_DISPLAY_NAMES: Record<HandoffAgentSdk, string> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  'claude-code-cli': 'Claude Code (CLI)',
  codex: 'Codex'
}

const FALLBACK_MODELS: Record<HandoffAgentSdk, SelectedModel> = {
  opencode: { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' },
  'claude-code': { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' },
  'claude-code-cli': { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' },
  codex: { providerID: 'codex', modelID: 'gpt-5.5' }
}

const modelCatalogCache = new Map<HandoffAgentSdk, ProviderModels[]>()
const inflightModelCatalogRequests = new Map<HandoffAgentSdk, Promise<ProviderModels[]>>()

function normalizeHandoffSdk(
  sdk:
    | 'opencode'
    | 'claude-code'
    | 'claude-code-cli'
    | 'codex'
    | 'terminal'
    | null
    | undefined
): HandoffAgentSdk {
  if (sdk === 'claude-code' || sdk === 'claude-code-cli' || sdk === 'codex') return sdk
  return 'opencode'
}

function getModeDefaultKey(mode: 'build' | 'plan' | 'super-plan' | undefined): 'build' | 'plan' {
  return mode === 'plan' || mode === 'super-plan' ? 'plan' : 'build'
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
  agentSdk?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal'
  mode?: 'build' | 'plan' | 'super-plan'
  explicitSdk?: boolean
}): EffectiveHandoffSelection {
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

export function getHandoffSdkDisplayName(agentSdk: HandoffAgentSdk): string {
  return SDK_DISPLAY_NAMES[agentSdk]
}

export function getAvailableHandoffAgentSdks(
  availableAgentSdks?: AvailableAgentSdks | null
): HandoffAgentSdk[] {
  const orderedSdks: HandoffAgentSdk[] = ['opencode', 'claude-code', 'codex', 'claude-code-cli']
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
  if (typeof window.opencodeOps?.listModels !== 'function') return []

  const listModelsSdk = agentSdk === 'claude-code-cli' ? 'claude-code' : agentSdk
  const request = window.opencodeOps
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
  agentSdkOverride?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal'
  initialMode?: 'build' | 'plan' | 'super-plan'
  modelOverride?: SelectedModel
}): {
  agentSdk: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal'
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
    const model = resolveModelForSdk(resolvedAgentSdk, settings)
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
