import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  type DocumentRunItem,
  type DocumentRunReport
} from '../types/document-flow'
import {
  RUN_STATUS_MARKERS,
  renderRunStatusBlock,
  runStatusInput,
  upsertRunStatusBlock,
  type RunStatusInput,
  type RunStatusTask
} from './document-status'

// The run status summary written at the top of the source document when a run finishes.

const task = (overrides: Partial<RunStatusTask> = {}): RunStatusTask => ({
  key: 'A1',
  title: 'Checkout flow',
  status: 'merged',
  statusDetail: null,
  verification: [],
  documentUpdate: 'done',
  documentUpdateDetail: null,
  report: null,
  ...overrides
})

const input = (overrides: Partial<RunStatusInput> = {}): RunStatusInput => ({
  generatedAt: '2026-10-19T13:41:07.000Z',
  integrationBranch: 'doc-factory',
  headSha: '0123456789abcdef',
  tasks: [task()],
  verify: null,
  manualSteps: [],
  migrations: [],
  ...overrides
})

const { start, end } = RUN_STATUS_MARKERS.markdown

describe('renderRunStatusBlock', () => {
  it('writes the Markdown block: heading, generated line, legend and a row per task', () => {
    const block = renderRunStatusBlock('markdown', input())
    expect(block.split('\n')).toEqual([
      start,
      '## Implementation status',
      '',
      'Generated 2026-10-19 13:41 UTC by the document run · integration branch `doc-factory` @ `0123456`',
      '',
      '✅ Done · ⚠️ Partial / merged as it stood · ⏭️ Skipped · ❌ Not merged',
      '',
      '| Task | Status | Verified | Follow-ups | Document |',
      '| --- | --- | --- | --- | --- |',
      '| **A1** · Checkout flow | ✅ Done | — | — | Updated |',
      end
    ])
  })

  it('words a merged, a merged-as-is, a skipped and an unmerged task', () => {
    const block = renderRunStatusBlock(
      'markdown',
      input({
        tasks: [
          task({
            key: 'A1',
            verification: ['playwright', 'tests'],
            report: {
              outcome: 'updated',
              verified: 'tests: 12 passed',
              followUps: [],
              notes: 'Struck A1.'
            }
          }),
          task({
            key: 'A2',
            title: 'Empty state',
            statusDetail: 'Merged as it stood. The agent ended on: the icon is missing',
            verification: ['playwright', 'tests'],
            report: {
              outcome: 'updated',
              verified: null,
              followUps: ['Add the icon', 'Translate the label'],
              notes: null
            }
          }),
          task({
            key: 'A3',
            title: 'Already there',
            status: 'skipped',
            documentUpdate: 'failed',
            documentUpdateDetail: 'The document was not changed.'
          }),
          task({
            key: 'A4',
            title: 'Exports',
            status: 'needs_attention',
            documentUpdate: null
          })
        ]
      })
    )
    const rows = block.split('\n').filter((line) => line.startsWith('| **'))
    expect(rows).toEqual([
      '| **A1** · Checkout flow | ✅ Done | tests: 12 passed | None | Updated |',
      '| **A2** · Empty state | ⚠️ Partial | Not confirmed (asked for playwright, tests) | Add the icon; Translate the label | Updated |',
      '| **A3** · Already there | ✅ Done (already implemented) | — | — | Not updated: The document was not changed. |',
      '| **A4** · Exports | ❌ Not merged (needs attention) | — | — | Not updated |'
    ])
  })

  it('never words the asked-for methods as checks that ran, nor a skip by the user as done', () => {
    const block = renderRunStatusBlock(
      'markdown',
      input({
        tasks: [
          task({ key: 'A1', verification: ['tests', 'playwright'] }),
          task({
            key: 'A2',
            status: 'needs_attention',
            verification: ['tests', 'playwright'],
            documentUpdate: null
          }),
          task({ key: 'A3', status: 'skipped', documentUpdate: null })
        ]
      })
    )
    const rows = block.split('\n').filter((line) => line.startsWith('| **'))
    expect(rows).toEqual([
      '| **A1** · Checkout flow | ✅ Done | Not confirmed (asked for tests, playwright) | — | Updated |',
      '| **A2** · Checkout flow | ❌ Not merged (needs attention) | — | — | Not updated |',
      '| **A3** · Checkout flow | ⏭️ Skipped | — | — | Not updated |'
    ])
  })

  it('counts a merge adopted at the end of the run with its caveat as partial', () => {
    const block = renderRunStatusBlock(
      'markdown',
      input({
        tasks: [
          task({
            statusDetail:
              'Merged, but its checks were not confirmed before the run ended. Merged as it stood. The agent ended on: x'
          })
        ]
      })
    )
    expect(block).toContain('| ⚠️ Partial |')
  })

  it('adds the checks, manual steps and migrations after the table', () => {
    const block = renderRunStatusBlock(
      'markdown',
      input({
        verify: { command: 'pnpm test', ok: false },
        manualSteps: ['Rotate the API key'],
        migrations: ['db/migrations/0042_orders.sql']
      })
    )
    expect(block).toContain('\n\nChecks after the merges: `pnpm test` failed\n')
    expect(block).toContain('\n**Manual steps**\n\n- Rotate the API key\n')
    expect(block).toContain('\n**Migrations**\n\n- db/migrations/0042_orders.sql\n')
  })

  it('leaves out the lists that are empty and the checks when none ran', () => {
    const block = renderRunStatusBlock('markdown', input({ verify: null }))
    expect(block).not.toContain('Checks after the merges')
    expect(block).not.toContain('Manual steps')
    expect(block).not.toContain('Migrations')
  })

  it('keeps a value from breaking the table or the markers', () => {
    const block = renderRunStatusBlock(
      'markdown',
      input({
        tasks: [
          task({
            title: 'A | B\nC',
            documentUpdate: 'skipped',
            documentUpdateDetail: `oops ${end}`
          })
        ]
      })
    )
    expect(block).toContain('| **A1** · A \\| B C |')
    expect(block.indexOf(end)).toBe(block.length - end.length)
  })

  it('escapes everything in the HTML block', () => {
    const block = renderRunStatusBlock(
      'html',
      input({
        tasks: [task({ title: '<script>alert("x")</script> & co' })],
        verify: { command: 'make check && echo "ok"', ok: true }
      })
    )
    expect(block.startsWith(`${RUN_STATUS_MARKERS.html.start}\n<section`)).toBe(true)
    expect(block.endsWith(`</section>\n${RUN_STATUS_MARKERS.html.end}`)).toBe(true)
    expect(block).toContain('<h2 style="margin:0 0 4px">Implementation status</h2>')
    expect(block).toContain(
      '<strong>A1</strong> · &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co'
    )
    expect(block).not.toContain('<script>')
    expect(block).toContain(
      'Checks after the merges: <code>make check &amp;&amp; echo &quot;ok&quot;</code> passed'
    )
    expect(block).toContain('<code>doc-factory</code> @ <code>0123456</code>')
  })

  it('lays the text block out as aligned plain lines', () => {
    const block = renderRunStatusBlock(
      'text',
      input({
        tasks: [
          task({
            report: { outcome: 'updated', verified: 'tests', followUps: [], notes: null }
          })
        ],
        manualSteps: ['Rotate the API key']
      })
    )
    expect(block.split('\n')).toEqual([
      '==== tedooo run status (generated) ====',
      'Implementation status',
      'Generated 2026-10-19 13:41 UTC by the document run · integration branch doc-factory @ 0123456',
      'Legend: ✅ Done · ⚠️ Partial / merged as it stood · ⏭️ Skipped · ❌ Not merged',
      '',
      'A1 · Checkout flow',
      '  Status:     ✅ Done',
      '  Verified:   tests',
      '  Follow-ups: None',
      '  Document:   Updated',
      '',
      'Manual steps:',
      '  - Rotate the API key',
      '==== end of tedooo run status ===='
    ])
  })

  it('leaves the commit out when the branch head is unknown', () => {
    expect(renderRunStatusBlock('markdown', input({ headSha: '' }))).toContain(
      'integration branch `doc-factory`\n'
    )
  })
})

