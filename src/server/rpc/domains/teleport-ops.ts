import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { Effect } from 'effect'
import { z } from 'zod'
import type { DiscordConfig, DiscordProvisionSummary } from '@shared/types/discord'
import type { Project, Session, Worktree } from '../../../main/db'
import type { SessionMode } from '../../../main/db/types'
import type {
  GitOperationResult,
  GitPushResult,
  GitRemoteUrlResult
} from '../../../main/effect/git/types'
import {
  encodePath,
  readClaudeTranscriptRaw,
  resolveProjectsDir
} from '../../../main/services/claude-transcript-reader'
import type {
  TeleportRemoteReceiveParams,
  TeleportRemoteReceiveResult
} from '../../../main/services/teleport-remote-client'
import type { RpcHandler } from '../router'

const execFileAsync = promisify(execFile)

export interface TeleportStartResult {
  readonly success: boolean
  readonly step?: string
  readonly error?: string
  readonly channelUrl?: string
  readonly channelId?: string
  readonly remoteWorktreeId?: string
}

export type TeleportReceiveParams = TeleportRemoteReceiveParams
export type TeleportReceiveResult = TeleportRemoteReceiveResult

interface TeleportDb {
  getSession: (id: string) => Session | null
  getWorktree: (id: string) => Worktree | null
  getProject: (id: string) => Project | null
  getAllProjects?: () => Project[]
  getWorktreesByProject: (projectId: string) => Worktree[]
  createSession: (data: {
    worktree_id: string | null
    project_id: string
    name?: string | null
    opencode_session_id?: string | null
    claude_session_id?: string | null
    agent_sdk?: 'claude-code-cli'
    mode?: SessionMode
    model_provider_id?: string | null
    model_id?: string | null
    model_variant?: string | null
  }) => Session
  updateWorktree: (id: string, data: { teleported_to?: string | null }) => Worktree | null
  getDiscordChannelResourceByWorktree: (
    worktreeId: string
  ) => { id: string; discord_id: string; guild_id: string } | null
  setDiscordResourceManagedSession: (resourceId: string, sessionId: string | null) => unknown
}

interface TeleportGit {
  getCurrentBranch: (repoPath: string) => Promise<string>
  getRemoteUrl: (repoPath: string, remote?: string) => Promise<GitRemoteUrlResult>
  hasUncommittedChanges: (repoPath: string) => Promise<boolean>
  stageAll: (repoPath: string) => Promise<GitOperationResult>
  commit: (
    repoPath: string,
    message: string
  ) => Promise<{ success: boolean; commitHash?: string; error?: string }>
  push: (repoPath: string, remote?: string, branch?: string) => Promise<GitPushResult>
  revParseHead: (repoPath: string) => Promise<string>
  fetch: (repoPath: string) => Promise<void>
  ensureRemoteProject: (gitUrl: string, projectName: string) => Promise<Project>
  ensureTeleportWorktree: (project: Project, branch: string, headSha: string) => Promise<Worktree>
}

interface TeleportDiscord {
  getConfig: () => DiscordConfig | null
  provision: (projectIds: string[]) => Promise<DiscordProvisionSummary>
}

interface TeleportRemote {
  receive: (params: TeleportReceiveParams) => Promise<TeleportReceiveResult>
}

export interface TeleportOpsRpcService {
  readonly start: (params: {
    sessionId: string
  }) => Effect.Effect<TeleportStartResult, unknown, never>
  readonly receive: (
    params: TeleportReceiveParams
  ) => Effect.Effect<TeleportReceiveResult, unknown, never>
}

export interface TeleportOpsDeps {
  readonly db: TeleportDb
  readonly git: TeleportGit
  readonly discord: TeleportDiscord
  readonly remote: TeleportRemote
}

const modelSchema = z
  .object({
    providerId: z.string().nullable(),
    id: z.string().nullable(),
    variant: z.string().nullable()
  })
  .strict()

