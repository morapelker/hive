# Hive Phase 18 Implementation Plan

This document outlines the implementation plan for Hive Phase 18, covering archive task stop, skill card UI, PR to GitHub, permission status, merge conflict header button, plain file rendering, grep UI restyle, /clear command, and plan ready status.

---

## Overview

The implementation is divided into **12 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 18 builds upon Phase 17** — all Phase 17 infrastructure is assumed to be in place.

---

## Dependencies & Parallelization

```
Session 1  (Archive Task Stop)                  ── no deps
Session 2  (/clear Command)                     ── no deps
Session 3  (Plan Ready Status)                  ── no deps
Session 4  (Skill Card UI)                      ── no deps
Session 5  (Grep UI Restyle)                    ── no deps
Session 6  (Permission Status)                  ── no deps
Session 7  (Merge Conflict Header Button)       ── no deps
Session 8  (Plain File Rendering: Backend)      ── no deps
Session 9  (Plain File Rendering: Frontend)     ── blocked by Session 8
Session 10 (PR to GitHub: Backend)              ── no deps
Session 11 (PR to GitHub: Frontend)             ── blocked by Session 10
Session 12 (Integration & Verification)         ── blocked by Sessions 1-11
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Time →                                                                  │
│                                                                          │
│  Track A: [S1: Archive Task Stop]                                        │
│  Track B: [S2: /clear Command]                                           │
│  Track C: [S3: Plan Ready Status]                                        │
│  Track D: [S4: Skill Card UI]                                            │
│  Track E: [S5: Grep UI Restyle]                                          │
│  Track F: [S6: Permission Status]                                        │
│  Track G: [S7: Merge Conflict Header Button]                             │
│  Track H: [S8: Plain File Backend] → [S9: Plain File Frontend]           │
│  Track I: [S10: PR Backend] → [S11: PR Frontend]                        │
│                                                                          │
│  All ────────────────────────────────────────────► [S12: Integration]    │
└──────────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 1-8, 10 are fully independent (9 sessions). Sessions 9, 11 depend on their predecessors.

**Minimum total**: 3 rounds:

1. (S1, S2, S3, S4, S5, S6, S7, S8, S10 in parallel)
2. (S9, S11 — after their dependencies)
3. (S12)

**Recommended serial order** (if doing one at a time):

S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12

Rationale: S1-S3 are the smallest self-contained changes (single file each). S4-S5 are UI-only tool rendering changes. S6-S7 are moderate status/header changes. S8-S9 are sequential (backend then frontend for plain file rendering). S10-S11 are sequential and the largest feature (new IPC + store + UI for PR). S12 validates everything.

---

## Testing Infrastructure

### Test File Structure (Phase 18)

```
test/
├── phase-18/
│   ├── session-1/
│   │   └── archive-task-stop.test.ts
│   ├── session-2/
│   │   └── clear-command.test.ts
│   ├── session-3/
│   │   └── plan-ready-status.test.ts
│   ├── session-4/
│   │   └── skill-card.test.tsx
│   ├── session-5/
│   │   └── grep-restyle.test.tsx
│   ├── session-6/
│   │   └── permission-status.test.ts
│   ├── session-7/
│   │   └── merge-conflict-button.test.tsx
│   ├── session-8/
│   │   └── plain-file-backend.test.ts
│   ├── session-9/
│   │   └── plain-file-frontend.test.tsx
│   ├── session-10/
│   │   └── pr-github-backend.test.ts
│   ├── session-11/
│   │   └── pr-github-frontend.test.tsx
│   └── session-12/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies — all features use existing packages:
# - zustand (stores — already installed)
# - lucide-react (icons — already installed)
# - sonner (toasts — already installed)
# - react-syntax-highlighter (already installed)
# - simple-git (already installed)
# - Electron APIs: ipcRenderer, ipcMain (built-in)
```

---

## Session 1: Archive Task Stop

### Objectives

- Stop any running run-tab process (dev server, build, etc.) before archiving a worktree
- Abort any active OpenCode streaming sessions for the worktree before archiving
- Prevent orphaned child processes and lingering OpenCode sessions

### Tasks

#### 1. Kill running script process before archive

In `src/renderer/src/stores/useWorktreeStore.ts`, in the `archiveWorktree` action, add a kill step before the existing `window.worktreeOps.delete()` call:

```typescript
import { useScriptStore } from './useScriptStore'
import { useSessionStore } from './useSessionStore'
import { useWorktreeStatusStore } from './useWorktreeStatusStore'

// Inside archiveWorktree, before window.worktreeOps.delete():

// 1. Kill running script process
const scriptState = useScriptStore.getState().scriptStates[worktreeId]
if (scriptState?.runRunning) {
  try {
    await window.scriptOps.kill(worktreeId)
    useScriptStore.getState().setRunRunning(worktreeId, false)
  } catch {
    // Log but don't block archive — process may have already exited
  }
}
```

#### 2. Abort active OpenCode sessions

Still in the same `archiveWorktree` action, after the kill step:

```typescript
// 2. Abort any active streaming sessions
const sessionIds = useSessionStore.getState().sessionsByWorktree.get(worktreeId) || []
for (const sid of sessionIds) {
  const status = useWorktreeStatusStore.getState().sessionStatuses[sid]
  if (status?.status === 'working' || status?.status === 'planning') {
    try {
      await window.opencodeOps.abort(worktreePath, sid)
    } catch {
      // Non-critical — session may already be idle
    }
  }
}

