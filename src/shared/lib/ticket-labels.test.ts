import { describe, expect, it } from 'vitest'

import {
  TICKET_LABELS_MAX,
  TICKET_LABEL_COLORS,
  TICKET_LABEL_NAME_MAX,
  applySavedTicketLabelChange,
  copyTicketLabelsForNewTicket,
  hasTicketLabelNamed,
  isTicketLabelColor,
  isTicketLabelColorToken,
  normalizeTicketLabelName,
  parseTicketLabel,
  parseTicketLabels,
  sortTicketLabels,
  ticketLabelCatalogOrder,
  ticketLabelNameKey,
  ticketLabelsOf,
  type TicketLabel
} from './ticket-labels'

const saved = (id: string, name = id, color = 'yellow'): TicketLabel => ({
  id,
  kind: 'saved',
  name,
  color
})
const once = (id: string, name = id, color = 'gray'): TicketLabel => ({
  id,
  kind: 'once',
  name,
  color
})

const order = (...ids: string[]): ReadonlyMap<string, number> =>
  ticketLabelCatalogOrder(ids.map((id) => ({ id })))

describe('colours', () => {
  it('knows the nine preset colours', () => {
    expect(TICKET_LABEL_COLORS).toEqual([
      'gray',
      'red',
      'orange',
      'yellow',
      'green',
      'teal',
      'blue',
      'purple',
      'pink'
    ])
    for (const color of TICKET_LABEL_COLORS) expect(isTicketLabelColor(color)).toBe(true)
    expect(isTicketLabelColor('magenta')).toBe(false)
    expect(isTicketLabelColor(undefined)).toBe(false)
  })

  it('accepts any well-formed token, so a newer build’s colour survives a round-trip', () => {
    expect(isTicketLabelColorToken('magenta')).toBe(true)
    expect(isTicketLabelColorToken('sky-2')).toBe(true)
    expect(isTicketLabelColorToken('Red')).toBe(false)
    expect(isTicketLabelColorToken('2red')).toBe(false)
    expect(isTicketLabelColorToken('')).toBe(false)
    expect(isTicketLabelColorToken('a'.repeat(25))).toBe(false)
    expect(isTicketLabelColorToken('#ff0000')).toBe(false)
    expect(isTicketLabelColorToken(3)).toBe(false)
  })
})

describe('normalizeTicketLabelName / ticketLabelNameKey', () => {
  it('trims and collapses inner whitespace', () => {
    expect(normalizeTicketLabelName('  Waiting \n for\t\tJoy  ')).toBe('Waiting for Joy')
  })

  it('applies NFKC so look-alike forms are one name', () => {
    expect(normalizeTicketLabelName('Ｗａｉｔｉｎｇ')).toBe('Waiting')
    expect(normalizeTicketLabelName('ﬁx')).toBe('fix')
  })

  it('keeps the case as typed (the card upper-cases with CSS)', () => {
    expect(normalizeTicketLabelName('Waiting for Joy')).toBe('Waiting for Joy')
  })

  it('cuts to TICKET_LABEL_NAME_MAX code points and drops a trailing space left by the cut', () => {
    const long = 'x'.repeat(40)
    expect(normalizeTicketLabelName(long)).toBe('x'.repeat(TICKET_LABEL_NAME_MAX))

    const emoji = '🚀'.repeat(40)
    const cut = normalizeTicketLabelName(emoji)
    expect(Array.from(cut)).toHaveLength(TICKET_LABEL_NAME_MAX)
    expect(cut).toBe('🚀'.repeat(TICKET_LABEL_NAME_MAX))

    const spaceAtCut = `${'a'.repeat(TICKET_LABEL_NAME_MAX - 1)} tail`
    expect(normalizeTicketLabelName(spaceAtCut)).toBe('a'.repeat(TICKET_LABEL_NAME_MAX - 1))
  })

  it('returns an empty string for whitespace only', () => {
    expect(normalizeTicketLabelName(' \t\n ')).toBe('')
  })

  it('folds case for the identity key', () => {
    expect(ticketLabelNameKey(' JOY ')).toBe('joy')
    expect(ticketLabelNameKey('Joy')).toBe(ticketLabelNameKey('jOY'))
    expect(ticketLabelNameKey('Waiting  for Joy')).toBe('waiting for joy')
    expect(ticketLabelNameKey('ＪＯＹ')).toBe('joy')
  })
})

