# Hive Phase 14 Implementation Plan

This document outlines the implementation plan for Hive Phase 14, focusing on custom project icons, git merge operations, file staging dual display, question submit confirmation, worktree drag reordering, session entry auto-scroll, input field improvements, dock badge notifications, worktree status bar, and file search bug fix.

---

## Overview

The implementation is divided into **13 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 14 builds upon Phase 13** — all Phase 13 infrastructure is assumed to be in place.

---

## Dependencies & Parallelization

```
Session 1  (File Search Bug Fix)        ── no deps
Session 2  (File Changes Dual Display)  ── no deps
Session 3  (Auto-Scroll on Entry)       ── no deps
Session 4  (Question No Auto-Submit)    ── no deps
Session 5  (Better Input Field)         ── no deps
Session 6  (Dock Badge Notifications)   ── no deps
Session 7  (Worktree Status Store)      ── no deps
Session 8  (Worktree Status UI)         ── blocked by Session 7 (needs extended status types)
Session 9  (Git Merge Backend)          ── no deps
Session 10 (Git Merge UI)              ── blocked by Session 9 (needs IPC + service)
Session 11 (Custom Project Icon)        ── no deps
Session 12 (Worktree Drag Reorder)     ── no deps
Session 13 (Integration & Verification) ── blocked by Sessions 1-12
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────────┐
│  Time →                                                              │
│                                                                      │
│  Track A: [S1: File Search Fix]                                      │
│  Track B: [S2: File Changes Dual]                                    │
│  Track C: [S3: Auto-Scroll]                                         │
│  Track D: [S4: Question Submit]                                      │
│  Track E: [S5: Input Field]                                          │
│  Track F: [S6: Dock Badge]                                           │
│  Track G: [S7: Status Store] → [S8: Status UI]                      │
│  Track H: [S9: Merge Backend] → [S10: Merge UI]                     │
│  Track I: [S11: Custom Icon]                                         │
│  Track J: [S12: Drag Reorder]                                        │
│                                                                      │
│  All ──────────────────────────────────────────► [S13: Integration]   │
└──────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 1-7, 9, 11, 12 are fully independent. Session 8 depends on Session 7 (status store types). Session 10 depends on Session 9 (merge IPC).

**Minimum total**: 3 rounds:

1. (S1, S2, S3, S4, S5, S6, S7, S9, S11, S12 in parallel)
2. (S8, S10 — after their dependencies complete)
3. (S13)

**Recommended serial order** (if doing one at a time):

S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12 → S13

Rationale: S1-S4 are quick bug fixes (highest priority), S5-S6 are small UX improvements, S7-S8 are sequential status work, S9-S10 are sequential merge work, S11 is a full-stack feature, S12 is a medium UI feature, S13 validates everything.

---

## Testing Infrastructure

### Test File Structure (Phase 14)

```
test/
├── phase-14/
│   ├── session-1/
│   │   └── file-search-fix.test.ts
│   ├── session-2/
│   │   └── file-changes-dual.test.ts
│   ├── session-3/
│   │   └── session-entry-scroll.test.ts
│   ├── session-4/
│   │   └── question-no-autosubmit.test.ts
│   ├── session-5/
│   │   └── input-field.test.ts
│   ├── session-6/
│   │   └── dock-badge.test.ts
│   ├── session-7/
│   │   └── worktree-status-store.test.ts
│   ├── session-8/
│   │   └── worktree-status-ui.test.ts
│   ├── session-9/
│   │   └── git-merge-backend.test.ts
│   ├── session-10/
│   │   └── git-merge-ui.test.ts
│   ├── session-11/
│   │   └── custom-project-icon.test.ts
│   ├── session-12/
│   │   └── worktree-drag-reorder.test.ts
│   └── session-13/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies — all features use existing packages:
# - zustand (stores — already installed)
# - lucide-react (icons — already installed)
# - simple-git (git operations — already installed)
# - Electron APIs: dialog, app.dock, Notification (built-in)
```

---

## Session 1: File Search Bug Fix

### Objectives

- Fix Cmd+D file search to return results immediately without requiring the Files tab to be visited first
- Trigger `loadFileTree()` when the search dialog opens and the file tree is empty

### Tasks

#### 1. Add file tree loading effect to `FileSearchDialog.tsx`

In `src/renderer/src/components/file-search/FileSearchDialog.tsx`, add a `useEffect` that triggers `loadFileTree` when the dialog opens and the current worktree has no tree data:

```tsx
const loadFileTree = useFileTreeStore((state) => state.loadFileTree)

