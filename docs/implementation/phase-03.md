# Hive Phase 3 Implementation Plan

This document outlines the implementation plan for Hive Phase 3, focusing on UX/UI polish, markdown rendering, tool call refinement, and response logging.

---

## Overview

The implementation is divided into **6 focused sessions**, each with:
- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 3 builds upon Phase 2** — all Phase 2 infrastructure (file tree, git operations, command palette, settings, chat layout, tool cards, build/plan mode) is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 3)
```
test/
├── phase-3/
│   ├── session-1/
│   │   └── input-area-redesign.test.ts
│   ├── session-2/
│   │   └── markdown-rendering.test.ts
│   ├── session-3/
│   │   └── tool-card-polish.test.ts
│   ├── session-4/
│   │   └── response-logging.test.ts
│   ├── session-5/
│   │   └── preload-ipc-logging.test.ts
│   └── session-6/
│       └── integration-polish.test.ts
```

### New Dependencies
```json
{
  "react-markdown": "^9.0.0",
  "remark-gfm": "^4.0.0",
  "react-syntax-highlighter": "^15.6.0",
  "@types/react-syntax-highlighter": "^15.5.0"
}
```

---

## Session 1: Input Area Redesign & Mode Toggle Relocation

### Objectives
- Redesign the bottom input area as a single cohesive container
- Move the build/plan mode toggle from the session header into the input container
- Apply mode-aware border colors (blue for build, purple for plan)
- Remove the separate mode header bar from MainPane.tsx

### Tasks
1. Remove the session header bar (lines 68-77) from `src/renderer/src/components/layout/MainPane.tsx` that contains `<ModeToggle>` and the "Shift+Tab to toggle" hint
2. Remove the `ModeToggle` import from `MainPane.tsx`
3. In `SessionView.tsx`, replace the current input area (lines 631-668) with a new bordered container layout:
   - Outer wrapper: `p-4 bg-background` (replaces `border-t border-border p-4 bg-background`)
   - Inner container: `max-w-3xl mx-auto rounded-xl border-2 transition-colors duration-200` with mode-aware colors
   - Top row inside container: `<ModeToggle sessionId={sessionId} />`
   - Middle: borderless textarea with `bg-transparent focus:outline-none`
   - Bottom row: hint text on left, send button on right
4. Import `ModeToggle` into `SessionView.tsx`
5. Read mode from `useSessionStore` via `modeBySession.get(sessionId)` to drive border color
6. Apply border colors: `border-blue-500/50 bg-blue-500/5` for build, `border-violet-500/50 bg-violet-500/5` for plan
7. Update `ModeToggle.tsx` styling to be more compact for inline use — smaller padding, keep the pill shape
8. Preserve all existing textarea behavior: auto-resize, Enter to send, Shift+Enter for newline, disabled during send
9. Preserve Shift+Tab keyboard shortcut (no changes to shortcut system needed)
10. Export `ModeToggle` from sessions index if not already done

### Key Files
- `src/renderer/src/components/layout/MainPane.tsx` — remove mode header bar
- `src/renderer/src/components/sessions/SessionView.tsx` — redesign input area
- `src/renderer/src/components/sessions/ModeToggle.tsx` — restyle for compact inline use
- `src/renderer/src/stores/useSessionStore.ts` — read mode (no changes needed)

### Definition of Done
- [ ] Mode header bar removed from MainPane.tsx (no `session-header` div)
- [ ] Input area rendered as single bordered container with rounded corners
- [ ] ModeToggle appears top-left inside the input container
- [ ] Build mode shows blue border (`border-blue-500/50`)
- [ ] Plan mode shows purple border (`border-violet-500/50`)
- [ ] Border color transitions smoothly when toggling mode
- [ ] Textarea has no visible border (borderless inside container)
- [ ] Send button sits bottom-right inside container
- [ ] Hint text ("Enter to send, Shift+Enter for new line") sits bottom-left
- [ ] Shift+Tab still toggles mode
- [ ] Enter to send still works
- [ ] Shift+Enter for newline still works
- [ ] Auto-resize textarea still works
- [ ] Send button disabled when input empty or sending

