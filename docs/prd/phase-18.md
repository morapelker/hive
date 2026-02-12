# Hive -- Phase 18 Product Requirements Document

## Overview

Phase 18 delivers nine targeted improvements spanning workspace lifecycle safety, new tool renderers, GitHub integration, permission visibility, merge conflict UX, git view refinements, search tool UI consistency, a `/clear` command, and planning-mode status clarity. It includes: stopping running tasks before archiving a workspace; rendering skill tool calls with an expandable card UI instead of the generic fallback; adding a PR-to-GitHub button that auto-fills details via an AI session; surfacing permission requests in the sidebar status even for non-visible sessions; showing a prominent "Fix merge conflicts" button in the header after a failed merge; rendering newly added files as plain content instead of diffs; restyling the Grep tool to match the compact Read/Edit pattern and renaming it "Search"; adding a `/clear` built-in command to close the current tab and open a fresh one; and changing the sidebar status from "Ready" to "Plan ready" when a planning session completes.

### Phase 18 Goals

1. Stop running tasks in the run tab before archiving a workspace
2. Implement skill card UI with expandable markdown rendering
3. Add a PR-to-GitHub button with auto-filled details via AI session
4. Surface permission requests in sidebar status for all sessions (including non-visible)
5. Show a "Fix merge conflicts" button in the header after merge conflicts
6. Render added/new files as plain content instead of diff in the git view
7. Restyle Grep tool UI to match compact Read/Edit pattern and rename to "Search"
8. Add `/clear` built-in command to close current tab and open a fresh one
9. Show "Plan ready" instead of "Ready" when a planning session completes

---

## Technical Additions

| Component                    | Technology                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Archive task stop            | `useScriptStore` kill integration in `useWorktreeStore.archiveWorktree`                        |
| Skill card UI                | New `SkillToolView.tsx` component with `Zap` icon, collapsible markdown via `MarkdownRenderer` |
| PR-to-GitHub                 | `gh pr create` via session prompt, remote URL detection IPC, branch picker dropdown            |
| Permission status            | Extend `useWorktreeStatusStore` to accept `'permission'` status, update global listener        |
| Merge conflict header button | New state in `useGitStore`, conditional button in `Header.tsx` with session auto-creation      |
| Plain file rendering         | Extend `InlineDiffViewer` to render raw file content for `isUntracked` or status `'A'`         |
| Grep UI restyle              | Refactor `GrepToolView.tsx` to use `CompactFileToolCard` pattern, rename label to "Search"     |
| /clear command               | New built-in command in `SessionView.tsx`, close tab + create new session                      |
| Plan ready status            | New `SessionStatusType` value or conditional display logic in `WorktreeItem.tsx`               |

---

## Features

### 1. Stop Running Tasks Before Archiving

#### 1.1 Current State

The `archiveWorktree` action in `useWorktreeStore.ts` (lines 188-250) archives a worktree by calling `window.worktreeOps.delete({ archive: true })`. It guards against archiving default worktrees (lines 194-199) but does **not** check whether a task is running in the run tab for that worktree.

The run tab state is managed by `useScriptStore.ts`, which tracks `runRunning: boolean` and `runPid: number | null` per worktree. Killing a running process is done via `window.scriptOps.kill(worktreeId)` which is exposed through the preload layer (`src/preload/index.ts`, line 951) and identifies processes by worktree ID.

If a user archives a worktree while a dev server or build process is running, the process becomes orphaned — the worktree directory may be deleted but the child process keeps running, consuming resources and potentially holding file locks.

#### 1.2 New Design

```
Archive worktree flow (with task stop):

  ┌──────────────────────────────────────────────────┐
  │ User clicks "Archive" on worktree                 │
  │                                                   │
  │  1. Check useScriptStore for runRunning            │
  │     for this worktreeId                           │
  │                                                   │
  │  2. If runRunning === true:                        │
  │     → Call window.scriptOps.kill(worktreeId)       │
  │     → Wait for kill to complete                    │
  │     → Update script store (runRunning = false)     │
  │                                                   │
  │  3. Proceed with existing archive flow             │
  │     → window.worktreeOps.delete({ archive: true }) │
  └──────────────────────────────────────────────────┘

  No user confirmation needed for the kill —
  archiving is already a destructive action that
  the user has confirmed. Killing the task is an
  implicit prerequisite.
```

#### 1.3 Implementation

**A. Add task stop logic to `archiveWorktree` in `useWorktreeStore.ts`:**

Before the existing `window.worktreeOps.delete()` call, check for a running process and kill it:

```typescript
// Check if a run process is alive for this worktree
const scriptState = useScriptStore.getState().scriptStates[worktreeId]
if (scriptState?.runRunning) {
  try {
    await window.scriptOps.kill(worktreeId)
    useScriptStore.getState().setRunRunning(worktreeId, false)
  } catch {
    // Log but don't block archive — the process may have already exited
  }
}
```

**B. Also stop any active OpenCode sessions for the worktree** — if the worktree has active streaming sessions, those should be interrupted too. The archive flow already handles session cleanup (the worktree is marked archived in DB), but lingering OpenCode processes may continue. Add a call to abort streaming:

```typescript
// Abort any active OpenCode sessions for this worktree
const sessionIds = useSessionStore.getState().sessionsByWorktree.get(worktreeId) || []
for (const sessionId of sessionIds) {
  const status = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
  if (status?.status === 'working' || status?.status === 'planning') {
    try {
      await window.opencodeOps.abort(worktreePath, sessionId)
    } catch {
      // Non-critical — session may already be idle
    }
  }
}
```

#### 1.4 Files to Modify

| File                                          | Change                                                            |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `src/renderer/src/stores/useWorktreeStore.ts` | Add kill + abort logic before archive in `archiveWorktree` action |

---

### 2. Skill Card UI

#### 2.1 Current State

