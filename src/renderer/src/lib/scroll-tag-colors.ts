// Curated categorical color palette for scroll tag markers — mid-tone hues
// (Tailwind 500-level) chosen to stay readable on both light and dark
// backgrounds, unlike raw random hues which can land near-white/near-black
// or low-contrast pastels.

export const SCROLL_TAG_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#10b981', // emerald
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899' // pink
] as const

const MAX_RETRIES = 20

export function generateScrollTagColor(taken: ReadonlySet<string>): string {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const color = SCROLL_TAG_COLORS[Math.floor(Math.random() * SCROLL_TAG_COLORS.length)]
    if (!taken.has(color)) return color
  }
  // Retries exhausted: deterministically find any untaken color.
  const untaken = SCROLL_TAG_COLORS.find((c) => !taken.has(c))
  if (untaken) return untaken
  // Palette fully saturated: reuse a random color.
  return SCROLL_TAG_COLORS[Math.floor(Math.random() * SCROLL_TAG_COLORS.length)]
}
