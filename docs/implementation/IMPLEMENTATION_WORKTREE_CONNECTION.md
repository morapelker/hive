# Hive Worktree Connections Implementation Plan

This document outlines the implementation plan for Worktree Connections, covering database schema, filesystem operations, IPC handlers, renderer stores, sidebar UI, session integration, and the connect dialog.

---

## Overview

The implementation is divided into **10 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

**Refer to:** `docs/prd/PRD_WORKTREE_CONNECTION.md` for full product requirements.

---

## Dependencies & Parallelization

```
Session 1  (DB Schema & Migration)                -- no deps
Session 2  (Connection Service: Filesystem)        -- no deps
Session 3  (Connection IPC Handlers)               -- blocked by Sessions 1, 2
Session 4  (Preload Bridge & Types)                -- blocked by Session 3
Session 5  (Connection Store)                      -- blocked by Session 4
Session 6  (Session Store: Connection Support)     -- blocked by Sessions 1, 4
Session 7  (Connect Dialog UI)                     -- blocked by Session 5
Session 8  (Sidebar: ConnectionList & ConnectionItem) -- blocked by Sessions 5, 6
Session 9  (SessionView & MainPane Integration)    -- blocked by Sessions 6, 8
Session 10 (Worktree Archive Cascade & Verification) -- blocked by Sessions 1-9
```

### Parallel Tracks

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Time →                                                                      │
│                                                                              │
│  Track A: [S1: DB Schema] ──────────────────────┐                            │
│  Track B: [S2: Filesystem Service] ─────────────┤                            │
│                                                  ▼                           │
│                                       [S3: IPC Handlers]                     │
│                                                  │                           │
│                                       [S4: Preload & Types]                  │
│                                            ┌─────┴─────┐                     │
│                                            ▼           ▼                     │
│                                   [S5: Connection   [S6: Session             │
│                                    Store]            Store]                  │
│                                      │    ╲         ╱   │                    │
│                                      ▼     ╲       ╱    ▼                    │
│                             [S7: Connect  [S8: Sidebar]                      │
│                              Dialog]         │                               │
│                                              ▼                               │
│                                    [S9: SessionView &                        │
│                                     MainPane]                                │
│                                              │                               │
│                                    [S10: Archive Cascade                     │
│                                     & Verification]                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Maximum parallelism**: Sessions 1 and 2 are fully independent.

**Minimum total**: 8 rounds (mostly sequential due to layered dependencies).

**Recommended serial order**: S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10

Rationale: Each layer depends on the one below it. S1 and S2 can run in parallel. Everything else chains through IPC → preload → store → UI.

---

## Testing Infrastructure

### Test File Structure

```
test/
├── worktree-connection/
│   ├── session-1/
│   │   └── connection-schema.test.ts
│   ├── session-2/
│   │   └── connection-service.test.ts
│   ├── session-3/
│   │   └── connection-handlers.test.ts
│   ├── session-4/
│   │   └── connection-preload.test.ts
│   ├── session-5/
│   │   └── connection-store.test.ts
│   ├── session-6/
│   │   └── session-store-connections.test.ts
│   ├── session-7/
│   │   └── connect-dialog.test.tsx
│   ├── session-8/
│   │   └── sidebar-connections.test.tsx
│   ├── session-9/
│   │   └── session-view-connections.test.tsx
│   └── session-10/
│       └── archive-cascade-integration.test.ts
```

### New Dependencies

```bash
# No new dependencies -- all features use existing packages:
# - better-sqlite3 (database -- already installed)
# - zustand (stores -- already installed)
# - lucide-react (icons -- already installed)
# - sonner (toasts -- already installed)
# - Node.js fs (symlinks -- built-in)
```

---

## Session 1: Database Schema & Migration

### Objectives

- Add `connections` and `connection_members` tables
- Add `connection_id` column to the `sessions` table
- Make `project_id` nullable on `sessions` for connection-scoped sessions
- Bump `CURRENT_SCHEMA_VERSION` to 2

### Tasks

#### 1. Add migration to `schema.ts`

In `src/main/db/schema.ts`, bump `CURRENT_SCHEMA_VERSION` to `2` and append a new migration to the `MIGRATIONS` array:

```typescript
{
  version: 2,
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connection_members (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        symlink_name TEXT NOT NULL,
        added_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE,
        FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_connection_members_connection ON connection_members(connection_id);
      CREATE INDEX idx_connection_members_worktree ON connection_members(worktree_id);
    `)

    // Add connection_id to sessions, make project_id nullable for connection sessions
    db.exec(`
      ALTER TABLE sessions ADD COLUMN connection_id TEXT DEFAULT NULL
        REFERENCES connections(id) ON DELETE SET NULL;
      CREATE INDEX idx_sessions_connection ON sessions(connection_id);
    `)
  }
}
```

Note: SQLite does not support `ALTER COLUMN` to make `project_id` nullable. Since the column was created as `NOT NULL`, connection sessions should use a sentinel project_id from the first member. This avoids a table rebuild. See Open Question 1 in the PRD -- resolve by picking the first member's `project_id` as the session's `project_id`.

#### 2. Add CRUD methods to `database.ts`

In `src/main/db/database.ts`, add methods for the new tables:

- `createConnection(data: ConnectionCreate): Connection`
- `getConnection(id: string): ConnectionWithMembers | null`
- `getAllConnections(): ConnectionWithMembers[]`
- `updateConnection(id: string, data: Partial<Connection>): void`
- `deleteConnection(id: string): void`
- `createConnectionMember(data: ConnectionMemberCreate): ConnectionMember`
- `deleteConnectionMember(connectionId: string, worktreeId: string): void`
- `getConnectionMembersByWorktree(worktreeId: string): ConnectionMember[]`
- `getActiveSessionsByConnection(connectionId: string): Session[]`

The `getConnection` and `getAllConnections` methods should JOIN with `connection_members`, `worktrees`, and `projects` to return `ConnectionWithMembers` with enriched member data.

#### 3. Add DB types

In `src/main/db/types.ts`, add:

```typescript
interface ConnectionCreate {
  name: string
  path: string
}

