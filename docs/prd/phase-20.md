# Hive -- Phase 20 Product Requirements Document

## Overview

Phase 20 delivers five improvements spanning file viewing, PR lifecycle, app stability, keyboard shortcuts, and merge UX. It includes: opening fully-added files (especially markdown) in the normal file viewer instead of the syntax-highlighted diff view; evolving the PR button into a full PR-merge-archive lifecycle flow; prompting the user before quitting when worktrees are in a loading state; adding a Cmd+G keyboard shortcut for the sidebar merge action; and replacing the merge button with a styled archive button when the selected merge-from branch is already up-to-date.

### Phase 20 Goals

1. Open fully-added files in the standard file viewer (markdown files use the markdown preview)
2. Evolve the PR button into a merge button after PR creation, then an archive button after merge
3. Prompt the user before quitting when worktrees are loading
4. Add Cmd+G keybind to trigger the sidebar merge action
5. Show archive button instead of merge when the selected branch is already up-to-date

---

## Technical Additions

| Component                  | Technology                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| Added file viewer routing  | Update `ChangesView.handleViewDiff` to route new files through `openFile` instead of `setActiveDiff`    |
| PR lifecycle state machine | New `prState` map in `useGitStore` tracking per-worktree PR status (none → created → merged → archived) |
| PR URL detection           | Parse AI session streaming output for GitHub PR URLs when session originated from PR button             |
| PR merge via gh CLI        | New `git:prMerge` IPC channel calling `gh pr merge` + cross-worktree local branch sync                  |
| Quit confirmation          | `before-quit` handler in main process checking worktree loading state via IPC to renderer               |
| Cmd+G shortcut             | New entry in `DEFAULT_SHORTCUTS`, handler in `useKeyboardShortcuts` dispatching sidebar merge           |
| Branch up-to-date check    | New `git:isBranchMerged` IPC channel, UI swap in `GitPushPull` from merge button to archive button      |

---

## Features

### 1. Open Fully-Added Files in the Standard File Viewer

#### 1.1 Current State

When a user clicks a file in `ChangesView` (`src/renderer/src/components/file-tree/ChangesView.tsx`, line 219-234), `handleViewDiff` is called. For new/added files (status `?` or `A`), it sets `isNewFile: true` in the `ActiveDiff` and opens `InlineDiffViewer`.

`InlineDiffViewer` (`src/renderer/src/components/diff/InlineDiffViewer.tsx`, lines 356-389) detects `isNewFile` and renders the raw file content with `react-syntax-highlighter` (Prism + oneDark). This means:

- **Markdown files** show as raw markdown source code with syntax highlighting, not a rendered preview
- **All new files** show in a diff-oriented chrome (with "New file" badge, copy-diff button, context line controls) that is irrelevant for viewing a wholly new file
- The `FileViewer` component (`src/renderer/src/components/file-viewer/FileViewer.tsx`), which has proper markdown preview with source/preview toggle (lines 220-262), is never reached because `activeDiff` takes priority in `MainPane` (line 61-73)

#### 1.2 New Design

