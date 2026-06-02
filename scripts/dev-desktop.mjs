#!/usr/bin/env node
import { spawn } from 'node:child_process'
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

const shutdown = (code = 0) => {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    child.kill('SIGTERM')
  }
  setTimeout(() => {
    for (const child of children) {
      child.kill('SIGKILL')
    }
  }, 2000).unref()
  process.exit(code)
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

const runDevDesktop = async () => {
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
  runDevDesktop().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    shutdown(1)
  })
}
