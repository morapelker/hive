import { describe, expect, it } from 'vitest'
import { DOCUMENT_RUN_STATUSES, type DocumentRunStatus } from '../types/document-flow'
import {
  addingTicketsResumesRun,
  canAddTicketsToRun,
  defaultTicketRunTitle,
  dependsOnFromBoard,
  launchConfigFromQueued,
  mintTicketRunKeys,
  runKindLabel,
  runOwnsItsTickets,
  ticketRunItemDraft,
  ticketRunRefusal,
  type TicketRunCandidate
} from './ticket-runs'

const candidate = (fields: Partial<TicketRunCandidate> = {}): TicketRunCandidate => ({
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Add the checkout button',
  description: 'Put it under the cart.',
  column: 'todo',
  archived_at: null,
  current_session_id: null,
  external_provider: null,
  external_id: null,
  ticket_prefix: 'TD',
  ticket_number: 12,
  ...fields
})

describe('which runs own and take tickets', () => {
  it('a run owns its tickets until it has ended', () => {
    const owning = DOCUMENT_RUN_STATUSES.filter(runOwnsItsTickets)

    expect(owning).toEqual(['extracting', 'extract_failed', 'preview', 'running', 'paused'])
  })

  it.each<[DocumentRunStatus, boolean, boolean]>([
    ['preview', true, false],
    ['running', true, false],
    ['paused', true, false],
    ['completed', true, true],
    ['completed_with_issues', true, true],
    ['cancelled', false, false],
    ['extracting', false, false],
    ['extract_failed', false, false]
  ])('a %s orchestrator takes tickets: %s, resuming: %s', (status, takes, resumes) => {
    expect(canAddTicketsToRun({ source_kind: 'tickets', status, migration_session_id: null })).toBe(
      takes
    )
    expect(addingTicketsResumesRun({ status })).toBe(resumes)
  })

  it('a document run, and an orchestrator whose migrations are being executed, take none', () => {
    expect(
      canAddTicketsToRun({ source_kind: 'document', status: 'running', migration_session_id: null })
    ).toBe(false)
    expect(
      canAddTicketsToRun({
        source_kind: 'tickets',
        status: 'completed',
        migration_session_id: 'session-1'
      })
    ).toBe(false)
  })
})

describe('ticketRunRefusal', () => {
  it('takes a ticket in To Do, and a queued one left In Progress without a session', () => {
    expect(ticketRunRefusal(candidate(), null)).toBeNull()
    expect(ticketRunRefusal(candidate({ column: 'in_progress' }), null)).toBeNull()
  })

  it.each<[string, Partial<TicketRunCandidate>, string]>([
    [
      'the ticket of a run',
      { external_provider: 'document-run', external_id: 'run-1' },
      'An orchestrator ticket cannot be part of another run.'
    ],
    [
      'a shell command',
      { external_provider: 'shell-command', external_id: 'cmd-1' },
      'A shell command ticket runs no agent.'
    ],
    ['an archived ticket', { archived_at: '2026-11-01T00:00:00.000Z' }, 'It is archived.'],
    [
      'a launched ticket',
      { current_session_id: 'session-1', column: 'in_progress' },
      'It already has a session. Only tickets that have not been launched can be orchestrated.'
    ],
    [
      'a ticket in Review',
      { column: 'review' },
      'It is in Review; only tickets that have not been launched can be orchestrated.'
    ],
    [
      'a ticket in an unknown column',
      { column: 'later' },
      'It is in later; only tickets that have not been launched can be orchestrated.'
    ]
  ])('refuses %s', (_name, fields, reason) => {
    expect(ticketRunRefusal(candidate(fields), null)).toBe(reason)
  })

  it('names the run that holds the ticket, or says it is in this one', () => {
    const owner = { runId: 'run-1', title: 'Checkout', status: 'running' as const }

    expect(ticketRunRefusal(candidate(), owner)).toBe('It is already part of “Checkout”.')
    expect(ticketRunRefusal(candidate(), owner, 'run-2')).toBe('It is already part of “Checkout”.')
    expect(ticketRunRefusal(candidate(), owner, 'run-1')).toBe('It is already part of this run.')
  })

  it('reports a shell command without an id as an ordinary ticket', () => {
    expect(ticketRunRefusal(candidate({ external_provider: 'shell-command' }), null)).toBeNull()
  })
})

describe('mintTicketRunKeys', () => {
  it("uses the tickets' own keys, else T1, T2, … past the keys taken", () => {
    expect(
      mintTicketRunKeys(
        [
          { ticket_prefix: 'TD', ticket_number: 4 },
          { ticket_prefix: null, ticket_number: null },
          { ticket_prefix: 'TD', ticket_number: null },
          { ticket_prefix: null, ticket_number: 7 }
        ],
        ['T1', 'T3']
      )
    ).toEqual(['TD-4', 'T2', 'T4', 'T5'])
  })

  it('suffixes a key that is taken already, or repeated', () => {
    expect(
      mintTicketRunKeys(
        [
          { ticket_prefix: 'TD', ticket_number: 4 },
          { ticket_prefix: 'TD', ticket_number: 4 },
          { ticket_prefix: 'TD', ticket_number: 5 }
        ],
        ['TD-5', 'TD-5-2']
      )
    ).toEqual(['TD-4', 'TD-4-2', 'TD-5-3'])
  })
})

