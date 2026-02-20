# PRD: Hive Headless Server Mode + React Native Mobile Client

## Context

Hive is an Electron desktop app for managing git projects, worktrees, and AI coding sessions (OpenCode + Claude Code). The user wants to control Hive remotely from their phone. This requires:

1. A **headless server mode** that exposes all Hive capabilities over the network via **GraphQL** (implemented in this repo)
2. A **React Native mobile app** with full feature parity (separate repo — documented here, built later)
3. **Zero disruption** to the existing desktop app functionality

**Repository structure**: The GraphQL server, EventBus, shared types, and headless mode are all implemented in this Hive Electron repo. The React Native mobile app is a separate project/repository that consumes the GraphQL API. This PRD documents both sides for completeness, but implementation in this repo focuses on the server side.

The desktop app's architecture is already well-suited for this: services (`src/main/services/`) are completely decoupled from Electron UI. The IPC handlers (`src/main/ipc/`) are thin wrappers. We add GraphQL resolvers as a second thin wrapper over the same services.

---

## 1. Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────┐
│  Hive Process (Electron)                            │
│                                                     │
│  ┌──────────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ Services     │  │ EventBus  │  │ GraphQL      │ │
│  │ • Database   │──│ (bridges  │──│ Server       │ │
│  │ • Git        │  │  push     │  │ (graphql-    │ │
│  │ • OpenCode   │  │  events)  │  │  yoga)       │ │
│  │ • ClaudeCode │  │           │  │              │ │
│  │ • Scripts    │  └─────┬─────┘  │ • SDL schema │ │
│  │ • Terminal   │    ┌───┴───┐    │ • Resolvers  │ │
│  │ • FileTree   │    │IPC    │    │ • WS subs    │ │
│  └──────────────┘    │(local)│    │ • Auth       │ │
│                      └───┬───┘    │ • TLS        │ │
│                          │        └──────┬───────┘ │
└──────────────────────────┼───────────────┼─────────┘
                           │               │
                   ┌───────┴───────┐ ┌─────┴─────────┐
                   │ Electron      │ │ React Native   │
                   │ Renderer      │ │ Mobile App     │
                   │ (unchanged)   │ │ (new)          │
                   │               │ │                │
                   │ • Zustand     │ │ • Apollo Client│
                   │ • window.*    │ │ • Zustand      │
                   │   (unchanged) │ │   (shared)     │
                   └───────────────┘ └────────────────┘
```

### Two Startup Modes

**GUI mode** (default, unchanged):
```bash
hive          # Creates BrowserWindow, registers IPC, normal desktop app
```

**Headless mode** (new):
```bash
hive --headless --port 8443    # No window, starts GraphQL server on port
```

Both modes initialize the same services (Database, Git, OpenCode, ClaudeCode, Scripts, Terminal). The difference is:
- GUI mode creates a `BrowserWindow` and registers IPC handlers
- Headless mode starts a GraphQL HTTP+WebSocket server

### Changes to Desktop App

**Renderer (components, stores, hooks, preload)**: ZERO changes.

**Services (~5 files)**: Add one line per push-event site to also emit to EventBus:
```typescript
// opencode-service.ts, git-file-handlers.ts, file-tree-handlers.ts,
// script-handlers.ts, terminal-handlers.ts
this.mainWindow?.webContents.send(channel, data)
this.eventBus?.emit(channel, data)  // ← added
```

**Main entry (`src/main/index.ts`)**: Add headless mode branch (~20 lines).

---

## 2. GraphQL Server Design

### 2.1 Technology Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| GraphQL server | **graphql-yoga** | The Guild maintains core graphql-js; built-in WS subscriptions; `yoga.fetch()` for testing |
| Schema style | **SDL-first** (.graphql files) | Readable, standard, clear separation of schema and resolvers |
| Subscriptions | **graphql-ws** | The standard subscription protocol (built into yoga) |
| Codegen | **graphql-codegen** | Generates TypeScript types from SDL for both server resolvers and RN client |
| TLS | Node.js `https` module | Self-signed certs with certificate pinning |
| Auth | Custom yoga plugin | API key verification via Bearer token |

### 2.2 File Structure

```
src/
  server/                              ← NEW directory
    index.ts                           # Server entry point (createYoga + https)
    context.ts                         # GraphQL context factory (carries services)
    schema/                            # SDL schema files
      schema.graphql                   # Root schema (Query, Mutation, Subscription)
      types/
        project.graphql                # Project, Worktree, Session types
        git.graphql                    # Git types (FileStatus, BranchInfo, Diff)
        opencode.graphql               # AI session types (StreamEvent, Permission, etc.)
        file-tree.graphql              # FileTreeNode, FlatFile
        connection.graphql             # Connection, ConnectionMember
        script.graphql                 # ScriptOutputEvent
        terminal.graphql               # Terminal types
        settings.graphql               # Setting, DetectedApp
        system.graphql                 # ServerStatus, AppPaths
    resolvers/
      index.ts                         # Merge all resolvers
      query/
        db.resolvers.ts                # Database CRUD queries
        project.resolvers.ts           # Project queries
        worktree.resolvers.ts          # Worktree queries
        git.resolvers.ts               # Git queries
        opencode.resolvers.ts          # AI session queries
        file-tree.resolvers.ts         # File tree queries
        file.resolvers.ts              # File read queries
        connection.resolvers.ts        # Connection queries
        settings.resolvers.ts          # Settings queries
        system.resolvers.ts            # System info queries
      mutation/
        db.resolvers.ts                # Database CRUD mutations
        project.resolvers.ts           # Project mutations
        worktree.resolvers.ts          # Worktree mutations
        git.resolvers.ts               # Git mutations (~15)
        opencode.resolvers.ts          # AI session mutations (~15)
        file.resolvers.ts              # File write mutation
        script.resolvers.ts            # Script mutations
        terminal.resolvers.ts          # Terminal mutations
        connection.resolvers.ts        # Connection mutations
        system.resolvers.ts            # Kill switch, push token
      subscription/
        opencode.resolvers.ts          # AI stream subscription
        git.resolvers.ts               # Status/branch change subscriptions
        file-tree.resolvers.ts         # File change subscription
        terminal.resolvers.ts          # Terminal data subscription
        script.resolvers.ts            # Script output subscription
        worktree.resolvers.ts          # Branch renamed subscription
    plugins/
      auth.ts                          # Yoga plugin: API key verification + brute force protection
      path-guard.ts                    # Yoga plugin: path traversal prevention
      audit.ts                         # Yoga plugin: request audit logging
    event-bus.ts                       # Typed EventEmitter bridge
    headless-bootstrap.ts              # Headless mode startup sequence
    config.ts                          # ~/.hive/headless.json loader
  shared/                              ← NEW directory
    types/                             # Extracted from index.d.ts (shared TS types)
      index.ts
      project.ts
      worktree.ts
      session.ts
      git.ts
      opencode.ts
      file-tree.ts
      connection.ts
      script.ts
      terminal.ts
      settings.ts
    lib/                               # Platform-agnostic utilities
      stream-event-handler.ts          # Extracted from useOpenCodeGlobalListener
      transport.ts                     # HiveTransport interface definition
    codegen.ts                         # graphql-codegen config
