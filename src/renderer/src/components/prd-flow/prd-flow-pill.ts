import type { DocumentFlowTone } from '@/components/document-flow/document-flow-ui'
import type { PrdFlow, PrdFlowStage } from '@/stores/usePrdFlowStore'
import { prdFileName, tasksFileName } from '@shared/document-flow/prd-flow'

// What the board card of a ticket says about its PRD flow ("New PRD → orchestrator ticket…"):
// one pill that names the step the flow is at, with the flow's own words as its hover text.
// No React and no stores: the card (KanbanTicketCard) reads the flow and renders what this
// returns.

export interface PrdFlowPill {
  label: string
  tone: DocumentFlowTone
  /** The hover text: what the flow waits for or what went wrong, else what the step does. */
  hint: string
  /** The flow stopped: the card offers "Retry" beside the pill. */
  canRetry: boolean
}

const STAGE_LABELS: Record<PrdFlowStage, string> = {
  launching: 'PRD flow · starting',
  prd: 'PRD flow · writing the PRD',
  tasks: 'PRD flow · writing the tasks',
  creating_run: 'PRD flow · creating the orchestrator'
}

/** The driver's own words for a session that asks the person something (lib/prd-flow/driver). */
const WAITING_FOR_YOU_PREFIX = 'Waiting for you'

/** What the step does and what comes next, said when the flow has nothing of its own to say. */
function stageHint(flow: PrdFlow): string {
  const prd = prdFileName(flow.prefix)
  const tasks = tasksFileName(flow.prefix)
  switch (flow.stage) {
    case 'launching':
      return `The session that writes ${prd} is being started. It is asked for ${tasks} next.`
    case 'prd':
      return `The session is writing ${prd}. It is asked for ${tasks} once the PRD exists.`
    case 'tasks':
      return `The session is writing ${tasks}, which becomes an orchestrator ticket.`
    case 'creating_run':
      return `${tasks} is being made into an orchestrator ticket, which waits in To Do to be launched.`
  }
}

/**
 * The pill of a ticket's PRD flow, or null for a ticket that has none. A flow that is on says
 * the step it is at, in blue, or "waiting for you", in amber, while its session asks the person
 * something; a flow that stopped says "needs attention", in red, and can be retried.
 */
export function prdFlowPill(flow: PrdFlow | null): PrdFlowPill | null {
  if (!flow) return null
  if (flow.status === 'needs_attention') {
    return {
      label: 'PRD flow · needs attention',
      tone: 'danger',
      hint: flow.detail ?? 'The PRD flow stopped. Retry continues it.',
      canRetry: true
    }
  }
  if (flow.detail?.startsWith(WAITING_FOR_YOU_PREFIX)) {
    return {
      label: 'PRD flow · waiting for you',
      tone: 'warning',
      hint: flow.detail,
      canRetry: false
    }
  }
  return {
    label: STAGE_LABELS[flow.stage],
    tone: 'info',
    hint: flow.detail ?? stageHint(flow),
    canRetry: false
  }
}
