// The Mongo completion source as pure functions: the site analysis for every context the
// Shell tab and the query editors complete in (db. / db.coll. / cursor modifiers / use / show
// / filter keys and operators / pipeline stages and stage bodies / update operators / $field
// references / getCollection('…')), and the options each site produces from the schema.
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import {
  analyzeMongoCompletion,
  mongoCompletionItems,
  shouldOfferWhileTyping,
  stageOperatorOptions,
  type MongoCompletionData,
  type MongoCompletionSite
} from './mongo-completion'
import { createMongoCompletionSource } from './mongo-completion-source'

const data: MongoCompletionData = {
  databases: ['shop', 'admin'],
  collections: ['orders', 'users', 'order-items', 'system.views'],
  fields: (collection) =>
    collection === 'users'
      ? [{ path: 'email', type: 'String' }]
      : [
          { path: '_id', type: 'ObjectId' },
          { path: 'status', type: 'String' },
          { path: 'items.productId', type: 'ObjectId' }
        ],
  serverVersion: '8.0.0'
}

const site = (text: string): MongoCompletionSite => {
  const result = analyzeMongoCompletion(text)
  if (result.kind === 'none') throw new Error(`no site for ${text}`)
  return result
}
const labels = (text: string): string[] =>
  mongoCompletionItems(site(text), data).map((i) => i.label)

describe('analyzeMongoCompletion: member chains', () => {
  it('db. → collections and database methods', () => {
    expect(site('db.')).toMatchObject({ kind: 'db-member', prefix: '', from: 3 })
    expect(site('db.or')).toMatchObject({ kind: 'db-member', prefix: 'or', from: 3 })
    const items = mongoCompletionItems(site('db.'), data)
    expect(items.map((i) => i.label)).toEqual(
      expect.arrayContaining(['orders', 'getCollection', 'runCommand'])
    )
    // Not an identifier → inserted as getCollection('…').
    expect(items.find((i) => i.label === 'order-items')?.apply).toBe("getCollection('order-items')")
  })

  it('db.coll. → collection methods (also via getCollection and db[...])', () => {
    expect(site('db.orders.')).toMatchObject({ kind: 'collection-member', collection: 'orders' })
    expect(site("db.getCollection('order-items').fi")).toMatchObject({
      kind: 'collection-member',
      collection: 'order-items',
      prefix: 'fi'
    })
    expect(site("db['orders'].")).toMatchObject({ kind: 'collection-member', collection: 'orders' })
    expect(site("db.getSiblingDB('admin').system.")).toMatchObject({
      kind: 'collection-member',
      collection: 'system',
      database: 'admin'
    })
    expect(labels('db.orders.')).toEqual(
      expect.arrayContaining(['find', 'aggregate', 'deleteMany', 'explain'])
    )
    expect(labels('db.system.')).toContain('views')
  })

  it('…find(…). → cursor methods for that method only', () => {
    expect(site('db.orders.find({ a: 1 }).')).toMatchObject({
      kind: 'cursor-member',
      method: 'find'
    })
    expect(site('db.orders.find({})\n  .sort({ a: 1 })\n  .li')).toMatchObject({
      kind: 'cursor-member',
      method: 'find',
      prefix: 'li'
    })
    const findMods = labels('db.orders.find().')
    expect(findMods).toEqual(
      expect.arrayContaining(['sort', 'limit', 'skip', 'explain', 'toArray'])
    )
    const aggMods = labels('db.orders.aggregate([]).')
    expect(aggMods).toContain('explain')
    expect(aggMods).not.toContain('sort')
  })

  it('db.coll.explain(). → explainable methods', () => {
    expect(site("db.orders.explain('executionStats').")).toMatchObject({ kind: 'explain-member' })
    expect(labels('db.orders.explain().')).toEqual(['find', 'aggregate', 'count', 'distinct'])
  })

  it('statement start, use and show', () => {
    expect(site('d')).toMatchObject({ kind: 'statement', prefix: 'd' })
    expect(site('db.orders.find()\nd')).toMatchObject({ kind: 'statement' })
    expect(site('db.a.find(); d')).toMatchObject({ kind: 'statement' })
    expect(analyzeMongoCompletion('db.a.find() d').kind).toBe('none')
    expect(site('use sh')).toMatchObject({ kind: 'use', prefix: 'sh', from: 4 })
    expect(labels('use ')).toEqual(['shop', 'admin'])
    expect(site('show c')).toMatchObject({ kind: 'show' })
    expect(labels('show ')).toEqual(expect.arrayContaining(['dbs', 'collections']))
  })

  it('offers nothing inside comments, numbers, regexes or helper calls', () => {
    expect(analyzeMongoCompletion('// db.').kind).toBe('none')
    expect(analyzeMongoCompletion('/* db.').kind).toBe('none')
    expect(analyzeMongoCompletion('db.orders.find({ a: 12').kind).toBe('none')
    expect(analyzeMongoCompletion('db.orders.find({ a: /ab').kind).toBe('none')
    expect(analyzeMongoCompletion("db.orders.find({ _id: ObjectId('").kind).toBe('none')
  })
})

