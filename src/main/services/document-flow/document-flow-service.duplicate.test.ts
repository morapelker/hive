// @vitest-environment node
// `duplicateRun`: a fresh copy of a run, back in the preview with its own ticket in To Do. What
// the user chose on the original comes along (config, each ticket's model, verification and
// selection); nothing of what the original did does. A document run is copied with its
// extraction and files; an orchestrator made from board tickets gets copies of its tickets.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCUMENT_RUN_TICKET_PROVIDER } from '@shared/document-flow/run-ticket'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  type DocumentRunConfig,
  type DocumentRunItem,
  type DocumentRunLaunchConfig
} from '@shared/types/document-flow'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  TEST_PROJECT_ID,
  createServiceHarness,
  seedRun,
  type FakeBoardTicket,
  type ServiceHarness
} from './test-support'

let harness: ServiceHarness

beforeEach(() => {
  harness = createServiceHarness()
})

afterEach(() => {
  harness.cleanup()
})

const opus: DocumentRunLaunchConfig = {
  sdk: 'claude-code',
  model: { providerID: 'anthropic', modelID: 'claude-opus', variant: 'high' },
  codexFastMode: false
}
const codex: DocumentRunLaunchConfig = { sdk: 'codex', model: null, codexFastMode: true }

/** A config with nothing left at its default. */
const chosenConfig: DocumentRunConfig = {
  ...DEFAULT_DOCUMENT_RUN_CONFIG,
  maxParallel: 7,
  verifyCommand: 'pnpm check',
  interactive: false,
  promptStyle: 'small',
  defaultLaunch: opus,
  generation: { provider: 'codex', model: 'gpt-5', effort: 'high' },
  baseBranch: 'develop',
  notes: 'only tasks A1 and A2',
  verificationDisabled: true
}

const itemsOf = (runId: string): DocumentRunItem[] => harness.db.getDocumentRunItems(runId)
const board = (id: string): FakeBoardTicket => {
  const found = harness.boardTickets.get(id)
  if (!found) throw new Error(`no board ticket ${id}`)
  return found
}
const runTicketsOf = (runId: string): FakeBoardTicket[] =>
  [...harness.boardTickets.values()].filter(
    (ticket) =>
      ticket.external_provider === DOCUMENT_RUN_TICKET_PROVIDER && ticket.external_id === runId
  )
