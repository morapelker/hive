import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  KanbanTicket,
  KanbanTicketColumn,
  KanbanTicketCreate,
  KanbanTicketUpdate,
  MarkdownCardDiagnostic,
  TicketDependency
} from '../../../main/db/types'
import {
  registerKanbanSessionSync,
  registerKanbanNewSession,
  type KanbanSessionEvent
} from './store-coordination'
import { isPlanLike } from '../lib/constants'
import { useConnectionStore } from './useConnectionStore'
import { usePinnedStore } from './usePinnedStore'
import { useWorktreeStatusStore } from './useWorktreeStatusStore'
import { kanbanApi as kanban } from '@/api/kanban-api'

export interface BoardTelegramTarget {
  ticketId: string
  projectId: string
  worktreeId: string
  sessionId: string
}

export interface TicketRef {
  projectId: string
  ticketId: string
}

export type TicketKey = string

export interface MarkdownCardPlaceholder {
  projectId: string
  filePath: string
  kind: MarkdownCardDiagnostic['kind']
  message: string
  blocking: true
}

export function ticketKey(projectId: string, ticketId: string): TicketKey {
  return `${encodeURIComponent(projectId)}:${encodeURIComponent(ticketId)}`
}

export function ticketRefKey(ref: TicketRef): TicketKey {
  return ticketKey(ref.projectId, ref.ticketId)
}

export function parseTicketKey(key: TicketKey): TicketRef {
  const separator = key.indexOf(':')
  if (separator === -1) return { projectId: '', ticketId: decodeURIComponent(key) }
  return {
    projectId: decodeURIComponent(key.slice(0, separator)),
    ticketId: decodeURIComponent(key.slice(separator + 1))
  }
}

// ── Shared drag state (module-level, avoids DataTransfer issues in Electron) ──
export interface KanbanDragData {
  projectId: string
  ticketId: string
  sourceColumn: string
  sourceIndex: number
}

let _kanbanDragData: KanbanDragData | null = null
let _pendingDragTicketKeyFrame: number | undefined

export function setKanbanDragData(data: KanbanDragData | null): void {
  _kanbanDragData = data

  // Cancel any pending delayed draggingTicketKey update
  if (_pendingDragTicketKeyFrame !== undefined) {
    cancelAnimationFrame(_pendingDragTicketKeyFrame)
    _pendingDragTicketKeyFrame = undefined
  }

  if (data) {
    // isDragging set immediately so columns show drag affordance
    useKanbanStore.setState({ isDragging: true })
    // Delay draggingTicketKey to next frame — the wrapper collapse must happen
    // AFTER the browser has committed the drag (captured the drag image and
    // started tracking the pointer). Collapsing during dragstart aborts the drag.
    _pendingDragTicketKeyFrame = requestAnimationFrame(() => {
      _pendingDragTicketKeyFrame = undefined
      useKanbanStore.setState({ draggingTicketKey: ticketKey(data.projectId, data.ticketId) })
    })
  } else {
    // Clear everything immediately on drag end / drop
    useKanbanStore.setState({ isDragging: false, draggingTicketKey: null })
  }
}

export function getKanbanDragData(): KanbanDragData | null {
  return _kanbanDragData
}

// ── Layout animation suppression (module-level, shared across all columns) ──
// Set during drag-and-drop so the resulting re-render uses instant transitions.
// Cleared after a short delay to ensure React has committed the render.
let _suppressLayoutAnimation = false

export function suppressLayoutAnimation(): void {
  _suppressLayoutAnimation = true
  setTimeout(() => {
    _suppressLayoutAnimation = false
  }, 300)
}

export function isLayoutAnimationSuppressed(): boolean {
  return _suppressLayoutAnimation
}

// ── Column ordering for sort comparisons ───────────────────────────────
const COLUMN_ORDER: Record<KanbanTicketColumn, number> = {
  todo: 0,
  in_progress: 1,
  review: 2,
  done: 3
}

function findTicketByRef(
  ticketsByProject: Map<string, KanbanTicket[]>,
  ref: TicketRef
): KanbanTicket | null {
  return ticketsByProject.get(ref.projectId)?.find((ticket) => ticket.id === ref.ticketId) ?? null
}

function removeDependencyLinksForTicket(
  dependencyMap: Map<TicketKey, Set<TicketKey>>,
  removedKey: TicketKey
): Map<TicketKey, Set<TicketKey>> {
  const newMap = new Map(dependencyMap)
  newMap.delete(removedKey)
  for (const [depKey, blockers] of newMap) {
    if (!blockers.has(removedKey)) continue
    const newSet = new Set(blockers)
    newSet.delete(removedKey)
    if (newSet.size === 0) {
      newMap.delete(depKey)
    } else {
      newMap.set(depKey, newSet)
    }
  }
  return newMap
}

