// @vitest-environment node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { integrationBranchHint } from '@shared/document-flow/planning'
import type { DocumentRunItem, DocumentRunStatus } from '@shared/types/document-flow'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  TEST_CONNECTION_PROJECT_ID,
  TEST_PROJECT_ID,
  createServiceHarness,
  createTestRepo,
  isolateGitConfig,
  seedRun,
  type FakeBoardTicket,
  type ServiceHarness,
  type TestRepo
} from './test-support'

// Orchestrators made from board tickets (`source_kind: 'tickets'`): adopting the user's own
// tickets into a run, keeping the run's graph in step with the board's dependencies, adding and
// removing tickets before and while it runs, and what such a run does not do (no document).

let restoreGitConfig: () => void
let repo: TestRepo
let harness: ServiceHarness

beforeAll(() => {
  restoreGitConfig = isolateGitConfig()
})

afterAll(() => {
  restoreGitConfig()
})

beforeEach(() => {
  repo = createTestRepo()
  harness = createServiceHarness({ repo })
})

afterEach(() => {
  harness.cleanup()
  repo.cleanup()
})

const ticket = (fields: Partial<FakeBoardTicket> = {}): string => harness.addBoardTicket(fields)
const board = (id: string): FakeBoardTicket => {
  const found = harness.boardTickets.get(id)
  if (!found) throw new Error(`no board ticket ${id}`)
  return found
}
/** `dependent` waits for `blocker` on the board. */
const edge = (dependent: string, blocker: string): void => {
  harness.boardDependencies.push({
    projectId: TEST_PROJECT_ID,
    dependent_id: dependent,
    blocker_id: blocker
  })
}
const create = (ticketIds: string[], title?: string | null) =>
  harness.service.createTicketRun({
    projectId: TEST_PROJECT_ID,
    ticketIds,
    ...(title !== undefined ? { title } : {})
  })
const itemsOf = (runId: string): DocumentRunItem[] => harness.db.getDocumentRunItems(runId)
const itemOf = (runId: string, key: string): DocumentRunItem => {
  const found = itemsOf(runId).find((item) => item.key === key)
  if (!found) throw new Error(`no item ${key}`)
  return found
}
const graphOf = (runId: string): Record<string, string[]> =>
  Object.fromEntries(itemsOf(runId).map((item) => [item.key, item.depends_on]))
const eventsOf = (runId: string, type: string) =>
  harness.db.events.filter((event) => event.run_id === runId && event.type === type)
/** Fire-and-forget board writes (the parent links) land. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * A launched run made from board tickets, on a real integration worktree, its own ticket on the
 * board in `runTicket`. Items name their board tickets through `ticket_id`.
 */
function seedLaunched(options: {
  status?: DocumentRunStatus
  runTicket?: 'in_progress' | 'review' | 'done'
  items: NonNullable<NonNullable<Parameters<typeof seedRun>[1]>['items']>
  worktreeStatus?: 'active' | 'archived'
}): string {
  const integration = repo.addWorktree('orch-factory', repo.baseSha)
  harness.worktrees.set('wt-integration', {
    id: 'wt-integration',
    path: integration,
    branch_name: 'orch-factory',
    status: options.worktreeStatus ?? 'active',
    base_branch: 'main'
  })
  const { run } = seedRun(harness, {
    run: {
      source_kind: 'tickets',
      status: options.status ?? 'running',
      base_branch: 'main',
      base_sha: repo.baseSha,
      integration_branch: 'orch-factory',
      integration_worktree_id: 'wt-integration',
      integration_worktree_path: integration,
      started_at: new Date().toISOString()
    },
    items: options.items
  })
  const runTicket = `run-ticket-${run.id}`
  harness.boardTickets.set(runTicket, {
    id: runTicket,
    projectId: TEST_PROJECT_ID,
    column: options.runTicket ?? 'in_progress',
    external_provider: 'document-run',
    external_id: run.id
  })
  harness.db.updateDocumentRun(run.id, { ticket_id: runTicket })
  return run.id
}

