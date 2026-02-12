# Hive Phase 15 Implementation Plan

This document outlines the implementation plan for Hive Phase 15, focusing on context indicator bug fix, tool call correlation after tab switching, question dialog persistence across tabs, user message ordering, copy branch name, favorite models, worktree last-message time, open in Chrome, Cmd+W file tab close, and merge conflicts button.

---

## Overview

The implementation is divided into **13 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 15 builds upon Phase 14** — all Phase 14 infrastructure is assumed to be in place.

---

## Dependencies & Parallelization

```
Session 1  (Context Indicator Bug Fix)       ── no deps
Session 2  (Tool Call Correlation Fix)       ── no deps
Session 3  (Question Dialog Persistence)     ── no deps
Session 4  (User Message Ordering Fix)       ── no deps
Session 5  (Copy Branch Name)               ── no deps
Session 6  (Cmd+W File Tab Close)           ── no deps
Session 7  (Last Message Time Store)         ── no deps
Session 8  (Last Message Time UI)            ── blocked by Session 7 (needs store)
Session 9  (Favorite Models)                ── no deps
Session 10 (Open in Chrome Backend)          ── no deps
Session 11 (Open in Chrome UI)              ── blocked by Session 10 (needs IPC)
Session 12 (Merge Conflicts Button)          ── no deps
Session 13 (Integration & Verification)      ── blocked by Sessions 1-12
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────────┐
│  Time →                                                              │
│                                                                      │
│  Track A: [S1: Context Fix]                                          │
│  Track B: [S2: Tool Correlation]                                     │
│  Track C: [S3: Question Persist]                                     │
│  Track D: [S4: Message Order]                                        │
│  Track E: [S5: Copy Branch]                                          │
│  Track F: [S6: Cmd+W File Close]                                     │
│  Track G: [S7: Last Msg Store] → [S8: Last Msg UI]                  │
│  Track H: [S9: Favorite Models]                                      │
│  Track I: [S10: Chrome Backend] → [S11: Chrome UI]                   │
│  Track J: [S12: Merge Conflicts]                                     │
│                                                                      │
│  All ──────────────────────────────────────────► [S13: Integration]   │
└──────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 1-7, 9, 10, 12 are fully independent. Session 8 depends on Session 7 (status store). Session 11 depends on Session 10 (IPC handler).

**Minimum total**: 3 rounds:

1. (S1, S2, S3, S4, S5, S6, S7, S9, S10, S12 in parallel)
2. (S8, S11 — after their dependencies complete)
3. (S13)

**Recommended serial order** (if doing one at a time):

S3 → S4 → S2 → S1 → S6 → S5 → S7 → S8 → S12 → S9 → S10 → S11 → S13

Rationale: S3-S4 are the highest-impact bug fixes (stuck sessions, misordered messages), S2 fixes confusing detached tool results, S1 fixes context display, S6 and S5 are small UX fixes, S7-S8 are sequential store+UI work, S12 reuses existing patterns, S9 is a self-contained feature, S10-S11 are sequential Chrome work, S13 validates everything.

---

## Testing Infrastructure

### Test File Structure (Phase 15)

```
test/
├── phase-15/
│   ├── session-1/
│   │   └── context-background.test.ts
│   ├── session-2/
│   │   └── tool-correlation.test.ts
│   ├── session-3/
│   │   └── question-persistence.test.ts
│   ├── session-4/
│   │   └── message-ordering.test.ts
│   ├── session-5/
│   │   └── copy-branch-name.test.tsx
│   ├── session-6/
│   │   └── cmd-w-file-close.test.ts
│   ├── session-7/
│   │   └── last-message-time-store.test.ts
│   ├── session-8/
│   │   └── last-message-time-ui.test.tsx
│   ├── session-9/
│   │   └── favorite-models.test.ts
│   ├── session-10/
│   │   └── open-in-chrome-backend.test.ts
│   ├── session-11/
│   │   └── open-in-chrome-ui.test.tsx
│   ├── session-12/
│   │   └── merge-conflicts.test.tsx
│   └── session-13/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies — all features use existing packages:
# - zustand (stores — already installed)
# - lucide-react (icons — already installed)
# - sonner (toasts — already installed)
# - Electron APIs: shell, clipboard (built-in)
```

---

## Session 1: Context Indicator Bug Fix

### Objectives

- Fix background sessions showing 0 tokens by extracting context data in the global listener
- Guard `resetSessionTokens` during DB reconstruction to avoid clearing valid cached data when no tokens are found in the DB scan
- Ensure context indicator shows correct values immediately when switching to a session that completed in the background

### Tasks

#### 1. Add token extraction for background sessions in `useOpenCodeGlobalListener.ts`

In `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`, the existing `session.updated` handler (lines 36-42) only handles title updates. Replace the entire `session.updated` block with a broader `message.updated` handler that also extracts tokens for background sessions:

**Current code (lines 34-42):**

```typescript
if (event.type === 'session.updated' && sessionId !== activeId) {
  const sessionTitle = event.data?.info?.title || event.data?.title
  if (sessionTitle) {
    useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
  }
  return
}
```

**New code:**

```typescript
// Handle message.updated for background sessions — extract title + tokens
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

// Keep session.updated for background title sync (some events use this type)
if (event.type === 'session.updated' && sessionId !== activeId) {
  const sessionTitle = event.data?.info?.title || event.data?.title
  if (sessionTitle) {
    useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
  }
  return
}
```

Add the needed imports at the top:

```typescript
import { extractTokens, extractCost, extractModelRef } from '@/lib/token-utils'
import { useContextStore } from '@/stores/useContextStore'
```

#### 2. Guard `resetSessionTokens` in `loadMessagesFromDatabase`

In `src/renderer/src/components/sessions/SessionView.tsx`, the DB reconstruction (lines 769-801) calls `resetSessionTokens` before scanning. If the scan finds nothing, the session is left at 0 even if the global listener had already populated valid data.

**Current code (lines 772-801):**

```typescript
useContextStore.getState().resetSessionTokens(sessionId)
let totalCost = 0
let snapshotSet = false

for (let i = dbMessages.length - 1; i >= 0; i--) {
  // ... scan and extract ...
}
if (totalCost > 0) {
  useContextStore.getState().setSessionCost(sessionId, totalCost)
}
```

**New code — scan first, only reset+set if data was found:**

```typescript
let totalCost = 0
let snapshotSet = false
let snapshotTokens: TokenInfo | null = null
let snapshotModelRef: SessionModelRef | undefined

for (let i = dbMessages.length - 1; i >= 0; i--) {
  const msg = dbMessages[i]
  if (msg.role === 'assistant' && msg.opencode_message_json) {
    try {
      const msgJson = JSON.parse(msg.opencode_message_json)
      totalCost += extractCost(msgJson)

      if (!snapshotSet) {
        const tokens = extractTokens(msgJson)
        if (tokens) {
          snapshotTokens = tokens
          snapshotModelRef = extractModelRef(msgJson) ?? undefined
          snapshotSet = true
        }
      }
    } catch {
      // Ignore parse errors
    }
  }
}

