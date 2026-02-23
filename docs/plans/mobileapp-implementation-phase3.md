# Phase 3 — Server Core (Sessions 19–31)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 3 builds the core GraphQL server infrastructure: the context factory, server entry point (yoga + HTTPS + WebSocket), headless bootstrap sequence, authentication system (API key generation, verification plugin, brute force protection, WebSocket auth), path guard plugin, TLS certificate generation, config loader, and headless CLI flag handling in `src/main/index.ts`. At the end of this phase, `hive --headless` starts a functional (but mostly empty) GraphQL server with authentication and TLS.

## Prerequisites

- Phase 1 completed: shared types, EventBus, dependencies installed.
- Phase 2 completed: SDL schema files, codegen generating resolver types.
- Key files from Phase 2: `src/server/__generated__/resolvers-types.ts`, all `.graphql` schema files.

## Key Source Files (Read-Only Reference)

| File | Purpose |
|------|---------|
| `src/main/index.ts` | Electron main entry — currently 466 lines. `app.whenReady()` at line 315, `createWindow()` at line 356, CLI flag parsing at line 42-43. Headless branch goes BEFORE `createWindow()`. |
| `src/main/db/index.ts` | `getDatabase()` singleton — returns `DatabaseService` |
| `src/main/services/agent-sdk-manager.ts` | `AgentSdkManager` class — manages OpenCode + ClaudeCode implementers |
| `src/main/services/claude-code-implementer.ts` | `ClaudeCodeImplementer` class |
| `src/main/services/claude-binary-resolver.ts` | `resolveClaudeBinaryPath()` |
| `src/server/event-bus.ts` | `getEventBus()` singleton (from Phase 1) |
| `src/server/__generated__/resolvers-types.ts` | Generated resolver types (from Phase 2) |

## Architecture Notes

**Dual startup mode:**
- **GUI mode** (default): `hive` → creates BrowserWindow, registers IPC handlers, normal desktop app
- **Headless mode** (new): `hive --headless --port 8443` → no window, starts GraphQL server

Both modes share the same services (Database, Git, OpenCode, Scripts, Terminal). The difference is:
- GUI mode: `createWindow()` + IPC handlers
- Headless mode: `headlessBootstrap()` + GraphQL server

**Auth model:** 256-bit random API key with `hive_` prefix. SHA-256 hash stored in SQLite `settings` table. Timing-safe comparison. Brute force protection: 5 failures per IP per 60s → 300s block. Authenticated users are NEVER rate-limited.

**TLS:** Self-signed ECDSA P-256 cert, auto-generated on first headless run. Stored at `~/.hive/tls/`. Fingerprint stored in settings for QR pairing.

---

## Session 19: GraphQL Context

**Goal:** Create the context interface that carries all services to resolvers.

**Definition of Done:** `GraphQLContext` type defined, importable, compiles clean.

**Tasks:**

1. `[server]` Create `src/server/context.ts` exporting `GraphQLContext` interface:
   ```typescript
   import type { DatabaseService } from '../main/db/database'
   import type { AgentSdkManager } from '../main/services/agent-sdk-manager'
   import type { EventBus } from './event-bus'

   export interface GraphQLContext {
     db: DatabaseService
     sdkManager: AgentSdkManager
     eventBus: EventBus
     clientIp: string
     authenticated: boolean
   }
   ```
   Note: Import paths may need adjustment based on actual file locations. The `DatabaseService` type should be imported from wherever it's defined (check `src/main/db/` for the actual export).

2. `[server]` Verify it compiles: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 20: Server Entry Point

**Goal:** Create the `startGraphQLServer` function that creates the yoga instance + HTTPS server + WebSocket server.

**Definition of Done:** Function exists, can be called with options (port, cert, key, context), starts HTTPS+WS server. Returns a handle for graceful shutdown.

**Tasks:**

