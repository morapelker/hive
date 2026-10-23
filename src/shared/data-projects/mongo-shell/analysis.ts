// Safety facts about Mongo operations that both the shell classifier (on acorn ASTs) and the
// server (on parsed BSON values from the Documents/Aggregations tabs) need: $out/$merge at any
// depth, server-side JavaScript operators, "empty filter" detection, and the exact warning
// texts. Keeping the texts here means a deleteMany({}) typed in the shell and the bulk-delete
// button produce the same red warning, and both match the gate's destructive-reason pattern
// (production type-to-confirm).

import type { Expression, Node as AcornNode, ObjectExpression } from 'acorn'
import { mongoPropertyKey } from './parser'

/** Operators that run JavaScript on the server: flagged, never blocked by themselves. */
export const MONGO_SERVER_JS_OPERATORS: readonly string[] = ['$where', '$function', '$accumulator']

export const MONGO_OUTPUT_STAGES: readonly string[] = ['$out', '$merge']

/** Red warning texts (DataPlannedStatement.dangerous). */
export const MONGO_DANGER = {
  deleteManyAll: (collection: string): string =>
    `deleteMany with an empty filter deletes every document in "${collection}"`,
  updateManyAll: (collection: string): string =>
    `updateMany with an empty filter updates every document in "${collection}"`,
  drop: (collection: string): string =>
    `drop() deletes collection "${collection}" and all its documents`,
  dropDatabase: (database: string | undefined): string =>
    `dropDatabase() deletes database ${database ? `"${database}"` : '(the current database)'} and everything in it`,
  dropIndexesAll: (collection: string): string =>
    `dropIndexes() drops every index of "${collection}" except _id`,
  dropIndexes: (collection: string): string => `dropIndexes drops indexes of "${collection}"`,
  dropIndex: (name: string, collection: string): string =>
    `dropIndex drops index "${name}" of "${collection}"`,
  out: (target: string | null): string =>
    `$out replaces ${target ? `collection "${target}"` : 'the target collection'} with the pipeline output`,
  merge: (target: string | null): string =>
    `$merge writes the pipeline output into ${target ? `collection "${target}"` : 'another collection'}`,
  renameDropTarget: (to: string): string =>
    `renameCollection with dropTarget drops the existing collection "${to}"`,
  serverJs: (operator: string): string =>
    `${operator} runs JavaScript on the server (slow; disabled on some deployments)`,
  shutdown: (): string => 'shutdown stops the database server',
  commandDeleteAll: (collection: string): string =>
    `delete command with an empty filter deletes every document in "${collection}"`,
  commandUpdateAll: (collection: string): string =>
    `update command with an empty filter and multi: true updates every document in "${collection}"`
} as const

// ---------------------------------------------------------------------------------------------
// Value-level (parsed BSON values)
// ---------------------------------------------------------------------------------------------

