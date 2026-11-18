/**
 * "New PRD → orchestrator ticket…" on the card of the ticket whose session writes the PRD and
 * then the tasks document: the "PRD flow" pill for every step of a flow that is on, for a
 * session that waits for the person and for a flow that stopped; "Retry" beside the pill of a
 * stopped flow, which continues the flow and does not open the ticket; the menu's "Retry
 * PRD flow" and "Cancel PRD flow"; and "Move to project…", which is off for as long as the
 * ticket has a flow. What the two actions do is tested in lib/prd-flow.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket, Project } from '../../../../main/db/types'

// Radix opens a context menu slowly under jsdom here (see the other card-menu suites)
vi.setConfig({ testTimeout: 120_000 })

const api = vi.hoisted(() => ({ get: vi.fn(async () => null) }))
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))
const actions = vi.hoisted(() => ({
  retryPrdFlow: vi.fn(async () => {}),
  cancelPrdFlow: vi.fn(async () => {})
}))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/lib/toast', () => ({ toast: toastMock }))
vi.mock('@/lib/prd-flow/actions', () => actions)

import { KanbanTicketCard } from './KanbanTicketCard'
import { tonePillClass } from '@/components/document-flow/document-flow-ui'
import { useKanbanStore } from '@/stores/useKanbanStore'
import {
  usePrdFlowStore,
  type PrdFlow,
  type PrdFlowAttention,
  type PrdFlowStage
} from '@/stores/usePrdFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'

const initialKanbanState = useKanbanStore.getState()
const initialPrdFlowState = usePrdFlowStore.getState()
const initialProjectState = useProjectStore.getState()

const PROJECT = 'project-1'
const TICKET = 'ticket-1'
const now = '2026-06-01T00:00:00.000Z'

/** The flow's ticket as the flow leaves it: In Progress, linked to the flow's session. */
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: TICKET,
    project_id: PROJECT,
    title: 'code mode',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: 'session-1',
    worktree_id: null,
    mode: 'build',
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

function makeFlow(overrides: Partial<PrdFlow> = {}): PrdFlow {
  return {
    ticketId: TICKET,
    projectId: PROJECT,
    name: 'code mode',
    prefix: 'CODE_MODE',
    prompt: 'A mode for writing code.',
    research: true,
    clarify: true,
    launch: { sdk: 'claude-code', model: null, codexFastMode: false },
    checkout: { kind: 'worktree', worktreeId: 'wt-main' },
    cwd: '/code/shop',
    memberDirs: [],
    sessionId: 'session-1',
    stage: 'prd',
    status: 'running',
    attention: null,
    detail: null,
    promptedAt: 1_000,
    reprompts: 0,
    resumes: 0,
    waitingSince: null,
    retryAt: null,
    forcePrompt: false,
    prdPath: null,
    tasksPath: null,
    runId: null,
    createdAt: 1_000,
    ...overrides
  }
}

/** The ticket's flow as the PRD flow store holds it. */
function seedFlow(overrides: Partial<PrdFlow> = {}): void {
  usePrdFlowStore.getState().putFlow(makeFlow(overrides))
}

/** A flow that stopped and waits for the person. */
function seedStoppedFlow(overrides: Partial<PrdFlow> = {}): void {
  seedFlow({
    status: 'needs_attention',
    attention: 'missing_file',
    detail: 'CODE_MODE_PRD.html was not created.',
    ...overrides
  })
}

const card = (): HTMLElement => screen.getByTestId(`kanban-ticket-${TICKET}`)
const pill = (): HTMLElement | null => screen.queryByTestId('ticket-prd-flow-pill')
const retryButton = (): HTMLElement | null => screen.queryByTestId('ticket-prd-flow-retry')
const retryItem = (): HTMLElement | null => screen.queryByTestId('ctx-prd-flow-retry')
const cancelItem = (): HTMLElement | null => screen.queryByTestId('ctx-prd-flow-cancel')

/** Opens the card's menu and waits for an item every ticket of this Mac has. */
async function openMenu(): Promise<void> {
  fireEvent.contextMenu(card())
  await screen.findByTestId('ctx-delete-ticket')
}

const isDisabled = (element: HTMLElement): boolean =>
  element.hasAttribute('data-disabled') || element.getAttribute('aria-disabled') === 'true'

// floating-ui probes every positioned element with matches(':popover-open') and
// matches(':modal'); jsdom recurses on them for seconds per menu. Answer them directly.
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

