# Hive — Phase 14 Product Requirements Document

## Overview

**Phase 14** focuses on **project customization, git merge operations, file staging accuracy, question UX, workspace reordering, scroll behavior, input polish, dock badge notifications, worktree status detail, and file search reliability**. The work spans ten items: adding per-project custom image icons picked from the user's filesystem in project settings, introducing a "Merge from" button that merges another branch into the current worktree branch, fixing the file changes panel so files with both staged and unstaged changes appear in both sections, removing single-question auto-submit so users always confirm via a Submit button, enabling drag-and-drop reordering of worktrees in the sidebar, scrolling instantly to the bottom when entering a session, widening the input field and fixing pre-populated draft height, incrementing the macOS dock badge on each notification, expanding worktree rows to two lines with rich status text, and fixing file search to work without visiting the Files tab first.

### Phase 14 Goals

- Allow users to pick a custom image file (SVG/PNG/JPG) as the icon for a project in Project Settings, overriding the language icon, with a clear button to restore the default
- Add a "Merge from {branch}" button in the git panel that merges a specified branch into the current worktree branch
- Show files with both staged and unstaged changes in both the Staged and Changes panels simultaneously
- Remove auto-submit behavior for single-question prompts so users always confirm their answer with a Submit button
- Allow drag-and-drop reordering of worktrees within a project in the sidebar
- Scroll instantly to the bottom (without animation) when entering a session
- Widen the message input field and ensure pre-populated draft text sets the correct textarea height immediately
- Increment the macOS dock badge count on each notification and clear it when the app gains focus
- Expand worktree sidebar rows to two lines, showing status text ("Working", "Answer questions", "Planning", "Archiving") on the second line
- Fix file search (Cmd+D) to work immediately without requiring the Files tab to be visited first

---

## Technical Additions

| Component                    | Technology                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Custom Project Icon          | DB migration (column), file picker + copy to `~/.hive/project-icons/`, modified `LanguageIcon.tsx` |
| Git Merge From               | New `merge()` in `git-service.ts`, new IPC handler, merge UI in `GitPushPull.tsx`                  |
| File Changes Dual Display    | Modified `getFileStatuses()` in `git-service.ts` — dual entries for staged+unstaged files          |
| Question Submit Confirmation | Modified `QuestionPrompt.tsx` — remove auto-submit, always require explicit Submit                 |
| Worktree Drag Reorder        | Modified `useWorktreeStore` (persisted order), drag handlers in `WorktreeItem.tsx`                 |
| Session Entry Auto-Scroll    | Modified `SessionView.tsx` — instant `scrollIntoView` on session switch                            |
| Better Input Field           | Modified `SessionView.tsx` — wider max-width, resize on session change                             |
| Dock Badge Notifications     | Modified `notification-service.ts` — `app.dock.setBadge()`, clear on window focus                  |
| Worktree Status Bar          | Expanded `useWorktreeStatusStore` statuses, two-line `WorktreeItem.tsx` layout                     |
| File Search Bug Fix          | Modified `FileSearchDialog.tsx` — trigger `loadFileTree()` on dialog open when tree is empty       |

---

## Features

### 1. Custom Icon per Project

#### 1.1 Current State

The `LanguageIcon` component in `src/renderer/src/components/projects/LanguageIcon.tsx` (101 lines) renders project icons based on the `project.language` field with a three-tier priority system:

```tsx
export function LanguageIcon({ language, className }: LanguageIconProps): React.JSX.Element {
  const customIcons = useCustomIcons()

  if (!language) {
    return <FolderGit2 className={className ?? 'h-4 w-4 text-muted-foreground shrink-0'} />
  }

  const customIconUrl = customIcons[language]
  if (customIconUrl) {
    return <img src={customIconUrl} alt={language} ... />
  }

  const config = LANGUAGE_MAP[language]
  if (!config) {
    return <FolderGit2 className={className ?? 'h-4 w-4 text-muted-foreground shrink-0'} />
  }

  return (
    <div className={`h-4 w-4 shrink-0 rounded-sm flex items-center justify-center ${config.bg}`}>
      <span className={`text-[8px] font-bold leading-none ${config.text}`}>{config.label}</span>
    </div>
  )
}
```

The `ProjectSettingsDialog` in `src/renderer/src/components/projects/ProjectSettingsDialog.tsx` (137 lines) only manages script fields (setup, run, archive). There is no icon customization.

The `Project` type in `src/preload/index.d.ts` and `src/main/db/types.ts` has no `custom_icon` field. The database schema (version 7) has no such column.

The app stores persistent data under `~/.hive/` (database at `~/.hive/hive.db`, logs at `~/.hive/logs/`).

#### 1.2 New Design

```
Custom Project Icon Flow:

  Project Settings Dialog — new section at top:
  ┌─────────────────────────────────────────────────────────┐
  │  Project Settings                                        │
  │  /Users/name/my-project                                  │
  │                                                          │
  │  Project Icon                                            │
  │  ┌──────┐                                                │
  │  │ [img] │  [Change]  [Clear]                            │
  │  └──────┘                                                │
  │  Choose a custom image for this project (SVG, PNG, JPG). │
  │                                                          │
  │  Setup Script                                            │
  │  ...                                                     │
  └─────────────────────────────────────────────────────────┘

  "Change" opens a native file picker dialog filtered to image files.
  "Clear" removes the custom icon, restoring the language-based default.

  File handling:
  1. User clicks "Change" → native dialog.showOpenDialog with filters:
     [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'] }]
  2. Selected file is COPIED to ~/.hive/project-icons/{projectId}{ext}
     (e.g. ~/.hive/project-icons/abc123.png)
  3. Database stores the filename: "abc123.png"
  4. Renderer reads it as a file:// URL or via an IPC that returns
     the data URL / resolved path

  Why copy instead of reference:
  - Original file may be moved/deleted
  - Consistent path under app control
  - Small files (icons) — negligible storage

  Rendering priority (updated LanguageIcon):
  1. custom_icon is set → render <img> from resolved icon path
  2. language has custom icon URL → render <img> (existing)
  3. language in LANGUAGE_MAP → render colored badge
  4. fallback → FolderGit2 icon

  Storage: filename string in `projects.custom_icon` column (e.g. "abc123.svg").
  Actual file at ~/.hive/project-icons/{filename}.
```

#### 1.3 Implementation

**Database migration (version 8):**

```sql
ALTER TABLE projects ADD COLUMN custom_icon TEXT DEFAULT NULL;
```

**Types — `src/main/db/types.ts`:**

```typescript
// Add to Project interface:
custom_icon: string | null

// Add to ProjectUpdate interface:
custom_icon?: string | null
```

**Types — `src/preload/index.d.ts`:**

```typescript
// Add to Project interface:
custom_icon: string | null

// Add to projectOps interface:
pickProjectIcon(projectId: string): Promise<{ success: boolean; filename?: string; error?: string }>
removeProjectIcon(projectId: string): Promise<{ success: boolean; error?: string }>
getProjectIconPath(filename: string): string
```

**New IPC handlers in `project-handlers.ts`:**