describe('parseTicketLabel', () => {
  it('normalises a valid entry and drops unknown keys', () => {
    expect(
      parseTicketLabel({
        id: 'l1',
        kind: 'saved',
        name: '  Waiting   for Joy ',
        color: 'yellow',
        x: 1
      })
    ).toEqual({ id: 'l1', kind: 'saved', name: 'Waiting for Joy', color: 'yellow' })
  })

  it('keeps an unknown but well-formed colour token and maps junk colours to gray', () => {
    expect(parseTicketLabel({ id: 'l1', kind: 'once', name: 'A', color: 'magenta' })?.color).toBe(
      'magenta'
    )
    expect(
      parseTicketLabel({ id: 'l1', kind: 'once', name: 'A', color: 'NOT A COLOR' })?.color
    ).toBe('gray')
    expect(parseTicketLabel({ id: 'l1', kind: 'once', name: 'A', color: 7 })?.color).toBe('gray')
    expect(parseTicketLabel({ id: 'l1', kind: 'once', name: 'A' })?.color).toBe('gray')
  })

  it('rejects entries that are not usable labels', () => {
    const bad: unknown[] = [
      null,
      undefined,
      0,
      'label',
      ['l1', 'saved', 'A', 'red'],
      {},
      { kind: 'saved', name: 'A', color: 'red' },
      { id: '', kind: 'saved', name: 'A', color: 'red' },
      { id: 'x'.repeat(65), kind: 'saved', name: 'A', color: 'red' },
      { id: 7, kind: 'saved', name: 'A', color: 'red' },
      { id: 'l1', kind: 'pinned', name: 'A', color: 'red' },
      { id: 'l1', name: 'A', color: 'red' },
      { id: 'l1', kind: 'saved', name: 42, color: 'red' },
      { id: 'l1', kind: 'saved', color: 'red' },
      { id: 'l1', kind: 'saved', name: '   ', color: 'red' }
    ]
    for (const value of bad) expect(parseTicketLabel(value)).toBeNull()
  })

  it('cuts an oversize name instead of dropping the label', () => {
    const label = parseTicketLabel({ id: 'l1', kind: 'once', name: 'n'.repeat(500), color: 'red' })
    expect(label?.name).toBe('n'.repeat(TICKET_LABEL_NAME_MAX))
  })
})

