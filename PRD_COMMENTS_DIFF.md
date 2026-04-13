# PRD: Diff Comments

**Status:** Draft
**Owner:** TBD
**Last updated:** 2026-04-13
**Target branch for implementation:** `claude/add-diff-comments-kL6w1`

---

## 1. Overview

Add a **GitHub-style line comments** feature to the Changes tab's diff views. Users can leave comments on specific lines or line ranges of their pending changes, persist them in the local SQLite database, jump between them, edit or remove them, and — with one click — attach the entire batch as structured context to the main session input so Claude can address every note in a single second pass.

## 2. Problem & Context

The current Hive review loop has a gap. When a user reviews their own (or Claude's) pending changes in the Changes tab, their only feedback channel is free-form prose in the session input. That forces them to:

- Re-describe line locations in English ("in `foo.ts` around the new `validate()` function…")
- Lose line-level precision when there are many small notes
- Keep the full mental context in their head between spotting an issue and typing it out

Hive already supports attaching tickets and GitHub PR review comments to the session input (see `PrCommentAttachments()` in `src/renderer/src/components/sessions/SessionView.tsx:428`). Those flows cover external review input. What's missing is a first-class way to do the review **yourself**, on the **local** diff, and hand the results back to Claude as structured, line-anchored context.

The natural workflow this feature enables:

1. User opens Changes tab → diff view.
2. Walks through the diff, leaving short notes on specific lines: "split this", "add null check", "rename to X", "this regex is wrong".
3. Hits "Attach all to chat" in the diff toolbar.
4. Comments become chips above the session input (mirroring how PR comments attach today).
5. User hits send — optionally with an additional prose instruction like "address all of these".
6. Claude receives every comment as structured context and addresses them in a single second pass.

## 3. Goals / Non-Goals

### Goals
- Let the user write comments anchored to specific right-side lines or line ranges in any diff rendered by `MonacoDiffView` or `BranchDiffView`.
- Persist comments locally so they survive app reloads, tab switches, and session switches on the same worktree.
- Provide a one-click "attach all" flow that converts comments into structured context for the next outbound message.
- Surface navigation, edit, delete, and clear-all controls so the user can curate the comment set between passes.
- Gracefully handle line drift when the underlying code changes between passes.

### Non-Goals (v1)
- No syncing to GitHub PR review comments. (Existing PR-comments feature covers that direction; this is local-only.)
- No threaded replies. Comments are flat notes.
- No comments on the LEFT (deleted) side of the diff — v1 is about code Claude should change.
- No keyboard shortcuts for prev/next or attach — mouse/trackpad only in v1.
- No "Attach" button near the session input's `AttachmentButton` — the entry point lives only in the diff toolbar.
- No multi-user authoring model, mentions, or avatars — single-user app.
- No comment rendering in Git history diffs.

## 4. Users & Use Cases

Single primary user: the developer running a Hive session on a worktree. Typical use case: two-pass refinement.

- **Pass 1:** Claude produces a round of changes.
- **Pass 2:** User reviews the diff, leaves 5–30 targeted notes, hits "Attach all to chat", optionally adds "address these", sends.
- **Pass 3:** Claude revises. User re-reviews; outdated notes are re-anchored or flagged.

## 5. User Flows

### 5.1 Write a single-line comment
1. User hovers over a line on the right-hand side of the diff.
2. A `+` button appears in the gutter.
3. User clicks `+`. An inline editor (Monaco view zone) expands below the line with a textarea, **Save** and **Cancel** buttons.
4. User types the note and clicks **Save** (or `Cmd/Ctrl+Enter`).
5. The editor collapses into a read-only comment card anchored to that line, with **Edit** and **Delete** actions on hover.

### 5.2 Write a multi-line range comment
1. User hovers a line; `+` appears in the gutter.
2. User presses the `+` and **drags** up or down; the gutter visually highlights the range as it extends.
3. On mouseup, the inline editor opens at the bottom of the range with the same Save/Cancel controls. The selected range is displayed in the editor header (`Lines 42–47`).
4. Save anchors the comment to the whole range.

### 5.3 Edit / delete a single comment
- Hover an existing comment card → **Edit** and **Delete** appear.
- **Edit** toggles the card back into textarea form with Save/Cancel.
- **Delete** removes the comment (no confirmation for single deletes — it's cheap to re-add).

### 5.4 Jump between comments
- The floating diff toolbar shows: `3 comments · ← → · Attach all to chat · Clear`.
- `←` / `→` arrows scroll to and flash the previous/next comment in file-then-line order.
- A collapsible side panel lists every comment grouped by file; clicking an entry does the same scroll+flash.

### 5.5 Clear all
- **Clear** in the toolbar opens a confirmation dialog ("Delete all 3 comments on this worktree?").
- On confirm, all comments for the current worktree are removed from the DB.

### 5.6 Bulk-attach all comments to the session input
- User clicks **Attach all to chat** in the diff toolbar.
- For each stored comment, a chip appears in a row above the session textarea (same row style as `PrCommentAttachments`): file path, line range, truncated body snippet, hover `×` to detach individually.
- Soft toast warning if the attached count exceeds 20 ("Attaching 24 comments may consume significant context — consider splitting into passes").
- The DB rows are not modified; only the in-memory attached-set grows.
- User optionally types free-form text (e.g. "address all of these").
- On send, the attached set is serialized into the outbound message (see §10) and then cleared. DB rows remain.

### 5.7 Re-review after Claude edits
- When the diff re-renders after Claude's second pass, each comment re-anchors (§7).
- Successfully re-anchored comments render inline at their new line.
- Comments whose anchor can no longer be located are marked **Outdated** and surface in an "Outdated (N)" section at the bottom of the side panel, alongside the original snippet they pointed at. They remain attachable and deletable.

## 6. UX Specification

### Gutter affordance
- On pointer hover over a right-side line, render a small `+` button overlayed in the Monaco gutter (absolutely positioned, following the `HunkActionGutter.tsx` positioning strategy using `modifiedEditor.getTopForLineNumber()`).
- Click for single-line. Press-and-drag extends a highlighted range until mouseup.

### Inline view-zone editor
- Reuses the pattern in `src/renderer/src/components/diff/PrCommentGutter.tsx` (Monaco view zones + `ResizeObserver` + `MutationObserver` + scroll preservation).
- Contents: range header (`Lines 42–47`), autosized textarea, Save + Cancel buttons.
- Keyboard: `Cmd/Ctrl+Enter` submits, `Esc` cancels.
- Disallow save with an empty body.

### Saved comment card (view zone)
- Shows body rendered as plain text (no markdown in v1).
- Hover reveals **Edit** and **Delete** action buttons top-right.
- If marked outdated, a yellow `Outdated` badge is shown top-left with the original snippet in a `<pre>` block below the body.

### Floating toolbar
- Docked to the top-right of the diff view.
- Hidden when there are zero comments for the current worktree.
- Layout: `3 comments` · `←` · `→` · `Attach all to chat` · `Clear`.
- `Attach all to chat` is disabled if the attached set already contains every stored comment.

### Side panel
- Collapsible drawer opened from a toggle next to the toolbar counter.
- Grouped by file path, with a per-file count.
- Each entry shows: line range, truncated body (line-clamp-2), click-to-jump.
- Bottom section: "Outdated (N)" collapsed by default, with original snippets inlined.
- Virtualized when entry count exceeds ~50.

### Attached chip above session input
- Rendered alongside `PrCommentAttachments` in `SessionView.tsx` (the container above the textarea).
- Visual: matches existing PR-comment chip styling — file name, `:lineStart-lineEnd`, body preview (80-char truncation), hover × to detach.

## 7. Re-Anchoring Algorithm

### On create
At the moment the user saves a comment, capture from the Monaco modified model:
- `anchor_text`: the joined text of `line_start..line_end` (inclusive).
- `anchor_context_before`: up to 3 lines immediately preceding `line_start`, or fewer if at file start.
- `anchor_context_after`: up to 3 lines immediately following `line_end`, or fewer if at file end.

### On diff render / refresh
For each stored comment on files present in the diff:

1. Read the current text of the target file from the Monaco modified model.
2. **Fast path:** check if the joined text of lines `[line_start..line_end]` exactly equals `anchor_text`. If yes, render in place.
3. **Content search:** scan the file for an exact match of `anchor_text`. If exactly one match is found, render at that new line range. If multiple matches are found, disambiguate by also requiring `anchor_context_before` and/or `anchor_context_after` to match; pick the unique match if any.
4. **Fallback:** mark the comment as `is_outdated = true` in memory and surface it in the Outdated section of the side panel. Do **not** update the DB row until the user explicitly attaches it, edits it, or deletes it — that way a temporarily-edited file won't permanently strand the comment.

Line-number updates from successful re-anchoring are applied to the in-memory projection used for rendering; they are persisted back to the DB on the next edit or attach action.

## 8. Data Model

### New SQLite table
Added in a new migration at `src/main/db/schema.ts`, bumping `CURRENT_SCHEMA_VERSION` from 22 → 23.

```sql
CREATE TABLE diff_comments (
  id TEXT PRIMARY KEY,               -- uuid
  worktree_id TEXT NOT NULL,         -- scope
  file_path TEXT NOT NULL,           -- repo-relative, right-side file path
  line_start INTEGER NOT NULL,       -- right-side line, 1-based inclusive
  line_end INTEGER NOT NULL,         -- right-side line, 1-based inclusive; == line_start for single-line
  anchor_text TEXT NOT NULL,         -- exact text of line_start..line_end at creation
  anchor_context_before TEXT,        -- up to 3 lines before, joined with '\n'
  anchor_context_after TEXT,         -- up to 3 lines after, joined with '\n'
  body TEXT NOT NULL,                -- comment body, plain text
  is_outdated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
);

CREATE INDEX idx_diff_comments_worktree ON diff_comments(worktree_id);
CREATE INDEX idx_diff_comments_worktree_file ON diff_comments(worktree_id, file_path);
```

`is_outdated` is persisted for resumability after the user explicitly interacts, but is always re-computed at render time by the re-anchoring algorithm.

### TypeScript shape (`src/main/db/types.ts`)
```ts
export interface DiffComment {
  id: string
  worktree_id: string
  file_path: string
  line_start: number
  line_end: number
  anchor_text: string
  anchor_context_before: string | null
  anchor_context_after: string | null
  body: string
  is_outdated: 0 | 1
  created_at: string
  updated_at: string
}
```

## 9. API / IPC

New handlers in `src/main/ipc/database-handlers.ts`, following the existing `db:resource:action` pattern. Implemented on `DatabaseService` in `src/main/db/database.ts`.

| Channel | Args | Returns |
|---|---|---|
| `db:diffComment:create` | `{ worktreeId, filePath, lineStart, lineEnd, body, anchorText, anchorContextBefore?, anchorContextAfter? }` | `DiffComment` |
| `db:diffComment:list` | `{ worktreeId }` | `DiffComment[]` |
| `db:diffComment:update` | `{ id, body }` | `DiffComment` |
| `db:diffComment:setOutdated` | `{ id, isOutdated }` | `DiffComment` |
| `db:diffComment:delete` | `{ id }` | `{ success: true }` |
| `db:diffComment:clearAll` | `{ worktreeId }` | `{ deletedCount: number }` |

## 10. Renderer Architecture

### New Zustand store: `src/renderer/src/stores/useDiffCommentStore.ts`
Mirrors the shape of `usePRReviewStore`:

```ts
interface DiffCommentStoreState {
  comments: Map<string /* worktreeId */, DiffComment[]>
  loading: Map<string, boolean>
  error: Map<string, string | null>

  // Attached set for next outbound message (persists across tab switches)
  attachedCommentIds: Set<string>

  // Data actions (thin wrappers around IPC)
  fetch: (worktreeId: string) => Promise<void>
  create: (...) => Promise<DiffComment>
  update: (id: string, body: string) => Promise<void>
  remove: (id: string) => Promise<void>
  clearAll: (worktreeId: string) => Promise<void>

  // Attach flow
  attachAllToChat: (worktreeId: string) => void
  detach: (id: string) => void
  clearAttached: () => void

  // Jump event bus
  jumpTo: (id: string) => void      // emits to subscribers
  onJump: (cb: (id: string) => void) => () => void
}
```

### New components
- `src/renderer/src/components/diff/DiffCommentGutter.tsx` — sibling of `PrCommentGutter.tsx`. Owns the `+` affordance, drag-to-range selection, and the inline view-zone editor/card rendering.
- `src/renderer/src/components/diff/DiffCommentToolbar.tsx` — floating top-of-diff toolbar (counter, prev/next, attach, clear).
- `src/renderer/src/components/diff/DiffCommentSidePanel.tsx` — collapsible side panel; consumes the store directly.
- `src/renderer/src/components/sessions/DiffCommentAttachments.tsx` — chip row above the session input, rendered adjacent to `PrCommentAttachments()` in `SessionView.tsx`.

### Integration points
- `MonacoDiffView.tsx` and `BranchDiffView.tsx`: mount `DiffCommentGutter`, `DiffCommentToolbar`, and optionally open `DiffCommentSidePanel`.
- `SessionView.tsx`: render `<DiffCommentAttachments />` alongside `<PrCommentAttachments />` near line 5626; read `useDiffCommentStore.getState().attachedCommentIds` at the same points where PR attached comments are read today (lines 4065, 4196, 4323, 4361) and include them in message serialization.

## 11. Serialization to Claude

Extend `src/renderer/src/lib/file-attachment-utils.ts` (`buildMessageParts` and `buildDisplayContent`) with a new XML block. The block is a single `<diff-comments>` element with one `<diff-comment>` child per attached comment:

```xml
<diff-comments>
  <diff-comment file="src/foo.ts" lines="42-45" outdated="false">
    <snippet><![CDATA[
function validate(input) {
  return input != null
}
    ]]></snippet>
    <body>split this into validateString and validateNumber</body>
  </diff-comment>
  <diff-comment file="src/bar.ts" lines="10" outdated="true">
    <snippet><![CDATA[const REGEX = /\d+/]]></snippet>
    <body>this regex misses decimals</body>
  </diff-comment>
</diff-comments>
```

Rules:
- File paths, line numbers, and the `outdated` flag live in attributes and use the existing `escapeXmlAttr` helper.
- `<snippet>` and `<body>` use `<![CDATA[...]]>` so bodies/snippets can freely contain quotes, tags, and multi-line text.
- Ordering: by `file_path` ascending, then `line_start` ascending.
- `buildDisplayContent` mirrors the same block so the optimistic UI message matches what's stored on disk, consistent with how PR comments and tickets are handled today.
- Sending clears only `attachedCommentIds` (per decision); DB rows are untouched.

The outbound message structure remains `MessagePart[]`: the diff-comments XML becomes a `{ type: 'text', text: … }` part appended after ticket/PR blocks and before the final prompt-text part.

## 12. Edge Cases

| Case | Behavior |
|---|---|
| File deleted upstream (no longer in the worktree) | Comments surface in a "Missing file (N)" section of the side panel. Still attachable; serialized with `outdated="true"`. |
| File renamed | Treated as delete + re-add. Existing comments show as Outdated with original file path in the snippet preview. (Full rename-tracking is out of scope for v1.) |
| Very large diff or many comments (50+) | Side panel virtualizes. Toolbar shows a soft-warning toast when attaching more than 20. |
| Worktree deletion | `ON DELETE CASCADE` on `diff_comments.worktree_id` removes rows automatically. |
| Empty body | Save button disabled. |
| Concurrent sessions on the same worktree | Both see the same store + DB rows. Real-time sync across renderer tabs is not a requirement in v1; comments refresh on tab focus. |
| Working-tree diff vs branch diff of same file | Unified per the locked decision: one anchor per `(worktree, file, right-line)` rendered in both views. |

## 13. Telemetry & Logging

No new telemetry in v1. Reuse the existing app logger at the IPC boundary for error paths only.

## 14. Verification / Manual Test Plan

Run through each scenario end-to-end in the packaged Electron app:

- [ ] Create a single-line comment in the working-tree diff; it renders inline and persists after reload.
- [ ] Create a multi-line range comment via drag; the range header shows the correct inclusive line span.
- [ ] The same comment appears in the branch diff (`BranchDiffView`) for the same file+line.
- [ ] Edit a comment; the updated body renders; `updated_at` advances in the DB.
- [ ] Delete a single comment; it disappears from both the inline view and the side panel.
- [ ] Click prev/next in the toolbar; the diff scrolls to and briefly flashes each comment.
- [ ] Click an entry in the side panel; same scroll+flash.
- [ ] Click "Attach all to chat"; chips appear above the session input. DB rows are still present (verify via DB dump or a second session view).
- [ ] Detach a single chip via hover-×; only that one leaves the attached set.
- [ ] Type some text and send; the attached set clears, DB rows remain untouched, and the outbound message contains the `<diff-comments>` XML block with correct ordering and CDATA escaping.
- [ ] Attach 21 comments; the soft-warning toast is shown; send still works.
- [ ] After Claude's response modifies the file so an anchored line shifts by 5 lines, the comment re-anchors to the new line (verified by visual placement).
- [ ] After Claude's response deletes an anchored line, the comment appears in the Outdated section of the side panel with the original snippet, and can still be attached and sent with `outdated="true"`.
- [ ] Click "Clear" in the toolbar; confirm dialog appears; confirming removes every comment on that worktree from the DB.
- [ ] Switch to a different session on the same worktree; the comments are still visible.
- [ ] Switch to a different worktree; its comments are isolated (none from the previous worktree visible).
- [ ] Delete the worktree entirely; `diff_comments` rows for it are gone (cascade).

## 15. Out of Scope / Future Work

- Threaded replies (discussion within a single comment).
- Comments on the LEFT side of the diff ("why did we drop this line?").
- Markdown rendering in comment bodies.
- Keyboard shortcuts for prev/next and attach.
- Optional GitHub PR sync: push a local comment as a real PR review comment when a PR exists.
- Rename tracking so comments survive file renames cleanly.
- Resolved/unresolved state per comment (à la GitHub review threads).
- Auto-attaching new comments as they're written (opt-in streaming mode).
