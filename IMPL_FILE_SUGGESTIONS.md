# Implementation Plan: @ File Mentions

Reference: [PRD_FILE_SUGGESTIONS.md](./PRD_FILE_SUGGESTIONS.md)

---

## Session 1: Extract Shared Utilities & Add Setting

**Goal:** Move `flattenTree`/`scoreMatch` to a shared util, add the `stripAtMentions` setting to the store and settings UI.

### Tasks

1. **Create `src/renderer/src/lib/file-search-utils.ts`**
   - Move `flattenTree()` and `scoreMatch()` from `FileSearchDialog.tsx` into this new file.
   - Export the `FlatFile` and `FileTreeNode` interfaces from here.
   - Update `FileSearchDialog.tsx` to import from `@/lib/file-search-utils` instead of defining locally.

2. **Add `stripAtMentions` to settings store**
   - In `useSettingsStore.ts`:
     - Add `stripAtMentions: boolean` to the `AppSettings` interface (under a `// Chat` comment group).
     - Add `stripAtMentions: true` to `DEFAULT_SETTINGS`.
     - Add `stripAtMentions: state.stripAtMentions` to `extractSettings()`.
     - Add `stripAtMentions: state.stripAtMentions` to the `partialize` config.

3. **Add toggle to `SettingsGeneral.tsx`**
   - Destructure `stripAtMentions` from `useSettingsStore`.
   - Add a toggle row after the "Model icons" row, before "Branch Naming".
   - Use the same `<button role="switch">` pattern as the existing toggles.
   - Label: "Strip @ from file mentions"
   - Description: "Remove the @ symbol from file references inserted via the file picker before sending"
   - `data-testid="strip-at-mentions-toggle"`

### Definition of Done

- `flattenTree` and `scoreMatch` are importable from `@/lib/file-search-utils`.
- `FileSearchDialog` still works identically (imports changed, no behavior change).
- Settings store has `stripAtMentions` defaulting to `true`.
- Settings UI shows the toggle and it persists on reload.

### Test File: `test/file-mentions/session-1-utils-and-settings.test.ts`

```
Tests:
- flattenTree: still works after move (import from new location)
- scoreMatch: still works after move (import from new location)
- stripAtMentions defaults to true in DEFAULT_SETTINGS
- updateSetting('stripAtMentions', false) changes the value
- extractSettings includes stripAtMentions
```

### Verification

```bash
pnpm vitest run test/file-mentions/session-1-utils-and-settings.test.ts
pnpm vitest run test/phase-9/session-11/file-search-dialog.test.ts  # confirm no regression
pnpm lint
```

---

## Session 2: Core `useFileMentions` Hook — Trigger Detection & State

**Goal:** Build the hook that detects `@` triggers in the input, manages popover open/close state, and filters the file list.

### Tasks

1. **Create `src/renderer/src/hooks/useFileMentions.ts`**
   - Define types:
     ```ts
     interface FileMention {
       relativePath: string
       startIndex: number
       endIndex: number
     }
     ```
   - Hook signature: `useFileMentions(inputValue: string, cursorPosition: number, fileTree: FileTreeNode[])`
   - Internal state: `isOpen`, `query`, `triggerIndex`, `selectedIndex`, `mentions` (array of `FileMention`).
   - Memoize `flatFiles` from `flattenTree(fileTree)` — only recompute when `fileTree` reference changes.

2. **Implement trigger detection logic**
   - Scan backward from `cursorPosition` to find the nearest `@`.
   - If `@` is found AND it is at position 0, or preceded by a space/newline → it's a valid trigger.
   - Extract `query` = text between `@` and `cursorPosition` (exclusive of `@`).
   - If query contains a space → close popover (user abandoned the mention).
   - Set `isOpen = true` when valid trigger is active, `false` otherwise.

3. **Implement filtering**
   - When `isOpen && query === ''` → return first 5 files alphabetically by `relativePath`.
   - When `isOpen && query !== ''` → run `scoreMatch` against `flatFiles`, take top 5 with score > 0, sorted by score desc then alphabetically.
   - Expose as `suggestions: FlatFile[]`.