````
Clicking a fully-added file in ChangesView:

  Before:
  ┌──────────────────────────────────────────┐
  │ [New file] [Copy] [Context: 3]           │  ← diff chrome
  │                                          │
  │  1 │ # README.md                         │  ← raw syntax-highlighted
  │  2 │                                     │     markdown source code
  │  3 │ This is a description...            │
  │  4 │                                     │
  │  5 │ ## Installation                     │
  │  6 │ ```bash                             │
  │  7 │ npm install                         │
  └──────────────────────────────────────────┘

  After:
  ┌──────────────────────────────────────────┐
  │ README.md              [Source] [Preview] │  ← normal file viewer
  │                                          │
  │  # README.md                             │  ← rendered markdown
  │                                          │     (preview mode default)
  │  This is a description...                │
  │                                          │
  │  ## Installation                         │
  │  ┌──────────────────────────────┐        │
  │  │ npm install                  │        │
  │  └──────────────────────────────┘        │
  └──────────────────────────────────────────┘

  For non-markdown added files (e.g. new .ts, .css files):
  Same as before -- opens in the standard FileViewer with
  syntax highlighting and line numbers (which FileViewer
  already does via SyntaxHighlighter).
````

**Key behavior:** When a file in ChangesView has status `?` (untracked) or `A` (added) and is entirely new (not a renamed/copied file with partial changes), clicking it should open it via `useFileViewerStore.openFile()` instead of `setActiveDiff()`. This routes through the standard `FileViewer` component, which:

- Detects `.md`/`.mdx` files and defaults to preview mode (line 107-108)
- Renders via `MarkdownRenderer` in preview mode (line 256-262)
- Has source/preview toggle for markdown (lines 220-243)
- Shows proper syntax highlighting for all other file types

#### 1.3 Implementation

**A. Update `handleViewDiff` in `ChangesView.tsx`** (lines 219-234):

Route new/added files through `openFile` instead of `setActiveDiff`:

```typescript
const handleViewDiff = useCallback(
  (file: GitFileStatus) => {
    if (!worktreePath) return
    const isNewFile = file.status === '?' || file.status === 'A'

    if (isNewFile) {
      // Open fully-added files in the standard file viewer
      const fullPath = `${worktreePath}/${file.relativePath}`
      const fileName = file.relativePath.split('/').pop() || file.relativePath
      const worktreeId = useWorktreeStore.getState().selectedWorktreeId
      if (worktreeId) {
        useFileViewerStore.getState().openFile(fullPath, fileName, worktreeId)
      }
    } else {
      // Open modified/deleted files in the diff viewer
      useFileViewerStore.getState().setActiveDiff({
        worktreePath,
        filePath: file.relativePath,
        fileName: file.relativePath.split('/').pop() || file.relativePath,
        staged: file.staged,
        isUntracked: file.status === '?',
        isNewFile: false
      })
    }

    onFileClick?.(file.relativePath)
  },
  [worktreePath, onFileClick]
)
```

**B. Apply the same logic to `GitStatusPanel.tsx`** (lines 251-264) if it has the same pattern.

**C. No changes needed to `InlineDiffViewer`, `FileViewer`, or `MainPane`** -- the existing routing logic already works correctly when `openFile` is called instead of `setActiveDiff`. `MainPane` line 76-78 checks `activeFilePath` and renders `FileViewer` when no `activeDiff` is active.

#### 1.4 Files to Modify

| File                                                    | Change                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `src/renderer/src/components/file-tree/ChangesView.tsx` | Update `handleViewDiff` to route new files through `openFile` |
| `src/renderer/src/components/git/GitStatusPanel.tsx`    | Same change to its `handleViewDiff` equivalent                |

---

### 2. PR Lifecycle: Create → Merge → Archive

#### 2.1 Current State

The PR button in `Header.tsx` (lines 183-227) is a static "PR" button that always creates a new AI session with a prompt to run `gh pr create`. It has a target-branch dropdown next to it. After clicking, an AI session is created and the AI runs the command -- but the app has no awareness of whether a PR was actually created, its URL, or its state.

The merge functionality lives entirely in the sidebar (`GitPushPull.tsx`, lines 174-189) as a local `git merge` from a selected branch.

There is no connection between PR creation and subsequent merge/cleanup actions.

#### 2.2 New Design

The PR button evolves through a state machine based on the worktree lifecycle:

```
PR Lifecycle State Machine (per worktree):

  ┌─────────┐    PR button     ┌──────────────┐    AI outputs    ┌─────────────┐
  │  none    │ ──── click ────→ │  creating    │ ── PR URL ─────→ │  created    │
  └─────────┘                   └──────────────┘                   └─────────────┘
       │                                                                 │
       │  (clean tree +                                                  │
       │   PR detected)                                          Merge button
       │                                                          click (Cmd+G
       │                                                          does NOT
       ▼                                                          trigger this)
  ┌─────────┐                                                           │
  │  created │ ◄────────────────────────────────────────────────────────┘
  └─────────┘                                                           │
       │                                                                │
       │  gh pr merge                                                   │
       │  succeeds                                                      ▼
       │                                                         ┌─────────────┐
       └────────────────────────────────────────────────────────→│   merged    │
                                                                 └─────────────┘
                                                                       │
                                                                Archive button
                                                                  click
                                                                       │
                                                                       ▼
                                                                ┌─────────────┐
                                                                │  archived   │
                                                                └─────────────┘
                                                                (worktree gone,
                                                                 user switched
                                                                 to no-worktree)

  Header button appearance at each state:

  none:      [PR]  → {target branch dropdown}
             Standard outline button. Creates a PR session.

  creating:  [PR ⟳]  → {target branch dropdown}
             Disabled, spinner. AI session is running.

  created:   [Merge PR]
             Green/success variant. Clean working tree required.
             Dropdown hidden (target already set).

  merged:    [Archive]
             Destructive/red variant. Archives the worktree.
