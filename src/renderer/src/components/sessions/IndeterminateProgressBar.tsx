import { useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import type { SessionMode } from '@/stores/useSessionStore'

interface IndeterminateProgressBarProps {
  mode: SessionMode
  isAsking?: boolean
  isCompacting?: boolean
  isReviewing?: boolean
  isFixingConflicts?: boolean
  className?: string
}

const ANIMATION_DURATION_MS = 3000

// Web Animations API keyframes — mirrors the CSS @keyframes progress-bounce.
// 6-phase bouncing worm: grow → slide → shrink → grow → slide back → shrink.
// Animates ONLY `transform` (translateX + scaleX) so the animation is GPU-composited
// and keeps running smoothly even when the main thread is congested. The bar is 25%
// of the track wide; translateX is in multiples of its own width (400% == full track),
// scaleX grows/shrinks it from its left edge (transform-origin: left).
const BOUNCE_KEYFRAMES: Keyframe[] = [
  { transform: 'translateX(0) scaleX(0)', offset: 0 },
  { transform: 'translateX(0) scaleX(1)', offset: 0.12 },
  { transform: 'translateX(300%) scaleX(1)', offset: 0.38 },
  { transform: 'translateX(400%) scaleX(0)', offset: 0.5 },
  { transform: 'translateX(300%) scaleX(1)', offset: 0.62 },
  { transform: 'translateX(0) scaleX(1)', offset: 0.88 },
  { transform: 'translateX(0) scaleX(0)', offset: 1 }
]

const BOUNCE_TIMING: KeyframeAnimationOptions = {
  duration: ANIMATION_DURATION_MS,
  iterations: Infinity,
  easing: 'linear'
}

export function IndeterminateProgressBar({
  mode,
  isAsking,
  isCompacting,
  isReviewing,
  isFixingConflicts,
  className
}: IndeterminateProgressBarProps) {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = barRef.current
    if (!el) return

    try {
      const anim = el.animate(BOUNCE_KEYFRAMES, BOUNCE_TIMING)

      // Sync to global clock so every bar — regardless of when it mounts — is
      // at the same phase in the 3-second cycle. This is the key fix: setting
      // currentTime directly is deterministic and avoids CSS animation-delay quirks.
      anim.currentTime = Date.now() % ANIMATION_DURATION_MS

      return () => anim.cancel()
    } catch {
      // Animation failed — bar stays visible at CSS default position
    }
    return undefined
  }, [])

  const bgTrack = isFixingConflicts
    ? 'bg-fuchsia-500/15'
    : isCompacting
    ? 'bg-red-500/15'
    : isAsking
      ? 'bg-amber-500/15'
      : isReviewing
        ? 'bg-green-500/15'
        : mode === 'build'
          ? 'bg-blue-500/15'
          : mode === 'super-plan'
            ? 'bg-orange-500/15'
            : 'bg-violet-500/15'
  const bgBar = isFixingConflicts
    ? 'bg-fuchsia-500'
    : isCompacting
    ? 'bg-red-500'
    : isAsking
      ? 'bg-amber-500'
      : isReviewing
        ? 'bg-green-500'
        : mode === 'build'
          ? 'bg-blue-500'
          : mode === 'super-plan'
            ? 'bg-orange-500'
            : 'bg-violet-500'

  return (
    <div className={cn('flex flex-col items-center w-36', className)}>
      {isCompacting && (
        <span className="text-[10px] font-semibold text-red-500 leading-none mb-0.5">
          Compacting
        </span>
      )}
      <div
        role="progressbar"
        aria-label={
          isFixingConflicts
            ? 'Fixing merge conflicts'
            : isCompacting
              ? 'Compacting conversation'
              : isAsking
                ? 'Waiting for answer'
                : 'Agent is working'
        }
        className={cn('relative w-full h-4 rounded-full overflow-hidden', bgTrack)}
      >
        <div
          ref={barRef}
          className={cn('progress-bounce-bar absolute top-0 bottom-0 rounded-full', bgBar)}
        />
      </div>
    </div>
  )
}