// Only reset and apply if we found data — otherwise keep whatever
// the global listener or a previous load may have set
if (snapshotTokens || totalCost > 0) {
  useContextStore.getState().resetSessionTokens(sessionId)
  if (snapshotTokens) {
    useContextStore.getState().setSessionTokens(sessionId, snapshotTokens, snapshotModelRef)
  }
  if (totalCost > 0) {
    useContextStore.getState().setSessionCost(sessionId, totalCost)
  }
}
```

Add `TokenInfo` and `SessionModelRef` to imports from `@/stores/useContextStore` if not already present.

### Key Files

- `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` — add `message.updated` token extraction for background sessions
- `src/renderer/src/components/sessions/SessionView.tsx` — guard `resetSessionTokens` in `loadMessagesFromDatabase`

### Definition of Done

- [ ] Sessions completing in the background have non-zero context indicator values when switching to them
- [ ] Token extraction in the global listener correctly uses `extractTokens`, `extractCost`, `extractModelRef`
- [ ] `loadMessagesFromDatabase` does not reset valid cached tokens when DB scan finds no data
- [ ] Sessions with token data in the DB still reconstruct correctly on mount
- [ ] Active session token extraction (real-time streaming) is unaffected
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a worktree, start a session, send a message
2. Switch to a different worktree tab while the session is streaming
3. Wait for the session to complete (background)
4. Switch back — verify the context indicator shows non-zero values
5. Restart the app, open the same session — verify context reconstructs from DB
6. Stay on a session while it streams — verify real-time token updates still work

### Testing Criteria

```typescript
// test/phase-15/session-1/context-background.test.ts
describe('Session 1: Context Indicator Bug Fix', () => {
  test('global listener extracts tokens from message.updated for background sessions', () => {
    // Set activeSessionId to 'session-A'
    // Fire onStream with type: 'message.updated', sessionId: 'session-B'
    //   and data: { info: { time: { completed: '...' } }, tokens: { input: 100, output: 50 } }
    // Verify useContextStore.setSessionTokens called with 'session-B' and correct tokens
  })

  test('global listener does NOT extract tokens for the active session', () => {
    // Set activeSessionId to 'session-A'
    // Fire onStream with type: 'message.updated', sessionId: 'session-A'
    // Verify useContextStore.setSessionTokens NOT called (active session handles its own)
  })

  test('global listener extracts cost from message.updated', () => {
    // Fire onStream with message.updated carrying cost: 0.0123 for background session
    // Verify useContextStore.addSessionCost called with correct value
  })

  test('loadMessagesFromDatabase does not reset tokens when DB has no data', () => {
    // Set up useContextStore with valid tokens for session
    // Call loadMessagesFromDatabase with empty dbMessages array
    // Verify tokens were NOT reset (still present in store)
  })

  test('loadMessagesFromDatabase resets and sets when DB has token data', () => {
    // Set up dbMessages with assistant message containing tokens
    // Call loadMessagesFromDatabase
    // Verify resetSessionTokens then setSessionTokens called
  })
})
```

---

## Session 2: Tool Call Correlation Fix

### Objectives

- Fix tool call results appearing as detached entries after tab switching
- Preserve streaming parts across tab switches for sessions that are actively streaming
- Ensure `upsertToolUse` can always find the matching tool entry when a result arrives

### Tasks

#### 1. Conditional streaming parts clearing in `SessionView.tsx`

In `src/renderer/src/components/sessions/SessionView.tsx`, the session init effect (lines 821-834) clears streaming state unconditionally. Change it to preserve state for sessions that are actively streaming.

**Current code (lines 829-834):**

```typescript
streamingPartsRef.current = []
streamingContentRef.current = ''
childToSubtaskIndexRef.current = new Map()
setStreamingParts([])
setStreamingContent('')
hasFinalizedCurrentResponseRef.current = false
```

**New code:**

```typescript
// Only clear streaming display state if NOT currently streaming this session.
// When the user switches away and back to an actively-streaming session,
// we preserve streamingPartsRef so incoming tool results can find their
// matching callID via upsertToolUse instead of creating detached entries.
if (!isStreaming) {
  streamingPartsRef.current = []
  streamingContentRef.current = ''
  childToSubtaskIndexRef.current = new Map()
  setStreamingParts([])
  setStreamingContent('')
}
hasFinalizedCurrentResponseRef.current = false
```

#### 2. Don't clear streaming refs on unmount for active sessions

The cleanup at lines 1497-1502 unsubscribes the stream listener. However, the streaming state refs (`streamingPartsRef`) are React refs that live with the component instance — they are destroyed on unmount regardless.

The restoration at lines 1269-1288 reads from the DB. The problem is the DB may lag behind in-flight tool calls. Improve the restoration to merge with any already-present streaming parts instead of replacing:

**Current code (lines 1275-1288):**

```typescript
if (loadedMessages.length > 0) {
  const lastMsg = loadedMessages[loadedMessages.length - 1]
  if (lastMsg.role === 'assistant' && lastMsg.parts && lastMsg.parts.length > 0) {
    streamingPartsRef.current = lastMsg.parts.map((p) => ({ ...p }))
    setStreamingParts([...streamingPartsRef.current])
    // Also restore text content
    const textParts = lastMsg.parts.filter((p) => p.type === 'text')
    if (textParts.length > 0) {
      const content = textParts.map((p) => p.text || '').join('')
      streamingContentRef.current = content
      setStreamingContent(content)
    }
  }
}
```

**New code — merge DB parts with any already-present streaming parts:**

```typescript
if (loadedMessages.length > 0) {
  const lastMsg = loadedMessages[loadedMessages.length - 1]
  if (lastMsg.role === 'assistant' && lastMsg.parts && lastMsg.parts.length > 0) {
    const dbParts = lastMsg.parts.map((p) => ({ ...p }))

    if (streamingPartsRef.current.length > 0) {
      // Merge: DB parts are the base, but keep any streaming parts
      // that have a tool_use with a callID not yet in the DB parts
      const dbToolIds = new Set(
        dbParts.filter((p) => p.type === 'tool_use' && p.toolUse?.id).map((p) => p.toolUse!.id)
      )
      const extraParts = streamingPartsRef.current.filter(
        (p) => p.type === 'tool_use' && p.toolUse?.id && !dbToolIds.has(p.toolUse.id)
      )
      streamingPartsRef.current = [...dbParts, ...extraParts]
    } else {
      streamingPartsRef.current = dbParts
    }

    setStreamingParts([...streamingPartsRef.current])

    const textParts = streamingPartsRef.current.filter((p) => p.type === 'text')
    if (textParts.length > 0) {
      const content = textParts.map((p) => p.text || '').join('')
      streamingContentRef.current = content
      setStreamingContent(content)
    }
  }
}
```

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — conditional clearing, merge-based restoration

### Definition of Done

- [ ] Tool call results always merge into their originating tool card after tab switching
- [ ] No detached "orphan" tool result entries appear in the message stream
- [ ] Switching away and back to an actively-streaming session preserves the current tool state
- [ ] Sessions that are NOT streaming still get a clean state on entry
- [ ] Text content is preserved correctly across tab switches during streaming
- [ ] Finalization after streaming completes works correctly
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a session that triggers a `Write` tool call
2. While the tool is still running (spinner visible), switch to a different worktree tab
3. Wait a moment, then switch back
4. Verify the tool call result appears merged into the original tool card (single card, status updates from running → success)
5. Repeat with `Read` and `Bash` tools
6. Verify finalization (stream completion) still works after switching back
7. Switch to a session that is NOT streaming — verify clean state with no leftover parts

### Testing Criteria

```typescript
// test/phase-15/session-2/tool-correlation.test.ts
describe('Session 2: Tool Call Correlation Fix', () => {
  test('streaming parts preserved when isStreaming is true during init', () => {
    // Set isStreaming = true
    // Pre-populate streamingPartsRef with a tool_use part { id: 'tool-1', status: 'running' }
    // Trigger session init effect (re-mount)
    // Verify streamingPartsRef still contains the tool-1 part
  })

  test('streaming parts cleared when isStreaming is false during init', () => {
    // Set isStreaming = false
    // Pre-populate streamingPartsRef with parts
    // Trigger session init effect
    // Verify streamingPartsRef is empty
  })

  test('DB restoration merges with existing streaming parts', () => {
    // Set streamingPartsRef with tool_use { id: 'tool-2', status: 'running' }
    // Mock loadMessagesFromDatabase returning message with parts [text, tool_use { id: 'tool-1' }]
    // After restoration, verify streamingPartsRef contains both tool-1 (from DB) and tool-2 (preserved)
  })

  test('upsertToolUse finds existing tool after restoration', () => {
    // Restore parts from DB with tool_use { id: 'write-123', status: 'running' }
    // Call upsertToolUse('write-123', { status: 'success', output: '...' })
    // Verify the existing part is updated, no new part created
  })
})
```

---

## Session 3: Question Dialog Persistence

### Objectives

- Fix question dialogs disappearing when switching away from a worktree tab with a pending question
- Handle `question.asked` events in the global listener for background sessions
- Remove `clearSession` calls from SessionView unmount cleanup

### Tasks

#### 1. Remove `clearSession` from SessionView unmount

In `src/renderer/src/components/sessions/SessionView.tsx`, modify the cleanup function (lines 1497-1502):

**Current code:**

```typescript
return () => {
  unsubscribe()
  useQuestionStore.getState().clearSession(sessionId)
  usePermissionStore.getState().clearSession(sessionId)
}
```

**New code:**

```typescript
return () => {
  unsubscribe()
  // DO NOT clear questions or permissions — they must persist across tab switches.
  // They are removed individually when answered/rejected via removeQuestion/removePermission.
}
```

#### 2. Handle question events in the global listener

In `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`, add question event handling for background sessions. Add before the `session.status` check:

```typescript
import { useQuestionStore } from '@/stores/useQuestionStore'