```

**PR detection mechanism:**

When the PR button is clicked, the created session is tagged as a "PR session" in store state. As the AI streams its response, the renderer watches for GitHub PR URLs in the output (pattern: `https://github.com/.+/pull/\d+`). When detected, the PR number and URL are stored in `useGitStore.prInfo` (in-memory only -- does not survive app restart).

**Merge operation (gh pr merge):**

When the user clicks the "Merge PR" button:

1. Run `gh pr merge <number> --merge` (or `--squash`/`--rebase` based on repo default) via a new IPC channel
2. On success, sync the local branch: use `git worktree list` to find if any local worktree corresponds to the PR target branch. If found, run `git merge <our-branch>` in that worktree's directory to fast-forward the local copy.
3. Transition the button to "Archive" state.

**Archive operation:**

The "Archive" button calls the existing `archiveWorktree()` from `useWorktreeStore` (lines 194-284), which handles killing processes, aborting sessions, deleting the worktree, and switching to no-worktree view.

#### 2.3 Implementation

**A. Add PR state to `useGitStore.ts`:**

```typescript
// New types
interface PRInfo {
  state: 'none' | 'creating' | 'created' | 'merged'
  prNumber?: number
  prUrl?: string
  targetBranch?: string
  sessionId?: string  // The session that created the PR (for output watching)
}

// New state in useGitStore
prInfo: Map<string, PRInfo>  // worktreeId → PRInfo

// New actions
setPrState: (worktreeId: string, info: PRInfo) => void
```

**B. Add PR URL detection in session streaming output.**

The session store or a dedicated hook should watch for PR URLs in the AI's streamed response. Only sessions created by the PR button (tracked via `sessionId` in `PRInfo`) should be monitored.

When a URL matching `https://github.com/.+/pull/(\d+)` is found in the session output:

- Extract the PR number
- Update `prInfo` for the worktree to `state: 'created'` with the PR number and URL

This can be implemented as a `useEffect` in `Header.tsx` or a dedicated `usePRDetection` hook that watches the active session's messages.

**C. Add new IPC channel `git:prMerge`:**

New handler in `src/main/ipc/git-file-handlers.ts`:

```typescript
ipcMain.handle('git:prMerge', async (_event, worktreePath: string, prNumber: number) => {
  try {
    // Step 1: Merge the PR on GitHub
    const mergeResult = await execPromise(`gh pr merge ${prNumber} --merge`, { cwd: worktreePath })

    // Step 2: Sync local branch
    // Find the PR's target branch
    const prInfoResult = await execPromise(
      `gh pr view ${prNumber} --json baseRefName -q '.baseRefName'`,
      { cwd: worktreePath }
    )
    const targetBranch = prInfoResult.stdout.trim()

    // Check if any local worktree corresponds to the target branch
    const worktreeListResult = await execPromise('git worktree list --porcelain', {
      cwd: worktreePath
    })
    // Parse worktree list to find one on the target branch
    const targetWorktreePath = parseWorktreeForBranch(worktreeListResult.stdout, targetBranch)

    if (targetWorktreePath) {
      // Merge our branch into the target branch's worktree
      const currentBranch = await execPromise('git branch --show-current', { cwd: worktreePath })
      await execPromise(`git merge ${currentBranch.stdout.trim()}`, { cwd: targetWorktreePath })
    }

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})
```

