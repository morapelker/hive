# Hive -- Phase 16 Product Requirements Document

## Overview

Phase 16 addresses three targeted improvements: adding undo/redo commands that mirror OpenCode's native undo/redo functionality, fixing a bug where sessions randomly appear idle while still actively producing messages, and capping the Run tab output buffer to prevent unbounded memory growth. The undo/redo feature introduces two built-in slash commands (`/undo` and `/redo`) that bypass the SDK command endpoint and directly invoke OpenCode's undo/redo API. The session-idle bug requires investigation into how `session.status` events interact between the global listener and SessionView to find the root cause of premature idle transitions. The run output cap introduces a character limit that trims the oldest entries when exceeded.

### Phase 16 Goals

1. Add `/undo` and `/redo` as built-in commands that appear in the slash command popover and invoke OpenCode's native undo/redo mechanism (modeled after the opencode CLI client)
2. Investigate and fix sessions randomly transitioning to idle/finished state while still actively working and producing messages
3. Cap the Run tab output buffer to a sensible character limit, trimming the oldest entries to prevent unbounded growth

---

## Technical Additions

| Component            | Technology                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Undo/Redo commands   | Built-in slash commands in `SessionView.tsx`, new IPC handlers calling OpenCode SDK undo/redo API                              |
| Session idle bug fix | Investigation of `session.status` event handling in `useOpenCodeGlobalListener.ts` and `SessionView.tsx`, race condition fixes |
| Run output cap       | `OutputRingBuffer` class (O(1) append/evict), version-counter in `useScriptStore.ts`, character + capacity limits              |

---

## Features

### 1. Undo/Redo Commands

#### 1.1 Current State

Slash commands are fetched dynamically from the OpenCode SDK at session initialization via `window.opencodeOps.commands(path)` (`SessionView.tsx`, lines 1423-1435). These external commands are stored as React state:

```typescript
const [slashCommands, setSlashCommands] = useState<
  Array<{ name: string; description?: string; template: string; agent?: string }>
>([])
```

When the user types `/`, `showSlashCommands` is set to `true` (`SessionView.tsx`, lines 1983-1986), and the `SlashCommandPopover` renders above the input (`SessionView.tsx`, lines 2176-2182). The popover filters commands by substring match and supports keyboard navigation (up/down/enter/escape).

When a slash command is sent, `handleSend` (`SessionView.tsx`, lines 1746-1831) detects the `/` prefix, finds the matching command in `slashCommands`, optionally switches mode based on the command's `agent` field, and calls `window.opencodeOps.command()` to execute it through the SDK's command endpoint.

There is currently no concept of "built-in" commands that the app handles locally without going through the SDK command API. The `/undo` and `/redo` operations do not exist as commands. OpenCode's CLI client (reference implementation at `/Users/mor/Documents/dev/opencode`) implements undo/redo as first-class operations that interact with the session's message history, reverting the last assistant turn or re-applying a reverted turn.

#### 1.2 New Design

```
Built-in commands vs SDK commands:

  ┌─────────────────────────────────────────────────────────┐
  │ User types "/"                                           │
  │                                                          │
  │ SlashCommandPopover shows:                               │
  │   /undo        Undo the last assistant response  [built-in] │
  │   /redo        Redo the last undone response     [built-in] │
  │   /compact     Compact conversation history      [SDK]      │
  │   /plan        Switch to plan mode               [SDK]      │
  │   ...                                                    │
  └─────────────────────────────────────────────────────────┘

  Built-in commands (/undo, /redo):
  - Defined statically in the renderer, NOT fetched from SDK
  - Merged with SDK commands in the popover list
  - Built-in commands appear at the top of the list
  - When selected and sent, they DO NOT go through
    window.opencodeOps.command() — they call dedicated
    undo/redo IPC endpoints instead
  - They do NOT create a user message in the chat

  Undo behavior (modeled after opencode CLI):
  1. Call OpenCode SDK's undo API for the current session
  2. On success: reload messages from database, show toast
  3. On failure: show error toast

  Redo behavior:
  1. Call OpenCode SDK's redo API for the current session
  2. On success: reload messages from database, show toast
  3. On failure: show error toast (e.g. "Nothing to redo")
```