1. `[server]` Create `src/server/index.ts` with `startGraphQLServer(opts)` function:
   - Import `createYoga` and `createSchema` from `graphql-yoga`
   - Import `useServer` from `graphql-ws/lib/use/ws`
   - Import `createServer` from `node:https`
   - Import `WebSocketServer` from `ws`
   - Read SDL schema files (use `readFileSync` to load all `.graphql` files from `src/server/schema/`)
   - Create yoga instance with `createSchema({ typeDefs, resolvers })`
   - Create HTTPS server with TLS cert/key
   - Create WebSocketServer on the same server at yoga's endpoint path
   - Wire `graphql-ws` using `useServer()`
   - Return handle with `close()` method

   Key implementation notes:
   - The resolver merger starts empty (`{}`) — resolvers are added incrementally in Phases 4-8
   - Use `yoga.graphqlEndpoint` for the WS path
   - The HTTPS server needs `readFileSync(opts.tlsCert)` and `readFileSync(opts.tlsKey)`
   - WebSocket auth is handled in Session 25

2. `[server]` Create `src/server/resolvers/index.ts` — empty resolver merger:
   ```typescript
   export function mergeResolvers() {
     return {}
   }
   ```
   This will be incrementally populated as resolver files are added in Phases 4-8.

3. `[server]` Verify it compiles: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 21: Headless Bootstrap

**Goal:** Create the bootstrap sequence for headless mode.

**Definition of Done:** `headlessBootstrap()` function that initializes services and starts the GraphQL server.

**Tasks:**

1. `[server]` Create `src/server/headless-bootstrap.ts` with `headlessBootstrap(opts)` function:
   - Load config from `~/.hive/headless.json` (Session 28)
   - Initialize database: call `getDatabase()` (same as GUI mode uses in `src/main/index.ts` line 338)
   - Run `fixPath()` (same as GUI mode, line 318)
   - Resolve Claude binary path: `resolveClaudeBinaryPath()`
   - Create `AgentSdkManager` (same pattern as `src/main/index.ts` lines 372-409, but without `mainWindow`)
   - Get EventBus singleton: `getEventBus()`
   - Ensure TLS certs exist (generate if needed — Session 27)
   - Ensure API key exists (generate if needed — Session 22)
   - Display API key + QR code on first run (Session 94)
   - Call `startGraphQLServer()` with assembled options
   - Log startup info: port, bind address, cert fingerprint

   The opts parameter:
   ```typescript
   interface HeadlessBootstrapOpts {
     port?: number
     bind?: string
   }
   ```

2. `[server]` Verify it compiles: `pnpm build`

**Note:** This function will evolve as Sessions 22-28 are implemented. Initial version can stub out TLS/auth/config with TODOs.

---

## Session 22: Auth — API Key Generation

**Goal:** Implement key generation, hashing, and storage utilities.

**Definition of Done:** Can generate `hive_` prefixed keys, hash them, store hash in DB, verify keys with timing-safe comparison.

**Tasks:**

1. `[server]` Create key utilities in `src/server/plugins/auth.ts`:
   ```typescript
   import crypto from 'node:crypto'

   export function generateApiKey(): string {
     return 'hive_' + crypto.randomBytes(32).toString('base64url')
   }

   export function hashApiKey(key: string): string {
     return crypto.createHash('sha256').update(key).digest('hex')
   }

   export function verifyApiKey(key: string, storedHash: string): boolean {
     const keyHash = hashApiKey(key)
     const keyBuf = Buffer.from(keyHash, 'hex')
     const storedBuf = Buffer.from(storedHash, 'hex')
     if (keyBuf.length !== storedBuf.length) return false
     return crypto.timingSafeEqual(keyBuf, storedBuf)
   }
   ```

2. `[server]` Write tests in `test/server/auth-key.test.ts`:
   - `generateApiKey()` returns string starting with `hive_`
   - `generateApiKey()` returns different keys each call
   - `generateApiKey()` key length is reasonable (> 40 chars)
   - `hashApiKey()` returns consistent hash for same input
   - `hashApiKey()` returns 64 hex chars (SHA-256)
   - `verifyApiKey()` returns true for correct key
   - `verifyApiKey()` returns false for wrong key
   - `verifyApiKey()` returns false for empty key
   - `verifyApiKey()` returns false for hash length mismatch

3. `[server]` Run tests: `pnpm vitest run test/server/auth-key.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/auth-key.test.ts
```

---

## Session 23: Auth — Verification Plugin

