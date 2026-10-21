import { describe, expect, it, vi } from 'vitest'
import type { SessionProfilerDbRow } from '../db/database'
import type { PtyInstanceInfo } from './pty-service'

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
// The live wiring is never used here (every test builds its own profiler), but the module
// imports it; keep the heavy main-process modules out of the test.
vi.mock('../db/database', () => ({ getDatabase: vi.fn() }))
vi.mock('./claude-cli-background-work-tracker', () => ({
  getClaudeCliBackgroundWorkCounts: vi.fn()
}))
vi.mock('./claude-hook-server', () => ({ getLastClaudeCliStatus: vi.fn() }))
vi.mock('./pty-service', () => ({ ptyService: {} }))
vi.mock('./terminal-pty-bridge', () => ({
  isAgentCliTerminal: vi.fn(),
  isCodexCliTerminal: vi.fn(),
  reapCliTerminal: vi.fn()
}))

import {
  SESSION_PROFILER_IDLE_THRESHOLD_SECONDS,
  agentKindFor,
  buildChildrenIndex,
  collectSubtree,
  cpuDeltas,
  cpuPercentOf,
  createSessionProfiler,
  deriveIrrelevantReasons,
  detectSessions,
  makeCpuSample,
  orphanParentsOf,
  parsePsDuration,
  parsePsLine,
  parsePsOutput,
  psArgs,
  sameStartedAt,
  ttyDevicePath,
  type SessionProfilerDeps
} from './session-profiler'

const APP = 500
const SERVER = 510
const UUID_A = 'aaaaaaaa-1111-2222-3333-444444444444'
const UUID_B = 'bbbbbbbb-1111-2222-3333-444444444444'
const UUID_C = 'cccccccc-1111-2222-3333-444444444444'
const LSTART = 'Wed Oct 21 00:46:03 2026'

interface Proc {
  pid: number
  ppid: number
  pgid?: number
  rssKb?: number
  time?: string
  etime?: string
  stat?: string
  tty?: string
  lstart?: string
  args: string
}

const psLine = (p: Proc): string =>
  [
    String(p.pid).padStart(5),
    String(p.ppid).padStart(5),
    String(p.pgid ?? p.pid).padStart(5),
    String(p.rssKb ?? 1000).padStart(6),
    (p.time ?? '0:01.00').padStart(9),
    (p.etime ?? '10:00').padStart(11),
    (p.stat ?? 'S').padEnd(4),
    (p.tty ?? '??').padStart(6),
    p.lstart ?? LSTART,
    '   ',
    p.args
  ].join(' ')

const psOutput = (procs: Proc[]): string => procs.map(psLine).join('\n') + '\n'

const claudeArgs = (uuid: string): string =>
  `/Users/me/.local/bin/claude --resume x --settings {"hooks":{"Stop":[{"hooks":[{"type":"http","url":"http://127.0.0.1:4100/hook/${uuid}/stop"}]}]}}`
const codexArgs = (uuid: string): string =>
  `/opt/codex resume -c hooks.Stop="curl -s http://127.0.0.1:4100/codex-hook/${uuid}/stop"`

const baseTree = (extra: Proc[] = []): Proc[] => [
  { pid: 1, ppid: 0, args: '/sbin/launchd' },
  {
    pid: APP,
    ppid: 1,
    rssKb: 200_000,
    time: '1:00.00',
    args: '/Applications/Hive.app/Contents/MacOS/Hive'
  },
  { pid: SERVER, ppid: APP, rssKb: 100_000, args: 'Hive Helper out/main/server.js' },
  ...extra
]

const pty = (
  id: string,
  pid: number,
  overrides: Partial<PtyInstanceInfo> = {}
): PtyInstanceInfo => ({
  id,
  pid,
  cwd: `/wt/${id}`,
  backend: 'node-pty',
  createdAt: 0,
  lastOutputAt: 0,
  lastInputAt: 0,
  ...overrides
})

const dbRow = (
  id: string,
  overrides: Partial<SessionProfilerDbRow> = {}
): SessionProfilerDbRow => ({
  id,
  sessionExists: true,
  name: `Session ${id.slice(0, 4)}`,
  status: 'active',
  agentSdk: 'claude-code-cli',
  worktreeName: 'feature',
  worktreePath: '/wt/feature',
  worktreeArchived: false,
  projectName: 'repo',
  ticket: null,
  documentRunBusy: false,
  ...overrides
})

function makeDeps(overrides: Partial<SessionProfilerDeps> & { psOutputs?: string[] } = {}): {
  deps: SessionProfilerDeps
  runPs: ReturnType<typeof vi.fn>
  clock: { now: number }
} {
  const clock = { now: 1_000_000 }
  const outputs = overrides.psOutputs ?? [psOutput(baseTree())]
  let call = 0
  const runPs = vi.fn(async () => {
    const stdout = outputs[Math.min(call, outputs.length - 1)]
    call += 1
    return { stdout, psPid: null }
  })
  const deps: SessionProfilerDeps = {
    platform: 'darwin',
    appPid: APP,
    appParentPid: 1,
    runPs,
    listPtys: () => [],
    hasPty: () => true,
    isAgentCliTerminal: () => true,
    isCodexCliTerminal: () => false,
    reapCliTerminal: () => true,
    getDbRows: (ids) => ids.map((id) => dbRow(id)),
    getLiveStatus: () => undefined,
    getBackgroundWork: () => 0,
    isPaused: () => false,
    statTty: async () => null,
    kill: () => undefined,
    cpuCount: () => 8,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms
    },
    ...overrides
  }
  return { deps, runPs, clock }
}

