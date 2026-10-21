import { getRendererRpcClient } from './rpc-client'
import type {
  SessionProfilerKillRequest,
  SessionProfilerKillResult,
  SessionProfilerSnapshot
} from '@shared/types/session-profiler'

/**
 * Session profiler (Settings → Advanced → "Session profiler"): the header counter of the agent
 * CLI processes the app has alive. Main samples the OS only when asked, so nothing calls this
 * while the setting is off. Outside the desktop app the backend answers `supported: false`.
 */
export const sessionProfilerApi = {
  getSnapshot: async (): Promise<SessionProfilerSnapshot> =>
    getRendererRpcClient().request<SessionProfilerSnapshot>('sessionProfilerOps.getSnapshot', {}),

  /** Stops a session's process; the session row stays as is, so it resumes on next use. */
  kill: async (request: SessionProfilerKillRequest): Promise<SessionProfilerKillResult> =>
    getRendererRpcClient().request<SessionProfilerKillResult>('sessionProfilerOps.kill', request)
}
