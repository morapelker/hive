import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { createLogger } from '../services/logger'
import { getVoiceBaseDir } from './voice-paths'

const log = createLogger({ component: 'VoiceSounds' })

export type VoiceSoundName = 'start' | 'stop'

/** The same system sounds Wispelker plays: "Pop" when recording starts, "Tink" when it stops. */
const MAC_SOUND_FILES: Record<VoiceSoundName, string> = {
  start: '/System/Library/Sounds/Pop.aiff',
  stop: '/System/Library/Sounds/Tink.aiff'
}

export interface VoiceSoundBuffers {
  readonly start: Uint8Array | null
  readonly stop: Uint8Array | null
}

let cached: Promise<VoiceSoundBuffers> | null = null

/**
 * Chromium cannot decode AIFF and `afplay` takes hundreds of milliseconds to
 * start, so the macOS system sounds are converted to WAV once (afconvert,
 * ~30 ms) and handed to the HUD window, which decodes them with Web Audio and
 * plays them with no latency. Other platforms get null buffers and the HUD
 * synthesises a short tone instead.
 */
export function loadVoiceSoundBuffers(): Promise<VoiceSoundBuffers> {
  cached ??= convertAll().catch((error: unknown) => {
    log.warn('sound conversion failed; HUD will synthesise tones', { error: String(error) })
    cached = null
    return { start: null, stop: null }
  })
  return cached
}

async function convertAll(): Promise<VoiceSoundBuffers> {
  if (process.platform !== 'darwin') return { start: null, stop: null }
  const dir = join(getVoiceBaseDir(), 'sounds')
  await mkdir(dir, { recursive: true })
  const [start, stop] = await Promise.all([
    convert(MAC_SOUND_FILES.start, join(dir, 'start.wav')),
    convert(MAC_SOUND_FILES.stop, join(dir, 'stop.wav'))
  ])
  return { start, stop }
}

async function convert(source: string, target: string): Promise<Uint8Array | null> {
  if (!existsSync(source)) return null
  if (!existsSync(target)) {
    await new Promise<void>((resolve, reject) => {
      execFile(
        '/usr/bin/afconvert',
        ['-f', 'WAVE', '-d', 'LEI16', source, target],
        { timeout: 10_000 },
        (error) => (error ? reject(error) : resolve())
      )
    })
  }
  return new Uint8Array(await readFile(target))
}
