# Hive Phase 9 Implementation Plan

This document outlines the implementation plan for Hive Phase 9, focusing on platform polish (Cmd+W override, PATH fix), session control (abort streaming, input persistence), UX affordances (copy on hover, file search), file tree completeness (hidden files), and streaming correctness (subagent routing, subtool loading).

---

## Overview

The implementation is divided into **12 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 9 builds upon Phase 8** — all Phase 8 infrastructure is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 9)

```
test/
├── phase-9/
│   ├── session-1/
│   │   └── path-fix.test.ts
│   ├── session-2/
│   │   └── hidden-files.test.ts
│   ├── session-3/
│   │   └── cmd-w-override.test.ts
│   ├── session-4/
│   │   └── abort-streaming.test.ts
│   ├── session-5/
│   │   └── subagent-tagging.test.ts
│   ├── session-6/
│   │   └── subagent-renderer.test.ts
│   ├── session-7/
│   │   └── subtool-loading.test.ts
│   ├── session-8/
│   │   └── copy-on-hover.test.ts
│   ├── session-9/
│   │   └── input-persistence.test.ts
│   ├── session-10/
│   │   └── file-search-store.test.ts
│   ├── session-11/
│   │   └── file-search-dialog.test.ts
│   └── session-12/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
pnpm add fix-path
```

All other features use existing packages: React, Zustand, Electron, lucide-react, cmdk, better-sqlite3, sonner.

---

## Session 1: PATH Variable Inheritance

### Objectives

- Install `fix-path` to inherit the user's full shell PATH when Electron is launched from Finder/Dock/Spotlight
- Call it at app startup before any child process spawning

### Tasks

#### 1. Install `fix-path`

```bash
pnpm add fix-path
```

#### 2. Call `fixPath()` at app startup

In `src/main/index.ts`, add the import at the top of the file:

```typescript
import fixPath from 'fix-path'
```

Then call it as the very first thing inside `app.whenReady()`, before database init or IPC registration (before line 217):

```typescript
app.whenReady().then(() => {
  // Fix PATH for macOS when launched from Finder/Dock/Spotlight.
  // Must run before any child process spawning (opencode, scripts).
  fixPath()

  log.info('App starting', { version: app.getVersion(), platform: process.platform })
  // ... rest of existing initialization
})
```

#### 3. Verify the spawn calls inherit patched env

Confirm that `opencode-service.ts` line 72 (`env: { ...process.env }`) and `script-runner.ts` (lines 30–34, 180, 220, 295) spread `process.env` — they will automatically pick up the patched PATH. No changes needed in these files.

### Key Files

- `package.json` — add `fix-path` dependency
- `src/main/index.ts` — import and call `fixPath()`

### Definition of Done

- [ ] `fix-path` is listed in `package.json` dependencies
- [ ] `fixPath()` is called at the top of `app.whenReady()` before any service initialization
- [ ] When launched from Finder, `process.env.PATH` includes Homebrew (`/opt/homebrew/bin`) and other user paths
- [ ] `opencode serve` starts successfully when app is launched from Dock
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Build the app: `pnpm build && pnpm build:mac`
2. Launch the built app from Finder (not from terminal)
3. Select a worktree and open/create a session
4. Verify the session connects to OpenCode (no "opencode not found" error)
5. Run a script via the script runner — verify it can access Homebrew/nvm binaries

---

## Session 2: Hidden Files in File Tree

### Objectives

- Remove the blanket dotfile filter so hidden files like `.env`, `.gitignore`, `.vscode/` appear in the file tree
- Keep `.git` and `.DS_Store` excluded via the existing `IGNORE_DIRS` and `IGNORE_FILES` sets

### Tasks

#### 1. Remove dotfile filter in `scanDirectory()`

In `src/main/ipc/file-tree-handlers.ts`, remove lines 95–98:

```typescript
// REMOVE these lines:
// Skip hidden files/folders (starting with .) except important ones
if (entry.name.startsWith('.') && ![''].includes(entry.name)) {
  continue
}
```

The existing guards on lines 88–93 already handle `.git` (in `IGNORE_DIRS`) and `.DS_Store` (in `IGNORE_FILES`).

#### 2. Remove dotfile filter in `scanSingleDirectory()`

In the same file, remove lines 155–157:

```typescript
// REMOVE these lines:
if (entry.name.startsWith('.')) {
  continue
}
```

### Key Files

- `src/main/ipc/file-tree-handlers.ts` — remove two `continue` blocks

### Definition of Done

- [ ] `scanDirectory()` no longer skips entries starting with `.`
- [ ] `scanSingleDirectory()` no longer skips entries starting with `.`
- [ ] `.git/` remains hidden (excluded by `IGNORE_DIRS`)
- [ ] `.DS_Store` remains hidden (excluded by `IGNORE_FILES`)
- [ ] `.env`, `.gitignore`, `.prettierrc`, `.eslintrc`, `.github/`, `.vscode/` appear in the file tree
- [ ] File tree sort order is correct (directories first, then files, alphabetically)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start the app, select a worktree that contains dotfiles (`.env`, `.gitignore`, etc.)
2. Open the file tree sidebar
3. Verify dotfiles and dot-directories are visible
4. Verify `.git/` is NOT shown
5. Verify `.DS_Store` is NOT shown
6. Expand a dot-directory (e.g., `.github/`) — verify its children load correctly
7. Click a dotfile (e.g., `.env`) — verify it opens in the file preview

### Testing Criteria

```typescript
// test/phase-9/session-2/hidden-files.test.ts
describe('Session 2: Hidden Files', () => {
  test('scanDirectory includes dotfiles', async () => {
    // Create a temp directory with .env, .gitignore, .vscode/, .git/, .DS_Store
    // Call scanDirectory
    // Verify .env and .gitignore are in results
    // Verify .vscode/ is in results
    // Verify .git/ is NOT in results (IGNORE_DIRS)
    // Verify .DS_Store is NOT in results (IGNORE_FILES)
  })

  test('scanSingleDirectory includes dotfiles', async () => {
    // Same as above but for scanSingleDirectory
  })

  test('dotfiles are sorted correctly', async () => {
    // Verify directories come first, then files
    // Verify alphabetical within each group
  })
})
```

---

## Session 3: Cmd+W Session Close Override

### Objectives

- Intercept Cmd+W at the Electron main process level to prevent window closure
- Forward it to the renderer to close the active session tab (or no-op)
- Replace `{ role: 'fileMenu' }` with a custom File menu that omits the native Close Window accelerator

### Tasks

#### 1. Add Cmd+W to `before-input-event` in main process

In `src/main/index.ts`, extend the existing `before-input-event` handler (lines 125–136) to also intercept Cmd+W:

```typescript
mainWindow.webContents.on('before-input-event', (event, input) => {
  // Existing Cmd+T interception (lines 126-135)...

  // Intercept Cmd+W — never close the window
  if (
    input.key.toLowerCase() === 'w' &&
    (input.meta || input.control) &&
    !input.alt &&
    !input.shift &&
    input.type === 'keyDown'
  ) {
    event.preventDefault()
    mainWindow!.webContents.send('shortcut:close-session')
  }
})
```

#### 2. Replace `{ role: 'fileMenu' }` with custom File menu

In `src/main/index.ts` (line 249), replace:

