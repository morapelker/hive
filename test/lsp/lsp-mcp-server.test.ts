import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { createLspToolHandler } from '../../src/main/services/lsp/lsp-mcp-server'
import type { LspService } from '../../src/main/services/lsp/lsp-service'

/**
 * Create a mock LspService with all methods stubbed.
 */
function createMockLspService(
  projectRoot: string,
  overrides: Partial<Record<keyof LspService, unknown>> = {}
): LspService {
  return {
    getProjectRoot: vi.fn().mockReturnValue(projectRoot),
    hasClients: vi.fn().mockResolvedValue(true),
    getClients: vi.fn().mockResolvedValue([]),
    touchFile: vi.fn().mockResolvedValue(undefined),
    goToDefinition: vi.fn().mockResolvedValue([{ uri: 'file:///mock/file.ts', range: { start: { line: 10, character: 0 }, end: { line: 10, character: 15 } } }]),
    hover: vi.fn().mockResolvedValue([{ contents: { kind: 'markdown', value: '```ts\nconst x: number\n```' } }]),
    findReferences: vi.fn().mockResolvedValue([{ uri: 'file:///mock/file.ts', range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } } }]),
    documentSymbol: vi.fn().mockResolvedValue([{ name: 'hello', kind: 12 }]),
    workspaceSymbol: vi.fn().mockResolvedValue([{ name: 'hello', kind: 12, location: {} }]),
    goToImplementation: vi.fn().mockResolvedValue([{ uri: 'file:///mock/impl.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } }]),
    incomingCalls: vi.fn().mockResolvedValue([{ from: { name: 'caller' } }]),
    outgoingCalls: vi.fn().mockResolvedValue([{ to: { name: 'callee' } }]),
    diagnostics: vi.fn().mockResolvedValue(new Map([
      ['/mock/file.ts', [{ severity: 1, message: 'error' }]]
    ])),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as LspService
}

describe('createLspToolHandler', () => {
  let tmpDir: string
  let testFilePath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-mcp-test-'))
    testFilePath = path.join(tmpDir, 'test.ts')
    fs.writeFileSync(testFilePath, 'const x: number = 1\n')
  })

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('goToDefinition calls lspService.goToDefinition with 0-based position', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'goToDefinition',
      filePath: testFilePath,
      line: 10,
      character: 5
    })

    expect(mockService.goToDefinition).toHaveBeenCalledWith({
      file: testFilePath,
      line: 9,
      character: 4
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].type).toBe('text')
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].uri).toBe('file:///mock/file.ts')
  })

  it('converts line: 10, character: 5 to line: 9, character: 4', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    await handler({
      operation: 'goToDefinition',
      filePath: testFilePath,
      line: 10,
      character: 5
    })

    expect(mockService.goToDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ line: 9, character: 4 })
    )
  })

  it('returns isError: true when file does not exist', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'goToDefinition',
      filePath: path.join(tmpDir, 'nonexistent.ts'),
      line: 1,
      character: 1
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('File not found')
  })

  it('returns isError: true when hasClients() returns false', async () => {
    const mockService = createMockLspService(tmpDir, {
      hasClients: vi.fn().mockResolvedValue(false)
    })
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'goToDefinition',
      filePath: testFilePath,
      line: 1,
      character: 1
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No language server available')
  })

  it('hover calls lspService.hover()', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'hover',
      filePath: testFilePath,
      line: 1,
      character: 1
    })

    expect(mockService.hover).toHaveBeenCalledWith({
      file: testFilePath,
      line: 0,
      character: 0
    })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed[0].contents.kind).toBe('markdown')
  })

  it('findReferences calls lspService.findReferences()', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    await handler({
      operation: 'findReferences',
      filePath: testFilePath,
      line: 5,
      character: 3
    })

    expect(mockService.findReferences).toHaveBeenCalledWith({
      file: testFilePath,
      line: 4,
      character: 2
    })
  })

  it('documentSymbol calls lspService.documentSymbol() with file path', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'documentSymbol',
      filePath: testFilePath
    })

    expect(mockService.documentSymbol).toHaveBeenCalledWith(testFilePath)
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed[0].name).toBe('hello')
  })

  it('workspaceSymbol calls lspService.workspaceSymbol()', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'workspaceSymbol',
      filePath: 'hello'
    })

    expect(mockService.workspaceSymbol).toHaveBeenCalledWith('hello')
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed[0].name).toBe('hello')
  })

  it('returns JSON stringified results on success', async () => {
    const mockResults = [
      { uri: 'file:///a.ts', range: { start: { line: 1, character: 0 } } },
      { uri: 'file:///b.ts', range: { start: { line: 2, character: 5 } } }
    ]
    const mockService = createMockLspService(tmpDir, {
      goToDefinition: vi.fn().mockResolvedValue(mockResults)
    })
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'goToDefinition',
      filePath: testFilePath,
      line: 1,
      character: 1
    })

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toEqual(mockResults)
  })

  it('returns "No results found" when operation returns empty array', async () => {
    const mockService = createMockLspService(tmpDir, {
      goToDefinition: vi.fn().mockResolvedValue([])
    })
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'goToDefinition',
      filePath: testFilePath,
      line: 1,
      character: 1
    })

    expect(result.content[0].text).toBe('No results found')
    expect(result.isError).toBeUndefined()
  })

  it('relative file path resolved against project root', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    await handler({
      operation: 'goToDefinition',
      filePath: 'test.ts',
      line: 1,
      character: 1
    })

    // The resolved path should be tmpDir/test.ts
    expect(mockService.hasClients).toHaveBeenCalledWith(
      path.join(tmpDir, 'test.ts')
    )
    expect(mockService.goToDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ file: path.join(tmpDir, 'test.ts') })
    )
  })

  it('goToImplementation calls lspService.goToImplementation()', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    await handler({
      operation: 'goToImplementation',
      filePath: testFilePath,
      line: 1,
      character: 1
    })

    expect(mockService.goToImplementation).toHaveBeenCalledWith({
      file: testFilePath,
      line: 0,
      character: 0
    })
  })

  it('incomingCalls calls lspService.incomingCalls()', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    await handler({
      operation: 'incomingCalls',
      filePath: testFilePath,
      line: 1,
      character: 1
    })

    expect(mockService.incomingCalls).toHaveBeenCalledWith({
      file: testFilePath,
      line: 0,
      character: 0
    })
  })

  it('outgoingCalls calls lspService.outgoingCalls()', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    await handler({
      operation: 'outgoingCalls',
      filePath: testFilePath,
      line: 1,
      character: 1
    })

    expect(mockService.outgoingCalls).toHaveBeenCalledWith({
      file: testFilePath,
      line: 0,
      character: 0
    })
  })

  it('diagnostics calls lspService.diagnostics() and returns all', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'diagnostics',
      filePath: ''
    })

    expect(mockService.diagnostics).toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed['/mock/file.ts']).toBeDefined()
    expect(parsed['/mock/file.ts'][0].severity).toBe(1)
  })

  it('returns error when position-based operation is missing line/character', async () => {
    const mockService = createMockLspService(tmpDir)
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'goToDefinition',
      filePath: testFilePath
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('requires line and character')
  })

  it('catches and wraps errors from service methods', async () => {
    const mockService = createMockLspService(tmpDir, {
      goToDefinition: vi.fn().mockRejectedValue(new Error('Connection lost'))
    })
    const handler = createLspToolHandler(mockService)

    const result = await handler({
      operation: 'goToDefinition',
      filePath: testFilePath,
      line: 1,
      character: 1
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('LSP error: Connection lost')
  })
})

describe('createLspMcpServerConfig', () => {
  it('returns object with type: "sdk", name: "hive-lsp", and instance', async () => {
    // Dynamically import the SDK-dependent factory function
    const { createLspMcpServerConfig } = await import(
      '../../src/main/services/lsp/lsp-mcp-server'
    )

    const mockService = createMockLspService('/mock/project')
    const config = await createLspMcpServerConfig(mockService)

    expect(config.type).toBe('sdk')
    expect(config.name).toBe('hive-lsp')
    expect(config.instance).toBeDefined()
  })
})
