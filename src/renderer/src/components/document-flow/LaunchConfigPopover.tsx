import { useEffect, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import { LaunchConfigPicker } from './LaunchConfigPicker'

const LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

interface LaunchConfigPopoverProps {
  itemKey: string
  /** What the picker starts from; null offers "Choose model". */
  value: DocumentRunLaunchConfig | null
  /** What the trigger shows next to its arrows: the ticket's model badge, or nothing. */
  badge: React.ReactNode
  /** What a null value means in the picker, e.g. "Run default". */
  inheritLabel: string
  /** Label of the picker button that goes back to the inherited config. */
  clearLabel: string
  /** Tooltip of the trigger. */
  title?: string
  /**
   * Prefix of the test ids: `-trigger-{key}` for the trigger, `-picker-{key}` for the picker.
   */
  testIdPrefix: string
  /** Saves one step of the pick; the popover counts it as pending until it settles. */
  onChange: (value: DocumentRunLaunchConfig | null) => Promise<unknown>
  /**
   * Reports whether the model is still being picked: the picker is open, or a pick is on its
   * way to the server. The picker saves every step, so the model is not final meanwhile.
   */
  onPickingChange?: (picking: boolean) => void
  /** Shown under the picker once every pick has landed, e.g. "also use for other tickets". */
  footer?: React.ReactNode
}

/**
 * A ticket's model and effort behind its badge: click the badge, pick in the popover. Every
 * step is saved as it is made; the picker (and its model catalog request) only mounts while the
 * popover is open, so a list of tickets costs nothing until one is clicked.
 */
export function LaunchConfigPopover({
  itemKey,
  value,
  badge,
  inheritLabel,
  clearLabel,
  title = 'Change model and effort',
  testIdPrefix,
  onChange,
  onPickingChange,
  footer
}: LaunchConfigPopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pendingPicks, setPendingPicks] = useState(0)
  const picking = open || pendingPicks > 0
  useEffect(() => {
    onPickingChange?.(picking)
  }, [onPickingChange, picking])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Model and effort for ${itemKey}`}
          title={title}
          data-testid={`${testIdPrefix}-trigger-${itemKey}`}
          className={cn(
            'flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-md border border-transparent px-1.5 transition-colors hover:border-border hover:bg-accent/50 data-[state=open]:border-border data-[state=open]:bg-accent/50'
          )}
        >
          {badge}
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] space-y-1.5" data-docflow-dialog="">
        <p className={LABEL_CLASS}>Model for {itemKey}</p>
        <LaunchConfigPicker
          value={value}
          onChange={(next) => {
            setPendingPicks((count) => count + 1)
            void onChange(next).finally(() => setPendingPicks((count) => count - 1))
          }}
          inheritLabel={inheritLabel}
          clearLabel={clearLabel}
          testIdPrefix={`${testIdPrefix}-picker-${itemKey}`}
        />
        {pendingPicks === 0 && footer}
      </PopoverContent>
    </Popover>
  )
}