**Research reference:** The opencode CLI client at `/Users/mor/Documents/dev/opencode` contains the reference implementation for undo/redo. The implementing agent should study how it invokes the SDK's undo/redo endpoints, what parameters are required (session ID, directory), and what the expected response shape is. Key areas to explore in that codebase:

- How the CLI defines undo/redo commands
- What SDK client methods are called (likely `client.session.undo` / `client.session.redo` or similar)
- What happens to the message history after undo/redo
- Whether undo/redo triggers stream events that need handling

#### 1.3 Implementation

**A. Define built-in commands as a static array** (`SessionView.tsx` or a new utility):

```typescript
const BUILT_IN_COMMANDS: Array<{
  name: string
  description: string
  template: string
  builtIn: true
}> = [
  {
    name: 'undo',
    description: 'Undo the last assistant response',
    template: '/undo',
    builtIn: true
  },
  {
    name: 'redo',
    description: 'Redo the last undone response',
    template: '/redo',
    builtIn: true
  }
]
```

**B. Merge built-in commands with SDK commands in the popover.** Update the `commands` prop passed to `SlashCommandPopover`:

```typescript
const allCommands = useMemo(
  () => [...BUILT_IN_COMMANDS, ...slashCommands],
  [slashCommands]
)

<SlashCommandPopover
  commands={allCommands}
  filter={inputValue}
  onSelect={handleCommandSelect}
  onClose={handleSlashClose}
  visible={showSlashCommands}
/>
```

**C. Update `SlashCommandPopover.tsx`** to visually distinguish built-in commands (optional — a subtle badge or different styling to indicate these are built-in rather than SDK commands).

**D. Route built-in commands differently in `handleSend`.** Before the existing SDK command matching logic, check for built-in commands:

```typescript
if (trimmedValue.startsWith('/')) {
  const spaceIndex = trimmedValue.indexOf(' ')
  const commandName = spaceIndex > 0 ? trimmedValue.slice(1, spaceIndex) : trimmedValue.slice(1)

  // Handle built-in commands FIRST
  if (commandName === 'undo') {
    setInputValue('')
    setShowSlashCommands(false)
    try {
      const result = await window.opencodeOps.undo(worktreePath, opencodeSessionId)
      if (result.success) {
        await loadMessagesFromDatabase()
        toast.success('Undone')
      } else {
        toast.error(result.error || 'Nothing to undo')
      }
    } catch (error) {
      toast.error('Undo failed')
    }
    return
  }

  if (commandName === 'redo') {
    setInputValue('')
    setShowSlashCommands(false)
    try {
      const result = await window.opencodeOps.redo(worktreePath, opencodeSessionId)
      if (result.success) {
        await loadMessagesFromDatabase()
        toast.success('Redone')
      } else {
        toast.error(result.error || 'Nothing to redo')
      }
    } catch (error) {
      toast.error('Redo failed')
    }
    return
  }

  // ... existing SDK command matching logic below ...
}
```

Note: Built-in commands do NOT save a user message to the database or display one in the chat. They clear the input and execute immediately. This differs from SDK commands which create a visible user message.

**E. Add undo/redo IPC endpoints.** These need to be researched from the opencode reference client to determine the exact SDK API shape.

Main process handler (`opencode-handlers.ts`):

```typescript
ipcMain.handle('opencode:undo', async (_event, { worktreePath, sessionId }) => {
  try {
    // Call the OpenCode SDK's undo method
    // Exact API to be determined from reference client research
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

Service layer (`opencode-service.ts`):

```typescript
async undo(worktreePath: string, sessionId: string): Promise<{ success: boolean }> {
  const instance = await this.getOrCreateInstance()
  // Exact SDK method to be determined from reference client research
  // Likely: instance.client.session.undo({ path: { id: sessionId }, query: { directory: worktreePath } })
  await instance.client.session.undo(/* ... */)
  return { success: true }
}

async redo(worktreePath: string, sessionId: string): Promise<{ success: boolean }> {
  const instance = await this.getOrCreateInstance()
  await instance.client.session.redo(/* ... */)
  return { success: true }
}
```

Preload bridge (`preload/index.ts`):

```typescript
undo: (worktreePath: string, sessionId: string) =>
  ipcRenderer.invoke('opencode:undo', { worktreePath, sessionId }),
