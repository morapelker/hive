# Hive Phase 11 Implementation Plan

This document outlines the implementation plan for Hive Phase 11, focusing on session title simplification (server-side titles), automatic and manual branch renaming, worktree UX improvements (auto-start, create from branch), file sidebar redesign, and streaming/tool-call correctness bugfixes.

---

## Overview

The implementation is divided into **12 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 11 builds upon Phase 10** — all Phase 10 infrastructure is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 11)

```
test/
├── phase-11/
│   ├── session-1/
│   │   └── remove-haiku-naming.test.ts
│   ├── session-2/
│   │   └── server-title-events.test.ts
│   ├── session-3/
│   │   └── branch-rename-infra.test.ts
│   ├── session-4/
│   │   └── auto-rename-branch.test.ts
│   ├── session-5/
│   │   └── manual-branch-rename.test.ts
│   ├── session-6/
│   │   └── auto-start-session.test.ts
│   ├── session-7/
│   │   └── worktree-from-branch.test.ts
│   ├── session-8/
│   │   └── streaming-bugfixes.test.ts
│   ├── session-9/
│   │   └── file-sidebar-tabs.test.ts
│   ├── session-10/
│   │   └── changes-view.test.ts
│   ├── session-11/
│   │   └── ui-text-changes.test.ts
│   └── session-12/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies — all features use existing packages:
# - @opencode-ai/sdk (session.patch, session status already available)
# - simple-git (branch -m for rename — already installed)
# - zustand (stores — already installed)
# - lucide-react (icons — already installed)
# - @tanstack/react-virtual (ChangesView can reuse — already installed)
```

---

## Session 1: Remove Custom Haiku Naming System

### Objectives

- Remove the entire custom title generation system (Haiku calls, naming callbacks, temporary sessions, fire-and-forget triggers)
- Change the default session title format to match the server expectation
- Ensure the app still functions with the old timestamp-based titles until server titles arrive

### Tasks

#### 1. Remove `NamingCallback` infrastructure from `opencode-service.ts`

In `src/main/services/opencode-service.ts`:

- Delete the `NamingCallback` interface (lines 141-147)
- Delete the `namingCallbacks` Map declaration (line 155)
- Delete all naming callback event routing in `handleEvent()` (lines 1017-1049) — the block that checks if an event's session ID is in `namingCallbacks`, collects text deltas, and resolves on `session.idle`
- Delete the `generateSessionName()` method entirely (lines 1159-1231)

#### 2. Remove `generateSessionName` IPC handler

In `src/main/ipc/opencode-handlers.ts`:

- Delete the `opencode:generateSessionName` handler (lines 142-163)

#### 3. Remove `generateSessionName` from preload

In `src/preload/index.ts`:

- Remove the `generateSessionName` method from the `opencodeOps` namespace (lines 675-679)

In `src/preload/index.d.ts`:

- Remove the `generateSessionName` declaration from the `opencodeOps` interface (line 310)

#### 4. Remove naming trigger from SessionView

In `src/renderer/src/components/sessions/SessionView.tsx`:

- Delete the `hasTriggeredNamingRef` declaration
- Delete the fire-and-forget naming block that calls `window.opencodeOps.generateSessionName()` (lines 1474-1502)
- Remove any imports related to the naming flow

#### 5. Update default session title format in store

In `src/renderer/src/stores/useSessionStore.ts`:

- Delete the `generateSessionName()` utility function (lines 57-63 — the one that produces `"Session HH:MM"`)
- Change the `createSession` method's name value (line 152) from `generateSessionName()` to:

```typescript
name: `New session - ${new Date().toISOString()}`
```

This format matches the server's default title regex so the server's `ensureTitle` guard recognizes it as a placeholder and will auto-generate a proper title.

#### 6. Verify no remaining references

Search the codebase for any remaining references to `generateSessionName`, `namingCallbacks`, `hasTriggeredNamingRef`, or `NamingCallback` and remove them.

### Key Files

- `src/main/services/opencode-service.ts` — remove naming infrastructure
- `src/main/ipc/opencode-handlers.ts` — remove IPC handler
- `src/preload/index.ts` — remove preload method
- `src/preload/index.d.ts` — remove type declaration
- `src/renderer/src/components/sessions/SessionView.tsx` — remove naming trigger
- `src/renderer/src/stores/useSessionStore.ts` — remove utility, update default title

### Definition of Done

