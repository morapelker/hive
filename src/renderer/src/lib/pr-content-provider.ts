export type PRContentProvider = 'opencode' | 'claude-code' | 'codex'
export type AgentSdkPreference = PRContentProvider | 'terminal' | 'claude-code-cli' | 'codex-cli'

export interface AvailableAgentSdks {
  opencode: boolean
  claude: boolean
  codex: boolean
}

const PROVIDER_ORDER: PRContentProvider[] = ['claude-code', 'codex', 'opencode']

export function resolvePRContentProvider(
  rawPreferredSdk: AgentSdkPreference,
  availableSdks?: AvailableAgentSdks | null
): PRContentProvider | null {
  // claude-code-cli shares Claude's text-generation provider
  const preferredSdk: PRContentProvider | 'terminal' =
    rawPreferredSdk === 'claude-code-cli'
      ? 'claude-code'
      : rawPreferredSdk === 'codex-cli'
        ? 'codex'
        : rawPreferredSdk
  if (preferredSdk !== 'terminal') {
    if (!availableSdks || isProviderAvailable(preferredSdk, availableSdks)) {
      return preferredSdk
    }
  }

  if (!availableSdks) {
    return preferredSdk === 'terminal' ? 'claude-code' : preferredSdk
  }

  for (const provider of PROVIDER_ORDER) {
    if (isProviderAvailable(provider, availableSdks)) {
      return provider
    }
  }

  return null
}

/** Shape of the persisted `prContentModel` setting (agentSdk-stamped SelectedModel). */
export interface PRContentModelSetting {
  agentSdk?: string
  providerID: string
  modelID: string
  variant?: string
}

export interface PRContentGeneration {
  provider: PRContentProvider
  model?: string
  effort?: string
}

/**
 * Resolve the provider + model + effort to use for PR content generation.
 *
 * When the user configured a PR content model in Settings → Models, its SDK
 * picks the provider and its modelID/variant become the model/effort overrides.
 * Otherwise (or when the configured provider's CLI is unavailable) falls back
 * to the provider chain derived from the default agent SDK, with no overrides.
 */
export function resolvePRContentGeneration(
  contentModel: PRContentModelSetting | null | undefined,
  preferredSdk: AgentSdkPreference,
  availableSdks?: AvailableAgentSdks | null
): PRContentGeneration | null {
  if (contentModel) {
    // A model picked without an explicit SDK is portable across every available
    // catalog, so the default provider chain decides which CLI runs it.
    const provider = contentModel.agentSdk
      ? toPRContentProvider(contentModel.agentSdk)
      : resolvePRContentProvider(preferredSdk, availableSdks)
    if (provider && (!availableSdks || isProviderAvailable(provider, availableSdks))) {
      // opencode expects the fully-qualified "provider/model" form; claude and
      // codex CLIs take the bare model slug.
      const model =
        provider === 'opencode'
          ? `${contentModel.providerID}/${contentModel.modelID}`
          : contentModel.modelID
      // ultracode is a claude-code-cli-only pseudo-effort; xhigh is its SDK equivalent.
      const effort = contentModel.variant === 'ultracode' ? 'xhigh' : contentModel.variant
      return { provider, model, ...(effort ? { effort } : {}) }
    }
  }

  const fallback = resolvePRContentProvider(preferredSdk, availableSdks)
  return fallback ? { provider: fallback } : null
}

function toPRContentProvider(agentSdk: string): PRContentProvider | null {
  switch (agentSdk) {
    case 'claude-code':
    case 'claude-code-cli':
      return 'claude-code'
    case 'codex-cli':
      return 'codex'
    case 'codex':
      return 'codex'
    case 'opencode':
      return 'opencode'
    default:
      return null
  }
}

function isProviderAvailable(provider: PRContentProvider, availableSdks: AvailableAgentSdks): boolean {
  switch (provider) {
    case 'claude-code':
      return availableSdks.claude
    case 'codex':
      return availableSdks.codex
    case 'opencode':
      return availableSdks.opencode
  }
}
