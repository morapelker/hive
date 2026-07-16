import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { Effect } from 'effect'

import { loadClaudeSDK } from './claude-sdk-loader'
import { resolveCodexBinaryPath } from './codex-binary-resolver'
import { getCodexCliEnv } from './codex-cli-env'
import { detectAgentSdks } from './system-info'
import type { AgentSdkDetection } from './system-info'
import type { OpenCodeLaunchSpec } from './opencode-binary-resolver'
import { createLogger } from './logger'
import type { AgentSdkId } from './agent-sdk-types'
import {
  SpawnFailed,
  SpawnNonZeroExit,
  SpawnOutputCapExceeded,
  SpawnSignalled,
  SpawnTimeout
} from '../effect/spawn/errors'
import { getRuntime } from '../effect/spawn/runtime'
import { Spawn } from '../effect/spawn/service'

const log = createLogger({ component: 'TextGenerationRouter' })

const TIMEOUT_MS = 30_000
const MAX_RETRIES = 1
const MAX_OUTPUT_SIZE = 1024 * 1024 // 1 MB

export interface GenerateTextOptions {
  modelOverride?: string
  outputSchema?: string
  cwd?: string
}

let cachedSdks: AgentSdkDetection | null = null
let cacheTimestamp = 0
const SDK_CACHE_TTL_MS = 60_000

let claudeBinaryPath: string | null = null
let codexBinaryPath: string | null = null
let openCodeLaunchSpec: OpenCodeLaunchSpec | null = null

export function setClaudeBinaryPath(path: string | null): void {
  claudeBinaryPath = path
}

export function setCodexBinaryPath(path: string | null): void {
  codexBinaryPath = path
}

export function setOpenCodeLaunchSpec(spec: OpenCodeLaunchSpec | null): void {
  openCodeLaunchSpec = spec
}

function getCachedSdkDetection(): AgentSdkDetection {
  const now = Date.now()
  if (!cachedSdks || now - cacheTimestamp > SDK_CACHE_TTL_MS) {
    cachedSdks = detectAgentSdks(openCodeLaunchSpec)
    cacheTimestamp = now
  }
  return cachedSdks
}

/**
 * Generate text using the specified provider's LLM.
 *
 * Provider routing:
 * - claude-code: Uses the Claude Agent SDK with haiku
 * - codex: Spawns `codex exec` with prompt piped to stdin
 * - opencode: Spawns `opencode run` and parses the JSON event stream
 * - terminal: No generation capability, returns null
 *
 * Falls back through available providers (Claude -> Codex -> OpenCode)
 * if the selected provider's CLI is not available.
 */
export async function generateText(
  prompt: string,
  systemPrompt: string,
  provider: AgentSdkId,
  options: GenerateTextOptions = {}
): Promise<string | null> {
  const { modelOverride, outputSchema, cwd } = options
  const resolvedProvider = resolveProvider(provider)
  if (!resolvedProvider) {
    throw new Error(
      'No AI provider available. Ensure claude, codex, or opencode CLI is installed and on your PATH.'
    )
  }

  if (resolvedProvider !== provider) {
    log.info('Falling back to available provider', { requested: provider, resolved: resolvedProvider })
  }

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await generateWithProvider(
        resolvedProvider,
        prompt,
        systemPrompt,
        modelOverride,
        outputSchema,
        cwd
      )
      if (result !== null) {
        log.info('Text generation succeeded', {
          requestedProvider: provider,
          resolvedProvider,
          attempt,
          usedStructuredOutput: Boolean(outputSchema),
          cwd
        })
        return result
      }
      lastError = new Error('Text generation returned empty result')
      log.warn('Text generation returned empty result', {
        requestedProvider: provider,
        resolvedProvider,
        attempt,
        cwd
      })
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err))
      log.warn('Text generation attempt failed', {
        requestedProvider: provider,
        resolvedProvider,
        attempt,
        error: lastError.message,
        cwd
      })
    }
  }

  log.warn('Text generation: all attempts exhausted', {
    requestedProvider: provider,
    resolvedProvider,
    cwd
  })
  throw lastError ?? new Error('Text generation failed: all attempts returned empty results')
}

