import { describe, expect, it } from 'vitest'

import {
  TICKET_LABELS_MAX,
  ticketLabelCatalogOrder,
  type TicketLabel
} from '@shared/lib/ticket-labels'
import {
  canAddTicketLabel,
  extendTicketLabelSession,
  isTicketLabelNameTaken,
  isTicketOnlyLabel,
  nextTicketLabels,
  openTicketLabelSession,
  ticketOnlyLabelRows
} from './ticket-label-session'

const saved = (id: string, name = id): TicketLabel => ({ id, kind: 'saved', name, color: 'yellow' })
const once = (id: string, name = id): TicketLabel => ({ id, kind: 'once', name, color: 'gray' })

// The catalog as the menu sees it: saved labels A, B, C in that order.
const A = saved('A', 'Waiting for Joy')
const B = saved('B', 'Blocked')
const C = saved('C', 'Needs QA')
const catalogOrder = ticketLabelCatalogOrder([A, B, C])
const catalogIds: ReadonlySet<string> = new Set(catalogOrder.keys())
const noCatalog: ReadonlySet<string> = new Set()

const ids = (labels: readonly TicketLabel[]): string[] => labels.map((label) => label.id)

describe('isTicketOnlyLabel', () => {
  it('is true for a one-off and for a saved label the catalog lost', () => {
    expect(isTicketOnlyLabel(once('o1'), catalogIds)).toBe(true)
    expect(isTicketOnlyLabel(saved('gone'), catalogIds)).toBe(true)
    expect(isTicketOnlyLabel(A, catalogIds)).toBe(false)
  })
})

describe('openTicketLabelSession', () => {
  it('snapshots the ticket-only labels in the ticket’s order', () => {
    const o1 = once('o1')
    const lost = saved('lost')
    const o2 = once('o2')
    const session = openTicketLabelSession([A, o1, lost, B, o2], catalogIds)
    expect(session).toEqual([o1, lost, o2])
    expect(session[0]).toBe(o1)
  })

  it('is empty for a ticket with saved labels only', () => {
    expect(openTicketLabelSession([A, B], catalogIds)).toEqual([])
  })
})

