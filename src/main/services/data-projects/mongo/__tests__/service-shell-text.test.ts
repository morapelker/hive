// The shell text MongoEngineService records in history and shows in confirm dialogs must stay
// valid shell when a user-typed fragment ends in a `// comment` (hermetic: fake driver, no DB).
import { describe, expect, it } from 'vitest'
import type { DataHistoryEntry } from '../../../../../shared/data-projects/types'
import { parseMongoShell } from '../../../../../shared/data-projects/mongo-shell'
import {
  DataDriverError,
  type DataProjectRecord,
  type SafetyEvaluationInput
} from '../../contracts'
import type { MongoDriver } from '../driver'
import { createMongoEngineService } from '../service'

const record: DataProjectRecord = {
  id: 'p1',
  name: 'mongo',
  engine: 'mongodb',
  config: { database: 'shop' },
  icon: null,
  iconColor: null,
  environment: 'local',
  color: null,
  safeMode: 'half-safe',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretCiphertext: null,
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: '2026-01-01T00:00:00.000Z'
}

/** A driver whose every operation fails: find still records its history text. */
const offlineDriver = {
  readTimeoutMs: 1000,
  startOperation: async () => ({
    tag: 'op',
    session: undefined,
    signal: new AbortController().signal,
    cancelled: false,
    cancel: async () => undefined,
    end: async () => undefined
  }),
  getClient: async () => {
    throw new Error('offline')
  },
  toError: (error: unknown) =>
    error instanceof DataDriverError ? error : new DataDriverError(String(error))
} as unknown as MongoDriver

function setup() {
  const history: Array<Omit<DataHistoryEntry, 'id'>> = []
  const confirmed: string[] = []
  const service = createMongoEngineService({
    getRecord: () => record,
    getDriver: async () => offlineDriver,
    evaluateSafety: (input: SafetyEvaluationInput) => {
      confirmed.push(input.statements[0].text)
      return {
        action: 'confirm',
        plan: { statements: [], mode: 'half-safe' } as never,
        confirmToken: 'token'
      }
    },
    registerQuery: () => () => undefined,
    recordHistory: (entry) => history.push(entry)
  })
  return { service, history, confirmed }
}

const expectValidShell = (text: string): void => {
  const parsed = parseMongoShell(text)
  expect(parsed.ok ? null : parsed.error.message, text).toBeNull()
}

describe('Mongo service shell text after a fragment ending in // comment', () => {
  it('keeps the find history text runnable', async () => {
    const { service, history } = setup()
    await expect(
      service.find(
        {
          dataProjectId: 'p1',
          queryId: 'q1',
          database: 'shop',
          collection: 'orders',
          filter: "{ status: 'A' } // only A",
          projection: '{ total: 1 } // money',
          sort: '{ total: -1 } // biggest',
          collation: "{ locale: 'en' } // en",
          hint: '{ status: 1 } // index',
          limit: 20
        },
        { clientId: null }
      )
    ).rejects.toThrow(/offline/)
    const text = history.at(-1)?.text ?? ''
    expect(text).toContain('// only A\n, { total: 1 } // money\n)')
    expect(text).toMatch(/\.limit\(20\)$/)
    expectValidShell(text)
  })

  it('keeps the confirm text of writes, $out aggregates and index/collection changes runnable', async () => {
    const { service, confirmed } = setup()
    const ctx = { clientId: null }
    const base = { dataProjectId: 'p1', database: 'shop', collection: 'orders' }
    await service.write(
      {
        ...base,
        op: 'updateMany',
        filter: "{ status: 'A' } // stale",
        update: "{ $set: { status: 'B' } } // archive",
        upsert: true,
        collation: "{ locale: 'en' } // en"
      },
      ctx
    )
    await service.write({ ...base, op: 'deleteMany', filter: '{ total: 0 } // empty' }, ctx)
    await service.write(
      { ...base, op: 'replaceOne', filter: '{ _id: 1 } // one', document: '{ a: 1 } // doc' },
      ctx
    )
    await service.write({ ...base, op: 'insertOne', document: '{ a: 1 } // new' }, ctx)
    await service.aggregate(
      {
        ...base,
        queryId: 'q2',
        pipeline: "[{ $match: {} }, { $out: 'copy' }] // copy",
        limit: 20
      },
      ctx
    )
    await service.createIndex({ ...base, keys: '{ a: 1 } // a', options: '{ unique: true } // u' })
    await service.collection({
      dataProjectId: 'p1',
      database: 'shop',
      action: { kind: 'create', collection: 'logs', options: '{ capped: false } // plain' }
    })
    expect(confirmed).toHaveLength(7)
    for (const text of confirmed) expectValidShell(text)
    expect(confirmed[0]).toContain("// stale\n, { $set: { status: 'B' } } // archive\n, {")
    expect(confirmed[0]).toContain("collation: { locale: 'en' } // en\n }")
  })

  it('leaves fragments without a trailing line comment as they are', async () => {
    const { service, history, confirmed } = setup()
    await service
      .find(
        {
          dataProjectId: 'p1',
          queryId: 'q3',
          database: 'shop',
          collection: 'orders',
          // `//` inside a string or a regex is not a comment.
          filter: '{ url: "http://x/y", re: /a\\/\\// }',
          limit: 5
        },
        { clientId: null }
      )
      .catch(() => undefined)
    expect(history.at(-1)?.text).toBe(
      'db.getCollection("orders").find({ url: "http://x/y", re: /a\\/\\// }).limit(5)'
    )
    await service.write(
      {
        dataProjectId: 'p1',
        database: 'shop',
        collection: 'orders',
        op: 'deleteMany',
        filter: '{ a: 1 /* note */ }'
      },
      { clientId: null }
    )
    expect(confirmed.at(-1)).toBe('db.getCollection("orders").deleteMany({ a: 1 /* note */ })')
  })
})
