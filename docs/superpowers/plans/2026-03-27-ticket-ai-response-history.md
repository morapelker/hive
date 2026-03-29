# Ticket AI Response History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the AI's final assistant message at each turn-completion, so the ticket modal shows a full interleaved conversation history (user follow-ups + AI responses).

**Architecture:** Extend the existing `ticket_followup_messages` table with a `role` column. Capture AI responses at two events in `useOpenCodeGlobalListener.ts`: `session.status` idle (fetches last assistant message from session_messages) and `plan.ready` (stores plan content directly). Update the display component to render both roles.

**Tech Stack:** SQLite, Electron IPC, React, Zustand

---

All paths relative to `/Users/mor/.hive-worktrees/hive-electron/hive-electron--canary-v3/`.

## File Map

| File | Responsibility |
|------|---------------|
| `src/main/db/types.ts` | Add `role` to `TicketFollowupMessage` + `TicketFollowupMessageCreate` |
| `src/main/db/schema.ts` | v13 migration: ALTER TABLE add `role` column |
| `src/main/db/database.ts` | Include `role` in INSERT and return value |
| `src/preload/index.ts` | Add `role` to inline type in `followup.create` |
| `src/preload/index.d.ts` | Add `role` to type declarations |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` | Add helpers + capture at idle and plan.ready |
| `src/renderer/src/components/kanban/KanbanTicketModal.tsx` | Rename component, update styling for both roles |

---

### Task 1: Add `role` Column — Types, Schema, DB Method

**Files:**
- Modify: `src/main/db/types.ts:378-394`
- Modify: `src/main/db/schema.ts:1,324-346`
- Modify: `src/main/db/database.ts:1764-1793`

- [ ] **Step 1: Add `role` to `TicketFollowupMessage` interface**

In `src/main/db/types.ts`, the `TicketFollowupMessage` interface starts at line 378. Add `role` after `content`:

```typescript
export interface TicketFollowupMessage {
  id: string
  ticket_id: string
  content: string
  role: 'user' | 'assistant'
  mode: 'build' | 'plan'
  session_id: string | null
  source: 'direct' | 'supercharge' | 'error_retry'
  created_at: string
}
```

- [ ] **Step 2: Add `role` to `TicketFollowupMessageCreate` interface**

Same file, the create interface starts at line 389. Add optional `role`:

```typescript
export interface TicketFollowupMessageCreate {
  ticket_id: string
  content: string
  role?: 'user' | 'assistant'
  mode: 'build' | 'plan'
  session_id?: string | null
  source?: 'direct' | 'supercharge' | 'error_retry'
}
```

- [ ] **Step 3: Bump schema version and add v13 migration**

In `src/main/db/schema.ts`:

1. Line 1: Change `CURRENT_SCHEMA_VERSION = 12` to `CURRENT_SCHEMA_VERSION = 13`

2. After the v12 migration closing `}` (line 346), add a comma and the v13 migration:

```typescript
  {
    version: 13,
    name: 'add_ticket_followup_messages_role',
    up: `
      ALTER TABLE ticket_followup_messages ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
    `,
    down: `
      ALTER TABLE ticket_followup_messages DROP COLUMN role;
    `
  }
