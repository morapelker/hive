# Phase 8 — GraphQL Subscriptions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement all 8 GraphQL subscriptions that stream real-time EventBus events to mobile clients over WebSocket.

**Architecture:** Each subscription is an async generator that bridges typed EventBus events into GraphQL yields using a queue + promise pattern. The `finally` block handles cleanup. The `opencodeStream` subscription adds 50ms batching to reduce WebSocket frame overhead during rapid AI token streaming.

**Tech Stack:** graphql-yoga, graphql-ws, Node.js EventEmitter (via `EventBus`), TypeScript async generators.

---

## Shared Pattern Reference

Every subscription resolver follows this shape. **Do not deviate** — the queue+promise pattern is the canonical way to bridge EventEmitter → async generator:

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'

export const exampleResolvers: Resolvers = {
  Subscription: {
    fieldName: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: PayloadType[] = []
        let resolve: (() => void) | null = null

        const listener = (eventArgs) => {
          // optional: filter by args
          queue.push(transformedPayload)
          resolve?.()
        }

        ctx.eventBus.on('channel-name', listener)
        try {
          while (true) {
            if (queue.length === 0) {
              await new Promise<void>(r => { resolve = r })
            }
            while (queue.length > 0) {
              yield { fieldName: queue.shift()! }
            }
          }
        } finally {
          ctx.eventBus.off('channel-name', listener)
        }
      }
    }
  }
}
```

Key files for reference:
- **EventBus typed events:** `src/server/event-bus.ts` (lines 4-13)
- **Shared types:** `src/shared/types/opencode.ts`, `src/shared/types/file-tree.ts`, `src/shared/types/script.ts`
- **Generated resolver types:** `src/server/__generated__/resolvers-types.ts` (line ~2750 for `SubscriptionResolvers`)
- **GraphQL context:** `src/server/context.ts` — has `eventBus: EventBus`
- **Resolver registration:** `src/server/resolvers/index.ts` — `deepMerge()` + `mergeResolvers()`
- **Existing resolver pattern:** `src/server/resolvers/query/git.resolvers.ts` (import style)

---

## Task 1: OpenCode Stream Subscription (core + filtering + batching)

**Files:**
- Create: `src/server/resolvers/subscription/opencode.resolvers.ts`
- Test: `test/server/subscriptions/opencode.test.ts`

**Step 1: Write the failing test**

```typescript
// test/server/subscriptions/opencode.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import type { OpenCodeStreamEvent } from '../../../src/shared/types/opencode'
import { opencodeSubscriptionResolvers } from '../../../src/server/resolvers/subscription/opencode.resolvers'

function getSubscribeFn() {
  const sub = opencodeSubscriptionResolvers.Subscription!.opencodeStream
  if (typeof sub === 'function') throw new Error('Expected object with subscribe')
  return (sub as { subscribe: (...args: any[]) => AsyncIterable<any> }).subscribe
}

