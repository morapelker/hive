# Phase 9 — Security & Operations (Sessions 88–99)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 9 adds all remaining security features and operational tooling for the headless server. This includes audit logging, auto-lock (idle timeout), kill switch, QR code pairing display, key rotation, certificate regeneration, PID file management, status file reporting, and a comprehensive security test suite.

At the end of this phase, the headless server is production-ready with full security hardening.

## Prerequisites

- Phases 1-8 completed: full GraphQL server with all queries, mutations, and subscriptions.
- Auth plugin with API key verification and brute force protection (Phase 3, Sessions 22-25).
- Path guard plugin (Phase 3, Session 26).
- TLS certificate generation (Phase 3, Session 27).
- Config loader (Phase 3, Session 28).
- CLI flag parsing and headless startup branch (Phase 3, Sessions 29-30).

## Key Source Files (Read-Only Reference)

| File | Purpose |
|------|---------|
| `src/server/plugins/auth.ts` | API key generation, hashing, verification, brute force protection |
| `src/server/plugins/path-guard.ts` | Path traversal prevention |
| `src/server/config.ts` | Config loader with defaults |
| `src/server/index.ts` | Server entry point |
| `src/server/headless-bootstrap.ts` | Headless startup sequence |
| `src/main/index.ts` lines 42-43 | CLI flag parsing |
| `src/main/db/schema.ts` | Database schema + settings table |

## Architecture Notes

### Audit Logging

The audit plugin is a yoga plugin that logs every request with timing, operation name, IP, and result status. Sensitive operations (terminal, script, git push, kill switch) get extra detail logged. Logs go to the existing Winston logger at `~/Library/Logs/hive/`.

### Auto-Lock

After `inactivityTimeoutMin` (default 30 minutes) with no authenticated requests, the server enters "locked" mode. In locked mode, ALL requests return a specific GraphQL error (`SERVER_LOCKED`) except `systemServerStatus` (which returns the locked status). The server is unlocked via `hive --headless --unlock` CLI command.

### Kill Switch

The `systemKillSwitch` mutation immediately:
1. Invalidates the API key (deletes hash from settings)
2. Closes all WebSocket connections
3. Stops accepting new connections
4. Logs the kill event
5. Shuts down the server process

Also accessible via `hive --headless --kill` CLI command (sends SIGTERM to the PID from the PID file).

### QR Code Pairing

On first headless start, the server generates an API key and displays it in the terminal along with a QR code. The QR code payload is a JSON string containing `{ host, port, key, certFingerprint }`. The mobile app scans this QR code to establish the connection.

---

## Session 88: Audit Logging Plugin

**Goal:** Create a yoga plugin that logs every GraphQL request.

**Definition of Done:** Every request is logged with operation name, IP, timing, and status.

**Tasks:**

1. `[server]` Create `src/server/plugins/audit.ts`:
   ```typescript
   import { Plugin } from 'graphql-yoga'
   import { log } from '../../main/services/logger'

   export function createAuditPlugin(): Plugin {
     return {
       onExecute({ args }) {
         const start = Date.now()
         const operationName = args.operationName || 'anonymous'
         const clientIp = args.contextValue.clientIp || 'unknown'

         return {
           onExecuteDone({ result }) {
             const duration = Date.now() - start
             const hasErrors = result.errors && result.errors.length > 0

             log.info(`[audit] ${operationName} from ${clientIp} - ${duration}ms${hasErrors ? ' [ERROR]' : ''}`)

             if (hasErrors) {
               log.warn(`[audit] ${operationName} errors:`, result.errors.map(e => e.message))
             }
           }
         }
       }
     }
   }
   ```

2. `[server]` Register the audit plugin in `src/server/index.ts` yoga configuration:
   ```typescript
   plugins: [authPlugin, auditPlugin, pathGuardPlugin]
   ```

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 89: Sensitive Operation Logging

**Goal:** Add extra audit detail for sensitive operations.

**Definition of Done:** Terminal, script, git push, and kill switch operations are logged with additional context.

**Tasks:**

