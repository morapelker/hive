// Structural parser for ONE mongosh-style statement. It never evaluates anything: acorn builds
// an AST and we accept only a short allowlist of shapes —
//
//   use <db> | show dbs|databases|collections|tables|users|roles|profile
//   db[.getSiblingDB('x')].<coll | getCollection('c') | ['c']>.<method>(args)[.<modifier>(args)]*
//   db[.getSiblingDB('x')].<collection>.explain(verbosity?).<find|aggregate|count|distinct>(args)...
//   db[.getSiblingDB('x')].<dbMethod>(args)[.toArray()]
//
// Arguments must be JSON-like literals plus the BSON helpers @mongodb-js/shell-bson-parser
// understands (ObjectId(), ISODate(), NumberLong(), /regex/, function values for $where...). The
// argument check here mirrors that parser's allowlist (slightly stricter) so the renderer can
// underline an unsupported expression before anything is sent; the server converts the values
// with the real parser and re-checks. No BSON library is imported: this file runs in the
// renderer too.

import {
  parse as acornParse,
  type ArrayExpression,
  type CallExpression,
  type Expression,
  type Literal,
  type MemberExpression,
  type NewExpression,
  type Node as AcornNode,
  type ObjectExpression,
  type Program,
  type Property,
  type SpreadElement
} from 'acorn'
import {
  MONGO_COLLECTION_METHODS,
  MONGO_CURSOR_METHODS,
  MONGO_DATABASE_METHODS,
  MONGO_EXPLAINABLE_METHODS,
  MONGO_SHELL_CONSTRUCTORS,
  MONGO_SHOW_TARGETS,
  type MongoMethodInfo
} from './methods'

export interface MongoShellRange {
  start: number
  end: number
}

export interface MongoShellModifier {
  name: string
  /** Range of `.name(...)` (from the dot to the closing parenthesis). */
  start: number
  end: number
  argRanges: MongoShellRange[]
}

export type MongoShellKind = 'collection' | 'database' | 'use' | 'show'

export interface MongoShellStructure {
  kind: MongoShellKind
  /** `use` target, or the db.getSiblingDB('x') database. Undefined = the session's database. */
  database?: string
  collection?: string
  /**
   * Collection or database method ('find', 'getCollectionNames'...); 'use' for `use x`; the
   * canonical `show` target ('dbs', 'collections', 'users', 'roles', 'profile') for show.
   */
  method: string
  /** Cursor modifiers in call order ('sort', 'limit', 'explain'...). */
  modifiers: string[]
  /** Argument ranges of the method call (offsets into the statement text). */
  argRanges: MongoShellRange[]
  /** aggregate: the operator of each top-level stage ('?' when a stage is not a literal object). */
  stageNames?: string[]
  /** The modifier calls with their argument ranges (same order as `modifiers`). */
  modifierCalls: MongoShellModifier[]
  /** Explain instead of run: `.explain(v)` (prefix false) or `db.c.explain(v).find()` (prefix true). */
  explain?: { argRanges: MongoShellRange[]; prefix: boolean }
  /** runCommand/adminCommand: the command name (first key, or the string argument). */
  commandName?: string
  /** Where the method name sits, for error underlines. */
  methodRange: MongoShellRange
}

export interface MongoShellParseError {
  error: { message: string; offset: number }
}

/** Argument expression nodes (acorn ESTree). Shared with the classifier and the server. */
export type MongoShellArgNode = Expression

/** The structure plus the argument ASTs (classifier, server-side value conversion). */
export interface MongoShellParsed {
  text: string
  structure: MongoShellStructure
  argNodes: MongoShellArgNode[]
  modifierArgNodes: MongoShellArgNode[][]
  explainArgNodes: MongoShellArgNode[]
}

export type MongoShellParseResult =
  { ok: true; value: MongoShellParsed } | { ok: false; error: { message: string; offset: number } }

export const isMongoShellParseError = (
  value: MongoShellStructure | MongoShellParseError
): value is MongoShellParseError => 'error' in value

class ShellSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number
  ) {
    super(message)
  }
}

