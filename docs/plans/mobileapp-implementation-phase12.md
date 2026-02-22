# Phase 12 — Shared Logic Port (Sessions 114–120)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 12 ports all 13 Zustand stores from the Hive desktop app to the React Native mobile app. Each store's `window.*` IPC calls are replaced with GraphQL transport calls via the `HiveTransport` abstraction created in Phase 11. The business logic (state management, derived data, actions) remains identical.

At the end of this phase, all stores are functional in the mobile app — the same data flows and state management patterns from the desktop app work over GraphQL.

## Prerequisites

- Phase 11 completed: React Native app scaffolded with Apollo Client, codegen, and transport abstraction.
- `HiveTransport` interface defined and `GraphQLTransport` implementation created.
- All GraphQL operations defined in `src/graphql/operations/` for codegen.
- Familiarity with the desktop store implementations.

## Key Source Files (Read-Only Reference — Desktop Repo)

| File | Purpose | Lines |
|------|---------|-------|
| `src/renderer/src/stores/useProjectStore.ts` | Project CRUD, selection, ordering | ~200 |
| `src/renderer/src/stores/useWorktreeStore.ts` | Worktree CRUD, selection, ordering | ~200 |
| `src/renderer/src/stores/useSessionStore.ts` | Session management, tabs, model, streaming | ~1200 |
| `src/renderer/src/stores/useWorktreeStatusStore.ts` | Session status badges per worktree | ~100 |
| `src/renderer/src/stores/useContextStore.ts` | Token usage tracking | ~50 |
| `src/renderer/src/stores/usePermissionStore.ts` | Pending permission queue | ~80 |
| `src/renderer/src/stores/useQuestionStore.ts` | Pending question queue | ~80 |
| `src/renderer/src/stores/useGitStore.ts` | Git file statuses, branch info | ~150 |
| `src/renderer/src/stores/useFileTreeStore.ts` | File tree data | ~100 |
| `src/renderer/src/stores/useFileViewerStore.ts` | Open file/diff tabs | ~100 |
| `src/renderer/src/stores/useSettingsStore.ts` | User preferences | ~80 |
| `src/renderer/src/stores/useConnectionStore.ts` | Multi-worktree connections | ~150 |
| `src/renderer/src/stores/useSpaceStore.ts` | Spaces management | ~100 |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` | Stream event handler | ~200 |
| `src/preload/index.d.ts` | Window API type definitions | 1134 |

## Architecture Notes

### Transport Injection Pattern

Desktop stores call `window.db.project.getAll()`. Mobile stores call `transport.db.project.getAll()`. The transport is injected at store creation time:

```typescript
// Desktop (unchanged):
const projects = await window.db.project.getAll()

