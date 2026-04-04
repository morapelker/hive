import { GraphQLResolveInfo, GraphQLScalarType, GraphQLScalarTypeConfig } from 'graphql';
import { GraphQLContext } from '../context';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  JSON: { input: unknown; output: unknown; }
};

export type AgentSdk =
  | 'claude_code'
  | 'codex'
  | 'opencode'
  | 'terminal';

export type AgentSdkDetection = {
  __typename?: 'AgentSdkDetection';
  claude: Scalars['Boolean']['output'];
  codex: Scalars['Boolean']['output'];
  opencode: Scalars['Boolean']['output'];
};

export type AppPaths = {
  __typename?: 'AppPaths';
  home: Scalars['String']['output'];
  logs: Scalars['String']['output'];
  userData: Scalars['String']['output'];
};

export type Attachment = {
  __typename?: 'Attachment';
  id: Scalars['String']['output'];
  label: Scalars['String']['output'];
  type: Scalars['String']['output'];
  url: Scalars['String']['output'];
};

export type AttachmentInput = {
  label: Scalars['String']['input'];
  type: Scalars['String']['input'];
  url: Scalars['String']['input'];
};

export type AuthResult = {
  __typename?: 'AuthResult';
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type CommandApprovalReplyInput = {
  approved: Scalars['Boolean']['input'];
  hiveSessionId: Scalars['String']['input'];
  requestId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};

export type Connection = {
  __typename?: 'Connection';
  color?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  path: Scalars['String']['output'];
  status: Scalars['String']['output'];
  updatedAt: Scalars['String']['output'];
};

export type ConnectionAddMemberResult = {
  __typename?: 'ConnectionAddMemberResult';
  error?: Maybe<Scalars['String']['output']>;
  member?: Maybe<Scalars['JSON']['output']>;
  success: Scalars['Boolean']['output'];
};

export type ConnectionCreateResult = {
  __typename?: 'ConnectionCreateResult';
  connection?: Maybe<ConnectionWithMembers>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type ConnectionMember = {
  __typename?: 'ConnectionMember';
  addedAt: Scalars['String']['output'];
  connectionId: Scalars['ID']['output'];
  id: Scalars['ID']['output'];
  projectId: Scalars['ID']['output'];
  symlinkName: Scalars['String']['output'];
  worktreeId: Scalars['ID']['output'];
};

export type ConnectionMemberWithDetails = {
  __typename?: 'ConnectionMemberWithDetails';
  addedAt: Scalars['String']['output'];
  connectionId: Scalars['ID']['output'];
  id: Scalars['ID']['output'];
  projectId: Scalars['ID']['output'];
  projectName: Scalars['String']['output'];
  symlinkName: Scalars['String']['output'];
  worktreeBranch: Scalars['String']['output'];
  worktreeId: Scalars['ID']['output'];
  worktreeName: Scalars['String']['output'];
  worktreePath: Scalars['String']['output'];
};

export type ConnectionRemoveMemberResult = {
  __typename?: 'ConnectionRemoveMemberResult';
  connectionDeleted?: Maybe<Scalars['Boolean']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type ConnectionWithMembers = {
  __typename?: 'ConnectionWithMembers';
  color?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  members: Array<ConnectionMemberWithDetails>;
  name: Scalars['String']['output'];
  path: Scalars['String']['output'];
  status: Scalars['String']['output'];
  updatedAt: Scalars['String']['output'];
};

export type CreateFromBranchInput = {
  branchName: Scalars['String']['input'];
  nameHint?: InputMaybe<Scalars['String']['input']>;
  prNumber?: InputMaybe<Scalars['Int']['input']>;
  projectId: Scalars['ID']['input'];
  projectName: Scalars['String']['input'];
  projectPath: Scalars['String']['input'];
};

export type CreateProjectInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  path: Scalars['String']['input'];
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type CreateSessionInput = {
  agentSdk?: InputMaybe<AgentSdk>;
  connectionId?: InputMaybe<Scalars['ID']['input']>;
  modelId?: InputMaybe<Scalars['String']['input']>;
  modelProviderId?: InputMaybe<Scalars['String']['input']>;
  modelVariant?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  opencodeSessionId?: InputMaybe<Scalars['String']['input']>;
  projectId: Scalars['ID']['input'];
  worktreeId?: InputMaybe<Scalars['ID']['input']>;
};

export type CreateSpaceInput = {
  iconType?: InputMaybe<Scalars['String']['input']>;
  iconValue?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
};

export type CreateWorktreeInput = {
  projectId: Scalars['ID']['input'];
  projectName: Scalars['String']['input'];
  projectPath: Scalars['String']['input'];
};

export type DeleteWorktreeInput = {
  archive: Scalars['Boolean']['input'];
  branchName: Scalars['String']['input'];
  projectPath: Scalars['String']['input'];
  worktreeId: Scalars['ID']['input'];
  worktreePath: Scalars['String']['input'];
};

export type DetectRepoResult = {
  __typename?: 'DetectRepoResult';
  repo?: Maybe<Scalars['String']['output']>;
};

export type DetectedApp = {
  __typename?: 'DetectedApp';
  available: Scalars['Boolean']['output'];
  command: Scalars['String']['output'];
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type DuplicateWorktreeInput = {
  projectId: Scalars['ID']['input'];
  projectName: Scalars['String']['input'];
  projectPath: Scalars['String']['input'];
  sourceBranch: Scalars['String']['input'];
  sourceWorktreePath: Scalars['String']['input'];
};

export type FileReadImageResult = {
  __typename?: 'FileReadImageResult';
  content?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  mimeType?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type FileReadResult = {
  __typename?: 'FileReadResult';
  content?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type FileTreeChangeEvent = {
  __typename?: 'FileTreeChangeEvent';
  changedPath: Scalars['String']['output'];
  eventType: Scalars['String']['output'];
  relativePath: Scalars['String']['output'];
  worktreePath: Scalars['String']['output'];
};

export type FileTreeChildrenResult = {
  __typename?: 'FileTreeChildrenResult';
  children?: Maybe<Array<FileTreeNode>>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type FileTreeNode = {
  __typename?: 'FileTreeNode';
  children?: Maybe<Array<FileTreeNode>>;
  extension?: Maybe<Scalars['String']['output']>;
  isDirectory: Scalars['Boolean']['output'];
  isSymlink?: Maybe<Scalars['Boolean']['output']>;
  name: Scalars['String']['output'];
  path: Scalars['String']['output'];
  relativePath: Scalars['String']['output'];
};

export type FileTreeScanFlatResult = {
  __typename?: 'FileTreeScanFlatResult';
  error?: Maybe<Scalars['String']['output']>;
  files?: Maybe<Array<FlatFile>>;
  success: Scalars['Boolean']['output'];
};

export type FileTreeScanResult = {
  __typename?: 'FileTreeScanResult';
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
  tree?: Maybe<Array<FileTreeNode>>;
};

export type FlatFile = {
  __typename?: 'FlatFile';
  extension?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  path: Scalars['String']['output'];
  relativePath: Scalars['String']['output'];
};

export type ForkSessionInput = {
  messageId?: InputMaybe<Scalars['String']['input']>;
  opencodeSessionId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};

export type GitBranchChangedEvent = {
  __typename?: 'GitBranchChangedEvent';
  worktreePath: Scalars['String']['output'];
};

export type GitBranchDiffFile = {
  __typename?: 'GitBranchDiffFile';
  path: Scalars['String']['output'];
  status: Scalars['String']['output'];
};

export type GitBranchDiffFilesResult = {
  __typename?: 'GitBranchDiffFilesResult';
  error?: Maybe<Scalars['String']['output']>;
  files?: Maybe<Array<GitBranchDiffFile>>;
  success: Scalars['Boolean']['output'];
};

export type GitBranchFileDiffResult = {
  __typename?: 'GitBranchFileDiffResult';
  diff?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitBranchInfo = {
  __typename?: 'GitBranchInfo';
  ahead: Scalars['Int']['output'];
  behind: Scalars['Int']['output'];
  name: Scalars['String']['output'];
  tracking?: Maybe<Scalars['String']['output']>;
};

export type GitBranchInfoResult = {
  __typename?: 'GitBranchInfoResult';
  branch?: Maybe<GitBranchInfo>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitBranchWithStatus = {
  __typename?: 'GitBranchWithStatus';
  isCheckedOut: Scalars['Boolean']['output'];
  isRemote: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  worktreePath?: Maybe<Scalars['String']['output']>;
};

export type GitBranchesResult = {
  __typename?: 'GitBranchesResult';
  branches?: Maybe<Array<Scalars['String']['output']>>;
  currentBranch?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitBranchesWithStatusResult = {
  __typename?: 'GitBranchesWithStatusResult';
  branches?: Maybe<Array<GitBranchWithStatus>>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitCommitResult = {
  __typename?: 'GitCommitResult';
  commitHash?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitDiffInput = {
  contextLines?: InputMaybe<Scalars['Int']['input']>;
  filePath: Scalars['String']['input'];
  isUntracked: Scalars['Boolean']['input'];
  staged: Scalars['Boolean']['input'];
  worktreePath: Scalars['String']['input'];
};

export type GitDiffResult = {
  __typename?: 'GitDiffResult';
  diff?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  fileName?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitDiffStatFile = {
  __typename?: 'GitDiffStatFile';
  additions: Scalars['Int']['output'];
  binary: Scalars['Boolean']['output'];
  deletions: Scalars['Int']['output'];
  path: Scalars['String']['output'];
};

export type GitDiffStatResult = {
  __typename?: 'GitDiffStatResult';
  error?: Maybe<Scalars['String']['output']>;
  files?: Maybe<Array<GitDiffStatFile>>;
  success: Scalars['Boolean']['output'];
};

export type GitFileContentBase64Result = {
  __typename?: 'GitFileContentBase64Result';
  content?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  mimeType?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitFileContentResult = {
  __typename?: 'GitFileContentResult';
  content?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitFileStatus = {
  __typename?: 'GitFileStatus';
  path: Scalars['String']['output'];
  relativePath: Scalars['String']['output'];
  staged: Scalars['Boolean']['output'];
  status: Scalars['String']['output'];
};

export type GitFileStatusesResult = {
  __typename?: 'GitFileStatusesResult';
  error?: Maybe<Scalars['String']['output']>;
  files?: Maybe<Array<GitFileStatus>>;
  success: Scalars['Boolean']['output'];
};

export type GitIsMergedResult = {
  __typename?: 'GitIsMergedResult';
  isMerged: Scalars['Boolean']['output'];
  success: Scalars['Boolean']['output'];
};

export type GitMergeResult = {
  __typename?: 'GitMergeResult';
  conflicts?: Maybe<Array<Scalars['String']['output']>>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitPr = {
  __typename?: 'GitPR';
  author: Scalars['String']['output'];
  headRefName: Scalars['String']['output'];
  number: Scalars['Int']['output'];
  title: Scalars['String']['output'];
};

export type GitPrListResult = {
  __typename?: 'GitPRListResult';
  error?: Maybe<Scalars['String']['output']>;
  prs?: Maybe<Array<GitPr>>;
  success: Scalars['Boolean']['output'];
};

export type GitPrReviewCommentsResult = {
  __typename?: 'GitPRReviewCommentsResult';
  comments?: Maybe<Array<PrReviewComment>>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitPrStateResult = {
  __typename?: 'GitPRStateResult';
  error?: Maybe<Scalars['String']['output']>;
  merged?: Maybe<Scalars['Boolean']['output']>;
  state?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitPullInput = {
  branch?: InputMaybe<Scalars['String']['input']>;
  rebase?: InputMaybe<Scalars['Boolean']['input']>;
  remote?: InputMaybe<Scalars['String']['input']>;
  worktreePath: Scalars['String']['input'];
};

export type GitPushInput = {
  branch?: InputMaybe<Scalars['String']['input']>;
  force?: InputMaybe<Scalars['Boolean']['input']>;
  remote?: InputMaybe<Scalars['String']['input']>;
  worktreePath: Scalars['String']['input'];
};

export type GitRefContentResult = {
  __typename?: 'GitRefContentResult';
  content?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type GitRemoteUrlResult = {
  __typename?: 'GitRemoteUrlResult';
  error?: Maybe<Scalars['String']['output']>;
  remote?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
  url?: Maybe<Scalars['String']['output']>;
};

export type GitStatusChangedEvent = {
  __typename?: 'GitStatusChangedEvent';
  worktreePath: Scalars['String']['output'];
};

export type ImportIssueInput = {
  body?: InputMaybe<Scalars['String']['input']>;
  externalId: Scalars['String']['input'];
  state: Scalars['String']['input'];
  title: Scalars['String']['input'];
  url: Scalars['String']['input'];
};

export type ImportIssuesInput = {
  issues: Array<ImportIssueInput>;
  projectId: Scalars['String']['input'];
  providerId: Scalars['String']['input'];
  repo: Scalars['String']['input'];
};

export type ImportResult = {
  __typename?: 'ImportResult';
  imported: Array<Scalars['String']['output']>;
  skipped: Array<Scalars['String']['output']>;
};

export type KanbanCreateTicketInput = {
  column: KanbanTicketColumn;
  description?: InputMaybe<Scalars['String']['input']>;
  externalId?: InputMaybe<Scalars['String']['input']>;
  externalProvider?: InputMaybe<Scalars['String']['input']>;
  externalUrl?: InputMaybe<Scalars['String']['input']>;
  projectId: Scalars['String']['input'];
  sessionId?: InputMaybe<Scalars['String']['input']>;
  sortOrder?: InputMaybe<Scalars['Float']['input']>;
  title: Scalars['String']['input'];
  worktreeId?: InputMaybe<Scalars['String']['input']>;
};

export type KanbanTicket = {
  __typename?: 'KanbanTicket';
  archived: Scalars['Boolean']['output'];
  column: KanbanTicketColumn;
  createdAt: Scalars['String']['output'];
  description?: Maybe<Scalars['String']['output']>;
  externalId?: Maybe<Scalars['String']['output']>;
  externalProvider?: Maybe<Scalars['String']['output']>;
  externalUrl?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  projectId: Scalars['String']['output'];
  sessionId?: Maybe<Scalars['String']['output']>;
  sortOrder: Scalars['Float']['output'];
  title: Scalars['String']['output'];
  totalTokens: Scalars['Int']['output'];
  updatedAt: Scalars['String']['output'];
  worktreeId?: Maybe<Scalars['String']['output']>;
};

export type KanbanTicketColumn =
  | 'done'
  | 'in_progress'
  | 'review'
  | 'todo';

export type KanbanUpdateTicketInput = {
  column?: InputMaybe<KanbanTicketColumn>;
  description?: InputMaybe<Scalars['String']['input']>;
  sessionId?: InputMaybe<Scalars['String']['input']>;
  sortOrder?: InputMaybe<Scalars['Float']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
  worktreeId?: InputMaybe<Scalars['String']['input']>;
};

export type ListIssuesInput = {
  page: Scalars['Int']['input'];
  perPage: Scalars['Int']['input'];
  providerId: Scalars['String']['input'];
  repo: Scalars['String']['input'];
  search?: InputMaybe<Scalars['String']['input']>;
  state: Scalars['String']['input'];
};

export type MessagePartInput = {
  filename?: InputMaybe<Scalars['String']['input']>;
  mime?: InputMaybe<Scalars['String']['input']>;
  text?: InputMaybe<Scalars['String']['input']>;
  type: Scalars['String']['input'];
  url?: InputMaybe<Scalars['String']['input']>;
};

export type ModelInput = {
  modelID: Scalars['String']['input'];
  providerID: Scalars['String']['input'];
  variant?: InputMaybe<Scalars['String']['input']>;
};

export type Mutation = {
  __typename?: 'Mutation';
  addConnectionMember: ConnectionAddMemberResult;
  appendResponseLog: Scalars['Boolean']['output'];
  appendWorktreeSessionTitle: SuccessResult;
  archiveWorktree?: Maybe<Worktree>;
  assignProjectToSpace: Scalars['Boolean']['output'];
  createConnection: ConnectionCreateResult;
  createProject: Project;
  createResponseLog: Scalars['String']['output'];
  createSession: Session;
  createSpace: Space;
  createWorktree: WorktreeCreateResult;
  createWorktreeFromBranch: WorktreeCreateResult;
  deleteConnection: SuccessResult;
  deleteProject: Scalars['Boolean']['output'];
  deleteSession: Scalars['Boolean']['output'];
  deleteSetting: Scalars['Boolean']['output'];
  deleteSpace: Scalars['Boolean']['output'];
  deleteWorktree: SuccessResult;
  duplicateWorktree: WorktreeCreateResult;
  fileTreeUnwatch: SuccessResult;
  fileTreeWatch: SuccessResult;
  fileWrite: SuccessResult;
  gitAddToGitignore: SuccessResult;
  gitCommit: GitCommitResult;
  gitDeleteBranch: SuccessResult;
  gitDiscardChanges: SuccessResult;
  gitMerge: GitMergeResult;
  gitPrMerge: SuccessResult;
  gitPull: SuccessResult;
  gitPush: SuccessResult;
  gitRevertHunk: SuccessResult;
  gitStageAll: SuccessResult;
  gitStageFile: SuccessResult;
  gitStageHunk: SuccessResult;
  gitUnstageAll: SuccessResult;
  gitUnstageFile: SuccessResult;
  gitUnstageHunk: SuccessResult;
  gitUnwatchBranch: SuccessResult;
  gitUnwatchWorktree: SuccessResult;
  gitWatchBranch: SuccessResult;
  gitWatchWorktree: SuccessResult;
  kanbanAddTicketTokens?: Maybe<KanbanTicket>;
  kanbanArchiveAllDone: SuccessResult;
  kanbanArchiveTicket?: Maybe<KanbanTicket>;
  kanbanCreateTicket: KanbanTicket;
  kanbanDeleteTicket: SuccessResult;
  kanbanMoveTicket?: Maybe<KanbanTicket>;
  kanbanReorderTicket: SuccessResult;
  kanbanToggleSimpleMode: SuccessResult;
  kanbanUnarchiveTicket?: Maybe<KanbanTicket>;
  kanbanUpdateTicket?: Maybe<KanbanTicket>;
  opencodeAbort: SuccessResult;
  opencodeCommand: SuccessResult;
  opencodeCommandApprovalReply: SuccessResult;
  opencodeConnect: OpenCodeConnectResult;
  opencodeDisconnect: SuccessResult;
  opencodeFork: OpenCodeForkResult;
  opencodePermissionReply: SuccessResult;
  opencodePlanApprove: SuccessResult;
  opencodePlanReject: SuccessResult;
  opencodePrompt: SuccessResult;
  opencodeQuestionReject: SuccessResult;
  opencodeQuestionReply: SuccessResult;
  opencodeReconnect: OpenCodeReconnectResult;
  opencodeRedo: OpenCodeRedoResult;
  opencodeRenameSession: SuccessResult;
  opencodeSetModel: SuccessResult;
  opencodeUndo: OpenCodeUndoResult;
  projectInitRepository: SuccessResult;
  projectRemoveIcon: SuccessResult;
  projectUploadIcon: SuccessResult;
  removeConnectionMember: ConnectionRemoveMemberResult;
  removeProjectFromSpace: Scalars['Boolean']['output'];
  removeWorktreeFromAllConnections: SuccessResult;
  renameConnection?: Maybe<ConnectionWithMembers>;
  renameWorktreeBranch: SuccessResult;
  reorderProjects: Scalars['Boolean']['output'];
  reorderSpaces: Scalars['Boolean']['output'];
  scriptKill: SuccessResult;
  scriptRunArchive: ScriptArchiveResult;
  scriptRunProject: ScriptRunResult;
  scriptRunSetup: SuccessResult;
  setSetting: Scalars['Boolean']['output'];
  syncWorktrees: SuccessResult;
  systemKillSwitch: Scalars['Boolean']['output'];
  systemRegisterPushToken: Scalars['Boolean']['output'];
  terminalCreate: TerminalCreateResult;
  terminalDestroy: Scalars['Boolean']['output'];
  terminalResize: Scalars['Boolean']['output'];
  terminalWrite: Scalars['Boolean']['output'];
  ticketImportAuthenticate: AuthResult;
  ticketImportIssues: ImportResult;
  ticketImportUpdateRemoteStatus: AuthResult;
  touchProject: Scalars['Boolean']['output'];
  touchWorktree: Scalars['Boolean']['output'];
  updateProject?: Maybe<Project>;
  updateSession?: Maybe<Session>;
  updateSessionDraft: Scalars['Boolean']['output'];
  updateSpace?: Maybe<Space>;
  updateWorktree?: Maybe<Worktree>;
  updateWorktreeModel: SuccessResult;
  worktreeAddAttachment: SuccessResult;
  worktreeAttachPR: SuccessResult;
  worktreeDetachPR: SuccessResult;
  worktreeRemoveAttachment: SuccessResult;
  worktreeSetPinned: SuccessResult;
};


export type MutationAddConnectionMemberArgs = {
  connectionId: Scalars['ID']['input'];
  worktreeId: Scalars['ID']['input'];
};


export type MutationAppendResponseLogArgs = {
  data: Scalars['JSON']['input'];
  filePath: Scalars['String']['input'];
};


export type MutationAppendWorktreeSessionTitleArgs = {
  title: Scalars['String']['input'];
  worktreeId: Scalars['ID']['input'];
};


export type MutationArchiveWorktreeArgs = {
  id: Scalars['ID']['input'];
};


export type MutationAssignProjectToSpaceArgs = {
  projectId: Scalars['ID']['input'];
  spaceId: Scalars['ID']['input'];
};


export type MutationCreateConnectionArgs = {
  worktreeIds: Array<Scalars['ID']['input']>;
};


export type MutationCreateProjectArgs = {
  input: CreateProjectInput;
};


export type MutationCreateResponseLogArgs = {
  sessionId: Scalars['ID']['input'];
};


export type MutationCreateSessionArgs = {
  input: CreateSessionInput;
};


export type MutationCreateSpaceArgs = {
  input: CreateSpaceInput;
};


export type MutationCreateWorktreeArgs = {
  input: CreateWorktreeInput;
};


export type MutationCreateWorktreeFromBranchArgs = {
  input: CreateFromBranchInput;
};


export type MutationDeleteConnectionArgs = {
  connectionId: Scalars['ID']['input'];
};


export type MutationDeleteProjectArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeleteSessionArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeleteSettingArgs = {
  key: Scalars['String']['input'];
};


export type MutationDeleteSpaceArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeleteWorktreeArgs = {
  input: DeleteWorktreeInput;
};


export type MutationDuplicateWorktreeArgs = {
  input: DuplicateWorktreeInput;
};


export type MutationFileTreeUnwatchArgs = {
  worktreePath: Scalars['String']['input'];
};


export type MutationFileTreeWatchArgs = {
  worktreePath: Scalars['String']['input'];
};


export type MutationFileWriteArgs = {
  content: Scalars['String']['input'];
  filePath: Scalars['String']['input'];
};


export type MutationGitAddToGitignoreArgs = {
  pattern: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitCommitArgs = {
  message: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitDeleteBranchArgs = {
  branchName: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitDiscardChangesArgs = {
  filePath: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitMergeArgs = {
  sourceBranch: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitPrMergeArgs = {
  prNumber: Scalars['Int']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitPullArgs = {
  input: GitPullInput;
};


export type MutationGitPushArgs = {
  input: GitPushInput;
};


export type MutationGitRevertHunkArgs = {
  patch: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitStageAllArgs = {
  worktreePath: Scalars['String']['input'];
};


export type MutationGitStageFileArgs = {
  filePath: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitStageHunkArgs = {
  patch: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitUnstageAllArgs = {
  worktreePath: Scalars['String']['input'];
};


export type MutationGitUnstageFileArgs = {
  filePath: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitUnstageHunkArgs = {
  patch: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationGitUnwatchBranchArgs = {
  worktreePath: Scalars['String']['input'];
};


export type MutationGitUnwatchWorktreeArgs = {
  worktreePath: Scalars['String']['input'];
};


export type MutationGitWatchBranchArgs = {
  worktreePath: Scalars['String']['input'];
};


export type MutationGitWatchWorktreeArgs = {
  worktreePath: Scalars['String']['input'];
};


export type MutationKanbanAddTicketTokensArgs = {
  id: Scalars['ID']['input'];
  tokens: Scalars['Int']['input'];
};


export type MutationKanbanArchiveAllDoneArgs = {
  projectId: Scalars['ID']['input'];
};


export type MutationKanbanArchiveTicketArgs = {
  id: Scalars['ID']['input'];
};


export type MutationKanbanCreateTicketArgs = {
  input: KanbanCreateTicketInput;
};


export type MutationKanbanDeleteTicketArgs = {
  id: Scalars['ID']['input'];
};


export type MutationKanbanMoveTicketArgs = {
  column: KanbanTicketColumn;
  id: Scalars['ID']['input'];
  sortOrder: Scalars['Float']['input'];
};


export type MutationKanbanReorderTicketArgs = {
  id: Scalars['ID']['input'];
  sortOrder: Scalars['Float']['input'];
};


export type MutationKanbanToggleSimpleModeArgs = {
  enabled: Scalars['Boolean']['input'];
  projectId: Scalars['ID']['input'];
};


export type MutationKanbanUnarchiveTicketArgs = {
  id: Scalars['ID']['input'];
};


export type MutationKanbanUpdateTicketArgs = {
  id: Scalars['ID']['input'];
  input: KanbanUpdateTicketInput;
};


export type MutationOpencodeAbortArgs = {
  sessionId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationOpencodeCommandArgs = {
  input: OpenCodeCommandInput;
};


export type MutationOpencodeCommandApprovalReplyArgs = {
  input: CommandApprovalReplyInput;
};


export type MutationOpencodeConnectArgs = {
  hiveSessionId: Scalars['ID']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationOpencodeDisconnectArgs = {
  sessionId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationOpencodeForkArgs = {
  input: ForkSessionInput;
};


export type MutationOpencodePermissionReplyArgs = {
  input: PermissionReplyInput;
};


export type MutationOpencodePlanApproveArgs = {
  input: PlanApproveInput;
};


export type MutationOpencodePlanRejectArgs = {
  input: PlanRejectInput;
};


export type MutationOpencodePromptArgs = {
  input: OpenCodePromptInput;
};


export type MutationOpencodeQuestionRejectArgs = {
  requestId: Scalars['String']['input'];
  worktreePath?: InputMaybe<Scalars['String']['input']>;
};


export type MutationOpencodeQuestionReplyArgs = {
  input: QuestionReplyInput;
};


export type MutationOpencodeReconnectArgs = {
  input: OpenCodeReconnectInput;
};


export type MutationOpencodeRedoArgs = {
  sessionId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationOpencodeRenameSessionArgs = {
  input: RenameSessionInput;
};


export type MutationOpencodeSetModelArgs = {
  input: SetModelInput;
};


export type MutationOpencodeUndoArgs = {
  sessionId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type MutationProjectInitRepositoryArgs = {
  path: Scalars['String']['input'];
};


export type MutationProjectRemoveIconArgs = {
  projectId: Scalars['ID']['input'];
};


export type MutationProjectUploadIconArgs = {
  data: Scalars['String']['input'];
  filename: Scalars['String']['input'];
  projectId: Scalars['ID']['input'];
};


export type MutationRemoveConnectionMemberArgs = {
  connectionId: Scalars['ID']['input'];
  worktreeId: Scalars['ID']['input'];
};


export type MutationRemoveProjectFromSpaceArgs = {
  projectId: Scalars['ID']['input'];
  spaceId: Scalars['ID']['input'];
};


export type MutationRemoveWorktreeFromAllConnectionsArgs = {
  worktreeId: Scalars['ID']['input'];
};


export type MutationRenameConnectionArgs = {
  connectionId: Scalars['ID']['input'];
  customName?: InputMaybe<Scalars['String']['input']>;
};


export type MutationRenameWorktreeBranchArgs = {
  input: RenameBranchInput;
};


export type MutationReorderProjectsArgs = {
  orderedIds: Array<Scalars['ID']['input']>;
};


export type MutationReorderSpacesArgs = {
  orderedIds: Array<Scalars['ID']['input']>;
};


export type MutationScriptKillArgs = {
  worktreeId: Scalars['ID']['input'];
};


export type MutationScriptRunArchiveArgs = {
  commands: Array<Scalars['String']['input']>;
  cwd: Scalars['String']['input'];
};


export type MutationScriptRunProjectArgs = {
  input: ScriptRunInput;
};


export type MutationScriptRunSetupArgs = {
  input: ScriptRunInput;
};


export type MutationSetSettingArgs = {
  key: Scalars['String']['input'];
  value: Scalars['String']['input'];
};


export type MutationSyncWorktreesArgs = {
  projectId: Scalars['ID']['input'];
  projectPath: Scalars['String']['input'];
};


export type MutationSystemRegisterPushTokenArgs = {
  platform: Scalars['String']['input'];
  token: Scalars['String']['input'];
};


export type MutationTerminalCreateArgs = {
  cwd: Scalars['String']['input'];
  shell?: InputMaybe<Scalars['String']['input']>;
  worktreeId: Scalars['ID']['input'];
};


export type MutationTerminalDestroyArgs = {
  worktreeId: Scalars['ID']['input'];
};


export type MutationTerminalResizeArgs = {
  cols: Scalars['Int']['input'];
  rows: Scalars['Int']['input'];
  worktreeId: Scalars['ID']['input'];
};


export type MutationTerminalWriteArgs = {
  data: Scalars['String']['input'];
  worktreeId: Scalars['ID']['input'];
};


export type MutationTicketImportAuthenticateArgs = {
  providerId: Scalars['String']['input'];
  settings: Scalars['String']['input'];
};


export type MutationTicketImportIssuesArgs = {
  input: ImportIssuesInput;
};


export type MutationTicketImportUpdateRemoteStatusArgs = {
  input: UpdateRemoteStatusInput;
  settings: Scalars['String']['input'];
};


export type MutationTouchProjectArgs = {
  id: Scalars['ID']['input'];
};


export type MutationTouchWorktreeArgs = {
  id: Scalars['ID']['input'];
};


export type MutationUpdateProjectArgs = {
  id: Scalars['ID']['input'];
  input: UpdateProjectInput;
};


export type MutationUpdateSessionArgs = {
  id: Scalars['ID']['input'];
  input: UpdateSessionInput;
};


export type MutationUpdateSessionDraftArgs = {
  draft?: InputMaybe<Scalars['String']['input']>;
  sessionId: Scalars['ID']['input'];
};


export type MutationUpdateSpaceArgs = {
  id: Scalars['ID']['input'];
  input: UpdateSpaceInput;
};


export type MutationUpdateWorktreeArgs = {
  id: Scalars['ID']['input'];
  input: UpdateWorktreeInput;
};


export type MutationUpdateWorktreeModelArgs = {
  input: UpdateWorktreeModelInput;
};


export type MutationWorktreeAddAttachmentArgs = {
  attachment: AttachmentInput;
  worktreeId: Scalars['ID']['input'];
};


export type MutationWorktreeAttachPrArgs = {
  prNumber: Scalars['Int']['input'];
  prUrl: Scalars['String']['input'];
  worktreeId: Scalars['ID']['input'];
};


export type MutationWorktreeDetachPrArgs = {
  worktreeId: Scalars['ID']['input'];
};


export type MutationWorktreeRemoveAttachmentArgs = {
  attachmentId: Scalars['String']['input'];
  worktreeId: Scalars['ID']['input'];
};


export type MutationWorktreeSetPinnedArgs = {
  pinned: Scalars['Boolean']['input'];
  worktreeId: Scalars['ID']['input'];
};

export type OpenCodeAgent = {
  __typename?: 'OpenCodeAgent';
  description?: Maybe<Scalars['String']['output']>;
  mode: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type OpenCodeAgentsResult = {
  __typename?: 'OpenCodeAgentsResult';
  agents: Array<OpenCodeAgent>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodeCapabilities = {
  __typename?: 'OpenCodeCapabilities';
  supportsCommands: Scalars['Boolean']['output'];
  supportsModelSelection: Scalars['Boolean']['output'];
  supportsPartialStreaming: Scalars['Boolean']['output'];
  supportsPermissionRequests: Scalars['Boolean']['output'];
  supportsQuestionPrompts: Scalars['Boolean']['output'];
  supportsReconnect: Scalars['Boolean']['output'];
  supportsRedo: Scalars['Boolean']['output'];
  supportsUndo: Scalars['Boolean']['output'];
};

export type OpenCodeCapabilitiesResult = {
  __typename?: 'OpenCodeCapabilitiesResult';
  capabilities?: Maybe<OpenCodeCapabilities>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodeCommand = {
  __typename?: 'OpenCodeCommand';
  agent?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  hints?: Maybe<Array<Scalars['String']['output']>>;
  model?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  source?: Maybe<Scalars['String']['output']>;
  subtask?: Maybe<Scalars['Boolean']['output']>;
  template: Scalars['String']['output'];
};

export type OpenCodeCommandInput = {
  args: Scalars['String']['input'];
  command: Scalars['String']['input'];
  model?: InputMaybe<ModelInput>;
  opencodeSessionId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};

export type OpenCodeCommandsResult = {
  __typename?: 'OpenCodeCommandsResult';
  commands: Array<OpenCodeCommand>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodeConnectResult = {
  __typename?: 'OpenCodeConnectResult';
  error?: Maybe<Scalars['String']['output']>;
  sessionId?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodeForkResult = {
  __typename?: 'OpenCodeForkResult';
  error?: Maybe<Scalars['String']['output']>;
  sessionId?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodeMessagesResult = {
  __typename?: 'OpenCodeMessagesResult';
  error?: Maybe<Scalars['String']['output']>;
  messages?: Maybe<Scalars['JSON']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodeModelInfoResult = {
  __typename?: 'OpenCodeModelInfoResult';
  error?: Maybe<Scalars['String']['output']>;
  model?: Maybe<Scalars['JSON']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodeModelsResult = {
  __typename?: 'OpenCodeModelsResult';
  error?: Maybe<Scalars['String']['output']>;
  providers?: Maybe<Scalars['JSON']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodePermissionListResult = {
  __typename?: 'OpenCodePermissionListResult';
  error?: Maybe<Scalars['String']['output']>;
  permissions: Array<PermissionRequest>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodePromptInput = {
  agent?: InputMaybe<Scalars['String']['input']>;
  message?: InputMaybe<Scalars['String']['input']>;
  model?: InputMaybe<ModelInput>;
  opencodeSessionId: Scalars['String']['input'];
  parts?: InputMaybe<Array<MessagePartInput>>;
  worktreePath: Scalars['String']['input'];
};

export type OpenCodeReconnectInput = {
  hiveSessionId: Scalars['ID']['input'];
  opencodeSessionId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};

export type OpenCodeReconnectResult = {
  __typename?: 'OpenCodeReconnectResult';
  error?: Maybe<Scalars['String']['output']>;
  revertMessageID?: Maybe<Scalars['String']['output']>;
  sessionStatus?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodeRedoResult = {
  __typename?: 'OpenCodeRedoResult';
  error?: Maybe<Scalars['String']['output']>;
  revertMessageID?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodeSessionInfoResult = {
  __typename?: 'OpenCodeSessionInfoResult';
  error?: Maybe<Scalars['String']['output']>;
  revertDiff?: Maybe<Scalars['String']['output']>;
  revertMessageID?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type OpenCodeStreamEvent = {
  __typename?: 'OpenCodeStreamEvent';
  childSessionId?: Maybe<Scalars['String']['output']>;
  data: Scalars['JSON']['output'];
  sessionId: Scalars['String']['output'];
  statusPayload?: Maybe<SessionStatusPayload>;
  type: Scalars['String']['output'];
};

export type OpenCodeUndoResult = {
  __typename?: 'OpenCodeUndoResult';
  error?: Maybe<Scalars['String']['output']>;
  restoredPrompt?: Maybe<Scalars['String']['output']>;
  revertDiff?: Maybe<Scalars['String']['output']>;
  revertMessageID?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type PrReviewComment = {
  __typename?: 'PRReviewComment';
  body: Scalars['String']['output'];
  createdAt: Scalars['String']['output'];
  id: Scalars['Int']['output'];
  line?: Maybe<Scalars['Int']['output']>;
  path?: Maybe<Scalars['String']['output']>;
  user: PrReviewUser;
};

export type PrReviewUser = {
  __typename?: 'PRReviewUser';
  login: Scalars['String']['output'];
};

export type PermissionReplyInput = {
  message?: InputMaybe<Scalars['String']['input']>;
  reply: Scalars['String']['input'];
  requestId: Scalars['String']['input'];
  worktreePath?: InputMaybe<Scalars['String']['input']>;
};

export type PermissionRequest = {
  __typename?: 'PermissionRequest';
  always: Array<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  metadata?: Maybe<Scalars['JSON']['output']>;
  patterns: Array<Scalars['String']['output']>;
  permission: Scalars['String']['output'];
  sessionID: Scalars['String']['output'];
  tool?: Maybe<PermissionTool>;
};

export type PermissionTool = {
  __typename?: 'PermissionTool';
  callID: Scalars['String']['output'];
  messageID: Scalars['String']['output'];
};

export type PlanApproveInput = {
  hiveSessionId: Scalars['ID']['input'];
  requestId?: InputMaybe<Scalars['String']['input']>;
  worktreePath: Scalars['String']['input'];
};

export type PlanRejectInput = {
  feedback: Scalars['String']['input'];
  hiveSessionId: Scalars['ID']['input'];
  requestId?: InputMaybe<Scalars['String']['input']>;
  worktreePath: Scalars['String']['input'];
};

export type Project = {
  __typename?: 'Project';
  archiveScript?: Maybe<Scalars['String']['output']>;
  autoAssignPort: Scalars['Boolean']['output'];
  createdAt: Scalars['String']['output'];
  customIcon?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  detectedIcon?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  language?: Maybe<Scalars['String']['output']>;
  lastAccessedAt: Scalars['String']['output'];
  name: Scalars['String']['output'];
  path: Scalars['String']['output'];
  runScript?: Maybe<Scalars['String']['output']>;
  setupScript?: Maybe<Scalars['String']['output']>;
  sortOrder: Scalars['Int']['output'];
  tags?: Maybe<Scalars['String']['output']>;
};

export type ProjectSpaceAssignment = {
  __typename?: 'ProjectSpaceAssignment';
  projectId: Scalars['ID']['output'];
  spaceId: Scalars['ID']['output'];
};

export type ProjectValidateResult = {
  __typename?: 'ProjectValidateResult';
  error?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  path?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type Query = {
  __typename?: 'Query';
  activeSessionsByConnection: Array<Session>;
  activeSessionsByWorktree: Array<Session>;
  activeWorktreesByProject: Array<Worktree>;
  allSettings: Array<SettingEntry>;
  allSpaceAssignments: Array<ProjectSpaceAssignment>;
  connection?: Maybe<ConnectionWithMembers>;
  connections: Array<ConnectionWithMembers>;
  dbSchemaVersion: Scalars['Int']['output'];
  detectedEditors: Array<DetectedApp>;
  detectedTerminals: Array<DetectedApp>;
  fileRead: FileReadResult;
  fileReadImageAsBase64: FileReadImageResult;
  fileReadPrompt: FileReadResult;
  fileTreeLoadChildren: FileTreeChildrenResult;
  fileTreeScan: FileTreeScanResult;
  fileTreeScanFlat: FileTreeScanFlatResult;
  gitBranchDiffFiles: GitBranchDiffFilesResult;
  gitBranchExists: Scalars['Boolean']['output'];
  gitBranchFileDiff: GitBranchFileDiffResult;
  gitBranchInfo: GitBranchInfoResult;
  gitBranches: GitBranchesResult;
  gitBranchesWithStatus: GitBranchesWithStatusResult;
  gitDiff: GitDiffResult;
  gitDiffStat: GitDiffStatResult;
  gitFileContent: GitFileContentResult;
  gitFileContentBase64: GitFileContentBase64Result;
  gitFileStatuses: GitFileStatusesResult;
  gitIsBranchMerged: GitIsMergedResult;
  gitListPRs: GitPrListResult;
  gitPRReviewComments: GitPrReviewCommentsResult;
  gitPRState: GitPrStateResult;
  gitRefContent: GitRefContentResult;
  gitRefContentBase64: GitFileContentBase64Result;
  gitRemoteUrl: GitRemoteUrlResult;
  kanbanTicket?: Maybe<KanbanTicket>;
  kanbanTicketsByProject: Array<KanbanTicket>;
  kanbanTicketsBySession: Array<KanbanTicket>;
  opencodeAgents: OpenCodeAgentsResult;
  opencodeCapabilities: OpenCodeCapabilitiesResult;
  opencodeCommands: OpenCodeCommandsResult;
  opencodeMessages: OpenCodeMessagesResult;
  opencodeModelInfo: OpenCodeModelInfoResult;
  opencodeModels: OpenCodeModelsResult;
  opencodePermissionList: OpenCodePermissionListResult;
  opencodeSessionInfo: OpenCodeSessionInfoResult;
  pinnedConnections: Array<ConnectionWithMembers>;
  pinnedWorktrees: Array<Worktree>;
  project?: Maybe<Project>;
  projectByPath?: Maybe<Project>;
  projectDetectFavicon?: Maybe<Scalars['String']['output']>;
  projectDetectLanguage?: Maybe<Scalars['String']['output']>;
  projectIconPath?: Maybe<Scalars['String']['output']>;
  projectIdsSortedByLastMessage: Array<Scalars['ID']['output']>;
  projectIsGitRepository: Scalars['Boolean']['output'];
  projectLanguageIcons: Scalars['JSON']['output'];
  projectValidate: ProjectValidateResult;
  projects: Array<Project>;
  recentlyActiveWorktrees: Array<Worktree>;
  scriptPort?: Maybe<Scalars['Int']['output']>;
  searchSessions: Array<SessionWithWorktree>;
  session?: Maybe<Session>;
  sessionDraft?: Maybe<Scalars['String']['output']>;
  sessionsByConnection: Array<Session>;
  sessionsByProject: Array<Session>;
  sessionsByWorktree: Array<Session>;
  setting?: Maybe<Scalars['String']['output']>;
  spaceProjectIds: Array<Scalars['ID']['output']>;
  spaces: Array<Space>;
  systemAppPaths: AppPaths;
  systemAppVersion: Scalars['String']['output'];
  systemDetectAgentSdks: AgentSdkDetection;
  systemLogDir: Scalars['String']['output'];
  systemServerStatus: ServerStatus;
  ticketImportAvailableStatuses: Array<RemoteStatus>;
  ticketImportDetectRepo: DetectRepoResult;
  ticketImportListIssues: RemoteIssueListResult;
  ticketImportProviders: Array<TicketProviderInfo>;
  ticketImportSettingsSchema: Array<SettingsFieldInfo>;
  usageFetch: UsageResult;
  usageFetchOpenai: UsageResult;
  worktree?: Maybe<Worktree>;
  worktreeExists: Scalars['Boolean']['output'];
  worktreeHasCommits: Scalars['Boolean']['output'];
  worktreesByProject: Array<Worktree>;
};


export type QueryActiveSessionsByConnectionArgs = {
  connectionId: Scalars['ID']['input'];
};


export type QueryActiveSessionsByWorktreeArgs = {
  worktreeId: Scalars['ID']['input'];
};


export type QueryActiveWorktreesByProjectArgs = {
  projectId: Scalars['ID']['input'];
};


export type QueryConnectionArgs = {
  connectionId: Scalars['ID']['input'];
};


export type QueryFileReadArgs = {
  filePath: Scalars['String']['input'];
};


export type QueryFileReadImageAsBase64Args = {
  filePath: Scalars['String']['input'];
};


export type QueryFileReadPromptArgs = {
  promptName: Scalars['String']['input'];
};


export type QueryFileTreeLoadChildrenArgs = {
  dirPath: Scalars['String']['input'];
  rootPath: Scalars['String']['input'];
};


export type QueryFileTreeScanArgs = {
  dirPath: Scalars['String']['input'];
};


export type QueryFileTreeScanFlatArgs = {
  dirPath: Scalars['String']['input'];
};


export type QueryGitBranchDiffFilesArgs = {
  baseBranch: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryGitBranchExistsArgs = {
  branchName: Scalars['String']['input'];
  projectPath: Scalars['String']['input'];
};


export type QueryGitBranchFileDiffArgs = {
  baseBranch: Scalars['String']['input'];
  filePath: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryGitBranchInfoArgs = {
  worktreePath: Scalars['String']['input'];
};


export type QueryGitBranchesArgs = {
  projectPath: Scalars['String']['input'];
};


export type QueryGitBranchesWithStatusArgs = {
  projectPath: Scalars['String']['input'];
};


export type QueryGitDiffArgs = {
  input: GitDiffInput;
};


export type QueryGitDiffStatArgs = {
  worktreePath: Scalars['String']['input'];
};


export type QueryGitFileContentArgs = {
  filePath: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryGitFileContentBase64Args = {
  filePath: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryGitFileStatusesArgs = {
  worktreePath: Scalars['String']['input'];
};


export type QueryGitIsBranchMergedArgs = {
  branch: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryGitListPRsArgs = {
  projectPath: Scalars['String']['input'];
};


export type QueryGitPrReviewCommentsArgs = {
  prNumber: Scalars['Int']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryGitPrStateArgs = {
  prNumber: Scalars['Int']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryGitRefContentArgs = {
  filePath: Scalars['String']['input'];
  ref: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryGitRefContentBase64Args = {
  filePath: Scalars['String']['input'];
  ref: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryGitRemoteUrlArgs = {
  remote?: InputMaybe<Scalars['String']['input']>;
  worktreePath: Scalars['String']['input'];
};


export type QueryKanbanTicketArgs = {
  id: Scalars['ID']['input'];
};


export type QueryKanbanTicketsByProjectArgs = {
  includeArchived?: InputMaybe<Scalars['Boolean']['input']>;
  projectId: Scalars['ID']['input'];
};


export type QueryKanbanTicketsBySessionArgs = {
  sessionId: Scalars['ID']['input'];
};


export type QueryOpencodeAgentsArgs = {
  worktreePath?: InputMaybe<Scalars['String']['input']>;
};


export type QueryOpencodeCapabilitiesArgs = {
  sessionId?: InputMaybe<Scalars['String']['input']>;
};


export type QueryOpencodeCommandsArgs = {
  sessionId?: InputMaybe<Scalars['String']['input']>;
  worktreePath: Scalars['String']['input'];
};


export type QueryOpencodeMessagesArgs = {
  sessionId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryOpencodeModelInfoArgs = {
  agentSdk?: InputMaybe<AgentSdk>;
  modelId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryOpencodeModelsArgs = {
  agentSdk?: InputMaybe<AgentSdk>;
};


export type QueryOpencodePermissionListArgs = {
  worktreePath?: InputMaybe<Scalars['String']['input']>;
};


export type QueryOpencodeSessionInfoArgs = {
  sessionId: Scalars['String']['input'];
  worktreePath: Scalars['String']['input'];
};


export type QueryProjectArgs = {
  id: Scalars['ID']['input'];
};


export type QueryProjectByPathArgs = {
  path: Scalars['String']['input'];
};


export type QueryProjectDetectFaviconArgs = {
  projectPath: Scalars['String']['input'];
};


export type QueryProjectDetectLanguageArgs = {
  projectPath: Scalars['String']['input'];
};


export type QueryProjectIconPathArgs = {
  filename: Scalars['String']['input'];
};


export type QueryProjectIsGitRepositoryArgs = {
  path: Scalars['String']['input'];
};


export type QueryProjectValidateArgs = {
  path: Scalars['String']['input'];
};


export type QueryRecentlyActiveWorktreesArgs = {
  cutoffMs: Scalars['Int']['input'];
};


export type QueryScriptPortArgs = {
  cwd: Scalars['String']['input'];
};


export type QuerySearchSessionsArgs = {
  input: SessionSearchInput;
};


export type QuerySessionArgs = {
  id: Scalars['ID']['input'];
};


export type QuerySessionDraftArgs = {
  sessionId: Scalars['ID']['input'];
};


export type QuerySessionsByConnectionArgs = {
  connectionId: Scalars['ID']['input'];
};


export type QuerySessionsByProjectArgs = {
  projectId: Scalars['ID']['input'];
};


export type QuerySessionsByWorktreeArgs = {
  worktreeId: Scalars['ID']['input'];
};


export type QuerySettingArgs = {
  key: Scalars['String']['input'];
};


export type QuerySpaceProjectIdsArgs = {
  spaceId: Scalars['ID']['input'];
};


export type QueryTicketImportAvailableStatusesArgs = {
  externalId: Scalars['String']['input'];
  providerId: Scalars['String']['input'];
  repo: Scalars['String']['input'];
  settings: Scalars['String']['input'];
};


export type QueryTicketImportDetectRepoArgs = {
  projectPath: Scalars['String']['input'];
  providerId: Scalars['String']['input'];
};


export type QueryTicketImportListIssuesArgs = {
  input: ListIssuesInput;
  settings: Scalars['String']['input'];
};


export type QueryTicketImportSettingsSchemaArgs = {
  providerId: Scalars['String']['input'];
};


export type QueryUsageFetchArgs = {
  providers?: InputMaybe<Array<Scalars['String']['input']>>;
};


export type QueryWorktreeArgs = {
  id: Scalars['ID']['input'];
};


export type QueryWorktreeExistsArgs = {
  worktreePath: Scalars['String']['input'];
};


export type QueryWorktreeHasCommitsArgs = {
  projectPath: Scalars['String']['input'];
};


export type QueryWorktreesByProjectArgs = {
  projectId: Scalars['ID']['input'];
};

export type QuestionReplyInput = {
  answers: Array<Array<Scalars['String']['input']>>;
  requestId: Scalars['String']['input'];
  worktreePath?: InputMaybe<Scalars['String']['input']>;
};

export type RemoteIssue = {
  __typename?: 'RemoteIssue';
  body?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['String']['output'];
  externalId: Scalars['String']['output'];
  state: Scalars['String']['output'];
  title: Scalars['String']['output'];
  updatedAt: Scalars['String']['output'];
  url: Scalars['String']['output'];
};

export type RemoteIssueListResult = {
  __typename?: 'RemoteIssueListResult';
  hasNextPage: Scalars['Boolean']['output'];
  issues: Array<RemoteIssue>;
  totalCount: Scalars['Int']['output'];
};

export type RemoteStatus = {
  __typename?: 'RemoteStatus';
  id: Scalars['String']['output'];
  label: Scalars['String']['output'];
};

export type RenameBranchInput = {
  newBranch: Scalars['String']['input'];
  oldBranch: Scalars['String']['input'];
  worktreeId: Scalars['ID']['input'];
  worktreePath: Scalars['String']['input'];
};

export type RenameSessionInput = {
  opencodeSessionId: Scalars['String']['input'];
  title: Scalars['String']['input'];
  worktreePath?: InputMaybe<Scalars['String']['input']>;
};

export type ScriptArchiveResult = {
  __typename?: 'ScriptArchiveResult';
  error?: Maybe<Scalars['String']['output']>;
  output?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type ScriptOutputEvent = {
  __typename?: 'ScriptOutputEvent';
  command?: Maybe<Scalars['String']['output']>;
  data?: Maybe<Scalars['String']['output']>;
  exitCode?: Maybe<Scalars['Int']['output']>;
  type: Scalars['String']['output'];
};

export type ScriptRunInput = {
  commands: Array<Scalars['String']['input']>;
  cwd: Scalars['String']['input'];
  worktreeId: Scalars['ID']['input'];
};

export type ScriptRunResult = {
  __typename?: 'ScriptRunResult';
  error?: Maybe<Scalars['String']['output']>;
  pid?: Maybe<Scalars['Int']['output']>;
  success: Scalars['Boolean']['output'];
};

export type ServerStatus = {
  __typename?: 'ServerStatus';
  connections: Scalars['Int']['output'];
  locked: Scalars['Boolean']['output'];
  requestCount: Scalars['Int']['output'];
  uptime: Scalars['Int']['output'];
  version: Scalars['String']['output'];
};

export type Session = {
  __typename?: 'Session';
  agentSdk: AgentSdk;
  completedAt?: Maybe<Scalars['String']['output']>;
  connectionId?: Maybe<Scalars['ID']['output']>;
  createdAt: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  mode: SessionMode;
  modelId?: Maybe<Scalars['String']['output']>;
  modelProviderId?: Maybe<Scalars['String']['output']>;
  modelVariant?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  opencodeSessionId?: Maybe<Scalars['String']['output']>;
  projectId: Scalars['ID']['output'];
  status: SessionStatus;
  updatedAt: Scalars['String']['output'];
  worktreeId?: Maybe<Scalars['ID']['output']>;
};

export type SessionMode =
  | 'build'
  | 'plan';

export type SessionSearchInput = {
  dateFrom?: InputMaybe<Scalars['String']['input']>;
  dateTo?: InputMaybe<Scalars['String']['input']>;
  includeArchived?: InputMaybe<Scalars['Boolean']['input']>;
  keyword?: InputMaybe<Scalars['String']['input']>;
  projectId?: InputMaybe<Scalars['ID']['input']>;
  worktreeId?: InputMaybe<Scalars['ID']['input']>;
};

export type SessionStatus =
  | 'active'
  | 'completed'
  | 'error';

export type SessionStatusPayload = {
  __typename?: 'SessionStatusPayload';
  attempt?: Maybe<Scalars['Int']['output']>;
  message?: Maybe<Scalars['String']['output']>;
  next?: Maybe<Scalars['Int']['output']>;
  type: Scalars['String']['output'];
};

export type SessionWithWorktree = {
  __typename?: 'SessionWithWorktree';
  agentSdk: AgentSdk;
  completedAt?: Maybe<Scalars['String']['output']>;
  connectionId?: Maybe<Scalars['ID']['output']>;
  createdAt: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  mode: SessionMode;
  modelId?: Maybe<Scalars['String']['output']>;
  modelProviderId?: Maybe<Scalars['String']['output']>;
  modelVariant?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  opencodeSessionId?: Maybe<Scalars['String']['output']>;
  projectId: Scalars['ID']['output'];
  projectName?: Maybe<Scalars['String']['output']>;
  status: SessionStatus;
  updatedAt: Scalars['String']['output'];
  worktreeBranchName?: Maybe<Scalars['String']['output']>;
  worktreeId?: Maybe<Scalars['ID']['output']>;
  worktreeName?: Maybe<Scalars['String']['output']>;
};

export type SetModelInput = {
  agentSdk?: InputMaybe<AgentSdk>;
  modelID: Scalars['String']['input'];
  providerID: Scalars['String']['input'];
  variant?: InputMaybe<Scalars['String']['input']>;
};

export type SettingEntry = {
  __typename?: 'SettingEntry';
  key: Scalars['String']['output'];
  value: Scalars['String']['output'];
};

export type SettingsFieldInfo = {
  __typename?: 'SettingsFieldInfo';
  key: Scalars['String']['output'];
  label: Scalars['String']['output'];
  placeholder?: Maybe<Scalars['String']['output']>;
  required: Scalars['Boolean']['output'];
  type: Scalars['String']['output'];
};

export type Space = {
  __typename?: 'Space';
  createdAt: Scalars['String']['output'];
  iconType: Scalars['String']['output'];
  iconValue: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  sortOrder: Scalars['Int']['output'];
};

export type Subscription = {
  __typename?: 'Subscription';
  fileTreeChange: FileTreeChangeEvent;
  gitBranchChanged: GitBranchChangedEvent;
  gitStatusChanged: GitStatusChangedEvent;
  opencodeStream: OpenCodeStreamEvent;
  scriptOutput: ScriptOutputEvent;
  terminalData: TerminalDataEvent;
  terminalExit: TerminalExitEvent;
  worktreeBranchRenamed: WorktreeBranchRenamedEvent;
};


export type SubscriptionFileTreeChangeArgs = {
  worktreePath?: InputMaybe<Scalars['String']['input']>;
};


export type SubscriptionGitBranchChangedArgs = {
  worktreePath?: InputMaybe<Scalars['String']['input']>;
};


export type SubscriptionGitStatusChangedArgs = {
  worktreePath?: InputMaybe<Scalars['String']['input']>;
};


export type SubscriptionOpencodeStreamArgs = {
  sessionIds?: InputMaybe<Array<Scalars['String']['input']>>;
};


export type SubscriptionScriptOutputArgs = {
  channel: Scalars['String']['input'];
  worktreeId: Scalars['ID']['input'];
};


export type SubscriptionTerminalDataArgs = {
  worktreeId: Scalars['ID']['input'];
};


export type SubscriptionTerminalExitArgs = {
  worktreeId: Scalars['ID']['input'];
};

export type SuccessResult = {
  __typename?: 'SuccessResult';
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type TerminalCreateResult = {
  __typename?: 'TerminalCreateResult';
  cols?: Maybe<Scalars['Int']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  rows?: Maybe<Scalars['Int']['output']>;
  success: Scalars['Boolean']['output'];
};

export type TerminalDataEvent = {
  __typename?: 'TerminalDataEvent';
  data: Scalars['String']['output'];
  worktreeId: Scalars['ID']['output'];
};

export type TerminalExitEvent = {
  __typename?: 'TerminalExitEvent';
  code: Scalars['Int']['output'];
  worktreeId: Scalars['ID']['output'];
};

export type TicketProviderInfo = {
  __typename?: 'TicketProviderInfo';
  icon: Scalars['String']['output'];
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type UpdateProjectInput = {
  archiveScript?: InputMaybe<Scalars['String']['input']>;
  autoAssignPort?: InputMaybe<Scalars['Boolean']['input']>;
  customIcon?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  detectedIcon?: InputMaybe<Scalars['String']['input']>;
  language?: InputMaybe<Scalars['String']['input']>;
  lastAccessedAt?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  runScript?: InputMaybe<Scalars['String']['input']>;
  setupScript?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type UpdateRemoteStatusInput = {
  externalId: Scalars['String']['input'];
  providerId: Scalars['String']['input'];
  repo: Scalars['String']['input'];
  statusId: Scalars['String']['input'];
};

export type UpdateSessionInput = {
  agentSdk?: InputMaybe<AgentSdk>;
  completedAt?: InputMaybe<Scalars['String']['input']>;
  mode?: InputMaybe<SessionMode>;
  modelId?: InputMaybe<Scalars['String']['input']>;
  modelProviderId?: InputMaybe<Scalars['String']['input']>;
  modelVariant?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  opencodeSessionId?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SessionStatus>;
  updatedAt?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateSpaceInput = {
  iconType?: InputMaybe<Scalars['String']['input']>;
  iconValue?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  sortOrder?: InputMaybe<Scalars['Int']['input']>;
};

export type UpdateWorktreeInput = {
  lastAccessedAt?: InputMaybe<Scalars['String']['input']>;
  lastMessageAt?: InputMaybe<Scalars['Float']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<WorktreeStatus>;
};

export type UpdateWorktreeModelInput = {
  modelId: Scalars['String']['input'];
  modelProviderId: Scalars['String']['input'];
  modelVariant?: InputMaybe<Scalars['String']['input']>;
  worktreeId: Scalars['ID']['input'];
};

export type UsageResult = {
  __typename?: 'UsageResult';
  data?: Maybe<Scalars['JSON']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type Worktree = {
  __typename?: 'Worktree';
  attachments: Array<Attachment>;
  branchName: Scalars['String']['output'];
  branchRenamed: Scalars['Int']['output'];
  context?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['String']['output'];
  githubPrNumber?: Maybe<Scalars['Int']['output']>;
  githubPrUrl?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isDefault: Scalars['Boolean']['output'];
  lastAccessedAt: Scalars['String']['output'];
  lastMessageAt?: Maybe<Scalars['Float']['output']>;
  lastModelId?: Maybe<Scalars['String']['output']>;
  lastModelProviderId?: Maybe<Scalars['String']['output']>;
  lastModelVariant?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  path: Scalars['String']['output'];
  pinned: Scalars['Boolean']['output'];
  projectId: Scalars['ID']['output'];
  sessionTitles: Scalars['String']['output'];
  status: WorktreeStatus;
};

export type WorktreeBranchRenamedEvent = {
  __typename?: 'WorktreeBranchRenamedEvent';
  newBranch: Scalars['String']['output'];
  worktreeId: Scalars['ID']['output'];
};

export type WorktreeCreateResult = {
  __typename?: 'WorktreeCreateResult';
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
  worktree?: Maybe<Worktree>;
};

export type WorktreeStatus =
  | 'active'
  | 'archived';

export type WithIndex<TObject> = TObject & Record<string, any>;
export type ResolversObject<TObject> = WithIndex<TObject>;

export type ResolverTypeWrapper<T> = Promise<T> | T;


export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<TResult, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = ResolverFn<TResult, TParent, TContext, TArgs> | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<TResult, TKey extends string, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<TResult, TKey extends string, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (obj: T, context: TContext, info: GraphQLResolveInfo) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<TResult = Record<PropertyKey, never>, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;





/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = ResolversObject<{
  AgentSdk: AgentSdk;
  AgentSdkDetection: ResolverTypeWrapper<AgentSdkDetection>;
  AppPaths: ResolverTypeWrapper<AppPaths>;
  Attachment: ResolverTypeWrapper<Attachment>;
  AttachmentInput: AttachmentInput;
  AuthResult: ResolverTypeWrapper<AuthResult>;
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  CommandApprovalReplyInput: CommandApprovalReplyInput;
  Connection: ResolverTypeWrapper<Connection>;
  ConnectionAddMemberResult: ResolverTypeWrapper<ConnectionAddMemberResult>;
  ConnectionCreateResult: ResolverTypeWrapper<ConnectionCreateResult>;
  ConnectionMember: ResolverTypeWrapper<ConnectionMember>;
  ConnectionMemberWithDetails: ResolverTypeWrapper<ConnectionMemberWithDetails>;
  ConnectionRemoveMemberResult: ResolverTypeWrapper<ConnectionRemoveMemberResult>;
  ConnectionWithMembers: ResolverTypeWrapper<ConnectionWithMembers>;
  CreateFromBranchInput: CreateFromBranchInput;
  CreateProjectInput: CreateProjectInput;
  CreateSessionInput: CreateSessionInput;
  CreateSpaceInput: CreateSpaceInput;
  CreateWorktreeInput: CreateWorktreeInput;
  DeleteWorktreeInput: DeleteWorktreeInput;
  DetectRepoResult: ResolverTypeWrapper<DetectRepoResult>;
  DetectedApp: ResolverTypeWrapper<DetectedApp>;
  DuplicateWorktreeInput: DuplicateWorktreeInput;
  FileReadImageResult: ResolverTypeWrapper<FileReadImageResult>;
  FileReadResult: ResolverTypeWrapper<FileReadResult>;
  FileTreeChangeEvent: ResolverTypeWrapper<FileTreeChangeEvent>;
  FileTreeChildrenResult: ResolverTypeWrapper<FileTreeChildrenResult>;
  FileTreeNode: ResolverTypeWrapper<FileTreeNode>;
  FileTreeScanFlatResult: ResolverTypeWrapper<FileTreeScanFlatResult>;
  FileTreeScanResult: ResolverTypeWrapper<FileTreeScanResult>;
  FlatFile: ResolverTypeWrapper<FlatFile>;
  Float: ResolverTypeWrapper<Scalars['Float']['output']>;
  ForkSessionInput: ForkSessionInput;
  GitBranchChangedEvent: ResolverTypeWrapper<GitBranchChangedEvent>;
  GitBranchDiffFile: ResolverTypeWrapper<GitBranchDiffFile>;
  GitBranchDiffFilesResult: ResolverTypeWrapper<GitBranchDiffFilesResult>;
  GitBranchFileDiffResult: ResolverTypeWrapper<GitBranchFileDiffResult>;
  GitBranchInfo: ResolverTypeWrapper<GitBranchInfo>;
  GitBranchInfoResult: ResolverTypeWrapper<GitBranchInfoResult>;
  GitBranchWithStatus: ResolverTypeWrapper<GitBranchWithStatus>;
  GitBranchesResult: ResolverTypeWrapper<GitBranchesResult>;
  GitBranchesWithStatusResult: ResolverTypeWrapper<GitBranchesWithStatusResult>;
  GitCommitResult: ResolverTypeWrapper<GitCommitResult>;
  GitDiffInput: GitDiffInput;
  GitDiffResult: ResolverTypeWrapper<GitDiffResult>;
  GitDiffStatFile: ResolverTypeWrapper<GitDiffStatFile>;
  GitDiffStatResult: ResolverTypeWrapper<GitDiffStatResult>;
  GitFileContentBase64Result: ResolverTypeWrapper<GitFileContentBase64Result>;
  GitFileContentResult: ResolverTypeWrapper<GitFileContentResult>;
  GitFileStatus: ResolverTypeWrapper<GitFileStatus>;
  GitFileStatusesResult: ResolverTypeWrapper<GitFileStatusesResult>;
  GitIsMergedResult: ResolverTypeWrapper<GitIsMergedResult>;
  GitMergeResult: ResolverTypeWrapper<GitMergeResult>;
  GitPR: ResolverTypeWrapper<GitPr>;
  GitPRListResult: ResolverTypeWrapper<GitPrListResult>;
  GitPRReviewCommentsResult: ResolverTypeWrapper<GitPrReviewCommentsResult>;
  GitPRStateResult: ResolverTypeWrapper<GitPrStateResult>;
  GitPullInput: GitPullInput;
  GitPushInput: GitPushInput;
  GitRefContentResult: ResolverTypeWrapper<GitRefContentResult>;
  GitRemoteUrlResult: ResolverTypeWrapper<GitRemoteUrlResult>;
  GitStatusChangedEvent: ResolverTypeWrapper<GitStatusChangedEvent>;
  ID: ResolverTypeWrapper<Scalars['ID']['output']>;
  ImportIssueInput: ImportIssueInput;
  ImportIssuesInput: ImportIssuesInput;
  ImportResult: ResolverTypeWrapper<ImportResult>;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  JSON: ResolverTypeWrapper<Scalars['JSON']['output']>;
  KanbanCreateTicketInput: KanbanCreateTicketInput;
  KanbanTicket: ResolverTypeWrapper<KanbanTicket>;
  KanbanTicketColumn: KanbanTicketColumn;
  KanbanUpdateTicketInput: KanbanUpdateTicketInput;
  ListIssuesInput: ListIssuesInput;
  MessagePartInput: MessagePartInput;
  ModelInput: ModelInput;
  Mutation: ResolverTypeWrapper<Record<PropertyKey, never>>;
  OpenCodeAgent: ResolverTypeWrapper<OpenCodeAgent>;
  OpenCodeAgentsResult: ResolverTypeWrapper<OpenCodeAgentsResult>;
  OpenCodeCapabilities: ResolverTypeWrapper<OpenCodeCapabilities>;
  OpenCodeCapabilitiesResult: ResolverTypeWrapper<OpenCodeCapabilitiesResult>;
  OpenCodeCommand: ResolverTypeWrapper<OpenCodeCommand>;
  OpenCodeCommandInput: OpenCodeCommandInput;
  OpenCodeCommandsResult: ResolverTypeWrapper<OpenCodeCommandsResult>;
  OpenCodeConnectResult: ResolverTypeWrapper<OpenCodeConnectResult>;
  OpenCodeForkResult: ResolverTypeWrapper<OpenCodeForkResult>;
  OpenCodeMessagesResult: ResolverTypeWrapper<OpenCodeMessagesResult>;
  OpenCodeModelInfoResult: ResolverTypeWrapper<OpenCodeModelInfoResult>;
  OpenCodeModelsResult: ResolverTypeWrapper<OpenCodeModelsResult>;
  OpenCodePermissionListResult: ResolverTypeWrapper<OpenCodePermissionListResult>;
  OpenCodePromptInput: OpenCodePromptInput;
  OpenCodeReconnectInput: OpenCodeReconnectInput;
  OpenCodeReconnectResult: ResolverTypeWrapper<OpenCodeReconnectResult>;
  OpenCodeRedoResult: ResolverTypeWrapper<OpenCodeRedoResult>;
  OpenCodeSessionInfoResult: ResolverTypeWrapper<OpenCodeSessionInfoResult>;
  OpenCodeStreamEvent: ResolverTypeWrapper<OpenCodeStreamEvent>;
  OpenCodeUndoResult: ResolverTypeWrapper<OpenCodeUndoResult>;
  PRReviewComment: ResolverTypeWrapper<PrReviewComment>;
  PRReviewUser: ResolverTypeWrapper<PrReviewUser>;
  PermissionReplyInput: PermissionReplyInput;
  PermissionRequest: ResolverTypeWrapper<PermissionRequest>;
  PermissionTool: ResolverTypeWrapper<PermissionTool>;
  PlanApproveInput: PlanApproveInput;
  PlanRejectInput: PlanRejectInput;
  Project: ResolverTypeWrapper<Project>;
  ProjectSpaceAssignment: ResolverTypeWrapper<ProjectSpaceAssignment>;
  ProjectValidateResult: ResolverTypeWrapper<ProjectValidateResult>;
  Query: ResolverTypeWrapper<Record<PropertyKey, never>>;
  QuestionReplyInput: QuestionReplyInput;
  RemoteIssue: ResolverTypeWrapper<RemoteIssue>;
  RemoteIssueListResult: ResolverTypeWrapper<RemoteIssueListResult>;
  RemoteStatus: ResolverTypeWrapper<RemoteStatus>;
  RenameBranchInput: RenameBranchInput;
  RenameSessionInput: RenameSessionInput;
  ScriptArchiveResult: ResolverTypeWrapper<ScriptArchiveResult>;
  ScriptOutputEvent: ResolverTypeWrapper<ScriptOutputEvent>;
  ScriptRunInput: ScriptRunInput;
  ScriptRunResult: ResolverTypeWrapper<ScriptRunResult>;
  ServerStatus: ResolverTypeWrapper<ServerStatus>;
  Session: ResolverTypeWrapper<Session>;
  SessionMode: SessionMode;
  SessionSearchInput: SessionSearchInput;
  SessionStatus: SessionStatus;
  SessionStatusPayload: ResolverTypeWrapper<SessionStatusPayload>;
  SessionWithWorktree: ResolverTypeWrapper<SessionWithWorktree>;
  SetModelInput: SetModelInput;
  SettingEntry: ResolverTypeWrapper<SettingEntry>;
  SettingsFieldInfo: ResolverTypeWrapper<SettingsFieldInfo>;
  Space: ResolverTypeWrapper<Space>;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
  Subscription: ResolverTypeWrapper<Record<PropertyKey, never>>;
  SuccessResult: ResolverTypeWrapper<SuccessResult>;
  TerminalCreateResult: ResolverTypeWrapper<TerminalCreateResult>;
  TerminalDataEvent: ResolverTypeWrapper<TerminalDataEvent>;
  TerminalExitEvent: ResolverTypeWrapper<TerminalExitEvent>;
  TicketProviderInfo: ResolverTypeWrapper<TicketProviderInfo>;
  UpdateProjectInput: UpdateProjectInput;
  UpdateRemoteStatusInput: UpdateRemoteStatusInput;
  UpdateSessionInput: UpdateSessionInput;
  UpdateSpaceInput: UpdateSpaceInput;
  UpdateWorktreeInput: UpdateWorktreeInput;
  UpdateWorktreeModelInput: UpdateWorktreeModelInput;
  UsageResult: ResolverTypeWrapper<UsageResult>;
  Worktree: ResolverTypeWrapper<Worktree>;
  WorktreeBranchRenamedEvent: ResolverTypeWrapper<WorktreeBranchRenamedEvent>;
  WorktreeCreateResult: ResolverTypeWrapper<WorktreeCreateResult>;
  WorktreeStatus: WorktreeStatus;
}>;

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = ResolversObject<{
  AgentSdkDetection: AgentSdkDetection;
  AppPaths: AppPaths;
  Attachment: Attachment;
  AttachmentInput: AttachmentInput;
  AuthResult: AuthResult;
  Boolean: Scalars['Boolean']['output'];
  CommandApprovalReplyInput: CommandApprovalReplyInput;
  Connection: Connection;
  ConnectionAddMemberResult: ConnectionAddMemberResult;
  ConnectionCreateResult: ConnectionCreateResult;
  ConnectionMember: ConnectionMember;
  ConnectionMemberWithDetails: ConnectionMemberWithDetails;
  ConnectionRemoveMemberResult: ConnectionRemoveMemberResult;
  ConnectionWithMembers: ConnectionWithMembers;
  CreateFromBranchInput: CreateFromBranchInput;
  CreateProjectInput: CreateProjectInput;
  CreateSessionInput: CreateSessionInput;
  CreateSpaceInput: CreateSpaceInput;
  CreateWorktreeInput: CreateWorktreeInput;
  DeleteWorktreeInput: DeleteWorktreeInput;
  DetectRepoResult: DetectRepoResult;
  DetectedApp: DetectedApp;
  DuplicateWorktreeInput: DuplicateWorktreeInput;
  FileReadImageResult: FileReadImageResult;
  FileReadResult: FileReadResult;
  FileTreeChangeEvent: FileTreeChangeEvent;
  FileTreeChildrenResult: FileTreeChildrenResult;
  FileTreeNode: FileTreeNode;
  FileTreeScanFlatResult: FileTreeScanFlatResult;
  FileTreeScanResult: FileTreeScanResult;
  FlatFile: FlatFile;
  Float: Scalars['Float']['output'];
  ForkSessionInput: ForkSessionInput;
  GitBranchChangedEvent: GitBranchChangedEvent;
  GitBranchDiffFile: GitBranchDiffFile;
  GitBranchDiffFilesResult: GitBranchDiffFilesResult;
  GitBranchFileDiffResult: GitBranchFileDiffResult;
  GitBranchInfo: GitBranchInfo;
  GitBranchInfoResult: GitBranchInfoResult;
  GitBranchWithStatus: GitBranchWithStatus;
  GitBranchesResult: GitBranchesResult;
  GitBranchesWithStatusResult: GitBranchesWithStatusResult;
  GitCommitResult: GitCommitResult;
  GitDiffInput: GitDiffInput;
  GitDiffResult: GitDiffResult;
  GitDiffStatFile: GitDiffStatFile;
  GitDiffStatResult: GitDiffStatResult;
  GitFileContentBase64Result: GitFileContentBase64Result;
  GitFileContentResult: GitFileContentResult;
  GitFileStatus: GitFileStatus;
  GitFileStatusesResult: GitFileStatusesResult;
  GitIsMergedResult: GitIsMergedResult;
  GitMergeResult: GitMergeResult;
  GitPR: GitPr;
  GitPRListResult: GitPrListResult;
  GitPRReviewCommentsResult: GitPrReviewCommentsResult;
  GitPRStateResult: GitPrStateResult;
  GitPullInput: GitPullInput;
  GitPushInput: GitPushInput;
  GitRefContentResult: GitRefContentResult;
  GitRemoteUrlResult: GitRemoteUrlResult;
  GitStatusChangedEvent: GitStatusChangedEvent;
  ID: Scalars['ID']['output'];
  ImportIssueInput: ImportIssueInput;
  ImportIssuesInput: ImportIssuesInput;
  ImportResult: ImportResult;
  Int: Scalars['Int']['output'];
  JSON: Scalars['JSON']['output'];
  KanbanCreateTicketInput: KanbanCreateTicketInput;
  KanbanTicket: KanbanTicket;
  KanbanUpdateTicketInput: KanbanUpdateTicketInput;
  ListIssuesInput: ListIssuesInput;
  MessagePartInput: MessagePartInput;
  ModelInput: ModelInput;
  Mutation: Record<PropertyKey, never>;
  OpenCodeAgent: OpenCodeAgent;
  OpenCodeAgentsResult: OpenCodeAgentsResult;
  OpenCodeCapabilities: OpenCodeCapabilities;
  OpenCodeCapabilitiesResult: OpenCodeCapabilitiesResult;
  OpenCodeCommand: OpenCodeCommand;
  OpenCodeCommandInput: OpenCodeCommandInput;
  OpenCodeCommandsResult: OpenCodeCommandsResult;
  OpenCodeConnectResult: OpenCodeConnectResult;
  OpenCodeForkResult: OpenCodeForkResult;
  OpenCodeMessagesResult: OpenCodeMessagesResult;
  OpenCodeModelInfoResult: OpenCodeModelInfoResult;
  OpenCodeModelsResult: OpenCodeModelsResult;
  OpenCodePermissionListResult: OpenCodePermissionListResult;
  OpenCodePromptInput: OpenCodePromptInput;
  OpenCodeReconnectInput: OpenCodeReconnectInput;
  OpenCodeReconnectResult: OpenCodeReconnectResult;
  OpenCodeRedoResult: OpenCodeRedoResult;
  OpenCodeSessionInfoResult: OpenCodeSessionInfoResult;
  OpenCodeStreamEvent: OpenCodeStreamEvent;
  OpenCodeUndoResult: OpenCodeUndoResult;
  PRReviewComment: PrReviewComment;
  PRReviewUser: PrReviewUser;
  PermissionReplyInput: PermissionReplyInput;
  PermissionRequest: PermissionRequest;
  PermissionTool: PermissionTool;
  PlanApproveInput: PlanApproveInput;
  PlanRejectInput: PlanRejectInput;
  Project: Project;
  ProjectSpaceAssignment: ProjectSpaceAssignment;
  ProjectValidateResult: ProjectValidateResult;
  Query: Record<PropertyKey, never>;
  QuestionReplyInput: QuestionReplyInput;
  RemoteIssue: RemoteIssue;
  RemoteIssueListResult: RemoteIssueListResult;
  RemoteStatus: RemoteStatus;
  RenameBranchInput: RenameBranchInput;
  RenameSessionInput: RenameSessionInput;
  ScriptArchiveResult: ScriptArchiveResult;
  ScriptOutputEvent: ScriptOutputEvent;
  ScriptRunInput: ScriptRunInput;
  ScriptRunResult: ScriptRunResult;
  ServerStatus: ServerStatus;
  Session: Session;
  SessionSearchInput: SessionSearchInput;
  SessionStatusPayload: SessionStatusPayload;
  SessionWithWorktree: SessionWithWorktree;
  SetModelInput: SetModelInput;
  SettingEntry: SettingEntry;
  SettingsFieldInfo: SettingsFieldInfo;
  Space: Space;
  String: Scalars['String']['output'];
  Subscription: Record<PropertyKey, never>;
  SuccessResult: SuccessResult;
  TerminalCreateResult: TerminalCreateResult;
  TerminalDataEvent: TerminalDataEvent;
  TerminalExitEvent: TerminalExitEvent;
  TicketProviderInfo: TicketProviderInfo;
  UpdateProjectInput: UpdateProjectInput;
  UpdateRemoteStatusInput: UpdateRemoteStatusInput;
  UpdateSessionInput: UpdateSessionInput;
  UpdateSpaceInput: UpdateSpaceInput;
  UpdateWorktreeInput: UpdateWorktreeInput;
  UpdateWorktreeModelInput: UpdateWorktreeModelInput;
  UsageResult: UsageResult;
  Worktree: Worktree;
  WorktreeBranchRenamedEvent: WorktreeBranchRenamedEvent;
  WorktreeCreateResult: WorktreeCreateResult;
}>;

export type AgentSdkDetectionResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['AgentSdkDetection'] = ResolversParentTypes['AgentSdkDetection']> = ResolversObject<{
  claude?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  codex?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  opencode?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type AppPathsResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['AppPaths'] = ResolversParentTypes['AppPaths']> = ResolversObject<{
  home?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  logs?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  userData?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type AttachmentResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Attachment'] = ResolversParentTypes['Attachment']> = ResolversObject<{
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  label?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  url?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type AuthResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['AuthResult'] = ResolversParentTypes['AuthResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type ConnectionResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Connection'] = ResolversParentTypes['Connection']> = ResolversObject<{
  color?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  path?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type ConnectionAddMemberResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ConnectionAddMemberResult'] = ResolversParentTypes['ConnectionAddMemberResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  member?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type ConnectionCreateResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ConnectionCreateResult'] = ResolversParentTypes['ConnectionCreateResult']> = ResolversObject<{
  connection?: Resolver<Maybe<ResolversTypes['ConnectionWithMembers']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type ConnectionMemberResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ConnectionMember'] = ResolversParentTypes['ConnectionMember']> = ResolversObject<{
  addedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  connectionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  projectId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  symlinkName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreeId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
}>;

export type ConnectionMemberWithDetailsResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ConnectionMemberWithDetails'] = ResolversParentTypes['ConnectionMemberWithDetails']> = ResolversObject<{
  addedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  connectionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  projectId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  projectName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  symlinkName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreeBranch?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreeId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  worktreeName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreePath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type ConnectionRemoveMemberResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ConnectionRemoveMemberResult'] = ResolversParentTypes['ConnectionRemoveMemberResult']> = ResolversObject<{
  connectionDeleted?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type ConnectionWithMembersResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ConnectionWithMembers'] = ResolversParentTypes['ConnectionWithMembers']> = ResolversObject<{
  color?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  members?: Resolver<Array<ResolversTypes['ConnectionMemberWithDetails']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  path?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type DetectRepoResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['DetectRepoResult'] = ResolversParentTypes['DetectRepoResult']> = ResolversObject<{
  repo?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type DetectedAppResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['DetectedApp'] = ResolversParentTypes['DetectedApp']> = ResolversObject<{
  available?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  command?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type FileReadImageResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FileReadImageResult'] = ResolversParentTypes['FileReadImageResult']> = ResolversObject<{
  content?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  mimeType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type FileReadResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FileReadResult'] = ResolversParentTypes['FileReadResult']> = ResolversObject<{
  content?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type FileTreeChangeEventResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FileTreeChangeEvent'] = ResolversParentTypes['FileTreeChangeEvent']> = ResolversObject<{
  changedPath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  eventType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  relativePath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreePath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type FileTreeChildrenResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FileTreeChildrenResult'] = ResolversParentTypes['FileTreeChildrenResult']> = ResolversObject<{
  children?: Resolver<Maybe<Array<ResolversTypes['FileTreeNode']>>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type FileTreeNodeResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FileTreeNode'] = ResolversParentTypes['FileTreeNode']> = ResolversObject<{
  children?: Resolver<Maybe<Array<ResolversTypes['FileTreeNode']>>, ParentType, ContextType>;
  extension?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isDirectory?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isSymlink?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  path?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  relativePath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type FileTreeScanFlatResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FileTreeScanFlatResult'] = ResolversParentTypes['FileTreeScanFlatResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  files?: Resolver<Maybe<Array<ResolversTypes['FlatFile']>>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type FileTreeScanResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FileTreeScanResult'] = ResolversParentTypes['FileTreeScanResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  tree?: Resolver<Maybe<Array<ResolversTypes['FileTreeNode']>>, ParentType, ContextType>;
}>;

export type FlatFileResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FlatFile'] = ResolversParentTypes['FlatFile']> = ResolversObject<{
  extension?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  path?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  relativePath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type GitBranchChangedEventResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitBranchChangedEvent'] = ResolversParentTypes['GitBranchChangedEvent']> = ResolversObject<{
  worktreePath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type GitBranchDiffFileResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitBranchDiffFile'] = ResolversParentTypes['GitBranchDiffFile']> = ResolversObject<{
  path?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type GitBranchDiffFilesResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitBranchDiffFilesResult'] = ResolversParentTypes['GitBranchDiffFilesResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  files?: Resolver<Maybe<Array<ResolversTypes['GitBranchDiffFile']>>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitBranchFileDiffResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitBranchFileDiffResult'] = ResolversParentTypes['GitBranchFileDiffResult']> = ResolversObject<{
  diff?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitBranchInfoResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitBranchInfo'] = ResolversParentTypes['GitBranchInfo']> = ResolversObject<{
  ahead?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  behind?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  tracking?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type GitBranchInfoResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitBranchInfoResult'] = ResolversParentTypes['GitBranchInfoResult']> = ResolversObject<{
  branch?: Resolver<Maybe<ResolversTypes['GitBranchInfo']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitBranchWithStatusResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitBranchWithStatus'] = ResolversParentTypes['GitBranchWithStatus']> = ResolversObject<{
  isCheckedOut?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isRemote?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreePath?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type GitBranchesResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitBranchesResult'] = ResolversParentTypes['GitBranchesResult']> = ResolversObject<{
  branches?: Resolver<Maybe<Array<ResolversTypes['String']>>, ParentType, ContextType>;
  currentBranch?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitBranchesWithStatusResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitBranchesWithStatusResult'] = ResolversParentTypes['GitBranchesWithStatusResult']> = ResolversObject<{
  branches?: Resolver<Maybe<Array<ResolversTypes['GitBranchWithStatus']>>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitCommitResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitCommitResult'] = ResolversParentTypes['GitCommitResult']> = ResolversObject<{
  commitHash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitDiffResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitDiffResult'] = ResolversParentTypes['GitDiffResult']> = ResolversObject<{
  diff?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  fileName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitDiffStatFileResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitDiffStatFile'] = ResolversParentTypes['GitDiffStatFile']> = ResolversObject<{
  additions?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  binary?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  deletions?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  path?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type GitDiffStatResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitDiffStatResult'] = ResolversParentTypes['GitDiffStatResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  files?: Resolver<Maybe<Array<ResolversTypes['GitDiffStatFile']>>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitFileContentBase64ResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitFileContentBase64Result'] = ResolversParentTypes['GitFileContentBase64Result']> = ResolversObject<{
  content?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  mimeType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitFileContentResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitFileContentResult'] = ResolversParentTypes['GitFileContentResult']> = ResolversObject<{
  content?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitFileStatusResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitFileStatus'] = ResolversParentTypes['GitFileStatus']> = ResolversObject<{
  path?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  relativePath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  staged?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type GitFileStatusesResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitFileStatusesResult'] = ResolversParentTypes['GitFileStatusesResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  files?: Resolver<Maybe<Array<ResolversTypes['GitFileStatus']>>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitIsMergedResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitIsMergedResult'] = ResolversParentTypes['GitIsMergedResult']> = ResolversObject<{
  isMerged?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitMergeResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitMergeResult'] = ResolversParentTypes['GitMergeResult']> = ResolversObject<{
  conflicts?: Resolver<Maybe<Array<ResolversTypes['String']>>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitPrResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitPR'] = ResolversParentTypes['GitPR']> = ResolversObject<{
  author?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  headRefName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  number?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  title?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type GitPrListResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitPRListResult'] = ResolversParentTypes['GitPRListResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  prs?: Resolver<Maybe<Array<ResolversTypes['GitPR']>>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitPrReviewCommentsResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitPRReviewCommentsResult'] = ResolversParentTypes['GitPRReviewCommentsResult']> = ResolversObject<{
  comments?: Resolver<Maybe<Array<ResolversTypes['PRReviewComment']>>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitPrStateResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitPRStateResult'] = ResolversParentTypes['GitPRStateResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  merged?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  state?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitRefContentResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitRefContentResult'] = ResolversParentTypes['GitRefContentResult']> = ResolversObject<{
  content?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type GitRemoteUrlResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitRemoteUrlResult'] = ResolversParentTypes['GitRemoteUrlResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  remote?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type GitStatusChangedEventResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GitStatusChangedEvent'] = ResolversParentTypes['GitStatusChangedEvent']> = ResolversObject<{
  worktreePath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type ImportResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ImportResult'] = ResolversParentTypes['ImportResult']> = ResolversObject<{
  imported?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  skipped?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export interface JsonScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['JSON'], any> {
  name: 'JSON';
}

export type KanbanTicketResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['KanbanTicket'] = ResolversParentTypes['KanbanTicket']> = ResolversObject<{
  archived?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  column?: Resolver<ResolversTypes['KanbanTicketColumn'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  externalId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  externalProvider?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  externalUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  projectId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sessionId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sortOrder?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  title?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  totalTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreeId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type MutationResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Mutation'] = ResolversParentTypes['Mutation']> = ResolversObject<{
  addConnectionMember?: Resolver<ResolversTypes['ConnectionAddMemberResult'], ParentType, ContextType, RequireFields<MutationAddConnectionMemberArgs, 'connectionId' | 'worktreeId'>>;
  appendResponseLog?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationAppendResponseLogArgs, 'data' | 'filePath'>>;
  appendWorktreeSessionTitle?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationAppendWorktreeSessionTitleArgs, 'title' | 'worktreeId'>>;
  archiveWorktree?: Resolver<Maybe<ResolversTypes['Worktree']>, ParentType, ContextType, RequireFields<MutationArchiveWorktreeArgs, 'id'>>;
  assignProjectToSpace?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationAssignProjectToSpaceArgs, 'projectId' | 'spaceId'>>;
  createConnection?: Resolver<ResolversTypes['ConnectionCreateResult'], ParentType, ContextType, RequireFields<MutationCreateConnectionArgs, 'worktreeIds'>>;
  createProject?: Resolver<ResolversTypes['Project'], ParentType, ContextType, RequireFields<MutationCreateProjectArgs, 'input'>>;
  createResponseLog?: Resolver<ResolversTypes['String'], ParentType, ContextType, RequireFields<MutationCreateResponseLogArgs, 'sessionId'>>;
  createSession?: Resolver<ResolversTypes['Session'], ParentType, ContextType, RequireFields<MutationCreateSessionArgs, 'input'>>;
  createSpace?: Resolver<ResolversTypes['Space'], ParentType, ContextType, RequireFields<MutationCreateSpaceArgs, 'input'>>;
  createWorktree?: Resolver<ResolversTypes['WorktreeCreateResult'], ParentType, ContextType, RequireFields<MutationCreateWorktreeArgs, 'input'>>;
  createWorktreeFromBranch?: Resolver<ResolversTypes['WorktreeCreateResult'], ParentType, ContextType, RequireFields<MutationCreateWorktreeFromBranchArgs, 'input'>>;
  deleteConnection?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationDeleteConnectionArgs, 'connectionId'>>;
  deleteProject?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationDeleteProjectArgs, 'id'>>;
  deleteSession?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationDeleteSessionArgs, 'id'>>;
  deleteSetting?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationDeleteSettingArgs, 'key'>>;
  deleteSpace?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationDeleteSpaceArgs, 'id'>>;
  deleteWorktree?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationDeleteWorktreeArgs, 'input'>>;
  duplicateWorktree?: Resolver<ResolversTypes['WorktreeCreateResult'], ParentType, ContextType, RequireFields<MutationDuplicateWorktreeArgs, 'input'>>;
  fileTreeUnwatch?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationFileTreeUnwatchArgs, 'worktreePath'>>;
  fileTreeWatch?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationFileTreeWatchArgs, 'worktreePath'>>;
  fileWrite?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationFileWriteArgs, 'content' | 'filePath'>>;
  gitAddToGitignore?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitAddToGitignoreArgs, 'pattern' | 'worktreePath'>>;
  gitCommit?: Resolver<ResolversTypes['GitCommitResult'], ParentType, ContextType, RequireFields<MutationGitCommitArgs, 'message' | 'worktreePath'>>;
  gitDeleteBranch?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitDeleteBranchArgs, 'branchName' | 'worktreePath'>>;
  gitDiscardChanges?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitDiscardChangesArgs, 'filePath' | 'worktreePath'>>;
  gitMerge?: Resolver<ResolversTypes['GitMergeResult'], ParentType, ContextType, RequireFields<MutationGitMergeArgs, 'sourceBranch' | 'worktreePath'>>;
  gitPrMerge?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitPrMergeArgs, 'prNumber' | 'worktreePath'>>;
  gitPull?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitPullArgs, 'input'>>;
  gitPush?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitPushArgs, 'input'>>;
  gitRevertHunk?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitRevertHunkArgs, 'patch' | 'worktreePath'>>;
  gitStageAll?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitStageAllArgs, 'worktreePath'>>;
  gitStageFile?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitStageFileArgs, 'filePath' | 'worktreePath'>>;
  gitStageHunk?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitStageHunkArgs, 'patch' | 'worktreePath'>>;
  gitUnstageAll?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitUnstageAllArgs, 'worktreePath'>>;
  gitUnstageFile?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitUnstageFileArgs, 'filePath' | 'worktreePath'>>;
  gitUnstageHunk?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitUnstageHunkArgs, 'patch' | 'worktreePath'>>;
  gitUnwatchBranch?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitUnwatchBranchArgs, 'worktreePath'>>;
  gitUnwatchWorktree?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitUnwatchWorktreeArgs, 'worktreePath'>>;
  gitWatchBranch?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitWatchBranchArgs, 'worktreePath'>>;
  gitWatchWorktree?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationGitWatchWorktreeArgs, 'worktreePath'>>;
  kanbanAddTicketTokens?: Resolver<Maybe<ResolversTypes['KanbanTicket']>, ParentType, ContextType, RequireFields<MutationKanbanAddTicketTokensArgs, 'id' | 'tokens'>>;
  kanbanArchiveAllDone?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationKanbanArchiveAllDoneArgs, 'projectId'>>;
  kanbanArchiveTicket?: Resolver<Maybe<ResolversTypes['KanbanTicket']>, ParentType, ContextType, RequireFields<MutationKanbanArchiveTicketArgs, 'id'>>;
  kanbanCreateTicket?: Resolver<ResolversTypes['KanbanTicket'], ParentType, ContextType, RequireFields<MutationKanbanCreateTicketArgs, 'input'>>;
  kanbanDeleteTicket?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationKanbanDeleteTicketArgs, 'id'>>;
  kanbanMoveTicket?: Resolver<Maybe<ResolversTypes['KanbanTicket']>, ParentType, ContextType, RequireFields<MutationKanbanMoveTicketArgs, 'column' | 'id' | 'sortOrder'>>;
  kanbanReorderTicket?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationKanbanReorderTicketArgs, 'id' | 'sortOrder'>>;
  kanbanToggleSimpleMode?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationKanbanToggleSimpleModeArgs, 'enabled' | 'projectId'>>;
  kanbanUnarchiveTicket?: Resolver<Maybe<ResolversTypes['KanbanTicket']>, ParentType, ContextType, RequireFields<MutationKanbanUnarchiveTicketArgs, 'id'>>;
  kanbanUpdateTicket?: Resolver<Maybe<ResolversTypes['KanbanTicket']>, ParentType, ContextType, RequireFields<MutationKanbanUpdateTicketArgs, 'id' | 'input'>>;
  opencodeAbort?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodeAbortArgs, 'sessionId' | 'worktreePath'>>;
  opencodeCommand?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodeCommandArgs, 'input'>>;
  opencodeCommandApprovalReply?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodeCommandApprovalReplyArgs, 'input'>>;
  opencodeConnect?: Resolver<ResolversTypes['OpenCodeConnectResult'], ParentType, ContextType, RequireFields<MutationOpencodeConnectArgs, 'hiveSessionId' | 'worktreePath'>>;
  opencodeDisconnect?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodeDisconnectArgs, 'sessionId' | 'worktreePath'>>;
  opencodeFork?: Resolver<ResolversTypes['OpenCodeForkResult'], ParentType, ContextType, RequireFields<MutationOpencodeForkArgs, 'input'>>;
  opencodePermissionReply?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodePermissionReplyArgs, 'input'>>;
  opencodePlanApprove?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodePlanApproveArgs, 'input'>>;
  opencodePlanReject?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodePlanRejectArgs, 'input'>>;
  opencodePrompt?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodePromptArgs, 'input'>>;
  opencodeQuestionReject?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodeQuestionRejectArgs, 'requestId'>>;
  opencodeQuestionReply?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodeQuestionReplyArgs, 'input'>>;
  opencodeReconnect?: Resolver<ResolversTypes['OpenCodeReconnectResult'], ParentType, ContextType, RequireFields<MutationOpencodeReconnectArgs, 'input'>>;
  opencodeRedo?: Resolver<ResolversTypes['OpenCodeRedoResult'], ParentType, ContextType, RequireFields<MutationOpencodeRedoArgs, 'sessionId' | 'worktreePath'>>;
  opencodeRenameSession?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodeRenameSessionArgs, 'input'>>;
  opencodeSetModel?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationOpencodeSetModelArgs, 'input'>>;
  opencodeUndo?: Resolver<ResolversTypes['OpenCodeUndoResult'], ParentType, ContextType, RequireFields<MutationOpencodeUndoArgs, 'sessionId' | 'worktreePath'>>;
  projectInitRepository?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationProjectInitRepositoryArgs, 'path'>>;
  projectRemoveIcon?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationProjectRemoveIconArgs, 'projectId'>>;
  projectUploadIcon?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationProjectUploadIconArgs, 'data' | 'filename' | 'projectId'>>;
  removeConnectionMember?: Resolver<ResolversTypes['ConnectionRemoveMemberResult'], ParentType, ContextType, RequireFields<MutationRemoveConnectionMemberArgs, 'connectionId' | 'worktreeId'>>;
  removeProjectFromSpace?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationRemoveProjectFromSpaceArgs, 'projectId' | 'spaceId'>>;
  removeWorktreeFromAllConnections?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationRemoveWorktreeFromAllConnectionsArgs, 'worktreeId'>>;
  renameConnection?: Resolver<Maybe<ResolversTypes['ConnectionWithMembers']>, ParentType, ContextType, RequireFields<MutationRenameConnectionArgs, 'connectionId'>>;
  renameWorktreeBranch?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationRenameWorktreeBranchArgs, 'input'>>;
  reorderProjects?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationReorderProjectsArgs, 'orderedIds'>>;
  reorderSpaces?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationReorderSpacesArgs, 'orderedIds'>>;
  scriptKill?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationScriptKillArgs, 'worktreeId'>>;
  scriptRunArchive?: Resolver<ResolversTypes['ScriptArchiveResult'], ParentType, ContextType, RequireFields<MutationScriptRunArchiveArgs, 'commands' | 'cwd'>>;
  scriptRunProject?: Resolver<ResolversTypes['ScriptRunResult'], ParentType, ContextType, RequireFields<MutationScriptRunProjectArgs, 'input'>>;
  scriptRunSetup?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationScriptRunSetupArgs, 'input'>>;
  setSetting?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationSetSettingArgs, 'key' | 'value'>>;
  syncWorktrees?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationSyncWorktreesArgs, 'projectId' | 'projectPath'>>;
  systemKillSwitch?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  systemRegisterPushToken?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationSystemRegisterPushTokenArgs, 'platform' | 'token'>>;
  terminalCreate?: Resolver<ResolversTypes['TerminalCreateResult'], ParentType, ContextType, RequireFields<MutationTerminalCreateArgs, 'cwd' | 'worktreeId'>>;
  terminalDestroy?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationTerminalDestroyArgs, 'worktreeId'>>;
  terminalResize?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationTerminalResizeArgs, 'cols' | 'rows' | 'worktreeId'>>;
  terminalWrite?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationTerminalWriteArgs, 'data' | 'worktreeId'>>;
  ticketImportAuthenticate?: Resolver<ResolversTypes['AuthResult'], ParentType, ContextType, RequireFields<MutationTicketImportAuthenticateArgs, 'providerId' | 'settings'>>;
  ticketImportIssues?: Resolver<ResolversTypes['ImportResult'], ParentType, ContextType, RequireFields<MutationTicketImportIssuesArgs, 'input'>>;
  ticketImportUpdateRemoteStatus?: Resolver<ResolversTypes['AuthResult'], ParentType, ContextType, RequireFields<MutationTicketImportUpdateRemoteStatusArgs, 'input' | 'settings'>>;
  touchProject?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationTouchProjectArgs, 'id'>>;
  touchWorktree?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationTouchWorktreeArgs, 'id'>>;
  updateProject?: Resolver<Maybe<ResolversTypes['Project']>, ParentType, ContextType, RequireFields<MutationUpdateProjectArgs, 'id' | 'input'>>;
  updateSession?: Resolver<Maybe<ResolversTypes['Session']>, ParentType, ContextType, RequireFields<MutationUpdateSessionArgs, 'id' | 'input'>>;
  updateSessionDraft?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<MutationUpdateSessionDraftArgs, 'sessionId'>>;
  updateSpace?: Resolver<Maybe<ResolversTypes['Space']>, ParentType, ContextType, RequireFields<MutationUpdateSpaceArgs, 'id' | 'input'>>;
  updateWorktree?: Resolver<Maybe<ResolversTypes['Worktree']>, ParentType, ContextType, RequireFields<MutationUpdateWorktreeArgs, 'id' | 'input'>>;
  updateWorktreeModel?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationUpdateWorktreeModelArgs, 'input'>>;
  worktreeAddAttachment?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationWorktreeAddAttachmentArgs, 'attachment' | 'worktreeId'>>;
  worktreeAttachPR?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationWorktreeAttachPrArgs, 'prNumber' | 'prUrl' | 'worktreeId'>>;
  worktreeDetachPR?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationWorktreeDetachPrArgs, 'worktreeId'>>;
  worktreeRemoveAttachment?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationWorktreeRemoveAttachmentArgs, 'attachmentId' | 'worktreeId'>>;
  worktreeSetPinned?: Resolver<ResolversTypes['SuccessResult'], ParentType, ContextType, RequireFields<MutationWorktreeSetPinnedArgs, 'pinned' | 'worktreeId'>>;
}>;

export type OpenCodeAgentResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeAgent'] = ResolversParentTypes['OpenCodeAgent']> = ResolversObject<{
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  mode?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type OpenCodeAgentsResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeAgentsResult'] = ResolversParentTypes['OpenCodeAgentsResult']> = ResolversObject<{
  agents?: Resolver<Array<ResolversTypes['OpenCodeAgent']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeCapabilitiesResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeCapabilities'] = ResolversParentTypes['OpenCodeCapabilities']> = ResolversObject<{
  supportsCommands?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  supportsModelSelection?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  supportsPartialStreaming?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  supportsPermissionRequests?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  supportsQuestionPrompts?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  supportsReconnect?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  supportsRedo?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  supportsUndo?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeCapabilitiesResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeCapabilitiesResult'] = ResolversParentTypes['OpenCodeCapabilitiesResult']> = ResolversObject<{
  capabilities?: Resolver<Maybe<ResolversTypes['OpenCodeCapabilities']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeCommandResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeCommand'] = ResolversParentTypes['OpenCodeCommand']> = ResolversObject<{
  agent?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  hints?: Resolver<Maybe<Array<ResolversTypes['String']>>, ParentType, ContextType>;
  model?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  source?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  subtask?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  template?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type OpenCodeCommandsResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeCommandsResult'] = ResolversParentTypes['OpenCodeCommandsResult']> = ResolversObject<{
  commands?: Resolver<Array<ResolversTypes['OpenCodeCommand']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeConnectResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeConnectResult'] = ResolversParentTypes['OpenCodeConnectResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sessionId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeForkResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeForkResult'] = ResolversParentTypes['OpenCodeForkResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sessionId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeMessagesResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeMessagesResult'] = ResolversParentTypes['OpenCodeMessagesResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  messages?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeModelInfoResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeModelInfoResult'] = ResolversParentTypes['OpenCodeModelInfoResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  model?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeModelsResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeModelsResult'] = ResolversParentTypes['OpenCodeModelsResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  providers?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodePermissionListResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodePermissionListResult'] = ResolversParentTypes['OpenCodePermissionListResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  permissions?: Resolver<Array<ResolversTypes['PermissionRequest']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeReconnectResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeReconnectResult'] = ResolversParentTypes['OpenCodeReconnectResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  revertMessageID?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sessionStatus?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeRedoResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeRedoResult'] = ResolversParentTypes['OpenCodeRedoResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  revertMessageID?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeSessionInfoResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeSessionInfoResult'] = ResolversParentTypes['OpenCodeSessionInfoResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  revertDiff?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  revertMessageID?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type OpenCodeStreamEventResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeStreamEvent'] = ResolversParentTypes['OpenCodeStreamEvent']> = ResolversObject<{
  childSessionId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  data?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  statusPayload?: Resolver<Maybe<ResolversTypes['SessionStatusPayload']>, ParentType, ContextType>;
  type?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type OpenCodeUndoResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['OpenCodeUndoResult'] = ResolversParentTypes['OpenCodeUndoResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  restoredPrompt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  revertDiff?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  revertMessageID?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type PrReviewCommentResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['PRReviewComment'] = ResolversParentTypes['PRReviewComment']> = ResolversObject<{
  body?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  line?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  path?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  user?: Resolver<ResolversTypes['PRReviewUser'], ParentType, ContextType>;
}>;

export type PrReviewUserResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['PRReviewUser'] = ResolversParentTypes['PRReviewUser']> = ResolversObject<{
  login?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type PermissionRequestResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['PermissionRequest'] = ResolversParentTypes['PermissionRequest']> = ResolversObject<{
  always?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  metadata?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  patterns?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  permission?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sessionID?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  tool?: Resolver<Maybe<ResolversTypes['PermissionTool']>, ParentType, ContextType>;
}>;

export type PermissionToolResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['PermissionTool'] = ResolversParentTypes['PermissionTool']> = ResolversObject<{
  callID?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  messageID?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type ProjectResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Project'] = ResolversParentTypes['Project']> = ResolversObject<{
  archiveScript?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  autoAssignPort?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  customIcon?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  detectedIcon?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  language?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  lastAccessedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  path?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  runScript?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  setupScript?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sortOrder?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  tags?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ProjectSpaceAssignmentResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ProjectSpaceAssignment'] = ResolversParentTypes['ProjectSpaceAssignment']> = ResolversObject<{
  projectId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  spaceId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
}>;

export type ProjectValidateResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ProjectValidateResult'] = ResolversParentTypes['ProjectValidateResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  path?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type QueryResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query']> = ResolversObject<{
  activeSessionsByConnection?: Resolver<Array<ResolversTypes['Session']>, ParentType, ContextType, RequireFields<QueryActiveSessionsByConnectionArgs, 'connectionId'>>;
  activeSessionsByWorktree?: Resolver<Array<ResolversTypes['Session']>, ParentType, ContextType, RequireFields<QueryActiveSessionsByWorktreeArgs, 'worktreeId'>>;
  activeWorktreesByProject?: Resolver<Array<ResolversTypes['Worktree']>, ParentType, ContextType, RequireFields<QueryActiveWorktreesByProjectArgs, 'projectId'>>;
  allSettings?: Resolver<Array<ResolversTypes['SettingEntry']>, ParentType, ContextType>;
  allSpaceAssignments?: Resolver<Array<ResolversTypes['ProjectSpaceAssignment']>, ParentType, ContextType>;
  connection?: Resolver<Maybe<ResolversTypes['ConnectionWithMembers']>, ParentType, ContextType, RequireFields<QueryConnectionArgs, 'connectionId'>>;
  connections?: Resolver<Array<ResolversTypes['ConnectionWithMembers']>, ParentType, ContextType>;
  dbSchemaVersion?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  detectedEditors?: Resolver<Array<ResolversTypes['DetectedApp']>, ParentType, ContextType>;
  detectedTerminals?: Resolver<Array<ResolversTypes['DetectedApp']>, ParentType, ContextType>;
  fileRead?: Resolver<ResolversTypes['FileReadResult'], ParentType, ContextType, RequireFields<QueryFileReadArgs, 'filePath'>>;
  fileReadImageAsBase64?: Resolver<ResolversTypes['FileReadImageResult'], ParentType, ContextType, RequireFields<QueryFileReadImageAsBase64Args, 'filePath'>>;
  fileReadPrompt?: Resolver<ResolversTypes['FileReadResult'], ParentType, ContextType, RequireFields<QueryFileReadPromptArgs, 'promptName'>>;
  fileTreeLoadChildren?: Resolver<ResolversTypes['FileTreeChildrenResult'], ParentType, ContextType, RequireFields<QueryFileTreeLoadChildrenArgs, 'dirPath' | 'rootPath'>>;
  fileTreeScan?: Resolver<ResolversTypes['FileTreeScanResult'], ParentType, ContextType, RequireFields<QueryFileTreeScanArgs, 'dirPath'>>;
  fileTreeScanFlat?: Resolver<ResolversTypes['FileTreeScanFlatResult'], ParentType, ContextType, RequireFields<QueryFileTreeScanFlatArgs, 'dirPath'>>;
  gitBranchDiffFiles?: Resolver<ResolversTypes['GitBranchDiffFilesResult'], ParentType, ContextType, RequireFields<QueryGitBranchDiffFilesArgs, 'baseBranch' | 'worktreePath'>>;
  gitBranchExists?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<QueryGitBranchExistsArgs, 'branchName' | 'projectPath'>>;
  gitBranchFileDiff?: Resolver<ResolversTypes['GitBranchFileDiffResult'], ParentType, ContextType, RequireFields<QueryGitBranchFileDiffArgs, 'baseBranch' | 'filePath' | 'worktreePath'>>;
  gitBranchInfo?: Resolver<ResolversTypes['GitBranchInfoResult'], ParentType, ContextType, RequireFields<QueryGitBranchInfoArgs, 'worktreePath'>>;
  gitBranches?: Resolver<ResolversTypes['GitBranchesResult'], ParentType, ContextType, RequireFields<QueryGitBranchesArgs, 'projectPath'>>;
  gitBranchesWithStatus?: Resolver<ResolversTypes['GitBranchesWithStatusResult'], ParentType, ContextType, RequireFields<QueryGitBranchesWithStatusArgs, 'projectPath'>>;
  gitDiff?: Resolver<ResolversTypes['GitDiffResult'], ParentType, ContextType, RequireFields<QueryGitDiffArgs, 'input'>>;
  gitDiffStat?: Resolver<ResolversTypes['GitDiffStatResult'], ParentType, ContextType, RequireFields<QueryGitDiffStatArgs, 'worktreePath'>>;
  gitFileContent?: Resolver<ResolversTypes['GitFileContentResult'], ParentType, ContextType, RequireFields<QueryGitFileContentArgs, 'filePath' | 'worktreePath'>>;
  gitFileContentBase64?: Resolver<ResolversTypes['GitFileContentBase64Result'], ParentType, ContextType, RequireFields<QueryGitFileContentBase64Args, 'filePath' | 'worktreePath'>>;
  gitFileStatuses?: Resolver<ResolversTypes['GitFileStatusesResult'], ParentType, ContextType, RequireFields<QueryGitFileStatusesArgs, 'worktreePath'>>;
  gitIsBranchMerged?: Resolver<ResolversTypes['GitIsMergedResult'], ParentType, ContextType, RequireFields<QueryGitIsBranchMergedArgs, 'branch' | 'worktreePath'>>;
  gitListPRs?: Resolver<ResolversTypes['GitPRListResult'], ParentType, ContextType, RequireFields<QueryGitListPRsArgs, 'projectPath'>>;
  gitPRReviewComments?: Resolver<ResolversTypes['GitPRReviewCommentsResult'], ParentType, ContextType, RequireFields<QueryGitPrReviewCommentsArgs, 'prNumber' | 'worktreePath'>>;
  gitPRState?: Resolver<ResolversTypes['GitPRStateResult'], ParentType, ContextType, RequireFields<QueryGitPrStateArgs, 'prNumber' | 'worktreePath'>>;
  gitRefContent?: Resolver<ResolversTypes['GitRefContentResult'], ParentType, ContextType, RequireFields<QueryGitRefContentArgs, 'filePath' | 'ref' | 'worktreePath'>>;
  gitRefContentBase64?: Resolver<ResolversTypes['GitFileContentBase64Result'], ParentType, ContextType, RequireFields<QueryGitRefContentBase64Args, 'filePath' | 'ref' | 'worktreePath'>>;
  gitRemoteUrl?: Resolver<ResolversTypes['GitRemoteUrlResult'], ParentType, ContextType, RequireFields<QueryGitRemoteUrlArgs, 'worktreePath'>>;
  kanbanTicket?: Resolver<Maybe<ResolversTypes['KanbanTicket']>, ParentType, ContextType, RequireFields<QueryKanbanTicketArgs, 'id'>>;
  kanbanTicketsByProject?: Resolver<Array<ResolversTypes['KanbanTicket']>, ParentType, ContextType, RequireFields<QueryKanbanTicketsByProjectArgs, 'projectId'>>;
  kanbanTicketsBySession?: Resolver<Array<ResolversTypes['KanbanTicket']>, ParentType, ContextType, RequireFields<QueryKanbanTicketsBySessionArgs, 'sessionId'>>;
  opencodeAgents?: Resolver<ResolversTypes['OpenCodeAgentsResult'], ParentType, ContextType, Partial<QueryOpencodeAgentsArgs>>;
  opencodeCapabilities?: Resolver<ResolversTypes['OpenCodeCapabilitiesResult'], ParentType, ContextType, Partial<QueryOpencodeCapabilitiesArgs>>;
  opencodeCommands?: Resolver<ResolversTypes['OpenCodeCommandsResult'], ParentType, ContextType, RequireFields<QueryOpencodeCommandsArgs, 'worktreePath'>>;
  opencodeMessages?: Resolver<ResolversTypes['OpenCodeMessagesResult'], ParentType, ContextType, RequireFields<QueryOpencodeMessagesArgs, 'sessionId' | 'worktreePath'>>;
  opencodeModelInfo?: Resolver<ResolversTypes['OpenCodeModelInfoResult'], ParentType, ContextType, RequireFields<QueryOpencodeModelInfoArgs, 'modelId' | 'worktreePath'>>;
  opencodeModels?: Resolver<ResolversTypes['OpenCodeModelsResult'], ParentType, ContextType, Partial<QueryOpencodeModelsArgs>>;
  opencodePermissionList?: Resolver<ResolversTypes['OpenCodePermissionListResult'], ParentType, ContextType, Partial<QueryOpencodePermissionListArgs>>;
  opencodeSessionInfo?: Resolver<ResolversTypes['OpenCodeSessionInfoResult'], ParentType, ContextType, RequireFields<QueryOpencodeSessionInfoArgs, 'sessionId' | 'worktreePath'>>;
  pinnedConnections?: Resolver<Array<ResolversTypes['ConnectionWithMembers']>, ParentType, ContextType>;
  pinnedWorktrees?: Resolver<Array<ResolversTypes['Worktree']>, ParentType, ContextType>;
  project?: Resolver<Maybe<ResolversTypes['Project']>, ParentType, ContextType, RequireFields<QueryProjectArgs, 'id'>>;
  projectByPath?: Resolver<Maybe<ResolversTypes['Project']>, ParentType, ContextType, RequireFields<QueryProjectByPathArgs, 'path'>>;
  projectDetectFavicon?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, RequireFields<QueryProjectDetectFaviconArgs, 'projectPath'>>;
  projectDetectLanguage?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, RequireFields<QueryProjectDetectLanguageArgs, 'projectPath'>>;
  projectIconPath?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, RequireFields<QueryProjectIconPathArgs, 'filename'>>;
  projectIdsSortedByLastMessage?: Resolver<Array<ResolversTypes['ID']>, ParentType, ContextType>;
  projectIsGitRepository?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<QueryProjectIsGitRepositoryArgs, 'path'>>;
  projectLanguageIcons?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
  projectValidate?: Resolver<ResolversTypes['ProjectValidateResult'], ParentType, ContextType, RequireFields<QueryProjectValidateArgs, 'path'>>;
  projects?: Resolver<Array<ResolversTypes['Project']>, ParentType, ContextType>;
  recentlyActiveWorktrees?: Resolver<Array<ResolversTypes['Worktree']>, ParentType, ContextType, RequireFields<QueryRecentlyActiveWorktreesArgs, 'cutoffMs'>>;
  scriptPort?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType, RequireFields<QueryScriptPortArgs, 'cwd'>>;
  searchSessions?: Resolver<Array<ResolversTypes['SessionWithWorktree']>, ParentType, ContextType, RequireFields<QuerySearchSessionsArgs, 'input'>>;
  session?: Resolver<Maybe<ResolversTypes['Session']>, ParentType, ContextType, RequireFields<QuerySessionArgs, 'id'>>;
  sessionDraft?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, RequireFields<QuerySessionDraftArgs, 'sessionId'>>;
  sessionsByConnection?: Resolver<Array<ResolversTypes['Session']>, ParentType, ContextType, RequireFields<QuerySessionsByConnectionArgs, 'connectionId'>>;
  sessionsByProject?: Resolver<Array<ResolversTypes['Session']>, ParentType, ContextType, RequireFields<QuerySessionsByProjectArgs, 'projectId'>>;
  sessionsByWorktree?: Resolver<Array<ResolversTypes['Session']>, ParentType, ContextType, RequireFields<QuerySessionsByWorktreeArgs, 'worktreeId'>>;
  setting?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType, RequireFields<QuerySettingArgs, 'key'>>;
  spaceProjectIds?: Resolver<Array<ResolversTypes['ID']>, ParentType, ContextType, RequireFields<QuerySpaceProjectIdsArgs, 'spaceId'>>;
  spaces?: Resolver<Array<ResolversTypes['Space']>, ParentType, ContextType>;
  systemAppPaths?: Resolver<ResolversTypes['AppPaths'], ParentType, ContextType>;
  systemAppVersion?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  systemDetectAgentSdks?: Resolver<ResolversTypes['AgentSdkDetection'], ParentType, ContextType>;
  systemLogDir?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  systemServerStatus?: Resolver<ResolversTypes['ServerStatus'], ParentType, ContextType>;
  ticketImportAvailableStatuses?: Resolver<Array<ResolversTypes['RemoteStatus']>, ParentType, ContextType, RequireFields<QueryTicketImportAvailableStatusesArgs, 'externalId' | 'providerId' | 'repo' | 'settings'>>;
  ticketImportDetectRepo?: Resolver<ResolversTypes['DetectRepoResult'], ParentType, ContextType, RequireFields<QueryTicketImportDetectRepoArgs, 'projectPath' | 'providerId'>>;
  ticketImportListIssues?: Resolver<ResolversTypes['RemoteIssueListResult'], ParentType, ContextType, RequireFields<QueryTicketImportListIssuesArgs, 'input' | 'settings'>>;
  ticketImportProviders?: Resolver<Array<ResolversTypes['TicketProviderInfo']>, ParentType, ContextType>;
  ticketImportSettingsSchema?: Resolver<Array<ResolversTypes['SettingsFieldInfo']>, ParentType, ContextType, RequireFields<QueryTicketImportSettingsSchemaArgs, 'providerId'>>;
  usageFetch?: Resolver<ResolversTypes['UsageResult'], ParentType, ContextType, Partial<QueryUsageFetchArgs>>;
  usageFetchOpenai?: Resolver<ResolversTypes['UsageResult'], ParentType, ContextType>;
  worktree?: Resolver<Maybe<ResolversTypes['Worktree']>, ParentType, ContextType, RequireFields<QueryWorktreeArgs, 'id'>>;
  worktreeExists?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<QueryWorktreeExistsArgs, 'worktreePath'>>;
  worktreeHasCommits?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType, RequireFields<QueryWorktreeHasCommitsArgs, 'projectPath'>>;
  worktreesByProject?: Resolver<Array<ResolversTypes['Worktree']>, ParentType, ContextType, RequireFields<QueryWorktreesByProjectArgs, 'projectId'>>;
}>;

export type RemoteIssueResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['RemoteIssue'] = ResolversParentTypes['RemoteIssue']> = ResolversObject<{
  body?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  externalId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  state?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  title?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  url?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type RemoteIssueListResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['RemoteIssueListResult'] = ResolversParentTypes['RemoteIssueListResult']> = ResolversObject<{
  hasNextPage?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  issues?: Resolver<Array<ResolversTypes['RemoteIssue']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type RemoteStatusResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['RemoteStatus'] = ResolversParentTypes['RemoteStatus']> = ResolversObject<{
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  label?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type ScriptArchiveResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ScriptArchiveResult'] = ResolversParentTypes['ScriptArchiveResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  output?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type ScriptOutputEventResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ScriptOutputEvent'] = ResolversParentTypes['ScriptOutputEvent']> = ResolversObject<{
  command?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  data?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  exitCode?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  type?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type ScriptRunResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ScriptRunResult'] = ResolversParentTypes['ScriptRunResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  pid?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type ServerStatusResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['ServerStatus'] = ResolversParentTypes['ServerStatus']> = ResolversObject<{
  connections?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  locked?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  requestCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  uptime?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  version?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type SessionResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Session'] = ResolversParentTypes['Session']> = ResolversObject<{
  agentSdk?: Resolver<ResolversTypes['AgentSdk'], ParentType, ContextType>;
  completedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  connectionId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  mode?: Resolver<ResolversTypes['SessionMode'], ParentType, ContextType>;
  modelId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  modelProviderId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  modelVariant?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  opencodeSessionId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  projectId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['SessionStatus'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreeId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
}>;

export type SessionStatusPayloadResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['SessionStatusPayload'] = ResolversParentTypes['SessionStatusPayload']> = ResolversObject<{
  attempt?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  message?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  next?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  type?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type SessionWithWorktreeResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['SessionWithWorktree'] = ResolversParentTypes['SessionWithWorktree']> = ResolversObject<{
  agentSdk?: Resolver<ResolversTypes['AgentSdk'], ParentType, ContextType>;
  completedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  connectionId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  mode?: Resolver<ResolversTypes['SessionMode'], ParentType, ContextType>;
  modelId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  modelProviderId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  modelVariant?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  opencodeSessionId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  projectId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  projectName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<ResolversTypes['SessionStatus'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreeBranchName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  worktreeId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  worktreeName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type SettingEntryResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['SettingEntry'] = ResolversParentTypes['SettingEntry']> = ResolversObject<{
  key?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  value?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type SettingsFieldInfoResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['SettingsFieldInfo'] = ResolversParentTypes['SettingsFieldInfo']> = ResolversObject<{
  key?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  label?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  placeholder?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  required?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type SpaceResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Space'] = ResolversParentTypes['Space']> = ResolversObject<{
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  iconType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  iconValue?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sortOrder?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SubscriptionResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Subscription'] = ResolversParentTypes['Subscription']> = ResolversObject<{
  fileTreeChange?: SubscriptionResolver<ResolversTypes['FileTreeChangeEvent'], "fileTreeChange", ParentType, ContextType, Partial<SubscriptionFileTreeChangeArgs>>;
  gitBranchChanged?: SubscriptionResolver<ResolversTypes['GitBranchChangedEvent'], "gitBranchChanged", ParentType, ContextType, Partial<SubscriptionGitBranchChangedArgs>>;
  gitStatusChanged?: SubscriptionResolver<ResolversTypes['GitStatusChangedEvent'], "gitStatusChanged", ParentType, ContextType, Partial<SubscriptionGitStatusChangedArgs>>;
  opencodeStream?: SubscriptionResolver<ResolversTypes['OpenCodeStreamEvent'], "opencodeStream", ParentType, ContextType, Partial<SubscriptionOpencodeStreamArgs>>;
  scriptOutput?: SubscriptionResolver<ResolversTypes['ScriptOutputEvent'], "scriptOutput", ParentType, ContextType, RequireFields<SubscriptionScriptOutputArgs, 'channel' | 'worktreeId'>>;
  terminalData?: SubscriptionResolver<ResolversTypes['TerminalDataEvent'], "terminalData", ParentType, ContextType, RequireFields<SubscriptionTerminalDataArgs, 'worktreeId'>>;
  terminalExit?: SubscriptionResolver<ResolversTypes['TerminalExitEvent'], "terminalExit", ParentType, ContextType, RequireFields<SubscriptionTerminalExitArgs, 'worktreeId'>>;
  worktreeBranchRenamed?: SubscriptionResolver<ResolversTypes['WorktreeBranchRenamedEvent'], "worktreeBranchRenamed", ParentType, ContextType>;
}>;

export type SuccessResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['SuccessResult'] = ResolversParentTypes['SuccessResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type TerminalCreateResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['TerminalCreateResult'] = ResolversParentTypes['TerminalCreateResult']> = ResolversObject<{
  cols?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  rows?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type TerminalDataEventResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['TerminalDataEvent'] = ResolversParentTypes['TerminalDataEvent']> = ResolversObject<{
  data?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreeId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
}>;

export type TerminalExitEventResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['TerminalExitEvent'] = ResolversParentTypes['TerminalExitEvent']> = ResolversObject<{
  code?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  worktreeId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
}>;

export type TicketProviderInfoResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['TicketProviderInfo'] = ResolversParentTypes['TicketProviderInfo']> = ResolversObject<{
  icon?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type UsageResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['UsageResult'] = ResolversParentTypes['UsageResult']> = ResolversObject<{
  data?: Resolver<Maybe<ResolversTypes['JSON']>, ParentType, ContextType>;
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type WorktreeResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Worktree'] = ResolversParentTypes['Worktree']> = ResolversObject<{
  attachments?: Resolver<Array<ResolversTypes['Attachment']>, ParentType, ContextType>;
  branchName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  branchRenamed?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  context?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  githubPrNumber?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  githubPrUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  isDefault?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  lastAccessedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  lastMessageAt?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  lastModelId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  lastModelProviderId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  lastModelVariant?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  path?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  pinned?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  projectId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  sessionTitles?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['WorktreeStatus'], ParentType, ContextType>;
}>;

export type WorktreeBranchRenamedEventResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['WorktreeBranchRenamedEvent'] = ResolversParentTypes['WorktreeBranchRenamedEvent']> = ResolversObject<{
  newBranch?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  worktreeId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
}>;

export type WorktreeCreateResultResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['WorktreeCreateResult'] = ResolversParentTypes['WorktreeCreateResult']> = ResolversObject<{
  error?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  worktree?: Resolver<Maybe<ResolversTypes['Worktree']>, ParentType, ContextType>;
}>;

export type Resolvers<ContextType = GraphQLContext> = ResolversObject<{
  AgentSdkDetection?: AgentSdkDetectionResolvers<ContextType>;
  AppPaths?: AppPathsResolvers<ContextType>;
  Attachment?: AttachmentResolvers<ContextType>;
  AuthResult?: AuthResultResolvers<ContextType>;
  Connection?: ConnectionResolvers<ContextType>;
  ConnectionAddMemberResult?: ConnectionAddMemberResultResolvers<ContextType>;
  ConnectionCreateResult?: ConnectionCreateResultResolvers<ContextType>;
  ConnectionMember?: ConnectionMemberResolvers<ContextType>;
  ConnectionMemberWithDetails?: ConnectionMemberWithDetailsResolvers<ContextType>;
  ConnectionRemoveMemberResult?: ConnectionRemoveMemberResultResolvers<ContextType>;
  ConnectionWithMembers?: ConnectionWithMembersResolvers<ContextType>;
  DetectRepoResult?: DetectRepoResultResolvers<ContextType>;
  DetectedApp?: DetectedAppResolvers<ContextType>;
  FileReadImageResult?: FileReadImageResultResolvers<ContextType>;
  FileReadResult?: FileReadResultResolvers<ContextType>;
  FileTreeChangeEvent?: FileTreeChangeEventResolvers<ContextType>;
  FileTreeChildrenResult?: FileTreeChildrenResultResolvers<ContextType>;
  FileTreeNode?: FileTreeNodeResolvers<ContextType>;
  FileTreeScanFlatResult?: FileTreeScanFlatResultResolvers<ContextType>;
  FileTreeScanResult?: FileTreeScanResultResolvers<ContextType>;
  FlatFile?: FlatFileResolvers<ContextType>;
  GitBranchChangedEvent?: GitBranchChangedEventResolvers<ContextType>;
  GitBranchDiffFile?: GitBranchDiffFileResolvers<ContextType>;
  GitBranchDiffFilesResult?: GitBranchDiffFilesResultResolvers<ContextType>;
  GitBranchFileDiffResult?: GitBranchFileDiffResultResolvers<ContextType>;
  GitBranchInfo?: GitBranchInfoResolvers<ContextType>;
  GitBranchInfoResult?: GitBranchInfoResultResolvers<ContextType>;
  GitBranchWithStatus?: GitBranchWithStatusResolvers<ContextType>;
  GitBranchesResult?: GitBranchesResultResolvers<ContextType>;
  GitBranchesWithStatusResult?: GitBranchesWithStatusResultResolvers<ContextType>;
  GitCommitResult?: GitCommitResultResolvers<ContextType>;
  GitDiffResult?: GitDiffResultResolvers<ContextType>;
  GitDiffStatFile?: GitDiffStatFileResolvers<ContextType>;
  GitDiffStatResult?: GitDiffStatResultResolvers<ContextType>;
  GitFileContentBase64Result?: GitFileContentBase64ResultResolvers<ContextType>;
  GitFileContentResult?: GitFileContentResultResolvers<ContextType>;
  GitFileStatus?: GitFileStatusResolvers<ContextType>;
  GitFileStatusesResult?: GitFileStatusesResultResolvers<ContextType>;
  GitIsMergedResult?: GitIsMergedResultResolvers<ContextType>;
  GitMergeResult?: GitMergeResultResolvers<ContextType>;
  GitPR?: GitPrResolvers<ContextType>;
  GitPRListResult?: GitPrListResultResolvers<ContextType>;
  GitPRReviewCommentsResult?: GitPrReviewCommentsResultResolvers<ContextType>;
  GitPRStateResult?: GitPrStateResultResolvers<ContextType>;
  GitRefContentResult?: GitRefContentResultResolvers<ContextType>;
  GitRemoteUrlResult?: GitRemoteUrlResultResolvers<ContextType>;
  GitStatusChangedEvent?: GitStatusChangedEventResolvers<ContextType>;
  ImportResult?: ImportResultResolvers<ContextType>;
  JSON?: GraphQLScalarType;
  KanbanTicket?: KanbanTicketResolvers<ContextType>;
  Mutation?: MutationResolvers<ContextType>;
  OpenCodeAgent?: OpenCodeAgentResolvers<ContextType>;
  OpenCodeAgentsResult?: OpenCodeAgentsResultResolvers<ContextType>;
  OpenCodeCapabilities?: OpenCodeCapabilitiesResolvers<ContextType>;
  OpenCodeCapabilitiesResult?: OpenCodeCapabilitiesResultResolvers<ContextType>;
  OpenCodeCommand?: OpenCodeCommandResolvers<ContextType>;
  OpenCodeCommandsResult?: OpenCodeCommandsResultResolvers<ContextType>;
  OpenCodeConnectResult?: OpenCodeConnectResultResolvers<ContextType>;
  OpenCodeForkResult?: OpenCodeForkResultResolvers<ContextType>;
  OpenCodeMessagesResult?: OpenCodeMessagesResultResolvers<ContextType>;
  OpenCodeModelInfoResult?: OpenCodeModelInfoResultResolvers<ContextType>;
  OpenCodeModelsResult?: OpenCodeModelsResultResolvers<ContextType>;
  OpenCodePermissionListResult?: OpenCodePermissionListResultResolvers<ContextType>;
  OpenCodeReconnectResult?: OpenCodeReconnectResultResolvers<ContextType>;
  OpenCodeRedoResult?: OpenCodeRedoResultResolvers<ContextType>;
  OpenCodeSessionInfoResult?: OpenCodeSessionInfoResultResolvers<ContextType>;
  OpenCodeStreamEvent?: OpenCodeStreamEventResolvers<ContextType>;
  OpenCodeUndoResult?: OpenCodeUndoResultResolvers<ContextType>;
  PRReviewComment?: PrReviewCommentResolvers<ContextType>;
  PRReviewUser?: PrReviewUserResolvers<ContextType>;
  PermissionRequest?: PermissionRequestResolvers<ContextType>;
  PermissionTool?: PermissionToolResolvers<ContextType>;
  Project?: ProjectResolvers<ContextType>;
  ProjectSpaceAssignment?: ProjectSpaceAssignmentResolvers<ContextType>;
  ProjectValidateResult?: ProjectValidateResultResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  RemoteIssue?: RemoteIssueResolvers<ContextType>;
  RemoteIssueListResult?: RemoteIssueListResultResolvers<ContextType>;
  RemoteStatus?: RemoteStatusResolvers<ContextType>;
  ScriptArchiveResult?: ScriptArchiveResultResolvers<ContextType>;
  ScriptOutputEvent?: ScriptOutputEventResolvers<ContextType>;
  ScriptRunResult?: ScriptRunResultResolvers<ContextType>;
  ServerStatus?: ServerStatusResolvers<ContextType>;
  Session?: SessionResolvers<ContextType>;
  SessionStatusPayload?: SessionStatusPayloadResolvers<ContextType>;
  SessionWithWorktree?: SessionWithWorktreeResolvers<ContextType>;
  SettingEntry?: SettingEntryResolvers<ContextType>;
  SettingsFieldInfo?: SettingsFieldInfoResolvers<ContextType>;
  Space?: SpaceResolvers<ContextType>;
  Subscription?: SubscriptionResolvers<ContextType>;
  SuccessResult?: SuccessResultResolvers<ContextType>;
  TerminalCreateResult?: TerminalCreateResultResolvers<ContextType>;
  TerminalDataEvent?: TerminalDataEventResolvers<ContextType>;
  TerminalExitEvent?: TerminalExitEventResolvers<ContextType>;
  TicketProviderInfo?: TicketProviderInfoResolvers<ContextType>;
  UsageResult?: UsageResultResolvers<ContextType>;
  Worktree?: WorktreeResolvers<ContextType>;
  WorktreeBranchRenamedEvent?: WorktreeBranchRenamedEventResolvers<ContextType>;
  WorktreeCreateResult?: WorktreeCreateResultResolvers<ContextType>;
}>;

