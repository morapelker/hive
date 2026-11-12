import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceModelState, VoiceSpeechModelInfo } from '@shared/types/voice'

/**
 * Runs the real model store (Range resume, SHA-256 check, tar extraction,
 * "ready" detection) against a local HTTP server that serves a tiny archive
 * laid out exactly like the sherpa-onnx release archives.
 */

const fixture = vi.hoisted(() => ({
  url: '',
  downloadBytes: 0,
  sha256: ''
}))

vi.mock('electron', () => ({
  net: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }
}))
vi.mock('../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('./voice-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voice-paths')>()
  const fs = await import('fs')
  const path = await import('path')
  return {
    ...actual,
    voiceModelDownloadUrl: () => fixture.url,
    // Same file list as production, minus the 100 MB encoder floor so the fixture stays tiny.
    voiceModelFilesPresent: (dir: string) =>
      Object.values(actual.VOICE_MODEL_FILES).every((file) => {
        const filePath = path.join(dir, file)
        return fs.existsSync(filePath) && fs.statSync(filePath).size > 0
      })
  }
})
vi.mock('@shared/types/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/types/voice')>()
  return {
    ...actual,
    // The real catalog entry, with size and checksum swapped for the fixture's.
    findVoiceSpeechModel: (id: string): VoiceSpeechModelInfo => ({
      ...actual.findVoiceSpeechModel(id),
      downloadBytes: fixture.downloadBytes,
      sha256: fixture.sha256
    })
  }
})

import { VOICE_SPEECH_MODELS } from '@shared/types/voice'
import { VoiceModelStore } from './voice-model-store'
import { VOICE_MODEL_FILES } from './voice-paths'

const MODEL_ID = 'nemotron-speech-streaming-en-0.6b' as const
const MODEL = VOICE_SPEECH_MODELS.find((m) => m.id === MODEL_ID)!

interface ServeMode {
  body: Buffer
  /** Drop the connection after this many body bytes (simulates a network cut). */
  cutAfter: number | null
}

let workDir: string
let archive: Buffer
let server: Server
let mode: ServeMode
let requests: IncomingHttpHeaders[]

