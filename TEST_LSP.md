# Manual Testing Guide: LSP Support for Claude Agent SDK Sessions

## Prerequisites

1. **Hive is built and running** — `pnpm dev` from the vizsla directory
2. **typescript-language-server installed** — `npx typescript-language-server --version` should work (bundled via npx, no global install needed)
3. **Optional language servers** (for full coverage):
   - Go: `gopls` installed (`which gopls`)
   - Python: `pyright-langserver` installed (`which pyright-langserver` or via npx)
   - Rust: `rust-analyzer` installed (`which rust-analyzer`)
4. **Log file location**: `~/.hive/logs/hive-YYYY-MM-DD.log` — tail this during testing:
   ```bash
   tail -f ~/.hive/logs/hive-$(date +%Y-%m-%d).log | grep -i lsp
   ```

---

## Part 1: Automated Test Verification

### Test 1.1: Run all LSP unit tests
```bash
pnpm vitest run test/lsp/
```
**Expected**: All 98 tests pass across 7 test files (lsp-types, fake-lsp-server, lsp-client, lsp-servers, lsp-service, lsp-mcp-server, lsp-mcp-e2e).

### Test 1.2: Run full test suite
```bash
pnpm test
```
**Expected**: All tests pass — no regressions in existing tests.

### Test 1.3: Lint check
```bash
pnpm lint
```
**Expected**: No errors in any LSP files.

### Test 1.4: Build check
```bash
pnpm build
```
**Expected**: Production build succeeds without errors.

---

## Part 2: TypeScript LSP Operations (Core Path)

Start Hive with `pnpm dev`, then open a **TypeScript worktree** (any project with a `tsconfig.json`).

### Test 2.1: `goToDefinition`
**Step**: Start a Claude session. Send a prompt asking Claude to use the LSP tool:
> "Use the LSP tool to find the definition of a function. Call `goToDefinition` on `src/main/index.ts` at line 1, character 10."

**Expected**:
- Claude invokes `mcp__hive-lsp__lsp` with `{ operation: "goToDefinition", filePath: "src/main/index.ts", line: 1, character: 10 }`
- The response is a JSON array of location objects with `uri` (file URI) and `range` (start/end line+character)
- In the log file, you should see the TypeScript language server spawn on first use (look for activity around `typescript-language-server`)

### Test 2.2: `hover`
**Step**: Ask Claude:
> "Use the LSP tool with `hover` on `src/main/index.ts` at line 1, character 10 to get type information."

**Expected**:
- Response contains a JSON array with a hover result
- Each result has `contents` with `kind: "markdown"` and a `value` containing type/documentation info
- No new server spawn in logs (reuses the already-running TypeScript server)

### Test 2.3: `findReferences`
**Step**: Pick a symbol that's used in multiple places (e.g., an exported function or variable). Ask Claude:
> "Use the LSP tool with `findReferences` on [file] at line [N], character [M]."

**Expected**:
- Response is a JSON array of location objects
- Contains 2+ entries (the definition + at least one usage)
- Each entry has `uri` and `range`

### Test 2.4: `documentSymbol`
**Step**: Ask Claude:
> "Use the LSP tool with `documentSymbol` on `src/main/services/lsp/lsp-service.ts`."

**Expected**:
- Response is a JSON array of symbol objects
- Contains entries like `LspService` (class), `getProjectRoot` (method), `hasClients` (method), `goToDefinition` (method), etc.
- Each symbol has `name`, `kind` (numeric SymbolKind), and `range`
- No `line`/`character` parameters needed for this operation

### Test 2.5: `workspaceSymbol`
**Step**: Ask Claude:
> "Use the LSP tool with `workspaceSymbol` and `filePath: 'LspService'` to search for symbols named LspService across the workspace."

**Expected**:
- Response is a JSON array of symbol information objects
- Should find `LspService` and related symbols across the project
- Note: `filePath` is repurposed as the search query string for this operation