describe('ps parsing', () => {
  it('parses macOS cpu time and elapsed formats', () => {
    expect(parsePsDuration('0:00.00')).toBe(0)
    expect(parsePsDuration('1:16.85')).toBeCloseTo(76.85)
    expect(parsePsDuration('4592:55.39')).toBeCloseTo(4592 * 60 + 55.39)
    expect(parsePsDuration('00:00')).toBe(0)
    expect(parsePsDuration('30:19')).toBe(30 * 60 + 19)
    expect(parsePsDuration('11:15:35')).toBe(11 * 3600 + 15 * 60 + 35)
    expect(parsePsDuration('07-11:15:35')).toBe(7 * 86_400 + 11 * 3600 + 15 * 60 + 35)
  })

  it('parses procps time formats', () => {
    expect(parsePsDuration('00:01:23')).toBe(83)
    expect(parsePsDuration('1-02:03:04')).toBe(86_400 + 2 * 3600 + 3 * 60 + 4)
    expect(Number.isNaN(parsePsDuration('garbage'))).toBe(true)
  })

  it('parses a real macOS line, keeping spaces inside args', () => {
    const line =
      '62215 57034 62215 1201552   1:16.85       30:19 Ss+  16/1 Wed Oct 21 00:46:03 2026     /Users/mor/.local/bin/claude --model opus --settings {"a": "b c"}'
    expect(parsePsLine(line)).toEqual({
      pid: 62215,
      ppid: 57034,
      pgid: 62215,
      rssBytes: 1201552 * 1024,
      cpuSeconds: expect.closeTo(76.85, 5),
      elapsedSeconds: 30 * 60 + 19,
      stat: 'Ss+',
      tty: '16/1',
      startedAt: 'Wed Oct 21 00:46:03 2026',
      args: '/Users/mor/.local/bin/claude --model opus --settings {"a": "b c"}'
    })
  })

  it('collapses the padded day of lstart and treats ?? as no tty', () => {
    const line =
      '  335     1   335  14048   3:52.90 07-11:14:20 Ss     ?? Tue Oct  6 14:02:02 2026     /usr/libexec/UserEventAgent (System)'
    const proc = parsePsLine(line)
    expect(proc?.startedAt).toBe('Tue Oct 6 14:02:02 2026')
    expect(proc?.tty).toBeNull()
    expect(proc?.args).toBe('/usr/libexec/UserEventAgent (System)')
  })

  it('accepts a line without args and skips garbage lines', () => {
    const out = parsePsOutput(
      [
        '  77     1    77      0   0:00.00       01:00 Z      ?? Wed Oct 21 00:46:03 2026',
        'not a ps line',
        ''
      ].join('\n')
    )
    expect([...out.keys()]).toEqual([77])
    expect(out.get(77)?.args).toBe('')
  })

  it('asks for tdev on macOS and tty elsewhere', () => {
    expect(psArgs('darwin').at(-1)).toBe(
      'pid=,ppid=,pgid=,rss=,time=,etime=,stat=,tdev=,lstart=,args='
    )
    expect(psArgs('linux').at(-1)).toBe(
      'pid=,ppid=,pgid=,rss=,time=,etime=,stat=,tty=,lstart=,args='
    )
  })

  it('maps tty columns to device paths', () => {
    expect(ttyDevicePath('16/17', 'darwin')).toEqual({ path: '/dev/ttys017', rdev: 0x10000011 })
    expect(ttyDevicePath(null, 'darwin')).toBeNull()
    expect(ttyDevicePath('pts/3', 'linux')).toEqual({ path: '/dev/pts/3', rdev: null })
    expect(ttyDevicePath('../etc', 'linux')).toBeNull()
  })
})

describe('process tree and CPU', () => {
  it('collects a subtree iteratively and survives cycles', () => {
    const processes = parsePsOutput(
      psOutput([
        { pid: 1, ppid: 0, args: 'init' },
        { pid: 10, ppid: 1, args: 'a' },
        { pid: 11, ppid: 10, args: 'b' },
        { pid: 12, ppid: 11, args: 'c' },
        { pid: 20, ppid: 1, args: 'other' },
        { pid: 30, ppid: 31, args: 'loop' },
        { pid: 31, ppid: 30, args: 'loop' }
      ])
    )
    const children = buildChildrenIndex(processes)
    expect([...collectSubtree(10, children)].sort()).toEqual([10, 11, 12])
    expect([...collectSubtree(30, children)].sort()).toEqual([30, 31])
  })

  it('diffs cumulative cpu time per pid:lstart', () => {
    const before = parsePsOutput(
      psOutput([
        { pid: 10, ppid: 1, time: '0:10.00', args: 'a' },
        { pid: 11, ppid: 1, time: '0:05.00', args: 'reused', lstart: 'Wed Oct 21 00:00:00 2026' }
      ])
    )
    const after = parsePsOutput(
      psOutput([
        { pid: 10, ppid: 1, time: '0:13.00', args: 'a' },
        // Same pid, different start: a new process — all its CPU is inside the window.
        { pid: 11, ppid: 1, time: '0:01.50', args: 'new', lstart: 'Wed Oct 21 00:59:00 2026' },
        { pid: 12, ppid: 1, time: '0:00.50', args: 'born' }
      ])
    )
    const deltas = cpuDeltas(after, makeCpuSample(before, 0))
    expect(deltas.get(10)).toBeCloseTo(3)
    expect(deltas.get(11)).toBeCloseTo(1.5)
    expect(deltas.get(12)).toBeCloseTo(0.5)
    // 3 s of CPU over a 2 s window = 150% of one core.
    expect(cpuPercentOf([10], deltas, 2000)).toBe(150)
    expect(cpuPercentOf([10, 11, 12], deltas, 10_000)).toBe(50)
  })

  it('keeps a process whose lstart moved with a clock step (same etime-derived start)', () => {
    const before = parsePsOutput(
      psOutput([{ pid: 10, ppid: 1, time: '600:00.00', etime: '10:00:00', args: 'main' }])
    )
    // 60 s later the wall clock was stepped by a second: lstart reads differently.
    const after = parsePsOutput(
      psOutput([
        {
          pid: 10,
          ppid: 1,
          time: '600:30.00',
          etime: '10:01:00',
          lstart: 'Wed Oct 21 00:46:04 2026',
          args: 'main'
        }
      ])
    )
    expect(cpuDeltas(after, makeCpuSample(before, 1_000_000), 1_060_000).get(10)).toBeCloseTo(30)
    // A recycled pid started later than the old process: all of its CPU is new.
    const recycled = parsePsOutput(
      psOutput([
        {
          pid: 10,
          ppid: 1,
          time: '0:02.00',
          etime: '00:05',
          lstart: 'Wed Oct 21 10:46:58 2026',
          args: 'x'
        }
      ])
    )
    expect(cpuDeltas(recycled, makeCpuSample(before, 1_000_000), 1_060_000).get(10)).toBeCloseTo(2)
  })

  it('compares start times exactly on macOS and with a clock-step tolerance elsewhere', () => {
    const later = 'Wed Oct 21 00:46:04 2026'
    expect(sameStartedAt(LSTART, LSTART, 'darwin')).toBe(true)
    expect(sameStartedAt(LSTART, later, 'darwin')).toBe(false)
    expect(sameStartedAt(LSTART, later, 'linux')).toBe(true)
    expect(sameStartedAt(LSTART, 'Wed Oct 21 00:46:09 2026', 'linux')).toBe(false)
  })
})

