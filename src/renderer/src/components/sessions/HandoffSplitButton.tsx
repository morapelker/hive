import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  getAvailableHandoffAgentSdks,
  getEffectiveHandoffSelection,
  loadHandoffModelCatalog,
  type HandoffSelectionOverride
} from '@/lib/handoffSelection'
import { setHandoffPickerOpen } from '@/lib/handoff-ui-state'
import { cn } from '@/lib/utils'
import { supportsGoalMode } from '@shared/types/agent-sdk'
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
  /** Source session, when known — scopes the picker-open guard that keeps the plan card / ticket modal alive during selection. */
  sessionId?: string
  onHandoff: (override: HandoffSelectionOverride) => void
  vimModeEnabled?: boolean
  testIdPrefix?: string
  disabled?: boolean
}

export function HandoffSplitButton({
  worktreeId,
  sessionId,
  onHandoff,
  vimModeEnabled = false,
  testIdPrefix = 'plan-ready',
  disabled = false
}: HandoffSplitButtonProps): React.JSX.Element {
  const availableAgentSdks = useSettingsStore((state) => state.availableAgentSdks)
  const customProviders = useSettingsStore((state) => state.customProviders)
  const lastHandoffOverride = useSettingsStore((state) => state.lastHandoffOverride)
  const defaultAgentSdk = useSettingsStore((state) => state.defaultAgentSdk)
  const defaultModels = useSettingsStore((state) => state.defaultModels)
  const selectedModel = useSettingsStore((state) => state.selectedModel)
  const selectedModelByProvider = useSettingsStore((state) => state.selectedModelByProvider)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [catalogVersion, setCatalogVersion] = useState(0)
  const [goalMode, setGoalMode] = useState(false)
  const pickerId = useId()
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setHandoffPickerOpen(pickerId, sessionId ?? null, pickerOpen)
    return () => {
      setHandoffPickerOpen(pickerId, sessionId ?? null, false)
    }
  }, [pickerId, sessionId, pickerOpen])

  // If something still hides or unmounts this button while the picker popover
  // is open (its content is portalled to <body>), the popover would survive
  // with a zero-size anchor and teleport to the viewport corner. Close it
  // instead. Only trip after the anchor has been measured with a real size so
  // layout-less environments (jsdom) never see a false collapse.
  useEffect(() => {
    if (!pickerOpen) return
    const el = containerRef.current
    if (!el) return

    let hadSize = false
    const check = (): void => {
      const rect = el.getBoundingClientRect()
      const visible = rect.width > 0 && rect.height > 0
      if (visible) {
        hadSize = true
      } else if (hadSize) {
        setPickerOpen(false)
      }
    }

    check()
    const interval = window.setInterval(check, 200)
    return () => window.clearInterval(interval)
  }, [pickerOpen])

  const availableHandoffSdks = getAvailableHandoffAgentSdks(availableAgentSdks)
  const launchableCustomProviders = availableHandoffSdks.includes('claude-code-cli')
    ? (customProviders ?? []).filter((p) => p.command.trim())
    : []
  const showChevron = availableHandoffSdks.length + launchableCustomProviders.length > 1
  void availableAgentSdks
  void lastHandoffOverride
  void defaultAgentSdk
  void defaultModels
  void selectedModel
  void selectedModelByProvider
  void catalogVersion
  const effective = getEffectiveHandoffSelection({ worktreeId })
  const isGoalModeActive = goalMode && supportsGoalMode(effective.agentSdk)

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

  useEffect(() => {
    if (!supportsGoalMode(effective.agentSdk)) {
      setGoalMode(false)
    }
  }, [effective.agentSdk])

  const withGoalMode = (override: HandoffSelectionOverride): HandoffSelectionOverride => {
    const finalGoalMode = supportsGoalMode(override.agentSdk) ? isGoalModeActive : false
    return { ...override, goalMode: finalGoalMode }
  }

  const labelTitle = effective.customProviderId
    ? `Handoff · ${effective.display.sdkName}`
    : `Handoff · ${effective.display.sdkName} / ${effective.display.modelName}${
        effective.display.variant ? ` ${effective.display.variant.toUpperCase()}` : ''
      }`
  const leftButtonTestId =
    testIdPrefix === 'plan-review' ? `${testIdPrefix}-handoff-btn` : `${testIdPrefix}-handoff-fab`
  const chevronTestId = `${testIdPrefix}-handoff-chevron`

  return (
    <div
      ref={containerRef}
      className={cn(
        'inline-flex h-8 items-center rounded-full border text-foreground shadow-md transition-colors duration-200',
        isGoalModeActive ? 'relative border-primary/40 bg-primary/15' : 'border-border bg-muted/80',
        disabled ? 'opacity-60' : isGoalModeActive ? 'hover:bg-primary/20' : 'hover:bg-muted'
      )}
      onContextMenu={(e) => {
        e.preventDefault()
        if (disabled) return
        if (!supportsGoalMode(effective.agentSdk)) return
        setGoalMode((current) => !current)
      }}
    >
      {isGoalModeActive && (
        <span className="pointer-events-none absolute -top-4 left-1/2 -translate-x-1/2 text-[10px] font-semibold uppercase tracking-wide text-primary">
          Goal mode
        </span>
      )}
      <button
        type="button"
        title={labelTitle}
        aria-label={labelTitle}
        disabled={disabled}
        data-testid={leftButtonTestId}
        onClick={() => {
          onHandoff(
            withGoalMode({
              agentSdk: effective.agentSdk,
              customProviderId: effective.customProviderId,
              model: effective.model
            })
          )
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
        {effective.customProviderId ? (
          <span className="max-w-[180px] truncate">{effective.display.sdkName}</span>
        ) : (
          <>
            <span className="shrink-0">{effective.display.sdkName} /</span>
            <span className="max-w-[180px] truncate">{effective.display.modelName}</span>
          </>
        )}
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
            onConfirm={(override) => {
              // Unregister before dispatching so the handoff's own teardown
              // (plan clear, ticket sync, modal close) isn't guarded away.
              setHandoffPickerOpen(pickerId, sessionId ?? null, false)
              onHandoff(withGoalMode(override))
            }}
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
