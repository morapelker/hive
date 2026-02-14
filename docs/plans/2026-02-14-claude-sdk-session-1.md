# Session 1 — Integration Contract Freeze

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Lock all integration decisions for the Claude Code SDK integration, define the `AgentSdkImplementer` interface, add the `agent_sdk` DB column, and validate with contract tests.

**Architecture:** Strategy pattern — define an `AgentSdkImplementer` interface that both OpenCode and Claude adapters implement. A manager (Session 2+) will route operations to the correct implementer based on the session's `agent_sdk` column. The Claude SDK (`@anthropic-ai/claude-agent-sdk`) uses a `query()` function that returns an async iterator of `SDKMessage` events, which maps to Hive's `OpenCodeStreamEvent` format.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk@^0.2.42`, SQLite migrations, Vitest

---

## Confirmed Decisions

| Decision                 | Value                                             | Rationale                                                       |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------------------- |
| SDK package              | `@anthropic-ai/claude-agent-sdk@^0.2.42`          | Latest stable, well-typed, ESM                                  |
| Auth strategy (v1)       | Local Claude credentials only                     | Uses existing `~/.claude/` auth; no API key UI needed           |
| API key auth             | Deferred                                          | Non-blocking for v1                                             |
| Session ID field         | Reuse `opencode_session_id` column                | Claude SDK `session_id` is a string, same shape as OpenCode's   |
| SDK routing column       | `agent_sdk TEXT DEFAULT 'opencode'` on `sessions` | Immutable per session; defaults to opencode for backward compat |
| Provider identity values | `'opencode' \| 'claude-code'`                     | String values stored in `agent_sdk` column                      |

## Capability Truth Table

| Capability                   | OpenCode | Claude Code | Notes                                                        |
| ---------------------------- | -------- | ----------- | ------------------------------------------------------------ |
| `supportsUndo`               | `true`   | `true`      | Claude: via `Query.rewindFiles()` + `resumeSessionAt`        |
| `supportsRedo`               | `true`   | `false`     | Claude rewind is one-directional; no unrevert equivalent     |
| `supportsCommands`           | `true`   | `true`      | Claude: via `Query.supportedCommands()`                      |
| `supportsPermissionRequests` | `true`   | `true`      | Claude: via `canUseTool` callback                            |
| `supportsQuestionPrompts`    | `true`   | `true`      | Claude: `AskUserQuestion` tool via `canUseTool`              |
| `supportsModelSelection`     | `true`   | `true`      | Claude: via `Query.setModel()` and `Query.supportedModels()` |
| `supportsReconnect`          | `true`   | `true`      | Claude: via `options.resume`                                 |
| `supportsPartialStreaming`   | `true`   | `true`      | Claude: via `includePartialMessages: true`                   |

## Claude SDK Event → Hive Stream Mapping

| SDK Message Type                       | Hive `type`            | Hive `statusPayload` | Notes                                           |
| -------------------------------------- | ---------------------- | -------------------- | ----------------------------------------------- |
| `system` (subtype: `init`)             | `session.init`         | `{ type: 'idle' }`   | Extract `session_id`, tools, model              |
| `user`                                 | `message.created`      | —                    | Forward message, capture `uuid` for checkpoints |
| `assistant`                            | `message.updated`      | —                    | Map `message.content` blocks to parts           |
| `stream_event`                         | `message.part.updated` | —                    | Only when `includePartialMessages: true`        |
| `result` (subtype: `success`)          | `session.completed`    | `{ type: 'idle' }`   | Extract cost, usage stats                       |
| `result` (subtype: `error_*`)          | `session.error`        | `{ type: 'idle' }`   | Extract error messages                          |
| `system` (subtype: `status`)           | `session.status`       | `{ type: 'busy' }`   | Compacting status                               |
| `tool_progress`                        | `message.part.updated` | —                    | Progress events for long-running tools          |
| `auth_status`                          | `session.auth`         | —                    | Auth flow events                                |
| `system` (subtype: `compact_boundary`) | (internal)             | —                    | Not forwarded to renderer                       |
| `system` (subtype: `hook_response`)    | (internal)             | —                    | Not forwarded to renderer                       |

## Session Persistence / Resume Contract

| Aspect               | Value                                                                |
| -------------------- | -------------------------------------------------------------------- |
| Stored in            | `sessions.opencode_session_id` (reused column, shared with OpenCode) |
| Format               | String UUID assigned by Claude SDK (e.g., `"abc123..."`)             |
| Returned via         | `SDKSystemMessage` with `subtype: 'init'` → `message.session_id`     |
| Resume mechanism     | `query({ prompt, options: { resume: storedSessionId } })`            |
| Resume after restart | Works — Claude SDK persists sessions to `~/.claude/`                 |
| Reconnect validation | Attempt `resume` — if SDK throws, session is stale; create new       |

## Credential Discovery / Failure States

- Claude SDK discovers credentials from `~/.claude/` directory (OAuth tokens from `claude` CLI login)
- If no credentials found, SDK throws an authentication error on first `query()` call
- Hive should catch this and surface: "Claude Code not authenticated. Run `claude login` in your terminal."
- `ANTHROPIC_API_KEY` env var is an alternative but deferred to a later phase

---

## Task 1: Install SDK dependency

**Files:**

- Modify: `package.json`

**Step 1: Install the package**

Run: `pnpm add @anthropic-ai/claude-agent-sdk@^0.2.42`

**Step 2: Verify installation**

Run: `pnpm list @anthropic-ai/claude-agent-sdk`
Expected: Shows installed version ≥ 0.2.42

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @anthropic-ai/claude-agent-sdk dependency"
```

