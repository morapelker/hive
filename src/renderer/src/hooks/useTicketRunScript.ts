import { useCallback, useEffect, useMemo, useState } from 'react'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useScriptStore, fireRunScript, killRunScript } from '@/stores/useScriptStore'
import { toast } from '@/lib/toast'
import type { KanbanTicket } from '../../../main/db/types'
import { dbApi } from '@/api/db-api'

type TicketRunWorktree = {
  path: string
}

/**
 * Combined state + actions for running the project's `run_script` against
 * a ticket's attached worktree.  Consumed by the presentational
 * `TicketRunButton` and the modal-scoped Cmd+R hotkey.
 */
export interface TicketRunScriptState {
  /** True when the ticket has a worktree and the project has a run_script configured. */
  hasRunScript: boolean
  /** True while the run script is actively executing for this ticket's worktree. */
  runRunning: boolean
  /** Start the project's run script in the ticket's worktree.  No-op when no run script. */
  handleRunScript: () => void
  /** Kill the running script in this ticket's worktree.  No-op when worktree_id is null. */
  handleStopScript: () => Promise<void>
}

/**
 * Resolve the ticket's worktree from the in-memory store with a DB fallback,
 * subscribe reactively to the project's `run_script`, and expose
 * start/stop handlers + a reactive `runRunning` flag from `useScriptStore`.
 */
export function useTicketRunScript(ticket: KanbanTicket): TicketRunScriptState {
  // Reactive project selector — ensures `hasRunScript` updates if run_script
  // changes in Project Settings while the modal is open.
  const runScript = useProjectStore(
    (s) => s.projects.find((p) => p.id === ticket.project_id)?.run_script ?? null
  )

  // In-memory worktree lookup (reactive to worktreesByProject changes).
  const inMemoryWorktree = useWorktreeStore((s) => {
    if (!ticket.worktree_id) return null
    for (const worktrees of s.worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === ticket.worktree_id)
      if (wt) return wt
    }
    return null
  })

  // DB fallback: when the worktree isn't in memory (project not loaded),
  // hydrate from the DB so the button still works on pinned-board cross-project views.
  const [dbWorktree, setDbWorktree] = useState<TicketRunWorktree | null>(null)

  useEffect(() => {
    let cancelled = false

    if (!ticket.worktree_id) {
      setDbWorktree(null)
      return
    }
    if (inMemoryWorktree) {
      setDbWorktree(null)
      return
    }

    dbApi.worktree
      .get(ticket.worktree_id)
      .then((wt) => {
        if (!cancelled) setDbWorktree(wt ?? null)
      })
      .catch(() => {
        if (!cancelled) setDbWorktree(null)
      })

    return () => {
      cancelled = true
    }
  }, [ticket.worktree_id, inMemoryWorktree])

  const resolvedWorktree = inMemoryWorktree ?? dbWorktree

  const hasRunScript = !!runScript && !!resolvedWorktree

  const runRunning = useScriptStore((s) =>
    ticket.worktree_id ? (s.scriptStates[ticket.worktree_id]?.runRunning ?? false) : false
  )

  const handleRunScript = useCallback(() => {
    if (!ticket.worktree_id || !resolvedWorktree || !runScript || runRunning) return
    const commands = runScript
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
    fireRunScript(ticket.worktree_id, commands, resolvedWorktree.path)
    toast.success('Run script started')
  }, [ticket.worktree_id, resolvedWorktree, runScript, runRunning])

  const handleStopScript = useCallback(async () => {
    if (!ticket.worktree_id) return
    await killRunScript(ticket.worktree_id)
    toast.success('Run script stopped')
  }, [ticket.worktree_id])

  return useMemo(
    () => ({ hasRunScript, runRunning, handleRunScript, handleStopScript }),
    [hasRunScript, runRunning, handleRunScript, handleStopScript]
  )
}

/**
 * Register a window-capture Cmd+R / Ctrl+R handler that toggles run/stop
 * whenever the kanban ticket modal has focus.  Runs in the capture phase
 * and calls `stopImmediatePropagation()` so the global Cmd+R handler
 * (which targets the sidebar's selected worktree) doesn't also fire.
 */
export function useTicketRunScriptHotkey(state: TicketRunScriptState): void {
  const { hasRunScript, runRunning, handleRunScript, handleStopScript } = state

  useEffect(() => {
    if (!hasRunScript) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'r' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const modal = document.querySelector('[data-testid="kanban-ticket-modal"]')
        if (modal?.contains(document.activeElement)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          if (runRunning) {
            void handleStopScript()
          } else {
            handleRunScript()
          }
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [hasRunScript, runRunning, handleRunScript, handleStopScript])
}
