# Claude Code SDK Implementation Plan

This document defines the execution plan to replace the current Claude mock provider with a real Claude Code SDK implementation and bring it to production-ready behavior in Hive.

## Current State (Confirmed)

- Multi-provider plumbing exists (`AgentSdkImplementer`, manager, per-session `agent_sdk` routing).
- `ClaudeCodeImplementer` exists but is mock-only and contains 24 `TODO(claude-code-sdk)` markers in `src/main/services/claude-code-implementer.ts`.
- Several IPC and renderer paths still default to `opencode` behavior for non-session-scoped operations.
- UI still labels Claude as mock and contains hardcoded capability assumptions.

## Planning Rules

- Every session is scoped to one testable milestone.
- No session is complete until its tests pass and its Definition of Done is met.
- Do not remove fallback behavior for existing OpenCode sessions.
- Keep session-level SDK affinity immutable (`sessions.agent_sdk` remains authoritative).
- For external documentation research, use Chrome MCP browser tools (open docs in-browser and inspect content there) instead of crawler-style fetches.

## Confirmed Decisions

- Auth path for first production rollout: use existing local Claude credentials only.
- API key-based auth is explicitly deferred to a later phase.

---

## Session 1 - Integration Contract Freeze

### Goal

Lock all integration decisions that materially affect implementation shape.

### Tasks

- [x] Confirm exact Claude SDK package and supported runtime version (Node/Electron main process compatibility).
- [x] Lock auth strategy to local Claude credentials for v1 and document credential discovery/failure states.
- [x] Defer API key auth to a follow-up phase (non-blocking for v1).
- [x] Confirm capability truth table for Claude SDK at launch (`supportsUndo`, `supportsRedo`, `supportsCommands`, `supportsPermissionRequests`, `supportsQuestionPrompts`).
- [x] Confirm canonical Claude event taxonomy and payloads that must be mapped into Hive stream format.
- [x] Confirm session persistence/resume contract (what identifier we store in `opencode_session_id` and how reconnect works after app restart).

### Tests

- [x] Add a contract test file that validates the capability map and identifier format assumptions used by Claude adapter construction.

### Definition of Done

- Integration decisions are documented in `docs/specs/agent-sdk-integration.md`.
- No implementation ambiguity remains for auth, capabilities, or session resume.

---

## Session 2 - Claude Adapter Foundation (Main Process)

### Goal

Create the real Claude SDK client wrapper and replace mock-only internals with adapter primitives.

### Tasks

- [ ] Add Claude SDK dependency and typed wrapper module(s) in `src/main/services/`.
- [ ] Introduce explicit adapter layer in `src/main/services/claude-code-implementer.ts` for:
  - client init
  - session lifecycle calls
  - event subscription lifecycle
  - model lookup
- [ ] Replace mock transcript directory logic (`~/.hive/claude-code-mock/transcripts`) with SDK-backed reads/writes.
- [ ] Replace mock maps/timers with runtime state needed only for active subscriptions and cancellation.
- [ ] Keep structured logging parity with `opencode-service`.

### Tests

- [ ] Add unit tests for adapter initialization and failure handling with mocked SDK client.
- [ ] Add unit tests for cleanup behavior (client/session/subscription disposal).

### Definition of Done

- `ClaudeCodeImplementer` no longer depends on local mock transcript files.
- Adapter bootstraps in tests with deterministic mocked SDK behavior.

---

## Session 3 - Real Session Lifecycle (connect/reconnect/disconnect/cleanup)

### Goal

Make Claude session creation and resume fully real and restart-safe.

### Tasks

- [ ] Implement `connect` with real SDK session creation and stable mapping to Hive session ID.
- [ ] Implement `reconnect` using persisted agent session ID from DB + worktree path.
- [ ] Implement `disconnect` and `cleanup` to close SDK resources and detach subscriptions safely.
- [ ] Ensure reconnect behavior remains correct after app restart with persisted DB session rows.

### Tests

- [ ] Add lifecycle tests for connect -> disconnect -> reconnect using mocked SDK responses.
- [ ] Add integration-style main-process tests for persisted session ID resume path.

