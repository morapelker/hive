import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionMeta,
  buildExtractionPrompt,
  buildExtractionRepairPrompt,
  buildItemDrafts,
  parseExtractionResponse,
  type ExtractionResult
} from './extraction'
import { preprocessDocument, type PreprocessedDocument } from './preprocess'

// Block map of the sample (see preprocess.test.ts): b4-b12 rules and decisions, b15-b25 A1,
// b26-b39 A2 (with the progress report at b37-b39), b40-b46 B1, b47-b50 B2, b51-b54 data
// changes, b55-b57 permissions, b58-b61 tests. The mock-up disclaimer repeats at b25, b35,
// b36, b46, b50 and b63.
const doc = preprocessDocument({
  fileName: 'spec-sample.html',
  content: readFileSync(join(__dirname, '__fixtures__', 'spec-sample.html'), 'utf8')
})

const SOURCE_PATH = '/Users/me/Downloads/orders round 1.html'
const DOCUMENT_PATH = '/runs/r1/document.md'
const LEGEND =
  'How to read the spec text: [UPPER CASE] in square brackets is a tag or status badge of the document, not part of any UI string or identifier, and [fig-NN "alt"] marks one of its images.'

type Json = Record<string, unknown>

const ticket = (overrides: Json = {}): Json => ({
  key: 'A1',
  title: 'Order totals',
  summary: 'Totals include tax and shipping and are stored in one column.',
  kind: 'fix',
  blocks: [[15, 25]],
  relatedBlocks: [53, 59],
  dependsOn: [],
  docStatus: 'done',
  hasMigration: true,
  size: 'M',
  conflictRisk: 'high',
  openQuestions: [],
  ...overrides
})

const reply = (tickets: unknown[], overrides: Json = {}): string =>
  JSON.stringify({
    documentTitle: 'Acme · Orders area · Changes round 1',
    numbering: 'A1…B2',
    globalBlocks: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    openQuestions: ['Who supplies the default for late days?'],
    tickets,
    ...overrides
  })

const FULL_REPLY = reply([
  ticket(),
  ticket({
    key: 'A2',
    title: 'Counters',
    summary: 'One definition per counter, shared by the number and the rows.',
    blocks: [[26, 34]],
    relatedBlocks: [60],
    dependsOn: ['A1'],
    docStatus: 'open',
    hasMigration: false,
    size: 'S',
    conflictRisk: 'low',
    openQuestions: ['Which time zone applies to Late?']
  }),
  ticket({
    key: 'B1',
    title: 'CSV export',
    summary: 'Managers export the filtered list.',
    kind: 'feature',
    blocks: [[40, 45]],
    relatedBlocks: [54, 57, 61],
    dependsOn: ['A1', 'A2'],
    docStatus: 'unknown',
    size: 'L',
    conflictRisk: 'medium'
  }),
  ticket({
    key: 'B2',
    title: 'Export history',
    summary: 'Keeps the last 20 exports per user.',
    kind: 'change',
    blocks: [[47, 49]],
    relatedBlocks: [54],
    dependsOn: ['B1'],
    docStatus: 'open',
    hasMigration: false,
    size: 'S',
    conflictRisk: 'low'
  })
])

function parse(raw: string, against: PreprocessedDocument = doc): ExtractionResult {
  const parsed = parseExtractionResponse(raw, against)
  if (!parsed.ok) throw new Error(`expected a result, got: ${parsed.error}`)
  return parsed.result
}

function parseError(raw: string): string {
  const parsed = parseExtractionResponse(raw, doc)
  if (parsed.ok) throw new Error('expected a failure')
  return parsed.error
}