// Load file tree on open if not already loaded
useEffect(() => {
  if (isOpen && selectedWorktreePath && fileTree === EMPTY_TREE) {
    loadFileTree(selectedWorktreePath)
  }
}, [isOpen, selectedWorktreePath, fileTree, loadFileTree])
```

Place this after the existing `fileTree` and `allFiles` useMemo declarations (around line 95).

The identity check `fileTree === EMPTY_TREE` works because `EMPTY_TREE` is a module-level constant (line 66), so the reference is stable.

### Key Files

- `src/renderer/src/components/file-search/FileSearchDialog.tsx` — add `useEffect` for eager tree loading

### Definition of Done

- [ ] Cmd+D file search returns results on first use after app launch
- [ ] File search works without ever visiting the Files tab
- [ ] File search still works correctly after visiting the Files tab (no double-load issues)
- [ ] Loading the tree doesn't block the dialog from opening (async load, results appear when ready)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Launch the app, select a worktree — do NOT click the Files tab
2. Press Cmd+D to open file search
3. Type a filename — verify search results appear
4. Close the dialog, visit the Files tab, then press Cmd+D again — verify search still works
5. Switch to a different worktree, press Cmd+D — verify results are from the new worktree

### Testing Criteria

```typescript
// test/phase-14/session-1/file-search-fix.test.ts
describe('Session 1: File Search Bug Fix', () => {
  test('loads file tree when dialog opens with empty tree', () => {
    const loadFileTree = vi.fn()
    // Mock useFileTreeStore with empty tree, loadFileTree mock
    // Mock useFileSearchStore with isOpen: true
    // Render FileSearchDialog
    // Verify loadFileTree called with worktreePath
  })

  test('does not reload file tree when already loaded', () => {
    const loadFileTree = vi.fn()
    // Mock useFileTreeStore with populated tree
    // Render FileSearchDialog with isOpen: true
    // Verify loadFileTree NOT called
  })

  test('does not load when dialog is closed', () => {
    const loadFileTree = vi.fn()
    // Mock useFileSearchStore with isOpen: false
    // Render FileSearchDialog
    // Verify loadFileTree NOT called
  })
})
```

---

## Session 2: File Changes Dual Display

### Objectives

- Show files with both staged and unstaged changes in BOTH the Staged and Changes panels simultaneously
- Fix the backend `getFileStatuses()` to emit two entries instead of mutating the existing entry

### Tasks

#### 1. Modify `getFileStatuses()` in `git-service.ts`

In `src/main/services/git-service.ts`, update the staged files processing loop (lines 391-406). Replace the mutation of `existing.staged = true` with a new `files.push()`:

**Current code (lines 393-397):**

```typescript
const existing = files.find((f) => f.relativePath === file)
if (existing) {
  // File has both staged and unstaged changes
  existing.staged = true
} else {
```

**New code:**

```typescript
const existing = files.find((f) => f.relativePath === file)
if (existing) {
  // File has both staged and unstaged changes — keep BOTH entries
  // existing stays as { staged: false } (unstaged changes)
  // Add new entry for the staged portion
  files.push({
    path: join(this.repoPath, file),
    relativePath: file,
    status: 'M',
    staged: true
  })
} else {
```

The renderer's `ChangesView.tsx` and `GitStatusPanel.tsx` need no changes — the categorization loop will naturally put the two entries into their respective panels.

### Key Files

- `src/main/services/git-service.ts` — modify staged files processing in `getFileStatuses()`

### Definition of Done

- [ ] A file with both staged and unstaged changes appears in both "Staged Changes" and "Changes" panels
- [ ] Staging the unstaged entry stages the remaining changes
- [ ] Unstaging the staged entry moves those changes back to unstaged
- [ ] Files with only staged changes still appear only in "Staged Changes"
- [ ] Files with only unstaged changes still appear only in "Changes"
- [ ] Untracked files still appear only in "Untracked"
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a file, stage some changes (`git add -p`), then make additional edits
2. Open the git panel — verify the file appears in both "Staged Changes" and "Changes"
3. Click to stage the unstaged entry — verify it moves to "Staged Changes" (now fully staged)
4. Unstage one portion — verify it splits back into both panels
5. Verify files with only staged or only unstaged changes are unaffected

### Testing Criteria

```typescript
// test/phase-14/session-2/file-changes-dual.test.ts
describe('Session 2: File Changes Dual Display', () => {
  test('file in both modified and staged produces two entries', () => {
    // Mock simple-git status with a file in both status.modified and status.staged
    // Call getFileStatuses()
    // Verify result contains two entries for the same relativePath:
    //   one with staged: false, one with staged: true
  })

  test('file only in modified produces one unstaged entry', () => {
    // Mock status.modified with a file, status.staged empty
    // Verify single entry with staged: false
  })

  test('file only in staged produces one staged entry', () => {
    // Mock status.staged with a file, status.modified empty
    // Verify single entry with staged: true
  })

  test('unstaged entry preserves original status M', () => {
    // Mock both modified and staged
    // Verify the unstaged entry has status: 'M', staged: false
  })

  test('staged entry has status M', () => {
    // Mock both modified and staged
    // Verify the staged entry has status: 'M', staged: true
  })
})
```

---

## Session 3: Auto-Scroll to Bottom on Session Entry

### Objectives

- Scroll instantly to the bottom (no animation) when entering/switching to a session
- Ensure messages are rendered before scrolling (use `requestAnimationFrame`)

### Tasks

#### 1. Add instant scroll to the session switch effect in `SessionView.tsx`

In `src/renderer/src/components/sessions/SessionView.tsx`, modify the session switch reset effect (lines 527-536) to add an instant scroll:

**Add at the end of the existing effect body:**

```typescript
// Instant scroll to bottom after messages render
requestAnimationFrame(() => {
  messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
})
```

The full effect becomes:

```typescript
useEffect(() => {
  if (scrollCooldownRef.current !== null) {
    clearTimeout(scrollCooldownRef.current)
    scrollCooldownRef.current = null
  }
  isScrollCooldownActiveRef.current = false
  isAutoScrollEnabledRef.current = true
  setShowScrollFab(false)
  userHasScrolledUpRef.current = false

  // Instant scroll to bottom after messages render
  requestAnimationFrame(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
  })
}, [sessionId])
```

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — add instant scroll in session switch effect

### Definition of Done

- [ ] Entering a session with existing messages starts at the bottom immediately
- [ ] No visible smooth scroll animation occurs on session entry
- [ ] Switching between session tabs always starts scrolled to bottom
- [ ] Smooth auto-scroll during streaming is unaffected
- [ ] Scroll FAB behavior during streaming is unaffected
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a session with many messages — verify it starts at the bottom instantly
2. Switch to another session tab — verify instant scroll to bottom
3. Switch back — verify instant scroll again
4. Start streaming in a session — verify smooth auto-scroll still works during streaming
5. Scroll up during streaming — verify FAB appears and cooldown behavior is unchanged

### Testing Criteria

```typescript
// test/phase-14/session-3/session-entry-scroll.test.ts
describe('Session 3: Session Entry Auto-Scroll', () => {
  test('scrollIntoView called with instant behavior on session change', () => {
    // Mock messagesEndRef with scrollIntoView spy
    // Render SessionView, change sessionId
    // Verify scrollIntoView called with { behavior: 'instant' }
  })
})
```

---

## Session 4: Question No Auto-Submit

### Objectives

- Remove auto-submit behavior for single-question, single-choice prompts
- Always show a Submit button for single-question configurations
- Clicking an option selects it (highlights) without submitting

### Tasks

#### 1. Remove auto-submit in `handleOptionClick`

In `src/renderer/src/components/sessions/QuestionPrompt.tsx`, modify `handleOptionClick` (lines 35-77):

**Remove the auto-submit early return (lines 39-43):**

```typescript
// DELETE these lines:
if (!isMultiple && !isMultiQuestion) {
  setSending(true)
  onReply(request.id, [[label]])
  return
}
```

**Replace with single-choice selection that sets the answer without submitting:**

```typescript
if (!isMultiple) {
  // Single-choice: select this option (replaces previous selection)
  setAnswers((prev) => {
    const updated = [...prev]
    updated[currentTab] = [label]
    return updated
  })

  // Multi-question: auto-advance to next tab (unchanged)
  if (isMultiQuestion && !isLastTab) {
    setTimeout(() => {
      setCurrentTab((t) => t + 1)
      setEditingCustom(false)
    }, 150)
  }
  return
}
```

#### 2. Remove auto-submit in `handleCustomSubmit`

Modify `handleCustomSubmit` (lines 79-105):

**Remove the auto-submit early return (lines 85-89):**

```typescript
// DELETE these lines:
if (!isMultiQuestion) {
  setSending(true)
  onReply(request.id, [[text]])
  return
}
```

**Replace with saving the answer without submitting:**

```typescript
// Save custom text as the selected answer (no auto-submit)
setAnswers((prev) => {
  const updated = [...prev]
  updated[currentTab] = [text]
  return updated
})
setEditingCustom(false)

// Multi-question: auto-advance (unchanged)
if (isMultiQuestion && !isLastTab) {
  setCurrentTab((t) => t + 1)
}
```

#### 3. Always show Submit button for single questions

In the action buttons area (lines 276-286), change the condition from `isMultiple && !isMultiQuestion` to `!isMultiQuestion`:

**Current:**

```tsx
{isMultiple && !isMultiQuestion && (
  <Button size="sm" onClick={() => handleSubmit()} disabled={!hasCurrentAnswer || sending}>
```

**New:**

```tsx
{!isMultiQuestion && (
  <Button size="sm" onClick={() => handleSubmit()} disabled={!hasCurrentAnswer || sending}>
```

### Key Files

- `src/renderer/src/components/sessions/QuestionPrompt.tsx` — remove auto-submit, always show Submit

### Definition of Done

- [ ] Clicking an option in a single-question prompt selects it (highlights) but does NOT submit
- [ ] A "Submit" button is always visible for single-question prompts
- [ ] Clicking "Submit" sends the selected answer
- [ ] Submit button is disabled when no option is selected
- [ ] Multi-question auto-advance behavior is unchanged
- [ ] Multi-choice toggle behavior is unchanged
- [ ] Custom text input saves the answer but does not auto-submit for single questions
- [ ] Dismiss button still works
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Trigger a single-question, single-choice AI question
2. Click an option — verify it highlights but the answer is NOT sent yet
3. Click "Submit" — verify the answer is sent
4. Trigger another question — click an option, then click a different option — verify the selection changes
5. Click "Type your own answer", type text, press Enter — verify answer is saved but not sent
6. Click "Submit" — verify the custom text is sent
7. Trigger a multi-question flow — verify auto-advance still works

### Testing Criteria

```typescript
// test/phase-14/session-4/question-no-autosubmit.test.ts
describe('Session 4: Question No Auto-Submit', () => {
  test('clicking option does NOT call onReply for single question', async () => {
    const onReply = vi.fn()
    render(
      <QuestionPrompt
        request={{
          id: 'req1',
          questions: [{
            question: 'Pick one',
            header: 'Q1',
            options: [{ label: 'A', description: '' }, { label: 'B', description: '' }]
          }]
        }}
        onReply={onReply}
        onReject={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('option-A'))
    expect(onReply).not.toHaveBeenCalled()
  })

  test('Submit button is visible for single question', () => {
    render(
      <QuestionPrompt
        request={{
          id: 'req1',
          questions: [{
            question: 'Pick one',
            header: 'Q1',
            options: [{ label: 'A', description: '' }]
          }]
        }}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )
    expect(screen.getByText('Submit')).toBeInTheDocument()
  })

  test('clicking Submit after selecting option calls onReply', async () => {
    const onReply = vi.fn()
    render(
      <QuestionPrompt
        request={{
          id: 'req1',
          questions: [{
            question: 'Pick one',
            header: 'Q1',
            options: [{ label: 'A', description: '' }]
          }]
        }}
        onReply={onReply}
        onReject={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('option-A'))
    await userEvent.click(screen.getByText('Submit'))
    expect(onReply).toHaveBeenCalledWith('req1', [['A']])
  })

  test('Submit button disabled when no option selected', () => {
    render(
      <QuestionPrompt
        request={{
          id: 'req1',
          questions: [{
            question: 'Pick one',
            header: 'Q1',
            options: [{ label: 'A', description: '' }]
          }]
        }}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )
    expect(screen.getByText('Submit')).toBeDisabled()
  })
})
```

---

## Session 5: Better Input Field

### Objectives

- Widen the message input field from `max-w-3xl` (768px) to `max-w-4xl` (896px)
- Fix pre-populated draft text height by adding `sessionId` to the auto-resize effect dependencies

### Tasks

#### 1. Widen the input container in `SessionView.tsx`

Change `max-w-3xl` to `max-w-4xl` on line 2079:

```tsx
<div className="max-w-4xl mx-auto relative">
```

Also check if the message list area uses `max-w-3xl` — if so, update it to `max-w-4xl` for consistency.

#### 2. Fix auto-resize for pre-populated drafts

Modify the auto-resize effect (lines 554-561) to also trigger on `sessionId` changes and use `requestAnimationFrame`:

```typescript
useEffect(() => {
  const textarea = textareaRef.current
  if (textarea) {
    requestAnimationFrame(() => {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    })
  }
}, [inputValue, sessionId])
```

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — widen container, fix resize deps

### Definition of Done

- [ ] Input field is visibly wider on screens > 768px
- [ ] Input container uses `max-w-4xl` class
- [ ] Entering a session with a pre-populated draft shows the textarea at the correct height immediately
- [ ] Multi-line drafts do not start at 40px and then jump to the correct height
- [ ] Auto-resize still works correctly when typing
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open the app on a wide screen — verify the input area is wider than before
2. Type a multi-line message in a session, switch to another tab, switch back — verify the textarea height is correct immediately
3. Type in the textarea — verify auto-resize still grows/shrinks correctly
4. Verify the message list area above matches the input area width

### Testing Criteria

```typescript
// test/phase-14/session-5/input-field.test.ts
describe('Session 5: Better Input Field', () => {
  test('input container uses max-w-4xl class', () => {
    // Render SessionView
    // Find the input area container
    // Verify it has 'max-w-4xl' class
  })

  test('textarea resize effect depends on sessionId', () => {
    // This is a behavior test: switch sessionId with pre-populated value
    // Verify textarea.style.height is set correctly
  })
})
```

---

## Session 6: Dock Badge Notifications

### Objectives

- Increment the macOS dock badge by 1 on each notification
- Clear the badge when the app window gains focus

### Tasks

#### 1. Add badge tracking to `notification-service.ts`

In `src/main/services/notification-service.ts`:

**Add `app` import:**

```typescript
import { Notification, BrowserWindow, app } from 'electron'
```

**Add `unreadCount` field:**

```typescript
class NotificationService {
  private mainWindow: BrowserWindow | null = null
  private unreadCount = 0
```

**Register focus listener in `setMainWindow`:**

```typescript
setMainWindow(window: BrowserWindow): void {
  this.mainWindow = window

  // Clear badge when window gains focus
  window.on('focus', () => {
    this.clearBadge()
  })
}
```

**Increment badge in `showSessionComplete`, after `notification.show()`:**

```typescript
notification.show()

// Increment dock badge
this.unreadCount++
app.dock?.setBadge(String(this.unreadCount))
```

**Add `clearBadge` method:**

```typescript
private clearBadge(): void {
  this.unreadCount = 0
  app.dock?.setBadge('')
}
```

### Key Files

- `src/main/services/notification-service.ts` — add badge tracking, increment, and clear

### Definition of Done

- [ ] Each notification increments the dock badge by 1
- [ ] Multiple notifications while unfocused show cumulative count (e.g. "3")
- [ ] Focusing the app window clears the dock badge to empty
- [ ] Clicking a notification (which focuses the window) also clears the badge
- [ ] No crashes on non-macOS (app.dock is optional-chained)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a session, move the app to background
2. Wait for session to complete — verify dock badge shows "1"
3. Start another session in background — wait for completion — verify badge shows "2"
4. Click the app window to focus it — verify badge disappears
5. Verify clicking the notification itself also clears the badge

### Testing Criteria

```typescript
// test/phase-14/session-6/dock-badge.test.ts
describe('Session 6: Dock Badge', () => {
  test('increments badge count on notification', () => {
    // Mock app.dock.setBadge
    // Call showSessionComplete twice
    // Verify setBadge called with '1' then '2'
  })

  test('clears badge on window focus', () => {
    // Mock app.dock.setBadge
    // Set up mainWindow mock with on('focus') handler
    // Call showSessionComplete
    // Trigger focus event
    // Verify setBadge called with ''
  })

  test('does not crash when app.dock is undefined', () => {
    // Mock app without dock property
    // Call showSessionComplete
    // Verify no error thrown
  })
})
```

---

## Session 7: Worktree Status Store Extensions

### Objectives

- Extend `useWorktreeStatusStore` to support `'planning'` and `'answering'` status types
- Update `getWorktreeStatus` priority logic for the new types
- Set appropriate status from `SessionView` based on session mode and pending questions

### Tasks

#### 1. Extend status types in `useWorktreeStatusStore.ts`

In `src/renderer/src/stores/useWorktreeStatusStore.ts`, update the `SessionStatus` interface and all type annotations:

```typescript
interface SessionStatus {
  status: 'working' | 'planning' | 'answering' | 'unread'
  timestamp: number
}
```

Update all `setSessionStatus` and `getWorktreeStatus` signatures to accept/return the extended union type.

#### 2. Update `getWorktreeStatus` priority logic

Replace the current logic with the extended priority chain:

```typescript
getWorktreeStatus: (worktreeId: string) => {
  // ... get sessions for worktree ...

  let hasPlanning = false
  let hasWorking = false
  let latestUnread: SessionStatus | null = null

  for (const id of sessionIds) {
    const entry = sessionStatuses[id]
    if (!entry) continue

    if (entry.status === 'answering') return 'answering' // highest priority
    if (entry.status === 'planning') hasPlanning = true
    if (entry.status === 'working') hasWorking = true
    if (entry.status === 'unread') {
      if (!latestUnread || entry.timestamp > latestUnread.timestamp) {
        latestUnread = entry
      }
    }
  }

  if (hasPlanning) return 'planning'
  if (hasWorking) return 'working'
  return latestUnread ? 'unread' : null
}
```

#### 3. Set 'planning' status from SessionView

In `SessionView.tsx`, where stream events set session status to `'working'`, check the session mode:

- If the session's mode is `'plan'`, set `'planning'` instead of `'working'`
- Find the relevant `setSessionStatus('working')` calls and wrap with mode check

#### 4. Set 'answering' status on pending questions

In `SessionView.tsx`, when `activeQuestion` is set (a question tool fires), set the status to `'answering'`:

```typescript
// When activeQuestion changes
useEffect(() => {
  if (activeQuestion && sessionId) {
    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'answering')
  }
}, [activeQuestion, sessionId])
```

When the question is answered/dismissed, the existing working/idle logic should restore the correct status.

### Key Files

- `src/renderer/src/stores/useWorktreeStatusStore.ts` — extend types, update priority logic
- `src/renderer/src/components/sessions/SessionView.tsx` — set planning/answering status

### Definition of Done

- [ ] Status store accepts `'planning'` and `'answering'` as valid status values
- [ ] `getWorktreeStatus` returns `'answering'` when any session has a pending question
- [ ] `getWorktreeStatus` returns `'planning'` when a session is working in plan mode
- [ ] `getWorktreeStatus` returns `'working'` when a session is working in build mode
- [ ] Priority order: answering > planning > working > unread > null
- [ ] Existing `'working'` and `'unread'` behavior is unchanged for build-mode sessions
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a session in build mode — verify `getWorktreeStatus` returns `'working'`
2. Start a session in plan mode — verify `getWorktreeStatus` returns `'planning'`
3. Trigger a question from the AI — verify status switches to `'answering'`
4. Answer the question — verify status reverts to `'working'` or `'planning'`

### Testing Criteria

```typescript
// test/phase-14/session-7/worktree-status-store.test.ts
describe('Session 7: Worktree Status Store', () => {
  test('accepts planning status', () => {
    const { setSessionStatus, sessionStatuses } = useWorktreeStatusStore.getState()
    setSessionStatus('session1', 'planning')
    expect(useWorktreeStatusStore.getState().sessionStatuses['session1']?.status).toBe('planning')
  })

  test('accepts answering status', () => {
    const { setSessionStatus } = useWorktreeStatusStore.getState()
    setSessionStatus('session1', 'answering')
    expect(useWorktreeStatusStore.getState().sessionStatuses['session1']?.status).toBe('answering')
  })

  test('answering has highest priority', () => {
    // Set one session to 'working', another to 'answering'
    // Verify getWorktreeStatus returns 'answering'
  })

  test('planning takes priority over working', () => {
    // Set one session to 'working', another to 'planning'
    // Verify getWorktreeStatus returns 'planning'
  })

  test('working takes priority over unread', () => {
    // Set one session to 'unread', another to 'working'
    // Verify getWorktreeStatus returns 'working'
  })
})
```

---

## Session 8: Worktree Status UI (Two-Line Rows)

### Objectives

- Expand worktree sidebar rows to two lines when there is active status
- Show status text on the second line: "Working", "Answer questions", "Planning", "Archiving"
- Keep rows single-line when idle

### Tasks

#### 1. Update `WorktreeItem.tsx` layout to support two lines

In `src/renderer/src/components/worktrees/WorktreeItem.tsx`, restructure the name area to a `flex-col` container:

```tsx
// Derive display status text
const archivingWorktreeIds = useWorktreeStore((s) => s.archivingWorktreeIds)
const isArchivingThis = archivingWorktreeIds.has(worktree.id)

const displayStatus = isArchivingThis
  ? 'Archiving'
  : worktreeStatus === 'answering'
    ? 'Answer questions'
    : worktreeStatus === 'planning'
      ? 'Planning'
      : worktreeStatus === 'working'
        ? 'Working'
        : null
```

Replace the name `<span>` (lines 256-259) with a `flex-col` wrapper:

```tsx
<div className="flex-1 min-w-0">
  {isRenamingBranch ? (
    <input ... />
  ) : (
    <span className="text-sm truncate block">{worktree.name}</span>
  )}
  {displayStatus && (
    <span className="text-[10px] text-muted-foreground block">
      {displayStatus}
    </span>
  )}
</div>
```

### Key Files

- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — two-line layout with status text

### Definition of Done

- [ ] Worktree rows show "Working" text when a session is working in build mode
- [ ] Worktree rows show "Planning" text when a session is working in plan mode
- [ ] Worktree rows show "Answer questions" when a pending question exists
- [ ] Worktree rows show "Archiving" during the archive process
- [ ] Worktree rows show no second line when idle
- [ ] Status text is styled as `text-[10px] text-muted-foreground`
- [ ] Row layout doesn't break with long worktree names (truncation still works)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a session in build mode — verify "Working" appears under the worktree name
2. Switch to plan mode and send a message — verify "Planning" appears
3. Trigger a question from the AI — verify "Answer questions" appears
4. Archive a worktree — verify "Archiving" appears briefly
5. Wait for idle — verify the second line disappears

### Testing Criteria

```typescript
// test/phase-14/session-8/worktree-status-ui.test.ts
describe('Session 8: Worktree Status UI', () => {
  test('shows "Working" when worktreeStatus is working', () => {
    // Mock worktreeStatus as 'working'
    // Render WorktreeItem
    // Verify 'Working' text is present
  })

  test('shows "Planning" when worktreeStatus is planning', () => {
    // Mock worktreeStatus as 'planning'
    // Verify 'Planning' text present
  })

  test('shows "Answer questions" when worktreeStatus is answering', () => {
    // Mock worktreeStatus as 'answering'
    // Verify 'Answer questions' text present
  })

  test('shows "Archiving" when worktree is being archived', () => {
    // Mock archivingWorktreeIds containing the worktree id
    // Verify 'Archiving' text present
  })

  test('shows no status text when idle', () => {
    // Mock worktreeStatus as null, not archiving
    // Verify no status text rendered
  })
})
```

---

## Session 9: Git Merge Backend

### Objectives

- Add `merge(sourceBranch)` method to `git-service.ts`
- Add `git:merge` IPC handler in `git-file-handlers.ts`
- Expose `merge()` in the preload bridge and type declarations

### Tasks

#### 1. Add `merge()` method to `git-service.ts`

In `src/main/services/git-service.ts`, add the method after `pull()` (around line 780):

```typescript
async merge(sourceBranch: string): Promise<{
  success: boolean
  error?: string
  conflicts?: string[]
}> {
  try {
    log.info('Merging branch', { sourceBranch, repoPath: this.repoPath })
    await this.git.merge([sourceBranch])
    return { success: true }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'git' in error &&
      (error as any).git?.conflicts?.length
    ) {
      const conflicts = (error as any).git.conflicts as string[]
      log.warn('Merge resulted in conflicts', { sourceBranch, conflicts })
      return {
        success: false,
        error: `Merge conflicts in ${conflicts.length} file(s). Resolve conflicts before continuing.`,
        conflicts
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    log.error('Merge failed', error instanceof Error ? error : new Error(message), {
      sourceBranch,
      repoPath: this.repoPath
    })
    return { success: false, error: message }
  }
}
```

#### 2. Add IPC handler in `git-file-handlers.ts`

In `src/main/ipc/git-file-handlers.ts`, add the handler:

```typescript
ipcMain.handle('git:merge', async (_event, worktreePath: string, sourceBranch: string) => {
  try {
    const gitService = createGitService(worktreePath)
    return await gitService.merge(sourceBranch)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})
```

#### 3. Expose in preload

In `src/preload/index.ts`, add to the `gitOps` namespace:

```typescript
merge: (worktreePath: string, sourceBranch: string) =>
  ipcRenderer.invoke('git:merge', worktreePath, sourceBranch),
```

#### 4. Add type declaration

In `src/preload/index.d.ts`, add to the gitOps interface:

```typescript
merge(worktreePath: string, sourceBranch: string): Promise<{
  success: boolean
  error?: string
  conflicts?: string[]
}>
```

### Key Files

- `src/main/services/git-service.ts` — add `merge()` method
- `src/main/ipc/git-file-handlers.ts` — add `git:merge` IPC handler
- `src/preload/index.ts` — expose `merge()` in gitOps
- `src/preload/index.d.ts` — add `merge` type declaration

### Definition of Done

- [ ] `gitService.merge('main')` successfully merges the main branch
- [ ] Merge conflicts are detected and returned with file list
- [ ] IPC handler correctly delegates to git service
- [ ] Preload exposes `window.gitOps.merge()`
- [ ] Type declarations compile correctly
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a test branch with changes, make diverging changes on main
2. Call `window.gitOps.merge(worktreePath, 'main')` from dev tools
3. Verify successful merge with clean state
4. Create a conflict scenario — verify the error response includes conflict file names

### Testing Criteria

```typescript
// test/phase-14/session-9/git-merge-backend.test.ts
describe('Session 9: Git Merge Backend', () => {
  test('merge returns success on clean merge', async () => {
    // Mock this.git.merge to resolve
    // Call gitService.merge('main')
    // Verify { success: true }
  })

  test('merge returns conflicts on conflict', async () => {
    // Mock this.git.merge to throw GitResponseError with conflicts
    // Call gitService.merge('main')
    // Verify { success: false, conflicts: [...] }
  })

  test('merge returns error on other failures', async () => {
    // Mock this.git.merge to throw generic Error
    // Verify { success: false, error: '...' }
  })
})
```

---

## Session 10: Git Merge UI

### Objectives

- Add a merge UI section to `GitPushPull.tsx` with an editable branch input and merge button
- Default to the repository's default branch (main/master)
- Refresh file statuses after merge

### Tasks

#### 1. Add merge state and handler to `GitPushPull.tsx`

In `src/renderer/src/components/git/GitPushPull.tsx`, add state for the merge branch and loading:

```tsx
const [mergeBranch, setMergeBranch] = useState('')
const [isMerging, setIsMerging] = useState(false)
```

#### 2. Load default branch on mount

Add an effect to populate the merge branch input with the default branch:

```tsx
useEffect(() => {
  if (worktreePath && !mergeBranch) {
    // Derive from branchInfo or add a getDefaultBranch IPC if needed
    // For now, default to 'main'
    setMergeBranch('main')
  }
}, [worktreePath])
```

Note: If `getDefaultBranch` is not yet exposed via IPC, either add a simple handler or hardcode 'main' as the default with the input being editable.

#### 3. Add merge handler

```tsx
const handleMerge = useCallback(async () => {
  if (!worktreePath || !mergeBranch.trim()) return
  setIsMerging(true)
  try {
    const result = await window.gitOps.merge(worktreePath, mergeBranch.trim())
    if (result.success) {
      toast.success(`Merged ${mergeBranch} successfully`)
      // Refresh statuses
    } else {
      toast.error('Merge failed', { description: result.error })
    }
  } finally {
    setIsMerging(false)
  }
}, [worktreePath, mergeBranch])
```

#### 4. Add merge UI section

Add below the push/pull options, inside a `border-t` separator:

```tsx
<div className="flex gap-2 items-center border-t pt-2">
  <span className="text-[10px] text-muted-foreground whitespace-nowrap">Merge from</span>
  <input
    value={mergeBranch}
    onChange={(e) => setMergeBranch(e.target.value)}
    className="flex-1 bg-background border border-border rounded px-1.5 py-0.5 text-xs
               focus:outline-none focus:ring-1 focus:ring-ring min-w-0"
    placeholder="branch name"
    disabled={isMerging || isOperating}
  />
  <Button
    variant="outline"
    size="sm"
    className="h-6 text-xs whitespace-nowrap"
    onClick={handleMerge}
    disabled={isMerging || isOperating || !mergeBranch.trim()}
  >
    {isMerging ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Merge'}
  </Button>
</div>
```

### Key Files

- `src/renderer/src/components/git/GitPushPull.tsx` — add merge UI section

### Definition of Done

- [ ] "Merge from" input and button appear below push/pull controls
- [ ] Input defaults to 'main' (or detected default branch)
- [ ] User can edit the branch name to any branch
- [ ] Merge button is disabled while pushing/pulling/merging or input is empty
- [ ] Successful merge shows a success toast
- [ ] Failed merge shows an error toast with the error message
- [ ] File statuses refresh after merge
- [ ] Merge button shows spinner while merging
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open the git panel on a worktree — verify "Merge from" section appears
2. The input should default to "main" (or your default branch)
3. Click "Merge" — verify merge succeeds and toast appears
4. Change the input to a non-existent branch — click "Merge" — verify error toast
5. Create a conflict scenario — click "Merge" — verify conflict error toast
6. Verify the merge button is disabled while other git operations are in progress

### Testing Criteria

```typescript
// test/phase-14/session-10/git-merge-ui.test.ts
describe('Session 10: Git Merge UI', () => {
  test('renders merge section with input and button', () => {
    render(<GitPushPull worktreePath="/test/path" />)
    expect(screen.getByPlaceholderText('branch name')).toBeInTheDocument()
    expect(screen.getByText('Merge')).toBeInTheDocument()
  })

  test('merge button disabled when input is empty', () => {
    render(<GitPushPull worktreePath="/test/path" />)
    // Clear the input
    // Verify Merge button is disabled
  })

  test('calls gitOps.merge on button click', async () => {
    const mergeMock = vi.fn().mockResolvedValue({ success: true })
    // Mock window.gitOps.merge
    render(<GitPushPull worktreePath="/test/path" />)
    // Set input to 'main', click Merge
    // Verify mergeMock called with ('/test/path', 'main')
  })
})
```

---

## Session 11: Custom Project Icon

### Objectives

- Add database migration for `custom_icon` column
- Add IPC handlers for picking, removing, and resolving icon paths
- Update `LanguageIcon` to render custom image icons
- Add icon picker UI to `ProjectSettingsDialog`

### Tasks

#### 1. Add database migration v8

In `src/main/db/schema.ts`, bump `CURRENT_SCHEMA_VERSION` to 8 and add the migration:

```typescript
{
  version: 8,
  name: 'add_project_custom_icon',
  up: `ALTER TABLE projects ADD COLUMN custom_icon TEXT DEFAULT NULL;`,
  down: `-- SQLite does not support DROP COLUMN; recreate table if needed`
}
```

#### 2. Update types

In `src/main/db/types.ts`, add `custom_icon: string | null` to `Project` and `custom_icon?: string | null` to `ProjectUpdate`.

In `src/preload/index.d.ts`, add `custom_icon: string | null` to the `Project` interface and add icon IPC methods to the `projectOps` interface.

#### 3. Add IPC handlers in `project-handlers.ts`

Add three handlers: `project:pickIcon` (opens file dialog, copies to `~/.hive/project-icons/`), `project:removeIcon` (deletes icon file), and `project:getIconPath` (resolves filename to full path).

#### 4. Expose in preload

In `src/preload/index.ts`, add `pickProjectIcon`, `removeProjectIcon`, and `getProjectIconPath` to the `projectOps` namespace.

#### 5. Update `LanguageIcon.tsx`

Add `customIcon` prop. When set, render `<img>` from the resolved file path. Otherwise, existing logic unchanged.

#### 6. Update `ProjectItem.tsx`

Pass `project.custom_icon` to `<LanguageIcon>`.

#### 7. Update `ProjectSettingsDialog.tsx`

Add an icon picker section at the top with "Change" (opens file picker) and "Clear" buttons. Include `custom_icon` in the save payload.

### Key Files

- `src/main/db/schema.ts` — migration v8
- `src/main/db/types.ts` — add `custom_icon` field
- `src/preload/index.d.ts` — types for Project and projectOps
- `src/preload/index.ts` — expose icon IPC methods
- `src/main/ipc/project-handlers.ts` — add icon handlers
- `src/renderer/src/components/projects/LanguageIcon.tsx` — add customIcon prop
- `src/renderer/src/components/projects/ProjectItem.tsx` — pass custom_icon
- `src/renderer/src/components/projects/ProjectSettingsDialog.tsx` — add icon picker UI

### Definition of Done

- [ ] Database migration adds `custom_icon` column to projects table
- [ ] "Change" button in Project Settings opens a native file picker filtered to SVG/PNG/JPG
- [ ] Selected image is copied to `~/.hive/project-icons/{projectId}.{ext}`
- [ ] Previous icon for the same project is deleted when a new one is picked
- [ ] "Clear" button removes the icon file and resets to language-based icon
- [ ] Custom icon renders as `<img>` in the sidebar project list
- [ ] Custom icon persists across app restarts
- [ ] Canceling the file picker does not change the icon
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open Project Settings — verify the icon picker section appears
2. Click "Change" — verify a file picker opens filtered to image files
3. Select an image — verify it appears in the preview and in the sidebar
4. Click "Save" — close and reopen settings — verify the icon persists
5. Click "Clear" — verify the language icon is restored
6. Restart the app — verify custom icons persist
7. Pick a new image to replace an existing one — verify the old file is removed

### Testing Criteria

```typescript
// test/phase-14/session-11/custom-project-icon.test.ts
describe('Session 11: Custom Project Icon', () => {
  test('LanguageIcon renders img when customIcon is set', () => {
    // Mock getProjectIconPath
    render(<LanguageIcon language="typescript" customIcon="abc123.png" />)
    const img = screen.getByAltText('project icon')
    expect(img).toBeInTheDocument()
    expect(img.tagName).toBe('IMG')
  })

  test('LanguageIcon falls back to language icon when customIcon is null', () => {
    render(<LanguageIcon language="typescript" customIcon={null} />)
    // Verify the TS badge renders, not an img
  })

  test('LanguageIcon renders FolderGit2 when no customIcon and no language', () => {
    render(<LanguageIcon language={null} customIcon={null} />)
    // Verify FolderGit2 icon renders
  })

  test('ProjectSettingsDialog shows icon picker section', () => {
    render(<ProjectSettingsDialog project={mockProject} open={true} onOpenChange={vi.fn()} />)
    expect(screen.getByText('Project Icon')).toBeInTheDocument()
    expect(screen.getByText('Change')).toBeInTheDocument()
  })

  test('Clear button only shown when custom icon exists', () => {
    // Render with project.custom_icon = 'abc.png'
    // Verify 'Clear' button visible
    // Render with project.custom_icon = null
    // Verify 'Clear' button not visible
  })
})
```

---

## Session 12: Worktree Drag Reorder

### Objectives

- Allow drag-and-drop reordering of non-default worktrees within a project
- Persist custom order across sessions via localStorage
- Pin default worktree at the top (not draggable)

### Tasks

#### 1. Add order tracking to `useWorktreeStore`

In `src/renderer/src/stores/useWorktreeStore.ts`:

- Add `worktreeOrderByProject: Map<string, string[]>` to state
- Add `reorderWorktrees(projectId, fromIndex, toIndex)` action
- Modify `getWorktreesForProject` to apply custom order when available
- Persist `worktreeOrderByProject` in the store's localStorage config

#### 2. Add drag handlers to `WorktreeItem.tsx`

Accept new props `index` and `onReorder`. Add `draggable`, `onDragStart`, `onDragOver`, `onDrop` to the row div. Only non-default worktrees are draggable. Add visual drag feedback (opacity change).

#### 3. Update `WorktreeList.tsx`

Pass `index` and `onReorder` props to each `WorktreeItem`. Get `reorderWorktrees` from the store.

### Key Files

- `src/renderer/src/stores/useWorktreeStore.ts` — order state, reorder action, custom ordering
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — drag handlers, visual feedback
- `src/renderer/src/components/worktrees/WorktreeList.tsx` — pass index and callback

### Definition of Done

- [ ] Non-default worktrees can be dragged and dropped to reorder
- [ ] Default worktree stays pinned at the top and cannot be dragged
- [ ] Dragged item becomes semi-transparent during drag
- [ ] Drop position is respected correctly
- [ ] Custom order persists across app restarts (localStorage)
- [ ] New worktrees appear at the end of the custom order
- [ ] Removing a worktree does not break the order of remaining ones
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create three worktrees in a project
2. Drag the second worktree below the third — verify the order changes
3. Drag the third worktree above the second — verify the order changes back
4. Try to drag the default worktree — verify it cannot be dragged
5. Restart the app — verify the custom order persists
6. Create a new worktree — verify it appears at the end
7. Archive a worktree — verify remaining order is maintained

### Testing Criteria

```typescript
// test/phase-14/session-12/worktree-drag-reorder.test.ts
describe('Session 12: Worktree Drag Reorder', () => {
  test('reorderWorktrees swaps items correctly', () => {
    // Set initial order [a, b, c]
    // Call reorderWorktrees(projectId, 0, 2)
    // Verify order is [b, c, a]
  })

  test('getWorktreesForProject applies custom order', () => {
    // Set worktrees and custom order
    // Verify getWorktreesForProject returns worktrees in custom order
  })

  test('default worktree stays first regardless of custom order', () => {
    // Set custom order that doesn't include default
    // Verify default is still first in getWorktreesForProject
  })

  test('new worktrees appear at end of custom order', () => {
    // Set custom order, add a new worktree not in the order
    // Verify new worktree appears after ordered ones
  })

  test('WorktreeItem is not draggable when is_default', () => {
    render(<WorktreeItem worktree={{ ...mockWorktree, is_default: true }} ... />)
    const row = screen.getByTestId(`worktree-item-${mockWorktree.id}`)
    expect(row).not.toHaveAttribute('draggable', 'true')
  })
})
```

---

## Session 13: Integration & Verification

### Objectives

- Verify all Phase 14 features work correctly together
- Test cross-feature interactions
- Run lint and tests
- Fix any edge cases or regressions

### Tasks

#### 1. File search + Files tab interaction

- Open file search (Cmd+D) without visiting Files tab — verify results appear
- Then visit the Files tab — verify it works normally (no double-load conflict)
- Switch worktrees — press Cmd+D — verify results are from the new worktree

#### 2. File changes dual display + merge interaction

- Merge a branch that creates a partially-staged file scenario
- Verify the file appears in both Staged and Changes panels after merge
- Stage the remaining changes — verify it consolidates to Staged only

#### 3. Auto-scroll + input field interaction

- Enter a session with a pre-populated draft and history — verify:
  - Scroll starts at bottom (instant)
  - Textarea height matches the draft content
  - Input area is wider than before

#### 4. Question prompt + worktree status

- Trigger a question from an AI session
- Verify "Answer questions" appears on the worktree row
- Verify the Submit button is visible (no auto-submit)
- Select an answer, click Submit
- Verify status changes back to "Working" or "Planning"

#### 5. Dock badge + notification flow

- Background the app, run a session to completion
- Verify dock badge shows "1"
- Run another session — verify badge shows "2"
- Click the notification — verify app focuses and badge clears

#### 6. Custom icon persistence

- Set a custom icon on a project
- Verify it renders in the sidebar
- Restart the app — verify icon persists
- Clear the icon — verify language icon returns

#### 7. Worktree drag reorder + status

- Reorder worktrees, then start a session
- Verify "Working" status appears on the correct (reordered) worktree row
- Verify the order persists after restart

#### 8. Merge operation end-to-end

- Create a branch divergence from main
- Open the git panel — verify "Merge from main" appears
- Click Merge — verify success toast and file statuses refresh
- Create a conflict — click Merge — verify error toast with conflict count

#### 9. Full smoke test

Walk through the complete flow:

1. Open app → set a custom icon on a project → verify it renders
2. Select a worktree → verify auto-scroll to bottom of session
3. Open Cmd+D → verify file search works immediately
4. Start a plan-mode session → verify "Planning" on worktree row
5. Trigger a question → verify "Answer questions" status → select and click Submit
6. After completion → background app → verify dock badge increments
7. Edit a file, stage partial changes → verify dual display in both panels
8. Merge from main → verify success
9. Drag-reorder worktrees → verify new order persists
10. Verify input field is wider and draft heights are correct

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
- [ ] Cross-feature interactions work (question + status, merge + file changes, etc.)
- [ ] No regressions from Phase 13 features (header branding, selection propagation, etc.)
- [ ] `pnpm lint` passes with no new warnings
- [ ] `pnpm test` passes with all Phase 14 tests green
- [ ] App starts and runs without console errors
- [ ] No TypeScript compilation errors

### Testing Criteria

```typescript
// test/phase-14/session-13/integration-verification.test.ts
describe('Session 13: Integration Verification', () => {
  test('all Phase 14 features compile without errors', () => {
    // This is validated by `pnpm lint` passing
  })

  test('all Phase 14 test suites pass', () => {
    // This is validated by `pnpm test` passing
  })
})
```