```

### 2.3 GraphQL Schema Overview

#### Root Schema

```graphql
# schema/schema.graphql

type Query {
  # --- Projects ---
  projects: [Project!]!
  project(id: ID!): Project
  projectByPath(path: String!): Project

  # --- Worktrees ---
  worktree(id: ID!): Worktree
  worktreesByProject(projectId: ID!): [Worktree!]!
  activeWorktreesByProject(projectId: ID!): [Worktree!]!
  worktreeExists(worktreePath: String!): Boolean!
  worktreeHasCommits(projectPath: String!): Boolean!

  # --- Sessions ---
  session(id: ID!): Session
  sessionsByWorktree(worktreeId: ID!): [Session!]!
  activeSessionsByWorktree(worktreeId: ID!): [Session!]!
  sessionsByProject(projectId: ID!): [Session!]!
  sessionsByConnection(connectionId: ID!): [Session!]!
  activeSessionsByConnection(connectionId: ID!): [Session!]!
  searchSessions(input: SessionSearchInput!): [SessionWithWorktree!]!
  sessionDraft(sessionId: ID!): String

  # --- Spaces ---
  spaces: [Space!]!
  spaceProjectIds(spaceId: ID!): [ID!]!
  allSpaceAssignments: [ProjectSpaceAssignment!]!

  # --- Settings ---
  setting(key: String!): String
  allSettings: [SettingEntry!]!

  # --- AI Operations ---
  opencodeMessages(worktreePath: String!, sessionId: String!): OpenCodeMessagesResult!
  opencodeModels(agentSdk: AgentSdk): OpenCodeModelsResult!
  opencodeModelInfo(worktreePath: String!, modelId: String!, agentSdk: AgentSdk): OpenCodeModelInfoResult!
  opencodeSessionInfo(worktreePath: String!, sessionId: String!): OpenCodeSessionInfoResult!
  opencodeCommands(worktreePath: String!, sessionId: String): OpenCodeCommandsResult!
  opencodeCapabilities(sessionId: String): OpenCodeCapabilitiesResult!
  opencodePermissionList(worktreePath: String): OpenCodePermissionListResult!

  # --- Git ---
  gitFileStatuses(worktreePath: String!): GitFileStatusesResult!
  gitDiff(input: GitDiffInput!): GitDiffResult!
  gitDiffStat(worktreePath: String!): GitDiffStatResult!
  gitFileContent(worktreePath: String!, filePath: String!): GitFileContentResult!
  gitRefContent(worktreePath: String!, ref: String!, filePath: String!): GitRefContentResult!
  gitBranchInfo(worktreePath: String!): GitBranchInfoResult!
  gitBranches(projectPath: String!): GitBranchesResult!
  gitBranchExists(projectPath: String!, branchName: String!): Boolean!
  gitBranchesWithStatus(projectPath: String!): GitBranchesWithStatusResult!
  gitIsBranchMerged(worktreePath: String!, branch: String!): GitIsMergedResult!
  gitRemoteUrl(worktreePath: String!, remote: String): GitRemoteUrlResult!
  gitListPRs(projectPath: String!): GitPRListResult!

  # --- File Tree ---
  fileTreeScan(dirPath: String!): FileTreeScanResult!
  fileTreeScanFlat(dirPath: String!): FileTreeScanFlatResult!
  fileTreeLoadChildren(dirPath: String!, rootPath: String!): FileTreeChildrenResult!

  # --- File ---
  fileRead(filePath: String!): FileReadResult!
  fileReadPrompt(promptName: String!): FileReadResult!

  # --- Connection ---
  connections: [ConnectionWithMembers!]!
  connection(connectionId: ID!): ConnectionWithMembers

  # --- Project Operations ---
  projectValidate(path: String!): ProjectValidateResult!
  projectIsGitRepository(path: String!): Boolean!
  projectDetectLanguage(projectPath: String!): String
  projectLanguageIcons: JSON!
  projectIconPath(filename: String!): String

  # --- Settings Operations ---
  detectedEditors: [DetectedApp!]!
  detectedTerminals: [DetectedApp!]!

  # --- System ---
  systemLogDir: String!
  systemAppVersion: String!
  systemAppPaths: AppPaths!
  systemDetectAgentSdks: AgentSdkDetection!
  systemServerStatus: ServerStatus!

  # --- Script ---
  scriptPort(cwd: String!): Int

  # --- DB Utility ---
  dbSchemaVersion: Int!
}

