import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentFlowRunner } from './runner'
import {
  INTEGRATION_BRANCH,
  PROJECT_ID,
  TEST_NOW,
  advance,
  createWorld,
  type RunnerWorld
} from './runner-fakes'

describe('DocumentFlowRunner: launching', () => {
  let runner: DocumentFlowRunner | null = null

  const start = (world: RunnerWorld): void => {
    runner = new DocumentFlowRunner(world.ports)
    runner.start()
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

  it('launches a wave one ticket at a time and holds a dependent back until its dependency merged', async () => {
    const world = createWorld({
      config: { maxParallel: 2 },
      items: [{ key: 'A' }, { key: 'B' }, { key: 'C', depends_on: ['A'] }]
    })
    let concurrent = 0
    let peak = 0
    world.ports.launchTicket.mockImplementation(async (spec) => {
      world.launches.push(spec)
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 500))
      concurrent -= 1
      return world.launchOk(spec)
    })
    start(world)

    await advance(300)
    expect(world.statuses()).toEqual({ A: 'launching', B: 'pending', C: 'pending' })

    await advance(2000)
    expect(world.launches.map((spec) => spec.ticketId)).toEqual(['ticket-A', 'ticket-B'])
    expect(peak).toBe(1)
    expect(world.statuses()).toEqual({ A: 'running', B: 'running', C: 'pending' })

    // A free slot alone is not enough: C waits for A to be merged, not merely finished.
    world.endTurn(world.sessionOf('A'))
    await advance(3200)
    expect(world.item('A').status).not.toBe('running')
    await advance(2000)

    expect(world.item('A').status).toBe('merged')
    expect(world.launches.map((spec) => spec.ticketId)).toEqual([
      'ticket-A',
      'ticket-B',
      'ticket-C'
    ])
    expect(world.item('C').status).toBe('running')
  })

  it('never has more agents working than maxParallel', async () => {
    const world = createWorld({
      config: { maxParallel: 1 },
      items: [{ key: 'A' }, { key: 'B' }]
    })
    start(world)

    await advance(5000)

    expect(world.statuses()).toEqual({ A: 'running', B: 'pending' })
    expect(world.launches).toHaveLength(1)
  })

  it('does not wait for a skipped or a deselected dependency', async () => {
    const world = createWorld({
      items: [
        { key: 'A', status: 'skipped' },
        { key: 'B', selected: false },
        { key: 'C', depends_on: ['A', 'B'] }
      ]
    })
    start(world)

    await advance(1000)

    expect(world.statuses()).toEqual({ A: 'skipped', B: 'pending', C: 'running' })
    expect(world.launches.map((spec) => spec.ticketId)).toEqual(['ticket-C'])
  })

  it('records the session, worktree and real branch name of a launch', async () => {
    const world = createWorld()
    world.ports.launchTicket.mockImplementation(async (spec) => {
      const result = world.launchOk(spec)
      // The name was taken: git gave the branch a suffix.
      world.worktrees.set(result.worktreeId as string, {
        id: result.worktreeId as string,
        branch_name: 'a-task-a-2',
        path: '/worktrees/a-task-a-2'
      })
      return result
    })
    start(world)

    await advance(1000)

    const item = world.item('A')
    expect(item).toMatchObject({
      status: 'running',
      status_detail: null,
      session_id: 'session-1',
      worktree_id: 'wt-1',
      branch_name: 'a-task-a-2',
      started_at: '2026-05-04T10:00:00.100Z'
    })
    expect(item.last_prompt_at).toBe(item.started_at)
    expect(world.events.map((event) => event.type)).toContain('launched')
  })

  it('cuts the ticket worktree from the integration branch without touching the user’s view', async () => {
    const world = createWorld({ items: [{ key: 'A2', title: 'Ramp-up rule' }, { key: 'B' }] })
    start(world)

    await advance(1000)

    const spec = world.launches[0]
    expect(spec).toMatchObject({
      ticketId: 'ticket-A2',
      projectId: PROJECT_ID,
      mode: 'build',
      goalMode: false,
      goalSuccessCriteria: null,
      worktree: {
        type: 'new',
        sourceBranch: INTEGRATION_BRANCH,
        baseRef: INTEGRATION_BRANCH,
        autoPull: false,
        select: false,
        nameHint: 'a2-ramp-up-rule'
      },
      ticketUpdateExtras: {
        column: 'in_progress',
        sort_order: -1,
        plan_ready: false,
        pending_launch_config: null
      }
    })
    expect(spec.prompt.startsWith('<ticket title="Ramp-up rule">')).toBe(true)
    expect(spec.prompt).toContain(`Your branch was cut from \`${INTEGRATION_BRANCH}\``)
    expect(spec.prompt).toContain('otherwise change `main`')
    expect(spec.prompt).toContain('B (Task B)')
    expect(spec.prompt).toContain('STATUS: DONE | NEEDS_INPUT | BLOCKED')
  })

  it('tells agents whether they may ask, following the run setting', async () => {
    const interactive = createWorld({ config: { interactive: true } })
    start(interactive)
    await advance(1000)
    runner?.stop()

    const unattended = createWorld({ config: { interactive: false } })
    start(unattended)
    await advance(1000)

    expect(interactive.launches[0].prompt).toContain('ask with the AskUserQuestion tool')
    expect(interactive.launches[0].prompt).not.toContain('Nobody is watching this run')
    expect(unattended.launches[0].prompt).toContain('Nobody is watching this run')
  })

  it('names the dependencies already merged into the branch a ticket starts from', async () => {
    const world = createWorld({
      items: [
        { key: 'A', status: 'merged' },
        { key: 'B', depends_on: ['A'], has_migration: true }
      ]
    })
    start(world)

    await advance(1000)

    const prompt = world.launches[0].prompt
    expect(prompt).toContain('Already on your branch (merged before you started): A (Task A)')
    expect(prompt).not.toContain('Other tasks of this document are built in parallel')
    expect(prompt).toContain('add a NEW migration')
  })

  it('resolves the model from the ticket, then the run default, then the app default', async () => {
    const ticketConfig = {
      sdk: 'codex' as const,
      model: { providerID: 'openai', modelID: 'ticket-model' },
      codexFastMode: true
    }
    const runConfig = {
      sdk: 'claude-code-cli' as const,
      model: { providerID: 'anthropic', modelID: 'run-model', variant: 'ultracode' },
      codexFastMode: false
    }
    const world = createWorld({
      config: { defaultLaunch: runConfig, maxParallel: 2 },
      items: [{ key: 'A', launch_config: ticketConfig }, { key: 'B' }]
    })
    start(world)
    await advance(1000)
    runner?.stop()

    const bare = createWorld()
    start(bare)
    await advance(1000)

    expect(world.launches[0].modelConfig).toEqual(ticketConfig)
    expect(world.launches[1].modelConfig).toEqual(runConfig)
    expect(world.ports.resolveDefaultLaunch).not.toHaveBeenCalled()
    expect(bare.launches[0].modelConfig.model?.modelID).toBe('app-default')
  })

  it('flags a failed launch, cleans up after it, and relaunches on Retry', async () => {
    const world = createWorld()
    world.ports.launchTicket.mockResolvedValueOnce({
      success: false,
      error: 'disk full',
      sessionId: 'orphan-session',
      worktreeId: 'wt-half'
    })
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'Could not launch: disk full',
      session_id: null
    })
    expect(world.ports.completeOrphanSession).toHaveBeenCalledWith('orphan-session')
    expect(world.ports.resetTicketToTodo).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A')
    expect(world.events.map((event) => event.type)).toContain('launch_failed')
    expect(world.notices).toEqual([
      { level: 'warning', message: 'A needs attention: Could not launch: disk full' }
    ])

    // Retry of an item without a session puts it back to pending (see the store's retryItem).
    world.setItem('A', { status: 'pending', status_detail: null })
    await advance(5000)

    expect(world.item('A')).toMatchObject({ status: 'running', session_id: 'session-1' })
    expect(world.ports.launchTicket).toHaveBeenCalledTimes(2)
  })

  it('flags a ticket that no longer exists after reloading the board once', async () => {
    const world = createWorld()
    world.tickets.delete('ticket-A')
    start(world)

    await advance(1000)

    expect(world.ports.reloadTickets).toHaveBeenCalledTimes(1)
    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'Its ticket no longer exists.'
    })
    expect(world.ports.launchTicket).not.toHaveBeenCalled()
  })

  it('adopts the session of a launch that a reload interrupted after it started', async () => {
    const launchedAt = '2026-05-04T09:58:00.000Z'
    const world = createWorld({
      items: [{ key: 'A', status: 'launching', started_at: launchedAt }]
    })
    world.tickets.set('ticket-A', {
      ...world.tickets.get('ticket-A')!,
      current_session_id: 'session-before-reload',
      worktree_id: 'wt-before-reload'
    })
    world.worktrees.set('wt-before-reload', {
      id: 'wt-before-reload',
      branch_name: 'a-task-a',
      path: '/worktrees/a-task-a'
    })
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'running',
      session_id: 'session-before-reload',
      worktree_id: 'wt-before-reload',
      branch_name: 'a-task-a',
      // The launch time, so a turn that already ended while reloading still counts.
      last_prompt_at: launchedAt
    })
    expect(world.ports.launchTicket).not.toHaveBeenCalled()
  })

  it('launches again when a reload cut the launch off before the session was started', async () => {
    const world = createWorld({
      items: [{ key: 'A', status: 'launching', started_at: '2026-05-04T09:58:00.000Z' }]
    })
    world.tickets.set('ticket-A', {
      ...world.tickets.get('ticket-A')!,
      current_session_id: 'session-never-prompted',
      worktree_id: 'wt-before-reload'
    })
    world.unstartedSessions.add('session-never-prompted')
    start(world)

    await advance(1000)

    expect(world.ports.completeOrphanSession).toHaveBeenCalledWith('session-never-prompted')
    expect(world.ports.resetTicketToTodo).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A')
    expect(world.events.map((event) => event.type)).toContain('launch_failed')
    const statuses = world.ports.updateItem.mock.calls.map(([, , patch]) => patch.status)
    expect(statuses).toEqual(['pending', 'launching', 'running'])
    expect(world.item('A')).toMatchObject({ status: 'running', session_id: 'session-1' })
    expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
  })

  it('launches again when a reload interrupted the launch before a session existed', async () => {
    const world = createWorld({
      items: [{ key: 'A', status: 'launching', started_at: '2026-05-04T09:58:00.000Z' }]
    })
    start(world)

    await advance(300)
    expect(world.item('A').status).not.toBe('launching')

    await advance(1000)
    expect(world.item('A')).toMatchObject({ status: 'running', session_id: 'session-1' })
    expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
  })

  describe('where a branch is cut from while a merge lands', () => {
    it('starts from the commit before a merge that is still being verified or fixed', async () => {
      const world = createWorld({
        config: { maxParallel: 3 },
        items: [
          {
            key: 'A',
            status: 'fixing',
            pre_merge_sha: 'before-a',
            merge_sha: 'merge-a',
            fix_session_id: 's-fix',
            fix_ticket_id: 'fix-ticket-1'
          },
          { key: 'B' }
        ]
      })
      world.setSignal('s-fix', { kind: 'working' })
      start(world)

      await advance(1000)

      expect(world.item('B').status).toBe('running')
      expect(world.launches[0].worktree).toMatchObject({
        sourceBranch: INTEGRATION_BRANCH,
        baseRef: 'before-a'
      })
    })

    it('waits while a merge is landing and its pre-merge commit is not recorded yet', async () => {
      const world = createWorld({
        config: { maxParallel: 3 },
        items: [{ key: 'A', status: 'verifying', pre_merge_sha: null }, { key: 'B' }]
      })
      world.setRun({ config: { ...world.detail().run.config, verifyCommand: 'pnpm test' } })
      world.api.verify.mockReturnValue(new Promise(() => {}))
      start(world)

      await advance(30_000)
      expect(world.launches).toEqual([])
      expect(world.item('B').status).toBe('pending')

      world.setItem('A', { pre_merge_sha: 'before-a' })
      await advance(1000)
      expect(world.launches[0].worktree).toMatchObject({ baseRef: 'before-a' })
    })
  })

  it('does not start a queued launch once the run is paused', async () => {
    const world = createWorld({
      config: { maxParallel: 2 },
      items: [{ key: 'A' }, { key: 'B' }]
    })
    world.ports.launchTicket.mockImplementation(async (spec) => {
      world.launches.push(spec)
      await new Promise((resolve) => setTimeout(resolve, 500))
      return world.launchOk(spec)
    })
    start(world)

    await advance(300)
    world.setRun({ status: 'paused' })
    await advance(3000)

    // The launch already under way finishes and is recorded; the queued one never starts.
    expect(world.statuses()).toEqual({ A: 'running', B: 'pending' })
    expect(world.launches).toHaveLength(1)
  })
})
