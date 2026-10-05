// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTRACTION_JSON_SCHEMA, EXTRACTION_SYSTEM_PROMPT } from '@shared/document-flow/extraction'
import { DOCUMENT_TEXT_LIMIT, preprocessDocument } from '@shared/document-flow/preprocess'
import { DEFAULT_DOCUMENT_RUN_CONFIG } from '@shared/types/document-flow'
import { getRpcRequestContext, rpcRequestContext } from '../../../server/rpc/request-context'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { TEST_PROJECT_ID, createServiceHarness, seedRun, type ServiceHarness } from './test-support'

// A 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const SPEC = [
  '# Factory changes',
  '',
  'Apply every task on its own branch.',
  '',
  '## A1 · Chinese translation',
  '',
  'Translate the factory screens.',
  '',
  `![Translated screen](data:image/png;base64,${PNG_BASE64})`,
  '',
  '## A2 · Ramp-up rule',
  '',
  'Add the ramp-up rule after A1 is in.',
  ''
].join('\n')

/** A reply a model could give for SPEC: block ids are looked up, not guessed. */
function replyFor(content: string = SPEC): string {
  const { blocks } = preprocessDocument({ fileName: 'spec.md', content })
  const idOf = (text: string): number => {
    const block = blocks.find((candidate) => candidate.text.includes(text))
    if (!block) throw new Error(`no block contains "${text}"`)
    return block.id
  }
  const lastId = blocks[blocks.length - 1].id
  return JSON.stringify({
    documentTitle: 'Factory "changes" <round 2>',
    numbering: 'A1…A2',
    globalBlocks: [idOf('Apply every task')],
    openQuestions: ['Which Chinese locale?'],
    tickets: [
      {
        key: 'A1',
        title: 'Chinese translation',
        summary: 'Translate the factory screens.',
        kind: 'feature',
        blocks: [[idOf('A1 · Chinese translation'), idOf('A2 · Ramp-up rule') - 1]],
        relatedBlocks: [],
        dependsOn: [],
        docStatus: 'open',
        hasMigration: false,
        size: 'M',
        conflictRisk: 'high',
        openQuestions: []
      },
      {
        key: 'A2',
        title: 'Ramp-up rule',
        summary: 'Add the ramp-up rule.',
        kind: 'change',
        blocks: [[idOf('A2 · Ramp-up rule'), lastId]],
        relatedBlocks: [],
        dependsOn: ['A1'],
        docStatus: 'done',
        hasMigration: true,
        size: 'S',
        conflictRisk: 'low',
        openQuestions: []
      }
    ]
  })
}

/** A model that answers only when the test says so. */
function deferredModel(): {
  generate: () => Promise<string>
  /** Resolves once the service has asked. */
  asked: Promise<void>
  answer: (reply: string) => void
} {
  let resolveReply: (reply: string) => void = () => undefined
  let markAsked: () => void = () => undefined
  const asked = new Promise<void>((resolve) => (markAsked = resolve))
  return {
    generate: () =>
      new Promise<string>((resolve) => {
        resolveReply = resolve
        markAsked()
      }),
    asked,
    answer: (reply) => resolveReply(reply)
  }
}

/** A local web server that answers every request the same way. */
async function serve(
  answer: (response: ServerResponse) => void
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => answer(response))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

let harness: ServiceHarness
let specPath: string

beforeEach(() => {
  harness = createServiceHarness()
  mkdirSync(join(harness.scratch, 'specs'))
  specPath = join(harness.scratch, 'specs', 'Factory spec.md')
  writeFileSync(specPath, SPEC)
})

afterEach(() => {
  harness.cleanup()
})

async function extract(documentPath: string = specPath): Promise<string> {
  const detail = await harness.service.createRun({ projectId: TEST_PROJECT_ID, documentPath })
  await harness.service.whenExtractionSettled(detail.run.id)
  return detail.run.id
}

