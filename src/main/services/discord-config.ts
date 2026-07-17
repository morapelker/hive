import type { DiscordConfig } from '@shared/types/discord'

export const DISCORD_CONFIG_KEY = 'discord_config'

interface SettingsReader {
  getSetting(key: string): string | null
}

export const isConfigured = (config: DiscordConfig | null): config is DiscordConfig =>
  !!config?.botToken.trim() && !!config.guildId.trim()

export const parseConfig = (raw: string | null): DiscordConfig | null => {
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

const parseEnvBoolean = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined) return fallback
  const normalized = raw.trim().toLowerCase()
  if (!normalized) return fallback
  return !['0', 'false', 'no', 'off'].includes(normalized)
}

const parseEnvProjectIds = (raw: string | undefined): string[] => {
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return Array.from(
        new Set(parsed.filter((id): id is string => typeof id === 'string').map((id) => id.trim()))
      ).filter((id) => id.length > 0)
    }
  } catch {
    // Fall back to comma-separated values.
  }
  return Array.from(new Set(raw.split(',').map((id) => id.trim()))).filter((id) => id.length > 0)
}

export const getEnvConfig = (env: NodeJS.ProcessEnv = process.env): DiscordConfig | null => {
  const botToken = env.HIVE_DISCORD_BOT_TOKEN?.trim() ?? ''
  const guildId = env.HIVE_DISCORD_GUILD_ID?.trim() ?? ''
  if (!botToken || !guildId) return null
  return {
    botToken,
    guildId,
    guildName: env.HIVE_DISCORD_GUILD_NAME?.trim() || guildId,
    enabled: parseEnvBoolean(env.HIVE_DISCORD_ENABLED, true),
    selectedProjectIds: parseEnvProjectIds(env.HIVE_DISCORD_SELECTED_PROJECT_IDS)
  }
}

export const isBlankConfig = (config: DiscordConfig | null): boolean =>
  !config || (!config.botToken.trim() && !config.guildId.trim())

export const getDiscordConfig = (db: SettingsReader): DiscordConfig | null => {
  const savedConfig = parseConfig(db.getSetting(DISCORD_CONFIG_KEY))
  return isBlankConfig(savedConfig) ? getEnvConfig() : savedConfig
}

export const isDiscordModeEnabled = (db: SettingsReader): boolean => {
  const config = getDiscordConfig(db)
  return isConfigured(config) && config.enabled === true
}
