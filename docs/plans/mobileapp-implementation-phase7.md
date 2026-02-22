# Phase 7 — Resolvers: Script, Terminal, Logging (Sessions 73–76)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 7 implements the remaining non-subscription resolvers: script execution, terminal management, and response logging. These are the final resolver domains before moving to subscriptions. Script resolvers wrap the `ScriptRunner` service and port assignment logic. Terminal resolvers wrap the `ptyService` for PTY lifecycle management. Logging resolvers wrap the response-log helpers used for session recording.

At the end of this phase, all query and mutation resolvers are complete. The only missing piece is subscriptions (Phase 8).

## Prerequisites

- Phases 1-6 completed: all infrastructure, DB resolvers, operation resolvers, and OpenCode AI resolvers working.
- `GraphQLContext` has `db`, `sdkManager`, `eventBus`.
- All query/mutation resolver patterns established (thin wrappers over existing services).
- Test infrastructure from Phase 4 (test-server helper, mock-db) available.

## Key Source Files (Read-Only Reference)

| File | Purpose |
|------|---------|
| `src/preload/index.ts` lines 1196-1243 | `scriptOps` IPC calls — runSetup, runProject, kill, runArchive, getPort |
| `src/preload/index.ts` lines 1288-1401 | `terminalOps` IPC calls — create, write, resize, destroy, onData, onExit |
| `src/preload/index.ts` lines 472-480 | `loggingOps` IPC calls — createResponseLog, appendResponseLog |
| `src/main/ipc/terminal-handlers.ts` | Terminal PTY management — create, write, resize, destroy handlers |
| `src/main/services/script-runner.ts` | `ScriptRunner` class — runSequential, runPersistent, kill, runAndWait |
| `src/main/services/pty-service.ts` | `ptyService` singleton — PTY lifecycle (create, write, resize, destroy) |
| `src/main/index.ts` lines 301-310 | Logging handler registration — createResponseLog, appendResponseLog |

## Architecture Notes

### Script Resolvers

Script resolvers are thin wrappers over the `ScriptRunner` service (instantiated in `src/main/index.ts`). The `ScriptRunner` manages child processes for setup scripts (sequential), run scripts (persistent/long-running), and archive scripts (run-and-wait). The port assignment is handled separately via the `port:get` IPC channel.

Script output events flow through the EventBus (`script:output` channel, added in Phase 1) and will be consumed by the `scriptOutput` subscription in Phase 8.

### Terminal Resolvers

The desktop app uses dynamic IPC channels for terminal data (`terminal:data:${worktreeId}`, `terminal:exit:${worktreeId}`). The EventBus normalizes these to flat keys with `worktreeId` as an argument: `eventBus.emit('terminal:data', worktreeId, data)`. GraphQL subscriptions (Phase 8) will filter by `worktreeId`.

`terminalOps.write` uses `ipcRenderer.send()` (fire-and-forget) in the desktop app because keystrokes don't need a response. The GraphQL mutation still returns `Boolean!` — it calls `ptyService.write()` synchronously and returns `true`.

### Logging Resolvers

The logging handlers are registered inline in `src/main/index.ts` (not in a separate handler file). They call `createResponseLog(sessionId)` and `appendResponseLog(filePath, data)` from the logger service. The GraphQL resolvers import and call these same functions directly.

---

## Session 73: Script Resolvers

**Goal:** Implement all script-related query and mutation resolvers.

**Definition of Done:** `scriptPort` query and `scriptRunSetup`, `scriptRunProject`, `scriptKill`, `scriptRunArchive` mutations work via GraphQL.

**Tasks:**

