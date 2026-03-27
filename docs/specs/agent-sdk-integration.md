# Agent SDK Integration Specification

> Single source of truth for all integration decisions between Hive and AI agent SDKs.

## Supported SDKs

| SDK         | Package                          | Status     |
| ----------- | -------------------------------- | ---------- |
| OpenCode    | `@opencode-ai/sdk`               | Production |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | Production |
| Codex       | `@openai/codex` (app-server)     | Production |

## Architecture

Hive uses a **strategy pattern** for AI agent integration. The `AgentSdkImplementer` interface
(defined in `src/main/services/agent-sdk-types.ts`) is the contract that OpenCode, Claude Code,
and Codex adapters implement. A manager (`AgentSdkManager`) routes operations to the correct
implementer based on each session's `agent_sdk` column.

### Session Routing

- Each session row has an immutable `agent_sdk` column (`'opencode' | 'claude-code' | 'codex' | 'terminal'`)
- Default value is `'opencode'` for backward compatibility
- The column is set at session creation and never changes
- All IPC and GraphQL operations resolve the target SDK from the session's `agent_sdk` value

### GraphQL Routing

GraphQL resolvers use two dispatch mechanisms:

1. **`withSdkDispatch(ctx, agentSessionId, opencodeFn, sdkFn)`** -- Looks up the SDK from the
   agent session ID in the DB, then routes to the correct implementer.
2. **`withSdkDispatchByHiveSession(ctx, hiveSessionId, opencodeFn, sdkFn)`** -- Used for `connect`
   where no agent session ID exists yet; looks up `session.agent_sdk` from the DB.

For operations that take an `agentSdk` parameter from the GraphQL enum (e.g., `opencodeModels`,
`opencodeSetModel`), the helper `mapGraphQLSdkToInternal()` converts `'claude_code'` (GraphQL
underscore format) to `'claude-code'` (internal hyphen format). `'codex'` passes through unchanged.

For human-in-the-loop operations (question reply/reject, permission reply), the resolver iterates
over all non-OpenCode implementers checking `hasPendingQuestion()` or `hasPendingApproval()` to
find the correct target.

### GraphQL Enum to Internal ID Mapping

| GraphQL Enum | Internal `AgentSdkId` | DB `agent_sdk` |
| ------------ | --------------------- | --------------- |
| `opencode`   | `opencode`            | `opencode`      |
| `claude_code`| `claude-code`         | `claude-code`   |
| `codex`      | `codex`               | `codex`         |
| `terminal`   | `terminal`            | `terminal`      |

## Authentication

### OpenCode

OpenCode discovers credentials from its own configuration. No special setup required by Hive.

### Claude Code

Claude Code SDK discovers credentials from `~/.claude/` (OAuth tokens from `claude` CLI login).

**Credential discovery flow:**

1. SDK attempts to read local credentials on first `query()` call
2. If credentials found: proceeds normally
3. If not found: throws authentication error

**Failure handling:**

- Surface to user: "Claude Code not authenticated. Run `claude login` in your terminal."
- Do not retry automatically -- user must authenticate externally

### Codex

Codex discovers credentials via the `OPENAI_API_KEY` environment variable or local OpenAI
configuration files.

**Credential discovery flow:**

1. `CodexAppServerManager` spawns the Codex CLI (`codex`) as a child process
2. The child process discovers API keys from the environment
3. If no key found: the session start will fail with an authentication error

**Failure handling:**

- Surface to user: "Codex not authenticated. Set the OPENAI_API_KEY environment variable."
- The Codex app-server process handles auth internally; Hive does not manage tokens directly

### Deferred: API Key Auth (Claude)

API key-based authentication (`ANTHROPIC_API_KEY` env var) for Claude is explicitly deferred to a
follow-up phase. This is non-blocking for v1.

## Capability Truth Table

| Capability                   | OpenCode | Claude Code | Codex       | Notes                                                        |
| ---------------------------- | -------- | ----------- | ----------- | ------------------------------------------------------------ |
| `supportsUndo`               | true     | true        | true        | Codex: via `rollbackThread()` on the app-server              |
| `supportsRedo`               | true     | **false**   | **false**   | Neither Claude nor Codex support redo                        |
| `supportsCommands`           | true     | true        | **false**   | Codex has no slash-command protocol                          |
| `supportsPermissionRequests` | true     | true        | true        | Codex: via `requestApproval` events from the app-server      |
| `supportsQuestionPrompts`    | true     | true        | true        | Codex: via `requestUserInput` events from the app-server     |
| `supportsModelSelection`     | true     | true        | true        | Codex: model passed to `startSession()` and `sendTurn()`     |
| `supportsReconnect`          | true     | true        | true        | Codex: via `resumeThreadId` on `startSession()`              |
| `supportsPartialStreaming`   | true     | true        | true        | Codex: via `content.delta` events from the app-server        |