interface ConnectionMemberCreate {
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
}
```

### Key Files

- `src/main/db/schema.ts` -- migration v2
- `src/main/db/database.ts` -- CRUD methods
- `src/main/db/types.ts` -- create/update types

### Definition of Done

- [ ] `CURRENT_SCHEMA_VERSION` is `2`
- [ ] `connections` table is created with id, name, path, status, timestamps
- [ ] `connection_members` table is created with FKs to connections, worktrees, projects
- [ ] `sessions` table has a `connection_id` column (nullable, FK to connections)
- [ ] Indexes exist on `connection_members.connection_id`, `connection_members.worktree_id`, `sessions.connection_id`
- [ ] All CRUD methods work: create, get, getAll, update, delete for connections and members
- [ ] `getConnection` returns enriched members with worktree name, branch, path, project name
- [ ] Deleting a connection cascades to `connection_members`
- [ ] Deleting a worktree cascades to its `connection_members` rows
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/worktree-connection/session-1/connection-schema.test.ts
describe('Session 1: Connection Schema', () => {
  test('connections table is created by migration', () => {
    // Run migration against in-memory SQLite
    // Verify table exists with correct columns
  })

  test('connection_members table has correct foreign keys', () => {
    // Insert a connection, then a member
    // Verify FK constraint: inserting member with invalid connection_id fails
  })

  test('deleting a connection cascades to members', () => {
    // Create connection + 2 members
    // Delete connection
    // Verify members are gone
  })

  test('deleting a worktree cascades to its connection_members', () => {
    // Create connection + member referencing worktree
    // Delete worktree
    // Verify member row is deleted, connection still exists
  })

  test('sessions.connection_id column exists and is nullable', () => {
    // Create a session with connection_id = null (existing behavior)
    // Create a session with connection_id set
    // Verify both work
  })

  test('getAllConnections returns enriched member data', () => {
    // Create connection with 2 members from different projects
    // Call getAllConnections
    // Verify each member has worktree_name, worktree_branch, project_name
  })
})
```

---

## Session 2: Connection Service (Filesystem Operations)

### Objectives

- Create `connection-service.ts` with all filesystem operations
- Implement directory creation, symlink management, and AGENTS.md generation
- Handle edge cases: parent dir creation, symlink name collisions, broken symlinks

### Tasks

#### 1. Create `connection-service.ts`

Create `src/main/services/connection-service.ts` with the following functions:

```typescript
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

const CONNECTIONS_BASE_DIR = path.join(app.getPath('home'), '.hive', 'connections')

export function getConnectionsBaseDir(): string {
  return CONNECTIONS_BASE_DIR
}

export function ensureConnectionsDir(): void {
  fs.mkdirSync(CONNECTIONS_BASE_DIR, { recursive: true })
}

export function createConnectionDir(name: string): string {
  ensureConnectionsDir()
  const dirPath = path.join(CONNECTIONS_BASE_DIR, name)
  fs.mkdirSync(dirPath, { recursive: true })
  return dirPath
}

export function deleteConnectionDir(connectionPath: string): void {
  if (fs.existsSync(connectionPath)) {
    fs.rmSync(connectionPath, { recursive: true, force: true })
  }
}

export function createSymlink(targetPath: string, symlinkPath: string): void {
  fs.symlinkSync(targetPath, symlinkPath, 'dir')
}

export function removeSymlink(symlinkPath: string): void {
  if (fs.existsSync(symlinkPath) || fs.lstatSync(symlinkPath).isSymbolicLink()) {
    fs.unlinkSync(symlinkPath)
  }
}

export function renameConnectionDir(oldPath: string, newPath: string): void {
  fs.renameSync(oldPath, newPath)
}
```

#### 2. Implement AGENTS.md generation

```typescript
interface AgentsMdMember {
  symlinkName: string
  projectName: string
  branchName: string
  worktreePath: string
}

export function generateAgentsMd(connectionPath: string, members: AgentsMdMember[]): void {
  const sections = members.map(
    (m) => `### ${m.symlinkName}/
- **Project:** ${m.projectName}
- **Branch:** ${m.branchName}
- **Path:** ${m.worktreePath}`
  )

  const content = `# Connected Worktrees

This workspace contains symlinked worktrees from multiple projects.
Each subdirectory is a separate git repository.

## Projects

${sections.join('\n\n')}

## Working in this workspace

- Each subdirectory is a fully independent git repo
- Make commits in each subdirectory separately
- Changes in one project do not affect the other
`

  fs.writeFileSync(path.join(connectionPath, 'AGENTS.md'), content, 'utf-8')
}
```

#### 3. Implement symlink name derivation

```typescript
export function deriveSymlinkName(projectName: string, existingNames: string[]): string {
  const base = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  if (!existingNames.includes(base)) return base
  let counter = 2
  while (existingNames.includes(`${base}-${counter}`)) counter++
  return `${base}-${counter}`
}
```

### Key Files

- `src/main/services/connection-service.ts` -- **new file**

### Definition of Done