### Testing Criteria
```typescript
// test/phase-3/session-1/input-area-redesign.test.ts
describe('Session 1: Input Area Redesign', () => {
  test('Mode header bar is removed from MainPane', async () => {
    // Query for data-testid="session-header"
    // Verify it does NOT exist in the DOM
  });

  test('Input area renders as single bordered container', async () => {
    // Query for data-testid="input-area"
    // Verify it has rounded-xl and border-2 classes
  });

  test('ModeToggle appears inside input container', async () => {
    // Query for data-testid="mode-toggle"
    // Verify it's a descendant of data-testid="input-area"
  });

  test('Build mode shows blue border', async () => {
    // Default mode is build
    // Verify input container has border-blue-500/50 class
  });

  test('Plan mode shows purple border', async () => {
    // Toggle to plan mode
    // Verify input container has border-violet-500/50 class
  });

  test('Border color transitions smoothly', async () => {
    // Verify input container has transition-colors and duration-200 classes
  });

  test('Textarea has no visible border', async () => {
    // Query textarea inside input container
    // Verify it has border-none or no border classes
  });

  test('Send button sits inside container bottom-right', async () => {
    // Query for data-testid="send-button"
    // Verify it's inside data-testid="input-area"
  });

  test('Shift+Tab toggles mode from input area', async () => {
    // Focus textarea
    // Press Shift+Tab
    // Verify mode changes (border color changes)
  });

  test('Enter sends message', async () => {
    // Type message, press Enter
    // Verify message sent (input cleared)
  });

  test('Shift+Enter creates new line', async () => {
    // Type text, press Shift+Enter
    // Verify textarea has newline (not sent)
  });

  test('Textarea auto-resizes', async () => {
    // Type multiple lines
    // Verify textarea height increases
  });

  test('Send button disabled when empty', async () => {
    // Empty textarea
    // Verify send button is disabled
  });
});
```

---

## Session 2: Markdown Rendering for Assistant Messages

### Objectives
- Install markdown rendering dependencies
- Create a MarkdownRenderer component using react-markdown
- Replace the custom regex-based `parseContent()` in AssistantCanvas with proper markdown rendering
- Style all markdown elements with Tailwind
- Keep existing CodeBlock component for fenced code blocks

### Tasks
1. Install dependencies: `pnpm add react-markdown remark-gfm react-syntax-highlighter && pnpm add -D @types/react-syntax-highlighter`
2. Create `src/renderer/src/components/sessions/MarkdownRenderer.tsx`:
   - Import `ReactMarkdown` from `react-markdown` and `remarkGfm` from `remark-gfm`
   - Custom component overrides for: `code`, `h1`-`h3`, `p`, `ul`, `ol`, `li`, `blockquote`, `table`, `th`, `td`, `a`, `hr`, `strong`, `em`
   - For fenced code blocks: delegate to existing `CodeBlock` component (move it from AssistantCanvas or import it)
   - For inline code: render with `bg-muted px-1.5 py-0.5 rounded text-sm font-mono`
3. Extract `CodeBlock` component from `AssistantCanvas.tsx` into its own file `CodeBlock.tsx` (or keep inline — depends on import complexity)
4. In `AssistantCanvas.tsx`:
   - Remove the `parseContent()` function (lines 64-97)
   - Remove the code block regex
   - Import `MarkdownRenderer`
   - Replace `{parseContent(part.text)}` with `<MarkdownRenderer content={part.text} />`
   - Replace `{parseContent(content)}` with `<MarkdownRenderer content={content} />`
5. Style markdown elements with Tailwind classes matching the app's dark/light theme
6. Ensure links have `target="_blank" rel="noopener noreferrer"` for Electron safety
7. Export `MarkdownRenderer` from sessions index
8. Test with various markdown: headings, bold, italic, lists, tables, code blocks, inline code, links, blockquotes