1. `[server]` Enhance the audit plugin to detect sensitive operations:
   ```typescript
   const SENSITIVE_OPS = new Set([
     'terminalCreate', 'terminalWrite',
     'scriptRunSetup', 'scriptRunProject',
     'gitPush', 'gitCommit', 'gitMerge', 'gitDeleteBranch',
     'systemKillSwitch',
     'fileWrite'
   ])
   ```

2. `[server]` For sensitive operations, log additional context:
   - `terminalCreate`/`terminalWrite`: log `worktreeId`
   - `scriptRunSetup`/`scriptRunProject`: log `worktreeId`, `cwd`
   - `gitPush`/`gitCommit`: log `worktreePath`
   - `systemKillSwitch`: log `clientIp`, timestamp with WARNING level
   - `fileWrite`: log `filePath`

3. `[server]` Log format:
   ```
   [audit:sensitive] terminalWrite from 192.168.1.5 - worktreeId=wt-abc123
   [audit:sensitive] gitPush from 192.168.1.5 - worktreePath=/home/user/projects/myapp/main
   [audit:sensitive] systemKillSwitch from 192.168.1.5 - SERVER KILL INITIATED
   ```

4. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 90: Auto-Lock — Activity Tracking

**Goal:** Track the timestamp of the last authenticated request.

**Definition of Done:** Every successful authenticated request updates a `lastActivityAt` timestamp.

**Tasks:**

1. `[server]` Add activity tracking to the auth plugin in `src/server/plugins/auth.ts`:
   ```typescript
   let lastActivityAt = Date.now()

   export function getLastActivityAt(): number {
     return lastActivityAt
   }

   export function updateActivity(): void {
     lastActivityAt = Date.now()
   }
   ```

2. `[server]` Call `updateActivity()` on every successful authenticated request in the auth plugin's `onExecute` hook.

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 91: Auto-Lock — Lock Mode

**Goal:** Implement the locked state that blocks all API calls after inactivity timeout.

**Definition of Done:** After `inactivityTimeoutMin` with no requests, server enters locked mode. All requests return `SERVER_LOCKED` error except `systemServerStatus`.

**Tasks:**

1. `[server]` Add lock state management:
   ```typescript
   let isLocked = false

   export function checkAndLock(timeoutMinutes: number): boolean {
     if (isLocked) return true
     const elapsed = Date.now() - getLastActivityAt()
     if (elapsed > timeoutMinutes * 60 * 1000) {
       isLocked = true
       log.warn('[security] Server auto-locked after inactivity')
       return true
     }
     return false
   }

   export function unlock(): void {
     isLocked = false
     updateActivity()
     log.info('[security] Server unlocked')
   }

   export function isServerLocked(): boolean {
     return isLocked
   }
   ```

2. `[server]` Add a check in the auth plugin that runs BEFORE authentication:
   ```typescript
   // In the auth plugin onExecute hook:
   if (checkAndLock(config.security.inactivityTimeoutMin)) {
     // Allow systemServerStatus through even when locked
     if (operationName !== 'systemServerStatus') {
       throw new GraphQLError('Server is locked due to inactivity. Use --unlock to resume.', {
         extensions: { code: 'SERVER_LOCKED' }
       })
     }
   }
   ```

3. `[server]` Set up a periodic check (every 60 seconds) in the headless bootstrap to trigger lock:
   ```typescript
   setInterval(() => {
     checkAndLock(config.security.inactivityTimeoutMin)
   }, 60_000)
   ```

4. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 92: Auto-Lock — Unlock CLI

**Goal:** Implement `hive --headless --unlock` to resume a locked server.

**Definition of Done:** Running `--unlock` clears the lock state and the server resumes normal operation.

**Tasks:**

1. `[server]` The `--unlock` CLI command (in `src/main/index.ts`) needs to communicate with the running server process. Two approaches:
   - **Option A (recommended):** Write a signal file (`~/.hive/hive-headless.unlock`) that the running server watches.
   - **Option B:** Send a SIGUSR1 signal to the PID from the PID file.