describe('createTicketRun', () => {
  it('makes a preview run of the tickets in the order given, keyed by their keys', async () => {
    const [first, second, third] = [ticket(), ticket(), ticket()]

    const detail = await create([third, first, second])

    expect(detail.run).toMatchObject({
      project_id: TEST_PROJECT_ID,
      source_kind: 'tickets',
      source_path: '',
      document_path: null,
      status: 'preview',
      title: 'Board ticket 3 + 2 more',
      run_dir: join(harness.runsRoot, detail.run.id),
      extraction: null
    })
    // Nothing is written for a run without a document.
    expect(existsSync(detail.run.run_dir)).toBe(false)
    expect(harness.generateCalls).toEqual([])
    expect(
      detail.items.map(({ key, position, ticket_id, status, selected, title, description }) => ({
        key,
        position,
        ticket_id,
        status,
        selected,
        title,
        description
      }))
    ).toEqual([
      {
        key: 'TD-3',
        position: 0,
        ticket_id: third,
        status: 'pending',
        selected: true,
        title: 'Board ticket 3',
        description: 'Do the thing of ticket 3.'
      },
      {
        key: 'TD-1',
        position: 1,
        ticket_id: first,
        status: 'pending',
        selected: true,
        title: 'Board ticket 1',
        description: 'Do the thing of ticket 1.'
      },
      {
        key: 'TD-2',
        position: 2,
        ticket_id: second,
        status: 'pending',
        selected: true,
        title: 'Board ticket 2',
        description: 'Do the thing of ticket 2.'
      }
    ])
    expect(eventsOf(detail.run.id, 'created').map((event) => event.message)).toEqual([
      'Orchestrator made from 3 board tickets: TD-3, TD-1, TD-2'
    ])
  })

  it('keys tickets of a board without ticket keys T1, T2, … and takes a title as one safe line', async () => {
    const ids = [
      ticket({ ticket_prefix: null, ticket_number: null }),
      ticket({ ticket_prefix: null, ticket_number: null })
    ]

    const detail = await create(ids, '  Checkout "polish" <round 2>\n')

    expect(detail.items.map((item) => item.key)).toEqual(['T1', 'T2'])
    expect(detail.run.title).toBe('Checkout polish round 2')
  })

  it('reads the dependencies between its own tickets from the board, and no others', async () => {
    const [a, b, c, outside] = [ticket(), ticket(), ticket(), ticket()]
    edge(b, a)
    edge(c, a)
    edge(c, b)
    edge(a, outside)
    edge(outside, b)

    const detail = await create([a, b, c])

    expect(graphOf(detail.run.id)).toEqual({
      'TD-1': [],
      'TD-2': ['TD-1'],
      'TD-3': ['TD-1', 'TD-2']
    })
  })

  it('breaks a loop the board holds between its tickets, and says so once', async () => {
    const [a, b] = [ticket(), ticket()]
    edge(a, b)
    edge(b, a)

    const detail = await create([a, b])

    // The edge pointing forward in the run's order goes: TD-1 no longer waits for TD-2.
    expect(graphOf(detail.run.id)).toEqual({ 'TD-1': [], 'TD-2': ['TD-1'] })
    expect(eventsOf(detail.run.id, 'dependency_warning')).toHaveLength(1)
  })

  it("puts the run's own ticket in To Do, without a document, and links the adopted tickets to it", async () => {
    const [a, b] = [ticket(), ticket()]

    const detail = await create([a, b])
    await settle()

    expect(detail.run.ticket_id).toBe('ticket-1')
    expect(harness.ticketBatches).toHaveLength(1)
    expect(harness.ticketBatches[0].drafts).toEqual([
      expect.objectContaining({
        title: 'Board ticket 1 + 1 more',
        description:
          'Orchestrator of 2 board tickets; open this ticket to review them and launch the run.',
        column: 'todo',
        external_provider: 'document-run',
        external_id: detail.run.id,
        external_url: null
      })
    ])
    expect(board('ticket-1').column).toBe('todo')
    expect(board(a).parent_ticket_id).toBe('ticket-1')
    expect(board(b).parent_ticket_id).toBe('ticket-1')
  })

  it('takes the model of a queued launch, drops the queue, and sends a queued ticket back to To Do', async () => {
    const queued = ticket({
      column: 'in_progress',
      pending_launch_config: JSON.stringify({
        worktree: 'new',
        mode: 'build',
        sdk: 'claude-code-cli',
        model: { providerID: 'anthropic', modelID: 'opus', variant: 'max' }
      })
    })
    const plain = ticket()

    const detail = await create([queued, plain])

    expect(itemOf(detail.run.id, 'TD-1').launch_config).toEqual({
      sdk: 'claude-code-cli',
      model: { providerID: 'anthropic', modelID: 'opus', variant: 'max' },
      codexFastMode: false
    })
    expect(itemOf(detail.run.id, 'TD-2').launch_config).toBeNull()
    expect(board(queued)).toMatchObject({ column: 'todo', pending_launch_config: null })
    expect(harness.ticketUpdates).toContainEqual({
      projectId: TEST_PROJECT_ID,
      ticketId: queued,
      patch: { pending_launch_config: null }
    })
    // Nothing to drop on the other one.
    expect(
      harness.ticketUpdates.filter(
        (update) => update.ticketId === plain && 'pending_launch_config' in update.patch
      )
    ).toEqual([])
  })

  it.each([
    [
      'a ticket that has a session',
      { current_session_id: 'session-1', column: 'in_progress' as const },
      'It already has a session'
    ],
    ['an archived ticket', { archived_at: '2026-11-01T00:00:00.000Z' }, 'It is archived.'],
    ['a ticket in Review', { column: 'review' as const }, 'It is in Review'],
    [
      'a shell command ticket',
      { external_provider: 'shell-command', external_id: 'cmd-1' },
      'A shell command ticket runs no agent.'
    ],
    [
      'the ticket of a run',
      { external_provider: 'document-run', external_id: 'run-x' },
      'An orchestrator ticket cannot be part of another run.'
    ]
  ])('refuses %s, and makes nothing', async (_name, fields, reason) => {
    const ok = ticket()
    const refused = ticket(fields)

    await expect(create([ok, refused])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining(`TD-2 cannot be orchestrated: ${reason}`)
    })
    expect(harness.db.runs.size).toBe(0)
    expect(harness.ticketBatches).toEqual([])
    expect(harness.ticketUpdates).toEqual([])
  })

  it('refuses a ticket another orchestrator holds, until that one has ended', async () => {
    const shared = ticket()
    const first = await create([shared], 'First')

    await expect(create([shared, ticket()])).rejects.toThrow(
      'TD-1 cannot be orchestrated: It is already part of “First”.'
    )

    harness.service.cancel(first.run.id)
    await expect(create([shared])).resolves.toMatchObject({ run: { status: 'preview' } })
  })

  it('names every ticket it refuses, and one that is gone from the board', async () => {
    const archived = ticket({ archived_at: '2026-11-01T00:00:00.000Z' })
    const elsewhere = ticket({ projectId: 'other-project' })

    await expect(create([archived, elsewhere, 'no-such-ticket'])).rejects.toThrow(
      "3 tickets cannot be orchestrated. TD-1: It is archived. A ticket: It is no longer on this project's board. A ticket: It is no longer on this project's board."
    )
  })

  it('refuses an empty pick, and a connection project with too few members', async () => {
    await expect(create([])).rejects.toThrow('Pick at least one ticket.')
    await expect(create(['  '])).rejects.toThrow('Pick at least one ticket.')

    harness.projects.set(TEST_CONNECTION_PROJECT_ID, {
      id: TEST_CONNECTION_PROJECT_ID,
      name: 'Both apps',
      path: join(harness.scratch, 'connection'),
      kind: 'connection',
      member_project_ids: JSON.stringify([TEST_PROJECT_ID])
    })
    await expect(
      harness.service.createTicketRun({
        projectId: TEST_CONNECTION_PROJECT_ID,
        ticketIds: [ticket({ projectId: TEST_CONNECTION_PROJECT_ID })]
      })
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'Both apps needs at least two member projects to run an orchestrator in; it has 1.'
    })
    expect(harness.db.runs.size).toBe(0)
  })

  it('adopts a ticket once when two orchestrators are made of it at the same time', async () => {
    const [a, b] = [ticket(), ticket()]

    const results = await Promise.allSettled([create([a], 'First'), create([a, b], 'Second')])

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'TD-1 cannot be orchestrated: It is already part of “First”.'
    })
    expect(harness.db.runs.size).toBe(1)
    expect(harness.db.findDocumentRunItemsByTicketId(a)).toHaveLength(1)
  })
})