// Mobile (via transport):
const transport = getTransport() // Global singleton
const projects = await transport.db.project.getAll()
```

### Store Porting Strategy

For each store:
1. Copy the desktop store file to the mobile `src/stores/` directory
2. Replace all `window.*` calls with `transport.*` calls
3. Remove any Electron-specific imports (ipcRenderer, etc.)
4. Remove desktop-only features (shortcuts, window focus events)
5. Keep all state shape, derived data, and business logic identical
6. Test the store with mock transport

### snake_case → camelCase Mapping

Desktop DB entities use `snake_case` (e.g., `project_id`, `last_accessed_at`). GraphQL uses `camelCase`. The GraphQL transport implementation handles this mapping:

```typescript
// In graphql-transport.ts
async getAll(): Promise<Project[]> {
  const { data } = await client.query({ query: PROJECTS_QUERY })
  // GraphQL returns camelCase, but stores expect snake_case
  return data.projects.map(p => ({
    ...p,
    custom_icon: p.customIcon,
    setup_script: p.setupScript,
    run_script: p.runScript,
    archive_script: p.archiveScript,
    auto_assign_port: p.autoAssignPort,
    sort_order: p.sortOrder,
    created_at: p.createdAt,
    last_accessed_at: p.lastAccessedAt,
  }))
}
```

### Desktop Store Reference Table

| Store | Window API Used | Transport Namespace | Key Methods |
|-------|----------------|--------------------| ------------|
| useProjectStore | `window.db.project.*` | `transport.db.project` | getAll, create, update, delete, touch, reorder |
| useWorktreeStore | `window.db.worktree.*`, `window.worktreeOps.*` | `transport.db.worktree`, `transport.worktreeOps` | getByProject, create, delete, archive, duplicate, rename |
| useSessionStore | `window.db.session.*`, `window.opencodeOps.*` | `transport.db.session`, `transport.opencodeOps` | create, update, connect, prompt, abort, setModel |
| useGitStore | `window.gitOps.*` | `transport.gitOps` | getFileStatuses, stage, unstage, commit, push, diff |
| useFileTreeStore | `window.fileTreeOps.*` | `transport.fileTreeOps` | scan, scanFlat, loadChildren, watch |
| useFileViewerStore | `window.fileOps.*`, `window.gitOps.*` | `transport.fileOps`, `transport.gitOps` | read, write, diff |
| useSettingsStore | `window.db.setting.*`, `window.settingsOps.*` | `transport.db.setting`, `transport.settingsOps` | get, set, getAll |
| useConnectionStore | `window.db.connection.*` | `transport.db.connection` | getAll, create, delete, addMember |
| useSpaceStore | `window.db.space.*` | `transport.db.space` | getAll, create, update, delete, assign |

---

## Session 114: Port Project Store

**Goal:** Port `useProjectStore` to use GraphQL transport.

**Definition of Done:** `useProjectStore` works in the mobile app with GraphQL transport. Projects load, create, update, delete.

**Source reference:** `src/renderer/src/stores/useProjectStore.ts`

**Tasks:**

1. `[app]` Copy `useProjectStore.ts` to `src/stores/useProjectStore.ts`.

2. `[app]` Replace all `window.db.project.*` calls with `transport.db.project.*`:
   ```typescript
   // Before (desktop):
   const projects = await window.db.project.getAll()

   // After (mobile):
   const transport = getTransport()
   const projects = await transport.db.project.getAll()
   ```

3. `[app]` Replace `window.projectOps.*` calls with `transport.projectOps.*`:
   - `validatePath` → `transport.projectOps.validate`
   - `isGitRepository` → `transport.projectOps.isGitRepository`
   - `detectLanguage` → `transport.projectOps.detectLanguage`

4. `[app]` Remove desktop-only features:
   - `window.systemOps.openInEditor` (replaced by navigation)
   - `window.systemOps.showItemInFolder` (not available on mobile)

5. `[app]` Handle `snake_case` ↔ `camelCase` mapping in the transport layer (not in the store).

6. `[app]` Verify store actions work with mock transport in a simple test.

**Verification:**
```bash
pnpm tsc --noEmit
```

---

## Session 115: Port Worktree Store

**Goal:** Port `useWorktreeStore` to use GraphQL transport.

**Definition of Done:** `useWorktreeStore` works in the mobile app. Worktrees load, create, archive, duplicate.

**Source reference:** `src/renderer/src/stores/useWorktreeStore.ts`

**Tasks:**

1. `[app]` Copy and adapt `useWorktreeStore.ts`:

2. `[app]` Replace `window.db.worktree.*` calls:
   - `getByProject` → `transport.db.worktree.getByProject`
   - `getActiveByProject` → `transport.db.worktree.getActiveByProject`
   - `update` → `transport.db.worktree.update`
   - `archive` → `transport.db.worktree.archive`
   - `touch` → `transport.db.worktree.touch`

3. `[app]` Replace `window.worktreeOps.*` calls:
   - `create` → `transport.worktreeOps.create`
   - `delete` → `transport.worktreeOps.delete`
   - `sync` → `transport.worktreeOps.sync`
   - `duplicate` → `transport.worktreeOps.duplicate`
   - `renameBranch` → `transport.worktreeOps.renameBranch`
   - `createFromBranch` → `transport.worktreeOps.createFromBranch`

4. `[app]` Remove desktop-only:
   - `openInTerminal`, `openInEditor` (desktop launchers)

**Verification:**
```bash
pnpm tsc --noEmit
```

---

## Session 116: Port Session Store

**Goal:** Port `useSessionStore` (~1200 lines) to use GraphQL transport.

**Definition of Done:** `useSessionStore` works in the mobile app. Session creation, tabs, model selection, streaming state all work.

**Source reference:** `src/renderer/src/stores/useSessionStore.ts`

**Tasks:**

1. `[app]` This is the most complex store to port (~1200 lines). Break it down:

   **Phase A — Session CRUD:**
   - Replace `window.db.session.*` with `transport.db.session.*`
   - `create`, `update`, `delete`, `getByWorktree`, `getActiveByWorktree`, `getByProject`

   **Phase B — OpenCode operations:**
   - Replace `window.opencodeOps.*` with `transport.opencodeOps.*`
   - `connect`, `reconnect`, `disconnect`, `prompt`, `abort`
   - `setModel`, `undo`, `redo`, `command`
   - `messages`, `sessionInfo`, `models`, `modelInfo`
   - `permissionReply`, `questionReply`, `questionReject`
   - `planApprove`, `planReject`
   - `fork`, `renameSession`
   - `commands`, `capabilities`, `permissionList`

   **Phase C — Session tab management:**
   - Keep all tab logic (active tab, tab ordering, tab switching) unchanged
   - These are pure client-side state, no IPC calls

   **Phase D — Model selection:**
   - Replace `window.opencodeOps.listModels` → `transport.opencodeOps.listModels`
   - Replace `window.opencodeOps.setModel` → `transport.opencodeOps.setModel`
   - Keep model selection UI state unchanged

   **Phase E — Streaming state:**
   - Keep streaming state (isStreaming, tokens, etc.) unchanged
   - These are driven by subscription events (handled in Session 120)

2. `[app]` Handle `agent_sdk` enum mapping:
   - Desktop DB: `'claude-code'` (hyphen)
   - GraphQL: `claude_code` (underscore)
   - Map in transport layer

3. `[app]` Remove desktop-only features:
   - `window.systemOps.openInApp` references
   - Electron notification hooks

**Verification:**
```bash
pnpm tsc --noEmit
```

---

## Session 117: Port Status Stores

**Goal:** Port `useWorktreeStatusStore` and `useContextStore`.

**Definition of Done:** Status badges update correctly. Token usage tracking works.

**Source references:**
- `src/renderer/src/stores/useWorktreeStatusStore.ts`
- `src/renderer/src/stores/useContextStore.ts`

**Tasks:**

1. `[app]` Port `useWorktreeStatusStore`:
   - This store derives worktree status badges from session states
   - Mostly client-side state derived from other stores
   - Minimal IPC calls — mainly listens to stream events

2. `[app]` Port `useContextStore`:
   - Tracks token usage per session
   - Updated by stream events (no direct IPC calls)
   - Pure client-side state

3. `[app]` Both stores should port with minimal changes — they primarily consume events rather than making IPC calls.

**Verification:**
```bash
pnpm tsc --noEmit
```

---

## Session 118: Port Permission & Question Stores

**Goal:** Port `usePermissionStore` and `useQuestionStore`.

**Definition of Done:** Permission and question modals can be triggered by stream events and responses sent back.

**Source references:**
- `src/renderer/src/stores/usePermissionStore.ts`
- `src/renderer/src/stores/useQuestionStore.ts`

**Tasks:**

1. `[app]` Port `usePermissionStore`:
   - Maintains a queue of pending permission requests
   - `add(request)` — called when stream event indicates permission needed
   - `remove(requestId)` — called after user responds
   - Replace `window.opencodeOps.permissionReply` → `transport.opencodeOps.permissionReply`

2. `[app]` Port `useQuestionStore`:
   - Maintains a queue of pending questions from the AI
   - `add(question)` — called when stream event indicates question
   - `remove(requestId)` — called after user responds
   - Replace `window.opencodeOps.questionReply` → `transport.opencodeOps.questionReply`
   - Replace `window.opencodeOps.questionReject` → `transport.opencodeOps.questionReject`

3. `[app]` Both stores are small (~80 lines each) and mostly manage UI state.

**Verification:**
```bash
pnpm tsc --noEmit
```

---

## Session 119: Port Remaining Stores

**Goal:** Port all remaining stores: Git, FileTree, FileViewer, Settings, Connection, Space.

**Definition of Done:** All 6 remaining stores work with GraphQL transport.

**Tasks:**

1. `[app]` Port `useGitStore`:
   - Replace `window.gitOps.*` with `transport.gitOps.*`
   - Key methods: `getFileStatuses`, `getDiff`, `getDiffStat`, `getBranchInfo`, `getBranches`
   - Staging: `stageFile`, `unstageFile`, `stageAll`, `unstageAll`
   - Actions: `commit`, `push`, `pull`, `merge`
   - Watching: `watchWorktree`, `unwatchWorktree`, `watchBranch`, `unwatchBranch`

2. `[app]` Port `useFileTreeStore`:
   - Replace `window.fileTreeOps.*` with `transport.fileTreeOps.*`
   - `scan`, `scanFlat`, `loadChildren`
   - `watch`, `unwatch`

3. `[app]` Port `useFileViewerStore`:
   - Replace `window.fileOps.read` → `transport.fileOps.read`
   - Replace `window.fileOps.write` → `transport.fileOps.write`
   - Replace `window.gitOps.getFileContent` → `transport.gitOps.getFileContent`
   - Replace `window.gitOps.getRefContent` → `transport.gitOps.getRefContent`
   - Replace `window.gitOps.getDiff` → `transport.gitOps.getDiff`

4. `[app]` Port `useSettingsStore`:
   - Replace `window.db.setting.*` → `transport.db.setting.*`
   - Replace `window.settingsOps.*` → `transport.settingsOps.*`
   - `detectedEditors`, `detectedTerminals` may not be relevant on mobile (skip or stub)

5. `[app]` Port `useConnectionStore`:
   - Replace `window.db.connection.*` → `transport.db.connection.*`
   - `getAll`, `create`, `delete`, `addMember`, `removeMember`, `rename`
   - Remove desktop-only: `openInTerminal`, `openInEditor`

6. `[app]` Port `useSpaceStore`:
   - Replace `window.db.space.*` → `transport.db.space.*`
   - `getAll`, `create`, `update`, `delete`, `assignProject`, `removeProject`, `reorder`

**Verification:**
```bash
pnpm tsc --noEmit
```

---

## Session 120: Extract Stream Event Handler

**Goal:** Extract the stream event handling logic from `useOpenCodeGlobalListener` into a shared pure function usable by both desktop and mobile.

**Definition of Done:** `handleStreamEvent()` function processes all stream event types and updates the appropriate stores.

**Source reference:** `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` (~200 lines)

**Tasks:**

1. `[app]` Study `useOpenCodeGlobalListener.ts` — it handles these event types:
   - `message.created` — new assistant message
   - `message.updated` — streaming token update
   - `message.completed` — assistant message done
   - `session.completed` — entire session completed
   - `session.error` — session error
   - `tool.start` — tool invocation started
   - `tool.result` — tool invocation completed
   - `permission.requested` — permission needed
   - `question.asked` — AI asking a question
   - `plan.ready` — plan ready for approval
   - `context.updated` — token usage update
   - `status.connecting`, `status.reconnecting`, `status.ready` — connection status

2. `[app]` Create `src/lib/stream-event-handler.ts`:
   ```typescript
   import type { OpenCodeStreamEvent } from '../types'
   import { useSessionStore } from '../stores/useSessionStore'
   import { useWorktreeStatusStore } from '../stores/useWorktreeStatusStore'
   import { usePermissionStore } from '../stores/usePermissionStore'
   import { useQuestionStore } from '../stores/useQuestionStore'
   import { useContextStore } from '../stores/useContextStore'

   export function handleStreamEvent(event: OpenCodeStreamEvent) {
     const { type, sessionId, data, childSessionId, statusPayload } = event

     switch (type) {
       case 'message.created':
         useSessionStore.getState().handleMessageCreated(sessionId, data)
         break
       case 'message.updated':
         useSessionStore.getState().handleMessageUpdated(sessionId, data)
         break
       case 'message.completed':
         useSessionStore.getState().handleMessageCompleted(sessionId, data)
         break
       case 'session.completed':
         useSessionStore.getState().handleSessionCompleted(sessionId, data)
         useWorktreeStatusStore.getState().update(sessionId, 'completed')
         break
       case 'session.error':
         useSessionStore.getState().handleSessionError(sessionId, data)
         useWorktreeStatusStore.getState().update(sessionId, 'error')
         break
       case 'permission.requested':
         usePermissionStore.getState().add(data)
         useWorktreeStatusStore.getState().update(sessionId, 'permission')
         break
       case 'question.asked':
         useQuestionStore.getState().add(data)
         useWorktreeStatusStore.getState().update(sessionId, 'question')
         break
       case 'plan.ready':
         useSessionStore.getState().handlePlanReady(sessionId, data)
         useWorktreeStatusStore.getState().update(sessionId, 'plan_ready')
         break
       case 'context.updated':
         useContextStore.getState().update(sessionId, data)
         break
       // ... handle all remaining event types
     }
   }
   ```

3. `[app]` Create a React hook that subscribes to `opencodeStream` and feeds events to the handler:
   ```typescript
   // src/hooks/useStreamSubscription.ts
   import { useSubscription, gql } from '@apollo/client'
   import { handleStreamEvent } from '../lib/stream-event-handler'

   const OPENCODE_STREAM = gql`
     subscription OpencodeStream($sessionIds: [String!]) {
       opencodeStream(sessionIds: $sessionIds) {
         type
         sessionId
         data
         childSessionId
         statusPayload {
           type attempt message next
         }
       }
     }
   `

   export function useStreamSubscription(sessionIds?: string[]) {
     useSubscription(OPENCODE_STREAM, {
       variables: { sessionIds },
       onData: ({ data }) => {
         if (data.data?.opencodeStream) {
           handleStreamEvent(data.data.opencodeStream)
         }
       }
     })
   }
   ```

4. `[app]` **Desktop side** (future, in Hive Electron repo): Replace the IPC-based listener with:
   ```typescript
   // In useOpenCodeGlobalListener.ts
   ipcRenderer.on('opencode:stream', (_event, data) => {
     handleStreamEvent(data) // Same function, IPC transport
   })
   ```

**Verification:**
```bash
pnpm tsc --noEmit
```

---

## Summary of Files Created

```
src/stores/
  useProjectStore.ts                — Ported from desktop
  useWorktreeStore.ts               — Ported from desktop
  useSessionStore.ts                — Ported from desktop (~1200 lines)
  useWorktreeStatusStore.ts         — Ported from desktop
  useContextStore.ts                — Ported from desktop
  usePermissionStore.ts             — Ported from desktop
  useQuestionStore.ts               — Ported from desktop
  useGitStore.ts                    — Ported from desktop
  useFileTreeStore.ts               — Ported from desktop
  useFileViewerStore.ts             — Ported from desktop
  useSettingsStore.ts               — Ported from desktop
  useConnectionStore.ts             — Ported from desktop
  useSpaceStore.ts                  — Ported from desktop

src/lib/
  stream-event-handler.ts           — Extracted from useOpenCodeGlobalListener

src/hooks/
  useStreamSubscription.ts          — Apollo subscription → handleStreamEvent

src/graphql/operations/
  (multiple files)                  — All GraphQL operations for codegen
```

## What Comes Next

Phase 13 (Mobile Core Screens, Sessions 121-130) builds the essential screens: project browser, worktree detail, AI session view with streaming, permission/question/plan modals, and model selector.
