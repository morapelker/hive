# Hive — Phase 13 Product Requirements Document

## Overview

**Phase 13** focuses on **markdown rendering fixes, diff view readability, non-git repository onboarding, header UX redesign, project refresh, selection consistency, and streaming thinking block behavior**. The work spans eight items: fixing code block rendering in the markdown formatter so tree-structure text and language-less fenced blocks preserve whitespace, improving diff view colors for better readability with dark text on colored backgrounds, prompting users with a modal when opening a non-git directory with an option to initialize a repository, replacing the quick-actions dropdown with individual buttons for one-click access, redesigning the header to show a logo with the active project and branch name, adding a refresh action to the project context menu, auto-highlighting parent projects when selecting worktrees/sessions, and auto-expanding thinking blocks during streaming with auto-collapse on completion.

### Phase 13 Goals

- Fix markdown code block rendering so fenced blocks without a language specifier (bare ` ``` `) preserve newlines and whitespace instead of collapsing to a single line
- Improve diff view color contrast by using dark-colored text on colored backgrounds (dark green text on green bg, dark red text on red bg) instead of light/white text
- Show a modal dialog when a user tries to add a non-git directory, offering to run `git init --initial-branch=main` or abort
- Replace the QuickActions split-button dropdown with individual icon buttons (Cursor, Ghostty, Copy Path, Finder) spread horizontally for one-click access
- Replace the "Hive" text title in the header with the app logo and display the active project name with branch in parentheses, e.g. `tedooo-website (lisbon)`
- Add a "Refresh Project" action to the project context menu that re-syncs worktree branch names from `git worktree list` output
- Auto-highlight parent project items when a child worktree or session is selected, eliminating the visual inconsistency of independent selection states
- Auto-expand thinking/reasoning blocks while they are actively streaming, then auto-collapse them once the streaming completes

---

## Technical Additions

| Component                  | Technology                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| Markdown Code Block Fix    | Modified `code` component override in `MarkdownRenderer.tsx` — multi-line content detection   |
| Diff Color Improvements    | CSS overrides in `globals.css` for diff2html, Tailwind class updates in `EditToolView.tsx`    |
| Git Init Dialog            | New `GitInitDialog.tsx` modal, new `git:init` IPC handler, modified `AddProjectButton` flow   |
| Individual Quick Actions   | Rewritten `QuickActions.tsx` — horizontal button row replacing split-button dropdown          |
| Header Branding Redesign   | Modified `Header.tsx` — logo SVG component + reactive project/branch display from stores      |
| Project Refresh            | New context menu item in `ProjectItem.tsx`, calls existing `syncWorktrees()` store action     |
| Selection Auto-Propagation | Modified `WorktreeItem.tsx` to call `selectProject()`, effect in sidebar for session→worktree |
| Streaming Thinking Blocks  | Modified `ReasoningBlock.tsx` with `isStreaming` prop, auto-expand/collapse via `useEffect`   |

---

## Features

### 1. Markdown Code Block Rendering Fix

#### 1.1 Current State

The `MarkdownRenderer` in `src/renderer/src/components/sessions/MarkdownRenderer.tsx` uses `react-markdown` with `remark-gfm` and custom component overrides. The `code` component override (lines 55-67) only renders content as a block-level `CodeBlock` when the `className` contains a `language-*` pattern:

```tsx
code: ({ className, children }) => {
  const match = /language-(\w+)/.exec(className || '')
  const isBlock = match !== null  // Only true when language is specified

  if (isBlock) {
    const code = String(children).replace(/\n$/, '')
    return <CodeBlock code={code} language={match![1]} />
  }

  return (
    <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
  )
},
pre: ({ children }) => <>{children}</>
```

**The problem chain:**

1. Tree-structure content is typically written inside bare fenced blocks (` ``` ` with no language):

   ````
   ```
   test/
   ├── phase-12/
   │   ├── session-1/
   │   │   └── context-calculation.test.ts
   ```
   ````

2. `react-markdown` emits `<pre><code>...tree content...</code></pre>` — no `className` on the `<code>` tag

3. The custom `pre` override **strips the `<pre>` wrapper entirely**: `pre: ({ children }) => <>{children}</>`

4. The custom `code` override runs the regex — no match — `isBlock` is `false`

5. Falls through to **inline code rendering**: `<code className="bg-muted ...">` with no `white-space: pre`

6. Without a `<pre>` ancestor or `white-space: pre` CSS, the browser **collapses all whitespace and newlines**, rendering the tree on a single line

This affects all fenced code blocks without a language specifier — tree structures, plain text, ASCII art, configuration snippets, etc.

#### 1.2 New Design

```
Fix Strategy:

  Detect block-level code even without a language specifier by checking
  if the content contains newline characters. Multi-line content inside
  a <code> element is always block-level (inline code never has newlines).

  Detection logic:
  1. First check: does className contain language-*? → block with that language
  2. Second check: does String(children) contain '\n'? → block with 'text' language
  3. Neither → inline code (single backtick)

  This is a reliable heuristic because:
  - react-markdown only produces multi-line <code> children for fenced blocks
  - Inline code (single backtick) never contains literal newlines
  - Edge case: a fenced block with a single line still works (no \n → inline style,
    which is visually equivalent to a code block with one line)
```