describe('retain until close', () => {
  const O1 = once('O1', 'Until 21/10')
  const O2 = once('O2', 'Ping Dana')
  const O3 = once('O3', 'Later')

  it('keeps an unticked one-off listed, unticked, with the same object', () => {
    const before = [A, O1, O2, O3]
    const session = openTicketLabelSession(before, catalogIds)

    const after = nextTicketLabels(before, O2, false, session, catalogOrder)
    expect(ids(after)).toEqual(['A', 'O1', 'O3'])

    const rows = ticketOnlyLabelRows(session, after, catalogIds)
    expect(rows.map((row) => [row.label.id, row.checked])).toEqual([
      ['O1', true],
      ['O2', false],
      ['O3', true]
    ])
    expect(rows[1].label).toBe(O2)
  })

  it('re-ticking restores the identical object at its original place among the one-offs', () => {
    const before = [A, O1, O2, O3]
    const session = openTicketLabelSession(before, catalogIds)
    const unticked = nextTicketLabels(before, O2, false, session, catalogOrder)

    const row = ticketOnlyLabelRows(session, unticked, catalogIds).find((r) => r.label.id === 'O2')
    expect(row?.checked).toBe(false)
    const restored = nextTicketLabels(unticked, row!.label, true, session, catalogOrder)

    expect(ids(restored)).toEqual(['A', 'O1', 'O2', 'O3'])
    expect(restored[2]).toBe(O2)
    expect(restored).toEqual(before)
  })

  it('restores the first and the last one-off to their places too', () => {
    const before = [O1, O2, O3]
    const session = openTicketLabelSession(before, catalogIds)
    const withoutBoth = nextTicketLabels(
      nextTicketLabels(before, O1, false, session, catalogOrder),
      O3,
      false,
      session,
      catalogOrder
    )
    expect(ids(withoutBoth)).toEqual(['O2'])

    const lastBack = nextTicketLabels(withoutBoth, O3, true, session, catalogOrder)
    expect(ids(lastBack)).toEqual(['O2', 'O3'])
    const firstBack = nextTicketLabels(lastBack, O1, true, session, catalogOrder)
    expect(ids(firstBack)).toEqual(['O1', 'O2', 'O3'])
  })

  it('remembers a one-off created mid-session once the session is extended', () => {
    const before = [A, O1]
    let session = openTicketLabelSession(before, catalogIds)

    // The create dialog adds a one-off while the menu is open.
    const created = once('NEW', 'Waiting until 21/10')
    const withNew = [...before, created]
    // Before the session learns about it, the row is still listed (ticked, from the ticket).
    expect(ticketOnlyLabelRows(session, withNew, catalogIds).map((r) => r.label.id)).toEqual([
      'O1',
      'NEW'
    ])

    session = extendTicketLabelSession(session, withNew, catalogIds)
    expect(ids(session)).toEqual(['O1', 'NEW'])

    const unticked = nextTicketLabels(withNew, created, false, session, catalogOrder)
    const rows = ticketOnlyLabelRows(session, unticked, catalogIds)
    expect(rows.map((row) => [row.label.id, row.checked])).toEqual([
      ['O1', true],
      ['NEW', false]
    ])
    expect(rows[1].label).toBe(created)
  })

  it('forgets an unticked one-off created mid-session if the session never learnt it', () => {
    const before = [O1]
    const session = openTicketLabelSession(before, catalogIds)
    const created = once('NEW')
    const unticked = nextTicketLabels([...before, created], created, false, session, catalogOrder)
    expect(ticketOnlyLabelRows(session, unticked, catalogIds).map((r) => r.label.id)).toEqual([
      'O1'
    ])
  })

  it('extending returns the same session when nothing is new', () => {
    const session = openTicketLabelSession([A, O1], catalogIds)
    expect(extendTicketLabelSession(session, [A, O1], catalogIds)).toBe(session)
    expect(extendTicketLabelSession(session, [A], catalogIds)).toBe(session)
    expect(extendTicketLabelSession(session, [A, B], catalogIds)).toBe(session)
  })

  it('a new session (the menu reopened) no longer lists a removed one-off', () => {
    const before = [A, O1, O2]
    const session = openTicketLabelSession(before, catalogIds)
    const after = nextTicketLabels(before, O2, false, session, catalogOrder)
    expect(ticketOnlyLabelRows(session, after, catalogIds)).toHaveLength(2)

    const reopened = openTicketLabelSession(after, catalogIds)
    expect(ticketOnlyLabelRows(reopened, after, catalogIds).map((r) => r.label.id)).toEqual(['O1'])
  })
})

describe('saved labels', () => {
  it('go to catalog order, ahead of the one-offs', () => {
    const O1 = once('O1')
    const session = openTicketLabelSession([O1, C], catalogIds)
    const withA = nextTicketLabels([C, O1], A, true, session, catalogOrder)
    expect(ids(withA)).toEqual(['A', 'C', 'O1'])
    const withB = nextTicketLabels(withA, B, true, session, catalogOrder)
    expect(ids(withB)).toEqual(['A', 'B', 'C', 'O1'])
  })

  it('come off without disturbing the rest', () => {
    const O1 = once('O1')
    const current = [A, B, C, O1]
    const next = nextTicketLabels(current, B, false, [O1], catalogOrder)
    expect(ids(next)).toEqual(['A', 'C', 'O1'])
    expect(next[0]).toBe(A)
    expect(next[2]).toBe(O1)
  })
})

describe('no-ops', () => {
  it('returns the current array when the label is already in that state', () => {
    const current = [A, once('O1')]
    expect(nextTicketLabels(current, A, true, [], catalogOrder)).toBe(current)
    expect(nextTicketLabels(current, B, false, [], catalogOrder)).toBe(current)
  })

  it('a full ticket refuses adds but still lets labels come off', () => {
    const full = Array.from({ length: TICKET_LABELS_MAX }, (_, i) => once(`o${i}`))
    expect(canAddTicketLabel(full)).toBe(false)
    expect(canAddTicketLabel(full.slice(1))).toBe(true)

    const session = openTicketLabelSession(full, catalogIds)
    expect(nextTicketLabels(full, A, true, session, catalogOrder)).toBe(full)
    expect(nextTicketLabels(full, once('extra'), true, session, catalogOrder)).toBe(full)

    const fewer = nextTicketLabels(full, full[3], false, session, catalogOrder)
    expect(fewer).toHaveLength(TICKET_LABELS_MAX - 1)
    // And the one just removed fits back in its place.
    expect(nextTicketLabels(fewer, full[3], true, session, catalogOrder)).toEqual(full)
  })
})

