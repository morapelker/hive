# Hive Phase 20 Implementation Plan

This document outlines the implementation plan for Hive Phase 20, covering added-file viewer routing, PR lifecycle (create → merge → archive), quit confirmation, Cmd+G merge shortcut, and branch up-to-date archive swap.

---

## Overview

The implementation is divided into **10 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 20 builds upon Phase 19** -- all Phase 19 infrastructure is assumed to be in place.

---

## Dependencies & Parallelization

```
Session 1  (Added File Viewer Routing)                -- no deps
Session 2  (PR Lifecycle: Store State)                -- no deps
Session 3  (PR Lifecycle: IPC + Backend)              -- no deps
Session 4  (PR Lifecycle: PR Detection Hook)          -- blocked by Session 2
Session 5  (PR Lifecycle: Header UI)                  -- blocked by Sessions 2, 3, 4
Session 6  (Quit Confirmation)                        -- no deps
Session 7  (Cmd+G: Store + Shortcut Definition)       -- no deps
Session 8  (Cmd+G: Handler Wiring)                    -- blocked by Session 7
Session 9  (Branch Up-to-Date Archive Swap)           -- no deps
Session 10 (Integration & Verification)               -- blocked by Sessions 1-9
```

### Parallel Tracks

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Time →                                                                       │
│                                                                               │
│  Track A: [S1: Added File Viewer]                                             │
│  Track B: [S2: PR Store] → [S4: PR Detection] → [S5: PR Header UI]           │
│  Track C: [S3: PR IPC Backend] ──────────────────↗                            │
│  Track D: [S6: Quit Confirmation]                                             │
│  Track E: [S7: Cmd+G Store + Def] → [S8: Cmd+G Handler]                      │
│  Track F: [S9: Branch Up-to-Date]                                             │
│                                                                               │
│  All ──────────────────────────────────────────────► [S10: Integration]       │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 1, 2, 3, 6, 7, 9 are fully independent (6 sessions).

**Minimum total**: 4 rounds:

1. (S1, S2, S3, S6, S7, S9 in parallel)
2. (S4, S8 -- after their dependencies)
3. (S5 -- after S2, S3, S4)
4. (S10)

**Recommended serial order** (if doing one at a time):

S1 → S9 → S6 → S7 → S8 → S2 → S3 → S4 → S5 → S10

Rationale: S1 is the smallest change (2 files, simple routing). S9 is self-contained backend+frontend. S6 is main-process only. S7-S8 are sequential (store then handler). S2-S5 are the PR lifecycle chain, best done in order. S10 validates everything.

---

## Testing Infrastructure

### Test File Structure (Phase 20)

```
test/
├── phase-20/
│   ├── session-1/
│   │   └── added-file-viewer.test.tsx
│   ├── session-2/
│   │   └── pr-lifecycle-store.test.ts
│   ├── session-3/
│   │   └── pr-merge-ipc.test.ts
│   ├── session-4/
│   │   └── pr-detection-hook.test.ts
│   ├── session-5/
│   │   └── pr-header-ui.test.tsx
│   ├── session-6/
│   │   └── quit-confirmation.test.ts
│   ├── session-7/
│   │   └── merge-shortcut-store.test.ts
│   ├── session-8/
│   │   └── merge-shortcut-handler.test.ts
│   ├── session-9/
│   │   └── branch-up-to-date.test.tsx
│   └── session-10/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies -- all features use existing packages:
# - zustand (stores -- already installed)
# - lucide-react (icons -- already installed)
# - Electron APIs: ipcRenderer, ipcMain, dialog (built-in)
# - gh CLI (external tool, assumed available on user machine)
```

---

## Session 1: Added File Viewer Routing

### Objectives

- Route fully-added files (status `?` or `A`) in ChangesView through `openFile()` instead of `setActiveDiff()`
- Markdown files open in the standard FileViewer with rendered preview (not raw syntax-highlighted source)
- Non-markdown added files open in FileViewer with syntax highlighting
- Modified/deleted files continue to open in the diff viewer as before

### Tasks

#### 1. Update `handleViewDiff` in `ChangesView.tsx`

In `src/renderer/src/components/file-tree/ChangesView.tsx` (lines 219-234), change the handler so new files use `openFile` instead of `setActiveDiff`:

```typescript
const handleViewDiff = useCallback(
  (file: GitFileStatus) => {
    if (!worktreePath) return
    const isNewFile = file.status === '?' || file.status === 'A'

    if (isNewFile) {
      const fullPath = `${worktreePath}/${file.relativePath}`
      const fileName = file.relativePath.split('/').pop() || file.relativePath
      const worktreeId = useWorktreeStore.getState().selectedWorktreeId
      if (worktreeId) {
        useFileViewerStore.getState().openFile(fullPath, fileName, worktreeId)
      }
    } else {
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

#### 2. Apply the same logic to `GitStatusPanel.tsx`

In `src/renderer/src/components/git/GitStatusPanel.tsx` (lines 251-264), apply the identical routing change so both entry points behave consistently.

### Key Files

- `src/renderer/src/components/file-tree/ChangesView.tsx` -- update `handleViewDiff`
- `src/renderer/src/components/git/GitStatusPanel.tsx` -- update equivalent handler

### Definition of Done

- [ ] Clicking an untracked (`.md`) file in Changes opens the markdown preview in FileViewer
- [ ] Clicking an untracked (`.ts`, `.css`, etc.) file opens it in FileViewer with syntax highlighting
- [ ] Clicking a staged-added (`A`) file opens it in FileViewer, not InlineDiffViewer
- [ ] Clicking a modified (`M`) file still opens the diff viewer
- [ ] Clicking a deleted (`D`) file still opens the diff viewer
- [ ] File tab appears in the tab bar with the correct file name
- [ ] Source/preview toggle works for markdown files opened this way
- [ ] No changes to `InlineDiffViewer`, `FileViewer`, or `MainPane` are needed
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Add a new `.md` file (untracked) -- click it in Changes -- verify rendered markdown preview opens
2. Add a new `.ts` file (untracked) -- click it in Changes -- verify syntax-highlighted source opens in FileViewer
3. Stage a new file (`git add`) -- click it in Changes (status `A`) -- verify FileViewer opens
4. Modify an existing file -- click it in Changes -- verify diff viewer opens (unchanged behavior)
5. Verify the file tab shows in the tab bar and can be closed

### Testing Criteria

```typescript
// test/phase-20/session-1/added-file-viewer.test.tsx
describe('Session 1: Added File Viewer Routing', () => {
  test('untracked file (status ?) calls openFile instead of setActiveDiff', () => {
    // Mock useFileViewerStore.getState().openFile
    // Mock useFileViewerStore.getState().setActiveDiff
    // Mock useWorktreeStore.getState().selectedWorktreeId
    // Simulate handleViewDiff with file { status: '?', relativePath: 'README.md' }
    // Verify openFile was called with correct fullPath, fileName, worktreeId
    // Verify setActiveDiff was NOT called
  })

  test('added file (status A) calls openFile instead of setActiveDiff', () => {
    // Same as above but with status: 'A'
    // Verify openFile was called
    // Verify setActiveDiff was NOT called
  })

  test('modified file (status M) still calls setActiveDiff', () => {
    // Simulate handleViewDiff with file { status: 'M', relativePath: 'src/app.ts' }
    // Verify setActiveDiff was called with isNewFile: false
    // Verify openFile was NOT called
  })

  test('deleted file (status D) still calls setActiveDiff', () => {
    // Simulate handleViewDiff with file { status: 'D', relativePath: 'old.ts' }
    // Verify setActiveDiff was called
    // Verify openFile was NOT called
  })

  test('openFile receives correct full path from worktreePath + relativePath', () => {
    // worktreePath = '/path/to/worktree'
    // file.relativePath = 'docs/README.md'
    // Verify openFile called with '/path/to/worktree/docs/README.md'
  })
})
```

---

## Session 2: PR Lifecycle -- Store State

### Objectives

- Add `PRInfo` type and `prInfo` state map to `useGitStore`
- Add `setPrState` action to update PR state per worktree
- This is the data foundation for the entire PR lifecycle feature

### Tasks

#### 1. Define `PRInfo` type

Add the type either inline in `useGitStore.ts` or in `src/preload/index.d.ts` (since it's shared):

```typescript
interface PRInfo {
  state: 'none' | 'creating' | 'created' | 'merged'
  prNumber?: number
  prUrl?: string
  targetBranch?: string
  sessionId?: string
}
```

#### 2. Add `prInfo` state to `useGitStore`

In `src/renderer/src/stores/useGitStore.ts`, add to the state interface and initial state:

```typescript
// State
prInfo: Map<string, PRInfo> // worktreeId → PRInfo

// Initial
prInfo: new Map()
```

#### 3. Add `setPrState` action

```typescript
setPrState: (worktreeId: string, info: PRInfo) => {
  set((state) => {
    const newMap = new Map(state.prInfo)
    newMap.set(worktreeId, info)
    return { prInfo: newMap }
  })
}
```

### Key Files

- `src/renderer/src/stores/useGitStore.ts` -- `PRInfo` type, `prInfo` map, `setPrState` action

### Definition of Done

- [ ] `PRInfo` type is defined with `state`, `prNumber`, `prUrl`, `targetBranch`, `sessionId`
- [ ] `prInfo` is a `Map<string, PRInfo>` in the git store, initialized empty
- [ ] `setPrState(worktreeId, info)` creates/updates the entry for that worktree
- [ ] Multiple worktrees can have independent PR states
- [ ] State is in-memory only (no persistence, no `persist` middleware for this field)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-20/session-2/pr-lifecycle-store.test.ts
describe('Session 2: PR Lifecycle Store State', () => {
  test('prInfo starts as an empty map', () => {
    const state = useGitStore.getState()
    expect(state.prInfo.size).toBe(0)
  })

  test('setPrState adds a new PR info entry', () => {
    useGitStore.getState().setPrState('wt-1', {
      state: 'creating',
      sessionId: 'session-123',
      targetBranch: 'origin/main'
    })
    const info = useGitStore.getState().prInfo.get('wt-1')
    expect(info?.state).toBe('creating')
    expect(info?.sessionId).toBe('session-123')
  })

  test('setPrState updates existing entry', () => {
    useGitStore.getState().setPrState('wt-1', { state: 'creating' })
    useGitStore.getState().setPrState('wt-1', {
      state: 'created',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42'
    })
    const info = useGitStore.getState().prInfo.get('wt-1')
    expect(info?.state).toBe('created')
    expect(info?.prNumber).toBe(42)
  })

  test('different worktrees have independent PR states', () => {
    useGitStore.getState().setPrState('wt-1', { state: 'created', prNumber: 1 })
    useGitStore.getState().setPrState('wt-2', { state: 'merged', prNumber: 2 })
    expect(useGitStore.getState().prInfo.get('wt-1')?.state).toBe('created')
    expect(useGitStore.getState().prInfo.get('wt-2')?.state).toBe('merged')
  })
})
```

---

## Session 3: PR Lifecycle -- IPC Backend

### Objectives

- Add `git:prMerge` IPC handler that runs `gh pr merge` and syncs the local target branch
- Add helper to parse `git worktree list --porcelain` output to find a worktree on a given branch
- Add preload bridge and type declarations for `prMerge`