**Goal:** Create yoga plugin that verifies Bearer token on every request.

**Definition of Done:** Plugin rejects unauthenticated requests with 401, accepts valid Bearer token.

**Tasks:**

1. `[server]` Implement `createAuthPlugin(getKeyHash)` in `src/server/plugins/auth.ts`:
   - This is a graphql-yoga plugin using the `useExtendContext` or `onRequest` hook
   - Reads `Authorization: Bearer hive_...` header from each request
   - Extracts the key after "Bearer "
   - Calls `verifyApiKey(key, storedHash)` to compare
   - If invalid: throws GraphQL error with code UNAUTHENTICATED (401)
   - If valid: extends context with `authenticated: true`
   - The `getKeyHash` is a function `() => string` that reads the hash from DB settings

2. `[server]` Write tests in `test/server/auth-plugin.test.ts`:
   - Request with valid Bearer token → 200 OK, `authenticated: true` in context
   - Request with no Authorization header → 401 UNAUTHENTICATED error
   - Request with invalid Bearer token → 401
   - Request with malformed header (no "Bearer" prefix) → 401
   - Request with "Bearer " but empty token → 401

3. `[server]` Run tests: `pnpm vitest run test/server/auth-plugin.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/auth-plugin.test.ts
```

---

## Session 24: Auth — Brute Force Protection

**Goal:** Block IPs after 5 failed auth attempts within 60 seconds.

**Definition of Done:** 5 failures per IP per minute → 300s block. Authenticated users NEVER rate-limited.

**Tasks:**

1. `[server]` Implement brute force tracker in `src/server/plugins/auth.ts`:
   ```typescript
   interface BruteForceEntry {
     attempts: number
     firstAttempt: number
     blockedUntil: number
   }

   const bruteForceMap = new Map<string, BruteForceEntry>()
   ```
   - On failed auth: increment attempts for IP. If ≥5 within 60s → set `blockedUntil = Date.now() + 300_000`
   - On blocked IP requesting → return 429 Too Many Requests BEFORE even checking key
   - On successful auth → do NOT track or rate-limit at all
   - Cleanup stale entries every 60s (entries older than blockSec + windowSec)
   - Make thresholds configurable via config: `maxAttempts`, `windowSec`, `blockSec`

2. `[server]` Write tests in `test/server/auth-brute-force.test.ts`:
   - 4 failed attempts → still allowed
   - 5th failed attempt from same IP → blocked (429)
   - Blocked IP → 429 response (even with correct key during block period)
   - After block period expires → unblocked
   - Successful auth from same IP → never blocked/tracked
   - Different IPs tracked independently
   - Stale entries cleaned up

3. `[server]` Run tests: `pnpm vitest run test/server/auth-brute-force.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/auth-brute-force.test.ts
```

---

## Session 25: Auth — WebSocket Auth

**Goal:** Verify API key during WebSocket handshake via connectionParams.

**Definition of Done:** Invalid key → connection rejected before upgrade. Valid key → connection accepted with authenticated context.

**Tasks:**

1. `[server]` In `src/server/index.ts`, configure `graphql-ws`'s `useServer` options:
   ```typescript
   useServer({
     execute: (args) => args.rootValue,
     subscribe: (args) => args.rootValue,
     context: (ctx) => ({
       ...baseContext,
       clientIp: ctx.extra.request.socket.remoteAddress || 'unknown',
       authenticated: true // already verified in onConnect
     }),
     onConnect: (ctx) => {
       const apiKey = ctx.connectionParams?.apiKey as string | undefined
       if (!apiKey) return false
       const hash = getKeyHash()
       if (!verifyApiKey(apiKey, hash)) return false
       return true // accepted
     }
   }, wss)
   ```

2. `[server]` Write test in `test/server/auth-ws.test.ts`:
   - WS connect with valid `apiKey` in connectionParams → connection established
   - WS connect with invalid `apiKey` → connection rejected (4403 or similar)
   - WS connect with no connectionParams → connection rejected
   - WS connect with empty apiKey → connection rejected

3. `[server]` Run tests: `pnpm vitest run test/server/auth-ws.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/auth-ws.test.ts
```

