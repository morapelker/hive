import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

type LaunchResult = { success: boolean; error?: string }
const runProjectShellCommand = vi.fn(async (_input: unknown): Promise<LaunchResult> => ({
  success: true
}))
const rerunShellCommand = vi.fn(async (_sessionId: string): Promise<LaunchResult> => ({
  success: true
}))
vi.mock('@/lib/shell-command-launch', () => ({
  runProjectShellCommand: (input: unknown) => runProjectShellCommand(input),
  rerunShellCommand: (sessionId: string) => rerunShellCommand(sessionId)
}))

import {
  isShellCommandTicket,
  resolveTicketShellCommandId,
  startShellCommandTicket
} from './shell-command-ticket'
import { toast } from '@/lib/toast'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { DOCUMENT_RUN_TICKET_PROVIDER } from '@shared/document-flow/run-ticket'
import {
  SHELL_COMMAND_TICKET_PROVIDER,
  createSessionShellCommandSnapshot
} from '@shared/lib/shell-commands'

const PROJECT = 'project-1'
const SESSION = 'session-shell'

type TicketRef = Parameters<typeof startShellCommandTicket>[0]

function makeTicket(overrides: Partial<TicketRef> = {}): TicketRef {
  return {
    id: 'ticket-1',
    project_id: PROJECT,
    current_session_id: null,
    external_provider: null,
    external_id: null,
    ...overrides
  }
}

/** A ticket carrying the shell-command marker. */
function markedTicket(overrides: Partial<TicketRef> = {}): TicketRef {
  return makeTicket({
    external_provider: SHELL_COMMAND_TICKET_PROVIDER,
    external_id: 'cmd-install',
    ...overrides
  })
}

/** Index a shell-command run for a session, as the run store does at startup. */
function seedRun(
  sessionId: string,
  commandId: string,
  state: 'pending' | 'running' | 'succeeded' | 'failed' = 'succeeded'
): void {
  useShellCommandRunStore.getState().setRun(sessionId, {
    ...createSessionShellCommandSnapshot({
      id: commandId,
      name: 'Install app',
      commands: 'pnpm i'
    }),
    state
  })
}

const moveTicket = vi.fn(async (..._args: unknown[]) => undefined)

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  useShellCommandRunStore.setState({ runsBySession: {} })
  useKanbanStore.setState({
    tickets: new Map(),
    moveTicket: moveTicket as unknown as ReturnType<typeof useKanbanStore.getState>['moveTicket'],
    computeSortOrder: () => 1000,
    getTicketsByColumn: () => []
  } as never)
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT,
        shell_commands: [{ id: 'cmd-install', name: 'Install app', commands: 'pnpm i' }]
      }
    ]
  } as never)
})

describe('resolveTicketShellCommandId', () => {
  it('reads the marker of a session-less ticket', () => {
    expect(resolveTicketShellCommandId(markedTicket())).toBe('cmd-install')
  })

  it('prefers the marker over the linked run', () => {
    seedRun(SESSION, 'cmd-from-run')

    expect(resolveTicketShellCommandId(markedTicket({ current_session_id: SESSION }))).toBe(
      'cmd-install'
    )
  })

  it('falls back to the run of current_session_id for an unmarked ticket', () => {
    seedRun(SESSION, 'cmd-from-run')

    expect(resolveTicketShellCommandId(makeTicket({ current_session_id: SESSION }))).toBe(
      'cmd-from-run'
    )
  })

  it('is null for a plain ticket, with or without an agent session', () => {
    seedRun(SESSION, 'cmd-from-run')

    expect(resolveTicketShellCommandId(makeTicket())).toBeNull()
    expect(
      resolveTicketShellCommandId(makeTicket({ current_session_id: 'session-agent' }))
    ).toBeNull()
  })

  it('is null for a jira ticket and for a document run ticket', () => {
    expect(
      resolveTicketShellCommandId(makeTicket({ external_provider: 'jira', external_id: 'PROJ-12' }))
    ).toBeNull()
    expect(
      resolveTicketShellCommandId(
        makeTicket({ external_provider: DOCUMENT_RUN_TICKET_PROVIDER, external_id: 'run-1' })
      )
    ).toBeNull()
  })

  it('is null for a marker with an empty external_id and no session', () => {
    expect(resolveTicketShellCommandId(markedTicket({ external_id: '' }))).toBeNull()
    expect(resolveTicketShellCommandId(markedTicket({ external_id: null }))).toBeNull()
  })

  it('a marker with an empty external_id still resolves through its session run', () => {
    seedRun(SESSION, 'cmd-from-run')

    expect(
      resolveTicketShellCommandId(markedTicket({ external_id: '', current_session_id: SESSION }))
    ).toBe('cmd-from-run')
  })

  it('follows the run store: a run removed from it no longer resolves', () => {
    seedRun(SESSION, 'cmd-from-run')
    const ticket = makeTicket({ current_session_id: SESSION })
    expect(resolveTicketShellCommandId(ticket)).toBe('cmd-from-run')

    useShellCommandRunStore.getState().removeRun(SESSION)

    expect(resolveTicketShellCommandId(ticket)).toBeNull()
  })
})

