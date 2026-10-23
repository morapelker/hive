// The mongosh subset the Shell tab understands, as data. The parser accepts exactly these
// methods (anything else is rejected before it can reach a server), the classifier reads the
// statement class from here, and the editor builds its completions and hover docs from the same
// tables, so what autocompletes is what runs.
//
// `statementClass` is the class of the call itself; the classifier refines it where the
// arguments matter (aggregate with $out/$merge → write, runCommand → by command name).

import type { DataStatementClass } from '../types'

/** What a statement produces: a document list (grid/JSON views), a scalar/object, or a message. */
export type MongoMethodOutput = 'documents' | 'value' | 'command'

/** Role of an argument position, for editor completion (field names, operators, stages...). */
export type MongoArgRole =
  | 'filter'
  | 'projection'
  | 'sort'
  | 'options'
  | 'update'
  | 'document'
  | 'documents'
  | 'replacement'
  | 'pipeline'
  | 'field'
  | 'keys'
  | 'index'
  | 'name'
  | 'command'
  | 'operations'
  | 'value'

export interface MongoMethodInfo {
  /** True when the call can change data, indexes or collections (aggregate: only with $out/$merge). */
  readonly write: boolean
  /** Signature plus a one-line description, for completion popups. */
  readonly doc: string
  readonly statementClass: DataStatementClass
  readonly output: MongoMethodOutput
  readonly minArgs: number
  readonly maxArgs: number
  /** Argument roles in order. */
  readonly args: readonly MongoArgRole[]
}

const m = (
  statementClass: DataStatementClass,
  output: MongoMethodOutput,
  args: readonly MongoArgRole[],
  minArgs: number,
  doc: string,
  maxArgs: number = args.length
): MongoMethodInfo => ({
  write: statementClass !== 'read' && statementClass !== 'session',
  doc,
  statementClass,
  output,
  minArgs,
  maxArgs,
  args
})

/** db.<collection>.<method>(...) */
export const MONGO_COLLECTION_METHODS: Readonly<Record<string, MongoMethodInfo>> = Object.freeze({
  find: m(
    'read',
    'documents',
    ['filter', 'projection', 'options'],
    0,
    'find(filter?, projection?, options?) — documents matching the filter'
  ),
  findOne: m(
    'read',
    'documents',
    ['filter', 'projection', 'options'],
    0,
    'findOne(filter?, projection?, options?) — the first matching document'
  ),
  countDocuments: m(
    'read',
    'value',
    ['filter', 'options'],
    0,
    'countDocuments(filter?, options?) — exact number of matching documents'
  ),
  estimatedDocumentCount: m(
    'read',
    'value',
    ['options'],
    0,
    'estimatedDocumentCount(options?) — fast count from collection metadata'
  ),
  count: m(
    'read',
    'value',
    ['filter', 'options'],
    0,
    'count(filter?, options?) — number of matching documents (legacy)'
  ),
  distinct: m(
    'read',
    'value',
    ['field', 'filter', 'options'],
    1,
    'distinct(field, filter?, options?) — distinct values of a field'
  ),
  aggregate: m(
    'read',
    'documents',
    ['pipeline', 'options'],
    0,
    'aggregate(pipeline, options?) — run an aggregation pipeline'
  ),
  insertOne: m(
    'write',
    'value',
    ['document', 'options'],
    1,
    'insertOne(document, options?) — insert one document'
  ),
  insertMany: m(
    'write',
    'value',
    ['documents', 'options'],
    1,
    'insertMany(documents, options?) — insert an array of documents'
  ),
  updateOne: m(
    'write',
    'value',
    ['filter', 'update', 'options'],
    2,
    'updateOne(filter, update, options?) — update the first matching document'
  ),
  updateMany: m(
    'write',
    'value',
    ['filter', 'update', 'options'],
    2,
    'updateMany(filter, update, options?) — update every matching document'
  ),
  replaceOne: m(
    'write',
    'value',
    ['filter', 'replacement', 'options'],
    2,
    'replaceOne(filter, replacement, options?) — replace the first matching document'
  ),
  deleteOne: m(
    'write',
    'value',
    ['filter', 'options'],
    1,
    'deleteOne(filter, options?) — delete the first matching document'
  ),
  deleteMany: m(
    'write',
    'value',
    ['filter', 'options'],
    1,
    'deleteMany(filter, options?) — delete every matching document'
  ),
  findOneAndUpdate: m(
    'write',
    'value',
    ['filter', 'update', 'options'],
    2,
    'findOneAndUpdate(filter, update, options?) — update one document and return it'
  ),
  findOneAndReplace: m(
    'write',
    'value',
    ['filter', 'replacement', 'options'],
    2,
    'findOneAndReplace(filter, replacement, options?) — replace one document and return it'
  ),
  findOneAndDelete: m(
    'write',
    'value',
    ['filter', 'options'],
    1,
    'findOneAndDelete(filter, options?) — delete one document and return it'
  ),
  bulkWrite: m(
    'write',
    'value',
    ['operations', 'options'],
    1,
    'bulkWrite(operations, options?) — several inserts/updates/deletes in one call'
  ),
  createIndex: m(
    'ddl',
    'value',
    ['keys', 'options', 'value'],
    1,
    'createIndex(keys, options?) — create an index'
  ),
  createIndexes: m(
    'ddl',
    'value',
    ['keys', 'options', 'value'],
    1,
    'createIndexes([keys, ...], options?) — create several indexes'
  ),
  dropIndex: m('ddl', 'value', ['index'], 1, 'dropIndex(nameOrKeys) — drop one index'),
  dropIndexes: m(
    'ddl',
    'value',
    ['index'],
    0,
    "dropIndexes(names?) — drop indexes (all but _id when no argument or '*')"
  ),
  hideIndex: m(
    'ddl',
    'value',
    ['index'],
    1,
    'hideIndex(nameOrKeys) — hide an index from the query planner'
  ),
  unhideIndex: m(
    'ddl',
    'value',
    ['index'],
    1,
    'unhideIndex(nameOrKeys) — make a hidden index visible again'
  ),
  getIndexes: m('read', 'documents', [], 0, 'getIndexes() — index definitions of the collection'),
  indexes: m('read', 'documents', [], 0, 'indexes() — index definitions of the collection'),
  stats: m('read', 'value', ['options'], 0, 'stats(options?) — storage statistics ($collStats)'),
  drop: m(
    'ddl',
    'command',
    ['options'],
    0,
    'drop() — delete the collection, its documents and indexes'
  ),
  renameCollection: m(
    'ddl',
    'command',
    ['name', 'value'],
    1,
    'renameCollection(newName, dropTarget?) — rename the collection'
  ),
  explain: m(
    'read',
    'value',
    ['value'],
    0,
    "explain(verbosity?) — explain the following find/aggregate/count/distinct ('queryPlanner' | 'executionStats' | 'allPlansExecution')"
  )
})

