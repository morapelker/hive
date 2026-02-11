# Hive -- Phase 15 Product Requirements Document

## Overview

Phase 15 focuses on critical bug fixes and quality-of-life improvements across the session experience. Four bug fixes address broken context tracking (zero-token display), detached tool call results after tab switching, invisible question dialogs on inactive tabs, and misordered user messages. Six feature additions include a copy-branch-name button, favorite models in the model selector, relative-time indicators on worktree rows, an "Open in Chrome" button for web-app run tabs, context-aware Cmd+W behavior for file tabs, and a merge-conflicts quick-action button.

### Phase 15 Goals

1. Fix context indicator showing 0 for sessions where tokens exist in the database
2. Fix tool call results appearing detached from their originating tool card after tab switching
3. Show pending question dialogs when switching to a worktree tab that has a question waiting
4. Fix user messages appearing in wrong positions within the message list
5. Add "Copy branch name" button to the window header
6. Allow right-clicking models in the selector to favorite them (starred models sort to top)
7. Show relative time since last message on each worktree row (e.g. "3m", "2h", "1d")
8. Add "Open in Chrome" button when the Run tab shows a running web app, with configurable Chrome command
9. Make Cmd+W close the active file tab when a file is focused, instead of always closing the session
10. Detect merge conflicts and show a bold "MERGE CONFLICTS" button that starts an AI fix session

---

## Technical Additions

| Component              | Technology                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Context bug fix        | `useOpenCodeGlobalListener.ts` background token extraction, `SessionView.tsx` finalization race fix |
| Tool call correlation  | `SessionView.tsx` streaming parts lifecycle refactor — preserve refs across unmount                 |
| Question persistence   | `useQuestionStore.ts` survives tab switch, `useOpenCodeGlobalListener.ts` handles `question.asked`  |
| Message ordering       | `SessionView.tsx` merge-based finalization instead of full replacement                              |
| Copy branch name       | `Header.tsx` button, `window.projectOps.copyToClipboard`                                            |
| Favorite models        | `useSettingsStore.ts` `favoriteModels: string[]`, `ModelSelector.tsx` context menu + sort           |
| Worktree last-activity | `useWorktreeStatusStore.ts` timestamp tracking, `WorktreeItem.tsx` relative time display            |
| Open in Chrome         | `RunTab.tsx` URL detection, `SessionTabs.tsx` button, `useSettingsStore.ts` chrome command, new IPC |
| Cmd+W file close       | `useKeyboardShortcuts.ts` + `src/main/index.ts` — check `activeFilePath` before closing session     |
| Merge conflicts        | `GitStatusPanel.tsx` conflict button, session creation flow similar to code review                  |

---

## Features

### 1. Context Indicator Bug Fix — Sessions Showing Zero Tokens

#### 1.1 Current State

Context data is stored in the ephemeral `useContextStore` (not persisted to localStorage). Token data arrives via two paths:

**Path A — Real-time streaming** (`SessionView.tsx`, lines 1182-1198): When a `message.updated` event arrives with `info.time.completed`, tokens are extracted and stored:

```typescript
const info = event.data?.info
if (info?.time?.completed) {
  const data = event.data as Record<string, unknown> | undefined
  if (data) {
    const tokens = extractTokens(data)
    if (tokens) {
      const modelRef = extractModelRef(data) ?? undefined
      useContextStore.getState().setSessionTokens(sessionId, tokens, modelRef)
    }
    const cost = extractCost(data)
    if (cost > 0) {
      useContextStore.getState().addSessionCost(sessionId, cost)
    }
  }
}
```

**Path B — Database reconstruction** (`SessionView.tsx`, lines 769-801): On session mount, `loadMessagesFromDatabase()` walks backward through assistant messages to reconstruct the token snapshot.

**The bugs:**

1. The global listener (`useOpenCodeGlobalListener.ts`, lines 28-58) does NOT extract tokens from `message.updated` events for background sessions. It only handles title updates and unread status. When a session completes in the background, tokens are never stored — the context store shows 0.

2. `useContextStore` has no `persist()` middleware. On app restart, all context data is lost. It's only reconstructed when a session is viewed (Path B), but sessions never opened after restart show 0 indefinitely.

3. The `loadMessagesFromDatabase()` function resets tokens at line 772 (`resetSessionTokens`) before scanning. If the scan finds no assistant messages with parseable tokens (e.g., because `opencode_message_json` is null or malformed), the session is left at 0.

#### 1.2 New Design

```
Background session token flow:

  message.updated event ──────┐
                               ▼
  ┌─────────────────────────────────────────────┐
  │ useOpenCodeGlobalListener                    │
  │                                              │
  │  if (event.type === 'message.updated') {     │
  │    if (sessionId !== activeId) {              │
  │      extractTokens → setSessionTokens        │
  │      extractCost → addSessionCost            │
  │    }                                         │
  │  }                                           │
  └─────────────────────────────────────────────┘

Session mount reconstruction:

  loadMessagesFromDatabase()
     │
     ▼
  Walk backward through assistant messages
     │  (same as today)
     ▼
  Always set tokens even if only partial data found
     │
     ▼
  If NO tokens found at all → leave indicator hidden (not 0)
```

#### 1.3 Implementation

**A. Add token extraction to the global listener** (`useOpenCodeGlobalListener.ts`):

```typescript
import { extractTokens, extractCost, extractModelRef } from '@/lib/token-utils'
import { useContextStore } from '@/stores/useContextStore'

// Inside the onStream handler, before the session.status check:
if (event.type === 'message.updated' && sessionId !== activeId) {
  const sessionTitle = event.data?.info?.title || event.data?.title
  if (sessionTitle) {
    useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
  }

  // Extract tokens for background sessions
  const info = event.data?.info
  if (info?.time?.completed) {
    const data = event.data as Record<string, unknown> | undefined
    if (data) {
      const tokens = extractTokens(data)
      if (tokens) {
        const modelRef = extractModelRef(data) ?? undefined
        useContextStore.getState().setSessionTokens(sessionId, tokens, modelRef)
      }
      const cost = extractCost(data)
      if (cost > 0) {
        useContextStore.getState().addSessionCost(sessionId, cost)
      }
    }
  }
  return
}
```

Note: this replaces the existing `session.updated` block (lines 36-42) which only handled title — we now also handle tokens within the same `message.updated` check.

**B. Protect against empty reconstruction** (`SessionView.tsx`): Don't call `resetSessionTokens` if we're about to scan and find nothing. Only reset if we'll actually set new values:

```typescript
let totalCost = 0
let snapshotSet = false
let foundAnyTokens = false

for (let i = dbMessages.length - 1; i >= 0; i--) {
  const msg = dbMessages[i]
  if (msg.role === 'assistant' && msg.opencode_message_json) {
    try {
      const msgJson = JSON.parse(msg.opencode_message_json)
      totalCost += extractCost(msgJson)

      if (!snapshotSet) {
        const tokens = extractTokens(msgJson)
        if (tokens) {
          foundAnyTokens = true
          snapshotSet = true
        }
      }
    } catch {
      /* ignore */
    }
  }
}

// Only reset and set if we found actual data
if (foundAnyTokens || totalCost > 0) {
  useContextStore.getState().resetSessionTokens(sessionId)
  // Re-scan and set (or refactor to cache the found values above)
  // ...set tokens and cost...
}
```

