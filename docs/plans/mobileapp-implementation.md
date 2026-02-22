# Hive Headless Server + Mobile App — Implementation Plan

**PRD Reference:** `docs/plans/mobileapp.md`

**Two repositories:**
- **server** = this repo (`hive-electron`) — GraphQL server, EventBus, shared types, headless mode
- **app** = separate React Native repo — mobile client consuming the GraphQL API

Each task is prefixed with `[server]` or `[app]` to indicate which project it belongs to.

---

## Session Map

| # | Session | Focus |
|---|---------|-------|
| **Phase 1 — Foundation** | | |
| 1 | Server Dependencies | Install graphql-yoga, graphql-ws, ws, codegen, qrcode-terminal |
| 2 | Directory Scaffolding | Create `src/server/`, `src/shared/` directory trees |
| 3 | Shared Types — Entities | Extract Project, Worktree, Session, Space, Connection types |
| 4 | Shared Types — Domain | Extract Git, OpenCode, FileTree, Script, Terminal, Settings types |
| 5 | Shared Types — Barrel Export | Index file, verify imports compile |
| 6 | EventBus — Core | Create typed EventEmitter with full event map |
| 7 | EventBus — Unit Tests | Test all event types, on/off/emit, removeAll |
| 8 | EventBus — Service Integration (OpenCode + Claude) | Add EventBus emission to opencode-service.ts and claude-code-implementer.ts |
| 9 | EventBus — Handler Integration (Git, FileTree, Terminal, Script) | Add EventBus emission to remaining 6 files |
| 10 | EventBus — Regression Check | Verify all existing tests still pass |
| **Phase 2 — SDL Schema** | | |
| 11 | SDL Types — Entities | Project, Worktree, Session, Space, Connection GraphQL types |
| 12 | SDL Types — Domain | Git, OpenCode, FileTree, Script, Terminal, Settings, System types |
| 13 | SDL Types — Inputs | All GraphQL input types (~28 inputs) |
| 14 | SDL Types — Results | All result wrapper types (SuccessResult, etc.) |
| 15 | SDL Root — Query | All Query fields |
| 16 | SDL Root — Mutation | All Mutation fields |
| 17 | SDL Root — Subscription | All Subscription fields |
| 18 | Codegen Setup | graphql-codegen config, generate resolver types |
| **Phase 3 — Server Core** | | |
| 19 | GraphQL Context | Context interface with all services |
| 20 | Server Entry Point | createYoga + HTTPS + WebSocket setup |
| 21 | Headless Bootstrap | Service initialization sequence for headless mode |
| 22 | Auth — API Key Generation | Key generation, hashing, storage in settings table |
| 23 | Auth — Verification Plugin | Yoga plugin for Bearer token verification |
| 24 | Auth — Brute Force Protection | Failed attempt tracking, IP blocking |
| 25 | Auth — WebSocket Auth | connectionParams verification during WS handshake |
| 26 | Path Guard Plugin | Path traversal prevention for file arguments |
| 27 | TLS Certificate Generation | ECDSA P-256 self-signed cert, fingerprint storage |
| 28 | Config Loader | ~/.hive/headless.json loading with defaults |
| 29 | Headless CLI — Flag Parsing | --headless, --port, --bind flag parsing in main/index.ts |
| 30 | Headless CLI — Startup Branch | Skip createWindow, call headlessBootstrap instead |
| 31 | Headless CLI — Management Commands | --rotate-key, --regen-certs, --show-status, --kill, --unlock |
| **Phase 4 — Resolvers: Database CRUD** | | |
| 32 | DB Query Resolvers — Projects | projects, project, projectByPath queries |
| 33 | DB Query Resolvers — Worktrees | worktree, worktreesByProject, activeWorktreesByProject queries |
| 34 | DB Query Resolvers — Sessions | session, sessionsByWorktree, activeSessionsByWorktree, sessionsByProject, searchSessions, sessionDraft queries |
| 35 | DB Query Resolvers — Sessions (Connection) | sessionsByConnection, activeSessionsByConnection queries |
| 36 | DB Query Resolvers — Spaces & Settings | spaces, spaceProjectIds, allSpaceAssignments, setting, allSettings queries |
| 37 | DB Mutation Resolvers — Projects | createProject, updateProject, deleteProject, touchProject, reorderProjects |
| 38 | DB Mutation Resolvers — Worktrees | updateWorktree, archiveWorktree, touchWorktree, appendWorktreeSessionTitle, updateWorktreeModel |
| 39 | DB Mutation Resolvers — Sessions | createSession, updateSession, deleteSession, updateSessionDraft |
| 40 | DB Mutation Resolvers — Spaces | createSpace, updateSpace, deleteSpace, assignProjectToSpace, removeProjectFromSpace, reorderSpaces |
| 41 | DB Mutation Resolvers — Settings | setSetting, deleteSetting |
| 42 | DB Resolver Tests | Integration tests for all DB resolvers via yoga.fetch() |
| **Phase 5 — Resolvers: Operations** | | |
| 43 | System Query Resolvers | systemLogDir, systemAppVersion, systemAppPaths, systemDetectAgentSdks, systemServerStatus, dbSchemaVersion |
| 44 | System Mutation Resolvers | systemKillSwitch, systemRegisterPushToken |
| 45 | Project Operation Query Resolvers | projectValidate, projectIsGitRepository, projectDetectLanguage, projectLanguageIcons, projectIconPath |
| 46 | Project Operation Mutation Resolvers | projectInitRepository, projectUploadIcon, projectRemoveIcon |
| 47 | Worktree Operation Query Resolvers | worktreeExists, worktreeHasCommits, getBranches, branchExists |
| 48 | Worktree Operation Mutation Resolvers | createWorktree, deleteWorktree, syncWorktrees, duplicateWorktree, renameWorktreeBranch, createWorktreeFromBranch |
| 49 | Git Query Resolvers — File Status & Diff | gitFileStatuses, gitDiff, gitDiffStat, gitFileContent, gitRefContent |
| 50 | Git Query Resolvers — Branch & Remote | gitBranchInfo, gitBranches, gitBranchExists, gitBranchesWithStatus, gitIsBranchMerged, gitRemoteUrl, gitListPRs |
| 51 | Git Mutation Resolvers — Staging | gitStageFile, gitUnstageFile, gitStageAll, gitUnstageAll, gitStageHunk, gitUnstageHunk, gitRevertHunk |
| 52 | Git Mutation Resolvers — Commit & Push | gitDiscardChanges, gitAddToGitignore, gitCommit, gitPush, gitPull |
| 53 | Git Mutation Resolvers — Merge & Branch | gitMerge, gitDeleteBranch, gitPrMerge |
| 54 | Git Mutation Resolvers — Watching | gitWatchWorktree, gitUnwatchWorktree, gitWatchBranch, gitUnwatchBranch |
| 55 | File & FileTree Resolvers | fileRead, fileReadPrompt, fileWrite, fileTreeScan, fileTreeScanFlat, fileTreeLoadChildren, fileTreeWatch, fileTreeUnwatch |
| 56 | Settings Operation Resolvers | detectedEditors, detectedTerminals |
| 57 | Connection Resolvers | connections, connection, createConnection, deleteConnection, renameConnection, addConnectionMember, removeConnectionMember, removeWorktreeFromAllConnections |
| 58 | Operation Resolver Tests | Integration tests for sessions 43-57 |
| **Phase 6 — Resolvers: OpenCode AI** | | |
| 59 | OpenCode Mutation — Connect & Disconnect | opencodeConnect, opencodeReconnect, opencodeDisconnect |
| 60 | OpenCode Mutation — Prompt & Abort | opencodePrompt (string + MessagePart[]), opencodeAbort |
| 61 | OpenCode Query — Messages & Session Info | opencodeMessages, opencodeSessionInfo |
| 62 | OpenCode Query — Models | opencodeModels, opencodeModelInfo |
| 63 | OpenCode Mutation — Model Selection | opencodeSetModel |
| 64 | OpenCode Mutation — Undo & Redo | opencodeUndo, opencodeRedo |
| 65 | OpenCode Query — Commands & Capabilities | opencodeCommands, opencodeCapabilities |
| 66 | OpenCode Mutation — Command Execution | opencodeCommand |
| 67 | OpenCode Mutation — Permissions | opencodePermissionReply, opencodePermissionList query |
| 68 | OpenCode Mutation — Questions | opencodeQuestionReply, opencodeQuestionReject |
| 69 | OpenCode Mutation — Plans | opencodePlanApprove, opencodePlanReject |
| 70 | OpenCode Mutation — Fork & Rename | opencodeFork, opencodeRenameSession |
| 71 | OpenCode SDK Dispatch | Implement agent_sdk check + routing to sdkManager for claude-code sessions |
| 72 | OpenCode Resolver Tests | Integration tests for all OpenCode resolvers |
| **Phase 7 — Resolvers: Script, Terminal, Logging** | | |
| 73 | Script Resolvers | scriptPort query, scriptRunSetup, scriptRunProject, scriptKill, scriptRunArchive mutations |
| 74 | Terminal Resolvers | terminalCreate, terminalWrite, terminalResize, terminalDestroy mutations |
| 75 | Logging Resolvers | createResponseLog, appendResponseLog mutations |
| 76 | Script/Terminal/Logging Tests | Integration tests |
| **Phase 8 — Subscriptions** | | |
| 77 | OpenCode Stream Subscription — Core | Async generator listening to EventBus opencode:stream |
| 78 | OpenCode Stream Subscription — Session Filtering | Filter events by sessionIds argument |
| 79 | OpenCode Stream Subscription — Batching | 50ms event accumulation to reduce WS frames |
| 80 | Git Status Subscription | gitStatusChanged subscription from EventBus git:statusChanged |
| 81 | Git Branch Subscription | gitBranchChanged subscription from EventBus git:branchChanged |
| 82 | File Tree Subscription | fileTreeChange subscription from EventBus file-tree:change |
| 83 | Terminal Data Subscription | terminalData subscription from EventBus terminal:data (dynamic per worktreeId) |
| 84 | Terminal Exit Subscription | terminalExit subscription from EventBus terminal:exit |
| 85 | Script Output Subscription | scriptOutput subscription from EventBus script:output (dynamic channel) |
| 86 | Worktree Branch Renamed Subscription | worktreeBranchRenamed subscription from EventBus |
| 87 | Subscription Integration Tests | WS client tests for all subscriptions |
| **Phase 9 — Security & Operations** | | |
| 88 | Audit Logging Plugin | Request logging with IP, operation, timing |
| 89 | Sensitive Operation Logging | Extra detail for terminal, script, git push, kill switch |
| 90 | Auto-Lock — Activity Tracking | Track last request timestamp |
| 91 | Auto-Lock — Lock Mode | Block API after inactivityTimeoutMin, except systemServerStatus |
| 92 | Auto-Lock — Unlock CLI | --unlock command via PID file signal |
| 93 | Kill Switch Implementation | systemKillSwitch mutation + --kill CLI |
| 94 | QR Code Pairing | Display API key + QR code on first headless start |
| 95 | Key Rotation | --rotate-key generates new key, invalidates old, displays new QR |
| 96 | Cert Regeneration | --regen-certs deletes and recreates TLS certs |
| 97 | PID File | Write ~/.hive/hive-headless.pid on startup, delete on shutdown |
| 98 | Status File | Write ~/.hive/hive-headless.status.json every 30s |
| 99 | Security Test Suite | Auth, brute force, path guard, kill switch, auto-lock tests |
| **Phase 10 — Server Testing & Regression** | | |
| 100 | Integration Test Infrastructure | Mock database, mock services, yoga test helper |
| 101 | Full DB Resolver Test Coverage | All CRUD operations tested |
| 102 | Full Operation Resolver Test Coverage | All domain operations tested |
| 103 | Full Subscription Test Coverage | All 8 subscriptions tested via WS |
| 104 | Regression Test Suite | Existing pnpm test passes, pnpm build succeeds, pnpm lint clean |
| 105 | Desktop Smoke Test | Manual: start desktop app normally, verify all features work |
| **Phase 11 — React Native Foundation** | | |
| 106 | App Scaffolding | React Native project init, folder structure |
| 107 | NativeWind Setup | Tailwind CSS for React Native configuration |
| 108 | React Navigation Setup | Bottom tabs + native stacks |
| 109 | Apollo Client Setup | HTTP + WS split link, auth headers |
| 110 | Codegen Setup | graphql-codegen for typed hooks from SDL |
| 111 | Transport Abstraction | HiveTransport interface + GraphQL transport implementation |
| 112 | Connection Manager Store | Server URL, API key, connection state, Keychain storage |
| 113 | Pairing Screen | QR scanner, manual entry, test connection |
| **Phase 12 — Shared Logic Port** | | |
| 114 | Port Project Store | useProjectStore with GraphQL transport |
| 115 | Port Worktree Store | useWorktreeStore with GraphQL transport |
| 116 | Port Session Store | useSessionStore (~1200 lines) with GraphQL transport |
| 117 | Port Status Stores | useWorktreeStatusStore, useContextStore |
| 118 | Port Permission & Question Stores | usePermissionStore, useQuestionStore |
| 119 | Port Remaining Stores | useGitStore, useFileTreeStore, useFileViewerStore, useSettingsStore, useConnectionStore, useSpaceStore |
| 120 | Extract Stream Event Handler | handleStreamEvent() from useOpenCodeGlobalListener |
| **Phase 13 — Mobile Core Screens** | | |
| 121 | Project Browser Screen | SectionList with project headers, worktree rows |
| 122 | Worktree Detail Screen | Branch info, status badges, session list |
| 123 | Session View — Message List | FlashList with user/assistant bubbles, markdown rendering |
| 124 | Session View — Input Area | Multiline TextInput, Send/Abort button, mode chip |
| 125 | Session View — Streaming | opencodeStream subscription integration, 30fps throttle |
| 126 | Session View — Tool Cards | Collapsed tool invocations, expandable detail |
| 127 | Permission Modal | Sticky banner with Allow/Deny buttons |
| 128 | Question Modal | Answer chips bottom sheet |
| 129 | Plan Approval Modal | Scrollable markdown + Approve/Reject |
| 130 | Model Selector | Bottom sheet with provider/model list |
| **Phase 14 — Mobile Feature Screens** | | |
| 131 | File Tree Browser | FlashList with indentation, file/folder icons, search |
| 132 | File Viewer | Syntax-highlighted with line numbers |
| 133 | File Editor | Monospace TextInput, save button |
| 134 | Git Changes Panel | Staged/unstaged sections, swipe actions |
| 135 | Git Commit & Push | Commit form, push/pull with ahead/behind counts |
| 136 | Diff Viewer | Unified diff with green/red, hunk staging |
| 137 | Simplified Terminal | TextInput + Run button, monospace ScrollView output |
| 138 | Settings Screen | Connection, AI Model, Agent SDK, Appearance |
| 139 | Session History Search | Search across sessions with filters |
| **Phase 15 — Mobile Polish** | | |
| 140 | Push Notifications | FCM/APNs integration, server token registration |
| 141 | Deep Linking | Notification tap → relevant screen |
| 142 | Actionable Notifications | Allow/Deny directly from notification |
| 143 | Offline & Reconnection | Connection state machine, exponential backoff, state recovery |
| 144 | Performance Optimization | FlashList tuning, streaming batching, Apollo cache |
| **Phase 16 — Mobile Testing** | | |
| 145 | Unit Tests — Stores | Shared stores with mock GraphQL transport |
| 146 | Component Tests | React Native Testing Library |
| 147 | E2E Tests | Detox test suite |
| 148 | App Store Preparation | Icons, splash, metadata, build config |

