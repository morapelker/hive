# Hive — Phase 11 Product Requirements Document

## Overview

**Phase 11** focuses on **session title simplification, automatic branch renaming, worktree UX improvements, file sidebar redesign, and streaming correctness bugfixes**. The work spans ten items: replacing the custom Haiku-based title generator with the server's built-in title events, auto-renaming worktree branches when a title is first received, adding manual branch rename to the worktree context menu, auto-starting the first session when entering an empty worktree, allowing worktree creation from any branch, fixing session loading state being cleared on tab switch, redesigning the file/changes sidebar with a two-tab layout, fixing tool call results detaching across session switches, fixing streaming content bleeding across tabs, and minor UI text changes.

### Phase 11 Goals

- Simplify session title generation by removing the custom Haiku naming system and relying on the OpenCode server's built-in `session.updated` events for automatic title delivery
- Auto-rename worktree branches from the initial random city name to a canonicalized form of the first AI-generated title (unless the user has manually renamed the branch)
- Allow users to manually rename branches via the worktree context menu
- Auto-create the first session when entering a worktree with zero sessions, eliminating the "Click + to create one" dead state
- Enable worktree creation from any branch (not just the default branch), via the project context menu with a filterable branch picker
- Fix session loading state being incorrectly cleared when switching to a loading session tab
- Redesign the file sidebar with separate "Changes" and "Files" tabs — changes showing git operations, files showing a clean tree with filtering
- Fix tool call results appearing as detached entities after switching sessions mid-tool-execution
- Fix streaming content from one session rendering in another session's tab
- Remove the "Streaming..." blue text indicator and rename "Task" tool display to "Agent"

---

## Technical Additions

| Component                   | Technology                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Server-Side Title Events    | OpenCode SDK `session.updated` events, remove custom `generateSessionName` + Haiku naming callbacks  |
| Branch Auto-Rename          | `simple-git` `branch -m` command, canonicalization utility, DB update                                |
| Manual Branch Rename        | New `renameBranch()` in git-service, IPC channel, context menu entry in `WorktreeItem.tsx`           |
| Auto-Start First Session    | Modified `SessionTabs.tsx` auto-start logic: per-worktree zero-session check instead of project-wide |
| Worktree from Branch        | New `createWorktreeFromBranch()` in git-service, branch picker dialog, project context menu entry    |
| Session Loading State Fix   | Guard in session tab click handler to preserve `isStreaming` state on tab switch                     |
| File Sidebar Redesign       | New tabbed layout component wrapping existing `FileTree` and new `ChangesView` extraction            |
| Tool Call Result Detach Fix | Persist and restore pending tool call state across session switches via message part matching        |
| Streaming Cross-Tab Fix     | Scope stream subscriptions + streaming state to opencode session ID, not just hive session ID        |
| UI Text Changes             | Remove "Streaming..." span in `AssistantCanvas.tsx`, rename "Task" → "Agent" in `ToolCard.tsx`       |

---

## Features

### 1. Server-Side Session Titles (Replace Custom Haiku Naming)

#### 1.1 Current State

Hive currently implements its own title generation system that duplicates what the OpenCode server already does:

- **`src/main/services/opencode-service.ts` lines 1159-1231**: `generateSessionName(userMessage, worktreePath)` creates a temporary OpenCode session, sends a naming prompt to Claude Haiku (`claude-haiku-4-5-20251001`), collects streamed text via the `namingCallbacks` Map (lines 141-155), and resolves with a 10-second timeout (line 1194).

- **`src/main/services/opencode-service.ts` lines 1017-1049**: Event routing for naming callbacks — when `message.part.updated` arrives for a naming session, it collects text deltas and on `session.idle` resolves the collected name.

- **`src/renderer/src/components/sessions/SessionView.tsx` lines 1474-1502**: On the first user message, fires `window.opencodeOps.generateSessionName(trimmedValue, worktreePath)` as a fire-and-forget call, then updates the store via `useSessionStore.getState().updateSessionName(sessionId, result.name)`.

- **`src/main/ipc/opencode-handlers.ts` lines 142-163**: IPC handler `'opencode:generateSessionName'` bridges renderer to the opencode service.

- **`src/preload/index.ts` lines 675-679**: Exposes `generateSessionName` on `opencodeOps`.

- **`src/renderer/src/stores/useSessionStore.ts` lines 57-63**: Local `generateSessionName()` creates a timestamp-based name like `Session HH:MM` used at creation time (line 152).

Per the `TITLE_GENERATION.md` document (lines 243-250), the OpenCode server already handles title generation automatically:

> If your client talks to the OpenCode server via its API, **you don't need to implement title generation yourself**. The server handles it automatically when you send the first message via `POST /session/:sessionID/message`. The session title will be updated asynchronously and you'll receive the update through the session event stream (`session.updated` event). You only need to:
>
> - Display the title from the session object
> - Listen for `session.updated` events to refresh it
> - Provide UI for manual rename via `PATCH /session/:sessionID`

The entire custom naming system (temporary sessions, Haiku calls, naming callbacks, fire-and-forget triggers) is unnecessary overhead and should be removed.

#### 1.2 New Design

```
New Title Flow:

  1. Session created → local title: "New session - <ISO date>"
  2. User sends first message via prompt()
  3. Server automatically generates title (background LLM call)
  4. Server emits SSE: { type: "session.updated", properties: { ...session, title: "New title" } }
  5. Main process handleEvent() detects "session.updated" → forwards to renderer
  6. Renderer stream handler extracts title from session data → updates store
  7. UI re-renders with new title in tabs, history, etc.

  Manual rename (new):
  1. User double-clicks tab name or uses context menu "Rename"
  2. Inline text input appears
  3. User types new name → presses Enter
  4. Renderer calls window.opencodeOps.renameSession(opencodeSessionId, newTitle, worktreePath)
  5. Preload → IPC → Main → client.session.patch({ path: { id }, body: { title } })
  6. Server accepts → emits session.updated with new title
  7. Store updates → UI re-renders
```

**What to remove:**

- `generateSessionName(userMessage, worktreePath)` method from `opencode-service.ts`
- `NamingCallback` interface, `namingCallbacks` Map, and all naming callback event routing
- `generateSessionName` IPC handler
- `generateSessionName` preload exposure and type declarations
- `hasTriggeredNamingRef` and fire-and-forget naming call from `SessionView.tsx`
- Local `generateSessionName()` utility from `useSessionStore.ts`

**What to add:**

- Handle `session.updated` events in the stream handler to extract and apply the server-generated title
- New `renameSession` method in opencode-service using PATCH `/session/:sessionID`
- IPC handler, preload exposure, and type declarations for `renameSession`
- Store the `opencode_session_id` ↔ hive session mapping for title updates

#### 1.3 Implementation

**Main Process — Remove naming system** (`src/main/services/opencode-service.ts`):

Remove the following:

- Lines 141-155: `NamingCallback` interface and `namingCallbacks` Map declaration
- Lines 1017-1049: Naming callback event routing in `handleEvent()`
- Lines 1159-1231: `generateSessionName()` method entirely
- Any imports or helpers used exclusively by the naming system

Add `renameSession` method:

```typescript
/**
 * Rename a session via the OpenCode server PATCH endpoint.
 * This sets a manual title that the server will not overwrite.
 */
async renameSession(
  opencodeSessionId: string,
  title: string,
  worktreePath?: string
): Promise<void> {
  const instance = await this.getOrCreateInstance()

  await instance.client.session.patch({
    path: { sessionID: opencodeSessionId },
    query: worktreePath ? { directory: worktreePath } : undefined,
    body: { title }
  })
}
```

**Main Process — Handle session.updated for title** (`src/main/services/opencode-service.ts`):

In `handleEvent()`, when processing `session.updated` events, extract the title and persist it. The event already flows to the renderer — the renderer-side handler will update the store:

```typescript
// In handleEvent(), after detecting eventType === 'session.updated':
if (eventType === 'session.updated') {
  const sessionData = event.properties
  const opencodeSessionId = sessionData?.id || sessionData?.sessionID
  if (opencodeSessionId) {
    const hiveSessionId = this.getMappedHiveSessionId(opencodeSessionId)
    if (hiveSessionId && sessionData?.title) {
      // Persist title to DB directly for resilience
      try {
        db.updateSession(hiveSessionId, { name: sessionData.title })
      } catch (err) {
        log.warn('Failed to persist session title from server', { err })
      }
    }
  }
}
```

**Main Process — IPC Handlers** (`src/main/ipc/opencode-handlers.ts`):

Remove the `opencode:generateSessionName` handler (lines 142-163).

Add:

```typescript
// Rename a session title via the OpenCode server
ipcMain.handle(
  'opencode:renameSession',
  async (
    _event,
    {
      opencodeSessionId,
      title,
      worktreePath
    }: { opencodeSessionId: string; title: string; worktreePath?: string }
  ) => {
    log.info('IPC: opencode:renameSession', { opencodeSessionId, title })
    try {
      await openCodeService.renameSession(opencodeSessionId, title, worktreePath)
      return { success: true }
    } catch (error) {
      log.error('IPC: opencode:renameSession failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
)
```

**Preload** (`src/preload/index.ts`):

Remove `generateSessionName` from `opencodeOps`.

Add:

```typescript
// Rename a session title via the server
renameSession: (
  opencodeSessionId: string,
  title: string,
  worktreePath?: string
): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('opencode:renameSession', { opencodeSessionId, title, worktreePath }),
```

**Preload Types** (`src/preload/index.d.ts`):

Remove `generateSessionName` declaration. Add:

```typescript
renameSession: (opencodeSessionId: string, title: string, worktreePath?: string) =>
  Promise<{ success: boolean; error?: string }>
```

**Renderer — Stream Event Handling** (`src/renderer/src/components/sessions/SessionView.tsx`):

Remove:

- `hasTriggeredNamingRef` declaration and all references
- The fire-and-forget naming block (lines 1474-1502)

Add a `session.updated` handler in the stream event switch:

```typescript
if (event.type === 'session.updated') {
  const sessionData = event.data
  if (sessionData?.title) {
    // Update the session name in the store
    useSessionStore.getState().updateSessionName(sessionId, sessionData.title)
  }
  return
}
```

**Renderer — Store** (`src/renderer/src/stores/useSessionStore.ts`):

Remove the local `generateSessionName()` utility function (lines 57-63).

Change the `createSession` method to use the server-style default title:

```typescript
// BEFORE
name: generateSessionName() // "Session HH:MM"

// AFTER
name: `New session - ${new Date().toISOString()}`
```

This matches the server's default title format so the server's `ensureTitle` guard recognizes it as a placeholder and generates a proper title.

#### 1.4 Files to Modify

| File                                                   | Change                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/services/opencode-service.ts`                | Remove `NamingCallback`, `namingCallbacks`, naming event routing, `generateSessionName()`; add `renameSession()`; add title extraction from `session.updated` events |
| `src/main/ipc/opencode-handlers.ts`                    | Remove `opencode:generateSessionName` handler; add `opencode:renameSession` handler                                                                                  |
| `src/preload/index.ts`                                 | Remove `generateSessionName` from `opencodeOps`; add `renameSession`                                                                                                 |
| `src/preload/index.d.ts`                               | Remove `generateSessionName` declaration; add `renameSession` declaration                                                                                            |
| `src/renderer/src/components/sessions/SessionView.tsx` | Remove naming ref + fire-and-forget block; add `session.updated` handler for title                                                                                   |
| `src/renderer/src/stores/useSessionStore.ts`           | Remove local `generateSessionName()` utility; change default title format to match server                                                                            |

---

### 2. Auto-Rename Branch on First Title

#### 2.1 Current State

When a worktree is created, `git-service.ts` (lines 211-248) assigns a random city name as the branch name via `selectUniqueCityName()` from `city-names.ts`. The branch name remains this random city name for the lifetime of the worktree.

There is **no `renameBranch` method** anywhere in the codebase — no git rename functionality exists. The worktree database record stores the branch name in `worktree.branch` (as defined in `src/preload/index.d.ts`).

The worktree sidebar (`WorktreeItem.tsx` line 170) displays `worktree.name` which is the directory name (same as the city name). The branch name is also shown elsewhere in the git status UI.

#### 2.2 New Design

When the first server-generated title arrives (via the `session.updated` event from Feature 1), automatically rename the git branch from the random city name to a canonicalized version of the title — unless the user has manually renamed the branch.

```
Auto-rename flow:

  1. Session title arrives via session.updated event (Feature 1)
  2. Check if current branch name is still one of the initial city names
     (i.e., user hasn't manually renamed it)
  3. If so, canonicalize the title: lowercase, replace spaces/special chars
     with dashes, trim, truncate to 50 chars, strip trailing dashes
  4. Call git branch -m <oldBranch> <newBranch> in the worktree directory
  5. Update the worktree DB record with the new branch name
  6. Emit a store update so the sidebar reflects the new branch name

  Example:
    Title: "Auth refresh token support"
    City name: "tokyo"
    New branch: "auth-refresh-token-support"

Canonicalization rules:
  - Lowercase
  - Replace spaces and underscores with dashes
  - Remove characters not in [a-z0-9-/.]
  - Collapse consecutive dashes
  - Strip leading/trailing dashes
  - Truncate to 50 characters
  - Strip trailing dashes after truncation
```

**How to detect "user hasn't manually renamed":**

Track whether a branch was auto-named (city name) by checking if the current branch name exists in the city names list. If it does, it's still the auto-generated name and eligible for rename. If it doesn't match any city name, the user (or a previous auto-rename) has already renamed it — skip.

To prevent re-renaming on subsequent title updates, also track whether we've already auto-renamed for this worktree (store a flag in the worktree DB record or use a local ref in the renderer).

#### 2.3 Implementation

**Utility — Branch name canonicalization** (`src/main/services/git-service.ts`):

```typescript
/**
 * Convert a session title into a safe git branch name.
 */
export function canonicalizeBranchName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces and underscores → dashes
    .replace(/[^a-z0-9\-/.]/g, '') // remove invalid chars
    .replace(/-{2,}/g, '-') // collapse consecutive dashes
    .replace(/^-+|-+$/g, '') // strip leading/trailing dashes
    .slice(0, 50) // truncate
    .replace(/-+$/, '') // strip trailing dashes after truncation
}
```

**Git Service — Rename branch** (`src/main/services/git-service.ts`):

```typescript
/**
 * Rename a branch in a worktree.
 */
