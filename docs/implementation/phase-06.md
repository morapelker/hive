# Hive Phase 6 Implementation Plan

This document outlines the implementation plan for Hive Phase 6, focusing on enhanced message rendering, context awareness, notifications, queued messages, image attachments, slash commands, UX improvements, and session state persistence.

---

## Overview

The implementation is divided into **10 focused sessions**, each with:
- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 6 builds upon Phase 5** — all Phase 5 infrastructure (script runner, worktree status store, default worktree, streaming bug fixes, xterm terminal tabs) is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 6)
```
test/
├── phase-6/
│   ├── session-1/
│   │   └── tab-persistence-badges.test.ts
│   ├── session-2/
│   │   └── queued-messages-plus-button.test.ts
│   ├── session-3/
│   │   └── context-indicator.test.ts
│   ├── session-4/
│   │   └── native-notifications.test.ts
│   ├── session-5/
│   │   └── prompt-parts-api.test.ts
│   ├── session-6/
│   │   └── image-attachments.test.ts
│   ├── session-7/
│   │   └── slash-commands.test.ts
│   ├── session-8/
│   │   └── rich-tool-rendering.test.ts
│   ├── session-9/
│   │   └── part-types-subagent.test.ts
│   └── session-10/
│       └── integration-polish.test.ts
```

### New Dependencies
```json
{
  "shiki": "latest"
}
```

Note: `shiki` is optional for syntax highlighting in tool views. All other features use existing dependencies (React, Zustand, Electron APIs, lucide-react, cmdk, sonner).

---

## Session 1: Tab Persistence & Session Tab Badges

### Objectives
- Persist the active session per worktree so switching projects/worktrees remembers the last tab
- Persist across app restarts via localStorage
- Show loading spinner and unread dot indicators on individual session tabs

### Tasks
1. In `src/renderer/src/stores/useSessionStore.ts`:
   - Add `activeSessionByWorktree: Record<string, string>` to the state interface
   - When `setActiveSession(sessionId)` is called:
     - Also store `activeSessionByWorktree[currentWorktreeId] = sessionId`
   - When `setActiveWorktree(worktreeId)` is called:
     - Look up `activeSessionByWorktree[worktreeId]`
     - If found and session still exists in `sessionsByWorktree`, set it as `activeSessionId`
   - Add Zustand `persist` middleware to the store (similar to `useLayoutStore`):
     ```typescript
     persist(
       (set, get) => ({ ... }),
       {
         name: 'hive-session-tabs',
         storage: createJSONStorage(() => localStorage),
         partialize: (state) => ({
           activeSessionByWorktree: state.activeSessionByWorktree,
         }),
       }
     )
     ```
   - On app start: the persisted `activeSessionByWorktree` is automatically restored

2. In `src/renderer/src/components/sessions/SessionTabs.tsx`:
   - Import `useWorktreeStatusStore`
   - In the `SessionTab` component, add status indicator:
     ```typescript
     function SessionTab({ sessionId, name, isActive, ... }: SessionTabProps) {
       const sessionStatus = useWorktreeStatusStore(
         (state) => state.sessionStatuses[sessionId]?.status ?? null
       )
       return (
         <div ...>
           {sessionStatus === 'working' && (
             <Loader2 className="h-3 w-3 animate-spin text-blue-500 flex-shrink-0" />
           )}
           {sessionStatus === 'unread' && (
             <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
           )}
           <span className="truncate flex-1">{name || 'Untitled'}</span>
           ...
         </div>
       )
     }
     ```
   - Add `Loader2` to the lucide-react imports

3. In `src/renderer/src/components/sessions/SessionTabs.tsx`:
   - In the worktree change effect (`useEffect` on `selectedWorktreeId`):
     - After calling `setActiveWorktree(selectedWorktreeId)`, the store now auto-restores the last active session
   - Verify the flow: switch worktree → store restores last session → UI shows correct active tab

### Key Files
- `src/renderer/src/stores/useSessionStore.ts` — add persistence + activeSessionByWorktree
- `src/renderer/src/components/sessions/SessionTabs.tsx` — add status indicators, verify restore flow

### Definition of Done
- [ ] `activeSessionByWorktree` map persisted in localStorage
- [ ] Switching worktrees restores the last active session tab
- [ ] Closing and reopening the app restores the last active session per worktree
- [ ] Session tabs show spinning Loader2 icon for `working` status
- [ ] Session tabs show blue dot for `unread` status
- [ ] Session tabs show no indicator for `null` status
- [ ] Tab badges update within 100ms of status change
- [ ] Persisted session ID that no longer exists is handled gracefully (falls back to first tab)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria
```typescript
// test/phase-6/session-1/tab-persistence-badges.test.ts
describe('Session 1: Tab Persistence & Badges', () => {
  test('activeSessionByWorktree persisted to localStorage', () => {
    // Set active session for worktree
    // Verify localStorage key 'hive-session-tabs' contains the mapping
  })

  test('Switching worktrees restores last active session', () => {
    // Set active session for worktree-A = session-1
    // Switch to worktree-B
    // Switch back to worktree-A
    // Verify activeSessionId is session-1
  })

  test('Stale session ID handled gracefully', () => {
    // Set activeSessionByWorktree['wt-1'] = 'deleted-session'
    // Switch to wt-1 (session no longer exists)
    // Verify falls back to first available session or null
  })

  test('SessionTab shows spinner for working status', () => {
    // Set session status to 'working'
    // Render SessionTab
    // Verify Loader2 icon with animate-spin present
  })

  test('SessionTab shows dot for unread status', () => {
    // Set session status to 'unread'
    // Render SessionTab
    // Verify blue dot element present
  })

  test('SessionTab shows no indicator for null status', () => {
    // Session status is null
    // Render SessionTab
    // Verify no spinner and no dot
  })

  test('Tab badge updates reactively', () => {
    // Render tab with null status
    // Set status to 'working'
    // Verify spinner appears without remount
  })

  test('Multiple tabs show independent statuses', () => {
    // Tab A: working, Tab B: unread, Tab C: null
    // Verify each shows correct indicator
  })
})
```

---

## Session 2: Queued Messages & "+" Worktree Button

### Objectives
- Allow sending follow-up messages while the agent is processing (queued via SDK)
- Show a queue indicator and change send button label during streaming
- Replace the 3-dot button on project items with a "+" button for worktree creation
- Keep the right-click context menu unchanged

### Tasks

#### Queued Messages
1. In `src/renderer/src/components/sessions/SessionView.tsx`:
   - Remove `disabled={isSending}` from the textarea element
   - Remove `disabled={!inputValue.trim() || isSending}` from the send button — change to `disabled={!inputValue.trim()}`
   - In `handleSend`:
     - If `isStreaming` is true (agent is busy):
       - Still save user message to DB and display it
       - Still call `window.opencodeOps.prompt()` — the SDK `promptAsync()` handles queuing
       - Increment a `queuedCount` state variable
       - Don't set `isSending = true` again (already sending)
     - If `isStreaming` is false (agent is idle):
       - Proceed as before (save message, send to OpenCode, set `isSending = true`)
   - Add `queuedCount` state: `const [queuedCount, setQueuedCount] = useState(0)`
   - Reset `queuedCount` to 0 on `session.idle` event
   - Change the send button appearance when `isStreaming`:
     - Show `ListPlus` icon (from lucide) instead of `Send` icon
     - Tooltip: "Queue message"
   - The textarea should remain enabled during streaming so user can type

2. Create `src/renderer/src/components/sessions/QueuedIndicator.tsx`:
   - Small badge below the input area showing "N queued" when `queuedCount > 0`
   - Simple text: `"1 message queued"` or `"2 messages queued"`
   - Fades out when count reaches 0
   ```typescript
   interface QueuedIndicatorProps {
     count: number
   }
   export function QueuedIndicator({ count }: QueuedIndicatorProps) {
     if (count === 0) return null
     return (
       <div className="text-xs text-muted-foreground px-3 py-1">
         {count} message{count > 1 ? 's' : ''} queued
       </div>
     )
   }
   ```

3. In `SessionView.tsx`, render `QueuedIndicator` inside the input area (above or below the textarea)

