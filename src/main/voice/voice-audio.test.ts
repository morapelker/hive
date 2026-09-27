import { describe, expect, it } from 'vitest'
import { isDigitalSilence, rms, trimSilence } from './voice-audio'
import { splitIntoWindows } from './voice-windows'

const RATE = 16000

function tone(seconds: number, amplitude = 0.3, frequency = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE)
  }
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

describe('voice-audio', () => {
  it('measures rms and detects digital silence', () => {
    expect(rms(new Float32Array(0))).toBe(0)
    expect(isDigitalSilence(new Float32Array(RATE))).toBe(true)
    expect(isDigitalSilence(tone(0.5))).toBe(false)
    expect(rms(tone(1, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })

  it('trims leading and trailing silence but keeps a little padding', () => {
    const clip = concat(new Float32Array(RATE), tone(1), new Float32Array(RATE))
    const trimmed = trimSilence(clip, RATE)
    // 1 s of tone plus up to 120 ms of padding on each side, minus frame rounding.
    expect(trimmed.length).toBeGreaterThan(RATE)
    expect(trimmed.length).toBeLessThan(RATE * 1.3)
    expect(trimSilence(new Float32Array(RATE), RATE).length).toBe(0)
    expect(trimSilence(tone(0.5), RATE).length).toBe(Math.round(0.5 * RATE))
  })

  it('keeps clips up to ~19 s in one window', () => {
    expect(splitIntoWindows(tone(18), RATE)).toHaveLength(1)
  })

  it('splits long clips at quiet points near 15 s boundaries', () => {
    // 14 s tone, 1 s gap, 14 s tone, 1 s gap, 10 s tone  → cut inside the gaps.
    const clip = concat(
      tone(14),
      new Float32Array(RATE),
      tone(14),
      new Float32Array(RATE),
      tone(10)
    )
    const windows = splitIntoWindows(clip, RATE)
    expect(windows.length).toBeGreaterThanOrEqual(2)
    expect(windows.reduce((sum, w) => sum + w.length, 0)).toBe(clip.length)
    const firstCut = windows[0].length
    // The first cut lands in the first silent gap (between 14 s and 15 s).
    expect(firstCut).toBeGreaterThanOrEqual(14 * RATE)
    expect(firstCut).toBeLessThanOrEqual(15 * RATE)
    for (const window of windows) {
      expect(window.length).toBeLessThanOrEqual(Math.round(RATE * 15 * 1.25) + RATE)
    }
  })
})
