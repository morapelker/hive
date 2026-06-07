import {
  encodeLocalEnvironmentBootstrapArg,
  type LocalEnvironmentBootstrap
} from '@shared/desktop-bridge'
import { getDesktopBackendBootstrap } from './backend-manager'
import { ipcMain, shell } from 'electron'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

export const getDesktopPreloadBootstrapArguments = (
  bootstrap: LocalEnvironmentBootstrap | null = getDesktopBackendBootstrap()
): string[] => [encodeLocalEnvironmentBootstrapArg(bootstrap)]

interface HiveEnterpriseLoginArgs {
  serverUrl?: string
}

export function registerDesktopBridgeHandlers(): void {
  ipcMain.handle('hive-enterprise:start-login', async (_event, args: HiveEnterpriseLoginArgs) => {
    const serverUrl = typeof args?.serverUrl === 'string' ? args.serverUrl.replace(/\/+$/, '') : ''
    if (!serverUrl) throw new Error('Hive Enterprise server URL is required')

    // Nonce that ties the loopback callback to this specific login attempt. The
    // browser is redirected with this state and the enterprise server echoes it
    // back, so unrelated requests (favicon probes, stray local pages) can't inject
    // a token.
    const state = randomUUID()

    return new Promise<{ token: string }>((resolve, reject) => {
      const server = createServer()
      let settled = false

      const cleanup = (): void => {
        clearTimeout(timeout)
        server.close()
      }

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }

      const timeout = setTimeout(() => {
        finish(() => reject(new Error('Timed out waiting for Hive Enterprise login')))
      }, 5 * 60 * 1000)

      server.on('request', (request, response) => {
        const host = request.headers.host ?? '127.0.0.1'
        const url = new URL(request.url ?? '/', `http://${host}`)

        // Ignore requests that don't carry our nonce (favicon prefetch, browser
        // connection checks, unrelated callers). Don't settle on them — only the
        // real callback for this login attempt should resolve or reject.
        if (url.searchParams.get('state') !== state) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('Not found')
          return
        }

        const token = url.searchParams.get('token')

        response.writeHead(token ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(
          token
            ? '<!doctype html><title>Hive Enterprise</title><p>Hive Enterprise sign-in complete. You can close this tab.</p>'
            : '<!doctype html><title>Hive Enterprise</title><p>Hive Enterprise sign-in failed.</p>'
        )

        if (token) {
          finish(() => resolve({ token }))
        } else {
          finish(() => reject(new Error('Hive Enterprise login did not return a token')))
        }
      })

      server.on('error', (error) => {
        finish(() => reject(error))
      })

      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          finish(() => reject(new Error('Unable to allocate Hive Enterprise loopback port')))
          return
        }
        // Use 127.0.0.1 (not "localhost") to match the bind address — on hosts that
        // resolve localhost to ::1 first, the callback would otherwise hit IPv6 and
        // be refused.
        const redirect = `http://127.0.0.1:${address.port}/?state=${state}`
        const startUrl = `${serverUrl}/api/auth/desktop/start?redirect=${encodeURIComponent(redirect)}`
        shell.openExternal(startUrl).catch((error) => {
          finish(() => reject(error))
        })
      })
    })
  })
}