```typescript
// BEFORE:
{ role: 'fileMenu' },

// AFTER:
{
  label: 'File',
  submenu: [
    {
      label: 'New Session',
      accelerator: 'CmdOrCtrl+T',
      click: () => { mainWindow?.webContents.send('shortcut:new-session') }
    },
    {
      label: 'Close Tab',
      accelerator: 'CmdOrCtrl+W',
      click: () => { mainWindow?.webContents.send('shortcut:close-session') }
    },
    { type: 'separator' },
    { role: 'quit' }
  ]
},
```

#### 3. Expose IPC listener in preload

In `src/preload/index.ts`, add to the `systemOps` namespace:

```typescript
onCloseSessionShortcut: (callback: () => void) => {
  const handler = (): void => {
    callback()
  }
  ipcRenderer.on('shortcut:close-session', handler)
  return () => {
    ipcRenderer.removeListener('shortcut:close-session', handler)
  }
}
```

#### 4. Add type declaration

In `src/preload/index.d.ts`, add to the `systemOps` interface:

```typescript
onCloseSessionShortcut: (callback: () => void) => () => void
```

#### 5. Register IPC listener in renderer

In `src/renderer/src/hooks/useKeyboardShortcuts.ts`, add a `useEffect` to listen for the main-process Cmd+W forwarding:

```typescript
useEffect(() => {
  if (!window.systemOps?.onCloseSessionShortcut) return

  const cleanup = window.systemOps.onCloseSessionShortcut(() => {
    const { activeSessionId } = useSessionStore.getState()
    if (!activeSessionId) return // no-op if no session open
    useSessionStore
      .getState()
      .closeSession(activeSessionId)
      .then((result) => {
        if (result.success) {
          toast.success('Session closed')
        } else {
          toast.error(result.error || 'Failed to close session')
        }
      })
  })

  return cleanup
}, [])
```

#### 6. Change `session:close` to `allowInInput: true`

In `useKeyboardShortcuts.ts` (line 133), change:

```typescript
// BEFORE:
allowInInput: false,

// AFTER:
allowInInput: true,
```

### Key Files

- `src/main/index.ts` — `before-input-event` handler, custom File menu
- `src/preload/index.ts` — `onCloseSessionShortcut`
- `src/preload/index.d.ts` — type declaration
- `src/renderer/src/hooks/useKeyboardShortcuts.ts` — IPC listener, `allowInInput`

### Definition of Done

- [ ] Cmd+W never closes the Electron window
- [ ] Cmd+W closes the active session tab if one is open
- [ ] Cmd+W is a silent no-op when no session is open (no toast, no error)
- [ ] Cmd+W works when the textarea is focused
- [ ] The File menu shows "Close Tab" with Cmd+W accelerator, not "Close Window"
- [ ] Cmd+Q still quits the app
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start the app with a session open
2. Press Cmd+W — verify the session tab closes, NOT the window
3. With no sessions open, press Cmd+W — verify nothing happens (no-op)
4. Focus the textarea, press Cmd+W — verify it still closes the session
5. Press Cmd+Q — verify the app quits normally
6. Check the File menu — verify "Close Tab" (Cmd+W) is listed, not "Close Window"

### Testing Criteria

```typescript
// test/phase-9/session-3/cmd-w-override.test.ts
describe('Session 3: Cmd+W Override', () => {
  test('Cmd+W keyDown sends close-session IPC', () => {
    // Simulate before-input-event with meta=true, key='w', type='keyDown'
    // Verify event.preventDefault called
    // Verify webContents.send called with 'shortcut:close-session'
  })

  test('Cmd+W keyUp does NOT trigger', () => {
    // type='keyUp'
    // Verify NOT intercepted
  })

  test('renderer closes active session on IPC', () => {
    // Mock activeSessionId = 'abc'
    // Trigger the IPC callback
    // Verify closeSession('abc') called
  })

  test('renderer no-ops when no active session', () => {
    // Mock activeSessionId = null
    // Trigger the IPC callback
    // Verify closeSession NOT called, no toast
  })
})
```

---

## Session 4: Stop Streaming (Abort)

### Objectives

- Wire up the OpenCode SDK's `session.abort()` through the full IPC chain
- Replace the send button with a stop button when streaming with empty input
- Handle `MessageAbortedError` gracefully

### Tasks

#### 1. Add `abort()` method to `OpenCodeService`

In `src/main/services/opencode-service.ts`, add a public method:

```typescript
async abort(worktreePath: string, opencodeSessionId: string): Promise<boolean> {
  const instance = this.instances.get(worktreePath)
  if (!instance?.client) {
    throw new Error('No OpenCode instance for worktree')
  }

  const result = await instance.client.session.abort({
    path: { id: opencodeSessionId },
    query: { directory: worktreePath }
  })

  return result.data === true
}
```

#### 2. Add IPC handler

In `src/main/ipc/opencode-handlers.ts`, add before the closing `log.info`:

```typescript
ipcMain.handle(
  'opencode:abort',
  async (_event, worktreePath: string, opencodeSessionId: string) => {
    log.info('IPC: opencode:abort', { worktreePath, opencodeSessionId })
    try {
      const result = await openCodeService.abort(worktreePath, opencodeSessionId)
      return { success: result }
    } catch (error) {
      log.error('IPC: opencode:abort failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
)
```

#### 3. Expose in preload

In `src/preload/index.ts`, add to the `opencodeOps` namespace:

```typescript
abort: (worktreePath: string, opencodeSessionId: string) =>
  ipcRenderer.invoke('opencode:abort', worktreePath, opencodeSessionId)
```

#### 4. Add type declaration

In `src/preload/index.d.ts`, add to `opencodeOps`:

```typescript
// Abort a streaming session
abort: (worktreePath: string, opencodeSessionId: string) =>
  Promise<{ success: boolean; error?: string }>
```

#### 5. Add stop button UI

In `src/renderer/src/components/sessions/SessionView.tsx`, add `Square` to the lucide-react imports. Add a `handleAbort` callback:

```typescript
const handleAbort = useCallback(async () => {
  if (!worktreePath || !opencodeSessionId) return
  await window.opencodeOps.abort(worktreePath, opencodeSessionId)
}, [worktreePath, opencodeSessionId])
```

Replace the send button JSX (lines 1618–1632) with conditional rendering:

```typescript
{isStreaming && !inputValue.trim() ? (
  <Button
    onClick={handleAbort}
    size="sm"
    variant="destructive"
    className="h-7 w-7 p-0"
    aria-label="Stop streaming"
    title="Stop streaming"
    data-testid="stop-button"
  >
    <Square className="h-3 w-3" />
  </Button>
) : (
  <Button
    onClick={handleSend}
    disabled={!inputValue.trim()}
    size="sm"
    className="h-7 w-7 p-0"
    aria-label={isStreaming ? 'Queue message' : 'Send message'}
    title={isStreaming ? 'Queue message' : 'Send message'}
    data-testid="send-button"
  >
    {isStreaming ? (
      <ListPlus className="h-3.5 w-3.5" />
    ) : (
      <Send className="h-3.5 w-3.5" />
    )}
  </Button>
)}
```

#### 6. Handle `MessageAbortedError` in stream handler

In the stream handler, when processing events after an abort, the SDK may send an error event with `name: "MessageAbortedError"`. In the existing error handling, suppress toasts for this error type. The `session.idle` event that follows will finalize normally, preserving the partial response.

