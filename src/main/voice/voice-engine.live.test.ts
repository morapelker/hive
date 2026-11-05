/**
 * Live check of the voice engine's streaming sessions against the REAL
 * Nemotron streaming model and the committed fixture clips
 * (test/fixtures/voice/*.wav + .txt).
 *
 * Opt-in (about 10 minutes in real time; run it on its own, on a quiet machine):
 *   VOICE_ENGINE_LIVE=1 pnpm exec vitest run src/main/voice/voice-engine.live.test.ts
 *
 * Skips cleanly unless VOICE_ENGINE_LIVE=1 and the model is on disk.
 *   VOICE_ENGINE_LIVE_MODEL_DIR     Nemotron folder (default: <base>/voice/models/<archive>,
 *                                   base = TEDOOO_CODE_DESKTOP_BASE_DIR or ~/.hive)
 *   VOICE_ENGINE_LIVE_PARAKEET_DIR  Parakeet v2 folder for the whole-clip regression check
 *                                   (same default rule; skipped when missing)
 *   VOICE_ENGINE_LIVE_RUNS          finish-latency repeats per timed fixture (default 5)
 *   VOICE_ENGINE_LIVE_SPEED         playback speed; 1 = real time (default), 4 = four times faster
 *
 * The real VoiceEngine (main-process side) drives the real worker logic
 * (VoiceEngineHost + sherpa-onnx-node) in-process instead of in an Electron
 * utility process; messages are structured-cloned and delivered
 * asynchronously, as between processes. Audio is pushed in the HUD's 96 ms
 * chunks, each when it would have been recorded.
 */
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { loadavg } from 'os'
import { join, resolve } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FakeEngineChild } from './__tests__/voice-engine-fakes'

const forked = vi.hoisted(() => ({ onFork: null as ((child: FakeEngineChild) => void) | null }))