describe('parseTicketLabels', () => {
  it('returns [] for NULL, empty and garbage input without throwing', () => {
    const garbage: unknown[] = [
      null,
      undefined,
      '',
      '   ',
      'not json',
      '{"id":"l1"',
      '{}',
      '42',
      'null',
      '"string"',
      42,
      true,
      { id: 'l1', kind: 'saved', name: 'A', color: 'red' },
      new Map()
    ]
    for (const value of garbage) expect(parseTicketLabels(value)).toEqual([])
  })

  it('reads the stored JSON string and an already-parsed array alike', () => {
    const labels = [saved('l1', 'Joy'), once('o1', 'Until 21/10', 'red')]
    expect(parseTicketLabels(JSON.stringify(labels))).toEqual(labels)
    expect(parseTicketLabels(labels)).toEqual(labels)
  })

  it('keeps the valid entries of a mixed array, in order', () => {
    expect(
      parseTicketLabels([
        null,
        saved('l1', 'Joy'),
        'junk',
        { id: 'l2', kind: 'saved', name: '' },
        once('o1', 'Later'),
        [1, 2]
      ])
    ).toEqual([saved('l1', 'Joy'), once('o1', 'Later')])
  })

  it('keeps the first occurrence of a duplicate id', () => {
    expect(
      parseTicketLabels([saved('l1', 'First'), once('l1', 'Second'), saved('l2', 'Other')])
    ).toEqual([saved('l1', 'First'), saved('l2', 'Other')])
  })

  it('does not de-duplicate by name (a rename may collide with a one-off)', () => {
    expect(parseTicketLabels([saved('l1', 'Joy'), once('o1', 'JOY')])).toHaveLength(2)
  })

  it(`caps a ticket at ${TICKET_LABELS_MAX} labels`, () => {
    const many = Array.from({ length: TICKET_LABELS_MAX + 5 }, (_, i) => once(`o${i}`))
    const parsed = parseTicketLabels(many)
    expect(parsed).toHaveLength(TICKET_LABELS_MAX)
    expect(parsed.at(-1)?.id).toBe(`o${TICKET_LABELS_MAX - 1}`)
  })

  it('counts only valid entries towards the cap', () => {
    const many = [
      ...Array.from({ length: 10 }, () => ({ junk: true })),
      ...Array.from({ length: TICKET_LABELS_MAX }, (_, i) => once(`o${i}`))
    ]
    expect(parseTicketLabels(many)).toHaveLength(TICKET_LABELS_MAX)
  })
})

describe('ticketLabelsOf', () => {
  it('reads [] for a row from an older build that has no labels', () => {
    expect(ticketLabelsOf({})).toEqual([])
    expect(ticketLabelsOf({ labels: null })).toEqual([])
    const labels = [saved('l1')]
    expect(ticketLabelsOf({ labels })).toBe(labels)
  })
})

describe('sortTicketLabels', () => {
  it('puts saved labels in catalog order, then unknown saved ones, then one-offs as they are', () => {
    const labels = [once('o2'), saved('c'), saved('ghost'), once('o1'), saved('a'), saved('b')]
    expect(sortTicketLabels(labels, order('a', 'b', 'c')).map((l) => l.id)).toEqual([
      'a',
      'b',
      'c',
      'ghost',
      'o2',
      'o1'
    ])
  })

  it('keeps several unknown saved labels in their relative order', () => {
    const labels = [saved('ghost2'), saved('a'), saved('ghost1')]
    expect(sortTicketLabels(labels, order('a')).map((l) => l.id)).toEqual(['a', 'ghost2', 'ghost1'])
  })

  it('returns the same array when it is already in order', () => {
    const labels = [saved('a'), saved('b'), once('o1')]
    expect(sortTicketLabels(labels, order('a', 'b'))).toBe(labels)
    const empty: TicketLabel[] = []
    expect(sortTicketLabels(empty, order('a'))).toBe(empty)
  })

  it('keeps the label objects themselves', () => {
    const a = saved('a')
    const sorted = sortTicketLabels([once('o1'), a], order('a'))
    expect(sorted[0]).toBe(a)
  })
})