```typescript
import { dialog, app } from 'electron'
import { join, extname } from 'path'
import { copyFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'

const ICONS_DIR = join(app.getPath('home'), '.hive', 'project-icons')

// Ensure icons directory exists
function ensureIconsDir(): void {
  if (!existsSync(ICONS_DIR)) {
    mkdirSync(ICONS_DIR, { recursive: true })
  }
}

ipcMain.handle(
  'project:pickIcon',
  async (
    _event,
    projectId: string
  ): Promise<{ success: boolean; filename?: string; error?: string }> => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Choose Project Icon',
        filters: [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'] }],
        properties: ['openFile']
      })

      if (result.canceled || !result.filePaths[0]) {
        return { success: false }
      }

      const sourcePath = result.filePaths[0]
      const ext = extname(sourcePath) // e.g. ".png"
      const filename = `${projectId}${ext}`

      ensureIconsDir()

      // Remove any existing icon for this project (may have different extension)
      for (const oldExt of ['.svg', '.png', '.jpg', '.jpeg', '.webp']) {
        const oldPath = join(ICONS_DIR, `${projectId}${oldExt}`)
        if (existsSync(oldPath)) unlinkSync(oldPath)
      }

      // Copy the new icon
      const destPath = join(ICONS_DIR, filename)
      copyFileSync(sourcePath, destPath)

      return { success: true, filename }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

ipcMain.handle(
  'project:removeIcon',
  async (_event, projectId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      for (const ext of ['.svg', '.png', '.jpg', '.jpeg', '.webp']) {
        const filePath = join(ICONS_DIR, `${projectId}${ext}`)
        if (existsSync(filePath)) unlinkSync(filePath)
      }
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

ipcMain.handle('project:getIconPath', (_event, filename: string): string => {
  return join(ICONS_DIR, filename)
})
```

**Preload bridge (`preload/index.ts`):**

```typescript
pickProjectIcon: (projectId: string): Promise<{ success: boolean; filename?: string; error?: string }> =>
  ipcRenderer.invoke('project:pickIcon', projectId),
removeProjectIcon: (projectId: string): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('project:removeIcon', projectId),
getProjectIconPath: (filename: string): string =>
  // Synchronous — returns the resolved file:// path for rendering
  // Alternatively use ipcRenderer.invoke for async
  ipcRenderer.sendSync('project:getIconPath', filename)
```

Note: For `getProjectIconPath`, a synchronous IPC call keeps the rendering simple. Alternatively, resolve the path on the main process side and store the full path in the DB, or use a preload-computed path since `~/.hive/project-icons/` is deterministic.

A simpler approach: expose a constant `ICONS_BASE_PATH` from preload and let the renderer construct `file://${ICONS_BASE_PATH}/${filename}` directly, avoiding the IPC round-trip entirely.

**LanguageIcon.tsx — Accept and prioritize custom icon:**

```tsx
interface LanguageIconProps {
  language: string | null
  customIcon?: string | null // NEW: filename like "abc123.png"
  className?: string
}

export function LanguageIcon({
  language,
  customIcon,
  className
}: LanguageIconProps): React.JSX.Element {
  const customIcons = useCustomIcons()

  // Priority 1: per-project custom image icon
  if (customIcon) {
    // Resolve to file:// URL from the icons directory
    const iconUrl = `file://${window.projectOps.getProjectIconPath(customIcon)}`
    return (
      <img
        src={iconUrl}
        alt="project icon"
        className="h-4 w-4 shrink-0 object-contain rounded-sm"
      />
    )
  }

  // Priority 2+: existing logic unchanged
  if (!language) {
    return <FolderGit2 className={className ?? 'h-4 w-4 text-muted-foreground shrink-0'} />
  }

  const customIconUrl = customIcons[language]
  if (customIconUrl) {
    return <img src={customIconUrl} alt={language} className="h-4 w-4 shrink-0 object-contain" />
  }

  const config = LANGUAGE_MAP[language]
  if (!config) {
    return <FolderGit2 className={className ?? 'h-4 w-4 text-muted-foreground shrink-0'} />
  }

  return (
    <div className={`h-4 w-4 shrink-0 rounded-sm flex items-center justify-center ${config.bg}`}>
      <span className={`text-[8px] font-bold leading-none ${config.text}`}>{config.label}</span>
    </div>
  )
}
```

**ProjectItem.tsx — Pass custom icon:**

```tsx
<LanguageIcon language={project.language} customIcon={project.custom_icon} />
```

**ProjectSettingsDialog.tsx — Add icon picker section:**

```tsx
const [customIcon, setCustomIcon] = useState<string | null>(null)

// On open:
useEffect(() => {
  if (open) {
    setCustomIcon(project.custom_icon ?? null)
    // ... existing script state
  }
}, [open, project.custom_icon, ...])

const handlePickIcon = async () => {
  const result = await window.projectOps.pickProjectIcon(project.id)
  if (result.success && result.filename) {
    setCustomIcon(result.filename)
  } else if (result.error) {
    toast.error(result.error)
  }
}

const handleClearIcon = async () => {
  await window.projectOps.removeProjectIcon(project.id)
  setCustomIcon(null)
}

// Icon picker section (above scripts):
<div className="space-y-1.5">
  <label className="text-sm font-medium">Project Icon</label>
  <p className="text-xs text-muted-foreground">
    Choose a custom image for this project (SVG, PNG, JPG).
  </p>
  <div className="flex items-center gap-3">
    <div className="h-10 w-10 rounded-md border border-border flex items-center justify-center overflow-hidden bg-muted/30">
      {customIcon ? (
        <img
          src={`file://${window.projectOps.getProjectIconPath(customIcon)}`}
          alt="project icon"
          className="h-8 w-8 object-contain"
        />
      ) : (
        <LanguageIcon language={project.language} className="h-5 w-5 text-muted-foreground" />
      )}
    </div>
    <Button variant="outline" size="sm" onClick={handlePickIcon}>
      Change
    </Button>
    {customIcon && (
      <Button variant="ghost" size="sm" onClick={handleClearIcon}>
        Clear
      </Button>
    )}
  </div>
</div>

// On save — include custom_icon:
await updateProject(project.id, {
  setup_script: setupScript.trim() || null,
  run_script: runScript.trim() || null,
  archive_script: archiveScript.trim() || null,
  custom_icon: customIcon
})
```

#### 1.4 Files to Modify

| File                                                             | Change                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/main/db/schema.ts`                                          | Add migration v8: `custom_icon TEXT` column on projects                      |
| `src/main/db/types.ts`                                           | Add `custom_icon` to `Project` and `ProjectUpdate`                           |
| `src/preload/index.d.ts`                                         | Add `custom_icon` to Project, add icon IPC methods to projectOps             |
| `src/preload/index.ts`                                           | Expose `pickProjectIcon`, `removeProjectIcon`, `getProjectIconPath`          |
| `src/main/ipc/project-handlers.ts`                               | Add `project:pickIcon`, `project:removeIcon`, `project:getIconPath` handlers |
| `src/renderer/src/components/projects/LanguageIcon.tsx`          | Add `customIcon` prop, render `<img>` from resolved file path                |
| `src/renderer/src/components/projects/ProjectItem.tsx`           | Pass `project.custom_icon` to `LanguageIcon`                                 |
| `src/renderer/src/components/projects/ProjectSettingsDialog.tsx` | Add icon picker section with file picker and clear button                    |

