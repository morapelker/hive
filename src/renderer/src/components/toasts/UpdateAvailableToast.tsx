import { Download } from 'lucide-react'

interface UpdateAvailableToastProps {
  version: string
  onDownload: () => void
  onLater: () => void
  onSkip: () => void
}

export function UpdateAvailableToast({
  version,
  onDownload,
  onLater,
  onSkip
}: UpdateAvailableToastProps): React.JSX.Element {
  return (
    <div className="flex w-[360px] flex-col gap-3 rounded-xl border border-border bg-background p-4 shadow-xl">
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 text-blue-500" />
        <span className="text-sm font-medium text-foreground">Update v{version} available</span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onLater}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Later
        </button>
        <button
          onClick={onSkip}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Skip this version
        </button>
        <button
          onClick={onDownload}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Download
        </button>
      </div>
    </div>
  )
}
