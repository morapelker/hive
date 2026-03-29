import { create } from 'zustand'

interface PermissionStore {
  pendingBySession: Map<string, PermissionRequest[]>
  addPermission: (sessionId: string, request: PermissionRequest) => void
  removePermission: (sessionId: string, requestId: string) => void
  getPermissions: (sessionId: string) => PermissionRequest[]
  getActivePermission: (sessionId: string) => PermissionRequest | null
  clearSession: (sessionId: string) => void
}

export const usePermissionStore = create<PermissionStore>((set, get) => ({
  pendingBySession: new Map(),

  addPermission: (sessionId, request) =>
    set((state) => {
      const map = new Map(state.pendingBySession)

      // Cross-session dedup: remove from any other session that has this request ID.
      // This prevents the same permission from appearing in two sessions simultaneously
      // if both the live event path and hydration path race with different session targets.
      for (const [existingSessionId, existingRequests] of map.entries()) {
        if (existingSessionId === sessionId) continue
        const filtered = existingRequests.filter((p) => p.id !== request.id)
        if (filtered.length !== existingRequests.length) {
          if (filtered.length === 0) {
            map.delete(existingSessionId)
          } else {
            map.set(existingSessionId, filtered)
          }
        }
      }

      // Same-session dedup (existing logic)
      const existing = map.get(sessionId) || []
      if (existing.some((p) => p.id === request.id)) return { pendingBySession: map }
      map.set(sessionId, [...existing, request])
      return { pendingBySession: map }
    }),

  removePermission: (sessionId, requestId) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      const existing = map.get(sessionId) || []
      const filtered = existing.filter((p) => p.id !== requestId)
      if (filtered.length === 0) {
        map.delete(sessionId)
      } else {
        map.set(sessionId, filtered)
      }
      return { pendingBySession: map }
    }),

  getPermissions: (sessionId) => get().pendingBySession.get(sessionId) || [],

  getActivePermission: (sessionId) => {
    const permissions = get().pendingBySession.get(sessionId) || []
    return permissions[0] || null
  },

  clearSession: (sessionId) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      map.delete(sessionId)
      return { pendingBySession: map }
    })
}))
