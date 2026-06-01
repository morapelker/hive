#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import process from 'node:process'

// dev:web runs the FULL Electron app (so the desktop command bridge + agent handlers
// are available) and serves the renderer from a Vite dev server with HMR. The Vite
// page is pointed at the full app's desktop backend, which runs with auth disabled on
// loopback — so a plain browser tab connects token-less and can drive agents/terminals.
// Open the Vite URL (default http://127.0.0.1:5173) in your browser.

const viteHost = process.env.HIVE_WEB_HOST ?? '127.0.0.1'
const vitePort = process.env.HIVE_WEB_PORT ?? process.env.PORT ?? '5173'
const viteOriginHost = viteHost === '0.0.0.0' ? 'localhost' : viteHost
const viteOrigin = `http://${viteOriginHost}:${vitePort}`

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

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })

const waitForBackend = async (port, timeoutMs = 90000) => {
  const url = `http://127.0.0.1:${port}/.well-known/hive/environment`
  const start = Date.now()
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      // backend not up yet — keep polling
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for the Hive desktop backend on :${port}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

try {
  // Build the main/preload/renderer bundles the full app runs from (out/main/index.js,
  // out/main/server.js, out/renderer). The browser renderer is served by Vite, so the
  // static web build (build:web) is not needed here.
  await run('pnpm', ['exec', 'electron-vite', 'build'])

  const backendPort = await getFreePort()

  const app = spawnTracked('pnpm', ['exec', 'electron', '.'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      // Pin the desktop backend to the free port we just reserved so Vite can target it.
      HIVE_DESKTOP_BACKEND_PORT: String(backendPort)
    }
  })

  process.stdout.write(
    `[dev:web] launching full Hive app; desktop backend pinned to :${backendPort}\n`
  )

  const env = await waitForBackend(backendPort)
  const httpBaseUrl = env.httpBaseUrl ?? `http://127.0.0.1:${backendPort}`
  const wsBaseUrl = env.wsBaseUrl ?? `ws://127.0.0.1:${backendPort}/ws`

  process.stdout.write(`[dev:web] backend ready at ${httpBaseUrl} (bridge + agents available)\n`)
  process.stdout.write(`[dev:web] open the web UI (HMR) at ${viteOrigin}\n`)

  const vite = spawnTracked(
    'pnpm',
    ['exec', 'vite', '--config', 'vite.web.config.ts', '--host', viteHost, '--port', vitePort],
    {
      env: {
        ...process.env,
        VITE_HIVE_HTTP_BASE_URL: httpBaseUrl,
        VITE_HIVE_WS_BASE_URL: wsBaseUrl
      }
    }
  )

  app.once('exit', (code, signal) => {
    if (shuttingDown) return
    process.stderr.write(`Hive app exited: code=${code} signal=${signal}\n`)
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
