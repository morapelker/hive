# Phase 10 — Server Testing & Regression (Sessions 100–105)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 10 is the final server-side phase. It ensures comprehensive test coverage for all GraphQL resolvers, subscriptions, and security features built in Phases 1-9. It also verifies that the existing desktop app is completely unaffected by all changes.

At the end of this phase, the Hive headless server is complete, tested, and production-ready. Implementation moves to the React Native mobile app (separate repository) in Phase 11.

## Prerequisites

- Phases 1-9 completed: full GraphQL server with all resolvers, subscriptions, security, and operational features.
- Test helpers from Phase 4 (test-server, mock-db) and Phase 6 (mock-sdk) available.
- All individual session tests from Phases 4-9 passing.

## Key Source Files (Read-Only Reference)

| File | Purpose |
|------|---------|
| `test/server/helpers/test-server.ts` | Yoga test server helper (Phase 4) |
| `test/server/helpers/mock-db.ts` | In-memory mock DatabaseService (Phase 4) |
| `test/server/helpers/mock-sdk.ts` | Mock AgentSdkManager (Phase 6) |
| `test/server/integration/` | Existing integration tests from prior phases |
| `vitest.config.ts` | Vitest configuration with workspace |
| `package.json` | Test scripts |

## Architecture Notes

### Test Infrastructure

The test server helper creates a yoga instance with mock services. Tests call `yoga.fetch()` for HTTP queries/mutations and use `graphql-ws` client for subscription tests. This avoids starting a real HTTP server for most tests.

```typescript
// test/server/helpers/test-server.ts
import { createYoga, createSchema } from 'graphql-yoga'

export function createTestServer(overrides?: Partial<GraphQLContext>) {
  const mockDb = createMockDb()
  const mockSdk = createMockSdkManager()
  const eventBus = new EventBus()

  const context: GraphQLContext = {
    db: mockDb,
    sdkManager: mockSdk,
    eventBus,
    clientIp: '127.0.0.1',
    authenticated: true,
    ...overrides
  }

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    context: () => context,
    plugins: [] // No auth plugin in tests (already authenticated)
  })

  return { yoga, context, mockDb, mockSdk, eventBus }
}

export async function execute(yoga, query: string, variables?: any) {
  const response = await yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  })
  return response.json()
}
```

### Mock Layering

```
Test → yoga.fetch() → Resolver → Mock Service → Canned Response
                                     ↑
                                Records calls for assertion
```

Mock services record all calls so tests can assert:
- Which service methods were called
- With what arguments
- In what order

---

## Session 100: Integration Test Infrastructure

**Goal:** Finalize the test infrastructure and ensure all helpers work together.

**Definition of Done:** Test server helper, mock DB, and mock SDK all work together. A smoke test passes.

**Tasks:**

1. `[server]` Review and finalize `test/server/helpers/test-server.ts`:
   - Ensure it loads ALL SDL schema files
   - Ensure it merges ALL resolver modules
   - Ensure the context includes all required services
   - Add a `cleanup()` function that resets mocks and EventBus between tests

2. `[server]` Review and finalize `test/server/helpers/mock-db.ts`:
   - In-memory storage for projects, worktrees, sessions, spaces, settings
   - All CRUD methods match the real DatabaseService interface
   - Pre-seed with test data (2 projects, 3 worktrees, 5 sessions, default settings)
   - `reset()` method to restore initial state

3. `[server]` Review and finalize `test/server/helpers/mock-sdk.ts`:
   - Mock `AgentSdkManager` with two mock implementers: `opencode` and `claude-code`
   - Each mock records calls and returns predictable responses
   - Mock `openCodeService` with all methods stubbed
   - `reset()` method to clear recorded calls

