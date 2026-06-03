export interface DiscordConfig {
  botToken: string
  guildId: string
  guildName: string
  enabled: boolean
  selectedProjectIds: string[]
}

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
