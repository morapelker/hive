import { describe, expect, it } from 'vitest'
import { DictationTrace } from './voice-dictation-summary'

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    }
  }
}

describe('DictationTrace', () => {
  it('measures a delivered dictation from the start and stop presses', () => {
    const c = clock()
    const trace = new DictationTrace('parakeet-tdt-0.6b-v2', c.now)
    trace.setTarget('paste')
    c.advance(120.4)
    trace.markCaptureStarted()
    c.advance(3_000)
    trace.markStop()
    trace.setAudio(48_000, 16_000)
    c.advance(80)
    trace.markTranscript('whole-clip', 71.6)
    trace.markAiStarted()
    c.advance(3_900)
    trace.markAiFinished('cleaned')
    c.advance(15)
    trace.markDelivered('pasted', 42)

    expect(trace.finish('delivered')).toEqual({
      outcome: 'delivered',
      reason: null,
      speechModel: 'parakeet-tdt-0.6b-v2',
      streamed: false,
      textSource: 'whole-clip',
      target: 'paste',
      audioMs: 3_000,
      startToCaptureMs: 120,
      recordMs: 3_120,
      stopToTranscriptMs: 80,
      decodeMs: 72,
      aiStep: 'cleaned',
      aiMs: 3_900,
      stopToDeliveredMs: 3_995,
      totalMs: 7_115,
      delivery: 'pasted',
      chars: 42
    })
  })

  it('leaves steps that never happened as null', () => {
    const c = clock()
    const trace = new DictationTrace('parakeet-tdt-0.6b-v2', c.now)
    c.advance(50)
    const summary = trace.finish('cancelled', 'escape')
    expect(summary).toMatchObject({
      outcome: 'cancelled',
      reason: 'escape',
      textSource: null,
      target: null,
      audioMs: null,
      startToCaptureMs: null,
      recordMs: null,
      stopToTranscriptMs: null,
      decodeMs: null,
      aiStep: 'not-applicable',
      aiMs: null,
      stopToDeliveredMs: null,
      delivery: null,
      chars: null,
      totalMs: 50
    })
  })

  it('has no AI duration when the AI step did not ask a model', () => {
    const c = clock()
    const trace = new DictationTrace('parakeet-tdt-0.6b-v2', c.now)
    trace.markStop()
    trace.markTranscript('whole-clip', 3)
    trace.markAiStarted()
    c.advance(2)
    trace.markAiFinished('disabled')
    expect(trace.finish('delivered')).toMatchObject({ aiStep: 'disabled', aiMs: null })
  })

  it('keeps the first capture and stop marks', () => {
    const c = clock()
    const trace = new DictationTrace('parakeet-tdt-0.6b-v2', c.now)
    c.advance(10)
    trace.markCaptureStarted()
    trace.markStop()
    c.advance(500)
    trace.markCaptureStarted()
    trace.markStop()
    expect(trace.finish('failed')).toMatchObject({ startToCaptureMs: 10, recordMs: 10 })
  })

  it('produces its summary only once', () => {
    const trace = new DictationTrace('parakeet-tdt-0.6b-v2', clock().now)
    expect(trace.isFinished).toBe(false)
    expect(trace.finish('discarded', 'too-short')).not.toBeNull()
    expect(trace.isFinished).toBe(true)
    expect(trace.finish('cancelled')).toBeNull()
  })

  it('keeps rounded timings consistent with each other', () => {
    const c = clock(0.3)
    const trace = new DictationTrace('parakeet-tdt-0.6b-v2', c.now)
    c.advance(0.4)
    trace.markStop()
    c.advance(0.4)
    trace.markTranscript('whole-clip', null)
    c.advance(0.4)
    trace.markDelivered('copied', 3)
    const summary = trace.finish('delivered')!
    expect(summary.stopToDeliveredMs!).toBeGreaterThanOrEqual(summary.stopToTranscriptMs!)
    expect(summary.totalMs).toBeGreaterThanOrEqual(summary.recordMs!)
    expect(summary.decodeMs).toBeNull()
  })

  it('uses a monotonic clock by default', () => {
    const summary = new DictationTrace('parakeet-tdt-0.6b-v2').finish('cancelled')!
    expect(summary.totalMs).toBeGreaterThanOrEqual(0)
  })
})
