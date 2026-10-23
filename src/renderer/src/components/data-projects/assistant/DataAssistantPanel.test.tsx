// The assistant panel end to end against the real store (RPC mocked): empty state with example
// prompts, the model in the header, Enter / Shift+Enter in the composer, the running state with
// tool chips and Stop / Escape, a proposal card with its READ/WRITE badge and Insert / Open in
// new tab / Copy, and the error chip with Retry.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DataAssistantEvent,
  DataAssistantEventPayload,
  DataProject
} from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  start: vi.fn(async (req: { requestId: string }) => ({ requestId: req.requestId })),
  cancel: vi.fn(async () => ({ cancelled: true })),
  listener: null as ((payload: DataAssistantEventPayload) => void) | null,
  editorText: '',
  copy: vi.fn(async () => true)
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    assistant: {
      start: mocks.start,
      cancel: mocks.cancel,
      onEvent: (listener: (payload: DataAssistantEventPayload) => void) => {
        mocks.listener = listener
        return () => {
          mocks.listener = null
        }
      }
    }
  }
}))

vi.mock('./assistant-context', () => ({
  readAssistantContext: () => ({ database: 'shop', editorText: mocks.editorText }),
  useAssistantActiveDatabase: () => 'shop'
}))

vi.mock('@/lib/data-projects/assistant-generation', () => ({
  resolveDataAssistantGeneration: () => ({
    provider: 'claude-code',
    model: 'opus',
    effort: 'medium'
  }),
  describeAssistantGeneration: (g: { provider: string; model?: string; effort?: string } | null) =>
    g ? ['Claude Code', g.model, g.effort].filter(Boolean).join(' · ') : 'No AI provider available',
  assistantProviderLabel: (p: string) => p,
  defaultAssistantModel: () => ({
    agentSdk: 'claude-code',
    providerID: 'anthropic',
    modelID: 'opus'
  })
}))

vi.mock('@/components/sessions/ModelSelector', () => ({
  ModelSelector: () => <button data-testid="model-selector-stub">model</button>
}))

vi.mock('@/components/sessions/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>
}))

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }))

// Highlighting and the READ/WRITE verdict have their own tests (query-insight.test.ts).
vi.mock('./query-insight', () => ({
  QUERY_TOKEN_CLASS: { plain: '' },
  tokenizeQuery: (text: string) => [{ kind: 'plain', text }],
  classifyQuery: (text: string, _language: string, _dialect: string | null, claimed: boolean) => ({
    kind: claimed || /^\s*DELETE/i.test(text) ? 'write' : 'read',
    classes: [/^\s*DELETE/i.test(text) ? 'write' : 'read'],
    dangerous: []
  })
}))

const { useDataAssistantStore } = await import('@/stores/useDataAssistantStore')
const { useDataEditorBridge } = await import('@/components/data-projects/editor-bridge')
const { DataAssistantPanel } = await import('./DataAssistantPanel')

const project: DataProject = {
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
  lastAccessedAt: '2026-10-01T00:00:00.000Z'
}

let seq = 0
function serverEvent(event: DataAssistantEvent): void {
  const requestId = useDataAssistantStore.getState().conversations['dp-1']?.requestId ?? 'none'
  seq += 1
  act(() => mocks.listener?.({ requestId, dataProjectId: 'dp-1', seq, event }))
}

beforeEach(() => {
  seq = 0
  mocks.editorText = ''
  useDataAssistantStore.getState().reset()
  useDataEditorBridge.setState({ pending: null })
})

afterEach(() => {
  // Unmount first: resetting the store under mounted components would update them outside act().
  cleanup()
  vi.clearAllMocks()
  useDataAssistantStore.getState().reset()
})

