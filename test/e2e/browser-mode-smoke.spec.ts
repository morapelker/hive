import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { test, expect } from '@playwright/test'

interface HiveServerReadyEvent {
  readonly event: 'hive-server-ready'
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
}

interface SettingRow {
  readonly key: string
  readonly value: string
}

interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly path: string
}

interface RpcProbeResult {
  readonly bootstrapStatus: number
  readonly wsTokenStatus: number
  readonly rpcResponse: unknown
}

interface RpcCallResult<T> {
  readonly bootstrapStatus: number
  readonly wsTokenStatus: number
  readonly rpcResponse: {
    readonly id?: string
    readonly ok?: boolean
    readonly value?: T
    readonly error?: unknown
  }
}

const spawnChild = (
  command: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv } = {}
): ChildProcess =>
  spawn(command, [...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...options.env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

const stopChild = async (child: ChildProcess | null): Promise<void> => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 2_000).unref()
  })
}

const waitForHiveServer = (child: ChildProcess): Promise<HiveServerReadyEvent> =>
  new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let buffer = ''
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for hive-server-ready\n${stdout}\n${stderr}`))
    }, 10_000)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      buffer += chunk
      const lines = buffer.split(/\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }

        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'event' in parsed &&
          parsed.event === 'hive-server-ready'
        ) {
          clearTimeout(timeout)
          resolve(parsed as HiveServerReadyEvent)
        }
      }
    })

    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`Hive server exited before ready: code=${code} signal=${signal}\n${stderr}`))
    })
  })

const waitForVite = (child: ChildProcess): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for Vite dev server\n${output}`))
    }, 15_000)

    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString()
      const match = output.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/)
      if (match?.[1]) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`Vite exited before ready: code=${code} signal=${signal}\n${output}`))
    })
  })