describe('start', () => {
  it('launches on an orch- integration branch and creates no task tickets', async () => {
    const [a, b] = [ticket(), ticket()]
    edge(b, a)
    const { run } = await create([a, b], 'Checkout polish')

    const detail = await harness.service.start(run.id)

    const branch = integrationBranchHint('Checkout polish', 'tickets')
    expect(branch).toBe('orch-checkout-polish')
    expect(detail.run).toMatchObject({
      status: 'running',
      base_branch: 'main',
      integration_branch: branch,
      ticket_id: 'ticket-1'
    })
    expect(harness.worktreeRequests.map((request) => request.nameHint)).toEqual([branch])
    // Only the run's own ticket was ever created: the items keep the user's tickets.
    expect(harness.ticketBatches).toHaveLength(1)
    expect(detail.items.map((item) => item.ticket_id)).toEqual([a, b])
    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': ['TD-1'] })
    expect(board('ticket-1')).toMatchObject({
      column: 'in_progress',
      description: `Orchestrator of 2 board tickets. Its branch ${branch} collects the merged work of its tickets; move this ticket to Done to merge it into main.`
    })
  })

  it('lets a ticket left unchecked in the preview go at launch: unlinked, free to orchestrate again', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    edge(c, b)
    const { run } = await create([a, b, c])
    await settle()
    expect(board(b).parent_ticket_id).toBe('ticket-1')
    harness.service.updateItem(run.id, itemOf(run.id, 'TD-2').id, { selected: false })

    const detail = await harness.service.start(run.id)
    await settle()

    expect(detail.items.map((item) => item.key)).toEqual(['TD-1', 'TD-3'])
    // TD-3 waited for TD-2, which is no longer in the run: it waits for nothing in it.
    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-3': [] })
    expect(board(b).parent_ticket_id ?? null).toBeNull()
    expect(board('ticket-1').description).toContain('Orchestrator of 2 board tickets')
    // The ticket is free: another orchestrator takes it.
    const other = await create([b], 'Second')
    expect(other.items.map((item) => item.ticket_id)).toEqual([b])
  })

  it('reads the board again at launch: edits made since reach the items', async () => {
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])
    board(a).title = 'Renamed "on" the board'
    board(a).description = 'New brief.'
    edge(a, b)

    await harness.service.start(run.id)

    expect(itemOf(run.id, 'TD-1')).toMatchObject({
      title: 'Renamed on the board',
      description: 'New brief.',
      depends_on: ['TD-2']
    })
  })

  it('drops a launch the board queued on a ticket since, and shows the model each launches with', async () => {
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])
    harness.db.updateDocumentRunItem(itemOf(run.id, 'TD-2').id, {
      launch_config: {
        sdk: 'claude-code-cli',
        model: { providerID: 'anthropic', modelID: 'sonnet' },
        codexFastMode: false
      }
    })
    board(a).pending_launch_config = '{"sdk":"claude-code"}'

    await harness.service.start(run.id)
    await settle()

    expect(board(a).pending_launch_config).toBeNull()
    expect(harness.ticketUpdates).toContainEqual({
      projectId: TEST_PROJECT_ID,
      ticketId: b,
      patch: { model_provider_id: 'anthropic', model_id: 'sonnet', model_variant: null }
    })
  })

  it.each([
    [
      'was launched from the board',
      (id: string) => {
        board(id).current_session_id = 'session-9'
      },
      'TD-1 was launched from the board; close its session or remove it from the orchestrator.'
    ],
    [
      'is gone from the board',
      (id: string) => {
        harness.boardTickets.delete(id)
      },
      'TD-1 is no longer on the board; remove it from the orchestrator.'
    ],
    [
      'was archived',
      (id: string) => {
        board(id).archived_at = '2026-11-01T00:00:00.000Z'
      },
      'TD-1 is archived; unarchive it or remove it from the orchestrator.'
    ],
    [
      'was moved to Review',
      (id: string) => {
        board(id).column = 'review'
      },
      'TD-1 was moved to Review on the board; move it back or remove it from the orchestrator.'
    ],
    [
      'was moved to Done',
      (id: string) => {
        board(id).column = 'done'
      },
      'TD-1 was moved to Done on the board; move it back or remove it from the orchestrator.'
    ],
    [
      'was moved to Merged',
      (id: string) => {
        board(id).column = 'merged'
      },
      'TD-1 was moved to Merged on the board; move it back or remove it from the orchestrator.'
    ]
  ])('refuses to launch a ticket that %s meanwhile', async (_name, change, message) => {
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])
    change(a)

    await expect(harness.service.start(run.id)).rejects.toThrow(message)

    expect(harness.db.getDocumentRun(run.id)?.status).toBe('preview')
    expect(harness.worktreeRequests).toEqual([])
  })

  it('launches a ticket that sits In Progress without a session, which has not started', async () => {
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])
    board(a).column = 'in_progress'

    await expect(harness.service.start(run.id)).resolves.toMatchObject({
      run: { status: 'running' }
    })
  })

  it('takes a ticket whose session has closed: the launch clears the stale link', async () => {
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])
    board(a).current_session_id = 'session-closed'
    harness.overrides.isSessionActive = (sessionId) => sessionId !== 'session-closed'

    const detail = await harness.service.start(run.id)

    expect(detail.run.status).toBe('running')
    expect(board(a).current_session_id).toBeNull()
    expect(harness.ticketUpdates).toContainEqual({
      projectId: TEST_PROJECT_ID,
      ticketId: a,
      patch: { current_session_id: null }
    })
  })

  it('refuses a ticket whose session is still open, and leaves its link', async () => {
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])
    board(a).current_session_id = 'session-open'
    harness.overrides.isSessionActive = () => true

    await expect(harness.service.start(run.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message:
        'TD-1 was launched from the board; close its session or remove it from the orchestrator.'
    })

    expect(board(a).current_session_id).toBe('session-open')
  })

  it('changes nothing when it refuses a launch: unchecked tickets and queued launches stay', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    edge(c, b)
    const { run } = await create([a, b, c])
    await settle()
    harness.service.updateItem(run.id, itemOf(run.id, 'TD-2').id, { selected: false })
    board(c).pending_launch_config = '{"sdk":"claude-code"}'
    board(c).title = 'Renamed since'
    board(a).archived_at = '2026-11-01T00:00:00.000Z'
    const items = itemsOf(run.id)
    const description = board('ticket-1').description

    await expect(harness.service.start(run.id)).rejects.toThrow('TD-1 is archived')

    expect(itemsOf(run.id)).toEqual(items)
    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': [], 'TD-3': ['TD-2'] })
    expect(board(b).parent_ticket_id).toBe('ticket-1')
    expect(board(c).pending_launch_config).toBe('{"sdk":"claude-code"}')
    expect(board('ticket-1').description).toBe(description)
    expect(eventsOf(run.id, 'ticket_removed')).toEqual([])
  })

  it('never links an unchecked ticket to a run ticket made at launch', async () => {
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])
    await settle()
    harness.service.updateItem(run.id, itemOf(run.id, 'TD-2').id, { selected: false })
    // The run's card is gone from the board, so the launch makes a new one and links the items.
    harness.boardTickets.delete(run.ticket_id as string)
    const parents: unknown[] = []
    harness.overrides.updateTicket = async (projectId, ticketId, patch) => {
      if (ticketId === b && patch.parent_ticket_id) parents.push(patch.parent_ticket_id)
      return harness.fakes.updateTicket(projectId, ticketId, patch)
    }

    await harness.service.start(run.id)
    await settle()

    expect(parents).toEqual([])
    expect(board(a).parent_ticket_id).toBe(harness.db.getDocumentRun(run.id)?.ticket_id)
  })

  it('keeps an unchecked ticket when the integration cannot be made, and lets it go on the retry', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    edge(c, b)
    const { run } = await create([a, b, c])
    await settle()
    harness.service.updateItem(run.id, itemOf(run.id, 'TD-2').id, { selected: false })
    harness.overrides.createWorktreeFromBranch = async () => ({
      success: false,
      error: 'disk full'
    })

    await expect(harness.service.start(run.id)).rejects.toThrow('disk full')

    expect(harness.db.getDocumentRun(run.id)?.status).toBe('preview')
    expect(itemsOf(run.id).map((item) => [item.key, item.selected])).toEqual([
      ['TD-1', true],
      ['TD-2', false],
      ['TD-3', true]
    ])
    expect(board(b).parent_ticket_id).toBe('ticket-1')
    expect(eventsOf(run.id, 'ticket_removed')).toEqual([])

    delete harness.overrides.createWorktreeFromBranch
    const detail = await harness.service.start(run.id)
    await settle()

    expect(detail.run.status).toBe('running')
    expect(detail.items.map((item) => item.key)).toEqual(['TD-1', 'TD-3'])
    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-3': [] })
    expect(board(b).parent_ticket_id ?? null).toBeNull()
  })

  describe('while the launch is under way', () => {
    /** `work` runs once the checks passed and before the run is `running`. */
    const duringLaunch = (work: () => Promise<void> | void): void => {
      harness.overrides.createWorktreeFromBranch = async (params) => {
        await work()
        return harness.fakes.createWorktreeFromBranch(params)
      }
    }

    it('keeps the last ticket, from the dashboard and from the board', async () => {
      const a = ticket()
      const { run } = await create([a])
      duringLaunch(async () => {
        await expect(
          harness.service.removeItem({ runId: run.id, itemId: itemOf(run.id, 'TD-1').id })
        ).rejects.toThrow('TD-1 is the last ticket of this orchestrator')
        board(a).archived_at = '2026-11-01T00:00:00.000Z'
        await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, a)
      })

      const detail = await harness.service.start(run.id)

      expect(detail.run.status).toBe('running')
      expect(detail.items.map((item) => item.key)).toEqual(['TD-1'])
      expect(eventsOf(run.id, 'ticket_removed')).toEqual([])
    })

    it('still lets a ticket go while another stays', async () => {
      const [a, b] = [ticket(), ticket()]
      const { run } = await create([a, b])
      duringLaunch(async () => {
        board(a).archived_at = '2026-11-01T00:00:00.000Z'
        await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, a)
      })

      const detail = await harness.service.start(run.id)

      expect(detail.items.map((item) => item.key)).toEqual(['TD-2'])
    })

    it('refuses to go on once the last ticket was unchecked, and stays in preview', async () => {
      const { run } = await create([ticket()])
      duringLaunch(() => {
        harness.service.updateItem(run.id, itemOf(run.id, 'TD-1').id, { selected: false })
      })

      await expect(harness.service.start(run.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message: 'This orchestrator has no ticket left to launch; select or add one.'
      })

      expect(harness.db.getDocumentRun(run.id)?.status).toBe('preview')
      // Nothing left the preview for the launch that did not happen.
      expect(itemsOf(run.id).map((item) => item.key)).toEqual(['TD-1'])
      // Once the launch is over it is a preview like any: its last ticket may go.
      await expect(
        harness.service.removeItem({ runId: run.id, itemId: itemOf(run.id, 'TD-1').id })
      ).resolves.toMatchObject({ items: [] })
    })
  })
})