### Key Files
- `src/renderer/src/components/sessions/MarkdownRenderer.tsx` — **NEW**
- `src/renderer/src/components/sessions/AssistantCanvas.tsx` — replace parseContent with MarkdownRenderer
- `src/renderer/src/components/sessions/index.ts` — add export
- `package.json` — new dependencies

### Definition of Done
- [ ] `react-markdown`, `remark-gfm`, `react-syntax-highlighter` installed
- [ ] MarkdownRenderer component created and exported
- [ ] `parseContent()` function removed from AssistantCanvas
- [ ] Headings (`#`, `##`, `###`) render with correct sizes and weights
- [ ] **Bold** and *italic* text renders correctly
- [ ] Unordered and ordered lists render with bullets/numbers
- [ ] Tables render with borders, headers, and horizontal scroll
- [ ] Fenced code blocks render with CodeBlock component (copy button, language label, dark background)
- [ ] Inline code renders with muted background and monospace font
- [ ] Links render as blue and open in external browser
- [ ] Blockquotes render with left border and italic style
- [ ] Horizontal rules render as dividers
- [ ] Streaming text still works (cursor appears at end)
- [ ] Tool cards still render inline between markdown sections

### Testing Criteria
```typescript
// test/phase-3/session-2/markdown-rendering.test.ts
describe('Session 2: Markdown Rendering', () => {
  test('Headings render with correct styles', async () => {
    // Render assistant message with "# Title\n## Subtitle\n### Section"
    // Verify h1 has text-xl font-bold
    // Verify h2 has text-lg font-semibold
    // Verify h3 has text-base font-semibold
  });

  test('Bold and italic render correctly', async () => {
    // Render "**bold** and *italic*"
    // Verify <strong> and <em> elements exist
  });

  test('Unordered list renders with bullets', async () => {
    // Render "- item 1\n- item 2\n- item 3"
    // Verify <ul> with list-disc class
    // Verify 3 <li> elements
  });

  test('Ordered list renders with numbers', async () => {
    // Render "1. first\n2. second"
    // Verify <ol> with list-decimal class
  });

  test('Tables render with borders and headers', async () => {
    // Render "| Col1 | Col2 |\n|------|------|\n| A | B |"
    // Verify <table> element with border classes
    // Verify <th> elements with bg-muted
  });

  test('Fenced code blocks use CodeBlock component', async () => {
    // Render "```typescript\nconst x = 1;\n```"
    // Verify data-testid="code-block" exists
    // Verify copy button present
    // Verify language label shows "typescript"
  });

  test('Inline code renders with muted background', async () => {
    // Render "Use `const` for constants"
    // Verify <code> element with bg-muted class
  });

  test('Links render and have correct attributes', async () => {
    // Render "[click here](https://example.com)"
    // Verify <a> with href, target="_blank", rel="noopener noreferrer"
  });

  test('Blockquotes render with left border', async () => {
    // Render "> This is a quote"
    // Verify <blockquote> with border-l-2 class
  });

  test('Streaming text with markdown still shows cursor', async () => {
    // Render streaming assistant message with markdown content
    // Verify StreamingCursor appears at end
  });

  test('Tool cards still render between markdown sections', async () => {
    // Render parts with text → tool_use → text
    // Verify ToolCard renders between MarkdownRenderer sections
  });

  test('Markdown renders under 50ms for typical message', async () => {
    // Time render of 500-word markdown message
    // Assert < 50ms
  });
});
```

---

## Session 3: Tool Call Card Polish

### Objectives
- Add status-based left border accent to tool cards
- Improve spacing, padding, and visual hierarchy
- Add smooth expand/collapse animation
- Replace hard character truncation with line-based "Show more" button
- Add subtle status transition animations

### Tasks
1. In `ToolCard.tsx`, add left border based on status:
   - `pending`: `border-l-2 border-l-muted-foreground`
   - `running`: `border-l-2 border-l-blue-500`
   - `success`: `border-l-2 border-l-green-500`
   - `error`: `border-l-2 border-l-red-500`
