// Which model the database assistant runs: the user's default, resolved exactly like the other
// one-shot AI jobs (document-flow extraction): the default agent SDK's build-mode / provider /
// global default model, folded onto a provider that is actually installed (claude-code → codex →
// opencode), CLI variants mapped to their SDK sibling, `ultracode` to xhigh, OpenCode as a
// `provider/model` slug. A per-panel override (picked with the ModelSelector) goes through the
// same resolver, so an override for a provider that is not installed falls back the same way.

import type { DataAssistantGeneration } from '@shared/data-projects/types'
import { resolvePRContentGeneration } from '@/lib/pr-content-provider'
import { resolveDefaultLaunchModel } from '@/lib/tedooo-agent/models'
import {
  resolvePreferredAgentSdk,
  useSettingsStore,
  type SelectedModel
} from '@/stores/useSettingsStore'

/** The default model as a ModelSelector value (agentSdk-stamped). */
export function defaultAssistantModel(): SelectedModel {
  const sdk = resolvePreferredAgentSdk()
  const model = resolveDefaultLaunchModel(sdk)
  return {
    agentSdk: sdk,
    providerID: model.providerID,
    modelID: model.modelID,
    ...(model.variant ? { variant: model.variant } : {})
  }
}

/**
 * `{ provider, model, effort }` for `dataAssistant.start`, or null when no AI provider is
 * installed at all.
 */
export function resolveDataAssistantGeneration(
  override?: SelectedModel | null
): DataAssistantGeneration | null {
  const { defaultAgentSdk, availableAgentSdks } = useSettingsStore.getState()
  const preferred = defaultAgentSdk ?? 'claude-code'
  return resolvePRContentGeneration(
    override ?? defaultAssistantModel(),
    preferred,
    availableAgentSdks
  )
}

const PROVIDER_LABEL: Record<DataAssistantGeneration['provider'], string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode'
}

export const assistantProviderLabel = (provider: string): string =>
  PROVIDER_LABEL[provider as DataAssistantGeneration['provider']] ?? provider

/** Short model name for the header: `claude-opus-4-5-20251101` → `opus 4.5`, `anthropic/x` → `x`. */
export function shortModelName(model: string): string {
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(bare)
  if (claude) return `${claude[1].toLowerCase()} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  return bare
}

/** "Claude Code · opus 4.5 · high" (provider, then model and effort when known). */
export function describeAssistantGeneration(generation: DataAssistantGeneration | null): string {
  if (!generation) return 'No AI provider available'
  return [
    assistantProviderLabel(generation.provider),
    generation.model ? shortModelName(generation.model) : null,
    generation.effort ?? null
  ]
    .filter(Boolean)
    .join(' · ')
}