#### "+" Worktree Button
4. In `src/renderer/src/components/projects/ProjectItem.tsx`:
   - Replace the `MoreHorizontal` button (visible on hover) with a `Plus` button:
     ```typescript
     <Button
       variant="ghost"
       size="icon"
       className={cn(
         'h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity',
         'hover:bg-accent'
       )}
       onClick={handleCreateWorktree}
       disabled={isCreatingWorktree}
     >
       {isCreatingWorktree ? (
         <Loader2 className="h-3.5 w-3.5 animate-spin" />
       ) : (
         <Plus className="h-3.5 w-3.5" />
       )}
     </Button>
     ```
   - Add `handleCreateWorktree` function:
     - Import `useWorktreeStore` → `createWorktree`
     - Call `createWorktree(project.id, project.path, project.name)`
     - Show toast on success/failure
   - Add `isCreatingWorktree` state to track creation in progress
   - Keep the entire `<ContextMenu>` wrapper and `<ContextMenuContent>` unchanged (right-click still works)
   - Remove the `MoreHorizontal` icon import if no longer used elsewhere

5. In `src/renderer/src/components/worktrees/WorktreeList.tsx`:
   - Remove the "New Worktree" button section (the `<div className="pl-4 py-1">` with Plus button)
   - Worktree list now only renders worktree items, no creation button

### Key Files
- `src/renderer/src/components/sessions/SessionView.tsx` — remove isSending guards, add queue tracking
- `src/renderer/src/components/sessions/QueuedIndicator.tsx` — **NEW**
- `src/renderer/src/components/projects/ProjectItem.tsx` — replace 3-dot with "+"
- `src/renderer/src/components/worktrees/WorktreeList.tsx` — remove "New Worktree" button

### Definition of Done
- [ ] Textarea is enabled while agent is streaming
- [ ] Send button is enabled while agent is streaming (only disabled if input is empty)
- [ ] Follow-up messages saved to DB and displayed immediately while streaming
- [ ] Follow-up messages sent to OpenCode via `promptAsync()` (SDK queues them)
- [ ] Send button shows queue icon (`ListPlus`) while streaming
- [ ] `QueuedIndicator` shows count of queued messages during streaming
- [ ] Queue count resets to 0 on `session.idle`
- [ ] "+" button appears on hover of project items
- [ ] "+" button creates a new worktree for that project
- [ ] "+" button shows spinner while creating
- [ ] Right-click context menu on project items still works (unchanged)
- [ ] "New Worktree" button removed from WorktreeList
- [ ] `pnpm lint` passes

### Testing Criteria
```typescript
// test/phase-6/session-2/queued-messages-plus-button.test.ts
describe('Session 2: Queued Messages & Plus Button', () => {
  test('Textarea enabled during streaming', () => {
    // Set isStreaming = true
    // Verify textarea is not disabled
  })

  test('Send button enabled during streaming', () => {
    // Set isStreaming = true, inputValue = "follow-up"
    // Verify send button is not disabled
  })

  test('Send button disabled when input empty', () => {
    // inputValue = ""
    // Verify send button is disabled
  })

  test('Follow-up message saved and displayed while streaming', () => {
    // Start streaming, type follow-up message, click send
    // Verify user message appears in message list
    // Verify window.opencodeOps.prompt called
  })

  test('Send button shows queue icon during streaming', () => {
    // isStreaming = true
    // Verify ListPlus icon rendered (not Send)
  })

  test('Send button shows send icon when idle', () => {
    // isStreaming = false
    // Verify Send icon rendered (not ListPlus)
  })

  test('QueuedIndicator shows count', () => {
    // queuedCount = 2
    // Verify "2 messages queued" text rendered
  })

  test('QueuedIndicator hidden when count is 0', () => {
    // queuedCount = 0
    // Verify QueuedIndicator not rendered
  })

  test('Queue count resets on session.idle', () => {
    // Queue 2 messages while streaming
    // Simulate session.idle event
    // Verify queuedCount is 0
  })

  test('Plus button on project item creates worktree', () => {
    // Render ProjectItem
    // Click "+" button
    // Verify createWorktree called with correct projectId, path, name
  })

  test('Plus button shows spinner while creating', () => {
    // Click "+" button
    // Verify Loader2 spin icon shown during creation
  })

  test('Right-click context menu still works', () => {
    // Right-click on project item
    // Verify context menu appears with all options
  })

  test('3-dot button no longer shown', () => {
    // Render ProjectItem, hover
    // Verify MoreHorizontal icon is NOT present
  })

  test('WorktreeList has no New Worktree button', () => {
    // Render WorktreeList
    // Verify no "New Worktree" button exists
  })
})
```

---

## Session 3: Context Indicator

### Objectives
- Track cumulative token usage per session from `message.updated` events
- Fetch the selected model's context window limit
- Display a color-coded progress bar with hover tooltip showing token breakdown

### Tasks
1. Create `src/renderer/src/stores/useContextStore.ts`:
   ```typescript
   interface TokenInfo {
     input: number
     output: number
     reasoning: number
     cacheRead: number
     cacheWrite: number
   }

   interface ContextState {
     // Per-session cumulative tokens
     tokensBySession: Record<string, TokenInfo>
     // Model context limits (modelId -> contextLimit)
     modelLimits: Record<string, number>
     // Actions
     addMessageTokens: (sessionId: string, tokens: TokenInfo) => void
     resetSessionTokens: (sessionId: string) => void
     setModelLimit: (modelId: string, limit: number) => void
     // Derived
     getContextUsage: (sessionId: string, modelId: string) => { used: number; limit: number; percent: number }
   }
   ```
   - `addMessageTokens`: adds tokens from a new assistant message to the session's running total
   - `getContextUsage`: calculates `used = input + output + reasoning` (total tokens that occupy context), returns percentage
   - Store is in-memory only (no persistence needed — rebuilt from events)

2. In `src/main/ipc/opencode-handlers.ts`:
   - Add `opencode:modelInfo` handler:
     ```typescript
     ipcMain.handle('opencode:modelInfo', async (_, { worktreePath, modelId }) => {
       const instance = opencodeService.getInstance(worktreePath)
       if (!instance) return { success: false, error: 'No instance' }
       // Get models list, find the model
       const result = await instance.client.app.models({ query: { directory: worktreePath } })
       const model = result.data?.find(m => m.id === modelId)
       if (!model) return { success: false, error: 'Model not found' }
       return { success: true, model: { id: model.id, name: model.name, limit: model.limit } }
     })
     ```

3. In `src/preload/index.ts`:
   - Add `modelInfo` to `window.opencodeOps`:
     ```typescript
     modelInfo: (worktreePath: string, modelId: string) =>
       ipcRenderer.invoke('opencode:modelInfo', { worktreePath, modelId })
     ```

4. In `src/preload/index.d.ts`:
   - Add type for `modelInfo` response

5. In `src/renderer/src/components/sessions/SessionView.tsx`:
   - In the `message.updated` event handler (where `role === 'assistant'` and `time.completed`):
     - Extract `info.tokens` from the event data
     - Call `useContextStore.getState().addMessageTokens(sessionId, { input, output, reasoning, cacheRead, cacheWrite })`
   - On session connect:
     - Fetch model info via `window.opencodeOps.modelInfo(worktreePath, currentModelId)`
     - Store the context limit: `useContextStore.getState().setModelLimit(modelId, limit.context)`
   - Also: when loading existing messages from DB on reconnect:
     - For each assistant message that has `opencode_message_json`, extract tokens and accumulate

6. Create `src/renderer/src/components/sessions/ContextIndicator.tsx`:
   ```typescript
   interface ContextIndicatorProps {
     sessionId: string
     modelId: string
   }
   ```
   - Subscribe to `useContextStore` for `getContextUsage(sessionId, modelId)`
   - Render a thin progress bar (h-1.5 rounded-full):
     - Background: `bg-muted`
     - Fill: color-coded by percentage:
       - 0-60%: `bg-green-500`
       - 60-80%: `bg-yellow-500`
       - 80-90%: `bg-orange-500`
       - 90-100%: `bg-red-500`
     - Width: percentage of parent
   - Wrap in a `Tooltip` (from shadcn/ui) that shows on hover:
     ```
     Context Usage
     124,800 / 200,000 tokens (62%)
     ────────────────────────
     Input: 98,200
     Output: 18,400
     Reasoning: 6,200
     Cache read: 1,500
     Cache write: 500
     ```
   - Width: ~120px, positioned between model selector and send button

7. In `SessionView.tsx`, render `<ContextIndicator>` in the input area's bottom row:
   - Between the `<ModelSelector />` and the hint text

### Key Files
- `src/renderer/src/stores/useContextStore.ts` — **NEW**
- `src/renderer/src/components/sessions/ContextIndicator.tsx` — **NEW**
- `src/renderer/src/components/sessions/SessionView.tsx` — extract tokens, fetch model, render indicator
- `src/main/ipc/opencode-handlers.ts` — add `opencode:modelInfo`
- `src/preload/index.ts` — expose `modelInfo`
- `src/preload/index.d.ts` — type for modelInfo