/** db.<method>(...) */
export const MONGO_DATABASE_METHODS: Readonly<Record<string, MongoMethodInfo>> = Object.freeze({
  getCollectionNames: m(
    'read',
    'value',
    [],
    0,
    'getCollectionNames() — names of the collections in this database'
  ),
  getCollectionInfos: m(
    'read',
    'documents',
    ['filter', 'options'],
    0,
    'getCollectionInfos(filter?, options?) — collection names, types and options'
  ),
  listCollections: m(
    'read',
    'documents',
    ['filter', 'options'],
    0,
    'listCollections(filter?, options?) — collection names, types and options'
  ),
  createCollection: m(
    'ddl',
    'command',
    ['name', 'options'],
    1,
    'createCollection(name, options?) — create a collection (capped, time series, validator, collation...)'
  ),
  createView: m(
    'ddl',
    'command',
    ['name', 'name', 'pipeline', 'options'],
    3,
    'createView(name, source, pipeline, options?) — create a read-only view'
  ),
  dropDatabase: m(
    'ddl',
    'command',
    ['options'],
    0,
    'dropDatabase() — delete this database and everything in it'
  ),
  stats: m('read', 'value', ['value'], 0, 'stats(scale?) — database statistics (dbStats)'),
  runCommand: m(
    'read',
    'value',
    ['command', 'options'],
    1,
    'runCommand(command) — run a database command (classified by its first key)'
  ),
  adminCommand: m(
    'read',
    'value',
    ['command'],
    1,
    'adminCommand(command) — run a command against the admin database'
  ),
  aggregate: m(
    'read',
    'documents',
    ['pipeline', 'options'],
    1,
    'aggregate(pipeline, options?) — database-level aggregation ($currentOp, $documents...)'
  ),
  getName: m('read', 'value', [], 0, 'getName() — the current database name'),
  version: m('read', 'value', [], 0, 'version() — server version'),
  serverStatus: m('read', 'value', ['options'], 0, 'serverStatus() — server status document'),
  hostInfo: m('read', 'value', [], 0, 'hostInfo() — host system information'),
  hello: m('read', 'value', [], 0, 'hello() — topology and role of the server'),
  isMaster: m('read', 'value', [], 0, 'isMaster() — legacy alias of hello()'),
  currentOp: m(
    'read',
    'documents',
    ['filter'],
    0,
    'currentOp(filter?) — operations running on the server'
  ),
  killOp: m('admin', 'value', ['value'], 1, 'killOp(opid) — terminate a running operation')
})