// 3. Proceed with existing archive flow
```

### Key Files

- `src/renderer/src/stores/useWorktreeStore.ts` — add kill + abort logic in `archiveWorktree`

### Definition of Done

- [ ] Archiving a worktree with a running dev server kills the process first
- [ ] Archiving a worktree with active streaming sessions aborts them first
- [ ] If the process is already stopped, archive proceeds without error
- [ ] If abort fails (session already idle), archive still proceeds
- [ ] Existing archive behavior (DB update, git cleanup) is unchanged
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a dev server in a worktree via the run tab
2. Archive the worktree — verify the dev server process is killed (no orphaned process in Activity Monitor)
3. Start a streaming session in a worktree, then archive while it's streaming — verify streaming stops
4. Archive a worktree with no running tasks — verify it works as before

### Testing Criteria

```typescript
// test/phase-18/session-1/archive-task-stop.test.ts
describe('Session 1: Archive Task Stop', () => {
  test('archiveWorktree kills running script before archive', async () => {
    // Mock useScriptStore with runRunning: true for worktreeId
    // Mock window.scriptOps.kill to resolve successfully
    // Call archiveWorktree
    // Verify window.scriptOps.kill called with worktreeId
    // Verify window.worktreeOps.delete called AFTER kill
  })

  test('archiveWorktree proceeds if kill fails', async () => {
    // Mock useScriptStore with runRunning: true
    // Mock window.scriptOps.kill to reject
    // Call archiveWorktree
    // Verify window.worktreeOps.delete still called
  })

  test('archiveWorktree skips kill when no process running', async () => {
    // Mock useScriptStore with runRunning: false
    // Call archiveWorktree
    // Verify window.scriptOps.kill NOT called
    // Verify window.worktreeOps.delete called
  })

  test('archiveWorktree aborts active streaming sessions', async () => {
    // Mock sessionsByWorktree with two sessions
    // Mock sessionStatuses: one 'working', one null
    // Call archiveWorktree
    // Verify window.opencodeOps.abort called once (only for 'working')
  })
})
```

---

## Session 2: /clear Built-in Command

### Objectives

- Add `/clear` as a built-in slash command alongside `/undo` and `/redo`
- When executed, close the current session tab and create a new session in the same worktree
- Focus the input field on the new session
- No user message is created (immediate execution like `/undo`)

### Tasks

#### 1. Add `/clear` to `BUILT_IN_SLASH_COMMANDS`

In `src/renderer/src/components/sessions/SessionView.tsx`, add to the existing `BUILT_IN_SLASH_COMMANDS` array:

```typescript
{
  name: 'clear',
  description: 'Close current tab and open a new one',
  template: '/clear',
  builtIn: true
}
```

#### 2. Handle `/clear` in `handleSend`

Add alongside the existing `/undo` and `/redo` handling (around lines 1822-1878):

```typescript
if (commandName === 'clear') {
  setInputValue('')
  setShowSlashCommands(false)

  const currentSessionId = sessionId
  const currentWorktreeId = worktreeId

  // Close current tab
  closeTab(currentWorktreeId, currentSessionId)

  // Create new session
  const { success, session } = await createSession(currentWorktreeId, projectId)
  if (success && session) {
    setActiveSession(session.id)
  }

  return
}
```

#### 3. Verify auto-focus on new session

Confirm that the new `SessionView` instance auto-focuses its textarea on mount. If it does not, add a mount-time focus `useEffect`.

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — add `/clear` to commands, handle in `handleSend`

### Definition of Done

- [ ] Typing `/` shows `/clear` in the slash command popover
- [ ] Selecting and sending `/clear` closes the current tab
- [ ] A new session is created in the same worktree and becomes active
- [ ] The input field of the new session is focused
- [ ] No user message is created in the chat for `/clear`
- [ ] The closed session remains in session history (Cmd+K)
- [ ] `/clear` is filterable (typing `/cl` shows `/clear`)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a session, send some messages
2. Type `/clear` and press Enter
3. Verify the old tab is closed, a new empty tab appears, and the input is focused
4. Open session history (Cmd+K) — verify the old session is still listed
5. Type `/cl` — verify the popover filters to show `/clear`

### Testing Criteria

```typescript
// test/phase-18/session-2/clear-command.test.ts
describe('Session 2: /clear Command', () => {
  test('/clear is in BUILT_IN_SLASH_COMMANDS', () => {
    expect(BUILT_IN_SLASH_COMMANDS.find((c) => c.name === 'clear')).toBeDefined()
  })

  test('/clear calls closeTab then createSession', async () => {
    const closeTabMock = vi.fn()
    const createSessionMock = vi.fn().mockResolvedValue({ success: true, session: { id: 'new-1' } })
    const setActiveMock = vi.fn()
    // Mock store actions
    // Simulate handleSend with '/clear'
    // Verify closeTab called with current worktreeId and sessionId
    // Verify createSession called with worktreeId and projectId
    // Verify setActiveSession called with 'new-1'
  })

  test('/clear does not create user message', async () => {
    // Simulate handleSend with '/clear'
    // Verify no message was added to local messages
  })

  test('/clear clears input', async () => {
    // Simulate handleSend with '/clear' when input has text
    // Verify inputValue is set to ''
  })
})
```

---

## Session 3: Plan Ready Status

### Objectives

- Add `'plan_ready'` as a new session status type
- Track session mode (`'plan'` or `'build'`) when a session completes streaming
- After the completion badge clears, show "Plan ready" (blue) instead of "Ready" for plan-mode sessions
- Clear `'plan_ready'` when new streaming starts

### Tasks

#### 1. Add `'plan_ready'` to `SessionStatusType` and `completionMode` to entry

In `src/renderer/src/stores/useWorktreeStatusStore.ts`:

```typescript
type SessionStatusType =
  | 'working'
  | 'planning'
  | 'answering'
  | 'unread'
  | 'completed'
  | 'plan_ready'

interface SessionStatusEntry {
  status: SessionStatusType
  timestamp: number
  word?: string
  durationMs?: number
  completionMode?: 'plan' | 'build'
}
```

#### 2. Update `getWorktreeStatus()` priority

In the priority aggregation function, add `'plan_ready'` at very low priority (just above `'unread'`):

```typescript
// Priority: answering > planning > working > completed > plan_ready > unread > null
if (entry.status === 'plan_ready') {
  planReady = entry
}
```

#### 3. Include mode when setting completed status

In `SessionView.tsx`, wherever the `'completed'` status is set (the streaming finalization path):

```typescript
const mode = useSessionStore.getState().getSessionMode(sessionId)
statusStore.setSessionStatus(sessionId, 'completed', {
  word,
  durationMs,
  completionMode: mode
})
```

In the completion badge timeout callback, transition to `'plan_ready'` if the mode was `'plan'`:

```typescript
setTimeout(() => {
  const current = statusStore.sessionStatuses[sessionId]
  if (current?.status === 'completed') {
    if (current.completionMode === 'plan') {
      statusStore.setSessionStatus(sessionId, 'plan_ready')
    } else {
      statusStore.clearSessionStatus(sessionId)
    }
  }
}, 30_000)
```

#### 4. Do the same in `useOpenCodeGlobalListener.ts` for background sessions

When a background session goes idle and gets the completion badge, include the mode:

```typescript
const mode = useSessionStore.getState().getSessionMode(sessionId)
statusStore.setSessionStatus(sessionId, 'completed', {
  word,
  durationMs: 0,
  completionMode: mode
})
```

#### 5. Update `WorktreeItem.tsx` display

```typescript
: worktreeStatus === 'plan_ready'
  ? { displayStatus: 'Plan ready', statusClass: 'font-semibold text-blue-400' }
