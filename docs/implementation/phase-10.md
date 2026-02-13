# Hive Phase 10 Implementation Plan

This document outlines the implementation plan for Hive Phase 10, focusing on interactive AI communication (question prompts), scroll UX correctness (FAB fix), tool display parity (Write tool), workspace navigation (Show in Finder), and slash command execution (SDK command endpoint with mode switching).

---

## Overview

The implementation is divided into **8 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 10 builds upon Phase 9** — all Phase 9 infrastructure is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 10)

```
test/
├── phase-10/
│   ├── session-1/
│   │   └── question-store-ipc.test.ts
│   ├── session-2/
│   │   └── question-prompt-ui.test.ts
│   ├── session-3/
│   │   └── question-session-integration.test.ts
│   ├── session-4/
│   │   └── scroll-fab-fix.test.ts
│   ├── session-5/
│   │   └── write-tool-view.test.ts
│   ├── session-6/
│   │   └── show-in-finder.test.ts
│   ├── session-7/
│   │   └── slash-command-execution.test.ts
│   └── session-8/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies — all features use existing packages:
# - @opencode-ai/sdk (question.reply/reject, session.command already available)
# - zustand (new question store — already installed)
# - lucide-react (FolderOpen, MessageCircleQuestion icons)
# - react-syntax-highlighter (WriteToolView — already installed)
```

---

## Session 1: Question Store & IPC Layer

### Objectives

- Create the Zustand store for managing pending question requests from the AI
- Wire up the full IPC chain for `question.reply()` and `question.reject()` through to the OpenCode SDK
- Forward `question.asked/replied/rejected` events to the renderer

### Tasks

#### 1. Create `useQuestionStore`

Create `src/renderer/src/stores/useQuestionStore.ts`:

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
  pendingBySession: Map<string, QuestionRequest[]>
  addQuestion: (sessionId: string, request: QuestionRequest) => void
  removeQuestion: (sessionId: string, requestId: string) => void
  getQuestions: (sessionId: string) => QuestionRequest[]
  getActiveQuestion: (sessionId: string) => QuestionRequest | null
  clearSession: (sessionId: string) => void
}

export const useQuestionStore = create<QuestionStore>((set, get) => ({
  pendingBySession: new Map(),

  addQuestion: (sessionId, request) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      const existing = map.get(sessionId) || []
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
  },

  clearSession: (sessionId) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      map.delete(sessionId)
      return { pendingBySession: map }
    })
}))
```

#### 2. Export from stores barrel

In `src/renderer/src/stores/index.ts`, add:

```typescript
export { useQuestionStore } from './useQuestionStore'
```

#### 3. Add service methods for question reply/reject

In `src/main/services/opencode-service.ts`, add two new public methods after the existing `abort()` method:

```typescript
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

#### 4. Add IPC handlers

In `src/main/ipc/opencode-handlers.ts`, add two new handlers after the existing `opencode:commands` handler:

```typescript
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

#### 5. Expose in preload

In `src/preload/index.ts`, add to the `opencodeOps` namespace (after the `commands` method, before `onStream`):

```typescript
questionReply: (
  requestId: string,
  answers: string[][],
  worktreePath?: string
): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('opencode:question:reply', { requestId, answers, worktreePath }),

questionReject: (
  requestId: string,
  worktreePath?: string
): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('opencode:question:reject', { requestId, worktreePath }),
```

#### 6. Add type declarations

In `src/preload/index.d.ts`, add to the `opencodeOps` interface:

```typescript
questionReply: (requestId: string, answers: string[][], worktreePath?: string) =>
  Promise<{ success: boolean; error?: string }>

questionReject: (requestId: string, worktreePath?: string) =>
  Promise<{ success: boolean; error?: string }>