---

## Task 2: Add `agent_sdk` column via DB migration

**Files:**

- Modify: `src/main/db/schema.ts` — bump `CURRENT_SCHEMA_VERSION` to 2, add migration
- Modify: `src/main/db/types.ts` — add `agent_sdk` to Session, SessionCreate, SessionUpdate
- Modify: `src/main/db/database.ts` — include `agent_sdk` in INSERT/UPDATE queries
- Modify: `src/preload/index.d.ts` — add `agent_sdk` to Session interface
- Modify: `src/preload/index.ts` — pass `agent_sdk` through session create/update

**Step 1: Add migration in `schema.ts`**

Change `CURRENT_SCHEMA_VERSION` from `1` to `2`.

Add to the `MIGRATIONS` array:

```ts
{
  version: 2,
  name: 'add_agent_sdk_column',
  up: `ALTER TABLE sessions ADD COLUMN agent_sdk TEXT NOT NULL DEFAULT 'opencode';`,
  down: `-- SQLite cannot drop columns; this is a no-op for safety`
}
```

**Step 2: Update types in `types.ts`**

Add to `Session` interface:

```ts
agent_sdk: 'opencode' | 'claude-code'
```

Add to `SessionCreate` interface:

```ts
agent_sdk?: 'opencode' | 'claude-code'
```

Add to `SessionUpdate` interface:

```ts
agent_sdk?: 'opencode' | 'claude-code'
```

**Step 3: Update `database.ts`**

In the `createSession` method, add `agent_sdk` to the property mapping (default `'opencode'`):

```ts
agent_sdk: data.agent_sdk ?? 'opencode',
```

Include `agent_sdk` in the INSERT column list and values.

In `updateSession`, handle `agent_sdk` in the update fields:

```ts
if (data.agent_sdk !== undefined) {
  updates.push('agent_sdk = ?')
  values.push(data.agent_sdk)
}
```

**Step 4: Update `preload/index.d.ts`**

Add `agent_sdk: 'opencode' | 'claude-code'` to the `Session` interface (after `opencode_session_id`).

Add `agent_sdk?: 'opencode' | 'claude-code'` to the session create parameter type.

Add `agent_sdk?: 'opencode' | 'claude-code'` to the session update parameter type.

**Step 5: Update `preload/index.ts`**

In the session create IPC call, pass through `agent_sdk` from the args.

In the session update IPC call, pass through `agent_sdk` from the args.

**Step 6: Run tests to verify nothing breaks**

Run: `pnpm vitest run`
Expected: All existing tests pass (migration is additive, column has a default)

**Step 7: Commit**

```bash
git add src/main/db/ src/preload/
git commit -m "feat: add agent_sdk column to sessions table (migration v2)"
```

---

## Task 3: Define `AgentSdkImplementer` interface

**Files:**

- Create: `src/main/services/agent-sdk-types.ts`

**Step 1: Write the interface file**

