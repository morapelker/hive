# Hive — Phase 9 Product Requirements Document

## Overview

**Phase 9** focuses on **platform polish, session control, streaming correctness, and UX affordances**. The work spans nine features: overriding Cmd+W to prevent accidental app closure, fixing PATH inheritance from the user's shell environment, adding copy-on-hover to messages, implementing streaming abort, persisting per-session input drafts to disk, showing hidden files in the file manager, adding a Cmd+D file search dialog, fixing subagent content routing and notifications, and correcting the subtool loading indicator.

### Phase 9 Goals

- Prevent Cmd+W from ever closing the Electron window — only close the active session tab (or no-op if none)
- Inherit the user's full PATH from their login shell so spawned processes (opencode, scripts) work as expected
- Show a copy-to-clipboard button on hover over any message bubble
- Allow users to abort a streaming response via a stop button when the input field is empty
- Persist input field drafts per session across session switches and app restarts
- Display hidden/dot files in the file tree (`.env`, `.gitignore`, `.vscode/`, etc.)
- Add a Cmd+D file search dialog for quick navigation to files by name
- Route subagent streaming content into their dedicated SubtaskCard containers instead of the main message flow
- Keep the streaming/loading indicator active until all tools complete, not just the first one

---

## Technical Additions

| Component                 | Technology                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Cmd+W Interception        | Electron `before-input-event`, custom File menu replacing `{ role: 'fileMenu' }`                |
| PATH Inheritance          | `fix-path` npm package (or `shell-path`), called at app startup before service init             |
| Copy on Hover             | React `group`/`group-hover:opacity-100`, `navigator.clipboard.writeText`, lucide `Copy`/`Check` |
| Streaming Abort           | OpenCode SDK `client.session.abort()`, new IPC channel, stop button UI                          |
| Input Draft Persistence   | SQLite `draft_input` column on `sessions` table, debounced writes (3s)                          |
| Hidden File Display       | Remove blanket dotfile filter in `file-tree-handlers.ts`                                        |
| File Search Dialog        | `cmdk` component, `useFileTreeStore` flat file list, fuzzy matching, `useFileViewerStore`       |
| Subagent Content Routing  | Child session ID tagging on stream events, subtask-to-child mapping in renderer                 |
| Subtool Loading Indicator | Guard `isStreaming` transitions against individual tool completions                             |

---

## Features

### 1. Cmd+W Session Close Override

#### 1.1 Current State

- `keyboard-shortcuts.ts` (line 46) defines `session:close` with `defaultBinding: { key: 'w', modifiers: ['meta'] }`
- `useKeyboardShortcuts.ts` (line 131) handles it by calling `useSessionStore.getState().closeSession(activeSessionId)`
- However, `src/main/index.ts` (line 249) uses `{ role: 'fileMenu' }` in the Electron menu template — this includes Electron's built-in "Close Window" (Cmd+W) menu accelerator
- The native menu accelerator fires at the OS level **before** any DOM keydown event reaches the renderer
- Result: Cmd+W closes the entire BrowserWindow instead of closing a session tab
- Additionally, the shortcut has `allowInInput: false` (line 131), so it wouldn't fire when the textarea is focused anyway

#### 1.2 New Design

Intercept Cmd+W at the Electron level using `webContents.on('before-input-event')` (same pattern as the Phase 8 Cmd+T fix). Replace the `{ role: 'fileMenu' }` menu with a custom File menu that omits the native Close Window accelerator. Cmd+W should **never** close the app.

```
Event flow (before fix):
  Cmd+W → Electron native fileMenu → BrowserWindow.close() → app quits

Event flow (after fix):
  Cmd+W → before-input-event → preventDefault → IPC to renderer → close active session tab (or no-op)
```

#### 1.3 Implementation

**Main Process** (`src/main/index.ts`):

Add Cmd+W to the existing `before-input-event` listener:

```typescript
mainWindow.webContents.on('before-input-event', (event, input) => {
  // Existing Cmd+T interception...

  // Intercept Cmd+W — never close the window, forward to renderer
  if (
    input.key.toLowerCase() === 'w' &&
    (input.meta || input.control) &&
    !input.alt &&
    !input.shift &&
    input.type === 'keyDown'
  ) {
    event.preventDefault()
    mainWindow!.webContents.send('shortcut:close-session')
  }
})
```

Replace `{ role: 'fileMenu' }` with a custom File menu:

```typescript
{
  label: 'File',
  submenu: [
    {
      label: 'Close Tab',
      accelerator: 'CmdOrCtrl+W',
      click: () => {
        mainWindow?.webContents.send('shortcut:close-session')
      }
    },
    { type: 'separator' },
    { role: 'quit' }
  ]
}
```

**Preload** (`src/preload/index.ts`):

```typescript
onCloseSessionShortcut: (callback: () => void) => {
  ipcRenderer.on('shortcut:close-session', () => callback())
  return () => {
    ipcRenderer.removeAllListeners('shortcut:close-session')
  }
}
```

**Renderer** (`useKeyboardShortcuts.ts`):

Register the IPC listener to close the active session:

```typescript
useEffect(() => {
  const cleanup = window.systemOps.onCloseSessionShortcut(() => {
    const { activeSessionId, closeSession } = useSessionStore.getState()
    if (activeSessionId) {
      closeSession(activeSessionId)
    }
    // If no active session — no-op
  })
  return cleanup
}, [])
```

Also change `session:close` to `allowInInput: true`.

**Edge Cases**:

- If no session is open: Cmd+W is a no-op (no toast, no error, silent)
- If the command palette or a modal is open: Cmd+W still only closes a session, not the app
- Quit remains available via Cmd+Q

#### 1.4 Files to Modify

| File                                             | Change                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`                              | Add Cmd+W to `before-input-event`; replace `{ role: 'fileMenu' }` with custom File menu omitting native Close Window |
| `src/preload/index.ts`                           | Add `onCloseSessionShortcut` to `systemOps`                                                                          |
| `src/preload/index.d.ts`                         | Type declaration for `onCloseSessionShortcut`                                                                        |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts` | Register IPC listener; change `session:close` to `allowInInput: true`                                                |

