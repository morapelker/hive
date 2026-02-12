# Hive -- Phase 19 Product Requirements Document

## Overview

Phase 19 delivers six improvements spanning naming theming, merge conflict safety, cross-worktree merge defaults, todo list visual polish, per-worktree model persistence, and tab context menus. It includes: replacing the world-cities naming list with dog breeds for worktree branch names; showing a merge conflicts section in the changes sidebar and disabling commit when conflicts exist; auto-defaulting the merge dropdown to the most recently committed branch across sibling worktrees in the same project; replacing text priority labels with Jira-style chevron icons in the todo list tool view; persisting the last-used model per worktree so new tabs inherit the worktree's model rather than a global default; and adding right-click context menus to session and file tabs with close/copy-path actions.

### Phase 19 Goals

1. Replace world cities with dog breeds for worktree branch naming
2. Show merge conflicts section in changes sidebar and disable commit button when conflicts exist
3. Default the merge dropdown to the most recently committed branch across sibling worktrees
4. Replace todo priority text labels with Jira-style chevron icons
5. Persist last-used model per worktree (not globally) so new tabs default to it
6. Add right-click context menus to session and file tabs

---

## Technical Additions

| Component                    | Technology                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| Dog breed names              | Replace `CITY_NAMES` array and all references in `city-names.ts`, rename file to `breed-names.ts` |
| Merge conflict UX            | Extend `ChangesView` with conflicts section, update `GitCommitForm` disable logic                 |
| Cross-worktree merge default | New `defaultMergeBranch` state in `useGitStore`, set on commit, read by sibling worktrees         |
| Todo chevron icons           | Replace `PriorityBadge` text with `ChevronUp`/`ChevronDown`/`ChevronsUp` icons from lucide-react  |
| Per-worktree model           | New `model_*` columns on `worktrees` table, update `useSessionStore.createSession` cascade        |
| Tab context menus            | New `TabContextMenu` component using shadcn `ContextMenu`, close/copy-path actions                |

---

## Features

### 1. Replace Cities with Dog Breeds

#### 1.1 Current State

Worktree branch names are generated from a list of ~130 world city names in `src/main/services/city-names.ts`. The `CITY_NAMES` array (lines 5-135) is used by:

- `getRandomCityName()` (line 140) -- picks a random city
- `selectUniqueCityName(existingNames)` (line 149) -- picks a unique name, falls back to `-v1` suffix
- `src/main/services/git-service.ts` (line 229-270) -- calls `selectUniqueCityName` during worktree creation
- `src/main/services/opencode-service.ts` (line 1096-1130) -- checks `CITY_NAMES.some(...)` to detect auto-named branches for auto-rename
- `src/main/ipc/worktree-handlers.ts` (line 211-221) -- checks city names during worktree sync to update display names

The names are used as git branch names directly, so they must be valid branch names (lowercase, no spaces, no special characters).

#### 1.2 New Design

```
Naming change: cities → dog breeds

  Before: tokyo, paris, chicago, mumbai, ...
  After:  golden-retriever, labrador, beagle, husky, ...

  All names must be:
  - Valid git branch names (lowercase, hyphens allowed)
  - Memorable and fun
  - No duplicates in the list
  - 100+ entries for variety

  File rename:
  city-names.ts → breed-names.ts

  Export rename:
  CITY_NAMES → BREED_NAMES
  getRandomCityName → getRandomBreedName
  selectUniqueCityName → selectUniqueBreedName

  All references must be updated across the codebase.
```

#### 1.3 Implementation

**A. Create `breed-names.ts`** (rename `city-names.ts`):

Replace the `CITY_NAMES` array with `BREED_NAMES` containing 120+ dog breeds, all formatted as valid git branch names:

```typescript
export const BREED_NAMES = [
  // Sporting Group
  'golden-retriever',
  'labrador',
  'cocker-spaniel',
  'english-setter',
  'irish-setter',
  'gordon-setter',
  'brittany',
  'vizsla',
  'weimaraner',
  'german-shorthaired-pointer',
  'english-springer-spaniel',
  'welsh-springer-spaniel',
  'nova-scotia-duck-tolling-retriever',
  'chesapeake-bay-retriever',
  'flat-coated-retriever',
  'boykin-spaniel',
  'clumber-spaniel',
  'field-spaniel',
  'irish-water-spaniel',
  'lagotto-romagnolo',

  // Hound Group
  'beagle',
  'basset-hound',
  'dachshund',
  'bloodhound',
  'greyhound',
  'whippet',
  'afghan-hound',
  'saluki',
  'borzoi',
  'rhodesian-ridgeback',
  'basenji',
  'irish-wolfhound',
  'scottish-deerhound',
  'coonhound',
  'foxhound',
  'harrier',
  'otterhound',
  'petit-basset-griffon-vendeen',
  'pharaoh-hound',
  'ibizan-hound',

  // Working Group
  'boxer',
  'rottweiler',
  'doberman',
  'great-dane',
  'mastiff',
  'bernese-mountain-dog',
  'newfoundland',
  'saint-bernard',
  'siberian-husky',
  'alaskan-malamute',
  'samoyed',
  'akita',
  'great-pyrenees',
  'portuguese-water-dog',
  'bullmastiff',
  'cane-corso',
  'dogue-de-bordeaux',
  'giant-schnauzer',
  'leonberger',
  'tibetan-mastiff',

  // Terrier Group
  'bull-terrier',
  'airedale',
  'scottish-terrier',
  'west-highland-terrier',
  'cairn-terrier',
  'yorkshire-terrier',
  'jack-russell',
  'fox-terrier',
  'border-terrier',
  'staffordshire-terrier',
  'miniature-schnauzer',
  'soft-coated-wheaten',
  'bedlington-terrier',
  'irish-terrier',
  'kerry-blue-terrier',
  'norwich-terrier',
  'norfolk-terrier',
  'welsh-terrier',
  'sealyham-terrier',
  'lakeland-terrier',

  // Toy Group
  'chihuahua',
  'pomeranian',
  'maltese',
  'shih-tzu',
  'pug',
  'cavalier-king-charles',
  'papillon',
  'havanese',
  'pekingese',
  'italian-greyhound',
  'chinese-crested',
  'japanese-chin',
  'toy-fox-terrier',
  'affenpinscher',
  'brussels-griffon',

  // Herding Group
  'border-collie',
  'german-shepherd',
  'australian-shepherd',
  'corgi',
  'shetland-sheepdog',
  'old-english-sheepdog',
  'belgian-malinois',
  'rough-collie',
  'australian-cattle-dog',
  'cardigan-welsh-corgi',
  'bouvier-des-flandres',
  'briard',
  'canaan-dog',
  'beauceron',
  'bergamasco',

  // Non-Sporting Group
  'poodle',
  'dalmatian',
  'bulldog',
  'french-bulldog',
  'boston-terrier',
  'shiba-inu',
  'chow-chow',
  'lhasa-apso',
  'bichon-frise',
  'keeshond',
  'schipperke',
  'tibetan-spaniel',
  'tibetan-terrier',
  'finnish-spitz',
  'xoloitzcuintli'
]
```

**B. Rename exports:**

```typescript
export function getRandomBreedName(): string {
  const index = Math.floor(Math.random() * BREED_NAMES.length)
  return BREED_NAMES[index]
}

export function selectUniqueBreedName(existingNames: Set<string>): string {
  const MAX_ATTEMPTS = 10
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const breedName = getRandomBreedName()
    if (!existingNames.has(breedName)) {
      return breedName
    }
  }
  const baseName = getRandomBreedName()
  let version = 1
  let candidateName = `${baseName}-v${version}`
  while (existingNames.has(candidateName)) {
    version++
    candidateName = `${baseName}-v${version}`
  }
  return candidateName
}
```

**C. Update all references:**

- `src/main/services/index.ts` -- update re-export from `breed-names`
- `src/main/services/git-service.ts` -- import and call `selectUniqueBreedName`
- `src/main/services/opencode-service.ts` -- import `BREED_NAMES`, update `CITY_NAMES.some(...)` to `BREED_NAMES.some(...)`
- `src/main/ipc/worktree-handlers.ts` -- import `BREED_NAMES`, update city name detection

