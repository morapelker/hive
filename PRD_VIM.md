# PRD: Vim-Style Keyboard Navigation

## Overview

Add a vim-style modal input system to Hive. Two modes: **normal** (bare keys trigger navigation) and **insert** (keys type into focused input). Includes permanent two-letter hint badges on worktrees, projects, and session tabs; hjkl/arrow navigation; and a `?` help overlay.

---

## Concepts

### Normal Mode (default)
- No input is focused. Bare keystrokes are captured for navigation.
- Two-letter hint badges are visible on all expanded worktrees, projects, and session tabs.
- `hjkl` / arrow keys navigate the sidebar and session tabs.

### Insert Mode
- An input field is focused. All keystrokes type characters as normal.
- Entered by pressing `I` (Shift+I) or clicking into any input/textarea.
- Exited by pressing `Escape` (blurs the active element).

---

## New Files

### 1. `src/renderer/src/stores/useVimModeStore.ts`

Zustand store for modal state.

```typescript
interface VimModeState {
  mode: 'normal' | 'insert'
  helpOverlayOpen: boolean

  enterNormalMode: () => void   // sets mode='normal', calls document.activeElement.blur()
  enterInsertMode: () => void   // sets mode='insert'
  toggleHelpOverlay: () => void
  setHelpOverlayOpen: (open: boolean) => void
}
```

- Starts in `'normal'` mode.
- `enterNormalMode()` must blur the active element: `(document.activeElement as HTMLElement)?.blur()`
- Export from `src/renderer/src/stores/index.ts`.

---

### 2. `src/renderer/src/hooks/useVimNavigation.ts`

Core hook. Registers a **capture-phase** `keydown` listener + `focusin`/`focusout` listeners on `document`.

#### Guard Conditions (pass key through, do NOT consume)

Before processing any key, check these in order. If any match, `return` without calling `preventDefault`/`stopPropagation`:

1. **Modifier keys held**: `event.metaKey || event.ctrlKey || event.altKey` — let existing `Cmd+T`, `Cmd+K`, etc. pass through to `useKeyboardShortcuts`.
2. **Insert mode** and key is not `Escape` — let the user type.
3. **Radix overlay active**: `document.querySelector('[data-radix-dialog-content], [data-radix-popover-content], [cmdk-root]')` — let dialogs/popovers/command-palette handle their own keys.
4. **Command palette open**: `useCommandPaletteStore.getState().isOpen` — pass through.

#### Mode Transitions

| Trigger | From | To | Action |
|---|---|---|---|
| `Escape` | insert | normal | `enterNormalMode()` (blurs active input) |
| `Escape` | normal (help open) | normal | `setHelpOverlayOpen(false)` |
| `Escape` | normal (no overlay) | — | Do nothing, let it propagate (for modals) |
| `I` (Shift+I) | normal | insert | Open left sidebar if collapsed, dispatch `hive:focus-project-filter` event |
| `focusin` on INPUT/TEXTAREA/contentEditable | normal | insert | Auto-switch (but NOT if inside `[data-radix-dialog-content]`, `[cmdk-root]`, or `[data-radix-popover-content]`) |
| `focusout` from input | insert | normal | Only if new `document.activeElement` is not an input/textarea/contentEditable |

#### Hint Dispatch (Normal Mode Only)

Two-stage keystroke matching, reusing the existing `useHintStore` pending mechanism:

1. **Uppercase letter `A-Z`** (no modifiers): Call `useHintStore.getState().enterPending(event.key)`. `preventDefault()`.
2. **While `mode === 'pending'`** (second keystroke):
   - Build `code = pendingChar + event.key.toLowerCase()`
   - Search for match in `useHintStore.getState().hintMap` (worktree/project hints) — iterate entries, find where `code === value`
   - Search for match in `useHintStore.getState().sessionHintMap` (session hints) — iterate entries, find where `code === value`
   - If worktree match found: call `dispatchHintAction(matchedKey)` (existing function from `ProjectFilter.tsx`, will be extracted)
   - If project match found: call `useProjectStore.getState().toggleProjectExpanded(projectId)`
   - If session match found: call `useSessionStore.getState().setActiveSession(sessionId)` + `useFileViewerStore.getState().setActiveFile(null)`
   - If another uppercase letter: restart pending with new char
   - If no match: call `exitPending()`