These capabilities are defined as constants in `src/main/services/agent-sdk-types.ts`:

- `OPENCODE_CAPABILITIES`
- `CLAUDE_CODE_CAPABILITIES`
- `CODEX_CAPABILITIES`
- `TERMINAL_CAPABILITIES`

## Claude SDK Event Taxonomy

The Claude SDK emits `SDKMessage` (a union of 11 types). These must be mapped into Hive's
`OpenCodeStreamEvent` format for the renderer.

| SDK Message Type                       | Hive `type`            | Hive `statusPayload` | Notes                                           |
| -------------------------------------- | ---------------------- | -------------------- | ----------------------------------------------- |
| `system` (subtype: `init`)             | `session.init`         | `{ type: 'idle' }`   | Extract `session_id`, tools, model              |
| `user`                                 | `message.created`      | --                   | Forward message, capture `uuid` for checkpoints |
| `assistant`                            | `message.updated`      | --                   | Map `message.content` blocks to parts           |
| `stream_event`                         | `message.part.updated` | --                   | Only when `includePartialMessages: true`        |
| `result` (subtype: `success`)          | `session.completed`    | `{ type: 'idle' }`   | Extract cost, usage stats                       |
| `result` (subtype: `error_*`)          | `session.error`        | `{ type: 'idle' }`   | Extract error messages                          |
| `system` (subtype: `status`)           | `session.status`       | `{ type: 'busy' }`   | Compacting status                               |
| `tool_progress`                        | `message.part.updated` | --                   | Progress events for long-running tools          |
| `auth_status`                          | `session.auth`         | --                   | Auth flow events                                |
| `system` (subtype: `compact_boundary`) | (internal)             | --                   | Not forwarded to renderer                       |
| `system` (subtype: `hook_response`)    | (internal)             | --                   | Not forwarded to renderer                       |

## Codex SDK Event Taxonomy

Codex events are emitted by `CodexAppServerManager` via its `'event'` EventEmitter. The
`CodexManagerEvent` type wraps all events with a `kind`, `method`, and `threadId` for routing.

| Codex Event Method                           | Hive `type`            | Notes                                           |
| -------------------------------------------- | ---------------------- | ----------------------------------------------- |
| `session/started`                            | `session.materialized` | Extract `threadId` as session identifier         |
| `content.delta`                              | `message.part.updated` | Streaming text/reasoning deltas                  |
| `turn/completed`                             | `session.completed`    | Turn finished; check `status` for success/fail   |
| `item/commandExecution/requestApproval`      | `request.opened`       | Tool execution approval request                  |
| `item/fileChange/requestApproval`            | `request.opened`       | File write approval request                      |
| `item/fileRead/requestApproval`              | `request.opened`       | File read approval request                       |
| `item/tool/requestUserInput`                 | `question.asked`       | Question prompt from the model                   |
| `session/closed`                             | (cleanup)              | Clean up pending HITL entries                     |
| `session/exited`                             | (cleanup)              | Clean up pending HITL entries                     |
| `session.state.changed` (state: `error`)     | `session.error`        | Codex process error                               |

Event mapping is handled by `mapCodexEventToStreamEvents()` in
`src/main/services/codex-event-mapper.ts`.

## Session Persistence and Resume

### Claude Code

| Aspect               | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| Stored in            | `sessions.opencode_session_id` (reused column, shared across all SDKs)    |
| Format               | String assigned by Claude SDK (returned in `SDKSystemMessage.session_id`) |
| Returned via         | `SDKSystemMessage` with `subtype: 'init'`                                 |
| Resume mechanism     | `query({ prompt, options: { resume: storedSessionId } })`                 |
| Resume after restart | Works -- Claude SDK persists sessions to `~/.claude/`                     |
| Reconnect validation | Attempt `resume`; if SDK throws, session is stale -- create new           |

### Codex

