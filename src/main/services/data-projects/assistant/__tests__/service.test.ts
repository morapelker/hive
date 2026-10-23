// @vitest-environment node
// DataAssistantService with fake engine and runners: start returns at once and the run reports
// through seq-numbered events ending in exactly one terminal event; cancel, the whole-run
// timeout and a newer question all stop a run; the Claude runner falls back to the JSON loop
// only when it failed before any output; errors reach the user with a Retry flag.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DataAssistantEvent,
  DataAssistantEventPayload,
  DataAssistantStartRequest
} from '../../../../../shared/data-projects/types'
import { DataAssistantService, type DataAssistantServiceDeps } from '../service'
import { AssistantRunError, type AssistantRunInput, type AssistantRunner } from '../types'
import { fakeEngine, sampleRecord } from './fakes'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

const TERMINAL = new Set(['done', 'error'])

function harness(overrides: Partial<DataAssistantServiceDeps> = {}) {
  const payloads: DataAssistantEventPayload[] = []
  const waiters = new Map<string, (events: DataAssistantEvent[]) => void>()
  const eventsOf = (requestId: string): DataAssistantEvent[] =>
    payloads.filter((p) => p.requestId === requestId).map((p) => p.event)
  const engine = fakeEngine()
  const deps: DataAssistantServiceDeps = {
    publish: (payload) => {
      payloads.push(payload)
      if (TERMINAL.has(payload.event.type))
        waiters.get(payload.requestId)?.(eventsOf(payload.requestId))
    },
    getProject: vi.fn(async (id: string) =>
      id === 'dp-1' || id === 'dp-2' ? sampleRecord({ id }) : null
    ),
    getEngine: vi.fn(async () => engine),
    runClaude: vi.fn<AssistantRunner>(async () => ({
      answer: 'hi',
      emitted: true,
      provider: 'claude-code'
    })),
    runJsonLoop: vi.fn<AssistantRunner>(async (input) => ({
      answer: 'hi',
      emitted: true,
      provider: input.generation.provider
    })),
    now: () => new Date('2026-10-23T11:05:00.000Z'),
    timeZone: () => 'UTC',
    ...overrides
  }
  const service = new DataAssistantService(deps)
  const finished = (requestId: string): Promise<DataAssistantEvent[]> =>
    new Promise((resolve) => {
      const existing = eventsOf(requestId)
      if (existing.some((event) => TERMINAL.has(event.type))) resolve(existing)
      else waiters.set(requestId, resolve)
    })
  return { service, deps, engine, payloads, eventsOf, finished }
}

const request = (
  overrides: Partial<DataAssistantStartRequest> = {}
): DataAssistantStartRequest => ({
  requestId: 'req-1',
  dataProjectId: 'dp-1',
  question: 'orders since yesterday',
  history: [],
  generation: { provider: 'claude-code', model: 'opus', effort: 'medium' },
  ...overrides
})

/** A runner that waits until the run is aborted (then rethrows the abort reason). */
const blockingRunner: AssistantRunner = (input) =>
  new Promise((_resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
  })

