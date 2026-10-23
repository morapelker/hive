// Aggregation helpers: the stage-preview request (only enabled stages up to the card,
// stageIndex pointing at the last of them), stage cards ⇄ text mode without losing disabled
// stages (nor making a commented pipeline invalid), $out/$merge target detection and default
// stage bodies.
import { describe, expect, it } from 'vitest'
import { parseMongoShell } from '@shared/data-projects/mongo-shell'
import {
  buildPipelineText,
  dedentBody,
  defaultStageBody,
  outputStageTarget,
  parsePipelineText,
  pipelineEditorText,
  stagePreviewRequest,
  stageToText,
  type MongoStageDraft
} from './pipeline'
import { aggregateShellText } from './requests'

const stages: MongoStageDraft[] = [
  { operator: '$match', body: "{ status: 'A' }", enabled: true },
  { operator: '$unwind', body: "'$items'", enabled: false },
  {
    operator: '$group',
    body: "{\n  _id: '$userId',\n  total: { $sum: '$total' }\n}",
    enabled: true
  },
  { operator: '$out', body: "'totals'", enabled: true }
]

describe('stagePreviewRequest', () => {
  const base = { dataProjectId: 'dp', database: 'shop', collection: 'orders', queryId: 'q1' }

  it('sends only the enabled stages up to the card and points stageIndex at the last one', () => {
    const request = stagePreviewRequest({ ...base, stages, index: 2 })
    expect(request).toEqual({
      dataProjectId: 'dp',
      queryId: 'q1',
      database: 'shop',
      collection: 'orders',
      pipeline: buildPipelineText([stages[0], stages[2]]),
      stageIndex: 1,
      limit: 10
    })
    // A later broken stage is never part of an earlier preview.
    expect(request!.pipeline).not.toContain('$out')
  })

  it('previews the first card alone and skips disabled cards', () => {
    expect(stagePreviewRequest({ ...base, stages, index: 0 })).toMatchObject({
      pipeline: "[\n  { $match: { status: 'A' } }\n]",
      stageIndex: 0
    })
    expect(stagePreviewRequest({ ...base, stages, index: 1 })).toBeNull()
    expect(stagePreviewRequest({ ...base, stages, index: 9 })).toBeNull()
    expect(stagePreviewRequest({ ...base, stages, index: 3, limit: 5 })).toMatchObject({
      stageIndex: 2,
      limit: 5
    })
  })
})

describe('pipeline text', () => {
  it('builds the enabled pipeline with indented multi-line bodies', () => {
    expect(buildPipelineText(stages)).toBe(
      [
        '[',
        "  { $match: { status: 'A' } },",
        '  {',
        '    $group: {',
        "      _id: '$userId',",
        "      total: { $sum: '$total' }",
        '    }',
        '  },',
        "  { $out: 'totals' }",
        ']'
      ].join('\n')
    )
    expect(buildPipelineText([])).toBe('[]')
    expect(stageToText({ operator: '$limit', body: ' 10 ' })).toBe('{ $limit: 10 }')
  })

  it('round-trips cards → text mode → cards, keeping disabled stages', () => {
    const text = pipelineEditorText(stages)
    expect(text).toContain("// disabled: { $unwind: '$items' }")
    const parsed = parsePipelineText(text)
    expect(parsed).toEqual({ ok: true, stages })
  })

  it('round-trips a disabled multi-line stage', () => {
    const drafts: MongoStageDraft[] = [
      { operator: '$group', body: '{\n  _id: null,\n  n: { $sum: 1 }\n}', enabled: false },
      { operator: '$limit', body: '5', enabled: true }
    ]
    expect(parsePipelineText(pipelineEditorText(drafts))).toEqual({ ok: true, stages: drafts })
  })

  it('parses hand-written text with comments, quoted keys and trailing commas', () => {
    const parsed = parsePipelineText(`// top comment
[
  { "$match": { a: /x\\/y/, b: '}' } }, // inline
  { $project: { a: 1, // keep a
      b: 1 } },
]`)
    expect(parsed).toEqual({
      ok: true,
      stages: [
        { operator: '$match', body: "{ a: /x\\/y/, b: '}' }", enabled: true },
        { operator: '$project', body: '{ a: 1, // keep a\nb: 1 }', enabled: true }
      ]
    })
  })

  it('reports what is wrong and where', () => {
    expect(parsePipelineText('{ $match: {} }')).toMatchObject({ ok: false, offset: 0 })
    expect(parsePipelineText('[ { $match: {}, $limit: 1 } ]')).toMatchObject({
      ok: false,
      error: expect.stringContaining('exactly one operator')
    })
    expect(parsePipelineText('[ { match: {} } ]')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not a stage operator')
    })
    expect(parsePipelineText('[ { $match: {} }')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not closed')
    })
    expect(parsePipelineText('[ 1 ]')).toMatchObject({
      ok: false,
      error: 'Stage 1 must be an object'
    })
    expect(parsePipelineText('[ {} ]')).toMatchObject({ ok: false, error: 'Stage 1 is empty' })
    expect(parsePipelineText('')).toEqual({ ok: true, stages: [] })
    expect(parsePipelineText('[]')).toEqual({ ok: true, stages: [] })
  })

  it('dedents bodies relative to their first line', () => {
    expect(dedentBody('{\n      a: 1\n    }')).toBe('{\n  a: 1\n}')
    expect(dedentBody('  10  ')).toBe('10')
  })
})

