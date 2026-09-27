import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_SETTINGS,
  findVoiceSpeechModel,
  sanitizeVoiceSettings,
  voiceHistoryPreview
} from './voice'

describe('sanitizeVoiceSettings', () => {
  it('returns defaults for missing or malformed blobs', () => {
    expect(sanitizeVoiceSettings(undefined)).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(sanitizeVoiceSettings('nope')).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(sanitizeVoiceSettings({ enabled: 'yes' }).enabled).toBe(false)
  })

  it('keeps valid values and clamps the rest', () => {
    const result = sanitizeVoiceSettings({
      enabled: true,
      speechModel: 'parakeet-tdt-0.6b-v3',
      hotkey: 'cmd+shift+d',
      sounds: false,
      pauseMediaWhileRecording: false,
      cleanup: {
        enabled: false,
        model: { agentSdk: 'codex', providerID: 'codex', modelID: 'gpt-5.5', variant: 'low' },
        customProviderId: 'p1',
        timeoutSeconds: 99,
        systemPrompt: 'be nice'
      },
      dictionary: [
        'Claude',
        { word: 'Mor', soundsLike: ['moor', ' '], caseSensitive: true },
        { word: '   ' },
        42
      ],
      restoreClipboardDelayMs: 50,
      unloadModelAfterMinutes: -1
    })
    expect(result.enabled).toBe(true)
    expect(result.speechModel).toBe('parakeet-tdt-0.6b-v3')
    expect(result.hotkey).toBe('cmd+shift+d')
    expect(result.sounds).toBe(false)
    expect(result.cleanup.enabled).toBe(false)
    expect(result.cleanup.model).toEqual({
      agentSdk: 'codex',
      providerID: 'codex',
      modelID: 'gpt-5.5',
      variant: 'low'
    })
    expect(result.cleanup.customProviderId).toBe('p1')
    expect(result.cleanup.timeoutSeconds).toBe(30)
    expect(result.cleanup.systemPrompt).toBe('be nice')
    expect(result.dictionary).toEqual([
      { word: 'Claude', soundsLike: [], caseSensitive: false },
      { word: 'Mor', soundsLike: ['moor'], caseSensitive: true }
    ])
    expect(result.restoreClipboardDelayMs).toBe(200)
    expect(result.unloadModelAfterMinutes).toBe(0)
  })

  it('drops unknown speech models and models without ids', () => {
    const result = sanitizeVoiceSettings({
      speechModel: 'whisper',
      cleanup: { model: { providerID: '', modelID: 'x' } }
    })
    expect(result.speechModel).toBe(DEFAULT_VOICE_SETTINGS.speechModel)
    expect(result.cleanup.model).toBeNull()
  })
})

describe('voice helpers', () => {
  it('previews history entries on one line, capped at 60 chars', () => {
    expect(voiceHistoryPreview('  hello\n\nworld\tagain  ')).toBe('hello world again')
    expect(voiceHistoryPreview('a'.repeat(100))).toBe(`${'a'.repeat(60)}…`)
  })

  it('falls back to the first speech model for unknown ids', () => {
    expect(findVoiceSpeechModel('nope').id).toBe('parakeet-tdt-0.6b-v2')
    expect(findVoiceSpeechModel('parakeet-tdt-0.6b-v3').languages).toBe('Multilingual')
  })
})
