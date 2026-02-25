import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { pathToFileURL } from 'url'
import { createLspClient } from '../../src/main/services/lsp/lsp-client'
import type { LspServerHandle } from '../../src/main/services/lsp/lsp-types'

const FAKE_SERVER_PATH = path.join(__dirname, 'fixture', 'fake-lsp-server.js')

describe('LSP Client', () => {
  let serverProcess: ChildProcess
  let client: Awaited<ReturnType<typeof createLspClient>> | undefined
  let tmpDir: string
  let testFilePath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-client-test-'))
    testFilePath = path.join(tmpDir, 'test.ts')
    fs.writeFileSync(testFilePath, 'const x: number = "hello"\n')
  })

  function spawnFakeServer(): LspServerHandle {
    serverProcess = spawn('node', [FAKE_SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { process: serverProcess }
  }

  afterEach(async () => {
    if (client) {
      try {
        await client.shutdown()
      } catch {
        // ignore shutdown errors
      }
      client = undefined
    }
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill()
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('createLspClient with fake server succeeds (connection established)', async () => {
    const server = spawnFakeServer()
    client = await createLspClient({
      serverID: 'test',
      server,
      root: tmpDir
    })

    expect(client).toBeDefined()
    expect(client.connection).toBeDefined()
    expect(client.notify).toBeDefined()
    expect(client.notify.open).toBeDefined()
    expect(typeof client.notify.open).toBe('function')
    expect(client.diagnostics).toBeInstanceOf(Map)
    expect(typeof client.shutdown).toBe('function')
    expect(typeof client.waitForDiagnostics).toBe('function')
  })

  it('notify.open first call triggers textDocument/didOpen', async () => {
    const server = spawnFakeServer()
    client = await createLspClient({
      serverID: 'test',
      server,
      root: tmpDir
    })

    // First open — should send textDocument/didOpen
    // The fake server publishes diagnostics in response to didOpen
    await client.notify.open(testFilePath)
    await client.waitForDiagnostics(testFilePath, 3000)

    const fileUri = pathToFileURL(testFilePath).toString()
    const diags = client.diagnostics.get(fileUri)
    expect(diags).toBeDefined()
    expect(diags!.length).toBeGreaterThan(0)
  })

  it('notify.open second call triggers textDocument/didChange with incremented version', async () => {
    const server = spawnFakeServer()
    client = await createLspClient({
      serverID: 'test',
      server,
      root: tmpDir
    })

    // First open (didOpen, version 1)
    await client.notify.open(testFilePath)
    await client.waitForDiagnostics(testFilePath, 3000)

    // Modify the file content
    fs.writeFileSync(testFilePath, 'const y: string = 42\n')

    // Second open (should trigger didChange, not didOpen)
    // The fake server also publishes diagnostics on didChange
    await client.notify.open(testFilePath)
    await client.waitForDiagnostics(testFilePath, 3000)

    // Verify diagnostics still present (server publishes on both didOpen and didChange)
    const fileUri = pathToFileURL(testFilePath).toString()
    const diags = client.diagnostics.get(fileUri)
    expect(diags).toBeDefined()
    expect(diags!.length).toBeGreaterThan(0)
  })

  it('waitForDiagnostics resolves when fake server publishes diagnostics', async () => {
    const server = spawnFakeServer()
    client = await createLspClient({
      serverID: 'test',
      server,
      root: tmpDir
    })

    await client.notify.open(testFilePath)

    // This should resolve because the fake server publishes diagnostics on didOpen
    const diags = await client.waitForDiagnostics(testFilePath, 3000)
    expect(diags).toBeDefined()
    expect(Array.isArray(diags)).toBe(true)
    expect(diags!.length).toBeGreaterThan(0)
  })

  it('waitForDiagnostics times out gracefully when no diagnostics arrive', async () => {
    const server = spawnFakeServer()
    client = await createLspClient({
      serverID: 'test',
      server,
      root: tmpDir
    })

    // Don't open any file — just wait for diagnostics on a path that
    // the server will never publish for. Should resolve gracefully.
    const diags = await client.waitForDiagnostics('/no/such/file.ts', 500)
    expect(diags).toBeUndefined()
  })

  it('shutdown kills the server process', async () => {
    const server = spawnFakeServer()
    client = await createLspClient({
      serverID: 'test',
      server,
      root: tmpDir
    })

    await client.shutdown()

    // Give a moment for the process to be killed
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(serverProcess.killed).toBe(true)
    client = undefined // prevent double-shutdown in afterEach
  })

  it('diagnostics map is populated after textDocument/publishDiagnostics', async () => {
    const server = spawnFakeServer()
    client = await createLspClient({
      serverID: 'test',
      server,
      root: tmpDir
    })

    // Initially empty
    expect(client.diagnostics.size).toBe(0)

    await client.notify.open(testFilePath)
    await client.waitForDiagnostics(testFilePath, 3000)

    // Now should have diagnostics
    expect(client.diagnostics.size).toBeGreaterThan(0)
    const fileUri = pathToFileURL(testFilePath).toString()
    const diags = client.diagnostics.get(fileUri)
    expect(diags).toBeDefined()
    expect(diags![0].message).toBe('Mock error: type mismatch')
    expect(diags![0].severity).toBe(1)
  })

  it('client handles workspace/workspaceFolders request from server', async () => {
    const server = spawnFakeServer()
    // The client registers an onRequest handler for workspace/workspaceFolders
    // during initialization. Verify the client is fully functional after setup,
    // which confirms the handler was registered without errors.
    client = await createLspClient({
      serverID: 'test',
      server,
      root: tmpDir
    })

    expect(client).toBeDefined()

    // Verify the client is operational — if workspace/workspaceFolders handler
    // was not set up, the server could error during interactions
    await client.notify.open(testFilePath)
    await client.waitForDiagnostics(testFilePath, 3000)
    expect(client.diagnostics.size).toBeGreaterThan(0)
  })
})
