/**
 * Headless launcher for project shell commands (shared/lib/shell-commands): one entry
 * point behind the project / worktree menus and the command palette, plus "Run again"
 * for an existing shell-command session.
 *
 * A launch creates a NEW session (agent_sdk 'terminal', session_type 'shell-command'),
 * an In Progress ticket when the settings say so, auto-pins only alongside a ticket,
 * asks the main process to start the run (main reads the script from the session's own
 * snapshot: no command text is ever sent from here) and jumps to the new terminal tab.
 *
 * Never throws and never toasts: callers own the toasts (launchTicketWithModel style).
 */
import {
  parseProjectShellCommands,
  parseSessionShellCommand,
  type ProjectShellCommand,
  type SessionShellCommand
} from '@shared/lib/shell-commands'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { terminalApi } from '@/api/terminal-api'
import { dbApi } from '@/api/db-api'
import { kanbanApi } from '@/api/kanban-api'
import { isForceBoardMode } from '@/api/hive-enterprise/client'
import { autoPinForBoardPrompt } from '@/lib/auto-pin'
import { isWindows } from '@/lib/platform'
import { lastSendMode, messageSendTimes, userExplicitSendTimes } from '@/lib/message-send-times'
import { markShellCommandStartFailed } from '@/lib/shell-command-status'
import type { KanbanTicket } from '../../../main/db/types'

export interface RunProjectShellCommandInput {
  projectId: string
  /** Resolved from the project store at launch time, never a command object from a stale menu. */
  commandId: string
  /** Omitted => project-level launch => the project's base (is_default) worktree. */
  worktreeId?: string | null
  /** Jump to the new terminal tab (default true). */
  focus?: boolean
}

export interface RunProjectShellCommandResult {
  success: boolean
  error?: string
  sessionId?: string
  /** null when no ticket was created (settings) or its creation failed. */
  ticketId?: string | null
  worktreeId?: string
}

const WINDOWS_ERROR = 'Shell commands are not supported on Windows'

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** Settings decide whether a launch gets a ticket (Force Board Mode always does). */
function wantsTicket(): boolean {
  const settings = useSettingsStore.getState()
  return settings.automaticallyCreateTicket || isForceBoardMode(settings)
}

/**
 * Resolve the worktree a launch runs in. Project-level: the base worktree. Worktree-
 * level: that worktree, which must belong to the project; a missing one is an error,
 * never a silent fallback to the base. One reload when the store is not populated yet.
 */
async function resolveWorktreeId(
  projectId: string,
  worktreeId: string | null | undefined
): Promise<{ worktreeId: string } | { error: string }> {
  const find = (): string | null => {
    const state = useWorktreeStore.getState()
    if (worktreeId) {
      const match = state.worktreesByProject.get(projectId)?.find((w) => w.id === worktreeId)
      return match ? match.id : null
    }
    return state.getDefaultWorktree(projectId)?.id ?? null
  }
  let resolved = find()
  if (!resolved) {
    await useWorktreeStore.getState().loadWorktrees(projectId)
    resolved = find()
  }
  if (resolved) return { worktreeId: resolved }
  return {
    error: worktreeId ? 'Worktree not found' : 'No base worktree found for this project'
  }
}

/** Ensure the project's tickets are loaded: createTicket appends to the loaded list. */
async function ensureTicketsLoaded(projectId: string): Promise<void> {
  if (!useKanbanStore.getState().tickets.has(projectId)) {
    await useKanbanStore.getState().loadTickets(projectId)
  }
}

/**
 * Create the In Progress ticket for a run (mirrors the first-prompt auto-create hook)
 * and auto-pin alongside it. Resolves to null when the ticket could not be created.
 */
async function createRunTicket(input: {
  projectId: string
  worktreeId: string
  sessionId: string
  title: string
  description: string
}): Promise<string | null> {
  const { projectId, worktreeId, sessionId } = input
  try {
    await ensureTicketsLoaded(projectId)
    const kanban = useKanbanStore.getState()
    const ticket = await kanban.createTicket(projectId, {
      project_id: projectId,
      title: input.title,
      description: input.description,
      column: 'in_progress',
      sort_order: kanban.computeSortOrder(kanban.getTicketsByColumn(projectId, 'in_progress'), 0),
      current_session_id: sessionId,
      worktree_id: worktreeId,
      mode: 'build',
      created_from_session: true
    })
    // Both existing precedents pin only alongside a ticket. Under Force Board Mode
    // this pins the base worktree even for a worktree-level launch.
    void autoPinForBoardPrompt({ projectId, worktreeId })
    return ticket.id
  } catch {
    return null
  }
}

/** The 'session starts work' stamps, in the order of ticket-launch.ts. */
function seedWorkingStatus(sessionId: string): void {
  const now = Date.now()
  messageSendTimes.set(sessionId, now)
  userExplicitSendTimes.set(sessionId, now)
  lastSendMode.set(sessionId, 'build')
  useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
}

/**
 * Ask main to start the run. Resolves to null on success, else the error text (after
 * recording the start failure on the session / ticket).
 */
async function startRun(
  sessionId: string
): Promise<{ error: string; alreadyRunning: boolean } | null> {
  try {
    const envelope = await terminalApi.runShellCommand(sessionId)
    if (!envelope.success) {
      const error = envelope.error || 'Failed to start command'
      markShellCommandStartFailed(sessionId, error)
      return { error, alreadyRunning: false }
    }
    const run = envelope.value
    if (run.success) return null
    if (run.alreadyRunning) {
      return { error: run.error || 'Command is already running', alreadyRunning: true }
    }
    const error = run.error || 'Failed to start command'
    markShellCommandStartFailed(sessionId, error)
    return { error, alreadyRunning: false }
  } catch (err) {
    const error = errorMessage(err, 'Failed to start command')
    markShellCommandStartFailed(sessionId, error)
    return { error, alreadyRunning: false }
  }
}

