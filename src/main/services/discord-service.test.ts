import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_CREATED_CHANNEL } from '@shared/worktree-events'
import { DiscordService } from './discord-service'
import { createWorktreeFromBranchOp } from './worktree-ops'
import { createGitService } from './git-service'
import type { DiscordResource, Project, Worktree } from '../db/types'

const discordJsMock = vi.hoisted(() => {
  const instances: any[] = []

  class MockDiscordClient {
    readonly options: unknown
    readonly login = vi.fn(async () => 'logged-in')
    readonly destroy = vi.fn()
    readonly isReady = vi.fn(() => true)
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    private readonly onceHandlers = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor(options: unknown) {
      this.options = options
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return this
    }

    once(event: string, handler: (...args: unknown[]) => void): this {
      this.onceHandlers.set(event, [...(this.onceHandlers.get(event) ?? []), handler])
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args)
      }
      for (const handler of this.onceHandlers.get(event) ?? []) {
        handler(...args)
      }
      this.onceHandlers.delete(event)
    }
  }

  const Client = vi.fn((options: unknown) => {
    const client = new MockDiscordClient(options)
    instances.push(client)
    return client
  })

  return { Client, instances }
})

vi.mock('discord.js', () => ({
  ChannelType: {
    GuildCategory: 4,
    GuildText: 0
  },
  Client: discordJsMock.Client,
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 512,
    MessageContent: 32768
  }
}))

vi.mock('./worktree-ops', () => ({
  createWorktreeFromBranchOp: vi.fn()
}))

vi.mock('./git-service', () => ({
  createGitService: vi.fn(() => ({
    getDefaultBranch: vi.fn(async () => 'main')
  }))
}))

class FakeDiscordDatabase {
  settings = new Map<string, string>()
  resources: DiscordResource[] = []
  projects: Project[] = []
  activeWorktrees = new Map<string, Worktree[]>()

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null
  }

  setSetting(key: string, value: string): void {
    this.settings.set(key, value)
  }

  getAllProjects(): Project[] {
    return this.projects
  }

  getProject(id: string): Project | null {
    return this.projects.find((project) => project.id === id) ?? null
  }

  getActiveWorktreesByProject(projectId: string): Worktree[] {
    return this.activeWorktrees.get(projectId) ?? []
  }

  getWorktree(id: string): Worktree | null {
    for (const worktrees of this.activeWorktrees.values()) {
      const worktree = worktrees.find((candidate) => candidate.id === id)
      if (worktree) return worktree
    }
    return null
  }

  getDiscordResourcesByGuild(guildId: string): DiscordResource[] {
    return this.resources.filter((resource) => resource.guild_id === guildId)
  }

  insertDiscordResource(resource: DiscordResource): void {
    this.resources.push({ ...resource, managed_session_id: resource.managed_session_id ?? null })
  }

  deleteDiscordResource(id: string): void {
    this.resources = this.resources.filter((resource) => resource.id !== id)
  }

  deleteSetting(key: string): void {
    this.settings.delete(key)
  }
}

const makeGateway = () => {
  let nextId = 1
  const actions: string[] = []
  return {
    actions,
    gateway: {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      verify: vi.fn(),
      registerCommands: vi.fn(async () => undefined),
      createCategory: vi.fn(async (name: string) => {
        const id = `discord-${nextId++}`
        actions.push(`create-category:${name}:${id}`)
        return id
      }),
      createTextChannel: vi.fn(async (name: string, parentId: string) => {
        const id = `discord-${nextId++}`
        actions.push(`create-channel:${name}:${parentId}:${id}`)
        return id
      }),
      deleteResource: vi.fn(async (discordId: string) => {
        actions.push(`delete:${discordId}`)
      })
    }
  }
}

const makeProject = (id: string, name: string): Project => ({
  id,
  name,
  path: `/repo/${name}`,
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
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z'
})

const makeWorktree = (
  id: string,
  projectId: string,
  name: string,
  overrides: Partial<Worktree> = {}
): Worktree => ({
  id,
  project_id: projectId,
  name,
  branch_name: name,
  path: `/repo/${projectId}/${name}`,
  status: 'active',
  is_default: false,
  branch_renamed: 0,
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
  base_branch: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  ...overrides
})

