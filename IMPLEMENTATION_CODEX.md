# Codex SDK Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add first-class `codex` agent SDK support to Hive using the Codex CLI `app-server` flow already implemented in `t3code`, while preserving Hive's current renderer, preload, IPC, DB, and GraphQL integration patterns.

**Architecture:** Implement Codex as a new Electron main-process `AgentSdkImplementer` that manages a `codex app-server` child process, normalizes JSON-RPC events into Hive's existing `OpenCodeStreamEvent` stream shape, and participates in the existing session-based provider routing used by OpenCode and Claude Code. Generalize current Claude-specific dispatch points so all provider-aware operations route by `sessions.agent_sdk` instead of hard-coded branching.

**Tech Stack:** Electron 33, React 19, TypeScript 5.7, Zustand 5, SQLite, Vitest, Codex CLI app-server, Hive IPC/preload bridge, GraphQL server resolvers.

---

## Working Rules

- Implement one session at a time.
- Do not start a later session until the current session's automated tests pass.
- Keep commits small and session-scoped.
- Prefer porting logic from `t3code` into Hive-native service classes rather than copying Effect-specific architecture.
- Keep the existing `opencode:*` IPC and GraphQL API names in this feature unless a session explicitly says otherwise.
- Reuse `opencode_session_id` as the provider-side session/thread identifier for Codex just like Claude does today.
- Default Codex v1 capabilities to:
  - `supportsUndo: true`
  - `supportsRedo: false`
  - `supportsCommands: false`
  - `supportsPermissionRequests: true`
  - `supportsQuestionPrompts: true`
  - `supportsModelSelection: true`
  - `supportsReconnect: true`
  - `supportsPartialStreaming: true`

## Reference Source Files In `t3code`

Use these files throughout implementation:

- Core process manager:
  - `/Users/mor/Documents/dev/t3code/apps/server/src/codexAppServerManager.ts`
- Health checks:
  - `/Users/mor/Documents/dev/t3code/apps/server/src/provider/Layers/ProviderHealth.ts`
- Provider adapter and event mapping:
  - `/Users/mor/Documents/dev/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
- Contracts and model/event definitions:
  - `/Users/mor/Documents/dev/t3code/packages/contracts/src/provider.ts`
  - `/Users/mor/Documents/dev/t3code/packages/contracts/src/model.ts`
  - `/Users/mor/Documents/dev/t3code/packages/contracts/src/providerRuntime.ts`
  - `/Users/mor/Documents/dev/t3code/packages/contracts/src/server.ts`
- Behavior-spec tests:
  - `/Users/mor/Documents/dev/t3code/apps/server/src/codexAppServerManager.test.ts`
  - `/Users/mor/Documents/dev/t3code/apps/server/src/provider/Layers/CodexAdapter.test.ts`
  - `/Users/mor/Documents/dev/t3code/apps/server/src/provider/Layers/ProviderHealth.test.ts`
  - `/Users/mor/Documents/dev/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- Prereq doc:
  - `/Users/mor/Documents/dev/t3code/.docs/codex-prerequisites.md`

## Session 1: Generalize SDK IDs And Provider Routing Foundations

**Goal:** Make Hive's core SDK abstractions understand `codex` and remove the assumption that only Claude is the non-OpenCode provider.

**Reference files:**

- Hive:
  - `src/main/services/agent-sdk-types.ts`
  - `src/main/services/agent-sdk-manager.ts`
  - `src/main/ipc/opencode-handlers.ts`
  - `src/server/resolvers/helpers/sdk-dispatch.ts`
  - `src/server/headless-bootstrap.ts`
  - `src/shared/types/session.ts`
  - `src/main/db/types.ts`
  - `src/preload/index.d.ts`
- `t3code`:
  - `/Users/mor/Documents/dev/t3code/packages/contracts/src/provider.ts`
  - `/Users/mor/Documents/dev/t3code/packages/contracts/src/providerRuntime.ts`

**Files:**

- Modify: `src/main/services/agent-sdk-types.ts`
- Modify: `src/main/services/agent-sdk-manager.ts`
- Modify: `src/main/ipc/opencode-handlers.ts`
- Modify: `src/server/resolvers/helpers/sdk-dispatch.ts`
- Modify: `src/server/headless-bootstrap.ts`
- Modify: `src/shared/types/session.ts`
- Modify: `src/main/db/types.ts`
- Modify: `src/preload/index.d.ts`
- Test: `test/phase-22/session-1/agent-sdk-manager-codex.test.ts`
- Test: `test/phase-22/session-1/sdk-dispatch-codex.test.ts`

