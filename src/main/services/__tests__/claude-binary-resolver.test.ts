import { mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetClaudeBinaryVersionsForTests,
  getClaudeBinaryVersion,
  logClaudeBinaryVersion,
  readClaudeBinaryVersion
} from '../claude-binary-resolver'

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: childProcessMocks.execFile,
  execFileSync: childProcessMocks.execFileSync
}))

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => loggerMocks)
}))

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

function lastExecFileCallback(): ExecFileCallback {
  const call = childProcessMocks.execFile.mock.calls.at(-1)
  return call?.at(-1) as ExecFileCallback
}

describe('logClaudeBinaryVersion', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('logs the claude --version output once resolved', () => {
    logClaudeBinaryVersion('/usr/local/bin/claude-a')

    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      '/usr/local/bin/claude-a',
      ['--version'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function)
    )
    lastExecFileCallback()(null, '2.1.0 (Claude Code)\n', '')
    expect(loggerMocks.info).toHaveBeenCalledWith('Claude CLI version', {
      path: '/usr/local/bin/claude-a',
      version: '2.1.0 (Claude Code)'
    })
  })

  it('only checks each binary path once', () => {
    logClaudeBinaryVersion('/usr/local/bin/claude-b')
    lastExecFileCallback()(null, '2.1.0\n', '')
    logClaudeBinaryVersion('/usr/local/bin/claude-b')

    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1)
  })

  it('warns instead of throwing when the version check fails', () => {
    logClaudeBinaryVersion('/usr/local/bin/claude-c')
    lastExecFileCallback()(new Error('spawn ENOENT'), '', '')

    expect(loggerMocks.warn).toHaveBeenCalledWith('Could not determine Claude CLI version', {
      path: '/usr/local/bin/claude-c',
      error: 'spawn ENOENT'
    })
  })
})

describe('getClaudeBinaryVersion', () => {
  afterEach(() => {
    __resetClaudeBinaryVersionsForTests()
    vi.clearAllMocks()
  })

  it('remembers the version a binary reported, by its path, without running anything', () => {
    expect(getClaudeBinaryVersion('/opt/claude')).toBeNull()

    logClaudeBinaryVersion('/opt/claude')
    // Asked, not answered yet.
    expect(getClaudeBinaryVersion('/opt/claude')).toBeNull()
    lastExecFileCallback()(null, '2.1.326 (Claude Code)\n', '')

    expect(getClaudeBinaryVersion('/opt/claude')).toBe('2.1.326')
    expect(getClaudeBinaryVersion('/opt/other-claude')).toBeNull()
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1)
  })

  it('keeps a pre-release suffix and falls back to the first line of output without a number', () => {
    logClaudeBinaryVersion('/opt/claude-next')
    lastExecFileCallback()(null, '2.2.0-beta.3 (Claude Code)\n', '')
    logClaudeBinaryVersion('/opt/claude-odd')
    lastExecFileCallback()(null, 'development build\nsecond line\n', '')

    expect(getClaudeBinaryVersion('/opt/claude-next')).toBe('2.2.0-beta.3')
    expect(getClaudeBinaryVersion('/opt/claude-odd')).toBe('development build')
  })

  it('knows no version for a binary that could not be asked or said nothing', () => {
    logClaudeBinaryVersion('/opt/claude-broken')
    lastExecFileCallback()(new Error('spawn ENOENT'), '', '')
    logClaudeBinaryVersion('/opt/claude-silent')
    lastExecFileCallback()(null, '\n', '')

    expect(getClaudeBinaryVersion('/opt/claude-broken')).toBeNull()
    expect(getClaudeBinaryVersion('/opt/claude-silent')).toBeNull()
  })
})

