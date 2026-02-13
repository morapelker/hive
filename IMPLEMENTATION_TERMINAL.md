# Terminal Integration: Implementation Plan

## Architecture Decision

After extensive research into Ghostty's codebase and Electron's architecture, here is the integration strategy.

### Why Not Direct Ghostty Embedding (Yet)

Ghostty's `libghostty` requires a native `NSView*` for its Metal renderer — it physically attaches an `IOSurfaceLayer` to the view and renders via Metal GPU pipelines. Embedding this in Electron requires a native Node addon that creates an NSView overlay on the BrowserWindow, positioned to align with a transparent "hole" in the HTML. This approach:

- Is macOS-only (no Windows/Linux)
- Creates z-ordering conflicts with HTML overlays (dropdowns, modals, command palette)
- Has fragile coupling to Chromium's internal view hierarchy
- Makes keyboard/IME routing extremely complex
- Requires building libghostty from Zig source (272MB static library)

**This is the right long-term path** for a premium macOS terminal experience, but it's a multi-month effort with significant risk.

### The Plan: node-pty + xterm.js (V1), Then Ghostty Native (V2)

**V1 (Sessions 1-6):** Build a fully functional terminal using `node-pty` + `xterm.js`. This is the same architecture VS Code uses for its integrated terminal. It supports all TUI apps (vim, tmux, htop, lazygit), mouse events, truecolor, ligatures (with canvas renderer), and resizing. This gives us a working terminal in ~1 week.

**V2 (Sessions 7-9):** Layer in Ghostty as an optional native backend on macOS. The V1 abstraction boundary makes this a backend swap, not a rewrite.

### Ghostty Config Reuse (Both V1 and V2)

Regardless of backend, we parse Ghostty's config file (`~/.config/ghostty/config` or `~/Library/Application Support/com.mitchellh.ghostty/config`) to extract user preferences: font family, font size, colors, cursor style, shell, keybindings. This means users get their familiar terminal look without configuring anything.

---

## Session 1: PTY Service in Main Process

**Goal:** Create a PTY management service in the main process that can spawn shells, relay I/O, and handle resize.

### Changes

**New dependency:**

- `node-pty` — native PTY for Node.js (add to `dependencies` and `pnpm.onlyBuiltDependencies`)

**New file: `src/main/services/pty-service.ts`**

PTY lifecycle manager. One PTY per worktree terminal.

```
class PtyService {
  private ptys: Map<string, { pty: IPty, cwd: string }>

  create(id: string, opts: { cwd: string, shell?: string, env?: Record<string,string> }): void
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  destroy(id: string): void
  destroyAll(): void

  // Events emitted to subscribers
  onData(id: string, callback: (data: string) => void): void
  onExit(id: string, callback: (code: number, signal: number) => void): void
}
```

Key behaviors:

- Detects user's shell from `$SHELL` or falls back to `/bin/zsh`
- Sets `TERM=xterm-256color`, `COLORTERM=truecolor`
- Inherits user's `$PATH` (uses `fix-path` like the rest of the app)
- Initial size: 80x24 (updated on first resize from renderer)
- Handles graceful shutdown: SIGHUP on destroy

**New file: `src/main/ipc/terminal-handlers.ts`**

IPC handlers bridging renderer ↔ PTY:

```
terminal:create   (worktreeId, cwd) → { success, cols, rows }
terminal:write    (worktreeId, data) → void
terminal:resize   (worktreeId, cols, rows) → void
terminal:destroy  (worktreeId) → void

// Push events (main → renderer):
terminal:data:{worktreeId}   (data: string)
terminal:exit:{worktreeId}   (code: number)
```

Register in `src/main/index.ts` alongside other handlers.

### Test

```bash
# In a test file or REPL:
# 1. Create a PTY
# 2. Write "echo hello\n"
# 3. Verify "hello" appears in onData
# 4. Resize to 120x40, verify no crash
# 5. Destroy, verify exit event fires
```

Write a vitest test: `test/terminal/pty-service.test.ts`

---

## Session 2: Preload Bridge + Terminal Store

**Goal:** Expose terminal IPC to the renderer and create the Zustand store for terminal state.

