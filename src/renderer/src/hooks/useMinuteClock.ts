import { useEffect, useState } from 'react'

const TICK_MS = 30_000

/**
 * The current time in ms, refreshed twice a minute: what a relative-time label ("5m") needs to
 * move on while nothing else re-renders it.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}