describe('one name per ticket', () => {
  it('refuses a saved label whose name a one-off on the ticket already has', () => {
    // The create dialog lets a one-off share a saved label's name on a ticket without it.
    const blockedOnce = once('O1', 'blocked')
    const current = [blockedOnce]
    const session = openTicketLabelSession(current, catalogIds)

    expect(isTicketLabelNameTaken(current, B)).toBe(true)
    expect(nextTicketLabels(current, B, true, session, catalogOrder)).toBe(current)
  })

  it('refuses a removed one-off ticked back after a saved label of its name went on', () => {
    const blockedOnce = once('O1', 'blocked')
    const session = openTicketLabelSession([blockedOnce], catalogIds)
    const unticked = nextTicketLabels([blockedOnce], blockedOnce, false, session, catalogOrder)
    const withSaved = nextTicketLabels(unticked, B, true, session, catalogOrder)
    expect(ids(withSaved)).toEqual(['B'])

    expect(isTicketLabelNameTaken(withSaved, blockedOnce)).toBe(true)
    expect(nextTicketLabels(withSaved, blockedOnce, true, session, catalogOrder)).toBe(withSaved)
  })

  it('matches names case- and spacing-insensitively, and never against the label itself', () => {
    const current = [A, once('O1', 'Ping Dana')]
    expect(isTicketLabelNameTaken(current, once('X', ' PING   dana '))).toBe(true)
    expect(isTicketLabelNameTaken(current, A)).toBe(false)
    expect(isTicketLabelNameTaken(current, { id: 'A', name: 'ping dana' })).toBe(true)
    expect(isTicketLabelNameTaken(current, C)).toBe(false)
  })

  it('still lets either label of a clashing pair come off', () => {
    // A rename can leave a saved label and a one-off with one name on a ticket.
    const clash = once('O1', 'Blocked')
    const current = [B, clash]
    expect(ids(nextTicketLabels(current, clash, false, [clash], catalogOrder))).toEqual(['B'])
    expect(ids(nextTicketLabels(current, B, false, [clash], catalogOrder))).toEqual(['O1'])
  })
})

describe('a session opened before the catalog loaded', () => {
  it('does not list the saved labels as ticket-only once the catalog is known', () => {
    const O1 = once('O1')
    const current = [A, O1, B]
    // The menu opened before the catalog loaded: every label looked ticket-only.
    const session = openTicketLabelSession(current, noCatalog)
    expect(ids(session)).toEqual(['A', 'O1', 'B'])

    // The catalog arrives while the menu is open.
    const rows = ticketOnlyLabelRows(session, current, catalogIds)
    expect(rows.map((row) => row.label.id)).toEqual(['O1'])

    // Unticking a saved label then does not leave it under "This ticket only".
    const after = nextTicketLabels(current, A, false, session, catalogOrder)
    expect(ticketOnlyLabelRows(session, after, catalogIds).map((row) => row.label.id)).toEqual([
      'O1'
    ])
  })

  it('still lists a saved label the catalog really lost', () => {
    const lost = saved('lost', 'Old label')
    const session = openTicketLabelSession([lost], noCatalog)
    const rows = ticketOnlyLabelRows(session, [lost], catalogIds)
    expect(rows).toEqual([{ label: lost, checked: true }])

    const after = nextTicketLabels([lost], lost, false, session, catalogOrder)
    expect(ticketOnlyLabelRows(session, after, catalogIds)).toEqual([
      { label: lost, checked: false }
    ])
  })
})

describe('ticketOnlyLabelRows', () => {
  it('shows the live copy of a remembered label (e.g. after a catalog-free edit elsewhere)', () => {
    const O1 = once('O1', 'Before')
    const session = openTicketLabelSession([O1], catalogIds)
    const live = { ...O1, name: 'After' }
    const rows = ticketOnlyLabelRows(session, [live], catalogIds)
    expect(rows).toEqual([{ label: live, checked: true }])
    expect(rows[0].label).toBe(live)
  })

  it('lists nothing for an empty session and a ticket without one-offs', () => {
    expect(ticketOnlyLabelRows([], [A, B], catalogIds)).toEqual([])
  })
})