function placeholdersFromDiagnostics(
  projectId: string,
  diagnostics: MarkdownCardDiagnostic[],
  tickets: KanbanTicket[] = []
): MarkdownCardPlaceholder[] {
  const renderedTicketIds = new Set(tickets.map((ticket) => ticket.id))
  return diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.blocking && (!diagnostic.ticketId || !renderedTicketIds.has(diagnostic.ticketId))
    )
    .map((diagnostic) => ({
      projectId,
      filePath: diagnostic.filePath,
      kind: diagnostic.kind,
      message: diagnostic.message,
      blocking: true
    }))
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
  /** Currently selected ticket ID for the detail modal (null = closed) */
  selectedTicketId: string | null
  selectedTicketRef: TicketRef | null
  /** Whether a ticket is currently being dragged (reactive, for column styling) */
  isDragging: boolean
  draggingTicketKey: TicketKey | null
  /** Per-project archive visibility toggle — NOT persisted to localStorage */
  showArchivedByProject: Record<string, boolean>
  markdownDiagnostics: Map<string, MarkdownCardDiagnostic[]>
  markdownPlaceholders: Map<string, MarkdownCardPlaceholder[]>
  /** Pending "move to done" data — set when a feature-branch ticket is dropped on Done, triggering the merge dialog */
  pendingDoneMove: {
    ticketId: string
    projectId: string
    sortOrder: number
  } | null
  /** Ephemeral board focus target used by the header Telegram toggle. */
  boardTelegramTarget: BoardTelegramTarget | null

  // ── Actions ────────────────────────────────────────────────────────
  setSelectedTicketId: (id: null) => void
  setSelectedTicketRef: (ref: TicketRef | null) => void
  setBoardTelegramTarget: (target: BoardTelegramTarget | null) => void
  clearBoardTelegramTarget: () => void
  loadTickets: (projectId: string) => Promise<void>
  createTicket: (projectId: string, data: KanbanTicketCreate) => Promise<KanbanTicket>
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
  deleteTicket: (ticketId: string, projectId: string) => Promise<void>
  moveTicketToProject: (
    ticketId: string,
    sourceProjectId: string,
    targetProjectId: string
  ) => Promise<KanbanTicket | null>
  moveTicket: (
    ticketId: string,
    projectId: string,
    column: KanbanTicketColumn,
    sortOrder: number
  ) => Promise<void>
  reorderTicket: (ticketId: string, projectId: string, newSortOrder: number) => Promise<void>
  toggleBoardView: () => void
  setSimpleMode: (projectId: string, enabled: boolean) => Promise<void>
  archiveTicket: (ticketId: string, projectId: string) => Promise<void>
  archiveAllDone: (projectId: string) => Promise<number>
  unarchiveTicket: (ticketId: string, projectId: string) => Promise<void>
  detachWorktreeTickets: (worktreeId: string) => Promise<void>
  setShowArchived: (projectId: string, show: boolean) => void
  setPendingDoneMove: (data: { ticketId: string; projectId: string; sortOrder: number }) => void
  clearPendingDoneMove: () => void
  completeDoneMove: () => Promise<void>

  // ── Session coordination ────────────────────────────────────────────
  syncTicketWithSession: (sessionId: string, event: KanbanSessionEvent) => void
  relinkTicketsForHandoff: (
    oldSessionId: string,
    newSessionId: string,
    goalMode?: boolean
  ) => Promise<void>

  // ── Getters ────────────────────────────────────────────────────────
  getTicketsForProject: (projectId: string) => KanbanTicket[]
  getTicketsByColumn: (projectId: string, column: KanbanTicketColumn) => KanbanTicket[]
  getArchivedTicketsByColumn: (projectId: string, column: KanbanTicketColumn) => KanbanTicket[]
  getDiagnosticsForTicket: (projectId: string, ticketId: string) => MarkdownCardDiagnostic[]
  getInvalidPlaceholdersForProject: (projectId: string) => MarkdownCardPlaceholder[]
  loadTicketsForProjectInAggregate: (projectId: string) => Promise<void>

  // ── Connection-level accessors ──────────────────────────────────────
  getConnectionProjectIds: (connectionId: string) => string[]
  loadTicketsForConnection: (connectionId: string) => Promise<void>
  getTicketsByColumnForConnection: (
    connectionId: string,
    column: KanbanTicketColumn
  ) => KanbanTicket[]
  getInvalidPlaceholdersForConnection: (connectionId: string) => MarkdownCardPlaceholder[]

  // ── Pinned board accessors ──────────────────────────────────────────
  isPinnedBoardActive: boolean
  togglePinnedBoard: () => void
  loadTicketsForPinnedProjects: () => Promise<void>
  getTicketsByColumnForPinned: (column: KanbanTicketColumn) => KanbanTicket[]
  getInvalidPlaceholdersForPinned: () => MarkdownCardPlaceholder[]
  getPinnedProjectIdsArray: () => string[]

  // ── PR data sync ───────────────────────────────────────────────────
  syncPRToTicket: (worktreeId: string, prNumber: number, prUrl: string) => void
  clearPRFromTicket: (worktreeId: string) => void
  attachPRToTicket: (ticketId: string, projectId: string, prNumber: number, prUrl: string) => void
  detachPRFromTicket: (ticketId: string, projectId: string) => void

  // ── Helpers ────────────────────────────────────────────────────────
  computeSortOrder: (tickets: KanbanTicket[], targetIndex: number) => number

  // ── Dependency tracking ────────────────────────────────────────────
  dependencyMap: Map<TicketKey, Set<TicketKey>> // Map<dependent_ticket_key, Set<blocker_ticket_key>>
  dependencyMode: { active: boolean; sourceTicketId: string | null; sourceProjectId?: string | null } | null
  hoveredBlockedTicketKey: TicketKey | null

  // ── Dependency actions ─────────────────────────────────────────────
  loadDependencies: (projectId: string) => Promise<void>
  addDependency: (dependent: TicketRef, blocker: TicketRef) => Promise<{ success: boolean; error?: string }>
  removeDependency: (dependent: TicketRef, blocker: TicketRef) => Promise<void>
  enterDependencyMode: (sourceTicketId: string, sourceProjectId?: string) => void
  exitDependencyMode: () => void
  setHoveredBlockedTicketRef: (ref: TicketRef | null) => void
}

