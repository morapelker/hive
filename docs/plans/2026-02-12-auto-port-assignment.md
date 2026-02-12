# Auto Port Assignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically assign unique dev server ports per worktree and inject `PORT=NNNN` into run/setup scripts, sharing a JSON registry file (`~/.playwright-mcp-ports.json`) with the existing Python `get-port.py` script.

**Architecture:** A `PortRegistry` service in the main process reads/writes `~/.playwright-mcp-ports.json` using the same logic as the Python script (start at 3011, assign next free, clean up stale dirs). A per-project boolean `auto_assign_port` (DB column) controls whether new worktrees get ports auto-assigned. The JSON file is the **single source of truth** for port assignments -- no port data in the DB. Port lookup and env injection happen entirely in the main process inside the script handlers, so the renderer doesn't need to know about ports at all (except a display badge).

**Tech Stack:** TypeScript, Node.js `fs`, SQLite migration (one column), React/Zustand UI

---

## Task 1: Create the PortRegistry service

**Files:**

- Create: `src/main/services/port-registry.ts`

Mirrors the Python script's logic exactly. Same file, same format, same port range.

**Step 1: Create the service file**

```typescript
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger'

const log = createLogger({ component: 'PortRegistry' })

const REGISTRY_PATH = join(homedir(), '.playwright-mcp-ports.json')
const START_PORT = 3011

type Registry = Record<string, number>

function loadRegistry(): Registry {
  try {
    if (existsSync(REGISTRY_PATH)) {
      const raw = readFileSync(REGISTRY_PATH, 'utf-8')
      return JSON.parse(raw) as Registry
    }
  } catch (error) {
    log.warn('Failed to load port registry, starting fresh', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
  return {}
}

function saveRegistry(registry: Registry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
}

function cleanupRegistry(registry: Registry): Registry {
  const cleaned: Registry = {}
  for (const [dir, port] of Object.entries(registry)) {
    try {
      const stat = statSync(dir)
      if (stat.isDirectory()) {
        cleaned[dir] = port
      }
    } catch {
      // Directory doesn't exist, skip it
    }
  }
  return cleaned
}

function findNextPort(registry: Registry): number {
  const used = new Set(Object.values(registry))
  let port = START_PORT
  while (used.has(port)) {
    port++
  }
  return port
}

/**
 * Assign a port for the given directory path.
 * If already registered, returns the existing port.
 * If not, assigns the next available port starting from 3011.
 * Cleans up stale entries (directories that no longer exist).
 */
export function assignPort(directoryPath: string): number {
  const registry = cleanupRegistry(loadRegistry())

  if (registry[directoryPath] !== undefined) {
    log.info('Port already assigned', { directoryPath, port: registry[directoryPath] })
    return registry[directoryPath]
  }

  const port = findNextPort(registry)
  registry[directoryPath] = port
  saveRegistry(registry)
  log.info('Assigned new port', { directoryPath, port })
  return port
}

/**
 * Release a port assignment for a directory.
 * Called when a worktree is archived/deleted.
 */
export function releasePort(directoryPath: string): void {
  const registry = loadRegistry()
  if (registry[directoryPath] !== undefined) {
    delete registry[directoryPath]
    saveRegistry(registry)
    log.info('Released port', { directoryPath })
  }
}

/**
 * Get the currently assigned port for a directory, or null if none.
 */
export function getAssignedPort(directoryPath: string): number | null {
  const registry = loadRegistry()
  return registry[directoryPath] ?? null
}
```

**Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit --pretty`

**Step 3: Commit**

```bash
git add src/main/services/port-registry.ts
git commit -m "feat: add PortRegistry service for auto port assignment"
```

---

## Task 2: Add database migration for `auto_assign_port`

Only one column needed. The JSON file stores the actual port assignments -- no port data in the DB.

**Files:**

- Modify: `src/main/db/schema.ts` (bump version 14 → 15, add migration)
- Modify: `src/main/db/types.ts` (add field to `Project`, `ProjectUpdate`)
- Modify: `src/preload/index.d.ts` (add field to renderer `Project`, `window.db.project.update`)

**Step 1: Add migration 15 in `schema.ts`**

Bump `CURRENT_SCHEMA_VERSION` from `14` to `15`.

Append to the `MIGRATIONS` array:

```typescript
{
  version: 15,
  name: 'add_auto_assign_port',
  up: 'ALTER TABLE projects ADD COLUMN auto_assign_port INTEGER NOT NULL DEFAULT 0;',
  down: ''
}
```

**Step 2: Update `src/main/db/types.ts`**

Add to `Project` interface (after `archive_script`):

```typescript
auto_assign_port: boolean
```

Add to `ProjectUpdate` interface (after `archive_script`):

```typescript
auto_assign_port?: boolean
```

**Step 3: Update `src/preload/index.d.ts`**

Add `auto_assign_port: boolean` to the renderer `Project` interface (after `archive_script`, line ~12).

Add `auto_assign_port?: boolean` to the `window.db.project.update` data parameter (after `archive_script`, line ~133).

**Step 4: Verify it compiles**

Run: `pnpm exec tsc --noEmit --pretty`

**Step 5: Commit**

```bash
git add src/main/db/schema.ts src/main/db/types.ts src/preload/index.d.ts
git commit -m "feat: add auto_assign_port column to projects table"
```

---

## Task 3: Assign port on worktree creation

When a worktree is created for a project with `auto_assign_port` enabled, register the worktree path in the JSON registry.

**Files:**

- Modify: `src/main/ipc/worktree-handlers.ts`

**Step 1: Update `worktree:create` handler**

After the worktree is created in the database (around line 80-90), add:

```typescript
// Auto-assign port if project has it enabled
const project = db.getProject(projectId)
if (project && project.auto_assign_port) {
  const { assignPort } = await import('../services/port-registry')
  const port = assignPort(worktree.path)
  log.info('Auto-assigned port to new worktree', {
    worktreeId: worktree.id,
    path: worktree.path,
    port
  })
}
```

Do the same for `worktree:duplicate` and `worktree:createFromBranch` handlers.

**Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit --pretty`

**Step 3: Commit**

```bash
git add src/main/ipc/worktree-handlers.ts
git commit -m "feat: assign port on worktree creation when auto_assign_port enabled"
```

---

## Task 4: Inject PORT env var in script handlers (main process)

This is the core of the feature. The script handlers already receive `worktreeId`. They can look up the worktree to get the path, then look up the port from the JSON registry, and pass it to ScriptRunner as an extra env var. The renderer doesn't need to change at all.

**Files:**

- Modify: `src/main/services/script-runner.ts` (accept `extraEnv` parameter)
- Modify: `src/main/ipc/script-handlers.ts` (look up port, pass to ScriptRunner)

**Step 1: Add `extraEnv` parameter to ScriptRunner methods**

In `script-runner.ts`, update `runSequential`, `runPersistent`, and their internal helpers:

```typescript
async runSequential(
  commands: string[],
  cwd: string,
  eventKey: string,
  extraEnv?: Record<string, string>
): Promise<SequentialResult>
```

```typescript
async runPersistent(
  commands: string[],
  cwd: string,
  eventKey: string,
  extraEnv?: Record<string, string>
): Promise<PersistentHandle>
```

Update `execCommand` to accept and merge `extraEnv`:

```typescript
private execCommand(
  command: string,
  cwd: string,
  eventKey: string,
  extraEnv?: Record<string, string>
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], {
      cwd,
      env: { ...getColorEnv(), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // ... rest unchanged
```

Same merge in `runPersistent`'s spawn call:

```typescript
const proc = spawn('sh', ['-c', combined], {
  cwd,
  env: { ...getColorEnv(), ...extraEnv },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32'
})
```

Pass `extraEnv` through from `runSequential` → `execCommand`.

**Step 2: Build port env in script-handlers.ts**

Import the registry and database at the top of `script-handlers.ts`:

```typescript
import { getAssignedPort, assignPort } from '../services/port-registry'
import { getDatabase } from '../db'
```

Create a helper function that resolves the port env for a worktree:

```typescript
function resolvePortEnv(worktreeId: string, cwd: string): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    const db = getDatabase()
    const worktree = db.getWorktree(worktreeId)
    if (!worktree) return env

    const project = db.getProject(worktree.project_id)
    if (!project?.auto_assign_port) return env

    // Lazy assignment: if auto_assign_port is enabled but no port registered yet, assign one
    let port = getAssignedPort(cwd)
    if (port === null) {
      port = assignPort(cwd)
      log.info('Lazy-assigned port for worktree', { worktreeId, cwd, port })
    }

    env.PORT = String(port)
  } catch (error) {
    log.warn('Failed to resolve port env', {
      worktreeId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  return env
}
```

