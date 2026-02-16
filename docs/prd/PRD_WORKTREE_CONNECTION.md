# Hive -- Worktree Connections Product Requirements Document

## Overview

Worktree Connections allow users to logically link worktrees across different projects so an AI coding agent can operate on multiple codebases simultaneously. Creating a connection produces a folder containing symlinks to each connected worktree. Sessions started in this folder give the agent access to all linked repos as if they were subdirectories of a single project.

Primary use case: connecting a frontend worktree and a backend worktree so the agent can make coordinated changes across both codebases in a single session.

### Goals

1. Create, manage, and delete cross-project worktree connections
2. Maintain a filesystem folder with symlinks to each connected worktree
3. Auto-generate an `AGENTS.md` in the connection folder describing the multi-repo setup
4. Support sessions scoped to the connection folder as the working directory
5. Display connections as a top-level section in the sidebar above projects
6. Dynamically add/remove worktrees from existing connections

---

## Technical Additions

| Component                 | Technology                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| Connection DB table       | New `connections` table in SQLite: id, name, status, created_at, updated_at                         |
| Connection members table  | New `connection_members` table: connection_id FK, worktree_id FK, project_id FK                     |
| Connection filesystem ops | Node.js `fs.symlink` / `fs.unlink` for managing symlinks in `~/.hive/connections/{name}/`           |
| AGENTS.md generation      | Template-based file generation describing connected repos, their paths, and purposes                |
| Connection IPC handlers   | New `src/main/ipc/connection-handlers.ts` with create/update/delete/addMember/removeMember channels |
| Connection store          | New `useConnectionStore` Zustand store in renderer                                                  |
| Connection UI components  | New section in sidebar above project list, context menu integration on worktree items               |
| Session scoping           | OpenCode `connect()` called with connection folder path instead of worktree path                    |

---

## Data Model

### `connections` Table

```sql
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- `name`: Auto-generated breed name (same naming system as worktrees). User can rename later.
- `path`: Filesystem path to the connection folder (`~/.hive/connections/{name}/`).
- `status`: `'active'` or `'archived'`.

### `connection_members` Table

```sql
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
```

- `symlink_name`: The name used for the symlink inside the connection folder (derived from the project name, e.g., `frontend`, `backend`). Must be unique within a connection.
- `project_id`: Denormalized from worktree for fast lookups. Kept in sync.

### Type Definitions (for `src/preload/index.d.ts`)

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

---

## Filesystem Layout

```
~/.hive/connections/
  french-bulldog/                    # connection folder (breed name)
    AGENTS.md                        # auto-generated context file
    frontend/  -> symlink to ~/.hive-worktrees/my-frontend/golden-retriever/
    backend/   -> symlink to ~/.hive-worktrees/my-backend/persian-cat/
  siberian-husky/                    # another connection
    AGENTS.md
    api/       -> symlink to ~/.hive-worktrees/api-service/labrador/
    dashboard/ -> symlink to ~/.hive-worktrees/dashboard-app/maine-coon/
```

**Symlink naming:** The symlink name is derived from the project name (lowercased, hyphenated). If two worktrees come from the same project (unusual but possible), append `-2`, `-3`, etc.

**AGENTS.md template:**

```markdown
# Connected Worktrees

This workspace contains symlinked worktrees from multiple projects.
Each subdirectory is a separate git repository.

## Projects

### {symlink_name}/

- **Project:** {project_name}
- **Branch:** {branch_name}
- **Path:** {worktree_path}

### {symlink_name}/

- **Project:** {project_name}
- **Branch:** {branch_name}
- **Path:** {worktree_path}

## Working in this workspace

