import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DiscordResource, Project, Session, Worktree } from '../../../../main/db'
import { encodePath } from '../../../../main/services/claude-transcript-reader'
import { makeTeleportOpsRpcService } from '../teleport-ops'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

const now = '2026-06-04T00:00:00.000Z'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'repo',
    path: '/remote/repo',
    description: null,
    tags: null,
    language: null,
    custom_icon: null,
    detected_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    worktree_create_script: null,
    custom_commands: null,
    auto_assign_port: false,
    sort_order: 0,
    created_at: now,
    last_accessed_at: now,
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'worktree-1',
    project_id: 'project-1',
    name: 'repo',
    branch_name: 'teleport/abc123',
    path: '/remote/repo-teleport',
    status: 'active',
    is_default: false,
    branch_renamed: 1,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    attachments: '[]',
    pinned: 0,
    context: null,
    github_pr_number: null,
    github_pr_url: null,
    teleported_to: null,
    base_branch: null,
    created_at: now,
    last_accessed_at: now,
    ...overrides
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-remote',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: null,
    status: 'active',
    opencode_session_id: 'claude-session-1',
    claude_session_id: 'claude-session-1',
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'claude-sonnet-4',
    model_variant: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

function channel(overrides: Partial<DiscordResource> = {}): DiscordResource {
  return {
    id: 'discord-resource-1',
    project_id: 'project-1',
    worktree_id: 'worktree-1',
    discord_id: '1234567890',
    type: 'channel',
    guild_id: 'guild-1',
    managed_session_id: null,
    created_at: now,
    ...overrides
  }
}