Then use it in the handlers:

```typescript
// In script:runProject handler:
const portEnv = resolvePortEnv(worktreeId, cwd)
const handle = await scriptRunner.runPersistent(commands, cwd, `script:run:${worktreeId}`, portEnv)

// In script:runSetup handler:
const portEnv = resolvePortEnv(worktreeId, cwd)
const result = await scriptRunner.runSequential(
  commands,
  cwd,
  `script:setup:${worktreeId}`,
  portEnv
)
```

Note the lazy assignment: if a user enables `auto_assign_port` on a project with existing worktrees, the port gets assigned on first script run. No retroactive migration needed.

**Step 3: Verify it compiles**

Run: `pnpm exec tsc --noEmit --pretty`

**Step 4: Commit**

```bash
git add src/main/services/script-runner.ts src/main/ipc/script-handlers.ts
git commit -m "feat: inject PORT env var into scripts for auto-port projects"
```

---

## Task 5: Release port on worktree archive

**Files:**

- Modify: `src/main/ipc/worktree-handlers.ts`

**Step 1: Update archive handler**

In the `worktree:archive` handler, before or after the worktree directory is removed, release the port. The handler already has the worktree path available:

```typescript
import { releasePort } from '../services/port-registry'

// In the archive handler, after getting the worktree info:
releasePort(worktreePath)
```

No need to check `auto_assign_port` -- if the path isn't in the registry, `releasePort` is a no-op.

**Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit --pretty`

**Step 3: Commit**

```bash
git add src/main/ipc/worktree-handlers.ts
git commit -m "feat: release port assignment when worktree is archived"
```

---

## Task 6: Add UI toggle in ProjectSettingsDialog

**Files:**

- Modify: `src/renderer/src/components/projects/ProjectSettingsDialog.tsx`

**Step 1: Add Switch component if missing**

Check if `src/renderer/src/components/ui/switch.tsx` exists. If not:

Run: `pnpm dlx shadcn@latest add switch`

**Step 2: Add the toggle to the dialog**

Add state:

```typescript
const [autoAssignPort, setAutoAssignPort] = useState(false)
```

In the `useEffect` that loads values on open, add:

```typescript
setAutoAssignPort(project.auto_assign_port ?? false)
```

Update the local `Project` interface at the top to include:

```typescript
auto_assign_port: boolean
```

Update the `useEffect` dependency array to include `project.auto_assign_port`.

In `handleSave`, include:

```typescript
const success = await updateProject(project.id, {
  setup_script: setupScript.trim() || null,
  run_script: runScript.trim() || null,
  archive_script: archiveScript.trim() || null,
  custom_icon: customIcon,
  auto_assign_port: autoAssignPort
})
```

Add the UI between the Project Icon section and Setup Script section:

```tsx
{
  /* Auto Port Assignment */
}
;<div className="space-y-1.5">
  <div className="flex items-center justify-between">
    <div>
      <label className="text-sm font-medium">Auto-assign Port</label>
      <p className="text-xs text-muted-foreground">
        Assign a unique port to each worktree and inject PORT into run/setup scripts. Ports start at
        3011.
      </p>
    </div>
    <Switch checked={autoAssignPort} onCheckedChange={setAutoAssignPort} />
  </div>
</div>
```

Import at top:

```typescript
import { Switch } from '@/components/ui/switch'
```

**Step 3: Verify it compiles**

Run: `pnpm exec tsc --noEmit --pretty`

**Step 4: Commit**

```bash
git add src/renderer/src/components/projects/ProjectSettingsDialog.tsx
git commit -m "feat: add auto-assign port toggle in project settings UI"
```

---

## Task 7: Display assigned port in RunTab

The renderer needs a way to query the port for display. Add a lightweight IPC call.

**Files:**

- Modify: `src/main/ipc/script-handlers.ts` (add `port:get` handler)
- Modify: `src/preload/index.ts` (expose `scriptOps.getPort`)
- Modify: `src/preload/index.d.ts` (add type)
- Modify: `src/renderer/src/components/layout/RunTab.tsx` (show badge)

**Step 1: Add IPC handler**

In `script-handlers.ts`, inside `registerScriptHandlers`:

```typescript
ipcMain.handle('port:get', async (_event, { cwd }: { cwd: string }) => {
  const { getAssignedPort } = await import('../services/port-registry')
  return { port: getAssignedPort(cwd) }
})
```

**Step 2: Expose in preload**

In `src/preload/index.ts`, add to `scriptOps`:

```typescript
getPort: (cwd: string): Promise<{ port: number | null }> =>
  ipcRenderer.invoke('port:get', { cwd }),
