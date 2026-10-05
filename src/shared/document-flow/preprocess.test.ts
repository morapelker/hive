import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  detectDocumentFormat,
  preprocessDocument,
  renderBlocks,
  type DocumentBlock,
  type PreprocessedDocument
} from './preprocess'

const html = (content: string, fileName = 'spec.html'): PreprocessedDocument =>
  preprocessDocument({ fileName, content })

const markdown = (content: string, fileName = 'spec.md'): PreprocessedDocument =>
  preprocessDocument({ fileName, content })

const texts = (doc: PreprocessedDocument): string[] => doc.blocks.map((block) => block.text)

const blockWith = (doc: PreprocessedDocument, needle: string): DocumentBlock => {
  const block = doc.blocks.find((candidate) => candidate.text.includes(needle))
  if (!block) throw new Error(`no block contains "${needle}"`)
  return block
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('preprocessDocument — HTML spec sample', () => {
  const source = readFileSync(join(__dirname, '__fixtures__', 'spec-sample.html'), 'utf8')
  const doc = html(source, '/Users/someone/Downloads/spec-sample.html')

  it('takes the title from <title>', () => {
    expect(doc.format).toBe('html')
    expect(doc.title).toBe('Acme · Orders area · Changes round 1')
  })

  it('numbers blocks from 1 without gaps', () => {
    expect(doc.blocks.length).toBeGreaterThan(40)
    expect(doc.blocks.map((block) => block.id)).toEqual(
      doc.blocks.map((_block, index) => index + 1)
    )
  })

  it('keeps no base64 in the blocks or the text', () => {
    expect(source).toContain(PNG_BASE64)
    expect(doc.text).not.toContain('base64')
    expect(doc.text).not.toContain('iVBORw0KGgo')
    expect(doc.text).not.toContain('/9j/4AAQ')
    expect(JSON.stringify(doc.blocks)).not.toContain('iVBORw0KGgo')
    expect(doc.text.length).toBeLessThan(source.length)
  })

  it('extracts the figures in document order', () => {
    expect(doc.figures).toEqual([
      {
        id: 'fig-01',
        alt: 'Orders list with totals',
        mime: 'image/png',
        base64: PNG_BASE64,
        src: null
      },
      {
        id: 'fig-02',
        alt: 'Stats row "after" the fix',
        mime: null,
        base64: null,
        src: 'img/stats-row.png'
      },
      {
        id: 'fig-03',
        alt: 'Export dialog',
        mime: 'image/jpeg',
        base64: expect.stringMatching(/^\/9j\/4AAQ[A-Za-z0-9+/]+=$/),
        src: null
      }
    ])
    expect(
      doc.blocks.filter((block) => block.type === 'figure').map((block) => block.text)
    ).toEqual([
      '[fig-01 "Orders list with totals"]',
      '[fig-02 "Stats row \'after\' the fix"]',
      '[fig-03 "Export dialog"]'
    ])
  })

  it('drops navigation, styles, scripts, comments and hidden elements', () => {
    for (const leaked of [
      'Rules & decisions',
      'A Fixes',
      'must not leak',
      'display:none',
      'className',
      'saved from url',
      'not a heading'
    ]) {
      expect(doc.text).not.toContain(leaked)
    }
  })

  it('decodes entities', () => {
    expect(doc.text).toContain('in build order A → B.')
    expect(doc.text).toContain('UTF-8 & BOM.')
    expect(doc.text).toContain('Totals > 0 round half up')
  })

  it('brackets tags and status badges', () => {
    expect(blockWith(doc, 'A1 · Order totals')).toMatchObject({
      type: 'heading',
      level: 3,
      text: 'A1 · Order totals [FIX] [✓ DONE] [LIVE · MIGRATION APPLIED 5 OCT · TOTALS RECOMPUTED FOR OPEN ORDERS]'
    })
    expect(blockWith(doc, 'PART A').text).toBe('PART A · FIXES (do these first) [✓ DONE]')
    expect(blockWith(doc, 'B1 · CSV export').text).toBe('B1 · CSV export [NEW] [DATA]')
    expect(blockWith(doc, 'bug fix').text).toBe(
      '[FIX] bug fix [CHANGE] change [NEW] new [DATA] data migration🔒 managers only'
    )
    expect(blockWith(doc, 'The file opens in Excel').text).toBe(
      'B · The file opens in Excel with the right separator. [SQL READY · RUN BY HAND]'
    )
  })

  it('does not bracket emphasis that is not a badge', () => {
    expect(doc.text).toContain('Work in the order A → B. After each part')
    expect(doc.text).toContain('- A1 · 0.005 rounds to 0.01')
    expect(doc.text).toContain("Build on what exists; don't rebuild screens")
  })

  it('keeps one language of a bilingual pair', () => {
    expect(doc.text).toContain('Questions go to the product owner before work starts.')
    expect(doc.text).not.toMatch(/\p{Script=Hebrew}/u)
  })

  it('keeps a repeated disclaimer every time, where it stands', () => {
    expect(source.split('Mock-up with example data.').length - 1).toBe(6)
    const disclaimers = doc.blocks.filter((block) =>
      block.text.startsWith('Mock-up with example data.')
    )
    expect(disclaimers).toHaveLength(6)
    // Under each mock-up's caption (A1, A2 twice, B1, B2) and once at the very end.
    expect(disclaimers.map((block) => block.id)).toEqual([25, 35, 36, 46, 50, 63])
    expect(doc.text).toContain('Mock-ups use example data.')
  })

  it('gives headings their own id or that of the element they open', () => {
    expect(blockWith(doc, 'How to apply these changes')).toMatchObject({
      type: 'heading',
      level: 2,
      anchor: 'rules'
    })
    expect(blockWith(doc, 'B1 · CSV export')).toMatchObject({ level: 3, anchor: 'b' })
    // Second heading of the same <section>: no longer its first content.
    expect(blockWith(doc, 'B2 · Export history').anchor).toBeNull()
    expect(blockWith(doc, 'A1 · Order totals').anchor).toBeNull()
    expect(blockWith(doc, 'Orders area: changes')).toMatchObject({ level: 1, anchor: null })
  })

  it('renders table rows with their cells joined', () => {
    expect(blockWith(doc, 'Topic')).toMatchObject({ type: 'table-row', text: 'Topic | Decision' })
    expect(blockWith(doc, 'CSV with a').text).toBe(
      'Export | CSV with a `;` separator, UTF-8 & BOM.'
    )
    expect(blockWith(doc, 'Late [RENAMED]').text).toBe(
      'Late [RENAMED] | open and due_date older than late days (Settings, 2)'
    )
    expect(blockWith(doc, 'add order_total').text).toBe(
      '`orders` | add order_total; drop grand_total | [CHANGE] [DATA]'
    )
  })

  it('indents nested list items, numbers ordered ones and marks struck text', () => {
    expect(blockWith(doc, 'Totals include tax')).toMatchObject({
      type: 'list-item',
      text: 'Totals include tax and shipping.'
    })
    expect(blockWith(doc, 'Rounded to 2 decimals').text).toBe('  Rounded to 2 decimals.')
    expect(blockWith(doc, 'the old').text).toBe(
      'Use `order_total` everywhere; the old ~~grand_total~~ column goes away.'
    )
    expect(blockWith(doc, 'Keep the last 20').text).toBe('1. Keep the last 20 exports per user.')
    expect(blockWith(doc, 'Older ones').text).toBe('2. Older ones are soft-deleted.')
  })

  it('splits a card that mixes running text and a list', () => {
    const report = blockWith(doc, 'Done and live')
    expect(report.type).toBe('paragraph')
    expect(report.text).toBe(
      'Done and live · on `main` (`3edbeb58`), deployed on 5 Oct. A1: totals recomputed; migration `migrations/20261005_order_total/migration.sql` applied. Open: the Late counter waits for part B.'
    )
    expect(doc.blocks[report.id]).toMatchObject({
      type: 'list-item',
      text: 'Counters that were wrong, and the fix'
    })
  })

  it('keeps a caption next to its figure', () => {
    const figure = blockWith(doc, '[fig-03')
    expect(doc.blocks[figure.id - 2]).toMatchObject({
      type: 'heading',
      level: 4,
      text: 'Export dialog'
    })
    expect(doc.blocks[figure.id]).toMatchObject({
      type: 'paragraph',
      text: 'The dialog remembers the last choice.'
    })
  })

  it('renders the text with ids', () => {
    expect(doc.text).toBe(renderBlocks(doc.blocks, { withIds: true }))
    expect(doc.text.startsWith('[b1] # Orders area: changes, round 1\n\n[b2] Changes to')).toBe(
      true
    )
    expect(doc.text).toContain('\n\n[b4] ## How to apply these changes {#rules}\n\n[b5] - Build on')
    expect(doc.text).toContain('\n[b9] | Topic | Decision |\n[b10] | Delete | ')
    expect(doc.text).toContain('\n[b17]   - Rounded to 2 decimals.\n')
    expect(doc.text).toContain('\n[b48] 1. Keep the last 20 exports per user.\n[b49] 2. Older')
  })

  it('renders the same blocks without ids', () => {
    const plain = renderBlocks(doc.blocks)
    expect(plain).not.toMatch(/\[b\d+\]/)
    expect(plain).toBe(renderBlocks(doc.blocks, { withIds: false }))
    expect(plain.startsWith('# Orders area: changes, round 1\n\nChanges to the live')).toBe(true)
    expect(plain).toContain('\n\n### B1 · CSV export [NEW] [DATA] {#b}\n\n- Managers 🔒 export')
    expect(plain).toContain('\n| Topic | Decision |\n| Delete | Soft delete only.')
  })
})

describe('preprocessDocument — HTML details', () => {
  it('recovers from malformed markup without losing text', () => {
    const doc = html(`<html><body>
      <!-- <div>commented <b>out</b></div> -->
      <div class=card data-x=1>Intro text
        <ul><li>First item<li>Second <b>bold item
        </ul>
      </span></section>
      <p>Paragraph one
      <p>Paragraph two</div></div></div>
      <table><tr><td>Cell A<td>Cell B<tr><td>Cell C</table>
      <h2 id=late>Late heading</h2>
      <p>After the heading
      Text with a < b and an unknown &entity; and &#x4e2d;&#25991;
      <img src=pic.png alt=Unquoted>
      <b>Unclosed bold at the end`)

    expect(texts(doc)).toEqual([
      'Intro text',
      'First item',
      'Second bold item',
      'Paragraph one',
      'Paragraph two',
      'Cell A | Cell B',
      'Cell C',
      'Late heading',
      'After the heading Text with a < b and an unknown &entity; and 中文 [fig-01 "Unquoted"] Unclosed bold at the end'
    ])
    expect(doc.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'list-item',
      'list-item',
      'paragraph',
      'paragraph',
      'table-row',
      'table-row',
      'heading',
      'paragraph'
    ])
    expect(blockWith(doc, 'Late heading')).toMatchObject({ level: 2, anchor: 'late' })
    expect(doc.figures).toEqual([
      { id: 'fig-01', alt: 'Unquoted', mime: null, base64: null, src: 'pic.png' }
    ])
    expect(doc.text).not.toContain('commented')
  })

  it.each([
    ['an empty document', ''],
    ['only a doctype', '<!DOCTYPE html>'],
    ['an unterminated comment', '<p>kept</p><!-- never closed <p>lost</p>'],
    ['an unterminated tag', '<p>kept</p><div class="x'],
    ['an unterminated script', '<p>kept</p><script>var a = "<p>lost</p>"'],
    ['stray end tags only', '</div></p></table></li>'],
    ['a lone angle bracket', '<'],
    ['an end tag at the very end', 'kept</']
  ])('does not throw on %s', (_name, content) => {
    const doc = html(content)
    expect(doc.blocks.every((block) => block.text.trim() !== '')).toBe(true)
    expect(doc.text).not.toContain('lost')
    if (content.includes('kept')) expect(doc.text).toContain('kept')
  })

  it('falls back to the first h1, then to the file name, for the title', () => {
    expect(html('<body><h2>Section</h2><h1>Real <em>title</em></h1></body>').title).toBe(
      'Real title'
    )
    expect(html('<p>No headings here</p>', '/tmp/My spec v2.final.html').title).toBe(
      'My spec v2.final'
    )
    expect(html('<title>  </title><p>x</p>', 'C:\\docs\\plan.htm').title).toBe('plan')
  })

  it('ignores a <title> inside an inline svg', () => {
    const doc = html(
      '<body><svg><title>Icon title</title><text>svg text</text></svg><h1>Doc</h1></body>'
    )
    expect(doc.title).toBe('Doc')
    expect(doc.text).not.toContain('svg text')
  })

  it('drops subtrees that are hidden or never rendered', () => {
    const doc = html(`<body>
      <noscript>Enable JavaScript</noscript><template><p>Template text</p></template>
      <p>Visible <span aria-hidden="true">★ decorative</span>text</p>
      <div style="color: red; DISPLAY : NONE"><p>Styled away</p></div>
      <p hidden>Attribute hidden</p>
      <div aria-hidden="false">Announced</div>
      <style>p::after { content: "css" }</style>
    </body>`)
    expect(texts(doc)).toEqual(['Visible text', 'Announced'])
  })

  it('keeps the first language when a bilingual document has no English', () => {
    const doc = html(`<body class="he">
      <div class="L he"><h2>כותרת</h2><p>טקסט</p></div>
      <div class="L fr"><h2>Titre</h2><p>Texte</p></div>
      <p>Shared <span class="L he">עברית</span><span class="L fr">français</span></p>
    </body>`)
    expect(texts(doc)).toEqual(['כותרת', 'טקסט', 'Shared עברית'])
  })

  it('prefers English whatever the page currently shows', () => {
    const doc = html(`<body class="he">
      <div class="L he">עברית</div>
      <div class="L en" style="display:none">English text</div>
    </body>`)
    expect(texts(doc)).toEqual(['English text'])
  })

  it('keeps every block of a document written in one language', () => {
    const doc = html(
      '<div class="L he">ראשון</div><div class="L he">שני</div><div class="L">x</div>'
    )
    expect(texts(doc)).toEqual(['ראשון', 'שני', 'x'])
  })

  it('brackets short upper-case badges only', () => {
    const doc = html(`<body>
      <p>One <span>NEW</span> two <b>FIX</b> three <em>P1 URGENT</em> four <mark>✓ DONE</mark> five <small>WIP</small></p>
      <p>The <b>EN / 中文</b> switch, order <b>A → G</b>, task <b>A1</b>, part <b>B</b>, <b>Done</b>, <i>follow-up days</i></p>
      <p><b>THIS SENTENCE IS SHOUTED BUT FAR TOO LONG TO BE A BADGE</b></p>
      <p><span class="chip">QUALIFIER PAST THIRTY CHARACTERS · STILL A CHIP</span> <span>QUALIFIER PAST THIRTY CHARACTERS · NOT STYLED</span></p>
      <p>tight<span class="a">ONE</span><span class="b">TWO</span>(<span>IN PARENS</span>)</p>
    </body>`)
    expect(texts(doc)).toEqual([
      'One [NEW] two [FIX] three [P1 URGENT] four [✓ DONE] five [WIP]',
      'The EN / 中文 switch, order A → G, task A1, part B, Done, follow-up days',
      'THIS SENTENCE IS SHOUTED BUT FAR TOO LONG TO BE A BADGE',
      '[QUALIFIER PAST THIRTY CHARACTERS · STILL A CHIP] QUALIFIER PAST THIRTY CHARACTERS · NOT STYLED',
      'tight [ONE] [TWO]([IN PARENS])'
    ])
  })

  it('handles inline code, line breaks, links, checkboxes and whitespace', () => {
    const doc = html(`<p>  Run   <code> pnpm
      test </code>then<br>open <a href="https://example.com/x">the   report</a>.</p>
      <ul><li><input type="checkbox" checked> shipped</li><li><input type=checkbox> pending</li></ul>`)
    expect(texts(doc)).toEqual([
      'Run `pnpm test` then open the report.',
      '[x] shipped',
      '[ ] pending'
    ])
  })

  it('keeps preformatted text as one code block', () => {
    const doc = html(
      '<p>Before</p><pre><code class="language-ts">\nconst a = 1\n\n  if (a &lt; 2) {\n    run()\n  }\n</code></pre><p>After</p>'
    )
    expect(doc.blocks).toEqual([
      { id: 1, type: 'paragraph', text: 'Before' },
      { id: 2, type: 'code', text: 'const a = 1\n\n  if (a < 2) {\n    run()\n  }' },
      { id: 3, type: 'paragraph', text: 'After' }
    ])
    expect(doc.text).toBe(
      '[b1] Before\n\n[b2] ```\nconst a = 1\n\n  if (a < 2) {\n    run()\n  }\n```\n\n[b3] After'
    )
  })

  it('reads tables with sections, empty cells and blocks inside cells', () => {
    const doc = html(`<table><caption>Inputs per step</caption>
      <thead><tr><th>Step<th>Input</thead>
      <tbody>
        <tr><td>1</td><td><p>Name</p><p>Phone</p></td></tr>
        <tr><td>2</td><td></td></tr>
        <tr><td></td><td></td></tr>
        <tr><td>3</td><td><ul><li>QR</li><li>Price <b>list</b></li></ul></td></tr>
        <tr><td>4</td><td><table><tr><td>inner a</td><td>inner b</td></tr></table></td></tr>
      </tbody></table>`)
    expect(doc.blocks.map((block) => [block.type, block.text])).toEqual([
      ['paragraph', 'Inputs per step'],
      ['table-row', 'Step | Input'],
      ['table-row', '1 | Name Phone'],
      ['table-row', '2 | '],
      ['table-row', '3 | - QR - Price list'],
      ['table-row', '4 | inner a inner b']
    ])
  })

  it('reads a layout cell that holds headings and code as ordinary blocks', () => {
    const doc = html(`<table><tr><td>
      <h2>A1 · Title</h2><p>Body</p><ul><li>x</li><li>y</li></ul>
      <pre>a: 1\n  b: 2\nc: 3</pre>
      <h2>A2 · Second</h2><p>More</p>
    </td><td>Side note</td></tr></table>`)
    expect(doc.blocks.map((block) => [block.type, block.text])).toEqual([
      ['heading', 'A1 · Title'],
      ['paragraph', 'Body'],
      ['list-item', 'x'],
      ['list-item', 'y'],
      ['code', 'a: 1\n  b: 2\nc: 3'],
      ['heading', 'A2 · Second'],
      ['paragraph', 'More'],
      ['table-row', 'Side note']
    ])
    expect(blockWith(doc, 'A1 · Title')).toMatchObject({ level: 2 })

    // Text before the heading stays a row; the cells after the layout cell form a row of their own.
    const mixed = html(
      '<table><tr><td>a</td><td>lead <h3>T1</h3><p>p</p></td><td>c</td></tr><tr><td>d</td><td>e</td></tr></table>'
    )
    expect(mixed.blocks.map((block) => [block.type, block.text])).toEqual([
      ['table-row', 'a | lead'],
      ['heading', 'T1'],
      ['paragraph', 'p'],
      ['table-row', 'c'],
      ['table-row', 'd | e']
    ])

    // A <pre> alone (a Confluence code macro in a data table) does not break its row apart:
    // the code is flattened into the cell so the endpoint keeps its example.
    const api = html(
      '<table><tr><th>Endpoint</th><th>Example</th></tr><tr><td>GET /x</td><td><pre>a: 1\nb: 2</pre></td></tr><tr><td>POST /y</td><td>plain</td></tr></table>'
    )
    expect(api.blocks.map((block) => [block.type, block.text])).toEqual([
      ['table-row', 'Endpoint | Example'],
      ['table-row', 'GET /x | a: 1 b: 2'],
      ['table-row', 'POST /y | plain']
    ])
  })

  it('starts a new block at a line break followed by a list marker', () => {
    const doc = html(
      '<p>Tasks:<br>1) Add export<br/>2) Add history<br>- a bullet<br>and a wrapped line</p><p>a<br>b</p>'
    )
    expect(doc.blocks.map((block) => [block.type, block.text])).toEqual([
      ['paragraph', 'Tasks:'],
      ['paragraph', '1) Add export'],
      ['paragraph', '2) Add history'],
      ['paragraph', '- a bullet and a wrapped line'],
      ['paragraph', 'a b']
    ])
  })

  it('reads a document whose <head> is never closed', () => {
    const doc = html(
      '<html><head><title>Spec</title><meta charset="utf-8"><body><h1>Spec</h1><p>Tasks...</p></body></html>'
    )
    expect(doc.title).toBe('Spec')
    expect(doc.blocks.map((block) => [block.type, block.text])).toEqual([
      ['heading', 'Spec'],
      ['paragraph', 'Tasks...']
    ])
    const noBody = html(
      '<!doctype html><head><title>T</title><meta charset="utf-8"><link rel="stylesheet" href="x.css"><h1>Heading</h1><p>Text</p>'
    )
    expect(texts(noBody)).toEqual(['Heading', 'Text'])
    // A dropped subtree inside the head still ends at its own end tag.
    expect(texts(html('<head><template><p>lost</p></template><p>kept</p>'))).toEqual(['kept'])
  })

  it('does not bracket a styled heading or cell wholesale, nor long runs with a plain class', () => {
    const doc = html(`<h1 class="c4"><span class="c3">RELEASE PLAN</span></h1>
      <p class="c2"><span class="c3">Rename the button to </span><span class="c5">SAVE CHANGES</span><span class="c3"> and </span><span class="c5">A LONG SHOUTED RUN THAT IS NOT A CHIP</span></p>
      <table><tr><td class="c1"><p><span class="c0">ID</span></p></td><th><b>STATUS</b></th><td><span class="new">NEW</span></td><td><span class="chg">CHANGE</span><span class="dat">DATA</span></td></tr></table>
      <h3>A2 · Export <span class="s1">DONE</span></h3><h4><span class="s1">✓ DONE</span></h4>`)
    expect(doc.blocks.map((block) => [block.type, block.text])).toEqual([
      ['heading', 'RELEASE PLAN'],
      [
        'paragraph',
        'Rename the button to [SAVE CHANGES] and A LONG SHOUTED RUN THAT IS NOT A CHIP'
      ],
      ['table-row', 'ID | STATUS | [NEW] | [CHANGE] [DATA]'],
      ['heading', 'A2 · Export [DONE]'],
      ['heading', '[✓ DONE]']
    ])
  })

  it('reads a very large single cell in linear time', () => {
    const pieces = Array.from(
      { length: 20_000 },
      (_value, index) => `<p>piece ${index} <b>x${index}</b></p>`
    )
    const content = `<table><tr><td>${pieces.join('')}</td></tr></table>`
    const startedAt = performance.now()
    const doc = html(content)
    expect(performance.now() - startedAt).toBeLessThan(1000)
    expect(doc.blocks).toHaveLength(1)
    expect(doc.blocks[0].text.startsWith('piece 0 x0 piece 1 x1 ')).toBe(true)
  })

  it('does not let an end tag inside a cell close an element around the table', () => {
    const doc = html(
      '<div><table><tr><td>one</div></td><td>two</td></tr></table><p>after</p></div>'
    )
    expect(texts(doc)).toEqual(['one | two', 'after'])
  })

  it('keeps list nesting, list starts and text around nested lists', () => {
    const doc =
      html(`<ol start="3"><li>Third<ol><li>Inner one</li><li value="7">Inner seven</li></ol>tail text</li>
      <li><p>Fourth, first paragraph</p><p>second paragraph</p></li></ol>
      <ul><li>Bullet<ul><li>Deep<ul><li>Deeper</li></ul></li></ul></li></ul>`)
    expect(texts(doc)).toEqual([
      '3. Third',
      '  1. Inner one',
      '  7. Inner seven',
      'tail text',
      '4. Fourth, first paragraph',
      'second paragraph',
      'Bullet',
      '  Deep',
      '    Deeper'
    ])
    expect(doc.blocks.every((block) => block.type === 'list-item')).toBe(true)
    expect(renderBlocks(doc.blocks)).toBe(
      [
        '3. Third',
        '  1. Inner one',
        '  7. Inner seven',
        '- tail text',
        '4. Fourth, first paragraph',
        '- second paragraph',
        '- Bullet',
        '  - Deep',
        '    - Deeper'
      ].join('\n')
    )
  })

  it('keeps a heading whose text sits in a block element', () => {
    const doc = html('<h1><div class="title">Wrapped <span>title</span></div></h1><p>Body</p>')
    expect(doc.blocks).toEqual([
      { id: 1, type: 'heading', level: 1, anchor: null, text: 'Wrapped title' },
      { id: 2, type: 'paragraph', text: 'Body' }
    ])
  })

  it('takes a heading anchor from the heading, its section or an inner anchor', () => {
    const doc =
      html(`<section id="outer"><header><h2>Opens the section</h2></header><h3 id="own">Own id</h3></section>
      <section id="late"><p>Text first</p><h2>Not the first content</h2></section>
      <h2><a name="legacy"></a>Legacy anchor</h2>`)
    expect(
      doc.blocks.filter((block) => block.type === 'heading').map((block) => block.anchor)
    ).toEqual(['outer', 'own', null, 'legacy'])
  })

  it('keeps an inline image inside its text and a lone image as a figure', () => {
    const doc = html(`<p>Click <img src="icons/lock.png" alt="lock"> to lock.</p>
      <p><img src="a.png"></p>
      <ul><li><img src="b.png" alt="B"> in a list</li></ul>
      <table><tr><td><img src="c.png" alt="C"></td><td>cell</td></tr></table>
      <img alt="no source"><img src="  ">`)
    expect(doc.blocks.map((block) => [block.type, block.text])).toEqual([
      ['paragraph', 'Click [fig-01 "lock"] to lock.'],
      ['figure', '[fig-02 ""]'],
      ['list-item', '[fig-03 "B"] in a list'],
      ['table-row', '[fig-04 "C"] | cell']
    ])
    expect(doc.figures.map((figure) => figure.src)).toEqual([
      'icons/lock.png',
      'a.png',
      'b.png',
      'c.png'
    ])
  })

  it('reads data URIs in their different spellings', () => {
    const wrapped = `${PNG_BASE64.slice(0, 40)}\n   ${PNG_BASE64.slice(40)}`
    const doc = html(`
      <img src="DATA:image/PNG;charset=binary;base64,${wrapped}" alt="wrapped">
      <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" alt="svg">
      <img src="data:image/png;base64" alt="broken">
      <img src="https://example.com/a.png?x=1&amp;y=2" alt="remote">`)
    expect(doc.figures).toEqual([
      { id: 'fig-01', alt: 'wrapped', mime: 'image/png', base64: PNG_BASE64, src: null },
      {
        id: 'fig-02',
        alt: 'svg',
        mime: 'image/svg+xml',
        base64: 'PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnLz4=',
        src: null
      },
      { id: 'fig-03', alt: 'broken', mime: null, base64: null, src: null },
      {
        id: 'fig-04',
        alt: 'remote',
        mime: null,
        base64: null,
        src: 'https://example.com/a.png?x=1&y=2'
      }
    ])
    expect(doc.text).not.toContain('data:')
  })

  it('pads figure ids to three digits from a hundred figures on', () => {
    const images = (count: number): string =>
      Array.from({ length: count }, (_value, index) => `<p><img src="${index}.png"></p>`).join('')
    expect(
      html(images(99))
        .figures.map((figure) => figure.id)
        .slice(-2)
    ).toEqual(['fig-98', 'fig-99'])
    const hundred = html(images(100))
    expect(hundred.figures[0].id).toBe('fig-001')
    expect(hundred.figures[99].id).toBe('fig-100')
    expect(hundred.blocks[0].text).toBe('[fig-001 ""]')
  })

  it('keeps the label paragraphs of every task written from a template', () => {
    const task = (n: number): string =>
      `<h3>A${n} · Task ${n}</h3><p>Do thing ${n}.</p>
      <p><strong>Backend changes:</strong></p><ul><li>backend item ${n}</li></ul>
      <p>Acceptance criteria:</p><ul><li>criterion ${n}</li></ul>
      <p><strong>Not in scope for this task:</strong></p><ul><li>later ${n}</li></ul>
      <p>Requires a database migration.</p>`
    const doc = html(Array.from({ length: 5 }, (_value, index) => task(index + 1)).join(''))

    expect(texts(doc).filter((text) => text === 'Backend changes:')).toHaveLength(5)
    expect(texts(doc).filter((text) => text === 'Acceptance criteria:')).toHaveLength(5)
    expect(texts(doc).filter((text) => text === 'Not in scope for this task:')).toHaveLength(5)
    expect(texts(doc).filter((text) => text === 'Requires a database migration.')).toHaveLength(5)
    // The last task reads exactly like the first: each list still has its label.
    expect(renderBlocks(doc.blocks.slice(-9))).toBe(
      [
        '### A5 · Task 5',
        '',
        'Do thing 5.',
        '',
        'Backend changes:',
        '',
        '- backend item 5',
        '',
        'Acceptance criteria:',
        '',
        '- criterion 5',
        '',
        'Not in scope for this task:',
        '',
        '- later 5',
        '',
        'Requires a database migration.'
      ].join('\n')
    )
    expect(doc.blocks.map((block) => block.id)).toEqual(
      doc.blocks.map((_block, index) => index + 1)
    )
  })

  it('removes an embedded payload that reached the text some other way', () => {
    const payload = 'QUJD'.repeat(400)
    const doc = html(`<p>Paste: data:image/png;base64,${payload} end</p>`)
    expect(texts(doc)).toEqual(['Paste: data:image/png;base64,[embedded data removed] end'])
  })

  it('pre-processes a 3 MB document of embedded images quickly', () => {
    const chunk = 'iVBORw0KGgoAAAANSUhEUgAA/+'.repeat(250)
    const image = chunk.repeat(36)
    expect(image.length).toBeGreaterThan(230_000)
    const sections = Array.from(
      { length: 13 },
      (_value, index) =>
        `<h3>T${index + 1} · Task ${index + 1} <span class="new">NEW</span></h3>
<div class="card"><ul><li>Requirement ${index + 1}a</li><li>Requirement ${index + 1}b</li></ul></div>
<figure><img src="data:image/jpeg;base64,${image}" alt="Mock-up ${index + 1}"></figure>`
    )
    const content = `<!DOCTYPE html><html><head><title>Big</title></head><body>${sections.join('\n')}</body></html>`
    expect(content.length).toBeGreaterThan(3_000_000)

    const startedAt = performance.now()
    const doc = html(content, 'big.html')
    const elapsedMs = performance.now() - startedAt

    expect(elapsedMs).toBeLessThan(2000)
    expect(doc.figures).toHaveLength(13)
    expect(
      doc.figures.every((figure) => figure.base64 === image && figure.mime === 'image/jpeg')
    ).toBe(true)
    expect(doc.blocks).toHaveLength(13 * 4)
    expect(doc.text.length).toBeLessThan(2000)
    expect(doc.text).toContain('[b1] ### T1 · Task 1 [NEW]')
    expect(doc.text).toContain('[fig-13 "Mock-up 13"]')
  })
})

