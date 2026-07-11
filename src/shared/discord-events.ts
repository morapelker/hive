import type { DiscordProvisionProgress, DiscordStatusChangedPayload } from './types/discord'

export const DISCORD_PROVISION_PROGRESS_CHANNEL = 'discord:provisionProgress'
export const DISCORD_STATUS_CHANGED_CHANNEL = 'discord:statusChanged'
// Claude CLI hook events relayed from the process that holds the hook (the
// Electron main process, where the PTY + hook server live) to the backend
// server process, where the Discord session bridge posts to channels.
export const DISCORD_CLAUDE_CLI_EVENT_CHANNEL = 'discord:claudeCliEvent'

export type DiscordProvisionProgressPayload = DiscordProvisionProgress
export type DiscordStatusChangedEventPayload = DiscordStatusChangedPayload