| Aspect               | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| Stored in            | `sessions.opencode_session_id` (reused column, shared across all SDKs)    |
| Format               | Thread ID string returned by `CodexAppServerManager.startSession()`       |
| Resume mechanism     | `startSession({ cwd, model, resumeThreadId })` on the app-server         |
| Resume after restart | Depends on Codex app-server thread persistence (may require warm server)  |
| Reconnect validation | Attempt resume; if session not found locally, try `resumeThreadId`        |

### Session ID Column

The `opencode_session_id` column name is shared between all SDKs. While the name references
OpenCode, it stores the agent-side session identifier for whichever SDK the session uses. The
column name is kept for backward compatibility (avoids migrating 29+ call sites). A future
rename to `agent_session_id` may be considered.

## Database Schema

### `sessions` table

The `agent_sdk` column was added in migration v2:

```sql
ALTER TABLE sessions ADD COLUMN agent_sdk TEXT NOT NULL DEFAULT 'opencode';
```

Valid values: `'opencode'` | `'claude-code'` | `'codex'` | `'terminal'`

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

## Method Implementation Notes

### Claude Code

| Method               | Behavior                                                                            |
| -------------------- | ----------------------------------------------------------------------------------- |
| `connect`            | Creates deferred session state (`pending::` ID, materialized on first prompt)       |
| `reconnect`          | Restores session state from DB; session resumes on next prompt via `options.resume` |
| `disconnect`         | Closes active query, aborts controller, removes session from map                    |
| `prompt`             | Calls `sdk.query()` with streaming; maps SDK events to Hive format                  |
| `abort`              | Aborts controller + calls `query.interrupt()`                                       |
| `getMessages`        | Returns in-memory messages or falls back to JSONL transcript reader                 |
| `getAvailableModels` | Returns static catalog (opus, sonnet, haiku)                                        |
| `getModelInfo`       | Looks up model in static catalog                                                    |
| `setSelectedModel`   | Stores model ID for next prompt                                                     |
| `getSessionInfo`     | Returns current revert boundary state from session                                  |
| `questionReply`      | Resolves pending `canUseTool` Promise for `AskUserQuestion`                         |
| `questionReject`     | Resolves pending `canUseTool` Promise with rejection                                |
| `permissionReply`    | No-op (permissions handled inline via `canUseTool` auto-allow)                      |
| `permissionList`     | Returns `[]` (no separate permission queue)                                         |
| `undo`               | Uses `Query.rewindFiles()` + fork/resumeSessionAt for next prompt                   |
| `redo`               | Throws unsupported error (`supportsRedo: false`)                                    |
| `listCommands`       | Returns `[]` (SDK commands require active query transport)                          |
| `sendCommand`        | Translates to `/<command> <args>` prompt and delegates to `prompt()`                |
| `renameSession`      | Updates session name in Hive's local DB (SDK has no rename API)                     |

### Codex

| Method               | Behavior                                                                            |
| -------------------- | ----------------------------------------------------------------------------------- |
| `connect`            | Spawns app-server session via `CodexAppServerManager.startSession()`                |
| `reconnect`          | Resumes existing in-memory session or starts new session with `resumeThreadId`      |
| `disconnect`         | Stops the manager session and clears local state                                    |
| `prompt`             | Sends turn via `manager.sendTurn()`, streams events, waits for `turn/completed`     |
| `abort`              | Interrupts current turn via `manager.interruptTurn()`                               |
| `getMessages`        | Returns in-memory messages or falls back to `manager.readThread()` snapshot         |
| `getAvailableModels` | Returns static catalog (o3-mini, o4-mini, etc.)                                     |
| `getModelInfo`       | Looks up model in static catalog via `getCodexModelInfo()`                           |
| `setSelectedModel`   | Stores resolved model slug for next session/turn                                    |
| `getSessionInfo`     | Returns current revert boundary state from in-memory session                        |
| `questionReply`      | Resolves pending user input request via `manager.respondToUserInput()`              |
| `questionReject`     | Rejects pending user input request via `manager.rejectUserInput()`                  |
| `permissionReply`    | Resolves pending approval via `manager.respondToApproval()`                         |
| `permissionList`     | Aggregates pending approvals across all sessions via `manager.getPendingApprovals()`|
| `undo`               | Rolls back 1 turn via `manager.rollbackThread()`, pops in-memory messages           |
| `redo`               | Throws unsupported error (`supportsRedo: false`)                                    |
| `listCommands`       | Throws unsupported error (`supportsCommands: false`)                                |
| `sendCommand`        | Throws unsupported error (`supportsCommands: false`)                                |
| `renameSession`      | Updates session name in Hive's local DB (Codex has no rename API)                   |

