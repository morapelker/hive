# Worktree Attachments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to attach Jira tickets and Figma links to worktrees, viewable and manageable from the worktree context menu.

**Architecture:** New `attachments` JSON column on the `worktrees` table (schema migration v6). Two new database methods for add/remove. URL parser utility. Context menu extended with sub-menus for each attachment. Dialog component for adding new attachments.

**Tech Stack:** SQLite (better-sqlite3), Electron IPC, React 19, Radix context-menu sub-menus, shadcn/ui Dialog, lucide-react icons.

---

### Task 1: URL Parser Utility

**Files:**
- Create: `src/renderer/src/lib/attachment-utils.ts`

**Step 1: Create the URL parser utility**

```ts
export interface AttachmentInfo {
  type: 'jira' | 'figma'
  label: string
}

/**
 * Parse a URL and detect if it's a Jira or Figma link.
 * Returns type + label, or null if unsupported.
 */
export function parseAttachmentUrl(url: string): AttachmentInfo | null {
  try {
    const parsed = new URL(url)

    // Jira: *.atlassian.net/browse/KEY-123 or *.atlassian.net/.../KEY-123
    if (parsed.hostname.endsWith('.atlassian.net')) {
      const match = parsed.pathname.match(/\/([A-Z][A-Z0-9]+-\d+)/)
      if (match) {
        return { type: 'jira', label: match[1] }
      }
    }

    // Figma: figma.com/design/*/Name or figma.com/file/*/Name
    if (
      parsed.hostname === 'figma.com' ||
      parsed.hostname === 'www.figma.com'
    ) {
      const match = parsed.pathname.match(/\/(design|file|board|proto)\/[^/]+\/([^/?]+)/)
      if (match) {
        const name = decodeURIComponent(match[2]).replace(/-/g, ' ')
        return { type: 'figma', label: name }
      }
    }

    return null
  } catch {
    return null
  }
}
```

**Step 2: Verify lint passes**

Run: `pnpm lint`
Expected: No errors related to the new file

**Step 3: Commit**

```bash
git add src/renderer/src/lib/attachment-utils.ts
git commit -m "feat(attachments): add URL parser utility for Jira and Figma links"
```

---

### Task 2: Database Migration + Methods

**Files:**
- Modify: `src/main/db/schema.ts` (lines 1, 23-39, 200-207)
- Modify: `src/main/db/database.ts` (after line 545)

**Step 1: Bump schema version and add migration**

In `src/main/db/schema.ts`:

1. Change `CURRENT_SCHEMA_VERSION = 5` to `CURRENT_SCHEMA_VERSION = 6`
2. Add `attachments TEXT DEFAULT '[]'` to the worktrees CREATE TABLE in `SCHEMA_SQL` (after `last_model_variant TEXT,` line 36)
3. Add migration entry at end of `MIGRATIONS` array:

```ts
{
  version: 6,
  name: 'add_worktree_attachments',
  up: `ALTER TABLE worktrees ADD COLUMN attachments TEXT DEFAULT '[]'`,
  down: `-- SQLite cannot drop columns; this is a no-op for safety`
}
```

**Step 2: Add safeAddColumn call for attachments**

In `src/main/db/database.ts`, inside the `ensureConnectionTables()` method (after line 182), add:

```ts
this.safeAddColumn('worktrees', 'attachments', "TEXT DEFAULT '[]'")
```

**Step 3: Add addAttachment database method**

In `src/main/db/database.ts`, after the `appendSessionTitle` method (after line 545), add:

```ts
/**
 * Add an attachment to a worktree's attachments JSON array.
 * Rejects duplicates by URL.
 */
addAttachment(
  worktreeId: string,
  attachment: { type: 'jira' | 'figma'; url: string; label: string }
): { success: boolean; error?: string } {
  const db = this.getDb()
  const row = db.prepare('SELECT attachments FROM worktrees WHERE id = ?').get(worktreeId) as
    | Record<string, unknown>
    | undefined
  if (!row) return { success: false, error: 'Worktree not found' }
  const attachments: Array<{
    id: string
    type: string
    url: string
    label: string
    created_at: string
  }> = JSON.parse((row.attachments as string) || '[]')
  if (attachments.some((a) => a.url === attachment.url)) {
    return { success: false, error: 'Already attached' }
  }
  const id = crypto.randomUUID()
  attachments.push({
    id,
    type: attachment.type,
    url: attachment.url,
    label: attachment.label,
    created_at: new Date().toISOString()
  })
  db.prepare('UPDATE worktrees SET attachments = ? WHERE id = ?').run(
    JSON.stringify(attachments),
    worktreeId
  )
  return { success: true }
}
```