describe('analyzeMongoCompletion: arguments', () => {
  it('finds method, argument index, key path and position', () => {
    expect(site('db.orders.find({ st')).toMatchObject({
      kind: 'argument',
      owner: 'collection',
      collection: 'orders',
      method: 'find',
      argIndex: 0,
      path: [],
      position: 'key',
      prefix: 'st'
    })
    expect(site('db.orders.find({ status: { $')).toMatchObject({
      path: ['status'],
      position: 'key',
      prefix: '$'
    })
    expect(site('db.orders.find({ status: ')).toMatchObject({ path: ['status'], position: 'value' })
    expect(site('db.orders.find({}, { ')).toMatchObject({ argIndex: 1, path: [], position: 'key' })
    expect(site('db.orders.find({ $or: [ { ')).toMatchObject({
      path: ['$or', '[]'],
      position: 'key'
    })
    expect(site('db.orders.find().sort({ ')).toMatchObject({
      owner: 'cursor',
      method: 'sort',
      baseMethod: 'find'
    })
    expect(site('db.orders.aggregate([{ $group: { _id: "$')).toMatchObject({
      path: ['[]', '$group', '_id'],
      position: 'value',
      quoted: true,
      prefix: '$'
    })
    expect(site("db.orders.find({ 'items.pr")).toMatchObject({
      quoted: true,
      position: 'key',
      prefix: 'items.pr'
    })
  })

  it('filter: fields + top-level operators, then field operators, then BSON helpers', () => {
    const top = labels('db.orders.find({ ')
    expect(top).toEqual(
      expect.arrayContaining(['status', 'items.productId', '$and', '$or', '$expr'])
    )
    expect(top).not.toContain('$gt')
    const fieldOps = labels('db.orders.find({ total: { ')
    expect(fieldOps).toEqual(expect.arrayContaining(['$gt', '$in', '$exists', '$regex']))
    expect(fieldOps).not.toContain('$and')
    expect(labels('db.orders.find({ $expr: { ')).toEqual(expect.arrayContaining(['$eq', '$add']))
    expect(labels('db.orders.find({ at: IS')).toEqual(
      expect.arrayContaining(['ISODate', 'ObjectId'])
    )
    // Dotted paths are quoted when inserted as a bare key, raw inside quotes.
    const bare = mongoCompletionItems(site('db.orders.find({ '), data)
    expect(bare.find((i) => i.label === 'items.productId')?.apply).toBe("'items.productId'")
    const inQuotes = mongoCompletionItems(site("db.orders.find({ 'it"), data)
    expect(inQuotes.find((i) => i.label === 'items.productId')?.apply).toBeUndefined()
    // Fields of the collection named in the statement.
    expect(labels('db.users.find({ ')).toContain('email')
  })

  it('pipeline: stages with snippets, $match as filter, $group accumulators, $field refs', () => {
    const stages = mongoCompletionItems(site('db.orders.aggregate([{ '), data)
    const match = stages.find((s) => s.label === '$match')
    expect(match?.snippet).toMatch(/^\$match: \{/)
    expect(stages.find((s) => s.label === '$out')?.detail).toBe('writes')
    // Atlas-only stages are hidden on a self-hosted server.
    expect(stages.map((s) => s.label)).not.toContain('$rankFusion')
    expect(labels('db.orders.aggregate([{ $match: { ')).toContain('status')
    expect(labels('db.orders.aggregate([{ $group: { ')).toEqual(['_id'])
    expect(labels('db.orders.aggregate([{ $group: { _id: null, n: { ')).toEqual(
      expect.arrayContaining(['$sum', '$avg', '$push'])
    )
    expect(labels('db.orders.aggregate([{ $group: { _id: "$')).toEqual(
      expect.arrayContaining(['$status', '$$NOW', '$$ROOT'])
    )
    expect(labels('db.orders.aggregate([{ $lookup: { ')).toEqual(
      expect.arrayContaining(['from', 'localField', 'foreignField', 'as'])
    )
    expect(labels("db.orders.aggregate([{ $lookup: { from: '")).toContain('users')
  })

  it('update: operators, then fields; pipeline updates offer update stages only', () => {
    expect(labels('db.orders.updateMany({}, { ')).toEqual(
      expect.arrayContaining(['$set', '$inc', '$unset'])
    )
    expect(labels('db.orders.updateMany({}, { $set: { ')).toContain('status')
    const stages = labels('db.orders.updateOne({}, [{ ')
    expect(stages).toEqual(expect.arrayContaining(['$set', '$unset']))
    expect(stages).not.toContain('$group')
  })

  it('names: getCollection / getSiblingDB / explain verbosity / distinct field', () => {
    expect(labels("db.getCollection('")).toContain('order-items')
    expect(labels("db.getSiblingDB('")).toEqual(['shop', 'admin'])
    expect(labels("db.orders.find().explain('")).toContain('executionStats')
    expect(labels("db.orders.distinct('")).toContain('status')
    expect(labels('db.orders.createIndex({ status: ')).toEqual(['1', '-1'])
  })

  it('opens while typing only after a dot, inside quotes or once a word is started', () => {
    expect(shouldOfferWhileTyping(site('db.'), 'db.')).toBe(true)
    expect(shouldOfferWhileTyping(site('db.orders.find({ '), 'db.orders.find({ ')).toBe(false)
    expect(shouldOfferWhileTyping(site('db.orders.find({ s'), 'db.orders.find({ s')).toBe(true)
    expect(shouldOfferWhileTyping(site("db.orders.find({ '"), "db.orders.find({ '")).toBe(true)
  })

  it('lists stage operators for the stage dropdown (deduplicated)', () => {
    const options = stageOperatorOptions({ serverVersion: '8.0.0' })
    const values = options.map((o) => o.value)
    expect(new Set(values).size).toBe(values.length)
    expect(options.find((o) => o.value === '$merge')?.outputStage).toBe(true)
    expect(values).toContain('$match')
  })
})

describe('createMongoCompletionSource', () => {
  const complete = (doc: string, prefix?: string, explicit = false) => {
    const state = EditorState.create({ doc })
    const source = createMongoCompletionSource(
      () => data,
      prefix === undefined ? undefined : () => prefix
    )
    return source(new CompletionContext(state, doc.length, explicit))
  }

  it('maps offsets back through the synthetic prefix of the query bar', () => {
    const result = complete('{ sta', "db.getCollection('orders').find(")
    expect(result).not.toBeNull()
    if (result && !('then' in result)) {
      expect(result.from).toBe(2)
      expect(result.options.map((o) => o.label)).toContain('status')
    }
  })

  it('stays closed in key position until a word is started (unless explicit)', () => {
    expect(complete('{ ', "db.getCollection('orders').find(")).toBeNull()
    expect(complete('{ ', "db.getCollection('orders').find(", true)).not.toBeNull()
  })
})
