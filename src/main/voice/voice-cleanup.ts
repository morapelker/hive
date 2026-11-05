import { CUSTOM_MODEL_PROVIDER_ID } from '@shared/types/custom-provider'
import type { SharedSelectedModel } from '@shared/model-resolution'
import type { VoiceCleanupResult, VoiceSettings } from '@shared/types/voice'
import {
  appendVocabulary,
  effectiveCleanupSystemPrompt,
  wrapTranscript
} from '@shared/voice/cleanup-prompt'
import { DictionaryReplacer } from '@shared/voice/dictionary-replacer'
import {
  cleanupFallbackReason,
  FALLBACK_REASON_DESCRIPTIONS,
  sanitizeTranscriptOutput
} from '@shared/voice/transcript-sanitizer'
import type { DatabaseService } from '../db/database'
import type { AgentSdkId } from '../services/agent-sdk-types'
import { buildCustomProviderShellSpawn } from '../services/claude-cli-spawner'
import { getCustomProviderById } from '../services/custom-providers'
import { getUserEnvironmentVariables } from '../services/env-vars'
import { createLogger } from '../services/logger'
import { generateText } from '../services/text-generation-router'
import { spawnCLI } from '../services/title-generation-shared'

const log = createLogger({ component: 'VoiceCleanup' })

/** Wispelker caps nothing, but a runaway transcript should never reach a model uncapped. */
const MAX_TRANSCRIPT_CHARS = 20_000
/** The configured timeout is for a typical sentence; long dictations get 40 ms per character more, up to a minute. */
const EXTRA_BUDGET_MS_PER_CHAR = 40
const MAX_BUDGET_MS = 60_000

export interface VoiceCleanupOutcome {
  /** Text to paste: cleaned when the model succeeded, otherwise the dictionary-corrected raw transcript. */
  readonly text: string
  /** True when `text` is the model's output. */
  readonly cleaned: boolean
  /** Human-readable reason when the raw transcript was used instead. */
  readonly fallbackReason: string | null
  /** What the AI step did, for the per-dictation summary log. */
  readonly ai: VoiceCleanupAiResult
}

/**
 * `disabled`: cleanup is off (or the caller turned it off). `not-applicable`:
 * nothing to clean. `skipped`: the caller aborted the step (the user skipped
 * polishing). `timed-out` / `failed`: the raw transcript was used instead.
 */
export type VoiceCleanupAiResult = VoiceCleanupResult

/** Thrown by our own budget timer, so a slow provider is told apart from a broken one. */
class CleanupTimeoutError extends Error {
  override readonly name = 'CleanupTimeoutError'
}

/** The caller aborted the step (the user skipped polishing). */
class CleanupAbortedError extends Error {
  override readonly name = 'AbortError'
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof CleanupTimeoutError) return true
  if (!(error instanceof Error)) return false
  // Provider spawns enforce the same budget and may fire first (SpawnTimeout, "timed out").
  return /time(d)?[\s_-]?out/i.test(`${error.name} ${error.message}`)
}

export interface VoiceCleanupDeps {
  readonly db: DatabaseService | null
  /**
   * Aborting it skips the AI step: the model request is cancelled (its CLI
   * process stopped) and the raw transcript comes back at once, as `skipped`.
   */
  readonly signal?: AbortSignal
  /** Override for tests: the model call itself. */
  readonly runModel?: (
    prompt: string,
    systemPrompt: string,
    settings: VoiceSettings,
    signal?: AbortSignal
  ) => Promise<string | null>
}

/**
 * Wispelker's TranscriptEnhancer: dictionary pre-pass on every path, optional
 * AI cleanup through one of the user's providers, sanitise the output, fall
 * back to the raw transcript when the output looks wrong, dictionary post-pass.
 * Never throws — text always lands. Aborting `deps.signal` skips the AI step
 * (not a failure): the raw transcript, `ai: 'skipped'`, no fallback reason.
 */
