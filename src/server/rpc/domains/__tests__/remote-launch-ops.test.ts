import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { Project, Session, SessionCreate, Worktree } from '../../../../main/db'
import type { RemoteLaunchOpsDeps } from '../remote-launch-ops'
import {
  classifyTmuxKillError,
  makeRemoteLaunchOpsRpcService
} from '../remote-launch-ops'
import type {
  RemoteLaunchApplySetupPlanResult,
  RemoteLaunchLaunchResult,
  RemoteLaunchPingResult,
  RemoteLaunchPrepareResult,
  RemoteLaunchProgressEvent,
  RemoteLaunchStartParams
} from '../../../../shared/types/remote-launch'

const now = '2026-07-09T00:00:00.000Z'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'repo',
    path: '/local/repo',
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
    branch_name: 'feature/x',
    path: '/remote/repo-feature-x',
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
    id: 'session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: null,
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'claude-sonnet-4',
    model_variant: null,
    remote_launch: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

/** Full deps with working happy-path defaults; tests override the pieces they exercise. */
function baseDeps(overrides: Partial<RemoteLaunchOpsDeps> = {}): RemoteLaunchOpsDeps {
  return {
    db: {
      getProject: vi.fn(() => project()),
      getWorktree: vi.fn(() => worktree()),
      getSession: vi.fn(() => session()),
      createSession: vi.fn((_data: SessionCreate) => session({ id: 'local-session-1' })),
      updateSession: vi.fn(() => session()),
      findSessionByRemoteLaunchId: vi.fn(() => null)
    },
    git: {
      getRemoteUrl: vi.fn(async () => ({ success: true, url: 'git@github.com:org/repo.git' })),
      branchExistsOnOrigin: vi.fn(async () => true),
      fetchOrigin: vi.fn(async () => undefined),
      aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })),
      revParse: vi.fn(async () => 'abc123')
    },
    remote: {
      isConfigured: vi.fn(() => true),
      getUrl: vi.fn(() => 'https://remote.example.com'),
      request: vi.fn(async () => {
        throw new Error('unstubbed remote.request call')
      })
    },
    publishProgress: vi.fn(),
    fs: {
      stat: vi.fn(async () => ({ isFile: true, isDirectory: false })),
      readFileBase64: vi.fn(async () => 'YmFzZTY0'),
      mkdirp: vi.fn(async () => undefined),
      writeFileBase64: vi.fn(async () => undefined)
    },
    ensureRemoteProject: vi.fn(async () => project({ id: 'remote-project-1', path: '/remote/repo' })),
    createWorktreeFromBranch: vi.fn(async () => ({
      success: true,
      worktree: worktree({ id: 'remote-worktree-1', path: '/remote/repo-feature-x' })
    })),
    runSetupCommand: vi.fn(async () => ({ success: true })),
    tmux: {
      hasSession: vi.fn(async () => false),
      killSession: vi.fn(async () => ({ killed: true, alreadyDead: false }))
    },
    desktopLaunchTmux: vi.fn(async () => ({ success: true, tmuxSession: 'hive-feature-x' })),
    pty: {
      create: vi.fn(),
      attachListeners: vi.fn()
    },
    ping: {
      gitAvailable: vi.fn(async () => true),
      tmuxAvailable: vi.fn(async () => true),
      claudeBinary: vi.fn(() => '/usr/local/bin/claude')
    },
    paths: {
      remoteLaunchPromptFile: vi.fn((sessionId: string) => `/home/user/.hive/remote-launch/${sessionId}.prompt.txt`)
    },
    ...overrides
  }
}

const okPing: RemoteLaunchPingResult = { ok: true, git: true, tmux: true, claude: true }

const okPrepare: RemoteLaunchPrepareResult = {
  remoteProjectId: 'remote-project-1',
  remoteWorktreeId: 'remote-worktree-1',
  remoteSessionId: 'remote-session-1',
  remoteWorktreePath: '/remote/repo-feature-x',
  remoteBranch: 'feature/x',
  reused: false
}

