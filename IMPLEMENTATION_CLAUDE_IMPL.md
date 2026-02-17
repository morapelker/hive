# Claude Code SDK Implementation Plan

This document defines the execution plan to replace the current Claude mock provider with a real Claude Code SDK implementation and bring it to production-ready behavior in Hive.

## Current State (Confirmed)

- Multi-provider plumbing exists (`AgentSdkImplementer`, manager, per-session `agent_sdk` routing).
- `ClaudeCodeImplementer` exists but is mock-only and contains 24 `TODO(claude-code-sdk)` markers in `src/main/services/claude-code-implementer.ts`.
- Several IPC and renderer paths still default to `opencode` behavior for non-session-scoped operations.
- UI still labels Claude as mock and contains hardcoded capability assumptions.

## Reference Project

An example project demonstrating Claude SDK usage is available at:
`/Users/mor/Documents/dev/mochi-2/mochi-claude-sdk`

Use this as a reference when implementing SDK integration (client init, streaming, tools, sessions, etc.).

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
  - `test/phase-21/session-1/agent-sdk-contract.test.ts` — 12 tests, all passing

### Definition of Done

- [x] Integration decisions are documented in `docs/specs/agent-sdk-integration.md`.
- [x] No implementation ambiguity remains for auth, capabilities, or session resume.
- [x] `AgentSdkImplementer` interface defined in `src/main/services/agent-sdk-types.ts`.
- [x] `agent_sdk` column added via migration v2 in `src/main/db/schema.ts`.
- [x] `@anthropic-ai/claude-agent-sdk@^0.2.42` installed.
- [x] `pnpm lint`, `pnpm test` (contract tests), and `pnpm build` all pass.

---

## Session 2 - Claude Adapter Foundation (Main Process)

### Goal

Create the real Claude SDK client wrapper and replace mock-only internals with adapter primitives.

### Tasks

- [x] Add Claude SDK dependency and typed wrapper module(s) in `src/main/services/`.
- [x] Introduce explicit adapter layer in `src/main/services/claude-code-implementer.ts` for:
  - client init
  - session lifecycle calls
  - event subscription lifecycle
  - model lookup
- [x] Replace mock transcript directory logic (`~/.hive/claude-code-mock/transcripts`) with SDK-backed reads/writes.
- [x] Replace mock maps/timers with runtime state needed only for active subscriptions and cancellation.
- [x] Keep structured logging parity with `opencode-service`.

### Tests

- [x] Add unit tests for adapter initialization and failure handling with mocked SDK client.
- [x] Add unit tests for cleanup behavior (client/session/subscription disposal).

### Definition of Done

- `ClaudeCodeImplementer` no longer depends on local mock transcript files.
- Adapter bootstraps in tests with deterministic mocked SDK behavior.

---

## Session 3 - Real Session Lifecycle (connect/reconnect/disconnect/cleanup)

### Goal

Make Claude session creation and resume fully real and restart-safe.

### Tasks

- [x] Implement `connect` with real SDK session creation and stable mapping to Hive session ID.
- [x] Implement `reconnect` using persisted agent session ID from DB + worktree path.
- [x] Implement `disconnect` and `cleanup` to close SDK resources and detach subscriptions safely.
- [x] Ensure reconnect behavior remains correct after app restart with persisted DB session rows.

### Tests

- [x] Add lifecycle tests for connect -> disconnect -> reconnect using mocked SDK responses.
  - `test/phase-21/session-3/claude-lifecycle.test.ts` — 32 tests, all passing
- [x] Add integration-style main-process tests for persisted session ID resume path.

### Definition of Done

- [x] Claude sessions reconnect successfully after simulated app restart.
- [x] No leaked subscriptions/timers/handles after disconnect or global cleanup.

---

## Session 4 - Prompt Streaming + Abort + Event Normalization

### Goal

Stream real Claude responses into renderer using Hive's normalized event contract.

### Tasks

- [x] Replace mock chunk streaming in `prompt` with SDK streaming API.
- [x] Map Claude SDK events into normalized `opencode:stream` payload shape:
  - `type`
  - `sessionId` (Hive session ID)
  - `data`
  - optional `childSessionId`
  - optional `statusPayload` for `session.status`
