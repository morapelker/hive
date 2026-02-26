# Hive PostHog Analytics Implementation Plan

This document outlines the implementation plan for anonymous PostHog analytics, covering the telemetry service, IPC bridge, event instrumentation, privacy settings UI, and test mocks.

---

## Overview

The implementation is divided into **5 focused sessions**, each with:

- Clear objectives and task list (B- for backend, F- for frontend)
- Definition of done
- Testing criteria for verification

**Refer to:** `docs/prd/PRD_ANALYTICS.md` for full product requirements.

---

## Dependencies & Parallelization

```
Session 1  (TelemetryService + Dependency)         -- no deps
Session 2  (IPC Handlers + Preload Bridge + Types)  -- blocked by Session 1
Session 3  (Lifecycle Wiring + Onboarding Events)   -- blocked by Session 2
Session 4  (Instrument IPC Handler Events)          -- blocked by Session 1
Session 5  (Privacy Settings UI)                    -- blocked by Session 2
```

### Dependency Graph

```
┌─────────────────────────────────────────────────────┐
│  Time →                                             │
│                                                     │
│  [S1: TelemetryService + Dep] ──┬──────────────┐   │
│                                 │              │   │
│                        [S2: IPC + Preload]     │   │
│                           ┌─────┴─────┐       │   │
│                           ▼           ▼       ▼   │
│                  [S3: Lifecycle   [S5: Privacy  [S4: IPC │
│                   + Onboarding]   Settings UI]  Events]  │
└─────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 4 and 5 are independent of each other (both only need S1/S2).

**Recommended serial order**: S1 → S2 → S3 → S4 → S5

---

## New Dependencies

```bash
pnpm add posthog-node
```

---

## Session 1: TelemetryService Core

### Objectives

Create the `TelemetryService` singleton in the main process. This is the foundation — all other sessions depend on it.

### Tasks

#### B-1. Install posthog-node

```bash
pnpm add posthog-node
```

Verify it appears in `package.json` dependencies.

#### B-2. Create `src/main/services/telemetry-service.ts`

Singleton class following the exact pattern of `src/main/services/logger.ts` (lines 42-237):

```typescript
import { PostHog } from 'posthog-node'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import { createLogger } from './logger'

const log = createLogger({ component: 'Telemetry' })

const POSTHOG_API_KEY = '<project-api-key>'  // TODO: user provides their key
const POSTHOG_HOST = 'https://us.i.posthog.com'

class TelemetryService {
  private static instance: TelemetryService | null = null
  private client: PostHog | null = null
  private distinctId: string | null = null
  private enabled = true

  static getInstance(): TelemetryService { ... }
  init(): void { ... }         // Load/generate distinctId, load enabled state, create client
  track(event, properties?): void { ... }  // No-op if disabled
  identify(properties?): void { ... }
  setEnabled(enabled): void { ... }
  isEnabled(): boolean { ... }
  async shutdown(): Promise<void> { ... }
}

export const telemetryService = TelemetryService.getInstance()
```

Key implementation details:
- `init()` reads `telemetry_distinct_id` and `telemetry_enabled` from SQLite `settings` table via `getDatabase()`
- If no `telemetry_distinct_id` exists, generate one with `crypto.randomUUID()` and store it
- Absent `telemetry_enabled` = enabled (opt-out default)
- PostHog client config: `flushAt: 20`, `flushInterval: 30000`
- `track()` attaches `app_version` (from `app.getVersion()`) and `platform` (from `process.platform`) to every event
- `setEnabled(false)` calls `this.shutdown()`, sets `client = null`, persists `telemetry_enabled: 'false'` to SQLite
- `setEnabled(true)` creates new client, persists `telemetry_enabled: 'true'`
- Track `telemetry_disabled` event before shutting down when user opts out

#### B-3. Export from services index

In `src/main/services/index.ts`, add:
```typescript
export { telemetryService } from './telemetry-service'
```

If no barrel file exists, this step is skipped — direct imports work fine.

### Definition of Done

- [ ] `posthog-node` is in `package.json` dependencies
- [ ] `telemetry-service.ts` exists with all 6 methods
- [ ] Service can be imported without errors: `import { telemetryService } from './telemetry-service'`
- [ ] `pnpm build` succeeds with no TypeScript errors

### Test Criteria

```bash
pnpm build   # Must succeed — verifies TS types and imports resolve
pnpm lint    # Must pass — verifies code style
```

---

## Session 2: IPC Handlers + Preload Bridge + Types

### Objectives

Wire the TelemetryService to the renderer via IPC so the renderer can call `window.analyticsOps.track()`, `setEnabled()`, and `isEnabled()`.

### Tasks

#### B-1. Register telemetry IPC handlers in `src/main/index.ts`

Add after the existing handler registrations (~line 446), alongside the other `ipcMain.handle` calls:

```typescript
import { telemetryService } from './services/telemetry-service'