type Mutation {
  # --- Projects ---
  createProject(input: CreateProjectInput!): Project!
  updateProject(id: ID!, input: UpdateProjectInput!): Project
  deleteProject(id: ID!): Boolean!
  touchProject(id: ID!): Boolean!
  reorderProjects(orderedIds: [ID!]!): Boolean!

  # --- Worktrees ---
  createWorktree(input: CreateWorktreeInput!): WorktreeCreateResult!
  deleteWorktree(input: DeleteWorktreeInput!): SuccessResult!
  syncWorktrees(projectId: ID!, projectPath: String!): SuccessResult!
  duplicateWorktree(input: DuplicateWorktreeInput!): WorktreeCreateResult!
  renameWorktreeBranch(input: RenameBranchInput!): SuccessResult!
  createWorktreeFromBranch(input: CreateFromBranchInput!): WorktreeCreateResult!
  updateWorktree(id: ID!, input: UpdateWorktreeInput!): Worktree
  archiveWorktree(id: ID!): Worktree
  touchWorktree(id: ID!): Boolean!
  appendWorktreeSessionTitle(worktreeId: ID!, title: String!): SuccessResult!
  updateWorktreeModel(input: UpdateWorktreeModelInput!): SuccessResult!

  # --- Sessions ---
  createSession(input: CreateSessionInput!): Session!
  updateSession(id: ID!, input: UpdateSessionInput!): Session
  deleteSession(id: ID!): Boolean!
  updateSessionDraft(sessionId: ID!, draft: String): Boolean!

  # --- Spaces ---
  createSpace(input: CreateSpaceInput!): Space!
  updateSpace(id: ID!, input: UpdateSpaceInput!): Space
  deleteSpace(id: ID!): Boolean!
  assignProjectToSpace(projectId: ID!, spaceId: ID!): Boolean!
  removeProjectFromSpace(projectId: ID!, spaceId: ID!): Boolean!
  reorderSpaces(orderedIds: [ID!]!): Boolean!

  # --- Settings ---
  setSetting(key: String!, value: String!): Boolean!
  deleteSetting(key: String!): Boolean!

  # --- AI Operations ---
  opencodeConnect(worktreePath: String!, hiveSessionId: ID!): OpenCodeConnectResult!
  opencodeReconnect(input: OpenCodeReconnectInput!): OpenCodeReconnectResult!
  opencodeDisconnect(worktreePath: String!, sessionId: String!): SuccessResult!
  opencodePrompt(input: OpenCodePromptInput!): SuccessResult!
  opencodeAbort(worktreePath: String!, sessionId: String!): SuccessResult!
  opencodeSetModel(input: SetModelInput!): SuccessResult!
  opencodeUndo(worktreePath: String!, sessionId: String!): OpenCodeUndoResult!
  opencodeRedo(worktreePath: String!, sessionId: String!): OpenCodeRedoResult!
  opencodeCommand(input: OpenCodeCommandInput!): SuccessResult!
  opencodeRenameSession(input: RenameSessionInput!): SuccessResult!
  opencodeFork(input: ForkSessionInput!): OpenCodeForkResult!
  opencodeQuestionReply(input: QuestionReplyInput!): SuccessResult!
  opencodeQuestionReject(requestId: String!, worktreePath: String): SuccessResult!
  opencodePlanApprove(input: PlanApproveInput!): SuccessResult!
  opencodePlanReject(input: PlanRejectInput!): SuccessResult!
  opencodePermissionReply(input: PermissionReplyInput!): SuccessResult!

  # --- Git ---
  gitStageFile(worktreePath: String!, filePath: String!): SuccessResult!
  gitUnstageFile(worktreePath: String!, filePath: String!): SuccessResult!
  gitStageAll(worktreePath: String!): SuccessResult!
  gitUnstageAll(worktreePath: String!): SuccessResult!
  gitStageHunk(worktreePath: String!, patch: String!): SuccessResult!
  gitUnstageHunk(worktreePath: String!, patch: String!): SuccessResult!
  gitRevertHunk(worktreePath: String!, patch: String!): SuccessResult!
  gitDiscardChanges(worktreePath: String!, filePath: String!): SuccessResult!
  gitAddToGitignore(worktreePath: String!, pattern: String!): SuccessResult!
  gitCommit(worktreePath: String!, message: String!): GitCommitResult!
  gitPush(input: GitPushInput!): SuccessResult!
  gitPull(input: GitPullInput!): SuccessResult!
  gitMerge(worktreePath: String!, sourceBranch: String!): GitMergeResult!
  gitDeleteBranch(worktreePath: String!, branchName: String!): SuccessResult!
  gitPrMerge(worktreePath: String!, prNumber: Int!): SuccessResult!
  gitWatchWorktree(worktreePath: String!): SuccessResult!
  gitUnwatchWorktree(worktreePath: String!): SuccessResult!
  gitWatchBranch(worktreePath: String!): SuccessResult!
  gitUnwatchBranch(worktreePath: String!): SuccessResult!

  # --- File Tree ---
  fileTreeWatch(worktreePath: String!): SuccessResult!
  fileTreeUnwatch(worktreePath: String!): SuccessResult!

  # --- File ---
  fileWrite(filePath: String!, content: String!): SuccessResult!

  # --- Script ---
  scriptRunSetup(input: ScriptRunInput!): SuccessResult!
  scriptRunProject(input: ScriptRunInput!): ScriptRunResult!
  scriptKill(worktreeId: ID!): SuccessResult!
  scriptRunArchive(commands: [String!]!, cwd: String!): ScriptArchiveResult!

  # --- Terminal ---
  terminalCreate(worktreeId: ID!, cwd: String!, shell: String): TerminalCreateResult!
  terminalWrite(worktreeId: ID!, data: String!): Boolean!
  terminalResize(worktreeId: ID!, cols: Int!, rows: Int!): Boolean!
  terminalDestroy(worktreeId: ID!): Boolean!

  # --- Connection ---
  createConnection(worktreeIds: [ID!]!): ConnectionCreateResult!
  deleteConnection(connectionId: ID!): SuccessResult!
  renameConnection(connectionId: ID!, customName: String): ConnectionWithMembers
  addConnectionMember(connectionId: ID!, worktreeId: ID!): ConnectionAddMemberResult!
  removeConnectionMember(connectionId: ID!, worktreeId: ID!): ConnectionRemoveMemberResult!
  removeWorktreeFromAllConnections(worktreeId: ID!): SuccessResult!

  # --- Project Operations ---
  projectInitRepository(path: String!): SuccessResult!
  projectUploadIcon(projectId: ID!, data: String!, filename: String!): SuccessResult!
  projectRemoveIcon(projectId: ID!): SuccessResult!

  # --- Logging ---
  createResponseLog(sessionId: ID!): String!
  appendResponseLog(filePath: String!, data: JSON!): Boolean!

  # --- System (server management) ---
  systemKillSwitch: Boolean!
  systemRegisterPushToken(token: String!, platform: String!): Boolean!
}

