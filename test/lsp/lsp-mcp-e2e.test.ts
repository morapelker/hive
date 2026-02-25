import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { LspService } from '../../src/main/services/lsp/lsp-service'
import * as lspServers from '../../src/main/services/lsp/lsp-servers'
import type {
  LspServerDefinition,
  LspServerHandle
} from '../../src/main/services/lsp/lsp-types'
import { createLspToolHandler } from '../../src/main/services/lsp/lsp-mcp-server'

const FAKE_SERVER_PATH = path.join(__dirname, 'fixture', 'fake-lsp-server.js')

function spawnFakeServer(): LspServerHandle {
  const proc = spawn('node', [FAKE_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return { process: proc }
}

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

describe('LSP MCP E2E', () => {
  let service: LspService
  let tmpDir: string
  let testFilePath: string
  let getServersForFileSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-mcp-e2e-'))
    testFilePath = path.join(tmpDir, 'test.ts')
    fs.writeFileSync(testFilePath, 'const x: number = 1\n')
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
    getServersForFileSpy = vi
      .spyOn(lspServers, 'getServersForFile')
      .mockReturnValue(defs)
  }

  it('goToDefinition end-to-end: handler -> service -> client -> fake server -> JSON output', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    const handler = createLspToolHandler(service, tmpDir)

    const result = await handler({
      operation: 'goToDefinition',
      filePath: testFilePath,
      line: 1,
      character: 7
    })

    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')

    const parsed = JSON.parse(result.content[0].text)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed[0].uri).toBeDefined()
    expect(parsed[0].range).toBeDefined()
  })

  it('hover end-to-end: handler -> service -> client -> fake server -> JSON output', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    const handler = createLspToolHandler(service, tmpDir)

    const result = await handler({
      operation: 'hover',
      filePath: testFilePath,
      line: 1,
      character: 7
    })

    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)

    const parsed = JSON.parse(result.content[0].text)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed[0].contents).toBeDefined()
    expect(parsed[0].contents.kind).toBe('markdown')
  })

  it('error path: non-existent file returns isError', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    const handler = createLspToolHandler(service, tmpDir)

    const result = await handler({
      operation: 'goToDefinition',
      filePath: path.join(tmpDir, 'does-not-exist.ts'),
      line: 1,
      character: 1
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('File not found')
  })

  it('documentSymbol end-to-end', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    const handler = createLspToolHandler(service, tmpDir)

    const result = await handler({
      operation: 'documentSymbol',
      filePath: testFilePath
    })

    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed[0].name).toBe('hello')
  })

  it('findReferences end-to-end', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    const handler = createLspToolHandler(service, tmpDir)

    const result = await handler({
      operation: 'findReferences',
      filePath: testFilePath,
      line: 1,
      character: 7
    })

    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThanOrEqual(2)
  })

  it('relative path resolves against projectRoot', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    const handler = createLspToolHandler(service, tmpDir)

    const result = await handler({
      operation: 'goToDefinition',
      filePath: 'test.ts',
      line: 1,
      character: 7
    })

    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.length).toBeGreaterThan(0)
  })

  it('diagnostics end-to-end returns file diagnostics', async () => {
    const fakeDef = createFakeServerDef()
    mockServersForFile([fakeDef])

    // Must open a file first to populate diagnostics
    await service.touchFile(testFilePath, true)

    const handler = createLspToolHandler(service, tmpDir)

    const result = await handler({
      operation: 'diagnostics',
      filePath: ''
    })

    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    // Diagnostics should have at least the test file entry
    const keys = Object.keys(parsed)
    expect(keys.length).toBeGreaterThan(0)
  })
})
