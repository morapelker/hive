# Phase 5 — Resolvers: Operations (Sessions 43–58)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 5 implements all non-AI operation resolvers: system queries/mutations, project operations, worktree git operations, git file operations (~25 operations), file/file-tree operations, settings detection, and connection management. These resolvers call the existing service functions and IPC handler logic directly, bypassing the IPC layer.

## Prerequisites

- Phases 1-4 completed: shared types, EventBus, SDL schema, codegen, server core, DB resolvers.
- All DB CRUD resolvers working and tested (Phase 4).
- `GraphQLContext` has `db`, `sdkManager`, `eventBus`, `clientIp`, `authenticated`.

## Key Architecture Pattern

Operation resolvers call the same underlying service functions that the IPC handlers in `src/main/ipc/` call. The IPC handlers are thin wrappers — they receive args from `ipcRenderer.invoke()`, call a service function, and return the result. GraphQL resolvers do the same thing, just receiving args from GraphQL instead of IPC.

For some operations, the logic lives directly in the IPC handler file (not a separate service). In these cases, extract the logic into a shared function or call the handler's internal functions directly.

## Source of Truth

| Reference | Purpose |
|-----------|---------|
| `src/preload/index.ts` lines 147-925 | All operation IPC calls to mirror |
| `src/main/ipc/project-handlers.ts` | Project operation implementations |
| `src/main/ipc/worktree-handlers.ts` | Worktree operation implementations |
| `src/main/ipc/git-file-handlers.ts` | Git operation implementations |
| `src/main/ipc/file-tree-handlers.ts` | File tree operation implementations |
| `src/main/ipc/file-handlers.ts` | File read/write implementations |
| `src/main/ipc/settings-handlers.ts` | Settings detection implementations |
| `src/main/ipc/connection-handlers.ts` | Connection operation implementations |
| `src/main/services/git-service.ts` | Git service (simple-git wrapper) |

---

## Session 43: System Query Resolvers

**Goal:** Implement all system query resolvers.

**Definition of Done:** `systemLogDir`, `systemAppVersion`, `systemAppPaths`, `systemDetectAgentSdks`, `systemServerStatus`, `dbSchemaVersion` queries return correct data.

**Tasks:**

1. `[server]` Create `src/server/resolvers/query/system.resolvers.ts`:
   ```typescript
   import { app } from 'electron'
   import { getLogDir } from '../../main/services/logger'
   import { execFileSync } from 'child_process'
   import { existsSync } from 'fs'

   export const systemQueryResolvers = {
     Query: {
       systemLogDir: () => getLogDir(),
       systemAppVersion: () => app.getVersion(),
       systemAppPaths: () => ({
         userData: app.getPath('userData'),
         home: app.getPath('home'),
         logs: getLogDir()
       }),
       systemDetectAgentSdks: () => {
         const whichCmd = process.platform === 'win32' ? 'where' : 'which'
         const check = (binary: string): boolean => {
           try {
             const result = execFileSync(whichCmd, [binary], {
               encoding: 'utf-8', timeout: 5000, env: process.env
             }).trim()
             return !!result.split('\n')[0].trim() && existsSync(result.split('\n')[0].trim())
           } catch { return false }
         }
         return { opencode: check('opencode'), claude: check('claude') }
       },
       systemServerStatus: (_p, _a, ctx) => {
         // Returns server status — implementation depends on server tracking
         return {
           uptime: Math.floor(process.uptime()),
           connections: 0, // tracked by WS server
           requestCount: 0, // tracked by audit plugin
           locked: false, // tracked by auto-lock
           version: app.getVersion()
         }
       }
     }
   }
   ```
   Note: `systemDetectAgentSdks` is the same logic from `src/main/index.ts` lines 274-293. Extract to a shared function or import directly.

2. `[server]` Register in resolver merger.
3. `[server]` Verify: `pnpm build`

---

## Session 44: System Mutation Resolvers

**Goal:** Implement system mutation resolvers.

