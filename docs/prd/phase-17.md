# Hive -- Phase 17 Product Requirements Document

## Overview

Phase 17 delivers a broad set of UX polish, data persistence, and organizational improvements across Hive. It includes: refreshing git status on window focus so users always see current file changes; showing a fun, randomized "Worked for Xs" completion badge after streaming; making model selection per-session with persistence; fixing tab-bar loading indicator accuracy; persisting default variant per model to the database; creating styled toast variants (success/info/error); auto-populating commit messages from session names; opening changed files as proper tabs instead of overlays; stripping the plan-mode prefix from displayed messages and showing a PLANNER badge; and introducing project spaces for logical grouping with customizable icons and a bottom tab bar.

### Phase 17 Goals

1. Refresh git file statuses when the Electron window regains focus
2. Show a randomized "Worked for {duration}" badge after session streaming completes (ephemeral, no persistence)
3. Make model selection per-session with persistence, defaulting new sessions to the last used model
4. Fix tab-bar loading indicator disappearing while sessions are still streaming
5. Persist default variant per model to SQLite so variant preference survives restarts
6. Create three visually distinct toast variants (success, info, error) and categorize all existing toasts
7. Default commit message to the session names from the current worktree
8. Open changed files from the git sidebar as proper file tabs instead of diff overlays
9. Strip plan-mode prefix from displayed messages and show a PLANNER badge instead
10. Add project spaces with customizable icons, a bottom tab bar, and per-space project filtering

---

## Technical Additions

| Component                  | Technology                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Git refresh on focus       | `BrowserWindow` `focus` event in main process, new IPC event `git:windowFocused`, renderer listener |
| Streaming completion badge | Ephemeral React state in `WorktreeItem` / `SessionView`, `Date.now()` duration tracking, word pool  |
| Per-session model          | New `model_provider_id`, `model_id`, `model_variant` columns on `sessions` table, store changes     |
| Tab loading fix            | Extend `SessionTabs` spinner to cover `'planning'` status, audit status propagation                 |
| Variant persistence        | New `model_variants` table in SQLite, `useSettingsStore` reads/writes per-model default variant     |
| Toast variants             | Custom toast components with icon + color coding, update `sonner.tsx` and `toast.ts`                |
| Default commit message     | New `session_titles` column on `worktrees` table, accumulate on rename, populate `GitCommitForm`    |
| File tabs for changes      | Extend `useFileViewerStore` to open changed files as tabs with diff content, update `ChangesView`   |
| Plan mode badge            | Client-side prefix stripping in message renderer, new `PlannerBadge` component on `UserBubble`      |
| Project spaces             | New `spaces` table, `space_id` FK on `projects`, `SpacesTabBar` component, space management UI      |

---

## Features

### 1. Refresh Git Changes on Window Focus

#### 1.1 Current State

Git file statuses are only refreshed in response to explicit mutations (stage, unstage, commit, push, pull, discard, etc.) via `git:statusChanged` IPC events emitted from `src/main/ipc/git-file-handlers.ts` (lines 73, 99, 125, 239, 267, 294, 325, 355, 381). Each mutation handler calls `mainWindow.webContents.send('git:statusChanged', { worktreePath })` after the operation completes.

The renderer subscribes to these events in `ChangesView.tsx` (lines 62-83) via `window.gitOps.onStatusChanged()` and reloads file statuses for the matching worktree path.

There is **no polling** and **no window focus detection** for git refreshes. The only existing focus handler is in `NotificationService` (`src/main/services/notification-service.ts`, lines 21-24) which clears the dock badge on focus. If a user switches to their terminal, runs git commands, and switches back to Hive, the changes sidebar is stale until they manually trigger a refresh.

#### 1.2 New Design

```
Window focus → git refresh flow:

  ┌───────────────────────────────────────────────────┐
  │ Main Process                                       │
  │                                                    │
  │  BrowserWindow 'focus' event                       │
  │    → mainWindow.webContents.send('app:windowFocused') │
  └───────────────┬───────────────────────────────────┘
                  │ IPC event
                  ▼
  ┌───────────────────────────────────────────────────┐
  │ Renderer (preload)                                 │
  │                                                    │
  │  window.app.onWindowFocused(callback)              │
  └───────────────┬───────────────────────────────────┘
                  │
                  ▼
  ┌───────────────────────────────────────────────────┐
  │ Renderer (store/component)                         │
  │                                                    │
  │  useGitStore.refreshStatuses()                     │
  │    (already debounced at 150ms)                    │
  │                                                    │
  │  Refreshes ALL expanded worktrees' file statuses   │
  │  and branch info in one pass                       │
  └───────────────────────────────────────────────────┘

  Throttle: Only trigger if >2s since last refresh
  to avoid redundant work on rapid focus toggling.
```

#### 1.3 Implementation

**A. Emit `app:windowFocused` from main process** (`src/main/index.ts`):

After the `mainWindow` is created, add a focus listener:

```typescript
mainWindow.on('focus', () => {
  mainWindow.webContents.send('app:windowFocused')
})
```

**B. Expose in preload** (`src/preload/index.ts`):

Add to the `app` namespace (or create one if needed):

```typescript
onWindowFocused: (callback: () => void) => {
  const handler = () => callback()
  ipcRenderer.on('app:windowFocused', handler)
  return () => ipcRenderer.removeListener('app:windowFocused', handler)
}
```

**C. Add type declaration** (`src/preload/index.d.ts`):

```typescript
// In the app namespace interface:
onWindowFocused(callback: () => void): () => void
```

**D. Listen in renderer and trigger git refresh.** The best place is in a top-level hook or `AppLayout.tsx` since it needs to refresh all visible worktrees, not just the active one:

```typescript
useEffect(() => {
  let lastRefreshTime = 0
  const THROTTLE_MS = 2000

  const unsubscribe = window.app.onWindowFocused(() => {
    const now = Date.now()
    if (now - lastRefreshTime < THROTTLE_MS) return
    lastRefreshTime = now

    // Refresh git statuses for all expanded worktrees
    useGitStore.getState().refreshStatuses()
  })

  return unsubscribe
}, [])
```

#### 1.4 Files to Modify

| File                                               | Change                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `src/main/index.ts`                                | Add `mainWindow.on('focus', ...)` to emit `app:windowFocused` |
| `src/preload/index.ts`                             | Expose `onWindowFocused` in appropriate namespace             |
| `src/preload/index.d.ts`                           | Add type declaration for `onWindowFocused`                    |
| `src/renderer/src/components/layout/AppLayout.tsx` | Subscribe to `onWindowFocused`, call `refreshStatuses()`      |

---

### 2. Streaming Completion Badge ("Worked for {duration}")

#### 2.1 Current State

When a session finishes streaming, the status in `WorktreeItem.tsx` (lines 96-104) transitions from `'working'` → cleared (shows `'Ready'`). There is no intermediate "completed" state and no duration tracking.

The streaming lifecycle in `SessionView.tsx`:

- **Start:** `session.status busy` event at line 1178 sets `isStreaming = true`
- **End:** `resetStreamingState()` at line 620 sets `isStreaming = false`