The `mcp_skill` (or `Skill`) tool has **no dedicated renderer**. The `TOOL_RENDERERS` map in `ToolCard.tsx` (lines 181-201) and the `getToolRenderer()` fallback function (lines 204-229) do not match any skill-related tool name. As a result, skill tool calls fall through to `FallbackToolView.tsx`, which renders a yellow "TODO" badge, the raw JSON input, and truncated output text (`src/renderer/src/components/sessions/tools/FallbackToolView.tsx`).

The skill tool input has a simple structure: `{ "name": "executing-plans" }`. The output is a markdown document wrapped in `<skill_content name="...">` tags containing the skill's instructions and workflows.

Tool views are registered in `ToolCard.tsx` via the `TOOL_RENDERERS` record and the `getToolRenderer()` function. File operations (read, write, edit) use the `CompactFileToolCard` layout with +/- expand/collapse buttons. Non-file tools use a standard `ToolCard` wrapper with collapsible content.

#### 2.2 New Design

```
Skill card UI:

  Collapsed state (default):
  ┌──────────────────────────────────────────────────┐
  │ ⚡ Skill   executing-plans                    [+] │
  └──────────────────────────────────────────────────┘

  Expanded state (after clicking +):
  ┌──────────────────────────────────────────────────┐
  │ ⚡ Skill   executing-plans                    [-] │
  ├──────────────────────────────────────────────────┤
  │                                                   │
  │  # Executing Plans                                │
  │                                                   │
  │  ## Overview                                      │
  │  Load plan, review critically, execute tasks      │
  │  in batches, report for review between batches.   │
  │                                                   │
  │  **Core principle:** Batch execution with         │
  │  checkpoints for architect review.                │
  │  ...                                              │
  └──────────────────────────────────────────────────┘

  Design notes:
  - Uses the CompactFileToolCard pattern (single-line
    header with +/- toggle, expandable content area)
  - Icon: Zap (lightning bolt) from lucide-react,
    rendered in yellow/amber to suggest "power-up"
  - Label: "Skill" (static text)
  - Info: skill name from input.name (e.g., "executing-plans")
  - Expanded content: parse output to extract markdown
    between <skill_content> tags, render with MarkdownRenderer
  - If output is empty (still loading), show Loader2 spinner
```

#### 2.3 Implementation

**A. Create `SkillToolView.tsx`** (`src/renderer/src/components/sessions/tools/SkillToolView.tsx`):

```tsx
import { useMemo } from 'react'
import { MarkdownRenderer } from '../MarkdownRenderer'

interface SkillToolViewProps {
  input: Record<string, unknown>
  output: string
}

export function SkillToolView({ input, output }: SkillToolViewProps) {
  const skillName = (input?.name as string) || 'unknown'

  // Extract content between <skill_content> tags
  const markdownContent = useMemo(() => {
    if (!output) return ''
    const match = output.match(/<skill_content[^>]*>([\s\S]*?)<\/skill_content>/)
    if (match) return match[1].trim()
    // Fallback: render entire output if no tags found
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

**B. Register in `ToolCard.tsx`** — add to `TOOL_RENDERERS` and `getToolRenderer()`:

```typescript
// In TOOL_RENDERERS (line ~201):
Skill: SkillToolView,
mcp_skill: SkillToolView,

// In getToolRenderer() fallback (before the final return):
if (lower.includes('skill')) return SkillToolView
```

**C. Add skill to `CollapsedContent`** in `ToolCard.tsx` — define the collapsed header content:

In the `CollapsedContent` component, add a case for skill tools that shows the `Zap` icon, "Skill" label, and skill name:

```typescript
// In CollapsedContent component:
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

**D. Route skill tools through `CompactFileToolCard`** — update the `isFileOperation()` function or add a separate `isSkillOperation()` check in the main `ToolCard` component to route skill tools to the compact card layout:

```typescript
// In ToolCard component render:
const isSkill = lower === 'skill' || lower === 'mcp_skill' || lower.includes('skill')
if (isFileOperation(toolUse.name) || isSkill) {
  return <CompactFileToolCard toolUse={toolUse} cwd={cwd} />
}
```

#### 2.4 Files to Modify

| File                                                           | Change                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/renderer/src/components/sessions/tools/SkillToolView.tsx` | **New file**: skill card renderer with markdown content         |
| `src/renderer/src/components/sessions/ToolCard.tsx`            | Register SkillToolView, add collapsed content, route to compact |

---

### 3. PR to GitHub

#### 3.1 Current State

There is no PR creation functionality in Hive. The git integration (`GitPushPull.tsx`, `GitStatusPanel.tsx`) supports push, pull, merge, and branch management, but not pull request creation.

Remote tracking information is available through `GitBranchInfo.tracking` (e.g., `origin/main`) in `useGitStore.ts` (line 19). The system knows which remote branch a worktree tracks but has **no IPC endpoint to fetch the remote URL** (e.g., `git remote get-url origin`) or detect whether the remote is GitHub specifically.

Session creation with a pending message is already implemented — `GitStatusPanel.tsx` (lines 335-376) creates review sessions with `setPendingMessage()` which auto-sends on session mount. This pattern can be reused for PR creation.

Branch listing with remote branches is available via `window.gitOps.listBranchesWithStatus()` which returns branches with `isRemote`, `isCheckedOut`, and `worktreePath` fields.

#### 3.2 New Design

```
PR-to-GitHub flow:

  ┌───────────────────────────────────────────────────┐
  │ GitPushPull toolbar area                           │
  │                                                    │
  │  [Push ↑] [Pull ↓] [Merge]  [PR ▸ origin/main ▾] │
  │                                │        │          │
  │                                │        └─ dropdown│
  │                                │           to pick │
  │                                │           target  │
  │                                │           branch  │
  │                                └── creates new     │
  │                                    session with    │
  │                                    PR prompt       │
  └───────────────────────────────────────────────────┘

  Preconditions (checked once per worktree per app launch):
  1. Remote exists (worktree has a remote configured)
  2. Remote URL contains "github.com"
  → Persisted in-memory (useGitStore or useWorktreeStore)
  → PR button only shown when both conditions are true

  Remote detection flow:
  ┌──────────────────────────────────────────────────┐
  │ On worktree selection (first time after launch):  │
  │                                                   │
  │  1. Call new IPC: git:getRemoteUrl(worktreePath)  │
  │  2. Response: { url: "git@github.com:org/repo" }  │
  │  3. Check if url contains "github.com"             │
  │  4. Store { hasRemote, isGitHub } in memory        │
  │  5. Skip this check on subsequent selections       │
  └──────────────────────────────────────────────────┘

  Target branch selection:
  - Default: the tracking branch (e.g., origin/main)
  - Dropdown: all remote branches from listBranchesWithStatus()
  - Stored per worktree in memory

  PR creation flow:
  ┌──────────────────────────────────────────────────┐
  │ User clicks PR button:                            │
  │                                                   │
  │  1. Create new session in the worktree             │
  │  2. Set session to build mode                      │
  │  3. Set pending message:                           │
  │     "Create a pull request to {targetBranch}.      │
  │      Use `gh pr create` to create the PR.          │
  │      Base the PR title and description on the      │
  │      git diff between HEAD and {targetBranch}."    │
  │  4. Session auto-sends the prompt                  │
  │  5. AI agent runs gh pr create with details        │
  └──────────────────────────────────────────────────┘