describe('preprocessDocument — Markdown', () => {
  it('reads headings, lists, tables, code and paragraphs', () => {
    const doc = markdown(
      [
        '# Orders round 1',
        '',
        'Intro line one',
        'continues here.',
        '',
        '## A1 · Totals {#a1}',
        '',
        '- First item',
        '  wrapped onto a second line',
        '  - Nested item',
        '    1. Deep ordered',
        '- Back at the top',
        '* Other marker',
        '',
        '1. Step one',
        '2) Step two',
        '',
        '| Table | Change |',
        '|:------|-------:|',
        '| `orders` | add total \\| drop old |',
        '',
        'Counter | Definition',
        '--- | ---',
        'Open | not shipped',
        '',
        '```ts',
        'const a = 1',
        '',
        '# not a heading',
        '```',
        '',
        'Setext title',
        '============',
        '',
        'Setext section',
        '--------------',
        '',
        '> Quoted rule',
        '> continues.',
        '',
        '---',
        '',
        'Closing #hashtag paragraph ##'
      ].join('\n')
    )

    expect(doc.format).toBe('markdown')
    expect(doc.title).toBe('Orders round 1')
    expect(doc.blocks).toEqual([
      { id: 1, type: 'heading', level: 1, anchor: null, text: 'Orders round 1' },
      { id: 2, type: 'paragraph', text: 'Intro line one continues here.' },
      { id: 3, type: 'heading', level: 2, anchor: 'a1', text: 'A1 · Totals' },
      { id: 4, type: 'list-item', text: 'First item wrapped onto a second line' },
      { id: 5, type: 'list-item', text: '  Nested item' },
      { id: 6, type: 'list-item', text: '    1. Deep ordered' },
      { id: 7, type: 'list-item', text: 'Back at the top' },
      { id: 8, type: 'list-item', text: 'Other marker' },
      { id: 9, type: 'list-item', text: '1. Step one' },
      { id: 10, type: 'list-item', text: '2) Step two' },
      { id: 11, type: 'table-row', text: 'Table | Change' },
      { id: 12, type: 'table-row', text: '`orders` | add total | drop old' },
      { id: 13, type: 'table-row', text: 'Counter | Definition' },
      { id: 14, type: 'table-row', text: 'Open | not shipped' },
      { id: 15, type: 'code', text: 'const a = 1\n\n# not a heading' },
      { id: 16, type: 'heading', level: 1, anchor: null, text: 'Setext title' },
      { id: 17, type: 'heading', level: 2, anchor: null, text: 'Setext section' },
      { id: 18, type: 'paragraph', text: 'Quoted rule continues.' },
      { id: 19, type: 'paragraph', text: 'Closing #hashtag paragraph ##' }
    ])
    expect(doc.text).toContain('[b3] ## A1 · Totals {#a1}\n\n[b4] - First item wrapped')
    expect(doc.text).toContain('[b5]   - Nested item\n[b6]     1. Deep ordered\n[b7] - Back')
    expect(doc.text).toContain('[b9] 1. Step one\n[b10] 2) Step two\n\n[b11] | Table | Change |')
  })

  it('strips closing hashes and leaves inline syntax alone', () => {
    const doc = markdown(
      '## Title with **bold** and [a link](https://x.test) ##\n\n####### seven hashes'
    )
    expect(doc.blocks).toEqual([
      {
        id: 1,
        type: 'heading',
        level: 2,
        anchor: null,
        text: 'Title with **bold** and [a link](https://x.test)'
      },
      { id: 2, type: 'paragraph', text: '####### seven hashes' }
    ])
    expect(doc.title).toBe('spec')
  })

  it('turns images into figures, embedded or referenced', () => {
    const doc = markdown(
      [
        '# Doc',
        '',
        `![Embedded shot](data:image/png;base64,${PNG_BASE64} "A title")`,
        '',
        'Text with ![inline icon](icons/lock.png) inside.',
        '',
        '![][image1] ![Named][Image1]',
        '',
        '![missing][nowhere]',
        '',
        '<img src="shots/a.png" alt="Html image"> and <IMG alt="Html embedded" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
        '',
        '[image1]: <data:image/jpeg;base64,/9j/4AAQSkZJRg==>',
        '[docs]: https://example.com/docs "Docs"'
      ].join('\n')
    )

    expect(doc.figures).toEqual([
      { id: 'fig-01', alt: 'Embedded shot', mime: 'image/png', base64: PNG_BASE64, src: null },
      { id: 'fig-02', alt: 'inline icon', mime: null, base64: null, src: 'icons/lock.png' },
      { id: 'fig-03', alt: '', mime: 'image/jpeg', base64: '/9j/4AAQSkZJRg==', src: null },
      { id: 'fig-04', alt: 'Named', mime: 'image/jpeg', base64: '/9j/4AAQSkZJRg==', src: null },
      { id: 'fig-05', alt: 'Html image', mime: null, base64: null, src: 'shots/a.png' },
      {
        id: 'fig-06',
        alt: 'Html embedded',
        mime: 'image/gif',
        base64: 'R0lGODlhAQABAAAAACw=',
        src: null
      }
    ])
    expect(doc.blocks.map((block) => [block.type, block.text])).toEqual([
      ['heading', 'Doc'],
      ['figure', '[fig-01 "Embedded shot"]'],
      ['paragraph', 'Text with [fig-02 "inline icon"] inside.'],
      ['figure', '[fig-03 ""]'],
      ['figure', '[fig-04 "Named"]'],
      ['paragraph', '![missing][nowhere]'],
      ['paragraph', '[fig-05 "Html image"] and [fig-06 "Html embedded"]'],
      ['paragraph', '[docs]: https://example.com/docs "Docs"']
    ])
    expect(doc.text).not.toContain('base64')
  })

  it('keeps a fenced block whole, whatever it contains', () => {
    const doc = markdown(
      [
        '- Item with code:',
        '',
        '  ~~~',
        '  ![not an image](x.png)',
        '  | not | a table |',
        '  ```',
        '  ~~~',
        '',
        '```',
        'never closed'
      ].join('\n')
    )
    expect(doc.blocks).toEqual([
      { id: 1, type: 'list-item', text: 'Item with code:' },
      { id: 2, type: 'code', text: '![not an image](x.png)\n| not | a table |\n```' },
      { id: 3, type: 'code', text: 'never closed' }
    ])
    expect(doc.figures).toEqual([])
    expect(renderBlocks(doc.blocks.slice(1, 2), { withIds: true })).toBe(
      '[b2] ````\n![not an image](x.png)\n| not | a table |\n```\n````'
    )
  })

  it('closes a fence opened inside a block quote', () => {
    const doc = markdown(
      [
        '# Spec',
        '',
        '## A1 · First',
        '',
        '> Example payload:',
        '> ```json',
        '> {"a": 1}',
        '> ```',
        '',
        '## A2 · Second',
        '',
        '> ```',
        '> unclosed quoted fence',
        '',
        'Body two.',
        '',
        '## A3 · Third',
        '> ```',
        '> still quoted',
        '## A4 · Fourth'
      ].join('\n')
    )
    expect(doc.blocks.map((block) => [block.type, block.text])).toEqual([
      ['heading', 'Spec'],
      ['heading', 'A1 · First'],
      ['paragraph', 'Example payload:'],
      ['code', '{"a": 1}'],
      ['heading', 'A2 · Second'],
      ['code', 'unclosed quoted fence'],
      ['paragraph', 'Body two.'],
      ['heading', 'A3 · Third'],
      ['code', 'still quoted'],
      ['heading', 'A4 · Fourth']
    ])
  })

  it('keeps the bold label paragraphs of every task written from a template', () => {
    const task = (n: number): string =>
      [
        `## A${n} · Task ${n}`,
        '',
        `Do thing ${n}.`,
        '',
        '**Backend changes:**',
        `- backend item ${n}`,
        '',
        '**Acceptance criteria:**',
        `- criterion ${n}`,
        '',
        'Requires a database migration.'
      ].join('\n')
    const doc = markdown(Array.from({ length: 5 }, (_value, index) => task(index + 1)).join('\n\n'))
    expect(texts(doc).filter((text) => text === '**Backend changes:**')).toHaveLength(5)
    expect(texts(doc).filter((text) => text === '**Acceptance criteria:**')).toHaveLength(5)
    expect(texts(doc).filter((text) => text === 'Requires a database migration.')).toHaveLength(5)
    expect(doc.blocks.slice(-7).map((block) => block.text)).toEqual([
      'A5 · Task 5',
      'Do thing 5.',
      '**Backend changes:**',
      'backend item 5',
      '**Acceptance criteria:**',
      'criterion 5',
      'Requires a database migration.'
    ])
  })

  it('keeps front matter out of the headings', () => {
    const doc = markdown('---\ntitle: Planned\nowner: me\n---\n\n# Real title\n\nBody')
    expect(doc.blocks.map((block) => [block.type, block.text])).toEqual([
      ['code', 'title: Planned\nowner: me'],
      ['heading', 'Real title'],
      ['paragraph', 'Body']
    ])
    expect(doc.title).toBe('Real title')
  })

  it('handles Windows line endings and a byte-order mark', () => {
    const doc = markdown(String.fromCharCode(0xfeff) + '# Title\r\n\r\n- one\r\n- two\r\n')
    expect(texts(doc)).toEqual(['Title', 'one', 'two'])
    expect(doc.title).toBe('Title')
  })

  it('reads a long embedded image line without choking', () => {
    const payload = 'QUJD'.repeat(200_000)
    const startedAt = performance.now()
    const doc = markdown(
      `# Big\n\n![shot](data:image/png;base64,${payload})\n\n![][ref]\n\n[ref]: data:image/png;base64,${payload}\n`
    )
    expect(performance.now() - startedAt).toBeLessThan(2000)
    expect(doc.figures.map((figure) => figure.base64?.length)).toEqual([800_000, 800_000])
    expect(doc.text).toBe('[b1] # Big\n\n[b2] [fig-01 "shot"]\n\n[b3] [fig-02 ""]')
  })
})

