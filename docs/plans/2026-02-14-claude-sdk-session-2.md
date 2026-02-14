# Session 2 — Claude Adapter Foundation (Main Process)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the real Claude SDK client wrapper, the adapter class implementing `AgentSdkImplementer`, and the SDK manager/router that dispatches operations to the correct adapter.

**Architecture:** `ClaudeCodeImplementer` wraps the Claude SDK's `query()` v1 API. It holds per-session state (`Query` instances, `AbortController`s, session ID mappings) and translates SDK interactions into `AgentSdkImplementer` method calls. An `AgentSdkManager` sits above both implementers and resolves the correct one from a session's `agent_sdk` value.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk@^0.2.42` (ESM, dynamic import), Vitest

---

## Decisions for This Session

| Decision            | Value                                             | Rationale                                                                        |
| ------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| SDK API version     | v1 `query()` API                                  | Stable, proven in reference project, `options.resume` for session continuity     |
| ESM import strategy | Dynamic `import()`                                | Same pattern as OpenCode SDK (`loadOpenCodeSDK` in `opencode-service.ts:99-105`) |
| Mock file status    | No existing mock — build fresh                    | `ClaudeCodeImplementer` doesn't exist yet; create from scratch                   |
| Manager scope       | Create `AgentSdkManager` in this session          | IPC rewiring deferred to later sessions, but router is testable now              |
| Method stubs        | Non-Session-2 methods throw `not yet implemented` | Sessions 3–8 fill them in; stubs make the class compile and test cleanly         |

---

## Task 1: Claude SDK Loader Module

**Files:**

- Create: `src/main/services/claude-sdk-loader.ts`

**Step 1: Write the failing test**

Create `test/phase-21/session-2/claude-sdk-loader.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We'll mock the dynamic import
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn()
}))