```

### Key Files

- `src/renderer/src/stores/useQuestionStore.ts` — **NEW**
- `src/renderer/src/stores/index.ts` — export new store
- `src/main/services/opencode-service.ts` — `questionReply()`, `questionReject()`
- `src/main/ipc/opencode-handlers.ts` — IPC handlers
- `src/preload/index.ts` — preload bridge
- `src/preload/index.d.ts` — type declarations

### Definition of Done

- [ ] `useQuestionStore` created with `addQuestion`, `removeQuestion`, `getActiveQuestion`, `clearSession`
- [ ] Store prevents duplicate question IDs
- [ ] `questionReply()` calls `client.question.reply()` with correct path/body
- [ ] `questionReject()` calls `client.question.reject()` with correct path
- [ ] IPC handlers `opencode:question:reply` and `opencode:question:reject` registered
- [ ] Preload exposes `questionReply()` and `questionReject()` on `window.opencodeOps`
- [ ] Type declarations added in `index.d.ts`
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Import `useQuestionStore` in devtools and call `addQuestion('test-session', { id: 'q1', sessionID: 's1', questions: [...] })`
2. Verify `getActiveQuestion('test-session')` returns the question
3. Call `removeQuestion('test-session', 'q1')` — verify it's gone
4. Add two questions, verify only the first is returned by `getActiveQuestion`

### Testing Criteria

```typescript
// test/phase-10/session-1/question-store-ipc.test.ts
describe('Session 1: Question Store & IPC', () => {
  describe('useQuestionStore', () => {
    beforeEach(() => {
      useQuestionStore.setState({ pendingBySession: new Map() })
    })

    test('addQuestion stores a question for a session', () => {
      const request = {
        id: 'q1',
        sessionID: 's1',
        questions: [{ question: 'Pick one', header: 'Choice', options: [] }]
      }
      useQuestionStore.getState().addQuestion('hive-1', request)
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(1)
    })

    test('addQuestion prevents duplicates', () => {
      const request = { id: 'q1', sessionID: 's1', questions: [] }
      useQuestionStore.getState().addQuestion('hive-1', request)
      useQuestionStore.getState().addQuestion('hive-1', request)
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(1)
    })

    test('removeQuestion removes by ID', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 's1', questions: [] })
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q2', sessionID: 's1', questions: [] })
      useQuestionStore.getState().removeQuestion('hive-1', 'q1')
      const remaining = useQuestionStore.getState().getQuestions('hive-1')
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('q2')
    })

    test('getActiveQuestion returns first pending question', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 's1', questions: [] })
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q2', sessionID: 's1', questions: [] })
      expect(useQuestionStore.getState().getActiveQuestion('hive-1')?.id).toBe('q1')
    })

    test('getActiveQuestion returns null when no questions', () => {
      expect(useQuestionStore.getState().getActiveQuestion('hive-1')).toBeNull()
    })

    test('clearSession removes all questions for a session', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 's1', questions: [] })
      useQuestionStore.getState().clearSession('hive-1')
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
    })
  })

  describe('IPC layer (source verification)', () => {
    test('opencode:question:reply handler registered', () => {
      // Verify the IPC handler source exists in opencode-handlers.ts
    })

    test('opencode:question:reject handler registered', () => {
      // Verify the IPC handler source exists in opencode-handlers.ts
    })

    test('preload exposes questionReply and questionReject', () => {
      // Verify window.opencodeOps.questionReply exists
      // Verify window.opencodeOps.questionReject exists
    })
  })
})
```

---

## Session 2: QuestionPrompt UI Component

### Objectives

- Build the `QuestionPrompt` component that renders interactive question UI inline in the session
- Support single-choice (auto-submit), multi-choice (toggle + submit), and custom free-text input
- Support multi-question tab navigation with a confirm review step

### Tasks

#### 1. Create `QuestionPrompt.tsx`

Create `src/renderer/src/components/sessions/QuestionPrompt.tsx`.

The component receives a `QuestionRequest` and callbacks for reply/reject. Key behaviors:

- **Single question, single choice** (`questions.length === 1 && !multiple`): Clicking an option immediately calls `onReply` with `[[label]]`. No confirm step.
- **Single question, multiple choice** (`multiple: true`): Toggle options with checkmarks. "Submit" button sends all selected labels.
- **Multiple questions**: Tab interface with question headers. "Next" advances tabs. Final tab shows a review. "Submit" sends all answers.
- **Custom text** (default unless `custom: false`): "Type your own answer" option opens an inline text input form.
- **Dismiss**: "Dismiss" button calls `onReject`.

```typescript
interface QuestionPromptProps {
  request: QuestionRequest
  onReply: (requestId: string, answers: QuestionAnswer[]) => void
  onReject: (requestId: string) => void
}
```

State:

```typescript
const [currentTab, setCurrentTab] = useState(0)
const [answers, setAnswers] = useState<QuestionAnswer[]>(request.questions.map(() => []))
const [customInputs, setCustomInputs] = useState<string[]>(request.questions.map(() => ''))
const [editingCustom, setEditingCustom] = useState(false)
const [sending, setSending] = useState(false)
```

Styling should follow the existing tool card patterns — use `bg-zinc-900/50` container, `border border-border`, lucide icons, consistent text sizes.

Reference: `<opencode-repo-path>` — see `packages/ui/src/components/message-part.tsx` (QuestionPrompt component) and `packages/app/src/components/question-dock.tsx` (QuestionDock component) for the OpenCode client's implementation.

#### 2. Implement option rendering

Each option is a clickable button showing `label` and `description`:

```typescript
<button
  onClick={() => handleOptionClick(option.label)}
  className={cn(
    'w-full text-left px-3 py-2 rounded-md border transition-colors',
    isSelected
      ? 'border-blue-500/50 bg-blue-500/10'
      : 'border-border hover:border-muted-foreground/30 hover:bg-muted/50'
  )}
>
  <div className="flex items-center gap-2">
    {isMultiple && (
      <div className={cn('h-4 w-4 rounded border flex items-center justify-center',
        isSelected ? 'bg-blue-500 border-blue-500' : 'border-muted-foreground/40'
      )}>
        {isSelected && <Check className="h-3 w-3 text-white" />}
      </div>
    )}
    <span className="text-sm font-medium">{option.label}</span>
  </div>
  {option.description && (
    <p className="text-xs text-muted-foreground mt-0.5 ml-6">{option.description}</p>
  )}
