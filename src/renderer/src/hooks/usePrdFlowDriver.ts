import { useEffect } from 'react'
import { PrdFlowDriver } from '@/lib/prd-flow/driver'
import { createLivePrdFlowPorts } from '@/lib/prd-flow/live-ports'

/**
 * Mount-once (AppLayout): drives every PRD flow of this window ("New PRD → orchestrator
 * ticket…") from its first prompt to the orchestrator ticket. Each mount gets a driver and
 * ports of its own and stops them on unmount, so mounting twice in a row leaves one driver at work.
 */
export function usePrdFlowDriver(): void {
  useEffect(() => {
    const driver = new PrdFlowDriver(createLivePrdFlowPorts())
    driver.start()
    return () => driver.stop()
  }, [])
}
