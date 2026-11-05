// The wizard for an orchestrator made from board tickets (a run whose `source_kind` is
// `tickets`): the pick step's "Document | Board tickets" switch, the ticket picker (eligible
// tickets checkable, the others locked with the reason, run and shell command tickets hidden,
// blockers left out offered), creating the run straight into its preview, and the preview
// without anything document-made — the rows are the board tickets, edited on the board, with
// Remove, the board's dependencies, the prompt the agent receives and "Add tickets".
// The document path has its own tests (ImplementDocumentWizard.pick / .preview).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOVE_RUN_REFUSAL } from '@/lib/peers/move-run'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { usePeerStore } from '@/stores/usePeerStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { DOCUMENT_RUN_TICKET_PROVIDER } from '@shared/document-flow/run-ticket'
import { SHELL_COMMAND_TICKET_PROVIDER } from '@shared/lib/shell-commands'
import type { PeerState } from '@shared/remote-access/peer-protocol'
import type {
  DocumentRunDetail,
  DocumentRunItem,
  DocumentRunPatch
} from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'
import { ImplementDocumentWizard } from './ImplementDocumentWizard'
import { TEST_PROJECT, makeDetail } from './test-fixtures'
import { DOCFLOW_TEXT_DEBOUNCE_MS } from './useDebouncedText'

const api = vi.hoisted(() => ({
  createRun: vi.fn(),
  createTicketRun: vi.fn(),
  addTickets: vi.fn(),
  removeItem: vi.fn(),
  setItemDependencies: vi.fn(),
  retryExtraction: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  updateRun: vi.fn(),
  updateItem: vi.fn(),
  start: vi.fn(),
  suggestVerifyCommand: vi.fn()
}))
const listBranchesWithStatus = vi.hoisted(() => vi.fn())

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/api/git-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/git-api')>()
  return { ...actual, gitApi: { ...actual.gitApi, listBranchesWithStatus } }
})
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialSettingsState = useSettingsStore.getState()
const initialPeerState = usePeerStore.getState()

/** Another Mac, live and taking moves. */
const STUDIO: PeerState = {
  desktopId: 'mac-b',
  desktopName: 'Studio Mac',
  instanceId: null,
  slot: null,
  appVersion: null,
  platform: null,
  online: true,
  paired: true,
  pairedInbound: true,
  link: 'live',
  executorOnline: true,
  capabilities: ['move-v1'],
  lastError: null,
  lastSeenAt: null,
  pairing: null
}

const PROJECT = TEST_PROJECT.id
const NOW = '2026-11-04T10:00:00.000Z'

function boardTicket(overrides: Partial<KanbanTicket> & { id: string }): KanbanTicket {
  return {
    project_id: PROJECT,
    title: `Ticket ${overrides.id}`,
    description: '',
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: NOW,
    updated_at: NOW,
    column_changed_at: NOW,
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
    labels: [],
    created_from_session: false,
    auto_approve_plan: false,
    unread: false,
    awaiting_completion: false,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ticket_prefix: 'TD',
    ticket_number: null,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  } as KanbanTicket
}

/**
 * The board: TD-1 waits for TD-2 (both To Do); TD-3 runs a session and TD-4 is queued (both
 * In Progress); TD-7 is Done; TD-8 belongs to another run; plus a run ticket and a shell
 * command ticket, which the picker never lists.
 */
const BOARD: KanbanTicket[] = [
  boardTicket({ id: 't1', ticket_number: 1, title: 'Login form', sort_order: 1 }),
  boardTicket({ id: 't2', ticket_number: 2, title: 'Login API', sort_order: 2 }),
  boardTicket({
    id: 't3',
    ticket_number: 3,
    title: 'Started already',
    column: 'in_progress',
    current_session_id: 'session-3'
  }),
  boardTicket({ id: 't4', ticket_number: 4, title: 'Queued work', column: 'in_progress' }),
  boardTicket({ id: 't7', ticket_number: 7, title: 'Old work', column: 'done' }),
  boardTicket({ id: 't8', ticket_number: 8, title: 'Held elsewhere', sort_order: 8 }),
  boardTicket({
    id: 'run-ticket',
    ticket_number: 20,
    title: 'Some orchestrator',
    external_provider: DOCUMENT_RUN_TICKET_PROVIDER,
    external_id: 'run-other'
  }),
  boardTicket({
    id: 'shell',
    ticket_number: 21,
    title: 'npm run dev',
    external_provider: SHELL_COMMAND_TICKET_PROVIDER,
    external_id: 'cmd-1'
  })
]

