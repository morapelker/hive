# Hive — Phase 8 Product Requirements Document

## Overview

**Phase 8** focuses on **streaming UX quality, message integrity, and keyboard shortcut reliability**. The primary work includes replacing the unconditional auto-scroll with a smart scroll system that respects user scroll position during streaming, eliminating artificial animation delays so content appears as fast as the model produces it, fixing a persistence bug where user messages are echoed back as assistant messages, and ensuring Cmd+T reliably opens a new session tab on macOS.

### Phase 8 Goals

- Allow users to scroll freely during streaming without being snapped to the bottom
- Show a floating action button to resume auto-scroll / jump to bottom
- Remove the fixed 100ms throttle on streaming text updates so content appears at native frame rate
- Fix the bug where user messages are persisted as assistant messages due to role extraction failure
- Make Cmd+T (macOS) reliably create a new session tab, including when the chat input is focused

---

## Technical Additions

| Component                | Technology                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Smart Auto-Scroll        | `onScroll` event handler, scroll position tracking, `IntersectionObserver` or manual threshold check |
| Scroll-to-Bottom FAB     | React component, CSS transition for show/hide, `scrollIntoView` on click                             |
| Adaptive Streaming Flush | `requestAnimationFrame` replacing `setTimeout(100)`, ref-based backlog detection                     |
| Message Echo Fix         | Role guard inversion in `persistStreamEvent`, defensive `extractEventMessageRole`                    |
| Cmd+T Shortcut Fix       | Electron `before-input-event` interception on `webContents`, IPC forwarding to renderer              |

---

## Features

### 1. Smart Auto-Scroll (Scroll Freedom During Streaming)

#### 1.1 Current State

- `SessionView.tsx` has a `scrollToBottom` function (line 397) that calls `messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })`
- A `useEffect` (lines 401–403) fires `scrollToBottom()` on **every** change to `messages`, `streamingContent`, or `streamingParts`
- During streaming, the 100ms throttled flush triggers state updates ~10 times/second, each of which fires the scroll effect
- There is **no** user-scroll detection — the scroll is unconditional
- There is **no** scroll-to-bottom button or FAB anywhere in the codebase
- The scroll container is `<div className="flex-1 overflow-y-auto">` (line 1228)
- A sentinel `<div ref={messagesEndRef} />` (line 1281) sits at the bottom of the message list as the scroll target

This means: if a user scrolls up to read an earlier message while the model is streaming, every new text chunk snaps them back to the bottom. The chat is effectively unreadable during active streaming.

#### 1.2 New Design

Introduce a **user-scroll-aware auto-scroll system** with three states:

```
┌─────────────────────────────────────────────┐
│  State Machine:                              │
│                                              │
│  AUTO_SCROLL ──(user scrolls up)──► PAUSED   │
│       ▲                                │     │
│       │                                │     │
│       └──(click FAB)───────────────────┘     │
│       └──(manual scroll to bottom)─────┘     │
└─────────────────────────────────────────────┘
```

**Auto-Scroll (default)**: New content triggers `scrollToBottom()`. This is the current behavior — appropriate when the user is reading the latest output.

**Paused**: The user has scrolled up (scroll position is more than ~80px from the bottom). Auto-scroll is suppressed. A floating action button appears at the bottom-right of the message area.

**Resume**: Auto-scroll resumes when either:

- The user clicks the FAB (scrolls to bottom + re-enables auto-scroll)
- The user manually scrolls back to the bottom (within ~80px threshold)

```
Message area with FAB:
┌──────────────────────────────────────────────┐
│  User: How do I implement auth?               │
│                                               │
│  Assistant: Here's a step-by-step approach... │
│  1. First, set up the middleware...           │
│  2. Then create the auth routes...            │  ← user is reading here
│                                               │
│                                               │
│                                         ┌──┐  │
│                                         │ ▼│  │  ← FAB (scroll to bottom)
│                                         └──┘  │
└──────────────────────────────────────────────┘

FAB details:
┌────┐
│ ▼  │   Semi-transparent, rounded, fixed to bottom-right of scroll container
│    │   Appears with a fade-in transition when user scrolls up during streaming
└────┘   Disappears when auto-scroll resumes or streaming ends and user is at bottom
```

#### 1.3 Implementation

**Scroll Position Tracking**:

Add an `onScroll` handler to the scroll container that computes proximity to bottom:

```typescript
const scrollContainerRef = useRef<HTMLDivElement>(null)
const isAutoScrollEnabledRef = useRef(true)
const [showScrollFab, setShowScrollFab] = useState(false)

const handleScroll = useCallback(() => {
  const el = scrollContainerRef.current
  if (!el) return

  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  const isNearBottom = distanceFromBottom < 80

  if (isNearBottom) {
    // User scrolled back to bottom — resume auto-scroll
    isAutoScrollEnabledRef.current = true
    setShowScrollFab(false)
  } else if (isStreaming || isSending) {
    // User scrolled up during active streaming — pause auto-scroll
    isAutoScrollEnabledRef.current = false
    setShowScrollFab(true)
  }
}, [isStreaming, isSending])
```

**Conditional Auto-Scroll**:

Replace the unconditional `useEffect` with one that checks the flag:

```typescript
useEffect(() => {
  if (isAutoScrollEnabledRef.current) {
    scrollToBottom()
  }
}, [messages, streamingContent, streamingParts, scrollToBottom])
```

**FAB Click Handler**:

```typescript
const handleScrollToBottomClick = useCallback(() => {
  isAutoScrollEnabledRef.current = true
  setShowScrollFab(false)
  scrollToBottom()
}, [scrollToBottom])
```

**Edge Cases**:

- When streaming ends (`isSending` becomes false) and user is not at bottom, keep the FAB visible until they scroll down or click it
- When a new user message is sent (`handleSend`), force-resume auto-scroll (the user just interacted, they want to see the response)
- The FAB should only appear during or after streaming — never during normal static browsing of message history
- Use a `useRef` (not state) for `isAutoScrollEnabled` to avoid re-render loops since `onScroll` fires frequently

**ScrollToBottomFab Component**:

```typescript
function ScrollToBottomFab({ onClick, visible }: { onClick: () => void; visible: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'absolute bottom-4 right-4 z-10',
        'h-8 w-8 rounded-full',
        'bg-muted/80 backdrop-blur-sm border border-border',
        'flex items-center justify-center',
        'shadow-md hover:bg-muted transition-all duration-200',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
      )}
      aria-label="Scroll to bottom"
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  )
}
```

#### 1.4 Files to Modify/Create

| File                                                         | Change                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx`       | Add `scrollContainerRef`, `isAutoScrollEnabledRef`, `showScrollFab` state, `handleScroll` callback; replace unconditional scroll `useEffect` with conditional version; attach `onScroll` to scroll container div; render `ScrollToBottomFab`; force-resume auto-scroll in `handleSend` |
| `src/renderer/src/components/sessions/ScrollToBottomFab.tsx` | **NEW** — Floating action button with arrow-down icon, fade transition, click handler                                                                                                                                                                                                  |

---

### 2. Adaptive Streaming Flush (Eliminate Animation Lag)

#### 2.1 Current State

- `SessionView.tsx` uses a dual ref/state pattern for streaming: incoming text deltas write to `streamingPartsRef` and `streamingContentRef` (refs, no re-render), then a `setTimeout` of 100ms batches these into React state via `flushStreamingState()` (lines 442–455)
- The `scheduleFlush` function (line 448) sets a 100ms timer. If the timer is already running, new deltas are silently batched until it fires
- Tool updates bypass the throttle using `immediateFlush()` (line 458) which clears the pending timer and flushes synchronously
- `MarkdownRenderer.tsx` renders content via `react-markdown` with no character-level animation — the streaming "appearance" is entirely due to the 100ms batched state updates
- `StreamingCursor.tsx` shows a CSS `animate-pulse` block cursor inline after the latest text
- There is no typewriter or character-by-character animation

The 100ms fixed delay means:

- If the model streams 500 characters in 50ms, the user waits 100ms before seeing any of them
- The content appears in visible "jumps" — chunks of text popping in every 100ms
- If the model is streaming faster than 10 updates/second, the user sees artificial lag
- The delay is especially noticeable for fast models (Haiku, GPT-4o-mini) where tokens arrive rapidly

#### 2.2 New Design

Replace the fixed 100ms `setTimeout` with a **`requestAnimationFrame`-based flush** that syncs text updates with the browser's paint cycle (~16.6ms at 60fps). This ensures:

1. Content appears within one frame of arriving (no artificial delay)
2. Multiple deltas arriving within the same frame are naturally batched by rAF (one flush per frame)
3. The browser controls the timing, preventing layout thrashing
4. Fast models show smooth, near-real-time text flow
5. Slow models behave identically to before (deltas just arrive less frequently)

The streaming cursor (`StreamingCursor.tsx`) and "Streaming..." label in `AssistantCanvas.tsx` remain unchanged — they already work correctly with any flush frequency.

#### 2.3 Implementation

Replace `scheduleFlush` and its `setTimeout` with `requestAnimationFrame`:

```typescript
const rafRef = useRef<number | null>(null)

