import { readFileSync } from 'fs'
import { basename, extname } from 'path'
import { pathToFileURL } from 'url'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from 'vscode-jsonrpc/node'
import type { Diagnostic } from 'vscode-languageserver-types'
import { LANGUAGE_EXTENSIONS } from './lsp-language-map'
import type { LspServerHandle } from './lsp-types'

/**
 * Input to createLspClient factory.
 */
export interface CreateLspClientInput {
  serverID: string
  server: LspServerHandle
  root: string
}

/**
 * The LSP client wrapper returned by createLspClient.
 */
export interface LspClient {
  /** The underlying JSON-RPC connection */
  connection: MessageConnection
  /** Notification helpers */
  notify: {
    /** Open (or re-open) a file — first call sends didOpen, subsequent calls send didChange */
    open: (filePath: string) => Promise<void>
  }
  /** Wait for diagnostics on a file, resolving after 150ms debounce or undefined on timeout */
  waitForDiagnostics: (filePath: string, timeout?: number) => Promise<Diagnostic[] | undefined>
  /** Current diagnostics keyed by file URI */
  diagnostics: Map<string, Diagnostic[]>
  /** Shut down the connection and kill the server process */
  shutdown: () => Promise<void>
}

/**
 * Create an LSP client that connects to a running language server process.
 * Performs the initialize/initialized handshake and sets up notification handlers.
 */
export async function createLspClient(input: CreateLspClientInput): Promise<LspClient> {
  const { serverID, server, root } = input
  const proc = server.process

  if (!proc.stdin || !proc.stdout) {
    throw new Error(`LSP server ${serverID}: process has no stdio streams`)
  }

  // Create JSON-RPC connection over stdio
  const connection = createMessageConnection(
    new StreamMessageReader(proc.stdout),
    new StreamMessageWriter(proc.stdin)
  )

  // Diagnostics storage: fileUri → Diagnostic[]
  const diagnosticsMap = new Map<string, Diagnostic[]>()

  // File version tracking: filePath → version number
  const fileVersions = new Map<string, number>()

  // Diagnostics event subscribers for waitForDiagnostics
  type DiagnosticsListener = (uri: string, diags: Diagnostic[]) => void
  const diagnosticsListeners = new Set<DiagnosticsListener>()

  // Handle textDocument/publishDiagnostics from the server
  connection.onNotification(
    'textDocument/publishDiagnostics',
    (params: { uri: string; diagnostics: Diagnostic[] }) => {
      diagnosticsMap.set(params.uri, params.diagnostics)
      diagnosticsListeners.forEach((listener) => {
        listener(params.uri, params.diagnostics)
      })
    }
  )

  // Handle workspace/workspaceFolders request from the server
  connection.onRequest('workspace/workspaceFolders', () => {
    return [
      {
        uri: pathToFileURL(root).toString(),
        name: basename(root)
      }
    ]
  })

  // Handle workspace/configuration request from the server
  connection.onRequest('workspace/configuration', () => {
    return [server.initializationOptions ?? {}]
  })

  // Handle client/registerCapability — no-op
  connection.onRequest('client/registerCapability', () => {
    return null
  })

  // Handle client/unregisterCapability — no-op
  connection.onRequest('client/unregisterCapability', () => {
    return null
  })

  // Start listening
  connection.listen()

  // Send initialize request
  await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).toString(),
    capabilities: {
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: true
        },
        publishDiagnostics: {
          relatedInformation: true
        }
      },
      workspace: {
        workspaceFolders: true,
        didChangeConfiguration: {
          dynamicRegistration: true
        },
        configuration: true
      }
    },
    workspaceFolders: [
      {
        uri: pathToFileURL(root).toString(),
        name: basename(root)
      }
    ],
    initializationOptions: server.initializationOptions ?? {}
  })

  // Send initialized notification
  await connection.sendNotification('initialized', {})

  // Send workspace/didChangeConfiguration if initialization options exist
  if (server.initializationOptions) {
    await connection.sendNotification('workspace/didChangeConfiguration', {
      settings: server.initializationOptions
    })
  }

  // --- notify.open ---
  async function openFile(filePath: string): Promise<void> {
    const fileUri = pathToFileURL(filePath).toString()
    const ext = extname(filePath)
    const languageId = LANGUAGE_EXTENSIONS[ext] || 'plaintext'

    let content = ''
    try {
      content = readFileSync(filePath, 'utf8')
    } catch {
      // File may not exist — send empty content
    }

    const existingVersion = fileVersions.get(filePath)

    if (existingVersion === undefined) {
      // First open — send textDocument/didOpen
      fileVersions.set(filePath, 1)

      await connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: fileUri,
          languageId,
          version: 1,
          text: content
        }
      })

      // Also send workspace/didChangeWatchedFiles (Created)
      await connection.sendNotification('workspace/didChangeWatchedFiles', {
        changes: [{ uri: fileUri, type: 1 /* Created */ }]
      })
    } else {
      // Subsequent open — send textDocument/didChange with incremented version
      const newVersion = existingVersion + 1
      fileVersions.set(filePath, newVersion)

      await connection.sendNotification('textDocument/didChange', {
        textDocument: {
          uri: fileUri,
          version: newVersion
        },
        contentChanges: [{ text: content }]
      })

      // Also send workspace/didChangeWatchedFiles (Changed)
      await connection.sendNotification('workspace/didChangeWatchedFiles', {
        changes: [{ uri: fileUri, type: 2 /* Changed */ }]
      })
    }
  }

  // --- waitForDiagnostics ---
  async function waitForDiagnostics(
    filePath: string,
    timeout = 3000
  ): Promise<Diagnostic[] | undefined> {
    const fileUri = pathToFileURL(filePath).toString()

    // Check if we already have diagnostics for this file
    const existing = diagnosticsMap.get(fileUri)
    if (existing && existing.length > 0) {
      // Still wait for the debounce period in case more are coming
    }

    return new Promise<Diagnostic[] | undefined>((resolve) => {
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      let resolved = false

      const cleanup = (timer: ReturnType<typeof setTimeout>) => {
        if (debounceTimer) clearTimeout(debounceTimer)
        clearTimeout(timer)
        diagnosticsListeners.delete(listener)
        resolved = true
      }

      const listener: DiagnosticsListener = (uri, _diags) => {
        if (uri !== fileUri) return
        if (resolved) return

        // Reset debounce timer on each diagnostic notification
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          if (resolved) return
          cleanup(timeoutTimer)
          resolve(diagnosticsMap.get(fileUri))
        }, 150)
      }

      diagnosticsListeners.add(listener)

      // If diagnostics already exist, start the debounce immediately
      if (existing && existing.length > 0) {
        debounceTimer = setTimeout(() => {
          if (resolved) return
          cleanup(timeoutTimer)
          resolve(diagnosticsMap.get(fileUri))
        }, 150)
      }

      // Timeout — resolve with undefined
      const timeoutTimer = setTimeout(() => {
        if (resolved) return
        cleanup(timeoutTimer)
        resolve(undefined)
      }, timeout)
    })
  }

  // --- shutdown ---
  async function shutdown(): Promise<void> {
    try {
      connection.end()
      connection.dispose()
    } catch {
      // ignore connection errors during shutdown
    }

    if (!proc.killed) {
      proc.kill()
    }
  }

  return {
    connection,
    notify: {
      open: openFile
    },
    waitForDiagnostics,
    diagnostics: diagnosticsMap,
    shutdown
  }
}