#### hjkl + Arrow Navigation (Normal Mode Only)

| Key | Action |
|---|---|
| `j` or `ArrowDown` | Select next worktree in sidebar |
| `k` or `ArrowUp` | Select previous worktree in sidebar |
| `h` or `ArrowLeft` | Switch to previous session tab |
| `l` or `ArrowRight` | Switch to next session tab |

**j/k implementation**: Build a flat ordered list of all visible worktrees:
```typescript
const visibleWorktrees: string[] = []
for (const project of projects) {  // useProjectStore.getState().projects
  if (!expandedProjectIds.has(project.id)) continue
  const wts = worktreesByProject.get(project.id) ?? []
  for (const wt of wts) {
    visibleWorktrees.push(wt.id)
  }
}
```
Find `selectedWorktreeId` index, move ±1 (clamped). Call `useWorktreeStore.getState().selectWorktree(newId)` and `useProjectStore.getState().selectProject(projectIdForNewWorktree)`.

**h/l implementation**: Read `tabOrderByWorktree.get(selectedWorktreeId)` and `activeSessionId` from `useSessionStore`. Find current index, move ±1 (clamped). Call `setActiveSession(newSessionId)`.

#### Help Overlay

| Key | Action |
|---|---|
| `?` (Shift+/) | `useVimModeStore.getState().toggleHelpOverlay()` |

#### Registration

Call `useVimNavigation()` in `AppLayout.tsx` right after `useKeyboardShortcuts()`.

---

### 3. `src/renderer/src/components/ui/HelpOverlay.tsx`

Full-screen overlay component. Renders when `useVimModeStore.helpOverlayOpen === true`.

**Layout**: Fixed inset-0, z-50, semi-transparent backdrop (`bg-black/60`), centered content card with max-width.

**Sections**:

1. **Mode indicator**: Shows current mode pill (NORMAL / INSERT)
2. **Navigation keys** (static):
   ```
   j / ↓     Navigate down (worktrees)
   k / ↑     Navigate up (worktrees)
   h / ←     Previous session tab
   l / →     Next session tab
   I         Focus project filter (insert mode)
   Esc       Return to normal mode
   ?         Toggle this overlay
   ```
3. **Dynamic worktree hints**: Read `useHintStore.hintMap`, resolve worktree names from `useWorktreeStore`, display as a grid of `[code] → [worktree name]`
4. **Dynamic session hints**: Read `useHintStore.sessionHintMap`, resolve session names from `useSessionStore`, display as `[code] → [session name]`
5. **System shortcuts**: Read from `DEFAULT_SHORTCUTS` in `keyboard-shortcuts.ts`, format with `formatBinding()`, display grouped by category

**Closes on**: `Escape`, `?`, or backdrop click.

**Render in `AppLayout.tsx`**:
```tsx
import { HelpOverlay } from '@/components/ui/HelpOverlay'
// ... inside the return, after other overlays:
<HelpOverlay />
```

---

## Modified Files

### 4. `src/renderer/src/stores/useHintStore.ts`

Add session hint support:

```typescript
// New fields:
sessionHintMap: Map<string, string>           // sessionId → code (e.g., "Sa")
sessionHintTargetMap: Map<string, string>     // sessionId → sessionId

// New actions:
setSessionHints: (map: Map<string, string>, targetMap: Map<string, string>) => void
clearSessionHints: () => void
```

Update `clearHints()` to also clear session hints.

---

### 5. `src/renderer/src/lib/hint-utils.ts`

#### Add `HintTarget.kind: 'project'`