**Step 4: Add removeAttachment database method**

Right after addAttachment, add:

```ts
/**
 * Remove an attachment from a worktree by attachment ID.
 */
removeAttachment(
  worktreeId: string,
  attachmentId: string
): { success: boolean; error?: string } {
  const db = this.getDb()
  const row = db.prepare('SELECT attachments FROM worktrees WHERE id = ?').get(worktreeId) as
    | Record<string, unknown>
    | undefined
  if (!row) return { success: false, error: 'Worktree not found' }
  const attachments: Array<{ id: string }> = JSON.parse(
    (row.attachments as string) || '[]'
  )
  const filtered = attachments.filter((a) => a.id !== attachmentId)
  if (filtered.length === attachments.length) {
    return { success: false, error: 'Attachment not found' }
  }
  db.prepare('UPDATE worktrees SET attachments = ? WHERE id = ?').run(
    JSON.stringify(filtered),
    worktreeId
  )
  return { success: true }
}
```

**Step 5: Add crypto import at top of database.ts if not present**

Check if `crypto` is imported. In Node.js 19+, `crypto.randomUUID()` is global. If the file uses `import crypto from 'crypto'` already, no change needed. Otherwise add at the top:

```ts
import crypto from 'crypto'
```

**Step 6: Verify lint passes**

Run: `pnpm lint`
Expected: No errors

**Step 7: Commit**

```bash
git add src/main/db/schema.ts src/main/db/database.ts
git commit -m "feat(attachments): add schema migration v6 and database methods for attachments"
```

---

### Task 3: IPC Handlers + Preload Bridge

**Files:**
- Modify: `src/main/ipc/database-handlers.ts` (after line 168, the appendSessionTitle handler)
- Modify: `src/preload/index.ts` (after line 69, inside the worktree namespace)
- Modify: `src/preload/index.d.ts` (lines 48-64 Worktree interface, lines 171-204 window.db.worktree)

**Step 1: Add IPC handlers for attachments**

In `src/main/ipc/database-handlers.ts`, after the `db:worktree:appendSessionTitle` handler block (around line 168), add:

```ts
ipcMain.handle(
  'db:worktree:addAttachment',
  (
    _event,
    {
      worktreeId,
      attachment
    }: {
      worktreeId: string
      attachment: { type: 'jira' | 'figma'; url: string; label: string }
    }
  ) => {
    try {
      return getDatabase().addAttachment(worktreeId, attachment)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

ipcMain.handle(
  'db:worktree:removeAttachment',
  (_event, { worktreeId, attachmentId }: { worktreeId: string; attachmentId: string }) => {
    try {
      return getDatabase().removeAttachment(worktreeId, attachmentId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)
```

**Step 2: Add preload bridge methods**

In `src/preload/index.ts`, inside the `worktree` object (after the `updateModel` method, around line 69), add:

```ts
addAttachment: (
  worktreeId: string,
  attachment: { type: 'jira' | 'figma'; url: string; label: string }
) =>
  ipcRenderer.invoke('db:worktree:addAttachment', { worktreeId, attachment }),
removeAttachment: (worktreeId: string, attachmentId: string) =>
  ipcRenderer.invoke('db:worktree:removeAttachment', { worktreeId, attachmentId }),
```

**Step 3: Update Worktree type declaration**

In `src/preload/index.d.ts`:

1. Add `attachments: string` to the `Worktree` interface (after `last_model_variant`, around line 63):

```ts
attachments: string // JSON array of Attachment objects
```

2. Add method declarations to `window.db.worktree` (after `updateModel`, around line 203):

```ts
addAttachment: (
  worktreeId: string,
  attachment: { type: 'jira' | 'figma'; url: string; label: string }
) => Promise<{ success: boolean; error?: string }>
removeAttachment: (
  worktreeId: string,
  attachmentId: string
) => Promise<{ success: boolean; error?: string }>
```

**Step 4: Verify lint passes**

Run: `pnpm lint`
Expected: No errors

**Step 5: Commit**

```bash
git add src/main/ipc/database-handlers.ts src/preload/index.ts src/preload/index.d.ts
git commit -m "feat(attachments): add IPC handlers and preload bridge for add/remove attachment"
```

---

### Task 4: Add Attachment Dialog Component

**Files:**
- Create: `src/renderer/src/components/worktrees/AddAttachmentDialog.tsx`

