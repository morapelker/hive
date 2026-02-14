# Session 4: Prompt Streaming + Abort + Event Normalization

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stream real Claude SDK responses through Hive's normalized event contract so the renderer receives the same `opencode:stream` events it already handles — no renderer changes needed.

**Architecture:** The `ClaudeCodeImplementer.prompt()` method calls `query()` from the Claude SDK, iterates the async generator, maps each `SDKMessage` into normalized `StreamEvent` payloads, and emits them via `sendToRenderer('opencode:stream', ...)`. IPC handlers gain SDK-dispatch logic so `opencode:prompt` and `opencode:abort` transparently route to the correct implementer based on `session.agent_sdk` in the DB. Abort uses `AbortController.abort()` + `query.interrupt()`.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk`, Electron IPC, Vitest

**Decisions:**

- IPC routing: Add SDK dispatch to existing `opencode:prompt`/`opencode:abort` handlers (renderer stays SDK-agnostic)
- `getMessages`: Stub returning `[]` (deferred to Session 5)
- Permissions: Auto-allow all tools via `permissionMode` (deferred to Session 7)

---

## Task 1: Add DB Lookup by Agent Session ID

**Files:**

- Modify: `src/main/db/database.ts` (add method)
- Test: `test/phase-21/session-4/db-agent-session-lookup.test.ts`

The IPC handlers receive `(worktreePath, agentSessionId)` but need to know which SDK to dispatch to. We need a DB query that finds the `agent_sdk` column from the `opencode_session_id` (which stores the agent-internal session ID for both OpenCode and Claude sessions).

**Step 1: Write the failing test**

```ts
// test/phase-21/session-4/db-agent-session-lookup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { DatabaseService } from '../../../src/main/db/database'