## Known Limitations

### Codex

- **No redo:** Codex thread rollback is one-directional. Once a turn is rolled back, there is no
  mechanism to restore it.
- **No slash commands:** Codex does not support a command protocol. The `supportsCommands`
  capability is `false`, and `listCommands` / `sendCommand` throw unsupported errors.
- **No fork:** Codex does not support session forking. The `opencodeFork` GraphQL mutation only
  calls OpenCode.
- **No plan approval:** Codex does not emit plan events. The `opencodePlanApprove` and
  `opencodePlanReject` mutations only check Claude Code.
- **Session persistence:** Codex sessions are managed by the app-server process. If the app-server
  exits, in-memory sessions are lost. Thread resume via `resumeThreadId` may succeed if the server
  retains thread state.
- **Model catalog is static:** Available models are defined in `src/main/services/codex-models.ts`
  and must be updated manually when new models become available.

### Claude Code

- **No redo:** Claude rewind is one-directional.
- **ESM-only:** The `@anthropic-ai/claude-agent-sdk` package is ESM-only and requires dynamic
  `import()` in Electron's main process.

## Troubleshooting

### Authentication Failures

**Symptom:** Claude sessions fail on first prompt with authentication error.

**Resolution:**

1. Run `claude login` in your terminal to authenticate the Claude CLI
2. Verify credentials exist: `ls ~/.claude/`
3. Restart Hive after authenticating

**Symptom:** Codex sessions fail to start or prompt returns auth error.

**Resolution:**

1. Set `OPENAI_API_KEY` in your environment
2. Verify: `echo $OPENAI_API_KEY`
3. Restart Hive after setting the key

### Session Reconnect Failures

**Symptom:** Previously active Claude session shows as disconnected after app restart.

**Resolution:**

- Session reconnect is deferred until the next prompt. The session state is restored from the
  DB `opencode_session_id` column and the SDK resumes via `options.resume` on the next `query()` call.
- If the SDK session has expired or the transcript file was deleted, the session will fail to
  resume. Create a new session in that case.

**Symptom:** Previously active Codex session shows as disconnected after app restart.

**Resolution:**

- Codex reconnect attempts to resume via `resumeThreadId`. If the app-server no longer has the
  thread, the reconnect fails gracefully and a new session should be created.

### Model Routing

**Symptom:** Wrong model used for Claude session, or model selection doesn't apply.

**Resolution:**

- Claude model selection is per-implementer (stored in `ClaudeCodeImplementer.selectedModel`).
- The model is passed to `sdk.query()` via `options.model` on each prompt.
- Supported model IDs: `opus`, `sonnet`, `haiku`.
- Model override can also be passed per-prompt via the `modelOverride` parameter.

**Symptom:** Wrong model used for Codex session.

**Resolution:**

- Codex model selection is per-implementer (stored in `CodexImplementer.selectedModel`).
- The model slug is resolved via `resolveCodexModelSlug()` before being passed to the app-server.
- Model override can be passed per-prompt via the `modelOverride` parameter.

### Undo Not Working

**Symptom:** Undo throws "Nothing to undo" even after multiple prompts.

**Resolution (Claude):**

- Undo requires file checkpoints to be captured. Checkpoints are recorded from SDK `user` messages
  that have a `uuid` and are not tool-result-only or subagent messages.
- Ensure `enableFileCheckpointing: true` and `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`
  environment variable are set (both are set by default in the implementer).
- After undo, the next prompt will fork the conversation via `forkSession: true`.

**Resolution (Codex):**

- Undo requires at least one completed turn in the in-memory message history.
- Codex undo calls `manager.rollbackThread()` and pops the last user+assistant exchange from
  in-memory messages.

## Risks and Mitigations

| Risk                                                             | Mitigation                                         |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk` is ESM-only                     | Use dynamic `import()` in Electron main process    |
| SDK version drift (reference uses v0.1.76, we target ^0.2.42)    | Core `query()` API is stable; pin if issues arise  |
| `opencode_session_id` column name is misleading                  | Document clearly; defer rename to future migration |
| zod peer dependency mismatch (SDK wants ^4.0.0, project has 3.x) | Works at runtime; upgrade zod when ready           |
| Codex app-server may crash or exit unexpectedly                   | Session cleanup on disconnect; graceful reconnect  |
| Codex model catalog may drift from actual availability            | Static catalog; update `codex-models.ts` as needed |