async renameBranch(
  worktreePath: string,
  oldBranch: string,
  newBranch: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const git = simpleGit(worktreePath)
    await git.branch(['-m', oldBranch, newBranch])
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
```

**IPC Handler** (`src/main/ipc/worktree-handlers.ts`):

```typescript
// Rename a branch in a worktree
ipcMain.handle(
  'worktree:renameBranch',
  async (
    _event,
    {
      worktreePath,
      oldBranch,
      newBranch
    }: { worktreePath: string; oldBranch: string; newBranch: string }
  ) => {
    log.info('IPC: worktree:renameBranch', { worktreePath, oldBranch, newBranch })
    try {
      const result = await gitService.renameBranch(worktreePath, oldBranch, newBranch)
      return result
    } catch (error) {
      log.error('IPC: worktree:renameBranch failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
)
```

**Preload** (`src/preload/index.ts`):

Add to `worktreeOps`:

```typescript
renameBranch: (
  worktreePath: string,
  oldBranch: string,
  newBranch: string
): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('worktree:renameBranch', { worktreePath, oldBranch, newBranch }),
```

**Preload Types** (`src/preload/index.d.ts`):

Add to `worktreeOps`:

```typescript
renameBranch: (worktreePath: string, oldBranch: string, newBranch: string) =>
  Promise<{ success: boolean; error?: string }>
```

**Renderer — Auto-rename trigger** (`src/renderer/src/components/sessions/SessionView.tsx`):

In the `session.updated` handler (added in Feature 1), after updating the title, trigger branch auto-rename:

```typescript
if (event.type === 'session.updated') {
  const sessionData = event.data
  if (sessionData?.title) {
    useSessionStore.getState().updateSessionName(sessionId, sessionData.title)

    // Auto-rename branch if this is the first title and branch is still a city name
    if (!hasAutoRenamedBranchRef.current && worktree?.branch) {
      const { CITY_NAMES } = await import('@main/services/city-names')
      const isCityName = CITY_NAMES.some(
        (city) => city.toLowerCase() === worktree.branch.toLowerCase()
      )
      if (isCityName) {
        hasAutoRenamedBranchRef.current = true
        const newBranch = canonicalizeBranchName(sessionData.title)
        if (newBranch && newBranch !== worktree.branch) {
          const result = await window.worktreeOps.renameBranch(
            worktree.path,
            worktree.branch,
            newBranch
          )
          if (result.success) {
            // Update the worktree record in DB and store
            await window.db.worktree.update(worktree.id, { branch: newBranch })
            useWorktreeStore.getState().updateWorktreeBranch(worktree.id, newBranch)
          }
        }
      }
    }
  }
  return
}
```

Note: The `canonicalizeBranchName` utility will need to be exported and available to the renderer. Since it's a pure string utility with no Node.js dependencies, it can be placed in a shared utility file or duplicated in the renderer. Alternatively, the rename logic can be handled entirely in the main process during the `session.updated` event handling.

**Better approach — Main process handles auto-rename** (`src/main/services/opencode-service.ts`):

Move the auto-rename logic to the main process where it has direct access to git-service and city-names:

```typescript
// In handleEvent(), in the session.updated branch, after persisting the title:
if (hiveSessionId && sessionData?.title) {
  try {
    db.updateSession(hiveSessionId, { name: sessionData.title })

    // Auto-rename branch if still a city name
    const worktree = db.getWorktreeBySessionId(hiveSessionId)
    if (worktree && !worktree.branch_renamed) {
      const isCityName = CITY_NAMES.some(
        (city) => city.toLowerCase() === worktree.branch.toLowerCase()
      )
      if (isCityName) {
        const newBranch = canonicalizeBranchName(sessionData.title)
        if (newBranch && newBranch !== worktree.branch) {
          const renameResult = await gitService.renameBranch(
            worktree.path,
            worktree.branch,
            newBranch
          )
          if (renameResult.success) {
            db.updateWorktree(worktree.id, { branch: newBranch, branch_renamed: true })
            // Notify renderer
            sendToRenderer('worktree:branchRenamed', {
              worktreeId: worktree.id,
              newBranch
            })
          }
        }
      }
    }
  } catch (err) {
    log.warn('Failed to auto-rename branch', { err })
  }
}
```

**Database — Add `branch_renamed` flag** (`src/main/db/schema.ts`):

Add a migration to add `branch_renamed` boolean column to the worktrees table:

```sql
ALTER TABLE worktrees ADD COLUMN branch_renamed INTEGER NOT NULL DEFAULT 0;
```

**Renderer — Listen for branch rename events** (`src/renderer/src/stores/useWorktreeStore.ts`):

Add a method to update a worktree's branch name and listen for the main process notification:

```typescript
updateWorktreeBranch: (worktreeId: string, newBranch: string) => {
  set((state) => ({
    worktrees: state.worktrees.map((w) => (w.id === worktreeId ? { ...w, branch: newBranch } : w))
  }))
}
```

#### 2.4 Files to Modify

| File                                          | Change                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/main/services/git-service.ts`            | Add `canonicalizeBranchName()` utility and `renameBranch()` method                |
| `src/main/services/opencode-service.ts`       | Add auto-rename logic in `session.updated` handler                                |
| `src/main/services/city-names.ts`             | Export `CITY_NAMES` array (if not already exported)                               |
| `src/main/ipc/worktree-handlers.ts`           | Add `worktree:renameBranch` IPC handler                                           |
| `src/main/db/schema.ts`                       | Add migration for `branch_renamed` column on worktrees                            |
| `src/preload/index.ts`                        | Add `renameBranch` to `worktreeOps`                                               |
| `src/preload/index.d.ts`                      | Add `renameBranch` type declaration; update `Worktree` type with `branch_renamed` |
| `src/renderer/src/stores/useWorktreeStore.ts` | Add `updateWorktreeBranch` method; listen for `worktree:branchRenamed` event      |

---

### 3. Manual Branch Rename via Context Menu

#### 3.1 Current State

There is no branch rename functionality in the UI. The worktree context menu (`WorktreeItem.tsx` lines 238-277) has: Open in Terminal, Open in Editor, Open in Finder, Copy Path, Duplicate, Unbranch, and Archive. No rename option exists.

There is project renaming (`ProjectItem.tsx` line 234 — "Edit Name"), but this renames the display name only, not a git branch.

#### 3.2 New Design

Add a "Rename Branch" option to the worktree context menu (both the right-click context menu and the three-dot dropdown). On click, show an inline input field (similar to the project "Edit Name" pattern) where the user can type a new branch name. On confirm, call the `renameBranch` IPC method (added in Feature 2) and update the store.

```
Worktree Context Menu (after):

  ┌──────────────────────────┐
  │  Terminal                │
  │  Editor                  │
  │  Finder                  │
  │  Copy Path               │
  │  ─────────────────────── │
  │  Rename Branch           │  ← NEW
  │  Duplicate               │
  │  ─────────────────────── │
  │  Unbranch                │
  │  Archive                 │
  └──────────────────────────┘
```

When "Rename Branch" is clicked:

1. Show an inline text input pre-filled with the current branch name
2. User edits the name and presses Enter (or clicks away to cancel)
3. The input value is canonicalized (same rules as Feature 2)
4. Call `window.worktreeOps.renameBranch(worktreePath, oldBranch, newBranch)`
5. On success, update the worktree in the DB and store
6. Also set `branch_renamed = true` to prevent future auto-renames (Feature 2)

#### 3.3 Implementation

**Renderer — WorktreeItem context menu** (`src/renderer/src/components/worktrees/WorktreeItem.tsx`):

Add state for editing the branch name:

```typescript
const [isRenamingBranch, setIsRenamingBranch] = useState(false)
const [branchNameInput, setBranchNameInput] = useState('')
```

Add the "Rename Branch" menu item after "Copy Path" in both the dropdown and context menus:

```typescript
<DropdownMenuItem
  onClick={() => {
    setBranchNameInput(worktree.branch)
    setIsRenamingBranch(true)
  }}
>
  <Pencil className="h-3.5 w-3.5 mr-2" />
  Rename Branch
</DropdownMenuItem>
```

Add inline input rendering when `isRenamingBranch` is true (replacing the branch name display):

```typescript
const handleBranchRename = async () => {
  const trimmed = branchNameInput.trim()
  if (!trimmed || trimmed === worktree.branch) {
    setIsRenamingBranch(false)
    return
  }
  // Canonicalize
  const newBranch = trimmed
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\-/.]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '')

  if (!newBranch) {
    toast.error('Invalid branch name')
    setIsRenamingBranch(false)
    return
  }

  const result = await window.worktreeOps.renameBranch(worktree.path, worktree.branch, newBranch)
  if (result.success) {
    await window.db.worktree.update(worktree.id, { branch: newBranch, branch_renamed: true })
    useWorktreeStore.getState().updateWorktreeBranch(worktree.id, newBranch)
    toast.success(`Branch renamed to ${newBranch}`)
  } else {
    toast.error(result.error || 'Failed to rename branch')
  }
  setIsRenamingBranch(false)
}
```

#### 3.4 Files to Modify

| File                                                     | Change                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Add "Rename Branch" to context menu and dropdown; add inline rename input + handler |

Note: The `renameBranch` IPC method and git-service method are already added in Feature 2.

---

### 4. Auto-Start First Session on Worktree Entry

#### 4.1 Current State

The auto-start logic in `SessionTabs.tsx` (lines 193-237) has an overly restrictive condition: it checks if **the entire project** has zero active sessions across all worktrees (line 214-218: `window.db.session.getByProject(project.id)` → checks if any session has `status === 'active'`). This means:

- If worktree A has an active session and the user switches to worktree B (which has 0 sessions), worktree B will **not** auto-create a session because the project already has an active session in worktree A.
- The user sees "No sessions yet. Click + to create one." (line 406-412 of `SessionTabs.tsx`) and has to manually click +.

The desired behavior: when entering **any** worktree with 0 sessions, automatically create the first session regardless of other worktrees.

#### 4.2 New Design

Change the auto-start check from project-wide to worktree-specific:

```
Current logic:
  IF autoStartSession setting enabled
  AND selected worktree's session list is empty
  AND NO active session exists in the ENTIRE PROJECT
  → auto-create session

New logic:
  IF autoStartSession setting enabled
  AND selected worktree's session list is empty
  → auto-create session
```

Remove the async DB check that queries all project sessions. The local store already knows how many sessions the selected worktree has.

#### 4.3 Implementation

**Renderer** (`src/renderer/src/components/sessions/SessionTabs.tsx`):

Simplify the auto-start `useEffect` (lines 198-237):

```typescript
useEffect(() => {
  if (!selectedWorktreeId) return
  if (!project) return
  if (isLoading) return
  if (!autoStartSession) return

  const sessions = useSessionStore.getState().getSessionsByWorktree(selectedWorktreeId)
  if (sessions.length > 0) return
  if (autoStartedRef.current === selectedWorktreeId) return

  autoStartedRef.current = selectedWorktreeId

  // Auto-create the first session for this worktree
  useSessionStore.getState().createSession(selectedWorktreeId, project.id)
}, [selectedWorktreeId, project, isLoading, autoStartSession])
```

This removes:

- The async `window.db.session.getByProject()` check
- The project-wide "any active session?" guard
- The re-check after the async call

#### 4.4 Files to Modify

| File                                                   | Change                                               |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionTabs.tsx` | Simplify auto-start logic to per-worktree check only |

---

### 5. Create Worktree from Specific Branch

#### 5.1 Current State

`git-service.ts` `createWorktree(projectName)` (lines 211-248) only accepts `projectName` as a parameter. It always creates a new branch from the default branch:

```typescript
const defaultBranch = await this.getDefaultBranch()
await this.git.raw(['worktree', 'add', '-b', cityName, worktreePath, defaultBranch])
```

There is no way to specify a source branch. The project context menu (`ProjectItem.tsx` lines 233-262) has no "New workspace from branch" option.

`git-service.ts` also has `duplicateWorktree(sourceBranch, sourceWorktreePath, projectName)` (lines 746-810) which creates a `<baseName>-v<N>` branch from a source branch and copies uncommitted state.

There is also `listBranches()` (line 263) and `getAllBranches()` (line 271) which return available branches.

#### 5.2 New Design

Add "New Workspace From..." to the project context menu. On click, show a dialog/popover with:

1. A filter text field at the top
2. A scrollable list of all branches (local + remote)
3. Each branch shows its name and whether it's currently checked out in a worktree

When the user selects a branch:

- If the branch is **not** checked out in any worktree → create a new worktree with `git worktree add <path> <branch>` (no `-b` flag — use existing branch)
- If the branch **is** already checked out → duplicate it (same behavior as right-clicking a worktree and choosing "Duplicate")

```
UI Flow:

  Right-click Project
  └─ New Workspace From... →
     ┌──────────────────────────────────┐
     │  🔍 Filter branches...           │
     ├──────────────────────────────────┤
     │  main                    (active)│
     │  feature/auth-tokens             │
     │  feature/file-picker             │
     │  bugfix/scroll-fab               │
     │  origin/feature/dark-mode        │
     └──────────────────────────────────┘

  Click "feature/auth-tokens" →
    Creates worktree at ~/.hive-worktrees/<project>/feature-auth-tokens
    Branch: feature/auth-tokens (existing)

  Click "main" (already checked out) →
    Creates duplicate: main-v2 worktree
```

#### 5.3 Implementation

**Git Service — Create worktree from existing branch** (`src/main/services/git-service.ts`):

```typescript
/**
 * Create a worktree from an existing branch.
 * If the branch is already checked out, duplicate it.
 */
async createWorktreeFromBranch(
  projectName: string,
  branchName: string
): Promise<CreateWorktreeResult> {
  // Check if branch is already checked out in a worktree
  const worktrees = await this.git.raw(['worktree', 'list', '--porcelain'])
  const checkedOutBranches = worktrees
    .split('\n')
    .filter((line) => line.startsWith('branch '))
    .map((line) => line.replace('branch refs/heads/', ''))

  if (checkedOutBranches.includes(branchName)) {
    // Branch is already checked out — find the source worktree and duplicate
    const existingWorktree = worktrees
      .split('\n\n')
      .find((block) => block.includes(`branch refs/heads/${branchName}`))
    const worktreePath = existingWorktree
      ?.split('\n')
      .find((line) => line.startsWith('worktree '))
      ?.replace('worktree ', '')

    if (worktreePath) {
      return this.duplicateWorktree(branchName, worktreePath, projectName)
    }
  }

  // Branch exists but is not checked out — create worktree using it
  const dirName = branchName
    .replace(/[/\\]/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase()

  const worktreeBase = path.join(os.homedir(), '.hive-worktrees', projectName)
  const worktreePath = path.join(worktreeBase, dirName)

  await fs.mkdir(worktreeBase, { recursive: true })
  await this.git.raw(['worktree', 'add', worktreePath, branchName])

  return {
    path: worktreePath,
    branch: branchName,
    name: dirName
  }
}
```

**Git Service — List all branches with checkout status** (`src/main/services/git-service.ts`):

```typescript
/**
 * List all branches (local + remote) with their checkout status.
 */
async listBranchesWithStatus(): Promise<
  Array<{
    name: string
    isRemote: boolean
    isCheckedOut: boolean
    worktreePath?: string
  }>
> {
  const [branchSummary, worktreeList] = await Promise.all([
    this.git.branch(['-a']),
    this.git.raw(['worktree', 'list', '--porcelain'])
  ])

  // Parse checked-out branches from worktree list
  const checkedOut = new Map<string, string>()
  const blocks = worktreeList.split('\n\n').filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n')
    const wtPath = lines.find((l) => l.startsWith('worktree '))?.replace('worktree ', '')
    const branch = lines.find((l) => l.startsWith('branch '))?.replace('branch refs/heads/', '')
    if (wtPath && branch) {
      checkedOut.set(branch, wtPath)
    }
  }

  return Object.entries(branchSummary.branches).map(([name, info]) => ({
    name: info.name,
    isRemote: name.startsWith('remotes/'),
    isCheckedOut: checkedOut.has(info.name),
    worktreePath: checkedOut.get(info.name)
  }))
}
```

**IPC Handlers** (`src/main/ipc/worktree-handlers.ts`):

```typescript
// Create a worktree from a specific branch
ipcMain.handle(
  'worktree:createFromBranch',
  async (
    _event,
    {
      projectId,
      projectPath,
      projectName,
      branchName
    }: { projectId: string; projectPath: string; projectName: string; branchName: string }
  ) => {
    log.info('IPC: worktree:createFromBranch', { projectName, branchName })
    try {
      const gitService = new GitService(projectPath)
      const result = await gitService.createWorktreeFromBranch(projectName, branchName)
      const worktree = db.createWorktree({
        project_id: projectId,
        name: result.name,
        path: result.path,
        branch: result.branch,
        is_default: false
      })
      return { success: true, worktree }
    } catch (error) {
      log.error('IPC: worktree:createFromBranch failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
)

// List all branches with checkout status
ipcMain.handle(
  'git:listBranchesWithStatus',
  async (_event, { projectPath }: { projectPath: string }) => {
    try {
      const gitService = new GitService(projectPath)
      const branches = await gitService.listBranchesWithStatus()
      return { success: true, branches }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        branches: []
      }
    }
  }
)
```

**Preload** (`src/preload/index.ts`):

Add to `worktreeOps`:

```typescript
createFromBranch: (
  projectId: string,
  projectPath: string,
  projectName: string,
  branchName: string
): Promise<{ success: boolean; worktree?: Worktree; error?: string }> =>
  ipcRenderer.invoke('worktree:createFromBranch', {
    projectId, projectPath, projectName, branchName
  }),
```

Add to `gitOps`:

```typescript
listBranchesWithStatus: (
  projectPath: string
): Promise<{
  success: boolean
  branches: Array<{ name: string; isRemote: boolean; isCheckedOut: boolean; worktreePath?: string }>
  error?: string
}> => ipcRenderer.invoke('git:listBranchesWithStatus', { projectPath }),
```

**Renderer — Branch Picker Dialog** (`src/renderer/src/components/worktrees/BranchPickerDialog.tsx`):

New component — a dialog containing:

- Filter input at the top
- Scrollable list of branches, filtered by input text
- Each item shows branch name, remote indicator badge, and "(active)" if checked out
- Clicking a branch triggers the `onSelect` callback

```typescript
interface BranchPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  onSelect: (branchName: string) => void
}

export function BranchPickerDialog({
  open,
  onOpenChange,
  projectPath,
  onSelect
}: BranchPickerDialogProps): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setLoading(true)
      window.gitOps.listBranchesWithStatus(projectPath).then((result) => {
        if (result.success) setBranches(result.branches)
        setLoading(false)
      })
    }
  }, [open, projectPath])

  const filtered = branches.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()))

  // Render Dialog with filter input + scrollable branch list
}
```

**Renderer — Project context menu** (`src/renderer/src/components/projects/ProjectItem.tsx`):

Add "New Workspace From..." menu item:

```typescript
<ContextMenuItem onClick={() => setBranchPickerOpen(true)}>
  <GitBranch className="h-3.5 w-3.5 mr-2" />
  New Workspace From...