/**
 * Resolve to an available provider, falling back if the requested one is unavailable.
 * Fallback order: claude-code -> codex -> opencode.
 */
function resolveProvider(provider: AgentSdkId): AgentSdkId | null {
  if (provider === 'terminal') return null

  const sdks = getCachedSdkDetection()
  const providerAvailable: Record<Exclude<AgentSdkId, 'terminal'>, boolean> = {
    'claude-code': sdks.claude,
    'claude-code-cli': sdks.claude,
    codex: sdks.codex,
    'codex-cli': sdks.codexCli,
    opencode: sdks.opencode
  }

  if (providerAvailable[provider]) return provider

  const fallbackOrder: Exclude<AgentSdkId, 'terminal'>[] = ['claude-code', 'codex', 'opencode']
  for (const fallback of fallbackOrder) {
    if (providerAvailable[fallback]) return fallback
  }

  return null
}

/**
 * Dispatch to the correct provider implementation.
 */
function generateWithProvider(
  provider: AgentSdkId,
  prompt: string,
  systemPrompt: string,
  modelOverride?: string,
  outputSchema?: string,
  cwd?: string
): Promise<string | null> {
  switch (provider) {
    case 'claude-code':
      return generateWithClaude(prompt, systemPrompt, modelOverride, cwd)
    case 'codex':
      return generateWithCodex(prompt, systemPrompt, modelOverride, outputSchema, cwd)
    case 'opencode':
      return generateWithOpenCode(prompt, systemPrompt, modelOverride, cwd)
    case 'terminal':
      return Promise.resolve(null)
  }
}

/**
 * Generate text using the Claude Agent SDK (haiku model).
 */
