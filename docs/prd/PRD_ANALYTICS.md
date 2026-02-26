# PRD: PostHog Anonymous Analytics

## Context

Hive has no usage analytics. We need anonymous metrics to understand onboarding funnels, activation milestones, and retention patterns to guide product decisions.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Goal | Growth/activation metrics | Understand onboarding funnel, first-use milestones, return patterns |
| SDK | `posthog-node` (main process only) | Simpler than dual-process, works offline, single instance, no renderer network access needed |
| Consent | Opt-out (on by default) | Standard for developer tools. Toggle in Settings > Privacy. No toasts or first-launch notices |
| Event count | ~13 core events | Focused on activation funnel, not comprehensive instrumentation |

---

## Architecture

### Approach: Centralized TelemetryService in Main Process

A singleton `TelemetryService` in `src/main/services/` — follows the exact same pattern as `LoggerService` and `NotificationService`. IPC handlers call `telemetryService.track()` directly where events happen. The renderer forwards UI-only events via `window.analyticsOps.track()` through IPC.

**Why this approach over alternatives:**
- **vs. IPC middleware/interceptor**: IPC channels are implementation details, not user-meaningful events. Can't express state transitions like "first prompt ever" or "onboarding completed" via middleware. Also no existing middleware pattern in the codebase.
- **vs. Event bus integration**: Hive has no central event bus. Building one just for analytics is over-engineering.
- **Centralized service wins on**: simplicity, greppability, alignment with existing patterns, flexibility to add/remove events.

### Data Flow

```
┌─────────────────────┐     ┌──────────────────────┐
│  Main Process        │     │  Renderer (React)     │
│                      │     │                       │
│  IPC Handlers ───────┼──→  │  window.analyticsOps  │
│       │              │     │  .track() ────────────┼──┐
│       ▼              │     │  .setEnabled() ───────┼──┤
│  TelemetryService    │◄────┼──────────────────────┼──┘
│       │              │ IPC │                       │
│       ▼              │     │                       │
│  posthog-node        │     │                       │
│  (batched HTTP)      │     │                       │
└─────────────────────┘     └──────────────────────┘
```

Most events are tracked directly in main process IPC handlers (no IPC round-trip). Only renderer-specific events (e.g., `onboarding_completed`) use the `window.analyticsOps.track()` bridge.

---

## TelemetryService Specification

### File: `src/main/services/telemetry-service.ts`

Singleton class with these methods:

| Method | Description |
|---|---|
| `init()` | Called after DB init in `app.whenReady()`. Loads `telemetry_distinct_id` and `telemetry_enabled` from SQLite settings table. Generates `crypto.randomUUID()` on first launch. Creates PostHog client if enabled. |
| `track(event, properties?)` | No-op if disabled. Calls `posthog.capture()` with `{ distinctId, event, properties: { app_version, platform, ...properties } }`. |
| `identify(properties?)` | Sets user properties on the anonymous profile (e.g., `platform`, `electron_version`). |
| `setEnabled(boolean)` | Toggles `telemetry_enabled` in SQLite. Creates or destroys PostHog client accordingly. |
| `isEnabled()` | Returns current enabled state. |
| `shutdown()` | Flushes all pending events. Called on `will-quit` before `closeDatabase()`. |

### PostHog Client Config

```typescript
new PostHog(POSTHOG_API_KEY, {
  host: POSTHOG_HOST,     // https://us.i.posthog.com or https://eu.i.posthog.com
  flushAt: 20,            // batch size before flush
  flushInterval: 30000    // 30 seconds
})
```

### Anonymous Identity

- Generated via `crypto.randomUUID()` on first app launch
- Stored in SQLite `settings` table with key `telemetry_distinct_id`
- Persists across app sessions but is per-machine (tied to `~/.hive/hive.db`)
- Never linked to any PII
- If user deletes DB, a new ID is generated (privacy-preserving)

### Offline Handling

- `posthog-node` queues events in memory and flushes in batches (20 events or 30s)
- Failed flushes are retried on next interval
- `shutdown()` in `will-quit` makes a final flush attempt before process exits
- No disk persistence needed — Electron's `will-quit` event is reliable enough

