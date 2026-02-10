# Hive — Phase 10 Product Requirements Document

## Overview

**Phase 10** focuses on **interactive AI communication, scroll UX correctness, tool display parity, workspace navigation, and slash command execution**. The work spans five features: implementing interactive question prompts so the AI can ask clarifying questions mid-session, fixing the scroll-to-bottom FAB from appearing prematurely during streaming, displaying the target file name in Write tool cards to match Edit tool parity, adding a "Show in Finder" action to the QuickActions dropdown, and making slash commands invoke the SDK's dedicated command endpoint with automatic mode switching based on the command's agent field.

### Phase 10 Goals

- Enable the AI to ask interactive questions (single-choice, multi-choice, free-text) that the user can answer inline, with answers fed back to continue the session
- Stop the scroll-to-bottom FAB from flickering during streaming — only show it after the user has intentionally scrolled up
- Show the target file path in Write tool cards with the same prominence as Edit tool cards
- Add a "Show in Finder" option to the QuickActions split-button dropdown alongside Cursor, Ghostty, and Copy Path
- Route slash commands through the SDK's `session.command()` endpoint instead of sending raw `/command` text as a prompt, and auto-switch between Build/Plan mode based on the command's `agent` field

---

## Technical Additions

| Component               | Technology                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Interactive Questions   | OpenCode SDK `question.asked/replied/rejected` events, `client.question.reply/reject`, Zustand store  |
| Scroll FAB Fix          | New `userHasScrolledUpRef` flag gating FAB visibility in `SessionView.tsx` scroll handler             |
| Write Tool File Name    | Fix `ReadToolView` expanded view to show file path header, matching `EditToolView` pattern            |
| Show in Finder          | Existing `shell:showItemInFolder` IPC channel, new entry in `QuickActions.tsx` ACTIONS array          |
| Slash Command Execution | SDK `client.session.command()`, new IPC channel `opencode:command`, auto mode-switch on `agent` field |

---

## Features

### 1. Interactive Question Prompts

#### 1.1 Current State

The OpenCode SDK has full support for interactive questions. The `@opencode-ai/sdk` package (v1.1.51) includes:

- **Types** in `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts`:
  - `QuestionOption` — `{ label: string; description: string }`
  - `QuestionInfo` — `{ question: string; header: string; options: QuestionOption[]; multiple?: boolean; custom?: boolean }`
  - `QuestionRequest` — `{ id: string; sessionID: string; questions: QuestionInfo[]; tool?: { messageID: string; callID: string } }`
  - `QuestionAnswer` — `Array<string>` (selected labels)
  - `EventQuestionAsked` — `{ type: 'question.asked'; properties: QuestionRequest }`
  - `EventQuestionReplied` / `EventQuestionRejected` — session/request cleanup events

- **SDK client methods** in `sdk.gen.d.ts`:
  - `client.question.list()` — GET `/question`
  - `client.question.reply({ requestID, answers })` — POST `/question/{requestID}/reply`
  - `client.question.reject({ requestID })` — POST `/question/{requestID}/reject`

However, Hive currently ignores all `question.*` events entirely:

- `src/main/services/opencode-service.ts` line 939 — `handleEvent()` extracts `eventType` but has no special handling for `question.asked`, `question.replied`, or `question.rejected`. These events pass through the generic forwarding at line 1050 (`sendToRenderer('opencode:stream', streamEvent)`), but the renderer does not process them.
- `src/renderer/src/components/sessions/SessionView.tsx` — The stream event handler (lines 830-1070) has branches for `message.part.updated`, `message.updated`, `session.idle`, `session.status`, and `session.error`, but no branch for any `question.*` event type.
- There is **no mechanism** to send responses back to the SDK. The only user-to-SDK communication is `prompt()` (line 756 of `opencode-service.ts`). No `question.reply()` or `question.reject()` methods exist in the service or IPC layer.
- If a question tool call appears, it would render as a regular `tool_use` part with `name: "question"` and fall through to `TodoToolView` (the raw JSON fallback) since `"question"` is not in the `TOOL_RENDERERS` map (line 163 of `ToolCard.tsx`). There would be no interactive UI.

**Reference implementation**: The OpenCode official client at `/Users/mor/Documents/dev/opencode` handles this fully. Key files:

- `packages/opencode/src/question/index.ts` — Question namespace (data model, ask/reply/reject, events, pending state)
- `packages/opencode/src/tool/question.ts` — QuestionTool definition (blocks until user answers)
- `packages/opencode/src/tool/question.txt` — Tool description/prompt for the AI
- `packages/ui/src/components/message-part.tsx` — Inline QuestionPrompt component (matches tool's callID to render in-place)
- `packages/app/src/components/question-dock.tsx` — QuestionDock component (docked at prompt area)
- `packages/app/src/context/global-sync/event-reducer.ts` — Event reducer (handles question.asked/replied/rejected SSE events)
- `packages/sdk/js/src/v2/gen/types.gen.ts` — Generated SDK types (QuestionOption, QuestionInfo, QuestionRequest, etc.)

#### 1.2 New Design

The question flow in Hive mirrors the OpenCode client architecture but adapted for the Electron IPC model:

```
Event Flow:

  1. AI invokes "question" tool → SDK blocks tool execution
  2. Server emits SSE: { type: "question.asked", properties: QuestionRequest }
  3. Main process handleEvent() detects "question.asked" → forwards to renderer
  4. Renderer stream handler stores QuestionRequest in useQuestionStore
  5. SessionView detects pending question → renders QuestionPrompt inline
  6. User selects options / types custom answer → clicks Submit
  7. Renderer calls window.opencodeOps.questionReply(requestID, answers)
  8. Preload → IPC → Main → client.question.reply({ requestID, answers })
  9. SDK resolves blocked tool → returns formatted answer to AI
 10. Server emits SSE: { type: "question.replied", ... }
 11. Main forwards → Renderer removes question from store → UI clears

  Alt: User clicks Dismiss
  7a. Renderer calls window.opencodeOps.questionReject(requestID)
  8a. SDK rejects blocked tool → AI receives rejection
```

```
QuestionPrompt UI Layout (single question, single choice):

  ┌─────────────────────────────────────────────────┐
  │  ❓ Header Text                        [Dismiss] │
  │                                                   │
  │  Question text goes here?                         │
  │                                                   │
  │  ┌─────────────────────────────────────────────┐  │
  │  │ ○ Option A Label                            │  │
  │  │   Description of option A                   │  │
  │  └─────────────────────────────────────────────┘  │
  │  ┌─────────────────────────────────────────────┐  │
  │  │ ○ Option B Label (Recommended)              │  │
  │  │   Description of option B                   │  │
  │  └─────────────────────────────────────────────┘  │
  │  ┌─────────────────────────────────────────────┐  │
  │  │ ✎ Type your own answer                      │  │
  │  └─────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────┘

QuestionPrompt UI Layout (multiple questions — tabbed):

  ┌─────────────────────────────────────────────────┐
  │  [Tab 1: Header] [Tab 2: Header] [✓ Confirm]   │
  │                                                   │
  │  Question text for current tab                    │
  │                                                   │
  │  ┌─────────────────────────────────────────────┐  │
  │  │ ☑ Option A (selected)                       │  │
  │  └─────────────────────────────────────────────┘  │
  │  ┌─────────────────────────────────────────────┐  │
  │  │ ☐ Option B                                  │  │
  │  └─────────────────────────────────────────────┘  │
  │                                                   │
  │                          [Dismiss]    [Next →]    │
  └─────────────────────────────────────────────────┘
```

**Interaction behaviors**:

- **Single question, single choice** (`questions.length === 1 && !multiple`): Clicking an option immediately submits the answer. No confirm step.
- **Single question, multiple choice** (`multiple: true`): Toggle options with checkmarks. "Submit" button sends selected labels.
- **Multiple questions**: Tab interface with question headers. Navigate between tabs. Final "Confirm" tab shows a review of all answers. "Submit" sends all answers at once.
- **Custom/free-text** (default unless `custom: false`): "Type your own answer" option opens an inline text input. Submitting adds the custom text as the selected answer.
- **Dismiss**: Rejects the question. The SDK will stop the tool and may halt the session loop depending on configuration.

#### 1.3 Implementation

**New Zustand Store** (`src/renderer/src/stores/useQuestionStore.ts`):

```typescript
import { create } from 'zustand'

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: { messageID: string; callID: string }
}

export type QuestionAnswer = string[]

interface QuestionStore {
  // Pending questions keyed by session ID
  pendingBySession: Map<string, QuestionRequest[]>

  // Add a pending question
  addQuestion: (sessionId: string, request: QuestionRequest) => void

  // Remove a question (after reply or reject)
  removeQuestion: (sessionId: string, requestId: string) => void

  // Get pending questions for a session
  getQuestions: (sessionId: string) => QuestionRequest[]

  // Get the first pending question for a session (for inline rendering)
  getActiveQuestion: (sessionId: string) => QuestionRequest | null
}

export const useQuestionStore = create<QuestionStore>((set, get) => ({
  pendingBySession: new Map(),

  addQuestion: (sessionId, request) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      const existing = map.get(sessionId) || []
      // Avoid duplicates
      if (existing.some((q) => q.id === request.id)) return state
      map.set(sessionId, [...existing, request])
      return { pendingBySession: map }
    }),

  removeQuestion: (sessionId, requestId) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      const existing = map.get(sessionId) || []
      const filtered = existing.filter((q) => q.id !== requestId)
      if (filtered.length === 0) {
        map.delete(sessionId)
      } else {
        map.set(sessionId, filtered)
      }
      return { pendingBySession: map }
    }),

  getQuestions: (sessionId) => get().pendingBySession.get(sessionId) || [],

  getActiveQuestion: (sessionId) => {
    const questions = get().pendingBySession.get(sessionId) || []
    return questions[0] || null
  }
}))
```

**Main Process — Service** (`src/main/services/opencode-service.ts`):

Add `questionReply` and `questionReject` methods:

```typescript
/**
 * Reply to a pending question from the AI
 */
async questionReply(
  requestId: string,
  answers: string[][],
  worktreePath?: string
): Promise<void> {
  const instance = await this.getOrCreateInstance()

  await instance.client.question.reply({
    path: { requestID: requestId },
    query: worktreePath ? { directory: worktreePath } : undefined,
    body: { answers }
  })
}

/**
 * Reject/dismiss a pending question from the AI
 */
async questionReject(
  requestId: string,
  worktreePath?: string
): Promise<void> {
  const instance = await this.getOrCreateInstance()

  await instance.client.question.reject({
    path: { requestID: requestId },
    query: worktreePath ? { directory: worktreePath } : undefined
  })
}
```

**Main Process — IPC Handlers** (`src/main/ipc/opencode-handlers.ts`):

```typescript
// Reply to a question from the AI
ipcMain.handle(
  'opencode:question:reply',
  async (
    _event,
    {
      requestId,
      answers,
      worktreePath
    }: { requestId: string; answers: string[][]; worktreePath?: string }
  ) => {
    log.info('IPC: opencode:question:reply', { requestId })
    try {
      await openCodeService.questionReply(requestId, answers, worktreePath)
      return { success: true }
    } catch (error) {
      log.error('IPC: opencode:question:reply failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
)

// Reject/dismiss a question from the AI
ipcMain.handle(
  'opencode:question:reject',
  async (_event, { requestId, worktreePath }: { requestId: string; worktreePath?: string }) => {
    log.info('IPC: opencode:question:reject', { requestId })
    try {
      await openCodeService.questionReject(requestId, worktreePath)
      return { success: true }
    } catch (error) {
      log.error('IPC: opencode:question:reject failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
)
```

**Preload** (`src/preload/index.ts`):

Add to the `opencodeOps` namespace (after line 698):

```typescript
// Reply to a question from the AI
questionReply: (
  requestId: string,
  answers: string[][],
  worktreePath?: string
): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('opencode:question:reply', { requestId, answers, worktreePath }),

// Reject/dismiss a question from the AI
questionReject: (
  requestId: string,
  worktreePath?: string
): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('opencode:question:reject', { requestId, worktreePath }),
```

**Preload Types** (`src/preload/index.d.ts`):

Add to the `opencodeOps` interface:

```typescript
questionReply: (requestId: string, answers: string[][], worktreePath?: string) =>
  Promise<{ success: boolean; error?: string }>

questionReject: (requestId: string, worktreePath?: string) =>
  Promise<{ success: boolean; error?: string }>
```

**Renderer — Stream Event Handling** (`SessionView.tsx`):

Inside the stream event handler (around line 830), add branches for question events:

```typescript
// Handle question events
if (event.type === 'question.asked') {
  const request = event.data as QuestionRequest
  // Map the OpenCode session ID to the question's session ID
  useQuestionStore.getState().addQuestion(sessionId, request)
  return
}

if (event.type === 'question.replied' || event.type === 'question.rejected') {
  const requestId = event.data?.requestID || event.data?.requestId
  if (requestId) {
    useQuestionStore.getState().removeQuestion(sessionId, requestId)
  }
  return
}
```

**Renderer — QuestionPrompt Component** (`src/renderer/src/components/sessions/QuestionPrompt.tsx`):

New component. The full implementation should reference the OpenCode client's `QuestionPrompt` in `packages/ui/src/components/message-part.tsx` and `QuestionDock` in `packages/app/src/components/question-dock.tsx`. Core structure:

```typescript
import { useState, useCallback } from 'react'
import { MessageCircleQuestion, X, Check, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { QuestionRequest, QuestionAnswer } from '@/stores/useQuestionStore'

interface QuestionPromptProps {
  request: QuestionRequest
  onReply: (requestId: string, answers: QuestionAnswer[]) => void
  onReject: (requestId: string) => void
}

export function QuestionPrompt({
  request,
  onReply,
  onReject
}: QuestionPromptProps): React.JSX.Element {
  const [currentTab, setCurrentTab] = useState(0)
  const [answers, setAnswers] = useState<QuestionAnswer[]>(request.questions.map(() => []))
  const [customInputs, setCustomInputs] = useState<string[]>(request.questions.map(() => ''))
  const [editingCustom, setEditingCustom] = useState(false)

  const isSingleQuestion = request.questions.length === 1
  const currentQuestion = request.questions[currentTab]
  const isMultiple = currentQuestion?.multiple ?? false
  const allowCustom = currentQuestion?.custom !== false // default true

  const handleOptionClick = useCallback(
    (label: string) => {
      if (isSingleQuestion && !isMultiple) {
        // Single question, single choice — auto-submit
        onReply(request.id, [[label]])
        return
      }

      setAnswers((prev) => {
        const updated = [...prev]
        const current = updated[currentTab] || []
        if (isMultiple) {
          // Toggle selection
          updated[currentTab] = current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label]
        } else {
          updated[currentTab] = [label]
        }
        return updated
      })
    },
    [currentTab, isMultiple, isSingleQuestion, onReply, request.id]
  )

  const handleCustomSubmit = useCallback(() => {
    const text = customInputs[currentTab]?.trim()
    if (!text) return
    setAnswers((prev) => {
      const updated = [...prev]
      updated[currentTab] = [text]
      return updated
    })
    setEditingCustom(false)
  }, [currentTab, customInputs])

  const handleSubmitAll = useCallback(() => {
    onReply(request.id, answers)
  }, [request.id, answers, onReply])

  // ... render question UI with tabs, options, custom input, dismiss button
}
```

**Renderer — SessionView Integration**:

In the JSX, render the QuestionPrompt after the streaming content area when a pending question exists:

```typescript
const activeQuestion = useQuestionStore((s) => s.getActiveQuestion(sessionId))

// In handleQuestionReply/Reject callbacks:
const handleQuestionReply = useCallback(
  async (requestId: string, answers: string[][]) => {
    await window.opencodeOps.questionReply(requestId, answers, worktreePath || undefined)
  },
  [worktreePath]
)

const handleQuestionReject = useCallback(
  async (requestId: string) => {
    await window.opencodeOps.questionReject(requestId, worktreePath || undefined)
  },
  [worktreePath]
)

// In JSX, after the streaming content / before the input:
{activeQuestion && (
  <QuestionPrompt
    request={activeQuestion}
    onReply={handleQuestionReply}
    onReject={handleQuestionReject}
  />
)}
```

**Edge Cases**:

- **Multiple questions queued**: Only show the first pending question. After it's answered/dismissed, the next one appears.
- **Session switch while question pending**: Questions are keyed by session ID, so switching sessions shows/hides the relevant question.
- **Question arrives after session finalized**: Store it anyway; the user can still answer and the SDK will handle it.
- **Network error on reply/reject**: Show toast error, keep the question visible so the user can retry.
- **Question with `custom: false`**: Hide the "Type your own answer" option.
- **Empty options array**: Show only the custom text input (if `custom !== false`).

#### 1.4 Files to Modify

| File                                                      | Change                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/renderer/src/stores/useQuestionStore.ts`             | **NEW** — Zustand store for pending question requests                                    |
| `src/renderer/src/components/sessions/QuestionPrompt.tsx` | **NEW** — Interactive question UI component (options, multi-select, custom input, tabs)  |
| `src/main/services/opencode-service.ts`                   | Add `questionReply()` and `questionReject()` methods                                     |
| `src/main/ipc/opencode-handlers.ts`                       | Add `opencode:question:reply` and `opencode:question:reject` IPC handlers                |
| `src/preload/index.ts`                                    | Expose `questionReply()` and `questionReject()` on `opencodeOps`                         |
| `src/preload/index.d.ts`                                  | Type declarations for question APIs                                                      |
| `src/renderer/src/components/sessions/SessionView.tsx`    | Handle `question.asked/replied/rejected` events in stream handler; render QuestionPrompt |
| `src/renderer/src/stores/index.ts`                        | Export `useQuestionStore`                                                                |

---

### 2. Scroll-to-Bottom FAB — Don't Show Prematurely

#### 2.1 Current State

The smart auto-scroll system in `SessionView.tsx` (lines 373-475) uses direction detection and a distance-from-bottom threshold to control the FAB:

- **Line 437-438**: `distanceFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight`, with `isNearBottom` threshold of 80px.
- **Lines 440-463**: If the user scrolls up during streaming, auto-scroll is disabled and the FAB is shown with a 2-second cooldown.
- **Lines 470-473**: The **problem** — if the scroll position is far from bottom during streaming (even without an explicit upward scroll by the user), the FAB is shown:

  ```typescript
  } else if (!isNearBottom && (isSending || isStreaming)) {
    // Far from bottom during streaming (no cooldown needed, just update state)
    isAutoScrollEnabledRef.current = false
    setShowScrollFab(true)
  }
  ```

  During streaming, new content is appended rapidly. The `scrollHeight` grows faster than `scrollTop` keeps up (browser rendering lag, rAF batching). This causes `distanceFromBottom > 80` transiently, triggering the FAB even though the user has not manually scrolled. The user sees the FAB flicker in and out as auto-scroll catches up on the next frame.

- **Lines 489-494**: The auto-scroll effect fires on `[messages, streamingContent, streamingParts]` and calls `scrollToBottom()`, but by then the scroll event has already fired and the FAB has been shown momentarily.

#### 2.2 New Design

Add a `userHasScrolledUpRef` boolean flag. The FAB should **only** become visible when the user has explicitly scrolled upward at least once since the last scroll-to-bottom reset. Content growth that pushes `distanceFromBottom > 80` without a prior user scroll-up should **not** show the FAB.

```
State machine:

  [Session start / Send message / FAB click / Session switch]
       │
       ▼
  userHasScrolledUpRef = false
  isAutoScrollEnabledRef = true
  showScrollFab = false
       │
       │  (streaming content grows, distance > 80px)
       │  → NO CHANGE (userHasScrolledUpRef is still false)
       │
       │  (user scrolls up intentionally)
       ▼
  userHasScrolledUpRef = true
  isAutoScrollEnabledRef = false
  showScrollFab = true
  cooldown starts (2s)
       │
       │  (user scrolls back to bottom, cooldown expired)
       ▼
  userHasScrolledUpRef = false  ← reset
  isAutoScrollEnabledRef = true
  showScrollFab = false
