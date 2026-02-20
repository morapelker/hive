# Phase 4 — Resolvers: Database CRUD (Sessions 32–42)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 4 implements the simplest resolvers — pure database CRUD operations that wrap the existing `DatabaseService` methods. These resolvers form the foundation for all data access. At the end of this phase, all project, worktree, session, space, and settings CRUD operations work via GraphQL.

## Prerequisites

- Phase 1-3 completed: shared types, EventBus, SDL schema, codegen, server entry point, context, auth.
- `src/server/context.ts` defines `GraphQLContext` with `db: DatabaseService`.
- `src/server/__generated__/resolvers-types.ts` has all generated types.
- `src/server/resolvers/index.ts` has the resolver merger.

## Key Architecture Pattern

Every resolver is a **thin wrapper** over the same `DatabaseService` methods that IPC handlers already use. The pattern:

```typescript
// IPC handler (existing)
ipcMain.handle('db:project:getAll', () => db.project.getAll())

// GraphQL resolver (new, same underlying call)
projects: async (_parent, _args, ctx) => ctx.db.project.getAll()
```

The `DatabaseService` (from `src/main/db/database.ts`) provides these namespaced methods:
- `ctx.db.project.*` — Project CRUD
- `ctx.db.worktree.*` — Worktree CRUD
- `ctx.db.session.*` — Session CRUD
- `ctx.db.space.*` — Space CRUD
- `ctx.db.setting.*` — Setting CRUD

The methods are synchronous (better-sqlite3 is sync) but wrapped in Promise for the IPC layer. GraphQL resolvers can call them directly.

## Field Name Mapping

Database uses `snake_case`, GraphQL uses `camelCase`. The resolver layer handles this mapping:
- DB: `project_id` → GraphQL: `projectId`
- DB: `branch_name` → GraphQL: `branchName`
- DB: `last_accessed_at` → GraphQL: `lastAccessedAt`

Create a utility `mapSnakeToCamel(obj)` or define field-level resolvers to handle this conversion.

## Source of Truth

| Reference | Purpose |
|-----------|---------|
| `src/preload/index.ts` lines 4-145 | All `db.*` IPC calls — these are the operations to mirror |
| `src/preload/index.d.ts` lines 132-263 | Full `window.db` type declarations |
| `src/main/db/database.ts` | `DatabaseService` class — actual method signatures |

---

## Session 32: DB Query Resolvers — Projects

**Goal:** Implement the 3 project query resolvers.

**Definition of Done:** `projects`, `project(id)`, `projectByPath(path)` queries return correct data via GraphQL.

**Tasks:**

1. `[server]` Create `src/server/resolvers/query/db.resolvers.ts` (this file will accumulate all DB query resolvers across sessions 32-36):
   ```typescript
   import type { Resolvers } from '../../__generated__/resolvers-types'

   // Utility to map snake_case DB rows to camelCase GraphQL fields
   function mapProject(row: any) {
     if (!row) return null
     return {
       id: row.id,
       name: row.name,
       path: row.path,
       description: row.description,
       tags: row.tags,
       language: row.language,
       customIcon: row.custom_icon,
       setupScript: row.setup_script,
       runScript: row.run_script,
       archiveScript: row.archive_script,
       autoAssignPort: row.auto_assign_port,
       sortOrder: row.sort_order,
       createdAt: row.created_at,
       lastAccessedAt: row.last_accessed_at
     }
   }
   ```

2. `[server]` Add project query resolvers:
   ```typescript
   export const dbQueryResolvers: Resolvers = {
     Query: {
       projects: async (_parent, _args, ctx) => {
         const rows = ctx.db.project.getAll()
         return rows.map(mapProject)
       },
       project: async (_parent, { id }, ctx) => {
         return mapProject(ctx.db.project.get(id))
       },
       projectByPath: async (_parent, { path }, ctx) => {
         return mapProject(ctx.db.project.getByPath(path))
       }
     }
   }
   ```

3. `[server]` Register in `src/server/resolvers/index.ts` by importing and merging `dbQueryResolvers`.

4. `[server]` Verify: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

## Session 33: DB Query Resolvers — Worktrees

**Goal:** Implement the 3 worktree query resolvers.

**Definition of Done:** `worktree(id)`, `worktreesByProject(projectId)`, `activeWorktreesByProject(projectId)` queries work.

**Tasks:**

