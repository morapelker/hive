/**
 * Shared look of the Orca tab strips: the surface behind the active tab and the
 * 2px bar that marks it. Every tab strip and file list uses these, so the active
 * thing looks the same wherever it shows up.
 */
export const TAB_ACTIVE_SURFACE_CLASS = 'bg-[color-mix(in_srgb,var(--foreground)_6%,var(--card))]'
export const TAB_MARKER_CLASS = 'bg-[color-mix(in_srgb,var(--foreground)_60%,var(--card))]'

/** Bar under the active tab, edge to edge. For strips whose tabs have dividers. */
export const TAB_UNDERLINE_CLASS = `absolute bottom-0 left-0 right-0 h-0.5 ${TAB_MARKER_CLASS}`

/** Bar under the active tab, inset. For strips whose tabs sit next to each other. */
export const TAB_UNDERLINE_INSET_CLASS = `absolute bottom-0 left-2 right-2 h-0.5 ${TAB_MARKER_CLASS}`