```

The key change: the `else if (!isNearBottom && (isSending || isStreaming))` branch (line 470) now also checks `userHasScrolledUpRef.current === true` before showing the FAB.

#### 2.3 Implementation

**Renderer** (`src/renderer/src/components/sessions/SessionView.tsx`):

Add a new ref after line 378:

```typescript
// Track whether user has intentionally scrolled up since last reset
const userHasScrolledUpRef = useRef(false)
```

Modify `handleScroll` (lines 429-475):

```typescript
const handleScroll = useCallback(() => {
  const el = scrollContainerRef.current
  if (!el) return

  const currentScrollTop = el.scrollTop
  const scrollingUp = currentScrollTop < lastScrollTopRef.current
  lastScrollTopRef.current = currentScrollTop

  const distanceFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight
  const isNearBottom = distanceFromBottom < 80

  // Upward scroll during streaming → mark as intentional, disable auto-scroll + cooldown
  if (scrollingUp && (isSending || isStreaming)) {
    userHasScrolledUpRef.current = true // NEW: mark intentional scroll-up
    isAutoScrollEnabledRef.current = false
    setShowScrollFab(true)
    isScrollCooldownActiveRef.current = true

    if (scrollCooldownRef.current !== null) {
      clearTimeout(scrollCooldownRef.current)
    }
    scrollCooldownRef.current = setTimeout(() => {
      scrollCooldownRef.current = null
      isScrollCooldownActiveRef.current = false
      const elNow = scrollContainerRef.current
      if (elNow) {
        const dist = elNow.scrollHeight - elNow.scrollTop - elNow.clientHeight
        if (dist < 80) {
          isAutoScrollEnabledRef.current = true
          setShowScrollFab(false)
          userHasScrolledUpRef.current = false // NEW: reset on return to bottom
        }
      }
    }, SCROLL_COOLDOWN_MS)
    return
  }

  // Near bottom and no active cooldown → re-enable auto-scroll
  if (isNearBottom && !isScrollCooldownActiveRef.current) {
    isAutoScrollEnabledRef.current = true
    setShowScrollFab(false)
    userHasScrolledUpRef.current = false // NEW: reset on return to bottom
  } else if (!isNearBottom && (isSending || isStreaming) && userHasScrolledUpRef.current) {
    // CHANGED: Only show FAB if user has previously scrolled up intentionally
    isAutoScrollEnabledRef.current = false
    setShowScrollFab(true)
  }
}, [isSending, isStreaming])
```

Reset `userHasScrolledUpRef` in all scroll-to-bottom reset points:

- **FAB click** (line 478-485): Add `userHasScrolledUpRef.current = false`
- **Send message** (line 1394-1401): Add `userHasScrolledUpRef.current = false`
- **Session switch** (line 496-505): Add `userHasScrolledUpRef.current = false`

#### 2.4 Files to Modify

| File                                                   | Change                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add `userHasScrolledUpRef`; gate FAB visibility on it in `handleScroll`; reset in FAB click, send, session switch |

---

### 3. Write Tool — Show File Name in Expanded View

#### 3.1 Current State

The Write tool's **collapsed header** in `ToolCard.tsx` (lines 242-257) already shows the file path correctly:

```typescript
// Write / Create
if (lowerName.includes('write') || lowerName === 'create') {
  const filePath = (input.filePath || input.file_path || input.path || '') as string
  const content = (input.content || '') as string
  const lineCount = content ? content.trimEnd().split('\n').length : null
  return (
    <>
      <span className="text-muted-foreground shrink-0"><FilePlus className="h-3.5 w-3.5" /></span>
      <span className="font-medium text-foreground shrink-0">Write</span>
      <span className="font-mono text-muted-foreground truncate min-w-0">{shortenPath(filePath, cwd)}</span>
      {lineCount !== null && (
        <span className="text-muted-foreground/60 shrink-0 text-[10px]">{lineCount} lines</span>
      )}
    </>
  )
}
```

However, the **expanded view** reuses `ReadToolView` (line 166: `Write: ReadToolView`). Looking at `ReadToolView.tsx`, it renders from `output` (the tool's response text) — it parses `<file>` XML wrappers and renders syntax-highlighted code. It does **not** show a file path header in the expanded detail view.

By contrast, `EditToolView.tsx` shows the diff content inline — but crucially, the Edit tool's collapsed header (lines 259-279) shows `<Pencil> Edit <filepath>` with line counts. Both collapsed headers work similarly.

The issue is that when the Write tool's `input` object has an empty or unrecognized file path key, the collapsed header shows an empty path. The SDK may send the path under `input.filePath`, `input.file_path`, or `input.path`, but some tool implementations use different field names.

Additionally, the expanded `ReadToolView` does not show any file identification — when expanded, the user loses context about which file is being written to.

#### 3.2 New Design

Create a dedicated `WriteToolView` component that shows:

1. A file path header at the top of the expanded view (matching the pattern from `EditToolView`)
2. The full file content being written, syntax-highlighted
3. Line count

The expanded view should show the file path extracted from `input` (same logic as the collapsed header) as a prominent header, followed by the syntax-highlighted content from `input.content`.

```
Write Tool — Expanded View:

  ┌─────────────────────────────────────────────┐
  │  📝 src/components/NewFile.tsx   42 lines    │  ← file header
  ├─────────────────────────────────────────────┤
  │  1 │ import { useState } from 'react'       │
  │  2 │                                         │
  │  3 │ export function NewFile() {             │
  │  4 │   const [state, setState] = useState(0) │
  │  ...│ (Show all 42 lines ▼)                  │
  └─────────────────────────────────────────────┘
```

#### 3.3 Implementation

**New Component** (`src/renderer/src/components/sessions/tools/WriteToolView.tsx`):

```typescript
import { useMemo, useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ToolViewProps } from './types'

const MAX_PREVIEW_LINES = 20

// Reuse language detection from ReadToolView pattern
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', xml: 'xml', svg: 'xml',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', sql: 'sql', sh: 'bash', bash: 'bash',
    dockerfile: 'docker', makefile: 'makefile'
  }
  return langMap[ext] || 'text'
}