---

### 2. PATH Variable Inheritance from Shell Environment

#### 2.1 Current State

- `opencode-service.ts` (line 70): `spawn('opencode', args, { env: { ...process.env } })` — inherits the Electron process's environment
- `script-runner.ts` (lines 180, 220, 295): Spawns `sh -c` with `{ env: colorEnv }` where `colorEnv = { ...process.env, ... }` — same minimal env
- When Electron is launched from Finder/Dock/Spotlight on macOS, `process.env.PATH` is the minimal system default: `/usr/bin:/bin:/usr/sbin:/sbin`
- Paths from Homebrew (`/opt/homebrew/bin`), nvm, pyenv, cargo, etc. are **not** included because Finder doesn't source `.zshrc` or `.bash_profile`
- No `fix-path`, `shell-path`, or `shell-env` packages are installed
- This means `opencode` (typically installed via npm/Homebrew) may not be found, causing connection failures

#### 2.2 New Design

Use the `fix-path` npm package (lightweight, well-maintained) to patch `process.env.PATH` at app startup. This package spawns the user's default shell in login-interactive mode (`zsh -ilc 'echo $PATH'`), captures the output, and replaces `process.env.PATH` with the full user PATH.

The fix must run **before** any child process is spawned — specifically before `OpenCodeService` initialization and before any `script-runner` usage.

#### 2.3 Implementation

**Install**:

```bash
pnpm add fix-path
```

**Main Process** (`src/main/index.ts`):

Call `fixPath()` at the very top of `app.whenReady()`, before database init or IPC registration:

```typescript
import fixPath from 'fix-path'

app.whenReady().then(() => {
  // Fix PATH for macOS when launched from Finder/Dock/Spotlight.
  // Must run before any child process spawning (opencode, scripts).
  fixPath()

  log.info('App starting', { version: app.getVersion(), platform: process.platform })
  // ... rest of initialization
})
```

**Verification**: After `fixPath()`, `process.env.PATH` should include the user's full PATH. All subsequent `spawn()` calls (opencode-service, script-runner, settings-handlers) inherit this automatically via `{ env: { ...process.env } }`.

**Edge Cases**:

- On Linux/Windows: `fix-path` is a no-op (PATH is already correct when launched from a terminal or desktop entry)
- If the user's shell hangs or takes >5s: `fix-path` has a built-in timeout and falls back to the original PATH
- If the user's default shell is not zsh (e.g., bash, fish): `fix-path` uses `$SHELL` which respects the user's configured shell

#### 2.4 Files to Modify

| File                | Change                                                                                |
| ------------------- | ------------------------------------------------------------------------------------- |
| `package.json`      | Add `fix-path` dependency                                                             |
| `src/main/index.ts` | Import and call `fixPath()` at top of `app.whenReady()` before service initialization |

---

### 3. Copy on Hover for Messages

#### 3.1 Current State

- `UserBubble.tsx` (22 lines): Renders user message as plain text in a bubble. No hover actions, no copy button.
- `AssistantCanvas.tsx` (272 lines): Renders assistant content as interleaved parts (markdown + tool cards). No hover actions, no copy button.
- `MessageRenderer.tsx` (31 lines): Routes to `UserBubble` or `AssistantCanvas` based on role.
- Existing copy pattern in `CodeBlock.tsx` (lines 14–23): Uses `navigator.clipboard.writeText(code)`, hover reveal via `group`/`group-hover:opacity-100`, check icon for 2s, toast notification.
- `clipboardToast` helpers exist in `src/renderer/src/lib/toast.ts` (lines 172–181).
- Raw message text is accessible as `message.content` (string) on every `OpenCodeMessage`.

#### 3.2 New Design

Add a copy button to each message that appears on hover. The button should be positioned at the top-right corner of the message, using the same `group-hover:opacity-100` pattern as `CodeBlock.tsx`.

```
┌─────────────────────────────────────────────────┐
│  Assistant message content...                [📋]│  ← copy button appears on hover
│  Here is the implementation:                     │
│  ...                                             │
└─────────────────────────────────────────────────┘
```

For assistant messages with parts, the copy should use `message.content` which contains the full concatenated text (no tool metadata).

#### 3.3 Implementation

**CopyMessageButton Component** (new file):

```typescript
import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface CopyMessageButtonProps {
  content: string
}

export function CopyMessageButton({ content }: CopyMessageButtonProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      toast.success('Message copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy message')
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className="absolute top-2 right-2 h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity z-10"
      aria-label="Copy message"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
      )}
    </Button>
  )
}
```

**MessageRenderer** — wrap each message in a `group relative` container:

```typescript
export function MessageRenderer({ message, isStreaming, cwd }: MessageRendererProps) {
  return (
    <div className="group relative">
      <CopyMessageButton content={message.content} />
      {message.role === 'user' ? (
        <UserBubble content={message.content} timestamp={message.timestamp} />
      ) : (
        <AssistantCanvas
          content={message.content}
          timestamp={message.timestamp}
          isStreaming={isStreaming}
          parts={message.parts}
          cwd={cwd}
        />
      )}
    </div>
  )
}
```

**Edge Cases**:

- Empty messages: Hide the copy button if `message.content` is empty or whitespace-only
- During streaming: Show the copy button but it copies whatever text has been produced so far
- Very long messages: Button stays at top-right of the message container, not the viewport

#### 3.4 Files to Modify/Create

