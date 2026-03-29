# Hive Kanban Board Implementation Plan

This document outlines the implementation plan for the Kanban Board View, covering database schema, IPC handlers, renderer stores, board UI components, drag-and-drop, session coordination, and ticket attachment integration.

**Methodology:** Use **TDD (Test-Driven Development)** for all sessions. Write failing tests first, then implement until tests pass. Use the **superpowers subagent development skill** (`/subagent`) to implement each session, passing this document as context. For any session involving UI work (S5, S6, S7, S8, S9, S11, S12, S13), use the **frontend design skill** (`/frontend-design`) to ensure high design quality and avoid generic AI aesthetics.

---

## Overview

The implementation is divided into **14 focused sessions**, each with:

- Clear objectives and task list
- Definition of done (checklist)
- Automated test cases (Vitest unit/integration tests)
- Manual test cases for visual/interaction verification

**Refer to:** [`PRD_kanban-board.md`](PRD_kanban-board.md) for full product requirements and design decisions.

---

## Dependencies & Parallelization

```
Session 1  (DB Schema & Migration)                    -- no deps
Session 2  (DB CRUD Methods & Types)                   -- blocked by S1
Session 3  (IPC Handlers & Preload Bridge)             -- blocked by S2
Session 4  (Kanban Store)                              -- blocked by S3
Session 5  (Header Toggle & MainPane & Cmd Palette)    -- blocked by S4
Session 6  (Board + Column + Card Components)          -- blocked by S4
Session 7  (Ticket Creation Modal)                     -- blocked by S6
Session 8  (Drag-and-Drop System)                      -- blocked by S6
Session 9  (Worktree Picker Modal)                     -- blocked by S8
Session 10 (Session ↔ Kanban Store Coordination)       -- blocked by S4
Session 11 (Ticket Modal: Multi-Mode Views)            -- blocked by S6, S10
Session 12 (Simple Board Mode)                         -- blocked by S8
Session 13 (Ticket Attachment in Normal View)           -- blocked by S4
Session 14 (End-to-End Integration & Verification)     -- blocked by S1–S13
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Time →                                                                          │
│                                                                                  │
│  [S1: DB Schema] ──► [S2: DB CRUD] ──► [S3: IPC + Preload] ──► [S4: Store]     │
│                                                                     │            │
│                                                        ┌────────────┼──────────┐ │
│                                                        ▼            ▼          ▼ │
│                                                   [S5: Header    [S6: Board  [S10: Session  │
│                                                    Toggle]        Components] Coordination] │
│                                                        │        ┌───┴───┐      │ │
│                                                        │        ▼       ▼      │ │
│                                                        │   [S7: Create [S8: Drag│ │
│                                                        │    Modal]     & Drop]  │ │
│                                                        │               │        │ │
│                                                        │         ┌─────┼────┐   │ │
│                                                        │         ▼     ▼    │   │ │
│                                                        │    [S9: WT  [S12:  │   │ │
│                                                        │     Picker] Simple]│   │ │
│                                                        │                    ▼   │ │
│                                                        │              [S11: Ticket│
│                                                        │               Modal]    │ │
│                                                        │                         │ │
│                               [S13: Ticket Attachment] ◄─── (needs S4 only)     │ │
│                                                                                  │ │
│                                          [S14: E2E Integration & Verification]   │ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: After S4 completes, S5 + S6 + S10 + S13 can all run in parallel.

**Recommended serial order**: S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12 → S13 → S14

---

## Testing Infrastructure

### Test File Structure

```
test/
├── kanban/
│   ├── session-1/
│   │   └── kanban-schema.test.ts
│   ├── session-2/
│   │   └── kanban-crud.test.ts
│   ├── session-3/
│   │   └── kanban-handlers.test.ts
│   ├── session-4/
│   │   └── kanban-store.test.ts
│   ├── session-5/
│   │   └── kanban-view-toggle.test.tsx
│   ├── session-6/
│   │   └── kanban-board-components.test.tsx
│   ├── session-7/
│   │   └── ticket-creation-modal.test.tsx
│   ├── session-8/
│   │   └── kanban-drag-drop.test.tsx
│   ├── session-9/
│   │   └── worktree-picker-modal.test.tsx
│   ├── session-10/
│   │   └── session-kanban-coordination.test.ts
│   ├── session-11/
│   │   └── ticket-modal-modes.test.tsx
│   ├── session-12/
│   │   └── simple-board-mode.test.tsx
│   ├── session-13/
│   │   └── ticket-attachment.test.tsx
│   └── session-14/
│       └── kanban-e2e.test.tsx
```

### New Dependencies

```bash
# No new dependencies -- all features use existing packages:
# - better-sqlite3 (database -- already installed)
# - zustand (stores -- already installed)
# - lucide-react (icons -- already installed)
# - sonner (toasts -- already installed)
# - @testing-library/react (component tests -- already installed)
# - vitest (unit tests -- already installed)
# - shadcn/ui Dialog, Button, Input, Textarea (UI -- already installed)
```

---

## Session 1: Database Schema & Migration

### Objectives

- Create the `kanban_tickets` table via migration v11
- Add `kanban_simple_mode` column to the `projects` table
- Add appropriate indexes for fast lookups

### Tasks

1. **Bump `CURRENT_SCHEMA_VERSION` to `11`** in `src/main/db/schema.ts`

2. **Add migration v11** to the `MIGRATIONS` array with the `kanban_tickets` table:
   - `id` TEXT PRIMARY KEY
   - `project_id` TEXT NOT NULL, FK to `projects(id)` ON DELETE CASCADE
   - `title` TEXT NOT NULL
   - `description` TEXT (nullable, markdown)
   - `attachments` TEXT NOT NULL DEFAULT `'[]'` (JSON array)
   - `column` TEXT NOT NULL DEFAULT `'todo'` (one of: `todo`, `in_progress`, `review`, `done`)
   - `sort_order` REAL NOT NULL DEFAULT `0` (fractional for O(1) insertions)
   - `current_session_id` TEXT, FK to `sessions(id)` ON DELETE SET NULL
   - `worktree_id` TEXT, FK to `worktrees(id)` ON DELETE SET NULL
   - `mode` TEXT (nullable, `'build'` or `'plan'`)
   - `plan_ready` INTEGER NOT NULL DEFAULT `0`
   - `created_at` TEXT NOT NULL
   - `updated_at` TEXT NOT NULL

3. **Add `kanban_simple_mode` column** to `projects` table via `safeAddColumn()`:
   - `kanban_simple_mode` INTEGER NOT NULL DEFAULT `0`

4. **Add indexes**:
   - `idx_kanban_tickets_project` on `kanban_tickets(project_id)`
   - `idx_kanban_tickets_session` on `kanban_tickets(current_session_id)`
   - `idx_kanban_tickets_worktree` on `kanban_tickets(worktree_id)`

### Key Files

- `src/main/db/schema.ts` -- migration v11

### Definition of Done

- [ ] `CURRENT_SCHEMA_VERSION` is `11`
- [ ] `kanban_tickets` table is created with all specified columns
- [ ] `projects` table has `kanban_simple_mode` column (default 0)
- [ ] All three indexes exist on `kanban_tickets`
- [ ] FK constraints work: deleting a project cascades to its tickets
- [ ] FK constraints work: deleting a session sets `current_session_id` to NULL
- [ ] FK constraints work: deleting a worktree sets `worktree_id` to NULL
- [ ] Migration applies cleanly on an existing v10 database
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-1/kanban-schema.test.ts
describe('Session 1: Kanban Schema', () => {
  test('kanban_tickets table is created by migration v11')
  test('kanban_tickets has all required columns with correct types')
  test('kanban_tickets.column defaults to "todo"')
  test('kanban_tickets.sort_order defaults to 0')
  test('kanban_tickets.plan_ready defaults to 0')
  test('kanban_tickets.attachments defaults to "[]"')
  test('projects table has kanban_simple_mode column defaulting to 0')
  test('deleting a project cascades to its kanban_tickets')
  test('deleting a session sets current_session_id to NULL on tickets')
  test('deleting a worktree sets worktree_id to NULL on tickets')
  test('indexes exist on project_id, current_session_id, worktree_id')
})
```