### Changes

**Update: `src/preload/index.ts`**

Add `terminalOps` namespace:

```ts
const terminalOps = {
  create: (worktreeId: string, cwd: string) =>
    ipcRenderer.invoke('terminal:create', worktreeId, cwd),
  write: (worktreeId: string, data: string) =>
    ipcRenderer.invoke('terminal:write', worktreeId, data),
  resize: (worktreeId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', worktreeId, cols, rows),
  destroy: (worktreeId: string) => ipcRenderer.invoke('terminal:destroy', worktreeId),
  onData: (worktreeId: string, callback: (data: string) => void) => {
    const channel = `terminal:data:${worktreeId}`
    const handler = (_event: IpcRendererEvent, data: string) => callback(data)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  onExit: (worktreeId: string, callback: (code: number) => void) => {
    const channel = `terminal:exit:${worktreeId}`
    const handler = (_event: IpcRendererEvent, code: number) => callback(code)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('terminalOps', terminalOps)
```

**Update: `src/preload/index.d.ts`**

Add type declarations for `window.terminalOps`.

**New file: `src/renderer/src/stores/useTerminalStore.ts`**

```ts
interface TerminalState {
  // Per-worktree terminal state
  terminals: Map<
    string,
    {
      status: 'creating' | 'running' | 'exited'
      exitCode?: number
    }
  >

  // Actions
  createTerminal: (worktreeId: string, cwd: string) => Promise<void>
  destroyTerminal: (worktreeId: string) => void
}
```

Export from `src/renderer/src/stores/index.ts`.

### Test

Write `test/terminal/terminal-store.test.ts` — mock `window.terminalOps`, verify store state transitions.

---

## Session 3: xterm.js Integration — Basic Rendering

**Goal:** Render a working terminal in the Terminal tab using xterm.js.

### Changes

**New dependencies:**

- `@xterm/xterm` — terminal emulator UI
- `@xterm/addon-fit` — auto-resize to container
- `@xterm/addon-web-links` — clickable URLs
- `@xterm/addon-webgl` — GPU-accelerated rendering

**New file: `src/renderer/src/components/terminal/TerminalView.tsx`**

The core terminal component:

```tsx
interface TerminalViewProps {
  worktreeId: string
  cwd: string
}
```

Responsibilities:

- Creates an xterm.js `Terminal` instance on mount
- Attaches `FitAddon`, `WebLinksAddon`, `WebglAddon` (with canvas fallback)
- Calls `window.terminalOps.create()` to spawn the PTY
- Wires `terminal.onData` → `window.terminalOps.write()` (user input → PTY)
- Wires `window.terminalOps.onData()` → `terminal.write()` (PTY output → display)
- Wires `window.terminalOps.onExit()` → show exit status
- Uses `ResizeObserver` + `FitAddon.fit()` → `window.terminalOps.resize()`
- Cleans up on unmount: destroy PTY, dispose terminal

**Update: `src/renderer/src/components/layout/BottomPanel.tsx`**

Replace the "TODO: Terminal" placeholder:

```tsx
{
  activeTab === 'terminal' && selectedWorktreeId && worktreePath && (
    <TerminalView worktreeId={selectedWorktreeId} cwd={worktreePath} />
  )
}
```

