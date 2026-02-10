# AGENTS.md

> Instructions for AI coding agents operating in this repository.

## Project

Hive -- Electron desktop app for managing git projects/worktrees with integrated AI coding sessions.
Stack: Electron 33, React 19, TypeScript 5.7, Tailwind CSS 4, Zustand 5, SQLite (better-sqlite3).

## Commands

```bash
pnpm dev                # Start dev with hot reload
pnpm build              # Production build to out/
pnpm lint               # ESLint check
pnpm lint:fix           # ESLint auto-fix
pnpm format             # Prettier format src/**/*.{ts,tsx,css}
pnpm test               # Vitest run all tests
pnpm test:watch         # Vitest watch mode
pnpm test:e2e           # Playwright E2E tests
pnpm build:mac          # Package for macOS
```

**Run a single test file:**

```bash
pnpm vitest run test/path/to/file.test.ts
```

**Always use pnpm** -- never npm or yarn.

## Architecture

Three-process Electron model:

| Directory       | Context         | Alias       |
| --------------- | --------------- | ----------- |
| `src/main/`     | Node.js (main)  | `@main/`    |
| `src/preload/`  | Isolated bridge | `@preload/` |
| `src/renderer/` | Browser (React) | `@/`        |

The renderer is sandboxed (`sandbox: true`, `contextIsolation: true`). All cross-process communication uses typed IPC through the preload layer.

**Data flow:** Component -> `window.{namespace}.{method}()` -> preload `ipcRenderer.invoke` -> main handler -> returns result -> store updates -> re-render.

## Code Style

### Formatting (Prettier)

- No semicolons
- Single quotes
- No trailing commas
- 100 char print width
- 2-space indent

### TypeScript

- Strict mode via `@electron-toolkit/tsconfig`
- Prefix unused variables/params with `_` (ESLint: `argsIgnorePattern: '^_'`)
- Use explicit types for function params; return types optional for components
- Error narrowing: `error instanceof Error ? error.message : String(error)`
- Catch blocks for non-critical failures may use bare `catch { }` (no variable)

### Imports

**Renderer code:** Use `@/` alias exclusively.

```ts
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useProjectStore, useWorktreeStore } from '@/stores'
```

**Main process:** Use relative imports or `@main/` alias.

```ts
import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
```

**Preload:** Import directly from `'electron'`.

### Naming Conventions

| Entity            | Convention    | Example                              |
| ----------------- | ------------- | ------------------------------------ |
| Components        | PascalCase    | `ProjectItem`, `AppLayout`           |
| Stores            | `useXxxStore` | `useProjectStore`                    |
| IPC handler files | kebab-case    | `project-handlers.ts`                |
| Service files     | kebab-case    | `git-service.ts`                     |
| Type interfaces   | PascalCase    | `Project`, `ProjectCreate`           |
| IPC channels      | colon-delim   | `db:project:create`, `git:stageFile` |

### React Components

- Functional components only, no class components
- Use `cn()` from `@/lib/utils` for conditional classNames
- UI primitives from shadcn/ui (new-york style, zinc base)
- Icons from `lucide-react`
- Toasts via `sonner` (`toast.success()`, `toast.error()`)
- Wrap major sections in `ErrorBoundary`
- Add `data-testid` attributes for testable elements

### Zustand Stores

Pattern: state + actions in a single interface, async actions call `window.*` APIs.

```ts
create<State>()(
  persist(
    (set, get) => ({
      /* state + actions */
    }),
    { name: 'hive-xxx', storage: createJSONStorage(() => localStorage) }
  )
)
```

All stores exported from `src/renderer/src/stores/index.ts`.

### Error Handling

- **Main process:** try/catch with `log.error()`, re-throw or return `{ success: false, error }`.
  Use `withErrorHandler` wrapper where available (see `database-handlers.ts`).
- **Renderer stores:** try/catch returning `{ success: boolean; error?: string }`.
- **Components:** ErrorBoundary wrapping, toast notifications for user-facing errors.

## Types

`src/preload/index.d.ts` is the **single source of truth** for shared types between processes. All entity types (`Project`, `Worktree`, `Session`, `SessionMessage`, `Setting`) and the full `Window` interface with all 12 API namespaces are defined there.

Main-process-only types live in `src/main/db/types.ts` with Create/Update variants.

## Adding a New IPC Channel

1. Add handler in `src/main/ipc/` -- use `ipcMain.handle(channel, handler)` pattern
2. Register in `src/main/index.ts` if creating a new handler module
3. Expose in `src/preload/index.ts` under the appropriate `window.*` namespace
4. Add type declaration in `src/preload/index.d.ts`
5. Call from renderer via `window.{namespace}.{method}()`

## Database

SQLite via `better-sqlite3`. Singleton `DatabaseService`. WAL mode, foreign keys ON.
Schema version tracked in `CURRENT_SCHEMA_VERSION` in `src/main/db/schema.ts`.
To add a migration: append to the `MIGRATIONS` array, bump `CURRENT_SCHEMA_VERSION`.

## Testing

- **Framework:** Vitest (jsdom environment for renderer tests, node for main)
- **Libraries:** `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`
- **Setup:** `test/setup.ts` mocks `window.matchMedia`, `window.gitOps`, `window.fileTreeOps`
- **Mock pattern:** Use `Object.defineProperty(window, 'apiName', { value: { method: vi.fn() } })`
- **Tests live in:** `test/` directory, organized by phase/session subdirectories
- **Globals:** `vitest` globals enabled -- no need to import `describe`, `it`, `expect`

## UI Framework

- **shadcn/ui:** new-york style, zinc base, CSS variables. Add components: `pnpm dlx shadcn@latest add <component>`
- **Tailwind CSS 4:** `@tailwindcss/vite` plugin, `@import "tailwindcss"` + `@theme inline` pattern
- **Theming:** 10 presets (6 dark, 4 light) via CSS variables in `src/renderer/src/lib/themes.ts`

## Logging

Main process uses `createLogger({ component: 'Name' })` from `src/main/services/logger.ts`.
Logs to `~/.hive/logs/hive-YYYY-MM-DD.log`. Max 5MB/file, 5 files retained.
