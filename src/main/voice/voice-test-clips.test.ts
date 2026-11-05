import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { decodeWav, resolveVoiceTestClipsDir, VoiceTestClips } from './voice-test-clips'

const APP_ROOT = resolve(__dirname, '../../..')
const FIXTURES = join(APP_ROOT, 'test', 'fixtures', 'voice')

function wav(options: {
  format?: number
  channels?: number
  sampleRate?: number
  bits?: number
  data: ArrayBuffer
  extraChunk?: boolean
}): Uint8Array {
  const { format = 1, channels = 1, sampleRate = 16000, bits = 16, data, extraChunk } = options
  const extra = extraChunk ? 8 + 3 + 1 : 0 // odd-sized chunk plus its pad byte
  const out = new DataView(new ArrayBuffer(44 + extra + data.byteLength))
  const tag = (at: number, text: string): void => {
    for (let i = 0; i < 4; i++) out.setUint8(at + i, text.charCodeAt(i))
  }
  tag(0, 'RIFF')
  out.setUint32(4, 36 + extra + data.byteLength, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, format, true)
  out.setUint16(22, channels, true)
  out.setUint32(24, sampleRate, true)
  out.setUint32(28, (sampleRate * channels * bits) / 8, true)
  out.setUint16(32, (channels * bits) / 8, true)
  out.setUint16(34, bits, true)
  let at = 36
  if (extraChunk) {
    tag(at, 'LIST')
    out.setUint32(at + 4, 3, true)
    at += 12
  }
  tag(at, 'data')
  out.setUint32(at + 4, data.byteLength, true)
  new Uint8Array(out.buffer).set(new Uint8Array(data), at + 8)
  return new Uint8Array(out.buffer)
}

describe('decodeWav', () => {
  it('decodes 16-bit PCM mono to floats', () => {
    const decoded = decodeWav(wav({ data: new Int16Array([0, 16384, -32768, 32767]).buffer }))
    expect(decoded.sampleRate).toBe(16000)
    expect(Array.from(decoded.samples)).toEqual([0, 0.5, -1, 32767 / 32768])
  })

  it('averages stereo channels and skips unknown chunks', () => {
    const decoded = decodeWav(
      wav({
        channels: 2,
        sampleRate: 48000,
        data: new Int16Array([16384, 0, -16384, -16384]).buffer,
        extraChunk: true
      })
    )
    expect(decoded.sampleRate).toBe(48000)
    expect(Array.from(decoded.samples)).toEqual([0.25, -0.5])
  })

  it('decodes 32-bit float PCM', () => {
    const decoded = decodeWav(
      wav({ format: 3, bits: 32, data: new Float32Array([0.25, -0.75]).buffer })
    )
    expect(Array.from(decoded.samples)).toEqual([0.25, -0.75])
  })

  it('rejects files that are not WAV or use an unsupported encoding', () => {
    expect(() => decodeWav(new TextEncoder().encode('definitely not a wav file'))).toThrow(
      'not a WAV file'
    )
    expect(() => decodeWav(wav({ format: 2, data: new ArrayBuffer(4) }))).toThrow('unsupported')
  })
})

describe('resolveVoiceTestClipsDir', () => {
  it('is off unless the switch has a value', () => {
    expect(resolveVoiceTestClipsDir(undefined, APP_ROOT)).toBeNull()
    expect(resolveVoiceTestClipsDir('', APP_ROOT)).toBeNull()
    expect(resolveVoiceTestClipsDir('0', APP_ROOT)).toBeNull()
    expect(resolveVoiceTestClipsDir('false', APP_ROOT)).toBeNull()
  })

  it('maps 1/true to the committed fixtures and anything else to a directory', () => {
    expect(resolveVoiceTestClipsDir('1', APP_ROOT)).toBe(FIXTURES)
    expect(resolveVoiceTestClipsDir('true', APP_ROOT)).toBe(FIXTURES)
    expect(resolveVoiceTestClipsDir('/tmp/clips', APP_ROOT)).toBe('/tmp/clips')
    expect(resolveVoiceTestClipsDir('my-clips', APP_ROOT)).toBe(join(APP_ROOT, 'my-clips'))
  })
})

