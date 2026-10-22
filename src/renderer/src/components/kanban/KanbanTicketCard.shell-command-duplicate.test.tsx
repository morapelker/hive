/**
 * A shell command's ticket is marked through the external-source fields, so it stays a
 * shell-command ticket without a session. Duplicating one yields another, the marked card
 * looks like a shell command (not like an imported ticket), and right-dragging it into
 * In Progress runs the command instead of launching an agent.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { SessionShellCommand } from '@shared/lib/shell-commands'
import type { KanbanTicket } from '../../../../main/db/types'

const mocks = vi.hoisted(() => ({
  startShellCommandTicket: vi.fn(),
  quickLaunchTicket: vi.fn(),
  quickLaunchTicketOnConnection: vi.fn()
}))

// resolveTicketShellCommandId stays real: it decides what a duplicate is stamped with
vi.mock('@/lib/shell-command-ticket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shell-command-ticket')>()
  return { ...actual, startShellCommandTicket: mocks.startShellCommandTicket }
})

vi.mock('@/components/kanban/WorktreePickerModal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./WorktreePickerModal')>()
  return {
    ...actual,
    quickLaunchTicket: mocks.quickLaunchTicket,
    quickLaunchTicketOnConnection: mocks.quickLaunchTicketOnConnection
  }
})

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

import { KanbanTicketCard } from './KanbanTicketCard'
import { toast } from '@/lib/toast'
import { ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'

const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialRunState = useShellCommandRunStore.getState()

const now = '2026-01-01T00:00:00.000Z'

const finishedRun: SessionShellCommand = {
  commandId: 'cmd-build',
  name: 'Build',
  script: 'make',
  detached: false,
  state: 'succeeded',
  runId: 'run-1',
  exitCode: 0,
  signal: null,
  reason: null,
  error: null,
  startedAt: now,
  finishedAt: now
}

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Build',
    description: 'Runs make',
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: now,
    updated_at: now,
    column_changed_at: null,
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    created_from_session: false,
    auto_approve_plan: false,
    unread: false,
    awaiting_completion: false,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ticket_prefix: null,
    ticket_number: null,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

/** A session-less ticket carrying the shell-command marker. */
const makeMarkedTicket = (overrides: Partial<KanbanTicket> = {}): KanbanTicket =>
  makeTicket({ external_provider: 'shell-command', external_id: 'cmd-build', ...overrides })

/** A ticket from before the marker existed: only its session says it is a shell command. */
function makeLegacyRunTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  useShellCommandRunStore.setState({ runsBySession: { 'session-1': finishedRun } })
  return makeTicket({
    column: 'review',
    current_session_id: 'session-1',
    worktree_id: 'worktree-1',
    mode: 'build',
    ...overrides
  })
}

const card = (): HTMLElement => screen.getByTestId('kanban-ticket-ticket-1')

const openMenu = (): void => {
  fireEvent.contextMenu(card())
}

const menuItemTexts = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
    (item) => item.textContent ?? ''
  )

/** Duplicate the rendered ticket from its menu; resolves to the createTicket call. */
async function duplicate(): Promise<[string, Record<string, unknown>]> {
  const createTicket = vi.fn().mockResolvedValue(makeTicket({ id: 'ticket-copy' }))
  useKanbanStore.setState({ createTicket } as never)

  openMenu()
  fireEvent.click(await screen.findByTestId('ctx-duplicate-ticket'))

  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ticket duplicated'))
  expect(createTicket).toHaveBeenCalledTimes(1)
  return createTicket.mock.calls[0] as [string, Record<string, unknown>]
}

function renderWithInProgressColumn(ticket: KanbanTicket): HTMLElement {
  render(
    <>
      <KanbanTicketCard ticket={ticket} />
      <div data-kanban-column="in_progress" />
      <div data-kanban-column="review" />
    </>
  )
  return document.querySelector('[data-kanban-column="in_progress"]') as HTMLElement
}

function rightDragInto(column: HTMLElement): void {
  const source = card()
  // jsdom has no layout — resolve hit-testing by x coordinate
  const original = document.elementFromPoint
  document.elementFromPoint = (x: number) => (x >= 300 ? column : source)
  try {
    fireEvent.mouseDown(source, { button: 2, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 350, clientY: 50 })
    fireEvent.mouseUp(window, { button: 2, clientX: 350, clientY: 50 })
  } finally {
    document.elementFromPoint = original
  }
}

/** Make ticket-1 depend on a ticket that is still in To Do. */
function blockTicket(): void {
  useKanbanStore.setState({
    tickets: new Map([['project-1', [makeTicket({ id: 'blocker-1', title: 'Blocker' })]]]),
    dependencyMap: new Map([
      [ticketKey('project-1', 'ticket-1'), new Set([ticketKey('project-1', 'blocker-1')])]
    ])
  })
}

