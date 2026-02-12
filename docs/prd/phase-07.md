# Hive — Phase 7 Product Requirements Document

## Overview

**Phase 7** focuses on **project filtering, branch duplication, code review triggers, inline diff viewing, running-process animations, UX polish, and model variant selection**. The primary work includes a subsequence-based project search with match highlighting, duplicating worktrees with uncommitted state preserved, a one-click code review session, replacing the diff modal with an inline diff viewer supporting context expansion and hunk navigation, a heartbeat ECG animation for worktrees with live processes, auto-focusing the session input, a clear button in the run pane, and grouping model variants with Alt+T toggling.

### Phase 7 Goals
- Add a project filter input with subsequence matching and match highlighting
- Allow duplicating a worktree (branch + uncommitted files) via right-click context menu
- Add a "Review" button that opens a new AI session to code-review current uncommitted changes
- Replace the diff modal with an inline diff viewer supporting context expansion and hunk navigation
- Show a pulsing ECG animation on worktrees with a live running process
- Auto-focus the session text input when entering a session
- Add a clear button to the run pane output
- Group model variants and allow toggling between them with Alt+T

---

## Technical Additions

| Component | Technology |
|-----------|------------|
| Project Filter | Subsequence matching algorithm, React `<input>`, character-level highlight spans |
| Branch Duplication | `simple-git` raw commands, `fs.cpSync` for uncommitted files, auto-versioning logic |
| Code Review | OpenCode SDK `prompt()` with `prompts/review.md` template, `git diff` for change context |
| Inline Diff Viewer | `diff2html` (existing), custom hunk navigation, context expansion via `git diff -U{n}` |
| Running Animation | CSS `@keyframes` ECG pulse animation, SVG sine wave path |
| Model Variants | Model ID parsing (base name + suffix grouping), `Alt+T` keyboard shortcut |

---

## Features

### 1. Project Filter (Subsequence Search)

#### 1.1 Current State
- `ProjectList.tsx` renders all projects in order with no filtering or search capability
- The project sidebar has a header with just a "+" button to add projects
- Projects are displayed as `ProjectItem` components with expand/collapse for worktrees
- Project data includes `name` and `path` fields — both are searchable targets

#### 1.2 New Design

Add a search input at the top of the project sidebar. Typing filters projects using **subsequence matching** (not substring/contains):

```
┌─ Projects ─────────── [+] ┐
│  ┌──────────────────────┐  │
│  │ 🔍 Filter projects... │  │
│  └──────────────────────┘  │
│                             │
│  📦 tedooo-orders          │  ← matches "orders": tedooo-[o][r][d][e][r][s]
│    ⎇ feature-auth          │
│  📦 ordjjrekekqerjskjs     │  ← matches "orders": [o][r][d]jjrekekqe[r]j[s]kjs (not a clean match but letters appear in order)
└─────────────────────────────┘
```

**Subsequence Matching Algorithm**:
- Given query `q` and target string `t`, find if all characters in `q` appear in `t` in order (not necessarily contiguous)
- For query "orders" and target "tedooo-orders": match characters o, r, d, e, r, s appearing in that order
- For query "orders" and target "ordjjrekekqerjskjs": o(0), r(1), d(2), then scan for e → found at position 7 (via 'e' in 'rekekqerjskjs'), r → position 10, s → position 12
- Case-insensitive: lowercase both query and target before matching
- Search both `project.name` AND `project.path` — match on either
- When matched, return the indices of matched characters for highlighting

**Match Highlighting**:
- Matched characters in the project name are rendered with a highlight style (e.g., `font-bold text-primary` or `bg-primary/20 rounded-sm`)
- If the match is on the path (not the name), show the path below the name in a smaller font with highlighted characters

**Behavior**:
- Empty query shows all projects (no filtering)
- Filter updates on every keystroke (debounce not needed — project count is small)
- Pressing Escape clears the filter and removes focus from the input
- The filter input is always visible (not hidden behind a toggle)
- Worktree names and paths are NOT searched — only project name and root path

#### 1.3 Implementation

**Subsequence Match Function**:
```typescript
interface SubsequenceMatch {
  matched: boolean
  indices: number[]  // indices of matched characters in the target string
  score: number      // lower is better — prefer contiguous matches
}

function subsequenceMatch(query: string, target: string): SubsequenceMatch {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const indices: number[] = []
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti)
      qi++
    }
  }
  if (qi < q.length) return { matched: false, indices: [], score: Infinity }
  // Score: sum of gaps between consecutive matches (lower = more contiguous)
  let score = 0
  for (let i = 1; i < indices.length; i++) {
    score += indices[i] - indices[i - 1] - 1
  }
  return { matched: true, indices, score }
}
```

