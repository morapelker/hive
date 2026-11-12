// @vitest-environment node
// Cross-machine tickets (docs/multi-instance/CROSS-MACHINE-TICKETS.md §3.3): the receiver's
// rewrite of a moved run's sender paths — exact strings, longest first, whole paths only, through
// the shared `rewritePaths` so tickets and runs agree on what a boundary is — over
// the run columns, the items (the two spec-file description lines, figure paths) and
// `blocks.json`'s figure `src`; and the validation a received `blocks.json` goes through.
import { describe, expect, it } from 'vitest'
import type { PreprocessedDocument } from '@shared/document-flow/preprocess'
import {
  PreprocessedDocumentSchema,
  rewriteBlocksJson,
  rewritePathsInText,
  rewriteRunPaths
} from './run-paths'

const SENDER_RUN = '/Users/a/.hive/document-runs/run-1'
const SENDER_DOC = `${SENDER_RUN}/document.md`
const SENDER_SOURCE = '/Users/a/Documents/Spec v2.html'
const HERE_RUN = '/Users/b/.hive/document-runs/run-1'
const HERE_DOC = `${HERE_RUN}/document.md`
const HERE_SOURCE = `${HERE_RUN}/source/Spec v2.html`

const map = {
  [SENDER_RUN]: HERE_RUN,
  [SENDER_DOC]: HERE_DOC,
  [SENDER_SOURCE]: HERE_SOURCE
}

describe('rewritePathsInText', () => {
  it('replaces the longest matching path first, so a file inside the run dir keeps its name', () => {
    expect(rewritePathsInText(`- Full text: ${SENDER_DOC} (search for "A1")`, map)).toBe(
      `- Full text: ${HERE_DOC} (search for "A1")`
    )
    expect(rewritePathsInText(`${SENDER_RUN}/figures/fig-01.png`, map)).toBe(
      `${HERE_RUN}/figures/fig-01.png`
    )
  })

  it('never matches part of a longer name', () => {
    expect(rewritePathsInText(`${SENDER_RUN}2`, map)).toBe(`${SENDER_RUN}2`)
    expect(rewritePathsInText(`${SENDER_RUN}-copy`, map)).toBe(`${SENDER_RUN}-copy`)
    expect(rewritePathsInText(`${SENDER_RUN}.bak`, map)).toBe(`${SENDER_RUN}.bak`)
    expect(rewritePathsInText(`${SENDER_RUN}_old/x`, map)).toBe(`${SENDER_RUN}_old/x`)
  })

  it('never matches a path that sits inside a longer one, before or after', () => {
    const narrow = { '/Users/a/runs/r1': '/Users/b/runs/r9' }
    expect(rewritePathsInText('x/Users/a/runs/r1', narrow)).toBe('x/Users/a/runs/r1')
    expect(rewritePathsInText('/Volumes/bk/Users/a/runs/r1', narrow)).toBe(
      '/Volumes/bk/Users/a/runs/r1'
    )
    expect(rewritePathsInText('/Users/a/runs/r1%2Fx', narrow)).toBe('/Users/a/runs/r1%2Fx')
    expect(rewritePathsInText('see /Users/a/runs/r1 and file:///Users/a/runs/r1', narrow)).toBe(
      'see /Users/b/runs/r9 and file:///Users/b/runs/r9'
    )
  })

  it('matches a path that ends a sentence, is quoted or sits in parentheses', () => {
    expect(rewritePathsInText(`The document is at ${SENDER_SOURCE}.`, map)).toBe(
      `The document is at ${HERE_SOURCE}.`
    )
    expect(rewritePathsInText(`"${SENDER_RUN}" and (${SENDER_RUN}) and '${SENDER_RUN}'`, map)).toBe(
      `"${HERE_RUN}" and (${HERE_RUN}) and '${HERE_RUN}'`
    )
    expect(rewritePathsInText(SENDER_RUN, map)).toBe(HERE_RUN)
  })

  it('rewrites file: URLs of the same paths, raw and percent-encoded', () => {
    expect(rewritePathsInText(`see file://${SENDER_SOURCE} now`, map)).toBe(
      `see file://${HERE_SOURCE} now`
    )
    expect(rewritePathsInText('file:///Users/a/Documents/Spec%20v2.html', map)).toBe(
      'file:///Users/b/.hive/document-runs/run-1/source/Spec%20v2.html'
    )
  })

  it('treats a trailing separator on a key as the same path', () => {
    expect(rewritePathsInText(`${SENDER_RUN}/x`, { [`${SENDER_RUN}/`]: HERE_RUN })).toBe(
      `${HERE_RUN}/x`
    )
  })

  it('leaves text without a match untouched and ignores empty or identity mappings', () => {
    expect(rewritePathsInText('nothing here', map)).toBe('nothing here')
    expect(rewritePathsInText('/a/b', { '': '/x', '/a/b': '/a/b' })).toBe('/a/b')
    expect(rewritePathsInText('', map)).toBe('')
  })
})

