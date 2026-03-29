# PRD: Kanban Board View

## Problem Statement

Hive users currently manage AI-powered development tasks by manually creating worktrees, spawning sessions, and tracking progress across multiple branches in the sidebar. There is no structured way to plan work, track its lifecycle (backlog → active → review → done), or visualize the state of multiple tasks at once. Users must mentally track which worktrees are doing what, whether sessions have completed, and what needs review — a cognitive overhead that grows with project complexity.

## Solution

A project-scoped Kanban board view that replaces the main sessions pane via a header toggle. The board provides a visual, drag-and-drop workflow for managing development tasks as tickets across four columns: **To Do**, **In Progress**, **Review**, and **Done**.

Tickets in the board integrate deeply with Hive's existing worktree and session infrastructure. Dragging a ticket to "In Progress" triggers a worktree picker that creates a session with the ticket content as context. The board then tracks session progress in real-time, auto-advances tickets when sessions complete, and supports the full Plan mode lifecycle (plan review → implement/handoff/supercharge) directly from ticket modals.

A "simple mode" toggle on the In Progress column allows tickets to be used as plain kanban cards without session integration, enabling lightweight task tracking alongside the full AI-powered workflow.

Tickets can also be manually attached as context to any session from the normal view, functioning as structured context similar to how GitHub PR comments appear as attachments.

All ticket data is persisted in SQLite.

## User Stories

1. As a developer, I want to toggle between the normal sessions view and a Kanban board for my project, so that I can switch between task planning and active development.

2. As a developer, I want the Kanban board to follow the currently selected project in the sidebar, so that switching projects updates the board automatically.

3. As a developer, I want to access the Kanban board via the command palette, so that I can switch views without reaching for a button.

4. As a developer, I want to create tickets in the To Do column with a title, markdown description, and file attachments, so that I can plan tasks before starting them.

5. As a developer, I want to edit a ticket's title, description, and attachments from any column by tapping the ticket, so that I can refine tasks as I learn more.

6. As a developer, I want to delete tickets from the ticket modal or a right-click context menu, so that I can clean up the board.

7. As a developer, I want to drag tickets freely between any columns (To Do, In Progress, Review, Done), so that I can manage tasks without artificial workflow restrictions.

8. As a developer, I want to reorder tickets within a column via drag-and-drop, so that I can prioritize work visually.

9. As a developer, I want dragging a ticket to In Progress to open a worktree picker modal, so that I can choose where the AI session runs.

10. As a developer, I want the worktree picker to show all project worktrees with a badge indicating how many active tickets each has, so that I can make informed assignment decisions.

11. As a developer, I want a "New worktree" option in the picker that auto-generates a worktree name immediately, so that I can start work without naming friction.

12. As a developer, I want a Build/Plan chip toggle in the worktree picker's input area (Tab to toggle, same as normal input), so that I can choose whether the session plans or implements.

13. As a developer, I want the worktree picker to show an editable text preview with my ticket content embedded as an XML block, so that I can customize the prompt before sending.

14. As a developer, I want the default prompt to differ by mode — "Please implement the following ticket" for Build, "Please review the following ticket and create a detailed implementation plan" for Plan — so that the AI starts with the right intent.

15. As a developer, I want sending from the worktree picker to create a session in the selected worktree with the prompt text in the input field, so that work begins immediately.

16. As a developer, I want ticket cards to show a pulsing animated border (blue for Build, violet for Plan) while the session is actively running, so that I can see at a glance which tickets are being worked on.

17. As a developer, I want ticket cards to display the worktree name when assigned (In Progress or Review), so that I can see which branch is handling each ticket.

18. As a developer, I want ticket cards to show an attachment count badge when attachments exist, so that I know context is available.

19. As a developer, I want tickets to auto-advance from In Progress to Review when a Build-mode session completes, so that I don't have to manually track session completion.

20. As a developer, I want tickets in Plan mode to stay in In Progress with a static solid violet border and a "Plan ready" badge when the plan session completes, so that I'm clearly alerted to review the plan.

21. As a developer, I want to tap a plan-ready ticket to see the rendered plan markdown with Implement, Handoff, and Supercharge buttons, so that I can review and approve the plan from the board.

22. As a developer, I want the Implement, Handoff, and Supercharge actions in the plan modal to work identically to the existing session view actions, so that the board is a full-fidelity alternative.

23. As a developer, I want Supercharge to automatically re-attach the ticket to the newly created session, so that the ticket continues tracking the right work.

24. As a developer, I want tickets with errored sessions to stay in In Progress with a red error badge, so that I can tap to see what went wrong and retry.

