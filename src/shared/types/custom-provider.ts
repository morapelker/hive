/**
 * User-defined "custom providers" built on top of the Claude Code CLI.
 *
 * A custom provider is claude-code-cli with a different launch command — e.g. a
 * shell alias like `claudex` that env-prefixes `claude` with ANTHROPIC_BASE_URL
 * pointed at a proxy so non-Anthropic models run through the Claude Code TUI.
 * Sessions keep `agent_sdk = 'claude-code-cli'` (so every CLI behavior gate,
 * hook, and bridge keeps working) and carry the provider's id in the separate
 * `custom_provider_id` session column; the main process resolves the command
 * from settings at spawn time.
 *
 * Definitions live in the app-settings blob (`customProviders`), so the main
 * process can read them DB-side during spawn without new IPC.
 */

/** Where a custom provider's turns should be counted for account usage. */
export type CustomProviderUsage = 'none' | 'claude' | 'openai'

export interface CustomClaudeProvider {
  id: string
  /** Display name shown in pickers ("New <name> Session", SDK toggle, handoff). */
  name: string
  /**
   * The command that launches the CLI. May be a shell alias, a PATH binary, an
   * absolute path, or a full command line with env prefixes/flags — it is run
   * through the user's interactive login shell so aliases resolve.
   */
  command: string
  usageProvider: CustomProviderUsage
}

/**
 * Map a provider's usage attribution onto the account-usage provider union
 * ('anthropic' | 'openai'); null means "don't refresh any account usage".
 */
export function customProviderUsageToUsageProvider(
  usage: CustomProviderUsage | undefined
): 'anthropic' | 'openai' | null {
  switch (usage) {
    case 'openai':
      return 'openai'
    case 'none':
      return null
    default:
      return 'anthropic'
  }
}

export function findCustomProvider(
  providers: CustomClaudeProvider[] | null | undefined,
  id: string | null | undefined
): CustomClaudeProvider | undefined {
  if (!id || !providers) return undefined
  return providers.find((p) => p.id === id)
}

/** Sanitize a value parsed from the settings JSON blob into a valid provider list. */
export function sanitizeCustomProviders(value: unknown): CustomClaudeProvider[] {
  if (!Array.isArray(value)) return []
  const result: CustomClaudeProvider[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const { id, name, command, usageProvider } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !id) continue
    if (typeof name !== 'string' || typeof command !== 'string') continue
    result.push({
      id,
      name,
      command,
      usageProvider:
        usageProvider === 'openai' || usageProvider === 'none' || usageProvider === 'claude'
          ? usageProvider
          : 'none'
    })
  }
  return result
}