const okApplySetupPlan: RemoteLaunchApplySetupPlanResult = { success: true }

const okLaunch: RemoteLaunchLaunchResult = { tmuxSession: 'hive-feature-x' }

function makeRequestMock(
  overrides: Partial<Record<string, (...args: unknown[]) => Promise<unknown>>> = {}
): (method: string, params: unknown, timeoutMs: number) => Promise<unknown> {
  const table: Record<string, (params: unknown) => Promise<unknown>> = {
    'remoteLaunchOps.ping': async () => okPing,
    'remoteLaunchOps.prepare': async () => okPrepare,
    'remoteLaunchOps.applySetupPlan': async () => okApplySetupPlan,
    'remoteLaunchOps.launch': async () => okLaunch,
    ...overrides
  }
  return async (method: string, params: unknown) => {
    const handler = table[method]
    if (!handler) throw new Error(`unstubbed remote.request call: ${method}`)
    return handler(params)
  }
}

const startParams: RemoteLaunchStartParams = {
  launchId: 'launch-1',
  ticketId: 'ticket-1',
  projectId: 'project-1',
  branch: 'feature/x',
  prompt: 'implement the thing',
  mode: 'build',
  model: { providerId: 'anthropic', id: 'claude-sonnet-4', variant: null },
  ticketTitle: 'Implement the thing'
}

function stepEvents(publishProgress: ReturnType<typeof vi.fn>): [string, RemoteLaunchProgressEvent][] {
  return publishProgress.mock.calls.map(([launchId, event]) => [
    launchId as string,
    event as RemoteLaunchProgressEvent
  ])
}

