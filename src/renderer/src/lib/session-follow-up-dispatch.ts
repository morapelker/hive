const inFlightSessions = new Set<string>()
const deferredIdleSessions = new Set<string>()

export interface SessionFollowUpDispatchOptions {
  sessionId: string
  isBlocked?: () => boolean
  dequeueFollowUp: () => string | null
  requeueFollowUp: (message: string) => void
  onBeforeDispatch?: (message: string) => void
  dispatchFollowUp: (message: string) => Promise<boolean>
  onDispatchFailure?: (message: string) => void
  onComplete: () => void
}

export type SessionFollowUpDispatchResult =
  | 'blocked'
  | 'deferred'
  | 'dispatched'
  | 'completed'
  | 'failed'

export async function handleSessionIdleFollowUp(
  options: SessionFollowUpDispatchOptions
): Promise<SessionFollowUpDispatchResult> {
  const { sessionId } = options

  if (options.isBlocked?.()) {
    return 'blocked'
  }

  if (inFlightSessions.has(sessionId)) {
    deferredIdleSessions.add(sessionId)
    return 'deferred'
  }

  const followUp = options.dequeueFollowUp()
  if (!followUp) {
    options.onComplete()
    return 'completed'
  }

  inFlightSessions.add(sessionId)

  let dispatchSucceeded = false
  try {
    options.onBeforeDispatch?.(followUp)
    dispatchSucceeded = await options.dispatchFollowUp(followUp)
  } catch {
    dispatchSucceeded = false
  }

  if (!dispatchSucceeded) {
    options.requeueFollowUp(followUp)
    options.onDispatchFailure?.(followUp)
  }

  inFlightSessions.delete(sessionId)

  if (dispatchSucceeded && deferredIdleSessions.delete(sessionId)) {
    return handleSessionIdleFollowUp(options)
  }

  deferredIdleSessions.delete(sessionId)
  return dispatchSucceeded ? 'dispatched' : 'failed'
}

export function resetSessionFollowUpDispatchState(): void {
  inFlightSessions.clear()
  deferredIdleSessions.clear()
}
