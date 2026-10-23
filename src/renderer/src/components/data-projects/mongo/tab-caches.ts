// The Mongo views keep module-level state that outlives a mounted component: results per tab
// (Documents, Aggregations, Schema), Shell runs per tab (a statement keeps running when its tab
// is switched away) and completion snapshots per project. Each registers a forgetter here, and
// the workspace store calls `forgetMongoCaches` when tabs close or a project's workspace is
// forgotten. A registry rather than imports: the views import the store, not the other way round.

export interface MongoCacheScope {
  /** Tabs that are gone (closed, or every tab of a forgotten project). */
  tabIds: readonly string[]
  /** Set when the whole project is forgotten (project-wide caches go too). */
  projectId?: string
}

type Forgetter = (scope: MongoCacheScope) => void

const forgetters = new Set<Forgetter>()

/** Registers a cache's forgetter (once, at module load); returns the unregister function. */
export function registerMongoCache(forget: Forgetter): () => void {
  forgetters.add(forget)
  return () => {
    forgetters.delete(forget)
  }
}

/** Drops what every registered cache holds for `scope`. */
export function forgetMongoCaches(scope: MongoCacheScope): void {
  if (!scope.tabIds.length && scope.projectId === undefined) return
  for (const forget of forgetters) {
    try {
      forget(scope)
    } catch {
      // A cache that fails to forget must not stop the others (or the store action).
    }
  }
}
