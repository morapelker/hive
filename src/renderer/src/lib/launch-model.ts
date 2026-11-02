// Default-model resolution for agent launches. Mirrors what a right-button quick launch does so
// "start it with the default model" runs exactly what the drag ghost would show.
import { FALLBACK_MODELS } from '@shared/model-resolution'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import { resolveModelForSdk, useSettingsStore, type SelectedModel } from '@/stores/useSettingsStore'

/** Byte-for-byte copy of the module-private resolveRowDefaultModel(sdk, 'build') in WorktreePickerModal.tsx. */
export function resolveDefaultLaunchModel(sdk: HandoffAgentSdk): SelectedModel {
  const settings = useSettingsStore.getState()
  const modeModel = settings.getModelForMode('build')
  if (modeModel && modeModel.agentSdk === sdk) return modeModel
  const resolved = resolveModelForSdk(sdk) ?? FALLBACK_MODELS[sdk]
  return { providerID: resolved.providerID, modelID: resolved.modelID, variant: resolved.variant }
}