2. `[server]` Implement Option A:
   - `--unlock` command writes `~/.hive/hive-headless.unlock` file and exits.
   - Running server watches for this file (via `fs.watch` or periodic check).
   - When detected, calls `unlock()` and deletes the file.
   ```typescript
   // In headless bootstrap:
   const unlockPath = path.join(hiveDir, 'hive-headless.unlock')
   setInterval(() => {
     if (fs.existsSync(unlockPath)) {
       fs.unlinkSync(unlockPath)
       unlock()
     }
   }, 5_000) // Check every 5 seconds
   ```

3. `[server]` In `src/main/index.ts` headless one-shot commands:
   ```typescript
   if (isUnlock) {
     const unlockPath = path.join(hiveDir, 'hive-headless.unlock')
     fs.writeFileSync(unlockPath, Date.now().toString())
     console.log('Unlock signal sent. Server will resume within 5 seconds.')
     app.quit()
     return
   }
   ```

4. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 93: Kill Switch Implementation

**Goal:** Implement `systemKillSwitch` mutation and `--kill` CLI command.

**Definition of Done:** Kill switch invalidates the API key, closes all connections, and shuts down the server.

**Tasks:**

1. `[server]` Implement `systemKillSwitch` mutation in `src/server/resolvers/mutation/system.resolvers.ts`:
   ```typescript
   systemKillSwitch: async (_parent, _args, ctx) => {
     // 1. Log the kill event
     log.warn('[security] Kill switch activated')

     // 2. Delete API key hash from settings
     ctx.db.setting.delete('headless_api_key_hash')
     ctx.db.setting.delete('headless_key_created_at')

     // 3. Close all WebSocket connections
     ctx.eventBus.emit('server:kill', {})

     // 4. Schedule server shutdown after a brief delay (let this response return)
     setTimeout(() => {
       process.exit(0)
     }, 500)

     return true
   }
   ```

2. `[server]` In the server entry point, listen for the kill event:
   ```typescript
   eventBus.on('server:kill', () => {
     wss.clients.forEach(client => client.close(1000, 'Server killed'))
     server.close()
   })
   ```

3. `[server]` Implement `--kill` CLI command in `src/main/index.ts`:
   ```typescript
   if (isKill) {
     const pidPath = path.join(hiveDir, 'hive-headless.pid')
     if (fs.existsSync(pidPath)) {
       const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim())
       try {
         process.kill(pid, 'SIGTERM')
         console.log(`Sent SIGTERM to headless server (PID ${pid})`)
       } catch (error) {
         console.error(`Failed to kill process ${pid}:`, error.message)
       }
     } else {
       console.error('No PID file found. Is the headless server running?')
     }
     app.quit()
     return
   }
   ```

4. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 94: QR Code Pairing

**Goal:** Display API key and QR code on first headless start.

**Definition of Done:** First run generates key, displays it in terminal, and shows scannable QR code.

**Tasks:**

1. `[server]` In `src/server/headless-bootstrap.ts`, after key generation:
   ```typescript
   import qrcode from 'qrcode-terminal'

   // Generate new key if none exists
   const existingHash = db.setting.get('headless_api_key_hash')
   if (!existingHash) {
     const apiKey = generateApiKey()
     const hash = hashApiKey(apiKey)
     db.setting.set('headless_api_key_hash', hash)
     db.setting.set('headless_key_created_at', new Date().toISOString())

     const certFingerprint = db.setting.get('headless_cert_fingerprint') || ''

     const pairingPayload = JSON.stringify({
       host: getLocalIp(),
       port: config.port,
       key: apiKey,
       certFingerprint
     })

     console.log('\n=== Hive Headless Server — First Run Setup ===\n')
     console.log(`API Key: ${apiKey}`)
     console.log(`Port: ${config.port}`)
     console.log(`Cert Fingerprint: ${certFingerprint}\n`)
     console.log('Scan this QR code with the Hive mobile app:\n')
     qrcode.generate(pairingPayload, { small: true })
     console.log('\n⚠️  Save your API key now — it cannot be shown again.')
     console.log('Use --rotate-key to generate a new key if needed.\n')
   }
   ```

