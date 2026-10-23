import { describe, expect, it } from 'vitest'
import {
  MONGO_COLLECTION_METHODS,
  MONGO_CURSOR_METHODS,
  MONGO_DATABASE_METHODS,
  classifyMongoShellStatement,
  findMongoOutputStages,
  findMongoServerJs,
  isEmptyMongoFilter,
  isMongoShellParseError,
  mongoStatementAtOffset,
  parseMongoShellStructure,
  pipelineEndsWithOutput,
  splitMongoShell,
  type MongoShellStructure
} from './index'

const structure = (text: string): MongoShellStructure => {
  const result = parseMongoShellStructure(text)
  if (isMongoShellParseError(result))
    throw new Error(`unexpected parse error: ${result.error.message}`)
  return result
}

const parseError = (text: string): { message: string; offset: number } => {
  const result = parseMongoShellStructure(text)
  if (!isMongoShellParseError(result)) throw new Error(`expected a parse error for ${text}`)
  return result.error
}

describe('splitMongoShell', () => {
  it('splits on semicolons and newlines, keeping offsets exact', () => {
    const src = 'use shop\ndb.orders.find({})\n\ndb.users.countDocuments(); show collections'
    const spans = splitMongoShell(src)
    expect(spans.map((s) => s.text)).toEqual([
      'use shop',
      'db.orders.find({})',
      'db.users.countDocuments()',
      'show collections'
    ])
    for (const span of spans) expect(src.slice(span.start, span.end)).toBe(span.text)
  })

  it('keeps a chain broken over several lines together', () => {
    const src =
      'db.orders\n  .find({ status: "A" })\n  .sort({ createdAt: -1 })\n  .limit(10)\ndb.users.find()'
    const spans = splitMongoShell(src)
    expect(spans).toHaveLength(2)
    expect(spans[0].text).toBe(
      'db.orders\n  .find({ status: "A" })\n  .sort({ createdAt: -1 })\n  .limit(10)'
    )
  })

  it('keeps multi-line arguments together (bracket depth)', () => {
    const src =
      'db.orders.aggregate([\n  { $match: { a: 1 } },\n\n  { $group: { _id: "$b" } }\n])\ndb.x.drop()'
    expect(splitMongoShell(src).map((s) => s.text)).toEqual([
      'db.orders.aggregate([\n  { $match: { a: 1 } },\n\n  { $group: { _id: "$b" } }\n])',
      'db.x.drop()'
    ])
  })

  it('ignores separators inside strings, regexes and comments', () => {
    const src = `db.a.find({ s: "x;y\\n", r: /a;b\\/c/i, t: 'q)' }) // trailing; comment\n/* block;\n comment */ db.b.find()`
    const spans = splitMongoShell(src)
    expect(spans.map((s) => s.text)).toEqual([
      `db.a.find({ s: "x;y\\n", r: /a;b\\/c/i, t: 'q)' })`,
      'db.b.find()'
    ])
  })

  it('reads a / after return, typeof and similar keywords as a regex', () => {
    const where = "db.users.find({ $where: function() { return /O'Brien/.test(this.name) } })"
    const src = `${where}\ndb.orders.find()`
    expect(splitMongoShell(src).map((s) => s.text)).toEqual([where, 'db.orders.find()'])
    const typeOf = 'db.a.find({ $where: function() { return typeof /"/ === "object" } })'
    expect(splitMongoShell(`${typeOf}\ndb.b.find()`).map((s) => s.text)).toEqual([
      typeOf,
      'db.b.find()'
    ])
    // A keyword after `.` is a property name, and an identifier is not a keyword: both divide.
    expect(splitMongoShell('db.a.find({ n: x.return / 2 })\ndb.b.find()')).toHaveLength(2)
    expect(splitMongoShell("db.a.find({ n: returns / 2, s: '/' })\ndb.b.find()")).toHaveLength(2)
    const parsed = parseMongoShellStructure(where)
    expect(isMongoShellParseError(parsed)).toBe(false)
  })

  it('continues when a line ends with an operator or comma', () => {
    const src = 'db.a.find({ a: 1,\n b: 2 })\ndb.a.find({ n: 1 +\n 2 })'
    expect(splitMongoShell(src)).toHaveLength(2)
  })

  it('skips comment-only and empty input', () => {
    expect(splitMongoShell('')).toEqual([])
    expect(splitMongoShell('  // just a comment\n/* and */ ;;\n')).toEqual([])
  })

  it('ends use/show at the end of the line', () => {
    expect(splitMongoShell('use shop\n.find()').map((s) => s.text)).toEqual(['use shop', '.find()'])
  })

  it('finds the statement at the cursor', () => {
    const src = 'db.a.find()\n\ndb.b.find(); db.c.find()\n'
    expect(mongoStatementAtOffset(src, 3)?.text).toBe('db.a.find()')
    expect(mongoStatementAtOffset(src, 11)?.text).toBe('db.a.find()')
    expect(mongoStatementAtOffset(src, 12)).toBeNull()
    expect(mongoStatementAtOffset(src, src.indexOf(';') + 1)?.text).toBe('db.b.find()')
    expect(mongoStatementAtOffset(src, src.indexOf('db.c') + 2)?.text).toBe('db.c.find()')
  })
})