**D. Add preload bridge for `git:prMerge`:**

In `src/preload/index.ts` under `gitOps`:

```typescript
prMerge: (worktreePath: string, prNumber: number) =>
  ipcRenderer.invoke('git:prMerge', worktreePath, prNumber)
```

Add type declaration in `src/preload/index.d.ts`.

**E. Update Header.tsx PR button section** (lines 183-227):

Replace the static PR button with a state-driven button:

```tsx
{isGitHub && (() => {
  const pr = prInfo?.get(selectedWorktreeId!)
  const isCleanTree = /* derive from git status: no staged, unstaged, untracked */

  if (pr?.state === 'merged') {
    // Archive button
    return (
      <Button
        size="sm"
        variant="destructive"
        className="h-7 text-xs"
        onClick={handleArchiveWorktree}
        data-testid="archive-button"
      >
        <Archive className="h-3.5 w-3.5 mr-1" />
        Archive
      </Button>
    )
  }

  if (pr?.state === 'created' && isCleanTree) {
    // Merge PR button
    return (
      <Button
        size="sm"
        variant="default"
        className="h-7 text-xs bg-green-600 hover:bg-green-700"
        onClick={handleMergePR}
        data-testid="merge-pr-button"
      >
        <GitMerge className="h-3.5 w-3.5 mr-1" />
        Merge PR
      </Button>
    )
  }

  // Default: PR creation button + target dropdown (existing UI)
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={handleCreatePR}
        disabled={isOperating || pr?.state === 'creating'}
        data-testid="pr-button"
      >
        {pr?.state === 'creating' ? (
          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
        ) : (
          <GitPullRequest className="h-3.5 w-3.5 mr-1" />
        )}
        PR
      </Button>
      {/* existing target branch dropdown */}
    </>
  )
})()}
```

**F. Implement `handleMergePR` in Header.tsx:**

```typescript
const handleMergePR = useCallback(async () => {
  if (!selectedWorktree?.path || !selectedWorktreeId) return
  const pr = useGitStore.getState().prInfo.get(selectedWorktreeId)
  if (!pr?.prNumber) return

  try {
    const result = await window.gitOps.prMerge(selectedWorktree.path, pr.prNumber)
    if (result.success) {
      toast.success('PR merged successfully')
      useGitStore.getState().setPrState(selectedWorktreeId, {
        ...pr,
        state: 'merged'
      })
    } else {
      toast.error(`Merge failed: ${result.error}`)
    }
  } catch (error) {
    toast.error('Failed to merge PR')
  }
}, [selectedWorktree?.path, selectedWorktreeId])
```

**G. Implement `handleArchiveWorktree` in Header.tsx:**

```typescript
const handleArchiveWorktree = useCallback(async () => {
  if (!selectedWorktreeId) return
  await useWorktreeStore.getState().archiveWorktree(selectedWorktreeId)
}, [selectedWorktreeId])
```

#### 2.4 Files to Modify