describe('rewriteRunPaths', () => {
  it('rewrites the three run columns, the description lines, titles, questions and figure paths', () => {
    const description = [
      'Implement task A1 — Add the schema — from the spec document "Spec".',
      '',
      'Spec files (read-only):',
      `- Full text: ${SENDER_DOC} (search for "Add the schema")`,
      `- Original document: ${SENDER_SOURCE} (it may embed large base64 images; prefer the text version)`
    ].join('\n')
    const result = rewriteRunPaths(
      {
        run: {
          id: 'run-1',
          source_path: SENDER_SOURCE,
          run_dir: SENDER_RUN,
          document_path: SENDER_DOC
        },
        items: [
          {
            key: 'A1',
            title: `Add the schema (${SENDER_SOURCE})`,
            summary: `See ${SENDER_DOC}`,
            description,
            open_questions: [`Is ${SENDER_RUN} right?`],
            figures: [{ id: 'fig-01', path: `${SENDER_RUN}/figures/fig-01.png`, label: 'ERD' }],
            selected: true
          }
        ]
      },
      map
    )

    expect(result.run).toEqual({
      id: 'run-1',
      source_path: HERE_SOURCE,
      run_dir: HERE_RUN,
      document_path: HERE_DOC
    })
    const [item] = result.items
    expect(item.key).toBe('A1')
    expect(item.selected).toBe(true)
    expect(item.title).toBe(`Add the schema (${HERE_SOURCE})`)
    expect(item.summary).toBe(`See ${HERE_DOC}`)
    expect(item.description).toContain(`- Full text: ${HERE_DOC} (search for "Add the schema")`)
    expect(item.description).toContain(`- Original document: ${HERE_SOURCE} (it may embed`)
    expect(item.open_questions).toEqual([`Is ${HERE_RUN} right?`])
    expect(item.figures).toEqual([
      { id: 'fig-01', path: `${HERE_RUN}/figures/fig-01.png`, label: 'ERD' }
    ])
    expect(JSON.stringify(result)).not.toContain('/Users/a/')
  })

  it('keeps a null document_path', () => {
    const result = rewriteRunPaths(
      { run: { source_path: SENDER_SOURCE, run_dir: SENDER_RUN, document_path: null }, items: [] },
      map
    )
    expect(result.run.document_path).toBeNull()
  })
})

const doc: PreprocessedDocument = {
  title: 'Spec',
  format: 'html',
  blocks: [
    { id: 1, type: 'heading', level: 1, anchor: 'top', text: 'Spec' },
    { id: 2, type: 'figure', text: '[fig-01 "ERD"]' }
  ],
  figures: [
    { id: 'fig-01', alt: 'ERD', mime: null, base64: null, src: `${SENDER_SOURCE}/../erd.png` },
    { id: 'fig-02', alt: 'Inline', mime: 'image/png', base64: 'AAAA', src: null }
  ],
  text: '[b1] Spec\n[b2] [fig-01 "ERD"]'
}

describe('rewriteBlocksJson', () => {
  it('validates the document, rewrites figure sources and drops any payload left in it', () => {
    const result = rewriteBlocksJson(JSON.stringify(doc), map)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doc.figures[0].src).toBe(`${HERE_SOURCE}/../erd.png`)
    expect(result.doc.figures[1].base64).toBeNull()
    expect(result.doc.blocks).toEqual(doc.blocks)
    expect(JSON.parse(result.json)).toEqual(result.doc)
    expect(result.json).not.toContain('/Users/a/')
  })

  it('drops unknown keys instead of refusing a file from a newer app', () => {
    const result = rewriteBlocksJson(JSON.stringify({ ...doc, future: true }), map)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect('future' in result.doc).toBe(false)
  })

  it('reports invalid JSON and a foreign shape', () => {
    expect(rewriteBlocksJson('{not json', map)).toMatchObject({ ok: false })
    const foreign = rewriteBlocksJson(JSON.stringify({ title: 'x', blocks: 'nope' }), map)
    expect(foreign.ok).toBe(false)
    if (foreign.ok) return
    expect(foreign.error).toContain('unexpected shape')
    expect(PreprocessedDocumentSchema.safeParse({ ...doc, format: 'pdf' }).success).toBe(false)
  })
})
