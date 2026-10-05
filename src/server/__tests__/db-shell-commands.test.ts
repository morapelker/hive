import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import type { ProjectUpdate, Session, SessionCreate, SessionUpdate } from '../../main/db'
import { makeEventBus } from '../events/event-bus'
import type { DbRpcService } from '../rpc/domains/db'
import { makeRpcRouter } from '../rpc/router'

// Only the members a test exercises are supplied: every handler under test calls exactly one.
const makeRouter = (db: Partial<DbRpcService>) =>
  makeRpcRouter({ eventBus: makeEventBus(), db: db as DbRpcService })

const call = (router: ReturnType<typeof makeRouter>, method: string, params: unknown) =>
  Effect.runPromise(router.handle({ id: 'req-1', method, params }))

const snapshot = {
  commandId: 'build',
  name: 'Build',
  script: 'pnpm build\npnpm test',
  detached: true,
  state: 'pending',
  runId: null,
  exitCode: null,
  signal: null,
  reason: null,
  error: null,
  startedAt: null,
  finishedAt: null
}

const session = { id: 'session-1' } as Session

describe('db.project.update with shell_commands', () => {
  const makeProjectRouter = (calls: Array<{ id: string; data: ProjectUpdate }>) =>
    makeRouter({
      updateProject: (id, data) =>
        Effect.sync(() => {
          calls.push({ id, data })
          return null
        })
    })

  it('forwards shell_commands with keepRunningOnQuit intact and strips unknown item keys', async () => {
    const calls: Array<{ id: string; data: ProjectUpdate }> = []
    const response = await call(makeProjectRouter(calls), 'db.project.update', {
      id: 'project-1',
      data: {
        shell_commands: [
          {
            id: 'install',
            name: 'Install',
            commands: 'pnpm install:mac',
            keepRunningOnQuit: true,
            unexpected: 'dropped'
          },
          { id: 'build', name: 'Build', commands: 'pnpm build' }
        ]
      }
    })

    expect(response).toEqual({ id: 'req-1', ok: true, value: null })
    expect(calls).toEqual([
      {
        id: 'project-1',
        data: {
          shell_commands: [
            {
              id: 'install',
              name: 'Install',
              commands: 'pnpm install:mac',
              keepRunningOnQuit: true
            },
            { id: 'build', name: 'Build', commands: 'pnpm build' }
          ]
        }
      }
    ])
  })

  it('forwards null (clear) and leaves the key out when the caller did not send it', async () => {
    const calls: Array<{ id: string; data: ProjectUpdate }> = []
    const router = makeProjectRouter(calls)

    await call(router, 'db.project.update', { id: 'project-1', data: { shell_commands: null } })
    await call(router, 'db.project.update', { id: 'project-1', data: { name: 'Renamed' } })

    expect(calls[0].data).toEqual({ shell_commands: null })
    expect(calls[1].data).toEqual({ name: 'Renamed' })
    expect('shell_commands' in calls[1].data).toBe(false)
  })

  it('rejects malformed definitions', async () => {
    const calls: Array<{ id: string; data: ProjectUpdate }> = []
    const router = makeProjectRouter(calls)
    const command = { id: 'build', name: 'Build', commands: 'pnpm build' }

    for (const shellCommands of [
      [{ ...command, keepRunningOnQuit: 'yes' }],
      [{ ...command, id: '' }],
      [{ ...command, id: 'x'.repeat(65) }],
      [{ ...command, commands: 'x'.repeat(64 * 1024 + 1) }],
      [{ id: 'build', name: 'Build' }],
      Array.from({ length: 51 }, (_, index) => ({ ...command, id: `cmd-${index}` })),
      'pnpm build'
    ]) {
      const response = await call(router, 'db.project.update', {
        id: 'project-1',
        data: { shell_commands: shellCommands }
      })
      expect(response).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    }
    expect(calls).toEqual([])
  })
})