---

## Phase 1 — Foundation

---

### Session 1: Server Dependencies

**Goal:** Install all production and dev dependencies needed for the GraphQL server.

**Definition of Done:** All packages installed, `pnpm build` succeeds, `pnpm test` still passes with zero new failures.

**Tasks:**

1. `[server]` Install production dependencies: `pnpm add graphql graphql-yoga graphql-ws ws qrcode-terminal`
2. `[server]` Install dev dependencies: `pnpm add -D @graphql-codegen/cli @graphql-codegen/typescript @graphql-codegen/typescript-resolvers @types/ws`
3. `[server]` Run `pnpm build` — verify it succeeds with no errors
4. `[server]` Run `pnpm test` — verify all existing tests still pass

**Verification:**
```bash
pnpm build && pnpm test
```

---

### Session 2: Directory Scaffolding

**Goal:** Create all empty directory structures for the server and shared code.

**Definition of Done:** All directories exist with placeholder `.gitkeep` files where needed.

**Tasks:**

1. `[server]` Create `src/server/` directory
2. `[server]` Create `src/server/schema/` and `src/server/schema/types/`
3. `[server]` Create `src/server/resolvers/`, `src/server/resolvers/query/`, `src/server/resolvers/mutation/`, `src/server/resolvers/subscription/`
4. `[server]` Create `src/server/plugins/`
5. `[server]` Create `src/server/__generated__/` (codegen output)
6. `[server]` Create `src/shared/`, `src/shared/types/`, `src/shared/lib/`
7. `[server]` Run `pnpm build` — verify scaffolding doesn't break anything

**Verification:**
```bash
ls -la src/server/ src/shared/ && pnpm build
```

---

### Session 3: Shared Types — Entities

**Goal:** Extract Project, Worktree, Session, Space, and Connection types from `src/preload/index.d.ts` into `src/shared/types/`.