**D. Backward compatibility:** The auto-rename check in `opencode-service.ts` should detect BOTH old city names and new breed names. Keep `CITY_NAMES` as a deprecated export (or inline the old array) in the detection logic so existing worktrees with city-name branches still get auto-renamed correctly:

```typescript
// In opencode-service.ts auto-rename logic:
const isAutoName =
  BREED_NAMES.some((b) => branchName === b || branchName.startsWith(`${b}-v`)) ||
  LEGACY_CITY_NAMES.some((c) => branchName === c || branchName.startsWith(`${c}-v`))
```

#### 1.4 Files to Modify

| File                                                        | Change                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/main/services/city-names.ts`                           | Rename to `breed-names.ts`, replace array + exports                                    |
| `src/main/services/index.ts`                                | Update re-export path                                                                  |
| `src/main/services/git-service.ts`                          | Import `selectUniqueBreedName` instead of `selectUniqueCityName`                       |
| `src/main/services/opencode-service.ts`                     | Import `BREED_NAMES`, update auto-rename detection, add backward compat for city names |
| `src/main/ipc/worktree-handlers.ts`                         | Import `BREED_NAMES`, update display name sync logic                                   |
| `test/phase-11/session-4/auto-rename-branch.test.ts`        | Update imports and test data                                                           |
| `test/phase-11/session-3/branch-rename-infra.test.ts`       | Update imports                                                                         |
| `test/phase-11/session-12/integration-verification.test.ts` | Update imports and test data                                                           |
| `test/session-5/worktrees.test.tsx`                         | Update test city name references                                                       |

---

### 2. Merge Conflicts in Changes Sidebar

#### 2.1 Current State

The `ChangesView` component (`src/renderer/src/components/file-tree/ChangesView.tsx`, lines 88-110) groups files into `stagedFiles`, `modifiedFiles`, and `untrackedFiles`. Files with status `'C'` (conflicted) are **silently dropped** -- they don't match any of the three filter conditions (`staged`, `'?'`, `'M'`/`'D'`/`'A'`).

The `GitStatusPanel` component (the older alternative) **does** handle conflicts -- it has a dedicated "Conflicts" section (lines 481-495) and an orange "CONFLICTS" button. But `ChangesView` is the one rendered in the right sidebar via `FileSidebar`.

The commit button in `GitCommitForm.tsx` (line 71) is enabled when `hasStaged && hasSummary && !isCommitting`. There is no conflict check.

The `useGitStore` already tracks conflicts via `conflictsByWorktree: Record<string, boolean>` (line 34) and updates this on status load (line 117-128). The header already has a "Fix conflicts" button (line 83-86 of `Header.tsx`).

#### 2.2 New Design

```
Merge conflicts in ChangesView:

  When conflicted files exist:
  ┌──────────────────────────────────────────────────┐
  │ Changes                                           │
  │                                                   │
  │ ▼ Merge Conflicts (2)           ← NEW SECTION     │
  │   ⚠ src/main/index.ts     C                       │
  │   ⚠ src/renderer/app.tsx   C                       │
  │                                                   │
  │ ▼ Staged Changes (3)                               │
  │   ✓ file1.ts               M                       │
  │   ✓ file2.ts               A                       │
  │   ✓ file3.ts               D                       │
  │                                                   │
  │ ▼ Changes (1)                                      │
  │   ...                                              │
  │                                                   │
  │ ┌──────────────────────────────────────────────┐   │
  │ │ Summary: [___________________________]       │   │
  │ │                                              │   │
  │ │ [Commit (3 files)]  ← DISABLED               │   │
  │ │  "Resolve merge conflicts before committing" │   │
  │ └──────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────┘

  Changes:
  1. Add conflictedFiles to the grouping useMemo in ChangesView
  2. Render a "Merge Conflicts" section as the FIRST section
     with AlertTriangle icon, red styling
  3. Pass hasConflicts to GitCommitForm
  4. Disable commit button when conflicts exist
  5. Show helper text explaining why commit is disabled
