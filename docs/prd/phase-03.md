# Hive - Phase 3 Product Requirements Document

## Overview

**Phase 3** focuses on **UX/UI polish, bug fixes, and overall app feel**. The primary work is refining the chat experience: redesigning the input area, relocating the build/plan mode toggle, properly rendering markdown in assistant messages, polishing tool call visuals, and adding response logging for debugging.

### Phase 3 Goals
- Polish the bottom input area for a cleaner, more refined feel
- Move build/plan mode toggle into the input area with mode-aware border colors
- Render assistant messages as proper markdown (headings, lists, code, tables, etc.)
- Polish tool call card UX/UI (spacing, animations, better states)
- Add `--log` CLI flag to dump all OpenCode responses to a file for debugging

---

## Technical Additions

| Component | Technology |
|-----------|------------|
| Markdown Rendering | react-markdown + remark-gfm |
| Syntax Highlighting | rehype-highlight or react-syntax-highlighter |

---

## Features

### 1. Input Area Redesign

#### 1.1 Current State
The input area is a basic textarea with a send button, separated by a border-top. The mode toggle lives in a separate header bar above the chat.

```
Current:
┌──────────────────────────────────────────────────────────┐
│ [🔨 Build]                          Shift+Tab to toggle  │  ← Separate header bar
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Chat messages...                                        │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────┐ [▶]  │  ← Basic textarea + button
│ │ Type your message...                            │      │
│ └────────────────────────────────────────────────┘      │
│ Press Enter to send, Shift+Enter for new line            │
└──────────────────────────────────────────────────────────┘
```

#### 1.2 New Design

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  Chat messages...                                        │
│                                                          │
│                                                          │
│  ┌─── blue border (build mode) ──────────────────────┐  │
│  │ [🔨 Build ▾]                                      │  │
│  │                                                    │  │
│  │  Type your message...                              │  │
│  │                                                    │  │
│  │                                  [Enter to send ▶] │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Key Changes**:
- Remove the separate mode header bar from `MainPane.tsx`
- Wrap the entire input section (mode toggle + textarea + send) in a single bordered container
- Container has rounded corners and a colored border based on current mode
- Mode toggle sits top-left inside the container
- Textarea is borderless inside the container (no double borders)
- Send button sits bottom-right inside the container
- Subtle background tint matching the mode color
- The `border-t border-border` separator above the input is removed — the input container floats at the bottom with padding

#### 1.3 Mode-Aware Border Colors

| Mode | Border Color | Background Tint |
|------|-------------|-----------------|
| **Build** | `border-blue-500` | `bg-blue-500/5` |
| **Plan** | `border-violet-500` | `bg-violet-500/5` |

- Transition between colors should be smooth: `transition-colors duration-200`
- Border width: `border-2` (slightly thicker than default to make color visible)

#### 1.4 Input Container Layout

```typescript
// Pseudocode structure
<div className="p-4 bg-background">
  <div className={cn(
    "max-w-3xl mx-auto rounded-xl border-2 overflow-hidden transition-colors duration-200",
    mode === 'build'
      ? "border-blue-500/50 bg-blue-500/5"
      : "border-violet-500/50 bg-violet-500/5"
  )}>
    {/* Top row: mode toggle */}
    <div className="flex items-center px-3 pt-2">
      <ModeToggle sessionId={sessionId} />
    </div>

    {/* Textarea - no border */}
    <textarea
      className="w-full bg-transparent border-none resize-none px-3 py-2 focus:outline-none"
      placeholder="Type your message..."
    />

    {/* Bottom row: hints + send button */}
    <div className="flex items-center justify-between px-3 pb-2">
      <span className="text-xs text-muted-foreground">
        Enter to send, Shift+Enter for new line
      </span>
      <Button size="sm">
        <Send className="h-4 w-4" />
      </Button>
    </div>
  </div>
</div>
```

#### 1.5 ModeToggle Updates
- Keep the same `ModeToggle` component but restyle it slightly to fit inside the input container
- Compact pill shape: icon + label + small dropdown chevron
- Clicking toggles between Build/Plan (same behavior as today)
- Shift+Tab keyboard shortcut still works globally
- Remove the "Shift+Tab to toggle mode" text from the old header — the hint is now part of the toggle's tooltip

---

### 2. Move Build/Plan Mode to Input Area

#### 2.1 Changes to MainPane.tsx
- **Remove** the entire session header bar that currently contains `<ModeToggle>` and the "Shift+Tab to toggle" hint (lines 68-77 in `MainPane.tsx`)
- The mode toggle now lives inside `SessionView.tsx`'s input area

#### 2.2 Changes to SessionView.tsx
- Import and render `ModeToggle` inside the new input container (see 1.4 above)
- The mode state is already read from `useSessionStore.modeBySession` — no store changes needed

