# OpenCode Undo/Redo Design Notes

This document captures how OpenCode implements undo/redo, and what is required to build an equivalent system in another wrapper (for example, a Claude Code wrapper).

It focuses on behavior and architecture, not code.

## 1) Core Model

OpenCode undo/redo is not a classic editor stack. It is a **session-level revert boundary + filesystem snapshot system**.

- Undo sets a session `revert` boundary and rewinds files changed by reverted turns.
- Redo either:
  - moves the boundary forward (incremental redo), or
  - clears the boundary and restores full state (full redo).
- Reverted messages are first **hidden**, not immediately deleted.
- Physical deletion of reverted history happens later via cleanup.

## 2) Main Data Concepts

### Session revert state

Session metadata includes a `revert` object with:

- `messageID`: current revert boundary (messages at/after this are considered reverted)
- `partID` (optional): boundary inside a message
- `snapshot` (optional): baseline snapshot hash used for restore/unrevert
- `diff` (optional): current textual diff after revert for UI display

### Message parts used by undo/redo

Assistant turns record file-change evidence in parts:

- `step-start` / `step-finish` parts carry snapshot markers
- `patch` parts carry `{ hash, files[] }` for changed files during the turn

Undo logic relies on these `patch` parts to know what file paths to rewind.

## 3) Snapshot Subsystem (What It Does)

OpenCode uses a project-scoped internal git store (separate from user repo history) as a snapshot engine.

### Snapshot responsibilities

- **track()**: capture current workspace state and return snapshot hash
- **patch(fromHash)**: list files changed since `fromHash`
- **revert(patches)**: rewind listed files to old versions from patch hashes
- **restore(snapshotHash)**: restore tracked files to exact snapshot state
- **diff(hash)** / **diffFull(from,to)**: produce UI/session diffs
- **cleanup()**: periodic gc/prune of snapshot store

### Important behavior details

- Snapshot data is per project and worktree-aware.
- `revert()` deduplicates files across patches.
- If file checkout fails and file did not exist in snapshot tree, file is deleted.
- Empty directories are not explicitly removed by revert.
- `restore()` restores tracked content to snapshot; untracked/new files may remain.

## 4) Undo Flow

## Preconditions

- Session should not be actively generating; abort/cancel first if busy.

## Steps

1. Load session messages and existing `session.revert` state.
2. Determine target boundary message (usually last visible user message before current boundary).
3. Scan message parts from boundary onward and collect all `patch` parts.
4. Ensure baseline snapshot exists:
   - reuse `session.revert.snapshot` if already set,
   - otherwise create one with `track()`.
5. Call snapshot `revert(patches)` to rewind file changes.
6. Compute updated diff (`diff(snapshot)`) and update session revert state.
7. Recompute and publish session diff summary for UI.
8. Return updated session/revert metadata.

## Effect

- Messages at/after `revert.messageID` become logically reverted.
- File system is moved back accordingly.
- UI can hide reverted tail and show a redo banner.

## 5) Redo Flow

OpenCode behavior is effectively two modes:

### A) Incremental redo

- Find next user message after current boundary.
- Reapply `revert()` using that next user message as new boundary.
- This moves boundary forward one user turn range.

### B) Full redo (restore all reverted messages)

- If there is no next user message after boundary:
  - call `unrevert()`
  - restore baseline snapshot via `restore(session.revert.snapshot)`
  - clear `session.revert`

## 6) Deferred Cleanup (Critical Design)

Undo does not immediately delete reverted messages.

There is a cleanup phase that permanently removes reverted history from storage:

- delete messages from boundary onward,
- if `partID` boundary exists, trim parts in boundary message,
- clear `session.revert` after removal.

Cleanup is run before operations that continue the conversation timeline (for example, sending a new prompt/command/shell or compaction).

This design gives users a redo window while still allowing hard commit to new history once they proceed.

## 7) UI/State Requirements for Your Wrapper

To match OpenCode semantics, the client should:

- hydrate revert state on reconnect/session load
- filter rendered transcript by boundary (hide reverted tail)
- show count of reverted user messages
- expose redo affordance (`/redo` or button)
- clear stale boundary if boundary message no longer exists
- restore previous prompt text on undo (quality-of-life behavior)

## 8) Main Functions You Need (No Code)

At minimum, your wrapper should define these behaviors:

- **getSessionInfo(sessionId)**
  - Returns `revertMessageID`, `revertDiff`, and related revert metadata.

- **undo(sessionId)**
  - Ensures idle/aborted state.
  - Chooses target user message before current boundary.
  - Calls server-side/session revert logic.
  - Returns updated boundary and optional restored prompt/diff.

- **redo(sessionId)**
  - If boundary exists and next user message exists, move boundary forward via revert.
  - Else call unrevert and clear boundary.

- **revert(sessionId, messageId, partId?)** (server/core)
  - Builds revert state, rewinds filesystem via patches, computes diff, updates summary.

- **unrevert(sessionId)** (server/core)
  - Restores snapshot baseline and clears revert state.

- **cleanupRevertedHistory(sessionId)** (server/core)
  - Permanently removes reverted messages/parts and clears revert marker.

- **snapshot.track / patch / revert / restore / diff / diffFull / cleanup**
  - Filesystem state engine backing undo/redo correctness.

## 9) Event and Sync Expectations

Undo/redo changes should propagate through normal session/message update events so all clients stay consistent.

At minimum, publish updates for:

- session updated (revert metadata changed)
- session diff updated (if diff summary changes)
- message removed / part removed (during cleanup)

## 10) Edge Cases to Handle

- Undo while session is busy (abort first)
- No undo target available (return "nothing to undo")
- No redo target and no revert state (return "nothing to redo")
- Missing boundary message in current transcript (clear stale boundary)
- Patch checkout failure for files that did not exist in snapshot (delete them)
- Worktree-scoped behavior in multi-worktree setups

## 11) Minimal Implementation Checklist

- Add revert state to session model.
- Add snapshot subsystem with project/worktree scoping.
- Emit per-turn patch metadata.
- Implement revert/unrevert/cleanup server functions.
- Wire undo/redo endpoints or IPC methods.
- Update UI to hide reverted tail and support redo.
- Run cleanup before creating new timeline content.

---

If you follow the above model, you will reproduce OpenCode's behavior closely: reversible message/file rollback with a temporary redo window, then durable history cleanup once the user continues.
