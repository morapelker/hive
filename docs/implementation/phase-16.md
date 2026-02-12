# Hive Phase 16 Implementation Plan

This document outlines the implementation plan for Hive Phase 16, focusing on undo/redo commands, fixing sessions randomly going idle, and capping run tab output history.

---

## Overview

The implementation is divided into **7 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 16 builds upon Phase 15** — all Phase 15 infrastructure is assumed to be in place.

---

## Dependencies & Parallelization

```
Session 1  (Undo/Redo: Research OpenCode SDK)   ── no deps
Session 2  (Undo/Redo: Backend IPC)             ── blocked by Session 1
Session 3  (Undo/Redo: Frontend Integration)     ── blocked by Session 2
Session 4  (Session Idle: Global Listener Fix)   ── no deps
Session 5  (Session Idle: SessionView Fix)       ── no deps (can parallel with S4)
Session 6  (Run Output Cap)                     ── no deps
Session 7  (Integration & Verification)          ── blocked by Sessions 1-6
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────────┐
│  Time →                                                              │
│                                                                      │
│  Track A: [S1: SDK Research] → [S2: IPC Backend] → [S3: Frontend]   │
│  Track B: [S4: Global Listener Fix]                                  │
│  Track C: [S5: SessionView Fix]                                      │
│  Track D: [S6: Run Output Cap]                                       │
│                                                                      │
│  All ──────────────────────────────────────────► [S7: Integration]   │
└──────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 1, 4, 5, 6 are fully independent. Sessions 4 and 5 can run in parallel (they touch different files for the same bug). Session 2 depends on Session 1 (research findings). Session 3 depends on Session 2 (IPC endpoints).

**Minimum total**: 4 rounds:

1. (S1, S4, S5, S6 in parallel)
2. (S2 — after S1)
3. (S3 — after S2)
4. (S7)

**Recommended serial order** (if doing one at a time):

S6 → S4 → S5 → S1 → S2 → S3 → S7

Rationale: S6 is the simplest self-contained change. S4 and S5 fix the highest-impact bug (sessions randomly idling). S1-S3 are sequential for undo/redo (research → backend → frontend). S7 validates everything.

---

## Testing Infrastructure

### Test File Structure (Phase 16)

```
test/
├── phase-16/
│   ├── session-1/
│   │   └── opencode-undo-redo-research.test.ts
│   ├── session-2/
│   │   └── undo-redo-ipc.test.ts
│   ├── session-3/
│   │   └── undo-redo-frontend.test.tsx
│   ├── session-4/
│   │   └── global-listener-busy.test.ts
│   ├── session-5/
│   │   └── session-idle-debounce.test.ts
│   ├── session-6/
│   │   └── run-output-cap.test.ts
│   └── session-7/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies — all features use existing packages:
# - zustand (stores — already installed)
# - lucide-react (icons — already installed)
# - sonner (toasts — already installed)
# - @opencode-ai/sdk (already installed)
```

---

## Session 1: Undo/Redo — Research OpenCode SDK API

### Objectives

- Study the opencode CLI client at `/Users/mor/Documents/dev/opencode` to understand how undo/redo works
- Document the exact SDK API for undo and redo (method names, parameters, return types)
- Determine whether undo/redo triggers stream events that the renderer needs to handle
- Understand preconditions and error cases

### Tasks

#### 1. Research the opencode CLI client

Explore the codebase at `/Users/mor/Documents/dev/opencode` to find:

- How undo/redo commands are defined and invoked
- What SDK client methods are called (`client.session.undo`, `client.session.redo`, or similar)
- What parameters are passed (session ID, directory, etc.)
- What the response shape looks like

#### 2. Research the OpenCode SDK type definitions

Look at the `@opencode-ai/sdk` package in `node_modules/@opencode-ai/sdk` to find:

- The type definitions for undo/redo endpoints
- Whether these are REST calls, SSE subscriptions, or something else
- The request/response types

#### 3. Document findings

Create a brief summary of the API shape to guide Sessions 2 and 3. This should include:

- Exact method signatures
- Required and optional parameters
- Expected response types
- Any stream events triggered by undo/redo
- Error conditions (nothing to undo, session busy, etc.)

### Key Files to Explore

- `/Users/mor/Documents/dev/opencode` — reference CLI client (undo/redo implementation)
- `node_modules/@opencode-ai/sdk/dist/index.d.ts` — SDK type definitions
- `src/main/services/opencode-service.ts` — existing SDK usage patterns in our codebase

### Definition of Done

- [ ] The exact SDK API for undo is documented (method, params, response)
- [ ] The exact SDK API for redo is documented (method, params, response)
- [ ] Stream event behavior after undo/redo is understood
- [ ] Error conditions are identified
- [ ] Findings are sufficient for Session 2 to implement the backend without further research

### How to Test

- This is a research session — verification is that the documented API matches what the SDK provides
- Cross-check documented method signatures against `node_modules/@opencode-ai/sdk/dist/index.d.ts`

### Testing Criteria

```typescript
// test/phase-16/session-1/opencode-undo-redo-research.test.ts
describe('Session 1: OpenCode SDK Undo/Redo API', () => {
  test('SDK client has undo method on session namespace', () => {
    // Verify the SDK type exports include session.undo
    // This validates that the research correctly identified the API
  })

  test('SDK client has redo method on session namespace', () => {
    // Verify the SDK type exports include session.redo
  })
})
```

---

## Session 2: Undo/Redo — Backend IPC Endpoints

### Objectives

- Add `undo()` and `redo()` methods to `opencode-service.ts` that call the OpenCode SDK
- Add `opencode:undo` and `opencode:redo` IPC handlers in `opencode-handlers.ts`
- Add preload bridge methods and type declarations

### Tasks

#### 1. Add `undo()` and `redo()` to `opencode-service.ts`

In `src/main/services/opencode-service.ts`, add two new methods. The exact SDK API calls should match the findings from Session 1:

```typescript
async undo(worktreePath: string, sessionId: string): Promise<{ success: boolean }> {
  const instance = await this.getOrCreateInstance()
  // Use the exact SDK method identified in Session 1 research
  await instance.client.session.undo(/* params from research */)
  return { success: true }
}