// Inside the onStream handler:

// Handle question events for background sessions
if (event.type === 'question.asked' && sessionId !== activeId) {
  const request = event.data
  if (request?.id && request?.questions) {
    useQuestionStore.getState().addQuestion(sessionId, request)
    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'answering')
  }
  return
}

if (
  (event.type === 'question.replied' || event.type === 'question.rejected') &&
  sessionId !== activeId
) {
  const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
  if (requestId) {
    useQuestionStore.getState().removeQuestion(sessionId, requestId)
  }
  return
}
```

This ensures that when a question arrives while viewing a different tab, the question is stored and the worktree shows "Answer questions" status. When the user switches back, `SessionView` reads `getActiveQuestion(sessionId)` from the store and renders `QuestionPrompt`.

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — remove `clearSession` from unmount cleanup
- `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` — add `question.asked/replied/rejected` handling for background sessions

### Definition of Done

- [ ] Switching to a worktree tab with a pending question shows the question dialog immediately
- [ ] The question dialog is functional — answers can be submitted and rejected
- [ ] Questions arriving while on a different tab are stored and visible on switch back
- [ ] "Answer questions" amber status appears on the worktree row when a background question arrives
- [ ] Answering or rejecting a question removes it from the store correctly
- [ ] Multiple concurrent questions across different sessions are handled independently
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a session and trigger a question (e.g., through a tool that asks a question)
2. While the question is showing, switch to a different worktree tab
3. Verify the original worktree shows "Answer questions" with amber icon
4. Switch back to the original worktree
5. Verify the question dialog appears and is functional
6. Submit an answer — verify the session continues
7. Trigger another question on a background session (let it arrive while on another tab)
8. Switch to that session — verify the question appears

### Testing Criteria

```typescript
// test/phase-15/session-3/question-persistence.test.ts
describe('Session 3: Question Dialog Persistence', () => {
  test('questions survive SessionView unmount', () => {
    // Add a question to useQuestionStore for session-A
    // Mount SessionView for session-A — verify question renders
    // Unmount SessionView (simulate tab switch)
    // Verify useQuestionStore still has the question for session-A
  })

  test('global listener adds question for background session', () => {
    // Set activeSessionId to 'session-A'
    // Fire onStream with type: 'question.asked', sessionId: 'session-B'
    // Verify useQuestionStore.addQuestion called with 'session-B'
    // Verify useWorktreeStatusStore.setSessionStatus called with 'answering'
  })

  test('global listener ignores question events for active session', () => {
    // Set activeSessionId to 'session-A'
    // Fire onStream with type: 'question.asked', sessionId: 'session-A'
    // Verify useQuestionStore.addQuestion NOT called (active session handles its own)
  })

  test('global listener removes question on reply for background session', () => {
    // Add question to store for session-B
    // Fire onStream with type: 'question.replied', sessionId: 'session-B'
    // Verify useQuestionStore.removeQuestion called
  })

  test('question dialog renders when switching to session with pending question', () => {
    // Add question to useQuestionStore for session-A
    // Mount SessionView for session-A
    // Verify QuestionPrompt component renders with correct question data
  })
})
```

---

## Session 4: User Message Ordering Fix

### Objectives

- Fix user messages appearing at wrong positions when `finalizeResponseFromDatabase` races with new message sends
- Use merge-based replacement in `loadMessagesFromDatabase` instead of blind array replacement

### Tasks

#### 1. Merge-based message replacement in `loadMessagesFromDatabase`

In `src/renderer/src/components/sessions/SessionView.tsx`, modify `loadMessagesFromDatabase` (line 759):

**Current code:**

```typescript
const loadedMessages = dbMessages.map(dbMessageToOpenCode)
setMessages(loadedMessages)
```

**New code:**

```typescript
const loadedMessages = dbMessages.map(dbMessageToOpenCode)