```

#### 3.3 Implementation

**A. Add `getRemoteUrl` IPC endpoint** in `src/main/ipc/git-file-handlers.ts`:

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

**B. Expose in preload** (`src/preload/index.ts`):

```typescript
getRemoteUrl: (worktreePath: string, remote?: string) =>
  ipcRenderer.invoke('git:getRemoteUrl', { worktreePath, remote })
```

**C. Add type declaration** (`src/preload/index.d.ts`):

```typescript
getRemoteUrl(worktreePath: string, remote?: string): Promise<{
  success: boolean
  url: string | null
  remote: string | null
  error?: string
}>
```

**D. Add GitHub detection state to `useGitStore`:**

```typescript
interface GitState {
  // ... existing fields
  remoteInfo: Map<string, { hasRemote: boolean; isGitHub: boolean; url: string | null }>
  prTargetBranch: Map<string, string> // worktreeId → target branch

  checkRemoteInfo: (worktreeId: string, worktreePath: string) => Promise<void>
  setPrTargetBranch: (worktreeId: string, branch: string) => void
}
```

**E. Call `checkRemoteInfo` on worktree selection** — in `AppLayout.tsx` or the worktree selection handler, trigger the check the first time a worktree is selected after app launch:

```typescript
useEffect(() => {
  if (!selectedWorktreeId || !selectedWorktreePath) return
  const info = useGitStore.getState().remoteInfo.get(selectedWorktreeId)
  if (!info) {
    useGitStore.getState().checkRemoteInfo(selectedWorktreeId, selectedWorktreePath)
  }
}, [selectedWorktreeId, selectedWorktreePath])
```

**F. Add PR button and target branch dropdown to `GitPushPull.tsx`:**

Render a "PR" button next to the existing push/pull buttons. The button is only visible when `remoteInfo.isGitHub` is true. Next to it, a small dropdown shows the current target branch and allows switching to any remote branch.

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
          <Button size="sm" variant="ghost" className="text-xs text-muted-foreground">
            → {prTargetBranch || branchInfo?.tracking || 'origin/main'}
            <ChevronDown className="h-3 w-3 ml-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
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

**G. Implement `handleCreatePR`:**

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

  // Switch to the new session tab
  setActiveSession(session.id)
}
```

#### 3.4 Files to Modify

| File                                              | Change                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `src/main/ipc/git-file-handlers.ts`               | Add `git:getRemoteUrl` IPC handler                                   |
| `src/main/services/git-service.ts`                | Add `getRemoteUrl()` method (optional, may go directly in handler)   |
| `src/preload/index.ts`                            | Expose `getRemoteUrl` in `gitOps` namespace                          |
| `src/preload/index.d.ts`                          | Type declaration for `getRemoteUrl`, PR-related types                |
| `src/renderer/src/stores/useGitStore.ts`          | Add `remoteInfo` map, `prTargetBranch` map, `checkRemoteInfo` action |
| `src/renderer/src/components/git/GitPushPull.tsx` | Add PR button with target branch dropdown                            |

---

### 4. Permission Requested Status in Sidebar

#### 4.1 Current State

Permission requests are tracked per-session in `usePermissionStore.ts` via `pendingBySession: Map<string, PermissionRequest[]>`. When a `permission.asked` event arrives, the permission is added to the store.

For the **active session**, the `PermissionPrompt` component renders inline above the input area (`SessionView.tsx`, lines 2399-2406). The textarea is disabled with a "Waiting for permission response..." placeholder (lines 2460-2462).

For **background sessions**, the global listener (`useOpenCodeGlobalListener.ts`) processes `permission.asked` events but does **not** set any worktree status. The permission sits in the store silently — the sidebar shows no indication that a background session needs attention.

The `SessionStatusType` type (`useWorktreeStatusStore.ts`, line 4) supports `'working' | 'planning' | 'answering' | 'unread' | 'completed'`. There is no `'permission'` status. The `'answering'` status (amber-colored "Answer questions" text in the sidebar) is the closest parallel — it alerts the user that a session needs input.

#### 4.2 New Design

```
Permission status in sidebar:

  ┌──────────────────────────────────────────────────┐
  │ ▶ Project A                                       │
  │   ├ main         Ready                            │
  │   └ feature-x    ⚠ Permission requested          │
  │                   (amber, same as "Answer         │
  │                    questions" but different text)  │
  └──────────────────────────────────────────────────┘

  Status priority (updated):
  1. 'answering'    → "Answer questions"   (amber)
  2. 'permission'   → "Permission requested" (amber)
  3. 'planning'     → "Planning"            (blue)
  4. 'working'      → "Working"             (primary)
  5. 'completed'    → "{Word} for {duration}" (orange)
  6. 'unread'       → "Ready" with blue dot
  7. null           → "Ready"

  The 'permission' status uses the same amber color
  and AlertCircle icon as 'answering' to maintain
  visual consistency for "user action needed" states.

  This works for BOTH visible and non-visible sessions
  because the global listener handles background events.
```

