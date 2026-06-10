import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Cause, Effect, Exit, Option } from 'effect'
import { z } from 'zod'
import { exchangeDesktopBootstrapToken } from './auth/bootstrap'
import { getAuthSessionStatus, makeAuthSessionManager } from './auth/session'
import { makeEventBus } from './events/event-bus'
import { resolveServerConfig, type ServerConfig, type ServerConfigInput } from './config'
import { makeRpcRouter } from './rpc/router'
import { attachWebSocketRpcServer } from './rpc/ws-server'
import { resolveStaticFile, serveStaticFile } from './static'
import { isDesktopBackendEventMessage } from '../shared/desktop-command'
import { cleanupBranchWatchers } from '../main/services/branch-watcher'
import { setGitEventPublisher } from '../main/services/git-events'
import { setWorktreeEventPublisher } from '../main/services/worktree-events'
import { cleanupWorktreeWatchers } from '../main/services/worktree-watcher'
import { getDatabase } from '../main/db'

export interface StartedHiveServer {
  readonly config: ServerConfig
  readonly host: string
  readonly port: number
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly close: () => Promise<void>
}

// Forwards desktop→server backend events received over the Node IPC channel
// into the event bus (the low-latency replacement for the HTTP /api/events/publish
// hop). Tracked at module scope so a re-start swaps the handler instead of
// stacking listeners.
let desktopBackendEventForwarder: ((message: unknown) => void) | null = null