2. Increase vertical margin from `my-2` to `my-3`
3. Update inner padding from `px-3 py-2` to `px-3.5 py-2.5`
4. Add `transition-all duration-150` to the expandable output section for smooth expand/collapse
5. Replace the 2000-character truncation with a line-based approach:
   - Show first 10 lines by default
   - Add "Show more" / "Show less" button when output exceeds 10 lines
   - Use state to toggle between truncated and full view
6. Add `animate-pulse` to the left border when status is `running`
7. Keep the existing error full-border styling (`border-red-500/30 bg-red-500/5`) in addition to the left border
8. Ensure the expand/collapse chevron transition rotates smoothly

### Key Files
- `src/renderer/src/components/sessions/ToolCard.tsx` — all visual changes

### Definition of Done
- [ ] Pending tools have gray left border
- [ ] Running tools have blue left border with pulse animation
- [ ] Successful tools have green left border
- [ ] Error tools have red left border (plus existing red border)
- [ ] Vertical spacing between cards is `my-3`
- [ ] Inner padding is `px-3.5 py-2.5`
- [ ] Expand/collapse has smooth height transition
- [ ] Output shows first 10 lines when truncated
- [ ] "Show more" button appears when output exceeds 10 lines
- [ ] "Show less" button collapses back to 10 lines
- [ ] Running state left border pulses

### Testing Criteria
```typescript
// test/phase-3/session-3/tool-card-polish.test.ts
describe('Session 3: Tool Card Polish', () => {
  test('Pending tool has gray left border', async () => {
    // Render ToolCard with status="pending"
    // Verify border-l-2 and border-l-muted-foreground classes
  });

  test('Running tool has blue left border', async () => {
    // Render ToolCard with status="running"
    // Verify border-l-2 and border-l-blue-500 classes
  });

  test('Successful tool has green left border', async () => {
    // Render ToolCard with status="success"
    // Verify border-l-2 and border-l-green-500 classes
  });

  test('Error tool has red left border', async () => {
    // Render ToolCard with status="error"
    // Verify border-l-2 and border-l-red-500 classes
  });

  test('Running tool left border pulses', async () => {
    // Render ToolCard with status="running"
    // Verify animate-pulse class on border element
  });

  test('Tool cards have increased vertical margin', async () => {
    // Render ToolCard
    // Verify my-3 class
  });

  test('Expand/collapse has smooth transition', async () => {
    // Render ToolCard with output
    // Verify transition-all and duration-150 classes on output section
  });

  test('Long output truncated to 10 lines', async () => {
    // Render ToolCard with 50-line output
    // Verify only 10 lines visible initially
  });

  test('Show more button appears for long output', async () => {
    // Render ToolCard with 50-line output, expand it
    // Verify "Show more" button visible
  });

  test('Show more reveals full output', async () => {
    // Click "Show more"
    // Verify all 50 lines visible
  });

  test('Show less collapses back to 10 lines', async () => {
    // Click "Show less" after expanding
    // Verify back to 10 lines
  });
});
```

---

## Session 4: Response Logging — Main Process

### Objectives
- Parse `--log` CLI flag in the Electron main process
- Create the response logger service for writing JSONL files
- Expose the log mode flag to the renderer via IPC
- Wire up response logging in OpenCode event handlers

### Tasks
1. In `src/main/index.ts`, add CLI flag parsing before `app.whenReady()`:
   ```typescript
   const cliArgs = process.argv.slice(2)
   const isLogMode = cliArgs.includes('--log')
   ```
2. Add `isLogMode` logging: `if (isLogMode) { log.info('Response logging enabled via --log flag') }`
3. Add IPC handler in `registerSystemHandlers()`: `ipcMain.handle('system:isLogMode', () => isLogMode)`
4. Create `src/main/services/response-logger.ts`:
   - `createResponseLog(sessionId: string): string` — creates JSONL file, writes header, returns file path
   - `appendResponseLog(filePath: string, data: unknown): void` — appends JSON line to file
   - Log directory: `~/.hive/logs/responses/`
   - File naming: `{sessionId}-{timestamp}.jsonl`
   - Follow pattern from existing `src/main/services/logger.ts`