describe('addTickets', () => {
  it('adds tickets to a running run after its last one, linked to the run ticket', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    const { run } = await create([a, b])
    await harness.service.start(run.id)
    edge(c, b)

    const detail = await harness.service.addTickets({ runId: run.id, ticketIds: [a, c] })

    expect(detail.run.status).toBe('running')
    expect(detail.items.map((item) => [item.key, item.position, item.status])).toEqual([
      ['TD-1', 0, 'pending'],
      ['TD-2', 1, 'pending'],
      ['TD-3', 2, 'pending']
    ])
    expect(itemOf(run.id, 'TD-3')).toMatchObject({ ticket_id: c, depends_on: ['TD-2'] })
    expect(board(c).parent_ticket_id).toBe('ticket-1')
    expect(eventsOf(run.id, 'tickets_added').map((event) => event.message)).toEqual([
      '1 board ticket joined the orchestrator: TD-3'
    ])
    // The run's ticket counts it.
    expect(board('ticket-1').description).toMatch(/^Orchestrator of 3 board tickets\./)
  })

  it('re-derives the graph of the tickets already there too', async () => {
    const [a, b] = [ticket(), ticket()]
    edge(a, b)
    const { run } = await create([a])
    expect(graphOf(run.id)).toEqual({ 'TD-1': [] })

    await harness.service.addTickets({ runId: run.id, ticketIds: [b] })

    expect(graphOf(run.id)).toEqual({ 'TD-1': ['TD-2'], 'TD-2': [] })
  })

  it('does nothing for tickets that are already in the run', async () => {
    const a = ticket()
    const { run } = await create([a])

    const detail = await harness.service.addTickets({ runId: run.id, ticketIds: [a] })

    expect(detail.items).toHaveLength(1)
    expect(eventsOf(run.id, 'tickets_added')).toEqual([])
  })

  it('resumes a finished run, its ticket back In Progress and its report cleared', async () => {
    const [done, fresh] = [ticket({ column: 'done' }), ticket()]
    const runId = seedLaunched({
      status: 'completed',
      runTicket: 'review',
      items: [{ key: 'TD-1', ticket_id: done, status: 'merged' }]
    })
    harness.db.updateDocumentRun(runId, {
      finished_at: '2026-11-01T00:00:00.000Z',
      report: { summary: 'old' } as never
    })

    const detail = await harness.service.addTickets({ runId, ticketIds: [fresh] })

    expect(detail.run).toMatchObject({
      status: 'running',
      finished_at: null,
      report: null,
      error: null
    })
    expect(itemOf(runId, 'TD-2')).toMatchObject({ status: 'pending', ticket_id: fresh })
    expect(board(`run-ticket-${runId}`).column).toBe('in_progress')
    expect(eventsOf(runId, 'resumed').map((event) => event.message)).toEqual([
      'Resumed with 1 more ticket'
    ])
  })

  it('holds a ticket from the moment it joins a finished run, before the board writes are done', async () => {
    const [done, joining] = [ticket({ column: 'done' }), ticket()]
    const runId = seedLaunched({
      status: 'completed',
      runTicket: 'review',
      items: [{ key: 'TD-1', ticket_id: done, status: 'merged' }]
    })
    let whileWriting: { status?: string; refusal: unknown } | null = null
    harness.overrides.updateTicket = async (projectId, ticketId, patch) => {
      delete harness.overrides.updateTicket
      whileWriting = {
        status: harness.db.getDocumentRun(runId)?.status,
        refusal: await create([joining]).then(
          () => null,
          (error: Error) => error.message
        )
      }
      return harness.fakes.updateTicket(projectId, ticketId, patch)
    }

    await harness.service.addTickets({ runId, ticketIds: [joining] })

    expect(whileWriting).toEqual({
      status: 'running',
      refusal: 'TD-2 cannot be orchestrated: It is already part of “Factory spec”.'
    })
    expect(harness.db.findDocumentRunItemsByTicketId(joining).map((item) => item.run_id)).toEqual([
      runId
    ])
  })

  it('sends the ticket on to Review when a resumed run is cancelled during the hand-over', async () => {
    const [done, joining] = [ticket({ column: 'done' }), ticket()]
    const runId = seedLaunched({
      status: 'completed',
      runTicket: 'review',
      items: [{ key: 'TD-1', ticket_id: done, status: 'merged' }]
    })
    harness.overrides.updateTicket = async (projectId, ticketId, patch) => {
      delete harness.overrides.updateTicket
      await harness.service.cancel(runId)
      return harness.fakes.updateTicket(projectId, ticketId, patch)
    }

    await harness.service.addTickets({ runId, ticketIds: [joining] })

    const run = harness.db.getDocumentRun(runId)
    expect(run?.status).toBe('cancelled')
    expect(board(run?.ticket_id as string).column).toBe('review')
  })

  it('publishes a ticket that joined with its graph already written, whatever the run', async () => {
    const [first, second, third] = [ticket(), ticket(), ticket()]
    edge(second, first)
    edge(third, first)
    const reasons = (from: number): string[] =>
      harness.published
        .slice(from)
        .map((event) => event.reason)
        .filter((reason) => reason !== 'event')

    const { run } = await create([first])
    await harness.service.start(run.id)
    let from = harness.published.length
    await harness.service.addTickets({ runId: run.id, ticketIds: [second] })
    expect(reasons(from).slice(0, 2)).toEqual(['item', 'run'])
    expect(itemOf(run.id, 'TD-2').depends_on).toEqual(['TD-1'])

    harness.db.updateDocumentRun(run.id, { status: 'completed' })
    from = harness.published.length
    await harness.service.addTickets({ runId: run.id, ticketIds: [third] })
    expect(reasons(from).slice(0, 2)).toEqual(['item', 'run'])
    expect(itemOf(run.id, 'TD-3').depends_on).toEqual(['TD-1'])
  })

  it('does not send a queued ticket back to To Do once the run has launched it', async () => {
    const queued = ticket({ column: 'in_progress', pending_launch_config: '{"sdk":"claude-code"}' })
    const runId = seedLaunched({
      items: [{ key: 'TD-9', ticket_id: ticket(), status: 'pending' }]
    })
    harness.overrides.updateTicket = async (projectId, ticketId, patch) => {
      await harness.fakes.updateTicket(projectId, ticketId, patch)
      // The run holds the ticket from the insert: its next tick launched it during this write.
      if (ticketId === queued) board(queued).current_session_id = 'session-of-the-run'
    }

    await harness.service.addTickets({ runId, ticketIds: [queued] })

    expect(board(queued).column).toBe('in_progress')
    expect(harness.ticketMoves.filter((move) => move.ticketId === queued)).toEqual([])
  })

  it('takes the ticket of a resumed run out of the archive, so the run has a card', async () => {
    const runId = seedLaunched({
      status: 'completed',
      runTicket: 'done',
      items: [{ key: 'TD-1', ticket_id: ticket({ column: 'done' }), status: 'merged' }]
    })
    board(`run-ticket-${runId}`).archived_at = '2026-11-01T00:00:00.000Z'

    const detail = await harness.service.addTickets({ runId, ticketIds: [ticket()] })

    expect(detail.run.status).toBe('running')
    expect(board(`run-ticket-${runId}`)).toMatchObject({
      column: 'in_progress',
      archived_at: null
    })
    expect(eventsOf(runId, 'run_ticket_unarchived')).toHaveLength(1)
  })

  it('resumes all the same when the board will not unarchive the ticket', async () => {
    const runId = seedLaunched({
      status: 'completed',
      runTicket: 'done',
      items: [{ key: 'TD-1', ticket_id: ticket({ column: 'done' }), status: 'merged' }]
    })
    board(`run-ticket-${runId}`).archived_at = '2026-11-01T00:00:00.000Z'
    harness.overrides.unarchiveTicket = async () => {
      throw new Error('board offline')
    }

    const detail = await harness.service.addTickets({ runId, ticketIds: [ticket()] })

    expect(detail.run.status).toBe('running')
    expect(board(`run-ticket-${runId}`).column).toBe('in_progress')
  })

  it('refuses a finished run whose integration branch is gone', async () => {
    const runId = seedLaunched({
      status: 'completed',
      runTicket: 'done',
      worktreeStatus: 'archived',
      items: [{ key: 'TD-1', ticket_id: ticket({ column: 'done' }), status: 'merged' }]
    })

    await expect(
      harness.service.addTickets({ runId, ticketIds: [ticket()] })
    ).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringContaining('gone') })
    expect(itemsOf(runId)).toHaveLength(1)
  })

  it('gives a ticket two runs take at the same time to the first of them', async () => {
    const shared = ticket()
    const first = await create([ticket()], 'First')
    const second = await create([ticket()], 'Second')

    const results = await Promise.allSettled([
      harness.service.addTickets({ runId: first.run.id, ticketIds: [shared] }),
      harness.service.addTickets({ runId: second.run.id, ticketIds: [shared] })
    ])

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      message: 'TD-1 cannot be orchestrated: It is already part of “First”.'
    })
    expect(harness.db.findDocumentRunItemsByTicketId(shared).map((item) => item.run_id)).toEqual([
      first.run.id
    ])
  })

  it('refuses a cancelled run, one whose migrations are being executed, and a document run', async () => {
    const cancelled = seedLaunched({
      status: 'cancelled',
      items: [{ key: 'TD-1', ticket_id: ticket(), status: 'cancelled' }]
    })
    await expect(
      harness.service.addTickets({ runId: cancelled, ticketIds: [ticket()] })
    ).rejects.toThrow('This orchestrator was cancelled; it takes no more tickets.')

    const { run: migrating } = seedRun(harness, {
      run: { source_kind: 'tickets', status: 'completed', migration_session_id: 'session-1' }
    })
    await expect(
      harness.service.addTickets({ runId: migrating.id, ticketIds: [ticket()] })
    ).rejects.toThrow(/executing the migrations/)

    const { run: document } = seedRun(harness, { items: [{ key: 'A1' }] })
    await expect(
      harness.service.addTickets({ runId: document.id, ticketIds: [ticket()] })
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(itemsOf(document.id)).toHaveLength(1)
  })
})

