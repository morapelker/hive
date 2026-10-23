// MongoEngineService: the structured Mongo operations behind the Documents, Aggregations,
// Indexes, Schema and Explain tabs (dataProjects.mongo.* RPCs). Text fields arrive as shell /
// EJSON text and are parsed here without eval.
//
// Safety: reads (find, read-only aggregate, previews, indexes, schema, explain) run directly
// with a default maxTimeMS. Everything that changes data or structure — document writes,
// aggregate with $out/$merge, index and collection mutations — goes through deps.evaluateSafety
// with source 'mongo', the equivalent shell text as the statement shown in the dialog, the
// collection (or index / database) as the type-to-confirm target, and a fingerprint built from
// the request's own text fields. The fingerprint is deliberately NOT built from parsed values:
// ObjectId() / ISODate() without arguments yield new values on every parse, and the confirm
// token must match the exact request the user saw.

import { tokenizer, tokTypes } from 'acorn'
import type { CollationOptions, IndexSpecification } from 'mongodb'
import {
  DATA_ERROR_CODES,
  DATA_HARD_ROW_CAP,
  type DataHistoryEntry,
  type DataStatementClass,
  type MongoAggregateRequest,
  type MongoAggregateResponse,
  type MongoCollectionMutationRequest,
  type MongoCollectionMutationResponse,
  type MongoCreateIndexRequest,
  type MongoDropIndexRequest,
  type MongoExplainRequest,
  type MongoExplainResponse,
  type MongoFindRequest,
  type MongoFindResponse,
  type MongoIndexInfo,
  type MongoIndexMutationResponse,
  type MongoSchemaRequest,
  type MongoSchemaResponse,
  type MongoWriteRequest,
  type MongoWriteResponse
} from '../../../../shared/data-projects/types'
import {
  MONGO_DANGER,
  findMongoOutputStages,
  findMongoServerJs,
  isEmptyMongoFilter
} from '../../../../shared/data-projects/mongo-shell'
import {
  DataDriverError,
  type DataCallContext,
  type DataProjectRecord,
  type EvaluateSafety,
  type MongoEngineService,
  type SafetyDecision
} from '../contracts'
import type { MongoDriver, MongoOperationHandle } from './driver'
import { MONGO_MAX_RESULT_BYTES, collectDocuments, withoutOutputStages } from './executor'
import { summarizeExplain } from './explain'
import {
  isPlainObject,
  loadMongoRuntime,
  parseShellHint,
  parseShellObject,
  parseShellValue,
  toCanonical,
  toNumberValue
} from './runtime'
import { analyzeMongoDocuments } from './schema'

export interface MongoServiceDeps {
  /** Throws a DATA_NOT_FOUND-coded error for unknown ids. */
  getRecord(id: string): DataProjectRecord
  /** The project's connected driver. */
  getDriver(id: string): Promise<MongoDriver>
  evaluateSafety: EvaluateSafety
  /** Makes `dataProjects.query.cancel(queryId)` reach this operation; returns the unregister fn. */
  registerQuery(queryId: string, clientId: string | null, cancel: () => Promise<void>): () => void
  recordHistory(entry: Omit<DataHistoryEntry, 'id'>): void
}

type Document = Record<string, unknown>

const DEFAULT_SCHEMA_SAMPLE = 1000
const MAX_SCHEMA_SAMPLE = 10_000
/** countDocuments for "1–20 of N" must not hold the page up for long. */
const COUNT_TIMEOUT_MS = 5000

const invalid = (message: string): DataDriverError =>
  new DataDriverError(message, { code: DATA_ERROR_CODES.invalidInput })

const coll = (name: string): string => `db.getCollection(${JSON.stringify(name)})`

/**
 * True when the text ends inside a `// line comment`. Text that does not tokenize counts when
 * its last line has any `//` (an extra line break is harmless; a swallowed `)` is not).
 */
function endsInLineComment(text: string): boolean {
  // A line comment that runs to the end starts on the last line.
  if (!text.slice(text.lastIndexOf('\n') + 1).includes('//')) return false
  let trailing = false
  try {
    const tokens = tokenizer(text, {
      ecmaVersion: 'latest',
      onComment: (block, _text, _start, end) => {
        if (!block && end === text.length) trailing = true
      }
    })
    let token = tokens.getToken()
    while (token.type !== tokTypes.eof) token = tokens.getToken()
  } catch {
    return true
  }
  return trailing
}

/**
 * A user-typed fragment (filter, pipeline, document…) as an argument of the shell text shown in
 * confirm dialogs and recorded in history: a trailing `// comment` would swallow the `,` or `)`
 * after it on its line (the request itself parses fine: the parser wraps fragments in newlines),
 * so the line ends after it.
 */