**Definition of Done:** `systemKillSwitch`, `systemRegisterPushToken` mutations work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/mutation/system.resolvers.ts`:
   ```typescript
   export const systemMutationResolvers = {
     Mutation: {
       systemKillSwitch: async (_p, _a, ctx) => {
         // Invalidate API key, close all connections, shut down server
         ctx.db.setting.delete('headless_api_key_hash')
         // Signal server shutdown (implementation in Phase 9)
         return true
       },
       systemRegisterPushToken: async (_p, { token, platform }, ctx) => {
         ctx.db.setting.set('headless_push_token', token)
         ctx.db.setting.set('headless_push_platform', platform)
         return true
       }
     }
   }
   ```

2. `[server]` Register in resolver merger.
3. `[server]` Verify: `pnpm build`

---

## Session 45: Project Operation Query Resolvers

**Goal:** Implement project operation query resolvers.

**Definition of Done:** `projectValidate`, `projectIsGitRepository`, `projectDetectLanguage`, `projectLanguageIcons`, `projectIconPath` queries work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/query/project.resolvers.ts`:
   - Import the same logic used by `src/main/ipc/project-handlers.ts`
   - `projectValidate(path)` — validates a directory path is a git repo, returns `{ success, path, name, error }`
   - `projectIsGitRepository(path)` — calls git service to check if path is a git repo
   - `projectDetectLanguage(projectPath)` — detects primary programming language
   - `projectLanguageIcons` — loads language icon data URLs
   - `projectIconPath(filename)` — resolves icon filename to full path

   For each resolver, look at how the corresponding IPC handler implements it and call the same service functions. For example:
   - `projectValidate` -> same as `ipcMain.handle('project:validate', ...)` in project-handlers.ts
   - `projectIsGitRepository` -> same as `ipcMain.handle('git:isRepository', ...)` using git-service.ts

2. `[server]` Register in resolver merger.
3. `[server]` Verify: `pnpm build`

---

## Session 46: Project Operation Mutation Resolvers

**Goal:** Implement project operation mutation resolvers.

**Definition of Done:** `projectInitRepository`, `projectUploadIcon`, `projectRemoveIcon` mutations work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/mutation/project.resolvers.ts`:
   - `projectInitRepository(path)` — initializes a new git repo at the given path (same as `git:init` IPC handler)
   - `projectUploadIcon(projectId, data, filename)` — saves icon data (base64 string) to disk, updates DB. Unlike desktop's `pickProjectIcon` which uses a native file dialog, this accepts base64 data directly (mobile sends the image data)
   - `projectRemoveIcon(projectId)` — deletes icon file, clears DB field

2. `[server]` Register in resolver merger.
3. `[server]` Verify: `pnpm build`

---

## Session 47: Worktree Operation Query Resolvers

**Goal:** Implement worktree operation query resolvers.

**Definition of Done:** `worktreeExists`, `worktreeHasCommits`, `gitBranches`, `gitBranchExists` queries work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/query/worktree.resolvers.ts`:
   - `worktreeExists(worktreePath)` — checks if directory exists on disk (same as `worktree:exists` IPC)
   - `worktreeHasCommits(projectPath)` — checks if repo has any commits (same as `worktree:hasCommits` IPC)

   Also add the branch queries that are in `worktreeOps` namespace:
   - `gitBranches(projectPath)` -> `{ success, branches, currentBranch, error }` (same as `git:branches` IPC)
   - `gitBranchExists(projectPath, branchName)` -> boolean (same as `git:branchExists` IPC)

   These call the git service (`simple-git`) methods.

2. `[server]` Register in resolver merger.
3. `[server]` Verify: `pnpm build`

---

## Session 48: Worktree Operation Mutation Resolvers

**Goal:** Implement worktree git operation mutation resolvers.

**Definition of Done:** `createWorktree`, `deleteWorktree`, `syncWorktrees`, `duplicateWorktree`, `renameWorktreeBranch`, `createWorktreeFromBranch` mutations work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/mutation/worktree.resolvers.ts`:
   - `createWorktree(input)` — calls the same logic as `worktree:create` IPC handler: generates branch name, runs `git worktree add`, creates DB record, returns worktree
   - `deleteWorktree(input)` — calls `worktree:delete` logic: runs `git worktree remove`, optionally archives DB record
   - `syncWorktrees(projectId, projectPath)` — calls `worktree:sync` logic: reads actual git worktrees, syncs DB
   - `duplicateWorktree(input)` — calls `worktree:duplicate` logic: creates branch from source, copies uncommitted state
   - `renameWorktreeBranch(input)` — calls `worktree:renameBranch` logic: `git branch -m`, updates DB
   - `createWorktreeFromBranch(input)` — calls `worktree:createFromBranch` logic

   Each of these is a complex operation. Look at `src/main/ipc/worktree-handlers.ts` for the full implementation. The resolver calls the same functions — the IPC handler is just a thin wrapper.

   Consider extracting the core logic from `worktree-handlers.ts` into a shared service function that both IPC and GraphQL can call.

2. `[server]` Register in resolver merger.
3. `[server]` Verify: `pnpm build`

---

## Session 49: Git Query Resolvers — File Status & Diff

**Goal:** Implement git file status and diff query resolvers.

**Definition of Done:** `gitFileStatuses`, `gitDiff`, `gitDiffStat`, `gitFileContent`, `gitRefContent` queries work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/query/git.resolvers.ts`:
   - `gitFileStatuses(worktreePath)` — calls git service `status()`, maps to `GitFileStatus[]` (same as `git:fileStatuses` IPC at `src/main/ipc/git-file-handlers.ts`)
   - `gitDiff(input)` — calls git service `diff()` with worktreePath, filePath, staged, isUntracked, contextLines (same as `git:diff` IPC)
   - `gitDiffStat(worktreePath)` — calls git service `diffStat()` (same as `git:diffStat` IPC)
   - `gitFileContent(worktreePath, filePath)` — reads file from disk (same as `git:getFileContent` IPC)
   - `gitRefContent(worktreePath, ref, filePath)` — reads file from git ref using `git show ref:filePath` (same as `git:getRefContent` IPC)

