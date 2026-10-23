// Small display formatters shared by the data-project panels (sizes, durations, counts, times).

/** 1536 → "1.5 KB"; null/undefined → ''. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`
}

/** 0.4 → "0 ms", 842 → "842 ms", 12_400 → "12.4 s", 3_725_000 → "1 h 2 min". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${Math.round(s - m * 60)} s`
  const h = Math.floor(m / 60)
  return `${h} h ${m - h * 60} min`
}

/** 1234567 → "1,234,567"; compact: "1.2M". */
export function formatCount(n: number | null | undefined, compact = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return ''
  if (!compact || n < 10_000) return n.toLocaleString('en-US')
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 100_000_000 ? 1 : 0)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

/** "just now", "5 min ago", "3 h ago", else a short date. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Math.max(0, now - t)
  if (diff < 45_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  const d = new Date(t)
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: diff > 300 * 86_400_000 ? 'numeric' : undefined
  })
}

/** A file-name-safe stem ("Query 1 · shop" → "Query_1_shop"). */
export function safeFileStem(name: string, fallback = 'results'): string {
  const stem = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 80)
  return stem || fallback
}
