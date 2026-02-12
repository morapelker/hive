# Hive Phase 17 Implementation Plan

This document outlines the implementation plan for Hive Phase 17, covering git refresh on window focus, streaming completion badge, per-session model selection, tab loading indicator fix, variant persistence, toast variants, default commit messages, diff file tabs, plan mode badge, and project spaces.

---

## Overview

The implementation is divided into **16 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 17 builds upon Phase 16** — all Phase 16 infrastructure is assumed to be in place.

---

## Dependencies & Parallelization

```
Session 1  (Toast Variants)                    ── no deps
Session 2  (Tab Loading Indicator Fix)         ── no deps
Session 3  (Plan Mode Badge)                   ── no deps
Session 4  (Git Refresh on Focus)              ── no deps
Session 5  (Variant Persistence)               ── no deps
Session 6  (Completion Badge: Store)           ── no deps
Session 7  (Completion Badge: UI)              ── blocked by Session 6
Session 8  (Per-Session Model: Schema)         ── no deps
Session 9  (Per-Session Model: Frontend)       ── blocked by Session 8
Session 10 (Default Commit Message: Backend)   ── no deps
Session 11 (Default Commit Message: Frontend)  ── blocked by Session 10
Session 12 (Diff File Tabs: Store)             ── no deps
Session 13 (Diff File Tabs: UI)               ── blocked by Session 12
Session 14 (Project Spaces: Schema & Store)    ── no deps
Session 15 (Project Spaces: UI)               ── blocked by Session 14
Session 16 (Integration & Verification)        ── blocked by Sessions 1-15
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Time →                                                                  │
│                                                                          │
│  Track A: [S1: Toast Variants]                                           │
│  Track B: [S2: Tab Loading Fix]                                          │
│  Track C: [S3: Plan Mode Badge]                                          │
│  Track D: [S4: Git Refresh on Focus]                                     │
│  Track E: [S5: Variant Persistence]                                      │
│  Track F: [S6: Completion Badge Store] → [S7: Completion Badge UI]       │
│  Track G: [S8: Per-Session Model Schema] → [S9: Per-Session Model UI]   │
│  Track H: [S10: Commit Msg Backend] → [S11: Commit Msg Frontend]        │
│  Track I: [S12: Diff Tabs Store] → [S13: Diff Tabs UI]                  │
│  Track J: [S14: Spaces Schema+Store] → [S15: Spaces UI]                 │
│                                                                          │
│  All ────────────────────────────────────────────► [S16: Integration]    │
└──────────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 1-6, 8, 10, 12, 14 are fully independent (10 sessions). Sessions 7, 9, 11, 13, 15 depend on their predecessors.

**Minimum total**: 3 rounds:

1. (S1, S2, S3, S4, S5, S6, S8, S10, S12, S14 in parallel)
2. (S7, S9, S11, S13, S15 — after their dependencies)
3. (S16)

**Recommended serial order** (if doing one at a time):

S2 → S3 → S1 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12 → S13 → S14 → S15 → S16

Rationale: S2 and S3 are the simplest standalone fixes. S1 is small but touches multiple files. S4-S5 are small features. S6-S7 are sequential (store then UI). S8-S9 require a migration. S10-S11 require a migration. S12-S13 refactor the file viewer. S14-S15 are the largest feature. S16 validates everything.

---

## Testing Infrastructure

### Test File Structure (Phase 17)

```
test/
├── phase-17/
│   ├── session-1/
│   │   └── toast-variants.test.ts
│   ├── session-2/
│   │   └── tab-loading-indicator.test.tsx
│   ├── session-3/
│   │   └── plan-mode-badge.test.tsx
│   ├── session-4/
│   │   └── git-focus-refresh.test.ts
│   ├── session-5/
│   │   └── variant-persistence.test.ts
│   ├── session-6/
│   │   └── completion-badge-store.test.ts
│   ├── session-7/
│   │   └── completion-badge-ui.test.tsx
│   ├── session-8/
│   │   └── per-session-model-schema.test.ts
│   ├── session-9/
│   │   └── per-session-model-frontend.test.tsx
│   ├── session-10/
│   │   └── commit-message-backend.test.ts
│   ├── session-11/
│   │   └── commit-message-frontend.test.tsx
│   ├── session-12/
│   │   └── diff-tabs-store.test.ts
│   ├── session-13/
│   │   └── diff-tabs-ui.test.tsx
│   ├── session-14/
│   │   └── spaces-schema-store.test.ts
│   ├── session-15/
│   │   └── spaces-ui.test.tsx
│   └── session-16/
│       └── integration-verification.test.ts
```

### New Dependencies

```bash
# No new dependencies — all features use existing packages:
# - zustand (stores — already installed)
# - lucide-react (icons — already installed)
# - sonner (toasts — already installed)
# - better-sqlite3 (database — already installed)
# - Electron APIs: BrowserWindow, ipcRenderer, ipcMain (built-in)
```

---

## Session 1: Toast Variants (Success, Info, Error)

### Objectives

- Add variant-specific visual styling (colored left borders) to the Sonner `<Toaster>` component
- Add colored icons to each toast variant in the custom toast wrapper
- Audit all direct `sonner` imports across the codebase and replace with centralized `@/lib/toast`

### Tasks

#### 1. Update `sonner.tsx` with variant-specific classNames

In `src/renderer/src/components/ui/sonner.tsx`, update the `<Sonner>` component's `toastOptions` to include variant-specific class names:

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

#### 2. Add icons to toast wrapper functions in `toast.ts`

In `src/renderer/src/lib/toast.ts`, update each variant to include a lucide-react icon via `createElement`:

```typescript
import { createElement } from 'react'
import { CheckCircle2, XCircle, Info as InfoIcon, AlertTriangle } from 'lucide-react'

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
    icon: createElement(InfoIcon, { className: 'h-4 w-4 text-blue-500' }),
    ...options
  })
},
warning: (message: string, options?: ToastOptions) => {
  return sonnerToast.warning(message, {
    duration: 4000,
    icon: createElement(AlertTriangle, { className: 'h-4 w-4 text-amber-500' }),
    ...options
  })
}
```

#### 3. Audit and replace direct `sonner` imports

Search the codebase for `import { toast } from 'sonner'` or `import { toast as ... } from 'sonner'`. Replace each with `import { toast } from '@/lib/toast'`. Categorize each existing call as success, error, info, or warning based on context.

### Key Files

- `src/renderer/src/components/ui/sonner.tsx` — variant-specific classNames
- `src/renderer/src/lib/toast.ts` — icons per variant
- Multiple component files — replace direct `sonner` imports

### Definition of Done

- [ ] Success toasts have a green left border and green CheckCircle2 icon
- [ ] Error toasts have a red left border and red XCircle icon
- [ ] Info toasts have a blue left border and blue Info icon
- [ ] Warning toasts have an amber left border and amber AlertTriangle icon
- [ ] All component files import `toast` from `@/lib/toast`, not directly from `sonner`
- [ ] Existing toast functionality (retry buttons, domain helpers) is unaffected
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Trigger a success toast (e.g., copy branch name) — verify green left border and green icon
2. Trigger an error toast (e.g., invalid git operation) — verify red left border and red icon
3. Trigger an info toast (if any exist) — verify blue styling
4. Verify toasts auto-dismiss at correct durations (3s success, 5s error)
5. Verify retry button on error toasts still works

### Testing Criteria

```typescript
// test/phase-17/session-1/toast-variants.test.ts
describe('Session 1: Toast Variants', () => {
  test('toast.success calls sonnerToast.success with green icon', () => {
    // Spy on sonnerToast.success
    // Call toast.success('Done')
    // Verify called with icon containing CheckCircle2 props
  })

  test('toast.error calls sonnerToast.error with red icon', () => {
    // Spy on sonnerToast.error
    // Call toast.error('Failed')
    // Verify called with icon containing XCircle props
  })

  test('toast.info calls sonnerToast.info with blue icon', () => {
    // Similar verification for info
  })

  test('toast.warning calls sonnerToast.warning with amber icon', () => {
    // Similar verification for warning
  })

  test('toast.error with retry passes action button', () => {
    // Call toast.error('Failed', { retry: mockFn })
    // Verify action button is included in options
  })
})
```

---

## Session 2: Tab Loading Indicator Fix

### Objectives

- Extend the tab bar spinner to show for `'planning'` status (not just `'working'`)
- Add icon for `'answering'` status in tabs
- Add icon for `'completed'` status in tabs (for Feature 2)
- Align tab indicators with sidebar indicators for consistency

### Tasks

#### 1. Update `SessionTabs.tsx` indicator rendering

In `src/renderer/src/components/sessions/SessionTabs.tsx`, replace the existing `sessionStatus === 'working'` spinner block (lines 110-121) with a comprehensive set of indicators:

```tsx
{
  ;(sessionStatus === 'working' || sessionStatus === 'planning') && (
    <Loader2
      className={cn(
        'h-3 w-3 animate-spin flex-shrink-0',
        sessionStatus === 'planning' ? 'text-blue-400' : 'text-blue-500'
      )}
      data-testid={`tab-spinner-${sessionId}`}
    />
  )
}
{
  sessionStatus === 'answering' && <AlertCircle className="h-3 w-3 text-amber-500 flex-shrink-0" />
}
{
  sessionStatus === 'completed' && <Check className="h-3 w-3 text-green-500 flex-shrink-0" />
}
{
  sessionStatus === 'unread' && !isActive && (
    <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
  )
}
```

Add imports for `AlertCircle`, `Check`, and `cn`.

### Key Files

- `src/renderer/src/components/sessions/SessionTabs.tsx` — extend indicator rendering

### Definition of Done

- [ ] Tab spinner shows for both `'working'` (blue-500) and `'planning'` (blue-400) statuses
- [ ] Tab shows amber AlertCircle icon for `'answering'` status
- [ ] Tab shows green Check icon for `'completed'` status (will be used by Feature 2)
- [ ] Tab shows blue dot for `'unread'` status on inactive tabs (existing behavior preserved)
- [ ] No indicator shown when status is `null` (existing behavior preserved)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Start a session in plan mode — verify blue-400 spinner appears in the tab
2. Start a session in build mode — verify blue-500 spinner appears
3. Trigger a question (answering state) — verify amber icon in tab
4. Observe sidebar and tab bar are in sync for all statuses

### Testing Criteria

```typescript
// test/phase-17/session-2/tab-loading-indicator.test.tsx
describe('Session 2: Tab Loading Indicator Fix', () => {
  test('spinner shows for working status', () => {
    // Mock sessionStatuses[id] = { status: 'working' }
    // Render tab, verify Loader2 with text-blue-500
  })

  test('spinner shows for planning status with different color', () => {
    // Mock sessionStatuses[id] = { status: 'planning' }
    // Render tab, verify Loader2 with text-blue-400
  })

  test('AlertCircle shows for answering status', () => {
    // Mock sessionStatuses[id] = { status: 'answering' }
    // Render tab, verify AlertCircle with text-amber-500
  })

  test('Check shows for completed status', () => {
    // Mock sessionStatuses[id] = { status: 'completed' }
    // Render tab, verify Check with text-green-500
  })

  test('blue dot shows for unread on inactive tab', () => {
    // Mock sessionStatuses[id] = { status: 'unread' }, isActive: false
    // Verify blue dot renders
  })

  test('no indicator for null status', () => {
    // Mock no status entry
    // Verify no spinner, icon, or dot
  })
})
```

---

## Session 3: Plan Mode Badge

### Objectives

- Extract `PLAN_MODE_PREFIX` to a shared constants file
- Strip the prefix from user messages at render time in `MessageRenderer.tsx`
- Show a styled "PLANNER" badge on user messages that had the prefix

### Tasks

#### 1. Create shared constant

Create or add to `src/renderer/src/lib/constants.ts`:

```typescript
export const PLAN_MODE_PREFIX =
  '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'