export async function enhanceTranscript(
  transcript: string,
  settings: VoiceSettings,
  deps: VoiceCleanupDeps
): Promise<VoiceCleanupOutcome> {
  const replacer = new DictionaryReplacer(settings.dictionary)
  const raw = replacer.apply(transcript.trim())
  if (!settings.cleanup.enabled || raw.length === 0) {
    return {
      text: raw,
      cleaned: false,
      fallbackReason: null,
      ai: settings.cleanup.enabled ? 'not-applicable' : 'disabled'
    }
  }

  const input = raw.length > MAX_TRANSCRIPT_CHARS ? `${raw.slice(0, MAX_TRANSCRIPT_CHARS)}…` : raw
  const systemPrompt = appendVocabulary(
    effectiveCleanupSystemPrompt(settings.cleanup.systemPrompt),
    settings.dictionary
  )
  const prompt = wrapTranscript(input)

  const signal = deps.signal
  const skipped: VoiceCleanupOutcome = {
    text: raw,
    cleaned: false,
    fallbackReason: null,
    ai: 'skipped'
  }
  if (signal?.aborted) return skipped

  const budgetMs = cleanupBudgetMs(settings.cleanup.timeoutSeconds, input.length)
  let output: string | null
  try {
    const run =
      deps.runModel ?? ((p, s, st, sig) => runCleanupModel(p, s, st, deps.db, budgetMs, sig))
    output = await withTimeout(
      run(prompt, systemPrompt, settings, signal),
      budgetMs,
      `AI cleanup did not answer within ${Math.round(budgetMs / 1000)}s`,
      signal
    )
  } catch (error) {
    // A skip is the user's choice, not a provider problem: no warning, no reason.
    if (signal?.aborted) return skipped
    const reason = `provider error: ${error instanceof Error ? error.message : String(error)}`
    log.warn('AI cleanup fell back to raw transcript', { reason })
    return {
      text: raw,
      cleaned: false,
      fallbackReason: reason,
      ai: isTimeoutError(error) ? 'timed-out' : 'failed'
    }
  }

  if (signal?.aborted) return skipped
  const sanitized = sanitizeTranscriptOutput(output ?? '', raw)
  const fallback = cleanupFallbackReason(raw, sanitized)
  if (fallback) {
    const reason = FALLBACK_REASON_DESCRIPTIONS[fallback]
    log.warn('AI cleanup fell back to raw transcript', { reason })
    return { text: raw, cleaned: false, fallbackReason: reason, ai: 'failed' }
  }

  return {
    text: replacer.apply(sanitized),
    cleaned: true,
    fallbackReason: null,
    ai: 'cleaned'
  }
}

export function cleanupBudgetMs(timeoutSeconds: number, transcriptChars: number): number {
  return Math.min(MAX_BUDGET_MS, timeoutSeconds * 1000 + EXTRA_BUDGET_MS_PER_CHAR * transcriptChars)
}

/** Settles with `promise`, or rejects when the budget runs out or `signal` aborts, whichever is first. */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new CleanupAbortedError('AI cleanup skipped'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      reject(new CleanupTimeoutError(message))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

/** How a picked provider/model/effort maps onto an actual one-shot call. */
export interface ResolvedCleanupModel {
  readonly provider: AgentSdkId
  readonly model?: string
  readonly effort?: string
  /** Set when the model belongs to a custom (claude-cli command) provider. */
  readonly customProviderId?: string
}

export function resolveCleanupModel(
  selected: SharedSelectedModel | null,
  customProviderId: string | null | undefined
): ResolvedCleanupModel {
  if (!selected) {
    // No pick: the router's default chain (claude → codex → opencode) with its cheap default models.
    return { provider: 'claude-code', effort: 'low' }
  }
  const effort = selected.variant === 'ultracode' ? 'xhigh' : selected.variant
  if (selected.providerID === CUSTOM_MODEL_PROVIDER_ID && customProviderId) {
    return {
      provider: 'claude-code-cli',
      model: selected.modelID,
      customProviderId,
      ...(effort ? { effort } : {})
    }
  }
  const sdk = selected.agentSdk
  const provider: AgentSdkId =
    sdk === 'codex' ? 'codex' : sdk === 'opencode' ? 'opencode' : 'claude-code'
  const model =
    provider === 'opencode' ? `${selected.providerID}/${selected.modelID}` : selected.modelID
  return { provider, model, ...(effort ? { effort } : {}) }
}

/**
 * The actual model call for the configured provider. Aborting `signal` stops
 * it: the Agent SDK query or CLI process is shut down, not just ignored.
 */
export async function runCleanupModel(
  prompt: string,
  systemPrompt: string,
  settings: VoiceSettings,
  db: DatabaseService | null,
  timeoutMs: number = settings.cleanup.timeoutSeconds * 1000,
  signal?: AbortSignal
): Promise<string | null> {
  const resolved = resolveCleanupModel(settings.cleanup.model, settings.cleanup.customProviderId)

  if (resolved.customProviderId) {
    const provider = getCustomProviderById(db, resolved.customProviderId)
    if (!provider || !provider.command.trim()) {
      throw new Error('the selected custom provider no longer exists')
    }
    const args = [
      '-p',
      '--output-format',
      'text',
      '--system-prompt',
      systemPrompt,
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--tools',
      ''
    ]
    if (resolved.model) args.push('--model', resolved.model)
    if (resolved.effort) args.push('--effort', resolved.effort)
    const spawn = buildCustomProviderShellSpawn(provider.command.trim(), args)
    const env = { ...process.env, ...getUserEnvironmentVariables(db) }
    const stdout = await spawnCLI(
      spawn.command,
      spawn.args,
      prompt,
      timeoutMs,
      undefined,
      env,
      signal
    )
    return stdout.trim() || null
  }

  return generateText(prompt, systemPrompt, resolved.provider, {
    ...(resolved.model ? { modelOverride: resolved.model } : {}),
    effort: resolved.effort ?? 'low',
    timeoutMs,
    maxRetries: 0,
    ...(signal ? { signal } : {})
  })
}