describe('upsertRunStatusBlock', () => {
  const block = renderRunStatusBlock('markdown', input())

  it('inserts at the top of a Markdown document without a title', () => {
    expect(upsertRunStatusBlock('Intro.\n', 'markdown', block)).toBe(`${block}\n\nIntro.\n`)
  })

  it('inserts after the title of a Markdown document that starts with one', () => {
    expect(upsertRunStatusBlock('# Spec\n\nIntro.\n', 'markdown', block)).toBe(
      `# Spec\n\n${block}\n\nIntro.\n`
    )
    expect(upsertRunStatusBlock('# Spec\nIntro.\n', 'markdown', block)).toBe(
      `# Spec\n\n${block}\n\nIntro.\n`
    )
  })

  it('inserts after the front matter, and after a title that follows it', () => {
    const front = '---\ntitle: Spec\n---\n'
    expect(upsertRunStatusBlock(`${front}Intro.\n`, 'markdown', block)).toBe(
      `${front}\n${block}\n\nIntro.\n`
    )
    expect(upsertRunStatusBlock(`${front}\n# Spec\n\nIntro.\n`, 'markdown', block)).toBe(
      `${front}\n# Spec\n\n${block}\n\nIntro.\n`
    )
  })

  it('takes a leading thematic break for content, not for front matter', () => {
    const document = '---\n\nIntro.\n## A\ntext\n\n---\n\n## B\n'
    expect(upsertRunStatusBlock(document, 'markdown', block)).toBe(`${block}\n\n${document}`)
  })

  it('does not take a title further down for the document title', () => {
    expect(upsertRunStatusBlock('Intro.\n\n# Later\n', 'markdown', block)).toBe(
      `${block}\n\nIntro.\n\n# Later\n`
    )
  })

  it('replaces the block between the markers, and running twice changes nothing', () => {
    const once = upsertRunStatusBlock('# Spec\n\nIntro.\n', 'markdown', block)
    expect(upsertRunStatusBlock(once, 'markdown', block)).toBe(once)

    const newer = renderRunStatusBlock(
      'markdown',
      input({ generatedAt: '2026-10-20T08:00:00.000Z' })
    )
    const twice = upsertRunStatusBlock(once, 'markdown', newer)
    expect(twice).toBe(`# Spec\n\n${newer}\n\nIntro.\n`)
    expect(twice.split(start)).toHaveLength(2)
  })

  it('replaces a block wherever the user moved it, touching nothing around it', () => {
    const document = `# Spec\n\nIntro.\n\n${start}\nold\n${end}\n\n## A1\n`
    expect(upsertRunStatusBlock(document, 'markdown', block)).toBe(
      `# Spec\n\nIntro.\n\n${block}\n\n## A1\n`
    )
  })

  it('leaves markers quoted in the text or in a code example alone', () => {
    const quoted = `# Spec\n\nMarkers \`${start}\` … \`${end}\` wrap it.\n`
    expect(upsertRunStatusBlock(quoted, 'markdown', block)).toBe(
      `# Spec\n\n${block}\n\nMarkers \`${start}\` … \`${end}\` wrap it.\n`
    )
    const fenced = `# Spec\n\n\`\`\`\n${start}\nexample\n${end}\n\`\`\`\n`
    const once = upsertRunStatusBlock(fenced, 'markdown', block)
    expect(once).toBe(`# Spec\n\n${block}\n\n\`\`\`\n${start}\nexample\n${end}\n\`\`\`\n`)
    // The block the run wrote is the one replaced from then on, never the example.
    expect(upsertRunStatusBlock(once, 'markdown', block)).toBe(once)
  })

  it('keeps the document’s CRLF line endings', () => {
    const result = upsertRunStatusBlock('# Spec\r\n\r\nIntro.\r\n', 'markdown', block)
    expect(result).toBe(`# Spec\r\n\r\n${block.replace(/\n/g, '\r\n')}\r\n\r\nIntro.\r\n`)
    expect(result.replace(/\r\n/g, '')).not.toContain('\n')
    expect(upsertRunStatusBlock(result, 'markdown', block)).toBe(result)
  })

  it('inserts right after <body> in HTML', () => {
    const html = renderRunStatusBlock('html', input())
    const document =
      '<!DOCTYPE html>\n<html><head><title>x</title></head>\n<body class="doc">\n<h1>Spec</h1>\n</body></html>\n'
    const result = upsertRunStatusBlock(document, 'html', html)
    expect(result).toBe(
      `<!DOCTYPE html>\n<html><head><title>x</title></head>\n<body class="doc">\n${html}\n<h1>Spec</h1>\n</body></html>\n`
    )
    expect(upsertRunStatusBlock(result, 'html', html)).toBe(result)
  })

  it('inserts an HTML fragment at the top, after a doctype if it has one', () => {
    const html = renderRunStatusBlock('html', input())
    expect(upsertRunStatusBlock('<h1>Spec</h1>\n', 'html', html)).toBe(`${html}\n<h1>Spec</h1>\n`)
    expect(upsertRunStatusBlock('<!doctype html>\n<h1>Spec</h1>', 'html', html)).toBe(
      `<!doctype html>\n${html}\n<h1>Spec</h1>`
    )
  })

  it('uses the text markers for a plain-text document', () => {
    const text = renderRunStatusBlock('text', input())
    const once = upsertRunStatusBlock('SPEC\n\nA1. Checkout\n', 'text', text)
    expect(once).toBe(`${text}\n\nSPEC\n\nA1. Checkout\n`)
    expect(once.startsWith(RUN_STATUS_MARKERS.text.start)).toBe(true)
    expect(upsertRunStatusBlock(once, 'text', text)).toBe(once)
  })

  it('writes a block into an empty document', () => {
    expect(upsertRunStatusBlock('', 'markdown', block)).toBe(`${block}\n`)
  })
})

