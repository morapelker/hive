import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetClaudeBinaryVersionsForTests,
  getClaudeBinaryVersion,
  logClaudeBinaryVersion
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