describe('committed fixture clips', () => {
  const clips = readdirSync(FIXTURES).filter((file) => file.endsWith('.wav'))
  const decode = (name: string): ReturnType<typeof decodeWav> =>
    decodeWav(new Uint8Array(readFileSync(join(FIXTURES, `${name}.wav`))))
  const seconds = (name: string): number => {
    const { samples, sampleRate } = decode(name)
    return samples.length / sampleRate
  }

  it('are 16 kHz mono WAVs, each with an expected transcript, under 5 MB in total', () => {
    expect(clips.sort()).toEqual([
      'monologue.wav',
      'paragraph.wav',
      'pause-mid.wav',
      'sentence.wav',
      'short-command.wav',
      'silence.wav',
      'speech-at-start.wav'
    ])
    let total = 0
    for (const file of clips) {
      const bytes = readFileSync(join(FIXTURES, file))
      total += statSync(join(FIXTURES, file)).size
      // fmt chunk: PCM, 1 channel, 16 kHz, 16-bit.
      expect(bytes.readUInt16LE(20)).toBe(1)
      expect(bytes.readUInt16LE(22)).toBe(1)
      expect(bytes.readUInt32LE(24)).toBe(16000)
      expect(bytes.readUInt16LE(34)).toBe(16)
      const text = readFileSync(join(FIXTURES, file.replace(/\.wav$/, '.txt')), 'utf8').trim()
      expect(text.length > 0).toBe(file !== 'silence.wav')
    }
    expect(total).toBeLessThan(5 * 1024 * 1024)
  })

  it('have the lengths the scenarios need', () => {
    expect(seconds('short-command')).toBeGreaterThan(2)
    expect(seconds('short-command')).toBeLessThan(4.5)
    expect(seconds('sentence')).toBeGreaterThan(6.5)
    expect(seconds('sentence')).toBeLessThan(10)
    expect(seconds('paragraph')).toBeGreaterThan(22)
    expect(seconds('paragraph')).toBeLessThan(30)
    expect(seconds('monologue')).toBeGreaterThan(55)
    expect(seconds('monologue')).toBeLessThan(66)
    expect(seconds('silence')).toBeCloseTo(3, 1)
  })

  it('has a ~7 s silent gap in the pause clip', () => {
    const { samples, sampleRate } = decode('pause-mid')
    let longest = 0
    let run = 0
    for (const sample of samples) {
      run = sample === 0 ? run + 1 : 0
      longest = Math.max(longest, run)
    }
    expect(longest / sampleRate).toBeGreaterThanOrEqual(7)
  })

  it('starts the speech-at-start clip with audible speech at the first sample', () => {
    expect(Math.abs(decode('speech-at-start').samples[0])).toBeGreaterThan(0.02)
  })

  it('makes the silence clip digital silence', () => {
    expect(decode('silence').samples.every((sample) => sample === 0)).toBe(true)
  })
})