describe('removeItem', () => {
  it('takes a ticket out before the launch: the ticket stays on the board, free, and nothing waits for it', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    edge(b, a)
    edge(c, a)
    const { run } = await create([a, b, c])
    await settle()

    const detail = await harness.service.removeItem({
      runId: run.id,
      itemId: itemOf(run.id, 'TD-1').id
    })

    expect(detail.items.map((item) => item.key)).toEqual(['TD-2', 'TD-3'])
    expect(graphOf(run.id)).toEqual({ 'TD-2': [], 'TD-3': [] })
    expect(harness.boardTickets.has(a)).toBe(true)
    expect(board(a).parent_ticket_id).toBeNull()
    // The board's own dependencies are the user's: they stay.
    expect(harness.boardDependencies).toHaveLength(2)
    expect(eventsOf(run.id, 'ticket_removed').map((event) => event.message)).toEqual([
      'TD-1 left the orchestrator; its ticket stays on the board'
    ])
    // Free again: another orchestrator may take it.
    await expect(create([a])).resolves.toMatchObject({ run: { status: 'preview' } })
  })

  it('takes out a ticket of a running run that waits its turn or never launched, never a launched one', async () => {
    const runId = seedLaunched({
      items: [
        { key: 'TD-1', ticket_id: ticket(), status: 'running', session_id: 'session-1' },
        { key: 'TD-2', ticket_id: ticket(), status: 'pending' },
        { key: 'TD-3', ticket_id: ticket(), status: 'needs_attention', session_id: null }
      ]
    })

    await expect(
      harness.service.removeItem({ runId, itemId: itemOf(runId, 'TD-1').id })
    ).rejects.toThrow('TD-1 has launched; skip it instead.')
    await harness.service.removeItem({ runId, itemId: itemOf(runId, 'TD-2').id })
    await harness.service.removeItem({ runId, itemId: itemOf(runId, 'TD-3').id })

    expect(itemsOf(runId).map((item) => item.key)).toEqual(['TD-1'])
  })

  it('keeps the last ticket of a launched run, which is skipped or the run cancelled instead', async () => {
    const runId = seedLaunched({
      items: [
        { key: 'TD-1', ticket_id: ticket(), status: 'pending' },
        { key: 'TD-2', ticket_id: ticket(), status: 'pending', selected: false }
      ]
    })

    await expect(
      harness.service.removeItem({ runId, itemId: itemOf(runId, 'TD-1').id })
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'TD-1 is the last ticket of this orchestrator; skip it or cancel the run instead.'
    })
    // One it does not launch goes; so does the last one of a preview.
    await harness.service.removeItem({ runId, itemId: itemOf(runId, 'TD-2').id })
    expect(itemsOf(runId).map((item) => item.key)).toEqual(['TD-1'])

    const { run } = await create([ticket()])
    await expect(
      harness.service.removeItem({ runId: run.id, itemId: itemsOf(run.id)[0].id })
    ).resolves.toMatchObject({ items: [] })
  })

  it('refuses a finished run and a document run', async () => {
    const finished = seedLaunched({
      status: 'completed_with_issues',
      runTicket: 'review',
      items: [{ key: 'TD-1', ticket_id: ticket(), status: 'needs_attention' }]
    })
    await expect(
      harness.service.removeItem({ runId: finished, itemId: itemOf(finished, 'TD-1').id })
    ).rejects.toThrow('This orchestrator has finished; its tickets can no longer change.')

    const { run: document, items } = seedRun(harness, { items: [{ key: 'A1' }] })
    await expect(
      harness.service.removeItem({ runId: document.id, itemId: items[0].id })
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(itemsOf(document.id)).toHaveLength(1)
  })
})