#### 1.4 Files to Modify

| File                                                   | Change                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`  | Add `message.updated` token extraction for background sessions         |
| `src/renderer/src/components/sessions/SessionView.tsx` | Guard `resetSessionTokens` — only reset when reconstruction finds data |
| `src/renderer/src/stores/useContextStore.ts`           | No changes needed (store API is sufficient)                            |
| `src/renderer/src/lib/token-utils.ts`                  | No changes needed (extraction functions handle all formats)            |

---

### 2. Tool Call Result Detachment After Tab Switch

#### 2.1 Current State

Tool calls are correlated by `callID` via `upsertToolUse()` (`SessionView.tsx`, lines 690-726). The function searches `streamingPartsRef.current` for a matching part:

```typescript
const upsertToolUse = useCallback((toolId, update) => {
  updateStreamingPartsRef((parts) => {
    const existingIndex = parts.findIndex((p) => p.type === 'tool_use' && p.toolUse?.id === toolId)
    if (existingIndex >= 0) {
      // Update existing
      const updatedParts = [...parts]
      updatedParts[existingIndex] = { ...existing, toolUse: { ...existing.toolUse!, ...update } }
      return updatedParts
    }
    // Add new tool use part
    return [...parts, { type: 'tool_use', toolUse: newToolUse }]
  })
  immediateFlush()
}, [])
```

On session switch, the cleanup at line 1497-1502 runs:

```typescript
return () => {
  unsubscribe()
  useQuestionStore.getState().clearSession(sessionId)
  usePermissionStore.getState().clearSession(sessionId)
}
```

And at lines 829-834, the streaming state is partially cleared:

```typescript
streamingPartsRef.current = []
streamingContentRef.current = ''
childToSubtaskIndexRef.current = new Map()
setStreamingParts([])
setStreamingContent('')
```

When switching back, restoration at lines 1275-1288 reads from the last DB-persisted assistant message. But tool calls in-flight may not be persisted yet — the main process persists `message.part.updated` events asynchronously. This creates a timing gap:

1. Tool `write` starts → added to `streamingPartsRef` with status `running`
2. User switches tab → `streamingPartsRef` cleared, component unmounts, stream listener unsubscribed
3. Meanwhile, the main process persists the `running` state to DB (or hasn't yet)
4. User switches back → new stream listener subscribes, but generation counter increments
5. Restoration reads DB — if the part was persisted, it restores with `running` status; if not, `streamingPartsRef` is empty
6. Tool `write` finishes → `message.part.updated` arrives → `upsertToolUse` can't find matching part → creates a NEW detached entry

#### 2.2 New Design

```
Before (broken):

  Tab A active:     [text] [write ⏳]
  Switch to Tab B:  streamingPartsRef = []  ← cleared
  Switch back:      [text] [write ⏳]       ← maybe restored from DB
  write finishes:   [text] [write ⏳] [write ✓]  ← DETACHED (new entry)

After (fixed):

  Tab A active:     [text] [write ⏳]
  Switch to Tab B:  streamingPartsRef preserved (not cleared for active streams)
  Switch back:      [text] [write ⏳]       ← restored from preserved ref
  write finishes:   [text] [write ✓]        ← merged into existing entry
```

The key insight: do NOT clear `streamingPartsRef` on session init when the session is actively streaming. Instead, only clear it when switching to a genuinely different session.

#### 2.3 Implementation

**A. Preserve streaming parts across tab switches.** Move the clearing logic behind a condition that checks whether the session was previously active and is still streaming:

```typescript
// In the initializeSession effect (lines 821-834):
streamGenerationRef.current += 1
const currentGeneration = streamGenerationRef.current

// Only clear streaming state if this is a different session or not streaming
const wasStreamingThisSession = streamingPartsRef.current.length > 0 && isStreaming

if (!wasStreamingThisSession) {
  streamingPartsRef.current = []
  streamingContentRef.current = ''
  childToSubtaskIndexRef.current = new Map()
  setStreamingParts([])
  setStreamingContent('')
}
hasFinalizedCurrentResponseRef.current = false
```

**B. Don't unsubscribe the stream listener on unmount if the session is streaming.** Instead, maintain a persistent listener map outside the component lifecycle. The simplest approach: move stream subscription to a ref that survives re-mounts by caching the unsubscribe function keyed by session ID in a module-level map:

```typescript
// Module-level map of active listeners
const activeListeners = new Map<string, () => void>()

// In the init effect:
// If there's already a listener for this session, reuse it
const existingUnsub = activeListeners.get(sessionId)
if (existingUnsub) {
  // Already listening — skip re-subscribe
} else {
  const unsubscribe = window.opencodeOps?.onStream
    ? window.opencodeOps.onStream((event) => {
        /* handler */
      })
    : () => {}
  activeListeners.set(sessionId, unsubscribe)
}

// Cleanup: only unsubscribe if the session is no longer streaming
return () => {
  if (!isStreamingRef.current) {
    const unsub = activeListeners.get(sessionId)
    unsub?.()
    activeListeners.delete(sessionId)
  }
}
```

**C. Alternatively (simpler approach):** Always restore from DB on re-mount and let `upsertToolUse` merge based on callID. The issue is that the DB may lag behind. Add a small delay before first processing events to give the DB time to persist in-flight parts:

```typescript
// After loadMessagesFromDatabase, wait a tick before processing queued events
// This ensures the DB has the latest parts for restoration
if (loadedMessages.length > 0) {
  const lastMsg = loadedMessages[loadedMessages.length - 1]
  if (lastMsg.role === 'assistant' && lastMsg.parts && lastMsg.parts.length > 0) {
    streamingPartsRef.current = lastMsg.parts.map((p) => ({ ...p }))
    setStreamingParts([...streamingPartsRef.current])
  }
}
```

The recommended approach is **A** (preserve parts across tab switches for active streams) combined with the existing restoration logic as a fallback.

#### 2.4 Files to Modify

| File                                                   | Change                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Conditional streaming parts clearing; preserve refs for active streams; improve restoration |

---

### 3. Question Dialog Not Showing on Inactive Tab Switch

#### 3.1 Current State

Questions are managed in `useQuestionStore` (`useQuestionStore.ts`). When a `question.asked` event arrives, it's stored via `addQuestion()`. The question UI renders in `SessionView.tsx` at lines 2096-2107:

```tsx
{
  activeQuestion && (
    <div className="px-4 pb-2">
      <div className="max-w-4xl mx-auto">
        <QuestionPrompt
          request={activeQuestion}
          onReply={handleQuestionReply}
          onReject={handleQuestionReject}
        />
      </div>
    </div>
  )
}
```

**The bug:** When SessionView unmounts (tab switch), cleanup at line 1500 clears all questions:

```typescript
return () => {
  unsubscribe()
  useQuestionStore.getState().clearSession(sessionId)
  usePermissionStore.getState().clearSession(sessionId)
}
```

And the global listener (`useOpenCodeGlobalListener.ts`) does NOT handle `question.asked` events — only `session.updated` and `session.status`. So when a question arrives while the user is on a different tab:

1. The SessionView stream listener is unsubscribed (no one handles `question.asked`)
2. Even if it was somehow stored, `clearSession` wipes it on unmount
3. When the user switches back, a new SessionView mounts but the question is gone
4. The session is stuck — the LLM is waiting for an answer that will never come

#### 3.2 New Design

```
Question lifecycle (fixed):

  ┌──────────────────────────────────────────────┐
  │ useOpenCodeGlobalListener                     │
  │                                               │
  │  question.asked → addQuestion(sessionId, req) │
  │  question.replied → removeQuestion(...)       │
  │  question.rejected → removeQuestion(...)      │
  │                                               │
  │  (handles ALL sessions, active or background) │
  └──────────────────────────────────────────────┘
                    │
                    ▼
  ┌──────────────────────────────────────────────┐
  │ useQuestionStore (persistent across tabs)     │
  │                                               │
  │  pendingBySession: Map<sessionId, questions>  │
  │  NOT cleared on SessionView unmount           │
  └──────────────────────────────────────────────┘
                    │
                    ▼
  ┌──────────────────────────────────────────────┐
  │ SessionView (renders when session is active)  │
  │                                               │
  │  activeQuestion = getActiveQuestion(sessionId)│
  │  Renders QuestionPrompt if non-null           │
  └──────────────────────────────────────────────┘