/** Calls that only navigate (they do not run anything by themselves). */
export const MONGO_DATABASE_NAVIGATION_METHODS: Readonly<Record<string, { readonly doc: string }>> =
  Object.freeze({
    getCollection: {
      doc: "getCollection('name') — a collection whose name is not a valid identifier"
    },
    getSiblingDB: { doc: "getSiblingDB('name') — another database on the same server" }
  })

export interface MongoCursorMethodInfo {
  readonly write: false
  readonly doc: string
  /** Which methods the modifier may follow. */
  readonly appliesTo: readonly string[]
  readonly minArgs: number
  readonly maxArgs: number
  /** Ends the chain (a count or an explain document instead of a cursor). */
  readonly terminal?: boolean
  /** No effect here (the shell always fetches the result as an array). */
  readonly noop?: boolean
}

const FIND = ['find'] as const
const FIND_AGG = ['find', 'aggregate'] as const
const CURSORS = ['find', 'aggregate', 'listCollections'] as const

const c = (
  appliesTo: readonly string[],
  minArgs: number,
  maxArgs: number,
  doc: string,
  extra: { terminal?: boolean; noop?: boolean } = {}
): MongoCursorMethodInfo => ({ write: false, doc, appliesTo, minArgs, maxArgs, ...extra })

/** .<modifier>(...) after find()/aggregate() */
export const MONGO_CURSOR_METHODS: Readonly<Record<string, MongoCursorMethodInfo>> = Object.freeze({
  sort: c(FIND, 1, 1, 'sort({ field: 1 | -1 }) — order of the results'),
  limit: c(FIND, 1, 1, 'limit(n) — return at most n documents'),
  skip: c(FIND, 1, 1, 'skip(n) — skip the first n documents'),
  project: c(FIND, 1, 1, 'project({ field: 1 }) — fields to return'),
  projection: c(FIND, 1, 1, 'projection({ field: 1 }) — fields to return'),
  hint: c(FIND, 1, 1, "hint('index_name' | { field: 1 }) — force an index"),
  collation: c(FIND, 1, 1, "collation({ locale: 'en', strength: 2 }) — string comparison rules"),
  maxTimeMS: c(FIND_AGG, 1, 1, 'maxTimeMS(ms) — server-side time limit'),
  comment: c(FIND, 1, 1, 'comment(text) — tag the operation in logs and currentOp'),
  batchSize: c(FIND_AGG, 1, 1, 'batchSize(n) — documents per network round trip'),
  allowDiskUse: c(FIND, 0, 1, 'allowDiskUse(true?) — allow large sorts to use temporary files'),
  min: c(FIND, 1, 1, 'min({ field: value }) — inclusive lower index bound (needs hint)'),
  max: c(FIND, 1, 1, 'max({ field: value }) — exclusive upper index bound (needs hint)'),
  returnKey: c(FIND, 0, 1, 'returnKey(true?) — return only the index keys'),
  showRecordId: c(FIND, 0, 1, 'showRecordId(true?) — add $recordId to each document'),
  readPref: c(FIND, 1, 2, "readPref('secondaryPreferred') — read preference for this query"),
  explain: c(
    FIND_AGG,
    0,
    1,
    "explain(verbosity?) — query plan instead of documents ('executionStats'...)",
    { terminal: true }
  ),
  count: c(FIND, 0, 1, 'count(applySkipLimit?) — number of matching documents', { terminal: true }),
  size: c(FIND, 0, 0, 'size() — number of documents after skip/limit', { terminal: true }),
  itcount: c(FIND_AGG, 0, 0, 'itcount() — number of documents the cursor returns', {
    terminal: true
  }),
  toArray: c(CURSORS, 0, 0, 'toArray() — no-op here (results always come back as an array)', {
    noop: true
  }),
  pretty: c(CURSORS, 0, 0, 'pretty() — no-op here (results are always formatted)', { noop: true })
})

/** Methods that `db.<coll>.explain(verbosity)` may be followed by. */
export const MONGO_EXPLAINABLE_METHODS: readonly string[] = [
  'find',
  'aggregate',
  'count',
  'distinct'
]

export const MONGO_EXPLAIN_VERBOSITIES: readonly string[] = [
  'queryPlanner',
  'executionStats',
  'allPlansExecution'
]

/** `show <target>`; aliases map to their canonical name. */
export const MONGO_SHOW_TARGETS: Readonly<
  Record<string, { readonly canonical: string; readonly doc: string }>
