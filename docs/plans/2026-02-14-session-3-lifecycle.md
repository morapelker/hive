# Session 3: Real Session Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Claude session creation and resume fully real and restart-safe via the `connect`, `reconnect`, `disconnect`, and `cleanup` methods in `ClaudeCodeImplementer`.

**Architecture:** The Claude Agent SDK's `query()` function requires a real prompt to create a new session — empty-string prompts only work for `resume`. Therefore, `connect()` uses a **deferred creation** model: it returns a placeholder session ID (UUID), and the real Claude session ID is obtained during the first `prompt()` call. `reconnect()` trusts the persisted session ID from the DB and registers it in memory, deferring actual SDK interaction to the next prompt. `disconnect()` aborts any active Query and removes the session from the in-memory map.

**Tech Stack:** TypeScript, Vitest, `@anthropic-ai/claude-agent-sdk` (the `query` function), Electron main process

---

## Key Design Decisions

1. **Deferred session creation:** `connect()` generates a `pending::<uuid>` placeholder ID. The Claude SDK is not contacted until `prompt()` is called. This avoids wasting API calls and matches the SDK's prompt-first design.

2. **Reconnect = trust + register:** `reconnect()` just stores the persisted session ID in the in-memory `sessions` map and returns `{ success: true, sessionStatus: 'idle' }`. The actual `options.resume` is passed during the next `prompt()`.

3. **Session state shape:** `ClaudeSessionState` gains two new fields:
   - `query: Query | null` — the active `AsyncGenerator` from the SDK (set during `prompt()`)
   - `materialized: boolean` — `false` for placeholder sessions, `true` once the SDK assigns a real session ID

4. **IPC routing is NOT in scope.** The IPC handlers in `opencode-handlers.ts` still hardcode `openCodeService`. SDK-aware routing is planned for later sessions. For now, Session 3 only implements the methods on `ClaudeCodeImplementer` itself, which are called by tests and will be called by routed IPC in a future session.

5. **Cleanup enhancement:** The existing `cleanup()` already aborts controllers and clears the map. We enhance it to also call `query.close()` on any active Query instances.

---

## Task 1: Expand `ClaudeSessionState` with Query and materialized flag

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts:8-14`

**Step 1: Update the `ClaudeSessionState` interface**

Add the two new fields. The `Query` type needs a lightweight local type alias since we don't want to import the full SDK at the type level (it's dynamically loaded).

```typescript
// At the top of the file, add a type alias for the Query object
// We use a minimal interface to avoid importing the full SDK at module level
export interface ClaudeQuery {
  interrupt(): Promise<void>
  close(): void
  return?(value?: void): Promise<IteratorResult<unknown, void>>
  next(...args: unknown[]): Promise<IteratorResult<unknown, void>>
  [Symbol.asyncIterator](): AsyncGenerator<unknown, void>
}

export interface ClaudeSessionState {
  claudeSessionId: string
  hiveSessionId: string
  worktreePath: string
  abortController: AbortController | null
  checkpoints: Map<string, number>
  query: ClaudeQuery | null // Active SDK Query (set during prompt, null before first prompt)
  materialized: boolean // false = placeholder ID, true = real SDK session ID
}
```

**Step 2: Verify the file still compiles**

Run: `pnpm tsc --noEmit --project tsconfig.node.json 2>&1 | head -20`
Expected: No new errors from this change.

**Step 3: Commit**

```bash
git add src/main/services/claude-code-implementer.ts
git commit -m "feat(claude): add Query and materialized fields to ClaudeSessionState"
```

---

## Task 2: Write failing tests for `connect()`

**Files:**

- Create: `test/phase-21/session-3/claude-lifecycle.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test ClaudeCodeImplementer directly
// Import the class and its session state type
import {
  ClaudeCodeImplementer,
  ClaudeSessionState
} from '../../../src/main/services/claude-code-implementer'