describe('db.session.create for shell-command sessions', () => {
  const makeSessionRouter = (calls: SessionCreate[]) =>
    makeRouter({
      createSession: (data) =>
        Effect.sync(() => {
          calls.push(data)
          return session
        })
    })

  const params = (overrides: Record<string, unknown> = {}) => ({
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    agent_sdk: 'terminal',
    session_type: 'shell-command',
    shell_command: JSON.stringify(snapshot),
    ...overrides
  })

  it('forwards the snapshot reset to pending even when the caller forged run state', async () => {
    const calls: SessionCreate[] = []
    const response = await call(
      makeSessionRouter(calls),
      'db.session.create',
      params({
        name: 'Build',
        shell_command: JSON.stringify({
          ...snapshot,
          state: 'succeeded',
          runId: 'run-1',
          exitCode: 0,
          signal: 15,
          reason: 'output-limit',
          error: 'forged',
          startedAt: '2026-10-05T00:00:00.000Z',
          finishedAt: '2026-10-05T00:00:01.000Z',
          unexpected: 'dropped'
        })
      })
    )

    expect(response).toEqual({ id: 'req-1', ok: true, value: session })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      worktree_id: 'worktree-1',
      project_id: 'project-1',
      name: 'Build',
      agent_sdk: 'terminal',
      session_type: 'shell-command'
    })
    expect(JSON.parse(calls[0].shell_command as string)).toEqual(snapshot)
  })

  it('rejects a non-terminal agent_sdk, a missing worktree and an unparsable snapshot', async () => {
    const calls: SessionCreate[] = []
    const router = makeSessionRouter(calls)

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ agent_sdk: 'claude-code-cli' }, 'Shell command sessions must use the terminal SDK'],
      [{ agent_sdk: undefined }, 'Shell command sessions must use the terminal SDK'],
      [{ worktree_id: null }, 'Shell command sessions need a worktree'],
      [{ shell_command: '{not json' }, 'Invalid shell command snapshot'],
      [{ shell_command: null }, 'Invalid shell command snapshot'],
      [{ shell_command: undefined }, 'Invalid shell command snapshot'],
      [
        { shell_command: JSON.stringify({ ...snapshot, script: '   ' }) },
        'Invalid shell command snapshot'
      ]
    ]
    for (const [overrides, message] of cases) {
      const response = await call(router, 'db.session.create', params(overrides))
      expect(response).toMatchObject({ ok: false, error: { message } })
    }
    expect(calls).toEqual([])
  })

  it('rejects shell_command on a session that is not a shell command', async () => {
    const calls: SessionCreate[] = []
    const router = makeSessionRouter(calls)

    for (const overrides of [{ session_type: 'default' }, { session_type: undefined }]) {
      const response = await call(router, 'db.session.create', params(overrides))
      expect(response).toMatchObject({
        ok: false,
        error: { message: 'shell_command is only valid for shell-command sessions' }
      })
    }
    expect(calls).toEqual([])
  })

  it('leaves ordinary sessions untouched', async () => {
    const calls: SessionCreate[] = []
    const response = await call(makeSessionRouter(calls), 'db.session.create', {
      worktree_id: 'worktree-1',
      project_id: 'project-1',
      agent_sdk: 'terminal'
    })

    expect(response).toMatchObject({ ok: true })
    expect(calls).toEqual([
      { worktree_id: 'worktree-1', project_id: 'project-1', agent_sdk: 'terminal' }
    ])
  })
})

describe('db.session.update', () => {
  it('does not forward shell_command: only the main process writes run state', async () => {
    const calls: Array<{ id: string; data: SessionUpdate }> = []
    const router = makeRouter({
      updateSession: (id, data) =>
        Effect.sync(() => {
          calls.push({ id, data })
          return null
        })
    })

    const response = await call(router, 'db.session.update', {
      id: 'session-1',
      data: { name: 'Renamed', shell_command: JSON.stringify({ ...snapshot, state: 'succeeded' }) }
    })

    expect(response).toEqual({ id: 'req-1', ok: true, value: null })
    expect(calls).toEqual([{ id: 'session-1', data: { name: 'Renamed' } }])
    expect('shell_command' in calls[0].data).toBe(false)
  })
})

describe('db.session.getShellCommandRuns', () => {
  const rows = [
    {
      sessionId: 'session-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      shellCommand: JSON.stringify(snapshot)
    },
    { sessionId: 'session-2', projectId: 'project-1', worktreeId: null, shellCommand: '{}' }
  ]

  it('returns the service rows', async () => {
    const router = makeRouter({ getShellCommandRuns: () => Effect.succeed(rows) })

    for (const params of [{}, undefined, null]) {
      expect(await call(router, 'db.session.getShellCommandRuns', params)).toEqual({
        id: 'req-1',
        ok: true,
        value: rows
      })
    }
  })

  it('returns [] when the service does not implement it', async () => {
    expect(await call(makeRouter({}), 'db.session.getShellCommandRuns', {})).toEqual({
      id: 'req-1',
      ok: true,
      value: []
    })
  })

  it('rejects non-empty params', async () => {
    let called = false
    const router = makeRouter({
      getShellCommandRuns: () =>
        Effect.sync(() => {
          called = true
          return rows
        })
    })

    expect(
      await call(router, 'db.session.getShellCommandRuns', { projectId: 'project-1' })
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(called).toBe(false)
  })
})