| File                                            | Change                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/renderer/src/stores/useGitStore.ts`        | Add `prInfo` map, `setPrState` action                                          |
| `src/renderer/src/components/layout/Header.tsx` | State-driven PR/Merge/Archive button, `handleMergePR`, `handleArchiveWorktree` |
| `src/renderer/src/hooks/usePRDetection.ts`      | **New file.** Hook to watch session output for PR URLs                         |
| `src/main/ipc/git-file-handlers.ts`             | Add `git:prMerge` handler with `gh pr merge` + local branch sync               |
| `src/preload/index.ts`                          | Add `prMerge` to `gitOps` namespace                                            |
| `src/preload/index.d.ts`                        | Add `prMerge` type declaration, add `PRInfo` type                              |

---

### 3. Quit Confirmation When Worktrees Are Loading

#### 3.1 Current State

The app quit handling is in `src/main/index.ts`:

- Lines 356-360: `window-all-closed` calls `app.quit()` on non-macOS
- Lines 363-374: `will-quit` runs cleanup (terminals, scripts, file watchers, OpenCode, database)
- No `before-quit` handler exists
- No confirmation dialog is shown before quitting

Worktree loading state is tracked in the renderer (`useWorktreeStore.isLoading`, line 32). However, the concept of "worktrees in a loading state" likely refers to worktrees that have running AI sessions or scripts -- specifically, worktrees with active OpenCode/script processes, not just the store's `isLoading` boolean.

The relevant state is likely:

- Running scripts: tracked in `useScriptStore` or via terminal PTY processes
- Active streaming sessions: tracked in `useSessionStore` via `streamingSessionIds` or similar
- The `archivingWorktreeIds` set in `useWorktreeStore` (worktrees currently being archived)

#### 3.2 New Design

```
Quit confirmation dialog:

  When the user presses Cmd+Q or closes the app window,
  if any worktrees have active processes running:

  ┌────────────────────────────────────────────────┐
  │                                                │
  │  Are you sure you want to quit?                │
  │                                                │
  │  You have pending worktrees running.           │
  │  Quitting now will terminate all active        │
  │  sessions and processes.                       │
  │                                                │
  │                    [Cancel]  [Quit Anyway]      │
  └────────────────────────────────────────────────┘

  "Pending worktrees running" means:
  - Any worktree has an active streaming AI session
  - Any worktree has a running script process

  If no worktrees are in a loading state, quit immediately
  without showing the dialog.
```

#### 3.3 Implementation

**A. Add IPC channel to query running worktree state from main process:**

The main process needs to know if any worktrees are "busy". Two approaches:

**Approach 1 (simpler):** Add a `before-quit` handler in `src/main/index.ts` that sends an IPC message to the renderer asking "are any worktrees busy?" The renderer checks its stores and responds.

**Approach 2 (recommended):** The main process already tracks running processes:

- Terminal PTYs are tracked in terminal management code
- OpenCode connections are tracked in `opencode-service.ts`
- Scripts are tracked in script runner code

Check these in the `before-quit` handler directly without needing to query the renderer.

```typescript
// In src/main/index.ts
let forceQuit = false

