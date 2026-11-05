import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildTicketRunPrompt,
  connectionWorkspaceParagraph,
  workspaceOfMembers
} from '@shared/document-flow/prompts'
import type {
  DocumentMergeCheckResult,
  DocumentRunDetail,
  DocumentRunItem
} from '@shared/types/document-flow'
import {
  DocumentFlowRunner,
  FINALIZE_RETRY_MS,
  NO_DOCUMENT_DETAIL,
  SETTLE_MS,
  foreignSessionDetail,
  setAsideTicketDetail
} from './runner'
import {
  FakeTransportError,
  INTEGRATION_BRANCH,
  MEMBERS,
  PROJECT_ID,
  RUN_ID,
  TEST_NOW,
  TICKETS_RUN,
  advance,
  createWorld,
  makeVerdict,
  type RunnerWorld
} from './runner-fakes'
import type { RunnerTicket } from './runner-ports'

// A run made from board tickets (an orchestrator) on the same loop as a document run: the
// user's ticket is the brief, a ticket launched from the board meanwhile is not launched over,
// there is no document lane, and items come and go while the run is under way.

const PROMPTED_AT = '2026-05-04T09:59:00.000Z'

const readyItem = (
  key: string,
  overrides: Partial<DocumentRunItem> = {}
): Partial<DocumentRunItem> => ({
  key,
  status: 'ready',
  session_id: `s-${key}`,
  worktree_id: `wt-${key}`,
  branch_name: `${key.toLowerCase()}-task`,
  started_at: PROMPTED_AT,
  last_prompt_at: PROMPTED_AT,
  ...overrides
})

const mergedItem = (key: string): Partial<DocumentRunItem> => ({
  ...readyItem(key),
  status: 'merged',
  merge_sha: `merge-${key}`,
  finished_at: PROMPTED_AT
})