```

Icon:

```tsx
{
  worktreeStatus === 'plan_ready' && <Map className="h-3.5 w-3.5 text-blue-400 shrink-0" />
}
```

### Key Files

- `src/renderer/src/stores/useWorktreeStatusStore.ts` — new status type, `completionMode` field, priority
- `src/renderer/src/components/sessions/SessionView.tsx` — include mode in completed status
- `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` — include mode for background sessions
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — render "Plan ready" text and icon

### Definition of Done

- [ ] After a planning session completes and the badge clears, sidebar shows "Plan ready" in blue
- [ ] After a build session completes and the badge clears, sidebar shows "Ready" (unchanged)
- [ ] "Plan ready" shows a `Map` icon (matching plan mode toggle)
- [ ] Starting new streaming in a "Plan ready" session overrides to "Planning" or "Working"
- [ ] Background plan sessions also show "Plan ready" after completion
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a session, switch to plan mode, send a prompt
2. Wait for streaming to complete — observe "{Word} for {duration}" badge
3. Wait 30 seconds — verify sidebar shows "Plan ready" (blue) instead of "Ready"
4. Send another prompt in the same session — verify status changes to "Planning"
5. Repeat with a build-mode session — after badge clears, verify it shows "Ready" (not "Plan ready")

### Testing Criteria

```typescript
// test/phase-18/session-3/plan-ready-status.test.ts
describe('Session 3: Plan Ready Status', () => {
  test('completed status with plan mode transitions to plan_ready after timeout', () => {
    const store = useWorktreeStatusStore.getState()
    store.setSessionStatus('s1', 'completed', {
      word: 'Crafted',
      durationMs: 5000,
      completionMode: 'plan'
    })
    // Advance timers by 30001ms
    vi.advanceTimersByTime(30001)
    expect(store.sessionStatuses['s1']?.status).toBe('plan_ready')
  })

  test('completed status with build mode clears to null after timeout', () => {
    const store = useWorktreeStatusStore.getState()
    store.setSessionStatus('s1', 'completed', {
      word: 'Built',
      durationMs: 5000,
      completionMode: 'build'
    })
    vi.advanceTimersByTime(30001)
    expect(store.sessionStatuses['s1']).toBeNull()
  })

  test('plan_ready has lower priority than working/planning', () => {
    // Set session A to 'plan_ready', session B to 'working'
    // Both in same worktree
    // getWorktreeStatus returns 'working'
  })

  test('WorktreeItem renders Plan ready with blue styling', () => {
    // Mock worktreeStatus = 'plan_ready'
    // Render WorktreeItem
    // Verify text "Plan ready" with text-blue-400
  })
})
```

---

## Session 4: Skill Card UI

### Objectives

- Create a `SkillToolView` component that renders skill tool output as expandable markdown
- Register it in `ToolCard.tsx` for `Skill` / `mcp_skill` tool names
- Use the `CompactFileToolCard` layout with a `Zap` icon, "Skill" label, and skill name
- Parse `<skill_content>` tags from output to extract the markdown

### Tasks

#### 1. Create `SkillToolView.tsx`

Create `src/renderer/src/components/sessions/tools/SkillToolView.tsx`:

```tsx
import { useMemo } from 'react'
import { MarkdownRenderer } from '../MarkdownRenderer'

interface SkillToolViewProps {
  input: Record<string, unknown>
  output: string
}

