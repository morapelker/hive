import dragonCorner from '@/assets/dragon-corner.png'
import { cn } from '@/lib/utils'

/**
 * How the dragon is lit: before launch, blue while the tickets are extracted and green once
 * they are ready; gold while the run is at work, silver otherwise, tarnished on error.
 */
export type EliteDragonLook = 'blue' | 'green' | 'gold' | 'silver' | 'silver-complete' | 'error'

interface EliteDragonIconProps {
  look: EliteDragonLook
  className?: string
}

/**
 * The full dragon an orchestrator ticket wears on its top-left corner, after the elite unit
 * frame in World of Warcraft: the head rests along the top edge looking right, the folded wing,
 * claws and tail grip the left edge. Sized and placed by `.ticket-elite-ornament`.
 */
export function EliteDragonIcon({ look, className }: EliteDragonIconProps): React.JSX.Element {
  return (
    <img
      src={dragonCorner}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-testid="ticket-elite-dragon"
      data-look={look}
      data-active={look === 'gold' ? '' : undefined}
      className={cn('ticket-elite-ornament', className)}
    />
  )
}