app.on('before-quit', (event) => {
  if (forceQuit) return // User confirmed, proceed with quit

  const hasRunningProcesses = checkForRunningProcesses()
  if (hasRunningProcesses) {
    event.preventDefault()

    const mainWindow = getMainWindow()
    if (!mainWindow) return

    dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Quit Hive?',
        message: 'Are you sure you want to quit?',
        detail:
          'You have pending worktrees running. Quitting now will terminate all active sessions and processes.',
        buttons: ['Cancel', 'Quit Anyway'],
        defaultId: 0,
        cancelId: 0
      })
      .then(({ response }) => {
        if (response === 1) {
          forceQuit = true
          app.quit()
        }
      })
  }
})
```

**B. Implement `checkForRunningProcesses()`:**

This function checks the main process's own tracking of running terminals, OpenCode connections, and script processes. It returns `true` if any are active.

```typescript
function checkForRunningProcesses(): boolean {
  // Check for active terminal PTYs
  const activeTerminals = getActiveTerminalCount()
  // Check for active OpenCode connections that are streaming
  const activeOpenCode = getActiveOpenCodeCount()
  // Check for running scripts
  const activeScripts = getActiveScriptCount()

  return activeTerminals > 0 || activeOpenCode > 0 || activeScripts > 0
}
```

The exact implementation depends on how these services expose their active connection counts. Each service should expose a simple getter for this.

**C. Handle macOS dock-quit behavior:**

On macOS, `Cmd+Q` and quitting from the dock both trigger `before-quit`. The window-close (`close` event on BrowserWindow) should also be intercepted for the same check when it's the last window.

#### 3.4 Files to Modify

| File                                                    | Change                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `src/main/index.ts`                                     | Add `before-quit` handler with dialog, add `forceQuit` flag |
| `src/main/services/opencode-service.ts`                 | Expose `getActiveConnectionCount()` or similar              |
| `src/main/services/script-runner.ts` (or equivalent)    | Expose `getActiveScriptCount()` if not already available    |
| `src/main/services/terminal-service.ts` (or equivalent) | Expose `getActiveTerminalCount()` if not already available  |

---

### 4. Cmd+G Keyboard Shortcut for Sidebar Merge

#### 4.1 Current State

Keyboard shortcuts are defined in `src/renderer/src/lib/keyboard-shortcuts.ts` (lines 30-161) with 17 shortcuts across 6 categories. The handler mapping is in `src/renderer/src/hooks/useKeyboardShortcuts.ts` (lines 241-498).

The Git category currently has three shortcuts:

- `Cmd+Shift+C` → Commit
- `Cmd+Shift+P` → Push
- `Cmd+Shift+L` → Pull

The sidebar merge action lives in `GitPushPull.tsx` (lines 174-189) and calls `window.gitOps.merge(worktreePath, mergeBranch)`.

#### 4.2 New Design

```
New shortcut:
  Cmd+G  →  Merge (sidebar merge action)

  Behavior:
  - Triggers the same action as clicking the "Merge" button in
    the GitPushPull section of the right sidebar
  - Uses whatever branch is currently selected in the merge
    dropdown
  - If no branch is selected, shows a toast: "Select a branch
    to merge from first"
  - If a merge is already in progress, the shortcut is ignored
  - This does NOT trigger the PR merge from the header

  Category: Git
  Display: ⌘G
```

#### 4.3 Implementation

**A. Add shortcut definition in `keyboard-shortcuts.ts`:**

Add to the Git category in `DEFAULT_SHORTCUTS`:

```typescript
{
  id: 'merge',
  label: 'Merge',
  description: 'Merge selected branch',
  category: 'Git',
  defaultBinding: { key: 'g', meta: true }
}
```

**B. Add handler in `useKeyboardShortcuts.ts`** (`getShortcutHandlers`):

The handler needs to read the current merge branch from `GitPushPull`'s state. Since `mergeBranch` is local component state in `GitPushPull`, we need to either:

1. **Lift `mergeBranch` state to the store** (recommended) -- move the selected merge branch into `useGitStore` so the shortcut handler can read it, or
2. **Dispatch a custom event** that `GitPushPull` listens for

**Option 1 (recommended):**

Add `selectedMergeBranch: Map<string, string>` to `useGitStore` (keyed by worktree path). `GitPushPull` reads/writes from this instead of local state. The shortcut handler can then:

```typescript
{
  shortcutId: 'merge',
  handler: () => {
    const worktreePath = getActiveWorktreePath()
    if (!worktreePath) return
    const mergeBranch = useGitStore.getState().selectedMergeBranch.get(worktreePath)
    if (!mergeBranch) {
      toast.error('Select a branch to merge from first')
      return
    }
    // Call the same merge logic as GitPushPull.handleMerge
    window.gitOps.merge(worktreePath, mergeBranch).then((result) => {
      if (result.success) {
        toast.success(`Merged ${mergeBranch}`)
        // Refresh statuses
      } else {
        toast.error(`Merge failed: ${result.error}`)
      }
    })
  }
}
```

**C. Register with menu if needed:**

Add a menu item in the application menu under a "Git" submenu or "Actions" so the shortcut appears in the menu bar.

#### 4.4 Files to Modify

| File                                                         | Change                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `src/renderer/src/lib/keyboard-shortcuts.ts`                 | Add `merge` shortcut definition to Git category                        |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts`             | Add merge handler to `getShortcutHandlers`                             |
| `src/renderer/src/stores/useGitStore.ts`                     | Add `selectedMergeBranch` map (lift from local state)                  |
| `src/renderer/src/components/git/GitPushPull.tsx`            | Use `selectedMergeBranch` from store instead of local `useState`       |
| `src/renderer/src/components/settings/SettingsShortcuts.tsx` | No change needed (auto-picks up new shortcut from `DEFAULT_SHORTCUTS`) |