### Definition of Done

- Claude sessions reconnect successfully after simulated app restart.
- No leaked subscriptions/timers/handles after disconnect or global cleanup.

---

## Session 4 - Prompt Streaming + Abort + Event Normalization

### Goal

Stream real Claude responses into renderer using Hive's normalized event contract.

### Tasks

- [ ] Replace mock chunk streaming in `prompt` with SDK streaming API.
- [ ] Map Claude SDK events into normalized `opencode:stream` payload shape:
  - `type`
  - `sessionId` (Hive session ID)
  - `data`
  - optional `childSessionId`
  - optional `statusPayload` for `session.status`
- [ ] Implement `abort` via real SDK cancellation/abort APIs.
- [ ] Ensure child/subtask events are forwarded in format compatible with `SessionView` and `useOpenCodeGlobalListener`.

### Tests

- [ ] Replace mock streaming tests with SDK-event-mapping tests in `test/phase-21/session-3` (or new phase folder).
- [ ] Add abort tests verifying stream termination and final idle status semantics.

### Definition of Done

- Claude prompt path emits real normalized stream events consumed by existing renderer logic.
- Abort stops active stream and returns session to idle state consistently.

---

## Session 5 - Transcript + Session Metadata + Revert Data

### Goal

Back `getMessages` and `getSessionInfo` with real Claude SDK sources.

### Tasks

- [ ] Implement `getMessages` against Claude history/message APIs.
- [ ] Implement `getSessionInfo` with real revert metadata (`revertMessageID`, `revertDiff`) or explicit null behavior when unavailable.
- [ ] Ensure transcript ordering and message IDs are stable for renderer undo/revert boundary logic.

### Tests

- [ ] Add unit tests for transcript normalization and ordering guarantees.
- [ ] Add tests for revert metadata behavior across supported/unsupported Claude capabilities.

### Definition of Done

- Message reload paths in `SessionView` work unchanged with Claude transcript output.
- Revert boundary UI does not break due to provider-specific ID formats.

---

## Session 6 - Models + Selection Routing (Per SDK)

### Goal

Make model listing/selection/provider metadata SDK-aware instead of hardcoded OpenCode.

### Tasks

- [ ] Implement Claude `getAvailableModels`, `setSelectedModel`, and `getModelInfo`.
- [ ] Update `src/main/ipc/opencode-handlers.ts` so model operations can resolve target SDK by context (session/hive session/active setting), not unconditional `defaultSdk`.
- [ ] Update preload signatures if needed to pass session context for model operations.
- [ ] Update renderer call sites (`ModelSelector`, session initialization, `useSessionStore.setSessionModel`, `useSettingsStore.setSelectedModel`) to provide enough context for correct SDK routing.

### Tests

- [ ] Add IPC tests proving model operations route to Claude for Claude sessions and to OpenCode for OpenCode sessions.
- [ ] Add renderer/store tests for model selection persistence across mixed-SDK sessions.

### Definition of Done

- Model list/info/selection works for both SDKs without cross-provider leakage.
- Existing OpenCode model UX remains intact.

---

## Session 7 - Commands, Questions, and Permissions (Human-in-the-loop)

### Goal

Implement Claude command/question/permission methods and route IPC correctly.

### Tasks

- [ ] Implement Claude `listCommands` and `sendCommand` (or correctly report unsupported with capability gating).
- [ ] Implement Claude `questionReply`, `questionReject`, `permissionReply`, `permissionList`.
- [ ] Update IPC handlers currently hardcoded to `defaultSdk` for:
  - `opencode:question:reply`
  - `opencode:question:reject`
  - `opencode:permission:reply`
  - `opencode:permission:list`
  - `opencode:commands` (if command support differs by SDK)
- [ ] Ensure request-to-session correlation works when only request ID + worktree path is available.

### Tests

- [ ] Add IPC routing tests for question/permission/command endpoints under Claude sessions.
- [ ] Add renderer tests validating prompt cards are populated and cleared by Claude events.

### Definition of Done

