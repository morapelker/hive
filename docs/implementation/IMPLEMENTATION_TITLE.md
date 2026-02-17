# Implementation Sessions: SDK-Based Title Generation

Reference: [PRD_TITLES.md](../prd/PRD_TITLES.md)

---

## Session 1: Rewrite `generateSessionTitle` to use Agent SDK

**Goal:** Replace the CLI-based (`execFile`) implementation with an in-process `sdk.query()` call.

### Tasks

1. Rewrite `src/main/services/claude-session-title.ts`:
   - Remove all `execFile`/`child_process` imports and types (`ExecFileExecutor`, `defaultExecFile`)
   - Import `loadClaudeSDK` from `./claude-sdk-loader`, `mkdirSync`/`existsSync` from `node:fs`, `join` from `node:path`, `homedir` from `node:os`
   - Compute `titlesDir` as `join(homedir(), '.hive', 'titles')`
   - Change function signature to `generateSessionTitle(message: string, claudeBinaryPath?: string | null): Promise<string | null>`
   - Ensure `~/.hive/titles/` exists via `mkdirSync(titlesDir, { recursive: true })`
   - Load SDK via `loadClaudeSDK()`
   - Build prompt from `TITLE_PROMPT + truncatedMessage` (keep existing prompt text and `MAX_MESSAGE_LENGTH` truncation)
   - Call `sdk.query({ prompt, options: { cwd: titlesDir, model: 'haiku', maxTurns: 1, pathToClaudeCodeExecutable (if provided) } })`
   - Create an `AbortController` with a 15s `setTimeout` for timeout protection, pass it in options, clean up on completion
   - Iterate async generator, extract text from the `result` message type (`msg.type === 'result'` → `msg.result`)
   - Trim result, validate (non-empty, ≤50 chars), return title or `null`
   - Wrap everything in try/catch — never throws, log errors

### Definition of Done

- `claude-session-title.ts` has zero references to `child_process`, `execFile`, `ExecFileExecutor`, `defaultExecFile`, `CLAUDECODE`
- Function uses `loadClaudeSDK()` → `sdk.query()` with `cwd: ~/.hive/titles/`
- Function signature is `(message, claudeBinaryPath?) → Promise<string | null>`
- File compiles with no TypeScript errors: `npx tsc --noEmit` on the file passes

### Testing Criteria

- Defer to Session 2 (unit tests rewrite)

---

## Session 2: Rewrite unit tests for `generateSessionTitle`

**Goal:** Replace all `execFile`-based mocks with `loadClaudeSDK` mocks.

### Tasks

1. Rewrite `test/claude-session-title.test.ts`:
   - Remove `ExecFileExecutor` import, `mockExecutor`, `mockExecFileSuccess`, `mockExecFileError` helpers
   - Mock `../src/main/services/claude-sdk-loader` returning a fake `loadClaudeSDK` that provides a `sdk.query()` returning an async generator
   - Mock `node:fs` for `mkdirSync`/`existsSync` (to avoid creating real dirs in tests)
   - Create helper `mockQueryResult(text: string)` that makes `sdk.query()` return an async generator yielding `{ type: 'result', result: text }`
   - Create helper `mockQueryError(err: Error)` that makes `sdk.query()` throw
   - Rewrite all existing test cases to use new helpers:
     - Returns trimmed title on successful SDK query
     - Returns `null` on empty SDK result
     - Returns `null` on whitespace-only SDK result
     - Returns `null` when title >50 chars
     - Returns title when exactly 50 chars
     - Returns `null` when SDK query throws
     - Truncates messages >2000 chars in the prompt passed to `sdk.query()`
     - Does not truncate messages under 2000 chars
     - Never throws — always returns string or `null`
   - Add new test cases for SDK-specific behavior:
     - Uses `model: 'haiku'` in query options
     - Sets `cwd` to `~/.hive/titles/` path
     - Passes `maxTurns: 1` in query options
     - Passes `pathToClaudeCodeExecutable` when `claudeBinaryPath` is provided
     - Omits `pathToClaudeCodeExecutable` when `claudeBinaryPath` is `null`/`undefined`
     - Creates `~/.hive/titles/` directory if it doesn't exist
     - Aborts query via AbortController after timeout

### Definition of Done

