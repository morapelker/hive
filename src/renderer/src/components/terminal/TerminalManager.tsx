import { useRef, useCallback, useEffect } from 'react'
import { TerminalView, type TerminalViewHandle } from './TerminalView'
import { TerminalTabSidebar } from './TerminalTabSidebar'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useTerminalTabStore } from '@/stores/useTerminalTabStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useShallow } from 'zustand/react/shallow'

interface TerminalManagerProps {
  /** The currently selected worktree ID (null if none selected) */
  selectedWorktreeId: string | null
  /** The worktree path for the selected worktree */
  worktreePath: string | null
  /** Whether the terminal tab is currently visible */
  isVisible: boolean
}

/**
 * TerminalManager renders one TerminalView per tab across all worktrees,
 * with a TerminalTabSidebar for the currently selected worktree.
 *
 * All tabs are kept mounted (CSS hidden) to preserve PTY state.
 * The tab store owns terminal identity — no activeWorktreesRef needed.
 */
export function TerminalManager({
  selectedWorktreeId,
  worktreePath,
  isVisible
}: TerminalManagerProps): React.JSX.Element {
  // Map worktreeId -> path for resolving CWD of non-selected worktrees' tabs
  const worktreePathsRef = useRef<Map<string, string>>(new Map())
  const terminalRefsMap = useRef<Map<string, React.RefObject<TerminalViewHandle | null>>>(new Map())

  const destroyTerminal = useTerminalStore((s) => s.destroyTerminal)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const embeddedTerminalBackend = useSettingsStore((s) => s.embeddedTerminalBackend)
  const prevBackendRef = useRef(embeddedTerminalBackend)

  const { tabsByWorktree, activeTabByWorktree, createTab, removeWorktree, removeAllTabs } =
    useTerminalTabStore(
      useShallow((s) => ({
        tabsByWorktree: s.tabsByWorktree,
        activeTabByWorktree: s.activeTabByWorktree,
        createTab: s.createTab,
        removeWorktree: s.removeWorktree,
        removeAllTabs: s.removeAllTabs
      }))
    )

  // Get or create a ref for a tab's terminal
  const getTerminalRef = useCallback(
    (tabId: string): React.RefObject<TerminalViewHandle | null> => {
      let ref = terminalRefsMap.current.get(tabId)
      if (!ref) {
        ref = { current: null }
        terminalRefsMap.current.set(tabId, ref)
      }
      return ref
    },
    []
  )

  // Update worktree paths map when the selected worktree changes
  if (selectedWorktreeId && worktreePath) {
    worktreePathsRef.current.set(selectedWorktreeId, worktreePath)
  }

  // Auto-create "Terminal 1" when a worktree is selected and has no tabs
  useEffect(() => {
    if (selectedWorktreeId && worktreePath && isVisible) {
      const tabs = tabsByWorktree.get(selectedWorktreeId)
      if (!tabs || tabs.length === 0) {
        createTab(selectedWorktreeId)
      }
    }
  }, [selectedWorktreeId, worktreePath, isVisible, tabsByWorktree, createTab])

  // When backend setting changes, tear down all active terminals so they get re-created
  // with the new backend on next visibility
  useEffect(() => {
    if (prevBackendRef.current !== embeddedTerminalBackend) {
      prevBackendRef.current = embeddedTerminalBackend
      // Destroy all PTYs across all worktrees by tab ID
      for (const [, tabs] of tabsByWorktree) {
        for (const tab of tabs) {
          destroyTerminal(tab.id)
        }
      }
      removeAllTabs()
      terminalRefsMap.current.clear()
    }
  }, [embeddedTerminalBackend, destroyTerminal, tabsByWorktree, removeAllTabs])

  // Clean up terminals for worktrees that no longer exist
  useEffect(() => {
    const existingWorktreeIds = new Set<string>()
    for (const [, worktrees] of worktreesByProject) {
      for (const wt of worktrees) {
        existingWorktreeIds.add(wt.id)
      }
    }

    for (const [worktreeId, tabs] of tabsByWorktree) {
      if (!existingWorktreeIds.has(worktreeId)) {
        // Worktree was deleted/archived — destroy all its tab PTYs
        for (const tab of tabs) {
          destroyTerminal(tab.id)
          terminalRefsMap.current.delete(tab.id)
        }
        removeWorktree(worktreeId)
        worktreePathsRef.current.delete(worktreeId)
      }
    }
  }, [worktreesByProject, destroyTerminal, tabsByWorktree, removeWorktree])

  // Collect ALL tabs across ALL worktrees for rendering
  const allTabs = Array.from(tabsByWorktree.values()).flat()

  // Determine which tab is currently active for the selected worktree
  const activeTabId = selectedWorktreeId
    ? activeTabByWorktree.get(selectedWorktreeId)
    : undefined

  if (allTabs.length === 0 && !selectedWorktreeId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a worktree to open a terminal
      </div>
    )
  }

  return (
    <div className="flex h-full w-full">
      <div className="flex-1 min-w-0 relative">
        {allTabs.map((tab) => {
          const isTabVisible =
            tab.worktreeId === selectedWorktreeId && tab.id === activeTabId
          const termRef = getTerminalRef(tab.id)
          const cwd = worktreePathsRef.current.get(tab.worktreeId) ?? ''

          return (
            <div
              key={tab.id}
              className={isTabVisible ? 'h-full w-full' : 'hidden'}
              data-testid={`terminal-instance-${tab.id}`}
            >
              <TerminalView
                ref={termRef}
                terminalId={tab.id}
                cwd={cwd}
                isVisible={isTabVisible && isVisible}
              />
            </div>
          )
        })}
        {/* Show placeholder if no tabs are visible */}
        {allTabs.length === 0 && selectedWorktreeId && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Select a worktree to open a terminal
          </div>
        )}
      </div>
      {selectedWorktreeId && <TerminalTabSidebar worktreeId={selectedWorktreeId} />}
    </div>
  )
}
