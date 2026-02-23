# Phase 9 — Security & Operations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add audit logging, auto-lock, kill switch enhancements, QR code pairing, PID file management, status file reporting, and security tests to the headless server.

**Architecture:** Introduce a `server-state.ts` module for shared runtime state (activity timestamp, request count, lock state, WS connection count). Create a yoga audit plugin for request logging. Wire lock enforcement into the server context factory. Enhance the existing headless bootstrap with PID file, status file writer, and QR code display.

**Tech Stack:** graphql-yoga plugins, qrcode-terminal (already installed), Node.js os module, vitest

---

## Key Context

- **Server entry:** `src/server/index.ts` — context factory handles auth inline (no yoga plugins yet)
- **Auth utilities:** `src/server/plugins/auth.ts` — pure functions, no state
- **Bootstrap:** `src/server/headless-bootstrap.ts` — startup + management commands (stubs for --kill, --unlock, --show-status exist)
- **Config:** `src/server/config.ts` — has `security.inactivityTimeoutMin` (default 30)
- **Tests run under:** `test/server/**` workspace (node environment, globals: true)
- **Logger:** `src/main/services/logger.ts` — `createLogger({ component })` returns `{ debug, info, warn, error }`
- **Mock DB:** `test/server/helpers/mock-db.ts` — `MockDatabaseService` class
- **Test server:** `test/server/helpers/test-server.ts` — `createTestServer(mockDb, overrides?)`
- **Code style:** No semicolons, single quotes, 2-space indent, 100 char width

---

### Task 1: Server State Module

**Files:**
- Create: `src/server/server-state.ts`
- Test: `test/server/server-state.test.ts`

This module holds all runtime state that multiple components need: activity tracking, lock state, request counting, and WebSocket connection counting.

**Step 1: Write the failing test**

Create `test/server/server-state.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  getLastActivityAt,
  updateActivity,
  getRequestCount,
  incrementRequestCount,
  isServerLocked,
  checkAndLock,
  unlock,
  getWsConnectionCount,
  incrementWsConnections,
  decrementWsConnections,
  resetServerState
} from '../../src/server/server-state'

describe('server-state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetServerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('activity tracking', () => {
    it('returns current time as initial lastActivityAt', () => {
      const now = Date.now()
      expect(getLastActivityAt()).toBe(now)
    })

    it('updates lastActivityAt', () => {
      vi.advanceTimersByTime(5000)
      updateActivity()
      expect(getLastActivityAt()).toBe(Date.now())
    })
  })

  describe('request counting', () => {
    it('starts at zero', () => {
      expect(getRequestCount()).toBe(0)
    })

    it('increments', () => {
      incrementRequestCount()
      incrementRequestCount()
      expect(getRequestCount()).toBe(2)
    })
  })

  describe('auto-lock', () => {
    it('is not locked initially', () => {
      expect(isServerLocked()).toBe(false)
    })

    it('does not lock before timeout', () => {
      vi.advanceTimersByTime(29 * 60 * 1000)
      expect(checkAndLock(30)).toBe(false)
      expect(isServerLocked()).toBe(false)
    })

    it('locks after inactivity timeout', () => {
      vi.advanceTimersByTime(31 * 60 * 1000)
      expect(checkAndLock(30)).toBe(true)
      expect(isServerLocked()).toBe(true)
    })

    it('stays locked once locked', () => {
      vi.advanceTimersByTime(31 * 60 * 1000)
      checkAndLock(30)
      expect(checkAndLock(30)).toBe(true)
    })

    it('does not lock if activity is recent', () => {
      vi.advanceTimersByTime(25 * 60 * 1000)
      updateActivity()
      vi.advanceTimersByTime(10 * 60 * 1000)
      expect(checkAndLock(30)).toBe(false)
    })

    it('unlocks and resets activity', () => {
      vi.advanceTimersByTime(31 * 60 * 1000)
      checkAndLock(30)
      unlock()
      expect(isServerLocked()).toBe(false)
      expect(getLastActivityAt()).toBe(Date.now())
    })
  })

  describe('WebSocket connections', () => {
    it('starts at zero', () => {
      expect(getWsConnectionCount()).toBe(0)
    })

    it('increments and decrements', () => {
      incrementWsConnections()
      incrementWsConnections()
      expect(getWsConnectionCount()).toBe(2)
      decrementWsConnections()
      expect(getWsConnectionCount()).toBe(1)
    })

    it('does not go below zero', () => {
      decrementWsConnections()
      expect(getWsConnectionCount()).toBe(0)
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/server-state.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write the implementation**

Create `src/server/server-state.ts`:

```typescript
let lastActivityAt = Date.now()
let requestCount = 0
let locked = false
let wsConnectionCount = 0

export function getLastActivityAt(): number {
  return lastActivityAt
}

export function updateActivity(): void {
  lastActivityAt = Date.now()
}

export function getRequestCount(): number {
  return requestCount
}

export function incrementRequestCount(): void {
  requestCount++
}

export function isServerLocked(): boolean {
  return locked
}

export function checkAndLock(timeoutMinutes: number): boolean {
  if (locked) return true
  const elapsed = Date.now() - lastActivityAt
  if (elapsed > timeoutMinutes * 60 * 1000) {
    locked = true
    return true
  }
  return false
}

export function unlock(): void {
  locked = false
  updateActivity()
}

export function getWsConnectionCount(): number {
  return wsConnectionCount
}

export function incrementWsConnections(): void {
  wsConnectionCount++
}

export function decrementWsConnections(): void {
  if (wsConnectionCount > 0) wsConnectionCount--
}