**Definition of Done:** Types extracted into individual files, compile cleanly, existing code unaffected.

**Source of truth:** `src/preload/index.d.ts`

**Tasks:**

1. `[server]` Create `src/shared/types/project.ts` — export `Project` interface (extracted from `index.d.ts` lines 30-45). Fields: id, name, path, description, tags, language, custom_icon, setup_script, run_script, archive_script, auto_assign_port, sort_order, created_at, last_accessed_at.
2. `[server]` Create `src/shared/types/worktree.ts` — export `Worktree` interface (lines 47-63). Fields: id, project_id, name, branch_name, path, status ('active'|'archived'), is_default, branch_renamed, last_message_at, session_titles, last_model_provider_id, last_model_id, last_model_variant, created_at, last_accessed_at.
3. `[server]` Create `src/shared/types/session.ts` — export `Session`, `SessionWithWorktree`, `SessionSearchOptions` interfaces (lines 65-101).
4. `[server]` Create `src/shared/types/space.ts` — export `Space` (id, name, icon_type, icon_value, sort_order, created_at) and `ProjectSpaceAssignment` (project_id, space_id) interfaces (lines 118-130).
5. `[server]` Create `src/shared/types/connection.ts` — export `Connection`, `ConnectionMember`, `ConnectionWithMembers` interfaces (lines 2-28).
6. `[server]` Run `npx tsc --noEmit src/shared/types/project.ts src/shared/types/worktree.ts src/shared/types/session.ts src/shared/types/space.ts src/shared/types/connection.ts` — verify all compile.

**Verification:**
```bash
pnpm build
```

---

### Session 4: Shared Types — Domain

**Goal:** Extract all domain-specific types (Git, OpenCode, FileTree, Script, Terminal, Settings).

**Definition of Done:** All domain types extracted, compile cleanly.

**Source of truth:** `src/preload/index.d.ts`

**Tasks:**

1. `[server]` Create `src/shared/types/git.ts` — export `GitStatusCode` type ('M'|'A'|'D'|'?'|'C'|''), `GitFileStatus` (path, relativePath, status, staged), `GitStatusChangedEvent` (worktreePath), `GitBranchInfo` (name, tracking, ahead, behind), `GitDiffStatFile` (path, additions, deletions, binary). Source: lines 1104-1123, 1015-1020.
2. `[server]` Create `src/shared/types/opencode.ts` — export `OpenCodeStreamEvent` (type, sessionId, data, childSessionId?, statusPayload?), `OpenCodeCommand` (name, description?, template, agent?, model?, source?, subtask?, hints?), `PermissionRequest` (id, sessionID, permission, patterns, metadata, always, tool?), `MessagePart` type union. Source: lines 1022-1075.
3. `[server]` Create `src/shared/types/file-tree.ts` — export `FileTreeNode` (name, path, relativePath, isDirectory, isSymlink?, extension, children?), `FlatFile` (name, path, relativePath, extension), `FileTreeChangeEvent` (worktreePath, eventType, changedPath, relativePath). Source: lines 1078-1102.
4. `[server]` Create `src/shared/types/script.ts` — export `ScriptOutputEvent` (type: 'command-start'|'output'|'error'|'done', command?, data?, exitCode?). Source: lines 1028-1033.
5. `[server]` Create `src/shared/types/terminal.ts` — export `GhosttyTerminalConfig` interface. Source: lines 104-116.
6. `[server]` Create `src/shared/types/settings.ts` — export `Setting` (key, value) and `DetectedApp` (id, name, command, available). Source: lines 82-86, 1125-1131.

**Verification:**
```bash
pnpm build
```

---

### Session 5: Shared Types — Barrel Export

**Goal:** Create barrel export and verify all types are importable from a single path.

**Definition of Done:** `import { Project, Worktree, Session, ... } from '../shared/types'` works.

**Tasks:**

1. `[server]` Create `src/shared/types/index.ts` — re-export all types from each domain file (`export * from './project'`, `export * from './worktree'`, etc.).
2. `[server]` Verify barrel compiles: `pnpm build`
3. `[server]` Run `pnpm test` — confirm zero regressions.

**Verification:**
```bash
pnpm build && pnpm test
```

---

### Session 6: EventBus — Core

**Goal:** Create the typed EventBus that bridges service events to GraphQL subscriptions.

**Definition of Done:** EventBus class with typed event map, singleton getter, compile clean.

**Tasks:**

1. `[server]` Create `src/server/event-bus.ts` with:
   - `EventBusEvents` interface mapping all 8 event channels to their argument tuples:
     - `'opencode:stream'` → `[event: { type: string; sessionId: string; data: unknown; childSessionId?: string; statusPayload?: { type: string; attempt?: number; message?: string; next?: number } }]`
     - `'worktree:branchRenamed'` → `[data: { worktreeId: string; newBranch: string }]`
     - `'git:statusChanged'` → `[data: { worktreePath: string }]`
     - `'git:branchChanged'` → `[data: { worktreePath: string }]`
     - `'file-tree:change'` → `[event: { worktreePath: string; eventType: string; changedPath: string; relativePath: string }]`
     - `'script:output'` → `[channel: string, event: { type: string; command?: string; data?: string; exitCode?: number }]`
     - `'terminal:data'` → `[worktreeId: string, data: string]`
     - `'terminal:exit'` → `[worktreeId: string, code: number]`
   - `EventBus` class wrapping Node.js `EventEmitter` with typed `emit`, `on`, `off`, `removeAllListeners` methods
   - `getEventBus()` singleton getter
   - `resetEventBus()` for test cleanup
2. `[server]` Verify it compiles: `pnpm build`

**Verification:**
```bash
pnpm build
```

---

### Session 7: EventBus — Unit Tests

**Goal:** Unit tests for the EventBus class.

**Definition of Done:** All event types tested, on/off/emit verified, removeAllListeners verified.

**Tasks:**

1. `[server]` Create `test/server/event-bus.test.ts` with tests:
   - Emits and receives `opencode:stream` events with correct shape
   - Emits and receives `terminal:data` events with two arguments (worktreeId, data)
   - Emits and receives `script:output` events with two arguments (channel, event)
   - Emits and receives `git:statusChanged` events
   - `off()` removes a specific listener (emit after off → not received)
   - `removeAllListeners()` clears all listeners for all events
   - Multiple listeners on same event all receive the event
   - Listeners for different events don't interfere
2. `[server]` Run tests: `pnpm vitest run test/server/event-bus.test.ts` — all pass.

**Verification:**
```bash
pnpm vitest run test/server/event-bus.test.ts
```

---

### Session 8: EventBus — Service Integration (OpenCode + Claude)

**Goal:** Add EventBus emission to the two AI service files that use `sendToRenderer`.

**Definition of Done:** `opencode-service.ts` and `claude-code-implementer.ts` emit to EventBus alongside `webContents.send`, zero changes to existing behavior.

**Files to modify:**
- `src/main/services/opencode-service.ts` — `sendToRenderer` method at line 1264
- `src/main/services/claude-code-implementer.ts` — `sendToRenderer` method at line 2319

**Tasks:**

1. `[server]` Modify `src/main/services/opencode-service.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - In `sendToRenderer` method (line 1264), AFTER the existing `webContents.send` line, add:
     ```
     const bus = getEventBus()
     if (channel === 'opencode:stream') bus.emit('opencode:stream', data)
     else if (channel === 'worktree:branchRenamed') bus.emit('worktree:branchRenamed', data)
     ```
   - This adds ~4 lines. The existing `webContents.send` call is UNCHANGED.
2. `[server]` Modify `src/main/services/claude-code-implementer.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - In `sendToRenderer` method (line 2319), AFTER the existing `webContents.send` line, add the same EventBus emission pattern.
   - This adds ~4 lines. The existing behavior is UNCHANGED.
3. `[server]` Run `pnpm build` — verify no compile errors.
4. `[server]` Run `pnpm test` — verify zero regressions.

**Verification:**
```bash
pnpm build && pnpm test
```

---

### Session 9: EventBus — Handler Integration (Git, FileTree, Terminal, Script)

**Goal:** Add EventBus emission to the remaining 6 files that send events to the renderer.

**Definition of Done:** All push-event sites in the codebase also emit to EventBus.

**Files to modify:**
- `src/main/services/worktree-watcher.ts` — `emitGitStatusChanged` at line 88
- `src/main/services/branch-watcher.ts` — `emitBranchChanged` at line 54
- `src/main/ipc/file-tree-handlers.ts` — debounced `webContents.send` at line 274
- `src/main/ipc/git-file-handlers.ts` — `webContents.send` at line 589 (after PR merge)
- `src/main/services/script-runner.ts` — `sendEvent` at line 135
- `src/main/ipc/terminal-handlers.ts` — `terminal:data` at line 68, `terminal:exit` at line 77

