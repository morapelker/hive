import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DETACHED_HOST_ARGV0,
  DETACHED_HOST_SCRIPT,
  SHELL_COMMAND_ARGV0,
  SHELL_COMMAND_WRAPPER
} from '../shell-command-scripts'
import { buildDetachedHostSpawn, buildShellCommandPtySpawn } from '../shell-command-spawner'

describe('buildShellCommandPtySpawn', () => {
  const savedShell = process.env.SHELL

  afterEach(() => {
    if (savedShell === undefined) delete process.env.SHELL
    else process.env.SHELL = savedShell
  })

  const steps = ['echo a', 'cd sub && ls']
  const pairs = ['echo a', 'echo a', 'cd sub && ls', 'cd sub && ls']

  it('zsh gets -ilc and (label, step) pairs after the constant wrapper and argv0', () => {
    expect(buildShellCommandPtySpawn(steps, { shell: '/bin/zsh', platform: 'darwin' })).toEqual({
      command: '/bin/zsh',
      args: ['-ilc', SHELL_COMMAND_WRAPPER, 'hive-shell-command', ...pairs]
    })
  })

  it('bash gets -ic, wherever it is installed', () => {
    expect(buildShellCommandPtySpawn(steps, { shell: '/bin/bash', platform: 'darwin' })).toEqual({
      command: '/bin/bash',
      args: ['-ic', SHELL_COMMAND_WRAPPER, SHELL_COMMAND_ARGV0, ...pairs]
    })
    expect(
      buildShellCommandPtySpawn(steps, { shell: '/opt/homebrew/bin/bash', platform: 'darwin' })
    ).toEqual({
      command: '/opt/homebrew/bin/bash',
      args: ['-ic', SHELL_COMMAND_WRAPPER, SHELL_COMMAND_ARGV0, ...pairs]
    })
  })

  it('dash never gets -i', () => {
    expect(buildShellCommandPtySpawn(steps, { shell: '/bin/dash', platform: 'linux' })).toEqual({
      command: '/bin/dash',
      args: ['-c', SHELL_COMMAND_WRAPPER, SHELL_COMMAND_ARGV0, ...pairs]
    })
  })

  it('ksh and sh get -ilc', () => {
    for (const shell of ['/bin/ksh', '/bin/sh']) {
      expect(buildShellCommandPtySpawn(steps, { shell, platform: 'darwin' })).toEqual({
        command: shell,
        args: ['-ilc', SHELL_COMMAND_WRAPPER, SHELL_COMMAND_ARGV0, ...pairs]
      })
    }
  })

  it('fish, tcsh and unknown shells fall back to the platform POSIX shell', () => {
    for (const shell of ['/opt/homebrew/bin/fish', '/bin/tcsh', '/usr/local/bin/nu', 'weird']) {
      expect(buildShellCommandPtySpawn(steps, { shell, platform: 'darwin' })).toEqual({
        command: '/bin/zsh',
        args: ['-ilc', SHELL_COMMAND_WRAPPER, SHELL_COMMAND_ARGV0, ...pairs]
      })
      expect(buildShellCommandPtySpawn(steps, { shell, platform: 'linux' })).toEqual({
        command: '/bin/bash',
        args: ['-ic', SHELL_COMMAND_WRAPPER, SHELL_COMMAND_ARGV0, ...pairs]
      })
    }
  })

  it('defaults to $SHELL, then to the platform fallback', () => {
    process.env.SHELL = '/bin/ksh'
    expect(buildShellCommandPtySpawn(steps, { platform: 'darwin' }).command).toBe('/bin/ksh')
    delete process.env.SHELL
    expect(buildShellCommandPtySpawn(steps, { platform: 'darwin' }).command).toBe('/bin/zsh')
    expect(buildShellCommandPtySpawn(steps, { platform: 'linux' }).command).toBe('/bin/bash')
  })

  it('passes a hostile step verbatim as exactly one argv element', () => {
    const hostile = '-rf "$(touch /tmp/nope)" \'; `id` && $HOME\nsecond line'
    const { args } = buildShellCommandPtySpawn(['echo ok', hostile], {
      shell: '/bin/zsh',
      platform: 'darwin'
    })
    expect(args.filter((arg) => arg === hostile)).toHaveLength(1)
    expect(args).toHaveLength(3 + 4)
    expect(args[6]).toBe(hostile)
    // The label is the same text with the newline collapsed: still one element.
    expect(args[5]).toBe('-rf "$(touch /tmp/nope)" \'; `id` && $HOME second line')
    expect(args[1]).toBe(SHELL_COMMAND_WRAPPER)
    expect(SHELL_COMMAND_WRAPPER).not.toContain('touch /tmp/nope')
    expect(DETACHED_HOST_SCRIPT).not.toContain('touch /tmp/nope')
  })

  it('truncates the label of a long step to 120 code points and keeps the full step', () => {
    const long = 'echo ' + '😀'.repeat(295)
    const { args } = buildShellCommandPtySpawn([long], { shell: '/bin/zsh', platform: 'darwin' })
    const label = args[3]
    expect(Array.from(label)).toHaveLength(120)
    expect(label.endsWith('…')).toBe(true)
    expect(label.startsWith('echo 😀')).toBe(true)
    expect(args[4]).toBe(long)
    expect(Array.from(args[4])).toHaveLength(300)
  })

  it('throws on Windows, on no steps and on a NUL character', () => {
    expect(() => buildShellCommandPtySpawn(['echo a'], { platform: 'win32' })).toThrow(
      'Shell commands are not supported on Windows'
    )
    expect(() => buildShellCommandPtySpawn([], { platform: 'darwin' })).toThrow(
      'Shell command has no runnable lines'
    )
    expect(() =>
      buildShellCommandPtySpawn(['echo a', 'echo b' + String.fromCharCode(0)], {
        platform: 'darwin'
      })
    ).toThrow('Shell command contains an invalid character')
  })
})

