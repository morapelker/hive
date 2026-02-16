# PRD: @ File Mentions in Chat Input

## Overview

Add `@` file mention functionality to the chat input textarea. Typing `@` opens an inline file suggestion popover that filters the project file tree as the user types. Selecting a file inserts its relative path into the message. A global setting controls whether `@` symbols are stripped from mentioned files before sending.

## User Stories

1. **As a user**, I want to type `@` in the chat input and see a list of project files so I can quickly reference them.
2. **As a user**, I want the file list to filter as I type after `@` so I can find files fast.
3. **As a user**, I want to navigate suggestions with arrow keys and select with Enter so I don't need the mouse.
4. **As a user**, I want a setting to control whether `@` is stripped from file references when sending, so the AI receives clean filenames.
5. **As a user**, I want to mention multiple files in one message.

## Detailed Requirements

### 1. Trigger Behavior

| Rule              | Detail                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Trigger character | `@`                                                                                             |
| Trigger position  | **Word boundary only** — must be preceded by a space, newline, or be at position 0 of the input |
| Mid-word `@`      | Ignored (e.g. `user@email.com` does NOT trigger the popover)                                    |
| Multiple mentions | Unlimited per message. Each `@` independently triggers the popover if at a word boundary        |

### 2. File Suggestion Popover

#### Appearance

- Positioned **above** the textarea, anchored to the caret's horizontal position (or left-aligned with the input if caret tracking is too complex).
- Styled consistently with the existing `SlashCommandPopover`: `bg-popover text-popover-foreground border shadow-md rounded-lg`.
- **Maximum 5 items** visible at a time.
- Each item shows: file icon (by extension, using existing conventions or lucide `File`/`Folder` icons), **filename** bolded, and the **relative path** in muted text below or to the right.

#### Data Source

- Uses the **full project file tree** from `useFileTreeStore` (already loaded and watched via chokidar).
- Reuse the existing `flattenTree()` utility from `FileSearchDialog.tsx` to flatten `FileTreeNode[]` into a searchable flat list.
- **Only files** shown (no directories).

#### Filtering & Scoring

- Reuse/adapt the `scoreMatch()` function from `FileSearchDialog.tsx`.
- Match against **both filename and full relative path**.
- Priority order:
  1. **Exact filename match** (highest) — query exactly equals filename
  2. **Filename starts-with** — filename begins with query
  3. **Filename contains** — query is a substring of filename
  4. **Path contains** — query is a substring of the relative path
  5. **Subsequence match** (lowest) — query characters appear in order within the path
- Results sorted by score descending, then alphabetically for ties.
- Return top **5** results max.
- Empty query (just `@` typed, no additional characters) shows the **5 most recently modified files** or the first 5 files alphabetically (implementation choice — alphabetical is simpler and deterministic).

#### Keyboard Navigation

| Key                     | Behavior                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `ArrowDown`             | Move selection down (wrap to top at end)                                              |
| `ArrowUp`               | Move selection up (wrap to bottom at start)                                           |
| `Enter`                 | Select the currently highlighted file and insert it                                   |
| `Escape`                | Close the popover without selecting, keep the `@` text as-is                          |
| `Space`                 | Close the popover without selecting (user is just typing `@` as text)                 |
| Any printable character | Append to the filter query and re-filter                                              |
| `Backspace`             | Remove last character from query. If query is empty and `@` is deleted, close popover |

#### Mouse

- Clicking a suggestion selects and inserts it.
- Clicking outside the popover closes it.

### 3. File Selection & Insertion

When a file is selected:

1. The `@` + any typed query text is **replaced** with `@{relativePath}` (e.g. `@src/components/Button.tsx`).
2. A trailing space is appended after the inserted path so the user can continue typing.
3. The popover closes.
4. Cursor is positioned after the trailing space.
5. The inserted text is **plain text** — no special styling or rich text.

Internally, the component tracks which substrings of the input correspond to file mentions (by index range or by storing the list of mentioned relative paths). This is needed for the stripping logic on send.

### 4. @ Stripping on Send

#### Setting

- **New setting:** `stripAtMentions` (boolean)
- **Default value:** `true` (strip by default)
- **Location in UI:** Settings Modal → General section
- **Label:** "Strip @ from file mentions"
- **Description/helper text:** "Remove the @ symbol from file references when sending messages"
- **Persistence:** Same dual-layer as existing settings (Zustand persist + SQLite)

#### Stripping Logic

- Applies **only** to file paths that were inserted via the `@` popover selection, NOT to any arbitrary `@` the user typed manually.
- On send, if `stripAtMentions` is `true`:
  - For each tracked file mention, remove the leading `@` from that mention in the message text.
  - Example: `"Check @src/utils/helpers.ts and refactor"` → `"Check src/utils/helpers.ts and refactor"`
- On send, if `stripAtMentions` is `false`:
  - Send the message text as-is, including `@` symbols.
- The **displayed message** in the chat history matches what was sent (i.e. if stripped, the chat bubble also shows the stripped version).

#### Tracking Mentions

To distinguish user-selected file mentions from arbitrary `@` text, maintain a list of active mentions:

```ts
interface FileMention {
  relativePath: string // e.g. "src/utils/helpers.ts"
  startIndex: number // position of '@' in the input string
  endIndex: number // position after the full path
}
```

