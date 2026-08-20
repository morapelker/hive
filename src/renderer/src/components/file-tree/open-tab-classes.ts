import type { FileTabState } from '@/hooks/useFileTabState'
import { TAB_ACTIVE_SURFACE_CLASS } from '@/lib/tab-styles'

/** Row background for the file that is open in the active tab, matching that tab. */
export function activeTabRowClass(state: FileTabState): string | undefined {
  return state === 'active' ? TAB_ACTIVE_SURFACE_CLASS : undefined
}
