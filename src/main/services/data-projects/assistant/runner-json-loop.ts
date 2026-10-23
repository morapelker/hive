// JSON-action loop: the assistant for providers that cannot host our tools in-process (Codex,
// OpenCode) and the fallback when the Claude runner fails before anything reached the user.
// Each step is one `generateText` call that must answer with one JSON action — call tools,
// propose the query, or answer in prose. Tool results are appended to the transcript and the
// next step runs, at most JSON_LOOP_MAX_STEPS times. Proposals go through the same toolbox as
// the Claude runner (same validation, same events). Every step spawns a CLI, so the status line
// says which step is running; the run's AbortSignal kills the spawned process.

import { extractJsonObject } from '../../../../shared/document-flow/json'
import type { AgentSdkId } from '../../agent-sdk-types'
import type { GenerateTextOptions } from '../../text-generation-router'
import { escapeWrapperTags } from './prompts'
import { PROPOSE_QUERY_TOOL } from './tools'
import {
  AssistantAbort,
  AssistantRunError,
  type AssistantRunInput,
  type AssistantRunOutcome,
  type AssistantRunner
} from './types'

export const JSON_LOOP_MAX_STEPS = 6
const STEP_TIMEOUT_MS = 90_000
const MAX_CALLS_PER_STEP = 4
/** Older tool results are shortened once the transcript grows past this. */
const TRANSCRIPT_MAX_CHARS = 48_000
const OLD_RESULT_MAX_CHARS = 1_500

export type AssistantGenerate = (
  prompt: string,
  systemPrompt: string,
  provider: AgentSdkId,
  options: GenerateTextOptions
) => Promise<string | null>

/**
 * Strict JSON schema of one action (Codex enforces it; the others are told the same shape).
 * Strict mode wants every key required, so unused keys carry empty values; it also rejects
 * array-size keywords, so the per-step call cap is applied when parsing instead.
 */
export const ASSISTANT_ACTION_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'tool_calls', 'query', 'explanation', 'is_write', 'database', 'answer'],
  properties: {
    action: { type: 'string', enum: ['tools', 'propose_query', 'answer'] },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'args_json'],
        properties: { name: { type: 'string' }, args_json: { type: 'string' } }
      }
    },
    query: { type: 'string' },
    explanation: { type: 'string' },
    is_write: { type: 'boolean' },
    database: { type: 'string' },
    answer: { type: 'string' }
  }
})

export type AssistantAction =
  | { kind: 'tools'; calls: Array<{ name: string; args: Record<string, unknown> }> }
  | { kind: 'propose'; query: string; explanation: string; isWrite: boolean; database?: string }
  | { kind: 'answer'; text: string }
  | { kind: 'invalid'; error: string }

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function parseArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = extractJsonObject(value)
    if (parsed) return parsed
  }
  return {}
}

/** Reads one action out of a model reply, tolerating the usual deviations from the schema. */
export function parseAssistantAction(reply: string): AssistantAction {
  const object = extractJsonObject(reply)
  if (!object) return { kind: 'invalid', error: 'the reply was not a JSON object' }
  const action = text(object.action ?? object.type)
    .trim()
    .toLowerCase()
  const rawCalls = Array.isArray(object.tool_calls)
    ? object.tool_calls
    : Array.isArray(object.calls)
      ? object.calls
      : null

  if (
    ['tools', 'tool', 'tool_call', 'tool_calls', 'call'].includes(action) ||
    (!action && rawCalls?.length)
  ) {
    const source: unknown[] = rawCalls ?? (object.name ? [object] : [])
    const calls = source
      .filter((call): call is Record<string, unknown> => !!call && typeof call === 'object')
      .map((call) => ({
        name: text(call.name ?? call.tool).trim(),
        args: parseArgs(call.args_json ?? call.args ?? call.arguments)
      }))
      .filter((call) => call.name)
      .slice(0, MAX_CALLS_PER_STEP)
    if (!calls.length) return { kind: 'invalid', error: '"tools" without any tool_calls' }
    // A propose_query among the calls goes through the toolbox like the propose action.
    return { kind: 'tools', calls }
  }
  if (['propose_query', 'propose', 'final', 'query'].includes(action)) {
    const query = text(object.query).trim()
    if (!query) return { kind: 'invalid', error: '"propose_query" without a query' }
    const database = text(object.database).trim()
    return {
      kind: 'propose',
      query,
      explanation: text(object.explanation).trim(),
      isWrite: object.is_write === true || object.isWrite === true,
      ...(database ? { database } : {})
    }
  }
  if (['answer', 'reply', 'message'].includes(action)) {
    const answer = text(object.answer ?? object.text ?? object.message).trim()
    if (!answer) return { kind: 'invalid', error: '"answer" without text' }
    return { kind: 'answer', text: answer }
  }
  return { kind: 'invalid', error: action ? `unknown action "${action}"` : 'missing "action"' }
}

interface LoopStep {
  n: number
  calls: Array<{ name: string; args: Record<string, unknown>; result: string }>
}

