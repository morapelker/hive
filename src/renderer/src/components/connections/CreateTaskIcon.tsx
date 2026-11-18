import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react'
import type { CreateTask } from './connection-create-tasks'

/** The state of one line of the connection-creation checklist (connection-create-tasks). */
export function CreateTaskIcon({ status }: { status: CreateTask['status'] }): React.JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
    case 'done':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
    case 'failed':
      return <XCircle className="h-4 w-4 shrink-0 text-destructive" />
    default:
      return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/50" />
  }
}
