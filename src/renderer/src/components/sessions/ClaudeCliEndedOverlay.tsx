interface ClaudeCliEndedOverlayProps {
  onRestart: () => void
}

export function ClaudeCliEndedOverlay({
  onRestart
}: ClaudeCliEndedOverlayProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onRestart}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/55 text-sm font-medium text-foreground backdrop-blur-[1px]"
      data-testid="claude-cli-ended-overlay"
    >
      Session ended - click to restart
    </button>
  )
}