async function generateWithClaude(
  prompt: string,
  systemPrompt: string,
  modelOverride?: string,
  cwd?: string
): Promise<string | null> {
  const sdk = await loadClaudeSDK()

  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), TIMEOUT_MS)
  let streamedText = ''

  try {
    const query = sdk.query({
      prompt,
      options: {
        cwd: cwd ?? homedir(),
        model: modelOverride ?? 'haiku',
        maxTurns: 2,
        abortController,
        systemPrompt,
        effort: 'low',
        thinking: { type: 'disabled' },
        tools: [],
        persistSession: false,
        ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {})
      }
    })

    let resultText = ''
    for await (const msg of query) {
      // Collect assistant text as it streams — fallback if the session ends early
      if (msg.type === 'assistant') {
        const content = (msg as Record<string, unknown>).message
        if (content && typeof content === 'object') {
          const blocks = (content as Record<string, unknown>).content
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
                streamedText += (block as Record<string, unknown>).text ?? ''
              }
            }
          }
        }
      }
      if (msg.type === 'result') {
        const resultMsg = msg as Record<string, unknown>
        if (typeof resultMsg.subtype === 'string' && resultMsg.subtype.startsWith('error')) {
          // For max_turns errors, use whatever text was already streamed
          if (resultMsg.subtype === 'error_max_turns' && streamedText) {
            log.info('Using streamed text after max_turns reached')
            resultText = streamedText
            break
          }
          const errors = Array.isArray(resultMsg.errors) ? resultMsg.errors : []
          throw new Error(
            `Claude generation error (${resultMsg.subtype}): ${errors.join('; ') || 'unknown'}`
          )
        }
        resultText = (resultMsg.result as string) ?? ''
        break
      }
    }

    return resultText || null
  } catch (err) {
    // If we collected streamed text before the error, use it as fallback
    if (streamedText) {
      log.warn('Using streamed text after error', {
        error: err instanceof Error ? err.message : String(err),
        streamedTextLength: streamedText.length
      })
      return streamedText
    }
    // Convert AbortError from timeout into a clearer message
    if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
      log.warn('Claude generation timed out', { error: err.message })
      throw new Error(`AI content generation timed out after ${TIMEOUT_MS / 1000}s`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Generate text by spawning `codex exec`.
 * Writes output to a temp file via --output-last-message, then reads it.
 */
async function generateWithCodex(
  prompt: string,
  systemPrompt: string,
  modelOverride?: string,
  outputSchema?: string,
  cwd?: string
): Promise<string | null> {
  const resolvedBinary = resolveCodexBinaryPath()
  const binary = codexBinaryPath || resolvedBinary || 'codex'
  const spawnEnv = getCodexCliEnv()
  const outputFile = join(tmpdir(), `hive-codex-${randomUUID()}.txt`)
  const schemaFile = outputSchema
    ? join(tmpdir(), `hive-codex-schema-${randomUUID()}.json`)
    : null
  const model = modelOverride ?? 'gpt-5.4-mini'
  const fullPrompt = `${systemPrompt}\n\n${prompt}`

  try {
    await writeFile(outputFile, '')
    const args = [
      'exec',
      '--ephemeral',
      '-s',
      'read-only',
      '--model',
      model,
      '--config',
      'model_reasoning_effort="low"'
    ]
    if (schemaFile && outputSchema) {
      await writeFile(schemaFile, outputSchema)
      args.push('--output-schema', schemaFile)
    }
    args.push('--output-last-message', outputFile, '-')

    await spawnWithStdin(
      binary,
      args,
      fullPrompt,
      cwd,
      spawnEnv
    )
    const output = await readFile(outputFile, 'utf-8')
    return output.trim() || null
  } finally {
    // Clean up temp file
    try {
      await unlink(outputFile)
    } catch {
      // File may not exist if codex failed before writing
    }
    if (schemaFile) {
      try {
        await unlink(schemaFile)
      } catch {
        // File may not exist if codex failed before writing
      }
    }
  }
}

/**
 * Generate text by spawning `opencode run` and parsing the JSON event stream.
 * Collects text from events with type "text".
 */
async function generateWithOpenCode(
  prompt: string,
  systemPrompt: string,
  modelOverride?: string,
  cwd?: string
): Promise<string | null> {
  const model = modelOverride ?? 'claude-haiku'
  const fullPrompt = `${systemPrompt}\n\n${prompt}`

  const stdout = await spawnWithStdin(
    'opencode',
    ['run', '--format', 'json', '--model', model],
    fullPrompt,
    cwd
  )

  // Parse newline-delimited JSON events, collecting text from "text" type events
  const textParts: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      if (event.type === 'text' && typeof event.text === 'string') {
        textParts.push(event.text)
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  const result = textParts.join('')
  return result || null
}

/**
 * Spawn a CLI process, pipe input to stdin, and collect stdout.
 * Rejects on non-zero exit, timeout, or spawn error.
 */
function spawnWithStdin(
  command: string,
  args: string[],
  input: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  return getRuntime()
    .runPromise(
      Effect.flatMap(Spawn, (spawn) =>
        spawn.runOnce({
          command,
          args,
          stdin: input,
          timeout: TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_SIZE,
          collectStderr: true,
          env: env ?? process.env,
          cwd
        })
      )
    )
    .then((result) => result.stdout)
    .catch((error: unknown) => {
      throw spawnErrorToError(error, command)
    })
}

function spawnErrorToError(error: unknown, command: string): Error {
  if (error instanceof SpawnTimeout) {
    return new Error(`${command} timed out after ${error.durationMs}ms`)
  }
  if (error instanceof SpawnOutputCapExceeded) {
    return new Error(`${command} ${error.stream} exceeded ${error.limit} bytes`)
  }
  if (error instanceof SpawnNonZeroExit) {
    return new Error(`${command} exited with code ${error.exitCode}: ${error.stderrPreview}`)
  }
  if (error instanceof SpawnFailed) {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
    return new Error(`Failed to spawn ${command}: ${cause}`)
  }
  if (error instanceof SpawnSignalled) {
    return new Error(`${command} exited from signal ${error.signal ?? 'unknown'}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}
