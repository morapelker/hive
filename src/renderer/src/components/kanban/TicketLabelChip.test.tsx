/**
 * A label chip draws the name as typed and leaves the capitals to CSS, so copying, typeahead
 * and screen readers get the real name; the card's row shows every label (wrapping, no "+N")
 * and nothing at all for a ticket without labels.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { TicketLabel } from '@shared/lib/ticket-labels'
import { TicketLabelChip, TicketLabelRow } from './TicketLabelChip'

const joy: TicketLabel = { id: 'lbl-joy', kind: 'saved', name: 'Waiting for Joy', color: 'yellow' }
const until: TicketLabel = { id: 'once-1', kind: 'once', name: 'Waiting until 21/10', color: 'gray' }

afterEach(cleanup)

describe('TicketLabelChip', () => {
  it('keeps the name as typed and capitalises it with CSS', () => {
    render(<TicketLabelChip label={joy} />)
    const chip = screen.getByTestId('ticket-label-chip')
    expect(chip).toHaveTextContent('Waiting for Joy')
    expect(chip.textContent).not.toBe('WAITING FOR JOY')
    expect(chip).toHaveClass('uppercase')
    expect(chip).toHaveAttribute('title', 'Waiting for Joy')
  })

  it('takes its colour from the palette, and gray for a token it does not know', () => {
    const { rerender } = render(<TicketLabelChip label={joy} />)
    expect(screen.getByTestId('ticket-label-chip').className).toContain('bg-yellow-400/35')

    rerender(<TicketLabelChip label={{ name: 'From a newer build', color: 'ultraviolet' }} />)
    expect(screen.getByTestId('ticket-label-chip').className).toContain('bg-neutral-500/12')
  })

  it('fades only when dimmed', () => {
    const { rerender } = render(<TicketLabelChip label={until} />)
    expect(screen.getByTestId('ticket-label-chip')).not.toHaveClass('opacity-60')
    rerender(<TicketLabelChip label={until} dimmed title="Removed" />)
    expect(screen.getByTestId('ticket-label-chip')).toHaveClass('opacity-60')
    expect(screen.getByTestId('ticket-label-chip')).toHaveAttribute('title', 'Removed')
  })
})

describe('TicketLabelRow', () => {
  it('renders nothing without labels', () => {
    const { container } = render(<TicketLabelRow labels={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows every label in order, wrapping, with no overflow chip', () => {
    const many: TicketLabel[] = Array.from({ length: 7 }, (_, index) => ({
      id: `once-${index}`,
      kind: 'once',
      name: `Label ${index}`,
      color: 'blue'
    }))
    render(<TicketLabelRow labels={[joy, ...many]} />)

    const row = screen.getByTestId('ticket-labels')
    expect(row).toHaveClass('flex-wrap')
    const chips = within(row).getAllByTestId('ticket-label-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Waiting for Joy',
      ...many.map((label) => label.name)
    ])
    expect(row.textContent).not.toMatch(/\+\d/)
  })

  it('draws one-offs exactly like saved labels', () => {
    render(<TicketLabelRow labels={[{ ...until, kind: 'saved', id: 'lbl-x' }, until]} />)
    const [saved, once] = screen.getAllByTestId('ticket-label-chip')
    expect(once.className).toBe(saved.className)
  })
})
