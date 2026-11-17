// The per-launch debug-log directory of a Code Mode session (Code Mode T06): what prepare
// puts on disk and for whom, what it refuses, what its environment file does in a real shell,
// and what remove and sweep delete. Runs against a real temporary directory.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

// The real file system, with one call that a test can make fail part-way through a prepare.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fchmodSync: vi.fn(actual.fchmodSync) }
})

import {
  CLAUDE_CLI_DEBUG_DIRNAME,
  CLAUDE_CLI_DEBUG_ENV_FILENAME,
  CLAUDE_CLI_DEBUG_LOG_FILENAME,
  CLAUDE_CLI_DEBUG_VARIABLE,
  ClaudeCliDebugDirs,
  claudeCliDebugDirs,
  claudeCliDebugEnvFileContent,
  getClaudeCliDebugRootDir,
  type ClaudeCliDebugLaunch
} from './claude-cli-debug-dir'

// Owner-only modes, symbolic links and `sh` are what this is about: POSIX only, as the module.
const describePosix = describe.skipIf(process.platform === 'win32')

const NONCE = '0123456789abcdef'
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash'].filter((shell) =>
  existsSync(shell)
)

const modeOf = (path: string): number => lstatSync(path).mode & 0o777

let base: string
/** `<data dir>/claude-cli-debug`. It does not exist until something is prepared. */
let root: string
/** App processes that are running, besides the one under test (`app1`). */
let aliveInstances: Set<string>

/** The app process `app1` on the data directory. */
const dirsOf = (
  options: Partial<ConstructorParameters<typeof ClaudeCliDebugDirs>[0]> = {}
): ClaudeCliDebugDirs =>
  new ClaudeCliDebugDirs({
    root,
    instanceId: 'app1',
    isInstanceAlive: (instanceId) => aliveInstances.has(instanceId),
    ...options
  })