describe('DatabaseService.getAgentSdkForSession', () => {
  let db: DatabaseService

  beforeEach(() => {
    db = new DatabaseService(':memory:')
  })

  it('returns "opencode" for an OpenCode session', () => {
    // Create project, worktree, then session with agent_sdk = 'opencode'
    db.createProject({ name: 'P', path: '/p' })
    const projects = db.getProjects()
    const projectId = projects[0].id
    db.createWorktree({
      project_id: projectId,
      path: '/p',
      name: 'main',
      branch: 'main',
      is_main: true
    })
    const worktrees = db.getWorktrees(projectId)
    const worktreeId = worktrees[0].id
    db.createSession({
      worktree_id: worktreeId,
      project_id: projectId,
      name: 'test',
      opencode_session_id: 'opc-123',
      agent_sdk: 'opencode'
    })

    const result = db.getAgentSdkForSession('opc-123')
    expect(result).toBe('opencode')
  })

  it('returns "claude-code" for a Claude session', () => {
    db.createProject({ name: 'P', path: '/p' })
    const projects = db.getProjects()
    const projectId = projects[0].id
    db.createWorktree({
      project_id: projectId,
      path: '/p',
      name: 'main',
      branch: 'main',
      is_main: true
    })
    const worktrees = db.getWorktrees(projectId)
    const worktreeId = worktrees[0].id
    db.createSession({
      worktree_id: worktreeId,
      project_id: projectId,
      name: 'test',
      opencode_session_id: 'pending::abc-123',
      agent_sdk: 'claude-code'
    })

    const result = db.getAgentSdkForSession('pending::abc-123')
    expect(result).toBe('claude-code')
  })

  it('returns null when no session matches', () => {
    const result = db.getAgentSdkForSession('nonexistent')
    expect(result).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/phase-21/session-4/db-agent-session-lookup.test.ts`
Expected: FAIL — `db.getAgentSdkForSession is not a function`

**Step 3: Write minimal implementation**

In `src/main/db/database.ts`, add after the existing `getSession` method (~line 512):

```ts
getAgentSdkForSession(agentSessionId: string): 'opencode' | 'claude-code' | null {
  const db = this.getDb()
  const row = db
    .prepare('SELECT agent_sdk FROM sessions WHERE opencode_session_id = ? LIMIT 1')
    .get(agentSessionId) as { agent_sdk: 'opencode' | 'claude-code' } | undefined
  return row?.agent_sdk ?? null
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/phase-21/session-4/db-agent-session-lookup.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add DB lookup for agent_sdk by agent session ID
```

---

## Task 2: Instantiate AgentSdkManager and Wire into IPC Registration

**Files:**

- Modify: `src/main/ipc/opencode-handlers.ts` (change function signature to accept `AgentSdkManager`)
- Modify: `src/main/ipc/index.ts` (re-export)
- Modify: `src/main/index.ts` (instantiate `AgentSdkManager`, pass to handler registration)
- Test: `test/phase-21/session-4/ipc-sdk-routing.test.ts`

Currently `registerOpenCodeHandlers(mainWindow)` only receives a `BrowserWindow` and hardcodes `openCodeService`. We need to pass `AgentSdkManager` + `DatabaseService` so handlers can dispatch by SDK.

**Step 1: Write the failing test**

```ts
// test/phase-21/session-4/ipc-sdk-routing.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))

import { AgentSdkManager } from '../../../src/main/services/agent-sdk-manager'
import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'
import type { AgentSdkImplementer } from '../../../src/main/services/agent-sdk-types'

function createMockOpenCodeImpl(): AgentSdkImplementer {
  return {
    id: 'opencode',
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
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    cleanup: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
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

describe('AgentSdkManager SDK dispatch', () => {
  let manager: AgentSdkManager
  let mockOC: AgentSdkImplementer
  let claude: ClaudeCodeImplementer

  beforeEach(() => {
    mockOC = createMockOpenCodeImpl()
    claude = new ClaudeCodeImplementer()
    manager = new AgentSdkManager(mockOC, claude)
  })

  it('getImplementer("opencode") returns OpenCode implementer', () => {
    expect(manager.getImplementer('opencode').id).toBe('opencode')
  })

  it('getImplementer("claude-code") returns Claude implementer', () => {
    expect(manager.getImplementer('claude-code').id).toBe('claude-code')
  })

  it('dispatches prompt to correct implementer based on sdk id', async () => {
    const impl = manager.getImplementer('opencode')
    await impl.prompt('/proj', 'ses-1', 'hello')
    expect(mockOC.prompt).toHaveBeenCalledWith('/proj', 'ses-1', 'hello')
  })

  it('dispatches abort to correct implementer based on sdk id', async () => {
    const impl = manager.getImplementer('opencode')
    await impl.abort('/proj', 'ses-1')
    expect(mockOC.abort).toHaveBeenCalledWith('/proj', 'ses-1')
  })

  it('throws for unknown SDK id', () => {
    expect(() => manager.getImplementer('unknown' as any)).toThrow(/Unknown agent SDK/)
  })
})
```

**Step 2: Run test to verify it passes** (this tests the existing AgentSdkManager — should pass already)

Run: `pnpm vitest run test/phase-21/session-4/ipc-sdk-routing.test.ts`
Expected: PASS (validates the dispatch contract we'll rely on)

**Step 3: Modify `registerOpenCodeHandlers` signature**

In `src/main/ipc/opencode-handlers.ts`, change the function signature and add SDK-resolution helper:

```ts
import { openCodeService } from '../services/opencode-service'
import { createLogger } from '../services/logger'
import { DatabaseService } from '../db/database'
import type { AgentSdkManager } from '../services/agent-sdk-manager'
import type { AgentSdkImplementer } from '../services/agent-sdk-types'

const log = createLogger({ component: 'OpenCodeHandlers' })

// Resolve which SDK implementer to use for a given agent session ID.
// Falls back to OpenCode (the default) when agent_sdk is not found.
function resolveImplementer(
  agentSessionId: string,
  manager: AgentSdkManager,
  dbService: DatabaseService
): AgentSdkImplementer {
  const sdkId = dbService.getAgentSdkForSession(agentSessionId)
  return manager.getImplementer(sdkId ?? 'opencode')
}

export function registerOpenCodeHandlers(
  mainWindow: BrowserWindow,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): void {
```

The `sdkManager` and `dbService` are optional for backward compatibility — when absent, behavior falls back to existing `openCodeService` direct calls.

**Step 4: Modify `opencode:prompt` handler to dispatch**

Replace the existing `opencode:prompt` handler body. When `sdkManager` is available and the session resolves to a non-opencode SDK, dispatch to that implementer. Otherwise fall through to `openCodeService`:

```ts
ipcMain.handle('opencode:prompt', async (_event, ...args: unknown[]) => {
  // ... (existing arg parsing — keep as-is) ...

  try {
    // If SDK manager is available, try SDK-aware dispatch
    if (sdkManager && dbService) {
      const impl = resolveImplementer(opencodeSessionId, sdkManager, dbService)
      if (impl.id !== 'opencode') {
        await impl.prompt(worktreePath, opencodeSessionId, messageOrParts, model)
        return { success: true }
      }
    }
    // Default: OpenCode direct path (unchanged)
    await openCodeService.prompt(worktreePath, opencodeSessionId, messageOrParts, model)
    return { success: true }
  } catch (error) { ... }
})
```

Apply same pattern to `opencode:abort`.

**Step 5: Instantiate AgentSdkManager in `src/main/index.ts`**

```ts
import { ClaudeCodeImplementer } from './services/claude-code-implementer'
import { AgentSdkManager } from './services/agent-sdk-manager'

// In createWindow() or app.whenReady():
const claudeImpl = new ClaudeCodeImplementer()
// Wrap openCodeService in an adapter OR pass it alongside manager
// For now, openCodeService calls go through the existing direct path
const sdkManager = new AgentSdkManager(openCodeServiceAdapter, claudeImpl)
sdkManager.setMainWindow(mainWindow)
registerOpenCodeHandlers(mainWindow, sdkManager, databaseService)
```

> **Note:** `openCodeService` does NOT implement `AgentSdkImplementer`. The dispatch logic in the handler falls through to `openCodeService` directly for `'opencode'` sessions. The `AgentSdkManager` only needs to hold Claude (and possibly a thin OpenCode adapter — or we skip registering OpenCode in the manager entirely and only use the manager for non-opencode SDKs). The simplest approach: only use `resolveImplementer` to check if `sdkId === 'claude-code'` and dispatch to Claude; otherwise fall through to existing `openCodeService` calls.

**Step 6: Commit**

```
feat: wire AgentSdkManager into IPC handlers for SDK-aware dispatch
```

---

## Task 3: Implement `ClaudeCodeImplementer.prompt()` — Core Streaming Loop

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts`
- Test: `test/phase-21/session-4/claude-prompt-streaming.test.ts`

This is the core task. The `prompt()` method must:

1. Look up session state from the internal map
2. Load the Claude SDK via `loadClaudeSDK()`
3. Create a fresh `AbortController`
4. Build SDK `query()` options (cwd, permissionMode, abortController, resume ID)
5. Handle `pending::` → real session ID materialization
6. Emit `session.status { type: 'busy' }` before streaming starts
7. Iterate the async generator, mapping each `SDKMessage` into normalized `StreamEvent`
8. Emit `session.status { type: 'idle' }` when the loop completes
9. Handle errors gracefully

**Step 1: Write the failing test**

```ts
// test/phase-21/session-4/claude-prompt-streaming.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the SDK loader
const mockQuery = vi.fn()
vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn().mockResolvedValue({ query: mockQuery })
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'
import type { BrowserWindow } from 'electron'

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

// Helper: create an async iterable that yields the given messages
function createMockQueryIterator(messages: Array<Record<string, unknown>>) {
  let index = 0
  const iterator = {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    next: vi.fn().mockImplementation(async () => {
      if (index < messages.length) {
        return { done: false, value: messages[index++] }
      }
      return { done: true, value: undefined }
    }),
    return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator
  }
  return iterator
}

describe('ClaudeCodeImplementer.prompt() – streaming', () => {
  let impl: ClaudeCodeImplementer
  let mockWindow: BrowserWindow

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new ClaudeCodeImplementer()
    mockWindow = createMockWindow()
    impl.setMainWindow(mockWindow)
  })

  it('throws if session is not found', async () => {
    await expect(impl.prompt('/proj', 'nonexistent', 'hello')).rejects.toThrow(/session not found/i)
  })

  it('emits session.status busy then idle for a simple prompt', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')

    const messages = [
      { type: 'assistant', session_id: 'real-sdk-id', content: [{ type: 'text', text: 'Hello!' }] }
    ]
    mockQuery.mockReturnValue(createMockQueryIterator(messages))

    await impl.prompt('/proj', sessionId, 'Hi')

    const send = mockWindow.webContents.send as ReturnType<typeof vi.fn>
    const events = send.mock.calls
      .filter(([ch]: [string]) => ch === 'opencode:stream')
      .map(([, evt]: [string, unknown]) => evt)

    // First event: session.status busy
    expect(events[0]).toMatchObject({
      type: 'session.status',
      sessionId: 'hive-1',
      statusPayload: { type: 'busy' }
    })

    // Last event: session.status idle
    expect(events[events.length - 1]).toMatchObject({
      type: 'session.status',
      sessionId: 'hive-1',
      statusPayload: { type: 'idle' }
    })
  })

  it('materializes pending:: session ID on first SDK message', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    expect(sessionId).toMatch(/^pending::/)

    const messages = [
      {
        type: 'assistant',
        session_id: 'real-claude-session',
        content: [{ type: 'text', text: 'Hi' }]
      }
    ]
    mockQuery.mockReturnValue(createMockQueryIterator(messages))

    await impl.prompt('/proj', sessionId, 'Hello')

    // The session should now be materialized under the real SDK ID
    const sessions = (impl as any).sessions as Map<string, unknown>
    // Old pending key should be gone
    const oldKey = `${'/proj'}::${sessionId}`
    expect(sessions.has(oldKey)).toBe(false)
    // New key with real ID should exist
    const newKey = `${'/proj'}::real-claude-session`
    expect(sessions.has(newKey)).toBe(true)
  })

  it('emits message.part.updated for assistant text', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')

    const messages = [
      { type: 'assistant', session_id: 'sdk-1', content: [{ type: 'text', text: 'Response text' }] }
    ]
    mockQuery.mockReturnValue(createMockQueryIterator(messages))

    await impl.prompt('/proj', sessionId, 'Hi')

    const send = mockWindow.webContents.send as ReturnType<typeof vi.fn>
    const events = send.mock.calls
      .filter(([ch]: [string]) => ch === 'opencode:stream')
      .map(([, evt]: [string, unknown]) => evt)

    const partEvents = events.filter((e: any) => e.type === 'message.part.updated')
    expect(partEvents.length).toBeGreaterThan(0)
    expect(partEvents[0]).toMatchObject({
      type: 'message.part.updated',
      sessionId: 'hive-1'
    })
  })

  it('captures user message UUIDs as checkpoints', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')

    const messages = [
      { type: 'user', session_id: 'sdk-1', uuid: 'ckpt-abc', content: [] },
      { type: 'assistant', session_id: 'sdk-1', content: [{ type: 'text', text: 'Ok' }] }
    ]
    mockQuery.mockReturnValue(createMockQueryIterator(messages))

    await impl.prompt('/proj', sessionId, 'Hi')

    // Access checkpoints via internal state
    const sessions = (impl as any).sessions as Map<string, any>
    const state = Array.from(sessions.values())[0]
    expect(state.checkpoints.has('ckpt-abc')).toBe(true)
  })

  it('skips init messages', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')

    const messages = [
      { type: 'init', session_id: 'sdk-1', content: {} },
      { type: 'assistant', session_id: 'sdk-1', content: [{ type: 'text', text: 'Hi' }] }
    ]
    mockQuery.mockReturnValue(createMockQueryIterator(messages))

    await impl.prompt('/proj', sessionId, 'Hello')

    const send = mockWindow.webContents.send as ReturnType<typeof vi.fn>
    const events = send.mock.calls
      .filter(([ch]: [string]) => ch === 'opencode:stream')
      .map(([, evt]: [string, unknown]) => evt)

    // No init event should be forwarded
    const initEvents = events.filter((e: any) => e.data?.type === 'init')
    expect(initEvents.length).toBe(0)
  })

  it('emits session.error and then idle on SDK error', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')

    mockQuery.mockImplementation(() => {
      throw new Error('SDK connection failed')
    })

    // prompt should not throw — it catches and emits error events
    await impl.prompt('/proj', sessionId, 'Hi')

    const send = mockWindow.webContents.send as ReturnType<typeof vi.fn>
    const events = send.mock.calls
      .filter(([ch]: [string]) => ch === 'opencode:stream')
      .map(([, evt]: [string, unknown]) => evt)

    const errorEvents = events.filter((e: any) => e.type === 'session.error')
    expect(errorEvents.length).toBe(1)

    // Should still end with idle
    const lastEvent = events[events.length - 1] as any
    expect(lastEvent.type).toBe('session.status')
    expect(lastEvent.statusPayload.type).toBe('idle')
  })

  it('passes resume ID to SDK when session is materialized', async () => {
    // Simulate a reconnected session (materialized = true, real ID)
    await impl.reconnect('/proj', 'real-sdk-id', 'hive-2')

    const messages = [
      { type: 'assistant', session_id: 'real-sdk-id', content: [{ type: 'text', text: 'Resumed' }] }
    ]
    mockQuery.mockReturnValue(createMockQueryIterator(messages))

    await impl.prompt('/proj', 'real-sdk-id', 'Continue')

    // Verify query was called with resume option
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.resume).toBe('real-sdk-id')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/phase-21/session-4/claude-prompt-streaming.test.ts`
Expected: FAIL — `not yet implemented (Session 4)`

**Step 3: Write the implementation**

Replace the `prompt` stub in `src/main/services/claude-code-implementer.ts`:

```ts
import { loadClaudeSDK } from './claude-sdk-loader'
import type { StreamEvent } from './opencode-service'

// ... inside the class ...

async prompt(
  worktreePath: string,
  agentSessionId: string,
  message:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'file'; mime: string; url: string; filename?: string }
      >,
  _modelOverride?: { providerID: string; modelID: string; variant?: string }
): Promise<void> {
  const session = this.getSession(worktreePath, agentSessionId)
  if (!session) {
    throw new Error(`ClaudeCodeImplementer.prompt: session not found for ${agentSessionId}`)
  }

  // Emit busy status
  this.emitStatus(session.hiveSessionId, 'busy')

  try {
    const sdk = await loadClaudeSDK()

    // Build prompt string from message parts
    const promptText = typeof message === 'string'
      ? message
      : message
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('\n')

    // Create fresh abort controller for this prompt
    session.abortController = new AbortController()

    // Build SDK options
    const options: Record<string, unknown> = {
      cwd: worktreePath,
      permissionMode: 'default',
      abortController: session.abortController,
      maxThinkingTokens: 31999
    }

    // If session is materialized (has a real SDK ID), pass resume
    if (session.materialized && !session.claudeSessionId.startsWith('pending::')) {
      options.resume = session.claudeSessionId
    }

    const queryData = sdk.query({ prompt: promptText, options })
    session.query = queryData as unknown as ClaudeQuery

    let messageIndex = 0

    for await (const sdkMessage of queryData) {
      // Check abort
      if (session.abortController?.signal.aborted) {
        break
      }

      const msg = sdkMessage as Record<string, unknown>

      // Skip init messages
      if (msg.type === 'init') {
        continue
      }

      // Materialize pending session ID from first SDK message
      const sdkSessionId = msg.session_id as string | undefined
      if (sdkSessionId && session.claudeSessionId.startsWith('pending::')) {
        const oldKey = this.getSessionKey(worktreePath, session.claudeSessionId)
        session.claudeSessionId = sdkSessionId
        session.materialized = true
        this.sessions.delete(oldKey)
        this.sessions.set(this.getSessionKey(worktreePath, sdkSessionId), session)
        log.info('Materialized session ID', {
          worktreePath,
          oldId: agentSessionId,
          newId: sdkSessionId
        })
      }

      // Capture user message UUIDs as checkpoints
      if (msg.type === 'user' && msg.uuid) {
        session.checkpoints.set(msg.uuid as string, messageIndex)
      }

      // Map SDK message to normalized stream events
      this.emitSdkMessage(session.hiveSessionId, msg, messageIndex)

      messageIndex++
    }

    // Emit idle when streaming completes
    this.emitStatus(session.hiveSessionId, 'idle')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log.error('Prompt streaming failed', { worktreePath, agentSessionId, error: errorMessage })

    // Emit error event
    this.sendToRenderer('opencode:stream', {
      type: 'session.error',
      sessionId: session.hiveSessionId,
      data: { error: errorMessage }
    })

    // Always return to idle
    this.emitStatus(session.hiveSessionId, 'idle')
  } finally {
    session.query = null
  }
}

// ── Event emission helpers ──────────────────────────────────────

private emitStatus(
  hiveSessionId: string,
  status: 'idle' | 'busy' | 'retry',
  extra?: { attempt?: number; message?: string; next?: number }
): void {
  const statusPayload = { type: status, ...extra }
  const event: StreamEvent = {
    type: 'session.status',
    sessionId: hiveSessionId,
    data: { status: statusPayload },
    statusPayload
  }
  this.sendToRenderer('opencode:stream', event)
}

private emitSdkMessage(
  hiveSessionId: string,
  msg: Record<string, unknown>,
  messageIndex: number
): void {
  const msgType = msg.type as string

  switch (msgType) {
    case 'assistant': {
      // Emit each content block as a message.part.updated
      const content = msg.content as Array<Record<string, unknown>> | undefined
      if (content && Array.isArray(content)) {
        for (const part of content) {
          this.sendToRenderer('opencode:stream', {
            type: 'message.part.updated',
            sessionId: hiveSessionId,
            data: {
              part: {
                type: part.type || 'text',
                text: part.text || '',
                sessionID: hiveSessionId,
                messageIndex
              }
            }
          })
        }
      }
      break
    }

    case 'result': {
      // Emit as message.updated (signals turn complete)
      this.sendToRenderer('opencode:stream', {
        type: 'message.updated',
        sessionId: hiveSessionId,
        data: {
          message: msg,
          messageIndex,
          isError: !!(msg.is_error)
        }
      })
      break
    }

    case 'user': {
      // User echo messages — emit as message.part.updated with user role
      // Renderer generally skips these but they're needed for transcript completeness
      this.sendToRenderer('opencode:stream', {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: {
          part: {
            type: 'user',
            role: 'user',
            sessionID: hiveSessionId,
            messageIndex
          }
        }
      })
      break
    }

    case 'tool_use': {
      // Tool usage events — emit as message.part.updated with tool type
      this.sendToRenderer('opencode:stream', {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: {
          part: {
            type: 'tool-use',
            toolName: msg.subtype || 'unknown',
            input: msg.content,
            sessionID: hiveSessionId,
            messageIndex
          }
        }
      })
      break
    }

    default:
      log.debug('Unhandled SDK message type', { type: msgType, messageIndex })
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/phase-21/session-4/claude-prompt-streaming.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: implement ClaudeCodeImplementer.prompt() with SDK streaming and event normalization
```

---

## Task 4: Implement `ClaudeCodeImplementer.abort()`

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts`
- Test: `test/phase-21/session-4/claude-abort.test.ts`

**Step 1: Write the failing test**

```ts
// test/phase-21/session-4/claude-abort.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn().mockResolvedValue({ query: mockQuery })
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'
import type { BrowserWindow } from 'electron'

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

describe('ClaudeCodeImplementer.abort()', () => {
  let impl: ClaudeCodeImplementer
  let mockWindow: BrowserWindow

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new ClaudeCodeImplementer()
    mockWindow = createMockWindow()
    impl.setMainWindow(mockWindow)
  })

  it('returns false when session is not found', async () => {
    const result = await impl.abort('/proj', 'nonexistent')
    expect(result).toBe(false)
  })

  it('aborts the abort controller', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const sessions = (impl as any).sessions as Map<string, any>
    const state = sessions.get((impl as any).getSessionKey('/proj', sessionId))
    expect(state.abortController.signal.aborted).toBe(false)

    await impl.abort('/proj', sessionId)
    expect(state.abortController.signal.aborted).toBe(true)
  })

  it('calls query.interrupt() if a query is active', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')

    // Manually set a mock query on the session
    const mockInterrupt = vi.fn().mockResolvedValue(undefined)
    const sessions = (impl as any).sessions as Map<string, any>
    const key = (impl as any).getSessionKey('/proj', sessionId)
    sessions.get(key).query = {
      interrupt: mockInterrupt,
      close: vi.fn(),
      next: vi.fn(),
      [Symbol.asyncIterator]: vi.fn()
    }

    await impl.abort('/proj', sessionId)
    expect(mockInterrupt).toHaveBeenCalled()
  })

  it('emits session.status idle after abort', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    await impl.abort('/proj', sessionId)

    const send = mockWindow.webContents.send as ReturnType<typeof vi.fn>
    const events = send.mock.calls
      .filter(([ch]: [string]) => ch === 'opencode:stream')
      .map(([, evt]: [string, unknown]) => evt)

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'session.status',
        sessionId: 'hive-1',
        statusPayload: { type: 'idle' }
      })
    )
  })

  it('returns true on successful abort', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const result = await impl.abort('/proj', sessionId)
    expect(result).toBe(true)
  })

  it('does not throw when query.interrupt() throws', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const sessions = (impl as any).sessions as Map<string, any>
    const key = (impl as any).getSessionKey('/proj', sessionId)
    sessions.get(key).query = {
      interrupt: vi.fn().mockRejectedValue(new Error('interrupt failed')),
      close: vi.fn(),
      next: vi.fn(),
      [Symbol.asyncIterator]: vi.fn()
    }

    const result = await impl.abort('/proj', sessionId)
    expect(result).toBe(true) // still succeeds
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/phase-21/session-4/claude-abort.test.ts`
Expected: FAIL — `not yet implemented (Session 4)`

**Step 3: Write the implementation**

Replace the `abort` stub in `src/main/services/claude-code-implementer.ts`:

```ts
async abort(worktreePath: string, agentSessionId: string): Promise<boolean> {
  const session = this.getSession(worktreePath, agentSessionId)
  if (!session) {
    log.warn('Abort: session not found', { worktreePath, agentSessionId })
    return false
  }

  // Abort the controller to signal the streaming loop to stop
  if (session.abortController) {
    session.abortController.abort()
  }

  // Interrupt the active query
  if (session.query) {
    try {
      await session.query.interrupt()
    } catch {
      log.warn('Abort: query.interrupt() threw, ignoring', { worktreePath, agentSessionId })
    }
    session.query = null
  }

  // Emit idle status
  this.emitStatus(session.hiveSessionId, 'idle')

  log.info('Aborted', { worktreePath, agentSessionId })
  return true
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/phase-21/session-4/claude-abort.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: implement ClaudeCodeImplementer.abort() with SDK interruption and idle status
```

---

## Task 5: Update `getMessages` Stub

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts`
- Test: `test/phase-21/session-4/claude-prompt-streaming.test.ts` (add one test)

**Step 1: Write the failing test**

Add to the streaming test file:

```ts
it('getMessages returns empty array (Session 5 stub)', async () => {
  const { sessionId } = await impl.connect('/proj', 'hive-1')
  const messages = await impl.getMessages('/proj', sessionId)
  expect(messages).toEqual([])
})
```

**Step 2: Run test — fails** with "not yet implemented (Session 4)"

**Step 3: Replace the stub**

```ts
async getMessages(_worktreePath: string, _agentSessionId: string): Promise<unknown[]> {
  // Real implementation deferred to Session 5 (Transcript + Session Metadata)
  return []
}
```

**Step 4: Run test — passes**

**Step 5: Commit**

```
chore: stub getMessages to return empty array (deferred to Session 5)
```

---

## Task 6: Wire IPC Dispatch for `opencode:prompt` and `opencode:abort`

**Files:**

- Modify: `src/main/ipc/opencode-handlers.ts`
- Modify: `src/main/index.ts`
- Test: `test/phase-21/session-4/ipc-sdk-routing.test.ts` (expand)

This task wires the actual IPC handler dispatch established in Task 2. The key additions:

**Step 1: Expand the routing test**

Add to `test/phase-21/session-4/ipc-sdk-routing.test.ts`:

```ts
describe('resolveImplementer helper', () => {
  // Test the resolution logic directly (import from handler module or test inline)
  it('returns OpenCode impl when DB returns "opencode"', () => { ... })
  it('returns Claude impl when DB returns "claude-code"', () => { ... })
  it('falls back to OpenCode when DB returns null', () => { ... })
})
```

**Step 2: Modify `opencode:prompt` handler**

In `src/main/ipc/opencode-handlers.ts`, update the prompt handler to check for Claude dispatch first:

```ts
// Inside opencode:prompt handler, after arg parsing:
if (sdkManager && dbService) {
  const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
  if (sdkId === 'claude-code') {
    const impl = sdkManager.getImplementer('claude-code')
    await impl.prompt(worktreePath, opencodeSessionId, messageOrParts, model)
    return { success: true }
  }
}
// Fall through to existing openCodeService.prompt(...)
```

**Step 3: Modify `opencode:abort` handler**

Same pattern:

```ts
if (sdkManager && dbService) {
  const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
  if (sdkId === 'claude-code') {
    const impl = sdkManager.getImplementer('claude-code')
    const result = await impl.abort(worktreePath, opencodeSessionId)
    return { success: result }
  }
}
// Fall through to existing openCodeService.abort(...)
```

**Step 4: Wire in `src/main/index.ts`**

```ts
import { ClaudeCodeImplementer } from './services/claude-code-implementer'
import { AgentSdkManager } from './services/agent-sdk-manager'

// In createWindow() after mainWindow is created:
const claudeImpl = new ClaudeCodeImplementer()

// Create a thin wrapper for openCodeService to satisfy AgentSdkManager constructor
// (openCodeService doesn't implement AgentSdkImplementer, but the manager just
//  needs an entry — prompt/abort dispatch falls through to openCodeService directly)
const sdkManager = new AgentSdkManager(
  /* opencode placeholder — dispatch never reaches it */ createOpenCodePlaceholder(),
  claudeImpl
)
sdkManager.setMainWindow(mainWindow)

registerOpenCodeHandlers(mainWindow, sdkManager, databaseService)
```

> **Implementation note:** Since `openCodeService` doesn't implement `AgentSdkImplementer`, the simplest path is to not register an OpenCode implementer at all and only use the manager for Claude dispatch. Adjust `AgentSdkManager` constructor to accept `claudeCode` only, or create a minimal placeholder that throws "use openCodeService directly". The handler's dispatch logic already falls through to `openCodeService` for non-claude sessions.

**Step 5: Run all tests**

Run: `pnpm vitest run test/phase-21/session-4/`
Expected: ALL PASS

**Step 6: Commit**

```
feat: wire SDK-aware dispatch in opencode:prompt and opencode:abort IPC handlers
```

---

## Task 7: Update Existing Session ID in DB After Materialization

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts` (import DB, update `opencode_session_id`)
- Test: `test/phase-21/session-4/claude-prompt-streaming.test.ts` (add test)

When a `pending::` session ID materializes to a real SDK session ID, we need to update the DB row's `opencode_session_id` so that future IPC calls (using the new real ID) can resolve the correct `agent_sdk`.

**Step 1: Add test**

```ts
it('updates DB opencode_session_id after materialization', async () => {
  // This test may need a mock DatabaseService or be an integration-level test
  // Verify that after prompt() materializes a pending:: ID, the DB is updated
})
```

**Step 2: Implementation**

The `ClaudeCodeImplementer` needs access to `DatabaseService`. Options:

- Constructor injection: `new ClaudeCodeImplementer(dbService)`
- Method on the interface: `setDatabaseService(db)` (looser coupling)

Add to the materialization block in `prompt()`:

```ts
if (sdkSessionId && session.claudeSessionId.startsWith('pending::')) {
  // ... existing re-keying logic ...

  // Update DB so future IPC calls with the new ID resolve correctly
  if (this.dbService) {
    const hiveSession = this.dbService.getSession(session.hiveSessionId)
    if (hiveSession) {
      this.dbService.updateSession(session.hiveSessionId, {
        opencode_session_id: sdkSessionId
      })
      log.info('Updated DB opencode_session_id', {
        hiveSessionId: session.hiveSessionId,
        newAgentSessionId: sdkSessionId
      })
    }
  }
}
```

**Step 3: Commit**

```
feat: persist materialized Claude session ID to DB for future IPC routing
```

---

## Task 8: Integration Smoke Test + Full Suite Verification

**Files:**

- Test: `test/phase-21/session-4/integration-smoke.test.ts`

**Step 1: Write integration test**

```ts
// test/phase-21/session-4/integration-smoke.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ... mocks ...

describe('Session 4 – Integration smoke test', () => {
  it('connect → prompt → stream events → idle lifecycle', async () => {
    // 1. Connect (get pending:: ID)
    // 2. Prompt with mock SDK yielding [assistant, result] messages
    // 3. Assert: busy → message.part.updated → message.updated → idle
    // 4. Assert session materialized with real ID
  })

  it('connect → prompt → abort → idle lifecycle', async () => {
    // 1. Connect
    // 2. Start prompt with a slow-yielding mock iterator
    // 3. Abort mid-stream
    // 4. Assert: busy → (partial events) → idle
  })

  it('reconnect → prompt uses resume option', async () => {
    // 1. Reconnect with known ID
    // 2. Prompt
    // 3. Assert query() called with options.resume set
  })
})
```

**Step 2: Run full test suite**

```bash
pnpm vitest run test/phase-21/session-4/
pnpm lint
pnpm test
pnpm build
```

**Step 3: Commit**

```
test: add Session 4 integration smoke tests for streaming + abort lifecycle
```

---

## Task Dependency Graph

```
Task 1 (DB lookup)
  └─→ Task 2 (AgentSdkManager wiring)
       └─→ Task 6 (IPC dispatch) ─→ Task 8 (Integration)
Task 3 (prompt implementation) ─→ Task 7 (DB materialization) ─→ Task 8
Task 4 (abort implementation) ─→ Task 8
Task 5 (getMessages stub) ─→ Task 8
```

Tasks 1, 3, 4, 5 can start in parallel. Task 2 depends on Task 1. Task 6 depends on Tasks 2+3+4. Task 7 depends on Task 3. Task 8 depends on all others.

---

## Files Modified (Summary)

| File                                                      | Action                                                        | Task       |
| --------------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| `src/main/db/database.ts`                                 | Add `getAgentSdkForSession()`                                 | 1          |
| `src/main/services/claude-code-implementer.ts`            | Implement `prompt()`, `abort()`, `getMessages()`, add helpers | 3, 4, 5, 7 |
| `src/main/ipc/opencode-handlers.ts`                       | Add SDK dispatch logic, accept `AgentSdkManager`              | 2, 6       |
| `src/main/ipc/index.ts`                                   | Update exports                                                | 2          |
| `src/main/index.ts`                                       | Instantiate `AgentSdkManager`, pass to handlers               | 2, 6       |
| `test/phase-21/session-4/db-agent-session-lookup.test.ts` | New                                                           | 1          |
| `test/phase-21/session-4/ipc-sdk-routing.test.ts`         | New                                                           | 2, 6       |
| `test/phase-21/session-4/claude-prompt-streaming.test.ts` | New                                                           | 3, 5       |
| `test/phase-21/session-4/claude-abort.test.ts`            | New                                                           | 4          |
| `test/phase-21/session-4/integration-smoke.test.ts`       | New                                                           | 8          |

## Definition of Done Checklist

- [ ] `ClaudeCodeImplementer.prompt()` streams real SDK events as normalized `opencode:stream` payloads
- [ ] `ClaudeCodeImplementer.abort()` stops streaming and returns session to idle
- [ ] `pending::` session IDs materialize to real SDK IDs on first prompt
- [ ] Materialized IDs are persisted to DB for future routing
- [ ] IPC handlers dispatch `opencode:prompt` and `opencode:abort` to correct implementer based on `agent_sdk`
- [ ] `getMessages` returns `[]` (Session 5 stub)
- [ ] All event types renderer expects (`session.status`, `message.part.updated`, `message.updated`, `session.error`) are emitted correctly
- [ ] `pnpm vitest run test/phase-21/session-4/` — all pass
- [ ] `pnpm lint` — passes
- [ ] `pnpm test` — passes
- [ ] `pnpm build` — passes
