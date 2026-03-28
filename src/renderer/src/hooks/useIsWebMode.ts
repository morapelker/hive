import { useMemo } from 'react'
import { detectTransportMode } from '@/transport/detect'

export function useIsWebMode(): boolean {
  return useMemo(() => detectTransportMode() === 'web', [])
}
