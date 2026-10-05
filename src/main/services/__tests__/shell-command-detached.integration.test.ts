import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_BASE_URL_ENV,
  ASSUME_FIRST_PARTY_ENV,
  setClaudeApiProxyBaseUrl
} from '../claude-api-proxy/claude-api-proxy-env'
import {
  adoptDetachedRunHost,
  createDetachedRunHost,
  detachedRunPreflight,
  parseInnerFile,
  stopDetachedRun
} from '../shell-command-detached-host'
import { SHELL_COMMAND_RUN_FILES, runHasLiveOwner } from '../shell-command-paths'
import type { RunHostExit, RunHostSink, ShellCommandRunHost } from '../shell-command-run-host'
import { buildDetachedHostSpawn, buildShellCommandPtySpawn } from '../shell-command-spawner'

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

/**
 * Really spawns the detached host (/bin/sh + cat + script(1)) under plain Node.
 *
 * Process safety: everything lives in one mkdtemp directory; every pid / process group
 * this file starts is recorded, only recorded pids are ever signalled, and afterEach
 * runs the stop recipe for every run directory and asserts nothing is left alive.
 */
const FIXTURE = resolve(__dirname, 'fixtures', 'shell-command-detached-parent.cjs')
const TEST_TIMEOUT_MS = 20_000
const COLS = 100
const ROWS = 30

const SHELLS = [...(process.platform === 'darwin' ? ['/bin/zsh'] : []), '/bin/bash'].filter(
  (shell) => existsSync(shell)
)

const unsupported = process.platform === 'win32' || detachedRunPreflight() !== null

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await delay(25)
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function pgidOf(pid: number): string {
  return execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)])
    .toString()
    .trim()
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

interface Recorder {
  sink: RunHostSink
  output(): string
  lines(): string[]
  exits: RunHostExit[]
  exit: Promise<RunHostExit>
}