**Tasks:**

1. `[server]` Modify `src/main/services/worktree-watcher.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - In `emitGitStatusChanged` (line 88), after the `webContents.send` line, add: `getEventBus().emit('git:statusChanged', { worktreePath })`
2. `[server]` Modify `src/main/services/branch-watcher.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - In `emitBranchChanged` (line 54), after the `webContents.send` line, add: `getEventBus().emit('git:branchChanged', { worktreePath })`
3. `[server]` Modify `src/main/ipc/file-tree-handlers.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - After the `mainWindow?.webContents.send('file-tree:change', ...)` at line 274, add: `getEventBus().emit('file-tree:change', { worktreePath, eventType, changedPath, relativePath: relative(worktreePath, changedPath) })`
4. `[server]` Modify `src/main/ipc/git-file-handlers.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - After the `webContents.send('git:statusChanged', ...)` at line 589, add: `getEventBus().emit('git:statusChanged', { worktreePath })`
5. `[server]` Modify `src/main/services/script-runner.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - In `sendEvent` method (line 135), after the `webContents.send` line, add: `getEventBus().emit('script:output', eventKey, event)`
6. `[server]` Modify `src/main/ipc/terminal-handlers.ts`:
   - Add import: `import { getEventBus } from '../../server/event-bus'`
   - After the `terminal:data` send at line 68, add: `getEventBus().emit('terminal:data', worktreeId, buffered)`
   - After the `terminal:exit` send at line 77, add: `getEventBus().emit('terminal:exit', worktreeId, code)`
7. `[server]` Run `pnpm build` — verify no compile errors.

**Verification:**
```bash
pnpm build
```

---

### Session 10: EventBus — Regression Check

**Goal:** Full regression test to confirm EventBus integration didn't break anything.

**Definition of Done:** All existing tests pass, build succeeds, lint clean.

**Tasks:**

1. `[server]` Run `pnpm test` — ALL existing tests pass.
2. `[server]` Run `pnpm lint` — no new lint errors.
3. `[server]` Run `pnpm build` — production build succeeds.

**Verification:**
```bash
pnpm test && pnpm lint && pnpm build
```

---

## Phase 2 — SDL Schema

---

### Session 11: SDL Types — Entities

**Goal:** Write GraphQL type definitions for all database entities.

**Definition of Done:** `.graphql` files with all entity types, valid SDL syntax.

**Tasks:**

1. `[server]` Create `src/server/schema/types/project.graphql` with:
   - `type Project` — all 14 fields matching `src/shared/types/project.ts` (camelCase GraphQL convention: `id: ID!`, `name: String!`, `path: String!`, `description: String`, `tags: String`, `language: String`, `customIcon: String`, `setupScript: String`, `runScript: String`, `archiveScript: String`, `autoAssignPort: Boolean!`, `sortOrder: Int!`, `createdAt: String!`, `lastAccessedAt: String`)
   - `type Worktree` — all fields from `src/shared/types/worktree.ts`
   - `type Session` — all fields from `src/shared/types/session.ts`
   - `type SessionWithWorktree` extending Session with worktree_name, worktree_branch_name, project_name
   - `enum WorktreeStatus { active, archived }`
   - `enum SessionStatus { active, completed, error }`
   - `enum SessionMode { build, plan }`
   - `enum AgentSdk { opencode, claude_code }`
2. `[server]` Create `src/server/schema/types/connection.graphql` with:
   - `type Connection` — id, name, status, path, color, createdAt, updatedAt
   - `type ConnectionMember` — id, connectionId, worktreeId, projectId, symlinkName, addedAt
   - `type ConnectionWithMembers` — extends Connection with members array (including joined worktree/project names)
3. `[server]` Add Space types to `project.graphql` or create separate file:
   - `type Space` — id, name, iconType, iconValue, sortOrder, createdAt
   - `type ProjectSpaceAssignment` — projectId, spaceId

**Verification:** Syntax-check each file by attempting to parse with graphql library or wait until codegen in Session 18.

---

### Session 12: SDL Types — Domain

**Goal:** Write GraphQL type definitions for all domain-specific types.

**Definition of Done:** All domain `.graphql` type files created.

**Tasks:**

1. `[server]` Create `src/server/schema/types/git.graphql` with:
   - `type GitFileStatus` — path, relativePath, status (String!), staged (Boolean!)
   - `type GitBranchInfo` — name, tracking, ahead, behind
   - `type GitDiffStatFile` — path, additions, deletions
   - `type GitStatusChangedEvent` — worktreePath
   - `type GitBranchChangedEvent` — worktreePath
2. `[server]` Create `src/server/schema/types/opencode.graphql` with:
   - `type OpenCodeStreamEvent` — type, sessionId, data (JSON!), childSessionId, statusPayload
   - `type SessionStatusPayload` — type, attempt, message, next
   - `type PermissionRequest` — id, sessionID, permission, patterns, metadata (JSON), always, tool
   - `type OpenCodeCommand` — name, description, template, agent, model, source, subtask, hints
   - `scalar JSON`
3. `[server]` Create `src/server/schema/types/file-tree.graphql` with:
   - `type FileTreeNode` — name, path, relativePath, isDirectory, isSymlink, extension, children (recursive)
   - `type FlatFile` — name, path, relativePath, extension
   - `type FileTreeChangeEvent` — worktreePath, eventType, changedPath, relativePath
4. `[server]` Create `src/server/schema/types/script.graphql` with:
   - `type ScriptOutputEvent` — type, command, data, exitCode
5. `[server]` Create `src/server/schema/types/terminal.graphql` with:
   - `type TerminalDataEvent` — worktreeId, data
   - `type TerminalExitEvent` — worktreeId, code
6. `[server]` Create `src/server/schema/types/settings.graphql` with:
   - `type SettingEntry` — key, value
   - `type DetectedApp` — id, name, command, available
7. `[server]` Create `src/server/schema/types/system.graphql` with:
   - `type ServerStatus` — uptime, connections, requestCount, locked, version
   - `type AppPaths` — userData, home, logs
   - `type AgentSdkDetection` — opencode (Boolean!), claude (Boolean!)

---

### Session 13: SDL Types — Inputs

**Goal:** Define all GraphQL input types used by mutations and queries.

**Definition of Done:** All ~28 input types defined in appropriate `.graphql` files.

**Tasks:**

1. `[server]` Add to `project.graphql`:
   - `input CreateProjectInput` — name!, path!, description, tags
   - `input UpdateProjectInput` — name, description, tags, language, customIcon, setupScript, runScript, archiveScript, autoAssignPort, lastAccessedAt
2. `[server]` Add worktree inputs:
   - `input CreateWorktreeInput` — projectId!, projectPath!, projectName!
   - `input DeleteWorktreeInput` — worktreeId!, worktreePath!, branchName!, projectPath!, archive!
   - `input DuplicateWorktreeInput` — projectId!, projectPath!, projectName!, sourceBranch!, sourceWorktreePath!
   - `input RenameBranchInput` — worktreeId!, worktreePath!, oldBranch!, newBranch!
   - `input CreateFromBranchInput` — projectId!, projectPath!, projectName!, branchName!
   - `input UpdateWorktreeInput` — name, status, lastMessageAt, lastAccessedAt
   - `input UpdateWorktreeModelInput` — worktreeId!, modelProviderId!, modelId!, modelVariant
3. `[server]` Add session inputs:
   - `input CreateSessionInput` — worktreeId, projectId!, connectionId, name, opencodeSessionId, agentSdk, modelProviderId, modelId, modelVariant
   - `input UpdateSessionInput` — name, status, opencodeSessionId, agentSdk, mode, modelProviderId, modelId, modelVariant, updatedAt, completedAt
   - `input SessionSearchInput` — keyword, projectId, worktreeId, dateFrom, dateTo, includeArchived
4. `[server]` Add space inputs:
   - `input CreateSpaceInput` — name!, iconType, iconValue
   - `input UpdateSpaceInput` — name, iconType, iconValue, sortOrder
5. `[server]` Add opencode inputs:
   - `input OpenCodeReconnectInput` — worktreePath!, opencodeSessionId!, hiveSessionId!
   - `input OpenCodePromptInput` — worktreePath!, opencodeSessionId!, message, parts ([MessagePartInput]), model (ModelInput)
   - `input MessagePartInput` — type!, text, mime, url, filename
   - `input ModelInput` — providerID!, modelID!, variant
   - `input SetModelInput` — providerID!, modelID!, variant, agentSdk
   - `input OpenCodeCommandInput` — worktreePath!, opencodeSessionId!, command!, args!, model (ModelInput)
   - `input RenameSessionInput` — opencodeSessionId!, title!, worktreePath
   - `input ForkSessionInput` — worktreePath!, opencodeSessionId!, messageId
   - `input QuestionReplyInput` — requestId!, answers!, worktreePath
   - `input PlanApproveInput` — worktreePath!, hiveSessionId!, requestId
   - `input PlanRejectInput` — worktreePath!, hiveSessionId!, feedback!, requestId
   - `input PermissionReplyInput` — requestId!, reply! (String: 'once'|'always'|'reject'), worktreePath, message
6. `[server]` Add git inputs:
   - `input GitDiffInput` — worktreePath!, filePath!, staged!, isUntracked!, contextLines
   - `input GitPushInput` — worktreePath!, remote, branch, force
   - `input GitPullInput` — worktreePath!, remote, branch, rebase
7. `[server]` Add script input:
   - `input ScriptRunInput` — commands!, cwd!, worktreeId!

---

### Session 14: SDL Types — Results

**Goal:** Define all result wrapper types used by resolvers.

**Definition of Done:** All result types defined, covering success/error patterns.

**Tasks:**

1. `[server]` Define common result types:
   - `type SuccessResult` — success (Boolean!), error (String)
   - `type WorktreeCreateResult` — success (Boolean!), worktree (Worktree), error (String)
2. `[server]` Define opencode result types:
   - `type OpenCodeConnectResult` — success!, sessionId, error
   - `type OpenCodeReconnectResult` — success!, sessionStatus, revertMessageID, error
   - `type OpenCodeMessagesResult` — success!, messages (JSON), error
   - `type OpenCodeModelsResult` — success!, providers (JSON), error
   - `type OpenCodeModelInfoResult` — success!, model (JSON), error
   - `type OpenCodeSessionInfoResult` — success!, revertMessageID, revertDiff, error
   - `type OpenCodeUndoResult` — success!, revertMessageID, restoredPrompt, revertDiff, error
   - `type OpenCodeRedoResult` — success!, revertMessageID, error
   - `type OpenCodeCommandsResult` — success!, commands ([OpenCodeCommand!]!), error
   - `type OpenCodeCapabilitiesResult` — success!, capabilities (JSON), error
   - `type OpenCodePermissionListResult` — success!, permissions ([PermissionRequest!]!), error
   - `type OpenCodeForkResult` — success!, sessionId, error
3. `[server]` Define git result types:
   - `type GitFileStatusesResult` — success!, files ([GitFileStatus!]), error
   - `type GitDiffResult` — success!, diff, fileName, error
   - `type GitDiffStatResult` — success!, files ([GitDiffStatFile!]), error
   - `type GitFileContentResult` — success!, content, error
   - `type GitRefContentResult` — success!, content, error
   - `type GitBranchInfoResult` — success!, branch (GitBranchInfo), error
   - `type GitBranchesResult` — success!, branches, currentBranch, error
   - `type GitBranchesWithStatusResult` — success!, branches (JSON), error
   - `type GitIsMergedResult` — success!, isMerged (Boolean!)
   - `type GitRemoteUrlResult` — success!, url, remote, error
   - `type GitPRListResult` — success!, prs (JSON), error
   - `type GitCommitResult` — success!, commitHash, error
   - `type GitMergeResult` — success!, error, conflicts
4. `[server]` Define remaining result types:
   - `type FileTreeScanResult` — success!, tree ([FileTreeNode!]), error
   - `type FileTreeScanFlatResult` — success!, files ([FlatFile!]), error
   - `type FileTreeChildrenResult` — success!, children ([FileTreeNode!]), error
   - `type FileReadResult` — success!, content, error
   - `type ProjectValidateResult` — success!, path, name, error
   - `type TerminalCreateResult` — success!, cols, rows, error
   - `type ScriptRunResult` — success!, pid, error
   - `type ScriptArchiveResult` — success!, output, error
   - `type ConnectionCreateResult` — success!, connection (ConnectionWithMembers), error
   - `type ConnectionAddMemberResult` — success!, member (JSON), error
   - `type ConnectionRemoveMemberResult` — success!, connectionDeleted, error
   - `type WorktreeBranchRenamedEvent` — worktreeId!, newBranch!

---

### Session 15: SDL Root — Query

**Goal:** Write the complete Query type in the root schema file.

**Definition of Done:** `schema.graphql` contains all ~55 Query fields exactly matching the PRD.

**Tasks:**

1. `[server]` Create `src/server/schema/schema.graphql` with `type Query` containing ALL fields listed in PRD Section 2.3 Query type. Group by domain with comments:
   - Projects (3): projects, project, projectByPath
   - Worktrees (5): worktree, worktreesByProject, activeWorktreesByProject, worktreeExists, worktreeHasCommits
   - Sessions (9): session, sessionsByWorktree, activeSessionsByWorktree, sessionsByProject, sessionsByConnection, activeSessionsByConnection, searchSessions, sessionDraft
   - Spaces (3): spaces, spaceProjectIds, allSpaceAssignments
   - Settings (2): setting, allSettings
   - AI Operations (7): opencodeMessages, opencodeModels, opencodeModelInfo, opencodeSessionInfo, opencodeCommands, opencodeCapabilities, opencodePermissionList
   - Git (12): gitFileStatuses, gitDiff, gitDiffStat, gitFileContent, gitRefContent, gitBranchInfo, gitBranches, gitBranchExists, gitBranchesWithStatus, gitIsBranchMerged, gitRemoteUrl, gitListPRs
   - File Tree (3): fileTreeScan, fileTreeScanFlat, fileTreeLoadChildren
   - File (2): fileRead, fileReadPrompt
   - Connection (2): connections, connection
   - Project Ops (5): projectValidate, projectIsGitRepository, projectDetectLanguage, projectLanguageIcons, projectIconPath
   - Settings Ops (2): detectedEditors, detectedTerminals
   - System (4): systemLogDir, systemAppVersion, systemAppPaths, systemDetectAgentSdks, systemServerStatus
   - Script (1): scriptPort
   - DB Utility (1): dbSchemaVersion

---

### Session 16: SDL Root — Mutation

**Goal:** Write the complete Mutation type.

**Definition of Done:** All ~75 Mutation fields defined matching the PRD.

**Tasks:**

1. `[server]` Add `type Mutation` to `schema.graphql` containing ALL fields listed in PRD Section 2.3 Mutation type. Group by domain:
   - Projects (5): createProject, updateProject, deleteProject, touchProject, reorderProjects
   - Worktrees (11): createWorktree, deleteWorktree, syncWorktrees, duplicateWorktree, renameWorktreeBranch, createWorktreeFromBranch, updateWorktree, archiveWorktree, touchWorktree, appendWorktreeSessionTitle, updateWorktreeModel
   - Sessions (4): createSession, updateSession, deleteSession, updateSessionDraft
   - Spaces (6): createSpace, updateSpace, deleteSpace, assignProjectToSpace, removeProjectFromSpace, reorderSpaces
   - Settings (2): setSetting, deleteSetting
   - AI Operations (16): opencodeConnect, opencodeReconnect, opencodeDisconnect, opencodePrompt, opencodeAbort, opencodeSetModel, opencodeUndo, opencodeRedo, opencodeCommand, opencodeRenameSession, opencodeFork, opencodeQuestionReply, opencodeQuestionReject, opencodePlanApprove, opencodePlanReject, opencodePermissionReply
   - Git (19): gitStageFile, gitUnstageFile, gitStageAll, gitUnstageAll, gitStageHunk, gitUnstageHunk, gitRevertHunk, gitDiscardChanges, gitAddToGitignore, gitCommit, gitPush, gitPull, gitMerge, gitDeleteBranch, gitPrMerge, gitWatchWorktree, gitUnwatchWorktree, gitWatchBranch, gitUnwatchBranch
   - File Tree (2): fileTreeWatch, fileTreeUnwatch
   - File (1): fileWrite
   - Script (4): scriptRunSetup, scriptRunProject, scriptKill, scriptRunArchive
   - Terminal (4): terminalCreate, terminalWrite, terminalResize, terminalDestroy
   - Connection (6): createConnection, deleteConnection, renameConnection, addConnectionMember, removeConnectionMember, removeWorktreeFromAllConnections
   - Project Ops (3): projectInitRepository, projectUploadIcon, projectRemoveIcon
   - Logging (2): createResponseLog, appendResponseLog
   - System (2): systemKillSwitch, systemRegisterPushToken

---

### Session 17: SDL Root — Subscription

**Goal:** Write the complete Subscription type.

**Definition of Done:** All 8 Subscription fields defined.

**Tasks:**

1. `[server]` Add `type Subscription` to `schema.graphql`:
   - `opencodeStream(sessionIds: [String!]): OpenCodeStreamEvent!`
   - `gitStatusChanged(worktreePath: String): GitStatusChangedEvent!`
   - `gitBranchChanged(worktreePath: String): GitBranchChangedEvent!`
   - `fileTreeChange(worktreePath: String): FileTreeChangeEvent!`
   - `terminalData(worktreeId: ID!): TerminalDataEvent!`
   - `terminalExit(worktreeId: ID!): TerminalExitEvent!`
   - `scriptOutput(worktreeId: ID!, channel: String!): ScriptOutputEvent!`
   - `worktreeBranchRenamed: WorktreeBranchRenamedEvent!`

---

### Session 18: Codegen Setup

**Goal:** Configure graphql-codegen to generate TypeScript resolver types from the SDL.

**Definition of Done:** `pnpm codegen` generates `src/server/__generated__/resolvers-types.ts`, types importable.

**Tasks:**

1. `[server]` Create `src/shared/codegen.ts` with CodegenConfig pointing to `src/server/schema/**/*.graphql`, generating to `src/server/__generated__/resolvers-types.ts` using plugins `['typescript', 'typescript-resolvers']` with contextType pointing to `../context#GraphQLContext`.
2. `[server]` Add `"codegen": "graphql-codegen --config src/shared/codegen.ts"` to package.json scripts.
3. `[server]` Run `pnpm codegen` — verify it generates the resolvers-types.ts file with no errors.
4. `[server]` Verify the generated types compile: `pnpm build`
5. `[server]` Run `pnpm test` — zero regressions.

