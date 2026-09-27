// Pure helpers for scroll-tag anchoring in the virtualized message list.

export interface ScrollAnchor {
  itemKey: string
  offsetWithinItem: number
  fallbackScrollTop: number
  fallbackScrollHeight: number
}

export interface ItemMeasurement {
  /** Matches @tanstack/virtual-core's Key so raw measurementsCache rows are accepted as-is. */
  key: string | number | bigint
  start: number
}

/**
 * Item keys that may disappear or be replaced: optimistic local messages,
 * streaming/queued messages, and transient banners/indicators. Tags must not
 * anchor to these.
 */
const EPHEMERAL_KEY_RE =
  /^(message:local-|streaming:|queued:|typing-indicator$|completion$|error-banner$|retry-banner$|revert-banner:)/

export function isEphemeralItemKey(key: string): boolean {
  return EPHEMERAL_KEY_RE.test(key)
}

/**
 * If the anchor points at an ephemeral item, walk backwards through the
 * measurements to the nearest stable item, recomputing the offset so the
 * absolute scroll position is preserved. Returns the anchor unchanged when it
 * is already stable or when no stable predecessor exists (fallback fields
 * still allow approximate restoration).
 */
export function stabilizeAnchor(
  anchor: ScrollAnchor,
  measurements: readonly ItemMeasurement[]
): ScrollAnchor {
  if (!isEphemeralItemKey(anchor.itemKey)) return anchor

  const idx = measurements.findIndex((m) => String(m.key) === anchor.itemKey)
  for (let i = idx - 1; i >= 0; i--) {
    const m = measurements[i]
    const key = String(m.key)
    if (!isEphemeralItemKey(key)) {
      return {
        ...anchor,
        itemKey: key,
        offsetWithinItem: Math.max(0, anchor.fallbackScrollTop - m.start)
      }
    }
  }
  return anchor
}

/**
 * Build an anchor for a fractional position (0..1) within the full
 * virtualized content — the inverse of computeAnchorFraction. Used when the
 * user clicks a spot on the gutter minimap. Null when nothing is measured
 * yet. Callers should run the result through stabilizeAnchor.
 */
export function anchorAtFraction(
  fraction: number,
  measurements: readonly ItemMeasurement[],
  totalSize: number,
  scrollHeight: number
): ScrollAnchor | null {
  if (totalSize <= 0 || measurements.length === 0) return null
  const clamped = Math.min(1, Math.max(0, fraction))
  const offset = clamped * totalSize
  // Last measurement whose start is at or before the offset.
  let target = measurements[0]
  for (const m of measurements) {
    if (m.start <= offset) target = m
    else break
  }
  return {
    itemKey: String(target.key),
    offsetWithinItem: Math.max(0, offset - target.start),
    fallbackScrollTop: offset,
    fallbackScrollHeight: scrollHeight
  }
}

/**
 * Fraction (0..1) of the anchored position within the full virtualized
 * content, for positioning gutter markers. Null when the anchored item no
 * longer exists or the total size is not yet measured.
 */
export function computeAnchorFraction(
  anchor: ScrollAnchor,
  measurements: readonly ItemMeasurement[],
  totalSize: number
): number | null {
  if (totalSize <= 0) return null
  const m = measurements.find((mm) => String(mm.key) === anchor.itemKey)
  if (!m) return null
  return Math.min(1, Math.max(0, (m.start + anchor.offsetWithinItem) / totalSize))
}

/**
 * Batch variant of computeAnchorFraction: resolves many anchors with a single
 * key→start map instead of scanning the measurement list per anchor. Used by
 * the gutter to position all markers in one pass per render.
 */
export function computeAnchorFractions(
  anchors: readonly ScrollAnchor[],
  measurements: readonly ItemMeasurement[],
  totalSize: number
): (number | null)[] {
  if (anchors.length === 0) return []
  if (totalSize <= 0) return anchors.map(() => null)
  // Single pass over measurements, storing only the keys the anchors need —
  // allocations are bounded by the number of tags, not the conversation size.
  const wantedKeys = new Set(anchors.map((a) => a.itemKey))
  const startByKey = new Map<string, number>()
  for (const m of measurements) {
    const key = typeof m.key === 'string' ? m.key : String(m.key)
    if (wantedKeys.has(key)) startByKey.set(key, m.start)
  }
  return anchors.map((anchor) => {
    const start = startByKey.get(anchor.itemKey)
    if (start === undefined) return null
    return Math.min(1, Math.max(0, (start + anchor.offsetWithinItem) / totalSize))
  })
}
