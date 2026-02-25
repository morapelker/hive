# PRD: LSP Support for Claude Agent SDK Sessions

## Problem Statement

Hive uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) to run Claude Code sessions within worktrees. Currently, Claude agents have **no access to Language Server Protocol (LSP) features** — they cannot look up type definitions, find references, get hover documentation, or see diagnostics. This forces the agent to rely solely on text search (grep/glob) for code navigation, which is imprecise and misses semantic relationships.

OpenCode has already proven that exposing LSP as an agent tool dramatically improves code intelligence capabilities — their implementation supports 40+ language servers and is gated behind a feature flag (`OPENCODE_EXPERIMENTAL_LSP_TOOL`).

## Goal

Add an **in-process MCP server** that exposes LSP operations as tools to Claude Agent SDK sessions, giving the agent code intelligence capabilities including go-to-definition, find-references, hover info, symbol search, call hierarchy, and diagnostics.

## Success Criteria

1. Claude agents in Hive can invoke LSP operations via the `mcp__hive-lsp__lsp` tool
2. TypeScript, Go, Python, and Rust language servers are supported
3. Language servers spawn on-demand and shut down cleanly when sessions disconnect
4. The tool is always-on (no setting required) and auto-approved (read-only)
5. Unit tests cover the LSP client, service, and MCP handler
6. Manual testing confirms real code intelligence results from a Claude session

## Non-Goals (for this PR)

- Auto-detection from project languages to pre-warm servers
- LSP status display in renderer UI
- Post-edit diagnostics refresh (hook into file edit events)
- Additional language servers beyond TS/Go/Python/Rust (C/C++, Ruby, Elixir, etc.)

---

## Technical Design

### Architecture

```
Claude Agent SDK
  → mcp__hive-lsp__lsp tool call
  → In-process MCP tool handler (lsp-mcp-server.ts)
  → LspService (lsp-service.ts) — manages clients per worktree
  → LspClient (lsp-client.ts) — vscode-jsonrpc connection
  → Language server child process (e.g., typescript-language-server)
```

The Claude Agent SDK provides `createSdkMcpServer()` and `tool()` helpers for defining in-process MCP tools. We use these to create a `hive-lsp` MCP server with a single `lsp` tool that multiplexes 9 LSP operations. This avoids needing a separate MCP server process — everything runs in Electron's main process.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Single tool with operation enum** | Matches OpenCode's proven pattern. Cleaner for LLM, avoids 9 separate tools cluttering the tool list. |
| **In-process MCP server** | Uses `createSdkMcpServer()` — no separate process, no port management, no serialization boundary. Simplest integration path. |
| **Lazy client initialization** | Language servers only spawn when a file of that type is first accessed. Avoids startup cost for unused languages. |
| **One LspService per worktree** | Each worktree may have different project roots and language configurations. Service lifecycle tied to worktree sessions. |
| **Read-only tool annotation** | LSP queries never modify files. Tool is auto-approved without user permission prompt. |
| **Always-on** | No feature flag or setting. If no LSP server is available for a file type, the tool returns a clear error and Claude falls back to other tools. |

---

## New Files

All under `src/main/services/lsp/`:

### `lsp-types.ts` — Shared interfaces

```typescript
export interface LspServerHandle {
  process: ChildProcessWithoutNullStreams
  initialization?: Record<string, unknown>
}

export interface LspServerDefinition {
  id: string
  extensions: string[]
  rootMarkers: string[]
  spawn(root: string): Promise<LspServerHandle | undefined>
}

export interface LspPosition {
  file: string     // absolute path
  line: number     // 0-based
  character: number // 0-based
}

export type LspOperation =
  | 'goToDefinition' | 'findReferences' | 'hover'
  | 'documentSymbol' | 'workspaceSymbol' | 'goToImplementation'
  | 'prepareCallHierarchy' | 'incomingCalls' | 'outgoingCalls'
```

### `lsp-language-map.ts` — Extension → languageId mapping

Port from OpenCode's `packages/opencode/src/lsp/language.ts`. Maps `.ts` → `'typescript'`, `.py` → `'python'`, etc. Used for `textDocument/didOpen` notifications.