**Step 1: Create the dialog component**

```tsx
import { useState, useCallback } from 'react'
import { Figma, Ticket, AlertCircle, Plus, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parseAttachmentUrl } from '@/lib/attachment-utils'
import type { AttachmentInfo } from '@/lib/attachment-utils'
import { toast } from '@/lib/toast'

interface AddAttachmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktreeId: string
  onAttachmentAdded: () => void
}

export function AddAttachmentDialog({
  open,
  onOpenChange,
  worktreeId,
  onAttachmentAdded
}: AddAttachmentDialogProps): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [detected, setDetected] = useState<AttachmentInfo | null>(null)
  const [isAdding, setIsAdding] = useState(false)

  const handleUrlChange = useCallback((value: string): void => {
    setUrl(value)
    if (value.trim()) {
      setDetected(parseAttachmentUrl(value.trim()))
    } else {
      setDetected(null)
    }
  }, [])

  const handleAdd = useCallback(async (): Promise<void> => {
    if (!detected) return
    setIsAdding(true)
    try {
      const result = await window.db.worktree.addAttachment(worktreeId, {
        type: detected.type,
        url: url.trim(),
        label: detected.label
      })
      if (result.success) {
        toast.success(`Attached ${detected.type === 'jira' ? 'Jira ticket' : 'Figma file'}: ${detected.label}`)
        onAttachmentAdded()
        onOpenChange(false)
        setUrl('')
        setDetected(null)
      } else {
        toast.error(result.error || 'Failed to add attachment')
      }
    } finally {
      setIsAdding(false)
    }
  }, [detected, url, worktreeId, onAttachmentAdded, onOpenChange])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter' && detected && !isAdding) {
        handleAdd()
      }
    },
    [detected, isAdding, handleAdd]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Attachment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="Paste a Jira or Figma URL"
            value={url}
            onChange={(e) => handleUrlChange(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          {url.trim() && (
            <div className="flex items-center gap-2 text-sm">
              {detected ? (
                <>
                  <Check className="h-4 w-4 text-green-500" />
                  {detected.type === 'jira' ? (
                    <Ticket className="h-4 w-4 text-blue-500" />
                  ) : (
                    <Figma className="h-4 w-4 text-purple-500" />
                  )}
                  <span className="text-muted-foreground">
                    {detected.type === 'jira' ? 'Jira ticket' : 'Figma file'}:{' '}
                    <span className="text-foreground font-medium">{detected.label}</span>
                  </span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4 text-destructive" />
                  <span className="text-destructive">Unsupported URL</span>
                </>
              )}
            </div>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!detected || isAdding}
              onClick={handleAdd}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

**Step 2: Verify lint passes**

Run: `pnpm lint`
Expected: No errors

**Step 3: Commit**

```bash
git add src/renderer/src/components/worktrees/AddAttachmentDialog.tsx
git commit -m "feat(attachments): add AddAttachmentDialog component"
```

---

### Task 5: Extend WorktreeItem Context Menu

**Files:**
- Modify: `src/renderer/src/components/worktrees/WorktreeItem.tsx`

This is the largest task. We need to:
1. Import new components and icons
2. Parse attachments from the worktree data
3. Add attachment sub-menus to both context menu AND dropdown menu
4. Add "Add Attachment" menu item
5. Wire up open-in-browser and detach handlers

**Step 1: Update imports**

Add to the lucide-react import (line 1-17):
- Add `Figma`, `Ticket`, `Plus`, `Unlink` to the icon imports

Add new component imports:
```ts
import {
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent
} from '@/components/ui/context-menu'
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu'
import { AddAttachmentDialog } from './AddAttachmentDialog'
```

**Step 2: Update the local Worktree interface (lines 45-56)**

Add `attachments: string` to the interface (after `last_accessed_at`):

```ts
attachments: string // JSON array
```

**Step 3: Add attachment state and handlers**

Inside the component function (after the archive confirmation state around line 136), add:

```ts
// Attachment state
const [addAttachmentOpen, setAddAttachmentOpen] = useState(false)
const [attachments, setAttachments] = useState<
  Array<{ id: string; type: 'jira' | 'figma'; url: string; label: string; created_at: string }>
>([])

// Parse attachments from worktree data
useEffect(() => {
  try {
    setAttachments(JSON.parse(worktree.attachments || '[]'))
  } catch {
    setAttachments([])
  }
}, [worktree.attachments])

const handleOpenAttachment = useCallback(async (url: string): Promise<void> => {
  await window.systemOps.openInChrome(url)
}, [])