</ContextMenuItem>
```

Handle branch selection:

```typescript
const handleBranchSelect = async (branchName: string) => {
  setBranchPickerOpen(false)
  const result = await window.worktreeOps.createFromBranch(
    project.id,
    project.path,
    project.name,
    branchName
  )
  if (result.success && result.worktree) {
    useWorktreeStore.getState().addWorktree(result.worktree)
    useWorktreeStore.getState().selectWorktree(result.worktree.id)
    toast.success(`Workspace created from ${branchName}`)
  } else {
    toast.error(result.error || 'Failed to create workspace')
  }
}
```

#### 5.4 Files to Modify

| File                                                           | Change                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/main/services/git-service.ts`                             | Add `createWorktreeFromBranch()` and `listBranchesWithStatus()` methods           |
| `src/main/ipc/worktree-handlers.ts`                            | Add `worktree:createFromBranch` and `git:listBranchesWithStatus` IPC handlers     |
| `src/preload/index.ts`                                         | Add `createFromBranch` to `worktreeOps`; add `listBranchesWithStatus` to `gitOps` |
| `src/preload/index.d.ts`                                       | Type declarations for new methods                                                 |
| `src/renderer/src/components/worktrees/BranchPickerDialog.tsx` | **NEW** — Branch picker dialog with filter and branch list                        |
| `src/renderer/src/components/projects/ProjectItem.tsx`         | Add "New Workspace From..." to context menu; handle branch selection              |
| `src/renderer/src/stores/useWorktreeStore.ts`                  | Add `addWorktree` method if not already present                                   |