/** Fire-and-forget board writes (the parent links) land. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('duplicateRun — a document run', () => {
  /** A cancelled run that launched: files on disk, one ticket merged, one that never started. */
  function seedCancelled(): { id: string; runDir: string } {
    const { run } = seedRun(harness, {
      run: {
        status: 'cancelled',
        config: chosenConfig,
        base_branch: 'develop',
        base_sha: 'abc123',
        integration_branch: 'doc-factory',
        integration_worktree_id: 'wt-integration',
        integration_worktree_path: '/worktrees/doc-factory',
        ticket_id: 'run-ticket-old',
        started_at: '2026-01-01T00:00:00.000Z',
        finished_at: '2026-01-02T00:00:00.000Z',
        extraction: {
          documentTitle: 'Factory spec',
          numbering: 'A1…A2',
          openQuestions: ['Which database?'],
          warnings: [],
          generatedBy: 'claude-code · opus',
          textLength: 120,
          figureCount: 1
        }
      },
      items: [
        {
          key: 'A1',
          title: 'Add the schema',
          status: 'merged',
          launch_config: codex,
          verification: ['tests'],
          ticket_id: 'ticket-a1',
          worktree_id: 'wt-a1',
          session_id: 'session-a1',
          branch_name: 'a1-add-the-schema',
          merge_sha: 'def456',
          started_at: '2026-01-01T00:00:00.000Z',
          finished_at: '2026-01-01T01:00:00.000Z'
        },
        {
          key: 'A2',
          title: 'Wire the API',
          status: 'cancelled',
          depends_on: ['A1'],
          selected: false,
          finished_at: '2026-01-02T00:00:00.000Z'
        }
      ]
    })
    const runDir = run.run_dir
    mkdirSync(join(runDir, 'figures'), { recursive: true })
    mkdirSync(join(runDir, 'doc-backups'), { recursive: true })
    writeFileSync(join(runDir, 'document.md'), '[1] # Factory spec\n')
    writeFileSync(join(runDir, 'figures', 'fig-01.png'), 'png-bytes')
    writeFileSync(join(runDir, 'doc-backups', 'A1-backup.html'), 'old')
    harness.db.updateDocumentRun(run.id, { document_path: join(runDir, 'document.md') })
    const [first] = itemsOf(run.id)
    harness.db.updateDocumentRunItem(first.id, {
      description: `Implement A1.\n- Full text: ${join(runDir, 'document.md')}`
    })
    // Figures are not part of the patch type: stored the way extraction stores them.
    harness.db.items.set(first.id, {
      ...(harness.db.items.get(first.id) as DocumentRunItem),
      figures: [{ id: 'fig-01', path: join(runDir, 'figures', 'fig-01.png'), label: 'Figure 1' }]
    })
    return { id: run.id, runDir }
  }

  it('makes a new run in the preview with the config, the extraction and every item, pending again', async () => {
    const source = seedCancelled()

    const { run, items } = await harness.service.duplicateRun(source.id)

    expect(run.id).not.toBe(source.id)
    expect(run).toMatchObject({
      project_id: TEST_PROJECT_ID,
      title: 'Factory spec',
      source_kind: 'document',
      source_path: '/specs/factory.html',
      status: 'preview',
      config: chosenConfig,
      extraction: { documentTitle: 'Factory spec', openQuestions: ['Which database?'] },
      // Nothing of the launch the original went through
      base_branch: null,
      base_sha: null,
      integration_branch: null,
      integration_worktree_id: null,
      integration_worktree_path: null,
      report: null,
      started_at: null,
      finished_at: null
    })
    expect(items.map((item) => item.key)).toEqual(['A1', 'A2'])
    expect(items[0]).toMatchObject({
      title: 'Add the schema',
      launch_config: codex,
      verification: ['tests'],
      selected: true,
      status: 'pending',
      ticket_id: null,
      worktree_id: null,
      session_id: null,
      branch_name: null,
      merge_sha: null,
      started_at: null,
      finished_at: null
    })
    expect(items[1]).toMatchObject({
      title: 'Wire the API',
      depends_on: ['A1'],
      selected: false,
      launch_config: null,
      status: 'pending',
      finished_at: null
    })
  })

  it('gives the copy a ticket of its own in To Do and leaves the original as it was', async () => {
    const source = seedCancelled()
    const before = structuredClone({
      run: harness.db.getDocumentRun(source.id),
      items: itemsOf(source.id)
    })

    const { run } = await harness.service.duplicateRun(source.id)

    const tickets = runTicketsOf(run.id)
    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({ column: 'todo', title: 'Factory spec', worktree_id: null })
    expect(run.ticket_id).toBe(tickets[0].id)
    expect(run.ticket_id).not.toBe('run-ticket-old')
    expect({ run: harness.db.getDocumentRun(source.id), items: itemsOf(source.id) }).toEqual(before)
    expect(harness.db.events.some((event) => event.run_id === run.id && event.type === 'created')).toBe(true)
    expect(harness.published.some((event) => event.runId === run.id)).toBe(true)
  })

  it('copies the files into a run directory of its own and points every path there', async () => {
    const source = seedCancelled()

    const { run, items } = await harness.service.duplicateRun(source.id)

    expect(run.run_dir).toBe(join(harness.runsRoot, run.id))
    expect(run.document_path).toBe(join(run.run_dir, 'document.md'))
    expect(readFileSync(join(run.run_dir, 'document.md'), 'utf8')).toBe('[1] # Factory spec\n')
    expect(readFileSync(join(run.run_dir, 'figures', 'fig-01.png'), 'utf8')).toBe('png-bytes')
    // The backups of the document belong to the original's edits
    expect(existsSync(join(run.run_dir, 'doc-backups'))).toBe(false)
    expect(items[0].figures).toEqual([
      { id: 'fig-01', path: join(run.run_dir, 'figures', 'fig-01.png'), label: 'Figure 1' }
    ])
    expect(items[0].description).toBe(
      `Implement A1.\n- Full text: ${join(run.run_dir, 'document.md')}`
    )
    expect(JSON.stringify({ run, items })).not.toContain(source.runDir)

    // The copy survives its original
    await harness.service.delete(source.id, { removeFiles: true })
    expect(existsSync(source.runDir)).toBe(false)
    expect(existsSync(join(run.run_dir, 'document.md'))).toBe(true)
  })

  it('copies a run whose files are gone, and one whose extraction failed as that', async () => {
    const { run: bare } = seedRun(harness, { items: [{ key: 'A1' }] })
    const copy = await harness.service.duplicateRun(bare.id)
    expect(copy.run.status).toBe('preview')
    expect(copy.items.map((item) => item.key)).toEqual(['A1'])

    const { run: failed } = seedRun(harness, {
      run: { status: 'extract_failed', error: 'The model answered nothing.' }
    })
    const retry = await harness.service.duplicateRun(failed.id)
    expect(retry.run).toMatchObject({
      status: 'extract_failed',
      error: 'The model answered nothing.'
    })
    expect(retry.items).toEqual([])
  })

  it('refuses a run that is still extracting, and one that does not exist', async () => {
    const { run } = seedRun(harness, { run: { status: 'extracting' } })
    await expect(harness.service.duplicateRun(run.id)).rejects.toThrow(
      'Wait for the extraction to finish.'
    )
    await expect(harness.service.duplicateRun('nope')).rejects.toThrow('was not found')
    expect(harness.db.runs.size).toBe(1)
  })

  it('leaves no rows and no directory behind when the copy fails half-way', async () => {
    const source = seedCancelled()
    const replace = harness.db.replaceDocumentRunItems.bind(harness.db)
    harness.db.replaceDocumentRunItems = () => {
      throw new Error('disk full')
    }

    await expect(harness.service.duplicateRun(source.id)).rejects.toThrow('disk full')

    harness.db.replaceDocumentRunItems = replace
    expect([...harness.db.runs.keys()]).toEqual([source.id])
    expect(runTicketsOf(source.id)).toEqual([])
    // Only the original's directory is left, as it was
    expect(readdirSync(harness.runsRoot)).toEqual([source.id])
    expect(readFileSync(join(source.runDir, 'document.md'), 'utf8')).toBe('[1] # Factory spec\n')
  })
})

