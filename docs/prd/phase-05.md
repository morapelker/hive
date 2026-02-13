# Hive - Phase 5 Product Requirements Document

## Overview

**Phase 5** focuses on **project lifecycle scripts, worktree status indicators, a default worktree, app branding, and streaming bug fixes**. The primary work includes per-project setup/run/archive scripts with dedicated UI tabs, a status badge system for worktree activity, a non-archivable default worktree per project, a new professional app icon, and fixing the streaming message duplication bug.

### Phase 5 Goals

- Allow users to configure a setup script per project that runs on worktree initialization
- Allow users to configure a run script per project triggered by Cmd+R
- Allow users to configure an archive script per project that runs before worktree archival
- Display a loading spinner or unread badge on worktrees based on session activity
- Add a default "(no-worktree)" entry per project for running sessions in the project root
- Replace the app icon with the professionally designed icon
- Fix the streaming bug where the user message appears as an assistant message and final messages duplicate

---

## Technical Additions

| Component        | Technology                                                       |
| ---------------- | ---------------------------------------------------------------- |
| Script Execution | Node.js `child_process.spawn` with PTY (node-pty)                |
| Setup/Run Tab UI | xterm.js terminal emulation in BottomPanel tabs                  |
| Status Badges    | Zustand reactive state with per-session status stack             |
| App Icon         | electron-builder icon resource (icns/ico/png)                    |
| Default Worktree | Virtual worktree entry (no git worktree, uses project root path) |

---

## Features

### 1. Setup Script

#### 1.1 Current State

The BottomPanel has a "Setup" tab that renders a TODO placeholder. There is no concept of per-project scripts. Projects have `name, path, description, tags, language` fields.

#### 1.2 New Design

**Project Script Configuration**:
Add a `setup_script` text field to the project configuration. This stores a newline-separated list of shell commands to execute sequentially when a new worktree is initialized.

Users configure the setup script in the project settings (accessible from the project 3-dot menu or Settings > Projects).

```
Project Settings:
┌─────────────────────────────────────────────────────┐
│  Setup Script                                       │
│  ┌─────────────────────────────────────────────────┐│
│  │ pnpm install                                    ││
│  │ pnpm run build                                  ││
│  │ cp .env.example .env                            ││
│  └─────────────────────────────────────────────────┘│
│  Commands run sequentially in the worktree directory│
│                                                     │
│  [Save]                                             │
└─────────────────────────────────────────────────────┘
```

#### 1.3 Execution Flow

When a new worktree is created:

1. After the git worktree is set up and DB entry created
2. If the project has a `setup_script`, start executing commands
3. Commands run sequentially in the **worktree's directory** (not the project root)
4. Output streams live to the **Setup tab** in the BottomPanel
5. Each command runs only after the previous one exits with code 0
6. If a command fails, stop execution and show the error in the Setup tab

#### 1.4 Setup Tab UI

The Setup tab in the BottomPanel renders a terminal-like output area:

```
┌─ [Setup] [Run] [Terminal] ─────────────────────────┐
│                                                     │
│  $ pnpm install                                     │
│  Packages: +342                                     │
│  Progress: ████████████████████████████████ 100%    │
│  Done in 4.2s                                       │
│                                                     │
│  $ pnpm run build                                   │
│  > build                                            │
│  > tsc && vite build                                │
│  ...                                                │
│                                                     │
│                          [Rerun Setup]              │
└─────────────────────────────────────────────────────┘
```

- Show each command prefixed with `$` before its output
- Stream stdout/stderr live as the commands run
- Show a spinner next to the currently running command
- "Rerun Setup" button at the bottom re-executes all commands from scratch
- Use xterm.js or a simple pre/code output area for terminal rendering

#### 1.5 Data Model Changes

Add to projects table:

```sql
ALTER TABLE projects ADD COLUMN setup_script TEXT DEFAULT NULL;
```

Add to `ProjectUpdate` type:

```typescript
setup_script?: string | null
```

#### 1.6 Files to Modify/Create

