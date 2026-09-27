import type { SharedSelectedModel } from '../model-resolution'

/**
 * Voice dictation ("Wispelker in the app"): press a hotkey, speak, get the
 * transcript pasted into whatever is focused. Transcription runs fully locally
 * (NVIDIA Parakeet TDT via sherpa-onnx); the optional cleanup pass uses one of
 * the user's own configured agent providers.
 */

export type VoiceSpeechModelId = 'parakeet-tdt-0.6b-v2' | 'parakeet-tdt-0.6b-v3'

export interface VoiceSpeechModelInfo {
  readonly id: VoiceSpeechModelId
  readonly name: string
  readonly description: string
  readonly languages: string
  /** Archive basename on the sherpa-onnx `asr-models` GitHub release (without `.tar.bz2`). */
  readonly archive: string
  /** Exact compressed download size in bytes. */
  readonly downloadBytes: number
  /** SHA-256 of the archive, verified after download. */
  readonly sha256: string
}

export const VOICE_SPEECH_MODELS: readonly VoiceSpeechModelInfo[] = [
  {
    id: 'parakeet-tdt-0.6b-v2',
    name: 'Parakeet TDT 0.6B v2',
    description: 'English only. Best recall for rare and technical words (the Wispelker model).',
    languages: 'English',
    archive: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    downloadBytes: 482_468_385,
    sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad'
  },
  {
    id: 'parakeet-tdt-0.6b-v3',
    name: 'Parakeet TDT 0.6B v3',
    description: 'Multilingual: 25 European languages with automatic language detection.',
    languages: 'Multilingual',
    archive: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    downloadBytes: 487_170_055,
    sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf'
  }
]

export const DEFAULT_VOICE_SPEECH_MODEL: VoiceSpeechModelId = 'parakeet-tdt-0.6b-v2'

export function findVoiceSpeechModel(id: string | null | undefined): VoiceSpeechModelInfo {
  return VOICE_SPEECH_MODELS.find((m) => m.id === id) ?? VOICE_SPEECH_MODELS[0]
}

export interface VoiceDictionaryEntry {
  /** Canonical spelling that must land in the pasted text. */
  word: string
  /** Mishearings that are always rewritten to `word` (case-insensitive). */
  soundsLike: string[]
  /** When true the word itself only matches its exact spelling (no recasing). */
  caseSensitive: boolean
}

export interface VoiceCleanupSettings {
  /** false → the raw local transcript is pasted (dictionary still applies). */
  enabled: boolean
  /** One of the user's providers/models; `variant` is the reasoning effort. null → app default chain. */
  model: SharedSelectedModel | null
  /** Set when `model` belongs to a custom (claude-cli command) provider. */
  customProviderId: string | null
  /** Wall-clock budget for the cleanup call; on timeout the raw transcript is pasted. */
  timeoutSeconds: number
  /** Empty → built-in coding-focused prompt. */
  systemPrompt: string
}

export interface VoiceSettings {
  /** Off by default. Enabling downloads the speech model on first use. */
  enabled: boolean
  speechModel: VoiceSpeechModelId
  /** Wispelker grammar, e.g. "option+space", "cmd+shift+d", "f19". */
  hotkey: string
  /** Feedback sounds when recording starts/stops. */
  sounds: boolean
  /** Pause music/video while recording and resume it afterwards (macOS). */
  pauseMediaWhileRecording: boolean
  cleanup: VoiceCleanupSettings
  dictionary: VoiceDictionaryEntry[]
  /** Delay before the previous clipboard contents are restored after pasting. */
  restoreClipboardDelayMs: number
  /** Free the ~1.4 GB speech model after this many idle minutes; 0 keeps it loaded. */
  unloadModelAfterMinutes: number
}

