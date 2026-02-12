# Hive Phase 8 Implementation Plan

This document outlines the implementation plan for Hive Phase 8, focusing on streaming UX quality (smart auto-scroll, adaptive flush), message integrity (echo fix), and keyboard shortcut reliability (Cmd+T).

---

## Overview

The implementation is divided into **6 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 8 builds upon Phase 7** — all Phase 7 infrastructure is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 8)

```
test/
├── phase-8/
│   ├── session-1/
│   │   └── message-echo-fix.test.ts
│   ├── session-2/
│   │   └── cmd-t-shortcut.test.ts
│   ├── session-3/
│   │   └── adaptive-flush.test.ts
│   ├── session-4/
│   │   └── smart-auto-scroll.test.ts
│   ├── session-5/
│   │   └── scroll-fab.test.ts
│   └── session-6/
│       └── integration-verification.test.ts
```

### New Dependencies

```json
// No new dependencies required
```

All features use existing packages: React, Zustand, Electron, lucide-react.

---

## Session 1: Fix User Message Echo (Bug Fix)

### Objectives

- Fix the bug where user messages sent to the OpenCode SDK are echoed back and persisted as assistant messages in the database
- Invert role guards in `persistStreamEvent` so only confirmed assistant messages are persisted
- Extend `extractEventMessageRole` with additional payload paths for robustness

### Tasks

#### 1. Invert role guards in `persistStreamEvent`

In `src/main/services/opencode-service.ts`, locate the `persistStreamEvent` function's `message.part.updated` handler (around line 250):

```typescript
// BEFORE (line ~250):
if (role === 'user') return

// AFTER:
if (role !== 'assistant') return
```

Then locate the `message.updated` handler (around line 280):

```typescript
// BEFORE (lines ~280-284):
if (role === 'user') return
if (!messageId) return
if (role && role !== 'assistant') return

// AFTER:
if (role !== 'assistant') return
if (!messageId) return
```

The second handler's three separate guards collapse into a single `if (role !== 'assistant') return`. This handles all cases: `undefined` role (extraction failed), `'user'` role (SDK echo), and any other unexpected role value.

#### 2. Extend `extractEventMessageRole`

In the same file, locate `extractEventMessageRole` (around lines 177–186). Add additional payload paths:

```typescript
function extractEventMessageRole(eventData: Record<string, unknown>): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = eventData as any
  const paths = [
    d?.message?.role,
    d?.info?.role,
    d?.part?.role,
    d?.role,
    d?.properties?.message?.role,
    d?.properties?.info?.role,
    d?.properties?.part?.role,
    d?.properties?.role,
    d?.metadata?.role,
    d?.content?.role
  ]
  for (const val of paths) {
    if (typeof val === 'string') return val
  }
  return undefined
}
```

#### 3. Verify the renderer-side guards are still intact

Confirm that `SessionView.tsx` still has user-echo skips at:

- Line ~647: `if (eventRole === 'user') return` (in `message.part.updated` handler)
- Line ~745: `if (eventRole === 'user') return` (in `message.updated` handler)

These are defense-in-depth — the main process fix is the primary fix, the renderer guards prevent any visual flicker.

### Key Files

- `src/main/services/opencode-service.ts` — role guard inversion + enhanced role extraction

### Definition of Done

- [ ] `persistStreamEvent` only persists events with confirmed `role === 'assistant'`
- [ ] Events with `undefined` role are silently dropped (not persisted)
- [ ] Events with `role === 'user'` are silently dropped (not persisted)
- [ ] `extractEventMessageRole` checks 10+ payload paths for the role field
- [ ] Sending a user message does NOT produce a duplicate assistant-role message in the database
- [ ] `finalizeResponseFromDatabase` loads only legitimate messages (user messages + real assistant responses)
- [ ] Renderer-side `eventRole === 'user'` guards remain in place as defense-in-depth
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start the app, select a worktree, open a session
2. Send a message to the AI
3. Wait for the response to complete
4. Open the SQLite database (`~/.hive/hive.db`) and query: `SELECT id, role, content FROM session_messages WHERE session_id = '<id>' ORDER BY created_at`
5. Verify: exactly one `user` row with your message, exactly one `assistant` row with the AI response — no duplicates
6. Send multiple messages in succession — verify no echoes accumulate
7. Refresh the session (switch away and back) — verify message history is clean

### Testing Criteria