### Definition of Done
- [ ] `useContextStore` tracks cumulative tokens per session
- [ ] `addMessageTokens` correctly accumulates input, output, reasoning, cache tokens
- [ ] `getContextUsage` returns correct percentage based on model limit
- [ ] `opencode:modelInfo` IPC handler returns model name and context limit
- [ ] Context indicator renders as a thin progress bar in the input area
- [ ] Progress bar color changes based on usage percentage (green → yellow → orange → red)
- [ ] Hover tooltip shows full token breakdown with formatted numbers
- [ ] Context usage updates after each `message.updated` event
- [ ] Context usage reconstructed from DB messages on session reconnect
- [ ] Progress bar width is ~120px, positioned correctly in layout
- [ ] Model limit fetched on session connect
- [ ] `pnpm lint` passes

### Testing Criteria
```typescript
// test/phase-6/session-3/context-indicator.test.ts
describe('Session 3: Context Indicator', () => {
  test('addMessageTokens accumulates correctly', () => {
    // Add tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 10, cacheWrite: 5 }
    // Add more: { input: 200, output: 100, reasoning: 50, cacheRead: 20, cacheWrite: 10 }
    // Verify totals: input=300, output=150, reasoning=50, cacheRead=30, cacheWrite=15
  })

  test('getContextUsage returns correct percentage', () => {
    // Set model limit to 200000
    // Add tokens totaling 100000 (input + output + reasoning)
    // Verify percent = 50
  })

  test('resetSessionTokens clears session data', () => {
    // Add tokens, reset, verify all zeros
  })

  test('Progress bar renders with correct color', () => {
    // 30% → verify bg-green-500
    // 70% → verify bg-yellow-500
    // 85% → verify bg-orange-500
    // 95% → verify bg-red-500
  })

  test('Tooltip shows token breakdown', () => {
    // Hover over indicator
    // Verify tooltip contains "Input:", "Output:", "Reasoning:", "Cache read:", "Cache write:"
  })

  test('Tooltip shows formatted numbers', () => {
    // Tokens = 124800 / 200000
    // Verify "124,800 / 200,000 tokens" in tooltip
  })

  test('Indicator positioned in input area', () => {
    // Render SessionView
    // Verify ContextIndicator between ModelSelector and send button
  })

  test('Model limit fetched on session connect', () => {
    // Connect to session
    // Verify window.opencodeOps.modelInfo called
    // Verify setModelLimit called with result
  })

  test('Tokens extracted from message.updated events', () => {
    // Simulate message.updated event with tokens
    // Verify addMessageTokens called with correct values
  })

  test('Tokens reconstructed from DB on reconnect', () => {
    // Load session with existing messages containing opencode_message_json
    // Verify token totals match sum of all assistant message tokens
  })
})
```

---

## Session 4: Native Notifications

### Objectives
- Track app window focus state in the main process
- Show native OS notifications when a session completes while unfocused
- Navigate to the completed session on notification click

### Tasks
1. In `src/main/index.ts`:
   - Add focus tracking on the main window:
     ```typescript
     let isWindowFocused = true
     mainWindow.on('focus', () => { isWindowFocused = true })
     mainWindow.on('blur', () => { isWindowFocused = false })
     ```
   - Export a getter: `export function getWindowFocused(): boolean { return isWindowFocused }`
   - Or: store on a shared state object accessible by services

2. Create `src/main/services/notification-service.ts`:
   ```typescript
   import { Notification, BrowserWindow } from 'electron'

   interface SessionNotificationData {
     projectName: string
     sessionName: string
     projectId: string
     worktreeId: string
     sessionId: string
   }

   export class NotificationService {
     private mainWindow: BrowserWindow | null = null

     setMainWindow(window: BrowserWindow) {
       this.mainWindow = window
     }

     showSessionComplete(data: SessionNotificationData) {
       const notification = new Notification({
         title: data.projectName,
         body: `"${data.sessionName}" completed`,
         silent: false,
       })
       notification.on('click', () => {
         if (this.mainWindow) {
           this.mainWindow.show()
           this.mainWindow.focus()
           this.mainWindow.webContents.send('notification:navigate', {
             projectId: data.projectId,
             worktreeId: data.worktreeId,
             sessionId: data.sessionId,
           })
         }
       })
       notification.show()
     }
   }
   ```

3. In `src/main/services/opencode-service.ts`:
   - Import `NotificationService` and the focus state getter
   - On `session.idle` event (in the event handler, after forwarding to renderer):
     - Check if window is focused
     - If NOT focused:
       - Look up the session's project name and session name from the database
       - Call `notificationService.showSessionComplete(data)`
   - Wire up the `NotificationService` with the `mainWindow` reference

4. In `src/preload/index.ts`:
   - Add `onNotificationNavigate` to `window.systemOps`:
     ```typescript
     onNotificationNavigate: (callback: (data: { projectId: string; worktreeId: string; sessionId: string }) => void) => {
       ipcRenderer.on('notification:navigate', (_, data) => callback(data))
     }
     ```

5. In `src/preload/index.d.ts`:
   - Add type for `onNotificationNavigate`

6. Create `src/renderer/src/hooks/useNotificationNavigation.ts`:
   ```typescript
   export function useNotificationNavigation() {
     useEffect(() => {
       window.systemOps.onNotificationNavigate((data) => {
         // Navigate to project
         useProjectStore.getState().setSelectedProject(data.projectId)
         // Navigate to worktree
         useWorktreeStore.getState().setSelectedWorktree(data.worktreeId)
         // Navigate to session
         useSessionStore.getState().setActiveSession(data.sessionId)
       })
     }, [])
   }
   ```

7. In `src/renderer/src/components/layout/AppLayout.tsx`:
   - Import and call `useNotificationNavigation()` in the component body

### Key Files
- `src/main/index.ts` — focus tracking
- `src/main/services/notification-service.ts` — **NEW**
- `src/main/services/opencode-service.ts` — trigger notification on session.idle when unfocused
- `src/preload/index.ts` — expose onNotificationNavigate
- `src/preload/index.d.ts` — types
- `src/renderer/src/hooks/useNotificationNavigation.ts` — **NEW**
- `src/renderer/src/components/layout/AppLayout.tsx` — mount hook

### Definition of Done
- [ ] Main process tracks window focus state (`isWindowFocused`)
- [ ] Native notification shown when session completes while app is unfocused
- [ ] Notification title is project name
- [ ] Notification body includes session name
- [ ] Clicking notification brings app to foreground
- [ ] Clicking notification navigates to the correct project → worktree → session
- [ ] No notification shown when app is focused
- [ ] Notification works on macOS (Electron `Notification` API)
- [ ] Navigation hook handles missing project/worktree/session gracefully
- [ ] `pnpm lint` passes

### Testing Criteria
```typescript
// test/phase-6/session-4/native-notifications.test.ts
describe('Session 4: Native Notifications', () => {
  test('Window focus state tracked', () => {
    // Simulate blur event
    // Verify isWindowFocused = false
    // Simulate focus event
    // Verify isWindowFocused = true
  })

  test('Notification shown when unfocused and session completes', () => {
    // Set window unfocused
    // Simulate session.idle event
    // Verify Notification constructor called with correct title/body
  })

  test('No notification when focused', () => {
    // Set window focused
    // Simulate session.idle event
    // Verify Notification constructor NOT called
  })

  test('Notification title is project name', () => {
    // Session belongs to project "my-project"
    // Verify notification.title = "my-project"
  })

  test('Notification body includes session name', () => {
    // Session name is "implement auth"
    // Verify notification.body contains "implement auth"
  })

  test('Notification click shows and focuses window', () => {
    // Click notification
    // Verify mainWindow.show() called
    // Verify mainWindow.focus() called
  })

  test('Notification click sends navigate event', () => {
    // Click notification
    // Verify webContents.send('notification:navigate', { projectId, worktreeId, sessionId })
  })

  test('Navigation hook sets correct project/worktree/session', () => {
    // Simulate notification:navigate event
    // Verify setSelectedProject, setSelectedWorktree, setActiveSession called
  })

  test('Navigation handles missing session gracefully', () => {
    // Simulate navigate to non-existent session
    // Verify no crash, graceful fallback
  })
})
```

---

## Session 5: Prompt API Update for Parts

### Objectives
- Update the OpenCode prompt pipeline to accept an array of parts (text + files) instead of just a string message
- This is a prerequisite for image attachments (Session 6) and a structural improvement

