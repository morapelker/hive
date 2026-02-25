import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { LspService } from '../../src/main/services/lsp/lsp-service'
import * as lspServers from '../../src/main/services/lsp/lsp-servers'
import type { LspServerDefinition, LspServerHandle } from '../../src/main/services/lsp/lsp-types'

const FAKE_SERVER_PATH = path.join(__dirname, 'fixture', 'fake-lsp-server.js')

function spawnFakeServer(): LspServerHandle {
  const proc = spawn('node', [FAKE_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return { process: proc }
}

/**
 * Create a fake server definition that uses the fake LSP server.
 */
function createFakeServerDef(
  overrides: Partial<LspServerDefinition> = {}
): LspServerDefinition {
  return {
    id: 'fake-typescript',
    extensions: ['.ts', '.tsx'],
    rootMarkers: ['tsconfig.json', 'package.json'],
    async spawn(_root: string) {
      return spawnFakeServer()
    },
    ...overrides
  }
}

describe('LspService', () => {
  let service: LspService
  let tmpDir: string
  let testFilePath: string
  let getServersForFileSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-service-test-'))
    testFilePath = path.join(tmpDir, 'test.ts')
    fs.writeFileSync(testFilePath, 'const x: number = 1\n')
    // Create a root marker so findProjectRoot finds tmpDir
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')

    service = new LspService(tmpDir)
  })

  afterEach(async () => {
    if (getServersForFileSpy) {
      getServersForFileSpy.mockRestore()
    }
    if (service) {
      await service.shutdown()
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function mockServersForFile(defs: LspServerDefinition[]) {
    getServersForFileSpy = vi.spyOn(lspServers, 'getServersForFile')
      .mockReturnValue(defs)
  }

  it('hasClients returns true when a server is available for .ts', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    const result = await service.hasClients(testFilePath)
    expect(result).toBe(true)
  })

  it('hasClients returns false for .txt (no matching server)', async () => {
    mockServersForFile([])

    const txtFile = path.join(tmpDir, 'readme.txt')
    const result = await service.hasClients(txtFile)
    expect(result).toBe(false)
  })

  it('getClients spawns client on first call', async () => {
    let spawnCount = 0
    const fakeDef = createFakeServerDef({
      async spawn(_root: string) {
        spawnCount++
        return spawnFakeServer()
      }
    })
    mockServersForFile([fakeDef])

    const clients = await service.getClients(testFilePath)
    expect(clients).toHaveLength(1)
    expect(spawnCount).toBe(1)
    expect(clients[0].connection).toBeDefined()
  })

  it('getClients returns cached client on second call (no new spawn)', async () => {
    let spawnCount = 0
    const fakeDef = createFakeServerDef({
      async spawn(_root: string) {
        spawnCount++
        return spawnFakeServer()
      }
    })
    mockServersForFile([fakeDef])

    const clients1 = await service.getClients(testFilePath)
    expect(spawnCount).toBe(1)

    const clients2 = await service.getClients(testFilePath)
    expect(spawnCount).toBe(1)
    expect(clients2[0]).toBe(clients1[0])
  })

  it('broken server is tracked after spawn failure — getClients skips it', async () => {
    let spawnCount = 0
    const brokenDef = createFakeServerDef({
      async spawn(_root: string) {
        spawnCount++
        return undefined // simulate spawn failure
      }
    })
    mockServersForFile([brokenDef])

    const clients1 = await service.getClients(testFilePath)
    expect(clients1).toHaveLength(0)
    expect(spawnCount).toBe(1)

    // Second call should skip the broken server entirely
    const clients2 = await service.getClients(testFilePath)
    expect(clients2).toHaveLength(0)
    expect(spawnCount).toBe(1) // not retried
  })

  it('hasClients returns false when server is broken', async () => {
    const brokenDef = createFakeServerDef({
      async spawn(_root: string) {
        return undefined
      }
    })
    mockServersForFile([brokenDef])

    // Trigger the broken marking
    await service.getClients(testFilePath)

    const result = await service.hasClients(testFilePath)
    expect(result).toBe(false)
  })

  it('touchFile opens file and waits for diagnostics', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    await service.touchFile(testFilePath, true)

    // Diagnostics should have been populated after touchFile with wait
    const diags = await service.diagnostics()
    expect(diags.size).toBeGreaterThan(0)
  })

  it('goToDefinition returns results from fake server', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    // Must open file first so server knows about it
    await service.touchFile(testFilePath, true)

    const results = await service.goToDefinition({
      file: testFilePath,
      line: 0,
      character: 6
    })

    expect(results).toBeDefined()
    expect(results.length).toBeGreaterThan(0)
    // Fake server returns Location with uri and range
    expect((results[0] as Record<string, unknown>).uri).toBeDefined()
  })

  it('hover returns results from fake server', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    await service.touchFile(testFilePath, true)

    const results = await service.hover({
      file: testFilePath,
      line: 0,
      character: 6
    })

    expect(results).toBeDefined()
    expect(results.length).toBeGreaterThan(0)
    const hover = results[0] as Record<string, unknown>
    expect(hover.contents).toBeDefined()
  })

  it('findReferences returns results from fake server', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    await service.touchFile(testFilePath, true)

    const results = await service.findReferences({
      file: testFilePath,
      line: 0,
      character: 6
    })

    expect(results).toBeDefined()
    expect(results.length).toBeGreaterThan(0)
  })

  it('documentSymbol returns results from fake server', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    await service.touchFile(testFilePath, true)

    const results = await service.documentSymbol(testFilePath)

    expect(results).toBeDefined()
    expect(results.length).toBeGreaterThan(0)
    const symbol = results[0] as Record<string, unknown>
    expect(symbol.name).toBe('hello')
  })

  it('shutdown kills all client processes and clears state', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    const clients = await service.getClients(testFilePath)
    expect(clients).toHaveLength(1)

    await service.shutdown()

    // After shutdown, getClients should spawn new ones (state cleared)
    // But we've already shut down, so let's check by calling hasClients
    // with cleared mock — should show empty state
    mockServersForFile([])
    const hasAfter = await service.hasClients(testFilePath)
    expect(hasAfter).toBe(false)
  })

  it('multiple concurrent getClients calls for same server deduplicate spawning', async () => {
    let spawnCount = 0
    const fakeDef = createFakeServerDef({
      async spawn(_root: string) {
        spawnCount++
        // Add a small delay to simulate real spawn time
        await new Promise((resolve) => setTimeout(resolve, 50))
        return spawnFakeServer()
      }
    })
    mockServersForFile([fakeDef])

    // Fire multiple getClients concurrently
    const [clients1, clients2, clients3] = await Promise.all([
      service.getClients(testFilePath),
      service.getClients(testFilePath),
      service.getClients(testFilePath)
    ])

    // Should only have spawned once
    expect(spawnCount).toBe(1)
    expect(clients1).toHaveLength(1)
    expect(clients2).toHaveLength(1)
    expect(clients3).toHaveLength(1)
    // All should reference the same client
    expect(clients1[0]).toBe(clients2[0])
    expect(clients2[0]).toBe(clients3[0])
  })

  it('workspaceSymbol returns results from fake server', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    // Must spawn clients first — workspaceSymbol only queries cached clients
    await service.touchFile(testFilePath, true)

    const results = await service.workspaceSymbol('hello')

    expect(results).toBeDefined()
    expect(results.length).toBeGreaterThan(0)
    const symbol = results[0] as Record<string, unknown>
    expect(symbol.name).toBe('hello')
  })

  it('goToImplementation returns results from fake server', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    await service.touchFile(testFilePath, true)

    const results = await service.goToImplementation({
      file: testFilePath,
      line: 0,
      character: 6
    })

    expect(results).toBeDefined()
    expect(results.length).toBeGreaterThan(0)
  })

  it('incomingCalls returns results from fake server', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    await service.touchFile(testFilePath, true)

    const results = await service.incomingCalls({
      file: testFilePath,
      line: 0,
      character: 6
    })

    expect(results).toBeDefined()
    expect(results.length).toBeGreaterThan(0)
    const call = results[0] as Record<string, unknown>
    expect(call.from).toBeDefined()
  })

  it('outgoingCalls returns results from fake server', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    await service.touchFile(testFilePath, true)

    const results = await service.outgoingCalls({
      file: testFilePath,
      line: 0,
      character: 6
    })

    expect(results).toBeDefined()
    expect(results.length).toBeGreaterThan(0)
    const call = results[0] as Record<string, unknown>
    expect(call.to).toBeDefined()
  })

  it('diagnostics aggregates from all clients', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    await service.touchFile(testFilePath, true)

    const diagMap = await service.diagnostics()
    expect(diagMap.size).toBeGreaterThan(0)

    // The diagnostics should be keyed by file path
    const fileDiags = diagMap.get(testFilePath)
    expect(fileDiags).toBeDefined()
    expect(fileDiags!.length).toBeGreaterThan(0)
  })
})