| File                                                         | Change                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/CopyMessageButton.tsx` | **NEW** — Copy button component following `CodeBlock.tsx` hover/clipboard pattern |
| `src/renderer/src/components/sessions/MessageRenderer.tsx`   | Add `group relative` wrapper, render `CopyMessageButton` overlay for each message |

---

### 4. Stop Streaming (Abort)

#### 4.1 Current State

- The OpenCode SDK provides `client.session.abort({ path: { id }, query: { directory } })` returning `Promise<boolean>` (SDK `types.gen.d.ts` lines 2056–2083)
- The SDK defines a `MessageAbortedError` type (`{ name: "MessageAbortedError", data: { message: string } }`) that appears on `AssistantMessage.error` when a session is aborted
- **No abort functionality exists in the app**: no `abort()` method on `OpenCodeService`, no `opencode:abort` IPC handler, no `abort` in preload `opencodeOps`, no stop button in the UI
- When streaming, the send button shows a `ListPlus` (queue) icon when `isStreaming` is true (SessionView line 1627–1628) but is disabled when input is empty (line 1620: `disabled={!inputValue.trim()}`)
- There is no way for the user to cancel a running response

#### 4.2 New Design

When `isStreaming` is true AND `inputValue` is empty (trimmed), the send button should transform into a **stop button** (square icon). Clicking it calls the OpenCode SDK's `session.abort()` via the full IPC chain.

```
Input field states:
┌──────────────────────────────────────────────────────┐
│ Not streaming, empty input     → Send button (disabled)      │
│ Not streaming, has input       → Send button (enabled)       │
│ Streaming, empty input         → Stop button (red, enabled)  │
│ Streaming, has input           → Queue button (enabled)      │
└──────────────────────────────────────────────────────┘
```

After abort:

- The streaming indicator stops
- The partial response remains visible (whatever was produced before abort)
- No error toast — the abort is user-initiated
- The `MessageAbortedError` in the event stream is handled silently (the `session.idle` event that follows will finalize normally)

#### 4.3 Implementation

**OpenCodeService** (`src/main/services/opencode-service.ts`):

Add an `abort` method:

```typescript
async abort(worktreePath: string, opencodeSessionId: string): Promise<boolean> {
  const instance = this.instances.get(worktreePath)
  if (!instance?.client) {
    throw new Error('No OpenCode instance for worktree')
  }

  const result = await instance.client.session.abort({
    path: { id: opencodeSessionId },
    query: { directory: worktreePath }
  })

  return result.data === true
}
```

**IPC Handler** (`src/main/ipc/opencode-handlers.ts`):

```typescript
ipcMain.handle(
  'opencode:abort',
  async (_event, worktreePath: string, opencodeSessionId: string) => {
    log.info('IPC: opencode:abort', { worktreePath, opencodeSessionId })
    try {
      const result = await openCodeService.abort(worktreePath, opencodeSessionId)
      return { success: result }
    } catch (error) {
      log.error('IPC: opencode:abort failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
)
```

**Preload** (`src/preload/index.ts`):

```typescript
abort: (worktreePath: string, opencodeSessionId: string) =>
  ipcRenderer.invoke('opencode:abort', worktreePath, opencodeSessionId)
```

**Renderer** (`SessionView.tsx`):

Replace the send button logic:

```typescript
const handleAbort = useCallback(async () => {
  if (!worktreePath || !opencodeSessionId) return
  await window.opencodeOps.abort(worktreePath, opencodeSessionId)
}, [worktreePath, opencodeSessionId])

// In JSX:
{isStreaming && !inputValue.trim() ? (
  <Button
    onClick={handleAbort}
    size="sm"
    className="h-7 w-7 p-0"
    variant="destructive"
    aria-label="Stop streaming"
    title="Stop streaming"
    data-testid="stop-button"
  >
    <Square className="h-3 w-3" />
  </Button>
) : (
  <Button
    onClick={handleSend}
    disabled={!inputValue.trim()}
    size="sm"
    className="h-7 w-7 p-0"
    aria-label={isStreaming ? 'Queue message' : 'Send message'}
    title={isStreaming ? 'Queue message' : 'Send message'}
    data-testid="send-button"
  >
    {isStreaming ? (
      <ListPlus className="h-3.5 w-3.5" />
    ) : (
      <Send className="h-3.5 w-3.5" />
    )}
  </Button>
)}
```

Handle `MessageAbortedError` in the stream handler — when `session.idle` arrives after an abort, finalize normally (partial response is preserved). If the event stream includes an error event with `name: "MessageAbortedError"`, suppress any error toast.

#### 4.4 Files to Modify

| File                                                   | Change                                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/services/opencode-service.ts`                | Add `abort(worktreePath, opencodeSessionId)` method calling `client.session.abort()`                                                                                    |
| `src/main/ipc/opencode-handlers.ts`                    | Add `opencode:abort` IPC handler                                                                                                                                        |
| `src/preload/index.ts`                                 | Add `abort` method to `opencodeOps` namespace                                                                                                                           |
| `src/preload/index.d.ts`                               | Type declaration for `abort` on `OpenCodeOps`                                                                                                                           |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add `handleAbort` callback; replace send button with stop button when streaming + empty input; import `Square` from lucide-react; handle `MessageAbortedError` silently |

---

### 5. Per-Session Input Field Persistence

#### 5.1 Current State

- `SessionView.tsx` (line 338): `const [inputValue, setInputValue] = useState('')` — plain local React state, initialized to empty string
- Input value is lost when switching sessions (component remounts with new `sessionId`, resetting state)
- Input value is lost on app restart (no persistence to disk)
- No draft/persistence mechanism exists
- `pendingMessages` map in session store is for pre-filled prompts (e.g., code review), not general drafts

#### 5.2 New Design

Add a `draft_input` column to the `sessions` table. Create a thin persistence layer that:

1. **Loads** the draft when a session is opened (populate `inputValue` from DB)
2. **Saves** the draft on session switch (component unmount) and after 3 seconds of inactivity (debounce)
3. **Clears** the draft when a message is sent (both in-memory and in DB)

```
Lifecycle:
  Session opens → load draft from DB → populate inputValue
  User types → update local state immediately → debounce 3s → persist to DB
  User switches session → save draft to DB (immediate) → next session loads its draft
  User sends message → clear inputValue → clear draft in DB
  App restarts → session opens → loads persisted draft from DB
```

#### 5.3 Implementation

**Database Migration** (`src/main/db/schema.ts`):

Bump `CURRENT_SCHEMA_VERSION` to 6 and add migration:

```typescript
{
  version: 6,
  name: 'add_session_draft_input',
  up: `ALTER TABLE sessions ADD COLUMN draft_input TEXT DEFAULT NULL;`,
  down: `-- SQLite does not support DROP COLUMN; recreate table if needed`
}
```

**Database Methods** (`src/main/db/database.ts`):

```typescript
getSessionDraft(sessionId: string): string | null {
  const row = this.db.prepare('SELECT draft_input FROM sessions WHERE id = ?').get(sessionId)
  return row?.draft_input ?? null
}

updateSessionDraft(sessionId: string, draft: string | null): void {
  this.db.prepare('UPDATE sessions SET draft_input = ? WHERE id = ?').run(draft, sessionId)
}
```

**IPC Handlers** (`src/main/ipc/session-handlers.ts` or `database-handlers.ts`):

```typescript
ipcMain.handle('db:session:getDraft', (_event, sessionId: string) => {
  return db.getSessionDraft(sessionId)
})

ipcMain.handle('db:session:updateDraft', (_event, sessionId: string, draft: string | null) => {
  db.updateSessionDraft(sessionId, draft)
})
```

**Preload** (`src/preload/index.ts`):

```typescript
session: {
  // ... existing methods
  getDraft: (sessionId: string) => ipcRenderer.invoke('db:session:getDraft', sessionId),
  updateDraft: (sessionId: string, draft: string | null) =>
    ipcRenderer.invoke('db:session:updateDraft', sessionId, draft)
}
```

**Renderer** (`SessionView.tsx`):

```typescript
// Load draft on mount
useEffect(() => {
  window.db.session.getDraft(sessionId).then((draft) => {
    if (draft) setInputValue(draft)
  })
}, [sessionId])

// Debounced save (3 seconds of no changes)
const draftTimerRef = useRef<NodeJS.Timeout | null>(null)

const handleInputChange = useCallback(
  (value: string) => {
    setInputValue(value)

    // Debounce draft persistence
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      window.db.session.updateDraft(sessionId, value || null)
    }, 3000)
  },
  [sessionId]
)

// Save draft on unmount (session switch)
useEffect(() => {
  return () => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    // Save current input value to DB on unmount
    const currentValue = inputValueRef.current // need a ref to read latest value in cleanup
    if (currentValue) {
      window.db.session.updateDraft(sessionId, currentValue)
    }
  }
}, [sessionId])

// Clear draft on send
const handleSend = useCallback(async () => {
  // ... existing send logic
  setInputValue('')
  window.db.session.updateDraft(sessionId, null)
  // ... rest of send
}, [sessionId /* ... */])
```

**Edge Cases**:

- Empty draft: Store as `NULL` not empty string (avoid wasting DB space on empty drafts)
- Session deletion: The `ON DELETE CASCADE` on sessions already handles cleanup of the sessions row
- Rapid session switching: The unmount save is synchronous from the renderer's perspective (fire-and-forget IPC); the next session's draft loads async but is fast (single row lookup by primary key)
- Sending clears the draft before the prompt is dispatched, so if the send fails the draft is already gone (acceptable — the user can re-type or Cmd+Z in the textarea)

#### 5.4 Files to Modify

| File                                                   | Change                                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/main/db/schema.ts`                                | Bump `CURRENT_SCHEMA_VERSION` to 6; add migration for `draft_input TEXT` column on `sessions`                                 |
| `src/main/db/database.ts`                              | Add `getSessionDraft` and `updateSessionDraft` methods                                                                        |
| `src/main/ipc/database-handlers.ts` (or session area)  | Add `db:session:getDraft` and `db:session:updateDraft` IPC handlers                                                           |
| `src/preload/index.ts`                                 | Add `getDraft` and `updateDraft` to `window.db.session`                                                                       |
| `src/preload/index.d.ts`                               | Type declarations for `getDraft` and `updateDraft`                                                                            |
| `src/renderer/src/components/sessions/SessionView.tsx` | Load draft on mount; debounced save on input change (3s); immediate save on unmount; clear draft on send; add `inputValueRef` |

---

### 6. Hidden Files in File Tree

#### 6.1 Current State

- `file-tree-handlers.ts` (lines 95–98) in `scanDirectory()`:

  ```typescript
  // Skip hidden files/folders (starting with .) except important ones
  if (entry.name.startsWith('.') && ![''].includes(entry.name)) {
    continue
  }
  ```

  The exception list `['']` is effectively empty — an empty string never matches any filename starting with `.`. All dotfiles and dot-directories are excluded.

- `file-tree-handlers.ts` (lines 155–157) in `scanSingleDirectory()`:

  ```typescript
  if (entry.name.startsWith('.')) {
    continue
  }
  ```

  Even more blunt — unconditionally skips all dotfiles with no exception list.

- Files like `.env`, `.gitignore`, `.prettierrc`, `.eslintrc`, `.github/`, `.vscode/` are completely invisible in the file tree.

- `.git` is already excluded by `IGNORE_DIRS` (line 38), and `.DS_Store` is already excluded by `IGNORE_FILES` (line 48), so removing the blanket dotfile filter will not expose these.

- The chokidar watcher `IGNORE_PATTERNS` (lines 20–33) already has specific `.git` and `.DS_Store` patterns but does not broadly ignore dotfiles, so change events for dotfiles would fire correctly once they are included in the tree.

#### 6.2 New Design

Remove the blanket `entry.name.startsWith('.')` filter from both `scanDirectory()` and `scanSingleDirectory()`. The specific exclusions in `IGNORE_DIRS` (`.git`, `.cache`) and `IGNORE_FILES` (`.DS_Store`, `Thumbs.db`) are already sufficient to hide unwanted items.

#### 6.3 Implementation

**`scanDirectory()`** — remove lines 95–98:

```typescript
// BEFORE:
// Skip hidden files/folders (starting with .) except important ones
if (entry.name.startsWith('.') && ![''].includes(entry.name)) {
  continue
}

// AFTER:
// (removed — dotfiles are now shown; .git and .DS_Store are already
// excluded by IGNORE_DIRS and IGNORE_FILES above)
```

**`scanSingleDirectory()`** — remove lines 155–157:

```typescript
// BEFORE:
if (entry.name.startsWith('.')) {
  continue
}

// AFTER:
// (removed — same rationale as scanDirectory)
```

**Edge Cases**:

- `.git/` is already in `IGNORE_DIRS`, so it remains hidden
- `.DS_Store` is already in `IGNORE_FILES`, so it remains hidden
- `.cache` is already in `IGNORE_DIRS`, so it remains hidden
- Dot-directories like `.github/`, `.vscode/`, `.husky/` will now be shown and can be expanded
- The file tree's sort order already handles dotfiles correctly (alphabetical, directories first)

#### 6.4 Files to Modify

| File                                 | Change                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `src/main/ipc/file-tree-handlers.ts` | Remove dotfile filter in `scanDirectory()` (lines 95–98) and `scanSingleDirectory()` (lines 155–157) |

---

### 7. Cmd+D File Search Dialog

#### 7.1 Current State

- The command palette (`Cmd+P`) only searches registered commands, not files
- `CommandPalette.tsx` uses the `cmdk` library for the input + list behavior
- `useFileTreeStore` holds the full file tree data for the active worktree (loaded via IPC from `file-tree-handlers.ts`)
- `useFileViewerStore.openFile(path, name, worktreeId)` opens a file in the preview editor, creating a tab and rendering via `FileViewer.tsx`
- The `before-input-event` pattern is established for Cmd+T and (after Feature 1) Cmd+W

#### 7.2 New Design

Create a `FileSearchDialog` component that mirrors the `CommandPalette` structure but searches files instead of commands:

```
┌──────────────────────────────────────────────────┐
│ 🔍  Search files...                               │
├──────────────────────────────────────────────────┤
│  📄 src/main/index.ts                             │
│  📄 src/main/services/opencode-service.ts         │  ← highlighted
│  📄 src/renderer/src/App.tsx                       │
│  📄 package.json                                   │
│  📄 .env                                           │
└──────────────────────────────────────────────────┘
```

- Opened via `Cmd+D`
- Fuzzy-matches against file names and relative paths
- Results update as the user types
- Arrow keys navigate, Enter opens the selected file via `useFileViewerStore.openFile()`
- Escape closes the dialog
- File icons based on extension (or generic file icon)

#### 7.3 Implementation

**Shortcut Interception** (`src/main/index.ts`):

Add Cmd+D to the `before-input-event` listener (Cmd+D is the browser "Bookmark" shortcut in Chromium):

```typescript
if (
  input.key.toLowerCase() === 'd' &&
  (input.meta || input.control) &&
  !input.alt &&
  !input.shift &&
  input.type === 'keyDown'
) {
  event.preventDefault()
  mainWindow!.webContents.send('shortcut:file-search')
}
```

**File Search Store** (new file):

```typescript
import { create } from 'zustand'

interface FileSearchState {
  isOpen: boolean
  searchQuery: string
  selectedIndex: number
  open: () => void
  close: () => void
  toggle: () => void
  setSearchQuery: (query: string) => void
  setSelectedIndex: (index: number) => void
  moveSelection: (direction: 'up' | 'down', maxIndex: number) => void
}
```

**Flat File List Utility**:

Flatten the file tree from `useFileTreeStore` into a flat array of `{ name, path, relativePath }` for searching:

```typescript
function flattenFileTree(
  nodes: FileTreeNode[]
): { name: string; path: string; relativePath: string }[] {
  const result: { name: string; path: string; relativePath: string }[] = []
  const walk = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (!node.isDirectory) {
        result.push({ name: node.name, path: node.path, relativePath: node.relativePath })
      }
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return result
}
```

**Fuzzy Matching**:

Score files by matching against `relativePath` and `name`:

```typescript
function fuzzyMatchFile(query: string, file: { name: string; relativePath: string }): number {
  const q = query.toLowerCase()
  const name = file.name.toLowerCase()
  const path = file.relativePath.toLowerCase()

  if (name === q) return 100 // Exact name match
  if (name.startsWith(q)) return 80 // Name prefix
  if (path.includes(q)) return 60 // Path contains
  if (name.includes(q)) return 50 // Name contains

  // Character-by-character fuzzy: check if all query chars appear in order
  let qi = 0
  for (let i = 0; i < path.length && qi < q.length; i++) {
    if (path[i] === q[qi]) qi++
  }
  if (qi === q.length) return 30

  return 0
}
```

**FileSearchDialog Component**:

Uses `cmdk` (same as `CommandPalette`) for consistent behavior:

```typescript
export function FileSearchDialog() {
  const { isOpen, searchQuery, close, setSearchQuery } = useFileSearchStore()
  const fileTree = useFileTreeStore((s) => s.fileTree)
  const worktreeId = useWorktreeStore((s) => s.selectedWorktreeId)

  const flatFiles = useMemo(() => flattenFileTree(fileTree), [fileTree])
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return flatFiles.slice(0, 50) // Show first 50 when empty
    return flatFiles
      .map((f) => ({ ...f, score: fuzzyMatchFile(searchQuery, f) }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
  }, [flatFiles, searchQuery])

  const handleSelect = useCallback(
    (file: { name: string; path: string }) => {
      useFileViewerStore.getState().openFile(file.path, file.name, worktreeId!)
      close()
    },
    [worktreeId, close]
  )

  if (!isOpen) return null
  // ... render Command dialog with file list
}
```

**Edge Cases**:

- Large file trees: Limit results to 50 items for performance; flatten lazily or cache
- No worktree selected: Disable/hide the shortcut or show empty state
- File tree not loaded yet: Show loading spinner or empty state
- Directories in lazy-load state (no children loaded): Only search files that have been loaded; the initial scan loads the first level, and expanded directories load deeper levels

#### 7.4 Files to Modify/Create

| File                                                           | Change                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/main/index.ts`                                            | Add Cmd+D to `before-input-event` listener, send `shortcut:file-search`       |
| `src/preload/index.ts`                                         | Add `onFileSearchShortcut` listener in `systemOps`                            |
| `src/preload/index.d.ts`                                       | Type declaration for `onFileSearchShortcut`                                   |
| `src/renderer/src/stores/useFileSearchStore.ts`                | **NEW** — Zustand store for file search dialog state                          |
| `src/renderer/src/components/file-search/FileSearchDialog.tsx` | **NEW** — File search modal using `cmdk`, fuzzy matching, file list rendering |
| `src/renderer/src/components/file-search/index.ts`             | **NEW** — Barrel export                                                       |
| `src/renderer/src/lib/keyboard-shortcuts.ts`                   | Add `nav:file-search` shortcut definition                                     |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts`               | Register IPC listener for `shortcut:file-search`; toggle file search store    |
| `src/renderer/src/components/layout/AppLayout.tsx`             | Render `FileSearchDialog` component                                           |

---

### 8. Subagent Handling Fixes

#### 8.1 Current State

There are three distinct bugs in how subagents are handled:

**Bug A — Premature Notifications** (`opencode-service.ts` lines 1003–1008):

When a child/subagent session emits `session.idle`, the event is routed to the parent Hive session via `resolveParentSession()`. Then `maybeNotifySessionComplete(hiveSessionId)` fires for the parent, sending a "session completed" notification even though only a subagent finished — the parent may still be processing.

**Bug B — Subagent Content Streams to Main Page** (`opencode-service.ts` lines 987–999):

After child-to-parent session resolution, all `message.part.updated` events from the child session are persisted and forwarded as top-level parts of the parent's assistant message. Subagent text and tool calls appear interleaved with the parent's own response, creating confusing rendering.

**Bug C — SubtaskCard Parts Always Empty During Streaming** (`SessionView.tsx` lines 854–869):

When a `subtask` part arrives, it's added with `parts: []`. There is no mechanism to route subsequent subagent events into the subtask's nested `parts` array. The `SubtaskCard` only shows content after `finalizeResponseFromDatabase()` reloads from the DB.

Additionally, subtask status is set to `'running'` but never updated to `'completed'` or `'error'` during live streaming — it's a dead-end that only resolves on DB reload.

#### 8.2 New Design

**Fix A — Notification Guard**:

Track which OpenCode session IDs are known child/subagent sessions. When `session.idle` arrives, check if the source session ID is a child — if so, skip `maybeNotifySessionComplete()`. Only notify when the **parent** session itself goes idle.

**Fix B — Child Session Tagging**:

When forwarding stream events from a child session to the renderer, include a `childSessionId` field in the `StreamEvent` payload. This allows the renderer to distinguish child events from parent events and route them appropriately.

```typescript
// StreamEvent enhancement:
interface StreamEvent {
  type: string
  sessionId: string // Hive session ID (parent)
  data: unknown
  childSessionId?: string // OpenCode session ID of the child, if this event came from a subagent
}
```

**Fix C — Renderer Content Routing**:

In the renderer's stream handler, when a `message.part.updated` event arrives with a `childSessionId`:

1. Find the `SubtaskCard` whose `sessionID` matches the `childSessionId`
2. Append the part (text, tool, reasoning) to that subtask's nested `parts` array
3. When `session.idle` arrives with a `childSessionId`, update the corresponding subtask's status to `'completed'`

```
Event routing (after fix):
  Parent text/tool event      → append to top-level streamingParts (existing behavior)
  Child text/tool event       → find SubtaskCard by childSessionId → append to subtask.parts
  Child session.idle event    → find SubtaskCard → set status to 'completed'
  Parent session.idle event   → finalize entire response, trigger notification
```

#### 8.3 Implementation

**Main Process** (`opencode-service.ts`):

Modify `handleEvent()` to tag child events and guard notifications:

```typescript
// After resolving child to parent:
const isChildEvent =
  hiveSessionId !== this.getMappedHiveSessionId(instance, sessionId, eventDirectory)
// (i.e., the original sessionId didn't map directly — we went through resolveParentSession)

// Only notify on parent's own session.idle
if (eventType === 'session.idle') {
  if (!isChildEvent) {
    this.maybeNotifySessionComplete(hiveSessionId)
  }
  // For child session.idle, still forward the event (renderer needs it to update subtask status)
}

// Tag the event with the child session ID
const streamEvent: StreamEvent = {
  type: eventType,
  sessionId: hiveSessionId,
  data: event.properties || event,
  ...(isChildEvent ? { childSessionId: sessionId } : {})
}
```

**Renderer** (`SessionView.tsx`):

Add a ref mapping child session IDs to subtask indices:

```typescript
const childToSubtaskIndexRef = useRef<Map<string, number>>(new Map())
```

When a `subtask` part is added with a `sessionID`:

```typescript
childToSubtaskIndexRef.current.set(part.sessionID, streamingPartsRef.current.length)
```

When a `message.part.updated` event arrives with `event.childSessionId`:

```typescript
if (event.childSessionId) {
  const subtaskIndex = childToSubtaskIndexRef.current.get(event.childSessionId)
  if (subtaskIndex !== undefined) {
    // Append to the subtask's nested parts instead of top-level
    updateStreamingPartsRef((parts) => {
      const updated = [...parts]
      const subtask = updated[subtaskIndex]
      if (subtask?.type === 'subtask') {
        subtask.subtask.parts = [...subtask.subtask.parts, newPart]
      }
      return updated
    })
    return // Don't add as top-level part
  }
}
```

When `session.idle` with `event.childSessionId` arrives:

```typescript
if (event.childSessionId) {
  // Update subtask status to completed
  const subtaskIndex = childToSubtaskIndexRef.current.get(event.childSessionId)
  if (subtaskIndex !== undefined) {
    updateStreamingPartsRef((parts) => {
      const updated = [...parts]
      const subtask = updated[subtaskIndex]
      if (subtask?.type === 'subtask') {
        subtask.subtask.status = 'completed'
      }
      return updated
    })
    immediateFlush()
  }
  return // Don't process as parent session.idle
}
```

**SubtaskCard** (`SubtaskCard.tsx`):

Already renders `subtask.parts` when they exist. The fix is in the data flow — once parts are populated during streaming (instead of only from DB), the existing rendering logic will display them.

#### 8.4 Files to Modify

| File                                                   | Change                                                                                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/services/opencode-service.ts`                | Tag stream events with `childSessionId`; guard `maybeNotifySessionComplete` to only fire for parent `session.idle`; don't persist child events as top-level parent messages |
| `src/preload/index.d.ts`                               | Update `OpenCodeStreamEvent` interface to include optional `childSessionId`                                                                                                 |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add `childToSubtaskIndexRef`; route child events into subtask parts; update subtask status on child `session.idle`; skip parent finalization for child idle                 |
| `src/renderer/src/components/sessions/SubtaskCard.tsx` | Ensure live streaming parts render correctly (may already work once data flow is fixed)                                                                                     |

---

### 9. Subtool Loading Indicator Fix

#### 9.1 Current State

- `isStreaming` is managed in `SessionView.tsx` (line 354) and drives the streaming cursor, "Streaming..." label, and tool card pulse animations
- `setIsStreaming(true)` is called on every `message.part.updated` event (lines 853, 871, 890, 897, 916, 923)
- `setIsStreaming(false)` happens in `resetStreamingState()` (line 680), called during `finalizeResponseFromDatabase()` (which is triggered by both `message.updated` with `time.completed` and `session.idle`)
- **The bug**: When multiple tools run concurrently, the first tool that completes sends a `message.updated` event with `info.time.completed`. This triggers `finalizeResponseFromDatabase()` (line 991), which calls `resetStreamingState()`, which sets `isStreaming` to `false` — even though other tools are still running
- The `hasFinalizedCurrentResponseRef` guard (line 956) prevents double-finalization but does **not** prevent premature finalization — once the first `message.updated` with `time.completed` arrives, the guard is set and streaming stops
- Additionally, a subagent's `session.idle` event (routed to the parent) can trigger `finalizeResponseFromDatabase()` via line 1000–1002, ending the streaming state while the parent is still working

#### 9.2 New Design

The core issue is that `message.updated` with `info.time.completed` from a subagent's completion or from an intermediate tool result triggers premature finalization. The fix has two parts:

1. **Only finalize on `session.idle` from the parent session**: Remove the `message.updated` → finalize path, or guard it more carefully. The `session.idle` event from the parent is the authoritative signal that all processing is complete.

2. **Don't finalize on child `session.idle`**: After implementing Feature 8's child event tagging, child `session.idle` events update subtask status but do NOT trigger `finalizeResponseFromDatabase()` or set `isStreaming(false)`.

Alternatively, keep the `message.updated` finalization path but only trigger it when the message ID matches the **parent** assistant message (not a child message). This is more defensive — if `session.idle` is delayed, the `message.updated` path still works.

#### 9.3 Implementation

**Guard `message.updated` finalization** (`SessionView.tsx`):

Add a check that `message.updated` is from the parent session's own message, not a subagent's:

```typescript
} else if (event.type === 'message.updated') {
  if (eventRole === 'user') return

  // Skip finalization for child/subagent messages
  if (event.childSessionId) return

  // ... existing echo detection and finalization logic
}
```

**Guard `session.idle` finalization** (`SessionView.tsx`):

```typescript
} else if (event.type === 'session.idle') {
  // Skip finalization for child/subagent idle events
  if (event.childSessionId) {
    // Update subtask status (handled in Feature 8)
    return
  }

  // Parent session is truly idle — finalize
  immediateFlush()
  setIsSending(false)
  setQueuedCount(0)

  if (!hasFinalizedCurrentResponseRef.current) {
    hasFinalizedCurrentResponseRef.current = true
    void finalizeResponseFromDatabase()
  }
  // ... existing worktree status update
}
```

**Result**: The streaming indicator (`isStreaming`) stays `true` as long as tools are running. Individual tool completions update the tool card's status (spinner → check) but don't affect the global streaming state. Only the parent's `session.idle` ends streaming.

#### 9.4 Files to Modify

| File                                                   | Change                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Guard `message.updated` finalization against `childSessionId`; guard `session.idle` finalization against child events; keep `isStreaming` true until parent `session.idle` |

---

## Files to Modify — Full Summary

### New Files

| File                                                           | Purpose                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/renderer/src/components/sessions/CopyMessageButton.tsx`   | Copy-to-clipboard button appearing on hover over messages       |
| `src/renderer/src/stores/useFileSearchStore.ts`                | Zustand store for file search dialog open/close state and query |
| `src/renderer/src/components/file-search/FileSearchDialog.tsx` | File search modal with fuzzy matching and file list             |
| `src/renderer/src/components/file-search/index.ts`             | Barrel export for file search components                        |

### Modified Files

| File                                                       | Features      | Changes                                                                                                                      |
| ---------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`                                        | 1, 2, 7       | Add Cmd+W and Cmd+D to `before-input-event`; replace `fileMenu` with custom File menu; call `fixPath()` at startup           |
| `src/main/services/opencode-service.ts`                    | 4, 8          | Add `abort()` method; tag child events with `childSessionId`; guard notifications for parent-only `session.idle`             |
| `src/main/ipc/opencode-handlers.ts`                        | 4             | Add `opencode:abort` IPC handler                                                                                             |
| `src/main/ipc/file-tree-handlers.ts`                       | 6             | Remove blanket dotfile filter in `scanDirectory()` and `scanSingleDirectory()`                                               |
| `src/main/db/schema.ts`                                    | 5             | Bump schema version to 6; add `draft_input` column migration                                                                 |
| `src/main/db/database.ts`                                  | 5             | Add `getSessionDraft` and `updateSessionDraft` methods                                                                       |
| `src/main/ipc/database-handlers.ts`                        | 5             | Add `db:session:getDraft` and `db:session:updateDraft` IPC handlers                                                          |
| `src/preload/index.ts`                                     | 1, 4, 5, 7    | Add `onCloseSessionShortcut`, `abort`, `getDraft`/`updateDraft`, `onFileSearchShortcut`                                      |
| `src/preload/index.d.ts`                                   | 1, 4, 5, 7, 8 | Type declarations for all new preload APIs and `OpenCodeStreamEvent.childSessionId`                                          |
| `src/renderer/src/components/sessions/SessionView.tsx`     | 4, 5, 8, 9    | Stop button UI; draft load/save/clear; child event routing into subtask parts; guard finalization against child events       |
| `src/renderer/src/components/sessions/MessageRenderer.tsx` | 3             | Add `group relative` wrapper and `CopyMessageButton` overlay                                                                 |
| `src/renderer/src/components/sessions/SubtaskCard.tsx`     | 8             | Ensure live streaming parts render during streaming (verify existing rendering handles populated parts)                      |
| `src/renderer/src/lib/keyboard-shortcuts.ts`               | 7             | Add `nav:file-search` shortcut definition                                                                                    |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts`           | 1, 7          | Register IPC listeners for `shortcut:close-session` and `shortcut:file-search`; set `allowInInput: true` for `session:close` |
| `src/renderer/src/components/layout/AppLayout.tsx`         | 7             | Render `FileSearchDialog` component                                                                                          |
| `package.json`                                             | 2             | Add `fix-path` dependency                                                                                                    |

---

## Dependencies to Add

```bash
pnpm add fix-path   # PATH inheritance from login shell (macOS Finder/Dock/Spotlight launch)

# No other new dependencies — all features use existing packages:
# - cmdk (file search dialog — already installed for command palette)
# - lucide-react (Square, Copy, Check icons)
# - zustand (new store for file search)
# - react, electron, better-sqlite3, sonner (existing)
```

---

## Non-Functional Requirements

| Requirement                  | Target                                                                 |
| ---------------------------- | ---------------------------------------------------------------------- |
| Cmd+W interception latency   | < 5ms from keypress to IPC delivery                                    |
| PATH fix startup overhead    | < 500ms (one shell spawn, cached for process lifetime)                 |
| Copy button hover reveal     | < 100ms CSS transition (opacity)                                       |
| Clipboard write              | < 50ms for messages up to 100KB                                        |
| Abort round-trip             | < 200ms from button click to streaming stop                            |
| Draft debounce persistence   | 3000ms after last keystroke (no DB write on every character)           |
| Draft load on session switch | < 50ms (single row SELECT by primary key)                              |
| File tree scan with dotfiles | No measurable regression (same `readdir` call, fewer `continue` skips) |
| File search fuzzy matching   | < 10ms for 10,000 files                                                |
| File search dialog open      | < 100ms from Cmd+D to visible dialog                                   |
| Subagent content routing     | No additional latency (in-memory map lookup per event)                 |
| Streaming indicator accuracy | Stays active until all tools + parent session complete                 |

---

## Out of Scope (Phase 9)

- Toggle to show/hide hidden files in the file tree (all dotfiles are shown; `.git` and `.DS_Store` remain hardcoded exclusions)
- Markdown rendering in the copy output (copies raw text, not rendered HTML)
- Abort with partial retry (abort fully stops; user must send a new prompt to continue)
- Input draft undo/redo history (only the current draft text is persisted, not edit history)
- File search by file contents (Cmd+D searches file names/paths only, not grep)
- File search recent/frecency ranking (results sorted by match score only)
- Subagent progress percentage or ETA in SubtaskCard
- Nested subagent chains (subagent-of-subagent routing — only one level of child→parent is handled)
- Custom exclusion list for the file tree (hardcoded `IGNORE_DIRS`/`IGNORE_FILES` only)
- Configurable draft auto-save interval (hardcoded 3 seconds)

---

## Implementation Priority

### Sprint 1: Platform Fixes (Highest Priority)

1. **Feature 2 — PATH Fix**: Install `fix-path`, call at startup. Without this, the app may not find `opencode` when launched from Finder.
2. **Feature 6 — Hidden Files**: Remove two `continue` statements. Smallest change, high-visibility fix.

### Sprint 2: Window Management + Session Control

3. **Feature 1 — Cmd+W Override**: Intercept at `before-input-event`, replace `fileMenu`, add IPC chain. Prevents accidental app closure.
4. **Feature 4 — Stop Streaming**: Full IPC chain for abort, stop button UI. Core session control — no way to cancel runaway responses.

### Sprint 3: Streaming Correctness

5. **Feature 8 — Subagent Handling**: Tag child events, route into SubtaskCards, guard notifications. Fixes broken streaming UI.
6. **Feature 9 — Subtool Loading**: Guard finalization against child events. Fixes misleading loading indicator. Depends on Feature 8's child tagging.

### Sprint 4: UX Affordances

7. **Feature 3 — Copy on Hover**: New component + wrapper in MessageRenderer. Low risk, high-value UX improvement.
8. **Feature 5 — Input Persistence**: DB migration, IPC handlers, debounced saves. Prevents text loss on session switch.

### Sprint 5: New Feature

9. **Feature 7 — Cmd+D File Search**: New dialog, store, fuzzy matching. Largest new feature, no existing functionality depends on it.

---

## Success Metrics

- Cmd+W never closes the Electron window under any circumstances — only closes the active session tab or does nothing
- Cmd+Q remains the only way to quit the app (plus window close button / OS force quit)
- `opencode serve` starts successfully when the app is launched from Finder/Dock/Spotlight
- Scripts executed via script-runner can access Homebrew/nvm/pyenv binaries
- Hovering over any message reveals a copy button; clicking it copies the raw text to clipboard with toast confirmation
- Clicking the stop button during streaming immediately halts the response; partial output is preserved
- Switching sessions preserves the input field text; reopening the app restores drafts for all active sessions
- Sending a message clears the input field and the persisted draft
- `.env`, `.gitignore`, `.prettierrc`, `.github/`, `.vscode/` files appear in the file tree
- `.git/` and `.DS_Store` remain hidden
- Cmd+D opens a file search dialog; typing filters files by name/path; Enter opens the selected file in the preview editor
- Subagent content appears inside SubtaskCard containers, not interleaved with the parent's response
- Session completion notifications only fire when the parent session is truly done, not when a subagent finishes
- The streaming indicator remains active while any tool is running; it stops only when all tools complete and the parent session goes idle
