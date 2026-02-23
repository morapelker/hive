# Phase 2 — SDL Schema (Sessions 11–18)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 2 defines the complete GraphQL schema in SDL (Schema Definition Language) `.graphql` files. These files are the contract between the server and mobile client. The schema mirrors the types extracted in Phase 1 and the API surface from `src/preload/index.d.ts`. At the end of this phase, `graphql-codegen` generates TypeScript resolver types from the SDL.

## Prerequisites

- Phase 1 completed: shared types in `src/shared/types/`, EventBus operational, directories scaffolded.
- `src/server/schema/` and `src/server/schema/types/` directories exist.
- `src/server/__generated__/` directory exists.

## Key Conventions

- **GraphQL field names use camelCase** (not snake_case). E.g., DB column `project_id` → GraphQL field `projectId`.
- **Nullable fields**: Fields that are `null` in the TS type are nullable in GraphQL (no `!`).
- **IDs**: Use `ID!` for primary keys, `ID` for optional foreign key references.
- **JSON scalar**: Used for untyped dynamic data (e.g., OpenCode message data, model providers).
- **Result wrapper pattern**: Most operations return a `*Result` type with `success: Boolean!` and optional `error: String`.

## Source of Truth

| Reference | Purpose |
|-----------|---------|
| `src/preload/index.d.ts` | Complete API surface — every operation to expose |
| `src/shared/types/` | TypeScript types extracted in Phase 1 |
| `docs/plans/mobileapp.md` Section 2.3 | Full GraphQL schema specification |

---

## Session 11: SDL Types — Entities

**Goal:** Write GraphQL type definitions for all database entities.

**Definition of Done:** `.graphql` files with all entity types, valid SDL syntax.

**Tasks:**

1. `[server]` Create `src/server/schema/types/project.graphql` with:
   ```graphql
   type Project {
     id: ID!
     name: String!
     path: String!
     description: String
     tags: String
     language: String
     customIcon: String
     setupScript: String
     runScript: String
     archiveScript: String
     autoAssignPort: Boolean!
     sortOrder: Int!
     createdAt: String!
     lastAccessedAt: String!
   }

   type Worktree {
     id: ID!
     projectId: ID!
     name: String!
     branchName: String!
     path: String!
     status: WorktreeStatus!
     isDefault: Boolean!
     branchRenamed: Int!
     lastMessageAt: Float
     sessionTitles: String!
     lastModelProviderId: String
     lastModelId: String
     lastModelVariant: String
     createdAt: String!
     lastAccessedAt: String!
   }

   type Session {
     id: ID!
     worktreeId: ID
     projectId: ID!
     connectionId: ID
     name: String
     status: SessionStatus!
     opencodeSessionId: String
     agentSdk: AgentSdk!
     mode: SessionMode!
     modelProviderId: String
     modelId: String
     modelVariant: String
     createdAt: String!
     updatedAt: String!
     completedAt: String
   }

   type SessionWithWorktree {
     id: ID!
     worktreeId: ID
     projectId: ID!
     connectionId: ID
     name: String
     status: SessionStatus!
     opencodeSessionId: String
     agentSdk: AgentSdk!
     mode: SessionMode!
     modelProviderId: String
     modelId: String
     modelVariant: String
     createdAt: String!
     updatedAt: String!
     completedAt: String
     worktreeName: String
     worktreeBranchName: String
     projectName: String
   }

   type Space {
     id: ID!
     name: String!
     iconType: String!
     iconValue: String!
     sortOrder: Int!
     createdAt: String!
   }

   type ProjectSpaceAssignment {
     projectId: ID!
     spaceId: ID!
   }

   enum WorktreeStatus {
     active
     archived
   }

   enum SessionStatus {
     active
     completed
     error
   }

   enum SessionMode {
     build
     plan
   }

   enum AgentSdk {
     opencode
     claude_code
   }
   ```