const noChanges: DocumentMergeCheckResult = {
  state: 'no_changes',
  conflictedFiles: [],
  committed: false,
  commitsAhead: 0
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** The user's own ticket on the board: what the brief is made of. */
const writeTicket = (
  world: RunnerWorld,
  ticketId: string,
  patch: { title?: string; description?: string | null; attachments?: unknown[] }
): void => {
  const ticket = world.tickets.get(ticketId)
  if (!ticket) throw new Error(`no ticket ${ticketId}`)
  world.tickets.set(ticketId, { ...ticket, ...patch })
}

describe('DocumentFlowRunner: a run made from board tickets', () => {
  let runner: DocumentFlowRunner | null = null

  const start = (world: RunnerWorld): void => {
    runner = new DocumentFlowRunner(world.ports)
    runner.start()
  }

  /** The agent ends its turn, the end settles, it is judged done and merged. */
  const finishTurn = async (world: RunnerWorld, key: string): Promise<void> => {
    world.endTurn(world.sessionOf(key))
    await advance(SETTLE_MS + 2000)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TEST_NOW))
  })

  afterEach(() => {
    runner?.stop()
    runner = null
    vi.useRealTimers()
  })

  describe('the brief', () => {
    it("launches the ticket with the user's title, description and attachments, then the rules of the run", async () => {
      const world = createWorld({ tickets: true, items: [{ key: 'TD-1', title: 'Snapshot' }] })
      const attachments = [
        { type: 'image', url: '/attachments/mock.png', label: 'Mock-up' },
        { type: 'jira', url: 'https://jira.example/TD-1', label: 'TD-1' }
      ]
      writeTicket(world, 'ticket-TD-1', {
        title: 'Add a dark mode toggle',
        description: '  Put it in the header.\n\nKeep the current colours as the light theme.\n',
        attachments
      })
      start(world)

      await advance(1000)

      const prompt = world.launches[0].prompt
      expect(prompt).toBe(
        buildTicketRunPrompt(
          {
            title: 'Add a dark mode toggle',
            description:
              '  Put it in the header.\n\nKeep the current colours as the light theme.\n',
            attachments
          },
          { interactive: true, sdk: 'claude-code-cli', verification: [] }
        )
      )
      expect(
        prompt.startsWith(
          'Please implement the following ticket.\n\n<ticket title="Add a dark mode toggle">'
        )
      ).toBe(true)
      expect(prompt).toContain('<file path="/attachments/mock.png">Mock-up</file>')
      expect(prompt).toContain('<link type="jira" url="https://jira.example/TD-1">TD-1</link>')
      expect(prompt).toContain('commit your work on this branch')
      // Never the document brief: there is no document to read the task in.
      expect(prompt).not.toContain('implement task')
      expect(prompt).not.toContain('file://')
      expect(world.launches[0]).toMatchObject({
        ticketId: 'ticket-TD-1',
        mode: 'build',
        goalMode: false,
        worktree: { type: 'new', baseRef: INTEGRATION_BRANCH, sourceBranch: 'main' }
      })
    })

    it('sends a ticket without a description as it stands, never the standard brief', async () => {
      const world = createWorld({ tickets: true, items: [{ key: 'TD-1' }] })
      writeTicket(world, 'ticket-TD-1', { title: 'Fix the footer', description: null })
      start(world)

      await advance(1000)

      expect(world.launches[0].prompt).toBe(
        buildTicketRunPrompt(
          { title: 'Fix the footer', description: null, attachments: [] },
          { interactive: true, sdk: 'claude-code-cli', verification: [] }
        )
      )
    })

    it('reads the ticket from the board at launch, so an edit made while it waited reaches the agent', async () => {
      const world = createWorld({
        tickets: true,
        config: { maxParallel: 1 },
        items: [{ key: 'TD-1' }, { key: 'TD-2' }]
      })
      start(world)
      await advance(1000)
      expect(world.launches).toHaveLength(1)

      writeTicket(world, 'ticket-TD-2', { title: 'Renamed', description: 'Edited while waiting.' })
      world.setItem('TD-1', { status: 'merged' })
      await advance(5000)

      expect(world.launches[1].prompt).toContain(
        '<ticket title="Renamed">Edited while waiting.</ticket>'
      )
    })

    it('briefs under the settings and verification of the launch, and the model of the ticket', async () => {
      const launchConfig = {
        sdk: 'codex' as const,
        model: { providerID: 'openai', modelID: 'ticket-model' },
        codexFastMode: false
      }
      const world = createWorld({
        tickets: true,
        config: { interactive: false },
        items: [{ key: 'TD-1', verification: ['tests'], launch_config: launchConfig }]
      })
      writeTicket(world, 'ticket-TD-1', { description: 'Do it.' })
      start(world)

      await advance(1000)

      expect(world.launches[0].prompt).toBe(
        buildTicketRunPrompt(
          { title: 'Task TD-1', description: 'Do it.', attachments: [] },
          { interactive: false, sdk: 'codex', verification: ['tests'] }
        )
      )
      expect(world.launches[0].prompt).toContain("do not ask me anything - i won't be next")
      expect(world.launches[0].modelConfig).toEqual(launchConfig)
    })

    it('leaves verification out while the run skips it', async () => {
      const world = createWorld({
        tickets: true,
        config: { verificationDisabled: true },
        items: [{ key: 'TD-1', verification: ['tests', 'playwright'] }]
      })
      start(world)

      await advance(1000)

      expect(world.launches[0].prompt).toBe(
        buildTicketRunPrompt(
          { title: 'Task TD-1', description: '', attachments: [] },
          { interactive: true, sdk: 'claude-code-cli', verification: [] }
        )
      )
    })

    it('tells a session launched under the old setting when it is flipped mid-launch', async () => {
      const world = createWorld({ tickets: true, items: [{ key: 'TD-1' }] })
      world.ports.launchTicket.mockImplementation(async (spec) => {
        world.launches.push(spec)
        await new Promise((resolve) => setTimeout(resolve, 500))
        return world.launchOk(spec)
      })
      start(world)

      await advance(300)
      world.setRun({ config: { ...world.detail().run.config, interactive: false } })
      await advance(2000)

      expect(world.launches[0].prompt).toContain('use the AskUserQuestion tool to ask me.')
      expect(world.modeNotices).toEqual([
        { sessionId: world.sessionOf('TD-1'), interactive: false }
      ])
    })

    it('on a connection project, names the members and launches into a new instance', async () => {
      const world = createWorld({
        tickets: true,
        connection: true,
        config: { interactive: false },
        items: [{ key: 'TD-1', verification: ['playwright'] }]
      })
      writeTicket(world, 'ticket-TD-1', {
        title: 'Share the cart',
        description: 'Both the web app and the API.'
      })
      start(world)

      await advance(1000)

      const workspace = workspaceOfMembers(MEMBERS)
      const [launch] = world.launches
      expect(launch.prompt).toBe(
        buildTicketRunPrompt(
          {
            title: 'Share the cart',
            description: 'Both the web app and the API.',
            attachments: []
          },
          { interactive: false, sdk: 'claude-code-cli', verification: ['playwright'], workspace }
        )
      )
      expect(launch.prompt).toContain(connectionWorkspaceParagraph(workspace))
      expect(launch.worktree).toMatchObject({ type: 'connection-new', savedProjectId: PROJECT_ID })
      expect(world.item('TD-1')).toMatchObject({ status: 'running', connection_id: 'conn-1' })
    })
  })

  describe("the run's own launch", () => {
    // The launch pipeline refuses to launch a ticket that waits for its run unless the run
    // itself asks (`orchestrated`): a store re-read older than the `launching` write would
    // otherwise get the run's own launch refused as a launch by hand.
    it.each([
      ['a git project', {}],
      ['a connection project', { connection: true }]
    ])('launches an orchestrator’s ticket as orchestrated, on %s', async (_label, options) => {
      const world = createWorld({ tickets: true, ...options, items: [{ key: 'TD-1' }] })
      start(world)

      await advance(1000)

      expect(world.launches).toHaveLength(1)
      expect(world.launches[0].orchestrated).toBe(true)
    })

    it('launches a document run’s ticket as orchestrated too, as its tickets wait for it as well', async () => {
      const world = createWorld({ items: [{ key: 'A' }] })
      start(world)

      await advance(1000)

      expect(world.launches[0].orchestrated).toBe(true)
    })
  })

  describe('a ticket the user launched from the board meanwhile', () => {
    it('is flagged instead of launched over, without ever being marked launching', async () => {
      const world = createWorld({ tickets: true, items: [{ key: 'TD-3' }] })
      writeTicket(world, 'ticket-TD-3', {})
      world.tickets.set('ticket-TD-3', {
        ...world.tickets.get('ticket-TD-3')!,
        column: 'in_progress',
        current_session_id: 'user-session',
        worktree_id: 'wt-user'
      })
      start(world)

      await advance(1000)

      expect(world.ports.launchTicket).not.toHaveBeenCalled()
      expect(world.item('TD-3')).toMatchObject({
        status: 'needs_attention',
        status_detail:
          'TD-3 has a session the run did not start (launched from the board). Close its session and Retry, or remove the ticket from the orchestrator.',
        session_id: null,
        started_at: null
      })
      expect(world.item('TD-3').status_detail).toBe(foreignSessionDetail('TD-3'))
      // A `launching` row would let a reloaded runner adopt the user's session.
      const written = world.ports.updateItem.mock.calls.map(([, , patch]) => patch.status)
      expect(written).not.toContain('launching')
      // The user's session and ticket are left as they are.
      expect(world.ports.completeOrphanSession).not.toHaveBeenCalled()
      expect(world.ports.resetTicketToTodo).not.toHaveBeenCalled()
      expect(world.tickets.get('ticket-TD-3')).toMatchObject({
        current_session_id: 'user-session',
        worktree_id: 'wt-user'
      })
      expect(world.notices).toEqual([
        {
          level: 'warning',
          message: `TD-3 needs attention: ${foreignSessionDetail('TD-3')}`,
          title: 'Orchestrator'
        }
      ])

      // The user stops it (dragging the card back to To Do unlinks the session) and retries.
      world.tickets.set('ticket-TD-3', {
        ...world.tickets.get('ticket-TD-3')!,
        column: 'todo',
        current_session_id: null,
        worktree_id: null
      })
      world.setItem('TD-3', { status: 'pending', status_detail: null })
      await advance(5000)

      expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
      expect(world.item('TD-3')).toMatchObject({ status: 'running', session_id: 'session-1' })
    })

    it('is flagged on a connection project too', async () => {
      const world = createWorld({ tickets: true, connection: true, items: [{ key: 'TD-3' }] })
      world.tickets.set('ticket-TD-3', {
        ...world.tickets.get('ticket-TD-3')!,
        current_session_id: 'user-session'
      })
      start(world)

      await advance(1000)

      expect(world.ports.launchTicket).not.toHaveBeenCalled()
      expect(world.item('TD-3')).toMatchObject({
        status: 'needs_attention',
        status_detail: foreignSessionDetail('TD-3')
      })
    })

    it('reloads the board once before judging a ticket it has not loaded', async () => {
      const world = createWorld({ tickets: true, items: [{ key: 'TD-3' }] })
      const ticket = world.tickets.get('ticket-TD-3')!
      world.tickets.delete('ticket-TD-3')
      world.ports.reloadTickets.mockImplementation(async () => {
        world.tickets.set(ticket.id, { ...ticket, current_session_id: 'user-session' })
      })
      start(world)

      await advance(1000)

      expect(world.ports.reloadTickets).toHaveBeenCalledTimes(1)
      expect(world.item('TD-3').status).toBe('needs_attention')
      expect(world.ports.launchTicket).not.toHaveBeenCalled()
    })

    it('still flags a ticket gone from the board as no longer existing', async () => {
      const world = createWorld({ tickets: true, items: [{ key: 'TD-3' }] })
      world.tickets.delete('ticket-TD-3')
      start(world)

      await advance(1000)

      expect(world.item('TD-3')).toMatchObject({
        status: 'needs_attention',
        status_detail: 'Its ticket no longer exists.'
      })
      expect(world.ports.launchTicket).not.toHaveBeenCalled()
    })

    it('does not flag what a document run launches (its tickets are the run’s own)', async () => {
      const world = createWorld({ items: [{ key: 'A' }] })
      world.tickets.set('ticket-A', {
        ...world.tickets.get('ticket-A')!,
        current_session_id: 'old-session'
      })
      start(world)

      await advance(1000)

      expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
      expect(world.item('A').status).toBe('running')
    })

    describe('once that session is over', () => {
      const linkClosedSession = (world: RunnerWorld, key: string): void => {
        world.tickets.set(`ticket-${key}`, {
          ...world.tickets.get(`ticket-${key}`)!,
          column: 'in_progress',
          current_session_id: 'user-session',
          worktree_id: 'wt-user'
        })
        world.closedSessions.add('user-session')
      }

      it('flags a closed session that a ticket modal resumed: its agent is working again', async () => {
        const world = createWorld({ tickets: true, items: [{ key: 'TD-3' }] })
        linkClosedSession(world, 'TD-3')
        world.setSignal('user-session', { kind: 'working' })
        start(world)

        await advance(1000)

        expect(world.ports.launchTicket).not.toHaveBeenCalled()
        expect(world.ports.unlinkTicketSession).not.toHaveBeenCalled()
        expect(world.item('TD-3')).toMatchObject({
          status: 'needs_attention',
          status_detail: foreignSessionDetail('TD-3')
        })
      })

      it('launches, having cleared the stale link before the `launching` write', async () => {
        const world = createWorld({ tickets: true, items: [{ key: 'TD-3' }] })
        linkClosedSession(world, 'TD-3')
        start(world)

        await advance(1000)

        expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
        expect(world.item('TD-3')).toMatchObject({ status: 'running', session_id: 'session-1' })
        expect(world.notices).toEqual([])
        expect(world.ports.unlinkTicketSession).toHaveBeenCalledExactlyOnceWith(
          PROJECT_ID,
          'ticket-TD-3'
        )
        const launchingWrite = world.ports.updateItem.mock.calls.findIndex(
          ([, , patch]) => patch.status === 'launching'
        )
        expect(world.ports.unlinkTicketSession.mock.invocationCallOrder[0]).toBeLessThan(
          world.ports.updateItem.mock.invocationCallOrder[launchingWrite]
        )
        // The user's closed session is left as it is; only the link went.
        expect(world.ports.completeOrphanSession).not.toHaveBeenCalled()
        expect(world.ports.resetTicketToTodo).not.toHaveBeenCalled()
      })

      it('leaves a reloaded runner no foreign session to adopt from the `launching` row', async () => {
        const world = createWorld({ tickets: true, items: [{ key: 'TD-3' }] })
        linkClosedSession(world, 'TD-3')
        const launch = deferred<void>()
        const realLaunch = world.ports.launchTicket.getMockImplementation()!
        world.ports.launchTicket.mockImplementation(async (spec) => {
          await launch.promise
          return realLaunch(spec)
        })
        start(world)
        await advance(1000)
        expect(world.item('TD-3').status).toBe('launching')
        expect(world.tickets.get('ticket-TD-3')!.current_session_id).toBeNull()

        // The page reloads in the middle of the launch.
        runner?.stop()
        runner = null
        start(world)
        await advance(1000)

        expect(world.item('TD-3').session_id).not.toBe('user-session')
        expect(world.events.map((event) => event.type)).not.toContain('launched')
        launch.resolve()
      })

      it('does not launch when the link could not be cleared', async () => {
        const world = createWorld({ tickets: true, items: [{ key: 'TD-3' }] })
        linkClosedSession(world, 'TD-3')
        world.ports.unlinkTicketSession.mockRejectedValueOnce(new Error('the board said no'))
        start(world)

        await advance(1000)

        expect(world.ports.launchTicket).not.toHaveBeenCalled()
        expect(world.item('TD-3')).toMatchObject({
          status: 'needs_attention',
          status_detail: 'the board said no'
        })
        const written = world.ports.updateItem.mock.calls.map(([, , patch]) => patch.status)
        expect(written).not.toContain('launching')
      })

      it('tries again when the server could not be reached for the link', async () => {
        const world = createWorld({ tickets: true, items: [{ key: 'TD-3' }] })
        linkClosedSession(world, 'TD-3')
        world.ports.unlinkTicketSession.mockRejectedValueOnce(new FakeTransportError('offline'))
        start(world)

        await advance(1000)
        expect(world.ports.launchTicket).not.toHaveBeenCalled()
        expect(world.item('TD-3').status).toBe('pending')

        await advance(20_000)
        expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
        expect(world.item('TD-3').status).toBe('running')
      })

      it('frees a ticket flagged for that session on Retry, once the user closed it', async () => {
        const world = createWorld({ tickets: true, items: [{ key: 'TD-3' }] })
        world.tickets.set('ticket-TD-3', {
          ...world.tickets.get('ticket-TD-3')!,
          column: 'in_progress',
          current_session_id: 'user-session'
        })
        start(world)
        await advance(1000)
        expect(world.item('TD-3').status_detail).toBe(foreignSessionDetail('TD-3'))

        // What the detail says to do: nothing unlinks the ticket when its session closes.
        world.closedSessions.add('user-session')
        world.setItem('TD-3', { status: 'pending', status_detail: null })
        await advance(5000)

        expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
        expect(world.item('TD-3')).toMatchObject({ status: 'running', session_id: 'session-1' })
      })

      it('launches on the same terms on a connection project', async () => {
        const world = createWorld({ tickets: true, connection: true, items: [{ key: 'TD-3' }] })
        linkClosedSession(world, 'TD-3')
        start(world)

        await advance(1000)

        expect(world.ports.unlinkTicketSession).toHaveBeenCalledTimes(1)
        expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
        expect(world.item('TD-3').status).toBe('running')
      })

      it('never asks about the session of what a document run launches', async () => {
        const world = createWorld({ items: [{ key: 'A' }] })
        linkClosedSession(world, 'A')
        start(world)

        await advance(1000)

        expect(world.ports.isSessionClosed).not.toHaveBeenCalled()
        expect(world.ports.unlinkTicketSession).not.toHaveBeenCalled()
        expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('a ticket the user finished or put away while it waited its turn', () => {
    const putTicket = (world: RunnerWorld, key: string, patch: Partial<RunnerTicket>): void => {
      world.tickets.set(`ticket-${key}`, { ...world.tickets.get(`ticket-${key}`)!, ...patch })
    }

    it.each([
      ['review', 'Review'],
      ['done', 'Done'],
      ['merged', 'Merged']
    ] as const)('is flagged rather than pulled back from %s', async (column, name) => {
      const world = createWorld({ tickets: true, items: [{ key: 'TD-2' }] })
      putTicket(world, 'TD-2', { column })
      start(world)

      await advance(1000)

      const detail = `TD-2 was moved to ${name} on the board. Move it back and Retry, or remove the ticket from the orchestrator.`
      expect(world.ports.launchTicket).not.toHaveBeenCalled()
      expect(world.item('TD-2')).toMatchObject({
        status: 'needs_attention',
        status_detail: detail,
        session_id: null,
        started_at: null
      })
      const written = world.ports.updateItem.mock.calls.map(([, , patch]) => patch.status)
      expect(written).not.toContain('launching')
      expect(world.tickets.get('ticket-TD-2')!.column).toBe(column)
      expect(world.notices).toEqual([
        { level: 'warning', message: `TD-2 needs attention: ${detail}`, title: 'Orchestrator' }
      ])

      // Back in To Do, Retry launches it.
      putTicket(world, 'TD-2', { column: 'todo' })
      world.setItem('TD-2', { status: 'pending', status_detail: null })
      await advance(5000)

      expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
      expect(world.item('TD-2')).toMatchObject({ status: 'running', session_id: 'session-1' })
    })

    it('is flagged when archived, whatever column it was archived from', async () => {
      const world = createWorld({ tickets: true, items: [{ key: 'TD-2' }] })
      putTicket(world, 'TD-2', { archived_at: '2026-05-04T09:30:00.000Z' })
      start(world)

      await advance(1000)

      expect(world.ports.launchTicket).not.toHaveBeenCalled()
      expect(world.item('TD-2')).toMatchObject({
        status: 'needs_attention',
        status_detail:
          'TD-2 was archived on the board. Unarchive it and Retry, or remove the ticket from the orchestrator.'
      })
    })

    it('is flagged on a connection project too', async () => {
      const world = createWorld({ tickets: true, connection: true, items: [{ key: 'TD-2' }] })
      putTicket(world, 'TD-2', { column: 'done' })
      start(world)

      await advance(1000)

      expect(world.ports.launchTicket).not.toHaveBeenCalled()
      expect(world.item('TD-2').status_detail).toBe(
        setAsideTicketDetail('TD-2', { column: 'done', archived_at: null })
      )
    })

    it('is flagged for the column, leaving a session linked to it alone', async () => {
      const world = createWorld({ tickets: true, items: [{ key: 'TD-2' }] })
      putTicket(world, 'TD-2', { column: 'done', current_session_id: 'user-session' })
      world.closedSessions.add('user-session')
      start(world)

      await advance(1000)

      expect(world.item('TD-2').status_detail).toBe(
        setAsideTicketDetail('TD-2', { column: 'done', archived_at: null })
      )
      expect(world.ports.unlinkTicketSession).not.toHaveBeenCalled()
      expect(world.tickets.get('ticket-TD-2')!.current_session_id).toBe('user-session')
    })

    it('launches a ticket still in To Do or In Progress, as the run took it', async () => {
      const world = createWorld({
        tickets: true,
        config: { maxParallel: 2 },
        items: [{ key: 'TD-1' }, { key: 'TD-2' }]
      })
      putTicket(world, 'TD-2', { column: 'in_progress' })
      start(world)

      await advance(1000)

      expect(world.ports.launchTicket).toHaveBeenCalledTimes(2)
      expect(world.statuses()).toEqual({ 'TD-1': 'running', 'TD-2': 'running' })
    })

    it('is flagged on the Retry of a launch that failed, the run never having launched it', async () => {
      const world = createWorld({ tickets: true, items: [{ key: 'TD-2' }] })
      world.ports.launchTicket.mockResolvedValueOnce({ success: false, error: 'no worktree' })
      start(world)
      await advance(1000)
      expect(world.item('TD-2')).toMatchObject({
        status: 'needs_attention',
        status_detail: 'Could not launch: no worktree',
        session_id: null
      })

      putTicket(world, 'TD-2', { column: 'done' })
      world.setItem('TD-2', { status: 'pending', status_detail: null })
      await advance(5000)

      expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
      expect(world.item('TD-2').status_detail).toBe(
        setAsideTicketDetail('TD-2', { column: 'done', archived_at: null })
      )
    })

    it('is not what a ticket the run launched is flagged for, its session having moved it', async () => {
      // A turn end took it to Review, and the item stopped on the user. Retry sends an item with
      // a session to `checking`, so it is judged again and never comes near the launch.
      const world = createWorld({
        tickets: true,
        items: [
          {
            key: 'TD-2',
            status: 'needs_attention',
            status_detail: 'The agent stopped.',
            session_id: 's-TD-2',
            worktree_id: 'wt-TD-2',
            branch_name: 'td-2-task',
            started_at: PROMPTED_AT,
            last_prompt_at: PROMPTED_AT
          }
        ]
      })
      putTicket(world, 'TD-2', { column: 'review', current_session_id: 's-TD-2' })
      world.setSignal('s-TD-2', { kind: 'unknown' })
      start(world)

      world.setItem('TD-2', { status: 'checking', status_detail: null })
      await advance(5000)

      expect(world.ports.launchTicket).not.toHaveBeenCalled()
      expect(world.item('TD-2')).toMatchObject({
        status: 'merged',
        session_id: 's-TD-2',
        status_detail: null
      })
    })

    it('does not hold a row back that carries the run’s own session, wherever that left it', async () => {
      // Nothing writes such a row today. Should one appear, the column is its session's doing, and
      // that session is the run's own: this check is only about a ticket never launched.
      const world = createWorld({
        tickets: true,
        items: [{ key: 'TD-2', session_id: 's-TD-2', worktree_id: 'wt-TD-2' }]
      })
      putTicket(world, 'TD-2', { column: 'review', current_session_id: 's-TD-2' })
      start(world)

      await advance(1000)

      expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
      expect(world.item('TD-2').status_detail).toBeNull()
    })

    it('never looks at the board for what a document run launches', async () => {
      const world = createWorld({ items: [{ key: 'A' }] })
      putTicket(world, 'A', { column: 'done', archived_at: '2026-05-04T09:30:00.000Z' })
      start(world)

      await advance(1000)

      expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
      expect(world.item('A').status).toBe('running')
    })
  })

  describe('no document lane', () => {
    it('merges a ticket, lets the board close its session, and finishes as an orchestrator', async () => {
      const world = createWorld({ tickets: true, items: [readyItem('TD-1')] })
      start(world)

      await advance(1000)

      expect(world.item('TD-1')).toMatchObject({
        status: 'merged',
        document_update_status: null,
        document_update_queued_at: null,
        document_update_finished_at: null
      })
      // Completion effects stay off (the run schedules its own dependents), but the session is
      // not kept: there is no document update to come.
      expect(world.ports.moveTicket).toHaveBeenCalledWith(PROJECT_ID, 'ticket-TD-1', 'merged', {
        skipCompletionEffects: true,
        keepSession: false
      })
      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()
      expect(world.followups).toEqual([])
      expect(world.api.inspectSource).not.toHaveBeenCalled()
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
      expect(world.detail().run.status).toBe('completed')
      expect(world.notices).toEqual([
        { level: 'success', message: 'Orchestrator finished: 1 merged', title: 'Orchestrator' }
      ])
    })

    it('runs every ticket from launch to the finished run without touching any document', async () => {
      const world = createWorld({
        tickets: true,
        config: { maxParallel: 2 },
        items: [{ key: 'TD-1' }, { key: 'TD-2', depends_on: ['TD-1'] }]
      })
      start(world)

      await advance(1000)
      expect(world.statuses()).toEqual({ 'TD-1': 'running', 'TD-2': 'pending' })

      await finishTurn(world, 'TD-1')
      expect(world.item('TD-1').status).toBe('merged')
      expect(world.item('TD-2').status).toBe('running')
      expect(world.launches[1].worktree).toMatchObject({ baseRef: INTEGRATION_BRANCH })

      await finishTurn(world, 'TD-2')

      expect(world.statuses()).toEqual({ 'TD-1': 'merged', 'TD-2': 'merged' })
      expect(world.documentUpdates()).toEqual({ 'TD-1': null, 'TD-2': null })
      expect(world.api.inspectSource).not.toHaveBeenCalled()
      expect(world.followups).toEqual([])
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
      expect(world.notices.at(-1)).toEqual({
        level: 'success',
        message: 'Orchestrator finished: 2 merged',
        title: 'Orchestrator'
      })
    })

    it('closes a ticket an unattended run found already done, with no update queued', async () => {
      const world = createWorld({
        tickets: true,
        config: { interactive: false },
        items: [readyItem('TD-1', { verdict: makeVerdict() })]
      })
      world.api.prepareMerge.mockResolvedValue(noChanges)
      start(world)

      await advance(1000)

      expect(world.item('TD-1')).toMatchObject({
        status: 'skipped',
        document_update_status: null
      })
      expect(world.api.inspectSource).not.toHaveBeenCalled()
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
      expect(world.notices.at(-1)?.message).toBe('Orchestrator finished: 0 merged, 1 skipped')
    })

    it('closes an update queued anyway (a stale dashboard’s Retry) as skipped, unprompted, and finishes', async () => {
      const world = createWorld({
        tickets: true,
        items: [
          {
            ...mergedItem('TD-1'),
            document_update_status: 'queued',
            document_update_queued_at: PROMPTED_AT
          }
        ]
      })
      start(world)

      await advance(1000)

      expect(world.item('TD-1')).toMatchObject({
        status: 'merged',
        document_update_status: 'skipped',
        document_update_detail: NO_DOCUMENT_DETAIL
      })
      expect(world.followups).toEqual([])
      expect(world.api.inspectSource).not.toHaveBeenCalled()
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
    })

    it('titles its flags as an orchestrator, while a document run’s notices stay as they were', async () => {
      const world = createWorld({ tickets: true, items: [readyItem('TD-1')] })
      world.api.prepareMerge.mockResolvedValue({ ...noChanges, state: 'error', error: 'boom' })
      start(world)

      await advance(1000)

      expect(world.notices).toEqual([
        { level: 'warning', message: 'TD-1 needs attention: boom', title: 'Orchestrator' }
      ])
      runner?.stop()

      const documentRun = createWorld({ items: [readyItem('A')] })
      documentRun.api.prepareMerge.mockResolvedValue({
        ...noChanges,
        state: 'error',
        error: 'boom'
      })
      start(documentRun)
      await advance(1000)

      expect(documentRun.notices).toEqual([
        { level: 'warning', message: 'A needs attention: boom' }
      ])
    })
  })

  describe('finishing beside other runs', () => {
    it('finishes two runs made from tickets independently, though neither has a source path', async () => {
      const world = createWorld({ tickets: true, items: [mergedItem('TD-1')] })
      world.addRun('run-2', { run: { ...TICKETS_RUN }, items: [mergedItem('TD-9')] })
      const first = deferred<DocumentRunDetail>()
      const finalize = world.api.finalize.getMockImplementation()!
      world.api.finalize.mockImplementation(async (runId: string) =>
        runId === RUN_ID ? first.promise : finalize(runId)
      )
      start(world)

      await advance(1000)

      // The first one's finalize is still out: the second does not wait behind it.
      expect(world.api.finalize).toHaveBeenCalledWith(RUN_ID)
      expect(world.api.finalize).toHaveBeenCalledWith('run-2')
      expect(world.detail('run-2').run.status).toBe('completed')

      first.resolve({
        ...world.detail(),
        run: { ...world.detail().run, status: 'completed' }
      })
      await advance(1000)
      expect(world.detail().run.status).toBe('completed')
    })

    it('does not wait for a document another run is editing', async () => {
      const world = createWorld({ tickets: true, items: [mergedItem('TD-1')] })
      world.addRun('run-2', {
        items: [
          {
            ...mergedItem('C'),
            document_update_status: 'updating',
            document_update_hash: 'sha-1'
          }
        ]
      })
      world.putDocument({}, '/docs/checkout.html')
      world.setSignal('s-C', { kind: 'working' })
      start(world)

      await advance(1000)

      expect(world.api.finalize).toHaveBeenCalledWith(RUN_ID)
      expect(world.api.finalize).not.toHaveBeenCalledWith('run-2')
      expect(world.detail().run.status).toBe('completed')
    })
  })

  describe('items that come and go while it runs', () => {
    it('launches a ticket added mid-run on the next tick, cut from the integration tip', async () => {
      const world = createWorld({
        tickets: true,
        config: { maxParallel: 2 },
        items: [{ key: 'TD-1' }]
      })
      start(world)
      await advance(1000)
      expect(world.statuses()).toEqual({ 'TD-1': 'running' })

      const added = world.addItem({ key: 'TD-7' })
      expect(added.position).toBe(1)
      writeTicket(world, 'ticket-TD-7', { title: 'Added later', description: 'One more thing.' })
      await advance(1000)

      expect(world.item('TD-7')).toMatchObject({ status: 'running', session_id: 'session-2' })
      expect(world.launches[1]).toMatchObject({
        ticketId: 'ticket-TD-7',
        worktree: { type: 'new', baseRef: INTEGRATION_BRANCH }
      })
      expect(world.launches[1].prompt).toContain(
        '<ticket title="Added later">One more thing.</ticket>'
      )
    })

    it('cuts a ticket added while a merge is being verified from the commit before that merge', async () => {
      const world = createWorld({
        tickets: true,
        config: { verifyCommand: 'pnpm test' },
        items: [
          readyItem('TD-1', {
            status: 'verifying',
            pre_merge_sha: 'before-TD-1',
            merge_sha: 'merge-TD-1'
          })
        ]
      })
      const verified = deferred<Awaited<ReturnType<typeof world.api.verify>>>()
      world.api.verify.mockImplementation(() => verified.promise)
      start(world)
      await advance(1000)

      world.addItem({ key: 'TD-7' })
      await advance(1000)

      expect(world.launches[0]).toMatchObject({
        ticketId: 'ticket-TD-7',
        worktree: { baseRef: 'before-TD-1' }
      })
      verified.resolve({
        skipped: false,
        ok: true,
        exitCode: 0,
        timedOut: false,
        output: '',
        durationMs: 1
      })
      await advance(1000)
      expect(world.item('TD-1').status).toBe('merged')
    })

    it('launches a ticket the server added while refusing to finalize, and finalizes once it is through', async () => {
      const world = createWorld({ tickets: true, items: [mergedItem('TD-1')] })
      world.api.finalize.mockImplementationOnce(async (runId: string) => {
        // The user added a ticket just as the run settled: the server keeps it running.
        world.addItem({ key: 'TD-2' })
        return world.detail(runId)
      })
      start(world)

      await advance(1000)
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
      expect(world.detail().run.status).toBe('running')
      expect(world.item('TD-2').status).toBe('running')

      await finishTurn(world, 'TD-2')

      // Well inside the retry delay of the refused finalize: the run it refused is gone.
      expect(world.item('TD-2').status).toBe('merged')
      expect(world.api.finalize).toHaveBeenCalledTimes(2)
      expect(world.detail().run.status).toBe('completed')
    })

    it('waits out the retry delay when the server keeps the same settled run running', async () => {
      const world = createWorld({ tickets: true, items: [mergedItem('TD-1')] })
      world.api.finalize.mockImplementationOnce(async (runId: string) => world.detail(runId))
      start(world)

      await advance(1000)
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
      await advance(30_000)
      expect(world.api.finalize).toHaveBeenCalledTimes(1)

      await advance(FINALIZE_RETRY_MS)
      expect(world.api.finalize).toHaveBeenCalledTimes(2)
      expect(world.detail().run.status).toBe('completed')
    })

    it('picks up a finished run the server resumed with a new ticket', async () => {
      const world = createWorld({
        tickets: true,
        run: { status: 'completed' },
        items: [mergedItem('TD-1')]
      })
      start(world)
      await advance(1000)
      expect(world.launches).toEqual([])

      world.setRun({ status: 'running', report: null, finished_at: null })
      world.addItem({ key: 'TD-2' })
      await advance(1000)

      expect(world.item('TD-2').status).toBe('running')
      expect(world.launches[0].worktree).toMatchObject({ baseRef: INTEGRATION_BRANCH })
      // Nothing to set up again: the integration worktree has served tickets already.
      expect(world.ports.fireSetupScript).not.toHaveBeenCalled()

      await finishTurn(world, 'TD-2')
      expect(world.detail().run.status).toBe('completed')
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
    })

    it('finishes, is resumed with a new ticket under the same runner, and finishes again', async () => {
      const world = createWorld({ tickets: true, items: [mergedItem('TD-1')] })
      start(world)
      await advance(1000)
      expect(world.detail().run.status).toBe('completed')
      expect(world.api.finalize).toHaveBeenCalledTimes(1)

      // The user adds a ticket to the finished orchestrator: the server puts it back in play.
      world.setRun({ status: 'running', report: null, finished_at: null })
      world.addItem({ key: 'TD-2' })
      await advance(1000)
      expect(world.item('TD-2').status).toBe('running')
      expect(world.launches.map((spec) => spec.ticketId)).toEqual(['ticket-TD-2'])

      await finishTurn(world, 'TD-2')

      expect(world.item('TD-2').status).toBe('merged')
      expect(world.api.finalize).toHaveBeenCalledTimes(2)
      expect(world.detail().run.status).toBe('completed')
      expect(world.notices.map((notice) => notice.message)).toEqual([
        'Orchestrator finished: 1 merged',
        'Orchestrator finished: 2 merged'
      ])
      expect(world.ports.warn).not.toHaveBeenCalled()
    })

    it('follows the dependencies the server derives from the board, as they change', async () => {
      const world = createWorld({
        tickets: true,
        config: { maxParallel: 3 },
        items: [{ key: 'TD-1' }, { key: 'TD-2', depends_on: ['TD-1'] }, { key: 'TD-3' }]
      })
      world.ports.launchTicket.mockImplementation(async (spec) => {
        world.launches.push(spec)
        await new Promise((resolve) => setTimeout(resolve, 200))
        return world.launchOk(spec)
      })
      // TD-3 gets a dependency on TD-1 on the board before its turn comes.
      world.setItem('TD-3', { depends_on: ['TD-1'] })
      start(world)

      await advance(2000)
      expect(world.statuses()).toEqual({
        'TD-1': 'running',
        'TD-2': 'pending',
        'TD-3': 'pending'
      })

      // The edge from TD-2 to TD-1 is removed on the board: TD-2 goes now.
      world.setItem('TD-2', { depends_on: [] })
      await advance(2000)
      expect(world.statuses()).toEqual({
        'TD-1': 'running',
        'TD-2': 'running',
        'TD-3': 'pending'
      })

      // TD-3 now starts after TD-2 as well: TD-1's merge alone does not let it go.
      world.setItem('TD-3', { depends_on: ['TD-1', 'TD-2'] })
      await finishTurn(world, 'TD-1')
      expect(world.item('TD-1').status).toBe('merged')
      expect(world.item('TD-3').status).toBe('pending')

      await finishTurn(world, 'TD-2')
      await advance(1000)
      expect(world.item('TD-3').status).toBe('running')
      expect(world.launches.map((spec) => spec.ticketId)).toEqual([
        'ticket-TD-1',
        'ticket-TD-2',
        'ticket-TD-3'
      ])
    })

    it('drops a removed ticket, also one queued to launch, and goes on with the rest', async () => {
      const world = createWorld({
        tickets: true,
        config: { maxParallel: 2 },
        items: [
          { key: 'TD-1' },
          { key: 'TD-2' },
          { key: 'TD-3', depends_on: ['TD-4'] },
          { key: 'TD-4' }
        ]
      })
      world.ports.launchTicket.mockImplementation(async (spec) => {
        world.launches.push(spec)
        await new Promise((resolve) => setTimeout(resolve, 500))
        return world.launchOk(spec)
      })
      start(world)

      await advance(300)
      expect(world.statuses()).toMatchObject({ 'TD-1': 'launching', 'TD-2': 'pending' })

      // TD-2 waits behind TD-1 in the launch chain; TD-4, which TD-3 starts after, is pending.
      world.removeItem('TD-2')
      world.removeItem('TD-4')
      await advance(2000)

      expect(world.launches.map((spec) => spec.ticketId)).toEqual(['ticket-TD-1', 'ticket-TD-3'])
      expect(world.statuses()).toEqual({ 'TD-1': 'running', 'TD-3': 'running' })
      expect(world.ports.warn).not.toHaveBeenCalled()

      await finishTurn(world, 'TD-1')
      await finishTurn(world, 'TD-3')
      expect(world.statuses()).toEqual({ 'TD-1': 'merged', 'TD-3': 'merged' })
      expect(world.detail().run.status).toBe('completed')
      expect(world.notices.at(-1)?.message).toBe('Orchestrator finished: 2 merged')
    })
  })
})
