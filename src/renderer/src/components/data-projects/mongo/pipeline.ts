// Aggregation pipeline helpers for the Aggregations tab: stage cards ⇄ one pipeline text, the
// request shaping of per-stage previews, $out/$merge detection and default stage bodies.
//
// Text mode must not lose anything the cards hold, including disabled stages. They are written
// as line comments that start with `// disabled:` (line comments cannot be broken by a `*/`
// inside the stage, unlike block comments); the server's loose parser ignores them if that text
// is ever sent as is, and converting back to cards revives them, disabled.
//
// A stage body is kept dedented (as typed in its card); building the pipeline indents it. A body
// that ends with a line comment (`{ status: 'A' } // only shipped`, which text mode produces
// from a commented pipeline) is always written in the multi-line form, so the comment cannot
// swallow the stage's closing brace.

import type { MongoAggregateRequest } from '@shared/data-projects/types'
import { lexShell, stringTokenValue, type ShellToken } from './shell-lexer'

export interface MongoStageDraft {
  /** '$match', '$group'… */
  operator: string
  /** Stage value as shell text (`{ status: 'A' }`, `10`, `'$items'`). */
  body: string
  enabled: boolean
}

export const OUTPUT_STAGES = new Set(['$out', '$merge'])

const DISABLED_MARK = 'disabled:'

/** Removes the common indentation of every line but the first (which is already trimmed). */
export function dedentBody(text: string): string {
  const lines = text.trim().split('\n')
  if (lines.length === 1) return lines[0]
  const rest = lines.slice(1)
  const indents = rest.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return [lines[0], ...rest.map((l) => l.slice(Math.min(cut, /^[ \t]*/.exec(l)![0].length)))].join(
    '\n'
  )
}

/** True when the text's last token is a `//` comment (it runs to the end of its line). */
const endsWithLineComment = (text: string): boolean => {
  const last = lexShell(text).at(-1)
  return last?.type === 'comment' && last.text.startsWith('//')
}

/** `{ $match: body }` with the body's continuation lines indented under `pad`. */
export function stageToText(stage: Pick<MongoStageDraft, 'operator' | 'body'>, pad = ''): string {
  const body = dedentBody(stage.body) || '{}'
  const lines = body.split('\n')
  if (lines.length === 1 && !endsWithLineComment(body)) return `{ ${stage.operator}: ${body} }`
  const inner = `${pad}  `
  return [
    '{',
    `${inner}${stage.operator}: ${lines[0]}`,
    ...lines.slice(1).map((l) => (l ? `${inner}${l}` : l)),
    `${pad}}`
  ].join('\n')
}

/** The enabled stages as a pipeline array ('[]' when there is none). */
export function buildPipelineText(stages: readonly MongoStageDraft[]): string {
  const enabled = stages.filter((s) => s.enabled)
  if (enabled.length === 0) return '[]'
  return `[\n${enabled.map((s) => `  ${stageToText(s, '  ')}`).join(',\n')}\n]`
}

/** Every stage for text mode; disabled ones as `// disabled:` comment blocks. */
export function pipelineEditorText(stages: readonly MongoStageDraft[]): string {
  if (stages.length === 0) return '[\n  \n]'
  const parts: string[] = []
  const enabledCount = stages.filter((s) => s.enabled).length
  let enabledSeen = 0
  for (const stage of stages) {
    const text = stageToText(stage, '  ')
    if (stage.enabled) {
      enabledSeen++
      parts.push(`  ${text}${enabledSeen < enabledCount ? ',' : ''}`)
    } else {
      const lines = text.split('\n')
      parts.push(
        lines
          .map((line, i) =>
            i === 0 ? `  // ${DISABLED_MARK} ${line}` : `  // ${line.replace(/^ {2}/, '')}`
          )
          .join('\n')
      )
    }
  }
  return `[\n${parts.join('\n')}\n]`
}

export type ParsePipelineResult =
  { ok: true; stages: MongoStageDraft[] } | { ok: false; error: string; offset: number }

function depthOf(tokens: readonly ShellToken[]): { depth: number; opened: boolean } {
  let depth = 0
  let opened = false
  for (const t of tokens) {
    if (t.type !== 'punct') continue
    if (t.text === '{' || t.text === '[' || t.text === '(') {
      depth++
      opened = true
    } else if (t.text === '}' || t.text === ']' || t.text === ')') depth--
  }
  return { depth, opened }
}

