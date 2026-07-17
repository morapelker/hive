/**
 * Per-account async mutex, shared across every code path that reads or rotates
 * a single account's OAuth credentials.
 *
 * Several callers can race to refresh/rotate the SAME account's token
 * concurrently: the 60s watcher, the boot/RPC mass refresh, a user-initiated
 * live fetch, and an account switch. Refresh tokens are single-use and rotate
 * on every refresh, so an overlapping second refresh would consume an
 * already-rotated token and fail with invalid_grant even though the account
 * has healthy, freshly-rotated credentials from the first refresh.
 *
 * Lives in its own module (rather than inside saved-usage-orchestrator.ts) so
 * that the orchestrator's saved-account path AND usage-ops.ts's live path share
 * ONE lock map keyed by `provider:email` — a left-click live fetch and a mass
 * refresh/watcher tick for the same account then serialize instead of double-
 * consuming the same single-use refresh token. Keeping it here also avoids an
 * import cycle (usage-ops already imports from the orchestrator, but the
 * orchestrator must not import from usage-ops).
 */
const accountLockTails = new Map<string, Promise<unknown>>()

export function accountLockKey(provider: string, email: string): string {
  return `${provider}:${email.toLowerCase()}`
}

/**
 * Chain `fn` onto the tail promise for `key`, cleaning up the map entry once
 * the chain drains so it never grows unbounded.
 */
export function withAccountLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = accountLockTails.get(key) ?? Promise.resolve()
  const result = prior.then(fn, fn)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  accountLockTails.set(key, tail)
  void tail.finally(() => {
    if (accountLockTails.get(key) === tail) accountLockTails.delete(key)
  })
  return result
}

/**
 * Acquire several account locks at once (e.g. a switch touches both the
 * outgoing-live and target accounts). Deduplicates and acquires in SORTED key
 * order so two multi-lock callers can never deadlock by grabbing the same pair
 * in opposite orders.
 */
export function withAccountLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort()
  const run = ordered.reduceRight<() => Promise<T>>(
    (next, key) => () => withAccountLock(key, next),
    fn
  )
  return run()
}
