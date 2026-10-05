import { create } from 'zustand'
import { getRendererRpcClient } from '@/api/rpc-client'
import { parseSessionShellCommand, type SessionShellCommand } from '@shared/lib/shell-commands'

/** One row of the `db.session.getShellCommandRuns` RPC. */
export interface ShellCommandRunRow {
  sessionId: string
  projectId: string
  worktreeId: string | null
  /** sessions.shell_command: JSON SessionShellCommand. */
  shellCommand: string
}

interface ShellCommandRunState {
  /**
   * Snapshot + run state of every known shell-command session, keyed by session id.
   * An entry existing means "this session is a shell command", also for sessions
   * that are not loaded into useSessionStore (closed tab, other worktree), which is
   * what ticket cards and the ticket modal key on.
   */
  runsBySession: Record<string, SessionShellCommand>
  /** True once loadAll has succeeded at least once. */
  loaded: boolean
  /** (Re)load every run from the database. Concurrent calls share one request. Never rejects. */
  loadAll: () => Promise<void>
  setRun: (sessionId: string, run: SessionShellCommand) => void
  /** Patch a known run; returns false (and changes nothing) when the session is unknown. */
  mergeRun: (sessionId: string, patch: Partial<SessionShellCommand>) => boolean
  removeRun: (sessionId: string) => void
}

// A status event can land while a loadAll round-trip is in flight; the (older)
// response must not overwrite it. Every local write stamps the session with a
// monotonically increasing revision and loadAll skips sessions stamped after it began.
let revision = 0
const touchedAt = new Map<string, number>()
let inFlightLoad: Promise<void> | null = null

export const useShellCommandRunStore = create<ShellCommandRunState>((set, get) => ({
  runsBySession: {},
  loaded: false,

  loadAll: () => {
    if (inFlightLoad) return inFlightLoad
    const startedAt = revision
    // Promise.resolve() first: an unconfigured RPC client throws synchronously.
    inFlightLoad = Promise.resolve()
      .then(() =>
        getRendererRpcClient().request<ShellCommandRunRow[]>('db.session.getShellCommandRuns', {})
      )
      .then((rows) => {
        if (!Array.isArray(rows)) return
        set((state) => {
          const next: Record<string, SessionShellCommand> = {}
          for (const row of rows) {
            if (typeof row?.sessionId !== 'string') continue
            const run = parseSessionShellCommand(row.shellCommand)
            if (run) next[row.sessionId] = run
          }
          // Sessions written locally since the request began keep the local value.
          for (const [sessionId, run] of Object.entries(state.runsBySession)) {
            if ((touchedAt.get(sessionId) ?? 0) > startedAt || !(sessionId in next)) {
              next[sessionId] = run
            }
          }
          return { runsBySession: next, loaded: true }
        })
      })
      .catch(() => {
        // Fail-soft: callers treat a missing entry as "not known yet".
      })
      .finally(() => {
        inFlightLoad = null
      })
    return inFlightLoad
  },

  setRun: (sessionId, run) => {
    touchedAt.set(sessionId, ++revision)
    set((state) => ({ runsBySession: { ...state.runsBySession, [sessionId]: run } }))
  },

  mergeRun: (sessionId, patch) => {
    const current = get().runsBySession[sessionId]
    if (!current) return false
    touchedAt.set(sessionId, ++revision)
    set((state) => ({
      runsBySession: { ...state.runsBySession, [sessionId]: { ...current, ...patch } }
    }))
    return true
  },

  removeRun: (sessionId) => {
    if (!(sessionId in get().runsBySession)) return
    touchedAt.set(sessionId, ++revision)
    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.runsBySession
      return { runsBySession: rest }
    })
  }
}))
