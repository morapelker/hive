/**
 * Test server helper — creates a graphql-yoga instance with mock context
 * for integration-testing resolvers via yoga.fetch() (no HTTP server needed).
 */

import { createYoga, createSchema } from 'graphql-yoga'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mergeResolvers } from '../../../src/server/resolvers'
import type { MockDatabaseService } from './mock-db'

// ---------------------------------------------------------------------------
// Schema loader (mirrors src/server/index.ts loadSchemaSDL)
// ---------------------------------------------------------------------------

function loadSchemaSDL(): string {
  const schemaDir = join(__dirname, '..', '..', '..', 'src', 'server', 'schema')
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

// ---------------------------------------------------------------------------
// createTestServer
// ---------------------------------------------------------------------------

export function createTestServer(
  mockDb: MockDatabaseService,
  contextOverrides?: Record<string, unknown>
) {
  const typeDefs = loadSchemaSDL()
  const resolvers = mergeResolvers()

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    context: {
      db: mockDb,
      authenticated: true,
      clientIp: '127.0.0.1',
      // Stubs for other context fields that resolvers may reference in future
      sdkManager: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      eventBus: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      ...contextOverrides
    }
  })

  return {
    /**
     * Execute a GraphQL query/mutation and return the parsed JSON response.
     */
    execute: async (
      query: string,
      variables?: Record<string, unknown>
    ): Promise<{ data?: any; errors?: any[] }> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const response = await yoga.fetch('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables })
      })
      return response.json() as any // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  }
}
