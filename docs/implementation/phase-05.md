# Hive Phase 5 Implementation Plan

This document outlines the implementation plan for Hive Phase 5, focusing on project lifecycle scripts (setup/run/archive), worktree status badges, a default worktree, app icon replacement, and streaming bug fixes.

---

## Overview

The implementation is divided into **10 focused sessions**, each with:
- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 5 builds upon Phase 4** — all Phase 4 infrastructure (theme system, model selection, streaming throttle, file viewer, language detection, session auto-naming, right sidebar split with BottomPanel, header quick actions) is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 5)
```
test/
├── phase-5/
│   ├── session-1/
│   │   └── db-migration-types.test.ts
│   ├── session-2/
│   │   └── script-runner.test.ts
│   ├── session-3/
│   │   └── project-scripts-ui.test.ts
│   ├── session-4/
│   │   └── setup-tab.test.ts
│   ├── session-5/
│   │   └── run-tab-cmd-r.test.ts
│   ├── session-6/
│   │   └── archive-script-default-worktree.test.ts
│   ├── session-7/
│   │   └── worktree-status-badges.test.ts
│   ├── session-8/
│   │   └── app-icon.test.ts
│   ├── session-9/
│   │   └── streaming-bug-fix.test.ts
│   └── session-10/
│       └── integration-polish.test.ts
```

### New Dependencies
```json
{
  "node-pty": "latest",
  "xterm": "latest",
  "xterm-addon-fit": "latest"
}
```

Note: `node-pty` requires native compilation. Electron-rebuild must handle it for the target Electron version (^33.2.1).

---

## Session 1: Database Migration & Types

### Objectives
- Add migration v4 for project script columns and worktree default flag
- Update shared type definitions to include new fields
- Ensure migration runs cleanly on existing databases

### Tasks
1. In `src/main/db/schema.ts`:
   - Increment `CURRENT_SCHEMA_VERSION` from `3` to `4`
   - Add migration v4 in the `migrateUp` function:
     ```sql
     ALTER TABLE projects ADD COLUMN setup_script TEXT DEFAULT NULL;
     ALTER TABLE projects ADD COLUMN run_script TEXT DEFAULT NULL;
     ALTER TABLE projects ADD COLUMN archive_script TEXT DEFAULT NULL;
     ALTER TABLE worktrees ADD COLUMN is_default INTEGER DEFAULT 0;
     ```
   - Add migration v4 down in `migrateDown` (no-op for SQLite, add comment explaining)
   - After migration: insert default worktrees for all existing projects that don't have one:
     ```sql
     INSERT INTO worktrees (id, project_id, name, branch_name, path, status, is_default, created_at, last_accessed_at)
     SELECT lower(hex(randomblob(4))), p.id, '(no-worktree)', NULL, p.path, 'active', 1, datetime('now'), datetime('now')
     FROM projects p
     WHERE p.id NOT IN (SELECT project_id FROM worktrees WHERE is_default = 1)
     ```
2. In `src/main/db/types.ts`:
   - Add to `Project` interface: `setup_script: string | null`, `run_script: string | null`, `archive_script: string | null`
   - Add to `ProjectCreate`: `setup_script?: string | null`, `run_script?: string | null`, `archive_script?: string | null`
   - Add to `ProjectUpdate`: `setup_script?: string | null`, `run_script?: string | null`, `archive_script?: string | null`
   - Add to `Worktree` interface: `is_default: boolean` (mapped from INTEGER 0/1)
   - Add to `WorktreeCreate`: `is_default?: boolean`
3. Update any DB query builders that insert/update projects to include the new columns
4. Update any DB query builders that read worktrees to include `is_default`

### Key Files
- `src/main/db/schema.ts` — migration v4
- `src/main/db/types.ts` — type updates
- `src/main/db/index.ts` — query builder updates (if separate)

### Definition of Done
- [ ] `CURRENT_SCHEMA_VERSION` is `4`
- [ ] Migration v4 adds `setup_script`, `run_script`, `archive_script` columns to projects
- [ ] Migration v4 adds `is_default` column to worktrees
- [ ] Migration v4 inserts default worktrees for existing projects
- [ ] `Project` type includes `setup_script`, `run_script`, `archive_script` (all nullable strings)
- [ ] `Worktree` type includes `is_default` (boolean)
- [ ] Existing database migrates cleanly from v3 to v4
- [ ] Fresh database creates all columns correctly
- [ ] DB queries for projects include new columns
- [ ] DB queries for worktrees include `is_default`

### Testing Criteria
```typescript
// test/phase-5/session-1/db-migration-types.test.ts
describe('Session 1: Database Migration & Types', () => {
  test('Schema version is 4', () => {
    // Import CURRENT_SCHEMA_VERSION
    // Verify equals 4
  });

  test('Migration v4 adds project script columns', () => {
    // Create v3 database
    // Run migration v4
    // Verify setup_script, run_script, archive_script columns exist on projects
  });

  test('Migration v4 adds is_default to worktrees', () => {
    // Create v3 database
    // Run migration v4
    // Verify is_default column exists on worktrees
  });

  test('Migration v4 creates default worktrees for existing projects', () => {
    // Create v3 database with 2 projects, no default worktrees
    // Run migration v4
    // Verify 2 default worktrees exist (one per project)
    // Verify each has is_default = 1, path = project path, name = '(no-worktree)'
  });

  test('Script columns default to NULL', () => {
    // Insert a project without specifying script columns
    // Verify all three are NULL
  });

  test('is_default defaults to 0', () => {
    // Insert a regular worktree
    // Verify is_default is 0
  });

  test('Project type includes script fields', () => {
    // Read a project from DB
    // Verify setup_script, run_script, archive_script are accessible (null or string)
  });

  test('Worktree type includes is_default field', () => {
    // Read a worktree from DB
    // Verify is_default is accessible (boolean)
  });

  test('Fresh database creates all v4 columns', () => {
    // Create brand new database
    // Verify all columns present in both tables
  });
});
```

---

## Session 2: Script Runner Service

### Objectives
- Create a main-process service for executing shell commands sequentially
- Support streaming stdout/stderr output via IPC events
- Support long-running processes with kill/restart capability
- Create IPC handlers for script operations

