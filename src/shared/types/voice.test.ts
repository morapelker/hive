import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VOICE_SETTINGS,
  DEFAULT_VOICE_SPEECH_MODEL,
  LEGACY_VOICE_SPEECH_MODEL,
  VOICE_SPEECH_MODELS,
  VOICE_AUDIO_CHUNK_MAX_SAMPLES,
  findVoiceSpeechModel,
  migrateVoiceSpeechModelDefault,
  sanitizeVoiceAudioChunk,
  sanitizeVoiceSettings,
  shouldSuggestStreamingModel,
  voiceHistoryPreview,
  type VoiceSettings
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
    expect(result.speechModel).toBe(LEGACY_VOICE_SPEECH_MODEL)
    expect(result.cleanup.model).toBeNull()
  })

  it('keeps the Nemotron streaming model id', () => {
    const result = sanitizeVoiceSettings({ speechModel: 'nemotron-speech-streaming-en-0.6b' })
    expect(result.speechModel).toBe('nemotron-speech-streaming-en-0.6b')
  })

  it('makes the streaming model the default for new setups only', () => {
    expect(DEFAULT_VOICE_SPEECH_MODEL).toBe('nemotron-speech-streaming-en-0.6b')
    expect(findVoiceSpeechModel(DEFAULT_VOICE_SPEECH_MODEL).streaming).toBe(true)
    expect(DEFAULT_VOICE_SETTINGS.speechModel).toBe('nemotron-speech-streaming-en-0.6b')
    // No voice settings saved yet.
    expect(sanitizeVoiceSettings(undefined).speechModel).toBe('nemotron-speech-streaming-en-0.6b')
    expect(sanitizeVoiceSettings(null).speechModel).toBe('nemotron-speech-streaming-en-0.6b')
    // A saved blob without a valid model meant the old default.
    expect(sanitizeVoiceSettings({}).speechModel).toBe('parakeet-tdt-0.6b-v2')
    expect(sanitizeVoiceSettings({ speechModel: 'nemotron' }).speechModel).toBe(
      'parakeet-tdt-0.6b-v2'
    )
  })

  it('keeps an existing Parakeet v2 profile as it was', () => {
    const saved = { enabled: true, speechModel: 'parakeet-tdt-0.6b-v2', hotkey: 'f19' }
    const result = sanitizeVoiceSettings(saved)
    expect(result.speechModel).toBe('parakeet-tdt-0.6b-v2')
    expect(result.enabled).toBe(true)
    expect(result.streamingSuggestionDismissed).toBe(false)
  })

  it('marks the default check as done for new setups and pending for older blobs', () => {
    expect(sanitizeVoiceSettings(undefined).speechModelDefaultMigrated).toBe(true)
    expect(sanitizeVoiceSettings(DEFAULT_VOICE_SETTINGS).speechModelDefaultMigrated).toBe(true)
    expect(
      sanitizeVoiceSettings({ speechModel: 'parakeet-tdt-0.6b-v2' }).speechModelDefaultMigrated
    ).toBe(false)
    expect(
      sanitizeVoiceSettings({ speechModelDefaultMigrated: 'yes' }).speechModelDefaultMigrated
    ).toBe(false)
  })

  it('keeps a dismissed streaming suggestion dismissed', () => {
    expect(
      sanitizeVoiceSettings({ streamingSuggestionDismissed: true }).streamingSuggestionDismissed
    ).toBe(true)
    expect(
      sanitizeVoiceSettings({ streamingSuggestionDismissed: 1 }).streamingSuggestionDismissed
    ).toBe(false)
    expect(DEFAULT_VOICE_SETTINGS.streamingSuggestionDismissed).toBe(false)
  })
})

describe('migrateVoiceSpeechModelDefault', () => {
  /** An existing profile saved before the streaming default (no marker yet). */
  const legacy = (partial: Partial<VoiceSettings> = {}): VoiceSettings => ({
    ...sanitizeVoiceSettings({ speechModel: 'parakeet-tdt-0.6b-v2' }),
    ...partial
  })
  const nothingOnDisk = (): boolean => false
  const v2OnDisk = (id: string): boolean => id === 'parakeet-tdt-0.6b-v2'

  it('moves a profile that never used voice to the streaming model', () => {
    const result = migrateVoiceSpeechModelDefault(legacy(), nothingOnDisk)
    expect(result).toEqual({
      settings: {
        ...legacy(),
        speechModel: 'nemotron-speech-streaming-en-0.6b',
        speechModelDefaultMigrated: true
      },
      switched: true
    })
  })

  it('keeps Parakeet v2 when any of it is on disk, even with voice off', () => {
    const result = migrateVoiceSpeechModelDefault(legacy(), v2OnDisk)
    expect(result?.switched).toBe(false)
    expect(result?.settings.speechModel).toBe('parakeet-tdt-0.6b-v2')
    expect(result?.settings.speechModelDefaultMigrated).toBe(true)
  })

  it('keeps the model of anyone with voice on, whatever is on disk', () => {
    const result = migrateVoiceSpeechModelDefault(legacy({ enabled: true }), nothingOnDisk)
    expect(result?.switched).toBe(false)
    expect(result?.settings).toEqual({
      ...legacy({ enabled: true }),
      speechModelDefaultMigrated: true
    })
  })

  it('keeps a model the user picked other than the old default', () => {
    const v3 = legacy({ speechModel: 'parakeet-tdt-0.6b-v3' })
    expect(migrateVoiceSpeechModelDefault(v3, nothingOnDisk)?.settings.speechModel).toBe(
      'parakeet-tdt-0.6b-v3'
    )
  })

  it('runs once: nothing to do once marked, or for new setups', () => {
    const hasLocalFiles = vi.fn(() => false)
    const once = migrateVoiceSpeechModelDefault(legacy({ enabled: true }), hasLocalFiles)
    expect(once).not.toBeNull()
    // Voice later turned off with the files deleted: the user's choice stands.
    const later = { ...once!.settings, enabled: false }
    expect(migrateVoiceSpeechModelDefault(later, hasLocalFiles)).toBeNull()
    expect(migrateVoiceSpeechModelDefault(DEFAULT_VOICE_SETTINGS, hasLocalFiles)).toBeNull()
  })
})

