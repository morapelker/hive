export interface DiscordConfig {
  botToken: string
  guildId: string
  guildName: string
  enabled: boolean
  selectedProjectIds: string[]
}

/**
 * Bot-global verbosity mode for what the bot posts to Discord channels.
 * - 'all': emit everything (intermediate messages + tool calls + interactive prompts).
 * - 'qa': only emit attention-required messages (questions, plan approvals,
 *   permission/command approvals) plus the final message of each run.
 */
export type DiscordEmissionMode = 'all' | 'qa'

export interface DiscordGuild {
  id: string
  name: string
}

export interface DiscordVerifyResult {
  ok: boolean
  botUser?: string
  guilds: DiscordGuild[]
  error?: string
}

export interface DiscordProvisionProgress {
  current: number
  total: number
  label: string
  phase: 'create' | 'delete'
}

export interface DiscordProvisionSummary {
  created: number
  deleted: number
}

export interface DiscordStatusChangedPayload {
  enabled: boolean
  configured: boolean
}
