import { FileText, Workflow, type LucideProps } from 'lucide-react'
import { isTicketRun, type DocumentRun } from '@shared/types/document-flow'

/**
 * The mark of a run made from board tickets (an "Orchestrator"): tickets wired into one flow.
 * Wherever a document run shows its FileText, such a run shows this instead.
 */
export function TicketRunIcon(props: LucideProps): React.JSX.Element {
  return <Workflow {...props} />
}

/** The run's kind as an icon: the document's FileText, or the orchestrator's mark. */
export function RunKindIcon({
  run,
  ...props
}: LucideProps & {
  run: Pick<DocumentRun, 'source_kind'> | null | undefined
}): React.JSX.Element {
  return isTicketRun(run) ? <TicketRunIcon {...props} /> : <FileText {...props} />
}