2. `[server]` Register in resolver merger.
3. `[server]` Verify: `pnpm build`

---

## Session 50: Git Query Resolvers — Branch & Remote

**Goal:** Implement git branch and remote query resolvers.

**Definition of Done:** `gitBranchInfo`, `gitBranches`, `gitBranchExists`, `gitBranchesWithStatus`, `gitIsBranchMerged`, `gitRemoteUrl`, `gitListPRs` queries work.

**Tasks:**

1. `[server]` Add to `git.resolvers.ts`:
   - `gitBranchInfo(worktreePath)` — calls git service, returns `{ name, tracking, ahead, behind }` (same as `git:branchInfo` IPC)
   - `gitBranches(projectPath)` — returns `{ branches, currentBranch }` (already in Session 47, may need to be moved here)
   - `gitBranchExists(projectPath, branchName)` — boolean check
   - `gitBranchesWithStatus(projectPath)` — returns branches with isRemote, isCheckedOut, worktreePath (same as `git:listBranchesWithStatus` IPC)
   - `gitIsBranchMerged(worktreePath, branch)` — checks if branch is merged into HEAD (same as `git:isBranchMerged` IPC)
   - `gitRemoteUrl(worktreePath, remote?)` — returns remote URL (same as `git:getRemoteUrl` IPC)
   - `gitListPRs(projectPath)` — lists PRs via `gh` CLI (same as `git:listPRs` IPC)

2. `[server]` Verify: `pnpm build`

---

## Session 51: Git Mutation Resolvers — Staging

**Goal:** Implement git staging mutation resolvers.

