# Phase 1 — Foundation (Sessions 1–10)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 1 lays the groundwork for the GraphQL server by installing dependencies, creating directory structures, extracting shared types from the existing codebase, and building the EventBus that bridges service-layer events to GraphQL subscriptions. At the end of this phase, the existing desktop app must be completely unaffected — all tests pass, build succeeds, and the EventBus silently emits events alongside the existing `webContents.send()` calls.

## Prerequisites

- None — this is the first phase.
- Familiarity with the existing codebase architecture (three-process Electron model: `src/main/`, `src/preload/`, `src/renderer/`).

## Key Source Files (Read-Only Reference)

| File | Purpose |
|------|---------|
| `src/preload/index.d.ts` | **Source of truth for all shared types** — Project (lines 30-45), Worktree (47-63), Session (65-81), Setting (82-86), Space (118-130), Connection (2-28), GitFileStatus (1107-1112), GitBranchInfo (1118-1123), OpenCodeStreamEvent (1062-1075), FileTreeNode (1078-1086), FlatFile (1089-1094), FileTreeChangeEvent (1097-1102), ScriptOutputEvent (1028-1033), DetectedApp (1125-1131), PermissionRequest (1048-1059), OpenCodeCommand (1036-1045), MessagePart (1023-1025), GitStatusCode (1105), GitDiffStatFile (1015-1020), GitStatusChangedEvent (1114-1116) |
| `src/main/services/opencode-service.ts` | Contains `sendToRenderer` helper at ~line 1264. Sends on channels: `'opencode:stream'` and `'worktree:branchRenamed'`. |
| `src/main/services/claude-code-implementer.ts` | Contains `sendToRenderer` at ~line 2319. Same channels as opencode-service. |
| `src/main/services/worktree-watcher.ts` | `emitGitStatusChanged` at line 88: `mainWindow.webContents.send('git:statusChanged', { worktreePath })` |
| `src/main/services/branch-watcher.ts` | `emitBranchChanged` at line 54: `mainWindow.webContents.send('git:branchChanged', { worktreePath })` |
| `src/main/ipc/file-tree-handlers.ts` | Debounced `webContents.send('file-tree:change', ...)` at ~line 274 |
| `src/main/ipc/git-file-handlers.ts` | `webContents.send('git:statusChanged', ...)` at ~line 589 (after PR merge) |
| `src/main/services/script-runner.ts` | `sendEvent` at line 135: `this.mainWindow.webContents.send(eventKey, event)`. Dynamic channels: `'script:setup:{worktreeId}'`, `'script:run:{worktreeId}'` |
| `src/main/ipc/terminal-handlers.ts` | `terminal:data:{worktreeId}` at line 68, `terminal:exit:{worktreeId}` at line 77 |
| `package.json` | Current dependencies — see what's already installed |

## Architecture Notes

The EventBus is a typed Node.js `EventEmitter` that serves as the bridge between existing service-layer events and future GraphQL subscriptions. Today, services push events to the renderer via `mainWindow.webContents.send(channel, data)`. After this phase, they'll ALSO emit to the EventBus: `getEventBus().emit(channel, data)`. The existing `webContents.send` calls remain UNCHANGED.

The shared types are extracted from `src/preload/index.d.ts` into `src/shared/types/` so both the main process (GraphQL resolvers) and the future React Native app can import them without depending on Electron's preload layer.

---

## Session 1: Server Dependencies

**Goal:** Install all production and dev dependencies needed for the GraphQL server.

**Definition of Done:** All packages installed, `pnpm build` succeeds, `pnpm test` still passes with zero new failures.

**Tasks:**

1. `[server]` Install production dependencies:
   ```bash
   pnpm add graphql graphql-yoga graphql-ws ws qrcode-terminal
   ```
2. `[server]` Install dev dependencies:
   ```bash
   pnpm add -D @graphql-codegen/cli @graphql-codegen/typescript @graphql-codegen/typescript-resolvers @types/ws
   ```
3. `[server]` Run `pnpm build` — verify it succeeds with no errors
4. `[server]` Run `pnpm test` — verify all existing tests still pass

**Verification:**
```bash
pnpm build && pnpm test
```

---

## Session 2: Directory Scaffolding

**Goal:** Create all empty directory structures for the server and shared code.

