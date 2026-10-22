// src/renderer/src/lib/ticket-label-colors.ts

/**
 * The ticket-label palette, per theme. Every class is a literal so Tailwind sees it — never build
 * these names at runtime. Small capitals on a tint only stay readable with hand-picked tones:
 * light mode uses 700–900 text on a 12% tint, dark mode 300/400 text on a 16% tint (each pair
 * clears 4.5:1 on the card). Yellow takes its hue from the fill in light mode — yellow text on
 * white reads as brown — so "WAITING FOR JOY" looks yellow in both themes.
 *
 * Do not reuse the status-pill recipe (text-X-500 on X-500/10): in light mode it is about 2:1.
 */

import {
  TICKET_LABEL_COLORS,
  isTicketLabelColor,
  type SavedTicketLabel,
  type TicketLabelColor
} from '@shared/lib/ticket-labels'

/** Geometry and type of a label chip. Square-ish corners keep it apart from the round status pills. */
export const TICKET_LABEL_CHIP_BASE =
  'inline-flex h-[18px] max-w-full min-w-0 shrink-0 items-center rounded-[4px] border px-1.5 text-[10px] font-semibold uppercase leading-none tracking-wider tabular-nums whitespace-nowrap select-none'

const CHIP_COLOR_CLASS: Record<TicketLabelColor, string> = {
  gray: 'border-neutral-500/30 bg-neutral-500/12 text-neutral-700 dark:border-neutral-400/30 dark:bg-neutral-400/16 dark:text-neutral-300',
  red: 'border-red-500/30 bg-red-500/12 text-red-700 dark:bg-red-500/16 dark:text-red-400',
  orange:
    'border-orange-500/30 bg-orange-500/12 text-orange-700 dark:bg-orange-500/16 dark:text-orange-400',
  yellow:
    'border-yellow-500/50 bg-yellow-400/35 text-yellow-900 dark:border-yellow-500/30 dark:bg-yellow-500/16 dark:text-yellow-400',
  green:
    'border-green-500/30 bg-green-500/12 text-green-800 dark:bg-green-500/16 dark:text-green-400',
  teal: 'border-teal-500/30 bg-teal-500/12 text-teal-700 dark:bg-teal-500/16 dark:text-teal-400',
  blue: 'border-blue-500/30 bg-blue-500/12 text-blue-700 dark:bg-blue-500/16 dark:text-blue-400',
  purple:
    'border-purple-500/30 bg-purple-500/12 text-purple-700 dark:bg-purple-500/16 dark:text-purple-400',
  pink: 'border-pink-500/30 bg-pink-500/12 text-pink-700 dark:bg-pink-500/16 dark:text-pink-400'
}

/** Solid swatches for the colour pickers. */
export const TICKET_LABEL_SWATCH_CLASS: Record<TicketLabelColor, string> = {
  gray: 'bg-neutral-500',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  yellow: 'bg-yellow-400',
  green: 'bg-green-500',
  teal: 'bg-teal-500',
  blue: 'bg-blue-500',
  purple: 'bg-purple-500',
  pink: 'bg-pink-500'
}

/** Names for tooltips and aria-labels. */
export const TICKET_LABEL_COLOR_NAMES: Record<TicketLabelColor, string> = {
  gray: 'Gray',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink'
}

/** A stored token as a palette colour; an unknown one (from a newer build) is drawn as gray. */
export function ticketLabelColorOf(color: string): TicketLabelColor {
  return isTicketLabelColor(color) ? color : 'gray'
}

/** The colour classes of a chip (combine with TICKET_LABEL_CHIP_BASE). */
export function ticketLabelChipColorClass(color: string): string {
  return CHIP_COLOR_CLASS[ticketLabelColorOf(color)]
}

/**
 * The colour a new saved label starts with: the palette colour the catalog uses least (gray,
 * the one-off default, skipped; ties go to palette order), so new labels tell apart at a glance.
 */
export function leastUsedTicketLabelColor(
  catalog: ReadonlyArray<Pick<SavedTicketLabel, 'color'>>
): TicketLabelColor {
  const counts = new Map<TicketLabelColor, number>()
  for (const label of catalog) {
    const color = ticketLabelColorOf(label.color)
    counts.set(color, (counts.get(color) ?? 0) + 1)
  }
  let best: TicketLabelColor = 'yellow'
  let bestCount = Number.POSITIVE_INFINITY
  for (const color of TICKET_LABEL_COLORS) {
    if (color === 'gray') continue
    const count = counts.get(color) ?? 0
    if (count < bestCount) {
      best = color
      bestCount = count
    }
  }
  return best
}