### Tasks

#### 1. Add `parseWorktreeForBranch` helper

In `src/main/services/git-service.ts` (or a new utility), add a function that parses `git worktree list --porcelain` output to find the worktree path for a given branch name:

```typescript
export function parseWorktreeForBranch(porcelainOutput: string, branchName: string): string | null {
  // Porcelain format:
  // worktree /path/to/worktree
  // HEAD abc123
  // branch refs/heads/main
  // (blank line)
  // worktree /path/to/another
  // ...
  const blocks = porcelainOutput.trim().split('\n\n')
  for (const block of blocks) {
    const lines = block.split('\n')
    let path = ''
    let branch = ''
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length)
    }
    if (branch === branchName && path) return path
  }
  return null
}
```

#### 2. Add `git:prMerge` IPC handler

In `src/main/ipc/git-file-handlers.ts`:

```typescript
ipcMain.handle('git:prMerge', async (_event, worktreePath: string, prNumber: number) => {
  try {
    // Step 1: Merge the PR on GitHub
    await execPromise(`gh pr merge ${prNumber} --merge`, { cwd: worktreePath })

    // Step 2: Get the target branch name
    const prInfoResult = await execPromise(
      `gh pr view ${prNumber} --json baseRefName -q '.baseRefName'`,
      { cwd: worktreePath }
    )
    const targetBranch = prInfoResult.stdout.trim()

    // Step 3: Find local worktree on target branch and sync
    const worktreeListResult = await execPromise('git worktree list --porcelain', {
      cwd: worktreePath
    })
    const targetWorktreePath = parseWorktreeForBranch(worktreeListResult.stdout, targetBranch)

    if (targetWorktreePath) {
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

#### 3. Add preload bridge

In `src/preload/index.ts` under `gitOps`:

```typescript
prMerge: (worktreePath: string, prNumber: number) =>
  ipcRenderer.invoke('git:prMerge', worktreePath, prNumber)
```

#### 4. Add type declarations

In `src/preload/index.d.ts`, add `prMerge` to the gitOps interface:

```typescript
prMerge: (worktreePath: string, prNumber: number) => Promise<{ success: boolean; error?: string }>
```

### Key Files

- `src/main/services/git-service.ts` -- `parseWorktreeForBranch` helper
- `src/main/ipc/git-file-handlers.ts` -- `git:prMerge` handler
- `src/preload/index.ts` -- preload bridge
- `src/preload/index.d.ts` -- type declaration

### Definition of Done

- [ ] `parseWorktreeForBranch` correctly parses porcelain output and returns the path or null
- [ ] `git:prMerge` handler calls `gh pr merge` with the PR number
- [ ] After merging, it looks up the target branch and syncs the local worktree if found
- [ ] If no local worktree is on the target branch, it skips the local sync gracefully
- [ ] Errors are caught and returned as `{ success: false, error: string }`
- [ ] Preload bridge exposes `window.gitOps.prMerge()`
- [ ] Type declarations are complete
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-20/session-3/pr-merge-ipc.test.ts
describe('Session 3: PR Merge IPC Backend', () => {
  describe('parseWorktreeForBranch', () => {
    test('finds worktree path for matching branch', () => {
      const output = [
        'worktree /Users/dev/project',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /Users/dev/project-feature',
        'HEAD def456',
        'branch refs/heads/feature-x'
      ].join('\n')
      expect(parseWorktreeForBranch(output, 'main')).toBe('/Users/dev/project')
      expect(parseWorktreeForBranch(output, 'feature-x')).toBe('/Users/dev/project-feature')
    })

    test('returns null when branch not found', () => {
      const output = 'worktree /path\nHEAD abc\nbranch refs/heads/main\n'
      expect(parseWorktreeForBranch(output, 'develop')).toBeNull()
    })

    test('handles bare worktree (no branch line)', () => {
      const output = 'worktree /path\nHEAD abc\nbare\n'
      expect(parseWorktreeForBranch(output, 'main')).toBeNull()
    })

    test('handles detached HEAD worktree', () => {
      const output = 'worktree /path\nHEAD abc\ndetached\n'
      expect(parseWorktreeForBranch(output, 'main')).toBeNull()
    })
  })

  test('prMerge type declaration exists on gitOps', () => {
    // TypeScript compilation check -- window.gitOps.prMerge exists
  })
})
```

---

## Session 4: PR Lifecycle -- PR Detection Hook

### Objectives

- Create a `usePRDetection` hook that watches session messages for GitHub PR URLs
- Only monitor sessions tagged as PR sessions (matched by `sessionId` in `PRInfo`)
- When a PR URL is detected, extract the number and transition PR state to `created`

### Tasks

#### 1. Create `usePRDetection` hook

Create `src/renderer/src/hooks/usePRDetection.ts`:

```typescript
import { useEffect } from 'react'
import { useGitStore } from '@/stores'
import { useSessionStore } from '@/stores'

const PR_URL_PATTERN = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/

export function usePRDetection(worktreeId: string | null) {
  const prInfo = useGitStore((s) => (worktreeId ? s.prInfo.get(worktreeId) : undefined))
  const setPrState = useGitStore((s) => s.setPrState)

  // Get the session messages for the PR session
  const sessionId = prInfo?.sessionId
  const messages = useSessionStore((s) => (sessionId ? s.messages.get(sessionId) : undefined))

  useEffect(() => {
    if (!worktreeId || !prInfo || prInfo.state !== 'creating' || !sessionId) return

    // Search through all messages for a PR URL
    if (!messages) return
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      const content = typeof msg.content === 'string' ? msg.content : ''
      const match = content.match(PR_URL_PATTERN)
      if (match) {
        const prNumber = parseInt(match[1], 10)
        setPrState(worktreeId, {
          ...prInfo,
          state: 'created',
          prNumber,
          prUrl: match[0]
        })
        return
      }
    }
  }, [worktreeId, prInfo, sessionId, messages, setPrState])
}
```