**Highlighted Text Component**:
```typescript
function HighlightedText({ text, indices }: { text: string; indices: number[] }) {
  const set = new Set(indices)
  return (
    <span>
      {text.split('').map((char, i) =>
        set.has(i)
          ? <span key={i} className="text-primary font-semibold">{char}</span>
          : <span key={i}>{char}</span>
      )}
    </span>
  )
}
```

**Filtering Logic** (in `ProjectList.tsx`):
1. Add `filterQuery` state
2. For each project, compute `subsequenceMatch(query, project.name)` and `subsequenceMatch(query, project.path)`
3. A project matches if either name or path matches
4. Sort matched projects by: name match score (prefer name matches over path matches), then by match score (prefer more contiguous matches)
5. Pass match indices to `ProjectItem` for highlighting

#### 1.4 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/components/projects/ProjectFilter.tsx` | **NEW** — Search input with clear button |
| `src/renderer/src/components/projects/HighlightedText.tsx` | **NEW** — Renders text with highlighted matched characters |
| `src/renderer/src/lib/subsequence-match.ts` | **NEW** — `subsequenceMatch()` function |
| `src/renderer/src/components/projects/ProjectList.tsx` | Add filter state, filter projects using subsequence match, pass match indices to ProjectItem |
| `src/renderer/src/components/projects/ProjectItem.tsx` | Accept optional `nameMatchIndices` and `pathMatchIndices` props, render HighlightedText when provided, show path with highlights when matched on path |

---

### 2. Branch Duplication

#### 2.1 Current State
- `WorktreeItem.tsx` context menu has: Open in Terminal, Open in Editor, Open in Finder, Copy Path, Unbranch, Archive
- `git-service.ts` `createWorktree()` always creates a new branch from the default branch (e.g., main) with a random city name
- No mechanism exists to duplicate a branch or copy uncommitted changes between worktrees
- The `worktree:create` IPC handler in `worktree-handlers.ts` only supports the basic create flow

#### 2.2 New Design

Add a "Duplicate" option to the worktree right-click context menu:

```
Right-click menu:
┌─────────────────────────────┐
│  Open in Terminal            │
│  Open in Editor              │
│  Open in Finder              │
│  Copy Path                   │
│  ─────────────────────────── │
│  Duplicate                   │  ← NEW
│  ─────────────────────────── │
│  Unbranch       Keep branch  │
│  Archive       Delete branch │
└─────────────────────────────┘
```

**Versioning Logic**:
- First duplication of `feature-auth` → `feature-auth-v2`
- Second duplication (from `feature-auth` OR `feature-auth-v2`) → `feature-auth-v3`
- The version counter is global: scan all existing branches matching `{baseName}-v{N}` to find the next version
- Base name extraction: strip `-v{N}` suffix if present to find the root name

**Duplication Process**:
1. Determine the base branch name (strip `-v{N}` suffix)
2. Scan existing branches for `{baseName}-v{N}` pattern, find max N
3. New branch name = `{baseName}-v{N+1}` (or `{baseName}-v2` if none exist)
4. Create a new git worktree from the source branch's HEAD
5. Copy uncommitted changes: use `git diff` to capture unstaged changes, `git diff --cached` for staged changes, and copy untracked files
6. Apply the changes in the new worktree to reproduce the exact working state

**Preserving Uncommitted State**:
The cleanest approach is:
1. In the source worktree, create a temporary stash: `git stash create` (creates stash without modifying working tree)
2. Create the new worktree branching from the source branch
3. In the new worktree, apply the stash: `git stash apply {stash-ref}`
4. If untracked files need copying, enumerate them via `git ls-files --others --exclude-standard` in the source and copy them to the new worktree

#### 2.3 Implementation

**Git Service** (`git-service.ts`):
```typescript
interface DuplicateWorktreeResult {
  success: boolean
  name?: string
  branchName?: string
  path?: string
  error?: string
}

async duplicateWorktree(
  sourceBranch: string,
  sourceWorktreePath: string,
  projectName: string
): Promise<DuplicateWorktreeResult>
```