**Definition of Done:** `gitStageFile`, `gitUnstageFile`, `gitStageAll`, `gitUnstageAll`, `gitStageHunk`, `gitUnstageHunk`, `gitRevertHunk` mutations work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/mutation/git.resolvers.ts`:
   - `gitStageFile(worktreePath, filePath)` — `git add <file>` (same as `git:stageFile` IPC)
   - `gitUnstageFile(worktreePath, filePath)` — `git reset HEAD <file>` (same as `git:unstageFile` IPC)
   - `gitStageAll(worktreePath)` — `git add -A` (same as `git:stageAll` IPC)
   - `gitUnstageAll(worktreePath)` — `git reset HEAD` (same as `git:unstageAll` IPC)
   - `gitStageHunk(worktreePath, patch)` — applies patch to index (same as `git:stageHunk` IPC)
   - `gitUnstageHunk(worktreePath, patch)` — reverse-applies patch from index (same as `git:unstageHunk` IPC)
   - `gitRevertHunk(worktreePath, patch)` — reverts hunk in working tree (same as `git:revertHunk` IPC)

   All return `SuccessResult { success, error }`.

2. `[server]` Register in resolver merger.
3. `[server]` Verify: `pnpm build`

---

## Session 52: Git Mutation Resolvers — Commit & Push

**Goal:** Implement git commit, push, pull, discard, and gitignore mutation resolvers.

**Definition of Done:** `gitDiscardChanges`, `gitAddToGitignore`, `gitCommit`, `gitPush`, `gitPull` mutations work.

**Tasks:**

1. `[server]` Add to `git.resolvers.ts`:
   - `gitDiscardChanges(worktreePath, filePath)` — `git checkout -- <file>` (same as `git:discardChanges` IPC)
   - `gitAddToGitignore(worktreePath, pattern)` — appends pattern to .gitignore (same as `git:addToGitignore` IPC)
   - `gitCommit(worktreePath, message)` — `git commit -m` -> returns `{ success, commitHash, error }` (same as `git:commit` IPC)
   - `gitPush(input)` — `git push` with optional remote, branch, force -> `SuccessResult` (same as `git:push` IPC)
   - `gitPull(input)` — `git pull` with optional remote, branch, rebase -> `SuccessResult` (same as `git:pull` IPC)

2. `[server]` Verify: `pnpm build`

---

## Session 53: Git Mutation Resolvers — Merge & Branch

**Goal:** Implement git merge and branch management mutation resolvers.

**Definition of Done:** `gitMerge`, `gitDeleteBranch`, `gitPrMerge` mutations work.

**Tasks:**

1. `[server]` Add to `git.resolvers.ts`:
   - `gitMerge(worktreePath, sourceBranch)` — `git merge <branch>` -> `{ success, error, conflicts }` (same as `git:merge` IPC)
   - `gitDeleteBranch(worktreePath, branchName)` — `git branch -d <branch>` -> `SuccessResult` (same as `git:deleteBranch` IPC)
   - `gitPrMerge(worktreePath, prNumber)` — merges PR via `gh pr merge` CLI (same as `git:prMerge` IPC). After merge, emits `git:statusChanged` via EventBus.

2. `[server]` Verify: `pnpm build`

---

## Session 54: Git Mutation Resolvers — Watching

**Goal:** Implement git watch/unwatch mutation resolvers.

**Definition of Done:** `gitWatchWorktree`, `gitUnwatchWorktree`, `gitWatchBranch`, `gitUnwatchBranch` mutations work.

**Tasks:**

1. `[server]` Add to `git.resolvers.ts`:
   - `gitWatchWorktree(worktreePath)` — starts the WorktreeWatcher for this path (same as `git:watchWorktree` IPC). Calls `watchWorktree(worktreePath)` from `src/main/services/worktree-watcher.ts`.
   - `gitUnwatchWorktree(worktreePath)` — stops the watcher. Calls `unwatchWorktree(worktreePath)`.
   - `gitWatchBranch(worktreePath)` — starts the BranchWatcher for this path. Calls `watchBranch(worktreePath)` from `src/main/services/branch-watcher.ts`.
   - `gitUnwatchBranch(worktreePath)` — stops the branch watcher. Calls `unwatchBranch(worktreePath)`.

   Note: The watchers need to be initialized for headless mode. In GUI mode, they're initialized with `initWorktreeWatcher(mainWindow)` and `initBranchWatcher(mainWindow)`. In headless mode, we skip `mainWindow` initialization but the EventBus emissions (added in Phase 1) still work.

2. `[server]` Verify: `pnpm build`

---

## Session 55: File & FileTree Resolvers

**Goal:** Implement all file and file tree resolvers.

**Definition of Done:** `fileRead`, `fileReadPrompt`, `fileWrite`, `fileTreeScan`, `fileTreeScanFlat`, `fileTreeLoadChildren`, `fileTreeWatch`, `fileTreeUnwatch` all work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/query/file-tree.resolvers.ts`:
   - `fileTreeScan(dirPath)` — scans directory, returns tree structure (same as `file-tree:scan` IPC)
   - `fileTreeScanFlat(dirPath)` — scans via `git ls-files`, returns flat file list (same as `file-tree:scan-flat` IPC)
   - `fileTreeLoadChildren(dirPath, rootPath)` — lazy-loads directory children (same as `file-tree:loadChildren` IPC)

2. `[server]` Create `src/server/resolvers/query/file.resolvers.ts`:
   - `fileRead(filePath)` — reads file content from disk (same as `file:read` IPC)
   - `fileReadPrompt(promptName)` — reads a prompt file (same as `file:readPrompt` IPC)

3. `[server]` Create `src/server/resolvers/mutation/file.resolvers.ts`:
   - `fileWrite(filePath, content)` — writes content to file on disk -> `SuccessResult`
   - `fileTreeWatch(worktreePath)` — starts file tree watcher
   - `fileTreeUnwatch(worktreePath)` — stops file tree watcher

4. `[server]` Register all in resolver merger.
5. `[server]` Verify: `pnpm build`

---

## Session 56: Settings Operation Resolvers

**Goal:** Implement settings detection resolvers.