// ── Store ──────────────────────────────────────────────────────────────
export const useKanbanStore = create<KanbanState>()(
  persist(
    (set, get) => ({
      tickets: new Map(),
      isLoading: false,
      isBoardViewActive: false,
      isPinnedBoardActive: false,
      simpleModeByProject: {} as Record<string, boolean>,
      selectedTicketId: null,
      selectedTicketRef: null,
      isDragging: false,
      draggingTicketKey: null,
      showArchivedByProject: {} as Record<string, boolean>,
      markdownDiagnostics: new Map(),
      markdownPlaceholders: new Map(),
      pendingDoneMove: null,
      boardTelegramTarget: null,
      dependencyMap: new Map(),
      dependencyMode: null,
      hoveredBlockedTicketKey: null,

      // ── setSelectedTicketId ────────────────────────────────────────
      setSelectedTicketId: (_id: null) => {
        set({ selectedTicketId: null, selectedTicketRef: null })
      },

      setSelectedTicketRef: (ref: TicketRef | null) => {
        set({ selectedTicketId: ref?.ticketId ?? null, selectedTicketRef: ref })
      },

      setBoardTelegramTarget: (target: BoardTelegramTarget | null) => {
        set({ boardTelegramTarget: target })
      },

      clearBoardTelegramTarget: () => {
        set({ boardTelegramTarget: null })
      },

      // ── loadTickets ──────────────────────────────────────────────
      loadTickets: async (projectId: string) => {
        set({ isLoading: true })
        try {
          const includeArchived = get().showArchivedByProject[projectId] ?? false
          const tickets = await kanban.ticket.getByProject<KanbanTicket>(
            projectId,
            includeArchived
          )
          const diagnostics = await kanban.diagnostics
            .get<MarkdownCardDiagnostic>(projectId)
            .catch(() => [])
          set((state) => {
            const next = new Map(state.tickets)
            const nextDiagnostics = new Map(state.markdownDiagnostics)
            const nextPlaceholders = new Map(state.markdownPlaceholders)
            next.set(projectId, tickets)
            nextDiagnostics.set(projectId, diagnostics)
            nextPlaceholders.set(
              projectId,
              placeholdersFromDiagnostics(projectId, diagnostics, tickets)
            )
            return {
              tickets: next,
              markdownDiagnostics: nextDiagnostics,
              markdownPlaceholders: nextPlaceholders,
              isLoading: false
            }
          })
          // Load dependencies for this project
          get().loadDependencies(projectId)
        } catch {
          set({ isLoading: false })
        }
      },

      loadTicketsForProjectInAggregate: async (projectId: string) => {
        set({ isLoading: true })
        try {
          const includeArchived = get().showArchivedByProject[projectId] ?? get().showArchivedByProject[''] ?? false
          const tickets = await kanban.ticket.getByProject<KanbanTicket>(
            projectId,
            includeArchived
          )
          const diagnostics = await kanban.diagnostics
            .get<MarkdownCardDiagnostic>(projectId)
            .catch(() => [])
          set((state) => {
            const next = new Map(state.tickets)
            const nextDiagnostics = new Map(state.markdownDiagnostics)
            const nextPlaceholders = new Map(state.markdownPlaceholders)
            next.set(projectId, tickets)
            nextDiagnostics.set(projectId, diagnostics)
            nextPlaceholders.set(
              projectId,
              placeholdersFromDiagnostics(projectId, diagnostics, tickets)
            )
            return {
              tickets: next,
              markdownDiagnostics: nextDiagnostics,
              markdownPlaceholders: nextPlaceholders,
              isLoading: false
            }
          })
          get().loadDependencies(projectId)
        } catch {
          set({ isLoading: false })
        }
      },

      // ── createTicket ─────────────────────────────────────────────
      createTicket: async (projectId: string, data: KanbanTicketCreate) => {
        const ticket = await kanban.ticket.create<KanbanTicket, KanbanTicketCreate>(
          projectId,
          data
        )
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
          await kanban.ticket.update(projectId, ticketId, data)
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
          await kanban.ticket.delete(projectId, ticketId)

          // Remove all dependency links for deleted ticket
          kanban.dependency.removeAll(projectId, ticketId).catch(() => {})
          // Update local dependency map
          set((state) => {
            return { dependencyMap: removeDependencyLinksForTicket(state.dependencyMap, ticketKey(projectId, ticketId)) }
          })
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

      // ── moveTicketToProject (optimistic) ─────────────────────────
      moveTicketToProject: async (
        ticketId: string,
        sourceProjectId: string,
        targetProjectId: string
      ) => {
        if (sourceProjectId === targetProjectId) return null

        const prevSource = get().tickets.get(sourceProjectId) ?? []
        const moved = prevSource.find((t) => t.id === ticketId)
        if (!moved) return null
        const sourceSnapshot = prevSource.map((t) => ({ ...t }))

        // Optimistic: remove from the source project's list
        set((state) => {
          const next = new Map(state.tickets)
          next.set(
            sourceProjectId,
            (next.get(sourceProjectId) ?? []).filter((t) => t.id !== ticketId)
          )
          const update: Partial<KanbanState> = { tickets: next }
          // Selection lives under the source board; clear it if this ticket was selected
          if (
            state.selectedTicketRef?.projectId === sourceProjectId &&
            state.selectedTicketRef.ticketId === ticketId
          ) {
            update.selectedTicketId = null
            update.selectedTicketRef = null
          } else if (!state.selectedTicketRef && state.selectedTicketId === ticketId) {
            update.selectedTicketId = null
          }
          return update
        })

        try {
          const updated = await kanban.ticket.moveToProject<KanbanTicket | null>(
            sourceProjectId,
            ticketId,
            targetProjectId
          )

          // If the target board is already loaded, surface the moved ticket there
          if (updated) {
            set((state) => {
              if (!state.tickets.has(targetProjectId)) return {}
              const next = new Map(state.tickets)
              const targetTickets = next.get(targetProjectId) ?? []
              if (targetTickets.some((t) => t.id === ticketId)) return {}
              next.set(targetProjectId, [...targetTickets, updated])
              return { tickets: next }
            })
          }

          // Detach dependency links (they reference the source project's board)
          kanban.dependency.removeAll(sourceProjectId, ticketId).catch(() => {})
          set((state) => {
            return {
              dependencyMap: removeDependencyLinksForTicket(
                state.dependencyMap,
                ticketKey(sourceProjectId, ticketId)
              )
            }
          })

          return updated
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(sourceProjectId, sourceSnapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── archiveTicket (optimistic) ─────────────────────────────────
      archiveTicket: async (ticketId: string, projectId: string) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        const now = new Date().toISOString()
        // Optimistic local archive
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId ? { ...t, archived_at: now, updated_at: now } : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.archive(projectId, ticketId)

          // Remove all dependency links for archived ticket
          await kanban.dependency.removeAll(projectId, ticketId)
          // Update local dependency map
          set((state) => {
            return { dependencyMap: removeDependencyLinksForTicket(state.dependencyMap, ticketKey(projectId, ticketId)) }
          })
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

      // ── archiveAllDone (optimistic) ────────────────────────────────
      archiveAllDone: async (projectId: string): Promise<number> => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        const now = new Date().toISOString()
        let count = 0
        // Optimistic local archive of all non-archived done tickets
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) => {
            if (t.column === 'done' && !t.archived_at) {
              count++
              return { ...t, archived_at: now, updated_at: now }
            }
            return t
          })
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.archiveAllDone(projectId)
          return count
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

      // ── unarchiveTicket (optimistic) ───────────────────────────────
      unarchiveTicket: async (ticketId: string, projectId: string) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        const now = new Date().toISOString()
        // Optimistic local unarchive
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId ? { ...t, archived_at: null, updated_at: now } : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.unarchive(projectId, ticketId)
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

      // ── detachWorktreeTickets (optimistic) ────────────────────────
      detachWorktreeTickets: async (worktreeId: string) => {
        const snapshot = new Map<string, KanbanTicket[]>()
        const now = new Date().toISOString()

        set((state) => {
          const next = new Map(state.tickets)
          let anyChanged = false

          for (const [projectId, projectTickets] of next) {
            let projectChanged = false
            const updated = projectTickets.map((ticket) => {
              if (ticket.worktree_id !== worktreeId) return ticket
              projectChanged = true
              return {
                ...ticket,
                worktree_id: null,
                updated_at: now
              }
            })

            if (projectChanged) {
              anyChanged = true
              snapshot.set(
                projectId,
                projectTickets.map((t) => ({ ...t }))
              )
              next.set(projectId, updated)
            }
          }

          return anyChanged ? { tickets: next } : {}
        })

        try {
          await kanban.ticket.detachWorktree(worktreeId)
        } catch (err) {
          if (snapshot.size > 0) {
            set((state) => {
              const next = new Map(state.tickets)
              for (const [projectId, projectTickets] of snapshot) {
                next.set(projectId, projectTickets)
              }
              return { tickets: next }
            })
          }
          throw err
        }
      },

      // ── setShowArchived ────────────────────────────────────────────
      setShowArchived: (projectId: string, show: boolean) => {
        set((state) => ({
          showArchivedByProject: { ...state.showArchivedByProject, [projectId]: show }
        }))
        // Re-fetch tickets with updated archive visibility
        // (multi-project boards use '' as key and re-fetch via their own effect)
        if (projectId) {
          get().loadTickets(projectId)
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

        // Clear "Go to review" indicator when ticket moves columns (optimistic)
        const movedTicket = prev.find((t) => t.id === ticketId)
        if (movedTicket?.worktree_id) {
          useWorktreeStatusStore.getState().clearCompletedReviewSession(movedTicket.worktree_id)
        }

        try {
          await kanban.ticket.move(projectId, ticketId, column, sortOrder)

          // When a ticket moves to done (or review, if that's the trigger), check if any dependents can be auto-launched
          const { useSettingsStore } = await import('./useSettingsStore')
          const { isBlockerSatisfied } = await import('../lib/blocker-utils')
          const triggerColumn = useSettingsStore.getState().followUpTriggerColumn
          if (
            column === 'done' ||
            (triggerColumn === 'review' && column === 'review' && movedTicket?.mode === 'build')
          ) {
            const { dependencyMap, tickets: allTickets } = get()
            const movedKey = ticketKey(projectId, ticketId)
            // Find tickets that list this ticket as a blocker
            for (const [depKey, blockers] of dependencyMap) {
              if (!blockers.has(movedKey)) continue
              // Check if ALL blockers of this dependent are now satisfied
              let allSatisfied = true
              for (const blockerKey of blockers) {
                const blockerRef = parseTicketKey(blockerKey)
                const blockerTicket = findTicketByRef(allTickets, blockerRef)
                if (blockerTicket && !isBlockerSatisfied(blockerTicket.column, blockerTicket.mode, triggerColumn)) {
                  allSatisfied = false
                  break
                }
              }
              if (allSatisfied) {
                const depTicket = findTicketByRef(allTickets, parseTicketKey(depKey))
                if (depTicket?.pending_launch_config) {
                  // Auto-launch will be handled by the auto-launch module (Task 5)
                  import('../lib/auto-launch')
                    .then(({ autoLaunchTicket }) => {
                      autoLaunchTicket(depTicket).catch((err) => {
                        console.error('Auto-launch failed for ticket:', depTicket.id, err)
                      })
                    })
                    .catch(() => {})
                }
              }
            }
          }
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
          await kanban.ticket.reorder(projectId, ticketId, newSortOrder)
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
        await kanban.simpleMode.toggle(projectId, enabled)
      },

      // ── syncTicketWithSession (called via store-coordination) ────
      syncTicketWithSession: (sessionId: string, event: KanbanSessionEvent) => {
        // Find all tickets across all projects referencing this session
        const allTickets = get().tickets
        for (const [projectId, tickets] of allTickets.entries()) {
          for (const ticket of tickets) {
            if (ticket.current_session_id !== sessionId) continue

            switch (event.type) {
              case 'session_completed': {
                if (ticket.mode === 'build' && ticket.column !== 'review') {
                  // Auto-advance build ticket to review column (idempotent — skip if already there)
                  get()
                    .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                    .catch(() => {})
                } else if (isPlanLike(ticket.mode) && !ticket.plan_ready) {
                  // Plan finished — set plan_ready and move to review for user attention
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                  if (ticket.column !== 'review') {
                    get()
                      .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                      .catch(() => {})
                  }
                }
                // Accumulate token delta to ticket's persistent total
                if (event.tokenDelta && event.tokenDelta > 0) {
                  kanban.ticket
                    .addTokens<KanbanTicket | null>(projectId, ticket.id, event.tokenDelta)
                    .then((updated) => {
                      if (updated) {
                        set((state) => {
                          const next = new Map(state.tickets)
                          const tickets = (next.get(projectId) ?? []).map((t) =>
                            t.id === ticket.id ? { ...t, total_tokens: updated.total_tokens } : t
                          )
                          next.set(projectId, tickets)
                          return { tickets: next }
                        })
                      }
                    })
                    .catch(() => {})
                }
                break
              }

              case 'plan_ready': {
                // Explicit plan.ready event — set flag and move to review
                if (isPlanLike(ticket.mode) && !ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                  if (ticket.column !== 'review') {
                    get()
                      .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                      .catch(() => {})
                  }
                }
                break
              }

              case 'plan_followup': {
                // User rejected or revised a ready plan in the Claude CLI terminal.
                // The session is planning again, so clear review state and return
                // the ticket to active work.
                if (ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: false })
                    .catch(() => {})
                }
                if (ticket.column !== 'in_progress') {
                  get()
                    .moveTicket(ticket.id, projectId, 'in_progress', ticket.sort_order)
                    .catch(() => {})
                }
                break
              }

              case 'supercharge': {
                // Supercharge creates a new session — re-attach ticket and reset plan_ready
                // Idempotent: skip if already pointing at the new session
                if (event.newSessionId && ticket.current_session_id !== event.newSessionId) {
                  get()
                    .updateTicket(ticket.id, projectId, {
                      current_session_id: event.newSessionId,
                      plan_ready: false,
                      mode: 'build'
                    })
                    .catch(() => {})
                }
                break
              }

              case 'mode_change': {
                // Mode toggled outside the Kanban board — sync ticket mode + plan_ready
                const targetMode = event.sessionMode ?? null
                const targetPlanReady = targetMode === 'build' ? false : ticket.plan_ready
                if (ticket.mode !== targetMode || ticket.plan_ready !== targetPlanReady) {
                  get()
                    .updateTicket(ticket.id, projectId, {
                      mode: targetMode,
                      plan_ready: targetPlanReady
                    })
                    .catch(() => {})
                }
                break
              }

              case 'implement': {
                // Plan approved from session view — clear plan_ready, set mode to build
                if (ticket.plan_ready || ticket.mode !== 'build') {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: false, mode: 'build' })
                    .catch(() => {})
                }
                break
              }

              case 'session_error': {
                // Error requires user attention — move to review if currently in_progress
                if (ticket.column === 'in_progress') {
                  get()
                    .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                    .catch(() => {})
                }
                break
              }

              case 'session_working': {
                // Session became active — move ticket to in_progress if it's in
                // todo (pre-assigned, first activity) or review (returning to work).
                if (ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: false })
                    .catch(() => {})
                }
                if (ticket.column === 'todo' || ticket.column === 'review') {
                  get()
                    .moveTicket(ticket.id, projectId, 'in_progress', ticket.sort_order)
                    .catch(() => {})
                }
                break
              }
            }
          }
        }
      },

      relinkTicketsForHandoff: async (
        oldSessionId: string,
        newSessionId: string,
        goalMode?: boolean
      ) => {
        const linkedTickets = await kanban.ticket.getBySession<KanbanTicket>(oldSessionId)
        if (!linkedTickets || linkedTickets.length === 0) return

        const nextGoalMode = goalMode === true
        const relinkedByKey = new Map<TicketKey, KanbanTicket>()

        for (const ticket of linkedTickets) {
          const nextGoalSuccessCriteria = nextGoalMode
            ? (ticket.goal_success_criteria ?? null)
            : null
          const alreadyRelinked =
            ticket.current_session_id === newSessionId &&
            ticket.plan_ready === false &&
            ticket.mode === 'build' &&
            ticket.goal_mode === nextGoalMode &&
            ticket.goal_success_criteria === nextGoalSuccessCriteria

          if (!alreadyRelinked) {
            await kanban.ticket.update(ticket.project_id, ticket.id, {
              current_session_id: newSessionId,
              plan_ready: false,
              mode: 'build',
              goal_mode: nextGoalMode,
              goal_success_criteria: nextGoalSuccessCriteria
            })
          }

          relinkedByKey.set(ticketKey(ticket.project_id, ticket.id), {
            ...ticket,
            current_session_id: newSessionId,
            plan_ready: false,
            mode: 'build',
            goal_mode: nextGoalMode,
            goal_success_criteria: nextGoalSuccessCriteria
          })
        }

        set((state) => {
          const next = new Map(state.tickets)
          let changed = false
          let boardTelegramTarget = state.boardTelegramTarget

          for (const [projectId, projectTickets] of next.entries()) {
            let projectChanged = false
            const updatedTickets = projectTickets.map((ticket) => {
              const relinked = relinkedByKey.get(ticketKey(projectId, ticket.id))
              if (!relinked) return ticket
              projectChanged = true
              if (boardTelegramTarget?.projectId === projectId && boardTelegramTarget.ticketId === ticket.id) {
                boardTelegramTarget = {
                  ...boardTelegramTarget,
                  sessionId: newSessionId,
                  worktreeId: relinked.worktree_id ?? boardTelegramTarget.worktreeId
                }
              }
              return {
                ...ticket,
                current_session_id: relinked.current_session_id,
                plan_ready: relinked.plan_ready,
                mode: relinked.mode,
                goal_mode: relinked.goal_mode,
                goal_success_criteria: relinked.goal_success_criteria
              }
            })

            if (projectChanged) {
              changed = true
              next.set(projectId, updatedTickets)
            }
          }

          return changed ? { tickets: next, boardTelegramTarget } : { boardTelegramTarget }
        })
      },

      // ── Merge-on-done state ──────────────────────────────────────────
      setPendingDoneMove: (data) => {
        set({ pendingDoneMove: data })
      },

      clearPendingDoneMove: () => {
        set({ pendingDoneMove: null })
      },

      completeDoneMove: async () => {
        const pending = get().pendingDoneMove
        if (!pending) return
        set({ pendingDoneMove: null })
        await get().moveTicket(pending.ticketId, pending.projectId, 'done', pending.sortOrder)
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
        return tickets
          .filter((t) => t.column === column && !t.archived_at)
          .sort((a, b) => a.sort_order - b.sort_order)
      },

      // ── getArchivedTicketsByColumn ─────────────────────────────────
      getArchivedTicketsByColumn: (
        projectId: string,
        column: KanbanTicketColumn
      ): KanbanTicket[] => {
        const tickets = get().tickets.get(projectId) ?? []
        return tickets
          .filter((t) => t.column === column && t.archived_at)
          .sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? ''))
      },

      getDiagnosticsForTicket: (projectId: string, ticketId: string): MarkdownCardDiagnostic[] => {
        return (get().markdownDiagnostics.get(projectId) ?? []).filter(
          (diagnostic) => diagnostic.ticketId === ticketId
        )
      },

      getInvalidPlaceholdersForProject: (projectId: string): MarkdownCardPlaceholder[] => {
        return get().markdownPlaceholders.get(projectId) ?? []
      },

      // ── getConnectionProjectIds ─────────────────────────────────
      getConnectionProjectIds: (connectionId: string): string[] => {
        const connection = useConnectionStore
          .getState()
          .connections.find((c) => c.id === connectionId)
        if (!connection) return []
        return [...new Set(connection.members.map((m) => m.project_id))]
      },

      // ── loadTicketsForConnection ────────────────────────────────
      loadTicketsForConnection: async (connectionId: string) => {
        let projectIds = get().getConnectionProjectIds(connectionId)
        if (projectIds.length === 0) {
          const connStore = useConnectionStore.getState()
          if (!connStore.loaded) {
            await connStore.loadConnections()
            projectIds = get().getConnectionProjectIds(connectionId)
          }
          if (projectIds.length === 0) return
        }

        set({ isLoading: true })
        try {
          const includeArchived = (pid: string) =>
            get().showArchivedByProject[pid] ?? get().showArchivedByProject[''] ?? false
          const results = await Promise.all(
            projectIds.map(async (pid) => ({
              projectId: pid,
              tickets: await kanban.ticket.getByProject<KanbanTicket>(pid, includeArchived(pid))
            }))
          )
          const diagnosticsByProject = await Promise.all(
            results.map(async (result) => ({
              projectId: result.projectId,
              diagnostics: await kanban.diagnostics
                .get<MarkdownCardDiagnostic>(result.projectId)
                .catch(() => [])
            }))
          )
          const diagnosticsMap = new Map(diagnosticsByProject.map((result) => [result.projectId, result.diagnostics]))

          // Batch update all projects at once
          set((state) => {
            const newTickets = new Map(state.tickets)
            const newDiagnostics = new Map(state.markdownDiagnostics)
            const newPlaceholders = new Map(state.markdownPlaceholders)
            results.forEach((result) => {
              const diagnostics = diagnosticsMap.get(result.projectId) ?? []
              newTickets.set(result.projectId, result.tickets)
              newDiagnostics.set(result.projectId, diagnostics)
              newPlaceholders.set(
                result.projectId,
                placeholdersFromDiagnostics(result.projectId, diagnostics, result.tickets)
              )
            })
            return {
              tickets: newTickets,
              markdownDiagnostics: newDiagnostics,
              markdownPlaceholders: newPlaceholders
            }
          })
          // Load dependencies for each project
          for (const pid of projectIds) {
            get().loadDependencies(pid)
          }
        } catch (error) {
          console.error('Failed to load tickets for connection:', error)
        } finally {
          set({ isLoading: false })
        }
      },

      // ── getTicketsByColumnForConnection ─────────────────────────
      getTicketsByColumnForConnection: (
        connectionId: string,
        column: KanbanTicketColumn
      ): KanbanTicket[] => {
        const projectIds = get().getConnectionProjectIds(connectionId)
        const merged = projectIds.flatMap((pid) => get().getTicketsByColumn(pid, column))
        merged.sort((a, b) => a.sort_order - b.sort_order)
        return merged
      },

      getInvalidPlaceholdersForConnection: (connectionId: string): MarkdownCardPlaceholder[] => {
        const projectIds = get().getConnectionProjectIds(connectionId)
        return projectIds.flatMap((pid) => get().getInvalidPlaceholdersForProject(pid))
      },

      // ── togglePinnedBoard ────────────────────────────────────────
      togglePinnedBoard: () => {
        set((state) => ({ isPinnedBoardActive: !state.isPinnedBoardActive }))
      },

      // ── loadTicketsForPinnedProjects ─────────────────────────────
      loadTicketsForPinnedProjects: async () => {
        let projectIds = [...usePinnedStore.getState().pinnedProjectIds]
        if (projectIds.length === 0) {
          const pinnedStore = usePinnedStore.getState()
          if (!pinnedStore.loaded) {
            await pinnedStore.loadPinned()
            projectIds = [...usePinnedStore.getState().pinnedProjectIds]
          }
          if (projectIds.length === 0) return
        }

        set({ isLoading: true })
        try {
          const includeArchived = (pid: string) =>
            get().showArchivedByProject[pid] ?? get().showArchivedByProject[''] ?? false
          const results = await Promise.all(
            projectIds.map(async (pid) => ({
              projectId: pid,
              tickets: await kanban.ticket.getByProject<KanbanTicket>(pid, includeArchived(pid))
            }))
          )
          const diagnosticsByProject = await Promise.all(
            results.map(async (result) => ({
              projectId: result.projectId,
              diagnostics: await kanban.diagnostics
                .get<MarkdownCardDiagnostic>(result.projectId)
                .catch(() => [])
            }))
          )
          const diagnosticsMap = new Map(diagnosticsByProject.map((result) => [result.projectId, result.diagnostics]))

          // Batch update all projects at once
          set((state) => {
            const newTickets = new Map(state.tickets)
            const newDiagnostics = new Map(state.markdownDiagnostics)
            const newPlaceholders = new Map(state.markdownPlaceholders)
            results.forEach((result) => {
              const diagnostics = diagnosticsMap.get(result.projectId) ?? []
              newTickets.set(result.projectId, result.tickets)
              newDiagnostics.set(result.projectId, diagnostics)
              newPlaceholders.set(
                result.projectId,
                placeholdersFromDiagnostics(result.projectId, diagnostics, result.tickets)
              )
            })
            return {
              tickets: newTickets,
              markdownDiagnostics: newDiagnostics,
              markdownPlaceholders: newPlaceholders
            }
          })
          // Load dependencies for each project
          for (const pid of projectIds) {
            get().loadDependencies(pid)
          }
        } catch (error) {
          console.error('Failed to load tickets for pinned projects:', error)
        } finally {
          set({ isLoading: false })
        }
      },

      // ── getTicketsByColumnForPinned ──────────────────────────────
      getTicketsByColumnForPinned: (column: KanbanTicketColumn): KanbanTicket[] => {
        const projectIds = [...usePinnedStore.getState().pinnedProjectIds]
        const merged = projectIds.flatMap((pid) => get().getTicketsByColumn(pid, column))
        merged.sort((a, b) => a.sort_order - b.sort_order)
        return merged
      },

      getInvalidPlaceholdersForPinned: (): MarkdownCardPlaceholder[] => {
        const projectIds = [...usePinnedStore.getState().pinnedProjectIds]
        return projectIds.flatMap((pid) => get().getInvalidPlaceholdersForProject(pid))
      },

      // ── getPinnedProjectIdsArray ─────────────────────────────────
      getPinnedProjectIdsArray: (): string[] => {
        return [...usePinnedStore.getState().pinnedProjectIds].sort()
      },

      // ── syncPRToTicket ───────────────────────────────────────────
      syncPRToTicket: (worktreeId: string, prNumber: number, prUrl: string) => {
        set((state) => {
          const newTickets = new Map(state.tickets)
          let anyChanged = false
          for (const [projectId, projectTickets] of newTickets) {
            let projectChanged = false
            const updated = projectTickets.map((t) => {
              if (t.worktree_id === worktreeId) {
                projectChanged = true
                return { ...t, github_pr_number: prNumber, github_pr_url: prUrl }
              }
              return t
            })
            if (projectChanged) {
              anyChanged = true
              newTickets.set(projectId, updated)
            }
          }
          return anyChanged ? { tickets: newTickets } : {}
        })
      },

      // ── clearPRFromTicket ──────────────────────────────────────────
      clearPRFromTicket: (worktreeId: string) => {
        set((state) => {
          const newTickets = new Map(state.tickets)
          let anyChanged = false
          for (const [projectId, projectTickets] of newTickets) {
            let projectChanged = false
            const updated = projectTickets.map((t) => {
              if (t.worktree_id === worktreeId) {
                projectChanged = true
                return { ...t, github_pr_number: null, github_pr_url: null }
              }
              return t
            })
            if (projectChanged) {
              anyChanged = true
              newTickets.set(projectId, updated)
            }
          }
          return anyChanged ? { tickets: newTickets } : {}
        })
      },

      // ── attachPRToTicket ──────────────────────────────────────────
      attachPRToTicket: (ticketId: string, projectId: string, prNumber: number, prUrl: string) => {
        set((state) => {
          const projectTickets = state.tickets.get(projectId)
          if (!projectTickets) return {}
          const updated = projectTickets.map((t) =>
            t.id === ticketId ? { ...t, github_pr_number: prNumber, github_pr_url: prUrl } : t
          )
          const newTickets = new Map(state.tickets)
          newTickets.set(projectId, updated)
          return { tickets: newTickets }
        })
      },

      // ── detachPRFromTicket ──────────────────────────────────────────
      detachPRFromTicket: (ticketId: string, projectId: string) => {
        set((state) => {
          const projectTickets = state.tickets.get(projectId)
          if (!projectTickets) return {}
          const updated = projectTickets.map((t) =>
            t.id === ticketId ? { ...t, github_pr_number: null, github_pr_url: null } : t
          )
          const newTickets = new Map(state.tickets)
          newTickets.set(projectId, updated)
          return { tickets: newTickets }
        })
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
      },

      // ── loadDependencies ────────────────────────────────────────────
      loadDependencies: async (projectId: string) => {
        try {
          const deps = await kanban.dependency.getForProject<TicketDependency>(projectId)
          set((state) => {
            const newMap = new Map(state.dependencyMap)
            for (const [depKey] of newMap) {
              if (parseTicketKey(depKey).projectId === projectId) newMap.delete(depKey)
            }
            // Populate from fetched data
            for (const dep of deps) {
              const dependentKey = ticketKey(projectId, dep.dependent_id)
              const blockerKey = ticketKey(projectId, dep.blocker_id)
              const existing = newMap.get(dependentKey) ?? new Set<TicketKey>()
              existing.add(blockerKey)
              newMap.set(dependentKey, existing)
            }
            return { dependencyMap: newMap }
          })
        } catch (err) {
          console.error('Failed to load dependencies:', err)
        }
      },

      // ── addDependency ───────────────────────────────────────────────
      addDependency: async (dependent: TicketRef, blocker: TicketRef) => {
        if (dependent.projectId !== blocker.projectId) {
          return { success: false, error: 'Dependencies can only be created within the same project' }
        }
        const result = await kanban.dependency.add(
          dependent.projectId,
          dependent.ticketId,
          blocker.ticketId
        )
        if (result.success) {
          set((state) => {
            const newMap = new Map(state.dependencyMap)
            const dependentKey = ticketRefKey(dependent)
            const existing = newMap.get(dependentKey) ?? new Set<TicketKey>()
            const newSet = new Set(existing)
            newSet.add(ticketRefKey(blocker))
            newMap.set(dependentKey, newSet)
            return { dependencyMap: newMap }
          })
        }
        return result
      },

      // ── removeDependency ────────────────────────────────────────────
      removeDependency: async (dependent: TicketRef, blocker: TicketRef) => {
        if (dependent.projectId !== blocker.projectId) return
        await kanban.dependency.remove(dependent.projectId, dependent.ticketId, blocker.ticketId)
        set((state) => {
          const newMap = new Map(state.dependencyMap)
          const dependentKey = ticketRefKey(dependent)
          const existing = newMap.get(dependentKey)
          if (existing) {
            const newSet = new Set(existing)
            newSet.delete(ticketRefKey(blocker))
            if (newSet.size === 0) {
              newMap.delete(dependentKey)
            } else {
              newMap.set(dependentKey, newSet)
            }
          }
          return { dependencyMap: newMap }
        })
      },

      // ── enterDependencyMode ─────────────────────────────────────────
      enterDependencyMode: (sourceTicketId: string, sourceProjectId?: string) => {
        set({ dependencyMode: { active: true, sourceTicketId, sourceProjectId: sourceProjectId ?? null } })
      },

      // ── exitDependencyMode ──────────────────────────────────────────
      exitDependencyMode: () => {
        set({ dependencyMode: null })
      },

      // ── setHoveredBlockedTicketRef ──────────────────────────────────
      setHoveredBlockedTicketRef: (ref: TicketRef | null) => {
        set({ hoveredBlockedTicketKey: ref ? ticketRefKey(ref) : null })
      }
    }),
    {
      name: 'hive-kanban',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        isBoardViewActive: state.isBoardViewActive,
        isPinnedBoardActive: state.isPinnedBoardActive,
        simpleModeByProject: state.simpleModeByProject
      })
    }
  )
)

