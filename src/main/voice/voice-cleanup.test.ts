import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '@shared/types/voice'
import { cleanupBudgetMs, enhanceTranscript, resolveCleanupModel } from './voice-cleanup'

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
      fallbackReason: null
    })
    expect(runModel).not.toHaveBeenCalled()
  })

  it('short-circuits an empty transcript', async () => {
    const runModel = vi.fn()
    const outcome = await enhanceTranscript('   ', settings(), { db: null, runModel })
    expect(outcome.text).toBe('')
    expect(runModel).not.toHaveBeenCalled()
  })

  it('uses the model output after sanitising and re-applies the dictionary', async () => {
    const runModel = vi.fn(async () => '"Hey moor, fix the bug."')
    const outcome = await enhanceTranscript(
      'hey moor fix the bug',
      settings({ dictionary: [{ word: 'Mor', soundsLike: ['moor'], caseSensitive: false }] }),
      { db: null, runModel }
    )
    expect(outcome).toEqual({ text: 'Hey Mor, fix the bug.', cleaned: true, fallbackReason: null })
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
  })

  it('falls back when the model answers instead of cleaning', async () => {
    const outcome = await enhanceTranscript('fix the bug', settings(), {
      db: null,
      runModel: async () => "I'm sorry, I can't help with that"
    })
    expect(outcome.cleaned).toBe(false)
    expect(outcome.fallbackReason).toBe('output looks like an assistant reply')
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
    } finally {
      vi.useRealTimers()
    }
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
