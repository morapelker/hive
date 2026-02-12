# Plan: Custom Application Menu for Hive

## Goal

Replace the minimal inline Electron menu (in `src/main/index.ts:312-350`) with a full-featured application menu that reflects Hive's actual feature surface: projects, worktrees, AI sessions, git operations, and navigation.

## Menu Structure

```
Hive (appMenu) | File | Edit | Session | Git | View | Window | Help
```

---

## Task 1: Create `src/main/menu.ts`

New file. The entire menu definition and state management lives here.

**Exports:**

- `buildMenu(mainWindow: BrowserWindow, isDev: boolean): Menu` -- builds and sets the application menu, stores the mainWindow reference for IPC
- `updateMenuState(state: MenuState): void` -- enables/disables conditional menu items
- `setAppVersion(version: string): void` -- updates Help > Version label
- `interface MenuState { hasActiveSession: boolean; hasActiveWorktree: boolean }`

**Implementation details:**

- Module-level `let _mainWindow: BrowserWindow | null = null` and a `send(channel)` helper that calls `_mainWindow?.webContents.send(channel)`
- Import `shell` from electron for `shell.openPath(getLogDir())` in Help > Open Log Directory
- Import `app` from electron for `app.getVersion()` in Help > Version
- Import `getLogDir` from `./services/logger`
- Use `process.platform === 'darwin'` for Mac-specific items (appMenu role on Mac only, Quit in File on non-Mac only)
- All conditional items must have an `id` string and start with `enabled: false`
- `updateMenuState` uses `Menu.getApplicationMenu()?.getMenuItemById(id)` to set `enabled`
- Two arrays define which items map to which state flag:
  - `sessionItemIds` (require `hasActiveSession`): `session-toggle-mode`, `session-cycle-model`, `session-undo-turn`, `session-redo-turn`
  - `worktreeItemIds` (require `hasActiveWorktree`): `session-run-project`, `git-commit`, `git-push`, `git-pull`, `git-stage-all`, `git-unstage-all`, `git-open-in-editor`, `git-open-in-terminal`

**Full menu template:**

```
Hive (appMenu)
  { role: 'appMenu' }  -- only on macOS

File
  New Session          CmdOrCtrl+T       -> send('shortcut:new-session')
  Close Session        CmdOrCtrl+W       -> send('shortcut:close-session')
  ---separator---
  New Worktree...      CmdOrCtrl+Shift+N -> send('menu:new-worktree')
  ---separator---
  Add Project...                         -> send('menu:add-project')
  ---separator---
  Quit                 { role: 'quit' }  -- only on non-macOS

Edit
  { role: 'editMenu' }

Session
  Toggle Build / Plan Mode               -> send('menu:toggle-mode')         id: session-toggle-mode, enabled: false
  Cycle Model Variant  Alt+T             -> send('menu:cycle-model')         id: session-cycle-model, enabled: false
  ---separator---
  Run Project          CmdOrCtrl+R       -> send('menu:run-project')         id: session-run-project, enabled: false
  ---separator---
  Undo Turn                              -> send('menu:undo-turn')           id: session-undo-turn, enabled: false
  Redo Turn                              -> send('menu:redo-turn')           id: session-redo-turn, enabled: false

Git
  Commit...            CmdOrCtrl+Shift+C -> send('menu:commit')             id: git-commit, enabled: false
  Push                 CmdOrCtrl+Shift+P -> send('menu:push')               id: git-push, enabled: false
  Pull                 CmdOrCtrl+Shift+L -> send('menu:pull')               id: git-pull, enabled: false
  ---separator---
  Stage All                              -> send('menu:stage-all')           id: git-stage-all, enabled: false
  Unstage All                            -> send('menu:unstage-all')         id: git-unstage-all, enabled: false
  ---separator---
  Open in Editor                         -> send('menu:open-in-editor')      id: git-open-in-editor, enabled: false
  Open in Terminal                       -> send('menu:open-in-terminal')    id: git-open-in-terminal, enabled: false

View
  Command Palette      CmdOrCtrl+P       -> send('menu:command-palette')
  Search Files         CmdOrCtrl+D       -> send('shortcut:file-search')
  Session History      CmdOrCtrl+K       -> send('menu:session-history')
  ---separator---
  Toggle Left Sidebar  CmdOrCtrl+B       -> send('menu:toggle-left-sidebar')
  Toggle Right Sidebar CmdOrCtrl+Shift+B -> send('menu:toggle-right-sidebar')
  ---separator---
  Focus Left Sidebar   CmdOrCtrl+1       -> send('menu:focus-left-sidebar')
  Focus Main Pane      CmdOrCtrl+2       -> send('menu:focus-main-pane')
  ---separator---
  Zoom In              { role: 'zoomIn' }
  Zoom Out             { role: 'zoomOut' }
  Reset Zoom           { role: 'resetZoom' }
  ---separator---
  Toggle Full Screen   { role: 'togglefullscreen' }
  Toggle Dev Tools     { role: 'toggleDevTools' }  -- only when isDev

Window
  { role: 'windowMenu' }

Help
  Open Log Directory                     -> shell.openPath(getLogDir())
  ---separator---
  Version X.Y.Z                          id: help-app-version, enabled: false (display only)
```