5. Wire up response logging IPC handlers:
   - `ipcMain.handle('logging:createResponseLog', (_, sessionId) => createResponseLog(sessionId))`
   - `ipcMain.handle('logging:appendResponseLog', (_, filePath, data) => appendResponseLog(filePath, data))`
   - Only register these handlers when `isLogMode` is true

### Key Files
- `src/main/index.ts` — CLI flag parsing + IPC handler registration
- `src/main/services/response-logger.ts` — **NEW** JSONL logger service
- `src/main/services/logger.ts` — reference for logging patterns (read-only)

### Definition of Done
- [ ] `--log` flag parsed from `process.argv`
- [ ] Log message printed when `--log` is active
- [ ] `system:isLogMode` IPC handler returns boolean
- [ ] `response-logger.ts` service created with `createResponseLog` and `appendResponseLog`
- [ ] Log files written to `~/.hive/logs/responses/`
- [ ] Log files use JSONL format (one JSON object per line)
- [ ] Session start header written when log created
- [ ] Each log entry has timestamp
- [ ] Logging IPC handlers only registered when `--log` is active
- [ ] File write is synchronous but fast (append-only)

### Testing Criteria
```typescript
// test/phase-3/session-4/response-logging.test.ts
describe('Session 4: Response Logging — Main Process', () => {
  test('--log flag is parsed from argv', async () => {
    // Mock process.argv with --log
    // Verify isLogMode is true
  });

  test('--log flag absent means logging disabled', async () => {
    // Mock process.argv without --log
    // Verify isLogMode is false
  });

  test('system:isLogMode IPC returns correct value', async () => {
    // Invoke system:isLogMode
    // Verify returns true when --log passed
  });

  test('createResponseLog creates JSONL file', async () => {
    // Call createResponseLog with session ID
    // Verify file exists at expected path
    // Verify first line is valid JSON with type: "session_start"
  });

  test('appendResponseLog appends JSON line', async () => {
    // Create log, append data
    // Read file, verify 2 lines (header + appended)
    // Verify each line is valid JSON
  });

  test('Log file goes to ~/.hive/logs/responses/', async () => {
    // Call createResponseLog
    // Verify file path starts with expected directory
  });

  test('Log entries have timestamps', async () => {
    // Append log entry
    // Parse the line, verify timestamp field exists
  });

  test('Logging IPC handlers not registered when --log absent', async () => {
    // Start without --log
    // Invoke logging:createResponseLog
    // Verify handler not found / returns error
  });
});
```

---

## Session 5: Response Logging — Renderer Integration

### Objectives
- Expose logging IPC calls via preload script
- Wire up SessionView.tsx stream events to log when `--log` is active
- Log all event types: text deltas, tool use updates, message completions, user prompts

### Tasks
1. Update `src/preload/index.ts` to expose logging operations:
   - `isLogMode: () => ipcRenderer.invoke('system:isLogMode')`
   - `createResponseLog: (sessionId: string) => ipcRenderer.invoke('logging:createResponseLog', sessionId)`
   - `appendResponseLog: (filePath: string, data: unknown) => ipcRenderer.invoke('logging:appendResponseLog', filePath, data)`
2. In `SessionView.tsx`, add a `useEffect` that checks `isLogMode` on mount and stores result in a ref
3. When connecting to an OpenCode session (around line 368), if log mode is active:
   - Call `createResponseLog(sessionId)` and store the returned file path in a ref
4. In the stream event handler (around line 280), when log mode is active:
   - On `message.part.updated`: append `{ type: 'part_updated', event: <raw event data> }`
   - On `message.updated`: append `{ type: 'message_updated', event: <raw event data> }`
   - On `session.idle`: append `{ type: 'session_idle' }`
5. In the `handleSend` function (around line 490), when log mode is active:
   - Append `{ type: 'user_prompt', content: <trimmed message>, mode: <current mode> }`
6. Wrap all logging calls in try/catch to prevent logging failures from breaking the UI

