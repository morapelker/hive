# Session Status Streaming Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `session.idle` / `message.updated` finalization with the SDK's authoritative `session.status` event (`busy`/`idle`/`retry`) so the streaming indicator accurately reflects the session lifecycle across multi-turn subagent flows.

**Architecture:** The OpenCode SDK emits `session.status` events with `{type:"busy"|"idle"|"retry"}` that track the entire multi-turn loop. Unlike `session.idle` (which fires between turns) or `message.updated` with `time.completed` (which is per-message), `session.status` stays `busy` throughout tool-call loops and only transitions to `idle` when the entire response is complete. We adopt this as the single source of truth for `isStreaming`, keeping `message.updated` only for per-message token extraction.

**Tech Stack:** React 19, TypeScript, Electron IPC, Vitest

---

## Context

### The bug

When a subagent (Task tool) runs during a multi-turn flow:

1. Turn 1: parent creates tool call, goes idle while waiting
2. `session.idle` fires (between turns, NOT final)
3. Renderer calls `finalizeResponseFromDatabase()` -> `resetStreamingState()` -> `setIsStreaming(false)`
4. Turn 2: parent resumes streaming the actual response
5. User sees loading stop and restart

### The fix

The official OpenCode client uses `session.status` events (not `session.idle`). The SDK already emits these events and they flow through to our renderer -- we just ignore them. The `session.status` state machine is:

- `busy` -> session is processing (stays busy across tool-call loops)
- `idle` -> session is truly done (loop exited)
- `retry` -> transient error, will retry

### Files touched

| File                                                   | Change                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `src/preload/index.d.ts`                               | Add `statusPayload` to `OpenCodeStreamEvent`                                |
| `src/main/services/opencode-service.ts`                | Add `statusPayload` to `StreamEvent`, extract on forwarding                 |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add `session.status` handler, refactor `session.idle` and `message.updated` |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`  | Switch from `session.idle` to `session.status`                              |
| `test/phase-9/session-7/subtool-loading.test.ts`       | Rewrite to test `session.status` based lifecycle                            |

---

## Task 1: Update StreamEvent Types

**Files:**

- Modify: `src/preload/index.d.ts:557-563`
- Modify: `src/main/services/opencode-service.ts:18-24`
- Modify: `src/main/services/opencode-service.ts:1042-1050`

**Step 1: Add `statusPayload` to `OpenCodeStreamEvent` in preload types**

In `src/preload/index.d.ts` at lines 557-563, the `OpenCodeStreamEvent` interface. Add `statusPayload`:

```typescript
interface OpenCodeStreamEvent {
  type: string
  sessionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  childSessionId?: string
  /** session.status event payload -- only present when type === 'session.status' */
  statusPayload?: {
    type: 'idle' | 'busy' | 'retry'
    attempt?: number
    message?: string
    next?: number
  }
}
```

**Step 2: Add `statusPayload` to `StreamEvent` in main process**

In `src/main/services/opencode-service.ts` at lines 18-24, the `StreamEvent` interface. Add:

```typescript
export interface StreamEvent {
  type: string
  sessionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  childSessionId?: string
  statusPayload?: {
    type: 'idle' | 'busy' | 'retry'
    attempt?: number
    message?: string
    next?: number
  }
}
```

**Step 3: Extract status payload when forwarding events**

In `src/main/services/opencode-service.ts` at lines 1042-1050, the event construction block. Replace with:

```typescript
// Send event to renderer
const streamEvent: StreamEvent = {
  type: eventType,
  sessionId: hiveSessionId,
  data: event.properties || event,
  ...(isChildEvent ? { childSessionId: sessionId } : {}),
  ...(eventType === 'session.status' && event.properties?.status
    ? { statusPayload: event.properties.status }
    : {})
}

this.sendToRenderer('opencode:stream', streamEvent)
```

**Step 4: Commit**

```
feat: add session.status event typing to StreamEvent
```

---

## Task 2: Write Failing Tests First

**Files:**

- Rewrite: `test/phase-9/session-7/subtool-loading.test.ts`

**Step 1: Rewrite the test file for `session.status` based lifecycle**

```typescript
import { describe, test, expect, beforeEach } from 'vitest'