describe('ClaudeCodeImplementer - Session Lifecycle (Session 3)', () => {
  let implementer: ClaudeCodeImplementer

  beforeEach(() => {
    implementer = new ClaudeCodeImplementer()
  })

  describe('connect()', () => {
    it('should return a placeholder session ID starting with "pending::"', async () => {
      const result = await implementer.connect('/path/to/worktree', 'hive-session-1')
      expect(result.sessionId).toMatch(/^pending::/)
    })

    it('should return a unique UUID in the placeholder ID', async () => {
      const result1 = await implementer.connect('/path/to/worktree', 'hive-session-1')
      const result2 = await implementer.connect('/path/to/worktree2', 'hive-session-2')
      expect(result1.sessionId).not.toBe(result2.sessionId)
    })

    it('should register the session in the internal sessions map', async () => {
      const result = await implementer.connect('/path/to/worktree', 'hive-session-1')
      // Access internal state via the protected getSession helper
      // We cast to access protected members in tests
      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/path/to/worktree', result.sessionId)
      ) as ClaudeSessionState
      expect(session).toBeDefined()
      expect(session.hiveSessionId).toBe('hive-session-1')
      expect(session.worktreePath).toBe('/path/to/worktree')
      expect(session.claudeSessionId).toBe(result.sessionId)
      expect(session.materialized).toBe(false)
      expect(session.query).toBeNull()
    })

    it('should create an AbortController for the session', async () => {
      const result = await implementer.connect('/path/to/worktree', 'hive-session-1')
      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/path/to/worktree', result.sessionId)
      ) as ClaudeSessionState
      expect(session.abortController).toBeInstanceOf(AbortController)
      expect(session.abortController!.signal.aborted).toBe(false)
    })

    it('should initialize empty checkpoints map', async () => {
      const result = await implementer.connect('/path/to/worktree', 'hive-session-1')
      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/path/to/worktree', result.sessionId)
      ) as ClaudeSessionState
      expect(session.checkpoints).toBeInstanceOf(Map)
      expect(session.checkpoints.size).toBe(0)
    })

    it('should log the connection', async () => {
      // Just verify no error is thrown — logging is a side effect
      await expect(
        implementer.connect('/path/to/worktree', 'hive-session-1')
      ).resolves.toBeDefined()
    })
  })

  describe('reconnect()', () => {
    it('should register the persisted session ID in the sessions map', async () => {
      const result = await implementer.reconnect(
        '/path/to/worktree',
        'claude-session-abc123',
        'hive-session-1'
      )
      expect(result.success).toBe(true)
      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/path/to/worktree', 'claude-session-abc123')
      ) as ClaudeSessionState
      expect(session).toBeDefined()
      expect(session.claudeSessionId).toBe('claude-session-abc123')
      expect(session.hiveSessionId).toBe('hive-session-1')
      expect(session.worktreePath).toBe('/path/to/worktree')
    })

    it('should mark reconnected sessions as materialized', async () => {
      await implementer.reconnect('/path/to/worktree', 'claude-session-abc123', 'hive-session-1')
      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/path/to/worktree', 'claude-session-abc123')
      ) as ClaudeSessionState
      expect(session.materialized).toBe(true)
    })

    it('should return idle status (deferred validation)', async () => {
      const result = await implementer.reconnect(
        '/path/to/worktree',
        'claude-session-abc123',
        'hive-session-1'
      )
      expect(result).toEqual({
        success: true,
        sessionStatus: 'idle',
        revertMessageID: null
      })
    })

    it('should create a fresh AbortController for the reconnected session', async () => {
      await implementer.reconnect('/path/to/worktree', 'claude-session-abc123', 'hive-session-1')
      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/path/to/worktree', 'claude-session-abc123')
      ) as ClaudeSessionState
      expect(session.abortController).toBeInstanceOf(AbortController)
    })

    it('should replace existing session state if reconnecting to same session', async () => {
      // First connect creates a session
      const connectResult = await implementer.connect('/path/to/worktree', 'hive-session-1')

      // Reconnect with a real session ID should add a NEW entry (different key)
      await implementer.reconnect('/path/to/worktree', 'real-claude-id', 'hive-session-1')

      // Both entries exist (placeholder + real)
      const sessions = (implementer as any).sessions as Map<string, ClaudeSessionState>
      expect(sessions.size).toBe(2)
    })

    it('should set query to null (deferred SDK interaction)', async () => {
      await implementer.reconnect('/path/to/worktree', 'claude-session-abc123', 'hive-session-1')
      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/path/to/worktree', 'claude-session-abc123')
      ) as ClaudeSessionState
      expect(session.query).toBeNull()
    })
  })

  describe('disconnect()', () => {
    it('should remove the session from the sessions map', async () => {
      const { sessionId } = await implementer.connect('/path/to/worktree', 'hive-session-1')
      await implementer.disconnect('/path/to/worktree', sessionId)
      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/path/to/worktree', sessionId)
      )
      expect(session).toBeUndefined()
    })

    it('should abort the AbortController on disconnect', async () => {
      const { sessionId } = await implementer.connect('/path/to/worktree', 'hive-session-1')
      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/path/to/worktree', sessionId)
      ) as ClaudeSessionState
      const controller = session.abortController!
      await implementer.disconnect('/path/to/worktree', sessionId)
      expect(controller.signal.aborted).toBe(true)
    })

    it('should call query.close() if a Query is active', async () => {
      const { sessionId } = await implementer.connect('/path/to/worktree', 'hive-session-1')
      // Simulate an active query by manually setting it
      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/path/to/worktree', sessionId)
      ) as ClaudeSessionState
      const mockQuery = { close: vi.fn(), interrupt: vi.fn().mockResolvedValue(undefined) }
      session.query = mockQuery as any
      await implementer.disconnect('/path/to/worktree', sessionId)
      expect(mockQuery.close).toHaveBeenCalled()
    })

    it('should not throw if session does not exist', async () => {
      await expect(
        implementer.disconnect('/path/to/worktree', 'nonexistent-session')
      ).resolves.not.toThrow()
    })

    it('should not throw if query is null', async () => {
      const { sessionId } = await implementer.connect('/path/to/worktree', 'hive-session-1')
      // query is already null by default from connect
      await expect(implementer.disconnect('/path/to/worktree', sessionId)).resolves.not.toThrow()
    })
  })

  describe('cleanup()', () => {
    it('should close all active queries', async () => {
      const { sessionId: id1 } = await implementer.connect('/wt1', 'hive-1')
      const { sessionId: id2 } = await implementer.connect('/wt2', 'hive-2')

      // Attach mock queries
      const sessions = (implementer as any).sessions as Map<string, ClaudeSessionState>
      const mockQuery1 = { close: vi.fn(), interrupt: vi.fn().mockResolvedValue(undefined) }
      const mockQuery2 = { close: vi.fn(), interrupt: vi.fn().mockResolvedValue(undefined) }
      sessions.get((implementer as any).getSessionKey('/wt1', id1))!.query = mockQuery1 as any
      sessions.get((implementer as any).getSessionKey('/wt2', id2))!.query = mockQuery2 as any

      await implementer.cleanup()

      expect(mockQuery1.close).toHaveBeenCalled()
      expect(mockQuery2.close).toHaveBeenCalled()
    })

    it('should abort all AbortControllers and clear the sessions map', async () => {
      const { sessionId: id1 } = await implementer.connect('/wt1', 'hive-1')
      const { sessionId: id2 } = await implementer.connect('/wt2', 'hive-2')

      const sessions = (implementer as any).sessions as Map<string, ClaudeSessionState>
      const ac1 = sessions.get((implementer as any).getSessionKey('/wt1', id1))!.abortController!
      const ac2 = sessions.get((implementer as any).getSessionKey('/wt2', id2))!.abortController!

      await implementer.cleanup()

      expect(ac1.signal.aborted).toBe(true)
      expect(ac2.signal.aborted).toBe(true)
      expect(sessions.size).toBe(0)
    })

    it('should handle query.close() throwing without propagating', async () => {
      const { sessionId } = await implementer.connect('/wt1', 'hive-1')
      const sessions = (implementer as any).sessions as Map<string, ClaudeSessionState>
      const badQuery = {
        close: vi.fn(() => {
          throw new Error('close failed')
        }),
        interrupt: vi.fn().mockResolvedValue(undefined)
      }
      sessions.get((implementer as any).getSessionKey('/wt1', sessionId))!.query = badQuery as any

      // cleanup should not throw even if query.close() does
      await expect(implementer.cleanup()).resolves.not.toThrow()
      expect(sessions.size).toBe(0)
    })
  })

  describe('lifecycle integration', () => {
    it('connect -> disconnect -> reconnect: full cycle', async () => {
      // 1. Connect creates placeholder
      const { sessionId: placeholderId } = await implementer.connect('/wt', 'hive-1')
      expect(placeholderId).toMatch(/^pending::/)

      // 2. Disconnect removes it
      await implementer.disconnect('/wt', placeholderId)
      expect((implementer as any).sessions.size).toBe(0)

      // 3. Reconnect with a "real" session ID from DB
      const reconResult = await implementer.reconnect('/wt', 'real-claude-id', 'hive-1')
      expect(reconResult.success).toBe(true)

      const session = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/wt', 'real-claude-id')
      ) as ClaudeSessionState
      expect(session.materialized).toBe(true)
      expect(session.claudeSessionId).toBe('real-claude-id')
    })

    it('multiple sessions on different worktrees coexist independently', async () => {
      const r1 = await implementer.connect('/wt1', 'hive-1')
      const r2 = await implementer.connect('/wt2', 'hive-2')
      expect((implementer as any).sessions.size).toBe(2)

      await implementer.disconnect('/wt1', r1.sessionId)
      expect((implementer as any).sessions.size).toBe(1)

      // Remaining session is wt2
      const remaining = (implementer as any).sessions.get(
        (implementer as any).getSessionKey('/wt2', r2.sessionId)
      )
      expect(remaining).toBeDefined()
      expect(remaining.hiveSessionId).toBe('hive-2')
    })

    it('reconnect after app restart simulation (fresh implementer)', async () => {
      // Simulate app restart: create a new implementer instance
      const freshImplementer = new ClaudeCodeImplementer()

      // Reconnect with persisted session data
      const result = await freshImplementer.reconnect(
        '/wt',
        'persisted-claude-session-id',
        'hive-session-from-db'
      )

      expect(result.success).toBe(true)
      expect(result.sessionStatus).toBe('idle')

      // Session is registered and ready for next prompt
      const session = (freshImplementer as any).sessions.get(
        (freshImplementer as any).getSessionKey('/wt', 'persisted-claude-session-id')
      ) as ClaudeSessionState
      expect(session.materialized).toBe(true)
      expect(session.query).toBeNull()
      expect(session.hiveSessionId).toBe('hive-session-from-db')
    })
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/phase-21/session-3/claude-lifecycle.test.ts`
Expected: FAIL — `connect`, `reconnect`, and `disconnect` all throw "not yet implemented"

**Step 3: Commit**

```bash
git add test/phase-21/session-3/claude-lifecycle.test.ts
git commit -m "test(claude): add failing lifecycle tests for Session 3"
```

---

## Task 3: Implement `connect()`

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts:31-33`

**Step 1: Implement the method**

Replace the stub with:

```typescript
async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
  // Generate a placeholder session ID. The real Claude session ID will be
  // obtained when the first prompt() call streams from the SDK.
  const placeholderId = `pending::${crypto.randomUUID()}`

  const key = this.getSessionKey(worktreePath, placeholderId)
  const state: ClaudeSessionState = {
    claudeSessionId: placeholderId,
    hiveSessionId,
    worktreePath,
    abortController: new AbortController(),
    checkpoints: new Map(),
    query: null,
    materialized: false
  }
  this.sessions.set(key, state)

  log.info('Connected (deferred)', {
    worktreePath,
    hiveSessionId,
    placeholderId
  })

  return { sessionId: placeholderId }
}
```

Also add at the top of the file, inside the import block:

```typescript
import { randomUUID } from 'node:crypto'
```

And use `randomUUID()` instead of `crypto.randomUUID()` (Node.js main process).

**Step 2: Run the connect tests**

Run: `pnpm vitest run test/phase-21/session-3/claude-lifecycle.test.ts -t "connect"`
Expected: All `connect()` tests PASS

**Step 3: Commit**

```bash
git add src/main/services/claude-code-implementer.ts
git commit -m "feat(claude): implement connect() with deferred session creation"
```

---

## Task 4: Implement `reconnect()`

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts:35-45`

**Step 1: Implement the method**

Replace the stub with:

```typescript
async reconnect(
  worktreePath: string,
  agentSessionId: string,
  hiveSessionId: string
): Promise<{
  success: boolean
  sessionStatus?: 'idle' | 'busy' | 'retry'
  revertMessageID?: string | null
}> {
  const key = this.getSessionKey(worktreePath, agentSessionId)

  // If already registered (e.g., tab switch without full teardown), update the mapping
  const existing = this.sessions.get(key)
  if (existing) {
    existing.hiveSessionId = hiveSessionId
    log.info('Reconnect: session already registered, updated hiveSessionId', {
      worktreePath,
      agentSessionId,
      hiveSessionId
    })
    return { success: true, sessionStatus: 'idle', revertMessageID: null }
  }

  // Register the persisted session ID. Actual SDK resume happens on next prompt().
  const state: ClaudeSessionState = {
    claudeSessionId: agentSessionId,
    hiveSessionId,
    worktreePath,
    abortController: new AbortController(),
    checkpoints: new Map(),
    query: null,
    materialized: true // Persisted IDs from DB are real Claude session IDs
  }
  this.sessions.set(key, state)

  log.info('Reconnected (deferred)', {
    worktreePath,
    agentSessionId,
    hiveSessionId
  })

  return { success: true, sessionStatus: 'idle', revertMessageID: null }
}
```

**Step 2: Run the reconnect tests**

Run: `pnpm vitest run test/phase-21/session-3/claude-lifecycle.test.ts -t "reconnect"`
Expected: All `reconnect()` tests PASS

**Step 3: Commit**

```bash
git add src/main/services/claude-code-implementer.ts
git commit -m "feat(claude): implement reconnect() with deferred SDK validation"
```

---

## Task 5: Implement `disconnect()`

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts:47-49`

**Step 1: Implement the method**

Replace the stub with:

```typescript
async disconnect(worktreePath: string, agentSessionId: string): Promise<void> {
  const key = this.getSessionKey(worktreePath, agentSessionId)
  const session = this.sessions.get(key)

  if (!session) {
    log.warn('Disconnect: session not found, ignoring', { worktreePath, agentSessionId })
    return
  }

  // Close the active query if one exists
  if (session.query) {
    try {
      session.query.close()
    } catch {
      log.warn('Disconnect: query.close() threw, ignoring', { worktreePath, agentSessionId })
    }
    session.query = null
  }

  // Abort the controller to cancel any in-flight operations
  if (session.abortController) {
    session.abortController.abort()
  }

  this.sessions.delete(key)
  log.info('Disconnected', { worktreePath, agentSessionId })
}
```

**Step 2: Run the disconnect tests**

Run: `pnpm vitest run test/phase-21/session-3/claude-lifecycle.test.ts -t "disconnect"`
Expected: All `disconnect()` tests PASS

**Step 3: Commit**

```bash
git add src/main/services/claude-code-implementer.ts
git commit -m "feat(claude): implement disconnect() with query cleanup"
```

---

## Task 6: Enhance `cleanup()` to close active queries

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts:51-60`

**Step 1: Update cleanup to also close queries**

Replace the existing cleanup with:

```typescript
async cleanup(): Promise<void> {
  log.info('Cleaning up all Claude Code sessions', { count: this.sessions.size })
  for (const [key, session] of this.sessions) {
    // Close active query first
    if (session.query) {
      try {
        session.query.close()
      } catch {
        log.warn('Cleanup: query.close() threw, ignoring', { key })
      }
      session.query = null
    }
    // Then abort the controller
    if (session.abortController) {
      log.debug('Aborting session', { key })
      session.abortController.abort()
    }
  }
  this.sessions.clear()
}
```

**Step 2: Run the cleanup tests**

Run: `pnpm vitest run test/phase-21/session-3/claude-lifecycle.test.ts -t "cleanup"`
Expected: All `cleanup()` tests PASS

**Step 3: Commit**

```bash
git add src/main/services/claude-code-implementer.ts
git commit -m "feat(claude): enhance cleanup() to close active Query instances"
```

---

## Task 7: Run all tests and verify

**Step 1: Run the full Session 3 test suite**

Run: `pnpm vitest run test/phase-21/session-3/claude-lifecycle.test.ts`
Expected: All tests PASS (approximately 19 tests)

**Step 2: Run existing Session 2 tests to confirm no regressions**

Run: `pnpm vitest run test/phase-21/`
Expected: All Session 1 + Session 2 + Session 3 tests PASS

**Step 3: Run lint**

Run: `pnpm lint`
Expected: Clean or pre-existing warnings only

**Step 4: Run build**

Run: `pnpm build`
Expected: Build succeeds

**Step 5: Commit if any lint fixes were needed**

```bash
git add -A
git commit -m "chore: lint fixes for Session 3"
```

---

## Task 8: Update implementation doc to mark Session 3 complete

**Files:**

- Modify: `IMPLEMENTATION_CLAUDE_IMPL.md:103-106` — check all four task checkboxes
- Modify: `IMPLEMENTATION_CLAUDE_IMPL.md:110-111` — check test checkboxes
- Modify: `IMPLEMENTATION_CLAUDE_IMPL.md:115-116` — check DoD checkboxes

**Step 1: Update the checkboxes**

Change `- [ ]` to `- [x]` for all Session 3 items.

**Step 2: Commit**

```bash
git add IMPLEMENTATION_CLAUDE_IMPL.md
git commit -m "docs: mark Session 3 lifecycle tasks complete"
```

---

## Architecture Notes for Future Sessions

### How `prompt()` (Session 4) will use the deferred creation model:

When `prompt()` is called on a **non-materialized** session (`materialized: false`):

1. Load the SDK: `const { query } = await loadClaudeSDK()`
2. Create a new `AbortController` (or reuse the existing one)
3. Call `query({ prompt: message, options: { cwd: worktreePath, abortController, enableFileCheckpointing: true } })`
4. Iterate the returned `Query` generator. The first `SDKMessage` with a `session_id` field provides the real Claude session ID.
5. **Re-key** the session in `this.sessions`: delete the placeholder key, insert with the real session ID.
6. Emit an event to the renderer so it can update `opencode_session_id` in the DB via `window.db.session.update()`.
7. Set `materialized = true` and store the `Query` on `session.query`.

When `prompt()` is called on a **materialized** session:

1. Call `query({ prompt: message, options: { cwd: worktreePath, resume: session.claudeSessionId, abortController } })`
2. Store the new `Query` on `session.query`.
3. Iterate and stream events normally.

### Why `disconnect` does NOT call `query.interrupt()`:

`interrupt()` is for gracefully stopping a running prompt (the SDK finishes current tool use then stops). `close()` is for forcefully terminating the subprocess. Since `disconnect` means "we're done with this session entirely," `close()` is the right call. `abort` on top of `close` is belt-and-suspenders since the SDK internally checks the abort signal.
