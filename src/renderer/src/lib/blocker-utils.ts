import type { KanbanTicketColumn } from '../../../main/db/types'
import type { FollowUpTriggerColumn } from '@/stores/useSettingsStore'

export function isBlockerSatisfied(
  blockerColumn: KanbanTicketColumn,
  blockerMode: 'build' | 'plan' | 'super-plan' | 'super-build' | null,
  triggerColumn: FollowUpTriggerColumn
): boolean {
  // A merged blocker's work already landed on the base branch, so it
  // satisfies dependents just like done. Not quite for a ticket of a run made
  // from board tickets: it sits in Merged from the moment it reached the run's
  // integration branch, before that branch reaches base. The run's own moves
  // fire nothing until its ticket lands, but a plain move of another blocker
  // still reads such a ticket as satisfied here.
  if (blockerColumn === 'done' || blockerColumn === 'merged') return true
  if (triggerColumn === 'review') {
    if (blockerColumn === 'review' && blockerMode === 'build') return true
  }
  return false
}
