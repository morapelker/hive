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
      fallbackReason: null,
      audioMs: 3_000,
      startToCaptureMs: 120,
      previewUpdates: null,
      captureToPreviewMs: null,
      recordMs: 3_120,
      stopToTranscriptMs: 80,
      decodeMs: 72,
      aiStep: 'cleaned',
      aiMs: 3_900,
      skipInput: null,
      skipToDeliveredMs: null,
      stopToDeliveredMs: 3_995,
      totalMs: 7_115,
      delivery: 'pasted',
      chars: 42
    })
  })

  it('reports a skipped AI step with its input, its duration up to the skip, and skip → delivered', () => {
    const c = clock()
    const trace = new DictationTrace('nemotron-speech-streaming-en-0.6b', c.now)
    trace.markCaptureStarted()
    c.advance(2_000)
    trace.markStop()
    c.advance(50)
    trace.markTranscript('streamed', 41)
    trace.markAiStarted()
    c.advance(700.4)
    trace.markAiSkipped('escape')
    c.advance(12)
    trace.markDelivered('pasted', 20)

    expect(trace.finish('delivered')).toMatchObject({
      aiStep: 'skipped',
      aiMs: 700,
      skipInput: 'escape',
      skipToDeliveredMs: 12,
      stopToDeliveredMs: 762
    })
  })

  it('leaves the skip fields null when the AI step was not skipped', () => {
    const c = clock()
    const trace = new DictationTrace('parakeet-tdt-0.6b-v2', c.now)
    trace.markStop()
    trace.markAiStarted()
    c.advance(5_000)
    trace.markAiFinished('timed-out')
    trace.markDelivered('pasted', 10)
    expect(trace.finish('delivered')).toMatchObject({
      aiStep: 'timed-out',
      aiMs: 5_000,
      skipInput: null,
      skipToDeliveredMs: null
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
      streamed: false,
      textSource: null,
      fallbackReason: null,
      audioMs: null,
      startToCaptureMs: null,
      previewUpdates: null,
      captureToPreviewMs: null,
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

  it('reports a streamed dictation: its preview updates and the streamed text source', () => {
    const c = clock()
    const trace = new DictationTrace('nemotron-speech-streaming-en-0.6b', c.now)
    trace.markStreamed()
    c.advance(40)
    trace.markCaptureStarted()
    c.advance(900.6)
    trace.markPreview()
    c.advance(560)
    trace.markPreview()
    c.advance(1_500)
    trace.markStop()
    c.advance(61)
    trace.markTranscript('streamed', 38.4)
    c.advance(4)
    trace.markDelivered('pasted', 15)

    expect(trace.finish('delivered')).toMatchObject({
      streamed: true,
      textSource: 'streamed',
      fallbackReason: null,
      previewUpdates: 2,
      captureToPreviewMs: 901,
      stopToTranscriptMs: 61,
      decodeMs: 38,
      stopToDeliveredMs: 65
    })
  })

  it('says why a streamed dictation fell back to the whole clip', () => {
    const c = clock()
    const trace = new DictationTrace('nemotron-speech-streaming-en-0.6b', c.now)
    trace.markStreamed()
    trace.markCaptureStarted()
    trace.markStop()
    c.advance(1_700)
    trace.markTranscript('fallback', 420, 'engine-exited')
    expect(trace.finish('delivered')).toMatchObject({
      streamed: true,
      textSource: 'fallback',
      fallbackReason: 'engine-exited',
      previewUpdates: 0,
      captureToPreviewMs: null,
      stopToTranscriptMs: 1_700,
      decodeMs: 420
    })
  })

  it('only keeps a fallback reason for fallback text', () => {
    const trace = new DictationTrace('nemotron-speech-streaming-en-0.6b', clock().now)
    trace.markTranscript('streamed', 30, 'empty-text')
    expect(trace.finish('delivered')).toMatchObject({ fallbackReason: null })
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