setMessages((currentMessages) => {
  // Find any local messages not yet in the DB result
  // (e.g., user messages sent during async DB load)
  const loadedIds = new Set(loadedMessages.map((m) => m.id))
  const localOnly = currentMessages.filter((m) => !loadedIds.has(m.id))

  // Append local-only messages at the end to preserve user intent
  return localOnly.length > 0 ? [...loadedMessages, ...localOnly] : loadedMessages
})
```

This ensures that if a user sends a message while `finalizeResponseFromDatabase` is in flight, the user's message won't be lost or repositioned — it stays at the end of the list.

#### 2. Guard finalization when a new prompt is in flight

Add a ref to track whether a new prompt was sent during the current streaming cycle:

```typescript
const newPromptPendingRef = useRef(false)
```

In `handleSend`, set it to true:

```typescript
// In handleSend, after calling window.opencodeOps.prompt:
newPromptPendingRef.current = true
```

In `finalizeResponseFromDatabase`, check and skip full reload if a new prompt is pending — the next finalization cycle will capture everything:

```typescript
const finalizeResponseFromDatabase = async (): Promise<void> => {
  if (newPromptPendingRef.current) {
    // A new prompt was sent during this stream — skip full reload.
    // The next stream completion will finalize both responses.
    newPromptPendingRef.current = false
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

Reset the ref when a stream starts (in the `session.status busy` handler):

```typescript
if (status.type === 'busy') {
  setIsStreaming(true)
  newPromptPendingRef.current = false
}
```

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — merge-based `setMessages`, new prompt guard in finalization

### Definition of Done

- [ ] User messages always appear at the end of the message list (before streaming content)
- [ ] No message reordering occurs during finalization
- [ ] Sending a message while a previous response is finalizing does not lose or reorder the new message
- [ ] Fast sequential message sends maintain correct order
- [ ] Finalization still correctly loads assistant responses from the DB
- [ ] Token reconstruction in `loadMessagesFromDatabase` is unaffected
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a message to a session and wait for the response to complete
2. Immediately send another message before the finalization toast appears
3. Verify the second message appears below the first response (not in a random position)
4. Send 3-4 rapid messages — verify all appear in the correct order
5. Verify assistant responses still render correctly after finalization

### Testing Criteria

```typescript
// test/phase-15/session-4/message-ordering.test.ts
describe('Session 4: User Message Ordering Fix', () => {
  test('loadMessagesFromDatabase preserves locally-added messages', () => {
    // Set messages state to [msg-A, msg-B, msg-C] where msg-C was locally added
    // Call loadMessagesFromDatabase which returns [msg-A, msg-B] from DB
    // Verify final state is [msg-A, msg-B, msg-C] (msg-C preserved at end)
  })

  test('loadMessagesFromDatabase does not duplicate messages already in DB', () => {
    // Set messages state to [msg-A, msg-B]
    // Call loadMessagesFromDatabase which returns [msg-A, msg-B, msg-D]
    // Verify final state is [msg-A, msg-B, msg-D] (no duplicates)
  })

  test('finalization skips full reload when new prompt is pending', () => {
    // Set newPromptPendingRef.current = true
    // Call finalizeResponseFromDatabase
    // Verify loadMessagesFromDatabase was NOT called
    // Verify resetStreamingState was called
  })

  test('finalization performs full reload when no new prompt pending', () => {
    // Set newPromptPendingRef.current = false
    // Call finalizeResponseFromDatabase
    // Verify loadMessagesFromDatabase was called
  })

  test('newPromptPendingRef resets on session.status busy', () => {
    // Set newPromptPendingRef to true
    // Fire session.status { type: 'busy' }
    // Verify newPromptPendingRef is false
  })
})
```

---

## Session 5: Copy Branch Name Button

### Objectives

- Add a "Copy branch name" button in the window header next to the branch name text
- Show a toast confirmation on copy

### Tasks

#### 1. Add copy button to `Header.tsx`

In `src/renderer/src/components/layout/Header.tsx`, add a clipboard icon button next to the branch name span (lines 42-44):

**Current code (lines 39-45):**

```tsx
{selectedProject ? (
  <span className="text-sm font-medium truncate" data-testid="header-project-info">
    {selectedProject.name}
    {selectedWorktree?.branch_name && selectedWorktree.name !== '(no-worktree)' && (
      <span className="text-primary font-normal"> ({selectedWorktree.branch_name})</span>
    )}
  </span>
```

**New code:**

```tsx
{selectedProject ? (
  <span className="text-sm font-medium truncate" data-testid="header-project-info">
    {selectedProject.name}
    {selectedWorktree?.branch_name && selectedWorktree.name !== '(no-worktree)' && (
      <>
        <span className="text-primary font-normal"> ({selectedWorktree.branch_name})</span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            window.projectOps.copyToClipboard(selectedWorktree.branch_name)
            toast.success('Branch name copied')
          }}
          className="ml-1 p-0.5 rounded hover:bg-accent transition-colors inline-flex items-center"
          title="Copy branch name"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          data-testid="copy-branch-name"
        >
          <Copy className="h-3 w-3 text-muted-foreground" />
        </button>
      </>
    )}
  </span>
```

Add imports:

```typescript
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
```

The button uses `WebkitAppRegion: 'no-drag'` because the header is a window drag region (line 32).

### Key Files

- `src/renderer/src/components/layout/Header.tsx` — add copy button with clipboard icon

### Definition of Done

- [ ] A clipboard icon button appears next to the branch name in the header
- [ ] Clicking the button copies the branch name to the clipboard
- [ ] A "Branch name copied" toast appears on click
- [ ] The button is clickable (not captured by the window drag region)
- [ ] The button does not appear when there is no branch name (e.g., `(no-worktree)`)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Select a worktree with a branch name — verify the clipboard icon appears next to the branch name
2. Click the icon — verify "Branch name copied" toast appears
3. Paste into a text editor — verify the exact branch name was copied (no parentheses or extra text)
4. Select the default worktree with `(no-worktree)` — verify no icon appears
5. Try to drag the window by clicking the icon — verify the button is clickable, not a drag handle

### Testing Criteria

```typescript
// test/phase-15/session-5/copy-branch-name.test.tsx
describe('Session 5: Copy Branch Name', () => {
  test('copy button renders when branch name exists', () => {
    // Mock selectedWorktree with branch_name: 'feature/auth'
    // Render Header
    // Verify button with data-testid="copy-branch-name" exists
  })

  test('copy button not rendered for (no-worktree)', () => {
    // Mock selectedWorktree with name: '(no-worktree)'
    // Render Header
    // Verify no copy-branch-name button
  })

  test('clicking copy button calls copyToClipboard with branch name', async () => {
    const copyMock = vi.fn()
    // Mock window.projectOps.copyToClipboard = copyMock
    // Mock selectedWorktree with branch_name: 'feature/auth'
    // Render Header, click the copy button
    // Verify copyMock called with 'feature/auth'
  })
})
```

---

## Session 6: Cmd+W File Tab Close

### Objectives

- Make Cmd+W close the active file tab when a file is focused
- Only close the session tab when no file or diff is active
- Clear active diff view when a diff is focused

### Tasks

#### 1. Update `onCloseSessionShortcut` handler in `useKeyboardShortcuts.ts`

In `src/renderer/src/hooks/useKeyboardShortcuts.ts`, modify the handler (lines 114-134):

**Current code:**

```typescript
const cleanup = window.systemOps.onCloseSessionShortcut(() => {
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

**New code:**

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

Add import:

```typescript
import { useFileViewerStore } from '@/stores/useFileViewerStore'
```

### Key Files

- `src/renderer/src/hooks/useKeyboardShortcuts.ts` — check `activeFilePath` / `activeDiff` before closing session

### Definition of Done

- [ ] Cmd+W closes the active file tab when a file tab is focused
- [ ] After closing a file tab, the view switches to the session (or next file tab)
- [ ] Cmd+W clears the diff view when a diff is active
- [ ] Cmd+W closes the session tab when no file or diff is active
- [ ] Cmd+W never closes the Electron window (existing behavior preserved)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a file from the file tree (creates a file tab) — verify it's focused
2. Press Cmd+W — verify the file tab closes and the session tab becomes active
3. Open two file tabs — press Cmd+W — verify only the active file tab closes
4. Click a git file diff — press Cmd+W — verify the diff view closes
5. With no file or diff active — press Cmd+W — verify the session tab closes
6. Verify Cmd+W never closes the Electron window

### Testing Criteria

```typescript
// test/phase-15/session-6/cmd-w-file-close.test.ts
describe('Session 6: Cmd+W File Tab Close', () => {
  test('closes file tab when activeFilePath is set', () => {
    // Mock useFileViewerStore with activeFilePath: '/path/to/file.ts'
    // Fire onCloseSessionShortcut callback
    // Verify closeFile called with '/path/to/file.ts'
    // Verify closeSession NOT called
  })

  test('clears diff when activeDiff is set and no file active', () => {
    // Mock useFileViewerStore with activeFilePath: null, activeDiff: { ... }
    // Fire callback
    // Verify clearActiveDiff called
    // Verify closeSession NOT called
  })

  test('closes session when no file and no diff active', () => {
    // Mock useFileViewerStore with activeFilePath: null, activeDiff: null
    // Mock useSessionStore with activeSessionId: 'session-1'
    // Fire callback
    // Verify closeSession called with 'session-1'
  })

  test('no-op when nothing is active', () => {
    // Mock everything as null
    // Fire callback
    // Verify no close functions called
  })
})
```

---

## Session 7: Last Message Time Store

### Objectives

- Add per-worktree last-message-time tracking to `useWorktreeStatusStore`
- Create a `formatRelativeTime` utility function
- Update timestamp on message send and background session completion

### Tasks

#### 1. Add last-message-time state to `useWorktreeStatusStore.ts`

In `src/renderer/src/stores/useWorktreeStatusStore.ts`, add to the state interface and implementation:

```typescript
interface WorktreeStatusState {
  sessionStatuses: Record<string, SessionStatus | null>
  lastMessageTimeByWorktree: Record<string, number> // worktreeId → epoch ms

  // ... existing actions ...
  setLastMessageTime: (worktreeId: string, timestamp: number) => void
  getLastMessageTime: (worktreeId: string) => number | null
}
```

Add to the store:

```typescript
lastMessageTimeByWorktree: {},

setLastMessageTime: (worktreeId: string, timestamp: number) => {
  set((state) => ({
    lastMessageTimeByWorktree: {
      ...state.lastMessageTimeByWorktree,
      [worktreeId]: Math.max(
        state.lastMessageTimeByWorktree[worktreeId] ?? 0,
        timestamp
      )
    }
  }))
},

getLastMessageTime: (worktreeId: string) => {
  return get().lastMessageTimeByWorktree[worktreeId] ?? null
},
```

#### 2. Create `formatRelativeTime` utility

Create `src/renderer/src/lib/format-utils.ts`:

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

#### 3. Update timestamp on user message send

In `src/renderer/src/components/sessions/SessionView.tsx`, after saving the user message in `handleSend` (around line 1662):

```typescript
// Update last message time for the worktree
if (worktreeId) {
  useWorktreeStatusStore.getState().setLastMessageTime(worktreeId, Date.now())
}
```

#### 4. Update timestamp from the global listener on background session completion

In `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`, when a background session goes idle, update the last-message time. Resolve worktree from session using the session store:

```typescript
if (status?.type === 'idle' && sessionId !== activeId) {
  useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'unread')

  // Update last message time for the worktree
  const sessions = useSessionStore.getState().sessionsByWorktree
  for (const [worktreeId, wSessions] of sessions) {
    if (wSessions.some((s) => s.id === sessionId)) {
      useWorktreeStatusStore.getState().setLastMessageTime(worktreeId, Date.now())
      break
    }
  }
}
```

### Key Files

- `src/renderer/src/stores/useWorktreeStatusStore.ts` — add `lastMessageTimeByWorktree`, `setLastMessageTime`, `getLastMessageTime`
- `src/renderer/src/lib/format-utils.ts` — new file with `formatRelativeTime`
- `src/renderer/src/components/sessions/SessionView.tsx` — call `setLastMessageTime` in `handleSend`
- `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` — call `setLastMessageTime` on background session idle

### Definition of Done

- [ ] `setLastMessageTime` stores the latest timestamp per worktree (max of existing and new)
- [ ] `getLastMessageTime` returns the stored timestamp or null
- [ ] `formatRelativeTime` returns correct strings: "now", "3m", "2h", "1d", "2w"
- [ ] Sending a user message updates the worktree's last-message time
- [ ] Background session completion updates the worktree's last-message time
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Run `formatRelativeTime` tests to verify all time bracket outputs
2. Send a message in a session — verify `getLastMessageTime` returns a recent timestamp
3. Let a background session complete — verify the worktree's time updates

### Testing Criteria

```typescript
// test/phase-15/session-7/last-message-time-store.test.ts
describe('Session 7: Last Message Time Store', () => {
  test('formatRelativeTime returns "now" for < 1 minute', () => {
    expect(formatRelativeTime(Date.now() - 30000)).toBe('now')
  })

  test('formatRelativeTime returns "Xm" for minutes', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60000)).toBe('5m')
  })

  test('formatRelativeTime returns "Xh" for hours', () => {
    expect(formatRelativeTime(Date.now() - 3 * 3600000)).toBe('3h')
  })

  test('formatRelativeTime returns "Xd" for days', () => {
    expect(formatRelativeTime(Date.now() - 2 * 86400000)).toBe('2d')
  })

  test('formatRelativeTime returns "Xw" for weeks', () => {
    expect(formatRelativeTime(Date.now() - 14 * 86400000)).toBe('2w')
  })

  test('setLastMessageTime stores timestamp for worktree', () => {
    const store = useWorktreeStatusStore.getState()
    store.setLastMessageTime('wt-1', 1000)
    expect(store.getLastMessageTime('wt-1')).toBe(1000)
  })

  test('setLastMessageTime keeps max timestamp', () => {
    const store = useWorktreeStatusStore.getState()
    store.setLastMessageTime('wt-1', 2000)
    store.setLastMessageTime('wt-1', 1000) // older
    expect(store.getLastMessageTime('wt-1')).toBe(2000)
  })

  test('getLastMessageTime returns null for unknown worktree', () => {
    expect(useWorktreeStatusStore.getState().getLastMessageTime('unknown')).toBeNull()
  })
})
```

---

## Session 8: Last Message Time UI

### Objectives

- Display the relative time since the last message on each worktree row
- Auto-refresh the display every 60 seconds so "now" transitions to "1m" etc.

### Tasks

#### 1. Add relative time display to `WorktreeItem.tsx`

In `src/renderer/src/components/worktrees/WorktreeItem.tsx`, change the status row from a single `<span>` to a flex container:

**Current code (lines 302-307):**

```tsx
<span className={cn('text-[11px] block', statusClass)} data-testid="worktree-status-text">
  {displayStatus}
