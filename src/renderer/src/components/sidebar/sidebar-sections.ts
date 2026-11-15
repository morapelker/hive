/**
 * The sections of the left sidebar's scroll area, top to bottom. LeftSidebar renders them in
 * this order; a section with nothing to show renders nothing, not even its heading.
 */
export const SIDEBAR_SECTIONS = ['pinned', 'recent', 'connections', 'all-projects'] as const

export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number]