export function SkillToolView({ output }: SkillToolViewProps) {
  const markdownContent = useMemo(() => {
    if (!output) return ''
    const match = output.match(/<skill_content[^>]*>([\s\S]*?)<\/skill_content>/)
    if (match) return match[1].trim()
    return output
  }, [output])

  return (
    <div className="text-xs">
      {markdownContent ? (
        <div className="p-3 max-h-[400px] overflow-y-auto">
          <MarkdownRenderer content={markdownContent} />
        </div>
      ) : (
        <div className="p-3 text-muted-foreground">Loading skill...</div>
      )}
    </div>
  )
}
```

#### 2. Register in `ToolCard.tsx`

In `TOOL_RENDERERS`:

```typescript
Skill: SkillToolView,
mcp_skill: SkillToolView,
```

In `getToolRenderer()` fallback chain:

```typescript
if (lower.includes('skill')) return SkillToolView
```

#### 3. Add collapsed content for skill tools

In the `CollapsedContent` component in `ToolCard.tsx`:

```typescript
if (lower === 'skill' || lower === 'mcp_skill' || lower.includes('skill')) {
  const skillName = (toolUse.input as Record<string, unknown>)?.name as string
  return (
    <>
      <Zap className="h-3.5 w-3.5 text-amber-400 shrink-0" />
      <span className="text-muted-foreground">Skill</span>
      <span className="truncate">{skillName || 'unknown'}</span>
    </>
  )
}
```

#### 4. Route skill tools through CompactFileToolCard

In the main `ToolCard` component render function:

```typescript
const isSkill = lower === 'skill' || lower === 'mcp_skill' || lower.includes('skill')
if (isFileOperation(toolUse.name) || isSkill) {
  return <CompactFileToolCard toolUse={toolUse} cwd={cwd} />
}
```

### Key Files

- `src/renderer/src/components/sessions/tools/SkillToolView.tsx` — **new file**
- `src/renderer/src/components/sessions/ToolCard.tsx` — register, collapsed content, routing

### Definition of Done

- [ ] Skill tool calls render with a Zap icon and "Skill" label (no more yellow "TODO" badge)
- [ ] The skill name (e.g., "executing-plans") appears in the collapsed header
- [ ] Clicking + expands to show the skill markdown content
- [ ] Content between `<skill_content>` tags is extracted and rendered as markdown
- [ ] If output has no `<skill_content>` tags, the entire output is rendered
- [ ] While loading (empty output), shows "Loading skill..." placeholder
- [ ] Expanded content is scrollable with a max height of 400px
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. In a session, trigger a tool call that uses `mcp_skill` (e.g., ask Claude to load a skill)
2. Verify the card shows ⚡ Skill + skill name in collapsed state
3. Click + to expand — verify markdown renders with headers, bold, bullet lists
4. Verify scrolling works for long skill content

### Testing Criteria

```typescript
// test/phase-18/session-4/skill-card.test.tsx
describe('Session 4: Skill Card UI', () => {
  test('SkillToolView extracts content from skill_content tags', () => {
    const output = '<skill_content name="test"># Hello\n\nWorld</skill_content>'
    // Render SkillToolView with output
    // Verify "# Hello" content is rendered (via MarkdownRenderer)
  })

  test('SkillToolView renders full output when no tags found', () => {
    const output = '# Some raw markdown'
    // Render SkillToolView with output
    // Verify the content is rendered
  })

  test('SkillToolView shows loading state when output is empty', () => {
    // Render SkillToolView with output = ''
    // Verify "Loading skill..." text is shown
  })

  test('getToolRenderer returns SkillToolView for skill tools', () => {
    expect(getToolRenderer('Skill')).toBe(SkillToolView)
    expect(getToolRenderer('mcp_skill')).toBe(SkillToolView)
  })

  test('skill tools are routed through CompactFileToolCard', () => {
    // Render ToolCard with name='Skill'
    // Verify CompactFileToolCard layout is used (has +/- button)
  })
})
```

---

## Session 5: Grep Tool UI Restyle

### Objectives

- Route Grep and Glob tools through the `CompactFileToolCard` layout (same as Read/Edit)
- Rename "Grep" to "Search" and "Glob" to "Find files" in the collapsed header
- Show a Search (magnifying glass) icon
- Display pattern, path, and match count in the collapsed header
- Keep the existing `GrepToolView` content renderer unchanged

### Tasks

#### 1. Add `isSearchOperation()` helper to `ToolCard.tsx`

```typescript
function isSearchOperation(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === 'grep' ||
    lower === 'mcp_grep' ||
    lower === 'glob' ||
    lower === 'mcp_glob' ||
    lower.includes('grep') ||
    lower.includes('glob')
  )
}
```

#### 2. Route search tools through CompactFileToolCard

In the `ToolCard` component render, update the routing:

```typescript
if (isFileOperation(toolUse.name) || isSearchOperation(toolUse.name)) {
  return <CompactFileToolCard toolUse={toolUse} cwd={cwd} />
}
```

#### 3. Add collapsed content for Grep and Glob

In the `CollapsedContent` component, add cases before the existing fallback:

For Grep → "Search":

```typescript
if (lower.includes('grep') || lower === 'mcp_grep') {
  const pattern = (toolUse.input as Record<string, unknown>)?.pattern as string
  const searchPath = (toolUse.input as Record<string, unknown>)?.path as string
  const matchCount = toolUse.output?.split('\n').filter(Boolean).length || 0
  return (
    <>
      <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">Search</span>
      <span className="truncate">"{pattern}"</span>
      {searchPath && <span className="text-muted-foreground truncate">in {searchPath}</span>}
      {matchCount > 0 && <span className="text-muted-foreground">({matchCount})</span>}
    </>
  )
}
```

For Glob → "Find files":

```typescript
if (lower.includes('glob') || lower === 'mcp_glob') {
  const pattern = (toolUse.input as Record<string, unknown>)?.pattern as string
  const matchCount = toolUse.output?.split('\n').filter(Boolean).length || 0
  return (
    <>
      <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">Find files</span>
      <span className="truncate">{pattern}</span>
      {matchCount > 0 && <span className="text-muted-foreground">({matchCount})</span>}
    </>
  )
}
```

### Key Files

- `src/renderer/src/components/sessions/ToolCard.tsx` — `isSearchOperation()`, routing, collapsed content

### Definition of Done

- [ ] Grep tool renders with the compact +/- card layout (not the standard card)
- [ ] Collapsed header shows: 🔍 Search "pattern" in path (count)
- [ ] Glob tool renders with compact layout: 🔍 Find files pattern (count)
- [ ] Expanded content still shows the same GrepToolView with pattern highlighting
- [ ] +/- toggle works for expand/collapse
- [ ] Loader spinner shows while the tool is running
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. In a session, trigger a grep/search operation (ask Claude to search for something)
2. Verify the collapsed card shows Search icon + "Search" label + pattern + match count
3. Click + to expand — verify results with pattern highlighting render
4. Click - to collapse
5. Trigger a glob operation — verify "Find files" label with file count

### Testing Criteria

```typescript
// test/phase-18/session-5/grep-restyle.test.tsx
describe('Session 5: Grep UI Restyle', () => {
  test('isSearchOperation matches grep variants', () => {
    expect(isSearchOperation('Grep')).toBe(true)
    expect(isSearchOperation('mcp_grep')).toBe(true)
    expect(isSearchOperation('Glob')).toBe(true)
    expect(isSearchOperation('mcp_glob')).toBe(true)
    expect(isSearchOperation('Read')).toBe(false)
  })

  test('grep tools use CompactFileToolCard layout', () => {
    // Render ToolCard with name='Grep'
    // Verify compact layout is used
  })

  test('collapsed content shows Search label for grep', () => {
    // Render CollapsedContent with grep toolUse
    // Verify "Search" text present, not "Grep"
  })

  test('collapsed content shows Find files label for glob', () => {
    // Render CollapsedContent with glob toolUse
    // Verify "Find files" text present
  })
})
```

---

## Session 6: Permission Requested Status in Sidebar

### Objectives

- Add `'permission'` as a new session status type
- Set `'permission'` status when a `permission.asked` event arrives (both active and background sessions)
- Clear `'permission'` status when the permission is replied/rejected
- Display "Permission requested" in the sidebar with amber styling (same as "Answer questions")

### Tasks

#### 1. Extend `SessionStatusType`

In `src/renderer/src/stores/useWorktreeStatusStore.ts`:

```typescript
type SessionStatusType =
  | 'working'
  | 'planning'
  | 'answering'
  | 'permission'
  | 'unread'
  | 'completed'
  | 'plan_ready'