const shellArg = (text: string): string => {
  const trimmed = text.trim()
  return endsInLineComment(trimmed) ? `${trimmed}\n` : trimmed
}
const textOr = (text: string | undefined, fallback: string): string =>
  text?.trim() ? shellArg(text) : fallback

function requireName(value: string | undefined, what: string): string {
  const name = value?.trim()
  if (!name) throw invalid(`${what} is required`)
  return name
}

function parsePipeline(text: string): Document[] {
  const value = parseShellValue(text, 'Pipeline')
  if (value === undefined) return []
  if (!Array.isArray(value))
    throw invalid('Pipeline must be an array of stages: [{ $match: {...} }, ...]')
  value.forEach((stage, i) => {
    if (!isPlainObject(stage) || Object.keys(stage).length === 0) {
      throw invalid(`Pipeline stage ${i + 1} must be an object like { $match: {...} }`)
    }
  })
  return value as Document[]
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return fallback
  return Math.min(Math.trunc(limit), DATA_HARD_ROW_CAP)
}

/** A Documents page over the byte budget: it is refused rather than shown short. */
const pageTooLarge = (pageSize: number): DataDriverError =>
  new DataDriverError(
    `These documents are too large to show ${pageSize} per page (over ${MONGO_MAX_RESULT_BYTES / 1024 / 1024} MB). Choose a smaller page size, or add a projection that leaves out the large fields.`,
    { code: 'ResultTooLarge' }
  )

const isMaxTimeExpired = (error: unknown): boolean =>
  (error as { code?: number }).code === 50 ||
  (error as { codeName?: string }).codeName === 'MaxTimeMSExpired'