### Tasks
1. In `src/main/services/opencode-service.ts`:
   - Update `prompt()` method signature:
     ```typescript
     async prompt(
       worktreePath: string,
       opencodeSessionId: string,
       parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }>
     ): Promise<void>
     ```
   - Update the `promptAsync` call body:
     ```typescript
     body: {
       model,
       parts  // Pass the parts array directly
     }
     ```
   - Keep backward compatibility: if called with a string (for existing callers), wrap it:
     ```typescript
     // Overload or runtime check
     const actualParts = typeof parts === 'string'
       ? [{ type: 'text' as const, text: parts }]
       : parts
     ```

2. In `src/main/ipc/opencode-handlers.ts`:
   - Update `opencode:prompt` handler:
     ```typescript
     ipcMain.handle('opencode:prompt', async (_, { worktreePath, sessionId, parts }) => {
       await opencodeService.prompt(worktreePath, sessionId, parts)
       return { success: true }
     })
     ```
   - Keep backward compatibility for `message` field:
     ```typescript
     const actualParts = parts || [{ type: 'text', text: message }]
     ```

3. In `src/preload/index.ts`:
   - Update `prompt` on `window.opencodeOps`:
     ```typescript
     prompt: (worktreePath: string, sessionId: string, parts: MessagePart[]) =>
       ipcRenderer.invoke('opencode:prompt', { worktreePath, sessionId, parts })
     ```
   - Keep backward compat overload that accepts a string `message`:
     ```typescript
     prompt: (worktreePath: string, sessionId: string, messageOrParts: string | MessagePart[]) =>
       ipcRenderer.invoke('opencode:prompt', {
         worktreePath,
         sessionId,
         parts: typeof messageOrParts === 'string'
           ? [{ type: 'text', text: messageOrParts }]
           : messageOrParts,
       })
     ```

4. In `src/preload/index.d.ts`:
   - Add `MessagePart` type:
     ```typescript
     type MessagePart =
       | { type: 'text'; text: string }
       | { type: 'file'; mime: string; url: string; filename?: string }
     ```
   - Update `prompt` signature

5. In `src/renderer/src/components/sessions/SessionView.tsx`:
   - Update `handleSend` to use the new parts-based prompt:
     ```typescript
     const parts: MessagePart[] = [{ type: 'text', text: promptMessage }]
     const result = await window.opencodeOps.prompt(worktreePath, opencodeSessionId, parts)
     ```
   - This is a structural change; image parts will be added in Session 6

### Key Files
- `src/main/services/opencode-service.ts` — update prompt() signature
- `src/main/ipc/opencode-handlers.ts` — update handler
- `src/preload/index.ts` — update preload bridge
- `src/preload/index.d.ts` — add MessagePart type
- `src/renderer/src/components/sessions/SessionView.tsx` — use parts in handleSend

### Definition of Done
- [ ] `opencode-service.ts` `prompt()` accepts `parts` array
- [ ] `opencode:prompt` IPC handler accepts `parts` parameter
- [ ] Preload bridge passes `parts` through to main process
- [ ] `MessagePart` type declared in `index.d.ts`
- [ ] `SessionView.handleSend()` sends text as `parts: [{ type: 'text', text }]`
- [ ] Backward compatible — existing string message still works via conversion
- [ ] Existing send flow works identically (no regression)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria
```typescript
// test/phase-6/session-5/prompt-parts-api.test.ts
describe('Session 5: Prompt Parts API', () => {
  test('prompt() accepts parts array', () => {
    // Call prompt with parts: [{ type: 'text', text: 'hello' }]
    // Verify promptAsync called with correct body.parts
  })

  test('prompt() accepts string for backward compat', () => {
    // Call prompt with string 'hello'
    // Verify converted to [{ type: 'text', text: 'hello' }]
  })

  test('IPC handler passes parts to service', () => {
    // Invoke opencode:prompt with parts array
    // Verify service.prompt called with same parts
  })

  test('File part included in prompt', () => {
    // Send parts: [{ type: 'text', text: 'look at this' }, { type: 'file', mime: 'image/png', url: 'data:...' }]
    // Verify promptAsync body.parts includes both
  })

  test('SessionView sends text as parts array', () => {
    // Type message, click send
    // Verify prompt called with parts: [{ type: 'text', text: '...' }]
  })

  test('MessagePart type declared', () => {
    // TypeScript compilation check — parts parameter accepts MessagePart[]
  })

  test('Existing send flow works (no regression)', () => {
    // Send a plain text message
    // Verify message saved to DB, displayed, sent to OpenCode
    // Verify response received normally
  })
})
```

---

## Session 6: Image & File Attachments UI

### Objectives
- Add attachment button (📎) for selecting files via dialog
- Add clipboard paste handler for images
- Show attachment previews with remove buttons
- Include attachments as file parts when sending messages

### Tasks
1. Create `src/renderer/src/components/sessions/AttachmentButton.tsx`:
   ```typescript
   interface AttachmentButtonProps {
     onAttach: (file: { name: string; mime: string; dataUrl: string }) => void
     disabled?: boolean
   }
   ```
   - Render a `Paperclip` icon button (from lucide)
   - On click, open a hidden `<input type="file" accept="image/*,.pdf" multiple />`
   - On file selected:
     - Read file via `FileReader.readAsDataURL()`
     - Call `onAttach({ name: file.name, mime: file.type, dataUrl: result })`
   - Button tooltip: "Attach image or file"

2. Create `src/renderer/src/components/sessions/AttachmentPreview.tsx`:
   ```typescript
   interface Attachment {
     id: string
     name: string
     mime: string
     dataUrl: string
   }

   interface AttachmentPreviewProps {
     attachments: Attachment[]
     onRemove: (id: string) => void
   }
   ```
   - Render a horizontal row of thumbnail cards above the textarea
   - Each card:
     - For images: show a small thumbnail (h-16 w-16 object-cover rounded)
     - For non-images (PDF): show a file icon with filename
     - "✕" button in top-right corner to remove
   - Scroll horizontally if many attachments

3. In `src/renderer/src/components/sessions/SessionView.tsx`:
   - Add attachment state:
     ```typescript
     const [attachments, setAttachments] = useState<Attachment[]>([])
     ```
   - Add `handleAttach` callback:
     ```typescript
     const handleAttach = (file: { name: string; mime: string; dataUrl: string }) => {
       setAttachments(prev => [...prev, { id: crypto.randomUUID(), ...file }])
     }
     ```
   - Add `handleRemoveAttachment`:
     ```typescript
     const handleRemoveAttachment = (id: string) => {
       setAttachments(prev => prev.filter(a => a.id !== id))
     }
     ```
   - Add clipboard paste handler on the textarea:
     ```typescript
     const handlePaste = (e: React.ClipboardEvent) => {
       const items = e.clipboardData?.items
       if (!items) return
       for (const item of Array.from(items)) {
         if (item.type.startsWith('image/')) {
           e.preventDefault()
           const file = item.getAsFile()
           if (!file) continue
           const reader = new FileReader()
           reader.onload = () => {
             handleAttach({
               name: file.name || 'pasted-image.png',
               mime: file.type,
               dataUrl: reader.result as string,
             })
           }
           reader.readAsDataURL(file)
         }
       }
     }
     ```
   - Add `onPaste={handlePaste}` to the textarea
   - In `handleSend`:
     - Build parts array including attachments:
       ```typescript
       const parts: MessagePart[] = [
         ...attachments.map(a => ({ type: 'file' as const, mime: a.mime, url: a.dataUrl, filename: a.name })),
         { type: 'text' as const, text: promptMessage },
       ]
       ```
     - Clear attachments after sending: `setAttachments([])`
   - Render `AttachmentPreview` above the textarea if `attachments.length > 0`
   - Render `AttachmentButton` in the bottom row next to the model selector

### Key Files
- `src/renderer/src/components/sessions/AttachmentButton.tsx` — **NEW**
- `src/renderer/src/components/sessions/AttachmentPreview.tsx` — **NEW**
- `src/renderer/src/components/sessions/SessionView.tsx` — attachment state, paste handler, send with parts

### Definition of Done
- [ ] 📎 button renders in input area next to model selector
- [ ] Clicking 📎 opens native file picker (images + PDF)
- [ ] Selected files appear as thumbnail previews above textarea
- [ ] Pasting an image from clipboard adds it as an attachment
- [ ] Each attachment has a remove (✕) button
- [ ] Clicking ✕ removes the attachment
- [ ] Attachments sent as `FilePartInput` parts alongside text
- [ ] Attachments cleared after sending
- [ ] Multiple attachments supported
- [ ] Image thumbnails show actual preview (from dataUrl)
- [ ] Non-image files show file icon with name
- [ ] Paste handler doesn't interfere with normal text paste
- [ ] `pnpm lint` passes