---

### 5. Archive Button When Branch Is Already Up-to-Date

#### 5.1 Current State

The merge dropdown in `GitPushPull.tsx` (lines 242-341) lets the user select a branch to merge from. The merge button (lines 331-340) is a static "Merge" button that is disabled only when merging, operating, or no branch is selected.

There is no check for whether the selected branch has already been fully merged into the current branch (i.e., the branches are up-to-date).

#### 5.2 New Design

```
When selecting a branch from the merge dropdown:

  Case 1: Branch has unmerged changes (normal)
  ┌─────────────────────────────────────────────┐
  │ Merge from: [main           ▼]   [Merge]    │
  └─────────────────────────────────────────────┘
  Standard outline button.

  Case 2: Branch is already merged / up-to-date
  ┌──────────────────────────────────────────────┐
  │ Merge from: [main           ▼]   [Archive]   │
  └──────────────────────────────────────────────┘
  Destructive/red variant button. Clicking archives
  the current worktree directly (no confirmation dialog
  since user explicitly chose this).

  Detection: Run `git merge-base --is-ancestor <merge-from> HEAD`
  If exit code 0, the selected branch is already an ancestor
  of HEAD (meaning all its changes are already in our branch).
  Also check the reverse: if our HEAD is already an ancestor
  of the merge-from branch, we're also "up to date" in the
  sense that a merge would be a no-op or fast-forward of
  already-integrated work.

  The check runs every time the merge dropdown selection changes.
```

#### 5.3 Implementation

**A. Add new IPC channel `git:isBranchMerged`:**

In `src/main/ipc/git-file-handlers.ts`:

```typescript
ipcMain.handle('git:isBranchMerged', async (_event, worktreePath: string, branch: string) => {
  try {
    // Check if the selected branch is an ancestor of HEAD
    // (all its commits are already in our branch)
    await execPromise(`git merge-base --is-ancestor ${branch} HEAD`, { cwd: worktreePath })
    return { success: true, isMerged: true }
  } catch {
    // Non-zero exit code means branch is NOT an ancestor
    return { success: true, isMerged: false }
  }
})
```

**B. Add preload bridge:**

```typescript
isBranchMerged: (worktreePath: string, branch: string) =>
  ipcRenderer.invoke('git:isBranchMerged', worktreePath, branch)
```

**C. Update `GitPushPull.tsx`:**

Add state and effect to check merge status when branch selection changes:

```typescript
const [isBranchMerged, setIsBranchMerged] = useState(false)

useEffect(() => {
  if (!worktreePath || !mergeBranch) {
    setIsBranchMerged(false)
    return
  }
  window.gitOps.isBranchMerged(worktreePath, mergeBranch).then((result) => {
    if (result.success) {
      setIsBranchMerged(result.isMerged)
    }
  })
}, [worktreePath, mergeBranch])
```

Replace the merge button conditionally:

```tsx
{
  isBranchMerged ? (
    <Button
      variant="destructive"
      size="sm"
      className="h-6 text-xs whitespace-nowrap"
      onClick={handleArchiveWorktree}
      data-testid="archive-merged-button"
    >
      Archive
    </Button>
  ) : (
    <Button
      variant="outline"
      size="sm"
      className="h-6 text-xs whitespace-nowrap"
      onClick={handleMerge}
      disabled={isMerging || isOperating || !mergeBranch.trim()}
      data-testid="merge-button"
    >
      {isMerging ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Merge'}
    </Button>
  )
}
```

