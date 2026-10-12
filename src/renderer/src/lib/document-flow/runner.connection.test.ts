import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildConflictPrompt,
  buildFixTicket,
  buildLaunchPrompt,
  connectionWorkspaceParagraph,
  withRunRules
} from '@shared/document-flow/prompts'
import type {
  DocumentMergeCheckResult,
  DocumentRunItem,
  DocumentVerifyResult
} from '@shared/types/document-flow'
import { DocumentFlowRunner } from './runner'
import {
  API_PROJECT,
  INTEGRATION_BRANCH,
  INTEGRATION_CONNECTION,
  MEMBERS,
  PROJECT_ID,
  TEST_NOW,
  WEB_PROJECT,
  advance,
  createWorld,
  makeItemMembers,
  type RunnerWorld
} from './runner-fakes'

// The runner on a connection project: the same loop, with the ticket launching into a new
// instance (a worktree per member, each cut from that member's integration tip), the fix
// session on the integration instance, and the agents told about the member repositories.

const PROMPTED_AT = '2026-05-04T09:59:00.000Z'
const WORKSPACE = [
  { symlinkName: 'web', projectName: 'Web' },
  { symlinkName: 'api', projectName: 'Api' }
]

const readyItem = (
  key: string,
  overrides: Partial<DocumentRunItem> = {}
): Partial<DocumentRunItem> => ({
  key,
  status: 'ready',
  session_id: `s-${key}`,
  connection_id: `conn-${key}`,
  members: makeItemMembers(key),
  branch_name: `${key.toLowerCase()}-task`,
  started_at: PROMPTED_AT,
  last_prompt_at: PROMPTED_AT,
  ...overrides
})

const failedIn = (
  member: (typeof MEMBERS)[number],
  command: string,
  output = 'FAIL src/x.test.ts'
): DocumentVerifyResult => ({
  skipped: false,
  ok: false,
  exitCode: 1,
  timedOut: false,
  output,
  durationMs: 5,
  failedMember: {
    project_id: member.project_id,
    project_name: member.project_name,
    symlink_name: member.symlink_name,
    command
  }
})