**Verification:**
```bash
pnpm codegen && pnpm build && pnpm test
```

---

## Phase 3 — Server Core

Sessions 19-31 build the GraphQL server infrastructure. Each session is detailed in the PRD. Key points per session:

---

### Session 19: GraphQL Context

**Goal:** Create the context interface that carries all services to resolvers.

**Definition of Done:** `GraphQLContext` type defined, importable.

**Tasks:**

1. `[server]` Create `src/server/context.ts` exporting `GraphQLContext` interface with fields: `db` (DatabaseService), `sdkManager` (AgentSdkManager), `eventBus` (EventBus), `clientIp` (string), `authenticated` (boolean).
2. `[server]` Verify it compiles: `pnpm build`

---

### Session 20: Server Entry Point

**Goal:** Create the `startGraphQLServer` function that creates the yoga instance + HTTPS server + WebSocket server.

**Definition of Done:** Function exists, can be called with options (port, cert, key, context), starts HTTPS+WS server.

**Tasks:**

1. `[server]` Create `src/server/index.ts` with `startGraphQLServer(opts)` function:
   - Creates `yoga` instance via `createYoga()` with schema from SDL files and resolver merger
   - Creates HTTPS server using `node:https` with TLS cert/key
   - Creates `WebSocketServer` on the same HTTPS server at yoga's endpoint path
   - Uses `graphql-ws`'s `useServer()` to wire WS subscriptions
   - Returns a handle with `close()` method for graceful shutdown
