# Markdown Kanban RPC Rebase

**Date:** 2026-06-12
**Status:** Draft for implementation planning
**Feature:** Port Markdown Kanban Mode onto the new HTTP/RPC architecture

## Overview

The original Markdown Kanban Mode PR was built against the Electron preload + `src/main/ipc/*` architecture. Upstream has since replaced that layer with a standalone backend/RPC architecture. Renderer code now calls typed API wrappers in `src/renderer/src/api/*`, and Kanban operations are served by `src/server/rpc/domains/kanban.ts`.

Markdown Kanban is still a valid feature, but it must be ported onto the new architecture instead of resolving conflicts by preserving the deleted IPC files. The goal of this rebase is to keep the storage behavior and previous review fixes while aligning all integration points with upstream `main`.

## Goals

- Preserve the Markdown Kanban user feature: opt-in per-project markdown-backed cards with YAML frontmatter and local runtime state.
- Keep the upstream architecture: no resurrection of `src/main/ipc/*` handlers as active code.
- Reuse the implemented Markdown backend logic where it remains valid.
- Rebase renderer identity changes onto the current `kanbanApi` API wrapper model.
- Keep all previous PR review fixes: dependency cleanup, bulk archive behavior, aggregate simple-mode drop behavior, project settings partial-save behavior, and partial Board Assistant batch failures.
- Add the Greptile polish fixes during the port where they naturally fit.

## Non-Goals

- Redesigning the Markdown Kanban file format.
- Reintroducing legacy IPC as a compatibility layer.
- Reworking unrelated upstream architecture changes.
- Migrating populated internal boards to markdown.
- Fixing unrelated upstream type/test failures outside the Markdown Kanban surface.

## Current Upstream Architecture

Upstream `main` has moved Kanban from Electron IPC to RPC:

- Backend domain: `src/server/rpc/domains/kanban.ts`
- Renderer API wrapper: `src/renderer/src/api/kanban-api.ts`
- Renderer consumers import `kanbanApi` instead of using `window.kanban`
- Old handlers under `src/main/ipc/*` are deleted
- Preload is no longer the primary app API surface

The current upstream Kanban RPC service mostly delegates directly to `getDatabase()` methods for internal SQLite tickets. Markdown Kanban should become a storage-routing layer behind this same RPC domain, not a parallel renderer path.

## Porting Approach

Treat upstream `main` as the source of truth and replay the Markdown Kanban feature onto it.

The preferred implementation path is:

1. Start from upstream `main`.
2. Re-add reusable Markdown backend modules:
   - `src/main/services/kanban-backend.ts`
   - `src/main/services/kanban-markdown-paths.ts`
   - `src/main/services/markdown-kanban-watcher.ts`
3. Adapt the backend modules to upstream DB types, schema version, and RPC service calls.
4. Extend `src/server/rpc/domains/kanban.ts` with Markdown-aware service routing and new config/watch/diagnostic methods.
5. Extend `src/renderer/src/api/kanban-api.ts` with the new Kanban config, diagnostics, and watch APIs.
6. Replay renderer store/component changes onto the current `kanbanApi` usage.
7. Port tests from `window.*` IPC mocks to `@/api/*` mocks and server RPC tests.

Do not resolve conflicts by keeping `src/main/ipc/kanban-handlers.ts`, `src/main/ipc/ticket-import-handlers.ts`, or `src/main/ipc/index.ts` as active files.

## Backend Design

Keep the storage-mode router from the original PR, but expose it through the RPC service layer.

Projects support:

- `internal`: existing SQLite `kanban_tickets`
- `markdown`: markdown files plus local SQLite runtime state

The Markdown backend should still own:

- markdown index loading/caching
- YAML frontmatter parsing and validation
- duplicate ID diagnostics
- adoption repair
- single-folder and status-folder layouts
- safe layout migration
- markdown dependency reads/writes
- runtime state in SQLite
- watcher invalidation support

The RPC domain should call a project-mode-aware backend for ticket operations that know or can infer `projectId`.

For methods that currently take only `ticketId`, introduce project-aware RPC params where correctness requires it. Markdown ticket IDs are project-local, so cross-project UI and mutation paths must route by `(projectId, ticketId)`.

Required backend additions to upstream RPC:

- `kanban.config.get(projectId)`
- `kanban.config.update(projectId, markdownConfig)`
- `kanban.config.setMode(projectId, mode)`
- `kanban.config.createFolders(projectId, markdownConfig?)`
- `kanban.config.pickMarkdownFolder()` or an equivalent desktop command routed through the current desktop bridge pattern
- `kanban.diagnostics.get(projectId)`
- `kanban.watch.start(projectId)`
- `kanban.watch.stop(projectId)`

The exact RPC method names can follow the existing `kanban.ticket.*` naming style, but the renderer API should expose them under `kanbanApi.config`, `kanbanApi.diagnostics`, and `kanbanApi.watch`.

## Schema And Types