</span>
```

**New code:**

```tsx
<div className="flex items-center justify-between">
  <span className={cn('text-[11px]', statusClass)} data-testid="worktree-status-text">
    {displayStatus}
  </span>
  {lastMessageTime && (
    <span
      className="text-[10px] text-muted-foreground tabular-nums shrink-0 ml-1"
      title={new Date(lastMessageTime).toLocaleString()}
      data-testid="worktree-last-message-time"
    >
      {formatRelativeTime(lastMessageTime)}
    </span>
  )}
</div>
```

Add state and imports:

```typescript
import { formatRelativeTime } from '@/lib/format-utils'

const lastMessageTime = useWorktreeStatusStore((s) => s.getLastMessageTime(worktree.id))
```

#### 2. Add 60-second auto-refresh

Add a timer that forces re-render every 60 seconds so the relative time stays current:

```typescript
const [, setTick] = useState(0)
useEffect(() => {
  const timer = setInterval(() => setTick((n) => n + 1), 60000)
  return () => clearInterval(timer)
}, [])
```

Place this inside the `WorktreeItem` component body, or in a parent like `WorktreeList` so a single timer covers all items.

### Key Files

- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — display relative time, auto-refresh timer

### Definition of Done

- [ ] Each worktree row shows a relative time string on the right side of the status row
- [ ] Time string formats: "now", "3m", "2h", "1d", "2w"
- [ ] Time string is gray (`text-muted-foreground`) and small (`text-[10px]`)
- [ ] Time has a tooltip showing the full date/time on hover
- [ ] Worktrees with no messages show no time string
- [ ] Time auto-refreshes every 60 seconds (e.g., "now" → "1m")
- [ ] The time does not interfere with the status text layout
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a message in a session — verify "now" appears on the right side of the worktree row
2. Wait 60+ seconds — verify it changes to "1m"
3. Switch to a worktree that has never had messages — verify no time string appears
4. Hover over the time — verify a full date/time tooltip appears
5. Verify the status text ("Working", "Ready", etc.) is still left-aligned and unchanged

### Testing Criteria

```typescript
// test/phase-15/session-8/last-message-time-ui.test.tsx
describe('Session 8: Last Message Time UI', () => {
  test('renders relative time when lastMessageTime exists', () => {
    // Mock useWorktreeStatusStore.getLastMessageTime to return Date.now() - 120000
    // Render WorktreeItem
    // Verify text "2m" appears in the element with data-testid="worktree-last-message-time"
  })

  test('does not render time when no lastMessageTime', () => {
    // Mock getLastMessageTime to return null
    // Render WorktreeItem
    // Verify no element with data-testid="worktree-last-message-time"
  })

  test('time element has tooltip with full date', () => {
    // Mock getLastMessageTime to return a timestamp
    // Render WorktreeItem
    // Verify the time element has a title attribute containing a date string
  })

  test('status text and time are in a flex row', () => {
    // Render WorktreeItem with status and time
    // Verify parent element has flex + justify-between classes
  })
})
```

---

## Session 9: Favorite Models

### Objectives

- Add `favoriteModels` to the settings store for persistence
- Add right-click to toggle favorite on model items in the dropdown
- Show a "Favorites" section at the top of the model dropdown with starred models

### Tasks

#### 1. Add `favoriteModels` to `useSettingsStore.ts`

In `src/renderer/src/stores/useSettingsStore.ts`:

Add to `AppSettings` interface:

```typescript
export interface AppSettings {
  // ... existing fields
  favoriteModels: string[] // Array of "providerID::modelID" keys
}
```

Add to `DEFAULT_SETTINGS`:

```typescript
const DEFAULT_SETTINGS: AppSettings = {
  // ... existing
  favoriteModels: []
}
```

Add to `SettingsState` interface:

```typescript
toggleFavoriteModel: (providerID: string, modelID: string) => void
```

Add action:

```typescript
toggleFavoriteModel: (providerID: string, modelID: string) => {
  const key = `${providerID}::${modelID}`
  const current = get().favoriteModels
  const updated = current.includes(key)
    ? current.filter((k) => k !== key)
    : [...current, key]
  set({ favoriteModels: updated })
  const settings = extractSettings({ ...get(), favoriteModels: updated } as SettingsState)
  saveToDatabase(settings)
},
```

Add `favoriteModels` to `extractSettings` and `partialize`.

#### 2. Add favorites section and right-click to `ModelSelector.tsx`

In `src/renderer/src/components/sessions/ModelSelector.tsx`:

Add store access:

```typescript
const favoriteModels = useSettingsStore((s) => s.favoriteModels)
const toggleFavoriteModel = useSettingsStore((s) => s.toggleFavoriteModel)
```

Add favorite helpers:

```typescript
const isFavorite = useCallback(
  (model: ModelInfo) => favoriteModels.includes(`${model.providerID}::${model.id}`),
  [favoriteModels]
)