### Manual Tests

- None required -- fully testable via automated tests.

---

## Session 2: Database CRUD Methods & Types

### Objectives

- Add TypeScript types for kanban tickets to `types.ts`
- Implement all CRUD methods on `DatabaseService`
- Add row mapping helpers for SQLite boolean/JSON fields

### Tasks

1. **Add types** to `src/main/db/types.ts`:
   - `KanbanTicket` interface (all columns mapped)
   - `KanbanTicketCreate` interface (title required, description/attachments/column optional)
   - `KanbanTicketUpdate` interface (all fields optional via Partial)
   - `KanbanTicketColumn` type: `'todo' | 'in_progress' | 'review' | 'done'`

2. **Add CRUD methods** to `src/main/db/database.ts`:
   - `createKanbanTicket(data: KanbanTicketCreate): KanbanTicket`
   - `getKanbanTicket(id: string): KanbanTicket | null`
   - `getKanbanTicketsByProject(projectId: string): KanbanTicket[]`
   - `updateKanbanTicket(id: string, data: KanbanTicketUpdate): KanbanTicket | null`
   - `deleteKanbanTicket(id: string): boolean`
   - `moveKanbanTicket(id: string, column: KanbanTicketColumn, sortOrder: number): KanbanTicket | null`
   - `reorderKanbanTicket(id: string, sortOrder: number): void`
   - `getKanbanTicketsBySession(sessionId: string): KanbanTicket[]` (for coordination lookups)
   - `updateProjectSimpleMode(projectId: string, enabled: boolean): void`

3. **Add `mapKanbanTicketRow` helper** to convert SQLite row to typed object (handle `plan_ready` int→boolean, parse `attachments` JSON)

4. **Ensure `getKanbanTicketsByProject` returns tickets ordered by `column`, then `sort_order`**

### Key Files

- `src/main/db/types.ts` -- new types
- `src/main/db/database.ts` -- CRUD methods

### Definition of Done

- [ ] All CRUD methods work: create, get, getByProject, update, delete
- [ ] `moveKanbanTicket` updates both `column` and `sort_order` atomically
- [ ] `reorderKanbanTicket` updates only `sort_order`
- [ ] `getKanbanTicketsByProject` returns tickets sorted by column then sort_order
- [ ] `getKanbanTicketsBySession` returns tickets linked to a given session
- [ ] `updateProjectSimpleMode` toggles `kanban_simple_mode` on projects
- [ ] `mapKanbanTicketRow` correctly maps `plan_ready` (int→bool) and `attachments` (string→array)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-2/kanban-crud.test.ts
describe('Session 2: Kanban CRUD', () => {
  test('createKanbanTicket returns ticket with generated id and timestamps')
  test('createKanbanTicket sets defaults: column=todo, sort_order=0, plan_ready=false')
  test('getKanbanTicket returns null for non-existent id')
  test('getKanbanTicket returns mapped ticket with boolean plan_ready and parsed attachments')
  test('getKanbanTicketsByProject returns only tickets for that project')
  test('getKanbanTicketsByProject returns tickets sorted by column then sort_order')
  test('updateKanbanTicket modifies only specified fields')
  test('updateKanbanTicket updates the updated_at timestamp')
  test('deleteKanbanTicket returns true on success, false on non-existent')
  test('moveKanbanTicket updates column and sort_order')
  test('reorderKanbanTicket updates only sort_order')
  test('getKanbanTicketsBySession returns tickets referencing that session')
  test('updateProjectSimpleMode toggles the kanban_simple_mode column')
})
```

### Manual Tests

- None required -- fully testable via automated tests.

---

## Session 3: IPC Handlers & Preload Bridge

### Objectives

- Create IPC handlers for all kanban ticket operations
- Expose kanban API to the renderer via the preload bridge
- Add TypeScript declarations for `window.kanban`

### Tasks

1. **Create `src/main/ipc/kanban-handlers.ts`** with `registerKanbanHandlers()`:
   - `kanban:ticket:create` → `createKanbanTicket(data)`
   - `kanban:ticket:get` → `getKanbanTicket(id)`
   - `kanban:ticket:getByProject` → `getKanbanTicketsByProject(projectId)`
   - `kanban:ticket:update` → `updateKanbanTicket(id, data)`
   - `kanban:ticket:delete` → `deleteKanbanTicket(id)`
   - `kanban:ticket:move` → `moveKanbanTicket(id, column, sortOrder)`
   - `kanban:ticket:reorder` → `reorderKanbanTicket(id, sortOrder)`
   - `kanban:ticket:getBySession` → `getKanbanTicketsBySession(sessionId)`
   - `kanban:simpleMode:toggle` → `updateProjectSimpleMode(projectId, enabled)`

2. **Register in `src/main/ipc/index.ts`**: export `registerKanbanHandlers`

3. **Call `registerKanbanHandlers()`** in the main process initialization

4. **Add preload bridge** in `src/preload/index.ts`:
   ```typescript
   const kanban = {
     ticket: {
       create: (data) => ipcRenderer.invoke('kanban:ticket:create', data),
       get: (id) => ipcRenderer.invoke('kanban:ticket:get', id),
       getByProject: (projectId) => ipcRenderer.invoke('kanban:ticket:getByProject', projectId),
       update: (id, data) => ipcRenderer.invoke('kanban:ticket:update', id, data),
       delete: (id) => ipcRenderer.invoke('kanban:ticket:delete', id),
       move: (id, column, sortOrder) => ipcRenderer.invoke('kanban:ticket:move', id, column, sortOrder),
       reorder: (id, sortOrder) => ipcRenderer.invoke('kanban:ticket:reorder', id, sortOrder),
       getBySession: (sessionId) => ipcRenderer.invoke('kanban:ticket:getBySession', sessionId),
     },
     simpleMode: {
       toggle: (projectId, enabled) => ipcRenderer.invoke('kanban:simpleMode:toggle', projectId, enabled),
     }
   }
   contextBridge.exposeInMainWorld('kanban', kanban)
   ```

5. **Add TypeScript declarations** for `window.kanban` in the shared types / preload declaration file

### Key Files

- `src/main/ipc/kanban-handlers.ts` -- **new file**
- `src/main/ipc/index.ts` -- register export
- `src/preload/index.ts` -- expose to renderer
- Preload type declarations file -- `window.kanban` types

### Definition of Done

- [ ] All 9 IPC channels are registered and respond correctly
- [ ] `registerKanbanHandlers` is exported from `src/main/ipc/index.ts`
- [ ] `registerKanbanHandlers()` is called during app initialization
- [ ] `window.kanban` is exposed in the renderer with typed API
- [ ] TypeScript declarations exist so the renderer can call `window.kanban.*` without type errors
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-3/kanban-handlers.test.ts
describe('Session 3: Kanban IPC Handlers', () => {
  test('kanban:ticket:create calls createKanbanTicket and returns result')
  test('kanban:ticket:get calls getKanbanTicket with correct id')
  test('kanban:ticket:getByProject calls getKanbanTicketsByProject')
  test('kanban:ticket:update calls updateKanbanTicket with id and data')
  test('kanban:ticket:delete calls deleteKanbanTicket')
  test('kanban:ticket:move calls moveKanbanTicket with column and sortOrder')
  test('kanban:ticket:reorder calls reorderKanbanTicket with sortOrder')
  test('kanban:ticket:getBySession calls getKanbanTicketsBySession')
  test('kanban:simpleMode:toggle calls updateProjectSimpleMode')
})
```

