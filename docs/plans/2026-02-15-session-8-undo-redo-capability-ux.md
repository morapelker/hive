# Session 8: Undo/Redo + Capability-Driven UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Claude undo via the SDK's `rewindFiles` API, add SDK-aware IPC dispatch for undo/redo, expose runtime capabilities to the renderer, and gate all undo/redo UI affordances on actual capabilities rather than hardcoded SDK identity checks.

**Architecture:** The Claude SDK provides `rewindFiles(userMessageId)` for file-level undo (requires `enableFileCheckpointing: true` in query options) but has no redo equivalent. Undo truncates the in-memory message list and tracks a revert boundary. Redo is explicitly unsupported for Claude (`supportsRedo: false`). The renderer learns about capabilities via a new `opencode:capabilities` IPC channel and gates slash commands, menu items, and revert-banner affordances accordingly. The existing `isClaudeCode` identity checks are replaced with capability-based logic.

**Tech Stack:** Electron IPC, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Vitest, React/Zustand

---

## Analysis of Current State

### What exists

- `ClaudeCodeImplementer.undo()` and `.redo()` are stubs throwing "not yet implemented (Session 8)"
- `ClaudeCodeImplementer.getSessionInfo()` returns `{ revertMessageID: null, revertDiff: null }` (stub)
- `CLAUDE_CODE_CAPABILITIES` in `agent-sdk-types.ts`: `supportsUndo: true, supportsRedo: false`
- `session.checkpoints` Map tracks user message UUIDs to message indices during streaming
- `enableFileCheckpointing` is NOT set in the SDK query options
- Undo/redo IPC handlers (`opencode:undo`, `opencode:redo`) route only to `openCodeService` -- no SDK dispatch
- No `opencode:capabilities` IPC channel exists
- Slash commands `/undo` and `/redo` always shown regardless of SDK
- Menu undo/redo enabled/disabled as a group based on `hasActiveSession` only
- `SessionView.tsx` uses `isClaudeCode = sessionRecord?.agent_sdk === 'claude-code'` for plan-mode branching (5 locations)

### What needs to change

1. Enable file checkpointing in Claude SDK query options
2. Implement `ClaudeCodeImplementer.undo()` using `rewindFiles()` + message truncation
3. Implement `ClaudeCodeImplementer.redo()` to return explicit unsupported error
4. Implement `ClaudeCodeImplementer.getSessionInfo()` to return tracked revert boundary
5. Add SDK-aware dispatch to `opencode:undo` and `opencode:redo` IPC handlers
6. Add `opencode:capabilities` IPC channel + preload bridge
7. Gate `/redo` slash command visibility on `supportsRedo` capability
8. Gate "Redo Turn" menu item on `supportsRedo` capability
9. Replace `isClaudeCode` identity checks with capability-based logic where appropriate
10. Write tests for all of the above

---

## Task 1: Enable File Checkpointing in Claude SDK Query Options

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts` (lines 294-307, the `options` object in `prompt()`)

**Step 1: Write the failing test**

Create `test/phase-21/session-8/claude-undo-redo.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the SDK and dependencies following the pattern from session-4 tests
// Test that when prompt() builds query options, enableFileCheckpointing is true

describe('ClaudeCodeImplementer undo/redo', () => {
  describe('file checkpointing', () => {
    it('should pass enableFileCheckpointing: true in query options', async () => {
      // Arrange: set up implementer with mocked SDK
      // Act: call prompt()
      // Assert: verify the options object passed to sdk.query() includes enableFileCheckpointing: true
    })
  })
})
```

The actual test structure should follow the mocking patterns from `test/phase-21/session-4/claude-prompt-streaming.test.ts`.

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/phase-21/session-8/claude-undo-redo.test.ts
```

Expected: FAIL

**Step 3: Add `enableFileCheckpointing: true` to query options**

In `src/main/services/claude-code-implementer.ts`, inside `prompt()` at the options object (around line 294):

```ts
const options: Record<string, unknown> = {
  cwd: session.worktreePath,
  permissionMode: sdkPermissionMode,
  abortController: session.abortController,
  maxThinkingTokens: 31999,
  model: modelOverride?.modelID ?? this.selectedModel,
  includePartialMessages: true,
  canUseTool: this.createCanUseToolCallback(session),
  enableFileCheckpointing: true // <-- ADD THIS
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/phase-21/session-8/claude-undo-redo.test.ts
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(session-8): enable file checkpointing in Claude SDK query options"
```

