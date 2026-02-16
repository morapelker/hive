/**
 * Cross-store coordination helpers.
 *
 * These functions use a registration pattern to break the circular dependency
 * chain between useConnectionStore and useWorktreeStore, while keeping the
 * deconfliction logic synchronous (no microtask delay).
 *
 * Each store registers its "clear selection" callback after creation. The
 * counterpart store calls the registered function synchronously, so both
 * state changes (select one + clear the other) happen in the same tick.
 */

let _clearWorktreeSelection: (() => void) | null = null
let _clearConnectionSelection: (() => void) | null = null

export function registerWorktreeClear(fn: () => void): void {
  _clearWorktreeSelection = fn
}

export function registerConnectionClear(fn: () => void): void {
  _clearConnectionSelection = fn
}

export function clearWorktreeSelection(): void {
  _clearWorktreeSelection?.()
}

export function clearConnectionSelection(): void {
  _clearConnectionSelection?.()
}