- Each subdirectory is a fully independent git repo
- Make commits in each subdirectory separately
- Changes in one project do not affect the other
```

The `AGENTS.md` is regenerated whenever members are added or removed.

---

## Features

### 1. Create a Connection

#### 1.1 Flow

```
User right-clicks a worktree in the sidebar:

  ┌─────────────────────────┐
  │ Open in Terminal         │
  │ Open in Editor           │
  │ Duplicate                │
  │ ─────────────────────── │
  │ Connect to...        →  │──→  Shows a picker dialog listing all
  │ ─────────────────────── │     worktrees from OTHER projects.
  │ Copy Path                │     User selects one or more worktrees.
  │ Show in Finder           │     Clicking "Connect" creates the
  │ ─────────────────────── │     connection.
  │ Archive                  │
  └─────────────────────────┘

  The picker dialog:
  ┌─────────────────────────────────────────────┐
  │  Connect worktrees                           │
  │                                              │
  │  Starting from: golden-retriever (frontend)  │
  │                                              │
  │  Select worktrees to connect:                │
  │  ┌──────────────────────────────────────┐    │
  │  │ ☐ persian-cat (backend)              │    │
  │  │ ☐ labrador (api-service)             │    │
  │  │ ☐ maine-coon (dashboard-app)         │    │
  │  │ ☐ beagle (backend)                   │    │
  │  └──────────────────────────────────────┘    │
  │                                              │
  │                    [Cancel]  [Connect]        │
  └─────────────────────────────────────────────┘

  Each item shows: {breed-name} ({project-name})
  Grouped by project.
  Only active (non-archived) worktrees from other projects shown.
```

#### 1.2 Backend Operations

When the user clicks "Connect":

1. Generate a unique breed name for the connection (same `selectUniqueBreedName` function, checking against existing connection names).
2. Create the connection directory: `~/.hive/connections/{breedName}/`
3. Create symlinks for each selected worktree:
   - Symlink name = project name (lowercased, hyphenated)
   - Target = worktree's filesystem path
4. Generate `AGENTS.md` in the connection folder.
5. Insert `connections` row and `connection_members` rows into the database.

#### 1.3 IPC Channels

| Channel                     | Params                                         | Returns                   |
| --------------------------- | ---------------------------------------------- | ------------------------- |
| `connection:create`         | `{ worktreeIds: string[] }`                    | `ConnectionWithMembers`   |
| `connection:delete`         | `{ connectionId: string }`                     | `{ success: boolean }`    |
| `connection:addMember`      | `{ connectionId: string, worktreeId: string }` | `ConnectionMember`        |
| `connection:removeMember`   | `{ connectionId: string, worktreeId: string }` | `{ success: boolean }`    |
| `connection:rename`         | `{ connectionId: string, name: string }`       | `{ success: boolean }`    |
| `connection:getAll`         | none                                           | `ConnectionWithMembers[]` |
| `connection:get`            | `{ connectionId: string }`                     | `ConnectionWithMembers`   |
| `connection:openInTerminal` | `{ connectionPath: string }`                   | void                      |
| `connection:openInEditor`   | `{ connectionPath: string }`                   | void                      |

#### 1.4 Files to Create/Modify

| File                                      | Change                                                          |
| ----------------------------------------- | --------------------------------------------------------------- |
| `src/main/db/schema.ts`                   | Add migration for `connections` and `connection_members` tables |
| `src/main/ipc/connection-handlers.ts`     | **New file.** All connection IPC handlers                       |
| `src/main/services/connection-service.ts` | **New file.** Filesystem ops: create dir, symlinks, AGENTS.md   |
| `src/main/index.ts`                       | Register connection handlers                                    |
| `src/preload/index.ts`                    | Add `connectionOps` namespace                                   |
| `src/preload/index.d.ts`                  | Add Connection types and `window.connectionOps` interface       |

---

### 2. Sidebar Display

#### 2.1 Layout

```
Sidebar (left panel):

  ┌───────────────────────────────┐
  │ CONNECTIONS                    │  ← new collapsible section
  │  ⟡ french-bulldog             │     (only visible when ≥1 connection exists)
  │    frontend + backend          │     subtitle: project names joined
  │  ⟡ siberian-husky             │
  │    api + dashboard             │
  │                                │
  │ PROJECTS                       │  ← existing section (unchanged)
  │  ▸ my-frontend                 │
  │  ▸ my-backend                  │
  │  ▸ api-service                 │
  └───────────────────────────────┘

  Clicking a connection selects it and shows its sessions
  in the main pane (same pattern as selecting a worktree).
