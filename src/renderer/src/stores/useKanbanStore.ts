import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  KanbanTicket,
  KanbanTicketColumn,
  KanbanTicketCreate,
  KanbanTicketDuplicateOverrides,
  KanbanTicketUpdate,
  MarkdownCardDiagnostic,
  TicketDependency
} from '../../../main/db/types'
import {
  registerKanbanSessionSync,
  registerKanbanNewSession,
  registerKanbanAutoCreateTicket,
  registerKanbanRenameSync,
  registerKanbanModelSync,
  type KanbanSessionEvent
} from './store-coordination'
import { CUSTOM_MODEL_PROVIDER_ID } from '@shared/types/custom-provider'
import { isPlanLike } from '../lib/constants'
import { useConnectionStore } from './useConnectionStore'
import { usePinnedStore } from './usePinnedStore'
import { useWorktreeStatusStore } from './useWorktreeStatusStore'
import { kanbanApi as kanban } from '@/api/kanban-api'
import { toast } from '@/lib/toast'

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
  merged: 3,
  done: 4
}

// When the ticket last moved between columns. Falls back to updated_at for
// tickets created before column_changed_at existed (moves used to bump it).
export const ticketTransitionTime = (t: KanbanTicket): string =>
  t.column_changed_at ?? t.updated_at

// Latest transition first — used by Done/Merged (always) and by any column
// whose per-column transition-sort toggle is on
export const byTransitionDesc = (a: KanbanTicket, b: KanbanTicket): number =>
  ticketTransitionTime(b).localeCompare(ticketTransitionTime(a))

export const isDateSortedColumn = (column: KanbanTicketColumn): boolean =>
  column === 'done' || column === 'merged'

// Key for the persisted per-board, per-column transition-sort toggle
// (projectId is '' on pinned/connection boards, mirroring showArchivedByProject)
export const transitionSortKey = (projectId: string, column: KanbanTicketColumn): string =>
  `${projectId}:${column}`

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

async function loadProjectTicketsSnapshot(
  projectId: string,
  includeArchived: boolean
): Promise<{ tickets: KanbanTicket[]; diagnostics: MarkdownCardDiagnostic[] }> {
  const tickets = await kanban.ticket.getByProject<KanbanTicket>(projectId, includeArchived)
  const diagnostics = await kanban.diagnostics
    .get<MarkdownCardDiagnostic>(projectId)
    .catch(() => [])
  return { tickets, diagnostics }
}

/** Pending "move to done/merged" data — drives the MergeOnDoneDialog */
export interface PendingDoneMove {
  ticketId: string
  projectId: string
  sortOrder: number
  targetColumn: 'merged' | 'done'
  /** Connection flow: merge this worktree instead of ticket.worktree_id (which is null) */
  worktreeId?: string
  /** Project owning `worktreeId` — may differ from the ticket's project */
  worktreeProjectId?: string
  /** Connection flow: member worktrees still to merge after the current one */
  remainingWorktrees?: { worktreeId: string; projectId: string }[]
  /**
   * Connection-project flow: offer the archive/keep step for each member
   * worktree (plain connections skip it — archiving would tear a worktree
   * out of a connection the user still needs).
   */
  offerArchive?: boolean
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
  /** Per-board+column "sort by latest transition" toggle (transitionSortKey) — persisted */
  transitionSortByColumn: Record<string, boolean>
  /** Project chosen the last time a ticket was created from the pinned board — persisted */
  pinnedBoardLastCreateProjectId: string | null
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
  /** Pending "move to done/merged" data — set when a feature-branch ticket is dropped on Done or Merged, triggering the merge dialog */
  pendingDoneMove: PendingDoneMove | null
  /** Ephemeral board focus target used by the header Telegram toggle. */
  boardTelegramTarget: BoardTelegramTarget | null
  /** Ephemeral Cmd+F board search — NOT persisted (partialize is inclusion-based). */
  boardSearch: { open: boolean; query: string; searchDescriptions: boolean }

