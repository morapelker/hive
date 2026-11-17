// This window tells the backend which of its sessions are running, so that a project with a
// running session is not moved to the dev folder (Settings › General, "Move projects"). The
// live status of a session exists only in this window (the status store), so this window is
// the one that reports: the whole set of running session ids.
//
// Sent once at start (an empty set says "nothing is running"), on every change of the set, and
// again whenever the socket reopens: the backend keeps a report only for as long as the socket
// that sent it is open.
import type { HiveClient } from '@/api/hive-client'
import { getRendererRpcClient } from '@/api/rpc-client'
import { settingsApi } from '@/api/settings-api'
import { lastSendMode } from '@/lib/message-send-times'
import { useWorktreeStatusStore, type SessionStatusEntry } from '@/stores/useWorktreeStatusStore'
import { RUNNING_SESSIONS_REPORT_MAX, runningStateOfStatus } from '@shared/session-running-state'

/** Status bursts (a session leaving one state for the next) are folded into one report. */
export const RUNNING_REPORT_DEBOUNCE_MS = 150
/** A report the backend did not take is sent again after this wait (and when the socket reopens). */
export const RUNNING_REPORT_RETRY_MS = 2_000

type StatusMap = Readonly<Record<string, SessionStatusEntry | null | undefined>>

/**
 * The ids of the sessions that are running by the definition of
 * shared/session-running-state.ts, sorted. A turn that ended in plan mode counts as a plan
 * waiting for approval, as the sidebar reads it ("Plan ready",
 * `useWorktreeStatusStore.getWorktreeStatus`).
 */
export function runningSessionIdsOf(
  statuses: StatusMap,
  sentInPlanMode: (sessionId: string) => boolean = (id) => lastSendMode.get(id) === 'plan'
): string[] {
  const ids: string[] = []
  for (const [sessionId, entry] of Object.entries(statuses)) {
    if (!entry) continue
    const planReady = entry.status === 'completed' && !entry.apiError && sentInPlanMode(sessionId)
    if (planReady || runningStateOfStatus(entry.status)) ids.push(sessionId)
  }
  ids.sort()
  return ids.slice(0, RUNNING_SESSIONS_REPORT_MAX)
}

/** A listener for every (re)connect of the RPC socket; a no-op while there is no client. */
const onRpcOpen = (listener: () => void): (() => void) => {
  try {
    const client = getRendererRpcClient() as Partial<Pick<HiveClient, 'onOpen'>>
    if (typeof client.onOpen === 'function') return client.onOpen(listener)
  } catch {
    // No RPC client yet (tests).
  }
  return () => {}
}

let stopReport: (() => void) | null = null

/** Starts reporting (called once from the app layout); returns the stop. */
export function startRunningSessionsReport(): () => void {
  if (stopReport) return stopReport
  /** What the backend last accepted, null = it must be told again. */
  let accepted: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const retryLater = (): void => {
    if (stopped || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      send(false)
    }, RUNNING_REPORT_RETRY_MS)
  }

  const send = (force: boolean): void => {
    if (stopped) return
    const sessionIds = runningSessionIdsOf(useWorktreeStatusStore.getState().sessionStatuses)
    const key = JSON.stringify(sessionIds)
    if (!force && key === accepted) return
    accepted = key
    let pending: Promise<unknown>
    try {
      pending = settingsApi.reportRunningSessions(sessionIds)
    } catch (error) {
      // No RPC client yet: the socket's open sends it
      accepted = null
      console.warn('[running-sessions] could not report the running sessions', error)
      return
    }
    void pending.catch((error: unknown) => {
      // Without this the backend would keep the last set it did take
      if (accepted === key) {
        accepted = null
        retryLater()
      }
      console.warn('[running-sessions] could not report the running sessions', error)
    })
  }

  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      send(false)
    }, RUNNING_REPORT_DEBOUNCE_MS)
  }

  const stops = [
    useWorktreeStatusStore.subscribe((state, prev) => {
      if (state.sessionStatuses !== prev.sessionStatuses) schedule()
    }),
    // A new socket is a new reporter to the backend: it knows nothing of what the old one said
    onRpcOpen(() => send(true))
  ]
  send(true)
  stopReport = () => {
    stopped = true
    for (const stop of stops) stop()
    if (timer) clearTimeout(timer)
    if (retryTimer) clearTimeout(retryTimer)
    timer = null
    retryTimer = null
    stopReport = null
  }
  return stopReport
}
