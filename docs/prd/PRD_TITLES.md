# PRD: Session Title Generation via Agent SDK

## Problem

The current CLI-based approach (`claude -p "..." --model haiku`) spawns a fresh Claude Code process for each title. This incurs a ~30-60s cold start (Node bootstrap, SDK init, auth handshake) and reliably times out. We need a fast approach that reuses the already-loaded SDK.

## Solution

Use the **already-imported `@anthropic-ai/claude-agent-sdk`** directly via `loadClaudeSDK()` → `sdk.query()` to run a lightweight Haiku query. The SDK is already loaded in memory — no cold start, no CLI process spawn.

To avoid polluting real project directories with SDK session artifacts (`.claude/` folders, JSONL transcripts), we run the query with `cwd` set to `~/.hive/titles/`.

## Implementation Steps

### Step 1: Rewrite `generateSessionTitle` in `claude-session-title.ts`

**Replace** the entire CLI-based implementation with an SDK-based one:

```typescript
import { loadClaudeSDK } from './claude-sdk-loader'
```

**New function signature** (drop `claudeBinaryPath` and `executor` params — no longer needed):

```typescript
export async function generateSessionTitle(
  message: string,
  claudeBinaryPath?: string | null
): Promise<string | null>
```

**Implementation:**

1. `import { mkdirSync, existsSync } from 'node:fs'` and `import { join } from 'node:path'` and `import { homedir } from 'node:os'`
2. Ensure `~/.hive/titles/` exists: `mkdirSync(titlesDir, { recursive: true })`
3. Load SDK: `const sdk = await loadClaudeSDK()`
4. Build the title prompt (same `TITLE_PROMPT + truncatedMessage` as today)
5. Call `sdk.query()` with minimal options:
   ```typescript
   const query = sdk.query({
     prompt: fullPrompt,
     options: {
       cwd: titlesDir,
       model: 'haiku',
       maxTurns: 1,
       ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {})
     }
   })
   ```
6. Iterate the async generator, collecting assistant text:
   ```typescript
   let resultText = ''
   for await (const msg of query) {
     if (msg.type === 'result') {
       resultText = (msg as any).result ?? ''
       break
     }
   }
   ```
7. Trim, validate (non-empty, ≤50 chars), return title or `null`
8. Wrap everything in try/catch — never throws

**Key options:**
- `cwd: ~/.hive/titles/` — isolates SDK session artifacts from real projects
- `model: 'haiku'` — fast and cheap
- `maxTurns: 1` — one prompt, one response, done
- `pathToClaudeCodeExecutable` — still needed for ASAR compatibility, passed through from `ClaudeCodeImplementer`

**No longer needed:**
- `execFile` / `ExecFileExecutor` / `defaultExecFile` — removed entirely
- `CLAUDECODE` env stripping — not relevant (SDK, not CLI subprocess)
- 60s timeout — SDK query is fast (already connected)

**Timeout handling:**
- Use `AbortController` with a 15s `setTimeout` to abort the query if it takes too long
- Clean up with `clearTimeout` on success

### Step 2: Update `handleTitleGeneration` in `claude-code-implementer.ts`

**Minimal change** — update the call to match new signature:

```typescript
// Before:
const title = await generateSessionTitle(this.claudeBinaryPath!, userMessage)

// After:
const title = await generateSessionTitle(userMessage, this.claudeBinaryPath)
```

### Step 3: Update call site in `prompt()` method

**Minimal change** — remove the `this.claudeBinaryPath` guard since the SDK approach doesn't require a binary path to function:

```typescript
// Before:
if (wasPending && this.claudeBinaryPath) {
  this.handleTitleGeneration(session, prompt).catch(() => {})
}

// After:
if (wasPending) {
  this.handleTitleGeneration(session, prompt).catch(() => {})
}
```

(The binary path is still passed as an optional hint for ASAR compat, but its absence no longer prevents title generation.)

### Step 4: Update unit tests in `test/claude-session-title.test.ts`

**Rewrite** to mock `loadClaudeSDK` instead of `execFile`:

```typescript
vi.mock('../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))
```

Mock `sdk.query()` to return an async generator yielding `{ type: 'result', result: 'Fix auth refresh' }`.

**Test cases** (keep the same coverage):
1. Returns trimmed title on successful SDK query
2. Returns `null` when SDK returns empty result
3. Returns `null` when title >50 chars
4. Returns `null` when SDK query throws
5. Truncates messages >2000 chars in the prompt
6. Uses `model: 'haiku'` in query options
7. Uses `~/.hive/titles/` as cwd
8. Passes `maxTurns: 1`
9. Never throws — always returns string or `null`
10. Passes `pathToClaudeCodeExecutable` when provided
11. Omits `pathToClaudeCodeExecutable` when not provided
12. Aborts query after timeout

### Step 5: Update integration tests in `test/claude-code-title-integration.test.ts`

**Minimal change** — update the mock for `generateSessionTitle` to match new signature (message first, binary path second). All 13 existing integration tests should continue to pass with only the mock update.

### Step 6: Clean up dead code

- Remove `ExecFileExecutor` type export
- Remove `defaultExecFile` function
- Remove `import { execFile } from 'node:child_process'`
- Remove the `env: { ...process.env, CLAUDECODE: undefined }` logic

### Step 7: Run all tests

- `npx vitest run test/claude-session-title.test.ts`
- `npx vitest run test/claude-code-title-integration.test.ts`
- `npx vitest run test/phase-21/session-2/claude-code-implementer.test.ts`

## File Changes

| File | Action | What Changes |
|------|--------|-------------|
| `src/main/services/claude-session-title.ts` | **REWRITE** | Replace CLI spawn with `sdk.query()`, drop `execFile` deps |
| `src/main/services/claude-code-implementer.ts` | **MODIFY** | Update call signature (2 lines), remove binary path guard (1 line) |
| `test/claude-session-title.test.ts` | **REWRITE** | Mock `loadClaudeSDK` instead of `execFile` |
| `test/claude-code-title-integration.test.ts` | **MODIFY** | Update mock signature |

## Why This Is Better

| | CLI approach (old) | SDK approach (new) |
|---|---|---|
| **Cold start** | ~30-60s (spawn Node, load SDK, auth) | ~0s (SDK already loaded in memory) |
| **Process overhead** | New OS process per title | In-process async call |
| **Auth** | Needs own auth handshake | Shares parent session's auth |
| **Timeout risk** | High (60s still marginal) | Low (~2-5s expected) |
| **CLAUDECODE env hack** | Required | Not needed |
| **Binary path required** | Yes (hard requirement) | No (optional ASAR hint) |
