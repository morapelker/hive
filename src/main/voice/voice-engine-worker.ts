/**
 * Voice engine utility process: hosts the sherpa-onnx offline recogniser
 * (NVIDIA Parakeet TDT, int8) out of the Electron main process.
 *
 * Runs via `utilityProcess.fork` (see voice-engine.ts). Bundled as its own
 * entry by electron-vite; `sherpa-onnx-node` stays an external `require` so
 * its prebuilt N-API addon and dylibs load from node_modules.
 */
import { join } from 'path'
import { splitIntoWindows } from './voice-windows'
import type { VoiceEngineRequest, VoiceEngineResponse } from './voice-engine-protocol'

interface SherpaOfflineStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
}

interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream
  decodeAsync(stream: SherpaOfflineStream): Promise<{ text: string }>
}

interface SherpaModule {
  version: string
  OfflineRecognizer: {
    createAsync(config: unknown): Promise<SherpaOfflineRecognizer>
  }
}

const parentPort = (process as unknown as { parentPort: Electron.ParentPort }).parentPort

let sherpa: SherpaModule | null = null
let recognizer: SherpaOfflineRecognizer | null = null
let loadedModelDir: string | null = null

function post(message: VoiceEngineResponse): void {
  parentPort.postMessage(message)
}

function loadSherpa(): SherpaModule {
  if (!sherpa) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require('sherpa-onnx-node') as SherpaModule
  }
  return sherpa
}

async function handleLoad(id: string, modelDir: string, numThreads: number): Promise<void> {
  const started = Date.now()
  if (recognizer && loadedModelDir === modelDir) {
    post({ type: 'loaded', id, loadMs: 0, version: loadSherpa().version })
    return
  }
  const module = loadSherpa()
  recognizer = null
  loadedModelDir = null
  const created = await module.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(modelDir, 'encoder.int8.onnx'),
        decoder: join(modelDir, 'decoder.int8.onnx'),
        joiner: join(modelDir, 'joiner.int8.onnx')
      },
      tokens: join(modelDir, 'tokens.txt'),
      numThreads: Math.max(1, Math.min(8, Math.round(numThreads))),
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer'
    },
    decodingMethod: 'greedy_search'
  })
  recognizer = created
  loadedModelDir = modelDir
  post({ type: 'loaded', id, loadMs: Date.now() - started, version: module.version })
}

async function handleTranscribe(
  id: string,
  samples: Float32Array,
  sampleRate: number
): Promise<void> {
  if (!recognizer) {
    throw new Error('Speech model is not loaded')
  }
  const started = Date.now()
  const parts: string[] = []
  for (const window of splitIntoWindows(samples, sampleRate)) {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples: window, sampleRate })
    const result = await recognizer.decodeAsync(stream)
    const text = (result.text ?? '').trim()
    if (text) parts.push(text)
  }
  post({
    type: 'result',
    id,
    text: parts.join(' '),
    decodeMs: Date.now() - started
  })
}

parentPort.on('message', (event) => {
  const message = event.data as VoiceEngineRequest
  if (!message || typeof message !== 'object' || typeof message.id !== 'string') return

  const run = async (): Promise<void> => {
    switch (message.type) {
      case 'load':
        await handleLoad(message.id, message.modelDir, message.numThreads)
        return
      case 'transcribe': {
        // Structured clone delivers a Float32Array; guard against plain objects
        // from a mismatched build so the native addon never sees garbage.
        const samples =
          message.samples instanceof Float32Array
            ? message.samples
            : Float32Array.from(message.samples as ArrayLike<number>)
        await handleTranscribe(message.id, samples, message.sampleRate)
        return
      }
      case 'unload':
        recognizer = null
        loadedModelDir = null
        post({ type: 'unloaded', id: message.id })
        // The parent kills the process afterwards; exiting here frees the
        // native memory immediately even if it does not.
        setTimeout(() => process.exit(0), 50)
        return
    }
  }

  run().catch((error: unknown) => {
    post({
      type: 'error',
      id: message.id,
      message: error instanceof Error ? error.message : String(error)
    })
  })
})