</button>
```

#### 3. Implement custom text input

When "Type your own answer" is clicked, show an inline form:

```typescript
{editingCustom && (
  <form onSubmit={handleCustomSubmit} className="flex gap-2">
    <input
      autoFocus
      value={customInputs[currentTab]}
      onChange={(e) => { /* update customInputs */ }}
      className="flex-1 bg-background border border-border rounded px-2 py-1 text-sm"
      placeholder="Type your answer..."
    />
    <Button size="sm" type="submit">Submit</Button>
    <Button size="sm" variant="ghost" onClick={() => setEditingCustom(false)}>Cancel</Button>
  </form>
)}
```

#### 4. Implement multi-question tabs

When `questions.length > 1`, render tab headers and navigation:

```typescript
{request.questions.length > 1 && (
  <div className="flex gap-1 mb-3">
    {request.questions.map((q, i) => (
      <button
        key={i}
        onClick={() => setCurrentTab(i)}
        className={cn(
          'px-2 py-1 text-xs rounded',
          i === currentTab ? 'bg-muted text-foreground' : 'text-muted-foreground'
        )}
      >
        {q.header}
        {answers[i]?.length > 0 && <Check className="h-3 w-3 ml-1 inline" />}
      </button>
    ))}
  </div>
)}
```

### Key Files

- `src/renderer/src/components/sessions/QuestionPrompt.tsx` — **NEW**

### Definition of Done

- [ ] `QuestionPrompt` component created with all interaction modes
- [ ] Single-choice auto-submits on click
- [ ] Multi-choice allows toggling with checkmarks and "Submit" button
- [ ] Multi-question shows tabs and review step
- [ ] Custom text input works with form submission
- [ ] Dismiss button calls `onReject`
- [ ] Sending state disables buttons to prevent double-submit
- [ ] Component handles empty options array gracefully (shows only custom input)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Render `QuestionPrompt` with a single question, 3 options, `multiple: false`
2. Click an option — verify `onReply` called immediately with `[['selected label']]`
3. Render with `multiple: true` — click two options, click Submit — verify `onReply` called with `[['label1', 'label2']]`
4. Click "Type your own answer" — type text, submit — verify `onReply` called with custom text
5. Click "Dismiss" — verify `onReject` called
6. Render with 2 questions — verify tab navigation, review step, and final submit

### Testing Criteria

```typescript
// test/phase-10/session-2/question-prompt-ui.test.ts
describe('Session 2: QuestionPrompt UI', () => {
  const singleQuestion: QuestionRequest = {
    id: 'q1',
    sessionID: 's1',
    questions: [{
      question: 'Which framework?',
      header: 'Framework',
      options: [
        { label: 'React', description: 'Component-based UI' },
        { label: 'Vue', description: 'Progressive framework' }
      ]
    }]
  }

  test('renders question text and options', () => {
    render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={vi.fn()} />)
    expect(screen.getByText('Which framework?')).toBeInTheDocument()
    expect(screen.getByText('React')).toBeInTheDocument()
    expect(screen.getByText('Vue')).toBeInTheDocument()
  })

  test('single-choice auto-submits on click', () => {
    const onReply = vi.fn()
    render(<QuestionPrompt request={singleQuestion} onReply={onReply} onReject={vi.fn()} />)
    fireEvent.click(screen.getByText('React'))
    expect(onReply).toHaveBeenCalledWith('q1', [['React']])
  })

  test('dismiss calls onReject', () => {
    const onReject = vi.fn()
    render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={onReject} />)
    fireEvent.click(screen.getByText(/dismiss/i))
    expect(onReject).toHaveBeenCalledWith('q1')
  })

  test('multi-choice allows toggling and submit', () => {
    const multiRequest = {
      ...singleQuestion,
      questions: [{ ...singleQuestion.questions[0], multiple: true }]
    }
    const onReply = vi.fn()
    render(<QuestionPrompt request={multiRequest} onReply={onReply} onReject={vi.fn()} />)
    fireEvent.click(screen.getByText('React'))
    fireEvent.click(screen.getByText('Vue'))
    fireEvent.click(screen.getByText(/submit/i))
    expect(onReply).toHaveBeenCalledWith('q1', [['React', 'Vue']])
  })

  test('custom text input works', () => {
    const onReply = vi.fn()
    render(<QuestionPrompt request={singleQuestion} onReply={onReply} onReject={vi.fn()} />)
    fireEvent.click(screen.getByText(/type your own/i))
    const input = screen.getByPlaceholderText(/type your answer/i)
    fireEvent.change(input, { target: { value: 'Svelte' } })
    fireEvent.submit(input.closest('form')!)
    expect(onReply).toHaveBeenCalledWith('q1', [['Svelte']])
  })
})
```

---

## Session 3: Question Event Handling in SessionView

### Objectives

- Handle `question.asked`, `question.replied`, and `question.rejected` events in the stream handler
- Render `QuestionPrompt` inline in the session view when a pending question exists
- Wire reply/reject callbacks through to the preload API

### Tasks

#### 1. Add question event handling in stream handler

In `src/renderer/src/components/sessions/SessionView.tsx`, inside the `onStream` callback (around line 830), add branches for question events before the existing `message.part.updated` branch:

```typescript
// Handle question events
if (event.type === 'question.asked') {
  const request = event.data
  if (request?.id && request?.questions) {
    useQuestionStore.getState().addQuestion(sessionId, request)
  }
  return
}

if (event.type === 'question.replied' || event.type === 'question.rejected') {
  const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
  if (requestId) {
    useQuestionStore.getState().removeQuestion(sessionId, requestId)
  }
  return
}
```

#### 2. Subscribe to active question from the store

Add near the other store subscriptions at the top of the component:

```typescript
const activeQuestion = useQuestionStore((s) => s.getActiveQuestion(sessionId))
```

#### 3. Create reply/reject callbacks

```typescript
const handleQuestionReply = useCallback(
  async (requestId: string, answers: string[][]) => {
    try {
      await window.opencodeOps.questionReply(requestId, answers, worktreePath || undefined)
    } catch (err) {
      console.error('Failed to reply to question:', err)
      toast.error('Failed to send answer')
    }
  },
  [worktreePath]
)

const handleQuestionReject = useCallback(
  async (requestId: string) => {
    try {
      await window.opencodeOps.questionReject(requestId, worktreePath || undefined)
    } catch (err) {
      console.error('Failed to reject question:', err)
      toast.error('Failed to dismiss question')
    }
  },
  [worktreePath]
)
```

#### 4. Render QuestionPrompt in JSX

Place the `QuestionPrompt` after the streaming content area, before the input:

```typescript
{activeQuestion && (
  <div className="px-4 pb-2">
    <QuestionPrompt
      request={activeQuestion}
      onReply={handleQuestionReply}
      onReject={handleQuestionReject}
    />
  </div>
)}
```

#### 5. Clear questions on session switch/cleanup

In the session initialization effect cleanup, add:

```typescript
useQuestionStore.getState().clearSession(sessionId)
```

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — event handling, rendering, callbacks

### Definition of Done

- [ ] `question.asked` events add questions to the store
- [ ] `question.replied` and `question.rejected` events remove questions from the store
- [ ] `QuestionPrompt` renders inline when `activeQuestion` is non-null
- [ ] Reply callback calls `window.opencodeOps.questionReply` with correct args
- [ ] Reject callback calls `window.opencodeOps.questionReject` with correct args
- [ ] Error toast shown on reply/reject failure
- [ ] Questions cleared on session switch
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a prompt that triggers the AI to ask a question (e.g., "I need to configure the project but I'm not sure which package manager to use")
2. Verify the QuestionPrompt appears inline with options
3. Click an option — verify the answer is sent, the prompt disappears, and the AI continues
4. Trigger another question — click "Dismiss" — verify the question disappears
5. Switch sessions and back — verify pending questions are cleared

### Testing Criteria

```typescript
// test/phase-10/session-3/question-session-integration.test.ts
describe('Session 3: Question Session Integration', () => {
  test('question.asked event adds to store', () => {
    const event = {
      type: 'question.asked',
      sessionId: 'hive-1',
      data: {
        id: 'q1',
        sessionID: 'opc-1',
        questions: [{ question: 'Pick one', header: 'Choice', options: [] }]
      }
    }
    // Simulate stream handler receiving this event
    // Verify useQuestionStore has the question for 'hive-1'
  })

  test('question.replied event removes from store', () => {
    // Add a question to store
    // Simulate question.replied event with matching requestID
    // Verify question removed
  })

  test('question.rejected event removes from store', () => {
    // Add a question to store
    // Simulate question.rejected event with matching requestID
    // Verify question removed
  })

  test('session cleanup clears questions', () => {
    // Add questions for a session
    // Simulate session switch (cleanup runs)
    // Verify questions cleared
  })

  test('QuestionPrompt rendered when active question exists', () => {
    // Add a question to the store for the current session
    // Verify QuestionPrompt component is rendered in the DOM
  })
})
```

---

## Session 4: Scroll-to-Bottom FAB — Fix Premature Display

### Objectives

- Add a `userHasScrolledUpRef` flag that gates FAB visibility
- Prevent the FAB from appearing due to streaming content growth alone
- Only show the FAB after the user has intentionally scrolled up

### Tasks

#### 1. Add `userHasScrolledUpRef`

In `src/renderer/src/components/sessions/SessionView.tsx`, add after the existing scroll refs (line 378):

```typescript
const userHasScrolledUpRef = useRef(false)
```

#### 2. Modify `handleScroll` to set the flag on intentional scroll-up

In the `handleScroll` callback (lines 429-475), modify the upward scroll branch (line 441) to set the flag:

```typescript
// Upward scroll during streaming → mark as intentional, disable + cooldown
if (scrollingUp && (isSending || isStreaming)) {
  userHasScrolledUpRef.current = true  // NEW
  isAutoScrollEnabledRef.current = false
  setShowScrollFab(true)
  // ... rest of existing cooldown logic
```

#### 3. Gate the "far from bottom" branch on the flag

Modify the `else if (!isNearBottom && ...)` branch (line 470) to require the flag:

```typescript
// BEFORE (line 470-473):
} else if (!isNearBottom && (isSending || isStreaming)) {
  isAutoScrollEnabledRef.current = false
  setShowScrollFab(true)
}

