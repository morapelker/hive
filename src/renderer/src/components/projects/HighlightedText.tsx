import { toHighlightRuns } from '@/lib/highlight-runs'

interface HighlightedTextProps {
  text: string
  indices: number[]
  className?: string
}

export function HighlightedText({
  text,
  indices,
  className
}: HighlightedTextProps): React.JSX.Element {
  return (
    <span className={className}>
      {toHighlightRuns(text, indices).map((run, i) =>
        run.hit ? (
          <span key={i} className="text-foreground font-semibold">
            {run.text}
          </span>
        ) : (
          run.text
        )
      )}
    </span>
  )
}
