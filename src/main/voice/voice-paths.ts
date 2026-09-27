import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { VoiceSpeechModelInfo } from '@shared/types/voice'

/**
 * Where voice dictation keeps its data. Lives under the shared ~/.hive root
 * (like attachments and logs) rather than Electron's per-instance userData, so
 * every app instance and the backend child see the same model files.
 */
export function getVoiceBaseDir(): string {
  const base = process.env.HIVE_DESKTOP_BASE_DIR ?? join(homedir(), '.hive')
  return join(base, 'voice')
}

export function getVoiceModelsDir(): string {
  return join(getVoiceBaseDir(), 'models')
}

export function getVoiceModelDir(model: VoiceSpeechModelInfo): string {
  return join(getVoiceModelsDir(), model.archive)
}

/** Files every Parakeet TDT int8 archive from sherpa-onnx ships. */
export const VOICE_MODEL_FILES = {
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  joiner: 'joiner.int8.onnx',
  tokens: 'tokens.txt'
} as const

/** The encoder is ~650 MB; anything far smaller is a truncated extraction. */
const MIN_ENCODER_BYTES = 100 * 1024 * 1024

export function voiceModelFilesPresent(modelDir: string): boolean {
  for (const file of Object.values(VOICE_MODEL_FILES)) {
    const path = join(modelDir, file)
    if (!existsSync(path)) return false
    try {
      const size = statSync(path).size
      if (size <= 0) return false
      if (file === VOICE_MODEL_FILES.encoder && size < MIN_ENCODER_BYTES) return false
    } catch {
      return false
    }
  }
  return true
}

export function voiceModelDownloadUrl(model: VoiceSpeechModelInfo): string {
  return `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${model.archive}.tar.bz2`
}