describe('setItemDependencies', () => {
  it("writes the board's dependencies between this ticket and the run's other tickets", async () => {
    const [a, b, c, outside] = [ticket(), ticket(), ticket(), ticket()]
    edge(c, outside)
    const { run } = await create([a, b, c])
    const third = itemOf(run.id, 'TD-3').id

    await harness.service.setItemDependencies({
      runId: run.id,
      itemId: third,
      dependsOn: ['TD-2', 'TD-1']
    })

    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': [], 'TD-3': ['TD-1', 'TD-2'] })
    expect(harness.boardDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependent_id: c, blocker_id: a }),
        expect.objectContaining({ dependent_id: c, blocker_id: b })
      ])
    )

    const detail = await harness.service.setItemDependencies({
      runId: run.id,
      itemId: third,
      dependsOn: ['TD-2']
    })

    expect(detail.items.find((item) => item.key === 'TD-3')?.depends_on).toEqual(['TD-2'])
    expect(harness.ticketUnlinks).toEqual([
      { projectId: TEST_PROJECT_ID, dependent: c, blocker: a }
    ])
    // The edge to a ticket outside the run is the board's own.
    expect(harness.boardDependencies).toContainEqual(
      expect.objectContaining({ dependent_id: c, blocker_id: outside })
    )
    expect(eventsOf(run.id, 'dependencies_changed').map((event) => event.message)).toEqual([
      'TD-3 starts after TD-1, TD-2',
      'TD-3 starts after TD-2'
    ])
  })

  it('refuses a cycle before the board is touched', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    edge(b, a)
    edge(c, b)
    const { run } = await create([a, b, c])

    await expect(
      harness.service.setItemDependencies({
        runId: run.id,
        itemId: itemOf(run.id, 'TD-1').id,
        dependsOn: ['TD-3']
      })
    ).rejects.toThrow('That would make a cycle: TD-1 → TD-3 → TD-2 → TD-1')
    expect(harness.ticketLinks).toEqual([])
    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': ['TD-1'], 'TD-3': ['TD-2'] })
  })

  it('refuses itself and keys that are not in the run', async () => {
    const { run } = await create([ticket(), ticket()])
    const first = itemOf(run.id, 'TD-1').id

    await expect(
      harness.service.setItemDependencies({ runId: run.id, itemId: first, dependsOn: ['TD-1'] })
    ).rejects.toThrow('TD-1 cannot start after itself.')
    await expect(
      harness.service.setItemDependencies({ runId: run.id, itemId: first, dependsOn: ['TD-9'] })
    ).rejects.toThrow('TD-9 is not a ticket of this orchestrator.')
  })

  it('re-links a ticket of a running run that waits its turn, never a launched one', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    const runId = seedLaunched({
      items: [
        { key: 'TD-1', ticket_id: a, status: 'running', session_id: 'session-1' },
        { key: 'TD-2', ticket_id: b, status: 'pending' },
        { key: 'TD-3', ticket_id: c, status: 'pending' }
      ]
    })

    await expect(
      harness.service.setItemDependencies({
        runId,
        itemId: itemOf(runId, 'TD-1').id,
        dependsOn: ['TD-2']
      })
    ).rejects.toThrow('TD-1 has launched; what it starts after can no longer be changed.')
    await harness.service.setItemDependencies({
      runId,
      itemId: itemOf(runId, 'TD-3').id,
      dependsOn: ['TD-1', 'TD-2']
    })

    expect(graphOf(runId)).toEqual({ 'TD-1': [], 'TD-2': [], 'TD-3': ['TD-1', 'TD-2'] })
  })

  it('surfaces a refusal of the board and keeps what did reach it', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    const { run } = await create([a, b, c])
    harness.overrides.addTicketDependency = async (projectId, dependent, blocker) => {
      if (blocker === b) return { success: false, error: 'Tickets must be in the same project' }
      harness.boardDependencies.push({ projectId, dependent_id: dependent, blocker_id: blocker })
      return { success: true }
    }

    await expect(
      harness.service.setItemDependencies({
        runId: run.id,
        itemId: itemOf(run.id, 'TD-3').id,
        dependsOn: ['TD-1', 'TD-2']
      })
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'The board refused “TD-3 starts after TD-2”: Tickets must be in the same project'
    })
    expect(itemOf(run.id, 'TD-3').depends_on).toEqual(['TD-1'])
  })

  it('refuses a document run', async () => {
    const { run, items } = seedRun(harness, { items: [{ key: 'A1' }, { key: 'A2' }] })

    await expect(
      harness.service.setItemDependencies({ runId: run.id, itemId: items[1].id, dependsOn: ['A1'] })
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })
})