#### 4.3 Implementation

**A. Add `'permission'` to `SessionStatusType`** in `useWorktreeStatusStore.ts`:

```typescript
type SessionStatusType =
  | 'working'
  | 'planning'
  | 'answering'
  | 'permission'
  | 'unread'
  | 'completed'
```

**B. Set permission status in the global listener** (`useOpenCodeGlobalListener.ts`):

When a `permission.asked` event arrives for a background session, set the status:

```typescript
// In the permission.asked handler (around line 73-81):
if (event.type === 'permission.asked') {
  const request = event as PermissionRequest
  usePermissionStore.getState().addPermission(sessionId, request)
  // Set sidebar status
  useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'permission')
  return
}
```

**C. Clear permission status when permission is replied** — in both the global listener and SessionView:

```typescript
// In permission.replied handler:
if (event.type === 'permission.replied') {
  usePermissionStore.getState().removePermission(sessionId, request.id)
  // If no more pending permissions, revert status
  const remaining = usePermissionStore.getState().pendingBySession.get(sessionId)
  if (!remaining || remaining.length === 0) {
    // Revert to working/planning based on current mode
    const mode = useSessionStore.getState().getSessionMode(sessionId)
    useWorktreeStatusStore
      .getState()
      .setSessionStatus(sessionId, mode === 'plan' ? 'planning' : 'working')
  }
}
```

**D. Update priority in `getWorktreeStatus()`** (`useWorktreeStatusStore.ts`):

Add `'permission'` at the same priority level as `'answering'`:

```typescript
if (entry.status === 'answering' || entry.status === 'permission') {
  return entry.status
}
```

**E. Update `WorktreeItem.tsx`** to display the permission status:

```typescript
: worktreeStatus === 'permission'
  ? { displayStatus: 'Permission requested', statusClass: 'font-semibold text-amber-500' }
```

And the icon:

```tsx
{
  worktreeStatus === 'permission' && <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
}
```

**F. Update `SessionTabs.tsx`** to show the permission icon on tabs:

```tsx
{
  sessionStatus === 'permission' && <AlertCircle className="h-3 w-3 text-amber-500 flex-shrink-0" />
}
```

**G. Also handle permission.asked in SessionView for the active session** — set the permission status when a permission is asked on the currently visible session (in addition to the existing PermissionPrompt rendering):

The existing `useEffect` at SessionView lines 519-533 handles the `'answering'` status when a question appears. Add a similar effect for permissions:

```typescript
useEffect(() => {
  if (activePermission) {
    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'permission')
  } else {
    const currentStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
    if (currentStatus?.status === 'permission') {
      // Revert to appropriate mode
      const mode = getSessionMode(sessionId)
      useWorktreeStatusStore
        .getState()
        .setSessionStatus(sessionId, mode === 'plan' ? 'planning' : 'working')
    }
  }
}, [activePermission, sessionId])
```

#### 4.4 Files to Modify

| File                                                     | Change                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/renderer/src/stores/useWorktreeStatusStore.ts`      | Add `'permission'` to `SessionStatusType`, update priority aggregation  |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`    | Set `'permission'` status on `permission.asked` for background sessions |
| `src/renderer/src/components/sessions/SessionView.tsx`   | Set `'permission'` status for active session, clear on reply            |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Display "Permission requested" text and icon                            |
| `src/renderer/src/components/sessions/SessionTabs.tsx`   | Show permission icon on tabs                                            |

---

### 5. Merge Conflict Header Button

#### 5.1 Current State

Merge conflicts are handled in `GitStatusPanel.tsx` (lines 174-200). Files with `status === 'C'` are categorized as `conflictedFiles`. A "CONFLICTS" button (lines 427-443) with an `AlertTriangle` icon appears in the git panel header, and a `handleFixConflicts` callback (lines 335-376) creates a new session named `Merge Conflicts -- {branchName}` with the pending message `'Fix merge conflicts'`.

However, this button is **only visible inside the git panel** — it does not appear in the main header bar. If the git panel is collapsed or the user is focused on a session, there is no persistent, visible indicator that merge conflicts exist. The user must navigate to the git panel to discover and act on conflicts.

When a merge operation fails with conflicts, a toast is shown (`GitPushPull.tsx`, line 165-170), but toasts are transient and easily missed.

The main header (`Header.tsx`, 94 lines) shows the project name, branch name, session history button, settings button, and sidebar toggle. There is no git-related status or action buttons in the header.

#### 5.2 New Design

```
Merge conflict button in header:

  ┌─────────────────────────────────────────────────────────┐
  │ 🐝 Project A / feature-x    [Fix conflicts] [⏰] [⚙] [▯]│
  │                               ▲ bright, colorful        │
  │                               shows only when           │
  │                               conflicts exist           │
  └─────────────────────────────────────────────────────────┘

  Button design:
  - Background: red/destructive variant or bright amber
  - Text: "Fix conflicts"
  - Icon: AlertTriangle (to match git panel)
  - Position: between QuickActions and History button
  - Visible ONLY when the current worktree has conflicted files
  - Clicking creates a new build-mode session with
    "Fix merge conflicts" prompt (same as GitStatusPanel)

  State tracking:
  - useGitStore gets a new `hasConflicts` flag per worktree
  - Updated whenever git statuses are refreshed
  - The flag is derived from the existing file status data
    (any file with status === 'C')
```

#### 5.3 Implementation

**A. Add `hasConflicts` state to `useGitStore`:**

```typescript
interface GitState {
  // ... existing fields
  conflictsByWorktree: Record<string, boolean> // worktreeId → has conflicts
  setHasConflicts: (worktreeId: string, hasConflicts: boolean) => void
}
```

**B. Update conflict detection on status refresh.** Wherever `refreshStatuses()` processes git file statuses, compute whether any file has `status === 'C'` and update the store:

```typescript
// After processing file statuses:
const hasConflicts = files.some((f) => f.status === 'C')
set((state) => ({
  conflictsByWorktree: {
    ...state.conflictsByWorktree,
    [worktreeId]: hasConflicts
  }
}))
```

**C. Add conflict button to `Header.tsx`:**

```tsx
const hasConflicts = useGitStore((state) => state.conflictsByWorktree[selectedWorktreeId] ?? false)

// Between QuickActions and History button:
{
  hasConflicts && (
    <Button
      size="sm"
      variant="destructive"
      className="h-7 text-xs font-semibold animate-pulse"
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

**D. Implement `handleFixConflicts` in Header** — reuse the same pattern as `GitStatusPanel.tsx`:

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

#### 5.4 Files to Modify

| File                                            | Change                                                     |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `src/renderer/src/stores/useGitStore.ts`        | Add `conflictsByWorktree` state, update on status refresh  |
| `src/renderer/src/components/layout/Header.tsx` | Add "Fix conflicts" button, implement `handleFixConflicts` |

---

### 6. Render Added Files as Plain Content

#### 6.1 Current State

When a user clicks a file in the git changes view, `handleViewDiff` (in `ChangesView.tsx`, line 213-226, and `GitStatusPanel.tsx`, line 251-263) calls `setActiveDiff()` with `isUntracked: file.status === '?'`.

For untracked files (`status === '?'`), `InlineDiffViewer.tsx` (line 48) passes `isUntracked: true` to `window.gitOps.getDiff()`, which calls `gitService.getUntrackedFileDiff()` instead of `gitService.getDiff()`. This method reads the entire file and formats it as a **synthetic diff** — all lines appear as additions (green `+` prefix). The status label shows "New file" (line 130).

However, for files with status `'A'` (staged as new/added), `isUntracked` is set to `false` because the check is `file.status === '?'`. These files are shown as a regular diff, which is fine for staged files that have a "before" state (empty) and "after" state.

The user's request is specifically about files that are **added and not changed** — meaning files that are newly added (either untracked `'?'` or staged-added `'A'`) should render their content as a normal file view rather than showing diff formatting (green lines with `+` prefixes).

#### 6.2 New Design

```
Plain content rendering for new files:

  Current behavior (untracked/added files):
  ┌──────────────────────────────────────────────────┐
  │ file.ts                    New file | Unstaged    │
  ├──────────────────────────────────────────────────┤
  │ + import { foo } from 'bar'                       │
  │ + export function hello() {                       │
  │ +   return 'world'                                │
  │ + }                                               │
  └──────────────────────────────────────────────────┘
  (All lines shown as additions in green — noisy for
   files that have never had a previous version)

  New behavior:
  ┌──────────────────────────────────────────────────┐
  │ file.ts                    New file | Unstaged    │
  ├──────────────────────────────────────────────────┤
  │  1 │ import { foo } from 'bar'                    │
  │  2 │ export function hello() {                    │
  │  3 │   return 'world'                             │
  │  4 │ }                                            │
  └──────────────────────────────────────────────────┘
  (Rendered as plain file content with line numbers,
   syntax highlighting, normal text color — identical
   to how ReadToolView renders file content)

  Detection:
  - isUntracked === true (status '?'), OR
  - file status === 'A' (added, not yet in history)
  Both should render as plain content.
```

#### 6.3 Implementation

**A. Add `isNewFile` flag to the diff data model.** Update the `setActiveDiff` call sites to pass a new flag:

```typescript
// In ChangesView.tsx and GitStatusPanel.tsx handleViewDiff:
const isNewFile = file.status === '?' || file.status === 'A'
setActiveDiff({
  worktreePath,
  filePath: file.path,
  staged: file.staged,
  isUntracked: file.status === '?',
  isNewFile
})
```

**B. Add `isNewFile` to the `DiffTab` type** in `useFileViewerStore.ts`:

```typescript
interface DiffTab {
  // ... existing fields
  isNewFile?: boolean
}
```

**C. Update `InlineDiffViewer.tsx`** to render plain content when `isNewFile` is true:

Instead of parsing and rendering diff output, read the file content and display it with syntax highlighting and line numbers (similar to `ReadToolView`):

```typescript
// When isNewFile is true, fetch raw file content instead of diff:
if (isNewFile) {
  const content = await window.gitOps.getFileContent(worktreePath, filePath)
  setFileContent(content)
  return
}
// ... existing diff fetch logic
```

Add a rendering branch:

```tsx
{isNewFile && fileContent ? (
  <div className="overflow-auto">
    <SyntaxHighlighter
      language={getLanguageFromPath(filePath)}
      style={oneDark}
      showLineNumbers
      customStyle={{ margin: 0, background: 'transparent' }}
    >
      {fileContent}
    </SyntaxHighlighter>
  </div>
) : (
  // ... existing diff rendering
)}
```

**D. If `getFileContent` IPC does not exist**, add it:

```typescript
// git-file-handlers.ts:
ipcMain.handle('git:getFileContent', async (_event, { worktreePath, filePath }) => {
  const fullPath = path.join(worktreePath, filePath)
  const content = await fs.readFile(fullPath, 'utf-8')
  return { success: true, content }
})
```

#### 6.4 Files to Modify

| File                                                    | Change                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `src/renderer/src/components/file-tree/ChangesView.tsx` | Pass `isNewFile` flag when setting active diff                |
| `src/renderer/src/components/git/GitStatusPanel.tsx`    | Pass `isNewFile` flag when setting active diff                |
| `src/renderer/src/stores/useFileViewerStore.ts`         | Add `isNewFile` to diff tab interface                         |
| `src/renderer/src/components/diff/InlineDiffViewer.tsx` | Render plain content with syntax highlighting for new files   |
| `src/main/ipc/git-file-handlers.ts`                     | Add `git:getFileContent` IPC handler (if not already present) |
| `src/preload/index.ts`                                  | Expose `getFileContent` in `gitOps` namespace                 |
| `src/preload/index.d.ts`                                | Type declaration for `getFileContent`                         |

---

### 7. Grep Tool UI Restyle

#### 7.1 Current State

The `GrepToolView` (`src/renderer/src/components/sessions/tools/GrepToolView.tsx`, 120 lines) renders search results in a custom layout with pattern highlighting, match count, and truncation. It is also used for `Glob` tool results (`ToolCard.tsx`, lines 190-191).

The tool uses a standard `ToolCard` wrapper (not `CompactFileToolCard`). The collapsed header shows the tool name (`Grep` / `Glob`) via `CollapsedContent` in `ToolCard.tsx`. The name "Grep" is technical and non-intuitive for users.

The Read and Edit tools use the `CompactFileToolCard` layout (lines 585-587 in `ToolCard.tsx`) which provides:

- A single-line header with an icon, label, and file path
- A +/- toggle button (Plus when collapsed, Minus when expanded)
- A Loader2 spinner while the tool is running
- Expandable content area for the full tool output

#### 7.2 New Design

```
Grep tool restyled as "Search":

  Collapsed state:
  ┌──────────────────────────────────────────────────┐
  │ 🔍 Search   "pattern" in src/   (12 matches) [+] │
  └──────────────────────────────────────────────────┘

  Expanded state:
  ┌──────────────────────────────────────────────────┐
  │ 🔍 Search   "pattern" in src/   (12 matches) [-] │
  ├──────────────────────────────────────────────────┤
  │  src/main/index.ts:42                             │
  │  src/renderer/app.tsx:15                          │
  │  src/renderer/app.tsx:28                          │
  │  ...                                              │
  └──────────────────────────────────────────────────┘

  Changes from current:
  1. Name: "Grep" → "Search" (and "Glob" → "Find files")
  2. Layout: Standard card → CompactFileToolCard pattern
  3. Icon: Search icon (magnifying glass) from lucide-react
  4. Collapsed info: pattern + path + match count
  5. +/- toggle button for expand/collapse
  6. Same content rendering inside (pattern highlighting,
     truncation with "Show all" button)