describe('createRun', () => {
  it('creates the run in `extracting` and returns before the model answers', async () => {
    const model = deferredModel()
    harness.overrides.generate = model.generate
    const { service, published, db } = harness
    const generation = { provider: 'codex' as const, model: 'gpt-5.4-mini', effort: 'low' }

    const detail = await service.createRun({
      projectId: TEST_PROJECT_ID,
      documentPath: specPath,
      generation
    })

    expect(detail.run).toMatchObject({
      project_id: TEST_PROJECT_ID,
      status: 'extracting',
      title: 'Factory spec.md',
      source_path: specPath,
      run_dir: join(harness.runsRoot, detail.run.id),
      document_path: null,
      error: null,
      config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, generation }
    })
    expect(detail.items).toEqual([])
    expect(detail.events.map((event) => event.type)).toEqual(['created'])
    expect(published).toEqual([
      { runId: detail.run.id, projectId: TEST_PROJECT_ID, reason: 'run' },
      { runId: detail.run.id, projectId: TEST_PROJECT_ID, reason: 'event' }
    ])
    expect(db.getDocumentRun(detail.run.id)?.status).toBe('extracting')

    await model.asked
    model.answer(replyFor())
    await service.whenExtractionSettled(detail.run.id)
    expect(db.getDocumentRun(detail.run.id)?.status).toBe('preview')
  })

  it('accepts a file:// URL and a path under ~', async () => {
    harness.replies.push(replyFor(), replyFor())

    const fromUrl = await harness.service.createRun({
      projectId: TEST_PROJECT_ID,
      documentPath: pathToFileURL(specPath).href
    })
    const fromHome = await harness.service.createRun({
      projectId: TEST_PROJECT_ID,
      documentPath: '~/specs/Factory spec.md'
    })

    expect(fromUrl.run.source_path).toBe(specPath)
    expect(fromHome.run.source_path).toBe(specPath)
    await harness.service.whenExtractionSettled(fromUrl.run.id)
    await harness.service.whenExtractionSettled(fromHome.run.id)
  })

  it('downloads a linked document into the project directory, then extracts from that file', async () => {
    const projectPath = harness.projects.get(TEST_PROJECT_ID)!.path
    mkdirSync(projectPath, { recursive: true })
    const site = await serve((response) => {
      response.writeHead(200, { 'content-type': 'text/markdown' })
      response.end(SPEC)
    })
    const link = `${site.origin}/specs/Factory%20spec.md`
    harness.replies.push(replyFor())

    try {
      const detail = await harness.service.createRun({
        projectId: TEST_PROJECT_ID,
        documentPath: `  ${link} `
      })

      const saved = join(projectPath, 'Factory spec.md')
      expect(detail.run).toMatchObject({
        status: 'extracting',
        title: 'Factory spec.md',
        source_path: saved
      })
      expect(readFileSync(saved, 'utf8')).toBe(SPEC)
      expect(detail.events.map((event) => event.message)).toEqual([
        `Document downloaded from ${link} to ${saved}`
      ])

      await harness.service.whenExtractionSettled(detail.run.id)
      const extracted = harness.service.get(detail.run.id)
      expect(extracted?.run.status).toBe('preview')
      expect(extracted?.items.map((item) => item.key)).toEqual(['A1', 'A2'])
    } finally {
      await site.close()
    }
  })

  it('refuses a link that cannot be downloaded and creates nothing', async () => {
    const site = await serve((response) => response.writeHead(410).end('gone'))

    try {
      await expect(
        harness.service.createRun({
          projectId: TEST_PROJECT_ID,
          documentPath: `${site.origin}/spec.html`
        })
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('the server answered 410')
      })
    } finally {
      await site.close()
    }

    expect(harness.db.runs.size).toBe(0)
    expect(harness.published).toEqual([])
  })

  it.each([
    ['a missing file', () => join(harness.scratch, 'specs', 'nope.md'), 'was not found'],
    ['a folder', () => join(harness.scratch, 'specs'), 'This is a folder, not a document'],
    ['a relative path', () => 'specs/Factory spec.md', 'Give the full path of the document'],
    ['an empty path', () => '   ', 'Choose a document first.']
  ])('refuses %s with a readable error and creates nothing', async (_name, path, message) => {
    await expect(
      harness.service.createRun({ projectId: TEST_PROJECT_ID, documentPath: path() })
    ).rejects.toMatchObject({ name: 'RpcRouteError', code: 'INVALID_INPUT' })
    await expect(
      harness.service.createRun({ projectId: TEST_PROJECT_ID, documentPath: path() })
    ).rejects.toThrow(message)

    expect(harness.db.runs.size).toBe(0)
    expect(harness.published).toEqual([])
    expect(harness.generateCalls).toEqual([])
  })

  it('refuses a connection project and an unknown project', async () => {
    harness.projects.set('connection-1', {
      id: 'connection-1',
      name: 'Both apps',
      path: join(harness.scratch, 'connection'),
      kind: 'connection'
    })

    await expect(
      harness.service.createRun({ projectId: 'connection-1', documentPath: specPath })
    ).rejects.toThrow('Documents cannot be implemented in a connection project yet.')
    await expect(
      harness.service.createRun({ projectId: 'unknown', documentPath: specPath })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'The project was not found.' })
    expect(harness.db.runs.size).toBe(0)
  })
})