---

## Session 26: Path Guard Plugin

**Goal:** Prevent path traversal attacks by validating all file/directory path arguments.

**Definition of Done:** Paths outside allowed roots rejected, `../` traversals blocked.

**Tasks:**

1. `[server]` Create `src/server/plugins/path-guard.ts`:
   ```typescript
   import { resolve, normalize } from 'node:path'
   import { realpathSync } from 'node:fs'

   export class PathGuard {
     private allowedRoots: string[]

     constructor(roots: string[]) {
       this.allowedRoots = roots.map(r => normalize(resolve(r)))
     }

     addRoot(root: string): void {
       this.allowedRoots.push(normalize(resolve(root)))
     }

     validatePath(inputPath: string): boolean {
       if (!inputPath || inputPath.trim() === '') return false
       const resolved = normalize(resolve(inputPath))
       return this.allowedRoots.some(root => resolved.startsWith(root))
     }
   }
   ```
   - Create a yoga plugin that inspects GraphQL variables for known path argument names: `worktreePath`, `filePath`, `dirPath`, `cwd`, `path`, `projectPath`
   - For each found path, calls `pathGuard.validatePath()`
   - If invalid: throws GraphQL error "Path not allowed"
   - Allowed roots populated from: all project paths in DB, `~/.hive/`

2. `[server]` Write tests in `test/server/path-guard.test.ts`:
   - Valid path under allowed root → accepted
   - Path with `../` escaping root → rejected
   - Absolute path outside all roots → rejected
   - Path to `~/.hive/` → accepted (always allowed)
   - Empty path → rejected
   - Null/undefined → rejected
   - Path exactly matching root → accepted
   - Deeply nested valid path → accepted

3. `[server]` Run tests: `pnpm vitest run test/server/path-guard.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/path-guard.test.ts
```

---

## Session 27: TLS Certificate Generation

**Goal:** Auto-generate self-signed ECDSA P-256 TLS certificates on first headless run.

**Definition of Done:** Certs generated to `~/.hive/tls/`, fingerprint stored in settings, idempotent.

**Tasks:**

1. `[server]` Create `src/server/tls.ts`:
   - `generateTlsCerts(outputDir: string)`:
     - Creates `~/.hive/tls/` directory if not existing
     - Uses Node.js `crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })` to generate ECDSA P-256 key pair
     - Creates self-signed X.509 certificate (10-year validity)
     - NOTE: Node.js doesn't have built-in X.509 cert creation. Use `crypto.X509Certificate` for reading, but for creation either use a small library or shell out to `openssl` (preferred for simplicity):
       ```bash
       openssl req -new -x509 -key server.key -out server.crt -days 3650 -subj "/CN=hive-headless"
       ```
     - Alternatively, generate via `openssl ecparam -genkey -name prime256v1 | openssl ec -out server.key` and `openssl req -new -x509 -key server.key -out server.crt -days 3650 -subj "/CN=hive-headless"`
   - `getCertFingerprint(certPath: string): string`:
     - Reads cert, computes SHA-256 fingerprint of DER-encoded cert
     - Returns fingerprint as hex string (64 chars)
   - `ensureTlsCerts(db)`:
     - Check if certs exist at configured paths
     - If not: generate them, compute fingerprint, store in settings as `headless_cert_fingerprint`
     - If yes: verify they're valid, return existing fingerprint
   - Idempotent: does NOT overwrite existing certs

2. `[server]` Write tests in `test/server/tls.test.ts`:
   - Certs generated to temp dir (use `os.tmpdir()`)
   - Both `server.crt` and `server.key` files created
   - Fingerprint is 64 hex chars
   - Re-running does NOT overwrite existing certs (check mtime)
   - Generated cert is readable by Node.js `tls.createSecureContext`

3. `[server]` Run tests: `pnpm vitest run test/server/tls.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/tls.test.ts
```

---

## Session 28: Config Loader

**Goal:** Load `~/.hive/headless.json` with sensible defaults.

**Definition of Done:** Config merges user settings with defaults, handles missing file, handles invalid JSON.

**Tasks:**