```typescript
// test/phase-8/session-1/message-echo-fix.test.ts
describe('Session 1: Message Echo Fix', () => {
  describe('extractEventMessageRole', () => {
    test('extracts role from message.role path', () => {
      const role = extractEventMessageRole({ message: { role: 'user' } })
      expect(role).toBe('user')
    })

    test('extracts role from info.role path', () => {
      const role = extractEventMessageRole({ info: { role: 'assistant' } })
      expect(role).toBe('assistant')
    })

    test('extracts role from part.role path', () => {
      const role = extractEventMessageRole({ part: { role: 'user' } })
      expect(role).toBe('user')
    })

    test('extracts role from nested properties path', () => {
      const role = extractEventMessageRole({
        properties: { message: { role: 'assistant' } }
      })
      expect(role).toBe('assistant')
    })

    test('returns undefined when role not found', () => {
      const role = extractEventMessageRole({ foo: 'bar' })
      expect(role).toBeUndefined()
    })

    test('returns undefined for empty object', () => {
      const role = extractEventMessageRole({})
      expect(role).toBeUndefined()
    })

    test('first valid path wins', () => {
      const role = extractEventMessageRole({
        message: { role: 'user' },
        info: { role: 'assistant' }
      })
      expect(role).toBe('user')
    })
  })

  describe('persistStreamEvent role guards', () => {
    test('message.part.updated with role=assistant is persisted', () => {
      // Mock event with role='assistant', valid part and messageId
      // Verify upsertSessionMessageByOpenCodeId called
    })

    test('message.part.updated with role=user is NOT persisted', () => {
      // Mock event with role='user'
      // Verify upsertSessionMessageByOpenCodeId NOT called
    })

    test('message.part.updated with undefined role is NOT persisted', () => {
      // Mock event with no role field anywhere
      // Verify upsertSessionMessageByOpenCodeId NOT called
    })

    test('message.updated with role=assistant is persisted', () => {
      // Mock event with role='assistant', valid messageId
      // Verify upsertSessionMessageByOpenCodeId called
    })

    test('message.updated with role=user is NOT persisted', () => {
      // Mock event with role='user'
      // Verify upsertSessionMessageByOpenCodeId NOT called
    })

    test('message.updated with undefined role is NOT persisted', () => {
      // Mock event with no role field
      // Verify upsertSessionMessageByOpenCodeId NOT called
    })
  })
})
```

---

## Session 2: Fix Cmd+T New Session Shortcut

### Objectives

- Intercept Cmd+T at the Electron main process level before Chromium consumes it
- Forward the shortcut to the renderer via IPC to trigger new session creation
- Ensure Cmd+T works even when the chat textarea is focused

### Tasks

#### 1. Add `before-input-event` listener in main process

In `src/main/index.ts`, after the `mainWindow` is created (inside `createWindow` or wherever the BrowserWindow is set up), add:

```typescript
mainWindow.webContents.on('before-input-event', (event, input) => {
  // Intercept Cmd+T (macOS) / Ctrl+T (Windows/Linux) before Chromium handles it
  if (
    input.key.toLowerCase() === 't' &&
    (input.meta || input.control) &&
    !input.alt &&
    !input.shift &&
    input.type === 'keyDown'
  ) {
    event.preventDefault()
    mainWindow.webContents.send('shortcut:new-session')
  }
})
```

Note the `input.type === 'keyDown'` check to avoid firing on keyUp events.

#### 2. Expose IPC listener in preload

In `src/preload/index.ts`, add to the `systemOps` namespace:

```typescript
onNewSessionShortcut: (callback: () => void) => {
  const handler = (): void => {
    callback()
  }
  ipcRenderer.on('shortcut:new-session', handler)
  return () => {
    ipcRenderer.removeListener('shortcut:new-session', handler)
  }
}
```

#### 3. Add type declaration

In `src/preload/index.d.ts`, add to the `SystemOps` interface:

```typescript
onNewSessionShortcut: (callback: () => void) => () => void
```

#### 4. Register IPC listener in renderer

In `src/renderer/src/hooks/useKeyboardShortcuts.ts`, add a `useEffect` inside the `useKeyboardShortcuts` hook to listen for the main-process Cmd+T forwarding:

```typescript
useEffect(() => {
  if (!window.systemOps?.onNewSessionShortcut) return

  const cleanup = window.systemOps.onNewSessionShortcut(() => {
    const { selectedWorktreeId, worktreesByProject } = useWorktreeStore.getState()
    if (!selectedWorktreeId) {
      toast.error('Please select a worktree first')
      return
    }
    let projectId: string | null = null
    for (const [pid, worktrees] of worktreesByProject) {
      if (worktrees.find((w) => w.id === selectedWorktreeId)) {
        projectId = pid
        break
      }
    }
    if (!projectId) {
      toast.error('Please select a worktree first')
      return
    }
    useSessionStore
      .getState()
      .createSession(selectedWorktreeId, projectId)
      .then((result) => {
        if (result.success) {
          toast.success('New session created')
        } else {
          toast.error(result.error || 'Failed to create session')
        }
      })
  })

  return cleanup
}, [])
```

This duplicates the existing `session:new` handler logic. To avoid duplication, extract the handler into a shared function:

```typescript
function createNewSession(): void {
  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore.getState()
  if (!selectedWorktreeId) {
    toast.error('Please select a worktree first')
    return
  }
  let projectId: string | null = null
  for (const [pid, worktrees] of worktreesByProject) {
    if (worktrees.find((w) => w.id === selectedWorktreeId)) {
      projectId = pid
      break
    }
  }
  if (!projectId) {
    toast.error('Please select a worktree first')
    return
  }
  useSessionStore
    .getState()
    .createSession(selectedWorktreeId, projectId)
    .then((result) => {
      if (result.success) {
        toast.success('New session created')
      } else {
        toast.error(result.error || 'Failed to create session')
      }
    })
}
```

Use this in both the `session:new` keyboard shortcut handler and the IPC listener.

#### 5. Change `allowInInput` for `session:new`

In the `getShortcutHandlers` function in `useKeyboardShortcuts.ts`, find the `session:new` entry and change:

```typescript
// BEFORE:
allowInInput: false

// AFTER:
allowInInput: true
```

This ensures that even if the event does reach the DOM (some platforms/configurations), it fires while the textarea is focused.

