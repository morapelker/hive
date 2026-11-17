/**
 * What holds a project back from being moved (`takeBusyReading`), one source at a time, with
 * every source injected. The last suite asks the real `ps` about a real terminal.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree } from '../../../db/types'
import {
  memberProjectIdsOf,
  parseForegroundBusyPids,
  readForegroundBusyPids,
  takeBusyReading,
  type BusyAgentSession,
  type BusyAgentSnapshot,
  type BusyConnection,
  type BusyDocumentRun,
  type BusyProject,
  type BusySession,
  type BusySources
} from '../busy-probe'
import { canonicalFolderPath } from '../folder-identity'
import type { BusyProbeOptions } from '../types'

const project = (id: string, extra: Partial<Project> = {}): Project =>
  ({ id, name: id, path: `/old/${id}`, kind: 'git', ...extra }) as Project

const worktree = (id: string, projectId: string, name = id): Worktree =>
  ({ id, project_id: projectId, name, path: `/old/${projectId}`, status: 'active' }) as Worktree

const P = project('p')
const OTHER = project('other')
const P_WORKTREES = [worktree('w-main', 'p', 'main'), worktree('w-feature', 'p', 'feature')]
const P_PATHS = ['/old/p']

const NO_AGENTS: BusyAgentSnapshot = { supported: true, sessions: [] }

const agent = (extra: Partial<BusyAgentSession>): BusyAgentSession => ({
  cwd: null,
  worktreePath: null,
  name: 'Fix login',
  agent: 'claude',
  stopping: false,
  tracked: true,
  pid: 4242,
  ...extra
})

/** What the desktop app answers on Windows, where it cannot sample processes. */
const WINDOWS_SNAPSHOT = {
  supported: false,
  sampledAt: 1_700_000_000_000,
  cpuWindowMs: null,
  idleThresholdSeconds: 600,
  sessions: [],
  totals: { processCount: 0 }
} as BusyAgentSnapshot

const COPIES: BusyProbeOptions = { copies: true }

interface World {
  running: string[]
  sessions: Record<string, BusySession>
  connections: Record<string, BusyConnection>
  projects: Record<string, BusyProject>
  runs: BusyDocumentRun[]
  shellSessions: BusySession[]
  /** Ids of the sessions with a command running that was typed with `!` into them. */
  bashSessions: string[]
  scripts: string[]
  snapshot: BusyAgentSnapshot
  terminals: { pid: number; cwd: string }[]
  foreground: number[] | null
  realPaths: Record<string, string>
}

/** Sources over a small world in which nothing is running until a test says so. */
const makeSources = (
  world: Partial<World> = {},
  overrides: Partial<BusySources> = {}
): BusySources => {
  const state: World = {
    running: [],
    sessions: {},
    connections: {},
    projects: {},
    runs: [],
    shellSessions: [],
    bashSessions: [],
    scripts: [],
    snapshot: NO_AGENTS,
    terminals: [],
    foreground: [],
    realPaths: {},
    ...world
  }
  return {
    runningSessionIds: () => state.running,
    getSession: (id) => state.sessions[id] ?? null,
    getConnection: (id) => state.connections[id] ?? null,
    getProject: (id) => state.projects[id] ?? null,
    activeDocumentRuns: () => state.runs,
    activeShellSessions: () => state.shellSessions,
    runningBashSessionIds: async () => state.bashSessions,
    isScriptRunning: (eventKey) => state.scripts.includes(eventKey),
    agentCliSnapshot: async () => state.snapshot,
    terminals: () => state.terminals,
    foregroundBusyPids: async () => (state.foreground === null ? null : new Set(state.foreground)),
    hasDesktopParent: true,
    canonical: (path) => state.realPaths[path] ?? path,
    ...overrides
  }
}

const reasonFor = async (
  sources: BusySources,
  target: Project = P,
  worktrees: readonly Worktree[] = P_WORKTREES,
  movingPaths: readonly string[] = P_PATHS,
  options?: BusyProbeOptions
): Promise<string | null> =>
  (await takeBusyReading(sources))(target, worktrees, movingPaths, options)

const session = (extra: Partial<BusySession> = {}): BusySession => ({
  project_id: 'p',
  connection_id: null,
  name: 'Fix login',
  ...extra
})

const run = (extra: Partial<BusyDocumentRun> = {}): BusyDocumentRun => ({
  project_id: 'p',
  title: 'Checkout',
  status: 'running',
  members: null,
  ...extra
})

const member = (projectId: string): NonNullable<BusyDocumentRun['members']>[number] =>
  ({ project_id: projectId }) as NonNullable<BusyDocumentRun['members']>[number]

