import { isCliAgentSdk } from '@shared/types/agent-sdk'
import { isPlanLike } from './constants'
import type { KanbanTicket } from '../../../main/db/types'

/**
 * Whether the "Auto approve" toggle applies to this ticket: a plan/super-plan
 * claude-cli ticket (or one with no session yet, so it can be pre-armed) whose
 * plan is not already awaiting approval. Goal-mode tickets keep their own
 * plan→implementor handoff flow and are excluded.
 */
export function canToggleAutoApprovePlan(
  ticket: Pick<KanbanTicket, 'mode' | 'goal_mode' | 'plan_ready' | 'current_session_id'>,
  linkedSessionAgentSdk: string | null
): boolean {
  if (!isPlanLike(ticket.mode)) return false
  if (ticket.goal_mode) return false
  if (ticket.plan_ready) return false
  if (ticket.current_session_id && !isCliAgentSdk(linkedSessionAgentSdk)) return false
  return true
}