### Testing Criteria
```typescript
// test/phase-6/session-6/image-attachments.test.ts
describe('Session 6: Image Attachments', () => {
  test('Attachment button renders in input area', () => {
    // Render SessionView
    // Verify Paperclip icon button present
  })

  test('File picker opens on button click', () => {
    // Click attachment button
    // Verify file input click triggered
  })

  test('Selected file appears as thumbnail', () => {
    // Simulate file selection with image/png
    // Verify AttachmentPreview shows thumbnail
  })

  test('Pasted image adds attachment', () => {
    // Simulate paste event with image/png clipboard data
    // Verify attachment added to state
    // Verify thumbnail preview shown
  })

  test('Normal text paste still works', () => {
    // Simulate paste event with text data (no images)
    // Verify text inserted into textarea as normal
    // Verify no attachment created
  })

  test('Remove button removes attachment', () => {
    // Add 2 attachments
    // Click remove on first
    // Verify only second attachment remains
  })

  test('Attachments included in message parts on send', () => {
    // Add image attachment + type text
    // Click send
    // Verify prompt called with parts: [{ type: 'file', ... }, { type: 'text', ... }]
  })

  test('Attachments cleared after send', () => {
    // Add attachment, send
    // Verify attachments state is empty
  })

  test('Multiple attachments displayed in row', () => {
    // Add 3 attachments
    // Verify all 3 thumbnails rendered
  })

  test('PDF attachment shows file icon', () => {
    // Add PDF file
    // Verify file icon rendered (not image thumbnail)
  })

  test('AttachmentPreview hidden when no attachments', () => {
    // No attachments
    // Verify AttachmentPreview not rendered
  })
})
```

---

## Session 7: Slash Commands

### Objectives
- Fetch available slash commands from the OpenCode SDK
- Show a popover when "/" is typed as the first character
- Filter commands with substring matching as user types
- Select a command to send it

### Tasks
1. In `src/main/services/opencode-service.ts`:
   - Add `listCommands` method:
     ```typescript
     async listCommands(worktreePath: string): Promise<Array<{ name: string; description?: string; template: string }>> {
       if (!this.instance) return []
       const result = await this.instance.client.command.list({
         query: { directory: worktreePath }
       })
       return result.data || []
     }
     ```

2. In `src/main/ipc/opencode-handlers.ts`:
   - Add `opencode:commands` handler:
     ```typescript
     ipcMain.handle('opencode:commands', async (_, { worktreePath }) => {
       const commands = await opencodeService.listCommands(worktreePath)
       return { success: true, commands }
     })
     ```

3. In `src/preload/index.ts`:
   - Add to `window.opencodeOps`:
     ```typescript
     commands: (worktreePath: string) =>
       ipcRenderer.invoke('opencode:commands', { worktreePath })
     ```

4. In `src/preload/index.d.ts`:
   - Add `Command` type and `commands` method signature

5. Create `src/renderer/src/components/sessions/SlashCommandPopover.tsx`:
   ```typescript
   interface SlashCommandPopoverProps {
     commands: Array<{ name: string; description?: string; template: string }>
     filter: string           // Current "/" filter text (e.g., "/comp")
     onSelect: (command: { name: string; template: string }) => void
     onClose: () => void
     visible: boolean
   }
   ```
   - Render a positioned popover above the input area
   - Filter commands: `commands.filter(c => c.name.includes(filter.replace('/', '')))`
   - Substring match (not prefix): `/super` matches `/using-superpowers`
   - Keyboard navigation:
     - Arrow Up/Down to navigate items
     - Enter to select highlighted item
     - Escape to close
   - Each item shows: `/command-name` and optional description
   - Limit display to 8 items max
   - Style: similar to command palette (cmdk)

6. In `src/renderer/src/components/sessions/SessionView.tsx`:
   - Add state:
     ```typescript
     const [commands, setCommands] = useState<Command[]>([])
     const [showSlashCommands, setShowSlashCommands] = useState(false)
     ```
   - Fetch commands on session connect:
     ```typescript
     const cmdResult = await window.opencodeOps.commands(worktreePath)
     if (cmdResult.success) setCommands(cmdResult.commands)
     ```
   - On input change, detect "/" prefix:
     ```typescript
     const handleInputChange = (value: string) => {
       setInputValue(value)
       if (value.startsWith('/') && value.length >= 1) {
         setShowSlashCommands(true)
       } else {
         setShowSlashCommands(false)
       }
     }
     ```
   - On command select:
     ```typescript
     const handleCommandSelect = (cmd: { name: string; template: string }) => {
       setInputValue(`/${cmd.name} `)
       setShowSlashCommands(false)
       textareaRef.current?.focus()
     }
     ```
   - Handle keyboard navigation: intercept ArrowUp/ArrowDown/Enter/Escape when popover is visible
   - Render `SlashCommandPopover` above the input area (position: absolute, bottom: 100%)

### Key Files
- `src/main/services/opencode-service.ts` — add `listCommands()`
- `src/main/ipc/opencode-handlers.ts` — add `opencode:commands`
- `src/preload/index.ts` — expose `commands`
- `src/preload/index.d.ts` — types
- `src/renderer/src/components/sessions/SlashCommandPopover.tsx` — **NEW**
- `src/renderer/src/components/sessions/SessionView.tsx` — slash detection, keyboard nav, popover rendering

### Definition of Done
- [ ] `opencode:commands` IPC handler returns list of commands from SDK
- [ ] Commands fetched on session connect and cached
- [ ] Popover appears when "/" is typed as first character
- [ ] Commands filtered with substring matching (e.g., "/super" matches "using-superpowers")
- [ ] Arrow keys navigate the list
- [ ] Enter selects the highlighted command
- [ ] Escape closes the popover
- [ ] Selected command name inserted into input
- [ ] Popover disappears when input no longer starts with "/"
- [ ] Max 8 items shown at once
- [ ] Each item shows command name and description
- [ ] Popover positioned above input area
- [ ] `pnpm lint` passes

### Testing Criteria
```typescript
// test/phase-6/session-7/slash-commands.test.ts
describe('Session 7: Slash Commands', () => {
  test('Commands fetched on session connect', () => {
    // Connect session
    // Verify window.opencodeOps.commands called
    // Verify commands stored in state
  })

  test('Popover shown when "/" typed', () => {
    // Type "/"
    // Verify popover visible
  })

  test('Popover hidden when input does not start with "/"', () => {
    // Type "hello"
    // Verify popover not visible
  })

  test('Popover hidden after clearing "/"', () => {
    // Type "/", then backspace
    // Verify popover hidden
  })

  test('Commands filtered by substring', () => {
    // Commands: ["compact", "using-superpowers", "commit"]
    // Type "/super"
    // Verify "using-superpowers" shown
    // Verify "compact" NOT shown
  })

  test('Fuzzy filter: "/comp" matches "compact"', () => {
    // Type "/comp"
    // Verify "compact" shown
  })

  test('Arrow down selects next item', () => {
    // Type "/", 3 items shown
    // Press ArrowDown
    // Verify second item highlighted
  })

  test('Enter selects highlighted command', () => {
    // Navigate to "compact", press Enter
    // Verify inputValue = "/compact "
    // Verify popover closed
  })

  test('Escape closes popover', () => {
    // Popover open, press Escape
    // Verify popover closed
    // Verify input unchanged
  })

  test('Max 8 items shown', () => {
    // 15 commands available, type "/"
    // Verify max 8 rendered
  })

  test('Each item shows name and description', () => {
    // Command with name "compact" and description "Compact context"
    // Verify both rendered in popover item
  })
})
```

---

## Session 8: Rich Tool Call Rendering

### Objectives
- Create tool-specific view components for known tools (Read, Edit, Grep, Glob, Bash, Write)
- Create a TODO fallback component for unknown tools
- Refactor `ToolCard` to route to specific renderers based on tool name

### Tasks
1. Create `src/renderer/src/components/sessions/tools/ReadToolView.tsx`:
   - Extract file path from `input.file_path` or `input.path`
   - Show filename with line range if `input.offset` / `input.limit` provided
   - On success: show first 20 lines of output with line numbers
   - Expandable to show full content
   - Monospace font, light background
   ```
   📄 src/main/index.ts (lines 1-50)
   ────────────────────────
    1 │ import { app } from 'electron'
    2 │ import { join } from 'path'
    3 │ ...
   [Show all 50 lines]
   ```