describe('session detection', () => {
  it('maps tracked PTYs to their whole subtree and finds topmost untracked hook processes', () => {
    const processes = parsePsOutput(
      psOutput(
        baseTree([
          // Tracked: custom provider, the agent is a grandchild under a wrapper shell.
          { pid: 600, ppid: APP, args: '/bin/zsh -ilc claude' },
          { pid: 601, ppid: 600, pgid: 600, args: claudeArgs(UUID_A) },
          { pid: 602, ppid: 601, pgid: 600, args: 'node mcp-server.js' },
          // Untracked inside the app tree; its child repeats the hook URL (not topmost).
          { pid: 700, ppid: APP, args: codexArgs(UUID_B) },
          { pid: 701, ppid: 700, pgid: 700, args: `curl http://127.0.0.1/codex-hook/${UUID_B}/x/` },
          // Orphan reparented to init.
          { pid: 800, ppid: 1, args: claudeArgs(UUID_C) },
          // Someone else's claude outside the app tree, not orphaned: ignored.
          { pid: 900, ppid: 899, args: claudeArgs(UUID_C) },
          // Non-agent PTY in the registry.
          { pid: 950, ppid: APP, args: '/bin/zsh' }
        ])
      )
    )
    const children = buildChildrenIndex(processes)
    const sessions = detectSessions({
      processes,
      children,
      appTree: collectSubtree(APP, children),
      ptys: [pty(UUID_A, 600), pty('shell-tab', 950)],
      isAgentCliTerminal: (id) => id === UUID_A
    })
    expect(
      sessions.map((s) => ({
        id: s.sessionId,
        root: s.rootPid,
        tracked: s.tracked,
        agent: s.argvAgent,
        pids: [...s.pids].sort()
      }))
    ).toEqual([
      { id: UUID_A, root: 600, tracked: true, agent: null, pids: [600, 601, 602] },
      { id: UUID_B, root: 700, tracked: false, agent: 'codex', pids: [700, 701] },
      { id: UUID_C, root: 800, tracked: false, agent: 'claude', pids: [800] }
    ])
  })

  it('finds orphans adopted by a subreaper above the app, not those of another app instance', () => {
    const processes = parsePsOutput(
      psOutput([
        { pid: 1, ppid: 0, args: '/sbin/init' },
        { pid: 300, ppid: 1, args: '/usr/lib/systemd/systemd --user' },
        { pid: APP, ppid: 300, args: '/opt/Hive/hive' },
        // Our leaked agent, adopted by the user manager (Linux child subreaper).
        { pid: 820, ppid: 300, args: claudeArgs(UUID_C) },
        // Another Hive instance's live agent: same hook URL shape, not ours.
        { pid: 400, ppid: 300, args: '/opt/Other/hive' },
        { pid: 830, ppid: 400, args: claudeArgs(UUID_B) }
      ])
    )
    const children = buildChildrenIndex(processes)
    expect([...orphanParentsOf(APP, processes, 'linux')].sort()).toEqual([1, 300])
    const sessions = detectSessions({
      processes,
      children,
      appTree: collectSubtree(APP, children),
      ptys: [],
      isAgentCliTerminal: () => true,
      orphanParents: orphanParentsOf(APP, processes, 'linux')
    })
    expect(sessions.map((row) => [row.sessionId, row.rootPid])).toEqual([[UUID_C, 820]])
  })

  it("never reads another instance's live agents as orphans when that instance is above the app", () => {
    // A dev build launched from a session of the installed app: the installed main is an
    // ancestor of ours, and its agents are its direct children.
    const processes = parsePsOutput(
      psOutput([
        { pid: 1, ppid: 0, args: '/sbin/launchd' },
        { pid: 400, ppid: 1, args: '/Applications/Hive.app/Contents/MacOS/Hive' },
        { pid: 830, ppid: 400, args: claudeArgs(UUID_B) },
        { pid: 840, ppid: 830, args: '/bin/zsh -c pnpm exec electron .' },
        { pid: APP, ppid: 840, args: 'Electron .' },
        // A genuine orphan adopted by launchd still counts.
        { pid: 850, ppid: 1, args: claudeArgs(UUID_C) }
      ])
    )
    const children = buildChildrenIndex(processes)
    for (const platform of ['darwin', 'linux'] as const) {
      expect([...orphanParentsOf(APP, processes, platform)]).toEqual([1])
      const sessions = detectSessions({
        processes,
        children,
        appTree: collectSubtree(APP, children),
        ptys: [],
        isAgentCliTerminal: () => true,
        orphanParents: orphanParentsOf(APP, processes, platform)
      })
      expect(sessions.map((row) => [row.sessionId, row.rootPid])).toEqual([[UUID_C, 850]])
    }
  })

  it('lists what is left of a just-stopped session under it as stopping', () => {
    const processes = parsePsOutput(
      psOutput(
        baseTree([
          // The exiting agent, already out of the registry.
          { pid: 600, ppid: APP, args: claudeArgs(UUID_A) },
          // Its dev server (own group, no hook URL), adopted by init when its shell died.
          { pid: 610, ppid: 1, pgid: 610, args: 'node next dev' },
          { pid: 611, ppid: 610, pgid: 610, args: 'next-server' },
          // An unrelated init child with the same shape stays out.
          { pid: 620, ppid: 1, pgid: 620, args: 'node next dev' }
        ])
      )
    )
    const children = buildChildrenIndex(processes)
    const key = (pid: number): string => `${pid}:${LSTART}`
    const sessions = detectSessions({
      processes,
      children,
      appTree: collectSubtree(APP, children),
      ptys: [],
      isAgentCliTerminal: () => true,
      stopping: new Map([
        [key(600), UUID_A],
        [key(610), UUID_A],
        [key(611), UUID_A]
      ])
    })
    expect(
      sessions.map((row) => ({
        id: row.sessionId,
        root: row.rootPid,
        stopping: row.stopping,
        tracked: row.tracked,
        pids: [...row.pids].sort()
      }))
    ).toEqual([{ id: UUID_A, root: 600, stopping: true, tracked: false, pids: [600, 610, 611] }])
  })

  it('skips registry entries whose process is gone', () => {
    const processes = parsePsOutput(psOutput(baseTree()))
    const children = buildChildrenIndex(processes)
    expect(
      detectSessions({
        processes,
        children,
        appTree: collectSubtree(APP, children),
        ptys: [pty(UUID_A, 4242)],
        isAgentCliTerminal: () => true
      })
    ).toEqual([])
  })
})