// AFTER:
} else if (!isNearBottom && (isSending || isStreaming) && userHasScrolledUpRef.current) {
  isAutoScrollEnabledRef.current = false
  setShowScrollFab(true)
}
```

This is the key change: without `userHasScrolledUpRef.current`, streaming content growth that pushes `distanceFromBottom > 80` no longer shows the FAB.

#### 4. Reset the flag when returning to bottom

In the "near bottom, no cooldown" branch (line 467-469), reset the flag:

```typescript
if (isNearBottom && !isScrollCooldownActiveRef.current) {
  isAutoScrollEnabledRef.current = true
  setShowScrollFab(false)
  userHasScrolledUpRef.current = false // NEW
}
```

Also in the cooldown expiry callback (inside the `setTimeout` at line 450-462), add the reset when near bottom:

```typescript
if (dist < 80) {
  isAutoScrollEnabledRef.current = true
  setShowScrollFab(false)
  userHasScrolledUpRef.current = false // NEW
}
```

#### 5. Reset the flag in all scroll-to-bottom reset points

Add `userHasScrolledUpRef.current = false` in:

- **FAB click** (`handleScrollToBottomClick`, line 478): after `isScrollCooldownActiveRef.current = false`
- **Send message** (`handleSend`, line 1399): after `isScrollCooldownActiveRef.current = false`
- **Session switch** (session reset effect, line 504): after `setShowScrollFab(false)`

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — `handleScroll`, reset points

### Definition of Done

- [ ] `userHasScrolledUpRef` added and initialized to `false`
- [ ] FAB never appears during normal streaming when user has not scrolled up
- [ ] FAB appears immediately when user scrolls up during streaming
- [ ] Flag resets when user scrolls back to bottom
- [ ] Flag resets on FAB click, send message, session switch
- [ ] Existing cooldown behavior preserved
- [ ] Auto-scroll behavior unchanged for the non-FAB case
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start streaming a long response — verify FAB does NOT appear even if the scroll lags behind content growth
2. During streaming, manually scroll up — verify FAB appears immediately
3. Click the FAB — verify it scrolls to bottom and disappears
4. Scroll up again, then manually scroll all the way back to bottom — verify FAB disappears
5. Send a new message after scrolling up — verify FAB disappears and auto-scroll resumes
6. Switch sessions — verify FAB state resets

### Testing Criteria

```typescript
// test/phase-10/session-4/scroll-fab-fix.test.ts
describe('Session 4: Scroll FAB Fix', () => {
  // Create a scroll tracker helper (mirroring the handleScroll logic)
  function createScrollTracker() {
    let isAutoScrollEnabled = true
    let showScrollFab = false
    let lastScrollTop = 0
    let userHasScrolledUp = false
    let isCooldownActive = false

    return {
      get state() {
        return { isAutoScrollEnabled, showScrollFab, userHasScrolledUp }
      },
      handleScroll(
        scrollTop: number,
        scrollHeight: number,
        clientHeight: number,
        isStreaming: boolean
      ) {
        const scrollingUp = scrollTop < lastScrollTop
        lastScrollTop = scrollTop
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight
        const isNearBottom = distanceFromBottom < 80

        if (scrollingUp && isStreaming) {
          userHasScrolledUp = true
          isAutoScrollEnabled = false
          showScrollFab = true
          return
        }
        if (isNearBottom && !isCooldownActive) {
          isAutoScrollEnabled = true
          showScrollFab = false
          userHasScrolledUp = false
        } else if (!isNearBottom && isStreaming && userHasScrolledUp) {
          isAutoScrollEnabled = false
          showScrollFab = true
        }
      },
      reset() {
        userHasScrolledUp = false
        isAutoScrollEnabled = true
        showScrollFab = false
        isCooldownActive = false
      }
    }
  }

  test('FAB does NOT show when content grows during streaming (no user scroll)', () => {
    const tracker = createScrollTracker()
    // Simulate content growing: scrollHeight increases, scrollTop stays at 0
    tracker.handleScroll(0, 500, 400, true) // distance=100, but userHasScrolledUp=false
    expect(tracker.state.showScrollFab).toBe(false)
    tracker.handleScroll(0, 600, 400, true) // distance=200
    expect(tracker.state.showScrollFab).toBe(false)
  })

  test('FAB shows when user scrolls up during streaming', () => {
    const tracker = createScrollTracker()
    tracker.handleScroll(100, 500, 400, true) // initial position
    tracker.handleScroll(50, 500, 400, true) // scrolled UP
    expect(tracker.state.showScrollFab).toBe(true)
    expect(tracker.state.userHasScrolledUp).toBe(true)
  })

  test('FAB shows for far-from-bottom AFTER user has scrolled up', () => {
    const tracker = createScrollTracker()
    tracker.handleScroll(100, 500, 400, true) // near bottom initially
    tracker.handleScroll(50, 500, 400, true) // user scrolls up → flag set
    tracker.handleScroll(50, 600, 400, true) // content grows, still far → FAB stays
    expect(tracker.state.showScrollFab).toBe(true)
  })

  test('flag resets when scrolling back to bottom', () => {
    const tracker = createScrollTracker()
    tracker.handleScroll(100, 500, 400, true)
    tracker.handleScroll(50, 500, 400, true) // scroll up
    expect(tracker.state.userHasScrolledUp).toBe(true)
    tracker.handleScroll(420, 500, 400, true) // scroll back to bottom (distance < 80)
    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.showScrollFab).toBe(false)
  })

  test('reset clears all state', () => {
    const tracker = createScrollTracker()
    tracker.handleScroll(100, 500, 400, true)
    tracker.handleScroll(50, 500, 400, true) // scroll up
    tracker.reset()
    expect(tracker.state.userHasScrolledUp).toBe(false)
    expect(tracker.state.showScrollFab).toBe(false)
    expect(tracker.state.isAutoScrollEnabled).toBe(true)
  })
})
```

---

## Session 5: Write Tool — Dedicated View with File Name

### Objectives

- Create a `WriteToolView` component that shows the file path and syntax-highlighted content
- Replace the `ReadToolView` reuse for Write tools in `ToolCard.tsx`

### Tasks

#### 1. Create `WriteToolView.tsx`

Create `src/renderer/src/components/sessions/tools/WriteToolView.tsx`:

The component extracts `filePath` and `content` from `input` (same field names as the collapsed header). It renders:

1. Syntax-highlighted content using `react-syntax-highlighter` with `oneDark` theme
2. Language detection from file extension
3. Line numbers
4. Truncation to 20 lines with "Show all N lines" toggle

Model this after the existing `ReadToolView.tsx` pattern but read from `input.content` instead of `output`.

#### 2. Update `ToolCard.tsx` — TOOL_RENDERERS map

In `src/renderer/src/components/sessions/ToolCard.tsx`, change lines 166-167:

```typescript
// BEFORE:
Write: ReadToolView, // Similar rendering to Read
write_file: ReadToolView,