1. Extract base name: `sourceBranch.replace(/-v\d+$/, '')`
2. Get all branches, filter for `{baseName}-v{N}`, find max N
3. New branch = `{baseName}-v{maxN + 1}` (or `{baseName}-v2`)
4. Create worktree: `git worktree add -b {newBranch} {newPath} {sourceBranch}`
5. Capture uncommitted state from source:
   - `git -C {sourceWorktreePath} stash create` → returns a stash ref (or empty if clean)
   - If stash ref exists: `git -C {newPath} stash apply {stashRef}`
6. Copy untracked files:
   - `git -C {sourceWorktreePath} ls-files --others --exclude-standard` → list of untracked files
   - Copy each file from source to new worktree preserving relative paths

#### 2.4 Files to Modify/Create

| File | Change |
|------|--------|
| `src/main/services/git-service.ts` | Add `duplicateWorktree()` method with versioning logic and uncommitted state preservation |
| `src/main/ipc/worktree-handlers.ts` | Add `worktree:duplicate` IPC handler |
| `src/preload/index.ts` | Expose `duplicate` method on `window.worktreeOps` |
| `src/preload/index.d.ts` | Add type for `duplicate` method params and result |
| `src/renderer/src/stores/useWorktreeStore.ts` | Add `duplicateWorktree` action |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Add "Duplicate" to both context menu and dropdown menu |

---

### 3. Code Review

#### 3.1 Current State
- `GitStatusPanel.tsx` shows file statuses, staging, commit form, and push/pull controls
- `prompts/review.md` exists with a structured multi-agent review workflow
- Sessions are created via `useSessionStore.createSession()` and messages sent via `window.opencodeOps.prompt()`
- No mechanism to trigger an automated review session from the git panel

#### 3.2 New Design

Add a "Review" button in the git panel header, next to the refresh button:

```
┌─ Git ──────────────────────────────┐
│  ⎇ feature-auth           🔄  📝   │  ← 📝 = Review button
│  ─────────────────────────────────  │
│  Staged Changes (2)                 │
│  ...                                │
└─────────────────────────────────────┘
```

**Behavior**:
1. Click "Review" → creates a new session in the current worktree
2. The session is named "Code Review — {branch}"
3. The prompt sent to the session combines:
   - The contents of `prompts/review.md`
   - An instruction: "Review the uncommitted and unstaged changes in this worktree"
   - The list of changed files with their statuses
4. The session tab auto-activates so the user sees the review in progress

#### 3.3 Implementation

1. Read `prompts/review.md` at runtime via a new IPC handler or embed it at build time
2. Gather the list of changed files from `useGitStore` (already loaded in GitStatusPanel)
3. Create a new session via `useSessionStore.createSession()`
4. Send the review prompt via `window.opencodeOps.prompt()`
5. Switch to the new session tab

**Prompt Construction**:
```
{contents of prompts/review.md}

---

Please review the following uncommitted changes in this worktree:

Changed files:
- M  src/renderer/src/App.tsx
- A  src/renderer/src/components/NewFeature.tsx
- ?  src/renderer/src/utils/helper.ts

Focus on: bugs, logic errors, CLAUDE.md compliance, and code quality.
```

#### 3.4 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/components/git/GitStatusPanel.tsx` | Add "Review" button in header, implement review session creation flow |
| `src/main/ipc/file-handlers.ts` | Add handler to read `prompts/review.md` file content (or use existing `fileOps.readFile`) |
| `src/renderer/src/stores/useSessionStore.ts` | Potentially add a `createReviewSession` convenience action |

---

### 4. Inline Diff Viewer

#### 4.1 Current State
- `DiffModal.tsx` opens a full-screen modal dialog when clicking a changed file in `GitStatusPanel`
- `DiffViewer.tsx` renders diffs using `diff2html` with unified/split view modes
- The modal shows: file name, staged/unstaged label, view mode toggle, copy button
- `window.gitOps.getDiff()` returns the raw diff string for a single file
- No context expansion or hunk navigation exists

#### 4.2 New Design

Replace the diff modal with an **inline diff viewer** in the main content pane. When a changed file is clicked in the git panel, the diff renders in the main area (same space as sessions/file viewer):