/** A plain JS object (not a BSON value, Date, RegExp, array or buffer). */
export function isPlainMongoObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if ('_bsontype' in value) return false
  if (value instanceof Date || value instanceof RegExp || ArrayBuffer.isView(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** A missing filter, null, or `{}`: matches every document. */
export function isEmptyMongoFilter(value: unknown): boolean {
  if (value === undefined || value === null) return true
  return isPlainMongoObject(value) && Object.keys(value).length === 0
}

export interface MongoOutputStage {
  stage: '$out' | '$merge'
  /** Target collection ("db.coll" when another database), null when not a literal. */
  target: string | null
}

function outputTarget(stage: '$out' | '$merge', spec: unknown): string | null {
  if (typeof spec === 'string') return spec
  if (!isPlainMongoObject(spec)) return null
  const into = stage === '$merge' ? spec.into : spec
  if (typeof into === 'string') return into
  if (isPlainMongoObject(into) && typeof into.coll === 'string') {
    return typeof into.db === 'string' ? `${into.db}.${into.coll}` : into.coll
  }
  return null
}

function walkValue(value: unknown, visit: (key: string, child: unknown) => void, depth = 0): void {
  if (depth > 64) return
  if (Array.isArray(value)) {
    for (const item of value) walkValue(item, visit, depth + 1)
    return
  }
  if (!isPlainMongoObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    visit(key, child)
    walkValue(child, visit, depth + 1)
  }
}

/** $out / $merge anywhere in a pipeline value (nested $facet / $lookup / $unionWith included). */
export function findMongoOutputStages(pipeline: unknown): MongoOutputStage[] {
  const found: MongoOutputStage[] = []
  walkValue(pipeline, (key, child) => {
    if (key === '$out' || key === '$merge')
      found.push({ stage: key, target: outputTarget(key, child) })
  })
  return found
}

/** Server-side JavaScript operators used anywhere in the value (unique, in first-seen order). */
export function findMongoServerJs(value: unknown): string[] {
  const found = new Set<string>()
  walkValue(value, (key) => {
    if (MONGO_SERVER_JS_OPERATORS.includes(key)) found.add(key)
  })
  return [...found]
}

/** True when the last top-level stage writes ($out/$merge): the pipeline returns no documents. */
export function pipelineEndsWithOutput(pipeline: unknown): boolean {
  if (!Array.isArray(pipeline) || pipeline.length === 0) return false
  const last = pipeline[pipeline.length - 1]
  return isPlainMongoObject(last) && ('$out' in last || '$merge' in last)
}

// ---------------------------------------------------------------------------------------------
// AST-level (shell statements, no BSON)
// ---------------------------------------------------------------------------------------------

/** Value node of `key` in an object literal, or undefined. */
export function astProperty(node: AcornNode | undefined, key: string): Expression | undefined {
  if (!node || node.type !== 'ObjectExpression') return undefined
  for (const property of (node as ObjectExpression).properties) {
    if (property.type === 'Property' && mongoPropertyKey(property) === key) return property.value
  }
  return undefined
}

/** A string literal's value. */
export function astString(node: AcornNode | undefined): string | undefined {
  if (!node || node.type !== 'Literal') return undefined
  const value = (node as unknown as { value: unknown }).value
  return typeof value === 'string' ? value : undefined
}

/** Missing, `{}`, `null` or `undefined`. */
export function isEmptyFilterNode(node: AcornNode | undefined): boolean {
  if (!node) return true
  if (node.type === 'ObjectExpression') return (node as ObjectExpression).properties.length === 0
  if (node.type === 'Literal') return (node as unknown as { value: unknown }).value === null
  if (node.type === 'Identifier') return (node as unknown as { name: string }).name === 'undefined'
  return false
}

/** Calls `visit` for every object property at any depth of an argument AST. */
export function walkAstProperties(
  node: AcornNode | null | undefined,
  visit: (key: string, value: Expression) => void,
  depth = 0
): void {
  if (!node || depth > 64) return
  switch (node.type) {
    case 'ObjectExpression':
      for (const property of (node as ObjectExpression).properties) {
        if (property.type !== 'Property') continue
        const key = mongoPropertyKey(property)
        if (key !== null) visit(key, property.value)
        walkAstProperties(property.value, visit, depth + 1)
      }
      return
    case 'ArrayExpression':
      for (const element of (node as unknown as { elements: Array<AcornNode | null> }).elements) {
        walkAstProperties(element, visit, depth + 1)
      }
      return
    case 'CallExpression':
    case 'NewExpression':
      for (const arg of (node as unknown as { arguments: AcornNode[] }).arguments) {
        walkAstProperties(arg, visit, depth + 1)
      }
      return
    default:
      return
  }
}

function astOutputTarget(stage: '$out' | '$merge', spec: Expression): string | null {
  const asString = astString(spec)
  if (asString !== undefined) return asString
  const into = stage === '$merge' ? astProperty(spec, 'into') : spec
  const intoString = astString(into)
  if (intoString !== undefined) return intoString
  const coll = astString(astProperty(into, 'coll'))
  if (coll === undefined) return null
  const db = astString(astProperty(into, 'db'))
  return db !== undefined ? `${db}.${coll}` : coll
}

/** $out / $merge anywhere in a pipeline AST. */
export function findAstOutputStages(node: AcornNode | undefined): MongoOutputStage[] {
  const found: MongoOutputStage[] = []
  walkAstProperties(node, (key, value) => {
    if (key === '$out' || key === '$merge')
      found.push({ stage: key, target: astOutputTarget(key, value) })
  })
  return found
}

/** Server-side JavaScript operators anywhere in the argument ASTs. */
export function findAstServerJs(nodes: readonly (AcornNode | undefined)[]): string[] {
  const found = new Set<string>()
  for (const node of nodes) {
    walkAstProperties(node, (key) => {
      if (MONGO_SERVER_JS_OPERATORS.includes(key)) found.add(key)
    })
  }
  return [...found]
}