export const VOICE_DEFAULT_HOTKEY = 'option+space'
export const VOICE_CLEANUP_TIMEOUT_MIN_SECONDS = 3
export const VOICE_CLEANUP_TIMEOUT_MAX_SECONDS = 30
export const VOICE_RESTORE_CLIPBOARD_MIN_MS = 200
export const VOICE_RESTORE_CLIPBOARD_MAX_MS = 5000

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  speechModel: DEFAULT_VOICE_SPEECH_MODEL,
  hotkey: VOICE_DEFAULT_HOTKEY,
  sounds: true,
  pauseMediaWhileRecording: true,
  cleanup: {
    enabled: true,
    model: null,
    customProviderId: null,
    timeoutSeconds: 10,
    systemPrompt: ''
  },
  dictionary: [],
  restoreClipboardDelayMs: 400,
  unloadModelAfterMinutes: 10
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function sanitizeDictionary(value: unknown): VoiceDictionaryEntry[] {
  if (!Array.isArray(value)) return []
  const entries: VoiceDictionaryEntry[] = []
  for (const raw of value) {
    if (typeof raw === 'string') {
      const word = raw.trim()
      if (word) entries.push({ word, soundsLike: [], caseSensitive: false })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const word = typeof record.word === 'string' ? record.word.trim() : ''
    if (!word) continue
    const soundsLike = Array.isArray(record.soundsLike)
      ? record.soundsLike
          .filter((alias): alias is string => typeof alias === 'string')
          .map((alias) => alias.trim())
          .filter((alias) => alias.length > 0)
      : []
    entries.push({ word, soundsLike, caseSensitive: record.caseSensitive === true })
  }
  return entries
}

function sanitizeSelectedModel(value: unknown): SharedSelectedModel | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.providerID !== 'string' || typeof record.modelID !== 'string') return null
  if (!record.providerID.trim() || !record.modelID.trim()) return null
  const model: SharedSelectedModel = { providerID: record.providerID, modelID: record.modelID }
  if (typeof record.agentSdk === 'string' && record.agentSdk) model.agentSdk = record.agentSdk
  if (typeof record.variant === 'string' && record.variant) model.variant = record.variant
  return model
}

/**
 * Deep-merge a persisted (possibly partial or malformed) `voice` settings blob
 * over the defaults. Every field is validated so a hand-edited or pre-feature
 * settings row never yields an invalid runtime configuration.
 */
export function sanitizeVoiceSettings(value: unknown): VoiceSettings {
  const defaults = DEFAULT_VOICE_SETTINGS
  if (!value || typeof value !== 'object') return { ...defaults, cleanup: { ...defaults.cleanup } }
  const record = value as Record<string, unknown>
  const cleanupRaw =
    record.cleanup && typeof record.cleanup === 'object'
      ? (record.cleanup as Record<string, unknown>)
      : {}
  const speechModel = VOICE_SPEECH_MODELS.some((m) => m.id === record.speechModel)
    ? (record.speechModel as VoiceSpeechModelId)
    : defaults.speechModel
  return {
    enabled: record.enabled === true,
    speechModel,
    hotkey:
      typeof record.hotkey === 'string' && record.hotkey.trim() ? record.hotkey : defaults.hotkey,
    sounds: typeof record.sounds === 'boolean' ? record.sounds : defaults.sounds,
    pauseMediaWhileRecording:
      typeof record.pauseMediaWhileRecording === 'boolean'
        ? record.pauseMediaWhileRecording
        : defaults.pauseMediaWhileRecording,
    cleanup: {
      enabled:
        typeof cleanupRaw.enabled === 'boolean' ? cleanupRaw.enabled : defaults.cleanup.enabled,
      model: sanitizeSelectedModel(cleanupRaw.model),
      customProviderId:
        typeof cleanupRaw.customProviderId === 'string' && cleanupRaw.customProviderId
          ? cleanupRaw.customProviderId
          : null,
      timeoutSeconds: clampNumber(
        cleanupRaw.timeoutSeconds,
        VOICE_CLEANUP_TIMEOUT_MIN_SECONDS,
        VOICE_CLEANUP_TIMEOUT_MAX_SECONDS,
        defaults.cleanup.timeoutSeconds
      ),
      systemPrompt: typeof cleanupRaw.systemPrompt === 'string' ? cleanupRaw.systemPrompt : ''
    },
    dictionary: sanitizeDictionary(record.dictionary),
    restoreClipboardDelayMs: clampNumber(
      record.restoreClipboardDelayMs,
      VOICE_RESTORE_CLIPBOARD_MIN_MS,
      VOICE_RESTORE_CLIPBOARD_MAX_MS,
      defaults.restoreClipboardDelayMs
    ),
    unloadModelAfterMinutes: clampNumber(
      record.unloadModelAfterMinutes,
      0,
      24 * 60,
      defaults.unloadModelAfterMinutes
    )
  }
}