1. `[server]` Create `src/server/resolvers/query/script.resolvers.ts`:
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'

   export const scriptQueryResolvers: Resolvers = {
     Query: {
       scriptPort: async (_parent, { cwd }, ctx) => {
         // Same as ipcRenderer.invoke('port:get', { cwd })
         // Calls the port assignment service
         const result = await getPort(cwd)
         return result.port
       }
     }
   }
   ```

   The `scriptPort` query returns `Int` (nullable) — the assigned port number for a worktree path, or `null` if no port is assigned.

2. `[server]` Create `src/server/resolvers/mutation/script.resolvers.ts`:
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'
   import { scriptRunner } from '../../main/services/script-runner'

   export const scriptMutationResolvers: Resolvers = {
     Mutation: {
       scriptRunSetup: async (_parent, { input }, _ctx) => {
         try {
           const result = await scriptRunner.runSequential(
             input.commands,
             input.cwd,
             input.worktreeId
           )
           return { success: result.success, error: result.error }
         } catch (error) {
           return {
             success: false,
             error: error instanceof Error ? error.message : 'Unknown error'
           }
         }
       },

       scriptRunProject: async (_parent, { input }, _ctx) => {
         try {
           const result = await scriptRunner.runPersistent(
             input.commands,
             input.cwd,
             input.worktreeId
           )
           return { success: result.success, pid: result.pid, error: result.error }
         } catch (error) {
           return {
             success: false,
             error: error instanceof Error ? error.message : 'Unknown error'
           }
         }
       },

       scriptKill: async (_parent, { worktreeId }, _ctx) => {
         try {
           await scriptRunner.kill(worktreeId)
           return { success: true }
         } catch (error) {
           return {
             success: false,
             error: error instanceof Error ? error.message : 'Unknown error'
           }
         }
       },

       scriptRunArchive: async (_parent, { commands, cwd }, _ctx) => {
         try {
           const result = await scriptRunner.runAndWait(commands, cwd)
           return {
             success: result.success,
             output: result.output,
             error: result.error
           }
         } catch (error) {
           return {
             success: false,
             output: '',
             error: error instanceof Error ? error.message : 'Unknown error'
           }
         }
       }
     }
   }
   ```

3. `[server]` Register both resolver objects in `src/server/resolvers/index.ts` by importing and merging `scriptQueryResolvers` and `scriptMutationResolvers`.

4. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 74: Terminal Resolvers

**Goal:** Implement all terminal mutation resolvers.

**Definition of Done:** `terminalCreate`, `terminalWrite`, `terminalResize`, `terminalDestroy` mutations work via GraphQL.

**Tasks:**

