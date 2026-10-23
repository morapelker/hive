// Context-aware completion for mongosh-style text, as pure functions so it can be tested
// without an editor. Two steps:
//
// 1. analyzeMongoCompletion(textBeforeCursor) finds the completion *site* with the forgiving
//    lexer and a bracket stack: after `db.` (collections + database methods), after
//    `db.<coll>.` (collection methods), after `…find(…).` (cursor methods for that method),
//    `use ` / `show `, or inside the arguments of a call — then which method, which argument,
//    the key path from the argument down to the cursor (`['[]', '$match', 'age']`), key or
//    value position and whether the cursor sits inside quotes.
// 2. mongoCompletionItems(site, data) turns the site into options: field paths from the
//    completion schema in key position, query operators inside `{ field: { … } }`, stages in a
//    pipeline, accumulators in `$group`, update operators, `$field` references inside strings,
//    BSON helpers in value position… Operator data comes from @mongodb-js/mongodb-constants,
//    filtered by server version and Atlas-only stages; method data from the shared mongo-shell
//    tables, so what completes is exactly what the Shell tab can run.
//
// The query bar, stage editors and dialogs reuse the same analyzer by prepending a synthetic
// prefix (`db.getCollection('orders').find(` + filter text), so every editor speaks one grammar.
// Text is scanned from the start of the document on each request; the lexer resets the member
// chain at statement boundaries (`;`, a new line starting a new expression).

import {
  ACCUMULATORS,
  EXPRESSION_OPERATORS,
  QUERY_OPERATORS,
  STAGE_OPERATORS,
  SYSTEM_VARIABLES
} from '@mongodb-js/mongodb-constants'
import {
  MONGO_COLLECTION_METHODS,
  MONGO_CURSOR_METHODS,
  MONGO_DATABASE_METHODS,
  MONGO_DATABASE_NAVIGATION_METHODS,
  MONGO_EXPLAINABLE_METHODS,
  MONGO_EXPLAIN_VERBOSITIES,
  MONGO_SHOW_TARGETS,
  type MongoArgRole
} from '@shared/data-projects/mongo-shell'
import { lexShell, stringTokenValue, type ShellToken } from './shell-lexer'

// ---------------------------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------------------------

interface SiteBase {
  /** Offset where the replaced word starts (inside quotes: after the opening quote). */
  from: number
  /** What the user typed so far at the cursor. */
  prefix: string
}

export type MongoCompletionSite =
  | (SiteBase & { kind: 'statement' })
  | (SiteBase & { kind: 'use' })
  | (SiteBase & { kind: 'show' })
  | (SiteBase & { kind: 'db-member'; database?: string })
  | (SiteBase & { kind: 'collection-member'; database?: string; collection: string })
  | (SiteBase & { kind: 'explain-member'; database?: string; collection: string })
  | (SiteBase & { kind: 'cursor-member'; method: string; owner: 'collection' | 'database' })
  | (SiteBase & { kind: 'collection-name'; database?: string })
  | (SiteBase & {
      kind: 'argument'
      owner: 'collection' | 'database' | 'cursor'
      database?: string
      collection: string | null
      /** Collection/database method, or the cursor modifier for owner 'cursor'. */
      method: string
      /** The collection method a cursor modifier applies to (find, aggregate). */
      baseMethod?: string
      argIndex: number
      /** Keys from the argument down to the cursor; '[]' marks an array level. */
      path: string[]
      position: 'key' | 'value'
      /** Inside a string literal. */
      quoted: boolean
    })

export type MongoCompletionAnalysis = MongoCompletionSite | { kind: 'none' }

interface ChainLink {
  name: string
  called: boolean
  /** The call's argument when it is exactly one string literal (getCollection('x')). */
  arg: string | null
}

type Frame =
  | {
      type: 'call'
      name: string
      /** The statement chain the call belongs to (top-level calls only). */
      chain: ChainLink[] | null
      argIndex: number
      tokens: number
      firstString: string | null
    }
  | { type: 'object'; key: string | null; afterColon: boolean; pendingKey: string | null }
  | { type: 'array' }
  | { type: 'index'; str: string | null }
  | { type: 'paren' }

type ChainState =
  | { state: 'db'; database?: string }
  | { state: 'db-call'; database?: string; method: string }
  | { state: 'coll'; database?: string; collection: string }
  | { state: 'explain'; database?: string; collection: string }
  | { state: 'cursor'; database?: string; collection: string; method: string }
  | { state: 'invalid' }