---

### 6. Fix: Session Loading State Cleared on Tab Switch

#### 6.1 Current State

When a session is actively streaming (loading), the session tab shows a spinning `Loader2` icon. However, switching to a different tab and back to the streaming session causes the loading indicator to stop — the session appears idle even though it hasn't finished.

The issue is in `SessionView.tsx`'s `initializeSession` effect (lines 684-1342). When the component mounts (on tab switch), it calls `resetStreamingState()` (line 758) which sets `isStreaming` to `false`, clearing all streaming visual indicators. It then attempts to reconnect to the OpenCode session, but the streaming state is already reset.

Additionally, entering a session currently removes the unread badge via the effect at session mount. The loading state reset is the bug — entering a session should only clear the unread badge, not the streaming/loading visual state.

#### 6.2 New Design

When `initializeSession` reconnects to a session that is already streaming:

1. Do **not** call `resetStreamingState()` before checking the session's current status
2. After reconnecting, query the OpenCode session's current status
3. If the session status is `busy` (actively streaming), set `isStreaming = true` and resume stream subscription without clearing state
4. Only clear the unread badge — not the loading indicator

```
Current flow on tab switch to a loading session:
  1. SessionView mounts
  2. resetStreamingState() → isStreaming = false ← BUG
  3. Load messages from DB
  4. Reconnect to OpenCode session
  5. Subscribe to stream events
  6. (session is still streaming but UI shows idle)

New flow:
  1. SessionView mounts
  2. Load messages from DB
  3. Reconnect to OpenCode session
  4. Check session status
  5. If status === 'busy' → set isStreaming = true
  6. Subscribe to stream events
  7. Clear unread badge only
  8. Resume showing streaming UI
```

#### 6.3 Implementation

**Renderer** (`src/renderer/src/components/sessions/SessionView.tsx`):

Move `resetStreamingState()` call to only fire when the session is confirmed idle. In `initializeSession`:

```typescript
// BEFORE (line ~758)
resetStreamingState()

// AFTER — defer the reset until we know the session status
// Don't call resetStreamingState() here at all.
// Instead, after reconnection, check status:

const sessionInfo = await window.opencodeOps.getSessionStatus(opencodeSessionId, worktreePath)
if (sessionInfo?.status === 'busy') {
  // Session is actively streaming — don't clear state
  setIsStreaming(true)
} else {
  // Session is idle — safe to reset
  resetStreamingState()
}
```

This requires a new IPC method to query session status. Alternatively, the status can be inferred from the first stream event received after subscription.

**Simpler approach — use the session.status event:**

Instead of querying status explicitly, let the stream subscription handle it. Remove the premature `resetStreamingState()` call. The `session.status` event handler already sets `isStreaming` based on the status type:

```typescript
// Remove the resetStreamingState() call at line ~758
// Keep the stream subscription setup
// The session.status event will correctly set isStreaming:
//   - status.type === 'busy' → setIsStreaming(true)
//   - status.type === 'idle' → resetStreamingState()
```

But we still need to clear stale streaming content from the previous view. Solution: only clear the **display state** (streaming parts and content) but not the `isStreaming` flag:

```typescript
// Replace resetStreamingState() with a partial clear:
streamingPartsRef.current = []
streamingContentRef.current = ''
setStreamingParts([])
setStreamingContent('')
// Do NOT set isStreaming to false here — let the stream events control it
```

#### 6.4 Files to Modify