2. Create `src/renderer/src/components/sessions/tools/EditToolView.tsx`:
   - Extract `input.file_path`, `input.old_string`, `input.new_string`
   - Show file path header
   - Render inline diff: red lines for old_string, green lines for new_string
   - Monospace font
   ```
   ✏️ src/App.tsx
   ────────────────────────
   - import { OldComponent } from './old'
   + import { NewComponent } from './new'
   ```

3. Create `src/renderer/src/components/sessions/tools/GrepToolView.tsx`:
   - Extract `input.pattern`, `input.path`
   - Show pattern and search path
   - Parse output for file paths and matched lines
   - Highlight matched text in output lines
   ```
   🔍 "auth" in src/ (3 matches)
   ────────────────────────
   src/auth/login.ts:15: const auth = ...
   src/auth/session.ts:8: import { auth } ...
   src/utils/helpers.ts:42: // auth helper
   ```

4. Create `src/renderer/src/components/sessions/tools/BashToolView.tsx`:
   - Extract `input.command` or `input.description`
   - Show command in terminal-styled block (dark background, monospace)
   - Show output below with basic ANSI color stripping (or rendering)
   ```
   $ pnpm test
   ────────────────────────
   PASS  test/session-1.test.ts
   Tests: 5 passed, 5 total
   Time: 2.4s
   ```

5. Create `src/renderer/src/components/sessions/tools/TodoToolView.tsx`:
   - Fallback for any tool not in the known list
   - Show tool name with "TODO" badge
   - Show raw `input` as formatted JSON
   - Show raw `output` as plain text (truncated)
   - Show a subtle "No custom renderer" note
   ```
   ❓ mcp__custom_tool ── TODO ──
   ────────────────────────
   Input:
   { "query": "SELECT * FROM users", "limit": 10 }
   Output:
   "Found 42 records matching query..."
   ⚠ No custom renderer — showing raw data
   ```

6. Refactor `src/renderer/src/components/sessions/ToolCard.tsx`:
   - Add a tool name → renderer mapping:
     ```typescript
     const TOOL_RENDERERS: Record<string, React.FC<ToolViewProps>> = {
       Read: ReadToolView,
       read_file: ReadToolView,
       Edit: EditToolView,
       edit_file: EditToolView,
       Grep: GrepToolView,
       grep: GrepToolView,
       Glob: GrepToolView,  // Similar rendering to Grep
       glob: GrepToolView,
       Bash: BashToolView,
       bash: BashToolView,
       Write: ReadToolView,  // Similar rendering to Read
       write_file: ReadToolView,
     }
     ```
   - When the tool card is expanded and has output:
     - Look up tool name in `TOOL_RENDERERS`
     - If found: render the specific view component
     - If not found: render `TodoToolView`
   - Keep existing collapsed state behavior (icon + label + status)
   - The detail view only renders on expand

7. Define a shared `ToolViewProps` interface:
   ```typescript
   interface ToolViewProps {
     name: string
     input: Record<string, unknown>
     output?: string
     error?: string
     status: ToolStatus
   }
   ```

### Key Files
- `src/renderer/src/components/sessions/tools/ReadToolView.tsx` — **NEW**
- `src/renderer/src/components/sessions/tools/EditToolView.tsx` — **NEW**
- `src/renderer/src/components/sessions/tools/GrepToolView.tsx` — **NEW**
- `src/renderer/src/components/sessions/tools/BashToolView.tsx` — **NEW**
- `src/renderer/src/components/sessions/tools/TodoToolView.tsx` — **NEW**
- `src/renderer/src/components/sessions/ToolCard.tsx` — refactor to route to renderers

### Definition of Done
- [ ] `ReadToolView` shows file path, line numbers, syntax-highlighted content preview
- [ ] `EditToolView` shows file path and inline diff (red/green)
- [ ] `GrepToolView` shows pattern, path, and highlighted match results
- [ ] `BashToolView` shows command in terminal style with output
- [ ] `TodoToolView` shows raw input/output JSON for unknown tools with "TODO" badge
- [ ] `ToolCard` routes to correct renderer based on tool name
- [ ] Unknown tools fall back to `TodoToolView` (not blank)
- [ ] All tool views expandable/collapsible
- [ ] Tool views use monospace font for code content
- [ ] Edit diff shows red (-) and green (+) lines
- [ ] Grep output highlights matched text
- [ ] Read view shows first 20 lines with "Show all" expander
- [ ] Bash view uses dark background terminal styling
- [ ] `pnpm lint` passes

### Testing Criteria
```typescript
// test/phase-6/session-8/rich-tool-rendering.test.ts
describe('Session 8: Rich Tool Rendering', () => {
  test('ReadToolView renders file path and content', () => {
    // Input: { file_path: 'src/main.ts' }, Output: "line1\nline2\n..."
    // Verify file path shown, content lines rendered
  })

  test('ReadToolView shows line numbers', () => {
    // Render with multi-line output
    // Verify line numbers (1, 2, 3...) present
  })

  test('ReadToolView truncates to 20 lines', () => {
    // Output has 50 lines
    // Verify only 20 shown initially
    // Verify "Show all" button present
  })

  test('EditToolView renders diff', () => {
    // Input: { old_string: 'foo', new_string: 'bar', file_path: 'test.ts' }
    // Verify red line with "foo", green line with "bar"
  })

  test('GrepToolView shows pattern and matches', () => {
    // Input: { pattern: 'auth' }, Output: "src/a.ts:1:auth\nsrc/b.ts:5:auth"
    // Verify pattern shown, matches listed
  })

  test('BashToolView renders terminal style', () => {
    // Input: { command: 'ls -la' }, Output: "total 42\n..."
    // Verify command shown with $ prefix, dark background
  })

  test('TodoToolView renders for unknown tool', () => {
    // Tool name: "mcp__custom"
    // Verify "TODO" badge shown
    // Verify raw input JSON displayed
    // Verify "No custom renderer" note
  })

  test('ToolCard routes Read tool correctly', () => {
    // ToolCard with name "Read", expand
    // Verify ReadToolView rendered
  })

  test('ToolCard routes Edit tool correctly', () => {
    // ToolCard with name "Edit", expand
    // Verify EditToolView rendered
  })

  test('ToolCard routes unknown tool to TodoToolView', () => {
    // ToolCard with name "SomeNewTool", expand
    // Verify TodoToolView rendered
  })

  test('Collapsed tool card unchanged', () => {
    // Render collapsed ToolCard
    // Verify same icon + label behavior as before
  })

  test('Tool views use monospace font', () => {
    // Render ReadToolView
    // Verify font-mono class on content area
  })
})
```

---

## Session 9: Extended Part Types & Subagent Rendering

### Objectives
- Handle new SDK part types: `subtask`, `step-start`, `step-finish`, `reasoning`, `compaction`
- Render SubtaskCard for subagent spawns with expandable nested message view
- Render ReasoningBlock for thinking/reasoning content
- Render CompactionPill for context compaction events

### Tasks
1. Extend `StreamingPart` type in `src/renderer/src/components/sessions/SessionView.tsx`:
   ```typescript
   export interface StreamingPart {
     type: 'text' | 'tool_use' | 'subtask' | 'step_start' | 'step_finish' | 'reasoning' | 'compaction'
     text?: string
     toolUse?: ToolUseInfo
     subtask?: {
       id: string
       sessionID: string
       prompt: string
       description: string
       agent: string
       parts: StreamingPart[]  // nested parts from child session
       status: 'running' | 'completed' | 'error'
     }
     stepStart?: { snapshot?: string }
     stepFinish?: { reason: string; cost: number; tokens: { input: number; output: number; reasoning: number } }
     reasoning?: string
     compactionAuto?: boolean
   }
   ```

2. Update `mapStoredPartsToStreamingParts()` in `SessionView.tsx`:
   - Add cases for:
     - `type === 'subtask'` → map to `{ type: 'subtask', subtask: { ... } }`
     - `type === 'step-start'` → map to `{ type: 'step_start', stepStart: { snapshot } }`
     - `type === 'step-finish'` → map to `{ type: 'step_finish', stepFinish: { reason, cost, tokens } }`
     - `type === 'reasoning'` → map to `{ type: 'reasoning', reasoning: text }`
     - `type === 'compaction'` → map to `{ type: 'compaction', compactionAuto: auto }`

