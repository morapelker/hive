// @vitest-environment node
// The Claude runner against a scripted fake of the Agent SDK: the query options that keep the
// run tool-less except for our MCP tools (no built-ins, dontAsk, no settings, no persistence,
// no disabled thinking), text deltas, tool calls through the in-process server, the early stop
// after a proposal, error mapping, abort, and that the CLI is always closed.
import { describe, expect, it, vi } from 'vitest'
import type { DataAssistantEvent } from '../../../../../shared/data-projects/types'
import {
  CLAUDE_MAX_TURNS,
  createClaudeRunner,
  toClaudeEffort,
  type ClaudeAgentSdk
} from '../runner-claude'
import { AssistantToolbox } from '../tools'
import { AssistantAbort, AssistantRunError, type AssistantRunInput } from '../types'
import { toolContext } from './fakes'

type Handler = (
  args: Record<string, unknown>,
  extra: unknown
) => Promise<{
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}>
type Message = Record<string, unknown>

interface ScriptContext {
  handlers: Map<string, Handler>
  options: Record<string, unknown>
  prompt: AsyncIterable<Record<string, unknown>>
}

function fakeSdk(script: (ctx: ScriptContext) => AsyncGenerator<Message>) {
  const handlers = new Map<string, Handler>()
  const close = vi.fn()
  const tool = vi.fn((name: string, _description: string, _shape: unknown, handler: Handler) => {
    handlers.set(name, handler)
    return { name }
  })
  const createSdkMcpServer = vi.fn((options: { name: string; tools?: unknown[] }) => ({
    type: 'sdk',
    name: options.name,
    instance: options.tools
  }))
  const query = vi.fn(
    (input: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) =>
      Object.assign(script({ handlers, options: input.options, prompt: input.prompt }), { close })
  )
  const sdk = { query, tool, createSdkMcpServer } as unknown as ClaudeAgentSdk
  return { sdk, handlers, close, query, createSdkMcpServer }
}

const delta = (text: string): Message => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
})
const messageStart: Message = {
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'message_start' }
}