- Human-in-the-loop workflows work end-to-end for Claude wherever capability says supported.
- Unsupported operations return clear, capability-consistent errors.

---

## Session 8 - Undo/Redo + Capability-Driven UX (No Hardcoded Mock Rules)

### Goal

Drive undo/redo and related UI gating from runtime capabilities, not SDK name checks.

### Tasks

- [ ] Implement Claude `undo` and `redo` according to confirmed capability table (or explicit unsupported errors).
- [ ] Replace hardcoded renderer capability logic:
  - `src/renderer/src/components/sessions/SessionView.tsx` (`getSessionSdkCapabilities`, mock-specific messages)
  - `src/renderer/src/hooks/useKeyboardShortcuts.ts` (hardcoded `activeSessionSdk === 'claude-code'` redo rule)
- [ ] Use `opencode:capabilities` as source of truth for active session controls and menu enablement.
- [ ] Update copy to remove "(Mock)" and mock-specific error strings.

### Tests

- [ ] Add/expand capability gating tests for both SDKs in main + renderer.
- [ ] Add tests for menu state updates based on runtime capability responses.

### Definition of Done

- Undo/redo affordances match actual SDK capability, not provider identity assumptions.
- Menu, slash commands, and inline UI all behave consistently.

---

## Session 9 - Settings/UX Finalization + Backward Compatibility

### Goal

Finalize user-facing Claude provider UX and preserve existing session behavior.

### Tasks

- [ ] Update `SettingsGeneral` copy from "Claude Code (Mock)" to production label.
- [ ] Keep existing session pinning semantics: old sessions remain on stored `agent_sdk`.
- [ ] Verify migrations are unnecessary (same `agent_sdk` value) or add migration if naming changes.
- [ ] Ensure fallback to OpenCode remains only for unresolved historical/invalid rows.

### Tests

- [ ] Update settings tests to expect production label/copy and unchanged pinning rules.
- [ ] Add regression test for mixed old/new sessions after settings change.

### Definition of Done

- UX reflects real Claude integration (no mock language).
- Backward compatibility for existing sessions is preserved.

---

## Session 10 - Remove Mock TODOs, Expand Verification, Ship Gate

### Goal

Finalize implementation quality gates and ensure no mock placeholders remain in active paths.

### Tasks

- [ ] Remove or resolve all `TODO(claude-code-sdk)` markers in `src/main/services/claude-code-implementer.ts`.
- [ ] Update `test/phase-21/session-8/integration-verification.test.ts` (currently expects TODO markers) to assert production readiness instead.
- [ ] Update docs:
  - `docs/specs/agent-sdk-integration.md`
  - this implementation doc with completion notes as sessions finish
- [ ] Add a concise troubleshooting section for auth/session reconnect/model routing.

### Tests

- [ ] Run targeted suites for all touched phase/session test files.
- [ ] Run full verification commands:
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`

### Definition of Done

- No remaining mock TODO markers in Claude production path.
- All required tests pass locally and build is green.
- Documentation matches actual behavior.

---

## Cross-Session Test Matrix (Must Exist by Completion)

- [ ] Claude adapter unit tests (client init, lifecycle, cleanup, error handling).
- [ ] Claude event normalization tests (status, message parts, message updates, child session mapping).
- [ ] IPC SDK routing tests for all operations, not just connect/prompt.
- [ ] Renderer capability-driven gating tests (undo/redo/menu/slash).
- [ ] Settings/session pinning regression tests across mixed SDK sessions.
- [ ] Integration verification test that asserts production Claude readiness (replaces mock TODO check).

## Global Definition of Done

- Claude provider is fully functional through the `AgentSdkImplementer` contract.
- Session create/connect/reconnect/prompt/abort/disconnect flows work for Claude and OpenCode.
- Event stream normalization is provider-agnostic and renderer-stable.
- Capability-gated features are driven by runtime capabilities.
- Model, command, question, permission, transcript, undo/redo behavior aligns with actual SDK support.
- No mock-only labels or mock TODO placeholders remain in shipping paths.
- `pnpm lint`, `pnpm test`, and `pnpm build` all pass.
