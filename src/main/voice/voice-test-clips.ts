import { app } from 'electron'
import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import {
  VOICE_TEST_CLIPS_ENV,
  isVoiceTestClipsSwitchOn,
  type VoiceTestCaptureClip,
  type VoiceTestClipInfo,
  type VoiceTestClipsStatus,
  type VoiceTestPreviewReport,
  type VoiceTestSelectOptions,
  type VoiceTestStreamReport
} from '@shared/types/voice'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'VoiceTestClips' })

/** The committed fixtures, relative to the app root (apps/tedooo-code in a dev checkout). */
const FIXTURES_RELATIVE_DIR = join('test', 'fixtures', 'voice')

/** Clip names are bare file stems: no paths, no traversal. */
const CLIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Longest auto-stop delay accepted after a clip ends. */
const MAX_AUTO_STOP_DELAY_MS = 60_000

/** Preview updates kept per dictation for `status().preview.history`. */
const MAX_PREVIEW_HISTORY = 200

export interface DecodedWav {
  readonly samples: Float32Array
  readonly sampleRate: number
}

/**
 * Decode a RIFF/WAVE file to mono Float32 PCM. Handles integer PCM (8/16/24/32-bit),
 * IEEE float (32/64-bit) and WAVE_FORMAT_EXTENSIBLE; multi-channel audio is averaged.
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('not a WAV file')
  }

  let format: { code: number; channels: number; sampleRate: number; bits: number } | null = null
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      if (size < 16) throw new Error('malformed WAV fmt chunk')
      let code = view.getUint16(body, true)
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (code === 0xfffe && size >= 40) code = view.getUint16(body + 24, true)
      format = {
        code,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true)
      }
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data chunk before fmt chunk')
      const end = Math.min(body + size, view.byteLength)
      return { samples: decodePcm(view, body, end, format), sampleRate: format.sampleRate }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('WAV file has no data chunk')
}

function decodePcm(
  view: DataView,
  start: number,
  end: number,
  format: { code: number; channels: number; sampleRate: number; bits: number }
): Float32Array {
  const { code, channels, sampleRate, bits } = format
  if (channels < 1 || sampleRate <= 0) throw new Error('malformed WAV format')
  const bytesPerSample = bits / 8
  let read: (at: number) => number
  if (code === 1 && bits === 8) read = (at) => (view.getUint8(at) - 128) / 128
  else if (code === 1 && bits === 16) read = (at) => view.getInt16(at, true) / 32768
  else if (code === 1 && bits === 24) {
    read = (at) => {
      const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)
      return value / 8388608
    }
  } else if (code === 1 && bits === 32) read = (at) => view.getInt32(at, true) / 2147483648
  else if (code === 3 && bits === 32) read = (at) => view.getFloat32(at, true)
  else if (code === 3 && bits === 64) read = (at) => view.getFloat64(at, true)
  else throw new Error(`unsupported WAV encoding (format ${code}, ${bits}-bit)`)

  const frameBytes = bytesPerSample * channels
  const frames = Math.floor((end - start) / frameBytes)
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    const at = start + frame * frameBytes
    let sum = 0
    for (let channel = 0; channel < channels; channel++) sum += read(at + channel * bytesPerSample)
    samples[frame] = sum / channels
  }
  return samples
}

/**
 * Where test clips come from, or null when the switch is off (the default).
 * `1`/`true` means the committed fixtures; any other value is a directory of clips.
 */
export function resolveVoiceTestClipsDir(
  value: string | undefined,
  appRoot: string
): string | null {
  if (!isVoiceTestClipsSwitchOn(value)) return null
  const trimmed = value!.trim()
  if (/^(1|true|yes|on)$/i.test(trimmed)) return join(appRoot, FIXTURES_RELATIVE_DIR)
  return isAbsolute(trimmed) ? trimmed : resolve(appRoot, trimmed)
}

function defaultAppRoot(): string {
  return typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd()
}

interface LoadedClip {
  readonly name: string
  readonly samples: Float32Array
  readonly sampleRate: number
}

/**
 * Dev/test only: lets the HUD record a WAV clip instead of the microphone, so
 * dictation can be driven end-to-end from the verify workflow (CDP). Inert
 * unless the app was launched with TEDOOO_CODE_VOICE_TEST_CLIPS set.
 *
 * The selected clip is handed to the HUD each time capture starts and plays
 * through the same worklet as the mic, in real time. When it ends, the HUD
 * reports back and — if auto-stop is on — the dictation is stopped through the
 * same controller path as the hotkey after the configured delay.
 */
export class VoiceTestClips {
  private resolvedDir: string | null | undefined = undefined
  private selected: LoadedClip | null = null
  private autoStopAfterMs: number | null = null
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private playing = false
  private lastStream: VoiceTestStreamReport | null = null
  private preview: VoiceTestPreviewReport | null = null
  private captureStartedAt = 0
  private stopDictation: () => void = () => {}

  constructor(
    private readonly options: {
      readonly env?: () => string | undefined
      readonly appRoot?: () => string
    } = {}
  ) {}

  /** The clip directory, read once from the launch environment. */
  get dir(): string | null {
    if (this.resolvedDir === undefined) {
      const value = (this.options.env ?? (() => process.env[VOICE_TEST_CLIPS_ENV]))()
      this.resolvedDir = isVoiceTestClipsSwitchOn(value)
        ? resolveVoiceTestClipsDir(value, (this.options.appRoot ?? defaultAppRoot)())
        : null
      if (this.resolvedDir) {
        log.warn('Voice test clips are ON: dictation records clips instead of the microphone', {
          dir: this.resolvedDir
        })
      }
    }
    return this.resolvedDir
  }