```

In `src/preload/index.d.ts`, add to `scriptOps`:

```typescript
getPort: (cwd: string) => Promise<{ port: number | null }>
```

**Step 3: Show in RunTab**

Add state and fetch the port when the worktree changes:

```typescript
const [assignedPort, setAssignedPort] = useState<number | null>(null)

useEffect(() => {
  const cwd = getWorktreePath()
  if (!cwd) {
    setAssignedPort(null)
    return
  }
  window.scriptOps.getPort(cwd).then(({ port }) => setAssignedPort(port))
}, [worktreeId, getWorktreePath])
```

In the status bar, after the running/stopped indicator:

```tsx
{
  assignedPort && <span className="text-muted-foreground ml-2 font-mono">PORT={assignedPort}</span>
}
```

**Step 4: Verify it compiles**

Run: `pnpm exec tsc --noEmit --pretty`

**Step 5: Commit**

```bash
git add src/main/ipc/script-handlers.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/components/layout/RunTab.tsx
git commit -m "feat: show assigned port badge in run tab"
```

---

## Task 8: Final verification

**Step 1: Run type check**

Run: `pnpm exec tsc --noEmit --pretty`
Expected: No errors.

**Step 2: Run lint**

Run: `pnpm lint`
Expected: No errors (fix any that appear).

**Step 3: Run tests**

Run: `pnpm test`
Expected: All existing tests pass.

**Step 4: Manual verification**

1. Start dev: `pnpm dev`
2. Open a project's settings dialog
3. Enable "Auto-assign Port"
4. Create a new worktree -- verify `~/.playwright-mcp-ports.json` gets a new entry
5. Run the project (Cmd+R) -- verify PORT is injected (add `echo $PORT` as first line of run script to confirm)
6. Verify the `PORT=3011` badge shows in the RunTab status bar
7. Archive the worktree -- verify the entry is removed from the JSON file
8. Enable auto-assign on a project with existing worktrees, run -- verify lazy assignment works
9. Run the Python script from a directory and verify it shares the same registry file

**Step 5: Final commit if any fixups needed**

```bash
git add -A
git commit -m "chore: final cleanup for auto port assignment feature"
```

---

## Summary of Changes

| Layer             | File                                 | Change                                                                                                                |
| ----------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Service           | `src/main/services/port-registry.ts` | **New.** Registry read/write/assign/release, mirrors get-port.py                                                      |
| DB Schema         | `src/main/db/schema.ts`              | Migration 15: `auto_assign_port` on projects (one column)                                                             |
| DB Types          | `src/main/db/types.ts`               | Add `auto_assign_port` to `Project`, `ProjectUpdate`                                                                  |
| Preload Types     | `src/preload/index.d.ts`             | Add `auto_assign_port` to `Project`, update API; add `getPort` to scriptOps                                           |
| Preload Bridge    | `src/preload/index.ts`               | Add `getPort` to scriptOps                                                                                            |
| Script Runner     | `src/main/services/script-runner.ts` | Accept `extraEnv` in `runSequential`/`runPersistent`                                                                  |
| Script Handlers   | `src/main/ipc/script-handlers.ts`    | `resolvePortEnv()` helper: look up project flag + JSON registry, pass to ScriptRunner; `port:get` handler for display |
| Worktree Handlers | `src/main/ipc/worktree-handlers.ts`  | `assignPort()` on create; `releasePort()` on archive                                                                  |
| UI                | `ProjectSettingsDialog.tsx`          | Switch toggle for `auto_assign_port`                                                                                  |
| UI                | `RunTab.tsx`                         | `PORT=NNNN` badge in status bar                                                                                       |

### What's NOT in the DB

Port assignments live exclusively in `~/.playwright-mcp-ports.json`. The DB only stores the boolean preference (`auto_assign_port`). This means:

- The JSON file is the single source of truth, shared with get-port.py
- No sync issues between two data stores
- Lazy assignment handles existing worktrees without migration
- `releasePort` on archive is a simple JSON file edit