Extend the existing `HintTarget` interface:
```typescript
export interface HintTarget {
  kind: 'worktree' | 'plus' | 'project'  // add 'project'
  worktreeId?: string
  projectId: string
}
```

Update `assignHints()` — the key for project targets: `'project:' + target.projectId`.

#### Add `assignSessionHints()`

New exported function:
```typescript
export function assignSessionHints(sessionIds: string[]): {
  sessionHintMap: Map<string, string>       // sessionId → code
  sessionHintTargetMap: Map<string, string> // sessionId → sessionId
}
```

Generates codes with `S` as fixed first char: `Sa`, `Sb`, ..., `Sz`, `S2`, ..., `S9` (up to 34 sessions). Uses `SECOND_CHARS` for the second character.

---

### 6. `src/renderer/src/components/projects/ProjectList.tsx`

**Current behavior** (lines 108-123): Hints only computed when `filterQuery.trim()` is non-empty.

**New behavior**: Also compute hints when `filterQuery` is empty AND `vimMode === 'normal'`:

```typescript
const vimMode = useVimModeStore((s) => s.mode)

const { hintMap, hintTargetMap } = useMemo(() => {
  if (!filterQuery.trim() && vimMode !== 'normal') {
    return { hintMap: new Map(), hintTargetMap: new Map() }
  }

  const targets: HintTarget[] = []
  const sourceProjects = filterQuery.trim() ? filteredProjects : /* all expanded projects */

  for (const { project } of sourceProjects) {
    const wts = worktreesByProject.get(project.id) ?? []
    if (filterQuery.trim()) {
      // Existing behavior: include plus target + all worktrees
      targets.push({ kind: 'plus', projectId: project.id })
      for (const wt of wts) {
        targets.push({ kind: 'worktree', worktreeId: wt.id, projectId: project.id })
      }
    } else {
      // Normal mode (no filter): only expanded projects
      if (expandedProjectIds.has(project.id)) {
        targets.push({ kind: 'project', projectId: project.id })
        for (const wt of wts) {
          targets.push({ kind: 'worktree', worktreeId: wt.id, projectId: project.id })
        }
      }
    }
  }
  // ...assign hints
}, [filteredProjects, worktreesByProject, filterQuery, vimMode, expandedProjectIds])
```

Update the `useEffect` that calls `setHints`/`clearHints` (lines 134-143) to also set hints when `vimMode === 'normal'` and filter is empty.

---

### 7. `src/renderer/src/components/worktrees/WorktreeItem.tsx`

**Line 638** — Change hint badge visibility condition:

```tsx
// Before:
{hint && inputFocused && <HintBadge code={hint} mode={hintMode} pendingChar={hintPendingChar} />}

// After:
const vimMode = useVimModeStore((s) => s.mode)
// ...
{hint && (inputFocused || vimMode === 'normal') && (
  <HintBadge code={hint} mode={hintMode} pendingChar={hintPendingChar} />
)}
```

Add `useVimModeStore` import.

---

### 8. `src/renderer/src/components/projects/ProjectItem.tsx`

**Line 331** — Same change as WorktreeItem for the plus hint badge:

```tsx
// Before:
{!isEditing && plusHint && inputFocused && (
  <HintBadge code={plusHint} mode={hintMode} pendingChar={hintPendingChar} />
)}

// After:
const vimMode = useVimModeStore((s) => s.mode)
// ...
{!isEditing && plusHint && (inputFocused || vimMode === 'normal') && (
  <HintBadge code={plusHint} mode={hintMode} pendingChar={hintPendingChar} />
)}
```

Also add a project-level hint badge. Read the project hint from `useHintStore`:
```tsx
const projectHint = useHintStore((s) => s.hintMap.get('project:' + project.id))
```

Render it near the project name (next to the expand chevron or after the name):
```tsx
{!isEditing && projectHint && vimMode === 'normal' && (
  <HintBadge code={projectHint} mode={hintMode} pendingChar={hintPendingChar} />
)}
```