redo: (worktreePath: string, sessionId: string) =>
  ipcRenderer.invoke('opencode:redo', { worktreePath, sessionId })
```

Type declarations (`preload/index.d.ts`):

```typescript
// In opencodeOps interface:
undo(worktreePath: string, sessionId: string): Promise<{ success: boolean; error?: string }>
redo(worktreePath: string, sessionId: string): Promise<{ success: boolean; error?: string }>
```

#### 1.4 Files to Modify

| File                                                           | Change                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx`         | Define `BUILT_IN_COMMANDS`, merge with SDK commands, route `/undo` and `/redo` in `handleSend` |
| `src/renderer/src/components/sessions/SlashCommandPopover.tsx` | (Optional) Visual distinction for built-in commands                                            |
| `src/main/ipc/opencode-handlers.ts`                            | Add `opencode:undo` and `opencode:redo` IPC handlers                                           |
| `src/main/services/opencode-service.ts`                        | Add `undo()` and `redo()` methods calling the OpenCode SDK                                     |
| `src/preload/index.ts`                                         | Expose `undo` and `redo` in `opencodeOps` namespace                                            |
| `src/preload/index.d.ts`                                       | Add type declarations for `undo` and `redo`                                                    |

#### 1.5 Research Required

Before implementation, the agent must study the opencode CLI client at `/Users/mor/Documents/dev/opencode` to understand:

1. The exact SDK client API for undo/redo (method names, parameters, return types)
2. Whether undo/redo triggers any stream events that need to be handled (e.g., `session.status`, `message.updated`)
3. How the message history changes after undo/redo (are messages deleted, marked, or reorganized?)
4. Whether there are any preconditions for undo/redo (e.g., can only undo when idle, can only undo the most recent turn)
5. How the CLI handles undo/redo errors (nothing to undo, session busy, etc.)

---

### 2. Sessions Randomly Transitioning to Idle

#### 2.1 Current State

Session status is tracked through two parallel systems:

**System A — SessionView (active session):** The `isStreaming` local state in `SessionView.tsx` (line 368) controls the streaming UI (cursor, stop button, message queueing). It is set to `true` when any content event arrives and set to `false` only via `resetStreamingState()` during finalization.

**System B — useWorktreeStatusStore (all sessions):** The `sessionStatuses` record in `useWorktreeStatusStore.ts` tracks `'working' | 'planning' | 'answering' | 'unread'` per session. This drives the sidebar status text and icons.

**The bug:** Sessions randomly appear to "finish" (status clears, streaming stops, sidebar shows "Ready") while the session is still actively working and producing messages. This manifests as:

- The sidebar worktree row drops from "Working" to "Ready"
- The streaming cursor disappears
- The stop button disappears
- New messages from the still-running session continue to arrive and are displayed, but the UI no longer shows streaming state

**Suspected causes:**

There are several identified gaps in the status event handling that could cause premature idle transitions:

**Gap 1 — `session.idle` handler does not update worktree status:** The `session.idle` event handler in `SessionView.tsx` (lines 1235-1263) calls `finalizeResponseFromDatabase()` which calls `resetStreamingState()` (setting `isStreaming = false`), but does NOT update the worktree status store. Only the `session.status idle` handler (lines 1285-1292) clears/sets the worktree status. However, if `session.idle` fires and triggers finalization first (sets `hasFinalizedCurrentResponseRef = true`), then `session.status idle` arrives and the finalization guard prevents a second finalization — but the worktree status IS still updated at lines 1285-1292 (the status update is outside the finalization guard). So this alone shouldn't cause the bug, but the double-finalization pattern is fragile.

**Gap 2 — Child session idle events misrouted:** The `session.idle` handler at line 1240 checks `if (event.childSessionId)` to distinguish child session completion from parent session completion. If a subtask/child session completes, only the subtask card status should update — the parent should keep streaming. However, if the child session ID check fails (e.g., `childSessionId` is undefined for a child session due to an SDK inconsistency), the handler falls through to the parent finalization path, prematurely idling the parent.

