export interface AvailableAgentSdks {
  opencode: boolean
  claude: boolean
  codex: boolean
}

export type SelectableAgentSdk = 'opencode' | 'claude-code' | 'codex' | 'terminal'

function getAgentSdkLabel(sdk: Exclude<SelectableAgentSdk, 'terminal'>): string {
  switch (sdk) {
    case 'opencode':
      return 'OpenCode'
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
  }
}

export function isAgentSdkAvailable(
  sdk: SelectableAgentSdk,
  availableAgentSdks?: AvailableAgentSdks | null
): boolean {
  if (sdk === 'terminal' || !availableAgentSdks) return true

  switch (sdk) {
    case 'opencode':
      return availableAgentSdks.opencode
    case 'claude-code':
      return availableAgentSdks.claude
    case 'codex':
      return availableAgentSdks.codex
    case 'terminal':
      return true
  }
}

export function getUnavailableAgentSdkMessage(
  sdk: SelectableAgentSdk,
  availableAgentSdks?: AvailableAgentSdks | null
): string | null {
  if (sdk === 'terminal' || !availableAgentSdks || isAgentSdkAvailable(sdk, availableAgentSdks)) {
    return null
  }

  return `${getAgentSdkLabel(sdk)} is not available on this system. Install it and restart Hive, or choose another provider.`
}