### Manual Tests

- None required -- fully testable via automated tests.

---

## Session 4: Kanban Store (Core State Management)

### Objectives

- Create `useKanbanStore` with Zustand (persist middleware)
- Implement ticket CRUD actions that call IPC
- Manage board view active state and simple mode toggle
- Persist UI state (board view active flag) in localStorage

### Tasks

1. **Create `src/renderer/src/stores/useKanbanStore.ts`**:

   **State:**
   - `tickets: Map<string, KanbanTicket[]>` -- keyed by project ID
   - `isLoading: boolean`
   - `isBoardViewActive: boolean` -- persisted
   - `simpleModeByProject: Record<string, boolean>` -- persisted

   **Actions:**
   - `loadTickets(projectId: string): Promise<void>` -- fetch from IPC, populate map
   - `createTicket(projectId: string, data: KanbanTicketCreate): Promise<KanbanTicket>`
   - `updateTicket(ticketId: string, projectId: string, data: KanbanTicketUpdate): Promise<void>`
   - `deleteTicket(ticketId: string, projectId: string): Promise<void>`
   - `moveTicket(ticketId: string, projectId: string, column: KanbanTicketColumn, sortOrder: number): Promise<void>`
   - `reorderTicket(ticketId: string, projectId: string, newSortOrder: number): Promise<void>`
   - `toggleBoardView(): void`
   - `setSimpleMode(projectId: string, enabled: boolean): Promise<void>`
   - `getTicketsForProject(projectId: string): KanbanTicket[]` -- getter
   - `getTicketsByColumn(projectId: string, column: KanbanTicketColumn): KanbanTicket[]` -- getter

   **Helpers:**
   - `computeSortOrder(tickets: KanbanTicket[], targetIndex: number): number` -- calculates fractional sort_order for insertion between adjacent tickets

2. **Add optimistic updates** -- update local state immediately, revert on IPC failure

3. **Persist only UI state** via `partialize`: `isBoardViewActive`, `simpleModeByProject`

### Key Files

- `src/renderer/src/stores/useKanbanStore.ts` -- **new file**

### Definition of Done

- [ ] Store loads tickets per project from IPC
- [ ] Create/update/delete actions call IPC and update local state
- [ ] `moveTicket` updates column and sort_order in local state and IPC
- [ ] `reorderTicket` computes correct fractional sort_order
- [ ] `toggleBoardView` flips the flag and persists to localStorage
- [ ] `setSimpleMode` calls IPC and updates local `simpleModeByProject`
- [ ] `getTicketsForProject` returns tickets sorted by column then sort_order
- [ ] `getTicketsByColumn` filters tickets for a specific column
- [ ] Optimistic updates revert on IPC failure
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-4/kanban-store.test.ts
describe('Session 4: Kanban Store', () => {
  test('loadTickets fetches tickets from IPC and populates map')
  test('createTicket adds ticket to local state and calls IPC')
  test('updateTicket modifies ticket in local state')
  test('deleteTicket removes ticket from local state')
  test('moveTicket updates column and sort_order in local state')
  test('reorderTicket computes fractional sort_order between neighbors')
  test('computeSortOrder: inserting at beginning uses (first.sortOrder - 1)')
  test('computeSortOrder: inserting at end uses (last.sortOrder + 1)')
  test('computeSortOrder: inserting between uses average of neighbors')
  test('toggleBoardView flips isBoardViewActive')
  test('setSimpleMode updates simpleModeByProject for given project')
  test('getTicketsForProject returns tickets sorted by column then sort_order')
  test('getTicketsByColumn filters tickets to a specific column')
  test('optimistic update reverts on IPC failure')
})
```

### Manual Tests

- None required -- fully testable via automated tests.

---

## Session 5: View Integration — Header Toggle, MainPane, Command Palette

> **Design skill:** Use `/frontend-design` for the header toggle button styling and active state indication.

### Objectives

- Add a Kanban toggle button to the Header component
- Wire MainPane to render the board (placeholder) when board view is active
- Register "Open Kanban Board" in the command palette

### Tasks

1. **Add toggle button to `src/renderer/src/components/layout/Header.tsx`**:
   - Import `useKanbanStore` and read `isBoardViewActive`, `toggleBoardView`
   - Add a button (e.g., `LayoutGrid` icon from lucide-react) next to existing header controls
   - Visually indicate active state (e.g., highlighted background when board view is on)
   - Only show when a project is selected

2. **Modify `src/renderer/src/components/layout/MainPane.tsx`**:
   - Import `useKanbanStore` and read `isBoardViewActive`
   - In `renderContent()`, add a check: if `isBoardViewActive` and a project is selected, render a `<KanbanBoard />` placeholder (simple div with "Kanban Board" text for now)
   - This check should come before the session view checks in the priority chain

3. **Register command palette action**:
   - In the command registry, add: `{ id: 'kanban:toggle', label: 'Open Kanban Board', category: 'navigation', keywords: ['kanban', 'board', 'tickets', 'todo'], action: () => toggleBoardView() }`

### Key Files

- `src/renderer/src/components/layout/Header.tsx` -- toggle button
- `src/renderer/src/components/layout/MainPane.tsx` -- view switching
- Command registry file -- new command

### Definition of Done

- [ ] Toggle button appears in the header when a project is selected
- [ ] Clicking the toggle switches `isBoardViewActive` in the store
- [ ] MainPane renders a placeholder when board view is active
- [ ] MainPane renders normal session view when board view is inactive
- [ ] Board view follows the currently selected project (switching projects updates the board)
- [ ] "Open Kanban Board" appears in the command palette and works
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-5/kanban-view-toggle.test.tsx
describe('Session 5: View Toggle', () => {
  test('Header renders kanban toggle button when project is selected')
  test('Header does not render kanban toggle when no project selected')
  test('clicking toggle button calls toggleBoardView')
  test('MainPane renders board placeholder when isBoardViewActive is true')
  test('MainPane renders session view when isBoardViewActive is false')
  test('command palette includes "Open Kanban Board" command')
})
```

### Manual Tests