```
┌─ Sidebar ─┐  ┌─ Main Pane ──────────────────────────────────┐
│ Projects   │  │  ┌─ Session ─┐  ┌─ Diff: App.tsx ─┐         │
│ ...        │  │  │           │  │  (active)        │         │
│            │  │  ├───────────┴──┴──────────────────┤         │
│            │  │  │  ▲ ▼  Unified | Split   Copy     │         │
│ Git Panel  │  │  ├──────────────────────────────────┤         │
│ ⎇ main     │  │  │  @@ -10,6 +10,8 @@               │         │
│ M App.tsx ←│──│─→│  │ 10 │ import { foo }            │         │
│ A New.tsx   │  │  │  │ 11 │ import { bar }            │         │
│            │  │  │  │ 12+│ import { baz }  ← added   │         │
│            │  │  │  │    │ ...                        │         │
│            │  │  │  │    │ [Show 5 more lines ▼]      │         │
│            │  │  │  │    │ ...                        │         │
│            │  │  │  │ 45-│ old code        ← removed  │         │
│            │  │  │  │ 45+│ new code        ← added    │         │
│            │  │  └──────────────────────────────────┘         │
└────────────┘  └───────────────────────────────────────────────┘
```

**Context Expansion**:
- Between diff hunks, show a "Show N more lines" button
- Clicking it re-fetches the diff with increased context (`git diff -U{n}`) and re-renders
- Default context: 3 lines (git default). Each expansion adds 10 more lines.

**Hunk Navigation**:
- Up (▲) and Down (▼) arrow buttons in the toolbar
- Clicking ▼ scrolls to the next diff hunk
- Clicking ▲ scrolls to the previous diff hunk
- Keyboard shortcut: `Alt+↑` / `Alt+↓` (or `]c` / `[c` vim-style)

#### 4.3 Implementation

1. Add a new tab type in the main pane for diffs (alongside sessions and file viewer)
2. When a file is clicked in `GitStatusPanel`, instead of opening `DiffModal`, open a diff tab
3. The diff tab renders `DiffViewer` inline with additional controls
4. For context expansion: maintain a `contextLines` state, re-fetch diff with `git diff -U{contextLines}`
5. For hunk navigation: parse diff output to find `@@` markers, scroll to next/prev

**Diff IPC Enhancement**:
- Update `gitOps.getDiff` to accept an optional `contextLines` parameter
- `git diff -U{contextLines}` for unstaged, `git diff --cached -U{contextLines}` for staged

#### 4.4 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/components/diff/InlineDiffViewer.tsx` | **NEW** — Full inline diff viewer with toolbar (nav arrows, view mode, copy, context expansion) |
| `src/renderer/src/components/diff/DiffViewer.tsx` | Add support for hunk anchors (data attributes on `@@` lines) for scroll navigation |
| `src/renderer/src/components/git/GitStatusPanel.tsx` | Change file click handler to open inline diff tab instead of DiffModal |
| `src/renderer/src/stores/useFileViewerStore.ts` | Add diff tab support (or create a dedicated diff tab state) |
| `src/main/ipc/git-file-handlers.ts` | Update `getDiff` handler to accept optional `contextLines` param |
| `src/preload/index.ts` | Update `getDiff` signature to include `contextLines` |
| `src/preload/index.d.ts` | Update `getDiff` type declaration |

---

### 5. Pulsing Animation for Running Worktrees

#### 5.1 Current State
- `WorktreeItem.tsx` shows `<Loader2 className="animate-spin">` when `worktreeStatus === 'working'` (AI session active)
- `RunTab.tsx` tracks `runRunning` state in `useScriptStore` per worktree
- The running state from the run tab (actual process alive) is separate from the AI session working state
- `useScriptStore` has `scriptStates[worktreeId].runRunning` boolean

#### 5.2 New Design

For worktrees where the **run process** (not AI session) is actively executing, show a small ECG/heartbeat pulse animation:

```
Worktree with live process:
┌──────────────────────────────┐
│  ╱╲  feature-auth            │  ← ECG pulse icon
│ ╱  ╲╱                        │
└──────────────────────────────┘

The pulse animation:
  ___     ___     ___
 /   \   /   \   /   \
/     \_/     \_/     \_  → continuous sine wave, loops every ~2s
```

**Implementation as SVG + CSS**:
- A small (16x12px) SVG showing a sine wave / ECG line
- CSS animation that shifts the wave horizontally creating a "traveling pulse" effect
- Color: `text-green-500` (matching the existing green dot for running state)
- Shown in the worktree item alongside or replacing the branch icon when the run process is alive

#### 5.3 Implementation

