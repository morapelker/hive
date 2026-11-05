import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { spawnCLI } from '../title-generation-shared'

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor<T>(read: () => T | null, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// A real process tree: what a custom cleanup provider looks like (a shell
// wrapper that starts the CLI). POSIX process groups only.
describe.skipIf(process.platform === 'win32')('spawnCLI abort (VOICE-08 skip)', () => {
  let dir: string | null = null

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('stops the wrapper and the process it started when the signal aborts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'spawn-cli-abort-'))
    const pidFile = join(dir, 'child.pid')
    const abort = new AbortController()
    const run = spawnCLI(
      '/bin/sh',
      ['-c', `sleep 30 & echo $! > '${pidFile}'; wait`],
      '',
      60_000,
      undefined,
      process.env,
      abort.signal
    )
    const settled = run.then(
      () => 'resolved',
      () => 'rejected'
    )
    const childPid = await waitFor(() => {
      try {
        const pid = Number(readFileSync(pidFile, 'utf8').trim())
        return pid > 0 ? pid : null
      } catch {
        return null
      }
    }, 5_000)
    expect(isRunning(childPid)).toBe(true)

    abort.abort()

    // SIGTERM to the whole group right away; nothing of the tree is left behind.
    await waitFor(() => (isRunning(childPid) ? null : true), 4_000)
    expect(await settled).toBe('rejected')
  }, 15_000)

  it('runs as before without a signal', async () => {
    await expect(spawnCLI('/bin/sh', ['-c', 'cat'], 'hello', 10_000)).resolves.toBe('hello')
  })
})
