# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Hive** is an Electron desktop app for managing git projects and worktrees with integrated OpenCode AI coding sessions. Built with Electron 33 + React 19 + TypeScript + Tailwind CSS 4 + SQLite.

## Commands

```bash
pnpm dev              # Start dev with hot reload (all processes)
pnpm build            # Production build to out/
pnpm lint             # ESLint check
pnpm lint:fix         # ESLint auto-fix
pnpm format           # Prettier format src/**/*.{ts,tsx,css}
pnpm test             # Vitest run all tests
pnpm test:watch       # Vitest watch mode
pnpm test:e2e         # Playwright E2E tests
pnpm build:mac        # Package for macOS
```

Run a single test file: `pnpm vitest run test/path/to/file.test.ts`

## Architecture

### Three-Process Electron Model

```
src/main/        → Electron main process (Node.js)
src/preload/     → Preload bridge (context-isolated IPC)
src/renderer/    → React UI (browser context)
```

All renderer↔main communication goes through the preload layer via typed IPC. The renderer never has direct Node.js access (sandbox: true, contextIsolation: true).

### Path Aliases

- `@/` → `src/renderer/src/` (renderer code)
- `@main/` → `src/main/` (main process code)
- `@preload/` → `src/preload/` (preload scripts)

### Main Process (`src/main/`)

- **`db/`** — SQLite via better-sqlite3. Schema in `schema.ts` with versioned migrations (CURRENT_SCHEMA_VERSION = 4). Database at `~/.hive/hive.db`. WAL mode, foreign keys enabled.
- **`ipc/`** — 13 IPC handler modules registered in `index.ts`. Pattern: `ipcMain.handle(channel, handler)` returning Promise results.
- **`services/`** — Core services: `git-service.ts` (simple-git wrapper), `opencode-service.ts` (OpenCode SDK lifecycle), `script-runner.ts` (setup/run/archive script execution), `logger.ts` (Winston-style, logs to ~/Library/Logs/hive/).

### Preload (`src/preload/`)

- **`index.ts`** — Exposes typed APIs to renderer window: `window.db`, `window.projectOps`, `window.worktreeOps`, `window.opencodeOps`, `window.gitOps`, `window.fileTreeOps`, `window.settingsOps`, `window.fileOps`, `window.scriptOps`, `window.systemOps`, `window.loggingOps`, `window.api`.
- **`index.d.ts`** — Global type declarations for all window APIs and database entities (Project, Worktree, Session, SessionMessage, Setting). This is the single source of truth for shared types between processes.

### Renderer (`src/renderer/src/`)

- **`stores/`** — Zustand stores (18 files). Each domain has its own store (useProjectStore, useWorktreeStore, useSessionStore, useLayoutStore, useThemeStore, useFileTreeStore, useGitStore, useScriptStore, etc.). All exported from `stores/index.ts`.
- **`hooks/`** — Custom hooks: `useKeyboardShortcuts` (global), `useKeyboardShortcut` (individual), `useCommands` (command palette), `useOpenCodeGlobalListener` (background session events). All exported from `hooks/index.ts`.
- **`components/`** — React components organized by domain: `ui/` (shadcn/ui primitives), `layout/` (AppLayout, Header, sidebars, MainPane), `projects/`, `worktrees/`, `sessions/`, `settings/`, `command-palette/`, `file-tree/`, `file-viewer/`, `git/`, `diff/`, `error/`.
- **`lib/`** — Utilities: `utils.ts` (cn() helper), `themes.ts` (CSS variable-based theming).

### Data Flow Pattern

1. User action in React component
2. Component calls `window.{apiNamespace}.{method}()`
3. Preload forwards via `ipcRenderer.invoke(channel, args)`
4. Main process handler in `src/main/ipc/` processes and returns
5. Store updates with result, component re-renders

### Adding a New IPC Channel

1. Add handler in `src/main/ipc/` (or create new handler file and register in `src/main/index.ts`)
2. Expose in `src/preload/index.ts` under the appropriate `window.*` namespace
3. Add type declaration in `src/preload/index.d.ts`
4. Call from renderer via the typed window API

### Database Changes

Schema migrations live in `src/main/db/schema.ts` in the `MIGRATIONS` array. Bump `CURRENT_SCHEMA_VERSION` and add a new migration entry. The `DatabaseService` singleton runs migrations automatically on init.

## UI Framework

- **shadcn/ui** (new-york style, zinc base color) with Radix primitives
- **Tailwind CSS 4** via `@tailwindcss/vite` plugin
- **Icons**: lucide-react
- **Toasts**: sonner
- **Command palette**: cmdk
- Add new shadcn components: `pnpm dlx shadcn@latest add <component>`

## Code Style

- No semicolons, single quotes, no trailing commas, 100 char print width, 2-space indent
- Unused variables prefixed with `_` (eslint rule: `argsIgnorePattern: '^_'`)
- Components wrapped in ErrorBoundary where appropriate

## Testing

- **Vitest** with two workspaces: `renderer` (jsdom) and `main` (node, only `test/session-3/`)
- Test setup in `test/setup.ts` mocks `window.matchMedia`, `window.gitOps`, `window.fileTreeOps`
- Tests organized by phase/session directories under `test/`
- Window API mocks: define on `window` with `Object.defineProperty` in setup or individual test files