### Tasks
1. Create `src/main/services/script-runner.ts`:
   - Export class `ScriptRunner` with methods:
     - `runSequential(commands: string[], cwd: string, eventKey: string): Promise<{success: boolean, error?: string}>`
       - Parse `commands` (split by newline, filter empty lines and comments)
       - For each command: spawn via `child_process.spawn('sh', ['-c', command], { cwd, env: process.env })`
       - Pipe stdout/stderr to IPC event: `webContents.send(eventKey, { type: 'output', data: chunk.toString() })`
       - Send command start event: `{ type: 'command-start', command }`
       - Wait for exit code 0 before running next command
       - On non-zero exit: send `{ type: 'error', command, exitCode }`, stop and return `{ success: false }`
       - On all complete: send `{ type: 'done' }`, return `{ success: true }`
     - `runPersistent(commands: string[], cwd: string, eventKey: string): { pid: number, kill: () => void }`
       - Combine commands with `&&` or run as a shell script
       - Spawn with `detached: false` so we can kill the process group
       - Return PID and a `kill()` function that sends SIGTERM, waits 500ms, then SIGKILL if still alive
       - Stream stdout/stderr to IPC event channel
     - `runAndWait(commands: string[], cwd: string, timeout?: number): Promise<{success: boolean, output: string, error?: string}>`
       - For archive scripts — non-interactive, captures output
       - Default timeout: 30000ms per command
       - Returns combined output for logging
   - Store running processes in a Map keyed by `eventKey` for cleanup
   - Handle process cleanup on app quit (kill all running processes)
2. Create `src/main/ipc/script-handlers.ts`:
   - `ipcMain.handle('script:runSetup', async (_, { commands, cwd, worktreeId }) => { ... })`
     - Uses `scriptRunner.runSequential(commands, cwd, `script:setup:${worktreeId}`)`
   - `ipcMain.handle('script:runProject', async (_, { commands, cwd, worktreeId }) => { ... })`
     - Uses `scriptRunner.runPersistent(commands, cwd, `script:run:${worktreeId}`)`
     - Returns `{ pid }` for tracking
   - `ipcMain.handle('script:kill', async (_, { worktreeId }) => { ... })`
     - Finds running process by key `script:run:${worktreeId}`, calls `kill()`
   - `ipcMain.handle('script:runArchive', async (_, { commands, cwd }) => { ... })`
     - Uses `scriptRunner.runAndWait(commands, cwd, 30000)`
3. Register script handlers in main process initialization (where other IPC handlers are registered)
4. In `src/preload/index.ts`, add to a new `scriptOps` API:
   - `runSetup: (commands, cwd, worktreeId) => ipcRenderer.invoke('script:runSetup', { commands, cwd, worktreeId })`
   - `runProject: (commands, cwd, worktreeId) => ipcRenderer.invoke('script:runProject', { commands, cwd, worktreeId })`
   - `kill: (worktreeId) => ipcRenderer.invoke('script:kill', { worktreeId })`
   - `runArchive: (commands, cwd) => ipcRenderer.invoke('script:runArchive', { commands, cwd })`
   - `onOutput: (channel, callback) => ipcRenderer.on(channel, (_, data) => callback(data))`
   - `offOutput: (channel) => ipcRenderer.removeAllListeners(channel)`

### Key Files
- `src/main/services/script-runner.ts` — **NEW**
- `src/main/ipc/script-handlers.ts` — **NEW**
- `src/preload/index.ts` — add scriptOps
- `src/main/index.ts` — register script handlers

### Definition of Done
- [ ] `ScriptRunner.runSequential` executes commands one-by-one in order
- [ ] Sequential execution stops on first non-zero exit code
- [ ] stdout/stderr streamed to renderer via IPC events
- [ ] Command start/done/error events sent for UI tracking
- [ ] `ScriptRunner.runPersistent` spawns a long-running process
- [ ] `kill()` sends SIGTERM then SIGKILL after 500ms timeout
- [ ] `ScriptRunner.runAndWait` captures output with 30s timeout
- [ ] IPC handlers registered and accessible from renderer
- [ ] `scriptOps` exposed in preload with all methods
- [ ] Running processes killed on app quit

### Testing Criteria
```typescript
// test/phase-5/session-2/script-runner.test.ts
describe('Session 2: Script Runner Service', () => {
  test('runSequential executes commands in order', () => {
    // Run: ['echo "first"', 'echo "second"']
    // Verify output events received in order: "first", "second"
    // Verify returns { success: true }
  });

  test('runSequential stops on failure', () => {
    // Run: ['echo "ok"', 'exit 1', 'echo "should not run"']
    // Verify "ok" output received
    // Verify error event with exitCode 1
    // Verify "should not run" NOT in output
    // Verify returns { success: false }
  });

  test('runSequential streams output events', () => {
    // Run: ['echo "hello world"']
    // Verify IPC event sent with { type: 'output', data: 'hello world\n' }
  });

  test('runSequential sends command-start events', () => {
    // Run: ['echo "a"', 'echo "b"']
    // Verify two command-start events with correct command strings
  });

  test('runPersistent returns PID and kill function', () => {
    // Run: ['sleep 60']
    // Verify returns { pid: number, kill: function }
    // Verify process is running (check PID)
  });

  test('kill sends SIGTERM then SIGKILL', () => {
    // Run: ['sleep 60'] persistently
    // Call kill()
    // Verify process is dead within 1s
  });

  test('runAndWait captures output', () => {
    // Run: ['echo "captured"']
    // Verify returns { success: true, output: 'captured\n' }
  });

  test('runAndWait respects timeout', () => {
    // Run: ['sleep 60'] with timeout: 1000
    // Verify returns within ~1s
    // Verify returns { success: false }
  });

  test('IPC handlers accessible from renderer', () => {
    // Invoke script:runSetup via IPC
    // Verify handler responds
  });

  test('scriptOps exposed in preload', () => {
    // Verify window.scriptOps has: runSetup, runProject, kill, runArchive, onOutput, offOutput
  });
});
```

---

## Session 3: Project Scripts Configuration UI

### Objectives
- Add script configuration textareas to project settings
- Support saving setup, run, and archive scripts per project
- Wire IPC handlers for updating project script fields

### Tasks
1. In `src/main/ipc/project-handlers.ts`:
   - Ensure the `db:project:update` handler supports updating `setup_script`, `run_script`, `archive_script` fields
   - The handler should accept partial updates and only SET the fields that are provided
2. Create or update `src/renderer/src/components/projects/ProjectSettings.tsx`:
   - If a project settings panel/modal exists, add 3 new sections
   - If not, create a settings panel accessible from the project 3-dot menu ("Project Settings")
   - Three sections, each with a label, description, and textarea:
     - **Setup Script**: "Commands to run when a new worktree is initialized. Each line is a separate command."
     - **Run Script**: "Commands triggered by ⌘R. Press ⌘R again while running to kill and restart."
     - **Archive Script**: "Commands to run before worktree archival. Failures won't block archival."
   - Each textarea:
     - Monospace font (`font-mono text-sm`)
     - Placeholder: e.g., `pnpm install\npnpm run build`
     - 4-6 rows default, auto-resize optional
   - Save button at the bottom (or auto-save on blur/change with debounce)
   - Load current script values when the panel opens (from project data)
   - On save: call `window.db.project.update(projectId, { setup_script, run_script, archive_script })`
3. In `src/renderer/src/components/projects/ProjectItem.tsx` (or wherever the 3-dot menu is):
   - Add "Settings" or "Project Settings" option to the dropdown menu
   - On click: open the ProjectSettings panel/modal for this project