const OTHER_RUN = makeDetail({ id: 'run-other', title: 'Other run', source_kind: 'tickets' }, [
  { key: 'TD-8', ticket_id: 't8' }
])

const loadTickets = vi.fn(async () => {})
const updateTicket = vi.fn(async () => {})

function seedBoard(tickets: KanbanTicket[] = BOARD): void {
  useKanbanStore.setState({
    tickets: new Map([[PROJECT, tickets]]),
    dependencyMap: new Map([[ticketKey(PROJECT, 't1'), new Set([ticketKey(PROJECT, 't2')])]]),
    loadTickets,
    updateTicket
  } as never)
}

/** A previewed orchestrator holding TD-1 (after TD-2) and TD-2. */
function ticketRunDetail(overrides: Partial<DocumentRunDetail['run']> = {}): DocumentRunDetail {
  return makeDetail(
    {
      id: 'run-t',
      title: 'Login',
      source_kind: 'tickets',
      source_path: '',
      document_path: null,
      extraction: null,
      ...overrides
    },
    [
      {
        key: 'TD-2',
        title: 'Login API',
        description: '',
        kind: 'change',
        size: null,
        conflict_risk: null,
        ticket_id: 't2'
      },
      {
        key: 'TD-1',
        title: 'Login form',
        description: '',
        kind: 'change',
        size: null,
        conflict_risk: null,
        ticket_id: 't1',
        depends_on: ['TD-2']
      }
    ]
  )
}

const storedDetail = (runId: string): DocumentRunDetail =>
  useDocumentFlowStore.getState().runsById[runId]

function openWizard(
  wizard: Partial<ReturnType<typeof useDocumentFlowStore.getState>['wizard']> = {}
): void {
  useDocumentFlowStore.setState({
    wizard: { open: true, projectId: PROJECT, runId: null, ...wizard }
  })
}

function seedRuns(...details: DocumentRunDetail[]): void {
  useDocumentFlowStore.setState({
    runsById: Object.fromEntries(details.map((detail) => [detail.run.id, detail])),
    loadedProjects: { [PROJECT]: true }
  })
}

async function renderWizard(): Promise<void> {
  await act(async () => {
    render(<ImplementDocumentWizard />)
  })
}

async function renderTicketPreview(detail: DocumentRunDetail = ticketRunDetail()): Promise<void> {
  seedRuns(detail)
  openWizard({ runId: detail.run.id })
  await renderWizard()
}

const row = (ticketId: string): HTMLElement => screen.getByTestId(`docflow-ticket-row-${ticketId}`)

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  // The server's list is what the store holds (nothing deleted elsewhere).
  api.list.mockImplementation(async () => Object.values(useDocumentFlowStore.getState().runsById))
  api.get.mockImplementation(async (runId: string) => storedDetail(runId) ?? null)
  api.suggestVerifyCommand.mockResolvedValue(null)
  api.updateRun.mockImplementation(async (runId: string, patch: DocumentRunPatch) => {
    const { run } = storedDetail(runId)
    return {
      ...run,
      ...(patch.title ? { title: patch.title } : {}),
      config: { ...run.config, ...patch.config }
    }
  })
  api.createTicketRun.mockImplementation(
    async ({ ticketIds, title }: { ticketIds: string[]; title?: string }) =>
      makeDetail(
        {
          id: 'run-new',
          title: title ?? 'Login API + 1 more',
          source_kind: 'tickets',
          source_path: '',
          document_path: null,
          extraction: null
        },
        ticketIds.map((ticketId) => ({
          key: `TD-${ticketId.slice(1)}`,
          ticket_id: ticketId,
          kind: 'change' as const
        }))
      )
  )
  listBranchesWithStatus.mockResolvedValue({
    success: true,
    branches: [
      { name: 'main', isRemote: false, isCheckedOut: true, worktreePath: TEST_PROJECT.path }
    ]
  })
  useProjectStore.setState({ projects: [TEST_PROJECT] } as never)
  useSettingsStore.setState({
    defaultAgentSdk: 'claude-code',
    availableAgentSdks: { opencode: true, claude: true, codex: true }
  })
  seedBoard()
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useProjectStore.setState(initialProjectState, true)
  useSettingsStore.setState(initialSettingsState, true)
  usePeerStore.setState(initialPeerState, true)
})

