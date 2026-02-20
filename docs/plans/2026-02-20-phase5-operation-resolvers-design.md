# Phase 5 Operation Resolvers — Design

**Date:** 2026-02-20
**Phase:** 5 (Sessions 43-58 from `mobileapp-implementation-phase5.md`)
**Scope:** ~60 operation resolvers across 8 domains + service extraction

## Decision Log

1. **Service extraction over duplication** — Extract shared service functions from IPC handlers so both IPC and GraphQL call the same logic.
2. **Batch into 6 steps** — Group the 16 sessions into 6 implementation steps by dependency.
3. **Tests per batch** — Write integration tests after each batch, not all at the end.

## Architecture

### Service Extraction Pattern

IPC handlers currently contain inline orchestration logic (DB writes, settings reads, port assignment). We extract this into service classes that both IPC handlers and GraphQL resolvers call.

```
Before:
  IPC Handler → inline logic → DB + GitService

After:
  IPC Handler → WorktreeService → DB + GitService
  GraphQL Resolver → WorktreeService → DB + GitService
```

### New Services

| Service | Source | Purpose |
|---------|--------|---------|
| `src/main/services/worktree-ops.ts` | `worktree-handlers.ts` | Worktree create/delete/sync/duplicate/rename orchestration |
| `src/main/services/connection-ops.ts` | `connection-handlers.ts` | Connection create/delete/member management + symlinks |
| `src/main/services/settings-detection.ts` | `settings-handlers.ts` | Editor/terminal detection |
| `src/main/services/system-info.ts` | `src/main/index.ts` | Agent SDK detection, app paths, server status |
| `src/main/services/project-ops.ts` | `project-handlers.ts` | Project validation, language detection, icon management |
| `src/main/services/file-ops.ts` | `file-handlers.ts` | File read/write operations |

### Resolver Pattern

All new resolvers follow the existing pattern from `db.resolvers.ts`:

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import { createGitService } from '../../../main/services/git-service'

