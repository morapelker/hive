# Phase 8 — Subscriptions (Sessions 77–87)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 8 implements all 8 GraphQL subscriptions that stream real-time events from the server to connected clients. These subscriptions use the `graphql-ws` protocol over WebSocket and are powered by the EventBus created in Phase 1. Each subscription is an async generator that listens to EventBus events and yields them to the client.

At the end of this phase, the GraphQL server is fully functional — all queries, mutations, and subscriptions are implemented. Phase 9 adds security/operations polish before the server is ready for production.

## Prerequisites

- Phases 1-7 completed: all infrastructure, EventBus, resolvers working.
- EventBus emitting all 8 event types from service files (Phase 1, Sessions 8-9).
- WebSocket server configured in `src/server/index.ts` (Phase 3, Session 20).
- `graphql-ws` `useServer()` wired to the WebSocket server.

## Key Source Files (Read-Only Reference)

| File | Purpose |
|------|---------|
| `src/server/event-bus.ts` | EventBus with all 8 typed event channels |
| `src/server/index.ts` | Server entry with WebSocket + `graphql-ws` setup |
| `src/server/schema/schema.graphql` | Subscription type definitions |
| `src/main/services/opencode-service.ts` | Emits `opencode:stream` events |
| `src/main/services/claude-code-implementer.ts` | Emits `opencode:stream` events |
| `src/main/services/worktree-watcher.ts` | Emits `git:statusChanged` |
| `src/main/services/branch-watcher.ts` | Emits `git:branchChanged` |
| `src/main/ipc/file-tree-handlers.ts` | Emits `file-tree:change` |
| `src/main/ipc/terminal-handlers.ts` | Emits `terminal:data`, `terminal:exit` |
| `src/main/services/script-runner.ts` | Emits `script:output` |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` | Desktop stream event handling (reference for mobile) |

## Architecture Notes

### Async Generator Pattern

Every subscription follows the same core pattern — an async generator that bridges EventBus events to GraphQL yields:

```typescript
subscribe: async function* (_parent, args, ctx) {
  const queue: EventType[] = []
  let resolve: (() => void) | null = null

  const listener = (...eventArgs) => {
    // Optional: filter by subscription arguments
    queue.push(transformEvent(eventArgs))
    resolve?.()
  }

  ctx.eventBus.on('channel-name', listener)
  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>(r => { resolve = r })
      }
      while (queue.length > 0) {
        yield { subscriptionFieldName: queue.shift()! }
      }
    }
  } finally {
    ctx.eventBus.off('channel-name', listener)
  }
}
```

Key properties:
- **Cleanup**: The `finally` block removes the listener when the client disconnects.
- **Backpressure**: Events queue up while the client processes the previous yield.
- **Filtering**: The listener can filter events based on subscription arguments before queueing.

### Event Channel Map

| EventBus Channel | GraphQL Subscription | Arguments |
|-----------------|---------------------|-----------|
| `opencode:stream` | `opencodeStream` | `sessionIds: [String!]` (optional filter) |
| `git:statusChanged` | `gitStatusChanged` | `worktreePath: String` (optional filter) |
| `git:branchChanged` | `gitBranchChanged` | `worktreePath: String` (optional filter) |
| `file-tree:change` | `fileTreeChange` | `worktreePath: String` (optional filter) |
| `terminal:data` | `terminalData` | `worktreeId: ID!` (required filter) |
| `terminal:exit` | `terminalExit` | `worktreeId: ID!` (required filter) |
| `script:output` | `scriptOutput` | `worktreeId: ID!`, `channel: String!` (required filters) |
| `worktree:branchRenamed` | `worktreeBranchRenamed` | (no filter) |

### Batching Strategy (OpenCode Stream)

AI streaming events fire at 10-50/sec during token generation. To reduce WebSocket frame overhead, the `opencodeStream` subscription accumulates events for 50ms before yielding a batch. This is implemented as a timer-based flush in Session 79.

---

## Session 77: OpenCode Stream Subscription — Core

**Goal:** Implement the core `opencodeStream` subscription that yields all AI streaming events.

**Definition of Done:** Subscribing to `opencodeStream` receives events emitted on the `opencode:stream` EventBus channel.

**Tasks:**

1. `[server]` Create `src/server/resolvers/subscription/opencode.resolvers.ts`:
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'

   export const opencodeSubscriptionResolvers: Resolvers = {
     Subscription: {
       opencodeStream: {
         subscribe: async function* (_parent, _args, ctx) {
           const queue: any[] = []
           let resolve: (() => void) | null = null

           const listener = (event: {
             type: string
             sessionId: string
             data: unknown
             childSessionId?: string
             statusPayload?: { type: string; attempt?: number; message?: string; next?: number }
           }) => {
             queue.push(event)
             resolve?.()
           }

           ctx.eventBus.on('opencode:stream', listener)
           try {
             while (true) {
               if (queue.length === 0) {
                 await new Promise<void>(r => { resolve = r })
               }
               while (queue.length > 0) {
                 yield { opencodeStream: queue.shift()! }
               }
             }
           } finally {
             ctx.eventBus.off('opencode:stream', listener)
           }
         }
       }
     }
   }
   ```