4. In `src/renderer/src/stores/useProjectStore.ts`:
   - Add `updateProject(projectId, updates)` action if not already present
   - Ensure the store reflects script field updates reactively

### Key Files
- `src/main/ipc/project-handlers.ts` — ensure script fields updateable
- `src/renderer/src/components/projects/ProjectSettings.tsx` — **NEW** or updated
- `src/renderer/src/components/projects/ProjectItem.tsx` — add Settings menu option
- `src/renderer/src/stores/useProjectStore.ts` — update action

### Definition of Done
- [ ] Project settings panel/modal accessible from project 3-dot menu
- [ ] Three script textareas rendered with labels and descriptions
- [ ] Textareas use monospace font with appropriate placeholders
- [ ] Save button persists all three scripts to the database
- [ ] Script values loaded from DB when panel opens
- [ ] Empty textarea saves as NULL (not empty string)
- [ ] Project store reflects script field updates
- [ ] Settings panel matches app theme styling

### Testing Criteria
```typescript
// test/phase-5/session-3/project-scripts-ui.test.ts
describe('Session 3: Project Scripts Configuration UI', () => {
  test('Project Settings accessible from 3-dot menu', () => {
    // Open project dropdown menu
    // Verify "Settings" or "Project Settings" option exists
  });

  test('Settings panel shows three script textareas', () => {
    // Open project settings
    // Verify Setup Script, Run Script, Archive Script sections
    // Verify each has a textarea
  });

  test('Script textareas have monospace font', () => {
    // Check textarea className contains font-mono
  });

  test('Scripts load from database', () => {
    // Set project setup_script in DB to "pnpm install"
    // Open settings
    // Verify textarea contains "pnpm install"
  });

  test('Save button persists scripts', () => {
    // Type "pnpm run dev" in Run Script textarea
    // Click Save
    // Reload project from DB
    // Verify run_script is "pnpm run dev"
  });

  test('Empty textarea saves as NULL', () => {
    // Clear Setup Script textarea
    // Save
    // Verify setup_script is NULL in DB (not "")
  });

  test('Labels and descriptions render correctly', () => {
    // Verify Setup Script label and description text
    // Verify Run Script label mentions ⌘R
    // Verify Archive Script label mentions failures won't block
  });

  test('Project store reflects updates', () => {
    // Save scripts
    // Check store.projects for updated project
    // Verify script fields match saved values
  });
});
```

---

## Session 4: Setup Tab

### Objectives
- Replace the Setup tab placeholder in BottomPanel with a real terminal output area
- Wire setup script execution into the worktree creation flow
- Add a "Rerun Setup" button

### Tasks
1. Create `src/renderer/src/stores/useScriptStore.ts`:
   - State per worktree:
     ```typescript
     interface ScriptState {
       setupOutput: string[]     // Array of output lines
       setupRunning: boolean
       setupError: string | null
       runOutput: string[]
       runRunning: boolean
       runPid: number | null
     }
     ```
   - State: `scriptStates: Record<string, ScriptState>` keyed by worktreeId
   - Actions:
     - `appendSetupOutput(worktreeId, line)` — append output line
     - `setSetupRunning(worktreeId, running)`
     - `setSetupError(worktreeId, error)`
     - `clearSetupOutput(worktreeId)` — for Rerun
     - Same for run script state
2. Create `src/renderer/src/components/layout/SetupTab.tsx`:
   - Props: `worktreeId: string`
   - Subscribe to `useScriptStore` for setup output/status
   - On mount: subscribe to IPC events `script:setup:${worktreeId}` via `window.scriptOps.onOutput`
   - On unmount: unsubscribe via `window.scriptOps.offOutput`
   - Render:
     - Scrollable output area (`overflow-auto`, `font-mono text-xs`)
     - Each command start: render as `$ {command}` with bold/dim styling
     - Each output line: render as plain text
     - Error lines: render in red
     - Auto-scroll to bottom on new output
   - "Rerun Setup" button at bottom:
     - Disabled while running
     - On click: clear output, call `window.scriptOps.runSetup(commands, cwd, worktreeId)`
     - Get `commands` from the project's `setup_script` field
   - Show spinner next to "Running..." label when active
   - Show "Setup complete" or "Setup failed" status when done
3. Update `src/renderer/src/components/layout/BottomPanel.tsx`:
   - Replace the Setup tab's `TodoPlaceholder` with `<SetupTab worktreeId={activeWorktreeId} />`
   - Get `activeWorktreeId` from `useWorktreeStore`