```

#### 2.2 Connection Item

Each connection item in the sidebar shows:

- **Name:** The breed name (e.g., "french-bulldog")
- **Subtitle:** Connected project names joined by " + " (e.g., "frontend + backend")
- **Status indicator:** Same pulse animation system as worktrees (working/planning/answering etc.)
- **Context menu:** Rename, Add worktree, Open in Terminal, Open in Editor, Copy Path, Delete

#### 2.3 Session Tabs for Connections

When a connection is selected, the main pane shows session tabs scoped to that connection. Sessions are created and managed identically to worktree sessions, except:

- `session.worktree_id` is `NULL`
- A new `session.connection_id` FK points to the connection
- OpenCode `connect()` is called with the connection folder path as the working directory

#### 2.4 Files to Create/Modify

| File                                                         | Change                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `src/renderer/src/components/connections/ConnectionList.tsx` | **New file.** Renders the "Connections" section in the sidebar   |
| `src/renderer/src/components/connections/ConnectionItem.tsx` | **New file.** Individual connection row with status/context menu |
| `src/renderer/src/components/connections/ConnectDialog.tsx`  | **New file.** Picker dialog for selecting worktrees to connect   |
| `src/renderer/src/components/connections/index.ts`           | **New file.** Barrel exports                                     |
| `src/renderer/src/components/layout/Sidebar.tsx`             | Add ConnectionList above ProjectList                             |
| `src/renderer/src/components/worktrees/WorktreeItem.tsx`     | Add "Connect to..." context menu item                            |

---

### 3. Sessions in Connections

#### 3.1 Schema Change

Add `connection_id` to the `sessions` table:

```sql
ALTER TABLE sessions ADD COLUMN connection_id TEXT DEFAULT NULL
  REFERENCES connections(id) ON DELETE SET NULL;
CREATE INDEX idx_sessions_connection ON sessions(connection_id);
```

A session belongs to either a worktree OR a connection (not both). The constraints:

- `worktree_id IS NOT NULL AND connection_id IS NULL` -- worktree session (existing behavior)
- `worktree_id IS NULL AND connection_id IS NOT NULL` -- connection session (new)
- Both NULL -- orphaned session (existing edge case, tolerated)

#### 3.2 Session Creation for Connections

When the user clicks "+" to create a new session tab while a connection is selected:

1. `useSessionStore.createSession(null, null, connectionId)` -- no worktree_id, no project_id (or we pick one of the connection's project_ids for the required FK -- see open question)
2. `window.db.session.create({ connection_id: connectionId, ... })`
3. On session init, `SessionView` resolves the connection path instead of a worktree path
4. `window.opencodeOps.connect(connectionPath, sessionId)` -- the connection folder is the working directory

The agent now sees the connection folder structure:

```
/Users/mor/.hive/connections/french-bulldog/
  AGENTS.md
  frontend/  -> (symlink)
  backend/   -> (symlink)
```

#### 3.3 Session Store Changes

`useSessionStore` needs parallel maps for connection sessions:

```typescript
// Existing (unchanged)
sessionsByWorktree: Map<string, Session[]>

