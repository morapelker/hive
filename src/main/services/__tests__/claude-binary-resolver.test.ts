import { afterEach, describe, expect, it, vi } from 'vitest'
import { logClaudeBinaryVersion } from '../claude-binary-resolver'

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