### Key Files

- `src/main/index.ts` — `before-input-event` listener
- `src/preload/index.ts` — expose `onNewSessionShortcut`
- `src/preload/index.d.ts` — type declaration
- `src/renderer/src/hooks/useKeyboardShortcuts.ts` — IPC listener + `allowInInput: true`

### Definition of Done

- [ ] Cmd+T on macOS creates a new session tab
- [ ] Ctrl+T on all platforms creates a new session tab (existing behavior preserved)
- [ ] Cmd+T works when the chat textarea is focused
- [ ] Cmd+T works when no input element is focused
- [ ] Cmd+T does not open a Chromium "new tab" (Electron default behavior suppressed)
- [ ] When no worktree is selected, Cmd+T shows an error toast
- [ ] Success toast shown when session is created
- [ ] `before-input-event` only intercepts `keyDown` (not `keyUp`)
- [ ] IPC listener properly cleaned up on unmount
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start the app, select a worktree with at least one session open
2. Click into the session textarea (focus it)
3. Press Cmd+T → verify a new session tab appears and "New session created" toast shown
4. Press Cmd+T again with no textarea focus → verify another session created
5. Press Ctrl+T → verify it also works (backward compatibility)
6. Deselect all worktrees → press Cmd+T → verify "Please select a worktree first" error toast
7. Verify no Chromium "new tab" behavior occurs on Cmd+T

### Testing Criteria

```typescript
// test/phase-8/session-2/cmd-t-shortcut.test.ts
describe('Session 2: Cmd+T Shortcut Fix', () => {
  describe('before-input-event handler', () => {
    test('Cmd+T keyDown sends IPC event', () => {
      // Simulate before-input-event with meta=true, key='t', type='keyDown'
      // Verify event.preventDefault called
      // Verify webContents.send called with 'shortcut:new-session'
    })

    test('Ctrl+T keyDown sends IPC event', () => {
      // Simulate before-input-event with control=true, key='t', type='keyDown'
      // Verify event.preventDefault called
      // Verify webContents.send called with 'shortcut:new-session'
    })

    test('Cmd+T keyUp does NOT send IPC event', () => {
      // Simulate before-input-event with meta=true, key='t', type='keyUp'
      // Verify event.preventDefault NOT called
    })

    test('Cmd+Shift+T does NOT trigger', () => {
      // Simulate with meta=true, shift=true, key='t'
      // Verify NOT intercepted
    })

    test('Alt+T does NOT trigger', () => {
      // Simulate with alt=true, key='t'
      // Verify NOT intercepted
    })
  })

  describe('Renderer IPC listener', () => {
    test('IPC callback triggers session creation', () => {
      // Mock window.systemOps.onNewSessionShortcut
      // Mock useWorktreeStore with selectedWorktreeId
      // Trigger the callback
      // Verify createSession called
    })

    test('IPC callback shows error when no worktree selected', () => {
      // Mock useWorktreeStore with selectedWorktreeId = null
      // Trigger the callback
      // Verify toast.error called
    })

    test('cleanup function removes listener', () => {
      // Get cleanup function from useEffect
      // Call cleanup
      // Verify ipcRenderer.removeListener called
    })
  })

  describe('allowInInput', () => {
    test('session:new shortcut fires when textarea focused', () => {
      // Focus a textarea
      // Dispatch Cmd+T keydown
      // Verify handler called (allowInInput: true)
    })
  })
})
```

---

## Session 3: Adaptive Streaming Flush

### Objectives

- Replace the fixed 100ms `setTimeout` throttle with `requestAnimationFrame`-based flushing
- Ensure streamed text appears within one frame (~16ms) of arriving
- Maintain immediate flush behavior for tool card updates

### Tasks

#### 1. Replace `throttleRef` with `rafRef`

In `src/renderer/src/components/sessions/SessionView.tsx`, locate the throttle machinery (around lines 351, 448–464):

**Replace the ref declaration** (line ~351):

```typescript
// BEFORE:
const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

// AFTER:
const rafRef = useRef<number | null>(null)
```

**Replace `scheduleFlush`** (lines ~448–455):

```typescript
// BEFORE:
const scheduleFlush = useCallback(() => {
  if (throttleRef.current === null) {
    throttleRef.current = setTimeout(() => {
      throttleRef.current = null
      flushStreamingState()
    }, 100)
  }
}, [flushStreamingState])

// AFTER:
const scheduleFlush = useCallback(() => {
  if (rafRef.current === null) {
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      flushStreamingState()
    })
  }
}, [flushStreamingState])
```

**Replace `immediateFlush`** (lines ~458–464):

```typescript
// BEFORE:
const immediateFlush = useCallback(() => {
  if (throttleRef.current !== null) {
    clearTimeout(throttleRef.current)
    throttleRef.current = null
  }
  flushStreamingState()
}, [flushStreamingState])

// AFTER:
const immediateFlush = useCallback(() => {
  if (rafRef.current !== null) {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }
  flushStreamingState()
}, [flushStreamingState])
```

#### 2. Add rAF cleanup on unmount

Add a cleanup `useEffect` near the other effect hooks:

```typescript
useEffect(() => {
  return () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
    }
  }
}, [])
```

#### 3. Verify existing callers are unchanged

Confirm these callers still work correctly without modification:

- `appendTextDelta` (line ~489) calls `scheduleFlush()` — works the same, just faster
- Tool event handlers (lines ~538+) call `immediateFlush()` — works the same, now cancels rAF instead of timeout
- `message.updated` completion (line ~773) calls `immediateFlush()` — works the same
- `session.idle` handler (line ~778) calls `immediateFlush()` — works the same

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — throttle → rAF replacement

### Definition of Done

- [ ] `throttleRef` replaced with `rafRef` throughout `SessionView.tsx`
- [ ] `scheduleFlush` uses `requestAnimationFrame` instead of `setTimeout(100)`
- [ ] `immediateFlush` uses `cancelAnimationFrame` instead of `clearTimeout`
- [ ] Cleanup `useEffect` cancels pending rAF on component unmount
- [ ] Streamed text appears within one frame (~16ms) of arriving — no 100ms delay
- [ ] Text streaming looks smooth and continuous (no visible 100ms chunking)
- [ ] Tool card updates still appear immediately via `immediateFlush`
- [ ] Stream completion (`message.updated`) still flushes immediately
- [ ] `session.idle` still flushes immediately
- [ ] No memory leaks (rAF properly canceled on unmount)
- [ ] No `setTimeout` or `clearTimeout` references remain in the streaming machinery
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start the app, open a session, send a message to the AI
2. Watch the streaming text appear — it should flow smoothly without visible "jumps" every 100ms
3. With a fast model (e.g., Haiku), verify text appears nearly character-by-character at frame rate
4. With a slow model (e.g., Opus), verify behavior is unchanged (just less frequent updates)
5. During streaming, verify tool cards (Read, Edit, Bash, etc.) still appear instantly when emitted
6. Verify stream completion still works — final message loads from DB correctly
7. Switch sessions mid-stream → verify no errors or leaked rAF callbacks

### Testing Criteria

```typescript
// test/phase-8/session-3/adaptive-flush.test.ts
describe('Session 3: Adaptive Streaming Flush', () => {
  describe('scheduleFlush', () => {
    test('uses requestAnimationFrame not setTimeout', () => {
      // Spy on requestAnimationFrame
      // Call scheduleFlush
      // Verify requestAnimationFrame called
      // Verify setTimeout NOT called
    })

    test('batches multiple calls within same frame', () => {
      // Call scheduleFlush 5 times rapidly
      // Verify requestAnimationFrame called only once
      // Verify flushStreamingState called only once after frame
    })

    test('flushes streaming state on animation frame', () => {
      // Call scheduleFlush
      // Fire the rAF callback
      // Verify flushStreamingState called
      // Verify rafRef reset to null
    })
  })

  describe('immediateFlush', () => {
    test('cancels pending rAF', () => {
      // Schedule a flush (sets rafRef)
      // Call immediateFlush
      // Verify cancelAnimationFrame called
      // Verify flushStreamingState called synchronously
    })

    test('works when no pending rAF', () => {
      // rafRef is null
      // Call immediateFlush
      // Verify flushStreamingState called
      // Verify cancelAnimationFrame NOT called
    })
  })

  describe('cleanup', () => {
    test('cancels pending rAF on unmount', () => {
      // Schedule a flush
      // Unmount the component
      // Verify cancelAnimationFrame called
    })

    test('no error when unmounting with no pending rAF', () => {
      // rafRef is null
      // Unmount
      // Verify no error
    })
  })

  describe('streaming behavior', () => {
    test('appendTextDelta triggers scheduleFlush', () => {
      // Call appendTextDelta with a text delta
      // Verify scheduleFlush called (which uses rAF)
    })

    test('tool events trigger immediateFlush', () => {
      // Simulate a tool_use event
      // Verify immediateFlush called (not scheduleFlush)
    })
  })
})
```

---

## Session 4: Smart Auto-Scroll — Scroll Position Tracking

### Objectives

- Add scroll position detection to the message list container
- Track whether the user has scrolled up away from the bottom
- Make auto-scroll conditional — only scroll to bottom when the user is near the bottom
- Force-resume auto-scroll when the user sends a new message

### Tasks

#### 1. Add scroll container ref

In `src/renderer/src/components/sessions/SessionView.tsx`, add a ref for the scroll container:

```typescript
const scrollContainerRef = useRef<HTMLDivElement>(null)
```

Attach it to the message list container div (the `<div className="flex-1 overflow-y-auto">` around line 1228):

```typescript
<div
  ref={scrollContainerRef}
  className="flex-1 overflow-y-auto"
  onScroll={handleScroll}
>
```

#### 2. Add auto-scroll tracking state

```typescript
const isAutoScrollEnabledRef = useRef(true)
const [showScrollFab, setShowScrollFab] = useState(false)
```

Use a `useRef` for `isAutoScrollEnabled` (not state) because:

- `onScroll` fires very frequently during streaming (every rAF flush triggers a scroll)
- Using state would cause unnecessary re-renders
- The auto-scroll `useEffect` reads the ref synchronously — no stale closure issue

#### 3. Implement `handleScroll` callback

```typescript
const handleScroll = useCallback(() => {
  const el = scrollContainerRef.current
  if (!el) return

  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  const isNearBottom = distanceFromBottom < 80

  if (isNearBottom) {
    isAutoScrollEnabledRef.current = true
    setShowScrollFab(false)
  } else {
    // Only show FAB and disable auto-scroll if we're actively streaming
    // or have just finished streaming (isSending covers both)
    if (isSending || isStreaming) {
      isAutoScrollEnabledRef.current = false
      setShowScrollFab(true)
    }
  }
}, [isSending, isStreaming])
```

