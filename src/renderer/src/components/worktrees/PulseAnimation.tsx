import { cn } from '@/lib/utils'

interface PulseAnimationProps {
  className?: string
}

export function PulseAnimation({ className }: PulseAnimationProps): React.JSX.Element {
  return (
    <svg className={cn('overflow-hidden', className)} viewBox="0 0 24 12" width="16" height="12">
      {/* CSS transform animation (see .pulse-wave in globals.css) instead of SVG SMIL,
          so it is GPU-composited and stays smooth when the main thread is busy. */}
      <g className="pulse-wave">
        <path
          d="M-12,6 Q-9,6 -8,2 Q-7,-2 -6,6 Q-5,14 -4,6 Q-3,6 0,6 Q3,6 4,2 Q5,-2 6,6 Q7,14 8,6 Q9,6 12,6 Q15,6 16,2 Q17,-2 18,6 Q19,14 20,6 Q21,6 24,6 Q27,6 28,2 Q29,-2 30,6 Q31,14 32,6 Q33,6 36,6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </g>
    </svg>
  )
}