describe('applySavedTicketLabelChange', () => {
  describe('update', () => {
    it('rewrites the name and colour of the matching saved label only', () => {
      const labels = [saved('l1', 'Joy', 'yellow'), once('l1-once', 'Joy'), saved('l2', 'Other')]
      const next = applySavedTicketLabelChange(labels, {
        type: 'update',
        label: { id: 'l1', name: 'Waiting for Joy', color: 'red' }
      })
      expect(next).toEqual([
        saved('l1', 'Waiting for Joy', 'red'),
        once('l1-once', 'Joy'),
        saved('l2', 'Other')
      ])
      expect(next[1]).toBe(labels[1])
      expect(next[2]).toBe(labels[2])
      // The input is not mutated.
      expect(labels[0].name).toBe('Joy')
    })

    it('does not touch a one-off that happens to share the id', () => {
      const labels = [once('l1', 'Mine')]
      expect(
        applySavedTicketLabelChange(labels, {
          type: 'update',
          label: { id: 'l1', name: 'Theirs', color: 'red' }
        })
      ).toBe(labels)
    })

    it('returns the same array when the ticket does not carry the label', () => {
      const labels = [saved('l2'), once('o1')]
      expect(
        applySavedTicketLabelChange(labels, {
          type: 'update',
          label: { id: 'l1', name: 'X', color: 'red' }
        })
      ).toBe(labels)
    })

    it('returns the same array when the name and colour are already current', () => {
      const labels = [saved('l1', 'Joy', 'yellow')]
      expect(
        applySavedTicketLabelChange(labels, {
          type: 'update',
          label: { id: 'l1', name: 'Joy', color: 'yellow' }
        })
      ).toBe(labels)
    })
  })

  describe('delete', () => {
    it('removes the saved label and keeps one-offs, even one with the same id', () => {
      const labels = [saved('l1'), once('l1'), saved('l2')]
      const next = applySavedTicketLabelChange(labels, { type: 'delete', id: 'l1' })
      expect(next).toEqual([once('l1'), saved('l2')])
      expect(next[0]).toBe(labels[1])
    })

    it('returns the same array when the ticket does not carry the label', () => {
      const labels = [saved('l2'), once('o1')]
      expect(applySavedTicketLabelChange(labels, { type: 'delete', id: 'l1' })).toBe(labels)
    })
  })

  describe('reorder', () => {
    it('sorts the saved labels by the new catalog order', () => {
      const labels = [saved('a'), saved('b'), once('o1'), saved('c')]
      const next = applySavedTicketLabelChange(labels, { type: 'reorder', ids: ['c', 'a', 'b'] })
      expect(next.map((l) => l.id)).toEqual(['c', 'a', 'b', 'o1'])
    })

    it('returns the same array when the order does not change it', () => {
      const labels = [saved('a'), saved('b'), once('o1')]
      expect(applySavedTicketLabelChange(labels, { type: 'reorder', ids: ['a', 'x', 'b'] })).toBe(
        labels
      )
      const empty: TicketLabel[] = []
      expect(applySavedTicketLabelChange(empty, { type: 'reorder', ids: ['a'] })).toBe(empty)
    })
  })
})

describe('hasTicketLabelNamed', () => {
  it('matches case- and whitespace-insensitively, saved and one-off alike', () => {
    const labels = [saved('l1', 'Waiting for Joy'), once('o1', 'Until 21/10')]
    expect(hasTicketLabelNamed(labels, '  WAITING   FOR joy ')).toBe(true)
    expect(hasTicketLabelNamed(labels, 'until 21/10')).toBe(true)
    expect(hasTicketLabelNamed(labels, 'Waiting')).toBe(false)
    expect(hasTicketLabelNamed([], 'Joy')).toBe(false)
  })
})

describe('copyTicketLabelsForNewTicket', () => {
  it('keeps saved labels and re-issues every one-off under a new id, in order', () => {
    const labels = [saved('l1', 'Joy'), once('o1', 'Until 21/10', 'red'), once('o2', 'Later')]
    let n = 0
    const copy = copyTicketLabelsForNewTicket(labels, () => `new-${++n}`)
    expect(copy).toEqual([
      saved('l1', 'Joy'),
      once('new-1', 'Until 21/10', 'red'),
      once('new-2', 'Later')
    ])
  })

  it('returns independent objects', () => {
    const labels = [saved('l1', 'Joy'), once('o1', 'Later')]
    const copy = copyTicketLabelsForNewTicket(labels, () => 'fresh')
    expect(copy).not.toBe(labels)
    expect(copy[0]).not.toBe(labels[0])
    copy[0].name = 'Changed'
    expect(labels[0].name).toBe('Joy')
  })

  it('copies an empty list to an empty list', () => {
    expect(copyTicketLabelsForNewTicket([], () => 'unused')).toEqual([])
  })
})