### Key Files
- `src/preload/index.ts` — expose logging IPC
- `src/renderer/src/components/sessions/SessionView.tsx` — wire up logging in stream handlers

### Definition of Done
- [ ] Preload exposes `isLogMode()`, `createResponseLog()`, `appendResponseLog()`
- [ ] SessionView checks log mode on mount
- [ ] Response log file created when connecting to OpenCode session (if `--log` active)
- [ ] Text delta events logged with `type: "part_updated"`
- [ ] Tool use events logged with `type: "part_updated"`
- [ ] Message completion events logged with `type: "message_updated"`
- [ ] Session idle events logged with `type: "session_idle"`
- [ ] User prompts logged with `type: "user_prompt"` including mode
- [ ] Logging failures don't break the UI (wrapped in try/catch)
- [ ] Log file is valid JSONL and inspectable with `cat` or `jq`

### Testing Criteria
```typescript
// test/phase-3/session-5/preload-ipc-logging.test.ts
describe('Session 5: Response Logging — Renderer Integration', () => {
  test('Preload exposes isLogMode', async () => {
    // Verify window.system.isLogMode exists and returns boolean
  });

  test('Preload exposes createResponseLog', async () => {
    // Verify window.logging.createResponseLog exists
  });

  test('Preload exposes appendResponseLog', async () => {
    // Verify window.logging.appendResponseLog exists
  });

  test('Log file created on session connect when --log active', async () => {
    // Enable log mode, connect session
    // Verify createResponseLog called with session ID
  });

  test('Text delta events are logged', async () => {
    // Enable log mode, receive text delta
    // Verify appendResponseLog called with type: "part_updated"
  });

  test('Tool use events are logged', async () => {
    // Enable log mode, receive tool use event
    // Verify appendResponseLog called with type: "part_updated"
  });

  test('Message completion events are logged', async () => {
    // Enable log mode, receive message.updated
    // Verify appendResponseLog called with type: "message_updated"
  });

  test('User prompts are logged', async () => {
    // Enable log mode, send a prompt
    // Verify appendResponseLog called with type: "user_prompt" and content
  });

  test('Logging failure does not break UI', async () => {
    // Mock appendResponseLog to throw
    // Send message
    // Verify no error shown to user, message still sends
  });

  test('No logging when --log not active', async () => {
    // Disable log mode
    // Send message, receive response
    // Verify appendResponseLog never called
  });
});
```

---

## Session 6: Integration Polish & Verification

### Objectives
- End-to-end verification of all Phase 3 features working together
- Fix any visual inconsistencies across themes (dark/light)
- Ensure performance targets are met
- Verify accessibility attributes are intact

### Tasks
1. Verify input area + mode toggle works in both dark and light themes
2. Verify markdown rendering works with streaming messages (partial markdown that completes)
3. Verify tool cards render correctly between markdown sections during streaming
4. Verify mode toggle inside input area doesn't interfere with textarea focus
5. Test with a real OpenCode session: send a message that triggers tool calls and markdown response
6. Verify `--log` produces a complete, parseable JSONL file after a full conversation
7. Check that all `data-testid` attributes are preserved for existing tests
8. Verify no console errors or warnings during normal operation
9. Profile markdown rendering performance — ensure < 50ms for typical messages
10. Profile mode toggle — ensure < 100ms visual feedback
11. Verify keyboard navigation still works: Tab into textarea, Shift+Tab toggles mode, Enter sends
12. Check accessibility: aria-labels on mode toggle, input area, send button

### Key Files
- All files modified in sessions 1-5
- Focus on cross-cutting concerns and integration points

### Definition of Done
- [ ] Input area looks correct in dark theme
- [ ] Input area looks correct in light theme
- [ ] Streaming markdown renders progressively (no flicker)
- [ ] Tool cards render between markdown during streaming
- [ ] Mode toggle doesn't steal focus from textarea
- [ ] Full conversation logged to JSONL with all event types
- [ ] No console errors during normal operation
- [ ] Markdown renders < 50ms
- [ ] Mode toggle responds < 100ms
- [ ] All existing data-testid attributes preserved
- [ ] Aria-labels present on input area, mode toggle, send button
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes

### Testing Criteria
```typescript
// test/phase-3/session-6/integration-polish.test.ts
describe('Session 6: Integration Polish', () => {
  test('Input area renders correctly in dark theme', async () => {
    // Set dark theme
    // Verify input container visible with correct border colors
  });

  test('Input area renders correctly in light theme', async () => {
    // Set light theme
    // Verify input container visible with correct border colors
  });

  test('Streaming markdown renders progressively', async () => {
    // Simulate streaming "# Hello\n\nThis is **bold**"
    // Verify heading appears first, then paragraph
    // No flicker or re-render artifacts
  });

  test('Tool cards render between markdown during streaming', async () => {
    // Simulate: text → tool_use → text
    // Verify: MarkdownRenderer → ToolCard → MarkdownRenderer in order
  });

  test('Mode toggle does not steal textarea focus', async () => {
    // Focus textarea
    // Click mode toggle
    // Verify textarea retains focus (or is re-focused)
  });

  test('Full conversation produces valid JSONL log', async () => {
    // Enable --log, conduct full conversation
    // Read log file
    // Verify all lines are valid JSON
    // Verify types: session_start, user_prompt, part_updated, message_updated, session_idle
  });

  test('No console errors during normal operation', async () => {
    // Capture console.error calls
    // Conduct normal workflow
    // Verify zero console errors
  });

  test('Markdown renders under 50ms', async () => {
    // Render 500-word markdown message with code blocks
    // Time the render
    // Assert < 50ms
  });

  test('All existing data-testid attributes preserved', async () => {
    // Query for key testids: input-area, message-input, send-button, mode-toggle
    // Verify all exist
  });

  test('Accessibility: aria-labels present', async () => {
    // Verify aria-label on: input-area, message-input, send-button, mode-toggle
  });

  test('Lint passes', async () => {
    // Run pnpm lint
    // Verify exit code 0
  });

  test('Typecheck passes', async () => {
    // Run pnpm typecheck
    // Verify exit code 0
  });
});
```

---

## Dependencies & Order

```
Session 1 (Input Area + Mode Toggle)
    |
    v
Session 2 (Markdown Rendering)
    |
    v
Session 3 (Tool Card Polish)
    |
    +---------------------------+
    |                           |
    v                           v
Session 4 (Logging: Main)   (can run in parallel with Session 4)
    |
    v
Session 5 (Logging: Renderer)
    |
    +---------------------------+
                |
                v
        Session 6 (Integration Polish)
```

### Parallel Tracks
- **Track A** (UI Polish): Sessions 1 → 2 → 3
- **Track B** (Response Logging): Sessions 4 → 5

Track A Session 1 must complete first (input area is the foundation).
Sessions 2 and 3 depend on Session 1 but are independent of each other.
Sessions 4 and 5 are independent of Track A and can run in parallel.
Session 6 requires all other sessions to be complete.

---

## Notes

### Assumed Phase 2 Infrastructure
- Chat layout with UserBubble + AssistantCanvas + ToolCard + StreamingCursor
- ModeToggle component with build/plan per-session state
- Shift+Tab shortcut for mode toggle
- Session store with `modeBySession` map
- OpenCode stream event handling in SessionView
- Preload with typed IPC invoke/on pattern
- Existing CodeBlock component with copy button

### Out of Scope (Phase 3)
Per PRD Phase 3, these are NOT included:
- Merge conflict UI
- Git authentication improvements
- New sidebar panels
- Plugin system
- Onboarding flow
- Auto-updates
- Multi-window support
- Sequential tool grouping (optional stretch goal, not required)

### Performance Targets
| Operation | Target |
|-----------|--------|
| Markdown Render (typical message) | < 50ms |
| Mode Toggle Visual Feedback | < 100ms |
| Input Area Re-render (mode switch) | No visible flicker |
| Log File Write | Non-blocking, no UI impact |
| Tool Card Expand/Collapse | Smooth < 150ms |
