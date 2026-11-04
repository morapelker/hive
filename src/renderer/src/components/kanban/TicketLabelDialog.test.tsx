/**
 * The "New label" / "One-off label" dialog: a saved label joins the catalog and goes on the
 * ticket; a one-off goes on the ticket only (never into the catalog). A name already on the
 * ticket is refused, and a name the catalog already has is offered for reuse instead of being
 * created twice. "Edit one-off label" is the same dialog, prefilled, changing a one-off in place.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { KanbanTicket } from '../../../../main/db/types'
import {
  TICKET_LABELS_MAX,
  type SavedTicketLabel,
  type SavedTicketLabelCreate,
  type TicketLabel
} from '@shared/lib/ticket-labels'
import type { TicketLabelWriteOutcome } from '@/lib/ticket-label-toggle'

vi.mock('@/lib/ticket-label-toggle', () => ({
  setTicketLabel: vi.fn(async (): Promise<TicketLabelWriteOutcome> => 'applied'),
  editTicketLabel: vi.fn(async (): Promise<TicketLabelWriteOutcome> => 'applied')
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

import { TicketLabelDialog } from './TicketLabelDialog'
import { editTicketLabel, setTicketLabel } from '@/lib/ticket-label-toggle'
import { toast } from '@/lib/toast'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useTicketLabelsStore } from '@/stores/useTicketLabelsStore'

const initialKanbanState = useKanbanStore.getState()
const initialLabelsState = useTicketLabelsStore.getState()

const now = '2026-01-01T00:00:00.000Z'
const ref = { projectId: 'project-1', ticketId: 'ticket-1' }

function savedLabel(id: string, name: string, color: string, sortOrder: number): SavedTicketLabel {
  return { id, name, color, sort_order: sortOrder, created_at: now, updated_at: now }
}

const joySaved = savedLabel('lbl-joy', 'Waiting for Joy', 'yellow', 0)
const blockedSaved = savedLabel('lbl-blocked', 'Blocked', 'red', 1)
const until: TicketLabel = { id: 'once-1', kind: 'once', name: 'Waiting until 21/10', color: 'gray' }

function seedTicket(labels: TicketLabel[]): void {
  const ticket = {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Add dark mode toggle',
    labels
  } as KanbanTicket
  useKanbanStore.setState({ tickets: new Map([['project-1', [ticket]]]) })
}

function openDialog(mode: 'saved' | 'once', create = vi.fn()): ReturnType<typeof vi.fn> {
  useTicketLabelsStore.setState({
    labels: [joySaved, blockedSaved],
    loaded: true,
    dialog: { kind: 'create', ...ref, mode },
    create
  } as never)
  render(<TicketLabelDialog />)
  return create
}

function openEditDialog(labelId = until.id): void {
  useTicketLabelsStore.setState({
    labels: [joySaved, blockedSaved],
    loaded: true,
    dialog: { kind: 'edit', ...ref, labelId }
  } as never)
  render(<TicketLabelDialog />)
}

const input = (): HTMLInputElement => screen.getByTestId('ticket-label-name-input') as HTMLInputElement
const submit = (): HTMLElement => screen.getByTestId('ticket-label-submit')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useKanbanStore.setState(initialKanbanState, true)
  useTicketLabelsStore.setState(initialLabelsState, true)
})

describe('TicketLabelDialog', () => {
  it('creates a saved label, then puts it on the ticket', async () => {
    seedTicket([until])
    const create = openDialog(
      'saved',
      vi.fn(async (data: SavedTicketLabelCreate) => savedLabel('lbl-new', data.name, data.color, 2))
    )

    expect(screen.getByText('New label')).toBeInTheDocument()
    expect(screen.getByText('Add dark mode toggle')).toBeInTheDocument()
    expect(screen.getByTestId('ticket-label-save-checkbox')).toHaveAttribute('aria-checked', 'true')
    // The catalog uses yellow and red: the least used colour after gray comes first
    expect(screen.getByTestId('ticket-label-color-orange')).toHaveAttribute('aria-checked', 'true')
    expect(submit()).toBeDisabled()

    fireEvent.change(input(), { target: { value: '  Needs   design ' } })
    expect(screen.getByText('17/32')).toBeInTheDocument()
    fireEvent.keyDown(input(), { key: 'Enter' })

    await waitFor(() => expect(setTicketLabel).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith({ name: 'Needs design', color: 'orange' })
    expect(setTicketLabel).toHaveBeenCalledWith(
      ref,
      { id: 'lbl-new', kind: 'saved', name: 'Needs design', color: 'orange' },
      true,
      []
    )
    await waitFor(() => expect(screen.queryByTestId('ticket-label-dialog')).toBeNull())
    expect(useTicketLabelsStore.getState().dialog).toBeNull()
  })

  it('puts a one-off on the ticket without touching the catalog', async () => {
    seedTicket([])
    const create = openDialog('once')

    expect(screen.getByText('One-off label')).toBeInTheDocument()
    expect(screen.getByText(/Only on this ticket\. Once removed, it.s gone for good\./)).toBeInTheDocument()
    expect(screen.getByTestId('ticket-label-save-checkbox')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('ticket-label-color-gray')).toHaveAttribute('aria-checked', 'true')

    fireEvent.change(input(), { target: { value: 'Waiting until 21/10' } })
    fireEvent.click(screen.getByTestId('ticket-label-color-teal'))
    fireEvent.click(submit())

    await waitFor(() => expect(setTicketLabel).toHaveBeenCalledTimes(1))
    expect(create).not.toHaveBeenCalled()
    const [target, label, on] = vi.mocked(setTicketLabel).mock.calls[0]
    expect(target).toEqual(ref)
    expect(on).toBe(true)
    expect(label).toEqual({
      id: expect.any(String),
      kind: 'once',
      name: 'Waiting until 21/10',
      color: 'teal'
    })
    expect(label.id).not.toBe('')
  })

  it('switches between saved and one-off in place', () => {
    seedTicket([])
    openDialog('once')

    fireEvent.click(screen.getByTestId('ticket-label-save-checkbox'))
    expect(screen.getByText('New label')).toBeInTheDocument()
    expect(screen.queryByText(/Only on this ticket/)).toBeNull()
    expect(input()).toHaveAttribute('placeholder', 'e.g. Waiting for Joy')
  })

  it('offers the saved label of the same name instead of creating a duplicate', async () => {
    seedTicket([])
    const create = openDialog('saved')

    fireEvent.change(input(), { target: { value: 'waiting FOR joy' } })
    expect(screen.getByTestId('ticket-label-saved-match')).toHaveTextContent('already exists')
    expect(submit()).toBeDisabled()

    fireEvent.click(screen.getByText('Apply it'))
    await waitFor(() => expect(setTicketLabel).toHaveBeenCalledTimes(1))
    expect(create).not.toHaveBeenCalled()
    expect(setTicketLabel).toHaveBeenCalledWith(
      ref,
      { id: 'lbl-joy', kind: 'saved', name: 'Waiting for Joy', color: 'yellow' },
      true,
      []
    )
  })

  it('lets a one-off share a saved name, offering the saved one too', () => {
    seedTicket([])
    openDialog('once')

    fireEvent.change(input(), { target: { value: 'blocked' } })
    expect(screen.getByTestId('ticket-label-saved-match')).toHaveTextContent('Matches saved label')
    expect(screen.getByText('Apply saved label')).toBeInTheDocument()
    expect(submit()).toBeEnabled()
  })

  it('refuses a name already on the ticket', () => {
    seedTicket([until])
    const create = openDialog('saved')

    fireEvent.change(input(), { target: { value: ' WAITING until 21/10 ' } })
    expect(screen.getByTestId('ticket-label-on-ticket')).toHaveTextContent('Already on this ticket')
    expect(submit()).toBeDisabled()
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(create).not.toHaveBeenCalled()
    expect(setTicketLabel).not.toHaveBeenCalled()
  })

  it('shows a create failure inline and stays open', async () => {
    seedTicket([])
    openDialog(
      'saved',
      vi.fn(async () => {
        throw new Error('A label named "Needs design" already exists')
      })
    )

    fireEvent.change(input(), { target: { value: 'Needs design' } })
    fireEvent.click(submit())

    expect(await screen.findByTestId('ticket-label-error')).toHaveTextContent(
      'A label named "Needs design" already exists'
    )
    expect(setTicketLabel).not.toHaveBeenCalled()
    expect(screen.getByTestId('ticket-label-dialog')).toBeInTheDocument()
  })

  it('keeps a one-off it could not write, open with an inline error', async () => {
    seedTicket([])
    openDialog('once')
    vi.mocked(setTicketLabel).mockResolvedValueOnce('failed')

    fireEvent.change(input(), { target: { value: 'Waiting until 21/10' } })
    fireEvent.click(screen.getByTestId('ticket-label-color-teal'))
    fireEvent.click(submit())

    expect(await screen.findByTestId('ticket-label-error')).toHaveTextContent(
      "Couldn't add the label. Try again."
    )
    // Nothing typed is lost: the name, the colour and the mode are as they were
    expect(useTicketLabelsStore.getState().dialog).not.toBeNull()
    expect(input().value).toBe('Waiting until 21/10')
    expect(screen.getByTestId('ticket-label-color-teal')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('ticket-label-save-checkbox')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(submit()).toBeEnabled()

    // A retry that lands closes the dialog
    fireEvent.click(submit())
    await waitFor(() => expect(useTicketLabelsStore.getState().dialog).toBeNull())
    expect(setTicketLabel).toHaveBeenCalledTimes(2)
  })

  it('says a saved label was saved but not added, and offers it for the retry', async () => {
    seedTicket([])
    const create = vi.fn(async (data: SavedTicketLabelCreate) => {
      const created = savedLabel('lbl-new', data.name, data.color, 2)
      // As the real store does: the catalog has the label once it is created
      useTicketLabelsStore.setState((state) => ({ labels: [...state.labels, created] }))
      return created
    })
    openDialog('saved', create)
    vi.mocked(setTicketLabel).mockResolvedValueOnce('failed')

    fireEvent.change(input(), { target: { value: 'Needs design' } })
    fireEvent.click(submit())

    expect(await screen.findByTestId('ticket-label-error')).toHaveTextContent(
      'The label was saved, but not added to this ticket. Try again.'
    )
    expect(useTicketLabelsStore.getState().dialog).not.toBeNull()
    // The name now matches the catalog: the retry applies the saved label, not a second one
    expect(screen.getByTestId('ticket-label-saved-match')).toHaveTextContent('already exists')
    expect(submit()).toBeDisabled()
    fireEvent.click(screen.getByTestId('ticket-label-apply-saved'))

    await waitFor(() => expect(useTicketLabelsStore.getState().dialog).toBeNull())
    expect(create).toHaveBeenCalledTimes(1)
    expect(setTicketLabel).toHaveBeenLastCalledWith(
      ref,
      { id: 'lbl-new', kind: 'saved', name: 'Needs design', color: 'orange' },
      true,
      []
    )
  })

  it('stays open with the reason when the ticket filled up before the label went on', async () => {
    seedTicket([])
    openDialog('once')
    const fill: TicketLabel[] = Array.from({ length: TICKET_LABELS_MAX }, (_, index) => ({
      id: `once-${index}`,
      kind: 'once',
      name: `Label ${index}`,
      color: 'gray'
    }))
    // Labels ticked from the menu meanwhile fill the ticket before the dialog's turn comes
    vi.mocked(setTicketLabel).mockImplementationOnce(async () => {
      seedTicket(fill)
      return 'unchanged'
    })

    fireEvent.change(input(), { target: { value: 'Waiting until 21/10' } })
    fireEvent.click(submit())

    expect(await screen.findByTestId('ticket-label-error')).toHaveTextContent(
      `This ticket already has ${TICKET_LABELS_MAX} labels, the most it can carry.`
    )
    expect(useTicketLabelsStore.getState().dialog).not.toBeNull()
    expect(input().value).toBe('Waiting until 21/10')
  })

  it('closes when the label turns out to be on the ticket already', async () => {
    seedTicket([])
    openDialog('saved')
    // Ticked from the menu meanwhile: the dialog's own write has nothing left to do
    vi.mocked(setTicketLabel).mockImplementationOnce(async (_ref, label) => {
      seedTicket([label])
      return 'unchanged'
    })

    fireEvent.change(input(), { target: { value: 'Blocked' } })
    fireEvent.click(screen.getByTestId('ticket-label-apply-saved'))

    await waitFor(() => expect(useTicketLabelsStore.getState().dialog).toBeNull())
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('closes with a toast when the ticket is gone before the label went on', async () => {
    seedTicket([])
    openDialog('once')
    vi.mocked(setTicketLabel).mockImplementationOnce(async () => {
      useKanbanStore.setState({ tickets: new Map([['project-1', []]]) })
      return 'unchanged'
    })

    fireEvent.change(input(), { target: { value: 'Waiting until 21/10' } })
    fireEvent.click(submit())

    await waitFor(() => expect(useTicketLabelsStore.getState().dialog).toBeNull())
    expect(toast.error).toHaveBeenCalledWith("The ticket is gone, so the label wasn't added")
  })

  it('ignores Enter that confirms an IME candidate', () => {
    seedTicket([])
    const create = openDialog('saved')

    fireEvent.change(input(), { target: { value: '待ち' } })
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 })

    expect(create).not.toHaveBeenCalled()
  })

  describe('editing a one-off', () => {
    const teal: TicketLabel = { ...until, color: 'teal' }

    it('opens prefilled, with only what editing needs', () => {
      seedTicket([teal])
      openEditDialog()

      expect(screen.getByText('Edit one-off label')).toBeInTheDocument()
      expect(input().value).toBe('Waiting until 21/10')
      expect(screen.getByTestId('ticket-label-color-teal')).toHaveAttribute('aria-checked', 'true')
      expect(submit()).toHaveTextContent('Save')
      expect(screen.queryByTestId('ticket-label-save-checkbox')).toBeNull()
    })

    it('writes the new name and colour under the same id', async () => {
      seedTicket([teal])
      openEditDialog()

      fireEvent.change(input(), { target: { value: '  Waiting until   22/10 ' } })
      fireEvent.click(screen.getByTestId('ticket-label-color-red'))
      fireEvent.click(submit())

      await waitFor(() => expect(useTicketLabelsStore.getState().dialog).toBeNull())
      expect(editTicketLabel).toHaveBeenCalledWith(ref, {
        id: 'once-1',
        kind: 'once',
        name: 'Waiting until 22/10',
        color: 'red'
      })
      expect(setTicketLabel).not.toHaveBeenCalled()
    })

    it('closes without a write when nothing changed', async () => {
      seedTicket([teal])
      openEditDialog()

      fireEvent.keyDown(input(), { key: 'Enter' })

      await waitFor(() => expect(useTicketLabelsStore.getState().dialog).toBeNull())
      expect(editTicketLabel).not.toHaveBeenCalled()
    })

    it('allows a change of case alone', async () => {
      seedTicket([teal])
      openEditDialog()

      fireEvent.change(input(), { target: { value: 'WAITING until 21/10' } })
      expect(screen.queryByTestId('ticket-label-on-ticket')).toBeNull()
      fireEvent.click(submit())

      await waitFor(() => expect(editTicketLabel).toHaveBeenCalledTimes(1))
      expect(vi.mocked(editTicketLabel).mock.calls[0][1].name).toBe('WAITING until 21/10')
    })

    it('refuses the name of another label on the ticket', () => {
      seedTicket([{ id: 'lbl-joy', kind: 'saved', name: 'Waiting for Joy', color: 'yellow' }, teal])
      openEditDialog()

      fireEvent.change(input(), { target: { value: 'waiting for joy' } })

      expect(screen.getByTestId('ticket-label-on-ticket')).toBeInTheDocument()
      expect(submit()).toBeDisabled()
    })

    it('recolours a one-off that shares its name with another label', async () => {
      // A catalog rename can leave a saved label and a one-off of one name on a ticket
      seedTicket([{ id: 'lbl-x', kind: 'saved', name: until.name, color: 'yellow' }, teal])
      openEditDialog()

      expect(screen.queryByTestId('ticket-label-on-ticket')).toBeNull()
      fireEvent.click(screen.getByTestId('ticket-label-color-red'))
      fireEvent.click(submit())

      await waitFor(() => expect(editTicketLabel).toHaveBeenCalledTimes(1))
    })

    it('can be edited on a full ticket', () => {
      const others: TicketLabel[] = Array.from({ length: TICKET_LABELS_MAX - 1 }, (_, index) => ({
        id: `other-${index}`,
        kind: 'once',
        name: `Label ${index}`,
        color: 'gray'
      }))
      seedTicket([...others, teal])
      openEditDialog()

      fireEvent.change(input(), { target: { value: 'Waiting until 22/10' } })
      expect(screen.queryByText(/the most it can carry/)).toBeNull()
      expect(submit()).toBeEnabled()
    })

    it('does not offer a saved label of the new name in place of the one-off', () => {
      seedTicket([teal])
      openEditDialog()

      fireEvent.change(input(), { target: { value: 'Blocked' } })

      expect(screen.queryByTestId('ticket-label-saved-match')).toBeNull()
      expect(submit()).toBeEnabled()
    })

    it('keeps a colour this build does not know unless a swatch is picked', async () => {
      seedTicket([{ ...until, color: 'magenta' }])
      openEditDialog()

      expect(screen.getByTestId('ticket-label-color-gray')).toHaveAttribute('aria-checked', 'true')
      fireEvent.change(input(), { target: { value: 'Waiting until 22/10' } })
      fireEvent.click(submit())

      await waitFor(() => expect(editTicketLabel).toHaveBeenCalledTimes(1))
      expect(vi.mocked(editTicketLabel).mock.calls[0][1].color).toBe('magenta')
    })

    it('stays open with what was typed when the write fails', async () => {
      seedTicket([teal])
      openEditDialog()
      vi.mocked(editTicketLabel).mockResolvedValueOnce('failed')

      fireEvent.change(input(), { target: { value: 'Waiting until 22/10' } })
      fireEvent.click(submit())

      expect(await screen.findByTestId('ticket-label-error')).toHaveTextContent(
        "Couldn't update the label. Try again."
      )
      expect(input().value).toBe('Waiting until 22/10')
      expect(useTicketLabelsStore.getState().dialog).not.toBeNull()
    })

    it('closes when a write reported failed turns out to have landed', async () => {
      seedTicket([teal])
      openEditDialog()
      vi.mocked(editTicketLabel).mockImplementationOnce(async (_ref, label) => {
        seedTicket([label])
        return 'failed'
      })

      fireEvent.change(input(), { target: { value: 'Waiting until 22/10' } })
      fireEvent.click(submit())

      await waitFor(() => expect(useTicketLabelsStore.getState().dialog).toBeNull())
    })

    it('closes with a toast when the label is gone before the edit went on', async () => {
      seedTicket([teal])
      openEditDialog()
      vi.mocked(editTicketLabel).mockImplementationOnce(async () => {
        seedTicket([])
        return 'unchanged'
      })

      fireEvent.change(input(), { target: { value: 'Waiting until 22/10' } })
      fireEvent.click(submit())

      await waitFor(() => expect(useTicketLabelsStore.getState().dialog).toBeNull())
      expect(toast.error).toHaveBeenCalledWith("The label is gone, so it wasn't changed")
    })

    it('never edits a saved label', () => {
      seedTicket([{ id: 'lbl-joy', kind: 'saved', name: 'Waiting for Joy', color: 'yellow' }])
      openEditDialog('lbl-joy')

      expect(screen.queryByTestId('ticket-label-dialog')).toBeNull()
    })
  })
})