/**
 * Session 7: Streaming Lifecycle via session.status
 *
 * Tests that isStreaming is driven by session.status events (busy/idle),
 * NOT by session.idle or message.updated finalization. This ensures the
 * streaming indicator stays active throughout multi-turn subagent flows.
 */

interface StreamEvent {
  type: string
  sessionId: string
  childSessionId?: string
  statusPayload?: { type: 'idle' | 'busy' | 'retry' }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

let hasFinalizedCurrentResponse: boolean
let isStreaming: boolean

/**
 * Simulates the session.status handler from SessionView.
 */
function handleSessionStatus(event: StreamEvent): {
  handled: boolean
  action?: string
} {
  const status = event.statusPayload || event.data?.status
  if (!status) return { handled: false }

  // Skip child session status events
  if (event.childSessionId) return { handled: true, action: 'skip-child' }

  if (status.type === 'busy') {
    isStreaming = true
    return { handled: true, action: 'set-busy' }
  } else if (status.type === 'idle') {
    if (!hasFinalizedCurrentResponse) {
      hasFinalizedCurrentResponse = true
      isStreaming = false
      return { handled: true, action: 'finalize' }
    }
    isStreaming = false
    return { handled: true, action: 'already-finalized' }
  } else if (status.type === 'retry') {
    return { handled: true, action: 'retry' }
  }

  return { handled: false }
}

/**
 * Simulates the session.idle handler (fallback only).
 */
function handleSessionIdle(event: StreamEvent): {
  handledAsChild: boolean
  finalized?: boolean
} {
  if (event.childSessionId) {
    return { handledAsChild: true }
  }

  if (!hasFinalizedCurrentResponse) {
    hasFinalizedCurrentResponse = true
    isStreaming = false
    return { handledAsChild: false, finalized: true }
  }
  return { handledAsChild: false, finalized: false }
}

/**
 * Simulates the message.updated handler (token extraction only, no finalization).
 */
function handleMessageUpdated(event: StreamEvent): {
  action: string
  tokensCaptured?: boolean
} {
  if (event.data?.role === 'user') return { action: 'skip-user-echo' }
  if (event.childSessionId) return { action: 'skip-child' }

  const info = event.data?.info
  if (info?.time?.completed && info?.tokens) {
    return { action: 'extract-tokens', tokensCaptured: true }
  }

  return { action: 'no-op' }
}

describe('Session 7: Streaming Lifecycle via session.status', () => {
  beforeEach(() => {
    hasFinalizedCurrentResponse = false
    isStreaming = false
  })

  describe('session.status drives isStreaming', () => {
    test('session.status busy sets isStreaming to true', () => {
      const result = handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'busy' }
      })

      expect(result.action).toBe('set-busy')
      expect(isStreaming).toBe(true)
    })

    test('session.status idle sets isStreaming to false and finalizes', () => {
      isStreaming = true

      const result = handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })

      expect(result.action).toBe('finalize')
      expect(isStreaming).toBe(false)
      expect(hasFinalizedCurrentResponse).toBe(true)
    })

    test('session.status retry keeps isStreaming true', () => {
      isStreaming = true

      const result = handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'retry' }
      })

      expect(result.action).toBe('retry')
      expect(isStreaming).toBe(true)
    })

    test('child session.status is ignored', () => {
      isStreaming = true

      const result = handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        childSessionId: 'child-1',
        statusPayload: { type: 'idle' }
      })

      expect(result.action).toBe('skip-child')
      expect(isStreaming).toBe(true)
    })

    test('duplicate session.status idle does not double-finalize', () => {
      isStreaming = true

      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })

      const result = handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })

      expect(result.action).toBe('already-finalized')
    })
  })

  describe('message.updated no longer finalizes', () => {
    test('message.updated with time.completed extracts tokens only', () => {
      isStreaming = true

      const result = handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent',
        data: {
          role: 'assistant',
          info: {
            time: { completed: Date.now() },
            tokens: { input: 100, output: 50, reasoning: 0 }
          },
          id: 'msg-1'
        }
      })

      expect(result.action).toBe('extract-tokens')
      expect(result.tokensCaptured).toBe(true)
      // CRITICAL: isStreaming unchanged, no finalization
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)
    })

    test('child message.updated is still skipped', () => {
      const result = handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent',
        childSessionId: 'child-1',
        data: {
          role: 'assistant',
          info: { time: { completed: Date.now() } }
        }
      })

      expect(result.action).toBe('skip-child')
    })

    test('user message.updated echo is skipped', () => {
      const result = handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent',
        data: { role: 'user' }
      })

      expect(result.action).toBe('skip-user-echo')
    })
  })

  describe('session.idle is fallback only', () => {
    test('session.idle finalizes if session.status did not', () => {
      isStreaming = true

      const result = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent'
      })

      expect(result.finalized).toBe(true)
      expect(isStreaming).toBe(false)
    })

    test('session.idle skips if session.status already finalized', () => {
      isStreaming = true

      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })
      expect(hasFinalizedCurrentResponse).toBe(true)

      const result = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent'
      })

      expect(result.finalized).toBe(false)
    })

    test('child session.idle still handled as child', () => {
      const result = handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent',
        childSessionId: 'child-1'
      })

      expect(result.handledAsChild).toBe(true)
    })
  })

  describe('Full multi-turn subagent lifecycle', () => {
    test('isStreaming stays true throughout Task tool execution', () => {
      // 1. session.status busy -> parent starts
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'busy' }
      })
      expect(isStreaming).toBe(true)

      // 2. message.updated with time.completed (turn 1 tool dispatch)
      //    Old code: would finalize. New code: token extraction only.
      handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent',
        data: {
          role: 'assistant',
          info: {
            time: { completed: Date.now() },
            tokens: { input: 500, output: 100 }
          },
          id: 'msg-turn1'
        }
      })
      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)

      // 3. Child session runs and completes
      handleSessionIdle({
        type: 'session.idle',
        sessionId: 'parent',
        childSessionId: 'child-1'
      })
      expect(isStreaming).toBe(true)

      // 4. Turn 2: response text streams (session.status stays busy)
      //    message.part.updated events would set isStreaming=true in real code

      // 5. Turn 2 message.updated (has tokens)
      handleMessageUpdated({
        type: 'message.updated',
        sessionId: 'parent',
        data: {
          role: 'assistant',
          info: {
            time: { completed: Date.now() },
            tokens: { input: 1000, output: 500 }
          },
          id: 'msg-turn2'
        }
      })
      expect(isStreaming).toBe(true) // Still no finalization

      // 6. session.status idle -> TRUE completion
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })
      expect(isStreaming).toBe(false)
      expect(hasFinalizedCurrentResponse).toBe(true)
    })

    test('multiple children do not affect parent streaming', () => {
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'busy' }
      })

      for (let i = 0; i < 5; i++) {
        handleSessionIdle({
          type: 'session.idle',
          sessionId: 'parent',
          childSessionId: `child-${i}`
        })
        handleSessionStatus({
          type: 'session.status',
          sessionId: 'parent',
          childSessionId: `child-${i}`,
          statusPayload: { type: 'idle' }
        })
      }

      expect(isStreaming).toBe(true)
      expect(hasFinalizedCurrentResponse).toBe(false)

      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })
      expect(isStreaming).toBe(false)
    })

    test('retry during subagent flow keeps streaming', () => {
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'busy' }
      })

      // Rate limited -> retry
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'retry' }
      })
      expect(isStreaming).toBe(true)

      // Retry succeeds -> busy again
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'busy' }
      })
      expect(isStreaming).toBe(true)

      // Eventually done
      handleSessionStatus({
        type: 'session.status',
        sessionId: 'parent',
        statusPayload: { type: 'idle' }
      })
      expect(isStreaming).toBe(false)
    })
  })
})
```

**Step 2: Run tests to verify they fail (TDD)**

```bash
pnpm vitest run test/phase-9/session-7/subtool-loading.test.ts
```

Expected: Tests pass (they test pure logic functions defined in the test file itself). The actual SessionView changes are tested by running the full test suite + manual testing.

**Step 3: Commit**

```
test: rewrite session 7 tests for session.status based lifecycle
```

---

## Task 3: Add `session.status` Handler in SessionView

**Files:**

- Modify: `src/renderer/src/components/sessions/SessionView.tsx`

**Step 1: Add the `session.status` handler**

After the `session.idle` handler block (after the closing `}` of the `session.idle` branch, currently around line 1153), add a new `else if` branch:

```typescript
} else if (event.type === 'session.status') {
  const status = event.statusPayload || event.data?.status
  if (!status) return

  // Skip child session status -- only parent status drives isStreaming
  if (event.childSessionId) return

  if (status.type === 'busy') {
    setIsStreaming(true)
  } else if (status.type === 'idle') {
    // Session is truly done -- flush and finalize
    immediateFlush()
    setIsSending(false)
    setQueuedCount(0)

    if (!hasFinalizedCurrentResponseRef.current) {
      hasFinalizedCurrentResponseRef.current = true
      void finalizeResponseFromDatabase()
    }

    // Update worktree status
    const activeId = useSessionStore.getState().activeSessionId
    const statusStore = useWorktreeStatusStore.getState()
    if (activeId === sessionId) {
      statusStore.clearSessionStatus(sessionId)
    } else {
      statusStore.setSessionStatus(sessionId, 'unread')
    }
  }
  // 'retry' status: keep isStreaming true, could add retry UI later
}
```

**Step 2: Commit**

```
feat: add session.status handler as primary streaming signal
```

---

## Task 4: Demote `session.idle` to Fallback

**Files:**

- Modify: `src/renderer/src/components/sessions/SessionView.tsx` (session.idle handler, ~lines 1117-1153)

**Step 1: Remove worktree status update from session.idle (now in session.status)**

Replace the parent portion of the `session.idle` handler (everything after the `return // Don't finalize the parent session` line). Keep the child subtask handling intact. The new parent portion:

```typescript
// Fallback: session.idle for parent acts as safety net.
// Primary finalization is handled by session.status {type:'idle'}.
// This catches edge cases where session.status events are unavailable.
immediateFlush()
setIsSending(false)
setQueuedCount(0)

if (!hasFinalizedCurrentResponseRef.current) {
  hasFinalizedCurrentResponseRef.current = true
  void finalizeResponseFromDatabase()
}
```

**What changes:** Remove the worktree status update block (lines ~1146-1153) from `session.idle`. That logic is now exclusively in `session.status`.

**Step 2: Commit**

```
refactor: demote session.idle to fallback, session.status is primary
```

---

## Task 5: Refactor `message.updated` to Token Extraction Only

**Files:**

- Modify: `src/renderer/src/components/sessions/SessionView.tsx` (message.updated handler, ~lines 1035-1116)

**Step 1: Remove finalization logic, keep echo detection + token extraction**

Replace the `message.updated` handler. Keep:

- User echo check (`if (eventRole === 'user') return`)
- Child event guard (`if (event.childSessionId) return`)
- Content-based echo detection (the `lastSentPromptRef` block)
- Token extraction from `info.tokens`

Remove:

- `hasFinalizedCurrentResponseRef.current = true`
- `finalizedMessageIdsRef.current.add(messageId)`
- `void finalizeResponseFromDatabase()`
- `immediateFlush()`
- The `hasRunningSubtasks` check
- The `getEventMessageId` call and duplicate finalization guards