---

## Task 2: Add Revert Boundary Tracking to ClaudeSessionState

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts` (ClaudeSessionState interface + undo/redo/getSessionInfo methods)

**Step 1: Write failing tests**

Add to `test/phase-21/session-8/claude-undo-redo.test.ts`:

```ts
describe('undo', () => {
  it('should rewind files to the last user message checkpoint', async () => {
    // Arrange: mock session with 2 user messages in checkpoints
    // Mock rewindFiles to return { canRewind: true, filesChanged: ['a.ts'], insertions: 0, deletions: 5 }
    // Act: call undo()
    // Assert: rewindFiles was called with the correct user message UUID
  })

  it('should set revertMessageID on the session state', async () => {
    // After undo, getSessionInfo should return the revert boundary
  })

  it('should truncate in-memory messages to the revert boundary', async () => {
    // After undo, getMessages should not include messages at/after the boundary
  })

  it('should return revertMessageID, restoredPrompt, and revertDiff', async () => {
    // The return value contract matches what the IPC handler expects
  })

  it('should throw when there are no user messages to undo', async () => {
    // Calling undo with no checkpoints should throw 'Nothing to undo'
  })

  it('should handle rewindFiles returning canRewind: false', async () => {
    // Should throw a clear error
  })

  it('should walk backward past already-reverted messages', async () => {
    // If already at a revert boundary, undo should go one step further back
  })
})

describe('redo', () => {
  it('should return an explicit unsupported error', async () => {
    // redo() should throw or return { success: false } with clear message
  })
})