- [ ] `createConnectionDir` creates `~/.hive/connections/{name}/` recursively
- [ ] `deleteConnectionDir` removes the entire connection folder
- [ ] `createSymlink` creates a directory symlink from target to link path
- [ ] `removeSymlink` safely removes a symlink (handles broken symlinks)
- [ ] `generateAgentsMd` writes a valid AGENTS.md with all member info
- [ ] `deriveSymlinkName` handles collisions by appending numeric suffixes
- [ ] `renameConnectionDir` renames the folder on disk
- [ ] `ensureConnectionsDir` creates parent dir if it does not exist
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/worktree-connection/session-2/connection-service.test.ts
describe('Session 2: Connection Service', () => {
  test('deriveSymlinkName returns lowercase hyphenated project name', () => {
    expect(deriveSymlinkName('My Frontend', [])).toBe('my-frontend')
  })

  test('deriveSymlinkName appends suffix on collision', () => {
    expect(deriveSymlinkName('backend', ['backend'])).toBe('backend-2')
    expect(deriveSymlinkName('backend', ['backend', 'backend-2'])).toBe('backend-3')
  })

  test('generateAgentsMd writes valid markdown with member sections', () => {
    // Call generateAgentsMd with 2 members
    // Read the file
    // Verify it contains both project sections
    // Verify the header and working instructions
  })

  test('createSymlink creates a working directory symlink', () => {
    // Create a temp dir as target
    // Create symlink
    // Verify fs.lstatSync(symlink).isSymbolicLink()
    // Verify reading through symlink works
  })

  test('removeSymlink handles broken symlinks', () => {
    // Create symlink to non-existent target
    // Call removeSymlink
    // Verify no error, symlink removed
  })

  test('createConnectionDir creates nested directories', () => {
    // Call with a name
    // Verify directory exists
  })
})
```

---

## Session 3: Connection IPC Handlers

### Objectives

- Create `connection-handlers.ts` with all IPC handlers for connection operations
- Wire up the connection service and database methods
- Register handlers in `src/main/index.ts`

### Tasks

#### 1. Create `connection-handlers.ts`

Create `src/main/ipc/connection-handlers.ts`:

```typescript
import { ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../db'
import {
  createConnectionDir,
  createSymlink,
  removeSymlink,
  deleteConnectionDir,
  generateAgentsMd,
  deriveSymlinkName,
  renameConnectionDir,
  getConnectionsBaseDir
} from '../services/connection-service'
import { selectUniqueBreedName } from '../services/breed-names'
import path from 'path'
```

Implement these handlers:

- **`connection:create`** -- Takes `{ worktreeIds: string[] }`. Generates breed name, creates dir, creates symlinks for each worktree, generates AGENTS.md, inserts DB rows. Returns `ConnectionWithMembers`.
- **`connection:delete`** -- Takes `{ connectionId: string }`. Deletes the filesystem directory, then the DB row (cascade handles members).
- **`connection:addMember`** -- Takes `{ connectionId: string, worktreeId: string }`. Looks up worktree and project, derives symlink name, creates symlink, inserts member row, regenerates AGENTS.md.
- **`connection:removeMember`** -- Takes `{ connectionId: string, worktreeId: string }`. Removes symlink, deletes member row, regenerates AGENTS.md. If no members remain, deletes the entire connection.
- **`connection:rename`** -- Takes `{ connectionId: string, name: string }`. Renames the folder on disk, updates DB.
- **`connection:getAll`** -- Returns all active connections with enriched members.
- **`connection:get`** -- Returns one connection with enriched members.
- **`connection:openInTerminal`** -- Reuse the existing terminal-opening logic from worktree handlers.
- **`connection:openInEditor`** -- Reuse the existing editor-opening logic.
- **`connection:removeWorktreeFromAll`** -- Takes `{ worktreeId: string }`. Finds all connections containing this worktree and removes it from each. Used by the archive cascade.

#### 2. Register in `src/main/index.ts`

Import and call the registration function from `connection-handlers.ts` where other handlers are registered.

### Key Files

- `src/main/ipc/connection-handlers.ts` -- **new file**
- `src/main/index.ts` -- register handlers

### Definition of Done

- [ ] `connection:create` generates breed name, creates dir + symlinks + AGENTS.md + DB rows
- [ ] `connection:delete` removes dir and DB row
- [ ] `connection:addMember` creates symlink, inserts member, regenerates AGENTS.md
- [ ] `connection:removeMember` removes symlink, deletes member, regenerates AGENTS.md
- [ ] `connection:removeMember` deletes the entire connection when last member is removed
- [ ] `connection:rename` renames folder on disk and updates DB
- [ ] `connection:getAll` returns enriched connections with member details
- [ ] `connection:openInTerminal` and `connection:openInEditor` work
- [ ] `connection:removeWorktreeFromAll` cleans up all connections for a given worktree
- [ ] All handlers wrap errors in try/catch and return `{ success: false, error }` on failure
- [ ] Handlers are registered in main process startup
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/worktree-connection/session-3/connection-handlers.test.ts
describe('Session 3: Connection IPC Handlers', () => {
  test('connection:create creates dir, symlinks, AGENTS.md, and DB rows', () => {
    // Mock database and filesystem
    // Call handler with 2 worktree IDs
    // Verify createConnectionDir called
    // Verify createSymlink called twice
    // Verify generateAgentsMd called
    // Verify DB insert for connection + 2 members
  })

  test('connection:delete removes directory and DB row', () => {
    // Mock existing connection
    // Call handler
    // Verify deleteConnectionDir called
    // Verify DB delete called
  })

  test('connection:addMember creates symlink and regenerates AGENTS.md', () => {
    // Mock existing connection with 1 member
    // Call addMember with new worktree
    // Verify symlink created
    // Verify member row inserted
    // Verify AGENTS.md regenerated with 2 members
  })

  test('connection:removeMember deletes connection when last member removed', () => {
    // Mock connection with 1 member
    // Call removeMember
    // Verify entire connection is deleted (dir + DB)
  })

  test('connection:removeWorktreeFromAll cleans up across connections', () => {
    // Mock worktree in 2 different connections
    // Call removeWorktreeFromAll
    // Verify member removed from both connections
  })
})
```

---

## Session 4: Preload Bridge & Type Declarations

### Objectives

- Add `Connection`, `ConnectionMember`, `ConnectionWithMembers` types to `index.d.ts`
- Add `connection_id` to the `Session` type
- Expose `window.connectionOps` namespace in the preload bridge
- Add connection-related methods to `window.db.session`

### Tasks

#### 1. Add types to `src/preload/index.d.ts`

```typescript
interface Connection {
  id: string
  name: string
  status: 'active' | 'archived'
  path: string
  created_at: string
  updated_at: string
}

interface ConnectionMember {
  id: string
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
  added_at: string
}

interface ConnectionWithMembers extends Connection {
  members: (ConnectionMember & {
    worktree_name: string
    worktree_branch: string
    worktree_path: string
    project_name: string
  })[]
}
```

Add `connection_id: string | null` to the existing `Session` interface.

#### 2. Add `connectionOps` to `Window` interface

```typescript
connectionOps: {
  create: (worktreeIds: string[]) => Promise<ConnectionWithMembers>
  delete: (connectionId: string) => Promise<{ success: boolean; error?: string }>
  addMember: (connectionId: string, worktreeId: string) => Promise<ConnectionMember>
  removeMember: (connectionId: string, worktreeId: string) => Promise<{ success: boolean }>
  rename: (connectionId: string, name: string) => Promise<{ success: boolean }>
  getAll: () => Promise<ConnectionWithMembers[]>
  get: (connectionId: string) => Promise<ConnectionWithMembers>
  openInTerminal: (connectionPath: string) => Promise<void>
  openInEditor: (connectionPath: string) => Promise<void>
  removeWorktreeFromAll: (worktreeId: string) => Promise<void>
}
```

#### 3. Add session connection methods to `window.db.session`

```typescript
getByConnection: (connectionId: string) => Promise<Session[]>
getActiveByConnection: (connectionId: string) => Promise<Session[]>
```

#### 4. Wire up in `src/preload/index.ts`

Add `connectionOps` context bridge:

```typescript
connectionOps: {
  create: (worktreeIds: string[]) =>
    ipcRenderer.invoke('connection:create', { worktreeIds }),
  delete: (connectionId: string) =>
    ipcRenderer.invoke('connection:delete', { connectionId }),
  addMember: (connectionId: string, worktreeId: string) =>
    ipcRenderer.invoke('connection:addMember', { connectionId, worktreeId }),
  removeMember: (connectionId: string, worktreeId: string) =>
    ipcRenderer.invoke('connection:removeMember', { connectionId, worktreeId }),
  rename: (connectionId: string, name: string) =>
    ipcRenderer.invoke('connection:rename', { connectionId, name }),
  getAll: () => ipcRenderer.invoke('connection:getAll'),
  get: (connectionId: string) =>
    ipcRenderer.invoke('connection:get', { connectionId }),
  openInTerminal: (connectionPath: string) =>
    ipcRenderer.invoke('connection:openInTerminal', { connectionPath }),
  openInEditor: (connectionPath: string) =>
    ipcRenderer.invoke('connection:openInEditor', { connectionPath }),
  removeWorktreeFromAll: (worktreeId: string) =>
    ipcRenderer.invoke('connection:removeWorktreeFromAll', { worktreeId })
}
```

Add session connection DB handlers in the existing `db.session` section.

### Key Files

- `src/preload/index.d.ts` -- types and window interface
- `src/preload/index.ts` -- context bridge wiring

### Definition of Done

- [ ] `Connection`, `ConnectionMember`, `ConnectionWithMembers` types are declared
- [ ] `Session` type includes `connection_id: string | null`
- [ ] `window.connectionOps` is fully typed and wired to IPC channels
- [ ] `window.db.session.getByConnection` and `getActiveByConnection` are exposed
- [ ] TypeScript compilation passes with no errors in preload files
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/worktree-connection/session-4/connection-preload.test.ts
describe('Session 4: Preload Bridge & Types', () => {
  test('connectionOps methods are exposed on window', () => {
    // Verify window.connectionOps.create is a function
    // Verify window.connectionOps.delete is a function
    // Verify window.connectionOps.getAll is a function
    // etc.
  })

  test('Session type accepts connection_id', () => {
    // TypeScript compilation check
    const session: Session = {
      // ... required fields
      connection_id: 'conn-1',
      worktree_id: null
    }
    expect(session.connection_id).toBe('conn-1')
  })

  test('Session type accepts null connection_id', () => {
    const session: Session = {
      // ... required fields
      connection_id: null,
      worktree_id: 'wt-1'
    }
    expect(session.connection_id).toBeNull()
  })
})
```

---

## Session 5: Connection Store (Zustand)

### Objectives

- Create `useConnectionStore` with state, actions, and persistence
- Handle loading, creating, deleting, adding/removing members, renaming, selecting
- Integrate selection deconfliction with `useWorktreeStore`

### Tasks

#### 1. Create `useConnectionStore.ts`

Create `src/renderer/src/stores/useConnectionStore.ts`:

```typescript
interface ConnectionState {
  connections: ConnectionWithMembers[]
  isLoading: boolean
  error: string | null
  selectedConnectionId: string | null

  // Actions
  loadConnections: () => Promise<void>
  createConnection: (worktreeIds: string[]) => Promise<string | null>
  deleteConnection: (connectionId: string) => Promise<void>
  addMember: (connectionId: string, worktreeId: string) => Promise<void>
  removeMember: (connectionId: string, worktreeId: string) => Promise<void>
  renameConnection: (connectionId: string, name: string) => Promise<void>
  selectConnection: (id: string | null) => void
}
```

Key implementation details:

- `loadConnections` calls `window.connectionOps.getAll()` and sets state
- `createConnection` calls `window.connectionOps.create()`, adds to local state, selects the new connection
- `deleteConnection` calls `window.connectionOps.delete()`, removes from state, clears selection if needed
- `selectConnection` sets `selectedConnectionId` AND clears `useWorktreeStore.selectedWorktreeId` to null (deconfliction)
- Use `persist` middleware to remember `selectedConnectionId` in localStorage

#### 2. Add deconfliction to `useWorktreeStore`

In `useWorktreeStore.selectWorktree`, add:

```typescript
// Clear any selected connection when a worktree is selected
useConnectionStore.getState().selectConnection(null)
```

This is a cross-store call. Import `useConnectionStore` lazily to avoid circular deps if needed.

#### 3. Export from barrel

Add `useConnectionStore` to `src/renderer/src/stores/index.ts`.

### Key Files

- `src/renderer/src/stores/useConnectionStore.ts` -- **new file**
- `src/renderer/src/stores/useWorktreeStore.ts` -- deconfliction in `selectWorktree`
- `src/renderer/src/stores/index.ts` -- barrel export

### Definition of Done

- [ ] `useConnectionStore` loads, creates, deletes, renames connections via IPC
- [ ] `addMember` and `removeMember` update local state and call IPC
- [ ] `selectConnection` deselects any active worktree
- [ ] `selectWorktree` deselects any active connection
- [ ] `selectedConnectionId` is persisted to localStorage
- [ ] The store handles errors gracefully (try/catch, toast on failure)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/worktree-connection/session-5/connection-store.test.ts
describe('Session 5: Connection Store', () => {
  test('loadConnections fetches from IPC and updates state', () => {
    // Mock window.connectionOps.getAll returning 2 connections
    // Call loadConnections
    // Verify state.connections has 2 entries
  })

  test('createConnection adds to state and selects it', () => {
    // Mock window.connectionOps.create
    // Call createConnection
    // Verify new connection in state
    // Verify selectedConnectionId is set
  })

  test('selectConnection clears selectedWorktreeId', () => {
    // Set selectedWorktreeId to 'wt-1'
    // Call selectConnection('conn-1')
    // Verify selectedWorktreeId is null
    // Verify selectedConnectionId is 'conn-1'
  })

  test('selectWorktree clears selectedConnectionId', () => {
    // Set selectedConnectionId to 'conn-1'
    // Call selectWorktree('wt-1')
    // Verify selectedConnectionId is null
  })

  test('deleteConnection removes from state and clears selection', () => {
    // Add connection, select it
    // Call deleteConnection
    // Verify removed from state
    // Verify selectedConnectionId is null
  })
})
```

---

## Session 6: Session Store -- Connection Support

### Objectives

- Add connection-scoped session maps to `useSessionStore`
- Add methods to load, create, close sessions for connections
- Add DB handlers for `getByConnection` and `getActiveByConnection`

### Tasks

#### 1. Add connection session state to `useSessionStore`

```typescript
// New state fields
sessionsByConnection: Map<string, Session[]>
tabOrderByConnection: Map<string, string[]>
activeSessionByConnection: Record<string, string> // persisted
```

#### 2. Add connection session actions

- `loadConnectionSessions(connectionId: string)` -- calls `window.db.session.getActiveByConnection(connectionId)`, populates `sessionsByConnection` and `tabOrderByConnection`
- `createConnectionSession(connectionId: string)` -- creates a session with `connection_id` set and `worktree_id` null. Determines `project_id` from the first member of the connection (query via `window.connectionOps.get()`). Adds to tab order, sets as active.
- `setActiveConnectionSession(sessionId: string)` -- sets active for connection context. Persists to `activeSessionByConnection`.
- `setActiveConnection(connectionId: string)` -- sets `activeConnectionId` in session store, restores last active session for that connection.

Reuse existing `closeSession`, `reorderTabs`, `toggleSessionMode` etc. by making them scope-agnostic (check whether session has `worktree_id` or `connection_id` to know which map to update).

#### 3. Add DB handlers for connection sessions

In `src/main/ipc/database-handlers.ts`:

```typescript
ipcMain.handle('db:session:getByConnection', async (_event, connectionId: string) => {
  return db.getSessionsByConnection(connectionId)
})

ipcMain.handle('db:session:getActiveByConnection', async (_event, connectionId: string) => {
  return db.getActiveSessionsByConnection(connectionId)
})
```

Add corresponding methods to `database.ts`.

#### 4. Persist `activeSessionByConnection`

Add to the Zustand `persist` middleware's `partialize`:

```typescript
partialize: (state) => ({
  activeSessionByWorktree: state.activeSessionByWorktree,
  activeSessionByConnection: state.activeSessionByConnection
})
```

### Key Files

- `src/renderer/src/stores/useSessionStore.ts` -- connection session maps and actions
- `src/main/ipc/database-handlers.ts` -- new DB handlers
- `src/main/db/database.ts` -- new query methods

### Definition of Done

- [ ] `sessionsByConnection` and `tabOrderByConnection` are maintained in parallel to worktree maps
- [ ] `createConnectionSession` creates a session with `connection_id` set, `worktree_id` null
- [ ] `loadConnectionSessions` loads active sessions for a connection
- [ ] Tab order and active session per connection are persisted
- [ ] Closing a connection session marks it completed and removes from tabs
- [ ] DB queries `getByConnection` and `getActiveByConnection` work correctly
- [ ] Existing worktree session behavior is completely unchanged
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### Testing Criteria

```typescript
// test/worktree-connection/session-6/session-store-connections.test.ts
describe('Session 6: Session Store Connection Support', () => {
  test('createConnectionSession sets connection_id and null worktree_id', () => {
    // Mock window.db.session.create
    // Call createConnectionSession('conn-1')
    // Verify create called with { connection_id: 'conn-1', worktree_id: null }
  })

  test('loadConnectionSessions populates sessionsByConnection', () => {
    // Mock getActiveByConnection returning 2 sessions
    // Call loadConnectionSessions
    // Verify sessionsByConnection.get('conn-1') has 2 entries
  })

  test('closing connection session removes from tabOrderByConnection', () => {
    // Create session, add to tabs
    // Close session
    // Verify removed from tabOrderByConnection
  })

  test('activeSessionByConnection persists across store resets', () => {
    // Set active connection session
    // Verify it survives localStorage round-trip
  })

  test('existing worktree session methods are unaffected', () => {
    // Create a worktree session
    // Verify sessionsByWorktree still works correctly
    // Verify sessionsByConnection is unaffected
  })
})
```

---

## Session 7: Connect Dialog UI

### Objectives

- Create `ConnectDialog` component that lets users pick worktrees from other projects
- Show worktrees grouped by project with breed name + project name
- Support both "create new connection" and "add to existing connection" flows
- Wire up to worktree context menu

### Tasks

#### 1. Create `ConnectDialog.tsx`

Create `src/renderer/src/components/connections/ConnectDialog.tsx`:

- A dialog/sheet component using shadcn `Dialog`
- Props: `sourceWorktreeId: string`, `open: boolean`, `onOpenChange: (open: boolean) => void`
- Lists all active worktrees from ALL projects except the source worktree's project
- Each item shows: checkbox, breed name, project name in parentheses
- Grouped by project with project name as group header
- "Connect" button at the bottom, disabled when no worktrees selected
- On submit: calls `useConnectionStore.createConnection([sourceWorktreeId, ...selectedIds])`

If existing connections are found (the source worktree is already in some connections, or there are connections it could be added to), show them above the worktree list as quick options under a "Add to existing connection" section.

#### 2. Add "Connect to..." to worktree context menu

In `src/renderer/src/components/worktrees/WorktreeItem.tsx`, add a new context menu item:

```tsx
<ContextMenuItem onClick={() => setConnectDialogOpen(true)}>
  <Link className="h-4 w-4 mr-2" />
  Connect to...
</ContextMenuItem>
```

Add state: `const [connectDialogOpen, setConnectDialogOpen] = useState(false)`

Render `<ConnectDialog>` at the component level.

#### 3. Create barrel export

Create `src/renderer/src/components/connections/index.ts` exporting `ConnectDialog`.

### Key Files

- `src/renderer/src/components/connections/ConnectDialog.tsx` -- **new file**
- `src/renderer/src/components/connections/index.ts` -- **new file**
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` -- context menu item

### Definition of Done

- [ ] "Connect to..." appears in worktree context menu
- [ ] Dialog opens showing worktrees from other projects, grouped by project
- [ ] Each worktree shows breed name + project name
- [ ] Multiple worktrees can be selected via checkboxes
- [ ] "Connect" button is disabled until at least one worktree is checked
- [ ] Submitting creates a connection and closes the dialog
- [ ] Toast confirms connection creation with the breed name
- [ ] Dialog supports adding to existing connections (shown as options above the list)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Right-click a worktree -- verify "Connect to..." menu item
2. Click it -- verify dialog opens with worktrees from other projects
3. Select one worktree + click Connect -- verify connection created, toast shown
4. Open sidebar -- verify new connection appears in Connections section
5. Right-click the same worktree again -- verify existing connection shown in dialog

### Testing Criteria

```typescript
// test/worktree-connection/session-7/connect-dialog.test.tsx
describe('Session 7: Connect Dialog', () => {
  test('renders worktrees grouped by project', () => {
    // Mock worktrees from 3 projects
    // Render dialog with source from project 1
    // Verify project 2 and 3 worktrees are shown
    // Verify project 1 worktrees are NOT shown
  })

  test('Connect button is disabled when nothing selected', () => {
    // Render dialog
    // Verify Connect button is disabled
  })

  test('selecting a worktree enables the Connect button', () => {
    // Render, click checkbox
    // Verify Connect button is enabled
  })

  test('submitting calls createConnection with source + selected IDs', () => {
    // Mock createConnection
    // Select a worktree, click Connect
    // Verify createConnection called with [sourceId, selectedId]
  })
})
```

---

## Session 8: Sidebar -- ConnectionList & ConnectionItem

### Objectives

- Create `ConnectionList` component for the sidebar "Connections" section
- Create `ConnectionItem` component for individual connection rows
- Add the section to the sidebar above the project list
- Support context menu with rename, add worktree, open in terminal/editor, copy path, delete

### Tasks

#### 1. Create `ConnectionList.tsx`

Create `src/renderer/src/components/connections/ConnectionList.tsx`:

- Renders a collapsible "CONNECTIONS" section header
- Only visible when `connections.length > 0`
- Lists all active connections using `ConnectionItem`
- Loads connections on mount via `useConnectionStore.loadConnections()`

#### 2. Create `ConnectionItem.tsx`

Create `src/renderer/src/components/connections/ConnectionItem.tsx`:

- Shows connection name (breed name)
- Subtitle: project names joined by " + "
- Status indicator using `useWorktreeStatusStore` (aggregated from connection's own sessions)
- Click handler: calls `useConnectionStore.selectConnection(id)`
- Visual selected state: highlighted background when `selectedConnectionId === id`
- Context menu:
  - Rename (inline editing, calls `useConnectionStore.renameConnection`)
  - Add worktree (opens a picker or the ConnectDialog scoped to adding)
  - Open in Terminal
  - Open in Editor
  - Copy Path
  - Show in Finder
  - Delete (with confirmation toast)

#### 3. Add to Sidebar

In `src/renderer/src/components/layout/Sidebar.tsx`, render `<ConnectionList />` above the existing project list.

#### 4. Add to barrel export

Update `src/renderer/src/components/connections/index.ts`.

### Key Files

- `src/renderer/src/components/connections/ConnectionList.tsx` -- **new file**
- `src/renderer/src/components/connections/ConnectionItem.tsx` -- **new file**
- `src/renderer/src/components/connections/index.ts` -- update barrel
- `src/renderer/src/components/layout/Sidebar.tsx` -- render ConnectionList

### Definition of Done

- [ ] "CONNECTIONS" section appears in sidebar above projects when connections exist
- [ ] Section is hidden when no connections exist
- [ ] Each connection shows breed name and project names subtitle
- [ ] Clicking a connection selects it (deselects any worktree)
- [ ] Selected connection has highlighted background
- [ ] Status indicators aggregate from the connection's own sessions
- [ ] Context menu works: rename, add worktree, open in terminal/editor, copy path, delete
- [ ] Inline rename edits the connection name
- [ ] Delete shows confirmation, then removes the connection
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a connection -- verify "CONNECTIONS" section appears in sidebar
2. Verify connection shows breed name and "frontend + backend" subtitle
3. Click the connection -- verify it highlights, worktree deselects
4. Right-click -- verify context menu with all actions
5. Rename via context menu -- verify name updates
6. Delete via context menu -- verify connection removed, section disappears if last
7. Delete all connections -- verify "CONNECTIONS" section disappears entirely

### Testing Criteria

```typescript
// test/worktree-connection/session-8/sidebar-connections.test.tsx
describe('Session 8: Sidebar Connections', () => {
  test('ConnectionList renders when connections exist', () => {
    // Mock 2 connections in store
    // Render ConnectionList
    // Verify 2 ConnectionItem components rendered
  })

  test('ConnectionList is hidden when no connections', () => {
    // Mock empty connections
    // Render ConnectionList
    // Verify nothing rendered (or section header hidden)
  })

  test('ConnectionItem shows breed name and project subtitle', () => {
    // Render ConnectionItem with members from 'frontend' and 'backend'
    // Verify breed name shown
    // Verify subtitle contains 'frontend + backend'
  })

  test('clicking ConnectionItem selects it and deselects worktree', () => {
    // Mock selectConnection and selectWorktree
    // Click ConnectionItem
    // Verify selectConnection called
  })

  test('context menu delete removes connection', () => {
    // Mock deleteConnection
    // Open context menu, click Delete
    // Verify deleteConnection called
  })
})
```

---

## Session 9: SessionView & MainPane Integration

### Objectives

- Update `MainPane` to render session tabs and view for the selected connection
- Update `SessionView` to resolve the connection path when `connection_id` is set
- Update `SessionTabs` to read from connection-scoped session lists
- Hide git UI (status, push/pull, PR) when a connection is selected

### Tasks

#### 1. Update `MainPane.tsx`

In `src/renderer/src/components/layout/MainPane.tsx`, add a check for `selectedConnectionId`:

```typescript
const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)