const handleDetachAttachment = useCallback(
  async (attachmentId: string): Promise<void> => {
    const result = await window.db.worktree.removeAttachment(worktree.id, attachmentId)
    if (result.success) {
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
      toast.success('Attachment removed')
    } else {
      toast.error(result.error || 'Failed to remove attachment')
    }
  },
  [worktree.id]
)

const handleAttachmentAdded = useCallback((): void => {
  // Reload worktree data to get fresh attachments
  window.db.worktree.get(worktree.id).then((w) => {
    if (w) {
      try {
        setAttachments(JSON.parse(w.attachments || '[]'))
      } catch {
        // ignore
      }
    }
  })
}, [worktree.id])
```

**Step 4: Add attachment menu items to the ContextMenuContent (lines 540-588)**

Insert BEFORE the first `<ContextMenuItem>` (before line 541), after the opening `<ContextMenuContent>` tag:

```tsx
{attachments.length > 0 && (
  <>
    {attachments.map((attachment) => (
      <ContextMenuSub key={attachment.id}>
        <ContextMenuSubTrigger>
          {attachment.type === 'jira' ? (
            <Ticket className="h-4 w-4 mr-2 text-blue-500" />
          ) : (
            <Figma className="h-4 w-4 mr-2 text-purple-500" />
          )}
          {attachment.label}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-40">
          <ContextMenuItem onClick={() => handleOpenAttachment(attachment.url)}>
            <ExternalLink className="h-4 w-4 mr-2" />
            Open
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => handleDetachAttachment(attachment.id)}
            className="text-destructive focus:text-destructive focus:bg-destructive/10"
          >
            <Unlink className="h-4 w-4 mr-2" />
            Detach
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    ))}
    <ContextMenuSeparator />
  </>
)}
<ContextMenuItem onClick={() => setAddAttachmentOpen(true)}>
  <Plus className="h-4 w-4 mr-2" />
  Add Attachment
</ContextMenuItem>
<ContextMenuSeparator />
```

**Step 5: Add the same attachment items to the DropdownMenuContent (lines 478-527)**

Insert BEFORE the first `<DropdownMenuItem>` (before line 479), after `<DropdownMenuContent className="w-52" align="end">`:

```tsx
{attachments.length > 0 && (
  <>
    {attachments.map((attachment) => (
      <DropdownMenuSub key={attachment.id}>
        <DropdownMenuSubTrigger>
          {attachment.type === 'jira' ? (
            <Ticket className="h-4 w-4 mr-2 text-blue-500" />
          ) : (
            <Figma className="h-4 w-4 mr-2 text-purple-500" />
          )}
          {attachment.label}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-40">
          <DropdownMenuItem onClick={() => handleOpenAttachment(attachment.url)}>
            <ExternalLink className="h-4 w-4 mr-2" />
            Open
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => handleDetachAttachment(attachment.id)}
            className="text-destructive focus:text-destructive focus:bg-destructive/10"
          >
            <Unlink className="h-4 w-4 mr-2" />
            Detach
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    ))}
    <DropdownMenuSeparator />
  </>
)}
<DropdownMenuItem onClick={() => setAddAttachmentOpen(true)}>
  <Plus className="h-4 w-4 mr-2" />
  Add Attachment
</DropdownMenuItem>
<DropdownMenuSeparator />
```

**Step 6: Add the AddAttachmentDialog**

Right before the closing `</ContextMenu>` tag (before line 589), add:

```tsx
<AddAttachmentDialog
  open={addAttachmentOpen}
  onOpenChange={setAddAttachmentOpen}
  worktreeId={worktree.id}
  onAttachmentAdded={handleAttachmentAdded}
/>
```

**Step 7: Check DropdownMenuSub is exported from the dropdown-menu UI component**

Look at `src/renderer/src/components/ui/dropdown-menu.tsx` and confirm `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent` are exported. If not, add them (they follow the same pattern as context-menu sub components).

**Step 8: Verify lint passes**

Run: `pnpm lint`
Expected: No errors

**Step 9: Commit**

```bash
git add src/renderer/src/components/worktrees/WorktreeItem.tsx
git commit -m "feat(attachments): add attachment sub-menus and add-attachment dialog to worktree context menu"
```

---

### Task 6: Verify Build + Manual Test

**Step 1: Run lint**

Run: `pnpm lint`
Expected: No errors

**Step 2: Run build**

Run: `pnpm build`
Expected: Build succeeds

**Step 3: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix(attachments): address lint and build issues"
```
