# Blank Session Provider Switch

**Date:** 2026-06-01  
**Status:** Design Approved  
**Feature:** Allow changing the AI provider for durable-blank sessions

## Overview

Allow users to change the AI provider for a newly created session before any conversation history exists. The static provider label in the composer becomes a provider selector while the session is still durably blank. After the first durable message or activity exists, the selector disappears and the same provider text is shown as a fixed label.

This keeps provider selection close to the existing composer controls, preserves the current session tab and draft, and avoids changing the provider for sessions that already have meaningful history.

## Problem Statement

Hive currently lets users choose the provider for new sessions through Settings or by right-clicking the `+` tab button. However, auto-created empty sessions already show a composer with a static provider label such as `CODEX` or `OPENCODE-GO`. If the user wants a different provider at that moment, the UI does not offer a direct switch in the place where they are about to type.

Changing the provider after a real conversation starts is risky because the session's `agent_sdk` controls routing, reconnect behavior, capabilities, model catalog, and the view type. The safe window is before the session has durable history.

## Goals

1. Let users change the AI provider from the composer for newly created blank sessions.
2. Preserve draft text while switching providers.
3. Preserve the existing session tab, active focus, mode, and tab order.
4. Make provider switching unavailable once durable conversation history exists.
5. Include only AI providers: OpenCode, Claude Code, Codex, and Claude Code CLI.
6. Keep Terminal out of this composer provider selector.
7. Avoid updating worktree/global last-used defaults merely because the user previewed a provider in a blank session.

## Non-Goals

1. Do not allow provider changes after durable history exists.
2. Do not add an `All providers` option to the composer provider selector.
3. Do not replace the existing right-click `+` provider creation menu.
4. Do not support switching to Terminal from the composer provider selector.
5. Do not redesign the full composer or settings model UI.

## User Experience

### Blank Session

When a session is durably blank, the existing static provider label position becomes a compact dropdown trigger:

- `OPENCODE`
- `CLAUDE CODE`
- `CODEX`
- `CLAUDE CLI`

The dropdown lists only installed/available AI providers. If provider availability has not loaded or cannot be verified, the control stays as static provider text and no switch targets are shown. For OpenCode-style sessions, the model selector remains immediately to the right and updates to the default model for the selected provider. For Claude Code CLI sessions, the model selector is intentionally hidden because the live CLI process does not consume Hive's post-spawn model changes.

Draft text in the composer remains untouched. If the user typed a prompt but has not sent it, switching providers should not clear or alter that draft.

### Nonblank Session

When a session is no longer durably blank, the provider selector is replaced by a static provider label in the same location. The caret disappears. For OpenCode-style sessions, the model selector continues to work within the existing provider's model catalog, matching today's behavior. Claude Code CLI continues to hide the model selector.

### Failure Feedback

Provider changes should be immediate and should not require confirmation. If the switch cannot be completed, show a toast and leave the session on its previous provider.

If switching succeeds but the new provider cannot connect, keep the session row on the selected provider and let the existing session connection error/retry UI handle the failure.

## Durable Blank Definition

A session is durably blank only when all of the following are true:

1. The visible message list is empty.
2. `window.db.sessionMessage.list(sessionId)` returns no messages.
3. `window.db.sessionActivity.list(sessionId)` returns no activities.
4. If an existing `opencode_session_id` exists, the live backend transcript can be verified and is empty.
5. If the session is Claude Code CLI, no `claude_session_id` has been captured yet; launched CLI transcripts are treated as unverifiable and therefore nonblank for switching.
6. No prompt is currently sending.
7. No stream is active.
8. No queued follow-up or pending follow-up prompt exists.
9. The session is not a bare Terminal session.
10. No pending initial prompt exists for the session.

Draft input does not affect blankness. A session with unsent composer text is still blank if the durable checks above pass.

The UI may use local visible state for quick rendering, but it must keep durable history state fresh after mount with a subscription-style or polling check. Once durable messages or activities appear, the dropdown becomes the static provider label even if the visible message list is empty or filtered.

The store action must enforce durable blankness before mutating the provider. It fails closed if it cannot verify messages, activities, live backend transcript history, provider availability, or live session status because a missing preload/API surface must not permit provider mutation. Local send/stream/queued follow-up activity must be mirrored into store-owned transient state so the action can reject active sessions without trusting a mounted component's local state.