- [x] Implement `abort` via real SDK cancellation/abort APIs.
- [x] Ensure child/subtask events are forwarded in format compatible with `SessionView` and `useOpenCodeGlobalListener`.

### Tests

- [x] Replace mock streaming tests with SDK-event-mapping tests in `test/phase-21/session-4/`.
  - `test/phase-21/session-4/claude-prompt-streaming.test.ts` — 13 tests
  - `test/phase-21/session-4/claude-abort.test.ts` — 6 tests
  - `test/phase-21/session-4/db-agent-session-lookup.test.ts` — 3 tests
  - `test/phase-21/session-4/ipc-sdk-routing.test.ts` — 5 tests
  - `test/phase-21/session-4/integration-smoke.test.ts` — 5 tests
- [x] Add abort tests verifying stream termination and final idle status semantics.

### Definition of Done

- [x] Claude prompt path emits real normalized stream events consumed by existing renderer logic.
- [x] Abort stops active stream and returns session to idle state consistently.

---

## Session 5 - Transcript + Session Metadata + Revert Data

### Goal

Back `getMessages` and `getSessionInfo` with real Claude SDK sources.

### Tasks

- [x] Implement `getMessages` against Claude history/message APIs.
  - Primary: JSONL transcript reader (`claude-transcript-reader.ts`) reads `~/.claude/projects/` on-disk transcripts
  - Secondary: In-memory accumulation during `prompt()` streaming for fast access
  - Messages translated to OpenCode-compatible format for existing renderer mapper
- [x] Implement `getSessionInfo` with real revert metadata (`revertMessageID`, `revertDiff`) or explicit null behavior when unavailable.
  - Returns `{ revertMessageID: null, revertDiff: null }` — revert tracking deferred to Session 8
- [x] Ensure transcript ordering and message IDs are stable for renderer undo/revert boundary logic.
  - UUIDs from Claude transcripts used as message IDs; timestamp-based ordering preserved
- [x] Add SDK-aware routing to `opencode:messages` and `opencode:sessionInfo` IPC handlers.

### Tests

- [x] Add unit tests for transcript normalization and ordering guarantees.
  - `test/phase-21/session-5/claude-transcript-reader.test.ts` — 24 tests
  - `test/phase-21/session-5/claude-getmessages.test.ts` — 5 tests
- [x] Add tests for revert metadata behavior across supported/unsupported Claude capabilities.
  - `test/phase-21/session-5/claude-getsessioninfo.test.ts` — 3 tests
  - `test/phase-21/session-5/ipc-messages-routing.test.ts` — 5 tests

### Definition of Done

- [x] Message reload paths in `SessionView` work unchanged with Claude transcript output.
- [x] Revert boundary UI does not break due to provider-specific ID formats.

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

- [x] Update `SettingsGeneral` copy from "Claude Code (Mock)" to production label.
  - Label was already "Claude Code" (no mock suffix found in codebase)
  - Section header improved from "Agent SDK" to "AI Provider" for user clarity
  - Description updated to explain existing sessions keep their original provider
- [x] Keep existing session pinning semantics: old sessions remain on stored `agent_sdk`.
  - Verified: `agent_sdk` is set at session creation and never mutated afterward
  - `useSessionStore.createSession()` reads `defaultAgentSdk` from settings and passes it once
- [x] Verify migrations are unnecessary (same `agent_sdk` value) or add migration if naming changes.
  - Confirmed: migration v2 uses `'opencode'` default, `'claude-code'` is the production value -- no rename needed
- [x] Ensure fallback to OpenCode remains only for unresolved historical/invalid rows.
  - DB default is `'opencode'`, `getAgentSdkForSession()` returns null for missing rows, IPC handlers fall through to OpenCode
- [x] Fix `useSettingsStore` partialize: added `defaultAgentSdk` and `showModelIcons` to localStorage cache for fast hydration

### Tests

- [x] Update settings tests to expect production label/copy and unchanged pinning rules.
  - `test/phase-21/session-9/settings-production-label.test.ts` -- 7 tests