// ── Register coordination callback after store creation ──────────────
registerKanbanSessionSync((sessionId, event) => {
  useKanbanStore.getState().syncTicketWithSession(sessionId, event)
})

// ── Register new-session callback: auto-attach pre-assigned tickets ──
registerKanbanNewSession((sessionId, worktreeId, projectId, sessionMode) => {
  const store = useKanbanStore.getState()
  const tickets = store.tickets.get(projectId) ?? []

  // Find the first ticket pre-assigned to this worktree with no active session
  const orphan = tickets.find(
    (t) => t.worktree_id === worktreeId && !t.current_session_id && !t.archived_at
  )
  if (!orphan) return

  // Auto-attach: link session and move to in_progress.
  // Setting `mode` is critical — the progress bar only renders when
  // ticket.mode is truthy, and session_completed only advances tickets
  // whose mode matches 'build' or a plan-like mode.
  const sortOrder = store.computeSortOrder(store.getTicketsByColumn(projectId, 'in_progress'), 0)
  store.updateTicket(orphan.id, projectId, {
    current_session_id: sessionId,
    column: 'in_progress',
    sort_order: sortOrder,
    mode: sessionMode as 'build' | 'plan',
    plan_ready: false
  })
  if (store.isBoardViewActive || store.isPinnedBoardActive) {
    store.setBoardTelegramTarget({
      ticketId: orphan.id,
      projectId,
      worktreeId,
      sessionId
    })
  }
})