/** Interprets `db.a.b.find().sort()…` (chain without its leading `db`). */
function walkChain(links: ChainLink[]): ChainState {
  let st: ChainState = { state: 'db' }
  for (const link of links) {
    switch (st.state) {
      case 'db':
        if (link.called) {
          if (link.name === 'getSiblingDB') st = { state: 'db', database: link.arg ?? undefined }
          else if (link.name === 'getCollection')
            st =
              link.arg !== null
                ? { state: 'coll', database: st.database, collection: link.arg }
                : { state: 'invalid' }
          else st = { state: 'db-call', database: st.database, method: link.name }
        } else st = { state: 'coll', database: st.database, collection: link.name }
        break
      case 'coll':
        if (!link.called)
          st = { state: 'coll', database: st.database, collection: `${st.collection}.${link.name}` }
        else if (link.name === 'explain')
          st = { state: 'explain', database: st.database, collection: st.collection }
        else
          st = {
            state: 'cursor',
            database: st.database,
            collection: st.collection,
            method: link.name
          }
        break
      case 'explain':
        st = link.called
          ? { state: 'cursor', database: st.database, collection: st.collection, method: link.name }
          : { state: 'invalid' }
        break
      case 'cursor':
      case 'db-call':
        if (!link.called) st = { state: 'invalid' }
        break
      default:
        return st
    }
  }
  return st
}

const isPunct = (token: ShellToken | null | undefined, text: string): boolean =>
  !!token && token.type === 'punct' && token.text === text