The 80px threshold accounts for:

- Small rendering differences between browsers
- The sentinel div height
- A margin of error so the user doesn't have to be pixel-perfect at the bottom

#### 4. Replace unconditional scroll `useEffect`

```typescript
// BEFORE (lines 401-403):
useEffect(() => {
  scrollToBottom()
}, [messages, streamingContent, streamingParts, scrollToBottom])

// AFTER:
useEffect(() => {
  if (isAutoScrollEnabledRef.current) {
    scrollToBottom()
  }
}, [messages, streamingContent, streamingParts, scrollToBottom])
```

#### 5. Force-resume auto-scroll on send

In the `handleSend` function (around line 1013), add before the prompt is sent:

```typescript
// User just sent a message — they want to see the response
isAutoScrollEnabledRef.current = true
setShowScrollFab(false)
```

#### 6. Handle FAB click

```typescript
const handleScrollToBottomClick = useCallback(() => {
  isAutoScrollEnabledRef.current = true
  setShowScrollFab(false)
  scrollToBottom()
}, [scrollToBottom])
```

#### 7. Reset auto-scroll state on session switch

When the active session changes, reset to auto-scroll enabled:

```typescript
useEffect(() => {
  isAutoScrollEnabledRef.current = true
  setShowScrollFab(false)
}, [sessionId])
```

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — scroll tracking, conditional auto-scroll, FAB state

### Definition of Done

- [ ] Scroll container has `ref` and `onScroll` handler attached
- [ ] `isAutoScrollEnabledRef` tracks whether auto-scroll is active
- [ ] Scrolling up more than 80px from bottom during streaming disables auto-scroll
- [ ] Scrolling back within 80px of bottom re-enables auto-scroll
- [ ] `showScrollFab` state is `true` when auto-scroll is paused during/after streaming
- [ ] Auto-scroll `useEffect` checks `isAutoScrollEnabledRef` before scrolling
- [ ] `handleSend` force-resumes auto-scroll
- [ ] Session switch resets auto-scroll to enabled
- [ ] `handleScrollToBottomClick` re-enables auto-scroll and scrolls to bottom
- [ ] No re-render loops from the `onScroll` handler (ref-based tracking)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start the app, open a session, send a long prompt that generates a multi-paragraph response
2. While the AI is streaming, scroll up — verify the viewport stays where you scrolled (no snapping to bottom)
3. Continue scrolling while streaming continues — verify viewport remains stable
4. Scroll back down to the bottom — verify auto-scroll resumes (new content pushes scroll down)
5. Send a new message — verify auto-scroll resumes immediately (viewport follows the new response)
6. Switch to a different session and back — verify auto-scroll is reset to enabled

### Testing Criteria

```typescript
// test/phase-8/session-4/smart-auto-scroll.test.ts
describe('Session 4: Smart Auto-Scroll', () => {
  describe('handleScroll', () => {
    test('near bottom enables auto-scroll', () => {
      // Set scrollHeight=1000, scrollTop=920, clientHeight=80 (distance=0)
      // Call handleScroll
      // Verify isAutoScrollEnabledRef.current === true
      // Verify showScrollFab === false
    })

    test('scrolled up during streaming disables auto-scroll', () => {
      // Set scrollHeight=1000, scrollTop=500, clientHeight=80 (distance=420)
      // isStreaming=true
      // Call handleScroll
      // Verify isAutoScrollEnabledRef.current === false
      // Verify showScrollFab === true
    })

    test('scrolled up when NOT streaming does NOT show FAB', () => {
      // Set scrollHeight=1000, scrollTop=500, clientHeight=80
      // isStreaming=false, isSending=false
      // Call handleScroll
      // Verify showScrollFab === false
    })

    test('80px threshold respected', () => {
      // Distance = 79px → isNearBottom = true
      // Distance = 81px → isNearBottom = false
    })
  })

  describe('conditional auto-scroll', () => {
    test('scrollToBottom called when auto-scroll enabled', () => {
      // isAutoScrollEnabledRef.current = true
      // Trigger useEffect (new streaming content)
      // Verify scrollToBottom called
    })

    test('scrollToBottom NOT called when auto-scroll disabled', () => {
      // isAutoScrollEnabledRef.current = false
      // Trigger useEffect (new streaming content)
      // Verify scrollToBottom NOT called
    })
  })

  describe('handleSend force-resume', () => {
    test('sending a message re-enables auto-scroll', () => {
      // isAutoScrollEnabledRef.current = false (user scrolled up)
      // Call handleSend
      // Verify isAutoScrollEnabledRef.current === true
      // Verify showScrollFab === false
    })
  })

  describe('session switch reset', () => {
    test('auto-scroll reset on session change', () => {
      // isAutoScrollEnabledRef.current = false
      // Change sessionId prop
      // Verify isAutoScrollEnabledRef.current === true
      // Verify showScrollFab === false
    })
  })

  describe('handleScrollToBottomClick', () => {
    test('re-enables auto-scroll and scrolls', () => {
      // isAutoScrollEnabledRef.current = false
      // Call handleScrollToBottomClick
      // Verify isAutoScrollEnabledRef.current === true
      // Verify showScrollFab === false
      // Verify scrollToBottom called
    })
  })
})
```