describe('preprocessDocument — plain text', () => {
  it('splits paragraphs on blank lines and keeps list lines apart', () => {
    const doc = preprocessDocument({
      fileName: '/tmp/Release notes.txt',
      content: [
        'First paragraph',
        'on two lines.',
        '',
        '',
        'Second paragraph with <b>markup</b> and # no heading.',
        '=====',
        '# Not a heading',
        '',
        '1. Do the first thing',
        '2. Do the second thing',
        '   - with a detail',
        '',
        '![not an image](x.png)'
      ].join('\n')
    })
    expect(doc.format).toBe('text')
    expect(doc.title).toBe('Release notes')
    expect(doc.figures).toEqual([])
    expect(doc.blocks).toEqual([
      { id: 1, type: 'paragraph', text: 'First paragraph on two lines.' },
      { id: 2, type: 'paragraph', text: 'Second paragraph with <b>markup</b> and # no heading.' },
      { id: 3, type: 'paragraph', text: '# Not a heading' },
      { id: 4, type: 'list-item', text: '1. Do the first thing' },
      { id: 5, type: 'list-item', text: '2. Do the second thing' },
      { id: 6, type: 'list-item', text: '  with a detail' },
      { id: 7, type: 'paragraph', text: '![not an image](x.png)' }
    ])
  })

  it('yields no blocks for an empty file', () => {
    const doc = preprocessDocument({ fileName: 'empty.txt', content: ' \n\n ' })
    expect(doc).toEqual({ title: 'empty', format: 'text', blocks: [], figures: [], text: '' })
  })
})

