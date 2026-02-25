import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'

const FAKE_SERVER_PATH = path.join(__dirname, 'fixture', 'fake-lsp-server.js')

// --- JSON-RPC transport helpers ---

function sendMessage(proc: ChildProcess, msg: Record<string, unknown>): void {
  const body = JSON.stringify(msg)
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
  proc.stdin!.write(header + body)
}

function sendRequest(
  proc: ChildProcess,
  id: number,
  method: string,
  params?: Record<string, unknown>
): void {
  sendMessage(proc, { jsonrpc: '2.0', id, method, params: params ?? {} })
}

function sendNotification(
  proc: ChildProcess,
  method: string,
  params?: Record<string, unknown>
): void {
  sendMessage(proc, { jsonrpc: '2.0', method, params: params ?? {} })
}

interface JsonRpcMessage {
  jsonrpc: string
  id?: number
  method?: string
  result?: unknown
  params?: unknown
  error?: { code: number; message: string }
}

function collectMessages(
  proc: ChildProcess,
  count: number,
  timeout = 5000
): Promise<JsonRpcMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: JsonRpcMessage[] = []
    let buf = ''
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for ${count} messages (got ${messages.length}): ${JSON.stringify(messages)}`
        )
      )
    }, timeout)

    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      while (true) {
        const hEnd = buf.indexOf('\r\n\r\n')
        if (hEnd === -1) return
        const match = buf.slice(0, hEnd).match(/Content-Length:\s*(\d+)/i)
        if (!match) {
          buf = buf.slice(hEnd + 4)
          continue
        }
        const len = parseInt(match[1], 10)
        const bodyStart = hEnd + 4
        if (buf.length < bodyStart + len) return
        const body = buf.slice(bodyStart, bodyStart + len)
        buf = buf.slice(bodyStart + len)
        try {
          messages.push(JSON.parse(body))
        } catch {
          // ignore parse errors
        }
        if (messages.length >= count) {
          clearTimeout(timer)
          resolve(messages)
          return
        }
      }
    })
  })
}

function waitForResponse(
  proc: ChildProcess,
  timeout = 5000
): Promise<JsonRpcMessage> {
  return collectMessages(proc, 1, timeout).then((msgs) => msgs[0])
}

// --- Tests ---

describe('Fake LSP Server', () => {
  let server: ChildProcess

  function startServer(): ChildProcess {
    server = spawn('node', [FAKE_SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return server
  }

  afterEach(() => {
    if (server && !server.killed) {
      server.stdin!.end()
      server.kill()
    }
  })

  it('responds to initialize with capabilities', async () => {
    startServer()
    const responsePromise = waitForResponse(server)
    sendRequest(server, 1, 'initialize', {
      capabilities: {},
      rootUri: 'file:///mock'
    })
    const response = await responsePromise

    expect(response.id).toBe(1)
    expect(response.result).toBeDefined()
    const result = response.result as Record<string, unknown>
    expect(result.capabilities).toBeDefined()
    const caps = result.capabilities as Record<string, unknown>
    expect(caps.definitionProvider).toBe(true)
    expect(caps.hoverProvider).toBe(true)
    expect(caps.referencesProvider).toBe(true)
    expect(caps.documentSymbolProvider).toBe(true)
    expect(caps.workspaceSymbolProvider).toBe(true)
    expect(caps.implementationProvider).toBe(true)
    expect(caps.callHierarchyProvider).toBe(true)
  })

  it('responds to textDocument/definition with Location[]', async () => {
    startServer()

    // Initialize first
    const initPromise = waitForResponse(server)
    sendRequest(server, 1, 'initialize', { capabilities: {} })
    await initPromise
    sendNotification(server, 'initialized')

    // Send definition request
    const defPromise = waitForResponse(server)
    sendRequest(server, 2, 'textDocument/definition', {
      textDocument: { uri: 'file:///mock/file.ts' },
      position: { line: 5, character: 10 }
    })
    const response = await defPromise

    expect(response.id).toBe(2)
    expect(Array.isArray(response.result)).toBe(true)
    const locations = response.result as Array<{
      uri: string
      range: { start: { line: number } }
    }>
    expect(locations.length).toBeGreaterThan(0)
    expect(locations[0].uri).toBeDefined()
    expect(locations[0].range).toBeDefined()
    expect(locations[0].range.start).toBeDefined()
    expect(typeof locations[0].range.start.line).toBe('number')
  })

  it('responds to textDocument/hover with hover result', async () => {
    startServer()

    // Initialize
    const initPromise = waitForResponse(server)
    sendRequest(server, 1, 'initialize', { capabilities: {} })
    await initPromise
    sendNotification(server, 'initialized')

    // Send hover request
    const hoverPromise = waitForResponse(server)
    sendRequest(server, 2, 'textDocument/hover', {
      textDocument: { uri: 'file:///mock/file.ts' },
      position: { line: 5, character: 0 }
    })
    const response = await hoverPromise

    expect(response.id).toBe(2)
    expect(response.result).toBeDefined()
    const result = response.result as { contents: { kind: string; value: string } }
    expect(result.contents).toBeDefined()
    expect(result.contents.kind).toBe('markdown')
    expect(typeof result.contents.value).toBe('string')
  })

  it('publishes diagnostics after textDocument/didOpen', async () => {
    startServer()

    // Initialize
    const initPromise = waitForResponse(server)
    sendRequest(server, 1, 'initialize', { capabilities: {} })
    await initPromise
    sendNotification(server, 'initialized')

    // Open a file and expect diagnostics notification
    const diagPromise = waitForResponse(server)
    sendNotification(server, 'textDocument/didOpen', {
      textDocument: {
        uri: 'file:///mock/test.ts',
        languageId: 'typescript',
        version: 1,
        text: 'const x: number = "hello"'
      }
    })
    const notification = await diagPromise

    expect(notification.method).toBe('textDocument/publishDiagnostics')
    expect(notification.params).toBeDefined()
    const params = notification.params as {
      uri: string
      diagnostics: Array<{ severity: number; message: string }>
    }
    expect(params.uri).toBe('file:///mock/test.ts')
    expect(Array.isArray(params.diagnostics)).toBe(true)
    expect(params.diagnostics.length).toBeGreaterThan(0)
    expect(params.diagnostics[0].severity).toBe(1)
    expect(typeof params.diagnostics[0].message).toBe('string')
  })

  it('responds to textDocument/references with Location[]', async () => {
    startServer()
    const initPromise = waitForResponse(server)
    sendRequest(server, 1, 'initialize', { capabilities: {} })
    await initPromise
    sendNotification(server, 'initialized')

    const refPromise = waitForResponse(server)
    sendRequest(server, 2, 'textDocument/references', {
      textDocument: { uri: 'file:///mock/file.ts' },
      position: { line: 10, character: 0 },
      context: { includeDeclaration: true }
    })
    const response = await refPromise

    expect(response.id).toBe(2)
    const locations = response.result as Array<{ uri: string; range: unknown }>
    expect(Array.isArray(locations)).toBe(true)
    expect(locations.length).toBeGreaterThanOrEqual(2)
  })

  it('responds to textDocument/documentSymbol with DocumentSymbol[]', async () => {
    startServer()
    const initPromise = waitForResponse(server)
    sendRequest(server, 1, 'initialize', { capabilities: {} })
    await initPromise
    sendNotification(server, 'initialized')

    const symPromise = waitForResponse(server)
    sendRequest(server, 2, 'textDocument/documentSymbol', {
      textDocument: { uri: 'file:///mock/file.ts' }
    })
    const response = await symPromise

    expect(response.id).toBe(2)
    const symbols = response.result as Array<{
      name: string
      kind: number
      range: unknown
      selectionRange: unknown
    }>
    expect(Array.isArray(symbols)).toBe(true)
    expect(symbols.length).toBeGreaterThan(0)
    expect(symbols[0].name).toBe('hello')
    expect(symbols[0].kind).toBe(12) // Function
  })

  it('responds to workspace/symbol with SymbolInformation[]', async () => {
    startServer()
    const initPromise = waitForResponse(server)
    sendRequest(server, 1, 'initialize', { capabilities: {} })
    await initPromise
    sendNotification(server, 'initialized')

    const symPromise = waitForResponse(server)
    sendRequest(server, 2, 'workspace/symbol', {
      query: 'hello'
    })
    const response = await symPromise

    expect(response.id).toBe(2)
    const symbols = response.result as Array<{
      name: string
      kind: number
      location: unknown
    }>
    expect(Array.isArray(symbols)).toBe(true)
    expect(symbols.length).toBeGreaterThan(0)
    expect(symbols[0].name).toBe('hello')
  })

  it('responds to textDocument/implementation with Location[]', async () => {
    startServer()
    const initPromise = waitForResponse(server)
    sendRequest(server, 1, 'initialize', { capabilities: {} })
    await initPromise
    sendNotification(server, 'initialized')

    const implPromise = waitForResponse(server)
    sendRequest(server, 2, 'textDocument/implementation', {
      textDocument: { uri: 'file:///mock/file.ts' },
      position: { line: 0, character: 9 }
    })
    const response = await implPromise

    expect(response.id).toBe(2)
    const locations = response.result as Array<{ uri: string; range: unknown }>
    expect(Array.isArray(locations)).toBe(true)
    expect(locations.length).toBeGreaterThan(0)
  })

  it('responds to callHierarchy prepare/incoming/outgoing', async () => {
    startServer()
    const initPromise = waitForResponse(server)
    sendRequest(server, 1, 'initialize', { capabilities: {} })
    await initPromise
    sendNotification(server, 'initialized')

    // Prepare call hierarchy
    const prepPromise = waitForResponse(server)
    sendRequest(server, 2, 'textDocument/prepareCallHierarchy', {
      textDocument: { uri: 'file:///mock/file.ts' },
      position: { line: 0, character: 9 }
    })
    const prepResponse = await prepPromise
    expect(prepResponse.id).toBe(2)
    const items = prepResponse.result as Array<{ name: string }>
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].name).toBe('hello')

    // Incoming calls
    const inPromise = waitForResponse(server)
    sendRequest(server, 3, 'callHierarchy/incomingCalls', {
      item: items[0]
    })
    const inResponse = await inPromise
    expect(inResponse.id).toBe(3)
    const inCalls = inResponse.result as Array<{ from: unknown; fromRanges: unknown }>
    expect(Array.isArray(inCalls)).toBe(true)
    expect(inCalls.length).toBeGreaterThan(0)

    // Outgoing calls
    const outPromise = waitForResponse(server)
    sendRequest(server, 4, 'callHierarchy/outgoingCalls', {
      item: items[0]
    })
    const outResponse = await outPromise
    expect(outResponse.id).toBe(4)
    const outCalls = outResponse.result as Array<{ to: unknown; fromRanges: unknown }>
    expect(Array.isArray(outCalls)).toBe(true)
    expect(outCalls.length).toBeGreaterThan(0)
  })

  it('exits cleanly when stdin closes', async () => {
    startServer()

    const exitPromise = new Promise<number | null>((resolve) => {
      server.on('close', (code) => resolve(code))
    })

    server.stdin!.end()
    const code = await exitPromise
    expect(code).toBe(0)
  })
})
