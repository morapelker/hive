import { useEffect, useRef } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { TIP_DEFINITIONS } from '@/lib/tip-definitions'
import { useTipStore } from '@/stores/useTipStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { cn } from '@/lib/utils'

interface TipProps {
  tipId: string
  children: React.ReactNode
  /** For action-triggered tips, parent controls when to show */
  enabled?: boolean
}

export function Tip({ tipId, children, enabled = true }: TipProps): React.JSX.Element {
  const definition = TIP_DEFINITIONS[tipId]
  const activeTipId = useTipStore((s) => s.activeTipId)
  const requestTip = useTipStore((s) => s.requestTip)
  const dismissTip = useTipStore((s) => s.dismissTip)
  const disableAllTips = useTipStore((s) => s.disableAllTips)
  const isTipSeen = useTipStore((s) => s.isTipSeen)
  const tipsEnabled = useSettingsStore((s) => s.tipsEnabled)

  const isOpen = activeTipId === tipId
  const seen = isTipSeen(tipId)
  const prevEnabled = useRef(enabled)

  // Mount-triggered tips: request when mounted and enabled
  // tipsEnabled in deps so tips re-fire when re-enabled from settings
  useEffect(() => {
    if (!definition || seen || !tipsEnabled) return
    if (definition.trigger === 'mount' && enabled) {
      requestTip(tipId)
    }
  }, [tipId, definition, enabled, seen, tipsEnabled, requestTip])

  // Action-triggered tips: request when enabled transitions to true
  useEffect(() => {
    if (!definition || seen || !tipsEnabled) return
    if (definition.trigger === 'action' && enabled && !prevEnabled.current) {
      requestTip(tipId)
    }
    prevEnabled.current = enabled
  }, [tipId, definition, enabled, seen, tipsEnabled, requestTip])

  if (!definition) {
    return <>{children}</>
  }

  const handleDismiss = (): void => {
    dismissTip(tipId)
  }

  const handleDisableAll = (): void => {
    dismissTip(tipId)
    disableAllTips()
  }

  return (
    <Popover open={isOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      {isOpen && (
        <PopoverContent
          side={definition.side ?? 'bottom'}
          align={definition.align ?? 'center'}
          sideOffset={8}
          className={cn(
            'w-64 p-0 overflow-hidden',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95'
          )}
          onInteractOutside={handleDismiss}
          onEscapeKeyDown={handleDismiss}
        >
          <div className="flex">
            {/* Accent left border */}
            <div className="w-[3px] shrink-0 bg-primary" />
            <div className="flex-1 p-3 space-y-2.5">
              <p className="text-sm text-popover-foreground leading-relaxed">
                {definition.description}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleDismiss}
                >
                  Got it
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={handleDisableAll}
                >
                  Don't show tips
                </Button>
              </div>
            </div>
          </div>
        </PopoverContent>
      )}
    </Popover>
  )
}