**Definition of Done:** All directories exist. `pnpm build` still succeeds.

**Tasks:**

1. `[server]` Create `src/server/` directory
2. `[server]` Create `src/server/schema/` and `src/server/schema/types/`
3. `[server]` Create `src/server/resolvers/`, `src/server/resolvers/query/`, `src/server/resolvers/mutation/`, `src/server/resolvers/subscription/`
4. `[server]` Create `src/server/plugins/`
5. `[server]` Create `src/server/__generated__/` (codegen output)
6. `[server]` Create `src/shared/`, `src/shared/types/`, `src/shared/lib/`
7. `[server]` Run `pnpm build` — verify scaffolding doesn't break anything

**Verification:**
```bash
ls -la src/server/ src/shared/ && pnpm build
```

---

## Session 3: Shared Types — Entities

**Goal:** Extract Project, Worktree, Session, Space, and Connection types from `src/preload/index.d.ts` into `src/shared/types/`.

**Definition of Done:** Types extracted into individual files, compile cleanly, existing code unaffected.

**Source of truth:** `src/preload/index.d.ts`

**Tasks:**

1. `[server]` Create `src/shared/types/project.ts` — export `Project` interface (extracted from `index.d.ts` lines 30-45):
   ```typescript
   export interface Project {
     id: string
     name: string
     path: string
     description: string | null
     tags: string | null
     language: string | null
     custom_icon: string | null
     setup_script: string | null
     run_script: string | null
     archive_script: string | null
     auto_assign_port: boolean
     sort_order: number
     created_at: string
     last_accessed_at: string
   }
   ```

2. `[server]` Create `src/shared/types/worktree.ts` — export `Worktree` interface (lines 47-63):
   ```typescript
   export interface Worktree {
     id: string
     project_id: string
     name: string
     branch_name: string
     path: string
     status: 'active' | 'archived'
     is_default: boolean
     branch_renamed: number
     last_message_at: number | null
     session_titles: string
     last_model_provider_id: string | null
     last_model_id: string | null
     last_model_variant: string | null
     created_at: string
     last_accessed_at: string
   }
   ```

3. `[server]` Create `src/shared/types/session.ts` — export `Session`, `SessionWithWorktree`, `SessionSearchOptions` interfaces (lines 65-101):
   ```typescript
   export interface Session {
     id: string
     worktree_id: string | null
     project_id: string
     connection_id: string | null
     name: string | null
     status: 'active' | 'completed' | 'error'
     opencode_session_id: string | null
     agent_sdk: 'opencode' | 'claude-code'
     mode: 'build' | 'plan'
     model_provider_id: string | null
     model_id: string | null
     model_variant: string | null
     created_at: string
     updated_at: string
     completed_at: string | null
   }

   export interface SessionWithWorktree extends Session {
     worktree_name?: string
     worktree_branch_name?: string
     project_name?: string
   }

   export interface SessionSearchOptions {
     keyword?: string
     project_id?: string
     worktree_id?: string
     dateFrom?: string
     dateTo?: string
     includeArchived?: boolean
   }
   ```

4. `[server]` Create `src/shared/types/space.ts` — export `Space` and `ProjectSpaceAssignment` (lines 118-130):
   ```typescript
   export interface Space {
     id: string
     name: string
     icon_type: string
     icon_value: string
     sort_order: number
     created_at: string
   }

   export interface ProjectSpaceAssignment {
     project_id: string
     space_id: string
   }
   ```

5. `[server]` Create `src/shared/types/connection.ts` — export `Connection`, `ConnectionMember`, `ConnectionWithMembers` interfaces (lines 2-28):
   ```typescript
   export interface Connection {
     id: string
     name: string
     status: 'active' | 'archived'
     path: string
     color: string | null
     created_at: string
     updated_at: string
   }

   export interface ConnectionMember {
     id: string
     connection_id: string
     worktree_id: string
     project_id: string
     symlink_name: string
     added_at: string
   }

   export interface ConnectionWithMembers extends Connection {
     members: (ConnectionMember & {
       worktree_name: string
       worktree_branch: string
       worktree_path: string
       project_name: string
     })[]
   }
   ```

6. `[server]` Verify all compile: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 4: Shared Types — Domain

