# Phase 3 — Server Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the core GraphQL server infrastructure so `hive --headless` starts a functional GraphQL server with authentication, TLS, and management commands.

**Architecture:** Headless mode shares services (Database, Git, OpenCode) with GUI mode but replaces window/IPC with a GraphQL server (yoga + HTTPS + WebSocket). Auth via `hive_`-prefixed API keys with SHA-256 hash stored in SQLite. Self-signed ECDSA TLS certs auto-generated on first run.

**Tech Stack:** graphql-yoga, graphql-ws, ws, Node.js crypto, openssl (CLI), better-sqlite3

---

### Task 1: Build Config Prerequisites

**Files:**
- Modify: `tsconfig.node.json`
- Modify: `vitest.config.ts`
- Modify: `test/setup.ts`

**Step 1: Add `src/server` and `src/shared` to tsconfig.node.json includes**

In `tsconfig.node.json`, add `src/server/**/*` and `src/shared/**/*` to the `include` array:

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.node.json",
  "include": [
    "electron.vite.config.*",
    "src/main/**/*",
    "src/preload/**/*",
    "src/server/**/*",
    "src/shared/**/*"
  ],
  "compilerOptions": {
    "composite": true,
    "types": ["electron-vite/node"],
    "baseUrl": ".",
    "paths": {
      "@main/*": ["src/main/*"],
      "@preload/*": ["src/preload/*"]
    }
  }
}
```

**Step 2: Add server test environment to vitest.config.ts**

Add `environmentMatchGlobs` so `test/server/**` runs in `node` environment:

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [
      ['test/server/**', 'node']
    ]
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
    },
  },
})
```

**Step 3: Guard window mocks in test/setup.ts**

Wrap the existing window mocking code in `test/setup.ts` with a guard so it doesn't fail in node environment:

At the very top of `test/setup.ts`, find the first `Object.defineProperty(window, ...)` or window mock block and wrap the entire contents in:

```typescript
if (typeof window !== 'undefined') {
  // ... all existing window mocking code stays here unchanged ...
}
```

**Step 4: Verify existing tests still pass**

Run: `pnpm build && pnpm test`
Expected: All existing tests pass. Build succeeds.

**Step 5: Commit**

```bash
git add tsconfig.node.json vitest.config.ts test/setup.ts
git commit -m "chore: configure build and test for server module"
```

---

### Task 2: GraphQL Context (Session 19)

**Files:**
- Modify: `src/server/context.ts`

**Step 1: Complete the GraphQLContext interface**

Replace the placeholder in `src/server/context.ts` with the full interface:

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

**Step 2: Verify it compiles**

Run: `pnpm build`
Expected: Build succeeds with no errors.

**Step 3: Commit**

```bash
git add src/server/context.ts
git commit -m "feat(server): complete GraphQLContext interface with all service types"
```

---

### Task 3: Auth Key Utilities (Session 22)

**Files:**
- Create: `src/server/plugins/auth.ts`
- Create: `test/server/auth-key.test.ts`

**Step 1: Write the failing tests**

Create `test/server/auth-key.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { generateApiKey, hashApiKey, verifyApiKey } from '../../src/server/plugins/auth'

describe('generateApiKey', () => {
  it('returns a string starting with hive_', () => {
    const key = generateApiKey()
    expect(key.startsWith('hive_')).toBe(true)
  })

  it('returns different keys each call', () => {
    const key1 = generateApiKey()
    const key2 = generateApiKey()
    expect(key1).not.toBe(key2)
  })

  it('returns a key longer than 40 characters', () => {
    const key = generateApiKey()
    expect(key.length).toBeGreaterThan(40)
  })
})

describe('hashApiKey', () => {
  it('returns consistent hash for same input', () => {
    const key = 'hive_test123'
    expect(hashApiKey(key)).toBe(hashApiKey(key))
  })

  it('returns 64 hex characters (SHA-256)', () => {
    const hash = hashApiKey('hive_test123')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns different hashes for different inputs', () => {
    expect(hashApiKey('hive_key1')).not.toBe(hashApiKey('hive_key2'))
  })
})

describe('verifyApiKey', () => {
  it('returns true for correct key', () => {
    const key = generateApiKey()
    const hash = hashApiKey(key)
    expect(verifyApiKey(key, hash)).toBe(true)
  })

  it('returns false for wrong key', () => {
    const key = generateApiKey()
    const hash = hashApiKey(key)
    expect(verifyApiKey('hive_wrong_key', hash)).toBe(false)
  })

  it('returns false for empty key', () => {
    const hash = hashApiKey('hive_test')
    expect(verifyApiKey('', hash)).toBe(false)
  })

  it('returns false for hash length mismatch', () => {
    const key = generateApiKey()
    expect(verifyApiKey(key, 'short')).toBe(false)
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/auth-key.test.ts`
Expected: FAIL — cannot find module `../../src/server/plugins/auth`

**Step 3: Implement the auth key utilities**

Create `src/server/plugins/auth.ts`:

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

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/server/auth-key.test.ts`
Expected: All 9 tests PASS.

**Step 5: Commit**

```bash
git add src/server/plugins/auth.ts test/server/auth-key.test.ts
git commit -m "feat(server): add API key generation, hashing, and verification"
```

---

### Task 4: Path Guard (Session 26)

**Files:**
- Create: `src/server/plugins/path-guard.ts`
- Create: `test/server/path-guard.test.ts`

**Step 1: Write the failing tests**

Create `test/server/path-guard.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { PathGuard } from '../../src/server/plugins/path-guard'

describe('PathGuard', () => {
  let guard: PathGuard

  beforeEach(() => {
    guard = new PathGuard(['/home/user/projects', '/tmp/hive'])
  })

  it('accepts valid path under allowed root', () => {
    expect(guard.validatePath('/home/user/projects/myapp/src/index.ts')).toBe(true)
  })

  it('accepts path exactly matching root', () => {
    expect(guard.validatePath('/home/user/projects')).toBe(true)
  })

  it('accepts deeply nested valid path', () => {
    expect(guard.validatePath('/home/user/projects/a/b/c/d/e/f.txt')).toBe(true)
  })

  it('rejects path with ../ escaping root', () => {
    expect(guard.validatePath('/home/user/projects/../../../etc/passwd')).toBe(false)
  })

  it('rejects absolute path outside all roots', () => {
    expect(guard.validatePath('/etc/passwd')).toBe(false)
  })

  it('rejects empty path', () => {
    expect(guard.validatePath('')).toBe(false)
  })

  it('rejects whitespace-only path', () => {
    expect(guard.validatePath('   ')).toBe(false)
  })

  it('accepts path under second root', () => {
    expect(guard.validatePath('/tmp/hive/data.json')).toBe(true)
  })

  it('addRoot allows new paths', () => {
    expect(guard.validatePath('/opt/newroot/file.txt')).toBe(false)
    guard.addRoot('/opt/newroot')
    expect(guard.validatePath('/opt/newroot/file.txt')).toBe(true)
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/path-guard.test.ts`
Expected: FAIL — cannot find module

**Step 3: Implement PathGuard**

Create `src/server/plugins/path-guard.ts`:

```typescript
import { resolve, normalize } from 'node:path'

export class PathGuard {
  private allowedRoots: string[]

  constructor(roots: string[]) {
    this.allowedRoots = roots.map((r) => normalize(resolve(r)))
  }

  addRoot(root: string): void {
    this.allowedRoots.push(normalize(resolve(root)))
  }

  validatePath(inputPath: string): boolean {
    if (!inputPath || inputPath.trim() === '') return false
    const resolved = normalize(resolve(inputPath))
    return this.allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + '/')
    )
  }
}

export const PATH_ARG_NAMES = [
  'worktreePath',
  'filePath',
  'dirPath',
  'cwd',
  'path',
  'projectPath'
]
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/server/path-guard.test.ts`
Expected: All 9 tests PASS.

**Step 5: Commit**

```bash
git add src/server/plugins/path-guard.ts test/server/path-guard.test.ts
git commit -m "feat(server): add PathGuard for path traversal prevention"
```

---

### Task 5: Config Loader (Session 28)

**Files:**
- Create: `src/server/config.ts`
- Create: `test/server/config.test.ts`

**Step 1: Write the failing tests**

Create `test/server/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadHeadlessConfig, type HeadlessConfig } from '../../src/server/config'

describe('loadHeadlessConfig', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `hive-config-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns defaults when config file does not exist', () => {
    const config = loadHeadlessConfig(join(tempDir, 'nonexistent.json'))
    expect(config.port).toBe(8443)
    expect(config.bindAddress).toBe('0.0.0.0')
    expect(config.security.bruteForceMaxAttempts).toBe(5)
    expect(config.security.bruteForceWindowSec).toBe(60)
    expect(config.security.bruteForceBlockSec).toBe(300)
  })

  it('merges partial config with defaults', () => {
    const configPath = join(tempDir, 'headless.json')
    writeFileSync(configPath, JSON.stringify({ port: 9443 }))
    const config = loadHeadlessConfig(configPath)
    expect(config.port).toBe(9443)
    expect(config.bindAddress).toBe('0.0.0.0')
    expect(config.security.bruteForceMaxAttempts).toBe(5)
  })

  it('returns defaults for invalid JSON', () => {
    const configPath = join(tempDir, 'headless.json')
    writeFileSync(configPath, 'not valid json {{{')
    const config = loadHeadlessConfig(configPath)
    expect(config.port).toBe(8443)
  })

  it('merges nested security settings', () => {
    const configPath = join(tempDir, 'headless.json')
    writeFileSync(
      configPath,
      JSON.stringify({ security: { bruteForceMaxAttempts: 10 } })
    )
    const config = loadHeadlessConfig(configPath)
    expect(config.security.bruteForceMaxAttempts).toBe(10)
    expect(config.security.bruteForceBlockSec).toBe(300)
  })

  it('merges nested TLS paths', () => {
    const configPath = join(tempDir, 'headless.json')
    writeFileSync(
      configPath,
      JSON.stringify({ tls: { certPath: '/custom/cert.pem' } })
    )
    const config = loadHeadlessConfig(configPath)
    expect(config.tls.certPath).toBe('/custom/cert.pem')
    expect(config.tls.keyPath).toContain('server.key')
  })

  it('returns defaults for empty JSON object', () => {
    const configPath = join(tempDir, 'headless.json')
    writeFileSync(configPath, '{}')
    const config = loadHeadlessConfig(configPath)
    expect(config.port).toBe(8443)
    expect(config.bindAddress).toBe('0.0.0.0')
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/config.test.ts`
Expected: FAIL — cannot find module

**Step 3: Implement config loader**

Create `src/server/config.ts`:

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

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const targetVal = result[key as keyof T]
    const sourceVal = source[key]
    if (
      targetVal &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal) &&
      sourceVal &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal)
    ) {
      ;(result as Record<string, unknown>)[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      )
    } else if (sourceVal !== undefined) {
      ;(result as Record<string, unknown>)[key] = sourceVal
    }
  }
  return result
}

export function loadHeadlessConfig(
  configPath?: string
): HeadlessConfig {
  const path = configPath ?? join(homedir(), '.hive', 'headless.json')
  if (!existsSync(path)) return { ...DEFAULTS, tls: { ...DEFAULTS.tls }, security: { ...DEFAULTS.security } }

  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    return deepMerge(
      { ...DEFAULTS, tls: { ...DEFAULTS.tls }, security: { ...DEFAULTS.security } },
      parsed
    )
  } catch {
    console.warn('Failed to parse headless config, using defaults')
    return { ...DEFAULTS, tls: { ...DEFAULTS.tls }, security: { ...DEFAULTS.security } }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/server/config.test.ts`
Expected: All 6 tests PASS.

**Step 5: Commit**

```bash
git add src/server/config.ts test/server/config.test.ts
git commit -m "feat(server): add headless config loader with deep merge and defaults"
```

---

### Task 6: TLS Certificate Generation (Session 27)

**Files:**
- Create: `src/server/tls.ts`
- Create: `test/server/tls.test.ts`

**Step 1: Write the failing tests**

Create `test/server/tls.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { generateTlsCerts, getCertFingerprint } from '../../src/server/tls'

describe('TLS Certificate Generation', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `hive-tls-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('generates cert and key files', () => {
    generateTlsCerts(tempDir)
    expect(existsSync(join(tempDir, 'server.crt'))).toBe(true)
    expect(existsSync(join(tempDir, 'server.key'))).toBe(true)
  })

  it('generates a valid fingerprint (64 hex chars)', () => {
    generateTlsCerts(tempDir)
    const fingerprint = getCertFingerprint(join(tempDir, 'server.crt'))
    expect(fingerprint).toHaveLength(64)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does NOT overwrite existing certs (idempotent)', () => {
    generateTlsCerts(tempDir)
    const certPath = join(tempDir, 'server.crt')
    const firstMtime = statSync(certPath).mtimeMs

    // Small delay to ensure mtime would differ
    const start = Date.now()
    while (Date.now() - start < 50) { /* busy wait */ }

    generateTlsCerts(tempDir)
    const secondMtime = statSync(certPath).mtimeMs
    expect(secondMtime).toBe(firstMtime)
  })

  it('generates cert readable by Node.js TLS', () => {
    generateTlsCerts(tempDir)
    const cert = readFileSync(join(tempDir, 'server.crt'), 'utf-8')
    const key = readFileSync(join(tempDir, 'server.key'), 'utf-8')

    // This throws if cert/key are invalid
    expect(() => {
      tls.createSecureContext({ cert, key })
    }).not.toThrow()
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/tls.test.ts`
Expected: FAIL — cannot find module

**Step 3: Implement TLS generation**

Create `src/server/tls.ts`:

```typescript
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'

export function generateTlsCerts(outputDir: string): void {
  const certPath = join(outputDir, 'server.crt')
  const keyPath = join(outputDir, 'server.key')

  // Idempotent: do not overwrite existing certs
  if (existsSync(certPath) && existsSync(keyPath)) return

  mkdirSync(outputDir, { recursive: true })

  // Generate ECDSA P-256 private key
  execSync(
    `openssl ecparam -genkey -name prime256v1 -noout -out "${keyPath}"`,
    { stdio: 'pipe' }
  )

  // Generate self-signed certificate (10 years)
  execSync(
    `openssl req -new -x509 -key "${keyPath}" -out "${certPath}" -days 3650 -subj "/CN=hive-headless"`,
    { stdio: 'pipe' }
  )
}

export function getCertFingerprint(certPath: string): string {
  const certPem = readFileSync(certPath, 'utf-8')
  // Extract DER from PEM
  const b64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s/g, '')
  const der = Buffer.from(b64, 'base64')
  return crypto.createHash('sha256').update(der).digest('hex')
}

export function ensureTlsCerts(
  tlsDir: string,
  storeFingerprintFn: (fingerprint: string) => void
): string {
  const certPath = join(tlsDir, 'server.crt')
  const keyPath = join(tlsDir, 'server.key')

  generateTlsCerts(tlsDir)

  const fingerprint = getCertFingerprint(certPath)
  storeFingerprintFn(fingerprint)

  return fingerprint
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/server/tls.test.ts`
Expected: All 4 tests PASS. (Requires `openssl` on PATH.)

**Step 5: Commit**

```bash
git add src/server/tls.ts test/server/tls.test.ts
git commit -m "feat(server): add TLS certificate generation with ECDSA P-256"
```

---

### Task 7: Auth Verification Plugin (Session 23)

**Files:**
- Modify: `src/server/plugins/auth.ts`
- Create: `test/server/auth-plugin.test.ts`

**Step 1: Write the failing tests**

Create `test/server/auth-plugin.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  extractBearerToken,
  hashApiKey,
  generateApiKey,
  verifyApiKey
} from '../../src/server/plugins/auth'

describe('extractBearerToken', () => {
  it('extracts token from valid Bearer header', () => {
    expect(extractBearerToken('Bearer hive_abc123')).toBe('hive_abc123')
  })

  it('returns null for missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull()
    expect(extractBearerToken(null as unknown as string)).toBeNull()
  })

  it('returns null for non-Bearer scheme', () => {
    expect(extractBearerToken('Basic abc123')).toBeNull()
  })

  it('returns null for Bearer with empty token', () => {
    expect(extractBearerToken('Bearer ')).toBeNull()
    expect(extractBearerToken('Bearer')).toBeNull()
  })
})