---

## Session 5: Scroll-to-Bottom FAB Component

### Objectives

- Create the `ScrollToBottomFab` component with fade animation
- Render it inside the scroll container with absolute positioning
- Wire it to the scroll tracking state from Session 4

### Tasks

#### 1. Create `ScrollToBottomFab.tsx`

Create `src/renderer/src/components/sessions/ScrollToBottomFab.tsx`:

```typescript
import { ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ScrollToBottomFabProps {
  onClick: () => void
  visible: boolean
}

export function ScrollToBottomFab({
  onClick,
  visible
}: ScrollToBottomFabProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'absolute bottom-4 right-4 z-10',
        'h-8 w-8 rounded-full',
        'bg-muted/80 backdrop-blur-sm border border-border',
        'flex items-center justify-center',
        'shadow-md hover:bg-muted transition-all duration-200',
        'cursor-pointer',
        visible
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 translate-y-2 pointer-events-none'
      )}
      aria-label="Scroll to bottom"
      data-testid="scroll-to-bottom-fab"
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  )
}
```

Key design decisions:

- `absolute` positioning within the scroll container (container needs `relative`)
- `backdrop-blur-sm` for a frosted glass effect over content
- `transition-all duration-200` for smooth show/hide
- `pointer-events-none` when hidden to prevent blocking clicks on content underneath
- `translate-y-2` when hidden for a subtle slide-up animation on appear

#### 2. Render FAB in SessionView

In `src/renderer/src/components/sessions/SessionView.tsx`, wrap the scroll container in a `relative` positioned div (or add `relative` to the existing container):

```typescript
<div className="relative flex-1">
  <div
    ref={scrollContainerRef}
    className="absolute inset-0 overflow-y-auto"
    onScroll={handleScroll}
  >
    {/* ... message list ... */}
    <div ref={messagesEndRef} />
  </div>
  <ScrollToBottomFab
    onClick={handleScrollToBottomClick}
    visible={showScrollFab}
  />
</div>
```

Note: The scroll container may need restructuring. The current layout uses `flex-1 overflow-y-auto` directly. Wrapping in a `relative` div with `absolute inset-0` child preserves the flex sizing while allowing absolute positioning of the FAB.

Alternatively, if the scroll container already has or can receive `relative` class:

```typescript
<div
  ref={scrollContainerRef}
  className="flex-1 overflow-y-auto relative"
  onScroll={handleScroll}
>
  {/* ... message list ... */}
  <div ref={messagesEndRef} />
  <ScrollToBottomFab
    onClick={handleScrollToBottomClick}
    visible={showScrollFab}
  />
</div>
```

But this would make the FAB scroll with the content. The FAB needs to be `sticky` or in a sibling wrapper. Evaluate the actual DOM structure and pick the approach that keeps the FAB fixed at the bottom-right of the visible viewport.

The safest approach is the wrapper pattern:

```typescript
<div className="relative flex-1 min-h-0">
  <div
    ref={scrollContainerRef}
    className="h-full overflow-y-auto"
    onScroll={handleScroll}
  >
    {/* messages */}
  </div>
  <ScrollToBottomFab
    onClick={handleScrollToBottomClick}
    visible={showScrollFab}
  />
</div>
```

`min-h-0` prevents the flex child from overflowing. The FAB is positioned absolute within the wrapper, outside the scroll container, so it stays fixed.

#### 3. Import ScrollToBottomFab

```typescript
import { ScrollToBottomFab } from './ScrollToBottomFab'
```

### Key Files

- `src/renderer/src/components/sessions/ScrollToBottomFab.tsx` — **NEW**
- `src/renderer/src/components/sessions/SessionView.tsx` — render FAB, layout adjustments

### Definition of Done

- [ ] `ScrollToBottomFab.tsx` created with proper styling and props
- [ ] FAB renders at bottom-right of the message area
- [ ] FAB is visible (opacity-100) when `showScrollFab` is true
- [ ] FAB is hidden (opacity-0, pointer-events-none) when `showScrollFab` is false
- [ ] FAB has a 200ms fade transition for show/hide
- [ ] FAB does not scroll with the content — stays fixed in the viewport
- [ ] Clicking FAB triggers `handleScrollToBottomClick` (scrolls to bottom + resumes auto-scroll)
- [ ] FAB does not obscure important content (bottom-right corner with proper z-index)
- [ ] FAB has hover state (bg-muted → slightly more opaque)
- [ ] Layout of the message area is unchanged (no visual regressions)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start the app, open a session, send a prompt
2. While streaming, scroll up — verify the FAB appears at the bottom-right with a fade-in animation
3. Verify the FAB has a down-arrow icon and semi-transparent background
4. Hover over the FAB — verify hover state (slightly darker)
5. Click the FAB — verify:
   - Viewport scrolls smoothly to the bottom
   - FAB fades out
   - Auto-scroll resumes (new streaming content pushes viewport down)
6. Scroll up again, then manually scroll all the way to the bottom — verify FAB disappears
7. Verify the FAB does not appear when just browsing static message history (no active streaming)
8. Verify the FAB does not block clicking on content underneath when hidden

### Testing Criteria