// Telemetry IPC
ipcMain.handle('telemetry:track', (_event, eventName: string, properties?: Record<string, unknown>) => {
  telemetryService.track(eventName, properties)
})

ipcMain.handle('telemetry:setEnabled', (_event, enabled: boolean) => {
  telemetryService.setEnabled(enabled)
})

ipcMain.handle('telemetry:isEnabled', () => {
  return telemetryService.isEnabled()
})
```

#### B-2. Add `analyticsOps` namespace to `src/preload/index.ts`

Follow the existing namespace pattern (e.g., `settingsOps` around lines 159-230). Define the object before the `contextBridge.exposeInMainWorld` calls:

```typescript
const analyticsOps = {
  track: (event: string, properties?: Record<string, unknown>) =>
    ipcRenderer.invoke('telemetry:track', event, properties),
  setEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('telemetry:setEnabled', enabled),
  isEnabled: () =>
    ipcRenderer.invoke('telemetry:isEnabled') as Promise<boolean>
}
```

Then expose it in the `contextBridge.exposeInMainWorld` block (~line 1589-1613):

```typescript
contextBridge.exposeInMainWorld('analyticsOps', analyticsOps)
```

#### B-3. Add type declarations in `src/preload/index.d.ts`

Inside the `declare global { interface Window { ... } }` block (~line 107-1048), add:

```typescript
analyticsOps: {
  track: (event: string, properties?: Record<string, unknown>) => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  isEnabled: () => Promise<boolean>
}
```

#### B-4. Add `window.analyticsOps` mock to `test/setup.ts`

Follow the existing pattern (~lines 56-93) for mocking window APIs:

```typescript
if (!window.analyticsOps) {
  Object.defineProperty(window, 'analyticsOps', {
    writable: true,
    configurable: true,
    value: {
      track: vi.fn().mockResolvedValue(undefined),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      isEnabled: vi.fn().mockResolvedValue(true)
    }
  })
}
```

### Definition of Done

- [ ] Three `ipcMain.handle` calls registered for `telemetry:*` channels
- [ ] `analyticsOps` object defined and exposed via `contextBridge.exposeInMainWorld`
- [ ] Type declarations added for `window.analyticsOps`
- [ ] Test mock added so existing tests don't break
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes (existing tests unaffected by new mock)

### Test Criteria

```bash
pnpm build    # Verifies TS compilation with new types
pnpm lint     # Code style
pnpm test     # Existing tests still pass with analyticsOps mock
```

---

## Session 3: App Lifecycle Wiring + Onboarding Events

### Objectives

Initialize the telemetry service at app startup, track the two lifecycle events (`app_launched`, `app_session_ended`), wire shutdown, and add the `onboarding_completed` renderer event.

### Tasks

#### B-1. Initialize telemetry in `src/main/index.ts`

In `app.whenReady()`, immediately after `getDatabase()` (line 436):

```typescript
// Initialize telemetry
telemetryService.init()
```

#### B-2. Track `app_launched` after window creation

After `createWindow()` (line 454) and the SDK manager setup (~line 529):

```typescript
telemetryService.track('app_launched')
telemetryService.identify({
  platform: process.platform,
  app_version: app.getVersion(),
  electron_version: process.versions.electron
})
```

#### B-3. Track `app_session_ended` and flush on quit

Store app start time at module level:

```typescript
const appStartTime = Date.now()
```

In `app.on('will-quit')` (~line 548), add BEFORE `closeDatabase()` (line 562):

```typescript
telemetryService.track('app_session_ended', {
  session_duration_ms: Date.now() - appStartTime
})
await telemetryService.shutdown()
```

#### F-1. Track `onboarding_completed` in `AgentSetupGuard.tsx`

In `src/renderer/src/components/setup/AgentSetupGuard.tsx`, at the two places where `updateSetting('initialSetupComplete', true)` is called:

**Auto-select path** (~line 33-34):
```typescript
updateSetting('defaultAgentSdk', opencode ? 'opencode' : 'claude-code')
updateSetting('initialSetupComplete', true)
window.analyticsOps.track('onboarding_completed', {
  sdk: opencode ? 'opencode' : 'claude-code',
  auto_selected: true
})
```

**Manual selection path** (~line 62-65):
```typescript
updateSetting('defaultAgentSdk', sdk)
updateSetting('initialSetupComplete', true)
window.analyticsOps.track('onboarding_completed', {
  sdk,
  auto_selected: false
})
```

### Definition of Done

- [ ] `telemetryService.init()` called after DB init in `app.whenReady()`
- [ ] `app_launched` tracked after window creation with `identify()` call
- [ ] `app_session_ended` tracked in `will-quit` with `session_duration_ms`
- [ ] `telemetryService.shutdown()` called before `closeDatabase()`
- [ ] `onboarding_completed` tracked at both auto-select and manual-select paths
- [ ] `pnpm build` succeeds
- [ ] `pnpm lint` passes

### Test Criteria

```bash
pnpm build
pnpm lint
pnpm test     # Existing tests pass — AgentSetupGuard tests use mock analyticsOps
```

**Manual verification:**
- Run `pnpm dev`, check main process logs for "Telemetry initialized" with distinct ID
- Check PostHog Live Events dashboard for `app_launched` event within ~30 seconds
- Quit the app, check PostHog for `app_session_ended` with `session_duration_ms` property

---

## Session 4: Instrument IPC Handler Events

### Objectives

Add `telemetryService.track()` calls to the 9 remaining events across 7 IPC handler files. Each is a single line inserted after the successful operation.

### Tasks

#### B-1. Track `project_added` in `src/main/ipc/database-handlers.ts`

In the `db:project:create` handler (~lines 40-54), after the project is created and returned:

```typescript
ipcMain.handle('db:project:create', (_event, data: ProjectCreate) => {
  const db = getDatabase()
  const project = db.createProject(data)
  db.createWorktree({ ... })
  telemetryService.track('project_added', { language: data.language ?? undefined })
  return project
})
```

#### B-2. Track `worktree_created` in `src/main/ipc/worktree-handlers.ts`

In the `worktree:create` handler (~lines 45-49), after the worktree is created:

```typescript
ipcMain.handle('worktree:create', async (_event, params: CreateWorktreeParams) => {
  const result = await createWorktreeOp(getDatabase(), params)
  telemetryService.track('worktree_created')
  return result
})
```

#### B-3. Track `session_started` in `src/main/ipc/opencode-handlers.ts`

In the connect handler (~lines 19-48), after successful connection:

```typescript
// After successful connect (both opencode and claude-code paths)
telemetryService.track('session_started', {
  agent_sdk: session?.agent_sdk ?? 'opencode'
})
```

#### B-4. Track `prompt_sent` in `src/main/ipc/opencode-handlers.ts`

In the prompt handler (~lines 85-150), after successful dispatch:

```typescript
telemetryService.track('prompt_sent', {
  agent_sdk: sdkId ?? 'opencode'
})
```

#### B-5. Track `connection_created` in `src/main/ipc/connection-handlers.ts`

In the `connection:create` handler (~lines 24-36), after creation:

```typescript
ipcMain.handle('connection:create', async (_event, { worktreeIds }) => {
  const db = getDatabase()
  const result = createConnectionOp(db, worktreeIds)
  telemetryService.track('connection_created')
  return result
})
```

#### B-6. Track `git_commit_made` in `src/main/ipc/git-file-handlers.ts`

In the `git:commit` handler (~lines 364-380), after successful commit:

```typescript
const result = await gitService.commit(message)
if (result.success) {
  telemetryService.track('git_commit_made')
}
return result
```

#### B-7. Track `git_push_made` in `src/main/ipc/git-file-handlers.ts`

In the `git:push` handler (~lines 384-406), after successful push:

```typescript
const result = await gitService.push(remote, branch, force)
if (result.success) {
  telemetryService.track('git_push_made')
}
return result
```

#### B-8. Track `script_run` in `src/main/ipc/script-handlers.ts`

In each of the three script handlers:

**`script:runSetup`** (~lines 41-64):
```typescript
telemetryService.track('script_run', { type: 'setup' })
```

**`script:runProject`** (~lines 68-91):
```typescript
telemetryService.track('script_run', { type: 'run' })
```

**`script:runArchive`** (~lines 110-125):
```typescript
telemetryService.track('script_run', { type: 'archive' })
```

#### B-9. Track `worktree_opened_in_editor` in `src/main/ipc/settings-handlers.ts`

In the `settings:openWithEditor` handler (~lines 42-73), after successful spawn:

```typescript
spawn(command, [worktreePath], { detached: true, stdio: 'ignore' })
telemetryService.track('worktree_opened_in_editor')
return { success: true }
```

### Definition of Done

- [ ] All 7 handler files import `telemetryService`
- [ ] 9 events tracked at the correct locations with correct properties
- [ ] Events only fire on success paths (not on errors)
- [ ] `pnpm build` succeeds
- [ ] `pnpm lint` passes

### Test Criteria

```bash
pnpm build
pnpm lint
pnpm test    # Existing handler tests still pass
```

**Manual verification** (run `pnpm dev` and check PostHog Live Events):
- Add a project → see `project_added` event
- Create a worktree → see `worktree_created` event
- Start a session → see `session_started` with `agent_sdk` property
- Send a prompt → see `prompt_sent` with `agent_sdk` property
- Commit in git panel → see `git_commit_made` event
- Run a script → see `script_run` with `type` property

---

## Session 5: Privacy Settings UI

### Objectives

Create the Settings > Privacy section with a toggle to opt out of analytics. This is the only user-facing change.

### Tasks

#### F-1. Create `src/renderer/src/components/settings/SettingsPrivacy.tsx`

Follow the component pattern of `SettingsSecurity.tsx` (~lines 69-98 for section header + toggle):

```typescript
import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'

