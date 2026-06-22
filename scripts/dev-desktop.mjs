#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const DEV_SERVER_DIR = '.dev-server'
const SERVER_ENTRY = 'server.js'
const SERVER_CHUNKS = 'server-chunks'

export const createDevDesktopEnv = ({ cwd = process.cwd(), env = process.env } = {}) => {
  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE

  return {
    ...childEnv,
    HIVE_SERVER_ENTRY_PATH:
      env.HIVE_SERVER_ENTRY_PATH && env.HIVE_SERVER_ENTRY_PATH.length > 0
        ? env.HIVE_SERVER_ENTRY_PATH
        : resolve(cwd, DEV_SERVER_DIR, SERVER_ENTRY)
  }
}

export const createDevHeadlessEnv = ({ env = process.env } = {}) => {
  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE

  return {
    ...childEnv,
    HIVE_HEADLESS: '1',
    HIVE_SERVER_MODE: env.HIVE_SERVER_MODE ?? 'browser',
    HIVE_SERVER_HOST: env.HIVE_SERVER_HOST ?? '127.0.0.1',
    HIVE_SERVER_PORT: env.HIVE_SERVER_PORT ?? '3773',
    HIVE_SERVER_REQUIRE_AUTH: env.HIVE_SERVER_REQUIRE_AUTH ?? 'true'
  }
}

const isHeadlessEnv = (env = process.env) => env.HIVE_HEADLESS === '1'

const children = new Set()
let shuttingDown = false

const spawnTracked = (command, args, options = {}) => {
  const child = spawn(command, args, {
    stdio: 'inherit',
    ...options
  })
  children.add(child)
  child.once('exit', () => {
    children.delete(child)
  })
  return child
}

const waitForExit = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', resolve)
  })

const shutdown = (code = 0) => {
  if (shuttingDown) return
  shuttingDown = true
  const shutdownChildren = [...children]
  const exits = shutdownChildren.map(waitForExit)

  for (const child of shutdownChildren) {
    child.kill('SIGTERM')
  }

  const forceKillTimer = setTimeout(() => {
    for (const child of children) {
      child.kill('SIGKILL')
    }
  }, 2000)

  void Promise.all(exits).finally(() => {
    clearTimeout(forceKillTimer)
    process.exit(code)
  })
}

export const installInteractiveInterruptHandler = ({
  stdin = process.stdin,
  shutdownHandler = () => shutdown(0)
} = {}) => {
  if (!stdin?.isTTY || typeof stdin.on !== 'function') {
    return () => {}
  }

  const wasRaw = Boolean(stdin.isRaw)
  const canSetRawMode = typeof stdin.setRawMode === 'function'

  const onData = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    if (buffer.includes(0x03)) {
      shutdownHandler()
    }
  }
  const onError = () => {}

  if (canSetRawMode) {
    stdin.setRawMode(true)
  }
  stdin.resume?.()
  stdin.on('data', onData)
  stdin.on('error', onError)

  return () => {
    stdin.off?.('data', onData)
    stdin.off?.('error', onError)
    stdin.removeListener?.('data', onData)
    stdin.removeListener?.('error', onError)
    if (canSetRawMode) {
      stdin.setRawMode(wasRaw)
    }
  }
}

export const reclaimForegroundProcessGroup = ({ spawnSyncImpl = spawnSync } = {}) => {
  if (!process.stdin?.isTTY || process.platform === 'win32') {
    return false
  }

  const script = [
    'import os, signal',
    'signal.signal(signal.SIGTTOU, signal.SIG_IGN)',
    "fd = os.open('/dev/tty', os.O_RDONLY)",
    'try:',
    '    os.tcsetpgrp(fd, os.getpgrp())',
    'finally:',
    '    os.close(fd)'
  ].join('\n')
  const result = spawnSyncImpl('python3', ['-c', script], { stdio: 'ignore' })
  return result.status === 0
}

export const installForegroundProcessGroupReclaimer = ({
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  reclaim = () => reclaimForegroundProcessGroup()
} = {}) => {
  if (!process.stdin?.isTTY || process.platform === 'win32') {
    return () => {}
  }

  reclaim()
  const interval = setIntervalImpl(reclaim, 500)
  interval.unref?.()

  return () => {
    clearIntervalImpl(interval)
  }
}

const run = (command, args, options = {}) =>
  new Promise((resolveRun, reject) => {
    const child = spawnTracked(command, args, options)
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(' ')} terminated with ${signal}`))
        return
      }
      if (code === 0) resolveRun()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })

const copyDevServerBundle = (cwd = process.cwd()) => {
  const sourceEntry = resolve(cwd, 'out/main', SERVER_ENTRY)
  const sourceChunks = resolve(cwd, 'out/main', SERVER_CHUNKS)
  const targetDir = resolve(cwd, DEV_SERVER_DIR)
  const targetEntry = resolve(targetDir, SERVER_ENTRY)
  const targetChunks = resolve(targetDir, SERVER_CHUNKS)

  if (!existsSync(sourceEntry)) {
    throw new Error(`Expected server bundle at ${sourceEntry}`)
  }

  mkdirSync(targetDir, { recursive: true })
  cpSync(sourceEntry, targetEntry)

  rmSync(targetChunks, { force: true, recursive: true })
  if (existsSync(sourceChunks)) {
    cpSync(sourceChunks, targetChunks, { recursive: true })
  }
}

const runDevHeadless = async () => {
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))

  await run('pnpm', ['run', 'build:server'])
  copyDevServerBundle()

  // Native modules are normally rebuilt for Electron by postinstall. Plain
  // Node headless mode needs the Node ABI instead.
  await run('pnpm', ['rebuild', 'better-sqlite3', 'node-pty'])

  const child = spawnTracked(
    process.execPath,
    [resolve(process.cwd(), DEV_SERVER_DIR, SERVER_ENTRY)],
    {
      env: createDevHeadlessEnv()
    }
  )

  child.once('exit', (code, signal) => {
    if (shuttingDown) return
    if (signal) shutdown(1)
    else shutdown(code ?? 0)
  })
}

const runDevDesktop = async () => {
  const disposeInteractiveInterruptHandler = installInteractiveInterruptHandler()
  const disposeForegroundProcessGroupReclaimer = installForegroundProcessGroupReclaimer()
  process.once('exit', disposeInteractiveInterruptHandler)
  process.once('exit', disposeForegroundProcessGroupReclaimer)
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))

  await run('pnpm', ['run', 'build:server'])
  copyDevServerBundle()

  const child = spawnTracked('pnpm', ['exec', 'electron-vite', 'dev'], {
    env: createDevDesktopEnv()
  })

  child.once('exit', (code, signal) => {
    if (shuttingDown) return
    if (signal) shutdown(1)
    else shutdown(code ?? 0)
  })
}

const isDirectRun = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false

if (isDirectRun) {
  const runDev = isHeadlessEnv() ? runDevHeadless : runDevDesktop

  runDev().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    shutdown(1)
  })
}
