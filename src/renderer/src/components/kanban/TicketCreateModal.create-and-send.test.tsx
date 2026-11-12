import { useSettingsStore } from '@/stores/useSettingsStore'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TicketCreateModal } from './TicketCreateModal'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore } from '@/stores/useConnectionStore'

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

const quickLaunchTicket = vi.fn().mockResolvedValue(true)
const quickLaunchTicketOnConnection = vi.fn().mockResolvedValue(true)
vi.mock('./WorktreePickerModal', () => ({
  quickLaunchTicket: (...args: unknown[]) => quickLaunchTicket(...args),
  quickLaunchTicketOnConnection: (...args: unknown[]) => quickLaunchTicketOnConnection(...args)
}))

const createdTicket = { id: 't1', project_id: 'project-1', title: 'New', column: 'todo' }

describe('TicketCreateModal — Create & Send', () => {
  let createTicket: ReturnType<typeof vi.fn>
  let onOpenChange: ReturnType<typeof vi.fn>

  beforeEach(() => {
    createTicket = vi.fn().mockResolvedValue(createdTicket)
    onOpenChange = vi.fn()
    useKanbanStore.setState({ createTicket } as never)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    useConnectionStore.setState({ connections: [] } as never)
  })

  const typeTitle = (): void => {
    fireEvent.change(screen.getByTestId('ticket-title-input'), { target: { value: 'New' } })
  }

  it('renders both submit buttons with their shortcut hints', () => {
    render(<TicketCreateModal open onOpenChange={onOpenChange} projectId="project-1" />)
    const createBtn = screen.getByTestId('ticket-create-btn')
    const sendBtn = screen.getByTestId('ticket-create-send-btn')
    expect(createBtn.querySelector('kbd')?.textContent).toMatch(/↵|Enter/)
    expect(sendBtn.querySelector('kbd')?.textContent).toMatch(/⇧|Shift/)
    expect(createBtn.querySelector('kbd')?.textContent).not.toMatch(/⇧|Shift/)
    // Disabled until a title is entered
    expect(sendBtn).toBeDisabled()
    typeTitle()
    expect(sendBtn).not.toBeDisabled()
  })

  it('Create & Send creates the ticket, closes, then quick-launches it in a new worktree', async () => {
    render(<TicketCreateModal open onOpenChange={onOpenChange} projectId="project-1" />)
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-create-send-btn'))

    await waitFor(() => expect(quickLaunchTicket).toHaveBeenCalledWith(createdTicket))
    expect(createTicket).toHaveBeenCalledTimes(1)
    expect(createTicket.mock.calls[0][1]).toMatchObject({ title: 'New', column: 'todo' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(quickLaunchTicketOnConnection).not.toHaveBeenCalled()
  })

  it('routes Create & Send to the connection launcher on connection boards', async () => {
    useConnectionStore.setState({
      connections: [
        {
          id: 'conn-1',
          name: 'Conn',
          members: [{ project_id: 'project-1', project_name: 'Alpha' }]
        }
      ]
    } as never)
    render(
      <TicketCreateModal
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        connectionId="conn-1"
      />
    )
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-create-send-btn'))

    await waitFor(() =>
      expect(quickLaunchTicketOnConnection).toHaveBeenCalledWith(createdTicket, 'conn-1')
    )
    expect(quickLaunchTicket).not.toHaveBeenCalled()
  })

  it('saves a creation-time override before launching', async () => {
    useSettingsStore.setState({ autoReview: true, autoReviewTasks: {} })
    render(<TicketCreateModal open onOpenChange={onOpenChange} projectId="project-1" />)
    typeTitle()
    fireEvent.change(
      screen.getByLabelText('Automatically move to Review when the agent finishes'),
      {
        target: { value: 'false' }
      }
    )
    expect(useSettingsStore.getState().autoReviewTasks).toEqual({})
    fireEvent.click(screen.getByTestId('ticket-create-send-btn'))
    await waitFor(() => expect(quickLaunchTicket).toHaveBeenCalled())
    expect(useSettingsStore.getState().autoReviewTasks['["project-1","t1"]']).toBe(false)
  })

  it('plain Create never launches', async () => {
    render(<TicketCreateModal open onOpenChange={onOpenChange} projectId="project-1" />)
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-create-btn'))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(createTicket).toHaveBeenCalledTimes(1)
    expect(quickLaunchTicket).not.toHaveBeenCalled()
    expect(quickLaunchTicketOnConnection).not.toHaveBeenCalled()
  })

  it('Cmd+Enter creates only; Cmd+Shift+Enter creates and sends', async () => {
    const { unmount } = render(
      <TicketCreateModal open onOpenChange={onOpenChange} projectId="project-1" />
    )
    typeTitle()
    fireEvent.keyDown(screen.getByTestId('ticket-title-input'), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(createTicket).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(quickLaunchTicket).not.toHaveBeenCalled()
    unmount()
    vi.clearAllMocks()
    createTicket.mockResolvedValue(createdTicket)

    render(<TicketCreateModal open onOpenChange={onOpenChange} projectId="project-1" />)
    typeTitle()
    fireEvent.keyDown(screen.getByTestId('ticket-title-input'), {
      key: 'Enter',
      ctrlKey: true,
      shiftKey: true
    })
    await waitFor(() => expect(quickLaunchTicket).toHaveBeenCalledWith(createdTicket))
    expect(createTicket).toHaveBeenCalledTimes(1)
  })

  it('does not launch when creation fails', async () => {
    createTicket.mockRejectedValue(new Error('boom'))
    render(<TicketCreateModal open onOpenChange={onOpenChange} projectId="project-1" />)
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-create-send-btn'))

    await waitFor(() => expect(createTicket).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('ticket-create-send-btn')).not.toBeDisabled())
    expect(quickLaunchTicket).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
