import { useFileViewerStore, tabAbsolutePath, isSameFilePath } from '@/stores/useFileViewerStore'

/** How a file relates to the open tabs: the active tab, open in a background tab, or not open. */
export type FileTabState = 'active' | 'open' | null

/**
 * Tells a file list row whether its file is open in a tab, so it can show an
 * active file indicator. Returns a scalar so unaffected rows do not re-render.
 * Pass null for rows that can never have a tab, like folders.
 */
export function useFileTabState(absolutePath: string | null): FileTabState {
  return useFileViewerStore((state) => {
    if (!absolutePath) return null
    const activeTab = state.activeFilePath ? state.openFiles.get(state.activeFilePath) : undefined
    const activePath = activeTab ? tabAbsolutePath(activeTab) : null
    if (activePath && isSameFilePath(activePath, absolutePath)) return 'active'
    for (const tab of state.openFiles.values()) {
      const path = tabAbsolutePath(tab)
      if (path && isSameFilePath(path, absolutePath)) return 'open'
    }
    return null
  })
}