const scheduleFlush = useCallback(() => {
  if (rafRef.current === null) {
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      flushStreamingState()
    })
  }
}, [flushStreamingState])

// Update immediateFlush to cancel rAF instead of clearTimeout
const immediateFlush = useCallback(() => {
  if (rafRef.current !== null) {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }
  flushStreamingState()
}, [flushStreamingState])
```

**Cleanup**: Cancel any pending rAF on unmount:

```typescript
useEffect(() => {
  return () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
    }
  }
}, [])
```

**Why rAF over reducing the timeout**:

- `setTimeout(16)` is not equivalent — it's subject to timer throttling (browsers clamp to 4ms minimum, may throttle to 1000ms in background tabs)
- `requestAnimationFrame` is specifically designed for visual updates: it fires once per frame, is automatically paused in background tabs (saving CPU), and is perfectly synchronized with the browser's compositor
- Multiple `scheduleFlush` calls within the same frame result in exactly one flush — natural batching without explicit timer management

#### 2.4 Files to Modify/Create

| File                                                   | Change                                                                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Replace `throttleRef` (`setTimeout`) with `rafRef` (`requestAnimationFrame`) in `scheduleFlush`; update `immediateFlush` to use `cancelAnimationFrame`; add cleanup `useEffect` for rAF on unmount |

---

### 3. Fix User Message Echo

#### 3.1 Current State

- When a user sends a message, `SessionView.tsx` (lines 1032–1040) saves it to the database with `role: 'user'` via `window.db.message.create()` and immediately adds it to the local `messages` state
- The prompt is then sent to the OpenCode SDK, which streams back events including **echoed user messages** — the SDK confirms receipt by re-emitting the user's prompt as `message.part.updated` and `message.updated` events with `role: 'user'`
- The renderer correctly skips these echoes at lines 647 (`if (eventRole === 'user') return`) and 745 (`if (eventRole === 'user') return`)
- However, the main process `persistStreamEvent` in `opencode-service.ts` has a **parallel persistence path** that processes every stream event
- `extractEventMessageRole()` (lines 177–186) checks multiple paths in the event payload for the role field: `eventData?.message?.role`, `eventData?.info?.role`, `eventData?.part?.role`, etc.
- If none of these paths contain the role (SDK payload structure varies), the function returns `undefined`

**The bug**: When `extractEventMessageRole()` returns `undefined`:

1. **`message.part.updated` handler** (line 250): `if (role === 'user') return` — does NOT return (`undefined !== 'user'`). The event proceeds to be persisted with **hardcoded `role: 'assistant'`** (line 270).

2. **`message.updated` handler** (line 280): `if (role === 'user') return` — does NOT return. Then `if (role && role !== 'assistant') return` — does NOT return (`undefined` is falsy, short-circuits). The event proceeds to be persisted with **hardcoded `role: 'assistant'`** (line 300).

The result: the database gets two entries for the same user message:

- The original user message (`role: 'user'`, no `opencode_message_id`)
- A duplicate from the SDK echo (`role: 'assistant'`, with `opencode_message_id`)

When `finalizeResponseFromDatabase` (line 599) reloads all messages from the DB, the echo appears as an assistant message that repeats the user's input.

#### 3.2 New Design

**Invert the guard logic**: Instead of skipping only when role is confirmed `'user'`, only persist when role is confirmed `'assistant'`. This safely handles the `undefined` case.

Additionally, make `extractEventMessageRole` more robust by checking additional paths that the OpenCode SDK may use.

#### 3.3 Implementation

**Guard Fix** in `persistStreamEvent`:

For `message.part.updated` (currently line 250):

```typescript
// BEFORE (vulnerable to undefined role):
if (role === 'user') return