```

Update `getWorktreeStatus()` priority — `'permission'` has the same priority as `'answering'`:

```typescript
if (entry.status === 'answering' || entry.status === 'permission') {
  return entry.status
}
```

#### 2. Set permission status in global listener

In `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`, in the `permission.asked` handler:

```typescript
useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'permission')
```

#### 3. Clear permission status on reply

In both the global listener and SessionView `permission.replied` / `permission.rejected` handlers, after removing the permission:

```typescript
const remaining = usePermissionStore.getState().pendingBySession.get(sessionId)
if (!remaining || remaining.length === 0) {
  const mode = useSessionStore.getState().getSessionMode(sessionId)
  useWorktreeStatusStore
    .getState()
    .setSessionStatus(sessionId, mode === 'plan' ? 'planning' : 'working')
}
```

#### 4. Set permission status for active session

In `SessionView.tsx`, add a `useEffect` that mirrors the answering-status pattern:

```typescript
useEffect(() => {
  if (activePermission) {
    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'permission')
  } else {
    const current = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
    if (current?.status === 'permission') {
      const mode = getSessionMode(sessionId)
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, mode === 'plan' ? 'planning' : 'working')
    }
  }
}, [activePermission, sessionId])
```

#### 5. Update WorktreeItem and SessionTabs display

In `WorktreeItem.tsx`:

```typescript
: worktreeStatus === 'permission'
  ? { displayStatus: 'Permission requested', statusClass: 'font-semibold text-amber-500' }
```

Icon:

```tsx
{
  worktreeStatus === 'permission' && <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
}
```

In `SessionTabs.tsx`:

```tsx
{
  sessionStatus === 'permission' && <AlertCircle className="h-3 w-3 text-amber-500 flex-shrink-0" />
}
```

### Key Files

- `src/renderer/src/stores/useWorktreeStatusStore.ts` — new status, priority
- `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` — set on permission.asked
- `src/renderer/src/components/sessions/SessionView.tsx` — set for active session, clear on reply
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — display text and icon
- `src/renderer/src/components/sessions/SessionTabs.tsx` — tab icon

### Definition of Done

- [ ] Permission requests on background sessions show "Permission requested" in the sidebar
- [ ] Permission requests on the active session also show "Permission requested"
- [ ] After replying to the permission, status reverts to "Working" or "Planning"
- [ ] Amber AlertCircle icon matches the "Answer questions" visual pattern
- [ ] Tab bar shows the amber icon for sessions with pending permissions
- [ ] `'permission'` has the same priority as `'answering'` in worktree status aggregation
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a session, trigger a bash command that requires permission
2. Verify the sidebar shows "Permission requested" with amber icon
3. Reply to the permission — verify status reverts to "Working"
4. Switch to another worktree while a permission is pending — verify the original worktree shows the status
5. Start a background session that triggers a permission — verify sidebar updates without switching to it

### Testing Criteria

```typescript
// test/phase-18/session-6/permission-status.test.ts
describe('Session 6: Permission Status', () => {
  test('permission.asked sets permission status for background session', () => {
    // Fire permission.asked event for a non-active session
    // Verify setSessionStatus called with 'permission'
  })

  test('permission.replied clears permission status', () => {
    // Set session status to 'permission'
    // Fire permission.replied event
    // Verify status reverts to 'working' or 'planning'
  })

  test('permission status has same priority as answering', () => {
    // Set session A to 'permission', session B to 'working'
    // getWorktreeStatus returns 'permission'
  })

  test('WorktreeItem shows Permission requested in amber', () => {
    // Mock worktreeStatus = 'permission'
    // Verify displayStatus = 'Permission requested'
  })
})
```

---

## Session 7: Merge Conflict Header Button

### Objectives

- Track whether the current worktree has merge conflicts in `useGitStore`
- Show a red "Fix conflicts" button in the main header when conflicts exist
- Clicking the button creates a new build-mode session with "Fix merge conflicts" prompt

### Tasks

#### 1. Add `conflictsByWorktree` state to `useGitStore`

In `src/renderer/src/stores/useGitStore.ts`:

```typescript
conflictsByWorktree: {} as Record<string, boolean>,

setHasConflicts: (worktreeId: string, hasConflicts: boolean) => {
  set((state) => ({
    conflictsByWorktree: {
      ...state.conflictsByWorktree,
      [worktreeId]: hasConflicts
    }
  }))
}
```

#### 2. Update conflict detection on status refresh

Wherever `refreshStatuses()` or file status loading processes git files, compute and store the conflict flag:

```typescript
const hasConflicts = files.some((f) => f.status === 'C')
get().setHasConflicts(worktreeId, hasConflicts)
```

#### 3. Add conflict button to `Header.tsx`

In `src/renderer/src/components/layout/Header.tsx`:

```tsx
const hasConflicts = useGitStore((state) => state.conflictsByWorktree[selectedWorktreeId] ?? false)