- [ ] Click the Kanban toggle in the header -- board placeholder appears
- [ ] Click again -- normal sessions view returns
- [ ] Open command palette (Cmd+K), type "kanban" -- command appears, selecting it toggles view
- [ ] Switch to a different project in sidebar -- board updates (shows placeholder for new project)
- [ ] With no project selected -- toggle button is hidden

---

## Session 6: Board Components — KanbanBoard, KanbanColumn, KanbanTicketCard

> **Design skill:** Use `/frontend-design` for the board layout, column styling, card design, pulsing border animations, badge styles, and Done column collapse interaction.

### Objectives

- Build the static board layout with 4 columns
- Render ticket cards with visual states (title, badges, borders)
- Implement column scroll and Done column collapse

### Tasks

1. **Create `src/renderer/src/components/kanban/KanbanBoard.tsx`**:
   - Accepts `projectId` prop
   - Calls `loadTickets(projectId)` on mount and when `projectId` changes
   - Renders 4 `KanbanColumn` components in a horizontal flex layout
   - Each column gets its filtered tickets via `getTicketsByColumn`

2. **Create `src/renderer/src/components/kanban/KanbanColumn.tsx`**:
   - Props: `column: KanbanTicketColumn`, `tickets: KanbanTicket[]`, `projectId: string`
   - Renders column header with title ("To Do", "In Progress", "Review", "Done") and ticket count
   - Done column: collapsible (expand/collapse toggle icon)
   - Each column scrolls independently (`overflow-y: auto`)
   - Renders a list of `KanbanTicketCard` components

3. **Create `src/renderer/src/components/kanban/KanbanTicketCard.tsx`**:
   - Props: `ticket: KanbanTicket`
   - Displays:
     - Title (always)
     - Attachment count badge with paperclip icon (if attachments exist)
     - Worktree name badge (if `worktree_id` is set, lookup worktree name from store)
     - Active indicator: pulsing animated border (blue if `mode === 'build'`, violet if `mode === 'plan'`) when session is active
     - Plan ready: static solid violet border + "Plan ready" badge when `plan_ready === true`
     - Error: red error badge when linked session has `status === 'error'`
   - Click handler (for future: opens ticket modal)
   - `data-testid="kanban-ticket-{id}"` for testing

4. **Replace the placeholder** in MainPane with the real `<KanbanBoard />` component

### Key Files

- `src/renderer/src/components/kanban/KanbanBoard.tsx` -- **new file**
- `src/renderer/src/components/kanban/KanbanColumn.tsx` -- **new file**
- `src/renderer/src/components/kanban/KanbanTicketCard.tsx` -- **new file**
- `src/renderer/src/components/layout/MainPane.tsx` -- swap placeholder

### Definition of Done

- [ ] Board renders 4 columns: To Do, In Progress, Review, Done
- [ ] Each column shows its ticket count in the header
- [ ] Tickets render with title, attachment badge, worktree badge as appropriate
- [ ] Active tickets have pulsing animated border (blue for build, violet for plan)
- [ ] Plan-ready tickets have static solid violet border + "Plan ready" badge
- [ ] Error tickets show red error badge
- [ ] Each column scrolls independently
- [ ] Done column can be collapsed/expanded
- [ ] Board loads tickets when project changes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-6/kanban-board-components.test.tsx
describe('Session 6: Board Components', () => {
  test('KanbanBoard renders 4 columns')
  test('KanbanBoard calls loadTickets on mount')
  test('KanbanColumn renders column header with title and count')
  test('KanbanColumn renders ticket cards for its tickets')
  test('KanbanColumn Done column toggles collapse state')
  test('KanbanTicketCard renders title')
  test('KanbanTicketCard renders attachment badge when attachments exist')
  test('KanbanTicketCard does not render attachment badge when no attachments')
  test('KanbanTicketCard renders worktree name when worktree_id is set')
  test('KanbanTicketCard applies pulsing blue border for active build ticket')
  test('KanbanTicketCard applies pulsing violet border for active plan ticket')
  test('KanbanTicketCard applies static violet border + Plan ready badge when plan_ready')
  test('KanbanTicketCard shows error badge when linked session has error status')
})
```

### Manual Tests

- [ ] Open Kanban view -- 4 columns render with correct headers
- [ ] Create test tickets in DB -- they appear in correct columns
- [ ] Tickets with attachments show paperclip badge with count
- [ ] Tickets assigned to worktrees show worktree name below title
- [ ] Active session tickets have a visible pulsing border animation
- [ ] Done column collapse/expand toggle works visually
- [ ] Columns scroll independently when many tickets

---

## Session 7: Ticket Creation Modal

> **Design skill:** Use `/frontend-design` for the creation modal layout, markdown editor styling, and attachment preview design.

### Objectives

- Add "+" button to the To Do column header
- Build the ticket creation modal with title, markdown description, and attachments
- Wire save to the kanban store

### Tasks

1. **Add "+" button** to `KanbanColumn` when `column === 'todo'`:
   - Lucide `Plus` icon in the column header
   - Clicking opens the creation modal

2. **Create `src/renderer/src/components/kanban/TicketCreateModal.tsx`**:
   - shadcn `Dialog` with controlled open/onOpenChange
   - Fields:
     - Title input (required, auto-focused)
     - Description: markdown editor with live preview (use CodeMirror with markdown language support, or a simple `Textarea` with a preview toggle)
     - Attachments: reuse existing `AttachmentButton` component and attachment preview pattern
   - Footer: Cancel + Create button
   - On create: call `kanbanStore.createTicket()` with `column: 'todo'`, close modal, show success toast

3. **Validation**: Title is required; disable Create button when title is empty

### Key Files

- `src/renderer/src/components/kanban/TicketCreateModal.tsx` -- **new file**
- `src/renderer/src/components/kanban/KanbanColumn.tsx` -- "+" button

### Definition of Done

- [ ] "+" button appears on the To Do column header only
- [ ] Clicking "+" opens the creation modal
- [ ] Title field is required and auto-focused
- [ ] Description has markdown editing with preview
- [ ] Attachments can be added using the existing attachment system
- [ ] Create button is disabled when title is empty
- [ ] Successful creation adds ticket to To Do column and shows toast
- [ ] Modal closes on successful creation
- [ ] Cancel closes without creating
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-7/ticket-creation-modal.test.tsx
describe('Session 7: Ticket Creation Modal', () => {
  test('"+" button renders in To Do column header')
  test('"+" button does not render in other columns')
  test('clicking "+" opens the creation modal')
  test('Create button is disabled when title is empty')
  test('Create button is enabled when title is provided')
  test('submitting calls createTicket with correct data')
  test('modal closes after successful creation')
  test('Cancel button closes modal without creating')
  test('description field accepts markdown text')
  test('attachments can be added and removed')
})
```

### Manual Tests

- [ ] Click "+" on To Do column -- modal opens
- [ ] Type a title and create -- ticket appears in To Do column
- [ ] Try creating with empty title -- button is disabled
- [ ] Add a description with markdown (bold, lists) -- preview renders it
- [ ] Attach a file -- attachment chip appears, can be removed with X
- [ ] Click Cancel -- modal closes, no ticket created

---

## Session 8: Drag-and-Drop System

> **Design skill:** Use `/frontend-design` for drag visual feedback (opacity, drop indicators, column highlights).

### Objectives