```

- [ ] **Step 4: Include `role` in `createTicketFollowupMessage`**

In `src/main/db/database.ts`, the method starts at line 1764. Update it to handle `role`:

```typescript
  createTicketFollowupMessage(data: TicketFollowupMessageCreate): TicketFollowupMessage {
    const db = this.getDb()
    const id = randomUUID()
    const now = new Date().toISOString()
    const sessionId = data.session_id ?? null
    const source = data.source ?? 'direct'
    const role = data.role ?? 'user'

    db.prepare(
      `INSERT INTO ticket_followup_messages (id, ticket_id, content, role, mode, session_id, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, data.ticket_id, data.content, role, data.mode, sessionId, source, now)

    return {
      id,
      ticket_id: data.ticket_id,
      content: data.content,
      role: role as 'user' | 'assistant',
      mode: data.mode as 'build' | 'plan',
      session_id: sessionId,
      source: source as 'direct' | 'supercharge' | 'error_retry',
      created_at: now
    }
  }
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors (or only pre-existing ones unrelated to our changes)

- [ ] **Step 6: Commit**

```bash
git add src/main/db/types.ts src/main/db/schema.ts src/main/db/database.ts
git commit -m "feat: add role column to ticket_followup_messages (v13 migration)"
```

---

### Task 2: Update Preload Bridge Types

**Files:**
- Modify: `src/preload/index.ts:1788-1798`
- Modify: `src/preload/index.d.ts:201-217,1323-1326`

- [ ] **Step 1: Add `role` to inline type in `preload/index.ts`**

In `src/preload/index.ts`, the `followup.create` inline type starts at line 1789. Add `role`:

```typescript
    followup: {
      create: (data: {
        ticket_id: string
        content: string
        role?: 'user' | 'assistant'
        mode: 'build' | 'plan'
        session_id?: string | null
        source?: 'direct' | 'supercharge' | 'error_retry'
      }) => ipcRenderer.invoke('kanban:followup:create', data),
      getByTicket: (ticketId: string) =>
        ipcRenderer.invoke('kanban:followup:getByTicket', ticketId)
    }
```

- [ ] **Step 2: Add `role` to type declarations in `preload/index.d.ts`**

In `src/preload/index.d.ts`, update the `TicketFollowupMessage` interface (line 201) to add `role`:

```typescript
  interface TicketFollowupMessage {
    id: string
    ticket_id: string
    content: string
    role: 'user' | 'assistant'
    mode: 'build' | 'plan'
    session_id: string | null
    source: 'direct' | 'supercharge' | 'error_retry'
    created_at: string
  }
```

And update `TicketFollowupMessageCreate` (line 212) to add optional `role`:

```typescript
  interface TicketFollowupMessageCreate {
    ticket_id: string
    content: string
    role?: 'user' | 'assistant'
    mode: 'build' | 'plan'
    session_id?: string | null
    source?: 'direct' | 'supercharge' | 'error_retry'
  }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts
git commit -m "feat: add role field to preload bridge followup types"
```

---

### Task 3: Capture AI Responses at Turn-Completion

**Files:**
- Modify: `src/renderer/src/hooks/useOpenCodeGlobalListener.ts:114-156,409-423,507,556-570,593`

This is the core task. We add two helper functions at module level, then hook them into three capture points.

- [ ] **Step 1: Add `findLinkedKanbanTicket` helper**

After `markBackgroundSessionCompleted` ends (line 156), add:

```typescript

function findLinkedKanbanTicket(sessionId: string): { id: string; current_session_id: string | null } | null {
  const kanbanTickets = useKanbanStore.getState().tickets
  for (const [, projectTickets] of kanbanTickets) {
    const linkedTicket = projectTickets.find((t) => t.current_session_id === sessionId)
    if (linkedTicket) return linkedTicket
  }
  return null
}

function captureAIResponseForTicket(sessionId: string): void {
  const linkedTicket = findLinkedKanbanTicket(sessionId)
  if (!linkedTicket) return

  window.db.sessionMessage.list(sessionId).then((messages) => {
    const last = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.content.trim().length > 0)
    if (last) {
      window.kanban.followup.create({
        ticket_id: linkedTicket.id,
        content: last.content,
        role: 'assistant',
        mode: useSessionStore.getState().getSessionMode(sessionId),
        session_id: sessionId,
        source: 'direct'
      }).catch(() => {})
    }
  }).catch(() => {})
}
```

- [ ] **Step 2: Capture at `session.status` idle**

Insert the capture AFTER the pending plan check (line 509) and AFTER the command approval check (line 513), but BEFORE the active session check (line 516). Between lines 513 and 515, add:

```typescript

          // Capture AI's final response for linked kanban ticket
          captureAIResponseForTicket(sessionId)
```

The resulting flow:

```
line 475: if (status?.type !== 'idle') return
lines 477-506: usage tracking
line 509: if pending plan → return (plan.ready handler captures those)
line 513: if command_approval → return (mid-turn, no capture)
NEW:      captureAIResponseForTicket(sessionId)
line 516: if active session → return (capture already done above)
```

Placement rationale:
- After pending plan check: `plan.ready` captures plan content directly, so idle events with pending plans would double-capture
- After command approval check: command approval means mid-turn, the AI hasn't finished yet
- Before active session check: active sessions still need their AI response captured for the ticket history

- [ ] **Step 3: Capture at deferred idle (inside `dispatchBackgroundFollowUp` finally block)**

In the `finally` block of `dispatchBackgroundFollowUp`, the deferred idle processing has its own pending plan check (line 587) and command approval check (line 591). Insert capture AFTER the command approval check (line 591) and BEFORE `const nextFollowUp` (line 593):

```typescript

                captureAIResponseForTicket(sessionId)
```

- [ ] **Step 4: Capture at `plan.ready`**

In the `plan.ready` handler (lines 409-423), after the plan is stored and status is set (line 420) but before `return` (line 422), add:

```typescript
              // Capture plan content as AI response for linked kanban ticket
              const planLinkedTicket = findLinkedKanbanTicket(sessionId)
              if (planLinkedTicket && data?.plan && data.plan.trim().length > 0) {
                window.kanban.followup.create({
                  ticket_id: planLinkedTicket.id,
                  content: data.plan,
                  role: 'assistant',
                  mode: 'plan',
                  session_id: sessionId,
                  source: 'direct'
                }).catch(() => {})
              }
```

We inline this instead of using `captureAIResponseForTicket` because the plan content is available directly from the event — no need to fetch session messages.

- [ ] **Step 5: Refactor supercharge followup to use `findLinkedKanbanTicket`**

Lines 556-570 currently inline the ticket lookup. Replace with:

```typescript
                // Persist follow-up for the linked kanban ticket
                const superchargeLinkedTicket = findLinkedKanbanTicket(sessionId)
                if (superchargeLinkedTicket) {
                  window.kanban.followup.create({
                    ticket_id: superchargeLinkedTicket.id,
                    content: message,
                    mode: useSessionStore.getState().getSessionMode(sessionId),
                    session_id: sessionId,
                    source: 'supercharge'
                  }).catch(() => {})
                }
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/hooks/useOpenCodeGlobalListener.ts
git commit -m "feat: capture AI responses at turn-completion for ticket conversation history"
```

---

### Task 4: Rename to ConversationHistory + Update Display

**Files:**
- Modify: `src/renderer/src/components/kanban/KanbanTicketModal.tsx:675-681,1011,1128-1134,1256,1346-1352,1441,1580-1618`

- [ ] **Step 1: Replace `FollowupHistory` component with `ConversationHistory`**

Replace the entire `FollowupHistory` component (lines 1580-1618) with:

```typescript
function ConversationHistory({ messages }: {
  messages: Array<{
    id: string
    content: string
    role: 'user' | 'assistant'
    mode: 'build' | 'plan'
    source: string
    created_at: string
  }>
}) {
  if (messages.length === 0) return null

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Conversation history
      </label>
      <div className="max-h-64 overflow-y-auto space-y-1.5 rounded-md border border-border/40 bg-muted/10 p-2">
        {messages.map((msg) => (
          <div key={msg.id} className={cn(
            'flex items-start gap-2 text-xs',
            msg.role === 'assistant' && 'bg-muted/30 rounded-md p-1.5 -mx-0.5'
          )}>
            <span className={cn(
              'shrink-0 mt-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
              msg.role === 'assistant'
                ? 'bg-emerald-500/10 text-emerald-500'
                : msg.mode === 'build'
                  ? 'bg-blue-500/10 text-blue-500'
                  : 'bg-violet-500/10 text-violet-500'
            )}>
              {msg.role === 'assistant' ? 'ai' : msg.mode}
            </span>
            <p className="text-foreground/80 whitespace-pre-wrap break-words flex-1 font-mono leading-relaxed">
              {msg.content}
            </p>
            <span className="shrink-0 text-muted-foreground/50 text-[10px]">
              {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

Key changes from `FollowupHistory`:
- Title: "Conversation history" instead of "Previous followups"
- `max-h-64` instead of `max-h-40` (more content now)
- Assistant messages get `bg-muted/30` background + padding
- Badge: green "ai" for assistant, blue/violet mode badge for user
- Type includes `role` field

- [ ] **Step 2: Update state type in `PlanReviewModeContent`**

Lines 675-677 currently have:

```typescript
  const [followupHistory, setFollowupHistory] = useState<Array<{
    id: string; content: string; mode: 'build' | 'plan'; source: string; created_at: string
  }>>([])
```

Replace with:

```typescript
  const [followupHistory, setFollowupHistory] = useState<Array<{
    id: string; content: string; role: 'user' | 'assistant'; mode: 'build' | 'plan'; source: string; created_at: string
  }>>([])
```

The `useEffect` on line 679-681 stays the same — `getByTicket` now returns rows with `role`.

- [ ] **Step 3: Update render in `PlanReviewModeContent`**

Line 1011: Replace `<FollowupHistory messages={followupHistory} />` with `<ConversationHistory messages={followupHistory} />`.

- [ ] **Step 4: Update state type in `ReviewModeContent`**

Lines 1128-1130 — same change as Step 2:

```typescript
  const [followupHistory, setFollowupHistory] = useState<Array<{
    id: string; content: string; role: 'user' | 'assistant'; mode: 'build' | 'plan'; source: string; created_at: string
  }>>([])
```

- [ ] **Step 5: Update render in `ReviewModeContent`**

Line 1256: Replace `<FollowupHistory messages={followupHistory} />` with `<ConversationHistory messages={followupHistory} />`.

- [ ] **Step 6: Update state type in `ErrorModeContent`**

Lines 1346-1348 — same change as Step 2:

```typescript
  const [followupHistory, setFollowupHistory] = useState<Array<{
    id: string; content: string; role: 'user' | 'assistant'; mode: 'build' | 'plan'; source: string; created_at: string
  }>>([])
```

- [ ] **Step 7: Update render in `ErrorModeContent`**

Line 1441: Replace `<FollowupHistory messages={followupHistory} />` with `<ConversationHistory messages={followupHistory} />`.

- [ ] **Step 8: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/components/kanban/KanbanTicketModal.tsx
git commit -m "feat: rename FollowupHistory to ConversationHistory with AI response display"
```

---

## Verification

After all tasks:

1. **Migration**: Start the app — schema bumps to v13, `role` column exists on `ticket_followup_messages`
2. **AI capture (build mode)**: Create a ticket, let AI work, open in review → should see AI's final message in conversation history with green "ai" badge
3. **AI capture (plan mode)**: Create a plan-mode ticket → plan.ready fires → open plan review → should see plan content as AI response
4. **Follow-up round-trip**: Send a follow-up from review mode → AI works → re-open modal → should see: AI response, your follow-up, new AI response
5. **Supercharge capture**: Supercharge a ticket → background follow-up dispatches → AI finishes → open modal → should see supercharge message + AI response
6. **Deferred idle**: Send a follow-up while AI is already processing → deferred idle fires → should still capture AI response
7. **Active session**: While viewing a session, let it complete → switch to kanban → open modal → AI response should be captured
8. **Cascade delete**: Delete a ticket → verify conversation rows are gone
9. **TypeScript**: `npx tsc --noEmit` passes