```

The worktree sidebar already shows "Answer questions" status with an amber icon when `worktreeStatus === 'answering'`. With this fix, clicking on that worktree will show the actual question dialog.

#### 3.3 Implementation

**A. Remove `clearSession` from SessionView unmount** (`SessionView.tsx`, lines 1497-1502):

```typescript
return () => {
  unsubscribe()
  // DO NOT clear questions — they must persist across tab switches
  // useQuestionStore.getState().clearSession(sessionId)  // REMOVED
  // Permissions are also needed across tab switches
  // usePermissionStore.getState().clearSession(sessionId)  // REMOVED
}
```

Questions and permissions are cleared when answered/rejected via `removeQuestion()` / `removePermission()`, which is the correct lifecycle. No need to clear on unmount.

**B. Handle question events in the global listener** (`useOpenCodeGlobalListener.ts`):

```typescript
import { useQuestionStore } from '@/stores/useQuestionStore'

// In the onStream handler, add before the session.status check:
if (event.type === 'question.asked') {
  // Only handle for background sessions — active session handles its own
  if (sessionId !== activeId) {
    const request = event.data
    if (request?.id && request?.questions) {
      useQuestionStore.getState().addQuestion(sessionId, request)
    }
  }
  return
}

if (event.type === 'question.replied' || event.type === 'question.rejected') {
  if (sessionId !== activeId) {
    const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
    if (requestId) {
      useQuestionStore.getState().removeQuestion(sessionId, requestId)
    }
  }
  return
}
```

**C. Set 'answering' status from global listener** when a background session receives a question:

```typescript
if (event.type === 'question.asked' && sessionId !== activeId) {
  const request = event.data
  if (request?.id && request?.questions) {
    useQuestionStore.getState().addQuestion(sessionId, request)
    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'answering')
  }
  return
}
```

This ensures the amber "Answer questions" status and icon appear in the worktree sidebar even when the question arrives while viewing a different tab.

#### 3.4 Files to Modify

| File                                                   | Change                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`  | Handle `question.asked`, `question.replied`, `question.rejected` for background sessions |
| `src/renderer/src/components/sessions/SessionView.tsx` | Remove `clearSession` calls from unmount cleanup                                         |

---

### 4. User Message Appearing at Wrong Position

#### 4.1 Current State

Messages are stored as local React state in `SessionView` (`useState<OpenCodeMessage[]>`, line 343). The user message flow:

1. `handleSend()` saves user message to DB (line 1655-1659)
2. Appends to state: `setMessages((prev) => [...prev, userMessage])` (line 1662)
3. Calls `window.opencodeOps.prompt()` to send to LLM (line 1690)
4. LLM responds via streaming events
5. On `session.idle` or `session.status {idle}`, calls `finalizeResponseFromDatabase()` (lines 1224-1226, 1243-1245)
6. `finalizeResponseFromDatabase()` calls `loadMessagesFromDatabase()` (line 808)
7. `loadMessagesFromDatabase()` replaces the entire array: `setMessages(loadedMessages)` (line 759)

**The race condition:** If the user sends a new message while finalization is in progress:

1. Response stream completes → `finalizeResponseFromDatabase()` called
2. User types and sends a new message → `setMessages(prev => [...prev, newMsg])` — correctly appended
3. `loadMessagesFromDatabase()` completes (async DB query) → `setMessages(loadedMessages)` — **replaces** entire state
4. The new user message was saved to DB with `created_at = now`, but the DB query may return results where this message appears in the middle (due to DB race) or at the end
5. If `setMessages` from step 3 runs AFTER step 2, the user's message position depends on DB ordering, which may differ from the append order

Additionally, `resetStreamingState()` is called in `finalizeResponseFromDatabase()` at line 813, which sets `isStreaming = false` and `isSending = false`. If the user sent a new message in step 2, this resets the sending state prematurely.

#### 4.2 New Design

```
Before (race condition):

  Time ──────────────────────────────────►
  ┌──────────┐  ┌──────────┐  ┌──────────────┐
  │ stream   │  │ user     │  │ finalize     │
  │ ends     │  │ sends    │  │ replaces     │
  │          │  │ msg      │  │ all msgs     │
  └──────────┘  └──────────┘  └──────────────┘
  Messages:     Messages:     Messages:
  [A1, A2]      [A1, A2, U3]  [A1, A2, U3?]  ← position depends on DB timing

After (merge-based finalization):

  Time ──────────────────────────────────►
  ┌──────────┐  ┌──────────┐  ┌──────────────┐
  │ stream   │  │ user     │  │ finalize     │
  │ ends     │  │ sends    │  │ merges       │
  │          │  │ msg      │  │ DB + local   │
  └──────────┘  └──────────┘  └──────────────┘
  Messages:     Messages:     Messages:
  [A1, A2]      [A1, A2, U3]  [A1, A2, U3]   ← U3 stays at end
```

#### 4.3 Implementation

**A. Guard finalization when a new prompt is in-flight.** Add a ref tracking whether a new prompt was sent after the last stream started:

```typescript
const promptSentDuringStreamRef = useRef(false)

// In handleSend, after sending:
promptSentDuringStreamRef.current = true

// In finalizeResponseFromDatabase:
const finalizeResponseFromDatabase = async (): Promise<void> => {
  // If a new prompt was sent, skip full replacement — the new prompt's
  // stream will finalize both when it completes
  if (promptSentDuringStreamRef.current) {
    promptSentDuringStreamRef.current = false
    resetStreamingState()
    return
  }

  try {
    await loadMessagesFromDatabase()
  } catch (error) {
    console.error('Failed to refresh messages after stream completion:', error)
    toast.error('Failed to refresh response')
  } finally {
    resetStreamingState()
    setIsSending(false)
  }
}
```