const START_HINT =
  'Statements must start with db (db.orders.find({ status: "A" })), use <database> or show dbs|collections'

// ---------------------------------------------------------------------------------------------
// Trivia (whitespace / comments)
// ---------------------------------------------------------------------------------------------

/** Index of the first character that is not whitespace or part of a comment. */
export function skipMongoTrivia(text: string, from: number): number {
  let i = from
  const n = text.length
  while (i < n) {
    const ch = text.charCodeAt(i)
    if (
      ch === 32 ||
      ch === 9 ||
      ch === 10 ||
      ch === 13 ||
      ch === 11 ||
      ch === 12 ||
      ch === 0xa0 ||
      ch === 0xfeff ||
      ch === 0x2028 ||
      ch === 0x2029
    ) {
      i++
    } else if (ch === 47 /* / */ && text.charCodeAt(i + 1) === 47) {
      while (i < n && text[i] !== '\n') i++
    } else if (ch === 47 && text.charCodeAt(i + 1) === 42 /* * */) {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else {
      break
    }
  }
  return i
}

// ---------------------------------------------------------------------------------------------
// use / show
// ---------------------------------------------------------------------------------------------

const INVALID_DB_CHARS = /[/\\. "$*<>:|?]/
const isInvalidDbName = (name: string): boolean =>
  !name || INVALID_DB_CHARS.test(name) || name.includes(String.fromCharCode(0)) || name.length > 63

function emptyStructure(
  kind: MongoShellKind,
  method: string,
  range: MongoShellRange
): MongoShellStructure {
  return { kind, method, modifiers: [], argRanges: [], modifierCalls: [], methodRange: range }
}

/** `use x` / `show y`, or null when the statement is not one of them. */
function parseLineCommand(text: string): MongoShellParseResult | null {
  const lead = skipMongoTrivia(text, 0)
  const head = /^(use|show)(?=[ \t]|$|;)/.exec(text.slice(lead))
  if (!head) return null
  const word = head[1]
  const n = text.length
  let i = lead + word.length
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i++
  const argStart = i
  let arg = ''
  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i]
    const close = text.indexOf(quote, i + 1)
    if (close < 0) return fail(`Unterminated quoted name after ${word}`, i)
    arg = text.slice(i + 1, close)
    i = close + 1
  } else {
    while (i < n && !/[\s;]/.test(text[i])) i++
    arg = text.slice(argStart, i)
  }
  const argEnd = i
  // Only `;`, whitespace and a trailing comment may follow.
  let j = i
  for (;;) {
    j = skipMongoTrivia(text, j)
    if (text[j] === ';') {
      j++
      continue
    }
    break
  }
  if (j < n) {
    return fail(`${word} takes exactly one name; put other statements on their own line`, j)
  }
  if (word === 'use') {
    if (!arg) return fail('use needs a database name: use <database>', argStart)
    if (isInvalidDbName(arg)) {
      return fail(`Invalid database name "${arg}"`, argStart)
    }
    const structure = emptyStructure('use', 'use', { start: lead, end: lead + 3 })
    structure.database = arg
    structure.argRanges = [{ start: argStart, end: argEnd }]
    return ok(text, structure, [], [], [])
  }
  const target = MONGO_SHOW_TARGETS[arg]
  if (!target) {
    return fail(
      `Unsupported: show ${arg || '…'}. Supported: show dbs, show collections, show users, show roles, show profile`,
      arg ? argStart : lead
    )
  }
  const structure = emptyStructure('show', target.canonical, { start: argStart, end: argEnd })
  structure.argRanges = [{ start: argStart, end: argEnd }]
  return ok(text, structure, [], [], [])
}

// ---------------------------------------------------------------------------------------------
// Argument allowlist (mirrors @mongodb-js/shell-bson-parser's Checker, loose mode)
// ---------------------------------------------------------------------------------------------

