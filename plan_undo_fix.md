# Plan: Fix Undo/Rewind to Use SDK Session Forking

## Problem

Hive's undo system treats the conversation as a flat list and destructively truncates both in-memory messages and the on-disk JSONL transcript. The official Claude Code client uses an **append-only JSONL** with a **`parentUuid` tree structure** and the SDK's **`forkSession`** option to branch conversations after undo. Hive's approach causes conversation management to "completely break" after undo because it fights the SDK's data model.

## Root Cause

Hive does three things the SDK doesn't expect:

1. **Truncates the JSONL** (`truncateJsonlTranscript`) -- deletes the undo target and everything after it
2. **Splices in-memory messages** -- destroys the forward history
3. **Uses `resumeSessionAt`** instead of `forkSession: true` -- tries to manually control replay boundaries instead of letting the SDK fork the conversation tree

The SDK expects: `rewindFiles()` restores files, then `forkSession: true` on the next `query()` creates a new conversation branch. The original JSONL stays untouched.

## Reference

- SDK docs: https://platform.claude.com/docs/en/agent-sdk/sessions#forking-sessions
- SDK docs: https://platform.claude.com/docs/en/agent-sdk/file-checkpointing
- Evidence: Comparing 1.jsonl / 2.jsonl / 3.jsonl from official Claude Code client shows append-only behavior with `parentUuid` branching

---

## Tasks

### Task 1: Remove JSONL Truncation

**File:** `src/main/services/claude-code-implementer.ts`

**What:** Remove all code that rewrites/truncates the JSONL transcript file.

**Changes:**

- Delete the entire `truncateJsonlTranscript()` method (lines 1844-1922)
- Remove the `pendingJsonlTruncateUuid` field from `ClaudeSessionState` (line 97)
- Remove the deferred truncation block in `prompt()` that calls `truncateJsonlTranscript` (lines 375-387)
- Remove `session.pendingJsonlTruncateUuid = targetUuid` from `undo()` (line 1138)
- Remove the `import { readFile, writeFile }` if no longer needed (check other usages first)

**Why:** The JSONL is the SDK's data store. It uses a `parentUuid` tree internally. Truncating it destroys the tree and corrupts the SDK's state. The official client never modifies the JSONL -- it's append-only.

---

### Task 2: Use `forkSession: true` Instead of `resumeSessionAt`

**File:** `src/main/services/claude-code-implementer.ts`

**What:** After an undo, the next `prompt()` should use `forkSession: true` instead of `resumeSessionAt`.

**Changes in `undo()` (around lines 1109-1131):**

- Remove `session.resumeSessionAt = previousCheckpointUuid` (line 1122)
- Remove the `resumeSessionAt` field from `ClaudeSessionState` entirely
- Add a new field: `pendingFork: boolean` (default `false`) to `ClaudeSessionState`
- In `undo()`, set `session.pendingFork = true`
- For the "undoing very first prompt" case (lines 1123-1131): still de-materialize (set `materialized = false`), which already causes a fresh session on next prompt. Set `pendingFork = false` in this case since there's nothing to fork from.

**Changes in `prompt()` (around lines 348-398):**

- Remove the `resumeSessionAt` option handling (lines 369-373, 397-398)
- Add: if `session.pendingFork` is truthy AND `session.materialized`:
  ```typescript
  options.forkSession = true
  ```
- After `sdk.query()` is called, clear the flag: `session.pendingFork = false`

**Why:** `forkSession: true` tells the SDK to create a new conversation branch from the resume point. The SDK returns a **new session ID** in the init message, and the `parentUuid` tree is handled automatically. This is the official mechanism for undo-then-continue.

---

### Task 3: Capture the New Session ID After Fork

**File:** `src/main/services/claude-code-implementer.ts`

**What:** When `forkSession: true` is used, the SDK returns a new session ID. Hive must capture it.

**Changes:**

