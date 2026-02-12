interface QueuedIndicatorProps {
  count: number
}

export function QueuedIndicator({ count }: QueuedIndicatorProps): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <div className="text-xs text-muted-foreground px-3 py-1">
      {count} message{count > 1 ? 's' : ''} queued
    </div>
  )
}
