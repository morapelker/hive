// The modal opened for a branch that is already picked (a run's, from its dashboard): one way
// out besides Cancel, the ticket goes to that branch, and everything else is the normal modal.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerState } from '@shared/remote-access/peer-protocol'

const launches = vi.hoisted(() => ({
  quickLaunchTicket: vi.fn(),
  quickLaunchTicketOnConnection: vi.fn()
}))
const remote = vi.hoisted(() => ({ createRemoteTicket: vi.fn(), moveRemoteTicket: vi.fn() }))
const deleteImage = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('./WorktreePickerModal', () => launches)
vi.mock('@/lib/peers/remote-ticket-actions', () => remote)
vi.mock('@/lib/peers/run-sync', () => ({ runPeerSync: vi.fn() }))
vi.mock('@/api/attachment-api', () => ({ attachmentApi: { deleteImage } }))
vi.mock('@/api/file-api', () => ({
  fileApi: { readImageAsBase64: vi.fn(async () => ({ success: false })) }
}))
vi.mock('@/stores/usePeerStore', async () => {
  const { create } = await import('zustand')
  return { usePeerStore: create<{ peers: PeerState[] }>(() => ({ peers: [] })) }
})

import { TicketCreateModal, writeCreateTicketTarget } from './TicketCreateModal'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePeerStore } from '@/stores/usePeerStore'

const PEER = {
  desktopId: 'desk-b',
  desktopName: 'Studio Mac',
  paired: true,
  link: 'live',
  executorOnline: true
} as PeerState

const created = { id: 't1', project_id: 'project-1', title: 'New', column: 'todo' }
const IMAGE = { type: 'image' as const, url: '/attachments/shot.png', label: 'shot.png' }
const PREFILL = { title: '', description: '', attachments: [IMAGE] }