describe('buildDetachedHostSpawn', () => {
  it('wraps the in-app spawn in the constant host script', () => {
    const inner = buildShellCommandPtySpawn(['echo a', 'echo b'], {
      shell: '/bin/bash',
      platform: 'darwin'
    })
    const runDir = '/tmp/some dir/with $pecial "chars"'
    expect(buildDetachedHostSpawn(inner, { runDir, cols: 100, rows: 30 })).toEqual({
      command: '/bin/sh',
      args: [
        '-c',
        DETACHED_HOST_SCRIPT,
        'hive-shell-host',
        runDir,
        '100',
        '30',
        '/bin/bash',
        '-ic',
        SHELL_COMMAND_WRAPPER,
        'hive-shell-command',
        'echo a',
        'echo a',
        'echo b',
        'echo b'
      ]
    })
    expect(DETACHED_HOST_ARGV0).toBe('hive-shell-host')
  })
})

/**
 * The real wrapper, run WITHOUT a PTY. Exit codes and skip behaviour are identical to
 * the PTY runs for these vectors; stderr is noisy without a tty (job-control warnings,
 * rc-file output), so only status and stdout are asserted.
 */
interface WrapperShell {
  name: string
  shell: string
  flags: string
}

const WRAPPER_SHELLS: WrapperShell[] = [
  ...(process.platform === 'darwin'
    ? [{ name: 'zsh -ilc', shell: '/bin/zsh', flags: '-ilc' }]
    : []),
  { name: 'bash -ic', shell: '/bin/bash', flags: '-ic' },
  { name: 'sh -c', shell: '/bin/sh', flags: '-c' }
].filter((entry) => existsSync(entry.shell))