  // ── Actions ────────────────────────────────────────────────────────
  setSelectedTicketId: (id: null) => void
  setSelectedTicketRef: (ref: TicketRef | null) => void
  setBoardTelegramTarget: (target: BoardTelegramTarget | null) => void
  clearBoardTelegramTarget: () => void
  loadTickets: (projectId: string) => Promise<void>
  loadTicketsWithArchiveVisibility: (projectId: string, includeArchived: boolean) => Promise<void>
  reconcileFinishedSessions: (projectId: string) => void
  createTicket: (projectId: string, data: KanbanTicketCreate) => Promise<KanbanTicket>
  duplicateTicket: (
    projectId: string,
    ticketId: string,
    overrides?: KanbanTicketDuplicateOverrides
  ) => Promise<KanbanTicket | null>
  convertMarkdownPlaceholder: (projectId: string, filePath: string) => Promise<KanbanTicket>
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
    sortOrder: number,
    opts?: {
      /**
       * Restoring a prior column, not completing work — don't fire
       * terminal-move side effects (dependent auto-launch / follow-up
       * trigger).
       */
      skipCompletionEffects?: boolean
    }
  ) => Promise<void>
  reorderTicket: (ticketId: string, projectId: string, newSortOrder: number) => Promise<void>
  toggleBoardView: () => void
  setSimpleMode: (projectId: string, enabled: boolean) => Promise<void>
  setPinnedBoardLastCreateProjectId: (projectId: string | null) => void
  setTransitionSort: (projectId: string, column: KanbanTicketColumn, enabled: boolean) => void
  archiveTicket: (ticketId: string, projectId: string) => Promise<void>
  archiveAllDone: (projectId: string, includeMerged?: boolean) => Promise<number>
  unarchiveTicket: (ticketId: string, projectId: string) => Promise<void>
  detachWorktreeTickets: (worktreeId: string) => Promise<void>
  setShowArchived: (projectId: string, show: boolean) => void
  openBoardSearch: () => void
  closeBoardSearch: () => void
  setBoardSearchQuery: (query: string) => void
  setBoardSearchDescriptions: (on: boolean) => void
  setPendingDoneMove: (data: PendingDoneMove) => void
  clearPendingDoneMove: () => void
  completeDoneMove: (expected?: {
    ticketId: string
    projectId: string
    worktreeId?: string
  }) => Promise<void>

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
  /** Close the pinned board unconditionally (navigation intent) — idempotent, unlike togglePinnedBoard. */
  closePinnedBoard: () => void
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

// Explicit follow-up sends that some project's tickets may not have seen —
// the board (or one of several linked projects) hadn't been loaded, so the
// one-shot explicit marker was consumed against an incomplete map.
// sessionId → project IDs whose tickets were loaded when the send fired
// (those already handled it live). reconcileFinishedSessions recovers the
// reopen for projects loaded later. In-memory per app run; entries drop as
// soon as the originating run stops being active (completed / plan_ready /
// error), so a stale marker can never attribute a future unrelated working
// status (e.g. a background auto-resume) to the old send.
const pendingExplicitReopens = new Map<string, Set<string>>()

// Same recovery for implement (plan approval) events: a manual ExitPlanMode
// approval in a CLI terminal emits implement + a PostToolUse working status —
// neither is an explicit send, so an unloaded project would otherwise lose
// the reopen. The auto_approve_plan exclusion is applied at reconcile time,
// when the ticket is available to check. Same lifecycle as above.
const pendingImplementReopens = new Map<string, Set<string>>()

