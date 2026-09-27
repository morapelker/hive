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
  'codex-cli': { providerID: 'codex', modelID: 'gpt-5.5', variant: 'high' }
}

export function getModeDefaultKey(mode: string | null | undefined): ModeDefaultKey {
  if (mode === 'plan' || mode === 'super-plan') return 'plan'
  if (mode === 'ask') return 'ask'
  if (mode === 'review') return 'review'
  return 'build'
}

export function normalizeAgentSdk(sdk: AgentSdk | string | null | undefined): HandoffAgentSdk {
  if (
    sdk === 'claude-code' ||
    sdk === 'claude-code-cli' ||
    sdk === 'codex' ||
    sdk === 'codex-cli'
  )
    return sdk
  return 'opencode'
}

export function resolveModelForSdk(
  sdk: HandoffAgentSdk,
  settings: ModelResolutionSettings
): SharedSelectedModel | null {
  const perProvider = settings.selectedModelByProvider ?? {}
  // The codex CLI shares codex's catalog and account: until the user picks a
  // model for it explicitly, run whatever they already chose for codex (the
  // static fallback below may not even be enabled on their account).
  const selected = perProvider[sdk] ?? (sdk === 'codex-cli' ? perProvider.codex : undefined)
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
  const resolvedSdk: HandoffAgentSdk = requestedSdk
  let model: SharedSelectedModel | null = null

  // Mirrors the renderer: a mode default only supplies a model for the SDK it
  // belongs to. One tagged for another SDK is ignored rather than redirecting
  // the session, so the configured default SDK stays in charge.
  const modeDefault = settings.defaultModels?.[getModeDefaultKey(opts.mode)]
  if (
    modeDefault &&
    requestedSdk === configuredDefaultSdk &&
    (!modeDefault.agentSdk || normalizeAgentSdk(modeDefault.agentSdk) === requestedSdk)
  ) {
    model = modeDefault
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