describe('isShellCommandTicket', () => {
  it('is true for a marked ticket, with or without a session', () => {
    expect(isShellCommandTicket(markedTicket())).toBe(true)
    expect(isShellCommandTicket(markedTicket({ current_session_id: 'session-any' }))).toBe(true)
  })

  it('is true for an unmarked ticket linked to a shell-command session', () => {
    seedRun(SESSION, 'cmd-from-run')

    expect(isShellCommandTicket(makeTicket({ current_session_id: SESSION }))).toBe(true)
  })

  it('is false for plain, jira, document run and empty-marker tickets', () => {
    seedRun(SESSION, 'cmd-from-run')

    expect(isShellCommandTicket(makeTicket())).toBe(false)
    expect(isShellCommandTicket(makeTicket({ current_session_id: 'session-agent' }))).toBe(false)
    expect(
      isShellCommandTicket(makeTicket({ external_provider: 'jira', external_id: 'PROJ-12' }))
    ).toBe(false)
    expect(
      isShellCommandTicket(
        makeTicket({ external_provider: DOCUMENT_RUN_TICKET_PROVIDER, external_id: 'run-1' })
      )
    ).toBe(false)
    expect(isShellCommandTicket(markedTicket({ external_id: '' }))).toBe(false)
  })
})

describe('startShellCommandTicket — without a session', () => {
  it('runs the command for the ticket, without leaving the board', async () => {
    await expect(startShellCommandTicket(markedTicket(), { sortOrder: 3.5 })).resolves.toBe(true)

    expect(runProjectShellCommand).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT,
      commandId: 'cmd-install',
      ticketId: 'ticket-1',
      sortOrder: 3.5,
      focus: false
    })
    expect(rerunShellCommand).not.toHaveBeenCalled()
  })

  it('names no worktree (the launcher then uses the base one) and no sort order by default', async () => {
    await startShellCommandTicket(markedTicket())

    const input = runProjectShellCommand.mock.calls[0][0] as Record<string, unknown>
    expect(input.worktreeId).toBeUndefined()
    expect(input.sortOrder).toBeUndefined()
    expect(input.focus).toBe(false)
  })

  it('toasts the command name on success', async () => {
    await startShellCommandTicket(markedTicket())

    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Started "Install app"')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('toasts the launch error and resolves to false', async () => {
    runProjectShellCommand.mockResolvedValueOnce({ success: false, error: 'Command not found' })

    await expect(startShellCommandTicket(markedTicket())).resolves.toBe(false)

    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Command not found')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('toasts a generic message when the failure carries no error text', async () => {
    runProjectShellCommand.mockResolvedValueOnce({ success: false })

    await expect(startShellCommandTicket(markedTicket())).resolves.toBe(false)

    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Failed to run command')
  })

  it('refuses an unmarked ticket without launching anything', async () => {
    await expect(startShellCommandTicket(makeTicket())).resolves.toBe(false)
    await expect(
      startShellCommandTicket(makeTicket({ external_provider: 'jira', external_id: 'PROJ-12' }))
    ).resolves.toBe(false)

    expect(runProjectShellCommand).not.toHaveBeenCalled()
    expect(rerunShellCommand).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledWith('Not a shell command ticket')
  })
})