/** One `{ $op: value }` element → operator + dedented body. */
function parseStageElement(
  text: string,
  offset: number,
  ordinal: number
): { ok: true; operator: string; body: string } | { ok: false; error: string; offset: number } {
  const tokens = lexShell(text).filter((t) => t.type !== 'comment')
  const fail = (error: string, at = 0) => ({ ok: false as const, error, offset: offset + at })
  if (!tokens.length || tokens[0].text !== '{' || tokens.at(-1)?.text !== '}')
    return fail(`Stage ${ordinal} must be an object such as { $match: { … } }`)
  const keyToken = tokens[1]
  if (!keyToken || keyToken.text === '}') return fail(`Stage ${ordinal} is empty`, tokens[0].start)
  const key =
    keyToken.type === 'ident'
      ? keyToken.text
      : keyToken.type === 'string'
        ? stringTokenValue(keyToken)
        : null
  if (key === null || tokens[2]?.text !== ':')
    return fail(`Stage ${ordinal}: expected an operator such as $match:`, keyToken.start)
  if (!key.startsWith('$'))
    return fail(
      `Stage ${ordinal}: '${key}' is not a stage operator (they start with $)`,
      keyToken.start
    )
  // The value runs to the first comma or closing brace at the element's own depth.
  let depth = 0
  let valueEnd = tokens.at(-1)!.start
  for (let i = 3; i < tokens.length - 1; i++) {
    const t = tokens[i]
    if (t.type !== 'punct') continue
    if (t.text === '{' || t.text === '[' || t.text === '(') depth++
    else if (t.text === '}' || t.text === ']' || t.text === ')') depth--
    else if (t.text === ',' && depth === 0) {
      const after = tokens[i + 1]
      if (after && after.text !== '}')
        return fail(
          `Stage ${ordinal} must have exactly one operator (one stage per card)`,
          after.start
        )
      valueEnd = t.start
      break
    }
  }
  const valueStart = tokens[2].end
  const body = dedentBody(text.slice(valueStart, valueEnd))
  if (!body) return fail(`Stage ${ordinal}: ${key} has no value`, tokens[2].start)
  return { ok: true, operator: key, body }
}

/** Pipeline text (text mode) → stage drafts; disabled-stage comments come back disabled. */
export function parsePipelineText(text: string): ParsePipelineResult {
  const tokens = lexShell(text)
  const first = tokens.findIndex((t) => t.type !== 'comment')
  if (first < 0) return { ok: true, stages: [] }
  if (tokens[first].text !== '[')
    return {
      ok: false,
      error: 'The pipeline must be an array of stages: [ { $match: { … } }, … ]',
      offset: tokens[first].start
    }
  const stages: MongoStageDraft[] = []
  let depth = 0
  let elementStart = -1
  let disabled: { lines: string[]; start: number } | null = null
  let closed = false

  const finishDisabled = (): ParsePipelineResult | null => {
    if (!disabled) return null
    const stageText = disabled.lines.join('\n')
    const parsed = parseStageElement(stageText, disabled.start, stages.length + 1)
    disabled = null
    if (!parsed.ok) return parsed
    stages.push({ operator: parsed.operator, body: parsed.body, enabled: false })
    return null
  }

  for (let i = first; i < tokens.length; i++) {
    const t = tokens[i]
    if (closed) {
      if (t.type === 'comment' || t.text === ';') continue
      return { ok: false, error: 'Unexpected text after the closing ]', offset: t.start }
    }
    if (t.type === 'comment') {
      if (depth !== 1 || elementStart >= 0 || !t.text.startsWith('//')) continue
      const line = t.text.slice(2).replace(/^ /, '')
      if (disabled) {
        disabled.lines.push(line)
      } else if (line.trimStart().startsWith(DISABLED_MARK)) {
        disabled = { lines: [line.trimStart().slice(DISABLED_MARK.length).trim()], start: t.start }
      } else continue
      const balance = depthOf(lexShell(disabled.lines.join('\n')))
      if (balance.opened && balance.depth <= 0) {
        const failed = finishDisabled()
        if (failed) return failed
      }
      continue
    }
    if (disabled) {
      return { ok: false, error: 'A disabled stage comment is incomplete', offset: disabled.start }
    }
    if (t.type === 'punct' && (t.text === '[' || t.text === '{' || t.text === '(')) {
      depth++
      if (depth === 2 && t.text === '{') elementStart = t.start
      else if (depth === 2)
        return { ok: false, error: `Stage ${stages.length + 1} must be an object`, offset: t.start }
      continue
    }
    if (t.type === 'punct' && (t.text === ']' || t.text === '}' || t.text === ')')) {
      depth--
      if (depth === 1 && elementStart >= 0) {
        const parsed = parseStageElement(
          text.slice(elementStart, t.end),
          elementStart,
          stages.length + 1
        )
        if (!parsed.ok) return parsed
        stages.push({ operator: parsed.operator, body: parsed.body, enabled: true })
        elementStart = -1
      } else if (depth === 0) closed = true
      continue
    }
    if (depth === 1 && !(t.type === 'punct' && t.text === ',')) {
      return { ok: false, error: `Stage ${stages.length + 1} must be an object`, offset: t.start }
    }
  }
  if (disabled) {
    const failed = finishDisabled()
    if (failed) return failed
  }
  if (!closed)
    return { ok: false, error: 'The pipeline is not closed (missing ])', offset: text.length }
  return { ok: true, stages }
}