```

#### 2.3 Implementation

**A. Update file grouping in `ChangesView.tsx`** (lines 88-110) to capture conflicted files:

```typescript
const { stagedFiles, modifiedFiles, untrackedFiles, conflictedFiles, allFiles } = useMemo(() => {
  const files = worktreePath ? fileStatusesByWorktree.get(worktreePath) || [] : []
  const staged: GitFileStatus[] = []
  const modified: GitFileStatus[] = []
  const untracked: GitFileStatus[] = []
  const conflicted: GitFileStatus[] = []

  for (const file of files) {
    if (file.status === 'C') {
      conflicted.push(file)
    } else if (file.staged) {
      staged.push(file)
    } else if (file.status === '?') {
      untracked.push(file)
    } else if (file.status === 'M' || file.status === 'D' || file.status === 'A') {
      modified.push(file)
    }
  }

  return {
    stagedFiles: staged,
    modifiedFiles: modified,
    untrackedFiles: untracked,
    conflictedFiles: conflicted,
    allFiles: files
  }
}, [worktreePath, fileStatusesByWorktree])
```

**B. Render "Merge Conflicts" section** as the first collapsible section in ChangesView, before "Staged Changes":

```tsx
{
  conflictedFiles.length > 0 && (
    <CollapsibleSection
      title={`Merge Conflicts (${conflictedFiles.length})`}
      icon={<AlertTriangle className="h-3.5 w-3.5 text-red-500" />}
      defaultOpen
      className="border-red-500/20"
    >
      {conflictedFiles.map((file) => (
        <FileListItem key={file.path} file={file} onClick={() => handleViewDiff(file)} />
      ))}
    </CollapsibleSection>
  )
}
```

**C. Update `GitCommitForm.tsx`** to accept and check for conflicts:

```typescript
interface GitCommitFormProps {
  worktreePath: string
  hasConflicts?: boolean
}

// Update canCommit:
const canCommit = hasStaged && hasSummary && !isCommitting && !hasConflicts
```

Add a helper message below the commit button when conflicts exist:

```tsx
{
  hasConflicts && (
    <p className="text-xs text-red-400 mt-1">Resolve merge conflicts before committing</p>
  )
}
```

**D. Pass `hasConflicts` from `ChangesView` to `GitCommitForm`:**

```tsx
{
  hasStaged && (
    <GitCommitForm worktreePath={worktreePath} hasConflicts={conflictedFiles.length > 0} />
  )
}
```

#### 2.4 Files to Modify

| File                                                    | Change                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/renderer/src/components/file-tree/ChangesView.tsx` | Add `conflictedFiles` to grouping, render "Merge Conflicts" section |
| `src/renderer/src/components/git/GitCommitForm.tsx`     | Accept `hasConflicts` prop, disable commit, show helper text        |

---

### 3. Default Merge Dropdown to Committed Branch

#### 3.1 Current State

The merge branch dropdown in `GitPushPull.tsx` (line 46) uses local component state: `useState('')`. This means the merge target resets to empty every time the component remounts. There is no cross-worktree awareness -- committing on branch `feature-x` does not influence what other worktrees see in their merge dropdown.

Worktrees within a project are siblings: they share the same git repository and are tracked in `useWorktreeStore.worktreesByProject: Map<string, Worktree[]>` (line 26). Each worktree has a `branch_name` and `path`.

After a commit, `useGitStore.commit()` (line 342-357) calls `refreshStatuses()` but does not update any cross-worktree state.

#### 3.2 New Design

