// Read/write classification of one mongosh-style statement (safety.md §A6) plus the red
// "dangerous" warnings of §A7. It works on the structure + argument ASTs, before anything runs,
// and is exact for the supported grammar: a statement the parser rejects is 'unknown', an
// unknown runCommand is 'unknown', and an aggregate is a write as soon as $out/$merge appears
// at any depth. The renderer uses it for the READ/WRITE badge; the server's copy is the one
// that counts (the query runner gates on it and the driver re-checks inside its read sandbox).

import type { Node as AcornNode } from 'acorn'
import type { DataStatementClass } from '../types'
import {
  MONGO_DANGER,
  astProperty,
  astString,
  findAstOutputStages,
  findAstServerJs,
  isEmptyFilterNode
} from './analysis'
import {
  MONGO_ADMIN_COMMANDS,
  MONGO_COLLECTION_METHODS,
  MONGO_DATABASE_METHODS,
  MONGO_DDL_COMMANDS,
  MONGO_READ_COMMANDS,
  MONGO_WRITE_COMMANDS,
  type MongoMethodOutput
} from './methods'
import {
  mongoPropertyKey,
  parseMongoShell,
  type MongoShellArgNode,
  type MongoShellParsed
} from './parser'

export interface MongoShellClassification {
  classification: DataStatementClass
  /** Red warnings shown in every safe mode (empty-filter deletes, drops, $out, server JS...). */
  dangerous: string[]
  /** Why it is not a plain read ("modifies documents", "unknown command x", parse error...). */
  reasons: string[]
  /** True when the statement produces a document list (grid / JSON views). */
  returnsDocuments: boolean
  /** What the statement produces; null when it does not parse. */
  output: MongoMethodOutput | null
  /** Database the statement runs in (use target / getSiblingDB, else the context database). */
  database?: string
  collection?: string
  /** Objects for the production type-to-confirm (SafetyStatementInput.targets). */
  targets: string[]
  /** Set when the text is not a supported statement (classification is then 'unknown'). */
  error?: { message: string; offset: number }
}

export interface MongoClassifyContext {
  /** The database the statement will run in when it does not name one (tab / session db). */
  database?: string
}

const REASON: Record<DataStatementClass, string> = {
  read: 'reads data',
  session: 'switches the current database',
  tx: 'transaction control',
  lock: 'takes locks',
  write: 'modifies documents',
  ddl: 'changes collections or indexes',
  admin: 'administrative command',
  unknown: 'not a recognised statement'
}

interface CommandVerdict {
  classification: DataStatementClass
  dangerous: string[]
  reasons: string[]
  targets: string[]
}

/** A numeric literal, including a signed one (`-1` is a UnaryExpression in the AST). */
function astNumber(node: MongoShellArgNode): number | undefined {
  if (node.type === 'Literal') return typeof node.value === 'number' ? node.value : undefined
  if (node.type !== 'UnaryExpression' || (node.operator !== '-' && node.operator !== '+'))
    return undefined
  const inner = astNumber(node.argument)
  return inner === undefined || node.operator === '+' ? inner : -inner
}

/**
 * `{ profile: -1 }` (optionally with a `comment`) only reports the profiler settings. Any other
 * level, the string form (`runCommand('profile')` sends `{ profile: 1 }`), or slowms /
 * sampleRate / filter next to -1 changes them, so only this exact shape is a read. A repeated
 * `profile` key is not, because the last one is what reaches the server.
 */
function isProfileStatusOnly(node: MongoShellArgNode | undefined): boolean {
  if (node?.type !== 'ObjectExpression') return false
  let levels = 0
  let level: number | undefined
  for (const property of node.properties) {
    const key = mongoPropertyKey(property)
    if (key === 'comment') continue
    if (key !== 'profile' || property.type !== 'Property') return false
    levels++
    level = astNumber(property.value)
  }
  return levels === 1 && level === -1
}