Session status only blocks switching when it represents active work or an interaction gate: `working`, `planning`, `answering`, `permission`, `command_approval`, or `plan_ready`. Plain `completed` status does not block switching when durable DB messages and activities are empty.

## Architecture

### Session Store Action

Add one explicit action to `useSessionStore`:

```ts
changeBlankSessionProvider(
  sessionId: string,
  nextAgentSdk: 'opencode' | 'claude-code' | 'codex' | 'claude-code-cli',
  nextModel?: SelectedModel
): Promise<{ success: boolean; error?: string }>
```

This action owns the safety invariant so UI components do not duplicate partial checks.

Action flow:

1. Find the session in worktree or connection session state, then verify it exists in the database.
2. Reject bare Terminal sessions.
3. Check durable blankness with `sessionMessage.list` and `sessionActivity.list`; reject if either API is unavailable or throws.
4. If the current session has an `opencode_session_id`, query the live backend transcript and reject if it is nonempty or cannot be verified.
5. If the current session is Claude CLI and has a `claude_session_id`, reject because Hive has no reliable session-only transcript verification API for the live CLI transcript.
6. Reject if provider availability is unknown or if `nextAgentSdk` is unavailable.
7. Reject if any sent message, activity, active stream, queued prompt, pending follow-up, pending initial prompt, or store-owned local send/stream/queued-follow-up activity exists.
8. Resolve a default model for `nextAgentSdk` if `nextModel` is not supplied.
9. Update the session row:
   - `agent_sdk = nextAgentSdk`
   - `model_provider_id = resolvedModel.providerID`
   - `model_id = resolvedModel.modelID`
   - `model_variant = resolvedModel.variant ?? null`
   - `opencode_session_id = null`
   - `claude_session_id = null`
10. After the database update succeeds, best-effort tear down the old runtime:
   - Disconnect the old `opencode_session_id` through `opencodeOps.disconnect`.
   - Destroy the old Claude CLI PTY through `terminalOps.destroy(sessionId)`.
11. Update the in-memory session in the owning scope.
12. Do not update worktree `last_model_*`.
13. Do not update global or per-SDK selected model defaults as a side effect.

`setSessionModel` remains responsible for explicit model changes and can keep its current last-used default behavior.

### Provider And Model Resolution

The provider selector should resolve the selected provider's model using the same precedence as new-session creation where possible:

1. Mode-specific default if it is valid for the selected SDK.
2. Per-SDK selected model from settings.
3. First available catalog model.
4. Existing fallback model for that SDK.

Provider switching intentionally skips worktree `last_model_*` fallback so an explicit switch cannot reuse a model from the previous SDK. A mode default without `agentSdk` may still be used for an explicit provider switch when it is verified as valid for the selected SDK; unknown validity must fail closed and fall through to the next precedence step.

In code, use `agentSdk` or `sessionProvider` naming for the session-level provider. Reserve `model_provider_id` for model catalog providers such as `anthropic`, `codex`, or `openai`.

### Session View Reconnect

After the store action changes `agent_sdk` and clears agent session IDs, `SessionView` should reconnect through the existing initialization path. If the provider changes to Claude Code CLI, the active main pane may need to swap from the OpenCode-style session view to the terminal-backed `ClaudeCliSessionView`.

That swap is expected and should be tested explicitly. Once the Claude CLI view is mounted, opening the provider dropdown must not hide or unmount it. Dropdowns may suppress native Ghostty overlays, but that suppression applies only to actual Ghostty surfaces; Claude CLI is xterm-backed and must remain visible so dropdown anchors stay stable.

When a Claude CLI session is moved into or out of a ticket modal, the mounted `SessionView`/`ClaudeCliSessionView` subtree must remain stable. Main pane mounting should use a stable host element that moves between the inline pane and modal target instead of switching between inline rendering and a new portal subtree. This prevents `TerminalView` from disposing and recreating the xterm backend while preserving correct dropdown anchoring.

## UI Component Changes

Introduce a small adjacent `SessionProviderSelector` for the static-label position. The final implementation should preserve this UI behavior:

1. Use the existing provider label location in the composer.
2. Render a dropdown only when durable blankness is true.
3. Render static text when durable blankness is false.
4. Do not show `All providers`.
5. Do not show Terminal.
6. Omit unavailable AI providers.
7. Treat unknown provider availability as unavailable: show static provider text and no dropdown menu until availability is known.
8. Keep the model selector immediately to the right for OpenCode-style session views.
9. Render `ModelSelector` with `hideProviderPrefix` so provider identity is shown once.
10. In Claude CLI session headers, keep the provider control but do not render `ModelSelector`.