describe('irrelevance rules', () => {
  const base = {
    tracked: true,
    dbRow: dbRow(UUID_A),
    liveStatus: 'completed',
    backgroundWork: 0,
    paused: false,
    stopping: false,
    idleSeconds: 60,
    idleThresholdSeconds: SESSION_PROFILER_IDLE_THRESHOLD_SECONDS
  }

  it('leaves a healthy session alone', () => {
    expect(deriveIrrelevantReasons(base)).toEqual([])
  })

  it('orders every applicable reason most significant first', () => {
    expect(
      deriveIrrelevantReasons({
        ...base,
        tracked: false,
        dbRow: dbRow(UUID_A, {
          status: 'completed',
          worktreeArchived: true,
          ticket: { id: 't', title: 'T', column: 'review', archived: true, projectId: 'p' }
        }),
        idleSeconds: 3 * 3600
      })
    ).toEqual(['session_completed', 'worktree_archived', 'ticket_done', 'untracked', 'idle'])
  })

  it('flags a missing row and a done ticket', () => {
    expect(
      deriveIrrelevantReasons({
        ...base,
        dbRow: dbRow(UUID_A, { sessionExists: false, status: null })
      })
    ).toEqual(['no_session_row'])
    expect(
      deriveIrrelevantReasons({
        ...base,
        dbRow: dbRow(UUID_A, {
          ticket: { id: 't', title: 'T', column: 'done', archived: false, projectId: 'p' }
        })
      })
    ).toEqual(['ticket_done'])
    expect(deriveIrrelevantReasons({ ...base, dbRow: dbRow(UUID_A, { status: 'error' }) })).toEqual(
      ['session_completed']
    )
  })

  it('counts idle only past the threshold and without background work', () => {
    const idle = SESSION_PROFILER_IDLE_THRESHOLD_SECONDS
    expect(deriveIrrelevantReasons({ ...base, idleSeconds: idle - 1 })).toEqual([])
    expect(deriveIrrelevantReasons({ ...base, idleSeconds: idle })).toEqual(['idle'])
    expect(deriveIrrelevantReasons({ ...base, idleSeconds: idle, backgroundWork: 2 })).toEqual([])
    expect(deriveIrrelevantReasons({ ...base, idleSeconds: null })).toEqual([])
  })

  it('never calls a paused session idle, but still reports what else is stale about it', () => {
    const idle = SESSION_PROFILER_IDLE_THRESHOLD_SECONDS * 4
    expect(deriveIrrelevantReasons({ ...base, idleSeconds: idle, paused: true })).toEqual([])
    expect(
      deriveIrrelevantReasons({
        ...base,
        idleSeconds: idle,
        paused: true,
        dbRow: dbRow(UUID_A, { worktreeArchived: true })
      })
    ).toEqual(['worktree_archived'])
  })

  it('offers nothing for a session that is being stopped', () => {
    expect(
      deriveIrrelevantReasons({
        ...base,
        tracked: false,
        stopping: true,
        dbRow: dbRow(UUID_A, { status: 'completed' }),
        idleSeconds: 99_999
      })
    ).toEqual([])
  })

  it('never flags a busy session or one a document run still needs', () => {
    const stale = {
      ...base,
      dbRow: dbRow(UUID_A, { status: 'completed', worktreeArchived: true }),
      idleSeconds: 99_999
    }
    for (const liveStatus of [
      'working',
      'planning',
      'answering',
      'permission',
      'command_approval',
      'plan_ready'
    ]) {
      expect(deriveIrrelevantReasons({ ...stale, liveStatus })).toEqual([])
    }
    expect(
      deriveIrrelevantReasons({ ...stale, dbRow: { ...stale.dbRow, documentRunBusy: true } })
    ).toEqual([])
  })

  it('infers nothing from the DB when it could not be read', () => {
    expect(deriveIrrelevantReasons({ ...base, dbRow: undefined })).toEqual([])
    expect(deriveIrrelevantReasons({ ...base, tracked: false, dbRow: undefined })).toEqual([
      'untracked'
    ])
  })

  it('names the agent from the DB, falling back to argv', () => {
    expect(agentKindFor('codex-cli', 'claude')).toBe('codex')
    expect(agentKindFor('claude-code-cli', 'codex')).toBe('claude')
    expect(agentKindFor(null, 'codex')).toBe('codex')
    expect(agentKindFor(null, null)).toBe('other')
  })
})

