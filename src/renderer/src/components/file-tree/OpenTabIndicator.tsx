import { cn } from '@/lib/utils'
import type { FileTabState } from '@/hooks/useFileTabState'
import { TAB_MARKER_CLASS } from '@/lib/tab-styles'

/**
 * Bar on the left edge of a file list row marking the file as open in a tab.
 * The row needs `relative` for this to position correctly.
 */
export function OpenTabIndicator({ state }: { state: FileTabState }): React.JSX.Element | null {
  if (!state) return null

  return (
    <span
      className={cn(
        'absolute left-0 top-0 bottom-0 w-0.5 rounded-r',
        TAB_MARKER_CLASS,
        state === 'open' && 'opacity-40'
      )}
      aria-hidden="true"
    />
  )
}
