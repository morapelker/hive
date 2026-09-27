import { describe, it, expect } from 'vitest'
import {
  isEphemeralItemKey,
  stabilizeAnchor,
  computeAnchorFraction,
  computeAnchorFractions,
  anchorAtFraction
} from '../scroll-tag-anchors'

const measurements = [
  { key: 'message:msg_1', start: 0 },
  { key: 'message:msg_2', start: 200 },
  { key: 'message:local-abc', start: 500 },
  { key: 'streaming:s1', start: 700 }
]

describe('isEphemeralItemKey', () => {
  it('flags optimistic and transient keys', () => {
    expect(isEphemeralItemKey('message:local-abc')).toBe(true)
    expect(isEphemeralItemKey('streaming:s1')).toBe(true)
    expect(isEphemeralItemKey('queued:q1')).toBe(true)
    expect(isEphemeralItemKey('typing-indicator')).toBe(true)
    expect(isEphemeralItemKey('completion')).toBe(true)
    expect(isEphemeralItemKey('error-banner')).toBe(true)
    expect(isEphemeralItemKey('retry-banner')).toBe(true)
    expect(isEphemeralItemKey('revert-banner:m1')).toBe(true)
  })

  it('accepts stable message keys', () => {
    expect(isEphemeralItemKey('message:msg_123')).toBe(false)
    expect(isEphemeralItemKey('bash-run1')).toBe(false)
  })
})

describe('stabilizeAnchor', () => {
  it('returns the anchor unchanged when already stable', () => {
    const anchor = {
      itemKey: 'message:msg_2',
      offsetWithinItem: 50,
      fallbackScrollTop: 250,
      fallbackScrollHeight: 1000
    }
    expect(stabilizeAnchor(anchor, measurements)).toEqual(anchor)
  })

  it('walks back to the nearest stable key, recomputing offset', () => {
    const anchor = {
      itemKey: 'message:local-abc',
      offsetWithinItem: 30,
      fallbackScrollTop: 530,
      fallbackScrollHeight: 1000
    }
    const stabilized = stabilizeAnchor(anchor, measurements)
    expect(stabilized.itemKey).toBe('message:msg_2')
    // scroll position 530, msg_2 starts at 200 → offset 330
    expect(stabilized.offsetWithinItem).toBe(330)
    expect(stabilized.fallbackScrollTop).toBe(530)
  })

  it('returns the anchor unchanged when no stable predecessor exists', () => {
    const allEphemeral = [
      { key: 'streaming:s1', start: 0 },
      { key: 'queued:q1', start: 100 }
    ]
    const anchor = {
      itemKey: 'queued:q1',
      offsetWithinItem: 10,
      fallbackScrollTop: 110,
      fallbackScrollHeight: 500
    }
    expect(stabilizeAnchor(anchor, allEphemeral)).toEqual(anchor)
  })
})

describe('anchorAtFraction', () => {
  // measurements: msg_1 @ 0, msg_2 @ 200, local @ 500, streaming @ 700; totalSize 1000
  it('anchors to the item containing the fractional offset', () => {
    const anchor = anchorAtFraction(0.3, measurements, 1000, 1040)
    // offset 300 → last item with start <= 300 is msg_2 (start 200)
    expect(anchor).toEqual({
      itemKey: 'message:msg_2',
      offsetWithinItem: 100,
      fallbackScrollTop: 300,
      fallbackScrollHeight: 1040
    })
  })

  it('anchors to the first item at fraction 0', () => {
    const anchor = anchorAtFraction(0, measurements, 1000, 1040)
    expect(anchor?.itemKey).toBe('message:msg_1')
    expect(anchor?.offsetWithinItem).toBe(0)
  })

  it('anchors to the last item at fraction 1', () => {
    const anchor = anchorAtFraction(1, measurements, 1000, 1040)
    expect(anchor?.itemKey).toBe('streaming:s1')
    expect(anchor?.offsetWithinItem).toBe(300)
  })

  it('clamps out-of-range fractions', () => {
    expect(anchorAtFraction(-0.5, measurements, 1000, 1040)?.fallbackScrollTop).toBe(0)
    expect(anchorAtFraction(1.5, measurements, 1000, 1040)?.fallbackScrollTop).toBe(1000)
  })

  it('returns null with no measurements', () => {
    expect(anchorAtFraction(0.5, [], 1000, 1040)).toBeNull()
  })

  it('returns null when total size is zero', () => {
    expect(anchorAtFraction(0.5, measurements, 0, 1040)).toBeNull()
  })
})

describe('computeAnchorFraction', () => {
  const anchor = {
    itemKey: 'message:msg_2',
    offsetWithinItem: 100,
    fallbackScrollTop: 300,
    fallbackScrollHeight: 1000
  }

  it('computes (start + offset) / totalSize', () => {
    expect(computeAnchorFraction(anchor, measurements, 1000)).toBe(0.3)
  })

  it('returns null when the key is missing', () => {
    expect(computeAnchorFraction({ ...anchor, itemKey: 'message:gone' }, measurements, 1000)).toBeNull()
  })

  it('returns null when total size is zero or negative', () => {
    expect(computeAnchorFraction(anchor, measurements, 0)).toBeNull()
  })

  it('clamps to [0, 1]', () => {
    expect(computeAnchorFraction({ ...anchor, offsetWithinItem: 5000 }, measurements, 1000)).toBe(1)
  })
})

describe('computeAnchorFractions', () => {
  const anchorFor = (itemKey: string, offsetWithinItem = 0) => ({
    itemKey,
    offsetWithinItem,
    fallbackScrollTop: 0,
    fallbackScrollHeight: 1000
  })

  it('resolves a batch of anchors in one pass, matching single-anchor results', () => {
    const anchors = [
      anchorFor('message:msg_1', 50),
      anchorFor('message:msg_2', 100),
      anchorFor('message:gone'),
      anchorFor('streaming:s1', 100)
    ]
    const batch = computeAnchorFractions(anchors, measurements, 1000)
    expect(batch).toEqual(anchors.map((a) => computeAnchorFraction(a, measurements, 1000)))
    expect(batch).toEqual([0.05, 0.3, null, 0.8])
  })

  it('returns all nulls when total size is zero', () => {
    expect(computeAnchorFractions([anchorFor('message:msg_1')], measurements, 0)).toEqual([null])
  })

  it('returns an empty array for no anchors', () => {
    expect(computeAnchorFractions([], measurements, 1000)).toEqual([])
  })

  it('resolves measurements with non-string keys (raw virtualizer cache rows)', () => {
    // The virtualizer's measurementsCache keys are typed string | number —
    // callers may pass cache rows directly without copying/stringifying.
    const rawMeasurements = [
      { key: 42 as unknown as string, start: 0 },
      { key: 'message:msg_2', start: 200 }
    ]
    const anchors = [anchorFor('42', 10), anchorFor('message:msg_2', 100)]
    expect(computeAnchorFractions(anchors, rawMeasurements, 1000)).toEqual([0.01, 0.3])
  })
})