async redo(worktreePath: string, sessionId: string): Promise<{ success: boolean }> {
  const instance = await this.getOrCreateInstance()
  await instance.client.session.redo(/* params from research */)
  return { success: true }
}
```

#### 2. Add IPC handlers in `opencode-handlers.ts`

In `src/main/ipc/opencode-handlers.ts`, add two new handlers:

```typescript
ipcMain.handle('opencode:undo', async (_event, { worktreePath, sessionId }) => {
  try {
    const result = await openCodeService.undo(worktreePath, sessionId)
    return { success: true, ...result }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('opencode:redo', async (_event, { worktreePath, sessionId }) => {
  try {
    const result = await openCodeService.redo(worktreePath, sessionId)
    return { success: true, ...result }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})
```

#### 3. Add preload bridge in `preload/index.ts`

In `src/preload/index.ts`, inside the `opencodeOps` namespace:

```typescript
undo: (worktreePath: string, sessionId: string) =>
  ipcRenderer.invoke('opencode:undo', { worktreePath, sessionId }),
redo: (worktreePath: string, sessionId: string) =>
  ipcRenderer.invoke('opencode:redo', { worktreePath, sessionId })
```

#### 4. Add type declarations in `preload/index.d.ts`

In `src/preload/index.d.ts`, inside the `opencodeOps` interface:

```typescript
undo(worktreePath: string, sessionId: string): Promise<{ success: boolean; error?: string }>
redo(worktreePath: string, sessionId: string): Promise<{ success: boolean; error?: string }>
```

### Key Files

- `src/main/services/opencode-service.ts` — add `undo()` and `redo()` methods
- `src/main/ipc/opencode-handlers.ts` — add `opencode:undo` and `opencode:redo` handlers
- `src/preload/index.ts` — expose in `opencodeOps` namespace
- `src/preload/index.d.ts` — type declarations

### Definition of Done

- [ ] `opencode-service.ts` has `undo()` and `redo()` methods that call the SDK
- [ ] `opencode-handlers.ts` has `opencode:undo` and `opencode:redo` handlers with error handling
- [ ] `preload/index.ts` exposes `undo` and `redo` in `opencodeOps`
- [ ] `preload/index.d.ts` has type declarations for both methods
- [ ] Error cases return `{ success: false, error: string }`
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Verify the IPC handlers are registered by checking no duplicate channel errors on startup
2. Call `window.opencodeOps.undo()` from the dev console with a valid session — verify it returns `{ success: true }` or a meaningful error
3. Call `window.opencodeOps.redo()` similarly

### Testing Criteria

```typescript
// test/phase-16/session-2/undo-redo-ipc.test.ts
describe('Session 2: Undo/Redo IPC', () => {
  test('undo handler calls openCodeService.undo with correct params', async () => {
    // Mock openCodeService.undo to return { success: true }
    // Invoke the handler with { worktreePath: '/path', sessionId: 'sess-1' }
    // Verify openCodeService.undo called with '/path' and 'sess-1'
    // Verify result is { success: true }
  })

  test('undo handler returns error on failure', async () => {
    // Mock openCodeService.undo to throw Error('Nothing to undo')
    // Invoke handler
    // Verify result is { success: false, error: 'Nothing to undo' }
  })

  test('redo handler calls openCodeService.redo with correct params', async () => {
    // Similar to undo test
  })

  test('redo handler returns error on failure', async () => {
    // Similar to undo error test
  })
})
```

---

## Session 3: Undo/Redo — Frontend Integration

### Objectives

- Define built-in `/undo` and `/redo` commands that appear in the slash command popover
- Route these commands to the dedicated IPC endpoints (not through SDK command API)
- Reload messages from database after successful undo/redo
- Show toast notifications for success/failure

### Tasks

#### 1. Define built-in commands array in `SessionView.tsx`

In `src/renderer/src/components/sessions/SessionView.tsx`, add a static array of built-in commands above the component:

```typescript
const BUILT_IN_COMMANDS = [
  {
    name: 'undo',
    description: 'Undo the last assistant response',
    template: '/undo',
    builtIn: true as const
  },
  {
    name: 'redo',
    description: 'Redo the last undone response',
    template: '/redo',
    builtIn: true as const
  }
]
```

#### 2. Merge built-in commands with SDK commands for the popover

Update the `commands` prop passed to `SlashCommandPopover` to include built-in commands at the top:

```typescript
const allCommands = useMemo(() => [...BUILT_IN_COMMANDS, ...slashCommands], [slashCommands])
```

Pass `allCommands` instead of `slashCommands` to `SlashCommandPopover`.

#### 3. Route built-in commands in `handleSend`

At the top of the slash command detection block in `handleSend` (before the existing SDK command matching), add built-in command handling:

```typescript
if (trimmedValue.startsWith('/')) {
  const spaceIndex = trimmedValue.indexOf(' ')
  const commandName = spaceIndex > 0 ? trimmedValue.slice(1, spaceIndex) : trimmedValue.slice(1)

  // Built-in commands — handled locally, no user message created
  if (commandName === 'undo' || commandName === 'redo') {
    setInputValue('')
    setShowSlashCommands(false)
    try {
      const result =
        commandName === 'undo'
          ? await window.opencodeOps.undo(worktreePath, opencodeSessionId)
          : await window.opencodeOps.redo(worktreePath, opencodeSessionId)
      if (result.success) {
        await loadMessagesFromDatabase()
        toast.success(commandName === 'undo' ? 'Undone' : 'Redone')
      } else {
        toast.error(result.error || `Nothing to ${commandName}`)
      }
    } catch {
      toast.error(`${commandName === 'undo' ? 'Undo' : 'Redo'} failed`)
    }
    return
  }

  // ... existing SDK command matching below ...
}
```

Key behavior differences from SDK commands:

- Built-in commands do NOT save a user message to the database
- They do NOT display a user message in the chat
- They clear the input and execute immediately
- On success, messages are reloaded from DB to reflect the undone/redone state

#### 4. (Optional) Add visual distinction in `SlashCommandPopover.tsx`

In `src/renderer/src/components/sessions/SlashCommandPopover.tsx`, optionally add a subtle badge or styling for built-in commands to distinguish them from SDK commands. This is low priority and can be skipped if time is tight.

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — `BUILT_IN_COMMANDS`, merge with SDK commands, route in `handleSend`
- `src/renderer/src/components/sessions/SlashCommandPopover.tsx` — (optional) visual distinction

### Definition of Done

- [ ] Typing `/` shows `/undo` and `/redo` at the top of the command popover
- [ ] Selecting `/undo` from the popover fills the input with `/undo `
- [ ] Pressing Enter with `/undo` in the input calls `window.opencodeOps.undo()`, NOT `window.opencodeOps.command()`
- [ ] No user message is created in the chat for `/undo` or `/redo`
- [ ] On success, messages are reloaded from the database and a toast shows "Undone" / "Redone"
- [ ] On failure, an error toast shows the error message
- [ ] The input is cleared after execution regardless of success/failure
- [ ] `/undo` and `/redo` are filterable (typing `/un` shows `/undo`, typing `/re` shows `/redo`)
- [ ] Regular SDK slash commands still work as before
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a session and send a message, wait for the response
2. Type `/undo` and press Enter — verify the last assistant response is removed, toast shows "Undone"
3. Type `/redo` and press Enter — verify the response is restored, toast shows "Redone"
4. Type `/un` — verify the popover filters to show `/undo`
5. Click `/undo` in the popover — verify input becomes `/undo `, then press Enter
6. Try `/undo` when there's nothing to undo — verify error toast
7. Use a regular SDK command like `/compact` — verify it still works through the SDK endpoint
8. Verify no user message bubble appears in the chat for `/undo` or `/redo`

### Testing Criteria

```typescript
// test/phase-16/session-3/undo-redo-frontend.test.tsx
describe('Session 3: Undo/Redo Frontend', () => {
  test('BUILT_IN_COMMANDS are merged with SDK commands', () => {
    // Mock slashCommands with [{ name: 'compact', ... }]
    // Verify allCommands contains undo, redo, and compact
    // Verify undo and redo appear before compact
  })

  test('/undo calls window.opencodeOps.undo, not command', async () => {
    const undoMock = vi.fn().mockResolvedValue({ success: true })
    const commandMock = vi.fn()
    // Mock window.opencodeOps.undo = undoMock
    // Mock window.opencodeOps.command = commandMock
    // Simulate handleSend with '/undo'
    // Verify undoMock called, commandMock NOT called
  })

  test('/undo does not create a user message', async () => {
    // Mock window.opencodeOps.undo to return { success: true }
    // Mock window.db.message.create
    // Simulate handleSend with '/undo'
    // Verify window.db.message.create NOT called
  })

  test('/undo reloads messages on success', async () => {
    // Mock window.opencodeOps.undo to return { success: true }
    // Spy on loadMessagesFromDatabase
    // Simulate handleSend with '/undo'
    // Verify loadMessagesFromDatabase was called
  })

  test('/undo shows error toast on failure', async () => {
    // Mock window.opencodeOps.undo to return { success: false, error: 'Nothing to undo' }
    // Simulate handleSend with '/undo'
    // Verify toast.error called with 'Nothing to undo'
  })

  test('/redo calls window.opencodeOps.redo', async () => {
    // Similar to /undo test but for redo
  })

  test('unknown slash command still routes to SDK command API', async () => {
    // Mock slashCommands with [{ name: 'compact', ... }]
    // Simulate handleSend with '/compact'
    // Verify window.opencodeOps.command called (not undo/redo)
  })
})
```

---

## Session 4: Session Idle Bug — Global Listener Fix

### Objectives

- Handle `session.status busy` events in the global listener for background sessions
- Ensure background sessions transition from `'unread'` back to `'working'`/`'planning'` when they become busy again
- This addresses Gap 5 from the PRD (no busy-state tracking for background sessions)

### Tasks

#### 1. Handle `session.status busy` in `useOpenCodeGlobalListener.ts`

In `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`, the current code (around line 97) has:

```typescript
if (status?.type !== 'idle') return
```

This ignores ALL non-idle statuses for background sessions. Change to explicitly handle `busy`:

```typescript
if (status?.type === 'busy') {
  // Background session became busy again — restore working/planning status
  if (sessionId !== activeId) {
    const currentMode = useSessionStore.getState().getSessionMode(sessionId)
    useWorktreeStatusStore
      .getState()
      .setSessionStatus(sessionId, currentMode === 'plan' ? 'planning' : 'working')
  }
  return
}

if (status?.type !== 'idle') return
// ... existing idle handling unchanged below
```

This ensures that when a background session transitions from idle to busy (e.g., processing queued messages, continuing multi-step work, or resuming after a brief pause), the worktree sidebar correctly shows "Working" or "Planning" instead of staying at "Ready" or "Unread".

### Key Files

- `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` — handle `session.status busy` for background sessions

### Definition of Done

- [ ] Background sessions transitioning from idle to busy show "Working" or "Planning" in the sidebar
- [ ] The mode-aware status (`'working'` vs `'planning'`) is correctly derived from `getSessionMode`
- [ ] Active session events are still skipped (handled by SessionView)
- [ ] Existing idle handling is unaffected
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open two worktrees, start a session in each
2. Send a message in Worktree A, switch to Worktree B
3. When Worktree A's session completes (shows "Unread"), queue another message
4. Verify Worktree A's sidebar shows "Working" (not stuck at "Unread" or "Ready")
5. When the queued message completes, verify it transitions back to "Unread"

### Testing Criteria

```typescript
// test/phase-16/session-4/global-listener-busy.test.ts
describe('Session 4: Global Listener Busy Handling', () => {
  test('session.status busy sets working status for background session', () => {
    // Set activeSessionId to 'session-A'
    // Mock getSessionMode('session-B') to return 'build'
    // Fire onStream with { type: 'session.status', sessionId: 'session-B', statusPayload: { type: 'busy' } }
    // Verify setSessionStatus called with ('session-B', 'working')
  })

  test('session.status busy sets planning status for plan-mode background session', () => {
    // Set activeSessionId to 'session-A'
    // Mock getSessionMode('session-B') to return 'plan'
    // Fire onStream with session.status busy for session-B
    // Verify setSessionStatus called with ('session-B', 'planning')
  })

  test('session.status busy is ignored for the active session', () => {
    // Set activeSessionId to 'session-A'
    // Fire onStream with session.status busy for session-A
    // Verify setSessionStatus NOT called (active session handled by SessionView)
  })

  test('session.status idle still sets unread for background session', () => {
    // Set activeSessionId to 'session-A'
    // Fire onStream with session.status idle for session-B
    // Verify setSessionStatus called with ('session-B', 'unread')
  })
})
```

---

## Session 5: Session Idle Bug — SessionView Debounced Finalization

### Objectives

- Debounce `session.status idle` finalization in SessionView to handle rapid idle-busy-idle SDK transitions
- Guard `session.idle` (deprecated) fallback against firing while actively streaming
- Add diagnostic logging for status transitions
- This addresses Gaps 1, 2, 3 from the PRD

### Tasks

#### 1. Add debounced finalization for `session.status idle`

In `src/renderer/src/components/sessions/SessionView.tsx`, add an `idleTimerRef` and change the `session.status idle` handler from immediate to debounced:

```typescript
const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
```

In the `session.status` handler, replace the immediate idle handling:

**Current code (conceptual):**

```typescript
if (status.type === 'idle') {
  immediateFlush()
  setIsSending(false)
  // ... finalize immediately
}
```

**New code:**

```typescript
if (status.type === 'busy') {
  // Cancel any pending idle finalization
  if (idleTimerRef.current) {
    clearTimeout(idleTimerRef.current)
    idleTimerRef.current = null
  }
  setIsStreaming(true)
  newPromptPendingRef.current = false
  return
}

if (status.type === 'idle') {
  // Debounce: wait 300ms before finalizing, in case busy arrives immediately after
  if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
  idleTimerRef.current = setTimeout(() => {
    idleTimerRef.current = null
    immediateFlush()
    setIsSending(false)
    setQueuedMessages([])

    if (!hasFinalizedCurrentResponseRef.current) {
      hasFinalizedCurrentResponseRef.current = true
      void finalizeResponseFromDatabase()
    }

    const activeId = useSessionStore.getState().activeSessionId
    const statusStore = useWorktreeStatusStore.getState()
    if (activeId === sessionId) {
      statusStore.clearSessionStatus(sessionId)
    } else {
      statusStore.setSessionStatus(sessionId, 'unread')
    }
  }, 300)
  return
}
```

#### 2. Clean up idle timer on unmount

In the cleanup function of the stream subscription effect:

```typescript
return () => {
  unsubscribe()
  if (idleTimerRef.current) {
    clearTimeout(idleTimerRef.current)
    idleTimerRef.current = null
  }
}
```

#### 3. Guard `session.idle` fallback defensively

In the `session.idle` handler, add a guard against firing while streaming is active:

```typescript
} else if (event.type === 'session.idle') {
  if (event.childSessionId) {
    // ... existing child session handling — unchanged ...
    return
  }

  // Guard: if we are actively streaming and haven't finalized yet,
  // defer to session.status for authoritative finalization
  if (isStreaming && !hasFinalizedCurrentResponseRef.current) {
    console.warn(
      `[SessionView] session.idle received while streaming (session=${sessionId}). Deferring to session.status.`
    )
    return
  }

  // ... existing fallback finalization ...
}
```

#### 4. Add diagnostic logging

Add `console.debug` calls to status transition handlers to help diagnose any remaining issues:

```typescript
// In session.status handler:
console.debug(`[SessionView] session.status`, {
  type: status.type,
  sessionId,
  isStreaming,
  hasFinalizedRef: hasFinalizedCurrentResponseRef.current,
  isSending
})
```

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — debounced finalization, session.idle guard, diagnostic logging

### Definition of Done

- [ ] `session.status idle` finalization is debounced by 300ms
- [ ] `session.status busy` cancels any pending idle debounce timer
- [ ] `session.idle` fallback does NOT finalize if `isStreaming` is true (defers to `session.status`)
- [ ] The idle timer is cleaned up on component unmount
- [ ] Diagnostic logging is present for `session.status` transitions
- [ ] Sessions that briefly go idle between tool calls do NOT appear to finish
- [ ] Sessions that genuinely complete still finalize correctly (after 300ms)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a session that uses multiple tool calls in sequence
2. Observe that the session stays in "Working" state throughout (no brief flicker to "Ready")
3. When the session genuinely completes, verify it transitions to "Ready" within ~300ms
4. Check browser console for `[SessionView] session.status` debug logs during streaming
5. Start a session and switch tabs during streaming — switch back and verify it's still showing as streaming

### Testing Criteria

```typescript
// test/phase-16/session-5/session-idle-debounce.test.ts
describe('Session 5: SessionView Idle Debounce', () => {
  test('session.status idle does not finalize immediately', () => {
    // Fire session.status { type: 'idle' }
    // Verify finalizeResponseFromDatabase NOT called immediately
    // Advance timers by 200ms
    // Verify still NOT called
    // Advance timers to 300ms total
    // Verify NOW called
  })

  test('session.status busy cancels pending idle timer', () => {
    // Fire session.status { type: 'idle' }
    // Fire session.status { type: 'busy' } at +100ms
    // Advance timers to 500ms
    // Verify finalizeResponseFromDatabase NEVER called
  })

  test('rapid idle-busy-idle only finalizes on the last idle', () => {
    // Fire idle → busy → idle sequence
    // Only the last idle should trigger finalization after 300ms
  })

  test('session.idle is ignored while streaming', () => {
    // Set isStreaming = true, hasFinalizedCurrentResponseRef = false
    // Fire session.idle (without childSessionId)
    // Verify finalizeResponseFromDatabase NOT called
    // Verify console.warn logged
  })

  test('session.idle with childSessionId still updates subtask', () => {
    // Fire session.idle with childSessionId = 'child-1'
    // Verify subtask card status is updated (existing behavior preserved)
    // Verify parent session is NOT finalized
  })

  test('idle timer is cleared on unmount', () => {
    // Fire session.status idle
    // Unmount component before 300ms
    // Verify no finalization occurs after 300ms
  })
})
```

---

## Session 6: Run Output Cap (Ring Buffer)

### Objectives

- Cap the run tab output buffer at 500,000 characters to prevent unbounded memory growth
- Use a circular ring buffer so appends and evictions are O(1) — no array copying or shifting
- Show a truncation marker in the UI when old output has been evicted

### Architecture: Why a Ring Buffer

The current implementation uses `[...existing.runOutput, line]` on every append — a full O(n) array copy. When trimming, it additionally requires `slice()` — another O(n). For long-running dev servers producing thousands of chunks, this creates significant GC pressure and CPU waste.

A ring buffer solves this by:

- **O(1) append**: write at the current `head` position, advance `head`
- **O(1) eviction**: advance `tail` to discard oldest entries, no shifting
- **No array copying**: the backing array is pre-allocated and mutated in place
- **O(n) read only when rendering**: `toArray()` produces the ordered snapshot only when React needs it

```
Ring Buffer Visualization:

  Capacity: 8 slots       (in reality: 50,000)

  Initial state (3 entries):
  ┌───┬───┬───┬───┬───┬───┬───┬───┐
  │ A │ B │ C │   │   │   │   │   │
  └───┴───┴───┴───┴───┴───┴───┴───┘
    tail=0       head=3

  After wrapping + eviction (char limit hit):
  ┌───┬───┬───┬───┬───┬───┬───┬───┐
  │ H │   │   │ D │ E │ F │ G │ H │  ← H overwrites slot 0
  └───┴───┴───┴───┴───┴───┴───┴───┘
            tail=3           head=1

  toArray() reads: [D, E, F, G, H]  (tail → head, wrapping)
  A, B, C were evicted — truncated=true
```

The key design decision: the ring buffer lives **outside Zustand** as a module-level mutable data structure. Zustand only stores a `runOutputVersion` counter that increments on each append, triggering React re-renders. This avoids fighting Zustand's immutability model while keeping appends truly O(1).

### Tasks

#### 1. Create the `OutputRingBuffer` class

Create a new file `src/renderer/src/lib/output-ring-buffer.ts`:

```typescript
const MAX_CHARS = 500_000
const BUFFER_CAPACITY = 50_000 // max entries (50K * ~10 chars avg = 500K)
const TRUNCATION_MARKER = '\x00TRUNC:[older output truncated]'

export class OutputRingBuffer {
  private chunks: (string | null)[]
  private head: number = 0 // next write position
  private tail: number = 0 // oldest valid entry position
  private _count: number = 0 // number of valid entries
  private _totalChars: number = 0
  private _truncated: boolean = false

  constructor(private capacity: number = BUFFER_CAPACITY) {
    this.chunks = new Array(capacity).fill(null)
  }

  append(chunk: string): void {
    // If buffer is full (by entry count), evict oldest
    if (this._count === this.capacity) {
      this.evictOldest()
    }

    // Write at head
    this.chunks[this.head] = chunk
    this._totalChars += chunk.length
    this._count++
    this.head = (this.head + 1) % this.capacity

    // Evict oldest entries until under character limit
    while (this._totalChars > MAX_CHARS && this._count > 1) {
      this.evictOldest()
    }
  }

  private evictOldest(): void {
    const evicted = this.chunks[this.tail]
    if (evicted !== null) {
      this._totalChars -= evicted.length
      this.chunks[this.tail] = null
    }
    this.tail = (this.tail + 1) % this.capacity
    this._count--
    this._truncated = true
  }

  /**
   * Produce an ordered array for rendering.
   * Called only when React needs to render — not on every append.
   */
  toArray(): string[] {
    const result: string[] = []
    if (this._truncated) {
      result.push(TRUNCATION_MARKER)
    }
    for (let i = 0; i < this._count; i++) {
      const chunk = this.chunks[(this.tail + i) % this.capacity]
      if (chunk !== null) result.push(chunk)
    }
    return result
  }

  clear(): void {
    this.chunks.fill(null)
    this.head = 0
    this.tail = 0
    this._count = 0
    this._totalChars = 0
    this._truncated = false
  }

  get totalChars(): number {
    return this._totalChars
  }
  get count(): number {
    return this._count
  }
  get truncated(): boolean {
    return this._truncated
  }
}

// Module-level buffer registry — one per worktree
const buffers = new Map<string, OutputRingBuffer>()

export function getOrCreateBuffer(worktreeId: string): OutputRingBuffer {
  let buf = buffers.get(worktreeId)
  if (!buf) {
    buf = new OutputRingBuffer()
    buffers.set(worktreeId, buf)
  }
  return buf
}

export function deleteBuffer(worktreeId: string): void {
  buffers.delete(worktreeId)
}

export { TRUNCATION_MARKER }
```

**Why capacity = 50,000:**

- At average chunk size of ~10 chars, 50K entries \* 10 = 500K chars — matches the char limit
- For larger chunks (100+ chars), the 500K char limit is the binding constraint (evicts before capacity is reached)
- For very small chunks (1-2 chars), 50K entries is still ample history
- Memory: 50K pointers = ~400KB overhead — negligible

#### 2. Update `useScriptStore.ts` — replace `runOutput: string[]` with `runOutputVersion: number`

In `src/renderer/src/stores/useScriptStore.ts`:

**Replace the `ScriptState` interface:**

```typescript
interface ScriptState {
  setupOutput: string[]
  setupRunning: boolean
  setupError: string | null
  runOutputVersion: number // replaces runOutput: string[]
  runRunning: boolean
  runPid: number | null
}

function createDefaultScriptState(): ScriptState {
  return {
    setupOutput: [],
    setupRunning: false,
    setupError: null,
    runOutputVersion: 0, // replaces runOutput: []
    runRunning: false,
    runPid: null
  }
}
```

**Replace `appendRunOutput`:**

```typescript
import { getOrCreateBuffer } from '@/lib/output-ring-buffer'

appendRunOutput: (worktreeId, line) => {
  // O(1) mutation — no array copying
  const buffer = getOrCreateBuffer(worktreeId)
  buffer.append(line)

  // Bump version to trigger React re-render
  set((state) => {
    const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
    return {
      scriptStates: {
        ...state.scriptStates,
        [worktreeId]: {
          ...existing,
          runOutputVersion: existing.runOutputVersion + 1
        }
      }
    }
  })
}
```

**Replace `clearRunOutput`:**

```typescript
clearRunOutput: (worktreeId) => {
  const buffer = getOrCreateBuffer(worktreeId)
  buffer.clear()

  set((state) => {
    const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
    return {
      scriptStates: {
        ...state.scriptStates,
        [worktreeId]: {
          ...existing,
          runOutputVersion: existing.runOutputVersion + 1
        }
      }
    }
  })
}
```

Add a new getter for consumers that need the array:

```typescript
getRunOutput: (worktreeId: string): string[] => {
  const buffer = getOrCreateBuffer(worktreeId)
  return buffer.toArray()
}
```

Add `getRunOutput` to the `ScriptStore` interface as well.

#### 3. Update `RunTab.tsx` — read from ring buffer via version-driven selector

In `src/renderer/src/components/layout/RunTab.tsx`:

**Replace the `runOutput` subscription:**

```typescript
import { getOrCreateBuffer, TRUNCATION_MARKER } from '@/lib/output-ring-buffer'

// Subscribe to version counter (triggers re-render on each append)
const runOutputVersion = useScriptStore((s) =>
  worktreeId ? (s.scriptStates[worktreeId]?.runOutputVersion ?? 0) : 0
)

// Produce the ordered array only when version changes
const runOutput = useMemo(() => {
  if (!worktreeId) return emptyOutput
  return getOrCreateBuffer(worktreeId).toArray()
}, [worktreeId, runOutputVersion])
```

**Add truncation marker rendering** in the `runOutput.map()` block. Place BEFORE the existing `\x00CMD:` and `\x00ERR:` checks:

```tsx
if (line.startsWith('\x00TRUNC:')) {
  const msg = line.slice(7)
  return (
    <div
      key={i}
      className="text-muted-foreground text-center text-[10px] py-1 border-b border-border/50"
    >
      {msg}
    </div>
  )
}
```

**Update the auto-scroll dependency:**

```typescript
// Auto-scroll to bottom on new output
useEffect(() => {
  if (outputRef.current) {
    outputRef.current.scrollTop = outputRef.current.scrollHeight
  }
}, [runOutputVersion]) // was: [runOutput]
```

**Update empty/length checks** — replace `runOutput.length` with version-aware checks:

```typescript
const hasOutput = runOutput.length > 0
```

The rest of the rendering logic (`.map()`, status bar) remains the same since `runOutput` is still a `string[]`.

#### 4. Update `BottomPanel.tsx` — URL detection for "Open in Chrome"

In `src/renderer/src/components/layout/BottomPanel.tsx`, the URL detection reads `scriptState.runOutput` (lines 31-32). Update to use the store getter:

```typescript
// Replace:
//   if (!scriptState?.runRunning || !scriptState.runOutput?.length) return null
//   return extractDevServerUrl(scriptState.runOutput)

// With:
const runOutput = useScriptStore.getState().getRunOutput(worktreeId)
if (!scriptState?.runRunning || !runOutput.length) return null
return extractDevServerUrl(runOutput)
```

Or use the `runOutputVersion` selector to drive a `useMemo` similar to RunTab.

### Key Files

- `src/renderer/src/lib/output-ring-buffer.ts` — **new file**: `OutputRingBuffer` class, module-level registry
- `src/renderer/src/stores/useScriptStore.ts` — replace `runOutput: string[]` with `runOutputVersion: number`, use ring buffer
- `src/renderer/src/components/layout/RunTab.tsx` — read from ring buffer via version selector, render truncation marker
- `src/renderer/src/components/layout/BottomPanel.tsx` — update URL detection to use `getRunOutput()`

### Definition of Done

- [ ] `OutputRingBuffer.append()` is O(1) — no array copying or shifting
- [ ] `OutputRingBuffer.toArray()` produces the correct ordered output
- [ ] Old entries are evicted when total characters exceed 500,000
- [ ] Old entries are evicted when entry count exceeds 50,000 (capacity)
- [ ] A `[older output truncated]` marker appears at the top when entries have been evicted
- [ ] The truncation marker renders as a centered, muted, small text line in the Run tab
- [ ] `clear()` resets the buffer completely (no stale data)
- [ ] "Open in Chrome" URL detection still works (reads from `getRunOutput()`)
- [ ] Output under limits is unaffected (no premature eviction)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a dev server that produces continuous output (e.g., a watch mode build)
2. Let it run for several minutes
3. Verify the Run tab does not grow infinitely — scroll to the top and verify the truncation marker appears
4. Verify recent output is still visible and correctly rendered
5. Verify ANSI color codes still render correctly after eviction
6. Stop and restart the dev server — verify `clear` resets everything
7. If "Open in Chrome" is implemented — verify URL detection still works after buffer wraps

### Testing Criteria

```typescript
// test/phase-16/session-6/run-output-cap.test.ts
import { OutputRingBuffer } from '@/lib/output-ring-buffer'
import { useScriptStore } from '@/stores/useScriptStore'

describe('OutputRingBuffer', () => {
  test('append and toArray preserve order', () => {
    const buf = new OutputRingBuffer(8)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    expect(buf.toArray()).toEqual(['A', 'B', 'C'])
  })

  test('evicts oldest when char limit exceeded', () => {
    // Use a small buffer with low capacity to test char eviction
    const buf = new OutputRingBuffer(100) // high capacity so char limit is binding
    const bigChunk = 'x'.repeat(200_000)
    buf.append(bigChunk)
    buf.append(bigChunk)
    buf.append(bigChunk) // total = 600K, limit = 500K
    expect(buf.totalChars).toBeLessThanOrEqual(500_000)
    expect(buf.truncated).toBe(true)
    const arr = buf.toArray()
    // First entry should be the truncation marker
    expect(arr[0]).toMatch(/truncated/)
  })

  test('evicts oldest when capacity exceeded', () => {
    const buf = new OutputRingBuffer(4) // small capacity
    buf.append('A')
    buf.append('B')
    buf.append('C')
    buf.append('D')
    buf.append('E') // capacity exceeded, A evicted
    expect(buf.count).toBe(4)
    expect(buf.truncated).toBe(true)
    const arr = buf.toArray()
    // Truncation marker + B, C, D, E
    expect(arr).toContain('B')
    expect(arr).toContain('E')
    expect(arr).not.toContain('A')
  })

  test('wraps around correctly', () => {
    const buf = new OutputRingBuffer(4)
    buf.append('A')
    buf.append('B')
    buf.append('C')
    buf.append('D')
    buf.append('E') // wraps: head=1, tail=1, [E, B, C, D]
    buf.append('F') // wraps: head=2, tail=2, [E, F, C, D]
    const arr = buf.toArray()
    const dataEntries = arr.filter((s) => !s.startsWith('\x00'))
    expect(dataEntries).toEqual(['C', 'D', 'E', 'F'])
  })

  test('clear resets all state', () => {
    const buf = new OutputRingBuffer(4)
    buf.append('A')
    buf.append('B')
    buf.clear()
    expect(buf.count).toBe(0)
    expect(buf.totalChars).toBe(0)
    expect(buf.truncated).toBe(false)
    expect(buf.toArray()).toEqual([])
  })

  test('most recent entry is always preserved even if it alone exceeds limit', () => {
    const buf = new OutputRingBuffer(100)
    const hugeChunk = 'x'.repeat(600_000) // single chunk > limit
    buf.append(hugeChunk)
    expect(buf.count).toBe(1)
    const arr = buf.toArray()
    expect(arr).toContain(hugeChunk)
  })
})

describe('useScriptStore with ring buffer', () => {
  beforeEach(() => {
    useScriptStore.setState({ scriptStates: {} })
  })

  test('appendRunOutput increments version', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-1', 'hello')
    const v1 = store.scriptStates['wt-1'].runOutputVersion
    store.appendRunOutput('wt-1', 'world')
    const v2 = store.scriptStates['wt-1'].runOutputVersion
    expect(v2).toBe(v1 + 1)
  })

  test('getRunOutput returns ordered array', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-1', 'line 1')
    store.appendRunOutput('wt-1', 'line 2')
    const output = store.getRunOutput('wt-1')
    expect(output).toEqual(['line 1', 'line 2'])
  })

  test('clearRunOutput resets buffer and bumps version', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-1', 'data')
    store.clearRunOutput('wt-1')
    const output = store.getRunOutput('wt-1')
    expect(output).toEqual([])
  })

  test('special markers (CMD, ERR) are preserved in recent output', () => {
    const store = useScriptStore.getState()
    const bigChunk = 'x'.repeat(500_000)
    store.appendRunOutput('wt-1', bigChunk)
    store.appendRunOutput('wt-1', '\x00CMD:pnpm dev')
    store.appendRunOutput('wt-1', 'server started')
    const output = store.getRunOutput('wt-1')
    const lastTwo = output.slice(-2)
    expect(lastTwo[0]).toBe('\x00CMD:pnpm dev')
    expect(lastTwo[1]).toBe('server started')
  })
})
```

Replace the existing `appendRunOutput` implementation:

```typescript
appendRunOutput: (worktreeId, line) => {
  set((state) => {
    const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
    let newOutput = [...existing.runOutput, line]

    // Calculate total character count
    let totalChars = 0
    for (const chunk of newOutput) {
      totalChars += chunk.length
    }

    // Trim from the front if over limit
    if (totalChars > MAX_RUN_OUTPUT_CHARS) {
      let charsToRemove = totalChars - MAX_RUN_OUTPUT_CHARS
      let startIndex = 0

      // Skip the truncation marker if already present
      if (newOutput[0] === TRUNCATION_MARKER) {
        startIndex = 1
      }

      while (charsToRemove > 0 && startIndex < newOutput.length - 1) {
        charsToRemove -= newOutput[startIndex].length
        startIndex++
      }

      newOutput = [TRUNCATION_MARKER, ...newOutput.slice(startIndex)]
    }

    return {
      scriptStates: {
        ...state.scriptStates,
        [worktreeId]: {
          ...existing,
          runOutput: newOutput
        }
      }
    }
  })
}
```

#### 2. Add truncation marker rendering in `RunTab.tsx`

In `src/renderer/src/components/layout/RunTab.tsx`, add a rendering case for the `\x00TRUNC:` prefix in the `runOutput.map()` block. Place it BEFORE the existing `\x00CMD:` and `\x00ERR:` checks:

```tsx
{
  runOutput.map((line, i) => {
    if (line.startsWith('\x00TRUNC:')) {
      const msg = line.slice(7)
      return (
        <div
          key={i}
          className="text-muted-foreground text-center text-[10px] py-1 border-b border-border/50"
        >
          {msg}
        </div>
      )
    }
    // ... existing CMD and ERR checks ...
  })
}
```

### Key Files

- `src/renderer/src/stores/useScriptStore.ts` — add `MAX_RUN_OUTPUT_CHARS`, trimming logic in `appendRunOutput`
- `src/renderer/src/components/layout/RunTab.tsx` — render `\x00TRUNC:` marker

### Definition of Done

- [ ] `appendRunOutput` trims output from the front when total characters exceed 500,000
- [ ] A `[older output truncated]` marker appears as the first entry after trimming
- [ ] The truncation marker does not get duplicated on subsequent trims
- [ ] The most recent output is always preserved (trimming only removes old entries)
- [ ] The truncation marker renders as a centered, muted, small text line in the Run tab
- [ ] Output under 500K characters is unaffected (no trimming)
- [ ] `clearRunOutput` still works correctly (resets to empty array)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a dev server that produces continuous output (e.g., a watch mode build)
2. Let it run for several minutes
3. Verify the Run tab does not grow infinitely — scroll to the top and verify the truncation marker appears
4. Verify recent output is still visible and correctly rendered
5. Verify ANSI color codes still render correctly after trimming
6. Stop and restart the dev server — verify `clearRunOutput` resets everything

### Testing Criteria

```typescript
// test/phase-16/session-6/run-output-cap.test.ts
describe('Session 6: Run Output Cap', () => {
  test('output under limit is not trimmed', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-1', 'short line')
    const state = store.scriptStates['wt-1']
    expect(state.runOutput).toEqual(['short line'])
  })

  test('output over limit is trimmed from the front', () => {
    const store = useScriptStore.getState()
    // Append chunks that total > 500K chars
    const bigChunk = 'x'.repeat(100_000)
    for (let i = 0; i < 6; i++) {
      store.appendRunOutput('wt-1', bigChunk)
    }
    const state = store.scriptStates['wt-1']
    // Total should be <= 500K + truncation marker
    const totalChars = state.runOutput.reduce((sum, s) => sum + s.length, 0)
    expect(totalChars).toBeLessThanOrEqual(500_000 + 100) // small overhead for marker
    // First entry should be the truncation marker
    expect(state.runOutput[0]).toBe('\x00TRUNC:[older output truncated]')
  })

  test('truncation marker is not duplicated', () => {
    const store = useScriptStore.getState()
    const bigChunk = 'x'.repeat(100_000)
    // Append enough to trigger trimming twice
    for (let i = 0; i < 12; i++) {
      store.appendRunOutput('wt-1', bigChunk)
    }
    const state = store.scriptStates['wt-1']
    // Only one truncation marker at the start
    const markers = state.runOutput.filter((l) => l.startsWith('\x00TRUNC:'))
    expect(markers.length).toBe(1)
    expect(state.runOutput[0]).toBe('\x00TRUNC:[older output truncated]')
  })

  test('most recent entry is always preserved', () => {
    const store = useScriptStore.getState()
    const bigChunk = 'x'.repeat(500_001)
    store.appendRunOutput('wt-1', bigChunk) // fills entire limit
    store.appendRunOutput('wt-1', 'latest')
    const state = store.scriptStates['wt-1']
    expect(state.runOutput[state.runOutput.length - 1]).toBe('latest')
  })

  test('clearRunOutput resets to empty', () => {
    const store = useScriptStore.getState()
    store.appendRunOutput('wt-1', 'some output')
    store.clearRunOutput('wt-1')
    const state = store.scriptStates['wt-1']
    expect(state.runOutput).toEqual([])
  })

  test('special markers (CMD, ERR) are preserved in recent output', () => {
    const store = useScriptStore.getState()
    const bigChunk = 'x'.repeat(500_000)
    store.appendRunOutput('wt-1', bigChunk)
    store.appendRunOutput('wt-1', '\x00CMD:pnpm dev')
    store.appendRunOutput('wt-1', 'server started')
    const state = store.scriptStates['wt-1']
    const lastTwo = state.runOutput.slice(-2)
    expect(lastTwo[0]).toBe('\x00CMD:pnpm dev')
    expect(lastTwo[1]).toBe('server started')
  })
})
```

---

## Session 7: Integration & Verification

### Objectives

- Verify all Phase 16 features work together end-to-end
- Run full test suite and lint
- Test edge cases and cross-feature interactions

### Tasks

#### 1. Run full test suite

```bash
pnpm test
pnpm lint
```

Fix any failures.

#### 2. Verify undo/redo end-to-end

- Start a session, send a message, wait for response
- `/undo` — verify response removed, toast shown
- `/redo` — verify response restored, toast shown
- `/undo` when nothing to undo — verify error toast
- Verify `/undo` and `/redo` appear in popover with correct filtering
- Verify no user message is created for undo/redo

#### 3. Verify session idle fix end-to-end

- Start a session with multi-tool-call response
- Verify no premature idle transitions (no brief "Ready" flickers)
- Start background sessions and verify they show "Working" when busy
- Verify sessions genuinely complete after 300ms debounce
- Switch tabs during active streaming — verify status is correct on return

#### 4. Verify run output cap end-to-end

- Start a dev server that produces continuous output
- Let it run for several minutes
- Verify truncation occurs — scroll to top to see marker
- Verify recent output is readable and ANSI colors work
- Stop and restart — verify clean state

#### 5. Cross-feature interaction tests

- While a session is streaming (and debounce is active), try `/undo` — verify it handles gracefully
- Run a dev server while switching tabs — verify both run output and session status behave correctly
- Verify slash command popover shows both built-in and SDK commands correctly after SDK reconnection

### Key Files

- All files modified in Sessions 1-6

### Definition of Done

- [ ] `pnpm test` passes with zero failures
- [ ] `pnpm lint` passes with zero errors
- [ ] Undo/redo works end-to-end with correct toast messages
- [ ] Session idle bug is resolved — no premature idle transitions during multi-tool responses
- [ ] Run output is capped correctly — truncation marker appears after sustained output
- [ ] No regressions in existing Phase 15 features
- [ ] All edge cases tested (nothing to undo, rapid tab switching, etc.)

### How to Test

Run the full integration test:

```bash
pnpm test
```

Then manually test each feature as described in the individual session testing sections above.

### Testing Criteria

```typescript
// test/phase-16/session-7/integration-verification.test.ts
describe('Session 7: Phase 16 Integration', () => {
  test('built-in commands coexist with SDK commands in popover', () => {
    // Verify allCommands = [...BUILT_IN_COMMANDS, ...sdkCommands]
    // Verify filtering works for both types
  })

  test('/undo during idle session works correctly', () => {
    // Session is idle (not streaming)
    // Execute /undo
    // Verify it succeeds and messages are reloaded
  })

  test('debounced idle does not interfere with undo', () => {
    // Session finishes (debounced idle in progress)
    // User types /undo before debounce completes
    // Verify undo executes cleanly
  })

  test('run output cap does not affect other store operations', () => {
    // Append run output past the limit
    // Verify setup output is unaffected
    // Verify run PID tracking is unaffected
  })

  test('global listener busy + SessionView debounce work together', () => {
    // Background session goes idle → busy → idle
    // Active session goes idle → busy → idle
    // Verify both are handled correctly without race conditions
  })
})
```
