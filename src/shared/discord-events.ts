import type { DiscordProvisionProgress, DiscordStatusChangedPayload } from './types/discord'

export const DISCORD_PROVISION_PROGRESS_CHANNEL = 'discord:provisionProgress'
export const DISCORD_STATUS_CHANGED_CHANNEL = 'discord:statusChanged'

export type DiscordProvisionProgressPayload = DiscordProvisionProgress
export type DiscordStatusChangedEventPayload = DiscordStatusChangedPayload