**Gap 3 — `session.status idle` during active streaming:** If the SDK sends a `session.status idle` event for a momentary pause between tool calls or between planning and execution phases, the handler at line 1274 unconditionally finalizes. There is no check for whether the session is about to become busy again. The `session.status busy` event at line 1271 sets `isStreaming = true` and `newPromptPendingRef.current = false`, but if the `idle` arrives first or the `busy` event is delayed, the session appears to finish prematurely.

**Gap 4 — Global listener and SessionView event overlap:** The global listener (`useOpenCodeGlobalListener.ts`, line 100) skips events where `sessionId === activeId`. SessionView (line 879) skips events where `event.sessionId !== sessionId`. During tab switches, there is a brief window where neither handler processes the event. If a `session.status busy` event is lost during this window but the preceding `session.status idle` was processed, the session stays idle.

**Gap 5 — No busy-state tracking for background sessions:** The global listener only handles `session.status idle` (line 97: `if (status?.type !== 'idle') return`). It does NOT handle `session.status busy`. When a background session transitions from idle to busy (e.g., processing queued messages or continuing multi-step work), the global listener ignores the busy event. The worktree status store retains `'unread'` from the previous idle instead of transitioning back to `'working'`. If the user then views the session, `initializeSession` in SessionView may not correctly restore the working state.

#### 2.2 New Design

```
Investigation and fix strategy:

  Step 1: Add diagnostic logging to pinpoint which event
  causes the premature idle transition.

  ┌─────────────────────────────────────────────────────────┐
  │ SessionView event handler                                │
  │                                                          │
  │  session.status idle → LOG with stack + timestamp        │
  │  session.idle        → LOG with childSessionId           │
  │  session.status busy → LOG with current isStreaming      │
  │                                                          │
  │  resetStreamingState → LOG caller trace                  │
  └─────────────────────────────────────────────────────────┘

  Step 2: Apply targeted fixes for identified gaps:

  Fix A — Guard finalization against rapid idle→busy→idle:
    When session.status idle arrives, do NOT finalize immediately.
    Instead, set a short debounce (200-300ms). If session.status
    busy arrives within that window, cancel the finalization.

    This handles the case where the SDK sends idle between
    tool calls or between planning/execution phases.

  Fix B — Handle busy events in global listener:
    When session.status busy arrives for a background session,
    set the worktree status to 'working' or 'planning'.
    Currently the global listener ignores all non-idle statuses.

  Fix C — Validate child session idle routing:
    Add explicit checks for child session events. If a
    session.idle event arrives without childSessionId but the
    session is actively streaming (isStreaming === true), log a
    warning and skip finalization — it may be a child event
    missing its childSessionId field.

  Fix D — Re-check session status on SessionView mount:
    When switching back to a session, query the current SDK
    session status. If it reports 'busy', restore isStreaming
    even if the worktree status store says otherwise.
```

#### 2.3 Implementation

**A. Handle `session.status busy` in the global listener** (`useOpenCodeGlobalListener.ts`):

Currently the global listener (line 97) has: `if (status?.type !== 'idle') return` — this ignores ALL non-idle statuses for background sessions.

Change to handle busy events:

```typescript
// Instead of:
//   if (status?.type !== 'idle') return

if (status?.type === 'busy') {
  // Background session became busy — update worktree status
  if (sessionId !== activeId) {
    // Determine mode from session store
    const currentMode = useSessionStore.getState().getSessionMode(sessionId)
    useWorktreeStatusStore
      .getState()
      .setSessionStatus(sessionId, currentMode === 'plan' ? 'planning' : 'working')
  }
  return
}

if (status?.type !== 'idle') return
// ... existing idle handling below
```

**B. Add debounced finalization in SessionView** to handle rapid idle→busy transitions:

```typescript
const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

// In session.status handler:
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
  // Debounce finalization — wait for potential immediate busy transition
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
  }, 300) // 300ms debounce
  return
}
```

Clean up the timer on unmount:

```typescript
return () => {
  unsubscribe()
  if (idleTimerRef.current) {
    clearTimeout(idleTimerRef.current)
    idleTimerRef.current = null
  }
}
```

**C. Guard `session.idle` fallback more defensively:**