3. Update the streaming event handler in `SessionView.tsx`:
   - In `message.part.updated` handler, add cases:
     ```typescript
     if (part.type === 'subtask') {
       updateStreamingPartsRef(parts => [
         ...parts,
         { type: 'subtask', subtask: { id: part.id, sessionID: part.sessionID, prompt: part.prompt, description: part.description, agent: part.agent, parts: [], status: 'running' } }
       ])
       immediateFlush()
     } else if (part.type === 'reasoning') {
       updateStreamingPartsRef(parts => {
         const last = parts[parts.length - 1]
         if (last?.type === 'reasoning') {
           return [...parts.slice(0, -1), { ...last, reasoning: (last.reasoning || '') + (event.data?.delta || part.text || '') }]
         }
         return [...parts, { type: 'reasoning', reasoning: event.data?.delta || part.text || '' }]
       })
       scheduleFlush()
     } else if (part.type === 'step-start') {
       updateStreamingPartsRef(parts => [...parts, { type: 'step_start', stepStart: { snapshot: part.snapshot } }])
       immediateFlush()
     } else if (part.type === 'step-finish') {
       updateStreamingPartsRef(parts => [...parts, { type: 'step_finish', stepFinish: { reason: part.reason, cost: part.cost, tokens: part.tokens } }])
       immediateFlush()
     } else if (part.type === 'compaction') {
       updateStreamingPartsRef(parts => [...parts, { type: 'compaction', compactionAuto: part.auto }])
       immediateFlush()
     }
     ```

4. Create `src/renderer/src/components/sessions/SubtaskCard.tsx`:
   ```typescript
   interface SubtaskCardProps {
     subtask: StreamingPart['subtask']
   }
   ```
   - Expandable card with:
     - Header: agent name icon + agent name + status indicator (spinner/check/error)
     - Collapsed: one-line description or prompt preview
     - Expanded: nested list of child parts (text + tool calls)
   - Click to toggle expand/collapse
   - Nested parts rendered recursively via AssistantCanvas-like logic
   - Border styling to visually distinguish nested level (indented, left border)

5. Create `src/renderer/src/components/sessions/ReasoningBlock.tsx`:
   ```typescript
   interface ReasoningBlockProps {
     text: string
   }
   ```
   - Collapsible block with "Thinking..." header
   - Collapsed by default, shows first line preview
   - Expanded shows full reasoning text
   - Muted styling (bg-muted/50, italic text, smaller font)
   - ChevronRight icon that rotates on expand

6. Create `src/renderer/src/components/sessions/CompactionPill.tsx`:
   ```typescript
   interface CompactionPillProps {
     auto: boolean
   }
   ```
   - Small inline pill/badge:
     - Text: "Context compacted" (or "Auto-compacted" if auto=true)
     - Styling: `bg-muted text-muted-foreground text-xs rounded-full px-2 py-0.5`
     - Icon: `Minimize2` from lucide

7. Update `src/renderer/src/components/sessions/AssistantCanvas.tsx`:
   - Add rendering for new part types in the parts loop:
     ```typescript
     if (part.type === 'subtask') {
       return <SubtaskCard key={i} subtask={part.subtask} />
     }
     if (part.type === 'reasoning') {
       return <ReasoningBlock key={i} text={part.reasoning || ''} />
     }
     if (part.type === 'compaction') {
       return <CompactionPill key={i} auto={part.compactionAuto ?? false} />
     }
     if (part.type === 'step_start' || part.type === 'step_finish') {
       return null  // Step boundaries are visual separators, optional rendering
     }
     ```

### Key Files
- `src/renderer/src/components/sessions/SessionView.tsx` — extend part types and streaming handler
- `src/renderer/src/components/sessions/AssistantCanvas.tsx` — render new part types
- `src/renderer/src/components/sessions/SubtaskCard.tsx` — **NEW**
- `src/renderer/src/components/sessions/ReasoningBlock.tsx` — **NEW**
- `src/renderer/src/components/sessions/CompactionPill.tsx` — **NEW**

### Definition of Done
- [ ] `subtask` parts rendered as expandable SubtaskCard
- [ ] SubtaskCard shows agent name, description, and status
- [ ] SubtaskCard expands to show nested parts (text + tools)
- [ ] SubtaskCard collapsed by default, expand on click
- [ ] `reasoning` parts rendered as collapsible ReasoningBlock
- [ ] ReasoningBlock shows "Thinking..." header, collapsed by default
- [ ] ReasoningBlock expands to show full reasoning text
- [ ] `compaction` parts rendered as CompactionPill
- [ ] CompactionPill shows "Context compacted" / "Auto-compacted"
- [ ] `step-start` and `step-finish` handled without crashing (may render as separators or nothing)
- [ ] `mapStoredPartsToStreamingParts` handles all new part types
- [ ] Streaming handler handles all new part types
- [ ] Parts from DB (reconnect) render correctly for new types
- [ ] No crash on unknown/unexpected part types (gracefully ignored)
- [ ] `pnpm lint` passes

### Testing Criteria
```typescript
// test/phase-6/session-9/part-types-subagent.test.ts
describe('Session 9: Part Types & Subagent', () => {
  test('subtask part renders SubtaskCard', () => {
    // Part: { type: 'subtask', prompt: 'search auth', agent: 'explore', description: 'Search patterns' }
    // Verify SubtaskCard rendered with agent name and description
  })

  test('SubtaskCard expands on click', () => {
    // Render collapsed SubtaskCard
    // Click header
    // Verify nested content area visible
  })

  test('SubtaskCard shows status indicator', () => {
    // status = 'running' → verify spinner
    // status = 'completed' → verify checkmark
  })

  test('reasoning part renders ReasoningBlock', () => {
    // Part: { type: 'reasoning', text: 'Let me think about...' }
    // Verify ReasoningBlock rendered
  })

  test('ReasoningBlock collapsed by default', () => {
    // Verify "Thinking..." header visible
    // Verify full text NOT visible
  })

  test('ReasoningBlock expands on click', () => {
    // Click header
    // Verify full text visible
  })

  test('compaction part renders CompactionPill', () => {
    // Part: { type: 'compaction', auto: true }
    // Verify "Auto-compacted" pill rendered
  })

  test('step-start and step-finish do not crash', () => {
    // Parts: [{ type: 'step-start' }, { type: 'text', text: 'hello' }, { type: 'step-finish' }]
    // Verify renders without error
    // Verify text part visible
  })

  test('mapStoredPartsToStreamingParts handles subtask', () => {
    // Raw: { type: 'subtask', prompt: '...', agent: 'explore', description: '...' }
    // Verify mapped to { type: 'subtask', subtask: { ... } }
  })

  test('mapStoredPartsToStreamingParts handles reasoning', () => {
    // Raw: { type: 'reasoning', text: 'thinking...' }
    // Verify mapped to { type: 'reasoning', reasoning: 'thinking...' }
  })

  test('mapStoredPartsToStreamingParts handles compaction', () => {
    // Raw: { type: 'compaction', auto: false }
    // Verify mapped to { type: 'compaction', compactionAuto: false }
  })

  test('Unknown part types gracefully ignored', () => {
    // Raw: { type: 'some_future_type', data: {} }
    // Verify no crash, part skipped
  })

  test('Streaming handler accumulates reasoning deltas', () => {
    // Two reasoning events: delta "Let me" then " think"
    // Verify single reasoning part with text "Let me think"
  })

  test('Reconnect loads all part types from DB', () => {
    // DB has messages with subtask, reasoning, compaction parts
    // Load messages
    // Verify all part types rendered correctly
  })
})
```

---

## Session 10: Integration & Polish

### Objectives
- End-to-end verification of all Phase 6 features working together
- Fix visual inconsistencies, edge cases, and performance issues
- Run lint and typecheck
- Verify cross-feature interactions

### Tasks
1. **Tab persistence end-to-end**:
   - Switch between 3 worktrees with different active sessions
   - Close and reopen app → verify each worktree remembers its tab
   - Delete a session that was persisted → verify fallback works

2. **Session tab badges end-to-end**:
   - Send message → verify spinner on that tab
   - Switch to different tab while streaming → verify original tab shows unread dot when done
   - Click unread tab → verify dot clears
   - Multiple tabs streaming → verify correct independent indicators

3. **Queued messages end-to-end**:
   - Send message, while streaming type a follow-up and send
   - Verify follow-up appears in chat
   - Verify queue indicator shows "1 message queued"
   - Verify agent processes both messages

4. **"+" button end-to-end**:
   - Hover project → verify "+" visible
   - Click "+" → verify worktree created
   - Right-click project → verify full context menu
   - Verify no 3-dot button anywhere

5. **Context indicator end-to-end**:
   - Send a message, wait for response
   - Verify progress bar appears with percentage
   - Hover → verify tooltip with token breakdown
   - Send multiple messages → verify percentage increases
   - Switch models → verify limit updates

