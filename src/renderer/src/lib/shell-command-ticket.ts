/**
 * Shell-command tickets on the board: which tickets they are, and starting one's command
 * from the ticket itself (dropped into In Progress, right-dragged there, Save & Send).
 *
 * A ticket is a shell-command ticket through its marker (shellCommandIdOfTicket), which
 * it keeps without a session, or through a linked shell-command session (tickets
 * created before the marker existed).
 */
import { toast } from '@/lib/toast'
import {
  isShellCommandRunActive,
  parseProjectShellCommands,
  shellCommandIdOfTicket
} from '@shared/lib/shell-commands'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { rerunShellCommand, runProjectShellCommand } from '@/lib/shell-command-launch'
import type { KanbanTicket } from '../../../main/db/types'

type ShellCommandTicketRef = Pick<
  KanbanTicket,
  'id' | 'project_id' | 'current_session_id' | 'external_provider' | 'external_id'
>

/** The project command a ticket stands for: its marker first, else its session's run. */
export function resolveTicketShellCommandId(ticket: ShellCommandTicketRef): string | null {
  const marked = shellCommandIdOfTicket(ticket)
  if (marked) return marked
  if (!ticket.current_session_id) return null
  return (
    useShellCommandRunStore.getState().runsBySession[ticket.current_session_id]?.commandId ?? null
  )
}

export function isShellCommandTicket(ticket: ShellCommandTicketRef): boolean {
  return resolveTicketShellCommandId(ticket) !== null
}

// Tickets whose command is being started: a second gesture must not start a second run
const starting = new Set<string>()

/**
 * Start a shell-command ticket's command and toast the outcome. Without a session it is
 * a new run in the project's base worktree, with the project's current definition of
 * the command; with one (a finished run dragged back) it is "Run again": same session,
 * same worktree. The board stays in view either way. Resolves to whether it started.
 */
export async function startShellCommandTicket(
  ticket: ShellCommandTicketRef,
  opts?: { sortOrder?: number }
): Promise<boolean> {
  const key = `${ticket.project_id}:${ticket.id}`
  if (starting.has(key)) return false
  starting.add(key)
  try {
    const kanban = useKanbanStore.getState()
    const moveToInProgress = (): Promise<void> =>
      kanban.moveTicket(
        ticket.id,
        ticket.project_id,
        'in_progress',
        opts?.sortOrder ??
          kanban.computeSortOrder(kanban.getTicketsByColumn(ticket.project_id, 'in_progress'), 0)
      )

    let result: { success: boolean; error?: string }
    // The command's name, for the toast: the title is only text
    let name: string | null = null
    const sessionId = ticket.current_session_id
    if (sessionId) {
      const run = useShellCommandRunStore.getState().runsBySession[sessionId]
      const marked = shellCommandIdOfTicket(ticket)
      if (!run) {
        result = { success: false, error: 'Session is not a shell command' }
      } else if (marked && run.commandId !== marked) {
        // The link was changed behind the ticket's back: never run what it does not stand for
        result = { success: false, error: "The ticket's session runs a different command" }
      } else if (isShellCommandRunActive(run.state)) {
        // Still running (parked in another column by hand): just bring the ticket back
        await moveToInProgress()
        return true
      } else {
        name = run.name
        result = await rerunShellCommand(sessionId)
        // session_working put the ticket back at its old place; the drop decides the slot
        if (result.success && opts?.sortOrder !== undefined) await moveToInProgress()
      }
    } else {
      const commandId = shellCommandIdOfTicket(ticket)
      if (commandId) {
        const project = useProjectStore.getState().projects.find((p) => p.id === ticket.project_id)
        name =
          parseProjectShellCommands(project?.shell_commands).find((c) => c.id === commandId)
            ?.name ?? null
        result = await runProjectShellCommand({
          projectId: ticket.project_id,
          commandId,
          ticketId: ticket.id,
          sortOrder: opts?.sortOrder,
          focus: false
        })
      } else {
        result = { success: false, error: 'Not a shell command ticket' }
      }
    }
    if (result.success) toast.success(name ? `Started "${name.trim()}"` : 'Command started')
    else toast.error(result.error || 'Failed to run command')
    return result.success
  } catch {
    toast.error('Failed to run command')
    return false
  } finally {
    starting.delete(key)
  }
}
