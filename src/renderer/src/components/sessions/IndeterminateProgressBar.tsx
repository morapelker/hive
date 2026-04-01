import { useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import type { SessionMode } from '@/stores/useSessionStore'

interface IndeterminateProgressBarProps {
  mode: SessionMode
  isAsking?: boolean
  isCompacting?: boolean
  className?: string
}

const ANIMATION_DURATION_MS = 3000

// Web Animations API keyframes — mirrors the CSS @keyframes progress-bounce
// 6-phase bouncing worm: grow → slide → shrink → grow → slide back → shrink
const BOUNCE_KEYFRAMES: Keyframe[] = [
  { left: '0%', right: '100%', offset: 0 },
  { left: '0%', right: '75%', offset: 0.12 },
  { left: '75%', right: '0%', offset: 0.38 },
  { left: '100%', right: '0%', offset: 0.5 },
  { left: '75%', right: '0%', offset: 0.62 },
  { left: '0%', right: '75%', offset: 0.88 },
  { left: '0%', right: '100%', offset: 1 }
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
  className
}: IndeterminateProgressBarProps) {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = barRef.current
    if (!el) return

    // Respect prefers-reduced-motion — CSS fallback handles static positioning
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const anim = el.animate(BOUNCE_KEYFRAMES, BOUNCE_TIMING)

    // Sync to global clock so every bar — regardless of when it mounts — is
    // at the same phase in the 3-second cycle. This is the key fix: setting
    // currentTime directly is deterministic and avoids CSS animation-delay quirks.
    anim.currentTime = Date.now() % ANIMATION_DURATION_MS

    return () => anim.cancel()
  }, [])

  const bgTrack = isCompacting
    ? 'bg-red-500/15'
    : isAsking
      ? 'bg-amber-500/15'
      : mode === 'build'
        ? 'bg-blue-500/15'
        : mode === 'super-plan'
          ? 'bg-orange-500/15'
          : 'bg-violet-500/15'
  const bgBar = isCompacting
    ? 'bg-red-500'
    : isAsking
      ? 'bg-amber-500'
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
        aria-label={isCompacting ? 'Compacting conversation' : isAsking ? 'Waiting for answer' : 'Agent is working'}
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