### `lsp-client.ts` — Single LSP server connection wrapper

Adapted from OpenCode's `packages/opencode/src/lsp/client.ts`:

- Uses `vscode-jsonrpc/node` for JSON-RPC 2.0 over stdio
- Initialize handshake with capabilities negotiation
- Handles `textDocument/publishDiagnostics` notifications → `Map<filePath, Diagnostic[]>`
- `notify.open(path)` — sends `textDocument/didOpen` or `textDocument/didChange`
- `waitForDiagnostics(path)` — waits up to 3s with 150ms debounce
- `shutdown()` — ends connection, kills process
- Uses Node.js `fs.promises.readFile` (not Bun APIs)

### `lsp-servers.ts` — Language server registry

Four server definitions with graceful "not installed" handling:

| Server | Command | Extensions | Root Markers |
|--------|---------|------------|--------------|
| TypeScript | `npx typescript-language-server --stdio` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | `tsconfig.json`, `package.json`, `pnpm-lock.yaml` |
| Go | `gopls serve` | `.go` | `go.mod`, `go.sum` |
| Python | `pyright-langserver --stdio` | `.py`, `.pyi` | `pyproject.toml`, `setup.py`, `requirements.txt` |
| Rust | `rust-analyzer` | `.rs` | `Cargo.toml` |

