# Hive — Phase 12 Product Requirements Document

## Overview

**Phase 12** focuses on **prompt history navigation, context calculation accuracy, queued message UX, tool call visual redesign, todo list rendering, markdown file preview, session auto-focus, archive loading states, and file viewer context menus**. The work spans nine items: adding up/down arrow key navigation through previously sent prompts per branch, fixing context token calculation to match the official OpenCode client implementation, showing queued messages as sticky bottom-pinned bubbles with a QUEUED tag until they are sent, redesigning Read/Write/Edit tool calls to a compact single-line format with status icons, rendering TodoWrite tool output as a proper todo list with status and priority indicators, enabling markdown rendering in the file viewer for `.md` files, auto-focusing the textarea when creating a new session via `+`, showing a dimmed spinner overlay on worktree items during archive operations, and adding Copy Path / Reveal in Finder to the file viewer tab context menu.

### Phase 12 Goals

- Enable prompt history navigation via up/down arrow keys in the message input, scoped per branch, so users can quickly recall and re-send previous prompts
- Fix context token calculation to match the official OpenCode client: total = input + output + reasoning + cache.read + cache.write, usage % = total / model.limit.context, sourced from the last assistant message with tokens > 0 (not cumulative across messages)
- Show queued messages as visible chat bubbles pinned to the bottom of the message list with a QUEUED badge, transforming into normal messages once sent
- Redesign Read, Write, and Edit tool calls from full-width expandable cards to compact inline `{icon} {tool} {file}` lines that expand on click
- Detect TodoWrite tool output (JSON arrays of todo items) and render a proper todo list UI with status indicators and priority badges
- Render markdown files (`.md`, `.mdx`) in the file viewer using the existing `MarkdownRenderer` instead of syntax-highlighted source
- Auto-focus the message textarea immediately when creating a new session via the `+` button
- Show a loading state (dimmed card + spinner) on worktree items during the archive operation
- Add "Copy Path" and "Reveal in Finder" to the file viewer's tab bar context menu

---

## Technical Additions

| Component                | Technology                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Prompt History           | Per-branch localStorage via Zustand persist, cursor-position-aware arrow key handling           |
| Context Calculation Fix  | Rewrite `useContextStore` to use last-message-with-tokens approach per CONTEXT_CALCULATION.md   |
| Queued Message Display   | New `QueuedMessageBubble` component, local state array of queued message contents               |
| Compact Tool Cards       | New rendering mode in `ToolCard.tsx` for Read/Write/Edit — inline layout with expand toggle     |
| TodoWrite Renderer       | New `TodoListView.tsx` tool renderer, JSON parsing, status/priority icon mapping                |
| Markdown File Preview    | Conditional rendering in `FileViewer.tsx` using existing `MarkdownRenderer` for `.md` files     |
| Session Auto-Focus       | Focus callback in `SessionTabs.tsx` after `createSession`, ensure textarea focus on mount       |
| Archive Loading State    | `archivingWorktreeIds` state in `useWorktreeStore`, spinner + opacity overlay in `WorktreeItem` |
| File Viewer Context Menu | New context menu on file viewer tab bar with Copy Path and Reveal in Finder actions             |

---

## Features

### 1. Prompt History Navigation (Up/Down Arrow Keys)

#### 1.1 Current State

The message textarea in `SessionView.tsx` has a minimal `handleKeyDown` handler (lines 1671-1679) that only handles Enter to send and Shift+Enter for newlines:

```tsx
const handleKeyDown = useCallback(
  (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  },
  [handleSend]
)
```

There is no prompt history tracking. Once a message is sent, it cannot be recalled. The input value is cleared immediately after sending (line 1510 in `handleSend`). Draft persistence exists (3-second debounce to `window.db.session.updateDraft()`), but this only saves the current unsent draft — not a history of sent prompts.

#### 1.2 New Design

```
Prompt History Flow:

  Storage: Per-branch prompt history stored in Zustand with localStorage persist
  Key: worktreeId (which maps 1:1 to a branch)
  Value: string[] — ordered list of sent prompts, newest last
  Max: 100 prompts per branch (FIFO eviction)

  Navigation:
  1. User presses Up Arrow in textarea
  2. Guard: cursor must be at position 0 (before first character)
     - If cursor is not at position 0, let default behavior (move cursor up) happen
  3. If at start of history: do nothing
  4. Decrement history index → set textarea value to history[index]
  5. Move cursor to end of inserted text

  1. User presses Down Arrow in textarea
  2. Guard: cursor must be at position === value.length (after last character)
     - If cursor is not at end, let default behavior (move cursor down) happen
  3. If at end of history: restore original draft (the text before history navigation began)
  4. Increment history index → set textarea value to history[index]

  State machine:
  ┌─────────────┐   Up (pos=0)     ┌───────────────┐
  │   Editing    │ ───────────────► │  Navigating    │
  │  (draft)     │ ◄─────────────── │  (historyIdx)  │
  └─────────────┘   Down (past end) └───────────────┘
                    or type/send

  When user starts typing while navigating: exit navigation, keep current text as draft
  When user sends while navigating: send the displayed text, add to history, reset navigation
```

#### 1.3 Implementation

**New Store — `usePromptHistoryStore.ts`:**

