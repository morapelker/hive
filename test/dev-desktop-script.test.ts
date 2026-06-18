import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, test, vi } from 'vitest'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('dev desktop script', () => {
  test('defaults HIVE_SERVER_ENTRY_PATH to the copied dev server bundle', async () => {
    const { createDevDesktopEnv } = await import('../scripts/dev-desktop.mjs')

    const env = createDevDesktopEnv({
      cwd: '/repo/hive',
      env: { PATH: '/bin' }
    })

    expect(env.HIVE_SERVER_ENTRY_PATH).toBe(resolve('/repo/hive/.dev-server/server.js'))
  })

  test('preserves an explicit HIVE_SERVER_ENTRY_PATH', async () => {
    const { createDevDesktopEnv } = await import('../scripts/dev-desktop.mjs')

    const env = createDevDesktopEnv({
      cwd: '/repo/hive',
      env: {
        PATH: '/bin',
        HIVE_SERVER_ENTRY_PATH: '/custom/server.js'
      }
    })

    expect(env.HIVE_SERVER_ENTRY_PATH).toBe('/custom/server.js')
  })

  test('does not pass ELECTRON_RUN_AS_NODE into electron-vite dev', async () => {
    const { createDevDesktopEnv } = await import('../scripts/dev-desktop.mjs')

    const env = createDevDesktopEnv({
      cwd: '/repo/hive',
      env: {
        PATH: '/bin',
        ELECTRON_RUN_AS_NODE: '1'
      }
    })

    expect(env.PATH).toBe('/bin')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  test('defaults headless server env for plain Node server mode', async () => {
    const { createDevHeadlessEnv } = await import('../scripts/dev-desktop.mjs')

    const env = createDevHeadlessEnv({
      env: {
        PATH: '/bin',
        ELECTRON_RUN_AS_NODE: '1'
      }
    })

    expect(env.HIVE_HEADLESS).toBe('1')
    expect(env.HIVE_SERVER_MODE).toBe('browser')
    expect(env.HIVE_SERVER_HOST).toBe('127.0.0.1')
    expect(env.HIVE_SERVER_PORT).toBe('3773')
    expect(env.HIVE_SERVER_REQUIRE_AUTH).toBe('true')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  test('preserves explicit headless server env overrides', async () => {
    const { createDevHeadlessEnv } = await import('../scripts/dev-desktop.mjs')

    const env = createDevHeadlessEnv({
      env: {
        HIVE_SERVER_MODE: 'desktop',
        HIVE_SERVER_HOST: '0.0.0.0',
        HIVE_SERVER_PORT: '0',
        HIVE_SERVER_REQUIRE_AUTH: 'false'
      }
    })

    expect(env.HIVE_HEADLESS).toBe('1')
    expect(env.HIVE_SERVER_MODE).toBe('desktop')
    expect(env.HIVE_SERVER_HOST).toBe('0.0.0.0')
    expect(env.HIVE_SERVER_PORT).toBe('0')
    expect(env.HIVE_SERVER_REQUIRE_AUTH).toBe('false')
  })

  test('routes interactive TTY Ctrl-C bytes through launcher shutdown', async () => {
    const { installInteractiveInterruptHandler } = await import('../scripts/dev-desktop.mjs')
    const stdin = new FakeTtyStdin()
    const shutdownHandler = vi.fn()

    const dispose = installInteractiveInterruptHandler({ stdin, shutdownHandler })

    stdin.emit('data', Buffer.from([0x03]))

    expect(stdin.resume).toHaveBeenCalled()
    expect(stdin.setRawMode).toHaveBeenCalledWith(true)
    expect(shutdownHandler).toHaveBeenCalledTimes(1)

    dispose()

    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false)
  })

  test('ignores TTY read errors while interactive interrupt handling is installed', async () => {
    const { installInteractiveInterruptHandler } = await import('../scripts/dev-desktop.mjs')
    const stdin = new FakeTtyStdin()

    const dispose = installInteractiveInterruptHandler({ stdin, shutdownHandler: vi.fn() })

    expect(() =>
      stdin.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' }))
    ).not.toThrow()

    dispose()
  })

  test('reclaims the terminal foreground process group in interactive mode', async () => {
    const { reclaimForegroundProcessGroup } = await import('../scripts/dev-desktop.mjs')
    const spawnSyncImpl = vi.fn(() => ({ status: 0 }))

    usingStdinTty(() => {
      expect(reclaimForegroundProcessGroup({ spawnSyncImpl })).toBe(true)
    })

    expect(spawnSyncImpl).toHaveBeenCalledWith(
      'python3',
      ['-c', expect.stringContaining('os.tcsetpgrp(fd, os.getpgrp())')],
      { stdio: 'ignore' }
    )
  })

  test('periodically reclaims the terminal foreground process group', async () => {
    const { installForegroundProcessGroupReclaimer } = await import('../scripts/dev-desktop.mjs')
    const clearIntervalImpl = vi.fn()
    const interval = { unref: vi.fn() }
    const reclaim = vi.fn()
    const setIntervalImpl = vi.fn(() => interval)

    const dispose = usingStdinTty(() =>
      installForegroundProcessGroupReclaimer({
        setIntervalImpl,
        clearIntervalImpl,
        reclaim
      })
    )

    expect(reclaim).toHaveBeenCalledTimes(1)
    expect(setIntervalImpl).toHaveBeenCalledWith(reclaim, 500)
    expect(interval.unref).toHaveBeenCalled()

    dispose()
    expect(clearIntervalImpl).toHaveBeenCalledWith(interval)
  })

  test('dev:desktop uses the desktop dev launcher', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.['dev:desktop']).toBe('node scripts/dev-desktop.mjs')
  })

  test('dev:headless launches desktop dev with the headless environment flag', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.['dev:headless']).toBe(
      'HIVE_HEADLESS=1 node scripts/dev-desktop.mjs'
    )
  })

  test('waits for the desktop child to exit after SIGINT before exiting', async () => {
    const cwd = mkTempDir()
    const binDir = resolve(cwd, 'bin')
    const readyFile = resolve(cwd, 'child-ready')
    const termFile = resolve(cwd, 'child-term')
    const launcherPath = resolve('scripts/dev-desktop.mjs')

    mkdirSync(resolve(cwd, 'out/main/server-chunks'), { recursive: true })
    writeFileSync(resolve(cwd, 'out/main/server.js'), '// fake server bundle\n')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      resolve(binDir, 'pnpm'),
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')

if (process.argv[2] === 'run' && process.argv[3] === 'build:server') {
  process.exit(0)
}

if (process.argv[2] === 'exec' && process.argv[3] === 'electron-vite' && process.argv[4] === 'dev') {
  writeFileSync(process.env.FAKE_CHILD_READY, 'ready')
  process.on('SIGTERM', () => {
    writeFileSync(process.env.FAKE_CHILD_TERM, 'term')
    setTimeout(() => process.exit(0), 600)
  })
  setInterval(() => {}, 100)
  return
}

process.stderr.write('unexpected pnpm args: ' + process.argv.slice(2).join(' ') + '\\n')
process.exit(1)
`,
      { mode: 0o755 }
    )

    const child = spawn(process.execPath, [launcherPath], {
      cwd,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FAKE_CHILD_READY: readyFile,
        FAKE_CHILD_TERM: termFile
      },
      stdio: 'ignore'
    })

    await waitFor(() => existsSync(readyFile))
    const signalAt = Date.now()
    child.kill('SIGINT')

    const exit = await waitForExit(child)
    const elapsedAfterSignalMs = Date.now() - signalAt

    expect(exit).toEqual({ code: 0, signal: null })
    expect(existsSync(termFile)).toBe(true)
    expect(elapsedAfterSignalMs).toBeGreaterThanOrEqual(500)
  }, 5_000)

  test('headless mode starts the copied server bundle with plain Node', async () => {
    const cwd = mkTempDir()
    const binDir = resolve(cwd, 'bin')
    const serverReadyFile = resolve(cwd, 'server-ready')
    const serverTermFile = resolve(cwd, 'server-term')
    const launcherPath = resolve('scripts/dev-desktop.mjs')

    mkdirSync(resolve(cwd, 'out/main/server-chunks'), { recursive: true })
    writeFileSync(
      resolve(cwd, 'out/main/server.js'),
      `const { writeFileSync } = require('node:fs')
writeFileSync(process.env.FAKE_SERVER_READY, JSON.stringify({
  argv: process.argv.slice(1),
  env: {
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
    HIVE_HEADLESS: process.env.HIVE_HEADLESS,
    HIVE_SERVER_MODE: process.env.HIVE_SERVER_MODE
  }
}))
process.on('SIGTERM', () => {
  writeFileSync(process.env.FAKE_SERVER_TERM, 'term')
  setTimeout(() => process.exit(0), 300)
})
setInterval(() => {}, 100)
`
    )
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      resolve(binDir, 'pnpm'),
      `#!/usr/bin/env node
if (process.argv[2] === 'run' && process.argv[3] === 'build:server') {
  process.exit(0)
}

if (
  process.argv[2] === 'rebuild' &&
  process.argv[3] === 'better-sqlite3' &&
  process.argv[4] === 'node-pty'
) {
  process.exit(0)
}

process.stderr.write('unexpected pnpm args: ' + process.argv.slice(2).join(' ') + '\\n')
process.exit(1)
`,
      { mode: 0o755 }
    )

    const child = spawn(process.execPath, [launcherPath], {
      cwd,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FAKE_SERVER_READY: serverReadyFile,
        FAKE_SERVER_TERM: serverTermFile,
        HIVE_HEADLESS: '1',
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: 'ignore'
    })

    await waitFor(() => existsSync(serverReadyFile))
    const ready = JSON.parse(readFileSync(serverReadyFile, 'utf-8')) as {
      argv: string[]
      env: Record<string, string | undefined>
    }

    expect(ready.argv[0]).toBe(resolve(cwd, '.dev-server/server.js'))
    expect(ready.env.HIVE_HEADLESS).toBe('1')
    expect(ready.env.HIVE_SERVER_MODE).toBe('browser')
    expect(ready.env.ELECTRON_RUN_AS_NODE).toBeUndefined()

    child.kill('SIGINT')
    const exit = await waitForExit(child)

    expect(exit).toEqual({ code: 0, signal: null })
    expect(existsSync(serverTermFile)).toBe(true)
  }, 5_000)
})

const mkTempDir = (): string => {
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'hive-dev-desktop-script-')))
  tempDirs.push(dir)
  return dir
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for condition')
}

const waitForExit = (
  child: ReturnType<typeof spawn>
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      child.off('error', reject)
      resolveExit({ code, signal })
    })
  })

class FakeTtyStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  resume = vi.fn()
  setRawMode = vi.fn((value: boolean) => {
    this.isRaw = value
    return this
  })
}

const usingStdinTty = <T>(callback: () => T): T => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: true
  })
  try {
    return callback()
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor)
    } else {
      delete (process.stdin as typeof process.stdin & { isTTY?: boolean }).isTTY
    }
  }
}
