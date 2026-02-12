interface StreamingCursorProps {
  className?: string
}

export function StreamingCursor({ className }: StreamingCursorProps): React.JSX.Element {
  return (
    <span
      className={`inline-block w-2 h-4 bg-foreground/70 animate-pulse ml-0.5 rounded-sm ${className || ''}`}
      data-testid="streaming-cursor"
    />
  )
}
