# Vim-Style Keyboard Navigation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add vim-style modal navigation covering ALL navigable areas of Hive — sidebar, session tabs, file viewer tabs, right sidebar tabs (changes/files/diffs), bottom panel tabs (setup/run/terminal), and a `?` help overlay with highlighted mnemonic letters.

**Architecture:** `useVimModeStore` tracks modal state. A capture-phase `useVimNavigation` hook intercepts keystrokes in normal mode. Two-letter hint codes use the existing hint system (sessions reserved under `S` prefix). Single-letter mnemonics (`c`/`f`/`d`/`s`/`r`/`t`/`[`/`]`) navigate panels and tabs directly.

**Normal Mode Keyboard Map:**

| Key | Action |
|-----|--------|
| `j` / `↓` | Next worktree in sidebar |
| `k` / `↑` | Previous worktree in sidebar |
| `h` / `←` | Previous session tab |
| `l` / `→` | Next session tab |
| `A-Z` (two-char) | Hint codes for worktrees/projects |
| `S` + char | Session tab hint codes |
| `I` | Focus project filter → insert mode |
| `Escape` | Return to normal mode / close help |
| `?` | Toggle help overlay |
| `c` | Right sidebar → **C**hanges tab |
| `f` | Right sidebar → **F**iles tab |
| `d` | Right sidebar → **D**iffs tab |
| `s` | Bottom panel → **S**etup tab |
| `r` | Bottom panel → **R**un tab |
| `t` | Bottom panel → **T**erminal tab |
| `[` | Previous file/diff tab |
| `]` | Next file/diff tab |

---

## Session 1: Core Stores & Utilities

**Goal:** Build the data layer — vim mode store, hint store extensions, hint utility functions.

### Tasks

- [ ] **1.1** Create `test/vim-navigation/vim-mode-store.test.ts` with tests:
  - Starts in `'normal'` mode, `helpOverlayOpen: false`
  - `enterInsertMode()` → mode='insert'
  - `enterNormalMode()` → mode='normal' + calls `document.activeElement.blur()`
  - `toggleHelpOverlay()` toggles boolean
  - `setHelpOverlayOpen(false)` explicitly closes
- [ ] **1.2** Run tests → verify FAIL (module not found)
- [ ] **1.3** Create `src/renderer/src/stores/useVimModeStore.ts` — Zustand store with `mode`, `helpOverlayOpen`, four actions
- [ ] **1.4** Run tests → verify PASS
- [ ] **1.5** Commit: `feat: add useVimModeStore`
- [ ] **1.6** Create `test/vim-navigation/hint-utils-extensions.test.ts` with tests:
  - `assignHints` generates key `'project:p1'` for `kind:'project'` targets
  - `assignHints` with `excludeFirstChars:'S'` produces no `S`-prefixed codes
  - `assignSessionHints([])` → empty maps
  - `assignSessionHints(['s1','s2','s3'])` → `{s1:'Sa', s2:'Sb', s3:'Sc'}`
  - `assignSessionHints` handles 34 sessions (full SECOND_CHARS capacity)
  - `assignSessionHints` with >34 sessions gracefully skips overflow
  - `dispatchHintAction('plus:p1')` dispatches `hive:hint-plus` event
  - `dispatchHintAction('project:p1')` calls `toggleProjectExpanded`
  - `dispatchHintAction('w1')` calls `selectWorktree` + `selectProject`
- [ ] **1.7** Run tests → verify FAIL
- [ ] **1.8** Update `src/renderer/src/lib/hint-utils.ts`:
  - Add `'project'` to `HintTarget.kind` union
  - Add `excludeFirstChars` optional param to `buildFirstChars()` and `assignHints()`
  - Add key derivation for project targets: `'project:' + projectId`
  - Add exported `assignSessionHints(sessionIds)` function (S + SECOND_CHARS)
  - Add exported `dispatchHintAction(key)` function (moved from ProjectFilter.tsx)