// If a connection is selected, render connection sessions
if (selectedConnectionId) {
  return <ConnectionSessionView connectionId={selectedConnectionId} />
}

// Otherwise, existing worktree logic
```

The `ConnectionSessionView` is either a new wrapper component or the existing `SessionView` with a `connectionId` prop instead of `worktreeId`.

#### 2. Update `SessionView.tsx` path resolution

In `SessionView.tsx` where the worktree path is resolved for OpenCode connect:

```typescript
// Existing: resolve worktree path
const worktreePath = session.worktree_id
  ? (await window.db.worktree.get(session.worktree_id))?.path
  : null

// New: also check for connection path
const connectionPath = session.connection_id
  ? (await window.connectionOps.get(session.connection_id))?.path
  : null

const workingDirectory = worktreePath || connectionPath
```

Use `workingDirectory` for `window.opencodeOps.connect(workingDirectory, sessionId)`.

#### 3. Update `SessionTabs.tsx`

Make `SessionTabs` accept either a `worktreeId` or `connectionId` prop. Read from the appropriate session list:

```typescript
const sessions = worktreeId
  ? useSessionStore((s) => s.sessionsByWorktree.get(worktreeId))
  : useSessionStore((s) => s.sessionsByConnection.get(connectionId!))

const tabOrder = worktreeId
  ? useSessionStore((s) => s.tabOrderByWorktree.get(worktreeId))
  : useSessionStore((s) => s.tabOrderByConnection.get(connectionId!))