25. As a developer, I want to tap a ticket in the Review column to see the last AI message and a followup input area (with Build/Plan chip toggle), so that I can evaluate the work and give feedback.

26. As a developer, I want followup commands from the Review modal to pipe to the same session and move the ticket back to In Progress, so that the conversation history stays intact.

27. As a developer, I want a "Jump to session" action on ticket cards, so that I can switch to the normal sessions view with the correct worktree and session selected.

28. As a developer, I want dragging a ticket backward from In Progress to To Do to show a confirmation dialog about stopping the session, so that I don't accidentally kill running work.

29. As a developer, I want the Done column to be collapsible, so that completed work doesn't crowd the board.

30. As a developer, I want a "simple mode" toggle on the In Progress column header, so that I can drag tickets in without triggering the worktree picker flow.

31. As a developer, I want simple mode to be persisted per-project, so that my preference survives app restarts.

32. As a developer, I want simple mode to only affect new drags (existing flow tickets keep their sessions), so that toggling doesn't disrupt active work.

33. As a developer, I want simple tickets to appear as plain cards (no animated border, no worktree badge), so that I can visually distinguish them from flow tickets.

34. As a developer, I want simple tickets to have zero automation (no auto-advance, no session tracking), so that they behave like a plain kanban board.

35. As a developer, I want to convert a simple ticket to a flow ticket via right-click "Assign to worktree", so that I can escalate a manual task to an AI-assisted one.

36. As a developer, I want to attach board tickets as context in the normal sessions view via the attachment icon's "Board ticket" option, so that I can reference tickets without being on the board.

37. As a developer, I want a ticket picker with title search and column status filters when attaching tickets, so that I can quickly find the right ticket.

38. As a developer, I want attached tickets to appear as styled chips in the attachment tray (with a kanban icon and title), so that they're visually consistent with file attachments.

39. As a developer, I want ticket attachments to be injected as XML blocks on send and have no side-effect on the board, so that they're purely informational context.

40. As a developer, I want to attach multiple tickets to a single message (sharing the 10-attachment limit with files), so that I can provide rich context.

## Implementation Decisions

### Database

- New `kanban_tickets` table added via migration v11 with fields: `id` (text PK), `project_id` (FK to projects), `title` (text, required), `description` (text, nullable, markdown), `attachments` (text, JSON array, default `'[]'`), `column` (text, one of `'todo'`, `'in_progress'`, `'review'`, `'done'`), `sort_order` (real, for intra-column ordering), `current_session_id` (FK to sessions, nullable), `worktree_id` (FK to worktrees, nullable), `mode` (text, `'build'` or `'plan'`, nullable), `plan_ready` (integer, 0/1), `created_at` (text, ISO), `updated_at` (text, ISO).
- The `projects` table gets a new column `kanban_simple_mode` (integer, default 0) to persist the simple mode toggle per project.
- Indexes on `project_id` and `current_session_id` for fast lookups.
- Fractional `sort_order` (real type) allows inserting between tickets without re-numbering the entire column.

### IPC Layer

- New `kanban-handlers.ts` file following the existing handler registration pattern.
- Channel naming: `kanban:ticket:create`, `kanban:ticket:update`, `kanban:ticket:delete`, `kanban:ticket:move`, `kanban:ticket:reorder`, `kanban:ticket:getByProject`, `kanban:simple-mode:toggle`.
- Exposed to renderer via preload as `window.kanban.*`.

### State Management (Zustand Store)

- New `useKanbanStore` following existing store patterns (persist middleware for UI state, data loaded fresh).
- State shape: tickets stored as `Map<string, KanbanTicket[]>` keyed by project ID, board view active flag, simple mode state per project.
- Actions: `loadTickets(projectId)`, `createTicket(...)`, `updateTicket(...)`, `deleteTicket(...)`, `moveTicket(ticketId, targetColumn, sortOrder)`, `reorderTicket(ticketId, newSortOrder)`, `setSimpleMode(projectId, enabled)`.
- Session status subscription: store subscribes to session store changes and auto-advances tickets when their linked session status changes to `completed`. For plan-mode sessions, sets `plan_ready = true` instead of advancing.
- Supercharge hook: intercepts session creation events from the supercharge flow and updates the ticket's `current_session_id` to the new session.
- Persisted state: `isBoardViewActive` flag (per project), `simpleMode` toggle (also in DB for durability).

### Store Coordination

- Session store changes trigger kanban store updates via the existing store coordination pattern (registration callbacks to break circular dependencies).
- When a session's status flips to `completed` or `error`, the kanban store checks if any ticket references that session via `current_session_id` and reacts accordingly.
- When the supercharge flow in the session store creates a new session, it emits a coordination event that the kanban store listens for to update `current_session_id`.

