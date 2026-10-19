import { useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import type { SessionMode } from '@/stores/useSessionStore'

interface IndeterminateProgressBarProps {
  mode: SessionMode
  isAsking?: boolean
  isCompacting?: boolean
  isReviewing?: boolean
  isFixingConflicts?: boolean
  /** A session is executing a document run's migrations. */
  isRunningMigrations?: boolean
  /** A merged ticket's session is updating the document its document run was made from. */
  isEditingDocument?: boolean
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
  isRunningMigrations,
  isEditingDocument,
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

  // Status hues: conflicts = error red, compacting = amber (red stays unambiguous),
  // editing the run's document = pink, reviewing = done emerald, migrations = fuchsia (no
  // other state wears it), then build blue / super-plan orange / plan violet. Pink and
  // fuchsia sit close, so the accessible name (and the label beside the bar) tells them apart.
  const bgBar = isFixingConflicts
    ? 'bg-red-500'
    : isCompacting
      ? 'bg-amber-500'
      : isAsking
        ? 'bg-amber-500'
        : isEditingDocument
          ? 'bg-pink-500'
          : isReviewing
            ? 'bg-emerald-500'
            : isRunningMigrations
              ? 'bg-fuchsia-500'
              : mode === 'super-plan' || mode === 'super-build'
                ? 'bg-orange-500'
                : mode === 'build'
                  ? 'bg-blue-500'
                  : 'bg-violet-500'

  return (
    <div className={cn('flex flex-col items-center w-14', className)}>
      {isCompacting && (
        <span className="text-[10px] font-medium text-amber-500 leading-none mb-1">Compacting</span>
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
                : isEditingDocument
                  ? 'Editing document'
                  : isRunningMigrations
                    ? 'Running migrations'
                    : 'Agent is working'
        }
        className="relative w-full h-[3px] rounded-[2px] overflow-hidden bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]"
      >
        <div
          ref={barRef}
          className={cn('progress-bounce-bar absolute top-0 bottom-0 rounded-[2px]', bgBar)}
        />
      </div>
    </div>
  )
}