---

### 9. `src/renderer/src/components/sessions/SessionTabs.tsx`

Add session hint computation and rendering.

**In `SessionTabs` component** (after `orderedSessions` is computed, ~line 846):
```typescript
import { assignSessionHints } from '@/lib/hint-utils'
import { useHintStore } from '@/stores'
import { useVimModeStore } from '@/stores'
import { HintBadge } from '@/components/ui/HintBadge'

// Inside SessionTabs():
const vimMode = useVimModeStore((s) => s.mode)
const hintMode = useHintStore((s) => s.mode)
const hintPendingChar = useHintStore((s) => s.pendingChar)
const sessionHintMap = useHintStore((s) => s.sessionHintMap)

// Compute session hints
const sessionHints = useMemo(() => {
  if (vimMode !== 'normal') return new Map<string, string>()
  const sessionIds = orderedSessions.map((s) => s.id)
  const { sessionHintMap, sessionHintTargetMap } = assignSessionHints(sessionIds)
  return sessionHintMap
}, [orderedSessions, vimMode])

// Sync to store
useEffect(() => {
  if (vimMode === 'normal' && sessionHints.size > 0) {
    useHintStore.getState().setSessionHints(sessionHints, sessionHints) // targetMap is identity
  } else {
    useHintStore.getState().clearSessionHints()
  }
  return () => useHintStore.getState().clearSessionHints()
}, [sessionHints, vimMode])
```

**In `SessionTab` component** — add hint badge prop and render:
```tsx
// Add to SessionTabProps:
hintCode?: string

// In render, after the name span (line 203):
{hintCode && vimMode === 'normal' && (
  <HintBadge code={hintCode} mode={hintMode} pendingChar={hintPendingChar} />
)}
```

**Pass hint code from SessionTabs to SessionTab** (around line 982):
```tsx
<SessionTab
  // ... existing props
  hintCode={sessionHints.get(session.id)}
/>
```

---

### 10. `src/renderer/src/components/layout/AppLayout.tsx`

Register the new hook and render the help overlay:

```typescript
import { useVimNavigation } from '@/hooks/useVimNavigation'
import { HelpOverlay } from '@/components/ui/HelpOverlay'

// In AppLayout():
useKeyboardShortcuts()
useVimNavigation()  // Add after useKeyboardShortcuts

// In the return JSX, after <AgentSetupGuard />:
<HelpOverlay />
```

---

### 11. `src/renderer/src/components/layout/Header.tsx`

Add a subtle mode indicator pill badge.

```tsx
import { useVimModeStore } from '@/stores'

// Inside Header component:
const vimMode = useVimModeStore((s) => s.mode)

// In the JSX, in the header bar (e.g., after the worktree/project info area):
<span className={cn(
  'text-[10px] font-mono px-1.5 py-0.5 rounded border select-none',
  vimMode === 'normal'
    ? 'text-muted-foreground bg-muted/50 border-border/50'
    : 'text-primary bg-primary/10 border-primary/30'
)}>
  {vimMode === 'normal' ? 'NORMAL' : 'INSERT'}
</span>
```

---

### 12. `src/renderer/src/components/projects/ProjectFilter.tsx`

**Move hint dispatch logic out**. The two-char hint matching currently lives in `ProjectFilter.handleKeyDown` (lines 38-78). This logic moves to `useVimNavigation` for global normal-mode dispatch.

