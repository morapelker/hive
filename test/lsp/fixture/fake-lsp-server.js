/**
 * Fake LSP server for testing.
 *
 * Implements JSON-RPC 2.0 over stdio with Content-Length framing.
 * Handles the initialize handshake and returns mock data for all 9 LSP operations.
 *
 * Usage: node test/lsp/fixture/fake-lsp-server.js
 */

// --- JSON-RPC transport layer ---

let buffer = ''

function send(msg) {
  const body = JSON.stringify(msg)
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
  process.stdout.write(header + body)
}

function sendResponse(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  parseMessages()
})

process.stdin.on('end', () => {
  process.exit(0)
})

function parseMessages() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return

    const header = buffer.slice(0, headerEnd)
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (!match) {
      buffer = buffer.slice(headerEnd + 4)
      continue
    }

    const contentLength = parseInt(match[1], 10)
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength

    if (buffer.length < bodyEnd) return

    const body = buffer.slice(bodyStart, bodyEnd)
    buffer = buffer.slice(bodyEnd)

    try {
      const msg = JSON.parse(body)
      handleMessage(msg)
    } catch {
      // Ignore parse errors
    }
  }
}

// --- Mock data ---

const MOCK_URI = 'file:///mock/file.ts'

const MOCK_LOCATION = {
  uri: MOCK_URI,
  range: {
    start: { line: 10, character: 0 },
    end: { line: 10, character: 15 }
  }
}

const MOCK_HOVER = {
  contents: {
    kind: 'markdown',
    value: '```typescript\nfunction hello(): void\n```'
  },
  range: {
    start: { line: 5, character: 0 },
    end: { line: 5, character: 5 }
  }
}

const MOCK_DOCUMENT_SYMBOL = {
  name: 'hello',
  kind: 12, // Function
  range: {
    start: { line: 0, character: 0 },
    end: { line: 5, character: 1 }
  },
  selectionRange: {
    start: { line: 0, character: 9 },
    end: { line: 0, character: 14 }
  },
  children: []
}

const MOCK_WORKSPACE_SYMBOL = {
  name: 'hello',
  kind: 12, // Function
  location: MOCK_LOCATION
}

const MOCK_CALL_HIERARCHY_ITEM = {
  name: 'hello',
  kind: 12, // Function
  uri: MOCK_URI,
  range: {
    start: { line: 0, character: 0 },
    end: { line: 5, character: 1 }
  },
  selectionRange: {
    start: { line: 0, character: 9 },
    end: { line: 0, character: 14 }
  }
}

const MOCK_INCOMING_CALL = {
  from: MOCK_CALL_HIERARCHY_ITEM,
  fromRanges: [
    {
      start: { line: 20, character: 2 },
      end: { line: 20, character: 7 }
    }
  ]
}

const MOCK_OUTGOING_CALL = {
  to: MOCK_CALL_HIERARCHY_ITEM,
  fromRanges: [
    {
      start: { line: 3, character: 2 },
      end: { line: 3, character: 12 }
    }
  ]
}

const MOCK_DIAGNOSTIC = {
  range: {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 10 }
  },
  severity: 1, // Error
  message: 'Mock error: type mismatch',
  source: 'fake-lsp'
}

// --- Message handler ---

let initialized = false

function handleMessage(msg) {
  // Requests (have an id)
  if (msg.id !== undefined && msg.method) {
    handleRequest(msg)
  }
  // Notifications (no id)
  else if (msg.method) {
    handleNotification(msg)
  }
}

function handleRequest(msg) {
  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        capabilities: {
          textDocumentSync: 1, // Full
          definitionProvider: true,
          hoverProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          implementationProvider: true,
          callHierarchyProvider: true
        }
      })
      break

    case 'shutdown':
      sendResponse(id, null)
      break

    case 'textDocument/definition':
      sendResponse(id, [MOCK_LOCATION])
      break

    case 'textDocument/hover':
      sendResponse(id, MOCK_HOVER)
      break

    case 'textDocument/references':
      sendResponse(id, [MOCK_LOCATION, { ...MOCK_LOCATION, range: { start: { line: 20, character: 5 }, end: { line: 20, character: 20 } } }])
      break

    case 'textDocument/documentSymbol':
      sendResponse(id, [MOCK_DOCUMENT_SYMBOL])
      break

    case 'workspace/symbol':
      sendResponse(id, [MOCK_WORKSPACE_SYMBOL])
      break

    case 'textDocument/implementation':
      sendResponse(id, [MOCK_LOCATION])
      break

    case 'textDocument/prepareCallHierarchy':
      sendResponse(id, [MOCK_CALL_HIERARCHY_ITEM])
      break

    case 'callHierarchy/incomingCalls':
      sendResponse(id, [MOCK_INCOMING_CALL])
      break

    case 'callHierarchy/outgoingCalls':
      sendResponse(id, [MOCK_OUTGOING_CALL])
      break

    case 'workspace/workspaceFolders':
      sendResponse(id, [{ uri: 'file:///mock/workspace', name: 'mock' }])
      break

    case 'client/registerCapability':
      sendResponse(id, null)
      break

    case 'client/unregisterCapability':
      sendResponse(id, null)
      break

    case 'workspace/configuration':
      sendResponse(id, [{}])
      break

    default:
      // Unknown method — respond with method not found
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      })
      break
  }
}

function handleNotification(msg) {
  const { method, params } = msg

  switch (method) {
    case 'initialized':
      initialized = true
      break

    case 'textDocument/didOpen':
      // Publish mock diagnostics for the opened file
      if (params && params.textDocument) {
        sendNotification('textDocument/publishDiagnostics', {
          uri: params.textDocument.uri,
          diagnostics: [MOCK_DIAGNOSTIC]
        })
      }
      break

    case 'textDocument/didChange':
      // Publish updated diagnostics
      if (params && params.textDocument) {
        sendNotification('textDocument/publishDiagnostics', {
          uri: params.textDocument.uri,
          diagnostics: [MOCK_DIAGNOSTIC]
        })
      }
      break

    case 'textDocument/didClose':
      // Clear diagnostics
      if (params && params.textDocument) {
        sendNotification('textDocument/publishDiagnostics', {
          uri: params.textDocument.uri,
          diagnostics: []
        })
      }
      break

    case 'workspace/didChangeConfiguration':
      // no-op
      break

    case 'workspace/didChangeWatchedFiles':
      // no-op
      break

    case 'exit':
      process.exit(0)
      break

    default:
      // Ignore unknown notifications
      break
  }
}