/** For $out / $merge stages: the target collection as written ('db.coll' or 'coll'). */
export function outputStageTarget(
  stage: Pick<MongoStageDraft, 'operator' | 'body'>
): string | null {
  if (!OUTPUT_STAGES.has(stage.operator)) return null
  const tokens = lexShell(stage.body).filter((t) => t.type !== 'comment')
  if (tokens[0]?.type === 'string') return stringTokenValue(tokens[0])
  const valueOf = (key: string): string | null => {
    for (let i = 0; i < tokens.length - 2; i++) {
      const t = tokens[i]
      const name = t.type === 'ident' ? t.text : t.type === 'string' ? stringTokenValue(t) : null
      if (name === key && tokens[i + 1].text === ':' && tokens[i + 2].type === 'string')
        return stringTokenValue(tokens[i + 2])
    }
    return null
  }
  const coll = valueOf('coll') ?? valueOf('into')
  const db = valueOf('db')
  return coll ? (db ? `${db}.${coll}` : coll) : null
}

export interface StagePreviewInput {
  dataProjectId: string
  database: string
  collection: string
  queryId: string
  stages: readonly MongoStageDraft[]
  /** Card index (counting disabled cards too). */
  index: number
  limit?: number
}

/**
 * The preview request of one card: only the enabled stages up to and including it are sent
 * (a broken stage further down cannot fail an earlier preview), and `stageIndex` points at the
 * last of them. null for a disabled card.
 */
export function stagePreviewRequest(input: StagePreviewInput): MongoAggregateRequest | null {
  const stage = input.stages[input.index]
  if (!stage || !stage.enabled) return null
  const upto = input.stages.slice(0, input.index + 1).filter((s) => s.enabled)
  return {
    dataProjectId: input.dataProjectId,
    queryId: input.queryId,
    database: input.database,
    collection: input.collection,
    pipeline: buildPipelineText(upto),
    stageIndex: upto.length - 1,
    limit: input.limit ?? 10
  }
}

/** A starting body when a stage operator is picked (valid shell, unlike raw snippets). */
const DEFAULT_BODIES: Record<string, string> = {
  $match: '{}',
  $project: '{\n  _id: 1\n}',
  $addFields: '{\n  newField: 1\n}',
  $set: '{\n  newField: 1\n}',
  $unset: "'field'",
  $group: '{\n  _id: null,\n  count: { $sum: 1 }\n}',
  $sort: '{\n  _id: 1\n}',
  $limit: '10',
  $skip: '0',
  $count: "'count'",
  $sample: '{ size: 10 }',
  $unwind: "'$field'",
  $lookup:
    "{\n  from: 'collection',\n  localField: 'field',\n  foreignField: '_id',\n  as: 'joined'\n}",
  $replaceRoot: "{ newRoot: '$field' }",
  $replaceWith: "'$field'",
  $sortByCount: "'$field'",
  $facet: '{\n  output: []\n}',
  $bucket: "{\n  groupBy: '$field',\n  boundaries: [0, 100],\n  default: 'other'\n}",
  $bucketAuto: "{\n  groupBy: '$field',\n  buckets: 5\n}",
  $unionWith: "{ coll: 'collection' }",
  $out: "'collection'",
  $merge: "{ into: 'collection' }",
  $redact: "'$$DESCEND'",
  $indexStats: '{}',
  $collStats: '{ storageStats: {} }',
  $documents: '[{ x: 1 }]',
  $setWindowFields: '{\n  sortBy: { _id: 1 },\n  output: {}\n}',
  $densify: "{\n  field: 'field',\n  range: { step: 1, bounds: 'full' }\n}",
  $fill: '{\n  output: {}\n}',
  $graphLookup:
    "{\n  from: 'collection',\n  startWith: '$field',\n  connectFromField: 'field',\n  connectToField: '_id',\n  as: 'graph'\n}"
}

/** Body for a newly chosen operator: a valid default, else the snippet with placeholders named. */
export function defaultStageBody(operator: string, snippet?: string): string {
  if (DEFAULT_BODIES[operator]) return DEFAULT_BODIES[operator]
  if (!snippet) return '{}'
  return snippet.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d*\}/g, '')
}