---

## Consent Model

### Behavior

- Analytics is **on by default** (opt-out model)
- `telemetry_enabled` setting absent from SQLite = enabled (default behavior)
- User can disable via Settings > Privacy toggle
- When disabled: no events are captured, PostHog client is destroyed
- When re-enabled: new PostHog client is created, events resume
- Setting persists across app restarts via SQLite
- **No toasts, banners, or first-launch notices** — just the settings toggle

### Privacy Guarantees — What is NOT Collected

- No project names, paths, or file contents
- No prompt text or AI responses
- No git branch names, commit messages, or diffs
- No worktree paths or directory structures
- No PII of any kind
- The distinct_id is a random UUID with no link to any identity

---

## Events Specification

### Onboarding Funnel

| Event | Trigger Location | Properties | Purpose |
|---|---|---|---|
| `app_launched` | `src/main/index.ts` (after window creation) | `app_version`, `platform` | Top of funnel — how many users launch the app |
| `onboarding_completed` | `AgentSetupGuard.tsx` via `window.analyticsOps.track()` | `{ sdk: string }` | Setup completion rate |

### Core Activation

| Event | Trigger Location | Properties | Purpose |
|---|---|---|---|
| `project_added` | `src/main/ipc/database-handlers.ts` (`db:project:create`) | `{ language?: string }` | First meaningful action after setup |
| `worktree_created` | `src/main/ipc/worktree-handlers.ts` (`worktree:create`) | — | Engagement depth |
| `session_started` | `src/main/ipc/opencode-handlers.ts` (connect handler) | `{ agent_sdk: string }` | Core activation — user starts coding with AI |
| `prompt_sent` | `src/main/ipc/opencode-handlers.ts` (prompt handler) | `{ agent_sdk: string }` | Core usage — user interacts with AI |

### Feature Adoption

| Event | Trigger Location | Properties | Purpose |
|---|---|---|---|
| `connection_created` | `src/main/ipc/connection-handlers.ts` | — | Multi-repo feature usage |
| `git_commit_made` | `src/main/ipc/git-file-handlers.ts` (`git:commit`) | — | Git integration adoption |
| `git_push_made` | `src/main/ipc/git-file-handlers.ts` (`git:push`) | — | Git workflow depth |
| `script_run` | `src/main/ipc/script-handlers.ts` | `{ type: 'setup' \| 'run' \| 'archive' }` | Setup automation adoption |
| `worktree_opened_in_editor` | `src/main/ipc/settings-handlers.ts` | — | External editor integration |

### Retention

| Event | Trigger Location | Properties | Purpose |
|---|---|---|---|
| `app_session_ended` | `src/main/index.ts` (`will-quit` handler) | `{ session_duration_ms: number }` | Session length distribution |

### Meta

| Event | Trigger Location | Properties | Purpose |
|---|---|---|---|
| `telemetry_disabled` | `telemetry-service.ts` (`setEnabled(false)`) | — | Track opt-out rate |

---

## Settings UI — Privacy Section

### New File: `src/renderer/src/components/settings/SettingsPrivacy.tsx`

Follow the same component pattern as `SettingsSecurity.tsx`:

- **Section header**: "Privacy" / "Control how Hive collects anonymous usage data"
- **Toggle switch**: "Send anonymous usage analytics" — bound to `window.analyticsOps.isEnabled()` / `window.analyticsOps.setEnabled()`
- **Info box**: Brief explanation of what is and isn't collected (feature usage counts, app version, platform — NOT project names, file contents, prompts, git data, or PII)

### SettingsModal Integration

Add to `SECTIONS` array in `SettingsModal.tsx`:
```typescript
{ id: 'privacy', label: 'Privacy', icon: Eye }
```

Add import and conditional rendering in content area.

---

## IPC Bridge

### Preload Namespace: `window.analyticsOps`

