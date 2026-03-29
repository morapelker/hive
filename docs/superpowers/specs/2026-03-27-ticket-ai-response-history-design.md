# Design: Store AI Responses in Ticket Conversation History

## Problem

Follow-up messages are now persisted (v12 migration), but the ticket modal only shows user follow-ups. The AI's response to each turn is invisible unless the user jumps to the session. We need a full conversation history: ticket description, AI response, followup, AI response, etc.

## Approach

Extend the existing `ticket_followup_messages` table with a `role` column (`'user' | 'assistant'`). Capture the AI's final assistant message at turn-completion events and store it in the same table. Display as an interleaved conversation.

## Schema Change

**v13 migration** (additive, backward-compatible):

```sql
ALTER TABLE ticket_followup_messages ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
```

Existing rows auto-default to `'user'`. New AI response rows get `role: 'assistant'`.

## Type Changes

- `TicketFollowupMessage.role: 'user' | 'assistant'`
- `TicketFollowupMessageCreate.role?: 'user' | 'assistant'` (defaults to `'user'`)

## Capture Mechanism

Two capture points in `useOpenCodeGlobalListener.ts`:

### 1. `session.status` idle (line ~475)

When the AI finishes a turn, `session.status` fires with `type: 'idle'`. This is the authoritative turn-complete signal. At this point:

1. Find the linked kanban ticket by session ID (same pattern as the supercharge followup code)
2. Fetch messages via `window.db.sessionMessage.list(sessionId)`
3. Find the last assistant message: `messages.reverse().find(m => m.role === 'assistant' && m.content.trim().length > 0)`
4. Store it: `window.kanban.followup.create({ ticket_id, content, mode, session_id, role: 'assistant', source: 'direct' })`

This must happen BEFORE dispatching any queued follow-ups, so the conversation stays chronologically correct.

### 2. `plan.ready` (line ~409)

The plan content (`data?.plan`) IS the AI's response for that turn. Store it with `role: 'assistant'`, `mode: 'plan'`.

### Not capturing on error

There is no explicit error status in `SessionStatusType`. AI execution errors result in the session going idle (covered by capture point 1). Dispatch errors (context resolution fails, prompt fails) don't produce meaningful AI responses.

## Fetching the Last Assistant Message

Existing API: `window.db.sessionMessage.list(sessionId)` returns `SessionMessage[]` ordered by `created_at ASC`.

`SessionMessage.content` contains the plain text extraction of the message (tool calls, code, etc. are in `opencode_message_json`). For the conversation history, `content` is what we display — it's the same text the user sees in the session view.

Pattern (already used in SessionView.tsx):
```typescript
const messages = await window.db.sessionMessage.list(sessionId)
const last = [...messages].reverse().find(m => m.role === 'assistant' && m.content.trim().length > 0)
```

## Display

Rename `FollowupHistory` to `ConversationHistory`. The component receives all messages (both roles) and renders:

1. **Ticket description** — always shown first as the opening context (rendered outside the component, as it already is)
2. **Assistant messages** — muted background, "AI" label, monospace text
3. **User follow-ups** — current blue/violet badge style

The `max-h-40` constraint should increase to `max-h-64` or more since the history will be longer with AI responses included.

## Files to Modify

| File | Change |
|------|--------|
| `src/main/db/types.ts` | Add `role` to both interfaces |
| `src/main/db/schema.ts` | v13 migration: ALTER TABLE add `role` column |
| `src/main/db/database.ts` | Pass `role` through in create method |
| `src/main/ipc/kanban-handlers.ts` | No change (pass-through) |
| `src/preload/index.ts` | Add `role` to the inline type in `followup.create` |
| `src/preload/index.d.ts` | Add `role` to the type declarations |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` | Add capture at `session.status` idle + `plan.ready` |
| `src/renderer/src/components/kanban/KanbanTicketModal.tsx` | Rename `FollowupHistory` to `ConversationHistory`, update styling for both roles |