```typescript
} else if (event.type === 'session.idle') {
  // Child session idle — update subtask, don't touch parent
  if (event.childSessionId) {
    // ... existing child handling ...
    return
  }

  // Parent session.idle without childSessionId.
  // Only finalize if we are not in the middle of active streaming
  // (safety valve: if isStreaming is true and we haven't explicitly
  // received a session.status idle, this may be a spurious event)
  if (isStreaming && !hasFinalizedCurrentResponseRef.current) {
    console.warn(
      `[SessionView] session.idle received while still streaming (sessionId=${sessionId}). ` +
      'Deferring to session.status for finalization.'
    )
    return
  }

  // ... existing fallback finalization ...
}
```

**D. Add diagnostic logging** (temporary, to help diagnose in production):

```typescript
// In session.status handler:
console.debug(`[SessionView] session.status`, {
  type: status.type,
  sessionId,
  isStreaming,
  hasFinalizedCurrentResponseRef: hasFinalizedCurrentResponseRef.current,
  isSending
})
```

#### 2.4 Files to Modify

| File                                                   | Change                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Debounce `session.status idle` finalization, guard `session.idle` fallback defensively |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`  | Handle `session.status busy` for background sessions (set 'working'/'planning' status) |

---

### 3. Limit Run Tab Output History

#### 3.1 Current State

The Run tab output is stored as a `string[]` array in `useScriptStore.ts`, keyed by worktree ID:

```typescript
interface ScriptState {
  runOutput: string[] // array of raw process output chunks
  // ...
}
```

The `appendRunOutput` action (`useScriptStore.ts`, lines 96-109) pushes each new chunk to the array via spread:

```typescript
appendRunOutput: (worktreeId, line) => {
  set((state) => {
    const existing = state.scriptStates[worktreeId] || createDefaultScriptState()
    return {
      scriptStates: {
        ...state.scriptStates,
        [worktreeId]: {
          ...existing,
          runOutput: [...existing.runOutput, line]
        }
      }
    }
  })
}
```

Each entry in the array is a raw `Buffer.toString()` chunk from the process's stdout/stderr — not split by newlines, not size-limited. The array grows unboundedly for long-running processes (dev servers, watch mode builds, etc.).

The store is not persisted (no `persist` middleware), so it resets on app reload. But during a session, a dev server can easily produce tens of thousands of chunks over hours, consuming significant memory and causing rendering slowdowns as `RunTab.tsx` maps over the entire array on every update.

`RunTab.tsx` (lines 171-193) renders each chunk as a `<div>` with `<Ansi>` parsing. No virtualization is used — all entries are in the DOM.

#### 3.2 New Design

```
Ring buffer output cap:

  MAX_RUN_OUTPUT_CHARS = 500,000  (500KB of text)
  BUFFER_CAPACITY = 50,000 entries

  Why 500K characters:
  - A typical terminal line is ~80-120 characters
  - 500K ≈ 4,000-6,000 lines of output
  - More than enough to diagnose issues and see recent output
  - Well within reasonable memory bounds
  - Most dev server output is repetitive (hot reload, request logs)
    so older entries have diminishing value

  Why a ring buffer (not array trimming):
  - O(1) append — write at head position, no array copying
  - O(1) eviction — advance tail pointer, no shifting
  - No GC pressure — backing array is pre-allocated and reused
  - O(n) read only when React renders (toArray snapshot)
  - Current approach copies entire array on EVERY append:
    [...existing.runOutput, line] = O(n) per chunk

  Structure:
  ┌───┬───┬───┬───┬───┬───┬───┬───┐
  │ D │ E │   │   │   │ A │ B │ C │  ← circular array
  └───┴───┴───┴───┴───┴───┴───┴───┘
        head=2       tail=5

  toArray() reads: [A, B, C, D, E]  (tail → head, wrapping)

  Eviction triggers:
  - Total characters > MAX_RUN_OUTPUT_CHARS
  - Entry count > BUFFER_CAPACITY
  Whichever is hit first. Oldest entries are evicted.

  Architecture:
  - Ring buffer lives OUTSIDE Zustand (module-level mutable object)
  - Zustand stores only a version counter per worktree
  - Version bump triggers React re-render
  - RunTab calls buffer.toArray() during render via useMemo

  ┌─────────────────────────────────────────────────────┐
  │ appendRunOutput(worktreeId, chunk)                   │
  │   1. buffer.append(chunk)     ← O(1) mutation       │
  │   2. set({ runOutputVersion++ })  ← trigger render  │
  └─────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────┐
  │ RunTab render                                        │
  │   const version = useScriptStore(s => s...version)  │
  │   const output = useMemo(                            │
  │     () => buffer.toArray(),   ← O(n) snapshot       │
  │     [version]                                        │
  │   )                                                  │
  └─────────────────────────────────────────────────────┘