### Board Components

- `KanbanBoard`: Top-level component rendered by `MainPane` when board view is active. Lays out 4 `KanbanColumn` components horizontally. Each column scrolls independently.
- `KanbanColumn`: Receives column ID and tickets. Renders a header (title, ticket count, and simple-mode toggle for In Progress), drop zone for drag-and-drop, and a list of `KanbanTicketCard` components. The Done column supports collapse/expand.
- `KanbanTicketCard`: Draggable card showing title, optional attachment count badge, optional worktree name badge. Visual states: default (no border), active/building (pulsing blue border), active/planning (pulsing violet border), plan ready (static solid violet border + badge), error (red error badge). Click opens `KanbanTicketModal`. Right-click opens context menu (delete, assign to worktree if simple). A "jump to session" icon triggers view switch.
- `KanbanTicketModal`: Multi-mode modal based on ticket state:
  - **Edit mode** (To Do, simple, or Done): Title input, markdown editor with preview for description, attachment management, delete button.
  - **Plan review mode** (In Progress + plan_ready): Rendered plan markdown (same renderer as ExitPlanModeToolView) with Implement, Handoff, Supercharge action buttons.
  - **Review mode** (Review column): Last AI assistant message from the session, plus a followup input area with Build/Plan chip toggle (Tab to switch). Send pipes to the same session and moves ticket to In Progress.
  - **Error mode** (In Progress + error): Error display from session, followup input to retry.

### Worktree Picker Modal

- Triggered when dragging a ticket to In Progress (and simple mode is off), or when right-clicking a simple ticket and choosing "Assign to worktree".
- Displays a list of project worktrees, each showing name, branch, and active ticket count badge.
- "New worktree" option at the top — selecting it auto-generates a worktree name using the existing city-name convention and creates the worktree immediately.
- Below the worktree list: an input area with the Build/Plan chip toggle (same component as the normal session input), Tab to toggle.
- The input area shows an editable text preview pre-filled with the mode-specific default template containing the ticket as an XML block:
  - Build: `"Please implement the following ticket.\n\n<ticket title='[title]'>[description + attachment refs]</ticket>"`
  - Plan: `"Please review the following ticket and create a detailed implementation plan.\n\n<ticket title='[title]'>[description + attachment refs]</ticket>"`
- On send: creates worktree if needed, creates a session in that worktree with the specified mode, puts the prompt text into the session, updates the ticket's `current_session_id`, `worktree_id`, `mode`, and `column` to `in_progress`.

### Ticket Attachment in Normal View

- The `AttachmentButton` component gains a new "Board ticket" option alongside existing file types.
- Selecting it opens a ticket picker modal scoped to the current project.
- The picker has: a text search input filtering by title, and column status filter chips (To Do, In Progress, Review, Done).
- Selected tickets appear as styled chips in the attachment tray, with a kanban/card icon and ticket title. Hovering shows full ticket content.
- On send, each ticket chip is injected as an XML block in the message (same format as the flow ticket prompt).
- Ticket attachments share the existing 10-attachment limit with file attachments.
- Attaching a ticket has zero side-effects on the board — purely informational context.

### View Integration

- `Header` component gets a toggle button to switch between sessions view and kanban board view for the current project.
- `MainPane` checks `useKanbanStore.isBoardViewActive` and renders `KanbanBoard` instead of the session components when active.
- Sidebar remains unchanged in kanban view — project and worktree selection still works, and selecting a project updates the board.
- "Jump to session" from a ticket card: sets `isBoardViewActive = false`, selects the ticket's worktree in the sidebar, and focuses the ticket's session tab.

### Command Palette

- New command registered: "Open Kanban Board" (category: `navigation`, keywords: `['kanban', 'board', 'tickets']`).
- Action: toggles board view for the currently selected project.

### Drag-and-Drop

- Uses HTML5 drag-and-drop API consistent with the existing `SessionTabs` pattern.
- Drag data transferred via `e.dataTransfer` with JSON containing ticket ID and source column.
- Drop zones on columns and between tickets (for intra-column reordering).
- Column drop triggers: if target is In Progress and simple mode is off → open worktree picker modal; if source is In Progress and target is To Do → show stop session confirmation; otherwise → move directly.

## Testing Decisions

Good tests for this feature verify external behavior through the public interfaces of each module, without coupling to internal implementation details. Tests should be resilient to refactoring — if the internal structure changes but the behavior stays the same, tests should still pass.

### Store: useKanbanStore (Unit Tests — Vitest)

