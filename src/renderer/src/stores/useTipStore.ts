import { create } from 'zustand'
import { TIP_DEFINITIONS } from '@/lib/tip-definitions'
import { useSettingsStore } from '@/stores/useSettingsStore'

const SEEN_TIPS_DB_KEY = 'seen_tips'
const SHOW_DELAY_MS = 500
const QUEUE_DELAY_MS = 500

interface TipState {
  // Persisted (loaded from DB)
  seenTipIds: string[]

  // Runtime
  activeTipId: string | null
  queue: string[]

  // Internal — tracks pending timers so they can be cancelled
  _showTimer: ReturnType<typeof setTimeout> | null

  // Actions
  loadSeenTips: () => Promise<void>
  requestTip: (tipId: string) => void
  dismissTip: (tipId: string) => void
  disableAllTips: () => void
  isTipSeen: (tipId: string) => boolean
}

async function persistSeenTips(seenTipIds: string[]): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(SEEN_TIPS_DB_KEY, JSON.stringify(seenTipIds))
    }
  } catch (error) {
    console.error('Failed to persist seen tips:', error)
  }
}

export const useTipStore = create<TipState>()((set, get) => ({
  seenTipIds: [],
  activeTipId: null,
  queue: [],
  _showTimer: null,

  loadSeenTips: async () => {
    try {
      if (typeof window !== 'undefined' && window.db?.setting) {
        const value = await window.db.setting.get(SEEN_TIPS_DB_KEY)
        if (value) {
          const parsed = JSON.parse(value)
          if (Array.isArray(parsed)) {
            set({ seenTipIds: parsed })
          }
        }
      }
    } catch (error) {
      console.error('Failed to load seen tips:', error)
    }
  },

  requestTip: (tipId: string) => {
    const { seenTipIds, activeTipId, queue } = get()

    // Skip if tips are globally disabled
    if (!useSettingsStore.getState().tipsEnabled) return

    // Skip if already seen or already queued/active
    if (seenTipIds.includes(tipId)) return
    if (activeTipId === tipId) return
    if (queue.includes(tipId)) return

    if (!activeTipId) {
      // No active tip — show after delay
      const timer = setTimeout(() => {
        set({ activeTipId: tipId, _showTimer: null })
      }, SHOW_DELAY_MS)
      set({ _showTimer: timer })
    } else {
      // Another tip is active — add to queue sorted by priority
      const newQueue = [...queue, tipId].sort((a, b) => {
        const aDef = TIP_DEFINITIONS[a]
        const bDef = TIP_DEFINITIONS[b]
        return (aDef?.priority ?? 999) - (bDef?.priority ?? 999)
      })
      set({ queue: newQueue })
    }
  },

  dismissTip: (tipId: string) => {
    const { seenTipIds, queue, _showTimer } = get()

    // Cancel any pending show timer
    if (_showTimer) {
      clearTimeout(_showTimer)
    }

    // Mark as seen
    const newSeenTipIds = [...seenTipIds, tipId]
    set({
      seenTipIds: newSeenTipIds,
      activeTipId: null,
      _showTimer: null
    })

    // Persist to DB
    persistSeenTips(newSeenTipIds)

    // Show next queued tip after delay (skip any that are now seen)
    const remaining = queue.filter((id) => !newSeenTipIds.includes(id))
    if (remaining.length > 0) {
      const nextTipId = remaining[0]
      const newQueue = remaining.slice(1)
      set({ queue: newQueue })

      const timer = setTimeout(() => {
        set({ activeTipId: nextTipId, _showTimer: null })
      }, QUEUE_DELAY_MS)
      set({ _showTimer: timer })
    } else {
      set({ queue: [] })
    }
  },

  disableAllTips: () => {
    const { _showTimer } = get()

    // Cancel any pending show timer
    if (_showTimer) {
      clearTimeout(_showTimer)
    }

    // Clear all runtime state
    set({
      activeTipId: null,
      queue: [],
      _showTimer: null
    })

    // Disable tips globally via settings
    useSettingsStore.getState().updateSetting('tipsEnabled', false)
  },

  isTipSeen: (tipId: string) => {
    return get().seenTipIds.includes(tipId)
  }
}))