export function WriteToolView({ input }: ToolViewProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const filePath = (input.filePath || input.file_path || input.path || '') as string
  const content = (input.content || '') as string
  const lines = useMemo(() => content.trimEnd().split('\n'), [content])
  const language = useMemo(() => detectLanguage(filePath), [filePath])

  const displayLines = expanded ? lines : lines.slice(0, MAX_PREVIEW_LINES)
  const displayContent = displayLines.join('\n')
  const hasMore = lines.length > MAX_PREVIEW_LINES

  return (
    <div className="space-y-2">
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        showLineNumbers
        customStyle={{
          margin: 0,
          borderRadius: '0.375rem',
          fontSize: '12px',
          maxHeight: expanded ? 'none' : '400px'
        }}
      >
        {displayContent}
      </SyntaxHighlighter>
      {hasMore && !expanded && (
        <button
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded(true)}
        >
          <ChevronDown className="h-3 w-3" />
          Show all {lines.length} lines
        </button>
      )}
      {expanded && hasMore && (
        <button
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded(false)}
        >
          <ChevronRight className="h-3 w-3" />
          Show less
        </button>
      )}
    </div>
  )
}
```

**Update ToolCard.tsx** (line 163-167):

```typescript
// BEFORE
Write: ReadToolView, // Similar rendering to Read
write_file: ReadToolView,