1. `[server]` Create `src/server/config.ts`:
   ```typescript
   import { readFileSync, existsSync } from 'node:fs'
   import { join } from 'node:path'
   import { homedir } from 'node:os'

   export interface HeadlessConfig {
     port: number
     bindAddress: string
     tls: {
       certPath: string
       keyPath: string
     }
     security: {
       bruteForceMaxAttempts: number
       bruteForceWindowSec: number
       bruteForceBlockSec: number
       inactivityTimeoutMin: number
       allowedIps: string[]
     }
   }

   const DEFAULTS: HeadlessConfig = {
     port: 8443,
     bindAddress: '0.0.0.0',
     tls: {
       certPath: join(homedir(), '.hive', 'tls', 'server.crt'),
       keyPath: join(homedir(), '.hive', 'tls', 'server.key')
     },
     security: {
       bruteForceMaxAttempts: 5,
       bruteForceWindowSec: 60,
       bruteForceBlockSec: 300,
       inactivityTimeoutMin: 30,
       allowedIps: []
     }
   }

   export function loadHeadlessConfig(): HeadlessConfig {
     const configPath = join(homedir(), '.hive', 'headless.json')
     if (!existsSync(configPath)) return { ...DEFAULTS }

     try {
       const raw = readFileSync(configPath, 'utf-8')
       const parsed = JSON.parse(raw)
       return deepMerge(DEFAULTS, parsed)
     } catch {
       // Invalid JSON — log warning, return defaults
       console.warn('Failed to parse ~/.hive/headless.json, using defaults')
       return { ...DEFAULTS }
     }
   }
   ```
   - Implement `deepMerge` utility for nested config objects

2. `[server]` Write tests in `test/server/config.test.ts`:
   - Missing config file → returns defaults
   - Empty config file → returns defaults
   - Partial config (just `port: 9443`) → merged with defaults, port is 9443, rest is defaults
   - Invalid JSON → returns defaults with warning
   - Custom security settings → properly merged
   - Nested TLS paths → properly merged

3. `[server]` Run tests: `pnpm vitest run test/server/config.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/config.test.ts
```

---

## Session 29: Headless CLI — Flag Parsing

**Goal:** Parse `--headless` and related flags from `process.argv` in `src/main/index.ts`.

**Definition of Done:** CLI flags parsed, available to startup logic, desktop mode completely unaffected.

**Tasks:**

1. `[server]` Modify `src/main/index.ts` — add flag parsing after existing `cliArgs` (line 43):
   ```typescript
   const isHeadless = cliArgs.includes('--headless')
   const headlessPort = cliArgs.includes('--port')
     ? parseInt(cliArgs[cliArgs.indexOf('--port') + 1])
     : undefined
   const headlessBind = cliArgs.includes('--bind')
     ? cliArgs[cliArgs.indexOf('--bind') + 1]
     : undefined
   const isRotateKey = cliArgs.includes('--rotate-key')
   const isRegenCerts = cliArgs.includes('--regen-certs')
   const isShowStatus = cliArgs.includes('--show-status')
   const isKill = cliArgs.includes('--kill')
   const isUnlock = cliArgs.includes('--unlock')
   ```

2. `[server]` Verify `pnpm build` succeeds. Desktop mode is completely unaffected (all new code is behind `isHeadless` checks not yet wired).

**Verification:**
```bash
pnpm build && pnpm test
```

---

## Session 30: Headless CLI — Startup Branch

**Goal:** Add the `--headless` branch to `app.whenReady()` that starts GraphQL server instead of creating a window.

**Definition of Done:** `hive --headless` starts server, `hive` (no flag) starts desktop as before.

**Tasks:**

1. `[server]` Modify `src/main/index.ts` — in `app.whenReady()` callback, AFTER `getDatabase()` and BEFORE `createWindow()` (around line 340-356), add headless branch:
   ```typescript
   if (isHeadless) {
     log.info('Starting in headless mode')
     const { headlessBootstrap } = await import('../server/headless-bootstrap')
     await headlessBootstrap({ port: headlessPort, bind: headlessBind })
     return // Skip ALL window/IPC/menu setup below
   }
   ```
   - The `return` ensures NONE of the window/IPC/menu code runs in headless mode.
   - The dynamic import ensures the server code is only loaded when needed.
   - Note: `app.whenReady()` callback must be `async` for this to work.