const favoriteModelObjects = useMemo(
  () => providers.flatMap((p) => p.models.filter((m) => isFavorite(m))),
  [providers, isFavorite]
)
```

Before the `filteredProviders.map(...)` block (around line 231), add a favorites section:

```tsx
{
  favoriteModelObjects.length > 0 && (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground flex items-center gap-1">
        <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" /> Favorites
      </DropdownMenuLabel>
      {favoriteModelObjects.map((model) => (
        <DropdownMenuItem
          key={`fav-${model.providerID}:${model.id}`}
          onClick={() => handleSelectModel(model)}
          onContextMenu={(e) => {
            e.preventDefault()
            toggleFavoriteModel(model.providerID, model.id)
          }}
          className="flex items-center justify-between gap-2 cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />
            <span className="truncate text-sm">{getDisplayName(model)}</span>
          </span>
          {isActiveModel(model) && <Check className="h-4 w-4 shrink-0 text-primary" />}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
    </>
  )
}
```

Add `onContextMenu` to each regular `DropdownMenuItem` (line 242-253):

```tsx
<DropdownMenuItem
  onClick={() => handleSelectModel(model)}
  onContextMenu={(e) => {
    e.preventDefault()
    toggleFavoriteModel(model.providerID, model.id)
  }}
  className="flex items-center justify-between gap-2 cursor-pointer"
  data-testid={`model-item-${model.id}`}
>
  <span className="flex items-center gap-1.5">
    {isFavorite(model) && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />}
    <span className="truncate text-sm">{getDisplayName(model)}</span>
  </span>
  {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
</DropdownMenuItem>
```

Add import:

```typescript
import { Star } from 'lucide-react'
```

### Key Files

- `src/renderer/src/stores/useSettingsStore.ts` — add `favoriteModels`, `toggleFavoriteModel`
- `src/renderer/src/components/sessions/ModelSelector.tsx` — favorites section, right-click toggle, star icons

### Definition of Done

- [ ] Right-clicking a model in the dropdown toggles its favorite status
- [ ] Starred models appear in a "Favorites" section at the top of the dropdown
- [ ] Starred models show a filled yellow star icon in both the favorites section and their normal provider section
- [ ] Un-starring a model (right-click again) removes it from the favorites section
- [ ] Clicking a favorited model in the favorites section selects it as the active model
- [ ] Favorites persist across app restarts (stored in settings DB + localStorage)
- [ ] The "Favorites" section header only appears when at least one model is favorited
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open the model dropdown — verify no favorites section initially
2. Right-click a model — verify a star appears next to it and a "Favorites" section appears at the top
3. Right-click the same model again — verify the star is removed and the favorites section disappears
4. Star 2-3 models — verify they all appear in the favorites section
5. Click a model in the favorites section — verify it becomes the active model
6. Restart the app — verify favorites persist
7. Use the filter input — verify favorites section still works with filtered results

### Testing Criteria

```typescript
// test/phase-15/session-9/favorite-models.test.ts
describe('Session 9: Favorite Models', () => {
  test('toggleFavoriteModel adds model to favorites', () => {
    const store = useSettingsStore.getState()
    store.toggleFavoriteModel('anthropic', 'claude-sonnet-4')
    expect(store.favoriteModels).toContain('anthropic::claude-sonnet-4')
  })

  test('toggleFavoriteModel removes model from favorites', () => {
    const store = useSettingsStore.getState()
    store.toggleFavoriteModel('anthropic', 'claude-sonnet-4') // add
    store.toggleFavoriteModel('anthropic', 'claude-sonnet-4') // remove
    expect(store.favoriteModels).not.toContain('anthropic::claude-sonnet-4')
  })

  test('favoriteModels persists in extractSettings', () => {
    // Set favoriteModels to ['anthropic::claude-sonnet-4']
    // Verify extractSettings includes favoriteModels
  })

  test('favorites section renders when favorites exist', () => {
    // Mock useSettingsStore.favoriteModels with one entry
    // Mock providers with matching model
    // Render ModelSelector, open dropdown
    // Verify "Favorites" label is visible
  })

  test('favorites section hidden when no favorites', () => {
    // Mock useSettingsStore.favoriteModels as empty
    // Render ModelSelector, open dropdown
    // Verify "Favorites" label is NOT visible
  })
})
```

---

## Session 10: Open in Chrome Backend

### Objectives

- Add IPC handler for opening a URL in Chrome with optional custom command
- Add preload bridge and type declarations
- Add `customChromeCommand` to settings store

### Tasks

#### 1. Add `customChromeCommand` to `useSettingsStore.ts`

In `src/renderer/src/stores/useSettingsStore.ts`:

Add to `AppSettings`:

```typescript
customChromeCommand: string // Custom chrome launch command, e.g. "open -n -a ..."
```

Add to `DEFAULT_SETTINGS`:

```typescript
customChromeCommand: ''
```

Add to `extractSettings` and `partialize`.

#### 2. Add IPC handler

In `src/main/ipc/system-handlers.ts` (or create if needed), add a handler for `system:openInChrome`:

```typescript
import { shell } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

ipcMain.handle(
  'system:openInChrome',
  async (_event, { url, customCommand }: { url: string; customCommand?: string }) => {
    try {
      if (customCommand) {
        const cmd = customCommand.replace(/\{url\}/g, url)
        await execAsync(cmd)
      } else {
        await shell.openExternal(url)
      }
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)
```

Register this handler in `src/main/index.ts` if using a new file.

#### 3. Add preload bridge

In `src/preload/index.ts`, add to the `systemOps` namespace:

```typescript
openInChrome: (url: string, customCommand?: string) =>
  ipcRenderer.invoke('system:openInChrome', { url, customCommand }),
```

#### 4. Add type declaration

In `src/preload/index.d.ts`, add to the `SystemOps` interface:

```typescript
openInChrome: (url: string, customCommand?: string) => Promise<{ success: boolean; error?: string }>
```

### Key Files

- `src/renderer/src/stores/useSettingsStore.ts` — add `customChromeCommand`
- `src/main/ipc/system-handlers.ts` — add `system:openInChrome` IPC handler
- `src/preload/index.ts` — add `openInChrome` to `systemOps`
- `src/preload/index.d.ts` — add type declaration

### Definition of Done

- [ ] `window.systemOps.openInChrome(url)` opens the URL in the default browser
- [ ] `window.systemOps.openInChrome(url, customCmd)` runs the custom command with `{url}` replaced
- [ ] The handler returns `{ success: true }` on success
- [ ] The handler returns `{ success: false, error: '...' }` on failure
- [ ] `customChromeCommand` is stored and persisted in the settings store
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Call `window.systemOps.openInChrome('http://localhost:3000')` from the dev console — verify browser opens
2. Set a custom command and call with it — verify the custom command runs
3. Pass an invalid command — verify error is returned

### Testing Criteria

```typescript
// test/phase-15/session-10/open-in-chrome-backend.test.ts
describe('Session 10: Open in Chrome Backend', () => {
  test('customChromeCommand defaults to empty string', () => {
    expect(useSettingsStore.getState().customChromeCommand).toBe('')
  })

  test('customChromeCommand persists via updateSetting', () => {
    const store = useSettingsStore.getState()
    store.updateSetting('customChromeCommand', 'open -a Chrome {url}')
    expect(store.customChromeCommand).toBe('open -a Chrome {url}')
  })

  test('openInChrome type declaration matches expected signature', () => {
    // TypeScript compilation validates this — no runtime test needed
    // Verified by pnpm lint passing
  })
})
```

---

## Session 11: Open in Chrome UI

### Objectives

- Detect dev server URLs from run output
- Show an "Open in Chrome" button in the session tab bar when a web app is running
- Add a right-click configuration popover for the custom Chrome command

### Tasks

#### 1. Add URL detection utility

In `src/renderer/src/lib/format-utils.ts` (already created in Session 7), add:

```typescript
const DEV_SERVER_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{3,5}\/?/

export function extractDevServerUrl(output: string[]): string | null {
  // Scan last 50 lines for a dev server URL
  for (let i = output.length - 1; i >= Math.max(0, output.length - 50); i--) {
    const match = output[i].match(DEV_SERVER_URL_PATTERN)
    if (match) return match[0]
  }
  return null
}
```

#### 2. Add "Open in Chrome" button to `SessionTabs.tsx`

In `src/renderer/src/components/sessions/SessionTabs.tsx`, add state and rendering after the right scroll arrow (around line 496):

```typescript
import { Globe } from 'lucide-react'
import { useScriptStore } from '@/stores/useScriptStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { extractDevServerUrl } from '@/lib/format-utils'

// Inside the component:
const runOutput = useScriptStore((s) =>
  selectedWorktreeId ? s.scriptStates[selectedWorktreeId]?.runOutput : null
)
const runRunning = useScriptStore((s) =>
  selectedWorktreeId ? (s.scriptStates[selectedWorktreeId]?.runRunning ?? false) : false
)
const activeBottomTab = useLayoutStore((s) => s.activeBottomTab)
const customChromeCommand = useSettingsStore((s) => s.customChromeCommand)

const detectedUrl = useMemo(() => {
  if (!runRunning || activeBottomTab !== 'run' || !runOutput) return null
  return extractDevServerUrl(runOutput)
}, [runRunning, activeBottomTab, runOutput])

const [chromeConfigOpen, setChromeConfigOpen] = useState(false)
const [chromeCommandInput, setChromeCommandInput] = useState(customChromeCommand)
```

Render after the right scroll arrow:

```tsx
{
  detectedUrl && (
    <div className="relative shrink-0 border-l border-border">
      <button
        onClick={() => {
          window.systemOps.openInChrome(detectedUrl, customChromeCommand || undefined)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setChromeCommandInput(customChromeCommand)
          setChromeConfigOpen(true)
        }}
        className="flex items-center gap-1 px-2 py-1.5 text-xs hover:bg-accent transition-colors"
        title={`Open ${detectedUrl} in Chrome (right-click to configure)`}
        data-testid="open-in-chrome"
      >
        <Globe className="h-3.5 w-3.5" />
        <span className="text-[11px]">Chrome</span>
      </button>
      {chromeConfigOpen && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-popover border rounded-md shadow-md p-3 w-80">
          <label className="text-xs font-medium block mb-1">Custom Chrome Command</label>
          <p className="text-[10px] text-muted-foreground mb-2">
            Use {'{url}'} as placeholder. Leave empty for default browser.
          </p>
          <input
            value={chromeCommandInput}
            onChange={(e) => setChromeCommandInput(e.target.value)}
            placeholder='open -a "Google Chrome" {url}'
            className="w-full text-xs bg-background border rounded px-2 py-1 mb-2"
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="flex justify-end gap-1">
            <button
              onClick={() => setChromeConfigOpen(false)}
              className="text-xs px-2 py-1 rounded hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                useSettingsStore.getState().updateSetting('customChromeCommand', chromeCommandInput)
                setChromeConfigOpen(false)
                toast.success('Chrome command saved')
              }}
              className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

### Key Files

- `src/renderer/src/lib/format-utils.ts` — add `extractDevServerUrl`
- `src/renderer/src/components/sessions/SessionTabs.tsx` — add Chrome button and config popover

### Definition of Done

- [ ] "Open in Chrome" button appears in the tab bar when the Run tab is active and a dev server URL is detected
- [ ] Clicking the button opens the detected URL in Chrome (or default browser)
- [ ] Right-clicking the button shows a configuration popover for the custom Chrome command
- [ ] Saving a custom command persists it and uses it for future opens
- [ ] The button disappears when the run process stops or the Run tab is deselected
- [ ] URL detection works for common dev servers: `localhost:3000`, `127.0.0.1:5173`, `0.0.0.0:8080`
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Configure a run script that starts a Next.js/Vite dev server
2. Press Cmd+R to run — wait for the server URL to appear in output
3. Switch to the Run tab — verify the "Chrome" button appears in the tab bar
4. Click the button — verify the URL opens in a browser
5. Right-click the button — verify the config popover appears
6. Enter a custom Chrome command with `{url}` — click Save — verify toast appears
7. Click the button again — verify it uses the custom command
8. Stop the run process — verify the button disappears
9. Switch away from the Run tab — verify the button disappears

### Testing Criteria

```typescript
// test/phase-15/session-11/open-in-chrome-ui.test.tsx
describe('Session 11: Open in Chrome UI', () => {
  test('extractDevServerUrl finds localhost URL', () => {
    const output = ['Starting server...', '  > Local:   http://localhost:3000/', 'ready']
    expect(extractDevServerUrl(output)).toBe('http://localhost:3000/')
  })

  test('extractDevServerUrl finds 127.0.0.1 URL', () => {
    const output = ['Server running at http://127.0.0.1:5173']
    expect(extractDevServerUrl(output)).toBe('http://127.0.0.1:5173')
  })

  test('extractDevServerUrl returns null when no URL found', () => {
    const output = ['Building...', 'Done.']
    expect(extractDevServerUrl(output)).toBeNull()
  })

  test('extractDevServerUrl scans last 50 lines only', () => {
    const output = Array(100).fill('noise')
    output[10] = 'http://localhost:3000' // too far back
    expect(extractDevServerUrl(output)).toBeNull()
  })

  test('Chrome button renders when URL detected and run tab active', () => {
    // Mock useScriptStore with runRunning: true, runOutput containing URL
    // Mock useLayoutStore with activeBottomTab: 'run'
    // Render SessionTabs
    // Verify button with data-testid="open-in-chrome" exists
  })

  test('Chrome button hidden when run tab not active', () => {
    // Mock activeBottomTab: 'terminal'
    // Verify no open-in-chrome button
  })
})
```

---

## Session 12: Merge Conflicts Button

### Objectives

- Detect merge-conflicted files from git status
- Show a bold "CONFLICTS" button next to the review button when conflicts exist
- Clicking the button creates a new session and auto-sends "Fix merge conflicts"

### Tasks

#### 1. Detect conflicted files and add handler in `GitStatusPanel.tsx`

In `src/renderer/src/components/git/GitStatusPanel.tsx`, add conflict detection:

```typescript
const conflictedFiles = useMemo(() => fileStatuses.filter((f) => f.status === 'C'), [fileStatuses])
const hasConflicts = conflictedFiles.length > 0

const [isFixingConflicts, setIsFixingConflicts] = useState(false)
```

Add the `handleFixConflicts` callback (follows the same pattern as `handleReview` at lines 255-326):

```typescript
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

    const sessionStore = useSessionStore.getState()
    const result = await sessionStore.createSession(selectedWorktreeId, projectId)
    if (!result.success || !result.session) {
      toast.error('Failed to create session')
      return
    }

    await sessionStore.updateSessionName(result.session.id, `Merge Conflicts — ${branchName}`)

    sessionStore.setPendingMessage(result.session.id, 'Fix merge conflicts')
  } catch (error) {
    console.error('Failed to start conflict resolution:', error)
    toast.error('Failed to start conflict resolution')
  } finally {
    setIsFixingConflicts(false)
  }
}, [worktreePath, branchInfo])
```

#### 2. Add the "CONFLICTS" button to the header

In the header buttons area (lines 362-389), add before the review button:

```tsx
import { AlertTriangle } from 'lucide-react'

// Inside <div className="flex items-center gap-0.5">:
{
  hasConflicts && (
    <Button
      variant="ghost"
      size="sm"
      className="h-5 px-1.5 text-[10px] font-bold text-orange-500 hover:text-orange-400 hover:bg-orange-500/10"
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
  )
}
```

### Key Files

- `src/renderer/src/components/git/GitStatusPanel.tsx` — conflict detection, "CONFLICTS" button, `handleFixConflicts`

### Definition of Done

- [ ] "CONFLICTS" button appears in bold orange when any conflicted files (`status === 'C'`) exist
- [ ] The button shows the AlertTriangle icon and text "CONFLICTS"
- [ ] Clicking the button creates a new session named "Merge Conflicts — {branchName}"
- [ ] The session auto-sends "Fix merge conflicts" as the first message
- [ ] The button shows a spinner while creating the session
- [ ] The button is hidden when there are no conflicts
- [ ] The review button and refresh button continue to work alongside the conflicts button
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a merge conflict: make conflicting changes on two branches, merge one into the other
2. Open the git panel — verify "CONFLICTS" button appears in bold orange
3. Click the button — verify a new session is created
4. Verify the session name is "Merge Conflicts — {branchName}"
5. Verify "Fix merge conflicts" is auto-sent as the first message
6. Resolve the conflicts, refresh git status — verify the button disappears
7. Verify the review button still works independently

### Testing Criteria

```typescript
// test/phase-15/session-12/merge-conflicts.test.tsx
describe('Session 12: Merge Conflicts Button', () => {
  test('CONFLICTS button renders when conflicted files exist', () => {
    // Mock useGitStore with files containing status: 'C'
    // Render GitStatusPanel
    // Verify button with data-testid="git-merge-conflicts-button" exists
    // Verify it contains text "CONFLICTS"
  })

  test('CONFLICTS button hidden when no conflicts', () => {
    // Mock useGitStore with files containing only status: 'M', 'A', '?'
    // Render GitStatusPanel
    // Verify no git-merge-conflicts-button
  })

  test('clicking CONFLICTS creates session with correct name', async () => {
    const createSession = vi.fn().mockResolvedValue({ success: true, session: { id: 's1' } })
    const updateSessionName = vi.fn()
    const setPendingMessage = vi.fn()
    // Mock stores with conflicted files and branch name 'feature/auth'
    // Click CONFLICTS button
    // Verify createSession called
    // Verify updateSessionName called with 'Merge Conflicts — feature/auth'
    // Verify setPendingMessage called with 'Fix merge conflicts'
  })

  test('button shows spinner while creating session', async () => {
    // Mock createSession to return a pending promise
    // Click CONFLICTS button
    // Verify Loader2 spinner is visible
  })
})
```

---

## Session 13: Integration & Verification

### Objectives

- Verify all Phase 15 features work correctly together
- Test cross-feature interactions
- Run lint and tests
- Fix any edge cases or regressions

### Tasks

#### 1. Context + tab switching interaction

- Start a session, send a message, switch to another worktree
- Wait for completion — verify context indicator shows correct values on switch back
- Verify "unread" dot also appears on the worktree row

#### 2. Tool correlation + question persistence interaction

- Start a session that triggers a tool call AND a question
- Switch away while the tool is running
- Switch back — verify tool result is merged correctly AND question dialog appears

#### 3. Message ordering + context indicator

- Send messages rapidly in a session
- Verify all messages appear in order
- Verify context indicator updates correctly with each response

#### 4. Copy branch name + Cmd+W

- Open a file tab from the file tree
- Copy the branch name from the header — verify it works while file tab is active
- Press Cmd+W — verify the file tab closes (not the session)
- Press Cmd+W again — verify the session closes

#### 5. Favorite models + model selector

- Star two models via right-click
- Open the dropdown — verify favorites section appears at top
- Select a favorite — verify it becomes active
- Send a message — verify the model is used correctly

#### 6. Last message time + worktree status

- Send a message — verify "now" appears on the worktree row
- Start a session on a second worktree, switch away
- Let it complete — verify time updates and "unread" dot appears together

#### 7. Open in Chrome + run tab

- Start a dev server via the Run tab
- Verify "Chrome" button appears in the tab bar
- Click it — verify browser opens
- Right-click, set a custom command, save — verify it persists
- Stop the server — verify button disappears

#### 8. Merge conflicts + question flow

- Create a merge conflict
- Verify CONFLICTS button appears
- Click it — verify session creates and sends prompt
- If the LLM asks a question during conflict resolution, verify the question dialog works

#### 9. Full smoke test

Walk through the complete flow:

1. Open app → select a worktree → verify context indicator from previous sessions loads
2. Star a model → select it → send a message → verify "now" appears on worktree row
3. Copy branch name from header → verify clipboard
4. Open a file tab → press Cmd+W → verify file tab closes, not session
5. Start another session on a different worktree → switch away → let it complete
6. Switch back → verify context indicator, last-message time, and unread status
7. Start a dev server → switch to Run tab → verify Chrome button → click it
8. Create a merge conflict → verify CONFLICTS button → click it → verify auto-sent prompt
9. Trigger a question → switch away → switch back → verify question dialog persists
10. Verify no detached tool results across any tab switches

#### 10. Run lint and tests

```bash
pnpm lint
pnpm test
```

Fix any failures.

### Key Files

- All files modified in Sessions 1-12

### Definition of Done

- [ ] All 10 features work correctly in isolation
- [ ] Cross-feature interactions work (context + tab switch, question + tool correlation, etc.)
- [ ] No regressions from Phase 14 features (custom icons, drag reorder, dock badge, etc.)
- [ ] `pnpm lint` passes with no new warnings
- [ ] `pnpm test` passes with all Phase 15 tests green
- [ ] App starts and runs without console errors
- [ ] No TypeScript compilation errors

### Testing Criteria

```typescript
// test/phase-15/session-13/integration-verification.test.ts
describe('Session 13: Integration Verification', () => {
  test('all Phase 15 features compile without errors', () => {
    // This is validated by `pnpm lint` passing
  })

  test('all Phase 15 test suites pass', () => {
    // This is validated by `pnpm test` passing
  })
})
```