- [ ] **1.9** Update `src/renderer/src/components/projects/ProjectFilter.tsx`: replace local `dispatchHintAction` (lines 12-22) with `import { dispatchHintAction } from '@/lib/hint-utils'`
- [ ] **1.10** Run tests → verify PASS
- [ ] **1.11** Commit: `feat: extend hint-utils with project kind, session hints, S-reservation, dispatchHintAction`
- [ ] **1.12** Create `test/vim-navigation/hint-store-sessions.test.ts` with tests:
  - Initial state has empty `sessionHintMap` and `sessionHintTargetMap`
  - `setSessionHints(map, targetMap)` populates both maps
  - `clearSessionHints()` resets both to empty
  - `clearHints()` also clears session maps (integration)
  - Session hints independent of worktree hints
- [ ] **1.13** Run tests → verify FAIL
- [ ] **1.14** Update `src/renderer/src/stores/useHintStore.ts`:
  - Import `HintTarget` from `@/lib/hint-utils` (remove duplicate definition)
  - Add `sessionHintMap: Map<string, string>`, `sessionHintTargetMap: Map<string, string>`
  - Add `setSessionHints`, `clearSessionHints` actions
  - Update `clearHints()` to also clear session maps
- [ ] **1.15** Run tests → verify PASS
- [ ] **1.16** Add export to `src/renderer/src/stores/index.ts`: `export { useVimModeStore } from './useVimModeStore'`
- [ ] **1.17** Commit: `feat: add session hints to useHintStore, deduplicate HintTarget`

### Definition of Done
- `pnpm vitest run test/vim-navigation/vim-mode-store.test.ts` → PASS
- `pnpm vitest run test/vim-navigation/hint-utils-extensions.test.ts` → PASS
- `pnpm vitest run test/vim-navigation/hint-store-sessions.test.ts` → PASS
- `pnpm lint` → no errors
- ProjectFilter still works (existing hint dispatch imported from shared util)

---

## Session 2: Navigation Hook — Guards & Mode Transitions

**Goal:** Create the `useVimNavigation` hook skeleton with guard conditions and mode transitions.

### Context — Stores to read via `.getState()`
- `useVimModeStore` — mode, enterNormalMode, enterInsertMode, helpOverlayOpen, toggleHelpOverlay, setHelpOverlayOpen
- `useCommandPaletteStore` — isOpen
- `useLayoutStore` — leftSidebarCollapsed, setLeftSidebarCollapsed, rightSidebarCollapsed, setRightSidebarCollapsed, setBottomPanelTab

### Tasks

- [ ] **2.1** Create `test/vim-navigation/vim-navigation-hook.test.ts` — scaffold with store mocks and `fireKey()` helper
- [ ] **2.2** Write guard condition tests:
  - `metaKey=true` → not consumed (passes through)
  - `ctrlKey=true` → not consumed
  - `altKey=true` → not consumed
  - Insert mode + key !== Escape → not consumed
  - Radix dialog present (`[data-radix-dialog-content]`) → not consumed
  - Command palette open → not consumed
- [ ] **2.3** Write mode transition tests:
  - `Escape` in insert mode → calls `enterNormalMode()`
  - `Escape` in normal mode + helpOverlayOpen → calls `setHelpOverlayOpen(false)`
  - `Escape` in normal mode, no overlay → does NOT `preventDefault()` (propagates for modals)
  - `I` (Shift+I) in normal mode → calls `enterInsertMode()`, opens left sidebar if collapsed, dispatches `hive:focus-project-filter`
  - `?` → calls `toggleHelpOverlay()`
- [ ] **2.4** Write focusin/focusout tests:
  - `focusin` on INPUT outside Radix → calls `enterInsertMode()`
  - `focusin` on INPUT inside `[data-radix-dialog-content]` → does NOT switch mode
  - `focusin` on INPUT inside `[cmdk-root]` → does NOT switch mode
  - `focusout` where new `activeElement` is body → calls `enterNormalMode()`
  - `focusout` where new `activeElement` is another INPUT → stays insert
- [ ] **2.5** Run tests → verify FAIL
- [ ] **2.6** Create `src/renderer/src/hooks/useVimNavigation.ts` with:
  - `useEffect` registering capture-phase `keydown`, `focusin`, `focusout` on `document`
  - Guard checks (modifier keys, insert mode, radix overlay, command palette)
  - Escape handling (insert→normal, close help, or propagate)
  - `I` handling (expand sidebar, enterInsertMode, dispatch `hive:focus-project-filter`)
  - `?` handling (toggleHelpOverlay)
  - focusin/focusout handlers with `isInputElement()` and `isInsideRadixOverlay()` helpers
