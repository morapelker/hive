# In-Progress Only Working Tickets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the In-Progress column only hold actively-working or manually-placed tickets — plan-completed and errored tickets auto-move to Review.

**Architecture:** Three targeted edits: the state machine in `useKanbanStore.ts` gets new move-to-review logic for plan-completed and errored events; the modal mode resolver in `KanbanTicketModal.tsx` drops its column guard so it works when plan-ready/error tickets are in the review column; existing tests are updated to match the new expectations.

**Tech Stack:** TypeScript, Zustand, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/renderer/src/stores/useKanbanStore.ts` | Modify lines 253–310 | State machine: `syncTicketWithSession` |
| `src/renderer/src/components/kanban/KanbanTicketModal.tsx` | Modify lines 172–187 | Modal mode resolver: `resolveModalMode` |
| `test/kanban/session-10/session-kanban-coordination.test.ts` | Modify | Update assertions for plan-completed + error tests |
| `test/kanban/session-14/kanban-e2e.test.tsx` | No changes needed | Build-complete E2E test already expects `review` |

---

### Task 1: Update `syncTicketWithSession` State Machine

**Files:**
- Modify: `src/renderer/src/stores/useKanbanStore.ts:261–306`

- [ ] **Step 1: Update the `session_completed` + `plan` branch**

In `src/renderer/src/stores/useKanbanStore.ts`, find this block (lines 268–273):

```typescript
              } else if (ticket.mode === 'plan' && !ticket.plan_ready) {
                  // Set plan_ready flag, keep in current column (idempotent — skip if already set)
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                }
```

Replace with:

```typescript
              } else if (ticket.mode === 'plan' && !ticket.plan_ready) {
                  // Plan finished — set plan_ready and move to review for user attention
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                  if (ticket.column !== 'review') {
                    get()
                      .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                      .catch(() => {})
                  }
                }
```

- [ ] **Step 2: Update the `plan_ready` event branch**

In the same file, find this block (lines 277–285):

```typescript
              case 'plan_ready': {
                // Explicit plan.ready event — set flag (idempotent)
                if (ticket.mode === 'plan' && !ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                }
                break
              }
```

Replace with:

```typescript
              case 'plan_ready': {
                // Explicit plan.ready event — set flag and move to review
                if (ticket.mode === 'plan' && !ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                  if (ticket.column !== 'review') {
                    get()
                      .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                      .catch(() => {})
                  }
                }
                break
              }
```

- [ ] **Step 3: Update the `session_error` branch**

In the same file, find this block (lines 302–306):

```typescript
              case 'session_error': {
                // No state change needed — ticket stays in current column.
                // The card reads session status from worktree-status store.
                break
              }
```

Replace with:

```typescript
              case 'session_error': {
                // Error requires user attention — move to review if currently in_progress
                if (ticket.column === 'in_progress') {
                  get()
                    .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                    .catch(() => {})
                }
                break
              }
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/stores/useKanbanStore.ts
git commit -m "feat: auto-move plan-completed and errored tickets to review column"
```

---

### Task 2: Update `resolveModalMode` in KanbanTicketModal

**Files:**
- Modify: `src/renderer/src/components/kanban/KanbanTicketModal.tsx:172–187`

- [ ] **Step 1: Update the modal mode resolver**

In `src/renderer/src/components/kanban/KanbanTicketModal.tsx`, find this function (lines 171–187):

```typescript
/** Determine what mode the modal should operate in */
function resolveModalMode(ticket: KanbanTicket, sessionStatus: string | null): ModalMode {
  // Error mode: in_progress + linked session has error
  if (ticket.column === 'in_progress' && sessionStatus === 'error') {
    return 'error'
  }
  // Plan review mode: in_progress + plan_ready
  if (ticket.column === 'in_progress' && ticket.plan_ready) {
    return 'plan_review'
  }
  // Review mode: review column
  if (ticket.column === 'review') {
    return 'review'
  }
  // Default: edit mode (todo, done, or simple in_progress tickets)
  return 'edit'
}
```

Replace with:

```typescript
/** Determine what mode the modal should operate in */
function resolveModalMode(ticket: KanbanTicket, sessionStatus: string | null): ModalMode {
  // Error mode: linked session has error (can appear in any column)
  if (sessionStatus === 'error') {
    return 'error'
  }
  // Plan review mode: plan_ready flag set (ticket is now in review column)
  if (ticket.plan_ready) {
    return 'plan_review'
  }
  // Review mode: review column
  if (ticket.column === 'review') {
    return 'review'
  }
  // Default: edit mode (todo, done, or simple in_progress tickets)
  return 'edit'
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/kanban/KanbanTicketModal.tsx
git commit -m "fix: remove column guard from resolveModalMode for plan_ready and error"
```

---

### Task 3: Update Tests in session-10

**Files:**
- Modify: `test/kanban/session-10/session-kanban-coordination.test.ts`

- [ ] **Step 1: Update "plan session completing sets plan_ready to true" test**

This test (lines 111–137) must also assert the ticket moved to `review` and that `move` was called. Find:

```typescript
  test('plan session completing sets plan_ready to true', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-2',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-2', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const updated = tickets!.find((t) => t.id === 't1')
    expect(updated!.plan_ready).toBe(true)
    expect(mockKanban.ticket.update).toHaveBeenCalledWith('t1', { plan_ready: true })
  })
