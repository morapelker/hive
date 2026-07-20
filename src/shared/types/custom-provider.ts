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

/**
 * Effort levels the claude CLI accepts for `--effort`. Provider models may only
 * declare a subset of these — commander rejects anything else, which would kill
 * the whole spawn. Note `ultracode` is NOT an effort (it rides in `--settings`)
 * and is never offered for custom providers.
 */
export const CUSTOM_PROVIDER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type CustomProviderEffort = (typeof CUSTOM_PROVIDER_EFFORTS)[number]

/** A model a custom provider serves, selectable when launching its sessions. */
export interface CustomProviderModel {
  /** Stable uuid — React row key and patch identity in the settings editor. */
  id: string
  /** Display name shown in pickers; falls back to the slug when blank. */
  name: string
  /** Passed verbatim as `--model <slug>` to the provider's command. */
  slug: string
  /** Efforts offered for this model; empty = never pass `--effort`. */
  efforts: CustomProviderEffort[]
}

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
  /**
   * Models this provider serves. When non-empty (and a model has a slug), the
   * session pickers offer them and the chosen slug/effort is appended as
   * `--model`/`--effort` after the command — overriding any alias-baked model.
   * When absent/empty the command keeps owning the model (legacy behavior).
   */
  models?: CustomProviderModel[]
}

/**
 * `SelectedModel.providerID` / `sessions.model_provider_id` marker for a model
 * chosen from a custom provider's list (matches the ticket-badge convention).
 */
export const CUSTOM_MODEL_PROVIDER_ID = 'custom'

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

/**
 * Models that can actually launch: a blank slug has nothing to pass as
 * `--model`, so half-typed settings rows are ignored (mirrors how providers
 * with a blank command are hidden from pickers).
 */
export function getLaunchableCustomProviderModels(
  models: CustomProviderModel[] | null | undefined
): CustomProviderModel[] {
  return (models ?? []).filter((m) => m.slug.trim() !== '')
}

/**
 * Strict slug match against the provider's declared models. Sessions persist
 * the slug in `model_id`; anything that doesn't match a declared model (stale
 * stock-claude values like 'sonnet', or a slug the user has since renamed)
 * must NOT be forwarded to the provider's command.
 */
export function matchCustomProviderModel(
  models: CustomProviderModel[] | null | undefined,
  slug: string | null | undefined
): CustomProviderModel | null {
  const trimmed = slug?.trim()
  if (!trimmed) return null
  return getLaunchableCustomProviderModels(models).find((m) => m.slug.trim() === trimmed) ?? null
}

/** The stored effort when the model declares it, else null (no `--effort`). */
export function resolveCustomProviderEffort(
  model: CustomProviderModel,
  variant: string | null | undefined
): CustomProviderEffort | null {
  if (!variant) return null
  return model.efforts.find((effort) => effort === variant) ?? null
}

/**
 * Resolve what a custom-provider session should run: the candidate model/effort
 * when it matches the provider's declarations, else the provider's default
 * (first declared model, first declared effort). Null when the provider
 * declares no launchable models — the command keeps owning the model.
 */
export function resolveCustomProviderModelSelection(
  provider: Pick<CustomClaudeProvider, 'models'> | null | undefined,
  candidateModelId?: string | null,
  candidateVariant?: string | null
): { model: CustomProviderModel; effort: CustomProviderEffort | null } | null {
  const launchable = getLaunchableCustomProviderModels(provider?.models)
  if (launchable.length === 0) return null
  const model = matchCustomProviderModel(launchable, candidateModelId) ?? launchable[0]
  const effort = resolveCustomProviderEffort(model, candidateVariant) ?? model.efforts[0] ?? null
  return { model, effort }
}

/** Display name for a provider model (slug fallback for blank names). */
export function getCustomProviderModelDisplayName(model: CustomProviderModel): string {
  return model.name.trim() || model.slug.trim()
}

function sanitizeCustomProviderModels(value: unknown): CustomProviderModel[] {
  if (!Array.isArray(value)) return []
  const result: CustomProviderModel[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const { id, name, slug, efforts } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !id) continue
    if (typeof name !== 'string' || typeof slug !== 'string') continue
    // Intersect with the known set in canonical order — the claude CLI rejects
    // unknown --effort values, which would kill the whole spawn.
    const effortSet = new Set(Array.isArray(efforts) ? efforts : [])
    result.push({
      id,
      name,
      slug,
      efforts: CUSTOM_PROVIDER_EFFORTS.filter((effort) => effortSet.has(effort))
    })
  }
  return result
}

/** Sanitize a value parsed from the settings JSON blob into a valid provider list. */
export function sanitizeCustomProviders(value: unknown): CustomClaudeProvider[] {
  if (!Array.isArray(value)) return []
  const result: CustomClaudeProvider[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const { id, name, command, usageProvider, models } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !id) continue
    if (typeof name !== 'string' || typeof command !== 'string') continue
    result.push({
      id,
      name,
      command,
      usageProvider:
        usageProvider === 'openai' || usageProvider === 'none' || usageProvider === 'claude'
          ? usageProvider
          : 'none',
      models: sanitizeCustomProviderModels(models)
    })
  }
  return result
}
