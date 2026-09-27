export interface HighlightRun {
  text: string
  hit: boolean
}

/**
 * Split text into alternating plain/highlighted runs of consecutive characters,
 * so a 60-character path renders as a handful of nodes instead of 60 spans.
 */
export function toHighlightRuns(text: string, indices: number[]): HighlightRun[] {
  const runs: HighlightRun[] = []
  if (text.length === 0) return runs
  const set = new Set(indices)
  let start = 0
  let hit = set.has(0)
  for (let i = 1; i <= text.length; i++) {
    const nextHit = i < text.length ? set.has(i) : !hit
    if (nextHit !== hit) {
      runs.push({ text: text.slice(start, i), hit })
      start = i
      hit = nextHit
    }
  }
  return runs
}