4. `[server]` Create a smoke test `test/server/integration/smoke.test.ts`:
   ```typescript
   import { describe, it, expect } from 'vitest'
   import { createTestServer, execute } from '../helpers/test-server'

   describe('Server Smoke Test', () => {
     it('responds to a simple query', async () => {
       const { yoga } = createTestServer()
       const { data } = await execute(yoga, '{ systemAppVersion }')
       expect(data.systemAppVersion).toBeTruthy()
     })

     it('responds to a mutation', async () => {
       const { yoga } = createTestServer()
       const { data } = await execute(yoga, `
         mutation {
           createProject(input: { name: "test", path: "/tmp/test" }) {
             id name path
           }
         }
       `)
       expect(data.createProject.name).toBe('test')
     })
   })
   ```

5. `[server]` Run smoke test:

**Verification:**
```bash
pnpm vitest run test/server/integration/smoke.test.ts
```

---

## Session 101: Full DB Resolver Test Coverage

**Goal:** Ensure all DB CRUD resolvers from Phase 4 have comprehensive test coverage.

**Definition of Done:** Every DB query and mutation resolver has at least one test. Edge cases covered.

**Tasks:**

1. `[server]` Review `test/server/integration/db.test.ts` and add any missing tests. Ensure coverage for:

   **Project resolvers (9 tests):**
   - `projects` query returns all projects
   - `project(id)` returns single project or null
   - `projectByPath(path)` returns project by path
   - `createProject` creates and returns project
   - `updateProject` updates specific fields
   - `deleteProject` removes project
   - `touchProject` updates lastAccessedAt
   - `reorderProjects` changes sort order
   - `createProject` with duplicate path returns error

   **Worktree resolvers (7 tests):**
   - `worktree(id)` returns single worktree
   - `worktreesByProject` returns all worktrees for project
   - `activeWorktreesByProject` excludes archived
   - `updateWorktree` updates fields
   - `archiveWorktree` sets status to archived
   - `touchWorktree` updates lastAccessedAt
   - `appendWorktreeSessionTitle` appends title string

   **Session resolvers (9 tests):**
   - `session(id)` returns single session
   - `sessionsByWorktree` returns sessions for worktree
   - `activeSessionsByWorktree` excludes completed
   - `sessionsByProject` returns sessions for project
   - `sessionsByConnection` returns sessions for connection
   - `searchSessions` with keyword filter
   - `createSession` creates session
   - `updateSession` updates fields
   - `deleteSession` removes session

   **Space resolvers (6 tests):**
   - `spaces` returns all spaces
   - `createSpace` creates space
   - `updateSpace` updates fields
   - `deleteSpace` removes space
   - `assignProjectToSpace` / `removeProjectFromSpace`
   - `reorderSpaces`

   **Settings resolvers (3 tests):**
   - `setting(key)` returns value
   - `setSetting` stores value
   - `deleteSetting` removes key

2. `[server]` Run tests:

**Verification:**
```bash
pnpm vitest run test/server/integration/db.test.ts
```

---

## Session 102: Full Operation Resolver Test Coverage

**Goal:** Ensure all operation resolvers from Phases 5-7 have comprehensive test coverage.

**Definition of Done:** Every operation query and mutation has at least one test.

**Tasks:**

