# Hive Phase 19 Implementation Plan

This document outlines the implementation plan for Hive Phase 19, covering dog breed naming, merge conflict sidebar UX, cross-worktree merge defaults, todo chevron icons, per-worktree model persistence, and tab context menus.

---

## Overview

The implementation is divided into **9 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 19 builds upon Phase 18** -- all Phase 18 infrastructure is assumed to be in place.

---

## Dependencies & Parallelization

```
Session 1  (Todo Chevron Icons)                  -- no deps
Session 2  (Dog Breed Names)                     -- no deps
Session 3  (Merge Conflicts Sidebar)             -- no deps
Session 4  (Cross-Worktree Merge Default)        -- no deps
Session 5  (Per-Worktree Model: Backend)         -- no deps
Session 6  (Per-Worktree Model: Frontend)        -- blocked by Session 5
Session 7  (Tab Context Menus: Store Actions)     -- no deps
Session 8  (Tab Context Menus: UI)               -- blocked by Session 7
Session 9  (Integration & Verification)          -- blocked by Sessions 1-8
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Time →                                                                  │
│                                                                          │
│  Track A: [S1: Todo Chevron Icons]                                       │
│  Track B: [S2: Dog Breed Names]                                          │
│  Track C: [S3: Merge Conflicts Sidebar]                                  │
│  Track D: [S4: Cross-Worktree Merge Default]                             │
│  Track E: [S5: Per-Worktree Model Backend] → [S6: Per-Worktree Frontend] │
│  Track F: [S7: Tab Context Store Actions]  → [S8: Tab Context UI]        │
│                                                                          │
│  All ────────────────────────────────────────────► [S9: Integration]     │
└──────────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 1-5, 7 are fully independent (6 sessions). Sessions 6, 8 depend on their predecessors.

**Minimum total**: 3 rounds:

1. (S1, S2, S3, S4, S5, S7 in parallel)
2. (S6, S8 -- after their dependencies)
3. (S9)

**Recommended serial order** (if doing one at a time):

S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9

Rationale: S1 is the smallest change (1 file). S2 is a straightforward rename with many files but low risk. S3-S4 are moderate UI/store changes. S5-S6 are sequential (DB migration + IPC then store + UI). S7-S8 are sequential (store actions then UI wiring). S9 validates everything.

---

## Testing Infrastructure

### Test File Structure (Phase 19)

```
test/
├── phase-19/
│   ├── session-1/
│   │   └── todo-chevron-icons.test.tsx
│   ├── session-2/
│   │   └── breed-names.test.ts
│   ├── session-3/
│   │   └── merge-conflicts-sidebar.test.tsx
│   ├── session-4/
│   │   └── cross-worktree-merge.test.ts
│   ├── session-5/
│   │   └── worktree-model-backend.test.ts
│   ├── session-6/
│   │   └── worktree-model-frontend.test.ts
│   ├── session-7/
│   │   └── tab-context-store.test.ts
│   ├── session-8/
│   │   └── tab-context-ui.test.tsx
│   └── session-9/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies -- all features use existing packages:
# - zustand (stores -- already installed)
# - lucide-react (icons -- already installed)
# - @radix-ui/react-context-menu (via shadcn -- already installed)
# - better-sqlite3 (database -- already installed)
# - Electron APIs: ipcRenderer, ipcMain (built-in)
```

---

## Session 1: Todo Chevron Priority Icons

### Objectives

- Replace the text-based `PriorityBadge` component with Jira-style chevron icons
- Low = single down chevron (blue), Medium = single up chevron (amber), High = double up chevron (red)
- Remove the background pill styling, use bare icons with color

### Tasks

#### 1. Replace `PriorityBadge` implementation

In `src/renderer/src/components/sessions/tools/TodoWriteToolView.tsx`, replace the `PriorityBadge` component (lines 31-43):

**Current:**

```tsx
function PriorityBadge({ priority }: { priority: TodoItem['priority'] }) {
  return (
    <span
      className={cn(
        'text-[10px] rounded px-1.5 py-0.5 font-medium shrink-0 leading-none',
        priority === 'high' && 'bg-red-500/15 text-red-500 dark:text-red-400',
        priority === 'medium' && 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        priority === 'low' && 'bg-muted text-muted-foreground'
      )}
    >
      {priority}
    </span>
  )
}
```

**New:**

```tsx
import { ChevronDown, ChevronUp, ChevronsUp } from 'lucide-react'