/**
 * Show the new terminal tab. All synchronous and in this order: the board view flag
 * hides terminals; selectWorktree closes the pinned board idempotently (never call
 * togglePinnedBoard); setActiveWorktree MUST precede setActiveSession, which keys on
 * the active worktree (and the SessionTabs sync effect would otherwise reset the
 * active session to the board tab in sticky-tab mode).
 */
function navigateToSession(projectId: string, worktreeId: string, sessionId: string): void {
  const kanban = useKanbanStore.getState()
  if (kanban.isBoardViewActive) kanban.toggleBoardView()
  useWorktreeStore.getState().selectWorktree(worktreeId)
  const projects = useProjectStore.getState()
  projects.selectProject(projectId)
  if (!projects.expandedProjectIds.has(projectId)) projects.toggleProjectExpanded(projectId)
  const sessions = useSessionStore.getState()
  sessions.setActiveWorktree(worktreeId)
  sessions.setActiveSession(sessionId)
}

export async function runProjectShellCommand(
  input: RunProjectShellCommandInput
): Promise<RunProjectShellCommandResult> {
  try {
    const { projectId, commandId, focus = true } = input
    if (isWindows()) return { success: false, error: WINDOWS_ERROR }

    const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
    if (!project || project.kind === 'connection') {
      return { success: false, error: 'Shell commands are only available for git projects' }
    }
    // Resolve by id from the store at launch time: a Radix menu or the palette's
    // memoized list can hold a stale definition.
    const command: ProjectShellCommand | undefined = parseProjectShellCommands(
      project.shell_commands
    ).find((c) => c.id === commandId)
    if (!command) return { success: false, error: 'Command not found' }

    const target = await resolveWorktreeId(projectId, input.worktreeId)
    if ('error' in target) return { success: false, error: target.error }
    const { worktreeId } = target

    const wantTicket = wantsTicket()
    if (wantTicket) await ensureTicketsLoaded(projectId)

    const created = await useSessionStore
      .getState()
      .createShellCommandSession({ worktreeId, projectId, command })
    if (!created.success || !created.session) {
      return { success: false, error: created.error || 'Could not create session' }
    }
    const sessionId = created.session.id

    const ticketId = wantTicket
      ? await createRunTicket({
          projectId,
          worktreeId,
          sessionId,
          title: command.name.trim(),
          description: command.commands
        })
      : null

    seedWorkingStatus(sessionId)

    const failure = await startRun(sessionId)
    if (focus) navigateToSession(projectId, worktreeId, sessionId)
    if (failure) {
      return { success: false, error: failure.error, sessionId, ticketId, worktreeId }
    }
    return { success: true, sessionId, ticketId, worktreeId }
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Failed to run command') }
  }
}

/** The run snapshot of a session: the run store first, the database as a fallback. */
async function resolveRun(sessionId: string): Promise<SessionShellCommand | null> {
  const known = useShellCommandRunStore.getState().runsBySession[sessionId]
  if (known) return known
  try {
    const session = await dbApi.session.get<{ shell_command?: string | null }>(sessionId)
    const run = parseSessionShellCommand(session?.shell_command)
    if (run) useShellCommandRunStore.getState().setRun(sessionId, run)
    return run
  } catch {
    return null
  }
}

/**
 * Run again with no ticket linked (it was deleted or archived, or the setting was off
 * at launch): create one like a launch does. A failed lookup creates nothing, so a
 * flaky RPC can never produce a second ticket for the session.
 */
async function ensureRunTicket(sessionId: string, run: SessionShellCommand): Promise<void> {
  try {
    const existing = await kanbanApi.ticket.getBySession<KanbanTicket>(sessionId)
    if (existing.some((t) => !t.archived_at)) return
    // Read after reactivateSession: that is what puts a closed session back in the store.
    const session =
      useSessionStore.getState().getSessionById(sessionId) ??
      (await dbApi.session.get<{ project_id: string; worktree_id: string | null }>(sessionId))
    if (!session?.project_id || !session.worktree_id) return
    await createRunTicket({
      projectId: session.project_id,
      worktreeId: session.worktree_id,
      sessionId,
      title: run.name.trim(),
      description: run.script
    })
  } catch {
    // Best-effort: the run itself does not depend on the ticket.
  }
}

/**
 * "Run again" (D3): restart the command in the SAME session, with the same ticket.
 * The terminal is cleared by main (empty replay at run start); no navigation, the
 * user is already looking at the transcript.
 */
export async function rerunShellCommand(
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (isWindows()) return { success: false, error: WINDOWS_ERROR }
    const run = await resolveRun(sessionId)
    if (!run) return { success: false, error: 'Session is not a shell command' }
    if (run.state === 'running') return { success: false, error: 'Command is already running' }

    // Restores a closed tab; no-op for an active session.
    await useSessionStore.getState().reactivateSession(sessionId)

    // Mandatory: the error mark otherwise clears only on Claude hook evidence.
    useWorktreeStatusStore.getState().clearSessionApiError(sessionId)
    // The existing 'session resumes work' path: session_working moves the ticket from
    // Review back to In Progress, and the explicit-send stamp reopens a Done/Merged one.
    seedWorkingStatus(sessionId)

    if (wantsTicket()) await ensureRunTicket(sessionId, run)

    const failure = await startRun(sessionId)
    if (failure) return { success: false, error: failure.error }
    return { success: true }
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Failed to run command again') }
  }
}