### Key Files

- `src/main/services/opencode-service.ts` — `abort()` method
- `src/main/ipc/opencode-handlers.ts` — `opencode:abort` handler
- `src/preload/index.ts` — `abort` method
- `src/preload/index.d.ts` — type declaration
- `src/renderer/src/components/sessions/SessionView.tsx` — stop button, `handleAbort`

### Definition of Done

- [ ] `OpenCodeService.abort()` calls `client.session.abort()` with correct params
- [ ] `opencode:abort` IPC handler registered and returns `{ success: boolean }`
- [ ] Preload exposes `window.opencodeOps.abort()`
- [ ] When streaming and input is empty: stop button (red square icon) shown instead of send
- [ ] When streaming and input has text: queue button (ListPlus) shown (existing behavior)
- [ ] When not streaming: send button shown (existing behavior)
- [ ] Clicking stop calls abort and streaming halts
- [ ] Partial response is preserved after abort
- [ ] No error toast on abort (user-initiated)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a message to trigger a long response
2. While streaming, with input field empty, verify the button shows a red square (stop icon)
3. Click the stop button — verify streaming stops, partial response remains visible
4. Type text while streaming — verify the button changes to queue icon (ListPlus)
5. Clear the text — verify it changes back to stop
6. After abort, send a new message — verify normal behavior resumes

### Testing Criteria

```typescript
// test/phase-9/session-4/abort-streaming.test.ts
describe('Session 4: Abort Streaming', () => {
  test('stop button shown when streaming and input empty', () => {
    // Render with isStreaming=true, inputValue=''
    // Verify stop-button testid present, send-button absent
  })

  test('queue button shown when streaming and input has text', () => {
    // Render with isStreaming=true, inputValue='hello'
    // Verify send-button testid present with ListPlus icon
  })

  test('send button shown when not streaming', () => {
    // Render with isStreaming=false
    // Verify send-button testid present with Send icon
  })

  test('handleAbort calls window.opencodeOps.abort', async () => {
    // Mock window.opencodeOps.abort
    // Click stop button
    // Verify abort called with correct worktreePath and sessionId
  })
})
```

---

## Session 5: Subagent Event Tagging (Main Process)

### Objectives

- Tag stream events from child/subagent sessions with a `childSessionId` field
- Guard `maybeNotifySessionComplete()` to only fire for the parent session's own `session.idle`
- Prevent child events from being persisted as top-level parent messages

### Tasks

#### 1. Detect child events in `handleEvent()`

In `src/main/services/opencode-service.ts`, in the `handleEvent()` method (around line 987), after resolving the hive session ID, track whether this event came from a child session:

```typescript
// After line 999 (hiveSessionId resolved):
const directHiveId = this.getMappedHiveSessionId(instance, sessionId, eventDirectory)
const isChildEvent = !directHiveId && !!hiveSessionId
```

The logic: if `getMappedHiveSessionId` returned nothing for the raw `sessionId` but we got a `hiveSessionId` through `resolveParentSession`, this is a child event.

#### 2. Guard notifications for parent-only `session.idle`

Replace lines 1003–1008:

```typescript
// BEFORE:
if (eventType === 'session.idle') {
  log.info('Forwarding session.idle to renderer', { ... })
  this.maybeNotifySessionComplete(hiveSessionId)
}

// AFTER:
if (eventType === 'session.idle') {
  log.info('Forwarding session.idle to renderer', {
    opencodeSessionId: sessionId,
    hiveSessionId,
    isChildEvent
  })
  if (!isChildEvent) {
    this.maybeNotifySessionComplete(hiveSessionId)
  }
}
```

#### 3. Tag forwarded events with `childSessionId`

Modify the `StreamEvent` construction (lines 1015–1019):

```typescript
const streamEvent: StreamEvent = {
  type: eventType,
  sessionId: hiveSessionId,
  data: event.properties || event,
  ...(isChildEvent ? { childSessionId: sessionId } : {})
}
```

#### 4. Skip persistence for child events as top-level messages

Before line 1012, add a guard:

```typescript
// Only persist events from the parent session as top-level messages.
// Child/subagent events will be rendered inside SubtaskCards, not as standalone messages.
if (!isChildEvent) {
  this.persistStreamEvent(hiveSessionId, eventType, event.properties || event)
}
```

#### 5. Update `StreamEvent` type

If there's a type definition for `StreamEvent`, add the optional field:

```typescript
interface StreamEvent {
  type: string
  sessionId: string
  data: unknown
  childSessionId?: string
}
```

#### 6. Update preload type

In `src/preload/index.d.ts`, update `OpenCodeStreamEvent`:

```typescript
interface OpenCodeStreamEvent {
  type: string
  sessionId: string
  data: unknown
  childSessionId?: string
}
```

### Key Files

- `src/main/services/opencode-service.ts` — child detection, notification guard, event tagging, persistence guard
- `src/preload/index.d.ts` — `OpenCodeStreamEvent.childSessionId`

### Definition of Done

- [ ] Child events are detected via `isChildEvent` flag
- [ ] `maybeNotifySessionComplete()` only fires for parent `session.idle`, not child
- [ ] Forwarded stream events include `childSessionId` when from a subagent
- [ ] Child events are NOT persisted as top-level parent session messages
- [ ] Parent events continue to be persisted normally
- [ ] `OpenCodeStreamEvent` type includes optional `childSessionId`
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a prompt that triggers subagent use (e.g., "Use the Task tool to research X")
2. Verify no "session completed" notification appears when the subagent finishes
3. Verify the notification DOES appear when the entire parent session completes
4. Check the database — verify no subagent text/tool rows appear as standalone assistant messages

### Testing Criteria

```typescript
// test/phase-9/session-5/subagent-tagging.test.ts
describe('Session 5: Subagent Event Tagging', () => {
  test('child event detected when resolveParentSession succeeds', () => {
    // getMappedHiveSessionId returns null for child session ID
    // resolveParentSession returns a parent ID
    // Verify isChildEvent = true
  })

  test('parent event detected when direct mapping exists', () => {
    // getMappedHiveSessionId returns hive ID directly
    // Verify isChildEvent = false
  })

  test('notification only fires for parent session.idle', () => {
    // Emit session.idle with isChildEvent=true
    // Verify maybeNotifySessionComplete NOT called
    // Emit session.idle with isChildEvent=false
    // Verify maybeNotifySessionComplete called
  })

  test('child events tagged with childSessionId', () => {
    // Process a child event
    // Verify streamEvent has childSessionId field
  })

  test('parent events do not have childSessionId', () => {
    // Process a parent event
    // Verify streamEvent does NOT have childSessionId
  })
})
```

---

## Session 6: Subagent Content Routing (Renderer)

### Objectives

- Route child session events into SubtaskCard parts instead of top-level streaming parts
- Update subtask status when child `session.idle` or error arrives
- Maintain a mapping of child session IDs to subtask indices

### Tasks

#### 1. Add child-to-subtask mapping ref

In `src/renderer/src/components/sessions/SessionView.tsx`, add:

```typescript
const childToSubtaskIndexRef = useRef<Map<string, number>>(new Map())
```

#### 2. Register subtask when created

When a subtask part is added (around line 854–869), register the mapping:

```typescript
} else if (part.type === 'subtask') {
  const subtaskIndex = streamingPartsRef.current.length // index it will be at
  updateStreamingPartsRef((parts) => [
    ...parts,
    {
      type: 'subtask',
      subtask: {
        id: part.id || `subtask-${Date.now()}`,
        sessionID: part.sessionID || '',
        prompt: part.prompt || '',
        description: part.description || '',
        agent: part.agent || 'unknown',
        parts: [],
        status: 'running'
      }
    }
  ])
  // Map child session ID to this subtask's index
  if (part.sessionID) {
    childToSubtaskIndexRef.current.set(part.sessionID, subtaskIndex)
  }
  immediateFlush()
  setIsStreaming(true)
}
```

#### 3. Route child `message.part.updated` events into subtasks

At the top of the `message.part.updated` handler, before the existing part-type switch, add:

```typescript
if (event.type === 'message.part.updated') {
  // Route child events into their SubtaskCard
  if (event.childSessionId) {
    const subtaskIdx = childToSubtaskIndexRef.current.get(event.childSessionId)
    if (subtaskIdx !== undefined) {
      const part = event.data?.part
      if (part?.type === 'text') {
        updateStreamingPartsRef((parts) => {
          const updated = [...parts]
          const subtask = updated[subtaskIdx]
          if (subtask?.type === 'subtask') {
            const lastPart = subtask.subtask.parts[subtask.subtask.parts.length - 1]
            if (lastPart?.type === 'text') {
              lastPart.text = (lastPart.text || '') + (event.data?.delta || part.text || '')
            } else {
              subtask.subtask.parts = [
                ...subtask.subtask.parts,
                { type: 'text', text: event.data?.delta || part.text || '' }
              ]
            }
          }
          return updated
        })
        scheduleFlush()
      } else if (part?.type === 'tool') {
        // Create tool_use part inside subtask
        const state = part.state || part
        const toolId = state.toolCallId || state.id || `tool-${Date.now()}`
        updateStreamingPartsRef((parts) => {
          const updated = [...parts]
          const subtask = updated[subtaskIdx]
          if (subtask?.type === 'subtask') {
            const existing = subtask.subtask.parts.find(
              (p) => p.type === 'tool_use' && p.toolUse?.id === toolId
            )
            if (existing && existing.type === 'tool_use' && existing.toolUse) {
              // Update existing tool
              const statusMap: Record<string, string> = {
                running: 'running',
                completed: 'success',
                error: 'error'
              }
              existing.toolUse.status = (statusMap[state.status] || 'running') as
                | 'pending'
                | 'running'
                | 'success'
                | 'error'
              if (state.time?.end) existing.toolUse.endTime = state.time.end
              if (state.status === 'completed') existing.toolUse.output = state.output
              if (state.status === 'error') existing.toolUse.error = state.error
            } else {
              // Add new tool
              subtask.subtask.parts = [
                ...subtask.subtask.parts,
                {
                  type: 'tool_use',
                  toolUse: {
                    id: toolId,
                    name: state.name || 'unknown',
                    input: state.input,
                    status: 'running',
                    startTime: state.time?.start || Date.now()
                  }
                }
              ]
            }
          }
          return updated
        })
        immediateFlush()
      }
      setIsStreaming(true)
      return // Don't process as top-level part
    }
  }
  // ... existing top-level part processing
}
```

#### 4. Handle child `session.idle` — update subtask status

In the `session.idle` handler, add a child check:

```typescript
} else if (event.type === 'session.idle') {
  // Child session idle — update subtask status, don't finalize parent
  if (event.childSessionId) {
    const subtaskIdx = childToSubtaskIndexRef.current.get(event.childSessionId)
    if (subtaskIdx !== undefined) {
      updateStreamingPartsRef((parts) => {
        const updated = [...parts]
        const subtask = updated[subtaskIdx]
        if (subtask?.type === 'subtask') {
          subtask.subtask.status = 'completed'
        }
        return updated
      })
      immediateFlush()
    }
    return // Don't finalize the parent session
  }

  // ... existing parent session.idle handling
}
```

#### 5. Reset the mapping on session change

In the session initialization cleanup, reset the ref:

```typescript
childToSubtaskIndexRef.current.clear()
```

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — child-to-subtask mapping, event routing, subtask status updates

### Definition of Done

- [ ] `childToSubtaskIndexRef` maps child session IDs to subtask indices
- [ ] Child `message.part.updated` events with text append to the subtask's text parts
- [ ] Child `message.part.updated` events with tools create/update tool_use parts inside the subtask
- [ ] Child `session.idle` updates the subtask status to `'completed'`
- [ ] Child events do NOT appear as top-level streaming parts
- [ ] Parent events continue to render as top-level parts
- [ ] SubtaskCard shows live content during streaming (not just "Processing...")
- [ ] Mapping is cleared on session change
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a prompt that triggers subagent/Task tool usage
2. Observe the SubtaskCard — verify it shows live text and tool cards inside it (not "Processing...")
3. Verify the parent response text doesn't include subagent content interleaved
4. When the subagent finishes, verify the SubtaskCard status changes from spinner to checkmark
5. Expand the SubtaskCard — verify nested content is visible

### Testing Criteria

```typescript
// test/phase-9/session-6/subagent-renderer.test.ts
describe('Session 6: Subagent Content Routing', () => {
  test('child text event appends to subtask parts', () => {
    // Create a subtask with sessionID='child-1'
    // Process a message.part.updated with childSessionId='child-1', part.type='text'
    // Verify the text appears in subtask.parts, not top-level
  })

  test('child tool event creates tool_use in subtask', () => {
    // Process a message.part.updated with childSessionId='child-1', part.type='tool'
    // Verify tool_use appears in subtask.parts
  })

  test('child session.idle updates subtask status to completed', () => {
    // Process session.idle with childSessionId='child-1'
    // Verify subtask.status changed to 'completed'
  })

  test('child session.idle does NOT finalize parent', () => {
    // Process session.idle with childSessionId
    // Verify finalizeResponseFromDatabase NOT called
    // Verify isStreaming still true
  })

  test('parent events unaffected by child routing', () => {
    // Process a message.part.updated WITHOUT childSessionId
    // Verify it appends to top-level streamingParts
  })
})
```

---

## Session 7: Subtool Loading Indicator Fix

### Objectives

- Prevent `message.updated` from child sessions from triggering premature finalization
- Ensure `isStreaming` stays `true` until the parent's own `session.idle` arrives

### Tasks

#### 1. Guard `message.updated` against child events

In `SessionView.tsx`, in the `message.updated` handler (around line 925), add a child guard:

```typescript
} else if (event.type === 'message.updated') {
  if (eventRole === 'user') return

  // Skip finalization for child/subagent messages
  if (event.childSessionId) return

  // ... existing echo detection and finalization logic
}
```

#### 2. Verify `session.idle` guard from Session 6

Confirm that the child `session.idle` guard from Session 6 prevents premature finalization. The `return` statement before the existing parent `session.idle` logic ensures `setIsSending(false)` and `finalizeResponseFromDatabase()` only run for the parent.

#### 3. Verify tool card status updates are independent

Confirm that individual tool cards update their own status (spinner → check → error) via the `upsertToolUse` function without affecting global `isStreaming`. The `setIsStreaming(true)` calls on tool events (line 853) only set it to true, never false — this is correct.

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — `message.updated` child guard

### Definition of Done