function PriorityBadge({ priority }: { priority: TodoItem['priority'] }) {
  switch (priority) {
    case 'high':
      return <ChevronsUp className="h-3.5 w-3.5 text-red-500 shrink-0" />
    case 'medium':
      return <ChevronUp className="h-3.5 w-3.5 text-amber-500 shrink-0" />
    case 'low':
      return <ChevronDown className="h-3.5 w-3.5 text-blue-500 shrink-0" />
    default:
      return null
  }
}
```

#### 2. Remove unused `cn` import if no longer needed

Check if `cn` is used elsewhere in the file. If `PriorityBadge` was the only consumer, the import of `cn` can be removed (it is also used in the todo item row at line 96-98, so it likely stays).

### Key Files

- `src/renderer/src/components/sessions/tools/TodoWriteToolView.tsx` -- replace `PriorityBadge`

### Definition of Done

- [ ] High priority shows a red double-up chevron (`ChevronsUp`) icon
- [ ] Medium priority shows an amber single-up chevron (`ChevronUp`) icon
- [ ] Low priority shows a blue single-down chevron (`ChevronDown`) icon
- [ ] No text labels ("high", "medium", "low") are rendered
- [ ] No background pill/badge styling remains on priority indicators
- [ ] Icons are positioned in the same location as the old text badges (right side of each todo item)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Trigger an AI session that uses the `TodoWrite` tool (e.g., ask Claude to plan a multi-step task)
2. Verify high-priority items show a red double-up chevron
3. Verify medium-priority items show an amber single-up chevron
4. Verify low-priority items show a blue single-down chevron
5. Verify no text labels appear next to the icons
6. Verify alignment -- icons should be vertically centered with the todo text

### Testing Criteria

```typescript
// test/phase-19/session-1/todo-chevron-icons.test.tsx
describe('Session 1: Todo Chevron Priority Icons', () => {
  test('high priority renders ChevronsUp icon in red', () => {
    render(<TodoWriteToolView input={{ todos: [
      { id: '1', content: 'Critical fix', status: 'pending', priority: 'high' }
    ] }} output="" error="" />)
    // Verify ChevronsUp SVG is present with text-red-500 class
    // Verify no text "high" in the priority area
  })

  test('medium priority renders ChevronUp icon in amber', () => {
    render(<TodoWriteToolView input={{ todos: [
      { id: '1', content: 'Some task', status: 'pending', priority: 'medium' }
    ] }} output="" error="" />)
    // Verify ChevronUp SVG is present with text-amber-500 class
    // Verify no text "medium" in the priority area
  })

  test('low priority renders ChevronDown icon in blue', () => {
    render(<TodoWriteToolView input={{ todos: [
      { id: '1', content: 'Nice to have', status: 'pending', priority: 'low' }
    ] }} output="" error="" />)
    // Verify ChevronDown SVG is present with text-blue-500 class
    // Verify no text "low" in the priority area
  })

  test('all three priorities render correctly in a mixed list', () => {
    render(<TodoWriteToolView input={{ todos: [
      { id: '1', content: 'High', status: 'pending', priority: 'high' },
      { id: '2', content: 'Med', status: 'in_progress', priority: 'medium' },
      { id: '3', content: 'Low', status: 'completed', priority: 'low' }
    ] }} output="" error="" />)
    // Verify all three icon types are present
    // Verify correct colors for each
  })
})
```

---

## Session 2: Replace Cities with Dog Breeds

### Objectives

- Replace the `CITY_NAMES` array with `BREED_NAMES` containing 120+ dog breed names
- Rename the file from `city-names.ts` to `breed-names.ts`
- Rename all exported functions (`getRandomCityName` → `getRandomBreedName`, etc.)
- Update all import sites across main process, IPC handlers, and tests
- Maintain backward compatibility for existing worktrees that have city-name branches

### Tasks

#### 1. Create `breed-names.ts` with the breed list

Create `src/main/services/breed-names.ts` with the full `BREED_NAMES` array (120+ entries organized by AKC group: Sporting, Hound, Working, Terrier, Toy, Herding, Non-Sporting). All names must be valid git branch names (lowercase, hyphens only, no spaces).

Export `BREED_NAMES`, `getRandomBreedName()`, `selectUniqueBreedName()`.

Also export `LEGACY_CITY_NAMES` -- a copy of the old city names array used only for backward-compatible auto-rename detection.

#### 2. Delete `city-names.ts`

Remove `src/main/services/city-names.ts`.

#### 3. Update `src/main/services/index.ts`

Change the re-export from `'./city-names'` to `'./breed-names'`.

#### 4. Update `src/main/services/git-service.ts`

Change import from `selectUniqueCityName` to `selectUniqueBreedName`. Update the call site in `createWorktree()` (around line 245).

#### 5. Update `src/main/services/opencode-service.ts`

- Import `BREED_NAMES` and `LEGACY_CITY_NAMES` from `'./breed-names'`
- Update the auto-rename detection logic (around line 1096-1130) to check both arrays:

```typescript
const isAutoName =
  BREED_NAMES.some((b) => branchName === b || branchName.startsWith(`${b}-v`)) ||
  LEGACY_CITY_NAMES.some((c) => branchName === c || branchName.startsWith(`${c}-v`))
