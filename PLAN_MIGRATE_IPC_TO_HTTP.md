# IPC to HTTP/WS Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Hive from Electron IPC-backed application APIs to a T3Code-style local HTTP/WebSocket backend, leaving Electron as a desktop shell only.

**Architecture:** Hive will gain a `src/server` runtime that owns database, git, filesystem, terminal, script, agent, settings, telemetry, and streaming services. The renderer will connect over authenticated HTTP/WS through a typed client. Electron IPC will shrink to a small `desktopBridge` for native shell functions only.

**Tech Stack:** Electron, React/Vite, TypeScript, Node HTTP/WebSocket runtime, Zod schemas, Vitest, Playwright, existing Hive service modules.

---

## Desired End State

Hive should run in two equivalent UI hosts:

- Electron desktop app: Electron starts and supervises a local backend server, then loads the renderer.
- Chrome/browser app: a browser loads the same renderer and connects to an already-running Hive backend.

The backend server owns all high-privilege app behavior:

- SQLite database access
- project/worktree operations
- git operations and watchers
- file tree scanning and file reads/writes
- attachment storage
- terminal PTYs
- script execution
- bash execution
- OpenCode, Claude Code, Claude CLI, and Codex session management
- agent streaming events, approvals, questions, plan approvals, and command approvals
- usage/account/settings/telemetry operations
- ticket import and kanban operations

Electron IPC remains only for native desktop shell capabilities:

- native folder/file picker
- native context menu
- app/window/menu actions
- updater
- open external URL/path
- app quit/restart
- secure desktop bootstrap
- desktop-only overlays and native UI integrations

## Non-Goals

- Do not rewrite the renderer UI.
- Do not replace Electron packaging.
- Do not expose the server publicly by default.
- Do not make Ghostty native surfaces browser-compatible.
- Do not delete the current IPC bridge until HTTP/WS parity exists.
- Do not move every renderer call site in one commit.

## Migration Strategy

Use a strangler migration.

1. Introduce a server and renderer HTTP/WS client.
2. Add a compatibility shim that exposes the existing `window.db`, `window.gitOps`, `window.opencodeOps`, and related APIs over HTTP/WS.
3. Migrate one domain at a time from IPC to RPC.
4. Keep old IPC handlers calling the same extracted services until each domain has parity.
5. Move renderer call sites from globals to explicit imported clients after the system works.
6. Delete old IPC surfaces only after all direct callers are gone.

This avoids a risky one-shot rewrite of the renderer, preload, and main process.

## Canonical Transport Shape

Define a shared request/response/event model in `src/shared/rpc`.

```ts
export interface RpcRequest {
  id: string
  method: string
  params: unknown
}

export type RpcResponse =
  | { id: string; ok: true; value: unknown }
  | {
      id: string
      ok: false
      error: {
        code: string
        message: string
        details?: unknown
      }
    }

export interface ServerEvent {
  channel: string
  payload: unknown
}
```

During the compatibility phase, convert RPC responses back into the existing `Envelope<T>` shape at the renderer compatibility boundary. That keeps current stores/components stable while transport changes underneath.

## Proposed File Structure

Create these new areas:

```text
src/server/
  bin.ts
  config.ts
  server.ts
  auth/
    bootstrap.ts
    session.ts
  events/
    event-bus.ts
  routes/
    environment.ts
    auth.ts
    static.ts
    attachments.ts
  rpc/
    protocol.ts
    router.ts
    ws-server.ts
    domains/
      db.ts
      project.ts
      worktree.ts
      git.ts
      file-tree.ts
      file.ts
      attachment.ts
      agent.ts
      terminal.ts
      script.ts
      bash.ts
      settings.ts
      connection.ts
      kanban.ts
      ticket-import.ts
      usage.ts
      account.ts
      telemetry.ts
      diagnostics.ts

src/shared/rpc/
  envelope.ts
  methods.ts
  events.ts
  errors.ts

src/renderer/src/api/
  environment.ts
  auth-bootstrap.ts
  hive-client.ts
  ws-transport.ts
  legacy-window-api.ts
  desktop-bridge.ts

src/main/desktop/
  backend-config.ts
  backend-manager.ts
  desktop-bridge-handlers.ts
```

Existing IPC handlers should be retained temporarily, then deleted domain by domain.

---

## Phase 1: Server Skeleton