- [ ] **2.7** Add export to `src/renderer/src/hooks/index.ts`: `export { useVimNavigation } from './useVimNavigation'`
- [ ] **2.8** Run tests → verify PASS
- [ ] **2.9** Commit: `feat: useVimNavigation hook with guards, mode transitions, focus tracking`

### Definition of Done
- All guard tests pass — modifiers, insert mode, radix, command palette
- All mode transition tests pass — Escape, I, ?, focusin/focusout
- `pnpm lint` → no errors

---

## Session 3: Navigation Hook — hjkl & Panel Navigation

**Goal:** Add hjkl worktree/session navigation plus single-letter panel/tab shortcuts.

### Context — Additional stores
- `useProjectStore` — projects, expandedProjectIds, selectProject
- `useWorktreeStore` — worktreesByProject, selectedWorktreeId, selectWorktree
- `useSessionStore` — tabOrderByWorktree, activeSessionId, setActiveSession
- `useFileViewerStore` — openFiles, activeFilePath, setActiveFile, activeDiff
- `useLayoutStore` — rightSidebarCollapsed, setRightSidebarCollapsed, setBottomPanelTab

### Tasks

- [ ] **3.1** Add hjkl navigation tests to `vim-navigation-hook.test.ts`:
  - `j` selects next worktree in flat visible list (respects expanded projects)
  - `k` selects previous worktree
  - `ArrowDown` same as `j`, `ArrowUp` same as `k`
  - `j` at last worktree → clamped (no crash)
  - `k` at first worktree → clamped
  - `l` switches to next session tab
  - `h` switches to previous session tab
  - `ArrowRight` same as `l`, `ArrowLeft` same as `h`
  - `h` at first session → clamped
  - `l` at last session → clamped
  - `l` also calls `setActiveFile(null)` to clear file viewer
- [ ] **3.2** Add panel navigation tests:
  - `c` calls `setRightSidebarCollapsed(false)` if collapsed + dispatches `hive:right-sidebar-tab` with `changes`
  - `f` → `hive:right-sidebar-tab` with `files`
  - `d` → `hive:right-sidebar-tab` with `diffs`
  - `s` calls `setBottomPanelTab('setup')` + opens right sidebar if collapsed
  - `r` calls `setBottomPanelTab('run')` + opens right sidebar
  - `t` calls `setBottomPanelTab('terminal')` + opens right sidebar
- [ ] **3.3** Add file tab navigation tests:
  - `[` switches to previous file/diff tab in `openFiles` Map
  - `]` switches to next file/diff tab
  - `[` at first tab → clamped
  - `]` at last tab → clamped
  - With no open files → no-op
- [ ] **3.4** Run tests → verify FAIL
- [ ] **3.5** Implement `navigateWorktree(delta)` helper:
  - Build flat list from `projects` × `expandedProjectIds` × `worktreesByProject`
  - Find current index, clamp delta, call `selectWorktree` + `selectProject`
  - `setTimeout` → `scrollIntoView({ block: 'nearest', behavior: 'smooth' })` on `[data-testid="worktree-item-${id}"]`
- [ ] **3.6** Implement `navigateSession(delta)` helper:
  - Read `tabOrderByWorktree.get(selectedWorktreeId)`, find `activeSessionId` index
  - Clamp delta, call `setActiveSession` + `setActiveFile(null)`
  - `setTimeout` → `scrollIntoView` on `[data-testid="session-tab-${id}"]`
- [ ] **3.7** Implement `navigateFileTab(delta)` helper:
  - Read `Array.from(openFiles.keys())`, find `activeFilePath` index
  - Clamp delta, call `setActiveFile(newPath)`
- [ ] **3.8** Implement panel shortcuts in `handleKeyDown`:
  - `c`/`f`/`d` → open right sidebar if collapsed + dispatch `hive:right-sidebar-tab` custom event
  - `s`/`r`/`t` → open right sidebar if collapsed + call `setBottomPanelTab()`
  - `[`/`]` → call `navigateFileTab(±1)`