describe('detectDocumentFormat', () => {
  it.each([
    ['spec.html', 'html'],
    ['SPEC.HTM', 'html'],
    ['page.xhtml', 'html'],
    ['notes.md', 'markdown'],
    ['notes.Markdown', 'markdown'],
    ['page.mdx', 'markdown'],
    ['notes.txt', 'text'],
    ['notes.text', 'text'],
    ['/Users/me/My Docs/v1.2/spec.final.md', 'markdown']
  ] as const)('trusts the extension of %s', (fileName, format) => {
    expect(detectDocumentFormat(fileName, '<html><body># not sniffed</body></html>')).toBe(format)
  })

  it.each([
    ['a doctype', '<!DOCTYPE html>\n<title>x</title>', 'html'],
    ['an html element', '\n\n<HTML lang="en"><p>x</p>', 'html'],
    ['a body element', '<body>\ntext', 'html'],
    [
      'a fragment of several tags',
      '<div><h1>T</h1><p>a</p><p>b</p><ul><li>c</li></ul></div>',
      'html'
    ],
    ['markdown headings and lists', '# Title\n\n- one\n- two\n', 'markdown'],
    [
      'markdown with a little inline html',
      '# Title\n\nText<br>more **bold**\n\n- a\n- b <b>c</b>\n',
      'markdown'
    ],
    [
      'a fenced block and a link',
      'See [the docs](https://x.test).\n\n```\ncode\n```\n',
      'markdown'
    ],
    ['plain prose', 'Just some notes.\nNothing special here.\n', 'text'],
    ['prose with one dash list', 'Things:\n- one\n- two\n', 'text'],
    ['prose mentioning a tag', 'Use the <b> tag sparingly.', 'text'],
    ['an empty file', '', 'text']
  ] as const)('sniffs %s when the extension says nothing', (_name, content, format) => {
    expect(detectDocumentFormat('README', content)).toBe(format)
    expect(detectDocumentFormat('export.dat', content)).toBe(format)
    expect(detectDocumentFormat('.hidden', content)).toBe(format)
  })

  it('only sniffs the head of the file', () => {
    const late = `${'plain words '.repeat(1000)}\n<html><body></body></html>`
    expect(detectDocumentFormat('dump', late)).toBe('text')
  })
})

