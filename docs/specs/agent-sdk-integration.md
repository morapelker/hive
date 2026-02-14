# Agent SDK Integration Specification

> Single source of truth for all integration decisions between Hive and AI agent SDKs.

## Supported SDKs

| SDK         | Package                          | Status      |
| ----------- | -------------------------------- | ----------- |
| OpenCode    | `@opencode-ai/sdk`               | Production  |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | In progress |

## Architecture

Hive uses a **strategy pattern** for AI agent integration. The `AgentSdkImplementer` interface
(defined in `src/main/services/agent-sdk-types.ts`) is the contract that both OpenCode and Claude
Code adapters implement. A manager routes operations to the correct implementer based on each
session's `agent_sdk` column.

### Session Routing

- Each session row has an immutable `agent_sdk` column (`'opencode' | 'claude-code'`)
- Default value is `'opencode'` for backward compatibility
- The column is set at session creation and never changes
- All IPC operations resolve the target SDK from the session's `agent_sdk` value

## Authentication

### v1: Local Credentials Only

Claude Code SDK discovers credentials from `~/.claude/` (OAuth tokens from `claude` CLI login).

**Credential discovery flow:**

1. SDK attempts to read local credentials on first `query()` call
2. If credentials found: proceeds normally
3. If not found: throws authentication error

**Failure handling:**

- Surface to user: "Claude Code not authenticated. Run `claude login` in your terminal."
- Do not retry automatically — user must authenticate externally

### Deferred: API Key Auth

API key-based authentication (`ANTHROPIC_API_KEY` env var) is explicitly deferred to a follow-up
phase. This is non-blocking for v1.

## Capability Truth Table

| Capability                   | OpenCode | Claude Code | Notes                                                        |
| ---------------------------- | -------- | ----------- | ------------------------------------------------------------ |
| `supportsUndo`               | true     | true        | Claude: via `Query.rewindFiles()` + `resumeSessionAt`        |
| `supportsRedo`               | true     | **false**   | Claude rewind is one-directional; no unrevert equivalent     |
| `supportsCommands`           | true     | true        | Claude: via `Query.supportedCommands()`                      |
| `supportsPermissionRequests` | true     | true        | Claude: via `canUseTool` callback                            |
| `supportsQuestionPrompts`    | true     | true        | Claude: `AskUserQuestion` tool via `canUseTool`              |
| `supportsModelSelection`     | true     | true        | Claude: via `Query.setModel()` and `Query.supportedModels()` |
| `supportsReconnect`          | true     | true        | Claude: via `options.resume`                                 |
| `supportsPartialStreaming`   | true     | true        | Claude: via `includePartialMessages: true`                   |

These capabilities are defined as constants in `src/main/services/agent-sdk-types.ts`:

- `OPENCODE_CAPABILITIES`
- `CLAUDE_CODE_CAPABILITIES`

## Claude SDK Event Taxonomy

The Claude SDK emits `SDKMessage` (a union of 11 types). These must be mapped into Hive's
`OpenCodeStreamEvent` format for the renderer.

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

## Session Persistence and Resume

| Aspect               | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| Stored in            | `sessions.opencode_session_id` (reused column, shared with OpenCode)      |
| Format               | String assigned by Claude SDK (returned in `SDKSystemMessage.session_id`) |
| Returned via         | `SDKSystemMessage` with `subtype: 'init'`                                 |
| Resume mechanism     | `query({ prompt, options: { resume: storedSessionId } })`                 |
| Resume after restart | Works — Claude SDK persists sessions to `~/.claude/`                      |
| Reconnect validation | Attempt `resume`; if SDK throws, session is stale — create new            |

### Session ID Column

The `opencode_session_id` column name is shared between both SDKs. While the name references
OpenCode, it stores the agent-side session identifier for whichever SDK the session uses. The
column name is kept for backward compatibility (avoids migrating 29+ call sites). A future
rename to `agent_session_id` may be considered.

## Database Schema

### `sessions` table

The `agent_sdk` column was added in migration v2:

```sql
ALTER TABLE sessions ADD COLUMN agent_sdk TEXT NOT NULL DEFAULT 'opencode';
```

Valid values: `'opencode'` | `'claude-code'`

## Interface Contract

The `AgentSdkImplementer` interface is defined in `src/main/services/agent-sdk-types.ts` and
requires implementers to provide:

- **Lifecycle:** connect, reconnect, disconnect, cleanup
- **Messaging:** prompt, abort, getMessages
- **Models:** getAvailableModels, getModelInfo, setSelectedModel
- **Session info:** getSessionInfo (revert state)
- **Human-in-the-loop:** questionReply, questionReject, permissionReply, permissionList
- **Undo/Redo:** undo, redo
- **Commands:** listCommands, sendCommand
- **Session management:** renameSession
- **Window binding:** setMainWindow (for event forwarding)

## Risks and Mitigations

| Risk                                                             | Mitigation                                         |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk` is ESM-only                     | Use dynamic `import()` in Electron main process    |
| SDK version drift (reference uses v0.1.76, we target ^0.2.42)    | Core `query()` API is stable; pin if issues arise  |
| `opencode_session_id` column name is misleading                  | Document clearly; defer rename to future migration |
| zod peer dependency mismatch (SDK wants ^4.0.0, project has 3.x) | Works at runtime; upgrade zod when ready           |