**Goal:** Extract all domain-specific types (Git, OpenCode, FileTree, Script, Terminal, Settings).

**Definition of Done:** All domain types extracted, compile cleanly.

**Source of truth:** `src/preload/index.d.ts`

**Tasks:**

1. `[server]` Create `src/shared/types/git.ts`:
   ```typescript
   export type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'C' | ''

   export interface GitFileStatus {
     path: string
     relativePath: string
     status: GitStatusCode
     staged: boolean
   }

   export interface GitStatusChangedEvent {
     worktreePath: string
   }

   export interface GitBranchInfo {
     name: string
     tracking: string | null
     ahead: number
     behind: number
   }

   export interface GitDiffStatFile {
     path: string
     additions: number
     deletions: number
     binary: boolean
   }
   ```

2. `[server]` Create `src/shared/types/opencode.ts`:
   ```typescript
   export interface OpenCodeStreamEvent {
     type: string
     sessionId: string
     data: unknown
     childSessionId?: string
     statusPayload?: {
       type: 'idle' | 'busy' | 'retry'
       attempt?: number
       message?: string
       next?: number
     }
   }

   export interface OpenCodeCommand {
     name: string
     description?: string
     template: string
     agent?: string
     model?: string
     source?: 'command' | 'mcp' | 'skill'
     subtask?: boolean
     hints?: string[]
   }

   export interface PermissionRequest {
     id: string
     sessionID: string
     permission: string
     patterns: string[]
     metadata: Record<string, unknown>
     always: string[]
     tool?: {
       messageID: string
       callID: string
     }
   }

   export type MessagePart =
     | { type: 'text'; text: string }
     | { type: 'file'; mime: string; url: string; filename?: string }
   ```

3. `[server]` Create `src/shared/types/file-tree.ts`:
   ```typescript
   export interface FileTreeNode {
     name: string
     path: string
     relativePath: string
     isDirectory: boolean
     isSymlink?: boolean
     extension: string | null
     children?: FileTreeNode[]
   }

   export interface FlatFile {
     name: string
     path: string
     relativePath: string
     extension: string | null
   }

   export interface FileTreeChangeEvent {
     worktreePath: string
     eventType: 'add' | 'addDir' | 'unlink' | 'unlinkDir' | 'change'
     changedPath: string
     relativePath: string
   }
   ```

4. `[server]` Create `src/shared/types/script.ts`:
   ```typescript
   export interface ScriptOutputEvent {
     type: 'command-start' | 'output' | 'error' | 'done'
     command?: string
     data?: string
     exitCode?: number
   }
   ```

5. `[server]` Create `src/shared/types/terminal.ts`:
   ```typescript
   export interface GhosttyTerminalConfig {
     fontFamily?: string
     fontSize?: number
     background?: string
     foreground?: string
     cursorStyle?: 'block' | 'bar' | 'underline'
     cursorColor?: string
     shell?: string
     scrollbackLimit?: number
     palette?: Record<number, string>
     selectionBackground?: string
     selectionForeground?: string
   }
   ```

6. `[server]` Create `src/shared/types/settings.ts`:
   ```typescript
   export interface Setting {
     key: string
     value: string
   }

   export interface DetectedApp {
     id: string
     name: string
     command: string
     available: boolean
   }
   ```

**Verification:**
```bash
pnpm build
```

---

## Session 5: Shared Types — Barrel Export

**Goal:** Create barrel export and verify all types are importable from a single path.

**Definition of Done:** `import { Project, Worktree, Session, ... } from '../shared/types'` works.

**Tasks:**

1. `[server]` Create `src/shared/types/index.ts` — re-export all types from each domain file:
   ```typescript
   export * from './project'
   export * from './worktree'
   export * from './session'
   export * from './space'
   export * from './connection'
   export * from './git'
   export * from './opencode'
   export * from './file-tree'
   export * from './script'
   export * from './terminal'
   export * from './settings'
   ```
2. `[server]` Verify barrel compiles: `pnpm build`
3. `[server]` Run `pnpm test` — confirm zero regressions.

**Verification:**
```bash
pnpm build && pnpm test
```

---

## Session 6: EventBus — Core

**Goal:** Create the typed EventBus that bridges service events to GraphQL subscriptions.

