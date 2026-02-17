import { Download } from 'lucide-react'

interface UpdateProgressToastProps {
  version: string
  percent: number
}

export function UpdateProgressToast({
  version,
  percent
}: UpdateProgressToastProps): React.JSX.Element {
  const rounded = Math.round(percent)

  return (
    <div className="flex w-[356px] flex-col gap-2.5 rounded-xl border border-border bg-background p-4 shadow-xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-medium text-foreground">
            Downloading v{version}...
          </span>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {rounded}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-blue-500 transition-all duration-300 ease-out"
          style={{ width: `${rounded}%` }}
        />
      </div>
    </div>
  )
}