function renderSteps(steps: LoopStep[]): string {
  const render = (step: LoopStep, shorten: boolean): string =>
    [
      `<step n="${step.n}">`,
      ...step.calls.flatMap((call) => {
        const result =
          shorten && call.result.length > OLD_RESULT_MAX_CHARS
            ? `${call.result.slice(0, OLD_RESULT_MAX_CHARS)}\n… [shortened: call the tool again if you need the rest]`
            : call.result
        return [
          `You called ${call.name} ${JSON.stringify(call.args)}`,
          `<tool_result name="${call.name}">`,
          escapeWrapperTags(result),
          '</tool_result>'
        ]
      }),
      '</step>'
    ].join('\n')
  let rendered = steps.map((step) => render(step, false))
  // Shorten the oldest steps first until the transcript fits.
  for (let i = 0; i < steps.length - 1 && rendered.join('\n').length > TRANSCRIPT_MAX_CHARS; i++) {
    rendered[i] = render(steps[i], true)
  }
  rendered = rendered.filter(Boolean)
  return rendered.length ? ['<steps>', ...rendered, '</steps>'].join('\n') : ''
}

function buildStepPrompt(
  userPrompt: string,
  steps: LoopStep[],
  options: { step: number; last: boolean; repairNote: string | null }
): string {
  const parts = ['<conversation>', userPrompt, '</conversation>']
  const rendered = renderSteps(steps)
  if (rendered) parts.push(rendered)
  if (options.repairNote) parts.push(options.repairNote)
  parts.push(
    options.last
      ? 'This is your final step: tools are no longer available. Reply with action "propose_query" (or "answer" if no query fits) now.'
      : `Reply with the next JSON action (step ${options.step} of ${JSON_LOOP_MAX_STEPS}).`
  )
  return parts.join('\n')
}

const PROVIDER_LABEL: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode'
}

function abortErrorOf(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AssistantAbort('cancelled')
}

export function createJsonLoopRunner(deps: { generate: AssistantGenerate }): AssistantRunner {
  return async (input: AssistantRunInput): Promise<AssistantRunOutcome> => {
    const { toolbox, signal, generation, emit } = input
    const provider = generation.provider as AgentSdkId
    const label = PROVIDER_LABEL[generation.provider] ?? generation.provider
    const outcome = (answer: string | null): AssistantRunOutcome => ({
      answer,
      emitted: true,
      provider: generation.provider,
      ...(generation.model ? { model: generation.model } : {})
    })
    const steps: LoopStep[] = []
    let repairNote: string | null = null

    for (let step = 1; step <= JSON_LOOP_MAX_STEPS; step++) {
      if (signal.aborted) throw abortErrorOf(signal)
      const last = step === JSON_LOOP_MAX_STEPS
      emit({
        type: 'status',
        text:
          step === 1
            ? `Asking ${label}…`
            : `Asking ${label}… (step ${step} of ${JSON_LOOP_MAX_STEPS})`
      })

      let reply: string | null
      try {
        reply = await deps.generate(
          buildStepPrompt(input.userPrompt, steps, { step, last, repairNote }),
          input.systemPrompt,
          provider,
          {
            ...(generation.model ? { modelOverride: generation.model } : {}),
            ...(generation.effort ? { effort: generation.effort } : {}),
            outputSchema: ASSISTANT_ACTION_SCHEMA,
            timeoutMs: STEP_TIMEOUT_MS,
            maxRetries: 0,
            signal
          }
        )
      } catch (error) {
        if (signal.aborted) throw abortErrorOf(signal)
        const message = error instanceof Error ? error.message : String(error)
        throw new AssistantRunError(`${label} failed: ${message}`, {
          retryable: true,
          beforeOutput: toolbox.calls === 0
        })
      }
      if (signal.aborted) throw abortErrorOf(signal)

      const raw = (reply ?? '').trim()
      const action = parseAssistantAction(raw)
      if (action.kind === 'invalid') {
        if (!repairNote) {
          repairNote = `Your previous reply could not be used (${action.error}). Reply again with exactly one JSON object in the required format.`
          continue
        }
        // Two unusable replies in a row: prose is still an answer; anything else is a failure.
        if (raw && !raw.startsWith('{') && !raw.startsWith('```')) return outcome(raw)
        throw new AssistantRunError(
          `${label} did not answer in the expected format. Try again or pick another model.`,
          { retryable: true, beforeOutput: toolbox.calls === 0 }
        )
      }
      repairNote = null

      if (action.kind === 'answer') return outcome(action.text)

      if (action.kind === 'propose') {
        const result = await toolbox.call(PROPOSE_QUERY_TOOL, {
          query: action.query,
          explanation: action.explanation,
          is_write: action.isWrite,
          ...(action.database ? { database: action.database } : {})
        })
        if (toolbox.proposal) return outcome(null)
        steps.push({
          n: step,
          calls: [{ name: PROPOSE_QUERY_TOOL, args: { query: action.query }, result: result.text }]
        })
        continue
      }

      if (last) break
      const calls: LoopStep['calls'] = []
      for (const call of action.calls) {
        const result = await toolbox.call(call.name, call.args)
        if (toolbox.proposal) return outcome(null)
        calls.push({ name: call.name, args: call.args, result: result.text })
      }
      steps.push({ n: step, calls })
    }

    throw new AssistantRunError(
      `The assistant could not deliver a query within ${JSON_LOOP_MAX_STEPS} steps. Try a more specific question.`,
      { retryable: true }
    )
  }
}
