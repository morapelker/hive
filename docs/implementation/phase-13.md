# Hive Phase 13 Implementation Plan

This document outlines the implementation plan for Hive Phase 13, focusing on markdown code block rendering fix, diff view color improvements, non-git repository onboarding, individual quick action buttons, header branding redesign, project refresh, selection auto-propagation, and streaming thinking block behavior.

---

## Overview

The implementation is divided into **9 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 13 builds upon Phase 12** — all Phase 12 infrastructure is assumed to be in place.

---

## Dependencies & Parallelization

```
Session 1 (Markdown Code Block Fix)     ── no deps
Session 2 (Diff Colors)                 ── no deps
Session 3 (Selection Auto-Propagation)  ── no deps
Session 4 (Streaming Thinking Blocks)   ── no deps
Session 5 (Refresh Project)             ── no deps
Session 6 (Quick Action Buttons)        ── no deps
Session 7 (Header Branding)             ── blocked by Session 6 (both modify Header area)
Session 8 (Non-Git Repository Dialog)   ── no deps
Session 9 (Integration & Verification)  ── blocked by Sessions 1-8
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────┐
│  Time →                                                          │
│                                                                  │
│  Track A: [S1: Markdown Fix]                                     │
│  Track B: [S2: Diff Colors]                                      │
│  Track C: [S3: Selection]                                        │
│  Track D: [S4: Thinking Blocks]                                  │
│  Track E: [S5: Refresh Project]                                  │
│  Track F: [S6: Quick Actions] → [S7: Header Branding]           │
│  Track G: [S8: Git Init Dialog]                                  │
│                                                                  │
│  All ──────────────────────────────────────────► [S9: Integration]│
└──────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 1-6, 8 are fully independent. Session 7 depends on Session 6 (both touch the header center area — QuickActions positioning).

**Minimum total**: 3 rounds:

1. (S1, S2, S3, S4, S5, S6, S8 in parallel)
2. (S7 — after S6 completes)
3. (S9)

**Recommended serial order** (if doing one at a time):

S1 → S3 → S2 → S4 → S5 → S6 → S7 → S8 → S9

Rationale: S1 fixes a visible user-reported bug (highest priority), S3 is a one-line fix (quick win), S2 is CSS-only (fast), S4 is a small component change, S5 adds a menu item, S6→S7 are sequential header changes, S8 is the most complex (new IPC + dialog), S9 validates everything.

---

## Testing Infrastructure

### Test File Structure (Phase 13)

```
test/
├── phase-13/
│   ├── session-1/
│   │   └── markdown-codeblock.test.ts
│   ├── session-2/
│   │   └── diff-colors.test.ts
│   ├── session-3/
│   │   └── selection-propagation.test.ts
│   ├── session-4/
│   │   └── streaming-thinking.test.ts
│   ├── session-5/
│   │   └── refresh-project.test.ts
│   ├── session-6/
│   │   └── quick-actions.test.ts
│   ├── session-7/
│   │   └── header-branding.test.ts
│   ├── session-8/
│   │   └── git-init-dialog.test.ts
│   └── session-9/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies — all features use existing packages:
# - react-markdown + remark-gfm (markdown rendering — already installed)
# - diff2html (diff rendering — already installed)
# - lucide-react (icons — already installed)
# - @radix-ui/react-alert-dialog via shadcn (dialogs — already installed)
# - zustand (stores — already installed)
```

---

## Session 1: Markdown Code Block Rendering Fix

### Objectives

- Fix fenced code blocks without a language specifier (bare ` ``` `) so they preserve whitespace and newlines
- Tree-structure text, ASCII art, and plain-text code blocks should render correctly in multi-line format
- Do not break existing language-specified code blocks

### Tasks

#### 1. Modify the `code` component override in `MarkdownRenderer.tsx`

In `src/renderer/src/components/sessions/MarkdownRenderer.tsx`, update the `code` entry in the `components` object (lines 55-67):

**Current code:**

```tsx
code: ({ className, children }) => {
  const match = /language-(\w+)/.exec(className || '')
  const isBlock = match !== null

  if (isBlock) {
    const code = String(children).replace(/\n$/, '')
    return <CodeBlock code={code} language={match![1]} />
  }

  return <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
}
```

**New code:**

```tsx
code: ({ className, children }) => {
  const match = /language-(\w+)/.exec(className || '')
  const content = String(children)
  const isBlock = match !== null || content.includes('\n')

  if (isBlock) {
    const code = content.replace(/\n$/, '')
    return <CodeBlock code={code} language={match?.[1] ?? 'text'} />
  }

  return <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
}
```

Three changes:

1. Extract `content = String(children)` before the check
2. Change `isBlock` condition to `match !== null || content.includes('\n')`
3. Use `match?.[1] ?? 'text'` instead of `match![1]` for the language fallback

The `pre` override remains unchanged — `CodeBlock` provides its own `<pre>` wrapper.

### Key Files

- `src/renderer/src/components/sessions/MarkdownRenderer.tsx` — update `code` component override

### Definition of Done

- [ ] Fenced code blocks without a language (bare ` ``` `) render with preserved newlines
- [ ] Tree-structure characters (├── └── │) display vertically, one entry per line
- [ ] Fenced blocks with a language specifier still work correctly
- [ ] Inline code (single backtick) is unaffected — still renders as inline `<code>`
- [ ] Language-less blocks render inside `CodeBlock` with `language="text"`
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. In a chat session, trigger a response containing a bare fenced code block with tree structure:
   ````
   ```
   src/
   ├── main/
   │   ├── index.ts
   │   └── db/
   └── renderer/
   ```
   ````
2. Verify each line renders on its own line with proper indentation
3. Verify a fenced block with a language (e.g., ` ```typescript `) still renders with syntax highlighting
4. Verify inline code like `someFunction()` still renders inline (not as a code block)
5. Open a `.md` file in the file viewer's preview mode — verify same fix applies there

