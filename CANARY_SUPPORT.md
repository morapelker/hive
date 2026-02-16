# Canary Builds Implementation Plan

> Implementation plan for adding canary update channel support to Hive.
> Each session is self-contained and should be executed in order.

## Architecture Overview

Canary builds use `electron-updater`'s native channel system. Both stable (`latest-mac.yml`) and canary (`canary-mac.yml`) manifests coexist in the same GitHub Releases repo (`morapelker/hive`). Canary versions use semver prerelease format: `1.0.19-canary.1`.

Users choose their channel in Settings. The main process reads the preference from SQLite and configures `autoUpdater.channel` accordingly. Homebrew gets a separate `hive-canary` cask that conflicts with the stable `hive` cask.

---

## Session 1: Updater Service — Channel-Aware Auto-Updates

**Goal:** Make the main-process updater read a channel preference from the database and configure `electron-updater` accordingly. Add a runtime `setChannel` method.

### Files to modify

#### `src/main/services/updater.ts`

1. Import `getDatabase` from `../db` (or wherever the singleton lives — check `src/main/db/index.ts`).

2. Add a helper function to read the channel from SQLite:

   ```ts
   function getUpdateChannel(): 'stable' | 'canary' {
     try {
       const db = getDatabase()
       const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as
         | { value: string }
         | undefined
       if (row) {
         const settings = JSON.parse(row.value)
         return settings.updateChannel === 'canary' ? 'canary' : 'stable'
       }
     } catch {
       // DB not ready or setting not found — default to stable
     }
     return 'stable'
   }
   ```

3. In `init()`, after the `if (!app.isPackaged) return` guard, read the channel and apply it:

   ```ts
   const channel = getUpdateChannel()
   autoUpdater.channel = channel === 'canary' ? 'canary' : 'latest'
   autoUpdater.allowPrerelease = channel === 'canary'
   autoUpdater.allowDowngrade = true // needed so canary->stable downgrades work
   log.info('Auto-updater initialized', { channel })
   ```

4. Add a `setChannel` method to the `updaterService` object:

   ```ts
   setChannel(channel: 'stable' | 'canary'): void {
     autoUpdater.channel = channel === 'canary' ? 'canary' : 'latest'
     autoUpdater.allowPrerelease = channel === 'canary'
     log.info('Update channel changed', { channel })
     this.checkForUpdates()
   }
   ```

5. Add a `getVersion` method:
   ```ts
   getVersion(): string {
     return app.getVersion()
   }
   ```

#### `src/main/ipc/updater-handlers.ts`

Add two new IPC handlers alongside the existing three:

```ts
ipcMain.handle('updater:setChannel', (_event, channel: string) => {
  updaterService.setChannel(channel as 'stable' | 'canary')
})

ipcMain.handle('updater:getVersion', () => {
  return updaterService.getVersion()
})
```

#### `src/preload/index.ts`

Add to the `updaterOps` object:

```ts
setChannel: (channel: string) => ipcRenderer.invoke('updater:setChannel', channel),
getVersion: () => ipcRenderer.invoke('updater:getVersion') as Promise<string>,
```

#### `src/preload/index.d.ts`

Add to the `updaterOps` interface inside `Window`:

```ts
setChannel(channel: string): Promise<void>
getVersion(): Promise<string>
```

### Verification

- Run `pnpm build` to confirm no type errors.
- Run `pnpm lint` to confirm no lint issues.
- The updater won't do anything in dev mode (`!app.isPackaged` guard), but the code should compile cleanly.

---

## Session 2: Settings Store — Add `updateChannel` Field

**Goal:** Add `updateChannel` to the settings store so the renderer can read/write the channel preference, and notify the main process when it changes.

### Files to modify

#### `src/renderer/src/stores/useSettingsStore.ts`

1. Add `updateChannel` to the `AppSettings` interface:

   ```ts
   // Updates
   updateChannel: 'stable' | 'canary'
   ```

2. Add to `DEFAULT_SETTINGS`:

   ```ts
   updateChannel: 'stable'
   ```

3. Add to the `extractSettings` function (add the line alongside the other fields):

   ```ts
   updateChannel: state.updateChannel,
   ```