```typescript
// src/preload/index.ts
const analyticsOps = {
  track: (event: string, properties?: Record<string, unknown>) =>
    ipcRenderer.invoke('telemetry:track', event, properties),
  setEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('telemetry:setEnabled', enabled),
  isEnabled: () =>
    ipcRenderer.invoke('telemetry:isEnabled') as Promise<boolean>
}
```

### Type Declaration: `src/preload/index.d.ts`

```typescript
analyticsOps: {
  track: (event: string, properties?: Record<string, unknown>) => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  isEnabled: () => Promise<boolean>
}
```

### Main Process IPC Handlers

Register inline in `src/main/index.ts` or in a new `src/main/ipc/telemetry-handlers.ts`:

```typescript
ipcMain.handle('telemetry:track', (_e, event, props) => telemetryService.track(event, props))
ipcMain.handle('telemetry:setEnabled', (_e, enabled) => telemetryService.setEnabled(enabled))
ipcMain.handle('telemetry:isEnabled', () => telemetryService.isEnabled())
```

---

## Files Summary

### New Files
| File | Purpose |
|---|---|
| `src/main/services/telemetry-service.ts` | Core PostHog singleton service |
| `src/renderer/src/components/settings/SettingsPrivacy.tsx` | Privacy settings UI section |

### Modified Files
| File | Change |
|---|---|
| `package.json` | Add `posthog-node` dependency |
| `src/main/index.ts` | Init telemetry service, register IPC handlers, track `app_launched`/`app_session_ended`, shutdown on quit |
| `src/preload/index.ts` | Expose `window.analyticsOps` namespace |
| `src/preload/index.d.ts` | Add `analyticsOps` type declarations |
| `src/renderer/src/components/settings/SettingsModal.tsx` | Add Privacy section to navigation and content |
| `src/renderer/src/stores/useSettingsStore.ts` | Add `telemetryEnabled: boolean` to `AppSettings` (renderer cache) |
| `src/renderer/src/components/setup/AgentSetupGuard.tsx` | Track `onboarding_completed` event |
| `src/main/ipc/database-handlers.ts` | Track `project_added` event |
| `src/main/ipc/worktree-handlers.ts` | Track `worktree_created` event |
| `src/main/ipc/opencode-handlers.ts` | Track `session_started`, `prompt_sent` events |
| `src/main/ipc/git-file-handlers.ts` | Track `git_commit_made`, `git_push_made` events |
| `src/main/ipc/script-handlers.ts` | Track `script_run` event |
| `src/main/ipc/connection-handlers.ts` | Track `connection_created` event |
| `src/main/ipc/settings-handlers.ts` | Track `worktree_opened_in_editor` event |

### Reuse Existing Patterns
| Pattern | Reference File |
|---|---|
| Singleton service | `src/main/services/logger.ts` |
| Settings UI section | `src/renderer/src/components/settings/SettingsSecurity.tsx` |
| IPC bridge namespace | `src/preload/index.ts` (any existing namespace) |
| SQLite settings | `window.db.setting.get/set` — no schema migration needed |

---

## Verification Plan

1. **Build**: `pnpm build` — no TypeScript errors with new types
2. **Dev mode**: `pnpm dev` — check main process logs for "Telemetry initialized" with distinct ID
3. **PostHog Live Events**: Use the app (add project, create worktree, start session, send prompt) → verify events appear in PostHog dashboard within ~30s
4. **Opt-out toggle**: Settings > Privacy → toggle off → verify no further events in PostHog
5. **Opt-out persistence**: Toggle off → restart app → verify telemetry stays disabled (check logs)
6. **Lint**: `pnpm lint` — no lint errors
7. **Tests**: `pnpm test` — existing tests pass (mock `window.analyticsOps` in test setup)

---

## Future Expansion (Not in Scope)

These events could be added later for deeper product understanding:

- `model_changed` — model selection patterns
- `command_palette_used` — command palette engagement
- `worktree_archived` / `worktree_deleted` — lifecycle completion
- `session_mode_changed` — build vs plan mode usage
- `terminal_created` — embedded terminal adoption
- Session recording via `posthog-js` in renderer (separate effort)
