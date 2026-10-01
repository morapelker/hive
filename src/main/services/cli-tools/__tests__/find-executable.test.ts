import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile: childProcessMocks.execFile }))

import { findExecutable, knownBinDirs, parseVersionOutput, probeVersion } from '../find-executable'

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void

/** Script the mocked execFile: each handler gets (file, args) and returns stdout or throws. */
function scriptExecFile(handler: (file: string, args: string[]) => string): void {
  childProcessMocks.execFile.mockImplementation(
    (file: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      try {
        callback(null, handler(file, args), '')
      } catch (error) {
        callback(error as Error, (error as { stdout?: string }).stdout ?? '', '')
      }
    }
  )
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'find-exec-test-'))
})

afterEach(async () => {
  vi.clearAllMocks()
  await rm(home, { recursive: true, force: true })
})

describe('parseVersionOutput', () => {
  it('reads bare, prefixed and v-prefixed versions from the first line', () => {
    expect(parseVersionOutput('0.1.19\n')).toBe('0.1.19')
    expect(parseVersionOutput('tcu 0.2.0 on macOS')).toBe('0.2.0')
    expect(parseVersionOutput('v1.2.3-rc.1\nmore')).toBe('1.2.3-rc.1')
    expect(parseVersionOutput('no version here')).toBeNull()
    expect(parseVersionOutput('')).toBeNull()
  })
})

describe('knownBinDirs', () => {
  it('lists the user-level bin directories installers use', () => {
    expect(knownBinDirs('/Users/me')).toEqual([
      '/Users/me/.local/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin'
    ])
  })
})

describe('findExecutable', () => {
  it('returns the first existing executable `which` prints', async () => {
    const bin = join(home, 'bin', 'tool')
    await mkdir(join(home, 'bin'), { recursive: true })
    await writeFile(bin, '#!/bin/sh\n')
    await chmod(bin, 0o755)
    scriptExecFile((file) => {
      if (file === 'which') return `/nonexistent/tool\n${bin}\n`
      throw new Error('unexpected')
    })

    expect(await findExecutable('tool', { home })).toBe(bin)
  })

  it('falls back to the login shell, then to known bin dirs', async () => {
    const localBin = join(home, '.local', 'bin', 'tool')
    await mkdir(join(home, '.local', 'bin'), { recursive: true })
    await writeFile(localBin, '#!/bin/sh\n')
    await chmod(localBin, 0o755)
    const calls: string[] = []
    scriptExecFile((file, args) => {
      calls.push(`${file} ${args.join(' ')}`)
      throw new Error('not found')
    })

    expect(await findExecutable('tool', { home, env: { SHELL: '/bin/zsh', PATH: '' } })).toBe(
      localBin
    )
    expect(calls).toEqual(['which tool', '/bin/zsh -lc command -v tool'])
  })

  it('prefers .cmd/.exe shims over extensionless ones on Windows', async () => {
    const plain = join(home, 'tool')
    const cmd = join(home, 'tool.cmd')
    await writeFile(plain, '#!/bin/sh\n')
    await writeFile(cmd, '@echo off\n')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      scriptExecFile((file) => {
        if (file === 'where') return `${plain}\r\n${cmd}\r\n`
        throw new Error('unexpected')
      })
      expect(await findExecutable('tool', { home })).toBe(cmd)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('returns null when nothing is found anywhere', async () => {
    scriptExecFile(() => {
      throw new Error('not found')
    })
    expect(await findExecutable('nothing', { home })).toBeNull()
  })

  it('ignores a login shell result without a path (an alias or builtin)', async () => {
    scriptExecFile((file) => {
      if (file === 'which') throw new Error('not found')
      return 'tool\n'
    })
    expect(await findExecutable('tool', { home, env: { SHELL: '/bin/zsh' } })).toBeNull()
  })
})

describe('probeVersion', () => {
  it('parses the version from stdout', async () => {
    scriptExecFile((file, args) => {
      expect(file).toBe('/bin/tool')
      expect(args).toEqual(['--version'])
      return '0.1.19\n'
    })
    expect(await probeVersion('/bin/tool')).toEqual({ version: '0.1.19', timedOut: false })
  })

  it('reports a timeout separately from a missing version', async () => {
    childProcessMocks.execFile.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, callback: ExecCallback) => {
        const error = Object.assign(new Error('killed'), { killed: true, code: null })
        callback(error, '', '')
      }
    )
    const probe = await probeVersion('/bin/tool')
    expect(probe.version).toBeNull()
    expect(probe.timedOut).toBe(true)
  })

  it('still takes a version printed by a tool that exits non-zero', async () => {
    childProcessMocks.execFile.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, callback: ExecCallback) => {
        callback(Object.assign(new Error('exit 1'), { code: 1 }), 'tool 2.0.0\n', '')
      }
    )
    const probe = await probeVersion('/bin/tool')
    expect(probe).toMatchObject({ version: '2.0.0', timedOut: false })
  })

  it('sends NO_UPDATE_NOTIFIER so npm wrappers do not phone home', async () => {
    let seenEnv: NodeJS.ProcessEnv = {}
    childProcessMocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        opts: { env: NodeJS.ProcessEnv },
        callback: ExecCallback
      ) => {
        seenEnv = opts.env
        callback(null, '1.0.0', '')
      }
    )
    await probeVersion('/bin/tool', { env: { PATH: '/x' } })
    expect(seenEnv).toEqual({ PATH: '/x', NO_UPDATE_NOTIFIER: '1' })
  })
})