/** runCommand / adminCommand: classified by the command name (its first key). */
function classifyCommand(
  node: MongoShellArgNode | undefined,
  name: string | undefined,
  database: string | undefined
): CommandVerdict {
  const verdict: CommandVerdict = {
    classification: 'unknown',
    dangerous: [],
    reasons: [],
    targets: []
  }
  if (!name) {
    verdict.reasons.push('the command must be a literal document such as { ping: 1 }')
    return verdict
  }
  const target = astString(astProperty(node, name))
  if (name === 'profile') {
    if (isProfileStatusOnly(node)) {
      verdict.classification = 'read'
    } else {
      verdict.classification = 'admin'
      verdict.reasons.push('profile changes the database profiler settings')
    }
    return verdict
  }
  if (name === 'features' && astProperty(node, 'oidReset') !== undefined) {
    // { features: 1, oidReset: true } regenerates the server's ObjectId machine id.
    verdict.classification = 'admin'
    verdict.reasons.push('features with oidReset resets the ObjectId generator')
    return verdict
  }
  if (MONGO_READ_COMMANDS.has(name)) {
    verdict.classification = 'read'
    if (name === 'aggregate' || name === 'explain') {
      // explain { aggregate: ..., pipeline: [{ $out }] } could persist output on old servers.
      const outputs = findAstOutputStages(node)
      if (outputs.length > 0) {
        verdict.classification = 'write'
        verdict.reasons.push('aggregate with $out/$merge writes to a collection')
        for (const out of outputs) {
          verdict.dangerous.push(
            out.stage === '$out' ? MONGO_DANGER.out(out.target) : MONGO_DANGER.merge(out.target)
          )
          if (out.target) verdict.targets.push(out.target)
        }
      }
    }
    return verdict
  }
  if (MONGO_WRITE_COMMANDS.has(name)) {
    verdict.classification = 'write'
    verdict.reasons.push(`${name} ${REASON.write}`)
    if (target) verdict.targets.push(target)
    if (name === 'delete') {
      const deletes = astProperty(node, 'deletes')
      if (deletes?.type === 'ArrayExpression') {
        for (const element of deletes.elements) {
          const limit = astProperty(element ?? undefined, 'limit')
          const unlimited =
            limit?.type === 'Literal' && (limit as unknown as { value: unknown }).value === 0
          if (element && unlimited && isEmptyFilterNode(astProperty(element, 'q'))) {
            verdict.dangerous.push(MONGO_DANGER.commandDeleteAll(target ?? '?'))
          }
        }
      }
    }
    if (name === 'update') {
      const updates = astProperty(node, 'updates')
      if (updates?.type === 'ArrayExpression') {
        for (const element of updates.elements) {
          const multi = astProperty(element ?? undefined, 'multi')
          const isMulti =
            multi?.type === 'Literal' && (multi as unknown as { value: unknown }).value === true
          if (element && isMulti && isEmptyFilterNode(astProperty(element, 'q'))) {
            verdict.dangerous.push(MONGO_DANGER.commandUpdateAll(target ?? '?'))
          }
        }
      }
    }
    return verdict
  }
  if (MONGO_DDL_COMMANDS.has(name)) {
    verdict.classification = 'ddl'
    verdict.reasons.push(`${name} ${REASON.ddl}`)
    if (name === 'drop' && target) {
      verdict.dangerous.push(MONGO_DANGER.drop(target))
      verdict.targets.push(target)
    } else if (name === 'dropDatabase') {
      verdict.dangerous.push(MONGO_DANGER.dropDatabase(database))
      if (database) verdict.targets.push(database)
    } else if ((name === 'dropIndexes' || name === 'deleteIndexes') && target) {
      const which = astString(astProperty(node, 'index'))
      verdict.dangerous.push(
        which === '*' ? MONGO_DANGER.dropIndexesAll(target) : MONGO_DANGER.dropIndexes(target)
      )
      verdict.targets.push(target)
    } else if (name === 'renameCollection') {
      const dropTarget = astProperty(node, 'dropTarget')
      const to = astString(astProperty(node, 'to'))
      if (
        dropTarget?.type === 'Literal' &&
        (dropTarget as unknown as { value: unknown }).value === true &&
        to
      ) {
        verdict.dangerous.push(MONGO_DANGER.renameDropTarget(to))
        verdict.targets.push(to)
      }
    } else if (target) {
      verdict.targets.push(target)
    }
    return verdict
  }
  if (MONGO_ADMIN_COMMANDS.has(name)) {
    verdict.classification = 'admin'
    verdict.reasons.push(`${name} is an ${REASON.admin}`)
    if (name === 'shutdown') verdict.dangerous.push(MONGO_DANGER.shutdown())
    return verdict
  }
  verdict.reasons.push(`unknown command "${name}"`)
  return verdict
}