#### 2.3 Keyboard Shortcut
- `Shift+Tab` continues to work from anywhere in the session view
- No changes to the shortcut system

---

### 3. Markdown Rendering for Assistant Messages

#### 3.1 Current State
`AssistantCanvas.tsx` uses a custom regex (`` /```(\w+)?\n([\s\S]*?)```/g ``) that only extracts fenced code blocks. Everything else is rendered as `<span className="whitespace-pre-wrap">` — no headings, bold, lists, tables, links, or any other markdown.

#### 3.2 New Approach
Replace the custom `parseContent()` function with `react-markdown` + `remark-gfm`.

**Dependencies to Install**:
```bash
pnpm add react-markdown remark-gfm react-syntax-highlighter
pnpm add -D @types/react-syntax-highlighter
```

#### 3.3 MarkdownRenderer Component

Create `src/renderer/src/components/sessions/MarkdownRenderer.tsx`:

```typescript
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

interface MarkdownRendererProps {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '')
          const isInline = !match
          if (isInline) {
            return <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono" {...props}>{children}</code>
          }
          return (
            <CodeBlock
              code={String(children).replace(/\n$/, '')}
              language={match[1]}
            />
          )
        },
        // Style other elements with Tailwind
        h1: ({ children }) => <h1 className="text-xl font-bold mt-4 mb-2">{children}</h1>,
        h2: ({ children }) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
        h3: ({ children }) => <h3 className="text-base font-semibold mt-2 mb-1">{children}</h3>,
        p: ({ children }) => <p className="mb-2 leading-relaxed">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-6 mb-2 space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-6 mb-2 space-y-1">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-muted-foreground/30 pl-4 italic text-muted-foreground my-2">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="min-w-full text-sm border border-border rounded">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-border px-3 py-1.5 bg-muted font-medium text-left">{children}</th>
        ),
        td: ({ children }) => <td className="border border-border px-3 py-1.5">{children}</td>,
        a: ({ href, children }) => (
          <a href={href} className="text-blue-500 hover:underline" target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        hr: () => <hr className="my-4 border-border" />,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
```

#### 3.4 Integration with AssistantCanvas

- Replace `parseContent(text)` calls with `<MarkdownRenderer content={text} />`
- Keep the existing `CodeBlock` component (with copy button) — reuse it as the code block renderer inside `MarkdownRenderer`
- Keep the `renderParts()` function structure — just swap the text rendering:

```typescript
// Before:
{parseContent(part.text)}

// After:
<MarkdownRenderer content={part.text} />
```

#### 3.5 Styling Considerations
- Use Tailwind typography classes on the assistant message wrapper
- Ensure code blocks maintain their current dark theme look (zinc-900 background)
- Links should open in external browser (Electron `shell.openExternal`)
- Tables should be horizontally scrollable on narrow widths
- Keep generous line-height for readability

---

### 4. Tool Call Card Polish

#### 4.1 Visual Refinements

**Spacing & Layout**:
- Increase vertical margin between tool cards: `my-3` (currently `my-2`)
- Add subtle left border accent for status indication instead of full border color change
- Consistent inner padding: `px-3.5 py-2.5`

**Status-based Left Border**:

| Status | Left Border | Icon |
|--------|------------|------|
| pending | `border-l-2 border-l-muted-foreground` | Spinner (gray) |
| running | `border-l-2 border-l-blue-500` | Spinner (blue) |
| success | `border-l-2 border-l-green-500` | Checkmark (green) |
| error | `border-l-2 border-l-red-500` | X (red) |

**Animation**:
- Running state: subtle pulse animation on the left border
- Success transition: brief flash of green background that fades out
- Expand/collapse: smooth height transition with `transition-all duration-150`

#### 4.2 Compact Mode for Sequential Tools
When multiple tool calls appear in sequence (e.g., 5 Read calls in a row), collapse them into a summary:

```
┌─ 📄 Read  ...components/App.tsx            ✓  0.2s  ─┐
├─ 📄 Read  ...hooks/useAuth.ts              ✓  0.1s  ─┤
├─ 📄 Read  ...services/api.ts               ✓  0.3s  ─┤
└─ 3 files read                              ✓  0.6s  ─┘
```

- Auto-collapse sequential same-type tool calls when there are 3+ in a row
- Show a summary row with total count and combined duration
- Click to expand individual cards
- This is an optional enhancement — implement if time permits

#### 4.3 Tool Output Improvements
- Syntax highlight output when it looks like code (detect JSON, TypeScript, etc.)
- Better truncation: show first 10 lines + "Show more" button instead of hard character cutoff
- For error output: red-tinted background with monospace font (already done, keep as-is)

---

### 5. Response Logging (`--log` Flag)