2. `[server]` Create `src/server/resolvers/index.ts` — empty resolver merger (returns `{}` initially, will merge all domain resolvers incrementally)
3. `[server]` Verify it compiles: `pnpm build`

---

### Session 21: Headless Bootstrap

**Goal:** Create the bootstrap sequence for headless mode.

**Definition of Done:** `headlessBootstrap()` function that initializes services and starts server.

**Tasks:**

1. `[server]` Create `src/server/headless-bootstrap.ts` with `headlessBootstrap(opts)` function:
   - Loads config from `~/.hive/headless.json`
   - Initializes database (same `getDatabase()` as GUI mode)
   - Creates AgentSdkManager (same pattern as `src/main/index.ts` lines 372-409)
   - Gets or creates EventBus singleton
   - Generates TLS certs if not existing
   - Generates API key if not existing (stores hash in settings)
   - Calls `startGraphQLServer()` with assembled options
   - Logs startup info (port, cert fingerprint)
2. `[server]` Verify it compiles: `pnpm build`

---

### Session 22: Auth — API Key Generation

**Goal:** Implement key generation, hashing, and storage utilities.

**Definition of Done:** Can generate `hive_` prefixed keys, hash them, store hash in DB.

**Tasks:**

1. `[server]` Create key utilities in `src/server/plugins/auth.ts`:
   - `generateApiKey()` → `'hive_' + crypto.randomBytes(32).toString('base64url')` (~43 char key)
   - `hashApiKey(key: string)` → `crypto.createHash('sha256').update(key).digest('hex')`
   - `verifyApiKey(key: string, storedHash: string)` → timing-safe comparison using `crypto.timingSafeEqual` on the SHA-256 hashes