**Task list:**

1. Add `'codex'` to every `AgentSdkId` / `agent_sdk` union that currently supports OpenCode and Claude.
2. Add `CODEX_CAPABILITIES` in `src/main/services/agent-sdk-types.ts` using the defaults in this plan.
3. Refactor `AgentSdkManager` to accept an arbitrary set of implementers instead of exactly two constructor arguments.
4. Update `src/server/headless-bootstrap.ts` so the placeholder manager wiring can host Codex later without further refactors.
5. Replace Claude-specific routing branches in `src/server/resolvers/helpers/sdk-dispatch.ts` with manager-based routing by `agent_sdk`.
6. In `src/main/ipc/opencode-handlers.ts`, identify the routes that special-case Claude and convert them to generic `sdkManager.getImplementer(sdkId)` dispatch where the session is non-OpenCode.
7. Keep Terminal special-cased as a non-AI mode.
8. Add focused tests proving Codex routes through the manager and that OpenCode remains the fallback.

**Automated tests:**

- Run: `pnpm vitest run test/phase-22/session-1/agent-sdk-manager-codex.test.ts`
- Run: `pnpm vitest run test/phase-22/session-1/sdk-dispatch-codex.test.ts`

**Definition of done:**

- Core types compile with `codex` everywhere they should.
- `AgentSdkManager` is no longer hard-coded to two providers.
- At least one IPC path and one GraphQL helper path prove Codex routing works generically.
- No Claude-only assumptions remain in the shared routing helpers.

**Manual test list:**

- No manual UI verification required in this session.

**Suggested commit:**

- `refactor: generalize agent sdk routing for codex`

---

## Session 2: Detection, Onboarding, Settings, And Session Type Surface

**Goal:** Expose Codex as an install-detected provider and allow it to be selected anywhere users currently choose an agent SDK.

**Reference files:**

- Hive:
  - `src/main/services/system-info.ts`
  - `src/main/index.ts`
  - `src/renderer/src/components/setup/AgentSetupGuard.tsx`
  - `src/renderer/src/components/setup/AgentPickerDialog.tsx`
  - `src/renderer/src/components/settings/SettingsGeneral.tsx`
  - `src/renderer/src/stores/useSettingsStore.ts`
  - `src/renderer/src/stores/useSessionStore.ts`
  - `src/renderer/src/components/sessions/SessionTabs.tsx`
- `t3code`:
  - `/Users/mor/Documents/dev/t3code/.docs/codex-prerequisites.md`
  - `/Users/mor/Documents/dev/t3code/apps/server/src/provider/Layers/ProviderHealth.ts`

**Files:**

- Modify: `src/main/services/system-info.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/src/components/setup/AgentSetupGuard.tsx`
- Modify: `src/renderer/src/components/setup/AgentPickerDialog.tsx`
- Modify: `src/renderer/src/components/settings/SettingsGeneral.tsx`
- Modify: `src/renderer/src/stores/useSettingsStore.ts`
- Modify: `src/renderer/src/stores/useSessionStore.ts`
- Modify: `src/renderer/src/components/sessions/SessionTabs.tsx`
- Test: `test/phase-22/session-2/system-info-codex-detection.test.ts`
- Test: `test/phase-22/session-2/agent-setup-guard-codex.test.tsx`
- Test: `test/phase-22/session-2/settings-codex-provider.test.tsx`

**Task list:**

1. Extend `detectAgentSdks()` in `src/main/services/system-info.ts` to detect `codex` using `which` on macOS/Linux and `where` on Windows.
2. Remove any duplicated detection logic in `src/main/index.ts` by reusing the same helper if practical; otherwise keep behavior identical in both places and add a TODO to deduplicate later.
3. Widen the renderer availability cache type to include Codex.
4. Update onboarding logic so:
   - one installed provider auto-selects it
   - multiple installed providers show Codex in the picker
   - none found still shows the existing missing-agent flow
5. Update settings UI so Codex can be chosen as the default agent SDK.
6. Update new session creation paths so `agent_sdk = 'codex'` can be persisted.
7. Add tests for detection, onboarding auto-selection, and settings rendering.