| File                                                   | Change                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/src/components/sessions/SessionView.tsx` | Remove premature `resetStreamingState()` in `initializeSession`; partial clear display state only; let stream events control `isStreaming` |

---

### 7. File Sidebar Redesign — Two-Tab Layout

#### 7.1 Current State

The file sidebar is a single `FileTree` component (`src/renderer/src/components/file-tree/FileTree.tsx`, 400 lines) that shows all files with git status indicators inline. Key sub-components:

- `FileTreeHeader.tsx` (76 lines) — title, collapse-all, refresh, close, and `FileTreeFilter` input
- `FileTreeNode.tsx` (195 lines) — individual rows with `FileIcon`, name, `GitStatusIndicator`
- `FileTreeFilter.tsx` — filter input
- `FileContextMenu.tsx` — right-click: stage, unstage, discard, gitignore, open in editor, etc.
- `GitStatusIndicator.tsx` — M/A/D/?/C badges
- `useFileTreeStore.ts` (274 lines) — tree data, filtering, file watching
- `useGitStore.ts` — git status data

Currently, there is no separation between "changed files" and "all files". Git status indicators are mixed into the full file tree. The git operations (stage, unstage, discard) are accessed via context menu on individual files.

#### 7.2 New Design

Replace the single-view file sidebar with a two-tab layout:

```
┌─────────────────────────────────────┐
│  [Changes]  [Files]          [✕]    │
├─────────────────────────────────────┤
│                                     │
│  Changes tab (selected):            │
│                                     │
│  Staged (3)                    [↓]  │
│    ✓ src/main/service.ts        M   │
│    ✓ src/renderer/App.tsx       A   │
│    ✓ package.json               M   │
│                                     │
│  Unstaged (2)                  [↑]  │
│    ○ src/utils/helpers.ts       M   │
│    ○ README.md                  M   │
│                                     │
│  Untracked (1)                      │
│    ? src/new-file.ts                │
│                                     │
│  ──────────────────────────────     │
│  [Stage All] [Unstage All] [Discard]│
│                                     │
├─────────────────────────────────────┤
│                                     │
│  Files tab:                         │
│                                     │
│  🔍 Filter files...                 │
│                                     │
│  📁 src/                            │
│    📁 main/                         │
│      📄 index.ts                    │
│      📄 service.ts                  │
│    📁 renderer/                     │
│      📄 App.tsx                     │
│  📄 package.json                    │
│                                     │
│  (No git indicators, no git menus)  │
│                                     │
└─────────────────────────────────────┘
```

**Changes tab:**

- Groups files by: Staged, Unstaged, Untracked
- Each group is collapsible with a count badge
- Shows git status indicator (M, A, D, ?, etc.)
- Bulk actions at the bottom: Stage All, Unstage All, Discard All
- Individual file actions via context menu: Stage, Unstage, Discard, Open Diff
- Clicking a file opens the diff viewer

**Files tab:**

- Standard file tree (same as current `FileTree` but without git UI)
- Filter field at the top
- No `GitStatusIndicator` badges
- No git-related context menu items (stage, unstage, discard)
- Context menu: Open, Open in Editor, Copy Path, Copy Name
- Clicking a file opens the file viewer

#### 7.3 Implementation

**New Component — `FileSidebar.tsx`** (`src/renderer/src/components/file-tree/FileSidebar.tsx`):

Wrapper component with tab switching:

```typescript
import { useState } from 'react'
import { FileTree } from './FileTree'
import { ChangesView } from './ChangesView'
import { cn } from '@/lib/utils'

interface FileSidebarProps {
  worktreePath: string
  onClose: () => void
  onFileClick: (filePath: string) => void
}

export function FileSidebar({
  worktreePath,
  onClose,
  onFileClick
}: FileSidebarProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'changes' | 'files'>('changes')

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border px-2 pt-2">
        <button
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors',
            activeTab === 'changes'
              ? 'text-foreground border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={() => setActiveTab('changes')}
        >
          Changes
        </button>
        <button
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors',
            activeTab === 'files'
              ? 'text-foreground border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={() => setActiveTab('files')}
        >
          Files
        </button>
        <div className="flex-1" />
        <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'changes' ? (
        <ChangesView worktreePath={worktreePath} onFileClick={onFileClick} />
      ) : (
        <FileTree
          worktreePath={worktreePath}
          onClose={onClose}
          onFileClick={onFileClick}
          hideGitIndicators
          hideGitContextActions
        />
      )}
    </div>
  )
}
```

**New Component — `ChangesView.tsx`** (`src/renderer/src/components/file-tree/ChangesView.tsx`):

Extracts the git-specific functionality into its own view:

```typescript
interface ChangesViewProps {
  worktreePath: string
  onFileClick: (filePath: string) => void
}

export function ChangesView({ worktreePath, onFileClick }: ChangesViewProps): React.JSX.Element {
  const gitStatus = useGitStore((s) => s.getStatusForWorktree(worktreePath))
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // Group files into: staged, unstaged, untracked
  const { staged, unstaged, untracked } = useMemo(() => {
    // ... group git status entries
  }, [gitStatus])

  // Render grouped file lists with bulk actions
}
```

**Modify FileTree** (`src/renderer/src/components/file-tree/FileTree.tsx`):

Add optional props to hide git-related UI:

```typescript
interface FileTreeProps {
  worktreePath: string
  onClose: () => void
  onFileClick: (filePath: string) => void
  hideGitIndicators?: boolean // NEW
  hideGitContextActions?: boolean // NEW
}
```

Pass these through to `FileTreeNode` and `FileContextMenu`.

**Update parent component** that renders the file sidebar to use `FileSidebar` instead of `FileTree` directly.

#### 7.4 Files to Modify

| File                                                          | Change                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/renderer/src/components/file-tree/FileSidebar.tsx`       | **NEW** — Two-tab wrapper (Changes / Files) with tab switching     |
| `src/renderer/src/components/file-tree/ChangesView.tsx`       | **NEW** — Git changes view with staged/unstaged/untracked groups   |
| `src/renderer/src/components/file-tree/FileTree.tsx`          | Add `hideGitIndicators` and `hideGitContextActions` optional props |
| `src/renderer/src/components/file-tree/FileTreeNode.tsx`      | Respect `hideGitIndicators` prop to suppress git badges            |
| `src/renderer/src/components/file-tree/FileContextMenu.tsx`   | Respect `hideGitContextActions` prop to suppress git menu items    |
| `src/renderer/src/components/file-tree/index.ts`              | Export `FileSidebar` and `ChangesView`                             |
| `src/renderer/src/components/layout/MainPane.tsx` (or parent) | Replace `FileTree` with `FileSidebar`                              |

---

### 8. Fix: Tool Call Results Detaching Across Session Switches

#### 8.1 Current State

When a tool call is in progress (e.g., a bash command running), the user switches to another session tab, and then switches back, the tool call result arrives and appears as a **separate entity** in the message list rather than being merged into the original tool call card.

The issue is in how streaming parts are reconciled after session switches. `SessionView.tsx` uses `streamingPartsRef` and `streamingContentRef` as local refs. When the component unmounts (tab switch away) and remounts (tab switch back), these refs are re-initialized to empty arrays. The stream subscription is re-created, but the mapping of pending tool call IDs (`callID`) to their positions in `streamingParts` is lost.

When a `message.part.updated` event arrives with a tool result for a pending `callID`, the reconciliation code cannot find the matching tool call in the empty `streamingParts` array, so it creates a new entry — causing the "detached" result.

Meanwhile, the **main process** correctly persists tool call results via `persistStreamEvent()` (line 339-435 of `opencode-service.ts`) which uses `mergeUpdatedPart()` to update the stored `opencode_parts_json`. The DB has the correct merged data.

#### 8.2 New Design

When `initializeSession` runs on remount (tab switch back), load the last assistant message's parts from the database. If the session is still streaming (status is `busy`), initialize `streamingPartsRef` from the persisted parts rather than starting empty. This way, when new tool results arrive, the `callID` matching code can find the original tool call and merge the result correctly.

```
Current flow on tab switch back during tool execution:
  1. SessionView mounts
  2. streamingPartsRef = [] (empty)
  3. Subscribe to stream events
  4. Tool result event arrives with callID: "abc123"
  5. No matching part in streamingParts → creates new entry (BUG)

New flow:
  1. SessionView mounts
  2. Load last assistant message parts from DB
  3. If session is busy, initialize streamingPartsRef from DB parts
  4. Subscribe to stream events
  5. Tool result event arrives with callID: "abc123"
  6. Finds matching tool call in streamingPartsRef → merges result (CORRECT)
```

#### 8.3 Implementation

