import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from '@/lib/toast'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { DocumentRun } from '@shared/types/document-flow'
import { NewRunBranchSession } from './NewRunBranchSession'

const checkout = vi.hoisted(() => ({ launchTicketOnCheckout: vi.fn() }))

vi.mock('@/lib/document-flow/run-checkout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-flow/run-checkout')>()),
  launchTicketOnCheckout: checkout.launchTicketOnCheckout
}))
vi.mock('@/components/kanban/WorktreePickerModal', () => ({
  quickLaunchTicket: vi.fn(),
  quickLaunchTicketOnConnection: vi.fn()
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const RUN = {
  id: 'run-1',
  status: 'completed',
  project_id: 'project-1',
  title: 'Checkout redesign',
  base_branch: 'main',
  integration_branch: 'doc-checkout',
  integration_worktree_id: 'wt-integration',
  integration_connection_id: null,
  members: null
} as unknown as DocumentRun

const CONNECTION_RUN = {
  ...RUN,
  project_id: 'connection-project',
  integration_worktree_id: null,
  integration_connection_id: 'conn-integration',
  members: [{ project_id: 'web' }]
} as unknown as DocumentRun

const TICKET = {
  id: 't1',
  project_id: 'project-1',
  title: 'Fix the footer',
  description: 'It overlaps',
  attachments: [{ type: 'image', url: '/a/shot.png', label: 'shot.png' }],
  column: 'todo'
}

const initialConnections = useConnectionStore.getState()
const initialKanban = useKanbanStore.getState()
const initialSettings = useSettingsStore.getState()
const initialWorktrees = useWorktreeStore.getState()

const showModal = async (run: DocumentRun = RUN): Promise<void> => {
  render(<NewRunBranchSession run={run} />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('docflow-new-branch-session'))
  })
}

const sendTicket = async (): Promise<void> => {
  fireEvent.change(screen.getByTestId('ticket-title-input'), { target: { value: 'Fix the footer' } })
  await act(async () => {
    fireEvent.click(screen.getByTestId('ticket-create-send-btn'))
  })
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  checkout.launchTicketOnCheckout.mockResolvedValue('session-1')
  useKanbanStore.setState({ createTicket: vi.fn().mockResolvedValue(TICKET) } as never)
  useSettingsStore.setState({ defaultAgentSdk: 'claude-code-cli', customProviders: [] })
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      ['project-1', [{ id: 'wt-integration', is_default: false, branch_name: 'doc-checkout' }]]
    ]) as never,
    loadedProjectIds: new Set(['project-1']),
    loadWorktrees: vi.fn(async () => undefined)
  })
  useConnectionStore.setState({
    loaded: true,
    connections: [{ id: 'conn-integration', status: 'active', path: '/c/int', members: [] }] as never,
    loadConnections: vi.fn(async () => undefined)
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useConnectionStore.setState(initialConnections, true)
  useKanbanStore.setState(initialKanban, true)
  useSettingsStore.setState(initialSettings, true)
  useWorktreeStore.setState(initialWorktrees, true)
})