describe('takeBusyReading', () => {
  it('lets a project through when nothing is running', async () => {
    expect(await reasonFor(makeSources())).toBeNull()
  })

  describe('sessions the window reports as working or waiting', () => {
    it('holds the project of a running session, and names the session and the remedy', async () => {
      const sources = makeSources({ running: ['s1'], sessions: { s1: session() } })

      expect(await reasonFor(sources)).toBe(
        'The session "Fix login" is working or waiting for an answer in this project. Wait for it to finish or stop it, then check again.'
      )
      expect(await reasonFor(sources, OTHER, [], ['/old/other'])).toBeNull()
    })

    it('speaks of "a session" when the session has no name', async () => {
      const sources = makeSources({ running: ['s1'], sessions: { s1: session({ name: null }) } })

      expect(await reasonFor(sources)).toBe(
        'A session is working or waiting for an answer in this project. Wait for it to finish or stop it, then check again.'
      )
    })

    it('ignores a session that is not reported as running, and one the database does not know', async () => {
      const sources = makeSources({ running: ['ghost'], sessions: { s1: session() } })

      expect(await reasonFor(sources)).toBeNull()
    })

    it('holds every member of the connection a running session works in', async () => {
      // An ad-hoc connection is listed under its first member's project.
      const sources = makeSources({
        running: ['s1'],
        sessions: { s1: session({ project_id: 'other', connection_id: 'c1' }) },
        connections: { c1: { members: [{ project_id: 'other' }, { project_id: 'p' }] } }
      })

      expect(await reasonFor(sources)).toBe(
        'The session "Fix login" is working or waiting for an answer in a connection that includes this project. Wait for it to finish or stop it, then check again.'
      )
      expect(await reasonFor(sources, project('third'), [], ['/old/third'])).toBeNull()
    })

    it('holds every member of the connection project a running session belongs to', async () => {
      const sources = makeSources({
        running: ['s1'],
        sessions: { s1: session({ project_id: 'cp' }) },
        projects: { cp: { member_project_ids: JSON.stringify(['other', 'p']) } }
      })

      expect(await reasonFor(sources)).toMatch(
        /in a connection that includes this project\. .*then check again\.$/
      )
    })

    it('follows a connection to the connection project it was saved as', async () => {
      const sources = makeSources({
        running: ['s1'],
        sessions: { s1: session({ project_id: 'other', connection_id: 'c1' }) },
        connections: { c1: { saved_project_id: 'cp', members: [{ project_id: 'other' }] } },
        projects: { cp: { member_project_ids: JSON.stringify(['other', 'p']) } }
      })

      expect(await reasonFor(sources)).toMatch(/connection that includes this project/)
    })

    it('does not hold a project that is in neither the session nor its connection', async () => {
      const sources = makeSources({
        running: ['s1', 's2'],
        sessions: {
          s1: session({ project_id: 'other', connection_id: 'gone' }),
          s2: session({ project_id: 'cp' })
        },
        projects: { cp: { member_project_ids: 'not json' } }
      })

      expect(await reasonFor(sources)).toBeNull()
    })
  })

  describe('document runs', () => {
    it.each([
      [
        'extracting',
        'The orchestrator "Checkout" is still reading its document for this project. Wait for it to finish or cancel it, then check again.'
      ],
      [
        'running',
        'The orchestrator "Checkout" is running in this project. Wait for it to finish or cancel it, then check again.'
      ],
      [
        'paused',
        'The orchestrator "Checkout" is paused in this project. Finish it or cancel it, then check again.'
      ]
    ] as const)('holds the project of a run that is %s', async (status, sentence) => {
      const sources = makeSources({ runs: [run({ status })] })

      expect(await reasonFor(sources)).toBe(sentence)
      expect(await reasonFor(sources, OTHER, [], ['/old/other'])).toBeNull()
    })

    it('holds a project that a run of a connection project names as a member', async () => {
      const sources = makeSources({
        runs: [run({ project_id: 'cp', members: [member('other'), member('p')] })]
      })

      expect(await reasonFor(sources)).toBe(
        'The orchestrator "Checkout" is running in a connection project that includes this project. Wait for it to finish or cancel it, then check again.'
      )
    })

    it('holds the members of a connection project whose run has not named them yet', async () => {
      const sources = makeSources({
        runs: [run({ project_id: 'cp', status: 'extracting' })],
        projects: { cp: { member_project_ids: JSON.stringify(['p']) } }
      })

      expect(await reasonFor(sources)).toMatch(
        /^The orchestrator "Checkout" is still reading its document for a connection project that includes this project\./
      )
    })

    it('says "an orchestrator" when the run has no title', async () => {
      expect(await reasonFor(makeSources({ runs: [run({ title: ' ' })] }))).toMatch(
        /^An orchestrator is running in this project\./
      )
    })
  })

  describe('shell commands', () => {
    it('holds the project of a pending or running command', async () => {
      const sources = makeSources({ shellSessions: [session({ name: 'Deploy' })] })

      expect(await reasonFor(sources)).toBe(
        'The command "Deploy" is running in this project. Wait for it to finish or stop it, then check again.'
      )
      expect(await reasonFor(sources, OTHER, [], ['/old/other'])).toBeNull()
    })

    it('holds the members of the connection a command runs in', async () => {
      const sources = makeSources({
        shellSessions: [session({ project_id: 'other', connection_id: 'c1', name: null })],
        connections: { c1: { members: [{ project_id: 'p' }] } }
      })

      expect(await reasonFor(sources)).toBe(
        'A command is running in a connection that includes this project. Wait for it to finish or stop it, then check again.'
      )
    })
  })

  describe('commands started with ! in a session', () => {
    const HELD =
      'The session "Fix login" is running a command in this project. Wait for the command to finish or stop it in that session, then check again.'
    const NOT_CHECKED = 'Could not check for commands running in sessions'

    it('a command started with ! in a session holds its project back, and the members of its connection', async () => {
      // The window does not report the session as working: only the command says it is.
      const own = makeSources({ bashSessions: ['s1'], sessions: { s1: session() } })

      expect(await reasonFor(own)).toBe(HELD)
      expect(await reasonFor(own, OTHER, [], ['/old/other'])).toBeNull()

      // A connection session runs its commands in the connection's folder, which is in no
      // project: the session says whose folders the command reaches.
      const connected = makeSources({
        bashSessions: ['s1'],
        sessions: { s1: session({ project_id: 'other', connection_id: 'c1', name: null }) },
        connections: { c1: { members: [{ project_id: 'other' }, { project_id: 'p' }] } }
      })

      expect(await reasonFor(connected)).toBe(
        'A session is running a command in a connection that includes this project. Wait for the command to finish or stop it in that session, then check again.'
      )
      expect(await reasonFor(connected, project('third'), [], ['/old/third'])).toBeNull()
    })

    it('holds the members of the connection project the session belongs to', async () => {
      const sources = makeSources({
        bashSessions: ['s1'],
        sessions: { s1: session({ project_id: 'cp' }) },
        projects: { cp: { member_project_ids: JSON.stringify(['other', 'p']) } }
      })

      expect(await reasonFor(sources)).toMatch(
        /^The session "Fix login" is running a command in a connection that includes this project\./
      )
    })

    it('lets the project through at the next reading, once the command is over', async () => {
      const bashSessions = ['s1']
      const sources = makeSources({ bashSessions, sessions: { s1: session() } })

      expect(await reasonFor(sources)).toBe(HELD)
      bashSessions.pop()
      expect(await reasonFor(sources)).toBeNull()
    })

    it('goes on past a command whose session is no longer in the database', async () => {
      const sources = makeSources({
        bashSessions: ['gone', 's1'],
        sessions: { s1: session({ project_id: 'other' }) }
      })

      expect(await reasonFor(sources)).toBeNull()
      expect(await reasonFor(sources, OTHER, [], ['/old/other'])).toBe(HELD)
    })

    it('holds every project when the commands cannot be read, and says so', async () => {
      const log = vi.fn()
      const rejecting = makeSources(
        {},
        { runningBashSessionIds: () => Promise.reject(new Error('the runtime is gone.')), log }
      )
      const throwing = makeSources(
        {},
        {
          runningBashSessionIds: () => {
            throw new Error('not loaded')
          }
        }
      )
      const unreadable = makeSources(
        {},
        { runningBashSessionIds: async () => undefined as unknown as string[] }
      )

      expect(await reasonFor(rejecting)).toBe(`${NOT_CHECKED}: the runtime is gone. Check again.`)
      expect(await reasonFor(rejecting, OTHER, [], ['/old/other'])).toBe(
        `${NOT_CHECKED}: the runtime is gone. Check again.`
      )
      expect(log).toHaveBeenCalledWith(
        'dev folder: could not check for commands running in sessions',
        { error: 'the runtime is gone' }
      )
      expect(await reasonFor(throwing)).toBe(`${NOT_CHECKED}: not loaded. Check again.`)
      expect(await reasonFor(unreadable)).toMatch(
        /^Could not check for commands running in sessions: .+\. Check again\.$/
      )
    })

    it('holds every project when the session of a running command cannot be read', async () => {
      const sources = makeSources(
        { bashSessions: ['s1'] },
        {
          getSession: () => {
            throw new Error('database is locked.')
          }
        }
      )

      expect(await reasonFor(sources)).toBe(`${NOT_CHECKED}: database is locked. Check again.`)
    })

    it('names a command that runs in the project before a check that could not be made', async () => {
      const sources = makeSources({
        bashSessions: ['s1'],
        sessions: { s1: session() },
        snapshot: { supported: true, sessions: [], error: 'boom' }
      })

      expect(await reasonFor(sources)).toBe(HELD)
      expect(await reasonFor(sources, OTHER, [], ['/old/other'])).toMatch(
        /^Could not check for open agent sessions/
      )
    })

    it('asks once per reading, and only after the slow readings have come in', async () => {
      const order: string[] = []
      const runningBashSessionIds = vi.fn(async () => {
        order.push('commands')
        return []
      })
      const sources = makeSources(
        {},
        {
          agentCliSnapshot: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20))
            order.push('agents')
            return NO_AGENTS
          },
          runningBashSessionIds
        }
      )

      const probe = await takeBusyReading(sources)
      for (const id of ['a', 'b', 'c']) probe(project(id), [], [`/old/${id}`])

      // A command started while the list of agents was on its way is still seen.
      expect(order).toEqual(['agents', 'commands'])
      expect(runningBashSessionIds).toHaveBeenCalledTimes(1)
    })
  })

  describe('run and setup scripts', () => {
    it("holds a project while the run script of one of its worktrees is running, by the script's key", async () => {
      const sources = makeSources({ scripts: ['script:run:w-feature'] })

      expect(await reasonFor(sources)).toBe(
        'The run script of this project is running (worktree "feature"). Stop it, then check again.'
      )
    })

    it('holds a project while a setup script is running', async () => {
      const sources = makeSources({ scripts: ['script:setup:w-main'] })

      expect(await reasonFor(sources)).toBe(
        'The setup script of the worktree "main" is still running. Wait for it to finish or stop it, then check again.'
      )
    })

    it('does not hold a project for a script of another worktree', async () => {
      const asked: string[] = []
      const sources = makeSources(
        { scripts: ['script:run:w-elsewhere'] },
        {
          isScriptRunning: (eventKey) => {
            asked.push(eventKey)
            return eventKey === 'script:run:w-elsewhere'
          }
        }
      )

      expect(await reasonFor(sources)).toBeNull()
      expect(asked).toEqual([
        'script:run:w-main',
        'script:setup:w-main',
        'script:run:w-feature',
        'script:setup:w-feature'
      ])
    })
  })

  describe('agent CLIs open in terminals', () => {
    const withAgents = (
      sessions: BusyAgentSession[],
      world: Partial<World> = {},
      overrides: Partial<BusySources> = {}
    ): BusySources => makeSources({ snapshot: { supported: true, sessions }, ...world }, overrides)

    it('holds a project while an agent CLI sits in its folder, idle or not', async () => {
      const sources = withAgents([agent({ cwd: '/old/p' })])

      expect(await reasonFor(sources)).toBe(
        'The Claude Code session "Fix login" has a terminal open in this project, and it would go on working in the old folder. Close its tab, then check again.'
      )
    })

    it('holds a project for an agent CLI in a folder inside it', async () => {
      expect(await reasonFor(withAgents([agent({ cwd: '/old/p/packages/api' })]))).toMatch(
        /Close its tab, then check again\.$/
      )
    })

    it('does not hold a project for an agent CLI elsewhere, or in a neighbour whose name starts the same', async () => {
      const sources = withAgents([
        agent({ cwd: '/old/p-2' }),
        agent({ cwd: '/old' }),
        agent({ cwd: '/elsewhere/p' })
      ])

      expect(await reasonFor(sources)).toBeNull()
    })

    it('falls back on the folder the database has for a session whose terminal is not known', async () => {
      const sources = withAgents([agent({ cwd: null, worktreePath: '/old/p', agent: 'codex' })])

      expect(await reasonFor(sources)).toMatch(/^The Codex session "Fix login" has a terminal open/)
    })

    it('compares by real path: a terminal opened through a link into the folder counts', async () => {
      const sources = withAgents([agent({ cwd: '/link/p/src' })], {
        realPaths: { '/link/p/src': '/old/p/src' }
      })

      expect(await reasonFor(sources)).toMatch(/has a terminal open in this project/)
    })

    it('compares by real path: a folder that is moved under a spelling through a link counts', async () => {
      const sources = withAgents([agent({ cwd: '/real/p/src' })], {
        realPaths: { '/link/p': '/real/p' }
      })

      expect(await reasonFor(sources, P, P_WORKTREES, ['/link/p'])).toMatch(
        /has a terminal open in this project/
      )
    })

    it('resolves real paths on the real disk when given the real resolver', async () => {
      const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'hive-busy-probe-')))
      try {
        mkdirSync(join(sandbox, 'real', 'p', 'src'), { recursive: true })
        symlinkSync(join(sandbox, 'real'), join(sandbox, 'link'), 'dir')
        const sources = withAgents(
          [agent({ cwd: join(sandbox, 'link', 'p', 'src') })],
          {},
          { canonical: canonicalFolderPath }
        )

        expect(await reasonFor(sources, P, P_WORKTREES, [join(sandbox, 'real', 'p')])).toMatch(
          /has a terminal open in this project/
        )
        expect(await reasonFor(sources, P, P_WORKTREES, [join(sandbox, 'real', 'q')])).toBeNull()
      } finally {
        rmSync(sandbox, { recursive: true, force: true })
      }
    })

    it('says so when the agent is on its way out', async () => {
      // The app lists a session it has just stopped as no longer tracked.
      const sources = withAgents([
        agent({
          worktreePath: '/old/p',
          stopping: true,
          tracked: false,
          name: null,
          agent: 'opencode'
        })
      ])

      expect(await reasonFor(sources)).toBe(
        'An OpenCode session is still shutting down in this project. Wait a moment, then check again.'
      )
    })

    it('does not ask to close a tab for an agent process that outlived its terminal', async () => {
      const leftover = agent({ cwd: null, worktreePath: '/old/p', tracked: false, pid: 1234 })

      const sentence = await reasonFor(withAgents([leftover]))

      expect(sentence).toBe(
        'A leftover Claude Code process (pid 1234) of the session "Fix login" is still running in this project. Turn on Session profiler in Settings › Advanced and stop it there, or end the process, then check again.'
      )
      expect(sentence).not.toMatch(/tab/i)
      expect(await reasonFor(withAgents([leftover]), OTHER, [], ['/old/other'])).toBeNull()
    })

    it('names a leftover agent process by what is known about it', async () => {
      const remedy =
        'Turn on Session profiler in Settings › Advanced and stop it there, or end the process, then check again.'
      const leftover = (extra: Partial<BusyAgentSession>): BusySources =>
        withAgents([agent({ worktreePath: '/old/p', tracked: false, pid: 77, ...extra })])

      expect(await reasonFor(leftover({ name: ' ', agent: 'codex' }))).toBe(
        `A leftover Codex process (pid 77) is still running in this project. ${remedy}`
      )
      expect(await reasonFor(leftover({ pid: 0 }))).toBe(
        `A leftover Claude Code process of the session "Fix login" is still running in this project. ${remedy}`
      )
      expect(
        await reasonFor(leftover({ name: null, agent: 'other' as BusyAgentSession['agent'] }))
      ).toBe(`A leftover agent process (pid 77) is still running in this project. ${remedy}`)
    })

    it('still asks to close the tab of a session the app has in a terminal', async () => {
      // A list from an app that does not say whether it tracks the session reads as before.
      const unmarked = { ...agent({ cwd: '/old/p' }), tracked: undefined, pid: undefined }
      const sources = withAgents([unmarked as unknown as BusyAgentSession])

      expect(await reasonFor(sources)).toMatch(/Close its tab, then check again\.$/)
      expect(await reasonFor(withAgents([agent({ cwd: '/old/p', tracked: true })]))).toMatch(
        /Close its tab, then check again\.$/
      )
    })

    it('holds every project when the app reports that the list could not be made', async () => {
      const sources = makeSources({
        snapshot: { supported: true, sessions: [], error: 'ps exited with code 1.' }
      })

      const sentence =
        'Could not check for open agent sessions: ps exited with code 1. Check again.'
      expect(await reasonFor(sources)).toBe(sentence)
      expect(await reasonFor(sources, OTHER, [], ['/old/other'])).toBe(sentence)
    })

    it('holds every project when the desktop app cannot list agent sessions on this system', async () => {
      const sources = makeSources({ snapshot: { supported: false, sessions: [] } })

      expect(await reasonFor(sources)).toBe(
        'Moving projects is not available on this system yet: Hive cannot tell whether an agent session is open in a project.'
      )
    })

    it('does not ask to check again on Windows, where checking again changes nothing', async () => {
      const sources = makeSources({ snapshot: WINDOWS_SNAPSHOT })
      const sentence =
        'Moving projects is not available on this system yet: Hive cannot tell whether an agent session is open in a project.'

      for (const reading of [1, 2]) {
        const probe = await takeBusyReading(sources)
        for (const id of ['a', 'b', 'c']) {
          expect([reading, id, probe(project(id), [], [`/old/${id}`])]).toEqual([
            reading,
            id,
            sentence
          ])
        }
      }
      expect(sentence).not.toMatch(/check again|try again/i)
    })

    it('names what is running in a project before saying that moving is not available', async () => {
      const sources = makeSources({
        running: ['s1'],
        sessions: { s1: session() },
        snapshot: WINDOWS_SNAPSHOT
      })

      expect(await reasonFor(sources)).toMatch(/^The session "Fix login" is working/)
      expect(await reasonFor(sources, OTHER, [], ['/old/other'])).toMatch(
        /^Moving projects is not available on this system yet/
      )
    })

    it('lets projects through without a desktop app: no agent CLI can exist then', async () => {
      const unsupported = makeSources(
        { snapshot: { supported: false, sessions: [] } },
        { hasDesktopParent: false }
      )
      const failed = makeSources(
        { snapshot: { supported: true, sessions: [], error: 'no channel' } },
        { hasDesktopParent: false }
      )

      expect(await reasonFor(unsupported)).toBeNull()
      expect(await reasonFor(failed)).toBeNull()
      expect(
        await reasonFor(makeSources({ snapshot: WINDOWS_SNAPSHOT }, { hasDesktopParent: false }))
      ).toBeNull()
    })

    it('still reads the list a server without a desktop app is given', async () => {
      const sources = withAgents([agent({ cwd: '/old/p' })], {}, { hasDesktopParent: false })

      expect(await reasonFor(sources)).toMatch(/has a terminal open in this project/)
    })

    it('holds every project when the list does not arrive in time', async () => {
      const sources = makeSources({}, { agentCliSnapshot: () => new Promise(() => undefined) })

      const probe = await takeBusyReading(sources, { agentSnapshotTimeoutMs: 20 })

      expect(probe(P, P_WORKTREES, P_PATHS)).toBe(
        'Could not check for open agent sessions: the app did not answer in time. Check again.'
      )
    })

    it('waits five seconds for the list, and not longer', async () => {
      vi.useFakeTimers()
      try {
        const sources = makeSources({}, { agentCliSnapshot: () => new Promise(() => undefined) })
        let probe: Awaited<ReturnType<typeof takeBusyReading>> | null = null
        const reading = takeBusyReading(sources).then((taken) => {
          probe = taken
        })

        await vi.advanceTimersByTimeAsync(4_999)
        expect(probe).toBeNull()
        await vi.advanceTimersByTimeAsync(1)
        await reading
        expect(probe).not.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('holds every project when asking for the list fails or gives something unreadable', async () => {
      const rejecting = makeSources(
        {},
        { agentCliSnapshot: () => Promise.reject(new Error('channel closed')) }
      )
      const throwing = makeSources(
        {},
        {
          agentCliSnapshot: () => {
            throw new Error('not connected')
          }
        }
      )
      const unreadable = makeSources(
        {},
        { agentCliSnapshot: async () => ({ supported: true }) as unknown as BusyAgentSnapshot }
      )

      expect(await reasonFor(rejecting)).toBe(
        'Could not check for open agent sessions: channel closed. Check again.'
      )
      expect(await reasonFor(throwing)).toBe(
        'Could not check for open agent sessions: not connected. Check again.'
      )
      expect(await reasonFor(unreadable)).toBe(
        'Could not check for open agent sessions: the app gave an answer that could not be read. Check again.'
      )
    })

    it('names what is known to be running before what could not be checked', async () => {
      const sources = makeSources({
        running: ['s1'],
        sessions: { s1: session() },
        snapshot: { supported: true, sessions: [], error: 'boom' }
      })

      expect(await reasonFor(sources)).toMatch(/^The session "Fix login" is working/)
      expect(await reasonFor(sources, OTHER, [], ['/old/other'])).toMatch(
        /^Could not check for open agent sessions/
      )
    })
  })

  describe('plain terminals', () => {
    it('does not hold a project for a terminal that sits at its prompt', async () => {
      const sources = makeSources({ terminals: [{ pid: 41, cwd: '/old/p' }], foreground: [] })

      expect(await reasonFor(sources)).toBeNull()
    })

    it('holds a project while a terminal in its folder runs a command in the foreground', async () => {
      const sources = makeSources({
        terminals: [
          { pid: 41, cwd: '/old/p' },
          { pid: 42, cwd: '/old/p/web' }
        ],
        foreground: [42]
      })

      expect(await reasonFor(sources)).toBe(
        'A terminal in this project is running a command. Stop it, then check again.'
      )
    })

    it('does not hold a project for a command running in a terminal elsewhere', async () => {
      const sources = makeSources({
        terminals: [
          { pid: 41, cwd: '/old/p' },
          { pid: 42, cwd: '/old/p-2' }
        ],
        foreground: [42]
      })

      expect(await reasonFor(sources)).toBeNull()
    })

    it('compares the terminal folder by real path as well', async () => {
      const sources = makeSources({
        terminals: [{ pid: 42, cwd: '/link/p' }],
        foreground: [42],
        realPaths: { '/link/p': '/old/p' }
      })

      expect(await reasonFor(sources)).toMatch(/^A terminal in this project is running a command/)
    })

    it('does not hold a project when it cannot be told which terminals are running something', async () => {
      const unreadable = makeSources({ terminals: [{ pid: 42, cwd: '/old/p' }], foreground: null })
      const failing = makeSources(
        { terminals: [{ pid: 42, cwd: '/old/p' }] },
        { foregroundBusyPids: () => Promise.reject(new Error('ps: not found')) }
      )

      expect(await reasonFor(unreadable)).toBeNull()
      expect(await reasonFor(failing)).toBeNull()
    })

    it('does not hold a project for a terminal on Windows, where shells have no foreground group', async () => {
      const sources = makeSources(
        { terminals: [{ pid: 42, cwd: '/old/p' }] },
        { foregroundBusyPids: (pids) => readForegroundBusyPids(pids, { platform: 'win32' }) }
      )

      expect(await reasonFor(sources)).toBeNull()
    })

    it('asks once per reading, for every terminal whose pid is known', async () => {
      const foregroundBusyPids = vi.fn(async () => new Set<number>())
      const sources = makeSources(
        {
          terminals: [
            { pid: 41, cwd: '/old/p' },
            { pid: 0, cwd: '/old/p' },
            { pid: 42, cwd: '/elsewhere' }
          ]
        },
        { foregroundBusyPids }
      )

      const probe = await takeBusyReading(sources)
      probe(P, P_WORKTREES, P_PATHS)
      probe(OTHER, [], ['/old/other'])

      expect(foregroundBusyPids).toHaveBeenCalledTimes(1)
      expect(foregroundBusyPids).toHaveBeenCalledWith([41, 42])
    })

    it('does not ask at all when no terminal is open', async () => {
      const foregroundBusyPids = vi.fn(async () => new Set<number>())

      await reasonFor(makeSources({}, { foregroundBusyPids }))

      expect(foregroundBusyPids).not.toHaveBeenCalled()
    })
  })

  describe('plain terminals when the move goes to another disk', () => {
    const OPEN_TERMINAL =
      'A terminal is open in this project. The move goes to another disk and removes the folder the terminal is in. Close the terminal, then check again.'
    const idleIn = (cwd: string, world: Partial<World> = {}): BusySources =>
      makeSources({ terminals: [{ pid: 41, cwd }], foreground: [], ...world })

    it('holds a project for a terminal that sits at its prompt in its folder', async () => {
      const sources = idleIn('/old/p')

      expect(await reasonFor(sources, P, P_WORKTREES, P_PATHS, COPIES)).toBe(OPEN_TERMINAL)
      expect(await reasonFor(sources, OTHER, [], ['/old/other'], COPIES)).toBeNull()
    })

    it('does not hold it when the folder is renamed: the terminal keeps its folder', async () => {
      const sources = idleIn('/old/p')

      expect(await reasonFor(sources, P, P_WORKTREES, P_PATHS)).toBeNull()
      expect(await reasonFor(sources, P, P_WORKTREES, P_PATHS, {})).toBeNull()
      expect(await reasonFor(sources, P, P_WORKTREES, P_PATHS, { copies: false })).toBeNull()
    })

    it('answers each question of one reading by the kind of move asked about', async () => {
      const probe = await takeBusyReading(idleIn('/old/p'))

      expect(probe(P, P_WORKTREES, P_PATHS, COPIES)).toBe(OPEN_TERMINAL)
      expect(probe(P, P_WORKTREES, P_PATHS)).toBeNull()
      expect(probe(P, P_WORKTREES, P_PATHS, COPIES)).toBe(OPEN_TERMINAL)
    })

    it('holds a project for a terminal in a folder inside it, in any folder that moves', async () => {
      expect(await reasonFor(idleIn('/old/p/web'), P, P_WORKTREES, P_PATHS, COPIES)).toBe(
        OPEN_TERMINAL
      )
      expect(
        await reasonFor(idleIn('/old/p-feature'), P, P_WORKTREES, ['/old/p', '/old/p-feature'], {
          copies: true
        })
      ).toBe(OPEN_TERMINAL)
    })

    it('does not hold a project for a terminal elsewhere, or in a neighbour whose name starts the same', async () => {
      const sources = makeSources({
        terminals: [
          { pid: 41, cwd: '/old/p-2' },
          { pid: 42, cwd: '/old' },
          { pid: 43, cwd: '/elsewhere/p' }
        ],
        foreground: []
      })

      expect(await reasonFor(sources, P, P_WORKTREES, P_PATHS, COPIES)).toBeNull()
    })

    it('compares the terminal folder by real path as well', async () => {
      const sources = idleIn('/link/p', { realPaths: { '/link/p': '/old/p' } })

      expect(await reasonFor(sources, P, P_WORKTREES, P_PATHS, COPIES)).toBe(OPEN_TERMINAL)
    })

    it('says that a command is running when the terminal is running one', async () => {
      const sources = makeSources({ terminals: [{ pid: 41, cwd: '/old/p' }], foreground: [41] })

      expect(await reasonFor(sources, P, P_WORKTREES, P_PATHS, COPIES)).toBe(
        'A terminal in this project is running a command. Stop it, then check again.'
      )
    })

    it('holds a project for an open terminal even when it cannot be told what the terminal is doing', async () => {
      const unreadable = idleIn('/old/p', { foreground: null })
      const failing = makeSources(
        { terminals: [{ pid: 41, cwd: '/old/p' }] },
        { foregroundBusyPids: () => Promise.reject(new Error('ps: not found')) }
      )
      const windows = makeSources(
        { terminals: [{ pid: 41, cwd: '/old/p' }] },
        { foregroundBusyPids: (pids) => readForegroundBusyPids(pids, { platform: 'win32' }) }
      )
      const pidUnknown = makeSources({ terminals: [{ pid: 0, cwd: '/old/p' }] })

      for (const sources of [unreadable, failing, windows, pidUnknown]) {
        expect(await reasonFor(sources, P, P_WORKTREES, P_PATHS, COPIES)).toBe(OPEN_TERMINAL)
        expect(await reasonFor(sources, P, P_WORKTREES, P_PATHS)).toBeNull()
      }
    })

    it('names an agent session in the folder before a plain terminal', async () => {
      const sources = idleIn('/old/p', {
        snapshot: { supported: true, sessions: [agent({ cwd: '/old/p' })] }
      })

      expect(await reasonFor(sources, P, P_WORKTREES, P_PATHS, COPIES)).toMatch(
        /^The Claude Code session "Fix login" has a terminal open/
      )
    })
  })

  describe('one reading, asked about many projects', () => {
    it('reads each source once, however many projects are asked about', async () => {
      const runningSessionIds = vi.fn(() => ['s1'])
      const getSession = vi.fn(() => session({ project_id: 'other' }))
      const activeDocumentRuns = vi.fn(() => [])
      const activeShellSessions = vi.fn(() => [])
      const agentCliSnapshot = vi.fn(async () => NO_AGENTS)
      const terminals = vi.fn(() => [])
      const sources = makeSources(
        {},
        {
          runningSessionIds,
          getSession,
          activeDocumentRuns,
          activeShellSessions,
          agentCliSnapshot,
          terminals
        }
      )

      const probe = await takeBusyReading(sources)
      for (const id of ['a', 'b', 'c']) probe(project(id), [], [`/old/${id}`])

      for (const read of [
        runningSessionIds,
        getSession,
        activeDocumentRuns,
        activeShellSessions,
        agentCliSnapshot,
        terminals
      ]) {
        expect(read).toHaveBeenCalledTimes(1)
      }
    })

    it('resolves each real path once', async () => {
      const canonical = vi.fn((path: string) => path)
      const sources = makeSources(
        { snapshot: { supported: true, sessions: [agent({ cwd: '/elsewhere' })] } },
        { canonical }
      )

      const probe = await takeBusyReading(sources)
      probe(P, P_WORKTREES, P_PATHS)
      probe(P, P_WORKTREES, P_PATHS)

      expect(canonical.mock.calls.map(([path]) => path).sort()).toEqual(['/elsewhere', '/old/p'])
    })
  })

  describe('a source that fails', () => {
    const boom = (): never => {
      throw new Error('database is locked.')
    }

    it.each([
      [
        'the running session ids',
        { runningSessionIds: boom },
        'Could not check which sessions are working: database is locked. Check again.'
      ],
      [
        'a session row',
        { runningSessionIds: () => ['s1'], getSession: boom },
        'Could not check which sessions are working: database is locked. Check again.'
      ],
      [
        'the document runs',
        { activeDocumentRuns: boom },
        'Could not check for running orchestrators: database is locked. Check again.'
      ],
      [
        'the shell commands',
        { activeShellSessions: boom },
        'Could not check for running commands: database is locked. Check again.'
      ],
      [
        'the terminals',
        { terminals: boom },
        'Could not check the open terminals: database is locked. Check again.'
      ],
      [
        'the script runner',
        { isScriptRunning: boom },
        'Could not check whether something is running in this project: database is locked. Check again.'
      ]
    ] as [string, Partial<BusySources>, string][])(
      'never rejects and holds every project when %s cannot be read',
      async (_what, overrides, sentence) => {
        const sources = makeSources({}, overrides)

        expect(await reasonFor(sources)).toBe(sentence)
      }
    )

    it('holds every project when a connection or a connection project cannot be read', async () => {
      const brokenConnection = makeSources(
        {
          running: ['s1'],
          sessions: { s1: session({ project_id: 'other', connection_id: 'c1' }) }
        },
        { getConnection: boom }
      )
      const brokenProject = makeSources(
        { runs: [run({ project_id: 'other' })] },
        { getProject: boom }
      )

      expect(await reasonFor(brokenConnection)).toMatch(
        /^Could not check which sessions are working/
      )
      expect(await reasonFor(brokenProject)).toMatch(/^Could not check for running orchestrators/)
    })

    it('goes on by spelling when a real path cannot be resolved', async () => {
      const sources = makeSources(
        { snapshot: { supported: true, sessions: [agent({ cwd: '/old/p' })] } },
        { canonical: boom }
      )

      expect(await reasonFor(sources)).toMatch(/has a terminal open in this project/)
      expect(await reasonFor(sources, OTHER, [], ['/old/other'])).toBeNull()
    })

    it('reports each failed check to the log', async () => {
      const log = vi.fn()
      const sources = makeSources({}, { activeDocumentRuns: boom, log })

      await reasonFor(sources)

      expect(log).toHaveBeenCalledWith('dev folder: could not check for running orchestrators', {
        error: 'database is locked'
      })
    })
  })
})

