import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { SessionMode } from '@/stores/useSessionStore'

interface IndeterminateProgressBarProps {
  mode: SessionMode
  isAsking?: boolean
  className?: string
}

const ANIMATION_DURATION_MS = 3000

export function IndeterminateProgressBar({
  mode,
  isAsking,
  className
}: IndeterminateProgressBarProps) {
  const bgTrack = isAsking
    ? 'bg-amber-500/15'
    : mode === 'build'
      ? 'bg-blue-500/15'
      : 'bg-violet-500/15'
  const bgBar = isAsking ? 'bg-amber-500' : mode === 'build' ? 'bg-blue-500' : 'bg-violet-500'

  // Sync all progress bars to the same phase by using a negative animation-delay
  // based on a global clock. Lazy initializer ensures this runs exactly once at
  // mount — subsequent re-renders reuse the captured value so the CSS animation
  // isn't restarted.
  const [syncDelay] = useState(() => -(Date.now() % ANIMATION_DURATION_MS))

  return (
    <div
      role="progressbar"
      aria-label={isAsking ? 'Waiting for answer' : 'Agent is working'}
      className={cn('relative w-36 h-4 rounded-full overflow-hidden', bgTrack, className)}
    >
      <div
        className={cn('progress-bounce-bar absolute top-0 bottom-0 rounded-full', bgBar)}
        style={{
          animation: `progress-bounce ${ANIMATION_DURATION_MS}ms linear infinite`,
          animationDelay: `${syncDelay}ms`
        }}
      />
    </div>
  )
}