4. Add to the `partialize` config in the `persist` middleware:

   ```ts
   updateChannel: state.updateChannel,
   ```

5. In the `updateSetting` action, add a side-effect hook: after the existing `saveToDatabase(settings)` call, check if the key is `updateChannel` and notify the main process:
   ```ts
   updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
     set({ [key]: value } as Partial<SettingsState>)
     const settings = extractSettings({ ...get(), [key]: value } as SettingsState)
     saveToDatabase(settings)
     // Notify main process of channel change
     if (key === 'updateChannel' && window.updaterOps?.setChannel) {
       window.updaterOps.setChannel(value as string)
     }
   }
   ```

### Verification

- Run `pnpm build` — no type errors.
- Run `pnpm lint` — clean.
- The setting now persists to localStorage + SQLite and triggers the main-process channel switch.

---

## Session 3: Settings UI — Updates Panel

**Goal:** Create a new "Updates" section in the settings modal where users can see their current version, pick stable/canary channel, and manually check for updates.

### Files to create

#### `src/renderer/src/components/settings/SettingsUpdates.tsx`

Create a new component with:

1. **Current version display** — call `window.updaterOps.getVersion()` in a `useEffect` on mount, store in local state. Show as "Version 1.0.18" (or "1.0.19-canary.2" for canary users).

2. **Update channel selector** — two buttons (same pattern as the "Branch Naming" dogs/cats toggle in `SettingsGeneral.tsx`):
   - **Stable** — "Tested, production-ready releases"
   - **Canary** — "Latest features, may contain bugs"
   - Read/write via `useSettingsStore` `updateChannel` / `updateSetting('updateChannel', ...)`

3. **Check for updates button** — calls `window.updaterOps.checkForUpdate()`, shows a loading spinner briefly. Use the existing `Button` component from `@/components/ui/button`.

4. Follow the exact same code patterns as `SettingsGeneral.tsx` for toggles and layout. Use `cn()` for conditional classNames.

Structure:

```tsx
import { useState, useEffect } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { RefreshCw } from 'lucide-react'

export function SettingsUpdates(): React.JSX.Element {
  const { updateChannel, updateSetting } = useSettingsStore()
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.updaterOps
      ?.getVersion()
      .then(setVersion)
      .catch(() => {})
  }, [])

  const handleCheckForUpdates = async (): Promise<void> => {
    setChecking(true)
    try {
      await window.updaterOps?.checkForUpdate()
    } catch {
      /* ignored */
    }
    setTimeout(() => setChecking(false), 2000)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Updates</h3>
        <p className="text-sm text-muted-foreground">Manage how Hive updates itself</p>
      </div>

      {/* Version display */}
      {version && (
        <div className="text-sm text-muted-foreground">
          Current version: <span className="font-mono text-foreground">{version}</span>
        </div>
      )}

      {/* Channel selector — same pattern as Branch Naming in SettingsGeneral */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Update Channel</label>
        <p className="text-xs text-muted-foreground">
          Choose which release channel to receive updates from
        </p>
        <div className="flex gap-2">
          {/* Stable button */}
          <button
            onClick={() => updateSetting('updateChannel', 'stable')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              updateChannel === 'stable'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="update-channel-stable"
          >
            Stable
          </button>
          {/* Canary button */}
          <button
            onClick={() => updateSetting('updateChannel', 'canary')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              updateChannel === 'canary'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="update-channel-canary"
          >
            Canary
          </button>
        </div>
        {/* Description of selected channel */}
        <p className="text-xs text-muted-foreground">
          {updateChannel === 'canary'
            ? 'You will receive early builds with the latest features. These may contain bugs.'
            : 'You will receive stable, tested releases.'}
        </p>
      </div>

      {/* Check for updates */}
      <div className="pt-4 border-t">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheckForUpdates}
          disabled={checking}
          data-testid="check-for-updates"
        >
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', checking && 'animate-spin')} />
          {checking ? 'Checking...' : 'Check for Updates'}
        </Button>
      </div>
    </div>
  )
}
```

### Files to modify

#### `src/renderer/src/components/settings/SettingsModal.tsx`