| File                                                       | Change                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `src/main/db/schema.ts`                                    | Add `setup_script` column to projects table (migration)      |
| `src/shared/types.ts`                                      | Add `setup_script` to Project, ProjectCreate, ProjectUpdate  |
| `src/main/services/script-runner.ts`                       | **NEW** — Script execution service using child_process.spawn |
| `src/main/ipc/script-handlers.ts`                          | **NEW** — IPC handlers for script execution and events       |
| `src/preload/index.ts`                                     | Expose script execution methods                              |
| `src/renderer/src/components/layout/BottomPanel.tsx`       | Replace Setup tab placeholder with terminal output           |
| `src/renderer/src/components/layout/SetupTab.tsx`          | **NEW** — Setup tab with output streaming and Rerun button   |
| `src/renderer/src/stores/useScriptStore.ts`                | **NEW** — Track running scripts, output, and status          |
| `src/renderer/src/components/projects/ProjectSettings.tsx` | Add setup script textarea to project settings                |
| `src/main/ipc/project-handlers.ts`                         | Support updating setup_script field                          |

---

### 2. Run Script

#### 2.1 Current State

The BottomPanel has a "Run" tab that renders a TODO placeholder. There is no Cmd+R shortcut registered.

#### 2.2 New Design

**Project Run Script Configuration**:
Add a `run_script` text field to the project configuration. This stores a newline-separated list of shell commands to execute when the user presses Cmd+R.

```
Project Settings:
┌─────────────────────────────────────────────────────┐
│  Run Script                                         │
│  ┌─────────────────────────────────────────────────┐│
│  │ pnpm run dev                                    ││
│  └─────────────────────────────────────────────────┘│
│  Commands triggered by Cmd+R. Press Cmd+R again     │
│  while running to kill and restart.                 │
│                                                     │
│  [Save]                                             │
└─────────────────────────────────────────────────────┘
```

#### 2.3 Execution Flow

**Start (Cmd+R when not running)**:

1. Execute the `run_script` commands sequentially in the active worktree's directory
2. Output streams to the **Run tab** in the BottomPanel
3. The Run tab auto-focuses when Cmd+R is pressed
4. Commands run in a persistent child process

**Kill + Restart (Cmd+R while running)**:

1. Send SIGTERM to the running process group
2. Wait briefly for graceful shutdown (500ms)
3. If still running, send SIGKILL
4. Once killed, restart the script from the beginning
5. Clear the previous output in the Run tab

#### 2.4 Run Tab UI

```
┌─ [Setup] [Run] [Terminal] ─────────────────────────┐
│                                                     │
│  $ pnpm run dev                                     │
│                                                     │
│  > dev                                              │
│  > next dev                                         │
│                                                     │
│  ▲ Next.js 14.1.0                                   │
│  - Local: http://localhost:3000                      │
│  - Ready in 2.3s                                    │
│                                                     │
│  ● Running              [Stop] [Restart]            │
└─────────────────────────────────────────────────────┘
```

- Show a green "Running" indicator when the process is alive
- "Stop" button sends SIGTERM/SIGKILL
- "Restart" button kills and re-runs
- Use xterm.js for proper terminal rendering (colors, cursor control)
- The output area should behave like a real terminal (scroll, ANSI colors)

#### 2.5 Keyboard Shortcut

Register `Cmd+R` as a new global shortcut:

```typescript
// In keyboard-shortcuts.ts
{
  id: 'project:run',
  label: 'Run Project',
  defaultBinding: { key: 'r', meta: true },
  category: 'session'
}
```

#### 2.6 Data Model Changes

Add to projects table:

```sql
ALTER TABLE projects ADD COLUMN run_script TEXT DEFAULT NULL;
```

#### 2.7 Files to Modify/Create

| File                                                       | Change                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/main/db/schema.ts`                                    | Add `run_script` column to projects table (same migration as setup_script) |
| `src/shared/types.ts`                                      | Add `run_script` to Project, ProjectCreate, ProjectUpdate                  |
| `src/main/services/script-runner.ts`                       | Add long-running process support with kill/restart                         |
| `src/main/ipc/script-handlers.ts`                          | Add `script:run`, `script:kill` IPC handlers                               |
| `src/preload/index.ts`                                     | Expose run/kill script methods                                             |
| `src/renderer/src/components/layout/BottomPanel.tsx`       | Replace Run tab placeholder with terminal output                           |
| `src/renderer/src/components/layout/RunTab.tsx`            | **NEW** — Run tab with live output, Stop/Restart buttons                   |
| `src/renderer/src/stores/useScriptStore.ts`                | Add run script state (running/stopped, output, PID)                        |
| `src/renderer/src/components/projects/ProjectSettings.tsx` | Add run script textarea                                                    |
| `src/renderer/src/lib/keyboard-shortcuts.ts`               | Add `project:run` shortcut (Cmd+R)                                         |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts`           | Handle Cmd+R action                                                        |

---

### 3. Archive Script

#### 3.1 Current State

