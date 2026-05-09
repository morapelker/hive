import type { ManagedRuntime } from 'effect'

/**
 * Shared registry of per-island Effect runtimes. Each island calls
 * `getOrCreateRuntime(name, factory)` from its own `runtime.ts` and the
 * registry owns the singleton storage. Replaces per-island module-scoped
 * `let runtime: ... | null` patterns.
 *
 * The whole main process can be torn down by a single `disposeAllRuntimes()`
 * call during `app.on('will-quit')`.
 */
type AnyRuntime = ManagedRuntime.ManagedRuntime<never, never>

const runtimes = new Map<string, AnyRuntime>()

/**
 * Returns the runtime registered under `name`, creating it via `factory` on
 * first access. The returned reference is stable for the process lifetime
 * (until `disposeRuntime(name)` or `disposeAllRuntimes()` is called).
 */
export const getOrCreateRuntime = <R, E>(
  name: string,
  factory: () => ManagedRuntime.ManagedRuntime<R, E>
): ManagedRuntime.ManagedRuntime<R, E> => {
  const existing = runtimes.get(name)
  if (existing) return existing as unknown as ManagedRuntime.ManagedRuntime<R, E>

  const created = factory()
  runtimes.set(name, created as unknown as AnyRuntime)
  return created
}

/**
 * Dispose a single island's runtime. Safe to call when the island has never
 * been initialized (no-op).
 */
export const disposeRuntime = async (name: string): Promise<void> => {
  const rt = runtimes.get(name)
  runtimes.delete(name)
  if (rt) await rt.dispose()
}

/**
 * Dispose every registered runtime. Called once during app shutdown.
 * Uses Promise.allSettled so a slow/broken island can't block the others.
 */
export const disposeAllRuntimes = async (): Promise<void> => {
  const all = Array.from(runtimes.values())
  runtimes.clear()
  await Promise.allSettled(all.map((rt) => rt.dispose()))
}

/** Test-only: drop the registry without disposing. Avoid in production code. */
export const __resetRuntimeRegistryForTests = (): void => {
  runtimes.clear()
}
