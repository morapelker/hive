import type { KanbanTicket } from '../../../main/db/types'
import { isTerminalBacked } from '@shared/types/agent-sdk'
import { dbApi } from '@/api/db-api'
import { terminalApi } from '@/api/terminal-api'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import {
  useSessionStore,
  type Session,
  type TiledSessionTile
} from '@/stores/useSessionStore'

/** Board scope the tile button was clicked from (mirrors KanbanColumn props) */
export interface TiledScopeInput {
  /** '' on multi-project boards (pinned/connection) — same convention as KanbanColumn */
  projectId: string
  connectionId?: string
  isPinnedMode?: boolean
}

/**
 * Compute the optimal near-square grid for `count` tiles in a `width`x`height`
 * container: picks the column count that maximizes how close each tile gets to
 * the ideal aspect ratio, weighted by cell utilization (fewer empty cells).
 */
export function computeGridLayout(
  count: number,
  width: number,
  height: number,
  idealTileAspect = 1.5
): { cols: number; rows: number } {
  if (count <= 0) return { cols: 1, rows: 1 }
  if (width <= 0 || height <= 0) {
    const cols = Math.ceil(Math.sqrt(count))
    return { cols, rows: Math.ceil(count / cols) }
  }

  let bestCols = 1
  let bestRows = count
  let bestScore = -Infinity
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const tileAspect = width / cols / (height / rows)
    // 1 when the tile hits the ideal aspect, decaying toward 0 either way
    const aspectScore =
      tileAspect >= idealTileAspect ? idealTileAspect / tileAspect : tileAspect / idealTileAspect
    // Penalize layouts with many empty cells (e.g. 5 tiles in a 3x2 grid is fine,
    // 5 tiles in a 4x2 grid wastes 3 cells)
    const utilization = count / (cols * rows)
    const score = aspectScore * utilization
    if (score > bestScore) {
      bestScore = score
      bestCols = cols
      bestRows = rows
    }
  }
  return { cols: bestCols, rows: bestRows }
}

/** Resolve the in-progress tickets for a board scope */
function getInProgressTickets(scope: TiledScopeInput): KanbanTicket[] {
  const kanban = useKanbanStore.getState()
  if (scope.isPinnedMode) return kanban.getTicketsByColumnForPinned('in_progress')
  if (scope.connectionId) {
    return kanban.getTicketsByColumnForConnection(scope.connectionId, 'in_progress')
  }
  return kanban.getTicketsByColumn(scope.projectId, 'in_progress')
}

function getScopeLabel(scope: TiledScopeInput): string {
  if (scope.isPinnedMode) return 'Pinned'
  if (scope.connectionId) {
    const connection = useConnectionStore
      .getState()
      .connections.find((c) => c.id === scope.connectionId)
    return connection?.custom_name || connection?.name || 'Connection'
  }
  const project = useProjectStore.getState().projects.find((p) => p.id === scope.projectId)
  return project?.name ?? 'Project'
}

/** Store-scan first, DB fallback (+ hydrate) — same pattern as KanbanTicketModal */
async function resolveSession(sessionId: string): Promise<Session | null> {
  const store = useSessionStore.getState()
  const inMemory = store.getSessionById(sessionId)
  if (inMemory) return inMemory
  try {
    const dbSession = await dbApi.session.get<Session>(sessionId)
    if (dbSession) {
      // Insert into the store so downstream lookups (SessionView routing,
      // MainPane getAgentSdk) can find it.
      useSessionStore.getState().hydrateSession(dbSession)
      return dbSession
    }
  } catch {
    // Session row missing — treat as no session
  }
  return null
}

/**
 * Build a snapshot of the board's In Progress column and open it as the
 * tiled-sessions tab. Snapshot semantics: the grid is fixed to the column's
 * contents at click time (no live re-flow).
 */
export async function openTiledInProgressSessions(
  scope: TiledScopeInput,
  /** The tickets the column currently displays (search-filtered). Falls back
   * to a fresh store query when omitted. */
  columnTickets?: KanbanTicket[]
): Promise<void> {
  const tickets = columnTickets ?? getInProgressTickets(scope)
  const isMultiProject = !!scope.connectionId || !!scope.isPinnedMode
  const projects = useProjectStore.getState().projects

  // The renderer's mounted-terminal mirror only knows sessions activated in
  // THIS renderer lifetime — a claude-cli PTY can be alive in the backend
  // (e.g. after a window reload, or driven by hooks/subagents with its tab
  // never opened) while the mirror misses it. Ask the backend for the ground
  // truth and use the union. Fail-soft: on RPC failure this is empty and we
  // degrade to the mirror-only behavior.
  const livePtyIds = new Set(await terminalApi.getLiveTerminalIds())

  const tiles: TiledSessionTile[] = []
  const tileBySessionId = new Map<string, TiledSessionTile>()

  for (const ticket of tickets) {
    // One session can serve several tickets (pre-assign / bulk handoff) —
    // merge those tickets into a single tile with joined titles.
    const sharedTile = ticket.current_session_id
      ? tileBySessionId.get(ticket.current_session_id)
      : undefined
    if (sharedTile) {
      sharedTile.ticketIds.push(ticket.id)
      sharedTile.title = `${sharedTile.title} · ${ticket.title}`
      continue
    }

    const session = ticket.current_session_id
      ? await resolveSession(ticket.current_session_id)
      : null

    const agentSdk = session?.agent_sdk ?? null
    // Terminal-backed sessions spawn their process when their view mounts, so
    // "running" means the view is already mounted this run OR the backend
    // reports a live PTY for the session (mounting such a tile reattaches —
    // ptyService.create reuses the live PTY, it never respawns). Chat sessions
    // don't spawn OS processes on mount — active status is enough.
    const isRunning =
      !!session &&
      session.status === 'active' &&
      (!isTerminalBacked(agentSdk) ||
        useSessionStore.getState().mountedTerminalMirror.has(session.id) ||
        livePtyIds.has(session.id))

    const tile: TiledSessionTile = {
      ticketIds: [ticket.id],
      title: ticket.title,
      projectId: ticket.project_id,
      projectName: isMultiProject
        ? (projects.find((p) => p.id === ticket.project_id)?.name ?? null)
        : null,
      sessionId: session?.id ?? null,
      agentSdk,
      isRunning
    }
    tiles.push(tile)
    if (session) tileBySessionId.set(session.id, tile)
  }

  useSessionStore.getState().openTiledSessions({ scopeLabel: getScopeLabel(scope), tiles })
}