describe('parseMongoShellStructure', () => {
  it('parses find with modifiers and argument ranges', () => {
    const text = 'db.orders.find({ status: "A" }, { total: 1 }).sort({ createdAt: -1 }).limit(10)'
    const s = structure(text)
    expect(s.kind).toBe('collection')
    expect(s.collection).toBe('orders')
    expect(s.method).toBe('find')
    expect(s.modifiers).toEqual(['sort', 'limit'])
    expect(s.argRanges.map((r) => text.slice(r.start, r.end))).toEqual([
      '{ status: "A" }',
      '{ total: 1 }'
    ])
    expect(s.modifierCalls[0].argRanges.map((r) => text.slice(r.start, r.end))).toEqual([
      '{ createdAt: -1 }'
    ])
    expect(text.slice(s.methodRange.start, s.methodRange.end)).toBe('find')
  })

  it('resolves getCollection, bracket names, dotted names and getSiblingDB', () => {
    expect(structure("db.getCollection('order-items').find()").collection).toBe('order-items')
    expect(structure('db["order-items"].countDocuments({})').collection).toBe('order-items')
    expect(structure('db.system.profile.find()').collection).toBe('system.profile')
    const sibling = structure("db.getSiblingDB('admin').getCollection('system.users').find()")
    expect(sibling.database).toBe('admin')
    expect(sibling.collection).toBe('system.users')
    const siblingDot = structure("db.getSiblingDB('analytics').events.aggregate([])")
    expect(siblingDot).toMatchObject({
      database: 'analytics',
      collection: 'events',
      method: 'aggregate'
    })
  })

  it('parses database methods and commands', () => {
    expect(structure('db.getCollectionNames()')).toMatchObject({
      kind: 'database',
      method: 'getCollectionNames'
    })
    expect(structure('db.runCommand({ ping: 1 })').commandName).toBe('ping')
    expect(structure("db.adminCommand('listDatabases')").commandName).toBe('listDatabases')
    expect(structure("db.getSiblingDB('x').dropDatabase()")).toMatchObject({
      database: 'x',
      method: 'dropDatabase'
    })
    expect(structure('db.listCollections().toArray()').modifiers).toEqual(['toArray'])
  })

  it('parses use and show', () => {
    expect(structure('use shop')).toMatchObject({ kind: 'use', method: 'use', database: 'shop' })
    expect(structure('  use "my-db" ;  // switch')).toMatchObject({
      kind: 'use',
      database: 'my-db'
    })
    expect(structure('show dbs')).toMatchObject({ kind: 'show', method: 'dbs' })
    expect(structure('show databases')).toMatchObject({ kind: 'show', method: 'dbs' })
    expect(structure('show tables;')).toMatchObject({ kind: 'show', method: 'collections' })
    expect(parseError('show logs').message).toMatch(/Unsupported: show logs/)
    expect(parseError('use a.b').message).toMatch(/Invalid database name/)
    expect(parseError('use').message).toMatch(/needs a database name/)
  })

  it('records aggregate stage names', () => {
    const s = structure(
      'db.orders.aggregate([{ $match: { a: 1 } }, { "$group": { _id: "$b" } }, x => x])'.replace(
        ', x => x',
        ''
      )
    )
    expect(s.stageNames).toEqual(['$match', '$group'])
  })

  it('supports explain in both positions', () => {
    const prefix = structure("db.orders.explain('executionStats').find({ a: 1 }).sort({ b: 1 })")
    expect(prefix).toMatchObject({ method: 'find', modifiers: ['sort'], explain: { prefix: true } })
    const suffix = structure('db.orders.find({ a: 1 }).explain()')
    expect(suffix).toMatchObject({
      method: 'find',
      modifiers: ['explain'],
      explain: { prefix: false }
    })
    expect(structure('db.orders.explain().aggregate([])').method).toBe('aggregate')
    expect(parseError('db.orders.explain().insertOne({})').message).toMatch(
      /explain\(\) must be followed/
    )
  })

  it('accepts await, BSON helpers, regexes, function values and comments', () => {
    expect(
      structure('await db.orders.findOne({ _id: ObjectId("58c33a794d08b991e3648fd2") })').method
    ).toBe('findOne')
    const text = `db.orders.find({
      createdAt: { $gte: ISODate("2024-01-01"), $lt: new Date(Date.now() - 86400000) }, // since
      total: NumberDecimal("10.5"), n: NumberLong("9007199254740993"), sku: /^AB/i,
      $where: function () { return this.a > 1 }, neg: -1, nan: NaN, u: undefined, x: Math.floor(2.5)
    })`
    expect(structure(text).method).toBe('find')
  })

  it('rejects arbitrary JavaScript', () => {
    const rejected = [
      'db.orders.find().forEach(d => print(d))',
      'db.orders.find({ a: require("fs") })',
      'db.orders.find({ a: process.env.HOME })',
      "db.orders.find({ a: 'x'.toUpperCase() })",
      'db.orders.find({ [key]: 1 })',
      'db.orders.find({ a: `tpl` })',
      'db.orders.find({ ...other })',
      'db.orders.find(filter)',
      'var x = 1',
      'x = db.orders.find()',
      'print("hi")',
      'this.constructor.constructor("return process")()',
      'db.orders.find({ a: [].constructor.constructor("return 1")() })',
      'db.orders.find({}); db.orders.drop()',
      'db.orders.find().length',
      'db.orders.find()?.limit(1)',
      'db.orders.mapReduce(function(){}, function(){})',
      'db.orders.insert({ a: 1 })',
      'db.orders.remove({})',
      'db.eval("1")',
      'db.orders.find().sort({ a: 1 }).toArray().map(x => x)',
      'db.orders.find({ a: 1 }).count().pretty().limit(1)',
      'db.orders.find({ a: (() => 1)() })',
      'db.orders.find({ a: 1 ? 2 : 3 })',
      'db.orders.find({ a: 1 || 2 })',
      'db.orders.find({ get a() { return 1 } })',
      'db.orders.find({ a })',
      'db[name].find()',
      'db.orders.find({ a: 1n })',
      'db',
      'db.orders',
      'db.getCollection(x).find()',
      'db.getSiblingDB(name).orders.find()',
      'db.orders.find({ a: 1 }',
      '{ a: 1 }',
      'db.orders.deleteMany()',
      'db.orders.find({}, {}, {}, {})',
      'db.orders.find().sort()',
      'db.orders.find().limit(1, 2)'
    ]
    for (const text of rejected) {
      const result = parseMongoShellStructure(text)
      expect(isMongoShellParseError(result), text).toBe(true)
    }
  })

  it('reports useful error offsets', () => {
    const text = 'db.orders.find({ a: require("fs") })'
    expect(parseError(text).offset).toBe(text.indexOf('require'))
    const syntax = 'db.orders.find({ a: 1 '
    expect(parseError(syntax).message).toMatch(/Syntax error/)
    const unknown = 'db.orders.frobnicate()'
    expect(parseError(unknown)).toMatchObject({ offset: unknown.indexOf('frobnicate') })
    expect(parseError('db.find({})').message).toMatch(/did you mean db.<collection>.find/)
    expect(parseError('db.orders.find().forEach(x => x)').message).toMatch(
      /forEach\(\) is not supported after find/
    )
  })
})

