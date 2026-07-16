import type { AgentSdk, HandoffAgentSdk } from './types/agent-sdk'

export interface SharedSelectedModel {
  providerID: string
  modelID: string
  variant?: string
  agentSdk?: AgentSdk | string
}

export interface ModelResolutionSettings {
  defaultAgentSdk?: AgentSdk | string | null
  selectedModel?: SharedSelectedModel | null
  selectedModelByProvider?: Record<string, SharedSelectedModel | null> | null
  defaultModels?: Partial<
    Record<'build' | 'plan' | 'ask' | 'review', SharedSelectedModel | null>
  > | null
}

type ModeDefaultKey = 'build' | 'plan' | 'ask' | 'review'

export const FALLBACK_MODELS: Record<HandoffAgentSdk, SharedSelectedModel> = {
  opencode: { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' },
  'claude-code': { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' },
  'claude-code-cli': { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' },
  codex: { providerID: 'codex', modelID: 'gpt-5.5' },
  'grok-cli': { providerID: 'xai', modelID: 'grok-4.5', variant: 'high' }
}

export function getModeDefaultKey(mode: string | null | undefined): ModeDefaultKey {
  if (mode === 'plan' || mode === 'super-plan') return 'plan'
  if (mode === 'ask') return 'ask'
  if (mode === 'review') return 'review'
  return 'build'
}

export function normalizeAgentSdk(sdk: AgentSdk | string | null | undefined): HandoffAgentSdk {
  if (sdk === 'claude-code' || sdk === 'claude-code-cli' || sdk === 'codex' || sdk === 'grok-cli') {
    return sdk
  }
  return 'opencode'
}

export function resolveModelForSdk(
  sdk: HandoffAgentSdk,
  settings: ModelResolutionSettings
): SharedSelectedModel | null {
  const perProvider = settings.selectedModelByProvider ?? {}
  const selected = perProvider[sdk]
  if (selected) return selected
  if (Object.keys(perProvider).length > 0) return null
  return settings.selectedModel ?? null
}

export function resolveSessionCreation(opts: {
  settings: ModelResolutionSettings
  mode?: string | null
  defaultAgentSdk?: AgentSdk | string | null
}): { agentSdk: AgentSdk; model: SharedSelectedModel } {
  const settings = opts.settings
  const requestedSdk = normalizeAgentSdk(
    opts.defaultAgentSdk ?? settings.defaultAgentSdk ?? 'opencode'
  )
  const configuredDefaultSdk = normalizeAgentSdk(settings.defaultAgentSdk ?? 'opencode')
  let resolvedSdk: HandoffAgentSdk = requestedSdk
  let model: SharedSelectedModel | null = null

  const modeDefault = settings.defaultModels?.[getModeDefaultKey(opts.mode)]
  if (modeDefault && requestedSdk === configuredDefaultSdk) {
    model = modeDefault
    resolvedSdk = normalizeAgentSdk(modeDefault.agentSdk ?? requestedSdk)
  }

  if (!model) {
    model = resolveModelForSdk(resolvedSdk, settings)
  }

  // Deliberate divergence from renderer resolution: main has no model catalog or
  // worktree-history caches, so Discord substitutes the hard SDK fallback here.
  if (!model) {
    model = FALLBACK_MODELS[resolvedSdk]
  }

  return { agentSdk: resolvedSdk, model }
}