describe('following the board', () => {
  it('re-derives the graph when a dependency between its tickets changes on the board', async () => {
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])

    edge(b, a)
    await harness.service.onBoardDependenciesChanged(TEST_PROJECT_ID, [b, a])
    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': ['TD-1'] })

    harness.boardDependencies.splice(0)
    await harness.service.onBoardDependenciesChanged(TEST_PROJECT_ID, [b, a])
    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': [] })
  })

  it("copies a ticket's new title and description", async () => {
    const a = ticket()
    const { run } = await create([a])
    board(a).title = 'Better <title>'
    board(a).description = 'Better brief.'

    await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, a)

    expect(itemOf(run.id, 'TD-1')).toMatchObject({
      title: 'Better title',
      description: 'Better brief.'
    })
  })

  it('lets a ticket that left the board or was archived go while it has not launched', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    edge(c, a)
    const { run } = await create([a, b, c])

    harness.boardTickets.delete(a)
    await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, a)
    board(b).archived_at = '2026-11-01T00:00:00.000Z'
    await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, b)

    expect(itemsOf(run.id).map((item) => item.key)).toEqual(['TD-3'])
    expect(eventsOf(run.id, 'ticket_removed').map((event) => event.message)).toEqual([
      'TD-1 left the board, so it left the orchestrator',
      'TD-2 was archived on the board, so it left the orchestrator'
    ])
  })

  it('keeps a launched ticket that left the board: the run reports it gone', async () => {
    const a = ticket()
    const runId = seedLaunched({
      items: [{ key: 'TD-1', ticket_id: a, status: 'running', session_id: 'session-1' }]
    })

    harness.boardTickets.delete(a)
    await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, a)

    expect(itemsOf(runId).map((item) => item.key)).toEqual(['TD-1'])
  })

  describe.each([
    [
      'deleted',
      (id: string) => {
        harness.boardTickets.delete(id)
      }
    ],
    [
      'archived',
      (id: string) => {
        board(id).archived_at = '2026-11-01T00:00:00.000Z'
      }
    ]
  ])('the last ticket of a launched run, %s', (_name, change) => {
    it('stays while it waits its turn: one the run does not launch is no reason to let it go', async () => {
      const last = ticket()
      const runId = seedLaunched({
        items: [
          { key: 'TD-1', ticket_id: last, status: 'pending' },
          { key: 'TD-2', ticket_id: ticket(), status: 'pending', selected: false }
        ]
      })

      change(last)
      await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, last)

      expect(itemsOf(runId).map((item) => item.key)).toEqual(['TD-1', 'TD-2'])
      expect(harness.db.getDocumentRun(runId)?.status).toBe('running')
      expect(eventsOf(runId, 'ticket_removed')).toEqual([])
    })

    it('stays when its launch failed in a paused run, for the user to skip', async () => {
      const last = ticket()
      const runId = seedLaunched({
        status: 'paused',
        items: [{ key: 'TD-1', ticket_id: last, status: 'needs_attention', session_id: null }]
      })

      change(last)
      await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, last)

      expect(itemsOf(runId).map((item) => item.key)).toEqual(['TD-1'])
      expect(harness.db.getDocumentRun(runId)?.status).toBe('paused')
    })
  })

  it('lets a ticket of a launched run go while another stays selected', async () => {
    const gone = ticket()
    const runId = seedLaunched({
      items: [
        { key: 'TD-1', ticket_id: ticket(), status: 'merged' },
        { key: 'TD-2', ticket_id: gone, status: 'pending' }
      ]
    })

    harness.boardTickets.delete(gone)
    await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, gone)

    expect(itemsOf(runId).map((item) => item.key)).toEqual(['TD-1'])
  })

  it('trusts no missing ticket while the board has cards it cannot read', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    const { run } = await create([a, b, c])
    harness.overrides.boardHasUnreadableCards = async () => true

    harness.boardTickets.delete(a)
    await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, a)
    expect(itemsOf(run.id).map((item) => item.key)).toEqual(['TD-1', 'TD-2', 'TD-3'])

    // What the board did read is still the board's word.
    board(b).archived_at = '2026-11-01T00:00:00.000Z'
    await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, b)
    expect(itemsOf(run.id).map((item) => item.key)).toEqual(['TD-1', 'TD-3'])

    // Once the board reads whole, a missing ticket is a ticket that left.
    harness.overrides.boardHasUnreadableCards = async () => false
    await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, a)
    expect(itemsOf(run.id).map((item) => item.key)).toEqual(['TD-3'])
  })

  it('leaves the graph alone while the board has cards it cannot read', async () => {
    const [a, b] = [ticket(), ticket()]
    edge(b, a)
    const { run } = await create([a, b])
    // An edge lives on the card of the ticket that waits: the card reads as gone, and so does it.
    harness.boardTickets.delete(b)
    harness.boardDependencies.splice(0)
    harness.overrides.boardHasUnreadableCards = async () => true

    await harness.service.refreshTicketRuns()
    await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, b)

    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': ['TD-1'] })
  })

  it('follows the board all the same when no ticket of the run is what cannot be read', async () => {
    // A stray file in a card folder is a blocking diagnostic that may never go away.
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])
    harness.overrides.boardHasUnreadableCards = async () => true
    edge(b, a)

    await harness.service.refreshTicketRuns()

    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': ['TD-1'] })
  })

  it('keeps the list of an unreadable card when the run changes, and takes the board again after', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    edge(b, a)
    const { run } = await create([a, b])
    // The card reads as gone, and the edge on it with it.
    const card = board(b)
    harness.boardTickets.delete(b)
    harness.boardDependencies.splice(0)
    harness.overrides.boardHasUnreadableCards = async () => true

    await harness.service.addTickets({ runId: run.id, ticketIds: [c] })

    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': ['TD-1'], 'TD-3': [] })

    // The card reads again, without the edge: the board is what counts once more.
    harness.boardTickets.set(b, card)
    harness.overrides.boardHasUnreadableCards = async () => false
    await harness.service.refreshTicketRuns()

    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': [], 'TD-3': [] })
  })

  it('does not take a ticket out at startup because a read came back empty', async () => {
    const [a, b, c] = [ticket(), ticket(), ticket()]
    const { run } = await create([a, b, c])
    const missing = ticket()
    const runId = seedLaunched({
      items: [
        { key: 'TD-8', ticket_id: missing, status: 'pending' },
        { key: 'TD-9', ticket_id: ticket(), status: 'pending' }
      ]
    })

    harness.boardTickets.delete(a)
    harness.boardTickets.delete(missing)
    board(b).archived_at = '2026-11-01T00:00:00.000Z'
    await harness.service.refreshTicketRuns()

    // Missing stays, however the board reads; archived is what the board said, and goes.
    expect(itemsOf(run.id).map((item) => item.key)).toEqual(['TD-1', 'TD-3'])
    expect(itemsOf(runId).map((item) => item.key)).toEqual(['TD-8', 'TD-9'])
    // The launch reports it, as it does any ticket that is gone.
    await expect(harness.service.start(run.id)).rejects.toThrow(
      'TD-1 is no longer on the board; remove it from the orchestrator.'
    )
  })

  it('keeps the last ticket of a launched run at startup too', async () => {
    const archived = ticket({ archived_at: '2026-11-01T00:00:00.000Z' })
    const runId = seedLaunched({
      items: [{ key: 'TD-1', ticket_id: archived, status: 'pending' }]
    })

    await harness.service.refreshTicketRuns()

    expect(itemsOf(runId).map((item) => item.key)).toEqual(['TD-1'])
  })

  it('leaves document runs and other projects alone, and never throws', async () => {
    const { run: document, items } = seedRun(harness, {
      items: [{ key: 'A1', ticket_id: 'doc-ticket' }]
    })
    await harness.service.onBoardTicketChanged(TEST_PROJECT_ID, 'doc-ticket')
    expect(itemsOf(document.id)).toEqual(items)

    const a = ticket()
    const { run } = await create([a])
    harness.boardTickets.delete(a)
    await harness.service.onBoardTicketChanged('other-project', a)
    expect(itemsOf(run.id)).toHaveLength(1)

    harness.overrides.getTicketDependencies = async () => {
      throw new Error('board offline')
    }
    await expect(
      harness.service.onBoardDependenciesChanged(TEST_PROJECT_ID, [a])
    ).resolves.toBeUndefined()
    await expect(harness.service.onBoardTicketChanged(TEST_PROJECT_ID, a)).resolves.toBeUndefined()
  })

  it('catches up at startup with what changed on the board meanwhile', async () => {
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])
    edge(b, a)
    board(a).title = 'Renamed'

    await harness.service.refreshTicketRuns()

    expect(itemOf(run.id, 'TD-1').title).toBe('Renamed')
    expect(graphOf(run.id)).toEqual({ 'TD-1': [], 'TD-2': ['TD-1'] })
  })
})