```

#### 4. Hide git UI for connections

In `Header.tsx` and the right sidebar, check if a connection is selected and hide git-specific UI:

```typescript
const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
const isConnectionMode = !!selectedConnectionId

// Hide: git status, push/pull, PR button, merge dropdown
// Show: connection name, session tabs, model selector
```

### Key Files

- `src/renderer/src/components/layout/MainPane.tsx` -- connection routing
- `src/renderer/src/components/sessions/SessionView.tsx` -- path resolution
- `src/renderer/src/components/sessions/SessionTabs.tsx` -- scope-agnostic tabs
- `src/renderer/src/components/layout/Header.tsx` -- hide git UI in connection mode

### Definition of Done

- [ ] Selecting a connection shows its sessions in the main pane
- [ ] Session tabs read from `sessionsByConnection` when a connection is active
- [ ] Creating a "+" session in connection mode creates a connection session
- [ ] `SessionView` connects to OpenCode using the connection folder path
- [ ] The AI agent sees the symlinked directory structure
- [ ] Git UI (status, push/pull, PR, merge) is hidden when a connection is selected
- [ ] Header shows the connection name instead of worktree/branch info
- [ ] Switching between worktree and connection modes works seamlessly
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test

1. Create a connection between frontend + backend worktrees
2. Click the connection in the sidebar
3. Verify session tabs area appears (empty, with "+" button)
4. Click "+" to create a session -- verify session initializes
5. Send a prompt -- verify the agent can see both repos (ask it to list directories)
6. Verify git UI (push/pull, PR, merge) is hidden
7. Click a worktree in the sidebar -- verify back to normal worktree mode
8. Click the connection again -- verify session is still there (persisted)

### Testing Criteria

```typescript
// test/worktree-connection/session-9/session-view-connections.test.tsx
describe('Session 9: SessionView & MainPane Integration', () => {
  test('MainPane renders connection session view when connection selected', () => {
    // Mock selectedConnectionId
    // Render MainPane
    // Verify connection session view rendered (not worktree view)
  })

  test('SessionView resolves connection path for OpenCode connect', () => {
    // Mock session with connection_id set, worktree_id null
    // Mock window.connectionOps.get returning { path: '/path/to/connection' }
    // Verify opencodeOps.connect called with connection path
  })

  test('SessionTabs reads from sessionsByConnection', () => {
    // Mock connectionId prop
    // Render SessionTabs
    // Verify it reads from sessionsByConnection, not sessionsByWorktree
  })

  test('Header hides git UI when connection is selected', () => {
    // Mock selectedConnectionId
    // Render Header
    // Verify push/pull/PR/merge elements are not rendered
  })

  test('switching from connection to worktree restores git UI', () => {
    // Select connection, then select worktree
    // Verify git UI reappears
  })
})
```

---

## Session 10: Worktree Archive Cascade & Verification

### Objectives

- Hook worktree archival into connection cleanup
- Verify all features work end-to-end
- Run full test suite and lint
- Test edge cases

### Tasks

#### 1. Add connection cleanup to worktree archive flow

In `src/renderer/src/stores/useWorktreeStore.ts`, in the `archiveWorktree` action, after the existing archive logic but before state updates:

```typescript
// Clean up any connections referencing this worktree
try {
  await window.connectionOps.removeWorktreeFromAll(worktreeId)
  // Reload connections to reflect the change
  await useConnectionStore.getState().loadConnections()
} catch {
  // Non-critical -- log but don't block archive
}
```

This calls the `connection:removeWorktreeFromAll` handler which removes the symlink and member row from every connection containing this worktree, and deletes connections that become empty.

#### 2. Run full test suite

```bash
pnpm test
pnpm lint
```

Fix any failures.

#### 3. Verify each feature end-to-end

**Connection creation:**

- Right-click worktree -> "Connect to..." -> select worktree from another project -> Connect
- Verify folder created at `~/.hive/connections/{breedName}/` with symlinks
- Verify `AGENTS.md` is generated with correct content
- Verify connection appears in sidebar

**Session in connection:**

- Select connection -> create session -> send a prompt
- Verify agent can see both repos
- Close session -> reopen from history -> verify reconnect works

**Member management:**

- Add a third worktree to an existing connection -> verify symlink + AGENTS.md updated
- Remove a worktree from a connection -> verify symlink removed + AGENTS.md updated
- Remove last worktree -> verify connection deleted

**Worktree archive cascade:**

- Archive a worktree that belongs to a connection
- Verify symlink removed from connection automatically
- Verify connection survives with remaining members
- Archive the last member -> verify connection is deleted

**Selection deconfliction:**

- Click worktree -> click connection -> click worktree
- Verify only one is selected at a time
- Verify main pane switches correctly

**Edge cases:**

- Create connection when `~/.hive/connections/` doesn't exist -> verify it's created
- Two connections referencing the same worktree -> both work
- Broken symlink (worktree deleted outside Hive) -> connection still loads, warning shown

#### 4. Verify no regressions

- All existing worktree operations work as before
- All existing session operations work as before
- All existing git operations work as before

### Key Files

- `src/renderer/src/stores/useWorktreeStore.ts` -- archive cascade
- All files from Sessions 1-9

### Definition of Done

- [ ] Archiving a worktree removes its symlinks from all connections
- [ ] Archiving the last member of a connection deletes the connection
- [ ] `pnpm test` passes with zero failures
- [ ] `pnpm lint` passes with zero errors
- [ ] Connection creation end-to-end works (dir + symlinks + AGENTS.md + DB)
- [ ] Sessions in connections work (create, send prompt, agent sees both repos)
- [ ] Member management works (add, remove, last-member deletion)
- [ ] Selection deconfliction works (worktree vs connection)
- [ ] Git UI is hidden when a connection is selected
- [ ] No regressions in existing worktree/session/git features

### Testing Criteria

```typescript
// test/worktree-connection/session-10/archive-cascade-integration.test.ts
describe('Session 10: Archive Cascade & Integration', () => {
  test('archiving a worktree calls removeWorktreeFromAll', () => {
    // Mock archiveWorktree flow
    // Verify window.connectionOps.removeWorktreeFromAll called with worktreeId
  })

  test('archiving a worktree reloads connections', () => {
    // Mock archive flow
    // Verify loadConnections called after removeWorktreeFromAll
  })

  test('connection survives when one of multiple members is archived', () => {
    // Connection with 2 members
    // Archive worktree for member 1
    // Verify connection still exists with 1 member
  })

  test('connection is deleted when last member is archived', () => {
    // Connection with 1 member
    // Archive that worktree
    // Verify connection is deleted
  })

  test('full lifecycle: create connection -> session -> archive -> cleanup', () => {
    // Create connection between 2 worktrees
    // Create a session in the connection
    // Archive one worktree
    // Verify connection has 1 member, session still exists (orphaned)
    // Archive the other worktree
    // Verify connection is deleted
  })

  test('worktree in multiple connections is cleaned up from all', () => {
    // Add same worktree to 2 different connections
    // Archive that worktree
    // Verify it's removed from both connections
  })
})
```
