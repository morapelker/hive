import { create } from 'zustand'
import { parseRemoteLaunch, type RemoteLaunchClientInfo } from '@shared/types/remote-launch'
import { dbApi } from '@/api/db-api'

interface SessionRemoteLaunchRow {
  remote_launch?: string | null
}

interface RemoteLaunchStoreState {
  /**
   * null = checked, not a remote (client-role) launch. Stopped remote
   * launches keep their info (with `stoppedAt` set) — consumers that only
   * care about ACTIVE launches must check `!info.stoppedAt`, but a stopped
   * remote session must stay distinguishable from a local one (it still has
   * no worktree, so e.g. the local terminal portal can never work for it).
   */
  remoteBySessionId: Record<string, RemoteLaunchClientInfo | null>
  ensureLoaded: (sessionId: string) => Promise<void>
  setRemoteInfo: (sessionId: string, info: RemoteLaunchClientInfo) => void
  /** Stamp a cached session's info as stopped (e.g. right after a successful stop). */
  markStopped: (sessionId: string) => void
}

// Module-scoped so concurrent ensureLoaded() calls for the same sessionId
// (e.g. from multiple mounted components) share one in-flight fetch instead
// of firing duplicate db.session.get RPCs.
const inFlightLoads = new Map<string, Promise<void>>()

// Session ids whose last load FAILED (cached as null so the UI resolves, but
// eligible for a retry on the next ensureLoaded call — e.g. a later mount).
// Without this, one transient RPC error would hide the remote badge/actions
// until app restart; without the null cache, it would hang "loading" forever.
const failedLoads = new Set<string>()

export const useRemoteLaunchStore = create<RemoteLaunchStoreState>()((set, get) => ({
  remoteBySessionId: {},

  ensureLoaded: (sessionId) => {
    if (sessionId in get().remoteBySessionId && !failedLoads.has(sessionId)) {
      return Promise.resolve()
    }

    const existing = inFlightLoads.get(sessionId)
    if (existing) return existing

    const load = (async () => {
      let clientInfo: RemoteLaunchClientInfo | null = null
      try {
        const session = await dbApi.session.get<SessionRemoteLaunchRow>(sessionId)
        const info = parseRemoteLaunch(session?.remote_launch)
        clientInfo = info?.role === 'client' ? info : null
        failedLoads.delete(sessionId)
      } catch {
        failedLoads.add(sessionId)
      } finally {
        inFlightLoads.delete(sessionId)
      }
      set((state) => ({
        remoteBySessionId: { ...state.remoteBySessionId, [sessionId]: clientInfo }
      }))
    })()

    inFlightLoads.set(sessionId, load)
    return load
  },

  setRemoteInfo: (sessionId, info) =>
    set((state) => ({
      remoteBySessionId: { ...state.remoteBySessionId, [sessionId]: info }
    })),

  markStopped: (sessionId) =>
    set((state) => {
      const info = state.remoteBySessionId[sessionId]
      if (!info || info.stoppedAt) return state
      return {
        remoteBySessionId: {
          ...state.remoteBySessionId,
          [sessionId]: { ...info, stoppedAt: new Date().toISOString() }
        }
      }
    })
}))
