import { useEffect } from 'react'
import { watchPrdFlowDrafts } from '@/lib/prd-flow/draft'

/**
 * Mount-once (AppLayout): keeps the PRD flows saved for later ("Save for later" in the form
 * of "New PRD → orchestrator ticket…") in step with the board. A draft whose ticket was
 * started as an ordinary ticket, moved out of To Do or archived is forgotten, and a draft
 * whose ticket was renamed on the board is renamed with it.
 */
export function usePrdFlowDrafts(): void {
  useEffect(() => watchPrdFlowDrafts(), [])
}
