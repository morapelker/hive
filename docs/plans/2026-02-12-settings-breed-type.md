# Settings: Remove Git Section + Add Breed Type Setting

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the Git settings section and add a "Branch Naming" setting to General that lets users choose between dog breeds (default) and cat breeds for auto-generated worktree branch names. Persist to SQLite.

**Architecture:** Add a `breedType` field (`'dogs' | 'cats'`) to `AppSettings` in the Zustand store. The renderer sends this preference through the existing `app_settings` JSON blob in SQLite. On the main process side, `breed-names.ts` gains a `CAT_BREEDS` array and `selectUniqueBreedName` accepts the breed type to pick the right list. The `worktree:create` IPC handler reads the setting from the database before calling `createWorktree`.

**Tech Stack:** React, Zustand, TypeScript, SQLite (better-sqlite3), Electron IPC

---

## Task 1: Add cat breeds list to `breed-names.ts`

**Files:**

- Modify: `src/main/services/breed-names.ts`

**Step 1: Add the `CAT_BREEDS` array**

After the existing `BREED_NAMES` array (line 76), add:

```ts
/**
 * Cat breed names for worktree naming convention
 * Uses well-known cat breeds for memorable, unique names
 * All names are valid git branch names (lowercase, hyphens only)
 */
export const CAT_BREEDS = [
  'persian',
  'maine-coon',
  'ragdoll',
  'british-shorthair',
  'siamese',
  'abyssinian',
  'bengal',
  'birman',
  'oriental-shorthair',
  'sphynx',
  'devon-rex',
  'scottish-fold',
  'burmese',
  'russian-blue',
  'norwegian-forest',
  'cornish-rex',
  'somali',
  'tonkinese',
  'singapura',
  'ragamuffin',
  'turkish-angora',
  'american-shorthair',
  'balinese',
  'chartreux',
  'himalayan',
  'manx',
  'ocicat',
  'savannah',
  'siberian',
  'turkish-van',
  'bombay',
  'egyptian-mau',
  'havana-brown',
  'japanese-bobtail',
  'korat',
  'laperm',
  'nebelung',
  'pixie-bob',
  'selkirk-rex',
  'snowshoe',
  'american-curl',
  'burmilla',
  'exotic-shorthair',
  'munchkin',
  'peterbald',
  'toyger',
  'chausie',
  'lykoi',
  'khao-manee',
  'sokoke'
]
```

**Step 2: Add a `BreedType` type and refactor selection functions**

```ts
export type BreedType = 'dogs' | 'cats'

function getBreedList(breedType: BreedType): string[] {
  return breedType === 'cats' ? CAT_BREEDS : BREED_NAMES
}

export function getRandomBreedName(breedType: BreedType = 'dogs'): string {
  const list = getBreedList(breedType)
  const index = Math.floor(Math.random() * list.length)
  return list[index]
}

export function selectUniqueBreedName(
  existingNames: Set<string>,
  breedType: BreedType = 'dogs'
): string {
  const MAX_ATTEMPTS = 10

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const breedName = getRandomBreedName(breedType)
    if (!existingNames.has(breedName)) {
      return breedName
    }
  }

  const baseName = getRandomBreedName(breedType)
  let version = 1
  let candidateName = `${baseName}-v${version}`

  while (existingNames.has(candidateName)) {
    version++
    candidateName = `${baseName}-v${version}`
  }

  return candidateName
}
```

**Step 3: Update auto-rename detection to include cat breeds**

In `worktree-handlers.ts` (line 229) and `opencode-service.ts` (line 1103), the `isAutoName` check uses `BREED_NAMES.some(...)`. These must also check `CAT_BREEDS`:

In both files, change the `isAutoName` logic to:

```ts
import { BREED_NAMES, CAT_BREEDS, LEGACY_CITY_NAMES } from '../services/breed-names'

// Then in the isAutoName check:
const isAutoName =
  [...BREED_NAMES, ...CAT_BREEDS].some(
    (b) => b === name.toLowerCase() || name.toLowerCase().startsWith(`${b}-v`)
  ) ||
  LEGACY_CITY_NAMES.some((c) => c === name.toLowerCase() || name.toLowerCase().startsWith(`${c}-v`))
```

Alternatively, export a helper `ALL_BREED_NAMES` from `breed-names.ts`:

```ts
export const ALL_BREED_NAMES = [...BREED_NAMES, ...CAT_BREEDS]
```

And use `ALL_BREED_NAMES` in both detection sites. This is cleaner and avoids duplication.