The `useWorktreeStatusStore.ts` (line 5) defines `SessionStatus = 'working' | 'planning' | 'answering' | 'unread'` — no `'completed'` variant exists.

Individual tool durations are tracked (`ToolCard.tsx`, lines 573-578), but there is no overall response duration tracking.

#### 2.2 New Design

```
Streaming completion badge flow:

  Word pool: ['Worked', 'Brewed', 'Cooked', 'Crafted', 'Built',
              'Forged', 'Wove', 'Shipped', 'Baked', 'Hacked']

  Duration formatting:
    < 60s  → "{n}s"     (e.g., "Brewed for 23s")
    >= 60s → "{n}m"     (e.g., "Cooked for 3m")
    >= 60m → "{n}h"     (e.g., "Forged for 1h")

  Lifecycle:
  ┌──────────┐     ┌──────────────┐     ┌──────────────────────┐
  │ Working  │ ──▶ │ Completed    │ ──▶ │ Ready (after timeout) │
  │ (spinner)│     │ "Baked for   │     │ (normal idle state)   │
  │          │     │  45s" badge  │     │                       │
  └──────────┘     └──────────────┘     └──────────────────────┘
                    shows for 30s
                    or until next
                    streaming starts

  Storage: Ephemeral only — useWorktreeStatusStore
  gets a new status variant 'completed' with metadata:
    { status: 'completed', word: string, durationMs: number }

  Displayed in:
    - WorktreeItem sidebar: replaces "Ready" text with "{Word} for {duration}"
    - SessionTabs: small badge next to tab name (optional)
```

#### 2.3 Implementation

**A. Extend `SessionStatus` type** in `useWorktreeStatusStore.ts`:

```typescript
type SessionStatus = 'working' | 'planning' | 'answering' | 'unread' | 'completed'

interface SessionStatusEntry {
  status: SessionStatus
  word?: string // random word from pool (only for 'completed')
  durationMs?: number // streaming duration (only for 'completed')
}
```

**B. Track streaming start time** in `SessionView.tsx`:

```typescript
const streamingStartTimeRef = useRef<number | null>(null)

// In session.status busy handler:
if (status.type === 'busy') {
  if (!streamingStartTimeRef.current) {
    streamingStartTimeRef.current = Date.now()
  }
  // ... existing busy handling
}
```

**C. On streaming completion, set 'completed' status with random word and duration:**

```typescript
const COMPLETION_WORDS = [
  'Worked',
  'Brewed',
  'Cooked',
  'Crafted',
  'Built',
  'Forged',
  'Wove',
  'Shipped',
  'Baked',
  'Hacked'
]

// In the idle/finalization path (after resetStreamingState):
const durationMs = streamingStartTimeRef.current ? Date.now() - streamingStartTimeRef.current : 0
streamingStartTimeRef.current = null

const word = COMPLETION_WORDS[Math.floor(Math.random() * COMPLETION_WORDS.length)]

statusStore.setSessionStatus(sessionId, 'completed', { word, durationMs })

// Auto-clear after 30 seconds
setTimeout(() => {
  const current = statusStore.sessionStatuses[sessionId]
  if (current?.status === 'completed') {
    statusStore.clearSessionStatus(sessionId)
  }
}, 30_000)
```

**D. Format duration helper** (utility function):

```typescript
function formatCompletionDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return `${hours}h`
}
```

**E. Update `WorktreeItem.tsx`** to render the completion badge:

```typescript
: worktreeStatus === 'completed'
  ? {
      displayStatus: `${statusEntry?.word ?? 'Worked'} for ${formatCompletionDuration(statusEntry?.durationMs ?? 0)}`,
      statusClass: 'font-semibold text-green-500'
    }
: worktreeStatus === 'working'
  ? { displayStatus: 'Working', statusClass: 'font-semibold text-primary' }
```

Show a checkmark icon instead of spinner when completed:

```typescript
{worktreeStatus === 'completed' && (
  <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
)}
```

#### 2.4 Files to Modify

| File                                                     | Change                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/renderer/src/stores/useWorktreeStatusStore.ts`      | Extend `SessionStatus` with `'completed'`, add `word`/`durationMs` fields |
| `src/renderer/src/components/sessions/SessionView.tsx`   | Track `streamingStartTimeRef`, set completed status on finalization       |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx` | Render "{Word} for {duration}" text and checkmark icon for completed      |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`    | Set completed status for background sessions on idle                      |

---

### 3. Per-Session Model Selection

#### 3.1 Current State

Model selection is **global** — a single `selectedModel: SelectedModel | null` in `useSettingsStore.ts` (line 36) applies to all sessions. When the user changes the model, it updates globally via `setSelectedModel()` (line 148) which persists to localStorage, SQLite (`app_settings` key), and the OpenCode backend.

The `Session` interface in `useSessionStore.ts` (lines 8-19) has no model fields. The `sessions` database table (schema.ts, lines 28-38) has no model columns.

`ModelSelector.tsx` reads from `useSettingsStore` globally (line 38) and writes back globally (line 113).

When creating a new session (`useSessionStore.ts`, line 155), no model information is stored on the session record.

#### 3.2 New Design

```
Per-session model selection:

  ┌─────────────────────────────────────────────────────┐
  │ Session A (Tab 1)                                    │
  │   Model: claude-opus-4-5 / anthropic                 │
  │   Variant: high                                      │
  └─────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────┐
  │ Session B (Tab 2)                                    │
  │   Model: codex-mini / openai                         │
  │   Variant: null                                      │
  └─────────────────────────────────────────────────────┘

  Storage:
  - sessions table gets 3 new columns:
    model_provider_id TEXT
    model_id TEXT
    model_variant TEXT

  - New session defaults:
    Copy from the LAST session's model (within same worktree)
    or fall back to global selectedModel from useSettingsStore

  - When user switches tabs:
    The active session's model is pushed to OpenCode backend
    via window.opencodeOps.setModel()

  - Global selectedModel in useSettingsStore remains as
    the "last used" default for new sessions

  Data flow:
  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
  │ ModelSelector │───▶│ useSessionStore  │───▶│ sessions DB  │
  │  (per tab)   │    │ .setSessionModel │    │ model columns│
  │              │    │                  │───▶│ OpenCode SDK │
  └──────────────┘    └──────────────────┘    └──────────────┘
                             │
                             ▼
                      Also update global
                      useSettingsStore.selectedModel
                      (for "last used" default)
```

#### 3.3 Implementation

**A. Database migration (v11)** — add model columns to sessions:

```sql
ALTER TABLE sessions ADD COLUMN model_provider_id TEXT;
ALTER TABLE sessions ADD COLUMN model_id TEXT;
ALTER TABLE sessions ADD COLUMN model_variant TEXT;
```

**B. Update Session interface** in `src/preload/index.d.ts`:

```typescript
interface Session {
  // ... existing fields
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
}
```

**C. Add `setSessionModel` action** to `useSessionStore.ts`:

```typescript
setSessionModel: async (sessionId: string, model: SelectedModel) => {
  // Update in-memory store
  set((state) => {
    const session = state.sessions.get(sessionId)
    if (session) {
      session.model_provider_id = model.providerID
      session.model_id = model.modelID
      session.model_variant = model.variant ?? null
    }
    return { sessions: new Map(state.sessions) }
  })

  // Persist to database
  await window.db.session.update(sessionId, {
    model_provider_id: model.providerID,
    model_id: model.modelID,
    model_variant: model.variant ?? null
  })

  // Push to OpenCode backend
  await window.opencodeOps.setModel(model)

  // Also update global "last used" model
  useSettingsStore.getState().setSelectedModel(model)
}
```

**D. Update `ModelSelector.tsx`** to read/write from session instead of global:

```typescript
// Instead of reading from useSettingsStore:
const session = useSessionStore((state) => state.sessions.get(sessionId))
const selectedModel: SelectedModel | null = session?.model_id
  ? {
      providerID: session.model_provider_id!,
      modelID: session.model_id,
      variant: session.model_variant ?? undefined
    }
  : useSettingsStore((state) => state.selectedModel) // fallback to global