describe('finalize', () => {
  it('does not finish while a ticket that joined has yet to launch', async () => {
    const runId = seedLaunched({
      items: [
        { key: 'TD-1', ticket_id: ticket(), status: 'merged' },
        { key: 'TD-2', ticket_id: ticket(), status: 'pending' }
      ]
    })

    const detail = await harness.service.finalize(runId)

    expect(detail.run).toMatchObject({ status: 'running', report: null, finished_at: null })
    expect(harness.ticketMoves).toEqual([])
  })

  it('finishes like any run, without writing to a document', async () => {
    const runId = seedLaunched({
      items: [
        { key: 'TD-1', ticket_id: ticket(), status: 'merged' },
        { key: 'TD-2', ticket_id: ticket(), status: 'skipped' }
      ]
    })

    const detail = await harness.service.finalize(runId)

    expect(detail.run.status).toBe('completed')
    expect(detail.run.report).not.toBeNull()
    expect(
      harness.db.events.filter(
        (event) => event.run_id === runId && event.type.startsWith('document_summary')
      )
    ).toEqual([])
    expect(board(`run-ticket-${runId}`).column).toBe('review')
  })
})

describe('what a run made from board tickets does not do', () => {
  it('has nothing to extract and no document to open', async () => {
    const { run } = await create([ticket()])

    expect(() => harness.service.retryExtraction({ runId: run.id })).toThrow(
      'A run made from board tickets has nothing to extract.'
    )
    await expect(harness.service.sourceFile(run.id)).resolves.toEqual({ path: '', exists: false })
    await expect(harness.service.inspectSource(run.id, 'TD-1')).resolves.toMatchObject({
      path: '',
      exists: false,
      backupPath: null
    })
  })

  it('keeps the brief and the graph on the board, the launch choices in the item', async () => {
    const { run } = await create([ticket(), ticket()])
    const item = itemOf(run.id, 'TD-2')

    for (const patch of [{ title: 'x' }, { summary: 'x' }, { description: 'x' }]) {
      expect(() => harness.service.updateItem(run.id, item.id, patch)).toThrow(
        'The ticket is the brief of an orchestrator: edit the ticket on the board.'
      )
    }
    expect(() => harness.service.updateItem(run.id, item.id, { depends_on: ['TD-1'] })).toThrow(
      /setItemDependencies/
    )
    expect(
      harness.service.updateItem(run.id, item.id, {
        selected: false,
        verification: ['tests'],
        launch_config: { sdk: 'codex', model: null, codexFastMode: true }
      })
    ).toMatchObject({
      selected: false,
      verification: ['tests'],
      launch_config: { sdk: 'codex', model: null, codexFastMode: true }
    })
  })

  it('deletes the run and its ticket, and keeps the adopted tickets, unlinked', async () => {
    const [a, b] = [ticket(), ticket()]
    const { run } = await create([a, b])
    await settle()
    expect(board(a).parent_ticket_id).toBe('ticket-1')

    await harness.service.delete(run.id)

    expect(harness.db.getDocumentRun(run.id)).toBeNull()
    expect(harness.boardTickets.has('ticket-1')).toBe(false)
    expect(board(a).parent_ticket_id).toBeNull()
    expect(board(b).parent_ticket_id).toBeNull()
  })
})