---

## Task 2: Update `src/main/index.ts`

1. **Remove `Menu` from electron import** -- no longer needed directly
2. **Add imports**: `import { buildMenu, updateMenuState } from './menu'` and `import type { MenuState } from './menu'`
3. **Delete the entire inline menu block** (the `menuTemplate` variable, the comment above it, and the `Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))` call)
4. **Inside the `if (mainWindow)` block** (after `createWindow()`), add before the OpenCode handler registrations:

```ts
// Build the full application menu (File, Edit, Session, Git, View, Window, Help)
log.info('Building application menu')
buildMenu(mainWindow, is.dev)

// Register menu state update handler (renderer tells main which items to enable/disable)
ipcMain.handle('menu:updateState', (_event, state: MenuState) => {
  updateMenuState(state)
})
```

---

## Task 3: Update `src/preload/index.ts`

Add two new methods to the `systemOps` object (after `onWindowFocused`):

```ts
// Update menu item enabled/disabled state (renderer -> main)
updateMenuState: (state: {
  hasActiveSession: boolean
  hasActiveWorktree: boolean
}): Promise<void> => ipcRenderer.invoke('menu:updateState', state),

// Subscribe to menu action events from the application menu (main -> renderer)
onMenuAction: (channel: string, callback: () => void): (() => void) => {
  const handler = (): void => {
    callback()
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}
```

---

## Task 4: Update `src/preload/index.d.ts`

Add to the `systemOps` interface (after `onWindowFocused`):

```ts
updateMenuState: (state: {
  hasActiveSession: boolean
  hasActiveWorktree: boolean
}) => Promise<void>
onMenuAction: (channel: string, callback: () => void) => () => void
```

---

## Task 5: Update `src/renderer/src/hooks/useKeyboardShortcuts.ts`

Three changes:

### 5a. Extract `handleRunProject()` as a standalone function

Move the run-project logic out of the `getShortcutHandlers` inline handler into a top-level function called `handleRunProject()`. The `project:run` shortcut handler becomes `handler: handleRunProject`. This avoids duplicating the logic for the menu action.

The function: reads `selectedWorktreeId` from `useWorktreeStore`, finds the project's `run_script`, parses commands, toggles start/stop via `useScriptStore` and `window.scriptOps`. Copy the exact existing logic from the `project:run` handler, just hoist it into a standalone function.

### 5b. Add `useMenuActionListeners()` hook

New function called from inside `useKeyboardShortcuts()` (after the existing `shortcut:close-session` listener). Single `useEffect` with `[]` deps. Guards on `window.systemOps?.onMenuAction`. Registers listeners for all `menu:*` channels, collects cleanup functions in an array, returns combined cleanup.

Channel-to-action mapping:

| Channel                     | Action                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `menu:new-worktree`         | Get `selectedProjectId` from `useProjectStore`, call `useWorktreeStore.getState().setCreatingForProject(selectedProjectId)`. Toast if no project selected. |
| `menu:add-project`          | `window.dispatchEvent(new CustomEvent('hive:add-project'))`                                                                                                |
| `menu:toggle-mode`          | Get `activeSessionId` from `useSessionStore`, call `toggleSessionMode(activeSessionId)`                                                                    |
| `menu:cycle-model`          | `window.dispatchEvent(new CustomEvent('hive:cycle-variant'))`                                                                                              |
| `menu:run-project`          | Call `handleRunProject()`                                                                                                                                  |
| `menu:undo-turn`            | `window.dispatchEvent(new CustomEvent('hive:undo-turn'))`                                                                                                  |
| `menu:redo-turn`            | `window.dispatchEvent(new CustomEvent('hive:redo-turn'))`                                                                                                  |
| `menu:commit`               | Dispatch `hive:focus-commit` custom event + ensure right sidebar is open via `useLayoutStore`                                                              |
| `menu:push`                 | Get worktree path via `getActiveWorktreePath()`, call `useGitStore.getState().push(path)`, toast result                                                    |
| `menu:pull`                 | Get worktree path, call `useGitStore.getState().pull(path)`, toast result                                                                                  |
| `menu:stage-all`            | Get worktree path, call `useGitStore.getState().stageAll(path)`. **Note: `stageAll` returns `Promise<boolean>`, not a result object.**                     |
| `menu:unstage-all`          | Same pattern as stage-all, returns `Promise<boolean>`                                                                                                      |
| `menu:open-in-editor`       | Get worktree path, call `window.worktreeOps.openInEditor(path)`                                                                                            |
| `menu:open-in-terminal`     | Get worktree path, call `window.worktreeOps.openInTerminal(path)`                                                                                          |
| `menu:command-palette`      | `useCommandPaletteStore.getState().toggle()`                                                                                                               |
| `menu:session-history`      | `useSessionHistoryStore.getState().togglePanel()`                                                                                                          |
| `menu:toggle-left-sidebar`  | `useLayoutStore.getState().toggleLeftSidebar()`                                                                                                            |
| `menu:toggle-right-sidebar` | `useLayoutStore.getState().toggleRightSidebar()`                                                                                                           |
| `menu:focus-left-sidebar`   | Query `[data-testid="left-sidebar"]`, focus first focusable child                                                                                          |
| `menu:focus-main-pane`      | Query `[data-testid="main-pane"]`, focus first focusable child                                                                                             |
| `menu:open-log-dir`         | `window.systemOps.getLogDir().then(dir => window.projectOps.openPath(dir))`                                                                                |

