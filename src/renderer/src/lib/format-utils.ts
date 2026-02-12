export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 1) return 'now'
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d`
  const diffWeek = Math.floor(diffDay / 7)
  return `${diffWeek}w`
}

export function formatCompletionDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return `${hours}h`
}

export const COMPLETION_WORDS = [
  'Swarmed',
  'Buzzed',
  'Hived',
  'Brewed',
  'Waxed',
  'Honeyed',
  'Sealed',
  'Capped',
  'Foraged',
  'Scouted',
  'Danced',
  'Dripped',
  'Sipped',
  'Clustered',
  'Nested',
  'Scented',
  'Pollinated',
  'Gathered',
  'Hummed'
]

const DEV_SERVER_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{3,5}\/?/

export function extractDevServerUrl(output: string[]): string | null {
  // Scan last 50 chunks for a dev server URL.
  // Each chunk may contain multiple lines (raw process output),
  // so we search the full text of each chunk.
  for (let i = output.length - 1; i >= Math.max(0, output.length - 50); i--) {
    const match = output[i].match(DEV_SERVER_URL_PATTERN)
    if (match) return match[0]
  }
  return null
}