**Simplified `handleKeyDown`**:
```typescript
const handleKeyDown = (e: React.KeyboardEvent): void => {
  if (e.key === 'Escape') {
    onChange('')
    inputRef.current?.blur()
    return
  }
  // Hint dispatch in filter mode (insert mode, filter has text)
  if (e.repeat) return
  if (!value) return

  // Keep existing hint dispatch logic for when filter is active
  // (this handles the case where user is in insert mode typing in filter
  // and wants to use uppercase+lowercase to jump to a filtered result)
  const { mode, pendingChar, hintMap, enterPending, exitPending } = useHintStore.getState()
  const isUppercase = /^[A-Z]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey

  if (mode === 'idle' && isUppercase) {
    e.preventDefault()
    enterPending(e.key)
  } else if (mode === 'pending') {
    const lowerKey = e.key.toLowerCase()
    let matchedKey: string | null = null
    for (const [k, code] of hintMap) {
      if (code[0] === pendingChar && code[1] === lowerKey) {
        matchedKey = k
        break
      }
    }
    if (matchedKey !== null) {
      e.preventDefault()
      dispatchHintAction(matchedKey)
      exitPending()
    } else if (isUppercase) {
      e.preventDefault()
      enterPending(e.key)
    } else {
      exitPending()
    }
  }
}
```

Note: The filter's hint dispatch remains for the **insert-mode-with-filter** use case. The new `useVimNavigation` handles the **normal-mode** hint dispatch independently.

---

### 13. `src/renderer/src/lib/keyboard-shortcuts.ts`

**No changes needed.** The existing `nav:filter-projects` shortcut (bound to `Cmd+G`) is unaffected. The `?` key has no existing binding — it was noted as a possible conflict, but checking line 121-126 confirms `nav:filter-projects` uses `{ key: 'g', modifiers: ['meta'] }`, not `?`.

---

### 14. `src/renderer/src/stores/index.ts`

Add export:
```typescript
export { useVimModeStore } from './useVimModeStore'
```

---

### 15. `src/renderer/src/hooks/index.ts`

Add export:
```typescript
export { useVimNavigation } from './useVimNavigation'
```

---

## Key Interactions & Edge Cases

### Modifier shortcuts are untouched
The vim handler's first guard checks `event.metaKey || event.ctrlKey || event.altKey`. If any modifier is held, the key passes straight through to `useKeyboardShortcuts`. This means `Cmd+K`, `Cmd+T`, `Cmd+P`, `Cmd+B`, etc. all work identically in both modes.

### Tab key
`Tab` toggles build/plan mode via `session:mode-toggle` with `allowInInput: true`. The vim handler does not intercept `Tab`, so this continues working in both modes.

### `?` requires Shift
On US keyboards, `?` is `Shift+/`. The handler checks `event.key === '?'` directly. Since Shift is not `metaKey/ctrlKey/altKey`, the guard passes it through to vim handling. The existing `event.shiftKey` check in `useKeyboardShortcuts` won't match anything since no shortcut binds to `?`.

### Escape in modals/dialogs
When a Radix dialog is open, the guard condition detects `[data-radix-dialog-content]` and passes `Escape` through to the dialog's own handler. The vim handler only consumes `Escape` when:
- In insert mode (to exit insert mode)
- Help overlay is open (to close it)
- No dialog/popover is active

### Command palette
When command palette is open, `useCommandPaletteStore.getState().isOpen` is checked. All keys pass through.

### Auto-insert on click
The `focusin` listener detects when any INPUT/TEXTAREA/contentEditable gains focus (e.g., user clicks into the commit message textarea, a session rename input, etc.) and auto-switches to insert mode. When focus leaves all inputs, mode returns to normal.

**Exception**: Focus events inside Radix dialogs/popovers (detected by checking ancestors for `[data-radix-dialog-content]` or `[data-radix-popover-content]`) do NOT trigger insert mode. These overlays manage their own keyboard handling.

### Hint code capacity
- Worktrees + projects: 26 × 34 = 884 codes (first char A-Z, second char a-z + 2-9)
- Sessions: 34 codes (fixed `S` prefix, second char from `SECOND_CHARS`)
- No collision between worktree codes and session codes since session codes always start with `S` and `S` is excluded from worktree first-chars — **wait, this IS a potential collision.** Solution: When computing worktree/project hints in normal mode, skip `S` as a first character (pass `buildFirstChars` a filter to exclude `S`). Or simpler: use `FIRST_CHARS.replace('S', '')` for the worktree hint pool. This reserves `S*` codes exclusively for sessions.