// See ProjectItem.shell-commands.test.tsx: jsdom cannot answer floating-ui's top-layer probes
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

beforeAll(() => {
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})

afterAll(() => {
  Element.prototype.matches = originalMatches
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useKanbanStore.setState(initialKanbanState, true)
  useProjectStore.setState(initialProjectState, true)
  useShellCommandRunStore.setState(initialRunState, true)
})

describe('duplicating a ticket', () => {
  it('marks the copy of a legacy shell-command ticket with its run’s command', async () => {
    render(<KanbanTicketCard ticket={makeLegacyRunTicket()} />)

    const [projectId, payload] = await duplicate()

    expect(projectId).toBe('project-1')
    // Strict: the copy starts over, without the original's session or worktree
    expect(payload).toStrictEqual({
      project_id: 'project-1',
      title: 'Build',
      description: 'Runs make',
      column: 'todo',
      labels: [],
      external_provider: 'shell-command',
      external_id: 'cmd-build'
    })
  })

  it('copies the marker of a session-less shell-command ticket', async () => {
    render(<KanbanTicketCard ticket={makeMarkedTicket({ external_id: 'cmd-deploy' })} />)

    const [, payload] = await duplicate()

    expect(payload).toStrictEqual({
      project_id: 'project-1',
      title: 'Build',
      description: 'Runs make',
      column: 'todo',
      labels: [],
      external_provider: 'shell-command',
      external_id: 'cmd-deploy'
    })
  })

  it('keeps the marker over the command of the session a marked ticket is linked to', async () => {
    // The linked run is of another command than the one the ticket stands for
    useShellCommandRunStore.setState({
      runsBySession: { 'session-1': { ...finishedRun, commandId: 'cmd-other' } }
    })
    render(
      <KanbanTicketCard
        ticket={makeMarkedTicket({ column: 'review', current_session_id: 'session-1' })}
      />
    )

    const [, payload] = await duplicate()

    expect(payload).toMatchObject({ external_provider: 'shell-command', external_id: 'cmd-build' })
  })

  it('sends no external source for a plain ticket', async () => {
    render(<KanbanTicketCard ticket={makeTicket()} />)

    const [, payload] = await duplicate()

    expect(payload).toStrictEqual({
      project_id: 'project-1',
      title: 'Build',
      description: 'Runs make',
      column: 'todo',
      labels: []
    })
  })

  it('does not mark the copy of an agent ticket whose session is not a shell command', async () => {
    useShellCommandRunStore.setState({ runsBySession: { 'another-session': finishedRun } })
    render(
      <KanbanTicketCard
        ticket={makeTicket({ column: 'review', current_session_id: 'session-1', mode: 'build' })}
      />
    )

    const [, payload] = await duplicate()

    expect(payload).not.toHaveProperty('external_provider')
    expect(payload).not.toHaveProperty('external_id')
  })

  it.each([
    ['jira', 'PROJ-7'],
    ['github', '42']
  ])('does not turn the copy of a %s ticket into a shell-command ticket', async (provider, id) => {
    render(
      <KanbanTicketCard
        ticket={makeTicket({
          external_provider: provider,
          external_id: id,
          external_url: `https://example.com/${id}`
        })}
      />
    )

    const [, payload] = await duplicate()

    expect(payload.external_provider).not.toBe('shell-command')
    expect(payload).toStrictEqual({
      project_id: 'project-1',
      title: 'Build',
      description: 'Runs make',
      column: 'todo',
      labels: []
    })
  })
})