describe('teleportOps.receive', () => {
  it('writes the transcript, pre-creates a Claude CLI session, and binds the Discord channel', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-teleport-rpc-'))
    tempDirs.push(baseDir)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(baseDir, '.claude'))

    const remoteProject = project({ path: join(baseDir, 'repo') })
    const remoteWorktree = worktree({ path: join(baseDir, 'repo-teleport') })
    const createdSession = session()
    const provisionedChannel = channel()

    const createSession = vi.fn(() => createdSession)
    const provision = vi.fn(async () => ({ created: 1, deleted: 0 }))
    const setDiscordResourceManagedSession = vi.fn(() => ({
      ...provisionedChannel,
      managed_session_id: createdSession.id
    }))

    const service = makeTeleportOpsRpcService({
      db: {
        getAllProjects: () => [remoteProject],
        getWorktreesByProject: () => [],
        getSessionsByWorktree: () => [],
        deleteSession: vi.fn(),
        createSession,
        getDiscordChannelResourceByWorktree: () => provisionedChannel,
        setDiscordResourceManagedSession,
        updateWorktree: vi.fn(),
        getProject: () => remoteProject,
        getWorktree: () => remoteWorktree,
        getSession: () => null
      },
      git: {
        fetch: vi.fn(),
        ensureRemoteProject: vi.fn(async () => remoteProject),
        ensureTeleportWorktree: vi.fn(async () => remoteWorktree),
        stageAll: vi.fn(),
        commit: vi.fn(),
        push: vi.fn(),
        getCurrentBranch: vi.fn(),
        getRemoteUrl: vi.fn(),
        hasUncommittedChanges: vi.fn(),
        revParseHead: vi.fn()
      },
      discord: {
        getConfig: vi.fn(() => ({
          botToken: 'token',
          guildId: 'guild-1',
          guildName: 'Hive',
          enabled: true,
          selectedProjectIds: ['other-project']
        })),
        provision
      },
      remote: {
        receive: vi.fn()
      },
      isSessionBusy: () => false
    })

    const result = await Effect.runPromise(
      service.receive({
        gitUrl: 'git@github.com:org/repo.git',
        branch: 'main',
        headSha: 'abc123',
        projectName: 'repo',
        claudeSessionId: 'claude-session-1',
        transcript: '{"type":"user"}\n',
        model: {
          providerId: 'anthropic',
          id: 'claude-sonnet-4',
          variant: null
        },
        mode: 'build'
      })
    )

    const transcriptPath = join(
      process.env.CLAUDE_CONFIG_DIR!,
      'projects',
      encodePath(remoteWorktree.path),
      'claude-session-1.jsonl'
    )
    expect(existsSync(transcriptPath)).toBe(true)
    expect(readFileSync(transcriptPath, 'utf-8')).toBe('{"type":"user"}\n')
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree_id: remoteWorktree.id,
        project_id: remoteProject.id,
        agent_sdk: 'claude-code-cli',
        mode: 'build',
        opencode_session_id: 'claude-session-1',
        claude_session_id: 'claude-session-1',
        model_provider_id: 'anthropic',
        model_id: 'claude-sonnet-4',
        model_variant: null
      })
    )
    expect(setDiscordResourceManagedSession).toHaveBeenCalledWith(
      provisionedChannel.id,
      createdSession.id
    )
    // Must merge with the existing selection, not replace it — otherwise
    // provisioning would delete every other project's Discord channels.
    expect(provision).toHaveBeenCalledWith(['other-project', remoteProject.id])
    expect(result).toMatchObject({
      success: true,
      channelId: provisionedChannel.discord_id,
      channelUrl: 'https://discord.com/channels/guild-1/1234567890',
      remoteWorktreeId: remoteWorktree.id
    })
  })

  it('fails clearly before provisioning when Discord is disabled', async () => {
    const service = makeTeleportOpsRpcService({
      db: {
        getAllProjects: () => [],
        getWorktreesByProject: () => [],
        getSessionsByWorktree: () => [],
        deleteSession: vi.fn(),
        createSession: vi.fn(),
        getDiscordChannelResourceByWorktree: () => null,
        setDiscordResourceManagedSession: vi.fn(),
        updateWorktree: vi.fn(),
        getProject: () => null,
        getWorktree: () => null,
        getSession: () => null
      },
      git: {
        fetch: vi.fn(),
        ensureRemoteProject: vi.fn(),
        ensureTeleportWorktree: vi.fn(),
        stageAll: vi.fn(),
        commit: vi.fn(),
        push: vi.fn(),
        getCurrentBranch: vi.fn(),
        getRemoteUrl: vi.fn(),
        hasUncommittedChanges: vi.fn(),
        revParseHead: vi.fn()
      },
      discord: {
        getConfig: vi.fn(() => null),
        provision: vi.fn()
      },
      remote: {
        receive: vi.fn()
      },
      isSessionBusy: () => false
    })

    await expect(
      Effect.runPromise(
        service.receive({
          gitUrl: 'git@github.com:org/repo.git',
          branch: 'main',
          headSha: 'abc123',
          projectName: 'repo',
          claudeSessionId: 'claude-session-1',
          transcript: '{}\n',
          model: { providerId: null, id: null, variant: null },
          mode: 'build'
        })
      )
    ).rejects.toThrow('Remote has no Discord configured')
  })

  it('reuses an existing teleport worktree and session instead of duplicating them', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-teleport-rpc-'))
    tempDirs.push(baseDir)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(baseDir, '.claude'))

    const remoteProject = project({ path: join(baseDir, 'repo') })
    const existingWorktree = worktree({
      id: 'wt-existing',
      branch_name: 'main',
      path: join(baseDir, 'repo-existing')
    })
    const existingSession = session({ id: 'sess-existing', claude_session_id: 'claude-session-1' })
    const provisionedChannel = channel({ worktree_id: 'wt-existing' })

    const ensureTeleportWorktree = vi.fn()
    const createSession = vi.fn()

    const service = makeTeleportOpsRpcService({
      db: {
        getAllProjects: () => [remoteProject],
        getWorktreesByProject: () => [existingWorktree],
        getSessionsByWorktree: () => [existingSession],
        deleteSession: vi.fn(),
        createSession,
        getDiscordChannelResourceByWorktree: () => provisionedChannel,
        setDiscordResourceManagedSession: vi.fn(),
        updateWorktree: vi.fn(),
        getProject: () => remoteProject,
        getWorktree: () => existingWorktree,
        getSession: () => null
      },
      git: {
        fetch: vi.fn(),
        ensureRemoteProject: vi.fn(async () => remoteProject),
        ensureTeleportWorktree,
        stageAll: vi.fn(),
        commit: vi.fn(),
        push: vi.fn(),
        getCurrentBranch: vi.fn(),
        getRemoteUrl: vi.fn(),
        hasUncommittedChanges: vi.fn(),
        revParseHead: vi.fn()
      },
      discord: {
        getConfig: vi.fn(() => ({
          botToken: 'token',
          guildId: 'guild-1',
          guildName: 'Hive',
          enabled: true,
          selectedProjectIds: ['project-1']
        })),
        provision: vi.fn(async () => ({ created: 0, deleted: 0 }))
      },
      remote: { receive: vi.fn() },
      isSessionBusy: () => false
    })

    const result = await Effect.runPromise(
      service.receive({
        gitUrl: 'git@github.com:org/repo.git',
        branch: 'main',
        headSha: 'abc123',
        projectName: 'repo',
        claudeSessionId: 'claude-session-1',
        transcript: '{"type":"user"}\n',
        model: { providerId: 'anthropic', id: 'claude-sonnet-4', variant: null },
        mode: 'build'
      })
    )

    expect(ensureTeleportWorktree).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      success: true,
      remoteWorktreeId: 'wt-existing',
      remoteSessionId: 'sess-existing'
    })
  })

  it('rolls back the created session when provisioning fails', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-teleport-rpc-'))
    tempDirs.push(baseDir)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(baseDir, '.claude'))

    const remoteProject = project({ path: join(baseDir, 'repo') })
    const remoteWorktree = worktree({ path: join(baseDir, 'repo-teleport') })
    const createdSession = session({ id: 'sess-new' })

    const deleteSession = vi.fn()

    const service = makeTeleportOpsRpcService({
      db: {
        getAllProjects: () => [remoteProject],
        getWorktreesByProject: () => [],
        getSessionsByWorktree: () => [],
        deleteSession,
        createSession: vi.fn(() => createdSession),
        getDiscordChannelResourceByWorktree: () => null,
        setDiscordResourceManagedSession: vi.fn(),
        updateWorktree: vi.fn(),
        getProject: () => remoteProject,
        getWorktree: () => remoteWorktree,
        getSession: () => null
      },
      git: {
        fetch: vi.fn(),
        ensureRemoteProject: vi.fn(async () => remoteProject),
        ensureTeleportWorktree: vi.fn(async () => remoteWorktree),
        stageAll: vi.fn(),
        commit: vi.fn(),
        push: vi.fn(),
        getCurrentBranch: vi.fn(),
        getRemoteUrl: vi.fn(),
        hasUncommittedChanges: vi.fn(),
        revParseHead: vi.fn()
      },
      discord: {
        getConfig: vi.fn(() => ({
          botToken: 'token',
          guildId: 'guild-1',
          guildName: 'Hive',
          enabled: true,
          selectedProjectIds: ['project-1']
        })),
        provision: vi.fn(async () => {
          throw new Error('discord boom')
        })
      },
      remote: { receive: vi.fn() },
      isSessionBusy: () => false
    })

    await expect(
      Effect.runPromise(
        service.receive({
          gitUrl: 'git@github.com:org/repo.git',
          branch: 'main',
          headSha: 'abc123',
          projectName: 'repo',
          claudeSessionId: 'claude-session-1',
          transcript: '{"type":"user"}\n',
          model: { providerId: 'anthropic', id: 'claude-sonnet-4', variant: null },
          mode: 'build'
        })
      )
    ).rejects.toThrow('discord boom')

    expect(deleteSession).toHaveBeenCalledWith('sess-new')
  })
})