describe('Claude SDK Loader', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('loadClaudeSDK returns the query function', async () => {
    const { loadClaudeSDK } = await import('../../../src/main/services/claude-sdk-loader')
    const sdk = await loadClaudeSDK()
    expect(sdk).toBeDefined()
    expect(typeof sdk.query).toBe('function')
  })

  it('loadClaudeSDK caches the result on repeated calls', async () => {
    const { loadClaudeSDK } = await import('../../../src/main/services/claude-sdk-loader')
    const sdk1 = await loadClaudeSDK()
    const sdk2 = await loadClaudeSDK()
    expect(sdk1).toBe(sdk2)
  })

  it('loadClaudeSDK rejects with descriptive error when SDK not available', async () => {
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => {
      throw new Error('Cannot find module')
    })
    // Need fresh import to pick up doMock
    const { loadClaudeSDK: loadFresh } =
      await import('../../../src/main/services/claude-sdk-loader')
    await expect(loadFresh()).rejects.toThrow(/Claude Code SDK/)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/phase-21/session-2/claude-sdk-loader.test.ts`
Expected: FAIL — module `claude-sdk-loader` doesn't exist.

**Step 3: Write the implementation**

Create `src/main/services/claude-sdk-loader.ts`:

```ts
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeSDKLoader' })

// Types re-exported for consumers
export type { Query, SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk'

interface ClaudeSDK {
  query: typeof import('@anthropic-ai/claude-agent-sdk').query
}

let cachedSDK: ClaudeSDK | null = null

/**
 * Dynamically import the Claude Code SDK (ESM-only package).
 * Result is cached after first successful load.
 */
export async function loadClaudeSDK(): Promise<ClaudeSDK> {
  if (cachedSDK) return cachedSDK

  try {
    log.info('Loading Claude Code SDK')
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    cachedSDK = { query: sdk.query }
    log.info('Claude Code SDK loaded successfully')
    return cachedSDK
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Failed to load Claude Code SDK', { error: message })
    throw new Error(
      `Claude Code SDK could not be loaded: ${message}. ` +
        'Ensure @anthropic-ai/claude-agent-sdk is installed.'
    )
  }
}
```

> **Note:** The `export type` re-exports may need adjustment depending on how Electron's bundler handles ESM type re-exports. If they cause build issues, move them to a separate `claude-sdk-types.ts` that uses `import type` only. The test mock uses `vi.mock` which intercepts the dynamic `import()`.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/phase-21/session-2/claude-sdk-loader.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/main/services/claude-sdk-loader.ts test/phase-21/session-2/
git commit -m "feat(claude): add Claude SDK dynamic loader with caching"
```

---

## Task 2: ClaudeCodeImplementer — Class Skeleton

**Files:**

- Create: `src/main/services/claude-code-implementer.ts`

**Step 1: Write the failing test**

Create `test/phase-21/session-2/claude-code-implementer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { AgentSdkImplementer } from '../../../src/main/services/agent-sdk-types'
import { CLAUDE_CODE_CAPABILITIES } from '../../../src/main/services/agent-sdk-types'

// Mock the SDK loader
vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

describe('ClaudeCodeImplementer', () => {
  let implementer: AgentSdkImplementer

  beforeEach(async () => {
    vi.resetModules()
    const { ClaudeCodeImplementer } =
      await import('../../../src/main/services/claude-code-implementer')
    implementer = new ClaudeCodeImplementer()
  })

  describe('identity and capabilities', () => {
    it('has id "claude-code"', () => {
      expect(implementer.id).toBe('claude-code')
    })

    it('exposes CLAUDE_CODE_CAPABILITIES', () => {
      expect(implementer.capabilities).toEqual(CLAUDE_CODE_CAPABILITIES)
    })

    it('satisfies AgentSdkImplementer interface shape', () => {
      // Lifecycle
      expect(typeof implementer.connect).toBe('function')
      expect(typeof implementer.reconnect).toBe('function')
      expect(typeof implementer.disconnect).toBe('function')
      expect(typeof implementer.cleanup).toBe('function')

      // Messaging
      expect(typeof implementer.prompt).toBe('function')
      expect(typeof implementer.abort).toBe('function')
      expect(typeof implementer.getMessages).toBe('function')

      // Models
      expect(typeof implementer.getAvailableModels).toBe('function')
      expect(typeof implementer.getModelInfo).toBe('function')
      expect(typeof implementer.setSelectedModel).toBe('function')

      // Session info
      expect(typeof implementer.getSessionInfo).toBe('function')

      // HITL
      expect(typeof implementer.questionReply).toBe('function')
      expect(typeof implementer.questionReject).toBe('function')
      expect(typeof implementer.permissionReply).toBe('function')
      expect(typeof implementer.permissionList).toBe('function')

      // Undo/Redo
      expect(typeof implementer.undo).toBe('function')
      expect(typeof implementer.redo).toBe('function')

      // Commands
      expect(typeof implementer.listCommands).toBe('function')
      expect(typeof implementer.sendCommand).toBe('function')

      // Session management
      expect(typeof implementer.renameSession).toBe('function')

      // Window binding
      expect(typeof implementer.setMainWindow).toBe('function')
    })
  })

  describe('setMainWindow', () => {
    it('accepts a BrowserWindow without throwing', () => {
      const mockWindow = { webContents: { send: vi.fn() } } as unknown as BrowserWindow
      expect(() => implementer.setMainWindow(mockWindow)).not.toThrow()
    })
  })

  describe('stub methods throw not-yet-implemented', () => {
    it('connect throws', async () => {
      await expect(implementer.connect('/path', 'hive-1')).rejects.toThrow(/not yet implemented/)
    })

    it('prompt throws', async () => {
      await expect(implementer.prompt('/path', 'session-1', 'hello')).rejects.toThrow(
        /not yet implemented/
      )
    })

    it('getMessages throws', async () => {
      await expect(implementer.getMessages('/path', 'session-1')).rejects.toThrow(
        /not yet implemented/
      )
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/phase-21/session-2/claude-code-implementer.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Write the implementation**

Create `src/main/services/claude-code-implementer.ts`:

```ts
import type { BrowserWindow } from 'electron'
import type { AgentSdkImplementer, AgentSdkCapabilities } from './agent-sdk-types'
import { CLAUDE_CODE_CAPABILITIES } from './agent-sdk-types'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeCodeImplementer' })

/**
 * Per-session runtime state for an active Claude session.
 * Tracks the Query instance (if streaming), abort controller, and session metadata.
 */
export interface ClaudeSessionState {
  /** The Claude SDK session ID (from SDKSystemMessage init) */
  claudeSessionId: string
  /** The Hive session ID (our DB row) */
  hiveSessionId: string
  /** Working directory for this session */
  worktreePath: string
  /** AbortController for the active query (null if idle) */
  abortController: AbortController | null
  /** Checkpoints captured from user messages (uuid -> message index) */
  checkpoints: Map<string, number>
}

/**
 * Claude Code SDK adapter implementing the AgentSdkImplementer interface.
 *
 * Uses the v1 `query()` API with `options.resume` for session continuity.
 * SDK is loaded dynamically (ESM-only) via `loadClaudeSDK()`.
 *
 * Session 2 scope: class skeleton, identity, setMainWindow, cleanup.
 * Sessions 3–8 fill in lifecycle, streaming, models, HITL, etc.
 */
export class ClaudeCodeImplementer implements AgentSdkImplementer {
  readonly id = 'claude-code' as const
  readonly capabilities: AgentSdkCapabilities = CLAUDE_CODE_CAPABILITIES

  private mainWindow: BrowserWindow | null = null

  /**
   * Active session states keyed by composite key: `${worktreePath}::${claudeSessionId}`
   */
  private sessions = new Map<string, ClaudeSessionState>()

  // --- Window binding ---

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
    log.info('Main window set')
  }

  // --- Internal helpers ---

  protected getSessionKey(worktreePath: string, claudeSessionId: string): string {
    return `${worktreePath}::${claudeSessionId}`
  }

  protected getSession(
    worktreePath: string,
    claudeSessionId: string
  ): ClaudeSessionState | undefined {
    return this.sessions.get(this.getSessionKey(worktreePath, claudeSessionId))
  }

  protected sendToRenderer(channel: string, data: unknown): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      log.warn('Cannot send to renderer: no main window', { channel })
      return
    }
    this.mainWindow.webContents.send(channel, data)
  }

  // --- Lifecycle (Session 3) ---

  async connect(_worktreePath: string, _hiveSessionId: string): Promise<{ sessionId: string }> {
    throw new Error('ClaudeCodeImplementer.connect: not yet implemented (Session 3)')
  }

  async reconnect(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }> {
    throw new Error('ClaudeCodeImplementer.reconnect: not yet implemented (Session 3)')
  }

  async disconnect(_worktreePath: string, _agentSessionId: string): Promise<void> {
    throw new Error('ClaudeCodeImplementer.disconnect: not yet implemented (Session 3)')
  }

  async cleanup(): Promise<void> {
    log.info('Cleaning up all Claude sessions', { count: this.sessions.size })
    for (const [key, session] of this.sessions) {
      if (session.abortController) {
        session.abortController.abort()
      }
      log.info('Cleaned up session', { key })
    }
    this.sessions.clear()
    log.info('All Claude sessions cleaned up')
  }

  // --- Messaging (Session 4) ---

  async prompt(
    _worktreePath: string,
    _agentSessionId: string,
    _message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    _modelOverride?: { providerID: string; modelID: string; variant?: string }
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.prompt: not yet implemented (Session 4)')
  }

  async abort(_worktreePath: string, _agentSessionId: string): Promise<boolean> {
    throw new Error('ClaudeCodeImplementer.abort: not yet implemented (Session 4)')
  }

  async getMessages(_worktreePath: string, _agentSessionId: string): Promise<unknown[]> {
    throw new Error('ClaudeCodeImplementer.getMessages: not yet implemented (Session 5)')
  }

  // --- Models (Session 6) ---

  async getAvailableModels(): Promise<unknown> {
    throw new Error('ClaudeCodeImplementer.getAvailableModels: not yet implemented (Session 6)')
  }

  async getModelInfo(
    _worktreePath: string,
    _modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null> {
    throw new Error('ClaudeCodeImplementer.getModelInfo: not yet implemented (Session 6)')
  }

  setSelectedModel(_model: { providerID: string; modelID: string; variant?: string }): void {
    throw new Error('ClaudeCodeImplementer.setSelectedModel: not yet implemented (Session 6)')
  }

  // --- Session info (Session 5) ---

  async getSessionInfo(
    _worktreePath: string,
    _agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }> {
    throw new Error('ClaudeCodeImplementer.getSessionInfo: not yet implemented (Session 5)')
  }

  // --- Human-in-the-loop (Session 7) ---

  async questionReply(
    _requestId: string,
    _answers: string[][],
    _worktreePath?: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.questionReply: not yet implemented (Session 7)')
  }

  async questionReject(_requestId: string, _worktreePath?: string): Promise<void> {
    throw new Error('ClaudeCodeImplementer.questionReject: not yet implemented (Session 7)')
  }

  async permissionReply(
    _requestId: string,
    _decision: 'once' | 'always' | 'reject',
    _worktreePath?: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.permissionReply: not yet implemented (Session 7)')
  }

  async permissionList(_worktreePath?: string): Promise<unknown[]> {
    throw new Error('ClaudeCodeImplementer.permissionList: not yet implemented (Session 7)')
  }

  // --- Undo/Redo (Session 8) ---

  async undo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('ClaudeCodeImplementer.undo: not yet implemented (Session 8)')
  }

  async redo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('ClaudeCodeImplementer.redo: not yet implemented (Session 8)')
  }

  // --- Commands (Session 7) ---

  async listCommands(_worktreePath: string): Promise<unknown[]> {
    throw new Error('ClaudeCodeImplementer.listCommands: not yet implemented (Session 7)')
  }

  async sendCommand(
    _worktreePath: string,
    _agentSessionId: string,
    _command: string,
    _args?: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.sendCommand: not yet implemented (Session 7)')
  }

  // --- Session management (Session 9) ---

  async renameSession(
    _worktreePath: string,
    _agentSessionId: string,
    _name: string
  ): Promise<void> {
    throw new Error('ClaudeCodeImplementer.renameSession: not yet implemented (Session 9)')
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/phase-21/session-2/claude-code-implementer.test.ts`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/main/services/claude-code-implementer.ts test/phase-21/session-2/claude-code-implementer.test.ts
git commit -m "feat(claude): add ClaudeCodeImplementer skeleton with AgentSdkImplementer interface"
```

---

## Task 3: ClaudeCodeImplementer — Cleanup Behavior Tests

**Files:**

- Modify: `test/phase-21/session-2/claude-code-implementer.test.ts`

This task adds thorough tests for `cleanup()` and internal state management — the only fully-implemented methods in Session 2.

**Step 1: Add cleanup tests**

Append to the existing test file:

```ts
describe('cleanup', () => {
  it('resolves without error when no sessions exist', async () => {
    await expect(implementer.cleanup()).resolves.toBeUndefined()
  })

  it('aborts active abort controllers during cleanup', async () => {
    // Access internal state to simulate active sessions
    const impl = implementer as any
    const abortController = new AbortController()
    const abortSpy = vi.spyOn(abortController, 'abort')

    impl.sessions.set('path::session-1', {
      claudeSessionId: 'session-1',
      hiveSessionId: 'hive-1',
      worktreePath: '/path',
      abortController,
      checkpoints: new Map()
    })

    await implementer.cleanup()

    expect(abortSpy).toHaveBeenCalled()
    expect(impl.sessions.size).toBe(0)
  })

  it('cleans up multiple sessions', async () => {
    const impl = implementer as any
    const controllers = [new AbortController(), new AbortController(), null]
    const spies = controllers
      .filter((c): c is AbortController => c !== null)
      .map((c) => vi.spyOn(c, 'abort'))

    impl.sessions.set('a::s1', {
      claudeSessionId: 's1',
      hiveSessionId: 'h1',
      worktreePath: 'a',
      abortController: controllers[0],
      checkpoints: new Map()
    })
    impl.sessions.set('b::s2', {
      claudeSessionId: 's2',
      hiveSessionId: 'h2',
      worktreePath: 'b',
      abortController: controllers[1],
      checkpoints: new Map()
    })
    impl.sessions.set('c::s3', {
      claudeSessionId: 's3',
      hiveSessionId: 'h3',
      worktreePath: 'c',
      abortController: null,
      checkpoints: new Map()
    })

    await implementer.cleanup()

    for (const spy of spies) {
      expect(spy).toHaveBeenCalled()
    }
    expect(impl.sessions.size).toBe(0)
  })

  it('skips null abort controllers without throwing', async () => {
    const impl = implementer as any
    impl.sessions.set('path::session-idle', {
      claudeSessionId: 'session-idle',
      hiveSessionId: 'hive-idle',
      worktreePath: '/path',
      abortController: null,
      checkpoints: new Map()
    })

    await expect(implementer.cleanup()).resolves.toBeUndefined()
    expect(impl.sessions.size).toBe(0)
  })
})

describe('sendToRenderer', () => {
  it('does not throw when no main window is set', () => {
    const impl = implementer as any
    expect(() => impl.sendToRenderer('test:channel', { data: 'value' })).not.toThrow()
  })

  it('sends data to main window webContents', () => {
    const mockSend = vi.fn()
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: mockSend }
    } as unknown as BrowserWindow
    implementer.setMainWindow(mockWindow)

    const impl = implementer as any
    impl.sendToRenderer('opencode:stream', { type: 'test' })

    expect(mockSend).toHaveBeenCalledWith('opencode:stream', { type: 'test' })
  })

  it('does not throw when window is destroyed', () => {
    const mockWindow = {
      isDestroyed: () => true,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow
    implementer.setMainWindow(mockWindow)

    const impl = implementer as any
    expect(() => impl.sendToRenderer('opencode:stream', { type: 'test' })).not.toThrow()
  })
})

describe('session key helpers', () => {
  it('getSessionKey produces composite key', () => {
    const impl = implementer as any
    expect(impl.getSessionKey('/foo', 'abc')).toBe('/foo::abc')
  })

  it('getSession returns undefined for unknown key', () => {
    const impl = implementer as any
    expect(impl.getSession('/foo', 'abc')).toBeUndefined()
  })

  it('getSession returns state for registered session', () => {
    const impl = implementer as any
    const state = {
      claudeSessionId: 'abc',
      hiveSessionId: 'h1',
      worktreePath: '/foo',
      abortController: null,
      checkpoints: new Map()
    }
    impl.sessions.set('/foo::abc', state)
    expect(impl.getSession('/foo', 'abc')).toBe(state)
  })
})
```

**Step 2: Run tests to verify they pass**

Run: `pnpm vitest run test/phase-21/session-2/claude-code-implementer.test.ts`
Expected: PASS (all tests — ~15+ tests)

**Step 3: Commit**

```bash
git add test/phase-21/session-2/claude-code-implementer.test.ts
git commit -m "test(claude): add cleanup, sendToRenderer, and session key tests"
```

---

## Task 4: AgentSdkManager — SDK Router

**Files:**

- Create: `src/main/services/agent-sdk-manager.ts`
- Create: `test/phase-21/session-2/agent-sdk-manager.test.ts`

**Step 1: Write the failing test**

Create `test/phase-21/session-2/agent-sdk-manager.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSdkImplementer, AgentSdkId } from '../../../src/main/services/agent-sdk-types'
import {
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES
} from '../../../src/main/services/agent-sdk-types'

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Minimal mock implementers
function createMockImplementer(id: AgentSdkId): AgentSdkImplementer {
  const caps = id === 'opencode' ? OPENCODE_CAPABILITIES : CLAUDE_CODE_CAPABILITIES
  return {
    id,
    capabilities: caps,
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    cleanup: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn(),
    abort: vi.fn(),
    getMessages: vi.fn(),
    getAvailableModels: vi.fn(),
    getModelInfo: vi.fn(),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn(),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    permissionReply: vi.fn(),
    permissionList: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    listCommands: vi.fn(),
    sendCommand: vi.fn(),
    renameSession: vi.fn(),
    setMainWindow: vi.fn()
  }
}

describe('AgentSdkManager', () => {
  let manager: InstanceType<
    typeof import('../../../src/main/services/agent-sdk-manager').AgentSdkManager
  >
  let mockOpenCode: AgentSdkImplementer
  let mockClaude: AgentSdkImplementer

  beforeEach(async () => {
    vi.resetModules()
    const { AgentSdkManager } = await import('../../../src/main/services/agent-sdk-manager')
    mockOpenCode = createMockImplementer('opencode')
    mockClaude = createMockImplementer('claude-code')
    manager = new AgentSdkManager(mockOpenCode, mockClaude)
  })

  describe('getImplementer', () => {
    it('returns opencode implementer for "opencode"', () => {
      expect(manager.getImplementer('opencode')).toBe(mockOpenCode)
    })

    it('returns claude-code implementer for "claude-code"', () => {
      expect(manager.getImplementer('claude-code')).toBe(mockClaude)
    })

    it('throws for unknown SDK id', () => {
      expect(() => manager.getImplementer('unknown' as AgentSdkId)).toThrow(/Unknown agent SDK/)
    })
  })

  describe('getCapabilities', () => {
    it('returns correct capabilities for opencode', () => {
      expect(manager.getCapabilities('opencode')).toEqual(OPENCODE_CAPABILITIES)
    })

    it('returns correct capabilities for claude-code', () => {
      expect(manager.getCapabilities('claude-code')).toEqual(CLAUDE_CODE_CAPABILITIES)
    })
  })

  describe('defaultSdkId', () => {
    it('returns opencode as default', () => {
      expect(manager.defaultSdkId).toBe('opencode')
    })
  })

  describe('setMainWindow', () => {
    it('forwards setMainWindow to all implementers', () => {
      const mockWindow = {} as any
      manager.setMainWindow(mockWindow)
      expect(mockOpenCode.setMainWindow).toHaveBeenCalledWith(mockWindow)
      expect(mockClaude.setMainWindow).toHaveBeenCalledWith(mockWindow)
    })
  })

  describe('cleanupAll', () => {
    it('calls cleanup on all implementers', async () => {
      await manager.cleanupAll()
      expect(mockOpenCode.cleanup).toHaveBeenCalled()
      expect(mockClaude.cleanup).toHaveBeenCalled()
    })

    it('continues cleanup even if one implementer fails', async () => {
      ;(mockOpenCode.cleanup as any).mockRejectedValue(new Error('opencode fail'))
      await manager.cleanupAll()
      expect(mockClaude.cleanup).toHaveBeenCalled()
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/phase-21/session-2/agent-sdk-manager.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Write the implementation**

Create `src/main/services/agent-sdk-manager.ts`:

```ts
import type { BrowserWindow } from 'electron'
import type { AgentSdkId, AgentSdkCapabilities, AgentSdkImplementer } from './agent-sdk-types'
import { createLogger } from './logger'

const log = createLogger({ component: 'AgentSdkManager' })

/**
 * Routes operations to the correct AgentSdkImplementer based on session SDK affinity.
 *
 * Holds references to all registered implementers. IPC handlers resolve the target
 * implementer via `getImplementer(sdkId)` and call methods directly.
 */
export class AgentSdkManager {
  private implementers: Map<AgentSdkId, AgentSdkImplementer>
  readonly defaultSdkId: AgentSdkId = 'opencode'

  constructor(opencode: AgentSdkImplementer, claudeCode: AgentSdkImplementer) {
    this.implementers = new Map<AgentSdkId, AgentSdkImplementer>([
      ['opencode', opencode],
      ['claude-code', claudeCode]
    ])
    log.info('AgentSdkManager initialized', {
      sdks: Array.from(this.implementers.keys())
    })
  }

  /**
   * Get the implementer for a given SDK id.
   * Throws if the SDK id is not registered.
   */
  getImplementer(sdkId: AgentSdkId): AgentSdkImplementer {
    const impl = this.implementers.get(sdkId)
    if (!impl) {
      throw new Error(`Unknown agent SDK: "${sdkId}"`)
    }
    return impl
  }

  /**
   * Get the capabilities for a given SDK id.
   */
  getCapabilities(sdkId: AgentSdkId): AgentSdkCapabilities {
    return this.getImplementer(sdkId).capabilities
  }

  /**
   * Forward setMainWindow to all implementers.
   */
  setMainWindow(window: BrowserWindow): void {
    for (const impl of this.implementers.values()) {
      impl.setMainWindow(window)
    }
  }

  /**
   * Cleanup all implementers. Errors in one do not prevent cleanup of others.
   */
  async cleanupAll(): Promise<void> {
    log.info('Cleaning up all SDK implementers')
    for (const [id, impl] of this.implementers) {
      try {
        await impl.cleanup()
        log.info('Cleaned up SDK', { id })
      } catch (error) {
        log.error('Error cleaning up SDK', {
          id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/phase-21/session-2/agent-sdk-manager.test.ts`
Expected: PASS (7 tests)

**Step 5: Commit**

```bash
git add src/main/services/agent-sdk-manager.ts test/phase-21/session-2/agent-sdk-manager.test.ts
git commit -m "feat(claude): add AgentSdkManager for SDK routing"
```

---

## Task 5: Verify Full Suite + Lint + Build

**Step 1: Run all Session 2 tests**

```bash
pnpm vitest run test/phase-21/session-2/
```

Expected: All tests pass (across 3 test files).

**Step 2: Run all project tests**

```bash
pnpm test
```

Expected: All tests pass (Session 1 contract tests + Session 2 tests + existing tests).

**Step 3: Run lint**

```bash
pnpm lint
```

Expected: No errors. Fix any issues (likely unused import warnings or missing semicolons).

**Step 4: Run build**

```bash
pnpm build
```

Expected: Build succeeds. The dynamic `import()` for the ESM SDK should work as it does for OpenCode. If the type re-exports in `claude-sdk-loader.ts` cause build issues, convert them to `import type` in a separate types file.

**Step 5: Commit any lint/build fixes**

```bash
git add -A
git commit -m "chore: fix lint/build issues from session 2"
```

---

## Definition of Done Checklist

- [ ] `ClaudeCodeImplementer` exists as a complete class implementing `AgentSdkImplementer`
- [ ] `ClaudeCodeImplementer` does not depend on any local mock transcript files
- [ ] SDK loader module (`claude-sdk-loader.ts`) handles dynamic ESM import with caching and error handling
- [ ] `AgentSdkManager` routes to correct implementer by `AgentSdkId`
- [ ] Cleanup correctly aborts active controllers and clears session state
- [ ] `sendToRenderer` is safe when no window or destroyed window
- [ ] All stub methods throw descriptive `not yet implemented` errors referencing which session fills them in
- [ ] Structured logging parity with OpenCode service (same `createLogger` pattern)
- [ ] `pnpm lint`, `pnpm test`, `pnpm build` all pass

## Files Created/Modified

| Action | File                                                      |
| ------ | --------------------------------------------------------- |
| Create | `src/main/services/claude-sdk-loader.ts`                  |
| Create | `src/main/services/claude-code-implementer.ts`            |
| Create | `src/main/services/agent-sdk-manager.ts`                  |
| Create | `test/phase-21/session-2/claude-sdk-loader.test.ts`       |
| Create | `test/phase-21/session-2/claude-code-implementer.test.ts` |
| Create | `test/phase-21/session-2/agent-sdk-manager.test.ts`       |

## What This Does NOT Do (Deferred)

- **IPC handler rewiring** — handlers still call `openCodeService` directly. Sessions 3+ will rewire them through the manager.
- **Real SDK calls** — `connect`, `prompt`, etc. are stubs. Session 3 implements lifecycle, Session 4 implements streaming.
- **Main process registration** — wiring the manager into `src/main/index.ts` is deferred until IPC handlers are ready to consume it.