4. Wire setup script into worktree creation:
   - In `src/renderer/src/stores/useWorktreeStore.ts` → `createWorktree` action:
     - After successful worktree creation, check if the project has a `setup_script`
     - If yes, call `window.scriptOps.runSetup(project.setup_script.split('\n'), worktree.path, worktree.id)`
     - This is fire-and-forget (don't await — user can watch in Setup tab)
   - Alternatively, wire this in the main process `worktree:create` handler

### Key Files
- `src/renderer/src/stores/useScriptStore.ts` — **NEW**
- `src/renderer/src/components/layout/SetupTab.tsx` — **NEW**
- `src/renderer/src/components/layout/BottomPanel.tsx` — wire SetupTab
- `src/renderer/src/stores/useWorktreeStore.ts` — trigger setup on create

### Definition of Done
- [ ] SetupTab renders terminal-like output area with monospace font
- [ ] Commands displayed as `$ command` with distinct styling
- [ ] stdout/stderr streamed live to the output area
- [ ] Output auto-scrolls to bottom
- [ ] "Rerun Setup" button clears output and re-executes all commands
- [ ] Button disabled while setup is running
- [ ] Running/complete/failed status indicator shown
- [ ] Setup script runs automatically when a new worktree is created
- [ ] Setup tab properly subscribes/unsubscribes to IPC events
- [ ] Error output rendered in red

### Testing Criteria
```typescript
// test/phase-5/session-4/setup-tab.test.ts
describe('Session 4: Setup Tab', () => {
  test('SetupTab renders in BottomPanel', () => {
    // Select a worktree
    // Click Setup tab
    // Verify SetupTab component rendered (not placeholder)
  });

  test('Setup script runs on worktree creation', () => {
    // Create project with setup_script "echo hello"
    // Create worktree
    // Verify setup script execution started
    // Verify "hello" appears in setup output
  });

  test('Commands shown with $ prefix', () => {
    // Run setup with "echo test"
    // Verify "$ echo test" rendered in output
  });

  test('Output streams live', () => {
    // Run setup with long output command
    // Verify output appears incrementally (not all at once)
  });

  test('Auto-scroll to bottom', () => {
    // Run setup with many output lines
    // Verify output area scrolled to bottom
  });

  test('Rerun Setup clears and re-executes', () => {
    // Run setup, wait for completion
    // Click Rerun Setup
    // Verify output cleared
    // Verify commands re-executed
  });

  test('Rerun Setup disabled while running', () => {
    // Start setup
    // Verify Rerun button is disabled
    // Wait for completion
    // Verify Rerun button is enabled
  });

  test('Error output shown in red', () => {
    // Run setup with failing command
    // Verify error text has red styling
  });

  test('Status indicator shows running state', () => {
    // Start setup
    // Verify spinner or "Running..." visible
    // Wait for completion
    // Verify "Setup complete" visible
  });

  test('Failed setup shows failure status', () => {
    // Run setup with command that exits 1
    // Verify "Setup failed" visible
  });
});
```

---

## Session 5: Run Tab & Cmd+R Shortcut

### Objectives
- Build the RunTab component with live terminal output and Stop/Restart buttons
- Register Cmd+R as a global keyboard shortcut
- Implement kill/restart toggle behavior on repeated Cmd+R presses

### Tasks
1. Create `src/renderer/src/components/layout/RunTab.tsx`:
   - Props: `worktreeId: string`
   - Subscribe to `useScriptStore` for run output/status/pid
   - On mount: subscribe to IPC events `script:run:${worktreeId}`
   - Render:
     - Terminal-like output area (same styling as SetupTab — `font-mono text-xs overflow-auto`)
     - Status bar at bottom:
       - When running: green dot + "Running" label + [Stop] [Restart] buttons
       - When stopped: gray dot + "Stopped" label + [Run] button
       - When no run script configured: "No run script configured. Add one in Project Settings."
     - Auto-scroll to bottom on new output
   - Stop button: calls `window.scriptOps.kill(worktreeId)`
   - Restart button: kills then re-runs
   - Run button: starts execution
   - xterm.js integration for ANSI color support (or simple pre-based rendering as fallback)
2. Update `src/renderer/src/components/layout/BottomPanel.tsx`:
   - Replace the Run tab's `TodoPlaceholder` with `<RunTab worktreeId={activeWorktreeId} />`
3. In `src/renderer/src/lib/keyboard-shortcuts.ts`:
   - Add new shortcut definition:
     ```typescript
     {
       id: 'project:run',
       label: 'Run Project',
       defaultBinding: { key: 'r', modifiers: [isMac ? 'meta' : 'ctrl'] },
       category: 'session'
     }
     ```
4. In `src/renderer/src/hooks/useKeyboardShortcuts.ts`:
   - Add handler for `project:run`:
     - Get active worktree and project
     - If no run_script configured, show toast notification ("No run script configured")
     - If run process is currently running (check `useScriptStore`): kill it, then restart
     - If not running: start execution via `window.scriptOps.runProject(commands, cwd, worktreeId)`
     - Switch BottomPanel active tab to "Run" on Cmd+R
   - Set `allowInInput: false` (don't trigger while typing)
5. Wire the script store run state:
   - On `runProject` call: set `runRunning = true`, clear output
   - On IPC event `script:run:${worktreeId}` with `type: 'output'`: append output
   - On process exit (IPC event `type: 'done'` or `type: 'error'`): set `runRunning = false`

### Key Files
- `src/renderer/src/components/layout/RunTab.tsx` — **NEW**
- `src/renderer/src/components/layout/BottomPanel.tsx` — wire RunTab
- `src/renderer/src/lib/keyboard-shortcuts.ts` — add project:run
- `src/renderer/src/hooks/useKeyboardShortcuts.ts` — handle Cmd+R
- `src/renderer/src/stores/useScriptStore.ts` — run state management

### Definition of Done
- [ ] RunTab renders terminal-like output with monospace font
- [ ] Output streams live with auto-scroll
- [ ] Status bar shows running/stopped state with correct indicator
- [ ] Stop button kills the running process
- [ ] Restart button kills and re-runs
- [ ] Cmd+R starts the run script when not running
- [ ] Cmd+R kills and restarts when already running
- [ ] Cmd+R switches BottomPanel to Run tab
- [ ] "No run script configured" message shown when script is empty
- [ ] Cmd+R does not trigger while typing in textarea
- [ ] Output cleared on restart
- [ ] ANSI colors rendered correctly (or stripped gracefully)

### Testing Criteria
```typescript
// test/phase-5/session-5/run-tab-cmd-r.test.ts
describe('Session 5: Run Tab & Cmd+R', () => {
  test('RunTab renders in BottomPanel', () => {
    // Click Run tab
    // Verify RunTab component rendered (not placeholder)
  });

  test('Cmd+R starts run script', () => {
    // Configure run_script "echo running"
    // Press Cmd+R
    // Verify script execution started
    // Verify "running" in output
  });

  test('Cmd+R switches to Run tab', () => {
    // Setup tab active
    // Press Cmd+R
    // Verify Run tab is now active
  });

  test('Cmd+R while running kills and restarts', () => {
    // Start long-running script
    // Press Cmd+R again
    // Verify process killed
    // Verify new process started
    // Verify output cleared
  });

  test('Stop button kills process', () => {
    // Start running script
    // Click Stop
    // Verify process killed
    // Verify status shows "Stopped"
  });

  test('Restart button kills and re-runs', () => {
    // Start running script
    // Click Restart
    // Verify old process killed, new one started
  });

  test('Status shows running indicator', () => {
    // Start script
    // Verify green dot + "Running" label
  });

  test('Status shows stopped indicator', () => {
    // No script running
    // Verify gray dot + "Stopped" label
  });

  test('No run script shows configuration message', () => {
    // Project with no run_script
    // Verify "No run script configured" message
  });

  test('Cmd+R does not trigger in textarea', () => {
    // Focus on chat textarea
    // Press Cmd+R
    // Verify run script does NOT start
  });

  test('Output auto-scrolls', () => {
    // Run script with many lines of output
    // Verify output area scrolled to bottom
  });

  test('project:run shortcut registered', () => {
    // Verify DEFAULT_SHORTCUTS includes project:run with key 'r' and meta modifier
  });
});
```

---

## Session 6: Archive Script & Default Worktree

### Objectives
- Wire archive script execution into the worktree archive flow
- Create a default "(no-worktree)" worktree when a project is added
- Block archive/delete operations on default worktrees
- Ensure default worktree appears first in the list with appropriate UI

### Tasks
1. In `src/main/ipc/worktree-handlers.ts`:
   - In the `worktree:delete` handler (archive flow):
     - Before calling `gitService.archiveWorktree()`, check if the project has an `archive_script`
     - If yes, run `scriptRunner.runAndWait(commands, worktreePath, 30000)`
     - Log the result (success/failure/output)
     - If archive script fails: log warning, proceed with archival anyway
     - After archive script (or if none), proceed with existing archive logic
   - Add a guard: if `worktree.is_default === true`, reject the delete/archive request with an error
2. In `src/main/ipc/project-handlers.ts`:
   - In the project creation handler (after inserting the project):
     - Insert a default worktree: `db.worktree.create({ project_id, name: '(no-worktree)', branch_name: null, path: project.path, status: 'active', is_default: true })`
3. In `src/renderer/src/stores/useWorktreeStore.ts`:
   - In `loadWorktrees`: sort so that `is_default` worktrees come first
   - In `archiveWorktree` / `unbranchWorktree`: check `is_default` — if true, show error toast and return early
   - Add helper: `getDefaultWorktree(projectId): Worktree | undefined`
4. In `src/renderer/src/components/worktrees/WorktreeList.tsx`:
   - Render default worktree first, separated from regular worktrees (optional divider)
   - Default worktree always visible, cannot be hidden or filtered
5. In `src/renderer/src/components/worktrees/WorktreeItem.tsx`:
   - If `worktree.is_default`:
     - Show a folder icon (`Folder` from lucide) instead of `GitBranch` icon
     - Remove "Archive" and "Unbranch" from dropdown menu
     - Remove "Archive" and "Unbranch" from context menu
     - Keep "Open in Terminal", "Open in Editor", "Open in Finder", "Copy Path"
   - Display name as "(no-worktree)" (already stored in DB)

### Key Files
- `src/main/ipc/worktree-handlers.ts` — archive script execution, block default delete
- `src/main/ipc/project-handlers.ts` — create default worktree on project add
- `src/renderer/src/stores/useWorktreeStore.ts` — sorting, archive guard
- `src/renderer/src/components/worktrees/WorktreeList.tsx` — default worktree first
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — different icon/menu for default

### Definition of Done
- [ ] Archive script runs before worktree deletion when configured
- [ ] Archive script failure does not block worktree archival
- [ ] Archive script output logged for debugging
- [ ] Default worktree created automatically when project is added
- [ ] Default worktree has `is_default = true`, `name = '(no-worktree)'`, `path = project.path`
- [ ] Default worktree cannot be archived or deleted (error shown)
- [ ] Default worktree appears first in worktree list
- [ ] Default worktree shows folder icon instead of branch icon
- [ ] Default worktree context menu has no Archive/Unbranch options
- [ ] Existing projects get default worktrees via migration (Session 1)
- [ ] Sessions can be created and run in the default worktree (uses project root path)

### Testing Criteria
```typescript
// test/phase-5/session-6/archive-script-default-worktree.test.ts
describe('Session 6: Archive Script & Default Worktree', () => {
  test('Archive script runs before worktree deletion', () => {
    // Configure archive_script "echo archiving"
    // Archive a worktree
    // Verify "echo archiving" was executed
    // Verify worktree deleted after script
  });

  test('Archive script failure does not block archival', () => {
    // Configure archive_script "exit 1"
    // Archive worktree
    // Verify worktree still archived despite script failure
  });

  test('Default worktree created on project add', () => {
    // Add new project
    // Verify a worktree with is_default=true exists for this project
    // Verify name is '(no-worktree)' and path is project path
  });

  test('Default worktree cannot be archived', () => {
    // Try to archive default worktree
    // Verify error returned/shown
    // Verify worktree still exists
  });

  test('Default worktree cannot be deleted', () => {
    // Try to delete default worktree
    // Verify rejected
  });

  test('Default worktree appears first in list', () => {
    // Load worktrees for project with default + regular
    // Verify default worktree is first
  });

  test('Default worktree shows folder icon', () => {
    // Render WorktreeItem for default worktree
    // Verify Folder icon used (not GitBranch)
  });

  test('Default worktree has no Archive/Unbranch in menu', () => {
    // Open dropdown for default worktree
    // Verify no "Archive" or "Unbranch" options
  });

  test('Default worktree has Open in Terminal/Editor/Finder/Copy Path', () => {
    // Open dropdown for default worktree
    // Verify utility options present
  });

  test('Sessions can run in default worktree', () => {
    // Select default worktree
    // Create session
    // Verify session created with project root as working directory
  });

  test('Archive script timeout respected', () => {
    // Configure archive_script "sleep 60"
    // Archive worktree
    // Verify archival completes within reasonable time (30s timeout)
  });
});
```

---

## Session 7: Worktree Status Badges

### Objectives
- Create a status store tracking working/unread state per session
- Show spinner (working) or dot badge (unread) on worktree items in the sidebar
- Set status to "working" when a message is sent, "unread" when response completes (if not viewing)
- Clear status when the user views the session tab

### Tasks
1. Create `src/renderer/src/stores/useWorktreeStatusStore.ts`:
   - State:
     ```typescript
     // sessionId → { status, timestamp }
     sessionStatuses: Record<string, { status: 'working' | 'unread', timestamp: number } | null>
     ```
   - Actions:
     - `setSessionStatus(sessionId: string, status: 'working' | 'unread' | null)` — sets with current timestamp
     - `clearSessionStatus(sessionId: string)` — sets to null
     - `getWorktreeStatus(worktreeId: string): 'working' | 'unread' | null`
       - Find all sessions for this worktree (need worktreeId → sessionIds mapping)
       - Filter non-null statuses
       - Return the one with the latest timestamp
       - Priority: if any is 'working', return 'working' regardless of timestamp
     - `getSessionsForWorktree(worktreeId: string): string[]` — helper to find sessions
   - The store should integrate with `useSessionStore` to know which sessions belong to which worktree
2. In `src/renderer/src/components/sessions/SessionView.tsx`:
   - In `handleSend` (when user sends a message):
     - Call `useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')`
   - In the streaming event handler, on `session.idle` (response complete):
     - Check if the user is currently viewing this session (compare with active session tab)
     - If viewing: call `clearSessionStatus(sessionId)` (or don't set at all)
     - If NOT viewing: call `setSessionStatus(sessionId, 'unread')`
3. In `src/renderer/src/components/sessions/SessionTabs.tsx`:
   - When a tab is selected (clicked or switched to):
     - Call `clearSessionStatus(sessionId)` for the newly active session
   - Show a small dot indicator on tabs that have 'unread' status (optional, nice-to-have)
4. In `src/renderer/src/components/worktrees/WorktreeItem.tsx`:
   - Import `useWorktreeStatusStore`
   - Call `getWorktreeStatus(worktree.id)` to get the display status
   - Render based on status:
     - `null`: normal icon (GitBranch or Folder for default)
     - `'working'`: replace icon with a spinning `Loader2` from lucide-react (with `animate-spin`)
     - `'unread'`: show a small colored dot badge (e.g., blue/primary circle) next to the worktree name
   - The badge/spinner replaces or overlays the normal icon

### Key Files
- `src/renderer/src/stores/useWorktreeStatusStore.ts` — **NEW**
- `src/renderer/src/components/sessions/SessionView.tsx` — set working/unread
- `src/renderer/src/components/sessions/SessionTabs.tsx` — clear on tab select
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — render badge/spinner

### Definition of Done
- [ ] `useWorktreeStatusStore` tracks session status per session ID
- [ ] `setSessionStatus` stores status with timestamp
- [ ] `getWorktreeStatus` returns 'working' if any session is working, else latest 'unread'
- [ ] Status set to "working" when user sends a message
- [ ] Status set to "unread" when response completes and user is NOT viewing the session
- [ ] Status cleared (null) when response completes and user IS viewing the session
- [ ] Status cleared when user switches to the unread session tab
- [ ] WorktreeItem shows spinning loader when worktree status is "working"
- [ ] WorktreeItem shows dot badge when worktree status is "unread"
- [ ] WorktreeItem shows normal icon when all sessions are null
- [ ] Multiple sessions per worktree handled correctly (latest/highest priority wins)

### Testing Criteria
```typescript
// test/phase-5/session-7/worktree-status-badges.test.ts
describe('Session 7: Worktree Status Badges', () => {
  test('Status set to working on message send', () => {
    // Send message in session
    // Verify sessionStatuses[sessionId] = { status: 'working', ... }
  });

  test('Status set to unread when response completes (not viewing)', () => {
    // Send message, switch to different tab
    // Wait for response complete
    // Verify status is 'unread'
  });

  test('Status cleared when response completes (viewing)', () => {
    // Send message, stay on same tab
    // Wait for response complete
    // Verify status is null
  });

  test('Status cleared when switching to unread tab', () => {
    // Session has 'unread' status
    // Switch to that session tab
    // Verify status becomes null
  });

  test('getWorktreeStatus returns working if any session working', () => {
    // Worktree with session1=null, session2=working
    // Verify getWorktreeStatus returns 'working'
  });

  test('getWorktreeStatus returns unread if no working sessions', () => {
    // Worktree with session1=null, session2=unread
    // Verify getWorktreeStatus returns 'unread'
  });

  test('getWorktreeStatus returns null if all sessions null', () => {
    // Worktree with session1=null, session2=null
    // Verify getWorktreeStatus returns null
  });

  test('WorktreeItem shows spinner when working', () => {
    // Set worktree status to working
    // Verify Loader2 icon with animate-spin class
  });

  test('WorktreeItem shows dot badge when unread', () => {
    // Set worktree status to unread
    // Verify colored dot badge visible
  });

  test('WorktreeItem shows normal icon when null', () => {
    // All sessions null
    // Verify normal GitBranch icon (or Folder for default)
  });

  test('Multiple worktrees show independent statuses', () => {
    // Worktree A: working, Worktree B: unread, Worktree C: null
    // Verify each shows correct indicator
  });
});
```

---

## Session 8: App Icon

### Objectives
- Convert the provided PNG icon to macOS (icns), Windows (ico), and Linux (png) formats
- Place icons in the `resources/` directory
- Verify electron-builder picks up the icons correctly

### Tasks
1. Examine the source icon at `/Users/mor/Desktop/appicon.png`:
   - Verify resolution is sufficient (ideally 1024x1024 or 512x512)
   - Verify it's a valid PNG
2. Convert to macOS `.icns` format:
   - Use `sips` (built into macOS) or `iconutil` to create the iconset:
     ```bash
     mkdir resources/icon.iconset
     sips -z 16 16     appicon.png --out resources/icon.iconset/icon_16x16.png
     sips -z 32 32     appicon.png --out resources/icon.iconset/icon_16x16@2x.png
     sips -z 32 32     appicon.png --out resources/icon.iconset/icon_32x32.png
     sips -z 64 64     appicon.png --out resources/icon.iconset/icon_32x32@2x.png
     sips -z 128 128   appicon.png --out resources/icon.iconset/icon_128x128.png
     sips -z 256 256   appicon.png --out resources/icon.iconset/icon_128x128@2x.png
     sips -z 256 256   appicon.png --out resources/icon.iconset/icon_256x256.png
     sips -z 512 512   appicon.png --out resources/icon.iconset/icon_256x256@2x.png
     sips -z 512 512   appicon.png --out resources/icon.iconset/icon_512x512.png
     sips -z 1024 1024 appicon.png --out resources/icon.iconset/icon_512x512@2x.png
     iconutil -c icns resources/icon.iconset -o resources/icon.icns
     rm -rf resources/icon.iconset
     ```
3. Convert to Windows `.ico` format:
   - Use a tool like `png2ico`, `convert` (ImageMagick), or an npm package
   - Include 16x16, 32x32, 48x48, 64x64, 128x128, 256x256 sizes
4. Copy/resize for Linux `icon.png`:
   - `sips -z 512 512 appicon.png --out resources/icon.png`
5. Verify electron-builder configuration:
   - Check `electron-builder.yml` or `package.json` build config
   - electron-builder auto-detects icons from `resources/` by filename convention (`icon.icns`, `icon.ico`, `icon.png`)
   - If custom config needed, add `icon: "resources/icon"` to the build config
6. Test the icon appears correctly:
   - Run `pnpm build:mac` (or `build:unpack` for faster testing)
   - Verify the app shows the new icon in Dock and Finder

### Key Files
- `resources/icon.icns` — **NEW** macOS icon
- `resources/icon.ico` — **NEW** Windows icon
- `resources/icon.png` — **NEW** Linux icon
- `electron-builder.yml` or `package.json` — verify/update build config

### Definition of Done
- [ ] `resources/icon.icns` exists with all required resolutions (16-1024px)
- [ ] `resources/icon.ico` exists with multiple resolutions
- [ ] `resources/icon.png` exists (512x512)
- [ ] electron-builder configuration references icons (or auto-detects)
- [ ] Built macOS app shows the new icon in Dock
- [ ] Built macOS app shows the new icon in Finder
- [ ] Icon is visually correct (not stretched, not pixelated)

### Testing Criteria
```typescript
// test/phase-5/session-8/app-icon.test.ts
describe('Session 8: App Icon', () => {
  test('icon.icns exists in resources', () => {
    // Verify file exists at resources/icon.icns
  });

  test('icon.ico exists in resources', () => {
    // Verify file exists at resources/icon.ico
  });

  test('icon.png exists in resources', () => {
    // Verify file exists at resources/icon.png
    // Verify dimensions are 512x512
  });

  test('electron-builder config references icons', () => {
    // Read electron-builder.yml or package.json build config
    // Verify icon path configured or resources/ auto-detected
  });

  test('Source icon is valid PNG', () => {
    // Read /Users/mor/Desktop/appicon.png
    // Verify PNG magic bytes
    // Verify resolution >= 512x512
  });
});
```

---

## Session 9: Streaming Bug Fix

### Objectives
- Fix Bug A: user message appearing as an assistant message
- Fix Bug B: final assistant message sometimes duplicated
- Verify no message duplication in any streaming scenario

### Tasks
1. Audit the streaming event handler in `src/renderer/src/components/sessions/SessionView.tsx` (Lines 351-441):
   - **Bug A investigation**: Look at the `message.part.updated` and `message.updated` event handlers
     - Check if events for role: "user" messages are being processed as assistant content
     - The OpenCode SDK may fire `message.updated` for the user's message echo
     - Fix: In the event handler, check the message role:
       ```typescript
       const messageRole = event.data?.message?.role || event.data?.properties?.role
       if (messageRole === 'user') return // Skip user message echoes
       ```
     - Also check `message.part.updated` — if the part belongs to a user message, skip it
   - **Bug B investigation**: Look at the flow when streaming ends
     - `message.part.updated` accumulates text via `appendTextDelta`
     - `message.updated` fires with the complete message → calls `immediateFlush` + `saveAssistantMessage`
     - `session.idle` also fires → calls `immediateFlush` + `saveAssistantMessage`
     - This may cause the message to be saved/rendered twice
     - Fix: Track whether the message has already been finalized:
       ```typescript
       const finalizedMessagesRef = useRef<Set<string>>(new Set())
       // In message.updated handler:
       const messageId = event.data?.message?.id || event.data?.properties?.messageID
       if (finalizedMessagesRef.current.has(messageId)) return
       finalizedMessagesRef.current.add(messageId)
       ```
     - Or: only save the message on `session.idle`, not on `message.updated`
     - Or: use `message.updated` to replace (not append) streaming content
2. Audit `src/main/services/opencode-service.ts` (event handler Lines 427-525):
   - Check if the main process is forwarding duplicate events
   - Verify the sessionMap routing doesn't create duplicate mappings
   - Ensure user message events from OpenCode are not re-sent to the renderer as assistant events
3. Audit `src/main/ipc/opencode-handlers.ts`:
   - Check if the IPC forwarding has any duplication paths
4. Add safeguards:
   - Message ID deduplication: track seen message IDs and skip duplicates
   - Role checking: never process user-role messages in the streaming handler
   - Clear streaming state completely on `session.idle` to prevent stale content from re-appearing
5. Test scenarios:
   - Short message (single text part, no tools)
   - Long message with multiple text parts
   - Message with tool calls interspersed
   - Rapid consecutive messages
   - Slow streaming with long pauses

### Key Files
- `src/renderer/src/components/sessions/SessionView.tsx` — streaming event handler fix
- `src/main/services/opencode-service.ts` — verify event forwarding
- `src/main/ipc/opencode-handlers.ts` — verify IPC forwarding

### Definition of Done
- [ ] User messages do NOT appear as assistant messages
- [ ] Each assistant message appears exactly once in the chat
- [ ] `message.updated` events for role="user" are skipped
- [ ] `message.part.updated` events for role="user" are skipped
- [ ] Final message is not duplicated by `message.updated` + `session.idle` both saving
- [ ] Message ID deduplication prevents duplicate renders
- [ ] Streaming content is replaced (not appended) when `message.updated` arrives
- [ ] No data loss — complete assistant response is still fully rendered
- [ ] No regression in streaming performance (throttle still works)

### Testing Criteria
```typescript
// test/phase-5/session-9/streaming-bug-fix.test.ts
describe('Session 9: Streaming Bug Fix', () => {
  test('User message does not appear as assistant message', () => {
    // Send a message "hello world"
    // Verify only one user message "hello world" in chat
    // Verify no assistant message contains "hello world" as content
  });

  test('User message.updated events are skipped', () => {
    // Simulate message.updated event with role: 'user'
    // Verify handler returns early
    // Verify no assistant content updated
  });

  test('User message.part.updated events are skipped', () => {
    // Simulate message.part.updated event for a user message
    // Verify handler returns early
  });

  test('Final assistant message appears exactly once', () => {
    // Stream a complete response
    // Wait for session.idle
    // Count assistant messages in chat
    // Verify exactly one
  });

  test('message.updated does not duplicate streamed content', () => {
    // Stream text via message.part.updated events
    // Fire message.updated with complete text
    // Verify text is not doubled
  });

  test('Rapid message.updated + session.idle does not duplicate', () => {
    // Fire message.updated immediately followed by session.idle
    // Verify message saved only once
  });

  test('Message ID deduplication works', () => {
    // Send same message.updated event twice (same messageId)
    // Verify only processed once
  });

  test('Short response renders correctly', () => {
    // Stream a 1-line response
    // Verify rendered correctly, no duplication
  });

  test('Long response with tools renders correctly', () => {
    // Stream text, tool call, more text
    // Verify all parts present once
  });

  test('Streaming throttle still works after fix', () => {
    // Stream 50 rapid text deltas
    // Verify throttled rendering (not 50 renders)
  });

  test('No data loss in streamed content', () => {
    // Stream known content in 10 chunks
    // Verify final rendered text matches all chunks concatenated
  });
});
```

---

## Session 10: Integration Polish & Verification

### Objectives
- End-to-end verification of all Phase 5 features working together
- Fix any visual inconsistencies or edge cases
- Ensure performance targets are met
- Run lint and typecheck

### Tasks
1. Verify setup script flow end-to-end:
   - Create a project with `setup_script = "echo 'setup done'"`
   - Create a new worktree
   - Verify Setup tab shows `$ echo 'setup done'` and `setup done`
   - Click Rerun Setup → verify output clears and re-runs
2. Verify run script flow end-to-end:
   - Set project `run_script = "echo 'running' && sleep 5"`
   - Press Cmd+R → verify Run tab shows output and "Running" status
   - Press Cmd+R again → verify kill and restart
   - Click Stop → verify process killed
3. Verify archive script flow:
   - Set project `archive_script = "echo 'cleanup'"`
   - Archive a worktree → verify script runs before deletion
   - Set `archive_script = "exit 1"` → archive another → verify archival proceeds despite failure
4. Verify default worktree:
   - Add a new project → verify (no-worktree) appears first
   - Try to archive it → verify blocked
   - Select it → create a session → verify session connects using project root path
   - Verify folder icon shown (not branch icon)
5. Verify worktree status badges:
   - Send a message in a worktree session → verify spinner on worktree item
   - Switch to a different worktree while response streams → verify original shows "unread" dot when done
   - Switch back → verify badge clears
   - Multiple sessions in one worktree → verify correct badge (working > unread)
6. Verify app icon:
   - Build the app with `pnpm build:unpack`
   - Verify icon in output matches the designed icon
7. Verify streaming fix:
   - Send a message → verify no duplicate user message as assistant
   - Wait for response → verify no duplicate final message
   - Send rapid consecutive messages → verify clean rendering
8. Cross-feature interactions:
   - Setup script on default worktree → verify runs in project root
   - Cmd+R on default worktree → verify runs in project root
   - Status badges during setup script → verify no conflict
9. Run `pnpm lint` — fix any errors
10. Run `pnpm typecheck` — fix any type errors
11. Profile key operations against performance targets

### Key Files
- All files modified in sessions 1-9
- Focus on cross-cutting concerns and integration points

### Definition of Done
- [ ] Setup script runs on worktree creation with live output in Setup tab
- [ ] Rerun Setup works correctly
- [ ] Cmd+R starts/kills/restarts run script with correct UI
- [ ] Archive script runs before deletion, failures don't block
- [ ] Default worktree exists for every project, cannot be archived
- [ ] Default worktree uses project root path for sessions
- [ ] Worktree badges show working (spinner) and unread (dot) correctly
- [ ] Badges clear when viewing the session
- [ ] App icon is the professional design on macOS
- [ ] No duplicate messages in streaming (user or assistant)
- [ ] Setup/run scripts work on default worktree
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] No console errors during normal operation
- [ ] Setup script start < 500ms after worktree creation
- [ ] Cmd+R response < 200ms
- [ ] Kill process < 1s
- [ ] Status badge update < 100ms

### Testing Criteria
```typescript
// test/phase-5/session-10/integration-polish.test.ts
describe('Session 10: Integration Polish', () => {
  test('Setup script end-to-end', () => {
    // Create project with setup_script, create worktree
    // Verify output in Setup tab
  });

  test('Rerun Setup end-to-end', () => {
    // Click Rerun Setup
    // Verify output cleared and re-executed
  });

  test('Cmd+R end-to-end (start/kill/restart)', () => {
    // Configure run script, press Cmd+R
    // Verify running, press Cmd+R again
    // Verify killed and restarted
  });

  test('Archive script end-to-end', () => {
    // Configure archive script, archive worktree
    // Verify script ran, worktree archived
  });

  test('Default worktree end-to-end', () => {
    // Add project, verify default worktree
    // Select it, create session, verify working directory
  });

  test('Worktree status badges end-to-end', () => {
    // Send message, verify spinner
    // Switch away, wait for response, verify unread dot
    // Switch back, verify cleared
  });

  test('Streaming no duplication end-to-end', () => {
    // Send message, wait for response
    // Count user messages and assistant messages
    // Verify exactly 1 of each
  });

  test('Setup script on default worktree', () => {
    // Configure setup script, select default worktree
    // Click Rerun Setup
    // Verify runs in project root directory
  });

  test('Run script on default worktree', () => {
    // Configure run script, select default worktree
    // Press Cmd+R
    // Verify runs in project root directory
  });

  test('Lint passes', () => {
    // Run pnpm lint
    // Verify exit code 0
  });

  test('Typecheck passes', () => {
    // Run pnpm typecheck
    // Verify exit code 0
  });

  test('No console errors during normal operation', () => {
    // Capture console.error
    // Navigate through all Phase 5 features
    // Verify zero errors
  });

  test('Performance: setup start < 500ms', () => {
    // Measure time from worktree creation to first setup output event
    // Verify < 500ms
  });

  test('Performance: Cmd+R response < 200ms', () => {
    // Measure time from keypress to first output event
    // Verify < 200ms
  });

  test('Performance: kill < 1s', () => {
    // Start process, measure time to kill
    // Verify < 1s
  });

  test('Performance: badge update < 100ms', () => {
    // Measure time from session state change to UI update
    // Verify < 100ms
  });
});
```

---

## Dependencies & Order

```
Session 1 (DB Migration & Types)
    |
    v
Session 2 (Script Runner Service)
    |
    +──────────────────────────────────+
    |               |                  |
    v               v                  v
Session 3       Session 6          Session 8
(Scripts UI)    (Archive Script    (App Icon)
    |            + Default Worktree)   |
    +───────+       |                  |
    |       |       |                  |
    v       v       v                  |
Session 4  Session 5  Session 7       |
(Setup Tab)(Run Tab   (Worktree       |
    |       + Cmd+R)   Status Badges) |
    |       |       |                  |
    +───────+───────+──────────────────+
    |
    v
Session 9 (Streaming Bug Fix)
    |
    v
Session 10 (Integration Polish)
```

### Parallel Tracks
- **Track A** (Foundation): Sessions 1 → 2 (must complete first — DB and service layer)
- **Track B** (Scripts UI + Setup): Sessions 3 → 4 (UI for configuring + Setup tab)
- **Track C** (Run + Cmd+R): Session 5 (independent after Track A)
- **Track D** (Archive + Default Worktree): Session 6 (independent after Track A)
- **Track E** (Status Badges): Session 7 (independent after Track A, but benefits from sessions 4-5 existing)
- **Track F** (App Icon): Session 8 (fully independent, can run anytime)
- **Track G** (Streaming Fix): Session 9 (independent, can run anytime but best before polish)

Sessions 1-2 must complete first (foundation — schema + service).
Sessions 3, 5, 6, 7, 8 can run in parallel after Session 2.
Session 4 depends on Session 3 (needs script config UI for the Rerun button to load scripts).
Session 9 can run anytime (independent bug fix).
Session 10 requires all other sessions to be complete.

---

## Notes

### Assumed Phase 4 Infrastructure
- Theme system with 10 presets and CSS custom properties
- BottomPanel with Setup/Run/Terminal tabs (placeholder content — we replace Setup and Run)
- Model selection pill in input area
- Streaming markdown throttle at ~100ms intervals
- Tab key for mode toggle (global, capture phase)
- Language detection and icons on project items
- Session auto-naming via Claude Haiku
- File viewer with Cmd+F search
- Header quick actions (Cursor, Ghostty, Copy Path)
- Settings modal with Appearance section
- Right sidebar split (file tree top, tab panel bottom)

### Out of Scope (Phase 5)
Per PRD Phase 5, these are NOT included:
- Terminal tab content in BottomPanel (placeholder remains)
- Script editing with syntax highlighting or autocomplete
- Script environment variable management UI
- Per-worktree script overrides (scripts are per-project only)
- Custom badge colors or animations
- Multiple run script profiles (only one run script per project)
- App icon auto-update or dynamic tray icon
- Comprehensive streaming architecture rewrite (targeted fix only)

### Performance Targets
| Operation | Target |
|-----------|--------|
| Setup script execution start | < 500ms after worktree creation |
| Run script start (Cmd+R) | < 200ms response |
| Run script kill (Cmd+R while running) | < 1s graceful shutdown |
| Archive script timeout | 30s max per command |
| Worktree status badge update | < 100ms after session state change |
| Default worktree session launch | Same latency as regular worktrees |
| App icon display | Correct on macOS, Windows, Linux |
| Streaming bug fix | No duplicate messages in any scenario |

### Key Architecture Decisions
1. **Script execution uses `child_process.spawn` (not node-pty)** for setup/archive scripts — simpler, sufficient for sequential command output. node-pty/xterm.js reserved for Run tab where ANSI colors and interactive output matter.
2. **Default worktree is a real DB record** (not a virtual/computed entry) — simplifies queries, session creation, and store management. Identified by `is_default` column.
3. **Status badges use a separate store** (not merged into worktree/session stores) — keeps ephemeral UI state decoupled from persisted data. Status is in-memory only, not saved to DB.
4. **Streaming fix uses role checking + message ID deduplication** — defensive approach that handles both known bugs and any future edge cases. No streaming architecture rewrite needed.