- [ ] `message.updated` from child sessions is ignored (no finalization)
- [ ] `session.idle` from child sessions does not trigger parent finalization (Session 6 guard)
- [ ] `isStreaming` remains `true` while any tool is running
- [ ] `isStreaming` only becomes `false` when parent `session.idle` arrives
- [ ] Individual tool cards show correct status (running → success/error) independently
- [ ] The streaming cursor and "Streaming..." label stay visible until all work completes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a prompt that triggers multiple tool calls (e.g., "Read files X, Y, and Z")
2. Watch the first tool complete — verify the streaming indicator (cursor, "Streaming..." label) stays active
3. Watch subsequent tools complete — verify streaming stays active until all are done
4. Only when `session.idle` fires should streaming stop
5. Send a prompt with subagents — verify subagent completion doesn't stop parent streaming

### Testing Criteria

```typescript
// test/phase-9/session-7/subtool-loading.test.ts
describe('Session 7: Subtool Loading Indicator', () => {
  test('message.updated from child does not trigger finalization', () => {
    // Process message.updated with childSessionId set
    // Verify hasFinalizedCurrentResponseRef NOT set
    // Verify finalizeResponseFromDatabase NOT called
  })

  test('message.updated from parent with time.completed triggers finalization', () => {
    // Process message.updated WITHOUT childSessionId, with info.time.completed
    // Verify finalization proceeds
  })

  test('isStreaming stays true after first tool completes', () => {
    // Add 3 tool_use parts in streaming
    // Complete the first tool
    // Verify isStreaming still true
  })

  test('isStreaming becomes false on parent session.idle', () => {
    // Process parent session.idle (no childSessionId)
    // Verify isStreaming set to false via finalizeResponseFromDatabase
  })
})
```

---

## Session 8: Copy on Hover for Messages

### Objectives

- Add a copy-to-clipboard button that appears on hover over any message
- Follow the existing `CodeBlock.tsx` pattern for hover reveal and clipboard access

### Tasks

#### 1. Create `CopyMessageButton.tsx`

Create `src/renderer/src/components/sessions/CopyMessageButton.tsx`:

```typescript
import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface CopyMessageButtonProps {
  content: string
}

export function CopyMessageButton({ content }: CopyMessageButtonProps) {
  const [copied, setCopied] = useState(false)

  if (!content.trim()) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className="absolute top-2 right-2 h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity z-10 bg-background/80 backdrop-blur-sm"
      aria-label="Copy message"
      data-testid="copy-message-button"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Copy className="h-3 w-3 text-muted-foreground" />
      )}
    </Button>
  )
}
```

#### 2. Wrap messages in `MessageRenderer.tsx`

In `src/renderer/src/components/sessions/MessageRenderer.tsx`, add the `group` wrapper:

```typescript
import { CopyMessageButton } from './CopyMessageButton'

export function MessageRenderer({ message, isStreaming = false, cwd }: MessageRendererProps) {
  return (
    <div className="group relative">
      <CopyMessageButton content={message.content} />
      {message.role === 'user' ? (
        <UserBubble content={message.content} timestamp={message.timestamp} />
      ) : (
        <AssistantCanvas
          content={message.content}
          timestamp={message.timestamp}
          isStreaming={isStreaming}
          parts={message.parts}
          cwd={cwd}
        />
      )}
    </div>
  )
}
```

### Key Files

- `src/renderer/src/components/sessions/CopyMessageButton.tsx` — **NEW**
- `src/renderer/src/components/sessions/MessageRenderer.tsx` — `group` wrapper + copy button

### Definition of Done

- [ ] `CopyMessageButton` component created
- [ ] Copy button appears at top-right of any message on hover
- [ ] Button is hidden by default (`opacity-0`)
- [ ] Button is hidden for empty/whitespace messages
- [ ] Clicking copies `message.content` to clipboard
- [ ] Check icon shown for 2s after copy
- [ ] Toast "Copied to clipboard" on success
- [ ] Button doesn't obscure message content
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Hover over a user message — verify copy button appears at top-right
2. Hover over an assistant message — verify copy button appears at top-right
3. Move mouse away — verify copy button disappears
4. Click the copy button — verify check icon appears, toast shown, clipboard has message text
5. Paste in an external app — verify the copied text matches the message content

### Testing Criteria

```typescript
// test/phase-9/session-8/copy-on-hover.test.ts
describe('Session 8: Copy on Hover', () => {
  test('CopyMessageButton renders for non-empty content', () => {
    // Render with content='Hello world'
    // Verify button exists in DOM
  })

  test('CopyMessageButton hidden for empty content', () => {
    // Render with content='   '
    // Verify returns null
  })

  test('clicking copy writes to clipboard', async () => {
    // Mock navigator.clipboard.writeText
    // Render and click
    // Verify writeText called with content
  })

  test('MessageRenderer wraps with group class', () => {
    // Render MessageRenderer with a user message
    // Verify outer div has 'group' and 'relative' classes
    // Verify CopyMessageButton is rendered
  })
})
```

---

## Session 9: Per-Session Input Field Persistence

### Objectives

- Persist input field drafts per session to SQLite
- Load drafts on session switch, save on unmount and after 3s debounce
- Clear drafts on message send

### Tasks

#### 1. Add database migration

In `src/main/db/schema.ts`, bump version and add migration:

```typescript
export const CURRENT_SCHEMA_VERSION = 6

// Add to MIGRATIONS array:
{
  version: 6,
  name: 'add_session_draft_input',
  up: `ALTER TABLE sessions ADD COLUMN draft_input TEXT DEFAULT NULL;`,
  down: `-- SQLite does not support DROP COLUMN; recreate table if needed`
}
```

#### 2. Add database methods

In `src/main/db/database.ts`, add:

```typescript
getSessionDraft(sessionId: string): string | null {
  const row = this.db.prepare('SELECT draft_input FROM sessions WHERE id = ?').get(sessionId) as { draft_input: string | null } | undefined
  return row?.draft_input ?? null
}

updateSessionDraft(sessionId: string, draft: string | null): void {
  this.db.prepare('UPDATE sessions SET draft_input = ? WHERE id = ?').run(draft, sessionId)
}
```

#### 3. Add IPC handlers

In the appropriate handler file (e.g., `src/main/ipc/database-handlers.ts`), add:

```typescript
ipcMain.handle('db:session:getDraft', (_event, sessionId: string) => {
  return db.getSessionDraft(sessionId)
})

ipcMain.handle('db:session:updateDraft', (_event, sessionId: string, draft: string | null) => {
  db.updateSessionDraft(sessionId, draft)
})
```

#### 4. Expose in preload

Add to `window.db.session` in `src/preload/index.ts`:

```typescript
getDraft: (sessionId: string) => ipcRenderer.invoke('db:session:getDraft', sessionId),
updateDraft: (sessionId: string, draft: string | null) =>
  ipcRenderer.invoke('db:session:updateDraft', sessionId, draft)
```

#### 5. Add type declarations

In `src/preload/index.d.ts`, add to the session DB ops:

```typescript
getDraft: (sessionId: string) => Promise<string | null>
updateDraft: (sessionId: string, draft: string | null) => Promise<void>
```

#### 6. Wire up in SessionView

In `src/renderer/src/components/sessions/SessionView.tsx`:

Add an `inputValueRef` to track the current value in cleanup:

```typescript
const inputValueRef = useRef('')
```