beforeEach(() => {
  useProjectStore.setState({
    projects: [{ id: PROJECT, name: 'Shop', path: '/code/shop', kind: 'git' } as Project]
  })
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.clearAllMocks()
  useKanbanStore.setState(initialKanbanState, true)
  usePrdFlowStore.setState(initialPrdFlowState, true)
  useProjectStore.setState(initialProjectState, true)
})

describe('the "PRD flow" pill', () => {
  it.each<[PrdFlowStage, string]>([
    ['launching', 'PRD flow · starting'],
    ['prd', 'PRD flow · writing the PRD'],
    ['tasks', 'PRD flow · writing the tasks'],
    ['creating_run', 'PRD flow · creating the orchestrator']
  ])('names the step of a flow that is on at %s, in blue', (stage, label) => {
    seedFlow({ stage })
    // Nothing else on the card asks for the badge row: the pill alone must make it render
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(pill()).toHaveTextContent(new RegExp(`^${label}$`))
    expect(pill()).toHaveAttribute('data-stage', stage)
    expect(pill()).toHaveAttribute('data-status', 'running')
    expect(pill()).toHaveClass(...tonePillClass('info').split(' '))
    expect(retryButton()).toBeNull()
  })

  it('says in its hover text what the step does, or what the flow waits for', () => {
    seedFlow({ stage: 'tasks' })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(pill()).toHaveAttribute(
      'title',
      'The session is writing CODE_MODE_TASKS.html, which becomes an orchestrator ticket.'
    )

    act(() => {
      usePrdFlowStore
        .getState()
        .patchFlow(TICKET, { detail: 'Waiting for work the session left running.' })
    })

    expect(pill()).toHaveAttribute('title', 'Waiting for work the session left running.')
    expect(pill()).toHaveTextContent(/^PRD flow · writing the tasks$/)
  })

  it('says "waiting for you", in amber, while the session asks the person something', () => {
    seedFlow({ stage: 'prd', detail: 'Waiting for you: a question' })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(pill()).toHaveTextContent(/^PRD flow · waiting for you$/)
    expect(pill()).toHaveAttribute('title', 'Waiting for you: a question')
    expect(pill()).toHaveAttribute('data-stage', 'prd')
    expect(pill()).toHaveAttribute('data-status', 'running')
    expect(pill()).toHaveClass(...tonePillClass('warning').split(' '))
    expect(retryButton()).toBeNull()
  })

  it.each<[PrdFlowStage, PrdFlowAttention, string]>([
    ['launching', 'launch_failed', 'The session could not be started: no model.'],
    ['prd', 'missing_file', 'CODE_MODE_PRD.html was not created.'],
    ['tasks', 'user_stopped', 'You stopped the session. Retry continues the flow.'],
    ['creating_run', 'run_failed', 'The orchestrator ticket could not be created: offline']
  ])(
    'says "needs attention", in red, with "Retry" beside it, for a flow that stopped at %s',
    (stage, attention, detail) => {
      seedStoppedFlow({ stage, attention, detail })
      render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

      expect(pill()).toHaveTextContent(/^PRD flow · needs attention$/)
      expect(pill()).toHaveAttribute('data-stage', stage)
      expect(pill()).toHaveAttribute('data-status', 'needs_attention')
      expect(pill()).toHaveAttribute('title', detail)
      expect(pill()).toHaveClass(...tonePillClass('danger').split(' '))
      expect(retryButton()).toHaveTextContent(/^Retry$/)
    }
  )

  it('is absent on a ticket with no flow, also while another ticket has one', () => {
    seedFlow({ ticketId: 'ticket-other' })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(pill()).toBeNull()
    expect(retryButton()).toBeNull()
  })

  it('follows the flow as the store moves it along, until the flow is over', () => {
    seedFlow({ stage: 'launching', sessionId: null })
    render(<KanbanTicketCard ticket={makeTicket()} />)
    expect(pill()).toHaveTextContent('PRD flow · starting')

    act(() => {
      usePrdFlowStore.getState().patchFlow(TICKET, { stage: 'prd', sessionId: 'session-1' })
    })
    expect(pill()).toHaveTextContent('PRD flow · writing the PRD')

    act(() => {
      usePrdFlowStore.getState().patchFlow(TICKET, {
        status: 'needs_attention',
        attention: 'missing_file',
        detail: 'CODE_MODE_PRD.html was not created.'
      })
    })
    expect(pill()).toHaveTextContent('PRD flow · needs attention')
    expect(retryButton()).toBeInTheDocument()

    act(() => {
      usePrdFlowStore
        .getState()
        .patchFlow(TICKET, { stage: 'tasks', status: 'running', attention: null, detail: null })
    })
    expect(pill()).toHaveTextContent('PRD flow · writing the tasks')
    expect(retryButton()).toBeNull()

    act(() => usePrdFlowStore.getState().removeFlow(TICKET))
    expect(pill()).toBeNull()
  })
})