describe('the extraction job', () => {
  it('stores the tickets, writes the run files and moves the run to preview', async () => {
    harness.replies.push(replyFor())

    const runId = await extract()

    const detail = harness.service.get(runId)
    const runDir = join(harness.runsRoot, runId)
    expect(detail?.run).toMatchObject({
      status: 'preview',
      // Quotes and angle brackets would break the launcher's <ticket title="…">.
      title: 'Factory changes round 2',
      document_path: join(runDir, 'document.md'),
      error: null,
      extraction: {
        numbering: 'A1…A2',
        openQuestions: ['Which Chinese locale?'],
        generatedBy: 'claude-code (default model)',
        figureCount: 1
      }
    })
    expect(detail?.run.extraction?.textLength).toBeGreaterThan(0)

    expect(detail?.items.map((item) => [item.key, item.title, item.position])).toEqual([
      ['A1', 'Chinese translation', 0],
      ['A2', 'Ramp-up rule', 1]
    ])
    const [a1, a2] = detail?.items ?? []
    expect(a1).toMatchObject({ status: 'pending', selected: true, kind: 'feature', depends_on: [] })
    // The document says A2 is done: extracted, but not selected.
    expect(a2).toMatchObject({
      selected: false,
      doc_status: 'done',
      has_migration: true,
      depends_on: ['A1']
    })
    expect(a1.description).toContain('Translate the factory screens.')
    expect(a1.description).toContain('Apply every task on its own branch.')
    expect(a1.description).toContain(join(runDir, 'document.md'))
    expect(a1.description).toContain(specPath)
    expect(a1.figures).toEqual([
      { id: 'fig-01', path: join(runDir, 'figures', 'fig-01.png'), label: 'Translated screen' }
    ])

    const text = readFileSync(join(runDir, 'document.md'), 'utf8')
    expect(text).toContain('[b1] # Factory changes')
    expect(text).not.toContain(PNG_BASE64)
    expect(readFileSync(a1.figures[0].path).toString('base64')).toBe(PNG_BASE64)
    expect(existsSync(join(runDir, 'blocks.json'))).toBe(true)

    expect(detail?.events.map((event) => event.type)).toEqual(['created', 'extracted'])
    expect(detail?.events.at(-1)?.message).toBe('2 tickets extracted')
  })

  it('asks the generation model with the extraction prompt, schema and time budget', async () => {
    harness.replies.push(replyFor())

    const detail = await harness.service.createRun({
      projectId: TEST_PROJECT_ID,
      documentPath: specPath,
      generation: { provider: 'codex', model: 'gpt-5.4-mini', effort: 'medium' }
    })
    await harness.service.whenExtractionSettled(detail.run.id)

    expect(harness.generateCalls).toHaveLength(1)
    const [call] = harness.generateCalls
    expect(call.systemPrompt).toBe(EXTRACTION_SYSTEM_PROMPT)
    expect(call.provider).toBe('codex')
    expect(call.options).toEqual({
      modelOverride: 'gpt-5.4-mini',
      effort: 'medium',
      outputSchema: EXTRACTION_JSON_SCHEMA,
      // A neutral directory: providers that can read files must not wander the project.
      cwd: tmpdir(),
      timeoutMs: 300_000,
      maxRetries: 1
    })
    expect(call.prompt).toContain('[b1] # Factory changes')
    expect(call.prompt).not.toContain(PNG_BASE64)
    expect(harness.db.getDocumentRun(detail.run.id)?.extraction?.generatedBy).toBe(
      'codex · gpt-5.4-mini'
    )
  })

  it('runs outside the request that started it', async () => {
    const contexts: unknown[] = []
    harness.overrides.detach = (task) => rpcRequestContext.exit(task)
    harness.overrides.generate = async () => {
      contexts.push(getRpcRequestContext())
      return replyFor()
    }

    const detail = await rpcRequestContext.run({ clientId: 'client-1', principal: null }, () =>
      harness.service.createRun({ projectId: TEST_PROJECT_ID, documentPath: specPath })
    )
    await harness.service.whenExtractionSettled(detail.run.id)

    expect(contexts).toEqual([undefined])
    expect(harness.db.getDocumentRun(detail.run.id)?.status).toBe('preview')
  })

  it('asks once more with a repair prompt when the reply cannot be used', async () => {
    harness.replies.push('Sure! Here are the tickets you asked for.', replyFor())

    const runId = await extract()

    expect(harness.generateCalls).toHaveLength(2)
    const repair = harness.generateCalls[1].prompt
    expect(repair).toContain('Your previous reply to this request could not be used.')
    expect(repair).toContain('Sure! Here are the tickets you asked for.')
    expect(repair).toContain('[b1] # Factory changes')

    const detail = harness.service.get(runId)
    expect(detail?.run.status).toBe('preview')
    expect(detail?.items).toHaveLength(2)
    expect(detail?.events.map((event) => event.type)).toEqual([
      'created',
      'extraction_retry',
      'extracted'
    ])
  })

  it('fails the run when the repaired reply is unusable too', async () => {
    harness.replies.push('no json here', '{"tickets": []}')

    const runId = await extract()

    const run = harness.service.get(runId)?.run
    expect(harness.generateCalls).toHaveLength(2)
    expect(run?.status).toBe('extract_failed')
    expect(run?.error).toMatch(/^The model did not return a usable ticket list\. /)
    expect(harness.db.getDocumentRunItems(runId)).toEqual([])
  })

  it.each([
    [
      'the model call fails',
      new Error('claude timed out after 300000ms'),
      'claude timed out after 300000ms'
    ],
    ['the model returns nothing', null, 'The model did not return a usable ticket list.']
  ])('fails the run with a readable error when %s', async (_name, reply, message) => {
    // The second answer is for the repair attempt of the empty reply.
    harness.replies.push(reply, null)

    const runId = await extract()

    const detail = harness.service.get(runId)
    expect(detail?.run.status).toBe('extract_failed')
    expect(detail?.run.error).toContain(message)
    expect(detail?.run.error).not.toMatch(/\n\s+at /)
    expect(detail?.events.at(-1)).toMatchObject({ type: 'extract_failed' })
    expect(harness.published.at(-1)).toEqual({
      runId,
      projectId: TEST_PROJECT_ID,
      reason: 'event'
    })
  })

  it('refuses a document whose text is over the limit, without calling the model', async () => {
    const paragraph = `${'word '.repeat(1000)}\n\n`
    const huge = `# Huge\n\n${paragraph.repeat(Math.ceil(DOCUMENT_TEXT_LIMIT / paragraph.length) + 1)}`
    const path = join(harness.scratch, 'specs', 'huge.md')
    writeFileSync(path, huge)

    const runId = await extract(path)

    const run = harness.service.get(runId)?.run
    expect(run?.status).toBe('extract_failed')
    expect(run?.error).toMatch(
      /^The document is too large to turn into tickets in one pass: [\d,]+ characters of text \(the limit is 400,000\)\./
    )
    expect(harness.generateCalls).toEqual([])
  })

  it.each([
    ['an empty document', '   \n', 'The document has no readable text.'],
    ['a binary file', '%PDF-1.7\u0000\u0001', 'This file is not text.']
  ])('refuses %s', async (_name, content, message) => {
    const path = join(harness.scratch, 'specs', 'odd.md')
    writeFileSync(path, content)

    const runId = await extract(path)

    expect(harness.service.get(runId)?.run).toMatchObject({ status: 'extract_failed' })
    expect(harness.service.get(runId)?.run.error).toContain(message)
    expect(harness.generateCalls).toEqual([])
  })

  it('fails when the document disappeared after it was picked', async () => {
    const { run } = seedRun(harness, {
      run: { status: 'extract_failed', source_path: join(harness.scratch, 'specs', 'gone.md') }
    })

    harness.service.retryExtraction({ runId: run.id })
    await harness.service.whenExtractionSettled(run.id)

    expect(harness.service.get(run.id)?.run.error).toContain('The document was not found')
  })

  it('discards the result when the run was cancelled while the model was working', async () => {
    const model = deferredModel()
    harness.overrides.generate = model.generate
    const detail = await harness.service.createRun({
      projectId: TEST_PROJECT_ID,
      documentPath: specPath
    })
    await model.asked

    harness.service.cancel(detail.run.id)
    model.answer(replyFor())
    await harness.service.whenExtractionSettled(detail.run.id)

    expect(harness.db.getDocumentRun(detail.run.id)?.status).toBe('cancelled')
    expect(harness.db.getDocumentRunItems(detail.run.id)).toEqual([])
  })
})