type Subscription {
  # --- AI Streaming (the core subscription) ---
  opencodeStream(sessionIds: [String!]): OpenCodeStreamEvent!

  # --- Git Status Changes ---
  gitStatusChanged(worktreePath: String): GitStatusChangedEvent!
  gitBranchChanged(worktreePath: String): GitBranchChangedEvent!

  # --- File Tree Changes ---
  fileTreeChange(worktreePath: String): FileTreeChangeEvent!

  # --- Terminal I/O ---
  terminalData(worktreeId: ID!): TerminalDataEvent!
  terminalExit(worktreeId: ID!): TerminalExitEvent!

  # --- Script Output ---
  scriptOutput(worktreeId: ID!, channel: String!): ScriptOutputEvent!

  # --- Worktree Events ---
  worktreeBranchRenamed: WorktreeBranchRenamedEvent!
}
```

### 2.4 Core Type Definitions

```graphql
# schema/types/project.graphql

type Project {
  id: ID!
  name: String!
  path: String!
  description: String
  tags: [String!]
  language: String
  customIcon: String
  setupScript: String
  runScript: String
  archiveScript: String
  autoAssignPort: Boolean!
  sortOrder: Int!
  createdAt: String!
  lastAccessedAt: String
}

type Worktree {
  id: ID!
  projectId: ID!
  name: String!
  branchName: String!
  path: String!
  status: WorktreeStatus!
  isDefault: Boolean!
  branchRenamed: Boolean!
  lastMessageAt: String
  sessionTitles: String
  lastModelProviderId: String
  lastModelId: String
  lastModelVariant: String
  createdAt: String!
  lastAccessedAt: String
}

type Session {
  id: ID!
  worktreeId: ID
  projectId: ID!
  connectionId: ID
  name: String
  status: SessionStatus!
  opencodeSessionId: String
  agentSdk: AgentSdk
  mode: SessionMode
  modelProviderId: String
  modelId: String
  modelVariant: String
  draftInput: String
  createdAt: String!
  updatedAt: String
  completedAt: String
}

enum WorktreeStatus { active, archived }
enum SessionStatus { active, completed, error }
enum SessionMode { build, plan }
enum AgentSdk { opencode, claude_code }
```

```graphql
# schema/types/opencode.graphql

type OpenCodeStreamEvent {
  type: String!
  sessionId: String!
  data: JSON!
  childSessionId: String
  statusPayload: SessionStatusPayload
}

type SessionStatusPayload {
  type: String!
  attempt: Int
  message: String
  next: Int
}

type PermissionRequest {
  id: String!
  sessionID: String!
  permission: String!
  patterns: [String!]!
  metadata: JSON
  always: Boolean!
  tool: String
}

input MessagePartInput {
  type: String!
  text: String
  mime: String
  url: String
  filename: String
}
```

```graphql
# schema/types/git.graphql

type GitFileStatus {
  path: String!
  relativePath: String!
  status: String!
  staged: Boolean!
}

type GitBranchInfo {
  name: String!
  tracking: String
  ahead: Int!
  behind: Int!
}

type GitDiffStatFile {
  path: String!
  additions: Int!
  deletions: Int!
}

type GitStatusChangedEvent {
  worktreePath: String!
}

type GitBranchChangedEvent {
  worktreePath: String!
}
```

```graphql
# schema/types/file-tree.graphql

type FileTreeNode {
  name: String!
  path: String!
  relativePath: String!
  isDirectory: Boolean!
  isSymlink: Boolean
  extension: String
  children: [FileTreeNode!]
}

type FlatFile {
  name: String!
  path: String!
  relativePath: String!
  extension: String
}

type FileTreeChangeEvent {
  worktreePath: String!
  eventType: String!
  changedPath: String!
  relativePath: String!
}
```

### 2.5 GraphQL Context

```typescript
// src/server/context.ts
interface GraphQLContext {
  db: DatabaseService
  sdkManager: AgentSdkManager
  eventBus: EventBus
  pathGuard: PathGuard
  auditLog: AuditLogger
  clientIp: string
  authenticated: boolean
}
```

### 2.6 Subscription Implementation

GraphQL subscriptions use `graphql-ws` over WebSocket. Resolvers listen to the EventBus using async generators:

```typescript
// src/server/resolvers/subscription/opencode.resolvers.ts
export const opencodeSubscriptionResolvers = {
  Subscription: {
    opencodeStream: {
      subscribe: async function* (_parent, args, ctx) {
        const queue: OpenCodeStreamEvent[] = []
        let resolve: (() => void) | null = null

        const listener = (event: OpenCodeStreamEvent) => {
          if (args.sessionIds && !args.sessionIds.includes(event.sessionId)) return
          queue.push(event)
          resolve?.()
        }

        ctx.eventBus.on('opencode:stream', listener)
        try {
          while (true) {
            if (queue.length === 0) await new Promise<void>(r => { resolve = r })
            while (queue.length > 0) {
              yield { opencodeStream: queue.shift()! }
            }
          }
        } finally {
          ctx.eventBus.off('opencode:stream', listener)
        }
      }
    }
  }
}
```

### 2.7 EventBus Design

Typed EventEmitter bridging services → GraphQL subscriptions:

```typescript
// src/server/event-bus.ts
interface EventBusEvents {
  'opencode:stream': [event: OpenCodeStreamEvent]
  'file-tree:change': [event: FileTreeChangeEvent]
  'git:statusChanged': [data: { worktreePath: string }]
  'git:branchChanged': [data: { worktreePath: string }]
  'terminal:data': [worktreeId: string, data: string]
  'terminal:exit': [worktreeId: string, code: number]
  'script:output': [channel: string, event: ScriptOutputEvent]
  'worktree:branchRenamed': [data: { worktreeId: string, newBranch: string }]
}
```

Services emit to both `webContents.send()` (desktop) and `eventBus.emit()` (GraphQL).

### 2.8 Server Entry Point

```typescript
// src/server/index.ts
import { createYoga, createSchema } from 'graphql-yoga'
import { useServer } from 'graphql-ws/lib/use/ws'
import { createServer } from 'node:https'
import { WebSocketServer } from 'ws'