2. `[server]` Register in `src/server/resolvers/index.ts`.

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 78: OpenCode Stream Subscription — Session Filtering

**Goal:** Add `sessionIds` argument filtering to `opencodeStream`.

**Definition of Done:** When `sessionIds` is provided, only events for those sessions are yielded. When omitted, all events are yielded.

**Tasks:**

1. `[server]` Modify the listener in `opencodeSubscriptionResolvers` to filter by `sessionIds`:
   ```typescript
   opencodeStream: {
     subscribe: async function* (_parent, args, ctx) {
       const queue: any[] = []
       let resolve: (() => void) | null = null
       const sessionFilter = args.sessionIds
         ? new Set(args.sessionIds)
         : null

       const listener = (event) => {
         // If sessionIds argument provided, filter events
         if (sessionFilter && !sessionFilter.has(event.sessionId)) {
           return // Skip events for other sessions
         }
         queue.push(event)
         resolve?.()
       }

       ctx.eventBus.on('opencode:stream', listener)
       try {
         while (true) {
           if (queue.length === 0) {
             await new Promise<void>(r => { resolve = r })
           }
           while (queue.length > 0) {
             yield { opencodeStream: queue.shift()! }
           }
         }
       } finally {
         ctx.eventBus.off('opencode:stream', listener)
       }
     }
   }
   ```

   **Notes:**
   - `sessionIds` is optional. If `null`/`undefined`, yield ALL events (useful for monitoring all sessions).
   - If provided, only yield events whose `sessionId` is in the set.
   - The mobile app uses this to subscribe only to the currently visible session(s).

2. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 79: OpenCode Stream Subscription — Batching

**Goal:** Add 50ms event batching to reduce WebSocket frame overhead during rapid streaming.

**Definition of Done:** Events are accumulated for up to 50ms before yielding, reducing frame count by ~5x during active token generation.

**Tasks:**

1. `[server]` Modify the subscription to use timer-based batching:
   ```typescript
   opencodeStream: {
     subscribe: async function* (_parent, args, ctx) {
       const queue: any[] = []
       let resolve: (() => void) | null = null
       let batchTimer: ReturnType<typeof setTimeout> | null = null
       const BATCH_MS = 50
       const sessionFilter = args.sessionIds
         ? new Set(args.sessionIds)
         : null

       const flush = () => {
         batchTimer = null
         resolve?.()
       }

       const listener = (event) => {
         if (sessionFilter && !sessionFilter.has(event.sessionId)) return
         queue.push(event)
         // Start a batch timer if not already running
         if (!batchTimer) {
           batchTimer = setTimeout(flush, BATCH_MS)
         }
       }

       ctx.eventBus.on('opencode:stream', listener)
       try {
         while (true) {
           if (queue.length === 0) {
             await new Promise<void>(r => { resolve = r })
           }
           // Yield all accumulated events as individual yields
           // (batching reduces timer wakeups, not individual yields)
           while (queue.length > 0) {
             yield { opencodeStream: queue.shift()! }
           }
         }
       } finally {
         if (batchTimer) clearTimeout(batchTimer)
         ctx.eventBus.off('opencode:stream', listener)
       }
     }
   }
   ```

   **Notes:**
   - The batching timer groups event wakeups, not individual event delivery. Each event is still yielded individually to maintain GraphQL subscription semantics.
   - The 50ms window means at most 20 wakeups/sec instead of 50+ during rapid streaming.
   - The `finally` block clears the timer to prevent leaks on disconnect.

2. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 80: Git Status Subscription

**Goal:** Implement `gitStatusChanged` subscription.

**Definition of Done:** Subscribing to `gitStatusChanged` receives events when git status changes in watched worktrees.

**Tasks:**

1. `[server]` Create `src/server/resolvers/subscription/git.resolvers.ts`:
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'

   export const gitSubscriptionResolvers: Resolvers = {
     Subscription: {
       gitStatusChanged: {
         subscribe: async function* (_parent, args, ctx) {
           const queue: { worktreePath: string }[] = []
           let resolve: (() => void) | null = null

           const listener = (data: { worktreePath: string }) => {
             // Optional filtering by worktreePath
             if (args.worktreePath && data.worktreePath !== args.worktreePath) return
             queue.push(data)
             resolve?.()
           }

           ctx.eventBus.on('git:statusChanged', listener)
           try {
             while (true) {
               if (queue.length === 0) {
                 await new Promise<void>(r => { resolve = r })
               }
               while (queue.length > 0) {
                 yield { gitStatusChanged: queue.shift()! }
               }
             }
           } finally {
             ctx.eventBus.off('git:statusChanged', listener)
           }
         }
       }
     }
   }
   ```

   **Notes:**
   - `worktreePath` argument is optional. If provided, only events for that worktree path are yielded.
   - The mobile app subscribes with the currently visible worktree path to avoid unnecessary updates.
   - The event payload is simple: `{ worktreePath }`. The client re-fetches `gitFileStatuses` to get the updated status list.

2. `[server]` Register in `src/server/resolvers/index.ts`.

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 81: Git Branch Subscription

**Goal:** Implement `gitBranchChanged` subscription.

**Definition of Done:** Subscribing to `gitBranchChanged` receives events when the current branch changes in watched worktrees.

**Tasks:**

1. `[server]` Add `gitBranchChanged` to `src/server/resolvers/subscription/git.resolvers.ts`:
   ```typescript
   gitBranchChanged: {
     subscribe: async function* (_parent, args, ctx) {
       const queue: { worktreePath: string }[] = []
       let resolve: (() => void) | null = null

       const listener = (data: { worktreePath: string }) => {
         if (args.worktreePath && data.worktreePath !== args.worktreePath) return
         queue.push(data)
         resolve?.()
       }

       ctx.eventBus.on('git:branchChanged', listener)
       try {
         while (true) {
           if (queue.length === 0) {
             await new Promise<void>(r => { resolve = r })
           }
           while (queue.length > 0) {
             yield { gitBranchChanged: queue.shift()! }
           }
         }
       } finally {
         ctx.eventBus.off('git:branchChanged', listener)
       }
     }
   }
   ```

   Same pattern as `gitStatusChanged`. Optional `worktreePath` filter. Client re-fetches `gitBranchInfo` on event.

2. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 82: File Tree Subscription

**Goal:** Implement `fileTreeChange` subscription.

**Definition of Done:** Subscribing to `fileTreeChange` receives events when files change in watched directories.

**Tasks:**

1. `[server]` Create `src/server/resolvers/subscription/file-tree.resolvers.ts`:
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'

   export const fileTreeSubscriptionResolvers: Resolvers = {
     Subscription: {
       fileTreeChange: {
         subscribe: async function* (_parent, args, ctx) {
           const queue: any[] = []
           let resolve: (() => void) | null = null

           const listener = (event: {
             worktreePath: string
             eventType: string
             changedPath: string
             relativePath: string
           }) => {
             if (args.worktreePath && event.worktreePath !== args.worktreePath) return
             queue.push(event)
             resolve?.()
           }

           ctx.eventBus.on('file-tree:change', listener)
           try {
             while (true) {
               if (queue.length === 0) {
                 await new Promise<void>(r => { resolve = r })
               }
               while (queue.length > 0) {
                 yield { fileTreeChange: queue.shift()! }
               }
             }
           } finally {
             ctx.eventBus.off('file-tree:change', listener)
           }
         }
       }
     }
   }
   ```

   **Event payload:** `{ worktreePath, eventType, changedPath, relativePath }` — matches the `FileTreeChangeEvent` type in the SDL schema.

   **Notes:**
   - `eventType` values: `'add'`, `'change'`, `'unlink'`, `'addDir'`, `'unlinkDir'` (from chokidar watcher).
   - The client can use `eventType` to incrementally update the file tree without a full re-scan.