test('browser mode loads, authenticates, reads settings, and lists projects', async ({ page }) => {
  const baseDir = mkdtempSync(join(tmpdir(), 'hive-browser-mode-'))
  const bootstrapToken = randomBytes(32).toString('base64url')
  const diagnostics: string[] = []
  let backend: ChildProcess | null = null
  let vite: ChildProcess | null = null

  try {
    page.on('console', (message) => {
      diagnostics.push(`console.${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', (error) => {
      diagnostics.push(`pageerror: ${error.message}`)
    })
    page.on('websocket', (socket) => {
      diagnostics.push(`websocket.open: ${socket.url()}`)
      socket.on('framesent', (event) => diagnostics.push(`websocket.sent: ${event.payload}`))
      socket.on('framereceived', (event) => diagnostics.push(`websocket.received: ${event.payload}`))
      socket.on('close', () => diagnostics.push(`websocket.close: ${socket.url()}`))
      socket.on('socketerror', (error) => diagnostics.push(`websocket.error: ${error}`))
    })

    backend = spawnChild('pnpm', ['exec', 'electron', 'out/main/server.js'], {
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        HOME: baseDir,
        HIVE_SERVER_BASE_DIR: baseDir,
        HIVE_SERVER_MODE: 'browser',
        HIVE_SERVER_PORT: '0',
        HIVE_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken,
        HIVE_SERVER_DEV_URL: 'http://127.0.0.1:5173'
      }
    })
    const ready = await waitForHiveServer(backend)

    vite = spawnChild('pnpm', ['exec', 'vite', '--config', 'vite.web.config.ts', '--host', '127.0.0.1', '--port', '0', '--clearScreen', 'false'], {
      env: {
        VITE_HIVE_BOOTSTRAP_TOKEN: bootstrapToken,
        VITE_HIVE_HTTP_BASE_URL: ready.httpBaseUrl,
        VITE_HIVE_WS_BASE_URL: ready.wsBaseUrl
      }
    })
    const appUrl = await waitForVite(vite)

    const response = await page.goto(appUrl)
    expect(response?.ok()).toBe(true)
    await page.waitForLoadState('domcontentloaded')

    const rpcProbe = await page.evaluate(
      async ({ httpBaseUrl, wsBaseUrl, token }) => {
        const bootstrapResponse = await fetch(`${httpBaseUrl}/api/auth/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bootstrapToken: token })
        })
        const bootstrap = await bootstrapResponse.json()
        const wsTokenResponse = await fetch(`${httpBaseUrl}/api/auth/ws-token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bootstrap.session.accessToken}` }
        })
        const wsToken = await wsTokenResponse.json()
        const rpcResponse = await new Promise<unknown>((resolve, reject) => {
          const socket = new WebSocket(
            `${wsBaseUrl}?token=${encodeURIComponent(wsToken.webSocketToken.token)}`
          )
          const timeout = setTimeout(() => {
            socket.close()
            reject(new Error('Timed out waiting for direct browser RPC response'))
          }, 5_000)

          socket.addEventListener('open', () => {
            socket.send(JSON.stringify({ id: 'probe-1', method: 'system.ping', params: {} }))
          })
          socket.addEventListener('message', (event) => {
            clearTimeout(timeout)
            socket.close()
            resolve(JSON.parse(event.data))
          })
          socket.addEventListener('error', () => {
            clearTimeout(timeout)
            reject(new Error('Direct browser RPC WebSocket failed'))
          })
        })

        return {
          bootstrapStatus: bootstrapResponse.status,
          wsTokenStatus: wsTokenResponse.status,
          rpcResponse
        }
      },
      { httpBaseUrl: ready.httpBaseUrl, wsBaseUrl: ready.wsBaseUrl, token: bootstrapToken }
    ) as RpcProbeResult

    expect(rpcProbe.bootstrapStatus).toBe(200)
    expect(rpcProbe.wsTokenStatus).toBe(200)
    expect(rpcProbe.rpcResponse).toEqual({ id: 'probe-1', ok: true, value: { ok: true } })

    const settings = await page.evaluate(
      async ({ httpBaseUrl, wsBaseUrl, token }) => {
        const bootstrapResponse = await fetch(`${httpBaseUrl}/api/auth/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bootstrapToken: token })
        })
        const bootstrap = await bootstrapResponse.json()
        const wsTokenResponse = await fetch(`${httpBaseUrl}/api/auth/ws-token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bootstrap.session.accessToken}` }
        })
        const wsToken = await wsTokenResponse.json()
        const rpcResponse = await new Promise<unknown>((resolve, reject) => {
          const socket = new WebSocket(
            `${wsBaseUrl}?token=${encodeURIComponent(wsToken.webSocketToken.token)}`
          )
          const timeout = setTimeout(() => {
            socket.close()
            reject(new Error('Timed out reading settings through direct RPC'))
          }, 5_000)

          socket.addEventListener('open', () => {
            socket.send(JSON.stringify({ id: 'settings-1', method: 'db.setting.getAll', params: {} }))
          })
          socket.addEventListener('message', (event) => {
            clearTimeout(timeout)
            socket.close()
            resolve(JSON.parse(event.data))
          })
          socket.addEventListener('error', () => {
            clearTimeout(timeout)
            reject(new Error('Direct settings RPC WebSocket failed'))
          })
        })

        return {
          bootstrapStatus: bootstrapResponse.status,
          wsTokenStatus: wsTokenResponse.status,
          rpcResponse
        }
      },
      { httpBaseUrl: ready.httpBaseUrl, wsBaseUrl: ready.wsBaseUrl, token: bootstrapToken }
    ).catch((error) => {
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          ...diagnostics.slice(-40)
        ].join('\n')
      )
    }) as RpcCallResult<SettingRow[]>
    const projects = await page.evaluate(
      async ({ httpBaseUrl, wsBaseUrl, token }) => {
        const bootstrapResponse = await fetch(`${httpBaseUrl}/api/auth/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bootstrapToken: token })
        })
        const bootstrap = await bootstrapResponse.json()
        const wsTokenResponse = await fetch(`${httpBaseUrl}/api/auth/ws-token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bootstrap.session.accessToken}` }
        })
        const wsToken = await wsTokenResponse.json()
        const rpcResponse = await new Promise<unknown>((resolve, reject) => {
          const socket = new WebSocket(
            `${wsBaseUrl}?token=${encodeURIComponent(wsToken.webSocketToken.token)}`
          )
          const timeout = setTimeout(() => {
            socket.close()
            reject(new Error('Timed out listing projects through direct RPC'))
          }, 5_000)

          socket.addEventListener('open', () => {
            socket.send(JSON.stringify({ id: 'projects-1', method: 'db.project.getAll', params: {} }))
          })
          socket.addEventListener('message', (event) => {
            clearTimeout(timeout)
            socket.close()
            resolve(JSON.parse(event.data))
          })
          socket.addEventListener('error', () => {
            clearTimeout(timeout)
            reject(new Error('Direct projects RPC WebSocket failed'))
          })
        })

        return {
          bootstrapStatus: bootstrapResponse.status,
          wsTokenStatus: wsTokenResponse.status,
          rpcResponse
        }
      },
      { httpBaseUrl: ready.httpBaseUrl, wsBaseUrl: ready.wsBaseUrl, token: bootstrapToken }
    ).catch((error) => {
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          ...diagnostics.slice(-40)
        ].join('\n')
      )
    }) as RpcCallResult<ProjectRow[]>

    expect(settings.bootstrapStatus).toBe(200)
    expect(settings.wsTokenStatus).toBe(200)
    expect(settings.rpcResponse.ok, JSON.stringify(settings)).toBe(true)
    expect(Array.isArray(settings.rpcResponse.value)).toBe(true)
    expect(projects.bootstrapStatus).toBe(200)
    expect(projects.wsTokenStatus).toBe(200)
    expect(projects.rpcResponse.ok, JSON.stringify(projects)).toBe(true)
    expect(Array.isArray(projects.rpcResponse.value)).toBe(true)
  } finally {
    await stopChild(vite)
    await stopChild(backend)
    rmSync(baseDir, { recursive: true, force: true })
  }
})
