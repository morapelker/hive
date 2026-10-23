// Turns a raw explain document into the summary card (winning plan stages root → leaf, index
// used, docs/keys examined, documents returned, time). Explain output differs by server version,
// query engine (classic `winningPlan.inputStage` vs SBE `winningPlan.queryPlan`), command (find,
// aggregate with a `stages` array, count, distinct) and topology (sharded `shards[]`), so this
// walks the document defensively instead of trusting one shape. Works on plain JS values (the
// driver's promoted explain output).

import type { MongoExplainResponse } from '../../../../shared/data-projects/types'
import { toNumberValue } from './runtime'

type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Depth-first search for the first object satisfying `match`. */
function findFirst(value: unknown, match: (obj: Obj) => boolean, depth = 0): Obj | null {
  if (depth > 40) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirst(item, match, depth + 1)
      if (found) return found
    }
    return null
  }
  if (!isObj(value)) return null
  if (match(value)) return value
  for (const child of Object.values(value)) {
    const found = findFirst(child, match, depth + 1)
    if (found) return found
  }
  return null
}

const SCAN_STAGES = new Set([
  'IXSCAN',
  'COUNT_SCAN',
  'DISTINCT_SCAN',
  'EXPRESS_IXSCAN',
  'EXPRESS_UPDATE',
  'EXPRESS_DELETE'
])

/** Stage names of a plan tree, root → leaf (pre-order), and the index it scans. */
function walkPlan(node: unknown, stages: string[], indexes: string[], depth = 0): void {
  if (!isObj(node) || depth > 60) return
  const plan = isObj(node.queryPlan) ? node.queryPlan : node
  if (typeof plan.stage === 'string') {
    stages.push(plan.stage)
    if (typeof plan.indexName === 'string' && SCAN_STAGES.has(plan.stage))
      indexes.push(plan.indexName)
    if (
      plan.stage === 'IDHACK' ||
      plan.stage === 'EXPRESS_IDHACK' ||
      plan.stage === 'EXPRESS_CLUSTERED_IXSCAN'
    ) {
      indexes.push('_id_')
    }
  }
  for (const key of ['inputStage', 'outerStage', 'innerStage', 'thenStage', 'elseStage']) {
    if (isObj(plan[key])) walkPlan(plan[key], stages, indexes, depth + 1)
  }
  if (Array.isArray(plan.inputStages)) {
    for (const child of plan.inputStages) walkPlan(child, stages, indexes, depth + 1)
  }
  if (Array.isArray(plan.shards)) {
    for (const shard of plan.shards) {
      if (isObj(shard)) walkPlan(shard.winningPlan ?? shard, stages, indexes, depth + 1)
    }
  }
}

const num = (value: unknown): number | null => {
  const n = toNumberValue(value)
  return n === null || Number.isNaN(n) ? null : n
}

export function summarizeExplain(raw: Obj): MongoExplainResponse['summary'] {
  const stages: string[] = []
  const indexes: string[] = []

  // Pipeline stages that ran after the query layer ($group, $sort... when not pushed down).
  const pipelineStages = Array.isArray(raw.stages) ? raw.stages.filter(isObj) : []
  const afterCursor = pipelineStages
    .map((stage) => Object.keys(stage).find((key) => key.startsWith('$')))
    .filter((name): name is string => !!name && name !== '$cursor')

  const planner = findFirst(raw, (obj) => isObj(obj.winningPlan))
  if (planner) walkPlan(planner.winningPlan, stages, indexes)

  // Fallback for EQ_LOOKUP-only plans: report the index it joined on.
  if (indexes.length === 0 && planner) {
    const lookup = findFirst(planner.winningPlan, (obj) => typeof obj.indexName === 'string')
    if (lookup) indexes.push(String(lookup.indexName))
  }

  const stats = findFirst(raw, (obj) => isObj(obj.executionStats))?.executionStats as
    Obj | undefined
  let nReturned = num(stats?.nReturned)
  let executionTimeMs = num(stats?.executionTimeMillis)
  const lastStage = pipelineStages[pipelineStages.length - 1]
  if (lastStage && afterCursor.length > 0) {
    const stageReturned = num(lastStage.nReturned)
    if (stageReturned !== null) nReturned = stageReturned
    const stageTime = num(lastStage.executionTimeMillisEstimate)
    if (stageTime !== null && (executionTimeMs === null || stageTime > executionTimeMs))
      executionTimeMs = stageTime
  }

  return {
    stages: [...afterCursor.reverse(), ...stages],
    indexName: indexes[0] ?? null,
    docsExamined: num(stats?.totalDocsExamined),
    keysExamined: num(stats?.totalKeysExamined),
    nReturned,
    executionTimeMs
  }
}
