import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync } from 'fs'
import { WORKTREE_CREATED_CHANNEL } from '@shared/worktree-events'
import { DiscordService } from './discord-service'
import { cloneRepository } from './git-repository'
import {
  createProjectWithDefaultWorktree,
  detectProjectFavicon,
  detectProjectLanguage
} from './project-ops'
import { createWorktreeFromBranchOp, deleteWorktreeOp, syncWorktreesOp } from './worktree-ops'
import { createGitService } from './git-service'
import type { DiscordResource, Project, Worktree } from '../db/types'

const discordJsMock = vi.hoisted(() => {
  interface MockDiscordClientShape {
    login: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    isReady: ReturnType<typeof vi.fn>
    application: {
      commands: {
        set: ReturnType<typeof vi.fn>
        create: ReturnType<typeof vi.fn>
      }
    }
    channels: {
      fetch: ReturnType<typeof vi.fn>
    }
    emit(event: string, ...args: unknown[]): void
  }

  const instances: MockDiscordClientShape[] = []

  class MockDiscordClient {
    readonly options: unknown
    readonly login = vi.fn(async () => 'logged-in')
    readonly destroy = vi.fn()
    readonly isReady = vi.fn(() => true)
    readonly application = {
      commands: {
        set: vi.fn(async () => undefined),
        create: vi.fn(async () => undefined)
      }
    }
    readonly channels = {
      fetch: vi.fn(async () => null)
    }
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

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn()
  }
})

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: vi.fn(() => '/home/test')
  }
})

vi.mock('./worktree-ops', () => ({
  createWorktreeFromBranchOp: vi.fn(),
  deleteWorktreeOp: vi.fn(),
  syncWorktreesOp: vi.fn()
}))

vi.mock('./git-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-repository')>()
  return {
    ...actual,
    cloneRepository: vi.fn()
  }
})