- [ ] `NamingCallback` interface and `namingCallbacks` Map no longer exist
- [ ] `generateSessionName()` method removed from opencode-service
- [ ] `opencode:generateSessionName` IPC handler removed
- [ ] `generateSessionName` removed from preload and type declarations
- [ ] `hasTriggeredNamingRef` and fire-and-forget naming block removed from SessionView
- [ ] Local `generateSessionName()` utility removed from session store
- [ ] New sessions are created with title format `"New session - <ISO date>"`
- [ ] No console errors when sending the first message (no calls to removed APIs)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start the app, create a new session
2. Verify the tab shows a title like `"New session - 2026-02-10T..."`
3. Send a message — verify NO Haiku API call is made (check main process logs for absence of `generateSessionName`)
4. Verify no console errors related to missing `generateSessionName`
5. (Titles won't auto-update yet — that comes in Session 2)

### Testing Criteria

```typescript
// test/phase-11/session-1/remove-haiku-naming.test.ts
describe('Session 1: Remove Haiku Naming', () => {
  test('createSession uses ISO date format title', () => {
    // Mock window.db.session.create
    // Call useSessionStore.getState().createSession(worktreeId, projectId)
    // Verify name matches /^New session - \d{4}-\d{2}-\d{2}T/
  })

  test('generateSessionName no longer exists on window.opencodeOps', () => {
    expect(window.opencodeOps.generateSessionName).toBeUndefined()
  })

  test('no naming-related refs in SessionView', () => {
    // Verify hasTriggeredNamingRef is not present in component
    // (source-level verification)
  })
})
```

---

## Session 2: Handle Server-Side Title Events + Manual Rename API

### Objectives

- Handle `session.updated` SSE events in both the main process (persist to DB) and renderer (update store)
- Add `renameSession` method for manual title changes via the OpenCode PATCH API
- Wire up the full IPC chain for `renameSession`

### Tasks

#### 1. Handle `session.updated` events in main process

In `src/main/services/opencode-service.ts`, in the `handleEvent()` method, add handling for `session.updated` events. When the event contains a title, persist it to the DB:

```typescript
if (eventType === 'session.updated') {
  const sessionData = event.properties
  const opencodeSessionId = sessionData?.id || sessionData?.sessionID
  if (opencodeSessionId) {
    const hiveSessionId = this.getMappedHiveSessionId(opencodeSessionId)
    if (hiveSessionId && sessionData?.title) {
      try {
        db.updateSession(hiveSessionId, { name: sessionData.title })
      } catch (err) {
        log.warn('Failed to persist session title from server', { err })
      }
    }
  }
  // Continue to forward event to renderer (existing generic forwarding handles this)
}
```

Ensure this block runs before the generic event forwarding so the DB is updated before the renderer processes it.

#### 2. Handle `session.updated` events in renderer

In `src/renderer/src/components/sessions/SessionView.tsx`, in the stream event handler, add a branch for `session.updated`:

```typescript
if (event.type === 'session.updated') {
  const sessionData = event.data
  if (sessionData?.title) {
    useSessionStore.getState().updateSessionName(sessionId, sessionData.title)
  }
  return
}
```

Place this before the existing `message.part.updated` branch.

#### 3. Add `renameSession` service method

In `src/main/services/opencode-service.ts`, add a new public method:

```typescript
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

#### 4. Add `renameSession` IPC handler

In `src/main/ipc/opencode-handlers.ts`:

```typescript
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

#### 5. Expose `renameSession` in preload

In `src/preload/index.ts`, add to `opencodeOps`:

```typescript
renameSession: (
  opencodeSessionId: string,
  title: string,
  worktreePath?: string
): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('opencode:renameSession', { opencodeSessionId, title, worktreePath }),
```

In `src/preload/index.d.ts`, add to the `opencodeOps` interface:

```typescript
renameSession: (opencodeSessionId: string, title: string, worktreePath?: string) =>
  Promise<{ success: boolean; error?: string }>
```

### Key Files

- `src/main/services/opencode-service.ts` — `session.updated` handling, `renameSession()` method
- `src/main/ipc/opencode-handlers.ts` — `opencode:renameSession` handler
- `src/preload/index.ts` — preload bridge
- `src/preload/index.d.ts` — type declarations
- `src/renderer/src/components/sessions/SessionView.tsx` — `session.updated` stream handler

### Definition of Done

- [ ] `session.updated` events with a title field update the session name in the DB (main process)
- [ ] `session.updated` events update the session name in the renderer store
- [ ] Session tab title updates within seconds of sending the first message
- [ ] Session history list reflects the new title
- [ ] `renameSession()` calls `client.session.patch()` with the title
- [ ] `opencode:renameSession` IPC handler registered
- [ ] Preload exposes `renameSession()` on `window.opencodeOps`
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a new session, send a message like "help me debug the auth module"
2. Wait 3-5 seconds — verify the tab title changes from `"New session - ..."` to a descriptive title (e.g., "Auth module debugging")
3. Open session history — verify the title is also updated there
4. Test `renameSession` from devtools: call `window.opencodeOps.renameSession(opencodeSessionId, 'My Custom Title', worktreePath)` — verify the tab updates

### Testing Criteria

```typescript
// test/phase-11/session-2/server-title-events.test.ts
describe('Session 2: Server Title Events', () => {
  test('session.updated event updates session name in store', () => {
    const updateSessionName = vi.fn()
    // Mock useSessionStore.getState().updateSessionName
    // Simulate stream event: { type: 'session.updated', sessionId: 'hive-1', data: { title: 'Auth debugging' } }
    // Verify updateSessionName called with ('hive-1', 'Auth debugging')
  })

  test('session.updated without title is ignored', () => {
    // Simulate event with no title field
    // Verify updateSessionName NOT called
  })

  test('renameSession IPC calls session.patch', () => {
    // Mock openCodeService.renameSession
    // Invoke 'opencode:renameSession' handler
    // Verify renameSession called with correct args
  })

  test('preload exposes renameSession', () => {
    expect(window.opencodeOps.renameSession).toBeDefined()
  })
})
```

---

## Session 3: Branch Rename Infrastructure

### Objectives

- Add the `canonicalizeBranchName()` utility
- Add the `renameBranch()` method to git-service
- Wire up the IPC channel for branch renaming
- Add the `branch_renamed` column to the worktrees table via DB migration
- Export the city names list for checking auto-generated names

### Tasks

#### 1. Add `canonicalizeBranchName` utility

In `src/main/services/git-service.ts`, add as an exported function:

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

#### 2. Add `renameBranch` method to git-service

In `src/main/services/git-service.ts`, add:

```typescript
/**
 * Rename a branch in a worktree directory.
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

#### 3. Export city names list

In `src/main/services/city-names.ts`, ensure the city names array is exported:

```typescript
export const CITY_NAMES = [
  /* existing list */
]
```

If it's currently `const cityNames = [...]` and only used internally, rename and export it.

#### 4. Add DB migration for `branch_renamed`

In `src/main/db/schema.ts`, bump `CURRENT_SCHEMA_VERSION` and add a new migration:

```typescript
{
  version: CURRENT_SCHEMA_VERSION,
  up: (db) => {
    db.exec('ALTER TABLE worktrees ADD COLUMN branch_renamed INTEGER NOT NULL DEFAULT 0')
  }
}
```

#### 5. Update `Worktree` type

In `src/preload/index.d.ts`, add to the `Worktree` interface:

```typescript
branch_renamed?: number  // 0 = auto-named (city), 1 = user/auto renamed
```

#### 6. Add `worktree:renameBranch` IPC handler

In `src/main/ipc/worktree-handlers.ts`:

```typescript
ipcMain.handle(
  'worktree:renameBranch',
  async (
    _event,
    {
      worktreeId,
      worktreePath,
      oldBranch,
      newBranch
    }: { worktreeId: string; worktreePath: string; oldBranch: string; newBranch: string }
  ) => {
    log.info('IPC: worktree:renameBranch', { worktreePath, oldBranch, newBranch })
    try {
      const result = await gitService.renameBranch(worktreePath, oldBranch, newBranch)
      if (result.success) {
        db.updateWorktree(worktreeId, { branch: newBranch, branch_renamed: 1 })
      }
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

#### 7. Expose in preload

In `src/preload/index.ts`, add to `worktreeOps`:

```typescript
renameBranch: (
  worktreeId: string,
  worktreePath: string,
  oldBranch: string,
  newBranch: string
): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('worktree:renameBranch', { worktreeId, worktreePath, oldBranch, newBranch }),
```

In `src/preload/index.d.ts`, add to `worktreeOps`:

```typescript
renameBranch: (worktreeId: string, worktreePath: string, oldBranch: string, newBranch: string) =>
  Promise<{ success: boolean; error?: string }>
```

#### 8. Add `updateWorktreeBranch` to the worktree store

In `src/renderer/src/stores/useWorktreeStore.ts`, add:

```typescript
updateWorktreeBranch: (worktreeId: string, newBranch: string) => {
  set((state) => ({
    worktrees: state.worktrees.map((w) => (w.id === worktreeId ? { ...w, branch: newBranch } : w))
  }))
}
```

### Key Files

- `src/main/services/git-service.ts` — `canonicalizeBranchName()`, `renameBranch()`
- `src/main/services/city-names.ts` — export `CITY_NAMES`
- `src/main/db/schema.ts` — migration for `branch_renamed`
- `src/main/ipc/worktree-handlers.ts` — `worktree:renameBranch` handler
- `src/preload/index.ts` — preload bridge
- `src/preload/index.d.ts` — type declarations, `Worktree` type update
- `src/renderer/src/stores/useWorktreeStore.ts` — `updateWorktreeBranch`

### Definition of Done

- [ ] `canonicalizeBranchName('Auth Refresh Token Support')` returns `'auth-refresh-token-support'`
- [ ] `canonicalizeBranchName` handles edge cases: double spaces, special chars, >50 char strings, empty input
- [ ] `renameBranch()` calls `git branch -m oldBranch newBranch`
- [ ] DB migration adds `branch_renamed` column to worktrees table
- [ ] `Worktree` type includes `branch_renamed`
- [ ] `worktree:renameBranch` IPC handler renames branch and updates DB
- [ ] `updateWorktreeBranch` updates the store so the sidebar reflects changes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Test `canonicalizeBranchName` with various inputs from devtools
2. Test `renameBranch` via IPC from devtools: pick a worktree, call `window.worktreeOps.renameBranch(id, path, 'old', 'new')`, verify `git branch` shows new name
3. Verify `branch_renamed` column exists in DB after migration

### Testing Criteria

```typescript
// test/phase-11/session-3/branch-rename-infra.test.ts
describe('Session 3: Branch Rename Infrastructure', () => {
  describe('canonicalizeBranchName', () => {
    test('converts spaces to dashes and lowercases', () => {
      expect(canonicalizeBranchName('Auth Refresh Token')).toBe('auth-refresh-token')
    })

    test('removes special characters', () => {
      expect(canonicalizeBranchName('Fix #123: Bug!')).toBe('fix-123-bug')
    })

    test('collapses consecutive dashes', () => {
      expect(canonicalizeBranchName('fix -- double  spaces')).toBe('fix-double-spaces')
    })

    test('truncates to 50 characters', () => {
      const long = 'a'.repeat(60)
      expect(canonicalizeBranchName(long).length).toBeLessThanOrEqual(50)
    })

    test('strips trailing dashes after truncation', () => {
      const input = 'a'.repeat(49) + '-b'
      const result = canonicalizeBranchName(input)
      expect(result.endsWith('-')).toBe(false)
    })

    test('returns empty string for empty input', () => {
      expect(canonicalizeBranchName('')).toBe('')
    })

    test('preserves dots and slashes', () => {
      expect(canonicalizeBranchName('feature/auth.v2')).toBe('feature/auth.v2')
    })

    test('converts underscores to dashes', () => {
      expect(canonicalizeBranchName('fix_the_bug')).toBe('fix-the-bug')
    })
  })

  describe('renameBranch IPC', () => {
    test('worktree:renameBranch handler exists', () => {
      // Source verification
    })

    test('preload exposes renameBranch on worktreeOps', () => {
      expect(window.worktreeOps.renameBranch).toBeDefined()
    })
  })
})
```

---

## Session 4: Auto-Rename Branch on First Title

### Objectives

- When a server-generated title arrives for a session, auto-rename the worktree branch from the city name to a canonicalized version of the title
- Only rename if the branch is still an original city name (not manually renamed)
- Only rename once per worktree (use `branch_renamed` flag)

### Tasks

#### 1. Add auto-rename logic in main process

In `src/main/services/opencode-service.ts`, extend the `session.updated` handler from Session 2. After persisting the title, check if the branch should be auto-renamed:

```typescript
// After: db.updateSession(hiveSessionId, { name: sessionData.title })

// Auto-rename branch if still a city name
const worktree = db.getWorktreeBySessionId(hiveSessionId)
if (worktree && !worktree.branch_renamed) {
  const isCityName = CITY_NAMES.some((city) => city.toLowerCase() === worktree.branch.toLowerCase())
  if (isCityName) {
    const newBranch = canonicalizeBranchName(sessionData.title)
    if (newBranch && newBranch !== worktree.branch.toLowerCase()) {
      try {
        const renameResult = await gitService.renameBranch(
          worktree.path,
          worktree.branch,
          newBranch
        )
        if (renameResult.success) {
          db.updateWorktree(worktree.id, { branch: newBranch, branch_renamed: 1 })
          // Notify renderer to update the sidebar
          this.sendToRenderer('worktree:branchRenamed', {
            worktreeId: worktree.id,
            newBranch
          })
        }
      } catch (err) {
        log.warn('Failed to auto-rename branch', { err })
      }
    }
  }
}
```

#### 2. Add DB helper to look up worktree by session ID

If `db.getWorktreeBySessionId()` doesn't exist, add it to the DB service:

```typescript
getWorktreeBySessionId(sessionId: string): Worktree | undefined {
  const session = this.db.prepare('SELECT worktree_id FROM sessions WHERE id = ?').get(sessionId)
  if (!session) return undefined
  return this.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(session.worktree_id)
}
```

#### 3. Listen for `worktree:branchRenamed` in renderer

In the renderer, set up a listener (in `useWorktreeStore.ts` or in a global listener hook) for the `worktree:branchRenamed` event:

```typescript
window.worktreeOps?.onBranchRenamed?.((data) => {
  const { worktreeId, newBranch } = data
  useWorktreeStore.getState().updateWorktreeBranch(worktreeId, newBranch)
})
```

Use the preload's typed namespace pattern similar to how `onStream` works.

#### 4. Import dependencies in opencode-service

Add imports for `CITY_NAMES`, `canonicalizeBranchName`, and `gitService` at the top of the file where they'll be used in the event handler.

### Key Files

- `src/main/services/opencode-service.ts` — auto-rename in `session.updated` handler
- `src/main/db/` — `getWorktreeBySessionId` helper (if needed)
- `src/renderer/src/stores/useWorktreeStore.ts` — listen for `worktree:branchRenamed`
- `src/preload/index.ts` — expose `worktree:branchRenamed` listener (if needed)

### Definition of Done

- [ ] When first title arrives and branch is a city name, branch is renamed to canonicalized title
- [ ] `branch_renamed` flag set to 1 after rename
- [ ] Second title update does NOT trigger another rename
- [ ] If branch was already manually renamed (not a city name), no rename occurs
- [ ] Sidebar immediately reflects the new branch name
- [ ] Git branch is actually renamed on disk (`git branch` shows new name)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a new worktree — verify it gets a city name (e.g., "tokyo")
2. Create a session and send "help me set up authentication"
3. Wait for the title to arrive — verify the branch name changes from "tokyo" to something like "auth-setup" in the sidebar
4. Verify `git branch` in the worktree directory shows the new branch name
5. Send another message — verify the branch is NOT renamed again
6. Create another worktree, manually rename its branch (Session 5), then send a message — verify the branch is NOT auto-renamed

### Testing Criteria

```typescript
// test/phase-11/session-4/auto-rename-branch.test.ts
describe('Session 4: Auto-Rename Branch', () => {
  test('branch renamed when city name and first title arrives', () => {
    // Mock: worktree with branch 'tokyo', branch_renamed: 0
    // Simulate session.updated with title 'Auth Setup Guide'
    // Verify renameBranch called with ('tokyo', 'auth-setup-guide')
    // Verify DB updated with branch_renamed: 1
  })

  test('branch NOT renamed when already renamed', () => {
    // Mock: worktree with branch 'custom-name', branch_renamed: 1
    // Simulate session.updated with title 'New Title'
    // Verify renameBranch NOT called
  })

  test('branch NOT renamed when name is not a city', () => {
    // Mock: worktree with branch 'my-feature', branch_renamed: 0
    // Simulate session.updated with title 'New Title'
    // Verify renameBranch NOT called (branch not in CITY_NAMES)
  })

  test('renderer receives branchRenamed event', () => {
    // Mock worktree:branchRenamed IPC event
    // Verify updateWorktreeBranch called in store
  })
})
```

---

## Session 5: Manual Branch Rename via Context Menu

### Objectives

- Add a "Rename Branch" option to the worktree context menu and dropdown menu
- Show an inline text input for the new branch name
- On submit, call the rename IPC and update the store

### Tasks

#### 1. Add rename state to WorktreeItem

In `src/renderer/src/components/worktrees/WorktreeItem.tsx`, add state:

```typescript
const [isRenamingBranch, setIsRenamingBranch] = useState(false)
const [branchNameInput, setBranchNameInput] = useState('')
```

#### 2. Add "Rename Branch" menu item

Add to both the dropdown menu (lines 193-232) and the context menu (lines 238-277), after "Copy Path" and before "Duplicate":

```typescript
<DropdownMenuSeparator />
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

Only show for non-default worktrees (same guard as Duplicate).

#### 3. Add inline rename input

When `isRenamingBranch` is true, replace the branch name display area with an input field:

```typescript
{isRenamingBranch ? (
  <input
    autoFocus
    value={branchNameInput}
    onChange={(e) => setBranchNameInput(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === 'Enter') handleBranchRename()
      if (e.key === 'Escape') setIsRenamingBranch(false)
    }}
    onBlur={() => setIsRenamingBranch(false)}
    className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full"
  />
) : (
  // existing branch name display
)}
```

#### 4. Implement rename handler

```typescript
const handleBranchRename = async () => {
  const trimmed = branchNameInput.trim()
  if (!trimmed || trimmed === worktree.branch) {
    setIsRenamingBranch(false)
    return
  }

  // Canonicalize for safety
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

  const result = await window.worktreeOps.renameBranch(
    worktree.id,
    worktree.path,
    worktree.branch,
    newBranch
  )

  if (result.success) {
    useWorktreeStore.getState().updateWorktreeBranch(worktree.id, newBranch)
    toast.success(`Branch renamed to ${newBranch}`)
  } else {
    toast.error(result.error || 'Failed to rename branch')
  }
  setIsRenamingBranch(false)
}
```

#### 5. Add Pencil icon import

Add `Pencil` to the lucide-react import at the top of the file if not already imported.

### Key Files

- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — menu item, inline input, handler

### Definition of Done

- [ ] "Rename Branch" appears in both the dropdown and context menu for non-default worktrees
- [ ] Clicking it shows an inline text input pre-filled with the current branch name
- [ ] Pressing Enter submits the rename
- [ ] Pressing Escape or clicking away cancels
- [ ] The input value is canonicalized before sending
- [ ] Git branch is renamed on success
- [ ] DB record updated with `branch_renamed: 1`
- [ ] Sidebar immediately reflects the new name
- [ ] Toast notification on success/failure
- [ ] Invalid branch names show an error toast
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Right-click a non-default worktree in the sidebar
2. Click "Rename Branch" — verify input appears with current branch name
3. Type a new name like "my-feature-branch", press Enter
4. Verify the sidebar updates, toast shows success
5. Verify `git branch` shows the new name
6. Try renaming with invalid chars (e.g., "my branch!!!") — verify it gets canonicalized
7. Press Escape instead of Enter — verify rename is cancelled
8. Verify "Rename Branch" does NOT appear for the default worktree

### Testing Criteria

```typescript
// test/phase-11/session-5/manual-branch-rename.test.ts
describe('Session 5: Manual Branch Rename', () => {
  test('Rename Branch menu item renders for non-default worktree', () => {
    // Render WorktreeItem with is_default: false
    // Open context menu
    // Verify "Rename Branch" item exists
  })

  test('Rename Branch menu item NOT rendered for default worktree', () => {
    // Render WorktreeItem with is_default: true
    // Open context menu
    // Verify "Rename Branch" item does NOT exist
  })

  test('clicking Rename Branch shows input', () => {
    // Click "Rename Branch"
    // Verify input element appears with current branch name
  })

  test('Enter submits rename', () => {
    // Mock window.worktreeOps.renameBranch returning success
    // Show input, change value, press Enter
    // Verify renameBranch called with correct args
  })

  test('Escape cancels rename', () => {
    // Show input, press Escape
    // Verify renameBranch NOT called
    // Verify input disappears
  })

  test('invalid input shows error', () => {
    // Show input, set value to '' (empty after canonicalization)
    // Submit
    // Verify error toast
  })
})
```

---

## Session 6: Auto-Start First Session on Worktree Entry

### Objectives

- Simplify the auto-start logic from project-wide to per-worktree
- When entering a worktree with 0 sessions, automatically create the first one

### Tasks

#### 1. Simplify auto-start `useEffect` in SessionTabs

In `src/renderer/src/components/sessions/SessionTabs.tsx`, replace the auto-start effect (lines 198-237):

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
  useSessionStore.getState().createSession(selectedWorktreeId, project.id)
}, [selectedWorktreeId, project, isLoading, autoStartSession])
```

This removes:

- The async `window.db.session.getByProject(project.id)` call
- The project-wide "any active session?" guard
- The re-check after the async call

#### 2. Verify `autoStartSession` setting still respected

The setting toggle in `SettingsGeneral.tsx` should continue to work — when disabled, no auto-start occurs.

### Key Files

- `src/renderer/src/components/sessions/SessionTabs.tsx` — simplify auto-start effect

### Definition of Done

- [ ] Entering a worktree with 0 sessions auto-creates a session (when setting enabled)
- [ ] Entering a worktree with existing sessions does NOT auto-create
- [ ] Auto-start works even when other worktrees in the project have active sessions
- [ ] Disabling the `autoStartSession` setting prevents auto-creation
- [ ] Auto-start only fires once per worktree selection (no duplicates)
- [ ] The "No sessions yet. Click + to create one." message is never shown when setting is enabled
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a new worktree — verify a session is automatically created
2. Switch to a different worktree that has sessions, then switch back — verify no duplicate session created
3. Create another new worktree while the first has an active session — verify auto-start still works for the new worktree
4. Go to Settings, disable "Auto-start session" — create a new worktree — verify no auto-start, see "Click + to create one."
5. Re-enable the setting — create another new worktree — verify auto-start resumes

### Testing Criteria

```typescript
// test/phase-11/session-6/auto-start-session.test.ts
describe('Session 6: Auto-Start Session', () => {
  test('auto-creates session when worktree has 0 sessions', () => {
    // Mock: selectedWorktreeId set, sessions empty, autoStartSession true
    // Verify createSession called with (worktreeId, projectId)
  })

  test('does NOT create when worktree has existing sessions', () => {
    // Mock: sessions.length > 0
    // Verify createSession NOT called
  })

  test('does NOT create when setting disabled', () => {
    // Mock: autoStartSession false
    // Verify createSession NOT called
  })

  test('does NOT create duplicate on re-render', () => {
    // Trigger effect twice with same worktreeId
    // Verify createSession called only once
  })

  test('creates for new worktree even when other worktrees have sessions', () => {
    // Mock: worktree A has sessions, switch to worktree B with 0 sessions
    // Verify createSession called for worktree B
  })
})
```

---

## Session 7: Create Worktree from Specific Branch

### Objectives

- Add `createWorktreeFromBranch()` and `listBranchesWithStatus()` to git-service
- Wire up IPC handlers
- Build the branch picker dialog
- Add "New Workspace From..." to the project context menu

### Tasks

#### 1. Add `listBranchesWithStatus` to git-service

In `src/main/services/git-service.ts`:

```typescript
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

  const checkedOut = new Map<string, string>()
  const blocks = worktreeList.split('\n\n').filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n')
    const wtPath = lines.find((l) => l.startsWith('worktree '))?.replace('worktree ', '')
    const branch = lines.find((l) => l.startsWith('branch '))?.replace('branch refs/heads/', '')
    if (wtPath && branch) checkedOut.set(branch, wtPath)
  }

  return Object.entries(branchSummary.branches).map(([name, info]) => ({
    name: info.name,
    isRemote: name.startsWith('remotes/'),
    isCheckedOut: checkedOut.has(info.name),
    worktreePath: checkedOut.get(info.name)
  }))
}
```

#### 2. Add `createWorktreeFromBranch` to git-service

In `src/main/services/git-service.ts`:

```typescript
async createWorktreeFromBranch(
  projectName: string,
  branchName: string
): Promise<CreateWorktreeResult> {
  // Check if branch is already checked out
  const worktreeList = await this.git.raw(['worktree', 'list', '--porcelain'])
  const blocks = worktreeList.split('\n\n').filter(Boolean)

  for (const block of blocks) {
    const lines = block.split('\n')
    const branch = lines.find((l) => l.startsWith('branch '))?.replace('branch refs/heads/', '')
    const wtPath = lines.find((l) => l.startsWith('worktree '))?.replace('worktree ', '')
    if (branch === branchName && wtPath) {
      // Already checked out — duplicate it
      return this.duplicateWorktree(branchName, wtPath, projectName)
    }
  }

  // Not checked out — create worktree using existing branch
  const dirName = branchName
    .replace(/[/\\]/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase()

  const worktreeBase = path.join(os.homedir(), '.hive-worktrees', projectName)
  const worktreePath = path.join(worktreeBase, dirName)

  await fs.mkdir(worktreeBase, { recursive: true })
  await this.git.raw(['worktree', 'add', worktreePath, branchName])

  return { path: worktreePath, branch: branchName, name: dirName }
}
```

#### 3. Add IPC handlers

In `src/main/ipc/worktree-handlers.ts`:

```typescript
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
      const gitSvc = new GitService(projectPath)
      const result = await gitSvc.createWorktreeFromBranch(projectName, branchName)
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
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  }
)

ipcMain.handle(
  'git:listBranchesWithStatus',
  async (_event, { projectPath }: { projectPath: string }) => {
    try {
      const gitSvc = new GitService(projectPath)
      const branches = await gitSvc.listBranchesWithStatus()
      return { success: true, branches }
    } catch (error) {
      return {
        success: false,
        branches: [],
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
)
```

#### 4. Expose in preload

In `src/preload/index.ts`, add to `worktreeOps`:

```typescript
createFromBranch: (
  projectId: string,
  projectPath: string,
  projectName: string,
  branchName: string
): Promise<{ success: boolean; worktree?: Worktree; error?: string }> =>
  ipcRenderer.invoke('worktree:createFromBranch', { projectId, projectPath, projectName, branchName }),
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

Add type declarations in `src/preload/index.d.ts`.

#### 5. Create BranchPickerDialog component

Create `src/renderer/src/components/worktrees/BranchPickerDialog.tsx`:

- Uses the shadcn `Dialog` component
- Filter input at the top (debounced)
- Scrollable list of branches
- Each branch shows: name, "(remote)" badge if remote, "(active)" badge if checked out
- Clicking a branch calls `onSelect(branchName)` and closes the dialog
- Loading spinner while fetching branches

#### 6. Add "New Workspace From..." to project context menu

In `src/renderer/src/components/projects/ProjectItem.tsx`:

- Add state: `const [branchPickerOpen, setBranchPickerOpen] = useState(false)`
- Add menu item after existing items (before the separator):

```typescript
<ContextMenuItem onClick={() => setBranchPickerOpen(true)}>
  <GitBranch className="h-3.5 w-3.5 mr-2" />
  New Workspace From...
</ContextMenuItem>
```

- Add the dialog at the component's JSX root level:

```typescript
<BranchPickerDialog
  open={branchPickerOpen}
  onOpenChange={setBranchPickerOpen}
  projectPath={project.path}
  onSelect={handleBranchSelect}
/>
```

- Implement `handleBranchSelect`:

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

### Key Files

- `src/main/services/git-service.ts` — `createWorktreeFromBranch()`, `listBranchesWithStatus()`
- `src/main/ipc/worktree-handlers.ts` — IPC handlers
- `src/preload/index.ts` — preload bridge
- `src/preload/index.d.ts` — type declarations
- `src/renderer/src/components/worktrees/BranchPickerDialog.tsx` — **NEW**
- `src/renderer/src/components/projects/ProjectItem.tsx` — menu item, dialog, handler

### Definition of Done

- [ ] `listBranchesWithStatus` returns all local and remote branches with checkout status
- [ ] `createWorktreeFromBranch` creates a worktree from an un-checked-out branch
- [ ] `createWorktreeFromBranch` duplicates when the branch is already checked out
- [ ] Branch picker dialog shows all branches with filter
- [ ] Branches show remote/active badges
- [ ] Selecting a branch creates a worktree and selects it
- [ ] "New Workspace From..." appears in the project context menu
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Right-click a project in the sidebar — verify "New Workspace From..." appears
2. Click it — verify dialog opens with branch list
3. Type in filter — verify list filters
4. Click a branch that's NOT checked out — verify worktree created, sidebar shows it, auto-selected
5. Click a branch that IS already checked out — verify a duplicate is created (e.g., `main-v2`)
6. Verify the new worktree directory exists on disk with the correct branch checked out

### Testing Criteria

```typescript
// test/phase-11/session-7/worktree-from-branch.test.ts
describe('Session 7: Worktree from Branch', () => {
  test('listBranchesWithStatus returns branches with status', () => {
    // Mock git.branch and git.raw for worktree list
    // Verify output has name, isRemote, isCheckedOut fields
  })

  test('createWorktreeFromBranch creates from unchecked branch', () => {
    // Mock git.raw for worktree list (branch not checked out)
    // Verify git worktree add called with correct path and branch
  })

  test('createWorktreeFromBranch duplicates checked-out branch', () => {
    // Mock git.raw for worktree list (branch IS checked out)
    // Verify duplicateWorktree called
  })

  test('BranchPickerDialog renders branches', () => {
    // Mock gitOps.listBranchesWithStatus
    // Open dialog
    // Verify branches rendered
  })

  test('BranchPickerDialog filters branches', () => {
    // Type in filter input
    // Verify list updates
  })

  test('ProjectItem shows New Workspace From... menu item', () => {
    // Render ProjectItem, open context menu
    // Verify menu item exists
  })
})
```

---

## Session 8: Streaming Bugfixes (Loading State, Cross-Tab Bleed, Tool Call Detach)

### Objectives

- Fix session loading state being cleared when switching tabs to a streaming session
- Fix streaming content bleeding across tabs
- Fix tool call results detaching after session switch during tool execution

### Tasks

#### 1. Fix loading state cleared on tab switch

In `src/renderer/src/components/sessions/SessionView.tsx`, in the `initializeSession` effect:

**Problem**: `resetStreamingState()` is called early (line ~758), which sets `isStreaming = false`. This kills the loading indicator when switching to a tab that's actively streaming.

**Fix**: Replace the full `resetStreamingState()` with a partial clear that only resets display data but NOT the `isStreaming` flag:

```typescript
// BEFORE:
resetStreamingState()

// AFTER:
// Partial clear — reset display data but preserve streaming status
streamingPartsRef.current = []
streamingContentRef.current = ''
childToSubtaskIndexRef.current = new Map()
setStreamingParts([])
setStreamingContent('')
hasFinalizedCurrentResponseRef.current = false
// NOTE: Do NOT set isStreaming = false here
// Let the stream subscription's session.status events control it
```

The `session.status` event handler already correctly sets `isStreaming` based on whether the session is `busy` or `idle`.

#### 2. Fix streaming content bleeding across tabs

**Problem**: When multiple `SessionView` instances are mounted (during tab transitions), stale closures in stream handlers can process events for the wrong session.

**Fix**: Add a generation counter ref to invalidate stale closures:

```typescript
const streamGenerationRef = useRef(0)
```

In the stream subscription effect:

```typescript
useEffect(() => {
  streamGenerationRef.current += 1
  const currentGeneration = streamGenerationRef.current

  // Partial clear for new session
  streamingPartsRef.current = []
  streamingContentRef.current = ''
  setStreamingParts([])
  setStreamingContent('')

  // ... setup code ...

  const unsubscribe = window.opencodeOps.onStream((event) => {
    // Guard 1: session ID check (existing)
    if (event.sessionId !== sessionId) return

    // Guard 2: generation check (NEW — prevents stale closure)
    if (streamGenerationRef.current !== currentGeneration) return

    // ... existing event processing ...
  })

  return () => {
    unsubscribe()
  }
}, [sessionId])
```

#### 3. Fix tool call results detaching after session switch

**Problem**: When switching away from a session with a running tool call and switching back, `streamingPartsRef` is empty. When the tool result arrives, it can't find the matching `callID` and creates a new detached entry.

**Fix**: On remount during an active session, initialize `streamingPartsRef` from the last persisted assistant message's parts:

```typescript
// In initializeSession, after loading messages from DB:
if (messages.length > 0) {
  const lastMsg = messages[messages.length - 1]
  if (lastMsg.role === 'assistant' && lastMsg.opencode_parts_json) {
    try {
      const persistedParts = JSON.parse(lastMsg.opencode_parts_json)
      if (Array.isArray(persistedParts) && persistedParts.length > 0) {
        streamingPartsRef.current = persistedParts.map(convertPersistedPartToStreamingPart)
        setStreamingParts([...streamingPartsRef.current])

        const textParts = persistedParts.filter((p: any) => p.type === 'text')
        if (textParts.length > 0) {
          const content = textParts.map((p: any) => p.content || p.text || '').join('')
          streamingContentRef.current = content
          setStreamingContent(content)
        }
      }
    } catch {
      // Fall through to empty state
    }
  }
}
```

Add a helper function `convertPersistedPartToStreamingPart` that maps the DB-stored part format to the `StreamingPart` format, preserving `callID`, tool name, status, etc.

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — all three fixes

### Definition of Done

- [ ] Switching to a tab with an actively streaming session preserves the spinning indicator
- [ ] Switching to a tab with an idle session correctly shows idle state
- [ ] Streaming content from session A never appears in session B's tab
- [ ] Starting a tool call, switching away, switching back → tool result appears merged into the original tool card
- [ ] No stale closures processing events for wrong sessions
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

**Loading state fix:**

1. Create two sessions in a worktree
2. In session A, send a long prompt that will stream for a while
3. While streaming, switch to session B tab
4. Switch back to session A — verify the loading/streaming indicator is still showing
5. Wait for streaming to finish — verify it correctly transitions to idle

**Cross-tab bleed fix:**

1. Create two sessions in a worktree
2. Start streaming in session A
3. Switch to session B tab — verify NO streaming content appears
4. Switch back to session A — verify streaming content is there
5. Repeat rapidly switching between tabs during streaming

**Tool call detach fix:**

1. Send a prompt that triggers a slow tool call (e.g., a bash command that takes time)
2. While the tool is running (spinner showing), switch to another session tab
3. Wait a moment, then switch back
4. When the tool result arrives, verify it appears inside the original tool card (not as a separate block)

### Testing Criteria

```typescript
// test/phase-11/session-8/streaming-bugfixes.test.ts
describe('Session 8: Streaming Bugfixes', () => {
  describe('Loading state preservation', () => {
    test('partial clear does not reset isStreaming', () => {
      // Simulate: isStreaming = true, then partial clear runs
      // Verify isStreaming remains true
    })

    test('session.status busy sets isStreaming true after remount', () => {
      // Simulate remount + session.status { type: 'busy' }
      // Verify isStreaming set to true
    })
  })

  describe('Cross-tab bleed prevention', () => {
    test('generation counter increments on session change', () => {
      // Change sessionId prop
      // Verify streamGenerationRef incremented
    })

    test('stale closure events are rejected', () => {
      // Subscribe with generation N
      // Increment generation to N+1
      // Send event with session ID matching
      // Verify event is NOT processed (generation mismatch)
    })
  })

  describe('Tool call result reconciliation', () => {
    test('streaming parts restored from DB on remount', () => {
      // Mock: last message has opencode_parts_json with a pending tool call
      // Remount SessionView
      // Verify streamingPartsRef populated with the tool call
    })

    test('tool result merges into restored tool call', () => {
      // Restore parts from DB with callID 'abc123'
      // Receive tool result event for callID 'abc123'
      // Verify result merged, not detached
    })
  })
})
```

---

## Session 9: File Sidebar — Tab Layout Wrapper

### Objectives

- Create the `FileSidebar` component with two tabs: "Changes" and "Files"
- Wire it into the layout replacing the current `FileTree` usage
- The "Files" tab renders the existing `FileTree` with git indicators hidden

### Tasks

#### 1. Create `FileSidebar.tsx`

Create `src/renderer/src/components/file-tree/FileSidebar.tsx`:

```typescript
import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileTree } from './FileTree'
import { ChangesView } from './ChangesView'

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
      <div className="flex items-center border-b border-border px-2 pt-1.5 pb-0">
        <button
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors relative',
            activeTab === 'changes'
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={() => setActiveTab('changes')}
        >
          Changes
          {activeTab === 'changes' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
          )}
        </button>
        <button
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors relative',
            activeTab === 'files'
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={() => setActiveTab('files')}
        >
          Files
          {activeTab === 'files' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
          )}
        </button>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="p-1 text-muted-foreground hover:text-foreground rounded"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === 'changes' ? (
          <ChangesView worktreePath={worktreePath} onFileClick={onFileClick} />
        ) : (
          <FileTree
            worktreePath={worktreePath}
            onClose={onClose}
            onFileClick={onFileClick}
            hideHeader
            hideGitIndicators
            hideGitContextActions
          />
        )}
      </div>
    </div>
  )
}
```

#### 2. Add optional props to FileTree

In `src/renderer/src/components/file-tree/FileTree.tsx`, add props:

```typescript
interface FileTreeProps {
  worktreePath: string
  onClose: () => void
  onFileClick: (filePath: string) => void
  hideHeader?: boolean // NEW — hide the built-in header
  hideGitIndicators?: boolean // NEW — suppress git status badges
  hideGitContextActions?: boolean // NEW — suppress git context menu items
}
```

- When `hideHeader` is true, skip rendering `FileTreeHeader`
- Pass `hideGitIndicators` to `FileTreeNode` (suppress `GitStatusIndicator`)
- Pass `hideGitContextActions` to `FileContextMenu` (suppress stage/unstage/discard items)

#### 3. Update FileTreeNode

In `src/renderer/src/components/file-tree/FileTreeNode.tsx`:

- Accept `hideGitIndicators?: boolean` prop
- When true, don't render the `GitStatusIndicator` component

#### 4. Update FileContextMenu

In `src/renderer/src/components/file-tree/FileContextMenu.tsx`:

- Accept `hideGitContextActions?: boolean` prop
- When true, don't render stage/unstage/discard/gitignore menu items

#### 5. Replace FileTree usage in layout

Find where `FileTree` is rendered in the layout (likely `MainPane.tsx` or a sidebar component) and replace with `FileSidebar`:

```typescript
// BEFORE:
<FileTree worktreePath={worktreePath} onClose={handleClose} onFileClick={handleFileClick} />

