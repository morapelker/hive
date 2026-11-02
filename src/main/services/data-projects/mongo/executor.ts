// Runs ONE parsed mongosh-style statement against a MongoClient by mapping its structure to
// driver calls — never by building or evaluating code. Argument values come from
// @mongodb-js/shell-bson-parser (runtime.ts), each method validates the shapes it needs, and
// reads are bounded: find gets .limit(N+1) / aggregate gets { $limit: N+1 } (unless it ends in
// $out/$merge) so `truncated` is exact, with the hard cap and a byte budget always applied;
// every operation carries the `hive:<uuid>` comment (for $currentOp → killOp on cancel), a
// default maxTimeMS on reads and the abort signal where the driver supports one.
//
// Results: document lists → { kind: 'documents' } (canonical EJSON, read with promoteValues:
// false so Int32/Double/Long survive), scalars and write results → { kind: 'value' } (canonical
// EJSON), use / DDL → { kind: 'command', message }.

import type { AbstractCursor, ClientSession, Collection, Db, Document, MongoClient } from 'mongodb'
import {
  DATA_ERROR_CODES,
  type DataCommandResult,
  type DataDocumentsResult,
  type DataValueResult
} from '../../../../shared/data-projects/types'
import {
  MONGO_EXPLAIN_VERBOSITIES,
  findMongoOutputStages,
  isPlainMongoObject,
  pipelineEndsWithOutput,
  type MongoShellArgNode,
  type MongoShellParsed
} from '../../../../shared/data-projects/mongo-shell'
import { DataDriverError, type DriverStatementResult } from '../contracts'
import { bsonSize, isPlainObject, parseShellValue, toCanonical, toNumberValue } from './runtime'

export interface MongoExecContext {
  client: MongoClient
  /** The session database ('' = mongosh's default "test"); getSiblingDB overrides it. */
  database: string
  /** `use x`: switch the session database. */
  useDatabase(name: string): void
  /** Comment tag of this operation ("hive:<uuid>"), for $currentOp → killOp. */
  tag: string
  signal: AbortSignal
  session?: ClientSession
  /** Auto-limit N (null = none; the hard cap still applies). */
  limit: number | null
  hardCap: number
  /** Default maxTimeMS for reads / writes (undefined = none). */
  readTimeoutMs?: number
  writeTimeoutMs?: number
  /** Set by the executor: the maxTimeMS that applied (for the timeout hint). */
  effectiveTimeoutMs?: number | null
}

type Opts = Record<string, unknown>

function invalid(message: string, position?: number): DataDriverError {
  return new DataDriverError(message, { code: DATA_ERROR_CODES.invalidInput, position })
}

/** Rejects as soon as the signal aborts (the server op is killed separately by the driver). */
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

// ---------------------------------------------------------------------------------------------
// Argument conversion and validation
// ---------------------------------------------------------------------------------------------

class Args {
  constructor(
    private readonly parsed: MongoShellParsed,
    private readonly owner: string
  ) {}

  value(node: MongoShellArgNode | undefined, index: number, owner = this.owner): unknown {
    if (!node) return undefined
    const text = this.parsed.text.slice(node.start, node.end)
    return parseShellValue(text, `Argument ${index + 1} of ${owner}()`, node.start)
  }

  object(
    node: MongoShellArgNode | undefined,
    index: number,
    what: string,
    owner = this.owner
  ): Opts | undefined {
    const value = this.value(node, index, owner)
    if (value === undefined || value === null) return undefined
    if (!isPlainObject(value)) throw invalid(`${owner}(): ${what} must be an object`, node?.start)
    return value
  }

  requiredObject(
    node: MongoShellArgNode | undefined,
    index: number,
    what: string,
    owner = this.owner
  ): Opts {
    const value = this.object(node, index, what, owner)
    if (!value) throw invalid(`${owner}(): ${what} is required`, node?.start)
    return value
  }

  array(
    node: MongoShellArgNode | undefined,
    index: number,
    what: string,
    owner = this.owner
  ): unknown[] {
    const value = this.value(node, index, owner)
    if (!Array.isArray(value)) throw invalid(`${owner}(): ${what} must be an array`, node?.start)
    return value
  }

  string(
    node: MongoShellArgNode | undefined,
    index: number,
    what: string,
    owner = this.owner
  ): string {
    const value = this.value(node, index, owner)
    if (typeof value !== 'string' || !value)
      throw invalid(`${owner}(): ${what} must be a non-empty string`, node?.start)
    return value
  }

  number(
    node: MongoShellArgNode | undefined,
    index: number,
    what: string,
    owner = this.owner
  ): number {
    const value = toNumberValue(this.value(node, index, owner))
    if (value === null || !Number.isFinite(value))
      throw invalid(`${owner}(): ${what} must be a number`, node?.start)
    return value
  }

  bool(
    node: MongoShellArgNode | undefined,
    index: number,
    fallback: boolean,
    owner = this.owner
  ): boolean {
    if (!node) return fallback
    const value = this.value(node, index, owner)
    if (typeof value !== 'boolean') throw invalid(`${owner}(): expected true or false`, node.start)
    return value
  }
}