---

### 2. Git Merge From

#### 2.1 Current State

There is no merge method in `src/main/services/git-service.ts` (1068 lines). The only merge-adjacent operation is `pull()` (lines 738-780) which supports `--rebase`. The `GitPushPull` component in `src/renderer/src/components/git/GitPushPull.tsx` (200 lines) only handles push and pull with force/rebase options.

Worktrees are created from the default branch via `createWorktree()` (line 223) which runs `git worktree add -b cityName worktreePath defaultBranch`, but the source branch is not stored.

The git IPC handlers live in `src/main/ipc/git-file-handlers.ts` and use `createGitService(worktreePath)` to instantiate the service.

#### 2.2 New Design

```
Merge From Flow:

  User is on feature branch "tallinn" in their worktree.
  They want to pull in latest changes from main (or another branch).

  UI location: below Push/Pull in GitPushPull.tsx
  ┌─────────────────────────────────────────────────────────┐
  │  [Push ↑ (2)]  [Pull ↓]                                 │
  │  ☐ Force push          ☐ Rebase on pull                  │
  │  ─────────────────────────────────────────────────────── │
  │  Merge from [main________]  [Merge]                      │
  └─────────────────────────────────────────────────────────┘

  - Default value: the default branch (main/master) via getDefaultBranch()
  - Editable text input: user can type any branch name
  - "Merge" button triggers `git merge {sourceBranch}` in current worktree

  On click "Merge":
  1. Run `git merge {source_branch}` in the current worktree cwd
  2. Success → toast "Merged {source_branch} into {current_branch}"
  3. Conflict → toast error with conflict file list
     Conflicted files appear in Changes panel (status 'C')
  4. Refresh file statuses + branch info after merge

  Why "merge from" (not "merge into"):
  - Single command in current worktree — no branch switching
  - No cross-worktree operations needed
  - Target branch may be checked out in another worktree — fine
  - Standard git pattern: `git merge main` from feature branch
```

#### 2.3 Implementation

**git-service.ts — New `merge()` method:**