- [x] Add regression test for mixed old/new sessions after settings change.
  - `test/phase-21/session-9/session-pinning-regression.test.ts` -- 7 tests
  - `test/phase-21/session-9/backward-compatibility.test.ts` -- 15 tests

### Definition of Done

- [x] UX reflects real Claude integration (no mock language).
- [x] Backward compatibility for existing sessions is preserved.

---

## Session 10 - Remove Mock TODOs, Expand Verification, Ship Gate

### Goal

Finalize implementation quality gates and ensure no mock placeholders remain in active paths.

### Tasks

- [x] Remove or resolve all `TODO(claude-code-sdk)` markers in `src/main/services/claude-code-implementer.ts`.
  - All 24 original markers were already resolved in Sessions 2-5
  - 5 remaining `not yet implemented` stubs (permissionReply, permissionList, listCommands, sendCommand, renameSession) resolved with proper implementations
- [x] Update `test/phase-21/session-8/integration-verification.test.ts` (currently expects TODO markers) to assert production readiness instead.
  - Expanded from 3 to 13 tests covering all resolved stubs, source scanning for leftover markers, and capability completeness
- [x] Update docs:
  - `docs/specs/agent-sdk-integration.md` — updated status to Production, added method implementation notes table and troubleshooting section
  - this implementation doc with completion notes as sessions finish
- [x] Add a concise troubleshooting section for auth/session reconnect/model routing.
  - Added to `docs/specs/agent-sdk-integration.md`: authentication, session reconnect, model routing, undo troubleshooting

### Tests

- [x] Run targeted suites for all touched phase/session test files.
- [x] Run full verification commands:
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`

### Definition of Done

- [x] No remaining mock TODO markers in Claude production path.
- [x] All required tests pass locally and build is green.
- [x] Documentation matches actual behavior.

---

## Cross-Session Test Matrix (Must Exist by Completion)

- [x] Claude adapter unit tests (client init, lifecycle, cleanup, error handling).
  - `test/phase-21/session-2/claude-code-implementer.test.ts`, `claude-sdk-loader.test.ts`, `agent-sdk-manager.test.ts`
  - `test/phase-21/session-3/claude-lifecycle.test.ts`
- [x] Claude event normalization tests (status, message parts, message updates, child session mapping).
  - `test/phase-21/session-4/claude-prompt-streaming.test.ts`, `claude-abort.test.ts`, `integration-smoke.test.ts`
- [x] IPC SDK routing tests for all operations, not just connect/prompt.
  - `test/phase-21/session-4/ipc-sdk-routing.test.ts`, `db-agent-session-lookup.test.ts`
  - `test/phase-21/session-5/ipc-messages-routing.test.ts`
  - `test/phase-21/session-6/ipc-model-routing.test.ts`
  - `test/phase-21/session-8/ipc-undo-redo-routing.test.ts`, `capabilities-ipc.test.ts`
- [x] Renderer capability-driven gating tests (undo/redo/menu/slash).
  - `test/phase-21/session-8/capability-gating-renderer.test.ts`, `menu-capability-gating.test.ts`
- [x] Settings/session pinning regression tests across mixed SDK sessions.
  - `test/phase-21/session-9/settings-production-label.test.ts`, `session-pinning-regression.test.ts`, `backward-compatibility.test.ts`
- [x] Integration verification test that asserts production Claude readiness (replaces mock TODO check).
  - `test/phase-21/session-8/integration-verification.test.ts` — 13 tests covering all stubs resolved, no TODO markers, capability completeness

## Global Definition of Done

- Claude provider is fully functional through the `AgentSdkImplementer` contract.
- Session create/connect/reconnect/prompt/abort/disconnect flows work for Claude and OpenCode.
- Event stream normalization is provider-agnostic and renderer-stable.
- Capability-gated features are driven by runtime capabilities.
- Model, command, question, permission, transcript, undo/redo behavior aligns with actual SDK support.
- No mock-only labels or mock TODO placeholders remain in shipping paths.
- `pnpm lint`, `pnpm test`, and `pnpm build` all pass.