```

#### 6. Update `src/main/ipc/worktree-handlers.ts`

- Import `BREED_NAMES` and `LEGACY_CITY_NAMES` from `'../services/breed-names'`
- Update the display name sync logic (around line 211-221) to check both arrays

#### 7. Update test files

- `test/phase-11/session-4/auto-rename-branch.test.ts` -- update imports, use breed names in test data
- `test/phase-11/session-3/branch-rename-infra.test.ts` -- update import to `BREED_NAMES`
- `test/phase-11/session-12/integration-verification.test.ts` -- update imports and test data
- `test/session-5/worktrees.test.tsx` -- replace city name references (`tokyo`, `paris`, `london`) with breed names

### Key Files

- `src/main/services/breed-names.ts` -- **new file** (replaces `city-names.ts`)
- `src/main/services/city-names.ts` -- **delete**
- `src/main/services/index.ts` -- update re-export
- `src/main/services/git-service.ts` -- update import and call
- `src/main/services/opencode-service.ts` -- update import and auto-rename detection
- `src/main/ipc/worktree-handlers.ts` -- update import and sync logic
- 4 test files -- update imports and test data

### Definition of Done

- [ ] `BREED_NAMES` array contains 120+ unique dog breed names
- [ ] All names are valid git branch names (lowercase, hyphens, no spaces or special chars)
- [ ] `getRandomBreedName()` returns a random breed from the list
- [ ] `selectUniqueBreedName()` avoids collisions and falls back to `-v1` suffix
- [ ] `LEGACY_CITY_NAMES` is exported for backward compatibility
- [ ] Auto-rename in `opencode-service.ts` detects both breed names AND legacy city names
- [ ] Worktree sync in `worktree-handlers.ts` detects both breed names AND legacy city names
- [ ] Creating a new worktree generates a breed-name branch (not a city name)
- [ ] `city-names.ts` is deleted
- [ ] No remaining imports of `city-names` or `CITY_NAMES` anywhere in the codebase
- [ ] All existing tests pass with updated references
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a new worktree -- verify the branch name is a dog breed (e.g., `golden-retriever`, `beagle`)
2. Verify no city names appear in newly created worktrees
3. Open an existing worktree that has a city-name branch (e.g., `chicago`) -- verify auto-rename still works when AI generates a session title
4. Run `pnpm test` -- all tests pass

### Testing Criteria

```typescript
// test/phase-19/session-2/breed-names.test.ts
describe('Session 2: Dog Breed Names', () => {
  test('BREED_NAMES contains 120+ entries', () => {
    expect(BREED_NAMES.length).toBeGreaterThanOrEqual(120)
  })

  test('all breed names are valid git branch names', () => {
    for (const name of BREED_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(name).not.toContain(' ')
      expect(name).not.toContain('_')
      expect(name).not.toMatch(/\.\./)
      expect(name).not.toEndWith('.')
      expect(name).not.toEndWith('.lock')
    }
  })

  test('no duplicate breed names', () => {
    const uniqueNames = new Set(BREED_NAMES)
    expect(uniqueNames.size).toBe(BREED_NAMES.length)
  })

  test('getRandomBreedName returns a name from the list', () => {
    const name = getRandomBreedName()
    expect(BREED_NAMES).toContain(name)
  })

  test('selectUniqueBreedName avoids existing names', () => {
    const existing = new Set(BREED_NAMES.slice(0, 119))
    const name = selectUniqueBreedName(existing)
    expect(existing.has(name)).toBe(false)
  })

  test('selectUniqueBreedName falls back to suffix when all names taken', () => {
    const existing = new Set(BREED_NAMES)
    const name = selectUniqueBreedName(existing)
    expect(name).toMatch(/-v\d+$/)
  })

  test('LEGACY_CITY_NAMES is exported for backward compatibility', () => {
    expect(LEGACY_CITY_NAMES).toBeDefined()
    expect(LEGACY_CITY_NAMES.length).toBeGreaterThan(100)
    expect(LEGACY_CITY_NAMES).toContain('tokyo')
    expect(LEGACY_CITY_NAMES).toContain('chicago')
  })

  test('auto-rename detection recognizes breed names', () => {
    const isAutoName = BREED_NAMES.some(
      (b) => 'golden-retriever' === b || 'golden-retriever'.startsWith(`${b}-v`)
    )
    expect(isAutoName).toBe(true)
  })

  test('auto-rename detection recognizes legacy city names', () => {
    const isAutoName = LEGACY_CITY_NAMES.some((c) => 'tokyo' === c || 'tokyo'.startsWith(`${c}-v`))
    expect(isAutoName).toBe(true)
  })
})
```

---

## Session 3: Merge Conflicts in Changes Sidebar

### Objectives

- Add conflicted files (`status === 'C'`) to the `ChangesView` file grouping
- Render a "Merge Conflicts" section as the first section in the sidebar with red styling
- Disable the commit button when merge conflicts exist
- Show an explanatory message when commit is disabled due to conflicts

### Tasks

#### 1. Add `conflictedFiles` to the grouping useMemo in `ChangesView.tsx`

In `src/renderer/src/components/file-tree/ChangesView.tsx` (lines 88-110), add a `conflicted` array to the grouping logic. Files with `status === 'C'` should be captured before checking other conditions:

```typescript
const conflicted: GitFileStatus[] = []

for (const file of files) {
  if (file.status === 'C') {
    conflicted.push(file)
  } else if (file.staged) {
    // ... existing logic
  }
}
```

Return `conflictedFiles: conflicted` in the result object.

#### 2. Render "Merge Conflicts" section

Add a new collapsible section before "Staged Changes" in the render output. Use `AlertTriangle` icon with red styling. The section should be open by default and have a red-tinted header:

- Icon: `AlertTriangle` in `text-red-500`
- Title: `Merge Conflicts ({count})`
- Each file rendered with the existing file list item pattern
- Clicking a conflicted file opens it in the diff viewer

#### 3. Update `GitCommitForm` to accept `hasConflicts` prop

In `src/renderer/src/components/git/GitCommitForm.tsx`:

- Add `hasConflicts?: boolean` to the props interface
- Update `canCommit` (line 71): `const canCommit = hasStaged && hasSummary && !isCommitting && !hasConflicts`
- Add a red helper text below the commit button: `"Resolve merge conflicts before committing"`

#### 4. Pass `hasConflicts` from `ChangesView` to `GitCommitForm`

Update the `<GitCommitForm>` render in `ChangesView` to pass `hasConflicts={conflictedFiles.length > 0}`.

### Key Files

- `src/renderer/src/components/file-tree/ChangesView.tsx` -- file grouping, conflicts section
- `src/renderer/src/components/git/GitCommitForm.tsx` -- disable logic, helper text

### Definition of Done

- [ ] Files with status `'C'` appear in a "Merge Conflicts" section at the top of the changes sidebar
- [ ] The section uses `AlertTriangle` icon with red color
- [ ] The section is open by default
- [ ] Clicking a conflicted file opens it in the diff viewer
- [ ] The commit button is disabled when conflicts exist
- [ ] A red helper text "Resolve merge conflicts before committing" appears when disabled due to conflicts
- [ ] Resolving all conflicts (no more `'C'` files) removes the section and re-enables commit
- [ ] Modified, staged, and untracked files continue to work normally
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a merge conflict: create two branches with conflicting changes to the same file, merge one into the other
2. Verify the "Merge Conflicts" section appears at the top of the changes sidebar
3. Verify the conflicted files are listed with appropriate styling
4. Verify the commit button is disabled with the helper message
5. Click a conflicted file -- verify the diff viewer opens
6. Resolve the conflict (edit the file, stage it) -- verify the section disappears and commit is re-enabled
7. When no conflicts exist -- verify no "Merge Conflicts" section is shown

### Testing Criteria

```typescript
// test/phase-19/session-3/merge-conflicts-sidebar.test.tsx
describe('Session 3: Merge Conflicts in Changes Sidebar', () => {
  test('conflicted files are grouped separately from modified files', () => {
    // Mock fileStatusesByWorktree with files including status 'C'
    // Render ChangesView
    // Verify conflicted files appear in "Merge Conflicts" section
    // Verify they do NOT appear in "Changes" or "Staged" sections
  })

  test('Merge Conflicts section renders as the first section', () => {
    // Mock files with mix of 'C', 'M', 'A', '?' statuses
    // Render ChangesView
    // Verify "Merge Conflicts" section appears before "Staged Changes"
  })

  test('commit button is disabled when hasConflicts is true', () => {
    // Render GitCommitForm with hasConflicts={true}, hasStaged, hasSummary
    // Verify commit button is disabled
  })

  test('commit button is enabled when hasConflicts is false', () => {
    // Render GitCommitForm with hasConflicts={false}, hasStaged, hasSummary
    // Verify commit button is enabled
  })

  test('helper text appears when conflicts disable commit', () => {
    // Render GitCommitForm with hasConflicts={true}
    // Verify "Resolve merge conflicts before committing" text is present
  })

  test('helper text hidden when no conflicts', () => {
    // Render GitCommitForm with hasConflicts={false}
    // Verify no conflict helper text
  })

  test('hasConflicts is passed from ChangesView to GitCommitForm', () => {
    // Mock files with conflicted files
    // Render ChangesView
    // Verify GitCommitForm receives hasConflicts={true}
  })
})
```

---

## Session 4: Cross-Worktree Merge Default

### Objectives

- After a successful commit, set the committed branch as the default merge target for sibling worktrees
- Store the default merge branch per project (in-memory, keyed by projectId)
- Read the default in `GitPushPull` to pre-populate the merge branch dropdown
- Exclude the current branch from the default (don't suggest merging a branch into itself)

### Tasks

#### 1. Add `defaultMergeBranch` state to `useGitStore`

In `src/renderer/src/stores/useGitStore.ts`:

- Add `defaultMergeBranch: Map<string, string>` to the state interface (projectId → branch name)
- Add `setDefaultMergeBranch(projectId: string, branchName: string)` action

```typescript
defaultMergeBranch: new Map() as Map<string, string>,