### Test 2.6: `goToImplementation`
**Step**: Find an interface or abstract method in the codebase. Ask Claude:
> "Use the LSP tool with `goToImplementation` on [interface file] at line [N], character [M]."

**Expected**:
- Response is a JSON array of location objects pointing to concrete implementations
- If the symbol has no implementations, returns `"No results found"` (not an error)

### Test 2.7: `incomingCalls`
**Step**: Pick a function that is called by other functions. Ask Claude:
> "Use the LSP tool with `incomingCalls` on [file] at line [N], character [M]."

**Expected**:
- Response is a JSON array of call hierarchy items
- Each item has a `from` object identifying the calling function
- Uses two-step LSP protocol internally: `prepareCallHierarchy` then `callHierarchy/incomingCalls`

### Test 2.8: `outgoingCalls`
**Step**: Pick a function that calls other functions. Ask Claude:
> "Use the LSP tool with `outgoingCalls` on [file] at line [N], character [M]."

**Expected**:
- Response is a JSON array of call hierarchy items
- Each item has a `to` object identifying the called function

### Test 2.9: `diagnostics`
**Step**: Ask Claude:
> "Use the LSP tool with `diagnostics` and `filePath: ''`."

**Expected**:
- Response is a JSON object keyed by file path, each value an array of diagnostic objects
- Each diagnostic has `severity` (1=error, 2=warning), `message`, `range`
- If no diagnostics exist, returns `"No diagnostics found"` (not an error)
- Note: Files must have been opened via `touchFile` first (which happens automatically when you use other operations)

---

## Part 3: Error Handling

### Test 3.1: Non-existent file
**Step**: Ask Claude:
> "Use the LSP tool with `goToDefinition` on `src/does-not-exist.ts` at line 1, character 1."

**Expected**:
- Response contains `isError: true`
- Text contains `"File not found: /absolute/path/to/does-not-exist.ts"`

### Test 3.2: No LSP server available
**Step**: Ask Claude:
> "Use the LSP tool with `goToDefinition` on `README.md` at line 1, character 1."

**Expected**:
- Response contains `isError: true`
- Text contains `"No language server available for: /absolute/path/to/README.md"`

### Test 3.3: Missing line/character for position-based operation
**Step**: If you can craft a tool call without line/character (e.g., via direct API), or ask Claude to try:
> "Use the LSP tool with `goToDefinition` on `src/main/index.ts` but don't provide line or character."

**Expected**:
- Response contains `isError: true`
- Text contains `requires line and character parameters`

### Test 3.4: Relative path resolution
**Step**: Ask Claude:
> "Use the LSP tool with `goToDefinition` on `src/main/index.ts` (relative path, not absolute) at line 1, character 10."