function makeRecorder(): Recorder {
  const chunks: string[] = []
  const exits: RunHostExit[] = []
  let resolveExit: (exit: RunHostExit) => void = () => {}
  const exit = new Promise<RunHostExit>((done) => {
    resolveExit = done
  })
  return {
    sink: {
      data: (chunk) => chunks.push(chunk),
      exit: (result) => {
        exits.push(result)
        resolveExit(result)
      }
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split(/\r?\n/),
    exits,
    exit
  }
}

describe.skipIf(unsupported)('detached shell-command runs (real processes)', () => {
  let baseDir: string
  let workDir: string
  let counter = 0
  const savedShell = process.env.SHELL
  // Everything this file started, for cleanup and the "nothing left" assertion.
  let runDirs: string[] = []
  let hosts: ShellCommandRunHost[] = []
  let recordedPids: number[] = []
  let fixtures: ChildProcess[] = []

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'shellcmd-detached-'))
    workDir = join(baseDir, 'worktree')
    mkdirSync(workDir)
  })

  afterEach(async () => {
    for (const host of hosts) host.detach()
    for (const fixture of fixtures) {
      if (fixture.pid && fixture.exitCode === null && fixture.signalCode === null) {
        try {
          process.kill(-fixture.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    const stillLive: string[] = []
    for (const runDir of runDirs) {
      await stopDetachedRun(runDir)
      // A run that just finished on its own: the exit file is written a moment before
      // the host lets go of the FIFO.
      const deadline = Date.now() + 3000
      while (runHasLiveOwner(runDir) && Date.now() < deadline) await delay(25)
      if (runHasLiveOwner(runDir)) stillLive.push(runDir)
    }
    const survivors: number[] = []
    for (const pid of recordedPids) {
      const deadline = Date.now() + 2000
      while (isAlive(pid) && Date.now() < deadline) await delay(25)
      if (isAlive(pid)) {
        survivors.push(pid)
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Gone in the meantime.
        }
      }
    }
    runDirs = []
    hosts = []
    recordedPids = []
    fixtures = []
    if (savedShell === undefined) delete process.env.SHELL
    else process.env.SHELL = savedShell
    setClaudeApiProxyBaseUrl(null)
    expect(stillLive).toEqual([])
    expect(survivors).toEqual([])
  })

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  function newRunDir(): string {
    counter += 1
    const runDir = join(baseDir, 'runs', `session-${counter}`, `run-${counter}`)
    runDirs.push(runDir)
    return runDir
  }

  function runFile(runDir: string, name: keyof typeof SHELL_COMMAND_RUN_FILES): string {
    return join(runDir, SHELL_COMMAND_RUN_FILES[name])
  }

  async function startRun(
    shell: string,
    steps: string[],
    env: Record<string, string> = {}
  ): Promise<Recorder & { host: ShellCommandRunHost; runDir: string; hostPid: number }> {
    // The host builds its argv from $SHELL: pin it.
    process.env.SHELL = shell
    const runDir = newRunDir()
    const recorder = makeRecorder()
    const host = createDetachedRunHost({
      sessionId: `session-${counter}`,
      runDir,
      cwd: workDir,
      steps,
      // The shells run -ilc / -ic: point them at an empty HOME so the developer's own
      // rc files (nvm, oh-my-zsh, an `exec fish`) never shape the test.
      env: { HOME: baseDir, ZDOTDIR: baseDir, ...env },
      cols: COLS,
      rows: ROWS,
      sink: recorder.sink
    })
    hosts.push(host)
    await host.start()
    const hostPid = Number(readText(runFile(runDir, 'hostPid')).trim())
    expect(hostPid).toBeGreaterThan(1)
    recordedPids.push(hostPid)
    return { ...recorder, host, runDir, hostPid }
  }

  function adopt(runDir: string): Recorder & { host: ShellCommandRunHost } {
    const recorder = makeRecorder()
    const host = adoptDetachedRunHost({ sessionId: 'adopted', runDir, sink: recorder.sink })
    hosts.push(host)
    return { ...recorder, host }
  }

  describe.each(SHELLS)('%s', (shell) => {
    it(
      '(a) runs the steps in a PTY of the requested size and records the result',
      async () => {
        const run = await startRun(shell, ['stty size', 'echo two'])
        expect(run.host.mode).toBe('detached')

        const exit = await run.exit

        expect(exit).toEqual({ kind: 'exited', exitCode: 0, signal: null, abnormal: false })
        expect(readText(runFile(run.runDir, 'exit'))).toBe('script=0\nwrapper=0\n')
        expect(run.lines()).toContain(`${ROWS} ${COLS}`)
        expect(run.lines()).toContain('two')
        expect(run.output()).toContain('[tedooo] Succeeded')
        expect(run.output()).not.toContain('Script started')
        // Gapless: the sink received exactly the bytes script(1) logged.
        expect(run.output()).toBe(readText(runFile(run.runDir, 'log')))
        expect(statSync(runFile(run.runDir, 'log')).mode & 0o777).toBe(0o600)
        expect(run.exits).toHaveLength(1)
        await waitFor(() => !runHasLiveOwner(run.runDir), 3000, 'the host to exit')
      },
      TEST_TIMEOUT_MS
    )

    it(
      '(b) stops at the first failing step with its exit code',
      async () => {
        const run = await startRun(shell, ['echo one', "sh -c 'exit 3'", 'echo NOTRUN'])

        const exit = await run.exit

        expect(exit).toEqual({ kind: 'exited', exitCode: 3, signal: null, abnormal: false })
        expect(readText(runFile(run.runDir, 'exit'))).toBe('script=3\nwrapper=3\n')
        expect(run.lines()).toContain('one')
        expect(run.lines()).not.toContain('NOTRUN')
        expect(run.output()).toContain('[tedooo] Failed at step 2/3')
      },
      TEST_TIMEOUT_MS
    )

    it(
      '(c) forwards keyboard input and leads its own process group',
      async () => {
        const run = await startRun(shell, [
          'printf "Enter> "; read -r X; echo "got=[$X]"',
          'test -t 0 && test -t 1 && test -t 2 && echo TTY-OK'
        ])
        await waitFor(() => run.output().endsWith('Enter> '), 10_000, 'the read prompt')

        // The host is its own session / process group leader: it does not die with us.
        expect(pgidOf(run.hostPid)).toBe(String(run.hostPid))
        expect(pgidOf(run.hostPid)).not.toBe(pgidOf(process.pid))
        expect(runHasLiveOwner(run.runDir)).toBe(true)
        const inner = parseInnerFile(readText(runFile(run.runDir, 'inner')))
        expect(inner).not.toBeNull()
        expect(pgidOf(inner!.pid)).toBe(String(inner!.pid))
        expect(run.exits).toEqual([])

        run.host.write('hello\r')

        const exit = await run.exit
        expect(exit).toEqual({ kind: 'exited', exitCode: 0, signal: null, abnormal: false })
        expect(run.lines()).toContain('got=[hello]')
        expect(run.lines()).toContain('TTY-OK')
      },
      TEST_TIMEOUT_MS
    )

    it(
      '(d) survives its parent and is adopted by a new owner',
      async () => {
        const runDir = newRunDir()
        const logPath = runFile(runDir, 'log')
        mkdirSync(runDir, { recursive: true, mode: 0o700 })
        execFileSync('mkfifo', ['-m', '600', runFile(runDir, 'stdin')])
        writeFileSync(logPath, '', { mode: 0o600 })
        const hostSpawn = buildDetachedHostSpawn(
          buildShellCommandPtySpawn(
            ['echo first', 'printf "Enter> "; read -r X; echo "got=[$X]"', 'echo last'],
            { shell }
          ),
          { runDir, cols: COLS, rows: ROWS }
        )
        const env: Record<string, string | undefined> = {
          ...process.env,
          TERM: 'xterm-256color',
          HOME: baseDir,
          ZDOTDIR: baseDir
        }
        delete env.TEDOOO_SHELL_RUN_DIR
        const specPath = join(baseDir, `spec-${counter}.json`)
        writeFileSync(specPath, JSON.stringify({ ...hostSpawn, cwd: workDir, env }))

        // The "app": its own process group, so killing the group cannot touch vitest.
        const fixture = spawn(process.execPath, [FIXTURE, specPath], {
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore']
        })
        fixtures.push(fixture)
        const fixtureExited = new Promise<void>((done) => fixture.once('exit', () => done()))
        let fixtureOut = ''
        fixture.stdout?.on('data', (chunk: Buffer) => {
          fixtureOut += chunk.toString()
        })
        await waitFor(() => /^host=\d+$/m.test(fixtureOut), 10_000, 'the fixture to spawn the host')
        const hostPid = Number(/^host=(\d+)$/m.exec(fixtureOut)?.[1])
        recordedPids.push(hostPid)
        await waitFor(
          () => readText(runFile(runDir, 'hostPid')).trim() === String(hostPid),
          5000,
          'host.pid'
        )
        await waitFor(() => readText(logPath).endsWith('Enter> '), 10_000, 'the read prompt')

        // Kill the whole "app" process group, the way a force-quit would.
        expect(fixture.pid).toBeGreaterThan(1)
        expect(pgidOf(fixture.pid!)).toBe(String(fixture.pid))
        expect(pgidOf(hostPid)).toBe(String(hostPid))
        process.kill(-fixture.pid!, 'SIGKILL')
        await fixtureExited
        await delay(300)

        expect(isAlive(hostPid)).toBe(true)
        expect(runHasLiveOwner(runDir)).toBe(true)
        expect(existsSync(runFile(runDir, 'exit'))).toBe(false)

        // A new owner adopts the run: replay, input, result.
        const adopted = adopt(runDir)
        await waitFor(() => adopted.output().endsWith('Enter> '), 5000, 'the replay')
        expect(adopted.output()).toBe(readText(logPath))
        expect(adopted.lines()).toContain('first')
        await adopted.host.start()

        adopted.host.write('adopted\r')

        const exit = await adopted.exit
        expect(exit).toEqual({ kind: 'exited', exitCode: 0, signal: null, abnormal: false })
        expect(adopted.lines()).toContain('got=[adopted]')
        expect(adopted.lines()).toContain('last')
        expect(adopted.output()).toBe(readText(logPath))
        expect(readText(runFile(runDir, 'exit'))).toBe('script=0\nwrapper=0\n')
      },
      TEST_TIMEOUT_MS
    )

    it(
      '(e) stop() kills the whole tree, including children that try to escape',
      async () => {
        const pidDir = join(baseDir, `pids-${counter + 1}`)
        mkdirSync(pidDir)
        const hasPerl = existsSync('/usr/bin/perl')
        const names = ['bg', 'immune', 'nohup', ...(hasPerl ? ['pgrp'] : []), 'fg']
        const step = [
          `D='${pidDir}'`,
          // a plain background job
          'sleep 301 & echo $! > "$D/bg"',
          // a child immune to HUP / TERM / INT
          `sh -c 'trap "" HUP TERM INT; echo $$ > "$1/immune"; exec sleep 302' sh "$D" &`,
          // a nohup child
          'nohup sleep 303 >/dev/null 2>&1 & echo $! > "$D/nohup"',
          // a child that leaves the shell's process group (but keeps the tty)
          ...(hasPerl
            ? [
                `perl -e 'setpgrp(0,0); open(F, ">", "$ARGV[0]/pgrp"); print F $$; close(F); exec "sleep", "304"' "$D" &`
              ]
            : []),
          // the foreground job
          `sh -c 'echo $$ > "$1/fg"; exec sleep 305' sh "$D"`
        ].join('; ')
        // 'a & ; b' is a syntax error: separators after '&' must be dropped.
        const run = await startRun(shell, [step.replace(/&; /g, '& '), 'echo NOTRUN'])

        const readPid = (name: string): number => Number(readText(join(pidDir, name)).trim())
        await waitFor(
          () => names.every((name) => readPid(name) > 1),
          10_000,
          'every child to record its pid'
        )
        const pids = names.map(readPid)
        recordedPids.push(...pids)
        const inner = parseInnerFile(readText(runFile(run.runDir, 'inner')))
        expect(inner).not.toBeNull()
        recordedPids.push(inner!.pid)
        await delay(200)
        expect(pids.map(isAlive)).toEqual(pids.map(() => true))
        if (hasPerl) expect(pgidOf(readPid('pgrp'))).not.toBe(String(inner!.pid))

        const startedAt = Date.now()
        await run.host.stop()
        const elapsed = Date.now() - startedAt

        expect(elapsed).toBeLessThan(3000)
        expect(runHasLiveOwner(run.runDir)).toBe(false)
        await waitFor(() => pids.every((pid) => !isAlive(pid)), 2000, 'every child to be gone')
        expect(isAlive(inner!.pid)).toBe(false)
        await waitFor(() => !isAlive(run.hostPid), 2000, 'the host to be gone')
        // A stopped host never reports an exit, and input is dropped silently.
        run.host.write('ignored\r')
        await delay(400)
        expect(run.exits).toEqual([])
        expect(run.lines()).not.toContain('NOTRUN')
      },
      TEST_TIMEOUT_MS
    )

    it(
      '(f) a run whose host and shell were killed is reported as lost',
      async () => {
        const run = await startRun(shell, ['echo started; sleep 306', 'echo NOTRUN'])
        await waitFor(() => run.lines().includes('started'), 10_000, 'the first step')
        const inner = parseInnerFile(readText(runFile(run.runDir, 'inner')))
        expect(inner).not.toBeNull()
        recordedPids.push(inner!.pid)
        // Our own host object stops watching, like an app that is gone.
        run.host.detach()

        // Host group first: nobody is left to write an exit file for the dying shell.
        process.kill(-run.hostPid, 'SIGKILL')
        try {
          process.kill(-inner!.pid, 'SIGKILL')
        } catch {
          // The hangup from the dying script(1) got there first.
        }
        await waitFor(() => !runHasLiveOwner(run.runDir), 3000, 'the owner to vanish')

        const adopted = adopt(run.runDir)
        const exit = await adopted.exit

        expect(exit).toEqual({ kind: 'lost' })
        expect(existsSync(runFile(run.runDir, 'exit'))).toBe(false)
        expect(adopted.lines()).toContain('started')
        expect(adopted.lines()).not.toContain('NOTRUN')
        expect(run.exits).toEqual([])
        expect(adopted.exits).toHaveLength(1)
      },
      TEST_TIMEOUT_MS
    )

    it(
      '(g) the log limit ends the run without limiting the command itself',
      async () => {
        const bigFile = join(baseDir, `big-${counter + 1}.bin`)
        const run = await startRun(
          shell,
          [
            `head -c 3000000 /dev/zero > '${bigFile}'`,
            "head -c 6000000 /dev/zero | tr '\\0' 'x'",
            'echo NOTRUN'
          ],
          { TEDOOO_SHELL_LOG_LIMIT_BLOCKS: '2048' }
        )

        const exit = await run.exit

        expect(exit).toMatchObject({ kind: 'exited', abnormal: true, reason: 'output-limit' })
        expect(exit.kind === 'exited' && exit.exitCode).toBe(153)
        expect(statSync(runFile(run.runDir, 'log')).size).toBeLessThanOrEqual(2 * 1024 * 1024)
        expect(statSync(runFile(run.runDir, 'log')).size).toBeGreaterThan(256 * 1024)
        // The limit applies to the log only: the earlier step wrote its 3 MB file in full.
        expect(statSync(bigFile).size).toBe(3_000_000)
        expect(run.lines()).not.toContain('NOTRUN')
      },
      TEST_TIMEOUT_MS
    )
  })

  it(
    '(h) builds the host environment from the app env, minus what dies with the app',
    async () => {
      const proxyUrl = 'http://127.0.0.1:9/tedooo-test-proxy'
      const saved = {
        base: process.env[ANTHROPIC_BASE_URL_ENV],
        firstParty: process.env[ASSUME_FIRST_PARTY_ENV],
        runDir: process.env.TEDOOO_SHELL_RUN_DIR
      }
      process.env[ANTHROPIC_BASE_URL_ENV] = proxyUrl
      process.env[ASSUME_FIRST_PARTY_ENV] = 'tedooo-test-first-party'
      process.env.TEDOOO_SHELL_RUN_DIR = '/nonexistent/inherited'
      setClaudeApiProxyBaseUrl(proxyUrl)
      try {
        const run = await startRun(
          '/bin/bash',
          [
            'echo "base=[$ANTHROPIC_BASE_URL] fp=[$_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL]"',
            'echo "dir=[$TEDOOO_SHELL_RUN_DIR] limit=[$TEDOOO_SHELL_LOG_LIMIT_BLOCKS]"',
            'echo "extra=[$TEDOOO_TEST_EXTRA] term=[$TERM] cwd=[$PWD]"'
          ],
          { TEDOOO_TEST_EXTRA: 'from-options' }
        )

        const exit = await run.exit

        expect(exit).toEqual({ kind: 'exited', exitCode: 0, signal: null, abnormal: false })
        expect(run.output()).not.toContain('tedooo-test-proxy')
        expect(run.output()).not.toContain('tedooo-test-first-party')
        expect(run.lines()).toContain('dir=[] limit=[]')
        const extraLine = run.lines().find((line) => line.startsWith('extra=['))
        expect(extraLine).toContain('extra=[from-options] term=[xterm-256color]')
        expect(extraLine).toContain('/worktree]')
      } finally {
        for (const [key, value] of [
          [ANTHROPIC_BASE_URL_ENV, saved.base],
          [ASSUME_FIRST_PARTY_ENV, saved.firstParty],
          ['TEDOOO_SHELL_RUN_DIR', saved.runDir]
        ] as const) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    },
    TEST_TIMEOUT_MS
  )

  it(
    '(i) start() fails cleanly when the host cannot run',
    async () => {
      process.env.SHELL = '/bin/bash'
      const runDir = newRunDir()
      const recorder = makeRecorder()
      const host = createDetachedRunHost({
        sessionId: 'no-cwd',
        runDir,
        cwd: join(baseDir, 'does-not-exist'),
        steps: ['echo never'],
        env: { HOME: baseDir, ZDOTDIR: baseDir },
        cols: COLS,
        rows: ROWS,
        sink: recorder.sink
      })
      hosts.push(host)

      await expect(host.start()).rejects.toThrow('The command host did not start')

      expect(existsSync(runDir)).toBe(false)
      expect(recorder.exits).toEqual([])
      host.write('x')
      host.resize(80, 24)
      await host.stop()
    },
    TEST_TIMEOUT_MS
  )

  it(
    '(j) a stop() issued while the host is starting still kills the run',
    async () => {
      process.env.SHELL = '/bin/bash'
      const runDir = newRunDir()
      const recorder = makeRecorder()
      const host = createDetachedRunHost({
        sessionId: 'stop-during-start',
        runDir,
        cwd: workDir,
        steps: ['echo started; sleep 307', 'echo NOTRUN'],
        env: { HOME: baseDir, ZDOTDIR: baseDir },
        cols: COLS,
        rows: ROWS,
        sink: recorder.sink
      })
      hosts.push(host)

      const starting = host.start()
      const stopping = host.stop()
      await starting
      // start() is idempotent: a second call never spawns a second host.
      await host.start()
      const hostPid = Number(readText(runFile(runDir, 'hostPid')).trim())
      expect(hostPid).toBeGreaterThan(1)
      recordedPids.push(hostPid)
      await stopping

      expect(runHasLiveOwner(runDir)).toBe(false)
      await waitFor(() => !isAlive(hostPid), 2000, 'the host to be gone')
      await delay(300)
      expect(recorder.exits).toEqual([])
      expect(readText(runFile(runDir, 'log')).split(/\r?\n/)).not.toContain('NOTRUN')
    },
    TEST_TIMEOUT_MS
  )
})