```
Cross-worktree merge default:

  Scenario:
  - Project "myapp" has worktrees:
    - main (default)
    - feature-auth (branch: feature-auth)
    - feature-ui (branch: feature-ui)

  User commits on feature-auth:
  ┌──────────────────────────────────────────────────┐
  │ After commit on feature-auth:                     │
  │                                                   │
  │ On "main" worktree:                               │
  │   Merge dropdown defaults to → "feature-auth"     │
  │                                                   │
  │ On "feature-ui" worktree:                         │
  │   Merge dropdown defaults to → "feature-auth"     │
  │                                                   │
  │ On "feature-auth" worktree:                       │
  │   Merge dropdown unchanged (own branch excluded)  │
  └──────────────────────────────────────────────────┘

  Storage:
  - useGitStore gets a new field:
    defaultMergeBranch: Map<string, string>
    (keyed by projectId → branch name of last commit)

  - Set when commit() succeeds, using the branch name
    from the worktree that committed

  - Read by GitPushPull to initialize mergeBranch state
    (only if the default branch isn't the current branch)

  - In-memory only (no persistence needed -- resets on
    app restart which is fine)
```

#### 3.3 Implementation

**A. Add `defaultMergeBranch` to `useGitStore`:**

```typescript
interface GitStoreState {
  // ... existing fields
  defaultMergeBranch: Map<string, string> // projectId → branch name

  setDefaultMergeBranch: (projectId: string, branchName: string) => void
}
```

**B. Set default merge branch after successful commit.** Update `commit()` in `useGitStore` to set the merge default:

```typescript
commit: async (worktreePath: string, message: string) => {
  set({ isCommitting: true, error: null })
  try {
    const result = await window.gitOps.commit(worktreePath, message)
    if (result.success) {
      await get().refreshStatuses(worktreePath)

      // Set this branch as the default merge target for sibling worktrees
      const branchInfo = get().branchInfoByWorktree.get(worktreePath)
      if (branchInfo?.name) {
        // Find the project ID for this worktree path
        const worktreeStore = useWorktreeStore.getState()
        const worktree = worktreeStore.worktrees.find((w) => w.path === worktreePath)
        if (worktree?.project_id) {
          get().setDefaultMergeBranch(worktree.project_id, branchInfo.name)
        }
      }
    }
    set({ isCommitting: false })
    return result
  } catch (error) {
    // ... existing error handling
  }
}
```

**C. Read default merge branch in `GitPushPull.tsx`:**

```typescript
// Get the project-wide default merge branch
const selectedWorktree = useWorktreeStore((state) =>
  state.worktrees.find((w) => w.path === worktreePath)
)
const defaultMergeBranch = useGitStore((state) =>
  selectedWorktree?.project_id
    ? state.defaultMergeBranch.get(selectedWorktree.project_id)
    : undefined
)
const branchInfo = useGitStore((state) => state.branchInfoByWorktree.get(worktreePath))

// Initialize merge branch from default (if it's not the current branch)
useEffect(() => {
  if (defaultMergeBranch && defaultMergeBranch !== branchInfo?.name && !mergeBranch) {
    setMergeBranch(defaultMergeBranch)
  }
}, [defaultMergeBranch, branchInfo?.name])
```

#### 3.4 Files to Modify

| File                                              | Change                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/renderer/src/stores/useGitStore.ts`          | Add `defaultMergeBranch` map, `setDefaultMergeBranch` action, set on commit |
| `src/renderer/src/components/git/GitPushPull.tsx` | Read default merge branch, initialize dropdown state                        |

---

### 4. Todo List Chevron Priority Icons

#### 4.1 Current State

The `PriorityBadge` component in `TodoWriteToolView.tsx` (lines 31-43) renders priority as a **text label** in a colored pill:

```tsx
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
```

This shows the word "high", "medium", or "low" as text. It takes up horizontal space and is less scannable than icons.

#### 4.2 New Design

```
Jira-style chevron priority icons:

  Low:    ↓  (single down chevron, blue)
  Medium: ↑  (single up chevron, yellow/amber)
  High:   ⇈  (double up chevron, red)

  Icon mapping:
  - Low:    ChevronDown from lucide-react, text-blue-500
  - Medium: ChevronUp from lucide-react, text-amber-500
  - High:   ChevronsUp from lucide-react, text-red-500

  The icons replace the text entirely. No background pill
  needed -- just the icon with color. The icon is placed
  in the same position where the text badge currently is
  (right side of each todo item).

  Visual:
  ┌──────────────────────────────────────────────────┐
  │ ○ Research existing metrics           ↓  (blue)   │
  │ ◉ Implement core tracking            ↑  (amber)  │
  │ ○ Fix critical bug                   ⇈  (red)    │
  │ ✓ Write tests                        ↓  (blue)   │
  └──────────────────────────────────────────────────┘
