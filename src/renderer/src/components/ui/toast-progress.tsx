export interface ToastProgressProps {
  /** Steps finished so far. */
  done: number
  /** Steps in all. */
  total: number
}

/** The bar under the message of a progress toast (`toast.progress`), with its count. */
export function ToastProgress({ done, total }: ToastProgressProps): React.JSX.Element {
  const max = Math.max(total, 0)
  const now = Math.min(Math.max(done, 0), max)
  const percent = max === 0 ? 0 : Math.round((now / max) * 100)

  return (
    <div className="mt-1.5 flex items-center gap-2" data-testid="toast-progress">
      <div
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--foreground)_12%,transparent)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={now}
      >
        <div
          className="h-full rounded-full bg-sky-500 transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums">
        {now}/{max}
      </span>
    </div>
  )
}