2. `[server]` Also need to handle the IPC handler registrations that happen BEFORE `createWindow()`:
   - `registerDatabaseHandlers()`, `registerProjectHandlers()`, etc. at lines 342-348 should still run in headless mode (database handlers are needed)
   - OR the headless bootstrap handles its own DB init
   - Decision: Move the headless check BEFORE the IPC registrations to keep things clean. The headless bootstrap initializes DB on its own.

3. `[server]` Verify `pnpm build` succeeds.
4. `[server]` Verify `pnpm test` — all existing tests still pass.

**Verification:**
```bash
pnpm build && pnpm test
```

---

## Session 31: Headless CLI — Management Commands

**Goal:** Implement `--rotate-key`, `--regen-certs`, `--show-status`, `--kill`, `--unlock`.

**Definition of Done:** Each CLI command works as one-shot operation (run and exit).

**Tasks:**

1. `[server]` In `src/main/index.ts` headless branch, BEFORE calling `headlessBootstrap()`, handle one-shot commands:

   ```typescript
   if (isHeadless) {
     log.info('Starting in headless mode')

     // Handle one-shot management commands
     if (isRotateKey || isRegenCerts || isShowStatus || isKill || isUnlock) {
       const { handleManagementCommand } = await import('../server/headless-bootstrap')
       await handleManagementCommand({
         rotateKey: isRotateKey,
         regenCerts: isRegenCerts,
         showStatus: isShowStatus,
         kill: isKill,
         unlock: isUnlock
       })
       app.quit()
       return
     }

     // Normal headless startup
     const { headlessBootstrap } = await import('../server/headless-bootstrap')
     await headlessBootstrap({ port: headlessPort, bind: headlessBind })
     return
   }
   ```

2. `[server]` Implement `handleManagementCommand(opts)` in `src/server/headless-bootstrap.ts`:
   - `--rotate-key`: Initialize DB, generate new API key, store hash, display new key + QR code, log rotation
   - `--regen-certs`: Delete old certs from `~/.hive/tls/`, regenerate new certs, update fingerprint in DB
   - `--show-status`: Read `~/.hive/hive-headless.status.json`, pretty-print to stdout (uptime, connections, request count, locked state)
   - `--kill`: Read PID file `~/.hive/hive-headless.pid`, send SIGTERM to running process
   - `--unlock`: Initialize DB, delete auto-lock state from settings table

3. `[server]` Each command calls `app.quit()` after completing (they don't start the server).
4. `[server]` Verify `pnpm build` succeeds.

**Verification:**
```bash
pnpm build
```

---

## Summary of Files Created

```
src/server/
  index.ts                    — startGraphQLServer() with yoga + HTTPS + WS
  context.ts                  — GraphQLContext interface
  headless-bootstrap.ts       — headlessBootstrap() + handleManagementCommand()
  config.ts                   — loadHeadlessConfig() with defaults
  tls.ts                      — generateTlsCerts(), getCertFingerprint(), ensureTlsCerts()
  plugins/
    auth.ts                   — generateApiKey(), hashApiKey(), verifyApiKey(), createAuthPlugin(), brute force tracker
    path-guard.ts             — PathGuard class + yoga plugin
  resolvers/
    index.ts                  — Empty resolver merger (placeholder)

test/server/
  auth-key.test.ts            — API key generation/verification tests
  auth-plugin.test.ts         — Auth plugin tests
  auth-brute-force.test.ts    — Brute force protection tests
  auth-ws.test.ts             — WebSocket auth tests
  path-guard.test.ts          — Path traversal prevention tests
  tls.test.ts                 — TLS cert generation tests
  config.test.ts              — Config loader tests
```

## Summary of Files Modified

| File | Lines Changed | What |
|------|--------------|------|
| `src/main/index.ts` | ~25 | CLI flag parsing + headless startup branch + management commands |

## What Comes Next

Phase 4 (DB Resolvers) will implement the simplest resolvers — pure database CRUD operations that wrap the existing `DatabaseService` methods.