describe('memberProjectIdsOf', () => {
  it('reads the ids of a connection project and nothing from anything else', () => {
    expect(memberProjectIdsOf({ member_project_ids: JSON.stringify(['a', '', 7, 'b']) })).toEqual([
      'a',
      'b'
    ])
    expect(memberProjectIdsOf({ member_project_ids: '{"a":1}' })).toEqual([])
    expect(memberProjectIdsOf({ member_project_ids: 'not json' })).toEqual([])
    expect(memberProjectIdsOf({ member_project_ids: null })).toEqual([])
    expect(memberProjectIdsOf(null)).toEqual([])
  })
})

describe('parseForegroundBusyPids', () => {
  // pid, process group, foreground process group of the terminal.
  const PS = [
    '    1     1     0',
    '  410   410   410',
    '  420   420   977',
    '  977   977   977',
    '  430   430    -1',
    '  440   440     0',
    'garbage line',
    '  450   450',
    ''
  ].join('\n')

  it('finds the shells whose terminal is held by another process group', () => {
    expect([...parseForegroundBusyPids(PS, [410, 420, 430, 440, 450, 999])]).toEqual([420])
  })

  it('only answers for the pids it was asked about', () => {
    expect(parseForegroundBusyPids(PS, [410]).size).toBe(0)
    expect(parseForegroundBusyPids(PS, []).size).toBe(0)
  })
})