function buildArchive(dir: string): Buffer {
  const root = join(dir, 'src', MODEL.archive)
  mkdirSync(join(root, 'test_wavs'), { recursive: true })
  for (const file of Object.values(VOICE_MODEL_FILES)) {
    // Incompressible bytes so the archive is big enough to cut mid-stream.
    writeFileSync(
      join(root, file),
      createHash('sha512').update(file).digest().toString('hex').repeat(4096)
    )
  }
  writeFileSync(join(root, 'README.md'), 'fixture')
  writeFileSync(join(root, 'test_wavs', '0.wav'), 'RIFF')
  const archivePath = join(dir, `${MODEL.archive}.tar.bz2`)
  execFileSync('tar', ['-cjf', archivePath, '-C', join(dir, 'src'), MODEL.archive])
  return readFileSync(archivePath)
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'voice-model-store-'))
  archive = buildArchive(workDir)
  fixture.downloadBytes = archive.length
  fixture.sha256 = createHash('sha256').update(archive).digest('hex')

  server = createServer((req, res) => {
    requests.push(req.headers)
    const { body, cutAfter } = mode
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    const start = range ? Number(range[1]) : 0
    const headers = { ETag: '"fixture-etag"', 'Content-Type': 'application/octet-stream' }
    if (range) {
      res.writeHead(206, {
        ...headers,
        'Content-Length': body.length - start,
        'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`
      })
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': body.length })
    }
    const slice = body.subarray(start)
    if (cutAfter !== null) {
      res.write(slice.subarray(0, cutAfter), () => {
        setTimeout(() => res.socket?.destroy(), 20)
      })
      return
    }
    res.end(slice)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fixture.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${MODEL.archive}.tar.bz2`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(workDir, { recursive: true, force: true })
})

let baseDir: string
const previousBaseDir = process.env.HIVE_DESKTOP_BASE_DIR

beforeEach(() => {
  baseDir = mkdtempSync(join(workDir, 'base-'))
  process.env.HIVE_DESKTOP_BASE_DIR = baseDir
  mode = { body: archive, cutAfter: null }
  requests = []
})

afterEach(() => {
  if (previousBaseDir === undefined) delete process.env.HIVE_DESKTOP_BASE_DIR
  else process.env.HIVE_DESKTOP_BASE_DIR = previousBaseDir
})

const modelsDir = (): string => join(baseDir, 'voice', 'models')
const partialPath = (): string => join(modelsDir(), `${MODEL.archive}.tar.bz2.partial`)

describe('VoiceModelStore with the Nemotron streaming model', () => {
  it('downloads, verifies and extracts the archive until the model is ready', async () => {
    const store = new VoiceModelStore()
    const phases: string[] = []
    store.onChange((modelId, state: VoiceModelState) => {
      expect(modelId).toBe(MODEL_ID)
      if (state.status === 'downloading' && phases.at(-1) !== state.phase) phases.push(state.phase)
    })

    expect(store.getState(MODEL_ID)).toEqual({ status: 'not-downloaded' })
    await store.download(MODEL_ID)

    expect(store.getState(MODEL_ID)).toEqual({ status: 'ready' })
    expect(store.isReady(MODEL_ID)).toBe(true)
    expect(phases).toEqual(['download', 'verify', 'extract'])
    const modelDir = join(modelsDir(), MODEL.archive)
    expect(store.getModelDir(MODEL_ID)).toBe(modelDir)
    for (const file of Object.values(VOICE_MODEL_FILES)) {
      expect(existsSync(join(modelDir, file))).toBe(true)
    }
    expect(existsSync(join(modelDir, 'test_wavs'))).toBe(false)
    expect(existsSync(partialPath())).toBe(false)
    expect(existsSync(`${partialPath()}.json`)).toBe(false)
  })

  it('resumes an interrupted download with a Range request', async () => {
    const store = new VoiceModelStore()
    const cutAfter = Math.floor(archive.length / 2)
    mode = { body: archive, cutAfter }

    await expect(store.download(MODEL_ID)).rejects.toThrow()
    expect(store.getState(MODEL_ID).status).toBe('failed')
    expect(existsSync(partialPath())).toBe(true)
    const kept = readFileSync(partialPath()).length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(archive.length)

    mode = { body: archive, cutAfter: null }
    await store.download(MODEL_ID)

    expect(store.getState(MODEL_ID)).toEqual({ status: 'ready' })
    expect(requests).toHaveLength(2)
    expect(requests[0].range).toBeUndefined()
    expect(requests[1].range).toBe(`bytes=${kept}-`)
    expect(requests[1]['if-range']).toBe('"fixture-etag"')
  })

  it('rejects an archive whose SHA-256 does not match and discards it', async () => {
    const store = new VoiceModelStore()
    const corrupt = Buffer.from(archive)
    corrupt[corrupt.length >> 1] ^= 0xff
    mode = { body: corrupt, cutAfter: null }

    await expect(store.download(MODEL_ID)).rejects.toThrow(/checksum mismatch/)

    const state = store.getState(MODEL_ID)
    expect(state.status).toBe('failed')
    expect(state.status === 'failed' && state.message).toMatch(/checksum mismatch/)
    expect(store.isReady(MODEL_ID)).toBe(false)
    expect(existsSync(join(modelsDir(), MODEL.archive))).toBe(false)
    expect(existsSync(partialPath())).toBe(false)

    // A retry against the good archive starts from scratch and succeeds.
    mode = { body: archive, cutAfter: null }
    await store.download(MODEL_ID)
    expect(store.getState(MODEL_ID)).toEqual({ status: 'ready' })
    expect(requests.at(-1)?.range).toBeUndefined()
  })
})

describe('VoiceModelStore.hasLocalFiles', () => {
  it('tells whether any of a model is on disk: nothing, a partial download, or its files', async () => {
    const store = new VoiceModelStore()
    expect(store.hasLocalFiles(MODEL_ID)).toBe(false)

    mkdirSync(modelsDir(), { recursive: true })
    const partial = join(modelsDir(), `${MODEL.archive}.tar.bz2.partial`)
    writeFileSync(partial, 'some bytes')
    expect(store.hasLocalFiles(MODEL_ID)).toBe(true)
    expect(store.hasLocalFiles('parakeet-tdt-0.6b-v2')).toBe(false)

    rmSync(partial)
    await store.download(MODEL_ID)
    expect(store.isReady(MODEL_ID)).toBe(true)
    expect(store.hasLocalFiles(MODEL_ID)).toBe(true)

    await store.delete(MODEL_ID)
    expect(store.hasLocalFiles(MODEL_ID)).toBe(false)
  })
})
