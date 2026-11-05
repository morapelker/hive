/**
 * Voice engine utility process: hosts the sherpa-onnx recogniser (NVIDIA
 * Parakeet TDT offline, or Nemotron Speech Streaming online; int8) out of the
 * Electron main process. The logic lives in voice-engine-host.ts.
 *
 * Runs via `utilityProcess.fork` (see voice-engine.ts). Bundled as its own
 * entry by electron-vite; `sherpa-onnx-node` stays an external `require` so
 * its prebuilt N-API addon and dylibs load from node_modules. Only worker-only
 * modules may be imported as values here (see voice-windows.ts).
 */
import { VoiceEngineHost, type SherpaModule } from './voice-engine-host'

const parentPort = (process as unknown as { parentPort: Electron.ParentPort }).parentPort

const host = new VoiceEngineHost({
  post: (message) => parentPort.postMessage(message),
  loadSherpa: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('sherpa-onnx-node') as SherpaModule
  },
  exit: () => {
    setTimeout(() => process.exit(0), 50)
  }
})

parentPort.on('message', (event) => host.handle(event.data))