describe('classifyMongoShellStatement', () => {
  const cls = (text: string, database?: string) => classifyMongoShellStatement(text, { database })

  it('classifies reads', () => {
    for (const text of [
      'db.orders.find({ status: "A" }).sort({ a: 1 }).limit(5)',
      'db.orders.findOne()',
      'db.orders.countDocuments({})',
      'db.orders.estimatedDocumentCount()',
      'db.orders.count()',
      "db.orders.distinct('status')",
      'db.orders.aggregate([{ $match: {} }, { $group: { _id: "$status", n: { $sum: 1 } } }])',
      'db.orders.getIndexes()',
      'db.orders.indexes()',
      'db.orders.stats()',
      'db.getCollectionNames()',
      'db.getCollectionInfos()',
      'db.stats()',
      'db.runCommand({ ping: 1 })',
      'db.runCommand({ listCollections: 1 })',
      'db.adminCommand({ listDatabases: 1 })',
      'db.runCommand({ aggregate: "orders", pipeline: [], cursor: {} })',
      'show dbs',
      'show collections',
      'db.orders.find().explain("executionStats")',
      'db.version()',
      'db.currentOp()'
    ]) {
      expect(cls(text).classification, text).toBe('read')
    }
    expect(cls('use shop').classification).toBe('session')
  })

  it('classifies writes, ddl and admin', () => {
    expect(cls('db.orders.insertOne({ a: 1 })').classification).toBe('write')
    expect(cls('db.orders.insertMany([{ a: 1 }])').classification).toBe('write')
    expect(cls('db.orders.updateOne({ _id: 1 }, { $set: { a: 1 } })').classification).toBe('write')
    expect(cls('db.orders.replaceOne({ _id: 1 }, { a: 1 })').classification).toBe('write')
    expect(cls('db.orders.deleteOne({ _id: 1 })').classification).toBe('write')
    expect(cls('db.orders.findOneAndUpdate({ _id: 1 }, { $inc: { n: 1 } })').classification).toBe(
      'write'
    )
    expect(cls('db.orders.findOneAndDelete({ _id: 1 })').classification).toBe('write')
    expect(cls('db.orders.bulkWrite([{ insertOne: { document: {} } }])').classification).toBe(
      'write'
    )
    expect(cls('db.orders.createIndex({ a: 1 })').classification).toBe('ddl')
    expect(cls('db.orders.dropIndex("a_1")').classification).toBe('ddl')
    expect(cls('db.orders.drop()').classification).toBe('ddl')
    expect(cls('db.orders.renameCollection("o2")').classification).toBe('ddl')
    expect(cls('db.createCollection("x", { capped: true, size: 1024 })').classification).toBe('ddl')
    expect(cls('db.dropDatabase()').classification).toBe('ddl')
    expect(cls('db.killOp(123)').classification).toBe('admin')
    expect(cls('db.runCommand({ insert: "orders", documents: [{}] })').classification).toBe('write')
    expect(cls('db.runCommand({ collMod: "orders", validator: {} })').classification).toBe('ddl')
    expect(cls('db.adminCommand({ setParameter: 1, x: 1 })').classification).toBe('admin')
    expect(cls('db.runCommand({ frobnicate: 1 })').classification).toBe('unknown')
    expect(cls('db.orders.find(').classification).toBe('unknown')
  })

  it('reads only the state-free forms of profile and features', () => {
    for (const text of [
      'db.runCommand({ profile: -1 })',
      "db.getSiblingDB('x').runCommand({ profile: -1, comment: 'status' })",
      'db.adminCommand({ "profile": -1 })'
    ]) {
      expect(cls(text).classification, text).toBe('read')
    }
    for (const text of [
      "db.getSiblingDB('x').runCommand({ profile: 2, slowms: 0 })",
      'db.runCommand({ profile: 1 })',
      'db.runCommand({ profile: 0 })',
      'db.runCommand({ profile: -1, slowms: 5 })',
      'db.runCommand({ profile: -1, sampleRate: 0.5 })',
      'db.runCommand({ profile: -1, filter: { millis: { $gt: 1 } } })',
      'db.runCommand({ profile: -1, profile: 2 })',
      'db.runCommand({ profile: NumberInt(2) })',
      "db.runCommand('profile')"
    ]) {
      const result = cls(text)
      expect(result.classification, text).toBe('admin')
      expect(result.reasons, text).toEqual(['profile changes the database profiler settings'])
    }
    expect(cls('db.runCommand({ features: 1 })').classification).toBe('read')
    expect(cls('db.runCommand({ features: 1, oidReset: true })').classification).toBe('admin')
  })

  it('treats $out/$merge anywhere as a write', () => {
    const out = cls('db.orders.aggregate([{ $match: {} }, { $out: "archive" }])')
    expect(out.classification).toBe('write')
    expect(out.output).toBe('command')
    expect(out.dangerous.join(' ')).toMatch(/\$out replaces collection "archive"/)
    expect(out.targets).toEqual(['archive'])
    const merge = cls('db.orders.aggregate([{ $merge: { into: { db: "bi", coll: "daily" } } }])')
    expect(merge.classification).toBe('write')
    expect(merge.dangerous[0]).toMatch(/bi\.daily/)
    const nested = cls(
      'db.orders.aggregate([{ $facet: { a: [{ $lookup: { from: "x", pipeline: [{ $unionWith: { coll: "y", pipeline: [{ "$out": "z" }] } }], as: "q" } }] } }])'
    )
    expect(nested.classification).toBe('write')
    expect(
      cls('db.runCommand({ aggregate: "orders", pipeline: [{ $out: "t" }], cursor: {} })')
        .classification
    ).toBe('write')
    expect(cls('db.getSiblingDB("admin").aggregate([{ $currentOp: {} }])').classification).toBe(
      'read'
    )
    // explain never writes (the executor strips $out and forces queryPlanner)
    expect(cls('db.orders.explain().aggregate([{ $out: "x" }])').classification).toBe('read')
  })

  it('flags dangerous statements', () => {
    expect(cls('db.orders.deleteMany({})').dangerous[0]).toMatch(
      /deleteMany with an empty filter deletes every document in "orders"/
    )
    expect(cls('db.orders.deleteMany({ status: "x" })').dangerous).toEqual([])
    expect(cls('db.orders.updateMany({}, { $set: { a: 1 } })').dangerous[0]).toMatch(
      /updateMany with an empty filter/
    )
    expect(cls('db.orders.drop()')).toMatchObject({ targets: ['orders'] })
    expect(cls('db.orders.drop()').dangerous[0]).toMatch(/drop\(\) deletes collection "orders"/)
    expect(cls('db.dropDatabase()', 'shop').dangerous[0]).toMatch(
      /dropDatabase\(\) deletes database "shop"/
    )
    expect(cls('db.dropDatabase()', 'shop').targets).toEqual(['shop'])
    expect(cls('db.orders.dropIndexes()').dangerous[0]).toMatch(/drops every index/)
    expect(cls('db.orders.dropIndex("a_1")').targets).toEqual(['a_1'])
    expect(cls('db.orders.renameCollection("archive", true)').dangerous[0]).toMatch(
      /dropTarget drops the existing collection "archive"/
    )
    expect(cls('db.orders.renameCollection("archive")').dangerous).toEqual([])
    expect(cls('db.orders.bulkWrite([{ deleteMany: { filter: {} } }])').dangerous[0]).toMatch(
      /deleteMany with an empty filter/
    )
    expect(cls('db.runCommand({ drop: "orders" })').dangerous[0]).toMatch(
      /drop\(\) deletes collection "orders"/
    )
    expect(
      cls('db.runCommand({ delete: "orders", deletes: [{ q: {}, limit: 0 }] })').dangerous[0]
    ).toMatch(/empty filter/)
    expect(cls('db.adminCommand({ shutdown: 1 })').dangerous[0]).toMatch(/shutdown/)
  })

  it('warns about server-side JavaScript without calling it a write', () => {
    const where = cls('db.orders.find({ $where: "this.a > 1" })')
    expect(where.classification).toBe('read')
    expect(where.dangerous[0]).toMatch(/\$where runs JavaScript on the server/)
    const fn = cls(
      'db.orders.aggregate([{ $addFields: { x: { $function: { body: function (a) { return a }, args: ["$a"], lang: "js" } } } }])'
    )
    expect(fn.classification).toBe('read')
    expect(fn.dangerous[0]).toMatch(/\$function/)
  })

  it('reports output kinds', () => {
    expect(cls('db.orders.find()').returnsDocuments).toBe(true)
    expect(cls('db.orders.find().count()').returnsDocuments).toBe(false)
    expect(cls('db.orders.find().explain()').output).toBe('value')
    expect(cls('db.orders.countDocuments()').output).toBe('value')
    expect(cls('show dbs').returnsDocuments).toBe(true)
    expect(cls('use x').output).toBe('command')
    expect(cls('db.orders.drop()').output).toBe('command')
  })

  it('never throws and reports parse errors', () => {
    const bad = cls('db.orders.find({ a: require("x") })')
    expect(bad.classification).toBe('unknown')
    expect(bad.error?.message).toMatch(/Unsupported expression/)
  })
})

