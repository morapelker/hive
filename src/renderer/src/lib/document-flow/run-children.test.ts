import { describe, expect, it } from 'vitest'
import { childColumnCounts, nestedRunChildIds, runChildrenOf } from './run-children'
import type { KanbanTicket } from '../../../../main/db/types'

const now = '2026-06-01T00:00:00.000Z'

function ticket(overrides: Partial<KanbanTicket>): KanbanTicket {
  return {
    id: 'ticket',
    project_id: 'proj-1',
    title: 'Ticket',
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
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
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

const run = (overrides: Partial<KanbanTicket> = {}): KanbanTicket =>
  ticket({
    id: 'run-ticket',
    column: 'in_progress',
    external_provider: 'document-run',
    external_id: 'run-1',
    ...overrides
  })

const child = (id: string, overrides: Partial<KanbanTicket> = {}): KanbanTicket =>
  ticket({ id, parent_ticket_id: 'run-ticket', ...overrides })

describe('nestedRunChildIds', () => {
  it('folds the tickets of a run that is on the board, and nothing else', () => {
    const ids = nestedRunChildIds([
      run(),
      child('a', { column: 'merged' }),
      child('b', { column: 'in_progress' }),
      ticket({ id: 'plain' }),
      // A child of a ticket that is not a run keeps its card
      ticket({ id: 'odd', parent_ticket_id: 'plain' }),
      // A child of a run that is not on this board (deleted, another project) keeps its card
      ticket({ id: 'orphan', parent_ticket_id: 'gone-run' })
    ])
    expect([...ids].sort()).toEqual(['a', 'b'])
  })

  it('does not fold the tickets of an archived run, nor archived tickets', () => {
    expect(nestedRunChildIds([run({ archived_at: now }), child('a')]).size).toBe(0)
    expect(nestedRunChildIds([run(), child('a', { archived_at: now })]).size).toBe(0)
  })

  it('is empty on a board without runs', () => {
    expect(nestedRunChildIds([ticket({ id: 'x' }), ticket({ id: 'y' })]).size).toBe(0)
  })
})

describe('runChildrenOf', () => {
  it('lists the rows by column, then by the board order within the column', () => {
    const rows = runChildrenOf(
      [
        run(),
        child('done-1', { column: 'done' }),
        child('todo-2', { column: 'todo', sort_order: 2 }),
        child('prog-1', { column: 'in_progress' }),
        child('todo-1', { column: 'todo', sort_order: 1 }),
        child('review-1', { column: 'review' }),
        child('merged-1', { column: 'merged' }),
        child('archived', { column: 'todo', archived_at: now }),
        ticket({ id: 'other-run-child', parent_ticket_id: 'other' })
      ],
      'run-ticket'
    )
    expect(rows.map((r) => r.id)).toEqual([
      'todo-1',
      'todo-2',
      'prog-1',
      'review-1',
      'merged-1',
      'done-1'
    ])
  })
})

describe('childColumnCounts', () => {
  it('counts the rows per column', () => {
    expect(
      childColumnCounts([
        child('a', { column: 'todo' }),
        child('b', { column: 'in_progress' }),
        child('c', { column: 'in_progress' }),
        child('d', { column: 'merged' })
      ])
    ).toEqual({ todo: 1, in_progress: 2, review: 0, merged: 1, done: 0 })
  })
})