describe('remoteLaunchOps.start', () => {
  it('publishes running/done for all 7 steps in order and creates the local client session', async () => {
    const publishProgress = vi.fn()
    const createSession = vi.fn((_data: SessionCreate) => session({ id: 'local-session-1' }))
    const deps = baseDeps({
      publishProgress,
      remote: {
        isConfigured: vi.fn(() => true),
        getUrl: vi.fn(() => 'https://remote.example.com'),
        request: makeRequestMock() as RemoteLaunchOpsDeps['remote']['request']
      },
      db: { ...baseDeps().db, createSession }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(service.start(startParams))

    expect(result).toEqual({ success: true, localSessionId: 'local-session-1', tmuxSession: 'hive-feature-x' })

    const events = stepEvents(publishProgress)
    expect(events.map(([, e]) => `${e.step}:${e.status}`)).toEqual([
      'connect:running',
      'connect:done',
      'branch-check:running',
      'branch-check:done',
      'clone:running',
      'clone:done',
      'worktree:running',
      'worktree:done',
      'file-transfer:running',
      'file-transfer:done',
      'setup-script:running',
      'setup-script:done',
      'launch:running',
      'launch:done'
    ])
    expect(events.every(([launchId]) => launchId === 'launch-1')).toBe(true)

    expect(createSession).toHaveBeenCalledTimes(1)
    const createArgs = createSession.mock.calls[0]![0]
    expect(createArgs.worktree_id).toBeNull()
    expect(createArgs.project_id).toBe('project-1')
    expect(createArgs.agent_sdk).toBe('claude-code-cli')
    const clientInfo = JSON.parse(createArgs.remote_launch as string)
    expect(clientInfo).toMatchObject({
      role: 'client',
      url: 'https://remote.example.com',
      remoteSessionId: 'remote-session-1',
      remoteWorktreeId: 'remote-worktree-1',
      remoteProjectId: 'remote-project-1',
      tmuxSession: 'hive-feature-x',
      branch: 'feature/x',
      worktreePath: '/remote/repo-feature-x'
    })
    expect(typeof clientInfo.launchedAt).toBe('string')
  })

  it('ping failure surfaces at the connect step', async () => {
    const publishProgress = vi.fn()
    const deps = baseDeps({
      publishProgress,
      remote: {
        isConfigured: vi.fn(() => true),
        getUrl: vi.fn(() => 'https://remote.example.com'),
        request: makeRequestMock({
          'remoteLaunchOps.ping': async () => ({ ok: false, git: true, tmux: false, claude: true })
        }) as RemoteLaunchOpsDeps['remote']['request']
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(service.start(startParams))

    expect(result.success).toBe(false)
    expect(result.step).toBe('connect')
    expect(result.error).toContain('tmux')

    const events = stepEvents(publishProgress)
    expect(events.map(([, e]) => `${e.step}:${e.status}`)).toEqual(['connect:running', 'connect:error'])
  })

  it('prepare rejection surfaces at the clone step', async () => {
    const publishProgress = vi.fn()
    const deps = baseDeps({
      publishProgress,
      remote: {
        isConfigured: vi.fn(() => true),
        getUrl: vi.fn(() => 'https://remote.example.com'),
        request: makeRequestMock({
          'remoteLaunchOps.prepare': async () => {
            throw new Error('prepare boom')
          }
        }) as RemoteLaunchOpsDeps['remote']['request']
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(service.start(startParams))

    expect(result).toEqual({ success: false, step: 'clone', error: 'prepare boom' })
    const events = stepEvents(publishProgress)
    expect(events.map(([, e]) => `${e.step}:${e.status}`)).toEqual([
      'connect:running',
      'connect:done',
      'branch-check:running',
      'branch-check:done',
      'clone:running',
      'clone:error'
    ])
  })

  it('applySetupPlan failedKind "write" surfaces at file-transfer', async () => {
    const publishProgress = vi.fn()
    const deps = baseDeps({
      publishProgress,
      db: { ...baseDeps().db, getProject: vi.fn(() => project({ setup_script: 'cp /abs/.env .env\nnpm ci' })) },
      remote: {
        isConfigured: vi.fn(() => true),
        getUrl: vi.fn(() => 'https://remote.example.com'),
        request: makeRequestMock({
          'remoteLaunchOps.applySetupPlan': async () => ({
            success: false,
            failedStepIndex: 0,
            failedKind: 'write',
            error: 'permission denied'
          })
        }) as RemoteLaunchOpsDeps['remote']['request']
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(service.start(startParams))

    expect(result).toEqual({ success: false, step: 'file-transfer', error: 'permission denied' })
    const events = stepEvents(publishProgress)
    expect(events.map(([, e]) => `${e.step}:${e.status}`)).toEqual([
      'connect:running',
      'connect:done',
      'branch-check:running',
      'branch-check:done',
      'clone:running',
      'clone:done',
      'worktree:running',
      'worktree:done',
      'file-transfer:running',
      'file-transfer:error'
    ])
  })

  it('applySetupPlan failedKind "run" surfaces at setup-script', async () => {
    const publishProgress = vi.fn()
    const deps = baseDeps({
      publishProgress,
      db: { ...baseDeps().db, getProject: vi.fn(() => project({ setup_script: 'cp /abs/.env .env\nnpm ci' })) },
      remote: {
        isConfigured: vi.fn(() => true),
        getUrl: vi.fn(() => 'https://remote.example.com'),
        request: makeRequestMock({
          'remoteLaunchOps.applySetupPlan': async () => ({
            success: false,
            failedStepIndex: 1,
            failedKind: 'run',
            error: 'npm ci exited 1'
          })
        }) as RemoteLaunchOpsDeps['remote']['request']
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(service.start(startParams))

    expect(result).toEqual({ success: false, step: 'setup-script', error: 'npm ci exited 1' })
    const events = stepEvents(publishProgress)
    expect(events.map(([, e]) => `${e.step}:${e.status}`)).toEqual([
      'connect:running',
      'connect:done',
      'branch-check:running',
      'branch-check:done',
      'clone:running',
      'clone:done',
      'worktree:running',
      'worktree:done',
      'file-transfer:running',
      'file-transfer:done',
      'setup-script:running',
      'setup-script:error'
    ])
  })

  it('launch rejection surfaces at the launch step', async () => {
    const publishProgress = vi.fn()
    const deps = baseDeps({
      publishProgress,
      remote: {
        isConfigured: vi.fn(() => true),
        getUrl: vi.fn(() => 'https://remote.example.com'),
        request: makeRequestMock({
          'remoteLaunchOps.launch': async () => {
            throw new Error('launch boom')
          }
        }) as RemoteLaunchOpsDeps['remote']['request']
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(service.start(startParams))

    expect(result).toEqual({ success: false, step: 'launch', error: 'launch boom' })
  })

  it('hard-fails at branch-check when the branch is missing on origin, without calling prepare/applySetupPlan/launch', async () => {
    const publishProgress = vi.fn()
    const request = vi.fn(makeRequestMock())
    const deps = baseDeps({
      publishProgress,
      git: { ...baseDeps().git, branchExistsOnOrigin: vi.fn(async () => false) },
      remote: {
        isConfigured: vi.fn(() => true),
        getUrl: vi.fn(() => 'https://remote.example.com'),
        request: request as unknown as RemoteLaunchOpsDeps['remote']['request']
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(service.start(startParams))

    expect(result.success).toBe(false)
    expect(result.step).toBe('branch-check')
    // Only the connect-step ping call should have gone out.
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe('remoteLaunchOps.ping')
  })

  it('empty setup script skips applySetupPlan but still publishes file-transfer/setup-script done', async () => {
    const publishProgress = vi.fn()
    const request = vi.fn(makeRequestMock())
    const deps = baseDeps({
      publishProgress,
      db: { ...baseDeps().db, getProject: vi.fn(() => project({ setup_script: null })) },
      remote: {
        isConfigured: vi.fn(() => true),
        getUrl: vi.fn(() => 'https://remote.example.com'),
        request: request as unknown as RemoteLaunchOpsDeps['remote']['request']
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(service.start(startParams))

    expect(result.success).toBe(true)
    expect(request.mock.calls.map((call) => call[0])).not.toContain('remoteLaunchOps.applySetupPlan')
    const events = stepEvents(publishProgress)
    expect(events.map(([, e]) => `${e.step}:${e.status}`)).toContain('file-transfer:done')
    expect(events.map(([, e]) => `${e.step}:${e.status}`)).toContain('setup-script:done')
  })

  it('a cp parser error fails at file-transfer before any applySetupPlan call', async () => {
    const publishProgress = vi.fn()
    const request = vi.fn(makeRequestMock())
    const deps = baseDeps({
      publishProgress,
      db: {
        ...baseDeps().db,
        getProject: vi.fn(() => project({ setup_script: 'cp -r /x .' }))
      },
      remote: {
        isConfigured: vi.fn(() => true),
        getUrl: vi.fn(() => 'https://remote.example.com'),
        request: request as unknown as RemoteLaunchOpsDeps['remote']['request']
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(service.start(startParams))

    expect(result.success).toBe(false)
    expect(result.step).toBe('file-transfer')
    expect(request.mock.calls.map((call) => call[0])).not.toContain('remoteLaunchOps.applySetupPlan')
  })
})

describe('remoteLaunchOps.prepare', () => {
  it('returns a reused result when findSessionByRemoteLaunchId hits, without calling ensureRemoteProject', async () => {
    const ensureRemoteProject = vi.fn(async () => project())
    const existingWorktree = worktree({ id: 'remote-worktree-9', path: '/remote/repo-existing' })
    const existingSession = session({ id: 'remote-session-9', worktree_id: 'remote-worktree-9' })
    const deps = baseDeps({
      ensureRemoteProject,
      db: {
        ...baseDeps().db,
        findSessionByRemoteLaunchId: vi.fn(() => existingSession),
        getWorktree: vi.fn(() => existingWorktree)
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(
      service.prepare({
        launchId: 'launch-1',
        gitUrl: 'git@github.com:org/repo.git',
        projectName: 'repo',
        branch: 'feature/x',
        mode: 'build',
        model: null
      })
    )

    expect(result).toEqual({
      remoteProjectId: existingWorktree.project_id,
      remoteWorktreeId: existingWorktree.id,
      remoteSessionId: existingSession.id,
      remoteWorktreePath: existingWorktree.path,
      remoteBranch: existingWorktree.branch_name,
      reused: true
    })
    expect(ensureRemoteProject).not.toHaveBeenCalled()
  })

  it('creates a fresh remote project/worktree/session when not previously launched', async () => {
    const createSession = vi.fn((_data: SessionCreate) =>
      session({ id: 'remote-session-new', worktree_id: 'remote-worktree-new' })
    )
    const deps = baseDeps({
      db: { ...baseDeps().db, findSessionByRemoteLaunchId: vi.fn(() => null), createSession }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(
      service.prepare({
        launchId: 'launch-2',
        gitUrl: 'git@github.com:org/repo.git',
        projectName: 'repo',
        branch: 'feature/x',
        mode: 'build',
        model: { providerId: 'anthropic', id: 'claude-sonnet-4', variant: null }
      })
    )

    expect(result.reused).toBe(false)
    expect(result.remoteSessionId).toBe('remote-session-new')
    const hostInfo = JSON.parse((createSession.mock.calls[0]![0].remote_launch as string) ?? 'null')
    expect(hostInfo).toEqual({ role: 'host', launchId: 'launch-2', tmuxSession: null, promptFile: null })
  })
})

describe('remoteLaunchOps.applySetupPlan', () => {
  it('executes write then run steps in order', async () => {
    const calls: string[] = []
    const deps = baseDeps({
      db: { ...baseDeps().db, getWorktree: vi.fn(() => worktree({ path: '/remote/repo-wt' })) },
      fs: {
        stat: vi.fn(async () => ({ isFile: true, isDirectory: false })),
        readFileBase64: vi.fn(async () => ''),
        mkdirp: vi.fn(async (dirPath: string) => {
          calls.push(`mkdirp:${dirPath}`)
        }),
        writeFileBase64: vi.fn(async (path: string) => {
          calls.push(`write:${path}`)
        })
      },
      runSetupCommand: vi.fn(async (command: string) => {
        calls.push(`run:${command}`)
        return { success: true }
      })
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(
      service.applySetupPlan({
        launchId: 'launch-1',
        remoteWorktreeId: 'worktree-1',
        steps: [
          { type: 'write', destRelPath: '.env', contentBase64: 'YQ==' },
          { type: 'run', command: 'npm ci' }
        ]
      })
    )

    expect(result).toEqual({ success: true })
    expect(calls).toEqual(['mkdirp:/remote/repo-wt', 'write:/remote/repo-wt/.env', 'run:npm ci'])
  })

  it('stops at the first failure and reports its index/kind', async () => {
    const runSetupCommand = vi.fn(async (command: string) => {
      if (command === 'fails') return { success: false, error: 'boom' }
      return { success: true }
    })
    const deps = baseDeps({
      db: { ...baseDeps().db, getWorktree: vi.fn(() => worktree({ path: '/remote/repo-wt' })) },
      runSetupCommand
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(
      service.applySetupPlan({
        launchId: 'launch-1',
        remoteWorktreeId: 'worktree-1',
        steps: [
          { type: 'run', command: 'ok-1' },
          { type: 'run', command: 'fails' },
          { type: 'run', command: 'never-runs' }
        ]
      })
    )

    expect(result).toEqual({ success: false, failedStepIndex: 1, failedKind: 'run', error: 'boom' })
    expect(runSetupCommand).toHaveBeenCalledTimes(2)
  })

  it('rejects a "../" escape and an absolute destRelPath without touching fs', async () => {
    const fs = {
      stat: vi.fn(async () => ({ isFile: true, isDirectory: false })),
      readFileBase64: vi.fn(async () => ''),
      mkdirp: vi.fn(async () => undefined),
      writeFileBase64: vi.fn(async () => undefined)
    }
    const deps = baseDeps({
      db: { ...baseDeps().db, getWorktree: vi.fn(() => worktree({ path: '/remote/repo-wt' })) },
      fs
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const escapeResult = await Effect.runPromise(
      service.applySetupPlan({
        launchId: 'launch-1',
        remoteWorktreeId: 'worktree-1',
        steps: [{ type: 'write', destRelPath: '../evil.txt', contentBase64: 'YQ==' }]
      })
    )
    expect(escapeResult).toMatchObject({ success: false, failedStepIndex: 0, failedKind: 'write' })

    const absoluteResult = await Effect.runPromise(
      service.applySetupPlan({
        launchId: 'launch-1',
        remoteWorktreeId: 'worktree-1',
        steps: [{ type: 'write', destRelPath: '/etc/passwd', contentBase64: 'YQ==' }]
      })
    )
    expect(absoluteResult).toMatchObject({ success: false, failedStepIndex: 0, failedKind: 'write' })

    expect(fs.mkdirp).not.toHaveBeenCalled()
    expect(fs.writeFileBase64).not.toHaveBeenCalled()
  })
})

describe('remoteLaunchOps.launch', () => {
  it('returns without invoking the desktop bridge when a live tmux session already exists', async () => {
    const desktopLaunchTmux = vi.fn(async () => ({ success: true, tmuxSession: 'hive-should-not-be-used' }))
    const hostSession = session({
      id: 'remote-session-1',
      worktree_id: 'worktree-1',
      remote_launch: JSON.stringify({
        role: 'host',
        launchId: 'launch-1',
        tmuxSession: 'hive-feature-x',
        promptFile: null
      })
    })
    const deps = baseDeps({
      desktopLaunchTmux,
      db: { ...baseDeps().db, getSession: vi.fn(() => hostSession) },
      tmux: { hasSession: vi.fn(async () => true), killSession: vi.fn(async () => ({ killed: true, alreadyDead: false })) }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(
      service.launch({ launchId: 'launch-1', remoteSessionId: 'remote-session-1', prompt: 'hi' })
    )

    expect(result).toEqual({ tmuxSession: 'hive-feature-x' })
    expect(desktopLaunchTmux).not.toHaveBeenCalled()
  })
})

describe('remoteLaunchOps.killTmux', () => {
  it('returns killed:true on success', async () => {
    const deps = baseDeps({
      tmux: { hasSession: vi.fn(async () => true), killSession: vi.fn(async () => ({ killed: true, alreadyDead: false })) }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(
      service.killTmux({ remoteSessionId: 'remote-session-1', tmuxSession: 'hive-feature-x' })
    )

    expect(result).toEqual({ killed: true, alreadyDead: false })
  })

  it('returns alreadyDead:true when the tmux session is already gone', async () => {
    const deps = baseDeps({
      tmux: {
        hasSession: vi.fn(async () => false),
        killSession: vi.fn(async () => ({ killed: false, alreadyDead: true }))
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(
      service.killTmux({ remoteSessionId: 'remote-session-1', tmuxSession: 'hive-feature-x' })
    )

    expect(result).toEqual({ killed: false, alreadyDead: true })
  })
})

describe('classifyTmuxKillError', () => {
  it('treats "session not found" stderr as already dead', () => {
    const error = Object.assign(new Error('exit 1'), { stderr: 'session not found: hive-x' })
    expect(classifyTmuxKillError(error)).toEqual({ killed: false, alreadyDead: true })
  })

  it('treats "no server running" stderr as already dead', () => {
    const error = Object.assign(new Error('exit 1'), { stderr: 'no server running on /tmp/tmux-501/default' })
    expect(classifyTmuxKillError(error)).toEqual({ killed: false, alreadyDead: true })
  })

  it('rethrows other failures', () => {
    const error = Object.assign(new Error('exit 1'), { stderr: 'permission denied' })
    expect(() => classifyTmuxKillError(error)).toThrow('permission denied')
  })
})

describe('remoteLaunchOps.attachTerminal', () => {
  it('errors when the tmux session has already exited', async () => {
    const hostSession = session({
      id: 'remote-session-1',
      worktree_id: 'worktree-1',
      remote_launch: JSON.stringify({
        role: 'host',
        launchId: 'launch-1',
        tmuxSession: 'hive-feature-x',
        promptFile: null
      })
    })
    const deps = baseDeps({
      db: { ...baseDeps().db, getSession: vi.fn(() => hostSession) },
      tmux: { hasSession: vi.fn(async () => false), killSession: vi.fn(async () => ({ killed: true, alreadyDead: false })) }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    await expect(
      Effect.runPromise(service.attachTerminal({ remoteSessionId: 'remote-session-1' }))
    ).rejects.toThrow('Remote session has exited')
  })

  it('returns a terminalId and wires pty listeners when the session is live', async () => {
    const hostSession = session({
      id: 'remote-session-1',
      worktree_id: 'worktree-1',
      remote_launch: JSON.stringify({
        role: 'host',
        launchId: 'launch-1',
        tmuxSession: 'hive-feature-x',
        promptFile: null
      })
    })
    const create = vi.fn()
    const attachListeners = vi.fn()
    const deps = baseDeps({
      db: {
        ...baseDeps().db,
        getSession: vi.fn(() => hostSession),
        getWorktree: vi.fn(() => worktree({ path: '/remote/repo-feature-x' }))
      },
      tmux: { hasSession: vi.fn(async () => true), killSession: vi.fn(async () => ({ killed: true, alreadyDead: false })) },
      pty: { create, attachListeners }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(
      service.attachTerminal({ remoteSessionId: 'remote-session-1', cols: 80, rows: 24 })
    )

    expect(result.terminalId).toMatch(/^remote-attach-remote-session-1-/)
    expect(create).toHaveBeenCalledWith(
      result.terminalId,
      expect.objectContaining({
        cwd: '/remote/repo-feature-x',
        command: 'tmux',
        args: ['attach-session', '-t', 'hive-feature-x'],
        cols: 80,
        rows: 24
      })
    )
    expect(attachListeners).toHaveBeenCalledWith(result.terminalId)
  })
})

describe('remoteLaunchOps.stop', () => {
  it('errors when the local session has no client remote_launch info', async () => {
    const deps = baseDeps({
      db: { ...baseDeps().db, getSession: vi.fn(() => session({ remote_launch: null })) }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    await expect(Effect.runPromise(service.stop({ sessionId: 'session-1' }))).rejects.toThrow(
      'Session is not a remote-launched client session'
    )
  })

  it('delegates to remoteLaunchOps.killTmux with the client remote_launch info', async () => {
    const request = vi.fn(async () => ({ killed: true, alreadyDead: false }))
    const clientSession = session({
      remote_launch: JSON.stringify({
        role: 'client',
        url: 'https://remote.example.com',
        remoteSessionId: 'remote-session-1',
        remoteWorktreeId: 'remote-worktree-1',
        remoteProjectId: 'remote-project-1',
        tmuxSession: 'hive-feature-x',
        branch: 'feature/x',
        worktreePath: '/remote/repo-feature-x',
        launchedAt: now
      })
    })
    const deps = baseDeps({
      db: { ...baseDeps().db, getSession: vi.fn(() => clientSession) },
      remote: {
        isConfigured: vi.fn(() => true),
        getUrl: vi.fn(() => 'https://remote.example.com'),
        request: request as unknown as RemoteLaunchOpsDeps['remote']['request']
      }
    })
    const service = makeRemoteLaunchOpsRpcService(deps)

    const result = await Effect.runPromise(service.stop({ sessionId: 'session-1' }))

    expect(result).toEqual({ killed: true, alreadyDead: false })
    expect(request).toHaveBeenCalledWith(
      'remoteLaunchOps.killTmux',
      { remoteSessionId: 'remote-session-1', tmuxSession: 'hive-feature-x' },
      15_000
    )
  })
})