**B. Use merge-based replacement in `loadMessagesFromDatabase`.** Instead of blindly replacing, merge DB messages with any locally-appended messages that may not be in the DB yet:

```typescript
const loadMessagesFromDatabase = async (): Promise<OpenCodeMessage[]> => {
  const dbMessages = (await window.db.message.getBySession(sessionId)) as DbMessage[]
  const loadedMessages = dbMessages.map(dbMessageToOpenCode)

  setMessages((currentMessages) => {
    // Find any local messages not yet in the DB result (sent during async load)
    const loadedIds = new Set(loadedMessages.map((m) => m.id))
    const localOnly = currentMessages.filter((m) => !loadedIds.has(m.id))

    // Append local-only messages at the end to preserve user intent
    return localOnly.length > 0 ? [...loadedMessages, ...localOnly] : loadedMessages
  })

  // ... rest of token reconstruction unchanged
  return loadedMessages
}
```

#### 4.4 Files to Modify

| File                                                   | Change                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `src/renderer/src/components/sessions/SessionView.tsx` | Merge-based `loadMessagesFromDatabase`, guard `finalizeResponseFromDatabase` against in-flight prompts |

---

### 5. Copy Branch Name Button

#### 5.1 Current State

The header (`Header.tsx`, lines 39-48) displays the branch name as read-only text:

```tsx
{
  selectedProject.name
}
{
  selectedWorktree?.branch_name && selectedWorktree.name !== '(no-worktree)' && (
    <span className="text-primary font-normal"> ({selectedWorktree.branch_name})</span>
  )
}
```

There is no way to copy the branch name without manually selecting the text. `WorktreeItem.tsx` has a "Copy Path" action (line 184-187) using `window.projectOps.copyToClipboard()`, but no "Copy Branch Name" equivalent.

#### 5.2 New Design

```
Header layout:

  ┌────────────────────────────────────────────────────────────────────┐
  │  [traffic]  🐝 ProjectName (branch-name) [📋]   [QuickActions]   │
  │  [lights ]                                  ▲     [⏱][⚙][◧]     │
  └─────────────────────────────────────────────┼──────────────────────┘
                                                │
                                         Copy branch name
                                         (clipboard icon)
                                         Tooltip: "Copy branch name"
                                         On click: copies + toast
```

#### 5.3 Implementation

Add a small clipboard button next to the branch name in `Header.tsx`:

```tsx
import { Copy } from 'lucide-react'
import { toast } from 'sonner'

// Inside the header, after the branch name span:
{
  selectedWorktree?.branch_name && selectedWorktree.name !== '(no-worktree)' && (
    <>
      <span className="text-primary font-normal"> ({selectedWorktree.branch_name})</span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          window.projectOps.copyToClipboard(selectedWorktree.branch_name)
          toast.success('Branch name copied')
        }}
        className="ml-0.5 p-0.5 rounded hover:bg-accent transition-colors"
        title="Copy branch name"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        data-testid="copy-branch-name"
      >
        <Copy className="h-3 w-3 text-muted-foreground" />
      </button>
    </>
  )
}
```

The button must have `WebkitAppRegion: 'no-drag'` because the header is a drag region (line 32).

#### 5.4 Files to Modify

| File                                            | Change                                                  |
| ----------------------------------------------- | ------------------------------------------------------- |
| `src/renderer/src/components/layout/Header.tsx` | Add copy button with clipboard icon next to branch name |

---

### 6. Favorite Models in Model Selector

#### 6.1 Current State

`ModelSelector.tsx` renders models grouped by provider. Models are loaded from `window.opencodeOps.listModels()` and displayed in a `DropdownMenu`. The selected model is stored in `useSettingsStore.selectedModel`. There is no concept of favoriting — all models appear in provider order.

```tsx
// ModelSelector.tsx, lines 231-280
{
  filteredProviders.map((provider, index) => (
    <div key={provider.providerID}>
      <DropdownMenuLabel>{provider.providerName}</DropdownMenuLabel>
      {provider.models.map((model) => (
        <DropdownMenuItem onClick={() => handleSelectModel(model)}>
          <span>{getDisplayName(model)}</span>
          {active && <Check className="h-4 w-4 text-primary" />}
        </DropdownMenuItem>
      ))}
    </div>
  ))
}
```

#### 6.2 New Design

```
Model dropdown with favorites:

  ┌──────────────────────────────┐
  │ 🔍 Filter models...          │
  ├──────────────────────────────┤
  │ ★ Favorites                  │  ← Only shown when favorites exist
  │   ★ claude-sonnet-4    ✓    │
  │   ★ gpt-4o                   │
  ├──────────────────────────────┤
  │ Anthropic                     │
  │   claude-opus-4-5             │
  │   claude-sonnet-4      ✓    │  ← Also appears in provider section
  │   claude-haiku-3.5            │
  ├──────────────────────────────┤
  │ OpenAI                        │
  │   gpt-4o                      │
  │   o4-mini                     │
  └──────────────────────────────┘

  Right-click on any model → toggles ★ favorite
  Starred models duplicated into "Favorites" section at top
```

#### 6.3 Implementation

**A. Add `favoriteModels` to settings store** (`useSettingsStore.ts`):

```typescript
export interface AppSettings {
  // ... existing fields
  favoriteModels: string[] // Array of "providerID::modelID" strings
}

const DEFAULT_SETTINGS: AppSettings = {
  // ... existing defaults
  favoriteModels: []
}
```

Add a toggle action:

```typescript
toggleFavoriteModel: (providerID: string, modelID: string) => {
  const key = `${providerID}::${modelID}`
  const current = get().favoriteModels
  const updated = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
  set({ favoriteModels: updated })
  const settings = extractSettings({ ...get(), favoriteModels: updated } as SettingsState)
  saveToDatabase(settings)
}
```

**B. Add right-click handler and favorites section to `ModelSelector.tsx`:**

```tsx
const favoriteModels = useSettingsStore((s) => s.favoriteModels)
const toggleFavoriteModel = useSettingsStore((s) => s.toggleFavoriteModel)

const isFavorite = (model: ModelInfo): boolean => {
  return favoriteModels.includes(`${model.providerID}::${model.id}`)
}

// Collect favorite model objects
const favoriteModelObjects = useMemo(() => {
  return providers.flatMap((p) => p.models.filter((m) => isFavorite(m)))
}, [providers, favoriteModels])

// In the dropdown content, before provider sections:
{
  favoriteModelObjects.length > 0 && (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground flex items-center gap-1">
        <Star className="h-3 w-3" /> Favorites
      </DropdownMenuLabel>
      {favoriteModelObjects.map((model) => (
        <DropdownMenuItem
          key={`fav-${model.providerID}:${model.id}`}
          onClick={() => handleSelectModel(model)}
          onContextMenu={(e) => {
            e.preventDefault()
            toggleFavoriteModel(model.providerID, model.id)
          }}
        >
          <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 mr-1.5" />
          <span>{getDisplayName(model)}</span>
          {isActiveModel(model) && <Check className="h-4 w-4 text-primary" />}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
    </>
  )
}

// On each regular model item, add onContextMenu:
;<DropdownMenuItem
  onClick={() => handleSelectModel(model)}
  onContextMenu={(e) => {
    e.preventDefault()
    toggleFavoriteModel(model.providerID, model.id)
  }}
>
  {isFavorite(model) && (
    <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 mr-1.5 shrink-0" />
  )}
  <span>{getDisplayName(model)}</span>
  {active && <Check className="h-4 w-4 text-primary" />}
</DropdownMenuItem>
```