export function SettingsPrivacy(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.analyticsOps.isEnabled().then((val) => {
      setEnabled(val)
      setLoaded(true)
    })
  }, [])

  const handleToggle = () => {
    const newValue = !enabled
    setEnabled(newValue)
    window.analyticsOps.setEnabled(newValue)
  }

  if (!loaded) return <div />

  return (
    <div className="space-y-6">
      {/* Section header */}
      <div>
        <h3 className="text-base font-medium mb-1">Privacy</h3>
        <p className="text-sm text-muted-foreground">
          Control how Hive collects anonymous usage data
        </p>
      </div>

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Send anonymous usage analytics</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Help improve Hive by sharing anonymous feature usage data
          </p>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          onClick={handleToggle}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            enabled ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span className={cn(
            'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
            enabled ? 'translate-x-4' : 'translate-x-0'
          )} />
        </button>
      </div>

      {/* Info box */}
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">What we collect:</span>{' '}
          Feature usage counts, app version, platform (macOS/Windows/Linux).
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          <span className="font-medium text-foreground">What we never collect:</span>{' '}
          Project names, file contents, prompts, AI responses, git data, or any personal information.
        </p>
      </div>
    </div>
  )
}
```

#### F-2. Register in `src/renderer/src/components/settings/SettingsModal.tsx`

Add import at top:
```typescript
import { SettingsPrivacy } from './SettingsPrivacy'
import { Eye } from 'lucide-react'
```

Add to `SECTIONS` array (~line 14-22) — place it after `security`:
```typescript
{ id: 'privacy', label: 'Privacy', icon: Eye },
```

Add to content rendering (~lines 78-84):
```typescript
{activeSection === 'privacy' && <SettingsPrivacy />}
```

Update the `SECTIONS` type annotation if it uses `as const` — ensure `'privacy'` is included.

#### F-3. Update `useSettingsStore.ts` type (optional cache)

In `src/renderer/src/stores/useSettingsStore.ts`, add `telemetryEnabled` to `AppSettings` (~line 34-82):

```typescript
// Privacy
telemetryEnabled: boolean
```

And its default (~line 84-120):
```typescript
telemetryEnabled: true,
```

This is a renderer-side cache only. The source of truth is the SQLite setting read directly by `TelemetryService`.

### Definition of Done

- [ ] `SettingsPrivacy.tsx` exists with toggle switch and info box
- [ ] Settings modal shows "Privacy" section with Eye icon in nav
- [ ] Toggle reads initial state from `window.analyticsOps.isEnabled()`
- [ ] Toggle calls `window.analyticsOps.setEnabled()` on click
- [ ] Info box explains what is and isn't collected
- [ ] `pnpm build` succeeds
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Test Criteria

```bash
pnpm build
pnpm lint
pnpm test
```

**Manual verification:**
- Open Settings → "Privacy" section appears in left nav with Eye icon
- Toggle is ON by default
- Toggle OFF → PostHog Live Events shows no further events
- Toggle back ON → events resume
- Restart app with toggle OFF → toggle remains OFF (persisted)
- Info box text is readable and accurate

---

## Summary

| Session | Focus | New Files | Modified Files | Events Added |
|---|---|---|---|---|
| 1 | TelemetryService core | `telemetry-service.ts` | `package.json` | — |
| 2 | IPC + preload + types | — | `index.ts` (main), `index.ts` (preload), `index.d.ts`, `test/setup.ts` | — |
| 3 | Lifecycle + onboarding | — | `index.ts` (main), `AgentSetupGuard.tsx` | `app_launched`, `app_session_ended`, `onboarding_completed` |
| 4 | IPC handler events | — | 7 handler files | `project_added`, `worktree_created`, `session_started`, `prompt_sent`, `connection_created`, `git_commit_made`, `git_push_made`, `script_run`, `worktree_opened_in_editor` |
| 5 | Privacy settings UI | `SettingsPrivacy.tsx` | `SettingsModal.tsx`, `useSettingsStore.ts` | — |

**Total: 2 new files, ~13 modified files, 13 events**
