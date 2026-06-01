import { createLogger } from './logger'
import { scriptRunner } from './script-runner'

const log = createLogger({ component: 'ScriptCleanup' })

export function cleanupScripts(): void {
  log.info('Cleaning up script runner')
  scriptRunner.killAll()
}
