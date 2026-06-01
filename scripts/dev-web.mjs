#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import process from 'node:process'

const viteHost = process.env.HIVE_WEB_HOST ?? '127.0.0.1'
const vitePort = process.env.HIVE_WEB_PORT ?? process.env.PORT ?? '5173'
const viteOriginHost = viteHost === '0.0.0.0' ? 'localhost' : viteHost
const viteOrigin = process.env.HIVE_SERVER_DEV_URL ?? `http://${viteOriginHost}:${vitePort}`
const serverPort = process.env.HIVE_SERVER_PORT ?? '0'
const bootstrapToken = process.env.HIVE_DESKTOP_BOOTSTRAP_TOKEN ?? randomBytes(32).toString('base64url')

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

process.once('SIGINT', () => shutdown(0))
process.once('SIGTERM', () => shutdown(0))

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawnTracked(command, args, options)
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(' ')} terminated with ${signal}`))
        return
      }
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })

const waitForBackend = (child) =>
  new Promise((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for hive-server-ready'))
    }, 15000)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split(/\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          process.stdout.write(line + '\n')
          continue
        }

        if (event.event === 'hive-server-ready') {
          clearTimeout(timeout)
          resolve(event)
          continue
        }

        process.stdout.write(line + '\n')
      }
    })

    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`Hive server exited before ready: code=${code} signal=${signal}`))
    })
  })

try {
  await run('pnpm', ['run', 'build'])

  const backend = spawnTracked('pnpm', ['exec', 'electron', 'out/main/server.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HIVE_SERVER_MODE: 'browser',
      HIVE_SERVER_PORT: serverPort,
      HIVE_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken,
      HIVE_SERVER_DEV_URL: viteOrigin
    }
  })
  backend.stderr.pipe(process.stderr)

  const ready = await waitForBackend(backend)
  process.stdout.write(`[dev:web] Hive backend ready at ${ready.httpBaseUrl}\n`)

  const vite = spawnTracked(
    'pnpm',
    ['exec', 'vite', '--config', 'vite.web.config.ts', '--host', viteHost, '--port', vitePort],
    {
      env: {
        ...process.env,
        VITE_HIVE_BOOTSTRAP_TOKEN: bootstrapToken,
        VITE_HIVE_HTTP_BASE_URL: ready.httpBaseUrl,
        VITE_HIVE_WS_BASE_URL: ready.wsBaseUrl
      }
    }
  )

  backend.once('exit', (code, signal) => {
    if (shuttingDown) return
    process.stderr.write(`Hive backend exited: code=${code} signal=${signal}\n`)
    vite.kill('SIGTERM')
    shutdown(1)
  })

  vite.once('exit', (code, signal) => {
    if (shuttingDown) return
    if (signal) shutdown(1)
    else shutdown(code ?? 0)
  })
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  shutdown(1)
}