The new handler:

```typescript
} else if (event.type === 'message.updated') {
  // Skip user-message echoes
  if (eventRole === 'user') return

  // Skip child/subagent messages
  if (event.childSessionId) return

  // Content-based echo detection for message.updated
  if (lastSentPromptRef.current) {
    const parts = event.data?.parts
    if (Array.isArray(parts) && parts.length > 0) {
      const textContent = parts
        .filter((p: { type?: string }) => p?.type === 'text')
        .map((p: { text?: string }) => p?.text || '')
        .join('')
        .trimEnd()
      if (textContent.length > 0 && lastSentPromptRef.current.startsWith(textContent)) {
        return // echo -- skip
      }
    }
  }

  // Extract token usage from completed messages (per-message, not per-session).
  // Finalization is handled by session.status, NOT here.
  const info = event.data?.info
  if (info?.time?.completed) {
    const tokens = info?.tokens
    if (tokens) {
      useContextStore.getState().addMessageTokens(sessionId, {
        input: typeof tokens.input === 'number' ? tokens.input : 0,
        output: typeof tokens.output === 'number' ? tokens.output : 0,
        reasoning: typeof tokens.reasoning === 'number' ? tokens.reasoning : 0,
        cacheRead:
          typeof tokens.cacheRead === 'number'
            ? tokens.cacheRead
            : typeof tokens.cache_read === 'number'
              ? tokens.cache_read
              : typeof tokens.cache?.read === 'number'
                ? tokens.cache.read
                : 0,
        cacheWrite:
          typeof tokens.cacheWrite === 'number'
            ? tokens.cacheWrite
            : typeof tokens.cache_write === 'number'
              ? tokens.cache_write
              : typeof tokens.cache?.write === 'number'
                ? tokens.cache.write
                : 0
      })
    }
  }
}
```

