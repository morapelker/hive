// The database assistant store: the event reducer (stale requests and repeated seqs ignored,
// tool trace, streamed text, proposal / answer / error / done), the ask → start flow with the
// workspace context and history, the one-time event subscription, the automatic insertion of a
// proposal into the editor (replace when the tab is empty, else a new tab), cancel and retry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DataAssistantEvent,
  DataAssistantEventPayload,
  DataProject
} from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  start: vi.fn(async (req: Record<string, unknown>) => ({ requestId: String(req.requestId) })),
  cancel: vi.fn(async () => ({ cancelled: true })),
  listener: null as ((payload: DataAssistantEventPayload) => void) | null,
  onEvent: vi.fn(),
  context: { database: 'shop', editorText: '' } as { database?: string; editorText?: string },
  generation: { provider: 'claude-code', model: 'opus', effort: 'medium' } as {
    provider: string
    model?: string
    effort?: string
  } | null
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    assistant: {
      start: mocks.start,
      cancel: mocks.cancel,
      onEvent: mocks.onEvent.mockImplementation(
        (listener: (p: DataAssistantEventPayload) => void) => {
          mocks.listener = listener
          return () => {
            mocks.listener = null
          }
        }
      )
    }
  }
}))

vi.mock('@/components/data-projects/assistant/assistant-context', () => ({
  readAssistantContext: vi.fn(() => mocks.context)
}))

vi.mock('@/lib/data-projects/assistant-generation', () => ({
  resolveDataAssistantGeneration: vi.fn(() => mocks.generation)
}))

const {
  useDataAssistantStore,
  reduceAssistantEvent,
  emptyConversation,
  buildAssistantHistory,
  toolLabel
} = await import('./useDataAssistantStore')
const { useDataEditorBridge } = await import('@/components/data-projects/editor-bridge')

const project = (overrides: Partial<DataProject> = {}): DataProject => ({
  id: 'dp-1',
  name: 'Shop PG',
  engine: 'postgres',
  config: { host: '127.0.0.1', database: 'shop' },
  icon: null,
  iconColor: null,
  environment: 'development',
  color: null,
  safeMode: 'off',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastAccessedAt: '2026-10-01T00:00:00.000Z',
  ...overrides
})

const conversation = () => useDataAssistantStore.getState().conversations['dp-1']

let seq = 0
function emit(event: DataAssistantEvent, requestId = conversation()?.requestId ?? 'none'): void {
  seq += 1
  mocks.listener?.({ requestId, dataProjectId: 'dp-1', seq, event })
}

beforeEach(() => {
  seq = 0
  mocks.context = { database: 'shop', editorText: '' }
  mocks.generation = { provider: 'claude-code', model: 'opus', effort: 'medium' }
  useDataAssistantStore.getState().reset()
  useDataEditorBridge.setState({ pending: null })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  useDataAssistantStore.getState().reset()
})