describe('snapshot', () => {
  const tree = (agentTime: string, appTime = '1:00.00'): string =>
    psOutput([
      { pid: 1, ppid: 0, args: '/sbin/launchd' },
      { pid: APP, ppid: 1, rssKb: 200_000, time: appTime, args: 'Hive' },
      { pid: SERVER, ppid: APP, rssKb: 100_000, time: '0:30.00', args: 'server.js' },
      {
        pid: 600,
        ppid: APP,
        rssKb: 500_000,
        time: agentTime,
        tty: '16/5',
        args: claudeArgs(UUID_A)
      },
      { pid: 601, ppid: 600, pgid: 600, rssKb: 50_000, time: '0:01.00', args: 'node mcp.js' },
      { pid: 800, ppid: 1, rssKb: 300_000, time: '0:10.00', tty: '16/9', args: codexArgs(UUID_B) },
      { pid: 999, ppid: 1, rssKb: 1, args: 'unrelated' }
    ])

  it('primes, then reports sessions, enrichment and totals', async () => {
    const { deps, runPs, clock } = makeDeps({
      psOutputs: [tree('0:10.00'), tree('0:11.50', '1:00.30')],
      listPtys: () => [
        pty(UUID_A, 600, {
          lastOutputAt: 1_000_000 - 40 * 60_000,
          lastInputAt: 1_000_000 - 50 * 60_000
        })
      ],
      isAgentCliTerminal: (id) => id === UUID_A,
      getDbRows: (ids) =>
        ids.map((id) =>
          id === UUID_A
            ? dbRow(id, {
                ticket: {
                  id: 't1',
                  title: 'Fix it',
                  column: 'review',
                  archived: false,
                  projectId: 'p'
                }
              })
            : dbRow(id, { sessionExists: false, name: null, status: null, agentSdk: null })
        ),
      getLiveStatus: () => 'completed',
      statTty: vi.fn(async (path: string) =>
        path === '/dev/ttys009' ? { atimeMs: 0, mtimeMs: 1_000_000, rdev: 0x10000009 } : null
      )
    })
    const snapshot = await createSessionProfiler(deps).getSnapshot()

    expect(runPs).toHaveBeenCalledTimes(2)
    expect(snapshot.supported).toBe(true)
    expect(snapshot.cpuWindowMs).toBe(1500)
    expect(snapshot.sampledAt).toBe(clock.now)
    const [tracked, untracked] = snapshot.sessions
    expect(tracked).toMatchObject({
      sessionId: UUID_A,
      pid: 600,
      startedAt: LSTART,
      agent: 'claude',
      tracked: true,
      liveStatus: 'completed',
      dbStatus: 'active',
      ticket: { title: 'Fix it', column: 'review' },
      cwd: `/wt/${UUID_A}`,
      processCount: 2,
      rssBytes: 550_000 * 1024,
      cpuPercent: 100,
      cpuSeconds: 12.5,
      idleSeconds: 40 * 60 + 1,
      irrelevantReasons: ['idle']
    })
    expect(untracked).toMatchObject({
      sessionId: UUID_B,
      pid: 800,
      agent: 'codex',
      tracked: false,
      liveStatus: null,
      dbStatus: null,
      cwd: null,
      cpuPercent: 0,
      idleSeconds: 1,
      irrelevantReasons: ['no_session_row', 'untracked']
    })
    expect(snapshot.totals).toEqual({
      // The app tree plus the leaked codex adopted by init: agents stay a subset of the totals.
      processCount: 5,
      // app 0.3 s + agent 1.5 s over 1.5 s
      cpuPercent: 120,
      agentCpuPercent: 100,
      rssBytes: (200_000 + 100_000 + 500_000 + 50_000 + 300_000) * 1024,
      agentRssBytes: (500_000 + 50_000 + 300_000) * 1024,
      cpuCount: 8
    })
  })

  it('serves the cache for 3 s, shares the in-flight sample, then diffs against the last one', async () => {
    const { deps, runPs, clock } = makeDeps({
      psOutputs: [tree('0:10.00'), tree('0:10.00'), tree('0:40.00')]
    })
    const profiler = createSessionProfiler(deps)
    const [first, second] = await Promise.all([profiler.getSnapshot(), profiler.getSnapshot()])
    expect(second).toBe(first)
    expect(runPs).toHaveBeenCalledTimes(2)

    clock.now += 2_000
    expect(await profiler.getSnapshot()).toBe(first)
    expect(runPs).toHaveBeenCalledTimes(2)

    clock.now += 58_000
    const later = await profiler.getSnapshot()
    expect(runPs).toHaveBeenCalledTimes(3)
    expect(later.cpuWindowMs).toBe(60_000)
    // 30 s of agent CPU over 60 s.
    expect(later.sessions.find((s) => s.pid === 600)?.cpuPercent).toBe(50)
  })

  it('re-primes when the previous sample is older than 5 minutes', async () => {
    const { deps, runPs, clock } = makeDeps()
    const profiler = createSessionProfiler(deps)
    await profiler.getSnapshot()
    clock.now += 6 * 60_000
    const snapshot = await profiler.getSnapshot()
    expect(runPs).toHaveBeenCalledTimes(4)
    expect(snapshot.cpuWindowMs).toBe(1500)
  })

  it('reports a failed sample without caching it', async () => {
    const { deps } = makeDeps()
    const runPs = vi.fn(deps.runPs).mockRejectedValueOnce(new Error('ps timed out'))
    const profiler = createSessionProfiler({ ...deps, runPs })
    const failed = await profiler.getSnapshot()
    expect(failed).toMatchObject({ supported: true, sessions: [], error: 'ps timed out' })
    const ok = await profiler.getSnapshot()
    expect(ok.error).toBeUndefined()
  })

  it('keeps DB-based reasons out when enrichment fails', async () => {
    const { deps } = makeDeps({
      psOutputs: [tree('0:10.00')],
      listPtys: () => [pty(UUID_A, 600, { lastOutputAt: 999_000, lastInputAt: 999_000 })],
      getDbRows: () => {
        throw new Error('db locked')
      }
    })
    const snapshot = await createSessionProfiler(deps).getSnapshot()
    expect(snapshot.sessions.find((s) => s.pid === 600)?.irrelevantReasons).toEqual([])
    expect(snapshot.sessions.find((s) => s.pid === 800)?.irrelevantReasons).toEqual(['untracked'])
  })

  it('reports a paused session and never calls it idle', async () => {
    const { deps } = makeDeps({
      psOutputs: [tree('0:10.00')],
      listPtys: () => [pty(UUID_A, 600, { lastOutputAt: 0, lastInputAt: 0 })],
      isAgentCliTerminal: (id) => id === UUID_A,
      getLiveStatus: () => 'completed',
      isPaused: (id) => id === UUID_A
    })
    const row = (await createSessionProfiler(deps).getSnapshot()).sessions.find(
      (session) => session.sessionId === UUID_A
    )
    expect(row).toMatchObject({ paused: true, stopping: false, irrelevantReasons: [] })
  })

  it('is unsupported on Windows and never runs ps there', async () => {
    const { deps, runPs } = makeDeps({ platform: 'win32' })
    const profiler = createSessionProfiler(deps)
    expect(await profiler.getSnapshot()).toMatchObject({ supported: false, sessions: [] })
    expect(await profiler.kill({ sessionId: UUID_A })).toEqual({ ok: false, error: 'unsupported' })
    expect(runPs).not.toHaveBeenCalled()
  })
})