1. Create a `PulseAnimation` component with an SVG sine wave path
2. Use CSS `@keyframes` to animate the `stroke-dashoffset` or `transform: translateX()` for the traveling effect
3. In `WorktreeItem.tsx`, subscribe to `useScriptStore` for the worktree's `runRunning` state
4. When `runRunning === true`, show the pulse animation instead of the branch icon

```typescript
// PulseAnimation.tsx
function PulseAnimation({ className }: { className?: string }) {
  return (
    <svg className={cn('pulse-ecg', className)} viewBox="0 0 24 12" width="24" height="12">
      <path
        d="M0,6 Q3,6 4,2 Q5,-2 6,6 Q7,14 8,6 Q9,6 12,6 Q15,6 16,2 Q17,-2 18,6 Q19,14 20,6 Q21,6 24,6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}
```

CSS animation:
```css
.pulse-ecg {
  overflow: hidden;
}
.pulse-ecg path {
  animation: ecg-travel 2s linear infinite;
  stroke-dasharray: 24;
  stroke-dashoffset: 0;
}
@keyframes ecg-travel {
  to {
    stroke-dashoffset: -24;
  }
}
```

#### 5.4 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/components/worktrees/PulseAnimation.tsx` | **NEW** — SVG ECG pulse animation component |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Import `useScriptStore`, show PulseAnimation when run process is alive |

---

### 6. Auto-Focus Session Text Field

#### 6.1 Current State
- `SessionView.tsx` has a `<textarea>` for message input with a `ref` (`textareaRef`)
- When switching to a session (clicking a session tab or selecting a worktree), the textarea does not auto-focus
- The user must click the textarea before they can start typing

#### 6.2 New Design

When a session becomes active (entering a session view), auto-focus the textarea so the user can immediately start typing.

#### 6.3 Implementation

Add a `useEffect` in `SessionView.tsx` that focuses the textarea when the component mounts or when the active session changes:

```typescript
useEffect(() => {
  if (textareaRef.current) {
    textareaRef.current.focus()
  }
}, [activeSessionId])
```

The focus should use a small `requestAnimationFrame` delay to ensure the DOM is settled after tab switch animations.

#### 6.4 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/components/sessions/SessionView.tsx` | Add `useEffect` to auto-focus textarea on session activation |

---

### 7. Clear Button in Run Pane

#### 7.1 Current State
- `RunTab.tsx` has a status bar at the bottom with Run/Stop/Restart buttons
- `useScriptStore` already has a `clearRunOutput(worktreeId)` method
- There is no button in the UI to clear the run output

#### 7.2 New Design

Add a "Clear" button to the run pane status bar:

```
Status bar:
┌─────────────────────────────────────────────────────────┐
│  ● Running                          Clear  Stop  Restart │
└─────────────────────────────────────────────────────────┘

When stopped with output:
┌─────────────────────────────────────────────────────────┐
│  ○ Stopped                          Clear          Run   │
└─────────────────────────────────────────────────────────┘
```

**Behavior**:
- Clear button is visible whenever there is output to clear (`runOutput.length > 0`)
- Clicking Clear calls `clearRunOutput(worktreeId)` from the store
- The button uses a `Trash2` or `XCircle` icon for clarity

#### 7.3 Implementation

Add a Clear button to the status bar in `RunTab.tsx`:

```typescript
{runOutput.length > 0 && (
  <button
    onClick={() => clearRunOutput(worktreeId)}
    className="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent transition-colors"
  >
    <Trash2 className="h-3 w-3" />
    Clear
  </button>
)}
```

#### 7.4 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/components/layout/RunTab.tsx` | Add Clear button to status bar, show when output exists |

---

### 8. Model Variant Selection

#### 8.1 Current State
- `ModelSelector.tsx` lists all models in a flat dropdown grouped by provider
- `shortenModelName()` strips date suffixes: `claude-opus-4-5-20251101` → `claude-opus-4-5`
- Each model is shown as a separate entry — no grouping of variants
- `useSettingsStore` stores `selectedModel: { providerID, modelID }`
- Selection is done via click in a dropdown menu

#### 8.2 New Design

Group models that are variants (same base name, different date suffixes or version identifiers). Show the currently selected variant and allow toggling:

```
Current display (pill):
┌──────────────────────────┐
│  claude-opus-4-5  ▾  ↻   │  ← ↻ = variant toggle (or Alt+T)
└──────────────────────────┘

Dropdown (when clicking the pill):
┌─────────────────────────────────────┐
│  Anthropic                           │
│  ────────────────────────────────    │
│  ✓ claude-opus-4-5                   │
│      20251101 | 20250514             │  ← variant chips shown below active model
│    claude-sonnet-4-5                 │
│    claude-haiku-4-5                  │
│  ────────────────────────────────    │
│  OpenAI                              │
│  ────────────────────────────────    │
│  ...                                 │
└─────────────────────────────────────┘
```

**Alt+T Behavior**:
- When the model selector is not open, pressing `Alt+T` cycles through variants of the currently selected model
- Variants are models with the same base name (after stripping date suffixes) from the same provider
- If only one variant exists, `Alt+T` does nothing
- A toast briefly shows which variant was selected

**Variant Grouping Logic**:
```typescript
function getBaseName(modelId: string): string {
  return modelId.replace(/(-\d{8,})$/, '')
}

// Group models by baseName within each provider
// { "claude-opus-4-5": ["claude-opus-4-5-20251101", "claude-opus-4-5-20250514"] }
```

#### 8.3 Implementation

1. In `ModelSelector.tsx`, group models by base name within each provider
2. Display the base name as the primary entry, with variant chips below when multiple exist
3. Clicking the base name selects the first (latest) variant
4. Clicking a variant chip selects that specific variant
5. Register `Alt+T` keyboard shortcut via `useKeyboardShortcut` hook
6. On `Alt+T`, find current model's variants, cycle to the next one, call `setSelectedModel()`
7. Show a toast: "Switched to claude-opus-4-5-20250514"

#### 8.4 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/components/sessions/ModelSelector.tsx` | Group models by base name, show variant indicators, add variant selection UI |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts` | Register `Alt+T` for model variant cycling (or handle in ModelSelector locally) |
| `src/renderer/src/stores/useSettingsStore.ts` | No changes needed (already stores providerID + modelID) |

---

## Files to Modify — Full Summary

### New Files

| File | Purpose |
|------|---------|
| `src/renderer/src/components/projects/ProjectFilter.tsx` | Search input for project filtering |
| `src/renderer/src/components/projects/HighlightedText.tsx` | Renders text with highlighted matched characters |
| `src/renderer/src/lib/subsequence-match.ts` | Subsequence matching algorithm |
| `src/renderer/src/components/diff/InlineDiffViewer.tsx` | Inline diff viewer with toolbar, hunk navigation, context expansion |
| `src/renderer/src/components/worktrees/PulseAnimation.tsx` | ECG pulse animation SVG component |

### Modified Files