setDefaultMergeBranch: (projectId: string, branchName: string) => {
  set((state) => {
    const newMap = new Map(state.defaultMergeBranch)
    newMap.set(projectId, branchName)
    return { defaultMergeBranch: newMap }
  })
},
```

#### 2. Set default merge branch after successful commit

In `useGitStore.commit()` (around line 342-357), after `refreshStatuses()` succeeds:

```typescript
// After refresh:
const branchInfo = get().branchInfoByWorktree.get(worktreePath)
if (branchInfo?.name) {
  const worktreeStore = useWorktreeStore.getState()
  const worktree = worktreeStore.worktrees.find((w) => w.path === worktreePath)
  if (worktree?.project_id) {
    get().setDefaultMergeBranch(worktree.project_id, branchInfo.name)
  }
}
```

#### 3. Read default merge branch in `GitPushPull.tsx`

In `src/renderer/src/components/git/GitPushPull.tsx`:

- Look up the worktree's project ID via `useWorktreeStore`
- Read `defaultMergeBranch` from `useGitStore`
- In a `useEffect`, if `defaultMergeBranch` is set and differs from the current branch and `mergeBranch` is empty, initialize `setMergeBranch(defaultMergeBranch)`

```typescript
const worktree = useWorktreeStore((s) => s.worktrees.find((w) => w.path === worktreePath))
const defaultMerge = useGitStore((s) =>
  worktree?.project_id ? s.defaultMergeBranch.get(worktree.project_id) : undefined
)
const currentBranch = useGitStore((s) => s.branchInfoByWorktree.get(worktreePath))?.name