4. **Implement keyboard navigation state**
   - `selectedIndex` resets to 0 when `query` changes.
   - Expose `moveSelection(direction: 'up' | 'down')` — wraps around.

5. **Implement `selectFile(file: FlatFile)` → returns insertion data**
   - Returns `{ newValue: string, newCursorPosition: number, mention: FileMention }`.
   - Replaces the range `[triggerIndex, cursorPosition]` in `inputValue` with `@{file.relativePath} `.
   - Computes the `FileMention` with correct `startIndex`/`endIndex`.
   - Sets `isOpen = false`.

6. **Implement `dismiss()`**
   - Sets `isOpen = false` without modifying text.

### Definition of Done

- The hook correctly identifies `@` triggers at word boundaries.
- Mid-word `@` (e.g. `user@test`) does NOT open the popover.
- Filtering works with proper priority scoring.
- `selectFile` returns correct text replacement data.
- All logic is pure/testable without React rendering.

### Test File: `test/file-mentions/session-2-use-file-mentions.test.ts`

```
Tests:
Trigger detection:
- '@' at position 0 opens popover
- ' @' (space then @) opens popover
- '\n@' (newline then @) opens popover
- 'user@' (mid-word) does NOT open popover
- 'a@b' does NOT open popover
- '@' followed by space closes popover

Filtering:
- empty query returns first 5 files alphabetically
- query 'help' matches 'helpers.ts' with filename-contains score
- query 'src/u' matches 'src/utils/helpers.ts' with path-contains score
- exact filename match scores highest
- max 5 results returned

Selection:
- selectFile replaces '@que' with '@src/utils/helpers.ts ' and returns correct mention
- selectFile appends trailing space after path
- mention has correct startIndex and endIndex

Navigation:
- moveSelection('down') increments selectedIndex
- moveSelection('down') wraps from last to 0
- moveSelection('up') wraps from 0 to last
- selectedIndex resets to 0 when query changes
```

### Verification

```bash
pnpm vitest run test/file-mentions/session-2-use-file-mentions.test.ts
pnpm lint
```

---

## Session 3: Mention Tracking — Index Adjustment & Stripping

**Goal:** Add the logic that tracks inserted mentions through subsequent edits and strips `@` on send.

### Tasks

1. **Add mention tracking to the hook**
   - After `selectFile`, the returned `FileMention` should be added to an internal `mentions` array.
   - Expose `mentions` as read-only from the hook.