export function startGraphQLServer(opts: {
  port: number
  tlsCert: string
  tlsKey: string
  context: GraphQLContext
}) {
  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    context: ({ request }) => ({
      ...opts.context,
      clientIp: extractIp(request),
      authenticated: verifyAuth(request, opts.context.db),
    }),
    plugins: [authPlugin, auditPlugin],
  })

  const server = createServer(
    { cert: readFileSync(opts.tlsCert), key: readFileSync(opts.tlsKey) },
    yoga
  )

  const wss = new WebSocketServer({ server, path: yoga.graphqlEndpoint })
  useServer(
    {
      execute: (args) => args.rootValue,
      subscribe: (args) => args.rootValue,
      context: (ctx) => ({
        ...opts.context,
        clientIp: ctx.extra.request.socket.remoteAddress,
        authenticated: verifyWsAuth(ctx.connectionParams, opts.context.db),
      }),
      onConnect: (ctx) => {
        if (!verifyWsAuth(ctx.connectionParams, opts.context.db)) return false
      },
    },
    wss
  )

  server.listen(opts.port)
}
```

### 2.9 Streaming Performance

AI streaming events fire at 10-50/sec during token generation. Strategies:
- **Batching**: Accumulate events for 50ms before yielding (reduces WebSocket frames)
- **Session filtering**: `sessionIds` argument lets mobile subscribe only to visible session events
- **Backpressure**: If WS send buffer grows, drop `message.updated` for non-active sessions (client re-fetches on reconnect)

### 2.10 Operations EXCLUDED from GraphQL (desktop-only, ~25 operations)

These are inherently desktop GUI concepts:
- `dialog:openDirectory` — native file picker
- `shell:showItemInFolder`, `shell:openPath` — desktop shell operations
- `clipboard:*` — client-side on mobile
- `worktree:openInTerminal`, `worktree:openInEditor` — desktop launchers
- `connection:openInTerminal`, `connection:openInEditor` — desktop launchers
- `system:openInChrome`, `system:openInApp` — desktop app openers
- `system:quitApp` — replaced by kill switch
- `menu:*`, `shortcut:*`, `notification:navigate`, `app:windowFocused` — Electron UI plumbing
- All `terminal:ghostty:*` (12 methods) — native GPU terminal rendering
- All `updater:*` — Electron auto-update (mobile uses app stores)

---

## 3. Security Design

### 3.1 Threat Model

This server exposes **full RCE** on the host machine via terminal, scripts, and AI sessions. A compromised API key = full system access. Every design decision must account for this.

### 3.2 API Key

**Generation**: 256-bit random key via `crypto.randomBytes(32)`, base64url encoded.
Format: `hive_Ks7dF2mPq9xR4wN8vT3jL6hB0yU5cA1eG7iO2sD4fH`

**Storage**: SHA-256 hash in SQLite `settings` table (`headless_api_key_hash`). Timing-safe comparison via `crypto.timingSafeEqual`.

**Pairing**: First run displays key in terminal + ASCII QR code. QR payload includes host, port, key, and TLS cert fingerprint.

**Rotation**: `hive --headless --rotate-key` generates new key, invalidates old hash, drops all connections.

### 3.3 TLS

**Self-signed certificate** with certificate pinning on mobile. Auto-generated on first headless run using ECDSA P-256 (10-year validity). Stored at `~/.hive/tls/`.

Certificate fingerprint included in QR code pairing payload. React Native app pins the fingerprint via `react-native-ssl-pinning`.

### 3.4 Transport Security

- **Rate limiting (unauthenticated only)**: 5 failed auth attempts per IP per minute → 5-minute block. **No rate limiting for authenticated users** — once authenticated, full access with no throttling.
- **WebSocket auth**: API key in `connectionParams` during WS handshake. Rejected before upgrade if invalid.
- **Timeouts**: HTTP 30s (120s long ops), WS idle 5min, heartbeat ping/30s, max 2 concurrent WS.

### 3.5 Request Security

- **Path traversal prevention**: `PathGuard` validates every file path against allowed roots (project paths, worktree paths, `~/.hive/`).
- **Command injection prevention**: Script endpoints accept worktree IDs only, resolve commands from DB. Terminal is intentionally a shell (like SSH).
- **Input validation**: GraphQL schema enforces types. Custom validators for paths, UUIDs, string lengths.
- **Payload limits**: 10MB HTTP body, 1MB WebSocket message.

### 3.6 Operational Security

- **Audit logging**: Auth success/failure, API calls, sensitive ops (terminal, scripts, git push), kill switch.
- **Failed auth alerting**: 3+ failures → ERROR log + system notification (if GUI active).
- **Kill switch**: `systemKillSwitch` mutation invalidates key, closes all connections. Also via CLI: `hive --headless --kill`.
- **Auto-lock**: 30 min inactivity → locked mode (all API calls return errors). Unlock via `hive --headless --unlock`.
- **Status file**: `~/.hive/hive-headless.status.json` updated every 30s with uptime, connections, request count.

### 3.7 CLI Interface

```
hive --headless                   # Start headless mode
hive --headless --port 9443       # Custom port
hive --headless --bind 127.0.0.1  # Bind to specific interface
hive --headless --rotate-key      # Rotate API key
hive --headless --regen-certs     # Regenerate TLS certs
hive --headless --show-status     # Print status of running instance
hive --headless --kill            # Stop and revoke key
hive --headless --unlock          # Unlock after inactivity timeout
```

### 3.8 Configuration

`~/.hive/headless.json`:
```json
{
  "port": 8443,
  "bindAddress": "0.0.0.0",
  "tls": { "certPath": "~/.hive/tls/server.crt", "keyPath": "~/.hive/tls/server.key" },
  "security": {
    "bruteForceMaxAttempts": 5,
    "bruteForceWindowSec": 60,
    "bruteForceBlockSec": 300,
    "inactivityTimeoutMin": 30,
    "allowedIps": []
  }
}
```

---

## 4. React Native Mobile App

### 4.1 Technology Stack

| Component | Technology |
|-----------|-----------|
| Framework | React Native (Expo or bare) |
| GraphQL client | **Apollo Client** (`@apollo/client`) |
| Codegen | **graphql-codegen** (generates typed hooks from SDL) |
| Navigation | React Navigation (bottom tabs + stacks) |
| State | Zustand (shared stores from Electron) |
| Styling | NativeWind (Tailwind for RN) |
| Lists | `@shopify/flash-list` |
| Icons | `lucide-react-native` |
| Markdown | `react-native-markdown-display` |
| Syntax highlighting | `react-native-code-editor` or custom |
| Bottom sheets | `@gorhom/bottom-sheet` |
| Secure storage | `react-native-keychain` |
| Push notifications | `@notifee/react-native` + FCM/APNs |
| QR scanner | `expo-camera` or `react-native-camera` |
| Persistence | `@react-native-async-storage/async-storage` |

### 4.2 Apollo Client Setup

```typescript
import { ApolloClient, InMemoryCache, split, HttpLink } from '@apollo/client'
import { GraphQLWsLink } from '@apollo/client/link/subscriptions'
import { createClient } from 'graphql-ws'
import { getMainDefinition } from '@apollo/client/utilities'