- Make ticket cards draggable
- Make columns drop targets
- Implement inter-column moves and intra-column reordering
- Add visual feedback during drag

### Tasks

1. **Make `KanbanTicketCard` draggable**:
   - `draggable={true}`
   - `onDragStart`: set transfer data with `{ ticketId, sourceColumn, sourceIndex }`
   - Visual feedback: reduce opacity while dragging

2. **Make `KanbanColumn` a drop target**:
   - `onDragOver`: prevent default, show drop indicator
   - `onDrop`: read transfer data, determine target position
   - Drop indicator: a horizontal line between cards showing where the ticket will land

3. **Implement drop logic in the store**:
   - Inter-column: call `moveTicket(ticketId, targetColumn, computedSortOrder)`
   - Intra-column: call `reorderTicket(ticketId, computedSortOrder)`
   - Compute sort_order based on drop position between neighbors

4. **Add column-specific drop triggers** (to be wired in later sessions):
   - When dropping on In Progress column and simple mode is off: set a flag to open the worktree picker (S9)
   - When dropping back to To Do from In Progress: set a flag to show stop session confirmation (S11)
   - For now, just move directly for all drops

5. **Visual feedback**:
   - Drag source: reduced opacity
   - Drop target column: subtle highlight
   - Drop position: horizontal line indicator between cards

### Key Files

- `src/renderer/src/components/kanban/KanbanTicketCard.tsx` -- drag source
- `src/renderer/src/components/kanban/KanbanColumn.tsx` -- drop target
- `src/renderer/src/stores/useKanbanStore.ts` -- move/reorder actions

### Definition of Done

- [ ] Ticket cards are draggable
- [ ] Cards can be dropped into any column
- [ ] Cards can be reordered within the same column
- [ ] Sort order is computed correctly (fractional between neighbors)
- [ ] Visual feedback: drag source has reduced opacity
- [ ] Visual feedback: drop target column is highlighted
- [ ] Visual feedback: drop position indicator shows between cards
- [ ] Drag data is correctly transferred (ticketId, sourceColumn)
- [ ] Store `moveTicket` and `reorderTicket` are called on drop
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-8/kanban-drag-drop.test.tsx
describe('Session 8: Drag-and-Drop', () => {
  test('ticket card has draggable=true')
  test('onDragStart sets correct transfer data')
  test('column onDragOver prevents default')
  test('dropping ticket in different column calls moveTicket')
  test('dropping ticket in same column at different position calls reorderTicket')
  test('sort_order is computed as average of neighbors for mid-drop')
  test('sort_order is (first - 1) for drop at beginning')
  test('sort_order is (last + 1) for drop at end')
  test('drag source gets opacity class during drag')
})
```

### Manual Tests

- [ ] Drag a ticket from To Do to In Progress -- it moves
- [ ] Drag a ticket from In Progress to Review -- it moves
- [ ] Drag a ticket within To Do to reorder -- order changes
- [ ] Drag source card becomes semi-transparent during drag
- [ ] Drop position indicator appears between cards
- [ ] Column highlights when dragging over it
- [ ] Refresh the page -- ticket positions persist

---

## Session 9: Worktree Picker Modal

> **Design skill:** Use `/frontend-design` for the worktree picker modal layout, worktree list items with badges, Build/Plan chip, and editable prompt preview area.

### Objectives

- Intercept drag-to-In-Progress to open the worktree picker modal
- Build the modal: worktree list, "New worktree" option, Build/Plan toggle, editable prompt preview
- On send: create worktree if needed, create session, update ticket

### Tasks

1. **Create `src/renderer/src/components/kanban/WorktreePickerModal.tsx`**:
   - Triggered when a ticket is dropped on In Progress (and simple mode is off)
   - Props: `ticket: KanbanTicket`, `projectId: string`, `open: boolean`, `onOpenChange`
   - **Worktree list**: fetch worktrees for the project from `useWorktreeStore`, display each with name, branch, and active ticket count badge (count tickets with that `worktree_id` in `in_progress` column)
   - **"New worktree" option**: at the top of the list, selecting it auto-generates a worktree name and creates immediately using the existing worktree creation service
   - **Input area**: reuse the Build/Plan chip toggle component (same as normal session input), with Tab to toggle
   - **Editable text preview**: a text area pre-filled with the mode-specific default template containing the ticket as an XML block
     - Build: `"Please implement the following ticket.\n\n<ticket title=\"{title}\">{description}</ticket>"`
     - Plan: `"Please review the following ticket and create a detailed implementation plan.\n\n<ticket title=\"{title}\">{description}</ticket>"`
   - Toggling Build/Plan updates the template prefix while preserving any user edits to the XML block
   - **Send button**: disabled until a worktree is selected

2. **Implement send flow**:
   - Create worktree if "New worktree" was selected
   - Create session in the selected worktree with the specified mode (`build` or `plan`)
   - Put the prompt text into the session input
   - Update ticket: `current_session_id`, `worktree_id`, `mode`, `column = 'in_progress'`
   - Close modal

3. **Wire the drag-drop trigger** in `KanbanColumn`:
   - When a ticket is dropped on the In Progress column and `simpleMode` is off, instead of directly moving, open the worktree picker modal with that ticket
   - Pass a callback from the modal to complete the move after send

### Key Files

- `src/renderer/src/components/kanban/WorktreePickerModal.tsx` -- **new file**
- `src/renderer/src/components/kanban/KanbanColumn.tsx` -- trigger on drop

### Definition of Done

- [ ] Dropping a ticket on In Progress (simple mode off) opens the worktree picker modal
- [ ] Modal displays all project worktrees with active ticket count badge
- [ ] "New worktree" option is at the top and auto-generates on selection
- [ ] Build/Plan chip toggle works (Tab to switch)
- [ ] Default prompt text updates when toggling Build/Plan
- [ ] Prompt text is editable
- [ ] Ticket content appears as XML block in the prompt
- [ ] Send button is disabled until a worktree is selected
- [ ] On send: session is created, ticket is updated, modal closes
- [ ] Ticket moves to In Progress with correct `worktree_id`, `current_session_id`, `mode`
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-9/worktree-picker-modal.test.tsx
describe('Session 9: Worktree Picker Modal', () => {
  test('modal renders list of project worktrees')
  test('each worktree shows active ticket count badge')
  test('"New worktree" option appears at top of list')
  test('Build/Plan chip toggle defaults to build')
  test('Tab key toggles between build and plan')
  test('default prompt changes when toggling build/plan')
  test('prompt text area is editable')
  test('ticket content is embedded as XML block in prompt')
  test('Send button is disabled when no worktree selected')
  test('Send button is enabled when worktree is selected')
  test('submitting calls session creation with correct mode')
  test('submitting updates ticket with session_id, worktree_id, mode')
  test('modal closes after successful send')
})
```

### Manual Tests

- [ ] Drag a ticket from To Do to In Progress -- worktree picker opens
- [ ] Worktree list shows all project worktrees with correct badges
- [ ] Select "New worktree" -- a new worktree is created instantly
- [ ] Toggle Build/Plan with Tab -- prompt prefix changes
- [ ] Edit the prompt text -- changes are preserved
- [ ] Click Send -- session starts, ticket moves to In Progress with animated border
- [ ] Jump to the normal view -- the created session is active in the selected worktree

---