- The existing materialization block (lines 435-471) already captures `sdkMessage.session_id` and updates `session.claudeSessionId`, the DB, the sessions map, and notifies the renderer. However, it only triggers when `session.claudeSessionId.startsWith('pending::')`.
- Extend this block: also trigger when the session ID from the SDK **differs** from the current `session.claudeSessionId`. This handles the fork case where we already have a materialized session but the SDK gives us a new one.
- The condition should become:
  ```typescript
  if (
    sdkSessionId &&
    (session.claudeSessionId.startsWith('pending::') || sdkSessionId !== session.claudeSessionId)
  ) {
    // existing materialization logic...
  }
  ```
- When triggered from a fork (not a `pending::` prefix), also reset `session.checkpoints` to a new empty Map and `session.checkpointCounter` to 0, since the new fork starts with its own checkpoint space.

**Why:** A forked session gets a new session ID and a new JSONL file. Without updating the ID, all subsequent operations (resume, undo, reconnect) would reference the old session.

---

### Task 4: Stop Destroying In-Memory Messages on Undo

**File:** `src/main/services/claude-code-implementer.ts`

**What:** Don't splice `session.messages` or delete checkpoints during undo.

**Changes in `undo()` (lines 1083-1107):**

- Remove the `session.messages.splice(revertIdx)` block (lines 1089-1098)
- Remove the checkpoint deletion loop (lines 1103-1107)
- Instead, store the revert boundary so the next `prompt()` knows not to hydrate stale messages:
  - Keep `session.revertMessageID` and `session.revertCheckpointUuid` (already set)
  - On the next `prompt()`, when `session.pendingFork` is true, clear `session.messages` entirely before starting the fork. The fork creates a new session, so messages will be rebuilt from the new JSONL as the SDK streams them.

**Changes in `prompt()` (around lines 306-314):**

- When `session.pendingFork` is true, skip the transcript hydration step and clear messages:
  ```typescript
  if (session.pendingFork) {
    session.messages = []
  } else if (session.messages.length === 0) {
    // existing hydration logic
  }
  ```

**Why:** The splicing destroys conversation history that the SDK still expects to exist in the JSONL. After a fork, the new session starts fresh anyway, so we just need to clear messages when the fork actually happens, not during undo.

---

### Task 5: Clean Up `rewindWithResumedQuery`

**File:** `src/main/services/claude-code-implementer.ts`

**What:** Remove the junk-cleanup comments and simplify now that we don't truncate.

**Changes:**

- Update the JSDoc on `rewindWithResumedQuery()` (lines 1924-1933) to remove references to junk entries and `truncateJsonlTranscript`
- The method itself remains correct -- it resumes with `prompt: ''` to get a `rewindFiles` handle. This is the documented pattern from the SDK docs.

---

### Task 6: Clear Revert UI State on New Prompt

**File:** `src/main/services/claude-code-implementer.ts`

**What:** Ensure the revert boundary state is cleared when a new prompt starts after undo.

**Changes in `prompt()` (find where revert state is cleared, or add it):**

- After the fork flag is consumed, clear all revert state:
  ```typescript
  session.revertMessageID = null
  session.revertCheckpointUuid = null
  session.revertDiff = null
  ```
- Check if this already happens (search for where these are cleared in prompt). If it does, verify it happens before the query starts.

**Why:** Once the user sends a new prompt after undo, the revert banner should disappear. The fork creates a clean branch.

---

### Task 7: Update Renderer to Handle Fork Transition

**File:** `src/renderer/src/components/sessions/SessionView.tsx`

**What:** The renderer needs to handle the session ID change from a fork and clear revert state.

**Changes:**

- The `session.materialized` event handler already exists and updates the renderer's `opencodeSessionId` state. Verify it works for the fork case (session ID change on an already-materialized session).
- When a new prompt is sent while `revertMessageID` is set (line ~2252 area), clear `revertMessageID`, `revertDiffRef`, and `revertedUserCount`. Check if this already happens -- the exploration found that on new prompt send, these are cleared.
- The `visibleMessages` memo and `revertedUserCount` memo should continue to work as-is since they're driven by `revertMessageID` state.

**Likely no changes needed here** -- verify by testing. The existing materialization handler and prompt-send cleanup should cover the fork case.