#### 5.1 Purpose
When developing and debugging the app, it's hard to inspect what OpenCode is actually sending back. Adding a `--log` flag enables dumping all raw OpenCode responses to a file.

#### 5.2 CLI Flag Parsing

In `src/main/index.ts`, parse command line arguments:

```typescript
// Parse CLI flags
const args = process.argv.slice(2)
const isLogMode = args.includes('--log')

if (isLogMode) {
  log.info('Response logging enabled via --log flag')
}
```

Expose the flag to the renderer via IPC:

```typescript
ipcMain.handle('system:isLogMode', () => isLogMode)
```

#### 5.3 Response Logger

Create `src/main/services/response-logger.ts`:

```typescript
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const LOG_DIR = join(app.getPath('home'), '.hive', 'logs', 'responses')

export function createResponseLog(sessionId: string): string {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = join(LOG_DIR, `${sessionId}-${timestamp}.jsonl`)

  // Write header
  writeFileSync(filePath, JSON.stringify({
    type: 'session_start',
    sessionId,
    startedAt: new Date().toISOString()
  }) + '\n')

  return filePath
}

export function appendResponseLog(filePath: string, data: unknown): void {
  appendFileSync(filePath, JSON.stringify({
    timestamp: new Date().toISOString(),
    ...data
  }) + '\n')
}
```

#### 5.4 Integration Points

In the OpenCode event handler (SessionView.tsx stream processing), when `--log` is enabled:
- Log every `message.part.updated` event (text deltas, tool use updates)
- Log every `message.updated` event (completed messages)
- Log every `session.idle` event
- Log user prompts being sent

The log file is JSONL format (one JSON object per line) for easy inspection with `jq` or any text editor.

#### 5.5 Log File Location
```
~/.hive/logs/responses/
├── {sessionId}-2024-01-15T10-30-00-000Z.jsonl
├── {sessionId}-2024-01-15T11-45-00-000Z.jsonl
└── ...
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/renderer/src/components/sessions/SessionView.tsx` | Redesign input area, integrate ModeToggle, add response logging hook |
| `src/renderer/src/components/sessions/ModeToggle.tsx` | Restyle for compact inline use |
| `src/renderer/src/components/sessions/AssistantCanvas.tsx` | Replace regex parser with MarkdownRenderer |
| `src/renderer/src/components/sessions/MarkdownRenderer.tsx` | **NEW** - react-markdown based renderer |
| `src/renderer/src/components/sessions/ToolCard.tsx` | Polish spacing, left border status, animations |
| `src/renderer/src/components/layout/MainPane.tsx` | Remove mode toggle header bar |
| `src/main/index.ts` | Parse `--log` CLI flag, expose via IPC |
| `src/main/services/response-logger.ts` | **NEW** - JSONL response logging service |

## Dependencies to Add

```bash
pnpm add react-markdown remark-gfm react-syntax-highlighter
pnpm add -D @types/react-syntax-highlighter
```

---

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Markdown render time | < 50ms for typical message |
| Mode toggle response | < 100ms visual feedback |
| Input area re-render | No visible flicker on mode switch |
| Log file write | Non-blocking, no UI impact |
| Tool card expand/collapse | Smooth animation < 150ms |

---

## Out of Scope (Phase 3)

- Merge conflict UI
- Git authentication improvements
- New sidebar panels
- Plugin system
- Onboarding flow
- Auto-updates
- Multi-window support

---

## Implementation Priority

### Sprint 1: Input Area + Mode Toggle
1. Remove mode header from MainPane.tsx
2. Redesign input area in SessionView.tsx with bordered container
3. Integrate ModeToggle inside input container
4. Add mode-aware border colors (blue/purple)
5. Polish spacing, transitions, placeholder text

### Sprint 2: Markdown Rendering
1. Install react-markdown + remark-gfm + react-syntax-highlighter
2. Create MarkdownRenderer component
3. Replace parseContent() in AssistantCanvas with MarkdownRenderer
4. Style all markdown elements with Tailwind
5. Verify code blocks keep copy button and dark theme

### Sprint 3: Tool Card Polish
1. Add left border status indicator
2. Improve spacing and padding
3. Add expand/collapse animation
4. Better output truncation with "Show more"
5. (Optional) Sequential tool grouping

### Sprint 4: Response Logging
1. Parse --log flag in main process
2. Create response-logger service
3. Wire up OpenCode event handlers to log when flag is active
4. Expose flag to renderer via IPC
5. Test with `--log` and inspect output files

---

## Success Metrics

- Input area feels cohesive (mode + textarea + send as one unit)
- Mode switch border color change is smooth and immediate
- Markdown renders correctly: headings, lists, bold, italic, code, tables, links
- Code blocks have syntax highlighting and copy button
- Tool cards have clear status indication at a glance
- `--log` flag produces inspectable JSONL files with all OpenCode responses