describe.skipIf(process.platform === 'win32')('SHELL_COMMAND_WRAPPER without a PTY', () => {
  let workDir: string

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'shellcmd-wrapper-'))
    mkdirSync(join(workDir, 'subdir'))
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  function run(
    target: WrapperShell,
    steps: string[],
    extraEnv: Record<string, string> = {}
  ): { status: number | null; stdout: string; lines: string[] } {
    const built = buildShellCommandPtySpawn(steps, { shell: target.shell })
    // An empty HOME keeps the developer's rc files (-ilc / -ic source them) out of the run.
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: workDir,
      ZDOTDIR: workDir,
      ...extraEnv
    }
    if (!('HIVE_SHELL_RUN_DIR' in extraEnv)) delete env.HIVE_SHELL_RUN_DIR
    const result = spawnSync(target.shell, [target.flags, ...built.args.slice(1)], {
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 20000
    })
    const stdout = result.stdout ?? ''
    return { status: result.status, stdout, lines: stdout.split(/\r?\n/) }
  }

  describe.each(WRAPPER_SHELLS)('$name', (target) => {
    it('runs every step and exits 0', { timeout: 30000 }, () => {
      const result = run(target, ['echo one', 'echo two', 'echo three'])
      expect(result.status).toBe(0)
      expect(result.lines).toEqual(expect.arrayContaining(['one', 'two', 'three']))
      expect(result.stdout).toContain('[1/3]')
      expect(result.stdout).toContain('[3/3]')
      expect(result.stdout).toContain('[hive] Succeeded')
    })

    it('stops at the first failing step with its status', { timeout: 30000 }, () => {
      const result = run(target, ['echo one', 'false', 'echo NOTRUN'])
      expect(result.status).toBe(1)
      expect(result.lines).toContain('one')
      expect(result.lines).not.toContain('NOTRUN')
      expect(result.stdout).toContain('[hive] Failed at step 2/3')
    })

    it('reports the exit code of a failing child', { timeout: 30000 }, () => {
      const result = run(target, ['echo one', "sh -c 'exit 3'", 'echo NOTRUN'])
      expect(result.status).toBe(3)
      expect(result.lines).not.toContain('NOTRUN')
    })

    it('an unknown command fails with 127', { timeout: 30000 }, () => {
      const result = run(target, ['echo one', 'nosuchcmd_tedooo_xyz', 'echo NOTRUN'])
      expect(result.status).toBe(127)
      expect(result.lines).not.toContain('NOTRUN')
    })

    it('a step starting with a dash is a command, not an eval option', { timeout: 30000 }, () => {
      const result = run(target, ['-nosuch_tedooo', 'echo NOTRUN'])
      expect(result.status).toBe(127)
      expect(result.lines).not.toContain('NOTRUN')
    })

    it('cd, export and shell variables persist across steps', { timeout: 30000 }, () => {
      const result = run(target, [
        'cd subdir',
        'export FOO=1',
        'BAR=two',
        'test "$(basename "$PWD")/$FOO/$BAR" = subdir/1/two && echo STATE-OK'
      ])
      expect(result.status).toBe(0)
      expect(result.lines).toContain('STATE-OK')
    })

    it('a step that fails to parse stops the run (the bash 3.2 case)', { timeout: 30000 }, () => {
      const result = run(target, ['echo one', 'if then (', 'echo NOTRUN'])
      expect(result.status).not.toBe(0)
      expect(result.status).not.toBeNull()
      expect(result.lines).not.toContain('NOTRUN')
    })

    it('a literal exit ends the run with that status', { timeout: 30000 }, () => {
      const result = run(target, ['echo one', 'exit 7', 'echo NOTRUN'])
      expect(result.status).toBe(7)
      expect(result.lines).not.toContain('NOTRUN')
      expect(result.stdout).toContain('[hive] Failed at step 2/3')
    })

    it('break and continue cannot hijack the step loop', { timeout: 30000 }, () => {
      for (const keyword of ['break', 'continue']) {
        const result = run(target, ['echo one', keyword, 'echo NOTRUN'])
        expect(result.status).toBe(2)
        expect(result.lines).not.toContain('NOTRUN')
      }
    })

    it('a step cannot clobber the wrapper state', { timeout: 30000 }, () => {
      const result = run(target, [
        'i=9; n=9; rc=9; step=zzz; arg=q; total=0; done=1',
        'echo two',
        'sh -c "exit 4"',
        'echo NOTRUN'
      ])
      expect(result.status).toBe(4)
      expect(result.lines).toContain('two')
      expect(result.lines).not.toContain('NOTRUN')
      expect(result.stdout).toContain('[hive] Failed at step 3/4')
    })

    it('writes no inner.exit when HIVE_SHELL_RUN_DIR is unset', { timeout: 30000 }, () => {
      const result = run(target, ['echo one', 'sh -c "exit 5"'])
      expect(result.status).toBe(5)
      expect(readdirSync(workDir).sort()).toEqual(['subdir'])
      expect(readdirSync(join(workDir, 'subdir'))).toEqual([])
    })

    it('records its status in inner.exit when the host set the run dir', { timeout: 30000 }, () => {
      const runDir = mkdtempSync(join(tmpdir(), 'shellcmd-wrapper-run-'))
      try {
        const result = run(
          target,
          ['echo one', 'sh -c "exit 6"', 'echo "dir=[$HIVE_SHELL_RUN_DIR]"'],
          {
            HIVE_SHELL_RUN_DIR: runDir
          }
        )
        expect(result.status).toBe(6)
        expect(readFileSync(join(runDir, 'inner.exit'), 'utf8')).toBe('6\n')

        // The variable is consumed before the first step: steps never see it.
        const ok = run(target, ['echo "dir=[$HIVE_SHELL_RUN_DIR]"'], {
          HIVE_SHELL_RUN_DIR: runDir
        })
        expect(ok.status).toBe(0)
        expect(ok.lines).toContain('dir=[]')
        expect(readFileSync(join(runDir, 'inner.exit'), 'utf8')).toBe('0\n')
      } finally {
        rmSync(runDir, { recursive: true, force: true })
      }
    })
  })
})