**Automated tests:**

- Run: `pnpm vitest run test/phase-22/session-2/system-info-codex-detection.test.ts`
- Run: `pnpm vitest run test/phase-22/session-2/agent-setup-guard-codex.test.tsx`
- Run: `pnpm vitest run test/phase-22/session-2/settings-codex-provider.test.tsx`

**Definition of done:**

- Hive can detect a locally installed Codex CLI.
- Users can select Codex in onboarding and settings.
- New sessions can be created with `agent_sdk = 'codex'` without type errors.

**Manual test list:**

- Start Hive with only `codex` installed on `PATH`; verify onboarding auto-selects Codex.
- Start Hive with OpenCode, Claude, and Codex installed; verify picker shows all three AI providers plus Terminal where applicable.
- Open Settings and switch default provider to Codex; verify the setting persists after reload.

**Suggested commit:**

- `feat: add codex to provider detection and settings`

---

## Session 3: Codex Health, Model Catalog, And Implementer Skeleton

**Goal:** Create the Codex main-process service scaffolding and runtime capability/model surfaces before wiring full streaming.

**Reference files:**

- Hive:
  - `src/main/services/claude-code-implementer.ts`
  - `src/main/services/agent-sdk-types.ts`
  - `src/main/ipc/opencode-handlers.ts`
- `t3code`:
  - `/Users/mor/Documents/dev/t3code/apps/server/src/provider/Layers/ProviderHealth.ts`
  - `/Users/mor/Documents/dev/t3code/packages/contracts/src/model.ts`
  - `/Users/mor/Documents/dev/t3code/apps/server/src/codexAppServerManager.ts`

**Files:**

- Create: `src/main/services/codex-health.ts`
- Create: `src/main/services/codex-models.ts`
- Create: `src/main/services/codex-implementer.ts`
- Modify: `src/main/index.ts`
- Modify: `src/server/headless-bootstrap.ts`
- Test: `test/phase-22/session-3/codex-health.test.ts`
- Test: `test/phase-22/session-3/codex-model-catalog.test.ts`
- Test: `test/phase-22/session-3/codex-implementer-skeleton.test.ts`

**Task list:**

1. Port the pure health-check logic from `ProviderHealth.ts` into a Hive-native `codex-health.ts`.
2. Implement helpers to:
   - run `codex --version`
   - optionally run `codex login status`
   - parse unauthenticated output into actionable user-facing errors
3. Port the Codex model constants and normalization ideas from `packages/contracts/src/model.ts` into `codex-models.ts`.
4. Create `CodexImplementer` that satisfies `AgentSdkImplementer`, even if some methods initially throw `not implemented` while covered by failing tests.
5. Wire the implementer into `src/main/index.ts` and `src/server/headless-bootstrap.ts` so the manager can instantiate it.
6. Implement `getAvailableModels()`, `getModelInfo()`, `setSelectedModel()`, `setMainWindow()`, and `cleanup()` first.
7. Keep all unimplemented lifecycle/messaging methods behind explicit errors until later sessions replace them.

**Automated tests:**

- Run: `pnpm vitest run test/phase-22/session-3/codex-health.test.ts`
- Run: `pnpm vitest run test/phase-22/session-3/codex-model-catalog.test.ts`
- Run: `pnpm vitest run test/phase-22/session-3/codex-implementer-skeleton.test.ts`

**Definition of done:**

- `CodexImplementer` exists, is registered, and exposes stable capabilities and model catalog behavior.
- Health-check helpers can distinguish installed vs missing vs unauthenticated Codex.
- No placeholder compilation errors remain.

**Manual test list:**

- None required beyond optional local invocation of the health helper in tests.

**Suggested commit:**

- `feat: scaffold codex implementer and health checks`

---

## Session 4: Codex App-Server Process Manager And Session Lifecycle

**Goal:** Spawn `codex app-server`, initialize a session, reconnect to an existing provider thread, and shut everything down cleanly.

**Reference files:**

- Hive:
  - `src/main/services/claude-code-implementer.ts`
  - `src/main/ipc/opencode-handlers.ts`
- `t3code`:
  - `/Users/mor/Documents/dev/t3code/apps/server/src/codexAppServerManager.ts`
  - `/Users/mor/Documents/dev/t3code/apps/server/src/codexAppServerManager.test.ts`

**Files:**