describe('kill', () => {
  const killTree = (extra: Proc[] = []): string =>
    psOutput(
      baseTree([
        { pid: 600, ppid: APP, args: claudeArgs(UUID_A) },
        { pid: 700, ppid: APP, args: claudeArgs(UUID_B) },
        { pid: 800, ppid: 1, args: codexArgs(UUID_C) },
        { pid: 900, ppid: 899, args: claudeArgs(UUID_C) },
        { pid: 901, ppid: APP, args: claudeArgs(UUID_C) },
        { pid: 902, ppid: APP, args: '/bin/zsh' },
        ...extra
      ])
    )

  /** A process table that `kill(pid, 0)` answers from; signals to a dead pid throw ESRCH. */
  const liveTable = (pids: number[], groups: Record<number, number[]> = {}) => {
    const alive = new Set(pids)
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (!alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        alive.delete(pid)
        if (pid < 0) for (const member of [-pid, ...(groups[-pid] ?? [])]) alive.delete(member)
      }
    })
    return { alive, kill }
  }

  it('reaps a tracked session through the PTY registry and invalidates the cache', async () => {
    const { alive, kill } = liveTable([600])
    const reapCliTerminal = vi.fn(() => {
      alive.delete(600)
      return true
    })
    const { deps, runPs } = makeDeps({
      psOutputs: [killTree()],
      listPtys: () => [pty(UUID_A, 600)],
      reapCliTerminal,
      kill
    })
    const profiler = createSessionProfiler(deps)
    await profiler.getSnapshot()
    expect(runPs).toHaveBeenCalledTimes(2)

    expect(await profiler.kill({ sessionId: UUID_A, pid: 600, startedAt: LSTART })).toEqual({
      ok: true,
      method: 'pty'
    })
    expect(reapCliTerminal).toHaveBeenCalledWith(UUID_A)
    // One pre-stop sample; nothing survived, so no sweep sample and no signal.
    expect(runPs).toHaveBeenCalledTimes(3)
    expect(kill).not.toHaveBeenCalledWith(expect.anything(), 'SIGTERM')
    await profiler.getSnapshot()
    expect(runPs).toHaveBeenCalledTimes(4)
  })

  it('never reaps another session whose PTY now has the requested pid', async () => {
    const reapCliTerminal = vi.fn(() => true)
    const kill = vi.fn()
    const { deps } = makeDeps({
      psOutputs: [killTree()],
      // Session A's row is stale: A has no PTY any more and B's new PTY got pid 700.
      listPtys: () => [pty(UUID_B, 700)],
      reapCliTerminal,
      kill
    })
    const result = await createSessionProfiler(deps).kill({
      sessionId: UUID_A,
      pid: 700,
      startedAt: LSTART
    })
    expect(result.ok).toBe(false)
    expect(reapCliTerminal).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('reaps a PTY by pid alone only when the start time still matches', async () => {
    const reapCliTerminal = vi.fn(() => true)
    const { deps } = makeDeps({
      psOutputs: [killTree()],
      listPtys: () => [pty(UUID_A, 600)],
      reapCliTerminal,
      kill: liveTable([]).kill
    })
    const profiler = createSessionProfiler(deps)
    expect(await profiler.kill({ pid: 600, startedAt: 'Thu Oct 22 10:00:00 2026' })).toMatchObject({
      ok: false
    })
    expect(await profiler.kill({ pid: 600 })).toMatchObject({ ok: false })
    expect(reapCliTerminal).not.toHaveBeenCalled()
    expect(await profiler.kill({ pid: 600, startedAt: LSTART })).toEqual({
      ok: true,
      method: 'pty'
    })
    expect(reapCliTerminal).toHaveBeenCalledWith(UUID_A)
  })

  it('refuses to reap a tracked session whose process changed since the sample', async () => {
    const reapCliTerminal = vi.fn(() => true)
    const { deps } = makeDeps({
      psOutputs: [killTree()],
      listPtys: () => [pty(UUID_A, 600)],
      reapCliTerminal
    })
    expect(
      await createSessionProfiler(deps).kill({
        sessionId: UUID_A,
        pid: 600,
        startedAt: 'Thu Oct 22 10:00:00 2026'
      })
    ).toMatchObject({ ok: false })
    expect(reapCliTerminal).not.toHaveBeenCalled()
  })

  it('after a tracked stop, stops the process groups the agent left behind', async () => {
    const before = killTree([
      // A Bash-tool shell that setsid'd, running a dev server: their own group.
      { pid: 610, ppid: 600, pgid: 610, args: '/bin/zsh -c pnpm dev' },
      { pid: 611, ppid: 610, pgid: 610, args: 'next-server' },
      // Same-group tool child: the PTY's own group kill covers it, but it is checked too.
      { pid: 612, ppid: 600, pgid: 600, args: 'node mcp.js' }
    ])
    const after = killTree([
      { pid: 610, ppid: 1, pgid: 610, args: '/bin/zsh -c pnpm dev' },
      { pid: 611, ppid: 610, pgid: 610, args: 'next-server' }
    ])
    const { alive, kill } = liveTable([600, 610, -610, 611], { 610: [611] })
    const { deps } = makeDeps({
      psOutputs: [before, after],
      listPtys: () => [pty(UUID_A, 600)],
      reapCliTerminal: () => {
        alive.delete(600)
        return true
      },
      kill
    })
    expect(
      await createSessionProfiler(deps).kill({ sessionId: UUID_A, pid: 600, startedAt: LSTART })
    ).toEqual({
      ok: true,
      method: 'pty'
    })
    expect(kill).toHaveBeenCalledWith(-610, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(611, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(expect.anything(), 'SIGKILL')
    expect(kill).not.toHaveBeenCalledWith(-600, expect.anything())
  })

  it('escalates the sweep to SIGKILL and never signals a recycled pid', async () => {
    const before = killTree([
      { pid: 610, ppid: 600, pgid: 610, args: 'next-server' },
      { pid: 620, ppid: 600, pgid: 620, args: 'vite' }
    ])
    const after = killTree([
      { pid: 610, ppid: 1, pgid: 610, args: 'next-server' },
      // 620 exited and the pid now belongs to something else.
      { pid: 620, ppid: 1, pgid: 620, lstart: 'Thu Oct 22 10:00:00 2026', args: 'unrelated' }
    ])
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (pid === 600 && signal === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    const { deps, clock } = makeDeps({
      psOutputs: [before, after],
      listPtys: () => [pty(UUID_A, 600)],
      kill
    })
    const start = clock.now
    await createSessionProfiler(deps).kill({ sessionId: UUID_A, pid: 600, startedAt: LSTART })
    expect(kill).toHaveBeenCalledWith(-610, 'SIGTERM')
    expect(kill).toHaveBeenLastCalledWith(-610, 'SIGKILL')
    expect(kill).not.toHaveBeenCalledWith(-620, expect.anything())
    expect(kill).not.toHaveBeenCalledWith(620, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(620, 'SIGKILL')
    expect(clock.now - start).toBeGreaterThanOrEqual(3_000)
  })

  it('shows a still-exiting stopped session as stopping, not as an untracked leftover', async () => {
    let ptys = [pty(UUID_A, 600)]
    const exiting = killTree([{ pid: 610, ppid: 1, pgid: 610, args: 'next-server' }])
    const before = killTree([{ pid: 610, ppid: 600, pgid: 610, args: 'next-server' }])
    // kill(0) says gone (the waits end at once), but ps still lists them for a moment.
    const { deps, clock } = makeDeps({
      psOutputs: [before, exiting],
      listPtys: () => ptys,
      reapCliTerminal: () => {
        ptys = []
        return true
      },
      kill: liveTable([]).kill,
      getDbRows: (ids) => ids.map((id) => dbRow(id, { status: 'completed' }))
    })
    const profiler = createSessionProfiler(deps)
    await profiler.kill({ sessionId: UUID_A, pid: 600, startedAt: LSTART })

    const rowA = (await profiler.getSnapshot()).sessions.find((row) => row.sessionId === UUID_A)
    expect(rowA).toMatchObject({
      pid: 600,
      tracked: false,
      stopping: true,
      processCount: 2,
      irrelevantReasons: []
    })

    // Still there long after: no longer "stopping" — a real leftover again.
    clock.now += 60_000
    const later = (await profiler.getSnapshot()).sessions.find((row) => row.sessionId === UUID_A)
    expect(later).toMatchObject({
      stopping: false,
      irrelevantReasons: ['session_completed', 'untracked']
    })
  })

  it('stops an orphan adopted by a subreaper above the app (Linux)', async () => {
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    const { deps } = makeDeps({
      platform: 'linux',
      appParentPid: 300,
      psOutputs: [
        psOutput([
          { pid: 1, ppid: 0, args: '/sbin/init' },
          { pid: 300, ppid: 1, args: '/usr/lib/systemd/systemd --user' },
          { pid: APP, ppid: 300, args: 'hive' },
          { pid: 820, ppid: 300, args: claudeArgs(UUID_C) },
          { pid: 400, ppid: 300, args: 'other-instance' },
          { pid: 830, ppid: 400, args: claudeArgs(UUID_B) }
        ])
      ],
      kill
    })
    const profiler = createSessionProfiler(deps)
    expect(await profiler.kill({ pid: 820, startedAt: LSTART })).toEqual({
      ok: true,
      method: 'signal'
    })
    expect(kill).toHaveBeenCalledWith(-820, 'SIGTERM')
    expect(await profiler.kill({ pid: 830, startedAt: LSTART })).toMatchObject({ ok: false })
    expect(kill).not.toHaveBeenCalledWith(-830, expect.anything())
  })

  it('refuses to reap a registry PTY that is not an agent CLI', async () => {
    const reapCliTerminal = vi.fn(() => true)
    const { deps } = makeDeps({
      listPtys: () => [pty('shell', 902)],
      isAgentCliTerminal: () => false,
      reapCliTerminal
    })
    expect(await createSessionProfiler(deps).kill({ sessionId: 'shell' })).toMatchObject({
      ok: false
    })
    expect(reapCliTerminal).not.toHaveBeenCalled()
  })

  it('signals the process group of a verified untracked process and waits for it', async () => {
    const alive = new Set([700, -700])
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGTERM') {
        // dies after the first poll
        setTimeout(() => {
          alive.delete(700)
          alive.delete(-700)
        }, 0)
        return
      }
      if (!alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    const { deps } = makeDeps({
      psOutputs: [killTree()],
      kill,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 0))
    })
    const result = await createSessionProfiler(deps).kill({
      sessionId: UUID_B,
      pid: 700,
      startedAt: LSTART
    })
    expect(result).toEqual({ ok: true, method: 'signal' })
    expect(kill).toHaveBeenCalledWith(-700, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(expect.anything(), 'SIGKILL')
  })

  it('escalates to SIGKILL after the grace period', async () => {
    const kill = vi.fn()
    const { deps, clock } = makeDeps({ psOutputs: [killTree()], kill })
    const result = await createSessionProfiler(deps).kill({ pid: 800, startedAt: LSTART })
    expect(result).toEqual({ ok: true, method: 'signal' })
    expect(kill).toHaveBeenCalledWith(-800, 'SIGTERM')
    expect(kill).toHaveBeenLastCalledWith(-800, 'SIGKILL')
    expect(clock.now).toBeGreaterThanOrEqual(1_000_000 + 3_000)
  })

  it('treats an already-gone process as stopped', async () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    const { deps } = makeDeps({ psOutputs: [killTree()], kill })
    expect(await createSessionProfiler(deps).kill({ pid: 800, startedAt: LSTART })).toEqual({
      ok: true,
      method: 'signal'
    })
  })

  it.each([
    ['pid 1', { pid: 1, startedAt: LSTART }],
    ['the app itself', { pid: APP, startedAt: LSTART }],
    ['a protected pid (server child)', { pid: SERVER, startedAt: LSTART }],
    ['a missing start time', { pid: 700 }],
    ['a pid reused by another process', { pid: 700, startedAt: 'Thu Oct 22 10:00:00 2026' }],
    ['a process without a hook url', { pid: 902, startedAt: LSTART }],
    ['a different session uuid', { pid: 700, sessionId: UUID_A, startedAt: LSTART }],
    ['a process outside the app tree', { pid: 900, startedAt: LSTART }],
    ['a group holding a protected pid', { pid: 901, startedAt: LSTART }],
    ['no target at all', {}]
  ])('refuses %s', async (_label, req) => {
    const kill = vi.fn()
    const { deps } = makeDeps({
      psOutputs: [killTree([{ pid: 950, ppid: 901, pgid: 901, args: 'x' }])],
      kill
    })
    const result = await createSessionProfiler(deps).kill(req, { protectedPids: [SERVER, 950] })
    expect(result.ok).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })

  it('signals a leaked earlier process of a tracked session by pid, not the live PTY', async () => {
    const reapCliTerminal = vi.fn(() => true)
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    const { deps } = makeDeps({
      psOutputs: [killTree([{ pid: 810, ppid: 1, args: claudeArgs(UUID_A) }])],
      listPtys: () => [pty(UUID_A, 600)],
      reapCliTerminal,
      kill
    })
    const result = await createSessionProfiler(deps).kill({
      sessionId: UUID_A,
      pid: 810,
      startedAt: LSTART
    })
    expect(result).toEqual({ ok: true, method: 'signal' })
    expect(reapCliTerminal).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith(-810, 'SIGTERM')
  })
})