// AFTER
Write: WriteToolView,
write_file: WriteToolView,
```

Also update the pattern fallback at line 187:

```typescript
// BEFORE
if (lower.includes('write') || lower === 'create') return ReadToolView

// AFTER
if (lower.includes('write') || lower === 'create') return WriteToolView
```

**Update tools/index.ts** — export `WriteToolView`:

```typescript
export { WriteToolView } from './WriteToolView'
```

#### 3.4 Files to Modify

| File                                                           | Change                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/tools/WriteToolView.tsx` | **NEW** — Dedicated Write tool expanded view with file header and syntax highlighting |
| `src/renderer/src/components/sessions/ToolCard.tsx`            | Map `Write`/`write_file` to `WriteToolView` in `TOOL_RENDERERS` and fallback          |
| `src/renderer/src/components/sessions/tools/index.ts`          | Export `WriteToolView`                                                                |

---

### 4. Show in Finder — QuickActions Dropdown

#### 4.1 Current State

`QuickActions.tsx` (line 38-42) defines three actions:

```typescript
const ACTIONS: ActionConfig[] = [
  { id: 'cursor', label: 'Cursor', icon: <CursorIcon className="h-3.5 w-3.5" /> },
  { id: 'ghostty', label: 'Ghostty', icon: <GhosttyIcon className="h-3.5 w-3.5" /> },
  { id: 'copy-path', label: 'Copy Path', icon: <Copy className="h-3.5 w-3.5" /> }
]
```

The `executeAction` callback (lines 65-83) handles `cursor` and `ghostty` via `window.systemOps.openInApp()`, and `copy-path` via `window.projectOps.copyToClipboard()`.

The IPC channel `shell:showItemInFolder` already exists:

- **Preload** `index.ts` line 154: `showInFolder: (path) => ipcRenderer.invoke('shell:showItemInFolder', path)`
- **Main** `project-handlers.ts` lines 91-93: `shell.showItemInFolder(path)`
- **Type** `index.d.ts` line 188: `showInFolder: (path: string) => Promise<void>`

This is used by `WorktreeItem.tsx` (line 92-94) for the worktree context menu "Open in Finder" action.

Additionally, there is a **bug** in `useCommands.ts` (line 327): The command palette's "Reveal in Finder" action calls `window.worktreeOps.openInFinder(worktreePath)` which **does not exist** on the `worktreeOps` namespace. The `worktreeOps` only exposes `openInTerminal` and `openInEditor`. This call would throw a runtime error. It should call `window.projectOps.showInFolder(worktreePath)` instead.

The `QuickActionType` type in `useSettingsStore.ts` (line 17) is `'cursor' | 'ghostty' | 'copy-path'` and needs to include the new action.

#### 4.2 New Design

Add a 4th action "Finder" to the `ACTIONS` array using the `FolderOpen` lucide icon. On click, call `window.projectOps.showInFolder(worktreePath)`. Also fix the command palette bug.

```
QuickActions Dropdown (after):

  ┌─────────────────────┐
  │  🔲 Cursor         ✓│
  │  👻 Ghostty         │
  │  📋 Copy Path       │
  │  📂 Finder          │  ← NEW
  └─────────────────────┘
```

#### 4.3 Implementation

**Renderer** (`src/renderer/src/components/layout/QuickActions.tsx`):

Add `FolderOpen` to the lucide imports (line 1):

```typescript
// BEFORE
import { ChevronDown, ExternalLink, Copy, Check } from 'lucide-react'

// AFTER
import { ChevronDown, ExternalLink, Copy, Check, FolderOpen } from 'lucide-react'
```

Add the new action to the `ACTIONS` array (after line 41):

```typescript
const ACTIONS: ActionConfig[] = [
  { id: 'cursor', label: 'Cursor', icon: <CursorIcon className="h-3.5 w-3.5" /> },
  { id: 'ghostty', label: 'Ghostty', icon: <GhosttyIcon className="h-3.5 w-3.5" /> },
  { id: 'copy-path', label: 'Copy Path', icon: <Copy className="h-3.5 w-3.5" /> },
  { id: 'finder', label: 'Finder', icon: <FolderOpen className="h-3.5 w-3.5" /> }
]
```

Add the `finder` case to `executeAction` (inside the try block, after the `copy-path` branch):

```typescript
if (actionId === 'copy-path') {
  await window.projectOps.copyToClipboard(worktreePath)
  setCopied(true)
  setTimeout(() => setCopied(false), 1500)
} else if (actionId === 'finder') {
  await window.projectOps.showInFolder(worktreePath)
} else {
  await window.systemOps.openInApp(actionId, worktreePath)
}
```

**Store** (`src/renderer/src/stores/useSettingsStore.ts`):

Update the `QuickActionType` union (line 17):

```typescript
// BEFORE
export type QuickActionType = 'cursor' | 'ghostty' | 'copy-path'

// AFTER
export type QuickActionType = 'cursor' | 'ghostty' | 'copy-path' | 'finder'
```

**Fix Command Palette Bug** (`src/renderer/src/hooks/useCommands.ts`):

Change line 327:

```typescript
// BEFORE
await window.worktreeOps.openInFinder(worktreePath)

// AFTER
await window.projectOps.showInFolder(worktreePath)
```

#### 4.4 Files to Modify