```

#### 4.3 Implementation

**A. Replace `PriorityBadge` content** in `TodoWriteToolView.tsx`:

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

No other files need changes -- the `PriorityBadge` is only rendered within `TodoWriteToolView.tsx` (line 111).

#### 4.4 Files to Modify

| File                                                               | Change                                          |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| `src/renderer/src/components/sessions/tools/TodoWriteToolView.tsx` | Replace `PriorityBadge` text with chevron icons |

---

### 5. Persist Last Model per Worktree

#### 5.1 Current State

Per-session model was implemented in Phase 17. New sessions inherit their model from the **last session in the same worktree** (`useSessionStore.ts`, lines 165-176), falling back to the global `useSettingsStore.selectedModel`.

However, this is stored per-session. The request is to persist the last-used model **per worktree** so that:

- When the user manually changes the model on any tab in a worktree, that becomes the worktree's default
- New tabs in that worktree default to the worktree's model
- This persists across app restarts (database-backed)

Currently, `useSessionStore.createSession` (line 165-176) looks at the last session's model columns. This mostly works, but:

- If the user changes models on an older session, the "last session" heuristic may not pick it up
- The intent is clearer with an explicit per-worktree default

The `worktrees` table does NOT have model columns. The `sessions` table has `model_provider_id`, `model_id`, `model_variant` (added in Phase 17 migration v11).

#### 5.2 New Design

```
Per-worktree model persistence:

  ┌─────────────────────────────────────────────────────┐
  │ worktrees table                                      │
  │                                                      │
  │  last_model_provider_id TEXT                         │
  │  last_model_id TEXT                                  │
  │  last_model_variant TEXT                             │
  └─────────────────────────────────────────────────────┘

  When user manually changes model on any session tab:
  1. Update the session's model (existing behavior)
  2. Also update the worktree's last_model_* columns (NEW)
  3. Persist to database

  When creating a new session:
  1. Check worktree's last_model_* columns
  2. If set → use as default for the new session
  3. If not → fall back to global selectedModel
  4. Skip the "find last session's model" heuristic

  Data flow:
  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
  │ ModelSelector │───▶│ useSessionStore  │───▶│ sessions DB  │
  │  (per tab)   │    │ .setSessionModel │    │ model columns│
  │              │    │                  │    │              │
  │              │    │ Also calls:      │    │              │
  │              │    │ worktreeOps      │───▶│ worktrees DB │
  │              │    │ .updateModel()   │    │ last_model_* │
  └──────────────┘    └──────────────────┘    └──────────────┘
