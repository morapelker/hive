# Hive Phase 12 Implementation Plan

This document outlines the implementation plan for Hive Phase 12, focusing on prompt history navigation, context calculation accuracy, queued message UX, compact tool card redesign, todo list rendering, markdown file preview, session auto-focus, archive loading states, and file viewer context menus.

---

## Overview

The implementation is divided into **10 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 12 builds upon Phase 11** — all Phase 11 infrastructure is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 12)

```
test/
├── phase-12/
│   ├── session-1/
│   │   └── context-calculation.test.ts
│   ├── session-2/
│   │   └── prompt-history.test.ts
│   ├── session-3/
│   │   └── queued-messages.test.ts
│   ├── session-4/
│   │   └── compact-file-tools.test.ts
│   ├── session-5/
│   │   └── todo-list-view.test.ts
│   ├── session-6/
│   │   └── markdown-preview.test.ts
│   ├── session-7/
│   │   └── session-autofocus.test.ts
│   ├── session-8/
│   │   └── archive-loading.test.ts
│   ├── session-9/
│   │   └── file-viewer-context-menu.test.ts
│   └── session-10/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies — all features use existing packages:
# - zustand (stores — already installed)
# - react-markdown + remark-gfm (markdown rendering — already installed)
# - lucide-react (icons — already installed)
# - react-syntax-highlighter (code display — already installed)
# - @radix-ui/react-context-menu via shadcn (context menus — already installed)
```

---

## Session 1: Context Calculation Fix

### Objectives

- Rewrite the context token calculation to match the official OpenCode client implementation
- Use snapshot-based approach (last assistant message with tokens > 0) instead of cumulative accumulation
- Fix the total formula: `total = input + output + reasoning + cache.read + cache.write`
- Add session cost tracking (sum of `.cost` across all assistant messages)
- Simplify token extraction in SessionView.tsx

### Tasks

#### 1. Rewrite `useContextStore.ts`

In `src/renderer/src/stores/useContextStore.ts`, replace the entire store:

**Key changes:**

- Replace `addMessageTokens` (cumulative) with `setSessionTokens` (snapshot replacement)
- Add `costBySession` record and `setSessionCost` / `addSessionCost` actions
- Fix `getContextUsage` formula: `used = input + output + reasoning + cacheRead + cacheWrite`
- Usage percent: `Math.round((used / limit) * 100)`

```typescript
interface ContextState {
  tokensBySession: Record<string, TokenInfo>
  costBySession: Record<string, number>
  modelLimits: Record<string, number>
  // Actions
  setSessionTokens: (sessionId: string, tokens: TokenInfo) => void // REPLACE, not add
  addSessionCost: (sessionId: string, cost: number) => void
  setSessionCost: (sessionId: string, cost: number) => void
  resetSessionTokens: (sessionId: string) => void
  setModelLimit: (modelId: string, limit: number) => void
  // Derived
  getContextUsage: (
    sessionId: string,
    modelId: string
  ) => {
    used: number
    limit: number
    percent: number
    tokens: TokenInfo
    cost: number
  }
}
```

The `setSessionTokens` action must fully replace the session's token snapshot — NOT add to existing values.

#### 2. Create `extractTokens` helper

Add a shared utility function (can live in `useContextStore.ts` or a separate `src/renderer/src/lib/token-utils.ts`):

```typescript
function extractTokens(messageData: Record<string, unknown>): TokenInfo | null {
  const tokens = messageData.tokens as Record<string, unknown> | undefined
  if (!tokens) return null

  const cache = tokens.cache as Record<string, number> | undefined
  const info: TokenInfo = {
    input: (tokens.input as number) || 0,
    output: (tokens.output as number) || 0,
    reasoning: (tokens.reasoning as number) || 0,
    cacheRead: cache?.read || 0,
    cacheWrite: cache?.write || 0
  }

  const total = info.input + info.output + info.reasoning + info.cacheRead + info.cacheWrite
  return total > 0 ? info : null
}
```

This replaces the fragile multi-format parsing that currently exists in SessionView.tsx (handling `cacheRead`, `cache_read`, `cache.read` variants). The server's JSON format uses `tokens.cache.read` / `tokens.cache.write` consistently.

#### 3. Update token extraction on DB load in `SessionView.tsx`

Replace the current cumulative token parsing loop (around lines 710-738) with:

- Walk backward through `dbMessages` to find the last assistant message with tokens > 0
- Call `extractTokens()` on the parsed `opencode_message_json`
- Call `useContextStore.getState().setSessionTokens(sessionId, tokens)` — single snapshot set
- Separately, sum `.cost` across ALL assistant messages for total session cost
- Call `useContextStore.getState().setSessionCost(sessionId, totalCost)`

**Important:** Remove all calls to `addMessageTokens` — they no longer exist. The store only has `setSessionTokens` now.

#### 4. Update token extraction on streaming in `SessionView.tsx`

Replace the current streaming token update (around lines 1108-1135) with:

- On `message.updated` events where `data.info?.time?.completed` is set, call `extractTokens(data)`
- If tokens found, call `setSessionTokens` (replace snapshot)
- If `data.cost > 0`, call `addSessionCost` (accumulate cost for this new message)

#### 5. Update `ContextIndicator.tsx`

- Update the `useMemo` that computes `used`: change from `t.input + t.output + t.cacheRead` to `t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite`
- Add cost reading from the store: `const cost = useContextStore((state) => state.costBySession[sessionId]) ?? 0`
- Add cost display in tooltip (below the token breakdown):

```tsx
{
  cost > 0 && (
    <div className="border-t border-background/20 pt-1.5">
      <div>Session cost: ${cost.toFixed(4)}</div>
    </div>
  )
}
```

#### 6. Verify no remaining `addMessageTokens` calls

Search the codebase for `addMessageTokens` and remove all references. Every call site should be converted to use `setSessionTokens`.

### Key Files

- `src/renderer/src/stores/useContextStore.ts` — full rewrite
- `src/renderer/src/components/sessions/SessionView.tsx` — simplify DB load and streaming token extraction
- `src/renderer/src/components/sessions/ContextIndicator.tsx` — fix formula, add cost display

### Definition of Done