1. `[server]` Create `src/server/resolvers/mutation/terminal.resolvers.ts`:
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'
   import { ptyService } from '../../main/services/pty-service'
   import { getEventBus } from '../../server/event-bus'

   export const terminalMutationResolvers: Resolvers = {
     Mutation: {
       terminalCreate: async (_parent, { worktreeId, cwd, shell }, _ctx) => {
         try {
           const { cols, rows } = ptyService.create(worktreeId, {
             cwd,
             shell: shell || undefined
           })

           // Wire PTY output to EventBus for GraphQL subscriptions.
           // In the desktop app, terminal-handlers.ts wires ptyService.onData
           // -> webContents.send + EventBus. For headless-only terminals
           // (created via GraphQL), we wire directly to EventBus here.
           ptyService.onData(worktreeId, (data) => {
             try {
               getEventBus().emit('terminal:data', worktreeId, data)
             } catch {}
           })
           ptyService.onExit(worktreeId, (code) => {
             try {
               getEventBus().emit('terminal:exit', worktreeId, code)
             } catch {}
           })

           return { success: true, cols, rows }
         } catch (error) {
           return {
             success: false,
             error: error instanceof Error ? error.message : 'Unknown error'
           }
         }
       },

       terminalWrite: async (_parent, { worktreeId, data }, _ctx) => {
         try {
           // ptyService.write is synchronous
           // (same as ipcMain.on('terminal:write') — fire-and-forget)
           ptyService.write(worktreeId, data)
           return true
         } catch {
           return false
         }
       },

       terminalResize: async (_parent, { worktreeId, cols, rows }, _ctx) => {
         try {
           ptyService.resize(worktreeId, cols, rows)
           return true
         } catch {
           return false
         }
       },

       terminalDestroy: async (_parent, { worktreeId }, _ctx) => {
         try {
           ptyService.destroy(worktreeId)
           return true
         } catch {
           return false
         }
       }
     }
   }
   ```

   **Important notes:**
   - `terminalWrite` calls `ptyService.write()` directly. In the desktop app, this is a fire-and-forget `ipcRenderer.send()`. The GraphQL mutation wraps it as a `Boolean!` return.
   - Terminal data flows BACK to the client via the `terminalData` subscription (Phase 8), not via the mutation response. The mutation only sends input TO the terminal.
   - `terminalCreate` wires `ptyService.onData` and `ptyService.onExit` to the EventBus so that GraphQL subscriptions receive terminal output even when the desktop IPC handlers are not active.

2. `[server]` Register `terminalMutationResolvers` in `src/server/resolvers/index.ts`.

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 75: Logging Resolvers

**Goal:** Implement logging mutation resolvers.

**Definition of Done:** `createResponseLog` and `appendResponseLog` mutations work via GraphQL.

**Tasks:**

1. `[server]` Create `src/server/resolvers/mutation/logging.resolvers.ts`:
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'
   import { createResponseLog, appendResponseLog } from '../../main/services/logger'

   export const loggingMutationResolvers: Resolvers = {
     Mutation: {
       createResponseLog: async (_parent, { sessionId }, _ctx) => {
         // Same as ipcMain.handle('logging:createResponseLog', ...)
         // Returns the file path of the newly created log file
         return createResponseLog(sessionId)
       },

       appendResponseLog: async (_parent, { filePath, data }, _ctx) => {
         // Same as ipcMain.handle('logging:appendResponseLog', ...)
         // Appends a JSON line to the log file
         appendResponseLog(filePath, data)
         return true
       }
     }
   }
   ```

   **Notes:**
   - `createResponseLog` returns a `String!` — the absolute file path of the created log file.
   - `appendResponseLog` takes a `JSON` scalar for the `data` parameter (arbitrary structured data) and returns `Boolean!`.
   - The logging handlers in the desktop app are registered inline in `src/main/index.ts` (lines 301-310). They call the same `createResponseLog` and `appendResponseLog` functions from the logger service.

2. `[server]` Register `loggingMutationResolvers` in `src/server/resolvers/index.ts`.

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 76: Script/Terminal/Logging Tests

**Goal:** Integration tests for all resolvers from sessions 73-75.

**Definition of Done:** All script, terminal, and logging resolver tests pass.

**Tasks:**