describe('value analysis', () => {
  it('finds output stages and server JS in values', () => {
    expect(findMongoOutputStages([{ $match: {} }, { $out: 'x' }])).toEqual([
      { stage: '$out', target: 'x' }
    ])
    expect(findMongoOutputStages([{ $facet: { a: [{ $merge: { into: 'y' } }] } }])).toEqual([
      { stage: '$merge', target: 'y' }
    ])
    expect(findMongoServerJs({ $where: 'x', a: [{ $accumulator: {} }] })).toEqual([
      '$where',
      '$accumulator'
    ])
    expect(pipelineEndsWithOutput([{ $match: {} }, { $merge: 'x' }])).toBe(true)
    expect(pipelineEndsWithOutput([{ $out: 'x' }, { $match: {} }])).toBe(false)
  })

  it('detects empty filters', () => {
    expect(isEmptyMongoFilter(undefined)).toBe(true)
    expect(isEmptyMongoFilter(null)).toBe(true)
    expect(isEmptyMongoFilter({})).toBe(true)
    expect(isEmptyMongoFilter({ a: 1 })).toBe(false)
    expect(isEmptyMongoFilter(new Date())).toBe(false)
  })
})

describe('method tables', () => {
  it('exposes completion tables with docs', () => {
    expect(MONGO_COLLECTION_METHODS.find.write).toBe(false)
    expect(MONGO_COLLECTION_METHODS.deleteMany.write).toBe(true)
    expect(MONGO_DATABASE_METHODS.dropDatabase.write).toBe(true)
    expect(MONGO_CURSOR_METHODS.sort.doc).toMatch(/sort/)
    for (const info of Object.values(MONGO_COLLECTION_METHODS))
      expect(info.doc.length).toBeGreaterThan(5)
  })
})
