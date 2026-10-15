// The colour of an orchestrator ("Implement document" run) ticket's key, derived from the key
// itself so every surface — the run's own card, each child's "parent ›" segment, the modal
// headers — paints the same run the same colour without any lookup, and two runs on one board
// are unlikely to share one. A fixed palette rather than a free hue: every entry was picked to
// read on both themes (no muddy yellows or dark navies), with a deeper tone for light mode.

export interface TicketKeyColor {
  /** Text colour in light mode. */
  light: string
  /** Text colour in dark mode. */
  dark: string
}

const PALETTE: readonly TicketKeyColor[] = [
  // Light tones are Tailwind's 700/800 shades: 10px semibold text on a white card needs them
  // to clear WCAG 3:1 (the warm and the green-blue hues most of all); dark tones are the 400s.
  { light: '#b91c1c', dark: '#f87171' }, // red
  { light: '#9a3412', dark: '#fb923c' }, // orange
  { light: '#92400e', dark: '#fbbf24' }, // amber
  { light: '#3f6212', dark: '#a3e635' }, // lime
  { light: '#065f46', dark: '#34d399' }, // emerald
  { light: '#115e59', dark: '#2dd4bf' }, // teal
  { light: '#155e75', dark: '#22d3ee' }, // cyan
  { light: '#0369a1', dark: '#38bdf8' }, // sky
  { light: '#1d4ed8', dark: '#60a5fa' }, // blue
  { light: '#4338ca', dark: '#818cf8' }, // indigo
  { light: '#6d28d9', dark: '#a78bfa' }, // violet
  { light: '#a21caf', dark: '#e879f9' }, // fuchsia
  { light: '#be185d', dark: '#f472b6' }, // pink
  { light: '#be123c', dark: '#fb7185' } // rose
]

/** FNV-1a over the key: cheap, stable across sessions and machines, spreads short strings well. */
export function hashTicketKey(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function ticketKeyColor(key: string): TicketKeyColor {
  return PALETTE[hashTicketKey(key) % PALETTE.length]
}

/**
 * Classes for a key segment painted in the run's colour: the text and a 14% tint of it as the
 * background, in whichever of the two custom properties the theme selects (`dark:` follows the
 * `.dark` class like the rest of the app). The properties themselves come from
 * ticketKeyColorStyle(), so the palette stays in one place.
 */
export const TICKET_KEY_COLOR_CLASS =
  'text-(--ticket-key-light) bg-(--ticket-key-light)/14 dark:text-(--ticket-key-dark) dark:bg-(--ticket-key-dark)/14'

/** The custom properties TICKET_KEY_COLOR_CLASS reads, as an inline style. */
export function ticketKeyColorStyle(key: string): React.CSSProperties {
  const color = ticketKeyColor(key)
  return {
    '--ticket-key-light': color.light,
    '--ticket-key-dark': color.dark
  } as React.CSSProperties
}
