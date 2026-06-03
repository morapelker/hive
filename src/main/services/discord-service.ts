import { randomUUID } from 'crypto'
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type CategoryChannel,
  type Guild,
  type TextChannel
} from 'discord.js'
import type {
  DiscordConfig,
  DiscordGuild,
  DiscordProvisionProgress,
  DiscordProvisionSummary,
  DiscordVerifyResult
} from '@shared/types/discord'
import {
  DISCORD_PROVISION_PROGRESS_CHANNEL,
  DISCORD_STATUS_CHANGED_CHANNEL
} from '@shared/discord-events'
import type { DatabaseService } from '../db/database'
import { getDatabase } from '../db'
import type { DiscordResource, Project, Worktree } from '../db/types'

const DISCORD_CONFIG_KEY = 'discord_config'

export interface DiscordGateway {
  verify(botToken: string): Promise<DiscordVerifyResult>
  connect(botToken: string, guildId: string): Promise<void>
  createCategory(name: string): Promise<string>
  createTextChannel(name: string, parentId: string): Promise<string>
  deleteResource(discordId: string): Promise<void>
  disconnect(): Promise<void>
}

type BackendEventPublisher = (channel: string, payload: unknown) => void

interface DiscordServiceDependencies {
  db?: DatabaseService
  gatewayFactory?: () => DiscordGateway
  publishEvent?: BackendEventPublisher
}

class DiscordJsGateway implements DiscordGateway {
  private client: Client | null = null
  private guild: Guild | null = null

  async verify(botToken: string): Promise<DiscordVerifyResult> {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] })
    try {
      await client.login(botToken)
      const guilds = await client.guilds.fetch()
      return {
        ok: true,
        botUser: client.user?.tag ?? client.user?.username ?? undefined,
        guilds: guilds.map((guild) => ({ id: guild.id, name: guild.name }))
      }
    } catch (error) {
      return {
        ok: false,
        guilds: [],
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      client.destroy()
    }
  }

  async connect(botToken: string, guildId: string): Promise<void> {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] })
    await this.client.login(botToken)
    this.guild = await this.client.guilds.fetch(guildId)
  }

  async createCategory(name: string): Promise<string> {
    if (!this.guild) throw new Error('Discord guild is not connected')
    const channel = (await this.guild.channels.create({
      name,
      type: ChannelType.GuildCategory
    })) as CategoryChannel
    return channel.id
  }

  async createTextChannel(name: string, parentId: string): Promise<string> {
    if (!this.guild) throw new Error('Discord guild is not connected')
    const channel = (await this.guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parentId
    })) as TextChannel
    return channel.id
  }

  async deleteResource(discordId: string): Promise<void> {
    if (!this.client) throw new Error('Discord client is not connected')
    const channel = await this.client.channels.fetch(discordId)
    if (channel && 'delete' in channel && typeof channel.delete === 'function') {
      await channel.delete()
    }
  }

  async disconnect(): Promise<void> {
    this.guild = null
    this.client?.destroy()
    this.client = null
  }
}

const emptyConfig: DiscordConfig = {
  botToken: '',
  guildId: '',
  guildName: '',
  enabled: false,
  selectedProjectIds: []
}

const isConfigured = (config: DiscordConfig | null): boolean =>
  !!config?.botToken.trim() && !!config.guildId.trim()

const parseConfig = (raw: string | null): DiscordConfig | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DiscordConfig>
    return {
      botToken: typeof parsed.botToken === 'string' ? parsed.botToken : '',
      guildId: typeof parsed.guildId === 'string' ? parsed.guildId : '',
      guildName: typeof parsed.guildName === 'string' ? parsed.guildName : '',
      enabled: parsed.enabled === true,
      selectedProjectIds: Array.isArray(parsed.selectedProjectIds)
        ? parsed.selectedProjectIds.filter((id): id is string => typeof id === 'string')
        : []
    }
  } catch {
    return null
  }
}

const sortDeleteOrder = (resources: DiscordResource[]): DiscordResource[] =>
  [...resources].sort((left, right) => {
    if (left.type === right.type) return 0
    return left.type === 'channel' ? -1 : 1
  })

const getDiscordErrorCode = (error: unknown): number | string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' || typeof code === 'string' ? code : null
}