describe('the card of a marked shell-command ticket', () => {
  it('shows the terminal icon and jagged edge in To Do without a session, and no plain ticket does', () => {
    const { unmount } = render(<KanbanTicketCard ticket={makeTicket()} />)
    expect(screen.queryByTestId('ticket-shell-command-icon')).not.toBeInTheDocument()
    expect(card().className).not.toContain('ticket-jagged')
    unmount()

    render(<KanbanTicketCard ticket={makeMarkedTicket()} />)
    const icon = screen.getByTestId('ticket-shell-command-icon')
    expect(icon.getAttribute('title')).toBe('Shell command — drag to In Progress to run it')
    expect(icon.nextElementSibling?.textContent).toBe('Build')
    expect(card().className).toContain('ticket-jagged')
  })

  it('drops the drag hint from the icon once the ticket has a session', () => {
    render(
      <KanbanTicketCard
        ticket={makeMarkedTicket({ column: 'in_progress', current_session_id: 'session-1' })}
      />
    )

    expect(screen.getByTestId('ticket-shell-command-icon').getAttribute('title')).toBe(
      'Shell command'
    )
  })

  it('is not an imported ticket: no provider badge and no remote status update', async () => {
    // An imported ticket has both
    const { unmount } = render(
      <KanbanTicketCard ticket={makeTicket({ external_provider: 'jira', external_id: 'PROJ-7' })} />
    )
    expect(screen.getByTitle('Jira #PROJ-7')).toBeInTheDocument()
    openMenu()
    expect(await screen.findByTestId('ctx-update-remote-status')).toHaveTextContent(
      'Update on Jira'
    )
    unmount()

    render(<KanbanTicketCard ticket={makeMarkedTicket()} />)
    expect(document.querySelector('[title$="#cmd-build"]')).toBeNull()
    openMenu()
    expect(await screen.findByTestId('ctx-duplicate-ticket')).toBeInTheDocument()
    expect(screen.queryByTestId('ctx-update-remote-status')).toBeNull()
    expect(menuItemTexts().filter((text) => text.startsWith('Update on'))).toEqual([])
  })

  it('cannot be moved to another project or given a worktree, unlike a plain ticket', async () => {
    const { unmount } = render(<KanbanTicketCard ticket={makeTicket()} />)
    openMenu()
    expect(await screen.findByTestId('ctx-move-to-project')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-assign-worktree')).toBeInTheDocument()
    unmount()

    render(<KanbanTicketCard ticket={makeMarkedTicket()} />)
    openMenu()
    expect(await screen.findByTestId('ctx-duplicate-ticket')).toBeInTheDocument()
    expect(screen.queryByTestId('ctx-move-to-project')).toBeNull()
    expect(screen.queryByTestId('ctx-assign-worktree')).toBeNull()
  })

  it('offers no worktree assignment outside To Do either', async () => {
    // The full assign flow a session-less plain ticket gets in any other column
    const { unmount } = render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)
    openMenu()
    expect(await screen.findByTestId('ctx-assign-worktree')).toBeInTheDocument()
    unmount()

    render(<KanbanTicketCard ticket={makeMarkedTicket({ column: 'review' })} />)
    openMenu()
    expect(await screen.findByTestId('ctx-duplicate-ticket')).toBeInTheDocument()
    expect(screen.queryByTestId('ctx-assign-worktree')).toBeNull()
  })
})

describe('right-button drag of a shell-command ticket into In Progress', () => {
  it('runs the command of a marked ticket and launches no agent', () => {
    mocks.startShellCommandTicket.mockResolvedValue(true)
    const ticket = makeMarkedTicket()
    const inProgress = renderWithInProgressColumn(ticket)

    rightDragInto(inProgress)

    expect(mocks.startShellCommandTicket).toHaveBeenCalledTimes(1)
    expect(mocks.startShellCommandTicket).toHaveBeenCalledWith(ticket)
    expect(mocks.quickLaunchTicket).not.toHaveBeenCalled()
    expect(mocks.quickLaunchTicketOnConnection).not.toHaveBeenCalled()
  })

  it('runs a legacy shell-command ticket again instead of launching an agent', () => {
    mocks.startShellCommandTicket.mockResolvedValue(true)
    const ticket = makeLegacyRunTicket()
    const inProgress = renderWithInProgressColumn(ticket)

    rightDragInto(inProgress)

    expect(mocks.startShellCommandTicket).toHaveBeenCalledWith(ticket)
    expect(mocks.quickLaunchTicket).not.toHaveBeenCalled()
  })

  it('still quick-launches a plain ticket', () => {
    mocks.quickLaunchTicket.mockResolvedValue(true)
    const ticket = makeTicket()
    const inProgress = renderWithInProgressColumn(ticket)

    rightDragInto(inProgress)

    expect(mocks.quickLaunchTicket).toHaveBeenCalledTimes(1)
    expect(mocks.quickLaunchTicket).toHaveBeenCalledWith(ticket)
    expect(mocks.startShellCommandTicket).not.toHaveBeenCalled()
  })

  it('starts nothing when dropped into another column', () => {
    renderWithInProgressColumn(makeMarkedTicket())

    rightDragInto(document.querySelector('[data-kanban-column="review"]') as HTMLElement)

    expect(mocks.startShellCommandTicket).not.toHaveBeenCalled()
    expect(mocks.quickLaunchTicket).not.toHaveBeenCalled()
  })

  it('refuses a blocked ticket with a warning', () => {
    blockTicket()
    const inProgress = renderWithInProgressColumn(makeMarkedTicket())

    rightDragInto(inProgress)

    expect(toast.warning).toHaveBeenCalledWith('Ticket is blocked — resolve its dependencies first')
    expect(mocks.startShellCommandTicket).not.toHaveBeenCalled()
    expect(mocks.quickLaunchTicket).not.toHaveBeenCalled()
  })

  it('ignores dependencies in simple mode', () => {
    mocks.startShellCommandTicket.mockResolvedValue(true)
    blockTicket()
    useKanbanStore.setState({ simpleModeByProject: { 'project-1': true } })
    const ticket = makeMarkedTicket()
    const inProgress = renderWithInProgressColumn(ticket)

    rightDragInto(inProgress)

    expect(mocks.startShellCommandTicket).toHaveBeenCalledWith(ticket)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
