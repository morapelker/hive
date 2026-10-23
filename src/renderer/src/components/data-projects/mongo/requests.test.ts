// Request shaping: find pages on top of the bar's skip/limit, "x–y of N", lossless `_id`
// filters and the optimistic-concurrency filter of an edit, Clone text, the Schema → filter
// insertion, createIndex options and createCollection options, name validation, and shell text
// that the Shell's own parser accepts (bare index-name hints, fragments ending with a comment).
import { describe, expect, it } from 'vitest'
import { parseMongoShell } from '@shared/data-projects/mongo-shell'
import {
  EMPTY_COLLECTION_FORM,
  EMPTY_INDEX_FORM,
  EMPTY_QUERY,
  aggregateShellText,
  appendFilterField,
  buildCollectionOptionsText,
  buildCreateIndexRequest,
  buildFindRequest,
  buildIndexOptionsText,
  cloneDocumentText,
  collectionAccessor,
  concurrencyFilterText,
  CONCURRENCY_FILTER_MAX,
  findShellText,
  hintShellText,
  idFilterText,
  pageInfo,
  parseQueryNumbers,
  validateCollectionName,
  validateDatabaseName
} from './requests'

const base = { dataProjectId: 'dp', database: 'shop', collection: 'orders', queryId: 'q' }

describe('buildFindRequest', () => {
  it('sends only what is set, with a count for "x–y of N"', () => {
    const result = buildFindRequest(base, { ...EMPTY_QUERY, filter: " { status: 'A' } " }, 0, 20)
    expect(result).toEqual({
      ok: true,
      numbers: { skip: 0, limit: null, maxTimeMS: undefined },
      request: { ...base, filter: "{ status: 'A' }", limit: 20, withCount: true }
    })
  })

  it('pages on top of the bar skip and stops at the bar limit', () => {
    const query = { ...EMPTY_QUERY, skip: '5', limit: '45', sort: '{ at: -1 }', maxTimeMS: '1000' }
    const page2 = buildFindRequest(base, query, 2, 20)
    expect(page2).toMatchObject({
      ok: true,
      request: { skip: 45, limit: 5, sort: '{ at: -1 }', maxTimeMS: 1000 }
    })
    expect(buildFindRequest(base, query, 3, 20)).toEqual({
      ok: false,
      error: 'This page is past the query limit'
    })
    expect(buildFindRequest(base, { ...EMPTY_QUERY, skip: 'ten' }, 0, 20)).toEqual({
      ok: false,
      error: 'Skip must be a whole number ≥ 0'
    })
  })
})

describe('pageInfo', () => {
  const numbers = parseQueryNumbers(EMPTY_QUERY)
  if (!numbers.ok) throw new Error('numbers')

  it('labels pages with the exact total when the count is known', () => {
    expect(
      pageInfo({
        page: 0,
        pageSize: 20,
        shown: 20,
        truncated: true,
        count: 1284,
        numbers: numbers.value
      })
    ).toMatchObject({
      label: '1–20 of 1,284',
      hasPrev: false,
      hasNext: true
    })
    expect(
      pageInfo({
        page: 64,
        pageSize: 20,
        shown: 4,
        truncated: false,
        count: 1284,
        numbers: numbers.value
      })
    ).toMatchObject({
      label: '1,281–1,284 of 1,284',
      hasNext: false,
      hasPrev: true
    })
  })

  it('falls back to "of many" without a count and applies the bar skip/limit to the total', () => {
    expect(
      pageInfo({
        page: 1,
        pageSize: 20,
        shown: 20,
        truncated: true,
        count: null,
        numbers: numbers.value
      })
    ).toMatchObject({
      label: '21–40 of many',
      hasNext: true
    })
    expect(
      pageInfo({
        page: 0,
        pageSize: 20,
        shown: 20,
        truncated: true,
        count: 100,
        numbers: { skip: 10, limit: 30, maxTimeMS: undefined }
      })
    ).toMatchObject({ total: 30, label: '1–20 of 30', hasNext: true })
    expect(
      pageInfo({
        page: 0,
        pageSize: 20,
        shown: 0,
        truncated: false,
        count: 0,
        numbers: numbers.value
      }).label
    ).toBe('No documents')
  })
})