**Definition of Done:** `detectedEditors`, `detectedTerminals` queries work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/query/settings.resolvers.ts`:
   - `detectedEditors` — detects installed editors (same as `settings:detectEditors` IPC in `src/main/ipc/settings-handlers.ts`)
   - `detectedTerminals` — detects installed terminals (same as `settings:detectTerminals` IPC)

   These iterate over known editor/terminal commands and check if they're available on PATH.

2. `[server]` Register in resolver merger.
3. `[server]` Verify: `pnpm build`

---

## Session 57: Connection Resolvers

**Goal:** Implement all connection resolvers.

**Definition of Done:** `connections`, `connection`, `createConnection`, `deleteConnection`, `renameConnection`, `addConnectionMember`, `removeConnectionMember`, `removeWorktreeFromAllConnections` all work.

**Tasks:**

1. `[server]` Create `src/server/resolvers/query/connection.resolvers.ts`:
   - `connections` — returns all connections with members (same as `connection:getAll` IPC)
   - `connection(connectionId)` — returns single connection with members (same as `connection:get` IPC)

   These call the connection service in `src/main/ipc/connection-handlers.ts`.

2. `[server]` Create `src/server/resolvers/mutation/connection.resolvers.ts`:
   - `createConnection(worktreeIds)` — creates connection with symlinks (same as `connection:create` IPC)
   - `deleteConnection(connectionId)` — deletes connection and symlinks (same as `connection:delete` IPC)
   - `renameConnection(connectionId, customName)` — renames (same as `connection:rename` IPC)
   - `addConnectionMember(connectionId, worktreeId)` — adds member (same as `connection:addMember` IPC)
   - `removeConnectionMember(connectionId, worktreeId)` — removes member (same as `connection:removeMember` IPC)
   - `removeWorktreeFromAllConnections(worktreeId)` — cleans up all connections for a worktree (same as `connection:removeWorktreeFromAll` IPC)

3. `[server]` Register all in resolver merger.
4. `[server]` Verify: `pnpm build`

---

## Session 58: Operation Resolver Tests

**Goal:** Integration tests for all operation resolvers (Sessions 43-57).

**Definition of Done:** Representative tests for each domain, all pass.

**Tasks:**

1. `[server]` Create `test/server/integration/operations.test.ts` with tests:
   - **System**: query `systemAppVersion` returns string, `systemAppPaths` returns all fields, `systemDetectAgentSdks` returns booleans
   - **Project ops**: `projectValidate` with valid path -> success, invalid path -> error
   - **Worktree ops**: `worktreeExists` with valid path -> true, `worktreeHasCommits` returns boolean
   - **Git**: `gitFileStatuses` returns array, `gitBranchInfo` returns branch name, `gitCommit` with message -> commitHash
   - **File**: `fileRead` with valid path -> content, invalid path -> error
   - **FileTree**: `fileTreeScan` returns tree nodes
   - **Settings**: `detectedEditors` returns array of DetectedApp
   - **Connections**: create -> add member -> query -> remove member -> delete

2. `[server]` Create mock services as needed (mock git service, mock file system) in `test/server/helpers/`.

3. `[server]` Run tests: `pnpm vitest run test/server/integration/operations.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/integration/operations.test.ts && pnpm build && pnpm test
```

---

## Summary of Files Created

```
src/server/resolvers/
  query/
    system.resolvers.ts           — System queries
    project.resolvers.ts          — Project operation queries
    worktree.resolvers.ts         — Worktree operation queries
    git.resolvers.ts              — Git queries (file status, diff, branch, remote)
    file-tree.resolvers.ts        — File tree queries
    file.resolvers.ts             — File read queries
    settings.resolvers.ts         — Settings detection queries
    connection.resolvers.ts       — Connection queries
  mutation/
    system.resolvers.ts           — System mutations (kill switch, push token)
    project.resolvers.ts          — Project operation mutations
    worktree.resolvers.ts         — Worktree git operation mutations
    git.resolvers.ts              — Git mutations (staging, commit, push, merge)
    file.resolvers.ts             — File write + tree watch mutations
    connection.resolvers.ts       — Connection mutations

test/server/
  integration/
    operations.test.ts            — Operation resolver integration tests
```

## Summary of Files Modified

| File | Change |
|------|--------|
| `src/server/resolvers/index.ts` | Import and merge all operation resolvers |

## What Comes Next

Phase 6 (OpenCode Resolvers) implements the most complex resolvers — AI session management with dual SDK dispatch (OpenCode + Claude Code).
