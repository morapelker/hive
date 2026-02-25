# Implementation Plan: LSP Support for Claude Agent SDK Sessions

Each session is a focused, testable unit of work. Sessions must be completed in order since later ones depend on earlier ones.

---

## Session 1: Dependencies & Core Types

**Goal:** Add npm dependencies and create the foundational types and language map.

### Task List

1. Add `vscode-jsonrpc: ^8.2.1` and `vscode-languageserver-types: ^3.17.5` to `package.json`
2. Run `pnpm install`
3. Create `src/main/services/lsp/lsp-types.ts`:
   - `LspServerHandle` interface (ChildProcess + initialization options)
   - `LspServerDefinition` interface (id, extensions, rootMarkers, spawn)
   - `LspPosition` interface (file, line, character — 0-based)
   - `LspOperation` type union (9 operations)
   - `LSP_OPERATIONS` const array
4. Create `src/main/services/lsp/lsp-language-map.ts`:
   - Port `LANGUAGE_EXTENSIONS` map from OpenCode's `packages/opencode/src/lsp/language.ts`
5. Create `src/main/services/lsp/index.ts`:
   - Barrel export for types and language map

### Definition of Done

- `pnpm install` succeeds with new dependencies
- Types compile without errors (`npx tsc --noEmit` on the new files)
- `LANGUAGE_EXTENSIONS` map covers at least: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`

### Tests

**Unit tests** (`test/lsp/lsp-types.test.ts`):
- `LANGUAGE_EXTENSIONS['.ts']` equals `'typescript'`
- `LANGUAGE_EXTENSIONS['.py']` equals `'python'`
- `LANGUAGE_EXTENSIONS['.go']` equals `'go'`
- `LANGUAGE_EXTENSIONS['.rs']` equals `'rust'`
- `LSP_OPERATIONS` contains all 9 operation strings

**E2E**: N/A (no runtime behavior yet)

---

## Session 2: Fake LSP Server (Test Fixture)

**Goal:** Create a fake LSP server that can be used in all subsequent test sessions.

### Task List

1. Create `test/lsp/fixture/fake-lsp-server.js`:
   - JSON-RPC 2.0 over stdio (Content-Length framing)
   - Handle `initialize` → respond with `{ capabilities: {} }`
   - Handle `initialized` → no-op
   - Handle `textDocument/didOpen` → publish mock diagnostics for the file
   - Handle `textDocument/definition` → return mock `Location[]`
   - Handle `textDocument/hover` → return mock hover result
   - Handle `textDocument/references` → return mock `Location[]`
   - Handle `textDocument/documentSymbol` → return mock `DocumentSymbol[]`
   - Handle `workspace/symbol` → return mock `SymbolInformation[]`
   - Handle `textDocument/implementation` → return mock `Location[]`
   - Handle `textDocument/prepareCallHierarchy` → return mock items
   - Handle `callHierarchy/incomingCalls` → return mock results
   - Handle `callHierarchy/outgoingCalls` → return mock results
   - Handle `workspace/workspaceFolders` request → respond
   - Handle `client/registerCapability` → respond
   - Handle `workspace/configuration` → respond

### Definition of Done

- Fake server can be spawned with `node test/lsp/fixture/fake-lsp-server.js`
- It handles the initialize handshake and returns mock data for all 9 operations
- Process exits cleanly when stdin closes

### Tests

**Unit test** (`test/lsp/fake-lsp-server.test.ts`):
- Spawn fake server, send initialize request, verify response has `capabilities`
- Send `textDocument/definition` request, verify mock `Location[]` response
- Send `textDocument/hover` request, verify mock hover response
- Verify server publishes `textDocument/publishDiagnostics` after `textDocument/didOpen`

**E2E**: N/A (test fixture only)

---

## Session 3: LSP Client

**Goal:** Implement the LSP client wrapper that manages a single language server connection.

### Task List

1. Create `src/main/services/lsp/lsp-client.ts`:
   - `createLspClient(input: { serverID, server: LspServerHandle, root: string })` async factory
   - Create `MessageConnection` via `createMessageConnection(StreamMessageReader, StreamMessageWriter)` from `vscode-jsonrpc/node`
   - Send `initialize` request with capabilities (textDocument sync, publishDiagnostics, workspace config)
   - Send `initialized` notification
   - Send `workspace/didChangeConfiguration` if initialization options exist
   - Handle `textDocument/publishDiagnostics` → store in `Map<filePath, Diagnostic[]>`
   - Handle `workspace/workspaceFolders` → return workspace root
   - Handle `workspace/configuration` → return initialization options
   - Handle `client/registerCapability` and `client/unregisterCapability` → no-op
   - `notify.open(path)` method:
     - First call for a file: `textDocument/didOpen` with full content + `workspace/didChangeWatchedFiles` (type: Created)
     - Subsequent calls: `textDocument/didChange` with full content + `workspace/didChangeWatchedFiles` (type: Changed)
     - Track file versions in a map
   - `waitForDiagnostics(path, timeout=3000)` method:
     - Subscribe to diagnostics events
     - Resolve after 150ms debounce from last diagnostic notification
     - Reject after timeout
   - `diagnostics` getter → returns the diagnostics Map
   - `shutdown()` method → connection.end(), connection.dispose(), process.kill()
   - Return typed client object
2. Update `src/main/services/lsp/index.ts` barrel export

### Definition of Done

- Client connects to fake LSP server and completes handshake
- File open/change notifications work correctly
- Diagnostics collection works
- Clean shutdown kills the server process

### Tests

**Unit tests** (`test/lsp/lsp-client.test.ts`):
- `createLspClient` with fake server succeeds (connection established)
- `notify.open('/path/to/file.ts')` first call triggers `textDocument/didOpen`
- `notify.open('/path/to/file.ts')` second call triggers `textDocument/didChange` with incremented version
- `waitForDiagnostics()` resolves when fake server publishes diagnostics
- `waitForDiagnostics()` times out (resolves gracefully) when no diagnostics arrive
- `shutdown()` kills the server process (check `process.killed`)
- `diagnostics` map is populated after `textDocument/publishDiagnostics`
- Client handles `workspace/workspaceFolders` request from server

**E2E**: N/A (tested via fake server)

---

## Session 4: Server Registry & Root Detection

**Goal:** Implement the language server registry with 4 server definitions and root detection.

### Task List

1. Create `src/main/services/lsp/lsp-servers.ts`:
   - `findProjectRoot(file, rootMarkers, stopDir)` utility:
     - Walk up from `path.dirname(file)` to `stopDir`
     - At each directory, check if any marker file exists (using `fs.existsSync`)
     - Return the directory containing the first marker found, or `stopDir` as fallback
   - `TypescriptServer: LspServerDefinition`:
     - id: `'typescript'`
     - extensions: `['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']`
     - rootMarkers: `['tsconfig.json', 'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock']`
     - spawn: Try `npx typescript-language-server --stdio`, check binary exists first
   - `GoplsServer: LspServerDefinition`:
     - id: `'gopls'`
     - extensions: `['.go']`
     - rootMarkers: `['go.mod', 'go.sum']`
     - spawn: `gopls serve` (check with `which`)
   - `PyrightServer: LspServerDefinition`:
     - id: `'pyright'`
     - extensions: `['.py', '.pyi']`
     - rootMarkers: `['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile']`
     - spawn: Try `pyright-langserver --stdio` or `npx pyright-langserver --stdio`
   - `RustAnalyzerServer: LspServerDefinition`:
     - id: `'rust-analyzer'`
     - extensions: `['.rs']`
     - rootMarkers: `['Cargo.toml']`
     - spawn: `rust-analyzer` (check with `which`)
   - `ALL_SERVERS` array export
   - `getServersForFile(filePath)` function that filters by extension match
2. Update barrel export

### Definition of Done

- `findProjectRoot()` correctly finds root markers walking up directories
- Each server definition has correct extensions and root markers
- `getServersForFile('foo.ts')` returns TypeScript server
- `getServersForFile('foo.py')` returns Pyright server
- Servers that aren't installed return `undefined` from `spawn()` (not throw)

### Tests

**Unit tests** (`test/lsp/lsp-servers.test.ts`):
- `findProjectRoot` finds `tsconfig.json` marker in a temp directory structure
- `findProjectRoot` returns stopDir when no marker exists
- `getServersForFile('/path/to/file.ts')` returns array containing TypescriptServer
- `getServersForFile('/path/to/file.go')` returns array containing GoplsServer
- `getServersForFile('/path/to/file.py')` returns array containing PyrightServer
- `getServersForFile('/path/to/file.rs')` returns array containing RustAnalyzerServer
- `getServersForFile('/path/to/file.txt')` returns empty array (no matching server)
- `getServersForFile('/path/to/file.tsx')` returns TypescriptServer (JSX variant)
- TypescriptServer.spawn() with a valid project root spawns a process (integration, skip if not installed)
- Server spawn returns undefined when binary not found (does not throw)

**E2E**: N/A

---

## Session 5: LSP Service

**Goal:** Implement the core LSP service that manages clients and dispatches operations.

### Task List

1. Create `src/main/services/lsp/lsp-service.ts`:
   - `LspService` class constructor takes `projectRoot: string`
   - Private state: `clients[]`, `servers Map`, `broken Set`, `spawning Map`
   - `async hasClients(filePath)`:
     - Check file extension against server definitions
     - Check root marker exists for matching servers
     - Return true if at least one non-broken server could handle the file
   - `async getClients(filePath)`:
     - Match file extension to server definitions
     - For each match: find root, check cache, spawn if needed
     - Dedup in-flight spawns using `spawning` Map
     - Mark broken servers on spawn/init failure
     - Return array of connected clients
   - `async touchFile(filePath, waitForDiagnostics?)`:
     - Get clients for file
     - Call `notify.open()` on each
     - If waitForDiagnostics, wait for diagnostics promise
   - 9 operation methods, each:
     - Get clients for file
     - Send LSP request via `client.connection.sendRequest()`
     - Aggregate results from all clients
     - Convert file URIs using `pathToFileURL` / `fileURLToPath`
   - `async diagnostics()`:
     - Aggregate diagnostics from all clients
   - `async shutdown()`:
     - Call `shutdown()` on all clients
     - Clear all state
2. Update barrel export

### Definition of Done

- Service spawns clients on first file access
- Cached clients are reused on subsequent access
- Broken servers are tracked and not retried
- All 9 operations dispatch correctly to clients
- Shutdown kills all server processes

### Tests

**Unit tests** (`test/lsp/lsp-service.test.ts`):
- Create service with mocked server definitions that spawn fake LSP server
- `hasClients('file.ts')` returns true when TypeScript server available
- `hasClients('file.txt')` returns false
- `getClients('file.ts')` spawns client on first call
- `getClients('file.ts')` returns cached client on second call (no new spawn)
- Broken server tracked after spawn failure — `getClients()` skips it
- `touchFile('file.ts', true)` opens file and waits for diagnostics
- `definition()` returns results from fake server
- `hover()` returns results from fake server
- `references()` returns results from fake server
- `documentSymbol()` returns results from fake server
- `shutdown()` kills all client processes, clears state
- Multiple concurrent `getClients()` calls for same server deduplicate spawning

**E2E**: N/A (uses fake server)

---

## Session 6: MCP Server & Tool Handler

**Goal:** Create the in-process MCP server that exposes the LSP tool to Claude Agent SDK.

### Task List

1. Create `src/main/services/lsp/lsp-mcp-server.ts`:
   - Import `createSdkMcpServer` and `tool` from `@anthropic-ai/claude-agent-sdk`
   - Import `z` from `zod/v4` (as re-exported by the SDK)
   - Define tool description (matching OpenCode's `lsp.txt`)
   - Define `createLspMcpServerConfig(lspService: LspService)`:
     - Create `lsp` tool with schema: `{ operation, filePath, line, character }`
     - Handler:
       1. Resolve absolute path (relative → join with `lspService.projectRoot`)
       2. Check file exists (`fs.existsSync`)
       3. Check `lspService.hasClients(file)`
       4. `lspService.touchFile(file, true)`
       5. Convert 1-based line/char to 0-based
       6. Switch on operation, call corresponding service method
       7. Return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`
       8. On error: return `{ content: [{ type: 'text', text: errorMsg }], isError: true }`
     - Tool annotations: `{ readOnly: true }`
   - Return `createSdkMcpServer({ name: 'hive-lsp', version: '1.0.0', tools: [lspTool] })`