Upstream `main` is currently at schema version `34`. The Markdown Kanban port should add the next schema migration rather than reuse the old version number from the PR.

Add project columns:

- `projects.kanban_storage_mode TEXT NOT NULL DEFAULT 'internal'`
- `projects.kanban_markdown_config TEXT DEFAULT NULL`

Add runtime table:

```sql
CREATE TABLE IF NOT EXISTS markdown_kanban_card_state (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  current_session_id TEXT DEFAULT NULL REFERENCES sessions(id) ON DELETE SET NULL,
  worktree_id TEXT DEFAULT NULL REFERENCES worktrees(id) ON DELETE SET NULL,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  pending_launch_config TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, card_id)
);
```

Add indexes for session and worktree lookups:

- `(current_session_id)`
- `(worktree_id)`
- `(project_id, card_id)`

Extend DB types with:

- `KanbanStorageMode = 'internal' | 'markdown'`
- `KanbanMarkdownConfig`
- `MarkdownCardDiagnostic`

Keep `MarkdownCardDiagnostic.blocking` as literal `true`, matching the original implemented contract.

## RPC API Shape

Upstream renderer API currently sends internal-style ticket calls such as:

```ts
kanbanApi.ticket.update(id, data)
kanbanApi.ticket.delete(id)
kanbanApi.dependency.removeAll(ticketId)
```

Markdown mode requires routing information. Prefer adding project-aware signatures in the renderer API wrapper while keeping call sites explicit:

```ts
kanbanApi.ticket.update(projectId, ticketId, data)
kanbanApi.ticket.delete(projectId, ticketId)
kanbanApi.ticket.archive(projectId, ticketId)
kanbanApi.ticket.unarchive(projectId, ticketId)
kanbanApi.ticket.move(projectId, ticketId, column, sortOrder)
kanbanApi.ticket.reorder(projectId, ticketId, sortOrder)
kanbanApi.ticket.addTokens(projectId, ticketId, tokens)
kanbanApi.dependency.add(projectId, dependentId, blockerId)
kanbanApi.dependency.remove(projectId, dependentId, blockerId)
kanbanApi.dependency.removeAll(projectId, ticketId)
```

Project-level APIs stay naturally project-scoped:

```ts
kanbanApi.ticket.getByProject(projectId, includeArchived)
kanbanApi.ticket.archiveAllDone(projectId)
kanbanApi.dependency.getForProject(projectId)
kanbanApi.board.importTickets(projectId, tickets, dependencies)
kanbanApi.board.export(projectId, projectName)
```

Worktree/session keyed APIs can keep their natural handles, but the backend must resolve affected markdown projects through runtime state and indexes:

```ts
kanbanApi.ticket.getBySession(sessionId)
kanbanApi.ticket.detachWorktree(worktreeId)
kanbanApi.ticket.syncPR(worktreeId, prNumber, prUrl)
kanbanApi.ticket.clearPR(worktreeId)
```

The RPC domain should validate project/payload consistency when a payload includes both a route `projectId` and a body `project_id`.

## Renderer Store And Identity

Replay the original renderer identity changes onto upstream `useKanbanStore`, but replace `window.kanban` with `kanbanApi`.

Required store concepts:

- `TicketRef { projectId: string; ticketId: string }`
- `ticketKey(projectId, ticketId)` helper
- `selectedTicketRef`
- legacy `setSelectedTicketId(null)` only for clearing selection
- project-scoped drag data
- `draggingTicketKey`
- project-scoped dependency map keys
- markdown diagnostics and placeholders keyed by project

Pinned and connection boards must resolve cards by `(project_id, id)`, not bare `id`.

The aggregate simple-mode drop fix must be preserved:

- in connection or pinned boards, read the In Progress toggle from the aggregate column `projectId` key when present
- fall back to the dragged card project ID only when the aggregate key has no value

## Project Settings UX

Replay the Markdown Kanban Settings UI onto upstream `ProjectSettingsDialog`.

The dialog should expose:

- storage mode toggle: Internal / Markdown
- layout toggle: one folder / status folders
- folder path inputs
- native folder picker buttons
- missing-folder recovery state
- explicit “Create folder and enable” action

The save flow must preserve the latest review fix:

1. Save non-Kanban project fields first with `updateProject`.
2. If project save fails, stop and show the existing project save error.
3. Then save Markdown config and mode through `kanbanApi.config`.
4. If Kanban config/mode fails, keep the dialog open and show the Kanban error.
5. Only close the dialog after both project settings and Kanban settings succeed.

Folder creation should not show a premature success toast. If folder creation succeeds but mode save fails, the user should see the mode/config error and remain in the dialog.

## Watcher Design

Keep the original watcher behavior, but expose watcher lifecycle through RPC/domain methods rather than preload IPC.

Watcher behavior:

- internal-mode projects no-op
- one watcher set per markdown project
- reference-counted start/stop
- serialized lifecycle operations per project
- debounced file events
- self-write suppression for Hive-initiated writes
- visible board scopes start watchers for the relevant projects

