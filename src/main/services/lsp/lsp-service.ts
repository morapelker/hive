import { pathToFileURL, fileURLToPath } from 'url'
import { createLspClient, type LspClient } from './lsp-client'
import { findProjectRoot, getServersForFile } from './lsp-servers'
import type { LspPosition, LspServerDefinition } from './lsp-types'

/**
 * Core LSP service that manages language server clients for a project.
 * Spawns clients on demand, caches them by server+root, and dispatches
 * LSP operations across all relevant clients.
 */
export class LspService {
  private projectRoot: string
  private clients: LspClient[] = []
  private servers = new Map<string, LspClient>()
  private broken = new Set<string>()
  private spawning = new Map<string, Promise<LspClient | undefined>>()

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
  }

  /**
   * Get the project root path.
   */
  getProjectRoot(): string {
    return this.projectRoot
  }

  /**
   * Check if at least one non-broken server could handle the file.
   */
  async hasClients(filePath: string): Promise<boolean> {
    const defs = getServersForFile(filePath)
    if (defs.length === 0) return false

    for (const def of defs) {
      const root = findProjectRoot(filePath, def.rootMarkers, this.projectRoot)
      const cacheKey = `${def.id}:${root}`
      if (!this.broken.has(cacheKey)) {
        return true
      }
    }
    return false
  }

  /**
   * Get (or spawn) all LSP clients that can handle the given file.
   * Deduplicates in-flight spawns and marks broken servers on failure.
   */
  async getClients(filePath: string): Promise<LspClient[]> {
    const defs = getServersForFile(filePath)
    if (defs.length === 0) return []

    const result: LspClient[] = []

    for (const def of defs) {
      const root = findProjectRoot(filePath, def.rootMarkers, this.projectRoot)
      const cacheKey = `${def.id}:${root}`

      // Skip broken servers
      if (this.broken.has(cacheKey)) continue

      // Check cache
      const cached = this.servers.get(cacheKey)
      if (cached) {
        result.push(cached)
        continue
      }

      // Dedup in-flight spawns
      let spawnPromise = this.spawning.get(cacheKey)
      if (!spawnPromise) {
        spawnPromise = this.spawnClient(def, root, cacheKey)
        this.spawning.set(cacheKey, spawnPromise)
      }

      const client = await spawnPromise
      if (client) {
        result.push(client)
      }
    }

    return result
  }

  /**
   * Open a file on all matching clients, optionally waiting for diagnostics.
   */
  async touchFile(
    filePath: string,
    waitForDiagnostics?: boolean
  ): Promise<void> {
    const clients = await this.getClients(filePath)

    for (const client of clients) {
      await client.notify.open(filePath)
      if (waitForDiagnostics) {
        await client.waitForDiagnostics(filePath)
      }
    }
  }

  // --- 9 LSP operations ---

  async goToDefinition(pos: LspPosition) {
    const clients = await this.getClients(pos.file)
    const results: unknown[] = []

    for (const client of clients) {
      try {
        const uri = pathToFileURL(pos.file).toString()
        const res = await client.connection.sendRequest('textDocument/definition', {
          textDocument: { uri },
          position: { line: pos.line, character: pos.character }
        })
        if (res) {
          const items = Array.isArray(res) ? res : [res]
          results.push(...items)
        }
      } catch {
        // Client may have crashed — skip and continue
      }
    }

    return results
  }

  async hover(pos: LspPosition) {
    const clients = await this.getClients(pos.file)
    const results: unknown[] = []

    for (const client of clients) {
      try {
        const uri = pathToFileURL(pos.file).toString()
        const res = await client.connection.sendRequest('textDocument/hover', {
          textDocument: { uri },
          position: { line: pos.line, character: pos.character }
        })
        if (res) {
          results.push(res)
        }
      } catch {
        // Client may have crashed — skip and continue
      }
    }

    return results
  }

  async findReferences(pos: LspPosition) {
    const clients = await this.getClients(pos.file)
    const results: unknown[] = []

    for (const client of clients) {
      try {
        const uri = pathToFileURL(pos.file).toString()
        const res = await client.connection.sendRequest('textDocument/references', {
          textDocument: { uri },
          position: { line: pos.line, character: pos.character },
          context: { includeDeclaration: true }
        })
        if (res) {
          const items = Array.isArray(res) ? res : [res]
          results.push(...items)
        }
      } catch {
        // Client may have crashed — skip and continue
      }
    }

    return results
  }

  async documentSymbol(filePath: string) {
    const clients = await this.getClients(filePath)
    const results: unknown[] = []

    for (const client of clients) {
      try {
        const uri = pathToFileURL(filePath).toString()
        const res = await client.connection.sendRequest('textDocument/documentSymbol', {
          textDocument: { uri }
        })
        if (res) {
          const items = Array.isArray(res) ? res : [res]
          results.push(...items)
        }
      } catch {
        // Client may have crashed — skip and continue
      }
    }

    return results
  }

  /**
   * Search for symbols across the workspace.
   * Only queries clients that have already been spawned (via getClients or touchFile).
   */
  async workspaceSymbol(query = '') {
    // Gather unique clients from all cached servers
    const seen = new Set<LspClient>()
    const clients: LspClient[] = []
    for (const client of this.servers.values()) {
      if (!seen.has(client)) {
        seen.add(client)
        clients.push(client)
      }
    }

    const results: unknown[] = []

    for (const client of clients) {
      try {
        const res = await client.connection.sendRequest('workspace/symbol', {
          query
        })
        if (res) {
          const items = Array.isArray(res) ? res : [res]
          results.push(...items)
        }
      } catch {
        // Client may have crashed — skip and continue
      }
    }

    return results
  }

  async goToImplementation(pos: LspPosition) {
    const clients = await this.getClients(pos.file)
    const results: unknown[] = []

    for (const client of clients) {
      try {
        const uri = pathToFileURL(pos.file).toString()
        const res = await client.connection.sendRequest('textDocument/implementation', {
          textDocument: { uri },
          position: { line: pos.line, character: pos.character }
        })
        if (res) {
          const items = Array.isArray(res) ? res : [res]
          results.push(...items)
        }
      } catch {
        // Client may have crashed — skip and continue
      }
    }

    return results
  }

  async incomingCalls(pos: LspPosition) {
    const clients = await this.getClients(pos.file)
    const results: unknown[] = []

    for (const client of clients) {
      try {
        const uri = pathToFileURL(pos.file).toString()
        const items = await client.connection.sendRequest(
          'textDocument/prepareCallHierarchy',
          {
            textDocument: { uri },
            position: { line: pos.line, character: pos.character }
          }
        ) as unknown[] | null

        if (items && Array.isArray(items)) {
          for (const item of items) {
            const calls = await client.connection.sendRequest(
              'callHierarchy/incomingCalls',
              { item }
            )
            if (calls) {
              const callItems = Array.isArray(calls) ? calls : [calls]
              results.push(...callItems)
            }
          }
        }
      } catch {
        // Client may have crashed — skip and continue
      }
    }

    return results
  }

  async outgoingCalls(pos: LspPosition) {
    const clients = await this.getClients(pos.file)
    const results: unknown[] = []

    for (const client of clients) {
      try {
        const uri = pathToFileURL(pos.file).toString()
        const items = await client.connection.sendRequest(
          'textDocument/prepareCallHierarchy',
          {
            textDocument: { uri },
            position: { line: pos.line, character: pos.character }
          }
        ) as unknown[] | null

        if (items && Array.isArray(items)) {
          for (const item of items) {
            const calls = await client.connection.sendRequest(
              'callHierarchy/outgoingCalls',
              { item }
            )
            if (calls) {
              const callItems = Array.isArray(calls) ? calls : [calls]
              results.push(...callItems)
            }
          }
        }
      } catch {
        // Client may have crashed — skip and continue
      }
    }

    return results
  }

  /**
   * Aggregate diagnostics from all connected clients.
   * Returns a map of file path to diagnostics array.
   */
  async diagnostics(): Promise<Map<string, unknown[]>> {
    const result = new Map<string, unknown[]>()

    for (const client of this.clients) {
      for (const [uri, diags] of client.diagnostics) {
        const filePath = fileURLToPath(uri)
        const existing = result.get(filePath) ?? []
        existing.push(...diags)
        result.set(filePath, existing)
      }
    }

    return result
  }

  /**
   * Shut down all clients and clear all state.
   */
  async shutdown(): Promise<void> {
    const shutdownPromises = this.clients.map((client) =>
      client.shutdown().catch(() => {})
    )
    await Promise.all(shutdownPromises)

    this.clients = []
    this.servers.clear()
    this.broken.clear()
    this.spawning.clear()
  }

  // --- Private helpers ---

  private async spawnClient(
    def: LspServerDefinition,
    root: string,
    cacheKey: string
  ): Promise<LspClient | undefined> {
    try {
      const handle = await def.spawn(root)
      if (!handle) {
        this.broken.add(cacheKey)
        return undefined
      }

      const client = await createLspClient({
        serverID: def.id,
        server: handle,
        root
      })

      this.servers.set(cacheKey, client)
      this.clients.push(client)
      return client
    } catch {
      this.broken.add(cacheKey)
      return undefined
    } finally {
      this.spawning.delete(cacheKey)
    }
  }
}