- [ ] **3.9** Run tests → verify PASS
- [ ] **3.10** Commit: `feat: hjkl navigation, panel shortcuts, file tab cycling`

### Definition of Done
- j/k navigates worktrees correctly with clamping
- h/l navigates session tabs correctly with clamping
- c/f/d switches right sidebar tabs (via custom event)
- s/r/t switches bottom panel tabs (via store action)
- [/] cycles file viewer tabs
- All panel shortcuts auto-expand right sidebar if collapsed
- `pnpm vitest run test/vim-navigation/` → PASS

---

## Session 4: Navigation Hook — Hint Dispatch

**Goal:** Add two-letter hint code dispatch for worktrees, projects, and sessions.

### Tasks

- [ ] **4.1** Add hint dispatch tests to `vim-navigation-hook.test.ts`:
  - Uppercase `A` in idle mode → calls `enterPending('A')`
  - Second char `a` with pending `A` + hintMap has `Aa` → calls `dispatchHintAction` with matched key
  - Second char matching session hint (e.g. `Sa`) → calls `setActiveSession(id)` + `setActiveFile(null)`
  - Second uppercase letter → restarts pending with new char
  - Non-matching second char → calls `exitPending()`
  - Project hint match (key starts with `project:`) → calls `toggleProjectExpanded`
- [ ] **4.2** Run tests → verify FAIL
- [ ] **4.3** Implement hint dispatch in `handleKeyDown`:
  - Idle + uppercase A-Z → `enterPending(event.key)`
  - Pending → build code from `pendingChar + lowerKey`, search `hintMap` then `sessionHintMap`
  - Worktree/project match → `dispatchHintAction(key)` + `exitPending()`
  - Session match → `setActiveSession(id)` + `setActiveFile(null)` + `exitPending()` + scrollIntoView
  - Another uppercase → restart pending
  - No match → `exitPending()`
- [ ] **4.4** Run tests → verify PASS
- [ ] **4.5** Commit: `feat: two-letter hint dispatch for worktrees, projects, sessions`

### Definition of Done
- Typing `Aa` selects the worktree with hint code `Aa`
- Typing `Sa` switches to the session with hint code `Sa`
- Typing a project code toggles expand/collapse
- Invalid second chars exit pending cleanly
- `pnpm vitest run test/vim-navigation/` → PASS

---

## Session 5: Sidebar Hint Badges

**Goal:** Make hint badges visible in normal mode on worktrees, projects, and the plus button.