### Testing Criteria

````typescript
// test/phase-13/session-1/markdown-codeblock.test.ts
describe('Session 1: Markdown Code Block Fix', () => {
  test('bare fenced block renders as CodeBlock', () => {
    const markdown = '```\nfoo/\n├── bar.ts\n└── baz.ts\n```'
    render(<MarkdownRenderer content={markdown} />)
    expect(screen.getByTestId('code-block')).toBeInTheDocument()
  })

  test('bare fenced block preserves newlines', () => {
    const markdown = '```\nline1\nline2\nline3\n```'
    render(<MarkdownRenderer content={markdown} />)
    const codeBlock = screen.getByTestId('code-block')
    expect(codeBlock.textContent).toContain('line1')
    expect(codeBlock.textContent).toContain('line2')
    expect(codeBlock.textContent).toContain('line3')
  })

  test('language-specified block still works', () => {
    const markdown = '```typescript\nconst x = 1\n```'
    render(<MarkdownRenderer content={markdown} />)
    const codeBlock = screen.getByTestId('code-block')
    expect(codeBlock).toBeInTheDocument()
    // Language label should be 'typescript', not 'text'
    expect(screen.getByText('typescript')).toBeInTheDocument()
  })

  test('bare fenced block uses "text" language', () => {
    const markdown = '```\nhello world\n```'
    render(<MarkdownRenderer content={markdown} />)
    expect(screen.getByText('text')).toBeInTheDocument()
  })

  test('inline code remains inline', () => {
    const markdown = 'Use `someFunction()` here'
    render(<MarkdownRenderer content={markdown} />)
    const inlineCode = screen.getByText('someFunction()')
    expect(inlineCode.tagName).toBe('CODE')
    expect(inlineCode).toHaveClass('bg-muted')
    // Should NOT be wrapped in a CodeBlock
    expect(screen.queryByTestId('code-block')).not.toBeInTheDocument()
  })

  test('tree structure characters render correctly', () => {
    const markdown = '```\ntest/\n├── foo/\n│   └── bar.ts\n└── baz.ts\n```'
    render(<MarkdownRenderer content={markdown} />)
    const codeBlock = screen.getByTestId('code-block')
    expect(codeBlock.textContent).toContain('├──')
    expect(codeBlock.textContent).toContain('│')
    expect(codeBlock.textContent).toContain('└──')
  })
})
````

---

## Session 2: Diff View Color Improvements

### Objectives

- Improve diff text readability by using dark-colored text on colored backgrounds
- Update both the diff2html CSS overrides (globals.css) and the EditToolView inline diff (Tailwind classes)
- Follow GitHub's modern dark mode diff color scheme

### Tasks

#### 1. Update diff2html dark mode text colors in `globals.css`

In `src/renderer/src/styles/globals.css`, modify the existing dark mode overrides (lines 178-192) and add text color rules:

**Replace the existing insertion/deletion blocks with:**

```css
/* Dark mode — added lines: dark green text on green background */
.dark .diff-viewer .d2h-ins {
  background-color: rgba(46, 160, 67, 0.15);
}

.dark .diff-viewer .d2h-ins .d2h-code-line-ctn {
  background-color: rgba(46, 160, 67, 0.15);
  color: #3fb950;
}

/* Dark mode — removed lines: dark red text on red background */
.dark .diff-viewer .d2h-del {
  background-color: rgba(248, 81, 73, 0.15);
}

.dark .diff-viewer .d2h-del .d2h-code-line-ctn {
  background-color: rgba(248, 81, 73, 0.15);
  color: #f85149;
}
```

#### 2. Add light mode text color overrides in `globals.css`

After the dark mode overrides, add light mode rules:

```css
/* Light mode — added lines: dark green text */
.diff-viewer .d2h-ins .d2h-code-line-ctn {
  color: #1a7f37;
}

/* Light mode — removed lines: dark red text */
.diff-viewer .d2h-del .d2h-code-line-ctn {
  color: #cf222e;
}
```

#### 3. Update EditToolView inline diff text colors

In `src/renderer/src/components/sessions/tools/EditToolView.tsx`, update the text classes for added and removed lines:

**Removed lines (line 68):**

Change `text-red-300` to `text-red-400`:

```tsx
<span className="text-red-400 whitespace-pre-wrap break-all">
```

**Added lines (line 90):**

Change `text-green-300` to `text-green-400`:

```tsx
<span className="text-green-400 whitespace-pre-wrap break-all">
```

The `+` and `-` sign spans (lines 67, 89) already use `text-red-400` and `text-green-400` respectively — no change needed there.

### Key Files

- `src/renderer/src/styles/globals.css` — diff2html dark/light mode text color overrides
- `src/renderer/src/components/sessions/tools/EditToolView.tsx` — Tailwind class updates

### Definition of Done

- [ ] diff2html added lines show `#3fb950` (dark green) text in dark mode
- [ ] diff2html removed lines show `#f85149` (dark red) text in dark mode
- [ ] diff2html added lines show `#1a7f37` text in light mode
- [ ] diff2html removed lines show `#cf222e` text in light mode
- [ ] EditToolView added lines use `text-green-400` instead of `text-green-300`
- [ ] EditToolView removed lines use `text-red-400` instead of `text-red-300`
- [ ] Both diff viewers are more readable with better contrast
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a file with changes in the diff viewer (click a changed file in the Changes tab)
2. Verify added lines have dark green text on subtle green background — NOT white text
3. Verify removed lines have dark red text on subtle red background — NOT white text
4. Trigger an AI Edit tool call — verify the inline diff in the chat uses darker green/red text
5. Switch between light and dark themes — verify colors are appropriate in both

### Testing Criteria

