/**
 * Messages between the Electron main process and the voice engine utility
 * process (`voice-engine-worker.ts`). The worker owns the ~1.4 GB sherpa-onnx
 * recogniser so it can be killed to free memory and a native crash never takes
 * the whole app down.
 *
 * The worker may only `import type` from this file: a value import would put
 * this module in a chunk shared with the main bundle, and the worker bundle is
 * unpacked from the asar on its own (see voice-windows.ts).
 */

export interface VoiceEngineLoadRequest {
  readonly type: 'load'
  readonly id: string
  readonly modelDir: string
  readonly numThreads: number
  /**
   * From the speech-model catalog: true loads an online (streaming)
   * transducer, false an offline one. Loading a model as the wrong kind kills
   * the worker natively, so the main process always decides this.
   */
  readonly streaming: boolean
}

export interface VoiceEngineTranscribeRequest {
  readonly type: 'transcribe'
  readonly id: string
  /** Mono PCM in [-1, 1]. Any sample rate; the recogniser resamples to 16 kHz. */
  readonly samples: Float32Array
  readonly sampleRate: number
}

export interface VoiceEngineUnloadRequest {
  readonly type: 'unload'
  readonly id: string
}

/**
 * Open a streaming session (streaming models only). Any leftover session is
 * dropped first: there is at most one at a time. Answered by `stream-started`.
 */
export interface VoiceEngineStreamStartRequest {
  readonly type: 'stream-start'
  readonly id: string
  readonly sessionId: string
  /** Fixed for the whole session: the recogniser cannot change rate mid-stream. */
  readonly sampleRate: number
}

/** Audio for the open session, in order. Fire-and-forget; failures arrive as `stream-error`. */
export interface VoiceEngineStreamAudioRequest {
  readonly type: 'stream-audio'
  readonly sessionId: string
  /** Mono PCM in [-1, 1] at the session's sample rate. Any length. */
  readonly samples: Float32Array
}

/** Flush the session and return its final transcript. Answered by `stream-result`. */
export interface VoiceEngineStreamFinishRequest {
  readonly type: 'stream-finish'
  readonly id: string
  readonly sessionId: string
}

/** Drop the session without a result. Fire-and-forget; unknown ids are ignored. */
export interface VoiceEngineStreamCancelRequest {
  readonly type: 'stream-cancel'
  readonly sessionId: string
}

export type VoiceEngineRequest =
  | VoiceEngineLoadRequest
  | VoiceEngineTranscribeRequest
  | VoiceEngineUnloadRequest
  | VoiceEngineStreamStartRequest
  | VoiceEngineStreamAudioRequest
  | VoiceEngineStreamFinishRequest
  | VoiceEngineStreamCancelRequest

export interface VoiceEngineLoadedResponse {
  readonly type: 'loaded'
  readonly id: string
  readonly loadMs: number
  readonly version: string
}

export interface VoiceEngineResultResponse {
  readonly type: 'result'
  readonly id: string
  readonly text: string
  readonly decodeMs: number
}

export interface VoiceEngineUnloadedResponse {
  readonly type: 'unloaded'
  readonly id: string
}

export interface VoiceEngineStreamStartedResponse {
  readonly type: 'stream-started'
  readonly id: string
  readonly sessionId: string
}

export interface VoiceEngineStreamResultResponse {
  readonly type: 'stream-result'
  readonly id: string
  readonly sessionId: string
  readonly text: string
  /** Worker time spent flushing (tail padding + final decodes). */
  readonly finishMs: number
  /** Model decode steps the flush needed (1–2 normally; more means the worker fell behind). */
  readonly finishDecodes: number
  /** Audio received for the session, excluding the engine's own padding. */
  readonly audioMs: number
  /** Total worker time spent decoding this session, including the flush. */
  readonly busyMs: number
}

export interface VoiceEngineErrorResponse {
  readonly type: 'error'
  readonly id: string
  readonly message: string
}

export type VoiceEngineResponse =
  | VoiceEngineLoadedResponse
  | VoiceEngineResultResponse
  | VoiceEngineUnloadedResponse
  | VoiceEngineStreamStartedResponse
  | VoiceEngineStreamResultResponse
  | VoiceEngineErrorResponse

/** Unsolicited: the session's transcript changed. Always the full text so far. */
export interface VoiceEngineStreamPartialEvent {
  readonly type: 'stream-partial'
  readonly sessionId: string
  readonly text: string
}

/** Unsolicited: the session failed and was dropped; a later finish reports the same error. */
export interface VoiceEngineStreamErrorEvent {
  readonly type: 'stream-error'
  readonly sessionId: string
  readonly message: string
}

export type VoiceEngineEvent = VoiceEngineStreamPartialEvent | VoiceEngineStreamErrorEvent

export type VoiceEngineMessage = VoiceEngineResponse | VoiceEngineEvent

const RESPONSE_TYPES = new Set<string>([
  'loaded',
  'result',
  'unloaded',
  'stream-started',
  'stream-result',
  'error'
])

export function isVoiceEngineResponse(value: unknown): value is VoiceEngineResponse {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.type === 'string' &&
    RESPONSE_TYPES.has(record.type)
  )
}

export function isVoiceEngineEvent(value: unknown): value is VoiceEngineEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.sessionId !== 'string') return false
  if (record.type === 'stream-partial') return typeof record.text === 'string'
  if (record.type === 'stream-error') return typeof record.message === 'string'
  return false
}