describe('DataAssistantPanel', () => {
  it('shows the model, example prompts and the data-access note when empty', async () => {
    const onClose = vi.fn()
    render(<DataAssistantPanel project={project} onClose={onClose} />)
    expect(screen.getByTestId('data-assistant-status-line')).toHaveTextContent(
      'Claude Code · opus · medium'
    )
    expect(screen.getByTestId('data-assistant-data-access')).toHaveTextContent('Schema only')
    expect(screen.getByTestId('data-assistant-database')).toHaveTextContent('shop')

    await userEvent.click(screen.getByTestId('data-assistant-example-0'))
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Orders created since yesterday, newest first',
        database: 'shop'
      })
    )
    await userEvent.click(screen.getByTestId('data-assistant-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('sends on Enter, keeps Shift+Enter as a newline', async () => {
    render(<DataAssistantPanel project={project} onClose={vi.fn()} />)
    const composer = screen.getByTestId('data-assistant-composer')
    await userEvent.type(composer, 'orders{Shift>}{Enter}{/Shift}since yesterday')
    expect(mocks.start).not.toHaveBeenCalled()
    expect(composer).toHaveValue('orders\nsince yesterday')
    await userEvent.type(composer, '{Enter}')
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'orders\nsince yesterday' })
    )
    expect(composer).toHaveValue('')
    expect(screen.getByTestId('data-assistant-message-user')).toHaveTextContent(
      'orders since yesterday'
    )
  })

  it('shows the run in flight and stops it with Escape', async () => {
    render(<DataAssistantPanel project={project} onClose={vi.fn()} />)
    await act(() => useDataAssistantStore.getState().ask(project, 'orders'))
    serverEvent({ type: 'status', text: 'Reading the schema…' })
    serverEvent({
      type: 'tool_start',
      callId: 'c1',
      name: 'describe_table',
      args: { table: 'orders' }
    })
    expect(screen.getByTestId('data-assistant-tool-chip')).toHaveTextContent(
      'describe_table(orders)'
    )
    expect(screen.getByTestId('data-assistant-thinking')).toHaveTextContent(
      'describe_table(orders)'
    )
    expect(screen.getByTestId('data-assistant-stop')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('data-assistant-composer'), { key: 'Escape' })
    expect(mocks.cancel).toHaveBeenCalled()
    await act(async () => {})
    serverEvent({ type: 'done', provider: 'claude-code' })
    expect(screen.getByTestId('data-assistant-message-system')).toHaveTextContent('Stopped.')
    expect(screen.getByTestId('data-assistant-send')).toBeInTheDocument()
  })

  it('renders a proposal card with the classifier badge and its actions', async () => {
    render(<DataAssistantPanel project={project} onClose={vi.fn()} />)
    await act(() => useDataAssistantStore.getState().ask(project, 'delete order 1'))
    serverEvent({ type: 'tool_start', callId: 'c1', name: 'list_tables', args: {} })
    serverEvent({ type: 'tool_end', callId: 'c1', ok: true, summary: '4 tables', ms: 5 })
    // The model claims a read; the classifier knows better.
    serverEvent({
      type: 'proposal',
      proposal: {
        language: 'sql',
        query: 'DELETE FROM orders WHERE id = 1',
        explanation: 'Deletes order 1.',
        isWrite: false
      }
    })
    serverEvent({ type: 'done', provider: 'claude-code', model: 'opus' })

    const card = screen.getByTestId('data-assistant-proposal')
    expect(within(card).getByTestId('data-assistant-proposal-badge')).toHaveTextContent('Write')
    expect(within(card).getByTestId('data-assistant-proposal-query')).toHaveTextContent(
      'DELETE FROM orders WHERE id = 1'
    )
    expect(card).toHaveTextContent('Placed in the editor · not run')
    expect(card).toHaveTextContent('Deletes order 1.')
    expect(screen.getByTestId('data-assistant-tool-chip')).toHaveTextContent(
      'list_tables · 4 tables'
    )
    expect(useDataEditorBridge.getState().pending).toMatchObject({
      mode: 'replace',
      origin: 'assistant'
    })

    useDataEditorBridge.setState({ pending: null })
    await userEvent.click(within(card).getByTestId('data-assistant-proposal-new-tab'))
    expect(useDataEditorBridge.getState().pending).toMatchObject({
      text: 'DELETE FROM orders WHERE id = 1',
      mode: 'new-tab'
    })
    await userEvent.click(within(card).getByTestId('data-assistant-proposal-insert'))
    expect(useDataEditorBridge.getState().pending).toMatchObject({ mode: 'replace' })
    await userEvent.click(within(card).getByTestId('data-assistant-proposal-copy'))
    expect(mocks.copy).toHaveBeenCalledWith('DELETE FROM orders WHERE id = 1')
    expect(within(card).getByTestId('data-assistant-proposal-copy')).toHaveTextContent('Copied')
  })

  it('shows a read badge for a plain SELECT', async () => {
    render(<DataAssistantPanel project={project} onClose={vi.fn()} />)
    await act(() => useDataAssistantStore.getState().ask(project, 'all orders'))
    serverEvent({
      type: 'proposal',
      proposal: { language: 'sql', query: 'SELECT * FROM orders', explanation: '', isWrite: false }
    })
    expect(screen.getByTestId('data-assistant-proposal-badge')).toHaveTextContent('Read')
  })

  it('shows an error chip whose Retry re-asks the question', async () => {
    render(<DataAssistantPanel project={project} onClose={vi.fn()} />)
    await act(() => useDataAssistantStore.getState().ask(project, 'orders'))
    serverEvent({ type: 'error', message: 'Claude rate limit reached.', retryable: true })
    expect(screen.getByTestId('data-assistant-error')).toHaveTextContent(
      'Claude rate limit reached.'
    )
    await userEvent.click(screen.getByTestId('data-assistant-error-retry'))
    expect(mocks.start).toHaveBeenCalledTimes(2)
  })

  it('shows a prose answer as an assistant message', async () => {
    render(<DataAssistantPanel project={project} onClose={vi.fn()} />)
    await act(() => useDataAssistantStore.getState().ask(project, 'shipped?'))
    serverEvent({ type: 'answer', text: 'Which status means shipped: "sent" or "delivered"?' })
    serverEvent({ type: 'done', provider: 'claude-code' })
    expect(screen.getByTestId('data-assistant-message-assistant')).toHaveTextContent(
      'Which status means shipped'
    )
  })
})
