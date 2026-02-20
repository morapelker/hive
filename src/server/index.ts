import { createYoga, createSchema, GraphQLError } from 'graphql-yoga'
import { useServer } from 'graphql-ws/use/ws'
import { createServer } from 'node:https'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import type { GraphQLContext } from './context'
import { mergeResolvers } from './resolvers'
import { extractBearerToken, verifyApiKey, BruteForceTracker } from './plugins/auth'

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
  tlsCert: string
  tlsKey: string
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

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
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
      let authenticated = false

      if (token) {
        const hash = opts.getKeyHash()
        if (verifyApiKey(token, hash)) {
          authenticated = true
          opts.bruteForce.recordSuccess(clientIp)
        } else {
          opts.bruteForce.recordFailure(clientIp)
        }
      }

      return {
        ...opts.context,
        clientIp,
        authenticated
      }
    }
  })

  const httpsServer = createServer(
    {
      cert: readFileSync(opts.tlsCert),
      key: readFileSync(opts.tlsKey)
    },
    yoga
  )

  const wss = new WebSocketServer({
    server: httpsServer,
    path: yoga.graphqlEndpoint
  })

  useServer(
    {
      execute: (args: unknown) => (args as { rootValue: never }).rootValue,
      subscribe: (args: unknown) => (args as { rootValue: never }).rootValue,
      context: (ctx) => ({
        ...opts.context,
        clientIp:
          (ctx.extra as { request: { socket: { remoteAddress?: string } } })
            .request.socket.remoteAddress || 'unknown',
        authenticated: true
      }),
      onConnect: (ctx) => {
        const clientIp =
          (ctx.extra as { request: { socket: { remoteAddress?: string } } })
            .request.socket.remoteAddress || 'unknown'

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

  httpsServer.listen(opts.port, opts.bindAddress)

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close(() => {
          httpsServer.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      })
  }
}