| File                                                  | Change                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/layout/QuickActions.tsx` | Add `FolderOpen` import; add `'finder'` action to `ACTIONS`; add `finder` branch to `executeAction`              |
| `src/renderer/src/stores/useSettingsStore.ts`         | Add `'finder'` to `QuickActionType` union                                                                        |
| `src/renderer/src/hooks/useCommands.ts`               | Fix "Reveal in Finder" to call `window.projectOps.showInFolder()` instead of `window.worktreeOps.openInFinder()` |

---

### 5. Slash Commands — Parse and Execute via SDK, Auto-Switch Mode

#### 5.1 Current State

Slash commands are fetched from the SDK at session init and displayed in a popover, but they are **sent as raw text prompts** rather than using the SDK's dedicated command endpoint.

**Command loading** — `SessionView.tsx` lines 1197-1209:

```typescript
const fetchCommands = (path: string): void => {
  window.opencodeOps
    .commands(path)
    .then((result) => {
      if (result.success && result.commands) {
        setSlashCommands(result.commands)
      }
    })
    .catch((err) => {
      console.warn('Failed to fetch slash commands:', err)
    })
}
```

**Current command type** — `index.d.ts` lines 552-557:

```typescript
interface OpenCodeCommand {
  name: string
  description?: string
  template: string
}
```

This is a **subset** of what the SDK actually returns. The SDK's `Command` type (in `types.gen.d.ts`) includes additional fields: `agent?: string`, `model?: string`, `source?: 'command' | 'mcp' | 'skill'`, `subtask?: boolean`, `hints: string[]`. The `agent` field is critical for mode switching.

**Command selection** — `SessionView.tsx` line 1566-1570: When the user selects a command from the popover, it simply sets the input value to `/{name} `:

```typescript
const handleCommandSelect = useCallback((cmd: { name: string; template: string }) => {
  setInputValue(`/${cmd.name} `)
  setShowSlashCommands(false)
  textareaRef.current?.focus()
}, [])
```

**Sending** — `SessionView.tsx` lines 1461-1484: The `handleSend` function sends the raw input text (including the `/command` prefix) as a plain prompt via `window.opencodeOps.prompt()`. There is no detection of slash commands and no routing to a command-specific endpoint.

**Mode system** — `SessionView.tsx` lines 1464-1468: Mode is prepended as a text prefix:

```typescript
const currentMode = useSessionStore.getState().getSessionMode(sessionId)
const modePrefix = currentMode === 'plan' ? '[Mode: Plan] You are in planning mode...\n\n' : ''
const promptMessage = modePrefix + trimmedValue
```

**SDK's session.command endpoint** — The SDK has `client.session.command()` which accepts:

- `sessionID` (path)
- `command` (command name)
- `arguments` (remaining text after command name)
- `agent?`, `model?`, `variant?` (optional overrides)
- `directory?` (query)

This endpoint handles template resolution, argument substitution (`$1`, `$ARGUMENTS`), shell command execution (`` !`...` ``), file reference resolution (`@path`), and agent/model overrides — all server-side. The current approach of sending `/command args` as a prompt text bypasses all of this.

**Slash command file format** (for reference — this is what users create in `.opencode/command/`):

```markdown
---
description: write a test list
agent: plan
---

give me a testing list for me to manually test what we've implemented this session
```

The `agent` field (`plan` or `build`) indicates which mode the command should run in.

#### 5.2 New Design

When the user submits a message starting with `/`, detect the command name, extract arguments, and route through the SDK's `session.command()` endpoint instead of `prompt()`. Before sending, check the command's `agent` field and auto-switch the session mode if needed.

```
Current flow:
  User types: /test-list some args
  → handleSend() sends "/test-list some args" as prompt text
  → SDK receives raw text, tries to interpret (may not work correctly)

New flow:
  User types: /test-list some args
  → handleSend() detects "/" prefix
  → Looks up command "test-list" in slashCommands
  → Checks command.agent === 'plan'
  → Current mode is 'build' → auto-switch to 'plan'
  → Calls window.opencodeOps.command(worktreePath, sessionId, {
      command: 'test-list',
      arguments: 'some args'
    })
  → Main process calls client.session.command({
      path: { id: sessionId },
      query: { directory: worktreePath },
      body: { command: 'test-list', arguments: 'some args', model, variant }
    })
  → SDK resolves template, substitutes args, executes shell commands, sends as prompt
```

#### 5.3 Implementation

**Update OpenCodeCommand type** — `src/preload/index.d.ts` (lines 552-557):

```typescript
// BEFORE
interface OpenCodeCommand {
  name: string
  description?: string
  template: string
}

// AFTER
interface OpenCodeCommand {
  name: string
  description?: string
  template: string
  agent?: string
  model?: string
  source?: 'command' | 'mcp' | 'skill'
  subtask?: boolean
  hints?: string[]
}
```

**Update preload command listing** — `src/preload/index.ts` (lines 691-698):

```typescript
// BEFORE
commands: (
  worktreePath: string
): Promise<{
  success: boolean
  commands: Array<{ name: string; description?: string; template: string }>
  error?: string
}> => ipcRenderer.invoke('opencode:commands', { worktreePath }),