const httpLink = new HttpLink({
  uri: `https://${serverUrl}/graphql`,
  headers: { authorization: `Bearer ${apiKey}` },
})

const wsLink = new GraphQLWsLink(createClient({
  url: `wss://${serverUrl}/graphql`,
  connectionParams: { apiKey },
}))

const splitLink = split(
  ({ query }) => {
    const def = getMainDefinition(query)
    return def.kind === 'OperationDefinition' && def.operation === 'subscription'
  },
  wsLink,
  httpLink,
)

const client = new ApolloClient({
  link: splitLink,
  cache: new InMemoryCache(),
})
```

### 4.3 Codegen Integration

`graphql-codegen` generates typed React hooks from the SDL schema:

```typescript
// Auto-generated by codegen
export function useProjectsQuery() { ... }
export function useCreateProjectMutation() { ... }
export function useOpencodeStreamSubscription(options: { sessionIds?: string[] }) { ... }
```

The mobile app uses these generated hooks directly. When the schema changes (new feature added), re-running codegen automatically updates all types and hooks.

### 4.4 Navigation Structure

```
Bottom Tabs (4 tabs):
┌────────────┬────────────┬────────────┬────────────┐
│  Projects  │  Session   │   Files    │    More    │
└────────────┴────────────┴────────────┴────────────┘

Projects Tab (stack):
  ProjectList → WorktreeDetail → SessionView

Session Tab (stack):
  SessionView → FileViewer (via tool card tap)

Files Tab (segmented control):
  Tree view: FileTree → FileViewer
  Changes view: GitChanges → DiffViewer

More Tab (stack):
  SettingsHome → ConnectionSetup | TerminalRunner | SessionHistory
```

**Modal overlays** (slide-up sheets):
- Permission request (big Approve/Reject buttons)
- Question prompt (answer options)
- Plan approval (scrollable markdown + Approve/Reject)
- Model selector (bottom sheet)

### 4.5 Critical Screens

#### Server Connection / Pairing
- TextInput for server URL + TextInput for API key (secure)
- "Scan QR Code" button
- Connection status indicator + "Test Connection" button
- Credentials stored in Keychain

#### Project / Worktree Browser
- `SectionList` with project headers, worktree rows
- Status badges (working/completed/permission/plan_ready)
- Long-press context menu (archive, duplicate, rename)

#### AI Session View (most complex screen)
- **Header**: session name, mode toggle, model selector, context usage
- **Message list** (`FlashList`): user bubbles, assistant responses (markdown + tool cards + subtasks + reasoning), streaming cursor
- **Permission banner**: sticky above input, Allow/Deny
- **Question banner**: answer chips
- **Plan approval**: full-screen modal
- **Input area** (bottom): multiline TextInput, Send/Abort, attachment, mode chip

#### File Tree Browser
- `FlashList` with indentation, file/folder icons, git status dots
- Search bar, lazy child loading

#### File Viewer / Editor
- View: syntax-highlighted, line numbers, horizontal scroll
- Edit: monospace TextInput, save button
- Diff viewer: unified diff with green/red coloring, swipe actions for hunk staging

#### Git Status Panel
- Segmented: Changes | Branches
- Staged/unstaged file sections, swipe-to-stage/unstage/discard
- Commit form + Push/Pull with ahead/behind counts

#### Terminal (Simplified Command Runner)
- TextInput + "Run" button
- ScrollView with monospace output, auto-scroll
- Command history
- NOT a full terminal emulator

#### Settings
- Connection, AI Model, Agent SDK, Notifications, Appearance, About

### 4.6 State Management — Shared Stores

**Strategy**: Shared Zustand store logic with a swappable transport abstraction.

**Reuse directly** (swap `window.*` calls for GraphQL queries/mutations):
- `useProjectStore` — project CRUD, selection, ordering
- `useWorktreeStore` — worktree CRUD, selection, ordering
- `useSessionStore` — session management, tabs, mode, model (~1200 lines)
- `useWorktreeStatusStore` — session status badges
- `usePermissionStore` — pending permission queue
- `useQuestionStore` — pending question queue
- `useContextStore` — token usage tracking
- `useSettingsStore` — user preferences
- `useGitStore` — git file statuses, branch info
- `useFileTreeStore` — file tree data
- `useFileViewerStore` — open file/diff tabs
- `useConnectionStore` — multi-worktree connections
- `useSpaceStore` — spaces
- `usePromptHistoryStore`, `useSessionHistoryStore`

**Rewrite for mobile**:
- `useLayoutStore` → mobile navigation state
- `useTerminalStore` → simplified command runner store
- `useCommandPaletteStore` → mobile search/action sheet
- `useShortcutStore` → not needed

**New mobile-only stores**:
- `useConnectionManagerStore` — server URL, API key, connection state, reconnection
- `useNotificationStore` — push notification registration
- `useMobileNavigationStore` — tab state, deep linking

### 4.7 Transport Abstraction

The `HiveTransport` interface mirrors `window.*` APIs. Stores call transport methods instead of `window.*` directly:

```typescript
interface HiveTransport {
  db: {
    project: { getAll(): Promise<Project[]>; get(id: string): Promise<Project | null>; ... }
    worktree: { ... }
    session: { ... }
    setting: { ... }
    space: { ... }
  }
  opencodeOps: { connect(...): Promise<Result>; prompt(...): Promise<Result>; ... }
  gitOps: { getFileStatuses(path: string): Promise<Result>; ... }
  // ... all namespaces
}
```

- **Electron transport**: wraps `window.*` calls (unchanged)
- **GraphQL transport**: wraps Apollo Client queries/mutations

### 4.8 Stream Event Handler — Shared Logic

`useOpenCodeGlobalListener` (~200 lines of event routing) extracted to a shared `handleStreamEvent()`. Used by:
- Desktop: `ipcRenderer.on('opencode:stream', ...)` → `handleStreamEvent(event)`
- Mobile: `useOpencodeStreamSubscription` → `handleStreamEvent(data.opencodeStream)`

### 4.9 Offline / Reconnection

**Connection state machine**: Disconnected → Connecting → Connected → Reconnecting → ...

**Reconnection**: Exponential backoff with jitter (1s→30s cap). Max 10 retries.

**State recovery on reconnect**:
1. Re-establish WebSocket
2. Active AI sessions: `opencodeReconnect` + `opencodeMessages` + re-subscribe
3. Visible worktree: `gitFileStatuses` + re-subscribe status changes
4. Visible file tree: `fileTreeScan` + re-subscribe changes

**Offline mode**: Cached data viewable. Actions show error toast. Persistent "Offline" banner.

### 4.10 Push Notifications

**Server triggers**: session completed, permission pending, question asked, plan ready, session error.
**Deep linking**: notification tap → relevant screen/modal.
**Actionable**: permission requests show Allow/Deny directly on notification.

### 4.11 Performance

- **Message list**: `FlashList`, streaming updates via mutable ref + 30fps throttle
- **Tool cards**: collapsed by default, lazy-loaded on expansion
- **Message windowing**: keep 100 recent messages for 200+ message sessions
- **Git status debounce**: 500ms on mobile (vs 150ms desktop)
- **Apollo cache**: normalized cache avoids redundant fetches

---

## 5. Code Sharing Strategy

### 5.1 Shared Package

```
src/shared/
  types/                         # Extracted from src/preload/index.d.ts
    project.ts, worktree.ts, session.ts, git.ts, opencode.ts,
    file-tree.ts, connection.ts, script.ts, terminal.ts, settings.ts
  lib/
    stream-event-handler.ts      # Extracted from useOpenCodeGlobalListener
    transport.ts                 # HiveTransport interface
    token-utils.ts, format-utils.ts, constants.ts, subsequence-match.ts
  codegen.ts                     # graphql-codegen config