**Step 4: Run lint**

```bash
pnpm lint
```

**Step 5: Commit**

```bash
git add src/main/services/breed-names.ts src/main/ipc/worktree-handlers.ts src/main/services/opencode-service.ts
git commit -m "feat: add cat breeds list and breed type parameter to naming functions"
```

---

## Task 2: Remove Git section from settings UI

**Files:**

- Delete: `src/renderer/src/components/settings/SettingsGit.tsx`
- Modify: `src/renderer/src/components/settings/SettingsModal.tsx`

**Step 1: Remove Git from SECTIONS array and content area**

In `SettingsModal.tsx`:

1. Remove the import: `import { SettingsGit } from './SettingsGit'` (line 9)
2. Remove the `GitBranch` icon from the lucide import (line 2)
3. Remove `{ id: 'git', label: 'Git', icon: GitBranch }` from `SECTIONS` (line 18)
4. Remove `{activeSection === 'git' && <SettingsGit />}` (line 74)

**Step 2: Delete `SettingsGit.tsx`**

```bash
rm src/renderer/src/components/settings/SettingsGit.tsx
```

**Step 3: Run lint**

```bash
pnpm lint
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: remove git settings section from settings modal"
```

---

## Task 3: Remove `commitTemplate` and `autoFetchInterval` from settings store

**Files:**

- Modify: `src/renderer/src/stores/useSettingsStore.ts`

These two fields are only consumed by the now-deleted `SettingsGit.tsx`. No other code references them.

**Step 1: Remove from `AppSettings` interface (lines 33-35)**

Delete:

```ts
// Git
commitTemplate: string
autoFetchInterval: number // 0 = disabled, otherwise minutes
```

**Step 2: Remove from `DEFAULT_SETTINGS` (lines 60-61)**

Delete:

```ts
  commitTemplate: '',
  autoFetchInterval: 0,
```

**Step 3: Remove from `extractSettings` (lines 121-122)**

Delete:

```ts
    commitTemplate: state.commitTemplate,
    autoFetchInterval: state.autoFetchInterval,
```

**Step 4: Remove from `partialize` (lines 222-223)**

Delete:

```ts
        commitTemplate: state.commitTemplate,
        autoFetchInterval: state.autoFetchInterval,
```

**Step 5: Run lint**

```bash
pnpm lint
```

**Step 6: Commit**

```bash
git add src/renderer/src/stores/useSettingsStore.ts
git commit -m "chore: remove unused commitTemplate and autoFetchInterval settings"
```

---

## Task 4: Add `breedType` setting to the store

**Files:**

- Modify: `src/renderer/src/stores/useSettingsStore.ts`

**Step 1: Add to `AppSettings` interface**

Add after the `autoStartSession` field in the `// General` group:

```ts
breedType: 'dogs' | 'cats'
```

**Step 2: Add to `DEFAULT_SETTINGS`**

```ts
  breedType: 'dogs',
```

**Step 3: Add to `extractSettings`**

```ts
    breedType: state.breedType,
```

**Step 4: Add to `partialize`**

```ts
        breedType: state.breedType,
```

**Step 5: Run lint**

```bash
pnpm lint
```

**Step 6: Commit**

```bash
git add src/renderer/src/stores/useSettingsStore.ts
git commit -m "feat: add breedType setting to app settings store"
```

---

## Task 5: Add breed type selector to `SettingsGeneral.tsx`

**Files:**

- Modify: `src/renderer/src/components/settings/SettingsGeneral.tsx`

**Step 1: Add the breed type UI**

Between the "Auto-start session" toggle and the "Reset to defaults" section, add a new setting block:

```tsx
{
  /* Branch naming */
}
;<div className="space-y-2">
  <label className="text-sm font-medium">Branch Naming</label>
  <p className="text-xs text-muted-foreground">
    Choose the naming theme for auto-generated worktree branches
  </p>
  <div className="flex gap-2">
    <button
      onClick={() => updateSetting('breedType', 'dogs')}
      className={cn(
        'px-3 py-1.5 rounded-md text-sm border transition-colors',
        breedType === 'dogs'
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
      )}
      data-testid="breed-type-dogs"
    >
      Dogs
    </button>
    <button
      onClick={() => updateSetting('breedType', 'cats')}
      className={cn(
        'px-3 py-1.5 rounded-md text-sm border transition-colors',
        breedType === 'cats'
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
      )}
      data-testid="breed-type-cats"
    >
      Cats
    </button>
  </div>
</div>
```

