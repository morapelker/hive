import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { net } from 'electron'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  findVoiceSpeechModel,
  type VoiceModelState,
  type VoiceSpeechModelId
} from '@shared/types/voice'
import { createLogger } from '../services/logger'
import {
  getVoiceModelDir,
  getVoiceModelsDir,
  voiceModelDownloadUrl,
  voiceModelFilesPresent
} from './voice-paths'

const log = createLogger({ component: 'VoiceModelStore' })

const PROGRESS_INTERVAL_MS = 250

type ProgressListener = (modelId: VoiceSpeechModelId, state: VoiceModelState) => void

interface ActiveDownload {
  readonly controller: AbortController
  readonly promise: Promise<void>
}

interface PartialMeta {
  readonly url: string
  readonly etag: string | null
}

/**
 * Downloads and manages the local Parakeet speech models (~480 MB int8
 * archives from the sherpa-onnx GitHub release). A model is "ready" when its
 * four files are on disk. Downloads resume after an interruption (HTTP Range
 * with If-Range), are verified against a pinned SHA-256, and are extracted into
 * a temporary directory that is renamed into place only once complete.
 */
export class VoiceModelStore {
  private downloads = new Map<VoiceSpeechModelId, ActiveDownload>()
  private progress = new Map<VoiceSpeechModelId, VoiceModelState>()
  private failures = new Map<VoiceSpeechModelId, string>()
  private listeners = new Set<ProgressListener>()