**D. Implement `handleArchiveWorktree` in `GitPushPull.tsx`:**

```typescript
const handleArchiveWorktree = useCallback(async () => {
  const worktreeId = useWorktreeStore.getState().selectedWorktreeId
  if (!worktreeId) return
  await useWorktreeStore.getState().archiveWorktree(worktreeId)
}, [])
```

No confirmation dialog since the user explicitly sees "Archive" and clicks it, and the branch is confirmed merged.

#### 5.4 Files to Modify

| File                                              | Change                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/main/ipc/git-file-handlers.ts`               | Add `git:isBranchMerged` handler                                         |
| `src/preload/index.ts`                            | Add `isBranchMerged` to `gitOps`                                         |
| `src/preload/index.d.ts`                          | Add `isBranchMerged` type declaration                                    |
| `src/renderer/src/components/git/GitPushPull.tsx` | Add merged check, swap merge/archive button, add `handleArchiveWorktree` |

---

## Testing

### Feature 1: Added File Viewer

- Click an untracked `.md` file in Changes → verify markdown preview opens (not syntax-highlighted source)
- Click an untracked `.ts` file in Changes → verify it opens in FileViewer with syntax highlighting
- Click a staged `.md` file (status `A`) in Changes → verify markdown preview opens
- Click a modified `.md` file in Changes → verify diff view still opens (not file viewer)
- Verify file tab appears in the tab bar with correct file name
- Verify source/preview toggle works for markdown files opened this way

### Feature 2: PR Lifecycle

- Click PR button → verify AI session is created with PR prompt
- After AI outputs a PR URL → verify button changes to "Merge PR" (when tree is clean)
- Click "Merge PR" → verify `gh pr merge` is called, button transitions to "Archive"
- Click "Archive" → verify worktree is archived and view switches to no-worktree
- Verify local branch sync: if a worktree exists for the target branch, verify `git merge` runs there
- Verify button stays as "PR" when tree has uncommitted changes even after PR is created
- Verify the PR button resets to "PR" on app restart (in-memory only)

### Feature 3: Quit Confirmation

- With running AI session, press Cmd+Q → verify confirmation dialog appears
- Click "Cancel" → verify app does not quit
- Click "Quit Anyway" → verify app quits and cleanup runs
- With no running processes, press Cmd+Q → verify app quits immediately (no dialog)
- Test macOS dock quit and window close button both trigger the check

### Feature 4: Cmd+G Shortcut

- Select a branch in merge dropdown, press Cmd+G → verify merge executes
- With no branch selected, press Cmd+G → verify toast "Select a branch to merge from first"
- During an active merge, press Cmd+G → verify shortcut is ignored
- Verify shortcut appears in Settings > Shortcuts under Git category
- Verify shortcut is customizable

### Feature 5: Archive When Up-to-Date

- Select a branch that is already merged → verify "Archive" button appears (red/destructive)
- Select a branch with unmerged changes → verify normal "Merge" button appears
- Click "Archive" on merged branch → verify worktree archives without confirmation dialog
- Change branch selection → verify button swaps correctly between merge and archive
- Verify the check runs on each branch selection change (not just initial load)

---

## Open Questions

1. **PR merge method:** Should the merge button offer a choice between merge, squash, and rebase? Or should it use the repository's default merge method? (Current design: use `--merge` flag. Could be enhanced to respect repo settings.)

2. **PR session detection edge cases:** What if the AI fails to create the PR (e.g., `gh` not installed, auth failure)? The button would stay in "creating" state. Need a timeout or error detection to reset to "none".

3. **Multiple PRs per worktree:** If a user creates a PR, it fails, and they create another -- the detection should use the latest session. The current design handles this by overwriting `prInfo` state.