```

### 5.2 What Shares Directly
- All TypeScript types (Project, Worktree, Session, GitFileStatus, etc.)
- Pure logic utilities
- Stream event handler logic
- Store business logic (after transport abstraction)

### 5.3 What's Mobile-Specific
- All React components (View, Text, Pressable vs div, span, button)
- Styling (NativeWind vs Tailwind CSS)
- Navigation (React Navigation vs none)
- Storage (AsyncStorage vs localStorage)
- File viewer (react-native-code-editor vs Monaco)
- Terminal (ScrollView vs xterm.js)

### 5.4 graphql-codegen Configuration

Generates TypeScript types + Apollo Client hooks from the SDL schema:
- Server-side: resolver types for type-safe resolvers
- Client-side: typed query/mutation/subscription hooks
- Run on schema change: `pnpm codegen`

---

## 6. Database Changes

No new tables needed. Security state uses existing `settings` key-value table:
- `headless_api_key_hash` — SHA-256 hash of API key
- `headless_cert_fingerprint` — TLS cert fingerprint
- `headless_key_created_at` — ISO timestamp
- `headless_push_token` — FCM/APNs device token
- `headless_push_platform` — `ios` | `android`

---

## 7. New Dependencies

### Server-side (add to existing `package.json`)

```
graphql                   # GraphQL core
graphql-yoga              # GraphQL server
graphql-ws                # WebSocket subscriptions
ws                        # WebSocket server
qrcode-terminal           # QR code display in terminal
@graphql-codegen/cli      # Type generation (devDep)
@graphql-codegen/typescript # Type generation (devDep)
@graphql-codegen/typescript-resolvers # Resolver types (devDep)
```

### Mobile app (new `package.json`)

```
react-native
@apollo/client            # GraphQL client
graphql                   # GraphQL core
graphql-ws                # WebSocket subscriptions
zustand                   # State management (shared stores)
nativewind                # Tailwind for RN
@gorhom/bottom-sheet      # Modal sheets
@shopify/flash-list       # Virtualized lists
lucide-react-native       # Icons
react-native-markdown-display
react-native-code-editor  # Syntax highlighting
react-native-keychain     # Secure credential storage
react-native-ssl-pinning  # TLS cert pinning
react-native-toast-message
@react-navigation/native
@react-navigation/bottom-tabs
@react-navigation/native-stack
@react-native-async-storage/async-storage
@notifee/react-native     # Push notifications
react-native-camera       # QR scanning
@graphql-codegen/cli      # Type generation (devDep)
@graphql-codegen/typescript  # (devDep)
@graphql-codegen/typescript-react-apollo  # Generated hooks (devDep)
```

---

## 8. Implementation Phases

### THIS REPO: Hive Electron (Server Side)

#### Phase 1: Foundation
1. Create `src/shared/types/` — extract types from `src/preload/index.d.ts`
2. Create `src/server/event-bus.ts` — typed EventEmitter
3. Modify ~5 service files to emit to EventBus alongside `webContents.send()`
4. Add `--headless` flag handling to `src/main/index.ts`
5. Add graphql + graphql-yoga + graphql-ws + ws dependencies

#### Phase 2: GraphQL Server Core
6. Write SDL schema files (types, queries, mutations, subscriptions)
7. Set up graphql-codegen for server resolver types
8. Create `src/server/context.ts`, server entry point
9. Create auth plugin (API key verification + brute force protection on unauthenticated requests)
10. Create path-guard plugin
11. Implement `db` resolvers (simplest, ~40 operations, pure CRUD)
12. Implement `system` resolvers
13. Test with GraphQL Playground / curl

#### Phase 3: Feature Resolvers
14. Implement `project` resolvers
15. Implement `worktree` resolvers
16. Implement `git` resolvers (~25 operations)
17. Implement `connection` resolvers
18. Implement `file` + `fileTree` resolvers
19. Implement `settings` resolvers

#### Phase 4: Streaming & Subscriptions
20. Implement `opencode` resolvers with `opencodeStream` subscription (~20 operations)
21. Implement `gitStatusChanged`, `gitBranchChanged` subscriptions
22. Implement `fileTreeChange` subscription
23. Implement `terminal` resolvers with `terminalData`/`terminalExit` subscriptions
24. Implement `script` resolvers with `scriptOutput` subscription
25. Implement `logging` resolvers

#### Phase 5: Security & Headless UX
26. TLS certificate auto-generation
27. API key generation + QR code display
28. Audit logging plugin
29. Auto-lock, kill switch
30. `~/.hive/headless.json` config loading
31. CLI commands (rotate-key, regen-certs, show-status, kill, unlock)
32. PID file + status file

#### Phase 6: Server Testing
33. Server integration tests (yoga.fetch())
34. Subscription tests (WebSocket connect, stream events)
35. Auth tests (key verification, brute force protection)
36. Regression: existing test suite still passes (`pnpm test`)

---

### SEPARATE REPO: React Native Mobile App (documented here, built later)

#### Phase 7: React Native Foundation
37. Scaffold React Native project (separate repo)
38. Set up NativeWind + React Navigation
39. Set up Apollo Client with split link (HTTP + WS)
40. Set up graphql-codegen for client (typed hooks)
41. Create `HiveTransport` interface + GraphQL transport implementation
42. Implement `useConnectionManagerStore` + Connection/Pairing screen
43. Port core Zustand stores (ProjectStore, WorktreeStore, SessionStore)
44. Extract `handleStreamEvent()` to shared package

#### Phase 8: Mobile Core Screens
45. Project / Worktree Browser screen
46. AI Session View screen (message list, input, streaming)
47. Permission, Question, Plan approval modals
48. Model selector bottom sheet

#### Phase 9: Mobile Full Feature Parity
49. File Tree Browser screen
50. File Viewer + basic Editor
51. Git Status Panel (changes, staging, commit, push/pull)
52. Diff Viewer
53. Terminal (simplified command runner)
54. Settings screen
55. Session History search

#### Phase 10: Mobile Polish
56. Push notification integration (FCM/APNs)
57. Deep linking from notifications
58. Actionable notifications (approve/deny from notification)
59. Offline/reconnection handling
60. Performance optimization (FlashList, streaming batching, Apollo cache tuning)

#### Phase 11: Mobile Testing & Release
61. Mobile unit tests (shared stores with mock transport)
62. Mobile component tests (React Native Testing Library)
63. E2E tests (Detox)
64. App Store / Play Store preparation

---

## 9. Critical Files Reference

### Files to Modify (minimal changes)

| File | Change |
|------|--------|
| `src/main/index.ts` | Add `--headless` branch (~20 lines) |
| `src/main/services/opencode-service.ts` | Add EventBus emission (~3 lines) |
| `src/main/ipc/git-file-handlers.ts` | Add EventBus emission (~2 lines) |
| `src/main/ipc/file-tree-handlers.ts` | Add EventBus emission (~1 line) |
| `src/main/ipc/script-handlers.ts` | Add EventBus emission (~2 lines) |
| `src/main/ipc/terminal-handlers.ts` | Add EventBus emission (~2 lines) |
| `package.json` | Add graphql + yoga + ws deps |

### Files to Create (new, in this repo)

| Directory | Purpose |
|-----------|---------|
| `src/shared/types/` | Extracted types (from `src/preload/index.d.ts`) |
| `src/shared/lib/` | Shared utilities + transport interface |
| `src/server/schema/` | GraphQL SDL schema files |
| `src/server/resolvers/` | Query, Mutation, Subscription resolvers |
| `src/server/plugins/` | Auth (with brute force protection), path-guard, audit plugins |
| `src/server/` | Server entry point, context, config, EventBus |

### Separate Repository (documented, built later)

| Directory | Purpose |
|-----------|---------|
| React Native project | Entire mobile app consuming the GraphQL API |

### Key Source-of-Truth Files (read-only reference)

| File | Why |
|------|-----|
| `src/preload/index.d.ts` | All shared types — the API contract to mirror in GraphQL SDL |
| `src/preload/index.ts` | Complete API surface — every operation to expose as resolver |
| `src/main/db/types.ts` | Database entity types → GraphQL types |
| `src/main/services/agent-sdk-types.ts` | AI SDK interface → opencode resolver contract |
| `src/main/ipc/opencode-handlers.ts` | Most complex handler — template for opencode resolvers |
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` | Stream event handler — extract to shared |
| `src/renderer/src/components/sessions/SessionView.tsx` | Reference for mobile session view |