describe('deleting a run while its tickets are extracted', () => {
  it('discards the result and leaves no run directory behind', async () => {
    const model = deferredModel()
    harness.overrides.generate = model.generate
    const detail = await harness.service.createRun({
      projectId: TEST_PROJECT_ID,
      documentPath: specPath
    })
    await model.asked
    expect(existsSync(detail.run.run_dir)).toBe(true)

    await expect(harness.service.delete(detail.run.id)).resolves.toBe(true)
    model.answer(replyFor())
    await harness.service.whenExtractionSettled(detail.run.id)

    expect(harness.db.getDocumentRun(detail.run.id)).toBeNull()
    expect(harness.db.getDocumentRunItems(detail.run.id)).toEqual([])
    expect(existsSync(detail.run.run_dir)).toBe(false)
  })
})

describe('retryExtraction', () => {
  it('extracts again from a failed run and replaces the generation model when given', async () => {
    harness.replies.push(new Error('rate limited'))
    const runId = await extract()
    expect(harness.service.get(runId)?.run.status).toBe('extract_failed')

    harness.replies.push(replyFor())
    const generation = { provider: 'opencode' as const, model: 'anthropic/claude-haiku' }
    const detail = harness.service.retryExtraction({ runId, generation })

    expect(detail.run).toMatchObject({ status: 'extracting', error: null })
    expect(detail.run.config.generation).toEqual(generation)
    await harness.service.whenExtractionSettled(runId)
    expect(harness.service.get(runId)?.run).toMatchObject({ status: 'preview', error: null })
    expect(harness.generateCalls.at(-1)).toMatchObject({
      provider: 'opencode',
      options: { modelOverride: 'anthropic/claude-haiku' }
    })
  })

  it('replaces the previewed tickets and keeps the stored model when none is given', async () => {
    harness.replies.push(replyFor())
    const created = await harness.service.createRun({
      projectId: TEST_PROJECT_ID,
      documentPath: specPath,
      generation: { provider: 'codex' }
    })
    await harness.service.whenExtractionSettled(created.run.id)
    const before = harness.db.getDocumentRunItems(created.run.id).map((item) => item.id)

    harness.replies.push(replyFor())
    harness.service.retryExtraction({ runId: created.run.id })
    await harness.service.whenExtractionSettled(created.run.id)

    const after = harness.db.getDocumentRunItems(created.run.id)
    expect(after).toHaveLength(2)
    expect(after.map((item) => item.id)).not.toEqual(before)
    expect(harness.db.getDocumentRun(created.run.id)?.config.generation).toEqual({
      provider: 'codex'
    })

    // An explicit null goes back to the provider default.
    harness.replies.push(replyFor())
    harness.service.retryExtraction({ runId: created.run.id, generation: null })
    await harness.service.whenExtractionSettled(created.run.id)
    expect(harness.db.getDocumentRun(created.run.id)?.config.generation).toBeNull()
  })

  it('is refused while an extraction is running and after the run was launched', async () => {
    const model = deferredModel()
    harness.overrides.generate = model.generate
    const detail = await harness.service.createRun({
      projectId: TEST_PROJECT_ID,
      documentPath: specPath
    })
    expect(() => harness.service.retryExtraction({ runId: detail.run.id })).toThrow(
      'The tickets are already being extracted.'
    )
    await model.asked
    model.answer(replyFor())
    await harness.service.whenExtractionSettled(detail.run.id)

    const { run } = seedRun(harness, { run: { status: 'running' } })
    expect(() => harness.service.retryExtraction({ runId: run.id })).toThrow(
      'Tickets can only be extracted again before the run is launched.'
    )
    expect(() => harness.service.retryExtraction({ runId: 'missing' })).toThrow(
      'The run was not found.'
    )
  })
})