1. `[server]` Add `mapWorktree(row)` utility to `db.resolvers.ts`:
   ```typescript
   function mapWorktree(row: any) {
     if (!row) return null
     return {
       id: row.id,
       projectId: row.project_id,
       name: row.name,
       branchName: row.branch_name,
       path: row.path,
       status: row.status,
       isDefault: row.is_default,
       branchRenamed: row.branch_renamed,
       lastMessageAt: row.last_message_at,
       sessionTitles: row.session_titles,
       lastModelProviderId: row.last_model_provider_id,
       lastModelId: row.last_model_id,
       lastModelVariant: row.last_model_variant,
       createdAt: row.created_at,
       lastAccessedAt: row.last_accessed_at
     }
   }
   ```

2. `[server]` Add worktree query resolvers:
   ```typescript
   worktree: async (_parent, { id }, ctx) => mapWorktree(ctx.db.worktree.get(id)),
   worktreesByProject: async (_parent, { projectId }, ctx) => {
     return ctx.db.worktree.getByProject(projectId).map(mapWorktree)
   },
   activeWorktreesByProject: async (_parent, { projectId }, ctx) => {
     return ctx.db.worktree.getActiveByProject(projectId).map(mapWorktree)
   }
   ```

3. `[server]` Verify: `pnpm build`

---

## Session 34: DB Query Resolvers — Sessions

**Goal:** Implement the 6 session query resolvers (worktree-scoped).

**Definition of Done:** `session(id)`, `sessionsByWorktree`, `activeSessionsByWorktree`, `sessionsByProject`, `searchSessions`, `sessionDraft` queries work.

**Tasks:**