/** Speech-model lifecycle as shown in Settings and the header icon tooltip. */
export type VoiceModelState =
  | { readonly status: 'not-downloaded' }
  | {
      readonly status: 'downloading'
      readonly phase: 'download' | 'extract' | 'verify'
      readonly receivedBytes: number
      readonly totalBytes: number | null
    }
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly message: string }

/** What the dictation controller is doing right now. */
export type VoiceDictationState = 'unavailable' | 'idle' | 'recording' | 'processing'

export type VoiceMicPermission = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

/** Snapshot pushed to every renderer window whenever anything changes. */
export interface VoiceStatus {
  readonly enabled: boolean
  readonly state: VoiceDictationState
  readonly model: VoiceModelState
  readonly speechModel: VoiceSpeechModelId
  /** True while the ~1.4 GB recogniser is resident in the engine worker. */
  readonly engineLoaded: boolean
  /** Human-readable hotkey, e.g. "⌥Space"; null when the configured hotkey is invalid. */
  readonly hotkeyDisplay: string | null
  /** Why the hotkey could not be registered, e.g. `unknown hotkey token "banana"`. */
  readonly hotkeyProblem: string | null
  /** "off" or the model name used for AI cleanup. */
  readonly cleanupLabel: string
  readonly micPermission: VoiceMicPermission
  /** Message of the last failed dictation, cleared on the next successful one. */
  readonly lastError: string | null
  /** Set when the user needs to act (e.g. accessibility or permission problems). */
  readonly notice: string | null
}

export interface VoiceHistoryEntry {
  readonly id: string
  /** Final delivered text (after cleanup and dictionary passes). */
  readonly text: string
  /** Local transcript before AI cleanup, when it differs from `text`. */
  readonly rawText: string | null
  /** ISO-8601. */
  readonly createdAt: string
  readonly durationMs: number
  /** True when AI cleanup produced `text` (false when it was skipped or fell back). */
  readonly cleaned: boolean
  /** Speech model id used for this entry. */
  readonly speechModel: string
}

export const VOICE_HISTORY_MENU_LIMIT = 20

/** Collapse whitespace to single spaces and cap the length for menu previews. */
export function voiceHistoryPreview(text: string, maxLength = 60): string {
  const collapsed = text.split(/\s+/).filter(Boolean).join(' ')
  const chars = Array.from(collapsed)
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : collapsed
}

/** Phases of the floating recording pill (mirrors Wispelker's RecordingWidgetModel). */
export type VoiceHudPhase =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'recording' }
  | {
      readonly kind: 'transcribing'
      readonly progress: number | null
      readonly showsProgress: boolean
    }
  | {
      readonly kind: 'enhancing'
      readonly progress: number | null
      readonly showsProgress: boolean
    }
  | { readonly kind: 'notice'; readonly text: string }

export interface VoiceHudState {
  readonly phase: VoiceHudPhase
  /** Feedback sound to play in the HUD on platforms without system sounds. */
  readonly sounds: boolean
}

/** Result of a completed dictation, pushed to the renderer for toasts/history refresh. */
export interface VoiceDictationResult {
  readonly entry: VoiceHistoryEntry
  readonly delivery: 'pasted' | 'copied'
  readonly cleanupFallbackReason: string | null
}