describe('an extraction interrupted by a server restart', () => {
  const longAgo = new Date(Date.now() - 60_000).toISOString()

  it('is reported as failed when the run is read', () => {
    const { run } = seedRun(harness, { run: { status: 'extracting' } })
    harness.db.runs.get(run.id)!.updated_at = longAgo

    const detail = harness.service.get(run.id)

    expect(detail?.run).toMatchObject({
      status: 'extract_failed',
      error: 'Extraction was interrupted. Try again.'
    })
    expect(detail?.events.at(-1)).toMatchObject({ type: 'extract_failed' })
    expect(harness.published.map((event) => event.reason)).toEqual(['run', 'event'])
  })

  it('is reported as failed when the runs are listed', () => {
    const { run } = seedRun(harness, { run: { status: 'extracting' } })
    harness.db.runs.get(run.id)!.updated_at = longAgo

    expect(harness.service.list(TEST_PROJECT_ID)[0].run.status).toBe('extract_failed')
  })

  it('leaves a run alone that was written to moments ago', () => {
    const { run } = seedRun(harness, { run: { status: 'extracting' } })

    expect(harness.service.get(run.id)?.run.status).toBe('extracting')
    expect(harness.published).toEqual([])
  })

  it('leaves a run alone whose job is still running in this process', async () => {
    const model = deferredModel()
    harness.overrides.generate = model.generate
    const detail = await harness.service.createRun({
      projectId: TEST_PROJECT_ID,
      documentPath: specPath
    })
    harness.db.runs.get(detail.run.id)!.updated_at = longAgo

    expect(harness.service.get(detail.run.id)?.run.status).toBe('extracting')

    await model.asked
    model.answer(replyFor())
    await harness.service.whenExtractionSettled(detail.run.id)
    expect(harness.service.get(detail.run.id)?.run.status).toBe('preview')
  })
})