1. `[server]` Create `test/server/integration/script-terminal-logging.test.ts`:
   ```typescript
   import { describe, it, expect, beforeEach, vi } from 'vitest'

   describe('Script Resolvers', () => {
     it('scriptPort query returns number or null', async () => {
       const { data } = await execute(`
         query { scriptPort(cwd: "/tmp/test-project") }
       `)
       expect(data.scriptPort).toSatisfy(
         (v: unknown) => v === null || typeof v === 'number'
       )
     })

     it('scriptRunSetup mutation returns success', async () => {
       const { data } = await execute(`
         mutation {
           scriptRunSetup(input: {
             commands: ["echo hello"]
             cwd: "/tmp/test"
             worktreeId: "wt-1"
           }) { success error }
         }
       `)
       expect(data.scriptRunSetup.success).toBe(true)
     })

     it('scriptRunProject mutation returns success with pid', async () => {
       const { data } = await execute(`
         mutation {
           scriptRunProject(input: {
             commands: ["node server.js"]
             cwd: "/tmp/test"
             worktreeId: "wt-1"
           }) { success pid error }
         }
       `)
       expect(data.scriptRunProject.success).toBe(true)
       expect(typeof data.scriptRunProject.pid).toBe('number')
     })

     it('scriptKill mutation returns success', async () => {
       const { data } = await execute(`
         mutation { scriptKill(worktreeId: "wt-1") { success error } }
       `)
       expect(data.scriptKill.success).toBe(true)
     })

     it('scriptRunArchive mutation returns success with output', async () => {
       const { data } = await execute(`
         mutation {
           scriptRunArchive(commands: ["echo done"], cwd: "/tmp/test") {
             success output error
           }
         }
       `)
       expect(data.scriptRunArchive.success).toBe(true)
       expect(typeof data.scriptRunArchive.output).toBe('string')
     })
   })

   describe('Terminal Resolvers', () => {
     it('terminalCreate mutation returns success with cols/rows', async () => {
       const { data } = await execute(`
         mutation {
           terminalCreate(worktreeId: "wt-1", cwd: "/tmp/test") {
             success cols rows error
           }
         }
       `)
       expect(data.terminalCreate.success).toBe(true)
       expect(typeof data.terminalCreate.cols).toBe('number')
       expect(typeof data.terminalCreate.rows).toBe('number')
     })

     it('terminalWrite mutation returns true', async () => {
       const { data } = await execute(`
         mutation { terminalWrite(worktreeId: "wt-1", data: "ls\\n") }
       `)
       expect(data.terminalWrite).toBe(true)
     })

     it('terminalResize mutation returns true', async () => {
       const { data } = await execute(`
         mutation { terminalResize(worktreeId: "wt-1", cols: 120, rows: 40) }
       `)
       expect(data.terminalResize).toBe(true)
     })

     it('terminalDestroy mutation returns true', async () => {
       const { data } = await execute(`
         mutation { terminalDestroy(worktreeId: "wt-1") }
       `)
       expect(data.terminalDestroy).toBe(true)
     })
   })

   describe('Logging Resolvers', () => {
     it('createResponseLog mutation returns file path string', async () => {
       const { data } = await execute(`
         mutation { createResponseLog(sessionId: "sess-1") }
       `)
       expect(typeof data.createResponseLog).toBe('string')
       expect(data.createResponseLog).toContain('sess-1')
     })

     it('appendResponseLog mutation returns true', async () => {
       const { data } = await execute(`
         mutation {
           appendResponseLog(
             filePath: "/tmp/logs/sess-1.jsonl"
             data: { type: "response", content: "hello" }
           )
         }
       `)
       expect(data.appendResponseLog).toBe(true)
     })
   })
   ```

2. `[server]` Tests use mock services from `test/server/helpers/`:
   - Mock `scriptRunner` with predictable responses (success, pid, output)
   - Mock `ptyService` that records calls and returns default cols/rows
   - Mock `createResponseLog` / `appendResponseLog` from logger
   - All mocks are registered via `vi.mock()` or injected through the test server context

3. `[server]` Run tests:

**Verification:**
```bash
pnpm vitest run test/server/integration/script-terminal-logging.test.ts && pnpm build
```

---

## Summary of Files Created

```
src/server/resolvers/
  query/
    script.resolvers.ts             — scriptPort query resolver
  mutation/
    script.resolvers.ts             — scriptRunSetup, scriptRunProject, scriptKill, scriptRunArchive
    terminal.resolvers.ts           — terminalCreate, terminalWrite, terminalResize, terminalDestroy
    logging.resolvers.ts            — createResponseLog, appendResponseLog

test/server/
  integration/
    script-terminal-logging.test.ts — Integration tests for all Phase 7 resolvers
```

## Summary of Files Modified

| File | Change |
|------|--------|
| `src/server/resolvers/index.ts` | Import and merge script, terminal, and logging resolvers |

## What Comes Next

Phase 8 (Subscriptions, Sessions 77-87) implements all 8 GraphQL subscriptions using EventBus async generators: `opencodeStream`, `gitStatusChanged`, `gitBranchChanged`, `fileTreeChanged`, `scriptOutput`, `terminalData`, `terminalExit`, and `worktreeBranchRenamed`.