```tsx
interface PromptHistoryState {
  // Per-worktree prompt history (worktreeId -> string[])
  historyByWorktree: Record<string, string[]>
  // Actions
  addPrompt: (worktreeId: string, prompt: string) => void
  getHistory: (worktreeId: string) => string[]
}

// Max prompts per branch
const MAX_HISTORY = 100

export const usePromptHistoryStore = create<PromptHistoryState>()(
  persist(
    (set, get) => ({
      historyByWorktree: {},

      addPrompt: (worktreeId, prompt) => {
        const trimmed = prompt.trim()
        if (!trimmed) return
        set((state) => {
          const existing = state.historyByWorktree[worktreeId] ?? []
          // Deduplicate: remove if same prompt exists at end
          const filtered = existing.filter((p) => p !== trimmed)
          const updated = [...filtered, trimmed].slice(-MAX_HISTORY)
          return {
            historyByWorktree: {
              ...state.historyByWorktree,
              [worktreeId]: updated
            }
          }
        })
      },

      getHistory: (worktreeId) => {
        return get().historyByWorktree[worktreeId] ?? []
      }
    }),
    { name: 'hive-prompt-history', storage: createJSONStorage(() => localStorage) }
  )
)
```

**SessionView.tsx — handleKeyDown modification:**

```tsx
// Local state for history navigation
const [historyIndex, setHistoryIndex] = useState<number | null>(null)
const savedDraftRef = useRef<string>('')

const handleKeyDown = useCallback(
  (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
      return
    }

    const textarea = e.currentTarget
    const history = usePromptHistoryStore.getState().getHistory(worktreeId)
    if (history.length === 0) return

    if (e.key === 'ArrowUp' && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
      e.preventDefault()
      if (historyIndex === null) {
        // Entering navigation — save current draft
        savedDraftRef.current = inputValue
        const newIndex = history.length - 1
        setHistoryIndex(newIndex)
        handleInputChange(history[newIndex])
      } else if (historyIndex > 0) {
        const newIndex = historyIndex - 1
        setHistoryIndex(newIndex)
        handleInputChange(history[newIndex])
      }
      return
    }

    if (
      e.key === 'ArrowDown' &&
      textarea.selectionStart === textarea.value.length &&
      textarea.selectionEnd === textarea.value.length
    ) {
      e.preventDefault()
      if (historyIndex !== null) {
        if (historyIndex < history.length - 1) {
          const newIndex = historyIndex + 1
          setHistoryIndex(newIndex)
          handleInputChange(history[newIndex])
        } else {
          // Past end of history — restore draft
          setHistoryIndex(null)
          handleInputChange(savedDraftRef.current)
        }
      }
      return
    }
  },
  [handleSend, inputValue, historyIndex, worktreeId, handleInputChange]
)

// Reset history navigation when user types manually
const handleInputChangeWithHistoryReset = useCallback(
  (value: string) => {
    // If navigating and user modifies text, exit navigation
    if (historyIndex !== null) {
      setHistoryIndex(null)
    }
    handleInputChange(value)
  },
  [historyIndex, handleInputChange]
)
```

**In `handleSend` — record to history:**

```tsx
// After successful send, add to prompt history
usePromptHistoryStore.getState().addPrompt(worktreeId, trimmedValue)
setHistoryIndex(null)
savedDraftRef.current = ''
```

#### 1.4 Files to Modify

| File                                                   | Change                                                  |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `src/renderer/src/stores/usePromptHistoryStore.ts`     | **New file** — per-branch prompt history store          |
| `src/renderer/src/stores/index.ts`                     | Export `usePromptHistoryStore`                          |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add Up/Down arrow handling, history state, record sends |

---

### 2. Context Calculation Fix

#### 2.1 Current State

The current context calculation in `useContextStore.ts` (81 lines) is fundamentally wrong compared to the official OpenCode client:

**Problem 1 — Cumulative accumulation:** The store uses `addMessageTokens()` which _sums_ token values across every assistant message. This means the context "usage" grows monotonically — it never reflects the actual current context window state. The official client reads tokens from the **last assistant message only** (the one with tokens > 0), since that message's token counts reflect the entire current context window size.

**Problem 2 — Wrong total formula:** The current formula is `used = input + output + cacheRead`. Per `CONTEXT_CALCULATION.md`, the correct formula is:

```
total = input + output + reasoning + cache.read + cache.write
```

All five categories should be summed to represent how much of the context window is in use.

**Problem 3 — Wrong denominator:** The current code uses a flat `modelLimits[modelId]` number. The official client uses `model.limit.context` from the provider endpoint, which is always the full context window size (e.g. 200,000 for Claude Sonnet).

**Problem 4 — Token extraction complexity:** `SessionView.tsx` lines 710-738 manually parse `opencode_message_json` from the database with multiple key format fallbacks (`cacheRead`, `cache_read`, `cache.read`). This fragile parsing should be simplified by using a consistent extraction function.

**Current code in `useContextStore.ts`:**

```tsx
getContextUsage: (sessionId: string, modelId: string) => {
  const state = get()
  const tokens = state.tokensBySession[sessionId] ?? { ...EMPTY_TOKENS }
  const limit = state.modelLimits[modelId] ?? 0
  const used = tokens.input + tokens.output + tokens.cacheRead // WRONG: missing reasoning + cacheWrite
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return { used, limit, percent, tokens }
}
```

#### 2.2 New Design

```
New Context Calculation Flow:

  On each assistant message completion (message.updated with tokens):
  1. Extract tokens from the message: { input, output, reasoning, cache: { read, write } }
  2. REPLACE (not accumulate) the session's token snapshot
  3. Compute: total = input + output + reasoning + cache.read + cache.write
  4. Compute: usage% = Math.round((total / model.limit.context) * 100)

  On session load from DB:
  1. Walk backward through messages to find last assistant message with tokens > 0
  2. Extract its tokens → set as session snapshot
  3. Compute same way

  Model limit resolution:
  1. From window.opencodeOps.modelInfo() → model.limit.context
  2. Store as modelLimits[modelId] = limit.context

  Display:
  - Same progress bar UI
  - Tooltip shows: total / limit tokens (%), plus breakdown of all 5 categories
  - Add session cost display: sum .cost across all assistant messages
```

#### 2.3 Implementation

**Rewritten `useContextStore.ts`:**