Archiving a worktree calls `gitService.archiveWorktree()` which removes the git worktree directory and deletes the branch. There is no pre-archive hook.

#### 3.2 New Design

**Project Archive Script Configuration**:
Add an `archive_script` text field to the project configuration. This stores a newline-separated list of shell commands to execute **before** a worktree is archived.

```
Project Settings:
┌─────────────────────────────────────────────────────┐
│  Archive Script                                     │
│  ┌─────────────────────────────────────────────────┐│
│  │ pnpm run clean                                  ││
│  │ docker compose down                             ││
│  └─────────────────────────────────────────────────┘│
│  Runs before worktree archival. If a command fails, │
│  archival proceeds anyway (with warning).           │
│                                                     │
│  [Save]                                             │
└─────────────────────────────────────────────────────┘
```

#### 3.3 Execution Flow

When a user archives a worktree:

1. If the project has an `archive_script`, run it **before** the worktree is removed
2. Commands execute sequentially in the **worktree's directory**
3. Show a progress indicator (e.g., "Running archive script...") during execution
4. If a command fails, log the error but **proceed with archival anyway** (warn the user)
5. After the archive script completes (or fails), proceed with the normal archive flow (remove worktree + delete branch)

#### 3.4 Data Model Changes

Add to projects table:

```sql
ALTER TABLE projects ADD COLUMN archive_script TEXT DEFAULT NULL;
```

#### 3.5 Files to Modify/Create

| File                                                       | Change                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `src/main/db/schema.ts`                                    | Add `archive_script` column to projects table (same migration) |
| `src/shared/types.ts`                                      | Add `archive_script` to Project, ProjectCreate, ProjectUpdate  |
| `src/main/services/script-runner.ts`                       | Add non-interactive script execution for archive               |
| `src/main/ipc/worktree-handlers.ts`                        | Run archive script before worktree deletion                    |
| `src/renderer/src/components/projects/ProjectSettings.tsx` | Add archive script textarea                                    |

---

### 4. Status Indicator per Worktree

#### 4.1 Current State

Worktrees are shown in the sidebar with a static icon (branch icon). Sessions have a `status` field (`active/completed/error`) but there is no visual indicator of session activity on the worktree level. The session store tracks connection status per session.

#### 4.2 New Design

**Status Stack per Worktree**:
Maintain a map of session statuses per worktree. Each session within a worktree can have one of three visual states:

| Status    | Visual                 | Meaning                                              |
| --------- | ---------------------- | ---------------------------------------------------- |
| `null`    | No badge (normal icon) | Session is idle and has been viewed                  |
| `working` | Spinning loader        | Session is actively processing (AI is responding)    |
| `unread`  | Unread dot badge       | Session completed but user hasn't viewed the tab yet |

**Worktree Badge Logic**:
The worktree icon in the sidebar is replaced by a badge when **any** session in that worktree has a non-null status. The badge shown is the **most recent status change** among all sessions:

```
Priority: working > unread > null

Worktree "feature-auth":
  Session 1: null
  Session 2: working    <- most recent change
  Session 3: unread

  -> Show: spinning loader (working takes priority as most recent)
```

#### 4.3 Status Transitions

```
Session lifecycle status changes:

1. User sends a message -> set session status to "working"
2. AI finishes responding (stream completes) ->
   - If user is currently viewing this session tab: set to null
   - If user is NOT viewing this session tab: set to "unread"
3. User switches to a tab with "unread" status -> set to null
4. User switches away from a "working" tab -> status stays "working"
```

#### 4.4 Implementation

**Status Store** (`useWorktreeStatusStore.ts`):

```typescript
interface WorktreeStatusStore {
  // Map of sessionId -> status
  sessionStatuses: Record<string, 'working' | 'unread' | null>

  // Set a session status
  setSessionStatus: (sessionId: string, status: 'working' | 'unread' | null) => void

  // Get the display status for a worktree (derived from its sessions)
  getWorktreeStatus: (worktreeId: string) => 'working' | 'unread' | null

  // Clear status when viewing a session
  clearSessionStatus: (sessionId: string) => void
}
```

**Worktree Sidebar Badge**:

```
Normal:           Working:          Unread:
┌──────────┐     ┌──────────┐     ┌──────────┐
│ ⎇ auth   │     │ ⟳ auth   │     │ ● auth   │
└──────────┘     └──────────┘     └──────────┘
```

- Replace the branch/worktree icon with a spinner when `working`
- Show a small colored dot badge when `unread`
- Return to normal icon when all sessions are `null`

