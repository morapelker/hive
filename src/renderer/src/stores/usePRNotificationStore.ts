import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PRNotificationStatus = 'loading' | 'success' | 'error' | 'info' | 'warning'

interface PRNotification {
  id: string
  status: PRNotificationStatus
  message: string
  description?: string
  prUrl?: string
  prNumber?: number
  worktreeId?: string
}

interface PRNotificationState {
  notifications: PRNotification[]

  /** Add a new notification and return its id */
  show: (notification: Omit<PRNotification, 'id'>) => string

  /** Update an existing notification in-place */
  update: (id: string, updates: Partial<Omit<PRNotification, 'id'>>) => void

  /** Remove a notification */
  dismiss: (id: string) => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let nextId = 0

export const usePRNotificationStore = create<PRNotificationState>()((set) => ({
  notifications: [],

  show: (notification) => {
    const id = `pr-notif-${++nextId}`
    set((state) => ({
      notifications: [...state.notifications, { ...notification, id }]
    }))
    return id
  },

  update: (id, updates) => {
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, ...updates } : n
      )
    }))
  },

  dismiss: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id)
    }))
  }
}))