describe('renderBlocks', () => {
  const blocks: DocumentBlock[] = [
    { id: 1, type: 'heading', level: 2, anchor: 'top', text: 'Title' },
    { id: 2, type: 'paragraph', text: 'First paragraph.' },
    { id: 3, type: 'paragraph', text: 'Second paragraph.' },
    { id: 4, type: 'list-item', text: 'one' },
    { id: 5, type: 'list-item', text: '  two' },
    { id: 6, type: 'table-row', text: 'a | b' },
    { id: 7, type: 'table-row', text: 'c | d' },
    { id: 8, type: 'figure', text: '[fig-01 "shot"]' },
    { id: 9, type: 'code', text: 'x = 1' },
    { id: 10, type: 'heading', text: 'No level' }
  ]

  it('spaces blocks of different kinds and keeps lists and tables tight', () => {
    expect(renderBlocks(blocks)).toBe(
      [
        '## Title {#top}',
        '',
        'First paragraph.',
        '',
        'Second paragraph.',
        '',
        '- one',
        '  - two',
        '',
        '| a | b |',
        '| c | d |',
        '',
        '[fig-01 "shot"]',
        '',
        '```',
        'x = 1',
        '```',
        '',
        '# No level'
      ].join('\n')
    )
  })

  it('prefixes every block with its id', () => {
    const lines = renderBlocks(blocks, { withIds: true }).split('\n')
    expect(lines[0]).toBe('[b1] ## Title {#top}')
    expect(lines.filter((line) => /^\[b\d+\] /.test(line))).toHaveLength(blocks.length)
    expect(lines).toContain('[b5]   - two')
    expect(lines).toContain('[b9] ```')
  })

  it('renders nothing for no blocks', () => {
    expect(renderBlocks([])).toBe('')
    expect(renderBlocks([], { withIds: true })).toBe('')
  })
})