Renderer hook:

- keep `useMarkdownKanbanWatcher`
- update it to call `kanbanApi.watch.start/stop`
- keep existing cleanup semantics for single-project, connection, and pinned boards

## Board Assistant And Import Behavior

Replay the partial batch creation fix onto upstream `useBoardChatStore` and `BoardAssistantView`, using `kanbanApi.ticket.createBatch`.

When creating drafts across multiple projects:

- group drafts by project
- run per-project batch creation with `Promise.allSettled`
- mark successful project drafts as created before surfacing failures
- reload tickets/dependencies only for successful projects
- leave failed project drafts uncreated so retry cannot duplicate successful tickets
- keep dependency filtering project-local

Board import should preserve the internal backend behavior:

- update or create selected tickets
- clear only selected-to-selected old dependencies before adding imported dependencies
- preserve dependencies involving unselected tickets unless explicitly replaced by selected-to-selected import data
- in markdown mode, update/move files when imported columns change

## Dependency And Delete Semantics

Preserve previous review fixes:

- internal delete removes dependency rows before deleting the ticket after ownership is verified
- markdown delete removes references from other markdown files before unlinking the deleted card
- markdown archive-all-done archives all done cards in bulk and removes dependency edges involving archived cards in one pass
- markdown import clears only selected-to-selected dependencies
- `removeAllDependencies` can remain broad for archive/delete semantics

Dependency operations must be routed by project for markdown. Internal dependency storage is still bare-ID SQLite, but ownership checks must happen before mutation.

## Greptile Polish Fixes

Fold these into the port:

- Layout migration from single-folder to status-folders must fail with a clear error if any candidate markdown file cannot be parsed or has invalid frontmatter. Do not silently leave invalid files behind in the old folder after switching layouts.
- `detachWorktree` should invalidate only markdown indexes for projects affected by the detached worktree, not clear all markdown indexes.
- `handleCreateKanbanFolders` should not show a standalone success toast before the subsequent save/mode-change succeeds.

## Testing Strategy

Port existing Markdown Kanban tests to the new architecture:

- markdown diagnostics/cache tests
- markdown watcher service tests
- markdown watcher hook tests
- markdown adoption repair tests
- duplicate card identity tests
- internal dependency routing tests
- board import dependency tests
- preload declaration tests should be replaced or reduced if preload no longer exposes the relevant surface

Add or update RPC/API tests:

- `src/server/rpc/domains/kanban` validates project-scoped ticket params
- `kanbanApi` wrapper sends the new method names and payload shapes
- config get/update/setMode/createFolders routes through RPC
- diagnostics and watcher methods no-op for internal projects and work for markdown projects

Update renderer tests:

- Project Settings saves non-Kanban settings even when Kanban mode change fails
- folder picker stores project-relative and external absolute paths
- create-folder flow retries save without premature success
- aggregate simple-mode drop behavior in pinned/connection boards
- partial Board Assistant create failures mark successful projects and retry only failed drafts

Targeted verification after the port:

```bash
pnpm exec vitest run \
  src/server/rpc/domains/__tests__/kanban-rpc.mock-provider.test.ts \
  src/renderer/src/api/__tests__/kanban-api.test.ts \
  src/renderer/src/components/projects/ProjectSettingsDialog.test.tsx \
  test/kanban/board-assistant-create-navigation.test.tsx \
  test/kanban/duplicate-card-identity.test.tsx \
  test/kanban/internal-dependency-routing.test.ts \
  test/kanban/markdown-diagnostics-cache.test.ts \
  test/kanban/markdown-kanban-watcher.test.ts \
  test/kanban/markdown-kanban-watcher-hook.test.tsx \
  test/kanban/markdown-adoption-repair.test.ts
```

Then run the broader Kanban suite affected by the rebase.

## Acceptance Criteria

- The branch no longer contains active old IPC Kanban handlers.
- Markdown Kanban config/mode APIs work through the new RPC/API layer.
- Internal-mode projects behave the same as upstream `main`.
- Markdown-mode projects load cards from configured markdown folders and write mutations back to markdown files.
- Runtime-only state stays local in SQLite.
- Duplicate IDs and invalid markdown files surface as diagnostics/placeholders.
- Connection and pinned boards use project-scoped card identity.
- Previous reviewer fixes remain covered by tests.
- The feature builds and runs against upstream `main` without merge conflict markers.

## Implementation Notes

- Prefer a fresh branch from `main` and replay the feature in coherent commits rather than resolving the old merge conflict directly.
- Keep the old PR implementation available as a reference, especially `kanban-backend.ts`, `kanban-markdown-paths.ts`, `markdown-kanban-watcher.ts`, and the markdown regression tests.
- Resolve `pnpm-lock.yaml` last after `package.json` is finalized.
- Do not spend time adapting obsolete preload declaration tests unless the new desktop bridge still exposes a relevant method.