### Files to modify
- `src/renderer/src/components/projects/ProjectList.tsx` (hint computation)
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` (badge visibility)
- `src/renderer/src/components/projects/ProjectItem.tsx` (project + plus badges)

### Tasks

- [ ] **5.1** In `ProjectList.tsx` — add `const vimMode = useVimModeStore((s) => s.mode)`
- [ ] **5.2** Update `useMemo` (lines ~108-123): compute hints when `filterQuery.trim()` is non-empty OR `vimMode === 'normal'`
  - Filter mode: existing behavior (plus + worktree targets)
  - Normal mode (no filter): project targets + worktree targets for expanded projects only
  - Pass `excludeFirstChars: 'S'` in normal mode (reserves S for sessions)
- [ ] **5.3** Update `useEffect` (lines ~134-143): call `setHints()` when `filterQuery.trim() || vimMode === 'normal'`
- [ ] **5.4** In `WorktreeItem.tsx` — add `const vimMode = useVimModeStore((s) => s.mode)`
  - Change condition: `hint && inputFocused` → `hint && (inputFocused || vimMode === 'normal')`
- [ ] **5.5** In `ProjectItem.tsx` — add `const vimMode = useVimModeStore((s) => s.mode)`
  - Change plus badge: `plusHint && inputFocused` → `plusHint && (inputFocused || vimMode === 'normal')`
  - Add project hint: `const projectHint = useHintStore((s) => s.hintMap.get('project:' + project.id))`
  - Render project badge: `projectHint && vimMode === 'normal'` → `<HintBadge code={projectHint} ... />`
- [ ] **5.6** `pnpm lint` → PASS
- [ ] **5.7** Commit: `feat: show hint badges in vim normal mode on worktrees and projects`

### Definition of Done
- In normal mode (no filter): hint badges visible on all expanded worktrees and projects
- In insert mode: badges hidden (unless filter is active — existing behavior)
- No `S`-prefixed codes appear on worktree/project hints
- `pnpm lint` → PASS

---

## Session 6: Session Tab Hints

**Goal:** Compute and render session hint badges (S-prefixed).

### Files to modify
- `src/renderer/src/components/sessions/SessionTabs.tsx`

### Tasks

- [ ] **6.1** Add imports: `assignSessionHints` from `@/lib/hint-utils`, `useHintStore`, `useVimModeStore`, `HintBadge`
- [ ] **6.2** In `SessionTabs` component (after `orderedSessions`): add vim/hint state subscriptions + `useMemo` for `sessionHints`
- [ ] **6.3** Add `useEffect` to sync session hints to store: `setSessionHints` when normal mode, `clearSessionHints` otherwise + on unmount
- [ ] **6.4** Add `hintCode?: string` prop to `SessionTabProps` interface
- [ ] **6.5** In `SessionTab` component: subscribe to `vimMode`, `hintMode`, `hintPendingChar`; render `<HintBadge>` when `hintCode && vimMode === 'normal'`
- [ ] **6.6** In `SessionTabs` render loop: pass `hintCode={sessionHints.get(session.id)}` to each `<SessionTab>`
- [ ] **6.7** `pnpm lint` → PASS
- [ ] **6.8** Commit: `feat: session tab hint badges with S-prefix codes`

### Definition of Done
- In normal mode: session tabs show `Sa`, `Sb`, ... badges
- In insert mode: session badges hidden
- Switching worktrees recomputes session hints for new worktree's sessions
- `pnpm lint` → PASS

---

## Session 7: Right Sidebar Tab Event Listener

**Goal:** Wire the `hive:right-sidebar-tab` custom event so `c`/`f`/`d` keys actually switch tabs.

### Files to modify
- `src/renderer/src/components/layout/FileSidebar.tsx` (or wherever the right sidebar top tabs live)

### Tasks

- [ ] **7.1** Read `FileSidebar.tsx` to find the local `activeTab` state and tab-switching logic
- [ ] **7.2** Add `useEffect` to listen for `hive:right-sidebar-tab` custom event:
  ```typescript
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab
      if (tab === 'changes' || tab === 'files' || tab === 'diffs') {
        setActiveTab(tab)
      }
    }
    window.addEventListener('hive:right-sidebar-tab', handler)
    return () => window.removeEventListener('hive:right-sidebar-tab', handler)
  }, [])
  ```
- [ ] **7.3** Manual test: press `c`/`f`/`d` in normal mode → right sidebar tab switches
- [ ] **7.4** `pnpm lint` → PASS
- [ ] **7.5** Commit: `feat: right sidebar tab switching via vim keyboard shortcuts`

### Definition of Done
- `c` switches right sidebar to Changes tab
- `f` switches to Files tab
- `d` switches to Diffs tab
- All three auto-expand right sidebar if collapsed
- `pnpm lint` → PASS

---

## Session 8: Help Overlay with Mnemonic Highlighting

**Goal:** Build the `?` overlay showing all shortcuts with highlighted mnemonic letters where applicable.

### Files to create
- `src/renderer/src/components/ui/HelpOverlay.tsx`
- `test/vim-navigation/help-overlay.test.tsx`

### Mnemonic Highlighting Concept
For panel shortcuts, highlight the mnemonic letter in the label:
- `c` → **C**hanges
- `f` → **F**iles
- `d` → **D**iffs
- `s` → **S**etup
- `r` → **R**un
- `t` → **T**erminal

Render as: `<span className="text-primary font-bold">C</span><span>hanges</span>`

### Tasks

- [ ] **8.1** Create `test/vim-navigation/help-overlay.test.tsx`:
  - Renders nothing when `helpOverlayOpen === false`
  - Renders content when `helpOverlayOpen === true`
  - Shows current mode pill (NORMAL/INSERT)
  - Displays static nav keys (j/k/h/l/I/Esc/?)
  - Displays panel mnemonics (c/f/d/s/r/t/[/])
  - Displays dynamic worktree hints from hintMap
  - Displays dynamic session hints from sessionHintMap
  - Closes on backdrop click
- [ ] **8.2** Run tests → verify FAIL
- [ ] **8.3** Create `src/renderer/src/components/ui/HelpOverlay.tsx`:
  - Conditional render on `helpOverlayOpen`
  - Fixed inset-0, z-50, `bg-black/60` backdrop
  - Centered card with sections:
    1. **Mode pill** — NORMAL (muted) / INSERT (primary)
    2. **Vim Navigation** — j/k/h/l + arrows (static)
    3. **Panel Shortcuts** — c/f/d/s/r/t/[/] with **highlighted mnemonic** letter
    4. **Worktree Hints** — dynamic grid from `useHintStore.hintMap` (resolved via `useWorktreeStore`)
    5. **Session Hints** — dynamic grid from `useHintStore.sessionHintMap` (resolved via `useSessionStore`)
    6. **System Shortcuts** — from `DEFAULT_SHORTCUTS`, formatted with `formatBinding()`
  - Closes on: Escape (handled by hook), `?` (handled by hook), backdrop click
- [ ] **8.4** Run tests → verify PASS
- [ ] **8.5** Commit: `feat: HelpOverlay with mnemonic highlighting and dynamic hints`

### Mnemonic Rendering Helper

```typescript
function MnemonicLabel({ letter, label }: { letter: string; label: string }): React.JSX.Element {
  const index = label.toLowerCase().indexOf(letter.toLowerCase())
  if (index === -1) return <span>{label}</span>
  return (
    <span>
      {label.slice(0, index)}
      <span className="text-primary font-bold">{label[index]}</span>
      {label.slice(index + 1)}
    </span>
  )
}
```

### Definition of Done
- `?` opens overlay with all sections populated
- Mnemonic letters are visually highlighted (e.g., **C**hanges, **F**iles, **R**un)
- Dynamic hints resolve to actual worktree/session names
- Backdrop click closes overlay
- `pnpm vitest run test/vim-navigation/help-overlay.test.tsx` → PASS

---

## Session 9: Header Mode Indicator + AppLayout Wiring

**Goal:** Final integration — mode pill in header, hook registration, overlay rendering.

### Files to modify
- `src/renderer/src/components/layout/Header.tsx`
- `src/renderer/src/components/layout/AppLayout.tsx`

### Tasks

- [ ] **9.1** In `Header.tsx`:
  - Add `const vimMode = useVimModeStore((s) => s.mode)`
  - After logo/project info area (~line 421), add mode pill:
    ```tsx
    <span className={cn(
      'text-[10px] font-mono px-1.5 py-0.5 rounded border select-none',
      vimMode === 'normal'
        ? 'text-muted-foreground bg-muted/50 border-border/50'
        : 'text-primary bg-primary/10 border-primary/30'
    )}>
      {vimMode === 'normal' ? 'NORMAL' : 'INSERT'}
    </span>
    ```
- [ ] **9.2** In `AppLayout.tsx`:
  - Import `useVimNavigation` from `@/hooks/useVimNavigation`
  - Import `HelpOverlay` from `@/components/ui/HelpOverlay`
  - Call `useVimNavigation()` right after `useKeyboardShortcuts()`
  - Render `<HelpOverlay />` after `<AgentSetupGuard />`
- [ ] **9.3** `pnpm lint` → PASS
- [ ] **9.4** `pnpm vitest run` → ALL tests PASS (full suite)
- [ ] **9.5** Commit: `feat: header mode pill and AppLayout vim integration`

### Definition of Done
- Header shows NORMAL/INSERT pill that updates in real-time
- `useVimNavigation()` is registered globally in AppLayout
- `<HelpOverlay />` renders in AppLayout
- Full test suite passes with no regressions

---

## Session 10: Manual Testing & Edge Cases

**Goal:** Comprehensive manual QA covering all interactions and edge cases.

### Checklist

- [ ] **10.1** Start app: `pnpm dev`
- [ ] **10.2** Header shows NORMAL pill
- [ ] **10.3** `j`/`k` navigates worktrees up/down, scrolling into view
- [ ] **10.4** `h`/`l` navigates session tabs left/right, scrolling into view
- [ ] **10.5** Arrow keys work identically to hjkl
- [ ] **10.6** Hint badges visible on all expanded worktrees and projects
- [ ] **10.7** Type a worktree hint code (e.g., `Aa`) → selects that worktree
- [ ] **10.8** Type a project hint code → toggles expand/collapse
- [ ] **10.9** Type `S` + letter → switches to that session tab
- [ ] **10.10** `I` (Shift+I) → focuses project filter, header shows INSERT
- [ ] **10.11** Type in filter → letters type normally
- [ ] **10.12** `Escape` → blurs input, header returns to NORMAL
- [ ] **10.13** With filter text: uppercase + lowercase hint dispatch still works
- [ ] **10.14** Insert mode: hint badges hidden
- [ ] **10.15** `c` → right sidebar switches to Changes, expands if collapsed
- [ ] **10.16** `f` → right sidebar switches to Files
- [ ] **10.17** `d` → right sidebar switches to Diffs
- [ ] **10.18** `s` → bottom panel switches to Setup, right sidebar expands
- [ ] **10.19** `r` → bottom panel switches to Run
- [ ] **10.20** `t` → bottom panel switches to Terminal
- [ ] **10.21** `[` → previous file/diff tab, `]` → next
- [ ] **10.22** `?` → help overlay appears with all sections
- [ ] **10.23** Help overlay: mnemonic letters highlighted (**C**hanges, **F**iles, etc.)
- [ ] **10.24** Help overlay: dynamic worktree + session hints displayed
- [ ] **10.25** Help overlay closes on `Escape`, `?`, or backdrop click
- [ ] **10.26** `Cmd+K`/`Cmd+T`/`Cmd+P` etc. still work in normal mode
- [ ] **10.27** Open command palette → vim keys don't fire
- [ ] **10.28** Open a Radix dialog/modal → vim keys don't fire
- [ ] **10.29** `Tab` still toggles build/plan mode in both modes
- [ ] **10.30** No `S`-prefixed codes on worktree hints
- [ ] **10.31** Click into commit textarea → auto-switches to INSERT mode
- [ ] **10.32** Click outside input → auto-switches back to NORMAL mode

---

## Key Files Reference

| File | Action | Session |
|------|--------|---------|
| `src/renderer/src/stores/useVimModeStore.ts` | Create | 1 |
| `src/renderer/src/stores/useHintStore.ts` | Modify | 1 |
| `src/renderer/src/lib/hint-utils.ts` | Modify | 1 |
| `src/renderer/src/stores/index.ts` | Modify | 1 |
| `src/renderer/src/components/projects/ProjectFilter.tsx` | Modify | 1 |
| `src/renderer/src/hooks/useVimNavigation.ts` | Create | 2-4 |
| `src/renderer/src/hooks/index.ts` | Modify | 2 |
| `src/renderer/src/components/projects/ProjectList.tsx` | Modify | 5 |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Modify | 5 |
| `src/renderer/src/components/projects/ProjectItem.tsx` | Modify | 5 |
| `src/renderer/src/components/sessions/SessionTabs.tsx` | Modify | 6 |
| `src/renderer/src/components/layout/FileSidebar.tsx` | Modify | 7 |
| `src/renderer/src/components/ui/HelpOverlay.tsx` | Create | 8 |
| `src/renderer/src/components/layout/Header.tsx` | Modify | 9 |
| `src/renderer/src/components/layout/AppLayout.tsx` | Modify | 9 |

## Test Files

| File | Session |
|------|---------|
| `test/vim-navigation/vim-mode-store.test.ts` | 1 |
| `test/vim-navigation/hint-utils-extensions.test.ts` | 1 |
| `test/vim-navigation/hint-store-sessions.test.ts` | 1 |
| `test/vim-navigation/vim-navigation-hook.test.ts` | 2-4 |
| `test/vim-navigation/help-overlay.test.tsx` | 8 |
