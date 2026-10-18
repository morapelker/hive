import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * Lucide's Shuffle glyph with an "Off" slash (same treatment as WifiOff /
 * BellOff): a diagonal slash with a gap cut around it so the arrows break
 * where it crosses. The gap is a mask, so it is transparent on any surface.
 * Marks an account removed from the auto-switch rotation; uses `currentColor`.
 */
export function ShuffleOffIcon({ className }: { className?: string }): React.JSX.Element {
  const maskId = useId()
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0', className)}
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" />
          <path d="m2 2 20 20" stroke="black" strokeWidth={6} />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <path d="m18 14 4 4-4 4" />
        <path d="m18 2 4 4-4 4" />
        <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
        <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
        <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />
      </g>
      <path d="m2 2 20 20" />
    </svg>
  )
}