#### 1.3 Implementation

**MarkdownRenderer.tsx — Modified `code` component override:**

```tsx
code: ({ className, children }) => {
  const match = /language-(\w+)/.exec(className || '')
  const content = String(children)
  // Block detection: has language class OR contains newlines (fenced block without language)
  const isBlock = match !== null || content.includes('\n')

  if (isBlock) {
    const code = content.replace(/\n$/, '')
    return <CodeBlock code={code} language={match?.[1] ?? 'text'} />
  }

  return <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
}
```

The only changes are:

1. Extract `content = String(children)` before the check
2. Change `isBlock` condition to `match !== null || content.includes('\n')`
3. Use `match?.[1] ?? 'text'` instead of `match![1]` for the language (falls back to `'text'` for bare fenced blocks)

The `pre` override remains unchanged — `CodeBlock` provides its own `<pre>` wrapper.

#### 1.4 Files to Modify

| File                                                        | Change                                                |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `src/renderer/src/components/sessions/MarkdownRenderer.tsx` | Update `code` component to detect multi-line as block |

---

### 2. Diff View Color Improvements

#### 2.1 Current State

There are two diff rendering systems with readability issues:

**A. diff2html-based diffs** (`DiffViewer.tsx`, styled via `globals.css` lines 135-222):

Dark mode uses semi-transparent green/red backgrounds but **does not override text color**. The text inherits the default foreground color (light/white), creating poor contrast — white text on green background is hard to read.

```css
.dark .diff-viewer .d2h-ins {
  background-color: rgba(46, 160, 67, 0.15);
}
.dark .diff-viewer .d2h-ins .d2h-code-line-ctn {
  background-color: rgba(46, 160, 67, 0.25);
}
/* No text color override — inherits white/light foreground */
```

**B. EditToolView inline diffs** (`EditToolView.tsx`):

Uses `text-green-300` (light green, `#86efac`) on `bg-green-500/10` and `text-red-300` (light red, `#fca5a5`) on `bg-red-500/10`. While readable, the light text on subtle background lacks the modern GitHub-style appearance where added/removed text uses darker, more saturated colors.

```tsx
<span className="text-green-300 whitespace-pre-wrap break-all">{line}</span>  // Added
<span className="text-red-300 whitespace-pre-wrap break-all">{line}</span>    // Removed
```

#### 2.2 New Design

```
Modern Diff Color Scheme:

  Goal: Dark, saturated text on subtle colored backgrounds.
  Reference: GitHub's modern dark mode diff styling.

  Added lines (green):
    Background: rgba(46, 160, 67, 0.15)  — keep existing
    Text:       #3fb950 (green-500-ish)   — dark green, high contrast
    +/- sign:   #3fb950                   — match text

  Removed lines (red):
    Background: rgba(248, 81, 73, 0.15)  — keep existing
    Text:       #f85149 (red-400-ish)     — dark red, high contrast
    +/- sign:   #f85149                   — match text

  Light mode:
    Added:   dark green text (#1a7f37) on light green bg (#dafbe1)
    Removed: dark red text (#cf222e) on light red bg (#ffebe9)

  This applies to BOTH diff systems:
  1. diff2html (globals.css overrides)
  2. EditToolView (Tailwind classes)
```

#### 2.3 Implementation

**globals.css — Add text color overrides for diff2html:**

```css
/* Dark mode — added lines: dark green text on green background */
.dark .diff-viewer .d2h-ins .d2h-code-line-ctn {
  background-color: rgba(46, 160, 67, 0.15);
  color: #3fb950;
}

/* Dark mode — removed lines: dark red text on red background */
.dark .diff-viewer .d2h-del .d2h-code-line-ctn {
  background-color: rgba(248, 81, 73, 0.15);
  color: #f85149;
}

/* Light mode — added lines */
.diff-viewer .d2h-ins .d2h-code-line-ctn {
  color: #1a7f37;
}

/* Light mode — removed lines */
.diff-viewer .d2h-del .d2h-code-line-ctn {
  color: #cf222e;
}
```

**EditToolView.tsx — Update Tailwind classes:**

```tsx
{/* Removed lines — change text-red-300 to text-red-400 */}
<span className="text-red-400 select-none shrink-0 w-4">-</span>
<span className="text-red-400 whitespace-pre-wrap break-all">{line || ' '}</span>

{/* Added lines — change text-green-300 to text-green-400 */}
<span className="text-green-400 select-none shrink-0 w-4">+</span>
<span className="text-green-400 whitespace-pre-wrap break-all">{line || ' '}</span>
```

Note: `text-green-400` is `#4ade80` and `text-red-400` is `#f87171` — darker and more saturated than the current 300 variants, providing better contrast on the subtle backgrounds.

#### 2.4 Files to Modify

| File                                                          | Change                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| `src/renderer/src/styles/globals.css`                         | Add text color overrides for `.d2h-ins` and `.d2h-del` |
| `src/renderer/src/components/sessions/tools/EditToolView.tsx` | Update green/red text classes from 300 to 400 variants |

---

### 3. Non-Git Repository Initialization Dialog

#### 3.1 Current State

When a user selects a non-git directory via the "Add Project" flow, the validation in `project-handlers.ts` (lines 68-88) checks for a `.git` directory and returns a failure:

```typescript
if (!isGitRepository(path)) {
  return {
    success: false,
    error:
      'The selected folder is not a Git repository. Please select a folder containing a .git directory.'
  }
}
```

The `AddProjectButton.tsx` (lines 24-42) receives this error and shows a toast notification. There is no option to initialize a git repository — the user must manually run `git init` elsewhere and retry.

The `useProjectStore.addProject()` (lines 73-121) calls `validateProject()` and returns early on failure without any recovery path.

#### 3.2 New Design

```
Non-Git Repository Flow:

  1. User selects a directory via the folder picker
  2. Validation runs — if NOT a git repository:
     a. Instead of showing an error toast, show a modal dialog
     b. Dialog content:
        ┌─────────────────────────────────────────────────────────┐
        │  Not a Git Repository                                   │
        │                                                         │
        │  The selected folder is not a Git repository:           │
        │  /Users/name/my-project                                 │
        │                                                         │
        │  Would you like to initialize a new Git repository?     │
        │                                                         │
        │              [Cancel]    [Initialize Repository]        │
        └─────────────────────────────────────────────────────────┘
     c. "Cancel" → close dialog, do nothing
     d. "Initialize Repository" →
        i.   Run `git init --initial-branch=main` in the selected directory
        ii.  If successful, proceed with addProject() flow (re-validate → create)
        iii. If failed, show error toast
  3. The rest of the add-project flow continues normally

  IPC additions:
  - New channel: `git:init` → runs `git init --initial-branch=main` in the given path
  - Exposed as: `window.projectOps.initRepository(path)`
```

#### 3.3 Implementation

**New IPC handler in `project-handlers.ts`:**

```typescript
ipcMain.handle(
  'git:init',
  async (_event, path: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await execAsync(`git init --initial-branch=main`, { cwd: path })
      return { success: true }
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
initRepository: (path: string): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('git:init', path)
```

**Type declaration (`preload/index.d.ts`):**

```typescript
// In ProjectOps interface:
initRepository(path: string): Promise<{ success: boolean; error?: string }>
```

**New `GitInitDialog.tsx`:**

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

interface GitInitDialogProps {
  open: boolean
  path: string
  onCancel: () => void
  onConfirm: () => void
}