// AFTER (safe — only persist confirmed assistant messages):
if (role !== 'assistant') return
```

For `message.updated` (currently lines 280–284):

```typescript
// BEFORE (vulnerable to undefined role):
if (role === 'user') return
if (!messageId) return
if (role && role !== 'assistant') return

// AFTER (safe — single clear guard):
if (role !== 'assistant') return
if (!messageId) return
```

**Enhanced Role Extraction** — extend `extractEventMessageRole` to check additional paths:

```typescript
function extractEventMessageRole(eventData: Record<string, unknown>): string | undefined {
  // Check all known SDK payload structures
  const paths = [
    eventData?.message?.role,
    eventData?.info?.role,
    eventData?.part?.role,
    eventData?.role,
    eventData?.properties?.message?.role,
    eventData?.properties?.info?.role,
    eventData?.properties?.part?.role,
    eventData?.properties?.role,
    // Additional paths for newer SDK versions
    eventData?.metadata?.role,
    eventData?.content?.role
  ]
  for (const val of paths) {
    if (typeof val === 'string') return val
  }
  return undefined
}
```

**Database Cleanup** (one-time): Existing echoed messages in the database should be cleaned up. Add a migration or startup routine that deletes assistant messages whose content exactly matches a preceding user message's content within the same session.

#### 3.4 Files to Modify/Create

| File                                    | Change                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/services/opencode-service.ts` | Invert role guards in `persistStreamEvent`: change `if (role === 'user') return` to `if (role !== 'assistant') return` for both `message.part.updated` and `message.updated` handlers; extend `extractEventMessageRole` with additional payload paths |

---

### 4. Fix Cmd+T New Session Shortcut

#### 4.1 Current State

- `keyboard-shortcuts.ts` (lines 38–44) defines `session:new` with `defaultBinding: { key: 't', modifiers: ['meta'] }`
- `eventMatchesBinding` (lines 229–245) treats `meta` and `ctrl` as interchangeable: `const hasCtrlOrMeta = event.ctrlKey || event.metaKey`
- So both Cmd+T and Ctrl+T should trigger the shortcut in the React layer
- The handler in `useKeyboardShortcuts.ts` (line 83) has `allowInInput: false`, meaning the shortcut does **not** fire when the user is focused on the session textarea or any input
- The global keydown listener is registered in capture phase (line 56): `document.addEventListener('keydown', handleKeyDown, true)`

**The problem**: On macOS, Chromium (which Electron uses) intercepts Cmd+T at the browser level to open a new tab **before** the keydown event reaches the DOM. Electron's `BrowserWindow` with a single-page app does not show a "new tab" (there's no tab bar), but the event is still consumed by Chromium's internal handler and never propagates to the React keydown listener. Ctrl+T does not have this Chromium interception, so it works.

Additionally, even if the event did reach React, `allowInInput: false` would prevent it from firing when the chat textarea is focused — which is where users spend most of their time.

#### 4.2 New Design

Intercept Cmd+T at the Electron level using `webContents.on('before-input-event')`, which fires **before** Chromium processes the keyboard event. This allows us to:

1. Prevent Chromium's default Cmd+T handling
2. Forward the shortcut to the renderer via IPC
3. Ensure it works regardless of input focus

```
Event flow (before fix):
  Cmd+T → Chromium intercepts → event consumed → React never sees it

Event flow (after fix):
  Cmd+T → before-input-event → preventDefault → IPC to renderer → session:new handler
```

Also change `allowInInput` to `true` for the `session:new` shortcut, since creating a new tab is a global operation that should work from anywhere.

#### 4.3 Implementation

**Main Process** (`src/main/index.ts`):

Register a `before-input-event` listener on the main window's webContents:

```typescript
mainWindow.webContents.on('before-input-event', (event, input) => {
  // Intercept Cmd+T (macOS) / Ctrl+T (Windows/Linux) before Chromium handles it
  if (
    input.key.toLowerCase() === 't' &&
    (input.meta || input.control) &&
    !input.alt &&
    !input.shift
  ) {
    event.preventDefault()
    mainWindow.webContents.send('shortcut:new-session')
  }
})
```

**Preload** (`src/preload/index.ts`):

Expose a listener for the shortcut IPC event:

```typescript
systemOps: {
  // ... existing methods
  onNewSessionShortcut: (callback: () => void) => {
    ipcRenderer.on('shortcut:new-session', () => callback())
    return () => {
      ipcRenderer.removeAllListeners('shortcut:new-session')
    }
  }
}
```

**Preload Types** (`src/preload/index.d.ts`):

```typescript
interface SystemOps {
  // ... existing methods
  onNewSessionShortcut: (callback: () => void) => () => void
}
```

**Renderer** — listen for the IPC event and trigger session creation:

In `useKeyboardShortcuts.ts` or `AppLayout.tsx`, register a listener:

```typescript
useEffect(() => {
  const cleanup = window.systemOps.onNewSessionShortcut(() => {
    // Reuse the exact same logic as the session:new shortcut handler
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

**Also update `allowInInput`**: Change the `session:new` shortcut handler in `useKeyboardShortcuts.ts` to `allowInInput: true`. This ensures that on platforms or edge cases where the event does reach the DOM (e.g., some Linux window managers), it still works while typing.

#### 4.4 Files to Modify/Create

| File                                             | Change                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`                              | Add `before-input-event` listener on `mainWindow.webContents` to intercept Cmd+T / Ctrl+T, call `event.preventDefault()`, send `shortcut:new-session` IPC to renderer |
| `src/preload/index.ts`                           | Add `onNewSessionShortcut` method to `systemOps` namespace, wrapping `ipcRenderer.on('shortcut:new-session')`                                                         |
| `src/preload/index.d.ts`                         | Add type declaration for `onNewSessionShortcut` on `SystemOps` interface                                                                                              |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts` | Change `session:new` handler to `allowInInput: true`; add `useEffect` to listen for `window.systemOps.onNewSessionShortcut` and trigger session creation              |

---

## Files to Modify — Full Summary

### New Files

| File                                                         | Purpose                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `src/renderer/src/components/sessions/ScrollToBottomFab.tsx` | Floating action button to resume auto-scroll during streaming |

### Modified Files

| File                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add scroll container ref and `onScroll` handler for user-scroll detection; replace unconditional scroll `useEffect` with conditional auto-scroll; add `showScrollFab` state; render `ScrollToBottomFab`; force-resume auto-scroll on send; replace `setTimeout(100)` throttle with `requestAnimationFrame`-based flush; update `immediateFlush` to cancel rAF; add rAF cleanup on unmount |
| `src/main/services/opencode-service.ts`                | Invert role guards in `persistStreamEvent` from `if (role === 'user') return` to `if (role !== 'assistant') return` in both `message.part.updated` and `message.updated` handlers; extend `extractEventMessageRole` with additional payload paths                                                                                                                                         |
| `src/main/index.ts`                                    | Add `before-input-event` listener on `mainWindow.webContents` to intercept Cmd+T / Ctrl+T before Chromium, send `shortcut:new-session` IPC                                                                                                                                                                                                                                                |
| `src/preload/index.ts`                                 | Add `onNewSessionShortcut` method to `systemOps` namespace                                                                                                                                                                                                                                                                                                                                |
| `src/preload/index.d.ts`                               | Add type declaration for `onNewSessionShortcut` on `SystemOps` interface                                                                                                                                                                                                                                                                                                                  |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts`       | Change `session:new` to `allowInInput: true`; add IPC listener for `shortcut:new-session` to trigger session creation from main process interception                                                                                                                                                                                                                                      |

---

## Dependencies to Add

```bash
# No new dependencies required — all features use existing packages:
# - React (components, hooks, refs)
# - Electron (before-input-event, ipcMain, ipcRenderer)
# - lucide-react (ArrowDown icon for FAB)
# - Zustand (existing stores)
```

---

## Non-Functional Requirements

| Requirement                                | Target                                                             |
| ------------------------------------------ | ------------------------------------------------------------------ |
| Scroll position check (`onScroll` handler) | < 1ms per invocation (simple arithmetic on scrollHeight/scrollTop) |
| Auto-scroll suppression                    | Immediate — next flush cycle respects the flag                     |
| FAB show/hide transition                   | 200ms CSS fade (no layout shift)                                   |
| Streaming text flush latency               | ≤ 16.6ms (one frame at 60fps) instead of 100ms                     |
| Text delta to screen time                  | ≤ 1 frame after arrival (no artificial buffering)                  |
| Message echo fix                           | Zero false assistant messages from user echo events                |
| Role guard evaluation                      | < 0.1ms per event (simple string comparison)                       |
| Cmd+T interception                         | < 5ms from keypress to IPC delivery                                |
| New session creation from Cmd+T            | < 500ms end-to-end (same as existing Ctrl+T flow)                  |