describe('teleportOps.start gating', () => {
  function makeStartService(opts: {
    isSessionBusy: boolean
    session?: Session | null
    getRemoteUrl?: () => Promise<{ success: boolean; url?: string; error?: string }>
  }) {
    const localSession = opts.session === undefined ? session() : opts.session
    const localWorktree = worktree()
    const localProject = project()
    return makeTeleportOpsRpcService({
      db: {
        getAllProjects: () => [localProject],
        getWorktreesByProject: () => [localWorktree],
        getSessionsByWorktree: () => [],
        deleteSession: vi.fn(),
        createSession: vi.fn(),
        getDiscordChannelResourceByWorktree: () => null,
        setDiscordResourceManagedSession: vi.fn(),
        updateWorktree: vi.fn(),
        getProject: () => localProject,
        getWorktree: () => localWorktree,
        getSession: () => localSession
      },
      git: {
        fetch: vi.fn(),
        ensureRemoteProject: vi.fn(),
        ensureTeleportWorktree: vi.fn(),
        stageAll: vi.fn(),
        commit: vi.fn(),
        push: vi.fn(),
        getCurrentBranch: vi.fn(async () => 'feature'),
        getRemoteUrl:
          opts.getRemoteUrl ?? vi.fn(async () => ({ success: false, error: 'no remote' })),
        hasUncommittedChanges: vi.fn(),
        revParseHead: vi.fn()
      },
      discord: {
        getConfig: vi.fn(() => null),
        provision: vi.fn()
      },
      remote: {
        receive: vi.fn()
      },
      isSessionBusy: () => opts.isSessionBusy
    })
  }

  it('rejects a busy session at the validate step', async () => {
    const service = makeStartService({ isSessionBusy: true })
    const result = await Effect.runPromise(service.start({ sessionId: 'session-remote' }))
    expect(result.success).toBe(false)
    expect(result.step).toBe('validate')
    expect(result.error).toBe('Stop the Claude Code CLI session before teleporting it')
  })

  it('passes the busy gate for an idle session even when its DB status is active', async () => {
    // The session has DB status 'active' (the default), which used to wrongly
    // block teleport. With the live-status gate it now proceeds past validate
    // and fails later at git-remote.
    const service = makeStartService({ isSessionBusy: false })
    const result = await Effect.runPromise(service.start({ sessionId: 'session-remote' }))
    expect(result.success).toBe(false)
    expect(result.step).toBe('git-remote')
  })
})
