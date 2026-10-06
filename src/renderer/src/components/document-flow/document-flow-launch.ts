import {
  ULTRACODE_VARIANT,
  findModelInfo,
  getVariantKeysForSdk,
  type ProviderModels
} from '@/lib/parseProviders'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import type { DocumentRunItem, DocumentRunLaunchConfig } from '@shared/types/document-flow'

// What a previewed run needs before it may launch: launch configs that can actually run,
// dependencies that can be scheduled, and at least one ticket. Pure, like document-flow-ui.

// ── Launch config ──────────────────────────────────────────────────────────

export const DOCUMENT_FLOW_SDK_LABELS: Record<HandoffAgentSdk, string> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  'claude-code-cli': 'Claude CLI',
  codex: 'Codex',
  'codex-cli': 'Codex CLI'
}

export function effectiveLaunchConfig(
  item: Pick<DocumentRunItem, 'launch_config'>,
  defaultLaunch: DocumentRunLaunchConfig | null
): DocumentRunLaunchConfig | null {
  return item.launch_config ?? defaultLaunch
}

/**
 * One line for the launch confirmation: SDK, model and effort, or "App default". A custom
 * provider is named when the caller knows its name.
 */
export function describeLaunchConfig(
  config: DocumentRunLaunchConfig | null,
  customProviderName?: string | null
): string {
  if (!config) return 'App default'
  const sdk = config.customProviderId
    ? `${DOCUMENT_FLOW_SDK_LABELS[config.sdk]} (${customProviderName || 'custom provider'})`
    : DOCUMENT_FLOW_SDK_LABELS[config.sdk]
  if (!config.model) return `${sdk} · default model`
  const variant = config.model.variant ? ` · ${config.model.variant}` : ''
  return `${sdk} · ${config.model.modelID}${variant}`
}

/** Only Codex has a fast mode; on any other SDK the flag is noise. */
export function hasCodexFastMode(config: DocumentRunLaunchConfig): boolean {
  return config.sdk === 'codex' && config.codexFastMode
}

/** Identity of a launch config: everything that changes what a ticket launches with. */
function launchConfigKey(config: DocumentRunLaunchConfig): string {
  return JSON.stringify([
    config.sdk,
    config.customProviderId ?? '',
    config.model?.providerID ?? '',
    config.model?.modelID ?? '',
    config.model?.variant ?? '',
    hasCodexFastMode(config)
  ])
}

export function sameLaunchConfig(
  a: DocumentRunLaunchConfig | null,
  b: DocumentRunLaunchConfig | null
): boolean {
  if (!a || !b) return a === b
  return launchConfigKey(a) === launchConfigKey(b)
}

// ── Quick picks ────────────────────────────────────────────────────────────

/** How many one-tap models a preview row offers. */
const QUICK_LAUNCH_CHOICE_LIMIT = 2

/**
 * `known` followed by the configs of `seen` it lacks, in the order they were seen. Returns
 * `known` itself when nothing is new.
 */
export function mergeLaunchConfigs(
  known: readonly DocumentRunLaunchConfig[],
  seen: readonly (DocumentRunLaunchConfig | null)[]
): readonly DocumentRunLaunchConfig[] {
  const keys = new Set(known.map(launchConfigKey))
  const added: DocumentRunLaunchConfig[] = []
  for (const config of seen) {
    if (!config) continue
    const key = launchConfigKey(config)
    if (keys.has(key)) continue
    keys.add(key)
    added.push(config)
  }
  return added.length > 0 ? [...known, ...added] : known
}

export interface QuickLaunchChoice {
  key: string
  config: DocumentRunLaunchConfig
  /**
   * Set only when another choice reads the same without it: same model, effort and fast mode.
   * Never set for a custom provider, which is always shown by its own name.
   */
  sdkLabel: string | null
}

/**
 * The one-tap models a preview row offers: the latest `limit` of the known configs, oldest
 * first. The run default is left out, since picking it is what "default" already does.
 */
export function quickLaunchChoices(
  known: readonly DocumentRunLaunchConfig[],
  defaultLaunch: DocumentRunLaunchConfig | null,
  limit = QUICK_LAUNCH_CHOICE_LIMIT
): QuickLaunchChoice[] {
  const offered = known.filter((config) => !sameLaunchConfig(config, defaultLaunch)).slice(-limit)
  // What a choice shows of its model. The provider is not part of it: the same model reads
  // the same whichever SDK serves it.
  const label = (config: DocumentRunLaunchConfig): string =>
    JSON.stringify([
      config.model?.modelID ?? config.sdk,
      config.model?.variant ?? '',
      hasCodexFastMode(config)
    ])
  return offered.map((config) => ({
    key: launchConfigKey(config),
    config,
    sdkLabel:
      !config.customProviderId &&
      offered.some((other) => other !== config && label(other) === label(config))
        ? DOCUMENT_FLOW_SDK_LABELS[config.sdk]
        : null
  }))
}