2. `[server]` Create `src/server/schema/types/connection.graphql` with:
   ```graphql
   type Connection {
     id: ID!
     name: String!
     status: String!
     path: String!
     color: String
     createdAt: String!
     updatedAt: String!
   }

   type ConnectionMember {
     id: ID!
     connectionId: ID!
     worktreeId: ID!
     projectId: ID!
     symlinkName: String!
     addedAt: String!
   }

   type ConnectionWithMembers {
     id: ID!
     name: String!
     status: String!
     path: String!
     color: String
     createdAt: String!
     updatedAt: String!
     members: [ConnectionMemberWithDetails!]!
   }

   type ConnectionMemberWithDetails {
     id: ID!
     connectionId: ID!
     worktreeId: ID!
     projectId: ID!
     symlinkName: String!
     addedAt: String!
     worktreeName: String!
     worktreeBranch: String!
     worktreePath: String!
     projectName: String!
   }
   ```

**Verification:** Files exist and are syntactically valid. Full validation happens in Session 18 with codegen.

---

## Session 12: SDL Types — Domain

**Goal:** Write GraphQL type definitions for all domain-specific types.

**Definition of Done:** All domain `.graphql` type files created.

**Tasks:**

1. `[server]` Create `src/server/schema/types/git.graphql` with:
   ```graphql
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
     binary: Boolean!
   }

   type GitStatusChangedEvent {
     worktreePath: String!
   }

   type GitBranchChangedEvent {
     worktreePath: String!
   }

   type GitBranchWithStatus {
     name: String!
     isRemote: Boolean!
     isCheckedOut: Boolean!
     worktreePath: String
   }

   type GitPR {
     number: Int!
     title: String!
     author: String!
     headRefName: String!
   }
   ```

2. `[server]` Create `src/server/schema/types/opencode.graphql` with:
   ```graphql
   scalar JSON

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
     always: [String!]!
     tool: PermissionTool
   }

   type PermissionTool {
     messageID: String!
     callID: String!
   }

   type OpenCodeCommand {
     name: String!
     description: String
     template: String!
     agent: String
     model: String
     source: String
     subtask: Boolean
     hints: [String!]
   }

   type OpenCodeCapabilities {
     supportsUndo: Boolean!
     supportsRedo: Boolean!
     supportsCommands: Boolean!
     supportsPermissionRequests: Boolean!
     supportsQuestionPrompts: Boolean!
     supportsModelSelection: Boolean!
     supportsReconnect: Boolean!
     supportsPartialStreaming: Boolean!
   }
   ```

