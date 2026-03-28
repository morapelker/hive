import { createYoga, createSchema } from 'graphql-yoga'
import { GraphQLError } from 'graphql'
import { useServer } from 'graphql-ws/use/ws'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import type { GraphQLContext } from './context'
import { mergeResolvers } from './resolvers'
import { extractBearerToken, verifyApiKey, BruteForceTracker } from './plugins/auth'
import { handleAuthEndpoint } from './plugins/auth-endpoint'
import { createStaticHandler } from './static-handler'

function loadSchemaSDL(): string {
  const schemaDir = join(__dirname, '..', '..', 'src', 'server', 'schema')
  const files: string[] = []

  function collectGraphql(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        collectGraphql(fullPath)
      } else if (entry.name.endsWith('.graphql')) {
        files.push(readFileSync(fullPath, 'utf-8'))
      }
    }
  }

  collectGraphql(schemaDir)
  return files.join('\n')
}

export interface ServerOptions {
  port: number
  bindAddress: string
  insecure?: boolean
  tlsCert?: string
  tlsKey?: string
  webRoot?: string
  context: Omit<GraphQLContext, 'clientIp' | 'authenticated'>
  getKeyHash: () => string
  bruteForce: BruteForceTracker
}

export interface ServerHandle {
  close: () => Promise<void>
}

export function startGraphQLServer(opts: ServerOptions): ServerHandle {
  const typeDefs = loadSchemaSDL()
  const resolvers = mergeResolvers()
  const schema = createSchema({ typeDefs, resolvers })

  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    context: (ctx: { request: Request }) => {
      // Use Node.js socket remoteAddress — x-forwarded-for is client-controlled
      const nodeReq = (ctx as Record<string, unknown>).req as
        | { socket?: { remoteAddress?: string } }
        | undefined
      const clientIp = nodeReq?.socket?.remoteAddress ?? 'unknown'

      // Reject IPs that have exceeded the brute force threshold
      if (opts.bruteForce.isBlocked(clientIp)) {
        throw new GraphQLError('Too many failed authentication attempts', {
          extensions: { http: { status: 429 } }
        })
      }

      const token = extractBearerToken(ctx.request.headers.get('authorization'))

      if (!token) {
        throw new GraphQLError('Authentication required', {
          extensions: { http: { status: 401 } }
        })
      }

      const hash = opts.getKeyHash()
      if (!verifyApiKey(token, hash)) {
        opts.bruteForce.recordFailure(clientIp)
        throw new GraphQLError('Invalid API key', {
          extensions: { http: { status: 401 } }
        })
      }

      opts.bruteForce.recordSuccess(clientIp)

      return {
        ...opts.context,
        clientIp,
        authenticated: true
      }
    }
  })

  const staticHandler = opts.webRoot ? createStaticHandler(opts.webRoot) : null

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/'
    const pathname = url.split('?')[0]

    // 1. Auth endpoint (async)
    if (req.method === 'POST' && pathname === '/api/auth/validate') {
      handleAuthEndpoint(req, res, opts.getKeyHash, opts.bruteForce).catch(() => {
        if (!res.writableEnded) {
          res.writeHead(500)
          res.end()
        }
      })
      return
    }

    // 2. GraphQL path -- always handled by yoga
    if (pathname === '/graphql' || pathname.startsWith('/graphql/')) {
      yoga(req, res)
      return
    }

    // 3. Static handler (if configured), falling back to yoga
    if (staticHandler && staticHandler(req, res)) {
      return
    }

    // 4. Fallback to yoga for any unmatched routes
    yoga(req, res)
  }

  const server = opts.insecure
    ? createHttpServer(requestHandler)
    : createHttpsServer(
        {
          cert: readFileSync(opts.tlsCert!),
          key: readFileSync(opts.tlsKey!)
        },
        requestHandler
      )

  const wss = new WebSocketServer({
    server,
    path: yoga.graphqlEndpoint
  })

  useServer(
    {
      schema,
      context: (ctx) => ({
        ...opts.context,
        clientIp:
          (ctx.extra as { request: { socket: { remoteAddress?: string } } }).request.socket
            .remoteAddress || 'unknown',
        authenticated: true
      }),
      onConnect: (ctx) => {
        const clientIp =
          (ctx.extra as { request: { socket: { remoteAddress?: string } } }).request.socket
            .remoteAddress || 'unknown'

        if (opts.bruteForce.isBlocked(clientIp)) return false

        const apiKey = ctx.connectionParams?.apiKey as string | undefined
        if (!apiKey) return false
        const hash = opts.getKeyHash()
        if (!verifyApiKey(apiKey, hash)) {
          opts.bruteForce.recordFailure(clientIp)
          return false
        }
        opts.bruteForce.recordSuccess(clientIp)
        return true
      }
    },
    wss
  )

  server.listen(opts.port, opts.bindAddress)

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close(() => {
          server.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      })
  }
}