#### 2. Determine where to mount the hook

The hook should be mounted in a component that is always rendered when a worktree is selected. `Header.tsx` is the natural home since it already renders the PR button:

```typescript
// In Header.tsx
usePRDetection(selectedWorktreeId)
```

### Key Files

- `src/renderer/src/hooks/usePRDetection.ts` -- **new file**
- `src/renderer/src/components/layout/Header.tsx` -- mount the hook

### Definition of Done

- [ ] `usePRDetection` hook monitors session messages for PR URLs
- [ ] Only sessions whose `sessionId` matches the `PRInfo.sessionId` are monitored
- [ ] Only `prInfo.state === 'creating'` triggers monitoring (avoids re-detection)
- [ ] When a PR URL like `https://github.com/org/repo/pull/123` is found, the PR number is extracted
- [ ] State transitions from `creating` to `created` with `prNumber` and `prUrl` set
- [ ] The hook is mounted in Header.tsx
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-20/session-4/pr-detection-hook.test.ts
describe('Session 4: PR Detection Hook', () => {
  test('PR_URL_PATTERN matches standard GitHub PR URLs', () => {
    const pattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/
    const match = 'https://github.com/myorg/myrepo/pull/42'.match(pattern)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('42')
  })

  test('PR_URL_PATTERN extracts number from URL embedded in text', () => {
    const pattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/
    const text = 'Created PR: https://github.com/org/repo/pull/123 successfully'
    const match = text.match(pattern)
    expect(match![1]).toBe('123')
  })

  test('does not match non-GitHub URLs', () => {
    const pattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/
    expect('https://gitlab.com/org/repo/pull/42'.match(pattern)).toBeNull()
  })

  test('hook transitions state from creating to created when PR URL found', () => {
    // Mock useGitStore with prInfo: { state: 'creating', sessionId: 's1' }
    // Mock useSessionStore with messages for 's1' containing a PR URL
    // Render hook
    // Verify setPrState called with state: 'created', prNumber, prUrl
  })

  test('hook does nothing when state is not creating', () => {
    // Mock prInfo with state: 'created'
    // Verify setPrState NOT called
  })

  test('hook does nothing when no messages contain PR URL', () => {
    // Mock messages with no PR URL
    // Verify setPrState NOT called (state stays 'creating')
  })
})
```

---

## Session 5: PR Lifecycle -- Header UI

### Objectives

- Update the PR button section in Header.tsx to be state-driven (none → creating → created → merged)
- Show "PR" button in `none`/`creating` state, "Merge PR" in `created` state, "Archive" in `merged` state
- Implement `handleMergePR` (calls `window.gitOps.prMerge`) and `handleArchiveWorktree`
- Update `handleCreatePR` to set PR state to `creating` with the session ID
- Wire up clean-tree detection for the merge button condition

### Tasks

#### 1. Update `handleCreatePR` to set PR state

After the session is created, tag it as a PR session:

```typescript
// After session creation succeeds:
useGitStore.getState().setPrState(wtId, {
  state: 'creating',
  sessionId: result.session.id,
  targetBranch: targetBranch
})
```

#### 2. Derive clean-tree state

Read from the git store to determine if the working tree has no changes:

```typescript
const fileStatuses = useGitStore((s) =>
  selectedWorktree?.path ? s.fileStatusesByWorktree.get(selectedWorktree.path) : undefined
)
const isCleanTree = !fileStatuses || fileStatuses.length === 0
```

#### 3. Replace static PR button with state-driven rendering

Replace the `isGitHub && (...)` block (lines 183-227) with the state machine rendering per the PRD: `none`/`creating` shows PR button (with spinner during creating), `created` + clean tree shows green "Merge PR" button, `merged` shows red "Archive" button.

#### 4. Implement `handleMergePR`

```typescript
const handleMergePR = useCallback(async () => {
  if (!selectedWorktree?.path || !selectedWorktreeId) return
  const pr = useGitStore.getState().prInfo.get(selectedWorktreeId)
  if (!pr?.prNumber) return

  try {
    const result = await window.gitOps.prMerge(selectedWorktree.path, pr.prNumber)
    if (result.success) {
      toast.success('PR merged successfully')
      useGitStore.getState().setPrState(selectedWorktreeId, { ...pr, state: 'merged' })
    } else {
      toast.error(`Merge failed: ${result.error}`)
    }
  } catch {
    toast.error('Failed to merge PR')
  }
}, [selectedWorktree?.path, selectedWorktreeId])
```

#### 5. Implement `handleArchiveWorktree`

```typescript
const handleArchiveWorktree = useCallback(async () => {
  if (!selectedWorktreeId) return
  await useWorktreeStore.getState().archiveWorktree(selectedWorktreeId)
}, [selectedWorktreeId])
```

#### 6. Add necessary icon imports

Add `Archive`, `GitMerge`, `Loader2` to the lucide-react imports if not already present.

### Key Files

- `src/renderer/src/components/layout/Header.tsx` -- state-driven UI, handlers

### Definition of Done

- [ ] PR button shows spinner when state is `creating`
- [ ] PR button is disabled during `creating` state
- [ ] "Merge PR" button (green) appears when state is `created` and tree is clean
- [ ] "Merge PR" button does NOT appear when tree has uncommitted changes (shows PR button instead)
- [ ] Clicking "Merge PR" calls `window.gitOps.prMerge` and transitions to `merged` on success
- [ ] "Archive" button (red/destructive) appears when state is `merged`
- [ ] Clicking "Archive" archives the worktree via existing `archiveWorktree()`
- [ ] Target branch dropdown is hidden when showing "Merge PR" or "Archive" (already set)
- [ ] Error toasts display on merge failure
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Click PR button -- verify session created, button shows spinner
2. After AI outputs PR URL -- verify "Merge PR" button appears (green)
3. Add an uncommitted file -- verify button reverts to "PR" (not "Merge PR")
4. Remove the file (clean tree) -- verify "Merge PR" reappears
5. Click "Merge PR" -- verify toast success, button becomes "Archive"
6. Click "Archive" -- verify worktree archives, view switches

### Testing Criteria

```typescript
// test/phase-20/session-5/pr-header-ui.test.tsx
describe('Session 5: PR Header UI', () => {
  test('renders PR button when prInfo state is none', () => {
    // Mock prInfo.get(worktreeId) returns undefined or { state: 'none' }
    // Render Header
    // Verify PR button with GitPullRequest icon is shown
  })

  test('renders spinner when prInfo state is creating', () => {
    // Mock prInfo with state: 'creating'
    // Render Header
    // Verify Loader2 spinner is shown, button is disabled
  })

  test('renders Merge PR button when state is created and tree is clean', () => {
    // Mock prInfo with state: 'created', prNumber: 42
    // Mock fileStatuses as empty array (clean tree)
    // Render Header
    // Verify green "Merge PR" button with GitMerge icon
  })

  test('renders PR button (not Merge) when state is created but tree is dirty', () => {
    // Mock prInfo with state: 'created'
    // Mock fileStatuses with at least one file
    // Render Header
    // Verify standard PR button shown, not Merge PR
  })

  test('renders Archive button when state is merged', () => {
    // Mock prInfo with state: 'merged'
    // Render Header
    // Verify red "Archive" button with Archive icon
  })

  test('handleCreatePR sets prState to creating with sessionId', async () => {
    // Mock session creation
    // Trigger handleCreatePR
    // Verify setPrState called with state: 'creating', sessionId
  })
})
```

---

## Session 6: Quit Confirmation When Worktrees Are Loading

### Objectives

- Add a `before-quit` handler in the main process that checks for running processes
- Show a native dialog asking the user to confirm quitting when processes are active
- Allow quitting immediately when no processes are running
- Handle the macOS dock-quit and window-close paths

### Tasks

#### 1. Expose active process counts from services

Each service needs a simple getter. Check which services already expose this, and add where missing:

- `src/main/services/opencode-service.ts` -- add `getActiveConnectionCount()` that returns the number of active OpenCode WebSocket connections
- Check terminal PTY tracking -- add `getActiveTerminalCount()` if not already available
- Check script runner -- add `getActiveScriptCount()` if not already available

#### 2. Add `checkForRunningProcesses()` function

In `src/main/index.ts` (or a utility imported there):

```typescript
function checkForRunningProcesses(): boolean {
  const activeOpenCode = getActiveOpenCodeConnectionCount()
  // Add other checks as discovered during implementation
  return activeOpenCode > 0
}
```

#### 3. Add `before-quit` handler

In `src/main/index.ts`:

```typescript
let forceQuit = false