#### 4.5 Files to Modify/Create

| File                                                     | Change                                                 |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `src/renderer/src/stores/useWorktreeStatusStore.ts`      | **NEW** — Session status tracking per worktree         |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Show badge/spinner based on worktree status            |
| `src/renderer/src/components/sessions/SessionView.tsx`   | Set status to "working" on prompt, clear on stream end |
| `src/renderer/src/components/sessions/SessionTabs.tsx`   | Clear "unread" status when tab is selected             |
| `src/renderer/src/stores/useSessionStore.ts`             | Integrate status updates on session events             |

---

### 5. App Icon

#### 5.1 Current State

The app uses the default Electron icon. The `resources/` directory contains only a `.gitkeep` file. No custom icon is configured in the build process.

#### 5.2 New Design

Replace the app icon with the professionally designed icon at `resources/icon.png`.

#### 5.3 Implementation

1. Convert the PNG to the required formats:
   - **macOS**: `icon.icns` (multiple resolutions bundled)
   - **Windows**: `icon.ico` (multiple resolutions bundled)
   - **Linux**: `icon.png` (512x512)

2. Place the converted icons in the `resources/` directory:

   ```
   resources/
   ├── icon.icns    (macOS)
   ├── icon.ico     (Windows)
   └── icon.png     (Linux, 512x512)
   ```

3. Update `electron-builder` configuration in `package.json` or `electron-builder.yml` to reference the icon files (if not auto-detected from `resources/`).

4. Electron-builder auto-detects icons from the `resources/` directory by convention, so placing them there should suffice.

#### 5.4 Files to Modify/Create

| File                                     | Change                                                |
| ---------------------------------------- | ----------------------------------------------------- |
| `resources/icon.icns`                    | **NEW** — macOS app icon                              |
| `resources/icon.ico`                     | **NEW** — Windows app icon                            |
| `resources/icon.png`                     | **NEW** — Linux app icon (512x512)                    |
| `electron-builder.yml` or `package.json` | Verify icon path configuration (may be auto-detected) |

---

### 6. Streaming Bug Fix

#### 6.1 Current Issue

Two bugs in the streaming message handling:

**Bug A — User message appears as assistant message**:
When sending a message to OpenCode, the user's message immediately appears as an **assistant** message in the chat (in addition to the correct user message). This suggests that the event handler is treating the echoed user content as an assistant response.

**Bug B — Final message duplication**:
Sometimes the final assistant message gets rendered **twice** — the complete message appears once from streaming accumulation and once from a final "message complete" event that re-adds the same content.

#### 6.2 Root Cause Investigation

The streaming event handling in `SessionView.tsx` and the OpenCode event processor need to be audited for:

1. **Bug A**: The `message.part.updated` or `message.updated` events may be firing for the **user's message** (role: "user") and being treated as assistant content. The event handler should check `message.role` and skip user messages.

2. **Bug B**: The stream accumulates text via `message.part.updated` events. When the stream ends, a `message.updated` event may deliver the complete message, causing the final text to be appended again. The handler should either:
   - Ignore `message.updated` for text that was already streamed via parts
   - Replace (not append) the streaming content with the final message content
   - Track whether content was already received via streaming parts

#### 6.3 Fix Strategy

**Bug A Fix**:
In the event handler, check the message role before processing:

```typescript
// Skip user messages — we already display them from the local send
if (message.role === 'user') return
```

**Bug B Fix**:
When a `message.updated` or `session.idle` event arrives with the complete message:

- Replace the streaming content with the finalized message (don't append)
- Clear streaming state to prevent duplication
- Use a flag or message ID deduplication to ensure each message renders exactly once

#### 6.4 Files to Modify

| File                                                   | Change                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Fix event handler to skip user messages, deduplicate final messages |
| `src/main/services/opencode-service.ts`                | Verify event forwarding doesn't duplicate messages                  |
| `src/main/ipc/opencode-handlers.ts`                    | Verify IPC event forwarding logic                                   |

---

### 7. Default Worktree (No-Worktree Entry)

#### 7.1 Current State

Every project requires creating a worktree (git worktree) before launching sessions. There is no way to run sessions in the project's root directory without branching.

#### 7.2 New Design

Add a **permanent, non-archivable "(no-worktree)"** entry as the first item in every project's worktree list. This entry:

- Uses the **project's root directory** as the working directory (no git worktree created)
- Is always visible as the first item in the worktree list
- Cannot be archived or deleted
- Allows launching sessions just like any other worktree
- Uses the project's current branch (whatever is checked out)

```
Worktree List:
┌──────────────────────────────────────────────────────┐
│ 📁 (no-worktree)        <-- always first, non-archivable
│ ⎇ feature-auth
│ ⎇ bugfix-login
│ + New Worktree
└──────────────────────────────────────────────────────┘
```

#### 7.3 Implementation Strategy

**Option A — Virtual worktree (recommended)**:
Create a special worktree record in the database when a project is added, with:

- `name`: "(no-worktree)"
- `branch_name`: null or empty (uses whatever branch the project root is on)
- `path`: same as the project's root path
- `status`: "active" (permanently, cannot change)
- A special flag or convention (e.g., `is_default: true` or `id` matching a pattern) to identify it

**Behavior differences from regular worktrees**:

- Context menu: no "Archive" or "Unbranch" options
- No branch deletion on cleanup
- Sessions run in the project root directory
- The OpenCode service connects using the project path instead of a worktree path

#### 7.4 Data Model Changes

Add a `is_default` boolean column to the worktrees table:

```sql
ALTER TABLE worktrees ADD COLUMN is_default INTEGER DEFAULT 0;
```

When a project is created, automatically insert a default worktree:

```sql
INSERT INTO worktrees (project_id, name, branch_name, path, status, is_default)
VALUES (?, '(no-worktree)', NULL, ?, 'active', 1);
```

#### 7.5 UI Behavior

- The default worktree always appears first in the list, separated from regular worktrees
- It uses a folder icon instead of a branch icon
- No archive/unbranch options in its context menu
- Clicking it selects it as the active worktree (sessions run in project root)
- When selected, the right sidebar shows the project root's file tree and git status

#### 7.6 Files to Modify/Create

| File                                                     | Change                                                   |
| -------------------------------------------------------- | -------------------------------------------------------- |
| `src/main/db/schema.ts`                                  | Add `is_default` column to worktrees table (migration)   |
| `src/shared/types.ts`                                    | Add `is_default` to Worktree type                        |
| `src/main/ipc/project-handlers.ts`                       | Create default worktree when project is added            |
| `src/renderer/src/components/worktrees/WorktreeList.tsx` | Always show default worktree first, no archive option    |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Different icon and context menu for default worktree     |
| `src/renderer/src/stores/useWorktreeStore.ts`            | Never filter out default worktree, prevent archiving     |
| `src/main/ipc/worktree-handlers.ts`                      | Block archive/delete operations on default worktrees     |
| `src/main/db/migrations/`                                | Migration to add default worktrees for existing projects |

---

## Files to Modify — Full Summary

### New Files

| File                                                | Purpose                                         |
| --------------------------------------------------- | ----------------------------------------------- |
| `src/main/services/script-runner.ts`                | Script execution service (setup, run, archive)  |
| `src/main/ipc/script-handlers.ts`                   | IPC handlers for script execution               |
| `src/renderer/src/components/layout/SetupTab.tsx`   | Setup tab with terminal output and Rerun button |
| `src/renderer/src/components/layout/RunTab.tsx`     | Run tab with live output, Stop/Restart          |
| `src/renderer/src/stores/useScriptStore.ts`         | Script execution state management               |
| `src/renderer/src/stores/useWorktreeStatusStore.ts` | Session status tracking for worktree badges     |
| `resources/icon.icns`                               | macOS app icon                                  |
| `resources/icon.ico`                                | Windows app icon                                |
| `resources/icon.png`                                | Linux app icon                                  |

### Modified Files

| File                                                       | Change                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/main/db/schema.ts`                                    | Migration: add setup_script, run_script, archive_script to projects; is_default to worktrees |
| `src/shared/types.ts`                                      | Add script fields to Project types, is_default to Worktree                                   |
| `src/main/ipc/project-handlers.ts`                         | Script field updates, create default worktree on project add                                 |
| `src/main/ipc/worktree-handlers.ts`                        | Run archive script before deletion, block default worktree deletion                          |
| `src/preload/index.ts`                                     | Expose script execution and kill methods                                                     |
| `src/renderer/src/components/layout/BottomPanel.tsx`       | Wire SetupTab and RunTab components into tabs                                                |
| `src/renderer/src/components/projects/ProjectSettings.tsx` | Add script configuration textareas                                                           |
| `src/renderer/src/components/worktrees/WorktreeList.tsx`   | Default worktree always first                                                                |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx`   | Status badges, default worktree icon                                                         |
| `src/renderer/src/components/sessions/SessionView.tsx`     | Fix streaming bugs, set working/unread status                                                |
| `src/renderer/src/components/sessions/SessionTabs.tsx`     | Clear unread on tab select                                                                   |
| `src/renderer/src/stores/useWorktreeStore.ts`              | Default worktree handling                                                                    |
| `src/renderer/src/stores/useSessionStore.ts`               | Integrate status updates                                                                     |
| `src/renderer/src/lib/keyboard-shortcuts.ts`               | Add Cmd+R shortcut                                                                           |
| `src/renderer/src/hooks/useKeyboardShortcuts.ts`           | Handle Cmd+R action                                                                          |
| `src/main/services/opencode-service.ts`                    | Verify event forwarding for streaming fix                                                    |
| `src/main/ipc/opencode-handlers.ts`                        | Verify IPC event logic for streaming fix                                                     |

---

## Dependencies to Add

```bash
pnpm add node-pty       # PTY for terminal emulation in script runner
pnpm add xterm          # Terminal rendering in Setup/Run tabs
pnpm add xterm-addon-fit # Auto-fit terminal to container
```

Note: `node-pty` requires native compilation. Ensure `electron-rebuild` handles it correctly for the target Electron version.

---

## Non-Functional Requirements

| Requirement                           | Target                                |
| ------------------------------------- | ------------------------------------- |
| Setup script execution start          | < 500ms after worktree creation       |
| Run script start (Cmd+R)              | < 200ms response                      |
| Run script kill (Cmd+R while running) | < 1s graceful shutdown                |
| Archive script timeout                | 30s max per command                   |
| Worktree status badge update          | < 100ms after session state change    |
| Default worktree session launch       | Same latency as regular worktrees     |
| App icon display                      | Correct on macOS, Windows, Linux      |
| Streaming bug fix                     | No duplicate messages in any scenario |

---

## Out of Scope (Phase 5)

- Terminal tab content in BottomPanel (existing placeholder remains)
- Script editing with syntax highlighting or autocomplete
- Script environment variable management UI
- Per-worktree script overrides (scripts are per-project only)
- Custom badge colors or animations
- Multiple run script profiles (only one run script per project)
- App icon auto-update or dynamic tray icon
- Comprehensive streaming architecture rewrite (targeted fix only)

---

## Implementation Priority

### Sprint 1: Database Migration & Project Scripts Config

1. Add migration for setup_script, run_script, archive_script columns
2. Add is_default column to worktrees table
3. Update shared types
4. Add script configuration UI to ProjectSettings
5. Wire IPC handlers for script field updates

### Sprint 2: Script Runner Service & Setup Tab

1. Create script-runner service with sequential command execution
2. Create IPC handlers for script execution with streaming output
3. Build SetupTab component with terminal output rendering
4. Wire setup script execution into worktree creation flow
5. Add "Rerun Setup" button functionality

### Sprint 3: Run Script & Cmd+R

1. Add long-running process support to script-runner
2. Add kill/restart logic with SIGTERM/SIGKILL
3. Build RunTab component with Stop/Restart buttons
4. Register Cmd+R keyboard shortcut
5. Wire Cmd+R to run/kill toggle behavior

### Sprint 4: Archive Script & Default Worktree

1. Wire archive script execution into worktree archive flow
2. Create default worktree on project creation
3. Add migration for existing projects (create default worktrees)
4. Update WorktreeList and WorktreeItem for default worktree
5. Block archive/delete on default worktrees

### Sprint 5: Worktree Status Badges

1. Create useWorktreeStatusStore
2. Integrate status updates in SessionView (working on send, unread on complete)
3. Clear unread status on tab selection
4. Update WorktreeItem to show badge/spinner
5. Test status transitions across multiple sessions

### Sprint 6: App Icon & Streaming Bug Fix

1. Convert appicon.png to icns/ico formats
2. Place icons in resources/ directory
3. Verify electron-builder picks up icons correctly
4. Audit streaming event handler for message role filtering
5. Fix final message duplication with deduplication logic
6. Test streaming with various message patterns

---

## Success Metrics

- Users can configure setup/run/archive scripts per project in settings
- Setup script runs automatically on worktree creation with live output in Setup tab
- Cmd+R starts the run script; pressing again kills and restarts it
- Archive script runs before worktree deletion (failures don't block archival)
- Worktrees show spinner when sessions are active and unread dot when complete
- Every project has a non-archivable "(no-worktree)" entry for root-directory sessions
- The app icon displays the professional design on all platforms
- No duplicate messages appear during or after streaming