describe('stage helpers', () => {
  it('finds $out / $merge targets', () => {
    expect(outputStageTarget({ operator: '$out', body: "'totals'" })).toBe('totals')
    expect(outputStageTarget({ operator: '$out', body: "{ db: 'arch', coll: 'totals' }" })).toBe(
      'arch.totals'
    )
    expect(outputStageTarget({ operator: '$merge', body: "{ into: 'totals', on: '_id' }" })).toBe(
      'totals'
    )
    expect(outputStageTarget({ operator: '$match', body: '{}' })).toBeNull()
  })

  it('offers valid default bodies and de-placeholdered snippets', () => {
    expect(defaultStageBody('$limit')).toBe('10')
    expect(defaultStageBody('$fancy', '{\n  ${1:field}: ${2:expression}\n}')).toBe(
      '{\n  field: expression\n}'
    )
    expect(defaultStageBody('$unknown')).toBe('{}')
  })
})

describe('stage bodies ending with a line comment', () => {
  const shellOk = (pipeline: string): boolean =>
    parseMongoShell(aggregateShellText('orders', pipeline)).ok

  it('keeps a valid commented pipeline valid after switching text → stages', () => {
    const text =
      "[\n  {\n    $match: { status: 'shipped' } // only shipped\n  },\n  { $limit: 5 }\n]"
    expect(shellOk(text)).toBe(true)
    const parsed = parsePipelineText(text)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.stages[0].body).toBe("{ status: 'shipped' } // only shipped")
    // Run, Open in shell and Export use the built pipeline; previews the prefix of each card.
    expect(shellOk(buildPipelineText(parsed.stages))).toBe(true)
    for (const index of [0, 1]) {
      const request = stagePreviewRequest({
        dataProjectId: 'dp',
        database: 'shop',
        collection: 'orders',
        queryId: 'q',
        stages: parsed.stages,
        index
      })
      expect(shellOk(request!.pipeline)).toBe(true)
    }
    expect(stageToText(parsed.stages[0])).toBe(
      "{\n  $match: { status: 'shipped' } // only shipped\n}"
    )
  })

  it('round-trips a commented stage through text mode, enabled or disabled', () => {
    for (const enabled of [true, false]) {
      const cards: MongoStageDraft[] = [
        { operator: '$match', body: '{ a: 1 } // note', enabled },
        { operator: '$limit', body: '5', enabled: true }
      ]
      const back = parsePipelineText(pipelineEditorText(cards))
      expect(back).toEqual({ ok: true, stages: cards })
      expect(shellOk(buildPipelineText(cards))).toBe(true)
    }
  })
})