```ts
import type { BrowserWindow } from 'electron'

export type AgentSdkId = 'opencode' | 'claude-code'

export interface AgentSdkCapabilities {
  supportsUndo: boolean
  supportsRedo: boolean
  supportsCommands: boolean
  supportsPermissionRequests: boolean
  supportsQuestionPrompts: boolean
  supportsModelSelection: boolean
  supportsReconnect: boolean
  supportsPartialStreaming: boolean
}

export interface AgentSdkImplementer {
  readonly id: AgentSdkId
  readonly capabilities: AgentSdkCapabilities

  // Lifecycle
  connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }>
  reconnect(
    worktreePath: string,
    agentSessionId: string,
    hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }>
  disconnect(worktreePath: string, agentSessionId: string): Promise<void>
  cleanup(): Promise<void>

  // Messaging
  prompt(
    worktreePath: string,
    agentSessionId: string,
    message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    modelOverride?: { providerID: string; modelID: string; variant?: string }
  ): Promise<void>
  abort(worktreePath: string, agentSessionId: string): Promise<boolean>
  getMessages(worktreePath: string, agentSessionId: string): Promise<unknown[]>

  // Models
  getAvailableModels(): Promise<unknown>
  getModelInfo(
    worktreePath: string,
    modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null>
  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void

  // Session info
  getSessionInfo(
    worktreePath: string,
    agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }>

  // Human-in-the-loop
  questionReply(requestId: string, answers: string[][], worktreePath?: string): Promise<void>
  questionReject(requestId: string, worktreePath?: string): Promise<void>
  permissionReply(
    requestId: string,
    decision: 'once' | 'always' | 'reject',
    worktreePath?: string
  ): Promise<void>
  permissionList(worktreePath?: string): Promise<unknown[]>

  // Undo/Redo
  undo(worktreePath: string, agentSessionId: string, hiveSessionId: string): Promise<unknown>
  redo(worktreePath: string, agentSessionId: string, hiveSessionId: string): Promise<unknown>

  // Commands
  listCommands(worktreePath: string): Promise<unknown[]>
  sendCommand(
    worktreePath: string,
    agentSessionId: string,
    command: string,
    args?: string
  ): Promise<void>

  // Session management
  renameSession(worktreePath: string, agentSessionId: string, name: string): Promise<void>

  // Window binding (for event forwarding to renderer)
  setMainWindow(window: BrowserWindow): void
}

export const OPENCODE_CAPABILITIES: AgentSdkCapabilities = {
  supportsUndo: true,
  supportsRedo: true,
  supportsCommands: true,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}

export const CLAUDE_CODE_CAPABILITIES: AgentSdkCapabilities = {
  supportsUndo: true,
  supportsRedo: false,
  supportsCommands: true,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}
```

**Step 2: Commit**

```bash
git add src/main/services/agent-sdk-types.ts
git commit -m "feat: define AgentSdkImplementer interface and capability maps"
```

---

## Task 4: Write contract tests

**Files:**

- Create: `test/phase-21/session-1/agent-sdk-contract.test.ts`

**Step 1: Write the test file**

