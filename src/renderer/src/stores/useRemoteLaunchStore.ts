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

export const useRemoteLaunchStore = create<RemoteLaunchStoreState>()((set, get) => ({
  remoteBySessionId: {},

  ensureLoaded: (sessionId) => {
    if (sessionId in get().remoteBySessionId) return Promise.resolve()

    const existing = inFlightLoads.get(sessionId)
    if (existing) return existing

    const load = (async () => {
      let clientInfo: RemoteLaunchClientInfo | null = null
      try {
        const session = await dbApi.session.get<SessionRemoteLaunchRow>(sessionId)
        const info = parseRemoteLaunch(session?.remote_launch)
        // A stopped launch renders like a non-remote session: no badge/actions.
        clientInfo = info?.role === 'client' && !info.stoppedAt ? info : null
      } catch {
        // Treat a failed fetch as "checked, not remote" — leaving the key
        // absent would strand consumers in a loading state forever, since
        // useTicketRemoteLaunch only re-fires ensureLoaded on sessionId
        // change and ensureLoaded never retries a cached key.
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