**Definition of Done:** EventBus class with typed event map, singleton getter, compile clean.

**Tasks:**

1. `[server]` Create `src/server/event-bus.ts` with:
   - `EventBusEvents` interface mapping all 8 event channels to their argument tuples:
     - `'opencode:stream'` -> `[event: OpenCodeStreamEvent]` (from shared types)
     - `'worktree:branchRenamed'` -> `[data: { worktreeId: string; newBranch: string }]`
     - `'git:statusChanged'` -> `[data: { worktreePath: string }]`
     - `'git:branchChanged'` -> `[data: { worktreePath: string }]`
     - `'file-tree:change'` -> `[event: FileTreeChangeEvent]` (from shared types)
     - `'script:output'` -> `[channel: string, event: ScriptOutputEvent]` (from shared types)
     - `'terminal:data'` -> `[worktreeId: string, data: string]`
     - `'terminal:exit'` -> `[worktreeId: string, code: number]`
   - `EventBus` class wrapping Node.js `EventEmitter` with typed `emit`, `on`, `off`, `removeAllListeners` methods
   - `getEventBus()` singleton getter
   - `resetEventBus()` for test cleanup

   Example implementation sketch:
   ```typescript
   import { EventEmitter } from 'events'
   import type { OpenCodeStreamEvent, FileTreeChangeEvent, ScriptOutputEvent } from '../shared/types'

   interface EventBusEvents {
     'opencode:stream': [event: OpenCodeStreamEvent]
     'worktree:branchRenamed': [data: { worktreeId: string; newBranch: string }]
     'git:statusChanged': [data: { worktreePath: string }]
     'git:branchChanged': [data: { worktreePath: string }]
     'file-tree:change': [event: FileTreeChangeEvent]
     'script:output': [channel: string, event: ScriptOutputEvent]
     'terminal:data': [worktreeId: string, data: string]
     'terminal:exit': [worktreeId: string, code: number]
   }

   export class EventBus {
     private emitter = new EventEmitter()

     emit<K extends keyof EventBusEvents>(event: K, ...args: EventBusEvents[K]): void {
       this.emitter.emit(event, ...args)
     }

     on<K extends keyof EventBusEvents>(event: K, listener: (...args: EventBusEvents[K]) => void): void {
       this.emitter.on(event, listener as (...args: unknown[]) => void)
     }

     off<K extends keyof EventBusEvents>(event: K, listener: (...args: EventBusEvents[K]) => void): void {
       this.emitter.off(event, listener as (...args: unknown[]) => void)
     }

     removeAllListeners(event?: keyof EventBusEvents): void {
       if (event) this.emitter.removeAllListeners(event)
       else this.emitter.removeAllListeners()
     }
   }

   let instance: EventBus | null = null

   export function getEventBus(): EventBus {
     if (!instance) instance = new EventBus()
     return instance
   }

   export function resetEventBus(): void {
     instance?.removeAllListeners()
     instance = null
   }
   ```

2. `[server]` Verify it compiles: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 7: EventBus — Unit Tests

**Goal:** Unit tests for the EventBus class.

**Definition of Done:** All event types tested, on/off/emit verified, removeAllListeners verified.

**Tasks:**

1. `[server]` Create `test/server/event-bus.test.ts` with tests:
   - Emits and receives `opencode:stream` events with correct shape
   - Emits and receives `terminal:data` events with two arguments (worktreeId, data)
   - Emits and receives `script:output` events with two arguments (channel, event)
   - Emits and receives `git:statusChanged` events
   - `off()` removes a specific listener (emit after off -> not received)
   - `removeAllListeners()` clears all listeners for all events
   - Multiple listeners on same event all receive the event
   - Listeners for different events don't interfere
   - `resetEventBus()` creates a fresh instance

2. `[server]` Run tests: `pnpm vitest run test/server/event-bus.test.ts` — all pass.

**Verification:**
```bash
pnpm vitest run test/server/event-bus.test.ts
```

**Note:** Tests should use the Vitest framework (already configured in the project). Import `{ describe, it, expect, beforeEach }` from `vitest`.

---

## Session 8: EventBus — Service Integration (OpenCode + Claude)

**Goal:** Add EventBus emission to the two AI service files that use `sendToRenderer`.