This list must be updated as the user edits the input (typing, backspace, cut/paste). If a user manually edits text inside a mention range, that mention is "broken" and removed from tracking (treated as plain text, `@` will not be stripped).

### 5. Settings Integration

#### AppSettings Type Addition

```ts
interface AppSettings {
  // ... existing fields ...
  stripAtMentions: boolean // new
}
```

#### Default Value

Add `stripAtMentions: true` to the settings store default state.

#### Settings UI

In `SettingsGeneral.tsx`, add a toggle row:

- **Label:** "Strip @ from file mentions"
- **Control:** Switch/toggle component
- **Description:** "When enabled, the @ symbol is removed from file references inserted via the file picker before the message is sent."

### 6. Interaction with Existing Features

| Feature                            | Interaction                                                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slash commands (`/`)**           | No conflict — `/` triggers at position 0 only, `@` triggers at word boundaries. If input starts with `/`, slash command popover takes priority. `@` mentions inside slash command text are not supported.                         |
| **Image attachments**              | Independent — `@` mentions are text-based, attachments are `MessagePart` file entries. Both can coexist.                                                                                                                          |
| **Prompt history (ArrowUp/Down)**  | When the `@` popover is open, ArrowUp/Down navigate suggestions instead of prompt history. When popover is closed, normal history behavior resumes.                                                                               |
| **Draft persistence**              | The raw input text (including `@` symbols) is saved as the draft. Mention tracking is ephemeral — if the user leaves and returns, `@` symbols in draft text are treated as plain text (not tracked mentions). This is acceptable. |
| **Multi-line input (Shift+Enter)** | `@` can be triggered on any line. The popover should work regardless of which line the cursor is on.                                                                                                                              |

## Architecture & Implementation Notes

### Files to Modify

| File                                                       | Change                                                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx`     | Add `@` detection in `handleInputChange` and `handleKeyDown`, manage popover state, mention tracking, stripping on send |
| `src/renderer/src/stores/useSettingsStore.ts`              | Add `stripAtMentions` to `AppSettings` type and default state                                                           |
| `src/renderer/src/components/settings/SettingsGeneral.tsx` | Add toggle for `stripAtMentions`                                                                                        |
| `src/preload/index.d.ts`                                   | Update `AppSettings` type if shared (verify if needed)                                                                  |

### New Files to Create

| File                                                          | Purpose                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/FileMentionPopover.tsx` | The `@` file suggestion popover component                                                                |
| `src/renderer/src/hooks/useFileMentions.ts`                   | Hook encapsulating mention detection, tracking, filtering, and stripping logic to keep SessionView clean |

### Reusable Utilities

- `flattenTree()` from `FileSearchDialog.tsx` — extract to a shared util if not already, or import directly.
- `scoreMatch()` from `FileSearchDialog.tsx` — same as above.
- `SlashCommandPopover.tsx` — reference for popover positioning, styling, and keyboard nav patterns.

### State Shape (in `useFileMentions` hook)

```ts
{
  isOpen: boolean              // popover visibility
  query: string                // current filter text after @
  triggerIndex: number         // cursor position of the @ that opened the popover
  selectedIndex: number        // currently highlighted suggestion (0-based)
  suggestions: FlatFile[]      // filtered file list
  mentions: FileMention[]      // tracked inserted mentions
}
```

### Performance Considerations

- File tree is already loaded in memory via `useFileTreeStore` — no async fetch needed for filtering.
- `flattenTree()` should be memoized (only recompute when file tree changes).
- Filtering 5 results from a flat list is fast enough to run synchronously on every keystroke.

## Edge Cases

| Case                                          | Behavior                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@` at end of input with no matches           | Show empty state: "No files found"                                                                                |
| User deletes part of an inserted mention      | Mention tracking for that mention is removed; it becomes plain text                                               |
| User pastes text containing `@`               | Pasted `@` does NOT trigger the popover (only typed `@` does). Pasted `@` text is not tracked as mentions.        |
| User types `@` then immediately presses Space | Popover closes, `@ ` remains as plain text                                                                        |
| User types `@` then immediately presses Enter | If suggestions are showing, selects top result. If no suggestions (empty file tree), sends the message as normal. |
| File tree not loaded yet                      | Popover shows "Loading..." or does not open until tree is available                                               |
| Very long file paths                          | Truncate display in popover with ellipsis; full path inserted on select                                           |

## Out of Scope (Future Enhancements)

- Rich text / syntax highlighting of `@mentions` in the textarea
- Sending file content as context alongside the mention
- `@` mentions for non-file entities (branches, commits, symbols)
- Autocomplete for partial paths with `/` separators
- Persisting mention tracking across draft save/restore cycles

## Acceptance Criteria

1. Typing `@` at a word boundary opens a file suggestion popover above the input.
2. Typing after `@` filters files by both name and path with proper priority scoring.
3. At most 5 suggestions are shown.
4. Arrow keys navigate, Enter selects, Escape dismisses.
5. Selecting a file inserts `@{relativePath}` followed by a space.
6. Multiple `@` mentions work independently in the same message.
7. Settings → General has a "Strip @ from file mentions" toggle, defaulting to ON.
8. When strip is ON, sending a message removes `@` only from popover-selected mentions, not from arbitrary `@` characters.
9. The chat bubble displays the same text that was sent (stripped or not).
10. `@` inside email addresses or mid-word does not trigger the popover.
11. The popover does not conflict with slash commands, prompt history, or image attachments.
