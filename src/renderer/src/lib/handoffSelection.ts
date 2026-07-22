import { isAgentSdkAvailable, type AvailableAgentSdks } from './agent-sdk-availability'
import { type AgentSdk, supportsGoalMode, toModelCatalogSdk } from '@shared/types/agent-sdk'
import {
  CUSTOM_MODEL_PROVIDER_ID,
  findCustomProvider,
  getCustomProviderModelDisplayName,
  resolveCustomProviderModelSelection,
  type CustomClaudeProvider
} from '@shared/types/custom-provider'
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

// The cache is a plain module Map, invisible to React. Components that resolve
// display names during render (e.g. ticket model badges mounted before the
// catalogs arrive) subscribe to this version so they re-render once a catalog
// lands instead of waiting for an unrelated re-render.
let modelCatalogCacheVersion = 0
const modelCatalogCacheListeners = new Set<() => void>()

function notifyModelCatalogCacheChanged(): void {
  modelCatalogCacheVersion++
  for (const listener of modelCatalogCacheListeners) listener()
}

export function subscribeModelCatalogCache(listener: () => void): () => void {
  modelCatalogCacheListeners.add(listener)
  return () => {
    modelCatalogCacheListeners.delete(listener)
  }
}

export function getModelCatalogCacheVersion(): number {
  return modelCatalogCacheVersion
}

function normalizeHandoffSdk(
  sdk: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal' | null | undefined
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

/**
 * Resolve a candidate model/effort against a custom provider's declared models
 * into the `SelectedModel` shape that rides overrides, launch configs, and the
 * session row (`providerID: 'custom'`, `modelID: <slug>`, `variant: <effort>`).
 * Only candidates already carrying the 'custom' marker count — a legacy stock
 * stamp like anthropic/sonnet must not accidentally match a declared slug
 * named after a stock alias. Invalid or non-custom candidates degrade to the
 * provider's default (first model/effort); null when the provider declares no
 * launchable models — the command keeps owning the model, as before this
 * feature.
 */
export function resolveCustomProviderSelectedModel(
  provider: CustomClaudeProvider,
  candidate?: { providerID?: string; modelID?: string | null; variant?: string | null } | null
): SelectedModel | null {
  const isCustomCandidate = candidate?.providerID === CUSTOM_MODEL_PROVIDER_ID
  const selection = resolveCustomProviderModelSelection(
    provider,
    isCustomCandidate ? candidate?.modelID : null,
    isCustomCandidate ? candidate?.variant : null
  )
  if (!selection) return null
  return {
    providerID: CUSTOM_MODEL_PROVIDER_ID,
    modelID: selection.model.slug.trim(),
    variant: selection.effort ?? undefined
  }
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
  const orderedSdks: HandoffAgentSdk[] = ['opencode', 'claude-code', 'codex', 'claude-code-cli']
  return orderedSdks.filter((sdk) => isAgentSdkAvailable(sdk, availableAgentSdks))
}

export function cacheHandoffModelCatalog(
  agentSdk: HandoffAgentSdk,
  providerData: unknown
): ProviderModels[] {
  const parsed = parseProviders(providerData)
  modelCatalogCache.set(agentSdk, parsed)
  notifyModelCatalogCacheChanged()
  return parsed
}

export function getCachedModelCatalog(agentSdk: HandoffAgentSdk): ProviderModels[] | null {
  return modelCatalogCache.get(agentSdk) ?? null
}

export function clearHandoffModelCatalogCache(): void {
  modelCatalogCache.clear()
  inflightModelCatalogRequests.clear()
  notifyModelCatalogCacheChanged()
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

/**
 * Warm the model-catalog cache for every available SDK so model names resolve
 * to their display form (e.g. "Fable 5" instead of "fable") without the user
 * first opening a model picker. Deduped by catalog SDK — claude-code and
 * claude-code-cli share one catalog, so only one fetch goes out for the pair.
 */
export async function preloadHandoffModelCatalogs(): Promise<void> {
  const availableAgentSdks = useSettingsStore.getState().availableAgentSdks
  const seenCatalogSdks = new Set<AgentSdk>()
  const sdksToLoad = getAvailableHandoffAgentSdks(availableAgentSdks).filter((sdk) => {
    const catalogSdk = toModelCatalogSdk(sdk)
    if (seenCatalogSdks.has(catalogSdk)) return false
    seenCatalogSdks.add(catalogSdk)
    return true
  })
  await Promise.all(sdksToLoad.map((sdk) => loadHandoffModelCatalog(sdk)))
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

  // A custom-provider override outlives its provider (they live in settings) —
  // a deleted provider must fall back rather than silently handing off to
  // plain claude-cli under the stale display name. Checked before the SDK
  // availability guard: custom providers run their own command and don't
  // depend on stock-claude detection.
  if (override.customProviderId) {
    const provider = findCustomProvider(settings.customProviders, override.customProviderId)
    if (!provider || !provider.command.trim()) return fallback
    const providerName = provider.name || 'Custom Provider'
    // Resolve the remembered model/effort against the provider's declared
    // models — a slug/effort the user has since removed degrades to the
    // provider default rather than riding along stale. Only overrides already
    // carrying the 'custom' marker count as a remembered pick: a legacy
    // override's stock stamp (anthropic/sonnet) must not accidentally match a
    // declared slug named after a stock alias.
    const isCustomOverrideModel = override.providerID === CUSTOM_MODEL_PROVIDER_ID
    const selection = resolveCustomProviderModelSelection(
      provider,
      isCustomOverrideModel ? override.modelID : null,
      isCustomOverrideModel ? override.variant : null
    )
    if (selection) {
      return {
        agentSdk: override.agentSdk,
        customProviderId: provider.id,
        model: {
          providerID: CUSTOM_MODEL_PROVIDER_ID,
          modelID: selection.model.slug.trim(),
          variant: selection.effort ?? undefined
        },
        display: {
          sdkName: providerName,
          modelName: getCustomProviderModelDisplayName(selection.model),
          variant: selection.effort ?? undefined
        }
      }
    }
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
        // No declared models: the provider's command decides the real model —
        // show only the name.
        sdkName: providerName,
        modelName: providerName,
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
  /** claude-code-cli only: resolve the model from this provider's declared list. */
  customProviderId?: string | null
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

  // Custom-provider sessions must never be stamped with a stock-claude model:
  // once the spawner passes --model for declared models, a stale claude value
  // would only be dead weight (it can't match a declared slug), and a declared
  // provider needs its default model stamped even when no override rides in.
  if (opts.customProviderId && agentSdk === 'claude-code-cli') {
    const provider = findCustomProvider(settings.customProviders, opts.customProviderId)
    if (provider) {
      const model = resolveCustomProviderSelectedModel(provider, opts.modelOverride)
      return { agentSdk, model }
    }
  }
  // A custom-shaped override that reaches here has lost its provider (deleted,
  // degraded, or a dangling id) — never leak the proxy slug into stock-claude
  // resolution. Scoped to claude-code-cli: 'custom' is also a legal opencode
  // catalog provider id and must pass through untouched for other SDKs.
  const modelOverride =
    agentSdk === 'claude-code-cli' &&
    opts.modelOverride?.providerID === CUSTOM_MODEL_PROVIDER_ID
      ? undefined
      : opts.modelOverride

  if (modelOverride) {
    return { agentSdk, model: modelOverride }
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
