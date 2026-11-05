import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '@shared/types/voice'

const providers = vi.hoisted(() => ({
  generateText: vi.fn(async () => 'Cleaned.'),
  spawnCLI: vi.fn(async () => 'Cleaned.'),
  getCustomProviderById: vi.fn(() => ({ id: 'provider-1', command: 'glm-claude' }))
}))
vi.mock('../services/text-generation-router', () => ({ generateText: providers.generateText }))
vi.mock('../services/title-generation-shared', () => ({ spawnCLI: providers.spawnCLI }))
vi.mock('../services/custom-providers', () => ({
  getCustomProviderById: providers.getCustomProviderById
}))
vi.mock('../services/env-vars', () => ({ getUserEnvironmentVariables: () => ({}) }))

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../services/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/logger')>()),
  createLogger: () => logger
}))

import {
  cleanupBudgetMs,
  enhanceTranscript,
  resolveCleanupModel,
  runCleanupModel
} from './voice-cleanup'

const settings = (overrides: Partial<VoiceSettings> = {}): VoiceSettings => ({
  ...DEFAULT_VOICE_SETTINGS,
  ...overrides,
  cleanup: { ...DEFAULT_VOICE_SETTINGS.cleanup, ...(overrides.cleanup ?? {}) }
})

describe('enhanceTranscript', () => {
  it('returns the dictionary-corrected raw transcript when cleanup is off', async () => {
    const runModel = vi.fn()
    const outcome = await enhanceTranscript(
      'hey moor claude broke the build',
      settings({
        cleanup: { ...DEFAULT_VOICE_SETTINGS.cleanup, enabled: false },
        dictionary: [
          { word: 'Mor', soundsLike: ['moor'], caseSensitive: false },
          { word: 'Claude', soundsLike: [], caseSensitive: false }
        ]
      }),
      { db: null, runModel }
    )
    expect(outcome).toEqual({
      text: 'hey Mor Claude broke the build',
      cleaned: false,
      fallbackReason: null,
      ai: 'disabled'
    })
    expect(runModel).not.toHaveBeenCalled()
  })

  it('short-circuits an empty transcript', async () => {
    const runModel = vi.fn()
    const outcome = await enhanceTranscript('   ', settings(), { db: null, runModel })
    expect(outcome.text).toBe('')
    expect(outcome.ai).toBe('not-applicable')
    expect(runModel).not.toHaveBeenCalled()
  })

  it('uses the model output after sanitising and re-applies the dictionary', async () => {
    const runModel = vi.fn(async () => '"Hey moor, fix the bug."')
    const outcome = await enhanceTranscript(
      'hey moor fix the bug',
      settings({ dictionary: [{ word: 'Mor', soundsLike: ['moor'], caseSensitive: false }] }),
      { db: null, runModel }
    )
    expect(outcome).toEqual({
      text: 'Hey Mor, fix the bug.',
      cleaned: true,
      fallbackReason: null,
      ai: 'cleaned'
    })
    const [prompt, systemPrompt] = runModel.mock.calls[0] as unknown as [string, string]
    expect(prompt).toContain('<transcript>\nhey Mor fix the bug\n</transcript>')
    expect(systemPrompt).toContain('VOCABULARY')
    expect(systemPrompt).toContain('Mor (may be misheard as: moor)')
  })

  it('falls back to the raw transcript when the provider fails', async () => {
    const outcome = await enhanceTranscript('fix the bug', settings(), {
      db: null,
      runModel: async () => {
        throw new Error('gateway returned 502')
      }
    })
    expect(outcome.text).toBe('fix the bug')
    expect(outcome.cleaned).toBe(false)
    expect(outcome.fallbackReason).toContain('provider error: gateway returned 502')
    expect(outcome.ai).toBe('failed')
  })

  it('reports a provider-side timeout as timed out, not failed', async () => {
    const outcome = await enhanceTranscript('fix the bug', settings(), {
      db: null,
      runModel: async () => {
        throw new Error('claude timed out after 10000ms')
      }
    })
    expect(outcome.cleaned).toBe(false)
    expect(outcome.ai).toBe('timed-out')
  })

  it('falls back when the model answers instead of cleaning', async () => {
    const outcome = await enhanceTranscript('fix the bug', settings(), {
      db: null,
      runModel: async () => "I'm sorry, I can't help with that"
    })
    expect(outcome.cleaned).toBe(false)
    expect(outcome.fallbackReason).toBe('output looks like an assistant reply')
    expect(outcome.ai).toBe('failed')
  })

  it('times out slow providers within the budget', async () => {
    vi.useFakeTimers()
    try {
      const pending = enhanceTranscript(
        'fix the bug',
        settings({ cleanup: { ...DEFAULT_VOICE_SETTINGS.cleanup, timeoutSeconds: 3 } }),
        { db: null, runModel: () => new Promise(() => {}) }
      )
      await vi.advanceTimersByTimeAsync(cleanupBudgetMs(3, 'fix the bug'.length) + 10)
      const outcome = await pending
      expect(outcome.cleaned).toBe(false)
      expect(outcome.fallbackReason).toMatch(/did not answer within/)
      expect(outcome.ai).toBe('timed-out')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('enhanceTranscript skipped by the caller (VOICE-08)', () => {
  const DICTIONARY = { dictionary: [{ word: 'Mor', soundsLike: ['moor'], caseSensitive: false }] }

  it('settles at once with the shown raw text when the signal aborts mid-request, and stops the request', async () => {
    logger.warn.mockClear()
    const abort = new AbortController()
    let modelSignal: AbortSignal | undefined
    const runModel = vi.fn((_p: string, _s: string, _st: VoiceSettings, signal?: AbortSignal) => {
      modelSignal = signal
      return new Promise<string | null>(() => {})
    })
    const pending = enhanceTranscript('hey moor fix the bug', settings(DICTIONARY), {
      db: null,
      signal: abort.signal,
      runModel
    })
    await Promise.resolve()
    abort.abort()

    expect(await pending).toEqual({
      text: 'hey Mor fix the bug',
      cleaned: false,
      fallbackReason: null,
      ai: 'skipped'
    })
    // The model call got the same signal, so the provider can stop its process.
    expect(modelSignal).toBe(abort.signal)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('reports a provider that rejects because of the abort as skipped, not failed', async () => {
    const abort = new AbortController()
    const outcome = await enhanceTranscript('fix the bug', settings(), {
      db: null,
      signal: abort.signal,
      runModel: async () => {
        abort.abort()
        throw Object.assign(new Error('AI generation was cancelled'), { name: 'AbortError' })
      }
    })
    expect(outcome).toMatchObject({ ai: 'skipped', fallbackReason: null, cleaned: false })
  })

  it('never calls the model when already skipped', async () => {
    const abort = new AbortController()
    abort.abort()
    const runModel = vi.fn()
    const outcome = await enhanceTranscript('fix the bug', settings(), {
      db: null,
      signal: abort.signal,
      runModel
    })
    expect(outcome.ai).toBe('skipped')
    expect(runModel).not.toHaveBeenCalled()
  })

  it('ignores a model answer that lands after the skip', async () => {
    const abort = new AbortController()
    const outcome = await enhanceTranscript('fix the bug', settings(), {
      db: null,
      signal: abort.signal,
      runModel: async () => {
        abort.abort()
        return 'Fix the bug.'
      }
    })
    expect(outcome).toMatchObject({ text: 'fix the bug', ai: 'skipped', cleaned: false })
  })

  it('still times out as before when nobody skips', async () => {
    vi.useFakeTimers()
    try {
      const pending = enhanceTranscript(
        'fix the bug',
        settings({ cleanup: { ...DEFAULT_VOICE_SETTINGS.cleanup, timeoutSeconds: 3 } }),
        { db: null, signal: new AbortController().signal, runModel: () => new Promise(() => {}) }
      )
      await vi.advanceTimersByTimeAsync(cleanupBudgetMs(3, 'fix the bug'.length) + 10)
      const outcome = await pending
      expect(outcome.ai).toBe('timed-out')
      expect(outcome.fallbackReason).toMatch(/did not answer within/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runCleanupModel cancellation', () => {
  it('hands the signal to the provider router (Agent SDK query / CLI process)', async () => {
    const abort = new AbortController()
    await runCleanupModel('p', 's', settings(), null, 5_000, abort.signal)
    expect(providers.generateText).toHaveBeenCalledWith(
      'p',
      's',
      'claude-code',
      expect.objectContaining({ signal: abort.signal, timeoutMs: 5_000, maxRetries: 0 })
    )
  })

  it('hands the signal to the custom provider command, so its process group is stopped', async () => {
    const abort = new AbortController()
    await runCleanupModel(
      'p',
      's',
      settings({
        cleanup: {
          ...DEFAULT_VOICE_SETTINGS.cleanup,
          model: {
            agentSdk: 'claude-code-cli',
            providerID: 'custom',
            modelID: 'glm-4.6',
            variant: 'low'
          },
          customProviderId: 'provider-1'
        }
      }),
      null,
      5_000,
      abort.signal
    )
    const call = providers.spawnCLI.mock.calls.at(-1) as unknown as unknown[]
    expect(call[3]).toBe(5_000)
    expect(call[6]).toBe(abort.signal)
  })
})

describe('cleanupBudgetMs', () => {
  it('scales with transcript length and caps at a minute', () => {
    expect(cleanupBudgetMs(10, 0)).toBe(10_000)
    expect(cleanupBudgetMs(10, 100)).toBe(14_000)
    expect(cleanupBudgetMs(30, 5000)).toBe(60_000)
  })
})

describe('resolveCleanupModel', () => {
  it('uses the default chain when nothing is picked', () => {
    expect(resolveCleanupModel(null, null)).toEqual({ provider: 'claude-code', effort: 'low' })
  })

  it('maps SDK picks to the router, with opencode models fully qualified', () => {
    expect(
      resolveCleanupModel(
        { agentSdk: 'codex', providerID: 'codex', modelID: 'gpt-5.5', variant: 'low' },
        null
      )
    ).toEqual({ provider: 'codex', model: 'gpt-5.5', effort: 'low' })
    expect(
      resolveCleanupModel(
        { agentSdk: 'opencode', providerID: 'anthropic', modelID: 'claude-haiku', variant: 'high' },
        null
      )
    ).toEqual({ provider: 'opencode', model: 'anthropic/claude-haiku', effort: 'high' })
    expect(
      resolveCleanupModel(
        {
          agentSdk: 'claude-code-cli',
          providerID: 'anthropic',
          modelID: 'haiku',
          variant: 'ultracode'
        },
        null
      )
    ).toEqual({ provider: 'claude-code', model: 'haiku', effort: 'xhigh' })
  })

  it('routes custom providers to the claude-cli command path', () => {
    expect(
      resolveCleanupModel(
        {
          agentSdk: 'claude-code-cli',
          providerID: 'custom',
          modelID: 'glm-4.6',
          variant: 'medium'
        },
        'provider-1'
      )
    ).toEqual({
      provider: 'claude-code-cli',
      model: 'glm-4.6',
      customProviderId: 'provider-1',
      effort: 'medium'
    })
  })
})