// AFTER:
Write: WriteToolView,
write_file: WriteToolView,
```

#### 3. Update `ToolCard.tsx` — fallback resolver

Change line 187:

```typescript
// BEFORE:
if (lower.includes('write') || lower === 'create') return ReadToolView

// AFTER:
if (lower.includes('write') || lower === 'create') return WriteToolView
```

#### 4. Add import to `ToolCard.tsx`

```typescript
import { WriteToolView } from './tools'
```

#### 5. Export from `tools/index.ts`

In `src/renderer/src/components/sessions/tools/index.ts`, add:

```typescript
export { WriteToolView } from './WriteToolView'
```

### Key Files

- `src/renderer/src/components/sessions/tools/WriteToolView.tsx` — **NEW**
- `src/renderer/src/components/sessions/tools/index.ts` — export
- `src/renderer/src/components/sessions/ToolCard.tsx` — map Write to WriteToolView

### Definition of Done

- [ ] `WriteToolView` component created with syntax highlighting
- [ ] File content read from `input.content` (not `output`)
- [ ] Language detected from file extension
- [ ] Line numbers shown
- [ ] Truncated to 20 lines with "Show all" toggle
- [ ] `TOOL_RENDERERS` maps `Write`/`write_file` to `WriteToolView`
- [ ] Fallback resolver updated
- [ ] Collapsed header continues to show file path and line count (unchanged)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Trigger a Write tool call (e.g., ask the AI to create a new file)
2. Verify the collapsed tool card header shows `<FilePlus> Write <filepath> <N lines>`
3. Expand the tool card — verify syntax-highlighted content is shown
4. If the file has more than 20 lines, verify the "Show all N lines" toggle works
5. Compare with the Edit tool card — verify similar visual treatment

### Testing Criteria

```typescript
// test/phase-10/session-5/write-tool-view.test.ts
describe('Session 5: WriteToolView', () => {
  test('renders content from input.content', () => {
    render(<WriteToolView
      name="Write"
      input={{ filePath: 'src/index.ts', content: 'const x = 1\nconst y = 2' }}
      status="success"
    />)
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument()
  })

  test('renders with empty content gracefully', () => {
    render(<WriteToolView name="Write" input={{}} status="success" />)
    // Should not crash
  })

  test('truncates to 20 lines with show-all toggle', () => {
    const longContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    render(<WriteToolView
      name="Write"
      input={{ filePath: 'test.ts', content: longContent }}
      status="success"
    />)
    expect(screen.getByText(/show all 30 lines/i)).toBeInTheDocument()
  })

  test('ToolCard maps Write to WriteToolView', () => {
    // Verify TOOL_RENDERERS['Write'] is WriteToolView
    // Verify TOOL_RENDERERS['write_file'] is WriteToolView
  })
})
```

---

## Session 6: Show in Finder — QuickActions & Command Palette Fix

### Objectives

- Add a "Finder" option to the QuickActions dropdown
- Fix the broken `window.worktreeOps.openInFinder` call in the command palette

### Tasks

#### 1. Update `QuickActionType` union

In `src/renderer/src/stores/useSettingsStore.ts`, line 17:

```typescript
// BEFORE:
export type QuickActionType = 'cursor' | 'ghostty' | 'copy-path'

// AFTER:
export type QuickActionType = 'cursor' | 'ghostty' | 'copy-path' | 'finder'
```

#### 2. Add Finder action to QuickActions

In `src/renderer/src/components/layout/QuickActions.tsx`:

Add `FolderOpen` to the lucide imports (line 1):

```typescript
// BEFORE:
import { ChevronDown, ExternalLink, Copy, Check } from 'lucide-react'

