/**
 * Messages between the Electron main process and the voice engine utility
 * process (`voice-engine-worker.ts`). The worker owns the ~1.4 GB sherpa-onnx
 * recogniser so it can be killed to free memory and a native crash never takes
 * the whole app down.
 */

export interface VoiceEngineLoadRequest {
  readonly type: 'load'
  readonly id: string
  readonly modelDir: string
  readonly numThreads: number
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

export type VoiceEngineRequest =
  VoiceEngineLoadRequest | VoiceEngineTranscribeRequest | VoiceEngineUnloadRequest

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

export interface VoiceEngineErrorResponse {
  readonly type: 'error'
  readonly id: string
  readonly message: string
}

export type VoiceEngineResponse =
  | VoiceEngineLoadedResponse
  | VoiceEngineResultResponse
  | VoiceEngineUnloadedResponse
  | VoiceEngineErrorResponse

export function isVoiceEngineResponse(value: unknown): value is VoiceEngineResponse {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    (record.type === 'loaded' ||
      record.type === 'result' ||
      record.type === 'unloaded' ||
      record.type === 'error')
  )
}