```

Replace with:

```typescript
  test('plan session completing sets plan_ready and moves to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-2',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-2', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const updated = tickets!.find((t) => t.id === 't1')
    expect(updated!.plan_ready).toBe(true)
    expect(updated!.column).toBe('review')
    expect(mockKanban.ticket.update).toHaveBeenCalledWith('t1', { plan_ready: true })
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
  })
```

- [ ] **Step 2: Update "plan session completing does NOT move ticket to review" test**

This test (lines 142–169) asserts the OLD behavior (plan stays in in_progress). It must now assert the opposite. Find:

```typescript
  test('plan session completing does NOT move ticket to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-3',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-3', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const updated = tickets!.find((t) => t.id === 't1')
    // Should stay in in_progress, not be moved to review
    expect(updated!.column).toBe('in_progress')
    expect(mockKanban.ticket.move).not.toHaveBeenCalled()
  })
```

Replace with:

```typescript
  test('plan session completing moves ticket to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-3',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-3', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const updated = tickets!.find((t) => t.id === 't1')
    expect(updated!.column).toBe('review')
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
  })
```

- [ ] **Step 3: Update "session error does not change ticket column" test**

This test (lines 174–200) asserts errors stay in in_progress. Now errors in in_progress should move to review. Find:

```typescript
  test('session error does not change ticket column', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-4',
      mode: 'build'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-4', {
        type: 'session_error'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const unchanged = tickets!.find((t) => t.id === 't1')
    expect(unchanged!.column).toBe('in_progress')
    expect(mockKanban.ticket.move).not.toHaveBeenCalled()
    expect(mockKanban.ticket.update).not.toHaveBeenCalled()
  })
```

Replace with:

```typescript
  test('session error moves in_progress ticket to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-4',
      mode: 'build'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-4', {
        type: 'session_error'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const moved = tickets!.find((t) => t.id === 't1')
    expect(moved!.column).toBe('review')
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
    expect(mockKanban.ticket.update).not.toHaveBeenCalled()
  })
```

- [ ] **Step 4: Update "plan_ready change persists via IPC" test**

This test (lines 302–325) should also verify the move IPC call. Find:

```typescript
  test('plan_ready change persists via IPC', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-6',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-6', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(mockKanban.ticket.update).toHaveBeenCalledWith('t1', { plan_ready: true })
  })
```

Replace with:

```typescript
  test('plan_ready change persists via IPC and moves to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-6',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-6', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(mockKanban.ticket.update).toHaveBeenCalledWith('t1', { plan_ready: true })
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
  })
```

- [ ] **Step 5: Update "multiple tickets can reference different sessions independently" test**

This test (lines 362–410) asserts ticketB (plan) stays in in_progress after completion. Now it should move to review. Find the final assertions block (lines 407–410):

```typescript
    const ticketsAfterB = useKanbanStore.getState().tickets.get('proj-1')!
    expect(ticketsAfterB.find((t) => t.id === 'tB')!.plan_ready).toBe(true)
    expect(ticketsAfterB.find((t) => t.id === 'tB')!.column).toBe('in_progress')
```

Replace with:

```typescript
    const ticketsAfterB = useKanbanStore.getState().tickets.get('proj-1')!
    expect(ticketsAfterB.find((t) => t.id === 'tB')!.plan_ready).toBe(true)
    expect(ticketsAfterB.find((t) => t.id === 'tB')!.column).toBe('review')
```

- [ ] **Step 6: Update "plan_ready event sets flag on plan-mode ticket" test**

This test (lines 438–461) must also assert the ticket moved to review. Find:

```typescript
  test('plan_ready event sets flag on plan-mode ticket', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-7',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-7', {
        type: 'plan_ready'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    expect(tickets!.find((t) => t.id === 't1')!.plan_ready).toBe(true)
  })
```

Replace with:

```typescript
  test('plan_ready event sets flag and moves to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-7',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-7', {
        type: 'plan_ready'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const updated = tickets!.find((t) => t.id === 't1')
    expect(updated!.plan_ready).toBe(true)
    expect(updated!.column).toBe('review')
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
  })
```

- [ ] **Step 7: Update "duplicate plan_ready is a no-op when already set" test**

This test (lines 542–567) has a ticket with `plan_ready: true` already. The idempotency guard `!ticket.plan_ready` prevents any action, so this test's assertions remain correct — **no changes needed**. Verify by reading: the guard skips both the updateTicket and the moveTicket since `plan_ready` is already `true`.

- [ ] **Step 8: Commit**

```bash
git add test/kanban/session-10/session-kanban-coordination.test.ts
git commit -m "test: update session-10 tests for plan-completed and error auto-move to review"
```

---

### Task 4: Run Tests and Verify

- [ ] **Step 1: Run the session-10 test suite**

```bash
npx vitest run test/kanban/session-10/session-kanban-coordination.test.ts
```

Expected: All tests pass.

- [ ] **Step 2: Run the session-14 E2E test suite**

```bash
npx vitest run test/kanban/session-14/kanban-e2e.test.tsx
```

Expected: All tests pass. The E2E `notifyKanbanSessionSync` test uses a `build` session so it's unaffected. The `board renders tickets in correct columns` test also uses a `build` session.

- [ ] **Step 3: Run the full kanban test suite**

```bash
npx vitest run test/kanban/
```

Expected: All kanban tests pass.