const SAFE_GLOBALS = new Set(['Infinity', 'NaN', 'undefined'])
const CONSTRUCTORS = new Set(MONGO_SHELL_CONSTRUCTORS)
const MATH_METHODS = new Set(
  'abs acos acosh asin asinh atan atan2 atanh cbrt ceil clz32 cos cosh exp expm1 floor fround hypot imul log log10 log1p log2 max min pow round sign sin sinh sqrt tan tanh trunc'.split(
    ' '
  )
)
const DATE_METHODS = new Set(
  'getDate getDay getFullYear getHours getMilliseconds getMinutes getMonth getSeconds getTime getTimezoneOffset getUTCDate getUTCDay getUTCFullYear getUTCHours getUTCMilliseconds getUTCMinutes getUTCMonth getUTCSeconds getYear now setDate setFullYear setHours setMilliseconds setMinutes setMonth setSeconds setTime setUTCDate setUTCFullYear setUTCHours setUTCMilliseconds setUTCMinutes setUTCMonth setUTCSeconds setYear toISOString valueOf'.split(
    ' '
  )
)
const CLASS_METHODS: Record<string, Set<string>> = {
  Math: MATH_METHODS,
  Date: DATE_METHODS,
  ISODate: DATE_METHODS,
  Binary: new Set(['createFromHexString', 'createFromBase64'])
}
const SAFE_UNARY = new Set(['-', '+', '!', '~'])
const UNSAFE_BINARY = new Set(['**', 'in', 'instanceof'])

/** The first node that is not allowed inside an argument value, or null. */
function unsafeNode(node: AcornNode | null | undefined): AcornNode | null {
  if (!node) return null
  switch (node.type) {
    case 'Literal':
      return (node as Literal).bigint !== undefined ? node : null
    case 'Identifier':
      return SAFE_GLOBALS.has((node as unknown as { name: string }).name) ? null : node
    case 'ArrayExpression': {
      const array = node as ArrayExpression
      for (const element of array.elements) {
        if (!element) return node
        if (element.type === 'SpreadElement') return element
        const bad = unsafeNode(element)
        if (bad) return bad
      }
      return null
    }
    case 'ObjectExpression': {
      for (const property of (node as ObjectExpression).properties) {
        if (property.type !== 'Property') return property
        if (
          property.computed ||
          property.method ||
          property.kind !== 'init' ||
          property.shorthand
        ) {
          return property
        }
        const key = property.key
        if (
          key.type !== 'Identifier' &&
          !(
            key.type === 'Literal' &&
            (typeof key.value === 'string' || typeof key.value === 'number')
          )
        ) {
          return key
        }
        const value = property.value
        // Function values ($where, $function.body, $accumulator.*) come back as source text.
        if (value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression')
          continue
        const bad = unsafeNode(value)
        if (bad) return bad
      }
      return null
    }
    case 'UnaryExpression': {
      const unary = node as unknown as { operator: string; argument: AcornNode }
      return SAFE_UNARY.has(unary.operator) ? unsafeNode(unary.argument) : node
    }
    case 'BinaryExpression': {
      const binary = node as unknown as { operator: string; left: AcornNode; right: AcornNode }
      if (UNSAFE_BINARY.has(binary.operator) || binary.left.type === 'PrivateIdentifier')
        return node
      return unsafeNode(binary.left) ?? unsafeNode(binary.right)
    }
    case 'CallExpression':
    case 'NewExpression':
      return unsafeCall(node as CallExpression | NewExpression)
    default:
      return node
  }
}

function unsafeArgs(args: Array<Expression | SpreadElement>): AcornNode | null {
  for (const arg of args) {
    if (arg.type === 'SpreadElement') return arg
    const bad = unsafeNode(arg)
    if (bad) return bad
  }
  return null
}

function unsafeCall(node: CallExpression | NewExpression): AcornNode | null {
  if (node.type === 'CallExpression' && node.optional) return node
  const callee = node.callee
  if (callee.type === 'Identifier') {
    return CONSTRUCTORS.has(callee.name) ? unsafeArgs(node.arguments) : node
  }
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    !callee.optional &&
    callee.property.type === 'Identifier'
  ) {
    const method = callee.property.name
    const object = callee.object
    if (object.type === 'Identifier') {
      const allowed = CLASS_METHODS[object.name]
      return allowed?.has(method) ? unsafeArgs(node.arguments) : node
    }
    // new Date(...).getTime(), ISODate('...').toISOString()
    if (
      (object.type === 'NewExpression' || object.type === 'CallExpression') &&
      object.callee.type === 'Identifier'
    ) {
      const allowed = CLASS_METHODS[object.callee.name]
      if (!allowed?.has(method)) return node
      return unsafeNode(object) ?? unsafeArgs(node.arguments)
    }
  }
  return node
}