- Zero references to `execFile`, `ExecFileExecutor`, `mockExecutor` in the test file
- All tests mock `loadClaudeSDK` and `node:fs` instead of `child_process`
- All tests pass: `npx vitest run test/claude-session-title.test.ts`

### Testing Criteria

- `npx vitest run test/claude-session-title.test.ts` — all tests pass
- No skipped or pending tests

---

## Session 3: Update `handleTitleGeneration` and call site in `claude-code-implementer.ts`

**Goal:** Wire up the new signature and remove the binary-path guard.

### Tasks

1. In `src/main/services/claude-code-implementer.ts`, update `handleTitleGeneration`:
   - Change call from `generateSessionTitle(this.claudeBinaryPath!, userMessage)` to `generateSessionTitle(userMessage, this.claudeBinaryPath)`
   - Update JSDoc comment to say "via Agent SDK" instead of "via Claude CLI"
2. Update the call site in `prompt()` (~line 498-504):
   - Change `if (wasPending && this.claudeBinaryPath)` to `if (wasPending)`
   - (Binary path is now optional — SDK works without it)
3. Remove the now-unused `import { execFile as nodeExecFile } from 'node:child_process'` if it was only used by title generation (verify it's not used elsewhere in the file — it isn't, `claude-code-implementer.ts` never imported it)

### Definition of Done

- `handleTitleGeneration` calls `generateSessionTitle(userMessage, this.claudeBinaryPath)`
- Call site guard is `if (wasPending)` without binary path check
- File compiles with no TypeScript errors

### Testing Criteria

- `npx vitest run test/claude-code-title-integration.test.ts` — all 13 tests pass
- `npx vitest run test/phase-21/session-2/claude-code-implementer.test.ts` — all 18 tests pass
- `npx vitest run test/phase-21/session-3/claude-lifecycle.test.ts` — all 32 tests pass

---

## Session 4: Update integration tests

**Goal:** Ensure integration tests match the new `generateSessionTitle` signature.

### Tasks

1. In `test/claude-code-title-integration.test.ts`:
   - Verify the mock for `generateSessionTitle` still works — it uses `mockGenerateSessionTitle` which is signature-agnostic (it captures all args via `...args`)
   - If any tests assert on the arguments passed to `generateSessionTitle`, update the expected argument order from `(binaryPath, message)` to `(message, binaryPath)`
   - Run and confirm all 13 tests pass without changes (the mock is `(...args: any[]) => mockGenerateSessionTitle(...args)` which is flexible)

### Definition of Done

- All 13 integration tests pass with no modifications (or with minimal arg-order updates)
- No test references the old `(binaryPath, message)` argument order

### Testing Criteria

- `npx vitest run test/claude-code-title-integration.test.ts` — 13/13 pass
- `npx vitest run test/claude-session-title.test.ts test/claude-code-title-integration.test.ts test/phase-21/session-2/claude-code-implementer.test.ts` — all pass together

---

## Session 5: End-to-end verification and cleanup

**Goal:** Verify the full flow works, clean up dead code, confirm no regressions.

### Tasks

1. Run the combined test suite:
   - `npx vitest run test/claude-session-title.test.ts test/claude-code-title-integration.test.ts test/phase-21/session-2/claude-code-implementer.test.ts test/phase-21/session-3/claude-lifecycle.test.ts`
2. Verify `~/.hive/titles/` directory behavior:
   - Confirm the directory gets created on first title generation
   - Confirm SDK session artifacts land there, not in the project directory
3. Clean up `PRD_TITLES.md` and `IMPLEMENTATION_TITLE.md` — remove or move to docs if desired
4. Manual smoke test in the app:
   - Create a new Claude Code session
   - Send a first message (e.g. "Fix the authentication bug in login.ts")
   - Verify: session title updates in the sidebar within ~2-5s
   - Verify: branch auto-renames from breed name to title-based name
   - Send a second message — verify title does NOT regenerate
   - Create a new session via undo+fork — verify title does NOT regenerate on the fork

### Definition of Done

- All automated tests pass
- Manual smoke test confirms title appears in sidebar and branch renames
- No references to the old CLI-based approach remain in source or test files
- `~/.hive/titles/` directory is created and contains SDK artifacts

### Testing Criteria

- All test files pass: unit (session-title), integration (title-integration), implementer, lifecycle
- Manual: title visible in sidebar within 5s of first message
- Manual: branch renamed from breed name to title-based name
- Manual: no title regeneration on second message or fork
