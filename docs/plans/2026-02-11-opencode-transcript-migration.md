# OpenCode Transcript Source-of-Truth Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop storing session messages in Hive SQLite and use OpenCode storage as the canonical transcript source so a session can be continued across Hive and native OpenCode CLI without transcript divergence.

**Architecture:** Keep Hive SQLite for local product metadata (projects, worktrees, session tabs, session mode, drafts, statuses), but move transcript reads/writes fully to OpenCode APIs (`session.messages` and stream events). SessionView becomes an OpenCode-backed transcript consumer with optimistic UI for local sends, and main-process event forwarding no longer mirrors messages into SQLite. Session history/search behavior is adjusted to remove dependence on `session_messages` content.

**Tech Stack:** Electron 33, React 19, TypeScript 5.7, Zustand 5, SQLite (metadata only), OpenCode SDK/API

---

## Scope and Non-Goals

- In scope:
  - No new message rows written to `session_messages`.
  - Session transcript loads from OpenCode data source.
  - Cross-client continuation support (Hive <-> OpenCode CLI) for sessions created in Hive.
  - Session history preview/search adapted to non-SQLite transcript storage.
- Out of scope for this migration:
  - Full removal of SQLite `sessions` table.
  - Full import/discovery of arbitrary sessions created only outside Hive.
  - Dropping `session_messages` table in same PR (defer to cleanup phase).

---

### Task 1: Add OpenCode transcript adapter and tests

**Files:**

- Create: `src/renderer/src/lib/opencode-transcript.ts`
- Create: `test/phase-12/session-1/opencode-transcript.test.ts`
- Modify: `src/renderer/src/lib/token-utils.ts` (only if normalization helpers are needed)

**Step 1: Write failing adapter tests**

Write tests for mapping OpenCode `session.messages` payloads (message `info` + `parts`) into renderer `OpenCodeMessage` shape:

- Preserves `id`, `role`, timestamp, and text content.
- Maps parts (`text`, `tool`, `subtask`, `step-start`, `step-finish`, `reasoning`, `compaction`) to `StreamingPart[]`.
- Handles missing/partial fields without throwing.
- Produces deterministic ordering by message ID/time.

**Step 2: Run test to verify failure**

Run: `pnpm vitest run test/phase-12/session-1/opencode-transcript.test.ts`
Expected: FAIL because adapter does not exist yet.

**Step 3: Implement minimal adapter**

Implement pure functions in `opencode-transcript.ts`:

- `mapOpencodeMessagesToSessionViewMessages(...)`
- `extractTextContentFromParts(...)`
- `mapOpencodePartToStreamingPart(...)`

Use strict runtime guards to avoid renderer crashes from malformed payloads.

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run test/phase-12/session-1/opencode-transcript.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/renderer/src/lib/opencode-transcript.ts test/phase-12/session-1/opencode-transcript.test.ts
git commit -m "feat: add OpenCode transcript adapter for renderer message hydration"
```

---

### Task 2: Switch SessionView transcript reads to OpenCode source

**Files:**

- Modify: `src/renderer/src/components/sessions/SessionView.tsx`
- Modify: `test/session-8/session-view.test.tsx`

**Step 1: Write failing SessionView tests**

Add/adjust tests to assert:

- Initial transcript hydration calls `window.opencodeOps.getMessages(...)` when `worktreePath` and `opencode_session_id` are available.
- Stream finalization refreshes transcript from OpenCode source, not `window.db.message.getBySession(...)`.
- Retry path reloads via OpenCode source.

**Step 2: Run test to verify failure**

Run: `pnpm vitest run test/session-8/session-view.test.tsx`
Expected: FAIL because SessionView still uses DB messages.

**Step 3: Implement read-path migration in SessionView**

Refactor `loadMessagesFromDatabase` into a source-agnostic loader that:

- Preferentially fetches transcript from `window.opencodeOps.getMessages(worktreePath, opencodeSessionId)`.
- Maps payload via `opencode-transcript.ts` adapter.
- Falls back to legacy SQLite reads only when OpenCode fetch is impossible for legacy sessions.
- Keeps token/cost reconstruction from canonical OpenCode message info.

Ensure `finalizeResponseFromDatabase` equivalent now performs OpenCode refresh.

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run test/session-8/session-view.test.tsx`
Expected: PASS with updated mocks.

