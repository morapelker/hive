const PERF_PROBE_PARAM = 'perfprobe'

let observerStarted = false

type ViteImportMeta = ImportMeta & {
  env?: {
    DEV?: boolean
  }
}

export function isPerfProbeEnabled(): boolean {
  if (!(import.meta as ViteImportMeta).env?.DEV) return false
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).has(PERF_PROBE_PARAM)
}

function ensureObserver(): void {
  if (observerStarted || !isPerfProbeEnabled()) return
  if (typeof PerformanceObserver === 'undefined') return

  observerStarted = true
  const observer = new PerformanceObserver((list) => {
    const rows = list.getEntriesByType('measure').map((entry) => ({
      name: entry.name,
      duration: Number(entry.duration.toFixed(2)),
      start: Number(entry.startTime.toFixed(2))
    }))
    if (rows.length > 0) {
      console.table(rows)
    }
  })

  observer.observe({ entryTypes: ['measure'] })
}

export function markKeystrokeStart(label = 'keystroke'): void {
  if (!isPerfProbeEnabled()) return
  ensureObserver()
  performance.mark(`${label}-start`)
}

export function markKeystrokeEnd(
  label = 'keystroke',
  options: { preserveStart?: boolean } = {}
): void {
  if (!isPerfProbeEnabled()) return
  const startMark = `${label}-start`
  const endMark = `${label}-end`

  try {
    performance.mark(endMark)
    performance.measure(label, startMark, endMark)
  } catch {
    return
  } finally {
    if (!options.preserveStart) {
      performance.clearMarks(startMark)
    }
    performance.clearMarks(endMark)
  }
}

export function markKeystrokePainted(label = 'keystroke'): void {
  if (!isPerfProbeEnabled()) return
  const startMark = `${label}-start`
  const paintMark = `${label}-painted`

  try {
    performance.mark(paintMark)
    performance.measure(`${label}-painted`, startMark, paintMark)
  } catch {
    return
  } finally {
    performance.clearMarks(startMark)
    performance.clearMarks(paintMark)
  }
}