**Definition of Done:** `opencode-service.ts` and `claude-code-implementer.ts` emit to EventBus alongside `webContents.send`, zero changes to existing behavior.

**Files to modify:**
- `src/main/services/opencode-service.ts` — `sendToRenderer` method at ~line 1264
- `src/main/services/claude-code-implementer.ts` — `sendToRenderer` method at ~line 2319

**How it works today:** Both files have a `sendToRenderer(channel, data)` helper that calls `this.mainWindow?.webContents.send(channel, data)`. The channels used are:
- `'opencode:stream'` — AI streaming events
- `'worktree:branchRenamed'` — when AI renames a branch

**Tasks:**

1. `[server]` Modify `src/main/services/opencode-service.ts`:
   - Add import at top of file: `import { getEventBus } from '../../server/event-bus'`
   - In `sendToRenderer` method, AFTER the existing `this.mainWindow?.webContents.send(channel, data)` line, add:
     ```typescript
     try {
       const bus = getEventBus()
       if (channel === 'opencode:stream') bus.emit('opencode:stream', data)
       else if (channel === 'worktree:branchRenamed') bus.emit('worktree:branchRenamed', data)
     } catch {
       // EventBus not available — silently ignore (desktop-only mode)
     }
     ```
   - This adds ~5 lines. The existing `webContents.send` call is UNCHANGED.

2. `[server]` Modify `src/main/services/claude-code-implementer.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - In `sendToRenderer` method, AFTER the existing `webContents.send` line, add the same EventBus emission pattern.
   - This adds ~5 lines. The existing behavior is UNCHANGED.

3. `[server]` Run `pnpm build` — verify no compile errors.
4. `[server]` Run `pnpm test` — verify zero regressions.

**Verification:**
```bash
pnpm build && pnpm test
```

---

## Session 9: EventBus — Handler Integration (Git, FileTree, Terminal, Script)

**Goal:** Add EventBus emission to the remaining 6 files that send events to the renderer.

**Definition of Done:** All push-event sites in the codebase also emit to EventBus.

**Files to modify:**

| File | Location | Channel |
|------|----------|---------|
| `src/main/services/worktree-watcher.ts` | `emitGitStatusChanged` at line 88 | `git:statusChanged` |
| `src/main/services/branch-watcher.ts` | `emitBranchChanged` at line 54 | `git:branchChanged` |
| `src/main/ipc/file-tree-handlers.ts` | Debounced send at ~line 274 | `file-tree:change` |
| `src/main/ipc/git-file-handlers.ts` | send at ~line 589 | `git:statusChanged` |
| `src/main/services/script-runner.ts` | `sendEvent` at line 135 | `script:output` |
| `src/main/ipc/terminal-handlers.ts` | lines 68, 77 | `terminal:data`, `terminal:exit` |

**Tasks:**

1. `[server]` Modify `src/main/services/worktree-watcher.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - In `emitGitStatusChanged` function (line 88-91), after the `mainWindow.webContents.send('git:statusChanged', { worktreePath })` line, add:
     ```typescript
     try { getEventBus().emit('git:statusChanged', { worktreePath }) } catch {}
     ```

2. `[server]` Modify `src/main/services/branch-watcher.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - In `emitBranchChanged` function (line 54-57), after the `mainWindow.webContents.send` line, add:
     ```typescript
     try { getEventBus().emit('git:branchChanged', { worktreePath }) } catch {}
     ```

3. `[server]` Modify `src/main/ipc/file-tree-handlers.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - After the `mainWindow?.webContents.send('file-tree:change', ...)` at ~line 274, add:
     ```typescript
     try { getEventBus().emit('file-tree:change', eventPayload) } catch {}
     ```
     Where `eventPayload` matches the `FileTreeChangeEvent` shape: `{ worktreePath, eventType, changedPath, relativePath }`.

4. `[server]` Modify `src/main/ipc/git-file-handlers.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - After the `webContents.send('git:statusChanged', ...)` at ~line 589, add:
     ```typescript
     try { getEventBus().emit('git:statusChanged', { worktreePath }) } catch {}
     ```

5. `[server]` Modify `src/main/services/script-runner.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - In `sendEvent` method (line 135-138), after the `this.mainWindow.webContents.send(eventKey, event)` line, add:
     ```typescript
     try { getEventBus().emit('script:output', eventKey, event) } catch {}
     ```