Keep it in sync:

```typescript
const handleInputChange = useCallback(
  (value: string) => {
    setInputValue(value)
    inputValueRef.current = value

    // Debounce draft persistence (3 seconds)
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      window.db.session.updateDraft(sessionId, value || null)
    }, 3000)
  },
  [sessionId]
)
```

Load draft on mount:

```typescript
// Inside the session initialization effect:
window.db.session.getDraft(sessionId).then((draft) => {
  if (draft) {
    setInputValue(draft)
    inputValueRef.current = draft
  }
})
```

Save on unmount:

```typescript
useEffect(() => {
  return () => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    const currentValue = inputValueRef.current
    if (currentValue) {
      window.db.session.updateDraft(sessionId, currentValue)
    }
  }
}, [sessionId])
```

Clear on send:

```typescript
// In handleSend, after setInputValue(''):
inputValueRef.current = ''
window.db.session.updateDraft(sessionId, null)
```

### Key Files

- `src/main/db/schema.ts` — migration
- `src/main/db/database.ts` — `getSessionDraft`, `updateSessionDraft`
- `src/main/ipc/database-handlers.ts` — IPC handlers
- `src/preload/index.ts` — expose draft methods
- `src/preload/index.d.ts` — type declarations
- `src/renderer/src/components/sessions/SessionView.tsx` — load/save/clear logic

### Definition of Done

- [ ] `CURRENT_SCHEMA_VERSION` bumped to 6
- [ ] `draft_input` column added to sessions table via migration
- [ ] `getSessionDraft` and `updateSessionDraft` DB methods work
- [ ] IPC handlers registered for `db:session:getDraft` and `db:session:updateDraft`
- [ ] Preload exposes `getDraft` and `updateDraft` on `window.db.session`
- [ ] Opening a session loads any saved draft into the input field
- [ ] Typing debounces a save after 3 seconds of inactivity
- [ ] Switching sessions saves the current draft immediately (unmount)
- [ ] Sending a message clears the draft from DB and input
- [ ] Restarting the app restores drafts for active sessions
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a session, type "hello world" in the input — do NOT send
2. Switch to a different session
3. Switch back — verify "hello world" is still in the input
4. Type "test draft", wait 4 seconds
5. Close and reopen the app — verify "test draft" is in the input for that session
6. Send the message — verify the input clears
7. Switch away and back — verify the input is empty (draft was cleared on send)

### Testing Criteria

```typescript
// test/phase-9/session-9/input-persistence.test.ts
describe('Session 9: Input Persistence', () => {
  test('draft loaded on session mount', async () => {
    // Mock window.db.session.getDraft returning 'saved draft'
    // Render SessionView
    // Verify inputValue becomes 'saved draft'
  })

  test('draft saved after 3 second debounce', async () => {
    // Type into input
    // Verify updateDraft NOT called immediately
    // Advance timers by 3000ms
    // Verify updateDraft called with current text
  })

  test('draft saved on unmount', () => {
    // Render SessionView, type text
    // Unmount
    // Verify updateDraft called with current text
  })

  test('draft cleared on send', () => {
    // Type and send
    // Verify updateDraft called with null
  })
})
```

---

## Session 10: File Search Store & Shortcut

### Objectives

- Create the Zustand store for the file search dialog
- Register the Cmd+D shortcut via `before-input-event` and IPC

### Tasks

#### 1. Create `useFileSearchStore`

Create `src/renderer/src/stores/useFileSearchStore.ts`:

```typescript
import { create } from 'zustand'

interface FileSearchState {
  isOpen: boolean
  searchQuery: string
  selectedIndex: number
  open: () => void
  close: () => void
  toggle: () => void
  setSearchQuery: (query: string) => void
  setSelectedIndex: (index: number) => void
  moveSelection: (direction: 'up' | 'down', maxIndex: number) => void
}

export const useFileSearchStore = create<FileSearchState>((set) => ({
  isOpen: false,
  searchQuery: '',
  selectedIndex: 0,
  open: () => set({ isOpen: true, searchQuery: '', selectedIndex: 0 }),
  close: () => set({ isOpen: false, searchQuery: '', selectedIndex: 0 }),
  toggle: () =>
    set((state) =>
      state.isOpen
        ? { isOpen: false, searchQuery: '', selectedIndex: 0 }
        : { isOpen: true, searchQuery: '', selectedIndex: 0 }
    ),
  setSearchQuery: (query) => set({ searchQuery: query, selectedIndex: 0 }),
  setSelectedIndex: (index) => set({ selectedIndex: index }),
  moveSelection: (direction, maxIndex) =>
    set((state) => ({
      selectedIndex:
        direction === 'up'
          ? Math.max(0, state.selectedIndex - 1)
          : Math.min(maxIndex, state.selectedIndex + 1)
    }))
}))
```

#### 2. Add shortcut definition

In `src/renderer/src/lib/keyboard-shortcuts.ts`, add:

```typescript
{
  id: 'nav:file-search',
  label: 'Search Files',
  description: 'Open the file search dialog',
  category: 'navigation',
  defaultBinding: { key: 'd', modifiers: ['meta'] }
}
```

#### 3. Intercept Cmd+D in main process

In `src/main/index.ts`, add to the `before-input-event` handler:

```typescript
if (
  input.key.toLowerCase() === 'd' &&
  (input.meta || input.control) &&
  !input.alt &&
  !input.shift &&
  input.type === 'keyDown'
) {
  event.preventDefault()
  mainWindow!.webContents.send('shortcut:file-search')
}
```

#### 4. Expose in preload

In `src/preload/index.ts`, add to `systemOps`:

```typescript
onFileSearchShortcut: (callback: () => void) => {
  const handler = (): void => {
    callback()
  }
  ipcRenderer.on('shortcut:file-search', handler)
  return () => {
    ipcRenderer.removeListener('shortcut:file-search', handler)
  }
}
```

#### 5. Add type declaration

In `src/preload/index.d.ts`:

```typescript
onFileSearchShortcut: (callback: () => void) => () => void
```

#### 6. Register in `useKeyboardShortcuts.ts`

Add a `useEffect` for the IPC listener:

```typescript
useEffect(() => {
  if (!window.systemOps?.onFileSearchShortcut) return

  const cleanup = window.systemOps.onFileSearchShortcut(() => {
    useFileSearchStore.getState().toggle()
  })

  return cleanup
}, [])
```

Also add the shortcut handler:

```typescript
{
  id: 'nav:file-search',
  binding: getEffectiveBinding('nav:file-search'),
  allowInInput: true,
  handler: () => {
    useFileSearchStore.getState().toggle()
  }
}
```

#### 7. Export store from `stores/index.ts`

Add `export { useFileSearchStore } from './useFileSearchStore'` to the stores barrel export.

### Key Files

- `src/renderer/src/stores/useFileSearchStore.ts` — **NEW**
- `src/renderer/src/lib/keyboard-shortcuts.ts` — shortcut definition
- `src/main/index.ts` — Cmd+D interception
- `src/preload/index.ts` — `onFileSearchShortcut`
- `src/preload/index.d.ts` — type declaration
- `src/renderer/src/hooks/useKeyboardShortcuts.ts` — IPC listener + handler

### Definition of Done