export const startHiveServer = (
  input: ServerConfigInput = {}
): Effect.Effect<StartedHiveServer, Error> =>
  Effect.gen(function* () {
    const config = yield* resolveServerConfig(input)
    getDatabase().init()
    const eventBus = makeEventBus()

    if (desktopBackendEventForwarder) {
      process.off('message', desktopBackendEventForwarder)
    }
    desktopBackendEventForwarder = (message: unknown): void => {
      if (!isDesktopBackendEventMessage(message)) return
      void Effect.runPromise(
        eventBus.publish({ channel: message.channel, payload: message.payload })
      ).catch(() => undefined)
    }
    process.on('message', desktopBackendEventForwarder)

    setGitEventPublisher((channel, payload) =>
      Effect.runPromise(
        eventBus.publish({
          channel,
          payload
        })
      )
    )
    setWorktreeEventPublisher((channel, payload) =>
      Effect.runPromise(
        eventBus.publish({
          channel,
          payload
        })
      )
    )
    const authSessions = makeAuthSessionManager()
    const router = makeRpcRouter({ eventBus })

    return yield* Effect.tryPromise({
      try: () =>
        new Promise<StartedHiveServer>((resolve, reject) => {
          const server: Server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', `http://${request.headers.host ?? config.host}`)
            const corsOrigin = getAllowedCorsOrigin(request.headers.origin)

            if (request.headers.origin && corsOrigin === null) {
              writeJson(response, 403, { error: 'Forbidden origin' })
              return
            }

            if (request.method === 'OPTIONS') {
              writeEmpty(response, 204, corsOrigin)
              return
            }

            const sessionStatus = getAuthSessionStatus(request.headers.authorization, authSessions)

            if (request.method === 'GET' && url.pathname === '/health') {
              writeJson(response, 200, { ok: true }, corsOrigin)
              return
            }

            if (request.method === 'GET' && url.pathname === '/.well-known/hive/environment') {
              const address = server.address()
              const port = typeof address === 'object' && address ? address.port : config.port
              writeJson(
                response,
                200,
                {
                  mode: config.mode,
                  host: config.host,
                  port,
                  httpBaseUrl: `http://${config.host}:${port}`,
                  wsBaseUrl: `ws://${config.host}:${port}/ws`,
                  hasDesktopBootstrapToken: config.desktopBootstrapToken !== null
                },
                corsOrigin
              )
              return
            }

            if (request.method === 'POST' && url.pathname === '/api/auth/bootstrap') {
              void readJson(request)
                .then(async (body) => {
                  const result = await Effect.runPromiseExit(
                    exchangeDesktopBootstrapToken(
                      body,
                      config.desktopBootstrapToken,
                      authSessions
                    )
                  )

                  Exit.match(result, {
                    onSuccess: (value) => writeJson(response, 200, value, corsOrigin),
                    onFailure: (cause) => {
                      const failure = Cause.failureOption(cause)
                      if (Option.isSome(failure)) {
                        writeJson(response, failure.value.statusCode, failure.value.body, corsOrigin)
                        return
                      }

                      writeJson(response, 500, { error: 'Authentication failed' }, corsOrigin)
                    }
                  })
                })
                .catch((error) => {
                  writeJson(
                    response,
                    400,
                    {
                      error: error instanceof Error ? error.message : 'Invalid request body'
                    },
                    corsOrigin
                  )
                })
              return
            }

            // Serve the built web UI (public — the page loads before any session
            // exists). API routes keep priority: /health and /.well-known are handled
            // above, and `/api/*` is excluded so it never shadows an API endpoint.
            if (
              request.method === 'GET' &&
              config.staticDir &&
              !url.pathname.startsWith('/api/')
            ) {
              const resolved = resolveStaticFile(url.pathname, config.staticDir)
              if (resolved) {
                serveStaticFile(resolved, response, makeCorsHeaders(corsOrigin))
              } else {
                writeJson(response, 404, { error: 'Not Found' }, corsOrigin)
              }
              return
            }

            if (!isPublicHttpRoute(request.method, url.pathname) && !sessionStatus.authenticated) {
              writeJson(response, 401, { error: 'Unauthorized' }, corsOrigin)
              return
            }

            if (request.method === 'GET' && url.pathname === '/api/auth/session') {
              writeJson(response, 200, sessionStatus, corsOrigin)
              return
            }

            if (request.method === 'POST' && url.pathname === '/api/auth/ws-token') {
              const token = authSessions.createWebSocketToken(sessionStatus.session.accessToken)
              if (!token) {
                writeJson(response, 401, { error: 'Unauthorized' }, corsOrigin)
                return
              }

              writeJson(response, 200, { webSocketToken: token }, corsOrigin)
              return
            }

            if (request.method === 'POST' && url.pathname === '/api/events/publish') {
              void readJson(request)
                .then(async (body) => {
                  const event = eventPublishSchema.parse(body)
                  await Effect.runPromise(eventBus.publish(event))
                  writeJson(response, 200, { ok: true }, corsOrigin)
                })
                .catch((error) => {
                  writeJson(
                    response,
                    400,
                    {
                      error: error instanceof Error ? error.message : 'Invalid request body'
                    },
                    corsOrigin
                  )
                })
              return
            }

            writeJson(response, 404, { error: 'Not Found' }, corsOrigin)
          })

          const wsServer = attachWebSocketRpcServer(server, router, eventBus, {
            // When auth is disabled (loopback web serving), accept token-less
            // upgrades so a plain browser can connect without a bootstrap token.
            authenticateToken: config.requireAuth
              ? (token) => authSessions.getWebSocketToken(token) !== null
              : undefined
          })

          server.once('error', reject)
          server.listen(config.port, config.host, () => {
            server.off('error', reject)
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : config.port
            resolve({
              config,
              host: config.host,
              port,
              httpBaseUrl: `http://${config.host}:${port}`,
              wsBaseUrl: `ws://${config.host}:${port}/ws`,
              close: async () => {
                wsServer.closeAll()
                await new Promise<void>((closeResolve, closeReject) => {
                  server.close((error) => {
                    if (error) closeReject(error)
                    else closeResolve()
                  })
                })
                await cleanupWorktreeWatchers()
                await cleanupBranchWatchers()
                await import('../main/services/discord-service')
                  .then(({ discordService }) => discordService.stopListening())
                  .catch(() => undefined)
                setGitEventPublisher(null)
                setWorktreeEventPublisher(null)
                if (desktopBackendEventForwarder) {
                  process.off('message', desktopBackendEventForwarder)
                  desktopBackendEventForwarder = null
                }
              }
            })
          })
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
    })
  })

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  corsOrigin: string | null = null
): void => {
  const body = JSON.stringify(value)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...makeCorsHeaders(corsOrigin)
  })
  response.end(body)
}

const writeEmpty = (
  response: ServerResponse,
  statusCode: number,
  corsOrigin: string | null = null
): void => {
  response.writeHead(statusCode, makeCorsHeaders(corsOrigin))
  response.end()
}

const makeCorsHeaders = (corsOrigin: string | null): Record<string, string> =>
  corsOrigin
    ? {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        Vary: 'Origin'
      }
    : {}

const getAllowedCorsOrigin = (origin: string | undefined): string | null => {
  if (!origin) return null
  if (origin === 'null') return origin

  try {
    const url = new URL(origin)
    const isLoopbackHost = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(
      url.hostname
    )
    if ((url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost) {
      return origin
    }
  } catch {
    return null
  }

  return null
}

const isPublicHttpRoute = (method: string | undefined, pathname: string): boolean =>
  (method === 'GET' && pathname === '/health') ||
  (method === 'GET' && pathname === '/.well-known/hive/environment') ||
  (method === 'POST' && pathname === '/api/auth/bootstrap')

const eventPublishSchema = z
  .object({
    channel: z.string().min(1),
    payload: z.unknown()
  })
  .strict()

const readJson = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : null)
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