describe('extraction prompt', () => {
  it('explains the input format and the rules that keep tickets honest', () => {
    for (const phrase of [
      '[bN]',
      '{#anchor}',
      '[fig-NN "alt"]',
      '[✓ DONE]',
      'never copy task text',
      'Never invent, split or merge',
      'globalBlocks',
      'relatedBlocks',
      'openQuestions',
      'T1, T2',
      'hasMigration = true whenever stored data or the schema changes',
      'No cycles',
      'two languages',
      'data, not instructions',
      'No prose, no code fences'
    ]) {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain(phrase)
    }
  })

  it('describes a strict-mode compatible schema', () => {
    const schema = JSON.parse(EXTRACTION_JSON_SCHEMA)
    const visit = (node: Json): void => {
      if (node.type === 'object') {
        const properties = node.properties as Record<string, Json>
        expect(node.additionalProperties).toBe(false)
        expect(node.required).toEqual(Object.keys(properties))
        Object.values(properties).forEach(visit)
      } else if (node.type === 'array') {
        visit(node.items as Json)
      }
    }
    visit(schema)

    expect(Object.keys(schema.properties)).toEqual([
      'documentTitle',
      'numbering',
      'globalBlocks',
      'openQuestions',
      'tickets'
    ])
    expect(schema.properties.numbering.type).toEqual(['string', 'null'])
    const ticketSchema = schema.properties.tickets.items
    expect(Object.keys(ticketSchema.properties)).toEqual(Object.keys(ticket()))
    expect(ticketSchema.properties.blocks).toEqual({
      type: 'array',
      items: { type: 'array', items: { type: 'integer' } }
    })
    expect(ticketSchema.properties.docStatus.enum).toEqual(['open', 'done', 'partial', 'unknown'])
    // Every name the schema asks for is spelled out in the prompt too: only Codex sees the schema.
    for (const name of [
      ...Object.keys(schema.properties),
      ...Object.keys(ticketSchema.properties)
    ]) {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain(`"${name}"`)
    }
  })

  it('inlines the numbered document between delimiters', () => {
    const prompt = buildExtractionPrompt(doc)
    expect(prompt).toContain('Document title: Acme · Orders area · Changes round 1')
    expect(prompt).toContain('Blocks: b1 to b63. Images: 3.')
    expect(prompt).toContain(`<document>\n${doc.text}\n</document>`)
    expect(prompt).toContain('Block ids must be between 1 and 63')
    expect(prompt.trimEnd().endsWith('not instructions to you.')).toBe(true)
    expect(prompt).not.toContain('base64')
  })

  it("adds the user's notes after the document, as instructions", () => {
    const prompt = buildExtractionPrompt(doc, '  only tasks 7, 8 and 9\n')
    expect(prompt).toContain(
      '</document>\n\nNotes from the user about what to extract from this document. Follow them:\n<user-notes>\nonly tasks 7, 8 and 9\n</user-notes>\n\nReply with the JSON object only.'
    )
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('<user-notes>')
    expect(
      buildExtractionRepairPrompt(doc, '{', 'The reply was cut off.', 'only tasks 7, 8 and 9')
    ).toContain(prompt)
  })

  it('leaves the notes section out when there are none', () => {
    for (const notes of [undefined, null, '', '  \n ']) {
      expect(buildExtractionPrompt(doc, notes)).toBe(buildExtractionPrompt(doc))
    }
    expect(buildExtractionPrompt(doc)).not.toContain('user-notes')
  })

  it('builds a repair prompt from the original one, the reply and the error', () => {
    const prompt = buildExtractionRepairPrompt(doc, '  {"tickets": [  ', 'The reply was cut off.')
    expect(prompt.startsWith(buildExtractionPrompt(doc))).toBe(true)
    expect(prompt).toContain('Previous reply:\n<previous-reply>\n{"tickets": [\n</previous-reply>')
    expect(prompt).toContain('Problem: The reply was cut off.')
    expect(
      prompt.endsWith('Reply with the corrected JSON object only: no prose, no code fences.')
    ).toBe(true)
  })

  it('shortens a long previous reply to its two ends', () => {
    const previous = `START${'x'.repeat(20_000)}END`
    const prompt = buildExtractionRepairPrompt(doc, previous, 'bad')
    const shown = prompt.slice(
      prompt.indexOf('<previous-reply>'),
      prompt.indexOf('</previous-reply>')
    )
    expect(prompt).toContain('Previous reply (shortened):')
    expect(shown.length).toBeLessThan(4200)
    expect(shown).toContain('START')
    expect(shown).toContain('END')
    expect(shown).toContain('characters left out')
    expect(buildExtractionRepairPrompt(doc, '', 'empty')).toContain(
      '<previous-reply>\n(empty)\n</previous-reply>'
    )
  })
})