describe('readClaudeBinaryVersion', () => {
  let dir: string
  /** The path the app resolves: a link to the installed version, as the CLI's installer leaves it. */
  let binary: string

  /** Install `version` and point the path at it, as an update of the CLI does. */
  const install = (version: string): string => {
    const target = join(dir, `claude-${version}`)
    writeFileSync(target, `#!/bin/sh\necho ${version}\n`)
    rmSync(binary, { force: true })
    symlinkSync(target, binary)
    return target
  }

  /** Let the file lookups finish and answer the `--version` that was started, if one was. */
  const answer = async (stdout: string, error: Error | null = null): Promise<void> => {
    await vi.waitFor(() => expect(childProcessMocks.execFile).toHaveBeenCalled())
    lastExecFileCallback()(error, stdout, '')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-binary-version-'))
    binary = join(dir, 'claude')
  })

  afterEach(() => {
    __resetClaudeBinaryVersionsForTests()
    vi.clearAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('asks the binary once and answers from what it said while the file is the same', async () => {
    install('2.1.326')

    const first = readClaudeBinaryVersion(binary)
    await answer('2.1.326 (Claude Code)\n')

    expect(await first).toBe('2.1.326')
    expect(await readClaudeBinaryVersion(binary)).toBe('2.1.326')
    expect(await readClaudeBinaryVersion(binary)).toBe('2.1.326')
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1)
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      binary,
      ['--version'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function)
    )
    // And it is what the lookup that runs nothing answers from then on.
    expect(getClaudeBinaryVersion(binary)).toBe('2.1.326')
  })

  it('asks once for callers that ask at the same time', async () => {
    install('2.1.326')

    const both = Promise.all([readClaudeBinaryVersion(binary), readClaudeBinaryVersion(binary)])
    await answer('2.1.326 (Claude Code)\n')

    expect(await both).toEqual(['2.1.326', '2.1.326'])
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1)
  })

  it('asks again when the path leads to another file: the CLI updated itself', async () => {
    install('2.1.326')
    const before = readClaudeBinaryVersion(binary)
    await answer('2.1.326 (Claude Code)\n')
    expect(await before).toBe('2.1.326')
    childProcessMocks.execFile.mockClear()

    install('2.1.327')
    const after = readClaudeBinaryVersion(binary)
    await answer('2.1.327 (Claude Code)\n')

    expect(await after).toBe('2.1.327')
    expect(getClaudeBinaryVersion(binary)).toBe('2.1.327')
    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1)
  })

  it('asks again when the file itself was replaced in place', async () => {
    const target = install('2.1.326')
    const before = readClaudeBinaryVersion(binary)
    await answer('2.1.326 (Claude Code)\n')
    expect(await before).toBe('2.1.326')
    childProcessMocks.execFile.mockClear()

    writeFileSync(target, '#!/bin/sh\necho 2.1.327 with more in it\n')
    utimesSync(target, new Date(), new Date(Date.now() + 60_000))
    const after = readClaudeBinaryVersion(binary)
    await answer('2.1.327 (Claude Code)\n')

    expect(await after).toBe('2.1.327')
  })

  it('knows no version when the binary cannot be asked, and asks again the next time', async () => {
    install('2.1.326')

    const failed = readClaudeBinaryVersion(binary)
    await answer('', new Error('spawn EACCES'))
    expect(await failed).toBeNull()
    expect(getClaudeBinaryVersion(binary)).toBeNull()
    expect(loggerMocks.warn).toHaveBeenCalledWith('Could not determine Claude CLI version', {
      path: binary,
      error: 'spawn EACCES'
    })
    childProcessMocks.execFile.mockClear()

    const again = readClaudeBinaryVersion(binary)
    await answer('2.1.326 (Claude Code)\n')
    expect(await again).toBe('2.1.326')
  })

  it('knows no version for a path that leads nowhere, without running anything', async () => {
    install('2.1.326')
    unlinkSync(join(dir, 'claude-2.1.326'))

    expect(await readClaudeBinaryVersion(binary)).toBeNull()
    expect(await readClaudeBinaryVersion(join(dir, 'no-such-claude'))).toBeNull()
    expect(childProcessMocks.execFile).not.toHaveBeenCalled()
  })
})