- Create: `src/main/services/codex-app-server-manager.ts`
- Modify: `src/main/services/codex-implementer.ts`
- Test: `test/phase-22/session-4/codex-app-server-manager.test.ts`
- Test: `test/phase-22/session-4/codex-lifecycle.test.ts`

**Task list:**

1. Port the child-process manager shape from `codexAppServerManager.ts` into a Hive-native class.
2. Implement child spawn for `codex app-server` with stdout/stderr/readline processing.
3. Port the Windows child-tree kill logic from `t3code`.
4. Implement JSON-RPC request/response correlation and timeouts.
5. Implement the minimal initialization flow:
   - `initialize`
   - `initialized`
   - account read if needed
   - thread start or thread resume
6. Add session state tracking keyed by Hive session and provider session/thread ID.
7. Implement `connect()`, `reconnect()`, `disconnect()`, and `cleanup()` in `CodexImplementer` using the manager.
8. Store enough metadata for future prompt, abort, and undo work.

**Automated tests:**

- Run: `pnpm vitest run test/phase-22/session-4/codex-app-server-manager.test.ts`
- Run: `pnpm vitest run test/phase-22/session-4/codex-lifecycle.test.ts`

**Definition of done:**

- Codex child processes can be started and stopped predictably.
- A Hive Codex session can connect and reconnect through the implementer.
- Session state survives the handoff between `connect()` and later prompt calls.

**Manual test list:**

- Start a Codex session, close it, and verify no orphan `codex app-server` process remains.
- Restart Hive and verify a stored Codex session can attempt reconnect without crashing.

**Suggested commit:**

- `feat: add codex app-server session lifecycle`

---

## Session 5: Prompting, Event Mapping, And Streaming Message Delivery

**Goal:** Send prompts to Codex, map app-server notifications into Hive stream events, and render Codex responses in the existing session UI without UI rewrites.

**Reference files:**

- Hive:
  - `src/shared/types/opencode.ts`
  - `src/main/ipc/opencode-handlers.ts`
  - `src/renderer/src/components/sessions/SessionView.tsx`
  - `src/renderer/src/stores/useSessionStore.ts`
- `t3code`:
  - `/Users/mor/Documents/dev/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
  - `/Users/mor/Documents/dev/t3code/packages/contracts/src/providerRuntime.ts`
  - `/Users/mor/Documents/dev/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`

**Files:**

- Create: `src/main/services/codex-event-mapper.ts`
- Modify: `src/main/services/codex-app-server-manager.ts`
- Modify: `src/main/services/codex-implementer.ts`
- Modify: `src/main/ipc/opencode-handlers.ts`
- Test: `test/phase-22/session-5/codex-event-mapper.test.ts`
- Test: `test/phase-22/session-5/codex-prompt-streaming.test.ts`
- Test: `test/phase-22/session-5/codex-child-session-routing.test.ts`

**Task list:**

1. Identify the minimum Codex app-server methods/notifications needed for prompt streaming.
2. Port the event classification ideas from `CodexAdapter.ts` into a Hive mapper that outputs `OpenCodeStreamEvent` objects.
3. Cover at least these flows:
   - assistant text delta
   - reasoning delta
   - task started / progress / completed
   - session state changes
   - runtime errors
4. Implement `prompt()` in `CodexImplementer` using the manager and event mapper.
5. Preserve first-prompt worktree context injection from `src/main/ipc/opencode-handlers.ts`.
6. Ensure the renderer receives stream events on the same channels it already listens to.
7. Add tests for streaming, partial updates, completion, and failure handling.

**Automated tests:**

- Run: `pnpm vitest run test/phase-22/session-5/codex-event-mapper.test.ts`
- Run: `pnpm vitest run test/phase-22/session-5/codex-prompt-streaming.test.ts`
- Run: `pnpm vitest run test/phase-22/session-5/codex-child-session-routing.test.ts`

**Definition of done:**

- A prompt sent through existing Hive session plumbing can stream Codex output into the UI event model.
- Reasoning and task progress do not break existing message rendering.
- Error paths surface a session error instead of hanging the session.

**Manual test list:**

- Start a Codex session and send a simple prompt; verify streaming text appears in SessionView.
- Send a prompt likely to trigger reasoning/progress; verify the UI stays responsive and status changes correctly.
- Trigger a failure case such as a missing login; verify a clear actionable error appears.

**Suggested commit:**

- `feat: stream codex app-server events through hive`

---

## Session 6: Permission Requests, Question Prompts, Abort, And Message Retrieval

**Goal:** Finish the human-in-the-loop and control-plane operations needed for real Codex usage.

**Reference files:**

- Hive:
  - `src/main/ipc/opencode-handlers.ts`
  - `src/renderer/src/stores/useQuestionStore.ts`
  - `src/renderer/src/stores/usePermissionStore.ts`
  - `src/renderer/src/stores/useCommandApprovalStore.ts`
- `t3code`:
  - `/Users/mor/Documents/dev/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
  - `/Users/mor/Documents/dev/t3code/apps/server/src/codexAppServerManager.ts`

