import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type CategoryChannel,
  type Guild,
  type Interaction,
  type Message,
  type NonThreadGuildBasedChannel,
  type TextBasedChannel,
  type TextChannel
} from 'discord.js'
import type {
  DiscordConfig,
  DiscordEmissionMode,
  DiscordProvisionProgress,
  DiscordProvisionSummary,
  DiscordVerifyResult
} from '@shared/types/discord'
import {
  DISCORD_PROVISION_PROGRESS_CHANNEL,
  DISCORD_STATUS_CHANGED_CHANNEL
} from '@shared/discord-events'
import { WORKTREE_CREATED_CHANNEL } from '@shared/worktree-events'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'
import type { DatabaseService } from '../db/database'
import { getDatabase } from '../db'
import type { DiscordResource, Project, SessionMode, Worktree } from '../db/types'
import { createGitService } from './git-service'
import { createLogger } from './logger'
import {
  createWorktreeFromBranchOp,
  deleteWorktreeOp,
  syncWorktreesOp
} from './worktree-ops'
import {
  createProjectWithDefaultWorktree,
  detectProjectFavicon,
  detectProjectLanguage
} from './project-ops'
import { cloneRepository, deriveProjectNameFromGitUrl } from './git-repository'
import { discordSessionBridge, type DiscordSessionBridge } from './discord-session-bridge'
import type { AgentSdkManager } from './agent-sdk-manager'
import { createPrFromWorktree } from './discord-pr-creator'

const DISCORD_CONFIG_KEY = 'discord_config'
const log = createLogger({ component: 'Discord' })
type DiscordCommand = {
  name: string
  description: string
  options?: Array<{
    type: 3
    name: string
    description: string
    required: boolean
  }>
}
const DISCORD_COMMANDS: DiscordCommand[] = [
  { name: 'plan', description: 'Switch this worktree to plan mode' },
  { name: 'build', description: 'Switch this worktree to build mode' },
  { name: 'super-plan', description: 'Switch this worktree to super-plan mode' },
  { name: 'archive', description: 'Archive this worktree and delete its channel' },
  { name: 'stop', description: 'Abort the current running session' },
  { name: 'pr', description: 'Create a pull request from this worktree branch' },
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
]

export interface DiscordGateway {
  verify(botToken: string): Promise<DiscordVerifyResult>
  connect(botToken: string, guildId: string): Promise<void>
  registerCommands(): Promise<void>
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
  sessionBridge?: DiscordSessionBridge
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

  async registerCommands(): Promise<void> {
    if (!this.guild) throw new Error('Discord guild is not connected')
    await this.guild.commands.set(DISCORD_COMMANDS)
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

const isConfigured = (config: DiscordConfig | null): config is DiscordConfig =>
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

const parseSessionTitles = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (title): title is string => typeof title === 'string' && title.trim().length > 0
        )
      : []
  } catch {
    return []
  }
}