/**
 * Why a launch config cannot run as configured, or null. A variant is only valid for the SDK
 * and model it was picked for: `ultracode` exists on the Claude CLI alone (and only for models
 * with `xhigh`), and other SDKs would silently run something else.
 */
export function launchConfigIssue(
  config: DocumentRunLaunchConfig | null,
  catalog: ProviderModels[] | null
): string | null {
  const variant = config?.model?.variant
  if (!config?.model || !variant) return null

  if (variant === ULTRACODE_VARIANT) {
    if (config.sdk !== 'claude-code-cli') {
      return `ultracode only works with the Claude CLI, not ${DOCUMENT_FLOW_SDK_LABELS[config.sdk]}`
    }
    if (config.customProviderId) return 'ultracode is not available with a custom provider'
  }
  // Custom providers declare their own models and efforts; the SDK catalog says nothing about them.
  if (config.customProviderId || !catalog) return null

  const modelInfo = findModelInfo(catalog, config.model.providerID, config.model.modelID)
  if (!modelInfo) return null
  if (getVariantKeysForSdk(modelInfo, config.sdk).includes(variant)) return null
  return `"${variant}" is not available for ${config.model.modelID} on ${DOCUMENT_FLOW_SDK_LABELS[config.sdk]}`
}

// ── Dependencies ───────────────────────────────────────────────────────────

type DependencyNode = Pick<DocumentRunItem, 'key' | 'depends_on' | 'selected'>

export type DependencyState = 'ok' | 'excluded' | 'unknown'

/** How a dependency pill reads in the preview: fine, pointing at a deselected ticket, or dangling. */
export function dependencyState(key: string, items: readonly DependencyNode[]): DependencyState {
  const dependency = items.find((candidate) => candidate.key === key)
  if (!dependency) return 'unknown'
  return dependency.selected ? 'ok' : 'excluded'
}

/** True when `fromKey` depends on `targetKey`, directly or through other tickets. */
export function dependencyReaches(
  fromKey: string,
  targetKey: string,
  items: readonly DependencyNode[]
): boolean {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const seen = new Set<string>()
  const stack = [fromKey]
  while (stack.length > 0) {
    const key = stack.pop() as string
    if (seen.has(key)) continue
    seen.add(key)
    for (const dependency of byKey.get(key)?.depends_on ?? []) {
      if (dependency === targetKey) return true
      stack.push(dependency)
    }
  }
  return false
}

// ── Launch validation ──────────────────────────────────────────────────────

export interface LaunchValidation {
  selectedCount: number
  /** Problems that block the launch. */
  blockers: string[]
  /** Things worth knowing that do not block it. */
  notes: string[]
}

export function validateLaunch(
  items: readonly DocumentRunItem[],
  defaultLaunch: DocumentRunLaunchConfig | null,
  getCatalog: (sdk: HandoffAgentSdk) => ProviderModels[] | null
): LaunchValidation {
  const selected = items.filter((item) => item.selected)
  const blockers: string[] = []
  const notes: string[] = []

  if (selected.length === 0) blockers.push('Select at least one ticket.')

  let defaultIssueReported = false
  const reportedCycles = new Set<string>()
  for (const item of selected) {
    if (!item.title.trim()) blockers.push(`${item.key} needs a title.`)

    const config = effectiveLaunchConfig(item, defaultLaunch)
    const issue = launchConfigIssue(config, config ? getCatalog(config.sdk) : null)
    if (issue && item.launch_config) {
      blockers.push(`${item.key}: ${issue}.`)
    } else if (issue && !defaultIssueReported) {
      // Every ticket on the run default shares the problem; say it once.
      defaultIssueReported = true
      blockers.push(`Default model: ${issue}.`)
    }

    for (const key of item.depends_on) {
      const state = dependencyState(key, items)
      if (state === 'excluded') {
        notes.push(`${item.key} will not wait for ${key} (not included)`)
      } else if (state === 'unknown') {
        notes.push(`${item.key} will not wait for ${key} (no such ticket)`)
      } else if (key === item.key) {
        blockers.push(`${item.key} depends on itself; remove the dependency.`)
      } else if (dependencyReaches(key, item.key, selected)) {
        const pair = [item.key, key].sort().join(' ↔ ')
        if (!reportedCycles.has(pair)) {
          reportedCycles.add(pair)
          blockers.push(
            `${item.key} and ${key} depend on each other; remove one of the dependencies.`
          )
        }
      }
    }
  }

  return { selectedCount: selected.length, blockers, notes }
}
