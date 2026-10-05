import { useId } from 'react'
import { cn } from '@/lib/utils'

interface EliteDragonIconProps {
  /** Gold while the ticket is at work; otherwise the gray of a card's border. */
  active: boolean
  className?: string
}

/**
 * The dragon head an orchestrator ticket wears on its top right corner, after the elite
 * unit frame in World of Warcraft.
 */
export function EliteDragonIcon({ active, className }: EliteDragonIconProps): React.JSX.Element {
  const gradientId = useId()
  const line = active ? '#4a2c00' : 'currentColor'
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      data-testid="ticket-elite-dragon"
      data-active={active ? '' : undefined}
      className={cn('text-muted-foreground/60', className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff1b8" />
          <stop offset=".45" stopColor="#f0b429" />
          <stop offset="1" stopColor="#9a5b00" />
        </linearGradient>
      </defs>
      <path
        d="M4 30 L8 26 L20 24 L28 18 L34 16 L58 2 L42 18 L62 14 L46 26 L56 30 L48 34 L54 42 L46 42 L50 62 L34 62 L34 50 L30 46 L10 46 L8 42 L27 37 L22 33 L18 37 L15 32 L11 36 L9 31 Z"
        fill={active ? `url(#${gradientId})` : 'var(--muted)'}
        stroke={line}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M23 26 L32 21 L30 27 Z" fill={active ? '#3b1d00' : 'currentColor'} />
      <circle cx="10" cy="28.5" r="1.2" fill={line} />
      <path
        d="M38 22 L44 30 M40 46 L44 56"
        fill="none"
        stroke={line}
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity=".6"
      />
    </svg>
  )
}