1. Add import:

   ```ts
   import { SettingsUpdates } from './SettingsUpdates'
   ```

2. Add `Download` to the lucide-react import (or `RefreshCw` — pick whichever icon fits better alongside the existing ones).

3. Add to the `SECTIONS` array (at the end, before `shortcuts`, or after `general` — your call):

   ```ts
   { id: 'updates', label: 'Updates', icon: Download }
   ```

4. Add the render case in the content area:
   ```tsx
   {
     activeSection === 'updates' && <SettingsUpdates />
   }
   ```

### Verification

- Run `pnpm build` — clean.
- Run `pnpm lint` — clean.
- Run `pnpm dev`, open Settings, confirm the "Updates" tab appears with version, channel toggle, and check button.

---

## Session 4: Canary Release Script

**Goal:** Create `scripts/release-canary.sh` and add the `release:canary` npm script. This is the script you run locally to cut a canary release.

### Files to create

#### `scripts/release-canary.sh`

The script follows the same structure as `release.sh` but with these differences:

- **No branch restriction** — canary can be released from any branch.
- **Auto-incremented canary version** — reads the current base version from `package.json`, looks at existing `v*-canary.*` tags to find the next number.
- **GitHub Release is marked as prerelease.**
- **electron-builder gets `-c.publish.channel=canary`** so it produces `canary-mac.yml`.
- **Updates `hive-canary.rb`** instead of `hive.rb`.
- **Simpler release notes** — just "Canary build from branch {branch} at {short-sha}".