**Step 5: Commit**

```bash
git add src/renderer/src/components/sessions/SessionView.tsx test/session-8/session-view.test.tsx
git commit -m "refactor: hydrate SessionView transcript from OpenCode canonical messages"
```

---

### Task 3: Remove renderer-side message writes to SQLite

**Files:**

- Modify: `src/renderer/src/components/sessions/SessionView.tsx`
- Modify: `test/session-8/session-view.test.tsx`

**Step 1: Write failing tests for no DB transcript writes**

Add tests verifying `window.db.message.create` is not called in:

- Normal send flow.
- Pending initial message flow.
- No-OpenCode placeholder flow (replace DB write with local temporary UI-only message).

**Step 2: Run tests to verify failure**

Run: `pnpm vitest run test/session-8/session-view.test.tsx`
Expected: FAIL while old DB writes still exist.

**Step 3: Implement minimal write-path migration**

Update send flows to:

- Append optimistic local user message directly to component state.
- Send prompt/command to OpenCode.
- On idle/finalization, canonicalize by reloading full transcript from OpenCode.

Do not create assistant/user rows in `window.db.message`.

**Step 4: Run tests to verify pass**

Run: `pnpm vitest run test/session-8/session-view.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/renderer/src/components/sessions/SessionView.tsx test/session-8/session-view.test.tsx
git commit -m "refactor: remove SessionView SQLite message writes in favor of OpenCode transcript"
```

---

### Task 4: Stop main-process stream persistence into SQLite

**Files:**

- Modify: `src/main/services/opencode-service.ts`
- Modify: `test/phase-8/session-1/message-echo-fix.test.ts`
- Modify: `test/phase-5/session-9/opencode-routing.test.ts`

**Step 1: Write failing service tests**

Add/update tests to enforce:

- `handleEvent` continues forwarding `opencode:stream` events.
- No database transcript upsert/get methods are called for `message.part.updated` / `message.updated`.
- Session title/worktree metadata updates still function.

**Step 2: Run tests to verify failure**

Run:

`pnpm vitest run test/phase-8/session-1/message-echo-fix.test.ts test/phase-5/session-9/opencode-routing.test.ts`

Expected: FAIL until persistence logic is removed.

**Step 3: Remove persistence path**

In `opencode-service.ts`:

- Remove `persistStreamEvent(...)` and related DB message upsert code.
- Remove `lastPromptBySession` usage that existed only for DB echo filtering.
- Keep event routing, status forwarding, question/permission flow, session title updates, and branch rename behavior.

**Step 4: Run tests to verify pass**

Run:

`pnpm vitest run test/phase-8/session-1/message-echo-fix.test.ts test/phase-5/session-9/opencode-routing.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/main/services/opencode-service.ts test/phase-8/session-1/message-echo-fix.test.ts test/phase-5/session-9/opencode-routing.test.ts
git commit -m "refactor: stop mirroring OpenCode stream messages into SQLite"
```

---

### Task 5: Update Session History preview and search semantics

**Files:**

- Modify: `src/renderer/src/components/sessions/SessionHistory.tsx`
- Modify: `src/renderer/src/stores/useSessionHistoryStore.ts`
- Modify: `src/main/db/database.ts`
- Modify: `test/session-9/session-history.test.ts`
- Modify: `test/session-3/database.test.ts`

**Step 1: Write failing tests**

Add tests to assert:

- Session preview uses OpenCode transcript fetch when possible.
- Session keyword search no longer depends on `session_messages` SQL content.
- DB search still filters correctly by project/worktree/date/archive.

**Step 2: Run tests to verify failure**

Run:

`pnpm vitest run test/session-9/session-history.test.ts test/session-3/database.test.ts`

Expected: FAIL with old query/preview behavior.

