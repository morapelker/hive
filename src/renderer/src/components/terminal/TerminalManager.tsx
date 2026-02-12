import { useRef, useCallback, useEffect } from 'react'
import { TerminalView, type TerminalViewHandle } from './TerminalView'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

interface TerminalManagerProps {
  /** The currently selected worktree ID (null if none selected) */
  selectedWorktreeId: string | null
  /** The worktree path for the selected worktree */
  worktreePath: string | null
  /** Whether the terminal tab is currently visible */
  isVisible: boolean
}

/**
 * TerminalManager ensures one TerminalView per worktree is kept alive across
 * tab switches and worktree changes. It renders all active terminals but only
 * shows the one matching the selected worktree.
 *
 * When the user switches from Terminal to Setup and back, the terminal DOM
 * and PTY process stay alive — no state is lost.
 */
export function TerminalManager({
  selectedWorktreeId,
  worktreePath,
  isVisible
}: TerminalManagerProps): React.JSX.Element {
  // Track which worktrees have had terminals opened
  const activeWorktreesRef = useRef<Map<string, string>>(new Map()) // worktreeId -> cwd
  const terminalRefsMap = useRef<Map<string, React.RefObject<TerminalViewHandle | null>>>(new Map())

  const destroyTerminal = useTerminalStore((s) => s.destroyTerminal)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const embeddedTerminalBackend = useSettingsStore((s) => s.embeddedTerminalBackend)
  const prevBackendRef = useRef(embeddedTerminalBackend)

  // Get or create a ref for a worktree's terminal
  const getTerminalRef = useCallback(
    (worktreeId: string): React.RefObject<TerminalViewHandle | null> => {
      let ref = terminalRefsMap.current.get(worktreeId)
      if (!ref) {
        ref = { current: null }
        terminalRefsMap.current.set(worktreeId, ref)
      }
      return ref
    },
    []
  )

  // Add the selected worktree to active terminals if it has a valid path
  if (selectedWorktreeId && worktreePath && isVisible) {
    if (!activeWorktreesRef.current.has(selectedWorktreeId)) {
      activeWorktreesRef.current.set(selectedWorktreeId, worktreePath)
    }
  }

  // When backend setting changes, tear down all active terminals so they get re-created
  // with the new backend on next visibility
  useEffect(() => {
    if (prevBackendRef.current !== embeddedTerminalBackend) {
      prevBackendRef.current = embeddedTerminalBackend
      // Destroy all active terminals — TerminalView will re-create with new backend
      for (const [worktreeId] of activeWorktreesRef.current) {
        destroyTerminal(worktreeId)
      }
      activeWorktreesRef.current.clear()
      terminalRefsMap.current.clear()
    }
  }, [embeddedTerminalBackend, destroyTerminal])

  // Clean up terminals for worktrees that no longer exist
  useEffect(() => {
    const existingWorktreeIds = new Set<string>()
    for (const [, worktrees] of worktreesByProject) {
      for (const wt of worktrees) {
        existingWorktreeIds.add(wt.id)
      }
    }

    for (const [worktreeId] of activeWorktreesRef.current) {
      if (!existingWorktreeIds.has(worktreeId)) {
        // Worktree was deleted/archived — clean up its terminal
        destroyTerminal(worktreeId)
        activeWorktreesRef.current.delete(worktreeId)
        terminalRefsMap.current.delete(worktreeId)
      }
    }
  }, [worktreesByProject, destroyTerminal])

  // Build the list of active terminals
  const activeTerminals = Array.from(activeWorktreesRef.current.entries())

  if (activeTerminals.length === 0 && !selectedWorktreeId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a worktree to open a terminal
      </div>
    )
  }

  return (
    <>
      {activeTerminals.map(([worktreeId, cwd]) => {
        const isActive = worktreeId === selectedWorktreeId && isVisible
        const termRef = getTerminalRef(worktreeId)

        return (
          <div
            key={worktreeId}
            className={isActive ? 'h-full w-full' : 'hidden'}
            data-testid={`terminal-instance-${worktreeId}`}
          >
            <TerminalView ref={termRef} worktreeId={worktreeId} cwd={cwd} isVisible={isActive} />
          </div>
        )
      })}
      {/* Show placeholder if selected worktree doesn't have a terminal yet */}
      {selectedWorktreeId &&
        !activeWorktreesRef.current.has(selectedWorktreeId) &&
        !worktreePath && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Select a worktree to open a terminal
          </div>
        )}
    </>
  )
}
