# In-Progress Column: Only Working Tickets

## Problem

The In-Progress column accumulates tickets that aren't actively being worked on. When a plan finishes planning, the ticket stays in `in_progress` with a `plan_ready` flag — but it's actually pending user review. Similarly, errored sessions linger in `in_progress` even though no work is happening. This clutters the column and makes it hard to see what's actually running.

## Rule

The In-Progress column should only contain:

1. **Manually-placed tickets** — tickets the user dragged there without a linked session
2. **Actively-working tickets** — tickets with a linked session in the `working` or `planning` state

Any ticket whose session finishes (plan complete, build complete, or error) should automatically move to the `review` column, since it requires user attention.

## Changes

### 1. `syncTicketWithSession` in `useKanbanStore.ts`

The state machine that handles session events needs three changes:

- **`session_completed` + `mode === 'plan'`**: Currently sets `plan_ready = true` and stays in the current column. Change to: set `plan_ready = true` AND move to `review`.
- **`plan_ready` event**: Currently sets `plan_ready = true` and stays. Change to: set `plan_ready = true` AND move to `review`.
- **`session_error` event**: Currently does nothing (no state change). Change to: move to `review` (if currently in `in_progress`). The ticket stays linked to the errored session so the error badge and modal still work.

### 2. `resolveModalMode` in `KanbanTicketModal.tsx`

The modal mode resolver currently gates `plan_review` mode on `column === 'in_progress'`. Since plan-ready tickets will now be in the `review` column, update the checks:

- **`error` mode**: Change from `column === 'in_progress' && sessionStatus === 'error'` to just `sessionStatus === 'error'` (error can now appear in `review` column).
- **`plan_review` mode**: Change from `column === 'in_progress' && plan_ready` to just `plan_ready` (plan-ready tickets are now in `review`).

### 3. Tests

Update test assertions in `test/kanban/session-10/` and `test/kanban/session-14/` to expect `review` column instead of `in_progress` for plan-completed and error scenarios.

## What doesn't change

- **DB schema**: No changes needed.
- **Card UI** (`KanbanTicketCard.tsx`): Border colors and badges are driven by `plan_ready`, `mode`, and session status — not column. They continue to work as-is.
- **Build completion**: Already moves to `review`. No change.
- **Supercharge**: Re-attaches to a new session with `mode = 'build'`, resets `plan_ready`. If the ticket was moved to review, the supercharge flow moves it back to `in_progress` as part of re-engaging work (existing behavior via the session becoming active).
- **Coordination layer** (`store-coordination.ts`): No changes to event types or registration.