describe('shell text', () => {
  it('uses db.name when safe and getCollection otherwise', () => {
    expect(collectionAccessor('orders')).toBe('db.orders')
    expect(collectionAccessor('order-items')).toBe("db.getCollection('order-items')")
    expect(collectionAccessor('stats')).toBe("db.getCollection('stats')")
  })

  it('describes the query bar as one statement', () => {
    expect(findShellText('orders', EMPTY_QUERY)).toBe('db.orders.find()')
    expect(
      findShellText('orders', {
        ...EMPTY_QUERY,
        filter: "{ status: 'A' }",
        project: '{ total: 1 }',
        sort: '{ at: -1 }',
        limit: '10'
      })
    ).toBe("db.orders.find({ status: 'A' }, { total: 1 }).sort({ at: -1 }).limit(10)")
    expect(aggregateShellText('orders', '[]')).toBe('db.orders.aggregate([])')
  })
})

describe('documents', () => {
  const doc = {
    _id: { $oid: '5f0c4a5b8e4b3b0b8c8e4b3b' },
    n: { $numberDouble: '1.0' },
    at: { $date: { $numberLong: '0' } }
  }

  it('builds a lossless _id filter', () => {
    expect(idFilterText(doc)).toBe("{ _id: ObjectId('5f0c4a5b8e4b3b0b8c8e4b3b') }")
    expect(idFilterText({ _id: { $numberLong: '7' } })).toBe("{ _id: NumberLong('7') }")
    expect(idFilterText({ a: 1 })).toBeNull()
  })

  it('clones without _id, keeping types', () => {
    expect(cloneDocumentText(doc)).toBe("{ n: Double(1), at: ISODate('1970-01-01T00:00:00.000Z') }")
  })

  it('appends a schema field to the filter and places the cursor after the colon', () => {
    const empty = appendFilterField('', 'address.city')
    expect(empty.text).toBe("{ 'address.city':  }")
    expect(empty.text.slice(0, empty.cursor)).toBe("{ 'address.city': ")
    const more = appendFilterField("{ status: 'A' }", 'total')
    expect(more.text).toBe("{ status: 'A', total:  }")
    expect(more.text.slice(0, more.cursor)).toBe("{ status: 'A', total: ")
    expect(appendFilterField('{}', 'a').text).toBe('{ a:  }')
  })
})

describe('createIndex', () => {
  it('builds the options document from the form', () => {
    expect(buildIndexOptionsText(EMPTY_INDEX_FORM)).toEqual({ ok: true, text: undefined })
    expect(
      buildIndexOptionsText({
        ...EMPTY_INDEX_FORM,
        name: "by 'status'",
        unique: true,
        hidden: true,
        ttlSeconds: '3600',
        partialFilter: "{ status: 'A' }"
      })
    ).toEqual({
      ok: true,
      text: "{ name: 'by \\'status\\'', unique: true, hidden: true, expireAfterSeconds: 3600, partialFilterExpression: { status: 'A' } }"
    })
    expect(buildIndexOptionsText({ ...EMPTY_INDEX_FORM, ttlSeconds: '-1' })).toMatchObject({
      ok: false
    })
    expect(
      buildIndexOptionsText({ ...EMPTY_INDEX_FORM, sparse: true, partialFilter: '{ a: 1 }' })
    ).toMatchObject({
      ok: false
    })
  })

  it('shapes the request and rejects empty keys', () => {
    expect(
      buildCreateIndexRequest(
        { dataProjectId: 'dp', database: 'shop', collection: 'orders' },
        { ...EMPTY_INDEX_FORM, keys: ' { createdAt: -1 } ', sparse: true }
      )
    ).toEqual({
      ok: true,
      request: {
        dataProjectId: 'dp',
        database: 'shop',
        collection: 'orders',
        keys: '{ createdAt: -1 }',
        options: '{ sparse: true }'
      }
    })
    expect(
      buildCreateIndexRequest(
        { dataProjectId: 'dp', database: 'shop', collection: 'orders' },
        { ...EMPTY_INDEX_FORM, keys: '{}' }
      )
    ).toMatchObject({ ok: false })
  })
})