const toGuildAccessError = (guildId: string, error: unknown): Error => {
  const code = getDiscordErrorCode(error)
  const message = error instanceof Error ? error.message : String(error)
  if (code === 10004 || message.toLowerCase().includes('unknown guild')) {
    return new Error(
      `Discord bot cannot access guild ${guildId}. Invite the bot user to that server with the bot scope and Manage Channels permission, then verify again.`
    )
  }
  return error instanceof Error ? error : new Error(message)
}

export class DiscordService {
  private db: DatabaseService | null
  private gatewayFactory: () => DiscordGateway
  private publishEvent: BackendEventPublisher | null
  private activeGateway: DiscordGateway | null = null

  constructor(dependencies: DiscordServiceDependencies = {}) {
    this.db = dependencies.db ?? null
    this.gatewayFactory = dependencies.gatewayFactory ?? (() => new DiscordJsGateway())
    this.publishEvent = dependencies.publishEvent ?? null
  }

  setBackendEventPublisher(publishEvent: BackendEventPublisher | null): void {
    this.publishEvent = publishEvent
  }

  getConfig(): DiscordConfig | null {
    return parseConfig(this.getDb().getSetting(DISCORD_CONFIG_KEY))
  }

  setConfig(config: DiscordConfig | null): void {
    if (!config) {
      this.getDb().deleteSetting(DISCORD_CONFIG_KEY)
      this.emitStatus(null)
      return
    }
    const normalized: DiscordConfig = {
      botToken: config.botToken.trim(),
      guildId: config.guildId.trim(),
      guildName: config.guildName.trim(),
      enabled: config.enabled,
      selectedProjectIds: config.selectedProjectIds
    }
    this.getDb().setSetting(DISCORD_CONFIG_KEY, JSON.stringify(normalized))
    this.emitStatus(normalized)
  }

  async verify(botToken: string): Promise<DiscordVerifyResult> {
    const gateway = this.gatewayFactory()
    return gateway.verify(botToken)
  }

  async provision(selectedProjectIds: string[]): Promise<DiscordProvisionSummary> {
    const config = this.getConfig()
    if (!isConfigured(config)) {
      throw new Error('Discord is not configured')
    }

    const uniqueSelectedProjectIds = Array.from(new Set(selectedProjectIds))
    const selectedSet = new Set(uniqueSelectedProjectIds)
    const db = this.getDb()
    const projectsById = new Map(db.getAllProjects().map((project) => [project.id, project]))
    const guildResources = db.getDiscordResourcesByGuild(config.guildId)
    const activeWorktreesByProject = new Map<string, Worktree[]>()

    for (const projectId of uniqueSelectedProjectIds) {
      if (projectsById.has(projectId)) {
        activeWorktreesByProject.set(projectId, db.getActiveWorktreesByProject(projectId))
      }
    }

    const deleteCandidates = this.computeDeleteCandidates(
      guildResources,
      selectedSet,
      activeWorktreesByProject
    )
    const createCandidates = this.computeCreateCandidates(
      uniqueSelectedProjectIds,
      projectsById,
      activeWorktreesByProject,
      guildResources,
      deleteCandidates
    )
    const total = deleteCandidates.length + createCandidates.length
    let current = 0
    let created = 0
    let deleted = 0

    const gateway = this.gatewayFactory()
    this.activeGateway = gateway
    try {
      try {
        await gateway.connect(config.botToken, config.guildId)
      } catch (error) {
        throw toGuildAccessError(config.guildId, error)
      }

      for (const resource of deleteCandidates) {
        await gateway.deleteResource(resource.discord_id)
        db.deleteDiscordResource(resource.id)
        deleted += 1
        current += 1
        this.emitProgress({
          current,
          total,
          phase: 'delete',
          label:
            resource.type === 'category'
              ? `Deleted category mapping for ${resource.project_id}`
              : `Deleted channel mapping for ${resource.worktree_id ?? resource.project_id}`
        })
      }

      const categoryIds = new Map<string, string>()
      for (const resource of guildResources) {
        if (
          resource.type === 'category' &&
          !deleteCandidates.some((candidate) => candidate.id === resource.id)
        ) {
          categoryIds.set(resource.project_id, resource.discord_id)
        }
      }

      for (const candidate of createCandidates) {
        if (candidate.type === 'category') {
          const discordId = await gateway.createCategory(candidate.project.name)
          categoryIds.set(candidate.project.id, discordId)
          db.insertDiscordResource({
            id: randomUUID(),
            project_id: candidate.project.id,
            worktree_id: null,
            discord_id: discordId,
            type: 'category',
            guild_id: config.guildId
          })
          created += 1
          current += 1
          this.emitProgress({
            current,
            total,
            phase: 'create',
            label: `Created category ${candidate.project.name}`
          })
          continue
        }

        const categoryId = categoryIds.get(candidate.project.id)
        if (!categoryId) {
          throw new Error(`Missing Discord category for ${candidate.project.name}`)
        }
        const discordId = await gateway.createTextChannel(candidate.worktree.name, categoryId)
        db.insertDiscordResource({
          id: randomUUID(),
          project_id: candidate.project.id,
          worktree_id: candidate.worktree.id,
          discord_id: discordId,
          type: 'channel',
          guild_id: config.guildId
        })
        created += 1
        current += 1
        this.emitProgress({
          current,
          total,
          phase: 'create',
          label: `Created channel ${candidate.worktree.name}`
        })
      }

      this.setConfig({ ...config, enabled: true, selectedProjectIds: uniqueSelectedProjectIds })
      return { created, deleted }
    } finally {
      await gateway.disconnect().catch(() => undefined)
      if (this.activeGateway === gateway) {
        this.activeGateway = null
      }
    }
  }