```

#### 2. Update `SessionView.tsx` to import from shared location

In `src/renderer/src/components/sessions/SessionView.tsx`, remove the local `PLAN_MODE_PREFIX` constant (lines 30-31) and `stripPlanModePrefix` function (lines 56-61). Import from the shared location:

```typescript
import { PLAN_MODE_PREFIX } from '@/lib/constants'
```

Keep `stripPlanModePrefix` as a local helper or move it to the constants file.

#### 3. Strip prefix and show badge in `MessageRenderer.tsx`

In `src/renderer/src/components/sessions/MessageRenderer.tsx`, where user messages are rendered (likely `UserBubble` or equivalent), add prefix detection and stripping:

```typescript
import { PLAN_MODE_PREFIX } from '@/lib/constants'

// Inside the user message rendering:
const isPlanMode = message.content.startsWith(PLAN_MODE_PREFIX)
const displayContent = isPlanMode
  ? message.content.slice(PLAN_MODE_PREFIX.length)
  : message.content

// Render:
return (
  <div className="...">
    {isPlanMode && (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-blue-500/15 text-blue-400 mb-1">
        PLANNER
      </span>
    )}
    <MarkdownRenderer content={displayContent} />
  </div>
)
```

### Key Files

- `src/renderer/src/lib/constants.ts` — new or existing file, export `PLAN_MODE_PREFIX`
- `src/renderer/src/components/sessions/SessionView.tsx` — import from shared location
- `src/renderer/src/components/sessions/MessageRenderer.tsx` — strip prefix, render badge

### Definition of Done

- [ ] `PLAN_MODE_PREFIX` is defined in one shared location and imported everywhere
- [ ] User messages loaded from the database that contain the prefix have it stripped at render time
- [ ] A "PLANNER" badge (blue pill) appears above the cleaned message content
- [ ] Messages without the prefix are unaffected
- [ ] The stored message content is NOT modified — stripping is render-only
- [ ] `stripPlanModePrefix` used for undo prompt restoration still works
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Send a message in plan mode, wait for finalization
2. After finalization reloads messages from DB — verify the prefix is stripped and "PLANNER" badge appears
3. Send a message in build mode — verify no badge, no stripping
4. Use `/undo` after a plan-mode message — verify prompt restoration still strips prefix correctly

### Testing Criteria

```typescript
// test/phase-17/session-3/plan-mode-badge.test.tsx
describe('Session 3: Plan Mode Badge', () => {
  test('PLAN_MODE_PREFIX is exported from constants', () => {
    expect(PLAN_MODE_PREFIX).toContain('[Mode: Plan]')
  })

  test('user message with prefix shows PLANNER badge', () => {
    // Render UserBubble with content starting with PLAN_MODE_PREFIX
    // Verify badge element with text "PLANNER" is rendered
    // Verify the prefix text is NOT in the rendered output
  })

  test('user message without prefix shows no badge', () => {
    // Render UserBubble with normal content
    // Verify no PLANNER badge
    // Verify full content is rendered
  })

  test('only the prefix is stripped, user content preserved', () => {
    const content = PLAN_MODE_PREFIX + 'How do we implement this?'
    // Render UserBubble with content
    // Verify "How do we implement this?" is rendered
    // Verify prefix text is not visible
  })
})
```

---

## Session 4: Git Refresh on Window Focus

### Objectives

- Emit an IPC event from the main process when the BrowserWindow gains focus
- Expose the event in the preload bridge
- Subscribe in the renderer and trigger a throttled git status refresh

### Tasks

#### 1. Add focus event emission in main process

In `src/main/index.ts`, after the `mainWindow` is created (inside the `createWindow` function or after `mainWindow = new BrowserWindow(...)`), add:

```typescript
mainWindow.on('focus', () => {
  mainWindow.webContents.send('app:windowFocused')
})
```

#### 2. Expose in preload

In `src/preload/index.ts`, add to the appropriate namespace (likely a new section near the existing system/app operations):

```typescript
onWindowFocused: (callback: () => void) => {
  const handler = () => callback()
  ipcRenderer.on('app:windowFocused', handler)
  return () => ipcRenderer.removeListener('app:windowFocused', handler)
}
```

#### 3. Add type declaration

In `src/preload/index.d.ts`, add to the appropriate interface:

```typescript
onWindowFocused(callback: () => void): () => void
```

#### 4. Subscribe in renderer

In `src/renderer/src/components/layout/AppLayout.tsx`, add a `useEffect` that subscribes to focus events and triggers a throttled git refresh:

```typescript
useEffect(() => {
  let lastRefreshTime = 0
  const THROTTLE_MS = 2000

  const unsubscribe = window.app.onWindowFocused(() => {
    const now = Date.now()
    if (now - lastRefreshTime < THROTTLE_MS) return
    lastRefreshTime = now
    useGitStore.getState().refreshStatuses()
  })

  return unsubscribe
}, [])
```

### Key Files

- `src/main/index.ts` — emit `app:windowFocused` on window focus
- `src/preload/index.ts` — expose `onWindowFocused`
- `src/preload/index.d.ts` — type declaration
- `src/renderer/src/components/layout/AppLayout.tsx` — subscribe and trigger refresh

### Definition of Done

- [ ] Switching back to Hive from another app triggers a git status refresh
- [ ] The refresh is throttled to once every 2 seconds (no spam on rapid focus toggling)
- [ ] `useGitStore.refreshStatuses()` is called (already debounced at 150ms internally)
- [ ] The preload listener properly cleans up on unsubscribe
- [ ] No errors when the window gains focus with no projects open
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Open Hive, expand a project with worktrees showing the git changes sidebar
2. Switch to a terminal, run `git add .` or make a file change
3. Switch back to Hive — verify the changes sidebar updates within ~2 seconds
4. Rapidly alt-tab between Hive and another app — verify no excessive refreshes

### Testing Criteria

```typescript
// test/phase-17/session-4/git-focus-refresh.test.ts
describe('Session 4: Git Refresh on Focus', () => {
  test('onWindowFocused callback fires on app:windowFocused event', () => {
    const callback = vi.fn()
    // Mock ipcRenderer.on for 'app:windowFocused'
    // Register callback
    // Emit the event
    // Verify callback called
  })

  test('unsubscribe removes the listener', () => {
    const callback = vi.fn()
    // Register and get unsubscribe function
    // Call unsubscribe
    // Emit event
    // Verify callback NOT called
  })

  test('throttle prevents rapid successive refreshes', () => {
    // Simulate 5 focus events within 1 second
    // Verify refreshStatuses called only once
  })

  test('throttle allows refresh after 2 seconds', () => {
    // Simulate focus event, advance time by 2001ms, simulate another
    // Verify refreshStatuses called twice
  })
})
```

---

## Session 5: Persist Default Variant per Model

### Objectives

- Add `modelVariantDefaults` map to `useSettingsStore` for per-model variant memory
- Persist the map to SQLite via the existing `saveToDatabase()` flow
- Update `ModelSelector` to read remembered variant on model select and persist on variant change

### Tasks

#### 1. Add `modelVariantDefaults` to settings store

In `src/renderer/src/stores/useSettingsStore.ts`:

Add to the state:

```typescript
modelVariantDefaults: Record<string, string> // "providerID::modelID" → variant
```

Add actions:

```typescript
setModelVariantDefault: (providerID: string, modelID: string, variant: string) => {
  const key = `${providerID}::${modelID}`
  const updated = { ...get().modelVariantDefaults, [key]: variant }
  set({ modelVariantDefaults: updated })
  const settings = extractSettings({ ...get(), modelVariantDefaults: updated } as SettingsState)
  saveToDatabase(settings)
},