Root detection: Walk up from file path looking for marker files (adapted from OpenCode's `NearestRoot` utility).

### `lsp-service.ts` — Core service (one per worktree)

Adapted from OpenCode's `packages/opencode/src/lsp/index.ts`:

- **Client management**: lazy spawn, caching by `(serverID, root)`, broken-server set, dedup in-flight spawns
- **Public API**:
  - `hasClients(filePath)` / `getClients(filePath)` — extension-based matching
  - `touchFile(filePath, waitForDiagnostics?)` — opens file in LSP
  - 9 operation methods: `definition()`, `references()`, `hover()`, `implementation()`, `documentSymbol()`, `workspaceSymbol()`, `prepareCallHierarchy()`, `incomingCalls()`, `outgoingCalls()`
  - `diagnostics()` — aggregated from all clients
  - `shutdown()` — kills all server processes

### `lsp-mcp-server.ts` — Creates the in-process MCP server

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'

export function createLspMcpServerConfig(lspService: LspService) {
  const lspTool = tool('lsp', DESCRIPTION, {
    operation: z.enum(OPERATIONS),
    filePath: z.string(),
    line: z.number().int().min(1),
    character: z.number().int().min(1),
  }, handler, { annotations: { readOnly: true } })

  return createSdkMcpServer({ name: 'hive-lsp', version: '1.0.0', tools: [lspTool] })
}
```

### `index.ts` — Public barrel export

Exports `createLspMcpServerConfig` and `LspService`.

---

## Modified Files

### `src/main/services/claude-code-implementer.ts`

1. **Add `lspServices` map** — `private lspServices = new Map<string, LspService>()`
2. **In `prompt()` method** (after options construction at line ~463):
   ```typescript
   const lspService = this.getOrCreateLspService(session.worktreePath)
   const lspMcpServer = createLspMcpServerConfig(lspService)
   options.mcpServers = { 'hive-lsp': lspMcpServer }
   options.allowedTools = ['mcp__hive-lsp__lsp']
   ```
3. **In `disconnect()`** — shutdown LspService if no other sessions use same worktree
4. **In `cleanup()`** — shutdown all LspService instances

### `package.json`

- Add `vscode-jsonrpc: ^8.2.1`
- Add `vscode-languageserver-types: ^3.17.5`

---

## LSP Tool Specification

**Tool name**: `mcp__hive-lsp__lsp`

**Description**: Interact with Language Server Protocol (LSP) servers to get code intelligence features.

**Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `operation` | enum | One of: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls` |
| `filePath` | string | Absolute or relative file path |
| `line` | integer ≥ 1 | Line number (1-based, as shown in editors) |
| `character` | integer ≥ 1 | Character offset (1-based, as shown in editors) |

**Output**: JSON array of LSP results (locations, hover info, symbols, etc.) or error message.

**Execution flow**:
1. Resolve absolute path
2. Validate file exists
3. Check LSP server available for file type
4. Touch file (open/sync with LSP)
5. Dispatch operation
6. Return JSON results

---

## Testing Strategy

### Unit Tests (`test/lsp/`)

**`fake-lsp-server.js`** — Minimal JSON-RPC 2.0 server over stdio:
- Handles `initialize`, `initialized`, `textDocument/didOpen`
- Returns mock responses for definition, hover, references
- Publishes mock diagnostics notifications
- Adapted from OpenCode's `test/fixture/lsp/fake-lsp-server.js`

**`lsp-client.test.ts`**:
- Initialize handshake with fake server
- `notify.open()` sends correct notifications
- `waitForDiagnostics()` resolves on mock diagnostics
- `shutdown()` kills process

**`lsp-service.test.ts`**:
- `hasClients()` matches file extensions correctly
- Broken server tracking (spawn failure → not retried)
- `shutdown()` cleans up all clients

**`lsp-mcp-server.test.ts`**:
- 1-based to 0-based position conversion
- File-not-found error handling
- No-LSP-available error handling
- Each operation dispatches correctly

### Manual Testing

1. `pnpm dev` → open a TypeScript worktree
2. Start Claude session, ask: "Use the LSP tool to find the definition of `createLogger` in src/main/services/logger.ts at line 10, character 5"
3. Verify correct file location returned
4. Test hover, findReferences, documentSymbol operations
5. Check Hive logs for LSP lifecycle (spawn on first use, shutdown on disconnect)

### Integration Test (optional)

- Create temp directory with `tsconfig.json` + `.ts` file with known symbols
- Start LspService, call operations, verify results
- Skip in CI if `typescript-language-server` not available

---

## Implementation Order

1. Dependencies — add `vscode-jsonrpc` + `vscode-languageserver-types`, install
2. Core types + language map — `lsp-types.ts`, `lsp-language-map.ts`
3. LSP client — `lsp-client.ts`
4. Server registry — `lsp-servers.ts` (TS + Go + Python + Rust)
5. LSP service — `lsp-service.ts`
6. MCP server — `lsp-mcp-server.ts`
7. Integration — wire into `claude-code-implementer.ts`
8. Tests — fake server + unit tests
9. Manual verification

---

## Key Technical Notes

- **Import path**: `vscode-jsonrpc/node` (NOT bare `vscode-jsonrpc`) for Node.js stream support
- **MCP tool naming**: Tool appears as `mcp__hive-lsp__lsp` in Claude's tool list
- **Zod version**: Claude Agent SDK re-exports `zod/v4` — use that for MCP tool schemas
- **Concurrent requests**: `vscode-jsonrpc` handles concurrent requests via request IDs
- **Error resilience**: Failed servers marked "broken", tool returns error text (not throws) so Claude can fallback
- **Resource management**: LSP servers tied to worktree session lifecycle — shutdown when last session disconnects

---

## Key Reference Files

| Purpose | Path |
|---------|------|
| OpenCode LSP tool | `/Users/mor/Documents/dev/opencode/packages/opencode/src/tool/lsp.ts` |
| OpenCode LSP client | `/Users/mor/Documents/dev/opencode/packages/opencode/src/lsp/client.ts` |
| OpenCode LSP service | `/Users/mor/Documents/dev/opencode/packages/opencode/src/lsp/index.ts` |
| OpenCode LSP servers | `/Users/mor/Documents/dev/opencode/packages/opencode/src/lsp/server.ts` |
| OpenCode language map | `/Users/mor/Documents/dev/opencode/packages/opencode/src/lsp/language.ts` |
| OpenCode fake test server | `/Users/mor/Documents/dev/opencode/test/fixture/lsp/fake-lsp-server.js` |
| SDK types | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` |
| Hive integration point | `src/main/services/claude-code-implementer.ts` (lines 446-463) |