## Session 10: Session ↔ Kanban Store Coordination

### Objectives

- Auto-advance tickets to Review when build session completes
- Set `plan_ready` when plan session completes
- Hook into supercharge to re-attach ticket to new session
- Handle session error state on tickets

### Tasks

1. **Add session status subscription** in `useKanbanStore`:
   - Subscribe to `useSessionStore` changes (via store coordination pattern)
   - When a session's status changes to `completed`:
     - Find tickets referencing that session via `current_session_id`
     - If ticket `mode === 'build'`: auto-move to `review` column
     - If ticket `mode === 'plan'`: set `plan_ready = true`, keep in `in_progress`
   - When a session's status changes to `error`:
     - Ticket stays in `in_progress` (no state change needed, card reads session status)

2. **Add store coordination registration** in `src/renderer/src/stores/store-coordination.ts`:
   - Register a callback from kanban store that session store calls when session status changes
   - Pattern: `registerKanbanSessionSync(callback)` to break circular dependency

3. **Hook into supercharge flow**:
   - When the session store's supercharge action creates a new session, it should call the registered kanban callback
   - The kanban store updates the ticket's `current_session_id` to the new session
   - The ticket's `plan_ready` resets to `false`

4. **Add `syncTicketWithSession` action** to the kanban store:
   - Called by the coordination layer when session status changes
   - Handles all the auto-advance and plan_ready logic
   - Also persists changes via IPC

### Key Files

- `src/renderer/src/stores/useKanbanStore.ts` -- session sync logic
- `src/renderer/src/stores/store-coordination.ts` -- registration
- `src/renderer/src/stores/useSessionStore.ts` -- emit coordination events

### Definition of Done

- [ ] When a build session completes, its ticket auto-moves to Review
- [ ] When a plan session completes, its ticket's `plan_ready` flag is set to true
- [ ] Ticket stays in In Progress when `plan_ready` (does not auto-advance)
- [ ] When session errors, ticket stays in In Progress (card shows error via session status)
- [ ] When supercharge creates a new session, ticket's `current_session_id` updates
- [ ] When supercharge happens, `plan_ready` resets to false
- [ ] All state changes persist via IPC (survive app restart)
- [ ] Store coordination breaks circular dependencies correctly
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-10/session-kanban-coordination.test.ts
describe('Session 10: Session ↔ Kanban Coordination', () => {
  test('build session completing moves ticket to review column')
  test('plan session completing sets plan_ready to true')
  test('plan session completing does NOT move ticket to review')
  test('session error does not change ticket column')
  test('supercharge updates ticket current_session_id to new session')
  test('supercharge resets plan_ready to false')
  test('auto-advance persists column change via IPC')
  test('plan_ready change persists via IPC')
  test('tickets with no session are not affected by session changes')
  test('multiple tickets can reference different sessions independently')
})
```

### Manual Tests

- [ ] Start a build session on a ticket -- when session finishes, ticket moves to Review automatically
- [ ] Start a plan session on a ticket -- when plan is ready, ticket shows "Plan ready" badge and stays in In Progress
- [ ] Supercharge a plan from the session view -- ticket's progress indicator resumes (new session tracked)
- [ ] Force a session error -- ticket shows error badge, stays in In Progress
- [ ] Restart the app -- all ticket states are preserved

---

## Session 11: Ticket Modal — Multi-Mode Views

> **Design skill:** Use `/frontend-design` for the multi-mode modal layout, plan review rendering, action button styling, followup input area, error state display, and context menu design.

### Objectives

- Build the ticket modal that adapts based on ticket state and column
- Implement edit mode (any column), plan review mode, review followup mode, error mode
- Wire plan actions (Implement, Handoff, Supercharge)
- Wire review followup (pipe to same session)
- Add "Jump to session" action
- Add backward-drag confirmation

### Tasks

1. **Create `src/renderer/src/components/kanban/KanbanTicketModal.tsx`**:
   - Controlled by the kanban store (selected ticket ID)
   - Adapts its content based on the ticket's state:

   **Edit mode** (To Do, Done, or simple tickets in any column):
   - Same form as creation: title, markdown description, attachments
   - Save button to persist changes
   - Delete button (trash icon)

   **Plan review mode** (In Progress + `plan_ready === true`):
   - Rendered plan markdown content (use same renderer as `ExitPlanModeToolView`)
   - Fetch plan content from the session's pending plan via session store
   - Action buttons at the bottom: **Implement**, **Handoff**, **Supercharge**
   - These call the same actions as `PlanReadyImplementFab` on the ticket's linked session
   - After action, close modal (ticket stays in board, coordination handles state changes)

   **Review mode** (Review column):
   - Display the last assistant message from the linked session
   - Followup input area: text area with Build/Plan chip toggle (Tab to switch)
   - Send followup: pipe message to the same session → move ticket back to In Progress
   - "Move to Done" button

   **Error mode** (In Progress + linked session has `status === 'error'`):
   - Display error info from the session
   - Followup input area for retry/correction
   - Send followup: pipe to same session

2. **Add "Jump to session" button** in the modal header:
   - Visible when ticket has a `current_session_id`
   - On click: set `isBoardViewActive = false`, select the ticket's worktree in sidebar, focus the session tab

3. **Add right-click context menu** to `KanbanTicketCard`:
   - "Delete" option (with confirmation)
   - "Assign to worktree" option (for simple tickets -- opens worktree picker)
   - "Jump to session" option (for flow tickets)

4. **Wire backward-drag confirmation**:
   - In `KanbanColumn` drop handler: if source column is `in_progress` and target is `todo`, and ticket has a `current_session_id`, show a confirmation dialog
   - Dialog: "This ticket has an active session. Stop the session and move to To Do?"
   - On confirm: stop the session (set status to completed), clear ticket's session link, move to To Do

### Key Files

- `src/renderer/src/components/kanban/KanbanTicketModal.tsx` -- **new file**
- `src/renderer/src/components/kanban/KanbanTicketCard.tsx` -- context menu, click handler
- `src/renderer/src/components/kanban/KanbanColumn.tsx` -- backward-drag confirmation

### Definition of Done

- [ ] Tapping a ticket opens the modal
- [ ] Modal shows edit mode for To Do and Done tickets
- [ ] Modal shows plan review mode for In Progress + plan_ready tickets
- [ ] Plan review shows Implement, Handoff, Supercharge buttons
- [ ] Plan actions work identically to PlanReadyImplementFab
- [ ] Modal shows review mode for Review column tickets
- [ ] Review mode shows last AI message and followup input
- [ ] Sending followup pipes to same session and moves ticket to In Progress
- [ ] Modal shows error mode for In Progress + error status
- [ ] "Jump to session" switches to normal view with correct worktree/session
- [ ] Right-click context menu works: delete, assign, jump
- [ ] Backward drag (In Progress → To Do) shows confirmation dialog
- [ ] Confirming backward drag stops session and moves ticket
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-11/ticket-modal-modes.test.tsx
describe('Session 11: Ticket Modal Modes', () => {
  test('edit mode: renders title, description, attachments fields for To Do ticket')
  test('edit mode: save persists changes via updateTicket')
  test('edit mode: delete removes ticket after confirmation')
  test('plan review mode: renders plan content when plan_ready is true')
  test('plan review mode: shows Implement, Handoff, Supercharge buttons')
  test('plan review mode: Implement calls correct session store action')
  test('plan review mode: Supercharge calls correct session store action')
  test('review mode: renders last assistant message for review column ticket')
  test('review mode: followup input has Build/Plan chip toggle')
  test('review mode: sending followup pipes to same session')
  test('review mode: sending followup moves ticket to in_progress')
  test('error mode: renders error info for errored session ticket')
  test('error mode: followup input allows retry')
  test('jump to session: sets isBoardViewActive to false')
  test('jump to session: selects correct worktree and session')
  test('context menu: delete option triggers deleteTicket')
  test('context menu: assign to worktree opens worktree picker for simple tickets')
  test('backward drag confirmation: shows dialog when moving from in_progress to todo')
  test('backward drag confirmation: confirming stops session and moves ticket')
  test('backward drag confirmation: cancelling keeps ticket in in_progress')
})
```