function snippet(text: string, node: AcornNode): string {
  const raw = text.slice(node.start, node.end).replace(/\s+/g, ' ')
  return raw.length > 40 ? `${raw.slice(0, 37)}…` : raw
}

function checkArgs(text: string, nodes: MongoShellArgNode[]): void {
  for (const node of nodes) {
    const bad = unsafeNode(node)
    if (!bad) continue
    const what = snippet(text, bad)
    if (bad.type === 'TemplateLiteral') {
      throw new ShellSyntaxError('Template strings are not supported; use quotes', bad.start)
    }
    if (bad.type === 'Identifier') {
      throw new ShellSyntaxError(
        `Variables are not supported (${what}); write the value itself, e.g. ObjectId('…') or ISODate('…')`,
        bad.start
      )
    }
    throw new ShellSyntaxError(
      `Unsupported expression: ${what}. Only literals, objects, arrays, regular expressions and BSON helpers (ObjectId, ISODate, NumberLong, NumberDecimal, UUID, …) are allowed`,
      bad.start
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Call chain
// ---------------------------------------------------------------------------------------------

type Segment =
  | { kind: 'prop'; name: string; start: number; end: number; exprStart: number }
  | { kind: 'call'; args: MongoShellArgNode[]; start: number; end: number }

function flatten(node: AcornNode, out: Segment[]): void {
  switch (node.type) {
    case 'Identifier': {
      const id = node as unknown as { name: string }
      out.push({
        kind: 'prop',
        name: id.name,
        start: node.start,
        end: node.end,
        exprStart: node.start
      })
      return
    }
    case 'MemberExpression': {
      const member = node as MemberExpression
      if (member.optional)
        throw new ShellSyntaxError('Optional chaining (?.) is not supported', member.start)
      if (member.object.type === 'Super') throw new ShellSyntaxError(START_HINT, member.start)
      flatten(member.object, out)
      const property = member.property
      if (!member.computed && property.type === 'Identifier') {
        out.push({
          kind: 'prop',
          name: property.name,
          start: property.start,
          end: property.end,
          exprStart: member.object.end
        })
        return
      }
      if (member.computed && property.type === 'Literal' && typeof property.value === 'string') {
        out.push({
          kind: 'prop',
          name: property.value,
          start: property.start,
          end: property.end,
          exprStart: member.object.end
        })
        return
      }
      throw new ShellSyntaxError(
        'Only quoted names are allowed inside [ ] (db["order-items"])',
        property.start
      )
    }
    case 'CallExpression': {
      const call = node as CallExpression
      if (call.optional)
        throw new ShellSyntaxError('Optional calls (?.()) are not supported', call.start)
      if (call.callee.type === 'Super') throw new ShellSyntaxError(START_HINT, call.start)
      flatten(call.callee, out)
      const args: MongoShellArgNode[] = []
      for (const arg of call.arguments) {
        if (arg.type === 'SpreadElement')
          throw new ShellSyntaxError('Spread arguments (...) are not supported', arg.start)
        args.push(arg)
      }
      out.push({ kind: 'call', args, start: call.callee.end, end: call.end })
      return
    }
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      throw new ShellSyntaxError(
        'Functions can only appear as values ($where, $function); JavaScript is not executed',
        node.start
      )
    default:
      throw new ShellSyntaxError(`${START_HINT}. Arbitrary JavaScript is not supported`, node.start)
  }
}

const literalString = (node: AcornNode | undefined): string | undefined =>
  node && node.type === 'Literal' && typeof (node as Literal).value === 'string'
    ? ((node as Literal).value as string)
    : undefined

/** Key name of an object property (identifier or string/number literal). */
export function mongoPropertyKey(property: Property | SpreadElement): string | null {
  if (property.type !== 'Property' || property.computed) return null
  const key = property.key
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return String(key.value)
  }
  return null
}

function checkArity(
  name: string,
  info: { minArgs: number; maxArgs: number },
  args: MongoShellArgNode[],
  at: number
): void {
  if (args.length < info.minArgs) {
    throw new ShellSyntaxError(
      `${name}() needs ${info.minArgs === 1 ? 'an argument' : `${info.minArgs} arguments`}`,
      at
    )
  }
  if (args.length > info.maxArgs) {
    const extra = args[info.maxArgs]
    throw new ShellSyntaxError(
      info.maxArgs === 0
        ? `${name}() takes no arguments`
        : `${name}() takes at most ${info.maxArgs} argument${info.maxArgs === 1 ? '' : 's'}`,
      extra.start
    )
  }
}

const rangeOf = (node: AcornNode): MongoShellRange => ({ start: node.start, end: node.end })

function ok(
  text: string,
  structure: MongoShellStructure,
  argNodes: MongoShellArgNode[],
  modifierArgNodes: MongoShellArgNode[][],
  explainArgNodes: MongoShellArgNode[]
): MongoShellParseResult {
  return { ok: true, value: { text, structure, argNodes, modifierArgNodes, explainArgNodes } }
}

function fail(message: string, offset: number): MongoShellParseResult {
  return { ok: false, error: { message, offset: Math.max(0, offset) } }
}

function interpret(text: string, segments: Segment[]): MongoShellParseResult {
  const first = segments[0]
  if (!first || first.kind !== 'prop' || first.name !== 'db') {
    throw new ShellSyntaxError(START_HINT, first?.start ?? 0)
  }
  let i = 1
  let database: string | undefined
  const at = (k: number): Segment | undefined => segments[k]
  const isCall = (k: number): boolean => at(k)?.kind === 'call'

  // db.getSiblingDB('x') (possibly repeated: the last one wins)
  for (;;) {
    const seg = at(i)
    if (seg?.kind === 'prop' && seg.name === 'getSiblingDB' && isCall(i + 1)) {
      const call = at(i + 1) as Extract<Segment, { kind: 'call' }>
      const name = literalString(call.args[0])
      if (call.args.length !== 1 || name === undefined) {
        throw new ShellSyntaxError(
          "getSiblingDB() needs one quoted database name: db.getSiblingDB('shop')",
          call.start
        )
      }
      if (isInvalidDbName(name))
        throw new ShellSyntaxError(`Invalid database name "${name}"`, call.args[0].start)
      database = name
      i += 2
      continue
    }
    break
  }

  const head = at(i)
  if (!head) {
    throw new ShellSyntaxError(
      'Incomplete statement: add a method, e.g. db.orders.find()',
      text.trimEnd().length
    )
  }
  if (head.kind === 'call') throw new ShellSyntaxError(START_HINT, head.start)

  let kind: MongoShellKind
  let collection: string | undefined
  let methodIndex: number

  if (isCall(i + 1) && head.name !== 'getCollection') {
    // db.<dbMethod>(...)
    if (!Object.prototype.hasOwnProperty.call(MONGO_DATABASE_METHODS, head.name)) {
      const hint = Object.prototype.hasOwnProperty.call(MONGO_COLLECTION_METHODS, head.name)
        ? ` — did you mean db.<collection>.${head.name}(...)?`
        : ''
      throw new ShellSyntaxError(`Unknown database method db.${head.name}()${hint}`, head.start)
    }
    kind = 'database'
    methodIndex = i
  } else {
    kind = 'collection'
    if (head.name === 'getCollection' && isCall(i + 1)) {
      const call = at(i + 1) as Extract<Segment, { kind: 'call' }>
      const name = literalString(call.args[0])
      if (call.args.length !== 1 || name === undefined) {
        throw new ShellSyntaxError(
          "getCollection() needs one quoted collection name: db.getCollection('orders')",
          call.start
        )
      }
      collection = name
      i += 2
    } else {
      // db.a.b.find(): every property up to the method is part of the collection name.
      const names: string[] = []
      while (at(i)?.kind === 'prop' && !isCall(i + 1)) {
        names.push((at(i) as Extract<Segment, { kind: 'prop' }>).name)
        i++
      }
      collection = names.join('.')
    }
    if (!collection) throw new ShellSyntaxError('Collection name must not be empty', head.start)
    if (collection.includes('\u0000') || collection.startsWith('$')) {
      throw new ShellSyntaxError(`Invalid collection name "${collection}"`, head.start)
    }
    const methodSeg = at(i)
    if (!methodSeg) {
      throw new ShellSyntaxError(`Add a method: db.${collection}.find()`, text.trimEnd().length)
    }
    if (methodSeg.kind !== 'prop' || !isCall(i + 1))
      throw new ShellSyntaxError('Expected a method call', methodSeg.start)
    methodIndex = i
  }

  const methodSeg = at(methodIndex) as Extract<Segment, { kind: 'prop' }>
  const methodCall = at(methodIndex + 1) as Extract<Segment, { kind: 'call' }>
  let method = methodSeg.name
  let methodRange: MongoShellRange = { start: methodSeg.start, end: methodSeg.end }
  let argNodes = methodCall.args
  let explain: MongoShellStructure['explain']
  let explainArgNodes: MongoShellArgNode[] = []
  let j = methodIndex + 2

  if (kind === 'collection') {
    if (!Object.prototype.hasOwnProperty.call(MONGO_COLLECTION_METHODS, method)) {
      const jsHint = /^(forEach|map|filter|next|hasNext|itcount|length|then)$/.test(method)
        ? ' (JavaScript iteration is not supported; the result is shown as a list)'
        : ''
      throw new ShellSyntaxError(`Unknown collection method ${method}()${jsHint}`, methodSeg.start)
    }
    if (method === 'explain') {
      checkArity('explain', MONGO_COLLECTION_METHODS.explain, argNodes, methodCall.start)
      explainArgNodes = argNodes
      explain = { argRanges: argNodes.map(rangeOf), prefix: true }
      const next = at(j)
      if (
        !next ||
        next.kind !== 'prop' ||
        !isCall(j + 1) ||
        !MONGO_EXPLAINABLE_METHODS.includes(next.name)
      ) {
        throw new ShellSyntaxError(
          'explain() must be followed by find(), aggregate(), count() or distinct()',
          next?.start ?? text.trimEnd().length
        )
      }
      method = next.name
      methodRange = { start: next.start, end: next.end }
      argNodes = (at(j + 1) as Extract<Segment, { kind: 'call' }>).args
      j += 2
    }
  }

  const info: MongoMethodInfo =
    kind === 'collection' ? MONGO_COLLECTION_METHODS[method] : MONGO_DATABASE_METHODS[method]
  checkArity(method, info, argNodes, methodRange.end)

  // Cursor modifiers
  const modifiers: string[] = []
  const modifierCalls: MongoShellModifier[] = []
  const modifierArgNodes: MongoShellArgNode[][] = []
  let terminal: string | null = null
  while (j < segments.length) {
    const seg = segments[j]
    if (seg.kind !== 'prop') throw new ShellSyntaxError('Unexpected call', seg.start)
    if (!isCall(j + 1)) {
      throw new ShellSyntaxError(
        `Property access .${seg.name} is not supported; only modifier calls like .sort({...})`,
        seg.start
      )
    }
    const call = at(j + 1) as Extract<Segment, { kind: 'call' }>
    const modifier = Object.prototype.hasOwnProperty.call(MONGO_CURSOR_METHODS, seg.name)
      ? MONGO_CURSOR_METHODS[seg.name]
      : undefined
    if (!modifier || !modifier.appliesTo.includes(method)) {
      throw new ShellSyntaxError(`.${seg.name}() is not supported after ${method}()`, seg.start)
    }
    if (terminal && seg.name !== 'pretty') {
      throw new ShellSyntaxError(`.${seg.name}() cannot follow .${terminal}()`, seg.start)
    }
    if (
      explain &&
      (seg.name === 'explain' ||
        seg.name === 'count' ||
        seg.name === 'size' ||
        seg.name === 'itcount')
    ) {
      throw new ShellSyntaxError(`.${seg.name}() cannot be combined with explain()`, seg.start)
    }
    checkArity(seg.name, modifier, call.args, call.end - 1)
    if (modifier.terminal) terminal = seg.name
    if (seg.name === 'explain') {
      explain = { argRanges: call.args.map(rangeOf), prefix: false }
      explainArgNodes = call.args
    }
    modifiers.push(seg.name)
    modifierCalls.push({
      name: seg.name,
      start: seg.exprStart,
      end: call.end,
      argRanges: call.args.map(rangeOf)
    })
    modifierArgNodes.push(call.args)
    j += 2
  }

  checkArgs(text, argNodes)
  for (const nodes of modifierArgNodes) checkArgs(text, nodes)
  checkArgs(text, explainArgNodes)

  const structure: MongoShellStructure = {
    kind,
    method,
    modifiers,
    argRanges: argNodes.map(rangeOf),
    modifierCalls,
    methodRange
  }
  if (database !== undefined) structure.database = database
  if (collection !== undefined) structure.collection = collection
  if (explain) structure.explain = explain
  if (method === 'aggregate') {
    const pipeline = argNodes[0]
    if (pipeline?.type === 'ArrayExpression') {
      structure.stageNames = pipeline.elements.map((element) => {
        if (element?.type !== 'ObjectExpression' || element.properties.length === 0) return '?'
        return mongoPropertyKey(element.properties[0]) ?? '?'
      })
    }
  }
  if (kind === 'database' && (method === 'runCommand' || method === 'adminCommand')) {
    const command = argNodes[0]
    const asString = literalString(command)
    if (asString !== undefined) structure.commandName = asString
    else if (command?.type === 'ObjectExpression' && command.properties.length > 0) {
      structure.commandName = mongoPropertyKey(command.properties[0]) ?? undefined
    }
  }
  return ok(text, structure, argNodes, modifierArgNodes, explainArgNodes)
}

/**
 * Parses one statement (as returned by `splitMongoShell`) into its structure plus argument
 * ASTs. Offsets in the result and in errors are relative to `text`.
 */
export function parseMongoShell(text: string): MongoShellParseResult {
  const line = parseLineCommand(text)
  if (line) return line
  let program: Program
  try {
    program = acornParse(text, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: false,
      allowHashBang: false
    })
  } catch (error) {
    const pos = (error as { pos?: number }).pos
    const message =
      error instanceof Error ? error.message.replace(/\s*\(\d+:\d+\)\s*$/, '') : String(error)
    return fail(`Syntax error: ${message}`, typeof pos === 'number' ? pos : 0)
  }
  const body = program.body.filter((statement) => statement.type !== 'EmptyStatement')
  if (body.length === 0) return fail('Empty statement', skipMongoTrivia(text, 0))
  if (body.length > 1) {
    return fail(
      'Run one statement at a time: put each statement on its own line or end it with ";"',
      body[1].start
    )
  }
  const statement = body[0]
  if (statement.type !== 'ExpressionStatement') return fail(START_HINT, statement.start)
  let expression = statement.expression as AcornNode
  if (expression.type === 'AwaitExpression') {
    expression = (expression as unknown as { argument: AcornNode }).argument
  }
  try {
    const segments: Segment[] = []
    flatten(expression, segments)
    return interpret(text, segments)
  } catch (error) {
    if (error instanceof ShellSyntaxError) return fail(error.message, error.offset)
    throw error
  }
}

/** The structure of one statement, or `{ error }` (renderer-safe: no BSON conversion). */
export function parseMongoShellStructure(text: string): MongoShellStructure | MongoShellParseError {
  const result = parseMongoShell(text)
  return result.ok ? result.value.structure : { error: result.error }
}