describe('createCollection', () => {
  it('builds capped, time-series, clustered and collation options', () => {
    expect(buildCollectionOptionsText({ ...EMPTY_COLLECTION_FORM, name: 'x' })).toEqual({
      ok: true,
      text: undefined
    })
    expect(
      buildCollectionOptionsText({
        ...EMPTY_COLLECTION_FORM,
        kind: 'capped',
        cappedSize: '1048576',
        cappedMax: '1000'
      })
    ).toEqual({ ok: true, text: '{ capped: true, size: 1048576, max: 1000 }' })
    expect(buildCollectionOptionsText({ ...EMPTY_COLLECTION_FORM, kind: 'capped' })).toMatchObject({
      ok: false
    })
    expect(
      buildCollectionOptionsText({
        ...EMPTY_COLLECTION_FORM,
        kind: 'timeseries',
        timeField: 'ts',
        metaField: 'sensor',
        granularity: 'minutes',
        expireAfterSeconds: '86400',
        collationLocale: 'en'
      })
    ).toEqual({
      ok: true,
      text: "{ timeseries: { timeField: 'ts', metaField: 'sensor', granularity: 'minutes' }, expireAfterSeconds: 86400, collation: { locale: 'en' } }"
    })
    expect(buildCollectionOptionsText({ ...EMPTY_COLLECTION_FORM, kind: 'clustered' })).toEqual({
      ok: true,
      text: '{ clusteredIndex: { key: { _id: 1 }, unique: true } }'
    })
    expect(
      buildCollectionOptionsText({
        ...EMPTY_COLLECTION_FORM,
        kind: 'capped',
        advanced: '{ capped: true, size: 1 }'
      })
    ).toEqual({ ok: true, text: '{ capped: true, size: 1 }' })
  })

  it('validates names before the round trip', () => {
    expect(validateCollectionName('orders')).toBeNull()
    expect(validateCollectionName('')).not.toBeNull()
    expect(validateCollectionName('a$b')).not.toBeNull()
    expect(validateCollectionName('system.x')).not.toBeNull()
    expect(validateDatabaseName('shop')).toBeNull()
    expect(validateDatabaseName('my db')).not.toBeNull()
    expect(validateDatabaseName('a.b')).not.toBeNull()
  })
})

describe('shell text the Shell can run', () => {
  const ok = (text: string): boolean => parseMongoShell(text).ok

  it('quotes a bare index-name hint like the server does', () => {
    const text = findShellText('orders', { ...EMPTY_QUERY, hint: 'status_1' })
    expect(text).toBe("db.orders.find().hint('status_1')")
    expect(ok(text)).toBe(true)
    expect(hintShellText("'status_1'")).toBe("'status_1'")
    expect(hintShellText('{ status: 1 }')).toBe('{ status: 1 }')
    expect(hintShellText('$natural')).toBe("'$natural'")
  })

  it('ends the line after a fragment that ends with a // comment', () => {
    const text = findShellText('orders', {
      ...EMPTY_QUERY,
      filter: "{ status: 'A' } // only A",
      project: '{ total: 1 } // money',
      sort: '{ at: -1 } // newest',
      collation: "{ locale: 'en' } // en"
    })
    expect(ok(text)).toBe(true)
    expect(text).toContain("{ status: 'A' } // only A\n, { total: 1 } // money\n)")
    expect(ok(aggregateShellText('orders', '[{ $limit: 1 }] // one'))).toBe(true)
    // No comment: unchanged one-liners.
    expect(findShellText('orders', { ...EMPTY_QUERY, filter: '{ a: 1 }' })).toBe(
      'db.orders.find({ a: 1 })'
    )
  })
})

describe('concurrencyFilterText', () => {
  const OID = '66f0a0a0a0a0a0a0a0a0a0a1'

  it('matches the loaded version: every field, objects/arrays/regexes by $eq, the field count', () => {
    const doc = {
      _id: { $oid: OID },
      status: 'A',
      total: { $numberDouble: '10.0' },
      n: 7,
      tags: ['x', 'y'],
      address: { city: 'TLV', $note: 'kept' },
      pattern: { $regularExpression: { pattern: '^a', options: 'i' } },
      none: null
    }
    const text = concurrencyFilterText(doc)!
    expect(text).toBe(
      `{ _id: ObjectId('${OID}'), status: 'A', total: Double(10), n: 7, ` +
        "tags: { $eq: [ 'x', 'y' ] }, address: { $eq: { city: 'TLV', $note: 'kept' } }, " +
        'pattern: { $eq: /^a/i }, none: null, ' +
        "$expr: { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, 8] } }"
    )
    expect(parseMongoShell(`db.orders.replaceOne(${text}, {})`).ok).toBe(true)
  })

  it('leaves fields a filter cannot address exactly to the field count', () => {
    const text = concurrencyFilterText({
      _id: 1,
      'a.b': 1,
      $weird: 2,
      byIndex: { '10': 'x', '2': 'y' },
      ok: true
    })!
    expect(text).toBe(
      "{ _id: 1, ok: true, $expr: { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, 5] } }"
    )
  })

  it('falls back to _id + field count for huge documents, and needs an _id', () => {
    const text = concurrencyFilterText({ _id: 1, blob: 'x'.repeat(CONCURRENCY_FILTER_MAX) })!
    expect(text).toBe("{ _id: 1, $expr: { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, 2] } }")
    expect(concurrencyFilterText({ a: 1 })).toBeNull()
  })
})