function pipelineOf(value: unknown[], owner: string, position?: number): Document[] {
  for (const stage of value) {
    if (!isPlainObject(stage))
      throw invalid(
        `${owner}(): every pipeline stage must be an object like { $match: {...} }`,
        position
      )
  }
  return value as Document[]
}

// ---------------------------------------------------------------------------------------------
// Limits and outputs
// ---------------------------------------------------------------------------------------------

interface ReadPlan {
  /** Documents to ask the server for (cap + 1 to detect truncation). */
  fetch: number
  cap: number
  resultLimit: number | null
}

function readPlan(userLimit: number | undefined, ctx: MongoExecContext): ReadPlan {
  const hardCap = Math.max(1, ctx.hardCap)
  if (userLimit !== undefined && userLimit !== 0) {
    const limit = Math.abs(Math.trunc(userLimit))
    if (limit <= hardCap) return { fetch: limit, cap: limit, resultLimit: null }
    return { fetch: hardCap + 1, cap: hardCap, resultLimit: hardCap }
  }
  const auto = ctx.limit && ctx.limit > 0 ? Math.min(ctx.limit, hardCap) : hardCap
  return { fetch: auto + 1, cap: auto, resultLimit: auto }
}

/**
 * Documents kept per result by serialized BSON size, like the SQL drivers' MAX_RESULT_BYTES:
 * without it, up to the hard cap of documents of up to 16 MB each would be collected and sent
 * as one RPC message (larger still as canonical EJSON).
 */
export const MONGO_MAX_RESULT_BYTES = 64 * 1024 * 1024

export interface CollectedDocuments {
  docs: Document[]
  /** The byte budget stopped the read before `fetch` documents. */
  byteLimited: boolean
}

/** Reads up to `fetch` documents and about `maxBytes` of BSON, then closes the cursor. */
export async function collectDocuments(
  cursor: AbstractCursor<Document>,
  fetch: number,
  maxBytes = MONGO_MAX_RESULT_BYTES
): Promise<CollectedDocuments> {
  const docs: Document[] = []
  let bytes = 0
  let byteLimited = false
  try {
    for await (const doc of cursor) {
      const size = bsonSize(doc)
      // The document that would cross the budget is left out unless it is the only one.
      if (docs.length > 0 && bytes + size > maxBytes) {
        byteLimited = true
        break
      }
      bytes += size
      docs.push(doc)
      if (docs.length >= fetch) break
    }
  } finally {
    await cursor.close().catch(() => undefined)
  }
  return { docs, byteLimited }
}

function documentsOutput(
  docs: Document[],
  plan: ReadPlan | null,
  byteLimited = false
): DriverStatementResult {
  let truncated = false
  let list = docs
  if (plan && docs.length > plan.cap) {
    truncated = true
    list = docs.slice(0, plan.cap)
  }
  // Stopped by the budget before the row limit (at the limit it only hid the "more" probe).
  const byteCut = byteLimited && (!plan || docs.length < plan.cap)
  const output: DataDocumentsResult = {
    kind: 'documents',
    documents: list.map((doc) => toCanonical<Record<string, unknown>>(doc)),
    truncated: truncated || byteLimited,
    limit: byteCut ? list.length : plan ? plan.resultLimit : null
  }
  if (!byteCut) return { output }
  return {
    output,
    notices: [
      `Showing the first ${list.length} documents: the full result is over ${MONGO_MAX_RESULT_BYTES / 1024 / 1024} MB. Add a projection that leaves out large fields, or a smaller limit.`
    ]
  }
}

/** Runs the cursor through the byte budget into a documents result. */
async function cursorOutput(
  cursor: AbstractCursor<Document>,
  plan: ReadPlan
): Promise<DriverStatementResult> {
  const { docs, byteLimited } = await collectDocuments(cursor, plan.fetch)
  return documentsOutput(docs, plan, byteLimited)
}

const valueOutput = (value: unknown): DriverStatementResult => {
  const output: DataValueResult = { kind: 'value', value: toCanonical<unknown>(value) }
  return { output }
}

const commandOutput = (message: string, affectedRows?: number | null): DriverStatementResult => {
  const output: DataCommandResult = { kind: 'command', message }
  if (affectedRows !== undefined) output.affectedRows = affectedRows
  return { output }
}

function explainVerbosity(args: Args, nodes: MongoShellArgNode[]): string {
  if (nodes.length === 0) return 'queryPlanner'
  const value = args.value(nodes[0], 0, 'explain')
  if (value === true) return 'allPlansExecution'
  if (value === false || value === undefined) return 'queryPlanner'
  if (typeof value === 'string' && MONGO_EXPLAIN_VERBOSITIES.includes(value)) return value
  throw invalid(
    `explain(): verbosity must be one of ${MONGO_EXPLAIN_VERBOSITIES.join(', ')}`,
    nodes[0].start
  )
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

/** Combines the user's comment (if any) with our tag so cancel can still find the operation. */
function commentFor(ctx: MongoExecContext, user: unknown): string {
  return typeof user === 'string' && user ? `${ctx.tag} ${user}` : ctx.tag
}

function baseRead(ctx: MongoExecContext, options: Opts | undefined): Opts {
  const opts: Opts = { ...(options ?? {}) }
  opts.comment = commentFor(ctx, opts.comment)
  if (ctx.session) opts.session = ctx.session
  opts.signal = ctx.signal
  if (opts.maxTimeMS === undefined && ctx.readTimeoutMs) opts.maxTimeMS = ctx.readTimeoutMs
  ctx.effectiveTimeoutMs = toNumberValue(opts.maxTimeMS) ?? null
  return opts
}

function baseWrite(ctx: MongoExecContext, options: Opts | undefined): Opts {
  const opts: Opts = { ...(options ?? {}) }
  opts.comment = commentFor(ctx, opts.comment)
  if (ctx.session) opts.session = ctx.session
  if (opts.maxTimeMS === undefined && ctx.writeTimeoutMs) opts.maxTimeMS = ctx.writeTimeoutMs
  ctx.effectiveTimeoutMs = toNumberValue(opts.maxTimeMS) ?? null
  return opts
}

/** A plain-object copy of the driver's write results (some are class instances). */
function writeResult(result: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) if (result[key] !== undefined) out[key] = result[key]
  return out
}