6. **Notifications end-to-end**:
   - Send message, blur window (click away), wait for response
   - Verify native notification appears
   - Click notification → verify app comes to foreground and correct session active

7. **Image attachments end-to-end**:
   - Click 📎 → select an image → verify thumbnail preview
   - Paste image from clipboard → verify attachment added
   - Remove one attachment → verify gone
   - Send message with attachment → verify sent as file part
   - Verify response acknowledges the image

8. **Slash commands end-to-end**:
   - Type "/" → verify popover with commands
   - Type "/comp" → verify filtered results
   - Arrow down + Enter → verify command inserted
   - Escape → verify popover closed
   - Send command → verify processed by OpenCode

9. **Rich tool rendering end-to-end**:
   - Trigger a Read tool → verify file preview with line numbers
   - Trigger an Edit tool → verify diff view
   - Trigger a Bash tool → verify terminal-style output
   - Trigger an unknown tool → verify TODO fallback

10. **Subagent rendering end-to-end**:
    - Send a prompt that triggers a subagent spawn
    - Verify SubtaskCard appears with agent name
    - Verify nested messages stream into the card
    - Verify card shows completed status when done

11. **Cross-feature interactions**:
    - Queue a message while subagent is running → verify queued
    - Context indicator during subagent → verify tokens accumulate
    - Tab badges during subagent → verify working status
    - Notification on subagent-heavy session → verify notification correct

12. Run `pnpm lint` — fix any errors
13. Run `pnpm test` — fix any failures
14. Manual performance check against NFR targets

### Key Files
- All files modified in sessions 1-9
- Focus on cross-cutting concerns and integration points

### Definition of Done
- [ ] Tab persistence works across worktree switches and app restarts
- [ ] Session tab badges show correct status for each tab independently
- [ ] Queued messages sent and processed correctly during streaming
- [ ] "+" button creates worktrees, 3-dot button removed
- [ ] Context indicator shows accurate usage and updates live
- [ ] Native notifications appear when unfocused, clicking navigates correctly
- [ ] Images can be attached via button or paste, sent with message, removed
- [ ] Slash commands popover shows, filters, and selects correctly
- [ ] Known tool calls render with rich views
- [ ] Unknown tool calls render with TODO fallback
- [ ] Subagent parts render as expandable cards with nested content
- [ ] Reasoning blocks render as collapsible thinking sections
- [ ] Context compaction shows as info pill
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] No console errors during normal operation
- [ ] Tool card render < 50ms
- [ ] Context indicator update < 200ms
- [ ] Notification delivery < 500ms
- [ ] Slash command popover < 100ms
- [ ] Tab persistence restore < 50ms

### Testing Criteria
```typescript
// test/phase-6/session-10/integration-polish.test.ts
describe('Session 10: Integration & Polish', () => {
  test('Tab persistence end-to-end', () => {
    // Switch worktrees, verify active session restored
  })

  test('Tab badges end-to-end', () => {
    // Send message, verify spinner, switch tab, verify unread dot, click back, verify cleared
  })

  test('Queued messages end-to-end', () => {
    // Send, queue follow-up during stream, verify both processed
  })

  test('Plus button end-to-end', () => {
    // Hover, click +, verify worktree created, right-click verify menu
  })

  test('Context indicator end-to-end', () => {
    // Send message, verify bar fills, hover, verify tooltip
  })

  test('Notification end-to-end', () => {
    // Blur, send message, verify notification, click, verify navigation
  })

  test('Image attachment end-to-end', () => {
    // Attach image, send, verify file part in prompt
  })

  test('Slash commands end-to-end', () => {
    // Type /, filter, select, send
  })

  test('Rich tool rendering end-to-end', () => {
    // Trigger Read, Edit, Bash, unknown tool
    // Verify each renders correctly
  })

  test('Subagent rendering end-to-end', () => {
    // Trigger subagent spawn, verify card, nested messages, completion
  })

  test('Cross-feature: queue during subagent', () => {
    // Subagent running, queue follow-up, verify queued
  })

  test('Cross-feature: context indicator with multiple messages', () => {
    // Send 3 messages, verify cumulative token tracking
  })

  test('Lint passes', () => {
    // pnpm lint exit code 0
  })

  test('Tests pass', () => {
    // pnpm test exit code 0
  })

  test('No console errors', () => {
    // Navigate through all Phase 6 features, verify zero console.error
  })
})
```

---

## Dependencies & Order

```
Session 1 (Tab Persistence & Badges)
    |
Session 2 (Queued Messages & Plus Button)
    |
Session 3 (Context Indicator)
    |
Session 4 (Notifications)
    |
Session 5 (Prompt Parts API)  ← prerequisite for images
    |
Session 6 (Image Attachments)
    |
Session 7 (Slash Commands)
    |
Session 8 (Rich Tool Rendering)
    |
Session 9 (Part Types & Subagent)
    |
Session 10 (Integration & Polish)
```

### Parallel Tracks

While sessions are listed sequentially, several can run in parallel after Session 1:

- **Track A (Core UX)**: Sessions 1 → 2 (tab persistence, badges, queued messages, plus button)
- **Track B (Context Awareness)**: Session 3 (context indicator — independent after Session 1)
- **Track C (Notifications)**: Session 4 (independent — only touches main process + new hook)
- **Track D (Attachments)**: Sessions 5 → 6 (prompt API must precede image UI)
- **Track E (Commands)**: Session 7 (independent — separate IPC + popover)
- **Track F (Rendering)**: Sessions 8 → 9 (tool rendering first, then part types that depend on AssistantCanvas updates)

**Minimum critical path**: Sessions 1 → 5 → 6 → 10 (tab persistence → prompt API → images → polish)

**Maximum parallelism**: After Session 1, tracks B/C/D/E/F can all proceed independently.

Session 10 requires all other sessions to be complete.

---

## Notes

### Assumed Phase 5 Infrastructure
- Script runner service with sequential/persistent/archive execution
- Setup tab and Run tab in BottomPanel with xterm.js
- Worktree status store (`useWorktreeStatusStore`) with per-session status tracking
- Default "(no-worktree)" worktree per project
- Professional app icon
- Streaming bug fixes (role checking, message ID dedup, finalization guards)
- Cmd+R keyboard shortcut for run script

### Out of Scope (Phase 6)
Per PRD Phase 6, these are NOT included:
- Video or audio file attachments (images and PDFs only)
- Inline image rendering in assistant responses
- Slash command argument editing/templating UI
- Multi-file diff viewer for Edit tool
- Streaming syntax highlighting (highlight after tool completes)
- Notification sound customization
- Notification preferences/settings UI (always notify when unfocused)
- Drag-and-drop file attachment (clipboard paste and button only)
- Context compaction trigger from the UI (show indicator only)
- Subagent message editing or interaction (read-only nested view)

### Performance Targets
| Operation | Target |
|-----------|--------|
| Tool card rendering (known tools) | < 50ms render time |
| Subagent card expand/collapse | < 100ms transition |
| Context indicator update | < 200ms after message.updated event |
| Notification delivery | < 500ms after session.idle when unfocused |
| Queued message send | < 100ms to submit (non-blocking) |
| Image attachment preview | < 200ms after paste or file selection |
| Slash command popover | < 100ms after typing "/" |
| Tab persistence restore | < 50ms on worktree switch |
| Session tab badge update | < 100ms after status change |

### Key Architecture Decisions
1. **Queued messages use SDK's native `promptAsync()` non-blocking behavior** — no custom queue needed. The SDK handles message queuing when the session is busy.
2. **Image attachments use `data:` URLs** — simplest approach, works for reasonably-sized images. Large file support (file:// URLs) deferred to a future phase.
3. **Context indicator tracks cumulative tokens per session** — sum of all assistant message tokens (input + output + reasoning). This approximates context window usage. More precise tracking would require server-side support.
4. **Tool renderers are lazy-loaded via the routing map** — `ToolCard` stays lightweight; specific renderers only mount when expanded. This keeps initial render fast.
5. **Subagent parts are rendered inline** — child session events are already routed to parent sessions by `opencode-service.ts`. The renderer accumulates child parts under the subtask part by matching sessionID.
6. **Slash commands are fetched once and cached** — on session connect, not on every "/" keystroke. Filter is client-side substring match.
7. **Tab persistence uses localStorage via Zustand persist** — lightweight, immediate, survives app restarts. Database not needed for this ephemeral preference.
8. **Notifications use Electron's `Notification` API** — native OS integration, no extra dependencies. Focus tracking via BrowserWindow events.