describe('readForegroundBusyPids', () => {
  it('cannot tell on Windows, and does not try', async () => {
    const readProcessGroups = vi.fn(async () => '')

    expect(await readForegroundBusyPids([1], { platform: 'win32', readProcessGroups })).toBeNull()
    expect(readProcessGroups).not.toHaveBeenCalled()
  })

  it('cannot tell when ps fails', async () => {
    const readProcessGroups = (): Promise<string> => Promise.reject(new Error('spawn ps ENOENT'))

    expect(await readForegroundBusyPids([1], { platform: 'darwin', readProcessGroups })).toBeNull()
  })

  it('runs ps once and reads the answer for the pids asked about', async () => {
    const readProcessGroups = vi.fn(async () => ' 10 10 10\n 20 20 31\n')

    const busy = await readForegroundBusyPids([10, 20], { platform: 'linux', readProcessGroups })

    expect([...(busy ?? [])]).toEqual([20])
    expect(readProcessGroups).toHaveBeenCalledTimes(1)
  })

  it('does not run ps for no pids', async () => {
    const readProcessGroups = vi.fn(async () => '')

    expect(
      (await readForegroundBusyPids([], { platform: 'darwin', readProcessGroups }))?.size
    ).toBe(0)
    expect(readProcessGroups).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform === 'win32')('a real terminal, asked through the real ps', () => {
  interface Terminal {
    readonly pid: number
    write(data: string): void
    kill(signal?: string): void
  }
  const terminals: Terminal[] = []

  afterEach(() => {
    for (const terminal of terminals.splice(0)) {
      try {
        terminal.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })

  /** Ask `ps` until the terminal reads as running a command (or not), for at most ten seconds. */
  const waitUntil = async (pid: number, running: boolean): Promise<boolean> => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const busy = await readForegroundBusyPids([pid])
      if (busy !== null && busy.has(pid) === running) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }

  it('tells a shell at its prompt from one running a command in the foreground', async (context) => {
    // The same library the app opens its terminals with.
    const pty = await import('node-pty').catch(() => null)
    if (pty === null) return context.skip()
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'hive-busy-terminal-')))
    try {
      const terminal = pty.spawn('/bin/sh', [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: folder,
        env: { ...process.env, PS1: '$ ' } as Record<string, string>
      })
      terminals.push(terminal)
      const sources = (): BusySources =>
        makeSources(
          { terminals: [{ pid: terminal.pid, cwd: folder }] },
          {
            foregroundBusyPids: (pids) => readForegroundBusyPids(pids),
            canonical: canonicalFolderPath
          }
        )

      // At its prompt: the terminal's foreground group is the shell's own.
      expect(await waitUntil(terminal.pid, false)).toBe(true)
      expect(await reasonFor(sources(), P, P_WORKTREES, [folder])).toBeNull()
      // The same idle terminal holds the project when its folder would be removed.
      expect(await reasonFor(sources(), P, P_WORKTREES, [folder], { copies: true })).toBe(
        'A terminal is open in this project. The move goes to another disk and removes the folder the terminal is in. Close the terminal, then check again.'
      )
      expect(
        await reasonFor(sources(), P, P_WORKTREES, [join(folder, 'elsewhere')], { copies: true })
      ).toBeNull()

      // A command in the foreground: the shell handed the terminal to the command's group.
      terminal.write('sleep 60\n')
      expect(await waitUntil(terminal.pid, true)).toBe(true)
      expect(await reasonFor(sources(), P, P_WORKTREES, [folder])).toBe(
        'A terminal in this project is running a command. Stop it, then check again.'
      )
      expect(await reasonFor(sources(), P, P_WORKTREES, [join(folder, 'elsewhere')])).toBeNull()

      // Interrupted: back at the prompt.
      terminal.write('\x03')
      expect(await waitUntil(terminal.pid, false)).toBe(true)

      // A command left running in the background does not hold the terminal.
      terminal.write('sleep 5 &\n')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await waitUntil(terminal.pid, false)).toBe(true)
      expect(await reasonFor(sources(), P, P_WORKTREES, [folder])).toBeNull()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60_000)
})
