export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  InteractId: { input: string; output: string; }
};

export type GqlInvite = {
  __typename?: 'Invite';
  acceptedAt?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['String']['output'];
  email: Scalars['String']['output'];
  id: Scalars['InteractId']['output'];
  role: GqlInviteRole;
};

export type GqlInviteRole =
  | 'dev'
  | 'org_admin';

export type GqlMember = {
  __typename?: 'Member';
  email: Scalars['String']['output'];
  id: Scalars['InteractId']['output'];
  name?: Maybe<Scalars['String']['output']>;
  picture?: Maybe<Scalars['String']['output']>;
  role: GqlUserRole;
};

export type GqlMutation = {
  __typename?: 'Mutation';
  createOrganization: GqlOrganization;
  inviteMember: GqlInvite;
  recordPromptIdle: GqlPromptMutationResult;
  recordPromptStart: GqlPromptStartResult;
  removeMember: Scalars['Boolean']['output'];
};


export type GqlMutationCreateOrganizationArgs = {
  name: Scalars['String']['input'];
};


export type GqlMutationInviteMemberArgs = {
  email: Scalars['String']['input'];
  role: GqlInviteRole;
};


export type GqlMutationRecordPromptIdleArgs = {
  input: GqlPromptIdleInput;
};


export type GqlMutationRecordPromptStartArgs = {
  input: GqlPromptStartInput;
};


export type GqlMutationRemoveMemberArgs = {
  userId: Scalars['InteractId']['input'];
};

export type GqlOrganization = {
  __typename?: 'Organization';
  id: Scalars['InteractId']['output'];
  name: Scalars['String']['output'];
};

export type GqlPromptIdleInput = {
  cacheReadTokens: Scalars['Int']['input'];
  cacheWriteTokens: Scalars['Int']['input'];
  inputTokens: Scalars['Int']['input'];
  outputTokens: Scalars['Int']['input'];
  promptId: Scalars['InteractId']['input'];
};

export type GqlPromptMutationResult = {
  __typename?: 'PromptMutationResult';
  recorded: Scalars['Boolean']['output'];
};

export type GqlPromptStartInput = {
  connectionProjects?: InputMaybe<Scalars['String']['input']>;
  contextLength?: InputMaybe<Scalars['Int']['input']>;
  gitRemoteUrl?: InputMaybe<Scalars['String']['input']>;
  handoffSessionId?: InputMaybe<Scalars['String']['input']>;
  isGoalPrompt?: InputMaybe<Scalars['Boolean']['input']>;
  loggedAt?: InputMaybe<Scalars['String']['input']>;
  mode?: InputMaybe<Scalars['String']['input']>;
  modelId?: InputMaybe<Scalars['String']['input']>;
  modelProviderId?: InputMaybe<Scalars['String']['input']>;
  modelVariant?: InputMaybe<Scalars['String']['input']>;
  projectName?: InputMaybe<Scalars['String']['input']>;
  projectPath?: InputMaybe<Scalars['String']['input']>;
  prompt: Scalars['String']['input'];
  providerId?: InputMaybe<Scalars['String']['input']>;
  sessionId: Scalars['String']['input'];
  worktreeBranch?: InputMaybe<Scalars['String']['input']>;
  worktreeId?: InputMaybe<Scalars['String']['input']>;
  worktreePath?: InputMaybe<Scalars['String']['input']>;
};

export type GqlPromptStartResult = {
  __typename?: 'PromptStartResult';
  promptId?: Maybe<Scalars['InteractId']['output']>;
  recorded: Scalars['Boolean']['output'];
};

export type GqlQuery = {
  __typename?: 'Query';
  listInvites: Array<GqlInvite>;
  listMembers: Array<GqlMember>;
  listOrganizations: Array<GqlOrganization>;
  listUsers: Array<GqlMember>;
  me?: Maybe<GqlUser>;
};


export type GqlQueryListInvitesArgs = {
  orgId?: InputMaybe<Scalars['InteractId']['input']>;
};


export type GqlQueryListMembersArgs = {
  orgId?: InputMaybe<Scalars['InteractId']['input']>;
};

export type GqlUser = {
  __typename?: 'User';
  email: Scalars['String']['output'];
  id: Scalars['InteractId']['output'];
  name?: Maybe<Scalars['String']['output']>;
  organization?: Maybe<GqlOrganization>;
  picture?: Maybe<Scalars['String']['output']>;
  role: GqlUserRole;
};

export type GqlUserRole =
  | 'dev'
  | 'org_admin'
  | 'super_admin';

export type GqlHiveEnterpriseMeQueryVariables = Exact<{ [key: string]: never; }>;


export type GqlHiveEnterpriseMeQuery = (
  { __typename?: 'Query' }
  & { me?: Maybe<(
    { __typename?: 'User' }
    & Pick<GqlUser, 'id' | 'email' | 'role'>
    & { organization?: Maybe<(
      { __typename?: 'Organization' }
      & Pick<GqlOrganization, 'id' | 'name'>
    )> }
  )> }
);

export type GqlHiveEnterpriseRecordPromptStartMutationVariables = Exact<{
  input: GqlPromptStartInput;
}>;


export type GqlHiveEnterpriseRecordPromptStartMutation = (
  { __typename?: 'Mutation' }
  & { recordPromptStart: (
    { __typename?: 'PromptStartResult' }
    & Pick<GqlPromptStartResult, 'recorded' | 'promptId'>
  ) }
);

export type GqlHiveEnterpriseRecordPromptIdleMutationVariables = Exact<{
  input: GqlPromptIdleInput;
}>;


export type GqlHiveEnterpriseRecordPromptIdleMutation = (
  { __typename?: 'Mutation' }
  & { recordPromptIdle: (
    { __typename?: 'PromptMutationResult' }
    & Pick<GqlPromptMutationResult, 'recorded'>
  ) }
);