  async disable(): Promise<void> {
    const config = this.getConfig()
    if (config) {
      this.setConfig({ ...config, enabled: false })
    } else {
      this.emitStatus(null)
    }
    await this.activeGateway?.disconnect().catch(() => undefined)
    this.activeGateway = null
  }

  private computeDeleteCandidates(
    resources: DiscordResource[],
    selectedProjectIds: Set<string>,
    activeWorktreesByProject: Map<string, Worktree[]>
  ): DiscordResource[] {
    const activeWorktreeIds = new Map<string, Set<string>>()
    for (const [projectId, worktrees] of activeWorktreesByProject) {
      activeWorktreeIds.set(projectId, new Set(worktrees.map((worktree) => worktree.id)))
    }

    return sortDeleteOrder(
      resources.filter((resource) => {
        if (!selectedProjectIds.has(resource.project_id)) return true
        if (resource.type === 'category') return false
        if (!resource.worktree_id) return true
        return !(activeWorktreeIds.get(resource.project_id)?.has(resource.worktree_id) ?? false)
      })
    )
  }

  private computeCreateCandidates(
    selectedProjectIds: string[],
    projectsById: Map<string, Project>,
    activeWorktreesByProject: Map<string, Worktree[]>,
    resources: DiscordResource[],
    deleteCandidates: DiscordResource[]
  ): Array<
    | { type: 'category'; project: Project }
    | { type: 'channel'; project: Project; worktree: Worktree }
  > {
    const deletingIds = new Set(deleteCandidates.map((resource) => resource.id))
    const keptResources = resources.filter((resource) => !deletingIds.has(resource.id))
    const candidates: Array<
      | { type: 'category'; project: Project }
      | { type: 'channel'; project: Project; worktree: Worktree }
    > = []

    for (const projectId of selectedProjectIds) {
      const project = projectsById.get(projectId)
      if (!project) continue

      const categoryExists = keptResources.some(
        (resource) => resource.project_id === projectId && resource.type === 'category'
      )
      if (!categoryExists) {
        candidates.push({ type: 'category', project })
      }

      const mappedWorktreeIds = new Set(
        keptResources
          .filter(
            (resource) =>
              resource.project_id === projectId &&
              resource.type === 'channel' &&
              resource.worktree_id
          )
          .map((resource) => resource.worktree_id)
      )
      for (const worktree of activeWorktreesByProject.get(projectId) ?? []) {
        if (!mappedWorktreeIds.has(worktree.id)) {
          candidates.push({ type: 'channel', project, worktree })
        }
      }
    }

    return candidates
  }

  private emitProgress(progress: DiscordProvisionProgress): void {
    this.publishEvent?.(DISCORD_PROVISION_PROGRESS_CHANNEL, progress)
  }

  private emitStatus(config: DiscordConfig | null): void {
    this.publishEvent?.(DISCORD_STATUS_CHANGED_CHANNEL, {
      enabled: config?.enabled === true,
      configured: isConfigured(config)
    })
  }

  private getDb(): DatabaseService {
    if (!this.db) {
      this.db = getDatabase()
    }
    return this.db
  }
}

export const discordService = new DiscordService()