describe('startShellCommandTicket — with a session', () => {
  it('runs the command again in the same session, never as a new run', async () => {
    seedRun(SESSION, 'cmd-install')
    const ticket = markedTicket({ current_session_id: SESSION })

    await expect(startShellCommandTicket(ticket, { sortOrder: 9 })).resolves.toBe(true)

    expect(rerunShellCommand).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(runProjectShellCommand).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Started "Install app"')
    // session_working put the ticket back at its old place; the drop decides the slot
    expect(moveTicket).toHaveBeenCalledExactlyOnceWith('ticket-1', PROJECT, 'in_progress', 9)
  })

  it('leaves the slot alone when no drop position was given', async () => {
    seedRun(SESSION, 'cmd-install')

    await startShellCommandTicket(markedTicket({ current_session_id: SESSION }))

    expect(rerunShellCommand).toHaveBeenCalledOnce()
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('only moves a ticket whose run is still going, instead of running it again', async () => {
    seedRun(SESSION, 'cmd-install', 'running')

    await expect(
      startShellCommandTicket(markedTicket({ current_session_id: SESSION }), { sortOrder: 2 })
    ).resolves.toBe(true)

    expect(moveTicket).toHaveBeenCalledExactlyOnceWith('ticket-1', PROJECT, 'in_progress', 2)
    expect(rerunShellCommand).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('refuses a session whose run is unknown', async () => {
    await expect(
      startShellCommandTicket(markedTicket({ current_session_id: SESSION }))
    ).resolves.toBe(false)

    expect(rerunShellCommand).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Session is not a shell command')
  })

  it("refuses a session that runs a different command than the ticket's", async () => {
    seedRun(SESSION, 'cmd-other')

    await expect(
      startShellCommandTicket(markedTicket({ current_session_id: SESSION }))
    ).resolves.toBe(false)

    expect(rerunShellCommand).not.toHaveBeenCalled()
    expect(moveTicket).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "The ticket's session runs a different command"
    )
  })

  it('does the same for an unmarked ticket of a shell-command session', async () => {
    seedRun(SESSION, 'cmd-from-run')

    await expect(
      startShellCommandTicket(makeTicket({ current_session_id: SESSION }))
    ).resolves.toBe(true)

    expect(rerunShellCommand).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(runProjectShellCommand).not.toHaveBeenCalled()
  })

  it('toasts the rerun error and resolves to false', async () => {
    seedRun(SESSION, 'cmd-install')
    rerunShellCommand.mockResolvedValueOnce({ success: false, error: 'Session is closed' })

    await expect(
      startShellCommandTicket(markedTicket({ current_session_id: SESSION }), { sortOrder: 4 })
    ).resolves.toBe(false)

    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Session is closed')
    expect(moveTicket).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(runProjectShellCommand).not.toHaveBeenCalled()
  })
})

describe('startShellCommandTicket — in-flight guard', () => {
  it('a second start while the first is in flight does not launch twice', async () => {
    const launch = deferred<LaunchResult>()
    runProjectShellCommand.mockReturnValueOnce(launch.promise)

    const first = startShellCommandTicket(markedTicket())
    await expect(startShellCommandTicket(markedTicket())).resolves.toBe(false)

    expect(runProjectShellCommand).toHaveBeenCalledTimes(1)
    // The refused gesture is silent: the first one owns the toast.
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()

    launch.resolve({ success: true })
    await expect(first).resolves.toBe(true)
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Started "Install app"')
  })

  it('guards "Run again" the same way', async () => {
    seedRun(SESSION, 'cmd-install')
    const rerun = deferred<LaunchResult>()
    rerunShellCommand.mockReturnValueOnce(rerun.promise)
    const ticket = markedTicket({ current_session_id: SESSION })

    const first = startShellCommandTicket(ticket)
    await expect(startShellCommandTicket(ticket)).resolves.toBe(false)

    expect(rerunShellCommand).toHaveBeenCalledTimes(1)

    rerun.resolve({ success: true })
    await expect(first).resolves.toBe(true)
  })

  it('releases the guard once the start has settled, success or failure', async () => {
    const ticket = markedTicket()
    runProjectShellCommand.mockResolvedValueOnce({ success: false, error: 'Command not found' })

    await expect(startShellCommandTicket(ticket)).resolves.toBe(false)
    await expect(startShellCommandTicket(ticket)).resolves.toBe(true)
    await expect(startShellCommandTicket(ticket)).resolves.toBe(true)

    expect(runProjectShellCommand).toHaveBeenCalledTimes(3)
  })

  it('releases the guard when the launcher throws, and toasts', async () => {
    const ticket = markedTicket()
    runProjectShellCommand.mockRejectedValueOnce(new Error('store exploded'))

    await expect(startShellCommandTicket(ticket)).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Failed to run command')
    await expect(startShellCommandTicket(ticket)).resolves.toBe(true)

    expect(runProjectShellCommand).toHaveBeenCalledTimes(2)
  })

  it('is per ticket and per project: other tickets start alongside', async () => {
    const launch = deferred<LaunchResult>()
    runProjectShellCommand.mockReturnValueOnce(launch.promise)

    const first = startShellCommandTicket(markedTicket())
    await expect(startShellCommandTicket(markedTicket({ id: 'ticket-2' }))).resolves.toBe(true)
    await expect(startShellCommandTicket(markedTicket({ project_id: 'project-2' }))).resolves.toBe(
      true
    )

    expect(runProjectShellCommand).toHaveBeenCalledTimes(3)
    expect(runProjectShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, ticketId: 'ticket-2' })
    )
    expect(runProjectShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-2', ticketId: 'ticket-1' })
    )

    launch.resolve({ success: true })
    await first
  })
})