// ── Store ──────────────────────────────────────────────────────────────
export const useKanbanStore = create<KanbanState>()(
  persist(
    (set, get) => ({
      tickets: new Map(),
      isLoading: false,
      isBoardViewActive: false,
      isPinnedBoardActive: false,
      simpleModeByProject: {} as Record<string, boolean>,
      transitionSortByColumn: {} as Record<string, boolean>,
      pinnedBoardLastCreateProjectId: null,
      selectedTicketId: null,
      selectedTicketRef: null,
      isDragging: false,
      draggingTicketKey: null,
      showArchivedByProject: {} as Record<string, boolean>,
      markdownDiagnostics: new Map(),
      markdownPlaceholders: new Map(),
      pendingDoneMove: null,
      boardTelegramTarget: null,
      boardSearch: { open: false, query: '', searchDescriptions: false },
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
          const { tickets, diagnostics } = await loadProjectTicketsSnapshot(
            projectId,
            includeArchived
          )
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
          // Recover any finished-session moves dropped before this load
          get().reconcileFinishedSessions(projectId)
        } catch {
          set({ isLoading: false })
        }
      },

      loadTicketsWithArchiveVisibility: async (projectId: string, includeArchived: boolean) => {
        set({ isLoading: true })
        try {
          const { tickets, diagnostics } = await loadProjectTicketsSnapshot(
            projectId,
            includeArchived
          )
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
          get().reconcileFinishedSessions(projectId)
        } catch {
          set({ isLoading: false })
        }
      },

      // ── reconcileFinishedSessions ────────────────────────────────
      // Safety net for session events that were dropped because this project's
      // tickets weren't loaded when the event fired (e.g. on app relaunch the
      // idle→completed replay can beat the board load). Run after tickets load:
      // any in_progress ticket whose linked session is in a concrete "finished"
      // status is advanced to review, and a done/merged ticket whose session
      // got an explicit follow-up while unloaded is reopened to in_progress.
      reconcileFinishedSessions: (projectId: string) => {
        const tickets = get().tickets.get(projectId) ?? []
        const statuses = useWorktreeStatusStore.getState().sessionStatuses
        // Sessions whose pending explicit send / implement is being
        // attributed to this project in this pass — lets several linked
        // tickets all recover, while the handled-mark stops later reloads
        // from re-attributing.
        const recoveredExplicit = new Set<string>()
        const recoveredImplement = new Set<string>()
        for (const ticket of tickets) {
          if (!ticket.current_session_id) continue
          const status = statuses[ticket.current_session_id]?.status ?? null
          // Attribute pending events to this project on any linked ticket
          // visit (whatever its column) — a re-done ticket must not be
          // reopened by the same event on a future reload.
          const explicitHandled = pendingExplicitReopens.get(ticket.current_session_id)
          if (explicitHandled && !explicitHandled.has(projectId)) {
            explicitHandled.add(projectId)
            recoveredExplicit.add(ticket.current_session_id)
          }
          const implementHandled = pendingImplementReopens.get(ticket.current_session_id)
          if (implementHandled && !implementHandled.has(projectId)) {
            implementHandled.add(projectId)
            recoveredImplement.add(ticket.current_session_id)
          }
          if (ticket.column === 'in_progress') {
            // Only act on positive "finished" evidence — never on progressing/
            // asking/no-status, so we don't yank not-yet-started or actively-
            // running sessions out of in_progress.
            if (status !== 'completed' && status !== 'plan_ready') continue
            if (isPlanLike(ticket.mode) && !ticket.plan_ready) {
              get().updateTicket(ticket.id, projectId, { plan_ready: true }).catch(() => {})
            }
            get().moveTicket(ticket.id, projectId, 'review', ticket.sort_order).catch(() => {})
          } else if (ticket.column === 'done' || ticket.column === 'merged') {
            // Recover an explicit follow-up or plan-approval reopen this
            // project missed while unloaded. Only while the session's run is
            // still active — running or blocked awaiting user input. A
            // session that already finished (or never started) gives no
            // license to leave the terminal column. Archived tickets never
            // reopen, and auto-approved plans don't reopen armed tickets
            // (see the session_working / implement guards).
            if (ticket.archived_at) continue
            const viaExplicit = recoveredExplicit.has(ticket.current_session_id)
            const viaImplement =
              recoveredImplement.has(ticket.current_session_id) && !ticket.auto_approve_plan
            if (!viaExplicit && !viaImplement) continue
            if (
              status !== 'working' &&
              status !== 'planning' &&
              status !== 'answering' &&
              status !== 'permission' &&
              status !== 'command_approval'
            )
              continue
            get()
              .moveTicket(ticket.id, projectId, 'in_progress', ticket.sort_order)
              .catch(() => {})
          }
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
          get().reconcileFinishedSessions(projectId)
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

      // ── duplicateTicket ──────────────────────────────────────────
      duplicateTicket: async (
        projectId: string,
        ticketId: string,
        overrides?: KanbanTicketDuplicateOverrides
      ) => {
        try {
          const ticket = await kanban.ticket.duplicate<KanbanTicket, KanbanTicketDuplicateOverrides>(
            projectId,
            ticketId,
            overrides
          )
          set((state) => {
            const next = new Map(state.tickets)
            const existing = next.get(projectId) ?? []
            next.set(projectId, [...existing, ticket])
            return { tickets: next }
          })
          return ticket
        } catch (err) {
          console.error('Failed to duplicate ticket:', ticketId, err)
          return null
        }
      },

      convertMarkdownPlaceholder: async (projectId: string, filePath: string) => {
        const ticket = await kanban.markdown.convertFileToCard<KanbanTicket>(projectId, filePath)
        const includeArchived =
          get().showArchivedByProject[projectId] ?? get().showArchivedByProject[''] ?? false
        await get().loadTicketsWithArchiveVisibility(projectId, includeArchived)
        return ticket
      },

      // ── updateTicket (optimistic) ────────────────────────────────
      updateTicket: async (ticketId: string, projectId: string, data: KanbanTicketUpdate) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Optimistic local update (column_changed_at mirrors the backend bump on
        // column changes so transition-sorted columns place the ticket right away)
        const updatedAt = new Date().toISOString()
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId
              ? {
                  ...t,
                  ...data,
                  column_changed_at:
                    data.column !== undefined && data.column !== t.column
                      ? updatedAt
                      : t.column_changed_at
                }
              : t
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
      // includeMerged: when the Merged column is hidden, merged tickets fold
      // into Done, so "Archive all" covers them too
      archiveAllDone: async (projectId: string, includeMerged?: boolean): Promise<number> => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        const now = new Date().toISOString()
        let count = 0
        // Optimistic local archive of all non-archived done tickets
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) => {
            if (
              (t.column === 'done' || (includeMerged && t.column === 'merged')) &&
              !t.archived_at
            ) {
              count++
              return { ...t, archived_at: now, updated_at: now }
            }
            return t
          })
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.archiveAllDone(projectId, includeMerged)
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

      // ── Board search (Cmd+F) ───────────────────────────────────────
      openBoardSearch: () => {
        const s = get().boardSearch
        if (!s.open) set({ boardSearch: { ...s, open: true } })
      },
      // Close = clear query + restore full board; searchDescriptions persists for the app session.
      closeBoardSearch: () => {
        const s = get().boardSearch
        if (!s.open && s.query === '') return
        set({ boardSearch: { ...s, open: false, query: '' } })
      },
      setBoardSearchQuery: (query: string) => {
        set({ boardSearch: { ...get().boardSearch, query } })
      },
      setBoardSearchDescriptions: (on: boolean) => {
        set({ boardSearch: { ...get().boardSearch, searchDescriptions: on } })
      },

      // ── moveTicket (optimistic) ──────────────────────────────────
      moveTicket: async (
        ticketId: string,
        projectId: string,
        column: KanbanTicketColumn,
        sortOrder: number,
        opts?: { skipCompletionEffects?: boolean }
      ) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Optimistic local update (updated_at/column_changed_at mirror the backend
        // bumps so transition-sorted columns place the ticket correctly right away)
        const moveStartedAtMs = Date.now()
        const movedAt = new Date(moveStartedAtMs).toISOString()
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId
              ? {
                  ...t,
                  column,
                  sort_order: sortOrder,
                  updated_at: movedAt,
                  column_changed_at: t.column === column ? t.column_changed_at : movedAt
                }
              : t
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

          // Entering the done column ends the ticket's work: close the attached
          // session so its agent process dies now and the tab is not restored on
          // the next worktree selection or app launch. Done only — a merged
          // move must NOT close the session (user decision). Lives in the
          // renderer because it is the only production caller of this RPC and
          // the server child cannot reach main-process PTYs — a future
          // non-renderer mover (bots, automations) needs its own server-side
          // hook.
          if (
            !opts?.skipCompletionEffects &&
            column === 'done' &&
            movedTicket?.current_session_id &&
            movedTicket.column !== column
          ) {
            const sessionIdToClose = movedTicket.current_session_id
            try {
              // One session can serve several tickets (pre-assign attaches the
              // worktree's session to every ticket; handoffs relink in bulk).
              // Closing it while another live ticket still rides it would kill
              // that ticket's in-flight work — skip, and skip too when the
              // link set cannot be verified.
              const linked = await kanban.ticket.getBySession<KanbanTicket>(sessionIdToClose)
              const sharedWithLiveTicket = linked.some(
                (t) =>
                  t.id !== ticketId &&
                  !t.archived_at &&
                  t.column !== 'done' &&
                  t.column !== 'merged'
              )
              // The awaits above race two newer intents: the user dragging the
              // ticket back out of done, and a background revival (follow-up
              // send, plan approval) putting the session back to work. Re-check
              // both from current state right before closing — the newer intent
              // wins. Only status transitions stamped AFTER this move count as
              // revivals: a session that was merely still working when the user
              // dragged to done must still be closed (that is the feature).
              const ticketNow = get()
                .tickets.get(projectId)
                ?.find((t) => t.id === ticketId)
              const statusEntry =
                useWorktreeStatusStore.getState().sessionStatuses[sessionIdToClose]
              const revivedDuringMove =
                statusEntry != null &&
                statusEntry.timestamp > moveStartedAtMs &&
                (statusEntry.status === 'working' ||
                  statusEntry.status === 'planning' ||
                  statusEntry.status === 'answering' ||
                  statusEntry.status === 'permission' ||
                  statusEntry.status === 'command_approval')
              const { useSessionStore, isSessionReactivating } = await import('./useSessionStore')
              if (
                !sharedWithLiveTicket &&
                ticketNow?.column === 'done' &&
                !revivedDuringMove &&
                // A revival can start before its status stamp lands — never
                // close while a reactivation/reopen is in flight.
                !isSessionReactivating(sessionIdToClose)
              ) {
                // No awaits sit between the guards above and this call, and
                // closeSession performs the remote stop and the close INSIDE
                // its per-session lifecycle lock (after re-checking
                // abortIfRevived there), so guard and transitions are atomic.
                // closeSession reports failures via its result, not by
                // throwing — surface non-aborted failures.
                void (async () => {
                  const result = await useSessionStore
                    .getState()
                    .closeSession(sessionIdToClose, { abortIfRevived: true, stopRemote: true })
                  if (!result.success && !result.aborted) {
                    console.error(
                      'Failed to close session for completed ticket:',
                      sessionIdToClose,
                      result.error
                    )
                    toast.error(
                      `Ticket is done, but its session could not be closed: ${result.error ?? 'unknown error'}`
                    )
                  }
                  if (result.success) {
                    // A drag back out of Done during the close (which does not
                    // mark the session reactivating) means the newer intent is
                    // to keep working — undo: restore active status and tab.
                    // Only when the ticket still references this session; the
                    // backward-drag-to-todo flow completes and unlinks it on
                    // purpose and must not be undone.
                    const ticketAfter = get()
                      .tickets.get(projectId)
                      ?.find((t) => t.id === ticketId)
                    if (
                      ticketAfter &&
                      ticketAfter.column !== 'done' &&
                      ticketAfter.current_session_id === sessionIdToClose
                    ) {
                      await useSessionStore.getState().reactivateSession(sessionIdToClose)
                    }
                  }
                })().catch((err) => {
                  console.error(
                    'Failed to close session for completed ticket:',
                    sessionIdToClose,
                    err
                  )
                })
              }
            } catch (err) {
              console.error('Skipping session close — link check failed:', sessionIdToClose, err)
            }
          }

          // When a ticket moves to done (or review, if that's the trigger), check if any dependents can be auto-launched
          const { useSettingsStore } = await import('./useSettingsStore')
          const { isBlockerSatisfied } = await import('../lib/blocker-utils')
          const triggerColumn = useSettingsStore.getState().followUpTriggerColumn
          if (
            !opts?.skipCompletionEffects &&
            (column === 'done' ||
              column === 'merged' ||
              (triggerColumn === 'review' && column === 'review' && movedTicket?.mode === 'build'))
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
        // If the tiled-sessions tab holds the pane, the user's intent is
        // "show the board": deactivate the tiled tab and force the board ON
        // (toggling would flip an already-true persisted flag to false with
        // no visible change). Dynamic import avoids a store dependency cycle.
        void import('./useSessionStore').then(({ useSessionStore }) => {
          const wasTiled = useSessionStore.getState().isTiledSessionsActive
          if (wasTiled) useSessionStore.getState().deactivateTiledSessions()
          set((state) => ({ isBoardViewActive: wasTiled ? true : !state.isBoardViewActive }))
        })
      },

      // ── setTransitionSort ────────────────────────────────────────
      setTransitionSort: (projectId: string, column: KanbanTicketColumn, enabled: boolean) => {
        set((state) => ({
          transitionSortByColumn: {
            ...state.transitionSortByColumn,
            [transitionSortKey(projectId, column)]: enabled
          }
        }))
      },

      // ── setPinnedBoardLastCreateProjectId ────────────────────────
      setPinnedBoardLastCreateProjectId: (projectId: string | null) => {
        set({ pinnedBoardLastCreateProjectId: projectId })
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

            // 'done' and 'merged' are terminal columns: once a user moves a
            // ticket there, no session event may auto-move it back. This
            // matters on app relaunch/focus, when a still-active session
            // re-emits its status (e.g. an `idle` replay → session_completed)
            // for a done/merged ticket. Each column-moving branch below guards
            // on those columns. Exceptions: a session_working caused by an
            // explicit user follow-up (event.explicitSend) and a plan approval
            // (implement) return the ticket to in_progress — resuming work on
            // a done/merged ticket reopens it.
            switch (event.type) {
              case 'session_completed': {
                // Plan tickets: surface the finished plan for the review UI.
                if (isPlanLike(ticket.mode) && !ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                }
                // The session finished → its progress bar is gone. Any non-terminal
                // ticket must advance to review regardless of mode/plan state (board
                // invariant: in_progress ⇔ a running progress bar). Move is idempotent.
                if (
                  ticket.column !== 'review' &&
                  ticket.column !== 'done' &&
                  ticket.column !== 'merged'
                ) {
                  get()
                    .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                    .catch(() => {})
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
                // Explicit plan.ready event — set the flag for plan tickets...
                if (isPlanLike(ticket.mode) && !ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                }
                // ...and move any non-terminal ticket to review. A build ticket can
                // land here when its completion is rerouted to plan_ready by a stale
                // lastSendMode, so the move must not be gated on mode.
                if (
                  ticket.column !== 'review' &&
                  ticket.column !== 'done' &&
                  ticket.column !== 'merged'
                ) {
                  get()
                    .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                    .catch(() => {})
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
                if (
                  ticket.column !== 'in_progress' &&
                  ticket.column !== 'done' &&
                  ticket.column !== 'merged'
                ) {
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
                // Plan approved from session view — clear plan_ready, set mode to
                // build, and consume the one-shot auto-approve flag.
                if (ticket.plan_ready || ticket.mode !== 'build' || ticket.auto_approve_plan) {
                  get()
                    .updateTicket(ticket.id, projectId, {
                      plan_ready: false,
                      mode: 'build',
                      auto_approve_plan: false
                    })
                    .catch(() => {})
                }
                // Approving a plan on a done/merged ticket resumes real work,
                // but its working status carries no send stamp (opencode) or a
                // PostToolUse hook (CLI), so session_working won't reopen it —
                // reopen here instead. Except when auto_approve_plan is armed:
                // the hook server answers ExitPlanMode with no fresh user
                // action, and the manual move to done/merged is the newer
                // intent. Manual modal / plan-card approvals still reopen via
                // their explicit send stamps. Other columns keep moving via
                // session_working as before.
                if (
                  (ticket.column === 'done' || ticket.column === 'merged') &&
                  !ticket.auto_approve_plan &&
                  !ticket.archived_at
                ) {
                  get()
                    .moveTicket(ticket.id, projectId, 'in_progress', ticket.sort_order)
                    .catch(() => {})
                  // The done-move closed this session; the approved plan puts it
                  // back to work — restore its active status and tab (no focus
                  // change) so the process is not culled as a completed leftover.
                  import('./useSessionStore')
                    .then(({ useSessionStore }) =>
                      useSessionStore.getState().reactivateSession(sessionId)
                    )
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
                // todo (pre-assigned, first activity) or review (returning to
                // work). done/merged move only for explicit user follow-ups
                // (never for streaming re-emits or status replays).
                if (ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: false })
                    .catch(() => {})
                }
                // Archived tickets never reopen: clearing the column while
                // archived_at persists would strand them (the archive UI only
                // renders archived done/merged, so Unarchive would be lost).
                const reopenedByFollowup =
                  event.explicitSend === true &&
                  (ticket.column === 'done' || ticket.column === 'merged') &&
                  !ticket.archived_at
                if (
                  ticket.column === 'todo' ||
                  ticket.column === 'review' ||
                  reopenedByFollowup
                ) {
                  get()
                    .moveTicket(ticket.id, projectId, 'in_progress', ticket.sort_order)
                    .catch(() => {})
                  if (reopenedByFollowup) {
                    // An explicit follow-up revived a done-closed session —
                    // restore its active status and tab (no focus change).
                    import('./useSessionStore')
                      .then(({ useSessionStore }) =>
                        useSessionStore.getState().reactivateSession(sessionId)
                      )
                      .catch(() => {})
                  }
                }
                break
              }
            }
          }
        }
        // Remember explicit sends and plan approvals so projects whose
        // tickets weren't loaded yet can recover the reopen on load
        // (reconcileFinishedSessions). The currently-loaded projects have
        // already handled the event live.
        if (event.type === 'session_working' && event.explicitSend === true) {
          pendingExplicitReopens.set(sessionId, new Set(allTickets.keys()))
        }
        if (event.type === 'implement') {
          pendingImplementReopens.set(sessionId, new Set(allTickets.keys()))
        }
        // The run ended or its status was cleared (canceled dispatch,
        // interrupt, teardown) — any not-yet-recovered reopen is moot, and a
        // stale marker must not reopen a ticket on a future unrelated run.
        if (
          event.type === 'session_completed' ||
          event.type === 'plan_ready' ||
          event.type === 'session_error' ||
          event.type === 'status_cleared'
        ) {
          pendingExplicitReopens.delete(sessionId)
          pendingImplementReopens.delete(sessionId)
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

      completeDoneMove: async (expected) => {
        const pending = get().pendingDoneMove
        if (!pending) return
        // Stale async completion (e.g. a merge resolving after the dialog was
        // dismissed and another ticket set a new pending move) must not
        // advance or move an unrelated pending state
        if (
          expected &&
          (expected.ticketId !== pending.ticketId ||
            expected.projectId !== pending.projectId ||
            expected.worktreeId !== pending.worktreeId)
        ) {
          return
        }
        // Connection flow: advance to the next member worktree before moving
        // the ticket — the move only happens after the last worktree finishes
        const [nextWorktree, ...restWorktrees] = pending.remainingWorktrees ?? []
        if (nextWorktree) {
          set({
            pendingDoneMove: {
              ticketId: pending.ticketId,
              projectId: pending.projectId,
              sortOrder: pending.sortOrder,
              targetColumn: pending.targetColumn,
              worktreeId: nextWorktree.worktreeId,
              worktreeProjectId: nextWorktree.projectId,
              remainingWorktrees: restWorktrees,
              offerArchive: pending.offerArchive
            }
          })
          return
        }
        set({ pendingDoneMove: null })
        await get().moveTicket(
          pending.ticketId,
          pending.projectId,
          pending.targetColumn,
          pending.sortOrder
        )
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
        const sortByTransition =
          isDateSortedColumn(column) ||
          (get().transitionSortByColumn[transitionSortKey(projectId, column)] ?? false)
        return tickets
          .filter((t) => t.column === column && !t.archived_at)
          .sort(sortByTransition ? byTransitionDesc : (a, b) => a.sort_order - b.sort_order)
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
          // Load dependencies + recover dropped finished-session moves per project
          for (const pid of projectIds) {
            get().loadDependencies(pid)
            get().reconcileFinishedSessions(pid)
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
        const sortByTransition =
          isDateSortedColumn(column) ||
          (get().transitionSortByColumn[transitionSortKey('', column)] ?? false)
        merged.sort(sortByTransition ? byTransitionDesc : (a, b) => a.sort_order - b.sort_order)
        return merged
      },

      getInvalidPlaceholdersForConnection: (connectionId: string): MarkdownCardPlaceholder[] => {
        const projectIds = get().getConnectionProjectIds(connectionId)
        return projectIds.flatMap((pid) => get().getInvalidPlaceholdersForProject(pid))
      },

      // ── togglePinnedBoard ────────────────────────────────────────
      togglePinnedBoard: () => {
        // Same intent resolution as toggleBoardView (see comment there).
        void import('./useSessionStore').then(({ useSessionStore }) => {
          const wasTiled = useSessionStore.getState().isTiledSessionsActive
          if (wasTiled) useSessionStore.getState().deactivateTiledSessions()
          set((state) => ({ isPinnedBoardActive: wasTiled ? true : !state.isPinnedBoardActive }))
        })
      },

      // ── closePinnedBoard ─────────────────────────────────────────
      // Sidebar navigation closes the board by setting the flag directly:
      // togglePinnedBoard is async (dynamic import) and tiled-aware, so two
      // queued "close" toggles cancel out and leave the board active.
      closePinnedBoard: () => {
        set((state) => (state.isPinnedBoardActive ? { isPinnedBoardActive: false } : state))
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
          // Load dependencies + recover dropped finished-session moves per project
          for (const pid of projectIds) {
            get().loadDependencies(pid)
            get().reconcileFinishedSessions(pid)
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
        const sortByTransition =
          isDateSortedColumn(column) ||
          (get().transitionSortByColumn[transitionSortKey('', column)] ?? false)
        merged.sort(sortByTransition ? byTransitionDesc : (a, b) => a.sort_order - b.sort_order)
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
        simpleModeByProject: state.simpleModeByProject,
        transitionSortByColumn: state.transitionSortByColumn,
        pinnedBoardLastCreateProjectId: state.pinnedBoardLastCreateProjectId
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

// ── Register auto-create-ticket callback (first message of a session) ──
// Creates a kanban ticket in the session's project on the first user message,
// when the "automatically create ticket" setting is on. Idempotent: skips if a
// ticket is already linked to the session (e.g. auto-attach above already ran).
registerKanbanAutoCreateTicket(({ sessionId, rawPrompt }) => {
  void (async () => {
    try {
      const [{ useSettingsStore }, { useSessionStore }] = await Promise.all([
        import('./useSettingsStore'),
        import('./useSessionStore')
      ])
      if (!useSettingsStore.getState().automaticallyCreateTicket) return

      const session = useSessionStore.getState().getSessionById(sessionId)
      if (!session) return
      // Raw terminals and the board assistant have no real "prompt" to capture.
      if (session.session_type === 'board-assistant' || session.agent_sdk === 'terminal') return

      // Idempotency gate (authoritative — immune to the auto-attach timing and a
      // stale in-memory tickets map): skip if any non-archived ticket is linked.
      const existing = await kanban.ticket.getBySession<KanbanTicket>(sessionId)
      if (existing.some((t) => !t.archived_at)) return

      const trimmed = rawPrompt.trim()
      const hasText = trimmed.length > 0
      const title = hasText ? trimmed.split(/\s+/).slice(0, 10).join(' ') : 'Untitled session'

      const store = useKanbanStore.getState()
      const sortOrder = store.computeSortOrder(
        store.getTicketsByColumn(session.project_id, 'in_progress'),
        0
      )
      await store.createTicket(session.project_id, {
        project_id: session.project_id,
        title,
        description: hasText ? rawPrompt : null,
        column: 'in_progress',
        sort_order: sortOrder,
        current_session_id: sessionId,
        worktree_id: session.worktree_id,
        mode: session.mode,
        created_from_session: true
      })

      // Mirror the manual-open behavior: when auto-pin is enabled, pin the
      // project's root/base worktree so the auto-created ticket shows on the
      // pinned board. No-op unless `autoPinBaseWorktreeOnBoardPrompt` is on.
      const { autoPinBaseWorktree } = await import('@/lib/auto-pin')
      void autoPinBaseWorktree(session.project_id)
    } catch {
      // Best-effort — never disrupt the user's send/prompt flow.
    }
  })()
})

// ── Register rename-sync callback (session renamed → ticket title) ────
// Keeps an auto-created ticket's title in sync with its session's name, for
// both manual renames and LLM auto-titles. Gated on the setting so disabling it
// freezes existing auto-created tickets too. Only touches created_from_session
// tickets, so a session started FROM a hand-written ticket is never clobbered.
registerKanbanRenameSync((sessionId, name) => {
  void (async () => {
    try {
      const { useSettingsStore } = await import('./useSettingsStore')
      if (!useSettingsStore.getState().automaticallyCreateTicket) return
      if (/^Session \d+$/.test(name.trim())) return // never sync a placeholder over a real title

      const store = useKanbanStore.getState()
      for (const [projectId, tickets] of store.tickets.entries()) {
        for (const ticket of tickets) {
          if (
            ticket.current_session_id === sessionId &&
            ticket.created_from_session &&
            !ticket.archived_at
          ) {
            if (ticket.title !== name) {
              store.updateTicket(ticket.id, projectId, { title: name }).catch(() => {})
            }
            return
          }
        }
      }

      // Fallback: the ticket's board may not be loaded into the map yet.
      const linked = await kanban.ticket.getBySession<KanbanTicket>(sessionId)
      const target = linked.find((t) => t.created_from_session && !t.archived_at)
      if (target && target.title !== name) {
        store.updateTicket(target.id, target.project_id, { title: name }).catch(() => {})
      }
    } catch {
      // Best-effort.
    }
  })()
})

// ── Register model-sync callback (mid-session model change → ticket badge) ──
// The CLI can switch models mid-session (usage-limit or safety degradation,
// /model in the terminal). Main persists the session row and the session store
// patches its maps; this syncs the linked ticket's badge so the board shows
// the model actually running. Only tickets that already carry a model are
// touched — a model-less ticket has no stale badge to fix — and custom-provider
// slugs are never overwritten with a stock alias.
registerKanbanModelSync((sessionId, model) => {
  void (async () => {
    try {
      const store = useKanbanStore.getState()
      const apply = (ticket: KanbanTicket, projectId: string): void => {
        if (!ticket.model_id || ticket.model_provider_id === CUSTOM_MODEL_PROVIDER_ID) return
        const patch: KanbanTicketUpdate = {}
        if (ticket.model_id !== model.modelId) patch.model_id = model.modelId
        if (model.modelVariant !== undefined && ticket.model_variant !== model.modelVariant) {
          patch.model_variant = model.modelVariant
        }
        if (Object.keys(patch).length === 0) return
        store.updateTicket(ticket.id, projectId, patch).catch(() => {})
      }

      let matched = false
      for (const [projectId, tickets] of store.tickets.entries()) {
        for (const ticket of tickets) {
          if (ticket.current_session_id === sessionId && !ticket.archived_at) {
            matched = true
            apply(ticket, projectId)
          }
        }
      }
      if (matched) return

      // Fallback: the ticket's board may not be loaded into the map yet.
      const linked = await kanban.ticket.getBySession<KanbanTicket>(sessionId)
      for (const target of linked) {
        if (!target.archived_at) apply(target, target.project_id)
      }
    } catch {
      // Best-effort.
    }
  })()
})