#### 6.4 Files to Modify

| File                                                     | Change                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/renderer/src/stores/useSettingsStore.ts`            | Add `favoriteModels: string[]` to `AppSettings`, add `toggleFavoriteModel` action |
| `src/renderer/src/components/sessions/ModelSelector.tsx` | Add favorites section, right-click toggle, star icons                             |

---

### 7. Last Message Time on Worktree Rows

#### 7.1 Current State

`WorktreeItem.tsx` displays a two-line row. The second line shows the status text (`Working`, `Ready`, `Planning`, `Answer questions`) on the left:

```tsx
// WorktreeItem.tsx, lines 302-307
<span className={cn('text-[11px] block', statusClass)} data-testid="worktree-status-text">
  {displayStatus}
</span>
```

There is no time information shown. The worktree status store tracks activity status but not timestamps of last messages.

#### 7.2 New Design

```
Worktree row layout:

  ┌──────────────────────────────────────────┐
  │ 🔀 feature/auth-refactor            [...] │  ← Row 1: branch name
  │    Working                            2m  │  ← Row 2: status (left) + time (right)
  └──────────────────────────────────────────┘

  Time format:
  - < 1 minute:  "now"
  - < 60 min:    "Xm"     (e.g. "3m", "45m")
  - < 24 hours:  "Xh"     (e.g. "2h", "18h")
  - < 7 days:    "Xd"     (e.g. "1d", "5d")
  - >= 7 days:   "Xw"     (e.g. "1w", "3w")
```

#### 7.3 Implementation

**A. Track last message timestamp per worktree** in `useWorktreeStatusStore.ts`:

```typescript
interface WorktreeStatusState {
  sessionStatuses: Record<string, SessionStatus | null>
  lastMessageTimeByWorktree: Record<string, number> // worktreeId → epoch ms

  setLastMessageTime: (worktreeId: string, timestamp: number) => void
  getLastMessageTime: (worktreeId: string) => number | null
}
```

```typescript
setLastMessageTime: (worktreeId: string, timestamp: number) => {
  set((state) => ({
    lastMessageTimeByWorktree: {
      ...state.lastMessageTimeByWorktree,
      [worktreeId]: Math.max(state.lastMessageTimeByWorktree[worktreeId] ?? 0, timestamp)
    }
  }))
}

getLastMessageTime: (worktreeId: string) => {
  return get().lastMessageTimeByWorktree[worktreeId] ?? null
}
```

**B. Update timestamp when messages arrive.** In `SessionView.tsx`, after saving a user message and after stream finalization, update the worktree's last message time:

```typescript
// In handleSend, after saving user message:
if (worktreeId) {
  useWorktreeStatusStore.getState().setLastMessageTime(worktreeId, Date.now())
}

// In the global listener, on session.status idle (background sessions):
// The session's worktree needs to be resolved
```

Also in `useOpenCodeGlobalListener.ts`, when a background session becomes idle, update the timestamp. We need to resolve session → worktree mapping:

```typescript
if (status?.type === 'idle' && sessionId !== activeId) {
  useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'unread')
  // Update last message time for the worktree
  const worktreeId = resolveWorktreeForSession(sessionId)
  if (worktreeId) {
    useWorktreeStatusStore.getState().setLastMessageTime(worktreeId, Date.now())
  }
}
```

**C. Add relative time formatting utility:**

```typescript
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 1) return 'now'
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d`
  const diffWeek = Math.floor(diffDay / 7)
  return `${diffWeek}w`
}
```

**D. Display in `WorktreeItem.tsx`:**

```tsx
const lastMessageTime = useWorktreeStatusStore((s) => s.getLastMessageTime(worktree.id))

// In the second row, change from a single span to a flex row:
<div className="flex items-center justify-between">
  <span className={cn('text-[11px]', statusClass)} data-testid="worktree-status-text">
    {displayStatus}
  </span>
  {lastMessageTime && (
    <span
      className="text-[10px] text-muted-foreground tabular-nums"
      data-testid="worktree-last-message-time"
    >
      {formatRelativeTime(lastMessageTime)}
    </span>
  )}
</div>
```

**E. Auto-refresh the relative time** with a 60-second interval so "now" transitions to "1m" etc.:

```typescript
// In WorktreeItem or a parent component
const [, forceUpdate] = useState(0)
useEffect(() => {
  const timer = setInterval(() => forceUpdate((n) => n + 1), 60000)
  return () => clearInterval(timer)
}, [])
```

#### 7.4 Files to Modify

| File                                                     | Change                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/renderer/src/stores/useWorktreeStatusStore.ts`      | Add `lastMessageTimeByWorktree`, `setLastMessageTime`, `getLastMessageTime` |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Display relative time on right side of status row, 60s refresh              |
| `src/renderer/src/lib/format-utils.ts`                   | New utility: `formatRelativeTime()` (or add to existing utils)              |
| `src/renderer/src/components/sessions/SessionView.tsx`   | Call `setLastMessageTime` in `handleSend`                                   |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`    | Call `setLastMessageTime` on background session idle                        |

---

### 8. Open in Chrome Button

#### 8.1 Current State

The `RunTab.tsx` component shows script output and status. It detects running processes via `useScriptStore`. The `SessionTabs.tsx` renders the tab bar with session tabs and file tabs. The `BottomPanel.tsx` hosts Setup/Run/Terminal tabs.

There is no mechanism to:

- Detect that a running process is a web server
- Open the app in a browser
- Configure a custom Chrome launch command

`RunTab.tsx` output lines (lines 171-193) include raw output from the dev server, which typically contains URL patterns like `http://localhost:3000` or `Local:   http://127.0.0.1:5173/`.

#### 8.2 New Design

```
Tab bar with "Open in Chrome" button:

  ┌──────────────────────────────────────────────────────────────────┐
  │ [+] │ Session 1 │ Session 2 │ file.ts │          │ [🌐 Chrome] │
  └──────────────────────────────────────────────────────────────────┘
                                                           ▲
                                               Only visible when:
                                               1. Run tab is selected
                                               2. Run process is alive
                                               3. URL detected in output

  Left-click:  Opens detected URL in Chrome (or custom command)
  Right-click: Opens popover to set custom Chrome command

  Default command: "open -a Google\\ Chrome {url}"
  Custom example:  "open -n -a /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome
                    --args --user-data-dir=\"...\" --disable-web-security {url}"
```