- [ ] `useFileSearchStore` created with `isOpen`, `searchQuery`, `selectedIndex`, actions
- [ ] `nav:file-search` shortcut defined with `{ key: 'd', modifiers: ['meta'] }`
- [ ] Cmd+D intercepted at `before-input-event` level
- [ ] IPC forwarded to renderer via `shortcut:file-search`
- [ ] Cmd+D toggles the file search store open/close
- [ ] Store resets query and selection on open/close
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Press Cmd+D — verify `useFileSearchStore.isOpen` becomes `true` (log in devtools)
2. Press Cmd+D again — verify it toggles back to `false`
3. Verify Cmd+D works from textarea focus

### Testing Criteria

```typescript
// test/phase-9/session-10/file-search-store.test.ts
describe('Session 10: File Search Store', () => {
  test('open sets isOpen true and resets query', () => {
    useFileSearchStore.getState().open()
    expect(useFileSearchStore.getState().isOpen).toBe(true)
    expect(useFileSearchStore.getState().searchQuery).toBe('')
  })

  test('close sets isOpen false', () => {
    useFileSearchStore.getState().open()
    useFileSearchStore.getState().close()
    expect(useFileSearchStore.getState().isOpen).toBe(false)
  })

  test('toggle flips isOpen', () => {
    useFileSearchStore.getState().toggle()
    expect(useFileSearchStore.getState().isOpen).toBe(true)
    useFileSearchStore.getState().toggle()
    expect(useFileSearchStore.getState().isOpen).toBe(false)
  })

  test('moveSelection stays within bounds', () => {
    useFileSearchStore.getState().moveSelection('down', 5)
    expect(useFileSearchStore.getState().selectedIndex).toBe(1)
    useFileSearchStore.getState().moveSelection('up', 5)
    expect(useFileSearchStore.getState().selectedIndex).toBe(0)
    useFileSearchStore.getState().moveSelection('up', 5)
    expect(useFileSearchStore.getState().selectedIndex).toBe(0) // stays at 0
  })
})
```

---

## Session 11: File Search Dialog Component

### Objectives

- Build the `FileSearchDialog` component with fuzzy file matching
- Wire it to the file tree store and file viewer store
- Render it in `AppLayout`

### Tasks

#### 1. Create the file search dialog

Create `src/renderer/src/components/file-search/FileSearchDialog.tsx`:

The component should:

- Render only when `useFileSearchStore.isOpen` is `true`
- Use `cmdk` for the input + list pattern (consistent with command palette)
- Flatten the file tree from `useFileTreeStore` into a searchable list
- Fuzzy-match against file name and relative path
- Limit results to 50 items
- Enter opens the selected file via `useFileViewerStore.openFile()`
- Escape closes the dialog
- Arrow keys navigate results

```typescript
import { useEffect, useCallback, useMemo } from 'react'
import { Command } from 'cmdk'
import { FileCode, Search } from 'lucide-react'
import { useFileSearchStore } from '@/stores/useFileSearchStore'
import { useFileTreeStore } from '@/stores'
import { useFileViewerStore } from '@/stores'
import { useWorktreeStore } from '@/stores'

// Flatten file tree to searchable array
function flattenTree(
  nodes: FileTreeNode[]
): Array<{ name: string; path: string; relativePath: string }> {
  const result: Array<{ name: string; path: string; relativePath: string }> = []
  const walk = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (!node.isDirectory) {
        result.push({ name: node.name, path: node.path, relativePath: node.relativePath })
      }
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return result
}

// Fuzzy match scoring
function scoreMatch(query: string, file: { name: string; relativePath: string }): number {
  const q = query.toLowerCase()
  const name = file.name.toLowerCase()
  const path = file.relativePath.toLowerCase()

  if (name === q) return 100
  if (name.startsWith(q)) return 80
  if (name.includes(q)) return 60
  if (path.includes(q)) return 40

  // Subsequence match
  let qi = 0
  for (let i = 0; i < path.length && qi < q.length; i++) {
    if (path[i] === q[qi]) qi++
  }
  return qi === q.length ? 20 : 0
}
```

#### 2. Create barrel export

Create `src/renderer/src/components/file-search/index.ts`:

```typescript
export { FileSearchDialog } from './FileSearchDialog'
```

#### 3. Render in AppLayout

In `src/renderer/src/components/layout/AppLayout.tsx`, add:

```typescript
import { FileSearchDialog } from '@/components/file-search'

// Inside the component JSX:
<FileSearchDialog />
```

### Key Files

- `src/renderer/src/components/file-search/FileSearchDialog.tsx` — **NEW**
- `src/renderer/src/components/file-search/index.ts` — **NEW**
- `src/renderer/src/components/layout/AppLayout.tsx` — render dialog

### Definition of Done

- [ ] `FileSearchDialog` renders when `isOpen` is true
- [ ] Input field auto-focuses on open
- [ ] Typing filters files by fuzzy match on name and relative path
- [ ] Results limited to 50 items
- [ ] Arrow keys navigate the list
- [ ] Enter opens the selected file in the file viewer
- [ ] Escape closes the dialog
- [ ] Clicking outside closes the dialog
- [ ] Dialog looks consistent with command palette styling
- [ ] File icons shown in results
- [ ] Relative path shown as secondary text
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Press Cmd+D — verify the file search dialog appears
2. Type a file name (e.g., "index") — verify matching files appear as you type
3. Arrow down to a result, press Enter — verify the file opens in the preview editor
4. Press Escape — verify the dialog closes
5. Press Cmd+D, type a partial path (e.g., "main/serv") — verify `opencode-service.ts` appears
6. Click outside the dialog — verify it closes

### Testing Criteria

```typescript
// test/phase-9/session-11/file-search-dialog.test.ts
describe('Session 11: File Search Dialog', () => {
  test('flattenTree extracts all files recursively', () => {
    const tree = [
      {
        name: 'src',
        isDirectory: true,
        children: [
          {
            name: 'index.ts',
            isDirectory: false,
            path: '/src/index.ts',
            relativePath: 'src/index.ts'
          }
        ],
        path: '/src',
        relativePath: 'src'
      },
      { name: 'README.md', isDirectory: false, path: '/README.md', relativePath: 'README.md' }
    ]
    const flat = flattenTree(tree)
    expect(flat).toHaveLength(2)
    expect(flat[0].name).toBe('index.ts')
  })

  test('scoreMatch returns highest for exact name match', () => {
    expect(scoreMatch('index.ts', { name: 'index.ts', relativePath: 'src/index.ts' })).toBe(100)
  })

  test('scoreMatch returns 0 for no match', () => {
    expect(scoreMatch('xyz', { name: 'index.ts', relativePath: 'src/index.ts' })).toBe(0)
  })

  test('dialog opens file on enter', () => {
    // Mock useFileViewerStore.openFile
    // Open dialog, select a file, press Enter
    // Verify openFile called with correct path
  })
})
```

---

## Session 12: Integration & Verification

### Objectives

- Verify all Phase 9 features work correctly together
- Test cross-feature interactions
- Run lint and tests
- Fix any edge cases or regressions

### Tasks

#### 1. PATH fix + abort interaction

- Launch from Finder → connect to session → send message → abort mid-stream → verify clean abort
- Verify `opencode` binary is found (PATH fix) AND abort SDK call succeeds

#### 2. Cmd+W + Cmd+D + input persistence interaction