2. Update barrel export to include `createLspMcpServerConfig`

### Definition of Done

- `createLspMcpServerConfig()` returns a valid `McpSdkServerConfigWithInstance`
- Tool handler converts 1-based to 0-based correctly
- Tool handler returns error content for missing files
- Tool handler returns error content when no LSP server available
- All 9 operations are dispatched correctly

### Tests

**Unit tests** (`test/lsp/lsp-mcp-server.test.ts`):
- `createLspMcpServerConfig()` returns object with `type: 'sdk'`, `name: 'hive-lsp'`, `instance`
- Tool handler with `operation: 'goToDefinition'` calls `lspService.definition()` with 0-based position
- Tool handler converts `line: 10, character: 5` to `line: 9, character: 4`
- Tool handler returns `isError: true` when file does not exist
- Tool handler returns `isError: true` when `hasClients()` returns false
- Tool handler with `operation: 'hover'` calls `lspService.hover()`
- Tool handler with `operation: 'findReferences'` calls `lspService.references()`
- Tool handler with `operation: 'documentSymbol'` calls `lspService.documentSymbol()` with file URI
- Tool handler with `operation: 'workspaceSymbol'` calls `lspService.workspaceSymbol()`
- Tool handler returns JSON stringified results on success
- Tool handler returns "No results found" when operation returns empty array
- Relative file path resolved against service projectRoot