> = Object.freeze({
  dbs: { canonical: 'dbs', doc: 'show dbs — databases with their sizes' },
  databases: { canonical: 'dbs', doc: 'show databases — databases with their sizes' },
  collections: {
    canonical: 'collections',
    doc: 'show collections — collections of the current database'
  },
  tables: { canonical: 'collections', doc: 'show tables — collections of the current database' },
  users: { canonical: 'users', doc: 'show users — users of the current database' },
  roles: { canonical: 'roles', doc: 'show roles — roles of the current database' },
  profile: { canonical: 'profile', doc: 'show profile — the 5 most recent profiler entries' }
})

/**
 * runCommand / adminCommand names that only read. Anything not listed (or listed as a write) is
 * at least a confirmation; unknown commands are 'unknown'.
 */
export const MONGO_READ_COMMANDS: ReadonlySet<string> = new Set([
  'find',
  'aggregate',
  'count',
  'distinct',
  'listCollections',
  'listIndexes',
  'listDatabases',
  'dbStats',
  'collStats',
  'dataSize',
  'serverStatus',
  'buildInfo',
  'buildinfo',
  'hello',
  'isMaster',
  'ismaster',
  'ping',
  'connectionStatus',
  'hostInfo',
  'getParameter',
  'getCmdLineOpts',
  'getLog',
  'explain',
  'currentOp',
  'listCommands',
  'whatsmyuri',
  'usersInfo',
  'rolesInfo',
  'validateDBMetadata',
  'getDefaultRWConcern',
  'replSetGetStatus',
  'replSetGetConfig',
  'top',
  'lockInfo',
  'features'
])

/** Commands that change data (class 'write'). */
export const MONGO_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'delete',
  'findAndModify',
  'findandmodify',
  'mapReduce',
  'mapreduce',
  'bulkWrite',
  'applyOps'
])

/** Commands that change collections, views or indexes (class 'ddl'). */
export const MONGO_DDL_COMMANDS: ReadonlySet<string> = new Set([
  'create',
  'drop',
  'dropDatabase',
  'createIndexes',
  'dropIndexes',
  'deleteIndexes',
  'collMod',
  'renameCollection',
  'convertToCapped',
  'cloneCollectionAsCapped',
  'reIndex',
  'compact',
  'validate',
  'cleanupOrphaned',
  'shardCollection',
  'reshardCollection'
])

/**
 * Everything else we know is administrative (class 'admin'). `profile` is here because any level
 * but -1, and slowms / sampleRate / filter even with -1, change the profiler (the last two
 * server-wide); the classifier lets exactly `{ profile: -1 }` through as a read.
 */
export const MONGO_ADMIN_COMMANDS: ReadonlySet<string> = new Set([
  'profile',
  'killOp',
  'killSessions',
  'killAllSessions',
  'killAllSessionsByPattern',
  'killCursors',
  'shutdown',
  'setParameter',
  'fsync',
  'fsyncUnlock',
  'logRotate',
  'createUser',
  'updateUser',
  'dropUser',
  'dropAllUsersFromDatabase',
  'grantRolesToUser',
  'revokeRolesFromUser',
  'createRole',
  'updateRole',
  'dropRole',
  'dropAllRolesFromDatabase',
  'grantPrivilegesToRole',
  'revokePrivilegesFromRole',
  'grantRolesToRole',
  'revokeRolesFromRole',
  'replSetReconfig',
  'replSetStepDown',
  'replSetFreeze',
  'replSetInitiate',
  'replSetMaintenance',
  'replSetSyncFrom',
  'setFeatureCompatibilityVersion',
  'setDefaultRWConcern',
  'enableSharding',
  'addShard',
  'removeShard',
  'movePrimary',
  'moveChunk',
  'balancerStart',
  'balancerStop',
  'flushRouterConfig',
  'refreshSessions',
  'endSessions',
  'abortTransaction',
  'commitTransaction'
])

/** BSON constructors the argument parser accepts (mirrors @mongodb-js/shell-bson-parser). */
export const MONGO_SHELL_CONSTRUCTORS: readonly string[] = [
  'ObjectId',
  'ObjectID',
  'ISODate',
  'Date',
  'NumberLong',
  'Int64',
  'Long',
  'NumberInt',
  'Int32',
  'Double',
  'NumberDecimal',
  'Decimal128',
  'Timestamp',
  'BinData',
  'Binary',
  'UUID',
  'LegacyJavaUUID',
  'LegacyCSharpUUID',
  'LegacyPythonUUID',
  'Code',
  'DBRef',
  'MinKey',
  'MaxKey',
  'Symbol',
  'Map',
  'RegExp'
]