describe('shouldSuggestStreamingModel', () => {
  const on = { ...DEFAULT_VOICE_SETTINGS, enabled: true }

  it('suggests switching only to Parakeet v2 users with voice on who have not dismissed it', () => {
    expect(shouldSuggestStreamingModel({ ...on, speechModel: 'parakeet-tdt-0.6b-v2' })).toBe(true)
    expect(shouldSuggestStreamingModel({ ...on, speechModel: 'parakeet-tdt-0.6b-v3' })).toBe(false)
    expect(shouldSuggestStreamingModel(on)).toBe(false)
    expect(
      shouldSuggestStreamingModel({
        ...on,
        speechModel: 'parakeet-tdt-0.6b-v2',
        streamingSuggestionDismissed: true
      })
    ).toBe(false)
    expect(
      shouldSuggestStreamingModel({ ...on, enabled: false, speechModel: 'parakeet-tdt-0.6b-v2' })
    ).toBe(false)
  })
})

describe('speech model catalog', () => {
  it('lists Parakeet v2, Parakeet v3 and the Nemotron streaming model, in that order', () => {
    expect(VOICE_SPEECH_MODELS.map((m) => m.id)).toEqual([
      'parakeet-tdt-0.6b-v2',
      'parakeet-tdt-0.6b-v3',
      'nemotron-speech-streaming-en-0.6b'
    ])
  })

  it('keeps the Parakeet entries unchanged and offline', () => {
    expect(findVoiceSpeechModel('parakeet-tdt-0.6b-v2')).toMatchObject({
      archive: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
      downloadBytes: 482_468_385,
      sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
      languages: 'English',
      streaming: false
    })
    expect(findVoiceSpeechModel('parakeet-tdt-0.6b-v3')).toMatchObject({
      archive: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
      downloadBytes: 487_170_055,
      sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
      languages: 'Multilingual',
      streaming: false
    })
  })

  it('pins the Nemotron streaming archive and marks it as streaming', () => {
    const model = findVoiceSpeechModel('nemotron-speech-streaming-en-0.6b')
    expect(model).toMatchObject({
      id: 'nemotron-speech-streaming-en-0.6b',
      archive: 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25',
      downloadBytes: 463_945_051,
      sha256: '78e2b79fcf7271553a74402a76b771b09ea40117a39566a79f52235b23db6358',
      languages: 'English',
      streaming: true
    })
    expect(model.description).toMatch(/live preview/i)
  })

  it('has unique ids and archives and well-formed checksums', () => {
    expect(new Set(VOICE_SPEECH_MODELS.map((m) => m.id)).size).toBe(VOICE_SPEECH_MODELS.length)
    expect(new Set(VOICE_SPEECH_MODELS.map((m) => m.archive)).size).toBe(VOICE_SPEECH_MODELS.length)
    for (const model of VOICE_SPEECH_MODELS) {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(model.downloadBytes).toBeGreaterThan(100 * 1024 * 1024)
    }
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

describe('sanitizeVoiceAudioChunk', () => {
  const good = { streamId: 3, seq: 0, samples: new Float32Array(1536), sampleRate: 16000 }

  it('keeps a well-formed chunk as is', () => {
    expect(sanitizeVoiceAudioChunk(good)).toEqual(good)
    expect(sanitizeVoiceAudioChunk(good)?.samples).toBe(good.samples)
  })

  it('rejects anything else', () => {
    for (const raw of [
      null,
      'chunk',
      { ...good, streamId: '3' },
      { ...good, streamId: 1.5 },
      { ...good, seq: -1 },
      { ...good, seq: Number.NaN },
      { ...good, samples: Array.from(good.samples) },
      { ...good, samples: new Float64Array(4) },
      { ...good, samples: new Float32Array(0) },
      { ...good, samples: new Float32Array(VOICE_AUDIO_CHUNK_MAX_SAMPLES + 1) },
      { ...good, sampleRate: 0 },
      { ...good, sampleRate: Number.POSITIVE_INFINITY }
    ]) {
      expect(sanitizeVoiceAudioChunk(raw)).toBeNull()
    }
  })
})