**Step 2: Destructure `breedType` from the store**

Update the destructure at the top of the component:

```ts
const { autoStartSession, breedType, updateSetting, resetToDefaults } = useSettingsStore()
```

**Step 3: Run lint**

```bash
pnpm lint
```

**Step 4: Commit**

```bash
git add src/renderer/src/components/settings/SettingsGeneral.tsx
git commit -m "feat: add breed type toggle to general settings"
```

---

## Task 6: Wire the main process to read breed type from SQLite

**Files:**

- Modify: `src/main/ipc/worktree-handlers.ts`
- Modify: `src/main/services/git-service.ts`

The key challenge: the main process needs the breed type preference when creating a worktree. Currently `gitService.createWorktree(projectName)` doesn't receive it. Two options:

**Option A (Recommended): Read from DB in the handler, pass to git service.**

The `worktree:create` handler already has access to `getDatabase()`. Read the setting there and pass it through.

**Step 1: Modify `CreateWorktreeParams` in `worktree-handlers.ts`**

No change needed to the interface -- the renderer already sends `projectId`, `projectPath`, `projectName`. The handler will read the breed type from DB itself.

In the `worktree:create` handler (line 59-61), before calling `gitService.createWorktree`:

```ts
// Read breed type preference from settings
let breedType: BreedType = 'dogs'
try {
  const settingsJson = getDatabase().getSetting('app_settings')
  if (settingsJson) {
    const settings = JSON.parse(settingsJson)
    if (settings.breedType === 'cats') {
      breedType = 'cats'
    }
  }
} catch {
  // Fall back to dogs
}
const result = await gitService.createWorktree(params.projectName, breedType)
```

Add import:

```ts
import { type BreedType } from '../services/breed-names'
```

**Step 2: Update `createWorktree` in `git-service.ts`**

Change signature from:

```ts
async createWorktree(projectName: string): Promise<CreateWorktreeResult>
```

to:

```ts
async createWorktree(projectName: string, breedType: BreedType = 'dogs'): Promise<CreateWorktreeResult>
```

Update the call on line 253:

```ts
const breedName = selectUniqueBreedName(existingNames, breedType)
```

Add import:

```ts
import { selectUniqueBreedName, type BreedType } from './breed-names'
```

(The existing import `import { selectUniqueBreedName } from './breed-names'` just needs `type BreedType` added.)

**Step 3: Run lint**

```bash
pnpm lint
```

**Step 4: Commit**

```bash
git add src/main/ipc/worktree-handlers.ts src/main/services/git-service.ts
git commit -m "feat: read breed type from settings when creating worktrees"
```

---

## Task 7: Verify and test end-to-end

**Step 1: Run the full test suite**

```bash
pnpm test
```

Fix any failures.

**Step 2: Run lint**

```bash
pnpm lint
```

**Step 3: Run build**

```bash
pnpm build
```

**Step 4: Manual smoke test checklist**

- [ ] Open Settings modal -- Git section is gone from left nav
- [ ] General section shows Dogs/Cats toggle, Dogs is selected by default
- [ ] Click Cats, close and reopen Settings -- Cats is still selected (localStorage)
- [ ] Restart app -- Cats is still selected (SQLite)
- [ ] Create a new worktree with Cats selected -- branch name is a cat breed
- [ ] Create a new worktree with Dogs selected -- branch name is a dog breed
- [ ] Reset All to Defaults -- breed type reverts to Dogs

**Step 5: Final commit if any fixes were needed**

---

## Summary of all files touched

| File                                                       | Action                                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/main/services/breed-names.ts`                         | Add `CAT_BREEDS`, `ALL_BREED_NAMES`, `BreedType` type, update function signatures |
| `src/main/services/git-service.ts`                         | Add `breedType` param to `createWorktree`                                         |
| `src/main/ipc/worktree-handlers.ts`                        | Read breed type from DB, pass to git service, update `isAutoName` detection       |
| `src/main/services/opencode-service.ts`                    | Update `isAutoName` detection to include cat breeds                               |
| `src/renderer/src/stores/useSettingsStore.ts`              | Remove `commitTemplate`/`autoFetchInterval`, add `breedType`                      |
| `src/renderer/src/components/settings/SettingsGeneral.tsx` | Add breed type toggle UI                                                          |
| `src/renderer/src/components/settings/SettingsModal.tsx`   | Remove Git section + import                                                       |
| `src/renderer/src/components/settings/SettingsGit.tsx`     | **Delete**                                                                        |