```

#### 3.3 Implementation

**A. Create `OutputRingBuffer` class** in a new file `src/renderer/src/lib/output-ring-buffer.ts`:

A class with `append(chunk)`, `toArray()`, and `clear()` methods. Pre-allocates a fixed-size array of 50,000 slots. Tracks `head`, `tail`, `count`, `totalChars`, and `truncated` state. Evicts from the tail when character or capacity limits are exceeded. Includes a module-level registry (`Map<worktreeId, OutputRingBuffer>`) with `getOrCreateBuffer()` and `deleteBuffer()` helpers.

**B. Update `useScriptStore.ts`** — replace `runOutput: string[]` with `runOutputVersion: number`:

The `appendRunOutput` action calls `buffer.append(chunk)` (O(1)) then bumps `runOutputVersion` to trigger re-renders. The `clearRunOutput` action calls `buffer.clear()` then bumps version. A new `getRunOutput(worktreeId)` getter calls `buffer.toArray()` for consumers that need the array.

**C. Update `RunTab.tsx`** — read from ring buffer via version-driven `useMemo`:

Subscribe to `runOutputVersion` instead of `runOutput`. Produce the `string[]` via `useMemo(() => buffer.toArray(), [worktreeId, version])`. Add rendering case for the `\x00TRUNC:` truncation marker before existing `\x00CMD:` and `\x00ERR:` checks.

**D. Update `BottomPanel.tsx`** — URL detection for "Open in Chrome" uses `getRunOutput()` instead of `scriptState.runOutput`.

#### 3.4 Files to Modify

| File                                                 | Change                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/renderer/src/lib/output-ring-buffer.ts`         | **New file**: `OutputRingBuffer` class, module-level registry                     |
| `src/renderer/src/stores/useScriptStore.ts`          | Replace `runOutput: string[]` with `runOutputVersion: number`, use ring buffer    |
| `src/renderer/src/components/layout/RunTab.tsx`      | Read from ring buffer via version selector, render `\x00TRUNC:` truncation marker |
| `src/renderer/src/components/layout/BottomPanel.tsx` | Update URL detection to use `getRunOutput()`                                      |

---

## Summary of All Files to Modify

| Feature          | File                                                           | Change                                               |
| ---------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| Undo/Redo        | `src/renderer/src/components/sessions/SessionView.tsx`         | Built-in commands, routing in handleSend             |
| Undo/Redo        | `src/renderer/src/components/sessions/SlashCommandPopover.tsx` | Optional visual distinction for built-in commands    |
| Undo/Redo        | `src/main/ipc/opencode-handlers.ts`                            | undo/redo IPC handlers                               |
| Undo/Redo        | `src/main/services/opencode-service.ts`                        | undo/redo SDK methods                                |
| Undo/Redo        | `src/preload/index.ts`                                         | Expose undo/redo in opencodeOps                      |
| Undo/Redo        | `src/preload/index.d.ts`                                       | Type declarations for undo/redo                      |
| Session Idle Bug | `src/renderer/src/components/sessions/SessionView.tsx`         | Debounced finalization, defensive session.idle guard |
| Session Idle Bug | `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`          | Handle session.status busy for background sessions   |
| Run Output Cap   | `src/renderer/src/lib/output-ring-buffer.ts`                   | New: OutputRingBuffer class, module-level registry   |
| Run Output Cap   | `src/renderer/src/stores/useScriptStore.ts`                    | Replace runOutput with runOutputVersion, ring buffer |
| Run Output Cap   | `src/renderer/src/components/layout/RunTab.tsx`                | Version-driven selector, render truncation marker    |
| Run Output Cap   | `src/renderer/src/components/layout/BottomPanel.tsx`           | Update URL detection to use getRunOutput()           |