const proposingRunner: AssistantRunner = async (input: AssistantRunInput) => {
  await input.toolbox.call('list_tables', { pattern: 'order' })
  await input.toolbox.call('propose_query', {
    query: "SELECT * FROM orders WHERE created_at >= now() - interval '1 day'",
    explanation: 'Rolling 24 hours.',
    is_write: false
  })
  return { answer: null, emitted: true, provider: 'claude-code', model: 'opus' }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DataAssistantService', () => {
  it('returns the requestId at once and streams seq-numbered events ending in done', async () => {
    const { service, finished, payloads, deps } = harness({ runClaude: vi.fn(proposingRunner) })
    await expect(service.start(request())).resolves.toEqual({ requestId: 'req-1' })
    const events = await finished('req-1')

    expect(events.map((e) => e.type)).toEqual([
      'status',
      'status',
      'tool_start',
      'tool_end',
      'tool_start',
      'tool_end',
      'proposal',
      'done'
    ])
    expect(events[0]).toEqual({ type: 'status', text: 'Reading the schema…' })
    expect(events[1]).toEqual({ type: 'status', text: 'Thinking…' })
    expect(events.at(-1)).toEqual({ type: 'done', provider: 'claude-code', model: 'opus' })
    expect(payloads.map((p) => p.seq)).toEqual(payloads.map((_, i) => i + 1))
    expect(payloads.every((p) => p.dataProjectId === 'dp-1' && p.requestId === 'req-1')).toBe(true)

    const input = vi.mocked(deps.runClaude).mock.calls[0][0]
    expect(input.systemPrompt).toContain('Engine: PostgreSQL 17.2')
    expect(input.systemPrompt).toContain('Current database: shop')
    expect(input.systemPrompt).toContain('Now: 2026-10-23T11:05:00+00:00 (UTC)')
    expect(input.systemPrompt).toContain(
      'orders(id int4, user_id int4, status text, created_at timestamptz)'
    )
    expect(input.userPrompt).toContain('orders since yesterday')
    expect(service.activeRuns).toBe(0)
  })

  it('masks credentials in the editor text and the conversation before the runner sees them', async () => {
    const { service, finished, deps } = harness()
    await service.start(
      request({
        question: "and with PASSWORD 'QuestionPw!'?",
        editorText: "CREATE USER app WITH PASSWORD 'EditorPw!'",
        history: [{ role: 'user', text: "ALTER USER app IDENTIFIED BY 'HistoryPw!'" }]
      })
    )
    await finished('req-1')
    const { userPrompt } = vi.mocked(deps.runClaude).mock.calls[0][0]
    for (const secret of ['QuestionPw!', 'EditorPw!', 'HistoryPw!'])
      expect(userPrompt).not.toContain(secret)
    expect(userPrompt).toContain("CREATE USER app WITH PASSWORD '***'")
  })

  it('connects first when the project is not connected', async () => {
    const { service, finished, engine } = harness()
    vi.mocked(engine.status).mockReturnValue({ dataProjectId: 'dp-1', state: 'disconnected' })
    await service.start(request())
    const events = await finished('req-1')
    expect(events[0]).toEqual({ type: 'status', text: 'Connecting to Shop PG…' })
    expect(engine.connect).toHaveBeenCalledWith('dp-1')
    expect(events.slice(-2)).toEqual([
      { type: 'answer', text: 'hi' },
      { type: 'done', provider: 'claude-code' }
    ])
  })

  it('explains a missing password instead of a raw error code', async () => {
    const { service, finished, engine } = harness()
    vi.mocked(engine.status).mockReturnValue({ dataProjectId: 'dp-1', state: 'disconnected' })
    vi.mocked(engine.connect).mockRejectedValue(
      Object.assign(new Error('password required'), { code: 'DATA_CREDENTIALS_REQUIRED' })
    )
    await service.start(request())
    const events = await finished('req-1')
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'This connection needs its password. Connect from the toolbar, then ask again.',
      retryable: true
    })
  })

  it('uses the JSON loop for Codex and OpenCode and ends with the prose answer', async () => {
    const { service, finished, deps } = harness()
    await service.start(request({ generation: { provider: 'codex' } }))
    const events = await finished('req-1')
    expect(deps.runClaude).not.toHaveBeenCalled()
    const input = vi.mocked(deps.runJsonLoop).mock.calls[0][0]
    expect(input.systemPrompt).toContain('## Reply format')
    expect(events.slice(-2)).toEqual([
      { type: 'answer', text: 'hi' },
      { type: 'done', provider: 'codex' }
    ])
  })

  it('keeps going without a schema overview when the snapshot fails', async () => {
    const { service, finished, engine, deps } = harness()
    vi.mocked(engine.completionSchema).mockRejectedValue(new Error('permission denied'))
    await service.start(request())
    await finished('req-1')
    expect(vi.mocked(deps.runClaude).mock.calls[0][0].systemPrompt).toContain(
      '(not available — use the tools)'
    )
  })

  it('cancels a running request: a status line, then done', async () => {
    const { service, finished } = harness({ runClaude: vi.fn(blockingRunner) })
    await service.start(request())
    await vi.waitFor(() => expect(service.activeRuns).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(service.cancel('req-1')).toEqual({ cancelled: true })
    const events = await finished('req-1')
    expect(events.slice(-2)).toEqual([
      { type: 'status', text: 'Cancelled' },
      { type: 'done', provider: 'claude-code', model: 'opus' }
    ])
    expect(service.cancel('req-1')).toEqual({ cancelled: false })
    expect(service.cancel('unknown')).toEqual({ cancelled: false })
  })

  it('stops a run that exceeds the whole-run timeout with a retryable error', async () => {
    const { service, finished } = harness({ runClaude: vi.fn(blockingRunner), runTimeoutMs: 30 })
    await service.start(request())
    const events = await finished('req-1')
    expect(events.at(-1)).toMatchObject({ type: 'error', retryable: true })
    expect((events.at(-1) as { message: string }).message).toContain('took longer than')
  })

  it('lets a newer question supersede the running one of the same project', async () => {
    const runClaude = vi.fn<AssistantRunner>().mockImplementationOnce(blockingRunner)
    runClaude.mockImplementation(async () => ({
      answer: 'second',
      emitted: true,
      provider: 'claude-code'
    }))
    const { service, finished } = harness({ runClaude })
    await service.start(request({ requestId: 'req-a' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await service.start(request({ requestId: 'req-b' }))
    const first = await finished('req-a')
    const second = await finished('req-b')
    expect(first.slice(-2)).toEqual([
      { type: 'status', text: 'Replaced by a newer question' },
      { type: 'done', provider: 'claude-code', model: 'opus' }
    ])
    expect(second.slice(-2)).toEqual([
      { type: 'answer', text: 'second' },
      { type: 'done', provider: 'claude-code' }
    ])
  })

  it('refuses unknown projects and duplicate request ids', async () => {
    const { service } = harness({ runClaude: vi.fn(blockingRunner) })
    await expect(service.start(request({ dataProjectId: 'missing' }))).rejects.toMatchObject({
      code: 'DATA_NOT_FOUND'
    })
    await service.start(request())
    await expect(service.start(request())).rejects.toMatchObject({ code: 'DATA_INVALID_INPUT' })
    service.shutdown()
  })

  it('falls back to the JSON loop when Claude fails before any output', async () => {
    const { service, finished, deps } = harness({
      runClaude: vi.fn<AssistantRunner>(async () => {
        throw new AssistantRunError('Claude Code failed: spawn ENOENT', { beforeOutput: true })
      }),
      fallbackProvider: async () => 'codex'
    })
    await service.start(request())
    const events = await finished('req-1')
    expect(events).toContainEqual({
      type: 'status',
      text: 'Claude Code failed (Claude Code failed: spawn ENOENT). Falling back to Codex…'
    })
    expect(vi.mocked(deps.runJsonLoop).mock.calls[0][0].generation).toEqual({ provider: 'codex' })
    expect(events.at(-1)).toEqual({ type: 'done', provider: 'codex' })
  })

  it('does not fall back once something reached the user', async () => {
    const { service, finished, deps } = harness({
      runClaude: vi.fn<AssistantRunner>(async (input) => {
        await input.toolbox.call('list_databases', {})
        throw new AssistantRunError('Claude rate limit reached.', { beforeOutput: false })
      }),
      fallbackProvider: async () => 'codex'
    })
    await service.start(request())
    const events = await finished('req-1')
    expect(deps.runJsonLoop).not.toHaveBeenCalled()
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Claude rate limit reached.',
      retryable: true
    })
  })

  it('reports a run that ends with neither a query nor an answer', async () => {
    const { service, finished } = harness({
      runClaude: vi.fn<AssistantRunner>(async () => ({
        answer: '  ',
        emitted: true,
        provider: 'claude-code'
      }))
    })
    await service.start(request())
    const events = await finished('req-1')
    expect(events.at(-1)).toMatchObject({ type: 'error', retryable: true })
  })

  it('treats a failure after the proposal as a finished run', async () => {
    const { service, finished } = harness({
      runClaude: vi.fn<AssistantRunner>(async (input) => {
        await proposingRunner(input)
        throw new Error('close failed')
      })
    })
    await service.start(request())
    const events = await finished('req-1')
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it("stops a disconnected renderer's runs and leaves the others running", async () => {
    const { service, finished, eventsOf } = harness({ runClaude: vi.fn(blockingRunner) })
    await service.start(request({ requestId: 'mine' }), 'renderer-1')
    await service.start(request({ requestId: 'other', dataProjectId: 'dp-2' }), 'renderer-2')
    await new Promise((resolve) => setTimeout(resolve, 5))
    service.releaseClient('renderer-2')
    const events = await finished('other')
    expect(events.slice(-2)).toEqual([
      { type: 'status', text: 'Cancelled' },
      { type: 'done', provider: 'claude-code', model: 'opus' }
    ])
    expect(eventsOf('mine').some((event) => event.type === 'done' || event.type === 'error')).toBe(
      false
    )
    expect(service.activeRuns).toBe(1)
    service.shutdown()
    await finished('mine')
  })

  it('stops every run on shutdown', async () => {
    const { service, finished } = harness({ runClaude: vi.fn(blockingRunner) })
    await service.start(request({ requestId: 'r1' }))
    await service.start(request({ requestId: 'r2', dataProjectId: 'dp-1' }))
    service.shutdown()
    await finished('r2')
    expect(service.activeRuns).toBe(0)
  })
})

describe('validateAssistantProposal (shared SQL toolkit and mongosh parser)', () => {
  it('accepts SQL, flags writes and reports lexer errors with their position', async () => {
    const { validateAssistantProposal } = await import('../service')
    const check = (query: string, language: 'sql' | 'mongo' = 'sql') =>
      validateAssistantProposal({
        language,
        dialect: language === 'sql' ? 'postgres' : null,
        engine: language === 'sql' ? 'postgres' : 'mongodb',
        query
      })
    await expect(check('SELECT status, count(*) FROM orders GROUP BY status')).resolves.toEqual({
      ok: true,
      isWrite: false
    })
    await expect(check('DELETE FROM orders WHERE id = 1')).resolves.toEqual({
      ok: true,
      isWrite: true
    })
    const broken = await check("SELECT 'unterminated FROM orders")
    expect(broken.ok).toBe(false)
    expect(broken.ok ? '' : broken.error).toMatch(/at character \d+/)

    await expect(
      check('db.orders.find({ status: "paid" }).sort({ createdAt: -1 })', 'mongo')
    ).resolves.toEqual({
      ok: true,
      isWrite: false
    })
    await expect(check('db.orders.deleteMany({ status: "cancelled" })', 'mongo')).resolves.toEqual({
      ok: true,
      isWrite: true
    })
    const badShell = await check('db.orders.find({ status: ', 'mongo')
    expect(badShell.ok).toBe(false)
  })
})