const buildPrCommitMessage = (worktree: Worktree): string => {
  const titles = parseSessionTitles(worktree.session_titles)
  const summary = titles[0]?.trim() || worktree.branch_name || worktree.name || 'Update worktree'
  const description = titles.length > 1 ? titles.map((title) => `- ${title.trim()}`).join('\n') : ''
  return description ? `${summary}\n\n${description}` : summary
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
  private listenerClient: Client | null = null
  private botCreatedChannelIds = new Set<string>()
  private sessionBridge: DiscordSessionBridge

  constructor(dependencies: DiscordServiceDependencies = {}) {
    this.db = dependencies.db ?? null
    this.gatewayFactory = dependencies.gatewayFactory ?? (() => new DiscordJsGateway())
    this.publishEvent = dependencies.publishEvent ?? null
    this.sessionBridge = dependencies.sessionBridge ?? discordSessionBridge
  }

  setBackendEventPublisher(publishEvent: BackendEventPublisher | null): void {
    this.publishEvent = publishEvent
    this.sessionBridge.setBackendEventPublisher(publishEvent)
  }

  setAgentSdkManager(manager: AgentSdkManager | null): void {
    this.sessionBridge.setAgentSdkManager(manager)
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
      await gateway.registerCommands().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        log.error(
          'Failed to register Discord slash commands',
          error instanceof Error ? error : new Error(message),
          {
            guildId: config.guildId
          }
        )
      })

      for (const resource of deleteCandidates) {
        try {
          await gateway.deleteResource(resource.discord_id)
        } catch (error) {
          if (getDiscordErrorCode(error) !== 10003) {
            throw error
          }
          log.warn('Discord resource was already deleted; removing stale mapping', {
            discordId: resource.discord_id,
            resourceId: resource.id,
            resourceType: resource.type,
            guildId: config.guildId
          })
        }
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
        this.botCreatedChannelIds.add(discordId)
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
      await this.startListening().catch((error) => {
        log.error(
          'Failed to start Discord listener after provisioning',
          error instanceof Error ? error : new Error(String(error))
        )
      })
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
    await this.stopListening()
  }

  async startListening(): Promise<void> {
    const config = this.getConfig()
    if (!isConfigured(config) || config.enabled !== true) {
      await this.stopListening()
      return
    }

    if (this.listenerClient?.isReady()) {
      return
    }

    if (this.listenerClient) {
      await this.stopListening()
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    })

    client.on('messageCreate', (message) => {
      void this.handleIncomingMessage(message)
    })
    client.on('interactionCreate', (interaction) => {
      void this.handleInteraction(interaction)
    })
    client.on('channelCreate', (channel) => {
      void this.handleChannelCreate(channel)
    })
    client.once('clientReady', (readyClient) => {
      log.info('Discord listener connected', {
        botUser: readyClient.user?.tag ?? readyClient.user?.username ?? undefined,
        guildId: config.guildId
      })
    })
    client.on('error', (error) => {
      log.error('Discord listener error', error instanceof Error ? error : new Error(String(error)))
    })

    try {
      await client.login(config.botToken)
      this.listenerClient = client
      const bridgeWithResolver = this.sessionBridge as DiscordSessionBridge & {
        setChannelResolver?: DiscordSessionBridge['setChannelResolver']
      }
      bridgeWithResolver.setChannelResolver?.(async (channelId) => {
        const channel = await client.channels.fetch(channelId)
        if (
          channel &&
          'isTextBased' in channel &&
          typeof channel.isTextBased === 'function' &&
          channel.isTextBased() &&
          'send' in channel &&
          typeof channel.send === 'function' &&
          'sendTyping' in channel &&
          typeof channel.sendTyping === 'function'
        ) {
          return channel as TextBasedChannel & {
            sendTyping: () => Promise<unknown>
          }
        }
        return null
      })
      this.sessionBridge.start()
      await this.registerSlashCommands(client, config.guildId)
    } catch (error) {
      client.destroy()
      log.error(
        'Failed to start Discord listener',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }

  async stopListening(): Promise<void> {
    this.listenerClient?.destroy()
    this.listenerClient = null
    ;(
      this.sessionBridge as DiscordSessionBridge & {
        setChannelResolver?: DiscordSessionBridge['setChannelResolver']
      }
    ).setChannelResolver?.(null)
    this.sessionBridge.dispose()
  }

  private async handleIncomingMessage(message: Message): Promise<void> {
    if (message.author.bot) return

    const config = this.getConfig()
    if (!isConfigured(config) || message.guildId !== config.guildId) return

    const db = this.getDb()
    const provisionedChannel = db
      .getDiscordResourcesByGuild(config.guildId)
      .find((resource) => resource.type === 'channel' && resource.discord_id === message.channelId)
    if (!provisionedChannel) return

    log.info('Discord message received', {
      channelId: message.channelId,
      author: message.author.tag,
      content: message.content
    })

    const channel = message.channel
    if (
      !channel.isTextBased() ||
      !('send' in channel) ||
      typeof channel.send !== 'function' ||
      !('sendTyping' in channel) ||
      typeof channel.sendTyping !== 'function'
    ) {
      return
    }

    try {
      if (!provisionedChannel.worktree_id) return
      const worktree = db.getWorktree(provisionedChannel.worktree_id)
      if (!worktree) return
      await this.sessionBridge.handleUserMessage({
        channelId: message.channelId,
        worktreeId: worktree.id,
        projectId: provisionedChannel.project_id,
        worktreePath: worktree.path,
        text: message.content,
        channel
      })
    } catch (error) {
      log.error(
        'Failed to handle Discord message',
        error instanceof Error ? error : new Error(String(error)),
        {
          channelId: message.channelId
        }
      )
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    const maybeComponent = interaction as Interaction & {
      isButton?: () => boolean
      isStringSelectMenu?: () => boolean
      isModalSubmit?: () => boolean
    }
    if (maybeComponent.isButton?.() || maybeComponent.isStringSelectMenu?.()) {
      await this.sessionBridge.handleComponentInteraction(interaction)
      return
    }

    if (maybeComponent.isModalSubmit?.()) {
      await this.sessionBridge.handleModalSubmit(interaction)
      return
    }

    if (!interaction.isChatInputCommand()) return

    const mode = this.modeFromCommand(interaction.commandName)
    if (mode) {
      await this.handleModeInteraction(interaction, mode)
      return
    }

    if (interaction.commandName === 'qa' || interaction.commandName === 'all') {
      await this.handleEmissionModeInteraction(interaction)
      return
    }

    if (interaction.commandName === 'archive') {
      await this.handleArchiveInteraction(interaction)
      return
    }

    if (interaction.commandName === 'add-project') {
      await this.handleAddProjectInteraction(interaction)
      return
    }

    if (interaction.commandName === 'clear') {
      await this.handleClearInteraction(interaction)
      return
    }

    if (interaction.commandName === 'stop') {
      await this.handleStopInteraction(interaction)
      return
    }

    if (interaction.commandName === 'pr') {
      await this.handlePrInteraction(interaction)
    }
  }

  private async registerSlashCommands(client: Client, guildId: string): Promise<void> {
    try {
      await client.application?.commands.set(DISCORD_COMMANDS, guildId)
    } catch (error) {
      log.error(
        'Failed to register Discord commands. Re-invite the bot with the applications.commands OAuth scope if commands do not appear.',
        error instanceof Error ? error : new Error(String(error)),
        { guildId }
      )
    }
  }

  private async handleModeInteraction(
    interaction: ChatInputCommandInteraction,
    mode: SessionMode
  ): Promise<void> {
    const config = this.getConfig()
    if (!isConfigured(config) || interaction.guildId !== config.guildId) return

    const db = this.getDb()
    const provisionedChannel = db
      .getDiscordResourcesByGuild(config.guildId)
      .find(
        (resource) => resource.type === 'channel' && resource.discord_id === interaction.channelId
      )

    if (!provisionedChannel?.worktree_id) {
      await interaction.reply({
        content: 'This channel is not linked to a worktree.',
        ephemeral: true
      })
      return
    }

    const worktree = db.getWorktree(provisionedChannel.worktree_id)
    if (!worktree) {
      await interaction.reply({
        content: 'This channel is not linked to a worktree.',
        ephemeral: true
      })
      return
    }

    await interaction.deferReply()
    try {
      await this.sessionBridge.setWorktreeMode(
        {
          worktreeId: worktree.id,
          projectId: provisionedChannel.project_id,
          worktreePath: worktree.path
        },
        mode
      )
      await interaction.editReply(`Changed to ${mode} mode`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(
        'Failed to handle Discord mode command',
        error instanceof Error ? error : new Error(message),
        {
          channelId: interaction.channelId,
          commandName: interaction.commandName
        }
      )
      await interaction.editReply(`Could not change mode: ${message}`)
    }
  }

  private modeFromCommand(
    commandName: ChatInputCommandInteraction['commandName']
  ): SessionMode | null {
    if (commandName === 'plan' || commandName === 'build' || commandName === 'super-plan') {
      return commandName
    }
    return null
  }

  private async handleAddProjectInteraction(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const config = this.getConfig()
    if (!isConfigured(config) || interaction.guildId !== config.guildId) return

    await interaction.deferReply()

    try {
      const url = interaction.options.getString('git_url', true)
      const name = deriveProjectNameFromGitUrl(url)
      if (!name) {
        await interaction.editReply('Could not derive a project name from that git URL.')
        return
      }

      const destDir = join(homedir(), 'hive-projects', name)
      const db = this.getDb()
      const existingProject = db.getProjectByPath(destDir)
      if (existingProject) {
        if (this.isProjectManagedInDiscord(db, config.guildId, existingProject.id, config)) {
          await interaction.editReply(
            `Project **${existingProject.name}** is already added to Hive and managed by Discord.`
          )
          return
        }

        await this.provision([...config.selectedProjectIds, existingProject.id])
        await interaction.editReply(
          `Project **${existingProject.name}** already exists in Hive; added it to Discord management.`
        )
        return
      }

      const pathExists = existsSync(destDir)

      if (!pathExists) {
        mkdirSync(dirname(destDir), { recursive: true })
        const cloneResult = await cloneRepository(url, destDir)
        if (!cloneResult.success) {
          rmSync(destDir, { recursive: true, force: true })
          await interaction.editReply(
            `Could not clone repository: ${cloneResult.error ?? 'unknown error'}`
          )
          return
        }
      }

      const project = createProjectWithDefaultWorktree(db, { name, path: destDir })
      const syncResult = await syncWorktreesOp({
        projectId: project.id,
        projectPath: destDir
      })
      if (!syncResult.success) {
        throw new Error(syncResult.error || 'Failed to sync worktrees')
      }

      void detectProjectLanguage(destDir)
        .then((language) => {
          if (language) db.updateProject(project.id, { language })
        })
        .catch(() => undefined)

      try {
        const favicon = detectProjectFavicon(destDir)
        if (favicon) db.updateProject(project.id, { detected_icon: favicon })
      } catch {
        // Best-effort metadata detection should not block onboarding.
      }

      await this.provision([...config.selectedProjectIds, project.id])
      await interaction.editReply(
        pathExists
          ? `Added existing path **${name}** to Hive and provisioned its Discord channel.`
          : `Added **${name}** and provisioned its Discord channel.`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(
        'Failed to handle /add-project',
        error instanceof Error ? error : new Error(message),
        {
          guildId: interaction.guildId ?? undefined,
          channelId: interaction.channelId ?? undefined
        }
      )

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`Could not add project: ${message}`).catch(() => undefined)
      } else {
        await interaction
          .reply({ content: `Could not add project: ${message}`, ephemeral: true })
          .catch(() => undefined)
      }
    }
  }

  private isProjectManagedInDiscord(
    db: DatabaseService,
    guildId: string,
    projectId: string,
    config: DiscordConfig
  ): boolean {
    if (!config.selectedProjectIds.includes(projectId)) return false

    const resources = db.getDiscordResourcesByGuild(guildId)
    const hasCategory = resources.some(
      (resource) => resource.project_id === projectId && resource.type === 'category'
    )
    if (!hasCategory) return false

    const activeWorktrees = db.getActiveWorktreesByProject(projectId)
    return activeWorktrees.every((worktree) =>
      resources.some(
        (resource) =>
          resource.project_id === projectId &&
          resource.worktree_id === worktree.id &&
          resource.type === 'channel'
      )
    )
  }

  private async handleEmissionModeInteraction(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const config = this.getConfig()
    if (!isConfigured(config) || interaction.guildId !== config.guildId) return

    const mode: DiscordEmissionMode = interaction.commandName === 'qa' ? 'qa' : 'all'
    this.sessionBridge.setEmissionMode(mode)

    const content =
      mode === 'qa'
        ? "QA mode on — I'll only post questions, plan approvals, and the final result of each run."
        : "Verbose mode on — I'll post all agent activity to channels."
    await interaction.reply({ content, ephemeral: true })
  }

  private async handleArchiveInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = this.getConfig()
    if (!isConfigured(config) || interaction.guildId !== config.guildId) return

    const db = this.getDb()
    const provisionedChannel = db
      .getDiscordResourcesByGuild(config.guildId)
      .find(
        (resource) => resource.type === 'channel' && resource.discord_id === interaction.channelId
      )

    if (!provisionedChannel) {
      await interaction.reply({
        content: 'This channel is not linked to a worktree.',
        ephemeral: true
      })
      return
    }

    await interaction.deferReply({ ephemeral: true })

    try {
      const worktree = provisionedChannel.worktree_id
        ? db.getWorktree(provisionedChannel.worktree_id)
        : null
      if (!worktree) {
        await interaction.editReply('No worktree found for this channel.')
        return
      }

      if (worktree.is_default) {
        await interaction.editReply('Cannot archive the base branch channel.')
        return
      }

      const project = db.getProject(provisionedChannel.project_id)
      if (!project) {
        await interaction.editReply('Project not found.')
        return
      }

      const result = await deleteWorktreeOp({
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        branchName: worktree.branch_name,
        projectPath: project.path,
        archive: true
      })

      if (!result.success) {
        await interaction.editReply(`Could not archive worktree: ${result.error}`)
        return
      }

      await interaction.editReply('Worktree archived. Deleting channel...')
      const channel = await interaction.client.channels.fetch(provisionedChannel.discord_id)
      if (channel && 'delete' in channel && typeof channel.delete === 'function') {
        await channel.delete()
      }
      db.deleteDiscordResource(provisionedChannel.id)
    } catch (error) {
      log.error(
        'Failed to handle /archive',
        error instanceof Error ? error : new Error(String(error)),
        { channelId: interaction.channelId }
      )
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Failed to archive worktree.').catch(() => undefined)
      } else {
        await interaction
          .reply({ content: 'Failed to archive worktree.', ephemeral: true })
          .catch(() => undefined)
      }
    }
  }

  private async handleClearInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = this.getConfig()
    if (!isConfigured(config) || interaction.guildId !== config.guildId) {
      return
    }

    try {
      const db = this.getDb()
      const provisionedChannel = db
        .getDiscordResourcesByGuild(config.guildId)
        .find(
          (resource) => resource.type === 'channel' && resource.discord_id === interaction.channelId
        )

      if (!provisionedChannel?.worktree_id) {
        await interaction.reply({
          content: 'This channel is not linked to a Hive worktree.',
          ephemeral: true
        })
        return
      }

      const worktree = db.getWorktree(provisionedChannel.worktree_id)
      if (!worktree) {
        await interaction.reply({
          content: 'This channel is not linked to a Hive worktree.',
          ephemeral: true
        })
        return
      }

      await interaction.deferReply()
      await this.sessionBridge.clearManagedSession({
        worktreeId: worktree.id,
        worktreePath: worktree.path
      })
      await interaction.editReply('Session cleared. Your next message will start a fresh session.')
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      log.error('Failed to handle Discord /clear command', normalized, {
        channelId: interaction.channelId ?? undefined
      })

      const content = 'Could not clear the session. Check the Hive logs for details.'
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(content).catch(() => undefined)
      } else {
        await interaction.reply({ content, ephemeral: true }).catch(() => undefined)
      }
    }
  }

  private async handleStopInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = this.getConfig()
    if (!isConfigured(config) || interaction.guildId !== config.guildId) {
      return
    }

    try {
      const db = this.getDb()
      const provisionedChannel = db
        .getDiscordResourcesByGuild(config.guildId)
        .find(
          (resource) => resource.type === 'channel' && resource.discord_id === interaction.channelId
        )

      if (!provisionedChannel?.worktree_id) {
        await interaction.reply({
          content: 'This channel is not linked to a Hive worktree.',
          ephemeral: true
        })
        return
      }

      const worktree = db.getWorktree(provisionedChannel.worktree_id)
      if (!worktree) {
        await interaction.reply({
          content: 'This channel is not linked to a Hive worktree.',
          ephemeral: true
        })
        return
      }

      await interaction.deferReply()
      const stopped = await this.sessionBridge.stopManagedSession({
        worktreeId: worktree.id,
        worktreePath: worktree.path
      })
      await interaction.editReply(stopped ? 'Session stopped.' : 'No running session to stop.')
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      log.error('Failed to handle Discord /stop command', normalized, {
        channelId: interaction.channelId ?? undefined
      })

      const content = 'Could not stop the session. Check the Hive logs for details.'
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(content).catch(() => undefined)
      } else {
        await interaction.reply({ content, ephemeral: true }).catch(() => undefined)
      }
    }
  }

  private async handlePrInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = this.getConfig()
    if (!isConfigured(config) || interaction.guildId !== config.guildId) {
      return
    }

    try {
      const db = this.getDb()
      const provisionedChannel = db
        .getDiscordResourcesByGuild(config.guildId)
        .find(
          (resource) => resource.type === 'channel' && resource.discord_id === interaction.channelId
        )

      if (!provisionedChannel?.worktree_id) {
        await interaction.reply({
          content: 'This channel is not linked to a Hive worktree.',
          ephemeral: true
        })
        return
      }

      const worktree = db.getWorktree(provisionedChannel.worktree_id)
      if (!worktree) {
        await interaction.reply({
          content: 'This channel is not linked to a Hive worktree.',
          ephemeral: true
        })
        return
      }

      const commitMessage = buildPrCommitMessage(worktree)
      const displayBase = worktree.base_branch?.trim() || 'main'

      await interaction.deferReply()
      const result = await createPrFromWorktree({
        worktreePath: worktree.path,
        baseBranch: worktree.base_branch,
        commitMessage
      })

      if ((result.status === 'created' || result.status === 'exists') && result.number) {
        db.attachPR(worktree.id, result.number, result.url)
      }

      if (result.status === 'created') {
        await interaction.editReply(`Pull request created: ${result.url}`)
        return
      }

      if (result.status === 'exists') {
        await interaction.editReply(`A pull request already exists: ${result.url}`)
        return
      }

      if (result.status === 'nothing') {
        await interaction.editReply(
          `Nothing to open a PR for — no commits ahead of ${displayBase}.`
        )
        return
      }

      await interaction.editReply(`Could not create the PR: ${result.message}`)
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      log.error('Failed to handle Discord /pr command', normalized, {
        channelId: interaction.channelId ?? undefined
      })

      const content = 'Could not create the PR. Check the Hive logs for details.'
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(content).catch(() => undefined)
      } else {
        await interaction.reply({ content, ephemeral: true }).catch(() => undefined)
      }
    }
  }

  private async handleChannelCreate(channel: NonThreadGuildBasedChannel): Promise<void> {
    const config = this.getConfig()
    if (!isConfigured(config) || config.enabled !== true || channel.guildId !== config.guildId) {
      return
    }

    if (channel.type !== ChannelType.GuildText) {
      return
    }

    if (this.botCreatedChannelIds.has(channel.id)) {
      this.botCreatedChannelIds.delete(channel.id)
      return
    }

    const db = this.getDb()
    const resources = db.getDiscordResourcesByGuild(config.guildId)
    if (resources.some((resource) => resource.discord_id === channel.id)) {
      return
    }

    const categoryResource = resources.find(
      (resource) => resource.type === 'category' && resource.discord_id === channel.parentId
    )
    if (!categoryResource) {
      return
    }

    const projectId = categoryResource.project_id
    const project = db.getProject(projectId)
    if (!project) {
      return
    }

    const nameHint = canonicalizeTicketTitle(channel.name)
    if (!nameHint) {
      await this.sendChannelMessage(
        channel,
        'Could not create worktree: channel name does not contain any branch-safe characters.'
      )
      return
    }

    try {
      const defaultWorktree = db
        .getActiveWorktreesByProject(projectId)
        .find((worktree) => worktree.is_default)
      const baseBranch =
        defaultWorktree?.branch_name ?? (await createGitService(project.path).getDefaultBranch())

      const result = await createWorktreeFromBranchOp({
        projectId,
        projectPath: project.path,
        projectName: project.name,
        branchName: baseBranch,
        nameHint
      })

      if (!result.success || !result.worktree) {
        throw new Error(result.error || 'Failed to create worktree')
      }

      db.insertDiscordResource({
        id: randomUUID(),
        project_id: projectId,
        worktree_id: result.worktree.id,
        discord_id: channel.id,
        type: 'channel',
        guild_id: config.guildId
      })

      this.publishEvent?.(WORKTREE_CREATED_CHANNEL, {
        projectId,
        worktree: result.worktree
      })

      await this.sendChannelMessage(channel, `Created worktree \`${result.worktree.branch_name}\``)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(
        'Failed to create worktree for Discord channel',
        error instanceof Error ? error : new Error(message),
        {
          channelId: channel.id,
          channelName: channel.name,
          projectId
        }
      )
      await this.sendChannelMessage(channel, `Could not create worktree: ${message}`)
    }
  }

  private async sendChannelMessage(
    channel: NonThreadGuildBasedChannel,
    message: string
  ): Promise<void> {
    const maybeSendable = channel as NonThreadGuildBasedChannel & {
      send?: (content: string) => Promise<unknown> | unknown
    }
    if (
      !channel.isTextBased() ||
      !('send' in maybeSendable) ||
      typeof maybeSendable.send !== 'function'
    ) {
      return
    }
    await maybeSendable.send(message)
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