describe('ImplementDocumentWizard — board tickets source', () => {
  it('switches the pick step between a document and board tickets; the title follows', async () => {
    openWizard()
    await renderWizard()

    expect(screen.getByTestId('docflow-wizard-title')).toHaveTextContent('Implement document')
    expect(screen.getByTestId('docflow-source-document')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('docflow-path-input')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-ticket-picker')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-source-tickets'))
    })
    expect(screen.getByTestId('docflow-wizard-title')).toHaveTextContent('Orchestrate tickets')
    expect(screen.getByTestId('docflow-ticket-picker')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-path-input')).toBeNull()
    // The board is read afresh: a ticket launched since must say so.
    expect(loadTickets).toHaveBeenCalledWith(PROJECT)

    fireEvent.click(screen.getByTestId('docflow-source-document'))
    expect(screen.getByTestId('docflow-wizard-title')).toHaveTextContent('Implement document')
    expect(screen.getByTestId('docflow-path-input')).toBeInTheDocument()
  })

  it('treats the switch as one tab stop, on the checked option, moved by the arrow keys', async () => {
    openWizard({ source: 'tickets' })
    await renderWizard()

    const tickets = screen.getByTestId('docflow-source-tickets')
    const document_ = screen.getByTestId('docflow-source-document')
    expect(tickets).toHaveAttribute('tabindex', '0')
    expect(document_).toHaveAttribute('tabindex', '-1')

    await act(async () => {
      tickets.focus()
      fireEvent.keyDown(tickets, { key: 'ArrowLeft' })
    })
    expect(screen.getByTestId('docflow-source-document')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('docflow-source-document')).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('docflow-source-document')).toHaveFocus()
    expect(screen.getByTestId('docflow-wizard-title')).toHaveTextContent('Implement document')
  })

  it('opens on board tickets with the preselected tickets checked', async () => {
    openWizard({ source: 'tickets', preselectedTicketIds: ['t2'] })
    await renderWizard()

    expect(screen.getByTestId('docflow-wizard-title')).toHaveTextContent('Orchestrate tickets')
    expect(row('t2')).toHaveAttribute('aria-checked', 'true')
    expect(row('t1')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('docflow-ticket-picker-count')).toHaveTextContent('1 ticket selected')
    expect(screen.getByTestId('docflow-create-ticket-run')).toHaveTextContent(
      'Create orchestrator (1)'
    )
    expect(screen.getByTestId('docflow-ticket-run-name')).toHaveAttribute(
      'placeholder',
      'Login API'
    )
  })

  it('locks tickets that cannot join with the reason and hides run and shell tickets', async () => {
    seedRuns(OTHER_RUN)
    openWizard({ source: 'tickets' })
    await renderWizard()

    // To Do to start with.
    expect(row('t1')).toBeEnabled()
    expect(row('t2')).toBeEnabled()
    expect(row('t8')).toBeDisabled()
    expect(screen.getByTestId('docflow-ticket-row-refusal-t8')).toHaveTextContent(
      'It is already part of “Other run”.'
    )
    expect(screen.queryByTestId('docflow-ticket-row-t4')).toBeNull()
    expect(screen.queryByTestId('docflow-ticket-row-run-ticket')).toBeNull()
    expect(screen.queryByTestId('docflow-ticket-row-shell')).toBeNull()
    // TD-1 waits for TD-2 on the board.
    expect(screen.getByTestId('docflow-ticket-row-blockers-t1')).toHaveTextContent('blocked by 1')

    fireEvent.click(screen.getByTestId('docflow-ticket-picker-column-in_progress'))
    // Queued (no session) has not started; a ticket with a session has.
    expect(row('t4')).toBeEnabled()
    expect(row('t4')).toHaveTextContent('queued')
    expect(row('t3')).toBeDisabled()
    expect(screen.getByTestId('docflow-ticket-row-refusal-t3')).toHaveTextContent(
      'It already has a session.'
    )

    fireEvent.click(screen.getByTestId('docflow-ticket-picker-column-done'))
    expect(row('t7')).toBeDisabled()
    expect(screen.getByTestId('docflow-ticket-row-refusal-t7')).toHaveTextContent('It is in Done')

    // A locked row does not check.
    fireEvent.click(row('t8'))
    expect(row('t8')).toHaveAttribute('aria-checked', 'false')

    fireEvent.change(screen.getByTestId('docflow-ticket-picker-search'), {
      target: { value: 'td-4' }
    })
    expect(screen.getByTestId('docflow-ticket-row-t4')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-ticket-row-t1')).toBeNull()
  })

  it('offers the blockers a picked ticket waits for and adds them', async () => {
    openWizard({ source: 'tickets' })
    await renderWizard()

    fireEvent.click(row('t1'))
    expect(screen.getByTestId('docflow-ticket-picker-missing-blockers')).toHaveTextContent(
      'TD-1 waits for a ticket you have not picked.'
    )
    fireEvent.click(screen.getByTestId('docflow-ticket-picker-add-blockers'))

    expect(row('t2')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByTestId('docflow-ticket-picker-missing-blockers')).toBeNull()
    expect(screen.getByTestId('docflow-ticket-picker-count')).toHaveTextContent(
      '2 tickets selected'
    )
  })

  it('creates the orchestrator, blockers first, and shows its preview', async () => {
    openWizard({ source: 'tickets' })
    await renderWizard()

    expect(screen.getByTestId('docflow-create-ticket-run')).toBeDisabled()
    fireEvent.click(row('t1'))
    fireEvent.click(row('t2'))
    fireEvent.change(screen.getByTestId('docflow-ticket-run-name'), {
      target: { value: 'Login' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-create-ticket-run'))
    })

    expect(api.createTicketRun).toHaveBeenCalledTimes(1)
    expect(api.createTicketRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, ticketIds: ['t2', 't1'], title: 'Login' })
    )
    expect(api.createRun).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'preview')
    )
    expect(useDocumentFlowStore.getState().wizard.runId).toBe('run-new')
    expect(screen.getByTestId('docflow-wizard-title')).toHaveTextContent('Orchestrate tickets')
    expect(screen.getByTestId('docflow-run-title-input')).toHaveValue('Login')
  })

  it('applies the remembered run settings to the orchestrator it creates, once', async () => {
    useDocumentFlowStore.setState({
      prefs: {
        maxParallel: 6,
        interactive: false,
        promptStyle: 'small',
        verifyCommandByProject: {},
        defaultLaunch: null
      }
    })
    openWizard({ source: 'tickets', preselectedTicketIds: ['t2'] })
    await renderWizard()

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-create-ticket-run'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'preview')
    )
    expect(screen.getByTestId('docflow-parallel-value')).toHaveTextContent('6')
    expect(api.updateRun).toHaveBeenCalledWith('run-new', {
      config: expect.objectContaining({ maxParallel: 6, interactive: false })
    })

    // Reopening the same run shows what is stored, not the remembered settings again.
    cleanup()
    api.updateRun.mockClear()
    useDocumentFlowStore.setState({ prefs: { ...initialFlowState.prefs, maxParallel: 2 } })
    openWizard({ runId: 'run-new' })
    await renderWizard()
    expect(screen.getByTestId('docflow-parallel-value')).toHaveTextContent('6')
    expect(api.updateRun).not.toHaveBeenCalled()
  })

  it('shows the error of a refused creation and stays on the pick step', async () => {
    api.createTicketRun.mockRejectedValue(new Error('TD-2 already has a session.'))
    openWizard({ source: 'tickets', preselectedTicketIds: ['t2'] })
    await renderWizard()

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-create-ticket-run'))
    })
    expect(screen.getByTestId('docflow-pick-error')).toHaveTextContent(
      'TD-2 already has a session.'
    )
    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'pick')
  })

  it('says how to start when the board has nothing to orchestrate', async () => {
    seedBoard([BOARD[2], BOARD[4], BOARD[6]])
    openWizard({ source: 'tickets' })
    await renderWizard()

    expect(screen.getByTestId('docflow-ticket-picker-empty')).toHaveTextContent(
      'No tickets to orchestrate yet. Create tickets on the board'
    )
    expect(screen.getByTestId('docflow-create-ticket-run')).toBeDisabled()
  })

  it('lists an orchestrator among the previous runs by its kind', async () => {
    seedRuns(ticketRunDetail({ title: '' }), makeDetail({ id: 'run-doc' }))
    openWizard()
    await renderWizard()

    expect(screen.getByTestId('docflow-run-kind-run-t')).toHaveAttribute('data-kind', 'tickets')
    expect(screen.getByTestId('docflow-run-row-run-t')).toHaveTextContent('Orchestrator')
    expect(screen.getByTestId('docflow-run-kind-run-doc')).toHaveAttribute('data-kind', 'document')
  })
})

