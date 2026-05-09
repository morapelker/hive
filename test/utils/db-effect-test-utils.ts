import { Layer } from 'effect'

import type { DatabaseService } from '../../src/main/db/database'
import { makeDbService } from '../../src/main/effect/db/layers'
import { Db } from '../../src/main/effect/db/service'

/**
 * Build a `Layer<Db>` bound to a specific `DatabaseService` (typically a
 * temp-file instance from `createTestDatabase()`).
 */
export const makeTestDbLayer = (svc: DatabaseService): Layer.Layer<Db> =>
  Layer.succeed(Db, makeDbService(svc))