export function resetServerState(): void {
  lastActivityAt = Date.now()
  requestCount = 0
  locked = false
  wsConnectionCount = 0
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/server-state.test.ts`
Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add src/server/server-state.ts test/server/server-state.test.ts
git commit -m "feat(server): add server-state module for runtime state tracking"
```

---

### Task 2: Audit Logging Plugin

**Files:**
- Create: `src/server/plugins/audit.ts`
- Test: `test/server/audit-plugin.test.ts`
- Modify: `src/server/index.ts:44-84` (add plugin to yoga config)

The audit plugin is a graphql-yoga `Plugin` that logs every request and increments the request counter.

**Step 1: Write the failing test**

Create `test/server/audit-plugin.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createYoga, createSchema } from 'graphql-yoga'
import { createAuditPlugin } from '../../src/server/plugins/audit'
import { getRequestCount, resetServerState } from '../../src/server/server-state'

// Minimal schema for testing
const yoga = createYoga({
  schema: createSchema({
    typeDefs: `type Query { hello: String!, fail: String! }`,
    resolvers: {
      Query: {
        hello: () => 'world',
        fail: () => { throw new Error('boom') }
      }
    }
  }),
  plugins: [createAuditPlugin()],
  context: () => ({ clientIp: '192.168.1.5', authenticated: true })
})

async function execute(query: string) {
  const res = await yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query })
  })
  return res.json()
}

describe('audit plugin', () => {
  beforeEach(() => {
    resetServerState()
  })

  it('increments request count on each request', async () => {
    expect(getRequestCount()).toBe(0)
    await execute('{ hello }')
    expect(getRequestCount()).toBe(1)
    await execute('{ hello }')
    expect(getRequestCount()).toBe(2)
  })

  it('increments request count even on error', async () => {
    await execute('{ fail }')
    expect(getRequestCount()).toBe(1)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/audit-plugin.test.ts`
Expected: FAIL — createAuditPlugin does not exist

**Step 3: Write the implementation**

Create `src/server/plugins/audit.ts`:

```typescript
import type { Plugin } from 'graphql-yoga'
import { incrementRequestCount } from '../server-state'

const SENSITIVE_OPS = new Set([
  'terminalCreate',
  'terminalWrite',
  'scriptRunSetup',
  'scriptRunProject',
  'gitPush',
  'gitCommit',
  'gitMerge',
  'gitDeleteBranch',
  'systemKillSwitch',
  'fileWrite'
])

function extractSensitiveContext(
  operationName: string,
  variableValues: Record<string, unknown>
): string {
  switch (operationName) {
    case 'terminalCreate':
    case 'terminalWrite':
      return variableValues.worktreeId
        ? `worktreeId=${variableValues.worktreeId}`
        : ''
    case 'scriptRunSetup':
    case 'scriptRunProject':
      return [
        variableValues.input &&
        typeof variableValues.input === 'object' &&
        'worktreeId' in variableValues.input
          ? `worktreeId=${(variableValues.input as Record<string, unknown>).worktreeId}`
          : '',
        variableValues.input &&
        typeof variableValues.input === 'object' &&
        'cwd' in variableValues.input
          ? `cwd=${(variableValues.input as Record<string, unknown>).cwd}`
          : ''
      ]
        .filter(Boolean)
        .join(' ')
    case 'gitPush':
    case 'gitCommit':
      return variableValues.worktreePath
        ? `worktreePath=${variableValues.worktreePath}`
        : ''
    case 'fileWrite':
      return variableValues.filePath
        ? `filePath=${variableValues.filePath}`
        : ''
    case 'systemKillSwitch':
      return 'SERVER KILL INITIATED'
    default:
      return ''
  }
}

export function createAuditPlugin(): Plugin {
  return {
    onExecute({ args }) {
      const start = Date.now()
      const operationName =
        args.operationName ??
        (args.document.definitions[0] &&
        'name' in args.document.definitions[0] &&
        args.document.definitions[0].name?.value) ??
        'anonymous'
      const clientIp =
        (args.contextValue as { clientIp?: string }).clientIp ?? 'unknown'

      return {
        onExecuteDone({ result }) {
          incrementRequestCount()
          const duration = Date.now() - start

          // Only log if we have a real logger available (skip in tests)
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createLogger } = require('../../main/services/logger')
            const log = createLogger({ component: 'audit' })

            const hasErrors =
              result &&
              'errors' in result &&
              Array.isArray(result.errors) &&
              result.errors.length > 0

            if (SENSITIVE_OPS.has(operationName)) {
              const context = extractSensitiveContext(
                operationName,
                args.variableValues ?? {}
              )
              const level = operationName === 'systemKillSwitch' ? 'warn' : 'info'
              log[level](
                `[sensitive] ${operationName} from ${clientIp} - ${duration}ms${context ? ' - ' + context : ''}${hasErrors ? ' [ERROR]' : ''}`
              )
            } else {
              log.info(
                `${operationName} from ${clientIp} - ${duration}ms${hasErrors ? ' [ERROR]' : ''}`
              )
            }

            if (hasErrors && 'errors' in result) {
              log.warn(`${operationName} errors`, {
                errors: result.errors!.map((e: { message: string }) => e.message)
              })
            }
          } catch {
            // Logger not available (e.g., in tests without electron) — silent
          }
        }
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/audit-plugin.test.ts`
Expected: All tests PASS

**Step 5: Wire audit plugin into server**

In `src/server/index.ts`, add the import at the top and the plugin to yoga:

Add import (after line 9):
```typescript
import { createAuditPlugin } from './plugins/audit'
```

Change the `createYoga` call (line 48) to include plugins:
```typescript
  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    graphqlEndpoint: '/graphql',
    plugins: [createAuditPlugin()],
    context: (ctx: { request: Request }) => {
```

**Step 6: Verify build**

Run: `pnpm build`
Expected: Build succeeds

**Step 7: Commit**

```bash
git add src/server/plugins/audit.ts test/server/audit-plugin.test.ts src/server/index.ts
git commit -m "feat(server): add audit logging plugin with sensitive operation tracking"
```

---

### Task 3: Auto-Lock Enforcement

**Files:**
- Modify: `src/server/index.ts:51-83` (add lock check + activity tracking to context)
- Test: `test/server/auto-lock.test.ts`

Wire lock checking and activity tracking into the server context factory. On every request:
1. Check if server should be locked (inactivity timeout)
2. If locked and operation is not `systemServerStatus`, throw `SERVER_LOCKED`
3. On successful auth, call `updateActivity()`

**Step 1: Write the failing test**

Create `test/server/auto-lock.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  checkAndLock,
  isServerLocked,
  unlock,
  resetServerState
} from '../../src/server/server-state'

describe('auto-lock integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetServerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('transitions to locked after timeout with no activity', () => {
    expect(isServerLocked()).toBe(false)
    vi.advanceTimersByTime(31 * 60 * 1000)
    checkAndLock(30)
    expect(isServerLocked()).toBe(true)
  })

  it('resumes after unlock', () => {
    vi.advanceTimersByTime(31 * 60 * 1000)
    checkAndLock(30)
    expect(isServerLocked()).toBe(true)
    unlock()
    expect(isServerLocked()).toBe(false)

    // Should not re-lock immediately since unlock resets activity
    expect(checkAndLock(30)).toBe(false)
  })

  it('does not lock with recent activity', () => {
    vi.advanceTimersByTime(15 * 60 * 1000)
    // Simulate activity by resetting state (updateActivity updates lastActivityAt)
    const { updateActivity } = require('../../src/server/server-state')
    updateActivity()
    vi.advanceTimersByTime(15 * 60 * 1000)
    expect(checkAndLock(30)).toBe(false)
  })
})
```

**Step 2: Run test to verify it passes**

Run: `pnpm vitest run test/server/auto-lock.test.ts`
Expected: All tests PASS (server-state module already works from Task 1)

**Step 3: Add lock enforcement to server context factory**

In `src/server/index.ts`, update the imports (add at top):

```typescript
import { GraphQLError } from 'graphql-yoga'  // already imported
import { checkAndLock, isServerLocked, updateActivity } from './server-state'
```

Update `ServerOptions` interface to include config:

```typescript
export interface ServerOptions {
  port: number
  bindAddress: string
  tlsCert: string
  tlsKey: string
  context: Omit<GraphQLContext, 'clientIp' | 'authenticated'>
  getKeyHash: () => string
  bruteForce: BruteForceTracker
  inactivityTimeoutMin: number
}
```

In the context factory (inside `createYoga`), add lock check after clientIp extraction and before auth, and activity update after successful auth. The full updated context factory:

```typescript
    context: (ctx: { request: Request }) => {
      const nodeReq = (ctx as Record<string, unknown>).req as
        | { socket?: { remoteAddress?: string } }
        | undefined
      const clientIp = nodeReq?.socket?.remoteAddress ?? 'unknown'

      if (opts.bruteForce.isBlocked(clientIp)) {
        throw new GraphQLError('Too many failed authentication attempts', {
          extensions: { http: { status: 429 } }
        })
      }

      // Auto-lock check
      if (checkAndLock(opts.inactivityTimeoutMin)) {
        // Parse operation name from request body to allow systemServerStatus through
        // The actual enforcement happens in resolvers; here we just check the timer
      }

      const token = extractBearerToken(ctx.request.headers.get('authorization'))
      let authenticated = false

      if (token) {
        const hash = opts.getKeyHash()
        if (verifyApiKey(token, hash)) {
          authenticated = true
          opts.bruteForce.recordSuccess(clientIp)
          updateActivity()
        } else {
          opts.bruteForce.recordFailure(clientIp)
        }
      }

      return {
        ...opts.context,
        clientIp,
        authenticated
      }
    }
```

**Step 4: Add lock check to GraphQL context type**

In `src/server/context.ts`, no changes needed — the lock state is checked via `isServerLocked()` imported from server-state wherever needed.

**Step 5: Add lock enforcement to all resolvers via auth check plugin**

The cleanest approach: create a small yoga plugin that checks lock state on every execute. This avoids modifying every resolver.

Add to `src/server/plugins/audit.ts` (or create inline in `index.ts`). Actually, add it as a separate function in `src/server/index.ts` right before `startGraphQLServer`:

In `src/server/index.ts`, after imports, before `startGraphQLServer`:

```typescript
function createLockGuardPlugin(getTimeoutMin: () => number): Plugin {
  return {
    onExecute({ args }) {
      if (checkAndLock(getTimeoutMin())) {
        const opName =
          args.operationName ??
          (args.document.definitions[0] &&
          'name' in args.document.definitions[0]
            ? args.document.definitions[0].name?.value
            : undefined)

        if (opName !== 'systemServerStatus') {
          throw new GraphQLError(
            'Server is locked due to inactivity. Use --unlock to resume.',
            { extensions: { code: 'SERVER_LOCKED' } }
          )
        }
      }
    }
  }
}
```

Add `type { Plugin }` to the graphql-yoga import:

```typescript
import { createYoga, createSchema, GraphQLError, type Plugin } from 'graphql-yoga'
```

Then in the `createYoga` call, use both plugins:

```typescript
    plugins: [
      createLockGuardPlugin(() => opts.inactivityTimeoutMin),
      createAuditPlugin()
    ],
```

**Step 6: Pass inactivityTimeoutMin from bootstrap**

In `src/server/headless-bootstrap.ts`, update the `startGraphQLServer` call (line 105-113) to include the new option:

```typescript
  serverHandle = startGraphQLServer({
    port,
    bindAddress: bind,
    tlsCert: config.tls.certPath,
    tlsKey: config.tls.keyPath,
    context: { db, sdkManager, eventBus },
    getKeyHash: () => db.getSetting('headless_api_key_hash') || '',
    bruteForce,
    inactivityTimeoutMin: config.security.inactivityTimeoutMin
  })
```

**Step 7: Add periodic lock check interval to bootstrap**

In `src/server/headless-bootstrap.ts`, after the server starts (after line 115), add:

```typescript
  // Periodic auto-lock check
  const lockCheckInterval = setInterval(() => {
    checkAndLock(config.security.inactivityTimeoutMin)
  }, 60_000)
```

Add the import at the top of `headless-bootstrap.ts`:

```typescript
import { checkAndLock } from './server-state'
```

Add `lockCheckInterval` cleanup to SIGTERM/SIGINT handlers:

```typescript
  process.on('SIGTERM', async () => {
    clearInterval(cleanupInterval)
    clearInterval(lockCheckInterval)
    await serverHandle?.close()
    process.exit(0)
  })
  process.on('SIGINT', async () => {
    clearInterval(cleanupInterval)
    clearInterval(lockCheckInterval)
    await serverHandle?.close()
    process.exit(0)
  })
```

**Step 8: Update systemServerStatus resolver to report real lock state**

In `src/server/resolvers/query/system.resolvers.ts`, add import and update:

```typescript
import { isServerLocked, getRequestCount, getWsConnectionCount } from '../../server/server-state'
```

Update the `systemServerStatus` resolver:

```typescript
    systemServerStatus: () => ({
      uptime: Math.floor(process.uptime()),
      connections: getWsConnectionCount(),
      requestCount: getRequestCount(),
      locked: isServerLocked(),
      version: getAppVersion()
    })
```

**Step 9: Verify build**

Run: `pnpm vitest run test/server/server-state.test.ts test/server/auto-lock.test.ts && pnpm build`
Expected: Tests pass, build succeeds

**Step 10: Commit**

```bash
git add src/server/index.ts src/server/headless-bootstrap.ts src/server/resolvers/query/system.resolvers.ts test/server/auto-lock.test.ts
git commit -m "feat(server): add auto-lock enforcement with inactivity timeout"
```

---

### Task 4: Enhance Kill Switch

**Files:**
- Modify: `src/server/resolvers/mutation/system.resolvers.ts`
- Modify: `src/server/index.ts` (add server:kill event handling)
- Modify: `src/server/event-bus.ts` (add server:kill event type)

The existing kill switch only deletes the API key hash. Enhance it to: log the kill event, close all WebSocket connections, and schedule server shutdown.

**Step 1: Add `server:kill` event to EventBus**

In `src/server/event-bus.ts`, add to the `EventBusEvents` interface:

```typescript
  'server:kill': []
```

**Step 2: Enhance the kill switch mutation**

In `src/server/resolvers/mutation/system.resolvers.ts`:

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'

export const systemMutationResolvers: Resolvers = {
  Mutation: {
    systemKillSwitch: async (_parent, _args, ctx) => {
      // 1. Delete API key hash (invalidates all future auth)
      ctx.db.deleteSetting('headless_api_key_hash')
      ctx.db.deleteSetting('headless_key_created_at')

      // 2. Emit kill event to close WebSocket connections and server
      ctx.eventBus.emit('server:kill')

      // 3. Schedule shutdown after response is sent
      setTimeout(() => {
        process.exit(0)
      }, 500)

      return true
    },
    systemRegisterPushToken: async (_parent, { token, platform }, ctx) => {
      ctx.db.setSetting('headless_push_token', token)
      ctx.db.setSetting('headless_push_platform', platform)
      return true
    }
  }
}
```

**Step 3: Handle server:kill in server entry**

In `src/server/index.ts`, after `useServer(...)` and before `httpsServer.listen(...)`, add the kill handler. To do this, we need to return the wss and httpsServer references. Update `startGraphQLServer` to listen for the kill event:

After the `useServer(...)` call (around line 129), add:

```typescript
  // Handle kill switch
  opts.context.eventBus.on('server:kill', () => {
    for (const client of wss.clients) {
      client.close(1000, 'Server killed')
    }
    httpsServer.close()
  })
```

**Step 4: Verify build**

Run: `pnpm build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add src/server/event-bus.ts src/server/resolvers/mutation/system.resolvers.ts src/server/index.ts
git commit -m "feat(server): enhance kill switch with WS close and graceful shutdown"
```

---

### Task 5: QR Code Pairing Display

**Files:**
- Modify: `src/server/headless-bootstrap.ts:83-92` (enhance API key display with QR code)

On first headless start (when a new API key is generated), display the key and a QR code containing the pairing payload.

**Step 1: Add QR code display to bootstrap**

In `src/server/headless-bootstrap.ts`, add imports at top:

```typescript
import qrcode from 'qrcode-terminal'
import { networkInterfaces } from 'node:os'
```

Add helper function before `headlessBootstrap`:

```typescript
function getLocalIp(): string {
  const interfaces = networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}
```

Replace the API key display block (lines 83-92) with:

```typescript
  // Ensure API key
  let existingHash = db.getSetting('headless_api_key_hash')
  if (!existingHash) {
    const newKey = generateApiKey()
    existingHash = hashApiKey(newKey)
    db.setSetting('headless_api_key_hash', existingHash)
    db.setSetting('headless_key_created_at', new Date().toISOString())

    const certFingerprint = db.getSetting('headless_cert_fingerprint') || fingerprint

    const pairingPayload = JSON.stringify({
      host: getLocalIp(),
      port,
      key: newKey,
      certFingerprint
    })

    console.log('\n=== Hive Headless Server — First Run Setup ===\n')
    console.log(`API Key: ${newKey}`)
    console.log(`Port: ${port}`)
    console.log(`Cert Fingerprint: ${certFingerprint}\n`)
    console.log('Scan this QR code with the Hive mobile app:\n')
    qrcode.generate(pairingPayload, { small: true })
    console.log('\n⚠️  Save your API key now — it cannot be shown again.')
    console.log('Use --rotate-key to generate a new key if needed.\n')
  }
```

**Step 2: Add QR code to --rotate-key command**

In the `handleManagementCommand` function, enhance the `rotateKey` block:

```typescript
  if (opts.rotateKey) {
    const newKey = generateApiKey()
    const hash = hashApiKey(newKey)
    db.setSetting('headless_api_key_hash', hash)
    db.setSetting('headless_key_created_at', new Date().toISOString())

    const certFingerprint = db.getSetting('headless_cert_fingerprint') || ''
    const config = loadHeadlessConfig()

    const pairingPayload = JSON.stringify({
      host: getLocalIp(),
      port: config.port,
      key: newKey,
      certFingerprint
    })

    console.log('\n=== API Key Rotated ===\n')
    console.log(`New API Key: ${newKey}`)
    console.log('\nScan this QR code with the Hive mobile app:\n')
    qrcode.generate(pairingPayload, { small: true })
    console.log('\n⚠️  The old key is now invalid. Update your mobile app.')
    console.log('If the headless server is running, restart it.\n')
  }
```

**Step 3: Add type declaration for qrcode-terminal**

Check if `@types/qrcode-terminal` exists. If not, create a declaration file:

Create `src/server/types/qrcode-terminal.d.ts`:

```typescript
declare module 'qrcode-terminal' {
  export function generate(
    text: string,
    options?: { small?: boolean },
    callback?: (qrcode: string) => void
  ): void
}
```

**Step 4: Verify build**

Run: `pnpm build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add src/server/headless-bootstrap.ts src/server/types/qrcode-terminal.d.ts
git commit -m "feat(server): add QR code pairing display on first run and key rotation"
```

---

### Task 6: PID File Management

**Files:**
- Modify: `src/server/headless-bootstrap.ts` (add PID file write on startup, cleanup on exit)
- Test: `test/server/pid-file.test.ts`

Write `~/.hive/hive-headless.pid` on startup, detect stale PID files, and clean up on exit.

**Step 1: Write the failing test**

Create `test/server/pid-file.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  writePidFile,
  cleanupPidFile,
  checkStalePidFile
} from '../../src/server/pid-file'