**Renderer** (`src/renderer/src/components/sessions/SessionView.tsx`):

In `initializeSession`, after loading messages from DB and determining the session is still active:

```typescript
// After loading messages and detecting session is streaming
if (lastMessage?.role === 'assistant' && lastMessage.opencode_parts_json) {
  try {
    const persistedParts = JSON.parse(lastMessage.opencode_parts_json)
    if (Array.isArray(persistedParts) && persistedParts.length > 0) {
      // Initialize streaming refs from persisted parts so tool call
      // results can find their matching calls
      streamingPartsRef.current = persistedParts.map(convertPersistedPartToStreamingPart)
      setStreamingParts([...streamingPartsRef.current])

      // Also restore text content
      const textParts = persistedParts.filter((p) => p.type === 'text')
      if (textParts.length > 0) {
        const restoredContent = textParts.map((p) => p.content || p.text || '').join('')
        streamingContentRef.current = restoredContent
        setStreamingContent(restoredContent)
      }
    }
  } catch {
    // Fall through to empty state
  }
}
```

The `convertPersistedPartToStreamingPart` helper maps the DB-stored part format to the `StreamingPart` format used by the streaming handler, ensuring `callID` and other identifiers are preserved.

#### 8.4 Files to Modify

| File                                                   | Change                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | On remount, initialize streaming refs from DB parts when session is still busy; add `convertPersistedPartToStreamingPart` helper |

---

### 9. Fix: Streaming Content Bleeding Across Tabs

#### 9.1 Current State

When multiple sessions are open as tabs in a worktree, streaming content from the active session appears on other tabs when switching. The user sees content being streamed in a session that isn't actually streaming.

The stream event handler in `SessionView.tsx` (line 770) checks:

```typescript
if (event.sessionId !== sessionId) return
```

This check uses the `sessionId` prop (the hive session ID). The `onStream` callback is set up per-component, so each `SessionView` instance has its own subscription.

However, the potential issue is that React may keep multiple `SessionView` instances mounted simultaneously during tab transitions (e.g., with `keep-alive` behavior or animation transitions). If two `SessionView` instances are mounted for different sessions but the stream events contain the same `sessionId` due to a mapping issue, content could bleed.

Another possibility: the `streamingContent` state updates cause the parent component to re-render, and if the parent passes down shared state or if there's a shared ref being read by multiple tab instances, content could leak.

The most likely root cause: the `onStream` listener is registered globally (via `ipcRenderer.on('opencode:stream', ...)`) and all mounted `SessionView` components receive all events. Each component should filter by its own `sessionId`, which line 770 does — but if there's a race condition during cleanup (old listener not unsubscribed before new one starts), events could be processed by the wrong instance.

#### 9.2 New Design

Strengthen the session ID scoping:

1. Use `useRef` to track the current session's opencode session ID for stream filtering
2. Ensure the `onStream` cleanup function runs synchronously before the new subscription starts
3. Add a component instance ID to prevent stale closures from processing events

```
Fix approach:

  1. Add a mount generation counter (ref that increments on each sessionId change)
  2. Capture the generation at subscription time
  3. In the stream handler, check that the current generation matches
  4. If it doesn't match (stale closure), skip the event
  5. Ensure cleanup always runs before new subscription
```

#### 9.3 Implementation

**Renderer** (`src/renderer/src/components/sessions/SessionView.tsx`):

Add a generation counter ref:

```typescript
const streamGenerationRef = useRef(0)
```

In the stream subscription effect:

```typescript
useEffect(() => {
  // Increment generation on every session change
  streamGenerationRef.current += 1
  const currentGeneration = streamGenerationRef.current

  // ... setup code ...

  const unsubscribe = window.opencodeOps.onStream((event) => {
    // Guard 1: check session ID
    if (event.sessionId !== sessionId) return

    // Guard 2: check generation (prevents stale closure processing)
    if (streamGenerationRef.current !== currentGeneration) return

    // ... process event ...
  })

  return () => {
    unsubscribe()
  }
}, [sessionId])
```

Additionally, ensure that `streamingContent` and `streamingParts` state is cleared when the session ID changes (at the top of the effect, before subscribing):

```typescript
// Clear display state for the new session
streamingPartsRef.current = []
streamingContentRef.current = ''
setStreamingParts([])
setStreamingContent('')
setIsStreaming(false)
```

#### 9.4 Files to Modify

| File                                                   | Change                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add generation counter for stream subscriptions; add stale closure guard; clear state on session change |

---

### 10. UI Text Changes

#### 10.1 Current State

- **"Streaming..." text**: `AssistantCanvas.tsx` lines 266-268 renders `<span className="block text-[10px] text-blue-500 animate-pulse mt-2">Streaming...</span>` at the bottom of every assistant message while streaming.

- **"Task" tool name**: `ToolCard.tsx` lines 376-394 renders `"Task"` as the display name for the `task` tool. Line 385: `<span className="font-medium text-foreground shrink-0">Task</span>`. Also at line 43 of `TaskToolView.tsx`: `{description || 'Agent Task'}`.

#### 10.2 New Design

- **Remove "Streaming..." text entirely** — the pulsing cursor (`StreamingCursor`) already indicates streaming.
- **Rename "Task" → "Agent"** in the collapsed tool card header to better reflect what the tool does (it dispatches a sub-agent).

#### 10.3 Implementation

**Remove "Streaming..." text** (`src/renderer/src/components/sessions/AssistantCanvas.tsx`):

```typescript
// BEFORE (lines 266-268)
{isStreaming && (
  <span className="block text-[10px] text-blue-500 animate-pulse mt-2">Streaming...</span>
)}

// AFTER — remove entirely
```

**Rename "Task" → "Agent"** (`src/renderer/src/components/sessions/ToolCard.tsx`):

```typescript
// BEFORE (line 385)
<span className="font-medium text-foreground shrink-0">Task</span>

// AFTER
<span className="font-medium text-foreground shrink-0">Agent</span>
```

**Update TaskToolView fallback** (`src/renderer/src/components/sessions/tools/TaskToolView.tsx`):

```typescript
// BEFORE (line 43)
{
  description || 'Agent Task'
}

// AFTER
{
  description || 'Sub-agent'
}
```

#### 10.4 Files to Modify

| File                                                          | Change                                      |
| ------------------------------------------------------------- | ------------------------------------------- |
| `src/renderer/src/components/sessions/AssistantCanvas.tsx`    | Remove "Streaming..." span                  |
| `src/renderer/src/components/sessions/ToolCard.tsx`           | Rename "Task" → "Agent" in collapsed header |
| `src/renderer/src/components/sessions/tools/TaskToolView.tsx` | Update fallback text                        |

---

## Files to Modify — Full Summary

### New Files