```typescript
// test/phase-13/session-2/diff-colors.test.ts
describe('Session 2: Diff Colors', () => {
  describe('EditToolView', () => {
    test('added lines use text-green-400', () => {
      render(
        <EditToolView
          name="Edit"
          input={{ oldString: 'old', newString: 'new' }}
          status="success"
        />
      )
      const addedLine = screen.getByTestId('diff-added')
      const contentSpan = addedLine.querySelector('span:last-child')
      expect(contentSpan).toHaveClass('text-green-400')
    })

    test('removed lines use text-red-400', () => {
      render(
        <EditToolView
          name="Edit"
          input={{ oldString: 'old', newString: 'new' }}
          status="success"
        />
      )
      const removedLine = screen.getByTestId('diff-removed')
      const contentSpan = removedLine.querySelector('span:last-child')
      expect(contentSpan).toHaveClass('text-red-400')
    })

    test('added lines do NOT use text-green-300', () => {
      render(
        <EditToolView
          name="Edit"
          input={{ oldString: 'old', newString: 'new' }}
          status="success"
        />
      )
      const addedLine = screen.getByTestId('diff-added')
      const contentSpan = addedLine.querySelector('span:last-child')
      expect(contentSpan).not.toHaveClass('text-green-300')
    })
  })
})
```

---

## Session 3: Selection Highlighting Auto-Propagation

### Objectives

- Auto-highlight the parent project when a worktree is selected
- Eliminate the visual inconsistency where a worktree is selected under one project but a different project appears highlighted

### Tasks

#### 1. Add `selectProject` call to `WorktreeItem.handleClick`

In `src/renderer/src/components/worktrees/WorktreeItem.tsx`, import `useProjectStore` and call `selectProject` when a worktree is clicked:

**Add import:**

```tsx
import { useProjectStore } from '@/stores'
```

**Add selector in the component:**

```tsx
const selectProject = useProjectStore((s) => s.selectProject)
```

**Modify `handleClick`:**

Current (lines 121-124):

```tsx
const handleClick = (): void => {
  selectWorktree(worktree.id)
  useWorktreeStatusStore.getState().clearWorktreeUnread(worktree.id)
}
```

New:

```tsx
const handleClick = (): void => {
  selectWorktree(worktree.id)
  selectProject(worktree.project_id)
  useWorktreeStatusStore.getState().clearWorktreeUnread(worktree.id)
}
```

That's it — one line addition. The `worktree.project_id` field is available on the `Worktree` type. The `selectProject` action sets `selectedProjectId` and calls `touchProject()`.

### Key Files

- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — add `selectProject` call

### Definition of Done

- [ ] Clicking a worktree highlights both the worktree AND its parent project
- [ ] The parent project's `bg-accent` highlighting appears immediately
- [ ] Clicking a worktree under Project B while Project A was highlighted switches highlight to Project B
- [ ] Clicking a project directly (expand/collapse) still works as before
- [ ] No double-render or performance issues from the extra store update
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Add two projects, each with at least one worktree
2. Click a worktree in Project A — verify Project A is highlighted
3. Click a worktree in Project B — verify Project B is now highlighted (not Project A)
4. Click the Project A header to collapse/expand — verify it highlights Project A
5. Click a worktree back in Project A — verify Project A is highlighted again

### Testing Criteria

```typescript
// test/phase-13/session-3/selection-propagation.test.ts
describe('Session 3: Selection Auto-Propagation', () => {
  test('clicking worktree selects parent project', () => {
    // Setup: two projects with worktrees
    // Click worktree in project A
    // Verify useProjectStore.selectedProjectId === projectA.id
  })

  test('switching worktree across projects updates project selection', () => {
    // Click worktree in project A
    // Then click worktree in project B
    // Verify selectedProjectId === projectB.id
  })

  test('clicking project directly still works', () => {
    // Click project header
    // Verify selectedProjectId is set
    // Verify project expanded/collapsed
  })
})
```

---

## Session 4: Streaming Thinking Block Auto-Expand/Collapse

### Objectives

- Auto-expand thinking/reasoning blocks while they are actively streaming text
- Auto-collapse thinking blocks when streaming ends
- Respect manual user toggles (if user collapses during streaming, keep it collapsed after)

### Tasks

#### 1. Add `isStreaming` prop to `ReasoningBlock`

In `src/renderer/src/components/sessions/ReasoningBlock.tsx`, update the interface and component:

```tsx
interface ReasoningBlockProps {
  text: string
  isStreaming?: boolean
}

export function ReasoningBlock({ text, isStreaming = false }: ReasoningBlockProps) {
```

#### 2. Add auto-expand/collapse logic with user override

Replace the simple `useState(false)` with streaming-aware state management:

```tsx
import { useState, useEffect, useRef } from 'react'

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
```

#### 3. Replace `onClick` handler

Change the button's `onClick` from the inline arrow function to `handleToggle`:

```tsx
<button
  type="button"
  onClick={handleToggle}
  // ... rest unchanged
>
```

#### 4. Pass `isStreaming` from `AssistantCanvas`

In `src/renderer/src/components/sessions/AssistantCanvas.tsx`, update the reasoning rendering (line 225-228):

**Current:**

```tsx
if (part.type === 'reasoning' && part.reasoning) {
  renderedParts.push(<ReasoningBlock key={`reasoning-${index}`} text={part.reasoning} />)
```

**New:**

```tsx
if (part.type === 'reasoning' && part.reasoning) {
  renderedParts.push(
    <ReasoningBlock key={`reasoning-${index}`} text={part.reasoning} isStreaming={isStreaming} />
  )
```

The `isStreaming` parameter is already available in the `renderParts()` function signature — it just needs to be forwarded.

### Key Files

- `src/renderer/src/components/sessions/ReasoningBlock.tsx` — add `isStreaming` prop, auto-expand/collapse logic
- `src/renderer/src/components/sessions/AssistantCanvas.tsx` — pass `isStreaming` to `ReasoningBlock`