**Files:**

- Modify: `src/main/services/codex-app-server-manager.ts`
- Modify: `src/main/services/codex-implementer.ts`
- Modify: `src/main/ipc/opencode-handlers.ts`
- Test: `test/phase-22/session-6/codex-permission-requests.test.ts`
- Test: `test/phase-22/session-6/codex-question-prompts.test.ts`
- Test: `test/phase-22/session-6/codex-abort-getmessages.test.ts`

**Task list:**

1. Implement request tracking for Codex approval requests.
2. Map Codex request kinds into Hive permission and command approval shapes.
3. Implement user-input question flow bridging from Codex `requestUserInput` style events into Hive's question store plumbing.
4. Implement `permissionReply()`, `questionReply()`, and `questionReject()`.
5. Implement `abort()` via Codex turn interruption.
6. Implement `getMessages()` using in-memory session state first; add transcript/thread-read fallback if needed for reconnect cases.
7. Implement `permissionList()` with behavior compatible with Hive's existing UI expectations, even if that is initially a best-effort list.

**Automated tests:**

- Run: `pnpm vitest run test/phase-22/session-6/codex-permission-requests.test.ts`
- Run: `pnpm vitest run test/phase-22/session-6/codex-question-prompts.test.ts`
- Run: `pnpm vitest run test/phase-22/session-6/codex-abort-getmessages.test.ts`

**Definition of done:**

- Approval prompts can be accepted or rejected from Hive.
- Question prompts can be answered from Hive.
- Abort works and updates session state.
- `getMessages()` returns Codex session content well enough for reconnect/UI hydration.

**Manual test list:**

- Trigger a Codex file-read or file-change approval and respond from the UI.
- Trigger a Codex question/input request and reply from the UI.
- Start a long Codex prompt and abort it; verify the session becomes idle instead of stuck.

**Suggested commit:**

- `feat: add codex hitl flows and abort support`

---

## Session 7: Undo, Session Info, Model Selection Integration, And Rename

**Goal:** Complete the remaining provider-parity operations so Codex behaves like a real first-class session type.

**Reference files:**

- Hive:
  - `src/main/services/claude-code-implementer.ts`
  - `src/main/ipc/opencode-handlers.ts`
  - `src/renderer/src/components/sessions/SessionView.tsx`
  - `src/renderer/src/components/sessions/ModelSelector.tsx`
