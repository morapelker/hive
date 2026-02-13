import ghosttyIcon from '@/assets/ghostty-icon.png'

interface GhosttyPromoToastProps {
  onActivate: () => void
  onDismiss: () => void
}

export function GhosttyPromoToast({
  onActivate,
  onDismiss
}: GhosttyPromoToastProps): React.JSX.Element {
  return (
    <div className="flex w-[360px] flex-col gap-3 rounded-xl border border-border bg-background p-4 shadow-xl">
      <div className="flex items-start gap-3">
        <img src={ghosttyIcon} alt="Ghostty" className="h-10 w-10 shrink-0 rounded-lg" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-foreground">Ghostty native terminal available</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Metal-accelerated rendering with your Ghostty config
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onDismiss}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Don&apos;t show again
        </button>
        <button
          onClick={onActivate}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Activate
        </button>
      </div>
    </div>
  )
}
