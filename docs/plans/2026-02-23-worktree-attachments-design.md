# Worktree Attachments

Attach Jira tickets and Figma links to worktrees for quick access from the context menu.

## Data Model

New `attachments` TEXT column on the `worktrees` table (schema migration v5), storing a JSON array:

```ts
interface Attachment {
  id: string          // crypto.randomUUID()
  type: 'jira' | 'figma'
  url: string
  label: string       // parsed from URL
  created_at: string  // ISO timestamp
}
```

This follows the existing `session_titles` pattern (JSON array in a TEXT column).

### URL Detection & Label Parsing

- **Jira**: `*.atlassian.net/browse/KEY-123` or similar paths containing a project key → label = `KEY-123`
- **Figma**: `figma.com/design/*/Name` or `figma.com/file/*/Name` → label = `Name` (dashes → spaces)
- **Invalid**: rejected with inline validation error

## UX

### Context Menu Layout

Attachments appear at the top of the worktree context menu, before existing items:

```
+-------------------------------+
| PROJ-123                  >   |  <- Jira sub-menu
| Login Redesign            >   |  <- Figma sub-menu
+-------------------------------+
| + Add Attachment              |
+-------------------------------+
| Open in Terminal              |
| Open in Editor                |
| ...                           |
```

Each attachment is a `ContextMenuSub` with two items:
- **Open** — opens URL in default browser via `shell.openExternal`
- **Detach** — removes the attachment

### Adding an Attachment

1. Right-click worktree -> "Add Attachment"
2. Dialog opens with a single text input: "Paste a Jira or Figma URL"
3. Auto-detects type on input, shows badge: "Jira ticket" or "Figma file"
4. Unsupported URLs show an error state; Add button stays disabled
5. Duplicate URLs rejected with toast
6. Enter or click "Add" saves, shows toast, closes dialog

### Detaching

1. Right-click worktree -> hover attachment -> sub-menu opens
2. Click "Detach" -> attachment removed, toast shown

## IPC Layer

Two new methods on the existing `window.db.worktree` namespace:

- `addAttachment(worktreeId: string, attachment: Omit<Attachment, 'id' | 'created_at'>)` — parse JSON array, append, write back
- `removeAttachment(worktreeId: string, attachmentId: string)` — parse JSON array, filter out, write back

Opening URLs uses `shell.openExternal(url)` via a `window.systemOps.openExternal(url)` channel.

## Components

1. **`AddAttachmentDialog`** — new dialog component with URL input, auto-detect badge, and Add button
2. **`WorktreeItem.tsx`** — extended context menu with attachment sub-menus and "Add Attachment" item
3. **`lib/attachment-utils.ts`** — pure `parseAttachmentUrl(url): { type, label } | null` function

## Error Handling

- Invalid URL: inline validation in dialog, Add button disabled
- Duplicate URL: toast "Already attached"
- Archived worktrees: no context menu, so no attachment actions possible