2. `[server]` Register in `src/server/resolvers/index.ts`.

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 83: Terminal Data Subscription

**Goal:** Implement `terminalData` subscription for streaming terminal output.

**Definition of Done:** Subscribing to `terminalData` with a `worktreeId` receives terminal output for that terminal.

**Tasks:**

1. `[server]` Create `src/server/resolvers/subscription/terminal.resolvers.ts`:
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'

   export const terminalSubscriptionResolvers: Resolvers = {
     Subscription: {
       terminalData: {
         subscribe: async function* (_parent, args, ctx) {
           const queue: { worktreeId: string; data: string }[] = []
           let resolve: (() => void) | null = null

           const listener = (worktreeId: string, data: string) => {
             // terminal:data emits two args: (worktreeId, data)
             // Only yield for the subscribed worktreeId
             if (worktreeId !== args.worktreeId) return
             queue.push({ worktreeId, data })
             resolve?.()
           }

           ctx.eventBus.on('terminal:data', listener)
           try {
             while (true) {
               if (queue.length === 0) {
                 await new Promise<void>(r => { resolve = r })
               }
               while (queue.length > 0) {
                 yield { terminalData: queue.shift()! }
               }
             }
           } finally {
             ctx.eventBus.off('terminal:data', listener)
           }
         }
       }
     }
   }
   ```

   **Notes:**
   - `worktreeId` is required (not optional) — each terminal subscription is tied to a specific terminal.
   - The EventBus `terminal:data` event has TWO arguments `(worktreeId, data)` — the listener destructures these.
   - In the desktop app, terminal data flows via dynamic IPC channels (`terminal:data:${worktreeId}`). The EventBus normalizes this to a single channel with worktreeId as a parameter.

2. `[server]` Register in `src/server/resolvers/index.ts`.

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 84: Terminal Exit Subscription

**Goal:** Implement `terminalExit` subscription.

**Definition of Done:** Subscribing to `terminalExit` with a `worktreeId` receives the exit event when that terminal closes.

**Tasks:**

1. `[server]` Add `terminalExit` to `src/server/resolvers/subscription/terminal.resolvers.ts`:
   ```typescript
   terminalExit: {
     subscribe: async function* (_parent, args, ctx) {
       const queue: { worktreeId: string; code: number }[] = []
       let resolve: (() => void) | null = null

       const listener = (worktreeId: string, code: number) => {
         if (worktreeId !== args.worktreeId) return
         queue.push({ worktreeId, code })
         resolve?.()
       }

       ctx.eventBus.on('terminal:exit', listener)
       try {
         while (true) {
           if (queue.length === 0) {
             await new Promise<void>(r => { resolve = r })
           }
           while (queue.length > 0) {
             yield { terminalExit: queue.shift()! }
           }
         }
       } finally {
         ctx.eventBus.off('terminal:exit', listener)
       }
     }
   }
   ```

   **Notes:**
   - This is typically a one-shot event — the terminal exits once. The subscription still uses the generator pattern for consistency.
   - The `code` field is the process exit code (0 = normal, non-zero = error).

2. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 85: Script Output Subscription

**Goal:** Implement `scriptOutput` subscription.

**Definition of Done:** Subscribing to `scriptOutput` with `worktreeId` and `channel` receives script output events.

**Tasks:**

1. `[server]` Create `src/server/resolvers/subscription/script.resolvers.ts`:
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'

   export const scriptSubscriptionResolvers: Resolvers = {
     Subscription: {
       scriptOutput: {
         subscribe: async function* (_parent, args, ctx) {
           const queue: any[] = []
           let resolve: (() => void) | null = null

           const listener = (channel: string, event: {
             type: string
             command?: string
             data?: string
             exitCode?: number
           }) => {
             // script:output emits two args: (channel, event)
             // Filter by the subscription's channel argument
             // The channel format is 'script:output:${worktreeId}:${scriptType}'
             // or it may be a simpler key. Match against args.channel.
             if (channel !== args.channel) return
             queue.push(event)
             resolve?.()
           }

           ctx.eventBus.on('script:output', listener)
           try {
             while (true) {
               if (queue.length === 0) {
                 await new Promise<void>(r => { resolve = r })
               }
               while (queue.length > 0) {
                 yield { scriptOutput: queue.shift()! }
               }
             }
           } finally {
             ctx.eventBus.off('script:output', listener)
           }
         }
       }
     }
   }
   ```

   **Notes:**
   - The `channel` argument identifies which script stream to listen to. In the desktop app, script output is sent on dynamic IPC channels (e.g., `script:output:wt-1:setup`, `script:output:wt-1:run`).
   - The EventBus emits `('script:output', channel, event)` where `channel` is the same dynamic channel key.
   - `ScriptOutputEvent` has `type: 'command-start' | 'output' | 'error' | 'done'`, plus optional `command`, `data`, `exitCode`.

