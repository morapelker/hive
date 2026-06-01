import { exec } from 'node:child_process'
import { createLogger } from './logger'

const log = createLogger({ component: 'SleepNow' })

/**
 * Put the machine to sleep now.
 *
 * macOS-only (`pmset sleepnow`, no sudo needed); logged no-op on other
 * platforms. Returns true if a command was issued.
 */
export function sleepNow(): boolean {
  if (process.platform !== 'darwin') {
    log.warn('sleepNow on unsupported platform', { platform: process.platform })
    return false
  }

  exec('pmset sleepnow', (err) => {
    if (err) {
      log.error('pmset sleepnow failed', err instanceof Error ? err : new Error(String(err)))
      return
    }
    log.info('Issued pmset sleepnow')
  })

  return true
}
