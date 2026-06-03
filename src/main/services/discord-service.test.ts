import { describe, expect, it, vi } from 'vitest'
import { DiscordService } from './discord-service'
import type { DiscordResource } from '../db/types'

type ProjectSeed = {
  id: string
  name: string
}

type WorktreeSeed = {
  id: string
  project_id: string
  name: string
}

class FakeDiscordDatabase {
  settings = new Map<string, string>()
  resources: DiscordResource[] = []
  projects: ProjectSeed[] = []
  activeWorktrees = new Map<string, WorktreeSeed[]>()

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null
  }

  setSetting(key: string, value: string): void {
    this.settings.set(key, value)
  }

  getAllProjects(): ProjectSeed[] {
    return this.projects
  }

  getActiveWorktreesByProject(projectId: string): WorktreeSeed[] {
    return this.activeWorktrees.get(projectId) ?? []
  }

  getDiscordResourcesByGuild(guildId: string): DiscordResource[] {
    return this.resources.filter((resource) => resource.guild_id === guildId)
  }

  insertDiscordResource(resource: DiscordResource): void {
    this.resources.push(resource)
  }

  deleteDiscordResource(id: string): void {
    this.resources = this.resources.filter((resource) => resource.id !== id)
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

const makeService = (db: FakeDiscordDatabase, gateway: ReturnType<typeof makeGateway>['gateway']) =>
  new DiscordService({
    db: db as never,
    gatewayFactory: () => gateway
  })

describe('DiscordService provisioning reconciliation', () => {
  it('creates a category per selected project and a channel per active worktree', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [{ id: 'p1', name: 'test-python' }]
    db.activeWorktrees.set('p1', [
      { id: 'w1', project_id: 'p1', name: 'main' },
      { id: 'w2', project_id: 'p1', name: 'feature-a' }
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
    db.projects = [{ id: 'p1', name: 'test-python' }]
    db.activeWorktrees.set('p1', [{ id: 'w1', project_id: 'p1', name: 'main' }])
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        created_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'r-channel',
        project_id: 'p1',
        worktree_id: 'w1',
        discord_id: 'channel-1',
        type: 'channel',
        guild_id: 'guild-1',
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ]
    const { gateway } = makeGateway()
    const service = makeService(db, gateway)

    const summary = await service.provision(['p1'])

    expect(summary).toEqual({ created: 0, deleted: 0 })
    expect(gateway.createCategory).not.toHaveBeenCalled()
    expect(gateway.createTextChannel).not.toHaveBeenCalled()
    expect(db.resources).toHaveLength(2)
  })

  it('deduplicates selected project ids before creating resources', async () => {
    const db = new FakeDiscordDatabase()
    configure(db)
    db.projects = [{ id: 'p1', name: 'test-python' }]
    db.activeWorktrees.set('p1', [{ id: 'w1', project_id: 'p1', name: 'main' }])
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
    db.projects = [{ id: 'p1', name: 'test-python' }]
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        created_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'r-channel',
        project_id: 'p1',
        worktree_id: 'w1',
        discord_id: 'channel-1',
        type: 'channel',
        guild_id: 'guild-1',
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
    db.projects = [{ id: 'p1', name: 'test-python' }]
    db.activeWorktrees.set('p1', [{ id: 'w1', project_id: 'p1', name: 'main' }])
    db.resources = [
      {
        id: 'r-category',
        project_id: 'p1',
        worktree_id: null,
        discord_id: 'category-1',
        type: 'category',
        guild_id: 'guild-1',
        created_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'r-active',
        project_id: 'p1',
        worktree_id: 'w1',
        discord_id: 'channel-1',
        type: 'channel',
        guild_id: 'guild-1',
        created_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'r-archived',
        project_id: 'p1',
        worktree_id: 'w2',
        discord_id: 'channel-archived',
        type: 'channel',
        guild_id: 'guild-1',
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
    db.projects = [{ id: 'p1', name: 'test-python' }]
    db.activeWorktrees.set('p1', [{ id: 'w1', project_id: 'p1', name: 'main' }])
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
    db.projects = [{ id: 'p1', name: 'test-python' }]
    db.activeWorktrees.set('p1', [{ id: 'w1', project_id: 'p1', name: 'main' }])
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
    db.projects = [{ id: 'p1', name: 'test-python' }]
    const { gateway } = makeGateway()
    gateway.connect.mockRejectedValueOnce(Object.assign(new Error('Unknown Guild'), { code: 10004 }))
    const service = makeService(db, gateway)

    await expect(service.provision(['p1'])).rejects.toThrow(
      'Discord bot cannot access guild guild-1'
    )

    expect(gateway.disconnect).toHaveBeenCalledTimes(1)
  })
})