const prepared = (dirs: ClaudeCliDebugDirs, sessionId: string): ClaudeCliDebugLaunch => {
  const launch = dirs.prepare(sessionId)
  if (!launch) throw new Error(`No directory was prepared for ${sessionId}`)
  return launch
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'claude-cli-debug-dir-'))
  root = join(base, 'data', CLAUDE_CLI_DEBUG_DIRNAME)
  mkdirSync(dirname(root))
  aliveInstances = new Set()
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describePosix('ClaudeCliDebugDirs.prepare', () => {
  it('creates a directory for the launch with an empty log and an environment file', () => {
    const launch = dirsOf({ nonce: () => NONCE }).prepare('session-1')

    const dir = join(root, `session-1-app1-${NONCE}`)
    expect(launch).toEqual({
      sessionId: 'session-1',
      dir,
      logFile: join(dir, CLAUDE_CLI_DEBUG_LOG_FILENAME),
      envFile: join(dir, CLAUDE_CLI_DEBUG_ENV_FILENAME)
    })
    expect(readdirSync(dir).sort()).toEqual(['env.sh', 'usage.log'])
    expect(readFileSync(launch!.logFile, 'utf8')).toBe('')
    expect(readFileSync(launch!.envFile, 'utf8')).toBe(claudeCliDebugEnvFileContent())
  })

  it('makes the directory and its files readable by their owner only', () => {
    const launch = prepared(dirsOf(), 'session-1')

    expect(modeOf(root)).toBe(0o700)
    expect(modeOf(launch.dir)).toBe(0o700)
    expect(modeOf(launch.logFile)).toBe(0o600)
    expect(modeOf(launch.envFile)).toBe(0o600)
    expect(lstatSync(launch.dir).uid).toBe(process.getuid!())
    expect(lstatSync(launch.logFile).isFile()).toBe(true)
    expect(lstatSync(launch.envFile).isFile()).toBe(true)
  })

  it('keeps them private whatever the umask of the app is', () => {
    const umask = process.umask(0)
    try {
      const open = prepared(dirsOf(), 'session-1')
      expect(modeOf(root)).toBe(0o700)
      expect(modeOf(open.dir)).toBe(0o700)
      expect(modeOf(open.logFile)).toBe(0o600)
      expect(modeOf(open.envFile)).toBe(0o600)

      // A umask that takes more than group and other away from what is made.
      rmSync(root, { recursive: true })
      process.umask(0o277)
      const tight = prepared(dirsOf(), 'session-2')
      expect(modeOf(root)).toBe(0o700)
      expect(modeOf(tight.dir)).toBe(0o700)
      expect(modeOf(tight.logFile)).toBe(0o600)
      expect(modeOf(tight.envFile)).toBe(0o600)
    } finally {
      process.umask(umask)
    }
  })

  it('gives every launch of one session a directory of its own', () => {
    const dirs = dirsOf()
    const first = prepared(dirs, 'session-1')
    const second = prepared(dirs, 'session-1')

    expect(second.dir).not.toBe(first.dir)
    expect(second.logFile).not.toBe(first.logFile)
    expect(readdirSync(root)).toHaveLength(2)
    expect(existsSync(first.logFile)).toBe(true)
    expect(existsSync(second.logFile)).toBe(true)
  })

  it('names the directory after a session id that holds dashes itself', () => {
    const sessionId = randomUUID()
    const launch = prepared(dirsOf({ nonce: () => NONCE }), sessionId)
    expect(launch.dir).toBe(join(root, `${sessionId}-app1-${NONCE}`))
  })

  describe('with something already at the place of the launch directory', () => {
    let target: string
    let outside: string
    const prepare = (): ClaudeCliDebugLaunch | null =>
      dirsOf({ nonce: () => NONCE }).prepare('session-1')

    beforeEach(() => {
      mkdirSync(root, { mode: 0o700 })
      target = join(root, `session-1-app1-${NONCE}`)
      outside = join(base, 'outside')
      mkdirSync(outside)
    })

    it('refuses a symbolic link to a directory and writes nothing through it', () => {
      symlinkSync(outside, target)

      expect(prepare()).toBeNull()
      expect(lstatSync(target).isSymbolicLink()).toBe(true)
      expect(readlinkSync(target)).toBe(outside)
      expect(readdirSync(outside)).toEqual([])
    })

    it('refuses a symbolic link to nothing and does not create what it points at', () => {
      const missing = join(outside, 'not-there')
      symlinkSync(missing, target)

      expect(prepare()).toBeNull()
      expect(readlinkSync(target)).toBe(missing)
      expect(existsSync(missing)).toBe(false)
    })

    it('refuses a regular file and leaves it as it was', () => {
      writeFileSync(target, 'planted', { mode: 0o644 })

      expect(prepare()).toBeNull()
      expect(lstatSync(target).isFile()).toBe(true)
      expect(readFileSync(target, 'utf8')).toBe('planted')
      expect(modeOf(target)).toBe(0o644)
    })

    it('refuses a directory with something in it and leaves that as it was', () => {
      mkdirSync(target, { mode: 0o755 })
      chmodSync(target, 0o755)
      writeFileSync(join(target, 'usage.log'), 'planted')

      expect(prepare()).toBeNull()
      expect(modeOf(target)).toBe(0o755)
      expect(readdirSync(target)).toEqual(['usage.log'])
      expect(readFileSync(join(target, 'usage.log'), 'utf8')).toBe('planted')
    })

    it('refuses an empty directory too: nothing that already exists is adopted', () => {
      mkdirSync(target, { mode: 0o700 })

      expect(prepare()).toBeNull()
      expect(readdirSync(target)).toEqual([])
    })

    it('prepares the next launch as usual', () => {
      writeFileSync(target, 'planted')
      expect(prepare()).toBeNull()

      const launch = dirsOf().prepare('session-1')
      expect(launch).not.toBeNull()
      expect(readFileSync(target, 'utf8')).toBe('planted')
    })
  })

  describe('with a root that is not its own', () => {
    it('refuses a root that is a symbolic link and creates nothing behind it', () => {
      const elsewhere = join(base, 'elsewhere')
      mkdirSync(elsewhere, { mode: 0o700 })
      symlinkSync(elsewhere, root)

      expect(dirsOf().prepare('session-1')).toBeNull()
      expect(readlinkSync(root)).toBe(elsewhere)
      expect(readdirSync(elsewhere)).toEqual([])
    })

    it('refuses a root that is a symbolic link to nothing', () => {
      const missing = join(base, 'missing')
      symlinkSync(missing, root)

      expect(dirsOf().prepare('session-1')).toBeNull()
      expect(existsSync(missing)).toBe(false)
    })

    it('refuses a root that is a file', () => {
      writeFileSync(root, 'planted')

      expect(dirsOf().prepare('session-1')).toBeNull()
      expect(readFileSync(root, 'utf8')).toBe('planted')
    })

    it('refuses a root that others can read, and does not change it', () => {
      mkdirSync(root)
      chmodSync(root, 0o755)

      expect(dirsOf().prepare('session-1')).toBeNull()
      expect(modeOf(root)).toBe(0o755)
      expect(readdirSync(root)).toEqual([])
    })
  })

  it('does not make the data directory itself', () => {
    rmSync(dirname(root), { recursive: true })

    expect(dirsOf().prepare('session-1')).toBeNull()
    expect(existsSync(dirname(root))).toBe(false)
  })

  it('has nothing for an id that cannot name a directory, without a root, and on Windows', () => {
    for (const sessionId of ['', '../escape', 'a/b', 'a b', 'x'.repeat(129), '.']) {
      expect(dirsOf().prepare(sessionId)).toBeNull()
    }
    expect(dirsOf({ root: null }).prepare('session-1')).toBeNull()
    expect(dirsOf({ platform: 'win32' }).prepare('session-1')).toBeNull()
    expect(dirsOf({ nonce: () => '../../escape' }).prepare('session-1')).toBeNull()
    expect(existsSync(root)).toBe(false)
  })

  it('leaves nothing of a launch behind when it cannot finish it', () => {
    const real = vi.mocked(fchmodSync).getMockImplementation()!
    // The log is created; the environment file is not.
    vi.mocked(fchmodSync)
      .mockImplementationOnce(real)
      .mockImplementationOnce(() => {
        throw new Error('disk trouble')
      })
    const dirs = dirsOf()

    expect(dirs.prepare('session-1')).toBeNull()
    expect(readdirSync(root)).toEqual([])

    // And the launch after it is prepared as usual.
    expect(dirs.prepare('session-1')).not.toBeNull()
  })

  it('rejects an instance id that could not be told apart in a directory name', () => {
    expect(() => dirsOf({ instanceId: 'app-1' })).toThrow('Invalid instance id')
    expect(() => dirsOf({ instanceId: '' })).toThrow('Invalid instance id')
  })
})