```typescript
/**
 * Merge a source branch into the current branch
 */
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
    // simple-git throws GitResponseError on conflicts
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

**git-file-handlers.ts — New `git:merge` IPC handler:**

```typescript
ipcMain.handle(
  'git:merge',
  async (
    _event,
    worktreePath: string,
    sourceBranch: string
  ): Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
    try {
      const gitService = createGitService(worktreePath)
      return await gitService.merge(sourceBranch)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)
```

**Preload bridge (`preload/index.ts`):**

```typescript
merge: (
  worktreePath: string,
  sourceBranch: string
): Promise<{ success: boolean; error?: string; conflicts?: string[] }> =>
  ipcRenderer.invoke('git:merge', worktreePath, sourceBranch)
```

**Type declaration (`preload/index.d.ts`):**

```typescript
// In gitOps interface:
merge(worktreePath: string, sourceBranch: string): Promise<{
  success: boolean
  error?: string
  conflicts?: string[]
}>
```

**GitPushPull.tsx — Add merge UI section:**

```tsx
const [mergeBranch, setMergeBranch] = useState('')
const [isMerging, setIsMerging] = useState(false)

// Load default branch on mount
useEffect(() => {
  if (worktreePath) {
    window.gitOps.getDefaultBranch(worktreePath).then((branch) => {
      if (branch) setMergeBranch(branch)
    })
  }
}, [worktreePath])

const handleMerge = useCallback(async () => {
  if (!worktreePath || !mergeBranch.trim()) return
  setIsMerging(true)
  try {
    const result = await window.gitOps.merge(worktreePath, mergeBranch.trim())
    if (result.success) {
      toast.success(`Merged ${mergeBranch} successfully`)
      // Refresh statuses
      refreshFileStatuses(worktreePath)
      refreshBranchInfo(worktreePath)
    } else {
      toast.error('Merge failed', { description: result.error })
    }
  } finally {
    setIsMerging(false)
  }
}, [worktreePath, mergeBranch])

// In JSX — new section below push/pull options:
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

Note: `getDefaultBranch` needs to be exposed via IPC if not already. Currently `getDefaultBranch()` exists in `git-service.ts` (lines 168-177) but may not have an IPC handler. Add one if missing, or derive the default branch from the already-available `branchInfo` data.

#### 2.4 Files to Modify

| File                                              | Change                                                |
| ------------------------------------------------- | ----------------------------------------------------- |
| `src/main/services/git-service.ts`                | Add `merge(sourceBranch)` method                      |
| `src/main/ipc/git-file-handlers.ts`               | Add `git:merge` IPC handler                           |
| `src/preload/index.ts`                            | Expose `merge()` in `gitOps` namespace                |
| `src/preload/index.d.ts`                          | Add `merge` type declaration to `gitOps`              |
| `src/renderer/src/components/git/GitPushPull.tsx` | Add merge UI section with branch input + merge button |
| `src/renderer/src/stores/useGitStore.ts`          | Add `merge` action wrapping `window.gitOps.merge()`   |

---

### 3. File Changes — Show in Both Panels

#### 3.1 Current State

In `src/main/services/git-service.ts` `getFileStatuses()` (lines 376-461), when a file appears in both `status.modified` (unstaged changes) and `status.staged` (staged changes), the code merges them into a single entry:

```typescript
// Process modified files (not staged)
for (const file of status.modified) {
  files.push({
    path: join(this.repoPath, file),
    relativePath: file,
    status: 'M',
    staged: false
  })
}

// Process staged files
for (const file of status.staged) {
  const existing = files.find((f) => f.relativePath === file)
  if (existing) {
    // File has both staged and unstaged changes
    existing.staged = true  // ← overwrites staged to true, losing the unstaged entry
  } else {
    files.push({ ..., status: 'A', staged: true })
  }
}
```

When the existing entry has `staged` set to `true`, the renderer's `ChangesView.tsx` (lines 88-110) categorizes it only into the "Staged" bucket because `file.staged` is checked first:

```typescript
for (const file of files) {
  if (file.staged) {
    staged.push(file) // ← file lands here only
  } else if (file.status === '?') {
    untracked.push(file)
  } else if (file.status === 'M' || file.status === 'D' || file.status === 'A') {
    modified.push(file) // ← never reached for this file
  }
}
```

The result: a file with both staged and unstaged changes only appears under "Staged Changes". The user cannot see or stage the remaining unstaged portion.

#### 3.2 New Design

```
Dual Entry Strategy:

  When a file has BOTH staged and unstaged changes, emit TWO entries
  from getFileStatuses():

  1. { relativePath: "file.ts", status: 'M', staged: false }  → Changes panel
  2. { relativePath: "file.ts", status: 'M', staged: true  }  → Staged panel

  The renderer's categorization logic already handles this correctly
  because it iterates the array and checks file.staged per entry.

  User sees:
  ┌─ Staged Changes ────────────────────┐
  │  ☑ M  src/file.ts                    │  ← staged portion
  ├─ Changes ───────────────────────────┤
  │  ☐ M  src/file.ts                    │  ← unstaged portion
  └─────────────────────────────────────┘

  Stage action on the unstaged entry stages the remaining changes.
  Unstage action on the staged entry moves changes back to unstaged.
```

#### 3.3 Implementation

**git-service.ts — Create two entries for staged+unstaged files:**

```typescript
// Process staged files
for (const file of status.staged) {
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
    files.push({
      path: join(this.repoPath, file),
      relativePath: file,
      status: 'A',
      staged: true
    })
  }
}
```

The only change is replacing `existing.staged = true` with a new `files.push()`. The existing unstaged entry remains with `staged: false`. The renderer needs no changes — the categorization loop will naturally put the two entries into their respective panels.

#### 3.4 Files to Modify

| File                               | Change                                                        |
| ---------------------------------- | ------------------------------------------------------------- |
| `src/main/services/git-service.ts` | Emit two entries instead of mutating `existing.staged = true` |

---

### 4. Question Tool — Don't Auto-Submit Single Questions

#### 4.1 Current State

The `QuestionPrompt` component in `src/renderer/src/components/sessions/QuestionPrompt.tsx` (340 lines) auto-submits in two cases:

**Case 1 — Single question, single choice (lines 39-43):**

```typescript
const handleOptionClick = useCallback((label: string) => {
  if (sending) return

  if (!isMultiple && !isMultiQuestion) {
    // Single question, single choice — auto-submit immediately
    setSending(true)
    onReply(request.id, [[label]])
    return
  }
  // ...
})
```

Clicking any option immediately sends the answer without confirmation.

**Case 2 — Single question, custom text (lines 85-89):**

```typescript
const handleCustomSubmit = useCallback((e: React.FormEvent) => {
  // ...
  if (!isMultiQuestion) {
    // Single question custom text — auto-submit
    setSending(true)
    onReply(request.id, [[text]])
    return
  }
  // ...
})
```

The custom text form also auto-submits for single questions.

**Action buttons area (lines 276-286):** The Submit button is only shown for `isMultiple && !isMultiQuestion`:

```tsx
{
  isMultiple && !isMultiQuestion && (
    <Button size="sm" onClick={() => handleSubmit()} disabled={!hasCurrentAnswer || sending}>
      {sending ? 'Sending...' : 'Submit'}
    </Button>
  )
}
```

Single-choice, single-question has no Submit button — the click IS the submit.

#### 4.2 New Design

```
No Auto-Submit Behavior:

  All question configurations now require an explicit Submit button click.

  Single question, single choice (was: auto-submit on click):
  1. Click an option → highlight it (toggle selection)
  2. Click "Submit" → send answer
  3. Only ONE option can be selected (radio-like behavior)

  Single question, custom text (was: auto-submit on form submit):
  1. Type text, click form "Submit" → save as selected answer
  2. Click main "Submit" → send answer
  OR simplify: custom text form submit directly selects the text,
     then user clicks main Submit to confirm.

  The Submit button is ALWAYS shown (not just for isMultiple).

  Behavior matrix:
  ┌───────────────────────┬──────────────────────────────────┐
  │ Configuration          │ Behavior                          │
  ├───────────────────────┼──────────────────────────────────┤
  │ Single Q, single-choice│ Select option → click Submit      │
  │ Single Q, multi-choice │ Toggle options → click Submit     │
  │ Multi Q, single-choice │ Select → auto-advance (unchanged) │
  │ Multi Q, multi-choice  │ Toggle → Next/Submit All          │
  └───────────────────────┴──────────────────────────────────┘

  Multi-question auto-advance is kept because the user still
  must click "Submit All" on the last tab to confirm everything.
```

#### 4.3 Implementation

**QuestionPrompt.tsx — Remove auto-submit for single question:**

```tsx
const handleOptionClick = useCallback(
  (label: string) => {
    if (sending) return

    // REMOVED: auto-submit for single question single choice
    // Now all single-choice selections just set the answer

    if (isMultiple) {
      // Multi-choice: toggle the selection (unchanged)
      setAnswers((prev) => {
        const updated = [...prev]
        const current = updated[currentTab] || []
        if (current.includes(label)) {
          updated[currentTab] = current.filter((l) => l !== label)
        } else {
          updated[currentTab] = [...current, label]
        }
        return updated
      })
      return
    }

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
  },
  [sending, isMultiple, isMultiQuestion, currentTab, isLastTab]
)
```

**Custom text submit — save answer without auto-submit:**

```tsx
const handleCustomSubmit = useCallback(
  (e: React.FormEvent) => {
    e.preventDefault()
    const text = customInputs[currentTab]?.trim()
    if (!text || sending) return

    // Save custom text as the answer (no auto-submit)
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
  },
  [customInputs, currentTab, sending, isMultiQuestion, isLastTab]
)
```

**Always show Submit button for single question:**

```tsx
{/* Submit button — shown for ALL single-question configurations */}
{!isMultiQuestion && (
  <Button
    size="sm"
    onClick={() => handleSubmit()}
    disabled={!hasCurrentAnswer || sending}
  >
    {sending ? 'Sending...' : 'Submit'}
  </Button>
)}

{/* Multi-question navigation (unchanged) */}
{isMultiQuestion && (
  // ... Back / Next / Submit All buttons unchanged
)}
```

The key changes are:

1. Remove the early `return` with `onReply` in `handleOptionClick` for `!isMultiple && !isMultiQuestion`
2. Remove the early `return` with `onReply` in `handleCustomSubmit` for `!isMultiQuestion`
3. Change the Submit button condition from `isMultiple && !isMultiQuestion` to `!isMultiQuestion`

#### 4.4 Files to Modify

| File                                                      | Change                                              |
| --------------------------------------------------------- | --------------------------------------------------- |
| `src/renderer/src/components/sessions/QuestionPrompt.tsx` | Remove auto-submit, always show Submit for single Q |

---

### 5. Reorder Worktrees with Drag-and-Drop

#### 5.1 Current State

`WorktreeList.tsx` in `src/renderer/src/components/worktrees/WorktreeList.tsx` (39 lines) renders worktrees in the order returned by `getWorktreesForProject(project.id)`. The ordering is determined in `useWorktreeStore.loadWorktrees()`:

```typescript
const sortedWorktrees = worktrees.sort((a, b) => {
  if (a.is_default && !b.is_default) return -1
  if (!a.is_default && b.is_default) return 1
  return new Date(b.last_accessed_at).getTime() - new Date(a.last_accessed_at).getTime()
})
```

Default worktree first, then by most recently accessed. There is no custom ordering or drag-and-drop.

The `SessionTabs` component already implements drag-and-drop tab reordering using native HTML5 drag events (`onDragStart`, `onDragOver`, `onDrop`, `onDragEnd`) with a `reorderTabs(worktreeId, fromIndex, toIndex)` action in the session store and persistent `tabOrderByWorktree` state.

#### 5.2 New Design

```
Worktree Drag-and-Drop:

  Sidebar worktree list within a project:
  ┌─ tedooo-website ────────────────────┐
  │  📁 main                             │  ← default always stays first
  │  ⊡ tallinn ≡                        │  ← draggable (drag handle on hover)
  │  ⊡ vienna  ≡                        │  ← draggable
  │  ⊡ london  ≡                        │  ← draggable
  └─────────────────────────────────────┘

  Rules:
  1. Default worktree is pinned at the top — not draggable
  2. Non-default worktrees can be reordered via drag-and-drop
  3. Drag feedback: dragged item becomes semi-transparent
  4. Drop indicator: highlight border between items at drop position
  5. Order persists across sessions (localStorage)

  State:
  - worktreeOrderByProject: Map<projectId, worktreeId[]>
  - Persisted in useWorktreeStore's persist config
  - getWorktreesForProject() applies custom order when available
  - New worktrees are appended to the end of the custom order
```

#### 5.3 Implementation

**useWorktreeStore — Add order tracking:**

```typescript
// New state
worktreeOrderByProject: Map<string, string[]>

// New action
reorderWorktrees: (projectId: string, fromIndex: number, toIndex: number) => {
  const currentOrder = get().worktreeOrderByProject.get(projectId)
  if (!currentOrder) return
  const updated = [...currentOrder]
  const [moved] = updated.splice(fromIndex, 1)
  updated.splice(toIndex, 0, moved)
  const newMap = new Map(get().worktreeOrderByProject)
  newMap.set(projectId, updated)
  set({ worktreeOrderByProject: newMap })
}

// Modified getWorktreesForProject:
getWorktreesForProject: (projectId: string) => {
  const worktrees = get().worktreesByProject.get(projectId) || []
  const customOrder = get().worktreeOrderByProject.get(projectId)
  if (!customOrder) return worktrees

  // Default worktree always first
  const defaultWt = worktrees.find((w) => w.is_default)
  const nonDefault = worktrees.filter((w) => !w.is_default)

  // Sort non-default by custom order
  const ordered = customOrder
    .map((id) => nonDefault.find((w) => w.id === id))
    .filter(Boolean) as Worktree[]

  // Append any new worktrees not in the custom order
  const orderedIds = new Set(customOrder)
  const remaining = nonDefault.filter((w) => !orderedIds.has(w.id))

  return [...(defaultWt ? [defaultWt] : []), ...ordered, ...remaining]
}
```

**WorktreeItem.tsx — Add drag handlers:**

```tsx
interface WorktreeItemProps {
  worktree: Worktree
  projectPath: string
  index: number              // NEW — position in the list
  onReorder: (from: number, to: number) => void  // NEW — callback
}

// Only non-default worktrees are draggable
const isDraggable = !worktree.is_default

// In the row div:
<div
  draggable={isDraggable}
  onDragStart={(e) => {
    e.dataTransfer.setData('text/plain', String(index))
    e.dataTransfer.effectAllowed = 'move'
  }}
  onDragOver={(e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }}
  onDrop={(e) => {
    e.preventDefault()
    const fromIndex = Number(e.dataTransfer.getData('text/plain'))
    if (fromIndex !== index) onReorder(fromIndex, index)
  }}
  className={cn(
    'group flex items-center gap-1.5 pl-8 pr-2 py-1 rounded-md cursor-pointer transition-colors',
    isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
    isArchiving && 'opacity-50 pointer-events-none'
  )}
  // ...
>
```

**WorktreeList.tsx — Pass index and reorder callback:**

```tsx
{
  worktrees.map((worktree, index) => (
    <WorktreeItem
      key={worktree.id}
      worktree={worktree}
      projectPath={project.path}
      index={index}
      onReorder={(from, to) => reorderWorktrees(project.id, from, to)}
    />
  ))
}
```

#### 5.4 Files to Modify

| File                                                     | Change                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/renderer/src/stores/useWorktreeStore.ts`            | Add `worktreeOrderByProject`, `reorderWorktrees`, modify `getWorktreesForProject` |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Add `draggable`, drag event handlers, visual feedback                             |
| `src/renderer/src/components/worktrees/WorktreeList.tsx` | Pass `index` and `onReorder` props to WorktreeItem                                |

---

### 6. Auto-Scroll to Bottom on Session Entry

#### 6.1 Current State

In `SessionView.tsx` (lines 527-536), the session switch effect resets auto-scroll state but does not explicitly scroll to the bottom:

```typescript
// Reset auto-scroll state on session switch
useEffect(() => {
  if (scrollCooldownRef.current !== null) {
    clearTimeout(scrollCooldownRef.current)
    scrollCooldownRef.current = null
  }
  isScrollCooldownActiveRef.current = false
  isAutoScrollEnabledRef.current = true
  setShowScrollFab(false)
  userHasScrolledUpRef.current = false
}, [sessionId])
```

The auto-scroll effect (lines 520-524) triggers on `[messages, streamingContent, streamingParts]` changes, but on session entry these values may already be set from the previous render — no change, no scroll. Additionally, the `scrollToBottom` function uses `behavior: 'smooth'` (line 449) which causes a visible animation.

The result: entering a session with existing messages may leave the user scrolled partway up, or animate slowly to the bottom.

#### 6.2 New Design

```
Instant Scroll on Session Entry:

  When sessionId changes:
  1. Reset all scroll state (existing behavior)
  2. Wait one frame (requestAnimationFrame) for messages to render
  3. Scroll to bottom INSTANTLY — no smooth animation

  Use scrollIntoView({ behavior: 'instant' }) or
  set scrollTop = scrollHeight directly.

  The smooth scrollToBottom() remains for streaming auto-scroll.
  Only the initial session entry scroll is instant.
```

#### 6.3 Implementation

**SessionView.tsx — Add instant scroll on session entry:**

```typescript
// Reset auto-scroll state on session switch + instant scroll to bottom
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

The only addition is the `requestAnimationFrame` + `scrollIntoView({ behavior: 'instant' })` at the end of the existing effect. The `'instant'` behavior is supported in all modern browsers and skips the smooth animation.

#### 6.4 Files to Modify

| File                                                   | Change                                                |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add instant scroll to bottom in session switch effect |

---

### 7. Better Input Field

#### 7.1 Current State

The input area in `SessionView.tsx` (lines 2072-2173) has two issues:

**A. Narrow max width:** The container is constrained to `max-w-3xl` (768px):

```tsx
<div className="max-w-3xl mx-auto relative">
```

This leaves significant unused horizontal space on wider screens.

**B. Pre-populated text height:** The auto-resize effect (lines 554-561) only runs on `inputValue` changes:

```typescript
useEffect(() => {
  const textarea = textareaRef.current
  if (textarea) {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }
}, [inputValue])
```

When entering a session with a pre-populated draft (from the `draft_input` persistence), the `inputValue` is set during initial render. But the textarea may not yet be mounted when the effect runs for the initial value, or the initial value is the same across a session switch, causing the textarea to stay at its minimum 40px height even though the content requires more.

#### 7.2 New Design

```
Input Field Improvements:

  A. Wider field:
     Change max-w-3xl (768px) to max-w-4xl (896px).
     This gives ~128px more width on wide screens.
     The message list area above should also match this width
     for visual consistency.

  B. Pre-populated height fix:
     Add sessionId to the auto-resize effect dependency array.
     When sessionId changes AND inputValue is pre-populated,
     the effect re-runs and sizes the textarea correctly.

     Also run resize in a requestAnimationFrame to ensure the
     textarea DOM is fully rendered before measuring scrollHeight.
```

#### 7.3 Implementation

**SessionView.tsx — Wider container:**

```tsx
{/* Change from max-w-3xl to max-w-4xl */}
<div className="max-w-4xl mx-auto relative">
```

Also update the message list container to match if it uses `max-w-3xl`.

**SessionView.tsx — Fix auto-resize for pre-populated text:**

```typescript
// Auto-resize textarea — also run on session switch for pre-populated drafts
useEffect(() => {
  const textarea = textareaRef.current
  if (textarea) {
    // Use rAF to ensure DOM is measured after render
    requestAnimationFrame(() => {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    })
  }
}, [inputValue, sessionId])
```

Adding `sessionId` to the dependency array ensures the resize runs when switching to a session with a pre-populated draft, even if the `inputValue` was already set before the effect ran.

#### 7.4 Files to Modify

| File                                                   | Change                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Widen to `max-w-4xl`, add `sessionId` to resize effect deps |

---

### 8. Dock Badge on Notifications

#### 8.1 Current State

The `NotificationService` in `src/main/services/notification-service.ts` (55 lines) fires native OS notifications when a session completes and the window is unfocused, but never interacts with the macOS dock badge:

```typescript
class NotificationService {
  private mainWindow: BrowserWindow | null = null

  showSessionComplete(data: SessionNotificationData): void {
    if (!Notification.isSupported()) { ... }
    const notification = new Notification({
      title: data.projectName,
      body: `"${data.sessionName}" completed`,
      silent: false
    })
    notification.on('click', () => { ... })
    notification.show()
  }
}
```

There are zero calls to `app.dock.setBadge()`, `app.setBadgeCount()`, or `app.dock.bounce()` anywhere in the codebase.

#### 8.2 New Design

```
Dock Badge Integration:

  On each notification:
  1. Increment an internal unread counter
  2. Set the dock badge to the counter value: app.dock?.setBadge(String(count))

  On app focus:
  1. Clear the counter
  2. Clear the dock badge: app.dock?.setBadge('')

  Edge cases:
  - Multiple notifications while unfocused → badge shows cumulative count
  - User clicks notification (brings app to focus) → badge clears via focus handler
  - app.dock is macOS-only — use optional chaining (app.dock?.setBadge)
  - On non-macOS: no-op (dock API doesn't exist)
```

#### 8.3 Implementation

**notification-service.ts — Add badge tracking:**

```typescript
import { Notification, BrowserWindow, app } from 'electron'
import { createLogger } from './logger'

const log = createLogger({ component: 'NotificationService' })

class NotificationService {
  private mainWindow: BrowserWindow | null = null
  private unreadCount = 0

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window

    // Clear badge when window gains focus
    window.on('focus', () => {
      this.clearBadge()
    })
  }

  showSessionComplete(data: SessionNotificationData): void {
    if (!Notification.isSupported()) {
      log.warn('Notifications not supported on this platform')
      return
    }

    log.info('Showing session complete notification', {
      projectName: data.projectName,
      sessionName: data.sessionName
    })

    const notification = new Notification({
      title: data.projectName,
      body: `"${data.sessionName}" completed`,
      silent: false
    })

    notification.on('click', () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.show()
        this.mainWindow.focus()
        this.mainWindow.webContents.send('notification:navigate', {
          projectId: data.projectId,
          worktreeId: data.worktreeId,
          sessionId: data.sessionId
        })
      }
    })

    notification.show()

    // Increment dock badge
    this.unreadCount++
    app.dock?.setBadge(String(this.unreadCount))
  }

  private clearBadge(): void {
    this.unreadCount = 0
    app.dock?.setBadge('')
  }
}
```

The changes are:

1. Import `app` from `electron`
2. Add `unreadCount` field
3. In `setMainWindow`: register `window.on('focus', clearBadge)`
4. In `showSessionComplete`: increment count, set badge
5. New `clearBadge` method: reset count, clear badge string

#### 8.4 Files to Modify

| File                                        | Change                                                        |
| ------------------------------------------- | ------------------------------------------------------------- |
| `src/main/services/notification-service.ts` | Add `unreadCount`, `setBadge` on notification, clear on focus |

---

### 9. Worktree Status Bar — Two-Line Rows with Status Text

#### 9.1 Current State

`WorktreeItem.tsx` (lines 208-266) renders a single-line flex row:

```tsx
<div className="group flex items-center gap-1.5 pl-8 pr-2 py-1 rounded-md cursor-pointer ...">
  {/* Icons (archiving/running/working/default) */}
  {/* Name or rename input */}
  {/* Unread dot */}
  {/* More options dropdown */}
</div>
```

The `useWorktreeStatusStore` (87 lines) only tracks two statuses: `'working' | 'unread'`, derived from stream events:

```typescript
interface SessionStatus {
  status: 'working' | 'unread'
  timestamp: number
}
```

There is no concept of "answering", "planning", or "archiving" status in the store. The archiving state is tracked separately via `archivingWorktreeIds` in `useWorktreeStore`.

#### 9.2 New Design

```
Two-Line Worktree Row:

  ┌──────────────────────────────────────────────────────┐
  │  🔀 tallinn                                    •••   │  ← line 1: icon + name + menu
  │     Working                                          │  ← line 2: status text
  └──────────────────────────────────────────────────────┘

  Status text values (priority order):
  1. "Archiving"        — worktree is being archived (archivingWorktreeIds)
  2. "Answer questions"  — any session has a pending question
  3. "Planning"          — session is working AND in plan mode
  4. "Working"           — session is working (busy) in build mode
  5. ""  (empty)         — idle / no active status

  Line 2 only appears when there is status text to show.
  When empty, the row stays compact (single line).

  Status text styling: text-xs text-muted-foreground, with a colored
  dot indicator matching the status type.

  Extended SessionStatus type:
  - 'working' | 'planning' | 'answering' | 'unread'
  - 'archiving' is not in the store — derived from archivingWorktreeIds

  Display status computation (in WorktreeItem or a helper):
  - If archivingWorktreeIds has this worktree → "Archiving"
  - If any session status is 'answering' → "Answer questions"
  - If any session status is 'planning' → "Planning"
  - If any session status is 'working' → "Working"
  - Otherwise → "" (no second line)
```

#### 9.3 Implementation

**useWorktreeStatusStore.ts — Extend status types:**

```typescript
interface SessionStatus {
  status: 'working' | 'planning' | 'answering' | 'unread'
  timestamp: number
}

interface WorktreeStatusState {
  sessionStatuses: Record<string, SessionStatus | null>

  setSessionStatus: (
    sessionId: string,
    status: 'working' | 'planning' | 'answering' | 'unread' | null
  ) => void
  clearSessionStatus: (sessionId: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  getWorktreeStatus: (worktreeId: string) => 'working' | 'planning' | 'answering' | 'unread' | null
}
```

Update `getWorktreeStatus` to return the highest priority active status:

```typescript
getWorktreeStatus: (worktreeId: string) => {
  const { sessionStatuses } = get()
  const sessionStore = useSessionStore.getState()
  const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []
  const sessionIds = sessions.map((s) => s.id)

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

**Status detection — Setting 'planning' and 'answering':**

In `SessionView.tsx` where stream events set session status to `'working'`, check the session mode:

- If `mode === 'plan'` → set `'planning'` instead of `'working'`
- When a question event arrives (pending question detected) → set `'answering'`
- When question is answered → restore to `'working'` or `'planning'` (or clear if idle)

**WorktreeItem.tsx — Two-line layout:**

```tsx
const archivingWorktreeIds = useWorktreeStore((s) => s.archivingWorktreeIds)
const isArchivingThis = archivingWorktreeIds.has(worktree.id)

// Derive display status text
const displayStatus = isArchivingThis
  ? 'Archiving'
  : worktreeStatus === 'answering'
    ? 'Answer questions'
    : worktreeStatus === 'planning'
      ? 'Planning'
      : worktreeStatus === 'working'
        ? 'Working'
        : null

// Updated row layout:
<div className={cn(
  'group flex items-center gap-1.5 pl-8 pr-2 rounded-md cursor-pointer transition-colors',
  displayStatus ? 'py-1' : 'py-1',  // same padding, second line adds natural height
  isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
  isArchiving && 'opacity-50 pointer-events-none'
)}>
  {/* Icons — unchanged */}

  {/* Name + Status — wrapped in flex-col */}
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

  {/* Unread dot — unchanged */}
  {/* More options — unchanged */}
</div>
```

#### 9.4 Files to Modify

| File                                                     | Change                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/renderer/src/stores/useWorktreeStatusStore.ts`      | Extend status to include `'planning'` and `'answering'`              |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Two-line layout with status text, derive display status              |
| `src/renderer/src/components/sessions/SessionView.tsx`   | Set `'planning'` status when mode is plan, `'answering'` on question |

---

### 10. File Search Bug Fix

#### 10.1 Current State

The `FileSearchDialog` in `src/renderer/src/components/file-search/FileSearchDialog.tsx` (274 lines) reads the file tree from `useFileTreeStore` but never triggers a load:

```tsx
// Line 87-91: reads existing tree data, falls back to empty
const fileTree = useFileTreeStore(
  (state) =>
    (selectedWorktreePath ? state.fileTreeByWorktree.get(selectedWorktreePath) : undefined) ??
    EMPTY_TREE
)

// Line 94: flattens tree into searchable list
const allFiles = useMemo(() => flattenTree(fileTree), [fileTree])
```

The file tree is only loaded when the Files tab panel mounts and calls `loadFileTree(worktreePath)`. If the user opens file search (Cmd+D) without ever visiting the Files tab, `fileTreeByWorktree` has no entry for the current worktree path, `fileTree` is `EMPTY_TREE`, and `allFiles` is empty — search shows "No files found."

The `loadFileTree` action in `useFileTreeStore` (lines 75-98) calls `window.fileTreeOps.scan(worktreePath)` and stores the result in `fileTreeByWorktree`.

#### 10.2 New Design

```
Eager File Tree Loading:

  When the FileSearchDialog opens and the file tree for the current
  worktree is empty, trigger loadFileTree() automatically.

  This is a minimal, targeted fix:
  1. Dialog opens → check if fileTree === EMPTY_TREE
  2. If empty and worktreePath exists → call loadFileTree(worktreePath)
  3. The store updates → fileTree re-renders → allFiles populates → search works

  No need to eagerly load on worktree selection (wasteful for
  projects with many worktrees). Only load when search is opened.
```

#### 10.3 Implementation

**FileSearchDialog.tsx — Trigger load when tree is empty:**

```tsx
const loadFileTree = useFileTreeStore((state) => state.loadFileTree)

// Load file tree on open if not already loaded
useEffect(() => {
  if (isOpen && selectedWorktreePath && fileTree === EMPTY_TREE) {
    loadFileTree(selectedWorktreePath)
  }
}, [isOpen, selectedWorktreePath, fileTree, loadFileTree])
```

This `useEffect` runs when the dialog opens. If the file tree for the current worktree hasn't been loaded yet (is `EMPTY_TREE`), it triggers `loadFileTree()`. The store update causes `fileTree` to re-derive, which causes `allFiles` to re-compute, and the search results populate.

The identity check `fileTree === EMPTY_TREE` works because `EMPTY_TREE` is a module-level constant (line 66), so the reference is stable.

#### 10.4 Files to Modify

| File                                                           | Change                                               |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| `src/renderer/src/components/file-search/FileSearchDialog.tsx` | Add `useEffect` to load file tree on open when empty |

---

## Files to Modify — Full Summary

### New Files

None — all changes are modifications to existing files.

### Modified Files

| File                                                             | Features | Change Summary                                                         |
| ---------------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `src/main/db/schema.ts`                                          | 1        | Add migration v8: `custom_icon TEXT` column on projects                |
| `src/main/db/types.ts`                                           | 1        | Add `custom_icon` to `Project` and `ProjectUpdate`                     |
| `src/preload/index.d.ts`                                         | 1, 2     | Add `custom_icon` to Project, icon IPC methods, `merge` to gitOps      |
| `src/preload/index.ts`                                           | 1, 2     | Expose icon picker/remove/path methods, `merge()` in gitOps            |
| `src/main/ipc/project-handlers.ts`                               | 1        | Add `project:pickIcon`, `project:removeIcon`, `project:getIconPath`    |
| `src/renderer/src/components/projects/LanguageIcon.tsx`          | 1        | Add `customIcon` prop, render `<img>` from resolved file path          |
| `src/renderer/src/components/projects/ProjectItem.tsx`           | 1        | Pass `project.custom_icon` to LanguageIcon                             |
| `src/renderer/src/components/projects/ProjectSettingsDialog.tsx` | 1        | Add icon picker section with file picker and clear button              |
| `src/main/services/git-service.ts`                               | 2, 3     | Add `merge()` method, emit dual entries for staged+unstaged files      |
| `src/main/ipc/git-file-handlers.ts`                              | 2        | Add `git:merge` IPC handler                                            |
| `src/renderer/src/components/git/GitPushPull.tsx`                | 2        | Add merge UI section with branch input and merge button                |
| `src/renderer/src/stores/useGitStore.ts`                         | 2        | Add `merge` action wrapping `window.gitOps.merge()`                    |
| `src/renderer/src/components/sessions/QuestionPrompt.tsx`        | 4        | Remove auto-submit, always show Submit button for single questions     |
| `src/renderer/src/stores/useWorktreeStore.ts`                    | 5        | Add `worktreeOrderByProject`, `reorderWorktrees`, custom ordering      |
| `src/renderer/src/components/worktrees/WorktreeList.tsx`         | 5        | Pass `index` and `onReorder` to WorktreeItem                           |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx`         | 5, 9     | Add drag handlers, two-line layout with status text                    |
| `src/renderer/src/components/sessions/SessionView.tsx`           | 6, 7, 9  | Instant scroll on entry, wider input, resize on session switch, status |
| `src/main/services/notification-service.ts`                      | 8        | Add dock badge increment/clear on focus                                |
| `src/renderer/src/stores/useWorktreeStatusStore.ts`              | 9        | Extend status types: `'planning'`, `'answering'`                       |
| `src/renderer/src/components/file-search/FileSearchDialog.tsx`   | 10       | Load file tree on dialog open when tree is empty                       |

---

## Dependencies to Add

```bash
# No new runtime dependencies required.
# Custom icon: uses native Electron dialog.showOpenDialog + fs.copyFileSync.
# Drag-and-drop: uses native HTML5 drag events (same pattern as SessionTabs).
# Dock badge: uses built-in Electron app.dock API.
```

---

## Non-Functional Requirements

| Requirement                           | Target                                                          |
| ------------------------------------- | --------------------------------------------------------------- |
| Custom icon render                    | < 16ms from store update to icon display                        |
| Icon file picker open                 | < 200ms from click to native file dialog visible                |
| Icon file copy                        | < 100ms for typical icon files (< 1MB)                          |
| Git merge execution                   | < 10s for typical branch merge (project-dependent)              |
| Merge conflict detection              | Immediate — reported in merge response, no second round-trip    |
| File status dual entry accuracy       | 100% of files with staged+unstaged changes shown in both panels |
| Question Submit button response       | < 50ms from click to answer sent                                |
| Worktree drag reorder visual feedback | < 16ms drag position update (native HTML5 drag)                 |
| Session entry scroll                  | Instant (0ms animation) to bottom on session switch             |
| Input field resize on draft load      | < 1 frame (16ms) from session entry to correct textarea height  |
| Dock badge update latency             | < 50ms from notification to badge visible                       |
| Worktree status text update           | < 16ms from status change to text display                       |
| File search tree load on dialog open  | < 500ms for projects with up to 10,000 files                    |

---

## Out of Scope (Phase 14)

- Custom project icon: image resizing/cropping before saving (stored as-is)
- Custom project icon: per-worktree icons (only per-project)
- Custom project icon: icon packs or built-in icon library (user provides their own image files)
- Git merge: interactive rebase or cherry-pick operations
- Git merge: three-way merge conflict resolution UI (conflicts shown in file list only)
- Git merge: merge commit message customization (uses git default)
- File changes: inline diff comparison between staged and unstaged versions of the same file
- Question tool: undo/edit a submitted answer
- Worktree reordering: cross-project drag (only within a project)
- Worktree reordering: drag to reorder projects themselves
- Auto-scroll: configurable scroll behavior (always instant on entry)
- Input field: resizable by dragging (only auto-resize)
- Dock badge: custom badge icon or notification grouping
- Dock badge: Linux/Windows taskbar badge (macOS dock only)
- Worktree status: custom status text or user-defined states
- Worktree status: progress percentage or ETA for working sessions
- File search: indexing or caching across sessions (loads fresh on each open)

---

## Implementation Priority

### Sprint 1: Quick Fixes (Highest Priority — Small Changes, Big Impact)

1. **Feature 10 — File Search Bug Fix**: Single `useEffect` addition in `FileSearchDialog.tsx`. Fixes a user-facing bug where Cmd+D search is broken until Files tab is visited.
2. **Feature 3 — File Changes Dual Display**: One-line change in `git-service.ts`. Fixes a data accuracy bug where partially-staged files are invisible in the Changes panel.
3. **Feature 6 — Auto-Scroll on Session Entry**: One-line addition in the session switch effect. Eliminates disorientation when entering sessions with history.
4. **Feature 4 — Question Submit Confirmation**: Small refactor in `QuestionPrompt.tsx`. Prevents accidental answer submission.

### Sprint 2: UX Improvements (High Priority — Better Daily Workflow)

5. **Feature 7 — Better Input Field**: Two small changes in `SessionView.tsx`. Wider input and correct draft height.
6. **Feature 8 — Dock Badge Notifications**: Small addition to `notification-service.ts`. Gives users visibility into pending completions.
7. **Feature 9 — Worktree Status Bar**: Extended store types + two-line layout. Rich status context at a glance.

### Sprint 3: Feature Additions (Medium Priority — New Capabilities)

8. **Feature 2 — Git Merge From**: New git operation with IPC + UI. Enables merging latest changes from another branch.
9. **Feature 1 — Custom Project Icon**: DB migration + settings UI + icon rendering. Per-project visual customization.
10. **Feature 5 — Worktree Drag Reorder**: Store + drag handlers. Custom sidebar organization.

---

## Success Metrics

- Picking a custom image file (SVG/PNG/JPG) in Project Settings renders that image in place of the language icon in the sidebar
- Clearing the custom icon restores the default language-based icon
- Custom icon persists across app restarts (stored in database)
- "Merge from" button appears in the git panel below push/pull
- Merge defaults to the default branch name (main/master)
- User can edit the merge source branch to any branch name
- Successful merge shows a success toast and refreshes file statuses
- Merge conflicts show an error toast with conflict count, and conflicted files appear with status 'C'
- A file with both staged and unstaged changes appears in both the "Staged Changes" and "Changes" sections simultaneously
- Staging the unstaged entry stages the remaining changes; unstaging the staged entry moves them back
- Clicking an option in a single-question prompt selects it (highlights) but does not submit
- A "Submit" button is always visible for single-question prompts
- Only clicking "Submit" sends the answer
- Multi-question auto-advance behavior is unchanged
- Worktrees can be dragged and dropped to reorder within a project
- Default worktree stays pinned at the top and cannot be dragged
- Custom worktree order persists across app restarts
- Entering a session scrolls instantly to the bottom without animation
- No visible scroll animation occurs when switching between sessions
- The message input field is wider (max-w-4xl instead of max-w-3xl)
- Entering a session with a pre-populated draft shows the textarea at the correct height immediately
- Each notification increments the macOS dock badge by 1
- Focusing the app window clears the dock badge to empty
- Multiple notifications while unfocused show cumulative count (e.g., "3")
- Worktree rows show a second line with status text when active
- "Working" appears when a session is busy in build mode
- "Planning" appears when a session is busy in plan mode
- "Answer questions" appears when a session has a pending question
- "Archiving" appears during the archive process
- No second line appears when the worktree is idle
- File search (Cmd+D) returns results immediately without visiting the Files tab first
- File search works on first use after app launch with a selected worktree

---

## Testing Plan

### Test Files to Create

| File                                                     | Features | Tests                                                            |
| -------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `test/phase-14/session-1/custom-project-icon.test.ts`    | 1        | Image icon render priority, file copy, clear restores default    |
| `test/phase-14/session-2/git-merge.test.ts`              | 2        | Merge success, conflict handling, branch input, refresh on merge |
| `test/phase-14/session-3/file-changes-dual.test.ts`      | 3        | Dual entries for staged+unstaged, correct panel assignment       |
| `test/phase-14/session-4/question-no-autosubmit.test.ts` | 4        | Click selects but doesn't submit, Submit button always visible   |
| `test/phase-14/session-5/worktree-drag-reorder.test.ts`  | 5        | Drag handlers, order persistence, default pinned                 |
| `test/phase-14/session-6/session-entry-scroll.test.ts`   | 6        | Instant scroll on session switch, no smooth animation            |
| `test/phase-14/session-7/input-field.test.ts`            | 7        | Wider container class, textarea height on draft load             |
| `test/phase-14/session-8/dock-badge.test.ts`             | 8        | Badge increment on notification, clear on focus                  |
| `test/phase-14/session-9/worktree-status-bar.test.ts`    | 9        | Status text rendering, priority order, two-line layout           |
| `test/phase-14/session-10/file-search-fix.test.ts`       | 10       | Tree loads on dialog open, search works without Files tab visit  |