```

#### 7.3 Implementation

**A. Route Grep/Glob tools through `CompactFileToolCard`** — update `isFileOperation()` in `ToolCard.tsx` or add a separate check:

```typescript
function isSearchOperation(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'grep' || lower === 'mcp_grep' || lower === 'glob' || lower === 'mcp_glob'
    || lower.includes('grep') || lower.includes('glob')
}

// In ToolCard render:
if (isFileOperation(toolUse.name) || isSearchOperation(toolUse.name)) {
  return <CompactFileToolCard toolUse={toolUse} cwd={cwd} />
}
```

**B. Update `CollapsedContent`** in `ToolCard.tsx` for search operations:

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
      {matchCount > 0 && (
        <span className="text-muted-foreground">({matchCount} matches)</span>
      )}
    </>
  )
}

if (lower.includes('glob') || lower === 'mcp_glob') {
  const pattern = (toolUse.input as Record<string, unknown>)?.pattern as string
  const matchCount = toolUse.output?.split('\n').filter(Boolean).length || 0
  return (
    <>
      <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">Find files</span>
      <span className="truncate">{pattern}</span>
      {matchCount > 0 && (
        <span className="text-muted-foreground">({matchCount} files)</span>
      )}
    </>
  )
}
```

**C. The `GrepToolView` content renderer remains the same** — it already handles pattern highlighting, result display, and truncation. Only the outer chrome (card layout, header, expand/collapse) changes to match the compact pattern.

#### 7.4 Files to Modify

| File                                                | Change                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/ToolCard.tsx` | Route grep/glob to compact layout, update collapsed content headers |

---

### 8. /clear Built-in Command

#### 8.1 Current State

Built-in slash commands are defined in `SessionView.tsx` (lines 47-60) as the `BUILT_IN_SLASH_COMMANDS` array with `/undo` and `/redo` entries. These are merged with SDK commands in the `SlashCommandPopover` and routed in `handleSend` (lines 1822-1878) before SDK command matching.

Session tab management is handled by `useSessionStore.ts`:

- `createSession(worktreeId, projectId)` creates a new session and sets it as active (lines 161-232)
- `closeTab(worktreeId, sessionId)` removes a session tab from the tab order (but does not delete the session from DB)
- `activeSessionId` tracks the currently visible session

The input field focus is managed via `textareaRef` in `SessionView.tsx`.

#### 8.2 New Design

```
/clear command flow:

  User types "/clear" and presses Enter:

  ┌──────────────────────────────────────────────────┐
  │ 1. Close the current session tab                  │
  │    (same as clicking X on the tab)                │
  │                                                   │
  │ 2. Create a new session in the same worktree      │
  │    (same as clicking + on the tab bar)             │
  │                                                   │
  │ 3. Focus the text input field of the new session   │
  └──────────────────────────────────────────────────┘

  The command does NOT appear as a user message in chat.
  It executes immediately (same as /undo and /redo).

  The closed session is NOT deleted — it remains in
  session history and can be accessed via Cmd+K.

  SlashCommandPopover entry:
  ┌─────────────────────────────────────────────────┐
  │ /clear   Close current tab and open a new one    │
  └─────────────────────────────────────────────────┘
```

#### 8.3 Implementation

**A. Add `/clear` to `BUILT_IN_SLASH_COMMANDS`** in `SessionView.tsx`:

```typescript
{
  name: 'clear',
  description: 'Close current tab and open a new one',
  template: '/clear',
  builtIn: true
}
```

**B. Handle `/clear` in `handleSend`** — add alongside the existing `/undo` and `/redo` handling:

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
    // Focus will happen automatically when the new SessionView mounts
    // and the textarea ref is set
  }

  return
}
```

**C. Ensure focus on new session** — the new `SessionView` should auto-focus its textarea on mount. Check if this already happens (via `autoFocus` or a `useEffect`). If not, add:

```typescript
useEffect(() => {
  if (textareaRef.current) {
    textareaRef.current.focus()
  }
}, []) // On mount
```

#### 8.4 Files to Modify

| File                                                   | Change                                                    |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add `/clear` to built-in commands, handle in `handleSend` |

---