- `t3code`:
  - `/Users/mor/Documents/dev/t3code/apps/server/src/codexAppServerManager.ts`
  - `/Users/mor/Documents/dev/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
  - `/Users/mor/Documents/dev/t3code/packages/contracts/src/model.ts`

**Files:**

- Modify: `src/main/services/codex-app-server-manager.ts`
- Modify: `src/main/services/codex-implementer.ts`
- Modify: `src/main/ipc/opencode-handlers.ts`
- Modify: `src/renderer/src/components/sessions/ModelSelector.tsx`
- Test: `test/phase-22/session-7/codex-undo-redo.test.ts`
- Test: `test/phase-22/session-7/codex-getsessioninfo.test.ts`
- Test: `test/phase-22/session-7/codex-model-selection.test.ts`

**Task list:**

1. Implement Codex rollback in the manager using the `thread/rollback` pattern from `t3code`.
2. Implement `undo()` in `CodexImplementer` and return an unsupported error for `redo()`.
3. Implement `getSessionInfo()` so SessionView can show undo/fork boundary info consistently.
4. Ensure Codex model selection integrates with existing `window.opencodeOps.models()` and `setModel()` flows.
5. Add any model normalization needed for Codex aliases or default variants.
6. Implement `renameSession()` as a local DB rename only, matching current Claude behavior.
7. Verify capability-gated UI behavior hides or disables redo for Codex.

**Automated tests:**

- Run: `pnpm vitest run test/phase-22/session-7/codex-undo-redo.test.ts`
- Run: `pnpm vitest run test/phase-22/session-7/codex-getsessioninfo.test.ts`
- Run: `pnpm vitest run test/phase-22/session-7/codex-model-selection.test.ts`

**Definition of done:**

- Codex supports undo end-to-end.
- Codex clearly reports redo as unsupported.
- Model selection works for both default and per-prompt model overrides.
- Session rename works without Codex-specific backend support.

**Manual test list:**

- Use Codex to make a reversible change, then trigger undo from the UI and verify the revert behavior.
- Confirm redo is hidden or disabled.
- Select different Codex models and verify the chosen model is used for the next prompt.

**Suggested commit:**

- `feat: finish codex session controls and model support`

---

## Session 8: Renderer Polish, Session Menus, Icons, And Backward-Compatibility Pass

**Goal:** Make Codex feel fully integrated in the existing UI and ensure old settings/session records remain safe.

**Reference files:**

- Hive:
  - `src/renderer/src/components/worktrees/ModelIcon.tsx`
  - `src/renderer/src/components/sessions/SessionTabs.tsx`
  - `src/renderer/src/components/sessions/SessionView.tsx`
  - `src/renderer/src/stores/useSettingsStore.ts`
  - `test/phase-21/session-9/backward-compatibility.test.ts`
- `t3code`:
  - `/Users/mor/Documents/dev/t3code/apps/web/src/appSettings.ts`
  - `/Users/mor/Documents/dev/t3code/apps/web/src/routes/_chat.settings.tsx`

**Files:**

- Modify: `src/renderer/src/components/worktrees/ModelIcon.tsx`
- Modify: `src/renderer/src/components/sessions/SessionTabs.tsx`
- Modify: `src/renderer/src/components/sessions/SessionView.tsx`
- Modify: `src/renderer/src/stores/useSettingsStore.ts`
- Test: `test/phase-22/session-8/codex-ui-polish.test.tsx`
- Test: `test/phase-22/session-8/codex-backward-compatibility.test.ts`

**Task list:**

1. Add Codex provider icon/name display wherever provider identities are shown.
2. Make sure session menus and badges treat Codex as a normal AI provider.
3. Verify the capability-driven slash command filtering in `SessionView` behaves correctly for Codex.
4. Add backward-compatibility tests proving old persisted settings without Codex fields still load.
5. Add backward-compatibility tests proving old sessions with OpenCode and Claude still render and route normally.

**Automated tests:**

- Run: `pnpm vitest run test/phase-22/session-8/codex-ui-polish.test.tsx`
- Run: `pnpm vitest run test/phase-22/session-8/codex-backward-compatibility.test.ts`

**Definition of done:**

- Codex looks intentional in the UI instead of like a partially wired provider.
- Existing persisted settings and historical sessions continue to load safely.

**Manual test list:**

- Open a mixed project with old OpenCode sessions and new Codex sessions; verify both render and switch correctly.
- Verify provider badges/icons/labels are correct in tabs and selectors.

**Suggested commit:**

- `feat: polish codex ui integration`

---

## Session 9: GraphQL, Docs, Final Regression, And Release Readiness

**Goal:** Finish server API parity, document Codex support, and run a full regression pass before merge.

**Reference files:**

- Hive:
  - `src/server/resolvers/query/opencode.resolvers.ts`
  - `src/server/resolvers/mutation/opencode.resolvers.ts`
  - `src/server/resolvers/query/db.resolvers.ts`
  - `src/server/resolvers/mutation/db.resolvers.ts`
  - `docs/specs/agent-sdk-integration.md`
- `t3code`:
  - `/Users/mor/Documents/dev/t3code/.docs/codex-prerequisites.md`
  - `/Users/mor/Documents/dev/t3code/apps/server/src/provider/Layers/ProviderHealth.test.ts`

**Files:**

- Modify: `src/server/resolvers/query/opencode.resolvers.ts`
- Modify: `src/server/resolvers/mutation/opencode.resolvers.ts`
- Modify: `src/server/resolvers/query/db.resolvers.ts`
- Modify: `src/server/resolvers/mutation/db.resolvers.ts`
- Modify: `docs/specs/agent-sdk-integration.md`
- Test: `test/phase-22/session-9/graphql-codex-routing.test.ts`
- Test: `test/phase-22/session-9/codex-regression-smoke.test.ts`

**Task list:**

1. Update GraphQL resolvers so Codex is fully routable for all existing `opencode*` operations.
2. Update DB-to-GraphQL enum mapping so Codex is represented consistently, including any `claude_code` formatting logic already in place.
3. Update `docs/specs/agent-sdk-integration.md` to document Codex support, capabilities, auth expectations, session persistence, and known limitations.
4. Add a compact regression suite that exercises provider selection, connect, prompt, abort, and capability lookup across OpenCode, Claude, and Codex.
5. Run the final targeted suite plus lint for touched files.

**Automated tests:**

- Run: `pnpm vitest run test/phase-22/session-9/graphql-codex-routing.test.ts`
- Run: `pnpm vitest run test/phase-22/session-9/codex-regression-smoke.test.ts`
- Run: `pnpm lint`

**Definition of done:**

- Codex works through GraphQL and headless paths, not just Electron IPC.
- The main integration spec is updated and accurate.
- The regression suite passes for all three AI providers.

**Manual test list:**

- Open a real Codex session end-to-end: create session, send prompt, answer an approval or question if prompted, undo, abort, reconnect after restart.
- Open a Claude session and an OpenCode session and verify both still work.
- Verify the user-facing auth guidance for unauthenticated Codex says to run `codex login`.

**Suggested commit:**

- `docs: finalize codex support and regression coverage`

---

## Final Verification Checklist

Run these before considering the feature complete:

1. `pnpm vitest run test/phase-22/session-1/agent-sdk-manager-codex.test.ts`
2. `pnpm vitest run test/phase-22/session-1/sdk-dispatch-codex.test.ts`
3. `pnpm vitest run test/phase-22/session-2/system-info-codex-detection.test.ts`
4. `pnpm vitest run test/phase-22/session-2/agent-setup-guard-codex.test.tsx`
5. `pnpm vitest run test/phase-22/session-2/settings-codex-provider.test.tsx`
6. `pnpm vitest run test/phase-22/session-3/codex-health.test.ts`
7. `pnpm vitest run test/phase-22/session-3/codex-model-catalog.test.ts`
8. `pnpm vitest run test/phase-22/session-3/codex-implementer-skeleton.test.ts`
9. `pnpm vitest run test/phase-22/session-4/codex-app-server-manager.test.ts`
10. `pnpm vitest run test/phase-22/session-4/codex-lifecycle.test.ts`
11. `pnpm vitest run test/phase-22/session-5/codex-event-mapper.test.ts`
12. `pnpm vitest run test/phase-22/session-5/codex-prompt-streaming.test.ts`
13. `pnpm vitest run test/phase-22/session-5/codex-child-session-routing.test.ts`
14. `pnpm vitest run test/phase-22/session-6/codex-permission-requests.test.ts`
15. `pnpm vitest run test/phase-22/session-6/codex-question-prompts.test.ts`
16. `pnpm vitest run test/phase-22/session-6/codex-abort-getmessages.test.ts`
17. `pnpm vitest run test/phase-22/session-7/codex-undo-redo.test.ts`
18. `pnpm vitest run test/phase-22/session-7/codex-getsessioninfo.test.ts`
19. `pnpm vitest run test/phase-22/session-7/codex-model-selection.test.ts`
20. `pnpm vitest run test/phase-22/session-8/codex-ui-polish.test.tsx`
21. `pnpm vitest run test/phase-22/session-8/codex-backward-compatibility.test.ts`
22. `pnpm vitest run test/phase-22/session-9/graphql-codex-routing.test.ts`
23. `pnpm vitest run test/phase-22/session-9/codex-regression-smoke.test.ts`
24. `pnpm lint`

## Acceptance Criteria

The feature is complete when all of the following are true:

- Codex is detected and selectable when installed.
- New and existing sessions can use `agent_sdk = 'codex'`.
- Codex can connect, reconnect, prompt, stream, abort, answer approvals/questions, fetch messages, undo, and rename sessions.
- Codex model selection works through existing model APIs and UI.
- OpenCode and Claude continue working across IPC, renderer, and GraphQL paths.
- `docs/specs/agent-sdk-integration.md` documents Codex accurately.