vi.mock('./project-ops', () => ({
  createProjectWithDefaultWorktree: vi.fn((db, data) => {
    const project = db.createProject(data)
    db.createWorktree({
      project_id: project.id,
      name: '(no-worktree)',
      branch_name: '',
      path: project.path,
      is_default: true
    })
    return project
  }),
  detectProjectLanguage: vi.fn(async () => null),
  detectProjectFavicon: vi.fn(() => null)
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

  getProjectByPath(path: string): Project | null {
    return this.projects.find((project) => project.path === path) ?? null
  }

  createProject(data: { name: string; path: string }): Project {
    const project = makeProject(`p${this.projects.length + 1}`, data.name)
    project.path = data.path
    this.projects.push(project)
    return project
  }

  updateProject(id: string, data: Partial<Project>): Project | null {
    const project = this.getProject(id)
    if (!project) return null
    Object.assign(project, data)
    return project
  }

  createWorktree(data: {
    project_id: string
    name: string
    branch_name: string
    path: string
    is_default?: boolean
  }): Worktree {
    const worktree = makeWorktree(
      `w${(this.activeWorktrees.get(data.project_id) ?? []).length + 1}`,
      data.project_id,
      data.name,
      {
        branch_name: data.branch_name,
        path: data.path,
        is_default: data.is_default ?? false
      }
    )
    this.activeWorktrees.set(data.project_id, [
      ...(this.activeWorktrees.get(data.project_id) ?? []),
      worktree
    ])
    return worktree
  }

  replaceActiveWorktrees(projectId: string, worktrees: Worktree[]): void {
    this.activeWorktrees.set(projectId, worktrees)
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

const configureSelected = (db: FakeDiscordDatabase, selectedProjectIds: string[]): void => {
  db.setSetting(
    'discord_config',
    JSON.stringify({
      botToken: 'token',
      guildId: 'guild-1',
      guildName: 'Hive',
      enabled: true,
      selectedProjectIds
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
    clearManagedSession?: ReturnType<typeof vi.fn>
    stopManagedSession?: ReturnType<typeof vi.fn>
    setBackendEventPublisher?: ReturnType<typeof vi.fn>
    handleComponentInteraction?: ReturnType<typeof vi.fn>
    handleModalSubmit?: ReturnType<typeof vi.fn>
    setChannelResolver?: ReturnType<typeof vi.fn>
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

const makeResource = (overrides: Partial<DiscordResource> = {}): DiscordResource => ({
  id: 'r-channel',
  project_id: 'p1',
  worktree_id: 'w1',
  discord_id: 'channel-1',
  type: 'channel',
  guild_id: 'guild-1',
  managed_session_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides
})

const makeArchiveInteraction = (
  client: unknown,
  overrides: {
    commandName?: string
    guildId?: string
    channelId?: string
    isChatInputCommand?: () => boolean
  } = {}
) => {
  const interaction = {
    commandName: overrides.commandName ?? 'archive',
    guildId: overrides.guildId ?? 'guild-1',
    channelId: overrides.channelId ?? 'channel-1',
    deferred: false,
    replied: false,
    client,
    isChatInputCommand: overrides.isChatInputCommand ?? (() => true),
    reply: vi.fn(async () => {
      interaction.replied = true
      return undefined
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true
      return undefined
    }),
    editReply: vi.fn(async () => {
      interaction.replied = true
      return undefined
    })
  }
  return interaction
}

const makeAddProjectInteraction = (client: unknown, gitUrl: string) => {
  const interaction = {
    commandName: 'add-project',
    guildId: 'guild-1',
    channelId: 'any-channel',
    deferred: false,
    replied: false,
    client,
    options: {
      getString: vi.fn(() => gitUrl)
    },
    isChatInputCommand: () => true,
    reply: vi.fn(async () => {
      interaction.replied = true
      return undefined
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true
      return undefined
    }),
    editReply: vi.fn(async () => {
      interaction.replied = true
      return undefined
    })
  }
  return interaction
}

beforeEach(() => {
  discordJsMock.Client.mockClear()
  discordJsMock.instances.length = 0
  vi.mocked(createWorktreeFromBranchOp).mockReset()
  vi.mocked(deleteWorktreeOp).mockReset()
  vi.mocked(syncWorktreesOp).mockReset()
  vi.mocked(syncWorktreesOp).mockResolvedValue({ success: true })
  vi.mocked(cloneRepository).mockReset()
  vi.mocked(cloneRepository).mockResolvedValue({ success: true })
  vi.mocked(existsSync).mockReset()
  vi.mocked(existsSync).mockReturnValue(false)
  vi.mocked(mkdirSync).mockReset()
  vi.mocked(createProjectWithDefaultWorktree).mockClear()
  vi.mocked(detectProjectLanguage).mockReset()
  vi.mocked(detectProjectLanguage).mockResolvedValue(null)
  vi.mocked(detectProjectFavicon).mockReset()
  vi.mocked(detectProjectFavicon).mockReturnValue(null)
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

  it('removes stale channel mappings when Discord reports the channel is already gone', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [makeWorktree('w1', 'p1', 'main')])
    db.resources = [
      {
        id: 'r-stale',
        project_id: 'old-project',
        worktree_id: 'old-worktree',
        discord_id: 'missing-channel',
        type: 'channel',
        guild_id: 'guild-1',
        managed_session_id: null,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway, actions } = makeGateway()
    gateway.deleteResource.mockRejectedValueOnce(
      Object.assign(new Error('Unknown Channel'), { code: 10003 })
    )
    const service = makeService(db, gateway)

    const summary = await service.provision(['p1'])

    expect(summary).toEqual({ created: 2, deleted: 1 })
    expect(db.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project_id: 'p1', worktree_id: null, type: 'category' }),
        expect.objectContaining({ project_id: 'p1', worktree_id: 'w1', type: 'channel' })
      ])
    )
    expect(db.resources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'r-stale' })])
    )
    expect(actions).toEqual([
      'create-category:test-python:discord-1',
      'create-channel:main:discord-1:discord-2'
    ])
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
    expect(discordJsMock.instances[0].application.commands.set).toHaveBeenCalledWith(
      [
        { name: 'plan', description: 'Switch this worktree to plan mode' },
        { name: 'build', description: 'Switch this worktree to build mode' },
        { name: 'super-plan', description: 'Switch this worktree to super-plan mode' },
        { name: 'archive', description: 'Archive this worktree and delete its channel' },
        { name: 'stop', description: 'Abort the current running session' },
        { name: 'clear', description: 'Clear the session attached to this worktree channel' },
        {
          name: 'qa',
          description: 'Only post questions, plan approvals, and final results to channels'
        },
        { name: 'all', description: 'Post all agent activity to channels (default)' },
        {
          name: 'add-project',
          description: 'Clone a git repo and add it to Hive',
          options: [
            {
              type: 3,
              name: 'git_url',
              description: 'Git SSH URL (git@host:user/repo.git)',
              required: true
            }
          ]
        }
      ],
      'guild-1'
    )
  })

  it('adds a project from a global slash command and provisions its default branch channel', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    const { gateway, actions } = makeGateway()
    const service = makeService(db, gateway)

    vi.mocked(syncWorktreesOp).mockImplementation(async (params) => {
      db.replaceActiveWorktrees(params.projectId, [
        makeWorktree('w-main', params.projectId, 'main', {
          branch_name: 'main',
          path: params.projectPath,
          is_default: true
        })
      ])
      return { success: true }
    })

    await service.startListening()
    const interaction = makeAddProjectInteraction(
      discordJsMock.instances[0],
      'git@github.com:example/repo.git'
    )

    discordJsMock.instances[0].emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.deferReply).toHaveBeenCalledTimes(1)
    expect(cloneRepository).toHaveBeenCalledWith(
      'git@github.com:example/repo.git',
      '/home/test/hive-projects/repo'
    )
    expect(createProjectWithDefaultWorktree).toHaveBeenCalledWith(db, {
      name: 'repo',
      path: '/home/test/hive-projects/repo'
    })
    expect(syncWorktreesOp).toHaveBeenCalledWith({
      projectId: 'p1',
      projectPath: '/home/test/hive-projects/repo'
    })
    expect(actions).toEqual([
      'create-category:repo:discord-1',
      'create-channel:main:discord-1:discord-2'
    ])
    expect(interaction.editReply).toHaveBeenCalledWith(
      'Added **repo** and provisioned its Discord channel.'
    )
    expect(JSON.parse(db.settings.get('discord_config') ?? '{}')).toMatchObject({
      selectedProjectIds: ['p1']
    })
  })

  it('reports when the project is already added to Hive and managed by Discord', async () => {
    const db = new FakeDiscordDatabase()
    configureSelected(db, ['p1'])
    const project = makeProject('p1', 'repo')
    project.path = '/home/test/hive-projects/repo'
    db.projects = [project]
    db.activeWorktrees.set('p1', [
      makeWorktree('w-main', 'p1', 'main', {
        path: '/home/test/hive-projects/repo',
        is_default: true
      })
    ])
    db.resources = [
      makeResource({
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category'
      }),
      makeResource({
        id: 'r-main',
        project_id: 'p1',
        worktree_id: 'w-main',
        discord_id: 'channel-main',
        type: 'channel'
      })
    ]
    const { gateway, actions } = makeGateway()
    const service = makeService(db, gateway)

    await service.startListening()
    const interaction = makeAddProjectInteraction(
      discordJsMock.instances[0],
      'git@github.com:example/repo.git'
    )

    discordJsMock.instances[0].emit('interactionCreate', interaction)
    await flushPromises()

    expect(cloneRepository).not.toHaveBeenCalled()
    expect(createProjectWithDefaultWorktree).not.toHaveBeenCalled()
    expect(syncWorktreesOp).not.toHaveBeenCalled()
    expect(actions).toEqual([])
    expect(interaction.editReply).toHaveBeenCalledWith(
      'Project **repo** is already added to Hive and managed by Discord.'
    )
  })

  it('adds an existing Hive project to Discord management when it is not managed yet', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    const project = makeProject('p1', 'repo')
    project.path = '/home/test/hive-projects/repo'
    db.projects = [project]
    db.activeWorktrees.set('p1', [
      makeWorktree('w-main', 'p1', 'main', {
        path: '/home/test/hive-projects/repo',
        is_default: true
      })
    ])
    const { gateway, actions } = makeGateway()
    const service = makeService(db, gateway)

    await service.startListening()
    const interaction = makeAddProjectInteraction(
      discordJsMock.instances[0],
      'git@github.com:example/repo.git'
    )

    discordJsMock.instances[0].emit('interactionCreate', interaction)
    await flushPromises()

    expect(cloneRepository).not.toHaveBeenCalled()
    expect(createProjectWithDefaultWorktree).not.toHaveBeenCalled()
    expect(syncWorktreesOp).not.toHaveBeenCalled()
    expect(actions).toEqual([
      'create-category:repo:discord-1',
      'create-channel:main:discord-1:discord-2'
    ])
    expect(interaction.editReply).toHaveBeenCalledWith(
      'Project **repo** already exists in Hive; added it to Discord management.'
    )
    expect(JSON.parse(db.settings.get('discord_config') ?? '{}')).toMatchObject({
      selectedProjectIds: ['p1']
    })
  })

  it('adds an existing filesystem path to Hive and Discord without cloning over it', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(syncWorktreesOp).mockImplementation(async (params) => {
      db.replaceActiveWorktrees(params.projectId, [
        makeWorktree('w-main', params.projectId, 'main', {
          branch_name: 'main',
          path: params.projectPath,
          is_default: true
        })
      ])
      return { success: true }
    })
    const { gateway, actions } = makeGateway()
    const service = makeService(db, gateway)

    await service.startListening()
    const interaction = makeAddProjectInteraction(
      discordJsMock.instances[0],
      'git@github.com:example/repo.git'
    )

    discordJsMock.instances[0].emit('interactionCreate', interaction)
    await flushPromises()

    expect(cloneRepository).not.toHaveBeenCalled()
    expect(createProjectWithDefaultWorktree).toHaveBeenCalledWith(db, {
      name: 'repo',
      path: '/home/test/hive-projects/repo'
    })
    expect(syncWorktreesOp).toHaveBeenCalledWith({
      projectId: 'p1',
      projectPath: '/home/test/hive-projects/repo'
    })
    expect(actions).toEqual([
      'create-category:repo:discord-1',
      'create-channel:main:discord-1:discord-2'
    ])
    expect(interaction.editReply).toHaveBeenCalledWith(
      'Added existing path **repo** to Hive and provisioned its Discord channel.'
    )
  })

  it('routes component interactions to the session bridge before slash command handling', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    const { gateway } = makeGateway()
    const sessionBridge = {
      start: vi.fn(),
      dispose: vi.fn(),
      handleUserMessage: vi.fn(),
      handleComponentInteraction: vi.fn(async () => undefined),
      handleModalSubmit: vi.fn(async () => undefined),
      setChannelResolver: vi.fn(),
      setBackendEventPublisher: vi.fn()
    }
    const service = makeService(db, gateway, sessionBridge)

    await service.startListening()
    discordJsMock.instances[0].emit('interactionCreate', {
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false
    })
    await flushPromises()

    expect(sessionBridge.handleComponentInteraction).toHaveBeenCalledTimes(1)
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

  it('handles /clear in a provisioned worktree channel as a public deferred reply', async () => {
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
        managed_session_id: 'hive-existing',
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway } = makeGateway()
    const sessionBridge = {
      start: vi.fn(),
      dispose: vi.fn(),
      handleUserMessage: vi.fn(async () => undefined),
      clearManagedSession: vi.fn(async () => undefined)
    }
    const service = makeService(db, gateway, sessionBridge)
    await service.startListening()
    const interaction = {
      isChatInputCommand: vi.fn(() => true),
      commandName: 'clear',
      guildId: 'guild-1',
      channelId: 'channel-1',
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined)
    }

    discordJsMock.instances[0].emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.deferReply).toHaveBeenCalledWith()
    expect(sessionBridge.clearManagedSession).toHaveBeenCalledWith({
      worktreeId: 'w1',
      worktreePath: '/repo/p1/main'
    })
    expect(interaction.editReply).toHaveBeenCalledWith(
      'Session cleared. Your next message will start a fresh session.'
    )
    expect(interaction.reply).not.toHaveBeenCalled()
  })

  it('handles /stop in a provisioned worktree channel as a public deferred reply', async () => {
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
        managed_session_id: 'hive-existing',
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway } = makeGateway()
    const sessionBridge = {
      start: vi.fn(),
      dispose: vi.fn(),
      handleUserMessage: vi.fn(async () => undefined),
      stopManagedSession: vi.fn(async () => true)
    }
    const service = makeService(db, gateway, sessionBridge)
    await service.startListening()
    const interaction = {
      isChatInputCommand: vi.fn(() => true),
      commandName: 'stop',
      guildId: 'guild-1',
      channelId: 'channel-1',
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined)
    }

    discordJsMock.instances[0].emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.deferReply).toHaveBeenCalledWith()
    expect(sessionBridge.stopManagedSession).toHaveBeenCalledWith({
      worktreeId: 'w1',
      worktreePath: '/repo/p1/main'
    })
    expect(interaction.editReply).toHaveBeenCalledWith('Session stopped.')
    expect(interaction.reply).not.toHaveBeenCalled()
  })

  it('replies ephemerally when /stop is used outside a provisioned worktree channel', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    const { gateway } = makeGateway()
    const sessionBridge = {
      start: vi.fn(),
      dispose: vi.fn(),
      handleUserMessage: vi.fn(async () => undefined),
      stopManagedSession: vi.fn(async () => true)
    }
    const service = makeService(db, gateway, sessionBridge)
    await service.startListening()
    const interaction = {
      isChatInputCommand: vi.fn(() => true),
      commandName: 'stop',
      guildId: 'guild-1',
      channelId: 'unmapped-channel',
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined)
    }

    discordJsMock.instances[0].emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'This channel is not linked to a Hive worktree.',
      ephemeral: true
    })
    expect(interaction.deferReply).not.toHaveBeenCalled()
    expect(sessionBridge.stopManagedSession).not.toHaveBeenCalled()
  })

  it('replies ephemerally when /clear is used outside a provisioned worktree channel', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    const { gateway } = makeGateway()
    const sessionBridge = {
      start: vi.fn(),
      dispose: vi.fn(),
      handleUserMessage: vi.fn(async () => undefined),
      clearManagedSession: vi.fn(async () => undefined)
    }
    const service = makeService(db, gateway, sessionBridge)
    await service.startListening()
    const interaction = {
      isChatInputCommand: vi.fn(() => true),
      commandName: 'clear',
      guildId: 'guild-1',
      channelId: 'unmapped-channel',
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined)
    }

    discordJsMock.instances[0].emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'This channel is not linked to a Hive worktree.',
      ephemeral: true
    })
    expect(interaction.deferReply).not.toHaveBeenCalled()
    expect(sessionBridge.clearManagedSession).not.toHaveBeenCalled()
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
})