- Test ticket CRUD operations (create returns correct shape, update modifies fields, delete removes ticket).
- Test column moves: `moveTicket` updates the `column` field and `sort_order`.
- Test intra-column reordering: `reorderTicket` updates `sort_order` correctly relative to neighbors.
- Test simple mode toggle: `setSimpleMode` persists per project and doesn't affect existing flow tickets.
- Test auto-advance logic: when a linked session's status changes to `completed` and ticket mode is `build`, ticket column becomes `review`. When mode is `plan`, `plan_ready` flips to true and ticket stays in `in_progress`.
- Test supercharge re-attachment: when a new session is created via supercharge for a ticket's session, `current_session_id` updates to the new session.
- Test error handling: when session errors, ticket stays in `in_progress` and retains its session link.
- Prior art: existing store patterns use `renderHook` + `act` from `@testing-library/react`, with state assertions via `getState()`.

### DB + IPC Layer (Integration Tests — Vitest)

- Test database CRUD: create a ticket, read it back, update fields, delete, verify cascade on project delete.
- Test column constraints: verify only valid column values are accepted.
- Test sort order: create multiple tickets, reorder, verify order persists across reads.
- Test IPC round-trip: call IPC handler with valid data, verify response matches database state.
- Test migration: verify migration v11 applies cleanly on a fresh database and on an existing v10 database.

### Session ↔ Kanban Coordination (Integration Tests — Vitest)

- Test auto-advance end-to-end: create a ticket in In Progress with a mock session, simulate session completion, verify ticket moves to Review.
- Test plan-ready detection: create a plan-mode ticket, simulate session completion with pending plan, verify `plan_ready` flag and ticket stays in In Progress.
- Test supercharge chain: simulate supercharge creating a new session, verify ticket's `current_session_id` updates.
- Test followup from Review: simulate sending a followup, verify ticket moves back to In Progress with same session ID.
- Test backward drag with session stop: simulate moving In Progress ticket to To Do, verify session stop is triggered.

### Drag-and-Drop Interactions (E2E Tests — Playwright)

- Test drag ticket from To Do to In Progress: verify worktree picker modal opens (simple mode off).
- Test drag ticket from To Do to In Progress with simple mode on: verify no modal, ticket moves directly.
- Test drag ticket within a column: verify reorder persists.
- Test drag ticket from In Progress to To Do: verify confirmation dialog appears.
- Test drag ticket from In Progress to Review: verify ticket position updates.
- Test drag ticket to Done column and collapse/expand Done column.
- Prior art: existing Playwright setup with `data-testid` selectors on components.

## Out of Scope

- **Multi-project board**: A global board showing tickets across all projects is not included. Each board is strictly project-scoped.
- **Ticket labels/tags**: No tagging or labeling system for tickets beyond the column status. May be added in a future iteration.
- **Assignees or multi-user**: No concept of assigning tickets to different users or team members. Hive is a single-user application.
- **Due dates or time tracking**: No deadlines, time estimates, or time-spent tracking on tickets.
- **Swimlanes or custom columns**: The four columns are fixed. No ability to add, remove, or rename columns.
- **Ticket templates**: No pre-defined ticket templates beyond the default prompt templates for Build/Plan modes.
- **Board-level analytics**: No burndown charts, velocity metrics, or board-level statistics.
- **Import/export**: No ability to import tickets from external tools (Jira, Linear, etc.) or export the board.
- **Ticket linking**: No ability to link tickets to each other (blockers, dependencies, parent/child).
- **Undo/redo**: No undo for column moves or ticket deletions.
- **Notification system**: No push notifications or system tray alerts when sessions complete. The board's visual indicators (border changes, badges) serve as the notification mechanism.

## Further Notes

- The Kanban board is designed as a **power-user workflow layer** on top of Hive's existing session and worktree infrastructure. It does not replace any existing functionality — it augments it with structured task tracking.
- The **simple mode toggle** is a critical escape valve. It ensures the board is useful even for developers who want lightweight task tracking without AI session integration for every ticket.
- The **XML block format** for ticket content in prompts should be designed to be easily parseable by the AI models while remaining human-readable in the editable text preview. The format mirrors the existing GitHub PR comment attachment pattern already used in the codebase.
- **Fractional sort ordering** (using real/float type) is chosen over integer ordering to allow O(1) insertions between tickets without re-numbering. If precision issues arise after many insertions, a periodic re-normalization pass can recalculate clean integer orders.
- The **session status subscription** in the kanban store should be lightweight — it reacts to status changes already emitted by the session store rather than polling. This follows the existing store coordination patterns in the codebase.
- The **worktree picker modal** is a new component but reuses the existing Build/Plan chip toggle component and attachment system, minimizing new UI surface area.