---

## 10. Verification Plan

### Server Testing
- Start headless: `hive --headless --port 8443`
- Verify TLS cert generation and QR code display
- Test auth via GraphQL query: `curl -k https://localhost:8443/graphql -H "Authorization: Bearer hive_..." -d '{"query":"{ systemAppVersion }"}'`
- Test rate limiting: 6 rapid requests with wrong key → 5th blocked
- Test each resolver domain with representative queries/mutations
- Test WebSocket subscription: connect, send prompt, verify stream events
- Test kill switch: call mutation, verify all connections drop
- Test auto-lock: wait 30 min, verify locked response
- Use GraphQL Playground for interactive testing

### Mobile Testing
- Scan QR code → connection established
- Browse projects and worktrees
- Start AI session → send prompt → see streaming response
- Approve/reject permission from notification (without opening app)
- View files with syntax highlighting
- Stage files, commit, push
- Run command in simplified terminal
- Disconnect WiFi → offline banner → reconnect → state restored
- Force-kill app → reopen → reconnected with state intact

### Integration Testing
- Desktop app running + headless server running simultaneously → both work
- Mobile sends prompt → desktop sees session activity (if both connected)
- Desktop makes changes → mobile refreshes and sees them

### Regression Testing
- Run full existing test suite (`pnpm test`) — all pass
- Run existing E2E tests (`pnpm test:e2e`) — all pass
- Desktop app startup and all features work normally

---

## 11. Future-Proofing

### Adding New Features

When a new feature is added to Hive:

1. **Service layer**: Implement the feature in `src/main/services/` (as usual)
2. **IPC handler**: Add IPC channel in `src/main/ipc/` (as usual, for desktop)
3. **GraphQL schema**: Add types/queries/mutations/subscriptions to SDL files
4. **Resolvers**: Add resolvers that call the same service methods
5. **Codegen**: Run `pnpm codegen` — typed hooks auto-generated for mobile
6. **Mobile UI**: Build the screen/component using generated hooks

Steps 3-6 are the only additions for mobile support. The service layer is shared, so no business logic duplication. The codegen step ensures type safety end-to-end.

### Potential Future Enhancements
- **Web client**: The GraphQL API is client-agnostic — a web dashboard could consume the same API
- **Multi-device**: Upgrade from single-device to multi-device by adding connection tracking and event fan-out
- **Plugin API**: Expose GraphQL schema extension points for user plugins
- **Metrics/monitoring**: Add Prometheus metrics endpoint alongside GraphQL