| File | Change |
|------|--------|
| `src/renderer/src/components/projects/ProjectList.tsx` | Add filter state, filter projects using subsequence match |
| `src/renderer/src/components/projects/ProjectItem.tsx` | Accept match indices props, render highlighted text |
| `src/main/services/git-service.ts` | Add `duplicateWorktree()` method |
| `src/main/ipc/worktree-handlers.ts` | Add `worktree:duplicate` IPC handler |
| `src/preload/index.ts` | Expose `worktreeOps.duplicate`, update `gitOps.getDiff` with contextLines param |
| `src/preload/index.d.ts` | Add types for duplicate, update getDiff signature |
| `src/renderer/src/stores/useWorktreeStore.ts` | Add `duplicateWorktree` store action |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Add "Duplicate" menu item, show PulseAnimation for running processes |
| `src/renderer/src/components/git/GitStatusPanel.tsx` | Add "Review" button, change file click to open inline diff |
| `src/renderer/src/stores/useSessionStore.ts` | Add `createReviewSession` action |
| `src/renderer/src/components/diff/DiffViewer.tsx` | Add hunk anchor data attributes |
| `src/renderer/src/stores/useFileViewerStore.ts` | Add diff tab support |
| `src/main/ipc/git-file-handlers.ts` | Update `getDiff` to accept `contextLines` |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add auto-focus on session activation |
| `src/renderer/src/components/layout/RunTab.tsx` | Add Clear button to status bar |
| `src/renderer/src/components/sessions/ModelSelector.tsx` | Group model variants, add variant selection UI |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts` | Add `Alt+T` shortcut for model variant cycling |

---

## Dependencies to Add

```bash
# No new dependencies required — all features use existing packages:
# - diff2html (already installed — diff rendering)
# - simple-git (already installed — git operations)
# - lucide-react (already installed — icons)
# - React + Zustand (already installed — UI and state)
```

---

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Project filter update | < 16ms per keystroke (synchronous, no debounce needed for < 100 projects) |
| Subsequence match highlighting | < 5ms per project |
| Branch duplication (including uncommitted files) | < 5 seconds for typical worktree |
| Review session creation | < 500ms to create session and send prompt |
| Inline diff render | < 100ms for files under 5000 lines |
| Context expansion re-render | < 200ms |
| Hunk navigation scroll | Instant (< 16ms) |
| Pulse animation | 60fps, no layout thrashing |
| Auto-focus textarea | < 50ms after session switch |
| Model variant cycle (Alt+T) | < 100ms |

---

## Out of Scope (Phase 7)

- Fuzzy matching (Levenshtein distance) — subsequence matching only
- Filtering worktrees by name (project name and path only)
- Branch duplication across different projects
- Branch duplication preserving stash entries
- Review with custom prompts (always uses `prompts/review.md`)
- Diff viewer for comparing arbitrary commits (only working tree vs HEAD)
- Diff viewer syntax highlighting (uses diff2html default highlighting)
- Multi-file diff viewer (one file at a time)
- Pulse animation customization (always green, always ECG style)
- Model variant sorting preferences (newest first by default)
- Model variant pinning or favorites

---

## Implementation Priority

### Sprint 1: Quick Wins (Auto-Focus, Clear, Pulse)
1. Add auto-focus `useEffect` in `SessionView.tsx` for textarea
2. Add Clear button to `RunTab.tsx` status bar
3. Create `PulseAnimation.tsx` SVG component with CSS animation
4. Wire `PulseAnimation` into `WorktreeItem.tsx` using `useScriptStore.runRunning`
5. Test all three features end-to-end

### Sprint 2: Project Filter
1. Create `subsequence-match.ts` utility with scoring
2. Create `HighlightedText.tsx` component
3. Create `ProjectFilter.tsx` search input
4. Integrate filter into `ProjectList.tsx` with match-based sorting
5. Update `ProjectItem.tsx` to show highlighted matches
6. Test with various project names and path matches

### Sprint 3: Branch Duplication
1. Add `duplicateWorktree()` to `git-service.ts` with versioning logic
2. Add `worktree:duplicate` IPC handler in `worktree-handlers.ts`
3. Expose in preload and update type declarations
4. Add `duplicateWorktree` action to `useWorktreeStore`
5. Add "Duplicate" to context menu and dropdown in `WorktreeItem.tsx`
6. Test duplication with uncommitted changes, untracked files, and version numbering

### Sprint 4: Code Review
1. Update file reading to support loading `prompts/review.md`
2. Add review button to `GitStatusPanel.tsx`
3. Implement review session creation flow (create session, build prompt, send)
4. Test review flow with various change states

### Sprint 5: Inline Diff Viewer
1. Create `InlineDiffViewer.tsx` with toolbar (nav, view mode, copy)
2. Add context expansion logic with `contextLines` parameter
3. Update `getDiff` IPC handler to accept `contextLines`
4. Add hunk navigation (scroll to `@@` markers)
5. Wire `GitStatusPanel` file click to open inline diff tab
6. Update `useFileViewerStore` for diff tab support
7. Test with various diff sizes and context levels

### Sprint 6: Model Variant Selection
1. Add variant grouping logic to `ModelSelector.tsx`
2. Update dropdown UI to show variant chips under grouped models
3. Add `Alt+T` keyboard shortcut for variant cycling
4. Show toast on variant switch
5. Test with multiple providers and variant counts

---

## Success Metrics

- Typing in the project filter instantly filters projects with highlighted subsequence matches
- The filter matches on both project name and root path, case-insensitively
- Right-clicking a worktree and selecting "Duplicate" creates a new worktree with the correct versioned name
- Duplicated worktrees contain all uncommitted and untracked changes from the source
- Clicking "Review" in the git panel creates a new AI session with the review prompt
- Clicking a changed file in the git panel opens an inline diff viewer (not a modal)
- The diff viewer supports expanding context and navigating between hunks
- Worktrees with a live run process show a smooth ECG pulse animation
- Entering a session auto-focuses the text input
- The Clear button in the run pane removes all output
- Models with variants show grouping in the selector
- Alt+T cycles through model variants with a toast confirmation
