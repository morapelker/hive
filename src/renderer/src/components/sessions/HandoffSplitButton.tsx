import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  getAvailableHandoffAgentSdks,
  getEffectiveHandoffSelection,
  loadHandoffModelCatalog,
  type HandoffSelectionOverride
} from '@/lib/handoffSelection'
import { cn } from '@/lib/utils'
import { HandoffModelPicker } from './HandoffModelPicker'
import { useSettingsStore } from '@/stores/useSettingsStore'

function MnemonicLabel({ letter, label }: { letter: string; label: string }): React.JSX.Element {
  const index = label.toLowerCase().indexOf(letter.toLowerCase())
  if (index === -1) return <span>{label}</span>

  return (
    <span>
      {label.slice(0, index)}
      <span className="font-semibold underline underline-offset-2 decoration-2">
        {label[index]}
      </span>
      {label.slice(index + 1)}
    </span>
  )
}

interface HandoffSplitButtonProps {
  worktreeId?: string
  onHandoff: (override: HandoffSelectionOverride) => void
  vimModeEnabled?: boolean
  testIdPrefix?: string
  disabled?: boolean
}

export function HandoffSplitButton({
  worktreeId,
  onHandoff,
  vimModeEnabled = false,
  testIdPrefix = 'plan-ready',
  disabled = false
}: HandoffSplitButtonProps): React.JSX.Element {
  const availableAgentSdks = useSettingsStore((state) => state.availableAgentSdks)
  const lastHandoffOverride = useSettingsStore((state) => state.lastHandoffOverride)
  const defaultAgentSdk = useSettingsStore((state) => state.defaultAgentSdk)
  const defaultModels = useSettingsStore((state) => state.defaultModels)
  const selectedModel = useSettingsStore((state) => state.selectedModel)
  const selectedModelByProvider = useSettingsStore((state) => state.selectedModelByProvider)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [catalogVersion, setCatalogVersion] = useState(0)

  const showChevron = getAvailableHandoffAgentSdks(availableAgentSdks).length > 1
  void availableAgentSdks
  void lastHandoffOverride
  void defaultAgentSdk
  void defaultModels
  void selectedModel
  void selectedModelByProvider
  void catalogVersion
  const effective = getEffectiveHandoffSelection({ worktreeId })

  useEffect(() => {
    let active = true
    void loadHandoffModelCatalog(effective.agentSdk).then(() => {
      if (active) {
        setCatalogVersion((current) => current + 1)
      }
    })

    return () => {
      active = false
    }
  }, [effective.agentSdk])

  const labelTitle = `Handoff · ${effective.display.sdkName} / ${effective.display.modelName}${
    effective.display.variant ? ` ${effective.display.variant.toUpperCase()}` : ''
  }`
  const leftButtonTestId =
    testIdPrefix === 'plan-review'
      ? `${testIdPrefix}-handoff-btn`
      : `${testIdPrefix}-handoff-fab`
  const chevronTestId = `${testIdPrefix}-handoff-chevron`

  return (
    <div
      className={cn(
        'inline-flex h-8 items-center rounded-full border border-border bg-muted/80 text-foreground shadow-md transition-colors duration-200',
        disabled ? 'opacity-60' : 'hover:bg-muted'
      )}
    >
      <button
        type="button"
        title={labelTitle}
        aria-label={labelTitle}
        disabled={disabled}
        data-testid={leftButtonTestId}
        onClick={() => {
          onHandoff({ agentSdk: effective.agentSdk, model: effective.model })
        }}
        className={cn(
          'flex min-w-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium',
          'disabled:pointer-events-none'
        )}
      >
        <span className="shrink-0">
          {vimModeEnabled ? <MnemonicLabel letter="a" label="Handoff" /> : 'Handoff'}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="shrink-0">{effective.display.sdkName} /</span>
        <span className="max-w-[180px] truncate">{effective.display.modelName}</span>
        {effective.display.variant && (
          <span className="rounded-full border border-border/80 bg-background/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            {effective.display.variant}
          </span>
        )}
      </button>

      {showChevron && (
        <>
          <div className="h-5 w-px self-center bg-border" />
          <HandoffModelPicker
            open={pickerOpen}
            onOpenChange={(open) => {
              if (!disabled) setPickerOpen(open)
            }}
            worktreeId={worktreeId}
            onConfirm={onHandoff}
            anchor={
              <button
                type="button"
                aria-label="Open handoff model picker"
                disabled={disabled}
                data-testid={chevronTestId}
                className={cn(
                  'flex h-full items-center justify-center rounded-r-full px-2.5 text-muted-foreground transition-colors',
                  'hover:text-foreground disabled:pointer-events-none'
                )}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            }
          />
        </>
      )}
    </div>
  )
}