describe('parseExtractionResponse', () => {
  it('reads a well-formed reply', () => {
    const result = parse(FULL_REPLY)
    expect(result).toEqual({
      documentTitle: 'Acme · Orders area · Changes round 1',
      numbering: 'A1…B2',
      globalBlocks: [4, 5, 6, 7, 8, 9, 10, 11, 12],
      openQuestions: ['Who supplies the default for late days?'],
      warnings: [],
      tickets: [
        {
          key: 'A1',
          title: 'Order totals',
          summary: 'Totals include tax and shipping and are stored in one column.',
          kind: 'fix',
          blockRanges: [[15, 25]],
          relatedBlocks: [53, 59],
          dependsOn: [],
          docStatus: 'done',
          hasMigration: true,
          size: 'M',
          conflictRisk: 'high',
          openQuestions: []
        },
        expect.objectContaining({
          key: 'A2',
          blockRanges: [[26, 34]],
          dependsOn: ['A1'],
          docStatus: 'open',
          hasMigration: false,
          openQuestions: ['Which time zone applies to Late?']
        }),
        expect.objectContaining({ key: 'B1', kind: 'feature', dependsOn: ['A1', 'A2'], size: 'L' }),
        expect.objectContaining({ key: 'B2', kind: 'change', dependsOn: ['B1'] })
      ]
    })
  })

  it('reads a reply wrapped in prose and a json code fence', () => {
    const wrapped = `Here are the tickets I found:\n\n\`\`\`json\n${FULL_REPLY}\n\`\`\`\n\nLet me know if you want changes.`
    expect(parse(wrapped)).toEqual(parse(FULL_REPLY))
    expect(parse(`Sure! ${FULL_REPLY} Hope that helps.`)).toEqual(parse(FULL_REPLY))
  })

  it('reads a reply whose strings contain a fenced code block', () => {
    const summary = 'Adds the column. Example:\n```sql\nALTER TABLE orders ADD order_total;\n```'
    const raw = reply([ticket({ summary })])
    expect(raw).toContain('```sql')
    expect(parse(raw).tickets[0].summary).toBe(
      'Adds the column. Example: ```sql ALTER TABLE orders ADD order_total; ```'
    )
    expect(parse(`\`\`\`json\n${raw}\n\`\`\``).tickets).toHaveLength(1)
  })

  it('reads a bare array as the ticket list', () => {
    const result = parse(JSON.stringify([ticket(), ticket({ key: 'A2', title: 'Counters' })]))
    expect(result.tickets.map((entry) => entry.key)).toEqual(['A1', 'A2'])
    expect(result.documentTitle).toBe(doc.title)
    expect(result.numbering).toBeNull()
    expect(result.globalBlocks).toEqual([])
  })

  it.each([
    ['pairs', [[15, 25]], [[15, 25]]],
    [
      'several pairs',
      [
        [15, 20],
        [30, 31]
      ],
      [
        [15, 20],
        [30, 31]
      ]
    ],
    ['objects', [{ from: 15, to: 25 }], [[15, 25]]],
    ['objects with other names', [{ start: 'b15', end: 'b25' }], [[15, 25]]],
    ['one object', { from: 15, to: 25 }, [[15, 25]]],
    ['range strings in a list', ['b15-b25'], [[15, 25]]],
    ['a range string', 'b15-b25', [[15, 25]]],
    ['a bare range string', '15-25', [[15, 25]]],
    ['an en dash', 'b15–b25', [[15, 25]]],
    ['the word to', 'b15 to b25', [[15, 25]]],
    [
      'several spans in one string',
      'b15-b20, b24, b30..b31',
      [
        [15, 20],
        [24, 24],
        [30, 31]
      ]
    ],
    [
      'a flat list of ids',
      [15, 16, 17, 20, 22, 23],
      [
        [15, 17],
        [20, 20],
        [22, 23]
      ]
    ],
    [
      'a flat list of b-ids',
      ['b15', 'b16', '[b17]', '19'],
      [
        [15, 17],
        [19, 19]
      ]
    ],
    ['pairs written as strings', [['b15', 'b25']], [[15, 25]]],
    ['a single id', 15, [[15, 15]]],
    ['a single id in a list', [15], [[15, 15]]],
    ['a reversed pair', [[25, 15]], [[15, 25]]],
    [
      'overlapping and touching ranges',
      [
        [20, 25],
        [15, 21],
        [26, 27],
        [15, 16]
      ],
      [[15, 27]]
    ],
    [
      'a mixed list',
      [[15, 16], 'b20-b21', { from: 30, to: 30 }, 40],
      [
        [15, 16],
        [20, 21],
        [30, 30],
        [40, 40]
      ]
    ]
  ])('accepts block ranges written as %s', (_name, blocks, expected) => {
    const result = parse(reply([ticket({ blocks })]))
    expect(result.tickets[0].blockRanges).toEqual(expected)
    expect(result.warnings).toEqual([])
  })

  it('reads a flat pair of far-apart ids as the range it stands for', () => {
    const result = parse(reply([ticket({ blocks: [15, 25] })]))
    expect(result.tickets[0].blockRanges).toEqual([[15, 25]])
    expect(result.warnings).toEqual(['A1: blocks [15,25] read as the range b15-b25.'])
    // Related and global lists are id lists: a pair there is two ids.
    const lists = parse(reply([ticket({ relatedBlocks: [53, 59] })], { globalBlocks: [4, 12] }))
    expect(lists.tickets[0].relatedBlocks).toEqual([53, 59])
    expect(lists.globalBlocks).toEqual([4, 12])
  })

  it('accepts snake_case names and other loose spellings', () => {
    const result = parse(
      JSON.stringify({
        document_title: 'Loose reply',
        global_blocks: 'b4-b7',
        open_questions: 'Who signs off?',
        tickets: [
          {
            key: 7,
            title: 'Numeric key',
            summary: 'S',
            kind: 'FIX',
            block_ranges: 'b15-b25',
            related_blocks: ['b49', 'b55-b57'],
            depends_on: 'a2, B1 and nothing-else',
            doc_status: 'Done',
            has_migration: 'yes',
            size: 'xl',
            conflict_risk: 'HIGH',
            open_questions: 'none'
          },
          { key: 'A2', title: 'Counters', blocks: [26], status: 'in progress', type: 'bug' },
          { key: 'B1', name: 'Named', blocks: [38], size: 'large', dependencies: ['a2'] }
        ]
      })
    )
    expect(result.documentTitle).toBe('Loose reply')
    expect(result.globalBlocks).toEqual([4, 5, 6, 7])
    expect(result.openQuestions).toEqual(['Who signs off?'])
    expect(result.tickets[0]).toEqual({
      key: '7',
      title: 'Numeric key',
      summary: 'S',
      kind: 'fix',
      blockRanges: [[15, 25]],
      relatedBlocks: [49, 55, 56, 57],
      dependsOn: ['A2', 'B1'],
      docStatus: 'done',
      hasMigration: true,
      size: 'XL',
      conflictRisk: 'high',
      openQuestions: []
    })
    expect(result.tickets[1]).toMatchObject({ kind: 'fix', docStatus: 'partial' })
    expect(result.tickets[2]).toMatchObject({ title: 'Named', size: 'L', dependsOn: ['A2'] })
    expect(result.warnings).toEqual(['7 depends on unknown task "nothing-else"; ignored.'])
  })

  it('falls back on unknown enum values and missing fields', () => {
    const result = parse(
      reply([
        {
          key: 'A1',
          title: 'Bare',
          blocks: [[15, 16]],
          kind: 'constructor',
          docStatus: 'shipped?',
          size: 'huge',
          conflictRisk: 'toString',
          hasMigration: 'maybe'
        }
      ])
    )
    expect(result.tickets[0]).toEqual({
      key: 'A1',
      title: 'Bare',
      summary: '',
      kind: 'change',
      blockRanges: [[15, 16]],
      relatedBlocks: [],
      dependsOn: [],
      docStatus: 'unknown',
      hasMigration: false,
      size: null,
      conflictRisk: null,
      openQuestions: []
    })
  })

  it('makes duplicate keys unique', () => {
    const result = parse(
      reply([
        ticket(),
        ticket({ title: 'Second A1', blocks: [[26, 27]] }),
        ticket({ title: 'Third A1', blocks: [[28, 28]], dependsOn: ['A1'] }),
        ticket({ key: 'A1-2', title: 'Clashes with the suffix', blocks: [[29, 29]] })
      ])
    )
    expect(result.tickets.map((entry) => entry.key)).toEqual(['A1', 'A1-2', 'A1-3', 'A1-2-2'])
    // A dependency on the shared key means the nearest earlier ticket that carries it.
    expect(result.tickets[2].dependsOn).toEqual(['A1-2'])
    expect(result.warnings).toEqual([
      'Key A1 is used twice; the second one is now A1-2.',
      'Key A1 is used twice; the second one is now A1-3.',
      'Key A1-2 is used twice; the second one is now A1-2-2.',
      'A1-3 depends on "A1", which A1, A1-2, A1-3 all carry; taken as A1-2.'
    ])
  })

  it('resolves dependencies and headings by the key as written, per section', () => {
    const perSection = preprocessDocument({
      fileName: 'parts.md',
      content: [
        '# Plan',
        '## Part A',
        '### 1 · Lists',
        'a1',
        '### 2 · Filters',
        'a2',
        '## Part B',
        '### 1 · Export',
        'b1',
        '### 2 · History',
        'b2'
      ].join('\n')
    })
    const result = parse(
      JSON.stringify({
        tickets: [
          { key: '1', title: 'Lists', blocks: [[3, 4]] },
          { key: '2', title: 'Filters', blocks: [[5, 6]], dependsOn: ['1'] },
          // Part B's task 1 came back without blocks: its heading is the second "1".
          { key: '1', title: 'Export', dependsOn: ['2'] },
          { key: '2', title: 'History', blocks: [[10, 11]], dependsOn: ['1'] },
          { key: 'Extra', title: 'Later', blocks: [[11, 11]] },
          // Another case still finds the ticket; a suffixed key names it directly.
          { key: 'Z', title: 'Last', blocks: [[11, 11]], dependsOn: ['extra', '1', '2-2'] }
        ]
      }),
      perSection
    )
    expect(result.tickets.map((entry) => [entry.key, entry.blockRanges, entry.dependsOn])).toEqual([
      ['1', [[3, 4]], []],
      ['2', [[5, 6]], ['1']],
      ['1-2', [[8, 9]], ['2']],
      ['2-2', [[10, 11]], ['1-2']],
      ['Extra', [[11, 11]], []],
      ['Z', [[11, 11]], ['Extra', '1-2', '2-2']]
    ])
    // Only a choice between several earlier tickets is reported.
    expect(result.warnings).toEqual([
      'Key 1 is used twice; the second one is now 1-2.',
      '1-2 had no usable blocks; located by its heading (b8-b9).',
      'Key 2 is used twice; the second one is now 2-2.',
      '2-2 depends on "1", which 1, 1-2 all carry; taken as 1-2.',
      'Z depends on "1", which 1, 1-2 all carry; taken as 1-2.'
    ])

    // A third ticket written "1" with only two such headings cannot be located.
    const third = parse(
      JSON.stringify({
        tickets: [
          { key: '1', title: 'Lists', blocks: [[3, 4]] },
          { key: '1', title: 'Export', blocks: [[8, 9]] },
          { key: '1', title: 'Nowhere' }
        ]
      }),
      perSection
    )
    expect(third.tickets[2].blockRanges).toEqual([])
    expect(third.warnings).toContain(
      '1-3 has no blocks in the document; its description holds no task text.'
    )
  })

  it('names tickets that have no key in document order', () => {
    const result = parse(
      reply([
        ticket({ key: '', title: 'First' }),
        ticket({ key: 'T1', title: 'Takes the name' }),
        ticket({ key: undefined, title: 'Third' })
      ])
    )
    expect(result.tickets.map((entry) => entry.key)).toEqual(['T1', 'T1-2', 'T3'])
    expect(result.warnings).toContain('"First" had no key; named T1.')
  })

  it('cleans unknown, self and duplicate dependencies', () => {
    const result = parse(
      reply([
        ticket({ key: 'A1', dependsOn: [] }),
        ticket({ key: 'A2', title: 'Counters', dependsOn: ['A2', 'Z9', 'A1', 'A1', ' '] }),
        ticket({ key: 'B1', title: 'CSV export', dependsOn: ['a1', '"A2"'] }),
        ticket({ key: 'B2', title: 'History', dependsOn: 'B1; A2 and none' })
      ])
    )
    expect(result.tickets.map((entry) => entry.dependsOn)).toEqual([
      [],
      ['A1'],
      ['A1', 'A2'],
      ['B1', 'A2']
    ])
    expect(result.warnings).toEqual([
      'A2 listed itself as a dependency; ignored.',
      'A2 depends on unknown task "Z9"; ignored.'
    ])
  })

  it('breaks dependency cycles', () => {
    const result = parse(
      reply([
        ticket({ key: 'A1', dependsOn: ['A2'] }),
        ticket({ key: 'A2', title: 'Counters', dependsOn: ['B1'] }),
        ticket({ key: 'B1', title: 'CSV export', dependsOn: ['A1'] }),
        ticket({ key: 'B2', title: 'History', dependsOn: ['B1'] })
      ])
    )
    const dependsOn = Object.fromEntries(
      result.tickets.map((entry) => [entry.key, entry.dependsOn])
    )
    // The loop is cut where an earlier task waited for a later one, so A1 can start.
    expect(dependsOn).toEqual({ A1: [], A2: ['B1'], B1: ['A1'], B2: ['B1'] })
    expect(result.warnings).toEqual([
      'Circular dependency A1 → A2 → B1 → A1; dropped "A1 depends on A2".'
    ])
  })

  it('cuts ranges back into the document', () => {
    const result = parse(
      reply(
        [
          ticket({
            blocks: [
              [0, 3],
              [50, 900],
              [200, 300]
            ],
            relatedBlocks: [57, 58, 63, 400, -2]
          }),
          ticket({ key: 'A2', title: 'Counters', blocks: ['b26-b34'], relatedBlocks: [] })
        ],
        { globalBlocks: [0, 1, 2, 99] }
      )
    )
    expect(result.tickets[0].blockRanges).toEqual([
      [1, 3],
      [50, 63]
    ])
    // 57, 58 and 63 already sit in the ticket's own text.
    expect(result.tickets[0].relatedBlocks).toEqual([])
    expect(result.globalBlocks).toEqual([1, 2])
    expect(result.warnings).toEqual([
      'A1: block ranges reaching outside b1-b63 were cut.',
      'A1: related blocks outside b1-b63 were dropped.',
      'Global blocks outside b1-b63 were dropped.'
    ])
  })

  it('locates a ticket without usable blocks by its heading', () => {
    const result = parse(
      reply([
        ticket({ key: 'A2', title: 'Counters', blocks: [] }),
        ticket({ key: 'b1', title: 'CSV export', blocks: [[400, 420]] }),
        ticket({ key: 'B2', title: 'Export history', blocks: undefined }),
        ticket({ key: 'A', title: 'A prefix of other keys', blocks: 'none' }),
        ticket({ key: 'T9', title: 'Not in the document', blocks: null })
      ])
    )
    expect(result.tickets.map((entry) => entry.blockRanges)).toEqual([
      // From the A2 heading to the block before the next heading of its level (B1).
      [[26, 39]],
      [[40, 46]],
      [[47, 50]],
      [],
      []
    ])
    expect(result.warnings).toEqual([
      'A2 had no usable blocks; located by its heading (b26-b39).',
      'b1: block ranges reaching outside b1-b63 were cut.',
      'b1 had no usable blocks; located by its heading (b40-b46).',
      'B2 had no usable blocks; located by its heading (b47-b50).',
      'A has no blocks in the document; its description holds no task text.',
      'T9 has no blocks in the document; its description holds no task text.'
    ])
  })

  it('finds numbered headings without confusing 1 with 1.1 or 10', () => {
    const numbered = preprocessDocument({
      fileName: 'tasks.md',
      content: [
        '# Plan',
        '## 1.1 Sub task',
        'a',
        '## 10. Tenth',
        'b',
        '## Task 1: First',
        'c',
        '### Details',
        'd',
        '## 2) Second',
        'e'
      ].join('\n')
    })
    const result = parse(
      JSON.stringify({
        tickets: [
          { key: '1', title: 'First' },
          { key: '2', title: 'Second' },
          { key: '10', title: 'Tenth' },
          { key: '1.1', title: 'Sub task' }
        ]
      }),
      numbered
    )
    expect(result.tickets.map((entry) => entry.blockRanges)).toEqual([
      [[6, 9]],
      [[10, 11]],
      [[4, 5]],
      [[2, 3]]
    ])
  })

  it('sanitises titles for the XML-ish attribute the launcher writes', () => {
    const control = String.fromCharCode(7)
    const result = parse(
      reply([
        ticket({ title: `  Say "hi" to <b>users</b>\r\nand${control}more\ttabs  ` }),
        ticket({ key: 'A2', title: 'A2 · Counters (stats row)' }),
        ticket({ key: 'B1', title: 'b1: CSV export' }),
        ticket({ key: 'B2', title: `B2 — ${'long title '.repeat(30)}` }),
        ticket({ key: 'C"1"\n<x>', title: 'Odd key' }),
        ticket({ key: 'A', title: 'A1 is not this key' })
      ])
    )
    expect(result.tickets.map((entry) => entry.title).slice(0, 3)).toEqual([
      'Say hi to busers/b and more tabs',
      'Counters (stats row)',
      'CSV export'
    ])
    const long = result.tickets[3].title
    expect(long).toHaveLength(120)
    expect(long.startsWith('long title long title')).toBe(true)
    expect(long.endsWith('…')).toBe(true)
    expect(result.tickets[4].key).toBe('C1 x')
    expect(result.tickets[5].title).toBe('A1 is not this key')
    for (const entry of result.tickets) {
      expect(entry.title).not.toMatch(/["<>\r\n\t]/)
      expect(entry.key).not.toMatch(/["<>\r\n]/)
    }
  })

  it('drops tickets without a title and entries that are not objects', () => {
    const result = parse(
      reply([
        ticket({ title: '' }),
        null,
        'A2',
        42,
        [ticket()],
        ticket({ key: 'A2', title: '   ' }),
        ticket({ title: undefined }),
        ticket({ key: 'B1', title: 'Kept' })
      ])
    )
    expect(result.tickets.map((entry) => entry.key)).toEqual(['B1'])
    expect(result.warnings).toEqual([
      'A1 has no title; dropped.',
      'Ticket 2 is not an object; dropped.',
      'Ticket 3 is not an object; dropped.',
      'Ticket 4 is not an object; dropped.',
      'Ticket 5 is not an object; dropped.',
      'A2 has no title; dropped.',
      'A1 has no title; dropped.'
    ])
  })

  it('falls back to the document title', () => {
    expect(parse(reply([ticket()], { documentTitle: '  ' })).documentTitle).toBe(doc.title)
    expect(parse(reply([ticket()], { documentTitle: 'Say "this"' })).documentTitle).toBe('Say this')
    expect(parse(reply([ticket()], { numbering: '' })).numbering).toBeNull()

    const quoted = preprocessDocument({
      fileName: 'quoted.html',
      content: '<title>The "new" <orders> area</title><h2>A1 · Totals</h2><p>Body</p>'
    })
    expect(quoted.title).toBe('The "new" <orders> area')
    expect(parse(JSON.stringify({ tickets: [ticket()] }), quoted).documentTitle).toBe(
      'The new orders area'
    )
  })

  it.each([
    ['an empty reply', '  ', 'The model returned an empty reply.'],
    ['prose', 'I cannot help with that.', 'The reply contains no JSON object that can be parsed.'],
    [
      'a cut-off reply',
      '{"documentTitle": "x", "tickets": [{"key": "A1", "title": "Tot',
      'The reply contains no JSON object that can be parsed. It looks cut off before the end.'
    ],
    [
      'an object without tickets',
      '{"documentTitle": "x"}',
      'The JSON object has no "tickets" list.'
    ],
    [
      'tickets that are not a list',
      '{"tickets": "none"}',
      'The JSON object has no "tickets" list.'
    ],
    ['an empty ticket list', '{"tickets": []}', 'The reply lists no tickets.'],
    [
      'only unusable tickets',
      '{"tickets": [{"key": "A1"}, null]}',
      'None of the 2 tickets in the reply could be used (each needs a title).'
    ]
  ])('fails clearly on %s', (_name, raw, error) => {
    expect(parseError(raw)).toBe(error)
  })

  it('never throws', () => {
    const hostile: unknown[] = [
      '{"tickets": [{"title": {"nested": true}, "blocks": {"from": {}}}]}',
      '{"tickets": [{"title": "x", "blocks": [[[[1]]]], "dependsOn": {"a": 1}, "relatedBlocks": "∞"}]}',
      '{"tickets": [{"title": "x", "key": {"toString": null}, "size": 5, "kind": []}]}',
      '{"tickets": {"0": {"title": "x"}}}',
      '[[[',
      '{"tickets": [{"title": "x", "blocks": [1e999, -1e999, null, "b", 1.7]}]}',
      `{"tickets": [{"title": "x", "blocks": "${'9'.repeat(4000)}"}]}`
    ]
    for (const raw of hostile) {
      expect(() => parseExtractionResponse(raw as string, doc)).not.toThrow()
    }
    const empty = preprocessDocument({ fileName: 'empty.txt', content: '' })
    const result = parse(reply([ticket()]), empty)
    expect(result.tickets[0].blockRanges).toEqual([])
    expect(result.globalBlocks).toEqual([])
  })
})

describe('buildItemDrafts', () => {
  const figurePaths = {
    'fig-01': '/runs/r1/figures/fig-01.png',
    'fig-03': '/runs/r1/figures/fig-03.jpg'
  }
  const build = (raw: string, paths: Record<string, string> = figurePaths) =>
    buildItemDrafts({
      result: parse(raw),
      doc,
      sourcePath: SOURCE_PATH,
      documentPath: DOCUMENT_PATH,
      figurePaths: paths
    })

  const drafts = build(FULL_REPLY)
  const rules = [
    '## Rules that apply to every task in this document',
    // Copied headings nest under the description's own sections: h2 and h3 become ### and ####.
    '### How to apply these changes {#rules}',
    '',
    "- Build on what exists; don't rebuild screens that aren't mentioned.",
    '- Work in the order A → B. After each part run its tests.',
    '- Data migrations (marked [DATA]) run once, on a backup first, and must be reversible.',
    '',
    '#### Decisions this round is built on',
    '',
    '| Topic | Decision |',
    '| Delete | Soft delete only. A manager can restore from a "Deleted" filter. |',
    '| Export | CSV with a `;` separator, UTF-8 & BOM. |',
    '| Rounding | Totals > 0 round half up to 2 decimals. |'
  ]

  it('assembles a self-contained description from the blocks', () => {
    expect(drafts[0].description).toBe(
      [
        'Implement task A1 — Order totals — from the spec document "Acme · Orders area · Changes round 1".',
        '',
        'Spec files (read-only):',
        '- Full text: /runs/r1/document.md (search for "A1 · Order totals")',
        '- Original document: /Users/me/Downloads/orders round 1.html (it may embed large base64 images; prefer the text version)',
        '',
        LEGEND,
        '',
        "The attached images are this task's mock-ups; open each one.",
        '',
        '## Task (verbatim from the spec)',
        '### A1 · Order totals [FIX] [✓ DONE] [LIVE · MIGRATION APPLIED 5 OCT · TOTALS RECOMPUTED FOR OPEN ORDERS]',
        '',
        '- Totals include tax and shipping.',
        '  - Rounded to 2 decimals.',
        "  - Shown in the order's currency.",
        '- Use `order_total` everywhere; the old ~~grand_total~~ column goes away.',
        '- [DATA] Backfill `order_total` for open orders.',
        '',
        '#### Orders list with totals',
        '',
        '[fig-01 "Orders list with totals"]',
        '',
        '- The total column is right-aligned.',
        '- Empty totals show a dash.',
        '',
        'Mock-up with example data. Layout and content are the reference.',
        '',
        ...rules,
        '',
        '## Related notes from other sections',
        'From "Data changes":',
        '| `orders` | add order_total; drop grand_total | [CHANGE] [DATA] |',
        '',
        'From "Tests and sign-off":',
        '- A1 · 0.005 rounds to 0.01; an order without lines totals 0. [✓ DONE]'
      ].join('\n')
    )
  })

  it('adds the open questions and leaves out what a ticket does not have', () => {
    expect(drafts[1].description).toBe(
      [
        'Implement task A2 — Counters — from the spec document "Acme · Orders area · Changes round 1".',
        '',
        'Spec files (read-only):',
        '- Full text: /runs/r1/document.md (search for "A2 · Counters (stats row)")',
        '- Original document: /Users/me/Downloads/orders round 1.html (it may embed large base64 images; prefer the text version)',
        '',
        LEGEND,
        '',
        '## Task (verbatim from the spec)',
        '### A2 · Counters (stats row) [FIX]',
        '',
        '- One definition per counter, used by the number and by the filtered view.',
        '- "Today" is the warehouse day, 00:00–24:00 Europe/Berlin.',
        '',
        '| Counter | Exact definition |',
        '| Orders · Open | status ≠ Cancelled and not shipped |',
        '| Late [RENAMED] | open and due_date older than late days (Settings, 2) |',
        '',
        '#### Stats row',
        '',
        '[fig-02 "Stats row \'after\' the fix"]',
        '',
        '- Each counter is clickable.',
        '',
        ...rules,
        '',
        '## Related notes from other sections',
        'From "Tests and sign-off":',
        '- A2 · Each counter equals the rows shown after clicking it.',
        '',
        '## Open questions noted in the spec',
        '- Which time zone applies to Late?'
      ].join('\n')
    )

    const bare = build(
      reply([ticket({ relatedBlocks: [], blocks: [[47, 49]] })], { globalBlocks: [] })
    )[0].description
    expect(bare).toBe(
      [
        'Implement task A1 — Order totals — from the spec document "Acme · Orders area · Changes round 1".',
        '',
        'Spec files (read-only):',
        '- Full text: /runs/r1/document.md (search for "B2 · Export history")',
        '- Original document: /Users/me/Downloads/orders round 1.html (it may embed large base64 images; prefer the text version)',
        '',
        LEGEND,
        '',
        '## Task (verbatim from the spec)',
        '### B2 · Export history [CHANGE]',
        '',
        '1. Keep the last 20 exports per user.',
        '2. Older ones are soft-deleted.'
      ].join('\n')
    )
  })

  it('maps the remaining fields one to one', () => {
    expect(drafts.map((draft) => ({ ...draft, description: '' }))).toEqual([
      {
        key: 'A1',
        title: 'Order totals',
        summary: 'Totals include tax and shipping and are stored in one column.',
        description: '',
        kind: 'fix',
        depends_on: [],
        has_migration: true,
        size: 'M',
        conflict_risk: 'high',
        doc_status: 'done',
        selected: false,
        figures: [
          { id: 'fig-01', path: '/runs/r1/figures/fig-01.png', label: 'Orders list with totals' }
        ],
        open_questions: []
      },
      {
        key: 'A2',
        title: 'Counters',
        summary: 'One definition per counter, shared by the number and the rows.',
        description: '',
        kind: 'fix',
        depends_on: ['A1'],
        has_migration: false,
        size: 'S',
        conflict_risk: 'low',
        doc_status: 'open',
        selected: true,
        figures: [],
        open_questions: ['Which time zone applies to Late?']
      },
      expect.objectContaining({
        key: 'B1',
        depends_on: ['A1', 'A2'],
        doc_status: 'unknown',
        selected: true,
        figures: [{ id: 'fig-03', path: '/runs/r1/figures/fig-03.jpg', label: 'Export dialog' }]
      }),
      expect.objectContaining({ key: 'B2', depends_on: ['B1'], selected: true, figures: [] })
    ])
  })

  it('deselects only the tickets the document marks done', () => {
    const statuses = ['done', 'open', 'partial', 'unknown']
    const built = build(
      reply(statuses.map((docStatus, index) => ticket({ key: `K${index}`, docStatus })))
    )
    expect(built.map((draft) => [draft.doc_status, draft.selected])).toEqual([
      ['done', false],
      ['open', true],
      ['partial', true],
      ['unknown', true]
    ])
  })

  it('attaches the figures of the task that have a file, in document order', () => {
    const everything = reply([
      ticket({
        blocks: [
          [30, 45],
          [15, 25]
        ]
      })
    ])
    expect(build(everything)[0].figures).toEqual([
      { id: 'fig-01', path: '/runs/r1/figures/fig-01.png', label: 'Orders list with totals' },
      { id: 'fig-03', path: '/runs/r1/figures/fig-03.jpg', label: 'Export dialog' }
    ])

    const none = build(everything, {})[0]
    expect(none.figures).toEqual([])
    expect(none.description).not.toContain('attached images')
    // Figures outside the ticket's own blocks are not attached, related or not.
    expect(
      build(reply([ticket({ blocks: [[26, 31]], relatedBlocks: [22, 44] })]))[0].figures
    ).toEqual([])
    expect(build(everything, { 'fig-02': '/f/2.png', toString: '/f/x.png' })[0].figures).toEqual([
      { id: 'fig-02', path: '/f/2.png', label: 'Stats row "after" the fix' }
    ])
  })

  it('labels a figure without alt text by its number', () => {
    const untitled = preprocessDocument({
      fileName: 'shots.html',
      content: '<h2>T1 · Shots</h2><p><img src="a.png"></p><p><img src="b.png" alt="<Named>"></p>'
    })
    const built = buildItemDrafts({
      result: parse(
        JSON.stringify({ tickets: [{ key: 'T1', title: 'Shots', blocks: [[1, 3]] }] }),
        untitled
      ),
      doc: untitled,
      sourcePath: SOURCE_PATH,
      documentPath: DOCUMENT_PATH,
      figurePaths: { 'fig-01': '/f/1.png', 'fig-02': '/f/2.png' }
    })
    expect(built[0].figures).toEqual([
      { id: 'fig-01', path: '/f/1.png', label: 'Figure 1' },
      { id: 'fig-02', path: '/f/2.png', label: 'Named' }
    ])
  })

  it('caps the shared sections and says so', () => {
    const rows = Array.from(
      { length: 150 },
      (_value, index) => `<tr><td>Rule ${index + 1}</td><td>${'binding text '.repeat(8)}</td></tr>`
    )
    const big = preprocessDocument({
      fileName: 'big.html',
      content: `<h2>T1 · Task</h2><p>Task body.</p><h2>Rules</h2><table>${rows.join('')}</table><h2>Tests</h2><p>${'one very long paragraph '.repeat(600)}</p>`
    })
    const lastRow = 4 + rows.length - 1
    const result = parse(
      JSON.stringify({
        globalBlocks: [[3, lastRow]],
        tickets: [{ key: 'T1', title: 'Task', blocks: [[1, 2]], relatedBlocks: [lastRow + 2] }]
      }),
      big
    )
    const description = buildItemDrafts({
      result,
      doc: big,
      sourcePath: SOURCE_PATH,
      documentPath: DOCUMENT_PATH,
      figurePaths: {}
    })[0].description

    const section = (title: string): string => {
      const start = description.indexOf(`## ${title}`)
      const next = description.indexOf('\n## ', start + 1)
      return description.slice(start, next === -1 ? undefined : next).trimEnd()
    }
    const global = section('Rules that apply to every task in this document')
    expect(global.endsWith('|\n… (truncated; see the full text)')).toBe(true)
    expect(global.length).toBeGreaterThan(5000)
    expect(global.length).toBeLessThan(6200)
    expect(global).toContain('| Rule 1 |')
    expect(global).not.toContain('| Rule 150 |')

    // One block longer than the cap is cut inside the block.
    const related = section('Related notes from other sections')
    expect(related.endsWith('\n… (truncated; see the full text)')).toBe(true)
    expect(related.length).toBeLessThan(6200)
    expect(related).toContain('From "Tests":\none very long paragraph')

    expect(section('Task (verbatim from the spec)')).toBe(
      '## Task (verbatim from the spec)\n### T1 · Task\n\nTask body.'
    )
  })

  it('closes a code fence the cap cuts through', () => {
    const schema = Array.from({ length: 400 }, (_value, index) => `column_${index}: text not null`)
    const spec = preprocessDocument({
      fileName: 'spec.md',
      content: [
        '## T1 · Task',
        'Task body.',
        '## Rules',
        'The schema every task builds on:',
        '```yaml',
        ...schema,
        '```',
        'After the schema.'
      ].join('\n')
    })
    const description = buildItemDrafts({
      result: parse(
        JSON.stringify({
          globalBlocks: [[3, 6]],
          tickets: [{ key: 'T1', title: 'Task', blocks: [[1, 2]], openQuestions: ['Which DB?'] }]
        }),
        spec
      ),
      doc: spec,
      sourcePath: SOURCE_PATH,
      documentPath: DOCUMENT_PATH,
      figurePaths: {}
    })[0].description

    const fenceLines = description.split('\n').filter((line) => /^`{3,}/.test(line))
    expect(fenceLines).toEqual(['```', '```'])
    expect(description).toContain(
      'text not null\n```\n… (truncated; see the full text)\n\n## Open questions noted in the spec'
    )
    expect(description).not.toContain('After the schema.')
  })

  it('does not take a paragraph that starts with backticks for an open fence', () => {
    // Markdown reads a one-line ```…``` as an inline span; plain text keeps pasted fences as
    // paragraph text. Neither opens a fence, so no closer must be appended to a capped section.
    const rules = Array.from(
      { length: 120 },
      (_value, index) => `Rule ${index + 1}: ${'binding text '.repeat(4)}`
    )
    const cases = [
      {
        fileName: 'spec.md',
        fence: '```run `pnpm test` first```',
        rendered: '```run `pnpm test` first```'
      },
      { fileName: 'spec.txt', fence: '```json\n{"a": 1}\n```', rendered: '```json {"a": 1} ```' }
    ]
    for (const { fileName, fence, rendered } of cases) {
      const spec = preprocessDocument({
        fileName,
        content: ['## T1 · Task', 'Task body.', '## Rules', fence, ...rules, 'After the rules.']
          .map((line) => `${line}\n`)
          .join('\n')
      })
      expect(spec.blocks[3]).toMatchObject({ type: 'paragraph', text: rendered })
      const description = buildItemDrafts({
        result: parse(
          JSON.stringify({
            globalBlocks: [[3, 4 + rules.length]],
            tickets: [{ key: 'T1', title: 'Task', blocks: [[1, 2]], openQuestions: ['Which DB?'] }]
          }),
          spec
        ),
        doc: spec,
        sourcePath: SOURCE_PATH,
        documentPath: DOCUMENT_PATH,
        figurePaths: {}
      })[0].description

      const fenceLines = description.split('\n').filter((line) => /^`{3,}/.test(line))
      expect(fenceLines).toEqual([rendered])
      expect(description).toMatch(
        /\nRule \d+: binding text[^\n]*\n… \(truncated; see the full text\)\n\n## Open questions noted in the spec/
      )
      expect(description).not.toContain('After the rules.')
    }
  })

  it('does not repeat a block the ticket already holds', () => {
    const built = build(
      reply([ticket({ blocks: [[4, 25]], relatedBlocks: [5, 20, 53] })], {
        globalBlocks: [4, 5, 6, 53]
      })
    )[0].description
    expect(built.split('- Build on what exists').length - 1).toBe(1)
    expect(built).toContain(
      '## Rules that apply to every task in this document\n| `orders` | add order_total; drop grand_total | [CHANGE] [DATA] |'
    )
    expect(built).not.toContain('## Related notes from other sections')
  })

  it('says so when the task text could not be located', () => {
    const built = build(reply([ticket({ key: 'T9', title: 'Nowhere', blocks: [] })]))[0]
    expect(built.description).toContain('(search for "T9")')
    expect(built.description).toContain(
      '## Task (verbatim from the spec)\n(The text of this task could not be located in the document. Find T9 in the full text.)'
    )
    expect(built.figures).toEqual([])
  })
})

describe('buildExtractionMeta', () => {
  it('summarises the extraction for the preview', () => {
    const result = parse(reply([ticket({ blocks: [15, 25] })]))
    expect(buildExtractionMeta({ result, doc, generatedBy: 'claude-code · haiku' })).toEqual({
      documentTitle: 'Acme · Orders area · Changes round 1',
      numbering: 'A1…B2',
      openQuestions: ['Who supplies the default for late days?'],
      warnings: ['A1: blocks [15,25] read as the range b15-b25.'],
      generatedBy: 'claude-code · haiku',
      textLength: doc.text.length,
      figureCount: 3
    })
  })

  it('falls back to the document title', () => {
    const result = { ...parse(reply([ticket()])), documentTitle: '' }
    const meta = buildExtractionMeta({ result, doc, generatedBy: null })
    expect(meta.documentTitle).toBe(doc.title)
    expect(meta.generatedBy).toBeNull()
  })
})