### Definition of Done

- [ ] Thinking blocks auto-expand when reasoning text begins streaming
- [ ] Thinking blocks auto-collapse when streaming ends (if user hasn't manually toggled)
- [ ] Manual expand/collapse toggle still works during and after streaming
- [ ] If user manually collapses during streaming, it stays collapsed after streaming ends
- [ ] If user manually expands a completed block, it stays expanded
- [ ] Non-streaming reasoning blocks (from persisted messages) start collapsed as before
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a prompt that triggers extended thinking — verify the thinking block auto-expands and shows streaming text
2. Wait for the response to complete — verify the thinking block auto-collapses
3. During streaming, click the thinking block to collapse it — verify it stays collapsed after streaming ends
4. Scroll up to a previous message's thinking block — verify it is collapsed (not affected by current streaming)
5. Click a collapsed thinking block from a previous message — verify manual expand still works

### Testing Criteria

```typescript
// test/phase-13/session-4/streaming-thinking.test.ts
describe('Session 4: Streaming Thinking Blocks', () => {
  test('auto-expands when isStreaming is true', () => {
    const { rerender } = render(<ReasoningBlock text="thinking..." isStreaming={false} />)
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()

    rerender(<ReasoningBlock text="thinking..." isStreaming={true} />)
    expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()
  })

  test('auto-collapses when isStreaming becomes false', () => {
    const { rerender } = render(<ReasoningBlock text="thinking..." isStreaming={true} />)
    expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()

    rerender(<ReasoningBlock text="done thinking" isStreaming={false} />)
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
  })

  test('user manual collapse is respected after streaming ends', async () => {
    const { rerender } = render(<ReasoningBlock text="thinking..." isStreaming={true} />)
    // Auto-expanded
    expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()

    // User manually collapses
    await userEvent.click(screen.getByTestId('reasoning-block-header'))
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()

    // Streaming ends — should stay collapsed (user override)
    rerender(<ReasoningBlock text="done thinking" isStreaming={false} />)
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
  })

  test('defaults to collapsed when isStreaming is not provided', () => {
    render(<ReasoningBlock text="some reasoning" />)
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
  })

  test('manual toggle still works on non-streaming blocks', async () => {
    render(<ReasoningBlock text="some reasoning" />)
    await userEvent.click(screen.getByTestId('reasoning-block-header'))
    expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('reasoning-block-header'))
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
  })
})
```

---

## Session 5: Refresh Project (Context Menu Action)

### Objectives

- Add a "Refresh Project" item to the project right-click context menu
- Clicking it re-syncs worktree branch names by calling the existing `syncWorktrees()` action
- Show a success toast on completion

### Tasks

#### 1. Add the context menu item in `ProjectItem.tsx`

In `src/renderer/src/components/projects/ProjectItem.tsx`, add a new `ContextMenuItem` after "Refresh Language" (line 281):

**Import `syncWorktrees` from the worktree store:**

```tsx
const syncWorktrees = useWorktreeStore((s) => s.syncWorktrees)
```

**Add the handler:**

```tsx
const handleRefreshProject = async () => {
  await syncWorktrees(project.id, project.path)
  toast.success('Project refreshed')
}
```

**Add the menu item (after the Refresh Language item, around line 282):**

```tsx
<ContextMenuItem onClick={handleRefreshProject}>
  <RefreshCw className="h-4 w-4 mr-2" />
  Refresh Project
</ContextMenuItem>
```

`RefreshCw` is already imported (used for "Refresh Language"). `toast` should already be imported (used elsewhere in the component). If not, import from `sonner`.

#### 2. Verify `syncWorktrees` is exported from the store

In `src/renderer/src/stores/useWorktreeStore.ts`, verify that `syncWorktrees` is in the store's interface and exposed. It already exists (lines 316-324), so this is just a verification step.

### Key Files

- `src/renderer/src/components/projects/ProjectItem.tsx` — add context menu item

### Definition of Done

- [ ] "Refresh Project" appears in the project context menu after "Refresh Language"
- [ ] Uses the `RefreshCw` icon (same as Refresh Language)
- [ ] Clicking it calls `syncWorktrees(projectId, projectPath)`
- [ ] Shows "Project refreshed" success toast on completion
- [ ] Worktree list in sidebar updates if branch names changed
- [ ] Worktrees missing from disk are archived
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Right-click a project — verify "Refresh Project" appears in the context menu
2. Externally rename a branch (via `git branch -m`) — click "Refresh Project" — verify the sidebar updates with the new branch name
3. Externally delete a worktree directory — click "Refresh Project" — verify the worktree is archived/removed from the sidebar
4. Verify the success toast appears after refresh

### Testing Criteria

```typescript
// test/phase-13/session-5/refresh-project.test.ts
describe('Session 5: Refresh Project', () => {
  test('context menu contains Refresh Project item', () => {
    // Render ProjectItem with context menu
    // Right-click to open
    // Verify 'Refresh Project' text is present
  })

  test('clicking Refresh Project calls syncWorktrees', async () => {
    const syncMock = vi.fn().mockResolvedValue(undefined)
    // Mock useWorktreeStore.syncWorktrees
    // Click 'Refresh Project'
    // Verify syncMock called with (project.id, project.path)
  })

  test('shows success toast after refresh', async () => {
    // Mock syncWorktrees to resolve
    // Click 'Refresh Project'
    // Verify toast.success called with 'Project refreshed'
  })
})
```

---

## Session 6: Individual Quick Action Buttons

### Objectives

- Replace the split-button dropdown with individual buttons for each quick action
- Enable one-click access to Cursor, Ghostty, Copy Path, and Finder
- Remove the dropdown pattern and "last used" tracking

### Tasks

#### 1. Rewrite `QuickActions.tsx`

In `src/renderer/src/components/layout/QuickActions.tsx`, replace the entire component:

**Remove imports:**

- `ChevronDown`, `ExternalLink` from lucide-react
- `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuTrigger` from UI
- `useSettingsStore` / `QuickActionType` (no longer needed for `lastOpenAction`)

**Keep imports:**

- `Copy`, `Check`, `FolderOpen` from lucide-react
- `useState`, `useCallback` from react
- `Button` from UI
- `useWorktreeStore`
- `CursorIcon`, `GhosttyIcon` internal components

**New component structure:**

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
    async (actionId: string) => {
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

Key differences:

- Cursor and Ghostty: icon + label buttons (branded, need labels for identification)
- Copy Path and Finder: icon-only buttons (universally recognized icons, saves space)
- No dropdown, no chevron, no split-button
- No `lastOpenAction` setting tracking

#### 2. Keep `CursorIcon` and `GhosttyIcon` SVG components

These stay unchanged at the top of the file.

#### 3. Remove unused `ACTIONS` array and `getActionConfig` helper

Delete the `ActionConfig` interface, `ACTIONS` array, and `getActionConfig` function — they are no longer needed.

### Key Files

- `src/renderer/src/components/layout/QuickActions.tsx` — full rewrite

### Definition of Done

- [ ] Four individual buttons visible in the header center area: Cursor, Ghostty, Copy Path, Finder
- [ ] Each button is clickable in a single click (no dropdown required)
- [ ] Cursor and Ghostty show icon + label text
- [ ] Copy Path and Finder show icon only
- [ ] Copy Path shows green check icon for 1.5s after copying
- [ ] All buttons disabled when no worktree is selected
- [ ] No dropdown menu or chevron button exists
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Select a worktree — verify four buttons appear in the header
2. Click "Cursor" — verify Cursor opens with the worktree path
3. Click "Ghostty" — verify Ghostty opens
4. Click the Copy icon — verify path copied and icon changes to green check
5. Click the Finder icon — verify Finder opens to the worktree directory
6. Deselect the worktree — verify all buttons are disabled/grayed
7. Verify there is NO dropdown chevron button anywhere

### Testing Criteria

```typescript
// test/phase-13/session-6/quick-actions.test.ts
describe('Session 6: Quick Action Buttons', () => {
  test('renders four individual buttons', () => {
    // Mock worktree selected
    render(<QuickActions />)
    expect(screen.getByTestId('quick-action-cursor')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-ghostty')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-copy-path')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-finder')).toBeInTheDocument()
  })

  test('no dropdown menu exists', () => {
    render(<QuickActions />)
    expect(screen.queryByTestId('quick-action-dropdown')).not.toBeInTheDocument()
  })

  test('buttons disabled when no worktree selected', () => {
    // Mock no worktree selected
    render(<QuickActions />)
    expect(screen.getByTestId('quick-action-cursor')).toBeDisabled()
    expect(screen.getByTestId('quick-action-ghostty')).toBeDisabled()
  })

  test('Cursor button shows label', () => {
    render(<QuickActions />)
    expect(screen.getByText('Cursor')).toBeInTheDocument()
  })

  test('Ghostty button shows label', () => {
    render(<QuickActions />)
    expect(screen.getByText('Ghostty')).toBeInTheDocument()
  })

  test('Copy Path shows check icon after click', async () => {
    // Mock worktree + copyToClipboard
    render(<QuickActions />)
    await userEvent.click(screen.getByTestId('quick-action-copy-path'))
    // Verify Check icon appears (green-500 class)
  })
})
```

---

## Session 7: Header Branding Redesign (Logo + Project/Branch)

### Objectives

- Replace the "Hive" text title with the app logo
- Display the active project name and branch name in parentheses
- Ensure the display updates reactively when switching projects, worktrees, or renaming branches

### Tasks

#### 1. Create or import the logo asset

**Option A (preferred): Inline SVG component.**

Create a `HiveLogo` component directly in `Header.tsx` or as a separate small file. Extract a simplified version of the app icon from `resources/icon.png` as SVG. The logo should:

- Be ~20x20px display size
- Use `currentColor` for theme adaptability
- Be simple enough for inline SVG

**Option B: Image import.**

Copy `resources/icon.png` to `src/renderer/src/assets/` and import it:

```tsx
import hiveLogo from '@/assets/icon.png'
// <img src={hiveLogo} alt="Hive" className="h-5 w-5" />
```

#### 2. Add store selectors to `Header.tsx`

In `src/renderer/src/components/layout/Header.tsx`, add imports and selectors:

```tsx
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

// Inside the Header component:
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
```

#### 3. Replace the `<h1>Hive</h1>` section

Replace lines 21-23:

```tsx
<div className="flex items-center gap-2 flex-1">
  <h1 className="text-lg font-semibold">Hive</h1>
</div>
```

With:

```tsx
<div className="flex items-center gap-2 flex-1 min-w-0">
  <img src={hiveLogo} alt="Hive" className="h-5 w-5 shrink-0" draggable={false} />
  {selectedProject ? (
    <span className="text-sm font-medium truncate">
      {selectedProject.name}
      {selectedWorktree?.branch_name && (
        <span className="text-muted-foreground font-normal"> ({selectedWorktree.branch_name})</span>
      )}
    </span>
  ) : (
    <span className="text-sm font-medium">Hive</span>
  )}
</div>
```

Key details:

- `min-w-0` on the container enables `truncate` to work in flex layout
- `shrink-0` on the logo prevents it from shrinking
- `truncate` on the text prevents long project/branch names from overflowing
- Falls back to "Hive" text when no project is selected
- Branch name only shown if the worktree has a `branch_name`
- `draggable={false}` on the img prevents drag interference with the titlebar

#### 4. Update title display for default worktrees

Worktrees with `name === '(no-worktree)'` represent the project root without git worktrees. For these, show just the project name without a branch. Check:

```tsx
{
  selectedWorktree?.branch_name && selectedWorktree.name !== '(no-worktree)' && (
    <span className="text-muted-foreground font-normal"> ({selectedWorktree.branch_name})</span>
  )
}
```

### Key Files

- `src/renderer/src/components/layout/Header.tsx` — replace title with logo + project/branch
- `src/renderer/src/assets/icon.png` — **copy from** `resources/icon.png` (or create SVG)

### Definition of Done

- [ ] App logo appears on the left side of the header (replacing "Hive" text)
- [ ] Active project name displays next to the logo
- [ ] Active branch name displays in parentheses after the project name
- [ ] Format: `ProjectName (branchName)`
- [ ] Switching projects updates the display immediately
- [ ] Switching worktrees updates the branch name immediately
- [ ] Branch rename (auto or manual) updates the display
- [ ] Long project/branch names truncate with ellipsis instead of overflowing
- [ ] When no project is selected, shows "Hive" text as fallback
- [ ] When a worktree has no branch (default worktree), shows just the project name
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open the app — verify logo + project name + branch name in the header
2. Switch to a different worktree — verify branch name changes
3. Switch to a different project — verify project name changes
4. Rename a branch — verify header updates
5. Create a new worktree — select it — verify header shows new branch
6. Close/deselect all projects — verify "Hive" fallback text appears
7. Add a project with a very long name — verify text truncates

### Testing Criteria

```typescript
// test/phase-13/session-7/header-branding.test.ts
describe('Session 7: Header Branding', () => {
  test('shows project name when project selected', () => {
    // Mock: selectedProjectId set, project with name 'my-app'
    render(<Header />)
    expect(screen.getByText('my-app')).toBeInTheDocument()
  })

  test('shows branch name in parentheses', () => {
    // Mock: project + worktree with branch_name 'lisbon'
    render(<Header />)
    expect(screen.getByText(/\(lisbon\)/)).toBeInTheDocument()
  })

  test('shows "Hive" fallback when no project selected', () => {
    // Mock: no selectedProjectId
    render(<Header />)
    expect(screen.getByText('Hive')).toBeInTheDocument()
  })

  test('does not show branch for default worktree', () => {
    // Mock: worktree with name '(no-worktree)'
    render(<Header />)
    expect(screen.queryByText(/\(/)).not.toBeInTheDocument()
  })

  test('logo image is rendered', () => {
    render(<Header />)
    const logo = screen.getByAltText('Hive')
    expect(logo).toBeInTheDocument()
    expect(logo.tagName).toBe('IMG')
  })
})
```

---

## Session 8: Non-Git Repository Initialization Dialog

### Objectives

- Show a modal dialog when a user tries to add a non-git directory
- Offer to run `git init --initial-branch=main` to initialize the repository
- Proceed with adding the project if initialization succeeds
- Handle errors gracefully

### Tasks

#### 1. Add `git:init` IPC handler

In `src/main/ipc/project-handlers.ts`, add a new handler:

```typescript
ipcMain.handle(
  'git:init',
  async (_event, path: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const { execSync } = require('child_process')
      execSync('git init --initial-branch=main', { cwd: path, encoding: 'utf-8' })
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

Note: Use `execSync` since `git init` is fast and we need to block until completion before proceeding. Alternatively, use the async `exec` from `child_process/promises` with `await`.

#### 2. Expose in preload bridge

In `src/preload/index.ts`, add to the `projectOps` namespace:

```typescript
initRepository: (path: string): Promise<{ success: boolean; error?: string }> =>
  ipcRenderer.invoke('git:init', path),
```

#### 3. Add type declaration

In `src/preload/index.d.ts`, add to the `ProjectOps` interface:

```typescript
initRepository(path: string): Promise<{ success: boolean; error?: string }>
```

#### 4. Create `GitInitDialog.tsx`

Create `src/renderer/src/components/projects/GitInitDialog.tsx`:

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
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Not a Git Repository</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>The selected folder is not a Git repository:</p>
              <p className="font-mono text-xs bg-muted rounded px-2 py-1 break-all">{path}</p>
              <p>Would you like to initialize a new Git repository?</p>
            </div>
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

Note: Using `asChild` on `AlertDialogDescription` with a `<div>` wrapper because we need multiple `<p>` tags. Without `asChild`, it would render `<p>` inside `<p>` (invalid HTML).

#### 5. Modify `AddProjectButton.tsx`

In `src/renderer/src/components/projects/AddProjectButton.tsx`:

**Add imports:**

```tsx
import { GitInitDialog } from './GitInitDialog'
```

**Add state:**

```tsx
const [gitInitPath, setGitInitPath] = useState<string | null>(null)
```

**Modify the add project handler to intercept git errors:**

Current flow calls `addProject(path)` and shows `toast.error` on failure. Modify to detect the specific "not a Git repository" error:

```tsx
const handleAddProject = async () => {
  const path = await window.projectOps.openDirectoryDialog()
  if (!path) return

  const result = await addProject(path)
  if (result.success) return

  // Check if the error is about not being a git repo
  if (result.error?.includes('not a Git repository')) {
    setGitInitPath(path)
    return
  }

  toast.error(result.error || 'Failed to add project', {
    action: { label: 'Retry', onClick: handleAddProject }
  })
}
```

**Add the init handler:**

```tsx
const handleInitRepository = async () => {
  if (!gitInitPath) return

  const initResult = await window.projectOps.initRepository(gitInitPath)
  if (!initResult.success) {
    toast.error(initResult.error || 'Failed to initialize repository')
    setGitInitPath(null)
    return
  }

  toast.success('Git repository initialized')

  // Retry adding the project
  const addResult = await addProject(gitInitPath)
  if (!addResult.success) {
    toast.error(addResult.error || 'Failed to add project')
  }
  setGitInitPath(null)
}
```

**Add the dialog to the JSX (at the end of the component return):**

```tsx
<GitInitDialog
  open={!!gitInitPath}
  path={gitInitPath || ''}
  onCancel={() => setGitInitPath(null)}
  onConfirm={handleInitRepository}
/>
```

#### 6. Verify AlertDialog UI component exists

Check that `src/renderer/src/components/ui/alert-dialog.tsx` exists (shadcn component). If not, install it:

```bash
pnpm dlx shadcn@latest add alert-dialog
```

### Key Files

- `src/main/ipc/project-handlers.ts` — add `git:init` handler
- `src/preload/index.ts` — expose `initRepository`
- `src/preload/index.d.ts` — type declaration
- `src/renderer/src/components/projects/GitInitDialog.tsx` — **NEW**
- `src/renderer/src/components/projects/AddProjectButton.tsx` — intercept error, show dialog

### Definition of Done

- [ ] Selecting a non-git directory shows a modal dialog instead of a toast error
- [ ] Dialog shows the path and asks if user wants to initialize a git repository
- [ ] "Cancel" closes the dialog without any action
- [ ] "Initialize Repository" runs `git init --initial-branch=main` in the directory
- [ ] On init success: shows success toast, proceeds to add the project
- [ ] On init failure: shows error toast, closes dialog
- [ ] After init, the project appears in the sidebar with its worktrees
- [ ] Regular git repos are unaffected — they add immediately as before
- [ ] Other add-project errors (duplicate, invalid path) still show toast as before
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a new empty directory (not a git repo): `mkdir /tmp/test-project`
2. Click `+` to add a project, select the empty directory
3. Verify a dialog appears saying "Not a Git Repository"
4. Click "Cancel" — verify dialog closes, no project added
5. Repeat, this time click "Initialize Repository" — verify:
   - Success toast appears
   - Project appears in the sidebar
   - The directory now has a `.git` folder
6. Try to add a regular git repo — verify it adds immediately (no dialog)
7. Try to add a non-existent path — verify error toast (not the dialog)

### Testing Criteria

```typescript
// test/phase-13/session-8/git-init-dialog.test.ts
describe('Session 8: Git Init Dialog', () => {
  describe('GitInitDialog', () => {
    test('renders dialog with path', () => {
      render(
        <GitInitDialog
          open={true}
          path="/tmp/my-project"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
      expect(screen.getByText('Not a Git Repository')).toBeInTheDocument()
      expect(screen.getByText('/tmp/my-project')).toBeInTheDocument()
    })

    test('Cancel button calls onCancel', async () => {
      const onCancel = vi.fn()
      render(
        <GitInitDialog
          open={true}
          path="/tmp/test"
          onCancel={onCancel}
          onConfirm={vi.fn()}
        />
      )
      await userEvent.click(screen.getByText('Cancel'))
      expect(onCancel).toHaveBeenCalled()
    })

    test('Initialize button calls onConfirm', async () => {
      const onConfirm = vi.fn()
      render(
        <GitInitDialog
          open={true}
          path="/tmp/test"
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      )
      await userEvent.click(screen.getByText('Initialize Repository'))
      expect(onConfirm).toHaveBeenCalled()
    })

    test('dialog not rendered when closed', () => {
      render(
        <GitInitDialog
          open={false}
          path="/tmp/test"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )
      expect(screen.queryByText('Not a Git Repository')).not.toBeInTheDocument()
    })
  })

  describe('AddProjectButton integration', () => {
    test('shows dialog when adding non-git directory', async () => {
      // Mock openDirectoryDialog to return a path
      // Mock addProject to return { success: false, error: '...not a Git repository...' }
      // Click add button
      // Verify GitInitDialog opens
    })

    test('initializes repo and retries add on confirm', async () => {
      // Mock initRepository to return { success: true }
      // Mock addProject to return { success: true } on second call
      // Verify both called in sequence
    })

    test('shows error toast on init failure', async () => {
      // Mock initRepository to return { success: false, error: 'failed' }
      // Verify toast.error called
    })
  })
})
```

---

## Session 9: Integration & Verification

### Objectives

- Verify all Phase 13 features work correctly together
- Test cross-feature interactions
- Run lint and tests
- Fix any edge cases or regressions

### Tasks

#### 1. Markdown rendering end-to-end

- Send a message that triggers a response with bare fenced code blocks
- Verify tree structures render correctly with preserved whitespace
- Open a `.md` file in file viewer — verify the markdown renderer also correctly shows code blocks
- Verify inline code (single backtick) is still inline

#### 2. Diff colors visual check

- Open a file with changes in the diff viewer
- Verify dark green text on green background for additions
- Verify dark red text on red background for deletions
- Trigger an Edit tool call — verify inline diff has improved colors
- Toggle light/dark theme — verify colors work in both modes

#### 3. Selection + Header integration

- Select a worktree in Project A — verify:
  - Project A is highlighted in sidebar (selection propagation)
  - Header shows `ProjectA (branchName)` (header branding)
- Switch to a worktree in Project B — verify:
  - Project B is now highlighted (not Project A)
  - Header updates to `ProjectB (newBranch)`
- Deselect everything — verify header shows "Hive"

#### 4. Quick actions with header

- Verify the header layout is correct: logo + project/branch on left, action buttons in center, settings on right
- Click each action button — verify one-click functionality
- Verify buttons disabled when no worktree selected

#### 5. Thinking blocks during streaming

- Send a prompt that triggers extended thinking
- Verify thinking block auto-expands during streaming
- Wait for completion — verify auto-collapse
- Manually expand the collapsed thinking block — verify manual toggle works
- Queue a follow-up during thinking — verify thinking block and follow-up messages coexist

#### 6. Refresh project

- Right-click a project — click "Refresh Project"
- Verify success toast
- Verify worktree list refreshes

#### 7. Non-git repository flow

- Try to add a non-git directory
- Verify dialog appears
- Click "Initialize Repository"
- Verify project is added with a git repo
- Verify the `.git` directory exists in the folder

#### 8. Full smoke test

Walk through the complete flow:

1. Open app → verify logo in header with "Hive" fallback
2. Add a non-git directory → dialog → initialize → project added → header updates
3. Create a worktree → verify parent project highlights → header shows project (branch)
4. Click Cursor button → opens Cursor (one click)
5. Click Ghostty button → opens Ghostty (one click)
6. Send a message with thinking → block auto-expands → auto-collapses on completion
7. View a diff → verify dark green/red text colors
8. Trigger a bare code block in response → verify whitespace preserved
9. Right-click project → Refresh Project → verify sync
10. Switch worktrees → verify header + selection update

#### 9. Run lint and tests

```bash
pnpm lint
pnpm test
```

Fix any failures.

### Key Files

- All files modified in Sessions 1-8

### Definition of Done

- [ ] All 8 features work correctly in isolation
- [ ] Cross-feature interactions work correctly (selection + header, quick actions + header)
- [ ] No regressions in Phase 12 features
- [ ] No console errors during normal operation
- [ ] No leaked timers, rAF callbacks, or IPC listeners
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Full happy path smoke test passes

### How to Test

Run through each integration scenario listed in Tasks above. Pay special attention to:

- Header display updating across project/worktree switches
- Selection propagation not interfering with expand/collapse behavior
- Thinking block auto-collapse timing (should collapse after streaming ends, not during)
- Git init dialog error recovery
- Diff colors in both light and dark themes

### Testing Criteria

```typescript
// test/phase-13/session-9/integration-verification.test.ts
describe('Session 9: Integration & Verification', () => {
  test('markdown code blocks with tree structure render correctly', () => {
    // Render MarkdownRenderer with tree-structure bare fenced block
    // Verify CodeBlock rendered with 'text' language
    // Verify content has newlines
  })

  test('diff colors are readable', () => {
    // Render EditToolView with changes
    // Verify green-400 and red-400 classes
  })

  test('selection propagation works with header', () => {
    // Select worktree → verify parent project selected
    // Verify header shows project name + branch
  })

  test('quick actions are all accessible', () => {
    // Render QuickActions with worktree selected
    // Verify 4 buttons present
    // Verify no dropdown
  })

  test('thinking blocks auto-expand and collapse', () => {
    // Render ReasoningBlock with isStreaming true → expanded
    // Set isStreaming false → collapsed
  })

  test('git init dialog flow works end-to-end', () => {
    // Mock non-git directory → dialog opens
    // Mock initRepository success → project added
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

## Notes

### Assumed Phase 12 Infrastructure

- Prompt history navigation (Up/Down arrow keys)
- Context calculation fix (snapshot-based tokens)
- Queued message bubbles
- Compact Read/Write/Edit tool cards
- TodoWrite tool rendering
- Markdown file preview in file viewer
- Session auto-focus
- Archive loading state
- File viewer tab context menu

### Out of Scope (Phase 13)

Per PRD Phase 13:

- Syntax highlighting for language-less code blocks (render as plain `text`)
- Word-level diff highlighting within diff lines
- Git init with custom branch names or .gitignore templates
- Configurable/reorderable quick action buttons
- Responsive dropdown fallback for narrow windows
- Breadcrumb navigation in header
- Auto-refresh on file system changes
- Multi-select for projects/worktrees
- Search/filter within thinking content
- Persisting user expand/collapse preference for thinking blocks across sessions

### Performance Targets

| Operation                    | Target                                        |
| ---------------------------- | --------------------------------------------- |
| Markdown code block render   | < 16ms for standard fenced blocks             |
| Diff text color application  | No JS overhead (CSS-only for diff2html)       |
| Git init dialog appearance   | < 100ms from directory selection to dialog    |
| Git init execution           | < 3s for typical directories                  |
| Quick action button response | < 50ms from click to action start             |
| Header project/branch update | < 16ms (single frame) from store change       |
| Project refresh (sync)       | < 2s for projects with up to 20 worktrees     |
| Selection propagation        | < 16ms from click to parent project highlight |
| Thinking block auto-expand   | < 16ms from first reasoning delta             |
| Thinking block auto-collapse | < 16ms from isStreaming=false                 |

### Key Architecture Decisions

1. **Multi-line heuristic for code blocks**: Detecting `\n` in content is reliable because `react-markdown` only produces multi-line `<code>` children for fenced blocks. Inline code (single backtick) never contains literal newlines.

2. **CSS-only diff color fix for diff2html**: Using CSS text color overrides avoids touching the diff2html library integration. The JS rendering path is unchanged — only visual styling updates.

3. **Individual buttons over dropdown**: The four quick actions are a fixed, small set. A dropdown adds an unnecessary click. On desktop, horizontal space is available for 4 small buttons.

4. **Logo + project/branch in header**: This follows IDE conventions (VS Code shows project name in title bar). The reactive display from stores ensures zero staleness.

5. **One-line fix for selection propagation**: Adding `selectProject()` in `WorktreeItem.handleClick` is the minimal correct fix. No store architecture changes needed — the stores already support this, they just weren't connected.

6. **User override ref for thinking blocks**: Using `useRef` for the override flag (instead of state) avoids re-renders. The flag is ephemeral — it resets when streaming starts, which is the correct lifecycle.

7. **AlertDialog over custom modal for git init**: Reusing shadcn's AlertDialog provides consistent styling and accessibility (focus trapping, escape to close). No need for a custom dialog implementation.

8. **`execSync` for git init**: `git init` is nearly instantaneous (<100ms) so synchronous execution is acceptable and simpler than async with await.
