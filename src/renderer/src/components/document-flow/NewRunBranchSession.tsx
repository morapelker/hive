import { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { TicketCreateModal } from '@/components/kanban/TicketCreateModal'
import { Button } from '@/components/ui/button'
import { buildTicketPrompt } from '@/lib/connection-project-launch'
import {
  launchTicketOnCheckout,
  runBranchTarget,
  type RunBranchTarget,
  type RunCheckout
} from '@/lib/document-flow/run-checkout'
import { resolveDefaultLaunchConfig } from '@/lib/document-flow/runner-ports'
import { toast } from '@/lib/toast'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { isActiveRunStatus } from '@shared/document-flow/run-ticket'
import { isConnectionRun, type DocumentRun } from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'

type SendableTarget = RunBranchTarget & { checkout: RunCheckout }

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * The run dashboard's way to start one more session on the run's branch: the new ticket modal,
 * whose ticket is an ordinary one of the run's project and launches on that branch with the
 * app's default agent, as "Create & Send" does.
 */
export function NewRunBranchSession({ run }: { run: DocumentRun }): React.JSX.Element {
  const [target, setTarget] = useState<SendableTarget | null>(null)
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // The run commits, merges and on a failed check hard-resets this checkout until it ends, so
  // a session in it could lose its work (and its ticket could merge a half-landed branch).
  const runActive = isActiveRunStatus(run.status)

  // Looked up on click: the checkout goes when the run's ticket is merged and archived.
  const start = async (): Promise<void> => {
    if (isConnectionRun(run)) await useConnectionStore.getState().loadConnections()
    else await useWorktreeStore.getState().loadWorktrees(run.project_id)
    const worktrees = useWorktreeStore.getState()
    const connections = useConnectionStore.getState()
    const next = runBranchTarget(
      run,
      worktrees.loadedProjectIds.has(run.project_id)
        ? worktrees.worktreesByProject.get(run.project_id)
        : undefined,
      connections.loaded ? connections.connections : undefined
    )
    if (!next.checkout) {
      toast.info(next.refusal ?? 'This run has no checkout to run in.')
      return
    }
    setTarget({ ...next, checkout: next.checkout })
    setOpen(true)
  }

  const send = async (ticket: KanbanTicket, sendable: SendableTarget): Promise<void> => {
    try {
      await launchTicketOnCheckout(ticket, sendable.checkout, {
        prompt: buildTicketPrompt('build', ticket),
        modelConfig: resolveDefaultLaunchConfig()
      })
      toast.success(`Session started on ${sendable.branch}`)
    } catch (cause) {
      toast.error(
        `Could not start the session on ${sendable.branch}: ${errorMessage(cause)} The ticket is in To Do.`
      )
    }
  }

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        size="sm"
        className="h-6 text-xs"
        data-testid="docflow-new-branch-session"
        title="Create a ticket and start a session on this branch"
        disabled={runActive}
        onClick={() => void start()}
      >
        <Plus className="h-3 w-3" />
        New session
      </Button>
      {/* Said in words: a disabled button shows no tooltip */}
      {runActive && (
        <span className="text-[11px]" data-testid="docflow-new-branch-session-blocked">
          Available when the run ends
        </span>
      )}
      {target && (
        <TicketCreateModal
          open={open}
          onOpenChange={setOpen}
          projectId={run.project_id}
          sendTo={{ branch: target.branch, send: (ticket) => send(ticket, target) }}
          // Opened by no trigger, so Radix has nothing to give the focus back to: on the body
          // it would be out of the dashboard, and Tab would flip the session behind it.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            buttonRef.current?.focus()
          }}
        />
      )}
    </>
  )
}