describe('DocumentFlowRunner on a connection project', () => {
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

  it('loads the members and the connections, and starts every member’s setup script', async () => {
    const world = createWorld({ connection: true })
    start(world)

    await advance(1000)

    expect(world.ports.loadProject).toHaveBeenCalledWith(PROJECT_ID, [WEB_PROJECT, API_PROJECT])
    expect(world.ports.fireSetupScript.mock.calls).toEqual([
      [WEB_PROJECT, 'wt-int-web', '/worktrees/web--doc-checkout'],
      [API_PROJECT, 'wt-int-api', '/worktrees/api--doc-checkout']
    ])
  })

  it('launches a ticket into a new instance cut from every member’s integration branch, and records it', async () => {
    const world = createWorld({
      connection: true,
      items: [{ key: 'A2', title: 'Ramp-up rule' }]
    })
    start(world)

    await advance(1000)

    const spec = world.launches[0]
    expect(spec).toMatchObject({
      ticketId: 'ticket-A2',
      projectId: PROJECT_ID,
      mode: 'build',
      worktree: {
        type: 'connection-new',
        savedProjectId: PROJECT_ID,
        // Each member against its own base branch, cut from its integration tip.
        members: [
          { projectId: WEB_PROJECT, sourceBranch: 'main', baseRef: INTEGRATION_BRANCH },
          { projectId: API_PROJECT, sourceBranch: 'develop', baseRef: INTEGRATION_BRANCH }
        ],
        nameHint: 'a2-ramp-up-rule'
      },
      ticketUpdateExtras: { column: 'in_progress', plan_ready: false, pending_launch_config: null }
    })
    // The standard brief with the connection paragraph, naming the members, under the rules
    // of the run (which place the paragraph where they place it).
    const rules = {
      interactive: true,
      sdk: 'claude-code-cli' as const,
      verification: [],
      workspace: WORKSPACE
    }
    expect(spec.prompt).toBe(
      withRunRules(
        buildLaunchPrompt({
          key: 'A2',
          title: 'Ramp-up rule',
          sourcePath: '/docs/checkout.html',
          promptStyle: 'full',
          ...rules
        }),
        rules
      )
    )
    expect(spec.prompt).toContain(
      'implement task A2 ("Ramp-up rule") from the file:///docs/checkout.html'
    )
    expect(spec.prompt).toContain(connectionWorkspaceParagraph(WORKSPACE))

    expect(world.item('A2')).toMatchObject({
      status: 'running',
      session_id: 'session-1',
      worktree_id: null,
      connection_id: 'conn-1',
      branch_name: 'a2-ramp-up-rule',
      members: [
        {
          project_id: WEB_PROJECT,
          worktree_id: 'wt-1-project-web',
          branch_name: 'a2-ramp-up-rule',
          pre_merge_sha: null,
          merge_sha: null
        },
        {
          project_id: API_PROJECT,
          worktree_id: 'wt-1-project-api',
          branch_name: 'a2-ramp-up-rule',
          pre_merge_sha: null,
          merge_sha: null
        }
      ]
    })
    expect(world.events.find((event) => event.type === 'launched')?.message).toContain(
      'in a new instance of 2 member repositories'
    )
  })

  it('keeps the connection paragraph in a brief the user edited on the board', async () => {
    const world = createWorld({ connection: true })
    world.tickets.set('ticket-A', {
      ...world.tickets.get('ticket-A')!,
      description: 'Build the thing exactly as the doc says.'
    })
    start(world)

    await advance(1000)

    expect(world.launches[0].prompt).toContain('Build the thing exactly as the doc says.')
    expect(world.launches[0].prompt).toContain(connectionWorkspaceParagraph(WORKSPACE))
  })

  describe('where a member branch is cut from while a merge lands', () => {
    it('starts each member from the commit before the merge that is still being verified', async () => {
      const world = createWorld({
        connection: true,
        config: { maxParallel: 3 },
        items: [
          {
            key: 'A',
            status: 'fixing',
            pre_merge_sha: 'web=before-a-web,api=before-a-api',
            merge_sha: 'web=merge-a-web',
            members: makeItemMembers('A', [
              { pre_merge_sha: 'before-a-web', merge_sha: 'merge-a-web' },
              { pre_merge_sha: 'before-a-api', merge_sha: null }
            ]),
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
        type: 'connection-new',
        members: [
          { projectId: WEB_PROJECT, baseRef: 'before-a-web' },
          { projectId: API_PROJECT, baseRef: 'before-a-api' }
        ]
      })
    })

    it('waits while a landing merge has no pre-merge commit recorded for one member yet', async () => {
      const world = createWorld({
        connection: true,
        config: { maxParallel: 3, memberVerifyCommands: { [WEB_PROJECT]: 'pnpm test' } },
        items: [
          {
            key: 'A',
            status: 'verifying',
            members: makeItemMembers('A', [{ pre_merge_sha: 'before-a-web' }, {}])
          },
          { key: 'B' }
        ]
      })
      world.api.verify.mockReturnValue(new Promise(() => {}))
      start(world)

      await advance(30_000)
      expect(world.launches).toEqual([])
      expect(world.item('B').status).toBe('pending')

      world.setItem('A', {
        members: makeItemMembers('A', [
          { pre_merge_sha: 'before-a-web' },
          { pre_merge_sha: 'before-a-api' }
        ])
      })
      await advance(1000)
      expect(world.launches[0].worktree).toMatchObject({
        members: [{ baseRef: 'before-a-web' }, { baseRef: 'before-a-api' }]
      })
    })
  })

  it('flags a failed launch with the instance it got as far as, and relaunches on Retry', async () => {
    const world = createWorld({ connection: true })
    world.ports.launchTicket.mockResolvedValueOnce({
      success: false,
      error: 'Failed to create worktree in "Api": disk full',
      connectionId: undefined
    })
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'Could not launch: Failed to create worktree in "Api": disk full',
      session_id: null,
      connection_id: null
    })
    expect(world.ports.resetTicketToTodo).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A')
  })

  describe('after a reload', () => {
    it('adopts the session of an interrupted launch with its instance’s member worktrees', async () => {
      const launchedAt = '2026-05-04T09:58:00.000Z'
      const world = createWorld({
        connection: true,
        items: [{ key: 'A', status: 'launching', started_at: launchedAt }]
      })
      world.tickets.set('ticket-A', {
        ...world.tickets.get('ticket-A')!,
        current_session_id: 'session-before-reload',
        worktree_id: null
      })
      world.sessionConnections.set('session-before-reload', 'conn-before-reload')
      world.connections.set('conn-before-reload', {
        id: 'conn-before-reload',
        path: '/connections/conn-before-reload',
        status: 'active',
        members: [
          {
            project_id: WEB_PROJECT,
            worktree_id: 'wt-a-web',
            branch_name: 'a-task-a',
            path: '/w/web'
          },
          {
            project_id: API_PROJECT,
            worktree_id: 'wt-a-api',
            branch_name: 'a-task-a-2',
            path: '/w/api'
          }
        ]
      })
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'running',
        session_id: 'session-before-reload',
        connection_id: 'conn-before-reload',
        worktree_id: null,
        // The name the members share: the first member's when a suffix told them apart.
        branch_name: 'a-task-a',
        members: [
          {
            project_id: WEB_PROJECT,
            worktree_id: 'wt-a-web',
            branch_name: 'a-task-a',
            pre_merge_sha: null,
            merge_sha: null
          },
          {
            project_id: API_PROJECT,
            worktree_id: 'wt-a-api',
            branch_name: 'a-task-a-2',
            pre_merge_sha: null,
            merge_sha: null
          }
        ],
        last_prompt_at: launchedAt
      })
      expect(world.ports.launchTicket).not.toHaveBeenCalled()
    })

    it('flags an adopted session whose instance is gone instead of launching twice', async () => {
      const world = createWorld({
        connection: true,
        items: [{ key: 'A', status: 'launching', started_at: PROMPTED_AT }]
      })
      world.tickets.set('ticket-A', {
        ...world.tickets.get('ticket-A')!,
        current_session_id: 'session-before-reload'
      })
      world.sessionConnections.set('session-before-reload', 'conn-gone')
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_attention',
        status_detail: 'The instance it was launched into no longer exists.'
      })
      expect(world.ports.launchTicket).not.toHaveBeenCalled()
    })
  })

  describe('verifying', () => {
    it('skips the checks when no member has a verify command, whatever the git-project command says', async () => {
      const world = createWorld({
        connection: true,
        config: { verifyCommand: 'pnpm test', memberVerifyCommands: {} },
        items: [readyItem('A')]
      })
      start(world)

      await advance(1000)

      expect(world.api.verify).not.toHaveBeenCalled()
      expect(world.item('A')).toMatchObject({ status: 'merged' })
    })

    it('runs the checks once any member has a command, after every member’s setup script', async () => {
      const world = createWorld({
        connection: true,
        config: { memberVerifyCommands: { [API_PROJECT]: 'make test' } },
        items: [readyItem('A')]
      })
      world.setupRunning.add('wt-int-api')
      start(world)

      await advance(25_000)
      expect(world.api.verify).not.toHaveBeenCalled()
      expect(world.item('A')).toMatchObject({
        status: 'verifying',
        status_detail: 'Waiting for the setup script to finish in the integration worktree.'
      })

      world.setupRunning.delete('wt-int-api')
      await advance(11_000)
      expect(world.api.verify).toHaveBeenCalledTimes(1)
      expect(world.item('A')).toMatchObject({ status: 'merged', status_detail: null })
    })

    it('starts the fix session on the integration instance, briefed with the members and the failing one', async () => {
      const world = createWorld({
        connection: true,
        config: {
          memberVerifyCommands: { [WEB_PROJECT]: 'pnpm check', [API_PROJECT]: 'make test' }
        },
        items: [readyItem('A', { title: 'Cart totals' })]
      })
      world.api.verify.mockResolvedValueOnce(failedIn(MEMBERS[1], 'make test'))
      start(world)

      await advance(1000)

      const fixTicket = buildFixTicket({
        documentTitle: 'Checkout redesign',
        key: 'A',
        title: 'Cart totals',
        integrationBranch: INTEGRATION_BRANCH,
        verifyCommand: 'make test',
        verifyOutput: 'FAIL src/x.test.ts',
        attempt: 1,
        interactive: true,
        workspace: WORKSPACE,
        failedMember: { symlinkName: 'api', projectName: 'Api' }
      })
      expect(world.ports.createTicket).toHaveBeenCalledWith(PROJECT_ID, fixTicket)
      expect(fixTicket.description).toContain('run inside that directory')
      expect(world.launches).toHaveLength(1)
      expect(world.launches[0]).toMatchObject({
        ticketId: 'fix-ticket-1',
        worktree: { type: 'existing-connection', connectionId: INTEGRATION_CONNECTION },
        mode: 'build'
      })
      expect(world.item('A')).toMatchObject({
        status: 'fixing',
        fix_ticket_id: 'fix-ticket-1',
        fix_session_id: 'session-2',
        fix_attempts: 1
      })
    })

    it('gives up with the instance named when the run has none to fix in', async () => {
      const world = createWorld({
        connection: true,
        run: { integration_connection_id: null },
        config: { memberVerifyCommands: { [WEB_PROJECT]: 'pnpm check' } },
        items: [readyItem('A')]
      })
      world.api.verify.mockResolvedValueOnce(failedIn(MEMBERS[0], 'pnpm check'))
      start(world)

      await advance(1000)

      expect(world.item('A').status).toBe('needs_attention')
      expect(world.item('A').status_detail).toContain(
        'The run has no integration instance to fix the checks in.'
      )
      expect(world.api.rollbackMerge).toHaveBeenCalledTimes(1)
    })
  })

  describe('conflicts', () => {
    const memberCheck = (
      member: (typeof MEMBERS)[number],
      head: string,
      conflictedFiles: string[]
    ): NonNullable<DocumentMergeCheckResult['members']>[number] => ({
      project_id: member.project_id,
      project_name: member.project_name,
      symlink_name: member.symlink_name,
      integrationBranch: member.integration_branch,
      integrationHead: head,
      state: conflictedFiles.length > 0 ? 'conflict' : 'clean',
      conflictedFiles,
      commitsAhead: conflictedFiles.length > 0 ? 2 : 0
    })

    it('tells the session which member repositories to merge in, each with its own commit', async () => {
      const world = createWorld({
        connection: true,
        items: [readyItem('A'), { key: 'B', status: 'merged' }]
      })
      world.api.prepareMerge.mockResolvedValueOnce({
        state: 'conflict',
        conflictedFiles: ['api/src/orders.ts'],
        integrationHead: 'web=w1,api=a1',
        committed: false,
        commitsAhead: 2,
        members: [
          memberCheck(MEMBERS[0], 'w1', []),
          memberCheck(MEMBERS[1], 'a1', ['src/orders.ts'])
        ]
      })
      start(world)

      await advance(1000)

      expect(world.followups).toEqual([
        {
          sessionId: 's-A',
          ticketId: 'ticket-A',
          prompt: buildConflictPrompt({
            integrationBranch: INTEGRATION_BRANCH,
            integrationCommit: 'web=w1,api=a1',
            conflictedFiles: ['api/src/orders.ts'],
            mergedTickets: [{ key: 'B', title: 'Task B' }],
            attempt: 1,
            interactive: true,
            // Only the member that conflicted, with the commit of its own integration branch.
            members: [
              {
                symlinkName: 'api',
                projectName: 'Api',
                integrationBranch: INTEGRATION_BRANCH,
                integrationCommit: 'a1'
              }
            ]
          })
        }
      ])
      expect(world.followups[0].prompt).toContain('`api/` (Api): `git merge a1`')
      expect(world.item('A')).toMatchObject({
        status: 'resolving_conflicts',
        conflict_attempts: 1,
        conflict_head: 'web=w1,api=a1'
      })
      expect(world.events.find((event) => event.type === 'conflict')?.message).toContain(
        'across api'
      )
    })

    it('names every member when the merge itself conflicted after a clean dry run', async () => {
      const world = createWorld({ connection: true, items: [readyItem('A')] })
      world.api.prepareMerge.mockResolvedValueOnce({
        state: 'clean',
        conflictedFiles: [],
        integrationHead: 'web=w1,api=a1',
        committed: false,
        commitsAhead: 1,
        members: [memberCheck(MEMBERS[0], 'w1', []), memberCheck(MEMBERS[1], 'a1', [])]
      })
      world.api.merge.mockResolvedValueOnce({
        success: false,
        conflictedFiles: ['web/src/app.ts']
      })
      start(world)

      await advance(1000)

      expect(world.followups[0].prompt).toContain('`web/` (Web): `git merge w1`')
      expect(world.followups[0].prompt).toContain('`api/` (Api): `git merge a1`')
      expect(world.item('A').status).toBe('resolving_conflicts')
    })
  })
})
