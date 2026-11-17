/**
 * The main process's end of organization learning.
 *
 * The live usage updater (claude-usage-live.ts) runs here; the accounts'
 * credentials are used in the server child, so that is where an account's
 * organization is learned (services/claude-organization-learner.ts). This
 * connects the two:
 *
 *  - a reading for an organization no account is mapped to makes the updater
 *    ask for organizations: the request goes to the child as a backend event,
 *    and the child's learner asks for the accounts that have none;
 *  - the child says when it stored one (from a usage poll or from the
 *    learner), and the readings the updater holds are looked at again at once.
 *
 * Both are best-effort. A request that does not reach the child costs the
 * held reading, which is dropped after its 60 seconds; a lost "stored" costs a
 * second, the updater's own re-check.
 */
import { publishDesktopBackendEvent } from '../../desktop/backend-event-publisher'
import {
  CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL,
  subscribeClaudeOrganizationLearned
} from '../usage/claude-organization-signal'
import {
  notifyClaudeOrganizationsLearned,
  setClaudeOrganizationsNeededHandler
} from './claude-usage-live'

/** Connect the live updater to the organization learner. Returns the disconnect. */
export function connectClaudeOrganizationLearning(): () => void {
  // Returns at once, as the updater requires: the event is sent, not awaited.
  const requestOrganizations = (): void => {
    void publishDesktopBackendEvent(CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL, {}).catch(() => false)
  }
  setClaudeOrganizationsNeededHandler(requestOrganizations)
  const unsubscribe = subscribeClaudeOrganizationLearned(() => notifyClaudeOrganizationsLearned())
  return () => {
    unsubscribe()
    setClaudeOrganizationsNeededHandler(null)
  }
}