// Between QuickActions and History button:
{
  hasConflicts && (
    <Button
      size="sm"
      variant="destructive"
      className="h-7 text-xs font-semibold"
      onClick={handleFixConflicts}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      data-testid="fix-conflicts-button"
    >
      <AlertTriangle className="h-3.5 w-3.5 mr-1" />
      Fix conflicts
    </Button>
  )
}
```

#### 4. Implement `handleFixConflicts`

```typescript
const handleFixConflicts = async () => {
  if (!selectedWorktreeId || !selectedProjectId) return
  const { success, session } = await createSession(selectedWorktreeId, selectedProjectId)
  if (!success || !session) return

  const branchName = selectedWorktree?.branch_name || 'unknown'
  await updateSessionName(session.id, `Merge Conflicts -- ${branchName}`)
  setPendingMessage(session.id, 'Fix merge conflicts')
  setActiveSession(session.id)
}
```

### Key Files

- `src/renderer/src/stores/useGitStore.ts` — `conflictsByWorktree`, `setHasConflicts`
- `src/renderer/src/components/layout/Header.tsx` — button rendering and handler

### Definition of Done

- [ ] When merge conflicts exist, a red "Fix conflicts" button appears in the header
- [ ] The button is visible regardless of whether the git panel is open
- [ ] Clicking creates a new session named "Merge Conflicts -- {branch}" with "Fix merge conflicts" prompt
- [ ] The session auto-sends the prompt on mount (via pending message)
- [ ] When conflicts are resolved (no more `status === 'C'` files), the button disappears
- [ ] The button has `data-testid="fix-conflicts-button"` for testing
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Trigger a merge with conflicts (merge a branch with conflicting changes)
2. Verify the red "Fix conflicts" button appears in the header
3. Click the button — verify a new session opens with the correct prompt
4. Resolve the conflicts and refresh git status — verify the button disappears
5. When no conflicts exist — verify no button is shown

### Testing Criteria

```typescript
// test/phase-18/session-7/merge-conflict-button.test.tsx
describe('Session 7: Merge Conflict Header Button', () => {
  test('button renders when hasConflicts is true', () => {
    // Mock useGitStore.conflictsByWorktree[worktreeId] = true
    // Render Header
    // Verify fix-conflicts-button is in the document
  })

  test('button hidden when hasConflicts is false', () => {
    // Mock conflictsByWorktree = false
    // Render Header
    // Verify fix-conflicts-button NOT in document
  })

  test('handleFixConflicts creates session with correct prompt', async () => {
    // Mock createSession, setPendingMessage, setActiveSession
    // Call handleFixConflicts
    // Verify session named "Merge Conflicts -- {branch}"
    // Verify pending message is "Fix merge conflicts"
  })
})
```

---

## Session 8: Plain File Rendering — Backend

### Objectives

- Add a `git:getFileContent` IPC endpoint to read raw file content from a worktree
- Expose through the preload bridge with type declarations
- This provides the backend for rendering new/added files as plain content instead of diff

### Tasks

#### 1. Add `git:getFileContent` IPC handler

In `src/main/ipc/git-file-handlers.ts`:

```typescript
ipcMain.handle('git:getFileContent', async (_event, { worktreePath, filePath }) => {
  try {
    const fullPath = path.join(worktreePath, filePath)
    const content = await fs.readFile(fullPath, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return {
      success: false,
      content: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})
```

#### 2. Expose in preload

In `src/preload/index.ts`:

```typescript
getFileContent: (worktreePath: string, filePath: string) =>
  ipcRenderer.invoke('git:getFileContent', { worktreePath, filePath })
```

#### 3. Add type declaration

In `src/preload/index.d.ts`:

```typescript
getFileContent(worktreePath: string, filePath: string): Promise<{
  success: boolean
  content: string | null
  error?: string
}>
```

### Key Files

- `src/main/ipc/git-file-handlers.ts` — `git:getFileContent` handler
- `src/preload/index.ts` — expose `getFileContent`
- `src/preload/index.d.ts` — type declaration

### Definition of Done

- [ ] `git:getFileContent` IPC handler reads file content from disk
- [ ] Returns `{ success: true, content: "..." }` on success
- [ ] Returns `{ success: false, error: "..." }` on failure (file not found, encoding issues)
- [ ] Preload bridge exposes `window.gitOps.getFileContent()`
- [ ] Type declaration matches the implementation
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-18/session-8/plain-file-backend.test.ts
describe('Session 8: Plain File Rendering Backend', () => {
  test('getFileContent type declaration exists', () => {
    // TypeScript compilation validates the type exists
  })

  test('handler returns success with content for existing file', async () => {
    // Mock fs.readFile to return 'file content'
    // Invoke handler
    // Verify { success: true, content: 'file content' }
  })

  test('handler returns error for missing file', async () => {
    // Mock fs.readFile to throw ENOENT
    // Invoke handler
    // Verify { success: false, error: ... }
  })
})
```

---

## Session 9: Plain File Rendering — Frontend

### Objectives

- Pass `isNewFile` flag from git views to the diff viewer for files with status `'?'` or `'A'`
- When `isNewFile` is true, fetch raw file content and render with syntax highlighting instead of diff
- Add `isNewFile` to the diff tab interface

### Tasks

#### 1. Update `setActiveDiff` call sites

In `src/renderer/src/components/file-tree/ChangesView.tsx` (`handleViewDiff`):

```typescript
const isNewFile = file.status === '?' || file.status === 'A'
setActiveDiff({
  worktreePath,
  filePath: file.path,
  staged: file.staged,
  isUntracked: file.status === '?',
  isNewFile
})
```

Same change in `src/renderer/src/components/git/GitStatusPanel.tsx` (`handleViewDiff`).

#### 2. Add `isNewFile` to diff types

In `src/renderer/src/stores/useFileViewerStore.ts`, add `isNewFile?: boolean` to the diff-related interfaces.

#### 3. Update `InlineDiffViewer.tsx`

Add `isNewFile` prop. When true, fetch raw content and render as plain file:

```typescript
// New state for plain file content:
const [fileContent, setFileContent] = useState<string | null>(null)

// In the fetch logic:
if (isNewFile) {
  const result = await window.gitOps.getFileContent(worktreePath, filePath)
  if (result.success && result.content) {
    setFileContent(result.content)
  }
  return
}
// ... existing diff fetch

// In rendering:
{isNewFile && fileContent ? (
  <div className="overflow-auto flex-1">
    <SyntaxHighlighter
      language={getLanguageFromPath(filePath)}
      style={oneDark}
      showLineNumbers
      customStyle={{ margin: 0, background: 'transparent', fontSize: '12px' }}
    >
      {fileContent}
    </SyntaxHighlighter>
  </div>
) : (
  // ... existing diff rendering
)}
```

The status label (line 130) should show "New file" for `isNewFile` files.

### Key Files

- `src/renderer/src/components/file-tree/ChangesView.tsx` — pass `isNewFile` flag
- `src/renderer/src/components/git/GitStatusPanel.tsx` — pass `isNewFile` flag
- `src/renderer/src/stores/useFileViewerStore.ts` — add `isNewFile` to interface
- `src/renderer/src/components/diff/InlineDiffViewer.tsx` — render plain content for new files

### Definition of Done

- [ ] Clicking an untracked (`?`) file in git changes shows plain file content with line numbers
- [ ] Clicking a staged-added (`A`) file also shows plain file content
- [ ] Plain file content has syntax highlighting appropriate to the file extension
- [ ] Modified (`M`) and deleted (`D`) files still show diffs (unchanged behavior)
- [ ] Status label shows "New file" for new files
- [ ] The toolbar (close, copy, context buttons) still works
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a new file in a worktree (untracked, status `?`)
2. Click it in the changes view — verify it renders as plain content with line numbers, no green + prefixes
3. Stage the file (status `A`) — click it — verify it still renders as plain content
4. Modify an existing file — click it — verify it still shows the diff view

### Testing Criteria

```typescript
// test/phase-18/session-9/plain-file-frontend.test.tsx
describe('Session 9: Plain File Rendering Frontend', () => {
  test('untracked files pass isNewFile=true to diff viewer', () => {
    // Mock file with status '?'
    // Trigger handleViewDiff
    // Verify setActiveDiff called with isNewFile: true
  })

  test('added files pass isNewFile=true to diff viewer', () => {
    // Mock file with status 'A'
    // Trigger handleViewDiff
    // Verify setActiveDiff called with isNewFile: true
  })

  test('modified files pass isNewFile=false', () => {
    // Mock file with status 'M'
    // Verify setActiveDiff called with isNewFile: false (or undefined)
  })

  test('InlineDiffViewer fetches raw content when isNewFile', () => {
    // Render InlineDiffViewer with isNewFile=true
    // Verify window.gitOps.getFileContent called
    // Verify window.gitOps.getDiff NOT called
  })

  test('InlineDiffViewer renders syntax-highlighted content for new files', () => {
    // Mock getFileContent to return TypeScript content
    // Render with isNewFile=true
    // Verify SyntaxHighlighter is used, not diff renderer
  })
})
```

---

## Session 10: PR to GitHub — Backend

### Objectives

- Add a `git:getRemoteUrl` IPC endpoint to fetch the remote URL for a worktree
- Expose through the preload bridge with type declarations
- Add `remoteInfo` and `prTargetBranch` state to `useGitStore` with a `checkRemoteInfo` action

### Tasks

#### 1. Add `git:getRemoteUrl` IPC handler

In `src/main/ipc/git-file-handlers.ts`:

```typescript
ipcMain.handle('git:getRemoteUrl', async (_event, { worktreePath, remote = 'origin' }) => {
  try {
    const git = simpleGit(worktreePath)
    const remotes = await git.getRemotes(true)
    const target = remotes.find((r) => r.name === remote)
    return {
      success: true,
      url: target?.refs?.fetch || target?.refs?.push || null,
      remote: target?.name || null
    }
  } catch (error) {
    return {
      success: false,
      url: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})
```

#### 2. Expose in preload

In `src/preload/index.ts`:

```typescript
getRemoteUrl: (worktreePath: string, remote?: string) =>
  ipcRenderer.invoke('git:getRemoteUrl', { worktreePath, remote })
```

#### 3. Add type declaration

In `src/preload/index.d.ts`:

```typescript
getRemoteUrl(worktreePath: string, remote?: string): Promise<{
  success: boolean
  url: string | null
  remote: string | null
  error?: string
}>
```

#### 4. Add store state and actions

In `src/renderer/src/stores/useGitStore.ts`:

```typescript
remoteInfo: new Map() as Map<string, { hasRemote: boolean; isGitHub: boolean; url: string | null }>,
prTargetBranch: new Map() as Map<string, string>,

checkRemoteInfo: async (worktreeId: string, worktreePath: string) => {
  const result = await window.gitOps.getRemoteUrl(worktreePath)
  const info = {
    hasRemote: !!result.url,
    isGitHub: result.url?.includes('github.com') ?? false,
    url: result.url
  }
  set((state) => {
    const remoteInfo = new Map(state.remoteInfo)
    remoteInfo.set(worktreeId, info)
    return { remoteInfo }
  })
},

setPrTargetBranch: (worktreeId: string, branch: string) => {
  set((state) => {
    const prTargetBranch = new Map(state.prTargetBranch)
    prTargetBranch.set(worktreeId, branch)
    return { prTargetBranch }
  })
}
```

#### 5. Trigger remote check on worktree selection

In `AppLayout.tsx` or the worktree selection flow:

```typescript
useEffect(() => {
  if (!selectedWorktreeId || !selectedWorktreePath) return
  const info = useGitStore.getState().remoteInfo.get(selectedWorktreeId)
  if (!info) {
    useGitStore.getState().checkRemoteInfo(selectedWorktreeId, selectedWorktreePath)
  }
}, [selectedWorktreeId, selectedWorktreePath])
```

### Key Files

- `src/main/ipc/git-file-handlers.ts` — `git:getRemoteUrl` handler
- `src/preload/index.ts` — expose `getRemoteUrl`
- `src/preload/index.d.ts` — type declaration
- `src/renderer/src/stores/useGitStore.ts` — `remoteInfo`, `prTargetBranch`, `checkRemoteInfo`
- `src/renderer/src/components/layout/AppLayout.tsx` — trigger remote check

### Definition of Done

- [ ] `git:getRemoteUrl` returns the remote URL for the default remote (`origin`)
- [ ] GitHub detection correctly identifies `github.com` in SSH and HTTPS URLs
- [ ] `remoteInfo` is populated on first worktree selection (not re-checked on subsequent selections)
- [ ] `prTargetBranch` can be set per worktree
- [ ] Non-GitHub remotes (GitLab, Bitbucket) are correctly identified as `isGitHub: false`
- [ ] Worktrees with no remote return `{ hasRemote: false, isGitHub: false }`
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-18/session-10/pr-github-backend.test.ts
describe('Session 10: PR to GitHub Backend', () => {
  test('getRemoteUrl returns GitHub SSH URL', async () => {
    // Mock simpleGit.getRemotes returning origin with git@github.com:org/repo.git
    // Verify { success: true, url: 'git@github.com:org/repo.git' }
  })

  test('getRemoteUrl returns GitHub HTTPS URL', async () => {
    // Mock with https://github.com/org/repo.git
    // Verify success
  })

  test('checkRemoteInfo detects GitHub', async () => {
    // Mock getRemoteUrl returning GitHub URL
    // Call checkRemoteInfo
    // Verify remoteInfo.get(id) = { hasRemote: true, isGitHub: true, url: ... }
  })

  test('checkRemoteInfo detects non-GitHub', async () => {
    // Mock with gitlab.com URL
    // Verify isGitHub: false
  })

  test('checkRemoteInfo handles no remote', async () => {
    // Mock getRemoteUrl returning url: null
    // Verify { hasRemote: false, isGitHub: false }
  })

  test('remote check only runs once per worktree', () => {
    // Set remoteInfo for worktreeId
    // Trigger the useEffect
    // Verify checkRemoteInfo NOT called again
  })
})
```

---

## Session 11: PR to GitHub — Frontend

### Objectives

- Add a PR button to `GitPushPull.tsx` that is visible only for GitHub-backed worktrees
- Show the target branch next to the button with a dropdown to change it
- Clicking PR creates a new session with a prompt for `gh pr create`

### Tasks

#### 1. Read remote info and branch data in `GitPushPull.tsx`

```typescript
const remoteInfo = useGitStore((state) => state.remoteInfo.get(worktreeId))
const isGitHub = remoteInfo?.isGitHub ?? false
const prTargetBranch = useGitStore((state) => state.prTargetBranch.get(worktreeId))
const setPrTargetBranch = useGitStore((state) => state.setPrTargetBranch)
```

#### 2. Add PR button and target branch dropdown

Render after the existing push/pull/merge buttons:

```tsx
{
  isGitHub && (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="outline" onClick={handleCreatePR} title="Create Pull Request">
        <GitPullRequest className="h-3.5 w-3.5 mr-1" />
        PR
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="text-xs text-muted-foreground px-2">
            → {prTargetBranch || branchInfo?.tracking || 'origin/main'}
            <ChevronDown className="h-3 w-3 ml-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-60 overflow-y-auto">
          {remoteBranches.map((branch) => (
            <DropdownMenuItem
              key={branch.name}
              onClick={() => setPrTargetBranch(worktreeId, branch.name)}
            >
              {branch.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
```

#### 3. Load remote branches for the dropdown

Use `window.gitOps.listBranchesWithStatus()` to populate the remote branch list:

```typescript
const remoteBranches = useMemo(() => branches.filter((b) => b.isRemote), [branches])
```

#### 4. Implement `handleCreatePR`

```typescript
const handleCreatePR = async () => {
  const targetBranch = prTargetBranch || branchInfo?.tracking || 'origin/main'
  const { success, session } = await createSession(worktreeId, projectId)
  if (!success || !session) return

  await updateSessionName(session.id, `PR → ${targetBranch}`)
  setPendingMessage(
    session.id,
    [
      `Create a pull request targeting ${targetBranch}.`,
      `Use \`gh pr create\` to create the PR.`,
      `Base the PR title and description on the git diff between HEAD and ${targetBranch}.`,
      `Make the description comprehensive, summarizing all changes.`
    ].join(' ')
  )

  setActiveSession(session.id)
}
```

### Key Files

- `src/renderer/src/components/git/GitPushPull.tsx` — PR button, target branch dropdown, `handleCreatePR`

### Definition of Done

- [ ] PR button appears only for GitHub-backed worktrees (not shown for GitLab, Bitbucket, or no remote)
- [ ] Target branch dropdown shows all remote branches and allows switching
- [ ] Default target branch is the tracking branch (e.g., `origin/main`)
- [ ] Clicking PR creates a new session with the correct auto-send prompt
- [ ] The session is named `PR → {targetBranch}`
- [ ] After creating the PR session, the tab switches to it
- [ ] The AI agent receives the prompt and can execute `gh pr create`
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a project backed by a GitHub repository
2. Verify the PR button appears in the git toolbar
3. Click the target branch dropdown — verify remote branches are listed
4. Select a different target branch — verify the dropdown label updates
5. Click PR — verify a new session opens with the PR creation prompt
6. Open a project backed by a non-GitHub remote — verify no PR button

### Testing Criteria

```typescript
// test/phase-18/session-11/pr-github-frontend.test.tsx
describe('Session 11: PR to GitHub Frontend', () => {
  test('PR button visible when isGitHub is true', () => {
    // Mock remoteInfo with isGitHub: true
    // Render GitPushPull
    // Verify PR button is in the document
  })

  test('PR button hidden when isGitHub is false', () => {
    // Mock remoteInfo with isGitHub: false
    // Render GitPushPull
    // Verify no PR button
  })

  test('handleCreatePR creates session with correct prompt', async () => {
    // Mock createSession, setPendingMessage, setActiveSession
    // Call handleCreatePR
    // Verify session named "PR → origin/main"
    // Verify pending message contains "gh pr create"
  })

  test('target branch dropdown shows remote branches', () => {
    // Mock branches with remote branches
    // Open dropdown
    // Verify remote branches are listed
  })

  test('selecting target branch updates store', () => {
    // Click a branch in dropdown
    // Verify setPrTargetBranch called with correct branch
  })
})
```

---

## Session 12: Integration & Verification

### Objectives

- Verify all Phase 18 features work together end-to-end
- Run full test suite and lint
- Test edge cases and cross-feature interactions

### Tasks

#### 1. Run full test suite

```bash
pnpm test
pnpm lint
```

Fix any failures.

#### 2. Verify each feature end-to-end

**Archive Task Stop:**

- Start dev server, archive worktree → process killed
- Start streaming, archive → streaming aborted

**/clear Command:**

- Type `/clear` → old tab closed, new tab open, input focused
- Old session still in history (Cmd+K)

**Plan Ready Status:**

- Plan mode session completes → badge → "Plan ready"
- Build mode session completes → badge → "Ready"

**Skill Card:**

- Trigger skill tool call → Zap icon, expand to see markdown

**Grep Restyle:**

- Search operation → compact card with "Search" label and +/-

**Permission Status:**

- Background permission → sidebar shows "Permission requested"
- Reply → status reverts

**Merge Conflict Button:**

- Merge with conflicts → red button in header
- Click → new session with prompt
- Resolve conflicts → button disappears

**Plain File Rendering:**

- New/untracked file → plain content with syntax highlighting
- Modified file → diff view (unchanged)

**PR to GitHub:**

- GitHub worktree → PR button visible
- Non-GitHub → hidden
- Click PR → session with prompt

#### 3. Cross-feature interaction tests

- Archive a worktree that has a pending permission → both abort and permission cleared
- `/clear` while streaming → verify streaming stops for old session
- Merge conflict button + plan ready on same worktree → conflict button takes priority in header (both visible)
- Skill card and grep restyle don't interfere with each other in ToolCard routing

### Key Files

- All files modified in Sessions 1-11

### Definition of Done

- [ ] `pnpm test` passes with zero failures
- [ ] `pnpm lint` passes with zero errors
- [ ] All 9 features work end-to-end
- [ ] No regressions in existing Phase 17 features
- [ ] Cross-feature interactions behave correctly
- [ ] All edge cases tested

### Testing Criteria

```typescript
// test/phase-18/session-12/integration-verification.test.ts
describe('Session 12: Phase 18 Integration', () => {
  test('all new status types are handled in WorktreeItem', () => {
    // Verify 'permission' and 'plan_ready' statuses render correctly
    // Verify no TypeScript errors with the extended SessionStatusType
  })

  test('ToolCard routing handles skill, grep, glob, and file operations', () => {
    // Verify each tool type routes to the correct card layout
    // No tool falls through to FallbackToolView unexpectedly
  })

  test('built-in commands include undo, redo, and clear', () => {
    expect(BUILT_IN_SLASH_COMMANDS).toHaveLength(3)
    expect(BUILT_IN_SLASH_COMMANDS.map((c) => c.name)).toEqual(['undo', 'redo', 'clear'])
  })

  test('getWorktreeStatus priority ordering is correct', () => {
    // answering > permission > planning > working > completed > plan_ready > unread > null
    // Test with various combinations
  })
})
```