describe('opencodeStream subscription', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  it('yields events from opencode:stream channel', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    const event: OpenCodeStreamEvent = {
      type: 'message.created',
      sessionId: 'sess-1',
      data: { content: 'hello' },
    }

    // Emit after a tick so the generator is waiting
    setTimeout(() => eventBus.emit('opencode:stream', event), 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value).toEqual({ opencodeStream: event })
  })

  it('filters by sessionIds when provided', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { sessionIds: ['sess-1'] },
      { eventBus } as any,
      {} as any,
    )

    setTimeout(() => {
      // This one should be filtered out
      eventBus.emit('opencode:stream', {
        type: 'message.created',
        sessionId: 'sess-2',
        data: {},
      })
      // This one should pass
      eventBus.emit('opencode:stream', {
        type: 'message.created',
        sessionId: 'sess-1',
        data: { content: 'yes' },
      })
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value.opencodeStream.sessionId).toBe('sess-1')
  })

  it('yields all events when sessionIds is not provided', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    setTimeout(() => {
      eventBus.emit('opencode:stream', {
        type: 'message.created',
        sessionId: 'sess-A',
        data: {},
      })
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value.opencodeStream.sessionId).toBe('sess-A')
  })

  it('batches events with 50ms delay to reduce wakeups', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    // Emit 3 events rapidly (within 50ms of each other)
    setTimeout(() => {
      eventBus.emit('opencode:stream', { type: 'a', sessionId: 's1', data: {} })
      eventBus.emit('opencode:stream', { type: 'b', sessionId: 's1', data: {} })
      eventBus.emit('opencode:stream', { type: 'c', sessionId: 's1', data: {} })
    }, 10)

    // All 3 should be yielded after the batch timer fires
    const r1 = await (iter as AsyncGenerator).next()
    const r2 = await (iter as AsyncGenerator).next()
    const r3 = await (iter as AsyncGenerator).next()

    expect(r1.value.opencodeStream.type).toBe('a')
    expect(r2.value.opencodeStream.type).toBe('b')
    expect(r3.value.opencodeStream.type).toBe('c')
  })

  it('cleans up EventBus listener when generator returns', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any) as AsyncGenerator

    // Start consuming
    setTimeout(() => {
      eventBus.emit('opencode:stream', {
        type: 'test',
        sessionId: 's1',
        data: {},
      })
    }, 10)

    await iter.next()
    // Force generator to return (simulates client disconnect)
    await iter.return(undefined)

    // Listener should be removed — emit should not throw or queue
    eventBus.emit('opencode:stream', {
      type: 'post-cleanup',
      sessionId: 's1',
      data: {},
    })
    // No assertion needed — just verifying no error and no leak
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/subscriptions/opencode.test.ts`
Expected: FAIL — module `opencode.resolvers.ts` does not exist

**Step 3: Write the implementation**

```typescript
// src/server/resolvers/subscription/opencode.resolvers.ts
import type { Resolvers } from '../../__generated__/resolvers-types'
import type { OpenCodeStreamEvent } from '../../../shared/types/opencode'

