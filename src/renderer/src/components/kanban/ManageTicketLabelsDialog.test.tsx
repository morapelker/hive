/**
 * "Manage labels…": the saved catalog for every project on this Mac. A rename saves on Enter
 * (once, even with the blur that follows) and a clash is shown then reverted; deleting a label
 * that tickets carry asks first, in the row, with the number of tickets it comes off — counts
 * that follow the catalog, and are asked again before a label is deleted unasked. In the
 * colour popover the arrow keys browse and only a click / Enter / Space saves.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SavedTicketLabel, SavedTicketLabelUpdate } from '@shared/lib/ticket-labels'

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

import { ManageTicketLabelsDialog } from './ManageTicketLabelsDialog'
import { useTicketLabelsStore } from '@/stores/useTicketLabelsStore'

const initialLabelsState = useTicketLabelsStore.getState()

// The colour popover is positioned by floating-ui, which probes `:popover-open` and `:modal`.
// jsdom's selector engine takes seconds over each probe; floating-ui reads a throw as "not in
// the top layer", which is the answer here anyway.
const nativeMatches = Element.prototype.matches
beforeAll(() => {
  Element.prototype.matches = function (this: Element, selector: string): boolean {
    if (selector === ':popover-open' || selector === ':modal') {
      throw new SyntaxError(`Unsupported selector ${selector}`)
    }
    return nativeMatches.call(this, selector)
  }
})
afterAll(() => {
  Element.prototype.matches = nativeMatches
})

const now = '2026-01-01T00:00:00.000Z'

function savedLabel(id: string, name: string, color: string, sortOrder: number): SavedTicketLabel {
  return { id, name, color, sort_order: sortOrder, created_at: now, updated_at: now }
}

const joySaved = savedLabel('lbl-joy', 'Waiting for Joy', 'yellow', 0)
const blockedSaved = savedLabel('lbl-blocked', 'Blocked', 'red', 1)
const importedSaved = savedLabel('lbl-imported', 'Needs review', 'blue', 2)

/** A label that joins the catalog from elsewhere (a db:changed reload of the store). */
function addToCatalog(label: SavedTicketLabel): void {
  act(() => {
    useTicketLabelsStore.setState((state) => ({ labels: [...state.labels, label] }))
  })
}

/** The store's catalog actions, applied to its list as the real (optimistic) ones are. */
function openManage(overrides: Record<string, unknown> = {}) {
  const actions = {
    update: vi.fn(async (id: string, data: SavedTicketLabelUpdate) => {
      useTicketLabelsStore.setState((state) => ({
        labels: state.labels.map((label) => (label.id === id ? { ...label, ...data } : label))
      }))
    }),
    remove: vi.fn(async (id: string) => {
      useTicketLabelsStore.setState((state) => ({
        labels: state.labels.filter((label) => label.id !== id)
      }))
    }),
    reorder: vi.fn(async () => undefined),
    usage: vi.fn(async (): Promise<Record<string, number>> => ({ 'lbl-joy': 3 })),
    create: vi.fn(),
    ...overrides
  }
  useTicketLabelsStore.setState({
    labels: [joySaved, blockedSaved],
    loaded: true,
    dialog: { kind: 'manage' },
    ...actions
  } as never)
  render(<ManageTicketLabelsDialog />)
  return actions
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useTicketLabelsStore.setState(initialLabelsState, true)
})