**Goal:** Create a standalone Hive backend process with a health route and minimal WebSocket RPC.

**Files:**

- Create: `src/server/config.ts`
- Create: `src/server/bin.ts`
- Create: `src/server/server.ts`
- Create: `src/server/events/event-bus.ts`
- Create: `src/server/rpc/protocol.ts`
- Create: `src/server/rpc/router.ts`
- Create: `src/server/rpc/ws-server.ts`
- Create: `src/shared/rpc/envelope.ts`
- Create: `src/shared/rpc/errors.ts`
- Test: `src/server/__tests__/server-config.test.ts`
- Test: `src/server/__tests__/server-smoke.test.ts`
- Test: `src/server/__tests__/rpc-router.test.ts`

- [ ] Add `ServerConfig` with `mode`, `host`, `port`, `baseDir`, `devUrl`, `staticDir`, `desktopBootstrapToken`, `logLevel`, and path derivation.
- [ ] Add a server entrypoint that can run without Electron.
- [ ] Add `GET /.well-known/hive/environment`.
- [ ] Add `/ws` WebSocket endpoint.
- [ ] Add `system.ping` RPC returning `{ ok: true }`.
- [ ] Add typed RPC error conversion for validation errors, domain errors, and unexpected defects.
- [ ] Add server event bus with `publish`, `subscribe`, and `unsubscribe`.
- [ ] Verify that `pnpm test -- src/server/__tests__/server-smoke.test.ts` passes.

**Acceptance criteria:**

- The server can start without creating an Electron window.
- A client can hit the health route.
- A client can call `system.ping` over WebSocket.

---

## Phase 2: Desktop Backend Manager

**Goal:** Make Electron start and supervise the backend server before opening the renderer.

**Files:**