describe('reduceAssistantEvent', () => {
  const running = { ...emptyConversation(), status: 'running' as const, requestId: 'r1' }
  const payload = (
    seq: number,
    event: DataAssistantEvent,
    requestId = 'r1'
  ): DataAssistantEventPayload => ({
    requestId,
    dataProjectId: 'dp-1',
    seq,
    event
  })

  it('ignores events of another request and repeated seqs', () => {
    const other = reduceAssistantEvent(running, payload(1, { type: 'status', text: 'x' }, 'r0'))
    expect(other.conversation).toBe(running)
    const first = reduceAssistantEvent(running, payload(2, { type: 'status', text: 'Reading…' }))
    expect(first.conversation.activity).toBe('Reading…')
    const repeat = reduceAssistantEvent(
      first.conversation,
      payload(2, { type: 'status', text: 'again' })
    )
    expect(repeat.conversation).toBe(first.conversation)
  })

  it('builds the tool trace and drops thinking-aloud text when a tool starts', () => {
    let c = reduceAssistantEvent(
      running,
      payload(1, { type: 'text_delta', text: 'Let me look' })
    ).conversation
    expect(c.draft).toBe('Let me look')
    c = reduceAssistantEvent(
      c,
      payload(2, {
        type: 'tool_start',
        callId: 'c1',
        name: 'describe_table',
        args: { table: 'orders' }
      })
    ).conversation
    expect(c.draft).toBe('')
    expect(c.activity).toBe('describe_table(orders)')
    c = reduceAssistantEvent(
      c,
      payload(3, { type: 'tool_end', callId: 'c1', ok: true, summary: '5 columns', ms: 12 })
    ).conversation
    expect(c.tools).toEqual([
      {
        callId: 'c1',
        name: 'describe_table',
        label: 'describe_table(orders)',
        status: 'ok',
        summary: '5 columns',
        ms: 12
      }
    ])
  })

  it('turns a proposal into an assistant message and asks for insertion', () => {
    const { conversation: c, insertMessageId } = reduceAssistantEvent(
      running,
      payload(1, {
        type: 'proposal',
        proposal: { language: 'sql', query: 'SELECT 1', explanation: 'One.', isWrite: false }
      })
    )
    expect(insertMessageId).toBe(c.messages[0].id)
    expect(c.messages[0]).toMatchObject({
      role: 'assistant',
      text: 'One.',
      proposal: { query: 'SELECT 1', autoInserted: null }
    })
  })

  it('ends the run on error and on done, keeping streamed prose without an answer', () => {
    const errored = reduceAssistantEvent(
      running,
      payload(1, { type: 'error', message: 'boom', retryable: true })
    ).conversation
    expect(errored).toMatchObject({
      status: 'idle',
      requestId: null,
      error: { message: 'boom', retryable: true }
    })

    const withDraft = { ...running, draft: 'Which status?' }
    const done = reduceAssistantEvent(
      withDraft,
      payload(1, { type: 'done', provider: 'codex' })
    ).conversation
    expect(done.status).toBe('idle')
    expect(done.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Which status?' })
    expect(done.answeredBy).toEqual({ provider: 'codex' })

    const cancelled = reduceAssistantEvent(
      { ...running, status: 'cancelling' },
      payload(1, { type: 'done', provider: 'claude-code' })
    ).conversation
    expect(cancelled.messages.at(-1)).toMatchObject({ role: 'system', text: 'Stopped.' })
  })
})

describe('helpers', () => {
  it('labels tool chips by their main argument', () => {
    expect(toolLabel('describe_table', { table: 'orders' })).toBe('describe_table(orders)')
    expect(toolLabel('list_databases', {})).toBe('list_databases')
    expect(toolLabel('propose_query', { is_write: false })).toBe('propose_query')
  })

  it('sends earlier proposals back as fenced queries', () => {
    const history = buildAssistantHistory([
      { id: 'u', role: 'user', text: 'orders?', createdAt: 0 },
      {
        id: 'a',
        role: 'assistant',
        text: 'All orders.',
        createdAt: 0,
        proposal: {
          language: 'sql',
          query: 'SELECT * FROM orders',
          explanation: 'All orders.',
          isWrite: false,
          autoInserted: null
        }
      },
      { id: 's', role: 'system', text: 'Stopped.', createdAt: 0 }
    ])
    expect(history).toEqual([
      { role: 'user', text: 'orders?' },
      { role: 'assistant', text: 'All orders.\n\n```sql\nSELECT * FROM orders\n```' }
    ])
  })
})

describe('useDataAssistantStore', () => {
  it('starts a request with the workspace context and subscribes once', async () => {
    mocks.context = { database: 'shop', editorText: 'SELECT 1' }
    await useDataAssistantStore.getState().ask(project(), '  orders since yesterday ')
    expect(mocks.onEvent).toHaveBeenCalledTimes(1)
    const request = mocks.start.mock.calls[0][0] as Record<string, unknown>
    expect(request).toMatchObject({
      dataProjectId: 'dp-1',
      question: 'orders since yesterday',
      database: 'shop',
      editorText: 'SELECT 1',
      history: [],
      generation: { provider: 'claude-code', model: 'opus', effort: 'medium' }
    })
    expect(conversation()).toMatchObject({
      status: 'running',
      requestId: request.requestId,
      runDatabase: 'shop',
      lastQuestion: 'orders since yesterday'
    })
    expect(conversation().messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'orders since yesterday' })
    ])

    emit({ type: 'done', provider: 'claude-code' })
    await useDataAssistantStore.getState().ask(project(), 'second')
    expect(mocks.onEvent).toHaveBeenCalledTimes(1)
    expect((mocks.start.mock.calls[1][0] as { history: unknown[] }).history).toEqual([
      { role: 'user', text: 'orders since yesterday' }
    ])
  })

  it('auto-inserts a proposal: replacing an empty tab, or in a new tab', async () => {
    await useDataAssistantStore.getState().ask(project(), 'orders since yesterday')
    emit({ type: 'tool_start', callId: 'c1', name: 'list_tables', args: {} })
    emit({ type: 'tool_end', callId: 'c1', ok: true, summary: '4 tables', ms: 3 })
    emit({
      type: 'proposal',
      proposal: { language: 'sql', query: 'SELECT * FROM orders', explanation: 'x', isWrite: false }
    })
    expect(useDataEditorBridge.getState().pending).toMatchObject({
      dataProjectId: 'dp-1',
      text: 'SELECT * FROM orders',
      mode: 'replace',
      database: 'shop',
      title: 'AI: orders since yesterday',
      origin: 'assistant'
    })
    expect(conversation().messages.at(-1)?.proposal?.autoInserted).toBe('replace')
    expect(conversation().messages.at(-1)?.tools).toHaveLength(1)
    emit({ type: 'done', provider: 'claude-code', model: 'opus' })
    expect(conversation().status).toBe('idle')

    mocks.context = { database: 'shop', editorText: 'SELECT mine FROM t' }
    await useDataAssistantStore.getState().ask(project(), 'users')
    emit({
      type: 'proposal',
      proposal: {
        language: 'sql',
        query: 'SELECT * FROM users',
        explanation: '',
        isWrite: false,
        database: 'crm'
      }
    })
    expect(useDataEditorBridge.getState().pending).toMatchObject({
      text: 'SELECT * FROM users',
      mode: 'new-tab',
      database: 'crm'
    })
  })

  it('re-inserts a proposal on demand without running anything', async () => {
    await useDataAssistantStore.getState().ask(project(), 'q')
    emit({
      type: 'proposal',
      proposal: { language: 'sql', query: 'SELECT 2', explanation: '', isWrite: false }
    })
    const messageId = conversation().messages.at(-1)!.id
    useDataEditorBridge.setState({ pending: null })
    useDataAssistantStore.getState().insertProposal('dp-1', messageId, 'new-tab')
    expect(useDataEditorBridge.getState().pending).toMatchObject({
      text: 'SELECT 2',
      mode: 'new-tab'
    })
  })

  it('cancels: Stopping…, then Stopped. when the server confirms', async () => {
    await useDataAssistantStore.getState().ask(project(), 'q')
    const requestId = conversation().requestId!
    await useDataAssistantStore.getState().cancel('dp-1')
    expect(mocks.cancel).toHaveBeenCalledWith(requestId)
    expect(conversation().status).toBe('cancelling')
    emit({ type: 'status', text: 'Cancelled' }, requestId)
    emit({ type: 'done', provider: 'claude-code' }, requestId)
    expect(conversation()).toMatchObject({ status: 'idle', requestId: null })
    expect(conversation().messages.at(-1)).toMatchObject({ role: 'system', text: 'Stopped.' })
  })

  it('finishes a cancel locally when the server no longer knows the request', async () => {
    mocks.cancel.mockResolvedValueOnce({ cancelled: false })
    await useDataAssistantStore.getState().ask(project(), 'q')
    await useDataAssistantStore.getState().cancel('dp-1')
    expect(conversation()).toMatchObject({ status: 'idle', requestId: null })
  })

  it('shows a start failure as a retryable error and retries the same question', async () => {
    mocks.start.mockRejectedValueOnce(new Error('socket closed'))
    await useDataAssistantStore.getState().ask(project(), 'orders?')
    expect(conversation()).toMatchObject({
      status: 'idle',
      error: { message: 'socket closed', retryable: true }
    })
    await useDataAssistantStore.getState().retry(project())
    expect(mocks.start).toHaveBeenCalledTimes(2)
    expect((mocks.start.mock.calls[1][0] as { question: string }).question).toBe('orders?')
    // The question is not duplicated, and is not part of its own history.
    expect(conversation().messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect((mocks.start.mock.calls[1][0] as { history: unknown[] }).history).toEqual([])
  })

  it('explains when no AI provider is installed', async () => {
    mocks.generation = null
    await useDataAssistantStore.getState().ask(project(), 'q')
    expect(mocks.start).not.toHaveBeenCalled()
    expect(conversation().error?.message).toContain('No AI provider is installed')
  })

  it('gives up on a run that stops sending events', async () => {
    vi.useFakeTimers()
    await useDataAssistantStore.getState().ask(project(), 'q')
    vi.advanceTimersByTime(200_001)
    expect(conversation()).toMatchObject({
      status: 'idle',
      error: { message: 'The assistant stopped responding.', retryable: true }
    })
  })

  it('starts over with a new conversation, ignoring the old run', async () => {
    await useDataAssistantStore.getState().ask(project(), 'q')
    const requestId = conversation().requestId!
    useDataAssistantStore.getState().newConversation('dp-1')
    expect(mocks.cancel).toHaveBeenCalledWith(requestId)
    emit({ type: 'answer', text: 'late' }, requestId)
    expect(conversation().messages).toEqual([])
  })
})
