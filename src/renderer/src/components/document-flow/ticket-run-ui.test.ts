import { describe, expect, it } from 'vitest'
import { buildTicketRunPrompt } from '@shared/document-flow/prompts'
import { DOCUMENT_RUN_TICKET_PROVIDER } from '@shared/document-flow/run-ticket'
import { SHELL_COMMAND_TICKET_PROVIDER } from '@shared/lib/shell-commands'
import { makeDetail } from './test-fixtures'
import {
  addTicketsLabel,
  describeMissingBlockers,
  isHiddenFromTicketPicker,
  missingBlockers,
  orderTicketIdsForRun,
  sortBoardTickets,
  ticketLabel,
  ticketMatchesSearch,
  ticketRunMeta,
  ticketRunOwners,
  ticketRunPromptParts,
  unresolvedBlockers
} from './ticket-run-ui'

const ref = { external_provider: null, external_id: null, archived_at: null }

describe('ticket-run-ui', () => {
  it('hides run tickets, shell commands and archived tickets from the picker', () => {
    expect(isHiddenFromTicketPicker(ref)).toBe(false)
    expect(
      isHiddenFromTicketPicker({ ...ref, external_provider: DOCUMENT_RUN_TICKET_PROVIDER })
    ).toBe(true)
    expect(
      isHiddenFromTicketPicker({
        ...ref,
        external_provider: SHELL_COMMAND_TICKET_PROVIDER,
        external_id: 'cmd-1'
      })
    ).toBe(true)
    expect(isHiddenFromTicketPicker({ ...ref, archived_at: '2026-01-01' })).toBe(true)
    // Another integration's ticket (GitHub, Jira…) is an ordinary ticket here.
    expect(isHiddenFromTicketPicker({ ...ref, external_provider: 'github' })).toBe(false)
  })

  it('sorts tickets the way the board reads: column by column, each in its order', () => {
    const sorted = sortBoardTickets([
      { id: 'd', column: 'done', sort_order: 0 },
      { id: 't2', column: 'todo', sort_order: 2 },
      { id: 'p', column: 'in_progress', sort_order: 0 },
      { id: 't1', column: 'todo', sort_order: 1 }
    ])
    expect(sorted.map((ticket) => ticket.id)).toEqual(['t1', 't2', 'p', 'd'])
  })

  it('searches by title and by key, ignoring case', () => {
    const ticket = { title: 'Checkout button', ticket_prefix: 'TD', ticket_number: 12 }
    expect(ticketMatchesSearch(ticket, '')).toBe(true)
    expect(ticketMatchesSearch(ticket, 'CHECKOUT')).toBe(true)
    expect(ticketMatchesSearch(ticket, 'td-12')).toBe(true)
    expect(ticketMatchesSearch(ticket, 'td-13')).toBe(false)
    expect(ticketMatchesSearch({ ...ticket, ticket_prefix: null }, 'td')).toBe(false)
  })

  it('names a ticket by its key, else by its title', () => {
    expect(ticketLabel({ title: 'A', ticket_prefix: 'TD', ticket_number: 3 })).toBe('TD-3')
    expect(ticketLabel({ title: ' Login ', ticket_prefix: null, ticket_number: null })).toBe(
      '“Login”'
    )
  })

  it('maps tickets to the runs that still own them', () => {
    const preview = makeDetail({ id: 'run-a', title: '', source_kind: 'tickets' }, [
      { key: 'TD-1', ticket_id: 't1' },
      { key: 'TD-2', ticket_id: null }
    ])
    const finished = makeDetail({ id: 'run-b', status: 'completed' }, [
      { key: 'A1', ticket_id: 't9' }
    ])
    const owners = ticketRunOwners([preview, finished])
    expect(owners.get('t1')).toEqual({ runId: 'run-a', title: 'Orchestrator', status: 'preview' })
    // A finished run gave its tickets back.
    expect(owners.has('t9')).toBe(false)
    expect(owners.size).toBe(1)
  })

  it('counts only the blockers that still hold a ticket back', () => {
    const tickets = new Map([
      ['a', { column: 'todo' }],
      ['b', { column: 'done' }],
      ['c', { column: 'merged' }],
      ['d', { column: 'review' }]
    ])
    const blockers = new Map([['x', ['a', 'b', 'c', 'd', 'gone']]])
    expect(unresolvedBlockers('x', blockers, tickets)).toEqual([
      { column: 'todo' },
      { column: 'review' }
    ])
    expect(unresolvedBlockers('y', blockers, tickets)).toEqual([])
  })

  it('finds the joinable blockers left out of a pick, closing over theirs', () => {
    // d waits for c, c for b, b for a; e waits for f, which cannot join.
    const blockersOf = new Map([
      ['d', ['c']],
      ['c', ['b']],
      ['b', ['a']],
      ['e', ['f']]
    ])
    const canJoin = (id: string): boolean => id !== 'f'
    const result = missingBlockers(['d', 'e'], blockersOf, canJoin, ['a', 'b', 'c', 'd', 'e', 'f'])
    expect(result.dependents).toEqual([{ ticketId: 'd', missing: ['c'] }])
    expect(result.closure).toEqual(['a', 'b', 'c'])
    // Picked already: nothing is missing.
    expect(missingBlockers(['a', 'b', 'c', 'd'], blockersOf, canJoin).dependents).toEqual([])
  })

  it('words the missing-blockers note for one and for several picked tickets', () => {
    const labelOf = (id: string): string => id.toUpperCase()
    expect(describeMissingBlockers([], labelOf)).toBeNull()
    expect(describeMissingBlockers([{ ticketId: 'td-1', missing: ['x', 'y'] }], labelOf)).toBe(
      'TD-1 waits for 2 tickets you have not picked.'
    )
    expect(describeMissingBlockers([{ ticketId: 'td-1', missing: ['x'] }], labelOf)).toBe(
      'TD-1 waits for a ticket you have not picked.'
    )
    expect(
      describeMissingBlockers(
        [
          { ticketId: 'a', missing: ['x'] },
          { ticketId: 'b', missing: ['y'] }
        ],
        labelOf
      )
    ).toBe('2 picked tickets wait for tickets you have not picked.')
  })

  it('orders picked tickets blockers first, otherwise in board order', () => {
    const board = ['a', 'b', 'c', 'd']
    // a waits for c; d waits for b. Picked in click order d, a, c, b.
    const blockersOf = new Map([
      ['a', ['c']],
      ['d', ['b', 'zz']]
    ])
    expect(orderTicketIdsForRun(['d', 'a', 'c', 'b'], board, blockersOf)).toEqual([
      'c',
      'a',
      'b',
      'd'
    ])
    // A cycle on the board (it refuses them, but a stale map could hold one) still ends.
    const cyclic = new Map([
      ['a', ['b']],
      ['b', ['a']]
    ])
    expect(orderTicketIdsForRun(['a', 'b'], board, cyclic)).toHaveLength(2)
  })

  it('reads the counts and the add button', () => {
    expect(ticketRunMeta([{ selected: true }, { selected: false }])).toBe('2 tickets · 1 selected')
    expect(addTicketsLabel(0, false)).toBe('Add tickets')
    expect(addTicketsLabel(1, false)).toBe('Add 1 ticket')
    expect(addTicketsLabel(3, true)).toBe('Add & resume')
  })

  it('splits the prompt into the brief and the rules, together exactly what is sent', () => {
    const ticket = {
      title: 'Fix login',
      description: 'The button does nothing.',
      attachments: [{ type: 'image', url: '/tmp/a.png', label: 'shot' }]
    }
    const rules = {
      interactive: false,
      sdk: 'claude-code' as const,
      verification: ['tests' as const],
      workspace: null
    }
    const parts = ticketRunPromptParts(ticket, rules)
    expect(parts.brief).toContain('<ticket title="Fix login">The button does nothing.')
    expect(parts.brief).toContain('<file path="/tmp/a.png">shot</file>')
    expect(parts.rules).not.toContain('Fix login')
    expect(`${parts.brief}\n\n${parts.rules}`).toBe(buildTicketRunPrompt(ticket, rules))
  })
})
