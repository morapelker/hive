# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev              # Start Electron app with hot reload
pnpm build            # Build main + preload + renderer (electron-vite)
pnpm build:web        # Build standalone web UI (vite.config.web.ts)
pnpm lint             # ESLint check (.ts, .tsx)
pnpm lint:fix         # ESLint auto-fix
pnpm format           # Prettier format src/**
pnpm test             # Run all tests (vitest run)
pnpm test:watch       # Vitest in watch mode
pnpm codegen          # Regenerate GraphQL TypeScript types from schema
pnpm start:server     # Run headless GraphQL server (no Electron window)
```

Run a single test file:
```bash
pnpm vitest run test/server/path-guard.test.ts
```

Build for distribution:
```bash
pnpm build:mac          # Signed macOS build (requires .env.signing)
pnpm build:mac:unsigned # Unsigned macOS build
```

## Architecture

Hive is an Electron app that manages git worktrees and AI coding sessions (OpenCode, Claude Code, Codex).

### Process model

```
Main Process (Node.js)
  └── src/main/          — Electron main, SQLite DB, IPC handlers, services
  └── src/server/        — GraphQL server (graphql-yoga + graphql-ws)

Preload (src/preload/)   — Context bridge exposing typed window.* APIs to renderer

Renderer Process (React)
  └── src/renderer/src/  — React 19 SPA, Zustand stores, shadcn/ui + Tailwind 4
```

### Dual communication channels

The renderer communicates with the main process via **two** channels:

1. **IPC** (`window.*` APIs defined in `src/preload/index.ts`) — used for direct database operations (CRUD for projects, worktrees, sessions, settings, etc.)

2. **GraphQL over HTTP/WebSocket** — used for AI session operations, git queries, file tree, and real-time subscriptions. The server runs inside the Electron main process on a local port (HTTPS in production, HTTP in dev/headless). GraphQL types are auto-generated into `src/server/__generated__/` via `pnpm codegen`.

### Server (`src/server/`)

- `index.ts` — starts graphql-yoga + WebSocket server (graphql-ws)
- `schema/schema.graphql` — single source of truth for all GraphQL types
- `resolvers/` — split into `query/`, `mutation/`, `subscription/`
- `context.ts` — `GraphQLContext`: `{ db, sdkManager, eventBus, clientIp, authenticated }`
- `plugins/auth.ts` — bearer token auth + brute-force protection
- `plugins/path-guard.ts` — `PathGuard` class validates all file path arguments against allowed roots to prevent traversal attacks. `PATH_ARG_NAMES` lists the argument names that are automatically validated.
- `static-handler.ts` — serves the built web UI from `out/web/` with SPA fallback

### Main process (`src/main/`)

- `db/` — `better-sqlite3` in WAL mode; `schema.ts` defines `CURRENT_SCHEMA_VERSION` (currently 20) and `SCHEMA_SQL`; migrations run on startup
- `ipc/` — one handler file per domain (projects, worktrees, sessions, git, terminal, kanban, etc.)
- `services/` — business logic: `git-service.ts`, `agent-sdk-manager.ts`, `opencode-service.ts`, `claude-code-implementer.ts`, `codex-implementer.ts`, `pty-service.ts`, `lsp/`, `connection-service.ts`, etc.

### Renderer (`src/renderer/src/`)

- `components/` — organized by domain: `sessions/`, `worktrees/`, `projects/`, `git/`, `terminal/`, `kanban/`, `connections/`, `file-tree/`, `settings/`, `spaces/`, etc.
- `stores/` — one Zustand store per domain (e.g. `useSessionStore.ts`, `useWorktreeStore.ts`). `store-coordination.ts` handles cross-store notifications.
- `@` alias maps to `src/renderer/src/`; `@shared` alias maps to `src/shared/`

### Headless mode

The app can run without an Electron window as a pure GraphQL server:
```bash
electron out/main/index.js --headless [--port 3000] [--bind 0.0.0.0]
```
The web UI (built via `pnpm build:web`) is then served as a SPA from `out/web/`.

### Testing

Tests live in `test/`. The vitest workspace (`vitest.workspace.ts`) runs two projects:
- **renderer** — jsdom environment for React/store tests
- **main** — Node environment for server, LSP, and main-process tests (Electron is mocked via `test/__mocks__/electron.ts`)

GraphQL types must be regenerated (`pnpm codegen`) after changing `schema.graphql`.