```tsx
interface TokenInfo {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

interface ContextState {
  // Per-session token snapshot (from LAST assistant message, not cumulative)
  tokensBySession: Record<string, TokenInfo>
  // Per-session cumulative cost
  costBySession: Record<string, number>
  // Model context limits
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

// Usage calculation per CONTEXT_CALCULATION.md:
// total = input + output + reasoning + cache.read + cache.write
// percent = Math.round((total / model.limit.context) * 100)
```

**Token extraction helper:**

```tsx
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

  // Only return if there are actually tokens
  const total = info.input + info.output + info.reasoning + info.cacheRead + info.cacheWrite
  return total > 0 ? info : null
}
```

**SessionView.tsx — DB load (replace lines 710-738):**

```tsx
// Walk backward to find last assistant message with tokens > 0
for (let i = dbMessages.length - 1; i >= 0; i--) {
  const msg = dbMessages[i]
  if (msg.role !== 'assistant' || !msg.opencode_message_json) continue
  try {
    const parsed = JSON.parse(msg.opencode_message_json)
    const tokens = extractTokens(parsed)
    if (tokens) {
      useContextStore.getState().setSessionTokens(sessionId, tokens)
      break
    }
  } catch {
    /* ignore parse errors */
  }
}

// Compute total cost across all assistant messages
let totalCost = 0
for (const msg of dbMessages) {
  if (msg.role !== 'assistant' || !msg.opencode_message_json) continue
  try {
    const parsed = JSON.parse(msg.opencode_message_json)
    totalCost += (parsed.cost as number) || 0
  } catch {
    /* ignore */
  }
}
useContextStore.getState().setSessionCost(sessionId, totalCost)
```

**SessionView.tsx — Streaming update (replace lines 1108-1135):**

```tsx
// On message.updated with completed time → extract final tokens
if (data.info?.time?.completed) {
  const tokens = extractTokens(data)
  if (tokens) {
    useContextStore.getState().setSessionTokens(sessionId, tokens)
  }
  const cost = (data.cost as number) || 0
  if (cost > 0) {
    useContextStore.getState().addSessionCost(sessionId, cost)
  }
}
```

**ContextIndicator.tsx — Update tooltip to show cost:**

```tsx
{
  cost > 0 && (
    <div className="border-t border-background/20 pt-1.5">
      <div>Cost: ${cost.toFixed(4)}</div>
    </div>
  )
}
```

#### 2.4 Files to Modify

| File                                                        | Change                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/renderer/src/stores/useContextStore.ts`                | Rewrite: replace cumulative with snapshot approach, add cost tracking |
| `src/renderer/src/components/sessions/ContextIndicator.tsx` | Update total formula, add cost display in tooltip                     |
| `src/renderer/src/components/sessions/SessionView.tsx`      | Simplify token extraction on DB load and streaming, use new store     |

---

### 3. Queued Messages Placement

#### 3.1 Current State

When a message is queued during streaming, the current implementation simply increments a counter (`queuedCount` state in `SessionView.tsx` line 343) and shows a plain text indicator via `QueuedIndicator` (13 lines):

```tsx
export function QueuedIndicator({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <div className="text-xs text-muted-foreground px-3 py-1">
      {count} message{count > 1 ? 's' : ''} queued
    </div>
  )
}
```

The message is immediately sent to OpenCode's SDK, which handles its own internal queue. There is no visual representation of _what_ the queued message says — the user can't see the content they queued.

#### 3.2 New Design

```
Queued Message Display:

  When user sends while streaming:
  1. Message is sent to OpenCode SDK as before (no change to send logic)
  2. Message content is also added to local queuedMessages[] array
  3. Queued messages render at the bottom of the chat as sticky bubbles
     with a QUEUED badge

  Visual layout (bottom of message list):
  ┌──────────────────────────────────────────────┐
  │ [QUEUED] Fix the import statement in App.tsx  │
  └──────────────────────────────────────────────┘

  Styling:
  - Same layout as UserBubble but with reduced opacity (70%)
  - QUEUED badge: small pill, muted foreground on muted background
  - Positioned at the actual bottom of the message list (after all messages)

  Transition:
  - When the streaming response completes and the queued message appears
    as a real message in the stream, remove it from queuedMessages[]
  - Detection: on session.idle or when we see a new user message appear
    in the stream that matches the queued content
  - The queued bubble disappears and the real message renders in its place
```

#### 3.3 Implementation

**SessionView.tsx — State changes:**

```tsx
// Replace simple counter with content tracking
const [queuedMessages, setQueuedMessages] = useState<
  Array<{
    id: string
    content: string
    timestamp: number
  }>
>([])

// In handleSend, when isStreaming (queued):
if (isQueuedMessage) {
  setQueuedMessages((prev) => [
    ...prev,
    { id: crypto.randomUUID(), content: trimmedValue, timestamp: Date.now() }
  ])
}

// On session.idle or session.status idle:
setQueuedMessages([])
```

**New component — `QueuedMessageBubble.tsx`:**

```tsx
interface QueuedMessageBubbleProps {
  content: string
}