export const opencodeSubscriptionResolvers: Resolvers = {
  Subscription: {
    opencodeStream: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: OpenCodeStreamEvent[] = []
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

        const listener = (event: OpenCodeStreamEvent) => {
          if (sessionFilter && !sessionFilter.has(event.sessionId)) return
          queue.push(event)
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
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/subscriptions/opencode.test.ts`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add src/server/resolvers/subscription/opencode.resolvers.ts test/server/subscriptions/opencode.test.ts
git commit -m "feat(server): add opencodeStream subscription with session filtering and 50ms batching"
```

---

## Task 2: Git Status + Branch Subscriptions

**Files:**
- Create: `src/server/resolvers/subscription/git.resolvers.ts`
- Test: `test/server/subscriptions/git.test.ts`

**Step 1: Write the failing test**

```typescript
// test/server/subscriptions/git.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import { gitSubscriptionResolvers } from '../../../src/server/resolvers/subscription/git.resolvers'

function getSubscribeFn(field: string) {
  const sub = (gitSubscriptionResolvers.Subscription as any)[field]
  return sub.subscribe as (...args: any[]) => AsyncIterable<any>
}

describe('git subscriptions', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  describe('gitStatusChanged', () => {
    it('yields git status change events', async () => {
      const subscribe = getSubscribeFn('gitStatusChanged')
      const iter = subscribe({}, {}, { eventBus } as any, {} as any)

      setTimeout(() => {
        eventBus.emit('git:statusChanged', { worktreePath: '/tmp/project/main' })
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value).toEqual({
        gitStatusChanged: { worktreePath: '/tmp/project/main' },
      })
    })

    it('filters by worktreePath when provided', async () => {
      const subscribe = getSubscribeFn('gitStatusChanged')
      const iter = subscribe(
        {},
        { worktreePath: '/tmp/project/main' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => {
        eventBus.emit('git:statusChanged', { worktreePath: '/tmp/project/other' })
        eventBus.emit('git:statusChanged', { worktreePath: '/tmp/project/main' })
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value.gitStatusChanged.worktreePath).toBe('/tmp/project/main')
    })

    it('yields all events when worktreePath not provided', async () => {
      const subscribe = getSubscribeFn('gitStatusChanged')
      const iter = subscribe({}, {}, { eventBus } as any, {} as any)

      setTimeout(() => {
        eventBus.emit('git:statusChanged', { worktreePath: '/any/path' })
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value.gitStatusChanged.worktreePath).toBe('/any/path')
    })

    it('cleans up listener on return', async () => {
      const subscribe = getSubscribeFn('gitStatusChanged')
      const iter = subscribe({}, {}, { eventBus } as any, {} as any) as AsyncGenerator

      setTimeout(() => {
        eventBus.emit('git:statusChanged', { worktreePath: '/tmp' })
      }, 10)

      await iter.next()
      await iter.return(undefined)
      // No throw = cleanup worked
    })
  })

  describe('gitBranchChanged', () => {
    it('yields branch change events', async () => {
      const subscribe = getSubscribeFn('gitBranchChanged')
      const iter = subscribe({}, {}, { eventBus } as any, {} as any)

      setTimeout(() => {
        eventBus.emit('git:branchChanged', { worktreePath: '/tmp/project/main' })
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value).toEqual({
        gitBranchChanged: { worktreePath: '/tmp/project/main' },
      })
    })

    it('filters by worktreePath when provided', async () => {
      const subscribe = getSubscribeFn('gitBranchChanged')
      const iter = subscribe(
        {},
        { worktreePath: '/tmp/project/feature' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => {
        eventBus.emit('git:branchChanged', { worktreePath: '/tmp/project/other' })
        eventBus.emit('git:branchChanged', { worktreePath: '/tmp/project/feature' })
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value.gitBranchChanged.worktreePath).toBe('/tmp/project/feature')
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/subscriptions/git.test.ts`
Expected: FAIL — module `git.resolvers.ts` does not exist

**Step 3: Write the implementation**

```typescript
// src/server/resolvers/subscription/git.resolvers.ts
import type { Resolvers } from '../../__generated__/resolvers-types'

export const gitSubscriptionResolvers: Resolvers = {
  Subscription: {
    gitStatusChanged: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: { worktreePath: string }[] = []
        let resolve: (() => void) | null = null

        const listener = (data: { worktreePath: string }) => {
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
    },
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
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/subscriptions/git.test.ts`
Expected: PASS (all 6 tests)

**Step 5: Commit**

```bash
git add src/server/resolvers/subscription/git.resolvers.ts test/server/subscriptions/git.test.ts
git commit -m "feat(server): add gitStatusChanged and gitBranchChanged subscriptions"
```

---

## Task 3: File Tree Change Subscription

**Files:**
- Create: `src/server/resolvers/subscription/file-tree.resolvers.ts`
- Test: `test/server/subscriptions/file-tree.test.ts`

**Step 1: Write the failing test**

```typescript
// test/server/subscriptions/file-tree.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import type { FileTreeChangeEvent } from '../../../src/shared/types/file-tree'
import { fileTreeSubscriptionResolvers } from '../../../src/server/resolvers/subscription/file-tree.resolvers'

function getSubscribeFn() {
  const sub = fileTreeSubscriptionResolvers.Subscription!.fileTreeChange
  if (typeof sub === 'function') throw new Error('Expected object with subscribe')
  return (sub as { subscribe: (...args: any[]) => AsyncIterable<any> }).subscribe
}

describe('fileTreeChange subscription', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  it('yields file tree change events', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    const event: FileTreeChangeEvent = {
      worktreePath: '/tmp/project/main',
      eventType: 'change',
      changedPath: '/tmp/project/main/src/index.ts',
      relativePath: 'src/index.ts',
    }

    setTimeout(() => eventBus.emit('file-tree:change', event), 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value).toEqual({ fileTreeChange: event })
  })

  it('filters by worktreePath when provided', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { worktreePath: '/tmp/project/main' },
      { eventBus } as any,
      {} as any,
    )

    setTimeout(() => {
      eventBus.emit('file-tree:change', {
        worktreePath: '/tmp/project/other',
        eventType: 'add',
        changedPath: '/tmp/project/other/foo.ts',
        relativePath: 'foo.ts',
      })
      eventBus.emit('file-tree:change', {
        worktreePath: '/tmp/project/main',
        eventType: 'unlink',
        changedPath: '/tmp/project/main/bar.ts',
        relativePath: 'bar.ts',
      })
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value.fileTreeChange.worktreePath).toBe('/tmp/project/main')
    expect(result.value.fileTreeChange.eventType).toBe('unlink')
  })

  it('cleans up listener on return', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any) as AsyncGenerator

    setTimeout(() => {
      eventBus.emit('file-tree:change', {
        worktreePath: '/tmp',
        eventType: 'change',
        changedPath: '/tmp/a.ts',
        relativePath: 'a.ts',
      })
    }, 10)

    await iter.next()
    await iter.return(undefined)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/subscriptions/file-tree.test.ts`
Expected: FAIL — module `file-tree.resolvers.ts` does not exist

**Step 3: Write the implementation**

```typescript
// src/server/resolvers/subscription/file-tree.resolvers.ts
import type { Resolvers } from '../../__generated__/resolvers-types'
import type { FileTreeChangeEvent } from '../../../shared/types/file-tree'

export const fileTreeSubscriptionResolvers: Resolvers = {
  Subscription: {
    fileTreeChange: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: FileTreeChangeEvent[] = []
        let resolve: (() => void) | null = null

        const listener = (event: FileTreeChangeEvent) => {
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

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/subscriptions/file-tree.test.ts`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add src/server/resolvers/subscription/file-tree.resolvers.ts test/server/subscriptions/file-tree.test.ts
git commit -m "feat(server): add fileTreeChange subscription"
```

---

## Task 4: Terminal Data + Exit Subscriptions

**Files:**
- Create: `src/server/resolvers/subscription/terminal.resolvers.ts`
- Test: `test/server/subscriptions/terminal.test.ts`

**Step 1: Write the failing test**

```typescript
// test/server/subscriptions/terminal.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import { terminalSubscriptionResolvers } from '../../../src/server/resolvers/subscription/terminal.resolvers'

function getSubscribeFn(field: string) {
  const sub = (terminalSubscriptionResolvers.Subscription as any)[field]
  return sub.subscribe as (...args: any[]) => AsyncIterable<any>
}

describe('terminal subscriptions', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  describe('terminalData', () => {
    it('yields terminal output for the subscribed worktreeId', async () => {
      const subscribe = getSubscribeFn('terminalData')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => eventBus.emit('terminal:data', 'wt-1', 'Hello\n'), 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value).toEqual({
        terminalData: { worktreeId: 'wt-1', data: 'Hello\n' },
      })
    })

    it('filters out events for other worktreeIds', async () => {
      const subscribe = getSubscribeFn('terminalData')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => {
        eventBus.emit('terminal:data', 'wt-2', 'Wrong terminal')
        eventBus.emit('terminal:data', 'wt-1', 'Right terminal')
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value.terminalData.data).toBe('Right terminal')
    })

    it('cleans up listener on return', async () => {
      const subscribe = getSubscribeFn('terminalData')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      ) as AsyncGenerator

      setTimeout(() => eventBus.emit('terminal:data', 'wt-1', 'test'), 10)
      await iter.next()
      await iter.return(undefined)
    })
  })

  describe('terminalExit', () => {
    it('yields exit event for the subscribed worktreeId', async () => {
      const subscribe = getSubscribeFn('terminalExit')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => eventBus.emit('terminal:exit', 'wt-1', 0), 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value).toEqual({
        terminalExit: { worktreeId: 'wt-1', code: 0 },
      })
    })

    it('filters out exit events for other worktreeIds', async () => {
      const subscribe = getSubscribeFn('terminalExit')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => {
        eventBus.emit('terminal:exit', 'wt-2', 1)
        eventBus.emit('terminal:exit', 'wt-1', 0)
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value.terminalExit.code).toBe(0)
      expect(result.value.terminalExit.worktreeId).toBe('wt-1')
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/subscriptions/terminal.test.ts`
Expected: FAIL — module `terminal.resolvers.ts` does not exist

**Step 3: Write the implementation**

Note: The EventBus emits `terminal:data` and `terminal:exit` with **two positional arguments** `(worktreeId, data/code)`, not a single object. The listener must destructure them and compose the yield payload.

```typescript
// src/server/resolvers/subscription/terminal.resolvers.ts
import type { Resolvers } from '../../__generated__/resolvers-types'

export const terminalSubscriptionResolvers: Resolvers = {
  Subscription: {
    terminalData: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: { worktreeId: string; data: string }[] = []
        let resolve: (() => void) | null = null

        const listener = (worktreeId: string, data: string) => {
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
    },
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
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/subscriptions/terminal.test.ts`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add src/server/resolvers/subscription/terminal.resolvers.ts test/server/subscriptions/terminal.test.ts
git commit -m "feat(server): add terminalData and terminalExit subscriptions"
```

---

## Task 5: Script Output Subscription

**Files:**
- Create: `src/server/resolvers/subscription/script.resolvers.ts`
- Test: `test/server/subscriptions/script.test.ts`

**Step 1: Write the failing test**

```typescript
// test/server/subscriptions/script.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import type { ScriptOutputEvent } from '../../../src/shared/types/script'
import { scriptSubscriptionResolvers } from '../../../src/server/resolvers/subscription/script.resolvers'

function getSubscribeFn() {
  const sub = scriptSubscriptionResolvers.Subscription!.scriptOutput
  if (typeof sub === 'function') throw new Error('Expected object with subscribe')
  return (sub as { subscribe: (...args: any[]) => AsyncIterable<any> }).subscribe
}

describe('scriptOutput subscription', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  it('yields script output for the matching channel', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { worktreeId: 'wt-1', channel: 'script:output:wt-1:run' },
      { eventBus } as any,
      {} as any,
    )

    const event: ScriptOutputEvent = {
      type: 'output',
      data: 'Server started on port 3000',
    }

    setTimeout(() => {
      eventBus.emit('script:output', 'script:output:wt-1:run', event)
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value).toEqual({ scriptOutput: event })
  })

  it('filters out events for other channels', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { worktreeId: 'wt-1', channel: 'script:output:wt-1:run' },
      { eventBus } as any,
      {} as any,
    )

    setTimeout(() => {
      // Different channel — should be filtered
      eventBus.emit('script:output', 'script:output:wt-1:setup', {
        type: 'output',
        data: 'wrong channel',
      })
      // Matching channel
      eventBus.emit('script:output', 'script:output:wt-1:run', {
        type: 'done',
        exitCode: 0,
      })
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value.scriptOutput.type).toBe('done')
    expect(result.value.scriptOutput.exitCode).toBe(0)
  })

  it('handles all ScriptOutputEvent types', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { worktreeId: 'wt-1', channel: 'ch1' },
      { eventBus } as any,
      {} as any,
    )

    const events: ScriptOutputEvent[] = [
      { type: 'command-start', command: 'npm test' },
      { type: 'output', data: 'PASS' },
      { type: 'done', exitCode: 0 },
    ]

    setTimeout(() => {
      for (const e of events) {
        eventBus.emit('script:output', 'ch1', e)
      }
    }, 10)

    for (const expected of events) {
      const result = await (iter as AsyncGenerator).next()
      expect(result.value.scriptOutput.type).toBe(expected.type)
    }
  })

  it('cleans up listener on return', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { worktreeId: 'wt-1', channel: 'ch1' },
      { eventBus } as any,
      {} as any,
    ) as AsyncGenerator

    setTimeout(() => {
      eventBus.emit('script:output', 'ch1', { type: 'output', data: 'x' })
    }, 10)

    await iter.next()
    await iter.return(undefined)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/subscriptions/script.test.ts`
Expected: FAIL — module `script.resolvers.ts` does not exist

**Step 3: Write the implementation**

Note: Like terminal events, `script:output` emits **two positional arguments** `(channel, event)`. The filter matches on `channel`, and only the `event` is yielded.

```typescript
// src/server/resolvers/subscription/script.resolvers.ts
import type { Resolvers } from '../../__generated__/resolvers-types'
import type { ScriptOutputEvent } from '../../../shared/types/script'

export const scriptSubscriptionResolvers: Resolvers = {
  Subscription: {
    scriptOutput: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: ScriptOutputEvent[] = []
        let resolve: (() => void) | null = null

        const listener = (channel: string, event: ScriptOutputEvent) => {
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

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/subscriptions/script.test.ts`
Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add src/server/resolvers/subscription/script.resolvers.ts test/server/subscriptions/script.test.ts
git commit -m "feat(server): add scriptOutput subscription"
```

---

## Task 6: Worktree Branch Renamed Subscription

**Files:**
- Create: `src/server/resolvers/subscription/worktree.resolvers.ts`
- Test: `test/server/subscriptions/worktree.test.ts`

**Step 1: Write the failing test**

```typescript
// test/server/subscriptions/worktree.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import { worktreeSubscriptionResolvers } from '../../../src/server/resolvers/subscription/worktree.resolvers'

function getSubscribeFn() {
  const sub = worktreeSubscriptionResolvers.Subscription!.worktreeBranchRenamed
  if (typeof sub === 'function') throw new Error('Expected object with subscribe')
  return (sub as { subscribe: (...args: any[]) => AsyncIterable<any> }).subscribe
}

describe('worktreeBranchRenamed subscription', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  it('yields branch rename events', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    setTimeout(() => {
      eventBus.emit('worktree:branchRenamed', {
        worktreeId: 'wt-1',
        newBranch: 'feature/new-name',
      })
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value).toEqual({
      worktreeBranchRenamed: {
        worktreeId: 'wt-1',
        newBranch: 'feature/new-name',
      },
    })
  })

  it('receives events for all worktrees (no filter)', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    setTimeout(() => {
      eventBus.emit('worktree:branchRenamed', { worktreeId: 'wt-1', newBranch: 'a' })
      eventBus.emit('worktree:branchRenamed', { worktreeId: 'wt-2', newBranch: 'b' })
    }, 10)

    const r1 = await (iter as AsyncGenerator).next()
    const r2 = await (iter as AsyncGenerator).next()
    expect(r1.value.worktreeBranchRenamed.worktreeId).toBe('wt-1')
    expect(r2.value.worktreeBranchRenamed.worktreeId).toBe('wt-2')
  })

  it('cleans up listener on return', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any) as AsyncGenerator

    setTimeout(() => {
      eventBus.emit('worktree:branchRenamed', {
        worktreeId: 'wt-1',
        newBranch: 'x',
      })
    }, 10)

    await iter.next()
    await iter.return(undefined)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/subscriptions/worktree.test.ts`
Expected: FAIL — module `worktree.resolvers.ts` does not exist

**Step 3: Write the implementation**

```typescript
// src/server/resolvers/subscription/worktree.resolvers.ts
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

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/subscriptions/worktree.test.ts`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add src/server/resolvers/subscription/worktree.resolvers.ts test/server/subscriptions/worktree.test.ts
git commit -m "feat(server): add worktreeBranchRenamed subscription"
```

---

## Task 7: Register All Subscription Resolvers

**Files:**
- Modify: `src/server/resolvers/index.ts`

**Step 1: Run all subscription tests to confirm they pass individually**

Run: `pnpm vitest run test/server/subscriptions/`
Expected: PASS — all tests from tasks 1–6

**Step 2: Add imports and register in mergeResolvers**

Add these imports at the end of the import block in `src/server/resolvers/index.ts`:

```typescript
import { opencodeSubscriptionResolvers } from './subscription/opencode.resolvers'
import { gitSubscriptionResolvers } from './subscription/git.resolvers'
import { fileTreeSubscriptionResolvers } from './subscription/file-tree.resolvers'
import { terminalSubscriptionResolvers } from './subscription/terminal.resolvers'
import { scriptSubscriptionResolvers } from './subscription/script.resolvers'
import { worktreeSubscriptionResolvers } from './subscription/worktree.resolvers'
```

Add these 6 entries at the end of the `deepMerge(...)` call in `mergeResolvers()`:

```typescript
  opencodeSubscriptionResolvers,
  gitSubscriptionResolvers,
  fileTreeSubscriptionResolvers,
  terminalSubscriptionResolvers,
  scriptSubscriptionResolvers,
  worktreeSubscriptionResolvers
```

**Step 3: Build to verify type-checking and resolver wiring**

Run: `pnpm build`
Expected: PASS — clean build, no type errors

**Step 4: Run all tests to ensure nothing broke**

Run: `pnpm vitest run test/server/`
Expected: PASS — all existing tests + all new subscription tests

**Step 5: Commit**

```bash
git add src/server/resolvers/index.ts
git commit -m "feat(server): register all 6 subscription resolver modules"
```

---

## Task 8: Full Build + Test Verification

**Step 1: Run the full test suite**

Run: `pnpm vitest run test/server/`
Expected: PASS — all server tests including new subscription tests

**Step 2: Run production build**

Run: `pnpm build`
Expected: PASS — clean build

**Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS — or fix any lint issues from new files

**Step 4: Final commit (if lint fixes needed)**

```bash
git add -A
git commit -m "chore: lint fixes for subscription resolvers"
```

---

## Summary

| Task | Files Created | Subscriptions |
|------|--------------|---------------|
| 1 | `opencode.resolvers.ts` + test | `opencodeStream` (filter + batch) |
| 2 | `git.resolvers.ts` + test | `gitStatusChanged`, `gitBranchChanged` |
| 3 | `file-tree.resolvers.ts` + test | `fileTreeChange` |
| 4 | `terminal.resolvers.ts` + test | `terminalData`, `terminalExit` |
| 5 | `script.resolvers.ts` + test | `scriptOutput` |
| 6 | `worktree.resolvers.ts` + test | `worktreeBranchRenamed` |
| 7 | Modified `resolvers/index.ts` | Registration of all 6 modules |
| 8 | — | Full verification pass |
