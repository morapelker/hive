export type PRContentProvider = 'opencode' | 'claude-code' | 'codex'
/**
 * Any SDK the caller might hold, including the terminal-backed CLIs (which
 * generate PR content through their SDK sibling's exec path) and the bare
 * terminal (which has no text-generation provider).
 */
export type AgentSdkPreference =
  | 'opencode'
  | 'claude-code'
  | 'claude-code-cli'
  | 'codex'
  | 'codex-cli'
  | 'terminal'

export interface AvailableAgentSdks {
  opencode: boolean
  claude: boolean
  codex: boolean
  /** codex binary present (may lack app-server); enough for `codex exec` text generation. */
  codexCli?: boolean
}

const PROVIDER_ORDER: PRContentProvider[] = ['claude-code', 'codex', 'opencode']

/**
 * Map any SDK to the provider that actually generates PR content. The terminal
 * CLIs share their SDK sibling's `codex exec` / claude route; `terminal` has
 * none.
 */
function toPRContentProvider(sdk: AgentSdkPreference): PRContentProvider | null {
  switch (sdk) {
    case 'claude-code':
    case 'claude-code-cli':
      return 'claude-code'
    case 'codex':
    case 'codex-cli':
      return 'codex'
    case 'opencode':
      return 'opencode'
    case 'terminal':
      return null
  }
}

export function resolvePRContentProvider(
  preferredSdk: AgentSdkPreference,
  availableSdks?: AvailableAgentSdks | null
): PRContentProvider | null {
  const preferred = toPRContentProvider(preferredSdk)
  if (preferred) {
    if (!availableSdks || isProviderAvailable(preferred, availableSdks)) {
      return preferred
    }
  }

  if (!availableSdks) {
    return preferred ?? 'claude-code'
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
      // PR content generation spawns `codex exec`, which needs only the codex
      // binary — available whenever either codex signal is set (app-server
      // `codex`, or the terminal CLI `codexCli`).
      return availableSdks.codex || (availableSdks.codexCli ?? false)
    case 'opencode':
      return availableSdks.opencode
  }
}