/** Finds the completion site for the text before the cursor (`text` ends at the cursor). */
export function analyzeMongoCompletion(text: string): MongoCompletionAnalysis {
  const all = lexShell(text)
  let tokens = all.filter((t) => t.type !== 'comment')
  const lastAny = all.at(-1)
  // Inside a comment, an unterminated regex/template, or right after a number: nothing to offer.
  if (lastAny && lastAny.end === text.length) {
    if (lastAny.type === 'comment' && (lastAny.unterminated || lastAny.text.startsWith('//')))
      return { kind: 'none' }
    if ((lastAny.type === 'regex' || lastAny.type === 'template') && lastAny.unterminated)
      return { kind: 'none' }
    if (lastAny.type === 'number') return { kind: 'none' }
  }

  let prefix = ''
  let from = text.length
  let quoted = false
  const tail = tokens.at(-1)
  if (tail && tail.end === text.length && tail.type === 'ident') {
    prefix = tail.text
    from = tail.start
    tokens = tokens.slice(0, -1)
  } else if (tail && tail.type === 'string' && tail.unterminated && tail.end === text.length) {
    quoted = true
    from = tail.start + 1
    prefix = text.slice(from)
    tokens = tokens.slice(0, -1)
  }

  const stack: Frame[] = []
  let chain: ChainLink[] = []
  let prev: ShellToken | null = null

  for (const token of tokens) {
    const top = stack.at(-1)
    if (top?.type === 'call') top.tokens++
    if (!top) {
      // Statement level: track the member chain db.a.find().sort()…
      if (token.type === 'ident') {
        if (isPunct(prev, '.')) chain.push({ name: token.text, called: false, arg: null })
        else chain = [{ name: token.text, called: false, arg: null }]
      } else if (token.type === 'punct') {
        if (token.text === '(') {
          const callee = prev?.type === 'ident' ? prev.text : null
          stack.push(
            callee !== null
              ? {
                  type: 'call',
                  name: callee,
                  chain: [...chain],
                  argIndex: 0,
                  tokens: 0,
                  firstString: null
                }
              : { type: 'paren' }
          )
        } else if (token.text === '[') {
          stack.push(
            prev && (prev.type === 'ident' || isPunct(prev, ')') || isPunct(prev, ']'))
              ? { type: 'index', str: null }
              : { type: 'array' }
          )
        } else if (token.text === '{')
          stack.push({ type: 'object', key: null, afterColon: false, pendingKey: null })
        else if (token.text !== '.') chain = []
      } else chain = []
      prev = token
      continue
    }

    if (token.type === 'punct') {
      switch (token.text) {
        case '(':
          stack.push(
            prev?.type === 'ident'
              ? {
                  type: 'call',
                  name: prev.text,
                  chain: null,
                  argIndex: 0,
                  tokens: 0,
                  firstString: null
                }
              : { type: 'paren' }
          )
          break
        case '[':
          stack.push({ type: 'array' })
          break
        case '{':
          stack.push({ type: 'object', key: null, afterColon: false, pendingKey: null })
          break
        case ')':
        case ']':
        case '}': {
          const popped = stack.pop()
          if (stack.length === 0 && popped) {
            if (popped.type === 'call' && popped.chain) {
              const link = chain.at(-1)
              if (link && link.name === popped.name) {
                link.called = true
                link.arg = popped.tokens === 2 ? popped.firstString : null
              }
            } else if (popped.type === 'index') {
              chain.push({ name: popped.str ?? '?', called: false, arg: null })
            }
          }
          break
        }
        case ':':
          if (top.type === 'object' && !top.afterColon) {
            top.key = top.pendingKey
            top.afterColon = true
          }
          break
        case ',':
          if (top.type === 'object') {
            top.key = null
            top.afterColon = false
            top.pendingKey = null
          } else if (top.type === 'call') top.argIndex++
          break
      }
    } else {
      if (top.type === 'object' && !top.afterColon) {
        if (token.type === 'ident') top.pendingKey = token.text
        else if (token.type === 'string') top.pendingKey = stringTokenValue(token)
      } else if (top.type === 'call' && top.tokens === 1 && token.type === 'string') {
        top.firstString = stringTokenValue(token)
      } else if (top.type === 'index' && token.type === 'string') {
        top.str = stringTokenValue(token)
      }
    }
    prev = token
  }

  const base = { from, prefix }

  if (stack.length === 0) {
    if (quoted) return { kind: 'none' }
    if (isPunct(prev, '.')) {
      if (chain.length === 0 || chain[0].name !== 'db' || chain[0].called) return { kind: 'none' }
      const st = walkChain(chain.slice(1))
      switch (st.state) {
        case 'db':
          return { kind: 'db-member', ...base, ...(st.database ? { database: st.database } : {}) }
        case 'coll':
          return {
            kind: 'collection-member',
            ...base,
            collection: st.collection,
            ...(st.database ? { database: st.database } : {})
          }
        case 'explain':
          return {
            kind: 'explain-member',
            ...base,
            collection: st.collection,
            ...(st.database ? { database: st.database } : {})
          }
        case 'cursor':
          return { kind: 'cursor-member', ...base, method: st.method, owner: 'collection' }
        case 'db-call':
          return { kind: 'cursor-member', ...base, method: st.method, owner: 'database' }
        default:
          return { kind: 'none' }
      }
    }
    if (
      prev?.type === 'ident' &&
      chain.length === 1 &&
      (prev.text === 'use' || prev.text === 'show') &&
      !/[\n\r]/.test(text.slice(prev.end, from))
    ) {
      return prev.text === 'use' ? { kind: 'use', ...base } : { kind: 'show', ...base }
    }
    // A new statement: start of text, after `;`, or on a fresh line after a complete one.
    if (!prev || isPunct(prev, ';') || /[\n\r]/.test(text.slice(prev.end, from)))
      return { kind: 'statement', ...base }
    return { kind: 'none' }
  }

  const root = stack[0]
  if (root.type === 'index') {
    if (stack.length !== 1 || !quoted) return { kind: 'none' }
    if (chain.length !== 1 || chain[0].name !== 'db') return { kind: 'none' }
    return { kind: 'collection-name', ...base }
  }
  if (root.type !== 'call' || !root.chain) return { kind: 'none' }
  const links = root.chain
  if (links.length < 2 || links[0].name !== 'db' || links[0].called) return { kind: 'none' }
  // The last link is the method being called (not marked called yet).
  const st = walkChain(links.slice(1, -1))
  const method = root.name

  let owner: 'collection' | 'database' | 'cursor'
  let collection: string | null = null
  let baseMethod: string | undefined
  let database: string | undefined
  switch (st.state) {
    case 'db':
      owner = 'database'
      database = st.database
      break
    case 'coll':
      owner = 'collection'
      collection = st.collection
      database = st.database
      break
    case 'explain':
      owner = 'collection'
      collection = st.collection
      database = st.database
      break
    case 'cursor':
      owner = 'cursor'
      collection = st.collection
      baseMethod = st.method
      database = st.database
      break
    default:
      return { kind: 'none' }
  }

  const path: string[] = []
  let position: 'key' | 'value' = 'value'
  for (let i = 1; i < stack.length; i++) {
    const frame = stack[i]
    const isTop = i === stack.length - 1
    if (frame.type === 'object') {
      if (isTop) {
        position = frame.afterColon ? 'value' : 'key'
        if (frame.afterColon) path.push(frame.key ?? '?')
      } else path.push(frame.key ?? '?')
    } else if (frame.type === 'array') {
      path.push('[]')
      if (isTop) position = 'value'
    } else if (frame.type === 'call') {
      // Inside a helper call such as ObjectId('…'): nothing useful to offer.
      return { kind: 'none' }
    } else if (frame.type === 'paren') {
      if (isTop) position = 'value'
    } else return { kind: 'none' }
  }

  return {
    kind: 'argument',
    ...base,
    owner,
    ...(database ? { database } : {}),
    collection,
    method,
    ...(baseMethod ? { baseMethod } : {}),
    argIndex: root.argIndex,
    path,
    position,
    quoted
  }
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export type MongoCompletionType =
  | 'property'
  | 'method'
  | 'keyword'
  | 'function'
  | 'variable'
  | 'constant'
  | 'class'
  | 'type'
  | 'namespace'
  | 'text'

export interface MongoCompletionItem {
  label: string
  type: MongoCompletionType
  detail?: string
  info?: string
  /** Text to insert instead of the label. */
  apply?: string
  /** CodeMirror snippet template (with ${1:placeholder} fields) to insert instead. */
  snippet?: string
  boost?: number
}

export interface MongoCompletionField {
  /** Dotted path ("address.city"). */
  path: string
  type?: string
}

export interface MongoCompletionData {
  databases: readonly string[]
  /** Collections of the editor's database (or of `database` in the site, when it differs). */
  collections: readonly string[]
  /** Field paths of a collection (null = the editor's own collection, if it has one). */
  fields: (collection: string | null) => readonly MongoCompletionField[]
  /** Server version for operator filtering ('8.0.4'); undefined = no filtering. */
  serverVersion?: string
  /** Atlas deployment (offers Atlas-only stages such as $search, $vectorSearch). */
  atlas?: boolean
}

interface Constant {
  value: string
  version: string
  meta?: string
  description?: string
  snippet?: string
  env?: readonly string[]
  outputStage?: boolean
  firstStage?: boolean
}

function versionAtMost(version: string, server: string | undefined): boolean {
  if (!server) return true
  const a = version.split('.').map((p) => parseInt(p, 10) || 0)
  const b = server.split('.').map((p) => parseInt(p, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return true
}

function usable(list: readonly Constant[], data: MongoCompletionData): Constant[] {
  const seen = new Set<string>()
  const out: Constant[] = []
  for (const c of list) {
    if (seen.has(c.value)) continue
    if (!versionAtMost(c.version, data.serverVersion)) continue
    if (c.env && !data.atlas && !c.env.includes('on-prem')) continue
    seen.add(c.value)
    out.push(c)
  }
  return out
}

const opItem = (c: Constant, type: MongoCompletionType = 'keyword'): MongoCompletionItem => ({
  label: c.value,
  type,
  ...(c.description ? { info: c.description } : {}),
  ...(c.meta ? { detail: c.meta } : {})
})

/** Query operators that only make sense at the top level of a filter. */
const TOP_LEVEL_QUERY = new Set([
  '$and',
  '$or',
  '$nor',
  '$expr',
  '$text',
  '$where',
  '$jsonSchema',
  '$comment'
])

const UPDATE_OPERATORS: Array<[string, string]> = [
  ['$set', 'Set field values'],
  ['$unset', 'Remove fields'],
  ['$inc', 'Increment by an amount'],
  ['$mul', 'Multiply by an amount'],
  ['$rename', 'Rename fields'],
  ['$setOnInsert', 'Set values only when an upsert inserts'],
  ['$min', 'Update when the value is smaller'],
  ['$max', 'Update when the value is larger'],
  ['$currentDate', 'Set to the current date'],
  ['$push', 'Append to an array'],
  ['$addToSet', 'Add to an array unless present'],
  ['$pull', 'Remove matching array elements'],
  ['$pullAll', 'Remove all listed values from an array'],
  ['$pop', 'Remove the first or last array element'],
  ['$bit', 'Bitwise update']
]

/** Stages allowed in an update pipeline (updateOne/updateMany with [ … ]). */
const UPDATE_PIPELINE_STAGES = new Set([
  '$addFields',
  '$set',
  '$project',
  '$unset',
  '$replaceRoot',
  '$replaceWith'
])

const BSON_HELPERS: MongoCompletionItem[] = [
  { label: 'ObjectId', type: 'function', snippet: "ObjectId('${}')", detail: 'ObjectId' },
  { label: 'ISODate', type: 'function', snippet: "ISODate('${}')", detail: 'Date' },
  { label: 'NumberLong', type: 'function', snippet: "NumberLong('${}')", detail: 'Int64' },
  { label: 'NumberInt', type: 'function', snippet: 'NumberInt(${})', detail: 'Int32' },
  {
    label: 'NumberDecimal',
    type: 'function',
    snippet: "NumberDecimal('${}')",
    detail: 'Decimal128'
  },
  { label: 'Double', type: 'function', snippet: 'Double(${})', detail: 'Double' },
  { label: 'UUID', type: 'function', snippet: "UUID('${}')", detail: 'Binary subtype 4' },
  { label: 'BinData', type: 'function', snippet: "BinData(${0}, '${}')", detail: 'Binary' },
  {
    label: 'Timestamp',
    type: 'function',
    snippet: 'Timestamp({ t: ${t}, i: ${i} })',
    detail: 'Timestamp'
  },
  { label: 'MinKey', type: 'function', apply: 'MinKey()', detail: 'MinKey' },
  { label: 'MaxKey', type: 'function', apply: 'MaxKey()', detail: 'MaxKey' },
  { label: 'true', type: 'constant' },
  { label: 'false', type: 'constant' },
  { label: 'null', type: 'constant' }
]

const OPTION_KEYS: Record<string, string[]> = {
  find: [
    'projection',
    'sort',
    'skip',
    'limit',
    'collation',
    'hint',
    'maxTimeMS',
    'comment',
    'allowDiskUse'
  ],
  findOne: ['projection', 'sort', 'skip', 'collation', 'hint', 'maxTimeMS', 'comment'],
  aggregate: ['allowDiskUse', 'maxTimeMS', 'collation', 'hint', 'comment', 'let', 'batchSize'],
  countDocuments: ['limit', 'skip', 'hint', 'maxTimeMS', 'collation'],
  updateOne: ['upsert', 'arrayFilters', 'collation', 'hint', 'let'],
  updateMany: ['upsert', 'arrayFilters', 'collation', 'hint', 'let'],
  replaceOne: ['upsert', 'collation', 'hint', 'let'],
  deleteOne: ['collation', 'hint', 'let'],
  deleteMany: ['collation', 'hint', 'let'],
  createIndex: [
    'name',
    'unique',
    'sparse',
    'expireAfterSeconds',
    'partialFilterExpression',
    'hidden',
    'collation',
    'weights',
    'default_language',
    'wildcardProjection'
  ],
  createCollection: [
    'capped',
    'size',
    'max',
    'timeseries',
    'expireAfterSeconds',
    'collation',
    'validator',
    'validationLevel',
    'validationAction',
    'clusteredIndex',
    'viewOn',
    'pipeline'
  ]
}

const STAGE_KEYS: Record<string, string[]> = {
  $lookup: ['from', 'localField', 'foreignField', 'as', 'let', 'pipeline'],
  $graphLookup: [
    'from',
    'startWith',
    'connectFromField',
    'connectToField',
    'as',
    'maxDepth',
    'depthField',
    'restrictSearchWithMatch'
  ],
  $unwind: ['path', 'includeArrayIndex', 'preserveNullAndEmptyArrays'],
  $sample: ['size'],
  $bucket: ['groupBy', 'boundaries', 'default', 'output'],
  $bucketAuto: ['groupBy', 'buckets', 'output', 'granularity'],
  $unionWith: ['coll', 'pipeline'],
  $merge: ['into', 'on', 'let', 'whenMatched', 'whenNotMatched'],
  $out: ['db', 'coll'],
  $replaceRoot: ['newRoot'],
  $geoNear: [
    'near',
    'distanceField',
    'maxDistance',
    'minDistance',
    'query',
    'spherical',
    'key',
    'includeLocs'
  ],
  $setWindowFields: ['partitionBy', 'sortBy', 'output'],
  $densify: ['field', 'partitionByFields', 'range'],
  $fill: ['partitionBy', 'partitionByFields', 'sortBy', 'output']
}

const keyItems = (keys: readonly string[], detail?: string): MongoCompletionItem[] =>
  keys.map((label) => ({ label, type: 'property', ...(detail ? { detail } : {}) }))

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function fieldItems(
  fields: readonly MongoCompletionField[],
  quoted: boolean
): MongoCompletionItem[] {
  return fields.map((f) => ({
    label: f.path,
    type: 'property',
    ...(f.type ? { detail: f.type } : {}),
    // Dotted paths are not identifiers: quote them in key position.
    ...(!quoted && !IDENT.test(f.path)
      ? { apply: `'${f.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` }
      : {}),
    boost: f.path.includes('.') ? -1 : 1
  }))
}

function fieldRefItems(
  fields: readonly MongoCompletionField[],
  data: MongoCompletionData
): MongoCompletionItem[] {
  return [
    ...fields.map((f) => ({
      label: `$${f.path}`,
      type: 'property' as const,
      ...(f.type ? { detail: f.type } : {})
    })),
    ...usable(SYSTEM_VARIABLES as readonly Constant[], data).map((c) => opItem(c, 'variable'))
  ]
}

function queryOperatorItems(data: MongoCompletionData, topLevel: boolean): MongoCompletionItem[] {
  return usable(QUERY_OPERATORS as readonly Constant[], data)
    .filter((c) => TOP_LEVEL_QUERY.has(c.value) === topLevel)
    .map((c) => opItem(c))
}

const expressionItems = (data: MongoCompletionData): MongoCompletionItem[] =>
  usable(EXPRESSION_OPERATORS as readonly Constant[], data).map((c) => opItem(c, 'function'))

const accumulatorItems = (data: MongoCompletionData): MongoCompletionItem[] =>
  usable(ACCUMULATORS as readonly Constant[], data).map((c) => opItem(c, 'function'))

/** Stage operators with their snippets (`$match: {\n  query\n}`). */
export function stageItems(
  data: MongoCompletionData,
  only?: ReadonlySet<string>
): MongoCompletionItem[] {
  return usable(STAGE_OPERATORS as readonly Constant[], data)
    .filter((c) => !only || only.has(c.value))
    .map((c) => ({
      label: c.value,
      type: 'keyword' as const,
      ...(c.description ? { info: c.description } : {}),
      detail: c.outputStage ? 'writes' : c.firstStage ? 'first stage' : 'stage',
      ...(c.snippet ? { snippet: `${c.value}: ${c.snippet}` } : {}),
      boost: c.outputStage ? -2 : c.firstStage ? -1 : 0
    }))
}

/** Stage operator names for the stage card dropdown (version/env filtered, deduplicated). */
export function stageOperatorOptions(
  data: Pick<MongoCompletionData, 'serverVersion' | 'atlas'>
): Array<{ value: string; description?: string; outputStage: boolean; snippet?: string }> {
  return usable(STAGE_OPERATORS as readonly Constant[], {
    ...data,
    databases: [],
    collections: [],
    fields: () => []
  }).map((c) => ({
    value: c.value,
    ...(c.description ? { description: c.description } : {}),
    outputStage: !!c.outputStage,
    ...(c.snippet ? { snippet: c.snippet } : {})
  }))
}

function filterBody(
  path: readonly string[],
  position: 'key' | 'value',
  quoted: boolean,
  fields: readonly MongoCompletionField[],
  data: MongoCompletionData
): MongoCompletionItem[] {
  if (position === 'value') return quoted ? [] : BSON_HELPERS
  const last = path.at(-1)
  if (last === undefined || last === '[]')
    return [...fieldItems(fields, quoted), ...(quoted ? [] : queryOperatorItems(data, true))]
  if (quoted) return []
  if (last === '$expr') return expressionItems(data)
  if (last === '$elemMatch')
    return [...fieldItems(fields, false), ...queryOperatorItems(data, false)]
  return queryOperatorItems(data, false)
}

function stageBody(
  stage: string,
  rest: readonly string[],
  position: 'key' | 'value',
  quoted: boolean,
  prefix: string,
  fields: readonly MongoCompletionField[],
  data: MongoCompletionData
): MongoCompletionItem[] {
  if (stage === '$match') return filterBody(rest, position, quoted, fields, data)
  if (position === 'value') {
    if (quoted) {
      const key = rest.at(-1)
      if ((stage === '$lookup' || stage === '$graphLookup') && key === 'from')
        return data.collections.map((c) => ({ label: c, type: 'namespace' }))
      if ((stage === '$unionWith' && (key === 'coll' || rest.length === 0)) || stage === '$out')
        return data.collections.map((c) => ({ label: c, type: 'namespace' }))
      if (stage === '$merge' && (key === 'into' || rest.length === 0))
        return data.collections.map((c) => ({ label: c, type: 'namespace' }))
      if (
        (stage === '$lookup' && (key === 'localField' || key === 'foreignField')) ||
        (stage === '$graphLookup' && (key === 'connectFromField' || key === 'connectToField'))
      )
        return fieldItems(fields, true)
      return prefix.startsWith('$') ? fieldRefItems(fields, data) : []
    }
    return BSON_HELPERS
  }
  if (quoted) return rest.length === 0 && stage !== '$group' ? fieldItems(fields, true) : []
  if (STAGE_KEYS[stage] && rest.length === 0) return keyItems(STAGE_KEYS[stage], stage)
  switch (stage) {
    case '$group':
      if (rest.length === 0) return [{ label: '_id', type: 'property', detail: 'group key' }]
      if (rest.length === 1) return accumulatorItems(data)
      return expressionItems(data)
    case '$project':
    case '$addFields':
    case '$set':
    case '$sort':
    case '$sortByCount':
      return rest.length === 0 ? fieldItems(fields, false) : expressionItems(data)
    default:
      return expressionItems(data)
  }
}

type ArgumentRole = MongoArgRole | 'collation' | 'verbosity' | 'collectionName' | 'databaseName'

function roleOf(site: Extract<MongoCompletionSite, { kind: 'argument' }>): ArgumentRole | null {
  if (site.owner === 'cursor') {
    switch (site.method) {
      case 'sort':
        return 'sort'
      case 'project':
      case 'projection':
        return 'projection'
      case 'hint':
      case 'min':
      case 'max':
        return 'keys'
      case 'collation':
        return 'collation'
      case 'explain':
        return 'verbosity'
      default:
        return null
    }
  }
  if (site.owner === 'database') {
    if (
      site.method === 'getCollection' ||
      site.method === 'createCollection' ||
      site.method === 'createView'
    )
      return site.argIndex === 0
        ? 'collectionName'
        : site.method === 'createView' && site.argIndex === 1
          ? 'collectionName'
          : null
    if (site.method === 'getSiblingDB') return 'databaseName'
    return MONGO_DATABASE_METHODS[site.method]?.args[site.argIndex] ?? null
  }
  if (site.method === 'explain') return 'verbosity'
  return MONGO_COLLECTION_METHODS[site.method]?.args[site.argIndex] ?? null
}

/** Completion options for a site (empty when there is nothing useful to offer). */
export function mongoCompletionItems(
  site: MongoCompletionSite,
  data: MongoCompletionData
): MongoCompletionItem[] {
  switch (site.kind) {
    case 'statement':
      return [
        { label: 'db', type: 'variable', detail: 'current database' },
        { label: 'use', type: 'keyword', apply: 'use ', detail: 'switch database' },
        { label: 'show', type: 'keyword', apply: 'show ', detail: 'show dbs | collections' }
      ]
    case 'use':
      return data.databases.map((d) => ({ label: d, type: 'namespace' }))
    case 'show':
      return Object.entries(MONGO_SHOW_TARGETS).map(([label, t]) => ({
        label,
        type: 'keyword',
        info: t.doc
      }))
    case 'collection-name':
      return data.collections.map((c) => ({ label: c, type: 'namespace' }))
    case 'db-member': {
      const collections = data.collections.map((c) => ({
        label: c,
        type: 'namespace' as const,
        detail: 'collection',
        // Names that are not identifiers (or clash with a method) need getCollection('…').
        ...(!IDENT.test(c) || c in MONGO_DATABASE_METHODS || c in MONGO_DATABASE_NAVIGATION_METHODS
          ? { apply: `getCollection('${c.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')` }
          : {}),
        boost: 2
      }))
      const methods = Object.entries(MONGO_DATABASE_METHODS).map(([label, m]) => ({
        label,
        type: 'method' as const,
        info: m.doc,
        detail: m.write ? 'write' : undefined,
        apply: `${label}(`
      }))
      const nav = Object.entries(MONGO_DATABASE_NAVIGATION_METHODS).map(([label, m]) => ({
        label,
        type: 'method' as const,
        info: m.doc,
        snippet: `${label}('\${}')`
      }))
      return [...collections, ...methods, ...nav]
    }
    case 'collection-member': {
      // `db.system.` → sub-collections ('system.users') as well as methods.
      const nested = data.collections
        .filter((c) => c.startsWith(`${site.collection}.`))
        .map((c) => ({
          label: c.slice(site.collection.length + 1),
          type: 'namespace' as const,
          detail: 'collection'
        }))
        .filter((c) => IDENT.test(c.label))
      return [
        ...Object.entries(MONGO_COLLECTION_METHODS).map(([label, m]) => ({
          label,
          type: 'method' as const,
          info: m.doc,
          ...(m.write ? { detail: 'write' } : { detail: 'read' }),
          apply: `${label}(`,
          boost: label === 'find' || label === 'aggregate' ? 2 : m.write ? -1 : 0
        })),
        {
          label: 'explain',
          type: 'method',
          info: 'explain(verbosity?) — then .find()/.aggregate()…',
          apply: 'explain('
        },
        ...nested
      ]
    }
    case 'explain-member':
      return MONGO_EXPLAINABLE_METHODS.map((label) => ({
        label,
        type: 'method',
        info: MONGO_COLLECTION_METHODS[label]?.doc,
        apply: `${label}(`
      }))
    case 'cursor-member':
      return Object.entries(MONGO_CURSOR_METHODS)
        .filter(([, m]) => m.appliesTo.includes(site.method))
        .map(([label, m]) => ({
          label,
          type: 'method' as const,
          info: m.doc,
          apply: m.maxArgs === 0 ? `${label}()` : `${label}(`
        }))
    case 'argument':
      return argumentItems(site, data)
  }
}

function argumentItems(
  site: Extract<MongoCompletionSite, { kind: 'argument' }>,
  data: MongoCompletionData
): MongoCompletionItem[] {
  const role = roleOf(site)
  const fields = data.fields(site.collection)
  const { path, position, quoted, prefix } = site
  if (!role) return []
  switch (role) {
    case 'collectionName':
      return quoted && path.length === 0
        ? data.collections.map((c) => ({ label: c, type: 'namespace' }))
        : []
    case 'databaseName':
      return quoted && path.length === 0
        ? data.databases.map((d) => ({ label: d, type: 'namespace' }))
        : []
    case 'verbosity':
      return quoted && path.length === 0
        ? MONGO_EXPLAIN_VERBOSITIES.map((v) => ({ label: v, type: 'constant' }))
        : []
    case 'field':
      return quoted && path.length === 0 ? fieldItems(fields, true) : []
    case 'filter':
      if (path.length === 0 && position === 'value') return quoted ? [] : prefix ? BSON_HELPERS : []
      return filterBody(path, position, quoted, fields, data)
    case 'pipeline': {
      if (path[0] !== '[]') return []
      if (path.length === 1) return position === 'key' && !quoted ? stageItems(data) : []
      return stageBody(path[1], path.slice(2), position, quoted, prefix, fields, data)
    }
    case 'update': {
      if (path[0] === '[]') {
        if (path.length === 1)
          return position === 'key' && !quoted ? stageItems(data, UPDATE_PIPELINE_STAGES) : []
        return stageBody(path[1], path.slice(2), position, quoted, prefix, fields, data)
      }
      if (position === 'value') return quoted || !prefix ? [] : BSON_HELPERS
      if (path.length === 0)
        return quoted
          ? []
          : UPDATE_OPERATORS.map(([label, info]) => ({ label, type: 'keyword', info }))
      if (path.length === 1) return fieldItems(fields, quoted)
      return []
    }
    case 'document':
    case 'replacement':
    case 'documents': {
      const inner = role === 'documents' && path[0] === '[]' ? path.slice(1) : path
      if (position === 'key' && inner.length === 0) return fieldItems(fields, quoted)
      if (position === 'value' && !quoted && prefix) return BSON_HELPERS
      return []
    }
    case 'projection':
    case 'sort':
    case 'keys': {
      if (position === 'key' && path.length === 0) return fieldItems(fields, quoted)
      if (position === 'value' && path.length === 1 && role === 'keys') {
        if (quoted)
          return ['text', '2dsphere', '2d', 'hashed'].map((label) => ({ label, type: 'constant' }))
        return [
          { label: '1', type: 'constant', detail: 'ascending' },
          { label: '-1', type: 'constant', detail: 'descending' }
        ]
      }
      return []
    }
    case 'options': {
      const keys =
        OPTION_KEYS[site.method] ?? (site.owner === 'database' ? OPTION_KEYS.createCollection : [])
      return position === 'key' && path.length === 0 && !quoted ? keyItems(keys, 'option') : []
    }
    case 'collation':
      return position === 'key' && path.length === 0 && !quoted
        ? keyItems(
            [
              'locale',
              'strength',
              'caseLevel',
              'caseFirst',
              'numericOrdering',
              'alternate',
              'maxVariable',
              'backwards'
            ],
            'collation'
          )
        : []
    default:
      return []
  }
}

/**
 * Whether completions should open while typing (CodeMirror calls the source on every edit):
 * always after `.`, inside quotes, or once a word is started; key/value positions with nothing
 * typed only on explicit request (Ctrl-Space) so `{ ` does not throw a list at the user.
 */
export function shouldOfferWhileTyping(site: MongoCompletionSite, text: string): boolean {
  if (site.prefix.length > 0) return true
  const before = text.slice(0, site.from).trimEnd()
  if (site.kind === 'argument') return site.quoted
  return before.endsWith('.')
}