```

#### 5.3 Implementation

**A. Database migration** -- add model columns to worktrees table:

```sql
ALTER TABLE worktrees ADD COLUMN last_model_provider_id TEXT;
ALTER TABLE worktrees ADD COLUMN last_model_id TEXT;
ALTER TABLE worktrees ADD COLUMN last_model_variant TEXT;
```

Bump `CURRENT_SCHEMA_VERSION` and add to `MIGRATIONS` array.

**B. Add `updateWorktreeModel` IPC endpoint:**

```typescript
ipcMain.handle(
  'db:worktree:updateModel',
  async (_event, { worktreeId, modelProviderId, modelId, modelVariant }) => {
    db.prepare(
      `
    UPDATE worktrees
    SET last_model_provider_id = ?, last_model_id = ?, last_model_variant = ?
    WHERE id = ?
  `
    ).run(modelProviderId, modelId, modelVariant ?? null, worktreeId)
    return { success: true }
  }
)
```

**C. Expose in preload and type declarations.**

**D. Update `setSessionModel` in `useSessionStore.ts`** to also persist to the worktree:

```typescript
setSessionModel: async (sessionId: string, model: SelectedModel) => {
  // ... existing session update logic ...

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
      // Update in-memory worktree record
      useWorktreeStore.getState().updateWorktreeModel(session.worktree_id, model)
    } catch {
      /* non-critical */
    }
  }
}
```

**E. Update `createSession` default cascade** to check worktree model first:

```typescript
createSession: async (worktreeId: string, projectId: string) => {
  // Priority 1: worktree's last-used model
  const worktree = useWorktreeStore.getState().worktrees.find((w) => w.id === worktreeId)
  const worktreeModel = worktree?.last_model_id
    ? {
        model_provider_id: worktree.last_model_provider_id,
        model_id: worktree.last_model_id,
        model_variant: worktree.last_model_variant
      }
    : null

  // Priority 2: global default
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

  const session = await window.db.session.create({
    worktree_id: worktreeId,
    project_id: projectId,
    name: `New session - ${new Date().toISOString()}`,
    ...(defaultModel && {
      model_provider_id: defaultModel.model_provider_id,
      model_id: defaultModel.model_id,
      model_variant: defaultModel.model_variant
    })
  })
  // ...
}
```

**F. Add model fields to Worktree interface** in `src/preload/index.d.ts` and `useWorktreeStore.ts`:

```typescript
interface Worktree {
  // ... existing fields
  last_model_provider_id: string | null
  last_model_id: string | null
  last_model_variant: string | null
}
```

#### 5.4 Files to Modify

| File                                          | Change                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/main/db/schema.ts`                       | Add migration: `last_model_*` columns on worktrees                                      |
| `src/main/db/database.ts`                     | Add `updateWorktreeModel` method                                                        |
| `src/main/db/types.ts`                        | Add model fields to `Worktree` and `WorktreeUpdate` types                               |
| `src/main/ipc/database-handlers.ts`           | Add `db:worktree:updateModel` IPC handler                                               |
| `src/preload/index.ts`                        | Expose `updateModel` in `db.worktree` namespace                                         |
| `src/preload/index.d.ts`                      | Add model fields to `Worktree` interface, type for `updateModel`                        |
| `src/renderer/src/stores/useWorktreeStore.ts` | Add `updateWorktreeModel` action, update Worktree interface                             |
| `src/renderer/src/stores/useSessionStore.ts`  | Update `setSessionModel` to persist to worktree, update `createSession` default cascade |

---

### 6. Right-Click Context Menus on Tabs

#### 6.1 Current State

`SessionTabs.tsx` (line 273) renders three tab types: `SessionTab` (line 38-174), `FileTab` (line 184-219), and `DiffTabItem` (line 229-271). None of them have a context menu. The only close mechanism is the X button and middle-click.

There are no "Close Others", "Close Others to the Right" actions anywhere in the codebase. The `useSessionStore` has `closeSession(sessionId)` (lines 234-300) for individual close. The `useFileViewerStore` has `closeFile(path)` (line 59-73) and `closeAllFiles()` (line 79-81).

The app already uses shadcn/ui `ContextMenu` in several places (WorktreeItem, SpacesTabBar, FileTreeNode, etc.), so the pattern is well-established.

#### 6.2 New Design

```
Tab context menus:

  Session tab (OpenCode) right-click:
  ┌──────────────────────────────┐
  │ Close                 ⌘W     │
  │ Close Others                 │
  │ Close Others to the Right    │
  └──────────────────────────────┘

  File tab right-click:
  ┌──────────────────────────────┐
  │ Close                 ⌘W     │
  │ Close Others                 │
  │ Close Others to the Right    │
  │ ─────────────────────────────│
  │ Copy Relative Path           │
  │ Copy Absolute Path           │
  └──────────────────────────────┘

  Diff tab right-click:
  ┌──────────────────────────────┐
  │ Close                 ⌘W     │
  │ Close Others                 │
  │ Close Others to the Right    │
  │ ─────────────────────────────│
  │ Copy Relative Path           │
  │ Copy Absolute Path           │
  └──────────────────────────────┘

  "Close Others" closes all tabs of the same type
  except the right-clicked one.

  "Close Others to the Right" closes all tabs of the
  same type that appear after the right-clicked tab
  in the tab order.

  Copy paths use the file path from the tab data.
  For session tabs, there is no file path, so no
  copy path options.
```

