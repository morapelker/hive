import { create } from 'zustand'
import { parseRemoteLaunch, type RemoteLaunchClientInfo } from '@shared/types/remote-launch'
import { dbApi } from '@/api/db-api'

interface SessionRemoteLaunchRow {
  remote_launch?: string | null
}

interface RemoteLaunchStoreState {
  /** null = checked, not a remote (client-role) launch. */
  remoteBySessionId: Record<string, RemoteLaunchClientInfo | null>
  ensureLoaded: (sessionId: string) => Promise<void>
  setRemoteInfo: (sessionId: string, info: RemoteLaunchClientInfo) => void
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
      try {
        const session = await dbApi.session.get<SessionRemoteLaunchRow>(sessionId)
        const info = parseRemoteLaunch(session?.remote_launch)
        const clientInfo = info?.role === 'client' ? info : null
        set((state) => ({
          remoteBySessionId: { ...state.remoteBySessionId, [sessionId]: clientInfo }
        }))
      } finally {
        inFlightLoads.delete(sessionId)
      }
    })()

    inFlightLoads.set(sessionId, load)
    return load
  },

  setRemoteInfo: (sessionId, info) =>
    set((state) => ({
      remoteBySessionId: { ...state.remoteBySessionId, [sessionId]: info }
    }))
}))