describe('VoiceTestClips', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'voice-test-clips-'))
    writeFileSync(join(dir, 'hello.wav'), wav({ data: new Int16Array(16000).fill(1000).buffer }))
    writeFileSync(join(dir, 'hello.txt'), 'Hello there.\n')
    writeFileSync(join(dir, 'broken.wav'), 'nope')
    writeFileSync(join(dir, 'notes.md'), '# not a clip')
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const make = (env: string | undefined): VoiceTestClips =>
    new VoiceTestClips({ env: () => env, appRoot: () => APP_ROOT })

  it('is inert when the switch is off: the HUD uses the microphone', async () => {
    const clips = make(undefined)
    expect(clips.enabled).toBe(false)
    expect(clips.captureSource()).toBeUndefined()
    await expect(clips.list()).rejects.toThrow('voice test clips are off')
    await expect(clips.select('hello')).rejects.toThrow('voice test clips are off')
  })

  it('lists readable clips with their duration and expected text', async () => {
    await expect(make(dir).list()).resolves.toEqual([
      { name: 'hello', durationMs: 1000, sampleRate: 16000, expectedText: 'Hello there.' }
    ])
  })

  it('lists the committed fixtures with the 1 shorthand', async () => {
    const names = (await make('1').list()).map((clip) => clip.name)
    expect(names).toContain('paragraph')
    expect(names).toHaveLength(7)
  })

  it('hands the selected clip to every capture until another is selected', async () => {
    const clips = make(dir)
    expect(clips.captureSource()).toBeNull()
    await clips.select('hello.wav')
    const first = clips.captureSource()
    expect(first?.name).toBe('hello')
    expect(first?.sampleRate).toBe(16000)
    expect(first?.samples).toHaveLength(16000)
    expect(clips.status()).toMatchObject({ selected: 'hello', durationMs: 1000, playing: true })
    clips.captureEnded()
    expect(clips.captureSource()?.name).toBe('hello')
    await clips.select(null)
    expect(clips.captureSource()).toBeNull()
  })

  it("reports the last dictation's streaming session until the next capture starts", async () => {
    const report = {
      chunks: 11,
      streamedMs: 1056,
      topUpMs: 0,
      clipMs: 1056,
      sessionAudioMs: 1056,
      finishMs: 60,
      text: 'Hello there'
    }
    const clips = make(dir)
    await clips.select('hello')
    expect(clips.status().lastStream).toBeNull()
    clips.captureSource()
    clips.reportStream(report)
    expect(clips.status().lastStream).toEqual(report)
    clips.captureSource()
    expect(clips.status().lastStream).toBeNull()

    const off = make(undefined)
    off.reportStream(report)
    expect(off.status().lastStream).toBeNull()
  })

  it('refuses names that are paths or do not exist', async () => {
    const clips = make(dir)
    await expect(clips.select('../hello')).rejects.toThrow('invalid test clip name')
    await expect(clips.select('/etc/passwd')).rejects.toThrow('invalid test clip name')
    await expect(clips.select(42)).rejects.toThrow('invalid test clip name')
    await expect(clips.select('missing')).rejects.toThrow('no test clip named "missing"')
  })

  it('stops the dictation the configured delay after the clip ends', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    const clips = make(dir)
    clips.setStopHandler(stop)
    await clips.select('hello', { autoStopAfterMs: 800 })
    clips.captureSource()
    clips.clipEnded()
    vi.advanceTimersByTime(799)
    expect(stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(clips.status().playing).toBe(false)
  })

  it('leaves stopping to the caller without an auto-stop delay', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    const clips = make(dir)
    clips.setStopHandler(stop)
    await clips.select('hello')
    clips.captureSource()
    clips.clipEnded()
    vi.advanceTimersByTime(120_000)
    expect(stop).not.toHaveBeenCalled()
  })

  it('drops a pending auto-stop when the dictation is stopped, cancelled or restarted', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    const clips = make(dir)
    clips.setStopHandler(stop)
    await clips.select('hello', { autoStopAfterMs: 500 })

    clips.captureSource()
    clips.clipEnded()
    clips.captureEnded()
    vi.advanceTimersByTime(1000)

    clips.captureSource()
    clips.clipEnded()
    clips.captureSource() // the next dictation starts before the timer fires
    vi.advanceTimersByTime(1000)
    expect(stop).not.toHaveBeenCalled()
  })

  it('ignores a clip-ended report when no clip is playing', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    const clips = make(dir)
    clips.setStopHandler(stop)
    await clips.select('hello', { autoStopAfterMs: 0 })
    clips.clipEnded()
    vi.advanceTimersByTime(10)
    expect(stop).not.toHaveBeenCalled()
  })

  it('clamps the auto-stop delay and treats junk as manual stop', async () => {
    const clips = make(dir)
    await expect(clips.select('hello', { autoStopAfterMs: 10 * 60_000 })).resolves.toMatchObject({
      autoStopAfterMs: 60_000
    })
    await expect(clips.select('hello', { autoStopAfterMs: -5 })).resolves.toMatchObject({
      autoStopAfterMs: null
    })
    await expect(clips.select('hello', { autoStopAfterMs: Number.NaN })).resolves.toMatchObject({
      autoStopAfterMs: null
    })
  })
})
