// What "running" means for an agent session, in one place. A session is running while it is
// working or planning, or while it waits on a person: a question, a permission or command
// approval, a plan waiting for approval. Finished, idle and merely unread sessions are not
// running. The window reports its running sessions to the backend with this definition
// (renderer lib/running-sessions-report.ts), and a project with one of them is not moved to the
// dev folder.
import type { SessionStatusType } from './types/session-status'

/** `working` = the agent is busy; `waiting` = it cannot go on until a person acts. */
export type SessionRunningState = 'working' | 'waiting'

const RUNNING_STATE_BY_STATUS: Readonly<Record<SessionStatusType, SessionRunningState | null>> = {
  working: 'working',
  planning: 'working',
  answering: 'waiting',
  permission: 'waiting',
  command_approval: 'waiting',
  plan_ready: 'waiting',
  completed: null,
  unread: null
}

/** The running state a session status stands for, null when the session is not running. */
export const runningStateOfStatus = (
  status: SessionStatusType | null | undefined
): SessionRunningState | null => (status ? (RUNNING_STATE_BY_STATUS[status] ?? null) : null)

/** The RPC the window reports its running sessions with: `{ sessionIds }`, the whole set each time. */
export const RUNNING_SESSIONS_REPORT_RPC = 'settingsOps.reportRunningSessions'

/** The most sessions one report may name. */
export const RUNNING_SESSIONS_REPORT_MAX = 500