// New
sessionsByConnection: Map<string, Session[]>
tabOrderByConnection: Map<string, string[]>
activeSessionByConnection: Record<string, string> // persisted
```

The `loadSessions`, `createSession`, `closeSession`, `setActiveSession` actions all need overloads or a discriminator to handle both worktree-scoped and connection-scoped sessions.

#### 3.4 Files to Modify

| File                                                   | Change                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `src/main/db/schema.ts`                                | Add `connection_id` column to sessions, migration                    |
| `src/preload/index.d.ts`                               | Add `connection_id` to `Session` type                                |
| `src/renderer/src/stores/useSessionStore.ts`           | Add connection-scoped session maps and actions                       |
| `src/renderer/src/components/sessions/SessionView.tsx` | Resolve connection path when `connection_id` is set                  |
| `src/renderer/src/components/sessions/SessionTabs.tsx` | Support connection-scoped tab rendering                              |
| `src/main/ipc/database-handlers.ts`                    | Add `db:session:getByConnection`, `db:session:getActiveByConnection` |

---

### 4. Live Add/Remove Members

#### 4.1 Adding a Worktree to an Existing Connection

Via the connection's context menu ("Add worktree") or the worktree's context menu ("Connect to..." showing existing connections as options):

1. Insert `connection_members` row
2. Create symlink: `fs.symlink(worktreePath, connectionPath/projectName)`
3. Regenerate `AGENTS.md`
4. Update UI

#### 4.2 Removing a Worktree from a Connection

Via the connection's expanded view or context menu:

1. Remove symlink: `fs.unlink(connectionPath/symlinkName)`
2. Delete `connection_members` row
3. Regenerate `AGENTS.md`
4. If no members remain, delete the connection entirely (remove folder, delete DB row)
5. Update UI

#### 4.3 Worktree Archival Cascade

When a worktree is archived (via `useWorktreeStore.archiveWorktree`), check if it belongs to any connections:

1. Query `connection_members` for the worktree ID
2. For each connection it belongs to, call `connection:removeMember`
3. The `ON DELETE CASCADE` FK on `connection_members.worktree_id` handles DB cleanup automatically
4. But the symlink removal and AGENTS.md regeneration need explicit handling

This logic belongs in `connection-service.ts` and should be called from the worktree archive flow.

#### 4.4 Files to Modify

| File                                            | Change                                                  |
| ----------------------------------------------- | ------------------------------------------------------- |
| `src/main/services/connection-service.ts`       | `addMember()`, `removeMember()`, `regenerateAgentsMd()` |
| `src/main/ipc/connection-handlers.ts`           | Wire up add/remove member channels                      |
| `src/renderer/src/stores/useWorktreeStore.ts`   | Call connection cleanup on archive                      |
| `src/renderer/src/stores/useConnectionStore.ts` | **New file.** State + actions for connections           |

---

### 5. Connection Store

#### 5.1 State Shape

```typescript
interface ConnectionState {
  connections: ConnectionWithMembers[]
  isLoading: boolean
  error: string | null