describePosix('the environment file', () => {
  /** What a shell command of the session sees of the debug variable and of the user's own. */
  const PROBE = [
    'printf "shell=%s\\n" "${ANTHROPIC_LOG-<unset>}"',
    'printf "child=%s\\n" "$(printenv ANTHROPIC_LOG || echo "<unset>")"',
    'printf "mine=%s\\n" "${MINE-<unset>}"',
    'printf "child-mine=%s\\n" "$(printenv MINE || echo "<unset>")"'
  ].join('\n')

  /**
   * The two ways the file reaches a shell: sourced, and the way the CLI does it, which puts
   * the text of the file in front of the command, on one command line.
   */
  const WAYS = SHELLS.flatMap((shell) => [
    { shell, way: 'sourced' as const },
    { shell, way: 'in front of a command' as const }
  ])

  const run = (
    { shell, way }: (typeof WAYS)[number],
    envFile: string,
    options: { cwd?: string; path?: string } = {}
  ): { status: number | null; stdout: string; stderr: string } => {
    const script =
      way === 'sourced'
        ? `. "$1" || exit 9\n${PROBE}`
        : `${readFileSync(envFile, 'utf8').trim()}\n: && eval '${PROBE.replace(/'/g, `'\\''`)}'`
    const result = spawnSync(shell, ['-c', script, 'sh', envFile], {
      cwd: options.cwd ?? base,
      env: { PATH: options.path ?? '/usr/bin:/bin', [CLAUDE_CLI_DEBUG_VARIABLE]: 'debug' },
      encoding: 'utf8'
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it('has the shells of the CLI to run in', () => {
    expect(SHELLS.some((shell) => shell === '/bin/bash' || shell === '/bin/zsh')).toBe(true)
  })

  it.each(WAYS)('takes the debug variable out of a $shell that has it set ($way)', (how) => {
    const launch = prepared(dirsOf(), 'session-1')

    expect(run(how, launch.envFile)).toEqual({
      status: 0,
      stdout: 'shell=<unset>\nchild=<unset>\nmine=<unset>\nchild-mine=<unset>\n',
      stderr: ''
    })
  })

  it.each(WAYS)("keeps the effects of the user's own environment file in $shell ($way)", (how) => {
    // A path that a careless quoting would break or run.
    const userDir = join(base, 'my "env" $(touch ran) it\'s `touch ran`')
    mkdirSync(userDir)
    const userEnvFile = join(userDir, 'env file.sh')
    writeFileSync(userEnvFile, 'export MINE="from my file"\n')
    const launch = dirsOf().prepare('session-1', { userEnvFile })

    expect(run(how, launch!.envFile)).toEqual({
      status: 0,
      stdout: 'shell=<unset>\nchild=<unset>\nmine=from my file\nchild-mine=from my file\n',
      stderr: ''
    })
    expect(existsSync(join(base, 'ran'))).toBe(false)
  })

  it.each(WAYS)(
    "takes the debug variable out in $shell even when the user's file sets it ($way)",
    (how) => {
      const userEnvFile = join(base, 'user-env.sh')
      writeFileSync(userEnvFile, 'export ANTHROPIC_LOG=info\nexport MINE=kept\n')
      const launch = dirsOf().prepare('session-1', { userEnvFile })

      expect(run(how, launch!.envFile)).toEqual({
        status: 0,
        stdout: 'shell=<unset>\nchild=<unset>\nmine=kept\nchild-mine=kept\n',
        stderr: ''
      })
    }
  )

  it.each(WAYS)("skips a user's file that does not exist in $shell ($way)", (how) => {
    const launch = dirsOf().prepare('session-1', { userEnvFile: join(base, 'not-there.sh') })

    expect(run(how, launch!.envFile)).toEqual({
      status: 0,
      stdout: 'shell=<unset>\nchild=<unset>\nmine=<unset>\nchild-mine=<unset>\n',
      stderr: ''
    })
  })

  it.each(WAYS)(
    "reads a user's relative path from where the CLI starts in $shell ($way)",
    (how) => {
      const project = join(base, 'project')
      const elsewhere = join(base, 'elsewhere')
      mkdirSync(project)
      mkdirSync(elsewhere)
      writeFileSync(join(project, 'userenv'), 'export MINE=project\n')
      writeFileSync(join(elsewhere, 'userenv'), 'export MINE=elsewhere\n')
      const launch = dirsOf().prepare('session-1', { userEnvFile: 'userenv', cwd: project })

      // A command that runs after a `cd`, with a file of the same name there and on the PATH.
      const result = run(how, launch!.envFile, {
        cwd: elsewhere,
        path: `${elsewhere}:/usr/bin:/bin`
      })
      expect(result.stdout).toContain('mine=project\n')
      expect(result.status).toBe(0)
    }
  )

  it.each(WAYS)(
    'reads a relative path without a place to start from in the working directory, not on the PATH, in $shell ($way)',
    (how) => {
      const cwd = join(base, 'project')
      const onPath = join(base, 'on-path')
      mkdirSync(cwd)
      mkdirSync(onPath)
      writeFileSync(join(cwd, 'userenv'), 'export MINE=working-directory\n')
      writeFileSync(join(onPath, 'userenv'), 'export MINE=path\n')
      const launch = dirsOf().prepare('session-1', { userEnvFile: 'userenv' })

      const result = run(how, launch!.envFile, { cwd, path: `${onPath}:/usr/bin:/bin` })
      expect(result.stdout).toContain('mine=working-directory\n')
      expect(result.status).toBe(0)
    }
  )

  it("is the unset alone, or the user's file and then the unset", () => {
    const alone = claudeCliDebugEnvFileContent()
    expect(alone).toBe('unset ANTHROPIC_LOG\n')
    expect(claudeCliDebugEnvFileContent(null)).toBe(alone)
    expect(claudeCliDebugEnvFileContent('')).toBe(alone)
    expect(claudeCliDebugEnvFileContent('   ')).toBe(alone)

    expect(claudeCliDebugEnvFileContent("/Users/o'brien/env.sh")).toBe(
      "if [ -f '/Users/o'\\''brien/env.sh' ]; then . '/Users/o'\\''brien/env.sh'; fi\n" +
        'unset ANTHROPIC_LOG\n'
    )
    expect(claudeCliDebugEnvFileContent('env/mine.sh', '/work/project')).toContain(
      ". '/work/project/env/mine.sh';"
    )
    expect(claudeCliDebugEnvFileContent('/abs/mine.sh', '/work/project')).toContain(
      ". '/abs/mine.sh';"
    )
    expect(claudeCliDebugEnvFileContent('-rel/env.sh')).toContain(". './-rel/env.sh';")
  })

  it('holds nothing that would end or show up in the command it runs in front of', () => {
    const text = claudeCliDebugEnvFileContent('/Users/me/env.sh')
    expect(text).not.toMatch(/\b(return|exit|echo|printf)\b/)
    expect(text).not.toContain('#')
  })
})

describePosix('ClaudeCliDebugDirs.remove', () => {
  it('deletes the directory with a rotated log and a latest link beside the log', () => {
    const dirs = dirsOf()
    const launch = prepared(dirs, 'session-1')
    const other = prepared(dirs, 'session-2')
    // What the CLI and the log follower leave beside the log.
    writeFileSync(launch.logFile, 'a line\n')
    writeFileSync(`${launch.logFile}.1`, 'rotated by the CLI\n')
    writeFileSync(`${launch.logFile}.old`, 'rotated by the app\n')
    symlinkSync(launch.logFile, join(launch.dir, 'latest'))

    dirs.remove(launch)

    expect(existsSync(launch.dir)).toBe(false)
    expect(readdirSync(root)).toEqual([`session-2-app1-${other.dir.slice(-16)}`])
    expect(existsSync(other.logFile)).toBe(true)
  })

  it('removes a link in the directory without following it', () => {
    const dirs = dirsOf()
    const launch = prepared(dirs, 'session-1')
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    symlinkSync(outside, join(launch.dir, 'latest'))

    dirs.remove(launch)

    expect(existsSync(launch.dir)).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('can be called again, and for a directory that was never there', () => {
    const dirs = dirsOf()
    const launch = prepared(dirs, 'session-1')

    dirs.remove(launch)
    expect(() => dirs.remove(launch)).not.toThrow()
    expect(() => dirs.remove({ dir: join(root, `gone-app1-${NONCE}`) })).not.toThrow()
    expect(() => dirsOf({ root: null }).remove(launch)).not.toThrow()
    expect(readdirSync(root)).toEqual([])
  })

  it('deletes nothing that is not a launch directory of its root', () => {
    const dirs = dirsOf()
    const launch = prepared(dirs, 'session-1')
    const stranger = join(base, 'elsewhere', `session-1-app1-${NONCE}`)
    mkdirSync(stranger, { recursive: true })
    mkdirSync(join(root, 'not-a-launch'))

    dirs.remove({ dir: stranger })
    dirs.remove({ dir: root })
    dirs.remove({ dir: dirname(root) })
    dirs.remove({ dir: join(root, 'not-a-launch') })
    dirs.remove({ dir: join(launch.dir, '..', '..') })
    dirs.remove({ dir: launch.logFile })

    expect(existsSync(stranger)).toBe(true)
    expect(readdirSync(root).sort()).toEqual(['not-a-launch', launch.dir.slice(root.length + 1)])
    expect(existsSync(launch.logFile)).toBe(true)
  })
})

describePosix('ClaudeCliDebugDirs.sweep', () => {
  it('removes the directories of sessions that are not alive and keeps the others', () => {
    const dirs = dirsOf()
    const live = prepared(dirs, 'session-live')
    const dead = prepared(dirs, 'session-dead')
    const deadAgain = prepared(dirs, 'session-dead')
    writeFileSync(`${dead.logFile}.1`, 'rotated\n')
    symlinkSync(dead.logFile, join(dead.dir, 'latest'))

    dirs.sweep(new Set(['session-live', 'session-never-prepared']))

    expect(existsSync(dead.dir)).toBe(false)
    expect(existsSync(deadAgain.dir)).toBe(false)
    expect(readdirSync(live.dir).sort()).toEqual(['env.sh', 'usage.log'])
    expect(readdirSync(root)).toEqual([live.dir.slice(root.length + 1)])
  })

  it('tells session ids apart that start alike or hold dashes', () => {
    const dirs = dirsOf()
    const uuid = randomUUID()
    const live = prepared(dirs, uuid)
    const longer = prepared(dirs, `${uuid}-fork`)
    const shorter = prepared(dirs, uuid.slice(0, 8))
    // A session named like the end of a live one's directory name.
    const tail = prepared(dirs, 'app1')

    dirs.sweep(new Set([uuid]))

    expect(existsSync(live.dir)).toBe(true)
    expect(existsSync(longer.dir)).toBe(false)
    expect(existsSync(shorter.dir)).toBe(false)
    expect(existsSync(tail.dir)).toBe(false)
  })

  it('ignores what is in the root and is not a launch directory', () => {
    const dirs = dirsOf()
    const dead = prepared(dirs, 'session-dead')
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    writeFileSync(join(root, 'notes.txt'), 'unrelated')
    writeFileSync(join(root, '.DS_Store'), '')
    mkdirSync(join(root, 'some-directory'))
    writeFileSync(join(root, 'some-directory', 'file'), 'unrelated')
    mkdirSync(join(root, 'session-dead'))
    // Named like launch directories, but a file and a link: not made by prepare.
    writeFileSync(join(root, `session-dead-app1-${NONCE}`), 'a file')
    symlinkSync(outside, join(root, 'session-dead-app1-fedcba9876543210'))

    dirs.sweep(new Set())

    expect(existsSync(dead.dir)).toBe(false)
    expect(readdirSync(root).sort()).toEqual(
      [
        '.DS_Store',
        'notes.txt',
        'session-dead',
        `session-dead-app1-${NONCE}`,
        'session-dead-app1-fedcba9876543210',
        'some-directory'
      ].sort()
    )
    expect(readFileSync(join(root, 'some-directory', 'file'), 'utf8')).toBe('unrelated')
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('leaves the directories of another app process to it while that one runs', () => {
    const mine = dirsOf()
    const theirs = dirsOf({ instanceId: 'app2' })
    const theirLaunch = prepared(theirs, 'session-of-theirs')
    aliveInstances.add('app2')

    mine.sweep(new Set())
    expect(existsSync(theirLaunch.logFile)).toBe(true)

    // That process is gone: whatever its sessions were, nothing is reading these any more,
    // also when this process has a live session of the same id.
    aliveInstances.delete('app2')
    const sameId = prepared(theirs, 'session-live')
    const own = prepared(mine, 'session-live')
    mine.sweep(new Set(['session-live', 'session-of-theirs']))

    expect(existsSync(theirLaunch.dir)).toBe(false)
    expect(existsSync(sameId.dir)).toBe(false)
    expect(existsSync(own.logFile)).toBe(true)
  })

  it('by default takes an app process for running when its pid is', () => {
    const mine = new ClaudeCliDebugDirs({ root })
    // This test's parent is running; no process has the highest pid a directory name can hold.
    const running = prepared(
      new ClaudeCliDebugDirs({ root, instanceId: String(process.ppid) }),
      'session-1'
    )
    const gone = prepared(new ClaudeCliDebugDirs({ root, instanceId: '2147483646' }), 'session-1')
    const notAPid = prepared(new ClaudeCliDebugDirs({ root, instanceId: 'app2' }), 'session-1')
    const own = prepared(mine, 'session-1')
    expect(own.dir).toContain(`session-1-${process.pid}-`)

    mine.sweep(new Set(['session-1']))

    expect(existsSync(running.dir)).toBe(true)
    expect(existsSync(gone.dir)).toBe(false)
    expect(existsSync(notAPid.dir)).toBe(false)
    expect(existsSync(own.dir)).toBe(true)
  })

  it.skipIf(process.getuid?.() === 0)('goes on past a directory it cannot delete', () => {
    const dirs = dirsOf({
      nonce: (() => {
        const nonces = ['000000000000000a', '000000000000000b']
        return () => nonces.shift()!
      })()
    })
    const stuck = prepared(dirs, 'session-a')
    const next = prepared(dirs, 'session-b')
    chmodSync(stuck.dir, 0o500)
    try {
      expect(() => dirs.sweep(new Set())).not.toThrow()
      expect(existsSync(stuck.dir)).toBe(true)
      expect(existsSync(next.dir)).toBe(false)
    } finally {
      chmodSync(stuck.dir, 0o700)
    }
  })

  it('does nothing without a root, and deletes nothing through a root that is a link', () => {
    expect(() => dirsOf().sweep(new Set())).not.toThrow()
    expect(existsSync(root)).toBe(false)
    expect(() => dirsOf({ root: null }).sweep(new Set())).not.toThrow()

    const elsewhere = join(base, 'elsewhere')
    const launch = prepared(dirsOf({ root: elsewhere }), 'session-dead')
    symlinkSync(elsewhere, root)
    dirsOf().sweep(new Set())
    expect(existsSync(launch.logFile)).toBe(true)
  })
})

describe('the debug-log directories of the app', () => {
  const savedDbPath = process.env.HIVE_SERVER_DB_PATH

  afterEach(() => {
    if (savedDbPath === undefined) delete process.env.HIVE_SERVER_DB_PATH
    else process.env.HIVE_SERVER_DB_PATH = savedDbPath
  })

  it('are beside the database', () => {
    process.env.HIVE_SERVER_DB_PATH = join(base, 'data', 'hive.db')
    expect(getClaudeCliDebugRootDir()).toBe(join(base, 'data', 'claude-cli-debug'))
  })

  it('are nowhere in a test run: nothing touches the data of the developer', () => {
    const dirs = claudeCliDebugDirs()
    expect(claudeCliDebugDirs()).toBe(dirs)
    expect(dirs.prepare('session-1')).toBeNull()
    expect(() => dirs.sweep(new Set())).not.toThrow()
  })
})