const configure = (db: FakeDiscordDatabase): void => {
  db.setSetting(
    'discord_config',
    JSON.stringify({
      botToken: 'token',
      guildId: 'guild-1',
      guildName: 'Hive',
      enabled: true,
      selectedProjectIds: []
    })
  )
}

const makeService = (
  db: FakeDiscordDatabase,
  gateway: ReturnType<typeof makeGateway>['gateway'],
  sessionBridge?: {
    start: () => void
    dispose: () => void
    handleUserMessage: ReturnType<typeof vi.fn>
    setWorktreeMode?: ReturnType<typeof vi.fn>
    setBackendEventPublisher?: ReturnType<typeof vi.fn>
  }
) =>
  new DiscordService({
    db: db as never,
    gatewayFactory: () => gateway,
    sessionBridge: sessionBridge as never
  })

const flushPromises = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  discordJsMock.Client.mockClear()
  discordJsMock.instances.length = 0
  vi.mocked(createWorktreeFromBranchOp).mockReset()
  vi.mocked(createGitService).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DiscordService provisioning reconciliation', () => {
  it('creates a category per selected project and a channel per active worktree', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [
      makeWorktree('w1', 'p1', 'main'),
      makeWorktree('w2', 'p1', 'feature-a')
    ])
    const { gateway, actions } = makeGateway()
    const service = makeService(db, gateway)

    const summary = await service.provision(['p1'])

    expect(summary).toEqual({ created: 3, deleted: 0 })
    expect(actions).toEqual([
      'create-category:test-python:discord-1',
      'create-channel:main:discord-1:discord-2',
      'create-channel:feature-a:discord-1:discord-3'
    ])
    expect(gateway.registerCommands).toHaveBeenCalledTimes(1)
    expect(db.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project_id: 'p1', worktree_id: null, type: 'category' }),
        expect.objectContaining({ project_id: 'p1', worktree_id: 'w1', type: 'channel' }),
        expect.objectContaining({ project_id: 'p1', worktree_id: 'w2', type: 'channel' })
      ])
    )
  })

  it('reuses persisted mappings and does not create duplicates', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [makeWorktree('w1', 'p1', 'main')])
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'r-channel',
        project_id: 'p1',
        worktree_id: 'w1',
        discord_id: 'channel-1',
        type: 'channel',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)

    const summary = await service.provision(['p1'])

    expect(summary).toEqual({ created: 0, deleted: 0 })
    expect(gateway.registerCommands).toHaveBeenCalledTimes(1)
    expect(gateway.createCategory).not.toHaveBeenCalled()
    expect(gateway.createTextChannel).not.toHaveBeenCalled()
    expect(db.resources).toHaveLength(2)
  })

  it('deduplicates selected project ids before creating resources', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [makeWorktree('w1', 'p1', 'main')])
    const { gateway, actions } = makeGateway()
    const service = makeService(db, gateway)

    const summary = await service.provision(['p1', 'p1'])

    expect(summary).toEqual({ created: 2, deleted: 0 })
    expect(actions).toEqual([
      'create-category:test-python:discord-1',
      'create-channel:main:discord-1:discord-2'
    ])
    expect(db.resources).toHaveLength(2)
    expect(JSON.parse(db.settings.get('discord_config') ?? '{}')).toMatchObject({
      selectedProjectIds: ['p1']
    })
  })

  it('deletes channels and categories for deselected projects', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'r-channel',
        project_id: 'p1',
        worktree_id: 'w1',
        discord_id: 'channel-1',
        type: 'channel',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway, actions } = makeGateway()
    const service = makeService(db, gateway)

    const summary = await service.provision([])

    expect(summary).toEqual({ created: 0, deleted: 2 })
    expect(actions).toEqual(['delete:channel-1', 'delete:category-1'])
    expect(db.resources).toEqual([])
  })

  it('deletes channel mappings whose worktree is no longer active', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [makeWorktree('w1', 'p1', 'main')])
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'r-active',
        project_id: 'p1',
        worktree_id: 'w1',
        discord_id: 'channel-1',
        type: 'channel',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'r-archived',
        project_id: 'p1',
        worktree_id: 'w2',
        discord_id: 'channel-archived',
        type: 'channel',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway, actions } = makeGateway()
    const service = makeService(db, gateway)

    const summary = await service.provision(['p1'])

    expect(summary).toEqual({ created: 0, deleted: 1 })
    expect(actions).toEqual(['delete:channel-archived'])
    expect(db.resources.map((resource) => resource.id)).toEqual(['r-category', 'r-active'])
  })

  it('emits progress after each provisioning step', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [makeWorktree('w1', 'p1', 'main')])
    const { gateway } = makeGateway()
    const events: Array<{ channel: string; payload: unknown }> = []
    const service = new DiscordService({
      db: db as never,
      gatewayFactory: () => gateway,
      publishEvent: (channel, payload) => events.push({ channel, payload })
    })

    await service.provision(['p1'])

    expect(events).toEqual([
      {
        channel: 'discord:provisionProgress',
        payload: {
          current: 1,
          total: 2,
          phase: 'create',
          label: 'Created category test-python'
        }
      },
      {
        channel: 'discord:provisionProgress',
        payload: {
          current: 2,
          total: 2,
          phase: 'create',
          label: 'Created channel main'
        }
      },
      {
        channel: 'discord:statusChanged',
        payload: {
          enabled: true,
          configured: true
        }
      }
    ])
  })

  it('aborts on the first Discord failure without saving mappings for failed work', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [makeWorktree('w1', 'p1', 'main')])
    const { gateway } = makeGateway()
    gateway.createTextChannel.mockRejectedValueOnce(new Error('missing Manage Channels'))
    const service = makeService(db, gateway)

    await expect(service.provision(['p1'])).rejects.toThrow('missing Manage Channels')

    expect(gateway.disconnect).toHaveBeenCalledTimes(1)
    expect(db.resources).toEqual([
      expect.objectContaining({
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'discord-1',
        type: 'category'
      })
    ])
    expect(JSON.parse(db.settings.get('discord_config') ?? '{}')).toMatchObject({
      enabled: true,
      selectedProjectIds: []
    })
  })

  it('surfaces an actionable error when the bot cannot access the configured guild', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    const { gateway } = makeGateway()
    gateway.connect.mockRejectedValueOnce(Object.assign(new Error('Unknown Guild'), { code: 10004 }))
    const service = makeService(db, gateway)

    await expect(service.provision(['p1'])).rejects.toThrow(
      'Discord bot cannot access guild guild-1'
    )

    expect(gateway.disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('DiscordService message listener', () => {
  it('starts the persistent listener after successful provisioning', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [makeWorktree('w1', 'p1', 'main')])
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)

    await service.provision(['p1'])

    expect(discordJsMock.Client).toHaveBeenCalledWith({
      intents: [1, 512, 32768]
    })
    expect(discordJsMock.instances).toHaveLength(1)
    expect(discordJsMock.instances[0].login).toHaveBeenCalledWith('token')
  })

  it('creates a worktree when a human creates a text channel under a managed project category', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [
      makeWorktree('w-main', 'p1', 'main', { is_default: true, branch_name: 'main' })
    ])
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const createdWorktree = makeWorktree('w-new', 'p1', 'fix-login-bug', {
      branch_renamed: 1,
      base_branch: 'main'
    })
    vi.mocked(createWorktreeFromBranchOp).mockResolvedValue({
      success: true,
      worktree: createdWorktree
    })
    const { gateway } = makeGateway()
    const events: Array<{ channel: string; payload: unknown }> = []
    const service = new DiscordService({
      db: db as never,
      gatewayFactory: () => gateway,
      publishEvent: (channel, payload) => events.push({ channel, payload })
    })
    await service.startListening()
    const channel = {
      id: 'channel-new',
      guildId: 'guild-1',
      type: 0,
      parentId: 'category-1',
      name: 'Fix Login Bug',
      isTextBased: () => true,
      send: vi.fn(async () => undefined)
    }

    discordJsMock.instances[0].emit('channelCreate', channel)
    await flushPromises()

    expect(createWorktreeFromBranchOp).toHaveBeenCalledWith({
      projectId: 'p1',
      projectPath: '/repo/test-python',
      projectName: 'test-python',
      branchName: 'main',
      nameHint: 'fix-login-bug'
    })
    expect(db.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_id: 'p1',
          worktree_id: 'w-new',
          discord_id: 'channel-new',
          type: 'channel',
          guild_id: 'guild-1',
          managed_session_id: null
        })
      ])
    )
    expect(events).toEqual([
      {
        channel: WORKTREE_CREATED_CHANNEL,
        payload: { projectId: 'p1', worktree: createdWorktree }
      }
    ])
    expect(channel.send).toHaveBeenCalledWith('Created worktree `fix-login-bug`')
  })

  it('ignores channelCreate events when disabled, from another guild, or not text channels', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [
      makeWorktree('w-main', 'p1', 'main', { is_default: true, branch_name: 'main' })
    ])
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)

    db.setSetting(
      'discord_config',
      JSON.stringify({
        botToken: 'token',
        guildId: 'guild-1',
        guildName: 'Hive',
        enabled: false,
        selectedProjectIds: []
      })
    )
    await service.startListening()
    expect(discordJsMock.instances).toHaveLength(0)

    configure(db)
    await service.startListening()
    const client = discordJsMock.instances[0]
    const wrongGuildChannel = {
      id: 'channel-wrong-guild',
      guildId: 'guild-2',
      type: 0,
      parentId: 'category-1',
      name: 'Wrong Guild',
      isTextBased: () => true,
      send: vi.fn(async () => undefined)
    }
    const categoryChannel = {
      id: 'channel-category',
      guildId: 'guild-1',
      type: 4,
      parentId: null,
      name: 'Not Text',
      isTextBased: () => false,
      send: vi.fn(async () => undefined)
    }

    client.emit('channelCreate', wrongGuildChannel)
    client.emit('channelCreate', categoryChannel)
    await flushPromises()

    expect(createWorktreeFromBranchOp).not.toHaveBeenCalled()
    expect(wrongGuildChannel.send).not.toHaveBeenCalled()
    expect(categoryChannel.send).not.toHaveBeenCalled()
  })

  it('uses git default branch when the project has no default worktree', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    vi.mocked(createWorktreeFromBranchOp).mockResolvedValue({
      success: true,
      worktree: makeWorktree('w-new', 'p1', 'new-task')
    })
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)
    await service.startListening()

    discordJsMock.instances[0].emit('channelCreate', {
      id: 'channel-new',
      guildId: 'guild-1',
      type: 0,
      parentId: 'category-1',
      name: 'New Task',
      isTextBased: () => true,
      send: vi.fn(async () => undefined)
    })
    await flushPromises()

    expect(createGitService).toHaveBeenCalledWith('/repo/test-python')
    expect(createWorktreeFromBranchOp).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'main', nameHint: 'new-task' })
    )
  })

  it('announces and maps the suffixed branch returned after a name collision', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [
      makeWorktree('w-main', 'p1', 'main', { is_default: true, branch_name: 'main' }),
      makeWorktree('w-existing', 'p1', 'fix-login-bug')
    ])
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const suffixedWorktree = makeWorktree('w-new', 'p1', 'fix-login-bug-2', {
      branch_name: 'fix-login-bug-2',
      base_branch: 'main'
    })
    vi.mocked(createWorktreeFromBranchOp).mockResolvedValue({
      success: true,
      worktree: suffixedWorktree
    })
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)
    await service.startListening()
    const channel = {
      id: 'channel-collision',
      guildId: 'guild-1',
      type: 0,
      parentId: 'category-1',
      name: 'Fix Login Bug',
      isTextBased: () => true,
      send: vi.fn(async () => undefined)
    }

    discordJsMock.instances[0].emit('channelCreate', channel)
    await flushPromises()

    expect(createWorktreeFromBranchOp).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'main', nameHint: 'fix-login-bug' })
    )
    expect(db.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_id: 'p1',
          worktree_id: 'w-new',
          discord_id: 'channel-collision',
          type: 'channel'
        })
      ])
    )
    expect(channel.send).toHaveBeenCalledWith('Created worktree `fix-login-bug-2`')
  })

  it('does not create worktrees for bot-provisioned or already mapped channels', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [makeWorktree('w1', 'p1', 'main')])
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)

    await service.provision(['p1'])
    const provisionedChannel = db.resources.find((resource) => resource.type === 'channel')
    expect(provisionedChannel?.discord_id).toBe('discord-2')
    db.resources = db.resources.filter((resource) => resource.discord_id !== 'discord-2')

    discordJsMock.instances[0].emit('channelCreate', {
      id: 'discord-2',
      guildId: 'guild-1',
      type: 0,
      parentId: 'discord-1',
      name: 'main',
      isTextBased: () => true,
      send: vi.fn(async () => undefined)
    })
    await flushPromises()

    db.resources.push({
      id: 'r-channel-existing',
      project_id: 'p1',
      worktree_id: 'w-existing',
      discord_id: 'channel-existing',
      type: 'channel',
      guild_id: 'guild-1',
      managed_session_id: null,
      created_at: '2026-01-01T00:00:00.000Z'
    })
    discordJsMock.instances[0].emit('channelCreate', {
      id: 'channel-existing',
      guildId: 'guild-1',
      type: 0,
      parentId: 'discord-1',
      name: 'existing',
      isTextBased: () => true,
      send: vi.fn(async () => undefined)
    })
    await flushPromises()

    expect(createWorktreeFromBranchOp).not.toHaveBeenCalled()
  })

  it('ignores channels outside managed categories and rejects empty normalized names', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)
    await service.startListening()
    const outsideChannel = {
      id: 'channel-outside',
      guildId: 'guild-1',
      type: 0,
      parentId: 'category-unmanaged',
      name: 'Outside',
      isTextBased: () => true,
      send: vi.fn(async () => undefined)
    }
    const emptyNameChannel = {
      id: 'channel-empty',
      guildId: 'guild-1',
      type: 0,
      parentId: 'category-1',
      name: '🔥🚀',
      isTextBased: () => true,
      send: vi.fn(async () => undefined)
    }

    discordJsMock.instances[0].emit('channelCreate', outsideChannel)
    discordJsMock.instances[0].emit('channelCreate', emptyNameChannel)
    await flushPromises()

    expect(createWorktreeFromBranchOp).not.toHaveBeenCalled()
    expect(outsideChannel.send).not.toHaveBeenCalled()
    expect(emptyNameChannel.send).toHaveBeenCalledWith(
      'Could not create worktree: channel name does not contain any branch-safe characters.'
    )
  })

  it('posts an error message when worktree creation fails', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [
      makeWorktree('w-main', 'p1', 'main', { is_default: true, branch_name: 'main' })
    ])
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    vi.mocked(createWorktreeFromBranchOp).mockResolvedValue({
      success: false,
      error: 'branch already exists'
    })
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)
    await service.startListening()
    const channel = {
      id: 'channel-fail',
      guildId: 'guild-1',
      type: 0,
      parentId: 'category-1',
      name: 'Fails',
      isTextBased: () => true,
      send: vi.fn(async () => undefined)
    }

    discordJsMock.instances[0].emit('channelCreate', channel)
    await flushPromises()

    expect(db.resources.some((resource) => resource.discord_id === 'channel-fail')).toBe(false)
    expect(channel.send).toHaveBeenCalledWith('Could not create worktree: branch already exists')
  })

  it('delegates non-bot messages in provisioned channels to the Discord session bridge', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.activeWorktrees.set('p1', [makeWorktree('w1', 'p1', 'main')])
    db.resources = [
      {
        id: 'r-channel',
        project_id: 'p1',
        worktree_id: 'w1',
        discord_id: 'channel-1',
        type: 'channel',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway } = makeGateway()
    const sessionBridge = {
      start: vi.fn(),
      dispose: vi.fn(),
      handleUserMessage: vi.fn(async () => undefined),
      setWorktreeMode: vi.fn(async () => undefined)
    }
    const service = makeService(db, gateway, sessionBridge)
    await service.startListening()
    const client = discordJsMock.instances[0]
    const channel = {
      isTextBased: () => true,
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined)
    }

    client.emit('messageCreate', {
      author: { bot: false, tag: 'alice#0001' },
      channel,
      channelId: 'channel-1',
      content: 'ship it',
      guildId: 'guild-1'
    })

    await flushPromises()

    expect(sessionBridge.start).toHaveBeenCalledTimes(1)
    expect(sessionBridge.handleUserMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      worktreeId: 'w1',
      projectId: 'p1',
      worktreePath: '/repo/p1/main',
      text: 'ship it',
      channel
    })
    expect(channel.sendTyping).not.toHaveBeenCalled()
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('replies ephemerally when a mode command is used outside a worktree channel', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    const { gateway } = makeGateway()
    const sessionBridge = {
      start: vi.fn(),
      dispose: vi.fn(),
      handleUserMessage: vi.fn(async () => undefined),
      setWorktreeMode: vi.fn(async () => undefined)
    }
    const service = makeService(db, gateway, sessionBridge)
    await service.startListening()
    const interaction = {
      isChatInputCommand: () => true,
      guildId: 'guild-1',
      channelId: 'channel-unlinked',
      commandName: 'plan',
      reply: vi.fn(async () => undefined),
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined)
    }

    discordJsMock.instances[0].emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'This channel is not linked to a worktree.',
      ephemeral: true
    })
    expect(interaction.deferReply).not.toHaveBeenCalled()
    expect(sessionBridge.setWorktreeMode).not.toHaveBeenCalled()
  })

  it('handles a valid mode command publicly and updates the worktree session mode', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.activeWorktrees.set('p1', [makeWorktree('w1', 'p1', 'main')])
    db.resources = [
      {
        id: 'r-channel',
        project_id: 'p1',
        worktree_id: 'w1',
        discord_id: 'channel-1',
        type: 'channel',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway } = makeGateway()
    const sessionBridge = {
      start: vi.fn(),
      dispose: vi.fn(),
      handleUserMessage: vi.fn(async () => undefined),
      setWorktreeMode: vi.fn(async () => undefined)
    }
    const service = makeService(db, gateway, sessionBridge)
    await service.startListening()
    const interaction = {
      isChatInputCommand: () => true,
      guildId: 'guild-1',
      channelId: 'channel-1',
      commandName: 'super-plan',
      reply: vi.fn(async () => undefined),
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined)
    }

    discordJsMock.instances[0].emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.reply).not.toHaveBeenCalled()
    expect(interaction.deferReply).toHaveBeenCalledTimes(1)
    expect(sessionBridge.setWorktreeMode).toHaveBeenCalledWith(
      {
        worktreeId: 'w1',
        projectId: 'p1',
        worktreePath: '/repo/p1/main'
      },
      'super-plan'
    )
    expect(interaction.editReply).toHaveBeenCalledWith('Changed to super-plan mode')
  })

  it('ignores bot messages and messages outside provisioned channels', async () => {
    vi.useFakeTimers()
    const db = new FakeDiscordDatabase()
    configure(db)
    db.resources = [
      {
        id: 'r-channel',
        project_id: 'p1',
        worktree_id: 'w1',
        discord_id: 'channel-1',
        type: 'channel',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)
    await service.startListening()
    const client = discordJsMock.instances[0]
    const channel = {
      isTextBased: () => true,
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined)
    }

    client.emit('messageCreate', {
      author: { bot: true, tag: 'bot#0001' },
      channel,
      channelId: 'channel-1',
      content: 'Received prompt',
      guildId: 'guild-1'
    })
    client.emit('messageCreate', {
      author: { bot: false, tag: 'alice#0001' },
      channel,
      channelId: 'channel-2',
      content: 'hello elsewhere',
      guildId: 'guild-1'
    })

    await vi.advanceTimersByTimeAsync(6000)
    expect(channel.sendTyping).not.toHaveBeenCalled()
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('passes the backend event publisher to the Discord session bridge', () => {
    const db = new FakeDiscordDatabase()
    const { gateway } = makeGateway()
    const sessionBridge = {
      start: vi.fn(),
      dispose: vi.fn(),
      handleUserMessage: vi.fn(async () => undefined),
      setBackendEventPublisher: vi.fn()
    }
    const service = makeService(db, gateway, sessionBridge)
    const publishEvent = vi.fn()

    service.setBackendEventPublisher(publishEvent)

    expect(sessionBridge.setBackendEventPublisher).toHaveBeenCalledWith(publishEvent)
  })
})