#### 6.3 Implementation

**A. Add bulk close actions to `useSessionStore`:**

```typescript
closeOtherSessions: (worktreeId: string, keepSessionId: string) => {
  const tabOrder = get().tabOrderByWorktree.get(worktreeId) || []
  for (const sessionId of tabOrder) {
    if (sessionId !== keepSessionId) {
      get().closeSession(sessionId)
    }
  }
}

closeSessionsToRight: (worktreeId: string, fromSessionId: string) => {
  const tabOrder = get().tabOrderByWorktree.get(worktreeId) || []
  const index = tabOrder.indexOf(fromSessionId)
  if (index === -1) return
  const toClose = tabOrder.slice(index + 1)
  for (const sessionId of toClose) {
    get().closeSession(sessionId)
  }
}
```

**B. Add bulk close actions to `useFileViewerStore`:**

```typescript
closeOtherFiles: (keepKey: string) => {
  set((state) => {
    const newMap = new Map()
    const kept = state.openFiles.get(keepKey)
    if (kept) newMap.set(keepKey, kept)
    return {
      openFiles: newMap,
      activeFilePath: kept ? keepKey : null,
      activeDiff: null
    }
  })
}

closeFilesToRight: (fromKey: string) => {
  set((state) => {
    const keys = [...state.openFiles.keys()]
    const index = keys.indexOf(fromKey)
    if (index === -1) return state
    const newMap = new Map()
    for (let i = 0; i <= index; i++) {
      const entry = state.openFiles.get(keys[i])
      if (entry) newMap.set(keys[i], entry)
    }
    return { openFiles: newMap }
  })
}
```

**C. Wrap tab components with `ContextMenu`** in `SessionTabs.tsx`:

For session tabs:

```tsx
<ContextMenu>
  <ContextMenuTrigger asChild>
    <div className="..."> {/* existing tab content */} </div>
  </ContextMenuTrigger>
  <ContextMenuContent>
    <ContextMenuItem onClick={() => closeSession(sessionId)}>
      Close
      <ContextMenuShortcut>⌘W</ContextMenuShortcut>
    </ContextMenuItem>
    <ContextMenuItem onClick={() => closeOtherSessions(worktreeId, sessionId)}>
      Close Others
    </ContextMenuItem>
    <ContextMenuItem onClick={() => closeSessionsToRight(worktreeId, sessionId)}>
      Close Others to the Right
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

For file/diff tabs, add the separator and copy path items:

```tsx
<ContextMenuSeparator />
<ContextMenuItem onClick={() => copyToClipboard(relativePath)}>
  Copy Relative Path
</ContextMenuItem>
<ContextMenuItem onClick={() => copyToClipboard(absolutePath)}>
  Copy Absolute Path
</ContextMenuItem>
```

**D. Clipboard copy utility:**

```typescript
const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text)
  toast.success('Copied to clipboard')
}
```

For relative path: strip the worktree path prefix from the absolute file path.
For absolute path: use the full file path directly.

#### 6.4 Files to Modify

| File                                                   | Change                                                   |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `src/renderer/src/stores/useSessionStore.ts`           | Add `closeOtherSessions`, `closeSessionsToRight` actions |
| `src/renderer/src/stores/useFileViewerStore.ts`        | Add `closeOtherFiles`, `closeFilesToRight` actions       |
| `src/renderer/src/components/sessions/SessionTabs.tsx` | Wrap tabs with `ContextMenu`, add close/copy-path items  |

---

## Summary

| #   | Feature                        | Complexity | Files                          |
| --- | ------------------------------ | ---------- | ------------------------------ |
| 1   | Dog breed names                | Low        | 9 files (rename + update refs) |
| 2   | Merge conflicts in sidebar     | Medium     | 2 files                        |
| 3   | Cross-worktree merge default   | Medium     | 2 files                        |
| 4   | Todo chevron icons             | Low        | 1 file                         |
| 5   | Per-worktree model persistence | High       | 8 files (DB + IPC + stores)    |
| 6   | Tab context menus              | Medium     | 3 files                        |
