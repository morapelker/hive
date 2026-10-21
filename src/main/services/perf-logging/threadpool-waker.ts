/**
 * Recovery for a wedged libuv thread pool (macOS).
 *
 * The four pool workers sleep on one pthread condition variable. On macOS
 * that condvar has been seen to lose a wakeup for good: libpthread's
 * user-space counters say every waiter was already signalled while the
 * kernel still has all four blocked, so every later `pthread_cond_signal` is
 * a no-op. The pool then never runs another job — every `fs.*`, every
 * `dns.lookup` and every node-pty keystroke write queues forever — while the
 * event loop, timers and PTY output look perfectly healthy. The probe in
 * threadpool-probe.ts detects exactly that state.
 *
 * `wakeThreadpoolWorkers` (native, src/native/uv-pool-waker) interrupts the
 * workers' waits with a signal; libpthread treats that as a spurious wakeup,
 * re-syncs the condvar and the workers drain their queue. Waking a worker
 * that was not stuck is harmless. Verified live on a wedged instance: 1,287
 * queued jobs drained and the terminals took input again.
 */
import { existsSync } from 'fs'
import { join, resolve } from 'path'

export interface ThreadpoolWakeResult {
  /** Workers found by thread name ("libuv-worker"). */
  found: number
  /** Workers the wake signal was delivered to. */
  signalled: number
  /** Why nothing was signalled (no addon, not macOS, the signal is taken, ...). */
  error?: string
}

interface WakerAddon {
  wakeThreadpoolWorkers: () => ThreadpoolWakeResult
}

const ADDON_FILE = 'uv-pool-waker.node'

/**
 * Packaged: `<resources>/native/` (electron-builder extraResources). Dev:
 * the build output next to the source, from hive's own `out/main` or
 * from the shell's `apps/shell/out/main` — and one level deeper, since this
 * module may be bundled into `out/main/chunks/`.
 */
export function threadpoolWakerCandidatePaths(
  resourcesPath: string | undefined = process.resourcesPath,
  dirname: string = __dirname
): string[] {
  const devBuild = join('src', 'native', 'uv-pool-waker', 'build', ADDON_FILE)
  const devPaths = [dirname, resolve(dirname, '..')].flatMap((outMain) => [
    resolve(outMain, '..', '..', devBuild),
    resolve(outMain, '..', '..', '..', 'hive', devBuild)
  ])
  return [...(resourcesPath ? [join(resourcesPath, 'native', ADDON_FILE)] : []), ...devPaths]
}

let addon: WakerAddon | null | undefined
let loadError: string | undefined
let pathOverride: string | undefined

function loadAddon(): WakerAddon | null {
  if (addon !== undefined) return addon
  addon = null
  if (process.platform !== 'darwin') {
    loadError = 'unsupported-platform'
    return addon
  }
  const path = (pathOverride ? [pathOverride] : threadpoolWakerCandidatePaths()).find((candidate) =>
    existsSync(candidate)
  )
  if (!path) {
    loadError = 'addon-missing'
    return addon
  }
  try {
    const module = { exports: {} as Partial<WakerAddon> }
    process.dlopen(module, path)
    if (typeof module.exports.wakeThreadpoolWorkers === 'function') {
      addon = module.exports as WakerAddon
    } else {
      loadError = 'addon-invalid'
    }
  } catch (error) {
    loadError = `addon-load-failed: ${error instanceof Error ? error.message : String(error)}`
  }
  return addon
}

/** Signal every libuv pool worker of this process awake. Never throws. */
export function wakeThreadpoolWorkers(): ThreadpoolWakeResult {
  const waker = loadAddon()
  if (!waker) return { found: 0, signalled: 0, error: loadError }
  try {
    return waker.wakeThreadpoolWorkers()
  } catch (error) {
    return { found: 0, signalled: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Whether the stall handler should wake the pool at this miss count: on the
 * first stalled ticks, then every tenth — each attempt is cheap and harmless,
 * and a pool that wedges again mid-episode gets another chance.
 */
export function shouldWakeAtMiss(consecutiveMisses: number, stallAfter: number): boolean {
  if (consecutiveMisses < stallAfter) return false
  const sinceStall = consecutiveMisses - stallAfter
  return sinceStall < 3 || sinceStall % 10 === 0
}

/** Tests: forget the loaded addon; `path` loads it from there instead of the candidates. */
export function __resetThreadpoolWakerForTests(path?: string): void {
  addon = undefined
  loadError = undefined
  pathOverride = path
}