6. `[server]` Modify `src/main/ipc/terminal-handlers.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - In the `onData` handler (around line 67-69), after `mainWindow.webContents.send(\`terminal:data:${worktreeId}\`, buffered)`, add:
     ```typescript
     try { getEventBus().emit('terminal:data', worktreeId, buffered) } catch {}
     ```
   - In the `onExit` handler (around line 76-78), after `mainWindow.webContents.send(\`terminal:exit:${worktreeId}\`, code)`, add:
     ```typescript
     try { getEventBus().emit('terminal:exit', worktreeId, code) } catch {}
     ```

7. `[server]` Run `pnpm build` — verify no compile errors.

**Verification:**
```bash
pnpm build
```

**Important notes:**
- Wrap all EventBus calls in `try/catch {}` to prevent errors if the EventBus module fails to load (e.g., in test environments).
- The `webContents.send` calls must remain UNCHANGED.
- Terminal channels are dynamic (`terminal:data:${worktreeId}`), but the EventBus uses flat `terminal:data` with worktreeId as the first argument. This is intentional — the GraphQL subscription layer will filter by worktreeId.

---

## Session 10: EventBus — Regression Check

**Goal:** Full regression test to confirm EventBus integration didn't break anything.

**Definition of Done:** All existing tests pass, build succeeds, lint clean.

**Tasks:**

1. `[server]` Run `pnpm test` — ALL existing tests pass.
2. `[server]` Run `pnpm lint` — no new lint errors.
3. `[server]` Run `pnpm build` — production build succeeds.

**Verification:**
```bash
pnpm test && pnpm lint && pnpm build
```

---

## Summary of Files Created

```
src/shared/
  types/
    index.ts          — barrel export
    project.ts        — Project interface
    worktree.ts       — Worktree interface
    session.ts        — Session, SessionWithWorktree, SessionSearchOptions
    space.ts          — Space, ProjectSpaceAssignment
    connection.ts     — Connection, ConnectionMember, ConnectionWithMembers
    git.ts            — GitStatusCode, GitFileStatus, GitStatusChangedEvent, GitBranchInfo, GitDiffStatFile
    opencode.ts       — OpenCodeStreamEvent, OpenCodeCommand, PermissionRequest, MessagePart
    file-tree.ts      — FileTreeNode, FlatFile, FileTreeChangeEvent
    script.ts         — ScriptOutputEvent
    terminal.ts       — GhosttyTerminalConfig
    settings.ts       — Setting, DetectedApp

src/server/
  event-bus.ts        — EventBus class + singleton
  schema/             — (empty, ready for Phase 2)
    types/            — (empty)
  resolvers/          — (empty, ready for Phase 4)
    query/            — (empty)
    mutation/         — (empty)
    subscription/     — (empty)
  plugins/            — (empty, ready for Phase 3)
  __generated__/      — (empty, ready for Phase 2)

test/server/
  event-bus.test.ts   — EventBus unit tests
```

## Summary of Files Modified

| File | Lines Changed | What |
|------|--------------|------|
| `package.json` | ~3 | Add 5 prod deps + 4 dev deps |
| `src/main/services/opencode-service.ts` | ~5 | Import EventBus + emit in sendToRenderer |
| `src/main/services/claude-code-implementer.ts` | ~5 | Import EventBus + emit in sendToRenderer |
| `src/main/services/worktree-watcher.ts` | ~2 | Import EventBus + emit in emitGitStatusChanged |
| `src/main/services/branch-watcher.ts` | ~2 | Import EventBus + emit in emitBranchChanged |
| `src/main/ipc/file-tree-handlers.ts` | ~2 | Import EventBus + emit in debounced send |
| `src/main/ipc/git-file-handlers.ts` | ~2 | Import EventBus + emit after PR merge |
| `src/main/services/script-runner.ts` | ~2 | Import EventBus + emit in sendEvent |
| `src/main/ipc/terminal-handlers.ts` | ~3 | Import EventBus + emit data + exit |

**Total: ~26 lines modified across 9 existing files.**

## What Comes Next

Phase 2 (SDL Schema) will define the complete GraphQL schema in `.graphql` files, using the shared types as a reference for field names and types.