```typescript
// test/phase-8/session-5/scroll-fab.test.ts
describe('Session 5: ScrollToBottomFab', () => {
  describe('ScrollToBottomFab component', () => {
    test('renders with ArrowDown icon', () => {
      // Render ScrollToBottomFab with visible=true
      // Verify button element with aria-label="Scroll to bottom"
      // Verify ArrowDown icon present
    })

    test('visible when visible=true', () => {
      // Render with visible=true
      // Verify opacity-100 class present
      // Verify pointer-events-none NOT present
    })

    test('hidden when visible=false', () => {
      // Render with visible=false
      // Verify opacity-0 class present
      // Verify pointer-events-none present
    })

    test('calls onClick when clicked', () => {
      // Render with visible=true
      // Click the button
      // Verify onClick called
    })

    test('not clickable when hidden', () => {
      // Render with visible=false
      // Attempt to click
      // Verify onClick NOT called (pointer-events-none)
    })
  })

  describe('FAB integration in SessionView', () => {
    test('FAB rendered in message area', () => {
      // Render SessionView
      // Verify scroll-to-bottom-fab element exists in DOM
    })

    test('FAB hidden by default', () => {
      // Render SessionView (initial state)
      // Verify FAB has opacity-0
    })

    test('FAB appears when user scrolls up during streaming', () => {
      // Set isStreaming=true
      // Simulate scroll event with distance > 80px from bottom
      // Verify FAB has opacity-100
    })

    test('FAB disappears when user scrolls to bottom', () => {
      // FAB is visible
      // Simulate scroll to bottom (distance < 80px)
      // Verify FAB has opacity-0
    })

    test('FAB click scrolls to bottom and hides FAB', () => {
      // FAB is visible
      // Click FAB
      // Verify scrollToBottom called
      // Verify FAB hidden
    })

    test('FAB position is fixed (does not scroll with content)', () => {
      // Verify FAB parent has position: relative
      // Verify FAB has position: absolute
      // Verify FAB is outside the scroll container
    })
  })
})
```

---

## Session 6: Integration & Verification

### Objectives

- Verify all Phase 8 features work correctly together
- Test cross-feature interactions
- Run lint and tests
- Fix any edge cases or regressions

### Tasks

#### 1. Echo Fix + Streaming Flush interaction

