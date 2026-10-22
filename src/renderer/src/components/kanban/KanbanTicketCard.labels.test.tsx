/**
 * Ticket labels on the card: a row of chips right under the title (every label, as typed,
 * capitalised by CSS), read-only on another Mac's ticket — including a row from an older build
 * that has no labels field at all.
 *
 * The Labels submenu toggles saved labels and keeps the menu open for several picks. A one-off
 * unticked while the menu is open stays listed (unticked) so it can be ticked back — the same
 * label, same id — and is gone for good once the menu closes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { KanbanTicket, KanbanTicketUpdate } from '../../../../main/db/types'
import type { RemoteTicket } from '@/lib/peers/contract'
import type { SavedTicketLabel, TicketLabel } from '@shared/lib/ticket-labels'

// Opening the card's Radix context menu takes 10–30 s under jsdom (see KanbanTicketCard.peer)
vi.setConfig({ testTimeout: 120_000 })

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

// The real toggle (per-ticket queue, latest store ticket), spied on
vi.mock('@/lib/ticket-label-toggle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ticket-label-toggle')>()
  return { setTicketLabel: vi.fn(actual.setTicketLabel) }
})

import { KanbanTicketCard } from './KanbanTicketCard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setTicketLabel } from '@/lib/ticket-label-toggle'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useTicketLabelsStore } from '@/stores/useTicketLabelsStore'

const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialLabelsState = useTicketLabelsStore.getState()

const now = '2026-01-01T00:00:00.000Z'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Add dark mode toggle',
    description: null,
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
    sync_task_id: null,
    sync_task_title: null,
    sync_task_status: null,
    sync_task_org_id: null,
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
    ticket_prefix: null,
    ticket_number: null,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

function savedLabel(id: string, name: string, color: string, sortOrder: number): SavedTicketLabel {
  return { id, name, color, sort_order: sortOrder, created_at: now, updated_at: now }
}

const joySaved = savedLabel('lbl-joy', 'Waiting for Joy', 'yellow', 0)
const blockedSaved = savedLabel('lbl-blocked', 'Blocked', 'red', 1)
const joy: TicketLabel = { id: 'lbl-joy', kind: 'saved', name: 'Waiting for Joy', color: 'yellow' }
const until: TicketLabel = { id: 'once-1', kind: 'once', name: 'Waiting until 21/10', color: 'gray' }

const card = (): HTMLElement => screen.getByTestId('kanban-ticket-ticket-1')

function renderCard(ticket: KanbanTicket | RemoteTicket): void {
  render(
    <TooltipProvider>
      <KanbanTicketCard ticket={ticket} />
    </TooltipProvider>
  )
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
  useTicketLabelsStore.setState(initialLabelsState, true)
})

describe('label chips on the card', () => {
  it('draws every label in its own row under the title, as typed', () => {
    renderCard(makeTicket({ labels: [joy, until] }))

    const row = within(card()).getByTestId('ticket-labels')
    const chips = within(row).getAllByTestId('ticket-label-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual(['Waiting for Joy', 'Waiting until 21/10'])
    for (const chip of chips) expect(chip).toHaveClass('uppercase')
    // Right after the title block: the row before it holds the title
    expect(row.previousElementSibling).toContainElement(screen.getByText('Add dark mode toggle'))
  })

  it('renders no row for a ticket without labels', () => {
    renderCard(makeTicket({ labels: [] }))
    expect(within(card()).queryByTestId('ticket-labels')).toBeNull()
  })

  it("draws another Mac's labels, and copes with an older build's row that has none", () => {
    const remote = {
      desktopId: 'desk-b',
      desktopName: 'Studio Mac',
      remoteProjectId: 'peer-proj-1',
      localProjectId: 'project-1'
    }
    const fromOlderBuild: Partial<KanbanTicket> = makeTicket()
    delete fromOlderBuild.labels
    renderCard({ ...(fromOlderBuild as KanbanTicket), remote })
    expect(screen.getByTestId('ticket-peer-badge')).toBeInTheDocument()
    expect(within(card()).queryByTestId('ticket-labels')).toBeNull()
    cleanup()

    renderCard({ ...makeTicket({ labels: [joy] }), remote })
    expect(within(card()).getByTestId('ticket-labels')).toHaveTextContent('Waiting for Joy')
  })
})

describe('the Labels submenu', () => {
  /** The card as the board renders it: from the store, so toggles reach it. */
  function StoreCard() {
    const ticket = useKanbanStore((s) => s.tickets.get('project-1')?.find((t) => t.id === 'ticket-1'))
    return ticket ? <KanbanTicketCard ticket={ticket} /> : null
  }

  /** updateTicket applied to the store, as the optimistic update does. */
  function stubUpdateTicket(): ReturnType<typeof vi.fn> {
    const updateTicket = vi.fn(async (ticketId: string, projectId: string, data: KanbanTicketUpdate) => {
      useKanbanStore.setState((state) => {
        const tickets = new Map(state.tickets)
        tickets.set(
          projectId,
          (tickets.get(projectId) ?? []).map((t) => (t.id === ticketId ? { ...t, ...data } : t))
        )
        return { tickets }
      })
    })
    useKanbanStore.setState({ updateTicket } as never)
    return updateTicket
  }

  async function openLabelsSubmenu(): Promise<void> {
    fireEvent.contextMenu(card())
    const trigger = await screen.findByTestId('ctx-labels-submenu')
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    await screen.findByTestId('ctx-label-lbl-blocked')
  }

  const lastLabels = (updateTicket: ReturnType<typeof vi.fn>): string[] =>
    (updateTicket.mock.lastCall?.[2] as KanbanTicketUpdate).labels!.map((label) => label.id)

  const cardLabelNames = (): string[] =>
    within(card())
      .queryAllByTestId('ticket-label-chip')
      .map((chip) => chip.textContent ?? '')

  it(
    'toggles saved labels in place and lets an unticked one-off be restored until it closes',
    async () => {
      useTicketLabelsStore.setState({ labels: [joySaved, blockedSaved], loaded: true })
      useKanbanStore.setState({
        tickets: new Map([['project-1', [makeTicket({ labels: [joy, until] })]]])
      })
      const updateTicket = stubUpdateTicket()
      render(
        <TooltipProvider>
          <StoreCard />
        </TooltipProvider>
      )

      await openLabelsSubmenu()
      expect(screen.getByTestId('ctx-labels-count')).toHaveTextContent('2')
      expect(screen.getByTestId('ctx-label-lbl-joy')).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByTestId('ctx-label-once-1')).toHaveAttribute('aria-checked', 'true')

      // Ticking a saved label: written in catalog order, and the menu stays open
      const blocked = screen.getByTestId('ctx-label-lbl-blocked')
      expect(blocked).toHaveAttribute('aria-checked', 'false')
      fireEvent.click(blocked)
      await waitFor(() => expect(updateTicket).toHaveBeenCalledTimes(1))
      expect(setTicketLabel).toHaveBeenLastCalledWith(
        { projectId: 'project-1', ticketId: 'ticket-1' },
        { id: 'lbl-blocked', kind: 'saved', name: 'Blocked', color: 'red' },
        true,
        [until]
      )
      expect(lastLabels(updateTicket)).toEqual(['lbl-joy', 'lbl-blocked', 'once-1'])
      await waitFor(() =>
        expect(screen.getByTestId('ctx-label-lbl-blocked')).toHaveAttribute('aria-checked', 'true')
      )
      expect(cardLabelNames()).toEqual(['Waiting for Joy', 'Blocked', 'Waiting until 21/10'])

      // Unticking the one-off: it leaves the card, its row stays (unticked, faded)
      fireEvent.click(screen.getByTestId('ctx-label-once-1'))
      await waitFor(() => expect(updateTicket).toHaveBeenCalledTimes(2))
      expect(lastLabels(updateTicket)).toEqual(['lbl-joy', 'lbl-blocked'])
      const removed = await waitFor(() => {
        const row = screen.getByTestId('ctx-label-once-1')
        expect(row).toHaveAttribute('aria-checked', 'false')
        return row
      })
      expect(removed).toHaveAttribute('data-removed')
      expect(within(removed).getByTestId('ticket-label-chip')).toHaveClass('opacity-60')
      expect(cardLabelNames()).toEqual(['Waiting for Joy', 'Blocked'])

      // Ticking it back restores the very same label
      fireEvent.click(removed)
      await waitFor(() => expect(updateTicket).toHaveBeenCalledTimes(3))
      const restored = (updateTicket.mock.lastCall?.[2] as KanbanTicketUpdate).labels!
      expect(restored.at(-1)).toEqual(until)
      await waitFor(() =>
        expect(screen.getByTestId('ctx-label-once-1')).toHaveAttribute('aria-checked', 'true')
      )

      // Unticked again, then the menu closes: the next opening has no record of it
      fireEvent.click(screen.getByTestId('ctx-label-once-1'))
      await waitFor(() => expect(updateTicket).toHaveBeenCalledTimes(4))
      await waitFor(() =>
        expect(screen.getByTestId('ctx-label-once-1')).toHaveAttribute('aria-checked', 'false')
      )
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByTestId('ctx-labels-submenu')).toBeNull())

      await openLabelsSubmenu()
      expect(screen.queryByTestId('ctx-label-once-1')).toBeNull()
      expect(screen.queryByText('This ticket only')).toBeNull()
      expect(screen.getByTestId('ctx-label-lbl-joy')).toHaveAttribute('aria-checked', 'true')
      expect(cardLabelNames()).toEqual(['Waiting for Joy', 'Blocked'])
    },
    180_000
  )
})

describe('Duplicate from the card menu', () => {
  it('copies every label, re-issuing each one-off under a new id', async () => {
    const createTicket = vi.fn().mockResolvedValue(makeTicket({ id: 'ticket-copy' }))
    useKanbanStore.setState({ createTicket } as never)
    renderCard(makeTicket({ labels: [joy, until] }))

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-duplicate-ticket'))

    await waitFor(() => expect(createTicket).toHaveBeenCalledTimes(1))
    const [, data] = createTicket.mock.calls[0] as [string, { labels: TicketLabel[] }]
    expect(data.labels).toHaveLength(2)
    expect(data.labels[0]).toEqual(joy)
    expect(data.labels[1]).toMatchObject({ kind: 'once', name: until.name, color: until.color })
    expect(data.labels[1].id).not.toBe(until.id)
  })
})
