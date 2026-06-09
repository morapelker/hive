import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

interface SettingRow {
  readonly key: string
  readonly value: string
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

const startXvfb = (): { readonly display: string; readonly process: ChildProcess | null } => {
  if (process.env.DISPLAY) {
    return { display: process.env.DISPLAY, process: null }
  }

  const display = `:${120 + (process.pid % 1000)}`
  const child = spawn(
    'Xvfb',
    [display, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )

  return { display, process: child }
}

test('electron mode starts the desktop backend, opens renderer, and reads settings', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'hive-electron-mode-'))
  const diagnostics: string[] = []
  const xvfb = startXvfb()
  let app: ElectronApplication | null = null

  try {
    await new Promise((resolve) => setTimeout(resolve, xvfb.process ? 500 : 0))

    app = await electron.launch({
      args: ['out/main/index.js', '--no-sandbox', '--disable-gpu'],
      env: {
        ...process.env,
        DISPLAY: xvfb.display,
        HOME: baseDir,
        XDG_CONFIG_HOME: join(baseDir, '.config'),
        XDG_CACHE_HOME: join(baseDir, '.cache'),
        XDG_DATA_HOME: join(baseDir, '.local', 'share')
      }
    })

    app.on('window', (page) => {
      diagnostics.push(`window: ${page.url()}`)
      page.on('console', (message) => {
        diagnostics.push(`console.${message.type()}: ${message.text()}`)
      })
      page.on('pageerror', (error) => {
        diagnostics.push(`pageerror: ${error.message}`)
      })
    })

    const page = await app.firstWindow({ timeout: 30_000 })

    await expect(page).toHaveURL(/\/out\/renderer\/index\.html$/)
    await page.waitForFunction(
      () => Boolean(window.desktopBridge?.getLocalEnvironmentBootstrap),
      undefined,
      { timeout: 10_000 }
    )

    const bootstrap = await page.evaluate(() => window.desktopBridge.getLocalEnvironmentBootstrap())
    expect(bootstrap?.httpBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(bootstrap?.wsBaseUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/)
    expect(bootstrap?.bootstrapToken).toEqual(expect.any(String))
    expect(bootstrap?.bootstrapToken.length).toBeGreaterThan(20)

    const settings = await page
      .evaluate(
        async ({ httpBaseUrl, wsBaseUrl, bootstrapToken }) => {
          const bootstrapResponse = await fetch(`${httpBaseUrl}/api/auth/bootstrap`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bootstrapToken })
          })
          const auth = await bootstrapResponse.json()
          const wsTokenResponse = await fetch(`${httpBaseUrl}/api/auth/ws-token`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${auth.session.accessToken}` }
          })
          const wsToken = await wsTokenResponse.json()
          const rpcResponse = await new Promise<unknown>((resolve, reject) => {
            const socket = new WebSocket(
              `${wsBaseUrl}?token=${encodeURIComponent(wsToken.webSocketToken.token)}`
            )
            const timeout = setTimeout(() => {
              socket.close()
              reject(new Error('Timed out reading settings through direct desktop RPC'))
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
              reject(new Error('Direct desktop settings RPC WebSocket failed'))
            })
          })

          return {
            bootstrapStatus: bootstrapResponse.status,
            wsTokenStatus: wsTokenResponse.status,
            rpcResponse
          }
        },
        {
          httpBaseUrl: bootstrap.httpBaseUrl,
          wsBaseUrl: bootstrap.wsBaseUrl,
          bootstrapToken: bootstrap.bootstrapToken
        }
      )
      .catch((error) => {
        throw new Error(
          [
            error instanceof Error ? error.message : String(error),
            ...diagnostics.slice(-40)
          ].join('\n')
        )
      }) as RpcCallResult<SettingRow[]>

    expect(settings.bootstrapStatus).toBe(200)
    expect(settings.wsTokenStatus).toBe(200)
    expect(settings.rpcResponse.ok, JSON.stringify(settings)).toBe(true)
    expect(Array.isArray(settings.rpcResponse.value)).toBe(true)
  } finally {
    if (app) await app.close().catch(() => undefined)
    await stopChild(xvfb.process)
    rmSync(baseDir, { recursive: true, force: true })
  }
})