describe('ImplementDocumentWizard — orchestrator preview', () => {
  it('shows the run, not a document: name, counts, Add tickets, no extraction parts', async () => {
    await renderTicketPreview()

    expect(screen.getByTestId('docflow-wizard-title')).toHaveTextContent('Orchestrate tickets')
    expect(screen.getByTestId('docflow-run-title-input')).toHaveValue('Login')
    expect(screen.getByTestId('docflow-preview-meta')).toHaveTextContent('2 tickets · 2 selected')
    expect(screen.getByTestId('docflow-add-tickets-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-reextract-btn')).toBeNull()
    expect(screen.queryByTestId('docflow-open-questions-toggle')).toBeNull()
    expect(screen.queryByTestId('docflow-extraction-warnings')).toBeNull()
    // No prompt style: each ticket is its own brief.
    expect(screen.queryByTestId('docflow-prompt-style')).toBeNull()
    // The row is the ticket: its key and title, what it starts after, no extraction pills.
    const rowTd1 = screen.getByTestId('docflow-item-TD-1')
    expect(rowTd1).toHaveTextContent('Login form')
    expect(rowTd1).not.toHaveTextContent('change')
    expect(screen.getByTestId('docflow-item-dep-TD-1-TD-2')).toHaveTextContent('after TD-2')

    fireEvent.click(screen.getByTestId('docflow-launch-btn'))
    const confirm = screen.getByTestId('docflow-launch-confirm')
    expect(confirm).toHaveTextContent('Questions')
    expect(within(confirm).queryByText('Prompt')).toBeNull()
  })

  it('writes the name of the run after the typing pause', async () => {
    vi.useFakeTimers()
    await renderTicketPreview()

    fireEvent.change(screen.getByTestId('docflow-run-title-input'), {
      target: { value: 'Login rework' }
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })
    expect(api.updateRun).toHaveBeenCalledWith('run-t', { title: 'Login rework' })
  })

  it('removes a ticket from the run, and says so when it cannot', async () => {
    const detail = ticketRunDetail()
    api.removeItem.mockImplementation(async ({ itemId }: { itemId: string }) => ({
      ...detail,
      items: detail.items.filter((item) => item.id !== itemId)
    }))
    await renderTicketPreview(detail)

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-remove-TD-1'))
    })
    expect(api.removeItem).toHaveBeenCalledWith({ runId: 'run-t', itemId: 'item-TD-1' })
    expect(screen.queryByTestId('docflow-item-TD-1')).toBeNull()

    api.removeItem.mockRejectedValue(new Error('TD-2 has launched.'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-remove-TD-2'))
    })
    expect(toast.error).toHaveBeenCalledWith('Could not remove TD-2: TD-2 has launched.')
    expect(screen.getByTestId('docflow-item-TD-2')).toBeInTheDocument()
  })

  it('edits what a ticket starts after through the board dependencies', async () => {
    const detail = ticketRunDetail()
    api.setItemDependencies.mockImplementation(
      async ({ itemId, dependsOn }: { itemId: string; dependsOn: string[] }) => ({
        ...detail,
        items: detail.items.map((item): DocumentRunItem =>
          item.id === itemId ? { ...item, depends_on: dependsOn } : item
        )
      })
    )
    await renderTicketPreview(detail)

    fireEvent.click(screen.getByTestId('docflow-item-toggle-TD-2'))
    // TD-1 already starts after TD-2.
    expect(screen.getByTestId('docflow-item-dep-toggle-TD-2-TD-1')).toBeDisabled()
    fireEvent.click(screen.getByTestId('docflow-item-toggle-TD-1'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-dep-toggle-TD-1-TD-2'))
    })
    expect(api.setItemDependencies).toHaveBeenCalledWith({
      runId: 'run-t',
      itemId: 'item-TD-1',
      dependsOn: []
    })
    expect(api.updateItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('docflow-item-dep-toggle-TD-1-TD-2')).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    api.setItemDependencies.mockRejectedValue(new Error('That would make a cycle.'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-dep-toggle-TD-1-TD-2'))
    })
    expect(toast.error).toHaveBeenCalledWith(
      'Could not change what TD-1 starts after: That would make a cycle.'
    )
  })

  it('edits the board ticket itself and shows what the agent receives', async () => {
    vi.useFakeTimers()
    await renderTicketPreview()

    fireEvent.click(screen.getByTestId('docflow-item-toggle-TD-1'))
    expect(screen.queryByTestId('docflow-item-title-TD-1')).toBeNull()
    const title = screen.getByTestId('docflow-ticket-title-TD-1')
    expect(title).toHaveValue('Login form')
    expect(screen.getByTestId('docflow-ticket-brief-TD-1')).toHaveTextContent(
      'This is the ticket on your board'
    )

    fireEvent.change(title, { target: { value: 'Login form v2' } })
    fireEvent.change(screen.getByTestId('docflow-ticket-description-TD-1'), {
      target: { value: 'Validate the email.' }
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })
    expect(updateTicket).toHaveBeenCalledWith('t1', PROJECT, { title: 'Login form v2' })
    expect(updateTicket).toHaveBeenCalledWith('t1', PROJECT, {
      description: 'Validate the email.'
    })
    // The run's own copy is the board's business, not the item's.
    expect(api.updateItem).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('docflow-brief-preview-toggle-TD-1'))
    expect(screen.getByTestId('docflow-brief-preview-brief-TD-1')).toHaveTextContent(
      'Please implement the following ticket.'
    )
    expect(screen.getByTestId('docflow-brief-preview-brief-TD-1')).toHaveTextContent(
      '<ticket title="Login form">'
    )
    expect(screen.getByTestId('docflow-brief-preview-TD-1')).toHaveTextContent('Added by the run')
    expect(screen.getByTestId('docflow-brief-preview-rules-TD-1')).not.toHaveTextContent(
      'Login form'
    )
  })

  it('adds board tickets to the run from the Add tickets dialog', async () => {
    const detail = ticketRunDetail()
    api.addTickets.mockImplementation(async () => detail)
    await renderTicketPreview(detail)

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-add-tickets-btn'))
    })
    const dialog = screen.getByTestId('docflow-add-tickets-dialog')
    expect(dialog).toHaveAttribute('data-docflow-dialog', '')
    // The run's own tickets are in it already.
    expect(within(dialog).getByTestId('docflow-ticket-row-t1')).toBeDisabled()
    expect(within(dialog).getByTestId('docflow-ticket-row-t1')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(within(dialog).getByTestId('docflow-add-tickets-confirm')).toBeDisabled()
    expect(within(dialog).queryByTestId('docflow-add-tickets-resume-note')).toBeNull()

    fireEvent.click(within(dialog).getByTestId('docflow-ticket-picker-column-in_progress'))
    fireEvent.click(within(dialog).getByTestId('docflow-ticket-row-t4'))
    expect(within(dialog).getByTestId('docflow-add-tickets-confirm')).toHaveTextContent(
      'Add 1 ticket'
    )
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('docflow-add-tickets-confirm'))
    })
    expect(api.addTickets).toHaveBeenCalledWith({ runId: 'run-t', ticketIds: ['t4'] })
    expect(toast.success).toHaveBeenCalledWith('Added 1 ticket to Login')
    expect(screen.queryByTestId('docflow-add-tickets-dialog')).toBeNull()
  })

  it('keeps an orchestrator on this Mac, even with another Mac live and chosen', async () => {
    usePeerStore.setState({ peers: [STUDIO], loaded: true })
    seedRuns(ticketRunDetail())
    openWizard({
      runId: 'run-t',
      destination: { kind: 'peer', desktopId: 'mac-b', desktopName: 'Studio Mac' }
    })
    await renderWizard()

    expect(screen.getByTestId('docflow-run-on-select')).toBeDisabled()
    expect(screen.getByTestId('docflow-run-on-note')).toHaveTextContent(MOVE_RUN_REFUSAL.tickets)
    expect(screen.getByTestId('docflow-launch-btn')).toHaveTextContent('Launch run (2)')
  })

  it('refuses to send an orchestrator to another Mac from the previous runs', async () => {
    usePeerStore.setState({ peers: [STUDIO], loaded: true })
    seedRuns(ticketRunDetail())
    openWizard()
    await renderWizard()

    expect(screen.getByTestId('docflow-move-to-mac-run-t')).toBeDisabled()
    expect(screen.getByTestId('docflow-move-to-mac-run-t')).toHaveAttribute(
      'title',
      MOVE_RUN_REFUSAL.tickets
    )
    expect(screen.getByTestId('docflow-run-on-mac-run-t')).toBeDisabled()
  })
})