function setup(sdk: ClaudeAgentSdk, signal = new AbortController().signal) {
  const events: DataAssistantEvent[] = []
  const emit = (event: DataAssistantEvent): void => {
    events.push(event)
  }
  const toolbox = new AssistantToolbox({ ctx: toolContext({ signal }), emit })
  const input: AssistantRunInput = {
    systemPrompt: 'SYSTEM PROMPT',
    userPrompt: 'USER PROMPT',
    toolbox,
    generation: { provider: 'claude-code', model: 'claude-opus-4-5-20251101', effort: 'ultracode' },
    signal,
    emit
  }
  const runner = createClaudeRunner({
    loadSdk: async () => sdk,
    launch: async () => ({
      env: { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' },
      binaryPath: '/usr/local/bin/claude',
      normalizeModel: (model) => (model.includes('opus') ? 'opus' : null)
    })
  })
  return { run: () => runner(input), events, toolbox }
}

describe('toClaudeEffort', () => {
  it('maps ultracode to xhigh and drops unknown levels', () => {
    expect(toClaudeEffort('ultracode')).toBe('xhigh')
    expect(toClaudeEffort('HIGH')).toBe('high')
    expect(toClaudeEffort('turbo')).toBeUndefined()
    expect(toClaudeEffort(undefined)).toBeUndefined()
  })
})

describe('createClaudeRunner', () => {
  it('runs with only our MCP tools, streams text, calls tools and stops after the proposal', async () => {
    let firstPrompt: unknown
    const fake = fakeSdk(async function* ({ handlers, prompt }) {
      firstPrompt = (await prompt[Symbol.asyncIterator]().next()).value
      yield messageStart
      yield delta('Let me look ')
      yield delta('at the tables.')
      const listed = await handlers.get('list_tables')!({ pattern: 'order' }, {})
      expect(listed.content[0].text).toContain('public.orders')
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Let me look at the tables.' }] }
      }
      await handlers.get('propose_query')!(
        { query: 'SELECT * FROM orders', explanation: 'All orders.', is_write: false },
        {}
      )
      yield messageStart
      yield delta('Done!')
      throw new Error('the runner should have stopped before this')
    })
    const { run, events, toolbox } = setup(fake.sdk)
    const outcome = await run()

    expect(outcome).toEqual({ answer: null, emitted: true, provider: 'claude-code', model: 'opus' })
    expect(toolbox.proposal?.query).toBe('SELECT * FROM orders')
    expect(fake.close).toHaveBeenCalledTimes(1)
    expect(firstPrompt).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'USER PROMPT' }] }
    })

    const [{ options }] = fake.query.mock.calls[0]
    expect(options).toMatchObject({
      systemPrompt: 'SYSTEM PROMPT',
      tools: [],
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      includePartialMessages: true,
      maxTurns: CLAUDE_MAX_TURNS,
      model: 'opus',
      effort: 'xhigh',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      env: { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' }
    })
    expect(options).not.toHaveProperty('thinking')
    expect(options.allowedTools).toEqual(toolbox.toolNames.map((name) => `mcp__db__${name}`))
    expect(Object.keys(options.mcpServers as object)).toEqual(['db'])
    expect(fake.createSdkMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'db', alwaysLoad: true })
    )

    expect(events.map((e) => e.type)).toEqual([
      'text_delta',
      'text_delta',
      'tool_start',
      'tool_end',
      'tool_start',
      'tool_end',
      'proposal'
    ])
  })

  it('returns the final text as the answer when no query was proposed', async () => {
    const fake = fakeSdk(async function* () {
      yield messageStart
      yield delta('Which status counts as shipped?')
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Which status counts as shipped?'
      }
    })
    const { run } = setup(fake.sdk)
    expect((await run()).answer).toBe('Which status counts as shipped?')
    expect(fake.close).toHaveBeenCalled()
  })

  it('reports tool failures to the model as MCP errors', async () => {
    let reply: Awaited<ReturnType<Handler>> | undefined
    const fake = fakeSdk(async function* ({ handlers }) {
      reply = await handlers.get('describe_table')!({}, {})
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' }
    })
    const { run } = setup(fake.sdk)
    await run()
    expect(reply?.isError).toBe(true)
    expect(reply?.content[0].text).toContain('Invalid arguments for describe_table')
  })

  it('maps an API error result to a friendly, retryable, before-output error', async () => {
    const fake = fakeSdk(async function* () {
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'authentication_failed',
        message: { content: [] }
      }
      yield { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key' }
    })
    const { run } = setup(fake.sdk)
    const error = await run().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssistantRunError)
    expect(error).toMatchObject({ retryable: true, beforeOutput: true })
    expect((error as Error).message).toContain('not signed in')
  })

  it('fails when the turns run out without a proposal', async () => {
    const fake = fakeSdk(async function* ({ handlers }) {
      await handlers.get('list_databases')!({}, {})
      yield { type: 'result', subtype: 'error_max_turns', errors: [] }
    })
    const { run } = setup(fake.sdk)
    await expect(run()).rejects.toMatchObject({ beforeOutput: false, retryable: true })
  })

  it('marks an SDK crash before any output as before-output (fallback allowed)', async () => {
    const fake = fakeSdk(async function* () {
      // The CLI dies before its first message.
      yield* []
      throw new Error('spawn ENOENT')
    })
    const { run } = setup(fake.sdk)
    await expect(run()).rejects.toMatchObject({ beforeOutput: true })
    const unavailable = createClaudeRunner({
      loadSdk: async () => {
        throw new Error('Cannot find module')
      },
      launch: async () => ({ env: {}, binaryPath: null })
    })
    const { toolbox } = setup(fake.sdk)
    await expect(
      unavailable({
        systemPrompt: '',
        userPrompt: '',
        toolbox,
        generation: { provider: 'claude-code' },
        signal: new AbortController().signal,
        emit: () => {}
      })
    ).rejects.toMatchObject({
      message: 'Claude Code is not available: Cannot find module',
      beforeOutput: true
    })
  })

  it('aborts the SDK query and rethrows the abort reason', async () => {
    const controller = new AbortController()
    const fake = fakeSdk(async function* ({ options }) {
      yield messageStart
      const sdkSignal = (options.abortController as AbortController).signal
      await new Promise<void>((resolve) => sdkSignal.addEventListener('abort', () => resolve()))
      const error = new Error('Claude Code process aborted by user')
      error.name = 'AbortError'
      throw error
    })
    const { run } = setup(fake.sdk, controller.signal)
    const pending = run()
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort(new AssistantAbort('cancelled'))
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    expect(fake.close).toHaveBeenCalled()
  })
})