**E2E test** (`test/lsp/lsp-mcp-e2e.test.ts`):
- Full stack test: create LspService with fake LSP server → create MCP server → invoke tool handler → verify result
- Test `goToDefinition` end-to-end: handler → service → client → fake server → response → JSON output
- Test `hover` end-to-end
- Test error path: non-existent file

---

## Session 7: Integration with Claude Code Implementer

**Goal:** Wire the LSP MCP server into Claude Agent SDK sessions.

### Task List

1. Modify `src/main/services/claude-code-implementer.ts`:
   - Add import: `import { createLspMcpServerConfig, LspService } from './lsp'`
   - Add private field: `private lspServices = new Map<string, LspService>()`
   - Add private method `getOrCreateLspService(worktreePath: string)`:
     - Check `lspServices` map
     - If not found, create new `LspService(worktreePath)`, store, return
     - If found, return existing
   - In `prompt()` method (after `const options: Options = { ... }` around line 463):
     - `const lspService = this.getOrCreateLspService(session.worktreePath)`
     - `const lspMcpServer = createLspMcpServerConfig(lspService)`
     - `options.mcpServers = { ...options.mcpServers, 'hive-lsp': lspMcpServer }`
     - `options.allowedTools = [...(options.allowedTools ?? []), 'mcp__hive-lsp__lsp']`
   - In `disconnect()` method (after `this.sessions.delete(key)`):
     - Check if any remaining session uses the same `worktreePath`
     - If none: `await this.lspServices.get(worktreePath)?.shutdown()`, delete from map
   - In `cleanup()` method (after sessions loop):
     - `for (const lsp of this.lspServices.values()) await lsp.shutdown()`
     - `this.lspServices.clear()`
