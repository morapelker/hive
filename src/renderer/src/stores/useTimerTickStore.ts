import { create } from 'zustand'

interface TimerTickState {
  tickMs: number
}

export const useTimerTickStore = create<TimerTickState>(() => ({
  tickMs: Date.now()
}))

// Single global 1-second tick — negligible cost (one Date.now + one setState/sec)
setInterval(() => {
  useTimerTickStore.setState({ tickMs: Date.now() })
}, 1000)