describe('auth verification flow', () => {
  it('valid key verifies against stored hash', () => {
    const key = generateApiKey()
    const hash = hashApiKey(key)
    expect(verifyApiKey(key, hash)).toBe(true)
  })

  it('invalid key does not verify', () => {
    const key = generateApiKey()
    const hash = hashApiKey(key)
    const wrongKey = generateApiKey()
    expect(verifyApiKey(wrongKey, hash)).toBe(false)
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/auth-plugin.test.ts`
Expected: FAIL — `extractBearerToken` is not exported

**Step 3: Add extractBearerToken to auth.ts**

Append to `src/server/plugins/auth.ts`:

```typescript
export function extractBearerToken(header: string | undefined | null): string | null {
  if (!header || typeof header !== 'string') return null
  const parts = header.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null
  const token = parts[1]
  if (!token || token.trim() === '') return null
  return token
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/server/auth-plugin.test.ts`
Expected: All 6 tests PASS.

**Step 5: Commit**

```bash
git add src/server/plugins/auth.ts test/server/auth-plugin.test.ts
git commit -m "feat(server): add Bearer token extraction for auth plugin"
```

---

### Task 8: Brute Force Protection (Session 24)

**Files:**
- Modify: `src/server/plugins/auth.ts`
- Create: `test/server/auth-brute-force.test.ts`

**Step 1: Write the failing tests**

Create `test/server/auth-brute-force.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BruteForceTracker } from '../../src/server/plugins/auth'

describe('BruteForceTracker', () => {
  let tracker: BruteForceTracker

  beforeEach(() => {
    tracker = new BruteForceTracker({
      maxAttempts: 5,
      windowMs: 60_000,
      blockMs: 300_000
    })
  })

  it('allows requests below threshold', () => {
    for (let i = 0; i < 4; i++) {
      tracker.recordFailure('192.168.1.1')
    }
    expect(tracker.isBlocked('192.168.1.1')).toBe(false)
  })

  it('blocks IP after reaching max attempts', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('192.168.1.1')
    }
    expect(tracker.isBlocked('192.168.1.1')).toBe(true)
  })

  it('returns true from isBlocked during block period', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('10.0.0.1')
    }
    expect(tracker.isBlocked('10.0.0.1')).toBe(true)
  })

  it('unblocks after block period expires', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('10.0.0.2')
    }
    expect(tracker.isBlocked('10.0.0.2')).toBe(true)

    // Advance time past block period
    vi.spyOn(Date, 'now').mockReturnValue(now + 300_001)
    expect(tracker.isBlocked('10.0.0.2')).toBe(false)

    vi.restoreAllMocks()
  })

  it('tracks different IPs independently', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('1.1.1.1')
    }
    expect(tracker.isBlocked('1.1.1.1')).toBe(true)
    expect(tracker.isBlocked('2.2.2.2')).toBe(false)
  })

  it('does not track successful auth (recordSuccess clears)', () => {
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure('3.3.3.3')
    }
    tracker.recordSuccess('3.3.3.3')
    // After success, counter should be cleared
    expect(tracker.isBlocked('3.3.3.3')).toBe(false)
  })

  it('cleanup removes stale entries', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    tracker.recordFailure('old.ip')

    // Advance past window + block period
    vi.spyOn(Date, 'now').mockReturnValue(now + 400_000)
    tracker.cleanup()

    // Entry should be gone, IP should not be blocked
    expect(tracker.isBlocked('old.ip')).toBe(false)
    expect(tracker.size).toBe(0)

    vi.restoreAllMocks()
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/auth-brute-force.test.ts`
Expected: FAIL — `BruteForceTracker` is not exported

**Step 3: Add BruteForceTracker class to auth.ts**

Append to `src/server/plugins/auth.ts`:

```typescript
interface BruteForceEntry {
  attempts: number
  firstAttempt: number
  blockedUntil: number
}

interface BruteForceOpts {
  maxAttempts: number
  windowMs: number
  blockMs: number
}

export class BruteForceTracker {
  private map = new Map<string, BruteForceEntry>()
  private opts: BruteForceOpts

  constructor(opts: BruteForceOpts) {
    this.opts = opts
  }

  get size(): number {
    return this.map.size
  }

  recordFailure(ip: string): void {
    const now = Date.now()
    const entry = this.map.get(ip)

    if (!entry || now - entry.firstAttempt > this.opts.windowMs) {
      this.map.set(ip, { attempts: 1, firstAttempt: now, blockedUntil: 0 })
      return
    }

    entry.attempts++
    if (entry.attempts >= this.opts.maxAttempts) {
      entry.blockedUntil = now + this.opts.blockMs
    }
  }

  recordSuccess(ip: string): void {
    this.map.delete(ip)
  }

  isBlocked(ip: string): boolean {
    const entry = this.map.get(ip)
    if (!entry) return false
    if (entry.blockedUntil === 0) return false
    if (Date.now() > entry.blockedUntil) {
      this.map.delete(ip)
      return false
    }
    return true
  }

  cleanup(): void {
    const now = Date.now()
    for (const [ip, entry] of this.map) {
      const expiry = entry.blockedUntil > 0
        ? entry.blockedUntil
        : entry.firstAttempt + this.opts.windowMs
      if (now > expiry) {
        this.map.delete(ip)
      }
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/server/auth-brute-force.test.ts`
Expected: All 7 tests PASS.

**Step 5: Commit**

```bash
git add src/server/plugins/auth.ts test/server/auth-brute-force.test.ts
git commit -m "feat(server): add brute force protection tracker"
```

---

### Task 9: Resolver Merger + Server Entry Point (Session 20)

**Files:**
- Create: `src/server/resolvers/index.ts`
- Create: `src/server/index.ts`

**Step 1: Create the empty resolver merger**

Create `src/server/resolvers/index.ts`:

```typescript
export function mergeResolvers() {
  return {}
}
```

**Step 2: Create the GraphQL server entry point**

Create `src/server/index.ts`:

```typescript
import { createYoga, createSchema } from 'graphql-yoga'
import { useServer } from 'graphql-ws/lib/use/ws'
import { createServer } from 'node:https'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import type { GraphQLContext } from './context'
import { mergeResolvers } from './resolvers'
import { extractBearerToken, verifyApiKey, BruteForceTracker } from './plugins/auth'

function loadSchemaSDL(): string {
  const schemaDir = join(__dirname, '..', '..', 'src', 'server', 'schema')
  const files: string[] = []

  function collectGraphql(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        collectGraphql(fullPath)
      } else if (entry.name.endsWith('.graphql')) {
        files.push(readFileSync(fullPath, 'utf-8'))
      }
    }
  }

  collectGraphql(schemaDir)
  return files.join('\n')
}

export interface ServerOptions {
  port: number
  bindAddress: string
  tlsCert: string
  tlsKey: string
  context: Omit<GraphQLContext, 'clientIp' | 'authenticated'>
  getKeyHash: () => string
  bruteForce: BruteForceTracker
}

export interface ServerHandle {
  close: () => Promise<void>
}

export function startGraphQLServer(opts: ServerOptions): ServerHandle {
  const typeDefs = loadSchemaSDL()
  const resolvers = mergeResolvers()

  const yoga = createYoga<GraphQLContext>({
    schema: createSchema({ typeDefs, resolvers }),
    graphqlEndpoint: '/graphql',
    context: ({ request }) => {
      const clientIp =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        'unknown'
      const token = extractBearerToken(request.headers.get('authorization'))
      let authenticated = false

      if (token) {
        const hash = opts.getKeyHash()
        if (verifyApiKey(token, hash)) {
          authenticated = true
          opts.bruteForce.recordSuccess(clientIp)
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
  })

  const httpsServer = createServer(
    {
      cert: readFileSync(opts.tlsCert),
      key: readFileSync(opts.tlsKey)
    },
    yoga
  )

  const wss = new WebSocketServer({
    server: httpsServer,
    path: yoga.graphqlEndpoint
  })

  useServer(
    {
      execute: (args) => args.rootValue as never,
      subscribe: (args) => args.rootValue as never,
      context: (ctx) => ({
        ...opts.context,
        clientIp: ctx.extra.request.socket.remoteAddress || 'unknown',
        authenticated: true
      }),
      onConnect: (ctx) => {
        const apiKey = ctx.connectionParams?.apiKey as string | undefined
        if (!apiKey) return false
        const hash = opts.getKeyHash()
        if (!verifyApiKey(apiKey, hash)) return false
        return true
      }
    },
    wss
  )

  httpsServer.listen(opts.port, opts.bindAddress)

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close(() => {
          httpsServer.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      })
  }
}
```

**Step 3: Verify it compiles**

Run: `pnpm build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add src/server/resolvers/index.ts src/server/index.ts
git commit -m "feat(server): add GraphQL server entry point with yoga + HTTPS + WebSocket"
```

---

### Task 10: Headless Bootstrap (Session 21)

**Files:**
- Create: `src/server/headless-bootstrap.ts`

**Step 1: Create the headless bootstrap function**

Create `src/server/headless-bootstrap.ts`:

```typescript
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadHeadlessConfig } from './config'
import { ensureTlsCerts, generateTlsCerts, getCertFingerprint } from './tls'
import { generateApiKey, hashApiKey, BruteForceTracker } from './plugins/auth'
import { getEventBus } from './event-bus'
import { startGraphQLServer, type ServerHandle } from './index'
import { getDatabase } from '../main/db'
import { resolveClaudeBinaryPath } from '../main/services/claude-binary-resolver'
import { ClaudeCodeImplementer } from '../main/services/claude-code-implementer'
import { AgentSdkManager } from '../main/services/agent-sdk-manager'
import type { AgentSdkImplementer } from '../main/services/agent-sdk-types'
import { rmSync } from 'node:fs'

export interface HeadlessBootstrapOpts {
  port?: number
  bind?: string
}

let serverHandle: ServerHandle | null = null

export async function headlessBootstrap(opts: HeadlessBootstrapOpts): Promise<void> {
  const config = loadHeadlessConfig()
  const port = opts.port ?? config.port
  const bind = opts.bind ?? config.bindAddress

  // Initialize database (same singleton as GUI mode)
  const db = getDatabase()

  // Resolve Claude binary
  const claudeBinaryPath = resolveClaudeBinaryPath()

  // Create AgentSdkManager (headless — no mainWindow)
  const claudeImpl = new ClaudeCodeImplementer()
  claudeImpl.setDatabaseService(db)
  claudeImpl.setClaudeBinaryPath(claudeBinaryPath)

  const openCodePlaceholder = {
    id: 'opencode' as const,
    capabilities: {
      supportsUndo: true,
      supportsRedo: true,
      supportsCommands: true,
      supportsPermissionRequests: true,
      supportsQuestionPrompts: true,
      supportsModelSelection: true,
      supportsReconnect: true,
      supportsPartialStreaming: true
    },
    connect: async () => ({ sessionId: '' }),
    reconnect: async () => ({ success: false }),
    disconnect: async () => {},
    cleanup: async () => {},
    prompt: async () => {},
    abort: async () => false,
    getMessages: async () => [],
    getAvailableModels: async () => ({}),
    getModelInfo: async () => null,
    setSelectedModel: () => {},
    getSessionInfo: async () => ({ revertMessageID: null, revertDiff: null }),
    questionReply: async () => {},
    questionReject: async () => {},
    permissionReply: async () => {},
    permissionList: async () => [],
    undo: async () => ({}),
    redo: async () => ({}),
    listCommands: async () => [],
    sendCommand: async () => {},
    renameSession: async () => {},
    setMainWindow: () => {}
  } satisfies AgentSdkImplementer
  const sdkManager = new AgentSdkManager(openCodePlaceholder, claudeImpl)

  // EventBus singleton
  const eventBus = getEventBus()

  // Ensure TLS certs
  const tlsDir = join(homedir(), '.hive', 'tls')
  const fingerprint = ensureTlsCerts(tlsDir, (fp) => {
    db.setSetting('headless_cert_fingerprint', fp)
  })

  // Ensure API key
  let existingHash = db.getSetting('headless_api_key_hash')
  if (!existingHash) {
    const newKey = generateApiKey()
    existingHash = hashApiKey(newKey)
    db.setSetting('headless_api_key_hash', existingHash)
    console.log('\n=== Hive Headless API Key (save this!) ===')
    console.log(newKey)
    console.log('==========================================\n')
  }

  // Brute force tracker
  const bruteForce = new BruteForceTracker({
    maxAttempts: config.security.bruteForceMaxAttempts,
    windowMs: config.security.bruteForceWindowSec * 1000,
    blockMs: config.security.bruteForceBlockSec * 1000
  })

  // Periodic cleanup
  const cleanupInterval = setInterval(() => bruteForce.cleanup(), 60_000)

  // Start GraphQL server
  serverHandle = startGraphQLServer({
    port,
    bindAddress: bind,
    tlsCert: config.tls.certPath,
    tlsKey: config.tls.keyPath,
    context: { db, sdkManager, eventBus },
    getKeyHash: () => db.getSetting('headless_api_key_hash') || '',
    bruteForce
  })

  console.log(`Hive headless server running on https://${bind}:${port}/graphql`)
  console.log(`TLS fingerprint: ${fingerprint}`)

  // Handle shutdown
  process.on('SIGTERM', async () => {
    clearInterval(cleanupInterval)
    await serverHandle?.close()
    process.exit(0)
  })
  process.on('SIGINT', async () => {
    clearInterval(cleanupInterval)
    await serverHandle?.close()
    process.exit(0)
  })
}

export interface ManagementCommandOpts {
  rotateKey?: boolean
  regenCerts?: boolean
  showStatus?: boolean
  kill?: boolean
  unlock?: boolean
}

export async function handleManagementCommand(opts: ManagementCommandOpts): Promise<void> {
  const db = getDatabase()
  const hiveDir = join(homedir(), '.hive')

  if (opts.rotateKey) {
    const newKey = generateApiKey()
    const hash = hashApiKey(newKey)
    db.setSetting('headless_api_key_hash', hash)
    console.log('\n=== New API Key ===')
    console.log(newKey)
    console.log('===================\n')
    console.log('API key rotated successfully. Update your mobile app.')
  }

  if (opts.regenCerts) {
    const tlsDir = join(hiveDir, 'tls')
    // Remove old certs
    rmSync(join(tlsDir, 'server.crt'), { force: true })
    rmSync(join(tlsDir, 'server.key'), { force: true })
    // Regenerate
    generateTlsCerts(tlsDir)
    const fingerprint = getCertFingerprint(join(tlsDir, 'server.crt'))
    db.setSetting('headless_cert_fingerprint', fingerprint)
    console.log('TLS certificates regenerated.')
    console.log(`New fingerprint: ${fingerprint}`)
  }

  if (opts.showStatus) {
    const statusPath = join(hiveDir, 'hive-headless.status.json')
    try {
      const { readFileSync } = await import('node:fs')
      const status = JSON.parse(readFileSync(statusPath, 'utf-8'))
      console.log(JSON.stringify(status, null, 2))
    } catch {
      console.log('No running headless server found (no status file).')
    }
  }

  if (opts.kill) {
    const pidPath = join(hiveDir, 'hive-headless.pid')
    try {
      const { readFileSync } = await import('node:fs')
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim())
      process.kill(pid, 'SIGTERM')
      console.log(`Sent SIGTERM to PID ${pid}`)
    } catch {
      console.log('No running headless server found (no PID file).')
    }
  }

  if (opts.unlock) {
    db.setSetting('headless_locked', '')
    console.log('Headless server unlocked.')
  }
}
```

**Step 2: Verify it compiles**

Run: `pnpm build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/server/headless-bootstrap.ts
git commit -m "feat(server): add headless bootstrap and management commands"
```

---

### Task 11: CLI Flag Parsing (Session 29)

**Files:**
- Modify: `src/main/index.ts` (lines 42-43)

**Step 1: Add headless CLI flag parsing**

In `src/main/index.ts`, after line 43 (`const isLogMode = cliArgs.includes('--log')`), add:

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

**Step 2: Verify build and existing tests**

Run: `pnpm build && pnpm test`
Expected: Build succeeds. All existing tests pass. No behavior change (new variables are unused so far).

**Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(server): parse --headless and management CLI flags"
```

---

### Task 12: Headless Startup Branch (Session 30)

**Files:**
- Modify: `src/main/index.ts` (inside `app.whenReady()` callback, around line 315)

**Step 1: Add the headless startup branch**

In `src/main/index.ts`, inside the `app.whenReady().then(() => {` callback, after `fixPath()` (line 318) and after `resolveClaudeBinaryPath()` (line 321) and after the `electronApp.setAppUserModelId` call (line 334), but BEFORE `getDatabase()` (line 338), add the headless branch:

```typescript
  // --- Headless mode ---
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
  // --- End headless mode ---
```

**Important:** The `app.whenReady().then(() => {` callback must become `async` for the `await` to work. Change line 315 from:

```typescript
app.whenReady().then(() => {
```

to:

```typescript
app.whenReady().then(async () => {
```

**Step 2: Verify build and existing tests**

Run: `pnpm build && pnpm test`
Expected: Build succeeds. All existing tests still pass. Desktop mode is completely unaffected — the new code only runs when `isHeadless` is true.

**Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(server): add --headless startup branch to main entry point"
```

---

### Task 13: Final Integration Verification

**Step 1: Run full build**

Run: `pnpm build`
Expected: Clean build with no errors.

**Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass (existing + new server tests).

**Step 3: Run server tests in isolation**

Run: `pnpm vitest run test/server/`
Expected: All server tests pass:
- `auth-key.test.ts` — 9 tests
- `auth-plugin.test.ts` — 6 tests
- `auth-brute-force.test.ts` — 7 tests
- `path-guard.test.ts` — 9 tests
- `config.test.ts` — 6 tests
- `tls.test.ts` — 4 tests
- `event-bus.test.ts` — 8 tests (existing)

Total: ~49 tests

**Step 4: Commit final state (if any remaining changes)**

```bash
git add -A
git commit -m "chore: Phase 3 complete — server core with auth, TLS, and headless CLI"
```

---

## Parallelization Guide

When implementing, these tasks can run in parallel:

**Parallel batch 1 (after Task 1):**
- Task 2 (auth keys)
- Task 3 (context) — no test, fast
- Task 4 (path guard)
- Task 5 (config)
- Task 6 (TLS)

**Parallel batch 2 (after batch 1):**
- Task 7 (auth plugin)
- Task 8 (brute force)

**Sequential (after batch 2):**
- Task 9 (resolver merger + server entry)
- Task 10 (headless bootstrap)
- Task 11 (CLI flag parsing)
- Task 12 (headless startup branch)
- Task 13 (final verification)