/** Classifies an already-parsed statement (the server reuses its parse). */
export function classifyParsedMongoShell(
  parsed: MongoShellParsed,
  context: MongoClassifyContext = {}
): MongoShellClassification {
  const { structure, argNodes } = parsed
  const database = structure.database ?? context.database
  const collection = structure.collection
  const result: MongoShellClassification = {
    classification: 'read',
    dangerous: [],
    reasons: [],
    returnsDocuments: false,
    output: 'value',
    targets: []
  }
  if (database !== undefined) result.database = database
  if (collection !== undefined) result.collection = collection

  if (structure.kind === 'use') {
    result.classification = 'session'
    result.reasons.push(REASON.session)
    result.output = 'command'
    return result
  }
  if (structure.kind === 'show') {
    result.output = 'documents'
    result.returnsDocuments = true
    return result
  }

  const info =
    structure.kind === 'collection'
      ? MONGO_COLLECTION_METHODS[structure.method]
      : MONGO_DATABASE_METHODS[structure.method]
  result.classification = info.statementClass
  result.output = info.output
  const coll = collection ?? '?'
  const explained = structure.explain !== undefined

  switch (structure.method) {
    case 'aggregate': {
      const outputs = findAstOutputStages(argNodes[0])
      if (outputs.length > 0 && !explained) {
        result.classification = 'write'
        result.reasons.push('aggregate with $out/$merge writes to a collection')
        result.output = 'command'
        for (const out of outputs) {
          result.dangerous.push(
            out.stage === '$out' ? MONGO_DANGER.out(out.target) : MONGO_DANGER.merge(out.target)
          )
          if (out.target) result.targets.push(out.target)
        }
      }
      break
    }
    case 'deleteMany':
      if (isEmptyFilterNode(argNodes[0])) result.dangerous.push(MONGO_DANGER.deleteManyAll(coll))
      result.targets.push(coll)
      break
    case 'updateMany':
      if (isEmptyFilterNode(argNodes[0])) result.dangerous.push(MONGO_DANGER.updateManyAll(coll))
      result.targets.push(coll)
      break
    case 'bulkWrite': {
      const ops = argNodes[0]
      if (ops?.type === 'ArrayExpression') {
        for (const op of ops.elements) {
          const del = astProperty(op ?? undefined, 'deleteMany')
          if (del && isEmptyFilterNode(astProperty(del, 'filter')))
            result.dangerous.push(MONGO_DANGER.deleteManyAll(coll))
          const upd = astProperty(op ?? undefined, 'updateMany')
          if (upd && isEmptyFilterNode(astProperty(upd, 'filter')))
            result.dangerous.push(MONGO_DANGER.updateManyAll(coll))
        }
      }
      result.targets.push(coll)
      break
    }
    case 'drop':
      result.dangerous.push(MONGO_DANGER.drop(coll))
      result.targets.push(coll)
      break
    case 'dropIndexes': {
      const which = argNodes[0]
      const all = !which || astString(which) === '*'
      result.dangerous.push(
        all ? MONGO_DANGER.dropIndexesAll(coll) : MONGO_DANGER.dropIndexes(coll)
      )
      result.targets.push(coll)
      break
    }
    case 'dropIndex': {
      const name = astString(argNodes[0])
      result.dangerous.push(MONGO_DANGER.dropIndex(name ?? 'by key pattern', coll))
      result.targets.push(name ?? coll)
      break
    }
    case 'renameCollection': {
      const to = astString(argNodes[0])
      const dropTarget = argNodes[1]
      if (
        dropTarget?.type === 'Literal' &&
        (dropTarget as unknown as { value: unknown }).value === true &&
        to
      ) {
        result.dangerous.push(MONGO_DANGER.renameDropTarget(to))
        result.targets.push(to)
      } else {
        result.targets.push(coll)
      }
      break
    }
    case 'dropDatabase':
      result.dangerous.push(MONGO_DANGER.dropDatabase(database))
      if (database) result.targets.push(database)
      break
    case 'runCommand':
    case 'adminCommand': {
      const verdict = classifyCommand(
        argNodes[0],
        structure.commandName,
        structure.method === 'adminCommand' ? 'admin' : database
      )
      result.classification = verdict.classification
      result.dangerous.push(...verdict.dangerous)
      result.reasons.push(...verdict.reasons)
      result.targets.push(...verdict.targets)
      break
    }
    default:
      if (info.write && collection) result.targets.push(collection)
      break
  }

  if (explained) {
    // explain never runs the write: the executor forces queryPlanner and strips $out/$merge.
    result.classification = 'read'
    result.output = 'value'
    result.reasons = []
    result.dangerous = []
    result.targets = []
  } else if (
    structure.modifiers.some((name) => name === 'count' || name === 'size' || name === 'itcount')
  ) {
    result.output = 'value'
  }

  const serverJs = findAstServerJs([...argNodes, ...parsed.modifierArgNodes.flat()] as AcornNode[])
  for (const operator of serverJs) result.dangerous.push(MONGO_DANGER.serverJs(operator))

  if (result.classification !== 'read' && result.reasons.length === 0) {
    result.reasons.push(REASON[result.classification])
  }
  result.returnsDocuments = result.output === 'documents'
  return result
}

/**
 * Classifies one statement (as split by `splitMongoShell`). Never throws: text that does not
 * parse is 'unknown' with the parse error attached.
 */
export function classifyMongoShellStatement(
  text: string,
  context: MongoClassifyContext = {}
): MongoShellClassification {
  const parsed = parseMongoShell(text)
  if (!parsed.ok) {
    return {
      classification: 'unknown',
      dangerous: [],
      reasons: [parsed.error.message],
      returnsDocuments: false,
      output: null,
      targets: [],
      error: parsed.error,
      ...(context.database !== undefined ? { database: context.database } : {})
    }
  }
  return classifyParsedMongoShell(parsed.value, context)
}

/** Alias used by design.md §6 ("classifyMongoCommand for Mongo"). */
export const classifyMongoCommand = classifyMongoShellStatement