1. `[server]` Review `test/server/integration/operations.test.ts` and add missing tests. Ensure coverage for:

   **System resolvers (6 tests):**
   - `systemLogDir` returns path
   - `systemAppVersion` returns version string
   - `systemAppPaths` returns all paths
   - `systemDetectAgentSdks` returns detection result
   - `systemServerStatus` returns status object
   - `dbSchemaVersion` returns number

   **Project operation resolvers (5 tests):**
   - `projectValidate` with valid/invalid paths
   - `projectIsGitRepository` true/false
   - `projectDetectLanguage` returns language
   - `projectInitRepository` creates repo
   - `projectUploadIcon` / `projectRemoveIcon`

   **Worktree operation resolvers (6 tests):**
   - `createWorktree` creates worktree and branch
   - `deleteWorktree` removes worktree
   - `syncWorktrees` syncs with filesystem
   - `duplicateWorktree` copies worktree
   - `renameWorktreeBranch` renames branch
   - `createWorktreeFromBranch` creates from existing branch

   **Git resolvers (15 tests):**
   - `gitFileStatuses` returns file list
   - `gitDiff` returns diff string
   - `gitDiffStat` returns file stats
   - `gitBranchInfo` returns branch details
   - `gitBranches` returns branch list
   - `gitStageFile` / `gitUnstageFile`
   - `gitStageAll` / `gitUnstageAll`
   - `gitStageHunk` / `gitUnstageHunk`
   - `gitCommit` returns commit hash
   - `gitPush` / `gitPull`
   - `gitMerge` returns merge result
   - `gitDeleteBranch`
   - `gitWatchWorktree` / `gitUnwatchWorktree`

   **File resolvers (5 tests):**
   - `fileTreeScan` returns tree
   - `fileTreeScanFlat` returns flat list
   - `fileTreeLoadChildren` returns children
   - `fileRead` returns content
   - `fileWrite` writes content

   **Connection resolvers (5 tests):**
   - `connections` returns all
   - `createConnection` creates with members
   - `addConnectionMember` / `removeConnectionMember`
   - `deleteConnection`
   - `renameConnection`

   **Script/Terminal/Logging resolvers (5 tests):**
   - `scriptPort` returns number
   - `scriptRunSetup` / `scriptRunProject` / `scriptKill`
   - `terminalCreate` / `terminalWrite` / `terminalResize` / `terminalDestroy`
   - `createResponseLog` / `appendResponseLog`

   **OpenCode resolvers (10 tests):**
   - `opencodeConnect` / `opencodeDisconnect`
   - `opencodePrompt` / `opencodeAbort`
   - `opencodeMessages` / `opencodeSessionInfo`
   - `opencodeModels` / `opencodeSetModel`
   - `opencodeUndo` / `opencodeRedo`
   - `opencodeCommand` / `opencodePermissionReply`
   - `opencodeQuestionReply` / `opencodeQuestionReject`
   - `opencodePlanApprove` / `opencodePlanReject`
   - `opencodeFork` / `opencodeRenameSession`
   - SDK dispatch: `claude-code` session routes correctly

2. `[server]` Run tests:

**Verification:**
```bash
pnpm vitest run test/server/integration/operations.test.ts
```

---

## Session 103: Full Subscription Test Coverage

**Goal:** Ensure all 8 subscriptions have comprehensive test coverage.

**Definition of Done:** Every subscription tested for event delivery, filtering, and cleanup.

**Tasks:**

1. `[server]` Review `test/server/integration/subscriptions.test.ts` and ensure full coverage:

   **For each of the 8 subscriptions, test:**
   - Basic event delivery (event emitted → received by subscriber)
   - Argument filtering (events for other targets not received)
   - Multiple concurrent subscribers receive same events
   - Cleanup: listener removed after client disconnects (EventBus listener count returns to pre-subscription level)

   **OpenCode-specific tests:**
   - `sessionIds` filtering: only matching session events received
   - No `sessionIds`: all events received
   - Batching: rapid events are grouped (50ms window)

   **Terminal-specific tests:**
   - `terminalData`: only receives data for subscribed `worktreeId`
   - `terminalExit`: receives exit code

   **Script-specific tests:**
   - `scriptOutput`: filters by `channel` argument
   - All `ScriptOutputEvent` types tested: `command-start`, `output`, `error`, `done`

2. `[server]` Add a stress test:
   ```typescript
   it('handles rapid event emission without dropping', async () => {
     const events: any[] = []
     const sub = subscribe('subscription { opencodeStream { type } }')

     // Emit 100 events rapidly
     for (let i = 0; i < 100; i++) {
       testEventBus.emit('opencode:stream', {
         type: `event-${i}`,
         sessionId: 'sess-1',
         data: {}
       })
     }

     // Wait for all events to be received
     await new Promise(r => setTimeout(r, 200))
     expect(events.length).toBe(100)
   })
   ```

3. `[server]` Run tests:

**Verification:**
```bash
pnpm vitest run test/server/integration/subscriptions.test.ts
```

---

## Session 104: Regression Test Suite