describe('runStatusInput', () => {
  const item = (overrides: Partial<DocumentRunItem>): DocumentRunItem =>
    ({
      key: 'A1',
      title: 'Task',
      position: 0,
      selected: true,
      status: 'merged',
      status_detail: null,
      verification: ['tests'],
      document_update_status: 'done',
      document_update_detail: 'Struck it.',
      document_update_report: null,
      ...overrides
    }) as DocumentRunItem

  const report = {
    generatedAt: '2026-10-19T13:41:07.000Z',
    integrationBranch: 'doc-factory',
    headSha: 'abc',
    verify: { command: 'pnpm test', ok: true, output: 'lots of output' },
    manualSteps: ['Step'],
    migrations: []
  } as unknown as DocumentRunReport

  it('takes the selected items in document order', () => {
    const result = runStatusInput(
      { config: DEFAULT_DOCUMENT_RUN_CONFIG },
      [
        item({ key: 'A3', position: 2 }),
        item({ key: 'A1', position: 0 }),
        item({ key: 'A2', position: 1, selected: false })
      ],
      report
    )
    expect(result.tasks.map((entry) => entry.key)).toEqual(['A1', 'A3'])
    expect(result.verify).toEqual({ command: 'pnpm test', ok: true })
    expect(result.tasks[0]).toMatchObject({ verification: ['tests'], documentUpdate: 'done' })
  })

  it('lists no verification methods while verification is off for the run', () => {
    const result = runStatusInput(
      { config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verificationDisabled: true } },
      [item({})],
      report
    )
    expect(result.tasks[0].verification).toEqual([])
  })
})
