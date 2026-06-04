import { create } from 'zustand'
import type { DiscordConfig } from '@shared/types/discord'
import { discordApi } from '@/api/discord-api'

interface DiscordStore {
  config: DiscordConfig | null
  enabled: boolean
  configured: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  lastError: string | null
  setConfig: (config: DiscordConfig | null) => void
  refresh: () => Promise<void>
}

const configuredFromConfig = (config: DiscordConfig | null): boolean =>
  !!config?.botToken.trim() && !!config.guildId.trim()

export const useDiscordStore = create<DiscordStore>((set) => ({
  config: null,
  enabled: false,
  configured: false,
  status: 'idle',
  lastError: null,

  setConfig: (config) =>
    set({
      config,
      enabled: config?.enabled === true,
      configured: configuredFromConfig(config),
      status: 'ready',
      lastError: null
    }),

  refresh: async () => {
    set({ status: 'loading' })
    try {
      const config = await discordApi.getConfig()
      useDiscordStore.getState().setConfig(config)
    } catch (error) {
      set({
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error)
      })
    }
  }
}))

if (typeof window !== 'undefined') {
  setTimeout(() => {
    useDiscordStore
      .getState()
      .refresh()
      .catch(() => {})
  }, 200)

  discordApi.onStatusChanged((status) => {
    setTimeout(() => {
      void useDiscordStore.getState().refresh()
    }, 0)
    useDiscordStore.setState({
      enabled: status.enabled,
      configured: status.configured,
      status: 'ready',
      lastError: null
    })
  })
}