**Goal:** Verify ALL existing tests pass and no regressions were introduced.

**Definition of Done:** `pnpm test` passes, `pnpm build` succeeds, `pnpm lint` is clean.

**Tasks:**

1. `[server]` Run the full existing test suite:
   ```bash
   pnpm test
   ```
   - ALL tests (both existing and new server tests) must pass
   - Zero new failures in existing renderer/main tests
   - If any existing tests fail, investigate and fix the regression (likely caused by import changes or type modifications)

2. `[server]` Run lint:
   ```bash
   pnpm lint
   ```
   - No new lint errors
   - New server files follow existing code style (no semicolons, single quotes, 2-space indent)

3. `[server]` Run production build:
   ```bash
   pnpm build
   ```
   - Build completes with no errors
   - Output in `out/` directory is correct

4. `[server]` Check for any type errors in the shared types:
   ```bash
   npx tsc --noEmit
   ```
   - Zero type errors across the entire project

5. `[server]` Verify the new server code doesn't increase the desktop app bundle size significantly (EventBus and shared types are tiny; server code should be tree-shaken out of the renderer bundle).

**Verification:**
```bash
pnpm test && pnpm lint && pnpm build
```

---

## Session 105: Desktop Smoke Test

**Goal:** Manual verification that the desktop app works exactly as before.

**Definition of Done:** All desktop features work identically — zero behavioral changes from the server implementation.

**Tasks:**

1. `[server]` Start the desktop app in dev mode:
   ```bash
   pnpm dev
   ```

2. `[server]` Manually verify each feature area:

   **Project Management:**
   - Create a new project (add existing git repo)
   - View project in project list
   - Edit project settings
   - Delete a project

   **Worktree Management:**
   - Create a new worktree
   - Switch between worktrees
   - Archive a worktree
   - Duplicate a worktree

   **AI Sessions:**
   - Start a new OpenCode session
   - Send a prompt and see streaming response
   - Verify tool cards render correctly
   - Handle a permission request (if one appears)
   - Abort a running session
   - Undo/redo if supported

   **Git Operations:**
   - View file status (modified, staged, untracked)
   - Stage/unstage files
   - View diffs
   - Commit changes
   - Push/pull

   **File Tree:**
   - Browse files
   - Open a file in viewer
   - Verify file watching (create a file externally, see it appear)

   **Terminal:**
   - Open terminal
   - Run a command
   - Close terminal

   **Other:**
   - Settings work
   - Command palette works
   - Keyboard shortcuts work
   - Connections work (if applicable)

3. `[server]` Verify that the EventBus emissions don't cause any console errors or performance issues in the desktop app. The EventBus should have zero listeners when no GraphQL server is running (GUI mode), so emissions should be no-ops.

4. `[server]` Document any issues found and create fix tasks if needed.

**Verification:**
```
Manual verification — no automated test command.
Document results in a test report or comment.
```

---

## Summary of Files Created

```
test/server/
  helpers/
    test-server.ts                  — Finalized test server helper
    mock-db.ts                      — Finalized mock DatabaseService
    mock-sdk.ts                     — Finalized mock AgentSdkManager
  integration/
    smoke.test.ts                   — Basic server smoke test
    db.test.ts                      — Full DB resolver coverage (review/expand)
    operations.test.ts              — Full operation resolver coverage (review/expand)
    subscriptions.test.ts           — Full subscription coverage (review/expand)
    security.test.ts                — Security test suite (from Phase 9)
```

## Summary of Files Modified

| File | Change |
|------|--------|
| `test/server/integration/db.test.ts` | Add missing test cases |
| `test/server/integration/operations.test.ts` | Add missing test cases |
| `test/server/integration/subscriptions.test.ts` | Add missing test cases |

## What Comes Next

Phase 11 (React Native Foundation, Sessions 106-113) begins the mobile app in a separate repository. It scaffolds the React Native project, sets up NativeWind, React Navigation, Apollo Client, codegen, transport abstraction, connection manager, and pairing screen.