/**
 * Executes one parsed statement. The caller has already classified it, enforced the read-only
 * sandbox, and owns cancellation (ctx.signal + killOp by ctx.tag).
 */
export async function executeMongoShellStatement(
  ctx: MongoExecContext,
  parsed: MongoShellParsed
): Promise<DriverStatementResult> {
  const { structure } = parsed
  if (structure.kind === 'use') {
    const name = structure.database ?? ''
    ctx.useDatabase(name)
    return commandOutput(`switched to db ${name}`)
  }
  // mongosh's default database is "test" when nothing selected one.
  const dbName = structure.database || ctx.database || 'test'
  const db = ctx.client.db(dbName)
  if (structure.kind === 'show') return runShow(ctx, db, structure.method)
  if (structure.kind === 'database') return runDatabaseMethod(ctx, db, parsed)
  const collection = db.collection(structure.collection ?? '')
  return runCollectionMethod(ctx, db, collection, parsed)
}

async function runShow(
  ctx: MongoExecContext,
  db: Db,
  target: string
): Promise<DriverStatementResult> {
  const base = { session: ctx.session, signal: ctx.signal }
  switch (target) {
    case 'dbs': {
      const result = await ctx.client
        .db('admin')
        .command({ listDatabases: 1, nameOnly: false, authorizedDatabases: true }, base)
      const docs = ((result.databases as Document[]) ?? []).map((d) => ({
        name: d.name,
        sizeOnDisk: d.sizeOnDisk,
        empty: d.empty
      }))
      return documentsOutput(docs, null)
    }
    case 'collections': {
      const list = await db
        .listCollections({}, { nameOnly: true, authorizedCollections: true, ...base })
        .toArray()
      const docs = list
        .map((c) => ({ name: c.name, type: c.type ?? 'collection' }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return documentsOutput(docs, null)
    }
    case 'users': {
      const result = await db.command({ usersInfo: 1 }, base)
      return documentsOutput((result.users as Document[]) ?? [], null)
    }
    case 'roles': {
      const result = await db.command({ rolesInfo: 1, showBuiltinRoles: true }, base)
      return documentsOutput((result.roles as Document[]) ?? [], null)
    }
    case 'profile': {
      const cursor = db
        .collection('system.profile')
        .find({}, { sort: { $natural: -1 }, limit: 5, promoteValues: false, ...base })
      const { docs, byteLimited } = await collectDocuments(cursor, 5)
      return documentsOutput(docs, null, byteLimited)
    }
    default:
      throw invalid(`Unsupported: show ${target}`)
  }
}

async function runDatabaseMethod(
  ctx: MongoExecContext,
  db: Db,
  parsed: MongoShellParsed
): Promise<DriverStatementResult> {
  const { structure, argNodes } = parsed
  const method = structure.method
  const args = new Args(parsed, `db.${method}`)
  const admin = ctx.client.db('admin')
  const base = { session: ctx.session, signal: ctx.signal }
  switch (method) {
    case 'getCollectionNames': {
      const list = await db
        .listCollections({}, { nameOnly: true, authorizedCollections: true, ...base })
        .toArray()
      return valueOutput(list.map((c) => c.name).sort((a, b) => a.localeCompare(b)))
    }
    case 'getCollectionInfos':
    case 'listCollections': {
      const filter = args.object(argNodes[0], 0, 'the filter') ?? {}
      const options = args.object(argNodes[1], 1, 'the options') ?? {}
      const list = await db
        .listCollections(filter, {
          ...options,
          nameOnly: false,
          authorizedCollections: true,
          ...base
        })
        .toArray()
      return documentsOutput(list as Document[], null)
    }
    case 'createCollection': {
      const name = args.string(argNodes[0], 0, 'the collection name')
      const options = args.object(argNodes[1], 1, 'the options') ?? {}
      await raceWithAbort(
        db.createCollection(name, { ...options, session: ctx.session }),
        ctx.signal
      )
      return commandOutput(`Created collection "${name}" in ${db.databaseName}`)
    }
    case 'createView': {
      const name = args.string(argNodes[0], 0, 'the view name')
      const source = args.string(argNodes[1], 1, 'the source collection')
      const pipeline = pipelineOf(
        args.array(argNodes[2], 2, 'the pipeline'),
        'createView',
        argNodes[2]?.start
      )
      const options = args.object(argNodes[3], 3, 'the options') ?? {}
      await raceWithAbort(
        db.createCollection(name, { ...options, viewOn: source, pipeline, session: ctx.session }),
        ctx.signal
      )
      return commandOutput(`Created view "${name}" on "${source}"`)
    }
    case 'dropDatabase': {
      await raceWithAbort(db.dropDatabase({ session: ctx.session }), ctx.signal)
      return commandOutput(`Dropped database "${db.databaseName}"`)
    }
    case 'stats': {
      const arg = args.value(argNodes[0], 0)
      const scale = toNumberValue(isPlainObject(arg) ? arg.scale : arg)
      const command: Document = { dbStats: 1 }
      if (scale) command.scale = scale
      return valueOutput(await db.command(command, base))
    }
    case 'runCommand':
    case 'adminCommand': {
      const raw = args.value(argNodes[0], 0)
      let command: Document
      if (typeof raw === 'string' && raw) command = { [raw]: 1 }
      else if (isPlainObject(raw) && Object.keys(raw).length > 0) command = raw
      else
        throw invalid(`${method}() needs a command document like { ping: 1 }`, argNodes[0]?.start)
      const target = method === 'adminCommand' ? admin : db
      return valueOutput(await target.command(command, base))
    }
    case 'aggregate':
      return runAggregate(ctx, parsed, args, (pipeline, options) => db.aggregate(pipeline, options))
    case 'getName':
      return valueOutput(db.databaseName)
    case 'version': {
      const info = await admin.command({ buildInfo: 1 }, base)
      return valueOutput(info.version)
    }
    case 'serverStatus':
      return valueOutput(
        await admin.command(
          { serverStatus: 1, ...(args.object(argNodes[0], 0, 'the options') ?? {}) },
          base
        )
      )
    case 'hostInfo':
      return valueOutput(await admin.command({ hostInfo: 1 }, base))
    case 'hello':
      return valueOutput(await admin.command({ hello: 1 }, base))
    case 'isMaster':
      return valueOutput(await admin.command({ isMaster: 1 }, base))
    case 'currentOp': {
      const arg = args.value(argNodes[0], 0)
      const all = arg === true
      const stage: Document = { $currentOp: { allUsers: true, idleConnections: all } }
      const pipeline: Document[] = [stage]
      if (isPlainObject(arg)) pipeline.push({ $match: arg })
      const plan = readPlan(undefined, ctx)
      pipeline.push({ $limit: plan.fetch })
      const cursor = admin.aggregate(pipeline, {
        ...baseRead(ctx, undefined),
        promoteValues: false
      })
      return cursorOutput(cursor, plan)
    }
    case 'killOp': {
      const raw = args.value(argNodes[0], 0)
      const op = typeof raw === 'string' ? raw : toNumberValue(raw)
      if (op === null || op === undefined || op === '')
        throw invalid('killOp() needs an operation id', argNodes[0]?.start)
      return valueOutput(await admin.command({ killOp: 1, op }, { session: ctx.session }))
    }
    default:
      throw invalid(`Unsupported database method db.${method}()`)
  }
}

type AggregateRunner = (
  pipeline: Document[],
  options: Opts
) => AbstractCursor<Document> & {
  explain(verbosity?: unknown): Promise<Document>
}

export interface AggregateSpec {
  pipeline: Document[]
  options: Opts
  terminal: 'explain' | 'itcount' | null
}

/** Pipeline, options and terminal modifier of an aggregate statement (values parsed). */
export function aggregateSpec(parsed: MongoShellParsed): AggregateSpec {
  const { structure, argNodes } = parsed
  const args = new Args(parsed, 'aggregate')
  const pipelineNode = argNodes[0]
  const pipeline = pipelineNode
    ? pipelineOf(args.array(pipelineNode, 0, 'the pipeline'), 'aggregate', pipelineNode.start)
    : []
  const options: Opts = { ...(args.object(argNodes[1], 1, 'the options') ?? {}) }
  let terminal: AggregateSpec['terminal'] = null
  structure.modifiers.forEach((name, i) => {
    const nodes = parsed.modifierArgNodes[i]
    switch (name) {
      case 'maxTimeMS':
        options.maxTimeMS = args.number(nodes[0], 0, 'maxTimeMS', name)
        break
      case 'batchSize':
        options.batchSize = args.number(nodes[0], 0, 'batch size', name)
        break
      case 'explain':
      case 'itcount':
        terminal = name
        break
      default:
        break
    }
  })
  return { pipeline, options, terminal }
}

async function runAggregate(
  ctx: MongoExecContext,
  parsed: MongoShellParsed,
  args: Args,
  run: AggregateRunner
): Promise<DriverStatementResult> {
  const { structure } = parsed
  const { pipeline, options, terminal } = aggregateSpec(parsed)

  if (structure.explain) {
    let verbosity = explainVerbosity(args, parsed.explainArgNodes)
    let explained = pipeline
    if (findMongoOutputStages(pipeline).length > 0) {
      // Never let an explain persist output (SERVER-38063): drop the stage, plan only.
      explained = pipeline.filter((stage) => !('$out' in stage) && !('$merge' in stage))
      verbosity = 'queryPlanner'
    }
    const result = await run(explained, baseRead(ctx, options)).explain(verbosity)
    return valueOutput(result)
  }

  if (terminal === 'itcount') {
    const counted = [...pipeline, { $count: 'n' }]
    const { docs } = await collectDocuments(run(counted, baseRead(ctx, options)), 1)
    return valueOutput(docs[0]?.n ?? 0)
  }

  if (pipelineEndsWithOutput(pipeline)) {
    const cursor = run(pipeline, { ...baseWrite(ctx, options), signal: ctx.signal })
    await collectDocuments(cursor, Number.MAX_SAFE_INTEGER)
    const out = findMongoOutputStages(pipeline).pop()
    return commandOutput(
      `Aggregation finished; its output was written to ${out?.target ? `"${out.target}"` : 'the target collection'}`
    )
  }

  const plan = readPlan(undefined, ctx)
  const opts = baseRead(ctx, options)
  if (opts.batchSize === undefined) opts.batchSize = Math.min(plan.fetch, 1000)
  const cursor = run([...pipeline, { $limit: plan.fetch }], { ...opts, promoteValues: false })
  return cursorOutput(cursor, plan)
}

async function runCollectionMethod(
  ctx: MongoExecContext,
  db: Db,
  collection: Collection<Document>,
  parsed: MongoShellParsed
): Promise<DriverStatementResult> {
  const { structure, argNodes } = parsed
  const method = structure.method
  const args = new Args(parsed, method)
  const name = collection.collectionName

  switch (method) {
    case 'find':
      return runFind(ctx, collection, parsed, args)
    case 'findOne': {
      const filter = args.object(argNodes[0], 0, 'the filter') ?? {}
      const projection = args.object(argNodes[1], 1, 'the projection')
      const options = args.object(argNodes[2], 2, 'the options') ?? {}
      const opts = baseRead(ctx, options)
      if (projection) opts.projection = projection
      const doc = await collection.findOne(filter, { ...opts, promoteValues: false })
      return documentsOutput(doc ? [doc] : [], null)
    }
    case 'countDocuments': {
      const filter = args.object(argNodes[0], 0, 'the filter') ?? {}
      const options = args.object(argNodes[1], 1, 'the options')
      return valueOutput(await collection.countDocuments(filter, baseRead(ctx, options)))
    }
    case 'estimatedDocumentCount': {
      const options = baseRead(ctx, args.object(argNodes[0], 0, 'the options'))
      delete options.signal
      return valueOutput(
        await raceWithAbort(collection.estimatedDocumentCount(options), ctx.signal)
      )
    }
    case 'count': {
      const filter = args.object(argNodes[0], 0, 'the filter') ?? {}
      const options = args.object(argNodes[1], 1, 'the options') ?? {}
      if (structure.explain)
        return explainCommand(ctx, db, { count: name, query: filter }, args, parsed)
      return valueOutput(await countFast(ctx, collection, filter, options))
    }
    case 'distinct': {
      const field = args.string(argNodes[0], 0, 'the field name')
      const filter = args.object(argNodes[1], 1, 'the filter') ?? {}
      const options = baseRead(ctx, args.object(argNodes[2], 2, 'the options'))
      delete options.signal
      if (structure.explain)
        return explainCommand(ctx, db, { distinct: name, key: field, query: filter }, args, parsed)
      return valueOutput(
        await raceWithAbort(collection.distinct(field, filter, options), ctx.signal)
      )
    }
    case 'aggregate':
      return runAggregate(ctx, parsed, args, (pipeline, options) =>
        collection.aggregate(pipeline, options)
      )
    case 'insertOne': {
      const doc = args.requiredObject(argNodes[0], 0, 'the document')
      const opts = baseWrite(ctx, args.object(argNodes[1], 1, 'the options'))
      const result = await raceWithAbort(collection.insertOne(doc, opts), ctx.signal)
      return valueOutput(
        writeResult(result as unknown as Record<string, unknown>, ['acknowledged', 'insertedId'])
      )
    }
    case 'insertMany': {
      const docs = args.array(argNodes[0], 0, 'the documents')
      if (docs.length === 0)
        throw invalid('insertMany(): the array of documents is empty', argNodes[0]?.start)
      for (const doc of docs) {
        if (!isPlainObject(doc))
          throw invalid('insertMany(): every element must be a document', argNodes[0]?.start)
      }
      const opts = baseWrite(ctx, args.object(argNodes[1], 1, 'the options'))
      const result = await raceWithAbort(
        collection.insertMany(docs as Document[], opts),
        ctx.signal
      )
      return valueOutput(
        writeResult(result as unknown as Record<string, unknown>, [
          'acknowledged',
          'insertedCount',
          'insertedIds'
        ])
      )
    }
    case 'updateOne':
    case 'updateMany': {
      const filter = args.requiredObject(argNodes[0], 0, 'the filter')
      const update = args.value(argNodes[1], 1)
      if (!isPlainObject(update) && !Array.isArray(update)) {
        throw invalid(
          `${method}(): the update must be an update document ({ $set: ... }) or a pipeline`,
          argNodes[1]?.start
        )
      }
      const opts = baseWrite(ctx, args.object(argNodes[2], 2, 'the options'))
      const run =
        method === 'updateOne'
          ? collection.updateOne(filter, update as Document, opts)
          : collection.updateMany(filter, update as Document, opts)
      const result = await raceWithAbort(run, ctx.signal)
      return valueOutput(
        writeResult(result as unknown as Record<string, unknown>, [
          'acknowledged',
          'matchedCount',
          'modifiedCount',
          'upsertedCount',
          'upsertedId'
        ])
      )
    }
    case 'replaceOne': {
      const filter = args.requiredObject(argNodes[0], 0, 'the filter')
      const replacement = args.requiredObject(argNodes[1], 1, 'the replacement document')
      const opts = baseWrite(ctx, args.object(argNodes[2], 2, 'the options'))
      const result = await raceWithAbort(
        collection.replaceOne(filter, replacement, opts),
        ctx.signal
      )
      return valueOutput(
        writeResult(result as unknown as Record<string, unknown>, [
          'acknowledged',
          'matchedCount',
          'modifiedCount',
          'upsertedCount',
          'upsertedId'
        ])
      )
    }
    case 'deleteOne':
    case 'deleteMany': {
      const filter = args.object(argNodes[0], 0, 'the filter')
      if (!filter && argNodes[0] && args.value(argNodes[0], 0) !== undefined) {
        throw invalid(`${method}(): the filter must be an object`, argNodes[0].start)
      }
      const opts = baseWrite(ctx, args.object(argNodes[1], 1, 'the options'))
      const run =
        method === 'deleteOne'
          ? collection.deleteOne(filter ?? {}, opts)
          : collection.deleteMany(filter ?? {}, opts)
      const result = await raceWithAbort(run, ctx.signal)
      return valueOutput(
        writeResult(result as unknown as Record<string, unknown>, ['acknowledged', 'deletedCount'])
      )
    }
    case 'findOneAndUpdate':
    case 'findOneAndReplace':
    case 'findOneAndDelete': {
      const filter = args.requiredObject(argNodes[0], 0, 'the filter')
      const optionsIndex = method === 'findOneAndDelete' ? 1 : 2
      const options: Opts = {
        ...(args.object(argNodes[optionsIndex], optionsIndex, 'the options') ?? {})
      }
      // mongosh spellings → driver options
      if (options.returnNewDocument === true || options.returnOriginal === false)
        options.returnDocument = 'after'
      delete options.returnNewDocument
      delete options.returnOriginal
      const opts = {
        ...baseWrite(ctx, options),
        includeResultMetadata: false,
        promoteValues: false
      }
      let run: Promise<unknown>
      if (method === 'findOneAndDelete') {
        run = collection.findOneAndDelete(filter, opts)
      } else if (method === 'findOneAndReplace') {
        run = collection.findOneAndReplace(
          filter,
          args.requiredObject(argNodes[1], 1, 'the replacement document'),
          opts
        )
      } else {
        const update = args.value(argNodes[1], 1)
        if (!isPlainObject(update) && !Array.isArray(update)) {
          throw invalid(
            'findOneAndUpdate(): the update must be an update document or a pipeline',
            argNodes[1]?.start
          )
        }
        run = collection.findOneAndUpdate(filter, update as Document, opts)
      }
      return valueOutput((await raceWithAbort(run, ctx.signal)) ?? null)
    }
    case 'bulkWrite': {
      const ops = args.array(argNodes[0], 0, 'the operations')
      const allowed = new Set([
        'insertOne',
        'updateOne',
        'updateMany',
        'replaceOne',
        'deleteOne',
        'deleteMany'
      ])
      for (const op of ops) {
        const keys = isPlainObject(op) ? Object.keys(op) : []
        if (keys.length !== 1 || !allowed.has(keys[0])) {
          throw invalid(
            `bulkWrite(): every operation must be one of { ${[...allowed].join(' | ')}: {...} }`,
            argNodes[0]?.start
          )
        }
      }
      const opts = baseWrite(ctx, args.object(argNodes[1], 1, 'the options'))
      const result = (await raceWithAbort(
        collection.bulkWrite(ops as never, opts),
        ctx.signal
      )) as unknown as Record<string, unknown>
      return valueOutput(
        writeResult(result, [
          'insertedCount',
          'matchedCount',
          'modifiedCount',
          'deletedCount',
          'upsertedCount',
          'insertedIds',
          'upsertedIds'
        ])
      )
    }
    case 'createIndex': {
      const keys = args.requiredObject(argNodes[0], 0, 'the index keys')
      const options: Opts = { ...(args.object(argNodes[1], 1, 'the options') ?? {}) }
      if (argNodes[2]) options.commitQuorum = args.value(argNodes[2], 2)
      const created = await raceWithAbort(
        collection.createIndex(keys as Document, baseWrite(ctx, options)),
        ctx.signal
      )
      return valueOutput(created)
    }
    case 'createIndexes': {
      const list = args.array(argNodes[0], 0, 'the list of index keys')
      const options = args.object(argNodes[1], 1, 'the options') ?? {}
      const specs = list.map((key) => {
        if (!isPlainObject(key))
          throw invalid(
            'createIndexes(): every element must be a key document like { field: 1 }',
            argNodes[0]?.start
          )
        return { key, ...options }
      })
      if (specs.length === 0)
        throw invalid('createIndexes(): the list is empty', argNodes[0]?.start)
      const commitQuorum = argNodes[2] ? args.value(argNodes[2], 2) : undefined
      const names = await raceWithAbort(
        collection.createIndexes(
          specs as never,
          baseWrite(ctx, commitQuorum !== undefined ? { commitQuorum } : undefined)
        ),
        ctx.signal
      )
      return valueOutput(names)
    }
    case 'dropIndex': {
      const indexName = await resolveIndexName(
        ctx,
        collection,
        args.value(argNodes[0], 0),
        argNodes[0]?.start
      )
      return valueOutput(
        await raceWithAbort(collection.dropIndex(indexName, baseWrite(ctx, undefined)), ctx.signal)
      )
    }
    case 'dropIndexes': {
      const raw = argNodes[0] ? args.value(argNodes[0], 0) : undefined
      if (raw === undefined || raw === '*') {
        return valueOutput(
          await raceWithAbort(collection.dropIndexes(baseWrite(ctx, undefined)), ctx.signal)
        )
      }
      const names = Array.isArray(raw) ? raw : [raw]
      const dropped: string[] = []
      for (const entry of names) {
        const indexName = await resolveIndexName(ctx, collection, entry, argNodes[0]?.start)
        await raceWithAbort(collection.dropIndex(indexName, baseWrite(ctx, undefined)), ctx.signal)
        dropped.push(indexName)
      }
      return valueOutput({ ok: 1, dropped })
    }
    case 'hideIndex':
    case 'unhideIndex': {
      const raw = args.value(argNodes[0], 0)
      const index =
        typeof raw === 'string' ? { name: raw } : isPlainObject(raw) ? { keyPattern: raw } : null
      if (!index)
        throw invalid(`${method}(): pass the index name or its key document`, argNodes[0]?.start)
      const result = await db.command(
        { collMod: name, index: { ...index, hidden: method === 'hideIndex' } },
        { session: ctx.session }
      )
      return valueOutput(result)
    }
    case 'getIndexes':
    case 'indexes': {
      const list = await raceWithAbort(
        collection.listIndexes({ session: ctx.session }).toArray(),
        ctx.signal
      )
      return documentsOutput(list, null)
    }
    case 'stats': {
      const raw = args.value(argNodes[0], 0)
      const scale = toNumberValue(isPlainObject(raw) ? raw.scale : raw)
      const storageStats: Document = {}
      if (scale) storageStats.scale = scale
      const cursor = collection.aggregate(
        [{ $collStats: { storageStats, count: {} } }],
        baseRead(ctx, undefined)
      )
      const { docs } = await collectDocuments(cursor, 1)
      return valueOutput(docs[0] ?? null)
    }
    case 'drop': {
      const dropped = await raceWithAbort(collection.drop({ session: ctx.session }), ctx.signal)
      return commandOutput(
        dropped ? `Dropped collection "${name}"` : `Collection "${name}" did not exist`
      )
    }
    case 'renameCollection': {
      const to = args.string(argNodes[0], 0, 'the new name')
      const dropTarget = args.bool(argNodes[1], 1, false)
      await raceWithAbort(collection.rename(to, { dropTarget, session: ctx.session }), ctx.signal)
      return commandOutput(`Renamed "${name}" to "${to}"`)
    }
    default:
      throw invalid(`Unsupported collection method ${method}()`)
  }
}

/** count() / cursor.count(): metadata count for an empty filter, else countDocuments. */
async function countFast(
  ctx: MongoExecContext,
  collection: Collection<Document>,
  filter: Opts,
  options: Opts
): Promise<number> {
  const opts = baseRead(ctx, options)
  const hasBounds = opts.skip !== undefined || opts.limit !== undefined
  if (Object.keys(filter).length === 0 && !hasBounds) {
    delete opts.signal
    return raceWithAbort(collection.estimatedDocumentCount(opts), ctx.signal)
  }
  return collection.countDocuments(filter, opts)
}

async function resolveIndexName(
  ctx: MongoExecContext,
  collection: Collection<Document>,
  raw: unknown,
  position?: number
): Promise<string> {
  if (typeof raw === 'string' && raw) return raw
  if (!isPlainObject(raw))
    throw invalid('Pass the index name or its key document, e.g. { createdAt: -1 }', position)
  const wanted = JSON.stringify(toCanonical(raw))
  const indexes = await collection.listIndexes({ session: ctx.session }).toArray()
  const match = indexes.find((index) => JSON.stringify(toCanonical(index.key)) === wanted)
  if (!match)
    throw invalid(
      `No index with key ${JSON.stringify(raw)} on "${collection.collectionName}"`,
      position
    )
  return String(match.name)
}

async function explainCommand(
  ctx: MongoExecContext,
  db: Db,
  command: Document,
  args: Args,
  parsed: MongoShellParsed
): Promise<DriverStatementResult> {
  const verbosity = explainVerbosity(args, parsed.explainArgNodes)
  const result = await db.command(
    { explain: command, verbosity },
    { session: ctx.session, signal: ctx.signal }
  )
  return valueOutput(result)
}

export interface FindSpec {
  filter: Document
  /** Driver find options from the projection argument, options argument and modifiers. */
  options: Opts
  /** The user's own limit (limit() modifier or options.limit), if any. */
  userLimit: number | undefined
  terminal: { name: string; nodes: MongoShellArgNode[] } | null
}

/** Filter, options, user limit and terminal modifier of a find statement (values parsed). */
export function findSpec(parsed: MongoShellParsed): FindSpec {
  const { structure, argNodes } = parsed
  const args = new Args(parsed, 'find')
  const filter = args.object(argNodes[0], 0, 'the filter') ?? {}
  const projection = args.object(argNodes[1], 1, 'the projection')
  const options: Opts = { ...(args.object(argNodes[2], 2, 'the options') ?? {}) }
  if (projection) options.projection = projection
  let userLimit =
    options.limit !== undefined ? (toNumberValue(options.limit) ?? undefined) : undefined
  delete options.limit
  let terminal: FindSpec['terminal'] = null

  structure.modifiers.forEach((name, i) => {
    const nodes = parsed.modifierArgNodes[i]
    switch (name) {
      case 'sort': {
        const sort = args.value(nodes[0], 0, name)
        if (!isPlainObject(sort) && typeof sort !== 'string' && !Array.isArray(sort)) {
          throw invalid('sort(): pass a sort document like { createdAt: -1 }', nodes[0]?.start)
        }
        options.sort = sort
        break
      }
      case 'limit':
        userLimit = args.number(nodes[0], 0, 'the limit', name)
        break
      case 'skip':
        options.skip = Math.max(0, Math.trunc(args.number(nodes[0], 0, 'the number to skip', name)))
        break
      case 'project':
      case 'projection':
        options.projection = args.requiredObject(nodes[0], 0, 'the projection', name)
        break
      case 'hint': {
        const hint = args.value(nodes[0], 0, name)
        if (typeof hint !== 'string' && !isPlainObject(hint)) {
          throw invalid('hint(): pass an index name or key document', nodes[0]?.start)
        }
        options.hint = hint
        break
      }
      case 'collation':
        options.collation = args.requiredObject(nodes[0], 0, 'the collation', name)
        break
      case 'maxTimeMS':
        options.maxTimeMS = args.number(nodes[0], 0, 'maxTimeMS', name)
        break
      case 'comment':
        options.comment = args.value(nodes[0], 0, name)
        break
      case 'batchSize':
        options.batchSize = args.number(nodes[0], 0, 'the batch size', name)
        break
      case 'allowDiskUse':
        options.allowDiskUse = args.bool(nodes[0], 0, true, name)
        break
      case 'min':
      case 'max':
        options[name] = args.requiredObject(nodes[0], 0, 'the index bound', name)
        break
      case 'returnKey':
      case 'showRecordId':
        options[name] = args.bool(nodes[0], 0, true, name)
        break
      case 'readPref':
        options.readPreference = args.string(nodes[0], 0, 'the read preference mode', name)
        break
      case 'explain':
      case 'count':
      case 'size':
      case 'itcount':
        terminal = { name, nodes }
        break
      default:
        break // toArray, pretty
    }
  })
  return { filter, options, userLimit, terminal }
}

async function runFind(
  ctx: MongoExecContext,
  collection: Collection<Document>,
  parsed: MongoShellParsed,
  args: Args
): Promise<DriverStatementResult> {
  const { structure } = parsed
  const { filter, options, userLimit, terminal } = findSpec(parsed)

  if (structure.explain) {
    const verbosity = explainVerbosity(args, parsed.explainArgNodes)
    const opts = baseRead(ctx, options)
    if (userLimit !== undefined) opts.limit = userLimit
    return valueOutput(await collection.find(filter, opts).explain(verbosity as never))
  }

  const finalTerminal = terminal
  if (finalTerminal) {
    const countOptions: Opts = {}
    for (const key of ['hint', 'collation', 'maxTimeMS', 'comment']) {
      if (options[key] !== undefined) countOptions[key] = options[key]
    }
    const applySkipLimit =
      finalTerminal.name === 'size' ||
      finalTerminal.name === 'itcount' ||
      (finalTerminal.name === 'count' && args.bool(finalTerminal.nodes[0], 0, false, 'count'))
    if (applySkipLimit) {
      if (options.skip !== undefined) countOptions.skip = options.skip
      if (userLimit !== undefined && userLimit !== 0) countOptions.limit = Math.abs(userLimit)
    }
    return valueOutput(await countFast(ctx, collection, filter, countOptions))
  }

  const plan = readPlan(userLimit, ctx)
  const opts = baseRead(ctx, options)
  opts.limit = plan.fetch
  if (opts.batchSize === undefined) opts.batchSize = Math.min(plan.fetch, 1000)
  const cursor = collection.find(filter, { ...opts, promoteValues: false })
  return cursorOutput(cursor, plan)
}

/** Strips $out/$merge stages from a pipeline (aggregation previews and explains never write). */
export function withoutOutputStages(pipeline: Document[]): Document[] {
  return pipeline.filter(
    (stage) => !isPlainMongoObject(stage) || (!('$out' in stage) && !('$merge' in stage))
  )
}
