import { Ban, Shuffle } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The auto-switch (shuffle) glyph inside a "banned" sign: the account is
 * guarded from the auto-switch rotation. `active` paints the ban ring red so a
 * removed account reads as important at a glance.
 */
export function AutoSwitchBanIcon({
  className,
  active = false
}: {
  className?: string
  active?: boolean
}): React.JSX.Element {
  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      aria-hidden="true"
    >
      <Shuffle className="h-[58%] w-[58%]" strokeWidth={2.5} />
      <Ban
        className={cn(
          'absolute inset-0 h-full w-full',
          active ? 'text-destructive' : 'text-current'
        )}
        strokeWidth={2.25}
      />
    </span>
  )
}