useEffect(() => {
  if (defaultMerge && defaultMerge !== currentBranch && !mergeBranch) {
    setMergeBranch(defaultMerge)
  }
}, [defaultMerge, currentBranch])
```

### Key Files

- `src/renderer/src/stores/useGitStore.ts` -- `defaultMergeBranch` state, action, set in `commit()`
- `src/renderer/src/components/git/GitPushPull.tsx` -- read default, initialize dropdown

### Definition of Done

- [ ] After committing on branch X, sibling worktrees' merge dropdown defaults to "X"
- [ ] The committing worktree itself does not see its own branch as default (excluded)
- [ ] The default is in-memory only (resets on app restart -- acceptable)
- [ ] If the user has already manually selected a merge branch, the default does not override it
- [ ] Multiple commits on different branches update the default to the latest
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a project with multiple worktrees (e.g., main, feature-a, feature-b)
2. Switch to feature-a, make a commit
3. Switch to main -- verify the merge dropdown pre-selects "feature-a"
4. Switch to feature-b -- verify the merge dropdown also pre-selects "feature-a"
5. Switch back to feature-a -- verify the merge dropdown does NOT pre-select "feature-a" (it's the current branch)
6. On feature-b, commit -- switch to main -- verify merge dropdown now shows "feature-b"

### Testing Criteria

```typescript
// test/phase-19/session-4/cross-worktree-merge.test.ts
describe('Session 4: Cross-Worktree Merge Default', () => {
  test('setDefaultMergeBranch stores branch by project ID', () => {
    const store = useGitStore.getState()
    store.setDefaultMergeBranch('project-1', 'feature-auth')
    expect(store.defaultMergeBranch.get('project-1')).toBe('feature-auth')
  })

  test('commit sets defaultMergeBranch for the project', async () => {
    // Mock: branchInfoByWorktree has branch 'feature-x' for worktreePath
    // Mock: useWorktreeStore has worktree with project_id 'proj-1' at worktreePath
    // Mock: window.gitOps.commit succeeds
    // Call useGitStore.getState().commit(worktreePath, 'msg')
    // Verify defaultMergeBranch.get('proj-1') === 'feature-x'
  })

  test('default merge branch is not applied when it matches current branch', () => {
    // Set defaultMergeBranch to 'feature-x'
    // Render GitPushPull on a worktree whose branch IS 'feature-x'
    // Verify mergeBranch is NOT set to 'feature-x'
  })

  test('default merge branch initializes dropdown when current branch differs', () => {
    // Set defaultMergeBranch to 'feature-x'
    // Render GitPushPull on a worktree whose branch is 'main'
    // Verify mergeBranch is initialized to 'feature-x'
  })

  test('manual selection is not overridden by default', () => {
    // Set mergeBranch to 'manual-choice' already
    // Set defaultMergeBranch to 'feature-x'
    // Verify mergeBranch remains 'manual-choice'
  })
})
```

---

## Session 5: Per-Worktree Model Persistence -- Backend

### Objectives

- Add a database migration with `last_model_provider_id`, `last_model_id`, `last_model_variant` columns on the `worktrees` table
- Add an `updateWorktreeModel` method to the database service
- Add a `db:worktree:updateModel` IPC handler
- Expose through the preload bridge with type declarations
- Add model fields to `Worktree` type interfaces

### Tasks

#### 1. Database migration

In `src/main/db/schema.ts`, bump `CURRENT_SCHEMA_VERSION` and add a new entry to the `MIGRATIONS` array:

```typescript
{
  version: <next_version>,
  name: 'add_worktree_model_columns',
  up: `
    ALTER TABLE worktrees ADD COLUMN last_model_provider_id TEXT;
    ALTER TABLE worktrees ADD COLUMN last_model_id TEXT;
    ALTER TABLE worktrees ADD COLUMN last_model_variant TEXT;
  `
}
```

#### 2. Add `updateWorktreeModel` to database service

In `src/main/db/database.ts`, add a method:

```typescript
updateWorktreeModel(
  worktreeId: string,
  modelProviderId: string,
  modelId: string,
  modelVariant: string | null
): void {
  this.db.prepare(`
    UPDATE worktrees
    SET last_model_provider_id = ?, last_model_id = ?, last_model_variant = ?
    WHERE id = ?
  `).run(modelProviderId, modelId, modelVariant, worktreeId)
}
```

#### 3. Update main-process types

In `src/main/db/types.ts`:

- Add to `Worktree` interface: `last_model_provider_id: string | null`, `last_model_id: string | null`, `last_model_variant: string | null`
- Add to `WorktreeUpdate` interface: same fields as optional

#### 4. Add IPC handler

In `src/main/ipc/database-handlers.ts`:

```typescript
ipcMain.handle(
  'db:worktree:updateModel',
  async (_event, { worktreeId, modelProviderId, modelId, modelVariant }) => {
    try {
      db.updateWorktreeModel(worktreeId, modelProviderId, modelId, modelVariant ?? null)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)
```

#### 5. Expose in preload

In `src/preload/index.ts`, add under the `db.worktree` namespace:

```typescript
updateModel: (params: {
  worktreeId: string
  modelProviderId: string
  modelId: string
  modelVariant: string | null
}) => ipcRenderer.invoke('db:worktree:updateModel', params)
```

#### 6. Type declarations

In `src/preload/index.d.ts`:

- Add `last_model_provider_id: string | null`, `last_model_id: string | null`, `last_model_variant: string | null` to the `Worktree` interface
- Add `updateModel` method to the `db.worktree` namespace interface

### Key Files

- `src/main/db/schema.ts` -- migration
- `src/main/db/database.ts` -- `updateWorktreeModel` method
- `src/main/db/types.ts` -- type additions
- `src/main/ipc/database-handlers.ts` -- IPC handler
- `src/preload/index.ts` -- preload bridge
- `src/preload/index.d.ts` -- type declarations

### Definition of Done

- [ ] Migration adds three nullable columns to `worktrees` table
- [ ] `CURRENT_SCHEMA_VERSION` is bumped
- [ ] `updateWorktreeModel` correctly updates the database row
- [ ] IPC handler `db:worktree:updateModel` is registered and functional
- [ ] Preload bridge exposes `window.db.worktree.updateModel()`
- [ ] Type declarations include model fields on `Worktree` and the `updateModel` method
- [ ] Existing worktree queries continue to work (new columns default to NULL)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-19/session-5/worktree-model-backend.test.ts
describe('Session 5: Per-Worktree Model Backend', () => {
  test('Worktree type includes model fields', () => {
    // TypeScript compilation check -- Worktree has last_model_provider_id, etc.
  })

  test('updateModel type declaration exists on db.worktree', () => {
    // TypeScript compilation check
  })

  test('migration adds last_model_* columns', () => {
    // Verify the migration SQL is correct
    // Verify CURRENT_SCHEMA_VERSION is bumped
  })
})
```

---

## Session 6: Per-Worktree Model Persistence -- Frontend

### Objectives

- Update `useWorktreeStore` to include model fields on the `Worktree` interface and add an `updateWorktreeModel` action
- Update `useSessionStore.setSessionModel` to also persist the model to the worktree
- Update `useSessionStore.createSession` to check the worktree's model first, then fall back to global

### Tasks

#### 1. Update `Worktree` interface in `useWorktreeStore.ts`

Add the model fields to the in-memory `Worktree` interface (around line 9-22):

```typescript
last_model_provider_id: string | null
last_model_id: string | null
last_model_variant: string | null
```

#### 2. Add `updateWorktreeModel` action

```typescript
updateWorktreeModel: (worktreeId: string, model: SelectedModel) => {
  set((state) => {
    const allWorktrees = [...state.worktrees]
    const idx = allWorktrees.findIndex((w) => w.id === worktreeId)
    if (idx !== -1) {
      allWorktrees[idx] = {
        ...allWorktrees[idx],
        last_model_provider_id: model.providerID,
        last_model_id: model.modelID,
        last_model_variant: model.variant ?? null
      }
    }
    return { worktrees: allWorktrees }
  })
}
```

#### 3. Update `setSessionModel` to persist to worktree

In `src/renderer/src/stores/useSessionStore.ts`, in the `setSessionModel` action (around line 513-552), after the existing session update, add:

```typescript
// Also persist as the worktree's last-used model
const session = get().sessions.get(sessionId)
if (session?.worktree_id) {
  try {
    await window.db.worktree.updateModel({
      worktreeId: session.worktree_id,
      modelProviderId: model.providerID,
      modelId: model.modelID,
      modelVariant: model.variant ?? null
    })
    useWorktreeStore.getState().updateWorktreeModel(session.worktree_id, model)
  } catch {
    /* non-critical */
  }
}
```

#### 4. Update `createSession` default cascade

In `useSessionStore.ts`, update `createSession` (around line 161-197) to check the worktree model first:

```typescript
// Priority 1: worktree's last-used model
const worktree = useWorktreeStore.getState().worktrees.find((w) => w.id === worktreeId)
const worktreeModel = worktree?.last_model_id
  ? {
      model_provider_id: worktree.last_model_provider_id,
      model_id: worktree.last_model_id,
      model_variant: worktree.last_model_variant
    }
  : null

// Priority 2: global default (skip the old "find last session" heuristic)
const globalModel = !worktreeModel
  ? (() => {
      const global = useSettingsStore.getState().selectedModel
      return global
        ? {
            model_provider_id: global.providerID,
            model_id: global.modelID,
            model_variant: global.variant ?? null
          }
        : null
    })()
  : null

const defaultModel = worktreeModel || globalModel
```

### Key Files

- `src/renderer/src/stores/useWorktreeStore.ts` -- model fields, `updateWorktreeModel` action
- `src/renderer/src/stores/useSessionStore.ts` -- update `setSessionModel`, update `createSession`

### Definition of Done

- [ ] Changing the model on any session tab persists the model to the worktree's DB row
- [ ] The in-memory worktree record is updated immediately
- [ ] New sessions in a worktree inherit the worktree's last-used model
- [ ] If the worktree has no model set, new sessions fall back to the global default
- [ ] The old "find last session's model" heuristic is replaced by the worktree model lookup
- [ ] Model persistence survives app restart (database-backed)
- [ ] Changing model on worktree A does not affect worktree B's default
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open worktree A, select model "claude-opus" on a session tab
2. Create a new tab in worktree A -- verify it defaults to "claude-opus"
3. Switch to worktree B -- create a new tab -- verify it uses the global default (not worktree A's model)
4. On worktree B, change to "gpt-4o" -- create a new tab -- verify it defaults to "gpt-4o"
5. Restart the app -- open worktree A -- create a new tab -- verify it still defaults to "claude-opus"
6. Open worktree B -- create a new tab -- verify it still defaults to "gpt-4o"

### Testing Criteria

```typescript
// test/phase-19/session-6/worktree-model-frontend.test.ts
describe('Session 6: Per-Worktree Model Frontend', () => {
  test('setSessionModel persists model to worktree', async () => {
    // Mock window.db.worktree.updateModel
    // Mock session with worktree_id
    // Call setSessionModel
    // Verify window.db.worktree.updateModel called with correct params
    // Verify useWorktreeStore.updateWorktreeModel called
  })

  test('createSession uses worktree model when available', async () => {
    // Mock worktree with last_model_id = 'claude-opus'
    // Call createSession
    // Verify window.db.session.create called with model_id = 'claude-opus'
  })

  test('createSession falls back to global when worktree has no model', async () => {
    // Mock worktree with last_model_id = null
    // Mock useSettingsStore.selectedModel = { modelID: 'gpt-4o' }
    // Call createSession
    // Verify window.db.session.create called with model_id = 'gpt-4o'
  })

  test('updateWorktreeModel updates in-memory record', () => {
    // Set up worktree in store
    // Call updateWorktreeModel
    // Verify worktree record has updated model fields
  })
})
```

---

## Session 7: Tab Context Menus -- Store Actions

### Objectives

- Add `closeOtherSessions` and `closeSessionsToRight` actions to `useSessionStore`
- Add `closeOtherFiles` and `closeFilesToRight` actions to `useFileViewerStore`
- These store actions provide the backend for the context menu UI in Session 8

### Tasks

#### 1. Add `closeOtherSessions` to `useSessionStore`

In `src/renderer/src/stores/useSessionStore.ts`:

```typescript
closeOtherSessions: async (worktreeId: string, keepSessionId: string) => {
  const tabOrder = [...(get().tabOrderByWorktree.get(worktreeId) || [])]
  for (const sessionId of tabOrder) {
    if (sessionId !== keepSessionId) {
      await get().closeSession(sessionId)
    }
  }
  // Ensure the kept session is active
  set({ activeSessionId: keepSessionId })
}
```

#### 2. Add `closeSessionsToRight` to `useSessionStore`

```typescript
closeSessionsToRight: async (worktreeId: string, fromSessionId: string) => {
  const tabOrder = [...(get().tabOrderByWorktree.get(worktreeId) || [])]
  const index = tabOrder.indexOf(fromSessionId)
  if (index === -1) return
  const toClose = tabOrder.slice(index + 1)
  for (const sessionId of toClose) {
    await get().closeSession(sessionId)
  }
}
```

#### 3. Add `closeOtherFiles` to `useFileViewerStore`

In `src/renderer/src/stores/useFileViewerStore.ts`:

```typescript
closeOtherFiles: (keepKey: string) => {
  set((state) => {
    const newMap = new Map<string, TabEntry>()
    const kept = state.openFiles.get(keepKey)
    if (kept) newMap.set(keepKey, kept)
    return {
      openFiles: newMap,
      activeFilePath: kept ? keepKey : null,
      activeDiff: kept?.type === 'diff' ? state.activeDiff : null
    }
  })
}
```

#### 4. Add `closeFilesToRight` to `useFileViewerStore`

```typescript
closeFilesToRight: (fromKey: string) => {
  set((state) => {
    const keys = [...state.openFiles.keys()]
    const index = keys.indexOf(fromKey)
    if (index === -1) return state
    const newMap = new Map<string, TabEntry>()
    for (let i = 0; i <= index; i++) {
      const entry = state.openFiles.get(keys[i])
      if (entry) newMap.set(keys[i], entry)
    }
    // If active file was to the right and got closed, activate the fromKey
    const activeStillOpen = newMap.has(state.activeFilePath || '')
    return {
      openFiles: newMap,
      activeFilePath: activeStillOpen ? state.activeFilePath : fromKey
    }
  })
}
```

### Key Files

- `src/renderer/src/stores/useSessionStore.ts` -- `closeOtherSessions`, `closeSessionsToRight`
- `src/renderer/src/stores/useFileViewerStore.ts` -- `closeOtherFiles`, `closeFilesToRight`

### Definition of Done

- [ ] `closeOtherSessions(worktreeId, keepId)` closes all sessions except `keepId`
- [ ] After closing others, `keepId` is the active session
- [ ] `closeSessionsToRight(worktreeId, fromId)` closes only sessions after `fromId` in tab order
- [ ] `closeOtherFiles(keepKey)` closes all file/diff tabs except `keepKey`
- [ ] After closing other files, `keepKey` is the active file tab
- [ ] `closeFilesToRight(fromKey)` closes file tabs after `fromKey` in the map order
- [ ] If the active tab was among the closed ones, the kept/from tab becomes active
- [ ] Edge case: closing others when there's only one tab is a no-op
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-19/session-7/tab-context-store.test.ts
describe('Session 7: Tab Context Store Actions', () => {
  describe('useSessionStore', () => {
    test('closeOtherSessions closes all except the kept session', async () => {
      // Set up tabOrder: ['s1', 's2', 's3']
      // Call closeOtherSessions(worktreeId, 's2')
      // Verify closeSession called for 's1' and 's3'
      // Verify activeSessionId = 's2'
    })

    test('closeSessionsToRight closes sessions after the given one', async () => {
      // Set up tabOrder: ['s1', 's2', 's3', 's4']
      // Call closeSessionsToRight(worktreeId, 's2')
      // Verify closeSession called for 's3' and 's4'
      // Verify 's1' and 's2' remain
    })

    test('closeSessionsToRight with last tab is a no-op', async () => {
      // Set up tabOrder: ['s1', 's2']
      // Call closeSessionsToRight(worktreeId, 's2')
      // Verify no closeSession calls
    })

    test('closeOtherSessions with single tab is a no-op', async () => {
      // Set up tabOrder: ['s1']
      // Call closeOtherSessions(worktreeId, 's1')
      // Verify no closeSession calls
    })
  })

  describe('useFileViewerStore', () => {
    test('closeOtherFiles keeps only the specified file', () => {
      // Set up openFiles with 3 entries
      // Call closeOtherFiles('file-2')
      // Verify openFiles has only 'file-2'
      // Verify activeFilePath = 'file-2'
    })

    test('closeFilesToRight removes files after the specified one', () => {
      // Set up openFiles: ['f1', 'f2', 'f3']
      // Call closeFilesToRight('f1')
      // Verify openFiles has only 'f1'
    })

    test('closeOtherFiles with single file is a no-op', () => {
      // Set up openFiles with 1 entry
      // Call closeOtherFiles('only-file')
      // Verify openFiles unchanged
    })
  })
})
```

---

## Session 8: Tab Context Menus -- UI

### Objectives

- Add right-click context menus to session tabs, file tabs, and diff tabs in `SessionTabs.tsx`
- Session tabs: Close, Close Others, Close Others to the Right
- File/diff tabs: all of the above + Copy Relative Path, Copy Absolute Path
- Use the existing shadcn/ui `ContextMenu` pattern

### Tasks

#### 1. Import context menu components

In `src/renderer/src/components/sessions/SessionTabs.tsx`, add imports:

```typescript
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
```

#### 2. Wrap `SessionTab` with context menu

In the `SessionTab` component (lines 38-174), wrap the tab's outer `div` with `<ContextMenu>` / `<ContextMenuTrigger>`:

```tsx
<ContextMenu>
  <ContextMenuTrigger asChild>{/* existing tab div */}</ContextMenuTrigger>
  <ContextMenuContent>
    <ContextMenuItem onClick={() => handleCloseSession(session.id)}>
      Close
      <ContextMenuShortcut>⌘W</ContextMenuShortcut>
    </ContextMenuItem>
    <ContextMenuItem onClick={() => closeOtherSessions(worktreeId, session.id)}>
      Close Others
    </ContextMenuItem>
    <ContextMenuItem onClick={() => closeSessionsToRight(worktreeId, session.id)}>
      Close Others to the Right
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

#### 3. Wrap `FileTab` with context menu (including copy paths)

```tsx
<ContextMenu>
  <ContextMenuTrigger asChild>{/* existing tab div */}</ContextMenuTrigger>
  <ContextMenuContent>
    <ContextMenuItem onClick={() => closeFile(tabKey)}>
      Close
      <ContextMenuShortcut>⌘W</ContextMenuShortcut>
    </ContextMenuItem>
    <ContextMenuItem onClick={() => closeOtherFiles(tabKey)}>Close Others</ContextMenuItem>
    <ContextMenuItem onClick={() => closeFilesToRight(tabKey)}>
      Close Others to the Right
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem onClick={() => copyToClipboard(relativePath)}>
      Copy Relative Path
    </ContextMenuItem>
    <ContextMenuItem onClick={() => copyToClipboard(absolutePath)}>
      Copy Absolute Path
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

#### 4. Wrap `DiffTabItem` with context menu (same as file tabs)

Same pattern as `FileTab` -- include Close, Close Others, Close Others to the Right, separator, Copy Relative Path, Copy Absolute Path.

For diff tabs, the relative path is `tab.filePath` and the absolute path is `path.join(tab.worktreePath, tab.filePath)`.

#### 5. Add clipboard copy helper

```typescript
const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text)
  toast.success('Copied to clipboard')
}
```

#### 6. Compute relative and absolute paths for file/diff tabs

For file tabs: `tab.path` is the absolute path, relative path is computed by stripping the worktree path prefix.

For diff tabs: `tab.filePath` is already relative, absolute is `worktreePath + '/' + filePath`.

### Key Files

- `src/renderer/src/components/sessions/SessionTabs.tsx` -- context menus on all three tab types

### Definition of Done

- [ ] Right-clicking a session tab shows: Close, Close Others, Close Others to the Right
- [ ] Right-clicking a file tab shows: Close, Close Others, Close Others to the Right, separator, Copy Relative Path, Copy Absolute Path
- [ ] Right-clicking a diff tab shows the same menu as file tabs
- [ ] "Close" closes the right-clicked tab (same as clicking X)
- [ ] "Close Others" closes all tabs of the same type except the right-clicked one
- [ ] "Close Others to the Right" closes tabs to the right of the right-clicked one
- [ ] "Copy Relative Path" copies the relative file path to clipboard and shows success toast
- [ ] "Copy Absolute Path" copies the full file path to clipboard and shows success toast
- [ ] The keyboard shortcut hint (⌘W) appears next to "Close"
- [ ] The context menu does not interfere with existing middle-click and X-button close behavior
- [ ] The context menu uses the same visual style as other context menus in the app (shadcn/ui)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open multiple session tabs -- right-click one -- verify the context menu appears
2. Click "Close" -- verify the tab closes
3. Open 4 session tabs -- right-click the 2nd -- click "Close Others" -- verify only the 2nd remains
4. Open 4 session tabs -- right-click the 2nd -- click "Close Others to the Right" -- verify 3rd and 4th close
5. Open a file tab -- right-click -- verify the file-specific context menu appears with copy options
6. Click "Copy Relative Path" -- paste somewhere -- verify the relative path is correct
7. Click "Copy Absolute Path" -- paste -- verify the full path is correct
8. Open a diff tab -- right-click -- verify same menu as file tabs
9. Verify middle-click close still works alongside context menu

### Testing Criteria

```typescript
// test/phase-19/session-8/tab-context-ui.test.tsx
describe('Session 8: Tab Context Menus UI', () => {
  test('session tab context menu has Close, Close Others, Close to Right', async () => {
    // Render SessionTabs with multiple sessions
    // Right-click (fireEvent.contextMenu) on a session tab
    // Verify menu items: "Close", "Close Others", "Close Others to the Right"
    // Verify NO "Copy Relative Path" or "Copy Absolute Path"
  })

  test('file tab context menu has close actions and copy paths', async () => {
    // Render SessionTabs with open file tabs
    // Right-click on a file tab
    // Verify menu items include all 5: Close, Close Others, Close to Right,
    //   Copy Relative Path, Copy Absolute Path
  })

  test('diff tab context menu has close actions and copy paths', async () => {
    // Render SessionTabs with open diff tabs
    // Right-click on a diff tab
    // Verify same 5 menu items as file tabs
  })

  test('Close Others calls closeOtherSessions', async () => {
    // Mock closeOtherSessions
    // Right-click session tab, click "Close Others"
    // Verify closeOtherSessions called with correct worktreeId and sessionId
  })

  test('Copy Relative Path copies to clipboard', async () => {
    // Mock navigator.clipboard.writeText
    // Right-click file tab, click "Copy Relative Path"
    // Verify clipboard.writeText called with relative path
  })

  test('Copy Absolute Path copies to clipboard', async () => {
    // Mock navigator.clipboard.writeText
    // Right-click file tab, click "Copy Absolute Path"
    // Verify clipboard.writeText called with absolute path
  })
})
```

---

## Session 9: Integration & Verification

### Objectives

- Verify all Phase 19 features work together end-to-end
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

**Todo Chevron Icons:**

- Trigger TodoWrite tool -- verify chevron icons with correct colors per priority level

**Dog Breed Names:**

- Create new worktree -- verify breed-name branch
- Existing city-name worktrees -- verify auto-rename still works

**Merge Conflicts Sidebar:**

- Merge with conflicts -- "Merge Conflicts" section appears, commit disabled
- Resolve conflicts -- section disappears, commit re-enabled

**Cross-Worktree Merge Default:**

- Commit on branch X -- sibling worktrees show X in merge dropdown
- Current worktree excluded from its own default

**Per-Worktree Model:**

- Change model on worktree A -- new tabs on A inherit it
- Worktree B unaffected
- Model persists across app restart

**Tab Context Menus:**

- Right-click session tab -- Close, Close Others, Close to Right all work
- Right-click file tab -- same + Copy Relative Path, Copy Absolute Path
- Clipboard copies correct paths

#### 3. Cross-feature interaction tests

- Merge conflicts + cross-worktree default: committing after resolving conflicts still sets the merge default for siblings
- Per-worktree model + tab context: closing a tab via context menu doesn't lose the worktree's model preference
- Dog breed names + per-worktree model: new worktree with breed name gets the correct model from global default (no worktree model yet)
- Tab context "Close Others" + merge conflicts: closing tabs doesn't affect the conflict detection in the sidebar
- Multiple features on the same worktree: ensure all store interactions are compatible

#### 4. Verify backward compatibility

- Existing worktrees with city-name branches still auto-rename correctly
- Existing worktrees without `last_model_*` columns (all NULL) fall through to global default
- Existing test suites from prior phases still pass

### Key Files

- All files modified in Sessions 1-8

### Definition of Done

- [ ] `pnpm test` passes with zero failures
- [ ] `pnpm lint` passes with zero errors
- [ ] All 6 features work end-to-end
- [ ] No regressions in existing Phase 18 features
- [ ] Cross-feature interactions behave correctly
- [ ] Backward compatibility confirmed for breed names and worktree model columns
- [ ] All edge cases tested

### Testing Criteria

```typescript
// test/phase-19/session-9/integration-verification.test.ts
describe('Session 9: Phase 19 Integration', () => {
  test('BREED_NAMES replaces CITY_NAMES with no stale references', () => {
    // Verify BREED_NAMES is exported from breed-names.ts
    // Verify no import of 'city-names' or 'CITY_NAMES' in src/ (grep)
    // LEGACY_CITY_NAMES exists for backward compat
  })

  test('PriorityBadge renders icons, not text', () => {
    // Render TodoWriteToolView with all priorities
    // Verify no text content "high", "medium", "low" in priority positions
    // Verify SVG icons are present
  })

  test('ChangesView correctly separates conflicted files from others', () => {
    // Mock files with mix of statuses including 'C'
    // Verify 'C' files in conflicts section, others in their sections
    // Verify no file appears in multiple sections
  })

  test('commit() sets defaultMergeBranch and does not break existing flow', async () => {
    // Full commit flow mock
    // Verify refreshStatuses still called
    // Verify defaultMergeBranch set
    // Verify return value unchanged
  })

  test('worktree model columns default to NULL for existing rows', () => {
    // Verify migration SQL uses ADD COLUMN without NOT NULL
    // New columns default to NULL (no crash on existing data)
  })

  test('tab context menu actions work alongside existing close mechanisms', () => {
    // Verify X button close still works
    // Verify middle-click close still works
    // Verify Cmd+W still works
    // Verify context menu Close works
    // All use the same underlying closeSession/closeFile
  })

  test('getWorktreeStatus priority ordering still correct with all statuses', () => {
    // Verify answering > permission > planning > working > completed > plan_ready > unread > null
    // (from Phase 18 -- still intact)
  })
})
```