2. `[server]` Create helper `getLocalIp()`:
   ```typescript
   import os from 'node:os'

   function getLocalIp(): string {
     const interfaces = os.networkInterfaces()
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

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 95: Key Rotation

**Goal:** Implement `--rotate-key` CLI command.

**Definition of Done:** Running `--rotate-key` generates a new key, invalidates the old one, and displays the new key + QR code.

**Tasks:**

1. `[server]` In `src/main/index.ts` headless one-shot commands:
   ```typescript
   if (isRotateKey) {
     const db = getDatabase()
     const apiKey = generateApiKey()
     const hash = hashApiKey(apiKey)

     // Overwrite existing key hash
     db.setting.set('headless_api_key_hash', hash)
     db.setting.set('headless_key_created_at', new Date().toISOString())

     const certFingerprint = db.setting.get('headless_cert_fingerprint') || ''
     const config = loadHeadlessConfig()

     const pairingPayload = JSON.stringify({
       host: getLocalIp(),
       port: config.port,
       key: apiKey,
       certFingerprint
     })

     console.log('\n=== API Key Rotated ===\n')
     console.log(`New API Key: ${apiKey}`)
     console.log('\nScan this QR code with the Hive mobile app:\n')
     qrcode.generate(pairingPayload, { small: true })
     console.log('\n⚠️  The old key is now invalid. Update your mobile app.')
     console.log('If the headless server is running, restart it.\n')

     app.quit()
     return
   }
   ```

2. `[server]` Note: The running server will automatically reject the old key on next request because it reads the hash from the DB on each verification. No restart needed for key invalidation.

3. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 96: Cert Regeneration

**Goal:** Implement `--regen-certs` CLI command.

**Definition of Done:** Running `--regen-certs` deletes old certs, generates new ones, and updates the fingerprint.

**Tasks:**

1. `[server]` In `src/main/index.ts` headless one-shot commands:
   ```typescript
   if (isRegenCerts) {
     const tlsDir = path.join(hiveDir, 'tls')

     // Delete old certs
     const certPath = path.join(tlsDir, 'server.crt')
     const keyPath = path.join(tlsDir, 'server.key')
     if (fs.existsSync(certPath)) fs.unlinkSync(certPath)
     if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath)

     // Regenerate
     generateTlsCerts(tlsDir)
     const fingerprint = getCertFingerprint(certPath)

     const db = getDatabase()
     db.setting.set('headless_cert_fingerprint', fingerprint)

     console.log('\n=== TLS Certificates Regenerated ===\n')
     console.log(`New Fingerprint: ${fingerprint}`)
     console.log('\n⚠️  Update the certificate fingerprint in your mobile app.')
     console.log('Restart the headless server if it is running.\n')

     app.quit()
     return
   }
   ```

2. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 97: PID File

**Goal:** Write and manage `~/.hive/hive-headless.pid` for the running headless server.

**Definition of Done:** PID file created on startup, deleted on shutdown, stale PID files detected.

**Tasks:**

1. `[server]` In `src/server/headless-bootstrap.ts`, after server starts:
   ```typescript
   const pidPath = path.join(hiveDir, 'hive-headless.pid')

   // Check for stale PID file
   if (fs.existsSync(pidPath)) {
     const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim())
     try {
       // Check if process is still running (signal 0 = check existence)
       process.kill(existingPid, 0)
       console.error(`Headless server already running (PID ${existingPid}). Use --kill to stop it.`)
       process.exit(1)
     } catch {
       // Process not running, stale PID file
       log.info(`Removing stale PID file (PID ${existingPid} not running)`)
     }
   }

   // Write PID file
   fs.writeFileSync(pidPath, process.pid.toString())

   // Clean up on exit
   const cleanupPid = () => {
     try { fs.unlinkSync(pidPath) } catch {}
   }
   process.on('exit', cleanupPid)
   process.on('SIGTERM', () => { cleanupPid(); process.exit(0) })
   process.on('SIGINT', () => { cleanupPid(); process.exit(0) })
   ```

2. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 98: Status File

**Goal:** Write `~/.hive/hive-headless.status.json` every 30 seconds with server status.

**Definition of Done:** Status file updated periodically with uptime, connections, request count, lock state.

**Tasks:**

1. `[server]` In `src/server/headless-bootstrap.ts`, set up status file writer:
   ```typescript
   const statusPath = path.join(hiveDir, 'hive-headless.status.json')
   const startTime = Date.now()
   let requestCount = 0

   // Increment request count from audit plugin
   export function incrementRequestCount() { requestCount++ }

   const writeStatus = () => {
     const status = {
       pid: process.pid,
       port: config.port,
       uptime: Math.floor((Date.now() - startTime) / 1000),
       uptimeFormatted: formatUptime(Date.now() - startTime),
       connections: wss.clients.size,
       requestCount,
       locked: isServerLocked(),
       lastActivityAt: new Date(getLastActivityAt()).toISOString(),
       version: app.getVersion(),
       startedAt: new Date(startTime).toISOString()
     }
     fs.writeFileSync(statusPath, JSON.stringify(status, null, 2))
   }

   // Write immediately and then every 30 seconds
   writeStatus()
   const statusInterval = setInterval(writeStatus, 30_000)

   // Clean up on exit
   process.on('exit', () => {
     clearInterval(statusInterval)
     try { fs.unlinkSync(statusPath) } catch {}
   })
   ```

2. `[server]` Implement `--show-status` CLI command in `src/main/index.ts`:
   ```typescript
   if (isShowStatus) {
     const statusPath = path.join(hiveDir, 'hive-headless.status.json')
     if (fs.existsSync(statusPath)) {
       const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'))
       console.log('\n=== Hive Headless Server Status ===\n')
       console.log(`PID:          ${status.pid}`)
       console.log(`Port:         ${status.port}`)
       console.log(`Uptime:       ${status.uptimeFormatted}`)
       console.log(`Connections:  ${status.connections}`)
       console.log(`Requests:     ${status.requestCount}`)
       console.log(`Locked:       ${status.locked ? 'YES' : 'no'}`)
       console.log(`Last Activity: ${status.lastActivityAt}`)
       console.log(`Version:      ${status.version}`)
       console.log(`Started:      ${status.startedAt}\n`)
     } else {
       console.log('No status file found. Is the headless server running?')
     }
     app.quit()
     return
   }
   ```

3. `[server]` Wire `incrementRequestCount()` into the audit plugin.

4. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 99: Security Test Suite

**Goal:** Comprehensive tests for all security features.

**Definition of Done:** Tests for auth, brute force, path guard, auto-lock, kill switch, and audit logging all pass.

**Tasks:**

1. `[server]` Create `test/server/integration/security.test.ts`:
   ```typescript
   import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

   describe('Security', () => {
     describe('Authentication', () => {
       it('rejects request with no auth header', async () => {
         const res = await fetch(serverUrl, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ query: '{ systemAppVersion }' })
         })
         const data = await res.json()
         expect(data.errors[0].extensions.code).toBe('UNAUTHENTICATED')
       })

       it('rejects request with invalid key', async () => {
         const res = await fetchWithAuth('invalid_key', '{ systemAppVersion }')
         const data = await res.json()
         expect(data.errors[0].extensions.code).toBe('UNAUTHENTICATED')
       })

       it('accepts request with valid key', async () => {
         const res = await fetchWithAuth(validKey, '{ systemAppVersion }')
         const data = await res.json()
         expect(data.data.systemAppVersion).toBeTruthy()
       })
     })

     describe('Brute Force Protection', () => {
       it('blocks IP after 5 failed attempts', async () => {
         for (let i = 0; i < 5; i++) {
           await fetchWithAuth('wrong_key', '{ systemAppVersion }')
         }
         const res = await fetchWithAuth('wrong_key', '{ systemAppVersion }')
         expect(res.status).toBe(429)
       })

       it('does not block successful auth from same IP', async () => {
         // Mix of failed and successful
         await fetchWithAuth('wrong_key', '{ systemAppVersion }')
         const res = await fetchWithAuth(validKey, '{ systemAppVersion }')
         const data = await res.json()
         expect(data.data.systemAppVersion).toBeTruthy()
       })
     })

     describe('Path Guard', () => {
       it('blocks path traversal in worktreePath', async () => {
         const res = await fetchWithAuth(validKey, `{
           gitFileStatuses(worktreePath: "/etc/../../../etc/passwd")
         }`)
         const data = await res.json()
         expect(data.errors[0].message).toContain('path')
       })

       it('allows valid project path', async () => {
         const res = await fetchWithAuth(validKey, `{
           gitFileStatuses(worktreePath: "${validWorktreePath}")
         }`)
         const data = await res.json()
         expect(data.errors).toBeUndefined()
       })
     })

     describe('Auto-Lock', () => {
       it('locks server after inactivity timeout', async () => {
         // Fast-forward time past the inactivity timeout
         vi.advanceTimersByTime(31 * 60 * 1000) // 31 minutes
         checkAndLock(30)

         const res = await fetchWithAuth(validKey, '{ projects { id } }')
         const data = await res.json()
         expect(data.errors[0].extensions.code).toBe('SERVER_LOCKED')
       })

       it('allows systemServerStatus when locked', async () => {
         vi.advanceTimersByTime(31 * 60 * 1000)
         checkAndLock(30)

         const res = await fetchWithAuth(validKey, '{ systemServerStatus { locked } }')
         const data = await res.json()
         expect(data.data.systemServerStatus.locked).toBe(true)
       })

       it('unlocks after unlock signal', async () => {
         vi.advanceTimersByTime(31 * 60 * 1000)
         checkAndLock(30)
         unlock()

         const res = await fetchWithAuth(validKey, '{ projects { id } }')
         const data = await res.json()
         expect(data.errors).toBeUndefined()
       })
     })

     describe('Kill Switch', () => {
       it('invalidates API key', async () => {
         await fetchWithAuth(validKey, 'mutation { systemKillSwitch }')
         // After kill, key should be invalid
         const res = await fetchWithAuth(validKey, '{ systemAppVersion }')
         const data = await res.json()
         expect(data.errors[0].extensions.code).toBe('UNAUTHENTICATED')
       })
     })

     describe('WebSocket Auth', () => {
       it('rejects WS connection with no credentials', async () => {
         const client = createClient({
           url: wsUrl,
           webSocketImpl: WebSocket,
           connectionParams: {}
         })
         await expect(connectAndSubscribe(client)).rejects.toThrow()
       })

       it('accepts WS connection with valid credentials', async () => {
         const client = createClient({
           url: wsUrl,
           webSocketImpl: WebSocket,
           connectionParams: { apiKey: validKey }
         })
         const sub = client.iterate({ query: 'subscription { worktreeBranchRenamed { worktreeId } }' })
         // Should not throw
         client.dispose()
       })
     })
   })
   ```

2. `[server]` Tests require:
   - Test server with all plugins enabled
   - Configurable inactivity timeout (set to a short value for tests)
   - Access to `checkAndLock`, `unlock`, `isServerLocked` functions
   - `vi.useFakeTimers()` for auto-lock timeout tests

3. `[server]` Run tests:

**Verification:**
```bash
pnpm vitest run test/server/integration/security.test.ts && pnpm build
```

---

## Summary of Files Created

```
src/server/plugins/
  audit.ts                          — Audit logging plugin (enhanced in sessions 88-89)

test/server/integration/
  security.test.ts                  — Comprehensive security test suite
```

## Summary of Files Modified

| File | Change |
|------|--------|
| `src/server/plugins/auth.ts` | Add activity tracking, auto-lock state, unlock function |
| `src/server/index.ts` | Register audit plugin, add kill event handler |
| `src/server/headless-bootstrap.ts` | Add QR code display, PID file, status file, unlock watcher, auto-lock interval |
| `src/main/index.ts` | Add --rotate-key, --regen-certs, --show-status, --kill, --unlock one-shot commands |

## What Comes Next

Phase 10 (Server Testing & Regression, Sessions 100-105) ensures comprehensive test coverage across all resolvers, subscriptions, and security features, plus regression testing to verify the desktop app is unaffected.