// AFTER:
<FileSidebar worktreePath={worktreePath} onClose={handleClose} onFileClick={handleFileClick} />
```

#### 6. Update barrel export

In `src/renderer/src/components/file-tree/index.ts`:

```typescript
export { FileSidebar } from './FileSidebar'
export { ChangesView } from './ChangesView'
```

#### 7. Create placeholder ChangesView

Create `src/renderer/src/components/file-tree/ChangesView.tsx` with a minimal placeholder (full implementation in Session 10):

```typescript
interface ChangesViewProps {
  worktreePath: string
  onFileClick: (filePath: string) => void
}

export function ChangesView({ worktreePath }: ChangesViewProps): React.JSX.Element {
  return (
    <div className="p-4 text-sm text-muted-foreground">
      Changes view — coming next session
    </div>
  )
}
```

### Key Files

- `src/renderer/src/components/file-tree/FileSidebar.tsx` — **NEW**
- `src/renderer/src/components/file-tree/ChangesView.tsx` — **NEW** (placeholder)
- `src/renderer/src/components/file-tree/FileTree.tsx` — add optional props
- `src/renderer/src/components/file-tree/FileTreeNode.tsx` — respect `hideGitIndicators`
- `src/renderer/src/components/file-tree/FileContextMenu.tsx` — respect `hideGitContextActions`
- `src/renderer/src/components/file-tree/index.ts` — exports
- Layout component that renders the sidebar — swap to `FileSidebar`

### Definition of Done

- [ ] `FileSidebar` renders with two tabs: "Changes" and "Files"
- [ ] Clicking tabs switches between views
- [ ] "Files" tab shows the file tree without git status indicators
- [ ] "Files" tab shows the file tree without git context menu items (stage/unstage/discard)
- [ ] "Files" tab includes filter field and standard navigation
- [ ] "Changes" tab shows placeholder (implemented in Session 10)
- [ ] Close button (X) works
- [ ] Tab active state styled with underline indicator
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a worktree with changed files
2. Verify the sidebar shows two tabs: "Changes" and "Files"
3. Default tab is "Changes" — shows placeholder
4. Click "Files" — verify file tree appears without git status badges (no M/A/D indicators)
5. Right-click a file in the "Files" tab — verify no stage/unstage/discard options
6. Verify the filter field works in the "Files" tab
7. Click the X button — verify sidebar closes

### Testing Criteria

```typescript
// test/phase-11/session-9/file-sidebar-tabs.test.ts
describe('Session 9: File Sidebar Tabs', () => {
  test('renders two tabs', () => {
    render(<FileSidebar worktreePath="/test" onClose={vi.fn()} onFileClick={vi.fn()} />)
    expect(screen.getByText('Changes')).toBeInTheDocument()
    expect(screen.getByText('Files')).toBeInTheDocument()
  })

  test('defaults to Changes tab', () => {
    render(<FileSidebar worktreePath="/test" onClose={vi.fn()} onFileClick={vi.fn()} />)
    // Verify Changes tab has active styling
  })

  test('switches to Files tab on click', () => {
    render(<FileSidebar worktreePath="/test" onClose={vi.fn()} onFileClick={vi.fn()} />)
    fireEvent.click(screen.getByText('Files'))
    // Verify FileTree is rendered
  })

  test('Files tab hides git indicators', () => {
    // Render FileTree with hideGitIndicators={true}
    // Verify GitStatusIndicator not rendered
  })

  test('Files tab hides git context actions', () => {
    // Render FileContextMenu with hideGitContextActions={true}
    // Open context menu
    // Verify stage/unstage/discard items not present
  })

  test('close button calls onClose', () => {
    const onClose = vi.fn()
    render(<FileSidebar worktreePath="/test" onClose={onClose} onFileClick={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
```

---

## Session 10: Changes View Implementation

### Objectives

- Implement the full `ChangesView` component with staged/unstaged/untracked file groups
- Add bulk actions: Stage All, Unstage All, Discard All
- Support individual file actions via context menu

### Tasks

#### 1. Implement ChangesView

Replace the placeholder in `src/renderer/src/components/file-tree/ChangesView.tsx`:

```typescript
import { useState, useMemo } from 'react'
import { ChevronDown, ChevronRight, Plus, Minus, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGitStore } from '@/stores'
import { FileIcon } from './FileIcon'
import { GitStatusIndicator } from './GitStatusIndicator'

interface ChangesViewProps {
  worktreePath: string
  onFileClick: (filePath: string) => void
}
```

The component should:

- Subscribe to `useGitStore` for the current worktree's git status
- Group files into three categories:
  - **Staged** — files with `index` status (not `' '` or `'?'`)
  - **Unstaged** — files with `working_dir` status (not `' '` or `'?'`)
  - **Untracked** — files with `'?'` status
- Each group is collapsible with a count badge
- Each file row shows: icon, file name (relative path), git status indicator
- Clicking a file calls `onFileClick` to open the diff viewer

#### 2. Add group headers

Each group has a clickable header that toggles collapse:

```typescript
<button
  onClick={() => toggleGroup('staged')}
  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
>
  {collapsed.has('staged') ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
  Staged ({staged.length})
</button>
```

#### 3. Add bulk actions

At the bottom of the view, add action buttons:

```typescript
<div className="flex items-center gap-2 px-3 py-2 border-t border-border">
  <button
    onClick={handleStageAll}
    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
    title="Stage All"
  >
    <Plus className="h-3 w-3" /> Stage All
  </button>
  <button
    onClick={handleUnstageAll}
    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
    title="Unstage All"
  >
    <Minus className="h-3 w-3" /> Unstage All
  </button>
  <button
    onClick={handleDiscardAll}
    className="text-xs text-destructive/70 hover:text-destructive flex items-center gap-1"
    title="Discard All Changes"
  >
    <Undo2 className="h-3 w-3" /> Discard
  </button>
</div>
```

Wire these to the existing git operations: `window.gitOps.stageFile`, `window.gitOps.unstageFile`, `window.gitOps.discardFile` (or their bulk equivalents if they exist).

#### 4. Add individual file context menu

Right-clicking a file in any group shows a context menu with:

- **Staged files**: Unstage, Open Diff
- **Unstaged files**: Stage, Discard, Open Diff
- **Untracked files**: Stage, Delete

#### 5. Handle empty state

When there are no changes, show: "No changes" message.

### Key Files

- `src/renderer/src/components/file-tree/ChangesView.tsx` — full implementation

### Definition of Done

- [ ] Staged, Unstaged, and Untracked groups displayed with correct file counts
- [ ] Groups are collapsible
- [ ] File rows show icon, relative path, and git status badge
- [ ] Clicking a file opens the diff viewer
- [ ] "Stage All" stages all unstaged + untracked files
- [ ] "Unstage All" unstages all staged files
- [ ] "Discard All" discards all unstaged changes (with confirmation)
- [ ] Right-click context menu provides per-file actions
- [ ] Empty state shown when no changes
- [ ] File list updates when git status changes (via store subscription)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Make changes to files in a worktree (modify, add new, stage some)
2. Open the sidebar, verify "Changes" tab shows grouped files
3. Verify staged files appear under "Staged", modified under "Unstaged", new under "Untracked"
4. Click group headers to collapse/expand
5. Click "Stage All" — verify all files move to Staged group
6. Click "Unstage All" — verify all files move back
7. Right-click a file → Stage → verify it moves to Staged
8. Discard a change — verify file disappears from the list
9. With no changes, verify "No changes" message

### Testing Criteria

```typescript
// test/phase-11/session-10/changes-view.test.ts
describe('Session 10: Changes View', () => {
  test('groups files by git status', () => {
    // Mock useGitStore with staged, unstaged, and untracked files
    // Render ChangesView
    // Verify three groups rendered with correct counts
  })

  test('collapsing a group hides its files', () => {
    // Click the Staged header
    // Verify staged files are hidden
  })

  test('clicking a file calls onFileClick', () => {
    const onFileClick = vi.fn()
    // Render with files, click one
    // Verify onFileClick called with file path
  })

  test('empty state shows message', () => {
    // Mock useGitStore with no changes
    // Verify "No changes" message
  })

  test('Stage All calls gitOps for all unstaged files', () => {
    // Mock window.gitOps.stageFile
    // Click Stage All
    // Verify stageFile called for each unstaged and untracked file
  })
})
```

---

## Session 11: UI Text Changes

### Objectives

- Remove the "Streaming..." blue text from `AssistantCanvas`
- Rename "Task" → "Agent" in `ToolCard` collapsed header
- Update `TaskToolView` fallback text

### Tasks

#### 1. Remove "Streaming..." text

In `src/renderer/src/components/sessions/AssistantCanvas.tsx`, delete lines 266-268:

```typescript
// DELETE:
{isStreaming && (
  <span className="block text-[10px] text-blue-500 animate-pulse mt-2">Streaming...</span>
)}
```

#### 2. Rename "Task" → "Agent" in ToolCard

In `src/renderer/src/components/sessions/ToolCard.tsx`, line 385:

```typescript
// BEFORE:
<span className="font-medium text-foreground shrink-0">Task</span>

// AFTER:
<span className="font-medium text-foreground shrink-0">Agent</span>
```

#### 3. Update TaskToolView fallback

In `src/renderer/src/components/sessions/tools/TaskToolView.tsx`, line 43:

```typescript
// BEFORE:
{
  description || 'Agent Task'
}

// AFTER:
{
  description || 'Sub-agent'
}
```

### Key Files

- `src/renderer/src/components/sessions/AssistantCanvas.tsx` — remove "Streaming..." span
- `src/renderer/src/components/sessions/ToolCard.tsx` — rename "Task" → "Agent"
- `src/renderer/src/components/sessions/tools/TaskToolView.tsx` — update fallback

### Definition of Done

- [ ] No "Streaming..." blue text appears anywhere during streaming
- [ ] The streaming cursor still appears (it's a separate component)
- [ ] Tool calls using the `task` tool show "Agent" in the collapsed header
- [ ] `TaskToolView` expanded view shows "Sub-agent" when no description
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a message and observe streaming — verify no "Streaming..." text, but the pulsing cursor is still visible
2. Send a prompt that triggers a `task` tool call (e.g., something that causes the AI to dispatch a sub-agent) — verify the collapsed tool card shows "Agent" instead of "Task"
3. Expand the tool card — verify fallback text is "Sub-agent" if no description

### Testing Criteria

```typescript
// test/phase-11/session-11/ui-text-changes.test.ts
describe('Session 11: UI Text Changes', () => {
  test('AssistantCanvas does not render Streaming text', () => {
    // Render AssistantCanvas with isStreaming={true}
    // Verify no element with text 'Streaming...'
  })

  test('ToolCard renders Agent instead of Task', () => {
    // Render ToolCard with name='task'
    // Verify text 'Agent' present, 'Task' absent in collapsed header
  })

  test('TaskToolView shows Sub-agent as fallback', () => {
    // Render TaskToolView without description
    // Verify text 'Sub-agent' present
  })
})
```

---

## Session 12: Integration & Verification

### Objectives

- Verify all Phase 11 features work correctly together
- Test cross-feature interactions
- Run lint and tests
- Fix any edge cases or regressions

### Tasks

#### 1. Title → Branch rename end-to-end

- Create a new worktree (city name branch) → create session → send first message → verify title updates → verify branch auto-renames → verify sidebar shows new branch name
- Send another message → verify no second rename

#### 2. Manual rename after auto-rename

- After a branch was auto-renamed, right-click → Rename Branch → enter new name → verify it sticks
- Send another message with new title → verify branch is NOT renamed again (branch_renamed = 1)

#### 3. Auto-start + title flow

- Create a new worktree → verify session auto-creates → send a message → verify title and branch update correctly

#### 4. Worktree from branch + sessions

- Create a worktree from a specific branch → verify auto-start creates a session → send a message → verify title appears

#### 5. Streaming bugfixes with file sidebar

- Start streaming → open file sidebar → switch between Changes and Files tabs → verify no glitches
- Switch sessions during streaming → verify no content bleed
- Run a tool call → switch tabs → switch back → verify tool result merges

#### 6. UI changes during streaming

- Stream a response → verify no "Streaming..." text
- Stream triggers a sub-agent → verify "Agent" label shown

#### 7. Full smoke test

Walk through the complete flow:

1. Open app → select project → "New Workspace From..." → pick a branch → worktree created → session auto-starts
2. Send a message → title updates in tab → branch auto-renames from city name
3. Right-click worktree → Rename Branch → set custom name → verify branch renamed
4. Open file sidebar → verify Changes tab shows git changes → switch to Files tab → verify clean tree
5. Send a prompt that triggers streaming with tool calls → switch to another session tab → switch back → verify no content bleed and tool results merge correctly
6. Verify no "Streaming..." text, "Agent" label on task tool calls

#### 8. Run lint and tests

```bash
pnpm lint
pnpm test
```

Fix any failures.

### Key Files

- All files modified in sessions 1–11

### Definition of Done

- [ ] All 10 features work correctly in isolation
- [ ] Cross-feature interactions work correctly
- [ ] No regressions in Phase 10 features (questions, scroll FAB, slash commands, etc.)
- [ ] No console errors during normal operation
- [ ] No leaked timers, rAF callbacks, or IPC listeners
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Full happy path smoke test passes

### How to Test

Run through each integration scenario listed in Tasks above. Pay special attention to:

- Title arrival timing and branch rename race conditions
- Auto-start with various worktree states
- Branch picker with many branches (100+)
- Streaming state during rapid tab switching

### Testing Criteria

```typescript
// test/phase-11/session-12/integration-verification.test.ts
describe('Session 12: Integration & Verification', () => {
  test('title event triggers branch auto-rename', () => {
    // End-to-end: session.updated with title → branch renamed from city name
  })

  test('manual rename prevents future auto-rename', () => {
    // Manual rename sets branch_renamed = 1
    // New title event arrives → no rename
  })

  test('auto-start creates session in new worktree from branch', () => {
    // Create worktree from branch → auto-start fires → session created
  })

  test('streaming state preserved across tab switches', () => {
    // Start streaming in session A
    // Switch to session B
    // Switch back to session A
    // Verify isStreaming still true
  })

  test('tool call result merges after tab switch', () => {
    // Start tool call in session A
    // Switch to session B
    // Switch back to session A
    // Receive tool result
    // Verify merged into original card
  })

  test('no streaming content in wrong tab', () => {
    // Stream in session A
    // Switch to session B
    // Verify no streaming content in session B
  })

  test('file sidebar tabs work during streaming', () => {
    // Start streaming
    // Open file sidebar
    // Switch between Changes and Files tabs
    // Verify no errors
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
Session 1 (Remove Haiku Naming)         ── foundational cleanup
    |
    └──► Session 2 (Server Title Events) ── depends on Session 1 (naming removed first)
              |
              └──► Session 4 (Auto-Rename Branch) ── depends on Sessions 2+3

Session 3 (Branch Rename Infra)          ── independent infrastructure
    |
    ├──► Session 4 (Auto-Rename Branch)  ── depends on Session 3 (needs renameBranch + canonicalize)
    └──► Session 5 (Manual Branch Rename) ── depends on Session 3 (needs renameBranch IPC)

Session 6 (Auto-Start Session)           ── independent
Session 7 (Worktree from Branch)         ── independent

Session 8 (Streaming Bugfixes)           ── independent

Session 9 (File Sidebar Tabs)            ── independent
    |
    └──► Session 10 (Changes View)       ── depends on Session 9 (needs FileSidebar wrapper)

Session 11 (UI Text Changes)             ── independent

Session 12 (Integration)                 ── requires sessions 1-11
```

### Parallel Tracks

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Time →                                                                    │
│                                                                            │
│  Track A: [S1: Remove Naming] → [S2: Title Events] ──┐                    │
│  Track B: [S3: Branch Infra] ─────────────────────────┼─► [S4: Auto-Rename]│
│                                    └──► [S5: Manual Rename]                │
│  Track C: [S6: Auto-Start]                                                 │
│  Track D: [S7: Worktree from Branch]                                       │
│  Track E: [S8: Streaming Bugfixes]                                         │
│  Track F: [S9: Sidebar Tabs] → [S10: Changes View]                        │
│  Track G: [S11: UI Text]                                                   │
│                                                                            │
│  All ──────────────────────────────────────────────► [S12: Integration]     │
└────────────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Tracks A–G are largely independent. Track A (S1→S2) must complete before S4 can start. Track B (S3) must complete before S4 and S5.

**Critical path**: S1 → S2 → S4 (title system → server events → auto-rename) and S3 → S4 (infra → auto-rename). S4 is the convergence point.

**Minimum total**: 5 rounds:

1. (S1, S3, S6, S7, S8, S9, S11 in parallel)
2. (S2, S5, S10 in parallel)
3. (S4)
4. (S12)

---

## Notes

### Assumed Phase 10 Infrastructure

- Interactive question prompts (QuestionPrompt, QuestionStore, IPC)
- Scroll FAB fix (userHasScrolledUpRef)
- Write tool view (WriteToolView)
- Show in Finder (QuickActions)
- Slash command execution (SDK command endpoint, mode switching)

### Out of Scope (Phase 11)

Per PRD Phase 11:

- Per-message summary titles (only session-level titles implemented)
- Custom title model selection (rely on server defaults)
- Branch rename with remote tracking update
- Worktree directory rename to match new branch name
- Remote branch checkout with tracking setup
- Merge conflict resolution in Changes view
- File staging/unstaging animations
- Drag-and-drop file staging
- File diff inline in Changes view (opens separate viewer)
- Session tab rename UI (manual rename via API only, no inline tab editing)
- Branch protection rules (preventing rename of main/master)

### Performance Targets

| Operation                          | Target                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| Title update from server event     | < 100ms from SSE event to title visible in tab            |
| Branch auto-rename after title     | < 500ms from title event to branch renamed and UI updated |
| Manual branch rename round-trip    | < 300ms from Enter key to rename complete                 |
| Auto-start session                 | < 200ms from worktree selection to session created        |
| Branch picker dialog load          | < 500ms from menu click to branch list rendered           |
| Session loading state preservation | 0 false-idle states                                       |
| File sidebar tab switch            | < 50ms to swap between tabs                               |
| Tool call result reconciliation    | 100% results merge into original tool card                |
| Stream content isolation           | 0 cross-tab content leaks                                 |

### Key Architecture Decisions

1. **Remove custom naming entirely rather than patching it**: The server already provides title generation. Keeping the Haiku system alongside server titles would cause race conditions (two sources of truth) and double the LLM costs. Clean removal is the correct approach.

2. **Auto-rename in main process rather than renderer**: The main process has direct access to git-service, city-names, and the DB. Doing it in the renderer would require additional IPC round-trips and importing Node.js-only modules. The main process also receives the SSE events first, so it can rename before notifying the renderer.

3. **`branch_renamed` DB flag over city-name-list checking alone**: While checking if the current branch is a city name works for the initial rename, it doesn't prevent re-renaming after a subsequent title change. The DB flag is a definitive "stop" signal.

4. **Per-worktree auto-start over project-wide**: The project-wide check was overly conservative. Users expect each worktree to be independent. If worktree A is active, that shouldn't prevent worktree B from having its own session.

5. **Generation counter for stream isolation over component-key remounting**: React's key-based remounting would lose all component state. A generation counter preserves state while preventing stale closures from processing events.

6. **Partial state clear on tab switch over full reset**: A full `resetStreamingState()` kills the loading indicator. Clearing only display data (parts, content) while preserving `isStreaming` lets the stream events control the loading state correctly.

7. **Restoring streaming parts from DB on remount**: The main process already persists parts via `mergeUpdatedPart()`. Reading them back on remount gives the stream handler the context it needs to merge tool results into their original calls.

8. **Two-tab sidebar over mixed tree**: Separating changes from files reduces cognitive load. Users looking at changes want git-focused actions; users browsing files want navigation. Mixing both creates UI clutter.
