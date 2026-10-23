// Claude runner: the Agent SDK's `query()` with the assistant's tools hosted by an in-process MCP
// server. Every built-in tool is off (`tools: []`), only our `mcp__db__*` tools are pre-approved
// and anything else is refused without a prompt (`permissionMode: 'dontAsk'`); no user/project
// settings or MCP servers load (`settingSources: []`, `strictMcpConfig`), nothing is persisted.
// Thinking is left to the model's default: newer models reject `thinking: disabled`.
//
// The prompt is a streaming input (one user message, held open until the result) because SDK
// MCP servers need the control channel of streaming mode. The run ends as soon as a query was
// proposed (no need to wait for closing words), on the turn's `result`, or on abort; the CLI
// process is closed in every case.

import { tmpdir } from 'node:os'
import { ASSISTANT_MCP_SERVER, TOOL_TIMEOUT_MS } from './tools'
import {
  AssistantAbort,
  AssistantRunError,
  isAbortError,
  type AssistantRunInput,
  type AssistantRunOutcome,
  type AssistantRunner
} from './types'

/** Model turns per run: enough for a few lookups, a parser bounce and the proposal. */
export const CLAUDE_MAX_TURNS = 16

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]

type SdkMessage = Record<string, unknown> & { type?: string }

/** The slice of the Agent SDK the runner uses (structural, so tests can pass a fake). */
export interface ClaudeAgentSdk {
  query: (input: {
    prompt: AsyncIterable<Record<string, unknown>>
    options: Record<string, unknown>
  }) => AsyncIterable<SdkMessage> & { close?: () => void }
  createSdkMcpServer?: (options: {
    name: string
    version?: string
    tools?: unknown[]
    alwaysLoad?: boolean
    timeout?: number
  }) => unknown
  tool?: (
    name: string,
    description: string,
    shape: Record<string, unknown>,
    handler: (
      args: Record<string, unknown>,
      extra: unknown
    ) => Promise<{
      content: Array<{ type: 'text'; text: string }>
      isError?: boolean
    }>
  ) => unknown
}

export interface ClaudeLaunchSettings {
  /** The CLI's environment: process env, the user's env vars, then the usage-proxy vars last. */
  env: Record<string, string | undefined>
  /** System `claude` binary (the SDK's bundled one cannot run from inside app.asar). */
  binaryPath: string | null
  /** Maps a catalog model id to what the CLI accepts (`claude-opus-4-5-…` → `opus`). */
  normalizeModel?: (model: string) => string | null
}

export interface ClaudeRunnerDeps {
  loadSdk: () => Promise<ClaudeAgentSdk>
  launch: () => Promise<ClaudeLaunchSettings>
}

export function toClaudeEffort(effort: string | undefined): ClaudeEffort | undefined {
  if (!effort) return undefined
  const lower = effort.toLowerCase()
  // `ultracode` is a CLI-only pseudo-effort; xhigh is its SDK equivalent.
  if (lower === 'ultracode') return 'xhigh'
  return (CLAUDE_EFFORTS as readonly string[]).includes(lower) ? (lower as ClaudeEffort) : undefined
}

const ASSISTANT_ERROR_TEXT: Record<string, string> = {
  authentication_failed:
    'Claude Code is not signed in. Open a terminal, run `claude` once and sign in.',
  oauth_org_not_allowed: 'Your Claude organisation does not allow this client.',
  account_on_hold: 'Your Claude account is on hold.',
  billing_error: 'Claude rejected the request because of a billing problem.',
  rate_limit: 'Claude rate limit reached. Try again in a moment.',
  overloaded: 'Claude is overloaded right now. Try again in a moment.',
  model_not_found:
    'The selected Claude model is not available to your account. Pick another model.',
  server_error: 'Claude had a server error. Try again.',
  max_output_tokens: 'The answer was too long for the model. Ask for something narrower.'
}

function textOfAssistantMessage(message: SdkMessage): string {
  const inner = message.message as { content?: unknown } | undefined
  if (!inner || !Array.isArray(inner.content)) return ''
  return inner.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
    )
    .map((block) => block.text)
    .join('')
}

function abortErrorOf(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AssistantAbort('cancelled')
}