**Step 3: Implement history migration**

- Replace preview `window.db.message.getBySession(...)` with OpenCode-backed preview (first N messages) using session/worktree/opencode IDs.
- Adjust `searchSessions` SQL in `database.ts` to remove `EXISTS (SELECT ... FROM session_messages ...)` dependency.
- Clarify UX copy: keyword search matches session metadata/title only.

**Step 4: Run tests to verify pass**

Run:

`pnpm vitest run test/session-9/session-history.test.ts test/session-3/database.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/renderer/src/components/sessions/SessionHistory.tsx src/renderer/src/stores/useSessionHistoryStore.ts src/main/db/database.ts test/session-9/session-history.test.ts test/session-3/database.test.ts
git commit -m "refactor: move session history preview/search off SQLite message content"
```

---

### Task 6: Remove `db.message` IPC/preload API surface

**Files:**

- Modify: `src/main/ipc/database-handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: renderer/tests that still reference `window.db.message`

**Step 1: Write failing type/tests pass**

Run a targeted type/lint pass first to capture all references:

Run: `pnpm lint`
Expected: Failures identifying `window.db.message` references.

**Step 2: Remove API endpoints and fix call sites**

- Remove `db:message:create|getBySession|delete` handlers.
- Remove `db.message` namespace from preload runtime and types.
- Replace remaining references with OpenCode transcript utilities or local UI-only state.

**Step 3: Run lint/tests**

Run:

- `pnpm lint`
- `pnpm vitest run test/session-8/session-view.test.tsx test/session-9/session-history.test.ts`

Expected: PASS.

**Step 4: Commit**

```bash
git add src/main/ipc/database-handlers.ts src/preload/index.ts src/preload/index.d.ts test/session-8/session-view.test.tsx test/session-9/session-history.test.ts
git commit -m "refactor: remove db.message IPC and preload surface"
```

---

### Task 7: Keep DB schema backward-compatible in this rollout

**Files:**

- Modify: `src/main/db/schema.ts` (optional note/migration marker only)
- Modify: docs if needed

**Step 1: Do not drop `session_messages` yet**

Keep schema unchanged for now to avoid destructive migration during behavior cutover.

**Step 2: Add explicit deferred cleanup note**

Document that table/index drop is deferred to a follow-up migration after burn-in.

**Step 3: Commit (if code/docs changed)**

```bash
git add src/main/db/schema.ts docs/plans/2026-02-11-opencode-transcript-migration.md
git commit -m "docs: defer session_messages table drop until post-migration stabilization"
```

---

### Task 8: End-to-end verification for cross-client continuation

**Step 1: Run full verification suite**

Run:

- `pnpm lint`
- `pnpm test`

Expected: PASS.

**Step 2: Manual scenario validation (required)**

1. In Hive, create a session in a worktree and send prompt A.
2. In native OpenCode terminal (same worktree), continue same session (`--session <id>`) and send prompt B.
3. Return to Hive and verify prompt B + assistant reply appear after transcript refresh (session switch or app focus).
4. In Hive, send prompt C and verify OpenCode terminal can continue with C context.
5. Validate one tool-heavy response and one plan-mode response.

**Step 3: Acceptance criteria**

- No new rows appear in `session_messages` for new traffic.
- Hive and OpenCode show same canonical transcript for the same `opencode_session_id`.
- Session title updates, unread badges, question/permission prompts continue working.
- No regressions in session tab behavior, drafts, or mode toggling.

**Step 4: Final commit**

```bash
git add .
git commit -m "feat: migrate Hive transcript source of truth to OpenCode storage"
```

---

## Rollout Notes

- Ship as one migration branch with clear QA checklist.
- Keep SQLite `session_messages` table for one stabilization cycle.
- If rollback is needed, restore old SessionView DB load path and main stream persistence path.

## Follow-Up (separate PR)

- Drop `session_messages` table and message-related indexes from schema/migrations.
- Remove message-related DB types and methods from `src/main/db/types.ts` and `src/main/db/database.ts`.
- Remove remaining legacy fallback logic.