export const gitQueryResolvers: Resolvers = {
  Query: {
    gitFileStatuses: async (_parent, { worktreePath }, _ctx) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getFileStatuses()
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  }
}
```

Key conventions:
- Import `Resolvers` type from codegen
- Wrap service calls in try/catch, return `{ success: false, error }` on failure
- Access DB via `ctx.db`, event bus via `ctx.eventBus`
- Use existing `createGitService(path)` factory for git operations
- Use extracted service functions for orchestration (worktree, connection)

### Registration

Each resolver file exports a named constant. All are merged in `resolvers/index.ts`:

```typescript
import { systemQueryResolvers } from './query/system.resolvers'
import { systemMutationResolvers } from './mutation/system.resolvers'
// ... etc
export function mergeResolvers(): Resolvers {
  return deepMerge(
    dbQueryResolvers, dbMutationResolvers,
    systemQueryResolvers, systemMutationResolvers,
    // ... all new resolver files
  )
}
```

## Implementation Steps

### Step 1: Service Extraction

Extract logic from IPC handlers into shared services. Refactor IPC handlers to call the new services (no behavior change).

**Files created:**
- `src/main/services/worktree-ops.ts`
- `src/main/services/connection-ops.ts`
- `src/main/services/settings-detection.ts`
- `src/main/services/system-info.ts`
- `src/main/services/project-ops.ts`
- `src/main/services/file-ops.ts`

**Files modified:**
- `src/main/ipc/worktree-handlers.ts` — call `worktree-ops` service
- `src/main/ipc/connection-handlers.ts` — call `connection-ops` service
- `src/main/ipc/settings-handlers.ts` — call `settings-detection` service
- `src/main/ipc/project-handlers.ts` — call `project-ops` service
- `src/main/ipc/file-handlers.ts` — call `file-ops` service

**Verification:** `pnpm build && pnpm test` (existing tests pass, no behavior change)

### Step 2: System + Settings + File Resolvers

**Resolver files:**
- `query/system.resolvers.ts` — `systemLogDir`, `systemAppVersion`, `systemAppPaths`, `systemDetectAgentSdks`, `systemServerStatus`, `dbSchemaVersion`
- `mutation/system.resolvers.ts` — `systemKillSwitch`, `systemRegisterPushToken`
- `query/settings.resolvers.ts` — `detectedEditors`, `detectedTerminals`
- `query/file.resolvers.ts` — `fileRead`, `fileReadPrompt`
- `query/file-tree.resolvers.ts` — `fileTreeScan`, `fileTreeScanFlat`, `fileTreeLoadChildren`
- `mutation/file.resolvers.ts` — `fileWrite`, `fileTreeWatch`, `fileTreeUnwatch`

**Tests:** System queries return correct types, file read/write works, file tree scan returns nodes

### Step 3: Project + Worktree Resolvers

**Resolver files:**
- `query/project.resolvers.ts` — `projectValidate`, `projectIsGitRepository`, `projectDetectLanguage`, `projectLanguageIcons`, `projectIconPath`
- `mutation/project.resolvers.ts` — `projectInitRepository`, `projectUploadIcon`, `projectRemoveIcon`
- `query/worktree.resolvers.ts` — `worktreeExists`, `worktreeHasCommits`, `gitBranches`, `gitBranchExists`
- `mutation/worktree.resolvers.ts` — `createWorktree`, `deleteWorktree`, `syncWorktrees`, `duplicateWorktree`, `renameWorktreeBranch`, `createWorktreeFromBranch`

**Tests:** Project validation, worktree create/delete lifecycle

### Step 4: Git Query Resolvers

**Resolver files:**
- `query/git.resolvers.ts` — `gitFileStatuses`, `gitDiff`, `gitDiffStat`, `gitFileContent`, `gitRefContent`, `gitBranchInfo`, `gitBranchesWithStatus`, `gitIsBranchMerged`, `gitRemoteUrl`, `gitListPRs`

**Tests:** File status returns array, diff returns content, branch info returns name

### Step 5: Git Mutation Resolvers

**Resolver files:**
- `mutation/git.resolvers.ts` — Staging (`stageFile`, `unstageFile`, `stageAll`, `unstageAll`, `stageHunk`, `unstageHunk`, `revertHunk`), Commit/Push (`discardChanges`, `addToGitignore`, `commit`, `push`, `pull`), Merge/Branch (`merge`, `deleteBranch`, `prMerge`), Watching (`watchWorktree`, `unwatchWorktree`, `watchBranch`, `unwatchBranch`)

**Tests:** Stage/unstage, commit returns hash, push/pull

### Step 6: Connection Resolvers

**Resolver files:**
- `query/connection.resolvers.ts` — `connections`, `connection`
- `mutation/connection.resolvers.ts` — `createConnection`, `deleteConnection`, `renameConnection`, `addConnectionMember`, `removeConnectionMember`, `removeWorktreeFromAllConnections`

**Tests:** Full connection lifecycle (create -> add member -> query -> remove -> delete)

## Files Summary

### Created (14 resolver files + 6 service files + test files)

```
src/main/services/
  worktree-ops.ts
  connection-ops.ts
  settings-detection.ts
  system-info.ts
  project-ops.ts
  file-ops.ts

src/server/resolvers/
  query/
    system.resolvers.ts
    project.resolvers.ts
    worktree.resolvers.ts
    git.resolvers.ts
    file.resolvers.ts
    file-tree.resolvers.ts
    settings.resolvers.ts
    connection.resolvers.ts
  mutation/
    system.resolvers.ts
    project.resolvers.ts
    worktree.resolvers.ts
    git.resolvers.ts
    file.resolvers.ts
    connection.resolvers.ts

test/server/integration/
  operations-system.test.ts
  operations-project-worktree.test.ts
  operations-git.test.ts
  operations-file.test.ts
  operations-connection.test.ts
```

### Modified

| File | Change |
|------|--------|
| `src/server/resolvers/index.ts` | Import and merge all new resolver files |
| `src/main/ipc/worktree-handlers.ts` | Call extracted service |
| `src/main/ipc/connection-handlers.ts` | Call extracted service |
| `src/main/ipc/settings-handlers.ts` | Call extracted service |
| `src/main/ipc/project-handlers.ts` | Call extracted service |
| `src/main/ipc/file-handlers.ts` | Call extracted service |

## What Comes Next

Phase 6 (OpenCode Resolvers) implements AI session management with dual SDK dispatch.