describe('defaultTicketRunTitle', () => {
  it('is the first title on one line, counting the others', () => {
    expect(defaultTicketRunTitle([{ title: '  Add\n the  button ' }])).toBe('Add the button')
    expect(defaultTicketRunTitle([{ title: 'Add' }, { title: 'B' }, { title: 'C' }])).toBe(
      'Add + 2 more'
    )
  })

  it('shortens a long first title and falls back when there is none', () => {
    const title = defaultTicketRunTitle([{ title: 'x'.repeat(80) }])

    expect(title).toBe(`${'x'.repeat(59)}…`)
    expect(defaultTicketRunTitle([{ title: '   ' }, { title: 'B' }])).toBe('Orchestrator + 1 more')
    expect(defaultTicketRunTitle([])).toBe('Orchestrator')
  })
})

describe('launchConfigFromQueued', () => {
  it('reads the model of a queued launch', () => {
    expect(
      launchConfigFromQueued(
        JSON.stringify({
          worktree: 'new',
          sdk: 'codex',
          model: { providerID: 'openai', modelID: 'gpt', variant: 'high' },
          codexFastMode: true,
          customProviderId: 'custom-1'
        })
      )
    ).toEqual({
      sdk: 'codex',
      model: { providerID: 'openai', modelID: 'gpt', variant: 'high' },
      codexFastMode: true,
      customProviderId: 'custom-1'
    })
  })

  it('keeps the first model of a multi-model queue, the rest of the queue filling in', () => {
    expect(
      launchConfigFromQueued(
        JSON.stringify({
          sdk: 'claude-code-cli',
          codexFastMode: false,
          models: [
            { model: { providerID: 'anthropic', modelID: 'opus' } },
            { sdk: 'codex', model: { providerID: 'openai', modelID: 'gpt' } }
          ]
        })
      )
    ).toEqual({
      sdk: 'claude-code-cli',
      model: { providerID: 'anthropic', modelID: 'opus' },
      codexFastMode: false
    })
  })

  it('drops a model it cannot read, and a queue without an sdk or that is not JSON', () => {
    expect(launchConfigFromQueued(JSON.stringify({ sdk: 'codex', model: { id: 'x' } }))).toEqual({
      sdk: 'codex',
      model: null,
      codexFastMode: false
    })
    expect(launchConfigFromQueued(JSON.stringify({ model: null }))).toBeNull()
    expect(launchConfigFromQueued('{not json')).toBeNull()
    expect(launchConfigFromQueued('')).toBeNull()
    expect(launchConfigFromQueued(null)).toBeNull()
    expect(launchConfigFromQueued(undefined)).toBeNull()
  })
})

describe('ticketRunItemDraft', () => {
  it('makes the ticket the task: its title, its description, nothing extracted', () => {
    const draft = ticketRunItemDraft(
      candidate({
        title: ' Add \n the button ',
        pending_launch_config: JSON.stringify({ sdk: 'codex' })
      }),
      'TD-12'
    )

    expect(draft).toMatchObject({
      key: 'TD-12',
      title: 'Add the button',
      summary: '',
      description: 'Put it under the cart.',
      kind: 'change',
      depends_on: [],
      has_migration: false,
      doc_status: 'open',
      selected: true,
      figures: [],
      open_questions: [],
      verification: [],
      launch_config: { sdk: 'codex', model: null, codexFastMode: false },
      ticket_id: 'ticket-1'
    })
  })

  it('titles an untitled ticket by its key and keeps no description it lacks', () => {
    expect(ticketRunItemDraft(candidate({ title: ' ', description: null }), 'T1')).toMatchObject({
      title: 'T1',
      description: '',
      launch_config: null
    })
  })
})

describe('dependsOnFromBoard', () => {
  it('keeps only edges between two tickets of the run, in item order, once each', () => {
    const items = [
      { key: 'A', ticket_id: 'a' },
      { key: 'B', ticket_id: 'b' },
      { key: 'C', ticket_id: 'c' },
      { key: 'D', ticket_id: null }
    ]

    expect(
      dependsOnFromBoard(items, [
        { dependent_id: 'c', blocker_id: 'b' },
        { dependent_id: 'c', blocker_id: 'a' },
        { dependent_id: 'c', blocker_id: 'a' },
        { dependent_id: 'b', blocker_id: 'outside' },
        { dependent_id: 'outside', blocker_id: 'a' },
        { dependent_id: 'a', blocker_id: 'a' }
      ])
    ).toEqual({ A: [], B: [], C: ['A', 'B'], D: [] })
  })
})

describe('runKindLabel', () => {
  it('tells an orchestrator from a document run', () => {
    expect(runKindLabel({ source_kind: 'tickets' })).toBe('Orchestrator')
    expect(runKindLabel({ source_kind: 'document' })).toBe('Document run')
    expect(runKindLabel(null)).toBe('Document run')
    expect(runKindLabel(undefined)).toBe('Document run')
  })
})