describe('ManageTicketLabelsDialog', () => {
  it('lists the catalog in order with how many tickets carry each label', async () => {
    openManage()

    expect(screen.getByText('Labels')).toBeInTheDocument()
    expect(screen.getByText('Shown on cards only, never sent to the model.')).toBeInTheDocument()
    expect(await screen.findByText('3 tickets')).toBeInTheDocument()
    expect(screen.getByTestId('manage-label-usage-lbl-blocked')).toHaveTextContent('0 tickets')
    const joyRow = screen.getByTestId('manage-label-row-lbl-joy')
    const blockedRow = screen.getByTestId('manage-label-row-lbl-blocked')
    expect(joyRow.compareDocumentPosition(blockedRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('manage-label-up-lbl-joy')).toBeDisabled()
    expect(screen.getByTestId('manage-label-down-lbl-blocked')).toBeDisabled()
  })

  it('renames on Enter, once', async () => {
    const { update } = openManage()
    const name = screen.getByTestId('manage-label-name-lbl-joy') as HTMLInputElement

    fireEvent.change(name, { target: { value: '  Waiting on Joy ' } })
    // The chip previews the new name as it is typed
    expect(within(screen.getByTestId('manage-label-row-lbl-joy')).getByTestId('ticket-label-chip'))
      .toHaveTextContent('Waiting on Joy')
    fireEvent.keyDown(name, { key: 'Enter' })
    fireEvent.blur(name)

    await waitFor(() => expect(name.value).toBe('Waiting on Joy'))
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('lbl-joy', { name: 'Waiting on Joy' })
  })

  it('shows a name clash and reverts the name', async () => {
    const { update } = openManage({
      update: vi.fn(async () => {
        throw new Error('A label named "Blocked" already exists')
      })
    })
    const name = screen.getByTestId('manage-label-name-lbl-joy') as HTMLInputElement

    fireEvent.change(name, { target: { value: 'blocked' } })
    fireEvent.blur(name)

    expect(await screen.findByTestId('manage-label-error-lbl-joy')).toHaveTextContent(
      'A label named "Blocked" already exists'
    )
    expect(name.value).toBe('Waiting for Joy')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('reverts an edit on Escape without closing the dialog', async () => {
    const { update } = openManage()
    await screen.findByText('3 tickets')
    const name = screen.getByTestId('manage-label-name-lbl-joy') as HTMLInputElement

    fireEvent.change(name, { target: { value: 'Something else' } })
    fireEvent.keyDown(name, { key: 'Escape' })

    expect(name.value).toBe('Waiting for Joy')
    expect(screen.getByTestId('manage-ticket-labels-dialog')).toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })

  it('asks before deleting a label tickets carry, with the count', async () => {
    const { remove, usage } = openManage()
    await screen.findByText('3 tickets')

    fireEvent.click(screen.getByTestId('manage-label-delete-lbl-joy'))
    const confirm = screen.getByTestId('manage-label-confirm-lbl-joy')
    expect(confirm).toHaveTextContent('Remove')
    expect(confirm).toHaveTextContent('from 3 tickets and delete it?')
    expect(within(confirm).getByTestId('ticket-label-chip')).toHaveTextContent('Waiting for Joy')
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('manage-label-confirm-delete-lbl-joy'))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('lbl-joy'))
    await waitFor(() => expect(screen.queryByTestId('manage-label-row-lbl-joy')).toBeNull())
    // The counts are fetched again after a delete
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(2))
  })

  it('deletes an unused label straight away', async () => {
    const { remove } = openManage()
    await screen.findByText('3 tickets')

    fireEvent.click(screen.getByTestId('manage-label-delete-lbl-blocked'))

    await waitFor(() => expect(remove).toHaveBeenCalledWith('lbl-blocked'))
    expect(screen.queryByTestId('manage-label-confirm-lbl-blocked')).toBeNull()
  })

  it('fetches the counts again when a label joins the catalog from elsewhere', async () => {
    const { usage } = openManage()
    await screen.findByText('3 tickets')
    expect(usage).toHaveBeenCalledTimes(1)

    // E.g. a ticket moved in from another Mac brought a saved label this Mac lacked
    usage.mockResolvedValue({ 'lbl-joy': 3, 'lbl-imported': 1 })
    addToCatalog(importedSaved)

    await waitFor(() =>
      expect(screen.getByTestId('manage-label-usage-lbl-imported')).toHaveTextContent('1 ticket')
    )
    expect(usage).toHaveBeenCalledTimes(2)
  })

  it('treats a label the counts have not seen yet as unknown, and asks before deleting it', async () => {
    const { usage, remove } = openManage()
    await screen.findByText('3 tickets')

    // The fresh count has not come back yet
    usage.mockImplementation(() => new Promise<Record<string, number>>(() => {}))
    addToCatalog(importedSaved)

    expect(screen.getByTestId('manage-label-usage-lbl-imported')).toHaveTextContent('…')
    fireEvent.click(screen.getByTestId('manage-label-delete-lbl-imported'))

    expect(screen.getByTestId('manage-label-confirm-lbl-imported')).toHaveTextContent(
      'from every ticket and delete it?'
    )
    expect(remove).not.toHaveBeenCalled()
  })

  it('asks the DB again before deleting a label shown as unused', async () => {
    const { usage, remove } = openManage()
    await screen.findByText('3 tickets')
    expect(screen.getByTestId('manage-label-usage-lbl-blocked')).toHaveTextContent('0 tickets')

    // Another window put the label on two tickets since the counts were fetched
    usage.mockResolvedValue({ 'lbl-joy': 3, 'lbl-blocked': 2 })
    fireEvent.click(screen.getByTestId('manage-label-delete-lbl-blocked'))

    expect(await screen.findByTestId('manage-label-confirm-lbl-blocked')).toHaveTextContent(
      'from 2 tickets and delete it?'
    )
    expect(usage).toHaveBeenCalledTimes(2)
    expect(remove).not.toHaveBeenCalled()
  })

  it('opens with the focus on the dialog itself, not its first button', async () => {
    openManage()

    const dialog = screen.getByTestId('manage-ticket-labels-dialog')
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    expect(screen.getByTestId('manage-label-down-lbl-joy')).not.toHaveFocus()
  })

  it('browses colours with the arrow keys, saving only the one chosen', async () => {
    const { update } = openManage()
    await screen.findByText('3 tickets')

    // The popover opens with the focus on the saved colour
    fireEvent.click(screen.getByTestId('manage-label-color-lbl-joy'))
    const yellow = await screen.findByTestId('manage-label-swatch-lbl-joy-yellow')
    await waitFor(() => expect(yellow).toHaveFocus())

    fireEvent.keyDown(yellow, { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByTestId('manage-label-swatch-lbl-joy-green'), {
      key: 'ArrowRight'
    })

    // Browsing writes nothing and keeps the popover open
    const teal = screen.getByTestId('manage-label-swatch-lbl-joy-teal')
    expect(teal).toHaveAttribute('aria-checked', 'true')
    expect(teal).toHaveFocus()
    expect(update).not.toHaveBeenCalled()

    // Enter on the focused swatch chooses it: one write, and the popover closes
    await userEvent.setup().keyboard('{Enter}')

    await waitFor(() => expect(screen.queryByTestId('manage-label-swatch-lbl-joy-teal')).toBeNull())
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('lbl-joy', { color: 'teal' })
  })

  it('drops a colour browsed to but not chosen when the popover closes', async () => {
    const { update } = openManage()
    await screen.findByText('3 tickets')

    fireEvent.click(screen.getByTestId('manage-label-color-lbl-joy'))
    fireEvent.keyDown(await screen.findByTestId('manage-label-swatch-lbl-joy-yellow'), {
      key: 'ArrowRight'
    })
    fireEvent.keyDown(screen.getByTestId('manage-label-swatch-lbl-joy-green'), { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByTestId('manage-label-swatch-lbl-joy-green')).toBeNull()
    )
    expect(update).not.toHaveBeenCalled()

    // It opens again on the saved colour
    fireEvent.click(screen.getByTestId('manage-label-color-lbl-joy'))
    expect(await screen.findByTestId('manage-label-swatch-lbl-joy-yellow')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('saves a clicked colour at once', async () => {
    const { update } = openManage()
    await screen.findByText('3 tickets')

    fireEvent.click(screen.getByTestId('manage-label-color-lbl-blocked'))
    fireEvent.click(await screen.findByTestId('manage-label-swatch-lbl-blocked-purple'))

    await waitFor(() =>
      expect(screen.queryByTestId('manage-label-swatch-lbl-blocked-purple')).toBeNull()
    )
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('lbl-blocked', { color: 'purple' })
  })

  it('moves a label down the list', async () => {
    const { reorder } = openManage()

    fireEvent.click(screen.getByTestId('manage-label-down-lbl-joy'))

    await waitFor(() => expect(reorder).toHaveBeenCalledWith(['lbl-blocked', 'lbl-joy']))
  })

  it('adds a saved label from the inline row, on no ticket', async () => {
    const create = vi.fn(async () => savedLabel('lbl-new', 'Needs design', 'orange', 2))
    openManage({ create })

    fireEvent.click(screen.getByTestId('manage-labels-new'))
    fireEvent.change(screen.getByTestId('manage-label-new-name'), {
      target: { value: 'Needs design' }
    })
    fireEvent.click(screen.getByTestId('manage-label-new-add'))

    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Needs design', color: 'orange' }))
    await waitFor(() => expect(screen.queryByTestId('manage-label-new-row')).toBeNull())
  })
})
