import { useCallback, useMemo } from 'react'
import { CodexFastToggle } from '@/components/sessions/CodexFastToggle'
import { CustomProviderModelSelector } from '@/components/sessions/CustomProviderModelSelector'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { Button } from '@/components/ui/button'
import {
  getAvailableHandoffAgentSdks,
  resolveCustomProviderSelectedModel
} from '@/lib/handoffSelection'
import { isWindows } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
  resolveModelForSdk,
  resolvePreferredAgentSdk,
  useSettingsStore,
  type SelectedModel
} from '@/stores/useSettingsStore'
import { FALLBACK_MODELS } from '@shared/model-resolution'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import { findCustomProvider, type CustomClaudeProvider } from '@shared/types/custom-provider'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import { DOCUMENT_FLOW_SDK_LABELS } from './document-flow-launch'

const NO_CUSTOM_PROVIDERS: CustomClaudeProvider[] = []

type LaunchModel = NonNullable<DocumentRunLaunchConfig['model']>

/** Launch configs carry the bare model; the picker's SDK stamp is routing detail. */
function toLaunchModel(model: {
  providerID: string
  modelID: string
  variant?: string
}): LaunchModel {
  return { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
}

/**
 * The model a ticket launched on `sdk` would get by default. Never inherits another SDK's
 * default: a variant picked for one SDK (ultracode above all) is not valid on the next.
 */
function defaultModelForSdk(sdk: HandoffAgentSdk): LaunchModel {
  const buildDefault = useSettingsStore.getState().getModelForMode('build')
  if (buildDefault && buildDefault.agentSdk === sdk) return toLaunchModel(buildDefault)
  return toLaunchModel(resolveModelForSdk(sdk) ?? FALLBACK_MODELS[sdk])
}

function launchConfigForSdk(
  sdk: HandoffAgentSdk,
  customProvider: CustomClaudeProvider | null
): DocumentRunLaunchConfig {
  if (customProvider) {
    return {
      sdk: 'claude-code-cli',
      model: resolveCustomProviderSelectedModel(customProvider, null),
      codexFastMode: false,
      customProviderId: customProvider.id
    }
  }
  return {
    sdk,
    model: defaultModelForSdk(sdk),
    codexFastMode: sdk === 'codex' && useSettingsStore.getState().codexFastMode,
    customProviderId: null
  }
}

interface LaunchConfigPickerProps {
  value: DocumentRunLaunchConfig | null
  onChange: (value: DocumentRunLaunchConfig | null) => void
  /** What a null value means here, e.g. "App default" or "Run default". */
  inheritLabel: string
  /** Label of the button that goes back to the inherited config. */
  clearLabel: string
  testIdPrefix: string
}

/**
 * SDK + model + effort for a document run or one of its tickets. The model catalog is only
 * fetched once a config is actually being chosen: mount this lazily (an expanded row, an
 * opened panel), never one per ticket up front.
 */
export function LaunchConfigPicker({
  value,
  onChange,
  inheritLabel,
  clearLabel,
  testIdPrefix
}: LaunchConfigPickerProps): React.JSX.Element {
  const availableAgentSdks = useSettingsStore((s) => s.availableAgentSdks)
  const rawCustomProviders = useSettingsStore((s) => s.customProviders)
  const codexFastModeAccepted = useSettingsStore((s) => s.codexFastModeAccepted)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const sdks = useMemo(() => getAvailableHandoffAgentSdks(availableAgentSdks), [availableAgentSdks])
  // Custom providers run a local shell command, which is not supported on Windows.
  const customProviders = useMemo(
    () =>
      isWindows()
        ? NO_CUSTOM_PROVIDERS
        : (rawCustomProviders ?? NO_CUSTOM_PROVIDERS).filter((provider) => provider.command.trim()),
    [rawCustomProviders]
  )

  const selectedModel = useMemo<SelectedModel | null>(
    () => (value?.model ? { ...value.model } : null),
    [value?.model]
  )
  const handleModelChange = useCallback(
    (model: SelectedModel) => {
      if (value) onChange({ ...value, model: toLaunchModel(model) })
    },
    [value, onChange]
  )

  if (!value) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground">{inheritLabel}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`${testIdPrefix}-choose`}
          onClick={() => onChange(launchConfigForSdk(resolvePreferredAgentSdk(), null))}
        >
          Choose model
        </Button>
      </div>
    )
  }

  const customProvider = findCustomProvider(customProviders, value.customProviderId) ?? null
  const sdkButtonClass = (active: boolean): string =>
    cn(
      'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
      active
        ? 'border-primary bg-primary text-primary-foreground'
        : 'border-border bg-muted/50 text-muted-foreground hover:bg-accent/50'
    )

  return (
    <div className="space-y-2" data-testid={testIdPrefix}>
      <div className="flex flex-wrap gap-1.5">
        {sdks.map((sdk) => {
          const active = value.sdk === sdk && !value.customProviderId
          return (
            <button
              key={sdk}
              type="button"
              data-testid={`${testIdPrefix}-sdk-${sdk}`}
              aria-pressed={active}
              className={sdkButtonClass(active)}
              onClick={() => {
                if (!active) onChange(launchConfigForSdk(sdk, null))
              }}
            >
              {DOCUMENT_FLOW_SDK_LABELS[sdk]}
            </button>
          )
        })}
        {customProviders.map((provider) => {
          const active = value.customProviderId === provider.id
          return (
            <button
              key={provider.id}
              type="button"
              data-testid={`${testIdPrefix}-sdk-custom-${provider.id}`}
              aria-pressed={active}
              className={sdkButtonClass(active)}
              onClick={() => {
                if (!active) onChange(launchConfigForSdk('claude-code-cli', provider))
              }}
            >
              {provider.name || 'Custom Provider'}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {customProvider ? (
          <CustomProviderModelSelector
            provider={customProvider}
            value={selectedModel}
            onChange={handleModelChange}
            testIdPrefix={`${testIdPrefix}-custom-model`}
          />
        ) : (
          <ModelSelector
            value={selectedModel}
            onChange={handleModelChange}
            agentSdkOverride={value.sdk}
          />
        )}
        {value.sdk === 'codex' && (
          <CodexFastToggle
            enabled={value.codexFastMode}
            accepted={codexFastModeAccepted}
            onToggle={() => onChange({ ...value, codexFastMode: !value.codexFastMode })}
            onAccept={() => updateSetting('codexFastModeAccepted', true)}
          />
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto text-muted-foreground"
          data-testid={`${testIdPrefix}-clear`}
          onClick={() => onChange(null)}
        >
          {clearLabel}
        </Button>
      </div>
    </div>
  )
}