  onChange(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getModelDir(modelId: VoiceSpeechModelId): string {
    return getVoiceModelDir(findVoiceSpeechModel(modelId))
  }

  isReady(modelId: VoiceSpeechModelId): boolean {
    return voiceModelFilesPresent(this.getModelDir(modelId))
  }

  getState(modelId: VoiceSpeechModelId): VoiceModelState {
    const inFlight = this.progress.get(modelId)
    if (inFlight) return inFlight
    if (this.isReady(modelId)) return { status: 'ready' }
    const failure = this.failures.get(modelId)
    if (failure) return { status: 'failed', message: failure }
    return { status: 'not-downloaded' }
  }

  /** Start (or join) the download; resolves when the model is ready. */
  download(modelId: VoiceSpeechModelId): Promise<void> {
    if (this.isReady(modelId)) return Promise.resolve()
    const active = this.downloads.get(modelId)
    if (active) return active.promise

    const controller = new AbortController()
    const promise = this.run(modelId, controller.signal).finally(() => {
      this.downloads.delete(modelId)
    })
    this.downloads.set(modelId, { controller, promise })
    return promise
  }

  cancel(modelId: VoiceSpeechModelId): void {
    this.downloads.get(modelId)?.controller.abort()
  }

  async delete(modelId: VoiceSpeechModelId): Promise<void> {
    this.cancel(modelId)
    const active = this.downloads.get(modelId)
    if (active) await active.promise.catch(() => {})
    const model = findVoiceSpeechModel(modelId)
    await rm(this.getModelDir(modelId), { recursive: true, force: true })
    await rm(join(getVoiceModelsDir(), `${model.archive}.tar.bz2.partial`), { force: true })
    await rm(join(getVoiceModelsDir(), `${model.archive}.tar.bz2.partial.json`), { force: true })
    this.failures.delete(modelId)
    this.emit(modelId)
    log.info('Deleted speech model', { modelId })
  }

  private async run(modelId: VoiceSpeechModelId, signal: AbortSignal): Promise<void> {
    const model = findVoiceSpeechModel(modelId)
    const modelsDir = getVoiceModelsDir()
    const modelDir = getVoiceModelDir(model)
    const archivePath = join(modelsDir, `${model.archive}.tar.bz2.partial`)
    const metaPath = `${archivePath}.json`
    this.failures.delete(modelId)
    this.setProgress(modelId, {
      status: 'downloading',
      phase: 'download',
      receivedBytes: 0,
      totalBytes: model.downloadBytes
    })

    let extractDir: string | null = null
    try {
      await mkdir(modelsDir, { recursive: true })
      await rm(modelDir, { recursive: true, force: true })

      const url = voiceModelDownloadUrl(model)
      await this.fetchArchive(
        url,
        archivePath,
        metaPath,
        model.downloadBytes,
        signal,
        (received) => {
          this.setProgress(modelId, {
            status: 'downloading',
            phase: 'download',
            receivedBytes: received,
            totalBytes: model.downloadBytes
          })
        }
      )
      if (signal.aborted) throw new Error('download cancelled')

      this.setProgress(modelId, {
        status: 'downloading',
        phase: 'verify',
        receivedBytes: model.downloadBytes,
        totalBytes: model.downloadBytes
      })
      const digest = await sha256File(archivePath, signal)
      if (digest !== model.sha256) {
        await rm(archivePath, { force: true })
        await rm(metaPath, { force: true })
        throw new Error('downloaded archive is corrupt (checksum mismatch); please try again')
      }

      this.setProgress(modelId, {
        status: 'downloading',
        phase: 'extract',
        receivedBytes: model.downloadBytes,
        totalBytes: model.downloadBytes
      })
      extractDir = await mkdtemp(join(modelsDir, `.${model.archive}-extract-`))
      await extractTarBz2(archivePath, extractDir, signal)
      if (signal.aborted) throw new Error('download cancelled')

      // The archive contains a single top-level directory named like the archive.
      const extracted = join(extractDir, model.archive)
      if (!voiceModelFilesPresent(extracted)) {
        throw new Error('archive did not contain the expected model files')
      }
      await rm(join(extracted, 'test_wavs'), { recursive: true, force: true })
      await rename(extracted, modelDir)
      await rm(archivePath, { force: true })
      await rm(metaPath, { force: true })
      log.info('Speech model ready', { modelId, modelDir })
    } catch (error) {
      const message = signal.aborted
        ? 'download cancelled'
        : error instanceof Error
          ? error.message
          : String(error)
      log.warn('Speech model download failed', { modelId, error: message })
      if (!signal.aborted) {
        this.failures.set(modelId, `Model download/load failed: ${message}`)
      }
      throw new Error(message)
    } finally {
      if (extractDir) await rm(extractDir, { recursive: true, force: true }).catch(() => {})
      this.progress.delete(modelId)
      this.emit(modelId)
    }
  }

  /** Stream the archive to disk, resuming a previous partial download when the server allows it. */
  private async fetchArchive(
    url: string,
    archivePath: string,
    metaPath: string,
    expectedBytes: number,
    signal: AbortSignal,
    onProgress: (received: number) => void
  ): Promise<void> {
    let offset = 0
    let etag: string | null = null
    if (existsSync(archivePath)) {
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as PartialMeta
        const size = (await stat(archivePath)).size
        if (meta.url === url && size > 0 && size < expectedBytes) {
          offset = size
          etag = meta.etag
        }
      } catch {
        offset = 0
      }
    }
    if (offset === expectedBytes) return
    if (offset === 0) {
      await rm(archivePath, { force: true })
    }

    const headers: Record<string, string> = {}
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`
      if (etag) headers['If-Range'] = etag
    }
    log.info('Downloading speech model archive', { url, offset })
    const response = await net.fetch(url, { headers, signal, redirect: 'follow' })
    if (offset > 0 && response.status === 200) {
      // Range ignored (asset changed or no partial support): start over.
      offset = 0
      await rm(archivePath, { force: true })
    } else if (offset > 0 && response.status !== 206) {
      throw new Error(`download failed with HTTP ${response.status}`)
    } else if (offset === 0 && !response.ok) {
      throw new Error(`download failed with HTTP ${response.status}`)
    }
    if (!response.body) throw new Error('download returned no body')

    await writeFile(
      metaPath,
      JSON.stringify({ url, etag: response.headers.get('etag') } satisfies PartialMeta)
    )

    const file = createWriteStream(archivePath, { flags: offset > 0 ? 'a' : 'w' })
    const reader = response.body.getReader()
    let received = offset
    let lastReport = 0
    try {
      for (;;) {
        if (signal.aborted) throw new Error('download cancelled')
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        received += value.byteLength
        if (!file.write(value)) {
          await new Promise<void>((resolve) => file.once('drain', resolve))
        }
        const now = Date.now()
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now
          onProgress(received)
        }
      }
      onProgress(received)
    } finally {
      await new Promise<void>((resolve, reject) => {
        file.end((error?: Error | null) => (error ? reject(error) : resolve()))
      })
      reader.releaseLock()
    }

    if (received !== expectedBytes) {
      throw new Error(`download incomplete (${received} of ${expectedBytes} bytes)`)
    }
  }

  private setProgress(modelId: VoiceSpeechModelId, state: VoiceModelState): void {
    this.progress.set(modelId, state)
    this.emit(modelId)
  }

  private emit(modelId: VoiceSpeechModelId): void {
    const state = this.getState(modelId)
    for (const listener of this.listeners) {
      try {
        listener(modelId, state)
      } catch (error) {
        log.warn('model store listener failed', { error: String(error) })
      }
    }
  }
}

function sha256File(path: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    const onAbort = (): void => {
      stream.destroy(new Error('download cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    stream.on('end', () => {
      signal.removeEventListener('abort', onAbort)
      resolve(hash.digest('hex'))
    })
  })
}

/** Extract with the system `tar` (bsdtar on macOS/Windows and GNU tar both auto-detect bzip2). */
function extractTarBz2(
  archivePath: string,
  destinationDir: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archivePath, '-C', destinationDir], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const onAbort = (): void => {
      child.kill('SIGTERM')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(`could not run tar: ${error.message}`))
    })
    child.on('exit', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(new Error(`tar exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

export const voiceModelStore = new VoiceModelStore()