### Manual Tests

- [ ] Click a To Do ticket -- edit modal opens, can change title/description/attachments
- [ ] Click a plan-ready ticket -- plan content renders, action buttons work
- [ ] Click Implement on a plan-ready ticket -- implementation starts
- [ ] Click a Review ticket -- last AI message shows, followup input available
- [ ] Send a followup from Review -- ticket moves to In Progress, session receives message
- [ ] Click "Jump to session" -- switches to normal view with correct session focused
- [ ] Right-click a ticket -- context menu appears with correct options
- [ ] Drag a ticket from In Progress to To Do -- confirmation dialog appears
- [ ] Confirm -- session stops, ticket moves. Cancel -- ticket stays.

---

## Session 12: Simple Board Mode

> **Design skill:** Use `/frontend-design` for the simple mode toggle switch styling and the visual distinction between simple and flow ticket cards.

### Objectives

- Add a toggle switch to the In Progress column header
- Implement simple mode behavior (direct drop, no modal, no automation)
- Visual distinction for simple vs flow tickets
- Right-click "Assign to worktree" conversion

### Tasks

1. **Add toggle to `KanbanColumn` for `in_progress` column**:
   - Small switch/toggle in the column header
   - Label: "Simple" or a bolt icon
   - Reads from `useKanbanStore.simpleModeByProject[projectId]`
   - Calls `setSimpleMode(projectId, enabled)` on toggle

2. **Modify drop handler** in `KanbanColumn`:
   - If `simpleMode` is on AND target column is `in_progress`: skip worktree picker, directly move ticket
   - If `simpleMode` is off: trigger worktree picker as before

3. **Visual distinction for simple tickets**:
   - In `KanbanTicketCard`: if ticket is in `in_progress` and has no `current_session_id` (simple), render as a plain card with no animated border, no worktree badge
   - Flow tickets retain their full visual state

4. **"Assign to worktree" conversion**:
   - Already added in S11 context menu
   - Opening the worktree picker for a simple ticket: on send, the ticket gains `current_session_id`, `worktree_id`, `mode` -- becomes a flow ticket with full visual state

5. **Ensure toggle only affects new drags**:
   - Toggling simple mode on does not alter existing flow tickets in In Progress
   - Toggling simple mode off does not alter existing simple tickets

### Key Files

- `src/renderer/src/components/kanban/KanbanColumn.tsx` -- toggle switch, drop logic
- `src/renderer/src/components/kanban/KanbanTicketCard.tsx` -- visual distinction
- `src/renderer/src/stores/useKanbanStore.ts` -- `setSimpleMode`

### Definition of Done

- [ ] Toggle switch appears on In Progress column header
- [ ] Toggle persists per-project (survives restart)
- [ ] Simple mode ON: dropping to In Progress skips worktree picker
- [ ] Simple mode OFF: dropping to In Progress opens worktree picker
- [ ] Simple tickets render as plain cards (no border animation, no worktree badge)
- [ ] Flow tickets retain full visual state regardless of toggle
- [ ] "Assign to worktree" converts simple ticket to flow ticket
- [ ] Toggling does not alter existing tickets' states
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-12/simple-board-mode.test.tsx
describe('Session 12: Simple Board Mode', () => {
  test('toggle switch renders on In Progress column header')
  test('toggle switch does not render on other columns')
  test('toggle calls setSimpleMode with correct project and value')
  test('simple mode on: drop to In Progress skips worktree picker')
  test('simple mode off: drop to In Progress triggers worktree picker')
  test('simple ticket card has no animated border')
  test('simple ticket card has no worktree badge')
  test('flow ticket retains animated border when simple mode is toggled on')
  test('assign to worktree on simple ticket opens worktree picker')
  test('after assigning worktree, simple ticket becomes flow ticket with session')
})
```

### Manual Tests

- [ ] Toggle simple mode on -- drag a ticket to In Progress -- it drops directly (no modal)
- [ ] Toggle simple mode off -- drag a ticket to In Progress -- worktree picker opens
- [ ] With both simple and flow tickets in In Progress -- visually distinct (one has border, one doesn't)
- [ ] Right-click a simple ticket → "Assign to worktree" -- worktree picker opens, after send ticket gains session
- [ ] Toggle simple mode, then restart app -- toggle state is preserved
- [ ] Toggle while flow tickets exist -- they keep their sessions and visual state

---

## Session 13: Ticket Attachment in Normal View

> **Design skill:** Use `/frontend-design` for the ticket picker modal layout, search/filter UI, ticket chip styling in the attachment tray, and hover tooltip design.

### Objectives

- Add "Board ticket" option to the AttachmentButton
- Build the ticket picker modal (search + column filter)
- Render ticket chips in the attachment tray
- Inject ticket content as XML blocks on send

### Tasks

1. **Add "Board ticket" option** to `AttachmentButton`:
   - New button/menu option alongside existing file attachment options
   - Only visible when a project is selected (tickets are project-scoped)
   - Clicking opens the ticket picker modal

2. **Create `src/renderer/src/components/kanban/TicketPickerModal.tsx`**:
   - Fetches all tickets for the current project
   - **Search input**: filters tickets by title (case-insensitive)
   - **Column status filter chips**: To Do, In Progress, Review, Done (toggleable, multi-select)
   - Each ticket row: title, column badge, attachment count
   - Clicking a ticket adds it to the attachment list and closes the modal (or stays open for multi-select, with a "Done" button)

3. **Create ticket attachment type**:
   - New attachment kind: `{ kind: 'ticket', id: string, ticketId: string, name: string, title: string, description: string, attachments: string }`
   - Rendered as a styled chip in the attachment tray: kanban icon + ticket title
   - Hover shows full ticket content (title + description + attachment list)

4. **Modify message building** in the session input send flow:
   - When building message parts, ticket attachments are injected as XML blocks:
     ```
     <ticket title="Ticket Title">
     Description text here...
     </ticket>
     ```
   - Multiple ticket attachments produce multiple XML blocks
   - Ticket attachments share the 10-attachment limit with file attachments

5. **Ensure no board side-effects**: attaching a ticket does not modify the ticket's state on the board

### Key Files

- `src/renderer/src/components/sessions/AttachmentButton.tsx` -- new option
- `src/renderer/src/components/kanban/TicketPickerModal.tsx` -- **new file**
- `src/renderer/src/components/sessions/AttachmentPreview.tsx` -- ticket chip rendering
- `src/renderer/src/lib/file-attachment-utils.ts` -- ticket attachment kind, message building

### Definition of Done

- [ ] "Board ticket" option appears in attachment button when project is selected
- [ ] "Board ticket" option does not appear when no project is selected
- [ ] Ticket picker modal shows all project tickets
- [ ] Search input filters by title
- [ ] Column filter chips toggle correctly (multi-select)
- [ ] Selecting a ticket adds it as a chip to the attachment tray
- [ ] Ticket chip shows kanban icon + title
- [ ] Hovering ticket chip shows full content
- [ ] Multiple tickets can be attached (within 10-attachment limit)
- [ ] On send, tickets are injected as XML blocks in the message
- [ ] Attaching a ticket does NOT change the ticket's state on the board
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-13/ticket-attachment.test.tsx
describe('Session 13: Ticket Attachment', () => {
  test('"Board ticket" option renders in attachment button when project selected')
  test('"Board ticket" option hidden when no project selected')
  test('ticket picker shows all project tickets')
  test('search input filters tickets by title case-insensitively')
  test('column filter chips toggle correctly')
  test('selecting a ticket adds it to attachment list')
  test('ticket chip renders with kanban icon and title')
  test('multiple tickets can be attached up to 10-attachment limit')
  test('ticket attachment is serialized as XML block in message parts')
  test('ticket XML block includes title and description')
  test('attaching ticket does not modify ticket state in kanban store')
})
```