### 5c. Add `useMenuStateUpdater()` hook

New function called from inside `useKeyboardShortcuts()` (after `useMenuActionListeners()`). Reactively subscribes to `activeSessionId` from `useSessionStore` and `selectedWorktreeId` from `useWorktreeStore` using Zustand selectors. On change, calls:

```ts
window.systemOps.updateMenuState({
  hasActiveSession: !!activeSessionId,
  hasActiveWorktree: !!selectedWorktreeId
})
```

Dependencies: `[activeSessionId, selectedWorktreeId]`

---

## Task 6: Update `src/renderer/src/components/projects/AddProjectButton.tsx`

Add `useEffect` to the import from `react`.

Add a `useEffect` that listens for the `hive:add-project` custom event and calls the existing `handleAddProject` function:

```ts
useEffect(() => {
  const handler = (): void => {
    handleAddProject()
  }
  window.addEventListener('hive:add-project', handler)
  return () => window.removeEventListener('hive:add-project', handler)
}, [handleAddProject])
```

Place this after the `handleAddProject` callback definition, before `handleInitRepository`.

---

## Task 7: Update `src/renderer/src/components/sessions/SessionView.tsx`

Add a `useEffect` that listens for `hive:undo-turn` and `hive:redo-turn` custom events. Place it after the existing Tab key handler effect and before the `visibleMessages` useMemo.

Each handler:

1. Checks `useSessionStore.getState().activeSessionId === sessionId` (only handle if this is the active session view)
2. Guards on `worktreePath && opencodeSessionId`
3. Calls `window.opencodeOps.undo(worktreePath, opencodeSessionId)` or `.redo()`
4. Updates revert state:
   - For undo: `setRevertMessageID`, `revertDiffRef.current`, restore prompt via `stripPlanModePrefix(result.restoredPrompt)` into `setInputValue` and `inputValueRef.current`
   - For redo: `setRevertMessageID`, clear revertDiff/input if `revertMessageID === null`
5. Calls `await refreshMessagesFromOpenCode()`
6. Catch block: `toast.error('Undo failed')` or `toast.error('Redo failed')`

Dependencies: `[sessionId, worktreePath, opencodeSessionId, refreshMessagesFromOpenCode]`

All referenced variables (`setRevertMessageID`, `revertDiffRef`, `setInputValue`, `inputValueRef`, `stripPlanModePrefix`, `refreshMessagesFromOpenCode`, `toast`) are already available in the component scope.

---

## Verification

After all tasks:

1. `pnpm build` must pass (exit 0, all 3 bundles: main, preload, renderer)
2. `pnpm lint` must have 0 errors (warnings are acceptable)
3. `pnpm test` -- no new failures introduced

---

## Key Gotchas

- `useWorktreeStore` method is `setCreatingForProject`, NOT `setCreatingForProjectId`
- `useGitStore.stageAll()` and `unstageAll()` return `Promise<boolean>`, NOT `{ success, error }` objects
- The `is` import from `@electron-toolkit/utils` is still needed in `index.ts` for `is.dev` (used in HMR URL loading at line ~179), so do NOT remove it
- `MenuState` should be imported with `import type` to avoid the unused-import lint warning
- The `menu:updateState` handler uses `ipcMain.handle` (not `.on`) since the renderer calls it via `ipcRenderer.invoke`
- Code style: no semicolons, single quotes, no trailing commas, 2-space indent, 100 char width
- Use `CmdOrCtrl` prefix (not `Cmd` or `Ctrl`) for cross-platform accelerators in Electron menu
