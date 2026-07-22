import type { KanbanTicketColumn } from '../../../main/db/types'
import type { FollowUpTriggerColumn } from '@/stores/useSettingsStore'

export function isBlockerSatisfied(
  blockerColumn: KanbanTicketColumn,
  blockerMode: 'build' | 'plan' | 'super-plan' | null,
  triggerColumn: FollowUpTriggerColumn
): boolean {
  // A merged blocker's work already landed on the base branch, so it
  // satisfies dependents just like done.
  if (blockerColumn === 'done' || blockerColumn === 'merged') return true
  if (triggerColumn === 'review') {
    if (blockerColumn === 'review' && blockerMode === 'build') return true
  }
  return false
}
