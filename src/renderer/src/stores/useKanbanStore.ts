import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  KanbanTicket,
  KanbanTicketColumn,
  KanbanTicketCreate,
  KanbanTicketUpdate
} from '../../../main/db/types'

// ── Column ordering for sort comparisons ───────────────────────────────
const COLUMN_ORDER: Record<KanbanTicketColumn, number> = {
  todo: 0,
  in_progress: 1,
  review: 2,
  done: 3
}

// ── State interface ────────────────────────────────────────────────────
interface KanbanState {
  /** Tickets keyed by project ID */
  tickets: Map<string, KanbanTicket[]>
  isLoading: boolean
  /** Whether the kanban board view is active — persisted to localStorage */
  isBoardViewActive: boolean
  /** Per-project simple mode toggle — persisted to localStorage */
  simpleModeByProject: Record<string, boolean>

  // ── Actions ────────────────────────────────────────────────────────
  loadTickets: (projectId: string) => Promise<void>
  createTicket: (projectId: string, data: KanbanTicketCreate) => Promise<KanbanTicket>
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
  deleteTicket: (ticketId: string, projectId: string) => Promise<void>
  moveTicket: (
    ticketId: string,
    projectId: string,
    column: KanbanTicketColumn,
    sortOrder: number
  ) => Promise<void>
  reorderTicket: (ticketId: string, projectId: string, newSortOrder: number) => Promise<void>
  toggleBoardView: () => void
  setSimpleMode: (projectId: string, enabled: boolean) => Promise<void>

  // ── Getters ────────────────────────────────────────────────────────
  getTicketsForProject: (projectId: string) => KanbanTicket[]
  getTicketsByColumn: (projectId: string, column: KanbanTicketColumn) => KanbanTicket[]

  // ── Helpers ────────────────────────────────────────────────────────
  computeSortOrder: (tickets: KanbanTicket[], targetIndex: number) => number
}

// ── Store ──────────────────────────────────────────────────────────────
export const useKanbanStore = create<KanbanState>()(
  persist(
    (set, get) => ({
      tickets: new Map(),
      isLoading: false,
      isBoardViewActive: false,
      simpleModeByProject: {} as Record<string, boolean>,

      // ── loadTickets ──────────────────────────────────────────────
      loadTickets: async (projectId: string) => {
        set({ isLoading: true })
        try {
          const tickets = await window.kanban.ticket.getByProject(projectId)
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, tickets)
            return { tickets: next, isLoading: false }
          })
        } catch {
          set({ isLoading: false })
        }
      },

      // ── createTicket ─────────────────────────────────────────────
      createTicket: async (projectId: string, data: KanbanTicketCreate) => {
        const ticket = await window.kanban.ticket.create(data)
        set((state) => {
          const next = new Map(state.tickets)
          const existing = next.get(projectId) ?? []
          next.set(projectId, [...existing, ticket])
          return { tickets: next }
        })
        return ticket
      },

      // ── updateTicket (optimistic) ────────────────────────────────
      updateTicket: async (ticketId: string, projectId: string, data: KanbanTicketUpdate) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Optimistic local update
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId ? { ...t, ...data } : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await window.kanban.ticket.update(ticketId, data)
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── deleteTicket (optimistic) ────────────────────────────────
      deleteTicket: async (ticketId: string, projectId: string) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Optimistic local delete
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).filter((t) => t.id !== ticketId)
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await window.kanban.ticket.delete(ticketId)
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── moveTicket (optimistic) ──────────────────────────────────
      moveTicket: async (
        ticketId: string,
        projectId: string,
        column: KanbanTicketColumn,
        sortOrder: number
      ) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Optimistic local update
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId ? { ...t, column, sort_order: sortOrder } : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await window.kanban.ticket.move(ticketId, column, sortOrder)
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── reorderTicket (optimistic) ───────────────────────────────
      reorderTicket: async (ticketId: string, projectId: string, newSortOrder: number) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Optimistic local update
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId ? { ...t, sort_order: newSortOrder } : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await window.kanban.ticket.reorder(ticketId, newSortOrder)
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── toggleBoardView ──────────────────────────────────────────
      toggleBoardView: () => {
        set((state) => ({ isBoardViewActive: !state.isBoardViewActive }))
      },

      // ── setSimpleMode ────────────────────────────────────────────
      setSimpleMode: async (projectId: string, enabled: boolean) => {
        set((state) => ({
          simpleModeByProject: { ...state.simpleModeByProject, [projectId]: enabled }
        }))
        await window.kanban.simpleMode.toggle(projectId, enabled)
      },

      // ── getTicketsForProject ─────────────────────────────────────
      getTicketsForProject: (projectId: string): KanbanTicket[] => {
        const tickets = get().tickets.get(projectId) ?? []
        return [...tickets].sort((a, b) => {
          const colDiff = COLUMN_ORDER[a.column] - COLUMN_ORDER[b.column]
          if (colDiff !== 0) return colDiff
          return a.sort_order - b.sort_order
        })
      },

      // ── getTicketsByColumn ───────────────────────────────────────
      getTicketsByColumn: (projectId: string, column: KanbanTicketColumn): KanbanTicket[] => {
        const tickets = get().tickets.get(projectId) ?? []
        return tickets.filter((t) => t.column === column).sort((a, b) => a.sort_order - b.sort_order)
      },

      // ── computeSortOrder ─────────────────────────────────────────
      computeSortOrder: (tickets: KanbanTicket[], targetIndex: number): number => {
        if (tickets.length === 0) return 0

        // Insert at beginning
        if (targetIndex <= 0) {
          return tickets[0].sort_order - 1
        }

        // Insert at end
        if (targetIndex >= tickets.length) {
          return tickets[tickets.length - 1].sort_order + 1
        }

        // Insert between
        const before = tickets[targetIndex - 1]
        const after = tickets[targetIndex]
        return (before.sort_order + after.sort_order) / 2
      }
    }),
    {
      name: 'hive-kanban',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        isBoardViewActive: state.isBoardViewActive,
        simpleModeByProject: state.simpleModeByProject
      })
    }
  )
)