### Scrolling worktree into view
When `j`/`k` selects a new worktree, the sidebar should scroll to make it visible. After calling `selectWorktree(newId)`, also scroll the element into view:
```typescript
setTimeout(() => {
  document.querySelector(`[data-testid="worktree-item-${newId}"]`)?.scrollIntoView({
    block: 'nearest',
    behavior: 'smooth'
  })
}, 50)
```

### Session tab scroll into view
Similarly for `h`/`l`, after switching session:
```typescript
setTimeout(() => {
  document.querySelector(`[data-testid="session-tab-${newSessionId}"]`)?.scrollIntoView({
    inline: 'nearest',
    behavior: 'smooth'
  })
}, 50)
```

---

## Implementation Order

| Step | File | What |
|---|---|---|
| 1 | `stores/useVimModeStore.ts` | New store (no dependencies) |
| 2 | `stores/useHintStore.ts` | Add `sessionHintMap`, `sessionHintTargetMap`, `setSessionHints`, `clearSessionHints` |
| 3 | `lib/hint-utils.ts` | Add `kind: 'project'` to `HintTarget`, add `assignSessionHints()`, reserve `S` prefix |
| 4 | `stores/index.ts` | Export `useVimModeStore` |
| 5 | `hooks/useVimNavigation.ts` | Core hook (mode transitions, hint dispatch, hjkl, help overlay toggle) |
| 6 | `hooks/index.ts` | Export `useVimNavigation` |
| 7 | `components/projects/ProjectList.tsx` | Compute hints in normal mode without filter |
| 8 | `components/worktrees/WorktreeItem.tsx` | Show hint badge in normal mode |
| 9 | `components/projects/ProjectItem.tsx` | Show project + plus hint badges in normal mode |
| 10 | `components/sessions/SessionTabs.tsx` | Compute + render session hint badges |
| 11 | `components/ui/HelpOverlay.tsx` | New help overlay component |
| 12 | `components/layout/AppLayout.tsx` | Register hook + render overlay |
| 13 | `components/layout/Header.tsx` | Mode indicator pill |
| 14 | `components/projects/ProjectFilter.tsx` | Keep insert-mode hint dispatch, no other changes needed |

---

## Testing Checklist

- [ ] Normal mode: pressing `j`/`k` navigates worktrees up/down
- [ ] Normal mode: pressing `h`/`l` navigates session tabs left/right
- [ ] Normal mode: arrow keys work same as hjkl
- [ ] Normal mode: hint badges visible on all expanded worktrees, projects, and session tabs
- [ ] Normal mode: typing a two-letter worktree code selects that worktree
- [ ] Normal mode: typing a two-letter project code toggles expand/collapse
- [ ] Normal mode: typing `S` + letter switches to that session tab
- [ ] Normal mode: `I` (Shift+I) focuses the project filter, enters insert mode
- [ ] Normal mode: `?` opens help overlay
- [ ] Normal mode: `Cmd+T`, `Cmd+K`, `Cmd+P` etc. still work
- [ ] Insert mode: all letters type into the focused input
- [ ] Insert mode: `Escape` blurs input, returns to normal mode
- [ ] Insert mode: hint badges hidden
- [ ] Insert mode with filter text: uppercase+lowercase hint dispatch still works in filter
- [ ] Help overlay: shows all static keys + dynamic worktree/session codes
- [ ] Help overlay: closes on `Escape`, `?`, or backdrop click
- [ ] Header shows NORMAL/INSERT mode indicator
- [ ] Dialogs/modals: vim keys don't fire while a dialog is open
- [ ] Command palette: vim keys don't fire while palette is open
- [ ] Tab key still toggles build/plan mode in both modes
- [ ] No `S`-prefixed codes appear in worktree hints (reserved for sessions)
- [ ] Worktree scrolls into view on j/k navigation
- [ ] Session tab scrolls into view on h/l navigation