Full script outline (6 phases, matching stable script structure):

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Colors & helpers (same as release.sh) ─────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}▶${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1" >&2; }
fatal() { err "$1"; exit 1; }

# ── Constants ─────────────────────────────────────────────────────
REPO="morapelker/hive"
GHOSTTY_DEPS_TAG="ghostty-deps-v1"
HOMEBREW_REPO="${HOMEBREW_REPO:-$HOME/Documents/dev/hive-brew}"
HOMEBREW_CASK="Casks/hive-canary.rb"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Phase 1: Preflight ───────────────────────────────────────────
# - Check gh auth, clean working tree, .env.signing
# - NO branch restriction (canary can ship from any branch)
# - Compute next canary version:
#     BASE_VERSION = current version from package.json (strip any existing prerelease)
#     Find highest existing tag matching v${BASE_VERSION}-canary.*
#     Increment: CANARY_NUM = highest + 1 (or 1 if none exist)
#     NEW_VERSION = "${BASE_VERSION}-canary.${CANARY_NUM}"
# - Show plan, confirm

# ── Phase 2: Version bump + git ──────────────────────────────────
# - Update package.json to NEW_VERSION
# - git commit "canary: v${NEW_VERSION}"
# - git tag "v${NEW_VERSION}"
# - Push commit + tag

# ── Phase 3: Build ────────────────────────────────────────────────
# - Resolve libghostty.a (same logic as release.sh)
# - pnpm install --frozen-lockfile
# - pnpm build:native
# - pnpm build

# ── Phase 4: Package + Sign + Notarize + Publish ─────────────────
# - electron-builder --mac --publish always -c.publish.channel=canary
#   ^^^ This is the KEY difference — produces canary-mac.yml
# - gh release edit "v${NEW_VERSION}" --prerelease --draft=false
#   with notes: "Canary build from branch ${BRANCH} (${SHORT_SHA})"

# ── Phase 5: Update Homebrew canary cask ──────────────────────────
# - Same SHA256 computation as release.sh but writes to hive-canary.rb
# - Commit message: "Update Hive Canary to v${NEW_VERSION}"

# ── Phase 6: Summary ─────────────────────────────────────────────
# - Print release URL, homebrew canary install command, assets list
```

**Version computation detail** (the trickiest part):

```bash
# Strip any existing prerelease suffix to get base version
BASE_VERSION=$(node -p "require('./package.json').version.replace(/-.*/, '')")

# Find the highest canary number for this base version
LATEST_CANARY=$(git tag -l "v${BASE_VERSION}-canary.*" | \
  sed "s/v${BASE_VERSION}-canary\.//" | \
  sort -n | tail -1)
CANARY_NUM=$(( ${LATEST_CANARY:-0} + 1 ))
NEW_VERSION="${BASE_VERSION}-canary.${CANARY_NUM}"
```

### Files to modify

#### `package.json`

Add to `"scripts"`:

```json
"release:canary": "bash scripts/release-canary.sh"
```

### Files to create (external repo)

#### `/Users/mor/Documents/dev/hive-brew/Casks/hive-canary.rb`

```ruby
cask "hive-canary" do
  version "0.0.0"

  on_arm do
    sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    url "https://github.com/morapelker/hive/releases/download/v#{version}/Hive-#{version}-arm64.dmg"
  end

  on_intel do
    sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    url "https://github.com/morapelker/hive/releases/download/v#{version}/Hive-#{version}.dmg"
  end

  name "Hive Canary"
  homepage "https://github.com/morapelker/hive"
  app "Hive.app"

  conflicts_with cask: "hive"
end
```

This is a placeholder — the first `pnpm release:canary` run will populate real values.

### Verification

- Run `bash -n scripts/release-canary.sh` to syntax-check without executing.
- Optionally do a dry run: add a `--dry-run` flag that skips git push, electron-builder publish, and homebrew push, but prints what it would do.
- The first real canary release will be the true end-to-end test.

---

## Session 5: Post-Release Version Restore (Optional Enhancement)

**Goal:** After a canary release, restore `package.json` to the base version so the working tree stays clean for development.

### Why

After `release-canary.sh` sets `package.json` to `1.0.19-canary.3`, the next `git status` shows a dirty tree with a canary version. The stable `release.sh` script expects a clean base version.

### Approach

At the end of `release-canary.sh` Phase 2 (after pushing the tag), restore the version:

```bash
# Restore base version in package.json for continued development
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '${BASE_VERSION}';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
git add package.json
git commit -m "chore: restore version to ${BASE_VERSION} after canary release"
git push origin "$CURRENT_BRANCH"
```

This way the canary version only exists in the tagged commit, and the working branch stays on the base version.

### Alternative

Skip this entirely. The canary version in `package.json` is harmless — the stable release script prompts for a new version anyway. Only implement if the dirty-version-in-tree bothers you.

---

## Session 6: Testing & Verification

**Goal:** Verify the full flow works end-to-end.

### Manual test plan

1. **Settings UI test:**
   - `pnpm dev`
   - Open Settings > Updates tab
   - Confirm version displays (will show dev version or empty in dev mode)
   - Toggle between Stable and Canary — confirm the toggle visuals work
   - Click "Check for Updates" — confirm button shows loading state

2. **Build test:**
   - `pnpm build` — no errors
   - `pnpm lint` — clean

3. **Canary release dry run:**
   - Run `pnpm release:canary` (or add `--dry-run` flag)
   - Confirm version computation is correct
   - Confirm it would tag with `-canary.N` suffix
   - Confirm electron-builder would get `-c.publish.channel=canary`

4. **First real canary release:**
   - Run `pnpm release:canary` for real
   - Verify GitHub Release is marked as prerelease
   - Verify `canary-mac.yml` exists in the release assets
   - Verify `hive-canary.rb` was updated in the homebrew repo

5. **Update channel switch test (requires two published releases):**
   - Install the stable build
   - Open Settings > Updates, switch to Canary
   - Confirm the app checks for and finds the canary update
   - Install the canary update, confirm version shows canary suffix
   - Switch back to Stable, confirm downgrade is offered

---

## Quick Reference

| Command                                           | What it does              |
| ------------------------------------------------- | ------------------------- |
| `pnpm release`                                    | Stable release (existing) |
| `pnpm release:canary`                             | Canary release (new)      |
| `brew install --cask morapelker/hive/hive`        | Install stable (existing) |
| `brew install --cask morapelker/hive/hive-canary` | Install canary (new)      |

| electron-updater channel | Manifest file    | Versions matched         |
| ------------------------ | ---------------- | ------------------------ |
| `latest` (default)       | `latest-mac.yml` | `1.0.18`, `1.0.19`, etc. |
| `canary`                 | `canary-mac.yml` | `1.0.19-canary.1`, etc.  |