#### 8.3 Implementation

**A. Detect URL from run output** in `useScriptStore.ts` or `RunTab.tsx`:

```typescript
// URL detection regex for common dev server output
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{3,5}\/?/

function extractDevServerUrl(output: string[]): string | null {
  for (let i = output.length - 1; i >= Math.max(0, output.length - 50); i--) {
    const match = output[i].match(URL_PATTERN)
    if (match) return match[0]
  }
  return null
}
```

**B. Add `customChromeCommand` to settings store** (`useSettingsStore.ts`):

```typescript
export interface AppSettings {
  // ... existing
  customChromeCommand: string // e.g. "open -n -a /Applications/Google\\ Chrome.app/..."
}

const DEFAULT_SETTINGS: AppSettings = {
  // ... existing
  customChromeCommand: ''
}
```

**C. Add IPC handler for launching Chrome** (`src/main/ipc/system-handlers.ts` or similar):

```typescript
ipcMain.handle('system:openInChrome', async (_event, { url, customCommand }) => {
  try {
    if (customCommand) {
      const cmd = customCommand.replace('{url}', url)
      await exec(cmd)
    } else {
      await shell.openExternal(url)
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})
```

**D. Add preload bridge** (`src/preload/index.ts`):

```typescript
openInChrome: (url: string, customCommand?: string) =>
  ipcRenderer.invoke('system:openInChrome', { url, customCommand })
```

**E. Add "Open in Chrome" button to `SessionTabs.tsx`** (right side of tab bar):

```tsx
const runOutput = useScriptStore((s) =>
  selectedWorktreeId ? s.scriptStates[selectedWorktreeId]?.runOutput : null
)
const runRunning = useScriptStore((s) =>
  selectedWorktreeId ? s.scriptStates[selectedWorktreeId]?.runRunning : false
)
const activeBottomTab = useLayoutStore((s) => s.activeBottomTab)
const customChromeCommand = useSettingsStore((s) => s.customChromeCommand)

const detectedUrl = useMemo(() => {
  if (!runRunning || activeBottomTab !== 'run' || !runOutput) return null
  return extractDevServerUrl(runOutput)
}, [runRunning, activeBottomTab, runOutput])

// In the render, after the right scroll arrow:
{
  detectedUrl && (
    <button
      onClick={() => window.systemOps.openInChrome(detectedUrl, customChromeCommand || undefined)}
      onContextMenu={(e) => {
        e.preventDefault()
        // Show popover or prompt for custom command
        setChromeCommandDialogOpen(true)
      }}
      className="flex items-center gap-1 px-2 py-1 text-xs hover:bg-accent transition-colors shrink-0 border-l border-border"
      title="Open in Chrome"
      data-testid="open-in-chrome"
    >
      <Globe className="h-3.5 w-3.5" />
      <span className="text-[11px]">Chrome</span>
    </button>
  )
}
```

**F. Add a small dialog/popover for custom command configuration:**

```tsx
{
  chromeCommandDialogOpen && (
    <div className="absolute right-0 top-full mt-1 z-50 bg-popover border rounded-md shadow-md p-3 w-80">
      <label className="text-xs font-medium">Custom Chrome Command</label>
      <p className="text-[10px] text-muted-foreground mb-2">
        Use {'{url}'} as placeholder for the URL
      </p>
      <input
        value={chromeCommandInput}
        onChange={(e) => setChromeCommandInput(e.target.value)}
        placeholder='open -a "Google Chrome" {url}'
        className="w-full text-xs bg-background border rounded px-2 py-1"
      />
      <div className="flex justify-end gap-1 mt-2">
        <button
          onClick={() => setChromeCommandDialogOpen(false)}
          className="text-xs px-2 py-1 rounded hover:bg-accent"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            useSettingsStore.getState().updateSetting('customChromeCommand', chromeCommandInput)
            setChromeCommandDialogOpen(false)
            toast.success('Chrome command saved')
          }}
          className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Save
        </button>
      </div>
    </div>
  )
}
```

#### 8.4 Files to Modify

| File                                                   | Change                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionTabs.tsx` | Add "Open in Chrome" button with URL detection, right-click config dialog  |
| `src/renderer/src/stores/useSettingsStore.ts`          | Add `customChromeCommand` to `AppSettings`                                 |
| `src/renderer/src/stores/useScriptStore.ts`            | (Optional) Add `detectedUrl` derived state or export URL detection utility |
| `src/main/ipc/system-handlers.ts`                      | Add `system:openInChrome` IPC handler                                      |
| `src/preload/index.ts`                                 | Add `openInChrome` to `systemOps` namespace                                |
| `src/preload/index.d.ts`                               | Add type declaration for `openInChrome`                                    |

---

### 9. Cmd+W Should Close File Tab When Focused

#### 9.1 Current State

Cmd+W is intercepted in the main process (`src/main/index.ts`, lines 150-160):

```typescript
if (input.key.toLowerCase() === 'w' && (input.meta || input.control) && ...) {
  event.preventDefault()
  mainWindow!.webContents.send('shortcut:close-session')
}
```

The renderer handler (`useKeyboardShortcuts.ts`, lines 114-134) always closes the active session:

```typescript
const cleanup = window.systemOps.onCloseSessionShortcut(() => {
  const { activeSessionId } = useSessionStore.getState()
  if (!activeSessionId) return
  useSessionStore.getState().closeSession(activeSessionId).then(...)
})
```

This means Cmd+W always closes the session tab, even when the user is viewing a file tab. This is confusing because the user expects Cmd+W to close whatever is currently focused.

`useFileViewerStore` tracks `activeFilePath` — when non-null, a file tab is the active view.

#### 9.2 New Design

```
Cmd+W behavior matrix:

  ┌─────────────────────────┬──────────────────────────────────┐
  │ Current focus            │ Cmd+W action                     │
  ├─────────────────────────┼──────────────────────────────────┤
  │ File tab active          │ Close file tab, switch to session │
  │ Diff view active         │ Clear diff view, switch to session│
  │ Session tab active       │ Close session tab (existing)     │
  │ No tab active            │ No-op                             │
  └─────────────────────────┴──────────────────────────────────┘
