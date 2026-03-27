import { cn } from '@/lib/utils'
import type { SessionMode } from '@/stores/useSessionStore'

interface IndeterminateProgressBarProps {
  mode: SessionMode
  isAsking?: boolean
  className?: string
}

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

  return (
    <div
      role="progressbar"
      aria-label={isAsking ? 'Waiting for answer' : 'Agent is working'}
      className={cn('relative w-36 h-4 rounded-full overflow-hidden', bgTrack, className)}
    >
      <div
        className={cn('progress-bounce-bar absolute top-0 bottom-0 rounded-full', bgBar)}
        style={{ animation: 'progress-bounce 3s linear infinite' }}
      />
    </div>
  )
}