2. **Implement `updateMentions(oldValue: string, newValue: string)` in the hook**
   - Called whenever `inputValue` changes (passed in by the consumer).
   - Detect the diff between old and new value (simple: find the first differing character and the length change).
   - For each tracked mention:
     - If the edit is entirely **before** the mention → shift `startIndex`/`endIndex` by the length delta.
     - If the edit is entirely **after** the mention → no change.
     - If the edit **overlaps** the mention range → remove that mention from tracking (it's broken).
   - Also validate: check that `newValue.substring(mention.startIndex, mention.endIndex)` still equals `@{mention.relativePath}`. If not, remove the mention.

3. **Implement `applyStripping(text: string, mentions: FileMention[]): string`**
   - Pure function (exported separately for testing).
   - Iterate mentions sorted by `startIndex` descending (process from end to start to preserve indices).
   - For each mention, remove the `@` at `mention.startIndex` (shift the substring by 1).
   - Return the modified text.

4. **Expose `getTextForSend(stripAtMentions: boolean): string`**
   - If `stripAtMentions` is `true` → call `applyStripping(inputValue, mentions)`.
   - If `false` → return `inputValue` as-is.

### Definition of Done

- Mentions survive edits before/after them with corrected indices.
- Mentions are removed when the user edits text inside their range.
- `applyStripping` correctly removes only the `@` from tracked mentions, leaving manually typed `@` intact.
- `getTextForSend` respects the setting.

### Test File: `test/file-mentions/session-3-mention-tracking.test.ts`

```
Tests:
Mention adjustment:
- typing text BEFORE a mention shifts its indices forward
- typing text AFTER a mention does not change its indices
- deleting text BEFORE a mention shifts its indices backward
- editing text INSIDE a mention removes it from tracking
- multiple mentions adjust independently

applyStripping:
- strips '@' from a single mention: '@src/foo.ts' → 'src/foo.ts'
- strips '@' from multiple mentions preserving positions
- does NOT strip manually typed '@' (e.g. '@manual' not in mentions list)
- mixed: 'Check @src/a.ts and @manual' with only first tracked → 'Check src/a.ts and @manual'
- empty mentions array returns text unchanged
- handles mention at start of string
- handles mention at end of string

getTextForSend:
- with stripAtMentions=true, strips tracked mentions
- with stripAtMentions=false, returns text unchanged
```

### Verification

```bash
pnpm vitest run test/file-mentions/session-3-mention-tracking.test.ts
pnpm lint
```

---

## Session 4: `FileMentionPopover` Component

**Goal:** Build the visual popover component that renders file suggestions.

### Tasks

1. **Create `src/renderer/src/components/sessions/FileMentionPopover.tsx`**
   - Props:
     ```ts
     interface FileMentionPopoverProps {
       suggestions: FlatFile[]
       selectedIndex: number
       visible: boolean
       onSelect: (file: FlatFile) => void
       onClose: () => void
       onNavigate: (direction: 'up' | 'down') => void
     }
     ```
   - Return `null` when `!visible`.

2. **Layout & styling**
   - Positioned `absolute bottom-full left-0 right-0 mb-1 z-50` — same as `SlashCommandPopover`.
   - Inner container: `mx-3 rounded-lg border bg-popover text-popover-foreground shadow-md max-h-48 overflow-y-auto`.
   - Each item: flex row with `FileIcon` (import from `@/components/file-tree/FileIcon`), filename bolded, relative path muted.
   - Selected item: `bg-accent text-accent-foreground`.
   - Empty state: "No files found" text.
   - `data-testid="file-mention-popover"` on outer div.
   - `data-testid="file-mention-item"` on each item.

3. **Keyboard handling**
   - Register a `window.addEventListener('keydown', handler, true)` (capture phase, same as `SlashCommandPopover`).
   - `ArrowDown` → `e.preventDefault(); e.stopPropagation(); onNavigate('down')`
   - `ArrowUp` → `e.preventDefault(); e.stopPropagation(); onNavigate('up')`
   - `Enter` → `e.preventDefault(); e.stopPropagation(); onSelect(suggestions[selectedIndex])`
   - `Escape` → `e.preventDefault(); e.stopPropagation(); onClose()`
   - Cleanup listener on unmount or when `!visible`.

4. **Mouse handling**
   - `onMouseEnter` on items sets `selectedIndex` (call parent via a new `onHover(index)` prop, or manage internally).
   - `onClick` on items calls `onSelect(file)`.

5. **Scroll selected item into view**
   - `useEffect` watching `selectedIndex` → `scrollIntoView({ block: 'nearest' })`.

### Definition of Done

- Popover renders a list of up to 5 files with icon, name, and path.
- Keyboard navigation works (arrow keys, enter, escape) without bubbling to the textarea.
- Mouse hover highlights, click selects.
- Visual style matches `SlashCommandPopover`.

### Test File: `test/file-mentions/session-4-file-mention-popover.test.tsx`

```
Tests:
- renders null when visible=false
- renders file suggestions when visible=true
- shows "No files found" when suggestions is empty
- displays filename and relative path for each suggestion
- highlights the selected item with bg-accent
- calls onSelect when Enter is pressed with correct file
- calls onClose when Escape is pressed
- calls onNavigate('down') on ArrowDown
- calls onNavigate('up') on ArrowUp
- calls onSelect when a suggestion is clicked
- has data-testid="file-mention-popover"
```

### Verification

```bash
pnpm vitest run test/file-mentions/session-4-file-mention-popover.test.tsx
pnpm lint
```

---

## Session 5: Integration into SessionView

**Goal:** Wire the hook and popover into `SessionView.tsx` so the full flow works end-to-end.

### Tasks

1. **Add state and hook usage to SessionView**
   - Import `useFileMentions` and `FileMentionPopover`.
   - Import `useFileTreeStore` (already likely available via worktree path).
   - Track cursor position: update a `cursorPositionRef` on every `onChange` and `onKeyUp`/`onClick` of the textarea (via `e.currentTarget.selectionStart`).
   - Call `useFileMentions(inputValue, cursorPosition, fileTree)`.

2. **Modify `handleInputChange`**
   - After setting `inputValue`, call `mentions.updateMentions(oldValue, newValue)` to keep mention indices in sync.
   - Detect if the change was a paste (use a `isPastingRef` flag set in `handlePaste`) — if paste, skip trigger detection for `@` characters introduced by paste.

3. **Modify `handleKeyDown`**
   - If `fileMentions.isOpen` → do NOT process ArrowUp/ArrowDown for prompt history. The popover's capture-phase listener will handle them.
   - If `fileMentions.isOpen` and Enter is pressed → do NOT call `handleSend`. The popover's listener handles it.
   - Add: if Space is pressed while popover is open → call `fileMentions.dismiss()`.

4. **Add `handleFileMentionSelect` callback**
   - Calls `fileMentions.selectFile(file)` to get `{ newValue, newCursorPosition, mention }`.
   - Sets `inputValue` to `newValue`.
   - Sets cursor position on the textarea to `newCursorPosition` (via `requestAnimationFrame` + `setSelectionRange`).
   - Focuses the textarea.

5. **Modify `handleSend`**
   - Before processing, compute `textToSend = fileMentions.getTextForSend(stripAtMentions)`.
   - Use `textToSend` instead of raw `inputValue` for:
     - The text in `createLocalMessage('user', textToSend)`.
     - The `parts` sent to `window.opencodeOps.prompt()`.
   - After send, clear mentions: `fileMentions.clearMentions()`.

6. **Render `FileMentionPopover`**
   - Place it next to `SlashCommandPopover` inside the `relative` container, before the `overflow-hidden` wrapper:
     ```tsx
     <FileMentionPopover
       suggestions={fileMentions.suggestions}
       selectedIndex={fileMentions.selectedIndex}
       visible={fileMentions.isOpen}
       onSelect={handleFileMentionSelect}
       onClose={fileMentions.dismiss}
       onNavigate={fileMentions.moveSelection}
     />
     ```
   - Ensure it only shows when `!showSlashCommands` (slash commands take priority).

### Definition of Done

- Typing `@` at a word boundary in the chat input opens the file popover.
- Typing filters the list in real-time.
- Arrow keys navigate, Enter inserts the file path, Escape dismisses.
- Multiple `@` mentions work in the same message.
- Sending with strip ON removes `@` from selected mentions only.
- Sending with strip OFF keeps `@` as-is.
- Slash commands, prompt history, attachments, and draft saving continue to work.

### Test File: `test/file-mentions/session-5-integration.test.ts`

```
Tests:
Integration (unit-level, mocking window APIs):
- typing '@' at position 0 opens file mention popover
- typing '@' after space opens file mention popover
- typing '@' mid-word does NOT open popover
- selecting a file inserts '@relativePath ' into input
- selecting a file then sending with strip ON sends without '@'
- selecting a file then sending with strip OFF sends with '@'
- slash command popover takes priority over file mention popover
- ArrowUp/Down navigate file suggestions when popover is open (not prompt history)
- Escape closes popover without side effects
- multiple mentions in one message all get stripped correctly
- editing a mention's text removes it from tracking
```

### Verification

```bash
pnpm vitest run test/file-mentions/
pnpm vitest run test/phase-9/session-11/file-search-dialog.test.ts  # regression check
pnpm lint
pnpm build  # full build passes
```

---

## Session 6: Edge Cases, Polish & Final Verification

**Goal:** Handle edge cases, ensure no regressions, and verify the complete feature works.

### Tasks

1. **Edge case: paste handling**
   - In `handlePaste`, set a `isPastingRef.current = true` flag before the default paste behavior.
   - In `handleInputChange`, if `isPastingRef.current` is true, do NOT open the popover for any newly introduced `@` characters. Reset the flag after processing.

2. **Edge case: Backspace closing popover**
   - When popover is open and query is empty, backspace should delete the `@` and close the popover.
   - Verify this works naturally via `handleInputChange` → the `@` disappears → trigger detection fails → `isOpen` goes false.

3. **Edge case: file tree not loaded**
   - If `fileTree` is empty/undefined, the popover can still open but shows "No files found".
   - Ensure `flattenTree([])` returns `[]` gracefully.

4. **Edge case: very long paths**
   - In `FileMentionPopover`, add `truncate` class on the relative path text and `max-w-[400px]` or `overflow-hidden` on the item container.

5. **Edge case: rapid typing performance**
   - Verify no noticeable lag when typing quickly after `@`. The memoized `flatFiles` + sync scoring of 5 results should be fast, but confirm.

6. **Accessibility**
   - Add `role="listbox"` on the suggestions container.
   - Add `role="option"` and `aria-selected` on each item.
   - Add `aria-expanded` and `aria-haspopup="listbox"` on the textarea when popover is open.

7. **Final regression suite**
   - Run all existing tests.
   - Run lint and build.

### Definition of Done

- All edge cases from the PRD are handled.
- No regressions in existing features.
- Build and lint pass cleanly.

### Test File: `test/file-mentions/session-6-edge-cases.test.ts`

```
Tests:
- pasted text containing '@' does NOT open popover
- backspace on empty query (just '@') closes popover
- empty file tree shows "No files found"
- very long path is truncated in display but fully inserted on select
- popover has role="listbox"
- suggestion items have role="option" and aria-selected
```

### Verification

```bash
pnpm vitest run test/file-mentions/
pnpm test          # full test suite
pnpm lint
pnpm build
```

---

## Summary: File Inventory

### New Files

| File                                                          | Session |
| ------------------------------------------------------------- | ------- |
| `src/renderer/src/lib/file-search-utils.ts`                   | 1       |
| `src/renderer/src/hooks/useFileMentions.ts`                   | 2, 3    |
| `src/renderer/src/components/sessions/FileMentionPopover.tsx` | 4       |
| `test/file-mentions/session-1-utils-and-settings.test.ts`     | 1       |
| `test/file-mentions/session-2-use-file-mentions.test.ts`      | 2       |
| `test/file-mentions/session-3-mention-tracking.test.ts`       | 3       |
| `test/file-mentions/session-4-file-mention-popover.test.tsx`  | 4       |
| `test/file-mentions/session-5-integration.test.ts`            | 5       |
| `test/file-mentions/session-6-edge-cases.test.ts`             | 6       |

### Modified Files

| File                                                           | Session | Change                           |
| -------------------------------------------------------------- | ------- | -------------------------------- |
| `src/renderer/src/components/file-search/FileSearchDialog.tsx` | 1       | Import from shared utils         |
| `src/renderer/src/stores/useSettingsStore.ts`                  | 1       | Add `stripAtMentions`            |
| `src/renderer/src/components/settings/SettingsGeneral.tsx`     | 1       | Add toggle UI                    |
| `src/renderer/src/components/sessions/SessionView.tsx`         | 5       | Wire hook + popover + send logic |

### Session Dependency Graph

```
Session 1 (utils + settings)
    ↓
Session 2 (hook: trigger + filter)
    ↓
Session 3 (hook: tracking + stripping)
    ↓
Session 4 (popover component)  ← can run in parallel with Session 3
    ↓
Session 5 (integration)
    ↓
Session 6 (edge cases + polish)
```