describe('"Retry" beside the pill of a flow that stopped', () => {
  const markTicketRead = vi.fn()
  const setSelectedTicketRef = vi.fn()

  beforeEach(() => {
    useKanbanStore.setState({ markTicketRead, setSelectedTicketRef } as never)
  })

  it('continues the flow, and does not open the ticket', () => {
    seedStoppedFlow()
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    fireEvent.click(retryButton()!)

    expect(actions.retryPrdFlow).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(actions.cancelPrdFlow).not.toHaveBeenCalled()
    expect(setSelectedTicketRef).not.toHaveBeenCalled()
  })

  it('leaves a click anywhere else on the card to open the ticket, as on any card', () => {
    seedStoppedFlow()
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    fireEvent.click(pill()!)

    expect(setSelectedTicketRef).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT,
      ticketId: TICKET
    })
    expect(actions.retryPrdFlow).not.toHaveBeenCalled()
  })
})

describe("the PRD flow items of the card's menu", () => {
  it('offers "Retry PRD flow" for a flow that stopped, which continues it', async () => {
    seedStoppedFlow()
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    await openMenu()
    expect(retryItem()).toHaveTextContent(/^Retry PRD flow$/)
    expect(cancelItem()).toHaveTextContent(/^Cancel PRD flow$/)
    fireEvent.click(retryItem()!)

    expect(actions.retryPrdFlow).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(actions.cancelPrdFlow).not.toHaveBeenCalled()
  })

  it('offers "Cancel PRD flow" for a flow that stopped, which forgets it', async () => {
    seedStoppedFlow()
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    await openMenu()
    fireEvent.click(cancelItem()!)

    expect(actions.cancelPrdFlow).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(actions.retryPrdFlow).not.toHaveBeenCalled()
  })

  it.each<[PrdFlowStage]>([['launching'], ['prd'], ['tasks'], ['creating_run']])(
    'offers "Cancel PRD flow" alone while the flow is on at %s',
    async (stage) => {
      seedFlow({ stage })
      render(<KanbanTicketCard ticket={makeTicket()} />)

      await openMenu()
      expect(retryItem()).toBeNull()
      expect(cancelItem()).toHaveClass('text-destructive')
      fireEvent.click(cancelItem()!)

      expect(actions.cancelPrdFlow).toHaveBeenCalledExactlyOnceWith(TICKET)
      expect(actions.retryPrdFlow).not.toHaveBeenCalled()
    }
  )

  it('offers neither on a ticket with no flow', async () => {
    seedStoppedFlow({ ticketId: 'ticket-other' })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openMenu()

    expect(retryItem()).toBeNull()
    expect(cancelItem()).toBeNull()
  })
})

describe('a ticket with a PRD flow stays on its board', () => {
  const moveItem = (): HTMLElement => screen.getByTestId('ctx-move-to-project')

  it.each<[PrdFlowStage]>([['launching'], ['prd'], ['tasks'], ['creating_run']])(
    'does not move to another project while the flow is on at %s, and says what to do first',
    async (stage) => {
      seedFlow({ stage })
      render(<KanbanTicketCard ticket={makeTicket()} />)

      await openMenu()

      expect(isDisabled(moveItem())).toBe(true)
      expect(moveItem()).toHaveTextContent(/^Move to project… · cancel its PRD flow first$/)
      fireEvent.click(moveItem())
      expect(screen.queryByRole('dialog')).toBeNull()
    }
  )

  it('does not move while its flow stopped and waits for the person either', async () => {
    seedStoppedFlow()
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    await openMenu()

    expect(isDisabled(moveItem())).toBe(true)
    expect(moveItem()).toHaveTextContent(/^Move to project… · cancel its PRD flow first$/)
  })

  it('moves as any ticket once it has no flow, also while another ticket has one', async () => {
    seedFlow({ ticketId: 'ticket-other' })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openMenu()

    expect(isDisabled(moveItem())).toBe(false)
    expect(moveItem()).toHaveTextContent(/^Move to project…$/)
  })

  it('moves again as soon as the flow is cancelled or over', async () => {
    seedFlow()
    render(<KanbanTicketCard ticket={makeTicket()} />)
    await openMenu()
    expect(isDisabled(moveItem())).toBe(true)

    act(() => usePrdFlowStore.getState().removeFlow(TICKET))

    expect(isDisabled(moveItem())).toBe(false)
    expect(moveItem()).toHaveTextContent(/^Move to project…$/)
  })
})