### 9. "Plan Ready" Status for Completed Planning Sessions

#### 9.1 Current State

When a session finishes streaming, the status transitions through `'completed'` (showing "{Word} for {duration}") and then to `null` (showing "Ready") after a timeout or when the next streaming starts.

The `'completed'` status in `useWorktreeStatusStore.ts` includes metadata (`word`, `durationMs`) but does **not** track which mode the session was in when it completed. Whether the session was in plan mode or build mode, the completion badge shows the same "{Word} for {duration}" text, and after the badge clears, both show "Ready".

The session mode (`'plan' | 'build'`) is tracked per-session in `useSessionStore.ts` via `modeBySession: Map<string, SessionMode>` (line 32). The mode is accessible via `getSessionMode(sessionId)` (lines 473-474).

When streaming starts, `handleSend` in `SessionView.tsx` (lines 1908-1912) sets the worktree status based on mode: plan → `'planning'`, build → `'working'`. But there is no corresponding mode-aware logic when streaming completes.

#### 9.2 New Design

```
Plan-ready status:

  Current completion flow:
  Planning ──▶ "Crafted for 45s" ──▶ Ready

  New completion flow:
  Planning ──▶ "Crafted for 45s" ──▶ Plan ready
  Working  ──▶ "Crafted for 45s" ──▶ Ready (unchanged)

  "Plan ready" tells the user: "This session was
  planning and has finished — your plan is waiting
  for review."

  Implementation approach:
  Track the session mode at completion time in the
  completed status entry. When the completion badge
  clears, use the stored mode to decide whether to
  show "Ready" or "Plan ready".

  Alternatively: don't add a new status type — just
  change the default display text. When the status is
  null (no active status), check if the session's mode
  is 'plan' and show "Plan ready" instead of "Ready".

  Visual design:
  ┌──────────────────────────────────────────────────┐
  │ ▶ Project A                                       │
  │   ├ main         Ready                            │
  │   └ feature-x    Plan ready                       │
  │                  (text-blue-400, same as Planning) │
  └──────────────────────────────────────────────────┘
```

#### 9.3 Implementation

**A. Add `completionMode` to `SessionStatusEntry`** in `useWorktreeStatusStore.ts`:

```typescript
interface SessionStatusEntry {
  status: SessionStatusType
  timestamp: number
  word?: string
  durationMs?: number
  completionMode?: 'plan' | 'build' // mode when session completed
}
```

**B. Store the mode when setting completed status.** In `SessionView.tsx` and `useOpenCodeGlobalListener.ts`, when setting the `'completed'` status, include the session mode:

```typescript
const mode = useSessionStore.getState().getSessionMode(sessionId)
statusStore.setSessionStatus(sessionId, 'completed', {
  word,
  durationMs,
  completionMode: mode
})
```

**C. When the completed badge clears** (after timeout), instead of clearing to `null`, set a mode-aware idle state. Update the timeout callback:

```typescript
setTimeout(() => {
  const current = statusStore.sessionStatuses[sessionId]
  if (current?.status === 'completed') {
    if (current.completionMode === 'plan') {
      // Keep a 'plan_ready' indicator — use a special status or metadata
      statusStore.setSessionStatus(sessionId, 'plan_ready')
    } else {
      statusStore.clearSessionStatus(sessionId)
    }
  }
}, 30_000)
```

**D. Add `'plan_ready'` to `SessionStatusType`** (or handle it as display logic):

Option 1 — New status type (cleaner):

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

Option 2 — Display logic only (simpler, no new status): In `WorktreeItem.tsx`, when status is `null`, check if the most recent completed session in this worktree was in plan mode. This avoids a new status type but requires more lookups.

**Recommended: Option 1** for clarity.

**E. Update `WorktreeItem.tsx`** display:

```typescript
: worktreeStatus === 'plan_ready'
  ? { displayStatus: 'Plan ready', statusClass: 'font-semibold text-blue-400' }
```

Icon for plan_ready — use a subtle indicator (e.g., `Map` icon in blue, matching the plan mode toggle):

```tsx
{
  worktreeStatus === 'plan_ready' && <Map className="h-3.5 w-3.5 text-blue-400 shrink-0" />
}
```

**F. Clear `plan_ready` when new streaming starts** — in the `handleSend` flow (SessionView lines 1908-1912), the status is already overwritten to `'planning'` or `'working'`, so `'plan_ready'` will be naturally replaced.

**G. Update `getWorktreeStatus()` priority** — `'plan_ready'` should have very low priority (just above `null`):

```typescript
// Priority order in getWorktreeStatus():
// answering > permission > planning > working > completed > plan_ready > unread > null
```

#### 9.4 Files to Modify

| File                                                     | Change                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/renderer/src/stores/useWorktreeStatusStore.ts`      | Add `'plan_ready'` status, `completionMode` field, update priority |
| `src/renderer/src/components/sessions/SessionView.tsx`   | Include session mode when setting completed status                 |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`    | Include session mode when setting completed status for bg sessions |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Display "Plan ready" text and Map icon                             |

---

## Summary of All Files to Modify