Need to get `worktreePath` from the worktree store (the worktree's `path` field).

**New file: `src/renderer/src/styles/xterm.css`**

Import xterm.js CSS. Customize to match the app's theme variables.

### Test

Manual verification:

1. Select a worktree → click Terminal tab
2. Shell prompt appears
3. Type `ls` → see output
4. Type `vim` → TUI renders correctly
5. Resize the panel → terminal reflows
6. Switch worktrees → different terminal per worktree

---

## Session 4: Ghostty Config Parsing

**Goal:** Parse Ghostty's config file to apply user's terminal preferences (font, colors, shell).

### Changes

**New file: `src/main/services/ghostty-config.ts`**

Config parser for Ghostty's key-value format:

```ts
interface GhosttyConfig {
  fontFamily?: string
  fontSize?: number
  background?: string
  foreground?: string
  cursorStyle?: 'block' | 'bar' | 'underline'
  cursorColor?: string
  shell?: string
  // ANSI color palette (0-15)
  palette?: Record<number, string>
  // Selection colors
  selectionBackground?: string
  selectionForeground?: string
}

function parseGhosttyConfig(): GhosttyConfig
```

Config file search order (matching Ghostty's own resolution):

1. `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty`
2. `~/Library/Application Support/com.mitchellh.ghostty/config`
3. `$XDG_CONFIG_HOME/ghostty/config.ghostty`
4. `$XDG_CONFIG_HOME/ghostty/config`
5. `~/.config/ghostty/config`

Handles:

- `#` comments
- `key = value` parsing
- `config-file` includes (recursive, with cycle detection)
- `palette = N=RRGGBB` syntax for ANSI colors
- Unknown keys silently ignored

**New IPC channel: `terminal:getConfig`**

Returns the parsed config to the renderer for applying to xterm.js.

**Update: `src/renderer/src/components/terminal/TerminalView.tsx`**

On mount, fetch ghostty config and apply to xterm.js:

```ts
const config = await window.terminalOps.getConfig()
const terminal = new Terminal({
  fontFamily: config.fontFamily || 'JetBrains Mono, monospace',
  fontSize: config.fontSize || 14,
  theme: {
    background: config.background || '#1e1e2e',
    foreground: config.foreground || '#cdd6f4',
    cursor: config.cursorColor
    // ... map palette to ansi0-ansi15
  },
  cursorStyle: config.cursorStyle || 'block'
})
```

Also pass `config.shell` to PTY creation so it uses the user's preferred shell.

### Test

Write `test/terminal/ghostty-config.test.ts`:

- Parse a sample config string with all supported keys
- Handle missing file gracefully (returns defaults)
- Handle `config-file` includes
- Handle malformed lines (skip gracefully)

---

## Session 5: Terminal Lifecycle & Multi-Terminal

**Goal:** Robust terminal lifecycle — persist across tab switches, one terminal per worktree, reconnect on visibility.

### Changes

**Update: `src/renderer/src/components/terminal/TerminalView.tsx`**

Current problem: if the user switches from Terminal to Setup tab and back, the terminal would unmount and remount, losing state.

Solution: **Keep the terminal DOM element alive but hidden.** Use CSS `display: none` / `visibility: hidden` instead of conditional rendering. The xterm.js instance and PTY stay alive.

Refactor BottomPanel to always render TerminalView but toggle visibility:

```tsx
<div className={activeTab === 'terminal' ? 'flex-1 min-h-0' : 'hidden'}>
  {selectedWorktreeId && worktreePath && (
    <TerminalView worktreeId={selectedWorktreeId} cwd={worktreePath} />
  )}
</div>
```

Call `fitAddon.fit()` when switching back to the terminal tab (the container size may have changed).

**Update: `src/renderer/src/components/terminal/TerminalView.tsx`**

Add terminal focus management:

- When terminal tab becomes active, focus the terminal
- `terminal.focus()` on click
- Handle `Cmd+C` / `Cmd+V` for copy/paste (xterm.js has built-in support but needs clipboard API wiring)
- `Cmd+K` to clear terminal

**Update: `src/main/services/pty-service.ts`**

Add `getOrCreate()` — if a PTY already exists for a worktreeId, return it instead of creating a new one. This prevents duplicate PTYs when the component remounts.

Add cleanup when a worktree is deleted/archived.

**New file: `src/renderer/src/components/terminal/TerminalManager.tsx`**

Manages the mapping of worktreeId → TerminalView instances. Ensures only one TerminalView per worktree exists, handles worktree switching.

### Test

Manual:

1. Open terminal, run `sleep 100 &` → switch to Setup → switch back → process still running
2. Switch worktrees → each has its own terminal
3. Delete worktree → terminal cleaned up
4. Resize the right sidebar → terminal reflows correctly

---

## Session 6: Polish — Theming, Keyboard, UX

**Goal:** Make the terminal feel native to the app — theme integration, keyboard shortcuts, scrollback, search.

### Changes

**New dependency:**

- `@xterm/addon-search` — search within terminal output

**Update: `src/renderer/src/components/terminal/TerminalView.tsx`**

Theme integration:

- Map the app's current theme (from `useSettingsStore`) to xterm.js theme object
- When theme changes, update `terminal.options.theme`
- Support both dark and light themes
- Use CSS variables from the app where possible

Keyboard integration:

- `Cmd+F` in terminal → open search bar (xterm search addon)
- `Cmd+K` → clear terminal (`terminal.clear()`)
- `Cmd+Shift+C` / `Cmd+Shift+V` → copy/paste (or `Cmd+C` when there's a selection)
- Ensure Electron's global shortcuts (like `Cmd+,` for settings) still work — xterm.js should not consume them

Scrollback:

- Default 10,000 lines (configurable via Ghostty config `scrollback-limit`)
- Scroll position indicator

**Update: `src/renderer/src/components/terminal/TerminalView.tsx`**

Add a minimal toolbar above the terminal:

- Current shell name + pid (or just an indicator that terminal is alive)
- "+" button to restart terminal if the process exited
- Search toggle
- Maybe: split terminal (future)

**Update: xterm.css / theme integration**

Ensure the terminal's background matches the surrounding panel. The scrollbar should use the app's scrollbar styles. Selection colors should feel consistent.

### Test

Manual:

1. Switch between light/dark themes → terminal colors update
2. `Cmd+F` → search bar appears, can find text
3. `Cmd+K` → terminal clears
4. Copy/paste works correctly
5. Run `htop` → TUI renders, mouse events work
6. Run `tmux` → splits work, mouse selection works
7. Run `lazygit` → full TUI with mouse support

---

## Session 7: Native Module Scaffold (Ghostty V2 Prep)

**Goal:** Create the native Node.js addon (N-API) that can create an NSView and link against libghostty. This is the foundation for V2.

> **Prerequisites:** Zig toolchain installed, Ghostty built as static library.

### Changes

**Build libghostty:**

```bash
cd ~/Documents/dev/ghostty
zig build -Dapp-runtime=none -Doptimize=ReleaseFast -Dxcframework-target=native
```

This produces `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a` (272MB universal).

**New directory: `src/native/`**

Native Node.js addon using `node-addon-api` (N-API):

```
src/native/
  binding.gyp          # node-gyp build config, links libghostty.a
  src/
    addon.mm           # Addon entry point (ObjC++)
    ghostty_bridge.h   # C++ wrapper around ghostty.h C API
    ghostty_bridge.mm  # Implementation: init, create surface, callbacks
    nsview_host.h      # NSView creation and BrowserWindow attachment
    nsview_host.mm     # ObjC implementation
  include/
    ghostty.h          # Copied from Ghostty repo
```

`binding.gyp` must:

- Link `libghostty.a` (static)
- Link frameworks: `Metal`, `QuartzCore`, `CoreText`, `Foundation`, `AppKit`, `IOSurface`
- Set `-ObjC` and `-ObjC++` flags
- Include the ghostty header path

**Exposed N-API functions:**

```ts
// Called once at startup
ghosttyInit(): boolean

// Create a terminal surface attached to the BrowserWindow
ghosttyCreateSurface(windowHandle: Buffer, rect: {x,y,w,h}, opts: {
  cwd?: string, shell?: string, scaleFactor: number
}): number  // returns surface ID

// Reposition/resize the native view
ghosttySetFrame(surfaceId: number, rect: {x,y,w,h}): void

// Forward keyboard events
ghosttyKeyEvent(surfaceId: number, event: {...}): boolean

// Destroy
ghosttyDestroySurface(surfaceId: number): void
ghosttyShutdown(): void
```

### Test

Build the native module, call `ghosttyInit()`, verify it returns true (libghostty initializes). Don't create surfaces yet — just prove the linking works.

```bash
node -e "const addon = require('./build/Release/ghostty.node'); console.log(addon.ghosttyInit())"
```

---

## Session 8: Native Ghostty Surface Rendering

**Goal:** Create a Ghostty terminal surface in a native NSView overlaid on the Electron window.

### Changes

**Update: `src/native/src/nsview_host.mm`**

Implement view creation and positioning:

1. Extract `NSWindow*` from Electron's `getNativeWindowHandle()` buffer
2. Create a plain `NSView` with the specified frame
3. Add it as a subview of the window's content view
4. Flip coordinates (Electron uses top-left origin, NSView uses bottom-left)
5. Set `autoresizingMask` for basic resize behavior

**Update: `src/native/src/ghostty_bridge.mm`**

Implement the full Ghostty embedding:

1. `ghostty_init()` — one-time initialization
2. `ghostty_config_new()` + `ghostty_config_load_default_files()` + `ghostty_config_finalize()`
3. Set up `ghostty_runtime_config_s` with callbacks:
   - `wakeup_cb` → dispatch to Node.js main thread via `napi_threadsafe_function`
   - `action_cb` → handle RENDER (call `ghostty_surface_draw`), SET_TITLE, MOUSE_SHAPE, CLOSE_WINDOW, etc.
   - `read_clipboard_cb` → read from `NSPasteboard`
   - `write_clipboard_cb` → write to `NSPasteboard`
   - `close_surface_cb` → emit event to JS
4. `ghostty_app_new(&runtime_cfg, config)`
5. Create surface: `ghostty_surface_new(app, &surface_cfg)` with the NSView pointer

**Critical callback: `action_cb`**

Must handle at minimum:

- `RENDER` → mark surface dirty for redraw
- `SET_TITLE` → emit to JS for tab title update
- `CELL_SIZE` → update discrete resize grid
- `MOUSE_SHAPE` → set NSCursor
- `CLOSE_WINDOW` → emit to JS
- `COLOR_CHANGE` → update if needed
- `RING_BELL` → NSBeep()
- `OPEN_URL` → NSWorkspace open
- `PWD` → emit to JS
- Others → return false (unhandled)

**Update: `src/main/services/pty-service.ts`**

Add a `backend` option: `'node-pty' | 'ghostty'`. When ghostty backend is selected, delegate to the native module instead of node-pty.

### Test

1. Build and load native module
2. Create a surface → Metal-rendered terminal appears in the Electron window
3. Type commands → output renders
4. Resize the window → terminal reflows
5. Run `vim` → TUI works
6. Colors, fonts match Ghostty config

---

## Session 9: Ghostty Backend Integration & Switching

**Goal:** Wire the native Ghostty backend into the renderer UI, with runtime switching between xterm.js and native.

### Changes

**Update: `src/renderer/src/components/terminal/TerminalView.tsx`**

Add backend abstraction:

```tsx
interface TerminalBackend {
  mount(container: HTMLDivElement, opts: TerminalOpts): void
  write(data: string): void // only for xterm backend
  resize(cols: number, rows: number): void
  focus(): void
  dispose(): void
}
```

Two implementations:

- `XtermBackend` — wraps the existing xterm.js code
- `GhosttyBackend` — calls native module via IPC, manages NSView overlay positioning

The GhosttyBackend needs to:

- Track the terminal container's position on screen via `ResizeObserver` + `getBoundingClientRect()`
- Send position updates to main process → native module repositions the NSView
- Forward focus/blur events
- Handle the overlay z-ordering (set `pointer-events: none` on the HTML container, let the native view receive events)

**New setting in `useSettingsStore`:**

```ts
terminalBackend: 'xterm' | 'ghostty' // default: 'xterm'
```

Ghostty backend only available on macOS (check `process.platform`).

**Update: Settings UI**

Add terminal backend picker in settings (under the existing terminal section):

- "Built-in (xterm.js)" — cross-platform, always available
- "Ghostty (native)" — macOS only, requires Ghostty to be installed or libghostty built

### Test

1. Settings → switch to Ghostty backend → terminal re-renders natively
2. Switch back to xterm → works without issues
3. All TUI apps work in both modes
4. Resizing, tab switching, worktree switching all work in Ghostty mode
5. Keyboard shortcuts (Cmd+C/V, etc.) work in Ghostty mode

---

## File Summary

### New Files

| File                                                       | Session | Description                 |
| ---------------------------------------------------------- | ------- | --------------------------- |
| `src/main/services/pty-service.ts`                         | 1       | PTY lifecycle manager       |
| `src/main/ipc/terminal-handlers.ts`                        | 1       | Terminal IPC handlers       |
| `src/renderer/src/stores/useTerminalStore.ts`              | 2       | Terminal state management   |
| `src/renderer/src/components/terminal/TerminalView.tsx`    | 3       | xterm.js terminal component |
| `src/renderer/src/components/terminal/TerminalManager.tsx` | 5       | Multi-terminal manager      |
| `src/renderer/src/styles/xterm.css`                        | 3       | Terminal styles             |
| `src/main/services/ghostty-config.ts`                      | 4       | Ghostty config parser       |
| `test/terminal/pty-service.test.ts`                        | 1       | PTY service tests           |
| `test/terminal/ghostty-config.test.ts`                     | 4       | Config parser tests         |
| `test/terminal/terminal-store.test.ts`                     | 2       | Store tests                 |
| `src/native/` (entire directory)                           | 7-9     | Native Ghostty addon        |

### Modified Files

| File                                                 | Session | Change                                   |
| ---------------------------------------------------- | ------- | ---------------------------------------- |
| `package.json`                                       | 1, 3    | Add node-pty, xterm.js deps              |
| `electron-builder.yml`                               | 1       | Native module rebuild config (if needed) |
| `src/main/index.ts`                                  | 1       | Register terminal handlers               |
| `src/preload/index.ts`                               | 2       | Add `terminalOps` namespace              |
| `src/preload/index.d.ts`                             | 2       | Add terminal type declarations           |
| `src/renderer/src/stores/index.ts`                   | 2       | Export terminal store                    |
| `src/renderer/src/components/layout/BottomPanel.tsx` | 3, 5    | Replace placeholder with TerminalView    |

---

## Dependency Summary

### V1 (Sessions 1-6)

```
node-pty          — Native PTY binding (main process)
@xterm/xterm      — Terminal emulator UI (renderer)
@xterm/addon-fit  — Auto-resize addon
@xterm/addon-web-links — Clickable URL detection
@xterm/addon-webgl — GPU-accelerated rendering
@xterm/addon-search — Search within terminal
```

### V2 (Sessions 7-9)

```
node-addon-api    — N-API C++ addon helpers
libghostty.a      — Built from Ghostty source (static library, ~272MB)
```

---

## Risk Assessment

| Risk                                             | Likelihood | Mitigation                                                                |
| ------------------------------------------------ | ---------- | ------------------------------------------------------------------------- |
| node-pty build fails for Electron's Node ABI     | Low        | Well-tested with Electron; `electron-builder install-app-deps` handles it |
| xterm.js WebGL addon crashes on some GPUs        | Low        | Automatic fallback to canvas renderer                                     |
| Ghostty config format changes in future versions | Medium     | Parser is lenient; unknown keys ignored                                   |
| Native module (V2) breaks on Electron upgrade    | High       | V1 (xterm.js) is always the fallback                                      |
| NSView overlay z-ordering issues (V2)            | High       | Extensive testing needed; may need to use child window instead            |
| IME/composition input in native mode (V2)        | Medium     | Ghostty handles IME natively; just need to not intercept it in Electron   |

---

## Success Criteria

After Session 6 (V1 complete):

- [ ] Terminal renders in the Terminal tab with user's shell
- [ ] TUI apps work: vim, tmux, htop, lazygit, top
- [ ] Mouse events work (click, scroll, selection)
- [ ] Copy/paste works (Cmd+C with selection, Cmd+V)
- [ ] Terminal reflows on resize
- [ ] Each worktree has its own terminal instance
- [ ] Terminal persists across tab switches
- [ ] Ghostty config is applied (font, colors, cursor)
- [ ] Search works (Cmd+F)
- [ ] Exited processes show status and allow restart

After Session 9 (V2 complete):

- [ ] Native Ghostty rendering via Metal on macOS
- [ ] Identical feature parity with standalone Ghostty
- [ ] Switchable backends in settings
- [ ] All V1 criteria still met with xterm.js backend