getModelVariantDefault: (providerID: string, modelID: string) => {
  const key = `${providerID}::${modelID}`
  return get().modelVariantDefaults[key]
}
```

Add `modelVariantDefaults` to `extractSettings`, `DEFAULT_SETTINGS` (default `{}`), and the Zustand persist `partialize`.

#### 2. Update `ModelSelector.tsx` to use remembered variants

In `handleSelectModel`:

```typescript
function handleSelectModel(model: ModelInfo): void {
  const variantKeys = getVariantKeys(model)
  const remembered = useSettingsStore.getState().getModelVariantDefault(model.providerID, model.id)
  const variant =
    remembered && variantKeys.includes(remembered)
      ? remembered
      : variantKeys.length > 0
        ? variantKeys[0]
        : undefined
  setSelectedModel({ providerID: model.providerID, modelID: model.id, variant })
}
```

In `handleSelectVariant`, persist the choice:

```typescript
function handleSelectVariant(model: ModelInfo, variant: string): void {
  useSettingsStore.getState().setModelVariantDefault(model.providerID, model.id, variant)
  setSelectedModel({ providerID: model.providerID, modelID: model.id, variant })
}
```

Also update the Alt+T variant cycling to persist:

```typescript
// After cycling to new variant:
useSettingsStore.getState().setModelVariantDefault(providerID, modelID, newVariant)
```

### Key Files

- `src/renderer/src/stores/useSettingsStore.ts` — add `modelVariantDefaults`, getter/setter
- `src/renderer/src/components/sessions/ModelSelector.tsx` — read/persist variant defaults

### Definition of Done

- [ ] Selecting a model remembers the last-used variant for that model
- [ ] Switching to model A (variant high), then model B, then back to model A restores "high"
- [ ] Variant defaults persist across app restarts (stored in SQLite via `saveToDatabase`)
- [ ] If a remembered variant is no longer available (model changed), falls back to first variant
- [ ] Alt+T cycling also persists the selected variant
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Select `claude-opus-4-5`, change variant to "high"
2. Switch to `codex-mini`, then back to `claude-opus-4-5` — verify variant is "high" not first default
3. Restart the app — verify `claude-opus-4-5` still defaults to "high"
4. Use Alt+T to cycle variant — switch away and back — verify cycled variant persists

### Testing Criteria

```typescript
// test/phase-17/session-5/variant-persistence.test.ts
describe('Session 5: Variant Persistence', () => {
  test('setModelVariantDefault stores variant for model key', () => {
    const store = useSettingsStore.getState()
    store.setModelVariantDefault('anthropic', 'claude-opus-4-5', 'high')
    expect(store.getModelVariantDefault('anthropic', 'claude-opus-4-5')).toBe('high')
  })

  test('getModelVariantDefault returns undefined for unknown model', () => {
    expect(useSettingsStore.getState().getModelVariantDefault('x', 'y')).toBeUndefined()
  })

  test('modelVariantDefaults included in extractSettings', () => {
    // Set a variant default
    // Verify extractSettings output includes modelVariantDefaults
  })

  test('handleSelectModel uses remembered variant when available', () => {
    // Set remembered variant 'high' for model
    // Call handleSelectModel with that model
    // Verify setSelectedModel called with variant: 'high'
  })

  test('handleSelectModel falls back to first variant when remembered is invalid', () => {
    // Set remembered variant 'deleted' for model (not in variantKeys)
    // Call handleSelectModel
    // Verify setSelectedModel called with first variant key, not 'deleted'
  })
})
```

---

## Session 6: Completion Badge — Store Layer

### Objectives

- Extend `SessionStatus` type with `'completed'` variant
- Add metadata fields (`word`, `durationMs`) to the session status entries
- Create `formatCompletionDuration` utility
- Define the `COMPLETION_WORDS` pool

### Tasks

#### 1. Extend `useWorktreeStatusStore.ts`

Update the session status type and entry structure:

```typescript
type SessionStatus = 'working' | 'planning' | 'answering' | 'unread' | 'completed'

interface SessionStatusEntry {
  status: SessionStatus
  word?: string
  durationMs?: number
}
```

Update `setSessionStatus` to accept optional metadata:

```typescript
setSessionStatus: (
  sessionId: string,
  status: SessionStatus,
  metadata?: { word?: string; durationMs?: number }
) => {
  set((state) => ({
    sessionStatuses: {
      ...state.sessionStatuses,
      [sessionId]: { status, ...metadata }
    }
  }))
}
```

Update `getWorktreeStatus` to include `'completed'` in the priority chain (lowest active priority, above `'unread'`).

#### 2. Create `formatCompletionDuration` utility

Add to `src/renderer/src/lib/format-utils.ts` (or create if it doesn't exist):

```typescript
export function formatCompletionDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return `${hours}h`
}

