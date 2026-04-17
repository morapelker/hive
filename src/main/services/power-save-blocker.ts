import { powerSaveBlocker } from 'electron'
import { createLogger } from './logger'

const log = createLogger({ component: 'PowerSaveBlocker' })

/**
 * Wraps Electron's `powerSaveBlocker` API with idempotent state management.
 *
 * The blocker uses the `prevent-display-sleep` mode, which keeps the display
 * awake and (on macOS) prevents lid-close-triggered sleep. A single
 * module-level blocker id is tracked so repeated calls with the same desired
 * state are no-ops.
 */

let currentBlockerId: number | null = null

/**
 * Idempotently set whether the system should stay awake.
 *
 * - `active === true`: starts a `prevent-display-sleep` blocker if none is held.
 * - `active === false`: stops the held blocker if any.
 * - Already in desired state: no-op.
 */
export function setKeepAwake(active: boolean): void {
  if (active) {
    if (currentBlockerId !== null) return
    try {
      const id = powerSaveBlocker.start('prevent-display-sleep')
      currentBlockerId = id
      log.info('Started power save blocker', { id })
    } catch (err) {
      log.error(
        'Failed to start power save blocker',
        err instanceof Error ? err : new Error(String(err))
      )
    }
  } else {
    if (currentBlockerId === null) return
    const id = currentBlockerId
    try {
      powerSaveBlocker.stop(id)
      log.info('Stopped power save blocker', { id })
    } catch (err) {
      log.error(
        'Failed to stop power save blocker',
        err instanceof Error ? err : new Error(String(err)),
        { id }
      )
    } finally {
      currentBlockerId = null
    }
  }
}

/** Returns whether a power save blocker is currently held (diagnostics). */
export function isKeepAwakeActive(): boolean {
  return currentBlockerId !== null
}

/** Release any active blocker. Safe to call when none is held. */
export function cleanupPowerSaveBlocker(): void {
  setKeepAwake(false)
}