export function QueuedMessageBubble({ content }: QueuedMessageBubbleProps) {
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

**Rendering position — at the bottom of the message list in SessionView.tsx:**

```tsx
{
  /* After all messages, before input area */
}
{
  queuedMessages.map((msg) => <QueuedMessageBubble key={msg.id} content={msg.content} />)
}
```

#### 3.4 Files to Modify

| File                                                           | Change                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `src/renderer/src/components/sessions/QueuedIndicator.tsx`     | Remove or repurpose (replaced by QueuedMessageBubble)       |
| `src/renderer/src/components/sessions/QueuedMessageBubble.tsx` | **New file** — renders queued message with QUEUED badge     |
| `src/renderer/src/components/sessions/SessionView.tsx`         | Track queued message content, render bubbles, clear on idle |

---

### 4. Read/Write/Edit Tool Call Redesign (Compact Inline)

#### 4.1 Current State

Read, Write, and Edit tool calls currently render as full-width bordered cards with a left color accent, status icon, expand/collapse toggle, and full syntax-highlighted code blocks when expanded. The collapsed state already shows `{icon} {tool_name} {file_path}` but wrapped in a bordered card with padding, duration, and a View/Hide button:

```
┌─ 📄 Read  src/components/App.tsx  (42 lines)  ⏱ 120ms  ✓  [View ▼] ─┐
└──────────────────────────────────────────────────────────────────────────┘
```

This takes significant vertical space, especially when the AI makes many file operations. With 10+ Read/Write/Edit calls in sequence, the chat becomes a wall of bordered cards.

#### 4.2 New Design

```
New compact format for Read, Write, Edit:

  Loading state:  ... Read  src/components/App.tsx
  Complete state: +  Read  src/components/App.tsx
  Expanded state: -  Read  src/components/App.tsx
                     ┌──────────────────────────┐
                     │ (syntax highlighted code) │
                     └──────────────────────────┘

  Icon states:
  - "..." (animated ellipsis or Loader2 spinner) — tool is running
  - "+" — tool completed, collapsed (click to expand)
  - "-" — tool is expanded (click to collapse)
  - Can expand during loading too (icon toggles between "..." and "-")

  Visual:
  - No border, no card wrapper, no background
  - Single line of text with small icon + tool name + file path
  - Clicking anywhere on the line toggles expansion
  - Expanded content: same as current (syntax highlighted code block)
  - Error state: red "x" icon instead of "+", red text for file path

  This ONLY applies to Read, Write, Edit tools.
  Bash, Grep, Glob, Task, Question keep their current card design.
```

#### 4.3 Implementation

**ToolCard.tsx — Add compact inline mode for file operations:**

The key change is detecting Read/Write/Edit tools and rendering them with a different layout. Rather than the bordered card, render a simple inline row.

```tsx
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

// In ToolCard component:
if (isFileOperation(toolUse.name)) {
  return <CompactFileToolCard toolUse={toolUse} cwd={cwd} />
}
// Otherwise render existing bordered card layout
```

**New `CompactFileToolCard` internal component:**

```tsx
function CompactFileToolCard({ toolUse, cwd }: { toolUse: ToolUseInfo; cwd?: string | null }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const hasOutput = !!(toolUse.output || toolUse.error || toolUse.input.content)
  const Renderer = useMemo(() => getToolRenderer(toolUse.name), [toolUse.name])

  const isRunning = toolUse.status === 'pending' || toolUse.status === 'running'
  const isError = toolUse.status === 'error'

  // Status icon
  const statusIcon = isRunning ? (
    isExpanded ? (
      <Minus className="h-3.5 w-3.5 text-blue-500" />
    ) : (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
    )
  ) : isError ? (
    <X className="h-3.5 w-3.5 text-red-500" />
  ) : isExpanded ? (
    <Minus className="h-3.5 w-3.5 text-muted-foreground" />
  ) : (
    <Plus className="h-3.5 w-3.5 text-green-500" />
  )

  const filePath = (toolUse.input.filePath ||
    toolUse.input.file_path ||
    toolUse.input.path ||
    '') as string
  const toolLabel = getFileToolLabel(toolUse.name)

  return (
    <div className="my-0.5" data-testid="compact-file-tool">
      <button
        onClick={() => hasOutput && setIsExpanded(!isExpanded)}
        className={cn(
          'flex items-center gap-1.5 text-xs py-0.5 w-full text-left',
          'hover:bg-muted/30 rounded px-1 -mx-1 transition-colors',
          hasOutput && 'cursor-pointer'
        )}
      >
        {statusIcon}
        <span className="font-medium text-foreground">{toolLabel}</span>
        <span
          className={cn(
            'font-mono truncate min-w-0',
            isError ? 'text-red-400' : 'text-muted-foreground'
          )}
        >
          {shortenPath(filePath, cwd)}
        </span>
      </button>
      {isExpanded && hasOutput && (
        <div className="ml-5 mt-1 mb-2">
          <Renderer
            name={toolUse.name}
            input={toolUse.input}
            output={toolUse.output}
            error={toolUse.error}
            status={toolUse.status}
          />
        </div>
      )}
    </div>
  )
}

function getFileToolLabel(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('read') || lower === 'cat' || lower === 'view') return 'Read'
  if (lower.includes('write') || lower === 'create') return 'Write'
  if (lower.includes('edit') || lower.includes('replace') || lower.includes('patch')) return 'Edit'
  return name
}
```

#### 4.4 Files to Modify

| File                                                | Change                                                        |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `src/renderer/src/components/sessions/ToolCard.tsx` | Add `isFileOperation` check, new `CompactFileToolCard` layout |

---

### 5. TodoWrite Tool Rendering

#### 5.1 Current State

The `TodoToolView` in `src/renderer/src/components/sessions/tools/TodoToolView.tsx` (61 lines) is a generic fallback renderer that shows raw JSON for any unrecognized tool. The `TodoWrite` / `mcp_todowrite` tool name is not in the `TOOL_RENDERERS` registry, so it falls through to this fallback.

The tool's output is a JSON array of todo items with `id`, `content`, `status` ("pending" | "in_progress" | "completed" | "cancelled"), and `priority` ("high" | "medium" | "low") fields. Currently this renders as a raw JSON blob — unreadable for users.

#### 5.2 New Design

```
TodoWrite Rendered Output:

  ✓  Update OpenCodeCommand type in index.d.ts          HIGH
  ✓  Add command() type declaration in index.d.ts       HIGH
  ⟳  Update listCommands() return type                  HIGH
  ○  Update preload commands() return type              HIGH
  ○  Add sendCommand() service method                   HIGH
  ○  Add opencode:command IPC handler                   HIGH
  ○  Expose command() in preload index.ts               MEDIUM
  ✕  Write tests for session 7                          MEDIUM

  Status icons:
  - completed  → ✓ (green check)
  - in_progress → ⟳ (blue spinning/animated icon)
  - pending     → ○ (gray circle)
  - cancelled   → ✕ (red/muted strikethrough)

  Priority badges:
  - high   → red pill
  - medium → yellow pill
  - low    → gray pill (or no badge)

  Detection:
  - Tool name matches: "todowrite", "mcp_todowrite", "TodoWrite", "todo_write"
  - OR: tool input contains a `todos` array where items have `content` + `status`
```

#### 5.3 Implementation

**New `TodoListView.tsx`:**

```tsx
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolViewProps } from './types'

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

function parseTodos(input: Record<string, unknown>): TodoItem[] | null {
  // Try input.todos first (the actual tool parameter)
  const raw = input.todos
  if (Array.isArray(raw)) {
    return raw.filter(
      (item) => item && typeof item === 'object' && 'content' in item && 'status' in item
    ) as TodoItem[]
  }
  return null
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
    case 'in_progress':
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />
    case 'cancelled':
      return <XCircle className="h-4 w-4 text-muted-foreground shrink-0" />
    default: // pending
      return <Circle className="h-4 w-4 text-muted-foreground shrink-0" />
  }
}

function PriorityBadge({ priority }: { priority: string }) {
  const styles = {
    high: 'bg-red-500/15 text-red-500',
    medium: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
    low: 'bg-muted text-muted-foreground'
  }
  return (
    <span
      className={cn(
        'text-[10px] rounded px-1.5 py-0.5 font-medium shrink-0',
        styles[priority] || styles.low
      )}
    >
      {priority}
    </span>
  )
}

export function TodoListView({ input }: ToolViewProps) {
  const todos = parseTodos(input)
  if (!todos || todos.length === 0) return null

  return (
    <div className="space-y-1" data-testid="todo-list-view">
      {todos.map((todo) => (
        <div
          key={todo.id}
          className={cn(
            'flex items-center gap-2 py-1 px-2 rounded text-sm',
            todo.status === 'cancelled' && 'opacity-50 line-through'
          )}
        >
          <StatusIcon status={todo.status} />
          <span className="flex-1 min-w-0 truncate">{todo.content}</span>
          <PriorityBadge priority={todo.priority} />
        </div>
      ))}
    </div>
  )
}
```

**ToolCard.tsx — Register the renderer:**

```tsx
import { TodoListView } from './tools/TodoListView'

// Add to TOOL_RENDERERS:
const TOOL_RENDERERS: Record<string, React.FC<ToolViewProps>> = {
  // ... existing entries ...
  TodoWrite: TodoListView,
  todowrite: TodoListView,
  mcp_todowrite: TodoListView,
  todo_write: TodoListView
}

// Also update getToolRenderer fallback to detect todo-like tools:
// If tool name contains 'todo', use TodoListView
if (lower.includes('todo')) return TodoListView
```

**CollapsedContent for TodoWrite — show task progress:**

```tsx
if (lowerName.includes('todo')) {
  const todos = input.todos as TodoItem[] | undefined
  const completed = todos?.filter((t) => t.status === 'completed').length || 0
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

#### 5.4 Files to Modify

| File                                                          | Change                                             |
| ------------------------------------------------------------- | -------------------------------------------------- |
| `src/renderer/src/components/sessions/tools/TodoListView.tsx` | **New file** — rich todo list renderer             |
| `src/renderer/src/components/sessions/ToolCard.tsx`           | Register TodoWrite variants, add collapsed content |

---

### 6. Markdown Rendering in File Viewer

#### 6.1 Current State

The `FileViewer` component in `src/renderer/src/components/file-viewer/FileViewer.tsx` (250 lines) renders **all** files through `react-syntax-highlighter` with the Prism `oneDark` theme. For markdown files (`.md`, `.mdx`), it detects the language as `'markdown'` (line 16-17 in the extension map) and renders the raw markdown source with syntax highlighting — meaning users see the raw markdown syntax (`# Header`, `**bold**`, `[links](url)`) instead of rendered content.

The codebase already has a full `MarkdownRenderer` component in `src/renderer/src/components/sessions/MarkdownRenderer.tsx` (78 lines) using `react-markdown` with `remark-gfm`, complete with styled headers, links (`target="_blank"`), tables, code blocks via `CodeBlock`, and all standard markdown elements.

#### 6.2 New Design

```
Markdown File Preview:

  Detection: file extension is .md or .mdx
  When detected:
  1. Render content through MarkdownRenderer instead of SyntaxHighlighter
  2. Add a toggle button in the file path bar: "Source" / "Preview"
     - Preview (default for .md): rendered markdown
     - Source: raw syntax-highlighted markdown (current behavior)

  Layout:
  ┌─ /path/to/README.md  ─────────────  [Source] [Preview] ─┐
  │                                                           │
  │  # My Project                                             │
  │                                                           │
  │  This is a **bold** statement with a [link](https://...)  │
  │                                                           │
  │  ## Features                                              │
  │  - Feature 1                                              │
  │  - Feature 2                                              │
  └───────────────────────────────────────────────────────────┘
```

#### 6.3 Implementation

**FileViewer.tsx — Add markdown detection and toggle:**

```tsx
function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase()
  return ext === '.md' || ext === '.mdx'
}

// In FileViewer component:
const isMarkdown = isMarkdownFile(filePath)
const [viewMode, setViewMode] = useState<'preview' | 'source'>(isMarkdown ? 'preview' : 'source')

// Reset view mode when file changes
useEffect(() => {
  setViewMode(isMarkdown ? 'preview' : 'source')
}, [filePath, isMarkdown])

// In the file path bar:
{isMarkdown && (
  <div className="flex items-center gap-1">
    <button
      onClick={() => setViewMode('source')}
      className={cn('px-2 py-0.5 rounded text-xs', viewMode === 'source' ? 'bg-accent' : 'hover:bg-accent/50')}
    >
      Source
    </button>
    <button
      onClick={() => setViewMode('preview')}
      className={cn('px-2 py-0.5 rounded text-xs', viewMode === 'preview' ? 'bg-accent' : 'hover:bg-accent/50')}
    >
      Preview
    </button>
  </div>
)}

// In the content area:
{viewMode === 'preview' && isMarkdown ? (
  <div className="flex-1 overflow-auto p-6 prose prose-sm dark:prose-invert max-w-none">
    <MarkdownRenderer content={content} />
  </div>
) : (
  <SyntaxHighlighter ... />
)}
```

#### 6.4 Files to Modify

| File                                                        | Change                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| `src/renderer/src/components/file-viewer/FileViewer.tsx`    | Add markdown detection, view mode toggle, MarkdownRenderer   |
| `src/renderer/src/components/sessions/MarkdownRenderer.tsx` | Export for reuse (may need to accept `content` prop variant) |

---

### 7. Auto-Focus Textarea on New Session

#### 7.1 Current State

The `+` button in `SessionTabs.tsx` (lines 418-425) creates a new session via `createSession()`. The session store's `createSession` (lines 155-196) creates the DB entry, updates local state, and sets `activeSessionId`. Focus on the textarea happens via a `useEffect` in `SessionView.tsx` (lines 522-528):

```tsx
useEffect(() => {
  if (viewState.status === 'connected' && textareaRef.current) {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }
}, [sessionId, viewState.status])
```

The issue is that the new session starts with `viewState.status === 'idle'` and transitions through `'connecting'` before reaching `'connected'`. This means there is a delay before focus happens. Additionally, the user may need to interact with the textarea immediately after clicking `+`.

#### 7.2 New Design

```
Auto-Focus Flow:

  1. User clicks "+" button
  2. Session is created → activeSessionId changes → SessionView remounts
  3. SessionView mounts with new session → viewState starts as 'idle'
  4. Add secondary focus trigger: focus on mount when session is new
     (detect via session.created_at being within last 2 seconds)
  5. Also focus when viewState transitions to 'connected'

  This ensures the textarea is focused immediately, even before the
  OpenCode connection is established.
```

#### 7.3 Implementation

**SessionView.tsx — Add immediate focus on new session mount:**

```tsx
// Focus textarea on mount for new sessions (before connection)
useEffect(() => {
  if (textareaRef.current) {
    // Small delay to ensure DOM is ready
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }
}, [sessionId]) // Re-run when session changes
```

This is actually simpler than the description suggests — just add an unconditional focus effect that triggers on `sessionId` change. The existing `useEffect` that focuses on `'connected'` status can remain as a backup. The key change is that focus no longer gates on `viewState.status === 'connected'`.

#### 7.4 Files to Modify

| File                                                   | Change                                             |
| ------------------------------------------------------ | -------------------------------------------------- |
| `src/renderer/src/components/sessions/SessionView.tsx` | Add unconditional focus effect on sessionId change |

---

### 8. Archive Loading State

#### 8.1 Current State

When archiving a worktree, the operation involves:

1. Running an optional `archive_script` (up to 30s timeout)
2. Removing the worktree from disk (`git worktree remove`)
3. Deleting the branch (`git branch -D`)
4. Updating the database (`status = 'archived'`)

This can take several seconds, especially with archive scripts. During this time, the UI shows no indication that anything is happening — the worktree item looks normal until it suddenly disappears. The `handleArchive` function in `WorktreeItem.tsx` (lines 157-169) calls `archiveWorktree()` which is async, but there is no loading state.

#### 8.2 New Design

```
Archive Loading UX:

  1. User clicks "Archive" in context menu / dropdown
  2. Immediately:
     - Add worktreeId to archivingWorktreeIds set in store
     - WorktreeItem detects this → renders with:
       a. opacity-50 (dimmed)
       b. Loader2 spinner replacing the normal icon
       c. Pointer-events disabled (prevent double-archive or other actions)
  3. Archive completes (success or failure):
     - Remove from archivingWorktreeIds
     - On success: worktree disappears from list (already implemented)
     - On failure: worktree returns to normal state, error toast shown

  State location: useWorktreeStore (not local state, since the item
  may re-render or the operation spans multiple seconds)
```

#### 8.3 Implementation

**useWorktreeStore.ts — Add archiving state:**

```tsx
interface WorktreeState {
  // ... existing fields ...
  archivingWorktreeIds: Set<string>
  // ... existing actions ...
}

// In archiveWorktree action:
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
      // Remove from state (existing logic)
      // ...
    } else {
      toast.error(result.error || 'Failed to archive workspace')
    }
  } finally {
    // Always remove from archiving set
    set((state) => {
      const next = new Set(state.archivingWorktreeIds)
      next.delete(id)
      return { archivingWorktreeIds: next }
    })
  }
}
```

**WorktreeItem.tsx — Consume archiving state:**

```tsx
const archivingWorktreeIds = useWorktreeStore((s) => s.archivingWorktreeIds)
const isArchiving = archivingWorktreeIds.has(worktree.id)

// In the root div:
<div className={cn(
  'group flex items-center gap-2 px-3 py-1.5 ...',
  isArchiving && 'opacity-50 pointer-events-none'
)}>
  {/* Replace normal icon with spinner when archiving */}
  {isArchiving ? (
    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
  ) : (
    /* existing icon logic */
  )}
  {/* ... rest of content ... */}
</div>
```

#### 8.4 Files to Modify

| File                                                     | Change                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `src/renderer/src/stores/useWorktreeStore.ts`            | Add `archivingWorktreeIds` set, wrap archive in try/finally |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Consume archiving state, show dimmed + spinner              |

---

### 9. File Viewer Context Menu (Copy Path / Reveal in Finder)

#### 9.1 Current State

The file viewer (`FileViewer.tsx`) displays files in tabs managed by `useFileViewerStore`. The tab bar shows file names but has no right-click context menu. The file tree's `FileContextMenu` component already has "Copy Path", "Copy Relative Path", and "Reveal in Finder" actions, but these are only available in the sidebar file tree — not in the file viewer's tab bar.

The file viewer tab bar is rendered in the parent layout component that manages the tab strip. Each tab shows the file name and a close button. There is no `<ContextMenu>` wrapper.

#### 9.2 New Design

```
File Viewer Tab Context Menu:

  Right-click on a file viewer tab:
  ┌──────────────────────┐
  │ Copy Path            │
  │ Copy Relative Path   │
  │ ──────────────────── │
  │ Reveal in Finder     │
  │ Open in Editor       │
  │ ──────────────────── │
  │ Close                │
  │ Close Others         │
  │ Close All            │
  └──────────────────────┘

  Actions:
  - Copy Path: absolute path to clipboard
  - Copy Relative Path: relative to worktree root
  - Reveal in Finder: window.gitOps.showInFinder(path)
  - Open in Editor: window.gitOps.openInEditor(path)
  - Close / Close Others / Close All: file viewer store actions
```

#### 9.3 Implementation

**New `FileViewerTabContextMenu.tsx`:**

```tsx
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { Copy, FolderOpen, FileCode, X, XCircle } from 'lucide-react'
import { useFileViewerStore } from '@/stores/useFileViewerStore'

interface FileViewerTabContextMenuProps {
  children: React.ReactNode
  filePath: string
  worktreePath?: string
}

export function FileViewerTabContextMenu({
  children,
  filePath,
  worktreePath
}: FileViewerTabContextMenuProps) {
  const { closeFile, closeAllFiles, openFiles, activeFilePath } = useFileViewerStore()

  const handleCopyPath = async () => {
    await window.projectOps.copyToClipboard(filePath)
  }

  const handleCopyRelativePath = async () => {
    const relative =
      worktreePath && filePath.startsWith(worktreePath)
        ? filePath.slice(worktreePath.length).replace(/^\//, '')
        : filePath
    await window.projectOps.copyToClipboard(relative)
  }

  const handleRevealInFinder = async () => {
    await window.gitOps.showInFinder(filePath)
  }

  const handleOpenInEditor = async () => {
    await window.gitOps.openInEditor(filePath)
  }

  const handleClose = () => closeFile(filePath)

  const handleCloseOthers = () => {
    for (const [path] of openFiles) {
      if (path !== filePath) closeFile(path)
    }
  }

  const handleCloseAll = () => closeAllFiles()

  return (
    <ContextMenu>
      {children}
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={handleCopyPath}>
          <Copy className="mr-2 h-4 w-4" />
          Copy Path
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyRelativePath}>
          <Copy className="mr-2 h-4 w-4" />
          Copy Relative Path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleRevealInFinder}>
          <FolderOpen className="mr-2 h-4 w-4" />
          Reveal in Finder
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInEditor}>
          <FileCode className="mr-2 h-4 w-4" />
          Open in Editor
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleClose}>
          <X className="mr-2 h-4 w-4" />
          Close
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCloseOthers} disabled={openFiles.size <= 1}>
          <XCircle className="mr-2 h-4 w-4" />
          Close Others
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCloseAll}>
          <XCircle className="mr-2 h-4 w-4" />
          Close All
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
```

**Wrap file viewer tabs with the context menu** in the parent layout that renders the tab strip.

#### 9.4 Files to Modify

| File                                                                    | Change                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------ |
| `src/renderer/src/components/file-viewer/FileViewerTabContextMenu.tsx`  | **New file** — context menu for file viewer tabs |
| Parent component rendering file viewer tab strip (layout or FileViewer) | Wrap each tab in `FileViewerTabContextMenu`      |

---

## Files to Modify — Full Summary

### New Files

| File                                                                   | Feature |
| ---------------------------------------------------------------------- | ------- |
| `src/renderer/src/stores/usePromptHistoryStore.ts`                     | 1       |
| `src/renderer/src/components/sessions/QueuedMessageBubble.tsx`         | 3       |
| `src/renderer/src/components/sessions/tools/TodoListView.tsx`          | 5       |
| `src/renderer/src/components/file-viewer/FileViewerTabContextMenu.tsx` | 9       |

### Modified Files

| File                                                          | Features   | Change Summary                                                                 |
| ------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| `src/renderer/src/stores/index.ts`                            | 1          | Export `usePromptHistoryStore`                                                 |
| `src/renderer/src/stores/useContextStore.ts`                  | 2          | Rewrite: snapshot-based tokens, cost tracking, correct total formula           |
| `src/renderer/src/stores/useWorktreeStore.ts`                 | 8          | Add `archivingWorktreeIds` set, wrap archive in try/finally                    |
| `src/renderer/src/components/sessions/SessionView.tsx`        | 1, 2, 3, 7 | Prompt history navigation, token extraction fix, queued message content, focus |
| `src/renderer/src/components/sessions/ContextIndicator.tsx`   | 2          | Update total formula, add cost display                                         |
| `src/renderer/src/components/sessions/ToolCard.tsx`           | 4, 5       | Compact inline mode for file ops, register TodoWrite renderer                  |
| `src/renderer/src/components/sessions/QueuedIndicator.tsx`    | 3          | Remove or replace with QueuedMessageBubble                                     |
| `src/renderer/src/components/sessions/tools/TodoToolView.tsx` | 5          | Remains as generic fallback (TodoListView handles TodoWrite specifically)      |
| `src/renderer/src/components/file-viewer/FileViewer.tsx`      | 6          | Markdown preview mode with source/preview toggle                               |
| `src/renderer/src/components/sessions/MarkdownRenderer.tsx`   | 6          | Ensure exportable for reuse in FileViewer                                      |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx`      | 8          | Consume archiving state, dimmed + spinner UI                                   |
| Parent component rendering file viewer tab strip              | 9          | Wrap tabs in FileViewerTabContextMenu                                          |

---

## Dependencies to Add

```bash
# No new dependencies — all features use existing packages:
# - zustand (stores — already installed)
# - react-markdown + remark-gfm (markdown rendering — already installed)
# - lucide-react (icons — already installed)
# - react-syntax-highlighter (code display — already installed)
# - @radix-ui/react-context-menu via shadcn (context menus — already installed)
```

---

## Non-Functional Requirements

| Requirement                         | Target                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------- |
| Prompt history Up/Down key response | < 16ms (single frame) from keypress to textarea content update             |
| Prompt history storage              | Max 100 entries per branch, ~50KB localStorage budget per branch           |
| Context calculation accuracy        | 100% match with official OpenCode client for same session data             |
| Context update from streaming       | < 100ms from message completion event to indicator update                  |
| Queued message bubble render        | < 16ms from send click to queued bubble visible at bottom                  |
| Queued message transition           | Queued bubble disappears within one render cycle of real message appearing |
| Compact tool card render            | File operation tool cards take ≤ 24px vertical height when collapsed       |
| TodoWrite list render               | Parsed and rendered within 1 frame for lists up to 50 items                |
| Markdown file preview render        | < 500ms from file load to fully rendered markdown for files up to 100KB    |
| Session auto-focus                  | Textarea focused within 1 frame of SessionView mount                       |
| Archive loading state visibility    | Dimmed + spinner visible within 1 frame of archive initiation              |
| File viewer context menu            | < 50ms from right-click to menu visible                                    |

---

## Out of Scope (Phase 12)

- Prompt history search/filter (only sequential up/down navigation)
- Prompt history sync across devices (localStorage only)
- Context breakdown bar with category visualization (system/user/assistant/tool segments — optional in CONTEXT_CALCULATION.md)
- Context overflow detection and compaction UI (server handles compaction automatically)
- Queued message editing or reordering before send
- Queued message cancellation (message is already sent to SDK)
- Compact inline mode for Bash, Grep, Glob, Task tools (only Read/Write/Edit)
- TodoWrite interactive editing (checking/unchecking items — read-only display)
- Markdown preview for files opened via tool calls (only file viewer)
- Markdown live editing or split-pane editor
- File viewer tab drag-and-drop reordering
- File viewer tab pinning

---

## Implementation Priority

### Sprint 1: Core Correctness (Highest Priority — Fixes Broken Behavior)

1. **Feature 2 — Context Calculation Fix**: The current context display is fundamentally wrong (cumulative vs. snapshot, wrong formula). This directly misleads users about their context window usage. Fixing this is the highest priority.
2. **Feature 7 — Auto-Focus on New Session**: Tiny change, high UX impact. Users expect focus in the input after creating a session.

### Sprint 2: Input & Message UX (High Priority — User-Facing Improvements)

3. **Feature 1 — Prompt History Navigation**: Standard terminal/chat UX pattern. Users expect up-arrow to recall previous messages. Scoped per branch for relevance.
4. **Feature 3 — Queued Message Placement**: Users currently can't see what they queued. The sticky bubble with QUEUED badge provides immediate visual feedback.

### Sprint 3: Visual Redesign (Medium-High Priority — Cleaner Chat Experience)

5. **Feature 4 — Read/Write/Edit Compact Design**: Reduces visual noise significantly. 10 file operations that previously took 10 bordered cards now take 10 small lines. Major readability improvement.
6. **Feature 5 — TodoWrite Rendering**: Transforms unreadable JSON blobs into a clean task list. Important for AI agent workflows that use todo tracking.

### Sprint 4: Polish (Medium Priority — Quality of Life)

7. **Feature 6 — Markdown File Preview**: Natural expectation when opening `.md` files. Leverages existing MarkdownRenderer.
8. **Feature 8 — Archive Loading State**: Prevents confusion during multi-second archive operations. Small change, good UX.
9. **Feature 9 — File Viewer Context Menu**: Standard IDE affordance. The actions already exist in the file tree — just need to be available in the viewer too.

---

## Success Metrics

- Pressing Up arrow at cursor position 0 in an empty textarea recalls the last sent message for that branch
- Pressing Down arrow at cursor end returns to the saved draft or clears the field
- History stores up to 100 prompts per branch and survives app restarts (localStorage)
- Context usage percentage matches the official OpenCode TUI when viewing the same session
- Context indicator shows total = input + output + reasoning + cache.read + cache.write
- Context tooltip displays session cost accumulated across all assistant messages
- Queued messages appear as styled bubbles at the bottom of the chat with a visible QUEUED badge
- Queued bubbles disappear when the stream completes and the real message renders
- Read, Write, and Edit tool calls render as compact single-line `{icon} {tool} {file}` entries
- Compact tool lines expand on click to show full syntax-highlighted content
- The loading state shows an animated icon (`...` or spinner) that changes to `+` on completion
- TodoWrite tool output renders as a checklist with status icons (check, spinner, circle, x) and priority badges
- Opening a `.md` file in the file viewer shows rendered markdown by default with a Source/Preview toggle
- Clicking `+` to create a new session immediately focuses the message textarea
- Archiving a worktree dims the item and shows a spinner until the operation completes
- Right-clicking a file viewer tab shows Copy Path, Copy Relative Path, Reveal in Finder, Open in Editor, Close, Close Others, Close All