---

### Task 8: Update Tests

**File:** `test/phase-21/session-8/claude-undo-redo.test.ts`

**What:** Rewrite tests to match the new behavior.

**Tests to modify:**

- `"truncates in-memory messages at the revert boundary"` (line 1090) -- should verify messages are NOT truncated during undo
- `"progressive undo removes messages incrementally"` (line 1131) -- should verify messages remain intact
- `"getMessages returns only the rewound conversation after undo"` (line 1162) -- behavior changes
- `"undo sets pendingJsonlTruncateUuid instead of truncating immediately"` (line 1181) -- remove/replace with `pendingFork` test
- `"deferred truncation runs at next prompt and cleans JSONL"` (line 1197) -- remove entirely
- `"deferred truncation removes empty text blocks from JSONL"` (line 1268) -- remove entirely
- `"JSONL truncation does not break when file is missing"` (line 1336) -- remove entirely
- `"deferred truncation preserves non-message entries"` (line 1348) -- remove entirely
- `"de-materialized session (undo first prompt) sets pending truncation"` (line 1411) -- update to check `pendingFork = false` instead of truncation
- `"sets resumeSessionAt to PREVIOUS checkpoint UUID"` (line 819) -- replace with test that sets `pendingFork = true`
- `"de-materializes session when undoing the only prompt"` (line 901) -- update to verify `pendingFork = false` and `materialized = false`

**Tests to add:**

- `"undo sets pendingFork = true for next prompt"` -- verify the flag is set
- `"prompt() passes forkSession: true when pendingFork is set"` -- verify SDK options
- `"prompt() clears pendingFork after query starts"` -- verify one-shot behavior
- `"prompt() clears session.messages when pendingFork is true"` -- verify fresh start
- `"captures new session ID after fork"` -- verify materialization handles ID change
- `"does not truncate JSONL on undo"` -- verify no file writes
- `"does not splice in-memory messages on undo"` -- verify messages array untouched
- `"undo preserves checkpoints for old branch"` -- verify checkpoints not deleted

---

### Task 9: Remove Dead Code and State Fields

**File:** `src/main/services/claude-code-implementer.ts`

**What:** Clean up state fields that are no longer needed.

**Remove from `ClaudeSessionState`:**

- `pendingJsonlTruncateUuid` -- no longer used (JSONL not truncated)
- `resumeSessionAt` -- replaced by `pendingFork`

**Add to `ClaudeSessionState`:**

- `pendingFork: boolean` -- signals next prompt should use `forkSession: true`

**Also remove:**

- Any imports only used by `truncateJsonlTranscript` (check `readFile`, `writeFile` from `fs/promises`)
- The `getJsonlPath` method IF it's only used by `truncateJsonlTranscript` (check -- it may be used elsewhere by transcript reading)

---

## Execution Order

1. **Task 9** (add `pendingFork` field, remove old fields) -- structural change everything else depends on
2. **Task 1** (remove JSONL truncation) -- eliminate destructive behavior
3. **Task 2** (use `forkSession`) -- the core fix
4. **Task 3** (capture new session ID) -- required for fork to work
5. **Task 4** (stop destroying messages) -- complete the non-destructive undo
6. **Task 5** (clean up comments) -- minor cleanup
7. **Task 6** (clear revert state on prompt) -- UI consistency
8. **Task 7** (verify renderer) -- likely no changes needed
9. **Task 8** (update tests) -- validate everything works

## Risk Assessment

- **Medium risk:** The `forkSession` option may behave slightly differently than expected (e.g., how it interacts with `resume`, whether checkpoints carry over). Need to test with the actual SDK.
- **Low risk:** The "undo first prompt" de-materialization path is already separate and doesn't need forking (it starts a fresh session).
- **Unknown:** Whether `getJsonlPath` is used elsewhere -- need to verify before deleting.
- **Unknown:** Whether the renderer's stale-boundary cleanup effect (lines 2774-2783) will fire incorrectly when messages change during fork transition. May need a brief suppress during the transition.
