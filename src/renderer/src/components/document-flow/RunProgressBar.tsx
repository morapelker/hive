import { cn } from '@/lib/utils'
import type { ProgressSegment } from './document-flow-ui'

interface RunProgressBarProps {
  segments: readonly ProgressSegment[]
  className?: string
}

/** The segmented bar of a run: one slice per group of tickets, as wide as the group is large. */
export function RunProgressBar({ segments, className }: RunProgressBarProps): React.JSX.Element {
  return (
    <div
      className={cn('flex h-1.5 min-w-0 gap-px overflow-hidden rounded-full bg-muted', className)}
      data-testid="docflow-progress-bar"
    >
      {segments.map((segment) => (
        <div
          key={segment.key}
          className={segment.className}
          style={{ flexGrow: segment.count }}
          title={`${segment.count} ${segment.label}`}
          data-testid={`docflow-progress-${segment.key}`}
        />
      ))}
    </div>
  )
}
