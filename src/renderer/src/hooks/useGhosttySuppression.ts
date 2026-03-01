import { useEffect } from 'react'
import { useLayoutStore } from '@/stores/useLayoutStore'

export function useGhosttySuppression(key: string, active: boolean): void {
  const push = useLayoutStore((s) => s.pushGhosttySuppression)
  const pop = useLayoutStore((s) => s.popGhosttySuppression)

  useEffect(() => {
    if (active) {
      push(key)
    } else {
      pop(key)
    }
    return () => {
      pop(key)
    }
  }, [key, active, push, pop])
}
