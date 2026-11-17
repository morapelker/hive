// The server child's half of organization learning
// (main/services/usage/claude-organization-signal.ts).
//
// "A Claude account's organization was stored" travels to the Electron main process as the
// `claudeOrganizationLearned` desktop command, where the live usage updater may be holding a
// reading for that organization. Sent and forgotten: main's answer is not awaited (no listener
// is kept for it), because a signal that gets lost costs a second at most: main re-checks the
// readings it holds on a timer. Without an IPC channel (browser server mode, tests) there is
// no main and nothing is sent.
//
// "Organizations are needed" arrives from main on the event bus and starts the learner.

import { Effect } from 'effect'
import { requestClaudeOrganizationLearning } from '../main/services/account-maintenance'
import {
  CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL,
  setClaudeOrganizationLearnedPublisher
} from '../main/services/usage/claude-organization-signal'
import { makeDesktopCommandRequest } from '../shared/desktop-command'
import type { EventBus } from './events/event-bus'

/** The slice of `process` the forwarder uses; tests inject one of their own. */
export interface ClaudeOrganizationIpc {
  send?: (message: unknown, callback: (error: Error | null) => void) => boolean
}

let ipc: ClaudeOrganizationIpc = process as unknown as ClaudeOrganizationIpc
let sequence = 0

export const forwardClaudeOrganizationLearnedToDesktop = (email: string): void => {
  const send = ipc.send
  if (typeof send !== 'function') return
  sequence += 1
  const id = `claude-organization-learned-${Date.now().toString(36)}-${sequence}`
  try {
    send.call(
      ipc,
      makeDesktopCommandRequest(id, 'claudeOrganizationLearned', { email }),
      () => undefined
    )
  } catch {
    // The channel closed under us (main is quitting).
  }
}

/**
 * Connect the server child to organization learning, both ways:
 *  - an organization stored in this process is reported to main (above);
 *  - main's "organizations needed" event (it saw live usage for an organization no account
 *    is mapped to) asks for the accounts that have none to be learned. `requestLearning` is
 *    account maintenance's, and does nothing where maintenance is not running.
 * Returns the disconnect.
 */
export const connectClaudeOrganizationLearningInServer = (
  eventBus: Pick<EventBus, 'subscribe'>,
  requestLearning: () => void = requestClaudeOrganizationLearning
): (() => void) => {
  setClaudeOrganizationLearnedPublisher(forwardClaudeOrganizationLearnedToDesktop)
  const unsubscribe = Effect.runSync(
    eventBus.subscribe(CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL, () => {
      try {
        requestLearning()
      } catch {
        // Never into the event bus: the next tick of account maintenance sweeps anyway.
      }
    })
  )
  return () => {
    unsubscribe()
    setClaudeOrganizationLearnedPublisher(null)
  }
}

/** Picks the channel. Tests only. */
export const __resetClaudeOrganizationForwarderForTests = (
  channel: ClaudeOrganizationIpc = process as unknown as ClaudeOrganizationIpc
): void => {
  ipc = channel
  sequence = 0
}