  get enabled(): boolean {
    return this.dir !== null
  }

  /** How an elapsed auto-stop ends the dictation (wired to the controller's toggle). */
  setStopHandler(stop: () => void): void {
    this.stopDictation = stop
  }

  async list(): Promise<VoiceTestClipInfo[]> {
    const dir = this.requireDir()
    const files = existsSync(dir) ? await readdir(dir) : []
    const clips: VoiceTestClipInfo[] = []
    for (const file of files.sort()) {
      if (!file.toLowerCase().endsWith('.wav')) continue
      const name = file.slice(0, -4)
      if (!CLIP_NAME.test(name)) continue
      try {
        const wav = decodeWav(new Uint8Array(await readFile(join(dir, file))))
        clips.push({
          name,
          durationMs: Math.round((wav.samples.length / wav.sampleRate) * 1000),
          sampleRate: wav.sampleRate,
          expectedText: await this.readExpected(name)
        })
      } catch (error) {
        log.warn('Skipping unreadable test clip', { file, error: String(error) })
      }
    }
    return clips
  }

  /** Arm a clip for the next dictations (it stays selected until changed). `null` disarms. */
  async select(name: unknown, options: VoiceTestSelectOptions = {}): Promise<VoiceTestClipsStatus> {
    const dir = this.requireDir()
    this.autoStopAfterMs = sanitizeAutoStop(options.autoStopAfterMs)
    if (name === null) {
      this.selected = null
      return this.status()
    }
    if (typeof name !== 'string' || !CLIP_NAME.test(name.replace(/\.wav$/i, ''))) {
      throw new Error('invalid test clip name')
    }
    const stem = name.replace(/\.wav$/i, '')
    const path = join(dir, `${stem}.wav`)
    if (!existsSync(path)) throw new Error(`no test clip named "${stem}"`)
    const wav = decodeWav(new Uint8Array(await readFile(path)))
    this.selected = { name: stem, samples: wav.samples, sampleRate: wav.sampleRate }
    log.info('Test clip selected', {
      clip: stem,
      durationMs: Math.round((wav.samples.length / wav.sampleRate) * 1000),
      autoStopAfterMs: this.autoStopAfterMs
    })
    return this.status()
  }

  status(): VoiceTestClipsStatus {
    return {
      enabled: this.enabled,
      dir: this.dir,
      selected: this.selected?.name ?? null,
      durationMs: this.selected
        ? Math.round((this.selected.samples.length / this.selected.sampleRate) * 1000)
        : null,
      autoStopAfterMs: this.autoStopAfterMs,
      playing: this.playing,
      lastStream: this.lastStream,
      preview: this.preview
    }
  }

  /** The dictation's streaming session finished; kept for `status()` (verify workflow). */
  reportStream(report: VoiceTestStreamReport): void {
    if (!this.enabled) return
    this.lastStream = report
  }

  /**
   * The dictation passed a live transcript update on to the HUD; kept, timed
   * from capture start, for `status()` (verify workflow).
   */
  reportPreview(text: string): void {
    if (!this.enabled) return
    const atMs = Math.max(0, Date.now() - this.captureStartedAt)
    const previous = this.preview
    const history = previous?.history ?? []
    this.preview = {
      updates: (previous?.updates ?? 0) + 1,
      firstAtMs: previous?.firstAtMs ?? atMs,
      lastAtMs: atMs,
      text,
      history:
        history.length < MAX_PREVIEW_HISTORY ? [...history, { atMs, chars: text.length }] : history
    }
  }

  /**
   * What the HUD should record from for the capture that is starting: undefined
   * means the microphone (switch off); null means the switch is on but no clip
   * is armed, which the HUD reports as a capture error rather than opening a mic.
   */
  captureSource(): VoiceTestCaptureClip | null | undefined {
    if (!this.enabled) return undefined
    this.clearStopTimer()
    this.lastStream = null
    this.preview = null
    this.captureStartedAt = Date.now()
    if (!this.selected) {
      log.warn('Dictation started with test clips on but no clip selected')
      this.playing = false
      return null
    }
    this.playing = true
    // A fresh copy: the payload is structured-cloned per send, but never hand out the cache.
    return {
      name: this.selected.name,
      samples: this.selected.samples.slice(),
      sampleRate: this.selected.sampleRate
    }
  }

  /** The HUD finished playing the clip (its last sample reached the recorder). */
  clipEnded(): void {
    if (!this.enabled || !this.playing) return
    this.playing = false
    const delay = this.autoStopAfterMs
    log.info('Test clip ended', { clip: this.selected?.name ?? null, autoStopAfterMs: delay })
    if (delay === null) return
    this.clearStopTimer()
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null
      this.stopDictation()
    }, delay)
  }

  /** Capture stopped or was cancelled before the auto-stop fired. */
  captureEnded(): void {
    this.playing = false
    this.clearStopTimer()
  }

  private clearStopTimer(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
  }

  private requireDir(): string {
    const dir = this.dir
    if (!dir) throw new Error(`voice test clips are off (launch with ${VOICE_TEST_CLIPS_ENV}=1)`)
    return dir
  }

  private async readExpected(name: string): Promise<string | null> {
    const path = join(this.requireDir(), `${name}.txt`)
    if (!existsSync(path)) return null
    return (await readFile(path, 'utf8')).trim()
  }
}

function sanitizeAutoStop(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(Math.round(value), MAX_AUTO_STOP_DELAY_MS)
}

export const voiceTestClips = new VoiceTestClips()
