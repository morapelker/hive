// Which sessions this Mac's window reports as running right now (working, or waiting on a
// person: shared/session-running-state.ts).
//
// The live status of a session exists only in the window (the renderer's status store), so the
// window reports the ids of its running sessions (`settingsOps.reportRunningSessions`): the
// whole set each time, replacing what it said before. Moving a project to the dev folder reads
// them here: a project with a running session stays where it is.
//
// A report belongs to the socket that sent it. When that socket closes (the window reloaded or
// went away) its sessions are forgotten at once: a window that is gone cannot say that they
// ended, and the next window reports its own set when its socket opens.

export interface RunningSessionsTracker {
  /**
   * The window behind `socketId` says which of its sessions are running: the whole set,
   * replacing what it said before. A report from a socket that already closed is dropped.
   */
  readonly report: (socketId: string | null, sessionIds: readonly string[]) => void
  /** That window's socket closed: what it reported is forgotten. */
  readonly releaseSocket: (socketId: string) => void
  /**
   * The sessions some window reports as running right now, each id once. Read from the
   * reports themselves, so an id is gone the moment its window reports without it or its
   * socket closes.
   */
  readonly runningSessionIds: () => readonly string[]
}

/** A report that came through no socket (a test, a direct call) shares one slot. */
const NO_SOCKET = '(no socket)'
/** How many closed sockets are remembered, to drop a report that was still on its way. */
const CLOSED_SOCKETS_KEPT = 64

export const createRunningSessionsTracker = (): RunningSessionsTracker => {
  /** Socket id → the sessions that window last reported. */
  const reports = new Map<string, readonly string[]>()
  const closed = new Set<string>()

  return {
    report: (socketId, sessionIds) => {
      if (socketId !== null && closed.has(socketId)) return
      reports.set(socketId ?? NO_SOCKET, [...sessionIds])
    },
    releaseSocket: (socketId) => {
      reports.delete(socketId)
      closed.add(socketId)
      if (closed.size > CLOSED_SOCKETS_KEPT) {
        for (const oldest of closed) {
          closed.delete(oldest)
          break
        }
      }
    },
    runningSessionIds: () => {
      const ids = new Set<string>()
      for (const sessionIds of reports.values()) {
        for (const id of sessionIds) ids.add(id)
      }
      return [...ids]
    }
  }
}