2. Verify no TypeScript compilation errors

### Definition of Done

- Claude sessions receive `hive-lsp` MCP server in their options
- `mcp__hive-lsp__lsp` is in `allowedTools`
- LSP services share per worktree (two sessions on same worktree reuse service)
- LSP service shuts down when last session for a worktree disconnects
- All LSP services shut down on implementer cleanup
- No TypeScript errors

### Tests

**Unit tests** (`test/lsp/lsp-integration.test.ts`):
- Mock `sdk.query` to capture options, verify `options.mcpServers['hive-lsp']` exists
- Verify `options.allowedTools` includes `'mcp__hive-lsp__lsp'`
- Verify two sessions on same worktree path share same LspService instance
- Verify disconnect of last session triggers LspService shutdown
- Verify disconnect of non-last session does NOT trigger shutdown
- Verify cleanup shuts down all LspService instances

**E2E test** (manual):
1. `pnpm dev` → open Hive
2. Create/open a TypeScript worktree
3. Start a Claude Code session
4. Send: "Use the LSP tool to get hover info for the function at line 1, character 10 in src/main/index.ts"
5. Verify the `mcp__hive-lsp__lsp` tool appears in the init message's tool list
6. Verify the tool returns LSP hover information
7. Try `goToDefinition`, `findReferences`, `documentSymbol`
8. Disconnect session → check logs confirm LSP server shutdown
9. Open a Go project (if available) → verify gopls spawns and works