describe('TicketCreateModal — opened for a branch', () => {
  let createTicket: ReturnType<typeof vi.fn>
  let onOpenChange: ReturnType<typeof vi.fn>
  let send: ReturnType<typeof vi.fn>

  const renderForBranch = (
    extra: Partial<React.ComponentProps<typeof TicketCreateModal>> = {}
  ): ReturnType<typeof render> =>
    render(
      <TicketCreateModal
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        sendTo={{ branch: 'doc-checkout', send }}
        {...extra}
      />
    )
  const typeTitle = (): void => {
    fireEvent.change(screen.getByTestId('ticket-title-input'), { target: { value: 'New' } })
  }

  beforeEach(() => {
    createTicket = vi.fn().mockResolvedValue(created)
    onOpenChange = vi.fn()
    send = vi.fn()
    useKanbanStore.setState({ createTicket } as never)
    usePeerStore.setState({ peers: [] })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('offers Cancel and Create & Send only, and names the branch', () => {
    renderForBranch()

    expect(screen.getByTestId('ticket-cancel-btn')).toBeInTheDocument()
    expect(screen.getByTestId('ticket-create-send-btn')).toHaveTextContent('Create & Send')
    expect(screen.queryByTestId('ticket-create-btn')).toBeNull()
    expect(screen.getByTestId('ticket-create-send-branch')).toHaveTextContent('doc-checkout')
    expect(screen.getByTestId('ticket-create-send-btn')).toBeDisabled()
  })

  it('still has the normal form, attachments included', () => {
    renderForBranch()

    expect(screen.getByTestId('ticket-title-input')).toBeInTheDocument()
    expect(screen.getByTestId('ticket-description-input')).toBeInTheDocument()
    expect(screen.getByTestId('ticket-create-modal')).toHaveTextContent(/attach/i)
  })

  it('creates a To Do ticket with its attachments, closes, then sends it to the branch', async () => {
    renderForBranch({ prefill: PREFILL })
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-create-send-btn'))

    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith(created))
    expect(createTicket.mock.calls[0]).toEqual([
      'project-1',
      {
        project_id: 'project-1',
        title: 'New',
        description: null,
        attachments: [{ type: 'image', url: '/attachments/shot.png', label: 'shot.png' }],
        column: 'todo'
      }
    ])
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(launches.quickLaunchTicket).not.toHaveBeenCalled()
    expect(launches.quickLaunchTicketOnConnection).not.toHaveBeenCalled()
  })

  it.each([
    ['Cmd+Enter', { metaKey: true }],
    ['Cmd+Shift+Enter', { metaKey: true, shiftKey: true }]
  ])('%s sends: there is nothing else to do', async (_label, keys) => {
    renderForBranch()
    typeTitle()
    fireEvent.keyDown(screen.getByTestId('ticket-title-input'), { key: 'Enter', ...keys })

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })

  it('shows the plain submit shortcut on its only action', () => {
    renderForBranch()
    expect(screen.getByTestId('ticket-create-send-btn').querySelector('kbd')?.textContent).not.toMatch(
      /⇧|Shift/
    )
  })

  it('sends nothing when the ticket could not be created, and stays open', async () => {
    createTicket.mockRejectedValue(new Error('nope'))
    renderForBranch()
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-create-send-btn'))

    await waitFor(() => expect(createTicket).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('ticket-create-send-btn')).toBeEnabled())
    expect(send).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('offers no other Mac, and a remembered one does not take the ticket', async () => {
    usePeerStore.setState({ peers: [PEER] })
    writeCreateTicketTarget('project-1', 'desk-b')
    renderForBranch()

    expect(screen.queryByTestId('ticket-create-target')).toBeNull()
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-create-send-btn'))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(remote.createRemoteTicket).not.toHaveBeenCalled()
  })

  it('leaves the remembered Mac for the next normal ticket', async () => {
    writeCreateTicketTarget('project-1', 'desk-b')
    renderForBranch()
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-create-send-btn'))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(window.localStorage.getItem('tedooo-code:create-ticket-target:project-1')).toBe('desk-b')
  })

  it('asks before discarding a typed ticket, like the normal modal', () => {
    renderForBranch()
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-cancel-btn'))

    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps a sent ticket’s image, and deletes a cancelled one’s', async () => {
    const { rerender } = renderForBranch({ prefill: PREFILL })
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-create-send-btn'))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))

    rerender(
      <TicketCreateModal
        open={false}
        onOpenChange={onOpenChange}
        projectId="project-1"
        sendTo={{ branch: 'doc-checkout', send }}
      />
    )
    expect(deleteImage).not.toHaveBeenCalled()
    cleanup()

    const cancelled = renderForBranch({ prefill: PREFILL })
    await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument())
    cancelled.rerender(
      <TicketCreateModal
        open={false}
        onOpenChange={onOpenChange}
        projectId="project-1"
        sendTo={{ branch: 'doc-checkout', send }}
      />
    )
    expect(deleteImage).toHaveBeenCalledExactlyOnceWith('/attachments/shot.png')
  })

  it('keeps Tab and Shift+Tab for its own fields, over the session behind the dashboard', () => {
    renderForBranch()
    expect(screen.getByTestId('ticket-create-modal')).toHaveAttribute('data-tab-navigates')
  })

  it('gives the focus back to the form after Keep editing', async () => {
    renderForBranch()
    typeTitle()
    fireEvent.click(screen.getByTestId('ticket-cancel-btn'))
    fireEvent.click(await screen.findByTestId('ticket-discard-keep-editing-btn'))

    await waitFor(() => expect(screen.getByTestId('ticket-title-input')).toHaveFocus())
  })

  it('hands the closing focus to the caller', () => {
    const onCloseAutoFocus = vi.fn()
    const { rerender } = renderForBranch({ onCloseAutoFocus })
    rerender(
      <TicketCreateModal
        open={false}
        onOpenChange={onOpenChange}
        projectId="project-1"
        sendTo={{ branch: 'doc-checkout', send }}
        onCloseAutoFocus={onCloseAutoFocus}
      />
    )
    return waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledTimes(1))
  })

  it('leaves the three-button modal alone without a branch', () => {
    render(<TicketCreateModal open onOpenChange={onOpenChange} projectId="project-1" />)

    expect(screen.getByTestId('ticket-create-btn')).toBeInTheDocument()
    expect(screen.getByTestId('ticket-create-send-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('ticket-create-send-branch')).toBeNull()
    expect(screen.getByTestId('ticket-create-modal')).not.toHaveAttribute('data-tab-navigates')
  })
})