// When selecting a model:
function handleSelectModel(model: ModelInfo): void {
  const variantKeys = getVariantKeys(model)
  const variant = variantKeys.length > 0 ? variantKeys[0] : undefined
  useSessionStore.getState().setSessionModel(sessionId, {
    providerID: model.providerID,
    modelID: model.id,
    variant
  })
}
```

**E. On tab switch**, push the active session's model to OpenCode:

```typescript
// In SessionView or the tab switch handler:
useEffect(() => {
  const session = useSessionStore.getState().sessions.get(sessionId)
  if (session?.model_id) {
    window.opencodeOps.setModel({
      providerID: session.model_provider_id!,
      modelID: session.model_id,
      variant: session.model_variant ?? undefined
    })
  }
}, [sessionId])
```

**F. On session creation**, default to last session's model or global default:

```typescript
// In createSession action:
const existingSessions = get().sessionsByWorktree.get(worktreeId) || []
const lastSession =
  existingSessions.length > 0
    ? get().sessions.get(existingSessions[existingSessions.length - 1])
    : null
const defaultModel = lastSession?.model_id
  ? {
      model_provider_id: lastSession.model_provider_id,
      model_id: lastSession.model_id,
      model_variant: lastSession.model_variant
    }
  : (() => {
      const global = useSettingsStore.getState().selectedModel
      return global
        ? {
            model_provider_id: global.providerID,
            model_id: global.modelID,
            model_variant: global.variant ?? null
          }
        : null
    })()

const session = await window.db.session.create({
  worktree_id: worktreeId,
  project_id: projectId,
  name: `New session - ${new Date().toISOString()}`,
  ...(defaultModel && {
    model_provider_id: defaultModel.model_provider_id,
    model_id: defaultModel.model_id,
    model_variant: defaultModel.model_variant
  })
})
```

#### 3.4 Files to Modify

| File                                                     | Change                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/main/db/schema.ts`                                  | Add migration v11: `model_provider_id`, `model_id`, `model_variant` cols |
| `src/main/db/database.ts`                                | Update session CRUD to handle new columns                                |
| `src/preload/index.d.ts`                                 | Add model fields to `Session` interface                                  |
| `src/renderer/src/stores/useSessionStore.ts`             | Add `setSessionModel` action, update `createSession` defaults            |
| `src/renderer/src/components/sessions/ModelSelector.tsx` | Read/write model from session store instead of global settings store     |
| `src/renderer/src/components/sessions/SessionView.tsx`   | Push session model to OpenCode on tab switch                             |

---

### 4. Fix Tab Bar Loading Indicator

#### 4.1 Current State

The tab bar in `SessionTabs.tsx` (lines 110-115) shows a spinner **only** when `sessionStatus === 'working'`:

```typescript
{sessionStatus === 'working' && (
  <Loader2 className="h-3 w-3 animate-spin text-blue-500 flex-shrink-0" />
)}
```

It does **not** show a spinner for `'planning'` status. The sidebar `WorktreeItem.tsx` (lines 276-282) correctly shows a spinner for both `'working'` and `'planning'`:

```typescript
{(worktreeStatus === 'working' || worktreeStatus === 'planning') && (
  <Loader2 className="h-3.5 w-3.5 text-primary shrink-0 animate-spin" />
)}
```