The key requirement is that model selection and session-provider selection remain distinct in code.

Claude CLI model choice remains a launch-time concern. Hive may persist `model_id` and `model_variant` and pass them to `claude --model` and `--effort` when creating the PTY, but changing Hive model state after the PTY is running does not update the live Claude process. Injecting `/model` into the PTY is intentionally out of scope because it is brittle and can mutate the user's Claude Code default. Hiding the selector avoids a control that appears to work while only changing Hive state.

## Error Handling

| Case | Behavior |
| ---- | -------- |
| Durable-blank validation fails | Do not switch; return an error |
| Durable-blank validation cannot be verified | Fail closed; do not switch |
| Live backend transcript cannot be verified | Fail closed; do not switch |
| Launched Claude CLI transcript exists but cannot be verified | Fail closed; show static provider text |
| Database update fails | Keep old provider and old runtime; show a toast |
| Old backend teardown fails after DB update | Log and continue |
| Store update succeeds but new provider connect fails | Keep selected provider; show existing connection retry UI |
| Provider availability unknown | Fail closed; show static provider text and reject switching |
| Provider unavailable | Omit from dropdown |
| Current provider unavailable | Keep current label; omit unavailable switch targets |
| Claude CLI switch triggers view swap | Allow swap; verify draft preservation where applicable |

## Testing Plan

### Store Tests

1. `changeBlankSessionProvider` succeeds when messages and activities are empty.
2. Draft input does not block switching.
3. Existing session messages block switching.
4. Existing session activities block switching.
5. Active/queued/pending prompt state blocks switching.
6. Old agent session IDs are cleared after a successful switch.
7. Existing unused backend session is disconnected best-effort.
8. Disconnect failure does not corrupt local state.
9. Worktree `last_model_*` defaults are not updated.
10. Global/per-SDK selected model defaults are not updated.
11. Missing history APIs or failed status verification reject the switch.
12. Database update failure does not disconnect OpenCode or destroy a Claude CLI PTY.
13. Plain `completed` status is allowed after durable blankness is verified.
14. Switching away from Claude CLI tears down the PTY after a successful DB update.
15. Live backend transcript history blocks switching.
16. Live backend transcript verification failure rejects the switch.
17. Unknown provider availability rejects the switch.
18. Store-owned sending, streaming, and queued local follow-up activity reject the switch.

### Component Tests

1. Blank session renders provider dropdown in the static provider label location.
2. Nonblank session renders static provider label.
3. Choosing a provider calls the store action.
4. Model selector updates to the selected provider's resolved model.
5. Unavailable providers are omitted.
6. No `All providers` option appears.
7. Terminal does not appear.
8. Durable history appearing after mount flips the dropdown back to static provider text.
9. Claude CLI renders the provider control and omits the model selector.
10. Unknown provider availability renders static provider text and no dropdown.
11. SessionView syncs send/stream/queued follow-up activity into store-owned provider-switch activity state and clears it on unmount.

### Regression Tests

1. Existing model switching still works after first message.
2. Right-click `+` provider creation still works.
3. Switching a blank OpenCode-style session to Claude Code CLI transitions cleanly to the terminal-backed view.
4. Auto-start blank sessions can switch provider before first send.
5. Explicit non-default provider switch uses a valid bare mode default.
6. Provider switching does not reuse worktree `last_model_*` fallback.
7. Unknown validity for a bare mode default falls back to the selected provider/default.
8. Opening the provider dropdown in a Claude CLI session keeps the xterm-backed Claude CLI view mounted and visible.
9. Moving a Claude CLI session into and out of a ticket modal does not remount `SessionView` or recreate the terminal backend.

## Manual Verification

1. Open a worktree with auto-start enabled.
2. Confirm the blank session shows a provider dropdown where the provider label normally appears.
3. Type a draft without sending it.
4. Switch provider from OpenCode to Codex.
5. Confirm the draft remains.
6. Switch back to another AI provider.
7. Send the prompt.
8. Confirm the selected provider and model are used for OpenCode-style sessions.
9. Confirm Claude CLI sessions show no model selector.
10. Confirm the provider control becomes a static label after history exists.

## Open Decisions

No open product decisions remain for this design. The provider control is a separate `SessionProviderSelector`, and session-provider and model-provider concepts remain clearly separated.