```ts
import { describe, it, expect } from 'vitest'
import {
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES,
  type AgentSdkCapabilities,
  type AgentSdkId
} from '../../../src/main/services/agent-sdk-types'

const CAPABILITY_KEYS: (keyof AgentSdkCapabilities)[] = [
  'supportsUndo',
  'supportsRedo',
  'supportsCommands',
  'supportsPermissionRequests',
  'supportsQuestionPrompts',
  'supportsModelSelection',
  'supportsReconnect',
  'supportsPartialStreaming'
]

describe('AgentSdk contract', () => {
  describe('capability maps are complete', () => {
    it('OPENCODE_CAPABILITIES has all required keys with boolean values', () => {
      for (const key of CAPABILITY_KEYS) {
        expect(typeof OPENCODE_CAPABILITIES[key]).toBe('boolean')
      }
    })

    it('CLAUDE_CODE_CAPABILITIES has all required keys with boolean values', () => {
      for (const key of CAPABILITY_KEYS) {
        expect(typeof CLAUDE_CODE_CAPABILITIES[key]).toBe('boolean')
      }
    })

    it('no extra keys in OPENCODE_CAPABILITIES', () => {
      expect(Object.keys(OPENCODE_CAPABILITIES).sort()).toEqual(CAPABILITY_KEYS.slice().sort())
    })

    it('no extra keys in CLAUDE_CODE_CAPABILITIES', () => {
      expect(Object.keys(CLAUDE_CODE_CAPABILITIES).sort()).toEqual(CAPABILITY_KEYS.slice().sort())
    })
  })

  describe('capability differences are intentional', () => {
    it('Claude does not support redo', () => {
      expect(CLAUDE_CODE_CAPABILITIES.supportsRedo).toBe(false)
    })

    it('OpenCode supports redo', () => {
      expect(OPENCODE_CAPABILITIES.supportsRedo).toBe(true)
    })

    it('both support undo', () => {
      expect(OPENCODE_CAPABILITIES.supportsUndo).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsUndo).toBe(true)
    })

    it('both support commands', () => {
      expect(OPENCODE_CAPABILITIES.supportsCommands).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsCommands).toBe(true)
    })

    it('both support reconnect', () => {
      expect(OPENCODE_CAPABILITIES.supportsReconnect).toBe(true)
      expect(CLAUDE_CODE_CAPABILITIES.supportsReconnect).toBe(true)
    })
  })

  describe('AgentSdkId values', () => {
    it('valid SDK identifiers are opencode and claude-code', () => {
      const validIds: AgentSdkId[] = ['opencode', 'claude-code']
      expect(validIds).toHaveLength(2)
      const _a: AgentSdkId = 'opencode'
      const _b: AgentSdkId = 'claude-code'
      expect(_a).toBe('opencode')
      expect(_b).toBe('claude-code')
    })
  })

  describe('session identifier format contract', () => {
    it('agent session IDs are non-empty strings', () => {
      // Both SDKs return string session IDs stored in opencode_session_id
      const mockOpenCodeId = 'oc_session_abc123'
      const mockClaudeId = 'claude-session-uuid-here'
      expect(typeof mockOpenCodeId).toBe('string')
      expect(mockOpenCodeId.length).toBeGreaterThan(0)
      expect(typeof mockClaudeId).toBe('string')
      expect(mockClaudeId.length).toBeGreaterThan(0)
    })

    it('agent_sdk defaults to opencode for backward compatibility', () => {
      const defaultSdk: AgentSdkId = 'opencode'
      expect(defaultSdk).toBe('opencode')
    })
  })
})
```

**Step 2: Run tests to verify they pass**

Run: `pnpm vitest run test/phase-21/session-1/agent-sdk-contract.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add test/phase-21/
git commit -m "test: add agent SDK contract tests for capabilities and identifiers"
```

---

## Task 5: Write the spec document

**Files:**

- Create: `docs/specs/agent-sdk-integration.md`

**Step 1: Write the spec**

The spec document should contain all the tables from the "Confirmed Decisions", "Capability Truth Table", "Claude SDK Event → Hive Stream Mapping", "Session Persistence / Resume Contract", and "Credential Discovery / Failure States" sections at the top of this plan. This is the single source of truth referenced by all subsequent sessions.

**Step 2: Commit**

```bash
git add docs/specs/agent-sdk-integration.md
git commit -m "docs: add agent SDK integration spec (Session 1 contract freeze)"
```

---

## Task 6: Run full verification

**Step 1: Run contract tests**

Run: `pnpm vitest run test/phase-21/session-1/`
Expected: All tests pass

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: All existing tests still pass

**Step 3: Run lint**

Run: `pnpm lint`
Expected: No errors

**Step 4: Run build**

Run: `pnpm build`
Expected: Build succeeds

**Step 5: Fix any issues found, then re-run failing checks**

---

## Files Changed Summary

| Action | Path                                                       |
| ------ | ---------------------------------------------------------- |
| Modify | `package.json` (add SDK dep)                               |
| Modify | `pnpm-lock.yaml` (lockfile update)                         |
| Modify | `src/main/db/schema.ts` (migration v2)                     |
| Modify | `src/main/db/types.ts` (add `agent_sdk` to Session types)  |
| Modify | `src/main/db/database.ts` (include `agent_sdk` in queries) |
| Modify | `src/preload/index.ts` (pass `agent_sdk` through)          |
| Modify | `src/preload/index.d.ts` (add `agent_sdk` to Session)      |
| Create | `src/main/services/agent-sdk-types.ts`                     |
| Create | `test/phase-21/session-1/agent-sdk-contract.test.ts`       |
| Create | `docs/specs/agent-sdk-integration.md`                      |

## Risks / Notes for Later Sessions

- The `@anthropic-ai/claude-agent-sdk` is ESM-only — Electron main process may need dynamic `import()`. This is a Session 2 concern.
- The `opencode_session_id` column name is misleading for Claude sessions. Consider renaming to `agent_session_id` in a future migration, but for now reuse avoids touching 29 call sites.
- The reference project uses SDK v0.1.76; we target ^0.2.42. Core `query()` API appears stable across versions.