describe('NewRunBranchSession', () => {
  it('opens the new ticket modal for the run’s branch, with its two buttons', async () => {
    await showModal()

    expect(screen.getByTestId('ticket-create-modal')).toBeInTheDocument()
    expect(screen.getByTestId('ticket-create-send-branch')).toHaveTextContent('doc-checkout')
    expect(screen.queryByTestId('ticket-create-btn')).toBeNull()
  })

  it('creates the ticket on the run’s project and sends it to the integration worktree', async () => {
    await showModal()
    await sendTicket()

    await waitFor(() => expect(checkout.launchTicketOnCheckout).toHaveBeenCalledTimes(1))
    expect(useKanbanStore.getState().createTicket).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ project_id: 'project-1', column: 'todo' })
    )
    const [ticket, target, launch] = checkout.launchTicketOnCheckout.mock.calls[0]
    expect(ticket).toBe(TICKET)
    expect(target).toEqual({ kind: 'worktree', worktreeId: 'wt-integration' })
    expect(launch.modelConfig.sdk).toBe('claude-code-cli')
  })

  it('sends the ticket’s normal prompt, attachments included', async () => {
    await showModal()
    await sendTicket()

    await waitFor(() => expect(checkout.launchTicketOnCheckout).toHaveBeenCalledTimes(1))
    const { prompt } = checkout.launchTicketOnCheckout.mock.calls[0][2]
    expect(prompt).toContain('Please implement the following ticket.')
    expect(prompt).toContain('<ticket title="Fix the footer">It overlaps')
    expect(prompt).toContain('<file path="/a/shot.png">shot.png</file>')
  })

  it('uses the connection project’s board and the integration instance for a connection run', async () => {
    await showModal(CONNECTION_RUN)
    await sendTicket()

    await waitFor(() => expect(checkout.launchTicketOnCheckout).toHaveBeenCalledTimes(1))
    expect(useKanbanStore.getState().createTicket).toHaveBeenCalledWith(
      'connection-project',
      expect.objectContaining({ project_id: 'connection-project' })
    )
    expect(checkout.launchTicketOnCheckout.mock.calls[0][1]).toEqual({
      kind: 'connection',
      connectionId: 'conn-integration'
    })
  })

  it('gives the focus back to its button when the modal closes', async () => {
    await showModal()
    await act(async () => {
      fireEvent.click(screen.getByTestId('ticket-cancel-btn'))
    })

    await waitFor(() => expect(screen.getByTestId('docflow-new-branch-session')).toHaveFocus())
  })

  it('says so on success', async () => {
    await showModal()
    await sendTicket()

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Session started on doc-checkout')
    )
  })

  it('says where the ticket went when it could not start', async () => {
    checkout.launchTicketOnCheckout.mockRejectedValue(new Error('No such worktree.'))
    await showModal()
    await sendTicket()

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not start the session on doc-checkout: No such worktree. The ticket is in To Do.'
      )
    )
  })

  it('opens nothing once the worktree is archived, and says why', async () => {
    useWorktreeStore.setState({ worktreesByProject: new Map([['project-1', []]]) as never })
    await showModal()

    expect(screen.queryByTestId('ticket-create-modal')).toBeNull()
    expect(toast.info).toHaveBeenCalledWith('The worktree of doc-checkout was archived.')
  })

  it('opens nothing once the instance is archived, and says why', async () => {
    useConnectionStore.setState({ connections: [] })
    await showModal(CONNECTION_RUN)

    expect(screen.queryByTestId('ticket-create-modal')).toBeNull()
    expect(toast.info).toHaveBeenCalledWith('The instance of doc-checkout was archived or deleted.')
  })

  it.each(['running', 'paused'] as const)(
    'is withheld, and says so, while the run is %s',
    (status) => {
      render(<NewRunBranchSession run={{ ...RUN, status }} />)

      expect(screen.getByTestId('docflow-new-branch-session')).toBeDisabled()
      expect(screen.getByTestId('docflow-new-branch-session-blocked')).toHaveTextContent(
        'Available when the run ends'
      )
    }
  )

  it.each(['completed', 'completed_with_issues', 'cancelled'] as const)(
    'is offered once the run is %s',
    (status) => {
      render(<NewRunBranchSession run={{ ...RUN, status }} />)

      expect(screen.getByTestId('docflow-new-branch-session')).toBeEnabled()
      expect(screen.queryByTestId('docflow-new-branch-session-blocked')).toBeNull()
    }
  )

  it('refreshes the checkouts before deciding', async () => {
    await showModal()
    expect(useWorktreeStore.getState().loadWorktrees).toHaveBeenCalledWith('project-1')

    cleanup()
    await showModal(CONNECTION_RUN)
    expect(useConnectionStore.getState().loadConnections).toHaveBeenCalledTimes(1)
  })
})