1. `[server]` Add `mapSession(row)` utility:
   ```typescript
   function mapSession(row: any) {
     if (!row) return null
     return {
       id: row.id,
       worktreeId: row.worktree_id,
       projectId: row.project_id,
       connectionId: row.connection_id,
       name: row.name,
       status: row.status,
       opencodeSessionId: row.opencode_session_id,
       agentSdk: row.agent_sdk === 'claude-code' ? 'claude_code' : row.agent_sdk,
       mode: row.mode,
       modelProviderId: row.model_provider_id,
       modelId: row.model_id,
       modelVariant: row.model_variant,
       createdAt: row.created_at,
       updatedAt: row.updated_at,
       completedAt: row.completed_at
     }
   }
   ```
   Note the `agent_sdk` mapping: DB stores `'claude-code'` (with hyphen) but GraphQL enum uses `claude_code` (with underscore, since GraphQL enums can't have hyphens).

2. `[server]` Add `mapSessionWithWorktree(row)` for `searchSessions`:
   ```typescript
   function mapSessionWithWorktree(row: any) {
     return {
       ...mapSession(row),
       worktreeName: row.worktree_name,
       worktreeBranchName: row.worktree_branch_name,
       projectName: row.project_name
     }
   }
   ```

3. `[server]` Add session query resolvers:
   ```typescript
   session: async (_parent, { id }, ctx) => mapSession(ctx.db.session.get(id)),
   sessionsByWorktree: async (_parent, { worktreeId }, ctx) => {
     return ctx.db.session.getByWorktree(worktreeId).map(mapSession)
   },
   activeSessionsByWorktree: async (_parent, { worktreeId }, ctx) => {
     return ctx.db.session.getActiveByWorktree(worktreeId).map(mapSession)
   },
   sessionsByProject: async (_parent, { projectId }, ctx) => {
     return ctx.db.session.getByProject(projectId).map(mapSession)
   },
   searchSessions: async (_parent, { input }, ctx) => {
     const opts = {
       keyword: input.keyword,
       project_id: input.projectId,
       worktree_id: input.worktreeId,
       dateFrom: input.dateFrom,
       dateTo: input.dateTo,
       includeArchived: input.includeArchived
     }
     return ctx.db.session.search(opts).map(mapSessionWithWorktree)
   },
   sessionDraft: async (_parent, { sessionId }, ctx) => {
     return ctx.db.session.getDraft(sessionId)
   }
   ```

4. `[server]` Verify: `pnpm build`

---

## Session 35: DB Query Resolvers — Sessions (Connection)

**Goal:** Implement the 2 connection-scoped session query resolvers.

**Definition of Done:** `sessionsByConnection(connectionId)`, `activeSessionsByConnection(connectionId)` queries work.

**Tasks:**

1. `[server]` Add to session query resolvers:
   ```typescript
   sessionsByConnection: async (_parent, { connectionId }, ctx) => {
     return ctx.db.session.getByConnection(connectionId).map(mapSession)
   },
   activeSessionsByConnection: async (_parent, { connectionId }, ctx) => {
     return ctx.db.session.getActiveByConnection(connectionId).map(mapSession)
   }
   ```

2. `[server]` Verify: `pnpm build`

---

## Session 36: DB Query Resolvers — Spaces & Settings

**Goal:** Implement the 5 space and 2 settings query resolvers.

**Definition of Done:** `spaces`, `spaceProjectIds`, `allSpaceAssignments`, `setting`, `allSettings` queries work.

**Tasks:**

1. `[server]` Add `mapSpace(row)` and `mapSpaceAssignment(row)` utilities.

2. `[server]` Add space query resolvers:
   ```typescript
   spaces: async (_parent, _args, ctx) => {
     return ctx.db.space.list().map(mapSpace)
   },
   spaceProjectIds: async (_parent, { spaceId }, ctx) => {
     return ctx.db.space.getProjectIds(spaceId)
   },
   allSpaceAssignments: async (_parent, _args, ctx) => {
     return ctx.db.space.getAllAssignments().map(a => ({
       projectId: a.project_id,
       spaceId: a.space_id
     }))
   }
   ```

3. `[server]` Add settings query resolvers:
   ```typescript
   setting: async (_parent, { key }, ctx) => {
     return ctx.db.setting.get(key)
   },
   allSettings: async (_parent, _args, ctx) => {
     return ctx.db.setting.getAll()
   }
   ```

4. `[server]` Add `dbSchemaVersion` query:
   ```typescript
   dbSchemaVersion: async (_parent, _args, ctx) => {
     return ctx.db.schemaVersion()
   }
   ```

5. `[server]` Verify: `pnpm build`

---

## Session 37: DB Mutation Resolvers — Projects

**Goal:** Implement the 5 project mutation resolvers.

**Definition of Done:** `createProject`, `updateProject`, `deleteProject`, `touchProject`, `reorderProjects` mutations work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/mutation/db.resolvers.ts`:

2. `[server]` Add project mutation resolvers:
   ```typescript
   export const dbMutationResolvers: Resolvers = {
     Mutation: {
       createProject: async (_parent, { input }, ctx) => {
         const row = ctx.db.project.create({
           name: input.name,
           path: input.path,
           description: input.description ?? null,
           tags: input.tags ? JSON.stringify(input.tags) : null
         })
         return mapProject(row)
       },
       updateProject: async (_parent, { id, input }, ctx) => {
         const data: Record<string, unknown> = {}
         if (input.name !== undefined) data.name = input.name
         if (input.description !== undefined) data.description = input.description
         if (input.tags !== undefined) data.tags = input.tags ? JSON.stringify(input.tags) : null
         if (input.language !== undefined) data.language = input.language
         if (input.customIcon !== undefined) data.custom_icon = input.customIcon
         if (input.setupScript !== undefined) data.setup_script = input.setupScript
         if (input.runScript !== undefined) data.run_script = input.runScript
         if (input.archiveScript !== undefined) data.archive_script = input.archiveScript
         if (input.autoAssignPort !== undefined) data.auto_assign_port = input.autoAssignPort
         if (input.lastAccessedAt !== undefined) data.last_accessed_at = input.lastAccessedAt
         return mapProject(ctx.db.project.update(id, data))
       },
       deleteProject: async (_parent, { id }, ctx) => ctx.db.project.delete(id),
       touchProject: async (_parent, { id }, ctx) => ctx.db.project.touch(id),
       reorderProjects: async (_parent, { orderedIds }, ctx) => ctx.db.project.reorder(orderedIds)
     }
   }
   ```

   Note the `camelCase → snake_case` reverse mapping for mutations (GraphQL input → DB column names).

3. `[server]` Register in resolver merger.
4. `[server]` Verify: `pnpm build`

---

## Session 38: DB Mutation Resolvers — Worktrees

**Goal:** Implement the 5 worktree DB mutation resolvers (DB-level CRUD, not git operations).

**Definition of Done:** `updateWorktree`, `archiveWorktree`, `touchWorktree`, `appendWorktreeSessionTitle`, `updateWorktreeModel` mutations work.

**Tasks:**

1. `[server]` Add worktree mutation resolvers:
   ```typescript
   updateWorktree: async (_parent, { id, input }, ctx) => {
     const data: Record<string, unknown> = {}
     if (input.name !== undefined) data.name = input.name
     if (input.status !== undefined) data.status = input.status
     if (input.lastMessageAt !== undefined) data.last_message_at = input.lastMessageAt
     if (input.lastAccessedAt !== undefined) data.last_accessed_at = input.lastAccessedAt
     return mapWorktree(ctx.db.worktree.update(id, data))
   },
   archiveWorktree: async (_parent, { id }, ctx) => {
     return mapWorktree(ctx.db.worktree.archive(id))
   },
   touchWorktree: async (_parent, { id }, ctx) => ctx.db.worktree.touch(id),
   appendWorktreeSessionTitle: async (_parent, { worktreeId, title }, ctx) => {
     return ctx.db.worktree.appendSessionTitle(worktreeId, title)
   },
   updateWorktreeModel: async (_parent, { input }, ctx) => {
     return ctx.db.worktree.updateModel({
       worktreeId: input.worktreeId,
       modelProviderId: input.modelProviderId,
       modelId: input.modelId,
       modelVariant: input.modelVariant ?? null
     })
   }
   ```

   Note: `createWorktree`, `deleteWorktree`, `syncWorktrees`, `duplicateWorktree`, `renameWorktreeBranch`, `createWorktreeFromBranch` are git operations, NOT simple DB CRUD. They are implemented in Phase 5 (Session 48).

2. `[server]` Verify: `pnpm build`

---

## Session 39: DB Mutation Resolvers — Sessions

**Goal:** Implement the 4 session mutation resolvers.

**Definition of Done:** `createSession`, `updateSession`, `deleteSession`, `updateSessionDraft` mutations work.

**Tasks:**

1. `[server]` Add session mutation resolvers:
   ```typescript
   createSession: async (_parent, { input }, ctx) => {
     const row = ctx.db.session.create({
       worktree_id: input.worktreeId ?? null,
       project_id: input.projectId,
       connection_id: input.connectionId ?? null,
       name: input.name ?? null,
       opencode_session_id: input.opencodeSessionId ?? null,
       agent_sdk: input.agentSdk === 'claude_code' ? 'claude-code' : (input.agentSdk ?? 'opencode'),
       model_provider_id: input.modelProviderId ?? null,
       model_id: input.modelId ?? null,
       model_variant: input.modelVariant ?? null
     })
     return mapSession(row)
   },
   updateSession: async (_parent, { id, input }, ctx) => {
     const data: Record<string, unknown> = {}
     if (input.name !== undefined) data.name = input.name
     if (input.status !== undefined) data.status = input.status
     if (input.opencodeSessionId !== undefined) data.opencode_session_id = input.opencodeSessionId
     if (input.agentSdk !== undefined) data.agent_sdk = input.agentSdk === 'claude_code' ? 'claude-code' : input.agentSdk
     if (input.mode !== undefined) data.mode = input.mode
     if (input.modelProviderId !== undefined) data.model_provider_id = input.modelProviderId
     if (input.modelId !== undefined) data.model_id = input.modelId
     if (input.modelVariant !== undefined) data.model_variant = input.modelVariant
     if (input.updatedAt !== undefined) data.updated_at = input.updatedAt
     if (input.completedAt !== undefined) data.completed_at = input.completedAt
     return mapSession(ctx.db.session.update(id, data))
   },
   deleteSession: async (_parent, { id }, ctx) => ctx.db.session.delete(id),
   updateSessionDraft: async (_parent, { sessionId, draft }, ctx) => {
     ctx.db.session.updateDraft(sessionId, draft ?? null)
     return true
   }
   ```

   Note the `agent_sdk` enum mapping: GraphQL `claude_code` ↔ DB `claude-code`.

2. `[server]` Verify: `pnpm build`

---

## Session 40: DB Mutation Resolvers — Spaces

**Goal:** Implement the 6 space mutation resolvers.

**Definition of Done:** `createSpace`, `updateSpace`, `deleteSpace`, `assignProjectToSpace`, `removeProjectFromSpace`, `reorderSpaces` mutations work.

**Tasks:**

1. `[server]` Add space mutation resolvers:
   ```typescript
   createSpace: async (_parent, { input }, ctx) => {
     return mapSpace(ctx.db.space.create({
       name: input.name,
       icon_type: input.iconType,
       icon_value: input.iconValue
     }))
   },
   updateSpace: async (_parent, { id, input }, ctx) => {
     const data: Record<string, unknown> = {}
     if (input.name !== undefined) data.name = input.name
     if (input.iconType !== undefined) data.icon_type = input.iconType
     if (input.iconValue !== undefined) data.icon_value = input.iconValue
     if (input.sortOrder !== undefined) data.sort_order = input.sortOrder
     return mapSpace(ctx.db.space.update(id, data))
   },
   deleteSpace: async (_parent, { id }, ctx) => ctx.db.space.delete(id),
   assignProjectToSpace: async (_parent, { projectId, spaceId }, ctx) => {
     return ctx.db.space.assignProject(projectId, spaceId)
   },
   removeProjectFromSpace: async (_parent, { projectId, spaceId }, ctx) => {
     return ctx.db.space.removeProject(projectId, spaceId)
   },
   reorderSpaces: async (_parent, { orderedIds }, ctx) => {
     return ctx.db.space.reorder(orderedIds)
   }
   ```

2. `[server]` Verify: `pnpm build`

---

## Session 41: DB Mutation Resolvers — Settings

**Goal:** Implement the 2 settings mutation resolvers.

**Definition of Done:** `setSetting`, `deleteSetting` mutations work.

**Tasks:**

1. `[server]` Add settings mutation resolvers:
   ```typescript
   setSetting: async (_parent, { key, value }, ctx) => {
     return ctx.db.setting.set(key, value)
   },
   deleteSetting: async (_parent, { key }, ctx) => {
     return ctx.db.setting.delete(key)
   }
   ```

2. `[server]` Verify: `pnpm build`

---

## Session 42: DB Resolver Tests

**Goal:** Integration tests for all DB resolvers via yoga.fetch().

**Definition of Done:** All DB query and mutation resolvers tested, all tests pass.

**Tasks:**

1. `[server]` Create `test/server/helpers/test-server.ts`:
   - Helper that creates a yoga instance with mock database
   - Uses `yoga.fetch()` for testing (no HTTP server needed)
   - Provides `executeQuery(query, variables?)` helper function
   ```typescript
   import { createYoga, createSchema } from 'graphql-yoga'
   // Load schema, resolvers, create mock context
   export function createTestServer(mockDb: MockDatabaseService) {
     const yoga = createYoga({
       schema: createSchema({ typeDefs, resolvers }),
       context: { db: mockDb, authenticated: true, clientIp: '127.0.0.1' }
     })
     return {
       execute: async (query: string, variables?: Record<string, unknown>) => {
         const response = await yoga.fetch('http://localhost/graphql', {
           method: 'POST',
           headers: { 'content-type': 'application/json' },
           body: JSON.stringify({ query, variables })
         })
         return response.json()
       }
     }
   }
   ```

2. `[server]` Create `test/server/helpers/mock-db.ts`:
   - In-memory mock of `DatabaseService` that mirrors the real DB interface
   - Uses plain arrays for storage
   - Implements: `project.*`, `worktree.*`, `session.*`, `space.*`, `setting.*`, `schemaVersion()`

3. `[server]` Create `test/server/integration/db.test.ts` with tests:
   - **Projects**: create → query → update → query → delete → verify gone
   - **Worktrees**: create → query by project → update → archive → verify
   - **Sessions**: create → query by worktree → search → update draft → delete
   - **Spaces**: create → assign project → query assignments → reorder → delete
   - **Settings**: set → get → getAll → delete → verify gone
   - **Schema version**: query returns integer

4. `[server]` Run tests: `pnpm vitest run test/server/integration/db.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/integration/db.test.ts && pnpm build
```

---

## Summary of Files Created

```
src/server/resolvers/
  query/
    db.resolvers.ts           — All DB query resolvers (projects, worktrees, sessions, spaces, settings)
  mutation/
    db.resolvers.ts           — All DB mutation resolvers

test/server/
  helpers/
    test-server.ts            — Yoga test helper with mock context
    mock-db.ts                — In-memory mock DatabaseService
  integration/
    db.test.ts                — DB resolver integration tests
```

## Summary of Files Modified

| File | Change |
|------|--------|
| `src/server/resolvers/index.ts` | Import and merge DB resolvers |

## What Comes Next

Phase 5 (Operation Resolvers) implements the non-DB resolvers: system, project ops, worktree ops (git), git operations, file/file-tree, settings detection, and connection management.