const receiveParamsSchema = z
  .object({
    gitUrl: z.string().min(1),
    branch: z.string().min(1),
    headSha: z.string().min(1),
    projectName: z.string().min(1),
    claudeSessionId: z.string().min(1),
    transcript: z.string(),
    model: modelSchema,
    mode: z.enum(['build', 'plan', 'super-plan'])
  })
  .strict() satisfies z.ZodType<TeleportReceiveParams>

const startParamsSchema = z.object({ sessionId: z.string().min(1) }).strict()

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const failStep = (step: string, error: unknown): TeleportStartResult => ({
  success: false,
  step,
  error: errorMessage(error)
})

function requireSuccess(result: { success: boolean; error?: string }, fallback: string): void {
  if (!result.success) throw new Error(result.error || fallback)
}

function discordChannelUrl(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`
}

function isDiscordConfigured(config: DiscordConfig | null): config is DiscordConfig {
  return !!config?.enabled && !!config.botToken.trim() && !!config.guildId.trim()
}

function findProjectWorktree(
  db: TeleportDb,
  session: Session
): { worktree: Worktree; project: Project } {
  if (!session.worktree_id) throw new Error('Session has no worktree')
  const worktree = db.getWorktree(session.worktree_id)
  if (!worktree) throw new Error('Session worktree not found')
  const project = db.getProject(session.project_id)
  if (!project) throw new Error('Session project not found')
  return { worktree, project }
}

async function startTeleport(
  deps: TeleportOpsDeps,
  params: { sessionId: string }
): Promise<TeleportStartResult> {
  let session: Session | null = null
  let worktree: Worktree | null = null
  let project: Project | null = null

  try {
    session = deps.db.getSession(params.sessionId)
    if (!session) throw new Error('Session not found')
    if (session.agent_sdk !== 'claude-code-cli') {
      throw new Error('Teleport only supports Claude Code CLI sessions')
    }
    if (session.status === 'active') {
      throw new Error('Stop the Claude Code CLI session before teleporting it')
    }
    if (!session.claude_session_id) {
      throw new Error('Claude session id is missing')
    }
    ;({ worktree, project } = findProjectWorktree(deps.db, session))
  } catch (error) {
    return failStep('validate', error)
  }

  let branch = ''
  let gitUrl = ''
  try {
    branch = await deps.git.getCurrentBranch(worktree.path)
    if (!branch) throw new Error('Current branch could not be resolved')
    const remote = await deps.git.getRemoteUrl(worktree.path, 'origin')
    if (!remote.success || !remote.url) {
      throw new Error(remote.error || 'Git remote "origin" is required for teleport')
    }
    gitUrl = remote.url
  } catch (error) {
    return failStep('git-remote', error)
  }

  let transcript = ''
  try {
    transcript = (await readClaudeTranscriptRaw(worktree.path, session.claude_session_id)) ?? ''
    if (!transcript) throw new Error('Claude transcript file not found')
  } catch (error) {
    return failStep('transcript', error)
  }

  let headSha = ''
  try {
    if (await deps.git.hasUncommittedChanges(worktree.path)) {
      requireSuccess(await deps.git.stageAll(worktree.path), 'Failed to stage teleport snapshot')
      requireSuccess(
        await deps.git.commit(worktree.path, 'Teleport snapshot'),
        'Failed to commit teleport snapshot'
      )
    }
    requireSuccess(
      await deps.git.push(worktree.path, 'origin', branch),
      'Failed to push teleport snapshot'
    )
    headSha = await deps.git.revParseHead(worktree.path)
  } catch (error) {
    return failStep('git-push', error)
  }

  try {
    const result = await deps.remote.receive({
      gitUrl,
      branch,
      headSha,
      projectName: project.name,
      claudeSessionId: session.claude_session_id,
      transcript,
      model: {
        providerId: session.model_provider_id,
        id: session.model_id,
        variant: session.model_variant
      },
      mode: session.mode
    })

    deps.db.updateWorktree(worktree.id, {
      teleported_to: JSON.stringify({
        url: gitUrl,
        channelUrl: result.channelUrl,
        channelId: result.channelId,
        remoteWorktreeId: result.remoteWorktreeId,
        teleportedAt: new Date().toISOString()
      })
    })

    return {
      success: true,
      channelUrl: result.channelUrl,
      channelId: result.channelId,
      remoteWorktreeId: result.remoteWorktreeId
    }
  } catch (error) {
    return failStep('remote-receive', error)
  }
}

async function receiveTeleport(
  deps: TeleportOpsDeps,
  params: TeleportReceiveParams
): Promise<TeleportReceiveResult> {
  const config = deps.discord.getConfig()
  if (!isDiscordConfigured(config)) {
    throw new Error('Remote has no Discord configured')
  }

  const project = await deps.git.ensureRemoteProject(params.gitUrl, params.projectName)
  const remoteWorktree = await deps.git.ensureTeleportWorktree(
    project,
    params.branch,
    params.headSha
  )

  const transcriptPath = join(
    resolveProjectsDir(),
    encodePath(remoteWorktree.path),
    `${params.claudeSessionId}.jsonl`
  )
  mkdirSync(dirname(transcriptPath), { recursive: true })
  writeFileSync(transcriptPath, params.transcript, 'utf-8')

  const session = deps.db.createSession({
    worktree_id: remoteWorktree.id,
    project_id: project.id,
    agent_sdk: 'claude-code-cli',
    mode: params.mode,
    opencode_session_id: params.claudeSessionId,
    claude_session_id: params.claudeSessionId,
    model_provider_id: params.model.providerId,
    model_id: params.model.id,
    model_variant: params.model.variant
  })

  await deps.discord.provision([project.id])
  const channel = deps.db.getDiscordChannelResourceByWorktree(remoteWorktree.id)
  if (!channel) throw new Error('Discord channel was not provisioned for the teleported worktree')
  deps.db.setDiscordResourceManagedSession(channel.id, session.id)

  return {
    success: true,
    channelId: channel.discord_id,
    channelUrl: discordChannelUrl(channel.guild_id, channel.discord_id),
    remoteWorktreeId: remoteWorktree.id,
    remoteSessionId: session.id
  }
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' })
  return stdout.trim()
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 64)
}

function uniquePath(basePath: string): string {
  if (!existsSync(basePath)) return basePath
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${basePath}-${i}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`Could not choose a free path for ${basePath}`)
}

async function isBranchCheckedOut(repoPath: string, branch: string): Promise<boolean> {
  const output = await execGit(repoPath, ['worktree', 'list', '--porcelain'])
  return output.split('\n').some((line) => line.trim() === `branch refs/heads/${branch}`)
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

async function createLiveDeps(): Promise<TeleportOpsDeps> {
  const [
    { getDatabase },
    { gitService },
    { cloneRepository, deriveProjectNameFromGitUrl },
    { createProjectWithDefaultWorktree },
    { syncWorktreesOp },
    { discordService },
    { sendTeleportReceive },
    { getTeleportSettings }
  ] = await Promise.all([
    import('../../../main/db'),
    import('../../../main/effect/git/facade'),
    import('../../../main/services/git-repository'),
    import('../../../main/services/project-ops'),
    import('../../../main/services/worktree-ops'),
    import('../../../main/services/discord-service'),
    import('../../../main/services/teleport-remote-client'),
    import('../../../main/services/teleport-remote-client')
  ])
  const db = getDatabase()

  return {
    db,
    git: {
      getCurrentBranch: (repoPath) => gitService.getCurrentBranch(repoPath),
      getRemoteUrl: (repoPath, remote) => gitService.getRemoteUrl(repoPath, remote),
      hasUncommittedChanges: (repoPath) => gitService.hasUncommittedChanges(repoPath),
      stageAll: (repoPath) => gitService.stageAll(repoPath),
      commit: (repoPath, message) => gitService.commit(repoPath, message),
      push: (repoPath, remote, branch) => gitService.push(repoPath, remote, branch),
      revParseHead: (repoPath) => execGit(repoPath, ['rev-parse', 'HEAD']),
      fetch: (repoPath) => execGit(repoPath, ['fetch', 'origin']).then(() => undefined),
      ensureRemoteProject: async (gitUrl, projectName) => {
        for (const candidate of db.getAllProjects()) {
          const remote = await gitService.getRemoteUrl(candidate.path, 'origin')
          if (remote.success && remote.url?.trim() === gitUrl.trim()) {
            await execGit(candidate.path, ['fetch', 'origin'])
            return candidate
          }
        }

        const derivedName = deriveProjectNameFromGitUrl(gitUrl) ?? projectName
        const destDir = uniquePath(join(homedir(), 'hive-projects', derivedName))
        mkdirSync(dirname(destDir), { recursive: true })
        const cloneResult = await cloneRepository(gitUrl, destDir)
        requireSuccess(cloneResult, 'Failed to clone remote project')
        const project = createProjectWithDefaultWorktree(db, { name: derivedName, path: destDir })
        requireSuccess(
          await syncWorktreesOp({ projectId: project.id, projectPath: destDir }),
          'Failed to sync cloned project worktrees'
        )
        return project
      },
      ensureTeleportWorktree: async (project, branch, headSha) => {
        await execGit(project.path, ['fetch', 'origin'])
        const short = headSha.slice(0, 8)
        const checkedOut = await isBranchCheckedOut(project.path, branch)
        const targetBranch = checkedOut ? `teleport/${short}` : branch
        if (checkedOut || !(await branchExists(project.path, targetBranch))) {
          await execGit(project.path, ['branch', '-f', targetBranch, headSha])
        }

        const worktreePath = uniquePath(
          join(dirname(project.path), `${basename(project.path)}-${slug(targetBranch)}`)
        )
        await execGit(project.path, ['worktree', 'add', worktreePath, targetBranch])
        requireSuccess(
          await syncWorktreesOp({ projectId: project.id, projectPath: project.path }),
          'Failed to sync teleported worktree'
        )
        const worktree = db.getWorktreeByPath(worktreePath)
        if (!worktree) throw new Error('Teleported worktree was not recorded')
        return worktree
      }
    },
    discord: {
      getConfig: () => discordService.getConfig(),
      provision: (projectIds) => discordService.provision(projectIds)
    },
    remote: {
      receive: (params) => {
        getTeleportSettings()
        return sendTeleportReceive(params)
      }
    }
  }
}

export const makeTeleportOpsRpcService = (deps: TeleportOpsDeps): TeleportOpsRpcService => ({
  start: (params) =>
    Effect.tryPromise({
      try: () => startTeleport(deps, params),
      catch: (cause) => cause
    }),
  receive: (params) =>
    Effect.tryPromise({
      try: () => receiveTeleport(deps, params),
      catch: (cause) => cause
    })
})

export const makeLiveTeleportOpsRpcService = (): TeleportOpsRpcService => ({
  start: (params) =>
    Effect.tryPromise({
      try: async () => startTeleport(await createLiveDeps(), params),
      catch: (cause) => cause
    }),
  receive: (params) =>
    Effect.tryPromise({
      try: async () => receiveTeleport(await createLiveDeps(), params),
      catch: (cause) => cause
    })
})

export const makeTeleportOpsRpcHandlers = (
  service: TeleportOpsRpcService = makeLiveTeleportOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'teleportOps.start',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => startParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.start(parsed)
        })
    ],
    [
      'teleportOps.receive',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => receiveParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.receive(parsed)
        })
    ]
  ])
