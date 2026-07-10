import { create } from 'zustand'
import { parseRemoteLaunch, type RemoteLaunchClientInfo } from '@shared/types/remote-launch'
import { dbApi } from '@/api/db-api'

interface SessionRemoteLaunchRow {
  remote_launch?: string | null
}

interface RemoteLaunchStoreState {
  /** null = checked, not an ACTIVE remote (client-role) launch. */
  remoteBySessionId: Record<string, RemoteLaunchClientInfo | null>
  ensureLoaded: (sessionId: string) => Promise<void>
  setRemoteInfo: (sessionId: string, info: RemoteLaunchClientInfo) => void
  /** Mark a session as no longer remote (e.g. right after a successful stop). */
  clearRemoteInfo: (sessionId: string) => void
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
        // A stopped launch renders like a non-remote session: no badge/actions.
        clientInfo = info?.role === 'client' && !info.stoppedAt ? info : null
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

  clearRemoteInfo: (sessionId) =>
    set((state) => ({
      remoteBySessionId: { ...state.remoteBySessionId, [sessionId]: null }
    }))
}))
