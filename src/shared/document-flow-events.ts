// Server → renderer push for the "Implement document" flow. One coarse channel: every write to
// a run, one of its items or its audit log publishes `{ runId }`, and the renderer store
// re-reads that run (debounced). Deliberately not a `db:changed` entity — the domain is
// desktop-only, and the channel is absent from the remote-access allowlist.

export const DOCUMENT_FLOW_UPDATED_CHANNEL = 'documentFlow:updated'

export type DocumentFlowUpdateReason = 'run' | 'item' | 'event' | 'deleted'

export interface DocumentFlowUpdatedEvent {
  runId: string
  projectId: string
  reason: DocumentFlowUpdateReason
  itemId?: string
}

const REASONS: ReadonlySet<string> = new Set<DocumentFlowUpdateReason>([
  'run',
  'item',
  'event',
  'deleted'
])

export function isDocumentFlowUpdatedEvent(value: unknown): value is DocumentFlowUpdatedEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Record<string, unknown>
  return (
    typeof event.runId === 'string' &&
    typeof event.projectId === 'string' &&
    typeof event.reason === 'string' &&
    REASONS.has(event.reason) &&
    (event.itemId === undefined || typeof event.itemId === 'string')
  )
}