**Expected**:
- Path resolves correctly against the project root
- Returns valid results (same as if you'd used the absolute path)

---

## Part 4: Lifecycle Management

### Test 4.1: Lazy server spawn
**Steps**:
1. Start Hive fresh (`pnpm dev`)
2. Open a worktree but do NOT start a Claude session yet
3. Check logs — no LSP-related entries should appear
4. Start a Claude session and make an LSP tool call on a `.ts` file

**Expected**:
- TypeScript language server spawns **only** when the first LSP tool call happens
- Log shows initialization activity on first call
- Subsequent calls reuse the same server (no new spawn)

### Test 4.2: Server shutdown on session disconnect
**Steps**:
1. Have an active Claude session that has used the LSP tool
2. Disconnect/end the Claude session
3. Watch the logs

**Expected**:
- Log entry: `"LSP service shut down (no remaining sessions)"` with the worktree path
- The typescript-language-server child process is killed

### Test 4.3: Shared service across sessions
**Steps**:
1. Start a Claude session on a worktree, use the LSP tool (spawns the TS server)
2. Start a **second** Claude session on the **same** worktree
3. Use the LSP tool from the second session
4. Disconnect the **first** session

**Expected**:
- Second session reuses the same LSP service (no new server spawn — check logs)
- Disconnecting the first session does NOT shut down the LSP service (still in use)
- Only when the second session also disconnects should the LSP service shut down

### Test 4.4: Graceful degradation
**Step**: If possible, simulate a scenario where the LSP server crashes or fails to start (e.g., temporarily rename the `typescript-language-server` binary). Then start a Claude session and use any non-LSP tool.

**Expected**:
- Log entry: `"Failed to attach LSP MCP server, continuing without LSP"`
- The Claude session still works — it just doesn't have the LSP tool available
- No crash, no unhandled error

---

## Part 5: Multi-Language Testing (Optional)

Requires the respective language servers to be installed.

### Test 5.1: Go (requires `gopls`)
**Step**: Open a Go project worktree (one with `go.mod`). Ask Claude:
> "Use the LSP tool with `goToDefinition` on `main.go` at line [N], character [M]."

**Expected**: Returns definition locations from gopls.

### Test 5.2: Python (requires `pyright-langserver`)
**Step**: Open a Python project worktree (one with `pyproject.toml` or `requirements.txt`). Ask Claude:
> "Use the LSP tool with `hover` on `main.py` at line [N], character [M]."

**Expected**: Returns type/doc hover info from Pyright.

### Test 5.3: Rust (requires `rust-analyzer`)
**Step**: Open a Rust project worktree (one with `Cargo.toml`). Ask Claude:
> "Use the LSP tool with `goToDefinition` on `src/main.rs` at line [N], character [M]."

**Expected**: Returns definition locations from rust-analyzer.

---

## Part 6: Position Conversion Verification

### Test 6.1: 1-based to 0-based conversion
**Step**: In a TypeScript file, note a known symbol at a specific position. For example, if `const x` starts at line 5, column 7 (as shown in your editor — 1-based), ask Claude:
> "Use the LSP tool with `hover` on [file] at line 5, character 7."

**Expected**:
- The tool internally converts to `line: 4, character: 6` (0-based) before sending to the LSP server
- The hover result matches the symbol at that exact position
- If off by one, hover would return info for the wrong symbol or "No results found"

---

## What to Watch in Logs

| Log message | When it appears |
|---|---|
| TypeScript server spawn activity | First LSP tool call on a `.ts` file |
| `LSP service shut down (no remaining sessions)` | Last session for a worktree disconnects |
| `Failed to attach LSP MCP server, continuing without LSP` | LSP init failed (graceful degradation) |
| `Cleanup: LSP service shutdown threw, ignoring` | Error during app cleanup (non-fatal) |

---

## Summary Checklist

| # | Test | Pass |
|---|---|---|
| 1.1 | Automated LSP tests pass (98 tests) | |
| 1.2 | Full test suite passes | |
| 1.3 | Lint clean | |
| 1.4 | Build succeeds | |
| 2.1 | `goToDefinition` returns correct locations | |
| 2.2 | `hover` returns type info | |
| 2.3 | `findReferences` returns multiple locations | |
| 2.4 | `documentSymbol` lists file symbols | |
| 2.5 | `workspaceSymbol` searches across project | |
| 2.6 | `goToImplementation` finds implementations | |
| 2.7 | `incomingCalls` finds callers | |
| 2.8 | `outgoingCalls` finds callees | |
| 2.9 | `diagnostics` returns errors/warnings | |
| 3.1 | Non-existent file returns "File not found" error | |
| 3.2 | `.md` file returns "No LSP server available" error | |
| 3.3 | Missing line/char returns "requires line and character" error | |
| 3.4 | Relative paths resolve correctly | |
| 4.1 | Server spawns lazily on first use | |
| 4.2 | Server shuts down on last session disconnect | |
| 4.3 | Multiple sessions share LSP service per worktree | |
| 4.4 | LSP failure doesn't break Claude sessions | |
| 5.1 | Go server works (if installed) | |
| 5.2 | Python server works (if installed) | |
| 5.3 | Rust server works (if installed) | |
| 6.1 | 1-based to 0-based position conversion correct | |