Additionally, the tab bar uses `sessionStatuses[sessionId]?.status` directly from the worktree status store (line 47-49). If there is any timing gap where the status is cleared momentarily during `session.status idle → busy` transitions (as identified in Phase 16's debounced finalization), the tab spinner would disappear and not reappear.

The `'answering'` status is also not reflected in the tab bar — only in the sidebar.

#### 4.2 New Design

```
Tab indicator states (aligned with sidebar):

  Status        Tab Indicator          Color
  ─────────     ──────────────         ─────
  'working'     Loader2 spinner        text-blue-500
  'planning'    Loader2 spinner        text-blue-400
  'answering'   AlertCircle icon       text-amber-500
  'completed'   Check icon             text-green-500
  'unread'      Blue dot               bg-blue-500
  null          (none)                 —
```

#### 4.3 Implementation

**A. Update `SessionTabs.tsx`** to show spinner for all active statuses:

```typescript
{(sessionStatus === 'working' || sessionStatus === 'planning') && (
  <Loader2
    className={cn(
      'h-3 w-3 animate-spin flex-shrink-0',
      sessionStatus === 'planning' ? 'text-blue-400' : 'text-blue-500'
    )}
  />
)}
{sessionStatus === 'answering' && (
  <AlertCircle className="h-3 w-3 text-amber-500 flex-shrink-0" />
)}
{sessionStatus === 'completed' && (
  <Check className="h-3 w-3 text-green-500 flex-shrink-0" />
)}
{sessionStatus === 'unread' && !isActive && (
  <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
)}
```

**B. Audit status propagation during tab switches** — ensure that when switching to a tab, the component re-reads the current status from the store, not a stale closure.

#### 4.4 Files to Modify

| File                                                   | Change                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `src/renderer/src/components/sessions/SessionTabs.tsx` | Add spinner for `'planning'`, icon for `'answering'`/`'completed'` |

---

### 5. Persist Default Variant per Model

#### 5.1 Current State

Model variant selection is stored as part of the global `selectedModel` in `useSettingsStore.ts` (line 14: `variant?: string`). When switching to a different model, the variant defaults to the **first** variant key (`ModelSelector.tsx`, line 116: `const variant = variantKeys.length > 0 ? variantKeys[0] : undefined`). There is no memory of which variant was last used for a given model.

For example, if the user selects `claude-opus-4-5` with variant `high`, then switches to `codex-mini`, then switches back to `claude-opus-4-5`, the variant resets to the first key instead of remembering `high`.

#### 5.2 New Design

```
Per-model variant persistence:

  ┌─────────────────────────────────────────────────────┐
  │ Settings DB (key-value)                              │
  │                                                      │
  │  key: 'model_variant_defaults'                       │
  │  value: JSON {                                       │
  │    "anthropic::claude-opus-4-5-20251101": "high",    │
  │    "openai::codex-mini": "low",                      │
  │    ...                                               │
  │  }                                                   │
  └─────────────────────────────────────────────────────┘

  When user selects model X:
    1. Look up "providerID::modelID" in variant defaults
    2. If found → use that variant
    3. If not found → use first variant key (current behavior)

  When user changes variant:
    1. Persist "providerID::modelID" → variant to the map
    2. Save map to settings DB
```

#### 5.3 Implementation

**A. Add `modelVariantDefaults` to settings store** (`useSettingsStore.ts`):

```typescript
interface SettingsState {
  // ... existing fields
  modelVariantDefaults: Record<string, string> // "providerID::modelID" → variant

  setModelVariantDefault: (providerID: string, modelID: string, variant: string) => void
  getModelVariantDefault: (providerID: string, modelID: string) => string | undefined
}
```

**B. Update `handleSelectModel` in `ModelSelector.tsx`** to read remembered variant:

```typescript
function handleSelectModel(model: ModelInfo): void {
  const variantKeys = getVariantKeys(model)
  const remembered = useSettingsStore.getState().getModelVariantDefault(model.providerID, model.id)
  const variant = variantKeys.includes(remembered ?? '')
    ? remembered
    : variantKeys.length > 0
      ? variantKeys[0]
      : undefined
  setSelectedModel({ providerID: model.providerID, modelID: model.id, variant })
}
```

**C. Update `handleSelectVariant`** to persist:

```typescript
function handleSelectVariant(model: ModelInfo, variant: string): void {
  useSettingsStore.getState().setModelVariantDefault(model.providerID, model.id, variant)
  setSelectedModel({ providerID: model.providerID, modelID: model.id, variant })
}
```

**D. Persist to SQLite** as part of the existing `saveToDatabase()` flow — include `modelVariantDefaults` in the `AppSettings` JSON blob.

#### 5.4 Files to Modify

| File                                                     | Change                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/renderer/src/stores/useSettingsStore.ts`            | Add `modelVariantDefaults` map, getter/setter, include in persistence |
| `src/renderer/src/components/sessions/ModelSelector.tsx` | Read remembered variant on model select, persist on variant change    |

---

### 6. Toast Variants (Success, Info, Error)

#### 6.1 Current State

Toasts use the `sonner` library with a shadcn/ui wrapper (`src/renderer/src/components/ui/sonner.tsx`, 24 lines). A custom toast utility (`src/renderer/src/lib/toast.ts`, 210 lines) provides `toast.success()`, `toast.error()`, `toast.info()`, `toast.warning()`, and domain helpers (`gitToast`, `projectToast`, etc.).

All toasts currently look visually similar — they share the same `bg-background text-foreground border-border` styling from the Sonner wrapper. The only differentiation is duration (3s for success/info, 5s for error). There are no color-coded icons, no colored borders, and no visual way to quickly distinguish a success from an error.

Some components import `toast` directly from `sonner` (e.g., `SessionView.tsx`) instead of the custom wrapper, bypassing the centralized toast system.

#### 6.2 New Design

```
Three visually distinct toast variants:

  ┌──────────────────────────────────────────────────┐
  │ ✓ Success                                         │
  │   Green left border (border-l-4 border-green-500) │
  │   CheckCircle2 icon in green                      │
  │   3s duration                                     │
  └──────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────┐
  │ ℹ Info                                            │
  │   Blue left border (border-l-4 border-blue-500)   │
  │   Info icon in blue                               │
  │   3s duration                                     │
  └──────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────┐
  │ ✕ Error                                           │
  │   Red left border (border-l-4 border-red-500)     │
  │   XCircle icon in red                             │
  │   5s duration                                     │
  │   Optional "Retry" action button                  │
  └──────────────────────────────────────────────────┘

  Warning variant (existing) gets:
  │   Amber left border, AlertTriangle icon in amber  │

  Implementation approach:
  - Use Sonner's `classNames` prop on the <Toaster> component
    to apply variant-specific styles
  - OR use custom toast rendering with sonner.custom()
  - Audit all toast.xxx() calls to ensure correct categorization
```

#### 6.3 Implementation

**A. Update Sonner `<Toaster>` component** (`sonner.tsx`) with variant-specific class overrides:

```tsx
<Sonner
  theme={theme as ToasterProps['theme']}
  className="toaster group"
  toastOptions={{
    classNames: {
      toast:
        'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-lg',
      success: 'group-[.toaster]:border-l-4 group-[.toaster]:border-l-green-500',
      error: 'group-[.toaster]:border-l-4 group-[.toaster]:border-l-red-500',
      info: 'group-[.toaster]:border-l-4 group-[.toaster]:border-l-blue-500',
      warning: 'group-[.toaster]:border-l-4 group-[.toaster]:border-l-amber-500',
      description: 'group-[.toast]:text-muted-foreground',
      actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
      cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground'
    }
  }}
/>
```

**B. Add icons to toast calls** in `toast.ts`:

Sonner supports an `icon` option. Update the wrapper functions:

```typescript
import { CheckCircle2, XCircle, Info, AlertTriangle } from 'lucide-react'

success: (message: string, options?: ToastOptions) => {
  return sonnerToast.success(message, {
    duration: 3000,
    icon: createElement(CheckCircle2, { className: 'h-4 w-4 text-green-500' }),
    ...options
  })
},
error: (message: string, options?: ToastOptions) => {
  return sonnerToast.error(message, {
    duration: 5000,
    icon: createElement(XCircle, { className: 'h-4 w-4 text-red-500' }),
    ...options
  })
},
info: (message: string, options?: ToastOptions) => {
  return sonnerToast.info(message, {
    duration: 3000,
    icon: createElement(Info, { className: 'h-4 w-4 text-blue-500' }),
    ...options
  })
}
```

**C. Audit and categorize all existing toast calls** across the codebase. Replace any raw `sonnerToast()` calls that import directly from `sonner` with the centralized `toast` wrapper from `@/lib/toast`. Categorize each call:

- Success: git operations completed, session created, clipboard copied, project added
- Error: git failures, session errors, network failures, validation errors
- Info: status updates, warnings about limits, informational messages

#### 6.4 Files to Modify

| File                                        | Change                                                     |
| ------------------------------------------- | ---------------------------------------------------------- |
| `src/renderer/src/components/ui/sonner.tsx` | Add variant-specific `classNames` to `toastOptions`        |
| `src/renderer/src/lib/toast.ts`             | Add icons to each toast variant, ensure consistent styling |
| Multiple component files                    | Audit/replace direct `sonner` imports with `@/lib/toast`   |

---

### 7. Default Commit Message from Session Names

#### 7.1 Current State

`GitCommitForm.tsx` (lines 107-142) renders a `summary` input and `description` textarea for commit messages. Both start empty. There is no auto-population from session data.

Session names are stored in the `sessions` table (`name` column). They are auto-generated as `'New session - {ISO timestamp}'` on creation and updated via `updateSessionName()` or from OpenCode SDK events (`session.updated`, `SessionView.tsx` line 813-818).

The `commitTemplate` field exists in `useSettingsStore` (line 32) but is unused — no code reads it.

When sessions are renamed (either by auto-title from SDK or manual rename), there is no tracking of the history of names for a worktree.

#### 7.2 New Design

```
Commit message auto-population:

  Session renames accumulate on the worktree record:

  ┌──────────────────────────────────────────────────┐
  │ worktrees table                                   │
  │                                                   │
  │  session_titles TEXT (JSON array)                  │
  │  e.g., ["Add dark mode toggle",                   │
  │         "Fix responsive layout",                  │
  │         "Update color palette"]                   │
  └──────────────────────────────────────────────────┘

  When a session gets a meaningful title (not the default
  "New session - {timestamp}" format):
    → Append the title to the worktree's session_titles array

  GitCommitForm behavior:
  ┌──────────────────────────────────────────────────┐
  │ Summary: "Add dark mode toggle"                   │
  │          (first session title)                    │
  │                                                   │
  │ Description:                                      │
  │   - Add dark mode toggle                          │
  │   - Fix responsive layout                         │
  │   - Update color palette                          │
  └──────────────────────────────────────────────────┘

  - Summary defaults to the FIRST session title
  - Description defaults to ALL session titles as bullet points
  - User can freely edit both fields
  - If no session titles exist, both remain empty (current behavior)
  - Only populate if fields are empty (don't overwrite user edits)
```

#### 7.3 Implementation

**A. Database migration (v12)** — add `session_titles` column to worktrees:

```sql
ALTER TABLE worktrees ADD COLUMN session_titles TEXT DEFAULT '[]';
```

**B. Track session title changes.** In `useSessionStore.ts`, when `updateSessionName` is called and the new name is not a default timestamp format:

```typescript
updateSessionName: async (sessionId: string, name: string) => {
  // ... existing update logic ...

  // If the name looks meaningful (not default format), track it
  const isDefault = /^New session - \d{4}-/.test(name)
  if (!isDefault) {
    const session = get().sessions.get(sessionId)
    if (session?.worktree_id) {
      await window.db.worktree.appendSessionTitle(session.worktree_id, name)
    }
  }
}
```

Also track auto-titles from SDK events (`SessionView.tsx` line 813-818):

```typescript
if (event.session.title && event.session.title !== currentSession?.name) {
  // ... existing name update ...
  const isDefault = /^New session - \d{4}-/.test(event.session.title)
  if (!isDefault && worktreeId) {
    await window.db.worktree.appendSessionTitle(worktreeId, event.session.title)
  }
}
```

**C. Add `appendSessionTitle` IPC endpoint:**

Main handler reads current JSON array, checks for duplicates, appends, and writes back:

```typescript
ipcMain.handle('db:worktree:appendSessionTitle', async (_event, { worktreeId, title }) => {
  const worktree = db.prepare('SELECT session_titles FROM worktrees WHERE id = ?').get(worktreeId)
  const titles: string[] = JSON.parse(worktree?.session_titles || '[]')
  if (!titles.includes(title)) {
    titles.push(title)
    db.prepare('UPDATE worktrees SET session_titles = ? WHERE id = ?').run(
      JSON.stringify(titles),
      worktreeId
    )
  }
  return { success: true }
})
```

**D. Update `GitCommitForm.tsx`** to read session titles and pre-populate:

```typescript
const worktree = useWorktreeStore((state) => state.worktrees.find((w) => w.id === worktreeId))
const sessionTitles: string[] = useMemo(() => {
  try {
    return JSON.parse(worktree?.session_titles || '[]')
  } catch {
    return []
  }
}, [worktree?.session_titles])

// Pre-populate on mount (only if fields are empty)
useEffect(() => {
  if (sessionTitles.length > 0 && !summary) {
    setSummary(sessionTitles[0])
    if (sessionTitles.length > 1) {
      setDescription(sessionTitles.map((t) => `- ${t}`).join('\n'))
    }
  }
}, []) // Only on mount
```

#### 7.4 Files to Modify

| File                                                   | Change                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `src/main/db/schema.ts`                                | Add migration v12: `session_titles TEXT` column on worktrees |
| `src/main/db/database.ts`                              | Add `appendSessionTitle` method                              |
| `src/main/ipc/database-handlers.ts`                    | Add `db:worktree:appendSessionTitle` IPC handler             |
| `src/preload/index.ts`                                 | Expose `appendSessionTitle` in `db.worktree` namespace       |
| `src/preload/index.d.ts`                               | Add type declaration for `appendSessionTitle`                |
| `src/renderer/src/stores/useSessionStore.ts`           | Track title changes in `updateSessionName`                   |
| `src/renderer/src/components/sessions/SessionView.tsx` | Track auto-titles from SDK events                            |
| `src/renderer/src/components/git/GitCommitForm.tsx`    | Pre-populate summary/description from session titles         |

---

### 8. Open Changed Files as Tabs

#### 8.1 Current State

Clicking a file in `ChangesView.tsx` (line 213-226) calls `useFileViewerStore.getState().setActiveDiff()` which sets `activeDiff` state and clears `activeFilePath`. This opens a diff viewer as an **overlay** on top of the current session view — it does not create a tab.

The tab system (`SessionTabs.tsx`) supports two types of tabs: session tabs and file tabs. File tabs are created via `useFileViewerStore.openFile()` (e.g., from the file tree). The diff viewer (`activeDiff`) is a separate concept — it replaces the main content area without creating a tab entry.

When `activeDiff` is set, clicking any session tab calls `setActiveFile(null)` (line 339 of `SessionTabs.tsx`) which clears the file viewer but doesn't affect `activeDiff`. The user must click elsewhere or navigate away to dismiss the diff overlay.

There is no `Cmd+W` handling for the diff overlay.

#### 8.2 New Design

```
Changed files open as proper tabs:

  Current behavior:
  ┌─────────┬─────────┬─────────┐
  │ Session1│ Session2│         │  ← tab bar
  ├─────────┴─────────┴─────────┤
  │                              │
  │   DIFF OVERLAY               │  ← overlays session content
  │   (no tab, no Cmd+W)        │
  │                              │
  └──────────────────────────────┘

  New behavior:
  ┌─────────┬─────────┬──────────┐
  │ Session1│ Session2│ ≋ file.ts│  ← file gets its own tab
  ├─────────┴─────────┴──────────┤
  │                               │
  │   DIFF VIEWER                 │  ← proper tab content
  │   (staged/unstaged diff)      │
  │   Cmd+W closes this tab       │
  │                               │
  └───────────────────────────────┘

  Tab behavior:
  - Tab icon: GitDiff icon (or similar) to distinguish from file tabs
  - Tab name: filename (e.g., "file.ts")
  - Tab tooltip: full relative path + "(staged)" or "(unstaged)"
  - Cmd+W or middle-click closes the tab
  - Clicking the tab re-activates the diff view
  - Multiple diff tabs can be open simultaneously
  - Switching to a session tab hides the diff
  - Switching back to a diff tab shows it again
```

#### 8.3 Implementation

**A. Extend `useFileViewerStore`** with a diff tab type:

```typescript
interface DiffTab {
  type: 'diff'
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
}

// Merge with existing FileViewerTab or add as a union:
type TabEntry = FileViewerTab | DiffTab
```

**B. Update `setActiveDiff`** in the store to also open a tab:

```typescript
setActiveDiff: (diff) => {
  if (!diff) {
    set({ activeDiff: null })
    return
  }
  const tabKey = `diff:${diff.filePath}:${diff.staged ? 'staged' : 'unstaged'}`
  set((state) => ({
    activeDiff: diff,
    activeFilePath: null,
    openFiles: new Map(state.openFiles).set(tabKey, {
      type: 'diff',
      ...diff
    })
  }))
}
```

**C. Update `SessionTabs.tsx`** to render diff tabs with appropriate icon and handle activation/closing.

**D. Add `Cmd+W` handler** for the active diff tab — when a diff tab is active and the user presses `Cmd+W`, close that tab and switch back to the last session.

#### 8.4 Files to Modify

| File                                                    | Change                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/renderer/src/stores/useFileViewerStore.ts`         | Add `DiffTab` type, update `setActiveDiff` to create tab entries   |
| `src/renderer/src/components/sessions/SessionTabs.tsx`  | Render diff tabs with GitDiff icon, handle close and activation    |
| `src/renderer/src/components/file-tree/ChangesView.tsx` | (Minimal changes — `handleViewDiff` already calls `setActiveDiff`) |
| `src/renderer/src/components/sessions/SessionView.tsx`  | Handle `Cmd+W` for diff tabs, coordinate with tab switching        |

---

### 9. Plan Mode Badge (Strip Prefix)

#### 9.1 Current State

The plan mode prefix is defined in `SessionView.tsx` (lines 30-31):

```typescript
const PLAN_MODE_PREFIX =
  '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'
```

When sending a message in plan mode, the prefix is prepended to the prompt sent to the OpenCode SDK (`SessionView.tsx`, lines 1907-1909), but the **local user message** displayed in the chat is created with the raw user input (`createLocalMessage('user', trimmedValue)` at line 1820).

However, when the full transcript is loaded from the database after streaming completes (`loadMessages`), the messages returned from OpenCode contain the prefix in the user message content — because that is what was actually sent. So after finalization, plan-mode user messages **do** show the prefix text in the chat.

The `stripPlanModePrefix` helper (lines 56-61) exists but is only used for undo/redo prompt restoration (line 1752), not for message display.

#### 9.2 New Design

```
Plan mode prefix stripping + PLANNER badge:

  Before (current, after finalization):
  ┌──────────────────────────────────────────────────┐
  │ User message:                                     │
  │ "[Mode: Plan] You are in planning mode. Focus on │
  │  designing, analyzing, and outlining an approach. │
  │  Do NOT make code changes..."                     │
  │                                                   │
  │ How do we implement the new feature?              │
  └──────────────────────────────────────────────────┘

  After:
  ┌──────────────────────────────────────────────────┐
  │ [PLANNER] User message:                           │
  │ How do we implement the new feature?              │
  └──────────────────────────────────────────────────┘

  Implementation:
  - Strip the PLAN_MODE_PREFIX from user message content
    at render time (in MessageRenderer or UserBubble)
  - If the prefix was stripped, attach a "PLANNER" badge
    to the message bubble
  - Do NOT modify the stored message — strip only at render
  - The badge should be a small, styled pill/tag
```

#### 9.3 Implementation

**A. Create a message content processor** in the rendering pipeline:

```typescript
function processUserMessageContent(content: string): { cleanContent: string; isPlanMode: boolean } {
  if (content.startsWith(PLAN_MODE_PREFIX)) {
    return { cleanContent: content.slice(PLAN_MODE_PREFIX.length), isPlanMode: true }
  }
  return { cleanContent: content, isPlanMode: false }
}
```

Move `PLAN_MODE_PREFIX` to a shared constants file so both `SessionView` and the renderer can access it.

**B. Update `UserBubble`** (in `MessageRenderer.tsx` or wherever user messages are rendered) to strip the prefix and show a badge:

```tsx
const { cleanContent, isPlanMode } = processUserMessageContent(message.content)

return (
  <div className="...">
    {isPlanMode && (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-blue-500/15 text-blue-400 mr-2">
        PLANNER
      </span>
    )}
    <MarkdownRenderer content={cleanContent} />
  </div>
)
```

**C. Ensure `PLAN_MODE_PREFIX` is consistent** — the exact prefix must match between the sending code and the stripping code. Extract to a shared constant.

#### 9.4 Files to Modify

| File                                                       | Change                                                |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `src/renderer/src/lib/constants.ts` (new or existing)      | Export `PLAN_MODE_PREFIX` as shared constant          |
| `src/renderer/src/components/sessions/SessionView.tsx`     | Import `PLAN_MODE_PREFIX` from shared location        |
| `src/renderer/src/components/sessions/MessageRenderer.tsx` | Strip prefix from user messages, render PLANNER badge |

---

### 10. Project Spaces

#### 10.1 Current State

Projects are stored as a flat list in `useProjectStore.ts` (lines 5-19). The `Project` interface has `tags: string | null` (JSON array) but there is no UI for grouping by tags. The sidebar renders all projects in a single scrollable list with drag-and-drop reordering (`ProjectList.tsx`) and subsequence filtering (`ProjectFilter.tsx`).

There is no concept of spaces, folders, or logical groupings. The `projects` database table has no foreign key to any grouping entity. The sidebar has no tab bar at the bottom.

#### 10.2 New Design

```
Project Spaces:

  ┌──────────────────────────────────────────────────┐
  │ Sidebar                                           │
  │                                                   │
  │ [Filter projects...]                              │
  │                                                   │
  │ ▶ Project A (workspace)                           │
  │ ▼ Project B (workspace)                           │
  │   ├ main (worktree)                               │
  │   └ feature-x (worktree)                          │
  │ ▶ Project C (workspace)                           │
  │                                                   │
  │ ───────────────────────────────────────────────── │
  │ [ 🏠 All ][ 🔧 Work ][ 🎮 Side ][ + ]           │
  │           ▲ bottom tab bar                        │
  └──────────────────────────────────────────────────┘

  Space data model:
  ┌─────────────────────────────────────────────────┐
  │ spaces table                                     │
  │   id TEXT PRIMARY KEY                            │
  │   name TEXT NOT NULL                             │
  │   icon_type TEXT NOT NULL ('default' | 'custom') │
  │   icon_value TEXT NOT NULL                       │
  │     - default: icon name from built-in collection│
  │     - custom: base64 encoded image data or path  │
  │   sort_order INTEGER DEFAULT 0                   │
  │   created_at TEXT NOT NULL                       │
  └─────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────┐
  │ project_spaces junction table                    │
  │   project_id TEXT REFERENCES projects(id)        │
  │   space_id TEXT REFERENCES spaces(id)            │
  │   PRIMARY KEY (project_id, space_id)             │
  └─────────────────────────────────────────────────┘

  A project can belong to multiple spaces.
  "All" is a virtual space (not stored) that shows everything.

  Built-in icon collection (50+ icons):
  - Category icons from lucide-react: Briefcase, Code, Gamepad2,
    Palette, Music, Camera, Book, Wrench, Rocket, Heart, Star,
    Coffee, Globe, Zap, Shield, Terminal, Database, Cloud,
    Smartphone, Monitor, Cpu, GitBranch, Package, Layers,
    Compass, Map, Flag, Award, Crown, Diamond, Flame, Leaf,
    Sun, Moon, Umbrella, Anchor, Key, Lock, Bell, Bookmark,
    Calendar, Clock, Download, Upload, Search, Settings,
    Share, Trash, Users, Video, Wifi, FileCode, FolderOpen,
    MessageSquare
  - Custom: user uploads an image from their computer
    (stored as base64 or file path)

  Bottom tab bar:
  - Fixed "All" tab (always first, not deletable)
  - User-created space tabs (drag-reorderable)
  - "+" button to create new space
  - Right-click context menu: Rename, Change Icon, Delete
  - Active space is highlighted/underlined
  - Selecting a space filters ProjectList to only show
    projects assigned to that space
  - Long-press or drag a project onto a space tab
    to assign it to that space
```

#### 10.3 Implementation

**A. Database migrations (v13)** — create spaces table and junction table:

```sql
-- Migration v13: Add spaces
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_type TEXT NOT NULL DEFAULT 'default',
  icon_value TEXT NOT NULL DEFAULT 'Folder',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_spaces (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, space_id)
);

CREATE INDEX idx_project_spaces_space ON project_spaces(space_id);
CREATE INDEX idx_project_spaces_project ON project_spaces(project_id);
```

**B. Create `useSpaceStore`** (`src/renderer/src/stores/useSpaceStore.ts`):

```typescript
interface Space {
  id: string
  name: string
  icon_type: 'default' | 'custom'
  icon_value: string
  sort_order: number
  created_at: string
}

interface SpaceState {
  spaces: Space[]
  activeSpaceId: string | null // null = "All"
  projectSpaceMap: Map<string, Set<string>> // projectId → Set<spaceId>

  loadSpaces: () => Promise<void>
  createSpace: (name: string, iconType: string, iconValue: string) => Promise<Space>
  updateSpace: (id: string, data: Partial<Space>) => Promise<void>
  deleteSpace: (id: string) => Promise<void>
  setActiveSpace: (id: string | null) => void
  assignProjectToSpace: (projectId: string, spaceId: string) => Promise<void>
  removeProjectFromSpace: (projectId: string, spaceId: string) => Promise<void>
  getProjectsForSpace: (spaceId: string | null) => string[] // returns project IDs
  reorderSpaces: (fromIndex: number, toIndex: number) => void
}
```

Persist `activeSpaceId` to localStorage.

**C. Create IPC handlers** for space CRUD and project-space assignments:

```
db:space:list → returns Space[]
db:space:create → creates space, returns Space
db:space:update → updates space fields
db:space:delete → deletes space + cascade junction entries
db:space:assignProject → inserts into project_spaces
db:space:removeProject → deletes from project_spaces
db:space:getProjectIds → returns project IDs for a space
db:space:reorder → updates sort_order for all spaces
```

**D. Create `SpacesTabBar` component** (`src/renderer/src/components/spaces/SpacesTabBar.tsx`):

Renders at the bottom of the sidebar. Shows:

- "All" tab (always first, icon: `LayoutGrid` or `Globe`)
- Dynamic space tabs with their icons
- "+" button to create new space
- Active tab highlighted with `border-b-2 border-primary`
- Context menu on right-click: Rename, Change Icon, Delete
- Drop zone for drag-assigning projects

**E. Create `SpaceIconPicker` component** for selecting icons:

Grid of 50+ lucide-react icons plus a "Custom Image" option that opens a file picker dialog (`window.dialog.showOpenDialog`). Custom images are resized client-side and stored as base64 or copied to an app data directory.

**F. Update `ProjectList.tsx`** to filter by active space:

```typescript
const activeSpaceId = useSpaceStore((state) => state.activeSpaceId)
const projectSpaceMap = useSpaceStore((state) => state.projectSpaceMap)

const filteredProjects = useMemo(() => {
  if (!activeSpaceId) return projects // "All" — show everything
  return projects.filter((p) => projectSpaceMap.get(p.id)?.has(activeSpaceId))
}, [projects, activeSpaceId, projectSpaceMap])
```

**G. Update `ProjectItem.tsx`** context menu to include "Move to Space" submenu.

**H. Update sidebar layout** to include `SpacesTabBar` at the bottom:

```tsx
<div className="flex flex-col h-full">
  <div className="flex-1 overflow-y-auto">
    <ProjectFilter ... />
    <ProjectList ... />
  </div>
  <SpacesTabBar />
</div>
```

#### 10.4 Files to Modify

| File                                                            | Change                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/main/db/schema.ts`                                         | Add migration v13: `spaces` table, `project_spaces` junction |
| `src/main/db/database.ts`                                       | Add space CRUD methods and project-space assignment methods  |
| `src/main/ipc/database-handlers.ts`                             | Add IPC handlers for space operations                        |
| `src/preload/index.ts`                                          | Expose space operations in `db.space` namespace              |
| `src/preload/index.d.ts`                                        | Add `Space` type, `db.space` interface declarations          |
| `src/renderer/src/stores/useSpaceStore.ts`                      | **New file**: space state management                         |
| `src/renderer/src/stores/index.ts`                              | Export `useSpaceStore`                                       |
| `src/renderer/src/components/spaces/SpacesTabBar.tsx`           | **New file**: bottom tab bar component                       |
| `src/renderer/src/components/spaces/SpaceIconPicker.tsx`        | **New file**: icon selection grid + custom image upload      |
| `src/renderer/src/components/projects/ProjectList.tsx`          | Filter projects by active space                              |
| `src/renderer/src/components/projects/ProjectItem.tsx`          | Add "Move to Space" context menu item                        |
| `src/renderer/src/components/layout/AppLayout.tsx` (or sidebar) | Add `SpacesTabBar` to sidebar layout                         |

---

## Summary of All Files to Modify

| Feature                | File                                                       | Change                                               |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| Git Focus Refresh      | `src/main/index.ts`                                        | Emit `app:windowFocused` on window focus             |
| Git Focus Refresh      | `src/preload/index.ts`                                     | Expose `onWindowFocused`                             |
| Git Focus Refresh      | `src/preload/index.d.ts`                                   | Type declaration for `onWindowFocused`               |
| Git Focus Refresh      | `src/renderer/src/components/layout/AppLayout.tsx`         | Subscribe to focus, trigger git refresh              |
| Completion Badge       | `src/renderer/src/stores/useWorktreeStatusStore.ts`        | Add `'completed'` status with word/duration metadata |
| Completion Badge       | `src/renderer/src/components/sessions/SessionView.tsx`     | Track streaming start time, set completed status     |
| Completion Badge       | `src/renderer/src/components/worktrees/WorktreeItem.tsx`   | Render "{Word} for {duration}" and checkmark         |
| Completion Badge       | `src/renderer/src/hooks/useOpenCodeGlobalListener.ts`      | Set completed status for background sessions         |
| Per-Session Model      | `src/main/db/schema.ts`                                    | Migration v11: model columns on sessions             |
| Per-Session Model      | `src/main/db/database.ts`                                  | Update session CRUD for model columns                |
| Per-Session Model      | `src/preload/index.d.ts`                                   | Add model fields to Session type                     |
| Per-Session Model      | `src/renderer/src/stores/useSessionStore.ts`               | Add `setSessionModel`, update `createSession`        |
| Per-Session Model      | `src/renderer/src/components/sessions/ModelSelector.tsx`   | Read/write from session store                        |
| Per-Session Model      | `src/renderer/src/components/sessions/SessionView.tsx`     | Push model on tab switch                             |
| Tab Loading Fix        | `src/renderer/src/components/sessions/SessionTabs.tsx`     | Spinner for planning, icon for answering/completed   |
| Variant Persistence    | `src/renderer/src/stores/useSettingsStore.ts`              | Add `modelVariantDefaults` map                       |
| Variant Persistence    | `src/renderer/src/components/sessions/ModelSelector.tsx`   | Read/persist variant defaults                        |
| Toast Variants         | `src/renderer/src/components/ui/sonner.tsx`                | Variant-specific class names                         |
| Toast Variants         | `src/renderer/src/lib/toast.ts`                            | Add icons per variant                                |
| Toast Variants         | Multiple components                                        | Audit/categorize toast calls                         |
| Default Commit Message | `src/main/db/schema.ts`                                    | Migration v12: `session_titles` on worktrees         |
| Default Commit Message | `src/main/db/database.ts`                                  | Add `appendSessionTitle` method                      |
| Default Commit Message | `src/main/ipc/database-handlers.ts`                        | Add `db:worktree:appendSessionTitle` handler         |
| Default Commit Message | `src/preload/index.ts`                                     | Expose `appendSessionTitle`                          |
| Default Commit Message | `src/preload/index.d.ts`                                   | Type declaration                                     |
| Default Commit Message | `src/renderer/src/stores/useSessionStore.ts`               | Track title changes                                  |
| Default Commit Message | `src/renderer/src/components/sessions/SessionView.tsx`     | Track auto-titles from SDK                           |
| Default Commit Message | `src/renderer/src/components/git/GitCommitForm.tsx`        | Pre-populate from session titles                     |
| File Tabs for Changes  | `src/renderer/src/stores/useFileViewerStore.ts`            | Add `DiffTab` type, open tabs for diffs              |
| File Tabs for Changes  | `src/renderer/src/components/sessions/SessionTabs.tsx`     | Render diff tabs                                     |
| File Tabs for Changes  | `src/renderer/src/components/sessions/SessionView.tsx`     | Cmd+W for diff tabs                                  |
| Plan Mode Badge        | `src/renderer/src/lib/constants.ts`                        | Shared `PLAN_MODE_PREFIX` constant                   |
| Plan Mode Badge        | `src/renderer/src/components/sessions/SessionView.tsx`     | Import from shared location                          |
| Plan Mode Badge        | `src/renderer/src/components/sessions/MessageRenderer.tsx` | Strip prefix, render PLANNER badge                   |
| Project Spaces         | `src/main/db/schema.ts`                                    | Migration v13: spaces + project_spaces tables        |
| Project Spaces         | `src/main/db/database.ts`                                  | Space CRUD + assignment methods                      |
| Project Spaces         | `src/main/ipc/database-handlers.ts`                        | Space IPC handlers                                   |
| Project Spaces         | `src/preload/index.ts`                                     | Expose `db.space` namespace                          |
| Project Spaces         | `src/preload/index.d.ts`                                   | Space types and interface                            |
| Project Spaces         | `src/renderer/src/stores/useSpaceStore.ts`                 | **New**: space state management                      |
| Project Spaces         | `src/renderer/src/stores/index.ts`                         | Export useSpaceStore                                 |
| Project Spaces         | `src/renderer/src/components/spaces/SpacesTabBar.tsx`      | **New**: bottom tab bar                              |
| Project Spaces         | `src/renderer/src/components/spaces/SpaceIconPicker.tsx`   | **New**: icon picker grid                            |
| Project Spaces         | `src/renderer/src/components/projects/ProjectList.tsx`     | Filter by active space                               |
| Project Spaces         | `src/renderer/src/components/projects/ProjectItem.tsx`     | "Move to Space" context menu                         |
| Project Spaces         | `src/renderer/src/components/layout/AppLayout.tsx`         | Add SpacesTabBar to sidebar                          |

---

## Out of Scope

- Server-side git status watching (filesystem watchers / `fsevents`) — focus-triggered refresh is sufficient for now
- Streaming duration persistence to database — the completion badge is ephemeral only
- Per-session provider API key management — models share the same provider credentials
- Toast notification history / log viewer
- Commit message templates configurable in settings
- File diff viewer virtualization or syntax highlighting improvements
- Space sharing or import/export between machines
- Nested spaces or space hierarchies
- Custom space colors or themes

---

## Implementation Priority

| Sprint | Features                                                             | Rationale                                                                |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1      | 4 (Tab Loading Fix), 6 (Toast Variants), 9 (Plan Mode Badge)         | Pure UI fixes, no database changes, low risk, immediately visible polish |
| 2      | 1 (Git Focus Refresh), 2 (Completion Badge), 5 (Variant Persistence) | Small features with limited scope, minimal schema changes                |
| 3      | 3 (Per-Session Model), 7 (Default Commit Message)                    | Database migrations required, moderate complexity                        |
| 4      | 8 (File Tabs for Changes)                                            | Refactors existing tab/file viewer architecture                          |
| 5      | 10 (Project Spaces)                                                  | Largest feature, new tables/stores/components, save for last             |

---

## Success Metrics

- Window focus triggers a visible git status refresh within 2 seconds
- Completion badge displays with correct duration after every streaming response
- Each session independently tracks and persists its model selection
- Tab bar loading indicator is always in sync with sidebar indicator
- Model variant preference persists across model switches and app restarts
- Toasts are visually distinguishable by type at a glance
- Commit message form is pre-populated with session titles for the worktree
- Changed files open as closable tabs with Cmd+W support
- Plan mode messages show a PLANNER badge with the prefix text stripped
- Projects can be organized into spaces with the bottom tab bar filtering correctly

---

## Testing Plan

| Test File                                     | Feature                | Validates                                             |
| --------------------------------------------- | ---------------------- | ----------------------------------------------------- |
| `test/phase17/git-focus-refresh.test.ts`      | Git Focus Refresh      | Focus event triggers status refresh with throttle     |
| `test/phase17/completion-badge.test.ts`       | Completion Badge       | Duration tracking, word randomization, auto-clear     |
| `test/phase17/per-session-model.test.ts`      | Per-Session Model      | Model stored per session, defaults, tab switch push   |
| `test/phase17/tab-loading-indicator.test.ts`  | Tab Loading Fix        | Spinner for working+planning, icon for answering      |
| `test/phase17/variant-persistence.test.ts`    | Variant Persistence    | Variant remembered per model across switches          |
| `test/phase17/toast-variants.test.ts`         | Toast Variants         | Visual distinction, icons, correct categorization     |
| `test/phase17/default-commit-message.test.ts` | Default Commit Message | Session titles accumulated, commit form pre-populated |
| `test/phase17/file-diff-tabs.test.ts`         | File Tabs for Changes  | Diff opens as tab, Cmd+W closes, tab switching works  |
| `test/phase17/plan-mode-badge.test.ts`        | Plan Mode Badge        | Prefix stripped, PLANNER badge shown, content intact  |
| `test/phase17/project-spaces.test.ts`         | Project Spaces         | CRUD, assignment, filtering, tab bar, icon picker     |