vi.mock('electron', async () => {
  const { FakeEngineChild } = await import('./__tests__/voice-engine-fakes')
  return {
    app: { isPackaged: false, getAppPath: () => '' },
    utilityProcess: {
      fork: vi.fn(() => {
        const child = new FakeEngineChild()
        forked.onFork?.(child)
        return child
      })
    }
  }
})
vi.mock('../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { findVoiceSpeechModel } from '@shared/types/voice'
import { normalizeForComparison } from '@shared/voice/transcript-sanitizer'
import { connectToHost } from './__tests__/voice-engine-fakes'
import type { SherpaModule } from './voice-engine-host'
import { VoiceEngine, type VoiceEngineModel, type VoiceStreamResult } from './voice-engine'
import { getVoiceModelDir, voiceModelFilesPresent } from './voice-paths'
import { decodeWav } from './voice-test-clips'

const LIVE = process.env.VOICE_ENGINE_LIVE === '1'
const RUNS = Math.max(1, Number(process.env.VOICE_ENGINE_LIVE_RUNS ?? 5))
const SPEED = Math.max(0.25, Number(process.env.VOICE_ENGINE_LIVE_SPEED ?? 1))

const NEMOTRON: VoiceEngineModel = {
  id: 'nemotron-speech-streaming-en-0.6b',
  dir:
    process.env.VOICE_ENGINE_LIVE_MODEL_DIR ??
    getVoiceModelDir(findVoiceSpeechModel('nemotron-speech-streaming-en-0.6b'))
}
const PARAKEET: VoiceEngineModel = {
  id: 'parakeet-tdt-0.6b-v2',
  dir:
    process.env.VOICE_ENGINE_LIVE_PARAKEET_DIR ??
    getVoiceModelDir(findVoiceSpeechModel('parakeet-tdt-0.6b-v2'))
}

const describeLive = LIVE && voiceModelFilesPresent(NEMOTRON.dir) ? describe : describe.skip
const describeParakeet = LIVE && voiceModelFilesPresent(PARAKEET.dir) ? describe : describe.skip

/** The HUD's capture chunk: 1536 samples at 16 kHz ≈ 96 ms. */
const CHUNK_SAMPLES = 1536
/** Latency budget: stop → final transcript, p95. */
const FINISH_BUDGET_MS = 150
/** Space-insensitive character error rate allowed (TTS clips; "home page" comes out as "homepage"). */
const MAX_CER = 0.02

const FIXTURES_DIR = resolve(__dirname, '../../../test/fixtures/voice')
const SPEECH_FIXTURES = [
  'short-command',
  'sentence',
  'paragraph',
  'monologue',
  'pause-mid',
  'speech-at-start'
]
const TIMED_FIXTURES = ['short-command', 'paragraph', 'monologue']

interface Fixture {
  readonly name: string
  readonly samples: Float32Array
  readonly sampleRate: number
  readonly expected: string
}

function loadFixture(name: string): Fixture {
  const wav = decodeWav(new Uint8Array(readFileSync(join(FIXTURES_DIR, `${name}.wav`))))
  const expected = readFileSync(join(FIXTURES_DIR, `${name}.txt`), 'utf8').trim()
  return { name, samples: wav.samples, sampleRate: wav.sampleRate, expected }
}

/**
 * Every fixture opens with a short click and ~0.1 s of digital zeros, which
 * would act as lead-in themselves. Cut to the true speech onset so a missing
 * lead-in shows up as a lost first word.
 */
function trimToOnset(samples: Float32Array): Float32Array {
  let i = 64
  while (i < samples.length && Math.abs(samples[i]) < 1e-4) i++
  return samples.subarray(i)
}

/** Cut the trailing quiet so speech runs right up to the stop. */
function trimToEnd(samples: Float32Array, sampleRate: number): Float32Array {
  const frame = Math.round(sampleRate * 0.01)
  let end = samples.length
  const loud = (from: number): boolean => {
    let energy = 0
    for (let i = from; i < from + frame; i++) energy += samples[i] * samples[i]
    return Math.sqrt(energy / frame) > 0.01
  }
  while (end - frame > 0 && !loud(end - frame)) end -= frame
  return samples.subarray(0, end)
}

function compact(text: string): string {
  return normalizeForComparison(text).replace(/ /g, '')
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[b.length]
}

function cer(actual: string, expected: string): number {
  const e = compact(expected)
  return e.length === 0 ? compact(actual).length : editDistance(compact(actual), e) / e.length
}

/** First and last word present, and the rest within the error budget. */
function expectTranscript(actual: string, expected: string): void {
  const words = normalizeForComparison(expected).split(' ')
  expect(compact(actual).startsWith(words[0]), `first word "${words[0]}" in "${actual}"`).toBe(true)
  expect(compact(actual).endsWith(words[words.length - 1]), `last word in "${actual}"`).toBe(true)
  expect(cer(actual, expected), `"${actual}" vs "${expected}"`).toBeLessThanOrEqual(MAX_CER)
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}

function sleepUntil(target: number): Promise<void> {
  const wait = target - performance.now()
  return wait > 0 ? new Promise((done) => setTimeout(done, wait)) : Promise.resolve()
}

interface StreamRun {
  readonly result: VoiceStreamResult
  /** finish() called → final text, measured here. */
  readonly finishMs: number
  /** Session start → first non-empty transcript update. */
  readonly firstUpdateMs: number | null
  readonly updates: number
}

const report: Array<Record<string, string | number>> = []

function record(label: string, fixture: Fixture, run: StreamRun): void {
  const audioS = fixture.samples.length / fixture.sampleRate
  report.push({
    run: label,
    audioS: Math.round(audioS * 10) / 10,
    finishMs: Math.round(run.finishMs),
    workerFinishMs: run.result.workerFinishMs,
    finishDecodes: run.result.finishDecodes,
    busyPct: Math.round((run.result.busyMs / run.result.audioMs) * 1000) / 10,
    firstUpdateMs: run.firstUpdateMs === null ? '-' : Math.round(run.firstUpdateMs * SPEED),
    updates: run.updates,
    cer: Math.round(cer(run.result.text, fixture.expected) * 1000) / 10
  })
}

describeLive('voice engine streaming sessions (live Nemotron model)', () => {
  let engine: VoiceEngine
  const finishTimes = new Map<string, number[]>()
  /** Each fixture's streamed transcript, to compare the whole-clip one with. */
  const streamedText = new Map<string, string>()

  async function streamInRealTime(samples: Float32Array, sampleRate: number): Promise<StreamRun> {
    let firstUpdateMs: number | null = null
    let updates = 0
    const started = performance.now()
    const session = engine.startSession(NEMOTRON, {
      sampleRate,
      // A session error surfaces as finish() rejecting.
      onUpdate: (text) => {
        updates++
        if (firstUpdateMs === null && text) firstUpdateMs = performance.now() - started
      }
    })
    const chunkMs = ((CHUNK_SAMPLES / sampleRate) * 1000) / SPEED
    for (let k = 0, from = 0; from < samples.length; k++, from += CHUNK_SAMPLES) {
      await sleepUntil(started + (k + 1) * chunkMs)
      session.push(samples.subarray(from, from + CHUNK_SAMPLES))
    }
    const stop = performance.now()
    const result = await session.finish()
    return { result, finishMs: performance.now() - stop, firstUpdateMs, updates }
  }

  function timeoutFor(fixture: Fixture, runs = 1): number {
    return ((fixture.samples.length / fixture.sampleRate / SPEED + 30) * runs + 30) * 1000
  }

  beforeAll(async () => {
    const nodeRequire = createRequire(__filename)
    const sherpa = nodeRequire('sherpa-onnx-node') as SherpaModule
    forked.onFork = (child) => connectToHost(child, sherpa)
    engine = new VoiceEngine()
    await engine.ensureLoaded(NEMOTRON)
  }, 120_000)

  afterAll(() => {
    engine?.dispose()
    for (const [name, times] of finishTimes) {
      report.push({
        run: `${name} finish p50/p95/max over ${times.length}`,
        finishMs: `${Math.round(percentile(times, 50))}/${Math.round(percentile(times, 95))}/${Math.round(Math.max(...times))}`
      })
    }
    const load = loadavg()
      .map((value) => value.toFixed(1))
      .join(' ')
    console.log(
      `\nVoice engine live harness (speed ×${SPEED}, model ${NEMOTRON.dir}, load average ${load})`
    )
    console.table(report)
  })

  for (const name of SPEECH_FIXTURES) {
    const fixture = loadFixture(name)
    it(
      `streams ${name} as it is spoken and gets its transcript`,
      async () => {
        const run = await streamInRealTime(fixture.samples, fixture.sampleRate)
        record(`stream ${name}`, fixture, run)
        streamedText.set(name, run.result.text)
        expectTranscript(run.result.text, fixture.expected)
        expect(run.firstUpdateMs).not.toBeNull()
      },
      timeoutFor(fixture)
    )
  }

  it('returns empty text, without an error, for the silence fixture', async () => {
    const fixture = loadFixture('silence')
    const run = await streamInRealTime(fixture.samples, fixture.sampleRate)
    record('stream silence', fixture, run)
    streamedText.set('silence', run.result.text)
    expect(run.result.text).toBe('')
    expect(run.updates).toBe(0)
  }, 60_000)

  it('keeps the first word when speech starts at the very first sample', async () => {
    for (const name of ['speech-at-start', 'short-command']) {
      const fixture = loadFixture(name)
      const samples = trimToOnset(fixture.samples)
      expect(Math.abs(samples[0])).toBeGreaterThan(1e-4)
      const run = await streamInRealTime(samples, fixture.sampleRate)
      record(`stream ${name} (onset-trimmed)`, { ...fixture, samples }, run)
      expectTranscript(run.result.text, fixture.expected)
    }
  }, 120_000)

  it('keeps the last word when speech runs right up to the stop', async () => {
    for (const name of ['speech-at-start', 'short-command', 'sentence']) {
      const fixture = loadFixture(name)
      const samples = trimToEnd(trimToOnset(fixture.samples), fixture.sampleRate)
      const run = await streamInRealTime(samples, fixture.sampleRate)
      record(`stream ${name} (both ends trimmed)`, { ...fixture, samples }, run)
      expectTranscript(run.result.text, fixture.expected)
    }
  }, 180_000)

  it('keeps the words after a 7 s pause', async () => {
    const fixture = loadFixture('pause-mid')
    const run = await streamInRealTime(fixture.samples, fixture.sampleRate)
    const afterPause = fixture.expected.split('. ')[1]
    expect(afterPause).toBeTruthy()
    expect(compact(run.result.text)).toContain(compact(afterPause))
  }, 90_000)

  it(
    `finishes within ${FINISH_BUDGET_MS} ms p95 for the 3 s, 25 s and 60 s fixtures`,
    async () => {
      for (const name of TIMED_FIXTURES) {
        const fixture = loadFixture(name)
        const times: number[] = []
        for (let i = 0; i < RUNS; i++) {
          const run = await streamInRealTime(fixture.samples, fixture.sampleRate)
          record(`timed ${name} #${i + 1}`, fixture, run)
          expectTranscript(run.result.text, fixture.expected)
          times.push(run.finishMs)
        }
        finishTimes.set(name, times)
      }
      for (const [name, times] of finishTimes) {
        expect(
          percentile(times, 95),
          `${name}: ${times.map(Math.round).join(', ')} ms`
        ).toBeLessThanOrEqual(FINISH_BUDGET_MS)
      }
    },
    TIMED_FIXTURES.map((name) => timeoutFor(loadFixture(name), RUNS)).reduce((a, b) => a + b)
  )

  it('transcribes every fixture as a whole clip with the streaming model, same text as streaming', async () => {
    for (const name of [...SPEECH_FIXTURES, 'silence']) {
      const fixture = loadFixture(name)
      const started = performance.now()
      const { text } = await engine.transcribe(fixture.samples, fixture.sampleRate)
      const streamed = streamedText.get(name)
      report.push({
        run: `whole-clip ${name}`,
        audioS: Math.round((fixture.samples.length / fixture.sampleRate) * 10) / 10,
        finishMs: Math.round(performance.now() - started),
        cer: Math.round(cer(text, fixture.expected) * 1000) / 10,
        sameAsStreamed: streamed === undefined ? '-' : String(text === streamed)
      })
      // Only when the streaming test for this fixture ran in this file run.
      if (streamed !== undefined) expect(text, `${name}: whole clip vs streamed`).toBe(streamed)
      if (!fixture.expected) {
        expect(text).toBe('')
        continue
      }
      expectTranscript(text, fixture.expected)
    }
  }, 300_000)
})

describeParakeet('voice engine whole-clip transcription (live Parakeet v2 model)', () => {
  let engine: VoiceEngine

  beforeAll(async () => {
    const nodeRequire = createRequire(__filename)
    const sherpa = nodeRequire('sherpa-onnx-node') as SherpaModule
    forked.onFork = (child) => connectToHost(child, sherpa)
    engine = new VoiceEngine()
    await engine.ensureLoaded(PARAKEET)
  }, 120_000)

  afterAll(() => {
    engine?.dispose()
  })

  it('transcribes every fixture as before', async () => {
    for (const name of [...SPEECH_FIXTURES, 'silence']) {
      const fixture = loadFixture(name)
      const { text } = await engine.transcribe(fixture.samples, fixture.sampleRate)
      if (!fixture.expected) {
        expect(text).toBe('')
        continue
      }
      expectTranscript(text, fixture.expected)
    }
  }, 120_000)
})