2. `[server]` Write tests in `test/server/auth-key.test.ts`:
   - `generateApiKey()` returns string starting with `hive_`
   - `generateApiKey()` returns different keys each call
   - `hashApiKey()` returns consistent hash for same input
   - `verifyApiKey()` returns true for correct key
   - `verifyApiKey()` returns false for wrong key
   - `verifyApiKey()` is constant-time (doesn't short-circuit)
3. `[server]` Run tests: `pnpm vitest run test/server/auth-key.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/auth-key.test.ts
```

---

### Session 23: Auth — Verification Plugin

**Goal:** Create yoga plugin that verifies Bearer token on every request.

**Definition of Done:** Plugin rejects unauthenticated requests with 401, accepts valid Bearer token.

**Tasks:**

1. `[server]` Implement `createAuthPlugin(db)` in `src/server/plugins/auth.ts`:
   - Reads `Authorization: Bearer hive_...` header from each request
   - Loads `headless_api_key_hash` from settings table
   - Calls `verifyApiKey()` to compare
   - If invalid: returns 401 Unauthorized GraphQL error
   - If valid: sets `context.authenticated = true`
2. `[server]` Write tests in `test/server/auth-plugin.test.ts`:
   - Request with valid Bearer token → 200 OK
   - Request with no Authorization header → 401
   - Request with invalid Bearer token → 401
   - Request with malformed header (no "Bearer" prefix) → 401
3. `[server]` Run tests: `pnpm vitest run test/server/auth-plugin.test.ts`

---

### Session 24: Auth — Brute Force Protection

**Goal:** Block IPs after 5 failed auth attempts within 60 seconds.

**Definition of Done:** 5 failures per IP per minute → 300s block. Authenticated users NEVER rate-limited.

**Tasks:**

1. `[server]` Implement brute force tracker in `src/server/plugins/auth.ts`:
   - In-memory `Map<string, { attempts: number, firstAttempt: number, blockedUntil: number }>` keyed by IP
   - On failed auth: increment attempts. If ≥5 within 60s → set blockedUntil = now + 300s
   - On blocked IP requesting → return 429 Too Many Requests before even checking key
   - On successful auth → do NOT track or rate-limit at all
   - Cleanup stale entries every 60s
2. `[server]` Write tests in `test/server/auth-brute-force.test.ts`:
   - 4 failed attempts → still allowed
   - 5th failed attempt → blocked
   - Blocked IP → 429 response
   - After 300s → unblocked
   - Successful auth from same IP → never blocked
   - Different IPs tracked independently
3. `[server]` Run tests: `pnpm vitest run test/server/auth-brute-force.test.ts`

---

### Session 25: Auth — WebSocket Auth

**Goal:** Verify API key during WebSocket handshake via connectionParams.

**Definition of Done:** Invalid key → connection rejected before upgrade. Valid key → connection accepted.

**Tasks:**

1. `[server]` In `src/server/index.ts`, configure `graphql-ws`'s `useServer` `onConnect` callback:
   - Read `connectionParams.apiKey`
   - Load hash from DB, verify
   - If invalid: return `false` (rejects connection)
   - If valid: set context.authenticated = true
2. `[server]` Write test in `test/server/auth-ws.test.ts`:
   - WS connect with valid apiKey in connectionParams → connected
   - WS connect with invalid apiKey → connection rejected
   - WS connect with no connectionParams → connection rejected
3. `[server]` Run tests: `pnpm vitest run test/server/auth-ws.test.ts`

---

### Session 26: Path Guard Plugin

**Goal:** Prevent path traversal attacks by validating all file/directory path arguments.

**Definition of Done:** Paths outside allowed roots rejected, `../` traversals blocked.

**Tasks:**

1. `[server]` Create `src/server/plugins/path-guard.ts`:
   - `PathGuard` class with `allowedRoots: string[]` (project paths, worktree paths, ~/.hive/)
   - `validatePath(inputPath: string)` → resolves path, checks it's under an allowed root
   - Rejects paths containing `..` after resolution, symlink escapes
   - Yoga plugin that inspects GraphQL variables for known path-like argument names (worktreePath, filePath, dirPath, cwd, path) and validates each
2. `[server]` Write tests in `test/server/path-guard.test.ts`:
   - Valid path under allowed root → accepted
   - Path with `../` escaping root → rejected
   - Absolute path outside all roots → rejected
   - Path to ~/.hive/ → accepted
   - Empty path → rejected
3. `[server]` Run tests: `pnpm vitest run test/server/path-guard.test.ts`

---

### Session 27: TLS Certificate Generation

**Goal:** Auto-generate self-signed ECDSA P-256 TLS certificates on first headless run.

**Definition of Done:** Certs generated to `~/.hive/tls/`, fingerprint stored in DB.

**Tasks:**

1. `[server]` Create TLS utilities in `src/server/config.ts` or `src/server/tls.ts`:
   - `generateTlsCerts(outputDir: string)` → uses `crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })` + self-signed X.509 cert (10-year validity)
   - Writes `server.crt` and `server.key` to `~/.hive/tls/`
   - `getCertFingerprint(certPath: string)` → SHA-256 fingerprint of DER-encoded cert
   - Stores fingerprint in settings table as `headless_cert_fingerprint`
2. `[server]` Write tests in `test/server/tls.test.ts`:
   - Certs generated to temp dir
   - Fingerprint is 64 hex chars
   - Existing certs NOT overwritten (idempotent)
3. `[server]` Run tests: `pnpm vitest run test/server/tls.test.ts`

---

### Session 28: Config Loader

**Goal:** Load `~/.hive/headless.json` with sensible defaults.

**Definition of Done:** Config merges user settings with defaults, handles missing file.

**Tasks:**

1. `[server]` Create `src/server/config.ts`:
   - `loadHeadlessConfig()` → reads `~/.hive/headless.json`, merges with defaults
   - Defaults: `{ port: 8443, bindAddress: '0.0.0.0', tls: { certPath: '~/.hive/tls/server.crt', keyPath: '~/.hive/tls/server.key' }, security: { bruteForceMaxAttempts: 5, bruteForceWindowSec: 60, bruteForceBlockSec: 300, inactivityTimeoutMin: 30, allowedIps: [] } }`
   - If file doesn't exist → returns defaults silently
   - If file has invalid JSON → logs warning, returns defaults
2. `[server]` Write tests in `test/server/config.test.ts`:
   - Missing file → returns defaults
   - Partial config → merged with defaults
   - Invalid JSON → returns defaults with warning
   - Custom port → overrides default
3. `[server]` Run tests: `pnpm vitest run test/server/config.test.ts`

---

### Session 29: Headless CLI — Flag Parsing

**Goal:** Parse `--headless` and related flags from `process.argv` in `src/main/index.ts`.

**Definition of Done:** CLI flags parsed, available to startup logic, desktop mode completely unaffected.

**Tasks:**

1. `[server]` Modify `src/main/index.ts` — add flag parsing after existing `cliArgs` (line 43):
   ```
   const isHeadless = cliArgs.includes('--headless')
   const headlessPort = cliArgs.includes('--port') ? parseInt(cliArgs[cliArgs.indexOf('--port') + 1]) : undefined
   const headlessBind = cliArgs.includes('--bind') ? cliArgs[cliArgs.indexOf('--bind') + 1] : undefined
   const isRotateKey = cliArgs.includes('--rotate-key')
   const isRegenCerts = cliArgs.includes('--regen-certs')
   const isShowStatus = cliArgs.includes('--show-status')
   const isKill = cliArgs.includes('--kill')
   const isUnlock = cliArgs.includes('--unlock')
   ```
2. `[server]` Verify `pnpm build` succeeds. Desktop mode is completely unaffected (all new code is behind `isHeadless` checks not yet wired).

---

### Session 30: Headless CLI — Startup Branch

**Goal:** Add the `--headless` branch to `app.whenReady()` that starts GraphQL server instead of creating a window.

**Definition of Done:** `hive --headless` starts server, `hive` (no flag) starts desktop as before.

**Tasks:**

1. `[server]` Modify `src/main/index.ts` — in `app.whenReady()` (line 315), add headless branch:
   - BEFORE `createWindow()` (line 356), add:
     ```
     if (isHeadless) {
       log.info('Starting in headless mode')
       const { headlessBootstrap } = await import('../server/headless-bootstrap')
       await headlessBootstrap({ port: headlessPort, bind: headlessBind })
       return // Skip all window/IPC/menu setup
     }
     ```
   - The `return` ensures NONE of the window/IPC/menu code runs in headless mode.
2. `[server]` Verify `pnpm build` succeeds.
3. `[server]` Verify `pnpm test` — all existing tests still pass.

**Verification:**
```bash
pnpm build && pnpm test
```

---

### Session 31: Headless CLI — Management Commands

**Goal:** Implement `--rotate-key`, `--regen-certs`, `--show-status`, `--kill`, `--unlock`.

**Definition of Done:** Each CLI command works as one-shot operation (run and exit).

**Tasks:**

1. `[server]` In `src/main/index.ts` headless branch, BEFORE calling `headlessBootstrap()`, handle one-shot commands:
   - `--rotate-key`: generate new key, store hash, display new key + QR code, exit
   - `--regen-certs`: delete old certs, regenerate, update fingerprint, exit
   - `--show-status`: read `~/.hive/hive-headless.status.json`, print to stdout, exit
   - `--kill`: read PID file, send SIGTERM to running process, exit
   - `--unlock`: clear auto-lock state (via settings table or signal), exit
2. `[server]` Each command calls `app.quit()` after completing (they don't start the server).
3. `[server]` Verify `pnpm build` succeeds.

---

## Phases 4-7 — Resolvers

Each resolver session follows the same pattern:

1. Create the resolver file in the appropriate directory
2. Import the generated types from codegen
3. Implement each resolver function calling the corresponding service/database method from the GraphQL context
4. Register the resolver in `src/server/resolvers/index.ts`
5. Write integration tests using `yoga.fetch()`

Sessions 32-76 are listed in the Session Map above. Each session targets a specific domain slice. The key principle: **every resolver is a thin wrapper over the same service methods that IPC handlers already use.**

For example, the `projects` query resolver looks like:
```typescript
projects: async (_parent, _args, ctx) => {
  return ctx.db.project.getAll()
}
```

The OpenCode resolvers (Sessions 59-72) are the most complex because they must replicate the SDK dispatch logic from `src/main/ipc/opencode-handlers.ts` — checking `agent_sdk` on the session and routing `claude-code` sessions to `sdkManager.getImplementer('claude-code')`.

---

## Phase 8 — Subscriptions

Sessions 77-87 implement all 8 GraphQL subscriptions. Each follows the same async generator pattern:

```typescript
subscribe: async function* (_parent, args, ctx) {
  const queue = []
  let resolve = null

  const listener = (event) => {
    // Optional filtering by args
    queue.push(event)
    resolve?.()
  }

  ctx.eventBus.on('channel', listener)
  try {
    while (true) {
      if (queue.length === 0) await new Promise(r => { resolve = r })
      while (queue.length > 0) yield { fieldName: queue.shift() }
    }
  } finally {
    ctx.eventBus.off('channel', listener)
  }
}
```

The `opencodeStream` subscription (Sessions 77-79) has extra complexity:
- **Session filtering** (Session 78): Only yield events whose `sessionId` matches the `sessionIds` argument
- **50ms batching** (Session 79): Accumulate events for 50ms before yielding to reduce WebSocket frame overhead

---

## Phase 9 — Security & Operations

Sessions 88-99 implement the remaining security and operational features:
- Audit logging (88-89)
- Auto-lock (90-92)
- Kill switch (93)
- QR code pairing (94)
- Key rotation + cert regen (95-96)
- PID + status files (97-98)
- Full security test suite (99)

---

## Phase 10 — Server Testing & Regression

Sessions 100-105 ensure comprehensive test coverage and zero regressions.

### Session 100: Integration Test Infrastructure

**Tasks:**

1. `[server]` Create `test/server/helpers/test-server.ts` — helper that creates a yoga instance with mock database and services, uses `yoga.fetch()` for testing
2. `[server]` Create `test/server/helpers/mock-db.ts` — in-memory mock of DatabaseService
3. `[server]` Create `test/server/helpers/mock-sdk.ts` — mock AgentSdkManager

### Session 104: Regression Test Suite

**Tasks:**

1. `[server]` Run `pnpm test` — ALL tests (existing + new) pass
2. `[server]` Run `pnpm lint` — no new lint errors
3. `[server]` Run `pnpm build` — production build succeeds

### Session 105: Desktop Smoke Test

**Tasks:**

1. `[server]` Start `pnpm dev` — desktop app opens normally
2. `[server]` Manually verify: create project, create worktree, start AI session, send prompt, see streaming response, view files, git status, commit — all work identically to before

---

## Phases 11-16 — React Native Mobile App (Separate Repo)

These sessions are documented here for completeness but will be implemented in a separate repository.

---

### Session 106: App Scaffolding

**Goal:** Initialize the React Native project.

**Tasks:**

1. `[app]` Initialize React Native project (Expo or bare workflow)
2. `[app]` Set up TypeScript configuration
3. `[app]` Set up ESLint + Prettier matching Hive conventions (no semicolons, single quotes)
4. `[app]` Create folder structure: `src/screens/`, `src/components/`, `src/stores/`, `src/hooks/`, `src/lib/`, `src/graphql/`
5. `[app]` Verify project builds and runs on iOS simulator

---

### Session 107: NativeWind Setup

**Tasks:**

1. `[app]` Install NativeWind: `pnpm add nativewind` + `pnpm add -D tailwindcss`
2. `[app]` Configure `tailwind.config.js` with content paths
3. `[app]` Configure babel plugin for NativeWind
4. `[app]` Create test component with Tailwind classes, verify styling renders

---

### Session 108: React Navigation Setup

**Tasks:**

1. `[app]` Install: `@react-navigation/native`, `@react-navigation/bottom-tabs`, `@react-navigation/native-stack`
2. `[app]` Create bottom tab navigator with 4 tabs: Projects, Session, Files, More
3. `[app]` Create stack navigators for each tab
4. `[app]` Verify navigation works between screens

---

### Session 109: Apollo Client Setup

**Tasks:**

1. `[app]` Install: `@apollo/client`, `graphql`, `graphql-ws`
2. `[app]` Create `src/lib/apollo.ts` with split link (HttpLink for queries/mutations, GraphQLWsLink for subscriptions)
3. `[app]` Configure auth headers (Bearer token from secure storage)
4. `[app]` Wrap app in `ApolloProvider`
5. `[app]` Test with a simple query (e.g., `{ systemAppVersion }`)

---

### Session 110: Codegen Setup

**Tasks:**

1. `[app]` Install: `@graphql-codegen/cli`, `@graphql-codegen/typescript`, `@graphql-codegen/typescript-react-apollo`
2. `[app]` Create codegen config pointing to SDL schema files (copied from server or fetched via introspection)
3. `[app]` Run codegen — generates typed hooks (`useProjectsQuery`, `useCreateProjectMutation`, etc.)
4. `[app]` Verify generated hooks are importable

---

### Session 111: Transport Abstraction

**Tasks:**

1. `[app]` Create `src/lib/transport.ts` — `HiveTransport` interface mirroring `window.*` namespaces
2. `[app]` Create `src/lib/graphql-transport.ts` — implementation wrapping Apollo Client queries/mutations
3. `[app]` Create transport provider context

---

### Session 112: Connection Manager Store

**Tasks:**

1. `[app]` Create `src/stores/useConnectionManagerStore.ts` — server URL, API key, connection state (disconnected/connecting/connected/reconnecting), TLS cert fingerprint
2. `[app]` Implement `react-native-keychain` storage for credentials
3. `[app]` Implement reconnection logic (exponential backoff, 1s→30s cap, max 10 retries)

---

### Session 113: Pairing Screen

**Tasks:**

1. `[app]` Create `src/screens/PairingScreen.tsx`:
   - QR code scanner button (expo-camera)
   - Manual entry: TextInput for server URL + TextInput for API key (secureTextEntry)
   - "Test Connection" button
   - Connection status indicator
2. `[app]` Parse QR payload: `{ host, port, key, certFingerprint }`
3. `[app]` Store credentials in Keychain on successful connection

---

### Sessions 114-120: Shared Logic Port

Port Zustand stores from the Electron renderer to the React Native app. Each store's `window.*` calls are replaced with GraphQL transport calls. The business logic (state management, derived data, actions) remains identical.

Key store: `useSessionStore` (~1200 lines, Session 116) is the most complex — manages session tabs, mode, model selection, streaming state, and integrates with permission/question/context stores.

Session 120 extracts `handleStreamEvent()` from `useOpenCodeGlobalListener.ts` into a shared pure function that both desktop (via IPC events) and mobile (via GraphQL subscriptions) can use.

---

### Sessions 121-130: Mobile Core Screens

Build the essential screens needed for basic remote control:
- Project/worktree browsing (121-122)
- AI session view with streaming (123-126) — the most complex mobile screen
- Permission/question/plan modals (127-129)
- Model selector (130)

---

### Sessions 131-139: Mobile Feature Screens

Full feature parity screens:
- File browsing and editing (131-133)
- Git operations (134-136)
- Simplified terminal (137)
- Settings and history (138-139)

---

### Sessions 140-144: Mobile Polish

Production readiness:
- Push notifications with deep linking (140-142)
- Offline handling and reconnection (143)
- Performance optimization (144)

---

### Sessions 145-148: Mobile Testing

- Unit tests for shared stores with mock transport (145)
- Component tests with React Native Testing Library (146)
- E2E tests with Detox (147)
- App store preparation (148)

---

## Appendix A: Files Modified in This Repo (Minimal Changes)

| File | Lines Changed | What |
|------|--------------|------|
| `package.json` | ~5 | Add 5 prod deps, 4 dev deps, 1 script |
| `src/main/index.ts` | ~25 | CLI flag parsing + headless startup branch |
| `src/main/services/opencode-service.ts` | ~5 | Import EventBus + emit in sendToRenderer |
| `src/main/services/claude-code-implementer.ts` | ~5 | Import EventBus + emit in sendToRenderer |
| `src/main/services/worktree-watcher.ts` | ~2 | Import EventBus + emit in emitGitStatusChanged |
| `src/main/services/branch-watcher.ts` | ~2 | Import EventBus + emit in emitBranchChanged |
| `src/main/ipc/file-tree-handlers.ts` | ~2 | Import EventBus + emit in debounced send |
| `src/main/ipc/git-file-handlers.ts` | ~2 | Import EventBus + emit after PR merge |
| `src/main/services/script-runner.ts` | ~2 | Import EventBus + emit in sendEvent |
| `src/main/ipc/terminal-handlers.ts` | ~3 | Import EventBus + emit data + exit |

**Total: ~53 lines modified across 10 existing files.**

## Appendix B: Files Created in This Repo

```
src/shared/
  types/index.ts, project.ts, worktree.ts, session.ts, connection.ts,
        settings.ts, git.ts, opencode.ts, file-tree.ts, script.ts,
        terminal.ts, space.ts
  lib/stream-event-handler.ts, transport.ts
  codegen.ts

src/server/
  index.ts, context.ts, event-bus.ts, headless-bootstrap.ts, config.ts, tls.ts
  __generated__/resolvers-types.ts
  schema/
    schema.graphql
    types/project.graphql, opencode.graphql, git.graphql, file-tree.graphql,
          connection.graphql, script.graphql, terminal.graphql,
          settings.graphql, system.graphql
  resolvers/
    index.ts
    query/db.ts, project.ts, worktree.ts, git.ts, opencode.ts,
          file-tree.ts, file.ts, connection.ts, settings.ts, system.ts, script.ts
    mutation/db.ts, project.ts, worktree.ts, git.ts, opencode.ts,
             file.ts, script.ts, terminal.ts, connection.ts, system.ts, logging.ts
    subscription/opencode.ts, git.ts, file-tree.ts, terminal.ts, script.ts, worktree.ts
  plugins/auth.ts, path-guard.ts, audit.ts

test/server/
  event-bus.test.ts, auth-key.test.ts, auth-plugin.test.ts,
  auth-brute-force.test.ts, auth-ws.test.ts, path-guard.test.ts,
  tls.test.ts, config.test.ts
  helpers/test-server.ts, mock-db.ts, mock-sdk.ts
  integration/db.test.ts, operations.test.ts, opencode.test.ts,
              subscriptions.test.ts, security.test.ts
```

## Appendix C: Desktop-Only Operations (NOT exposed via GraphQL)

These ~25 IPC channels are intentionally excluded:
- `dialog:openDirectory` — native file picker (mobile uses manual path entry)
- `shell:showItemInFolder`, `shell:openPath` — desktop shell
- `clipboard:writeText`, `clipboard:readText` — client-side on mobile
- `worktree:openInTerminal`, `worktree:openInEditor` — desktop app launchers
- `connection:openInTerminal`, `connection:openInEditor` — desktop app launchers
- `settings:openWithEditor`, `settings:openWithTerminal` — desktop app launchers
- `system:openInChrome`, `system:openInApp` — desktop app openers
- `system:quitApp` — replaced by kill switch
- `system:isLogMode` — desktop debugging only
- `menu:updateState` — Electron menu
- `shortcut:*` — Electron keyboard events
- `notification:navigate` — Electron notification click
- `app:windowFocused` — Electron window event
- All `terminal:ghostty:*` (12 methods) — native GPU terminal
- All `updater:*` — Electron auto-update (mobile uses app stores)
- `project:pickIcon` — native file picker for icon upload (mobile uses `projectUploadIcon` with base64 data)