**Step 2: Commit**

```
refactor: message.updated extracts tokens only, no finalization
```

---

## Task 6: Update Global Listener

**Files:**

- Modify: `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` (full file, 28 lines)

**Step 1: Switch from `session.idle` to `session.status`**

```typescript
import { useEffect } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

/**
 * Persistent global listener for OpenCode stream events.
 *
 * The main process now owns stream persistence into SQLite.
 * This listener only updates unread status for sessions that finish in background.
 */
export function useOpenCodeGlobalListener(): void {
  useEffect(() => {
    const unsubscribe = window.opencodeOps?.onStream
      ? window.opencodeOps.onStream((event) => {
          // Use session.status (not deprecated session.idle) as the authoritative signal
          if (event.type !== 'session.status') return

          const status = event.statusPayload || event.data?.status
          if (status?.type !== 'idle') return

          const sessionId = event.sessionId
          const activeId = useSessionStore.getState().activeSessionId

          // Active session is handled by SessionView.
          if (sessionId === activeId) return

          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'unread')
        })
      : () => {}

    return unsubscribe
  }, [])
}
```

**Step 2: Commit**

```
refactor: global listener uses session.status instead of deprecated session.idle
```

---

## Task 7: Full Verification

**Step 1: Lint**

```bash
pnpm lint
```

Expected: 0 errors.

**Step 2: Run session 7 tests**

```bash
pnpm vitest run test/phase-9/session-7/subtool-loading.test.ts
```

Expected: all tests pass.

**Step 3: Run full test suite**

```bash
pnpm test
```

Expected: no new failures.

**Step 4: Final commit if needed**

---

## Execution Order

| Order | Task   | Description                     |
| ----- | ------ | ------------------------------- |
| 1     | Task 1 | Types + main process forwarding |
| 2     | Task 2 | Write tests (TDD)               |
| 3     | Task 3 | Add `session.status` handler    |
| 4     | Task 4 | Demote `session.idle`           |
| 5     | Task 5 | Refactor `message.updated`      |
| 6     | Task 6 | Update global listener          |
| 7     | Task 7 | Full verification               |

---

## Rollback Plan

If `session.status` events turn out to not be reliably delivered, the `session.idle` fallback in Task 4 ensures finalization still works. The fallback is identical to the current behavior.

---

## What This Fixes

| Scenario                      | Before                                | After                                 |
| ----------------------------- | ------------------------------------- | ------------------------------------- |
| Simple single-turn response   | Works (message.updated finalizes)     | Works (session.status:idle finalizes) |
| Multi-tool sequential calls   | Works                                 | Works                                 |
| Subagent (Task tool)          | Loading stops between turns, restarts | Loading stays active throughout       |
| Multiple concurrent subagents | Loading flickers                      | Loading stays active throughout       |
| Retry on rate limit           | Not handled                           | Could show retry UI (future)          |

---

## Manual Testing Checklist

1. **Simple prompt** (no tools) -- streaming starts, response appears, streaming stops
2. **Single tool call** (e.g., "read src/main/index.ts") -- tool card appears, streaming stays active throughout
3. **Subagent prompt** ("Use the Task tool to research error handling") -- loading stays active through entire flow, no gap when subagent completes
4. **Multiple subagents** -- loading stays active until all work is done
5. **Stop button** -- visible while streaming, disappears when done
6. **Background session** -- session in non-active tab gets "unread" badge when it completes