// AFTER
commands: (
  worktreePath: string
): Promise<{
  success: boolean
  commands: Array<OpenCodeCommand>
  error?: string
}> => ipcRenderer.invoke('opencode:commands', { worktreePath }),
```

**Update service listCommands** — `src/main/services/opencode-service.ts` (lines 1231-1245):

Update the return type to include all fields from the SDK:

```typescript
// BEFORE
async listCommands(
  worktreePath: string
): Promise<Array<{ name: string; description?: string; template: string }>> {

// AFTER
async listCommands(
  worktreePath: string
): Promise<Array<{
  name: string
  description?: string
  template: string
  agent?: string
  model?: string
  source?: string
  subtask?: boolean
  hints?: string[]
}>> {
```

**Add sendCommand method** — `src/main/services/opencode-service.ts`:

```typescript
/**
 * Send a slash command to an OpenCode session.
 * Uses the SDK's dedicated command endpoint for proper template resolution.
 */
async sendCommand(
  worktreePath: string,
  opencodeSessionId: string,
  command: string,
  args: string
): Promise<void> {
  if (!this.instance) {
    throw new Error('No OpenCode instance available')
  }

  const { variant, ...model } = this.getSelectedModel()

  await this.instance.client.session.command({
    path: { sessionID: opencodeSessionId },
    query: { directory: worktreePath },
    body: {
      command,
      arguments: args,
      model: `${model.providerID}/${model.modelID}`,
      variant
    }
  })
}
```

**Add IPC handler** — `src/main/ipc/opencode-handlers.ts`:

```typescript
// Send a slash command to a session
ipcMain.handle(
  'opencode:command',
  async (
    _event,
    {
      worktreePath,
      sessionId,
      command,
      args
    }: {
      worktreePath: string
      sessionId: string
      command: string
      args: string
    }
  ) => {
    log.info('IPC: opencode:command', { worktreePath, sessionId, command, args })
    try {
      await openCodeService.sendCommand(worktreePath, sessionId, command, args)
      return { success: true }
    } catch (error) {
      log.error('IPC: opencode:command failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
)
```

**Preload** — `src/preload/index.ts`:

Add to `opencodeOps` (after the `prompt` method):

```typescript
// Send a slash command to a session (uses SDK's command endpoint)
command: (
  worktreePath: string,
  opencodeSessionId: string,
  command: string,
  args: string
): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('opencode:command', {
    worktreePath,
    sessionId: opencodeSessionId,
    command,
    args
  }),
```

**Preload types** — `src/preload/index.d.ts`:

Add to the `opencodeOps` interface:

```typescript
command: (worktreePath: string, opencodeSessionId: string, command: string, args: string) =>
  Promise<{ success: boolean; error?: string }>
```

**Renderer — handleSend modification** — `src/renderer/src/components/sessions/SessionView.tsx`:

In `handleSend` (starting at line 1461), add slash command detection before the generic prompt path:

```typescript
// Send to OpenCode if connected
if (worktreePath && opencodeSessionId) {
  // Check if this is a slash command
  if (trimmedValue.startsWith('/')) {
    const spaceIndex = trimmedValue.indexOf(' ')
    const commandName = spaceIndex > 0 ? trimmedValue.slice(1, spaceIndex) : trimmedValue.slice(1)
    const commandArgs = spaceIndex > 0 ? trimmedValue.slice(spaceIndex + 1).trim() : ''

    // Look up command in the loaded slash commands
    const matchedCommand = slashCommands.find((c) => c.name === commandName)

    if (matchedCommand) {
      // Auto-switch mode based on command's agent field
      if (matchedCommand.agent) {
        const currentMode = useSessionStore.getState().getSessionMode(sessionId)
        const targetMode = matchedCommand.agent === 'plan' ? 'plan' : 'build'
        if (currentMode !== targetMode) {
          await useSessionStore.getState().setSessionMode(sessionId, targetMode)
        }
      }

      // Send via the dedicated command endpoint
      const result = await window.opencodeOps.command(
        worktreePath,
        opencodeSessionId,
        commandName,
        commandArgs
      )
      if (!result.success) {
        console.error('Failed to send command to OpenCode:', result.error)
        toast.error('Failed to send command')
        setIsSending(false)
      }
    } else {
      // Unknown command — fall through to regular prompt
      // (the SDK may still handle it server-side)
      const result = await window.opencodeOps.prompt(worktreePath, opencodeSessionId, [
        { type: 'text' as const, text: trimmedValue }
      ])
      if (!result.success) {
        console.error('Failed to send prompt to OpenCode:', result.error)
        toast.error('Failed to send message to AI')
        setIsSending(false)
      }
    }
  } else {
    // Regular prompt (existing code)
    const currentMode = useSessionStore.getState().getSessionMode(sessionId)
    const modePrefix =
      currentMode === 'plan'
        ? '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'
        : ''
    const promptMessage = modePrefix + trimmedValue
    lastSentPromptRef.current = promptMessage
    const parts: MessagePart[] = [
      ...attachments.map((a) => ({
        type: 'file' as const,
        mime: a.mime,
        url: a.dataUrl,
        filename: a.name
      })),
      { type: 'text' as const, text: promptMessage }
    ]
    setAttachments([])
    const result = await window.opencodeOps.prompt(worktreePath, opencodeSessionId, parts)
    if (!result.success) {
      console.error('Failed to send prompt to OpenCode:', result.error)
      toast.error('Failed to send message to AI')
      setIsSending(false)
    }
  }
} else {
  // No OpenCode connection — existing placeholder code
  // ...
}
```

**Renderer — Update SlashCommandPopover** — `src/renderer/src/components/sessions/SlashCommandPopover.tsx`:

Update the interface to include `agent` (lines 4-8):

```typescript
// BEFORE
interface SlashCommand {
  name: string
  description?: string
  template: string
}

// AFTER
interface SlashCommand {
  name: string
  description?: string
  template: string
  agent?: string
}
```

Optionally show the agent badge in the popover item:

```typescript
<span className="font-mono text-xs text-muted-foreground">/{cmd.name}</span>
{cmd.agent && (
  <span className={cn(
    'text-[10px] px-1 rounded',
    cmd.agent === 'plan'
      ? 'bg-violet-500/20 text-violet-400'
      : 'bg-blue-500/20 text-blue-400'
  )}>
    {cmd.agent}
  </span>
)}
{cmd.description && (
  <span className="text-xs text-muted-foreground truncate">
    {cmd.description}
  </span>
)}
```

**Edge Cases**:

- **Unknown slash command**: If the user types `/foo` but `foo` is not in the loaded commands list, fall through to sending as a regular prompt. The SDK may still handle it.
- **Command with no agent field**: No mode switch occurs. The current mode is preserved.
- **Command with `agent: 'build'` while already in build mode**: No-op for mode switch.
- **File attachments with slash commands**: Currently, file attachments are not forwarded with `session.command()`. If attachments are present, they will be dropped. This is acceptable since slash commands define their own content.
- **Slash command while streaming**: Same behavior as regular messages — queued follow-up.

#### 5.4 Files to Modify

| File                                                           | Change                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/main/services/opencode-service.ts`                        | Add `sendCommand()` method; update `listCommands()` return type to include `agent`, `model`, etc. |
| `src/main/ipc/opencode-handlers.ts`                            | Add `opencode:command` IPC handler                                                                |
| `src/preload/index.ts`                                         | Add `command()` method to `opencodeOps`; update `commands()` return type                          |
| `src/preload/index.d.ts`                                       | Update `OpenCodeCommand` type; add `command()` method declaration                                 |
| `src/renderer/src/components/sessions/SessionView.tsx`         | Detect `/command` in `handleSend`, route to `command()` endpoint, auto-switch mode                |
| `src/renderer/src/components/sessions/SlashCommandPopover.tsx` | Update `SlashCommand` interface to include `agent`; optionally show agent badge                   |

---

## Files to Modify — Full Summary

### New Files

| File                                                           | Purpose                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/renderer/src/stores/useQuestionStore.ts`                  | Zustand store for pending AI question requests                |
| `src/renderer/src/components/sessions/QuestionPrompt.tsx`      | Interactive question prompt component (options, tabs, custom) |
| `src/renderer/src/components/sessions/tools/WriteToolView.tsx` | Dedicated Write tool expanded view with file path header      |

### Modified Files

| File                                                           | Features | Changes                                                                                           |
| -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `src/main/services/opencode-service.ts`                        | 1, 5     | Add `questionReply()`, `questionReject()`, `sendCommand()`; update `listCommands()` return type   |
| `src/main/ipc/opencode-handlers.ts`                            | 1, 5     | Add `opencode:question:reply`, `opencode:question:reject`, `opencode:command` IPC handlers        |
| `src/preload/index.ts`                                         | 1, 5     | Add `questionReply()`, `questionReject()`, `command()` to `opencodeOps`; update `commands()` type |
| `src/preload/index.d.ts`                                       | 1, 5     | Type declarations for question APIs, `command()` method, updated `OpenCodeCommand` type           |
| `src/renderer/src/components/sessions/SessionView.tsx`         | 1, 2, 5  | Handle question events; add `userHasScrolledUpRef` for FAB; detect slash commands in `handleSend` |
| `src/renderer/src/components/sessions/ToolCard.tsx`            | 3        | Map `Write`/`write_file` to `WriteToolView` in `TOOL_RENDERERS` and fallback                      |
| `src/renderer/src/components/sessions/tools/index.ts`          | 3        | Export `WriteToolView`                                                                            |
| `src/renderer/src/components/sessions/SlashCommandPopover.tsx` | 5        | Update `SlashCommand` interface to include `agent`; show agent badge                              |
| `src/renderer/src/components/layout/QuickActions.tsx`          | 4        | Add `FolderOpen` import; add `'finder'` action; add `finder` branch in `executeAction`            |
| `src/renderer/src/stores/useSettingsStore.ts`                  | 4        | Add `'finder'` to `QuickActionType` union                                                         |
| `src/renderer/src/hooks/useCommands.ts`                        | 4        | Fix "Reveal in Finder" to call `window.projectOps.showInFolder()`                                 |
| `src/renderer/src/stores/index.ts`                             | 1        | Export `useQuestionStore`                                                                         |

---

## Dependencies to Add

```bash
# No new dependencies — all features use existing packages:
# - @opencode-ai/sdk (question.reply/reject and session.command already available)
# - zustand (new question store — already installed)
# - lucide-react (FolderOpen, MessageCircleQuestion icons)
# - react-syntax-highlighter (WriteToolView — already installed)
# - react, electron (existing)
```

---

## Non-Functional Requirements

| Requirement                     | Target                                                         |
| ------------------------------- | -------------------------------------------------------------- |
| Question event → UI render      | < 100ms from SSE event to QuestionPrompt visible               |
| Question reply round-trip       | < 300ms from click to SDK acknowledgment                       |
| Question reject round-trip      | < 300ms from click to SDK acknowledgment                       |
| Scroll FAB false positive rate  | 0% — FAB never appears without user-initiated upward scroll    |
| Write tool expanded render      | < 50ms to display syntax-highlighted content (up to 500 lines) |
| Show in Finder latency          | < 200ms from click to Finder window visible                    |
| Slash command detection in send | < 5ms overhead for the `/` prefix check and command lookup     |
| Mode auto-switch on command     | < 50ms for the store update + UI re-render of mode indicator   |
| Command endpoint round-trip     | < 500ms from send to first streaming event (network-dependent) |

---

## Out of Scope (Phase 10)

- Rendering question answers as a summary after the question is answered (the tool card will show the raw tool output from the SDK)
- Question undo/edit after submission (answers are final once sent)
- Multiple simultaneous questions (only the first pending question is shown; others queue behind it)
- Custom per-question validation (e.g., regex on custom text input)
- Scroll FAB animation/transition changes (only the visibility logic changes; the existing CSS transitions remain)
- Write tool diff view showing changes vs. existing file content (only the new content is shown)
- Slash command argument autocomplete from `hints` field (hints are fetched but not used for autocomplete)
- Slash command file attachment forwarding (attachments are dropped when sending via the command endpoint)
- QuickActions reordering or custom action configuration (fixed order: Cursor, Ghostty, Copy Path, Finder)
- Cross-platform "Reveal in File Explorer" for Windows/Linux (macOS only via `shell.showItemInFolder`)

---

## Implementation Priority

### Sprint 1: Interactive Questions (Highest Priority — Core Feature)

1. **Feature 1 — Interactive Question Prompts**: New Zustand store, QuestionPrompt component, IPC handlers, stream event handling. This is the largest and most impactful feature — without it, the AI cannot ask clarifying questions and sessions may hang waiting for user input that the UI cannot capture.

### Sprint 2: Slash Command Execution (High Priority — Correctness Fix)

2. **Feature 5 — Slash Commands via SDK Endpoint**: New IPC handler, service method, handleSend detection, mode auto-switching, popover update. This fixes a correctness issue where commands aren't properly processed (template resolution, arg substitution, shell execution all skipped when sent as raw text).

### Sprint 3: UX Fixes (Medium Priority)

3. **Feature 2 — Scroll FAB Fix**: Single ref addition and three-line logic change. Small but high-impact UX improvement — eliminates a recurring visual annoyance.
4. **Feature 3 — Write Tool File Name**: New WriteToolView component, ToolCard mapping update. Small scope, improves tool display consistency.

### Sprint 4: Navigation (Lower Priority)

5. **Feature 4 — Show in Finder**: Add one action to QuickActions, fix command palette bug. Smallest change, uses entirely existing IPC infrastructure.

---

## Success Metrics

- When the AI invokes the question tool, an interactive prompt appears inline in the session view with clickable options
- Selecting an option on a single-choice question immediately sends the answer and the session continues
- Multi-choice questions allow toggling multiple options before submitting
- Dismissing a question rejects it and the AI receives the rejection
- The scroll-to-bottom FAB never appears during normal streaming when the user has not scrolled up
- The FAB appears immediately when the user intentionally scrolls up during streaming
- Clicking the FAB, sending a message, or switching sessions resets the scroll tracking
- The Write tool's expanded view shows syntax-highlighted content with the same visual quality as Read/Edit tools
- The Write tool's collapsed header continues to show the file path and line count
- "Finder" appears as the 4th option in the QuickActions dropdown
- Clicking "Finder" opens the worktree directory in macOS Finder
- The command palette "Reveal in Finder" action works without throwing a runtime error
- Typing `/command-name args` and pressing Enter routes through the SDK's command endpoint, not as a raw prompt
- If a command file has `agent: plan` and the session is in Build mode, the mode switches to Plan before sending
- If a command file has `agent: build` and the session is in Plan mode, the mode switches to Build before sending
- The slash command popover shows an agent badge (plan/build) next to commands that have one