// AFTER:
import { ChevronDown, ExternalLink, Copy, Check, FolderOpen } from 'lucide-react'
```

Add the new action to the `ACTIONS` array (line 38-42):

```typescript
const ACTIONS: ActionConfig[] = [
  { id: 'cursor', label: 'Cursor', icon: <CursorIcon className="h-3.5 w-3.5" /> },
  { id: 'ghostty', label: 'Ghostty', icon: <GhosttyIcon className="h-3.5 w-3.5" /> },
  { id: 'copy-path', label: 'Copy Path', icon: <Copy className="h-3.5 w-3.5" /> },
  { id: 'finder', label: 'Finder', icon: <FolderOpen className="h-3.5 w-3.5" /> }
]
```

#### 3. Add Finder branch to `executeAction`

In the `executeAction` callback (lines 65-83), add the `finder` case:

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

#### 4. Fix command palette "Reveal in Finder" bug

In `src/renderer/src/hooks/useCommands.ts`, line 327:

```typescript
// BEFORE:
await window.worktreeOps.openInFinder(worktreePath)

// AFTER:
await window.projectOps.showInFolder(worktreePath)
```

### Key Files

- `src/renderer/src/stores/useSettingsStore.ts` — update type union
- `src/renderer/src/components/layout/QuickActions.tsx` — add Finder action
- `src/renderer/src/hooks/useCommands.ts` — fix broken call

### Definition of Done

- [ ] `QuickActionType` includes `'finder'`
- [ ] "Finder" appears as the 4th item in the QuickActions dropdown
- [ ] Clicking "Finder" opens the worktree directory in macOS Finder
- [ ] "Finder" can be set as the last-used quick action (remembers across clicks)
- [ ] Command palette "Reveal in Finder" action calls `window.projectOps.showInFolder()` (no runtime error)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Click the QuickActions dropdown chevron — verify "Finder" appears as the 4th option
2. Click "Finder" — verify macOS Finder opens with the worktree directory selected
3. Click the main QuickActions button — verify "Finder" is now the last-used action
4. Open command palette (Cmd+K), type "finder" — verify "Reveal in Finder" appears
5. Select it — verify Finder opens (no console error)

### Testing Criteria

```typescript
// test/phase-10/session-6/show-in-finder.test.ts
describe('Session 6: Show in Finder', () => {
  test('ACTIONS array includes finder', () => {
    // Verify ACTIONS has 4 items
    // Verify the 4th item has id: 'finder'
  })

  test('executeAction calls showInFolder for finder', () => {
    // Mock window.projectOps.showInFolder
    // Call executeAction('finder')
    // Verify showInFolder called with worktreePath
  })

  test('command palette reveal-in-finder uses projectOps.showInFolder', () => {
    // Verify source code of useCommands.ts uses window.projectOps.showInFolder
    // (not window.worktreeOps.openInFinder)
  })

  test('QuickActionType includes finder', () => {
    // Verify TypeScript accepts 'finder' as QuickActionType
  })
})
```

---

## Session 7: Slash Commands — SDK Command Endpoint & Mode Switching

### Objectives

- Route slash commands through the SDK's `session.command()` endpoint instead of sending as raw prompt text
- Auto-switch between Build/Plan mode based on the command's `agent` field
- Update the `OpenCodeCommand` type to include `agent` and other SDK fields

### Tasks

#### 1. Update `OpenCodeCommand` type

In `src/preload/index.d.ts` (lines 552-557):

```typescript
// BEFORE:
interface OpenCodeCommand {
  name: string
  description?: string
  template: string
}

// AFTER:
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

#### 2. Update preload `commands()` return type

In `src/preload/index.ts` (lines 691-698), update the return type to use the broader type. The SDK already returns these fields; we were just discarding them.

#### 3. Update service `listCommands()` return type

In `src/main/services/opencode-service.ts` (lines 1231-1245), update the return type to include all SDK fields:

```typescript
async listCommands(
  worktreePath: string
): Promise<Array<{
  name: string; description?: string; template: string
  agent?: string; model?: string; source?: string
  subtask?: boolean; hints?: string[]
}>> {
```

#### 4. Add `sendCommand()` service method

In `src/main/services/opencode-service.ts`, add after the existing `listCommands()` method:

```typescript
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

#### 5. Add IPC handler

In `src/main/ipc/opencode-handlers.ts`:

```typescript
ipcMain.handle(
  'opencode:command',
  async (
    _event,
    {
      worktreePath,
      sessionId,
      command,
      args
    }: { worktreePath: string; sessionId: string; command: string; args: string }
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

#### 6. Expose in preload

In `src/preload/index.ts`, add to `opencodeOps`:

```typescript
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

#### 7. Add type declaration

In `src/preload/index.d.ts`, add to `opencodeOps`:

```typescript
command: (worktreePath: string, opencodeSessionId: string, command: string, args: string) =>
  Promise<{ success: boolean; error?: string }>
```

#### 8. Modify `handleSend` to detect and route slash commands

In `src/renderer/src/components/sessions/SessionView.tsx`, in the `handleSend` function (around line 1461), add slash command detection before the regular prompt path:

```typescript
if (worktreePath && opencodeSessionId) {
  if (trimmedValue.startsWith('/')) {
    const spaceIndex = trimmedValue.indexOf(' ')
    const commandName = spaceIndex > 0 ? trimmedValue.slice(1, spaceIndex) : trimmedValue.slice(1)
    const commandArgs = spaceIndex > 0 ? trimmedValue.slice(spaceIndex + 1).trim() : ''

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

      const result = await window.opencodeOps.command(
        worktreePath,
        opencodeSessionId,
        commandName,
        commandArgs
      )
      if (!result.success) {
        console.error('Failed to send command:', result.error)
        toast.error('Failed to send command')
        setIsSending(false)
      }
    } else {
      // Unknown command — send as regular prompt (SDK may handle it)
      const result = await window.opencodeOps.prompt(worktreePath, opencodeSessionId, [
        { type: 'text' as const, text: trimmedValue }
      ])
      if (!result.success) {
        toast.error('Failed to send message to AI')
        setIsSending(false)
      }
    }
  } else {
    // Regular prompt — existing code (with mode prefix, attachments, etc.)
    // ... keep existing code unchanged
  }
}
```

#### 9. Update `SlashCommandPopover` to show agent badge

In `src/renderer/src/components/sessions/SlashCommandPopover.tsx`, update the interface (lines 4-8):

```typescript
interface SlashCommand {
  name: string
  description?: string
  template: string
  agent?: string
}
```

Add an agent badge in the command item rendering (inside the `.map` block):

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
```

### Key Files

- `src/main/services/opencode-service.ts` — `sendCommand()`, updated `listCommands()` return type
- `src/main/ipc/opencode-handlers.ts` — `opencode:command` handler
- `src/preload/index.ts` — `command()` method, updated `commands()` type
- `src/preload/index.d.ts` — `OpenCodeCommand` type update, `command()` declaration
- `src/renderer/src/components/sessions/SessionView.tsx` — slash command detection in `handleSend`, mode switching
- `src/renderer/src/components/sessions/SlashCommandPopover.tsx` — `agent` field, badge UI

### Definition of Done

- [ ] `OpenCodeCommand` type includes `agent`, `model`, `source`, `subtask`, `hints`
- [ ] `sendCommand()` service method calls `client.session.command()`
- [ ] `opencode:command` IPC handler registered
- [ ] Preload exposes `command()` on `window.opencodeOps`
- [ ] Typing `/command-name args` routes through `session.command()` (not `prompt()`)
- [ ] Unknown `/commands` fall through to regular prompt sending
- [ ] If command has `agent: 'plan'` and current mode is `build`, mode auto-switches to `plan`
- [ ] If command has `agent: 'build'` and current mode is `plan`, mode auto-switches to `build`
- [ ] Commands without `agent` field don't trigger mode switch
- [ ] Slash command popover shows agent badge (plan = violet, build = blue)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a command file at `.opencode/command/test-plan.md` with `agent: plan`
2. Start in Build mode, type `/test-plan`, press Enter
3. Verify mode switches to Plan (mode toggle changes from blue/Hammer to violet/Map)
4. Verify the command is processed by the SDK (response streams back)
5. Type `/unknown-command` — verify it falls through to regular prompt
6. Open the slash command popover — verify agent badges appear

### Testing Criteria

```typescript
// test/phase-10/session-7/slash-command-execution.test.ts
describe('Session 7: Slash Command Execution', () => {
  test('slash command detected in handleSend', () => {
    // Input: '/test-plan some args'
    // Verify command name extracted as 'test-plan'
    // Verify args extracted as 'some args'
  })

  test('matched command routes to command endpoint', () => {
    // Mock slashCommands with { name: 'test-plan', agent: 'plan', ... }
    // Mock window.opencodeOps.command
    // Send '/test-plan args'
    // Verify command() called, NOT prompt()
  })

  test('unknown command falls through to prompt', () => {
    // Mock slashCommands (no match for 'unknown')
    // Mock window.opencodeOps.prompt
    // Send '/unknown args'
    // Verify prompt() called
  })

  test('mode switches from build to plan when command.agent is plan', () => {
    // Current mode: build
    // Command has agent: 'plan'
    // Verify setSessionMode called with 'plan'
  })

  test('mode does not switch when agent matches current', () => {
    // Current mode: plan
    // Command has agent: 'plan'
    // Verify setSessionMode NOT called
  })

  test('no mode switch when command has no agent field', () => {
    // Command has no agent
    // Verify setSessionMode NOT called
  })

  test('SlashCommandPopover shows agent badge', () => {
    // Render popover with a command that has agent: 'plan'
    // Verify badge element with text 'plan' and violet styling
  })
})
```

---

## Session 8: Integration & Verification

### Objectives

- Verify all Phase 10 features work correctly together
- Test cross-feature interactions
- Run lint and tests
- Fix any edge cases or regressions

### Tasks

#### 1. Question + Streaming interaction

- Send a prompt → AI asks a question mid-stream → verify FAB doesn't appear from content shift when question renders
- Answer the question → verify streaming resumes and auto-scroll continues

#### 2. Question + Scroll FAB interaction

- Scroll up during streaming → FAB appears → question arrives → verify both FAB and QuestionPrompt visible
- Click FAB to scroll down → verify QuestionPrompt is visible at the bottom
- Answer question → verify session continues

#### 3. Slash command + Question interaction

- Use a slash command that triggers a question → verify mode auto-switches first, then question renders

#### 4. Write tool + streaming

- Trigger a Write tool call → verify the expanded view shows the file content
- Verify Write tool collapsed header still shows file path and line count

#### 5. Show in Finder + QuickActions

- Set Finder as last-used action → close and reopen dropdown → verify it's remembered
- Use Finder from command palette → verify no error

#### 6. Scroll FAB with all features active

- Stream a response with tool calls (Write, Edit) + question → scroll up → verify FAB visible
- Click FAB → verify scroll to bottom
- Verify question is still answerable after scrolling

#### 7. Full smoke test

Run through:

1. Open app → select worktree → new session → type `/test-plan` (agent: plan) → verify mode switches to Plan → response streams → question appears → answer it → response continues → trigger Write tool → expand to see content → scroll up during streaming → FAB appears → click FAB → send another message → use QuickActions "Finder" → verify Finder opens → Cmd+K → "Reveal in Finder" → no error

#### 8. Run lint and tests

```bash
pnpm lint
pnpm test
```

Fix any failures.

### Key Files

- All files modified in sessions 1–7

### Definition of Done

- [ ] All 5 features work correctly in isolation
- [ ] Cross-feature interactions work correctly
- [ ] No regressions in Phase 9 features (Cmd+W, PATH, abort, drafts, file search, subagents)
- [ ] No console errors during normal operation
- [ ] No leaked timers, rAF callbacks, or IPC listeners
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Full happy path smoke test passes

### How to Test

Run through each integration scenario listed in Tasks above. Pay special attention to:

- Question rendering during active streaming (timing-sensitive)
- Mode switching before command execution (must complete before sending)
- FAB visibility with both streaming and question content changes

### Testing Criteria

```typescript
// test/phase-10/session-8/integration-verification.test.ts
describe('Session 8: Integration & Verification', () => {
  test('question event handled during streaming', () => {
    // Start streaming, receive question.asked event
    // Verify question added to store while streaming continues
  })

  test('FAB does not appear from question rendering', () => {
    // Streaming active, auto-scroll enabled
    // Question renders (shifts content)
    // Verify FAB does not appear (userHasScrolledUp is false)
  })

  test('slash command mode switch + question', () => {
    // Send /plan-command (agent: plan)
    // Verify mode switches
    // Receive question.asked
    // Verify question renders in plan mode
  })

  test('Write tool renders correctly during streaming', () => {
    // Stream includes a Write tool_use part
    // Verify WriteToolView renders with file content
  })

  test('Finder action works from QuickActions', () => {
    // Mock window.projectOps.showInFolder
    // Execute 'finder' action
    // Verify showInFolder called
  })

  test('command palette Reveal in Finder works', () => {
    // Mock window.projectOps.showInFolder
    // Execute action:reveal-in-finder command
    // Verify showInFolder called (not openInFinder)
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
Session 1 (Question Store & IPC)       ── independent, store + main + preload
    |
    └──► Session 2 (Question UI)        ── depends on Session 1 (needs store types)
              |
              └──► Session 3 (Question SessionView)  ── depends on Sessions 1+2 (needs store + component)

Session 4 (Scroll FAB Fix)             ── independent, SessionView scroll logic only
Session 5 (Write Tool View)            ── independent, new component + ToolCard mapping
Session 6 (Show in Finder)             ── independent, QuickActions + useCommands
Session 7 (Slash Commands)             ── independent, full IPC chain + SessionView

Session 8 (Integration)                ── requires sessions 1-7
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────────┐
│  Time →                                                              │
│                                                                      │
│  Track A: [S1: Q Store/IPC] → [S2: Q UI] → [S3: Q SessionView]      │
│  Track B: [S4: Scroll FAB Fix]                                       │
│  Track C: [S5: Write Tool View]                                      │
│  Track D: [S6: Show in Finder]                                       │
│  Track E: [S7: Slash Commands]                                       │
│                                                                      │
│  All ────────────────────────────────────────► [S8: Integration]      │
└──────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Tracks A–E are fully independent. Within Track A, sessions are sequential (1 → 2 → 3).

**Critical path**: Track A (Sessions 1 → 2 → 3) is the longest sequential chain at 3 sessions.

**Minimum total**: 4 rounds — (S1, S4, S5, S6, S7 in parallel) → (S2) → (S3) → (S8).

---

## Notes

### Assumed Phase 9 Infrastructure

- Cmd+W session close override
- PATH fix for Finder/Dock launch
- Copy on hover for messages
- Streaming abort (stop button)
- Per-session input draft persistence
- Hidden files in file tree
- Cmd+D file search dialog
- Subagent content routing into SubtaskCards
- Subtool loading indicator fix

### Out of Scope (Phase 10)

Per PRD Phase 10:

- Rendering question answers as a summary after answering (raw tool output only)
- Question undo/edit after submission
- Multiple simultaneous visible questions (only first shown, rest queue)
- Custom per-question validation (regex on text input)
- Scroll FAB animation/transition changes (only visibility logic changes)
- Write tool diff view (new content only, no comparison with existing)
- Slash command argument autocomplete from `hints` field
- Slash command file attachment forwarding
- QuickActions reordering or custom action configuration
- Cross-platform "Reveal in File Explorer" for Windows/Linux

### Performance Targets

| Operation                        | Target                                           |
| -------------------------------- | ------------------------------------------------ |
| Question event → UI render       | < 100ms from SSE event to QuestionPrompt visible |
| Question reply round-trip        | < 300ms from click to SDK acknowledgment         |
| Scroll FAB false positive rate   | 0% — FAB never appears without user scroll-up    |
| Write tool expanded render       | < 50ms for syntax highlighting up to 500 lines   |
| Show in Finder latency           | < 200ms from click to Finder window visible      |
| Slash command detection overhead | < 5ms for prefix check + command lookup          |
| Mode auto-switch on command      | < 50ms for store update + UI re-render           |
| Command endpoint round-trip      | < 500ms from send to first streaming event       |

### Key Architecture Decisions

1. **Zustand store for questions over component-local state**: Questions can arrive during streaming and must persist across re-renders. A store allows the stream handler to write and the component to read independently. Questions are keyed by session ID so multiple sessions don't interfere.
2. **`userHasScrolledUpRef` over debouncing scroll events**: A simple boolean flag is O(1) to check on every scroll event. Debouncing would introduce lag in detecting the user's intent. The flag is only set on confirmed upward scroll, making it precise.
3. **Dedicated `WriteToolView` over patching `ReadToolView`**: The Write and Read tools have different data sources (`input.content` vs `output`). A separate component avoids conditional branching in `ReadToolView` and keeps each tool view focused on its data shape.
4. **SDK `session.command()` over sending raw `/command` text**: The SDK's command endpoint handles template resolution, argument substitution (`$1`, `$ARGUMENTS`), shell execution (`` !`...` ``), and file references (`@path`) server-side. Sending raw text bypasses all of this, making command files unreliable.
5. **Auto mode-switch before command send**: The command's `agent` field defines the intended execution context. Switching mode before sending ensures the session UI reflects the correct state immediately, and the SDK receives the prompt in the intended agent context.
6. **Reusing existing `shell:showItemInFolder` IPC over a new channel**: The channel already exists and works. Adding it to QuickActions requires only UI changes — no new IPC infrastructure.

### Reference Implementation

The interactive question feature references the OpenCode official client at `<opencode-repo-path>`. Key files for implementers:

- `packages/opencode/src/question/index.ts` — Data model, ask/reply/reject, events
- `packages/opencode/src/tool/question.ts` — Tool definition (blocks until answered)
- `packages/opencode/src/tool/question.txt` — Tool prompt description
- `packages/ui/src/components/message-part.tsx` — Inline QuestionPrompt (SolidJS)
- `packages/app/src/components/question-dock.tsx` — QuestionDock (SolidJS)
- `packages/app/src/context/global-sync/event-reducer.ts` — Event reducer
- `packages/sdk/js/src/v2/gen/types.gen.ts` — SDK types