| Feature               | File                                                           | Change                                                     |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| Archive Task Stop     | `src/renderer/src/stores/useWorktreeStore.ts`                  | Kill running tasks/sessions before archive                 |
| Skill Card            | `src/renderer/src/components/sessions/tools/SkillToolView.tsx` | **New file**: skill card with markdown rendering           |
| Skill Card            | `src/renderer/src/components/sessions/ToolCard.tsx`            | Register SkillToolView, add collapsed content, route       |
| PR to GitHub          | `src/main/ipc/git-file-handlers.ts`                            | Add `git:getRemoteUrl` IPC handler                         |
| PR to GitHub          | `src/preload/index.ts`                                         | Expose `getRemoteUrl` in `gitOps`                          |
| PR to GitHub          | `src/preload/index.d.ts`                                       | Type declarations for `getRemoteUrl`                       |
| PR to GitHub          | `src/renderer/src/stores/useGitStore.ts`                       | Add `remoteInfo`, `prTargetBranch`, `checkRemoteInfo`      |
| PR to GitHub          | `src/renderer/src/components/git/GitPushPull.tsx`              | PR button with target branch dropdown                      |
| Permission Status     | `src/renderer/src/stores/useWorktreeStatusStore.ts`            | Add `'permission'` status, update priority                 |
| Permission Status     | `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`          | Set permission status for background sessions              |
| Permission Status     | `src/renderer/src/components/sessions/SessionView.tsx`         | Set permission status for active session                   |
| Permission Status     | `src/renderer/src/components/worktrees/WorktreeItem.tsx`       | Display "Permission requested" text and icon               |
| Permission Status     | `src/renderer/src/components/sessions/SessionTabs.tsx`         | Permission icon on tabs                                    |
| Merge Conflict Button | `src/renderer/src/stores/useGitStore.ts`                       | Add `conflictsByWorktree` state                            |
| Merge Conflict Button | `src/renderer/src/components/layout/Header.tsx`                | "Fix conflicts" button                                     |
| Plain File Rendering  | `src/renderer/src/components/file-tree/ChangesView.tsx`        | Pass `isNewFile` flag                                      |
| Plain File Rendering  | `src/renderer/src/components/git/GitStatusPanel.tsx`           | Pass `isNewFile` flag                                      |
| Plain File Rendering  | `src/renderer/src/stores/useFileViewerStore.ts`                | Add `isNewFile` to diff tab interface                      |
| Plain File Rendering  | `src/renderer/src/components/diff/InlineDiffViewer.tsx`        | Render plain content for new files                         |
| Plain File Rendering  | `src/main/ipc/git-file-handlers.ts`                            | Add `git:getFileContent` IPC handler                       |
| Plain File Rendering  | `src/preload/index.ts`                                         | Expose `getFileContent`                                    |
| Plain File Rendering  | `src/preload/index.d.ts`                                       | Type declaration for `getFileContent`                      |
| Grep UI Restyle       | `src/renderer/src/components/sessions/ToolCard.tsx`            | Route grep/glob to compact layout, rename to "Search"      |
| /clear Command        | `src/renderer/src/components/sessions/SessionView.tsx`         | Add `/clear` built-in command                              |
| Plan Ready Status     | `src/renderer/src/stores/useWorktreeStatusStore.ts`            | Add `'plan_ready'` status, `completionMode` field          |
| Plan Ready Status     | `src/renderer/src/components/sessions/SessionView.tsx`         | Include mode when setting completed status                 |
| Plan Ready Status     | `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`          | Include mode when setting completed status for bg sessions |
| Plan Ready Status     | `src/renderer/src/components/worktrees/WorktreeItem.tsx`       | Display "Plan ready" text and icon                         |

---

## Out of Scope

- Full GitHub PR dashboard or PR list viewer inside Hive
- PR review / approval workflow within the app
- Permission auto-approval rules or "always allow" persistence across sessions
- Merge conflict resolution UI (inline editor with conflict markers) — we delegate to AI
- File content editing in the plain file view (read-only)
- Glob tool result grouping or tree visualization
- Session deletion on `/clear` — closed tabs remain in history
- Plan ready status persistence to database — ephemeral only
- Custom PR templates or PR label/assignee selection

---

## Implementation Priority

| Sprint | Features                                                  | Rationale                                                                  |
| ------ | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1      | 1 (Archive Task Stop), 8 (/clear Command), 9 (Plan Ready) | Small, self-contained changes with no new files or IPC endpoints           |
| 2      | 2 (Skill Card), 7 (Grep Restyle)                          | UI-only changes in the tool rendering layer, one new file                  |
| 3      | 4 (Permission Status), 5 (Merge Conflict Button)          | Status system extensions, new state fields, moderate complexity            |
| 4      | 6 (Plain File Rendering)                                  | Touches diff viewer, file store, and may need new IPC endpoint             |
| 5      | 3 (PR to GitHub)                                          | Largest feature — new IPC endpoint, store state, UI components, AI session |

---

## Success Metrics

- Archiving a worktree with a running dev server kills the process before removing the worktree directory
- Skill tool calls render with a Zap icon, skill name, and expandable markdown content (no more "TODO" badge)
- PR button appears only for GitHub-backed worktrees and creates a session that successfully runs `gh pr create`
- Permission requests on background sessions show "Permission requested" in the sidebar within 1 second
- After a merge with conflicts, a red "Fix conflicts" button appears in the header and remains until conflicts are resolved
- Clicking a new/untracked file in git changes shows plain file content with line numbers and syntax highlighting
- Grep tool results display in the compact +/- card format with "Search" label and match count
- Typing `/clear` closes the current tab, opens a new one, and focuses the input field
- After a planning session completes, the sidebar shows "Plan ready" instead of "Ready"

---

## Testing Plan

| Test File                                     | Feature               | Validates                                                         |
| --------------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| `test/phase-18/archive-task-stop.test.ts`     | Archive Task Stop     | Kill called before archive, handles already-stopped processes     |
| `test/phase-18/skill-card.test.ts`            | Skill Card            | Renders skill name, parses output tags, expands/collapses         |
| `test/phase-18/pr-github.test.ts`             | PR to GitHub          | Remote detection, button visibility, session creation with prompt |
| `test/phase-18/permission-status.test.ts`     | Permission Status     | Status set on permission.asked, cleared on reply, sidebar shows   |
| `test/phase-18/merge-conflict-button.test.ts` | Merge Conflict Button | Button appears on conflicts, creates session, hidden when clear   |
| `test/phase-18/plain-file-rendering.test.ts`  | Plain File Rendering  | New files render as plain content, existing files still show diff |
| `test/phase-18/grep-restyle.test.ts`          | Grep UI Restyle       | Compact layout, "Search" label, +/- toggle, match count           |
| `test/phase-18/clear-command.test.ts`         | /clear Command        | Tab closed, new session created, input focused                    |
| `test/phase-18/plan-ready-status.test.ts`     | Plan Ready Status     | "Plan ready" shown after plan completion, cleared on new stream   |