describe('duplicateRun — an orchestrator made from board tickets', () => {
  /**
   * A cancelled orchestrator of three tickets: the first merged and now in Done, the second (which
   * waited for the first) launched and cancelled, the third never started.
   */
  function seedCancelled(): { id: string; tickets: [string, string, string] } {
    const first = harness.addBoardTicket({
      title: 'Add the schema',
      description: 'Create the tables.',
      column: 'done',
      current_session_id: 'session-1',
      worktree_id: 'wt-1',
      parent_ticket_id: 'run-ticket-old'
    })
    const second = harness.addBoardTicket({
      title: 'Wire the API',
      description: 'Expose the tables.',
      column: 'review',
      current_session_id: 'session-2',
      worktree_id: 'wt-2',
      parent_ticket_id: 'run-ticket-old'
    })
    const third = harness.addBoardTicket({
      title: 'Write the docs',
      description: null,
      parent_ticket_id: 'run-ticket-old'
    })
    harness.boardDependencies.push({
      projectId: TEST_PROJECT_ID,
      dependent_id: second,
      blocker_id: first
    })
    const { run } = seedRun(harness, {
      run: {
        source_kind: 'tickets',
        status: 'cancelled',
        title: 'Storefront',
        config: chosenConfig,
        base_branch: 'main',
        integration_branch: 'orch-storefront',
        integration_worktree_id: 'wt-integration',
        ticket_id: 'run-ticket-old',
        started_at: '2026-01-01T00:00:00.000Z',
        finished_at: '2026-01-02T00:00:00.000Z'
      },
      items: [
        {
          key: 'TD-1',
          title: 'Add the schema',
          status: 'merged',
          ticket_id: first,
          launch_config: codex,
          verification: ['tests', 'playwright'],
          session_id: 'session-1',
          worktree_id: 'wt-1',
          merge_sha: 'def456'
        },
        {
          key: 'TD-2',
          title: 'Wire the API',
          status: 'cancelled',
          ticket_id: second,
          depends_on: ['TD-1'],
          session_id: 'session-2',
          worktree_id: 'wt-2'
        },
        { key: 'TD-3', title: 'Write the docs', status: 'cancelled', ticket_id: third }
      ]
    })
    return { id: run.id, tickets: [first, second, third] }
  }

  it('copies every ticket into To Do and adopts the copies into a new run in the preview', async () => {
    const source = seedCancelled()

    const { run, items } = await harness.service.duplicateRun(source.id)
    await settle()

    expect(run).toMatchObject({
      title: 'Storefront',
      source_kind: 'tickets',
      source_path: '',
      status: 'preview',
      config: chosenConfig,
      integration_branch: null,
      integration_worktree_id: null,
      started_at: null,
      finished_at: null
    })
    expect(harness.ticketDuplicates.map((copy) => copy.ticketId)).toEqual(source.tickets)
    const copies = harness.ticketDuplicates.map((copy) => copy.copyId)
    expect(items.map((item) => item.ticket_id)).toEqual(copies)
    expect(items.map((item) => item.title)).toEqual([
      'Add the schema',
      'Wire the API',
      'Write the docs'
    ])
    for (const item of items) {
      expect(item).toMatchObject({
        status: 'pending',
        session_id: null,
        worktree_id: null,
        merge_sha: null
      })
    }
    // Fresh tickets: To Do, no session or worktree, under the copy's own ticket
    const [runTicket] = runTicketsOf(run.id)
    expect(runTicket).toMatchObject({ column: 'todo', title: 'Storefront' })
    for (const id of copies) {
      expect(board(id)).toMatchObject({ column: 'todo', parent_ticket_id: runTicket.id })
      expect(board(id).current_session_id ?? null).toBeNull()
      expect(board(id).worktree_id ?? null).toBeNull()
    }
    expect(board(copies[0])).toMatchObject({
      title: 'Add the schema',
      description: 'Create the tables.'
    })
  })

  it('keeps each ticket’s model, verification and selection, and the graph between the copies', async () => {
    const source = seedCancelled()

    const { items } = await harness.service.duplicateRun(source.id)

    expect(items[0]).toMatchObject({ launch_config: codex, verification: ['tests', 'playwright'] })
    expect(items[1]).toMatchObject({ launch_config: null, verification: [] })
    expect(items[1].depends_on).toEqual([items[0].key])
    expect(items[2].depends_on).toEqual([])
    // The graph is the board's: the copy of the second waits for the copy of the first
    expect(harness.boardDependencies).toContainEqual({
      projectId: TEST_PROJECT_ID,
      dependent_id: items[1].ticket_id,
      blocker_id: items[0].ticket_id
    })
  })

  it('leaves the original run and its tickets alone', async () => {
    const source = seedCancelled()
    const before = structuredClone({
      run: harness.db.getDocumentRun(source.id),
      items: itemsOf(source.id),
      tickets: source.tickets.map(board)
    })

    await harness.service.duplicateRun(source.id)
    await settle()

    expect({
      run: harness.db.getDocumentRun(source.id),
      items: itemsOf(source.id),
      tickets: source.tickets.map(board)
    }).toEqual(before)
  })

  it('writes a ticket that left the board again from the run’s copy of it', async () => {
    const source = seedCancelled()
    harness.boardTickets.delete(source.tickets[2])

    const { items } = await harness.service.duplicateRun(source.id)

    expect(harness.ticketDuplicates).toHaveLength(2)
    expect(items).toHaveLength(3)
    expect(board(items[2].ticket_id as string)).toMatchObject({
      column: 'todo',
      title: 'Write the docs'
    })
  })

  it('can be launched like any orchestrator: the copies are free tickets', async () => {
    const source = seedCancelled()
    const { run } = await harness.service.duplicateRun(source.id)

    // A second duplicate of the same original is as independent as the first
    const again = await harness.service.duplicateRun(source.id)

    expect(again.run.id).not.toBe(run.id)
    const mine = new Set(itemsOf(run.id).map((item) => item.ticket_id))
    expect(itemsOf(again.run.id).every((item) => !mine.has(item.ticket_id))).toBe(true)
  })

  it('takes the copied tickets off the board again when the run cannot be made', async () => {
    const source = seedCancelled()
    const ticketsBefore = new Set(harness.boardTickets.keys())
    harness.overrides.getTicketDependencies = async () => {
      throw new Error('the board cannot be read')
    }

    await expect(harness.service.duplicateRun(source.id)).rejects.toThrow(
      'the board cannot be read'
    )

    expect(new Set(harness.boardTickets.keys())).toEqual(ticketsBefore)
    expect(harness.deletedTickets).toEqual(harness.ticketDuplicates.map((copy) => copy.copyId))
    expect([...harness.db.runs.keys()]).toEqual([source.id])
  })

  it('refuses a dependency the board will not take, and cleans up', async () => {
    const source = seedCancelled()
    harness.overrides.addTicketDependency = async () => ({
      success: false,
      error: 'The board is read-only'
    })

    await expect(harness.service.duplicateRun(source.id)).rejects.toThrow(
      'TD-2 could not wait for TD-1: The board is read-only'
    )

    expect(harness.deletedTickets).toHaveLength(3)
    expect([...harness.db.runs.keys()]).toEqual([source.id])
  })

  it('refuses an orchestrator with no tickets', async () => {
    const { run } = seedRun(harness, { run: { source_kind: 'tickets' } })
    await expect(harness.service.duplicateRun(run.id)).rejects.toThrow(
      'This orchestrator has no tickets to duplicate.'
    )
  })
})