---

## Session 8: Final Verification & Cleanup

**Goal:** Run full test suite, fix any issues, verify end-to-end.

### Task List

1. Run `pnpm lint` — fix any linting issues in new files
2. Run `pnpm test` — ensure all existing tests still pass
3. Run `pnpm vitest run test/lsp/` — ensure all new LSP tests pass
4. Run `pnpm build` — ensure production build succeeds
5. Manual smoke test:
   - Start Hive dev mode
   - Open a TypeScript project worktree
   - Start Claude session and test each of the 9 LSP operations
   - Verify error handling: test with a `.txt` file (no LSP server)
   - Verify lifecycle: disconnect session, verify LSP servers shut down in logs
6. Review all new files for:
   - Consistent code style (no semicolons, single quotes, 2-space indent)
   - Proper error handling (no unhandled promises)
   - Logging (use existing logger pattern)
   - No hardcoded paths or secrets
7. Clean up any TODO comments or debug logging

### Definition of Done

- `pnpm lint` passes
- `pnpm test` passes (all existing + new tests)
- `pnpm build` succeeds
- Manual smoke test passes for all 9 operations
- Error paths handled gracefully
- Code follows project style conventions

### Tests

**Full test run**: `pnpm test` (all suites)

**E2E checklist**:
- [ ] TypeScript: `goToDefinition` on a known function returns correct file + line
- [ ] TypeScript: `hover` returns type information
- [ ] TypeScript: `findReferences` returns multiple locations
- [ ] TypeScript: `documentSymbol` returns function/class list
- [ ] TypeScript: `workspaceSymbol` returns project-wide results
- [ ] Error: Tool on `.txt` file returns "No LSP server available"
- [ ] Error: Tool on non-existent file returns "File not found"
- [ ] Lifecycle: LSP server spawns on first tool use (check logs)
- [ ] Lifecycle: LSP server shuts down on session disconnect (check logs)
- [ ] Go: `goToDefinition` works if gopls installed (optional)
- [ ] Python: `hover` works if pyright installed (optional)
- [ ] Rust: `goToDefinition` works if rust-analyzer installed (optional)

---

## Summary

| Session | Files Created/Modified | Estimated Time |
|---------|----------------------|----------------|
| 1 | `lsp-types.ts`, `lsp-language-map.ts`, `index.ts`, `package.json` | 30 min |
| 2 | `test/lsp/fixture/fake-lsp-server.js` | 45 min |
| 3 | `lsp-client.ts` + tests | 1.5 hours |
| 4 | `lsp-servers.ts` + tests | 1 hour |
| 5 | `lsp-service.ts` + tests | 1.5 hours |
| 6 | `lsp-mcp-server.ts` + tests | 1 hour |
| 7 | `claude-code-implementer.ts` modifications + tests | 1 hour |
| 8 | Verification, cleanup, manual testing | 1 hour |
| **Total** | **7 new files, 1 modified, 8 test files** | **~8 hours** |