- Open a session, type a draft, press Cmd+D → verify file search opens (draft preserved in background)
- Close file search, press Cmd+W → verify session closes (draft should be saved on unmount)
- Reopen the session → verify draft is gone (it was a closed session)

#### 3. Hidden files + file search interaction

- Verify dotfiles (`.env`, `.gitignore`) appear in Cmd+D file search results
- Select a dotfile from search → verify it opens in preview

#### 4. Subagent + abort interaction

- Send a prompt triggering subagents → abort mid-subagent → verify clean halt
- Verify SubtaskCard shows partial content and stops updating

#### 5. Copy on hover + streaming

- During streaming, hover over a partially-streamed assistant message → verify copy button appears
- Click copy → verify partial text is copied (whatever has been produced so far)

#### 6. Input persistence + abort

- Type a draft → send (clears draft) → abort → type new draft → verify new draft persists

#### 7. Full smoke test

Run through:

1. Launch app → PATH fix works → connect → Cmd+T new session → type draft → Cmd+D search file → open file → close file tab → verify draft persisted → send message → streaming with subagents → subagent content in SubtaskCard → hover copy → abort with stop button → Cmd+W close session → verify window stays open

#### 8. Run lint and tests

```bash
pnpm lint
pnpm test
```

Fix any failures.

### Key Files

- All files modified in sessions 1–11

### Definition of Done

- [ ] All 9 features work correctly in isolation
- [ ] Cross-feature interactions work correctly
- [ ] No regressions in Phase 8 features (auto-scroll, streaming flush, echo fix, Cmd+T)
- [ ] No console errors during normal operation
- [ ] No leaked timers, rAF callbacks, or IPC listeners
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Full happy path smoke test passes

### How to Test

Run through each integration scenario listed in Tasks above. Pay special attention to:

- Abort during subagent work (timing-sensitive)
- Draft persistence across rapid session switches
- File search over lazily-loaded tree nodes

### Testing Criteria

```typescript
// test/phase-9/session-12/integration-verification.test.ts
describe('Session 12: Integration & Verification', () => {
  test('abort stops streaming cleanly', () => {
    // Send message, start streaming, call abort
    // Verify streaming stops, partial content preserved
  })

  test('subagent content routes into SubtaskCard', () => {
    // Stream with subagent events
    // Verify SubtaskCard has content, top-level doesn't have subagent text
  })

  test('copy works during streaming', () => {
    // Start streaming, hover message, click copy
    // Verify clipboard has partial text
  })

  test('draft survives app restart', () => {
    // Type draft, unmount (simulating app close), remount
    // Verify draft loaded from DB
  })

  test('file search finds dotfiles', () => {
    // Open file search, type '.env'
    // Verify .env appears in results
  })

  test('Cmd+W never closes window', () => {
    // Trigger Cmd+W IPC event
    // Verify BrowserWindow.close NOT called
  })

  test('lint passes', () => {
    // pnpm lint exit code 0
  })

  test('tests pass', () => {
    // pnpm test exit code 0
  })
})
```

---

## Dependencies & Order

```
Session 1  (PATH Fix)          ── independent, main process only
Session 2  (Hidden Files)      ── independent, file-tree-handlers only
Session 3  (Cmd+W Override)    ── independent, main+preload+renderer
Session 4  (Abort Streaming)   ── independent, full IPC chain
Session 5  (Subagent Tagging)  ── independent, main process only
    |
    └──► Session 6  (Subagent Renderer)  ── depends on Session 5 (needs childSessionId)
              |
              └──► Session 7  (Subtool Loading)  ── depends on Session 6 (uses childSessionId guard)
Session 8  (Copy on Hover)     ── independent, renderer only
Session 9  (Input Persistence) ── independent, full IPC chain
Session 10 (File Search Store) ── independent, renderer+main+preload
    |
    └──► Session 11 (File Search Dialog) ── depends on Session 10 (needs store)

Session 12 (Integration)       ── requires sessions 1-11
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────────┐
│  Time →                                                              │
│                                                                      │
│  Track A: [S1: PATH] [S2: Hidden Files]                              │
│  Track B: [S3: Cmd+W]                                                │
│  Track C: [S4: Abort]                                                │
│  Track D: [S5: Subagent Tag] → [S6: Subagent Render] → [S7: Loading]│
│  Track E: [S8: Copy on Hover]                                        │
│  Track F: [S9: Input Persistence]                                    │
│  Track G: [S10: File Search Store] → [S11: File Search Dialog]       │
│                                                                      │
│  All ────────────────────────────────────────► [S12: Integration]     │
└──────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Tracks A–G are fully independent. Within each track, sessions are sequential.

**Critical path**: Track D (Sessions 5 → 6 → 7) is the longest sequential chain at 3 sessions.

**Minimum total**: 4 rounds — (S1–S5, S8–S10 in parallel) → (S2, S6, S11 in parallel) → (S7) → (S12).

---

## Notes

### Assumed Phase 8 Infrastructure

- Smart auto-scroll with FAB
- Adaptive streaming flush (rAF-based)
- User message echo fix
- Cmd+T interception via `before-input-event`

### Out of Scope (Phase 9)

Per PRD Phase 9:

- Toggle for show/hide hidden files (all dotfiles shown, `.git` and `.DS_Store` hardcoded)
- Markdown rendering in copy output (raw text only)
- Abort with partial retry
- Input draft undo/redo history
- File search by file contents (names/paths only)
- File search frecency ranking
- Subagent progress percentage in SubtaskCard
- Nested subagent chains (only one level of child→parent)
- Custom file tree exclusion list
- Configurable draft auto-save interval

### Performance Targets

| Operation                        | Target                              |
| -------------------------------- | ----------------------------------- |
| PATH fix startup overhead        | < 500ms                             |
| File tree scan with dotfiles     | No measurable regression            |
| Cmd+W interception               | < 5ms from keypress to IPC delivery |
| Abort round-trip (button → stop) | < 200ms                             |
| Draft debounce persistence       | 3000ms after last keystroke         |
| Draft load on session switch     | < 50ms                              |
| Copy to clipboard                | < 50ms for messages up to 100KB     |
| File search fuzzy matching       | < 10ms for 10,000 files             |
| Subagent event routing           | No additional latency (map lookup)  |
| Streaming indicator accuracy     | Active until parent session.idle    |

### Key Architecture Decisions

1. **`fix-path` over manual shell spawn**: Well-maintained package, handles edge cases (shell timeout, non-zsh shells, Windows no-op). Avoids reimplementing shell PATH extraction.
2. **Custom File menu over `fileMenu` role**: Electron's `fileMenu` includes "Close Window" (Cmd+W) which cannot be overridden. A custom menu gives full control over accelerators and actions.
3. **SDK `session.abort()` over AbortController**: The OpenCode SDK provides a first-class abort API that properly signals the server. An AbortController would only cancel the client-side SSE subscription, not the server-side processing.
4. **`draft_input` column on sessions table over separate table**: Simpler schema, no joins needed. Drafts have a 1:1 relationship with sessions. Cleanup is automatic via existing row lifecycle.
5. **Child event tagging over separate event channels**: Adding `childSessionId` to existing stream events is non-breaking and avoids creating a parallel event infrastructure. The renderer can distinguish child vs parent events with a single field check.
6. **File search using `cmdk` over custom implementation**: Consistent UX with the existing command palette. `cmdk` handles keyboard navigation, focus management, and accessibility out of the box.