app.on('before-quit', (event) => {
  if (forceQuit) return

  const hasRunning = checkForRunningProcesses()
  if (hasRunning) {
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

#### 4. Reset `forceQuit` on cancel

The `forceQuit` flag should only be set to `true` when the user confirms. It persists until the app actually quits (which is fine since `app.quit()` is called immediately after setting it).

### Key Files

- `src/main/index.ts` -- `before-quit` handler, `forceQuit` flag, `checkForRunningProcesses`
- `src/main/services/opencode-service.ts` -- expose active connection count
- Other service files as needed for terminal/script counts

### Definition of Done

- [ ] `before-quit` handler is registered before the existing `will-quit` handler
- [ ] When processes are running, `event.preventDefault()` stops the quit
- [ ] A native dialog appears with "Cancel" and "Quit Anyway" buttons
- [ ] Clicking "Cancel" does nothing (app stays open)
- [ ] Clicking "Quit Anyway" sets `forceQuit` and calls `app.quit()` again
- [ ] When no processes are running, the app quits immediately with no dialog
- [ ] Works for Cmd+Q, dock quit, and window close button on macOS
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start an AI session (active OpenCode connection) -- press Cmd+Q -- verify dialog appears
2. Click "Cancel" -- verify app stays open, session continues
3. Press Cmd+Q again -- click "Quit Anyway" -- verify app quits
4. With no active sessions -- press Cmd+Q -- verify app quits immediately (no dialog)
5. Test quitting from the macOS dock icon -- verify same behavior

### Testing Criteria

```typescript
// test/phase-20/session-6/quit-confirmation.test.ts
describe('Session 6: Quit Confirmation', () => {
  test('checkForRunningProcesses returns true when OpenCode connections active', () => {
    // Mock getActiveOpenCodeConnectionCount() returning 2
    // Verify checkForRunningProcesses() returns true
  })

  test('checkForRunningProcesses returns false when no processes running', () => {
    // Mock all counters returning 0
    // Verify checkForRunningProcesses() returns false
  })

  test('getActiveOpenCodeConnectionCount returns correct count', () => {
    // Verify the service exposes the count accurately
  })
})
```

---

## Session 7: Cmd+G Merge -- Store + Shortcut Definition

### Objectives

- Lift the `mergeBranch` local state from `GitPushPull` into `useGitStore` as `selectedMergeBranch`
- Add the `merge` shortcut definition to `DEFAULT_SHORTCUTS` in the Git category
- Update `GitPushPull` to read/write `selectedMergeBranch` from the store

### Tasks

#### 1. Add `selectedMergeBranch` to `useGitStore`

In `src/renderer/src/stores/useGitStore.ts`:

```typescript
// State
selectedMergeBranch: Map<string, string> // worktreePath → branchName

// Initial
selectedMergeBranch: new Map()

// Action
setSelectedMergeBranch: (worktreePath: string, branch: string) => {
  set((state) => {
    const newMap = new Map(state.selectedMergeBranch)
    newMap.set(worktreePath, branch)
    return { selectedMergeBranch: newMap }
  })
}
```

#### 2. Update `GitPushPull.tsx` to use store state

Replace the local `useState` for `mergeBranch`:

```typescript
// Before:
const [mergeBranch, setMergeBranch] = useState('')

// After:
const mergeBranch = useGitStore((s) =>
  worktreePath ? s.selectedMergeBranch.get(worktreePath) || '' : ''
)
const setSelectedMergeBranch = useGitStore((s) => s.setSelectedMergeBranch)
const setMergeBranch = (branch: string) => {
  if (worktreePath) setSelectedMergeBranch(worktreePath, branch)
}
```

Verify all existing references to `mergeBranch` and `setMergeBranch` in the component still work (they should since the API shape is the same -- a string value and a setter function).

#### 3. Add shortcut definition

In `src/renderer/src/lib/keyboard-shortcuts.ts`, add to the Git category in `DEFAULT_SHORTCUTS`:

```typescript
{
  id: 'merge',
  label: 'Merge',
  description: 'Merge selected branch',
  category: 'Git',
  defaultBinding: { key: 'g', meta: true }
}
```

### Key Files

- `src/renderer/src/stores/useGitStore.ts` -- `selectedMergeBranch` map + setter
- `src/renderer/src/components/git/GitPushPull.tsx` -- use store instead of local state
- `src/renderer/src/lib/keyboard-shortcuts.ts` -- add `merge` shortcut definition

### Definition of Done

- [ ] `selectedMergeBranch` is a `Map<string, string>` in useGitStore
- [ ] `setSelectedMergeBranch(worktreePath, branch)` updates the map
- [ ] `GitPushPull` reads from and writes to the store instead of local state
- [ ] All existing merge dropdown behavior works identically (selection, filtering, merge execution)
- [ ] The `merge` shortcut appears in `DEFAULT_SHORTCUTS` with `{ key: 'g', meta: true }`
- [ ] The shortcut appears in Settings > Shortcuts under the Git category
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-20/session-7/merge-shortcut-store.test.ts
describe('Session 7: Merge Shortcut Store + Definition', () => {
  test('selectedMergeBranch starts as empty map', () => {
    expect(useGitStore.getState().selectedMergeBranch.size).toBe(0)
  })

  test('setSelectedMergeBranch stores branch by worktree path', () => {
    useGitStore.getState().setSelectedMergeBranch('/path/wt1', 'feature-x')
    expect(useGitStore.getState().selectedMergeBranch.get('/path/wt1')).toBe('feature-x')
  })

  test('different worktrees have independent merge branch selections', () => {
    useGitStore.getState().setSelectedMergeBranch('/path/wt1', 'feature-x')
    useGitStore.getState().setSelectedMergeBranch('/path/wt2', 'main')
    expect(useGitStore.getState().selectedMergeBranch.get('/path/wt1')).toBe('feature-x')
    expect(useGitStore.getState().selectedMergeBranch.get('/path/wt2')).toBe('main')
  })

  test('merge shortcut is defined in DEFAULT_SHORTCUTS', () => {
    const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === 'merge')
    expect(shortcut).toBeDefined()
    expect(shortcut!.category).toBe('Git')
    expect(shortcut!.defaultBinding).toEqual({ key: 'g', meta: true })
  })
})
```

---

## Session 8: Cmd+G Merge -- Handler Wiring

### Objectives

- Add the merge shortcut handler to `getShortcutHandlers` in `useKeyboardShortcuts.ts`
- The handler reads `selectedMergeBranch` from the store and calls `window.gitOps.merge`
- Toast feedback for success, error, and "no branch selected"
- Optionally register in the application menu

### Tasks

#### 1. Add merge handler to `getShortcutHandlers`

In `src/renderer/src/hooks/useKeyboardShortcuts.ts`, in the `getShortcutHandlers` function:

```typescript
{
  shortcutId: 'merge',
  handler: async () => {
    const worktreeStore = useWorktreeStore.getState()
    const selectedWorktree = worktreeStore.worktrees.find(
      (w) => w.id === worktreeStore.selectedWorktreeId
    )
    if (!selectedWorktree?.path) return

    const gitStore = useGitStore.getState()
    const mergeBranch = gitStore.selectedMergeBranch.get(selectedWorktree.path)
    if (!mergeBranch) {
      toast.error('Select a branch to merge from first')
      return
    }

    // Check if already merging
    if (gitStore.isMerging) return

    try {
      const result = await window.gitOps.merge(selectedWorktree.path, mergeBranch)
      if (result.success) {
        toast.success(`Merged ${mergeBranch}`)
        // Refresh statuses
        gitStore.refreshStatuses(selectedWorktree.path)
      } else if (result.conflicts) {
        toast.warning(`Merge conflicts in ${result.conflicts.length} file(s)`)
      } else {
        toast.error(`Merge failed: ${result.error}`)
      }
    } catch {
      toast.error('Merge failed')
    }
  }
}
```

#### 2. Add `isMerging` check if not already accessible

Verify that `isMerging` is exposed from `useGitStore` or can be derived. If the merge is tracked locally in `GitPushPull`, lift it similarly to how `mergeBranch` was lifted in Session 7. If it's already in the store, just read it.

#### 3. (Optional) Register in application menu

Add a "Merge" menu item under the Git or Actions menu if one exists, with accelerator `CmdOrCtrl+G`.

### Key Files

- `src/renderer/src/hooks/useKeyboardShortcuts.ts` -- add merge handler
- `src/main/index.ts` or menu definition file -- optional menu item

### Definition of Done

- [ ] Pressing Cmd+G triggers the merge using the branch from `selectedMergeBranch`
- [ ] If no branch is selected, a toast "Select a branch to merge from first" appears
- [ ] If a merge is already in progress, the shortcut does nothing
- [ ] On success, a toast confirms the merge and statuses are refreshed
- [ ] On conflict, a warning toast mentions the conflict count
- [ ] On error, an error toast displays the failure message
- [ ] The shortcut is customizable via Settings > Shortcuts
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Select "main" in merge dropdown -- press Cmd+G -- verify merge executes and toast appears
2. Clear the merge dropdown selection -- press Cmd+G -- verify "Select a branch" toast
3. Trigger a merge that causes conflicts -- verify warning toast
4. Go to Settings > Shortcuts -- verify "Merge" appears under Git with Cmd+G
5. Rebind it to Cmd+Shift+G -- verify the new binding works

### Testing Criteria

```typescript
// test/phase-20/session-8/merge-shortcut-handler.test.ts
describe('Session 8: Merge Shortcut Handler', () => {
  test('handler calls window.gitOps.merge with selected branch', async () => {
    // Mock selectedMergeBranch: '/path/wt' -> 'feature-x'
    // Mock selectedWorktree with path '/path/wt'
    // Mock window.gitOps.merge returning { success: true }
    // Trigger merge handler
    // Verify window.gitOps.merge called with ('/path/wt', 'feature-x')
  })

  test('handler shows toast when no branch selected', async () => {
    // Mock selectedMergeBranch as empty for this worktree
    // Trigger merge handler
    // Verify toast.error called with 'Select a branch to merge from first'
    // Verify window.gitOps.merge NOT called
  })

  test('handler does nothing when isMerging is true', async () => {
    // Mock isMerging: true
    // Trigger merge handler
    // Verify window.gitOps.merge NOT called
  })

  test('handler shows success toast on successful merge', async () => {
    // Mock merge returning { success: true }
    // Trigger handler
    // Verify toast.success called
  })

  test('handler shows warning toast on merge conflicts', async () => {
    // Mock merge returning { success: false, conflicts: ['file1.ts', 'file2.ts'] }
    // Trigger handler
    // Verify toast.warning called
  })
})
```

---

## Session 9: Branch Up-to-Date Archive Swap

### Objectives

- Add `git:isBranchMerged` IPC handler using `git merge-base --is-ancestor`
- Add preload bridge and types
- Update `GitPushPull.tsx` to check if the selected branch is already merged
- Swap the "Merge" button for a red "Archive" button when the branch is up-to-date
- Archive action directly archives the worktree without confirmation

### Tasks

#### 1. Add `git:isBranchMerged` IPC handler

In `src/main/ipc/git-file-handlers.ts`:

```typescript
ipcMain.handle('git:isBranchMerged', async (_event, worktreePath: string, branch: string) => {
  try {
    await execPromise(`git merge-base --is-ancestor ${branch} HEAD`, { cwd: worktreePath })
    return { success: true, isMerged: true }
  } catch {
    return { success: true, isMerged: false }
  }
})
```

#### 2. Add preload bridge and types

In `src/preload/index.ts`:

```typescript
isBranchMerged: (worktreePath: string, branch: string) =>
  ipcRenderer.invoke('git:isBranchMerged', worktreePath, branch)
```

In `src/preload/index.d.ts`:

```typescript
isBranchMerged: (worktreePath: string, branch: string) =>
  Promise<{ success: boolean; isMerged: boolean }>
```

#### 3. Add merged check in `GitPushPull.tsx`

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

#### 4. Swap merge/archive button conditionally

Replace the merge button with conditional rendering:

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

#### 5. Add `handleArchiveWorktree` in `GitPushPull.tsx`

```typescript
const handleArchiveWorktree = useCallback(async () => {
  const worktreeId = useWorktreeStore.getState().selectedWorktreeId
  if (!worktreeId) return
  await useWorktreeStore.getState().archiveWorktree(worktreeId)
}, [])
```

### Key Files

- `src/main/ipc/git-file-handlers.ts` -- `git:isBranchMerged` handler
- `src/preload/index.ts` -- preload bridge
- `src/preload/index.d.ts` -- type declaration
- `src/renderer/src/components/git/GitPushPull.tsx` -- merged check, button swap, archive handler

### Definition of Done

- [ ] `git:isBranchMerged` correctly uses `git merge-base --is-ancestor`
- [ ] Returns `isMerged: true` when the branch is an ancestor of HEAD
- [ ] Returns `isMerged: false` when the branch has unmerged commits
- [ ] The check runs every time the merge branch selection changes
- [ ] "Archive" button (red/destructive) replaces "Merge" when branch is up-to-date
- [ ] "Merge" button (outline) shows when branch has unmerged changes
- [ ] Clicking "Archive" archives the worktree directly (no confirmation dialog)
- [ ] Changing the selected branch re-runs the check and swaps the button accordingly
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Select a branch that has been fully merged into the current branch -- verify "Archive" button (red)
2. Select a branch with new commits -- verify "Merge" button (normal)
3. Click "Archive" -- verify worktree archives
4. Switch between branches in the dropdown -- verify button swaps each time

### Testing Criteria

```typescript
// test/phase-20/session-9/branch-up-to-date.test.tsx
describe('Session 9: Branch Up-to-Date Archive Swap', () => {
  test('isBranchMerged returns true when branch is ancestor of HEAD', () => {
    // Mock execPromise for git merge-base --is-ancestor succeeding (exit 0)
    // Call handler
    // Verify { success: true, isMerged: true }
  })

  test('isBranchMerged returns false when branch is not ancestor', () => {
    // Mock execPromise for git merge-base --is-ancestor failing (non-zero exit)
    // Call handler
    // Verify { success: true, isMerged: false }
  })

  test('GitPushPull shows Archive button when isBranchMerged is true', () => {
    // Mock isBranchMerged API returning true
    // Render GitPushPull with a selected merge branch
    // Verify Archive button (destructive variant) is visible
    // Verify Merge button is NOT visible
  })

  test('GitPushPull shows Merge button when isBranchMerged is false', () => {
    // Mock isBranchMerged API returning false
    // Render GitPushPull with a selected merge branch
    // Verify Merge button is visible
    // Verify Archive button is NOT visible
  })

  test('Archive button calls archiveWorktree without confirmation', () => {
    // Mock archiveWorktree
    // Click Archive button
    // Verify archiveWorktree called immediately (no dialog)
  })

  test('changing branch re-checks merged status', () => {
    // Mock isBranchMerged
    // Change mergeBranch from 'merged-branch' to 'unmerged-branch'
    // Verify isBranchMerged called twice with different branch names
    // Verify button swaps accordingly
  })
})
```

---

## Session 10: Integration & Verification

### Objectives

- Verify all Phase 20 features work together end-to-end
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

**Added File Viewer (Session 1):**

- Click untracked `.md` file -- verify markdown preview (not raw source)
- Click untracked `.ts` file -- verify FileViewer with syntax highlighting
- Click modified file -- verify diff viewer (unchanged behavior)

**PR Lifecycle (Sessions 2-5):**

- Click PR button -- spinner shows, session created with PR prompt
- AI outputs PR URL -- button becomes "Merge PR" (green, clean tree only)
- Click "Merge PR" -- `gh pr merge` runs, button becomes "Archive"
- Click "Archive" -- worktree archives, view switches to no-worktree
- Restart app -- button resets to "PR" (in-memory state cleared)

**Quit Confirmation (Session 6):**

- With active AI session: Cmd+Q shows dialog, Cancel keeps app open, Quit Anyway quits
- With no sessions: Cmd+Q quits immediately

**Cmd+G Merge (Sessions 7-8):**

- Select branch + Cmd+G -- merge executes, toast confirms
- No branch selected + Cmd+G -- toast "Select a branch to merge from first"
- Shortcut visible in Settings > Shortcuts

**Branch Up-to-Date (Session 9):**

- Select merged branch -- Archive button (red) appears
- Select unmerged branch -- Merge button (outline) appears
- Archive button archives without confirmation

#### 3. Cross-feature interaction tests

- **PR lifecycle + branch up-to-date**: After PR merge, if the merge dropdown has the target branch selected (now up-to-date), verify Archive button shows in both the header (from PR flow) and the sidebar (from merged detection)
- **Cmd+G + branch up-to-date**: With a merged branch selected, pressing Cmd+G should attempt the merge (which is a no-op/fast-forward), not archive -- the Cmd+G shortcut always calls `gitOps.merge`, the archive swap is visual-only on the button
- **Added file viewer + existing file tabs**: Opening a new file via Changes should not interfere with existing diff tabs or session tabs
- **Quit confirmation + PR lifecycle**: If a PR session is still streaming, quit should trigger the confirmation dialog
- **Store state independence**: `prInfo`, `selectedMergeBranch`, and `isBranchMerged` should all work independently per worktree

#### 4. Verify no regressions

- Existing merge flow (sidebar merge without PR) still works
- Existing PR button flow (without merge/archive extension) still creates sessions
- Existing archive behavior (from worktree context menu) still works with confirmation dialog
- All Phase 19 features still pass

### Key Files

- All files modified in Sessions 1-9

### Definition of Done

- [ ] `pnpm test` passes with zero failures
- [ ] `pnpm lint` passes with zero errors
- [ ] All 5 features work end-to-end
- [ ] No regressions in existing Phase 19 features
- [ ] Cross-feature interactions behave correctly
- [ ] Edge cases tested (dirty tree, no branch selected, app restart, etc.)

### Testing Criteria

```typescript
// test/phase-20/session-10/integration-verification.test.ts
describe('Session 10: Phase 20 Integration', () => {
  test('added files route to FileViewer, modified files route to diff', () => {
    // Verify the routing logic covers all status codes
  })

  test('PR state machine transitions correctly through all states', () => {
    // none -> creating (PR button click)
    // creating -> created (PR URL detected)
    // created -> merged (Merge PR click)
    // merged -> archived (Archive click)
  })

  test('prInfo is independent per worktree', () => {
    // Set PR state on wt-1, verify wt-2 unaffected
  })

  test('selectedMergeBranch persists across component re-renders', () => {
    // Set branch in store, unmount/remount GitPushPull
    // Verify branch is still selected
  })

  test('Cmd+G triggers git merge, not PR merge or archive', () => {
    // Even when PR state is 'created', Cmd+G should call gitOps.merge
    // Not gitOps.prMerge
  })

  test('quit confirmation integrates with active OpenCode connections', () => {
    // Verify checkForRunningProcesses reads from actual service state
  })

  test('isBranchMerged check does not fire when no branch is selected', () => {
    // Verify no IPC call when mergeBranch is empty
  })

  test('all Phase 19 features still pass', () => {
    // Run phase-19 tests and verify no regressions
  })
})
```