- Send a message → verify no echo during streaming (rAF flush doesn't introduce echo timing issues)
- Send multiple rapid messages → verify no echo accumulation
- Verify `finalizeResponseFromDatabase` loads clean messages after rAF-based streaming

#### 2. Auto-Scroll + Streaming Flush interaction

- During streaming with rAF flush, scroll up → verify auto-scroll pauses (FAB appears)
- With faster flushing (~16ms), verify `onScroll` handler doesn't cause performance issues (no jank)
- Verify the auto-scroll `useEffect` fires correctly with rAF-speed state updates

#### 3. Cmd+T + Auto-Scroll interaction

- While auto-scroll is paused (FAB visible), press Cmd+T → verify new session created
- Verify the new session starts with auto-scroll enabled
- Verify Cmd+T works while the FAB is visible

#### 4. Echo Fix + Cmd+T interaction

- Create a new session via Cmd+T, send a message immediately → verify no echo
- Rapidly create sessions and send messages → verify message integrity across all sessions

#### 5. Edge cases

- Send a message and immediately scroll up before any response arrives → verify FAB appears once streaming starts
- Send a message, scroll up, then send another message (queued) → verify auto-scroll resumes for the new message
- Switch sessions mid-stream → verify no leaked rAF callbacks, no scroll state bleed
- Close a session tab during streaming → verify cleanup (rAF canceled, no errors)
- Very long response (10,000+ tokens) → verify scroll and rAF performance remain smooth
- Empty session (no messages) → verify no FAB, no scroll issues

#### 6. Run lint and tests

```bash
pnpm lint
pnpm test
```

Fix any failures.

#### 7. Manual smoke test

Run through the full happy path:

1. Open app → select worktree → Cmd+T to create session → send message → verify smooth streaming → scroll up → FAB appears → click FAB → auto-scroll resumes → response completes → verify no echoes in history

### Key Files

- All files modified in sessions 1–5
- Focus on cross-cutting concerns between the four features

### Definition of Done

- [ ] All 4 features from sessions 1–5 work correctly in isolation
- [ ] Cross-feature interactions work correctly (echo fix + flush, scroll + flush, Cmd+T + scroll, etc.)
- [ ] No regressions in Phase 7 features
- [ ] No console errors during normal operation
- [ ] No leaked rAF callbacks or timers
- [ ] Performance remains smooth with rAF-speed updates + scroll tracking
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Full happy path smoke test passes

### How to Test

Run through each integration scenario listed in Tasks above. Focus on timing-sensitive interactions — the rAF flush, scroll events, and IPC forwarding all involve async timing that could interact unexpectedly.

### Testing Criteria

```typescript
// test/phase-8/session-6/integration-verification.test.ts
describe('Session 6: Integration & Verification', () => {
  test('streaming with rAF produces no echoes', () => {
    // Send message, stream response via rAF flush
    // Verify messages array has exactly 1 user + 1 assistant
  })

  test('scroll tracking works with rAF-speed updates', () => {
    // Stream content at rAF speed
    // Scroll up mid-stream
    // Verify auto-scroll paused, FAB visible
    // Verify no performance degradation
  })

  test('Cmd+T works during active streaming', () => {
    // Start streaming in session-A
    // Press Cmd+T
    // Verify new session-B created
    // Verify session-A streaming continues
  })

  test('new session from Cmd+T starts with auto-scroll enabled', () => {
    // Pause auto-scroll in session-A (scroll up)
    // Cmd+T to create session-B
    // Switch to session-B
    // Verify auto-scroll enabled in session-B
  })

  test('rapid message sending produces no echoes', () => {
    // Send 5 messages in rapid succession
    // Wait for all responses
    // Verify exactly 5 user + 5 assistant messages
  })

  test('session switch during streaming cleans up properly', () => {
    // Start streaming in session-A
    // Switch to session-B
    // Verify no errors, no leaked callbacks
    // Switch back to session-A
    // Verify messages loaded from DB correctly
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
Session 1 (Echo Fix)              ── independent, no UI changes
Session 2 (Cmd+T Fix)            ── independent, main+preload+renderer
Session 3 (Adaptive Flush)       ── independent, SessionView only
    |
    └──► Session 4 (Scroll Tracking)   ── depends on Session 3 (same file, flush affects scroll timing)
              |
              └──► Session 5 (Scroll FAB)  ── depends on Session 4 (needs scroll state)
                        |
Session 6 (Integration)          ── requires sessions 1-5
```

### Parallel Tracks

Sessions 1, 2, and 3 are fully independent and can run in parallel:

- **Track A**: Session 1 — Main process only (`opencode-service.ts`)
- **Track B**: Session 2 — Main + preload + renderer (`index.ts`, `index.d.ts`, `useKeyboardShortcuts.ts`)
- **Track C**: Session 3 — Renderer only (`SessionView.tsx` — throttle replacement)

Sessions 4 and 5 must run sequentially after Session 3 (they build on the same file and depend on the flush timing).

```
┌──────────────────────────────────────────────────┐
│  Time →                                           │
│                                                   │
│  Track A: [Session 1: Echo Fix      ]             │
│  Track B: [Session 2: Cmd+T Fix    ]              │
│  Track C: [Session 3: Flush] → [Session 4: Scroll] → [Session 5: FAB]  │
│                                                   │
│  All ───────────────────────────► [Session 6: Integration]  │
└──────────────────────────────────────────────────┘
```

**Minimum critical path**: Session 3 → Session 4 → Session 5 → Session 6

**Maximum parallelism**: Sessions 1, 2, 3 all in parallel. Sessions 4, 5 sequential after 3.

Session 6 requires all previous sessions complete.

---

## Notes

### Assumed Phase 7 Infrastructure

- Project filter with subsequence matching
- Branch duplication with versioning
- Code review button
- Inline diff viewer
- Pulse animation for running worktrees
- Auto-focus session textarea
- Clear button in run pane
- Model variant selection with Alt+T

### Out of Scope (Phase 8)

Per PRD Phase 8:

- Scroll position persistence across session switches
- Unread message count on the scroll FAB
- Scroll-to-top button
- Per-message scroll anchoring
- Typewriter / character animation effects
- Configurable flush interval settings
- Retroactive database cleanup of echoed messages
- Cmd+T interception for other Chromium-consumed shortcuts
- Customizable keybinding for new session

### Performance Targets

| Operation                        | Target                       |
| -------------------------------- | ---------------------------- |
| Scroll position check (onScroll) | < 1ms                        |
| Auto-scroll suppression          | Immediate (next flush cycle) |
| FAB show/hide transition         | 200ms CSS                    |
| Streaming text flush latency     | ≤ 16.6ms (1 frame)           |
| Text delta to screen             | ≤ 1 frame after arrival      |
| Role guard evaluation            | < 0.1ms per event            |
| Cmd+T interception → IPC         | < 5ms                        |
| New session from Cmd+T           | < 500ms end-to-end           |

### Key Architecture Decisions

1. **Role guard inversion (`!== 'assistant'` instead of `=== 'user'`)**: Fail-safe — if role extraction fails, the event is dropped rather than persisted as the wrong role. Defense-in-depth: renderer-side guards remain as a second layer.
2. **`requestAnimationFrame` instead of reduced timeout**: rAF is purpose-built for visual updates. It's frame-synced, auto-paused in background tabs, and naturally batches multiple calls per frame. `setTimeout(16)` would be a poor imitation subject to timer throttling.
3. **`useRef` for auto-scroll tracking (not state)**: `onScroll` fires at frame rate during streaming. Using state would trigger re-renders on every scroll event. A ref is read synchronously by the auto-scroll `useEffect` without causing renders.
4. **`before-input-event` for Cmd+T (not `globalShortcut`)**: `before-input-event` fires in the context of the specific BrowserWindow, before Chromium's built-in handlers. `globalShortcut` is system-wide and would intercept Cmd+T in all apps. `before-input-event` is scoped correctly.
5. **80px scroll threshold**: Accounts for rendering variance, sentinel div height, and provides a comfortable buffer. Too small (e.g., 10px) would cause flickering between paused/resumed states. Too large (e.g., 200px) would prevent auto-scroll from resuming until the user is very close to the bottom.
6. **FAB outside scroll container**: Positioned in a sibling wrapper with `position: absolute`. If placed inside the scroll container, it would scroll with the content. The wrapper pattern keeps it fixed relative to the viewport area.
