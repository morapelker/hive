import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ptyService } from '../pty-service'

const nodePtyMocks = vi.hoisted(() => ({
  spawn: vi.fn()
}))

vi.mock('node-pty', () => ({
  spawn: nodePtyMocks.spawn
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

function makeFakePty(pid = 4242): Record<string, unknown> {
  return {
    pid,
    cols: 80,
    rows: 24,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn()
  }
}

function spawnedEnv(): Record<string, string> {
  const call = nodePtyMocks.spawn.mock.calls.at(-1)
  return call?.[2].env as Record<string, string>
}

describe('ptyService.create spawn environment', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const touchedKeys = ['COLUMNS', 'LINES', 'TERM', 'COLORTERM'] as const
  let nextId = 0

  beforeEach(() => {
    for (const key of touchedKeys) savedEnv[key] = process.env[key]
    nodePtyMocks.spawn.mockImplementation(() => makeFakePty())
  })

  afterEach(() => {
    for (const key of touchedKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    vi.clearAllMocks()
  })

  function create(opts: Record<string, unknown> = {}): void {
    ptyService.create(`pty-env-test-${nextId++}`, { cwd: '/tmp', ...opts })
  }

  it('strips COLUMNS and LINES inherited from the login shell env', () => {
    process.env.COLUMNS = '80'
    process.env.LINES = '24'

    create()

    expect(spawnedEnv().COLUMNS).toBeUndefined()
    expect(spawnedEnv().LINES).toBeUndefined()
  })

  it('forces TERM and COLORTERM regardless of the inherited values', () => {
    process.env.TERM = 'dumb'
    process.env.COLORTERM = ''

    create()

    expect(spawnedEnv().TERM).toBe('xterm-256color')
    expect(spawnedEnv().COLORTERM).toBe('truecolor')
  })

  it('keeps explicit caller env overrides, including COLUMNS', () => {
    process.env.COLUMNS = '80'

    create({ env: { COLUMNS: '120', HIVE_TEST_VAR: 'yes' } })

    expect(spawnedEnv().COLUMNS).toBe('120')
    expect(spawnedEnv().HIVE_TEST_VAR).toBe('yes')
  })
})

type KillFn = (pid: number, signal?: string | number) => true

describe('ptyService.destroy kill escalation', () => {
  const PID = 4242
  let killSpy: MockInstance<KillFn>
  let groupMembersSpy: MockInstance<(pgid: number) => Promise<Set<number>>>
  let nextId = 0

  function createAndGetPty(): { kill: ReturnType<typeof vi.fn> } {
    const id = `pty-escalation-test-${nextId++}`
    ptyService.create(id, { cwd: '/tmp' })
    const fakePty = nodePtyMocks.spawn.mock.results.at(-1)?.value as {
      kill: ReturnType<typeof vi.fn>
    }
    ptyService.destroy(id)
    return fakePty
  }

  async function advancePastGrace(): Promise<void> {
    await vi.advanceTimersByTimeAsync(1500)
    // Flush the snapshot/ownership promise chains the timer kicked off
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    // Drain ptys left registered by other describes — their (shared fake)
    // pids would trip the registered-pty guard in reapSurvivors. Fake timers
    // keep the escalations this schedules permanently inert.
    ptyService.destroyAll()
    vi.clearAllTimers()
    nodePtyMocks.spawn.mockImplementation(() => makeFakePty(PID))
    killSpy = vi.spyOn(process, 'kill') as unknown as MockInstance<KillFn>
    // Never run the real pgrep in unit tests
    groupMembersSpy = vi
      .spyOn(
        ptyService as unknown as { listGroupMembers(pgid: number): Promise<Set<number>> },
        'listGroupMembers'
      )
      .mockResolvedValue(new Set<number>()) as unknown as MockInstance<
      (pgid: number) => Promise<Set<number>>
    >
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    killSpy.mockRestore()
    groupMembersSpy.mockRestore()
    vi.clearAllMocks()
  })

  it('escalates to a process-group SIGKILL when the process survives SIGHUP', async () => {
    killSpy.mockImplementation((() => true) as KillFn)

    const fakePty = createAndGetPty()

    expect(fakePty.kill).toHaveBeenCalledTimes(1)
    expect(killSpy).not.toHaveBeenCalled()

    await advancePastGrace()

    expect(killSpy).toHaveBeenCalledWith(PID, 0)
    expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL')
  })

  it('does not escalate when the process and its group are both dead at probe time', async () => {
    killSpy.mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      return true
    }) as KillFn)

    createAndGetPty()
    await advancePastGrace()

    expect(killSpy).toHaveBeenCalledWith(PID, 0)
    expect(killSpy).toHaveBeenCalledWith(-PID, 0)
    expect(killSpy).not.toHaveBeenCalledWith(-PID, 'SIGKILL')
    expect(killSpy).not.toHaveBeenCalledWith(PID, 'SIGKILL')
  })

  it('escalates when the wrapper shell died but a snapshot member survives in the group', async () => {
    // Custom-provider topology: the direct child ($SHELL wrapper) is reaped,
    // but a HUP-ignoring agent in the same process group lives on. The agent
    // (999) appears in both the destroy-time snapshot and the current group,
    // proving ownership continuity.
    groupMembersSpy.mockResolvedValue(new Set([PID, 999]))
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid > 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      return true
    }) as KillFn)

    createAndGetPty()
    await advancePastGrace()

    expect(killSpy).toHaveBeenCalledWith(-PID, 0)
    expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL')
  })

  it('does not kill a group that no longer traces to the destroyed PTY (reused pgid)', async () => {
    // At destroy time the group held only the leader; at escalation time the
    // probe finds a live group, but none of its members were ours — the
    // numeric pgid was recycled by an unrelated process. No SIGKILL.
    groupMembersSpy
      .mockResolvedValueOnce(new Set([PID])) // destroy-time snapshot
      .mockResolvedValueOnce(new Set([777])) // escalation-time membership
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid > 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      return true
    }) as KillFn)

    createAndGetPty()
    await advancePastGrace()

    expect(killSpy).toHaveBeenCalledWith(-PID, 0)
    expect(killSpy).not.toHaveBeenCalledWith(-PID, 'SIGKILL')
    expect(killSpy).not.toHaveBeenCalledWith(PID, 'SIGKILL')
  })

  it('kills the surviving group even when the snapshot is empty (pgrep failure fails open)', async () => {
    // Default groupMembersSpy resolves an empty set — a tooling failure must
    // not disable the escalation, or the HUP-surviving leak returns.
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid > 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      return true
    }) as KillFn)

    createAndGetPty()
    await advancePastGrace()

    expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL')
  })

  it('does not kill blind when the leader exited and there is no membership evidence', async () => {
    // Exited leader + empty snapshot: an alive group with zero traced
    // members is treated as a recycled pgid, not an untracked survivor.
    const EXITED = 7575
    nodePtyMocks.spawn.mockImplementation(() => makeFakePty(EXITED))
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid > 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      return true
    }) as KillFn)

    const id = `pty-escalation-test-${nextId++}`
    ptyService.create(id, { cwd: '/tmp' })
    const fakePty = nodePtyMocks.spawn.mock.results.at(-1)?.value as {
      onExit: ReturnType<typeof vi.fn>
    }
    ptyService.destroy(id)
    const exitHandler = fakePty.onExit.mock.calls[0][0] as (e: {
      exitCode: number
      signal: number
    }) => void
    exitHandler({ exitCode: 0, signal: 1 })

    await advancePastGrace()

    expect(killSpy).not.toHaveBeenCalledWith(-EXITED, 'SIGKILL')
    expect(killSpy).not.toHaveBeenCalledWith(EXITED, 'SIGKILL')
  })

  it('a new PTY reusing an exited pid is probed normally (ledger cleared on spawn)', async () => {
    const RECYCLED = 6464
    nodePtyMocks.spawn.mockImplementation(() => makeFakePty(RECYCLED))
    killSpy.mockImplementation((() => true) as KillFn)

    // First pty exits — its pid lands in the exited ledger
    const firstId = `pty-escalation-test-${nextId++}`
    ptyService.create(firstId, { cwd: '/tmp' })
    const firstPty = nodePtyMocks.spawn.mock.results.at(-1)?.value as {
      onExit: ReturnType<typeof vi.fn>
    }
    const exitHandler = firstPty.onExit.mock.calls[0][0] as (e: {
      exitCode: number
      signal: number
    }) => void
    ptyService.destroy(firstId)
    exitHandler({ exitCode: 0, signal: 1 })
    await advancePastGrace()
    killSpy.mockClear()

    // A new pty spawns with the same (recycled) pid — create() must clear
    // the stale ledger entry so its own destroy escalation still probes it
    const secondId = `pty-escalation-test-${nextId++}`
    ptyService.create(secondId, { cwd: '/tmp' })
    ptyService.destroy(secondId)
    await advancePastGrace()

    expect(killSpy).toHaveBeenCalledWith(RECYCLED, 0)
    expect(killSpy).toHaveBeenCalledWith(-RECYCLED, 'SIGKILL')
  })

  it('never signals the numeric pid after the pty reported exit (pid-reuse hazard)', async () => {
    // Distinct pid: the exited-pid ledger is module-level and must not leak
    // into the other escalation tests.
    const REUSED_PID = 5353
    nodePtyMocks.spawn.mockImplementation(() => makeFakePty(REUSED_PID))
    // Simulate the worst case: the pid probe would "succeed" because an
    // unrelated process inherited the number; the group is empty.
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid < 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      return true
    }) as KillFn)

    const id = `pty-escalation-test-${nextId++}`
    ptyService.create(id, { cwd: '/tmp' })
    const fakePty = nodePtyMocks.spawn.mock.results.at(-1)?.value as {
      onExit: ReturnType<typeof vi.fn>
    }
    ptyService.destroy(id)
    // The child exits (and is reaped) during the grace period
    const exitHandler = fakePty.onExit.mock.calls[0][0] as (e: {
      exitCode: number
      signal: number
    }) => void
    exitHandler({ exitCode: 0, signal: 1 })

    await advancePastGrace()

    expect(killSpy).not.toHaveBeenCalledWith(REUSED_PID, 0)
    expect(killSpy).toHaveBeenCalledWith(-REUSED_PID, 0)
    expect(killSpy).not.toHaveBeenCalledWith(REUSED_PID, 'SIGKILL')
    expect(killSpy).not.toHaveBeenCalledWith(-REUSED_PID, 'SIGKILL')
  })

  it('falls back to a direct SIGKILL when the group kill fails', async () => {
    killSpy.mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0) return true
      if (pid < 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return true
    }) as KillFn)

    createAndGetPty()
    await advancePastGrace()

    expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL')
    expect(killSpy).toHaveBeenCalledWith(PID, 'SIGKILL')
  })

  it('a stale escalation timer never touches a pid recycled into a registered pty', async () => {
    const STALE = 8686
    nodePtyMocks.spawn.mockImplementation(() => makeFakePty(STALE))
    killSpy.mockImplementation((() => true) as KillFn)

    // Destroy arms the escalation timer for pid STALE
    const firstId = `pty-escalation-test-${nextId++}`
    ptyService.create(firstId, { cwd: '/tmp' })
    ptyService.destroy(firstId)

    // Before the grace elapses, a NEW pty spawns and the OS recycles the pid
    const secondId = `pty-escalation-test-${nextId++}`
    ptyService.create(secondId, { cwd: '/tmp' })

    await advancePastGrace()

    // The stale timer must not probe or signal the new session's process
    expect(killSpy).not.toHaveBeenCalledWith(-STALE, 'SIGKILL')
    expect(killSpy).not.toHaveBeenCalledWith(STALE, 'SIGKILL')

    ptyService.destroy(secondId)
  })

  it('destroyAllAndReap sweeps survivors after the bounded grace (quit path)', async () => {
    killSpy.mockImplementation((() => true) as KillFn)

    const id = `pty-escalation-test-${nextId++}`
    ptyService.create(id, { cwd: '/tmp' })
    const fakePty = nodePtyMocks.spawn.mock.results.at(-1)?.value as {
      kill: ReturnType<typeof vi.fn>
    }

    const reap = ptyService.destroyAllAndReap(300)
    expect(fakePty.kill).toHaveBeenCalledTimes(1)
    expect(killSpy).not.toHaveBeenCalledWith(-PID, 'SIGKILL')

    await vi.advanceTimersByTimeAsync(300)
    await reap

    expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL')
  })

  it('a late exit of a destroyed PTY does not unregister the PTY that reused its id', () => {
    // A shell command's Run again: destroy the old run's PTY, create a new one under
    // the same session id, and only then does the old process report its exit.
    // (Lives in this describe for its inert timers and kill spy: destroy() arms the
    // escalation, which must never probe real pids from a unit test.)
    type ExitHandler = (e: { exitCode: number; signal: number }) => void
    killSpy.mockImplementation((() => true) as KillFn)
    const first = makeFakePty(7101)
    const second = makeFakePty(7102)
    nodePtyMocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)

    ptyService.create('reused-id', { cwd: '/tmp' })
    ptyService.destroy('reused-id')
    expect(ptyService.has('reused-id')).toBe(false)

    ptyService.create('reused-id', { cwd: '/tmp' })
    const secondExits: Array<[number, number]> = []
    ptyService.onExit('reused-id', (code, signal) => secondExits.push([code, signal]))

    const firstExit = (first.onExit as ReturnType<typeof vi.fn>).mock.calls[0][0] as ExitHandler
    firstExit({ exitCode: 0, signal: 1 })

    expect(ptyService.has('reused-id')).toBe(true)
    expect(secondExits).toEqual([])
    ptyService.write('reused-id', 'still here\r')
    expect(second.write).toHaveBeenCalledWith('still here\r')
    expect(first.write).not.toHaveBeenCalled()

    // The second PTY's own exit still unregisters it.
    const secondExit = (second.onExit as ReturnType<typeof vi.fn>).mock.calls[0][0] as ExitHandler
    secondExit({ exitCode: 3, signal: 0 })
    expect(secondExits).toEqual([[3, 0]])
    expect(ptyService.has('reused-id')).toBe(false)
  })
})

describe('ptyService.listInstances activity timestamps', () => {
  let nextId = 0

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    nodePtyMocks.spawn.mockImplementation(() => makeFakePty(5151))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('reports pid and cwd, and stamps output and input separately', () => {
    const id = `pty-list-test-${nextId++}`
    ptyService.create(id, { cwd: '/repo/worktree' })
    const fakePty = nodePtyMocks.spawn.mock.results.at(-1)?.value as {
      onData: ReturnType<typeof vi.fn>
    }
    const emitData = fakePty.onData.mock.calls[0][0] as (data: string) => void
    const info = (): unknown => ptyService.listInstances().find((entry) => entry.id === id)

    expect(info()).toEqual({
      id,
      pid: 5151,
      cwd: '/repo/worktree',
      backend: 'node-pty',
      createdAt: 1_000_000,
      lastOutputAt: 1_000_000,
      lastInputAt: 1_000_000
    })

    vi.setSystemTime(1_005_000)
    emitData('hello')
    vi.setSystemTime(1_009_000)
    ptyService.write(id, 'ls\r')

    expect(info()).toMatchObject({ lastOutputAt: 1_005_000, lastInputAt: 1_009_000 })

    ptyService.destroy(id)
    expect(info()).toBeUndefined()
  })
})
