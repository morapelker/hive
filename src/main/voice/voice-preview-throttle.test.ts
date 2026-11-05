import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreviewThrottle } from './voice-preview-throttle'

describe('PreviewThrottle', () => {
  let sent: string[]
  let throttle: PreviewThrottle

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    throttle = new PreviewThrottle(
      150,
      (text) => sent.push(text),
      () => Date.now()
    )
  })

  afterEach(() => {
    throttle.cancel()
    vi.useRealTimers()
  })

  it('sends the first update at once', () => {
    throttle.push('create')
    expect(sent).toEqual(['create'])
  })

  it('sends updates that are further apart than the interval as they come', () => {
    throttle.push('create')
    vi.advanceTimersByTime(560)
    throttle.push('create a')
    vi.advanceTimersByTime(560)
    throttle.push('create a ticket')
    expect(sent).toEqual(['create', 'create a', 'create a ticket'])
  })

  it('collapses a burst into the first and the latest update', () => {
    throttle.push('one')
    throttle.push('one two')
    throttle.push('one two three')
    throttle.push('one two three four')
    expect(sent).toEqual(['one'])
    vi.advanceTimersByTime(149)
    expect(sent).toEqual(['one'])
    vi.advanceTimersByTime(1)
    expect(sent).toEqual(['one', 'one two three four'])
  })

  it('never sends more than one update per interval, however fast they come', () => {
    for (let i = 1; i <= 100; i++) {
      throttle.push(`word `.repeat(i).trim())
      vi.advanceTimersByTime(10)
    }
    vi.advanceTimersByTime(1_000)
    // 1 000 ms of pushes every 10 ms → the leading send plus one per 150 ms.
    expect(sent.length).toBeLessThanOrEqual(1 + Math.ceil(1_000 / 150))
    expect(sent.at(-1)).toBe('word '.repeat(100).trim())
  })

  it('drops text equal to what was last sent', () => {
    throttle.push('create a ticket')
    vi.advanceTimersByTime(500)
    throttle.push('create a ticket')
    expect(sent).toEqual(['create a ticket'])
    // A burst that comes back to the sent text sends nothing more.
    throttle.push('create a ticket for')
    expect(sent).toEqual(['create a ticket', 'create a ticket for'])
    throttle.push('create a ticket for me')
    throttle.push('create a ticket for')
    vi.advanceTimersByTime(500)
    expect(sent).toEqual(['create a ticket', 'create a ticket for'])
  })

  it('cancel drops the scheduled update', () => {
    throttle.push('one')
    throttle.push('one two')
    throttle.cancel()
    vi.advanceTimersByTime(1_000)
    expect(sent).toEqual(['one'])
  })
})
