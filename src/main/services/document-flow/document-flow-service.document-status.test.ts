// @vitest-environment node
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRunItemDraft } from '@shared/types/document-flow'
import type { DocumentRunItemRowPatch } from './db-port'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { createServiceHarness, seedRun, type ServiceHarness } from './test-support'

// The end of a run, for the document it was made from: the run status summary written at its
// top when the run finishes, and the document edit lane closed when it finishes or is cancelled.

let harness: ServiceHarness

beforeEach(() => {
  harness = createServiceHarness()
})

afterEach(() => {
  harness.cleanup()
})

const START = '<!-- hive-run-status:start -->'
const END = '<!-- hive-run-status:end -->'

/** A source document in the scratch directory, with these bytes. */
function writeSource(name: string, content: string | Buffer): string {
  const path = join(harness.scratch, 'docs', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** A launched run made from `sourcePath`. */
function seedLaunched(
  sourcePath: string,
  items: (Partial<DocumentRunItemDraft> & DocumentRunItemRowPatch)[] = [
    { key: 'A1', title: 'Checkout flow', status: 'merged', document_update_status: 'done' }
  ]
): string {
  const { run } = seedRun(harness, {
    run: { status: 'running', source_path: sourcePath, integration_branch: 'doc-factory' },
    items
  })
  return run.id
}

const eventsOf = (runId: string, type: string): string[] =>
  harness.db.events
    .filter((event) => event.run_id === runId && event.type === type)
    .map((event) => event.message)

const itemOf = (runId: string, key: string) =>
  harness.db.getDocumentRunItems(runId).find((item) => item.key === key)!

describe('the run status summary written by finalize', () => {
  it('writes the block under the title of a Markdown document', async () => {
    const path = writeSource('spec.md', '# Factory spec\n\n## A1 Checkout flow\n\nText.\n')
    const runId = seedLaunched(path)

    const detail = await harness.service.finalize(runId)

    expect(detail.run.status).toBe('completed')
    const text = readFileSync(path, 'utf8')
    expect(text.startsWith(`# Factory spec\n\n${START}\n## Implementation status\n`)).toBe(true)
    expect(text).toContain('| **A1** · Checkout flow | ✅ Done | — | — | Updated |')
    expect(text.endsWith(`${END}\n\n## A1 Checkout flow\n\nText.\n`)).toBe(true)
    expect(eventsOf(runId, 'document_summary_written')).toEqual([
      'Wrote the run status into spec.md'
    ])
    expect(detail.events.map((event) => event.type)).toContain('document_summary_written')
    // Nothing is left behind next to the document.
    expect(readdirSync(dirname(path))).toEqual(['spec.md'])
  })

  it('replaces the block of an earlier finalize instead of adding another', async () => {
    const path = writeSource('spec.md', '# Factory spec\n\nText.\n')
    const runId = seedLaunched(path)
    await harness.service.finalize(runId)
    harness.db.updateDocumentRun(runId, { status: 'running' })

    await harness.service.finalize(runId)

    const text = readFileSync(path, 'utf8')
    expect(text.split(START)).toHaveLength(2)
    expect(text.split(END)).toHaveLength(2)
    expect(text.endsWith(`${END}\n\nText.\n`)).toBe(true)
  })

  it('covers every selected task, the unmerged ones too, in document order', async () => {
    const path = writeSource('spec.md', 'Intro.\n')
    const runId = seedLaunched(path, [
      { key: 'A1', status: 'merged', document_update_status: 'done' },
      { key: 'A2', status: 'needs_attention' },
      { key: 'A3', status: 'merged', selected: false },
      { key: 'A4', status: 'skipped', status_detail: 'Skipped by you.' }
    ])

    await harness.service.finalize(runId)

    const rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('| **'))
      .map((line) => line.split(' | ')[0])
    expect(rows).toEqual(['| **A1** · Task 1', '| **A2** · Task 2', '| **A4** · Task 4'])
  })

  it('keeps the BOM of a UTF-8 document', async () => {
    const path = writeSource('spec.md', Buffer.from('﻿# Spec\n\nCafé.\n', 'utf8'))
    const runId = seedLaunched(path)

    await harness.service.finalize(runId)

    const bytes = readFileSync(path)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = bytes.subarray(3).toString('utf8')
    expect(text.startsWith(`# Spec\n\n${START}`)).toBe(true)
    expect(text.endsWith('Café.\n')).toBe(true)
  })

  it('writes an HTML document right after <body>', async () => {
    const path = writeSource(
      'spec.html',
      '<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head>\n<body>\n<h1>Spec</h1>\n</body></html>\n'
    )
    const runId = seedLaunched(path)

    await harness.service.finalize(runId)

    const text = readFileSync(path, 'utf8')
    expect(text).toContain(`<body>\n${START}\n<section`)
    expect(text).toContain(`</section>\n${END}\n<h1>Spec</h1>`)
  })

  it('leaves a document in another encoding alone, and says so', async () => {
    const bytes = Buffer.from('# Spec\n\nCaf\xe9 cr\xe8me.\n', 'latin1')
    const path = writeSource('spec.md', bytes)
    const runId = seedLaunched(path)

    const detail = await harness.service.finalize(runId)

    expect(detail.run.status).toBe('completed')
    expect(readFileSync(path).equals(bytes)).toBe(true)
    expect(eventsOf(runId, 'document_summary_skipped')).toEqual([
      'The run status was not written into spec.md: it is encoded as windows-1252, and only UTF-8 documents are rewritten.'
    ])
    expect(eventsOf(runId, 'document_summary_written')).toEqual([])
  })

  it('finishes the run when the document is gone', async () => {
    const path = join(harness.scratch, 'docs', 'gone.md')
    const runId = seedLaunched(path)

    const detail = await harness.service.finalize(runId)

    expect(detail.run.status).toBe('completed')
    expect(eventsOf(runId, 'document_summary_failed')).toEqual([
      `The run status could not be written into gone.md: the document is no longer at ${path}.`
    ])
  })

  it('finishes the run when the document cannot be written', async () => {
    const path = writeSource('spec.md', '# Spec\n')
    const runId = seedLaunched(path)
    chmodSync(dirname(path), 0o555)
    try {
      const detail = await harness.service.finalize(runId)

      expect(detail.run.status).toBe('completed')
      expect(eventsOf(runId, 'document_summary_failed')).toHaveLength(1)
      expect(readFileSync(path, 'utf8')).toBe('# Spec\n')
    } finally {
      chmodSync(dirname(path), 0o755)
    }
  })

  it('leaves a read-only document alone in a writable directory, and says so', async () => {
    const path = writeSource('spec.md', '# Spec\n')
    chmodSync(path, 0o444)
    const runId = seedLaunched(path)

    const detail = await harness.service.finalize(runId)

    expect(detail.run.status).toBe('completed')
    expect(readFileSync(path, 'utf8')).toBe('# Spec\n')
    expect(statSync(path).mode & 0o777).toBe(0o444)
    expect(eventsOf(runId, 'document_summary_skipped')).toEqual([
      'The run status was not written into spec.md: the document is read-only.'
    ])
  })

  it('keeps the permissions of the document, and a symlink stays a link', async () => {
    const target = writeSource('spec.md', '# Spec\n')
    chmodSync(target, 0o640)
    const link = join(harness.scratch, 'docs', 'link.md')
    symlinkSync(target, link)
    const runId = seedLaunched(link)

    await harness.service.finalize(runId)

    expect(readFileSync(target, 'utf8')).toContain(START)
    expect(statSync(target).mode & 0o777).toBe(0o640)
    expect(readdirSync(dirname(target)).sort()).toEqual(['link.md', 'spec.md'])
  })
})

describe('closing the document edit lane', () => {
  const pendingItems = (): (Partial<DocumentRunItemDraft> & DocumentRunItemRowPatch)[] => [
    { key: 'A1', status: 'merged', document_update_status: 'done' },
    { key: 'A2', status: 'merged', session_id: 's-2', document_update_status: 'updating' },
    { key: 'A3', status: 'skipped', session_id: 's-3', document_update_status: 'queued' },
    { key: 'A4', status: 'running' }
  ]

  it('skips the document updates left when the run is finished, before the summary', async () => {
    const path = writeSource('spec.md', 'Intro.\n')
    const runId = seedLaunched(path, pendingItems())

    await harness.service.finalize(runId)

    const detail = 'The run finished before this task updated the document.'
    for (const key of ['A2', 'A3']) {
      expect(itemOf(runId, key)).toMatchObject({
        document_update_status: 'skipped',
        document_update_detail: detail,
        document_update_finished_at: expect.any(String)
      })
    }
    expect(itemOf(runId, 'A1').document_update_status).toBe('done')
    expect(itemOf(runId, 'A4').document_update_status).toBeNull()
    expect(eventsOf(runId, 'document_update_skipped')).toEqual([
      `A2 did not update the document: ${detail}`,
      `A3 did not update the document: ${detail}`
    ])
    expect(readFileSync(path, 'utf8')).toContain(`| Not updated: ${detail} |`)
  })

  it('skips them with the cancelled wording when the run is cancelled, and writes nothing', () => {
    const path = writeSource('spec.md', 'Intro.\n')
    const runId = seedLaunched(path, pendingItems())

    harness.service.cancel(runId)

    const detail = 'The run was cancelled before this task updated the document.'
    for (const key of ['A2', 'A3']) {
      expect(itemOf(runId, key)).toMatchObject({
        status: key === 'A2' ? 'merged' : 'skipped',
        document_update_status: 'skipped',
        document_update_detail: detail
      })
    }
    expect(itemOf(runId, 'A4').status).toBe('cancelled')
    expect(readFileSync(path, 'utf8')).toBe('Intro.\n')
    expect(eventsOf(runId, 'document_summary_written')).toEqual([])
  })
})
