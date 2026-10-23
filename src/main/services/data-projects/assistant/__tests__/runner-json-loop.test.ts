// @vitest-environment node
// The JSON-action loop with a fake `generate`: tool steps feed results back, a proposal ends the
// run through the toolbox, a malformed reply gets one repair round, the step cap holds, and the
// run's AbortSignal reaches every generate call.
import { describe, expect, it, vi } from 'vitest'
import type { DataAssistantEvent } from '../../../../../shared/data-projects/types'
import {
  createJsonLoopRunner,
  JSON_LOOP_MAX_STEPS,
  parseAssistantAction,
  type AssistantGenerate
} from '../runner-json-loop'
import { AssistantToolbox } from '../tools'
import { AssistantAbort, AssistantRunError, type AssistantRunInput } from '../types'
import { toolContext } from './fakes'

const action = (value: Record<string, unknown>): string => JSON.stringify(value)
const TOOLS = (calls: Array<{ name: string; args: Record<string, unknown> }>): string =>
  action({
    action: 'tools',
    tool_calls: calls.map((call) => ({ name: call.name, args_json: JSON.stringify(call.args) })),
    query: '',
    explanation: '',
    is_write: false,
    database: '',
    answer: ''
  })
const PROPOSE = (query: string): string =>
  action({
    action: 'propose_query',
    tool_calls: [],
    query,
    explanation: 'Orders since yesterday.',
    is_write: false,
    database: '',
    answer: ''
  })

function setup(replies: Array<string | null | Error>, signal = new AbortController().signal) {
  const events: DataAssistantEvent[] = []
  const emit = (event: DataAssistantEvent): void => {
    events.push(event)
  }
  const toolbox = new AssistantToolbox({ ctx: toolContext({ signal }), emit })
  const prompts: string[] = []
  const generate = vi.fn<AssistantGenerate>(async (prompt) => {
    prompts.push(prompt)
    const next = replies.shift()
    if (next instanceof Error) throw next
    return next ?? null
  })
  const input: AssistantRunInput = {
    systemPrompt: 'SYSTEM',
    userPrompt: '<user_question>\norders since yesterday\n</user_question>',
    toolbox,
    generation: { provider: 'codex', model: 'gpt-5.5', effort: 'low' },
    signal,
    emit
  }
  return {
    run: () => createJsonLoopRunner({ generate })(input),
    generate,
    prompts,
    events,
    toolbox
  }
}

describe('parseAssistantAction', () => {
  it('reads the three actions and tolerates common deviations', () => {
    expect(
      parseAssistantAction(TOOLS([{ name: 'list_tables', args: { pattern: 'ord' } }]))
    ).toEqual({
      kind: 'tools',
      calls: [{ name: 'list_tables', args: { pattern: 'ord' } }]
    })
    expect(
      parseAssistantAction(
        'Sure!\n```json\n{"action":"tool","name":"describe_table","args":{"table":"orders"}}\n```'
      )
    ).toEqual({ kind: 'tools', calls: [{ name: 'describe_table', args: { table: 'orders' } }] })
    expect(parseAssistantAction('{"action":"final","query":"SELECT 1","isWrite":true}')).toEqual({
      kind: 'propose',
      query: 'SELECT 1',
      explanation: '',
      isWrite: true
    })
    expect(parseAssistantAction('{"action":"answer","answer":"Which status?"}')).toEqual({
      kind: 'answer',
      text: 'Which status?'
    })
    expect(parseAssistantAction('no json here')).toMatchObject({ kind: 'invalid' })
    expect(parseAssistantAction('{"action":"dance"}')).toMatchObject({
      kind: 'invalid',
      error: 'unknown action "dance"'
    })
  })
})

