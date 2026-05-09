import { BOARD_TAB_ID, useSessionStore } from '@/stores/useSessionStore'
import { type BoardTelegramTarget, useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { KanbanTicket } from '../../../main/db/types'

export interface TelegramForwardingTarget {
  sessionId: string | null
  worktreeId: string | null
  connectionId: string | null
  source: 'board-ticket' | 'active-session'
}

export interface TelegramForwardingTargetSnapshot {
  activeSessionId: string | null
  activeWorktreeId: string | null
  activeConnectionId: string | null
  activePinnedSessionId: string | null
  sessionsByWorktree: Map<string, Array<{ id: string }>>
  sessionsByConnection: Map<string, Array<{ id: string }>>
  boardMode: 'toggle' | 'sticky-tab'
  boardTelegramTarget: BoardTelegramTarget | null
  isBoardViewActive: boolean
  isPinnedBoardActive: boolean
  tickets: Map<string, KanbanTicket[]>
}

function getSnapshot(): TelegramForwardingTargetSnapshot {
  const sessionState = useSessionStore.getState()
  const kanbanState = useKanbanStore.getState()
  return {
    activeSessionId: sessionState.activeSessionId,
    activeWorktreeId: sessionState.activeWorktreeId,
    activeConnectionId: sessionState.activeConnectionId,
    activePinnedSessionId: sessionState.activePinnedSessionId,
    sessionsByWorktree: sessionState.sessionsByWorktree,
    sessionsByConnection: sessionState.sessionsByConnection,
    boardMode: useSettingsStore.getState().boardMode,
    boardTelegramTarget: kanbanState.boardTelegramTarget,
    isBoardViewActive: kanbanState.isBoardViewActive,
    isPinnedBoardActive: kanbanState.isPinnedBoardActive,
    tickets: kanbanState.tickets
  }
}

function sessionExists(snapshot: TelegramForwardingTargetSnapshot, sessionId: string): boolean {
  for (const sessions of snapshot.sessionsByWorktree.values()) {
    if (sessions.some((session) => session.id === sessionId)) return true
  }
  for (const sessions of snapshot.sessionsByConnection.values()) {
    if (sessions.some((session) => session.id === sessionId)) return true
  }
  return false
}

function isBoardVisible(snapshot: TelegramForwardingTargetSnapshot): boolean {
  if (snapshot.isPinnedBoardActive) return true
  if (snapshot.isBoardViewActive && !snapshot.activePinnedSessionId) return true
  return snapshot.boardMode === 'sticky-tab' && snapshot.activeSessionId === BOARD_TAB_ID
}

function getValidBoardTarget(snapshot: TelegramForwardingTargetSnapshot): TelegramForwardingTarget | null {
  if (!isBoardVisible(snapshot)) return null

  const target = snapshot.boardTelegramTarget
  if (!target || !sessionExists(snapshot, target.sessionId)) return null

  const projectTickets = snapshot.tickets.get(target.projectId)
  if (projectTickets) {
    const ticket = projectTickets.find((item) => item.id === target.ticketId)
    if (!ticket || ticket.current_session_id !== target.sessionId || ticket.worktree_id !== target.worktreeId) {
      return null
    }
  }

  return {
    sessionId: target.sessionId,
    worktreeId: target.worktreeId,
    connectionId: null,
    source: 'board-ticket'
  }
}

export function getTelegramForwardingTarget(
  snapshot: TelegramForwardingTargetSnapshot = getSnapshot()
): TelegramForwardingTarget {
  const boardTarget = getValidBoardTarget(snapshot)
  if (boardTarget) return boardTarget

  if (!snapshot.activeSessionId || snapshot.activeSessionId === BOARD_TAB_ID) {
    return { sessionId: null, worktreeId: null, connectionId: null, source: 'active-session' }
  }

  return {
    sessionId: snapshot.activeSessionId,
    worktreeId: snapshot.activeWorktreeId,
    connectionId: snapshot.activeConnectionId,
    source: 'active-session'
  }
}