2. `[server]` Register in `src/server/resolvers/index.ts`.

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 86: Worktree Branch Renamed Subscription

**Goal:** Implement `worktreeBranchRenamed` subscription.

**Definition of Done:** Subscribing receives events when a worktree branch is renamed.

**Tasks:**

1. `[server]` Create `src/server/resolvers/subscription/worktree.resolvers.ts`:
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'

   export const worktreeSubscriptionResolvers: Resolvers = {
     Subscription: {
       worktreeBranchRenamed: {
         subscribe: async function* (_parent, _args, ctx) {
           const queue: { worktreeId: string; newBranch: string }[] = []
           let resolve: (() => void) | null = null

           const listener = (data: { worktreeId: string; newBranch: string }) => {
             queue.push(data)
             resolve?.()
           }

           ctx.eventBus.on('worktree:branchRenamed', listener)
           try {
             while (true) {
               if (queue.length === 0) {
                 await new Promise<void>(r => { resolve = r })
               }
               while (queue.length > 0) {
                 yield { worktreeBranchRenamed: queue.shift()! }
               }
             }
           } finally {
             ctx.eventBus.off('worktree:branchRenamed', listener)
           }
         }
       }
     }
   }
   ```

   **Notes:**
   - No filtering arguments — this is a global event (branch renames are infrequent).
   - The mobile app uses this to update the worktree list when a branch name changes.

2. `[server]` Register in `src/server/resolvers/index.ts`.

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 87: Subscription Integration Tests

**Goal:** Integration tests for all 8 subscriptions using WebSocket clients.

**Definition of Done:** All subscriptions tested — events are received correctly, filtering works, cleanup happens on disconnect.

**Tasks:**

1. `[server]` Create `test/server/integration/subscriptions.test.ts`:
   ```typescript
   import { describe, it, expect, beforeEach, afterEach } from 'vitest'
   import { createClient } from 'graphql-ws'
   import WebSocket from 'ws'

   describe('Subscriptions', () => {
     // Test helper that creates a WS client connected to the test server
     let wsClient: ReturnType<typeof createClient>

     beforeEach(async () => {
       wsClient = createClient({
         url: testServerWsUrl,
         webSocketImpl: WebSocket,
         connectionParams: { apiKey: testApiKey }
       })
     })

     afterEach(() => {
       wsClient.dispose()
     })

     describe('opencodeStream', () => {
       it('receives all events when no sessionIds filter', async () => {
         const events: any[] = []
         const sub = wsClient.iterate({
           query: 'subscription { opencodeStream { type sessionId data } }'
         })

         // Emit test event on EventBus
         testEventBus.emit('opencode:stream', {
           type: 'message.created',
           sessionId: 'sess-1',
           data: { content: 'hello' }
         })

         const result = await sub.next()
         expect(result.value.data.opencodeStream.type).toBe('message.created')
         expect(result.value.data.opencodeStream.sessionId).toBe('sess-1')
       })

       it('filters events by sessionIds', async () => {
         const sub = wsClient.iterate({
           query: `subscription {
             opencodeStream(sessionIds: ["sess-1"]) {
               type sessionId
             }
           }`
         })

         // Emit for sess-2 (should be filtered out)
         testEventBus.emit('opencode:stream', {
           type: 'message.created',
           sessionId: 'sess-2',
           data: {}
         })

         // Emit for sess-1 (should be received)
         testEventBus.emit('opencode:stream', {
           type: 'message.created',
           sessionId: 'sess-1',
           data: {}
         })

         const result = await sub.next()
         expect(result.value.data.opencodeStream.sessionId).toBe('sess-1')
       })
     })

     describe('gitStatusChanged', () => {
       it('receives status change events', async () => {
         const sub = wsClient.iterate({
           query: `subscription {
             gitStatusChanged { worktreePath }
           }`
         })

         testEventBus.emit('git:statusChanged', { worktreePath: '/tmp/project/main' })

         const result = await sub.next()
         expect(result.value.data.gitStatusChanged.worktreePath).toBe('/tmp/project/main')
       })

       it('filters by worktreePath', async () => {
         const sub = wsClient.iterate({
           query: `subscription {
             gitStatusChanged(worktreePath: "/tmp/project/main") {
               worktreePath
             }
           }`
         })

         // Emit for different path (filtered)
         testEventBus.emit('git:statusChanged', { worktreePath: '/tmp/project/other' })

         // Emit for matching path
         testEventBus.emit('git:statusChanged', { worktreePath: '/tmp/project/main' })

         const result = await sub.next()
         expect(result.value.data.gitStatusChanged.worktreePath).toBe('/tmp/project/main')
       })
     })

     describe('gitBranchChanged', () => {
       it('receives branch change events', async () => {
         const sub = wsClient.iterate({
           query: 'subscription { gitBranchChanged { worktreePath } }'
         })

         testEventBus.emit('git:branchChanged', { worktreePath: '/tmp/project/main' })

         const result = await sub.next()
         expect(result.value.data.gitBranchChanged.worktreePath).toBe('/tmp/project/main')
       })
     })

     describe('fileTreeChange', () => {
       it('receives file change events', async () => {
         const sub = wsClient.iterate({
           query: `subscription {
             fileTreeChange { worktreePath eventType changedPath relativePath }
           }`
         })

         testEventBus.emit('file-tree:change', {
           worktreePath: '/tmp/project/main',
           eventType: 'change',
           changedPath: '/tmp/project/main/src/index.ts',
           relativePath: 'src/index.ts'
         })

         const result = await sub.next()
         expect(result.value.data.fileTreeChange.eventType).toBe('change')
         expect(result.value.data.fileTreeChange.relativePath).toBe('src/index.ts')
       })
     })

     describe('terminalData', () => {
       it('receives terminal output for subscribed worktreeId', async () => {
         const sub = wsClient.iterate({
           query: `subscription { terminalData(worktreeId: "wt-1") { worktreeId data } }`
         })

         testEventBus.emit('terminal:data', 'wt-1', 'Hello from terminal\n')

         const result = await sub.next()
         expect(result.value.data.terminalData.data).toBe('Hello from terminal\n')
       })

       it('does not receive output for other terminals', async () => {
         const sub = wsClient.iterate({
           query: `subscription { terminalData(worktreeId: "wt-1") { worktreeId data } }`
         })

         // Emit for wt-2 (should be filtered)
         testEventBus.emit('terminal:data', 'wt-2', 'Wrong terminal')

         // Emit for wt-1
         testEventBus.emit('terminal:data', 'wt-1', 'Right terminal')

         const result = await sub.next()
         expect(result.value.data.terminalData.data).toBe('Right terminal')
       })
     })

     describe('terminalExit', () => {
       it('receives exit event for subscribed terminal', async () => {
         const sub = wsClient.iterate({
           query: `subscription { terminalExit(worktreeId: "wt-1") { worktreeId code } }`
         })

         testEventBus.emit('terminal:exit', 'wt-1', 0)

         const result = await sub.next()
         expect(result.value.data.terminalExit.code).toBe(0)
       })
     })

     describe('scriptOutput', () => {
       it('receives script output for matching channel', async () => {
         const sub = wsClient.iterate({
           query: `subscription {
             scriptOutput(worktreeId: "wt-1", channel: "script:output:wt-1:run") {
               type data exitCode
             }
           }`
         })

         testEventBus.emit('script:output', 'script:output:wt-1:run', {
           type: 'output',
           data: 'Server started on port 3000'
         })

         const result = await sub.next()
         expect(result.value.data.scriptOutput.type).toBe('output')
         expect(result.value.data.scriptOutput.data).toBe('Server started on port 3000')
       })
     })

     describe('worktreeBranchRenamed', () => {
       it('receives branch rename events', async () => {
         const sub = wsClient.iterate({
           query: `subscription {
             worktreeBranchRenamed { worktreeId newBranch }
           }`
         })

         testEventBus.emit('worktree:branchRenamed', {
           worktreeId: 'wt-1',
           newBranch: 'feature/new-name'
         })

         const result = await sub.next()
         expect(result.value.data.worktreeBranchRenamed.worktreeId).toBe('wt-1')
         expect(result.value.data.worktreeBranchRenamed.newBranch).toBe('feature/new-name')
       })
     })

     describe('cleanup', () => {
       it('removes EventBus listener when client disconnects', async () => {
         const initialCount = testEventBus.listenerCount('opencode:stream')

         const sub = wsClient.iterate({
           query: 'subscription { opencodeStream { type } }'
         })
         // Start the subscription
         const pending = sub.next()

         // Wait briefly for subscription to register
         await new Promise(r => setTimeout(r, 50))
         expect(testEventBus.listenerCount('opencode:stream')).toBe(initialCount + 1)

         // Dispose client
         wsClient.dispose()
         await new Promise(r => setTimeout(r, 50))
         expect(testEventBus.listenerCount('opencode:stream')).toBe(initialCount)
       })
     })
   })
   ```

2. `[server]` Test infrastructure requirements:
   - Test server must expose a WebSocket URL alongside the HTTP URL
   - EventBus must be accessible in tests for emitting test events
   - API key authentication must work over WebSocket connectionParams
   - Use `graphql-ws` client library (same as production mobile client)

3. `[server]` Run tests:

**Verification:**
```bash
pnpm vitest run test/server/integration/subscriptions.test.ts && pnpm build
```

---

## Summary of Files Created

```
src/server/resolvers/subscription/
  opencode.resolvers.ts             — opencodeStream (with session filtering + 50ms batching)
  git.resolvers.ts                  — gitStatusChanged, gitBranchChanged
  file-tree.resolvers.ts            — fileTreeChange
  terminal.resolvers.ts             — terminalData, terminalExit
  script.resolvers.ts               — scriptOutput
  worktree.resolvers.ts             — worktreeBranchRenamed

test/server/integration/
  subscriptions.test.ts             — Integration tests for all 8 subscriptions
```

## Summary of Files Modified

| File | Change |
|------|--------|
| `src/server/resolvers/index.ts` | Import and merge all 6 subscription resolver modules |

## What Comes Next

Phase 9 (Security & Operations, Sessions 88-99) adds audit logging, auto-lock, kill switch, QR code pairing, key rotation, cert regeneration, PID/status files, and a comprehensive security test suite.