export function createMongoEngineService(deps: MongoServiceDeps): MongoEngineService {
  interface Gate {
    record: DataProjectRecord
    database: string
    text: string
    classification: DataStatementClass
    dangerous: string[]
    targets: string[]
    fingerprint: unknown[]
    confirmToken?: string
  }

  /** Runs the safety gate for one mutation; returns the decision. */
  function gate(input: Gate): SafetyDecision {
    return deps.evaluateSafety({
      project: input.record,
      database: input.database,
      source: 'mongo',
      statements: [
        {
          index: 0,
          text: input.text,
          start: 0,
          end: input.text.length,
          classification: input.classification,
          dangerous: input.dangerous,
          targets: input.targets
        }
      ],
      fingerprintText: JSON.stringify(input.fingerprint),
      confirmToken: input.confirmToken
    })
  }

  function history(
    record: DataProjectRecord,
    database: string,
    text: string,
    status: DataHistoryEntry['status'],
    started: number,
    rowCount: number | null,
    error: string | null
  ): void {
    try {
      deps.recordHistory({
        dataProjectId: record.id,
        database,
        text,
        status,
        durationMs: status === 'blocked' ? null : Date.now() - started,
        rowCount,
        error,
        executedAt: new Date().toISOString()
      })
    } catch {
      // History is best effort: never fail the operation because of it.
    }
  }

  /** Runs `work` as a cancellable operation registered under `queryId`. */
  async function cancellable<T>(
    driver: MongoDriver,
    queryId: string | null,
    clientId: string | null,
    work: (op: MongoOperationHandle) => Promise<T>
  ): Promise<T> {
    const op = await driver.startOperation()
    const unregister = queryId
      ? deps.registerQuery(queryId, clientId, () => op.cancel())
      : () => undefined
    try {
      return await work(op)
    } catch (error) {
      throw driver.toError(error, { cancelled: op.cancelled })
    } finally {
      unregister()
      await op.end()
    }
  }

  /**
   * Runs a gated mutation and records history. Returns the gate's answer when it did not run,
   * else `{ status: 'ok', ...result, durationMs }`; R is the RPC response union.
   */
  async function mutate<R>(
    g: Gate,
    run: () => Promise<{ result: Record<string, unknown>; rowCount: number | null }>
  ): Promise<R> {
    const decision = gate(g)
    if (decision.action === 'confirm') {
      return {
        status: 'confirmation_required',
        plan: decision.plan,
        confirmToken: decision.confirmToken
      } as R
    }
    if (decision.action === 'block') {
      history(g.record, g.database, g.text, 'blocked', Date.now(), null, decision.reason)
      return { status: 'blocked', plan: decision.plan, reason: decision.reason } as R
    }
    const started = Date.now()
    try {
      const { result, rowCount } = await run()
      history(g.record, g.database, g.text, 'ok', started, rowCount, null)
      return { status: 'ok', ...result, durationMs: Date.now() - started } as R
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      history(g.record, g.database, g.text, 'error', started, null, message)
      throw error
    }
  }

  // ---- find -----------------------------------------------------------------------------------

  async function find(req: MongoFindRequest, ctx: DataCallContext): Promise<MongoFindResponse> {
    // Shell/EJSON parsing needs the lazily loaded BSON runtime, even before any connect.
    await loadMongoRuntime()
    const record = deps.getRecord(req.dataProjectId)
    const database = requireName(req.database, 'Database')
    const collection = requireName(req.collection, 'Collection')
    const filter = parseShellObject(req.filter, 'Filter') ?? {}
    const projection = parseShellObject(req.projection, 'Projection')
    const sort = parseShellObject(req.sort, 'Sort')
    const collation = parseShellObject(req.collation, 'Collation')
    const hint = parseShellHint(req.hint)
    const limit = clampLimit(req.limit, 20)
    const skip = req.skip && req.skip > 0 ? Math.trunc(req.skip) : 0
    const driver = await deps.getDriver(req.dataProjectId)
    const maxTimeMS = req.maxTimeMS && req.maxTimeMS > 0 ? req.maxTimeMS : driver.readTimeoutMs
    const started = Date.now()
    const historyText = findShellText(req, limit)
    // Plain browsing (first page, no query) is not history; a typed query or refresh of one is.
    const recordable =
      !skip &&
      [req.filter, req.projection, req.sort, req.collation, req.hint].some(
        (t) => !!t?.trim() && t.trim() !== '{}'
      )
    try {
      const response = await cancellable(driver, req.queryId, ctx.clientId, async (op) => {
        const client = await driver.getClient()
        const c = client.db(database).collection(collection)
        const options: Document = {
          comment: op.tag,
          session: op.session,
          signal: op.signal,
          maxTimeMS,
          limit: limit + 1,
          batchSize: Math.min(limit + 1, 1000),
          promoteValues: false
        }
        if (projection) options.projection = projection
        if (sort) options.sort = sort
        if (collation) options.collation = collation
        if (hint) options.hint = hint
        if (skip) options.skip = skip
        const docsPromise = collectDocuments(c.find(filter, options), limit + 1)
        const countOptions = {
          maxTimeMS: Math.min(maxTimeMS, COUNT_TIMEOUT_MS),
          comment: op.tag,
          ...(collation ? { collation: collation as unknown as CollationOptions } : {}),
          ...(hint ? { hint } : {})
        }
        const exactCount = (): Promise<number> =>
          c.countDocuments(filter, { ...countOptions, signal: op.signal })
        // The count never fails the page (slow count, view without metadata count, missing
        // privilege...): the UI then shows "N+" / no total.
        const countPromise: Promise<number | null> = req.withCount
          ? (Object.keys(filter).length === 0 && !hint
              ? c
                  .estimatedDocumentCount({ maxTimeMS: countOptions.maxTimeMS, comment: op.tag })
                  .catch((error) => {
                    if (isMaxTimeExpired(error) || op.cancelled) throw error
                    return exactCount() // views have no metadata count
                  })
              : exactCount()
            ).catch(() => null)
          : Promise.resolve(null)
        const [{ docs, byteLimited }, count] = await Promise.all([docsPromise, countPromise])
        // Pages sit at skip + p·size: a short page would make the next one skip documents.
        if (byteLimited && docs.length < limit) throw pageTooLarge(limit)
        const truncated = docs.length > limit || byteLimited
        return {
          documents: (truncated ? docs.slice(0, limit) : docs).map((doc) =>
            toCanonical<Document>(doc)
          ),
          truncated,
          count,
          durationMs: Date.now() - started
        }
      })
      if (recordable) {
        history(record, database, historyText, 'ok', started, response.documents.length, null)
      }
      return response
    } catch (error) {
      const mapped = driver.toError(error)
      if (recordable)
        history(
          record,
          database,
          historyText,
          mapped.cancelled ? 'cancelled' : 'error',
          started,
          null,
          mapped.message
        )
      throw mapped
    }
  }

  // ---- aggregate ------------------------------------------------------------------------------

  async function aggregate(
    req: MongoAggregateRequest,
    ctx: DataCallContext
  ): Promise<MongoAggregateResponse> {
    // Shell/EJSON parsing needs the lazily loaded BSON runtime, even before any connect.
    await loadMongoRuntime()
    const record = deps.getRecord(req.dataProjectId)
    const database = requireName(req.database, 'Database')
    const collection = requireName(req.collection, 'Collection')
    const pipeline = parsePipeline(req.pipeline)
    const preview = req.stageIndex !== undefined && req.stageIndex !== null
    const limit = clampLimit(req.limit, 20)
    const text = `${coll(collection)}.aggregate(${textOr(req.pipeline, '[]')}${req.allowDiskUse ? ', { allowDiskUse: true }' : ''})`
    const driver = await deps.getDriver(req.dataProjectId)
    const maxTimeMS = req.maxTimeMS && req.maxTimeMS > 0 ? req.maxTimeMS : driver.readTimeoutMs

    let stages = pipeline
    if (preview) {
      const index = Math.max(0, Math.min(Math.trunc(req.stageIndex as number), pipeline.length - 1))
      // A stage preview never writes: $out/$merge are dropped (anywhere at top level).
      stages = withoutOutputStages(pipeline.slice(0, index + 1)) as Document[]
    }
    const outputs = preview ? [] : findMongoOutputStages(stages)

    const runRead = async (): Promise<MongoAggregateResponse> => {
      const started = Date.now()
      try {
        const response = await cancellable(driver, req.queryId, ctx.clientId, async (op) => {
          const client = await driver.getClient()
          const cursor = client
            .db(database)
            .collection(collection)
            .aggregate([...stages, { $limit: limit + 1 }], {
              comment: op.tag,
              session: op.session,
              signal: op.signal,
              maxTimeMS,
              allowDiskUse: req.allowDiskUse ?? true,
              batchSize: Math.min(limit + 1, 1000),
              promoteValues: false
            })
          // The byte budget may stop it early: then it shows fewer documents, marked truncated.
          const { docs, byteLimited } = await collectDocuments(cursor, limit + 1)
          const truncated = docs.length > limit || byteLimited
          return {
            status: 'ok' as const,
            documents: (truncated ? docs.slice(0, limit) : docs).map((doc) =>
              toCanonical<Document>(doc)
            ),
            truncated,
            durationMs: Date.now() - started
          }
        })
        if (!preview)
          history(record, database, text, 'ok', started, response.documents.length, null)
        return response
      } catch (error) {
        const mapped = driver.toError(error)
        if (mapped.cancelled) {
          if (!preview) history(record, database, text, 'cancelled', started, null, null)
          return { status: 'cancelled' }
        }
        if (!preview) history(record, database, text, 'error', started, null, mapped.message)
        throw mapped
      }
    }

    if (outputs.length === 0) return runRead()

    // $out / $merge: a write, gated like any other.
    const dangerous = outputs.map((o) =>
      o.stage === '$out' ? MONGO_DANGER.out(o.target) : MONGO_DANGER.merge(o.target)
    )
    for (const operator of findMongoServerJs(stages))
      dangerous.push(MONGO_DANGER.serverJs(operator))
    const decision = gate({
      record,
      database,
      text,
      classification: 'write',
      dangerous,
      targets: outputs.map((o) => o.target).filter((t): t is string => !!t),
      fingerprint: [
        'mongo.aggregate',
        database,
        collection,
        req.pipeline,
        req.allowDiskUse ?? null
      ],
      confirmToken: req.confirmToken
    })
    if (decision.action === 'confirm') {
      return {
        status: 'confirmation_required',
        plan: decision.plan,
        confirmToken: decision.confirmToken
      }
    }
    if (decision.action === 'block') {
      history(record, database, text, 'blocked', Date.now(), null, decision.reason)
      return { status: 'blocked', plan: decision.plan, reason: decision.reason }
    }
    const started = Date.now()
    try {
      await cancellable(driver, req.queryId, ctx.clientId, async (op) => {
        const client = await driver.getClient()
        const options: Document = {
          comment: op.tag,
          session: op.session,
          signal: op.signal,
          allowDiskUse: req.allowDiskUse ?? true
        }
        if (req.maxTimeMS && req.maxTimeMS > 0) options.maxTimeMS = req.maxTimeMS
        else if (driver.writeTimeoutMs) options.maxTimeMS = driver.writeTimeoutMs
        await client.db(database).collection(collection).aggregate(stages, options).toArray()
      })
      history(record, database, text, 'ok', started, null, null)
      return { status: 'ok', documents: [], truncated: false, durationMs: Date.now() - started }
    } catch (error) {
      const mapped = driver.toError(error)
      if (mapped.cancelled) {
        history(record, database, text, 'cancelled', started, null, null)
        return { status: 'cancelled' }
      }
      history(record, database, text, 'error', started, null, mapped.message)
      throw mapped
    }
  }

  // ---- write ----------------------------------------------------------------------------------

  async function write(req: MongoWriteRequest, _ctx: DataCallContext): Promise<MongoWriteResponse> {
    // Shell/EJSON parsing needs the lazily loaded BSON runtime, even before any connect.
    await loadMongoRuntime()
    const record = deps.getRecord(req.dataProjectId)
    const database = requireName(req.database, 'Database')
    const collection = requireName(req.collection, 'Collection')
    const op = req.op
    // Parse and validate before asking for confirmation: never confirm something that cannot run.
    const needsFilter = op !== 'insertOne' && op !== 'insertMany'
    const filterValue = needsFilter ? parseShellObject(req.filter, 'Filter') : undefined
    // The query bar's collation decides which documents the filter matches (and the count the
    // dialog showed); inserts match nothing, so it does not apply to them.
    const collation = needsFilter ? parseShellObject(req.collation, 'Collation') : undefined
    if (collation && (typeof collation.locale !== 'string' || !collation.locale.trim()))
      throw invalid("Collation needs a locale, e.g. { locale: 'en', strength: 2 }")
    let documentValue: unknown
    let updateValue: unknown
    switch (op) {
      case 'insertOne':
      case 'replaceOne': {
        documentValue = parseShellValue(req.document ?? '', 'Document')
        if (!isPlainObject(documentValue))
          throw invalid('Document must be an object like { field: value }')
        if (op === 'replaceOne' && Object.keys(documentValue).some((key) => key.startsWith('$'))) {
          throw invalid(
            'A replacement document cannot contain update operators ($set...); use Update instead'
          )
        }
        break
      }
      case 'insertMany': {
        documentValue = parseShellValue(req.document ?? '', 'Documents')
        if (!Array.isArray(documentValue) || documentValue.length === 0)
          throw invalid('Documents must be a non-empty array')
        if (documentValue.some((doc) => !isPlainObject(doc)))
          throw invalid('Every element of Documents must be an object')
        break
      }
      case 'updateOne':
      case 'updateMany': {
        updateValue = parseShellValue(req.update ?? '', 'Update')
        if (Array.isArray(updateValue)) {
          if (updateValue.length === 0 || updateValue.some((stage) => !isPlainObject(stage))) {
            throw invalid('An update pipeline must be a non-empty array of stages')
          }
        } else if (!isPlainObject(updateValue) || Object.keys(updateValue).length === 0) {
          throw invalid(
            'Update must be an update document like { $set: { field: value } } or a pipeline'
          )
        } else if (Object.keys(updateValue).some((key) => !key.startsWith('$'))) {
          throw invalid(
            'Update documents may only contain operators ($set, $unset, $inc...); use Replace to overwrite'
          )
        }
        break
      }
      case 'deleteOne':
      case 'deleteMany':
        break
      default:
        throw invalid(`Unsupported write operation ${String(op)}`)
    }

    const dangerous: string[] = []
    if (op === 'deleteMany' && isEmptyMongoFilter(filterValue))
      dangerous.push(MONGO_DANGER.deleteManyAll(collection))
    if (op === 'updateMany' && isEmptyMongoFilter(filterValue))
      dangerous.push(MONGO_DANGER.updateManyAll(collection))
    for (const operator of findMongoServerJs([filterValue, updateValue]))
      dangerous.push(MONGO_DANGER.serverJs(operator))

    const filterText = textOr(req.filter, '{}')
    const optionTexts: string[] = []
    if (req.upsert && (op === 'updateOne' || op === 'updateMany' || op === 'replaceOne'))
      optionTexts.push('upsert: true')
    if (collation) optionTexts.push(`collation: ${textOr(req.collation, '{}')}`)
    const optionsText = optionTexts.length > 0 ? `, { ${optionTexts.join(', ')} }` : ''
    const text =
      op === 'insertOne' || op === 'insertMany'
        ? `${coll(collection)}.${op}(${textOr(req.document, op === 'insertMany' ? '[]' : '{}')})`
        : op === 'replaceOne'
          ? `${coll(collection)}.replaceOne(${filterText}, ${textOr(req.document, '{}')}${optionsText})`
          : op === 'updateOne' || op === 'updateMany'
            ? `${coll(collection)}.${op}(${filterText}, ${textOr(req.update, '{}')}${optionsText})`
            : `${coll(collection)}.${op}(${filterText}${optionsText})`

    const driver = await deps.getDriver(req.dataProjectId)
    return mutate<MongoWriteResponse>(
      {
        record,
        database,
        text,
        classification: 'write',
        dangerous,
        targets: [collection],
        fingerprint: [
          'mongo.write',
          database,
          collection,
          op,
          req.filter ?? null,
          req.document ?? null,
          req.update ?? null,
          req.upsert === true,
          collation ? (req.collation ?? null) : null
        ],
        confirmToken: req.confirmToken
      },
      async () => {
        const client = await driver.getClient()
        const c = client.db(database).collection(collection)
        const options: Document = { comment: `tedooo:write` }
        if (driver.writeTimeoutMs) options.maxTimeMS = driver.writeTimeoutMs
        if (collation) options.collation = collation
        try {
          switch (op) {
            case 'insertOne': {
              const r = await c.insertOne(documentValue as Document, options)
              return { result: { insertedCount: r.acknowledged ? 1 : 0 }, rowCount: 1 }
            }
            case 'insertMany': {
              const r = await c.insertMany(documentValue as Document[], options)
              return { result: { insertedCount: r.insertedCount }, rowCount: r.insertedCount }
            }
            case 'replaceOne': {
              // The filter is used as given: the document editor sends the whole original
              // document, so matchedCount 0 means "changed (or deleted) since it was loaded".
              const r = await c.replaceOne(filterValue ?? {}, documentValue as Document, {
                ...options,
                upsert: req.upsert === true
              })
              return {
                result: {
                  matchedCount: r.matchedCount,
                  modifiedCount: r.modifiedCount,
                  ...(r.upsertedId ? { upsertedId: toCanonical(r.upsertedId) } : {})
                },
                rowCount: r.modifiedCount + r.upsertedCount
              }
            }
            case 'updateOne':
            case 'updateMany': {
              const update = updateValue as Document | Document[]
              const opts = { ...options, upsert: req.upsert === true }
              const r =
                op === 'updateOne'
                  ? await c.updateOne(filterValue ?? {}, update, opts)
                  : await c.updateMany(filterValue ?? {}, update, opts)
              return {
                result: {
                  matchedCount: r.matchedCount,
                  modifiedCount: r.modifiedCount,
                  ...(r.upsertedId ? { upsertedId: toCanonical(r.upsertedId) } : {})
                },
                rowCount: r.modifiedCount + r.upsertedCount
              }
            }
            case 'deleteOne':
            case 'deleteMany': {
              const r =
                op === 'deleteOne'
                  ? await c.deleteOne(filterValue ?? {}, options)
                  : await c.deleteMany(filterValue ?? {}, options)
              return { result: { deletedCount: r.deletedCount }, rowCount: r.deletedCount }
            }
          }
        } catch (error) {
          throw driver.toError(error)
        }
        throw invalid(`Unsupported write operation ${String(op)}`)
      }
    )
  }

  // ---- indexes --------------------------------------------------------------------------------

  async function indexes(
    id: string,
    database: string,
    collection: string
  ): Promise<MongoIndexInfo[]> {
    await loadMongoRuntime()
    deps.getRecord(id)
    const driver = await deps.getDriver(id)
    const client = await driver.getClient()
    const c = client
      .db(requireName(database, 'Database'))
      .collection(requireName(collection, 'Collection'))
    let list: Document[]
    try {
      list = await c.listIndexes().toArray()
    } catch (error) {
      const code = (error as { code?: number }).code
      if (code === 26 || code === 166) return [] // NamespaceNotFound / CommandNotSupportedOnView
      throw driver.toError(error)
    }
    const [sizes, accesses] = await Promise.all([
      c
        .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: 10_000 })
        .toArray()
        .then(
          (docs) => ((docs[0]?.storageStats as Document | undefined)?.indexSizes ?? {}) as Document
        )
        .catch(() => ({}) as Document),
      c
        .aggregate([{ $indexStats: {} }], { maxTimeMS: 10_000 })
        .toArray()
        .then((docs) => {
          const map = new Map<string, number>()
          for (const doc of docs) {
            const ops = toNumberValue((doc.accesses as Document | undefined)?.ops)
            if (typeof doc.name === 'string' && ops !== null)
              map.set(doc.name, (map.get(doc.name) ?? 0) + ops)
          }
          return map
        })
        .catch(() => new Map<string, number>())
    ])
    return list.map((index) => {
      const name = String(index.name)
      const ttl = toNumberValue(index.expireAfterSeconds)
      return {
        name,
        keys: toCanonical<Document>(index.key ?? {}),
        unique: index.unique === true || name === '_id_',
        sparse: index.sparse === true,
        hidden: index.hidden === true,
        ttlSeconds: ttl,
        partialFilterExpression: isPlainObject(index.partialFilterExpression)
          ? toCanonical<Document>(index.partialFilterExpression)
          : null,
        sizeBytes: toNumberValue(sizes[name]),
        accesses: accesses.has(name) ? (accesses.get(name) as number) : null
      }
    })
  }

  async function createIndex(req: MongoCreateIndexRequest): Promise<MongoIndexMutationResponse> {
    // Shell/EJSON parsing needs the lazily loaded BSON runtime, even before any connect.
    await loadMongoRuntime()
    const record = deps.getRecord(req.dataProjectId)
    const database = requireName(req.database, 'Database')
    const collection = requireName(req.collection, 'Collection')
    const keys = parseShellObject(req.keys, 'Index keys')
    if (!keys || Object.keys(keys).length === 0)
      throw invalid('Index keys are required, e.g. { createdAt: -1 }')
    const options = parseShellObject(req.options, 'Index options') ?? {}
    const text = `${coll(collection)}.createIndex(${shellArg(req.keys)}${req.options?.trim() ? `, ${shellArg(req.options)}` : ''})`
    const driver = await deps.getDriver(req.dataProjectId)
    return mutate<MongoIndexMutationResponse>(
      {
        record,
        database,
        text,
        classification: 'ddl',
        dangerous: [],
        targets: [collection],
        fingerprint: ['mongo.createIndex', database, collection, req.keys, req.options ?? null],
        confirmToken: req.confirmToken
      },
      async () => {
        const client = await driver.getClient()
        try {
          const name = await client
            .db(database)
            .collection(collection)
            .createIndex(keys as IndexSpecification, { ...options, comment: 'tedooo:createIndex' })
          driver.invalidateSchemaCache(database)
          return { result: { name }, rowCount: null }
        } catch (error) {
          throw driver.toError(error)
        }
      }
    )
  }

  async function dropIndex(req: MongoDropIndexRequest): Promise<MongoIndexMutationResponse> {
    // Shell/EJSON parsing needs the lazily loaded BSON runtime, even before any connect.
    await loadMongoRuntime()
    const record = deps.getRecord(req.dataProjectId)
    const database = requireName(req.database, 'Database')
    const collection = requireName(req.collection, 'Collection')
    const name = requireName(req.name, 'Index name')
    if (name === '_id_') throw invalid('The _id index cannot be dropped')
    const text = `${coll(collection)}.dropIndex(${JSON.stringify(name)})`
    const driver = await deps.getDriver(req.dataProjectId)
    return mutate<MongoIndexMutationResponse>(
      {
        record,
        database,
        text,
        classification: 'ddl',
        dangerous: [MONGO_DANGER.dropIndex(name, collection)],
        targets: [name],
        fingerprint: ['mongo.dropIndex', database, collection, name],
        confirmToken: req.confirmToken
      },
      async () => {
        const client = await driver.getClient()
        try {
          await client
            .db(database)
            .collection(collection)
            .dropIndex(name, { comment: 'tedooo:dropIndex' })
          return { result: { name }, rowCount: null }
        } catch (error) {
          throw driver.toError(error)
        }
      }
    )
  }

  // ---- schema / explain -------------------------------------------------------------------------

  async function schema(req: MongoSchemaRequest): Promise<MongoSchemaResponse> {
    // Shell/EJSON parsing needs the lazily loaded BSON runtime, even before any connect.
    await loadMongoRuntime()
    deps.getRecord(req.dataProjectId)
    const database = requireName(req.database, 'Database')
    const collection = requireName(req.collection, 'Collection')
    const size = Math.max(
      1,
      Math.min(Math.trunc(req.sampleSize ?? DEFAULT_SCHEMA_SAMPLE), MAX_SCHEMA_SAMPLE)
    )
    const driver = await deps.getDriver(req.dataProjectId)
    try {
      const client = await driver.getClient()
      const c = client.db(database).collection(collection)
      const [docs, count, info] = await Promise.all([
        driver.sampleDocuments(database, collection, size, driver.readTimeoutMs),
        c.estimatedDocumentCount({ maxTimeMS: 10_000 }).catch(() => null),
        driver.collectionInfo(database, collection).catch(() => null)
      ])
      const options = (info?.options ?? {}) as Document
      return {
        fields: analyzeMongoDocuments(docs),
        sampleSize: docs.length,
        count,
        validator: isPlainObject(options.validator)
          ? toCanonical<Document>(options.validator)
          : null
      }
    } catch (error) {
      throw driver.toError(error)
    }
  }

  async function explain(req: MongoExplainRequest): Promise<MongoExplainResponse> {
    // Shell/EJSON parsing needs the lazily loaded BSON runtime, even before any connect.
    await loadMongoRuntime()
    deps.getRecord(req.dataProjectId)
    const database = requireName(req.database, 'Database')
    const collection = requireName(req.collection, 'Collection')
    const driver = await deps.getDriver(req.dataProjectId)
    const client = await driver.getClient()
    const c = client.db(database).collection(collection)
    const maxTimeMS = driver.readTimeoutMs
    try {
      let raw: Document
      if (req.pipeline !== undefined && req.pipeline.trim()) {
        const pipeline = parsePipeline(req.pipeline)
        const hasOutput = findMongoOutputStages(pipeline).length > 0
        // executionStats would run the pipeline; never with $out/$merge (SERVER-38063).
        raw = (await c
          .aggregate(withoutOutputStages(pipeline), { maxTimeMS, comment: 'tedooo:explain' })
          .explain(hasOutput ? 'queryPlanner' : 'executionStats')) as Document
      } else {
        const f: Partial<NonNullable<MongoExplainRequest['find']>> = req.find ?? {}
        const filter = parseShellObject(f.filter, 'Filter') ?? {}
        const options: Document = { maxTimeMS, comment: 'tedooo:explain' }
        const projection = parseShellObject(f.projection, 'Projection')
        const sort = parseShellObject(f.sort, 'Sort')
        const hint = parseShellHint(f.hint)
        // The query bar's collation changes which index can serve the query: explain with it.
        const collation = parseShellObject(f.collation, 'Collation')
        if (projection) options.projection = projection
        if (sort) options.sort = sort
        if (hint) options.hint = hint
        if (collation) options.collation = collation
        if (f.skip && f.skip > 0) options.skip = Math.trunc(f.skip)
        if (f.limit && f.limit > 0) options.limit = Math.trunc(f.limit)
        raw = (await c.find(filter, options).explain('executionStats')) as Document
      }
      return { summary: summarizeExplain(raw), raw: toCanonical<Document>(raw) }
    } catch (error) {
      throw driver.toError(error)
    }
  }

  // ---- collections ----------------------------------------------------------------------------

  async function collectionMutation(
    req: MongoCollectionMutationRequest
  ): Promise<MongoCollectionMutationResponse> {
    // Shell/EJSON parsing needs the lazily loaded BSON runtime, even before any connect.
    await loadMongoRuntime()
    const record = deps.getRecord(req.dataProjectId)
    const database = requireName(req.database, 'Database')
    const action = req.action
    let text: string
    let dangerous: string[] = []
    let targets: string[]
    let options: Document | undefined
    switch (action.kind) {
      case 'create': {
        const name = requireName(action.collection, 'Collection name')
        options = parseShellObject(action.options, 'Collection options')
        text = `db.createCollection(${JSON.stringify(name)}${action.options?.trim() ? `, ${shellArg(action.options)}` : ''})`
        targets = [name]
        break
      }
      case 'drop': {
        const name = requireName(action.collection, 'Collection name')
        text = `${coll(name)}.drop()`
        dangerous = [MONGO_DANGER.drop(name)]
        targets = [name]
        break
      }
      case 'rename': {
        const name = requireName(action.collection, 'Collection name')
        const to = requireName(action.to, 'New name')
        text = `${coll(name)}.renameCollection(${JSON.stringify(to)})`
        targets = [name]
        break
      }
      case 'dropDatabase':
        text = `db.getSiblingDB(${JSON.stringify(database)}).dropDatabase()`
        dangerous = [MONGO_DANGER.dropDatabase(database)]
        targets = [database]
        break
      default:
        throw invalid('Unknown collection action')
    }
    const driver = await deps.getDriver(req.dataProjectId)
    return mutate<MongoCollectionMutationResponse>(
      {
        record,
        database,
        text,
        classification: 'ddl',
        dangerous,
        targets,
        fingerprint: ['mongo.collection', database, action],
        confirmToken: req.confirmToken
      },
      async () => {
        const client = await driver.getClient()
        const db = client.db(database)
        try {
          switch (action.kind) {
            case 'create':
              await db.createCollection(action.collection.trim(), options ?? {})
              break
            case 'drop':
              await db.collection(action.collection.trim()).drop()
              break
            case 'rename':
              await db
                .collection(action.collection.trim())
                .rename(action.to.trim(), { dropTarget: false })
              break
            case 'dropDatabase':
              await db.dropDatabase()
              break
          }
        } catch (error) {
          throw driver.toError(error)
        }
        driver.invalidateSchemaCache(database)
        return { result: {}, rowCount: null }
      }
    )
  }

  return {
    find,
    aggregate,
    write,
    indexes,
    createIndex,
    dropIndex,
    schema,
    explain,
    collection: collectionMutation
  }
}

/** History / plan text of a find request, in shell syntax. */
function findShellText(req: MongoFindRequest, limit: number): string {
  let text = `${coll(req.collection)}.find(${textOr(req.filter, '{}')}${req.projection?.trim() ? `, ${shellArg(req.projection)}` : ''})`
  if (req.sort?.trim()) text += `.sort(${shellArg(req.sort)})`
  if (req.collation?.trim()) text += `.collation(${shellArg(req.collation)})`
  if (req.hint?.trim()) {
    const hint = req.hint.trim()
    text += `.hint(${/^[\w.$-]+$/.test(hint) ? JSON.stringify(hint) : shellArg(hint)})`
  }
  if (req.skip && req.skip > 0) text += `.skip(${Math.trunc(req.skip)})`
  text += `.limit(${limit})`
  if (req.maxTimeMS && req.maxTimeMS > 0) text += `.maxTimeMS(${Math.trunc(req.maxTimeMS)})`
  return text
}
