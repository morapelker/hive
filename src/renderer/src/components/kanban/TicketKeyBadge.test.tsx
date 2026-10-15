import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketKeyBadge } from './TicketKeyBadge'

describe('TicketKeyBadge', () => {
  afterEach(() => cleanup())

  it('renders the formatted key with a copyable title', () => {
    render(
      <TicketKeyBadge
        ticket={{ ticket_prefix: 'TD', ticket_number: 12, parent_ticket_key: null }}
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
        ticket={{ ticket_prefix: 'TD', ticket_number: null, parent_ticket_key: null }}
      />
    )

    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the ticket has no prefix', () => {
    const { container } = render(
      <TicketKeyBadge
        ticket={{ ticket_prefix: null, ticket_number: 12, parent_ticket_key: null }}
      />
    )

    expect(container.firstChild).toBeNull()
  })

  it('shows the parent run key before the own key for an orchestrator child', () => {
    render(
      <TicketKeyBadge
        ticket={{ ticket_prefix: 'TD', ticket_number: 12, parent_ticket_key: 'TD-7' }}
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
        ticket={{ ticket_prefix: 'TD', ticket_number: 12, parent_ticket_key: 'TD-7' }}
        showParent={false}
      />
    )

    expect(screen.queryByTestId('ticket-parent-key')).toBeNull()
    expect(screen.getByTestId('ticket-key')).toHaveTextContent('TD-12')
  })

  it('applies the modal variant and extra classes to the chip', () => {
    render(
      <TicketKeyBadge
        ticket={{ ticket_prefix: 'TD', ticket_number: 12, parent_ticket_key: null }}
        variant="modal"
        className="mt-px"
      />
    )

    const chip = screen.getByTestId('ticket-key-badge')
    expect(chip.className).toContain('font-mono')
    expect(chip.className).toContain('text-[11px]')
    expect(chip.className).toContain('mt-px')
  })
})