### Manual Tests

- [ ] In normal sessions view, click attachment icon -- "Board ticket" option visible
- [ ] Click "Board ticket" -- picker modal opens with project tickets
- [ ] Type in search -- list filters by title
- [ ] Click column filter chips -- list filters by column
- [ ] Select a ticket -- chip appears in attachment tray with kanban icon
- [ ] Hover the chip -- full ticket content tooltip shows
- [ ] Send a message with ticket attachment -- AI receives the ticket as XML context
- [ ] Check the kanban board -- the attached ticket's state is unchanged
- [ ] Attach 10 items (mix of files and tickets) -- 11th is rejected

---

## Session 14: End-to-End Integration & Verification

### Objectives

- Verify all 13 sessions work together as a cohesive feature
- Fix any integration issues between modules
- Ensure data consistency across app restarts
- Verify edge cases and error paths

### Tasks

1. **Full lifecycle test**: Create ticket → drag to In Progress → session runs → auto-advance to Review → send followup → back to In Progress → complete → Review → drag to Done

2. **Plan mode lifecycle**: Create ticket → drag to In Progress (plan mode) → plan completes → plan_ready badge → tap → review plan → Supercharge → new session tracked → build completes → auto-advance to Review → Done

3. **Simple mode lifecycle**: Toggle simple on → drag to In Progress → no modal → move manually through columns → convert via "Assign to worktree" → gains session

4. **Multi-ticket + multi-worktree**: Multiple tickets assigned to same worktree → all show progress independently → sessions complete at different times → tickets advance independently

5. **Cross-view navigation**: Jump to session from board → normal view with correct selection → toggle back to board → ticket still in correct state

6. **Data persistence**: Create tickets, move them, assign sessions → restart app → all state preserved

7. **Error recovery**: Session errors → ticket shows error → send followup → session recovers → ticket advances

8. **Attachment integration**: Attach tickets in normal view → AI receives context → board unaffected

### Key Files

- All kanban-related files from S1–S13

### Definition of Done

- [ ] Full build lifecycle works end-to-end
- [ ] Full plan lifecycle works end-to-end (including supercharge)
- [ ] Simple mode lifecycle works end-to-end (including conversion)
- [ ] Multiple tickets on same worktree work independently
- [ ] Jump to session and back works correctly
- [ ] All state survives app restart
- [ ] Error states display and recover correctly
- [ ] Ticket attachment in normal view works without board side-effects
- [ ] No console errors or warnings during any flow
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Automated Tests

```typescript
// test/kanban/session-14/kanban-e2e.test.tsx
describe('Session 14: E2E Integration', () => {
  test('full build lifecycle: todo → in_progress → review → done')
  test('full plan lifecycle: todo → in_progress → plan_ready → supercharge → review → done')
  test('simple ticket lifecycle: todo → in_progress (simple) → assign worktree → flow')
  test('multiple tickets on same worktree advance independently')
  test('jump to session sets correct worktree and session selection')
  test('toggling board view preserves ticket state')
  test('session error sets error state without moving ticket')
  test('followup from error recovers ticket tracking')
  test('ticket attachment in normal view does not affect board state')
})
```

### Manual Tests

- [ ] **Full build flow**: Create a ticket with title + description + attachment → drag to In Progress → select a worktree → session starts (verify animated border) → wait for session to complete → ticket auto-moves to Review → tap ticket → see last AI message → send a followup → ticket moves to In Progress → session completes → ticket moves to Review → drag to Done → verify Done column shows it
- [ ] **Full plan flow**: Create ticket → drag to In Progress with Plan mode → session completes → "Plan ready" badge and violet border appear → tap ticket → plan renders with Implement/Handoff/Supercharge → click Supercharge → new session starts (border resumes) → build completes → ticket moves to Review → move to Done
- [ ] **Simple mode flow**: Toggle simple mode on → drag ticket to In Progress (no modal) → right-click → "Assign to worktree" → worktree picker opens → send → session starts, card gains animated border
- [ ] **Cross-view**: Click "Jump to session" on a ticket → normal view shows correct session → click Kanban toggle → board shows ticket in correct state
- [ ] **Restart**: Create several tickets in various columns → quit and reopen app → all tickets in correct columns with correct states
- [ ] **Ticket attachment**: Go to normal view → attach a board ticket → send message → verify AI receives the ticket content → check board → ticket state unchanged
- [ ] **Done collapse**: Collapse the Done column → tickets are hidden → expand → tickets reappear
- [ ] **Delete**: Right-click ticket → delete → ticket disappears from board → verify DB

---

## Summary

| Session | Module | Automated Tests | Est. Complexity |
|---------|--------|-----------------|-----------------|
| S1 | DB Schema & Migration | 11 tests | Low |
| S2 | DB CRUD & Types | 13 tests | Low |
| S3 | IPC Handlers & Preload | 9 tests | Low |
| S4 | Kanban Store | 14 tests | Medium |
| S5 | Header Toggle + MainPane + Cmd Palette | 6 tests | Low |
| S6 | Board + Column + Card Components | 13 tests | Medium |
| S7 | Ticket Creation Modal | 10 tests | Medium |
| S8 | Drag-and-Drop System | 9 tests | Medium |
| S9 | Worktree Picker Modal | 13 tests | High |
| S10 | Session ↔ Kanban Coordination | 10 tests | High |
| S11 | Ticket Modal: Multi-Mode Views | 19 tests | High |
| S12 | Simple Board Mode | 10 tests | Medium |
| S13 | Ticket Attachment in Normal View | 11 tests | Medium |
| S14 | E2E Integration & Verification | 9 tests | Medium |
| **Total** | | **157 tests** | |

**Methodology reminder**: Use TDD for every session. Write the test file first, run it (all tests fail), implement until all tests pass, then proceed to manual verification. Use the **superpowers subagent development skill** (`/subagent`) to implement each session, passing this file as context.