3. `[server]` Create `src/server/schema/types/file-tree.graphql` with:
   ```graphql
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

4. `[server]` Create `src/server/schema/types/script.graphql` with:
   ```graphql
   type ScriptOutputEvent {
     type: String!
     command: String
     data: String
     exitCode: Int
   }
   ```

5. `[server]` Create `src/server/schema/types/terminal.graphql` with:
   ```graphql
   type TerminalDataEvent {
     worktreeId: ID!
     data: String!
   }

   type TerminalExitEvent {
     worktreeId: ID!
     code: Int!
   }
   ```

6. `[server]` Create `src/server/schema/types/settings.graphql` with:
   ```graphql
   type SettingEntry {
     key: String!
     value: String!
   }

   type DetectedApp {
     id: String!
     name: String!
     command: String!
     available: Boolean!
   }
   ```

7. `[server]` Create `src/server/schema/types/system.graphql` with:
   ```graphql
   type ServerStatus {
     uptime: Int!
     connections: Int!
     requestCount: Int!
     locked: Boolean!
     version: String!
   }

   type AppPaths {
     userData: String!
     home: String!
     logs: String!
   }

   type AgentSdkDetection {
     opencode: Boolean!
     claude: Boolean!
   }
   ```

---

## Session 13: SDL Types — Inputs

**Goal:** Define all GraphQL input types used by mutations and queries.

**Definition of Done:** All ~28 input types defined in appropriate `.graphql` files.

**Tasks:**

1. `[server]` Add project inputs to `project.graphql`:
   ```graphql
   input CreateProjectInput {
     name: String!
     path: String!
     description: String
     tags: [String!]
   }

   input UpdateProjectInput {
     name: String
     description: String
     tags: [String!]
     language: String
     customIcon: String
     setupScript: String
     runScript: String
     archiveScript: String
     autoAssignPort: Boolean
     lastAccessedAt: String
   }
   ```

2. `[server]` Add worktree inputs to `project.graphql` (or a separate file):
   ```graphql
   input CreateWorktreeInput {
     projectId: ID!
     projectPath: String!
     projectName: String!
   }

   input DeleteWorktreeInput {
     worktreeId: ID!
     worktreePath: String!
     branchName: String!
     projectPath: String!
     archive: Boolean!
   }

   input DuplicateWorktreeInput {
     projectId: ID!
     projectPath: String!
     projectName: String!
     sourceBranch: String!
     sourceWorktreePath: String!
   }

   input RenameBranchInput {
     worktreeId: ID!
     worktreePath: String!
     oldBranch: String!
     newBranch: String!
   }

   input CreateFromBranchInput {
     projectId: ID!
     projectPath: String!
     projectName: String!
     branchName: String!
   }

   input UpdateWorktreeInput {
     name: String
     status: WorktreeStatus
     lastMessageAt: Float
     lastAccessedAt: String
   }

   input UpdateWorktreeModelInput {
     worktreeId: ID!
     modelProviderId: String!
     modelId: String!
     modelVariant: String
   }
   ```

3. `[server]` Add session inputs:
   ```graphql
   input CreateSessionInput {
     worktreeId: ID
     projectId: ID!
     connectionId: ID
     name: String
     opencodeSessionId: String
     agentSdk: AgentSdk
     modelProviderId: String
     modelId: String
     modelVariant: String
   }

   input UpdateSessionInput {
     name: String
     status: SessionStatus
     opencodeSessionId: String
     agentSdk: AgentSdk
     mode: SessionMode
     modelProviderId: String
     modelId: String
     modelVariant: String
     updatedAt: String
     completedAt: String
   }

   input SessionSearchInput {
     keyword: String
     projectId: ID
     worktreeId: ID
     dateFrom: String
     dateTo: String
     includeArchived: Boolean
   }
   ```

4. `[server]` Add space inputs:
   ```graphql
   input CreateSpaceInput {
     name: String!
     iconType: String
     iconValue: String
   }

   input UpdateSpaceInput {
     name: String
     iconType: String
     iconValue: String
     sortOrder: Int
   }
   ```

5. `[server]` Add OpenCode inputs to `opencode.graphql`:
   ```graphql
   input OpenCodeReconnectInput {
     worktreePath: String!
     opencodeSessionId: String!
     hiveSessionId: ID!
   }

   input OpenCodePromptInput {
     worktreePath: String!
     opencodeSessionId: String!
     message: String
     parts: [MessagePartInput!]
     model: ModelInput
   }

   input MessagePartInput {
     type: String!
     text: String
     mime: String
     url: String
     filename: String
   }

   input ModelInput {
     providerID: String!
     modelID: String!
     variant: String
   }

   input SetModelInput {
     providerID: String!
     modelID: String!
     variant: String
     agentSdk: AgentSdk
   }

   input OpenCodeCommandInput {
     worktreePath: String!
     opencodeSessionId: String!
     command: String!
     args: String!
     model: ModelInput
   }

   input RenameSessionInput {
     opencodeSessionId: String!
     title: String!
     worktreePath: String
   }

   input ForkSessionInput {
     worktreePath: String!
     opencodeSessionId: String!
     messageId: String
   }

   input QuestionReplyInput {
     requestId: String!
     answers: [[String!]!]!
     worktreePath: String
   }

   input PlanApproveInput {
     worktreePath: String!
     hiveSessionId: ID!
     requestId: String
   }

   input PlanRejectInput {
     worktreePath: String!
     hiveSessionId: ID!
     feedback: String!
     requestId: String
   }

   input PermissionReplyInput {
     requestId: String!
     reply: String!
     worktreePath: String
     message: String
   }
   ```

6. `[server]` Add git inputs to `git.graphql`:
   ```graphql
   input GitDiffInput {
     worktreePath: String!
     filePath: String!
     staged: Boolean!
     isUntracked: Boolean!
     contextLines: Int
   }

   input GitPushInput {
     worktreePath: String!
     remote: String
     branch: String
     force: Boolean
   }

   input GitPullInput {
     worktreePath: String!
     remote: String
     branch: String
     rebase: Boolean
   }
   ```

7. `[server]` Add script input to `script.graphql`:
   ```graphql
   input ScriptRunInput {
     commands: [String!]!
     cwd: String!
     worktreeId: ID!
   }
   ```

---

## Session 14: SDL Types — Results

**Goal:** Define all result wrapper types used by resolvers.

**Definition of Done:** All result types defined, covering success/error patterns.

**Tasks:**

1. `[server]` Create `src/server/schema/types/results.graphql` with ALL result types:
   ```graphql
   # Common
   type SuccessResult {
     success: Boolean!
     error: String
   }

   type WorktreeCreateResult {
     success: Boolean!
     worktree: Worktree
     error: String
   }

   # OpenCode Results
   type OpenCodeConnectResult {
     success: Boolean!
     sessionId: String
     error: String
   }

   type OpenCodeReconnectResult {
     success: Boolean!
     sessionStatus: String
     revertMessageID: String
     error: String
   }

   type OpenCodeMessagesResult {
     success: Boolean!
     messages: JSON
     error: String
   }

   type OpenCodeModelsResult {
     success: Boolean!
     providers: JSON
     error: String
   }

   type OpenCodeModelInfoResult {
     success: Boolean!
     model: JSON
     error: String
   }

   type OpenCodeSessionInfoResult {
     success: Boolean!
     revertMessageID: String
     revertDiff: String
     error: String
   }

   type OpenCodeUndoResult {
     success: Boolean!
     revertMessageID: String
     restoredPrompt: String
     revertDiff: String
     error: String
   }

   type OpenCodeRedoResult {
     success: Boolean!
     revertMessageID: String
     error: String
   }

   type OpenCodeCommandsResult {
     success: Boolean!
     commands: [OpenCodeCommand!]!
     error: String
   }

   type OpenCodeCapabilitiesResult {
     success: Boolean!
     capabilities: OpenCodeCapabilities
     error: String
   }

   type OpenCodePermissionListResult {
     success: Boolean!
     permissions: [PermissionRequest!]!
     error: String
   }

   type OpenCodeForkResult {
     success: Boolean!
     sessionId: String
     error: String
   }

   # Git Results
   type GitFileStatusesResult {
     success: Boolean!
     files: [GitFileStatus!]
     error: String
   }

   type GitDiffResult {
     success: Boolean!
     diff: String
     fileName: String
     error: String
   }

   type GitDiffStatResult {
     success: Boolean!
     files: [GitDiffStatFile!]
     error: String
   }

   type GitFileContentResult {
     success: Boolean!
     content: String
     error: String
   }

   type GitRefContentResult {
     success: Boolean!
     content: String
     error: String
   }

   type GitBranchInfoResult {
     success: Boolean!
     branch: GitBranchInfo
     error: String
   }

   type GitBranchesResult {
     success: Boolean!
     branches: [String!]
     currentBranch: String
     error: String
   }

   type GitBranchesWithStatusResult {
     success: Boolean!
     branches: [GitBranchWithStatus!]
     error: String
   }

   type GitIsMergedResult {
     success: Boolean!
     isMerged: Boolean!
   }

   type GitRemoteUrlResult {
     success: Boolean!
     url: String
     remote: String
     error: String
   }

   type GitPRListResult {
     success: Boolean!
     prs: [GitPR!]
     error: String
   }

   type GitCommitResult {
     success: Boolean!
     commitHash: String
     error: String
   }

   type GitMergeResult {
     success: Boolean!
     error: String
     conflicts: [String!]
   }

   # File Results
   type FileTreeScanResult {
     success: Boolean!
     tree: [FileTreeNode!]
     error: String
   }

   type FileTreeScanFlatResult {
     success: Boolean!
     files: [FlatFile!]
     error: String
   }

   type FileTreeChildrenResult {
     success: Boolean!
     children: [FileTreeNode!]
     error: String
   }

   type FileReadResult {
     success: Boolean!
     content: String
     error: String
   }

   # Project Results
   type ProjectValidateResult {
     success: Boolean!
     path: String
     name: String
     error: String
   }

   # Terminal Results
   type TerminalCreateResult {
     success: Boolean!
     cols: Int
     rows: Int
     error: String
   }

   # Script Results
   type ScriptRunResult {
     success: Boolean!
     pid: Int
     error: String
   }

   type ScriptArchiveResult {
     success: Boolean!
     output: String
     error: String
   }

   # Connection Results
   type ConnectionCreateResult {
     success: Boolean!
     connection: ConnectionWithMembers
     error: String
   }

   type ConnectionAddMemberResult {
     success: Boolean!
     member: JSON
     error: String
   }

   type ConnectionRemoveMemberResult {
     success: Boolean!
     connectionDeleted: Boolean
     error: String
   }

   # Subscription Events
   type WorktreeBranchRenamedEvent {
     worktreeId: ID!
     newBranch: String!
   }
   ```

---

## Session 15: SDL Root — Query

**Goal:** Write the complete Query type in the root schema file.

**Definition of Done:** `schema.graphql` contains all ~55 Query fields exactly matching the PRD.

**Tasks:**

1. `[server]` Create `src/server/schema/schema.graphql` with `type Query` containing ALL fields grouped by domain with comments. The complete list of query fields is:

   **Projects (3):** `projects: [Project!]!`, `project(id: ID!): Project`, `projectByPath(path: String!): Project`

   **Worktrees (5):** `worktree(id: ID!): Worktree`, `worktreesByProject(projectId: ID!): [Worktree!]!`, `activeWorktreesByProject(projectId: ID!): [Worktree!]!`, `worktreeExists(worktreePath: String!): Boolean!`, `worktreeHasCommits(projectPath: String!): Boolean!`

   **Sessions (9):** `session(id: ID!): Session`, `sessionsByWorktree(worktreeId: ID!): [Session!]!`, `activeSessionsByWorktree(worktreeId: ID!): [Session!]!`, `sessionsByProject(projectId: ID!): [Session!]!`, `sessionsByConnection(connectionId: ID!): [Session!]!`, `activeSessionsByConnection(connectionId: ID!): [Session!]!`, `searchSessions(input: SessionSearchInput!): [SessionWithWorktree!]!`, `sessionDraft(sessionId: ID!): String`

   **Spaces (3):** `spaces: [Space!]!`, `spaceProjectIds(spaceId: ID!): [ID!]!`, `allSpaceAssignments: [ProjectSpaceAssignment!]!`

   **Settings (2):** `setting(key: String!): String`, `allSettings: [SettingEntry!]!`

   **AI Operations (7):** `opencodeMessages(worktreePath: String!, sessionId: String!): OpenCodeMessagesResult!`, `opencodeModels(agentSdk: AgentSdk): OpenCodeModelsResult!`, `opencodeModelInfo(worktreePath: String!, modelId: String!, agentSdk: AgentSdk): OpenCodeModelInfoResult!`, `opencodeSessionInfo(worktreePath: String!, sessionId: String!): OpenCodeSessionInfoResult!`, `opencodeCommands(worktreePath: String!, sessionId: String): OpenCodeCommandsResult!`, `opencodeCapabilities(sessionId: String): OpenCodeCapabilitiesResult!`, `opencodePermissionList(worktreePath: String): OpenCodePermissionListResult!`

   **Git (12):** `gitFileStatuses(worktreePath: String!): GitFileStatusesResult!`, `gitDiff(input: GitDiffInput!): GitDiffResult!`, `gitDiffStat(worktreePath: String!): GitDiffStatResult!`, `gitFileContent(worktreePath: String!, filePath: String!): GitFileContentResult!`, `gitRefContent(worktreePath: String!, ref: String!, filePath: String!): GitRefContentResult!`, `gitBranchInfo(worktreePath: String!): GitBranchInfoResult!`, `gitBranches(projectPath: String!): GitBranchesResult!`, `gitBranchExists(projectPath: String!, branchName: String!): Boolean!`, `gitBranchesWithStatus(projectPath: String!): GitBranchesWithStatusResult!`, `gitIsBranchMerged(worktreePath: String!, branch: String!): GitIsMergedResult!`, `gitRemoteUrl(worktreePath: String!, remote: String): GitRemoteUrlResult!`, `gitListPRs(projectPath: String!): GitPRListResult!`

   **File Tree (3):** `fileTreeScan(dirPath: String!): FileTreeScanResult!`, `fileTreeScanFlat(dirPath: String!): FileTreeScanFlatResult!`, `fileTreeLoadChildren(dirPath: String!, rootPath: String!): FileTreeChildrenResult!`

   **File (2):** `fileRead(filePath: String!): FileReadResult!`, `fileReadPrompt(promptName: String!): FileReadResult!`

   **Connection (2):** `connections: [ConnectionWithMembers!]!`, `connection(connectionId: ID!): ConnectionWithMembers`

   **Project Ops (5):** `projectValidate(path: String!): ProjectValidateResult!`, `projectIsGitRepository(path: String!): Boolean!`, `projectDetectLanguage(projectPath: String!): String`, `projectLanguageIcons: JSON!`, `projectIconPath(filename: String!): String`

   **Settings Ops (2):** `detectedEditors: [DetectedApp!]!`, `detectedTerminals: [DetectedApp!]!`

   **System (5):** `systemLogDir: String!`, `systemAppVersion: String!`, `systemAppPaths: AppPaths!`, `systemDetectAgentSdks: AgentSdkDetection!`, `systemServerStatus: ServerStatus!`

   **Script (1):** `scriptPort(cwd: String!): Int`

   **DB Utility (1):** `dbSchemaVersion: Int!`

---

## Session 16: SDL Root — Mutation

**Goal:** Write the complete Mutation type.

**Definition of Done:** All ~80 Mutation fields defined matching the PRD.

**Tasks:**

1. `[server]` Add `type Mutation` to `schema.graphql` containing ALL fields grouped by domain:

   **Projects (5):** createProject, updateProject, deleteProject, touchProject, reorderProjects

   **Worktrees (11):** createWorktree, deleteWorktree, syncWorktrees, duplicateWorktree, renameWorktreeBranch, createWorktreeFromBranch, updateWorktree, archiveWorktree, touchWorktree, appendWorktreeSessionTitle, updateWorktreeModel

   **Sessions (4):** createSession, updateSession, deleteSession, updateSessionDraft

   **Spaces (6):** createSpace, updateSpace, deleteSpace, assignProjectToSpace, removeProjectFromSpace, reorderSpaces

   **Settings (2):** setSetting, deleteSetting

   **AI Operations (16):** opencodeConnect, opencodeReconnect, opencodeDisconnect, opencodePrompt, opencodeAbort, opencodeSetModel, opencodeUndo, opencodeRedo, opencodeCommand, opcodeRenameSession, opencodeFork, opencodeQuestionReply, opencodeQuestionReject, opencodePlanApprove, opencodePlanReject, opencodePermissionReply

   **Git (19):** gitStageFile, gitUnstageFile, gitStageAll, gitUnstageAll, gitStageHunk, gitUnstageHunk, gitRevertHunk, gitDiscardChanges, gitAddToGitignore, gitCommit, gitPush, gitPull, gitMerge, gitDeleteBranch, gitPrMerge, gitWatchWorktree, gitUnwatchWorktree, gitWatchBranch, gitUnwatchBranch

   **File Tree (2):** fileTreeWatch, fileTreeUnwatch

   **File (1):** fileWrite

   **Script (4):** scriptRunSetup, scriptRunProject, scriptKill, scriptRunArchive

   **Terminal (4):** terminalCreate, terminalWrite, terminalResize, terminalDestroy

   **Connection (6):** createConnection, deleteConnection, renameConnection, addConnectionMember, removeConnectionMember, removeWorktreeFromAllConnections

   **Project Ops (3):** projectInitRepository, projectUploadIcon, projectRemoveIcon

   **Logging (2):** createResponseLog, appendResponseLog

   **System (2):** systemKillSwitch, systemRegisterPushToken

   Each mutation field must have the correct input types and return types matching the PRD and the result types defined in Session 14.

---

## Session 17: SDL Root — Subscription

**Goal:** Write the complete Subscription type.

**Definition of Done:** All 8 Subscription fields defined.

**Tasks:**

1. `[server]` Add `type Subscription` to `schema.graphql`:
   ```graphql
   type Subscription {
     # AI streaming (core subscription)
     opencodeStream(sessionIds: [String!]): OpenCodeStreamEvent!

     # Git status changes
     gitStatusChanged(worktreePath: String): GitStatusChangedEvent!
     gitBranchChanged(worktreePath: String): GitBranchChangedEvent!

     # File tree changes
     fileTreeChange(worktreePath: String): FileTreeChangeEvent!

     # Terminal I/O
     terminalData(worktreeId: ID!): TerminalDataEvent!
     terminalExit(worktreeId: ID!): TerminalExitEvent!

     # Script output
     scriptOutput(worktreeId: ID!, channel: String!): ScriptOutputEvent!

     # Worktree events
     worktreeBranchRenamed: WorktreeBranchRenamedEvent!
   }
   ```

---

## Session 18: Codegen Setup

**Goal:** Configure graphql-codegen to generate TypeScript resolver types from the SDL.

**Definition of Done:** `pnpm codegen` generates `src/server/__generated__/resolvers-types.ts`, types importable.

**Tasks:**

1. `[server]` Create `src/shared/codegen.ts` (or `codegen.ts` at project root):
   ```typescript
   import type { CodegenConfig } from '@graphql-codegen/cli'

   const config: CodegenConfig = {
     schema: 'src/server/schema/**/*.graphql',
     generates: {
       'src/server/__generated__/resolvers-types.ts': {
         plugins: ['typescript', 'typescript-resolvers'],
         config: {
           contextType: '../context#GraphQLContext',
           mappers: {},
           useIndexSignature: true,
           enumsAsTypes: true,
           scalars: {
             JSON: 'unknown'
           }
         }
       }
     }
   }

   export default config
   ```

2. `[server]` Add script to `package.json`:
   ```json
   "codegen": "graphql-codegen --config src/shared/codegen.ts"
   ```

3. `[server]` Run `pnpm codegen` — verify it generates the resolvers-types.ts file with no errors.
4. `[server]` Verify the generated types compile: `pnpm build`
5. `[server]` Run `pnpm test` — zero regressions.

**Verification:**
```bash
pnpm codegen && pnpm build && pnpm test
```

---

## Summary of Files Created

```
src/server/schema/
  schema.graphql                  — Root Query, Mutation, Subscription types
  types/
    project.graphql               — Project, Worktree, Session, Space types + enums + inputs
    connection.graphql            — Connection types + inputs
    git.graphql                   — Git types + inputs
    opencode.graphql              — OpenCode types + inputs + JSON scalar
    file-tree.graphql             — FileTree types
    script.graphql                — Script types + inputs
    terminal.graphql              — Terminal event types
    settings.graphql              — Settings types
    system.graphql                — System types
    results.graphql               — ALL result wrapper types

src/shared/
  codegen.ts                      — graphql-codegen configuration

src/server/__generated__/
  resolvers-types.ts              — Auto-generated TypeScript types
```

## Summary of Files Modified

| File | Change |
|------|--------|
| `package.json` | Add `"codegen"` script |

## What Comes Next

Phase 3 (Server Core) will create the GraphQL server entry point, context factory, auth plugins, TLS cert generation, config loader, and the headless CLI flag handling in `src/main/index.ts`.