describe('createJsonLoopRunner', () => {
  it('runs tool steps, feeds their results back and ends on the proposal', async () => {
    const { run, generate, prompts, events, toolbox } = setup([
      TOOLS([{ name: 'list_tables', args: { pattern: 'order' } }]),
      TOOLS([{ name: 'describe_table', args: { table: 'orders' } }]),
      PROPOSE("SELECT * FROM orders WHERE created_at >= now() - interval '1 day'")
    ])
    const outcome = await run()
    expect(outcome).toEqual({ answer: null, emitted: true, provider: 'codex', model: 'gpt-5.5' })
    expect(toolbox.proposal?.query).toContain('interval')
    expect(generate).toHaveBeenCalledTimes(3)
    const [, system, provider, options] = generate.mock.calls[0]
    expect(system).toBe('SYSTEM')
    expect(provider).toBe('codex')
    expect(options).toMatchObject({ modelOverride: 'gpt-5.5', effort: 'low', maxRetries: 0 })
    expect(options.outputSchema).toContain('"tool_calls"')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(prompts[1]).toContain('<tool_result name="list_tables">')
    expect(prompts[2]).toContain('<tool_result name="describe_table">')
    expect(prompts[2]).toContain('step 3 of')
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1)
    expect(
      events.filter((e) => e.type === 'status').map((e) => (e as { text: string }).text)
    ).toEqual([
      'Asking Codex…',
      `Asking Codex… (step 2 of ${JSON_LOOP_MAX_STEPS})`,
      `Asking Codex… (step 3 of ${JSON_LOOP_MAX_STEPS})`
    ])
  })

  it('returns a prose answer', async () => {
    const { run } = setup([action({ action: 'answer', answer: 'Which status means shipped?' })])
    expect((await run()).answer).toBe('Which status means shipped?')
  })

  it('gives a malformed reply one repair round', async () => {
    const { run, prompts } = setup(['{"oops":', PROPOSE('SELECT 1')])
    const outcome = await run()
    expect(outcome.answer).toBeNull()
    expect(prompts[1]).toContain('Your previous reply could not be used')
  })

  it('treats two prose replies in a row as an answer', async () => {
    const { run } = setup(['I need more details.', 'Which table holds payments?'])
    expect((await run()).answer).toBe('Which table holds payments?')
  })

  it('feeds a rejected proposal back and accepts the fix', async () => {
    const events: DataAssistantEvent[] = []
    const toolbox = new AssistantToolbox({
      ctx: toolContext(),
      emit: (event) => events.push(event),
      validateProposal: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'unterminated string' })
        .mockResolvedValue({ ok: true, isWrite: false })
    })
    const replies = [PROPOSE("SELECT 'x"), PROPOSE("SELECT 'x'")]
    const prompts: string[] = []
    const generate = vi.fn<AssistantGenerate>(async (prompt) => {
      prompts.push(prompt)
      return replies.shift() ?? null
    })
    await createJsonLoopRunner({ generate })({
      systemPrompt: 'S',
      userPrompt: 'U',
      toolbox,
      generation: { provider: 'opencode' },
      signal: new AbortController().signal,
      emit: (event) => events.push(event)
    })
    expect(prompts[1]).toContain('The query was NOT delivered: unterminated string')
    expect(toolbox.proposal?.query).toBe("SELECT 'x'")
  })

  it('stops after the step cap with a retryable error', async () => {
    const replies = Array.from({ length: JSON_LOOP_MAX_STEPS }, () =>
      TOOLS([{ name: 'list_databases', args: {} }])
    )
    const { run, prompts } = setup(replies)
    await expect(run()).rejects.toMatchObject({ retryable: true })
    expect(prompts.at(-1)).toContain('This is your final step')
  })

  it('marks a provider failure before any tool call as before-output', async () => {
    const { run } = setup([new Error('codex exited with code 1')])
    const error = await run().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssistantRunError)
    expect(error).toMatchObject({
      message: 'Codex failed: codex exited with code 1',
      beforeOutput: true
    })
  })

  it('rethrows the abort reason when the run is cancelled mid-step', async () => {
    const controller = new AbortController()
    const { run } = setup([], controller.signal)
    const pending = run()
    controller.abort(new AssistantAbort('cancelled'))
    // The fake generate resolved null; the loop notices the abort before the next step.
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
  })
})
