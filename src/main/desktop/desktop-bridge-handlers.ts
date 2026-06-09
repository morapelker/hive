import {
  encodeLocalEnvironmentBootstrapArg,
  type LocalEnvironmentBootstrap
} from '@shared/desktop-bridge'
import { getDesktopBackendBootstrap } from './backend-manager'
import { ipcMain, shell } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

export const getDesktopPreloadBootstrapArguments = (
  bootstrap: LocalEnvironmentBootstrap | null = getDesktopBackendBootstrap()
): string[] => [encodeLocalEnvironmentBootstrapArg(bootstrap)]

interface HiveEnterpriseLoginArgs {
  serverUrl?: string
}

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'

const normalizeHiveEnterpriseDesktopAuthServerUrl = (value: string): string => {
  const serverUrl = value.replace(/\/+$/, '')

  try {
    const url = new URL(serverUrl)
    if (url.protocol === 'https:' && isLoopbackHostname(url.hostname)) {
      url.protocol = 'http:'
      return url.toString().replace(/\/+$/, '')
    }
  } catch {
    // Preserve the existing behavior for non-URL strings.
  }

  return serverUrl
}

export function registerDesktopBridgeHandlers(): void {
  ipcMain.handle('hive-enterprise:start-login', async (_event, args: HiveEnterpriseLoginArgs) => {
    const serverUrl =
      typeof args?.serverUrl === 'string'
        ? normalizeHiveEnterpriseDesktopAuthServerUrl(args.serverUrl)
        : ''
    if (!serverUrl) throw new Error('Hive Enterprise server URL is required')

    // Nonce that ties the loopback callback to this specific login attempt. The
    // browser is redirected with this state and the enterprise server echoes it
    // back, so unrelated requests (favicon probes, stray local pages) can't inject
    // a token.
    const state = randomUUID()

    return new Promise<{ token: string }>((resolve, reject) => {
      const servers = new Set<Server>()
      let settled = false

      const cleanup = (): void => {
        clearTimeout(timeout)
        for (const server of servers) {
          if (server.listening) server.close()
        }
      }

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }

      const timeout = setTimeout(
        () => {
          finish(() => reject(new Error('Timed out waiting for Hive Enterprise login')))
        },
        5 * 60 * 1000
      )

      const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
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
      }

      const openBrowser = (port: number): void => {
        const redirect = `http://localhost:${port}/?state=${state}`
        const startUrl = `${serverUrl}/api/auth/desktop/start?redirect=${encodeURIComponent(redirect)}`
        shell.openExternal(startUrl).catch((error) => {
          finish(() => reject(error))
        })
      }

      const ipv4Server = createServer(handleRequest)
      servers.add(ipv4Server)
      ipv4Server.on('error', (error) => {
        finish(() => reject(error))
      })

      ipv4Server.listen(0, '127.0.0.1', () => {
        const address = ipv4Server.address()
        if (!address || typeof address === 'string') {
          finish(() => reject(new Error('Unable to allocate Hive Enterprise loopback port')))
          return
        }

        // Enterprise validates the redirect host as "localhost". Listen on both
        // loopback families when possible so the browser callback works whether
        // localhost resolves to 127.0.0.1 or ::1 first.
        const ipv6Server = createServer(handleRequest)
        servers.add(ipv6Server)
        const handleIpv6Error = (error: NodeJS.ErrnoException): void => {
          if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EADDRINUSE'].includes(error.code ?? '')) {
            openBrowser(address.port)
            return
          }
          finish(() => reject(error))
        }
        ipv6Server.once('error', handleIpv6Error)
        ipv6Server.listen({ port: address.port, host: '::1', ipv6Only: true }, () => {
          ipv6Server.off('error', handleIpv6Error)
          ipv6Server.on('error', (error) => {
            finish(() => reject(error))
          })
          openBrowser(address.port)
        })
      })
    })
  })
}