```

#### 9.3 Implementation

**A. Rename the IPC channel** from `shortcut:close-session` to `shortcut:close-tab` (semantic accuracy). Or keep the same channel but change the handler logic.

Simpler approach — change only the renderer handler in `useKeyboardShortcuts.ts`:

```typescript
const cleanup = window.systemOps.onCloseSessionShortcut(() => {
  const { activeFilePath, activeDiff } = useFileViewerStore.getState()

  // Priority 1: Close active file tab
  if (activeFilePath) {
    useFileViewerStore.getState().closeFile(activeFilePath)
    return
  }

  // Priority 2: Clear active diff view
  if (activeDiff) {
    useFileViewerStore.getState().clearActiveDiff()
    return
  }

  // Priority 3: Close active session tab
  const { activeSessionId } = useSessionStore.getState()
  if (!activeSessionId) return
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
```

#### 9.4 Files to Modify

| File                                             | Change                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts` | Check `activeFilePath` / `activeDiff` before closing session; close file tab if focused |

---

### 10. Merge Conflicts Quick-Action Button

#### 10.1 Current State

Git status detection already identifies conflicted files with status code `'C'` (`git-service.ts`, lines 454-462). The `GitStatusPanel.tsx` header (lines 362-377) has a review button and a refresh button:

```tsx
<div className="flex items-center gap-0.5">
  <Button
    variant="ghost"
    size="icon"
    className="h-5 w-5"
    onClick={handleReview}
    disabled={!hasChanges || isReviewing}
    title="Review changes with AI"
  >
    {isReviewing ? <Loader2 /> : <FileSearch />}
  </Button>
  <Button
    variant="ghost"
    size="icon"
    className="h-5 w-5"
    onClick={handleRefresh}
    disabled={isLoading || isRefreshing}
  >
    <RefreshCw />
  </Button>
</div>
```

The `handleReview` function (lines 255-326) creates a new session, sets it to plan mode, and sends a review prompt. This is the exact pattern needed for merge conflict resolution.

Conflicted files are available in `fileStatuses` as entries with `status === 'C'`.

#### 10.2 New Design

```
Git status panel header with merge conflicts:

  ┌──────────────────────────────────────────────────────────────────┐
  │ 🔀 main  ↑2                [MERGE CONFLICTS] [🔍] [🔄]        │
  └──────────────────────────────────────────────────────────────────┘
                                      ▲
                               Bold red/orange text
                               Only visible when conflicted files exist
                               Click → creates session with "Fix merge conflicts"

  On click:
  1. Create new session
  2. Set session name to "Merge Conflicts — {branchName}"
  3. Set mode to "build" (not plan — we want the LLM to fix files)
  4. Auto-send prompt: "Fix merge conflicts"
```

#### 10.3 Implementation

**A. Detect conflicted files** in `GitStatusPanel.tsx`:

```typescript
const conflictedFiles = useMemo(() => fileStatuses.filter((f) => f.status === 'C'), [fileStatuses])
const hasConflicts = conflictedFiles.length > 0
```

**B. Add merge conflicts handler** (similar to `handleReview`):

```typescript
const [isFixingConflicts, setIsFixingConflicts] = useState(false)

const handleFixConflicts = useCallback(async () => {
  if (!worktreePath) return
  setIsFixingConflicts(true)
  try {
    const worktreeStore = useWorktreeStore.getState()
    const selectedWorktreeId = worktreeStore.selectedWorktreeId
    if (!selectedWorktreeId) {
      toast.error('No worktree selected')
      return
    }

    let projectId = ''
    for (const [projId, worktrees] of worktreeStore.worktreesByProject) {
      if (worktrees.some((w) => w.id === selectedWorktreeId)) {
        projectId = projId
        break
      }
    }
    if (!projectId) {
      toast.error('Could not find project for worktree')
      return
    }

    const branchName = branchInfo?.name || 'unknown'

    // Create session
    const sessionStore = useSessionStore.getState()
    const result = await sessionStore.createSession(selectedWorktreeId, projectId)
    if (!result.success || !result.session) {
      toast.error('Failed to create session')
      return
    }

    // Set session name — don't set plan mode, we want the LLM to fix files
    await sessionStore.updateSessionName(result.session.id, `Merge Conflicts — ${branchName}`)

    // Store pending message
    sessionStore.setPendingMessage(result.session.id, 'Fix merge conflicts')
  } catch (error) {
    console.error('Failed to start conflict resolution:', error)
    toast.error('Failed to start conflict resolution')
  } finally {
    setIsFixingConflicts(false)
  }
}, [worktreePath, branchInfo])
```

**C. Add the button** in the header, before the review button:

```tsx
<div className="flex items-center gap-0.5">
  {hasConflicts && (
    <Button
      variant="ghost"
      size="sm"
      className="h-5 px-1.5 text-[10px] font-bold text-orange-500 hover:text-orange-400"
      onClick={handleFixConflicts}
      disabled={isFixingConflicts}
      title={`${conflictedFiles.length} file(s) with merge conflicts — click to fix with AI`}
      data-testid="git-merge-conflicts-button"
    >
      {isFixingConflicts ? (
        <Loader2 className="h-3 w-3 animate-spin mr-0.5" />
      ) : (
        <AlertTriangle className="h-3 w-3 mr-0.5" />
      )}
      CONFLICTS
    </Button>
  )}
  <Button
    variant="ghost"
    size="icon"
    className="h-5 w-5"
    onClick={handleReview}
    disabled={!hasChanges || isReviewing}
    title="Review changes with AI"
  >
    ...
  </Button>
  ...
</div>
```

#### 10.4 Files to Modify

| File                                                 | Change                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/renderer/src/components/git/GitStatusPanel.tsx` | Add `handleFixConflicts`, "CONFLICTS" button, conflicted file detection |

---

## Files to Modify -- Full Summary

### New Files

| File                                   | Features | Purpose                        |
| -------------------------------------- | -------- | ------------------------------ |
| `src/renderer/src/lib/format-utils.ts` | 7        | `formatRelativeTime()` utility |

### Modified Files

| File                                                     | Features      | Change Summary                                                                                                                                                                 |
| -------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`    | 1, 3, 7       | Add token extraction for background sessions; handle `question.asked/replied/rejected`; update last-message timestamps                                                         |
| `src/renderer/src/components/sessions/SessionView.tsx`   | 1, 2, 3, 4, 7 | Guard `resetSessionTokens`; preserve streaming parts for active streams; remove `clearSession` from unmount; merge-based `loadMessagesFromDatabase`; call `setLastMessageTime` |
| `src/renderer/src/components/layout/Header.tsx`          | 5             | Add copy-branch-name button with clipboard icon                                                                                                                                |
| `src/renderer/src/stores/useSettingsStore.ts`            | 6, 8          | Add `favoriteModels: string[]`, `toggleFavoriteModel`, `customChromeCommand`                                                                                                   |
| `src/renderer/src/components/sessions/ModelSelector.tsx` | 6             | Add favorites section, right-click toggle, star icons                                                                                                                          |
| `src/renderer/src/stores/useWorktreeStatusStore.ts`      | 7             | Add `lastMessageTimeByWorktree`, `setLastMessageTime`, `getLastMessageTime`                                                                                                    |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | 7             | Display relative time on right side of status row with 60s auto-refresh                                                                                                        |
| `src/renderer/src/components/sessions/SessionTabs.tsx`   | 8             | Add "Open in Chrome" button with URL detection and config dialog                                                                                                               |
| `src/renderer/src/stores/useScriptStore.ts`              | 8             | (Optional) Export URL detection utility                                                                                                                                        |
| `src/main/ipc/system-handlers.ts`                        | 8             | Add `system:openInChrome` IPC handler                                                                                                                                          |
| `src/preload/index.ts`                                   | 8             | Add `openInChrome` to `systemOps` bridge                                                                                                                                       |
| `src/preload/index.d.ts`                                 | 8             | Add type declaration for `openInChrome`                                                                                                                                        |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts`         | 9             | Check `activeFilePath` / `activeDiff` before closing session                                                                                                                   |
| `src/renderer/src/components/git/GitStatusPanel.tsx`     | 10            | Add `handleFixConflicts`, "CONFLICTS" button                                                                                                                                   |

---

## Dependencies to Add

None — all features use existing packages.

---

## Non-Functional Requirements

| Requirement                                           | Target                                             |
| ----------------------------------------------------- | -------------------------------------------------- |
| Context indicator update latency (background session) | < 500ms after `message.updated` event              |
| Tool call correlation accuracy after tab switch       | 100% — no detached tool results                    |
| Question dialog display on tab switch                 | < 100ms after tab activation                       |
| Message ordering consistency                          | User messages always appear at the end of the list |
| Copy branch name clipboard write                      | < 50ms                                             |
| Favorite model toggle persistence                     | < 200ms save to DB                                 |
| Model selector render with favorites                  | < 16ms (no visible jank)                           |
| Relative time formatting                              | < 1ms per computation                              |
| Relative time refresh interval                        | 60 seconds                                         |
| URL detection in run output                           | < 10ms scan of last 50 lines                       |
| Open in Chrome launch                                 | < 1 second from click to browser window            |
| Cmd+W file close                                      | < 50ms tab close + view switch                     |
| Merge conflicts button visibility                     | Immediate on git status refresh                    |
| Conflict session creation                             | < 2 seconds from click to prompt sent              |

---

## Out of Scope (Phase 15)

- Persisting `useContextStore` to localStorage (would add complexity; DB reconstruction is sufficient)
- Token tracking for child/subagent sessions (only parent session tokens tracked)
- Automatic retry of questions that were lost before this fix
- Message reordering UI (drag-and-drop messages)
- Copy branch name via keyboard shortcut (Cmd+Shift+C or similar)
- Favorite model ordering (favorites appear in the order they were added)
- Model usage statistics or frequency-based sorting
- Live-updating relative times (sub-minute precision; 60s interval is sufficient)
- Open in Firefox/Safari/other browsers (Chrome-only for now)
- Custom URL pattern configuration for dev server detection
- Cmd+W closing the entire Electron window (intentionally prevented)
- Automated merge conflict resolution (the LLM handles it via the session)
- Conflict resolution UI (file-by-file conflict editor)
- Git rebase conflict detection (merge conflicts only)
- Custom Chrome profiles management UI (just a single command string)

---

## Implementation Priority

### Sprint 1 (Bug Fixes — Highest Priority)

1. **Feature 3: Question Dialog Persistence** — Users are completely stuck when questions arrive on inactive tabs. Removing `clearSession` from unmount and adding global listener handling is a small, high-impact fix.
2. **Feature 4: Message Ordering** — Misordered messages break user trust in the UI. Merge-based finalization prevents the race condition.
3. **Feature 2: Tool Call Correlation** — Detached tool results are visually confusing and break the session narrative. Preserving streaming parts for active streams fixes the root cause.
4. **Feature 1: Context Indicator** — Zero-token display for sessions with actual token data is misleading. Adding background token extraction to the global listener is a targeted fix.

### Sprint 2 (UX Improvements — High Priority)

5. **Feature 9: Cmd+W File Close** — Users instinctively press Cmd+W to close the current view. Closing a session when viewing a file is surprising and destructive.
6. **Feature 5: Copy Branch Name** — Small quality-of-life improvement, minimal code change, high daily utility.
7. **Feature 7: Last Message Time** — Provides at-a-glance activity context for each worktree without clicking into it.

### Sprint 3 (Feature Additions — Medium Priority)

8. **Feature 10: Merge Conflicts Button** — Surfaces an actionable git state that is otherwise hidden. Reuses the existing code-review session creation pattern.
9. **Feature 6: Favorite Models** — Reduces friction for users who frequently switch between 2-3 models across many providers.
10. **Feature 8: Open in Chrome** — Convenience feature for web app development. Requires new IPC channel and URL detection logic.

---

## Success Metrics

- Context indicator shows non-zero values for all sessions that have received at least one `message.updated` event with tokens
- Background sessions (completed while viewing a different tab) show correct context values immediately on tab switch
- Tool call results always merge into their originating tool card, regardless of tab switching during execution
- No detached "orphan" tool result entries appear in the message stream
- Question dialog appears immediately when switching to a worktree tab with a pending question
- Sessions with pending questions are never stuck — the user can always answer or dismiss
- User messages always appear as the last item in the message list (before streaming content)
- No message reordering occurs during finalization, even when sending messages rapidly
- Branch name can be copied with a single click from the header
- Clipboard contains the exact branch name (no parentheses or extra formatting)
- Right-clicking a model in the selector toggles the star icon
- Starred models appear in a "Favorites" section at the top of the dropdown
- Favorites persist across app restarts
- Each worktree row shows a relative time string on the right side of the status row
- Time string updates every 60 seconds without manual refresh
- "Open in Chrome" button appears when the Run tab shows a running dev server with a detected URL
- Clicking the button opens the URL in Chrome (or the custom command)
- Right-clicking allows configuring a custom Chrome launch command that persists
- Cmd+W closes the file tab when a file is focused, not the session
- Cmd+W still closes the session tab when no file is focused
- "CONFLICTS" button appears in the git panel header when conflicted files exist
- Clicking "CONFLICTS" creates a new session and auto-sends "Fix merge conflicts"

---

## Testing Plan

### Test Files to Create

| File                                                   | Features | Tests                                                                                             |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `test/phase-15/session-1/context-background.test.ts`   | 1        | Global listener token extraction, background session context, reconstruction guard                |
| `test/phase-15/session-2/tool-correlation.test.ts`     | 2        | Tool call correlation across tab switches, streaming parts preservation                           |
| `test/phase-15/session-3/question-persistence.test.ts` | 3        | Question survives tab switch, global listener handles question events, no clearSession on unmount |
| `test/phase-15/session-4/message-ordering.test.ts`     | 4        | Merge-based finalization, message order during concurrent send+finalize                           |
| `test/phase-15/session-5/copy-branch-name.test.tsx`    | 5        | Copy button renders, clipboard write, toast notification                                          |
| `test/phase-15/session-6/favorite-models.test.ts`      | 6        | Toggle favorite, persistence, sort order in dropdown, right-click interaction                     |
| `test/phase-15/session-7/last-message-time.test.ts`    | 7        | Relative time formatting, timestamp tracking, auto-refresh                                        |
| `test/phase-15/session-8/open-in-chrome.test.ts`       | 8        | URL detection from run output, button visibility, custom command persistence                      |
| `test/phase-15/session-9/cmd-w-file-close.test.ts`     | 9        | File tab close priority, diff view close, session close fallback                                  |
| `test/phase-15/session-10/merge-conflicts.test.tsx`    | 10       | Conflict detection, button visibility, session creation flow                                      |
