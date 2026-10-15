import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { ticketKeyColor } from '@/lib/ticket-key-color'
import { TicketKeyBadge, ticketKeyVisible, type TicketKeyBadgeTicket } from './TicketKeyBadge'

const plain = (over: Partial<TicketKeyBadgeTicket> = {}): TicketKeyBadgeTicket => ({
  ticket_prefix: 'TD',
  ticket_number: 12,
  parent_ticket_key: null,
  external_provider: null,
  external_id: null,
  ...over
})
const run = (over: Partial<TicketKeyBadgeTicket> = {}): TicketKeyBadgeTicket =>
  plain({ ticket_number: 7, external_provider: 'document-run', external_id: 'run-1', ...over })
const child = (over: Partial<TicketKeyBadgeTicket> = {}): TicketKeyBadgeTicket =>
  plain({ parent_ticket_key: 'TD-7', ...over })

describe('TicketKeyBadge', () => {
  beforeEach(() => useSettingsStore.setState({ ticketKeyDisplay: 'always' }))
  afterEach(() => cleanup())

  it('renders the formatted key with a copyable title', () => {
    render(
      <TicketKeyBadge
        ticket={plain()}
      />
    )

    const key = screen.getByTestId('ticket-key')
    expect(key).toHaveTextContent('TD-12')
    expect(key).toHaveAttribute('title', 'Ticket TD-12')
    expect(screen.queryByTestId('ticket-parent-key')).toBeNull()
  })

  it('renders nothing when the ticket has no number (markdown card, older row)', () => {
    const { container } = render(
      <TicketKeyBadge
        ticket={plain({ ticket_number: null })}
      />
    )

    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the ticket has no prefix', () => {
    const { container } = render(
      <TicketKeyBadge
        ticket={plain({ ticket_prefix: null })}
      />
    )

    expect(container.firstChild).toBeNull()
  })

  it('shows the parent run key before the own key for an orchestrator child', () => {
    render(
      <TicketKeyBadge
        ticket={child()}
      />
    )

    const parent = screen.getByTestId('ticket-parent-key')
    expect(parent).toHaveTextContent('TD-7')
    expect(parent).toHaveAttribute('title', 'Part of orchestrator TD-7')
    const own = screen.getByTestId('ticket-key')
    expect(own).toHaveTextContent('TD-12')
    // Parent reads first: "TD-7 › TD-12"
    expect(screen.getByTestId('ticket-key-badge')).toHaveTextContent(/TD-7.*›.*TD-12/)
    expect(parent.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('hides the parent segment when showParent is off', () => {
    render(
      <TicketKeyBadge
        ticket={child()}
        showParent={false}
      />
    )

    expect(screen.queryByTestId('ticket-parent-key')).toBeNull()
    expect(screen.getByTestId('ticket-key')).toHaveTextContent('TD-12')
  })

  it('applies the modal variant and extra classes to the chip', () => {
    render(
      <TicketKeyBadge
        ticket={plain()}
        variant="modal"
        className="mt-px"
      />
    )

    const chip = screen.getByTestId('ticket-key-badge')
    expect(chip.className).toContain('font-mono')
    expect(chip.className).toContain('text-[11px]')
    expect(chip.className).toContain('mt-px')
  })

  describe('the Ticket IDs setting', () => {
    it('never: hides every key', () => {
      useSettingsStore.setState({ ticketKeyDisplay: 'never' })
      const { container } = render(
        <>
          <TicketKeyBadge ticket={plain()} />
          <TicketKeyBadge ticket={run()} />
          <TicketKeyBadge ticket={child()} />
        </>
      )
      expect(container.querySelectorAll('[data-testid=ticket-key-badge]')).toHaveLength(0)
    })

    it('orchestrator: keeps the key on a run ticket and its children, drops it elsewhere', () => {
      useSettingsStore.setState({ ticketKeyDisplay: 'orchestrator' })
      render(
        <>
          <TicketKeyBadge ticket={plain()} />
          <TicketKeyBadge ticket={run()} />
          <TicketKeyBadge ticket={child()} />
        </>
      )
      expect(screen.getAllByTestId('ticket-key').map((el) => el.textContent)).toEqual([
        'TD-7',
        'TD-12'
      ])
      expect(screen.getByTestId('ticket-parent-key')).toHaveTextContent('TD-7')
    })

    it('ticketKeyVisible follows the three modes', () => {
      expect(ticketKeyVisible('always', plain())).toBe(true)
      expect(ticketKeyVisible('never', run())).toBe(false)
      expect(ticketKeyVisible('orchestrator', plain())).toBe(false)
      expect(ticketKeyVisible('orchestrator', run())).toBe(true)
      expect(ticketKeyVisible('orchestrator', child())).toBe(true)
    })
  })

  describe('the run colour', () => {
    it('paints a run ticket key and its children\'s parent segment in the colour of that key', () => {
      render(
        <>
          <TicketKeyBadge ticket={run()} />
          <TicketKeyBadge ticket={child()} />
        </>
      )
      const expected = ticketKeyColor('TD-7')
      const runKey = screen.getAllByTestId('ticket-key')[0]
      const parentSegment = screen.getByTestId('ticket-parent-key')
      expect(runKey).toHaveAttribute('title', 'Orchestrator TD-7')
      expect(runKey.style.getPropertyValue('--ticket-key-light')).toBe(expected.light)
      expect(runKey.style.getPropertyValue('--ticket-key-dark')).toBe(expected.dark)
      expect(parentSegment.style.getPropertyValue('--ticket-key-light')).toBe(expected.light)
      expect(parentSegment.style.getPropertyValue('--ticket-key-dark')).toBe(expected.dark)
      expect(runKey.className).toContain('dark:text-(--ticket-key-dark)')
      expect(parentSegment.className).toContain('bg-(--ticket-key-light)/14')
    })

    it('leaves an ordinary ticket key uncoloured', () => {
      render(<TicketKeyBadge ticket={plain()} />)
      expect(screen.getByTestId('ticket-key').getAttribute('style')).toBeNull()
    })
  })
})