export function createClaudeRunner(deps: ClaudeRunnerDeps): AssistantRunner {
  return async (input: AssistantRunInput): Promise<AssistantRunOutcome> => {
    const { toolbox, emit, signal, generation } = input
    let streamedText = false
    const emittedAnything = (): boolean =>
      streamedText || toolbox.calls > 0 || toolbox.proposal !== null

    if (signal.aborted) throw abortErrorOf(signal)

    let sdk: ClaudeAgentSdk
    let launch: ClaudeLaunchSettings
    try {
      ;[sdk, launch] = await Promise.all([deps.loadSdk(), deps.launch()])
    } catch (error) {
      throw new AssistantRunError(
        `Claude Code is not available: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, beforeOutput: true }
      )
    }
    const { createSdkMcpServer, tool } = sdk
    if (!createSdkMcpServer || !tool) {
      throw new AssistantRunError('The installed Claude Agent SDK cannot host tools.', {
        retryable: false,
        beforeOutput: true
      })
    }

    const mcpTools = toolbox.tools.map((definition) =>
      tool(definition.name, definition.description, definition.shape, async (args) => {
        try {
          const result = await toolbox.call(definition.name, args)
          return {
            content: [{ type: 'text' as const, text: result.text }],
            ...(result.ok ? {} : { isError: true })
          }
        } catch {
          // Aborted mid-call: the query is being torn down; tell the model to stop.
          return {
            content: [{ type: 'text' as const, text: 'Cancelled by the user.' }],
            isError: true
          }
        }
      })
    )
    const server = createSdkMcpServer({
      name: ASSISTANT_MCP_SERVER,
      version: '1.0.0',
      alwaysLoad: true,
      timeout: TOOL_TIMEOUT_MS + 10_000,
      tools: mcpTools
    })

    let releasePrompt: () => void = () => {}
    const promptDone = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const userPrompt = input.userPrompt
    async function* promptStream(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: userPrompt }] },
        parent_tool_use_id: null
      }
      // Streaming input stays open until the run is over (SDK MCP servers need it).
      await promptDone
    }

    const abortController = new AbortController()
    const forwardAbort = (): void => abortController.abort()
    signal.addEventListener('abort', forwardAbort, { once: true })

    const requestedModel = generation.model?.trim() || undefined
    const model = requestedModel
      ? (launch.normalizeModel?.(requestedModel) ?? requestedModel)
      : undefined
    const effort = toClaudeEffort(generation.effort) ?? 'medium'
    const binary = launch.binaryPath
    let stderrTail = ''

    const options: Record<string, unknown> = {
      cwd: tmpdir(),
      systemPrompt: input.systemPrompt,
      tools: [],
      mcpServers: { [ASSISTANT_MCP_SERVER]: server },
      allowedTools: toolbox.toolNames.map((name) => `mcp__${ASSISTANT_MCP_SERVER}__${name}`),
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      includePartialMessages: true,
      maxTurns: CLAUDE_MAX_TURNS,
      abortController,
      effort,
      env: launch.env,
      stderr: (data: string) => {
        stderrTail = (stderrTail + data).slice(-1_500)
      },
      ...(model ? { model } : {}),
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {})
    }

    let query: (AsyncIterable<SdkMessage> & { close?: () => void }) | null = null
    let currentText = ''
    let lastAssistantText = ''
    let resultText: string | null = null
    let assistantError: string | null = null

    try {
      query = sdk.query({ prompt: promptStream(), options })
      for await (const message of query) {
        if (signal.aborted) break
        if (message.type === 'stream_event') {
          if (message.parent_tool_use_id) continue
          const event = message.event as
            { type?: string; delta?: { type?: string; text?: unknown } } | undefined
          if (event?.type === 'message_start') currentText = ''
          if (
            event?.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            typeof event.delta.text === 'string' &&
            event.delta.text
          ) {
            currentText += event.delta.text
            streamedText = true
            emit({ type: 'text_delta', text: event.delta.text })
          }
        } else if (message.type === 'assistant') {
          if (message.parent_tool_use_id) continue
          const text = textOfAssistantMessage(message)
          if (text.trim()) lastAssistantText = text
          if (typeof message.error === 'string') {
            assistantError = ASSISTANT_ERROR_TEXT[message.error] ?? `Claude error: ${message.error}`
          }
        } else if (message.type === 'result') {
          const subtype = String(message.subtype ?? '')
          if (subtype === 'success') {
            if (message.is_error === true && !toolbox.proposal) {
              throw new AssistantRunError(
                assistantError ??
                  (String(message.result ?? '').trim() || 'Claude returned an error.'),
                { retryable: true, beforeOutput: !emittedAnything() }
              )
            }
            resultText = typeof message.result === 'string' ? message.result : null
          } else if (!toolbox.proposal) {
            if (subtype === 'error_max_turns') {
              throw new AssistantRunError(
                `The assistant used all its ${CLAUDE_MAX_TURNS} steps without delivering a query. Try a more specific question.`,
                { retryable: true }
              )
            }
            const errors = Array.isArray(message.errors) ? message.errors.join('; ') : ''
            throw new AssistantRunError(
              assistantError ?? `Claude stopped (${subtype}${errors ? `: ${errors}` : ''}).`,
              { retryable: true, beforeOutput: !emittedAnything() }
            )
          }
          break
        }
        // A delivered query ends the run: the closing words would only cost time.
        if (toolbox.proposal) break
      }
    } catch (error) {
      if (signal.aborted) throw abortErrorOf(signal)
      if (error instanceof AssistantRunError) throw error
      const message = error instanceof Error ? error.message : String(error)
      const hint = stderrTail.trim()
        ? ` (${stderrTail.trim().split('\n').slice(-2).join(' ')})`
        : ''
      throw new AssistantRunError(
        isAbortError(error)
          ? 'Claude Code stopped unexpectedly.'
          : `Claude Code failed: ${message}${hint}`,
        { retryable: true, beforeOutput: !emittedAnything() }
      )
    } finally {
      signal.removeEventListener('abort', forwardAbort)
      releasePrompt()
      try {
        if (query?.close) query.close()
        else abortController.abort()
      } catch {
        abortController.abort()
      }
    }

    if (signal.aborted) throw abortErrorOf(signal)
    const answer = toolbox.proposal
      ? null
      : resultText?.trim() || lastAssistantText.trim() || currentText.trim() || null
    const usedModel = model ?? requestedModel
    return {
      answer,
      emitted: emittedAnything(),
      provider: 'claude-code',
      ...(usedModel ? { model: usedModel } : {})
    }
  }
}
