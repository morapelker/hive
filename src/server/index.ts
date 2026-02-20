import { createYoga, createSchema } from 'graphql-yoga'
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
    context: ({ request }: { request: Request }) => {
      const clientIp =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        'unknown'
      const token = extractBearerToken(request.headers.get('authorization'))
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
        const apiKey = ctx.connectionParams?.apiKey as string | undefined
        if (!apiKey) return false
        const hash = opts.getKeyHash()
        if (!verifyApiKey(apiKey, hash)) return false
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