- [ ] `useContextStore` uses `setSessionTokens` (snapshot) instead of `addMessageTokens` (cumulative)
- [ ] Total formula: `used = input + output + reasoning + cacheRead + cacheWrite`
- [ ] Usage percent: `Math.round((used / limit) * 100)`
- [ ] Token data sourced from last assistant message with tokens > 0 (walk backward)
- [ ] Session cost summed across all assistant messages
- [ ] ContextIndicator tooltip shows all 5 token categories + session cost
- [ ] No remaining `addMessageTokens` references in the codebase
- [ ] `extractTokens` helper handles missing/null fields gracefully
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a session, send several messages
2. Check the context bar tooltip — verify total = input + output + reasoning + cache.read + cache.write
3. Compare the displayed context percentage with the official OpenCode TUI for the same session
4. Verify the percentage does NOT grow monotonically across messages (it should reflect the latest assistant message's snapshot, which can go down after compaction)
5. Check that session cost appears in the tooltip and accumulates across messages
6. Send a message, then reload the session from DB — verify context indicator shows the same values

### Testing Criteria

```typescript
// test/phase-12/session-1/context-calculation.test.ts
describe('Session 1: Context Calculation Fix', () => {
  describe('useContextStore', () => {
    test('setSessionTokens replaces (not accumulates) tokens', () => {
      const store = useContextStore.getState()
      store.setSessionTokens('s1', {
        input: 100,
        output: 50,
        reasoning: 10,
        cacheRead: 30,
        cacheWrite: 20
      })
      store.setSessionTokens('s1', {
        input: 200,
        output: 80,
        reasoning: 0,
        cacheRead: 50,
        cacheWrite: 10
      })
      const usage = store.getContextUsage('s1', 'model1')
      // Should be 200+80+0+50+10 = 340, NOT 300+130+10+80+30 = 550
      expect(usage.used).toBe(340)
    })

    test('getContextUsage computes correct total with all 5 categories', () => {
      const store = useContextStore.getState()
      store.setModelLimit('model1', 200000)
      store.setSessionTokens('s1', {
        input: 15000,
        output: 2000,
        reasoning: 500,
        cacheRead: 3000,
        cacheWrite: 1500
      })
      const usage = store.getContextUsage('s1', 'model1')
      expect(usage.used).toBe(22000) // 15000+2000+500+3000+1500
      expect(usage.percent).toBe(11) // Math.round(22000/200000*100)
    })

    test('cost tracks per session', () => {
      const store = useContextStore.getState()
      store.setSessionCost('s1', 0.01)
      store.addSessionCost('s1', 0.005)
      const usage = store.getContextUsage('s1', 'model1')
      expect(usage.cost).toBeCloseTo(0.015)
    })
  })

  describe('extractTokens', () => {
    test('parses standard token format', () => {
      const result = extractTokens({
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 30, write: 20 } }
      })
      expect(result).toEqual({
        input: 100,
        output: 50,
        reasoning: 10,
        cacheRead: 30,
        cacheWrite: 20
      })
    })

    test('returns null when no tokens', () => {
      expect(extractTokens({})).toBeNull()
    })

    test('returns null when all zeros', () => {
      const result = extractTokens({
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      })
      expect(result).toBeNull()
    })

    test('handles missing cache field', () => {
      const result = extractTokens({ tokens: { input: 100, output: 50 } })
      expect(result).toEqual({ input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    })
  })
})
```

---

## Session 2: Prompt History Navigation

### Objectives

- Create a per-branch prompt history store persisted to localStorage
- Add Up/Down arrow key navigation in the message textarea
- Save every sent prompt to history, deduplicated, max 100 per branch
- Preserve the current draft when entering history navigation mode

### Tasks

#### 1. Create `usePromptHistoryStore.ts`

Create `src/renderer/src/stores/usePromptHistoryStore.ts`:

- State: `historyByWorktree: Record<string, string[]>` (worktreeId → ordered prompts, newest last)
- Actions:
  - `addPrompt(worktreeId, prompt)`: Trim, deduplicate (remove existing match), append, cap at 100 (FIFO eviction)
  - `getHistory(worktreeId)`: Return the array or empty
- Persist to localStorage via `createJSONStorage` with key `'hive-prompt-history'`

#### 2. Export from store barrel

In `src/renderer/src/stores/index.ts`, add `export { usePromptHistoryStore } from './usePromptHistoryStore'`.

#### 3. Add history navigation state to SessionView

In `src/renderer/src/components/sessions/SessionView.tsx`:

- Add `const [historyIndex, setHistoryIndex] = useState<number | null>(null)` — null means not navigating
- Add `const savedDraftRef = useRef<string>('')` — stores the draft before entering navigation

#### 4. Modify `handleKeyDown` in SessionView

Extend the existing `handleKeyDown` (lines 1671-1679) with Up/Down arrow handling:

**ArrowUp guard:** Only activate when `textarea.selectionStart === 0 && textarea.selectionEnd === 0` (cursor at very beginning). This ensures normal multi-line cursor movement still works.

**ArrowUp behavior:**

- If `historyIndex === null`: save current `inputValue` as draft, set index to `history.length - 1`, load that prompt
- If `historyIndex > 0`: decrement index, load prompt at new index
- If `historyIndex === 0`: do nothing (at oldest entry)

**ArrowDown guard:** Only activate when `textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length` (cursor at very end).

**ArrowDown behavior:**

- If `historyIndex !== null && historyIndex < history.length - 1`: increment index, load prompt at new index
- If `historyIndex === history.length - 1`: exit navigation, restore saved draft, set index to null
- If `historyIndex === null`: do nothing

#### 5. Reset navigation on manual typing

When the user types (onChange fires while `historyIndex !== null`), reset `historyIndex` to null. The current text stays as-is. This allows users to recall a prompt and then edit it.

#### 6. Record sent prompts to history

In `handleSend`, after the message is successfully sent, call:

```typescript
usePromptHistoryStore.getState().addPrompt(worktreeId, trimmedValue)
setHistoryIndex(null)
savedDraftRef.current = ''
```

The `worktreeId` comes from the already-available `selectedWorktreeId` or derived from the session's `worktree_id`.

#### 7. Reset history index on session change

Add a `useEffect` that resets `historyIndex` to null and clears `savedDraftRef` when `sessionId` changes, so history navigation state doesn't leak across sessions.

### Key Files

- `src/renderer/src/stores/usePromptHistoryStore.ts` — **NEW**
- `src/renderer/src/stores/index.ts` — export
- `src/renderer/src/components/sessions/SessionView.tsx` — handleKeyDown extension, state, recording

### Definition of Done

- [ ] `usePromptHistoryStore` persists to localStorage under `'hive-prompt-history'`
- [ ] Up arrow at cursor position 0 loads the most recent prompt from history
- [ ] Repeated Up arrows walk backward through history
- [ ] Down arrow at cursor end walks forward, then restores draft
- [ ] Up/Down arrows at non-boundary cursor positions do nothing (normal cursor movement)
- [ ] Typing while navigating exits navigation mode, keeps current text
- [ ] Sending a message adds it to history
- [ ] Duplicate consecutive prompts are deduplicated
- [ ] Max 100 prompts per branch (oldest evicted)
- [ ] History survives app restart (localStorage)
- [ ] History index resets on session change
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send three messages: "hello", "fix the bug", "add tests"
2. Clear the input, press Up arrow — verify "add tests" appears
3. Press Up again — verify "fix the bug" appears
4. Press Up again — verify "hello" appears
5. Press Up again — verify nothing changes (at oldest)
6. Press Down — verify "fix the bug" appears
7. Press Down — verify "add tests" appears
8. Press Down — verify input clears (back to draft)
9. Type "partial text", then press Up — verify "add tests" appears and "partial text" is saved
10. Press Down past end — verify "partial text" is restored
11. With cursor in the middle of a multi-line message, press Up — verify normal cursor movement (not history)
12. Restart the app — verify history is still available
13. Switch to a different branch — verify that branch has its own history

### Testing Criteria

```typescript
// test/phase-12/session-2/prompt-history.test.ts
describe('Session 2: Prompt History', () => {
  describe('usePromptHistoryStore', () => {
    test('addPrompt appends to history', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', 'hello')
      store.addPrompt('wt1', 'world')
      expect(store.getHistory('wt1')).toEqual(['hello', 'world'])
    })

    test('deduplicates same prompt', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', 'hello')
      store.addPrompt('wt1', 'world')
      store.addPrompt('wt1', 'hello')
      expect(store.getHistory('wt1')).toEqual(['world', 'hello'])
    })

    test('caps at 100 entries', () => {
      const store = usePromptHistoryStore.getState()
      for (let i = 0; i < 110; i++) {
        store.addPrompt('wt1', `msg-${i}`)
      }
      const history = store.getHistory('wt1')
      expect(history.length).toBe(100)
      expect(history[0]).toBe('msg-10') // oldest 10 evicted
      expect(history[99]).toBe('msg-109')
    })

    test('empty/whitespace prompts ignored', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', '')
      store.addPrompt('wt1', '   ')
      expect(store.getHistory('wt1')).toEqual([])
    })

    test('histories are per-worktree', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', 'branch-a')
      store.addPrompt('wt2', 'branch-b')
      expect(store.getHistory('wt1')).toEqual(['branch-a'])
      expect(store.getHistory('wt2')).toEqual(['branch-b'])
    })
  })

  describe('keyboard navigation', () => {
    test('Up arrow at position 0 loads last prompt', () => {
      // Mock history: ['hello', 'world']
      // Simulate: cursor at pos 0, press ArrowUp
      // Verify inputValue becomes 'world'
    })

    test('Up arrow at non-zero position is ignored', () => {
      // Simulate: cursor at pos 3 in 'hello', press ArrowUp
      // Verify inputValue unchanged (normal cursor behavior)
    })

    test('Down arrow at end restores draft', () => {
      // Start with draft 'my draft', navigate up, then down past end
      // Verify inputValue becomes 'my draft'
    })

    test('typing during navigation exits navigation mode', () => {
      // Navigate to history entry, then type a character
      // Verify historyIndex reset to null
    })
  })
})
```

---

## Session 3: Queued Message Placement

### Objectives

- Replace the simple `queuedCount` counter with a content-tracking array
- Render queued messages as visible bubbles at the bottom of the chat
- Show a QUEUED badge on each queued bubble
- Transform queued bubbles into normal messages when the stream completes

### Tasks

#### 1. Replace `queuedCount` state with `queuedMessages` array

In `src/renderer/src/components/sessions/SessionView.tsx`:

Replace:

```typescript
const [queuedCount, setQueuedCount] = useState(0)
```

With:

```typescript
const [queuedMessages, setQueuedMessages] = useState<
  Array<{
    id: string
    content: string
    timestamp: number
  }>
>([])
```

#### 2. Update `handleSend` for queued messages

When `isQueuedMessage` (sending while streaming):

```typescript
if (isQueuedMessage) {
  setQueuedMessages((prev) => [
    ...prev,
    { id: crypto.randomUUID(), content: trimmedValue, timestamp: Date.now() }
  ])
}
```

#### 3. Clear queued messages on idle

On `session.idle` or `session.status { type: 'idle' }` events, clear the array:

```typescript
setQueuedMessages([])
```

Also handle partial clearing: when a new user message appears in the stream that matches a queued message's content, remove that specific queued message from the array. This handles the case where multiple messages are queued — they should disappear one by one as they are processed.

#### 4. Create `QueuedMessageBubble.tsx`

Create `src/renderer/src/components/sessions/QueuedMessageBubble.tsx`:

- Same visual style as `UserBubble` but with `opacity-70`
- QUEUED badge: small pill with `bg-primary-foreground/20` text styling
- Content rendered as `text-sm whitespace-pre-wrap break-words`

```tsx
export function QueuedMessageBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end opacity-70">
      <div className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 bg-primary text-primary-foreground">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-medium bg-primary-foreground/20 rounded px-1.5 py-0.5">
            QUEUED
          </span>
        </div>
        <div className="text-sm whitespace-pre-wrap break-words">{content}</div>
      </div>
    </div>
  )
}
```

#### 5. Render queued bubbles at the bottom of the message list

In SessionView's message rendering area, after all rendered messages and before the input area:

```tsx
{
  queuedMessages.map((msg) => <QueuedMessageBubble key={msg.id} content={msg.content} />)
}
```

Ensure these render inside the scrollable message container so they auto-scroll into view.

#### 6. Remove or update `QueuedIndicator`

The existing `QueuedIndicator.tsx` (which just shows a count) should be removed from the input area since the queued messages are now visible in the chat. Either delete the file or repurpose it. Remove the `<QueuedIndicator count={queuedCount} />` from the input area JSX.

### Key Files

- `src/renderer/src/components/sessions/QueuedMessageBubble.tsx` — **NEW**
- `src/renderer/src/components/sessions/SessionView.tsx` — state change, render, clear logic
- `src/renderer/src/components/sessions/QueuedIndicator.tsx` — remove or repurpose

### Definition of Done

- [ ] Queued messages stored as `{ id, content, timestamp }[]` instead of a count
- [ ] Queued messages render as styled bubbles at the bottom of the chat
- [ ] Each queued bubble shows a QUEUED badge
- [ ] Queued bubbles have reduced opacity (70%) to distinguish from sent messages
- [ ] Queued bubbles cleared when session goes idle
- [ ] Old `QueuedIndicator` count text removed from input area
- [ ] Multiple queued messages display as stacked bubbles
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a long streaming response (send a complex prompt)
2. While streaming, type a follow-up message and send it
3. Verify the follow-up appears at the bottom of the chat as a bubble with QUEUED badge and reduced opacity
4. Queue a second message — verify both appear stacked
5. Wait for streaming to complete — verify the queued bubbles disappear and the real messages appear in the chat history
6. Verify the input area no longer shows the old "X messages queued" text

### Testing Criteria

```typescript
// test/phase-12/session-3/queued-messages.test.ts
describe('Session 3: Queued Messages', () => {
  test('QueuedMessageBubble renders content with QUEUED badge', () => {
    render(<QueuedMessageBubble content="fix the imports" />)
    expect(screen.getByText('QUEUED')).toBeInTheDocument()
    expect(screen.getByText('fix the imports')).toBeInTheDocument()
  })

  test('QueuedMessageBubble has reduced opacity', () => {
    const { container } = render(<QueuedMessageBubble content="test" />)
    expect(container.firstChild).toHaveClass('opacity-70')
  })

  test('queued messages accumulate on send during streaming', () => {
    // Mock isStreaming = true
    // Call handleSend with 'msg1', then 'msg2'
    // Verify queuedMessages has 2 entries
  })

  test('queued messages cleared on session idle', () => {
    // Set queuedMessages to [{ id: '1', content: 'test', timestamp: 0 }]
    // Simulate session.status { type: 'idle' }
    // Verify queuedMessages is empty
  })
})
```

---

## Session 4: Read/Write/Edit Compact Inline Redesign

### Objectives

- Change Read, Write, and Edit tool calls from full-width bordered cards to compact single-line entries
- Show status icons: spinner when loading, `+` when done (collapsed), `-` when expanded
- Keep expansion behavior for viewing full content
- Only affect Read/Write/Edit — all other tools keep their current card design

### Tasks

#### 1. Add `isFileOperation` detection function

In `src/renderer/src/components/sessions/ToolCard.tsx`, add a function to detect file operation tools:

```typescript
function isFileOperation(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.includes('read') ||
    lower === 'cat' ||
    lower === 'view' ||
    lower.includes('write') ||
    lower === 'create' ||
    lower.includes('edit') ||
    lower.includes('replace') ||
    lower.includes('patch')
  )
}
```

#### 2. Create `CompactFileToolCard` component

Add a new internal component in `ToolCard.tsx` (not a separate file — it shares helpers):

- No border, no card background, no left color accent
- Single line: `{icon} {tool_name} {file_path}`
- Icon is:
  - `Loader2` (animate-spin) — when running and NOT expanded
  - `Minus` — when expanded (regardless of running/done)
  - `Plus` (green) — when complete and collapsed
  - `X` (red) — when error and collapsed
- Clickable — toggles expansion
- Expanded content indented with `ml-5`, shows existing tool renderer (ReadToolView/WriteToolView/EditToolView)
- Tool label: "Read", "Write", or "Edit" (resolved from tool name)
- File path shortened relative to cwd (using existing `shortenPath`)
- Uses `getToolRenderer` to get the appropriate expanded renderer

#### 3. Modify `ToolCard` export to route file operations

In the main `ToolCard` component:

```typescript
export const ToolCard = memo(function ToolCard({ toolUse, cwd, compact = false }: ToolCardProps) {
  // Route file operations to compact layout
  if (isFileOperation(toolUse.name)) {
    return <CompactFileToolCard toolUse={toolUse} cwd={cwd} />
  }

  // Existing card layout for all other tools
  // ... (keep current code unchanged)
})
```

#### 4. Add `Minus` and `Plus` to lucide imports

Add `Minus` and `Plus` to the existing lucide-react import at the top of `ToolCard.tsx`.

### Key Files

- `src/renderer/src/components/sessions/ToolCard.tsx` — `isFileOperation`, `CompactFileToolCard`, routing logic

### Definition of Done

- [ ] Read, Write, and Edit tool calls render as compact single-line entries (no border/card)
- [ ] Status icon: spinner when loading, `+` when done, `-` when expanded, `x` on error
- [ ] Clicking the line toggles expansion to show full tool output
- [ ] Expanded view uses existing ReadToolView/WriteToolView/EditToolView
- [ ] Expansion can happen while tool is still running (icon changes from spinner to `-`)
- [ ] Bash, Grep, Glob, Task, Question tools are unchanged (still use card design)
- [ ] Compact lines take ~24px vertical height when collapsed
- [ ] Error state shows red icon and red-tinted file path
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a prompt that triggers Read tool calls — verify they render as compact lines, not cards
2. Verify the spinner icon shows while the tool is running
3. Wait for completion — verify the icon changes to green `+`
4. Click the line — verify it expands to show syntax-highlighted file content with `-` icon
5. Click again — verify it collapses back to `+`
6. Send a prompt that triggers Write and Edit — verify same compact behavior
7. Send a prompt that triggers Bash — verify it still uses the bordered card design
8. Trigger an error (e.g., Read a non-existent file) — verify red `x` icon and red path text
9. Click to expand a running tool call — verify spinner changes to `-` icon and content shows

### Testing Criteria

```typescript
// test/phase-12/session-4/compact-file-tools.test.ts
describe('Session 4: Compact File Tools', () => {
  test('isFileOperation detects read/write/edit tools', () => {
    expect(isFileOperation('Read')).toBe(true)
    expect(isFileOperation('read_file')).toBe(true)
    expect(isFileOperation('Write')).toBe(true)
    expect(isFileOperation('Edit')).toBe(true)
    expect(isFileOperation('Bash')).toBe(false)
    expect(isFileOperation('Grep')).toBe(false)
    expect(isFileOperation('Task')).toBe(false)
  })

  test('compact tool shows file path', () => {
    render(<ToolCard toolUse={{
      id: '1', name: 'Read', status: 'success',
      input: { filePath: '/project/src/App.tsx' },
      output: 'file content', startTime: 0, endTime: 100
    }} />)
    expect(screen.getByText(/App\.tsx/)).toBeInTheDocument()
    expect(screen.getByText('Read')).toBeInTheDocument()
  })

  test('compact tool shows spinner when running', () => {
    render(<ToolCard toolUse={{
      id: '1', name: 'Read', status: 'running',
      input: { filePath: '/project/src/App.tsx' },
      startTime: 0
    }} />)
    expect(screen.getByTestId('tool-spinner')).toBeInTheDocument()
  })

  test('compact tool expands on click', async () => {
    render(<ToolCard toolUse={{
      id: '1', name: 'Read', status: 'success',
      input: { filePath: '/project/src/App.tsx' },
      output: '<file>\n00001| const x = 1\n</file>', startTime: 0, endTime: 100
    }} />)
    await userEvent.click(screen.getByTestId('compact-file-tool'))
    expect(screen.getByTestId('read-tool-view')).toBeInTheDocument()
  })

  test('non-file tools still use card layout', () => {
    render(<ToolCard toolUse={{
      id: '1', name: 'Bash', status: 'success',
      input: { command: 'ls' }, output: 'file.txt', startTime: 0, endTime: 100
    }} />)
    expect(screen.getByTestId('tool-card')).toBeInTheDocument()
  })
})
```

---

## Session 5: TodoWrite Tool Rendering

### Objectives

- Detect TodoWrite tool calls and render them as a proper todo list
- Show status icons (check, spinner, circle, x) and priority badges (high/medium/low)
- Register the renderer for all TodoWrite name variants
- Add collapsed content showing task progress (`X/Y completed`)

### Tasks

#### 1. Create `TodoListView.tsx`

Create `src/renderer/src/components/sessions/tools/TodoListView.tsx`:

- Parse `input.todos` as an array of `{ id, content, status, priority }` items
- Render each item as a row with:
  - Status icon: `CheckCircle2` (green) for completed, `Loader2` (blue, spinning) for in_progress, `Circle` (gray) for pending, `XCircle` (muted) for cancelled
  - Content text (truncated with `truncate` class)
  - Priority badge: red pill for high, yellow pill for medium, gray pill for low
- Cancelled items: `opacity-50 line-through`
- If `parseTodos` returns null or empty, return null (fall back to generic view)

#### 2. Register TodoWrite in `TOOL_RENDERERS`

In `src/renderer/src/components/sessions/ToolCard.tsx`:

```typescript
import { TodoListView } from './tools/TodoListView'

// Add to TOOL_RENDERERS map:
TodoWrite: TodoListView,
todowrite: TodoListView,
mcp_todowrite: TodoListView,
todo_write: TodoListView,
```

#### 3. Update `getToolRenderer` fallback

In the `getToolRenderer` function, add before the final `TodoToolView` fallback:

```typescript
if (lower.includes('todo')) return TodoListView
```

#### 4. Add collapsed content for TodoWrite

In `ToolCard.tsx`, add a new branch in `CollapsedContent` for todo tools:

```typescript
if (lowerName.includes('todo')) {
  const todos = input.todos as Array<{ status: string }> | undefined
  const completed = todos?.filter(t => t.status === 'completed').length || 0
  const total = todos?.length || 0
  return (
    <>
      <span className="text-muted-foreground shrink-0">
        <ListTodo className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground shrink-0">Tasks</span>
      <span className="text-muted-foreground text-[10px]">
        {completed}/{total} completed
      </span>
    </>
  )
}
```

Add `ListTodo` to the lucide-react imports.

#### 5. Add `ListTodo` to icon resolver

In `getToolIcon`, add:

```typescript
if (lowerName.includes('todo')) {
  return <ListTodo className={iconClass} />
}
```

### Key Files

- `src/renderer/src/components/sessions/tools/TodoListView.tsx` — **NEW**
- `src/renderer/src/components/sessions/ToolCard.tsx` — register renderer, collapsed content, icon

### Definition of Done

- [ ] TodoWrite tool calls render as a proper checklist instead of raw JSON
- [ ] Status icons: green check (completed), blue spinner (in_progress), gray circle (pending), muted x (cancelled)
- [ ] Priority badges: red (high), yellow (medium), gray (low)
- [ ] Cancelled items have reduced opacity and strikethrough
- [ ] Collapsed card header shows "Tasks: X/Y completed"
- [ ] All name variants recognized: `TodoWrite`, `todowrite`, `mcp_todowrite`, `todo_write`
- [ ] Falls back to generic TodoToolView if `input.todos` is missing or not an array
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Trigger an AI response that uses the TodoWrite tool (or mock one in devtools)
2. Verify the collapsed card shows "Tasks: X/Y completed" with a `ListTodo` icon
3. Expand the card — verify a checklist renders with icons and badges
4. Verify completed items show green checks
5. Verify in_progress items show blue spinners
6. Verify pending items show gray circles
7. Verify cancelled items are dimmed with strikethrough
8. Verify high priority items have red badges, medium have yellow

### Testing Criteria

```typescript
// test/phase-12/session-5/todo-list-view.test.ts
describe('Session 5: TodoListView', () => {
  const sampleTodos = [
    { id: '1', content: 'Setup types', status: 'completed', priority: 'high' },
    { id: '2', content: 'Write handler', status: 'in_progress', priority: 'high' },
    { id: '3', content: 'Add tests', status: 'pending', priority: 'medium' },
    { id: '4', content: 'Old task', status: 'cancelled', priority: 'low' }
  ]

  test('renders all todo items', () => {
    render(<TodoListView name="TodoWrite" input={{ todos: sampleTodos }} status="success" />)
    expect(screen.getByText('Setup types')).toBeInTheDocument()
    expect(screen.getByText('Write handler')).toBeInTheDocument()
    expect(screen.getByText('Add tests')).toBeInTheDocument()
    expect(screen.getByText('Old task')).toBeInTheDocument()
  })

  test('renders priority badges', () => {
    render(<TodoListView name="TodoWrite" input={{ todos: sampleTodos }} status="success" />)
    expect(screen.getAllByText('high')).toHaveLength(2)
    expect(screen.getByText('medium')).toBeInTheDocument()
    expect(screen.getByText('low')).toBeInTheDocument()
  })

  test('returns null for missing todos', () => {
    const { container } = render(<TodoListView name="TodoWrite" input={{}} status="success" />)
    expect(container.firstChild).toBeNull()
  })

  test('cancelled items have line-through', () => {
    render(<TodoListView name="TodoWrite" input={{ todos: sampleTodos }} status="success" />)
    const cancelledItem = screen.getByText('Old task').closest('div')
    expect(cancelledItem).toHaveClass('line-through')
  })

  test('ToolCard recognizes TodoWrite and uses TodoListView', () => {
    const renderer = getToolRenderer('mcp_todowrite')
    expect(renderer).toBe(TodoListView)
  })
})
```

---

## Session 6: Markdown Rendering in File Viewer

### Objectives

- Detect `.md` and `.mdx` files in the file viewer
- Render them through `MarkdownRenderer` by default instead of syntax highlighting
- Add a Source/Preview toggle in the file path bar

### Tasks

#### 1. Add markdown detection

In `src/renderer/src/components/file-viewer/FileViewer.tsx`, add a helper:

```typescript
function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  return ext === '.md' || ext === '.mdx'
}
```

#### 2. Add view mode state

In the `FileViewer` component:

```typescript
const isMarkdown = isMarkdownFile(filePath)
const [viewMode, setViewMode] = useState<'preview' | 'source'>(isMarkdown ? 'preview' : 'source')
```

Add an effect to reset view mode when `filePath` changes:

```typescript
useEffect(() => {
  setViewMode(isMarkdownFile(filePath) ? 'preview' : 'source')
}, [filePath])
```

#### 3. Add Source/Preview toggle in the file path bar

In the file path bar div (line 202), add toggle buttons when the file is markdown:

```tsx
<div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border bg-muted/30 flex items-center justify-between">
  <span className="truncate">{filePath}</span>
  {isMarkdown && (
    <div className="flex items-center gap-1 shrink-0 ml-2">
      <button
        onClick={() => setViewMode('source')}
        className={cn(
          'px-2 py-0.5 rounded text-xs transition-colors',
          viewMode === 'source' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
        )}
      >
        Source
      </button>
      <button
        onClick={() => setViewMode('preview')}
        className={cn(
          'px-2 py-0.5 rounded text-xs transition-colors',
          viewMode === 'preview' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
        )}
      >
        Preview
      </button>
    </div>
  )}
</div>
```

#### 4. Conditional rendering for markdown preview

Replace the content area to conditionally render:

```tsx
{viewMode === 'preview' && isMarkdown ? (
  <div className="flex-1 overflow-auto p-6 prose prose-sm dark:prose-invert max-w-none">
    <MarkdownRenderer content={content} />
  </div>
) : (
  <div ref={containerRef} className="flex-1 overflow-auto" data-testid="file-viewer-content">
    <SyntaxHighlighter ...>{content}</SyntaxHighlighter>
  </div>
)}
```

#### 5. Import `MarkdownRenderer`

Add import at the top of `FileViewer.tsx`:

```typescript
import { MarkdownRenderer } from '@/components/sessions/MarkdownRenderer'
```

Verify that `MarkdownRenderer` accepts a `content` prop (it currently receives `content` as a string). If it uses `children` instead, update the prop interface to also accept `content` or adjust the call site.

#### 6. Ensure search works in both modes

When in preview mode, the Cmd+F file search should still work on the raw content. The search overlay (`FileSearch`) already operates on the `content` string, not the rendered DOM. However, match highlighting (yellow background on lines) only applies to the `SyntaxHighlighter`. In preview mode, search match highlighting is not feasible — this is acceptable. Just ensure the search open/navigate still works.

### Key Files

- `src/renderer/src/components/file-viewer/FileViewer.tsx` — markdown detection, toggle, conditional render
- `src/renderer/src/components/sessions/MarkdownRenderer.tsx` — verify reusability (may need minor prop adjustment)

### Definition of Done

- [ ] `.md` files open in Preview mode by default (rendered markdown)
- [ ] `.mdx` files also open in Preview mode
- [ ] Source/Preview toggle buttons appear in the file path bar for markdown files
- [ ] Toggle buttons do NOT appear for non-markdown files
- [ ] Clicking "Source" shows raw syntax-highlighted markdown
- [ ] Clicking "Preview" shows rendered markdown with proper headers, links, code blocks, tables
- [ ] Links in preview are clickable and open in external browser (`target="_blank"`)
- [ ] Switching files resets the view mode appropriately
- [ ] Non-markdown files are unaffected (always show syntax highlighting)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open a `.md` file (e.g., README.md) in the file viewer
2. Verify it shows rendered markdown with styled headers, links, code blocks
3. Click "Source" — verify raw markdown source with syntax highlighting
4. Click "Preview" — verify rendered markdown again
5. Open a `.ts` file — verify no Source/Preview toggle, shows syntax highlighting
6. Open a `.mdx` file — verify it also shows rendered markdown by default
7. Click a link in the preview — verify it opens in the external browser

### Testing Criteria

```typescript
// test/phase-12/session-6/markdown-preview.test.ts
describe('Session 6: Markdown Preview', () => {
  test('markdown files default to preview mode', () => {
    // Mock window.fileOps.readFile to return markdown content
    render(<FileViewer filePath="/project/README.md" />)
    // Wait for load
    // Verify MarkdownRenderer is used (check for rendered heading)
  })

  test('non-markdown files show syntax highlighting', () => {
    render(<FileViewer filePath="/project/src/App.tsx" />)
    // Verify SyntaxHighlighter is used
    // Verify no Source/Preview toggle
  })

  test('toggle switches between source and preview', async () => {
    render(<FileViewer filePath="/project/README.md" />)
    // Default is preview
    await userEvent.click(screen.getByText('Source'))
    // Verify syntax highlighter shown
    await userEvent.click(screen.getByText('Preview'))
    // Verify markdown renderer shown
  })

  test('isMarkdownFile detects .md and .mdx', () => {
    expect(isMarkdownFile('/foo/bar.md')).toBe(true)
    expect(isMarkdownFile('/foo/bar.mdx')).toBe(true)
    expect(isMarkdownFile('/foo/bar.ts')).toBe(false)
    expect(isMarkdownFile('/foo/bar.json')).toBe(false)
  })
})
```

---

## Session 7: Auto-Focus Textarea on New Session + Minor UX

### Objectives

- Auto-focus the message textarea immediately when creating a new session via `+`
- Ensure focus happens before the OpenCode connection is established (no waiting for `'connected'` status)

### Tasks

#### 1. Add unconditional focus effect on sessionId change

In `src/renderer/src/components/sessions/SessionView.tsx`, add or modify the focus effect:

```typescript
// Focus textarea whenever session changes (new session or tab switch)
useEffect(() => {
  if (textareaRef.current) {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }
}, [sessionId])
```

This is in addition to (or replaces) the existing focus effect that gates on `viewState.status === 'connected'` (lines 522-528). The key insight: we want focus on EVERY session change, not just when connected. The textarea should be focusable even before the connection is established — users can type their message while waiting.

#### 2. Verify existing focus effect compatibility

Check the existing focus effect at lines 522-528:

```typescript
useEffect(() => {
  if (viewState.status === 'connected' && textareaRef.current) {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }
}, [sessionId, viewState.status])
```

This can remain as a fallback — it won't conflict with the new unconditional effect. Both attempting to focus the same element is harmless. Alternatively, simplify by removing the `viewState.status === 'connected'` gate entirely.

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — focus effect

### Definition of Done

- [ ] Clicking `+` to create a new session immediately focuses the textarea
- [ ] Focus happens before the OpenCode connection is established
- [ ] Switching between existing sessions also focuses the textarea
- [ ] Focus works even if the session has no connection yet (idle state)
- [ ] No double-focus or focus-stealing issues
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Click `+` to create a new session — verify the cursor is blinking in the textarea immediately
2. Type a message right away (before the connection indicator shows) — verify text appears
3. Switch to another session tab — verify textarea is focused in the new tab
4. Switch back — verify textarea is focused
5. Create multiple sessions in quick succession — verify focus stays in the latest

### Testing Criteria

```typescript
// test/phase-12/session-7/session-autofocus.test.ts
describe('Session 7: Session Auto-Focus', () => {
  test('textarea focused on session mount', () => {
    // Render SessionView with a new sessionId
    // Verify textareaRef.current === document.activeElement
  })

  test('textarea focused on session change', () => {
    // Render SessionView, change sessionId prop
    // Verify textarea re-focused
  })

  test('focus works in idle state (not connected)', () => {
    // Render SessionView with viewState.status = 'idle'
    // Verify textarea still focused
  })
})
```

---

## Session 8: Archive Loading State

### Objectives

- Show a visual loading state on worktree items during archive operations
- Dim the worktree card and show a spinner while archiving
- Disable interactions on the archiving worktree

### Tasks

#### 1. Add `archivingWorktreeIds` to worktree store

In `src/renderer/src/stores/useWorktreeStore.ts`:

Add to the state interface:

```typescript
archivingWorktreeIds: Set<string>
```

Initialize in the store:

```typescript
archivingWorktreeIds: new Set()
```

#### 2. Wrap `archiveWorktree` with loading state

Modify the existing `archiveWorktree` action to set/clear the archiving state:

```typescript
archiveWorktree: async (id, path, branchName, projectPath) => {
  // Mark as archiving
  set((state) => ({
    archivingWorktreeIds: new Set([...state.archivingWorktreeIds, id])
  }))

  try {
    const result = await window.worktreeOps.delete({
      id,
      path,
      branchName,
      projectPath,
      archive: true
    })

    if (result.success) {
      // Existing removal logic ...
    } else {
      toast.error(result.error || 'Failed to archive workspace')
    }
  } catch (error) {
    toast.error('Failed to archive workspace')
  } finally {
    // Always clear archiving state
    set((state) => {
      const next = new Set(state.archivingWorktreeIds)
      next.delete(id)
      return { archivingWorktreeIds: next }
    })
  }
}
```

Also wrap the `unbranch` action similarly if it exists.

#### 3. Consume archiving state in WorktreeItem

In `src/renderer/src/components/worktrees/WorktreeItem.tsx`:

```typescript
const archivingWorktreeIds = useWorktreeStore((s) => s.archivingWorktreeIds)
const isArchiving = archivingWorktreeIds.has(worktree.id)
```

Apply visual changes when `isArchiving`:

- Root container: add `opacity-50 pointer-events-none` classes
- Replace the normal status icon (Folder/GitBranch/PulseAnimation) with `<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />`

```tsx
<div className={cn(
  'group flex items-center gap-2 px-3 py-1.5 ...',
  isArchiving && 'opacity-50 pointer-events-none'
)}>
  {isArchiving ? (
    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
  ) : (
    // existing icon logic
  )}
  ...
</div>
```

#### 4. Handle Zustand Set serialization

`Set` doesn't serialize well with Zustand persist. Since `archivingWorktreeIds` is ephemeral (clears on app restart), either:

- Don't persist it (exclude from persist config) — preferred
- Use an array instead of Set

If the store uses `persist()`, add `archivingWorktreeIds` to the `partialize` exclusion list or use the `skipHydration` pattern.

### Key Files

- `src/renderer/src/stores/useWorktreeStore.ts` — archiving state, try/finally wrapper
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — consume state, visual changes

### Definition of Done

- [ ] Clicking "Archive" immediately dims the worktree item (opacity-50)
- [ ] A spinner replaces the normal icon during archiving
- [ ] The worktree item is non-interactive during archiving (pointer-events-none)
- [ ] On success: worktree disappears as before
- [ ] On failure: worktree returns to normal appearance, error toast shown
- [ ] Archiving state does not persist across app restarts
- [ ] Multiple worktrees can be archived simultaneously (each shows its own spinner)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Configure a project with an `archive_script` that takes a few seconds (e.g., `sleep 3`)
2. Click "Archive" on a worktree — verify it immediately dims with a spinner
3. Wait for the archive to complete — verify the worktree disappears
4. Try clicking the dimmed worktree during archiving — verify no interaction
5. Test archive failure (e.g., invalid path) — verify the worktree returns to normal with error toast
6. Archive two worktrees at once — verify both show spinners independently

### Testing Criteria

```typescript
// test/phase-12/session-8/archive-loading.test.ts
describe('Session 8: Archive Loading State', () => {
  test('archivingWorktreeIds starts empty', () => {
    const store = useWorktreeStore.getState()
    expect(store.archivingWorktreeIds.size).toBe(0)
  })

  test('archiveWorktree adds id to archivingWorktreeIds', async () => {
    // Mock window.worktreeOps.delete to resolve after delay
    const promise = useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path', 'branch', '/project')
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(true)
    await promise
  })

  test('archiveWorktree clears id on success', async () => {
    // Mock successful delete
    await useWorktreeStore.getState().archiveWorktree('wt1', '/path', 'branch', '/project')
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(false)
  })

  test('archiveWorktree clears id on failure', async () => {
    // Mock failed delete
    await useWorktreeStore.getState().archiveWorktree('wt1', '/path', 'branch', '/project')
    expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt1')).toBe(false)
  })

  test('WorktreeItem shows spinner when archiving', () => {
    // Mock archivingWorktreeIds containing 'wt1'
    // Render WorktreeItem for wt1
    // Verify Loader2 spinner present
    // Verify opacity-50 class
  })

  test('WorktreeItem is non-interactive when archiving', () => {
    // Verify pointer-events-none class when isArchiving
  })
})
```

---

## Session 9: File Viewer Tab Context Menu

### Objectives

- Add a right-click context menu to file viewer tabs
- Provide Copy Path, Copy Relative Path, Reveal in Finder, Open in Editor, Close, Close Others, Close All

### Tasks

#### 1. Create `FileViewerTabContextMenu.tsx`

Create `src/renderer/src/components/file-viewer/FileViewerTabContextMenu.tsx`:

- Uses shadcn `ContextMenu` wrapper
- Props: `children`, `filePath`, `worktreePath?`
- Menu items:
  - **Copy Path** — `window.projectOps.copyToClipboard(filePath)`
  - **Copy Relative Path** — compute relative path from worktreePath, copy
  - **Separator**
  - **Reveal in Finder** — `window.gitOps.showInFinder(filePath)`
  - **Open in Editor** — `window.gitOps.openInEditor(filePath)`
  - **Separator**
  - **Close** — `closeFile(filePath)` from `useFileViewerStore`
  - **Close Others** — close all files except this one
  - **Close All** — `closeAllFiles()` from `useFileViewerStore`

Icons: `Copy`, `FolderOpen`, `FileCode`, `X`, `XCircle` from lucide-react.

#### 2. Find and wrap file viewer tabs

Locate where file viewer tabs are rendered. This is likely in a parent component that manages the tab strip above `FileViewer`. Search for where `useFileViewerStore.openFiles` is iterated to render tab buttons.

Wrap each tab's clickable element with `<FileViewerTabContextMenu>`:

```tsx
<FileViewerTabContextMenu filePath={tab.path} worktreePath={worktreePath}>
  <ContextMenuTrigger asChild>
    <button className="..." onClick={() => setActiveFile(tab.path)}>
      {tab.name}
      <X
        className="..."
        onClick={(e) => {
          e.stopPropagation()
          closeFile(tab.path)
        }}
      />
    </button>
  </ContextMenuTrigger>
</FileViewerTabContextMenu>
```

#### 3. Add `closeOtherFiles` action to store if needed

If `useFileViewerStore` doesn't have a `closeOtherFiles(exceptPath)` action, add one:

```typescript
closeOtherFiles: (exceptPath: string) => {
  set((state) => {
    const newMap = new Map()
    const kept = state.openFiles.get(exceptPath)
    if (kept) newMap.set(exceptPath, kept)
    return { openFiles: newMap, activeFilePath: exceptPath }
  })
}
```

### Key Files

- `src/renderer/src/components/file-viewer/FileViewerTabContextMenu.tsx` — **NEW**
- Parent component rendering file viewer tab strip — wrap tabs
- `src/renderer/src/stores/useFileViewerStore.ts` — possibly add `closeOtherFiles`

### Definition of Done

- [ ] Right-clicking a file viewer tab shows a context menu
- [ ] "Copy Path" copies the absolute file path to clipboard
- [ ] "Copy Relative Path" copies the path relative to the worktree root
- [ ] "Reveal in Finder" opens the file's parent folder in Finder
- [ ] "Open in Editor" opens the file in the configured editor
- [ ] "Close" closes the tab
- [ ] "Close Others" closes all tabs except the right-clicked one
- [ ] "Close All" closes all tabs
- [ ] "Close Others" is disabled when only one tab is open
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open several files in the file viewer (click files in file tree or tool calls)
2. Right-click a tab — verify context menu appears
3. Click "Copy Path" — paste somewhere — verify absolute path
4. Click "Copy Relative Path" — verify relative path (no worktree prefix)
5. Click "Reveal in Finder" — verify Finder opens to the file's directory
6. Click "Open in Editor" — verify the file opens in VS Code (or configured editor)
7. Click "Close" — verify the tab closes
8. With 3 tabs open, right-click the middle one → "Close Others" — verify only the middle tab remains
9. Click "Close All" — verify all tabs close
10. With 1 tab open, right-click → verify "Close Others" is disabled/grayed

### Testing Criteria

```typescript
// test/phase-12/session-9/file-viewer-context-menu.test.ts
describe('Session 9: File Viewer Context Menu', () => {
  test('renders context menu items', () => {
    render(
      <FileViewerTabContextMenu filePath="/project/src/App.tsx" worktreePath="/project">
        <ContextMenuTrigger><button>App.tsx</button></ContextMenuTrigger>
      </FileViewerTabContextMenu>
    )
    // Right-click trigger
    // Verify: Copy Path, Copy Relative Path, Reveal in Finder, Open in Editor, Close, Close Others, Close All
  })

  test('Copy Path copies absolute path', async () => {
    // Mock window.projectOps.copyToClipboard
    // Click "Copy Path"
    // Verify called with '/project/src/App.tsx'
  })

  test('Copy Relative Path computes relative', async () => {
    // Mock window.projectOps.copyToClipboard
    // Click "Copy Relative Path"
    // Verify called with 'src/App.tsx'
  })

  test('Close calls closeFile', async () => {
    // Mock useFileViewerStore.closeFile
    // Click "Close"
    // Verify called with filePath
  })

  test('Close Others disabled with single tab', () => {
    // Mock openFiles with 1 entry
    // Verify Close Others is disabled
  })
})
```

---

## Session 10: Integration & Verification

### Objectives

- Verify all Phase 12 features work correctly together
- Test cross-feature interactions
- Run lint and tests
- Fix any edge cases or regressions

### Tasks

#### 1. Context + Streaming end-to-end

- Start a session, send multiple messages
- Verify context indicator updates after each response (snapshot, not cumulative)
- Verify context percentage can decrease after compaction
- Verify cost accumulates

#### 2. Prompt history + Session creation

- Create a new session via `+` — verify auto-focus
- Type and send several messages
- Navigate history with Up/Down — verify correct behavior
- Switch to another branch — verify different history

#### 3. Queued messages + Compact tools

- Send a complex prompt that triggers many Read/Write/Edit calls
- Verify compact inline format
- While streaming, queue a follow-up — verify queued bubble appears
- Wait for stream to complete — verify queued bubble transforms

#### 4. TodoWrite rendering

- Trigger a response that uses the TodoWrite tool
- Verify collapsed header shows task progress
- Verify expanded view shows proper checklist
- Verify while tasks are being updated, the in_progress items show spinners

#### 5. Markdown preview + File viewer context menu

- Open a `.md` file from the file tree
- Verify rendered markdown preview
- Toggle to Source — verify raw markdown
- Right-click the file tab — verify context menu actions work
- Open a `.ts` file — verify no toggle, syntax highlighting

#### 6. Archive loading

- Archive a worktree — verify dimmed + spinner
- Verify it disappears on completion
- Test failure case — verify recovery

#### 7. Full smoke test

Walk through the complete flow:

1. Open app → select project → create new worktree → session auto-starts → textarea auto-focused
2. Send a message → verify context indicator shows correct values → verify compact Read/Write/Edit tool calls
3. Send another message → verify context indicator updates (snapshot replacement)
4. Queue a message during streaming → verify queued bubble → verify it resolves
5. Press Up arrow to recall last prompt → press Down to return
6. Open a `.md` file → verify markdown preview → toggle Source/Preview
7. Right-click the file tab → Copy Path, Reveal in Finder
8. Trigger a TodoWrite tool → verify checklist rendering
9. Archive a worktree → verify spinner → verify disappears
10. Verify session cost in context indicator tooltip

#### 8. Run lint and tests

```bash
pnpm lint
pnpm test
```

Fix any failures.

### Key Files

- All files modified in sessions 1-9

### Definition of Done

- [ ] All 9 features work correctly in isolation
- [ ] Cross-feature interactions work correctly
- [ ] No regressions in Phase 11 features (titles, branch rename, file sidebar, streaming fixes)
- [ ] No console errors during normal operation
- [ ] No leaked timers, rAF callbacks, or IPC listeners
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Full happy path smoke test passes

### How to Test

Run through each integration scenario listed in Tasks above. Pay special attention to:

- Context indicator accuracy compared to official OpenCode client
- Prompt history across branch switches
- Queued message lifecycle during rapid streaming
- Compact tool card expansion/collapse during streaming
- Markdown preview memory usage with large files

### Testing Criteria

```typescript
// test/phase-12/session-10/integration-verification.test.ts
describe('Session 10: Integration & Verification', () => {
  test('context updates correctly after multiple messages', () => {
    // Send 3 messages, verify context reflects last message's tokens only
  })

  test('prompt history survives session creation', () => {
    // Send messages, create new session, verify Up arrow recalls from previous session
  })

  test('queued messages render and clear correctly', () => {
    // Queue during streaming, verify bubble, wait for idle, verify cleared
  })

  test('compact tool cards work during streaming', () => {
    // Start streaming with file operations
    // Verify compact format with spinners
    // Wait for completion, verify + icons
  })

  test('markdown preview in file viewer', () => {
    // Open .md file, verify rendered
    // Toggle to source, verify raw
  })

  test('file viewer context menu actions', () => {
    // Right-click tab, verify all actions present
  })

  test('archive loading state end-to-end', () => {
    // Archive worktree, verify spinner, verify cleanup
  })

  test('lint passes', () => {
    // pnpm lint exit code 0
  })

  test('tests pass', () => {
    // pnpm test exit code 0
  })
})
```

---

## Dependencies & Order

```
Session 1 (Context Fix)           ── standalone, highest priority
Session 2 (Prompt History)        ── standalone
Session 3 (Queued Messages)       ── standalone
Session 4 (Compact File Tools)    ── standalone
Session 5 (TodoWrite Rendering)   ── standalone (but touches ToolCard.tsx like S4)
Session 6 (Markdown Preview)      ── standalone
Session 7 (Auto-Focus)            ── standalone
Session 8 (Archive Loading)       ── standalone
Session 9 (File Viewer Menu)      ── standalone

Session 10 (Integration)          ── requires sessions 1-9
```

### Parallel Tracks

```
┌────────────────────────────────────────────────────────────────────┐
│  Time →                                                            │
│                                                                    │
│  Track A: [S1: Context Fix]                                        │
│  Track B: [S2: Prompt History]                                     │
│  Track C: [S3: Queued Messages]                                    │
│  Track D: [S4: Compact Tools] → [S5: TodoWrite] (shared ToolCard) │
│  Track E: [S6: Markdown Preview]                                   │
│  Track F: [S7: Auto-Focus]                                         │
│  Track G: [S8: Archive Loading]                                    │
│  Track H: [S9: File Viewer Menu]                                   │
│                                                                    │
│  All ────────────────────────────────────────► [S10: Integration]   │
└────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 1-3 and 6-9 are fully independent. Sessions 4 and 5 both modify `ToolCard.tsx` so should be done sequentially (Track D).

**Minimum total**: 3 rounds:

1. (S1, S2, S3, S4, S6, S7, S8, S9 in parallel)
2. (S5 — after S4 completes)
3. (S10)

**Recommended serial order** (if doing one at a time):

S1 → S7 → S2 → S3 → S4 → S5 → S6 → S8 → S9 → S10

Rationale: S1 fixes broken behavior (highest priority), S7 is trivial (quick win), S2-S3 are the core UX improvements, S4-S5 share ToolCard.tsx, S6-S9 are independent polish items.

---

## Notes

### Assumed Phase 11 Infrastructure

- Server-side session titles via `session.updated` events
- Branch auto-rename and manual rename
- File sidebar with Changes/Files tabs
- Streaming bugfixes (loading state, cross-tab bleed, tool call detach)
- Auto-start first session on worktree entry
- "Agent" label for Task tool calls (not "Task")

### Out of Scope (Phase 12)

Per PRD Phase 12:

- Prompt history search/filter (only sequential Up/Down navigation)
- Prompt history sync across devices (localStorage only)
- Context breakdown bar with category visualization
- Context overflow detection and compaction UI
- Queued message editing, reordering, or cancellation
- Compact inline mode for Bash, Grep, Glob, Task tools
- TodoWrite interactive editing (checking/unchecking — read-only display)
- Markdown preview for files opened via tool calls (only file viewer)
- Markdown live editing or split-pane editor
- File viewer tab drag-and-drop reordering or pinning

### Performance Targets

| Operation                       | Target                                   |
| ------------------------------- | ---------------------------------------- |
| Prompt history Up/Down response | < 16ms (single frame)                    |
| Context calculation on message  | < 100ms from event to indicator update   |
| Queued bubble render            | < 16ms from send click to bubble visible |
| Compact tool card height        | ≤ 24px collapsed                         |
| TodoWrite list render           | < 16ms for up to 50 items                |
| Markdown file preview           | < 500ms for files up to 100KB            |
| Session auto-focus              | < 16ms (1 frame) after mount             |
| Archive loading feedback        | < 16ms from click to dimmed+spinner      |
| File viewer context menu        | < 50ms from right-click to visible       |

### Key Architecture Decisions

1. **Snapshot-based tokens over cumulative accumulation**: The official OpenCode client reads tokens from the last assistant message. Each message's token counts represent the full current context state, not a delta. Accumulating would double-count.

2. **Per-branch prompt history over per-session**: Users think in terms of branches/features, not individual sessions. A branch may have multiple sessions over its lifetime. Sharing history across sessions on the same branch makes prompts more discoverable.

3. **localStorage for prompt history over SQLite**: History is a UI-only concern. It doesn't need the durability or query capabilities of SQLite. localStorage is faster, doesn't require IPC, and can be managed entirely in the renderer.

4. **Compact inline only for Read/Write/Edit**: These are high-frequency, low-information tool calls. Bash output is variable and important to see. Grep results need match counts. Task/Agent needs status tracking. Only file operations benefit from the compact treatment.

5. **Queued message content in renderer state, not in a store**: Queued messages are ephemeral (cleared on idle) and scoped to a single session view. A Zustand store would add unnecessary complexity for data that never needs to persist or be shared.

6. **Markdown preview as default for .md files**: Users opening markdown files in a file viewer expect to see rendered content, not source. The Source toggle is available for those who need raw access. This matches VS Code's behavior.

7. **Archiving state in store, not local component state**: The archive operation outlives potential re-renders of `WorktreeItem`. Storing the state in the Zustand store ensures it survives any component remount during the operation.