export const COMPLETION_WORDS = [
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
```

### Key Files

- `src/renderer/src/stores/useWorktreeStatusStore.ts` — extend type, metadata support
- `src/renderer/src/lib/format-utils.ts` — `formatCompletionDuration`, `COMPLETION_WORDS`

### Definition of Done

- [ ] `SessionStatus` type includes `'completed'`
- [ ] `setSessionStatus` accepts optional `word` and `durationMs` metadata
- [ ] `sessionStatuses` entries store the full `SessionStatusEntry` object
- [ ] `formatCompletionDuration` correctly formats: 23000→`"23s"`, 120000→`"2m"`, 3600000→`"1h"`
- [ ] `COMPLETION_WORDS` contains 10 fun words
- [ ] `getWorktreeStatus` aggregation handles `'completed'` correctly
- [ ] All existing status consumers (`WorktreeItem`, `SessionTabs`, etc.) are unbroken
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-17/session-6/completion-badge-store.test.ts
describe('Session 6: Completion Badge Store', () => {
  test('setSessionStatus stores completed with metadata', () => {
    const store = useWorktreeStatusStore.getState()
    store.setSessionStatus('s1', 'completed', { word: 'Brewed', durationMs: 23000 })
    expect(store.sessionStatuses['s1']).toEqual({
      status: 'completed',
      word: 'Brewed',
      durationMs: 23000
    })
  })

  test('setSessionStatus works without metadata (backward compat)', () => {
    const store = useWorktreeStatusStore.getState()
    store.setSessionStatus('s1', 'working')
    expect(store.sessionStatuses['s1']).toEqual({ status: 'working' })
  })

  test('formatCompletionDuration formats seconds', () => {
    expect(formatCompletionDuration(23000)).toBe('23s')
    expect(formatCompletionDuration(500)).toBe('1s')
  })

  test('formatCompletionDuration formats minutes', () => {
    expect(formatCompletionDuration(120000)).toBe('2m')
    expect(formatCompletionDuration(90000)).toBe('2m')
  })

  test('formatCompletionDuration formats hours', () => {
    expect(formatCompletionDuration(3600000)).toBe('1h')
    expect(formatCompletionDuration(7200000)).toBe('2h')
  })

  test('COMPLETION_WORDS has at least 10 entries', () => {
    expect(COMPLETION_WORDS.length).toBeGreaterThanOrEqual(10)
  })
})
```

---

## Session 7: Completion Badge — UI Integration

### Objectives

- Track streaming start time in `SessionView.tsx`
- On streaming completion, set `'completed'` status with random word and duration
- Auto-clear after 30 seconds
- Render the badge in `WorktreeItem.tsx` with checkmark icon and green text
- Handle background session completion in `useOpenCodeGlobalListener.ts`

### Tasks

#### 1. Track streaming start time in `SessionView.tsx`

Add a ref to track when streaming started:

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

#### 2. Set completed status on finalization

In the idle/finalization path (where `clearSessionStatus` or `setSessionStatus('unread')` is currently called), replace with:

```typescript
const durationMs = streamingStartTimeRef.current ? Date.now() - streamingStartTimeRef.current : 0
streamingStartTimeRef.current = null

const word = COMPLETION_WORDS[Math.floor(Math.random() * COMPLETION_WORDS.length)]

if (activeId === sessionId) {
  statusStore.setSessionStatus(sessionId, 'completed', { word, durationMs })
} else {
  statusStore.setSessionStatus(sessionId, 'completed', { word, durationMs })
}

// Auto-clear after 30 seconds
setTimeout(() => {
  const current = statusStore.sessionStatuses[sessionId]
  if (current?.status === 'completed') {
    statusStore.clearSessionStatus(sessionId)
  }
}, 30_000)
```

#### 3. Handle background completion in global listener

In `useOpenCodeGlobalListener.ts`, when a background session goes idle, also set completed status (with estimated duration if available, or 0):

```typescript
if (status?.type === 'idle' && sessionId !== activeId) {
  const word = COMPLETION_WORDS[Math.floor(Math.random() * COMPLETION_WORDS.length)]
  useWorktreeStatusStore
    .getState()
    .setSessionStatus(sessionId, 'completed', { word, durationMs: 0 })

  setTimeout(() => {
    const current = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
    if (current?.status === 'completed') {
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'unread')
    }
  }, 30_000)
}
```

#### 4. Render in `WorktreeItem.tsx`

Update the status text derivation (lines 96-104) to include completed:

```typescript
: worktreeStatus === 'completed'
  ? {
      displayStatus: `${statusEntry?.word ?? 'Worked'} for ${formatCompletionDuration(statusEntry?.durationMs ?? 0)}`,
      statusClass: 'font-semibold text-green-500'
    }
```

Add checkmark icon in the icon section:

```typescript
{worktreeStatus === 'completed' && (
  <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
)}
```

### Key Files

- `src/renderer/src/components/sessions/SessionView.tsx` — track start time, set completed
- `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` — background completion
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — render badge

### Definition of Done

- [ ] After streaming finishes, sidebar shows "{Word} for {duration}" in green with checkmark
- [ ] The word is randomly chosen from the pool (different each time)
- [ ] Duration accurately reflects time from first busy to idle
- [ ] Badge auto-clears after 30 seconds, reverting to "Ready"
- [ ] Background sessions also show the completion badge
- [ ] Starting a new prompt clears any existing completion badge
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-17/session-7/completion-badge-ui.test.tsx
describe('Session 7: Completion Badge UI', () => {
  test('WorktreeItem renders completion text with word and duration', () => {
    // Mock sessionStatuses[id] = { status: 'completed', word: 'Brewed', durationMs: 23000 }
    // Render WorktreeItem
    // Verify text contains "Brewed for 23s"
    // Verify Check icon is rendered
  })

  test('completion badge auto-clears after 30 seconds', () => {
    // Set completed status
    // Advance timers by 30001ms
    // Verify clearSessionStatus was called
  })

  test('starting new streaming clears completion badge', () => {
    // Set completed status
    // Fire session.status busy
    // Verify status transitions to 'working'
  })
})
```

---

## Session 8: Per-Session Model — Schema & Backend

### Objectives

- Add database migration v11 with model columns on the sessions table
- Update session CRUD in `database.ts` to handle the new columns
- Update preload bridge and type declarations

### Tasks

#### 1. Add migration v11 to `schema.ts`

In `src/main/db/schema.ts`, bump `CURRENT_SCHEMA_VERSION` to 11 and add migration:

```typescript
{
  version: 11,
  name: 'add_session_model_columns',
  up: `
    ALTER TABLE sessions ADD COLUMN model_provider_id TEXT;
    ALTER TABLE sessions ADD COLUMN model_id TEXT;
    ALTER TABLE sessions ADD COLUMN model_variant TEXT;
  `,
  down: ''
}
```

#### 2. Update `database.ts` session CRUD

In `src/main/db/database.ts`, update the `create` and `update` methods for sessions to include the new columns in INSERT and UPDATE statements.

#### 3. Update type declarations

In `src/preload/index.d.ts`, add to the `Session` interface:

```typescript
model_provider_id: string | null
model_id: string | null
model_variant: string | null
```

Update `SessionCreate` type to include optional model fields.

#### 4. Update preload bridge

Ensure `window.db.session.create()` and `window.db.session.update()` pass through the new model fields.

### Key Files

- `src/main/db/schema.ts` — migration v11
- `src/main/db/database.ts` — session CRUD updates
- `src/preload/index.d.ts` — Session type + SessionCreate type
- `src/preload/index.ts` — ensure model fields pass through

### Definition of Done

- [ ] Migration v11 adds three nullable columns to sessions table
- [ ] `CURRENT_SCHEMA_VERSION` is 11
- [ ] `window.db.session.create()` accepts optional model fields
- [ ] `window.db.session.update()` can update model fields
- [ ] Existing sessions without model fields work (columns nullable)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-17/session-8/per-session-model-schema.test.ts
describe('Session 8: Per-Session Model Schema', () => {
  test('Session type includes model fields', () => {
    // TypeScript compilation validates this
    const session: Session = {
      // ... required fields
      model_provider_id: 'anthropic',
      model_id: 'claude-opus-4-5',
      model_variant: 'high'
    }
    expect(session.model_id).toBe('claude-opus-4-5')
  })

  test('Session type allows null model fields', () => {
    const session: Session = {
      // ... required fields
      model_provider_id: null,
      model_id: null,
      model_variant: null
    }
    expect(session.model_id).toBeNull()
  })
})
```

---

## Session 9: Per-Session Model — Frontend Integration

### Objectives

- Add `setSessionModel` action to `useSessionStore`
- Update `ModelSelector.tsx` to read/write from session instead of global store
- Push session model to OpenCode on tab switch
- Default new sessions to last session's model or global default

### Tasks

#### 1. Add `setSessionModel` to `useSessionStore.ts`

```typescript
setSessionModel: async (sessionId: string, model: SelectedModel) => {
  set((state) => {
    const sessions = new Map(state.sessions)
    const session = sessions.get(sessionId)
    if (session) {
      sessions.set(sessionId, {
        ...session,
        model_provider_id: model.providerID,
        model_id: model.modelID,
        model_variant: model.variant ?? null
      })
    }
    return { sessions }
  })

  await window.db.session.update(sessionId, {
    model_provider_id: model.providerID,
    model_id: model.modelID,
    model_variant: model.variant ?? null
  })

  await window.opencodeOps.setModel(model)
  useSettingsStore.getState().setSelectedModel(model)
}
```

#### 2. Update `ModelSelector.tsx`

Pass `sessionId` as a prop. Read from session store with global fallback:

```typescript
const session = useSessionStore((state) => state.sessions.get(sessionId))
const selectedModel = session?.model_id
  ? {
      providerID: session.model_provider_id!,
      modelID: session.model_id,
      variant: session.model_variant ?? undefined
    }
  : useSettingsStore((state) => state.selectedModel)
```

Write to session store:

```typescript
function handleSelectModel(model: ModelInfo): void {
  const variantKeys = getVariantKeys(model)
  const remembered = useSettingsStore.getState().getModelVariantDefault(model.providerID, model.id)
  const variant = remembered && variantKeys.includes(remembered) ? remembered : variantKeys[0]
  useSessionStore
    .getState()
    .setSessionModel(sessionId, { providerID: model.providerID, modelID: model.id, variant })
}
```

#### 3. Push model on tab switch in `SessionView.tsx`

```typescript
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

#### 4. Default new sessions to last model

In `createSession` action, before creating the session, determine the default model from the last session in the same worktree or the global setting.

### Key Files

- `src/renderer/src/stores/useSessionStore.ts` — `setSessionModel`, `createSession` defaults
- `src/renderer/src/components/sessions/ModelSelector.tsx` — per-session read/write
- `src/renderer/src/components/sessions/SessionView.tsx` — push model on tab switch

### Definition of Done

- [ ] Each session independently stores its model selection
- [ ] Changing model in Tab A does not change model in Tab B
- [ ] Switching between tabs pushes the correct model to OpenCode
- [ ] New sessions default to the last session's model in the same worktree
- [ ] If no previous session exists, falls back to global `useSettingsStore.selectedModel`
- [ ] Model selection persists to SQLite and survives app restart
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create two sessions in the same worktree
2. Set Session A to `claude-opus-4-5` and Session B to `codex-mini`
3. Switch between tabs — verify the model selector shows the correct model per tab
4. Create a new Session C — verify it defaults to Session B's model (last created)
5. Restart the app — verify all sessions retain their model selections

### Testing Criteria

```typescript
// test/phase-17/session-9/per-session-model-frontend.test.tsx
describe('Session 9: Per-Session Model Frontend', () => {
  test('setSessionModel updates session in store', () => {
    // Create a session, call setSessionModel
    // Verify session.model_id is updated
  })

  test('setSessionModel persists to database', () => {
    // Spy on window.db.session.update
    // Call setSessionModel
    // Verify update called with model fields
  })

  test('setSessionModel pushes to OpenCode', () => {
    // Spy on window.opencodeOps.setModel
    // Call setSessionModel
    // Verify setModel called with correct SelectedModel
  })

  test('ModelSelector reads from session, not global', () => {
    // Set session model to X, global model to Y
    // Verify ModelSelector shows X
  })

  test('new session defaults to last session model', () => {
    // Create session A with model X
    // Create session B in same worktree
    // Verify session B has model X
  })
})
```

---

## Session 10: Default Commit Message — Backend

### Objectives

- Add migration v12 with `session_titles` column on the worktrees table
- Add `appendSessionTitle` method to the database service
- Add IPC handler and preload bridge for the new endpoint
- Track title changes in `useSessionStore` and `SessionView`

### Tasks

#### 1. Add migration v12

In `src/main/db/schema.ts`, bump `CURRENT_SCHEMA_VERSION` to 12:

```typescript
{
  version: 12,
  name: 'add_worktree_session_titles',
  up: `ALTER TABLE worktrees ADD COLUMN session_titles TEXT DEFAULT '[]';`,
  down: ''
}
```

Note: If session 8 already bumped to v11, this becomes v12. If both migrations are added in the same schema file, ensure version numbers are sequential.

#### 2. Add database method

In `src/main/db/database.ts`, add `appendSessionTitle`:

```typescript
appendSessionTitle(worktreeId: string, title: string): void {
  const row = this.db.prepare('SELECT session_titles FROM worktrees WHERE id = ?').get(worktreeId)
  const titles: string[] = JSON.parse((row as any)?.session_titles || '[]')
  if (!titles.includes(title)) {
    titles.push(title)
    this.db.prepare('UPDATE worktrees SET session_titles = ? WHERE id = ?')
      .run(JSON.stringify(titles), worktreeId)
  }
}
```

#### 3. Add IPC handler

In `src/main/ipc/database-handlers.ts`:

```typescript
ipcMain.handle('db:worktree:appendSessionTitle', async (_event, { worktreeId, title }) => {
  try {
    db.appendSessionTitle(worktreeId, title)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})
```

#### 4. Add preload bridge and types

In `src/preload/index.ts`, add to `db.worktree`:

```typescript
appendSessionTitle: (worktreeId: string, title: string) =>
  ipcRenderer.invoke('db:worktree:appendSessionTitle', { worktreeId, title })
```

In `src/preload/index.d.ts`, add to the worktree interface:

```typescript
appendSessionTitle(worktreeId: string, title: string): Promise<{ success: boolean; error?: string }>
```

#### 5. Track title changes

In `useSessionStore.ts` `updateSessionName` action, after the existing update logic, append non-default titles:

```typescript
const isDefault = /^New session - \d{4}-/.test(name)
if (!isDefault) {
  const session = get().sessions.get(sessionId)
  if (session?.worktree_id) {
    await window.db.worktree.appendSessionTitle(session.worktree_id, name)
  }
}
```

In `SessionView.tsx`, where auto-titles from SDK events are handled, also append:

```typescript
if (event.session.title && event.session.title !== currentSession?.name) {
  // ... existing name update ...
  const isDefault = /^New session - \d{4}-/.test(event.session.title)
  if (!isDefault && worktreeId) {
    window.db.worktree.appendSessionTitle(worktreeId, event.session.title)
  }
}
```

### Key Files

- `src/main/db/schema.ts` — migration v12
- `src/main/db/database.ts` — `appendSessionTitle` method
- `src/main/ipc/database-handlers.ts` — IPC handler
- `src/preload/index.ts` — bridge method
- `src/preload/index.d.ts` — type declarations
- `src/renderer/src/stores/useSessionStore.ts` — track in `updateSessionName`
- `src/renderer/src/components/sessions/SessionView.tsx` — track auto-titles

### Definition of Done

- [ ] `session_titles` column exists on worktrees table (JSON array string)
- [ ] Renaming a session appends the new title to the worktree's `session_titles`
- [ ] Auto-titles from OpenCode SDK are also tracked
- [ ] Default timestamp names (`"New session - 2025-..."`) are NOT tracked
- [ ] Duplicate titles are not added
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-17/session-10/commit-message-backend.test.ts
describe('Session 10: Default Commit Message Backend', () => {
  test('appendSessionTitle adds title to empty array', () => {
    // Mock db.prepare to return session_titles: '[]'
    // Call appendSessionTitle('wt-1', 'Add feature X')
    // Verify UPDATE called with '["Add feature X"]'
  })

  test('appendSessionTitle skips duplicates', () => {
    // Mock db.prepare to return session_titles: '["Add feature X"]'
    // Call appendSessionTitle('wt-1', 'Add feature X')
    // Verify UPDATE NOT called
  })

  test('default session names are not tracked', () => {
    // Call updateSessionName with 'New session - 2025-01-01T00:00:00.000Z'
    // Verify appendSessionTitle NOT called
  })

  test('meaningful session names are tracked', () => {
    // Call updateSessionName with 'Implement dark mode'
    // Verify appendSessionTitle called with the title
  })
})
```

---

## Session 11: Default Commit Message — Frontend

### Objectives

- Pre-populate `GitCommitForm` summary and description from worktree session titles
- Summary defaults to first title, description to bullet-point list of all titles
- Only populate on mount when fields are empty

### Tasks

#### 1. Update `GitCommitForm.tsx`

Add session titles reading:

```typescript
const sessionTitles: string[] = useMemo(() => {
  try {
    return JSON.parse(worktree?.session_titles || '[]')
  } catch {
    return []
  }
}, [worktree?.session_titles])
```

Pre-populate on mount:

```typescript
useEffect(() => {
  if (sessionTitles.length > 0 && !summary) {
    setSummary(sessionTitles[0])
    if (sessionTitles.length > 1) {
      setDescription(sessionTitles.map((t) => `- ${t}`).join('\n'))
    }
  }
}, []) // Only on mount — do not re-populate on title changes
```

Ensure the `Worktree` type in the renderer includes `session_titles`.

### Key Files

- `src/renderer/src/components/git/GitCommitForm.tsx` — pre-populate from session titles

### Definition of Done

- [ ] Commit form summary is pre-populated with the first session title
- [ ] Commit form description is pre-populated with all titles as bullet points
- [ ] User can freely edit both fields after pre-population
- [ ] Fields are not overwritten if user has already typed something
- [ ] If no session titles exist, fields remain empty (current behavior)
- [ ] Character counter and warnings still work correctly with pre-populated text
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a worktree, start a session, send a message (auto-title generates)
2. Start another session, let it also get a title
3. Stage some files, open the commit form
4. Verify summary = first session title, description = bullet list of all titles
5. Edit the summary — verify it stays edited (no re-population)
6. On a worktree with no session titles — verify empty form

### Testing Criteria

```typescript
// test/phase-17/session-11/commit-message-frontend.test.tsx
describe('Session 11: Default Commit Message Frontend', () => {
  test('summary pre-populates with first session title', () => {
    // Mock worktree.session_titles = '["Add feature", "Fix bug"]'
    // Render GitCommitForm
    // Verify summary input value is "Add feature"
  })

  test('description pre-populates with bullet list', () => {
    // Mock worktree.session_titles = '["Add feature", "Fix bug"]'
    // Render GitCommitForm
    // Verify description contains "- Add feature\n- Fix bug"
  })

  test('empty session_titles leaves form empty', () => {
    // Mock worktree.session_titles = '[]'
    // Render GitCommitForm
    // Verify summary and description are empty
  })

  test('does not overwrite user edits', () => {
    // Render GitCommitForm, type into summary
    // Re-render (simulate) — verify user text preserved
  })
})
```

---

## Session 12: Diff File Tabs — Store Layer

### Objectives

- Add `DiffTab` type to `useFileViewerStore`
- Update `setActiveDiff` to also create a tab entry in `openFiles`
- Add a method to activate a diff tab by its key

### Tasks

#### 1. Extend `useFileViewerStore.ts` types

```typescript
interface DiffTab {
  type: 'diff'
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
}

type TabEntry = FileViewerTab | DiffTab
```

Update `openFiles: Map<string, TabEntry>`.

#### 2. Update `setActiveDiff` to create tab

```typescript
setActiveDiff: (diff) => {
  if (!diff) {
    set({ activeDiff: null })
    return
  }
  const tabKey = `diff:${diff.filePath}:${diff.staged ? 'staged' : 'unstaged'}`
  set((state) => {
    const openFiles = new Map(state.openFiles)
    openFiles.set(tabKey, { type: 'diff', ...diff })
    return { activeDiff: diff, activeFilePath: tabKey, openFiles }
  })
}
```

#### 3. Add `closeDiffTab` method

```typescript
closeDiffTab: (tabKey: string) => {
  set((state) => {
    const openFiles = new Map(state.openFiles)
    openFiles.delete(tabKey)
    const newActive = state.activeFilePath === tabKey ? null : state.activeFilePath
    return {
      openFiles,
      activeFilePath: newActive,
      activeDiff: newActive === null ? null : state.activeDiff
    }
  })
}
```

### Key Files

- `src/renderer/src/stores/useFileViewerStore.ts` — `DiffTab` type, tab creation in `setActiveDiff`, `closeDiffTab`

### Definition of Done

- [ ] `setActiveDiff` creates an entry in `openFiles` with key `diff:{path}:{staged|unstaged}`
- [ ] `closeDiffTab` removes the entry and clears `activeDiff` if it was active
- [ ] Multiple diff tabs can coexist (different files or same file staged vs unstaged)
- [ ] Existing file tab operations (`openFile`, `closeFile`, `setActiveFile`) are unaffected
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-17/session-12/diff-tabs-store.test.ts
describe('Session 12: Diff File Tabs Store', () => {
  test('setActiveDiff creates tab entry', () => {
    const store = useFileViewerStore.getState()
    store.setActiveDiff({
      worktreePath: '/p',
      filePath: 'a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })
    expect(store.openFiles.has('diff:a.ts:unstaged')).toBe(true)
  })

  test('setActiveDiff sets activeFilePath to tab key', () => {
    const store = useFileViewerStore.getState()
    store.setActiveDiff({
      worktreePath: '/p',
      filePath: 'a.ts',
      fileName: 'a.ts',
      staged: true,
      isUntracked: false
    })
    expect(store.activeFilePath).toBe('diff:a.ts:staged')
  })

  test('closeDiffTab removes entry and clears active', () => {
    const store = useFileViewerStore.getState()
    store.setActiveDiff({
      worktreePath: '/p',
      filePath: 'a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })
    store.closeDiffTab('diff:a.ts:unstaged')
    expect(store.openFiles.has('diff:a.ts:unstaged')).toBe(false)
    expect(store.activeFilePath).toBeNull()
  })

  test('setActiveDiff(null) clears activeDiff without removing tabs', () => {
    const store = useFileViewerStore.getState()
    store.setActiveDiff({
      worktreePath: '/p',
      filePath: 'a.ts',
      fileName: 'a.ts',
      staged: false,
      isUntracked: false
    })
    store.setActiveDiff(null)
    expect(store.activeDiff).toBeNull()
  })
})
```

---

## Session 13: Diff File Tabs — UI Integration

### Objectives

- Render diff tabs in `SessionTabs.tsx` with a distinguishing icon
- Handle tab click to activate the diff view
- Handle tab close (X button, middle-click, Cmd+W)
- Ensure switching between session tabs and diff tabs works correctly

### Tasks

#### 1. Update `SessionTabs.tsx` to render diff tabs

After the session tab loop, add diff tab rendering by iterating `openFiles` entries where `type === 'diff'`:

```tsx
{
  Array.from(openFiles.entries())
    .filter(([_, tab]) => tab.type === 'diff')
    .map(([key, tab]) => (
      <DiffTabItem
        key={key}
        tabKey={key}
        tab={tab as DiffTab}
        isActive={activeFilePath === key}
        onActivate={() => {
          useFileViewerStore.getState().setActiveFile(key)
          // Also restore activeDiff for the viewer
        }}
        onClose={() => useFileViewerStore.getState().closeDiffTab(key)}
      />
    ))
}
```

Each diff tab shows:

- `GitCompare` or `Diff` icon from lucide-react
- File name as tab text
- Tooltip with full path + "(staged)" or "(unstaged)"
- X button for close, middle-click for close

#### 2. Update Cmd+W handling

In `useKeyboardShortcuts.ts`, the existing Cmd+W handler (from Phase 15) already checks `activeFilePath` first. Since diff tabs now set `activeFilePath`, Cmd+W should close the diff tab via `closeDiffTab(activeFilePath)` when the active path starts with `diff:`.

#### 3. Coordinate with `ChangesView`

`ChangesView` already calls `setActiveDiff` — no changes needed. The store update now creates the tab automatically.

### Key Files

- `src/renderer/src/components/sessions/SessionTabs.tsx` — render diff tabs
- `src/renderer/src/hooks/useKeyboardShortcuts.ts` — handle Cmd+W for diff tabs

### Definition of Done

- [ ] Clicking a file in the changes sidebar opens a diff tab in the tab bar
- [ ] Diff tab shows a distinct icon (GitCompare or similar), filename, and close button
- [ ] Clicking a diff tab activates the diff viewer
- [ ] Clicking a session tab hides the diff and shows the session
- [ ] Cmd+W closes the active diff tab
- [ ] Middle-click closes the diff tab
- [ ] Multiple diff tabs can be open simultaneously
- [ ] Closing the last diff tab returns to the active session
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Modify a file, open the changes sidebar, click the file — verify a diff tab appears
2. Click the diff tab — verify the diff is shown
3. Click a session tab — verify the session is shown, diff tab stays in the bar
4. Click the diff tab again — verify the diff reappears
5. Press Cmd+W on a diff tab — verify it closes
6. Open multiple files from changes — verify multiple diff tabs appear

### Testing Criteria

```typescript
// test/phase-17/session-13/diff-tabs-ui.test.tsx
describe('Session 13: Diff File Tabs UI', () => {
  test('diff tab renders with correct icon and name', () => {
    // Mock openFiles with a diff tab entry
    // Render SessionTabs
    // Verify tab renders with GitCompare icon and file name
  })

  test('clicking diff tab sets it as active', () => {
    // Render with diff tab
    // Click diff tab
    // Verify setActiveFile called with tab key
  })

  test('Cmd+W closes active diff tab', () => {
    // Mock activeFilePath starting with 'diff:'
    // Fire Cmd+W shortcut
    // Verify closeDiffTab called
  })

  test('session tabs still work alongside diff tabs', () => {
    // Render with both session tabs and diff tabs
    // Click session tab — verify session activates
    // Click diff tab — verify diff activates
  })
})
```

---

## Session 14: Project Spaces — Schema, Store & Backend

### Objectives

- Add migration v13 with `spaces` and `project_spaces` tables
- Add CRUD methods for spaces in the database service
- Add IPC handlers for space operations
- Add preload bridge and type declarations
- Create `useSpaceStore` with full state management

### Tasks

#### 1. Add migration v13

In `src/main/db/schema.ts`, bump version and add:

```typescript
{
  version: 13,
  name: 'add_project_spaces',
  up: `
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
    CREATE INDEX IF NOT EXISTS idx_project_spaces_space ON project_spaces(space_id);
    CREATE INDEX IF NOT EXISTS idx_project_spaces_project ON project_spaces(project_id);
  `,
  down: ''
}
```

#### 2. Add database methods

In `src/main/db/database.ts`, add methods:

- `listSpaces()` — returns all spaces ordered by `sort_order`
- `createSpace(data)` — inserts a space, returns it
- `updateSpace(id, data)` — updates name, icon_type, icon_value, sort_order
- `deleteSpace(id)` — deletes space (CASCADE removes junction entries)
- `assignProjectToSpace(projectId, spaceId)` — INSERT OR IGNORE into project_spaces
- `removeProjectFromSpace(projectId, spaceId)` — DELETE from project_spaces
- `getProjectIdsForSpace(spaceId)` — returns project IDs for a space
- `getAllProjectSpaceAssignments()` — returns all rows from project_spaces (for bulk loading)
- `reorderSpaces(orderedIds)` — updates sort_order based on array position

#### 3. Add IPC handlers

Add handlers in `src/main/ipc/database-handlers.ts` for all space operations:

- `db:space:list`
- `db:space:create`
- `db:space:update`
- `db:space:delete`
- `db:space:assignProject`
- `db:space:removeProject`
- `db:space:getProjectIds`
- `db:space:getAllAssignments`
- `db:space:reorder`

#### 4. Add preload bridge and types

In `src/preload/index.ts`, add `db.space` namespace. In `src/preload/index.d.ts`, add `Space` type and `db.space` interface.

#### 5. Create `useSpaceStore`

Create `src/renderer/src/stores/useSpaceStore.ts`:

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
  createSpace: (name: string, iconType: string, iconValue: string) => Promise<Space | null>
  updateSpace: (id: string, data: Partial<Space>) => Promise<void>
  deleteSpace: (id: string) => Promise<void>
  setActiveSpace: (id: string | null) => void
  assignProjectToSpace: (projectId: string, spaceId: string) => Promise<void>
  removeProjectFromSpace: (projectId: string, spaceId: string) => Promise<void>
  getProjectIdsForActiveSpace: () => string[] | null // null = all
  reorderSpaces: (fromIndex: number, toIndex: number) => void
}
```

Persist `activeSpaceId` via Zustand persist.

Export from `src/renderer/src/stores/index.ts`.

### Key Files

- `src/main/db/schema.ts` — migration v13
- `src/main/db/database.ts` — space CRUD + assignment methods
- `src/main/ipc/database-handlers.ts` — 9 IPC handlers
- `src/preload/index.ts` — `db.space` namespace
- `src/preload/index.d.ts` — `Space` type, interface
- `src/renderer/src/stores/useSpaceStore.ts` — new store
- `src/renderer/src/stores/index.ts` — export

### Definition of Done

- [ ] `spaces` and `project_spaces` tables created by migration v13
- [ ] All 9 IPC handlers work correctly
- [ ] `useSpaceStore` loads spaces and assignments on `loadSpaces()`
- [ ] CRUD operations persist correctly
- [ ] `activeSpaceId` persists across app restarts
- [ ] A project can belong to multiple spaces
- [ ] Deleting a space cascades to remove junction entries
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/phase-17/session-14/spaces-schema-store.test.ts
describe('Session 14: Project Spaces Schema & Store', () => {
  test('createSpace adds space to store', async () => {
    // Mock window.db.space.create to return a space
    // Call store.createSpace('Work', 'default', 'Briefcase')
    // Verify space added to store.spaces
  })

  test('assignProjectToSpace updates projectSpaceMap', async () => {
    // Call store.assignProjectToSpace('p1', 's1')
    // Verify store.projectSpaceMap.get('p1') contains 's1'
  })

  test('setActiveSpace filters projects', () => {
    // Set up projectSpaceMap with p1→{s1}, p2→{s1, s2}, p3→{s2}
    // setActiveSpace('s1')
    // Verify getProjectIdsForActiveSpace returns ['p1', 'p2']
  })

  test('setActiveSpace(null) returns null (show all)', () => {
    store.setActiveSpace(null)
    expect(store.getProjectIdsForActiveSpace()).toBeNull()
  })

  test('deleteSpace removes from store and clears active if needed', async () => {
    // Create space, set it active
    // Delete it
    // Verify activeSpaceId reset to null
  })
})
```

---

## Session 15: Project Spaces — UI Components

### Objectives

- Create `SpacesTabBar` component for the bottom of the sidebar
- Create `SpaceIconPicker` component with 50+ built-in icons and custom image upload
- Update `ProjectList.tsx` to filter projects by active space
- Update `ProjectItem.tsx` context menu with "Assign to Space" option
- Integrate `SpacesTabBar` into the sidebar layout

### Tasks

#### 1. Create `SpacesTabBar` component

In `src/renderer/src/components/spaces/SpacesTabBar.tsx`:

- Renders horizontally at the bottom of the sidebar
- Shows "All" tab (always first, icon: `LayoutGrid`)
- Shows each user space with its icon
- "+" button to create new space (opens name + icon picker dialog)
- Active tab has a highlight/underline
- Right-click context menu: Rename, Change Icon, Delete
- Tabs are reorderable via drag

#### 2. Create `SpaceIconPicker` component

In `src/renderer/src/components/spaces/SpaceIconPicker.tsx`:

- Grid of 50+ lucide-react icons (Briefcase, Code, Gamepad2, Palette, Music, Camera, Book, Wrench, Rocket, Heart, Star, Coffee, Globe, Zap, Shield, Terminal, Database, Cloud, Smartphone, Monitor, Cpu, GitBranch, Package, Layers, Compass, Map, Flag, Award, Crown, Diamond, Flame, Leaf, Sun, Moon, Umbrella, Anchor, Key, Lock, Bell, Bookmark, Calendar, Clock, Download, Upload, Search, Settings, Share, Trash, Users, Video, Wifi, FileCode, FolderOpen, MessageSquare)
- Each icon is clickable and highlights on selection
- "Custom Image" option opens a file dialog (`window.dialog?.showOpenDialog` or custom IPC)
- Selected icon returns `{ iconType: 'default' | 'custom', iconValue: string }`

#### 3. Update `ProjectList.tsx` to filter by space

```typescript
const activeSpaceId = useSpaceStore((state) => state.activeSpaceId)
const allowedProjectIds = useSpaceStore((state) => state.getProjectIdsForActiveSpace())

const filteredProjects = useMemo(() => {
  let result = projects
  if (allowedProjectIds !== null) {
    result = result.filter((p) => allowedProjectIds.includes(p.id))
  }
  // ... existing filter logic
  return result
}, [projects, allowedProjectIds, filterText])
```

#### 4. Update `ProjectItem.tsx` context menu

Add a "Assign to Space" submenu item that shows available spaces. Clicking a space toggles the project's membership in that space.

#### 5. Integrate into sidebar layout

In the sidebar component (likely `AppLayout.tsx` or a sidebar wrapper), add `SpacesTabBar` at the bottom:

```tsx
<div className="flex flex-col h-full">
  <div className="flex-1 overflow-y-auto">
    <ProjectFilter ... />
    <ProjectList ... />
  </div>
  <SpacesTabBar />
</div>
```

### Key Files

- `src/renderer/src/components/spaces/SpacesTabBar.tsx` — new component
- `src/renderer/src/components/spaces/SpaceIconPicker.tsx` — new component
- `src/renderer/src/components/projects/ProjectList.tsx` — filter by active space
- `src/renderer/src/components/projects/ProjectItem.tsx` — context menu
- `src/renderer/src/components/layout/AppLayout.tsx` — integrate tab bar

### Definition of Done

- [ ] Bottom tab bar renders with "All" tab and any user-created spaces
- [ ] Clicking a space tab filters the project list to only show assigned projects
- [ ] Clicking "All" shows all projects
- [ ] "+" button opens a dialog to name the space and choose an icon
- [ ] The icon picker shows 50+ icons in a searchable grid
- [ ] Custom image upload works (user can choose an image from their computer)
- [ ] Right-click on a space tab shows Rename, Change Icon, Delete options
- [ ] Context menu on project items includes "Assign to Space" with space list
- [ ] Drag-and-drop reordering of space tabs works
- [ ] Active space persists across app restarts
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Verify no spaces initially — only "All" tab at the bottom, all projects visible
2. Click "+" — create a "Work" space with Briefcase icon
3. Right-click a project — assign it to "Work"
4. Click the "Work" space tab — verify only assigned projects show
5. Click "All" — verify all projects show
6. Create another space "Side Projects" with Gamepad2 icon
7. Assign a project to both spaces — verify it appears in both
8. Right-click a space — rename it, change icon, verify changes persist
9. Delete a space — verify projects are unaffected (just unassigned from that space)
10. Restart app — verify spaces and assignments persist

### Testing Criteria

```typescript
// test/phase-17/session-15/spaces-ui.test.tsx
describe('Session 15: Project Spaces UI', () => {
  test('SpacesTabBar renders All tab', () => {
    // Render SpacesTabBar with empty spaces
    // Verify "All" tab is visible and active
  })

  test('SpacesTabBar renders user spaces', () => {
    // Mock spaces with [{name: 'Work', ...}]
    // Render SpacesTabBar
    // Verify "Work" tab is visible
  })

  test('clicking space tab calls setActiveSpace', () => {
    // Render with spaces, click a space
    // Verify setActiveSpace called with space id
  })

  test('ProjectList filters by active space', () => {
    // Mock 3 projects, assign 2 to space 's1'
    // Set activeSpaceId to 's1'
    // Render ProjectList
    // Verify only 2 projects rendered
  })

  test('SpaceIconPicker renders 50+ icons', () => {
    // Render SpaceIconPicker
    // Verify at least 50 icon buttons are present
  })

  test('selecting icon returns correct value', () => {
    // Render SpaceIconPicker with onSelect callback
    // Click an icon
    // Verify onSelect called with { iconType: 'default', iconValue: 'Briefcase' }
  })
})
```

---

## Session 16: Integration & Verification

### Objectives

- Verify all Phase 17 features work together end-to-end
- Run full test suite and lint
- Test edge cases and cross-feature interactions
- Ensure no regressions from Phase 16

### Tasks

#### 1. Run full test suite

```bash
pnpm test
pnpm lint
```

Fix any failures.

#### 2. Cross-feature interaction tests

**Toast variants + all features:**

- Verify git refresh errors show red toast
- Verify commit success shows green toast
- Verify space creation shows correct toast type

**Completion badge + tab loading:**

- Start streaming — verify both tab spinner and sidebar spinner show
- Streaming completes — verify both show completion badge/icon
- Badge clears after 30s — verify both revert

**Per-session model + completion badge:**

- Session A (opus) and Session B (codex) — verify each shows correct completion
- Verify model push on tab switch doesn't interfere with completion badge

**Diff tabs + Cmd+W:**

- Open a diff tab — press Cmd+W — verify diff tab closes
- With no diff or file tab — press Cmd+W — verify session closes

**Plan mode badge + commit message:**

- Send plan-mode messages — verify PLANNER badge shows
- Verify session titles (not plan prefix) end up in commit form

**Project spaces + project list:**

- Assign projects to spaces — verify filtering works
- Verify drag-and-drop reorder works within a space filter
- Verify the project filter (search) works in combination with space filtering

#### 3. Database migration order verification

Verify migrations v11 (session model columns), v12 (worktree session_titles), and v13 (spaces tables) all apply correctly in sequence. Test fresh database creation and migration from v10.

#### 4. Full smoke test

1. Open app → verify spaces tab bar at bottom → create a space
2. Add a project → assign to space → filter by space
3. Create a worktree → start a session → select a model per-session
4. Send a message in plan mode → verify PLANNER badge after finalization
5. Switch to terminal, make file changes, switch back → verify git refresh
6. Open a changed file → verify diff tab appears → Cmd+W closes it
7. Wait for streaming to complete → verify completion badge ("Brewed for 23s")
8. Create another session → verify it defaults to previous model
9. Change model variant → switch models → switch back → verify variant remembered
10. Stage files → open commit form → verify session titles pre-populate
11. Trigger error → verify red toast with icon
12. Trigger success → verify green toast with icon

### Key Files

- All files modified in Sessions 1-15

### Definition of Done

- [ ] `pnpm test` passes with zero failures
- [ ] `pnpm lint` passes with zero errors
- [ ] All 10 PRD features work correctly in isolation
- [ ] Cross-feature interactions work correctly
- [ ] No regressions from Phase 16 features
- [ ] Database migrations apply cleanly (fresh and upgrade paths)
- [ ] App starts and runs without console errors

### Testing Criteria

```typescript
// test/phase-17/session-16/integration-verification.test.ts
describe('Session 16: Phase 17 Integration', () => {
  test('all Phase 17 features compile without errors', () => {
    // Validated by pnpm lint passing
  })

  test('all Phase 17 test suites pass', () => {
    // Validated by pnpm test passing
  })

  test('database migrations v11-v13 apply in sequence', () => {
    // Verify CURRENT_SCHEMA_VERSION is 13
    // Verify all three migrations exist in MIGRATIONS array
  })
})
```