  // UI State
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

#### 5.2 File

| File                                            | Change                      |
| ----------------------------------------------- | --------------------------- |
| `src/renderer/src/stores/useConnectionStore.ts` | **New file**                |
| `src/renderer/src/stores/index.ts`              | Export `useConnectionStore` |

---

## Interaction with Existing Worktree/Session Selection

Currently, selecting a worktree sets `useWorktreeStore.selectedWorktreeId` and `useSessionStore.activeWorktreeId`. The main pane renders sessions based on the active worktree.

With connections, we introduce a parallel selection mode:

```
Selection state machine:

  ┌─────────────┐     click      ┌────────────────┐
  │  worktree    │ ◄──────────── │  connection     │
  │  selected    │ ──────────►   │  selected       │
  └─────────────┘     click      └────────────────┘

  When a worktree is selected:
    selectedWorktreeId = {id}
    selectedConnectionId = null
    → main pane shows worktree sessions

  When a connection is selected:
    selectedWorktreeId = null
    selectedConnectionId = {id}
    → main pane shows connection sessions
```

The `MainPane` component needs to check both stores and render the appropriate session view. The `SessionTabs` component needs to read from the correct session list based on what's selected.

### Files to Modify

| File                                              | Change                                                  |
| ------------------------------------------------- | ------------------------------------------------------- |
| `src/renderer/src/components/layout/MainPane.tsx` | Check for active connection, render connection sessions |
| `src/renderer/src/components/layout/Sidebar.tsx`  | Handle selection deconfliction (worktree vs connection) |
| `src/renderer/src/stores/useWorktreeStore.ts`     | Clear selection when connection is selected             |

---

## Migration

Schema version bump: `CURRENT_SCHEMA_VERSION` incremented. New migration appended to `MIGRATIONS` array:

```typescript
{
  version: N,  // next version number
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

    // Add connection_id to sessions
    db.exec(`
      ALTER TABLE sessions ADD COLUMN connection_id TEXT DEFAULT NULL
        REFERENCES connections(id) ON DELETE SET NULL;
      CREATE INDEX idx_sessions_connection ON sessions(connection_id);
    `)
  }
}
```

---

## Testing

### Connection CRUD

- Create a connection between two worktrees from different projects -- verify folder created with symlinks
- Verify symlinks point to correct worktree paths and are functional
- Verify `AGENTS.md` is generated with correct project information
- Rename a connection -- verify DB updated, folder renamed, symlinks still work
- Delete a connection -- verify folder removed, DB rows deleted, sessions orphaned gracefully

### Member Management

- Add a worktree to an existing connection -- verify new symlink created, AGENTS.md updated
- Remove a worktree from a connection -- verify symlink removed, AGENTS.md updated
- Remove the last worktree -- verify entire connection is deleted
- Archive a worktree that belongs to a connection -- verify symlink removed from connection automatically
- Create a connection with two worktrees from the same project -- verify symlink names don't collide

### Sessions

- Create a session in a connection -- verify OpenCode connects with connection folder path
- Verify agent can see and operate on files in both symlinked repos
- Close and reopen a connection session -- verify reconnect works
- Verify session history search includes connection sessions
- Delete a connection with active sessions -- verify sessions are orphaned (connection_id set NULL)

### UI

- Verify "Connections" section appears in sidebar only when connections exist
- Verify selecting a connection deselects any worktree and vice versa
- Verify session tabs render correctly for connection sessions
- Verify context menu on worktree includes "Connect to..." option
- Verify connection item shows correct status indicators from its sessions
- Verify connection context menu includes all expected actions

### Edge Cases

- Worktree path no longer exists on disk -- symlink is broken. Connection should still load; show warning indicator.
- Two connections referencing the same worktree -- both should work independently
- Creating a connection when `~/.hive/connections/` doesn't exist yet -- should create parent dir
- Symlink name collision (two worktrees from projects with the same name) -- append numeric suffix

---

## Open Questions

1. **Session `project_id` for connections:** The `sessions` table has a `NOT NULL` constraint on `project_id`. Connection sessions span multiple projects. Options: (a) make `project_id` nullable for connection sessions, (b) pick the first member's project_id as a default, (c) add a dedicated `connection_id` FK and make `project_id` nullable. Recommendation: option (c) -- make `project_id` nullable when `connection_id` is set.

2. **Connection status indicators:** Should the connection's status bubble aggregate statuses from sessions running in the connection, or from sessions running in each connected worktree? Recommendation: only aggregate from the connection's own sessions, not from the individual worktree sessions.

3. **Git operations in connection sessions:** The header bar shows git status, push/pull, PR buttons for the active worktree. When a connection is selected, these don't apply to a single repo. Options: (a) hide all git UI when a connection is selected, (b) show git UI for a user-selected "primary" repo. Recommendation: (a) hide git UI -- the agent handles git operations per-repo via its tools.

4. **Existing worktree "Connect to..." UX:** When the user right-clicks a worktree that's already in a connection, should "Connect to..." show existing connections they can add it to, or only create new ones? Recommendation: show both -- existing connections as top items, then a "Create new connection..." option below a divider.

5. **AGENTS.md customization:** Should users be able to edit the auto-generated AGENTS.md? If they do, should Hive preserve their edits when regenerating? Recommendation: v1 always overwrites. Add a user-editable section in a future iteration.
