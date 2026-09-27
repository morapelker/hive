/**
 * Runtime switch left over from the sidebar-search performance work
 * (docs/perf/project-filter-search-performance.html). Phase 1 of that plan is
 * unconditional; this is the Phase 2 trial. Remove once decided.
 */
export interface SidebarPerfFlags {
  /**
   * Keep hint-code prefixes stable across keystrokes instead of preferring the
   * last typed character (which reshuffles every code, and re-renders every
   * badge, on each keystroke).
   */
  stableHintPrefix: boolean
}

export const sidebarPerfFlags: SidebarPerfFlags = {
  stableHintPrefix: false
}