export function GitInitDialog({ open, path, onCancel, onConfirm }: GitInitDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Not a Git Repository</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <p>The selected folder is not a Git repository:</p>
            <p className="font-mono text-xs bg-muted rounded px-2 py-1 break-all">{path}</p>
            <p>Would you like to initialize a new Git repository?</p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Initialize Repository</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

**Modified `AddProjectButton.tsx` flow:**

```tsx
const [gitInitPath, setGitInitPath] = useState<string | null>(null)

const handleAddProject = async () => {
  const path = await window.projectOps.openDirectoryDialog()
  if (!path) return

  const result = await addProject(path)
  if (result.success) return

  // Check if the error is about not being a git repo
  if (result.error?.includes('not a Git repository')) {
    setGitInitPath(path) // Open the dialog
    return
  }

  toast.error(result.error || 'Failed to add project')
}

const handleInitRepository = async () => {
  if (!gitInitPath) return
  const initResult = await window.projectOps.initRepository(gitInitPath)
  if (!initResult.success) {
    toast.error(initResult.error || 'Failed to initialize repository')
    setGitInitPath(null)
    return
  }
  // Retry adding the project
  const addResult = await addProject(gitInitPath)
  if (!addResult.success) {
    toast.error(addResult.error || 'Failed to add project')
  }
  setGitInitPath(null)
}

// In JSX:
;<GitInitDialog
  open={!!gitInitPath}
  path={gitInitPath || ''}
  onCancel={() => setGitInitPath(null)}
  onConfirm={handleInitRepository}
/>
```

**Modified `useProjectStore.addProject()`:**

The store's `addProject` method needs to return the specific error string so `AddProjectButton` can distinguish "not a git repo" from other errors. The current implementation already returns `{ success: false, error: string }`, so no store changes are needed.

#### 3.4 Files to Modify

| File                                                        | Change                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `src/main/ipc/project-handlers.ts`                          | Add `git:init` IPC handler                               |
| `src/preload/index.ts`                                      | Expose `initRepository()` in `projectOps` namespace      |
| `src/preload/index.d.ts`                                    | Add `initRepository` type declaration                    |
| `src/renderer/src/components/projects/GitInitDialog.tsx`    | **New file** — AlertDialog for git init confirmation     |
| `src/renderer/src/components/projects/AddProjectButton.tsx` | Show GitInitDialog on non-git error, handle init + retry |

---

### 4. Individual Quick Action Buttons

#### 4.1 Current State

The `QuickActions` component in `src/renderer/src/components/layout/QuickActions.tsx` (165 lines) renders a **split button** pattern: the left part shows and executes the last-used action, the right part opens a dropdown with all four actions (Cursor, Ghostty, Copy Path, Finder).

This requires two clicks to access any action that isn't the last-used one: one to open the dropdown, one to select. On desktop screens where horizontal space is available, individual buttons would be faster.

The current ACTIONS array defines four items:

```typescript
const ACTIONS: ActionConfig[] = [
  { id: 'cursor', label: 'Cursor', icon: <CursorIcon /> },
  { id: 'ghostty', label: 'Ghostty', icon: <GhosttyIcon /> },
  { id: 'copy-path', label: 'Copy Path', icon: <Copy /> },
  { id: 'finder', label: 'Finder', icon: <FolderOpen /> }
]
```

#### 4.2 New Design

```
Individual Quick Action Buttons:

  Layout in the header center:
  ┌──────────────────────────────────────────────────────┐
  │  [Logo] project (branch)   [Cursor] [Ghostty] [📋] [📂]  [⏱] [⚙] [▐] │
  └──────────────────────────────────────────────────────┘

  Each action is a standalone ghost button with icon + label:
  - Cursor:    CursorIcon + "Cursor"
  - Ghostty:   GhosttyIcon + "Ghostty"
  - Copy Path: Copy icon (shows Check + "Copied" for 1.5s after click)
  - Finder:    FolderOpen icon + "Finder"

  Behavior:
  - Each button executes its action directly on click (one click)
  - All buttons disabled when no worktree is selected
  - No dropdown, no split button, no "last used" tracking needed
  - Compact styling: small ghost buttons with gap-1

  The `lastOpenAction` setting in useSettingsStore becomes unused
  for this component but can be kept for backward compatibility.
```

#### 4.3 Implementation

**Rewritten `QuickActions.tsx`:**

```tsx
export function QuickActions(): React.JSX.Element | null {
  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()
  const [copied, setCopied] = useState(false)

  const worktreePath = (() => {
    if (!selectedWorktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const worktree = worktrees.find((w) => w.id === selectedWorktreeId)
      if (worktree) return worktree.path
    }
    return null
  })()

  const disabled = !worktreePath

  const handleAction = useCallback(
    async (actionId: QuickActionType) => {
      if (!worktreePath) return
      try {
        if (actionId === 'copy-path') {
          await window.projectOps.copyToClipboard(worktreePath)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } else if (actionId === 'finder') {
          await window.projectOps.showInFolder(worktreePath)
        } else {
          await window.systemOps.openInApp(actionId, worktreePath)
        }
      } catch (error) {
        console.error('Quick action failed:', error)
      }
    },
    [worktreePath]
  )

  return (
    <div className="flex items-center gap-1" data-testid="quick-actions">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs"
        disabled={disabled}
        onClick={() => handleAction('cursor')}
        title="Open in Cursor"
        data-testid="quick-action-cursor"
      >
        <CursorIcon className="h-3.5 w-3.5" />
        <span>Cursor</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs"
        disabled={disabled}
        onClick={() => handleAction('ghostty')}
        title="Open in Ghostty"
        data-testid="quick-action-ghostty"
      >
        <GhosttyIcon className="h-3.5 w-3.5" />
        <span>Ghostty</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled}
        onClick={() => handleAction('copy-path')}
        title="Copy Path"
        data-testid="quick-action-copy-path"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled}
        onClick={() => handleAction('finder')}
        title="Reveal in Finder"
        data-testid="quick-action-finder"
      >
        <FolderOpen className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
```

Key changes:

- Remove `DropdownMenu` and `DropdownMenuTrigger/Content/Item` imports
- Remove `lastOpenAction` / `updateSetting` usage
- Remove split-button pattern
- Cursor and Ghostty get icon + label buttons (branded, identifiable)
- Copy Path and Finder get icon-only buttons (universally recognized icons)
- Remove `ChevronDown`, `ExternalLink` imports (no longer needed)

#### 4.4 Files to Modify

| File                                                  | Change                                                   |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `src/renderer/src/components/layout/QuickActions.tsx` | Rewrite from split-button dropdown to individual buttons |

---

### 5. Header Branding Redesign (Logo + Project/Branch)

#### 5.1 Current State

The `Header` component in `src/renderer/src/components/layout/Header.tsx` (68 lines) has this left section:

```tsx
<div className="w-16 flex-shrink-0" />  {/* macOS traffic light spacer */}
<div className="flex items-center gap-2 flex-1">
  <h1 className="text-lg font-semibold">Hive</h1>
</div>
```

There is no logo component or image — just a text `<h1>`. No project or branch name is displayed in the header. The app icon exists at `resources/icon.png` but is not used as an in-app logo. Project and branch information is only visible in the left sidebar.

#### 5.2 New Design

```
Header Left Section:

  ┌─[traffic lights]─ [🐝] tedooo-website (lisbon) ──── ... ─┐

  Components:
  1. macOS traffic light spacer (keep existing w-16)
  2. App logo — small inline SVG or <img> from resources, ~20x20px
  3. Project name — from useProjectStore.selectedProjectId → project.name
  4. Branch name in parentheses — from useWorktreeStore.selectedWorktreeId → worktree.branch_name
  5. Format: "{projectName} ({branchName})" in text-sm font-medium

  Reactive updates:
  - When selectedProjectId changes → project name updates
  - When selectedWorktreeId changes → branch name updates
  - When branch is renamed (via auto-rename or manual) → branch name updates
    (already handled by store reactivity since worktree data refreshes)
  - When no project selected → show "Hive" as fallback
  - When no worktree selected → show just project name without parenthetical

  Logo source:
  - Create an inline SVG component `HiveLogo` or use the existing icon.png
    rendered as a small <img> tag
  - Prefer SVG for crisp rendering at small sizes and theme adaptability
```

#### 5.3 Implementation

**Header.tsx — Replace title with logo + project/branch:**

```tsx
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

// Inside Header component:
const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
const projects = useProjectStore((s) => s.projects)
const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()

const selectedProject = projects.find((p) => p.id === selectedProjectId)
const selectedWorktree = (() => {
  if (!selectedWorktreeId) return null
  for (const worktrees of worktreesByProject.values()) {
    const wt = worktrees.find((w) => w.id === selectedWorktreeId)
    if (wt) return wt
  }
  return null
})()

// In JSX — replace the <h1>Hive</h1> section:
<div className="flex items-center gap-2 flex-1 min-w-0">
  <img
    src="hive-logo.svg"  // or inline SVG component
    alt="Hive"
    className="h-5 w-5 shrink-0"
  />
  {selectedProject ? (
    <span className="text-sm font-medium truncate">
      {selectedProject.name}
      {selectedWorktree?.branch_name && (
        <span className="text-muted-foreground font-normal">
          {' '}({selectedWorktree.branch_name})
        </span>
      )}
    </span>
  ) : (
    <span className="text-sm font-medium">Hive</span>
  )}
</div>
```

**Logo asset:**

Create an SVG logo component or import the existing `resources/icon.png`. For best results, create a `HiveLogo` inline SVG component in `Header.tsx` or a separate `HiveLogo.tsx` file. The SVG should be simple (the bee/hexagon icon from the app icon) and support `currentColor` for theme adaptability.

Alternatively, copy the app icon to the renderer's `public/` or `assets/` directory and reference it as an `<img>` tag.

#### 5.4 Files to Modify

| File                                            | Change                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `src/renderer/src/components/layout/Header.tsx` | Replace `<h1>Hive</h1>` with logo + project/branch display        |
| `src/renderer/src/assets/hive-logo.svg`         | **New file** — SVG logo asset (or inline SVG component in Header) |

---

### 6. Refresh Project (Context Menu Action)

#### 6.1 Current State

The project context menu in `ProjectItem.tsx` (lines 266-299) has seven items but no refresh/sync action. The worktree sync (`syncWorktrees()` in `useWorktreeStore.ts` lines 316-324) only runs automatically when `WorktreeList` mounts (on project expand). There is no way for users to manually trigger a re-sync of worktrees with the actual git state.

The `syncWorktrees()` action already exists and works correctly:

```typescript
syncWorktrees: async (projectId: string, projectPath: string) => {
  try {
    await window.worktreeOps.sync({ projectId, projectPath })
    await get().loadWorktrees(projectId)
  } catch {
    // Ignore sync errors
  }
}
```

The backend `worktree:sync` handler (in `worktree-handlers.ts` lines 189-215) compares git worktrees with the database: it archives missing worktrees and updates renamed branches by matching worktree paths to branch names from `git worktree list --porcelain` output.

#### 6.2 New Design

```
Refresh Project Action:

  Right-click project → context menu:
  ┌──────────────────────┐
  │ Edit Name            │
  │ Open in Finder       │
  │ Copy Path            │
  │ Refresh Language     │
  │ Refresh Project      │  ← NEW
  │ New Workspace From...│
  │ Project Settings     │
  │ ──────────────────── │
  │ Remove from Hive     │
  └──────────────────────┘

  Behavior:
  1. User clicks "Refresh Project"
  2. Calls syncWorktrees(projectId, projectPath)
     - This runs git worktree list, compares with DB
     - Archives worktrees whose paths no longer exist on disk
     - Updates branch names that were renamed externally
  3. Show a brief success toast: "Project refreshed"
  4. Worktree list in sidebar updates automatically (store reactivity)

  Icon: RefreshCw (already imported for "Refresh Language")
```

#### 6.3 Implementation

**ProjectItem.tsx — Add context menu item:**

```tsx
const handleRefreshProject = async () => {
  await syncWorktrees(project.id, project.path)
  toast.success('Project refreshed')
}

// In ContextMenuContent, after "Refresh Language":
;<ContextMenuItem onClick={handleRefreshProject}>
  <RefreshCw className="h-4 w-4 mr-2" />
  Refresh Project
</ContextMenuItem>
```

The `syncWorktrees` action is already available from `useWorktreeStore`. It just needs to be destructured at the top of the component and called from the new menu item.

#### 6.4 Files to Modify

| File                                                   | Change                                  |
| ------------------------------------------------------ | --------------------------------------- |
| `src/renderer/src/components/projects/ProjectItem.tsx` | Add "Refresh Project" context menu item |

---

### 7. Selection Highlighting Auto-Propagation

#### 7.1 Current State

The selection system uses three independent Zustand stores:

| Store              | State Property       | Set by                   |
| ------------------ | -------------------- | ------------------------ |
| `useProjectStore`  | `selectedProjectId`  | Clicking a project item  |
| `useWorktreeStore` | `selectedWorktreeId` | Clicking a worktree item |
| `useSessionStore`  | `activeSessionId`    | Clicking a session tab   |

These operate independently with **no upward propagation**:

- Clicking a **worktree** sets `selectedWorktreeId` but does NOT call `selectProject()` on its parent project
- Clicking a **session tab** sets `activeSessionId` but does NOT update `selectedWorktreeId` or `selectedProjectId`

The result: a user can have "Project A" highlighted in the sidebar while working in a worktree that belongs to "Project B". This is visually confusing.

#### 7.2 New Design

```
Selection Propagation Rules:

  Selecting a worktree → also selects its parent project:
  1. User clicks WorktreeItem
  2. selectWorktree(worktree.id) is called (existing)
  3. NEW: selectProject(worktree.project_id) is also called
  4. Parent project row highlights with bg-accent

  Selecting a session → already scoped to active worktree (no change needed):
  - Sessions only appear for the currently selected worktree
  - The session tab bar is rendered based on activeWorktreeId
  - Selecting a session does not change the worktree, so the
    project/worktree highlighting is already correct

  Edge case — clicking a project (expand/collapse):
  - Keep current behavior: selectProject + toggleExpanded
  - Do NOT auto-select a worktree (user may just want to expand/collapse)

  This is a minimal change: only WorktreeItem.handleClick needs
  an additional selectProject() call.
```

#### 7.3 Implementation

**WorktreeItem.tsx — Add parent project selection:**

```tsx
const selectProject = useProjectStore((s) => s.selectProject)

const handleClick = (): void => {
  selectWorktree(worktree.id)
  // Auto-highlight parent project
  selectProject(worktree.project_id)
  useWorktreeStatusStore.getState().clearWorktreeUnread(worktree.id)
}
```

The `worktree.project_id` field is available on the `Worktree` type (from `index.d.ts`). The `selectProject` action sets `selectedProjectId` and calls `touchProject()` to update `last_accessed_at`.

This single line addition ensures that when a user clicks any worktree, its parent project is always highlighted in the sidebar. The expand state is not affected — the project stays expanded (it must already be expanded for the worktree to be visible and clickable).

#### 7.4 Files to Modify

| File                                                     | Change                                                    |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Add `selectProject(worktree.project_id)` in `handleClick` |

---

### 8. Streaming Thinking Block Auto-Expand/Collapse

#### 8.1 Current State

The `ReasoningBlock` component in `src/renderer/src/components/sessions/ReasoningBlock.tsx` (53 lines) uses `useState(false)` — it always starts collapsed. There is no streaming awareness:

```tsx
export function ReasoningBlock({ text }: ReasoningBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  // ... renders collapsed preview or expanded content
}
```

The `AssistantCanvas.renderParts()` function has access to `isStreaming` (passed as a parameter) but does not forward it to `ReasoningBlock`:

```tsx
if (part.type === 'reasoning' && part.reasoning) {
  renderedParts.push(<ReasoningBlock key={`reasoning-${index}`} text={part.reasoning} />)
  // Note: isStreaming is available but not passed
}
```

Users must manually click to expand thinking blocks to see the reasoning in progress. Once streaming ends, the block stays in whatever state the user left it — there is no auto-collapse.

#### 8.2 New Design

```
Streaming Thinking Block Behavior:

  Phase 1 — Streaming active, reasoning block receiving text:
  1. Block is auto-expanded (forced open)
  2. Content updates in real-time as reasoning deltas arrive
  3. User CAN manually collapse it (user override takes priority)
  4. If user has not manually overridden, block stays expanded

  Phase 2 — Streaming completes (isStreaming goes false):
  1. If user has NOT manually toggled, auto-collapse the block
  2. If user HAS manually toggled (either direction), respect their choice

  State machine:
  ┌─────────────────┐  isStreaming=true   ┌───────────────────┐
  │   Collapsed      │ ──────────────────► │  Auto-Expanded     │
  │   (default)      │                     │  (streaming)       │
  └─────────────────┘                     └───────────────────┘
                                                    │
                                           isStreaming=false
                                           (no user toggle)
                                                    │
                                                    ▼
                                          ┌───────────────────┐
                                          │  Auto-Collapsed    │
                                          │  (done)            │
                                          └───────────────────┘

  If user clicks toggle at ANY point:
  - Set userOverride = true
  - Use user's chosen state from that point on
  - Do NOT auto-collapse on streaming end

  Props change:
  - Add `isStreaming?: boolean` prop to ReasoningBlock
  - Default to false for persisted (non-streaming) messages
```

#### 8.3 Implementation

**ReasoningBlock.tsx — Add streaming-aware expand/collapse:**

```tsx
import { useState, useEffect, useRef } from 'react'
import { ChevronRight, Brain } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ReasoningBlockProps {
  text: string
  isStreaming?: boolean
}

export function ReasoningBlock({ text, isStreaming = false }: ReasoningBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const userOverrideRef = useRef(false)

  // Auto-expand when streaming starts (if user hasn't overridden)
  useEffect(() => {
    if (isStreaming && !userOverrideRef.current) {
      setIsExpanded(true)
    }
  }, [isStreaming])

  // Auto-collapse when streaming ends (if user hasn't overridden)
  useEffect(() => {
    if (!isStreaming && !userOverrideRef.current) {
      setIsExpanded(false)
    }
  }, [isStreaming])

  // Reset user override when a new streaming session starts
  useEffect(() => {
    if (isStreaming) {
      userOverrideRef.current = false
    }
  }, [isStreaming])

  const handleToggle = () => {
    userOverrideRef.current = true
    setIsExpanded((prev) => !prev)
  }

  const lines = text.split('\n')
  const firstLine = lines[0]?.slice(0, 100) || 'Thinking...'
  const preview = firstLine.length < (lines[0]?.length ?? 0) ? firstLine + '...' : firstLine

  return (
    <div className="my-1 rounded-md bg-muted/30 overflow-hidden" data-testid="reasoning-block">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left hover:bg-muted/50 transition-colors"
        aria-expanded={isExpanded}
        data-testid="reasoning-block-header"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150',
            isExpanded && 'rotate-90'
          )}
        />
        <Brain className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        <span className="text-xs text-muted-foreground italic">
          {isExpanded ? 'Thinking...' : preview}
        </span>
      </button>

      {isExpanded && (
        <div className="border-t border-border/30 px-3 py-2" data-testid="reasoning-block-content">
          <p className="text-xs text-muted-foreground/80 italic whitespace-pre-wrap leading-relaxed font-mono">
            {text}
          </p>
        </div>
      )}
    </div>
  )
}
```

**AssistantCanvas.tsx — Pass `isStreaming` to ReasoningBlock:**

```tsx
if (part.type === 'reasoning' && part.reasoning) {
  renderedParts.push(
    <ReasoningBlock key={`reasoning-${index}`} text={part.reasoning} isStreaming={isStreaming} />
  )
  index += 1
  continue
}
```

Note: `isStreaming` is already a parameter of `renderParts()` — it just needs to be forwarded.

#### 8.4 Files to Modify

| File                                                       | Change                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| `src/renderer/src/components/sessions/ReasoningBlock.tsx`  | Add `isStreaming` prop, auto-expand/collapse with user override |
| `src/renderer/src/components/sessions/AssistantCanvas.tsx` | Pass `isStreaming` to `ReasoningBlock`                          |

---

## Files to Modify — Full Summary

### New Files

| File                                                     | Feature |
| -------------------------------------------------------- | ------- |
| `src/renderer/src/components/projects/GitInitDialog.tsx` | 3       |
| `src/renderer/src/assets/hive-logo.svg`                  | 5       |

### Modified Files

| File                                                          | Features | Change Summary                                                  |
| ------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| `src/renderer/src/components/sessions/MarkdownRenderer.tsx`   | 1        | Detect multi-line content as block-level code                   |
| `src/renderer/src/styles/globals.css`                         | 2        | Add text color overrides for diff2html added/removed lines      |
| `src/renderer/src/components/sessions/tools/EditToolView.tsx` | 2        | Update green/red text classes from 300 to 400 variants          |
| `src/main/ipc/project-handlers.ts`                            | 3        | Add `git:init` IPC handler                                      |
| `src/preload/index.ts`                                        | 3        | Expose `initRepository()` in `projectOps`                       |
| `src/preload/index.d.ts`                                      | 3        | Add `initRepository` type declaration                           |
| `src/renderer/src/components/projects/AddProjectButton.tsx`   | 3        | Show GitInitDialog on non-git error, handle init + retry        |
| `src/renderer/src/components/layout/QuickActions.tsx`         | 4        | Rewrite from split-button dropdown to individual buttons        |
| `src/renderer/src/components/layout/Header.tsx`               | 5        | Replace title with logo + reactive project/branch display       |
| `src/renderer/src/components/projects/ProjectItem.tsx`        | 6        | Add "Refresh Project" context menu item                         |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx`      | 7        | Add `selectProject(worktree.project_id)` in handleClick         |
| `src/renderer/src/components/sessions/ReasoningBlock.tsx`     | 8        | Add `isStreaming` prop, auto-expand/collapse with user override |
| `src/renderer/src/components/sessions/AssistantCanvas.tsx`    | 8        | Pass `isStreaming` to ReasoningBlock                            |

---

## Dependencies to Add

```bash
# No new dependencies — all features use existing packages:
# - react-markdown + remark-gfm (markdown rendering — already installed)
# - diff2html (diff rendering — already installed)
# - lucide-react (icons — already installed)
# - @radix-ui/react-alert-dialog via shadcn (dialogs — already installed)
# - zustand (stores — already installed)
```

---

## Non-Functional Requirements

| Requirement                          | Target                                                               |
| ------------------------------------ | -------------------------------------------------------------------- |
| Markdown code block whitespace       | All fenced blocks preserve newlines regardless of language specifier |
| Diff text readability (WCAG)         | Minimum 4.5:1 contrast ratio for diff text on colored backgrounds    |
| Git init dialog response             | < 100ms from directory selection to dialog appearance                |
| Git init execution                   | < 3s for `git init` on typical directories                           |
| Quick action button click response   | < 50ms from click to action execution start                          |
| Header project/branch update latency | < 16ms (single frame) from store change to display update            |
| Project refresh (sync) duration      | < 2s for projects with up to 20 worktrees                            |
| Selection propagation latency        | < 16ms from worktree click to parent project highlight               |
| Thinking block auto-expand           | < 16ms from first reasoning delta to expanded state                  |
| Thinking block auto-collapse         | < 16ms from isStreaming=false to collapsed state                     |

---

## Out of Scope (Phase 13)

- Markdown renderer: syntax highlighting for language-less code blocks (render as plain `text`)
- Markdown renderer: live editing or split-pane source/preview (covered in Phase 12 for file viewer)
- Diff view: language-aware syntax highlighting within diff content
- Diff view: word-level diff highlighting (character-by-character change detection)
- Git init: configuring initial commit, .gitignore template, or remote repository
- Git init: supporting `git init` with custom branch names (hardcoded to `main`)
- Quick actions: configurable/reorderable button list (fixed set of 4 actions)
- Quick actions: responsive dropdown fallback on narrow windows
- Header: breadcrumb navigation (project > worktree > session)
- Header: clickable project/branch name to switch projects
- Project refresh: auto-refresh on file system changes or timer
- Project refresh: showing a loading spinner during refresh
- Selection: multi-select for projects or worktrees
- Selection: keyboard navigation (arrow keys) in the sidebar
- Thinking blocks: search/filter within thinking content
- Thinking blocks: syntax highlighting within reasoning text
- Thinking blocks: persisting user expand/collapse preference across sessions

---

## Implementation Priority

### Sprint 1: Quick Fixes (Highest Priority — Small Changes, Big Impact)

1. **Feature 1 — Markdown Code Block Fix**: One-line condition change in `MarkdownRenderer.tsx`. Fixes a visible, user-reported rendering bug affecting all language-less code blocks.
2. **Feature 7 — Selection Auto-Propagation**: One-line addition in `WorktreeItem.tsx`. Eliminates a confusing visual inconsistency in the sidebar.
3. **Feature 2 — Diff Color Improvements**: CSS-only changes. Improves readability of a core feature (diff viewing).

### Sprint 2: UX Improvements (High Priority — Better Daily Workflow)

4. **Feature 8 — Streaming Thinking Blocks**: Small component change. Users can see AI reasoning in real-time without manual clicking, and blocks auto-clean-up after completion.
5. **Feature 6 — Refresh Project**: Single menu item addition. Gives users control over worktree sync instead of relying on auto-sync-on-expand.
6. **Feature 4 — Individual Quick Action Buttons**: Simplifies the QuickActions component. One-click access to all actions instead of dropdown navigation.

### Sprint 3: Feature Additions (Medium Priority — New Capabilities)

7. **Feature 5 — Header Branding Redesign**: Visual refresh with functional value (shows active project/branch at a glance).
8. **Feature 3 — Non-Git Repository Dialog**: New onboarding path for non-git directories. Requires IPC addition, dialog component, and flow modification.

---

## Success Metrics

- Fenced code blocks without a language specifier (bare ` ``` `) render with preserved whitespace and newlines, including tree-structure characters (├── └── │)
- Tree-structure text in code blocks displays vertically (one entry per line), not collapsed to a single line
- Diff view added lines show dark green text (#3fb950 dark mode / #1a7f37 light mode) on green background
- Diff view removed lines show dark red text (#f85149 dark mode / #cf222e light mode) on red background
- EditToolView inline diffs use `text-green-400` and `text-red-400` for better contrast
- Selecting a non-git directory opens a confirmation dialog with "Initialize Repository" and "Cancel" options
- Clicking "Initialize Repository" runs `git init --initial-branch=main` and proceeds to add the project on success
- Clicking "Cancel" closes the dialog without adding the project
- Each quick action (Cursor, Ghostty, Copy Path, Finder) is accessible with a single click from the header
- No dropdown menu is required to access any quick action
- The header displays the active project name and branch in parentheses, e.g. `tedooo-website (lisbon)`
- The header display updates within one frame when switching projects, worktrees, or when branches are renamed
- When no project is selected, the header shows the app logo with "Hive" text
- "Refresh Project" appears in the project context menu and successfully re-syncs worktree branch names
- Clicking a worktree in the sidebar highlights both the worktree AND its parent project
- There is never a state where a worktree is selected but a different project is highlighted
- Thinking blocks auto-expand when reasoning text begins streaming
- Thinking blocks auto-collapse when streaming ends (if user hasn't manually toggled)
- Manual expand/collapse toggle still works during and after streaming
- If user manually collapses a thinking block during streaming, it stays collapsed after streaming ends

---

## Testing Plan

### Test Files to Create

| File                                                    | Features | Tests                                                           |
| ------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| `test/phase-13/session-1/markdown-codeblock.test.ts`    | 1        | Block detection for bare fenced blocks, language-less rendering |
| `test/phase-13/session-2/diff-colors.test.ts`           | 2        | EditToolView class assertions for green-400/red-400             |
| `test/phase-13/session-3/git-init-dialog.test.ts`       | 3        | Dialog render, init flow, error handling                        |
| `test/phase-13/session-4/quick-actions.test.ts`         | 4        | Individual buttons render, click handlers, disabled state       |
| `test/phase-13/session-5/header-branding.test.ts`       | 5        | Logo render, project/branch display, fallback text              |
| `test/phase-13/session-6/refresh-project.test.ts`       | 6        | Context menu item presence, syncWorktrees call                  |
| `test/phase-13/session-7/selection-propagation.test.ts` | 7        | Worktree click selects parent project                           |
| `test/phase-13/session-8/streaming-thinking.test.ts`    | 8        | Auto-expand on stream, auto-collapse on end, user override      |
