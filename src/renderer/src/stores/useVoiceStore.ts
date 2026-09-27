import { create } from 'zustand'
import {
  VOICE_HISTORY_MENU_LIMIT,
  type VoiceDictationResult,
  type VoiceHistoryEntry,
  type VoiceStatus
} from '@shared/types/voice'

/** Voice dictation lives in the Electron main process; this mirrors its status for the header icon and menus. */
export function getVoiceBridge(): VoiceDesktopBridge | null {
  if (typeof window === 'undefined') return null
  return window.desktopBridge?.voice ?? null
}

export const isVoiceAvailable = (): boolean => getVoiceBridge() !== null

interface VoiceStore {
  /** Null until the first status arrives (or when running outside the desktop shell). */
  status: VoiceStatus | null
  /** Most recent transcripts for the header menu (newest first). */
  recent: VoiceHistoryEntry[]
  recentLoaded: boolean
  lastResult: VoiceDictationResult | null
  refreshStatus: () => Promise<void>
  refreshRecent: () => Promise<void>
  toggle: () => Promise<void>
  cancel: () => Promise<void>
  removeEntry: (id: string) => Promise<void>
  clearHistory: () => Promise<void>
}

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  status: null,
  recent: [],
  recentLoaded: false,
  lastResult: null,

  refreshStatus: async () => {
    const bridge = getVoiceBridge()
    if (!bridge) return
    try {
      set({ status: await bridge.getStatus() })
    } catch (error) {
      console.warn('[voice] status refresh failed', error)
    }
  },

  refreshRecent: async () => {
    const bridge = getVoiceBridge()
    if (!bridge) return
    try {
      const recent = await bridge.listHistory({ limit: VOICE_HISTORY_MENU_LIMIT })
      set({ recent, recentLoaded: true })
    } catch (error) {
      console.warn('[voice] history refresh failed', error)
    }
  },

  toggle: async () => {
    await getVoiceBridge()?.toggle()
  },

  cancel: async () => {
    await getVoiceBridge()?.cancel()
  },

  removeEntry: async (id) => {
    const bridge = getVoiceBridge()
    if (!bridge) return
    await bridge.deleteHistory(id)
    set({ recent: get().recent.filter((entry) => entry.id !== id) })
  },

  clearHistory: async () => {
    const bridge = getVoiceBridge()
    if (!bridge) return
    await bridge.clearHistory()
    set({ recent: [] })
  }
}))

if (typeof window !== 'undefined') {
  const bridge = getVoiceBridge()
  if (bridge) {
    bridge.onStatus((status) => {
      useVoiceStore.setState({ status })
    })
    bridge.onResult((result) => {
      useVoiceStore.setState((state) => ({
        lastResult: result,
        recent: [result.entry, ...state.recent.filter((e) => e.id !== result.entry.id)].slice(
          0,
          VOICE_HISTORY_MENU_LIMIT
        ),
        recentLoaded: true
      }))
    })
    setTimeout(() => {
      void useVoiceStore.getState().refreshStatus()
      void useVoiceStore.getState().refreshRecent()
    }, 250)
  }
}
