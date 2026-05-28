import { useId, type ReactNode } from 'react'
import { useGhosttySuppression } from '@/hooks/useGhosttySuppression'

interface GhosttySuppressionBoundaryProps {
  scope: string
  active?: boolean
  children: ReactNode
}

export function GhosttySuppressionBoundary({
  scope,
  active = true,
  children
}: GhosttySuppressionBoundaryProps): React.JSX.Element {
  const id = useId()
  useGhosttySuppression(`${scope}:${id}`, active)
  return <>{children}</>
}