describe('getSessionInfo', () => {
  it('should return null revert state when no undo has been performed', async () => {
    // Default state
  })

  it('should return the current revert boundary after undo', async () => {
    // After calling undo, getSessionInfo returns the revertMessageID
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
pnpm vitest run test/phase-21/session-8/claude-undo-redo.test.ts
```

**Step 3: Implement undo, redo, and getSessionInfo**

Add two fields to `ClaudeSessionState` interface:

```ts
export interface ClaudeSessionState {
  // ... existing fields ...
  /** Current revert boundary message ID (hive-side), set by undo */
  revertMessageID: string | null
  /** Diff string from last rewindFiles result */
  revertDiff: string | null
}
```

Initialize them as `null` wherever sessions are created (in `connect()` and `reconnect()`).

**Implement `undo()`:**

```ts
async undo(
  worktreePath: string,
  agentSessionId: string,
  _hiveSessionId: string
): Promise<{ revertMessageID: string; restoredPrompt: string; revertDiff: string | null }> {
  const session = this.getSession(worktreePath, agentSessionId)
  if (!session) throw new Error('No active session')

  // Find the last user message UUID BEFORE the current revert boundary
  // Walk checkpoints in reverse order (by message index)
  const sortedCheckpoints = [...session.checkpoints.entries()]
    .sort((a, b) => b[1] - a[1])  // descending by message index

  let targetUuid: string | null = null
  let targetMsgIndex: number = -1

  for (const [uuid, msgIndex] of sortedCheckpoints) {
    // Skip messages at or after current revert boundary
    if (session.revertMessageID) {
      const currentBoundaryIndex = this.findMessageIndexById(session, session.revertMessageID)
      if (currentBoundaryIndex >= 0 && msgIndex >= currentBoundaryIndex) continue
    }
    targetUuid = uuid
    targetMsgIndex = msgIndex
    break
  }

  if (!targetUuid || targetMsgIndex < 0) {
    throw new Error('Nothing to undo')
  }

  // Call SDK rewindFiles
  if (!session.query) {
    // Need an active query reference for rewindFiles
    // Use the SDK directly if no active query
    throw new Error('Cannot undo: no active SDK query. Reconnect and try again.')
  }

  const result = await (session.query as any).rewindFiles(targetUuid)
  if (!result.canRewind) {
    throw new Error(result.error || 'Cannot rewind files at this point')
  }

  // Build a diff summary from the result
  const revertDiff = result.filesChanged?.length
    ? `${result.filesChanged.length} file(s) changed: ${result.filesChanged.join(', ')}` +
      (result.insertions ? ` (+${result.insertions})` : '') +
      (result.deletions ? ` (-${result.deletions})` : '')
    : null

  // Find the user message at this checkpoint to extract the prompt text
  const userMsg = session.messages[targetMsgIndex] as Record<string, unknown> | undefined
  const restoredPrompt = this.extractPromptFromMessage(userMsg)

  // The revert boundary message ID should be the HIVE-side ID of the user message
  const hiveMessageId = (userMsg?.id as string) ?? `revert-${targetUuid}`

  // Set revert boundary
  session.revertMessageID = hiveMessageId
  session.revertDiff = revertDiff

  return { revertMessageID: hiveMessageId, restoredPrompt, revertDiff }
}
```

**Implement `redo()`:**

```ts
async redo(
  _worktreePath: string,
  _agentSessionId: string,
  _hiveSessionId: string
): Promise<unknown> {
  throw new Error('Redo is not supported for Claude Code sessions')
}
```

**Implement `getSessionInfo()`:**

```ts
async getSessionInfo(
  worktreePath: string,
  agentSessionId: string
): Promise<{ revertMessageID: string | null; revertDiff: string | null }> {
  const session = this.getSession(worktreePath, agentSessionId)
  return {
    revertMessageID: session?.revertMessageID ?? null,
    revertDiff: session?.revertDiff ?? null
  }
}
```

Add helper `extractPromptFromMessage()`:

```ts
private extractPromptFromMessage(msg: Record<string, unknown> | undefined): string {
  if (!msg) return ''
  const parts = msg.parts as Array<Record<string, unknown>> | undefined
  if (parts) {
    const textPart = parts.find((p) => p.type === 'text')
    if (textPart?.text) return String(textPart.text)
  }
  if (typeof msg.content === 'string') return msg.content
  return ''
}
```

Add helper `findMessageIndexById()`:

```ts
private findMessageIndexById(session: ClaudeSessionState, messageId: string): number {
  return session.messages.findIndex(
    (m) => (m as Record<string, unknown>).id === messageId
  )
}
```

**Important design note on `rewindFiles` and the query object:** The Claude SDK's `rewindFiles` is a method on the `Query` object, which only exists during an active streaming call. When no query is active, we need an alternative approach. Two options:

- **Option A:** Keep the last completed query reference alive (don't null it out in the `finally` block) so `rewindFiles` can be called after streaming finishes. The SDK may or may not support this.
- **Option B:** Create a new no-op query just for the `rewindFiles` call by calling `sdk.query({ prompt: '', options: { resume: sessionId, enableFileCheckpointing: true } })` and then calling `rewindFiles` on it.

**Investigation needed:** Before implementation, test whether `rewindFiles` works on a completed (non-active) query object. If not, we need to restructure the query lifecycle. The plan should start by writing a quick spike test against the real SDK to confirm this behavior. If `rewindFiles` requires an active query, Option B (create a lightweight query just for undo) is the fallback.

**Alternatively**, `rewindFiles` may be callable via the SDK control message interface directly without a query. The `SDKControlRewindFilesRequest` type suggests a control-message path exists. Investigate whether `ClaudeClient` has a `sendControlMessage` or similar API.

**Step 4: Run tests to verify they pass**

```bash
pnpm vitest run test/phase-21/session-8/claude-undo-redo.test.ts
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(session-8): implement Claude undo via rewindFiles + revert boundary tracking"
```

---

## Task 3: Add SDK-Aware Dispatch to Undo/Redo IPC Handlers

**Files:**

- Modify: `src/main/ipc/opencode-handlers.ts` (lines 361-395)
- Test: `test/phase-21/session-8/ipc-undo-redo-routing.test.ts`

**Step 1: Write the failing test**

Create `test/phase-21/session-8/ipc-undo-redo-routing.test.ts`:

```ts
describe('opencode:undo IPC routing', () => {
  it('should route to ClaudeCodeImplementer for claude-code sessions', async () => {
    // Mock dbService.getAgentSdkForSession to return 'claude-code'
    // Mock sdkManager.getImplementer('claude-code') to return mock implementer
    // Invoke the handler
    // Assert: claude implementer's undo was called, openCodeService.undo was NOT called
  })

  it('should fall through to openCodeService for opencode sessions', async () => {
    // Mock dbService.getAgentSdkForSession to return 'opencode'
    // Assert: openCodeService.undo was called
  })

  it('should fall through to openCodeService when sdkManager is unavailable', async () => {
    // No sdkManager provided
    // Assert: openCodeService.undo was called
  })
})

describe('opencode:redo IPC routing', () => {
  it('should route to ClaudeCodeImplementer for claude-code sessions', async () => {
    // For Claude, redo should return { success: false, error: 'not supported' }
  })

  it('should fall through to openCodeService for opencode sessions', async () => {
    // Assert: openCodeService.redo was called
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
pnpm vitest run test/phase-21/session-8/ipc-undo-redo-routing.test.ts
```

**Step 3: Add SDK dispatch to both handlers**

Replace `opencode:undo` handler (lines 361-377) with:

```ts
ipcMain.handle(
  'opencode:undo',
  async (_event, { worktreePath, sessionId }: { worktreePath: string; sessionId: string }) => {
    log.info('IPC: opencode:undo', { worktreePath, sessionId })
    try {
      // SDK-aware dispatch
      if (sdkManager && dbService) {
        const sdkId = dbService.getAgentSdkForSession(sessionId)
        if (sdkId === 'claude-code') {
          const impl = sdkManager.getImplementer('claude-code')
          const result = await impl.undo(worktreePath, sessionId, '')
          return { success: true, ...(result as Record<string, unknown>) }
        }
      }
      // Fall through to existing OpenCode path
      const result = await openCodeService.undo(worktreePath, sessionId)
      return { success: true, ...result }
    } catch (error) {
      log.error('IPC: opencode:undo failed', { error })
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  }
)
```

Apply the same pattern to `opencode:redo` (lines 379-395).

**Step 4: Run tests to verify they pass**

```bash
pnpm vitest run test/phase-21/session-8/ipc-undo-redo-routing.test.ts
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(session-8): add SDK-aware dispatch for undo/redo IPC handlers"
```

---

## Task 4: Add `opencode:capabilities` IPC Channel

**Files:**

- Modify: `src/main/ipc/opencode-handlers.ts` (add new handler)
- Modify: `src/preload/index.ts` (expose capability query)
- Modify: `src/preload/index.d.ts` (add type declaration)
- Test: `test/phase-21/session-8/capabilities-ipc.test.ts`

**Step 1: Write the failing test**

Create `test/phase-21/session-8/capabilities-ipc.test.ts`:

```ts
describe('opencode:capabilities IPC', () => {
  it('should return CLAUDE_CODE_CAPABILITIES for claude-code sessions', async () => {
    // Assert supportsRedo === false for Claude
  })

  it('should return OPENCODE_CAPABILITIES for opencode sessions', async () => {
    // Assert supportsRedo === true for OpenCode
  })

  it('should return default capabilities when no session is found', async () => {
    // Returns opencode capabilities as default
  })
})
```

**Step 2: Run tests to verify they fail**

````Step 3: Implement the IPC handler, preload bridge, and type declaration**

In `src/main/ipc/opencode-handlers.ts`, add:

```ts
ipcMain.handle(
  'opencode:capabilities',
  async (_event, { sessionId }: { sessionId?: string }) => {
    try {
      if (sdkManager && dbService && sessionId) {
        const sdkId = dbService.getAgentSdkForSession(sessionId)
        if (sdkId) {
          return { success: true, capabilities: sdkManager.getCapabilities(sdkId) }
        }
      }
      // Default to opencode capabilities
      return { success: true, capabilities: sdkManager?.getCapabilities('opencode') ?? OPENCODE_CAPABILITIES }
    } catch (error) {
      log.error('IPC: opencode:capabilities failed', { error })
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  }
)
````

In `src/preload/index.ts`, add under `opencodeOps`:

```ts
capabilities: (
  opencodeSessionId?: string
): Promise<{
  success: boolean
  capabilities?: {
    supportsUndo: boolean
    supportsRedo: boolean
    supportsCommands: boolean
    supportsPermissionRequests: boolean
    supportsQuestionPrompts: boolean
    supportsModelSelection: boolean
    supportsReconnect: boolean
    supportsPartialStreaming: boolean
  }
  error?: string
}> => ipcRenderer.invoke('opencode:capabilities', { sessionId: opencodeSessionId }),
```

In `src/preload/index.d.ts`, add the corresponding type declaration in the `opencodeOps` namespace.

**Step 4: Run tests to verify they pass**

```bash
pnpm vitest run test/phase-21/session-8/capabilities-ipc.test.ts
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(session-8): add opencode:capabilities IPC channel for runtime capability queries"
```

---

## Task 5: Gate Slash Commands on Capabilities

**Files:**

- Modify: `src/renderer/src/components/sessions/SessionView.tsx` (filter `allSlashCommands`)
- Test: `test/phase-21/session-8/capability-gating-renderer.test.ts`

**Step 1: Write the failing test**

Create `test/phase-21/session-8/capability-gating-renderer.test.ts`:

```ts
describe('slash command capability gating', () => {
  it('should include /redo when supportsRedo is true (OpenCode)', () => {
    // Render SessionView with opencode session
    // Assert /redo is in the slash command list
  })

  it('should exclude /redo when supportsRedo is false (Claude)', () => {
    // Render SessionView with claude-code session
    // Assert /redo is NOT in the slash command list
  })

  it('should always include /undo when supportsUndo is true', () => {
    // Both SDKs support undo, so /undo should always be present
  })
})
```

**Step 2: Run tests to verify they fail**

**Step 3: Implement capability-based filtering**

In `SessionView.tsx`, add a capabilities query that fires when `opencodeSessionId` changes:

```ts
const [sessionCapabilities, setSessionCapabilities] = useState<{
  supportsUndo: boolean
  supportsRedo: boolean
} | null>(null)

useEffect(() => {
  if (!opencodeSessionId) return
  window.opencodeOps
    .capabilities(opencodeSessionId)
    .then((result) => {
      if (result.success && result.capabilities) {
        setSessionCapabilities(result.capabilities)
      }
    })
    .catch(() => {})
}, [opencodeSessionId])
```

Update `allSlashCommands` memo to filter based on capabilities:

```ts
const allSlashCommands = useMemo(() => {
  const seen = new Set<string>()
  const ordered = [...BUILT_IN_SLASH_COMMANDS, ...slashCommands]
  return ordered.filter((command) => {
    const key = command.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    // Gate on capabilities
    if (key === 'undo' && sessionCapabilities && !sessionCapabilities.supportsUndo) return false
    if (key === 'redo' && sessionCapabilities && !sessionCapabilities.supportsRedo) return false
    return true
  })
}, [slashCommands, sessionCapabilities])
```

Also update the `/redo` handling in `handleSend` to check capability before executing:

```ts
if (commandName === 'redo') {
  if (sessionCapabilities && !sessionCapabilities.supportsRedo) {
    toast.error('Redo is not supported for this session type')
    return
  }
  // ... existing redo logic
}
```

**Step 4: Run tests to verify they pass**

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(session-8): gate /undo and /redo slash commands on runtime capabilities"
```

---

## Task 6: Gate Menu Undo/Redo on Capabilities

**Files:**

- Modify: `src/main/menu.ts` (`MenuState` interface, `updateMenuState` function)
- Modify: `src/preload/index.ts` and `src/preload/index.d.ts` (update `updateMenuState` signature)
- Modify: `src/renderer/src/hooks/useKeyboardShortcuts.ts` (`useMenuStateUpdater` function)
- Test: `test/phase-21/session-8/menu-capability-gating.test.ts`

**Step 1: Write the failing test**

```ts
describe('menu capability gating', () => {
  it('should disable Redo Turn menu item when supportsRedo is false', () => {
    // Call updateMenuState with canRedo: false
    // Assert 'session-redo-turn' menu item is disabled
  })

  it('should enable both Undo/Redo when capabilities support both', () => {
    // Call updateMenuState with canUndo: true, canRedo: true
    // Assert both items enabled
  })
})
```

**Step 2: Run tests to verify they fail**

**Step 3: Extend MenuState and update logic**

In `src/main/menu.ts`, extend `MenuState`:

```ts
export interface MenuState {
  hasActiveSession: boolean
  hasActiveWorktree: boolean
  canUndo?: boolean // defaults to hasActiveSession if undefined
  canRedo?: boolean // defaults to hasActiveSession if undefined
}
```

Update `updateMenuState`:

```ts
export function updateMenuState(state: MenuState): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return

  for (const id of sessionItemIds) {
    const item = menu.getMenuItemById(id)
    if (!item) continue

    if (id === 'session-undo-turn') {
      item.enabled = state.canUndo ?? state.hasActiveSession
    } else if (id === 'session-redo-turn') {
      item.enabled = state.canRedo ?? state.hasActiveSession
    } else {
      item.enabled = state.hasActiveSession
    }
  }

  for (const id of worktreeItemIds) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = state.hasActiveWorktree
  }
}
```

Update preload `updateMenuState` signature to include `canUndo?` and `canRedo?`.

Update `useMenuStateUpdater` in `useKeyboardShortcuts.ts` to query capabilities when the active session changes:

```ts
function useMenuStateUpdater(): void {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)

  // Look up the agent session ID for capability query
  const sessionRecord = useSessionStore((state) => {
    if (!activeSessionId) return null
    for (const sessions of state.sessionsByWorktree.values()) {
      const found = sessions.find((s) => s.id === activeSessionId)
      if (found) return found
    }
    return null
  })

  useEffect(() => {
    if (!window.systemOps?.updateMenuState) return

    const baseState = {
      hasActiveSession: !!activeSessionId,
      hasActiveWorktree: !!selectedWorktreeId
    }

    if (!activeSessionId || !sessionRecord?.opencode_session_id) {
      window.systemOps.updateMenuState(baseState)
      return
    }

    // Query capabilities for the active session
    window.opencodeOps
      ?.capabilities(sessionRecord.opencode_session_id)
      .then((result) => {
        window.systemOps.updateMenuState({
          ...baseState,
          canUndo: result.success ? result.capabilities?.supportsUndo : true,
          canRedo: result.success ? result.capabilities?.supportsRedo : true
        })
      })
      .catch(() => {
        window.systemOps.updateMenuState(baseState)
      })
  }, [activeSessionId, selectedWorktreeId, sessionRecord?.opencode_session_id])
}
```

**Step 4: Run tests to verify they pass**

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(session-8): gate menu undo/redo items on runtime SDK capabilities"
```

---

## Task 7: Replace `isClaudeCode` Identity Checks with Capability-Based Logic

**Files:**

- Modify: `src/renderer/src/components/sessions/SessionView.tsx` (5 locations using `isClaudeCode`)

**Step 1: Analyze each `isClaudeCode` usage**

The 5 locations are all related to **plan mode prefix handling**, not undo/redo:

- Line 1771: Skip `PLAN_MODE_PREFIX` for Claude (uses native plan mode)
- Line 2302: Same
- Line 2330: Same
- Line 2393: `handlePlanReadyImplement` branches on `isClaudeCode`
- Line 2769: `showPlanReadyImplementFab` logic

These are **not capability-gated** -- they're about behavioral differences in how Claude handles plan mode natively vs OpenCode needing a text prefix. This is legitimately SDK-specific behavior, not something that maps to a generic capability boolean.

**Decision:** Leave plan-mode `isClaudeCode` checks as-is. They represent a genuine behavioral difference, not a capability gate. The Session 8 task "Replace hardcoded renderer capability logic" specifically references `getSessionSdkCapabilities` and "mock-specific messages" -- neither of which exist in the current codebase (they were already cleaned up).

**What to do instead:** Add a check in the undo/redo event handlers that guards against calling redo on a session that doesn't support it:

```ts
// In the handleRedo function (both slash command and menu paths):
if (sessionCapabilities && !sessionCapabilities.supportsRedo) {
  toast.error('Redo is not supported for this session type')
  return
}
```

**Step 2: Write tests**

Add to `test/phase-21/session-8/capability-gating-renderer.test.ts`:

```ts
it('should show error toast when /redo attempted on Claude session', () => {
  // Mock capabilities with supportsRedo: false
  // Attempt to send /redo
  // Assert toast.error called with appropriate message
})

it('should not show error for /undo on Claude session', () => {
  // Mock capabilities with supportsUndo: true
  // Attempt /undo
  // Assert it proceeds normally
})
```

**Step 3: Implement guards**

**Step 4: Run tests**

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(session-8): add capability guards for redo in event handlers"
```

---

## Task 8: Clear Revert State on New Prompt for Claude Sessions

**Files:**

- Modify: `src/main/services/claude-code-implementer.ts` (in `prompt()` method)

**Step 1: Write the failing test**

```ts
it('should clear revert boundary when a new prompt is sent', async () => {
  // Arrange: session has a revert boundary from a previous undo
  // Act: call prompt() with new message
  // Assert: session.revertMessageID is null after prompt starts
})
```

**Step 2: Run test to verify it fails**

**Step 3: Add revert state clearing at the start of `prompt()`**

In `claude-code-implementer.ts` `prompt()` method, after obtaining the session reference:

```ts
// Clear revert boundary -- sending a new message supersedes any undo state
session.revertMessageID = null
session.revertDiff = null
```

**Step 4: Run tests**

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(session-8): clear Claude revert state when new prompt is sent"
```

---

## Task 9: Integration Verification + Lint + Build

**Files:**

- Create: `test/phase-21/session-8/integration-verification.test.ts`

**Step 1: Write integration verification test**

```ts
describe('Session 8 integration verification', () => {
  it('CLAUDE_CODE_CAPABILITIES has supportsUndo: true and supportsRedo: false', () => {
    expect(CLAUDE_CODE_CAPABILITIES.supportsUndo).toBe(true)
    expect(CLAUDE_CODE_CAPABILITIES.supportsRedo).toBe(false)
  })

  it('ClaudeCodeImplementer.undo does not throw "not yet implemented"', async () => {
    // Verify the stub has been replaced
  })

  it('ClaudeCodeImplementer.redo throws unsupported error (not "not yet implemented")', async () => {
    // Verify it throws the correct error message
  })

  it('ClaudeCodeImplementer.getSessionInfo returns tracked revert state', async () => {
    // Verify it reads from session state, not hardcoded null
  })

  it('opencode:undo handler has SDK dispatch', () => {
    // Verify the handler code contains sdkManager/dbService checks
    // (This can be a source-level assertion or a behavioral test)
  })
})
```

**Step 2: Run full verification**

```bash
pnpm lint
pnpm test
pnpm build
```

**Step 3: Commit**

```bash
git add -A && git commit -m "test(session-8): add integration verification tests"
```

---

## Definition of Done Checklist

- [ ] `enableFileCheckpointing: true` set in Claude SDK query options
- [ ] `ClaudeCodeImplementer.undo()` calls `rewindFiles()` and returns `{ revertMessageID, restoredPrompt, revertDiff }`
- [ ] `ClaudeCodeImplementer.redo()` returns explicit unsupported error
- [ ] `ClaudeCodeImplementer.getSessionInfo()` returns tracked revert boundary state
- [ ] Revert boundary cleared when new prompt is sent
- [ ] `opencode:undo` and `opencode:redo` IPC handlers have SDK-aware dispatch
- [ ] `opencode:capabilities` IPC channel exists and works
- [ ] `/redo` slash command hidden for sessions where `supportsRedo: false`
- [ ] "Redo Turn" menu item disabled for sessions where `supportsRedo: false`
- [ ] Redo attempts on unsupported sessions show clear error message
- [ ] All existing undo/redo behavior for OpenCode sessions unchanged
- [ ] `pnpm lint`, `pnpm test`, and `pnpm build` all pass

---

## Open Questions / Risks

1. **`rewindFiles` lifecycle:** The `rewindFiles` method is on the `Query` object, which is only alive during streaming. After streaming completes, `session.query` is set to `null`. We need to confirm whether:
   - The query object remains usable after iteration completes (before nulling)
   - Or we need to keep a reference to the last completed query
   - Or we need to use the SDK's control message interface directly
   - **Mitigation:** Task 2 should start with a spike test against the real SDK. If `rewindFiles` doesn't work on completed queries, restructure to keep the query alive or use a control-message approach.

2. **Claude SDK `rewindFiles` may not produce a git-style diff.** The `RewindFilesResult` returns `filesChanged`, `insertions`, and `deletions` -- not a unified diff string. The renderer's revert banner and `revertDiff` state expect either a diff string or null. We synthesize a summary string from the result metadata, which is a different format than what OpenCode returns. This should be fine since the diff is primarily for informational display.

3. **Checkpoint availability:** `session.checkpoints` is only populated during live streaming (from `SDKUserMessage.uuid`). If the session was reconnected (not the original streaming session), checkpoints may be empty. The transcript reader would need to be extended to populate checkpoints from historical data, or undo would only work for messages sent in the current app session.
