/**
 * The Labels submenu rows. A ticket shows each name once: an unticked row whose name another
 * label on the ticket already has (a one-off may share a saved label's name) is disabled, with
 * hover text saying why, so ticking it cannot draw two identical chips.
 *
 * The Radix menu primitives are replaced by plain elements: opening the real context menu
 * takes 10–30 s under jsdom (see KanbanTicketCard.labels.test.tsx), and only the rows matter.
 */
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SavedTicketLabel, TicketLabel } from '@shared/lib/ticket-labels'

vi.mock('@/components/ui/context-menu', () => {
  interface ItemProps {
    children?: ReactNode
    checked?: boolean
    disabled?: boolean
    className?: string
    onCheckedChange?: (on: boolean) => void
    onSelect?: (event: Event) => void
    textValue?: string
    'data-testid'?: string
    'data-removed'?: string
  }
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    ContextMenuCheckboxItem: ({
      children,
      checked,
      disabled,
      className,
      onCheckedChange,
      ...rest
    }: ItemProps) => (
      <div
        role="menuitemcheckbox"
        aria-checked={checked ? 'true' : 'false'}
        aria-disabled={disabled ? 'true' : undefined}
        data-testid={rest['data-testid']}
        data-removed={rest['data-removed']}
        className={className}
        onClick={() => {
          if (!disabled) onCheckedChange?.(!checked)
        }}
      >
        {children}
      </div>
    ),
    ContextMenuItem: ({ children, disabled, ...rest }: ItemProps) => (
      <div
        role="menuitem"
        aria-disabled={disabled ? 'true' : undefined}
        data-testid={rest['data-testid']}
      >
        {children}
      </div>
    ),
    ContextMenuLabel: Passthrough,
    ContextMenuSeparator: () => <hr />,
    ContextMenuSub: Passthrough,
    ContextMenuSubContent: Passthrough,
    ContextMenuSubTrigger: Passthrough
  }
})

vi.mock('@/lib/ticket-label-toggle', () => ({
  setTicketLabel: vi.fn(async () => 'applied')
}))

import { setTicketLabel } from '@/lib/ticket-label-toggle'
import { openTicketLabelSession } from '@/lib/ticket-label-session'
import { useTicketLabelsStore } from '@/stores/useTicketLabelsStore'
import { TicketLabelsMenuItems } from './TicketLabelsMenuItems'

const now = '2026-10-01T00:00:00.000Z'
const catalogRow = (id: string, name: string, sortOrder: number): SavedTicketLabel => ({
  id,
  name,
  color: 'red',
  sort_order: sortOrder,
  created_at: now,
  updated_at: now
})

const joyRow = catalogRow('lbl-joy', 'Waiting for Joy', 0)
const blockedRow = catalogRow('lbl-blocked', 'Blocked', 1)
const blockedSaved: TicketLabel = {
  id: 'lbl-blocked',
  kind: 'saved',
  name: 'Blocked',
  color: 'red'
}
const blockedOnce: TicketLabel = { id: 'once-1', kind: 'once', name: 'blocked', color: 'gray' }
const catalogIds: ReadonlySet<string> = new Set([joyRow.id, blockedRow.id])

const row = (id: string): HTMLElement => screen.getByTestId(`ctx-label-${id}`)
const chipTitle = (id: string): string | null =>
  within(row(id)).getByTestId('ticket-label-chip').getAttribute('title')

function renderRows(
  labels: readonly TicketLabel[],
  session = openTicketLabelSession(labels, catalogIds)
): void {
  render(<TicketLabelsMenuItems projectId="p1" ticketId="t1" labels={labels} session={session} />)
}

beforeEach(() => {
  useTicketLabelsStore.setState({ labels: [joyRow, blockedRow], loaded: true })
})

afterEach(() => {
  cleanup()
  vi.mocked(setTicketLabel).mockClear()
  useTicketLabelsStore.setState({ labels: [], loaded: false, dialog: null })
})

describe('TicketLabelsMenuItems', () => {
  it('disables a saved label whose name a one-off on the ticket already has', () => {
    renderRows([blockedOnce])

    expect(row('lbl-blocked')).toHaveAttribute('aria-checked', 'false')
    expect(row('lbl-blocked')).toHaveAttribute('aria-disabled', 'true')
    expect(chipTitle('lbl-blocked')).toBe('Already on this ticket')
    fireEvent.click(row('lbl-blocked'))
    expect(setTicketLabel).not.toHaveBeenCalled()

    // Other saved labels are offered as usual.
    expect(row('lbl-joy')).not.toHaveAttribute('aria-disabled')
    expect(chipTitle('lbl-joy')).toBe('Waiting for Joy')
    fireEvent.click(row('lbl-joy'))
    expect(setTicketLabel).toHaveBeenCalledTimes(1)
  })

  it('disables a removed one-off once a label of its name is back on the ticket', () => {
    // The menu opened with the one-off, which was unticked; then the saved "Blocked" went on.
    const session = openTicketLabelSession([blockedOnce], catalogIds)
    renderRows([blockedSaved], session)

    expect(row('once-1')).toHaveAttribute('aria-checked', 'false')
    expect(row('once-1')).toHaveAttribute('aria-disabled', 'true')
    expect(chipTitle('once-1')).toBe('Already on this ticket')
    fireEvent.click(row('once-1'))
    expect(setTicketLabel).not.toHaveBeenCalled()
  })

  it('keeps a removed one-off without a clash restorable', () => {
    const session = openTicketLabelSession([blockedOnce], catalogIds)
    renderRows([], session)

    expect(row('once-1')).not.toHaveAttribute('aria-disabled')
    expect(chipTitle('once-1')).toBe('Removed — tick to restore; it is gone once this menu closes')
    expect(row('lbl-blocked')).not.toHaveAttribute('aria-disabled')
  })

  it('never disables a ticked row, so either of a clashing pair can come off', () => {
    // A catalog rename can leave a saved label and a one-off of one name on a ticket.
    const clash: TicketLabel = { ...blockedOnce, name: 'Blocked' }
    renderRows([blockedSaved, clash])

    expect(row('lbl-blocked')).toHaveAttribute('aria-checked', 'true')
    expect(row('lbl-blocked')).not.toHaveAttribute('aria-disabled')
    expect(row('once-1')).toHaveAttribute('aria-checked', 'true')
    expect(row('once-1')).not.toHaveAttribute('aria-disabled')
  })
})