| File                                                           | Purpose                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/renderer/src/components/file-tree/FileSidebar.tsx`        | Two-tab wrapper (Changes / Files) for file sidebar                     |
| `src/renderer/src/components/file-tree/ChangesView.tsx`        | Git changes view with staged/unstaged/untracked file groups            |
| `src/renderer/src/components/worktrees/BranchPickerDialog.tsx` | Branch picker dialog with filter and branch list for worktree creation |

### Modified Files

| File                                                          | Features   | Changes                                                                                                                            |
| ------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/services/opencode-service.ts`                       | 1, 2       | Remove naming system; add `renameSession()`; handle `session.updated` for titles; auto-rename branch                               |
| `src/main/services/git-service.ts`                            | 2, 3, 5    | Add `canonicalizeBranchName()`, `renameBranch()`, `createWorktreeFromBranch()`, `listBranchesWithStatus()`                         |
| `src/main/services/city-names.ts`                             | 2          | Export `CITY_NAMES` array                                                                                                          |
| `src/main/ipc/opencode-handlers.ts`                           | 1          | Remove `generateSessionName` handler; add `renameSession` handler                                                                  |
| `src/main/ipc/worktree-handlers.ts`                           | 2, 3, 5    | Add `worktree:renameBranch`, `worktree:createFromBranch`, `git:listBranchesWithStatus` handlers                                    |
| `src/main/db/schema.ts`                                       | 2          | Add migration for `branch_renamed` column on worktrees table                                                                       |
| `src/preload/index.ts`                                        | 1, 2, 3, 5 | Remove `generateSessionName`; add `renameSession`, `renameBranch`, `createFromBranch`, `listBranchesWithStatus`                    |
| `src/preload/index.d.ts`                                      | 1, 2, 3, 5 | Type declarations for all new/removed methods; update `Worktree` type                                                              |
| `src/renderer/src/components/sessions/SessionView.tsx`        | 1, 6, 8, 9 | Handle `session.updated` titles; fix loading state preservation; restore tool call state on remount; add stream generation counter |
| `src/renderer/src/components/sessions/SessionTabs.tsx`        | 4          | Simplify auto-start logic to per-worktree check                                                                                    |
| `src/renderer/src/components/sessions/AssistantCanvas.tsx`    | 10         | Remove "Streaming..." text                                                                                                         |
| `src/renderer/src/components/sessions/ToolCard.tsx`           | 10         | Rename "Task" → "Agent"                                                                                                            |
| `src/renderer/src/components/sessions/tools/TaskToolView.tsx` | 10         | Update fallback text                                                                                                               |
| `src/renderer/src/components/file-tree/FileTree.tsx`          | 7          | Add `hideGitIndicators` and `hideGitContextActions` props                                                                          |
| `src/renderer/src/components/file-tree/FileTreeNode.tsx`      | 7          | Respect `hideGitIndicators` prop                                                                                                   |
| `src/renderer/src/components/file-tree/FileContextMenu.tsx`   | 7          | Respect `hideGitContextActions` prop                                                                                               |
| `src/renderer/src/components/file-tree/index.ts`              | 7          | Export `FileSidebar` and `ChangesView`                                                                                             |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx`      | 3          | Add "Rename Branch" to context menu and dropdown; add inline rename input                                                          |
| `src/renderer/src/components/projects/ProjectItem.tsx`        | 5          | Add "New Workspace From..." to context menu; handle branch selection                                                               |
| `src/renderer/src/stores/useSessionStore.ts`                  | 1          | Remove local `generateSessionName()`; change default title format                                                                  |
| `src/renderer/src/stores/useWorktreeStore.ts`                 | 2, 3       | Add `updateWorktreeBranch` method; listen for `worktree:branchRenamed` event                                                       |
| `src/renderer/src/components/layout/MainPane.tsx` (or parent) | 7          | Replace `FileTree` usage with `FileSidebar`                                                                                        |

---

## Dependencies to Add

```bash
# No new dependencies — all features use existing packages:
# - @opencode-ai/sdk (session.patch, session status already available)
# - simple-git (branch -m for rename)
# - zustand (stores — already installed)
# - lucide-react (icons — already installed)
# - @tanstack/react-virtual (ChangesView can reuse — already installed)
```

---

## Non-Functional Requirements

| Requirement                          | Target                                                                |
| ------------------------------------ | --------------------------------------------------------------------- |
| Title update from server event       | < 100ms from SSE event to title visible in tab and sidebar            |
| Branch auto-rename after title       | < 500ms from title event to branch renamed and UI updated             |
| Manual branch rename round-trip      | < 300ms from Enter key to git rename complete and UI updated          |
| Auto-start session on worktree entry | < 200ms from worktree selection to session created and view mounted   |
| Branch picker dialog load            | < 500ms from menu click to branch list rendered (with 100+ branches)  |
| Session loading state preservation   | 0 false-idle states — streaming sessions always show loading on entry |
| File sidebar tab switch              | < 50ms to swap between Changes and Files tabs                         |
| Tool call result reconciliation      | 100% of tool results merge into their original tool call card         |
| Stream content isolation             | 0 cross-tab content leaks across all streaming scenarios              |
| UI text change render                | Immediate — no visual glitch during streaming                         |

---

## Out of Scope (Phase 11)

- Per-message summary titles (the `message.summary.title` feature in `TITLE_GENERATION.md` — only session-level titles are implemented)
- Custom title model selection (`agent.title.model` config — rely on server defaults)
- Branch rename with remote tracking update (`git push --set-upstream` after rename)
- Worktree directory rename to match new branch name (only the git branch is renamed, not the filesystem directory)
- Remote branch checkout with tracking setup (only local branches and simple remote references)
- Merge conflict resolution in the Changes view
- File staging/unstaging animations
- Drag-and-drop file staging (stage by dragging files between groups)
- File diff inline in the Changes view (opens separate diff viewer on click)
- Session tab rename (double-click to rename) — manual rename is via the OpenCode PATCH API but no inline tab editing UI in this phase
- Branch protection rules (preventing rename of `main`/`master`)

---

## Implementation Priority

### Sprint 1: Title System Overhaul + Branch Rename (Highest Priority — Core Infrastructure)

1. **Feature 1 — Server-Side Session Titles**: Remove the entire custom Haiku naming system. Add `session.updated` event handling. Add `renameSession` API for manual renames. This is foundational — Feature 2 depends on it.
2. **Feature 2 — Auto-Rename Branch on First Title**: Add `renameBranch` to git-service, canonicalization utility, `branch_renamed` DB column, auto-rename in `session.updated` handler. Depends on Feature 1 delivering titles.

### Sprint 2: Worktree UX (High Priority — User-Facing Improvements)

3. **Feature 3 — Manual Branch Rename**: Add "Rename Branch" to worktree context menu with inline input. Reuses the `renameBranch` infrastructure from Feature 2.
4. **Feature 4 — Auto-Start First Session**: Simplify auto-start logic. Small change, high UX impact — eliminates a common friction point.
5. **Feature 5 — Worktree from Branch**: New `createWorktreeFromBranch`, branch picker dialog, project context menu entry. Larger scope but independent.

### Sprint 3: Bugfixes (High Priority — Correctness)

6. **Feature 6 — Session Loading State Fix**: Remove premature `resetStreamingState()` call. Small fix, high correctness impact.
7. **Feature 8 — Tool Call Result Detach Fix**: Initialize streaming refs from DB on remount. Medium complexity, correctness critical.
8. **Feature 9 — Streaming Cross-Tab Fix**: Add generation counter to stream subscriptions. Small fix, prevents visible content leak.

### Sprint 4: File Sidebar + UI Polish (Medium Priority)

9. **Feature 7 — File Sidebar Redesign**: New `FileSidebar` wrapper, `ChangesView` component, FileTree prop additions. Largest visual change.
10. **Feature 10 — UI Text Changes**: Remove "Streaming..." text, rename "Task" → "Agent". Trivial changes.

---

## Success Metrics

- Session titles automatically appear within seconds of sending the first message, matching the quality of OpenCode's built-in title generation
- No Haiku API calls are made by Hive for title generation (all title generation is server-side)
- The `renameSession` API correctly sets manual titles that the server does not overwrite
- Branch names automatically change from city names to descriptive names derived from the first session title
- Manually renamed branches are never auto-renamed again
- "Rename Branch" appears in the worktree context menu and successfully renames the git branch
- The sidebar immediately reflects branch name changes
- Entering a worktree with 0 sessions automatically creates and opens the first session
- The "Click + to create one" empty state is never shown when `autoStartSession` is enabled
- "New Workspace From..." shows a filterable branch list and correctly creates worktrees from any branch
- Already-checked-out branches are duplicated when selected
- Switching to a tab with a streaming session preserves the spinning/loading indicator
- Sending a tool call, switching tabs, and switching back shows the result merged into the original tool card
- Streaming content from one session never appears in another session's tab
- The "Streaming..." blue text is gone from the UI
- Tool calls using the "task" tool display "Agent" instead of "Task" in the collapsed header
- The Changes tab shows files grouped by git status (staged, unstaged, untracked) with bulk actions
- The Files tab shows a clean file tree without git status indicators