---

## Out of Scope (Phase 8)

- Scroll position persistence across session switches (scroll always starts at bottom when entering a session)
- Unread message count badge on the scroll FAB (FAB is a simple arrow, no counter)
- Scroll-to-top button (only scroll-to-bottom)
- Per-message scroll anchoring (browser-level scroll anchoring via `overflow-anchor` is acceptable but not explicitly managed)
- Animated text appearance effects (typewriter, fade-in per character) — content appears instantly on flush
- Configurable flush interval or animation speed settings
- Retroactive database cleanup of existing echoed messages (manual SQL or future migration)
- Cmd+T interception for other Electron-consumed shortcuts (only Cmd+T in this phase)
- Customizable keybinding for new session (uses existing shortcut override system from `useShortcutStore`)

---

## Implementation Priority

### Sprint 1: Message Echo Fix (Bug Fix — Highest Priority)

1. Invert role guards in `opencode-service.ts` `persistStreamEvent`: change `if (role === 'user') return` to `if (role !== 'assistant') return` for both event handlers
2. Extend `extractEventMessageRole` with additional payload paths for robustness
3. Test by sending messages and verifying no assistant-role duplicates appear in the database
4. Verify `finalizeResponseFromDatabase` loads clean message history

### Sprint 2: Cmd+T Shortcut Fix

1. Add `before-input-event` listener in `src/main/index.ts` to intercept Cmd+T / Ctrl+T
2. Expose `onNewSessionShortcut` IPC listener in preload
3. Add type declarations in `index.d.ts`
4. Register the IPC listener in `useKeyboardShortcuts.ts` or `AppLayout.tsx`
5. Change `session:new` to `allowInInput: true`
6. Test on macOS: Cmd+T creates new session from chat input, from empty focus, and from command palette

### Sprint 3: Adaptive Streaming Flush

1. Replace `throttleRef` / `setTimeout(100)` with `rafRef` / `requestAnimationFrame` in `SessionView.tsx`
2. Update `immediateFlush` to use `cancelAnimationFrame`
3. Add cleanup `useEffect` to cancel pending rAF on unmount
4. Test with fast model (Haiku) and slow model (Opus) to verify smooth streaming without visible jumps
5. Verify tool card updates still flush immediately via `immediateFlush`

### Sprint 4: Smart Auto-Scroll

1. Add `scrollContainerRef` to the message list container div
2. Add `isAutoScrollEnabledRef` and `showScrollFab` state
3. Implement `handleScroll` callback with bottom-proximity detection (80px threshold)
4. Replace unconditional scroll `useEffect` with conditional version checking `isAutoScrollEnabledRef`
5. Create `ScrollToBottomFab.tsx` component with arrow-down icon and fade transition
6. Render FAB inside the scroll container with absolute positioning
7. Force-resume auto-scroll in `handleSend` (user expects to see the response)
8. Test: scroll up during streaming → FAB appears, content stops auto-scrolling → click FAB → scrolls to bottom and resumes → scroll manually to bottom → FAB disappears and auto-scroll resumes

---

## Success Metrics

- Scrolling up during active streaming keeps the viewport stable — no snapping to bottom
- A scroll-to-bottom FAB appears when the user is scrolled away from the bottom during streaming
- Clicking the FAB smoothly scrolls to bottom and resumes auto-scrolling
- Manually scrolling to the bottom also resumes auto-scrolling and hides the FAB
- Sending a new message always auto-scrolls to show the response
- Streamed text appears within one frame (~16ms) of arriving — no perceptible lag between model output and screen
- Fast models (Haiku, GPT-4o-mini) show smooth continuous text flow instead of 100ms chunked jumps
- No user messages appear as assistant messages in the chat history
- Reloading messages from the database after stream completion shows only legitimate assistant responses
- Cmd+T on macOS creates a new session tab reliably, whether the chat input is focused or not
- Ctrl+T continues to work on all platforms as before
- Cmd+T works even when focused inside the chat textarea
