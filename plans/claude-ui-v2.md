# Claude UI V2 — Run claude CLI in a terminal

## Context

Today, sessions with `agent_sdk = 'claude-code'` are driven by `@anthropic-ai/claude-agent-sdk` through `src/main/services/claude-code-implementer.ts` and rendered as structured messages + tool cards inside `SessionView`. We want to move away from the SDK and instead spawn `claude --dangerously-skip-permissions` as a child process attached to a PTY, rendered as a full-bleed xterm terminal inside `SessionView`. Handoffs/ticket prompts should be passed to claude as the positional first-message argument, and the session's mode (plan/build) should be passed via `--permission-mode`.

We keep the SDK path alive as a **legacy** backend so existing sessions and users who prefer it can still use it.

## Goals

- Add a new agent backend `claude-code-cli` that spawns the `claude` CLI inside a PTY.
- Render the PTY full-bleed inside `SessionView` when `agent_sdk === 'claude-code-cli'`.
- Pass initial handoff/ticket prompt as the CLI positional arg so it auto-sends.
- Apply session mode at spawn via `--permission-mode plan` (build mode = no flag).
- Toggle mode mid-session by sending Shift+Tab (`\x1b[Z`) to the PTY (claude's built-in shortcut).
- Track claude's session UUID and resume with `--resume <id>` after app restart.

## Non-goals

- Removing the existing SDK code (`claude-code-implementer.ts`, Effect facade, etc.) — that becomes the **legacy** `claude-code` backend, untouched.
- Migrating existing `claude-code` DB rows — they stay on the legacy SDK renderer forever.
- Parsing claude's terminal output back into hive-style bubbles/tool cards.

## Key Decisions

| # | Decision | Notes |
|---|---|---|
| 1 | New `agent_sdk` value: `'claude-code-cli'` | Existing `'claude-code'` rows stay on legacy SDK path. No DB migration. |
| 2 | Renders **full-bleed terminal** in `SessionView` main canvas | No textarea, no Stop button, no message list, no tool cards. PTY handles all input/output/interrupt. |
| 3 | Initial prompt → positional argv | `claude --dangerously-skip-permissions [...] "<prompt>"` auto-sends on launch. |
| 4 | Plan mode → `--permission-mode plan` at spawn | Build mode = flag omitted. |
| 5 | Mid-session mode toggle → `pty.write('\x1b[Z')` | Shift+Tab escape. Still call `setSessionMode()` to keep hive UI in sync. |
| 6 | Super-plan with handoff → prefix `SUPER_PLAN_MODE_PREFIX` into positional arg | Same constant already used by SDK path. Super-plan toggle is **disabled when no handoff prompt is pending**. |
| 7 | Model dropdown stays | Translate to `--model <name>` + `--effort <level>` at spawn. Mid-session model changes happen via `/model` slash command typed by the user. |
| 8 | Resume on reconnect | Watch `~/.claude/projects/<encoded-worktree-path>/` for the newest `.jsonl` after first spawn; persist UUID basename as `sessions.claude_session_id`. On reconnect spawn `claude --resume <id> ...`. |
| 9 | PTY exit handling | Terminal stays mounted with final frame; overlay "Session ended — click to restart". Restart respawns with `--resume <id>` if known. |
| 10 | Reuse `pty-service.ts` | Extend `PtyCreateOpts` with optional `command` + `args` (defaults to shell). |

## CLI argv builder

```
claude
  --dangerously-skip-permissions
  [--permission-mode plan]            // when session.mode is plan or super-plan
  [--model <opus|sonnet|haiku>]       // from model dropdown
  [--effort <low|medium|high|xhigh|max>]
  [--resume <claudeSessionId>]        // when we have one from a prior run
  [<initialPrompt>]                   // positional; prefixed with SUPER_PLAN_MODE_PREFIX if mode=super-plan
```

`initialPrompt` is sourced from `pendingMessages.dequeue(sessionId)` at spawn time. Absent if user manually creates a session.

## Critical files to modify

### Main process

- **`src/main/services/pty-service.ts`** — Extend `PtyCreateOpts` with optional `command?: string` and `args?: string[]`. Default behavior (shell spawn) unchanged. The ghostty backend path needs the same parameterization or to be skipped for `claude-code-cli`.
- **`src/main/services/claude-cli-spawner.ts`** *(NEW)* — Pure function: given `{ session, worktreePath, pendingPrompt, claudeBinary, claudeSessionId }`, return `{ command, args, cwd, env }` for `pty-service.create()`. Encapsulates flag-building logic.
- **`src/main/services/claude-session-watcher.ts`** *(NEW)* — Wraps `fs.watch` on `~/.claude/projects/<encodePath(worktreePath)>/`. After spawn, the first new `.jsonl` filename is the session UUID. Emits the UUID to the renderer via IPC; main persists `sessions.claude_session_id = <uuid>`. Reuses `encodePath()` from existing `src/main/services/claude-transcript-reader.ts`.
- **`src/main/ipc/terminal-handlers.ts`** — Add a small IPC channel (or extend existing terminal create handler) so the renderer can request a "claude" PTY by session id; main calls `claude-cli-spawner` then `pty-service.create()`.
- **`src/main/db/database.ts`** + new numbered migration — Add `claude_session_id TEXT NULL` column on `sessions` (additive; safe with no row migration).
- **`src/main/services/claude-binary-resolver.ts`** — Already exists; reuse for binary discovery. Surface availability via existing `availableAgentSdks` plumbing.

### Renderer

- **`src/shared/types/session.ts`** — Extend `agent_sdk` union with `'claude-code-cli'`.
- **`src/renderer/src/lib/agent-sdk-availability.ts`** — Register `'claude-code-cli'` and gate it on claude binary presence (same check as existing `claude-session-title.ts` uses).
- **`src/renderer/src/stores/useSettingsStore.ts`** — Add `'claude-code-cli'` to known SDK list.
- **`src/renderer/src/components/settings/SettingsGeneral.tsx`** — New radio option labelled "Claude Code (CLI)" plus rename existing "Claude Code" → "Claude Code (legacy SDK)".
- **`src/renderer/src/stores/useSessionStore.ts`** —
  - `createSession()`: when `agent_sdk='claude-code-cli'`, do *not* call the SDK implementer's `connect()`; instead trigger the new terminal-spawn IPC. The pending message stays in `pendingMessages` until the main process asks for it during spawn.
  - `setSessionMode()` / `toggleSessionMode()`: when target session is `claude-code-cli` AND currently running, also send `\x1b[Z` to the PTY via terminal IPC. DB write still happens.
- **`src/renderer/src/components/sessions/SessionView.tsx`** — Early branch: if `session.agent_sdk === 'claude-code-cli'`, render `<ClaudeCliSessionView>` instead of the existing messages/textarea tree. Keep the header (title, mode toggle, model selector, super toggle, handoff button) above it.
- **`src/renderer/src/components/sessions/ClaudeCliSessionView.tsx`** *(NEW)* — Hosts an `<XtermBackend>` bound to the session's PTY. Full height. Renders `<ClaudeCliEndedOverlay>` when PTY has exited.
- **`src/renderer/src/components/sessions/ClaudeCliEndedOverlay.tsx`** *(NEW)* — Semi-transparent overlay: "Session ended — click to restart". On click, dispatch the spawn IPC again (with `--resume <claude_session_id>` if present).
- **`src/renderer/src/components/sessions/ModelSelector.tsx`** — When session is `claude-code-cli`, show only the model + effort dimensions that map to CLI flags. No structural change beyond conditional options.
- **`src/renderer/src/components/sessions/SuperToggle.tsx`** — Disable / hide the super-plan toggle for `claude-code-cli` sessions when there is no pending handoff prompt.
- **`src/renderer/src/lib/handoffSelection.ts`** — `resolveSessionCreationSelection()` and `buildHandoffPrompt()` accept `claude-code-cli` as a target sdk. For super-plan + claude-code-cli, prepend `SUPER_PLAN_MODE_PREFIX` from `src/renderer/src/lib/constants.ts` to the handoff prompt.

## Reused existing pieces

- `src/main/services/pty-service.ts` — PTY lifecycle (node-pty + ghostty fallbacks).
- `src/renderer/src/components/terminal/backends/XtermBackend.ts` — xterm.js renderer.
- `src/renderer/src/components/terminal/TerminalManager.tsx` — mount/unmount lifecycle. We adapt this (or a thin wrapper) for the in-SessionView mount instead of `MainPaneTerminalPanel`.
- `src/main/services/claude-binary-resolver.ts` — `which claude` discovery.
- `src/main/services/claude-transcript-reader.ts::encodePath()` — re-export the function for the session watcher.
- `src/main/services/claude-session-title.ts` — title generation continues to shell out to `claude -p`; unaffected by this work.
- `src/renderer/src/lib/constants.ts::SUPER_PLAN_MODE_PREFIX` — reused for super-plan handoff prefix injection.

## Out-of-scope / known limitations to document

- Mid-session messages typed into the terminal do NOT receive plan-mode or super-plan-mode prefixes (no interception point). Only the initial positional-arg prompt does.
- Mid-session model changes must be done via `/model` slash command typed in the terminal; the UI dropdown only takes effect at spawn time (or on a manual restart).
- Hive's "abort current message" UI is not shown — users press Ctrl+C in the terminal.
- Hive's structured plan-content overlay (from `ExitPlanMode` SDK tool) is not triggered; claude shows plan output inline in the terminal.

## Verification

1. **Smoke — new session, build mode, no prompt:**
   - Settings → pick "Claude Code (CLI)" as default.
   - Create a new session. Confirm SessionView renders a terminal with claude's REPL prompt. Type "hello" → response renders.
2. **Plan mode at spawn:**
   - Toggle mode to plan before sending. Confirm spawn argv contains `--permission-mode plan` (log inspection). Confirm claude shows plan-mode indicator in its TUI.
3. **Handoff with prompt:**
   - From a plan, use Handoff → claude-code-cli. New session opens. Confirm the prompt appears as the first user message inside the terminal and was auto-sent.
4. **Super-plan handoff:**
   - From a plan, set super-plan armed + handoff. Confirm the spawned argv's positional arg starts with the `SUPER_PLAN_MODE_PREFIX` text.
5. **Mid-session mode toggle:**
   - Press Tab in SessionView. Confirm claude's permission-mode indicator flips (Shift+Tab effect) and `sessions.mode` updates in DB.
6. **Resume after app restart:**
   - Send a few messages, quit hive, relaunch. Open the same session. Confirm spawn argv includes `--resume <uuid>` and claude reloads the prior transcript.
7. **PTY exit:**
   - Inside the terminal type `/quit`. Confirm the "Session ended — click to restart" overlay appears. Click → claude respawns with `--resume <uuid>`.
8. **Legacy backend untouched:**
   - Existing session rows with `agent_sdk='claude-code'` still open with the message-list/tool-card UI; SDK still drives them.
9. **Availability:**
   - Temporarily rename the `claude` binary on PATH. Confirm "Claude Code (CLI)" option is disabled in settings with the standard unavailable-sdk treatment.

## Rollout

- One Electron release. No phased flag — the legacy `claude-code` path remains selectable indefinitely as "Claude Code (legacy SDK)" so users can fall back.