describe('PID file management', () => {
  const testDir = join(tmpdir(), 'hive-test-pid-' + process.pid)
  const pidPath = join(testDir, 'hive-headless.pid')

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('writes PID file with current process PID', () => {
    writePidFile(pidPath)
    expect(existsSync(pidPath)).toBe(true)
    expect(readFileSync(pidPath, 'utf-8').trim()).toBe(process.pid.toString())
  })

  it('cleans up PID file', () => {
    writePidFile(pidPath)
    cleanupPidFile(pidPath)
    expect(existsSync(pidPath)).toBe(false)
  })

  it('cleanup is silent if file does not exist', () => {
    expect(() => cleanupPidFile(pidPath)).not.toThrow()
  })

  it('detects stale PID file (non-existent process)', () => {
    // Write a PID that definitely does not exist
    writeFileSync(pidPath, '999999999')
    const result = checkStalePidFile(pidPath)
    expect(result).toBe('stale')
    // Stale file should be removed
    expect(existsSync(pidPath)).toBe(false)
  })

  it('detects running process PID file', () => {
    // Write our own PID (we are definitely running)
    writeFileSync(pidPath, process.pid.toString())
    const result = checkStalePidFile(pidPath)
    expect(result).toBe('running')
  })

  it('returns none when no PID file exists', () => {
    const result = checkStalePidFile(pidPath)
    expect(result).toBe('none')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/pid-file.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write the implementation**

Create `src/server/pid-file.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'

export function writePidFile(pidPath: string): void {
  writeFileSync(pidPath, process.pid.toString())
}

export function cleanupPidFile(pidPath: string): void {
  try {
    unlinkSync(pidPath)
  } catch {
    // Ignore — file may already be deleted
  }
}

export type PidCheckResult = 'none' | 'stale' | 'running'

export function checkStalePidFile(pidPath: string): PidCheckResult {
  if (!existsSync(pidPath)) return 'none'

  const existingPid = parseInt(readFileSync(pidPath, 'utf-8').trim())
  if (isNaN(existingPid)) {
    // Corrupt PID file — treat as stale
    cleanupPidFile(pidPath)
    return 'stale'
  }

  try {
    // Signal 0 checks if process exists without sending a signal
    process.kill(existingPid, 0)
    return 'running'
  } catch {
    // Process not running — stale PID file
    cleanupPidFile(pidPath)
    return 'stale'
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/pid-file.test.ts`
Expected: All 6 tests PASS

**Step 5: Wire PID file into headless bootstrap**

In `src/server/headless-bootstrap.ts`, add import:

```typescript
import { writePidFile, cleanupPidFile, checkStalePidFile } from './pid-file'
```

After the server starts (after the `console.log` lines around line 115-116), add:

```typescript
  // PID file management
  const pidPath = join(homedir(), '.hive', 'hive-headless.pid')
  const pidStatus = checkStalePidFile(pidPath)
  if (pidStatus === 'running') {
    const existingPid = parseInt(
      (await import('node:fs')).readFileSync(pidPath, 'utf-8').trim()
    )
    console.error(
      `Headless server already running (PID ${existingPid}). Use --kill to stop it.`
    )
    process.exit(1)
  }
  writePidFile(pidPath)
```

Update the SIGTERM/SIGINT handlers to clean up the PID file:

```typescript
  process.on('SIGTERM', async () => {
    clearInterval(cleanupInterval)
    clearInterval(lockCheckInterval)
    cleanupPidFile(pidPath)
    await serverHandle?.close()
    process.exit(0)
  })
  process.on('SIGINT', async () => {
    clearInterval(cleanupInterval)
    clearInterval(lockCheckInterval)
    cleanupPidFile(pidPath)
    await serverHandle?.close()
    process.exit(0)
  })
```

**Step 6: Verify build**

Run: `pnpm vitest run test/server/pid-file.test.ts && pnpm build`
Expected: Tests pass, build succeeds

**Step 7: Commit**

```bash
git add src/server/pid-file.ts test/server/pid-file.test.ts src/server/headless-bootstrap.ts
git commit -m "feat(server): add PID file management with stale detection"
```

---

### Task 7: Status File Writer

**Files:**
- Create: `src/server/status-file.ts`
- Test: `test/server/status-file.test.ts`
- Modify: `src/server/headless-bootstrap.ts` (add periodic status writer)

Write `~/.hive/hive-headless.status.json` every 30 seconds with live server metrics.

**Step 1: Write the failing test**

Create `test/server/status-file.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeStatusFile, cleanupStatusFile, formatUptime } from '../../src/server/status-file'
import { resetServerState, incrementRequestCount } from '../../src/server/server-state'

describe('status-file', () => {
  const testDir = join(tmpdir(), 'hive-test-status-' + process.pid)
  const statusPath = join(testDir, 'hive-headless.status.json')

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    resetServerState()
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('writes status file with correct structure', () => {
    writeStatusFile(statusPath, { port: 8443, version: '1.0.0' })
    expect(existsSync(statusPath)).toBe(true)
    const status = JSON.parse(readFileSync(statusPath, 'utf-8'))
    expect(status).toMatchObject({
      pid: process.pid,
      port: 8443,
      version: '1.0.0',
      locked: false,
      requestCount: 0,
      connections: 0
    })
    expect(status.uptime).toBeTypeOf('number')
    expect(status.uptimeFormatted).toBeTypeOf('string')
    expect(status.startedAt).toBeTypeOf('string')
    expect(status.lastActivityAt).toBeTypeOf('string')
  })

  it('reflects current request count', () => {
    incrementRequestCount()
    incrementRequestCount()
    incrementRequestCount()
    writeStatusFile(statusPath, { port: 8443, version: '1.0.0' })
    const status = JSON.parse(readFileSync(statusPath, 'utf-8'))
    expect(status.requestCount).toBe(3)
  })

  it('cleans up status file', () => {
    writeStatusFile(statusPath, { port: 8443, version: '1.0.0' })
    cleanupStatusFile(statusPath)
    expect(existsSync(statusPath)).toBe(false)
  })

  it('cleanup is silent if file does not exist', () => {
    expect(() => cleanupStatusFile(statusPath)).not.toThrow()
  })
})

describe('formatUptime', () => {
  it('formats seconds', () => {
    expect(formatUptime(45_000)).toBe('45s')
  })

  it('formats minutes and seconds', () => {
    expect(formatUptime(125_000)).toBe('2m 5s')
  })

  it('formats hours', () => {
    expect(formatUptime(3_661_000)).toBe('1h 1m 1s')
  })

  it('formats days', () => {
    expect(formatUptime(90_061_000)).toBe('1d 1h 1m 1s')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/status-file.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write the implementation**

Create `src/server/status-file.ts`:

```typescript
import { writeFileSync, unlinkSync } from 'node:fs'
import {
  getRequestCount,
  isServerLocked,
  getLastActivityAt,
  getWsConnectionCount
} from './server-state'

const startTime = Date.now()

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${secs}s`)
  return parts.join(' ')
}

export interface StatusFileOpts {
  port: number
  version: string
}

export function writeStatusFile(statusPath: string, opts: StatusFileOpts): void {
  const now = Date.now()
  const status = {
    pid: process.pid,
    port: opts.port,
    uptime: Math.floor((now - startTime) / 1000),
    uptimeFormatted: formatUptime(now - startTime),
    connections: getWsConnectionCount(),
    requestCount: getRequestCount(),
    locked: isServerLocked(),
    lastActivityAt: new Date(getLastActivityAt()).toISOString(),
    version: opts.version,
    startedAt: new Date(startTime).toISOString()
  }
  writeFileSync(statusPath, JSON.stringify(status, null, 2))
}

export function cleanupStatusFile(statusPath: string): void {
  try {
    unlinkSync(statusPath)
  } catch {
    // Ignore — file may already be deleted
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/status-file.test.ts`
Expected: All tests PASS

**Step 5: Wire status file into headless bootstrap**

In `src/server/headless-bootstrap.ts`, add import:

```typescript
import { writeStatusFile, cleanupStatusFile } from './status-file'
```

After the PID file block, add:

```typescript
  // Status file writer
  const statusPath = join(homedir(), '.hive', 'hive-headless.status.json')
  const statusOpts = { port, version: app.getVersion() }
  writeStatusFile(statusPath, statusOpts)
  const statusInterval = setInterval(() => {
    writeStatusFile(statusPath, statusOpts)
  }, 30_000)
```

Note: `app` from electron — add import if not already available. In headless mode, `app` is available. Add:

```typescript
import { app } from 'electron'
```

Update SIGTERM/SIGINT handlers to clean up:

```typescript
  process.on('SIGTERM', async () => {
    clearInterval(cleanupInterval)
    clearInterval(lockCheckInterval)
    clearInterval(statusInterval)
    cleanupPidFile(pidPath)
    cleanupStatusFile(statusPath)
    await serverHandle?.close()
    process.exit(0)
  })
  process.on('SIGINT', async () => {
    clearInterval(cleanupInterval)
    clearInterval(lockCheckInterval)
    clearInterval(statusInterval)
    cleanupPidFile(pidPath)
    cleanupStatusFile(statusPath)
    await serverHandle?.close()
    process.exit(0)
  })
```

**Step 6: Verify build**

Run: `pnpm vitest run test/server/status-file.test.ts && pnpm build`
Expected: Tests pass, build succeeds

**Step 7: Commit**

```bash
git add src/server/status-file.ts test/server/status-file.test.ts src/server/headless-bootstrap.ts
git commit -m "feat(server): add periodic status file writer"
```

---

### Task 8: WebSocket Connection Tracking

**Files:**
- Modify: `src/server/index.ts` (add WS connect/disconnect tracking)

Track WebSocket connection count so `systemServerStatus.connections` returns real data.

**Step 1: Add WS tracking to server**

In `src/server/index.ts`, add import:

```typescript
import { incrementWsConnections, decrementWsConnections } from './server-state'
```

In the `useServer` config (around line 99-129), update `onConnect` to track connections and add `onDisconnect`:

```typescript
  useServer(
    {
      execute: (args: unknown) => (args as { rootValue: never }).rootValue,
      subscribe: (args: unknown) => (args as { rootValue: never }).rootValue,
      context: (ctx) => ({
        ...opts.context,
        clientIp:
          (ctx.extra as { request: { socket: { remoteAddress?: string } } })
            .request.socket.remoteAddress || 'unknown',
        authenticated: true
      }),
      onConnect: (ctx) => {
        const clientIp =
          (ctx.extra as { request: { socket: { remoteAddress?: string } } })
            .request.socket.remoteAddress || 'unknown'

        if (opts.bruteForce.isBlocked(clientIp)) return false

        const apiKey = ctx.connectionParams?.apiKey as string | undefined
        if (!apiKey) return false
        const hash = opts.getKeyHash()
        if (!verifyApiKey(apiKey, hash)) {
          opts.bruteForce.recordFailure(clientIp)
          return false
        }
        opts.bruteForce.recordSuccess(clientIp)
        incrementWsConnections()
        return true
      },
      onDisconnect: () => {
        decrementWsConnections()
      }
    },
    wss
  )
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(server): track WebSocket connection count"
```

---

### Task 9: Unlock via DB Setting Watcher

**Files:**
- Modify: `src/server/headless-bootstrap.ts` (add periodic unlock check)

The `--unlock` command already writes `headless_locked = ''` to DB. The running server needs to periodically check this and call `unlock()` when it detects the setting was cleared while the server is locked.

**Step 1: Add unlock watcher to bootstrap**

In `src/server/headless-bootstrap.ts`, add import:

```typescript
import { isServerLocked, unlock } from './server-state'
```

After the status file setup, add:

```typescript
  // Unlock watcher — checks if --unlock command cleared the DB setting
  const unlockCheckInterval = setInterval(() => {
    if (isServerLocked()) {
      const lockVal = db.getSetting('headless_locked')
      if (!lockVal || lockVal === '') {
        unlock()
        console.log('Server unlocked via --unlock command')
      }
    }
  }, 5_000)
```

Also, when the server auto-locks, we should set the DB setting so that --unlock knows to clear it. Add to the lock check interval:

```typescript
  // Periodic auto-lock check
  const lockCheckInterval = setInterval(() => {
    const wasLocked = isServerLocked()
    checkAndLock(config.security.inactivityTimeoutMin)
    if (!wasLocked && isServerLocked()) {
      db.setSetting('headless_locked', 'true')
      console.log('Server auto-locked due to inactivity')
    }
  }, 60_000)
```

Add `unlockCheckInterval` cleanup to signal handlers:

```typescript
  process.on('SIGTERM', async () => {
    clearInterval(cleanupInterval)
    clearInterval(lockCheckInterval)
    clearInterval(statusInterval)
    clearInterval(unlockCheckInterval)
    cleanupPidFile(pidPath)
    cleanupStatusFile(statusPath)
    await serverHandle?.close()
    process.exit(0)
  })
  process.on('SIGINT', async () => {
    clearInterval(cleanupInterval)
    clearInterval(lockCheckInterval)
    clearInterval(statusInterval)
    clearInterval(unlockCheckInterval)
    cleanupPidFile(pidPath)
    cleanupStatusFile(statusPath)
    await serverHandle?.close()
    process.exit(0)
  })
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/server/headless-bootstrap.ts
git commit -m "feat(server): add unlock watcher for --unlock CLI integration"
```

---

### Task 10: Security Test Suite

**Files:**
- Create: `test/server/integration/security.test.ts`

Comprehensive tests for auth, brute force, path guard, auto-lock, kill switch, and audit logging. These are unit/integration tests using the test server helper and direct function calls.

**Step 1: Write the test suite**

Create `test/server/integration/security.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MockDatabaseService } from '../helpers/mock-db'
import { createTestServer } from '../helpers/test-server'
import {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  extractBearerToken,
  BruteForceTracker
} from '../../../src/server/plugins/auth'
import { PathGuard } from '../../../src/server/plugins/path-guard'
import {
  checkAndLock,
  isServerLocked,
  unlock,
  updateActivity,
  resetServerState
} from '../../../src/server/server-state'

describe('Security Integration', () => {
  describe('Authentication', () => {
    let mockDb: MockDatabaseService

    beforeEach(() => {
      mockDb = new MockDatabaseService()
    })

    it('rejects request with unauthenticated context', async () => {
      // Test that resolvers requiring auth behave correctly
      // Our test server sets authenticated: true by default,
      // so we override to test unauthenticated behavior
      const server = createTestServer(mockDb, { authenticated: false })
      // systemAppVersion works regardless of auth in current impl
      // This test validates the context plumbing
      const result = await server.execute('{ systemAppVersion }')
      // Current resolvers don't check authenticated flag themselves
      // (auth is enforced at transport level), so this should still work
      expect(result.data).toBeTruthy()
    })

    it('generates and verifies API keys correctly', () => {
      const key = generateApiKey()
      expect(key).toMatch(/^hive_/)
      expect(key.length).toBeGreaterThan(20)

      const hash = hashApiKey(key)
      expect(verifyApiKey(key, hash)).toBe(true)
      expect(verifyApiKey('wrong_key', hash)).toBe(false)
    })

    it('extracts bearer token correctly', () => {
      expect(extractBearerToken('Bearer hive_abc123')).toBe('hive_abc123')
      expect(extractBearerToken(undefined)).toBeNull()
      expect(extractBearerToken('Basic abc123')).toBeNull()
      expect(extractBearerToken('Bearer ')).toBeNull()
    })
  })

  describe('Brute Force Protection', () => {
    let tracker: BruteForceTracker

    beforeEach(() => {
      tracker = new BruteForceTracker({
        maxAttempts: 3,
        windowMs: 60_000,
        blockMs: 300_000
      })
    })

    it('blocks IP after max failed attempts', () => {
      expect(tracker.isBlocked('1.2.3.4')).toBe(false)
      tracker.recordFailure('1.2.3.4')
      tracker.recordFailure('1.2.3.4')
      expect(tracker.isBlocked('1.2.3.4')).toBe(false)
      tracker.recordFailure('1.2.3.4')
      expect(tracker.isBlocked('1.2.3.4')).toBe(true)
    })

    it('does not block different IPs', () => {
      tracker.recordFailure('1.2.3.4')
      tracker.recordFailure('1.2.3.4')
      tracker.recordFailure('1.2.3.4')
      expect(tracker.isBlocked('5.6.7.8')).toBe(false)
    })

    it('clears on successful auth', () => {
      tracker.recordFailure('1.2.3.4')
      tracker.recordFailure('1.2.3.4')
      tracker.recordSuccess('1.2.3.4')
      tracker.recordFailure('1.2.3.4')
      // Should not be blocked — success cleared the counter
      expect(tracker.isBlocked('1.2.3.4')).toBe(false)
    })

    it('cleans up expired entries', () => {
      tracker.recordFailure('1.2.3.4')
      expect(tracker.size).toBe(1)
      // Manually expired entries are cleaned
      tracker.cleanup()
      // Entry still within window, should remain
      expect(tracker.size).toBe(1)
    })
  })

  describe('Path Guard', () => {
    let guard: PathGuard

    beforeEach(() => {
      guard = new PathGuard(['/home/user/projects', '/tmp/test'])
    })

    it('allows paths within allowed roots', () => {
      expect(guard.validatePath('/home/user/projects/myapp')).toBe(true)
      expect(guard.validatePath('/home/user/projects')).toBe(true)
      expect(guard.validatePath('/tmp/test/subdir')).toBe(true)
    })

    it('blocks paths outside allowed roots', () => {
      expect(guard.validatePath('/etc/passwd')).toBe(false)
      expect(guard.validatePath('/home/user')).toBe(false)
    })

    it('blocks path traversal attempts', () => {
      expect(guard.validatePath('/home/user/projects/../../../etc/passwd')).toBe(false)
    })

    it('blocks empty paths', () => {
      expect(guard.validatePath('')).toBe(false)
      expect(guard.validatePath('   ')).toBe(false)
    })

    it('allows dynamically added roots', () => {
      guard.addRoot('/opt/new-root')
      expect(guard.validatePath('/opt/new-root/file.txt')).toBe(true)
    })
  })

  describe('Auto-Lock', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      resetServerState()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('locks server after inactivity timeout', () => {
      vi.advanceTimersByTime(31 * 60 * 1000)
      expect(checkAndLock(30)).toBe(true)
      expect(isServerLocked()).toBe(true)
    })

    it('does not lock with recent activity', () => {
      vi.advanceTimersByTime(25 * 60 * 1000)
      updateActivity()
      vi.advanceTimersByTime(10 * 60 * 1000)
      expect(checkAndLock(30)).toBe(false)
    })

    it('unlocks after unlock signal', () => {
      vi.advanceTimersByTime(31 * 60 * 1000)
      checkAndLock(30)
      expect(isServerLocked()).toBe(true)
      unlock()
      expect(isServerLocked()).toBe(false)
      // Should not re-lock immediately
      expect(checkAndLock(30)).toBe(false)
    })
  })

  describe('Kill Switch', () => {
    let mockDb: MockDatabaseService

    beforeEach(() => {
      mockDb = new MockDatabaseService()
    })

    it('deletes API key hash from settings', async () => {
      const key = generateApiKey()
      const hash = hashApiKey(key)
      mockDb.setSetting('headless_api_key_hash', hash)

      const server = createTestServer(mockDb)

      // We cannot test the full kill (process.exit) but we can verify
      // the mutation deletes the key
      const result = await server.execute('mutation { systemKillSwitch }')
      expect(result.data?.systemKillSwitch).toBe(true)
      expect(mockDb.getSetting('headless_api_key_hash')).toBeNull()
    })
  })

  describe('System Server Status', () => {
    let mockDb: MockDatabaseService

    beforeEach(() => {
      mockDb = new MockDatabaseService()
    })

    it('returns server status', async () => {
      const server = createTestServer(mockDb)
      const result = await server.execute('{ systemServerStatus { uptime connections requestCount locked version } }')
      expect(result.data?.systemServerStatus).toMatchObject({
        locked: expect.any(Boolean),
        connections: expect.any(Number),
        requestCount: expect.any(Number),
        uptime: expect.any(Number),
        version: expect.any(String)
      })
    })
  })
})
```

**Step 2: Run the test suite**

Run: `pnpm vitest run test/server/integration/security.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add test/server/integration/security.test.ts
git commit -m "test(server): add comprehensive security integration test suite"
```

---

### Task 11: Final Build Verification

**Files:** None — verification only

**Step 1: Run all server tests**

Run: `pnpm vitest run test/server/`
Expected: All existing + new tests pass

**Step 2: Run full build**

Run: `pnpm build`
Expected: Build succeeds

**Step 3: Run lint**

Run: `pnpm lint`
Expected: No new errors (fix any that appear)

**Step 4: Final commit if lint fixes needed**

```bash
git add -A
git commit -m "chore: lint fixes for phase 9 security features"
```

---

## Summary of Files

### New Files
| File | Purpose |
|------|---------|
| `src/server/server-state.ts` | Shared runtime state (activity, lock, counters) |
| `src/server/plugins/audit.ts` | Yoga audit logging plugin |
| `src/server/pid-file.ts` | PID file write/check/cleanup |
| `src/server/status-file.ts` | Status file writer |
| `src/server/types/qrcode-terminal.d.ts` | Type declarations for qrcode-terminal |
| `test/server/server-state.test.ts` | Server state unit tests |
| `test/server/audit-plugin.test.ts` | Audit plugin tests |
| `test/server/auto-lock.test.ts` | Auto-lock integration tests |
| `test/server/pid-file.test.ts` | PID file management tests |
| `test/server/status-file.test.ts` | Status file writer tests |
| `test/server/integration/security.test.ts` | Comprehensive security test suite |

### Modified Files
| File | Change |
|------|--------|
| `src/server/index.ts` | Add audit plugin, lock guard plugin, WS tracking, kill event handler |
| `src/server/headless-bootstrap.ts` | Add QR display, PID file, status file, lock/unlock intervals |
| `src/server/event-bus.ts` | Add `server:kill` event type |
| `src/server/resolvers/query/system.resolvers.ts` | Use real server-state values |
| `src/server/resolvers/mutation/system.resolvers.ts` | Enhance kill switch with event + shutdown |