describe('/archive slash command', () => {
  it('registers the Discord slash commands when the listener starts', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)
    await service.startListening()
    const client = discordJsMock.instances[0]

    expect(client.application.commands.set).toHaveBeenCalledWith(
      [
        { name: 'plan', description: 'Switch this worktree to plan mode' },
        { name: 'build', description: 'Switch this worktree to build mode' },
        { name: 'super-plan', description: 'Switch this worktree to super-plan mode' },
        { name: 'archive', description: 'Archive this worktree and delete its channel' },
        { name: 'stop', description: 'Abort the current running session' },
        { name: 'clear', description: 'Clear the session attached to this worktree channel' },
        {
          name: 'qa',
          description: 'Only post questions, plan approvals, and final results to channels'
        },
        { name: 'all', description: 'Post all agent activity to channels (default)' },
        {
          name: 'add-project',
          description: 'Clone a git repo and add it to Hive',
          options: [
            {
              type: 3,
              name: 'git_url',
              description: 'Git SSH URL (git@host:user/repo.git)',
              required: true
            }
          ]
        }
      ],
      'guild-1'
    )
  })

  it('archives a feature worktree and deletes its channel', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [
      makeWorktree('w1', 'p1', 'feature-a', { branch_name: 'feature-a' })
    ])
    db.resources = [makeResource()]
    const deleteResource = vi.spyOn(db, 'deleteDiscordResource')
    const channelDelete = vi.fn(async () => undefined)
    vi.mocked(deleteWorktreeOp).mockResolvedValue({ success: true })
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)
    await service.startListening()
    const client = discordJsMock.instances[0]
    client.channels.fetch.mockResolvedValue({ delete: channelDelete })
    const interaction = makeArchiveInteraction(client)

    client.emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true })
    expect(deleteWorktreeOp).toHaveBeenCalledWith({
      worktreeId: 'w1',
      worktreePath: '/repo/p1/feature-a',
      branchName: 'feature-a',
      projectPath: '/repo/test-python',
      archive: true
    })
    expect(interaction.editReply).toHaveBeenCalledWith('Worktree archived. Deleting channel...')
    expect(channelDelete).toHaveBeenCalledTimes(1)
    expect(deleteResource).toHaveBeenCalledWith('r-channel')
    expect(db.resources).toEqual([])
  })

  it('refuses to archive the default worktree channel', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [
      makeWorktree('w1', 'p1', 'main', { branch_name: 'main', is_default: true })
    ])
    db.resources = [makeResource()]
    const channelDelete = vi.fn(async () => undefined)
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)
    await service.startListening()
    const client = discordJsMock.instances[0]
    client.channels.fetch.mockResolvedValue({ delete: channelDelete })
    const interaction = makeArchiveInteraction(client)

    client.emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.editReply).toHaveBeenCalledWith('Cannot archive the base branch channel.')
    expect(deleteWorktreeOp).not.toHaveBeenCalled()
    expect(channelDelete).not.toHaveBeenCalled()
    expect(db.resources).toHaveLength(1)
  })

  it('reports archive failures without deleting the channel or resource mapping', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [makeProject('p1', 'test-python')]
    db.activeWorktrees.set('p1', [
      makeWorktree('w1', 'p1', 'feature-a', { branch_name: 'feature-a' })
    ])
    db.resources = [makeResource()]
    const channelDelete = vi.fn(async () => undefined)
    vi.mocked(deleteWorktreeOp).mockResolvedValue({
      success: false,
      error: 'branch has unmerged changes'
    })
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)
    await service.startListening()
    const client = discordJsMock.instances[0]
    client.channels.fetch.mockResolvedValue({ delete: channelDelete })
    const interaction = makeArchiveInteraction(client)

    client.emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.editReply).toHaveBeenCalledWith(
      'Could not archive worktree: branch has unmerged changes'
    )
    expect(channelDelete).not.toHaveBeenCalled()
    expect(db.resources).toHaveLength(1)
  })

  it('replies when archive is invoked outside a linked worktree channel', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)
    await service.startListening()
    const client = discordJsMock.instances[0]
    const interaction = makeArchiveInteraction(client, { channelId: 'unlinked-channel' })

    client.emit('interactionCreate', interaction)
    await flushPromises()

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'This channel is not linked to a worktree.',
      ephemeral: true
    })
    expect(interaction.deferReply).not.toHaveBeenCalled()
    expect(deleteWorktreeOp).not.toHaveBeenCalled()
  })
})

describe('DiscordService bridge configuration', () => {
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
