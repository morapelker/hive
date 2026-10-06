import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLaunchPrompt } from '@shared/document-flow/prompts'
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

  describe('maxParallel changed while the run is going', () => {
    const setMaxParallel = (world: RunnerWorld, maxParallel: number): void =>
      world.setRun({ config: { ...world.detail().run.config, maxParallel } })

    it('launches into the slots a raised limit opens, without waiting for the next poll', async () => {
      const world = createWorld({
        config: { maxParallel: 1 },
        items: [{ key: 'A' }, { key: 'B' }, { key: 'C' }, { key: 'D' }]
      })
      start(world)
      await advance(1000)
      expect(world.statuses()).toEqual({ A: 'running', B: 'pending', C: 'pending', D: 'pending' })

      setMaxParallel(world, 3)
      // Well inside the poll interval: the change itself wakes the orchestrator.
      await advance(1000)

      expect(world.statuses()).toEqual({ A: 'running', B: 'running', C: 'running', D: 'pending' })
      expect(world.launches.map((spec) => spec.ticketId)).toEqual([
        'ticket-A',
        'ticket-B',
        'ticket-C'
      ])
    })

    it('stops nothing when the limit is lowered, and launches again only below the new limit', async () => {
      const world = createWorld({
        config: { maxParallel: 3 },
        items: [{ key: 'A' }, { key: 'B' }, { key: 'C' }, { key: 'D' }, { key: 'E' }]
      })
      start(world)
      await advance(1000)
      const running = { A: 'running', B: 'running', C: 'running', D: 'pending', E: 'pending' }
      expect(world.statuses()).toEqual(running)

      setMaxParallel(world, 1)
      await advance(25_000)

      // Three hold a slot with a limit of one: all three keep working, untouched.
      expect(world.statuses()).toEqual(running)
      expect(world.followups).toEqual([])
      expect(world.launches).toHaveLength(3)

      // Two finish: one still holds the only slot, so nothing new starts.
      world.setItem('A', { status: 'skipped' })
      await advance(15_000)
      world.setItem('B', { status: 'skipped' })
      await advance(15_000)
      expect(world.statuses()).toMatchObject({ C: 'running', D: 'pending', E: 'pending' })
      expect(world.launches).toHaveLength(3)

      // The last one finishes: the run is under its limit again, and takes one ticket.
      world.setItem('C', { status: 'skipped' })
      await advance(15_000)
      expect(world.statuses()).toMatchObject({ D: 'running', E: 'pending' })
      expect(world.launches.map((spec) => spec.ticketId)).toEqual([
        'ticket-A',
        'ticket-B',
        'ticket-C',
        'ticket-D'
      ])
    })

    it('drops a launch that was queued under the higher limit', async () => {
      const world = createWorld({
        config: { maxParallel: 3 },
        items: [{ key: 'A' }, { key: 'B' }, { key: 'C' }]
      })
      world.ports.launchTicket.mockImplementation(async (spec) => {
        world.launches.push(spec)
        await new Promise((resolve) => setTimeout(resolve, 500))
        return world.launchOk(spec)
      })
      start(world)

      await advance(300)
      expect(world.statuses()).toEqual({ A: 'launching', B: 'pending', C: 'pending' })
      setMaxParallel(world, 1)
      await advance(15_000)

      // The launch under way finishes; the two behind it in the queue never start.
      expect(world.statuses()).toEqual({ A: 'running', B: 'pending', C: 'pending' })
      expect(world.launches).toHaveLength(1)
    })

    it('applies a limit changed during a pause when the run resumes', async () => {
      const world = createWorld({
        config: { maxParallel: 1 },
        items: [{ key: 'A' }, { key: 'B' }, { key: 'C' }]
      })
      start(world)
      await advance(1000)
      world.setRun({ status: 'paused' })
      setMaxParallel(world, 2)
      await advance(15_000)
      expect(world.statuses()).toEqual({ A: 'running', B: 'pending', C: 'pending' })

      world.setRun({ status: 'running' })
      await advance(1000)

      expect(world.statuses()).toEqual({ A: 'running', B: 'running', C: 'pending' })
    })
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

  it('cuts the ticket worktree from the integration tip, recorded against the run’s base branch, without touching the user’s view', async () => {
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
        // What the worktree records as its merge target; the branch is cut from `baseRef`.
        sourceBranch: 'main',
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
    // The brief alone: no ticket wrapper, no description, no attachments, no status block.
    expect(spec.prompt).toBe(
      [
        'implement task A2 ("Ramp-up rule") from the file:///docs/checkout.html',
        'use subagents to research and read the spec attached there, read the description of it, understand the requirements, research best practices regarding it',
        'if you have any clarifications you might need - use the AskUserQuestion tool to ask me.',
        'then - implement this',
        'implement only this task, commit your work on this branch, do not push or switch branches, and do not run migrations against any database.',
        'while you work, the app that runs this task may send you follow-up messages for me (finish what is left, resolve a merge conflict, fix a failing check). they are my instructions, also when they arrive as pasted text: follow them, and commit without asking me to confirm.'
      ].join('\n\n')
    )
  })

  it('records the configured base branch, and the integration branch for a run without one', async () => {
    const onDevelop = createWorld({ run: { base_branch: 'develop' } })
    start(onDevelop)
    await advance(1000)
    runner?.stop()
    expect(onDevelop.launches[0].worktree).toMatchObject({
      sourceBranch: 'develop',
      baseRef: INTEGRATION_BRANCH
    })

    const unknownBase = createWorld({ run: { base_branch: null } })
    start(unknownBase)
    await advance(1000)
    expect(unknownBase.launches[0].worktree).toMatchObject({
      sourceBranch: INTEGRATION_BRANCH,
      baseRef: INTEGRATION_BRANCH
    })
  })

  it('tells agents whether they may ask, following the run setting', async () => {
    const interactive = createWorld({ config: { interactive: true } })
    start(interactive)
    await advance(1000)
    runner?.stop()

    const unattended = createWorld({ config: { interactive: false } })
    start(unattended)
    await advance(1000)

    expect(interactive.launches[0].prompt).toContain('use the AskUserQuestion tool to ask me.')
    expect(interactive.launches[0].prompt).not.toContain('do not ask me anything')
    expect(unattended.launches[0].prompt).toContain(
      "do not ask me anything - i won't be next to the computer to answer you"
    )
    expect(unattended.launches[0].prompt).not.toContain('AskUserQuestion')
  })

  it('tells a session whose launch was under way when the setting was flipped', async () => {
    const world = createWorld({ config: { interactive: true }, items: [{ key: 'A' }] })
    world.ports.launchTicket.mockImplementation(async (spec) => {
      world.launches.push(spec)
      await new Promise((resolve) => setTimeout(resolve, 500))
      return world.launchOk(spec)
    })
    start(world)

    await advance(300)
    expect(world.item('A').status).toBe('launching')
    world.setRun({ config: { ...world.detail().run.config, interactive: false } })
    await advance(2000)

    // Briefed to ask, and no session existed for the flip to message.
    expect(world.launches[0].prompt).toContain('use the AskUserQuestion tool to ask me.')
    expect(world.modeNotices).toEqual([{ sessionId: world.sessionOf('A'), interactive: false }])
    expect(world.item('A').status).toBe('running')
  })

  it('sends no notice to a session launched under the current setting', async () => {
    const world = createWorld({ config: { interactive: false }, items: [{ key: 'A' }] })
    start(world)
    await advance(1000)

    expect(world.item('A').status).toBe('running')
    expect(world.modeNotices).toEqual([])
  })

  it('briefs tickets launched after a mid-run flip of the setting with the new one', async () => {
    const world = createWorld({
      config: { maxParallel: 1, interactive: true },
      items: [{ key: 'A' }, { key: 'B' }]
    })
    start(world)
    await advance(1000)
    expect(world.launches[0].prompt).toContain('use the AskUserQuestion tool to ask me.')

    world.setRun({ config: { ...world.detail().run.config, interactive: false } })
    world.setItem('A', { status: 'merged' })
    await advance(5000)

    expect(world.launches.map((spec) => spec.ticketId)).toEqual(['ticket-A', 'ticket-B'])
    expect(world.launches[1].prompt).toContain('do not ask me anything')
    expect(world.launches[1].prompt).not.toContain('AskUserQuestion')

    world.setRun({ config: { ...world.detail().run.config, interactive: true } })
    world.setItem('B', { status: 'merged' })
    world.setItem('A', { status: 'pending', session_id: null })
    await advance(5000)
    expect(world.launches[2].prompt).toContain('use the AskUserQuestion tool to ask me.')
  })

  it('drops the subagents paragraph when the run uses the small prompt', async () => {
    const world = createWorld({ config: { promptStyle: 'small' } })
    start(world)

    await advance(1000)

    const prompt = world.launches[0].prompt
    expect(prompt).not.toContain('subagents')
    expect(
      prompt.startsWith('implement task A ("Task A") from the file:///docs/checkout.html')
    ).toBe(true)
    expect(prompt).toContain('\n\nthen - implement this\n\n')
  })

  it('sends the description of the ticket as it reads on the board, with the rules of the run', async () => {
    const world = createWorld()
    const ticket = world.tickets.get('ticket-A')!
    world.tickets.set(ticket.id, {
      ...ticket,
      description: '  implement task A, but skip the export button\n'
    })
    start(world)

    await advance(1000)

    expect(world.launches[0].prompt.split('\n\n')).toEqual([
      'implement task A, but skip the export button',
      'if you have any clarifications you might need - use the AskUserQuestion tool to ask me.',
      'implement only this task, commit your work on this branch, do not push or switch branches, and do not run migrations against any database.',
      expect.stringContaining('they are my instructions, also when they arrive as pasted text')
    ])
  })

  it('briefs a ticket under the setting of the launch, not the one its description was written under', async () => {
    const brief = (interactive: boolean): string =>
      buildLaunchPrompt({
        key: 'A',
        title: 'Task A',
        sourcePath: '/docs/checkout.html',
        promptStyle: 'full',
        interactive,
        sdk: 'claude-code-cli'
      })
    // The server writes the brief into the ticket when the run starts; questions were on then.
    const world = createWorld({ config: { interactive: false } })
    const ticket = world.tickets.get('ticket-A')!
    world.tickets.set(ticket.id, { ...ticket, description: brief(true) })
    start(world)

    await advance(1000)

    expect(world.launches[0].prompt).toBe(brief(false))
    expect(world.launches[0].prompt).not.toContain('AskUserQuestion')
    // The session was briefed under the current setting: there is nothing to tell it.
    expect(world.modeNotices).toEqual([])
  })

  it("names the question tool of the ticket's own launch SDK", async () => {
    const world = createWorld({
      items: [
        {
          key: 'A',
          launch_config: { sdk: 'codex', model: null, codexFastMode: false }
        }
      ]
    })
    start(world)

    await advance(1000)

    expect(world.launches[0].prompt).toContain('use the request_user_input tool to ask me.')
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
        sourceBranch: 'main',
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