- Create: `src/main/desktop/backend-config.ts`
- Create: `src/main/desktop/backend-manager.ts`
- Create: `src/main/desktop/backend-manager.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

- [ ] Add backend port selection, defaulting to `3773` and scanning upward when unavailable.
- [ ] Generate a one-time desktop bootstrap token per Electron run.
- [ ] Spawn the backend with `ELECTRON_RUN_AS_NODE=1`.
- [ ] Pass bootstrap config to the child process through a file descriptor or a scoped environment variable.
- [ ] Capture backend stdout/stderr to Hive logs.
- [ ] Poll `/.well-known/hive/environment` until ready.
- [ ] Open the renderer only after backend readiness.
- [ ] Add bounded restart on unexpected backend exit.
- [ ] Stop backend on app shutdown.

**Acceptance criteria:**

- `pnpm dev` starts a backend process first.
- The Electron window opens only after backend readiness.
- Backend crash logs are visible.
- The backend shuts down when Electron quits.

---

## Phase 3: Desktop Bridge

**Goal:** Shrink Electron preload toward native shell features while keeping the old IPC namespaces temporarily.

**Files:**

- Create: `src/main/desktop/desktop-bridge-handlers.ts`
- Create: `src/renderer/src/api/desktop-bridge.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`

Expose this future stable shape:

```ts
export interface DesktopBridge {
  getLocalEnvironmentBootstrap(): {
    httpBaseUrl: string
    wsBaseUrl: string
    bootstrapToken: string
  } | null
  pickFolder(options?: { defaultPath?: string }): Promise<string | null>
  confirm(message: string): Promise<boolean>
  showContextMenu<T extends string>(
    items: readonly { id: T; label: string; destructive?: boolean; disabled?: boolean }[],
    position?: { x: number; y: number }
  ): Promise<T | null>
  openExternal(url: string): Promise<boolean>
  onMenuAction(listener: (action: string) => void): () => void
  getUpdateState(): Promise<unknown>
  checkForUpdate(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  installUpdate(): Promise<unknown>
}
```

- [ ] Add `window.desktopBridge`.
- [ ] Keep existing `window.db`, `window.gitOps`, and similar namespaces for compatibility.
- [ ] Route native dialog/menu/updater methods through `desktopBridge`.
- [ ] Move desktop-only types away from core server/shared RPC types.

**Acceptance criteria:**

- Native menu, folder picker, updater, and external URL actions still work.
- Renderer can read backend bootstrap information from `desktopBridge`.

---

## Phase 4: Renderer HTTP/WS Client

**Goal:** Add a browser-capable renderer client and a compatibility shim for the existing global APIs.

**Files:**

- Create: `src/renderer/src/api/environment.ts`
- Create: `src/renderer/src/api/auth-bootstrap.ts`
- Create: `src/renderer/src/api/ws-transport.ts`
- Create: `src/renderer/src/api/hive-client.ts`
- Create: `src/renderer/src/api/legacy-window-api.ts`
- Test: `src/renderer/src/api/__tests__/environment.test.ts`
- Test: `src/renderer/src/api/__tests__/hive-client.test.ts`
- Test: `src/renderer/src/api/__tests__/legacy-window-api.test.ts`

- [ ] Resolve backend target from `desktopBridge.getLocalEnvironmentBootstrap()`.
- [ ] Resolve backend target from Vite env for browser dev mode.
- [ ] Resolve backend target from `window.location.origin` for production browser mode.
- [ ] Exchange desktop bootstrap token for an authenticated session.
- [ ] Create reconnecting WebSocket transport.
- [ ] Implement `HiveClient.request(method, params)`.
- [ ] Implement `HiveClient.subscribe(channel, params, callback)`.
- [ ] Implement `installLegacyWindowApi(client)` that recreates the existing preload global namespaces.

**Acceptance criteria:**

- Renderer code can call `window.db.setting.get` through the compatibility shim.
- A browser tab can connect to a local backend in dev mode.

---

## Phase 5: Authentication

**Goal:** Protect the local backend even before remote access exists.

**Files:**

- Create: `src/server/auth/bootstrap.ts`
- Create: `src/server/auth/session.ts`
- Create: `src/server/routes/auth.ts`
- Modify: `src/server/rpc/ws-server.ts`
- Test: `src/server/__tests__/auth-bootstrap.test.ts`
- Test: `src/server/__tests__/auth-ws.test.ts`

- [ ] Add `POST /api/auth/bootstrap` to exchange a desktop bootstrap token.
- [ ] Add `GET /api/auth/session` to check auth state.
- [ ] Add `POST /api/auth/ws-token` to issue a short-lived WS token.
- [ ] Require auth for WebSocket upgrade.
- [ ] Require auth for high-privilege HTTP routes.
- [ ] Allow unauthenticated access only to health/environment and bootstrap endpoints.

**Acceptance criteria:**

- Unauthenticated WS connection is rejected.
- Desktop bootstrap token creates an authenticated session.
- Browser mode can authenticate when given valid pairing/bootstrap credentials.

---

## Phase 6: Low-Risk RPC Domains

**Goal:** Prove the migration pattern with stateful but lower-risk domains.

**Domains:**

- `db`
- `settingsOps`
- `projectOps`
- `worktreeOps`
- `connectionOps`
- `kanban`
- `fileOps`
- `attachmentOps`

**Files:**

- Create RPC files under `src/server/rpc/domains/`
- Extract service modules as needed under `src/main/services/` or `src/server/services/`
- Modify matching files under `src/main/ipc/`
- Test parity per domain under `src/server/__tests__/`

- [ ] Extract domain logic from IPC handler into Electron-free service functions.
- [ ] Keep old IPC handler as an adapter over the extracted function.
- [ ] Add RPC handler as another adapter over the same function.
- [ ] Add tests that verify RPC output matches current IPC envelope behavior.
- [ ] Switch the compatibility shim method by method from IPC to RPC.
- [ ] Leave old IPC in place until direct renderer callers are gone.

**Acceptance criteria:**

- Settings, project list, worktree list, kanban tickets, files, and attachments work through HTTP/WS.
- IPC and RPC parity tests pass during migration.

---

## Phase 7: Event Subscriptions

**Goal:** Replace `BrowserWindow.webContents.send` and `ipcRenderer.on` with server-published WebSocket subscriptions.

**Events to migrate:**

- `git:statusChanged`
- `git:branchChanged`
- `worktree:branchRenamed`
- `file-tree:change`
- `opencode:stream`
- `telegram:statusChanged`
- `telegram:planImplementRequested`
- `script:*`
- `terminal:data:*`
- `terminal:exit:*`
- `terminal:claude-session-id:*`
- `claude-cli:status`
- `bash:stream`

**Files:**

- Modify: `src/server/events/event-bus.ts`
- Modify: `src/server/rpc/ws-server.ts`
- Modify affected services that currently call `webContents.send`
- Test: `src/server/__tests__/subscriptions.test.ts`

- [ ] Add subscription request shape: `{ channel: string; filter?: unknown }`.
- [ ] Add filtered event streams over WS.
- [ ] Add unsubscribe support.
- [ ] Batch terminal/script output chunks.
- [ ] Replace service-level `BrowserWindow` dependencies with event bus publishing.
- [ ] Keep menu/shortcut events on `desktopBridge`, not server event bus.

**Acceptance criteria:**

- Renderer can subscribe/unsubscribe to server events.
- High-volume output does not flood the renderer with one WS frame per byte chunk.
- Reconnect can resubscribe.

---

## Phase 8: Git and File Tree

**Goal:** Move git/file watching fully into the server runtime.

**Files:**

- Refactor: `src/main/ipc/git-file-handlers.ts`
- Refactor: `src/main/ipc/file-tree-handlers.ts`
- Refactor: `src/main/services/git-service.ts`
- Refactor: `src/main/services/worktree-watcher.ts`
- Refactor: `src/main/services/branch-watcher.ts`
- Create: `src/server/rpc/domains/git.ts`
- Create: `src/server/rpc/domains/file-tree.ts`
- Test: `src/server/__tests__/git-rpc.test.ts`
- Test: `src/server/__tests__/file-tree-rpc.test.ts`

- [ ] Move git operations into server-safe services with no Electron imports.
- [ ] Move watcher ownership into server lifecycle.
- [ ] Publish watcher updates through server event bus.
- [ ] Add RPC methods for status, branch info, diffs, staging, commits, push/pull, PR helpers, and file content.
- [ ] Add temp-git-repository integration tests.

**Acceptance criteria:**

- Git sidebar, diff UI, staging, commit, push, pull, and PR helpers work without Electron IPC.
- File tree scan/watch works without Electron IPC.

---

## Phase 9: Terminal and Script Streaming

**Goal:** Make xterm/node-pty and scripts work over WebSocket.

**Files:**

- Refactor: `src/main/services/pty-service.ts`
- Refactor: `src/main/services/script-runner.ts`
- Create: `src/server/rpc/domains/terminal.ts`
- Create: `src/server/rpc/domains/script.ts`
- Test: `src/server/__tests__/terminal-rpc.test.ts`
- Test: `src/server/__tests__/script-rpc.test.ts`

- [ ] Add `terminal.create`.
- [ ] Add `terminal.write`.
- [ ] Add `terminal.resize`.
- [ ] Add `terminal.destroy`.
- [ ] Add `terminal.data` subscription.
- [ ] Add `terminal.exit` subscription.
- [ ] Add script setup/run/archive/kill RPC methods.
- [ ] Add script output subscription.
- [ ] Keep Ghostty native integration desktop-only behind Electron.

**Acceptance criteria:**

- xterm terminal works in Electron and Chrome.
- Script output streams over WS.
- Ghostty absence does not break browser mode.

---

## Phase 10: Agent APIs

**Goal:** Move OpenCode, Claude Code, Claude CLI, and Codex session APIs to server RPC.

**Files:**

- Refactor: `src/main/ipc/opencode-handlers.ts`
- Refactor: `src/main/services/opencode-service.ts`
- Refactor: `src/main/services/agent-sdk-manager.ts`
- Refactor: `src/main/services/claude-code-implementer.ts`
- Refactor: `src/main/services/codex-implementer.ts`
- Refactor: `src/main/services/agent-event-bus.ts`
- Create: `src/server/rpc/domains/agent.ts`
- Test: `src/server/__tests__/agent-rpc.mock-provider.test.ts`
- Test: `src/server/__tests__/agent-stream-subscription.test.ts`

- [ ] Remove `BrowserWindow` from core agent service dependencies.
- [ ] Publish agent streams through server event bus.
- [ ] Add RPC methods for connect, reconnect, prompt, abort, steer, disconnect, messages, models, set model, model info, session info, undo, redo, commands, command execution, capabilities, fork, rename, refresh from thread.
- [ ] Add RPC methods for question reply/reject.
- [ ] Add RPC methods for plan approve/reject.
- [ ] Add RPC methods for permission and command approval replies.
- [ ] Add mocked-provider tests before real provider smoke tests.

**Acceptance criteria:**

- Agent sessions work through HTTP/WS.
- Approval/question/plan flows route correctly.
- Stream event ordering matches current renderer expectations.

---

## Phase 11: Browser Mode Scripts and Dev Workflow

**Goal:** Make Chrome a supported development target.

**Files:**

- Modify: `package.json`
- Modify: `electron.vite.config.ts`
- Add or modify Vite config if a separate web config is needed.
- Test: Playwright browser smoke tests.

- [ ] Add `dev:server`.
- [ ] Add `dev:web`.
- [ ] Add `dev:desktop`.
- [ ] Add loopback CORS rules for Vite dev origins.
- [ ] Add browser smoke test that loads app in Chrome, authenticates, reads settings, and lists projects.
- [ ] Add Electron smoke test that verifies desktop starts backend and opens renderer.

**Acceptance criteria:**

- `pnpm dev:web` can run the renderer in Chrome against a local backend.
- `pnpm dev:desktop` still runs the Electron app.
- Browser and Electron share the same renderer client path.

---

## Phase 12: Renderer API Cleanup

**Goal:** Stop relying on `window.*Ops` globals in app code.

**Files:**

- Modify renderer stores and hooks under `src/renderer/src/stores/`
- Modify renderer components under `src/renderer/src/components/`
- Delete: `src/renderer/src/api/legacy-window-api.ts` after migration
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`

- [ ] Introduce explicit API access hooks or modules for each domain.
- [ ] Replace `window.db` calls.
- [ ] Replace `window.gitOps` calls.
- [ ] Replace `window.opencodeOps` calls.
- [ ] Replace `window.terminalOps` calls.
- [ ] Replace remaining business API globals.
- [ ] Keep `window.desktopBridge` for native shell actions.
- [ ] Delete compatibility shim when unused.

**Acceptance criteria:**

- Core renderer code has no direct dependency on Electron IPC globals.
- Only `desktopBridge` remains as a window global.

---

## Phase 13: IPC Deletion

**Goal:** Remove old business IPC handlers and preload namespaces.

**Files:**

- Delete migrated files under `src/main/ipc/` where no longer needed.
- Shrink: `src/preload/index.ts`
- Shrink: `src/preload/index.d.ts`
- Update: `README.md`
- Update architecture docs.

- [ ] Delete migrated IPC handlers.
- [ ] Delete old preload namespace exposure for business APIs.
- [ ] Delete old IPC-specific tests or convert them to RPC tests.
- [ ] Update README architecture diagram from IPC to HTTP/WS.
- [ ] Run full build/test/lint suite.

**Acceptance criteria:**

- No core application operation uses Electron IPC.
- Electron IPC is desktop-shell-only.
- Server can run headlessly.
- Chrome can run Hive against the backend.

---

## Testing Strategy

Required test categories:

- Server config tests.
- Auth bootstrap tests.
- RPC router tests.
- WebSocket transport tests.
- Domain parity tests while IPC and RPC coexist.
- Subscription tests.
- Temp git repository integration tests.
- Terminal PTY integration tests.
- Script streaming tests.
- Mocked agent provider tests.
- Electron smoke test.
- Browser Playwright smoke test.

Recommended verification commands during implementation:

```bash
pnpm test
pnpm build
pnpm lint
pnpm test:e2e
```

Run narrower tests at each phase before running the full suite.

---

## First Milestone

Build the smallest useful vertical slice:

- Desktop starts backend.
- Backend exposes health route and `/ws`.
- Renderer authenticates using desktop bootstrap.
- RPC supports:
  - `db.setting.get`
  - `db.setting.set`
  - `db.setting.getAll`
- Compatibility shim exposes existing `window.db.setting`.
- Existing settings flow works through WS.
- Chrome can open the Vite app and connect to the backend.

This proves the architecture before migrating the full IPC surface.

---

## Migration Risks

- The current preload exposes a very large API surface, so compatibility shim behavior must be precise.
- Agent streams and approval flows are the highest-risk migration area.
- Terminal streaming needs batching and reconnect behavior.
- Browser file uploads cannot rely on Electron `webUtils.getPathForFile`.
- Ghostty native surfaces cannot work in Chrome and must remain optional.
- A local backend has filesystem/git/terminal privileges, so auth cannot be deferred.

---

## Completion Definition

The migration is complete when:

- Electron app works as before.
- Chrome can run Hive against the backend.
- Server owns all business logic.
- Renderer uses HTTP/WS client APIs.
- `src/preload/index.ts` exposes only desktop shell functionality.
- Old business IPC handlers are removed.
- Full verification suite passes.
