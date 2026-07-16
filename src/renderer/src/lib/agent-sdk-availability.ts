import type { AgentSdk } from '@shared/types/agent-sdk'

export interface AvailableAgentSdks {
  opencode: boolean
  claude: boolean
  codex: boolean
  /** codex binary present (no app-server requirement) — gates the terminal-backed codex-cli. */
  codexCli?: boolean
}

/** Alias of the shared {@link AgentSdk} union, kept for this module's selection-focused naming. */
export type SelectableAgentSdk = AgentSdk

function getAgentSdkLabel(sdk: Exclude<SelectableAgentSdk, 'terminal'>): string {
  switch (sdk) {
    case 'opencode':
      return 'OpenCode'
    case 'claude-code':
      return 'Claude Code'
    case 'claude-code-cli':
      return 'Claude Code (CLI)'
    case 'codex':
      return 'Codex'
    case 'codex-cli':
      return 'Codex (CLI)'
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
    case 'claude-code-cli':
      return availableAgentSdks.claude
    case 'codex':
      return availableAgentSdks.codex
    case 'codex-cli':
      return availableAgentSdks.codexCli ?? false
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
