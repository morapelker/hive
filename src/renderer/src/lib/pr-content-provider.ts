export type PRContentProvider = 'opencode' | 'claude-code' | 'codex'
export type AgentSdkPreference = PRContentProvider | 'terminal'

export interface AvailableAgentSdks {
  opencode: boolean
  claude: boolean
  codex: boolean
}

const PROVIDER_ORDER: PRContentProvider[] = ['claude-code', 'codex', 'opencode']

export function resolvePRContentProvider(
  preferredSdk: AgentSdkPreference,
  availableSdks?: AvailableAgentSdks | null
): PRContentProvider | null {
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
